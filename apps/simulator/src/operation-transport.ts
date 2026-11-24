import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DjiMqttAdapter, digest, type AdapterResult, type DjiAdapterConfig, type LedgerClient } from '@ledger/adapters';
import { DjiOsdEmulator } from '@ledger/emulators';
import type { PreparedWorldFact } from './operation-delivery.js';

interface Credential {
  username: string;
  password: string;
}
export interface OperationTransportConfig {
  emulatorUrl: string;
  adminKey: string;
  partnerKey: string;
  callbackHost: string;
  callbackPort: number;
  mqttUrl: string;
  bindings: Record<string, { device: Credential; adapter: Credential }>;
  stateDirectory: string;
  signal?: AbortSignal;
  controlHeaders(): Record<string, string>;
}
export type OperationCaptureConfig = Omit<DjiAdapterConfig, 'mqttUrl' | 'username' | 'password' | 'subject'> & {
  subject: { flightId: string };
};
interface SessionIdentity {
  version: 1;
  phase: 'initializing' | 'active';
  mqttUrl: string;
  apiUrl: string;
  tenantId: string;
  sourceId: string;
  sourceSessionId: string;
  deviceId: string;
  gatewayId: string;
  statePath: string;
  subject: { flightId: string };
}
interface Capture {
  identity: SessionIdentity;
  current: { ledger: LedgerClient };
  adapter: DjiMqttAdapter;
  emulator: DjiOsdEmulator;
  adapterStarted: boolean;
  emulatorStarted: boolean;
  stopping?: Promise<void>;
}
interface CallbackJob<Result = unknown> {
  bytes: Buffer;
  ingest(raw: Uint8Array): Promise<Result>;
  work?: Promise<Result>;
}
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function bounded<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retainSession(path: string, value: SessionIdentity): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function callbackBytes(request: IncomingMessage, expected: Buffer, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const abort = () => request.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      signal?.throwIfAborted();
      length += chunk.byteLength;
      if (length > expected.byteLength) throw new Error('Partner callback differs from retained source bytes');
      chunks.push(Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    const raw = Buffer.concat(chunks, length);
    if (!raw.equals(expected)) throw new Error('Partner callback differs from retained source bytes');
    return raw;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export class OperationTransport {
  private server?: Server;
  private closing = false;
  private readonly callbacks = new Map<string, CallbackJob>();
  private readonly captures = new Map<string, Capture>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly interruptedDevices = new Set<string>();
  private aborting?: Promise<void>;
  private readonly abort = () => {
    this.closing = true;
    this.server?.closeAllConnections();
    for (const capture of this.captures.values()) {
      capture.adapter.interruptTransport();
      capture.emulator.interruptTransport();
    }
    this.aborting ??= Promise.allSettled([...this.captures.values()].map((capture) => this.disconnect(capture))).then(
      () => {},
    );
  };
  constructor(private readonly config: OperationTransportConfig) {}

  private requireOpen(): void {
    this.config.signal?.throwIfAborted();
    if (this.closing) throw new Error('World transport is unavailable');
  }

  private requestSignal(milliseconds: number): AbortSignal {
    const timeout = AbortSignal.timeout(milliseconds);
    return this.config.signal ? AbortSignal.any([this.config.signal, timeout]) : timeout;
  }

  get callbackUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('World transport must start before delivery');
    const host = this.config.callbackHost.includes(':') ? `[${this.config.callbackHost}]` : this.config.callbackHost;
    return `http://${host}:${address.port}`;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('World transport is already started');
    this.config.signal?.throwIfAborted();
    this.closing = false;
    this.config.signal?.addEventListener('abort', this.abort, { once: true });
    const server = createServer(async (request, response) => {
      try {
        this.requireOpen();
        const key = request.headers['x-partner-key'];
        const expected = Buffer.from(this.config.partnerKey);
        if (
          request.method !== 'POST' ||
          typeof key !== 'string' ||
          Buffer.byteLength(key) !== expected.length ||
          !timingSafeEqual(Buffer.from(key), expected)
        ) {
          response.writeHead(403).end();
          return;
        }
        const job = this.callbacks.get(request.url ?? '');
        if (!job) {
          response.writeHead(404).end();
          return;
        }
        if (!job.work) {
          job.work = callbackBytes(request, job.bytes, this.config.signal).then((raw) => {
            this.requireOpen();
            return job.ingest(raw);
          });
        } else await callbackBytes(request, job.bytes, this.config.signal);
        await job.work;
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}');
      } catch {
        response.writeHead(400).end();
      }
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.config.callbackPort, this.config.callbackHost, resolve);
      });
      this.requireOpen();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async partnerOrder(
    prepared: PreparedWorldFact,
    ingestRawCallback: (raw: Uint8Array) => Promise<AdapterResult>,
  ): Promise<AdapterResult> {
    this.requireOpen();
    if (prepared.fact.kind !== 'order') throw new Error('World partner delivery is unavailable');
    const path = `/world/partner/${digest(`${prepared.fact.tenant}:${prepared.fact.sourceSessionId}:${prepared.fact.sequence}`)}`;
    if (this.callbacks.has(path)) throw new Error('World partner delivery is already active for this fact');
    const job: CallbackJob<AdapterResult> = {
      bytes: Buffer.from(prepared.bytesBase64, 'base64'),
      ingest: ingestRawCallback,
    };
    this.callbacks.set(path, job);
    try {
      let failure: unknown;
      try {
        const response = await fetch(`${this.config.emulatorUrl}/_simulation/partner/deliver`, {
          method: 'POST',
          headers: {
            ...this.config.controlHeaders(),
            'x-emulator-admin': this.config.adminKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            callbackUrl: `${this.callbackUrl}${path}`,
            order: JSON.parse(job.bytes.toString('utf8')),
          }),
          signal: this.requestSignal(6000),
        });
        const result = (await response.json()) as { status?: number };
        if (!response.ok || result.status !== 200)
          throw new Error('Vendor emulator did not accept its partner callback');
      } catch (error) {
        failure = error;
      }
      if (job.work) return await job.work;
      throw failure ?? new Error('Vendor emulator did not deliver its partner callback');
    } finally {
      this.callbacks.delete(path);
    }
  }

  async commandLink<Result>(
    prepared: PreparedWorldFact,
    ingestRawCallback: (raw: Uint8Array) => Promise<Result>,
  ): Promise<Result> {
    this.requireOpen();
    if (prepared.fact.kind !== 'command-link') throw new Error('World command-link delivery is unavailable');
    if (prepared.bytesBase64.length > 4 * Math.ceil((64 * 1024) / 3))
      throw new Error('World command-link source exceeds 64 KiB');
    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024 || bytes.toString('base64') !== prepared.bytesBase64)
      throw new Error('World command-link delivery requires canonical source bytes within 64 KiB');
    const path = `/world/command-link/${digest(
      JSON.stringify({
        tenant: prepared.fact.tenant,
        sourceSessionId: prepared.fact.sourceSessionId,
        sourceEventId: prepared.fact.sourceEventId,
      }),
    )}`;
    if (this.callbacks.has(path))
      throw new Error('World command-link delivery is already active for this source event');
    const job: CallbackJob<Result> = { bytes, ingest: ingestRawCallback };
    this.callbacks.set(path, job);
    try {
      let failure: unknown;
      try {
        const response = await fetch(`${this.config.emulatorUrl}/_simulation/command-link/deliver`, {
          method: 'POST',
          headers: {
            ...this.config.controlHeaders(),
            'x-emulator-admin': this.config.adminKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ callbackUrl: `${this.callbackUrl}${path}`, bytesBase64: prepared.bytesBase64 }),
          signal: this.requestSignal(6000),
          redirect: 'error',
        });
        const result = (await response.json()) as { status?: number };
        if (!response.ok || result.status !== 200)
          throw new Error('Vendor emulator did not accept its command-link callback');
      } catch (error) {
        failure = error;
      }
      if (job.work) return await job.work;
      throw failure ?? new Error('Vendor emulator did not deliver its command-link callback');
    } finally {
      this.callbacks.delete(path);
    }
  }

  async mission<Result>(
    prepared: PreparedWorldFact,
    ingestRawCallback: (raw: Uint8Array) => Promise<Result>,
  ): Promise<Result> {
    this.requireOpen();
    if (prepared.fact.kind !== 'mission') throw new Error('World mission delivery is unavailable');
    if (prepared.bytesBase64.length > 4 * Math.ceil((64 * 1024) / 3))
      throw new Error('World mission source exceeds 64 KiB');
    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024 || bytes.toString('base64') !== prepared.bytesBase64)
      throw new Error('World mission delivery requires canonical source bytes within 64 KiB');
    const path = `/world/mission/${digest(
      JSON.stringify({
        tenant: prepared.fact.tenant,
        sourceId: prepared.fact.sourceId,
        sourceMissionId: prepared.fact.source.sourceMissionId,
        sourceRevision: prepared.fact.source.sourceRevision,
      }),
    )}`;
    if (this.callbacks.has(path)) throw new Error('World mission delivery is already active for this source revision');
    const job: CallbackJob<Result> = { bytes, ingest: ingestRawCallback };
    this.callbacks.set(path, job);
    try {
      let failure: unknown;
      try {
        const response = await fetch(`${this.config.emulatorUrl}/_simulation/mission/deliver`, {
          method: 'POST',
          headers: {
            ...this.config.controlHeaders(),
            'x-emulator-admin': this.config.adminKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ callbackUrl: `${this.callbackUrl}${path}`, bytesBase64: prepared.bytesBase64 }),
          signal: this.requestSignal(6000),
          redirect: 'error',
        });
        const result = (await response.json()) as { status?: number };
        if (!response.ok || result.status !== 200)
          throw new Error('Vendor emulator did not accept its mission callback');
      } catch (error) {
        failure = error;
      }
      if (job.work) return await job.work;
      throw failure ?? new Error('Vendor emulator did not deliver its mission callback');
    } finally {
      this.callbacks.delete(path);
    }
  }

  private forDevice<T>(deviceId: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(deviceId) ?? Promise.resolve()).then(() => {
      this.requireOpen();
      return action();
    });
    const tail = pending.catch(() => {});
    this.queues.set(deviceId, tail);
    void tail.then(() => {
      if (this.queues.get(deviceId) === tail) this.queues.delete(deviceId);
    });
    return pending;
  }

  async setTelemetryDeliveryInterrupted(deviceId: string, interrupted: boolean): Promise<void> {
    this.requireOpen();
    if (interrupted) this.interruptedDevices.add(deviceId);
    else this.interruptedDevices.delete(deviceId);
    return this.forDevice(deviceId, async () => {
      const capture = this.captures.get(deviceId);
      if (interrupted && capture?.emulatorStarted) {
        await capture.emulator.stop();
        capture.emulatorStarted = false;
      }
    });
  }

  async position(prepared: PreparedWorldFact, config: OperationCaptureConfig): Promise<void> {
    this.requireOpen();
    if (prepared.fact.kind !== 'position') throw new Error('World MQTT delivery is unavailable');
    const deviceId = prepared.fact.aircraftId;
    return this.forDevice(deviceId, () => {
      this.requireTelemetryDelivery(deviceId);
      return this.deliverPosition(prepared, config);
    });
  }

  private requireTelemetryDelivery(deviceId: string): void {
    this.requireOpen();
    if (this.interruptedDevices.has(deviceId))
      throw new Error('Telemetry delivery is interrupted; original frames remain retained');
  }

  private sessionPath(deviceId: string): string {
    return join(this.config.stateDirectory, 'transport-sessions', `${digest(deviceId)}.json`);
  }

  private capture(identity: SessionIdentity, ledger: LedgerClient): Capture {
    const credentials = this.config.bindings[identity.deviceId];
    if (!credentials) throw new Error('World aircraft has no explicit MQTT credentials');
    const current = { ledger };
    const proxy = new Proxy(ledger, {
      get(_target, property) {
        const value = Reflect.get(current.ledger, property);
        return typeof value === 'function' ? value.bind(current.ledger) : value;
      },
    });
    return {
      identity,
      current,
      adapter: new DjiMqttAdapter({ ...identity, ...credentials.adapter, ledger: proxy }),
      emulator: new DjiOsdEmulator({ ...identity, ...credentials.device }),
      adapterStarted: false,
      emulatorStarted: false,
    };
  }

  private async connect(capture: Capture): Promise<void> {
    this.requireOpen();
    const { identity } = capture;
    if (identity.phase === 'active') {
      const file = await lstat(identity.statePath);
      if (!file.isFile() || file.isSymbolicLink())
        throw new Error('Retained world MQTT capture must be a regular file');
    }
    await capture.adapter.initialize();
    this.requireOpen();
    if (identity.phase === 'initializing') {
      identity.phase = 'active';
      await retainSession(this.sessionPath(identity.deviceId), identity);
    }
    this.requireOpen();
    if (!capture.adapterStarted) {
      await capture.adapter.start();
      capture.adapterStarted = true;
      this.requireOpen();
    }
  }

  private async disconnect(capture: Capture): Promise<void> {
    capture.stopping ??= Promise.allSettled([capture.adapter.stop(), capture.emulator.stop()])
      .then(() => {
        capture.adapterStarted = false;
        capture.emulatorStarted = false;
      })
      .finally(() => {
        capture.stopping = undefined;
      });
    await capture.stopping;
  }

  private async deliverPosition(prepared: PreparedWorldFact, config: OperationCaptureConfig): Promise<void> {
    this.requireOpen();
    if (prepared.fact.kind !== 'position') throw new Error('World MQTT expects a position');
    if (
      config.deviceId !== prepared.fact.aircraftId ||
      config.sourceSessionId !== prepared.fact.sourceSessionId ||
      !config.subject.flightId
    )
      throw new Error('World MQTT capture does not match its retained flight');
    const expected: SessionIdentity = {
      version: 1,
      phase: 'initializing',
      mqttUrl: this.config.mqttUrl,
      apiUrl: config.ledger.baseUrl,
      tenantId: config.tenantId,
      sourceId: config.sourceId,
      sourceSessionId: config.sourceSessionId,
      deviceId: config.deviceId,
      gatewayId: config.gatewayId,
      statePath: config.statePath,
      subject: config.subject,
    };
    let capture = this.captures.get(config.deviceId);
    if (!capture) {
      let retained: SessionIdentity | undefined;
      try {
        retained = JSON.parse(await readFile(this.sessionPath(config.deviceId), 'utf8')) as SessionIdentity;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        retained &&
        (retained.version !== 1 ||
          !['initializing', 'active'].includes(retained.phase) ||
          retained.deviceId !== config.deviceId ||
          retained.mqttUrl !== expected.mqttUrl ||
          retained.apiUrl !== expected.apiUrl ||
          retained.tenantId !== expected.tenantId ||
          !retained.sourceSessionId ||
          !retained.statePath ||
          !retained.subject?.flightId)
      )
        throw new Error('Retained world MQTT session belongs to another transport binding');
      this.requireOpen();
      if (!retained) await retainSession(this.sessionPath(config.deviceId), expected);
      this.requireOpen();
      capture = this.capture(retained ?? expected, config.ledger);
      this.captures.set(config.deviceId, capture);
    }
    capture.current.ledger = config.ledger;
    try {
      await this.connect(capture);
      this.requireOpen();
      if (capture.identity.sourceSessionId !== expected.sourceSessionId) {
        await capture.adapter.completeSession();
        this.requireOpen();
        await this.disconnect(capture);
        this.requireOpen();
        if (capture.adapter.stats.buffered || capture.adapter.stats.pending)
          throw new Error('Retained world MQTT session captured more evidence during completion');
        await retainSession(this.sessionPath(config.deviceId), expected);
        this.requireOpen();
        capture = this.capture(expected, config.ledger);
        this.captures.set(config.deviceId, capture);
        await this.connect(capture);
      } else if (
        JSON.stringify({ ...capture.identity, phase: 'active' }) !== JSON.stringify({ ...expected, phase: 'active' })
      ) {
        throw new Error('World MQTT logical session cannot change its retained binding');
      }
      this.requireTelemetryDelivery(config.deviceId);
      if (!capture.emulatorStarted) {
        await capture.emulator.start();
        capture.emulatorStarted = true;
      }
      this.requireTelemetryDelivery(config.deviceId);
      const bytes = Buffer.from(prepared.bytesBase64, 'base64');
      await bounded(capture.emulator.publishBytes(bytes), 8000, 'World MQTT publish remains pending');
      this.requireOpen();
      const topic = `thing/product/${config.deviceId}/osd`;
      const key = digest(Buffer.concat([Buffer.from(topic), Buffer.from([0]), bytes]));
      const deadline = Date.now() + 8000;
      while (true) {
        this.requireOpen();
        await capture.adapter.idle();
        this.requireOpen();
        const checkpoint = JSON.parse(await readFile(config.statePath, 'utf8')) as { seen: string[] };
        if (checkpoint.seen.includes(key)) break;
        if (Date.now() >= deadline) throw new Error('World MQTT publication has not reached durable adapter capture');
        await delay(20);
      }
      this.requireOpen();
      await capture.adapter.flush();
    } catch (error) {
      await this.disconnect(capture);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.config.signal?.aborted) this.abort();
    try {
      await Promise.allSettled([
        ...this.queues.values(),
        ...[...this.callbacks.values()].flatMap((job) => (job.work ? [job.work] : [])),
      ]);
      await this.aborting;
      await Promise.allSettled([...this.captures.values()].map((capture) => this.disconnect(capture)));
      this.captures.clear();
    } finally {
      this.config.signal?.removeEventListener('abort', this.abort);
      const server = this.server;
      this.server = undefined;
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
}
