import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { connect, type MqttClient } from 'mqtt';
import {
  TELEMETRY_DECODER,
  TELEMETRY_FORMAT,
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_SAMPLES,
  type Input,
  type TelemetrySample,
  type TelemetrySegment,
  type TelemetrySegmentDescriptor,
} from '@ledger/contracts';
import { type AdapterConfig, type AdapterResult, digest, retainInput } from './index.js';
import { decodeDjiOsd, DJI_LIMITATIONS } from './dji-osd.js';
export { decodeDjiOsd, DJI_DOCUMENTATION_DIGEST, DJI_LIMITATIONS } from './dji-osd.js';

export interface DjiAdapterConfig extends AdapterConfig {
  tenantId: string;
  sourceSessionId: string;
  deviceId: string;
  gatewayId: string;
  mqttUrl: string;
  username: string;
  password: string;
  statePath: string;
  subject: NonNullable<Input['subject']>;
  maxSamples?: number;
  maxSegmentAgeMs?: number;
  reconnectPeriodMs?: number;
  onError?: (error: Error) => void;
}
interface Pending {
  id: string;
  segment: TelemetrySegment;
}
interface State {
  version: 1;
  binding: string;
  nextSequence: number;
  seen: string[];
  buffer: TelemetrySample[];
  pending: Pending[];
}
const CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
export function describeTelemetry(segment: TelemetrySegment): TelemetrySegmentDescriptor {
  const positions = segment.samples.map((sample) => sample.sequence);
  const times = segment.samples.map((sample) => sample.occurredAt).sort();
  return {
    format: TELEMETRY_FORMAT,
    deviceId: segment.deviceId,
    gatewayId: segment.gatewayId,
    decoderVersion: TELEMETRY_DECODER,
    sequenceBasis: 'adapter_capture',
    sessionStartSequence: segment.sessionStartSequence,
    sampleCount: segment.samples.length,
    firstSequence: Math.min(...positions),
    lastSequence: Math.max(...positions),
    firstOccurredAt: times[0]!,
    lastOccurredAt: times.at(-1)!,
  };
}
export class DjiMqttAdapter {
  private state!: State;
  private client?: MqttClient;
  private timer?: ReturnType<typeof setInterval>;
  private serial: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private closing = false;
  private scheduledFlush = false;
  private reconnects = 0;
  private duplicateDeliveries = 0;
  private readonly binding: string;
  private readonly maxSamples: number;
  readonly results: AdapterResult[] = [];
  constructor(private config: DjiAdapterConfig) {
    const url = new URL(config.mqttUrl);
    if (
      !['mqtt:', 'mqtts:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.protocol === 'mqtt:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('DJI MQTT requires explicit credentials and TLS outside loopback');
    for (const value of [
      config.tenantId,
      config.sourceId,
      config.sourceSessionId,
      config.deviceId,
      config.gatewayId,
      config.username,
      config.password,
    ])
      if (!value || value.length > 200) throw new Error('DJI binding and credentials must be explicitly configured');
    if (!/^[A-Za-z0-9_-]+$/.test(config.deviceId))
      throw new Error('DJI device binding cannot contain MQTT wildcards or separators');
    this.maxSamples = config.maxSamples ?? TELEMETRY_MAX_SAMPLES;
    if (!Number.isSafeInteger(this.maxSamples) || this.maxSamples < 1 || this.maxSamples > TELEMETRY_MAX_SAMPLES)
      throw new Error('Invalid DJI segment sample bound');
    if (
      config.maxSegmentAgeMs !== undefined &&
      (!Number.isSafeInteger(config.maxSegmentAgeMs) || config.maxSegmentAgeMs < 100)
    )
      throw new Error('Invalid DJI segment age');
    this.binding = digest(
      JSON.stringify({
        tenantId: config.tenantId,
        sourceId: config.sourceId,
        sourceSessionId: config.sourceSessionId,
        deviceId: config.deviceId,
        gatewayId: config.gatewayId,
        subject: config.subject,
      }),
    );
  }
  get stats() {
    return {
      sourceSessionId: this.config.sourceSessionId,
      nextSequence: this.state?.nextSequence ?? 1,
      captured: (this.state?.nextSequence ?? 1) - 1,
      duplicateDeliveries: this.duplicateDeliveries,
      connections: this.reconnects,
      buffered: this.state?.buffer.length ?? 0,
      pending: this.state?.pending.length ?? 0,
    };
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => {});
    return result;
  }
  private async save(next: State): Promise<void> {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > CHECKPOINT_MAX_BYTES)
      throw new Error('DJI checkpoint byte capacity exceeded; capture stops until pending delivery recovers');
    const path = resolve(this.config.statePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    } finally {
      await file.close();
    }
    try {
      await rename(temp, path);
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
    this.state = next;
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const handle = await open(this.config.statePath, 'r');
      let encoded: Buffer;
      try {
        if ((await handle.stat()).size > CHECKPOINT_MAX_BYTES) throw new Error('DJI checkpoint exceeds byte capacity');
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
          length += chunk.byteLength;
          if (length > CHECKPOINT_MAX_BYTES) throw new Error('DJI checkpoint exceeds byte capacity');
          chunks.push(Buffer.from(chunk));
        }
        encoded = Buffer.concat(chunks, length);
      } finally {
        await handle.close();
      }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) as State;
      if (
        value.version !== 1 ||
        value.binding !== this.binding ||
        !Number.isSafeInteger(value.nextSequence) ||
        value.nextSequence < 1 ||
        !Array.isArray(value.seen) ||
        !Array.isArray(value.buffer) ||
        !Array.isArray(value.pending)
      )
        throw new Error('DJI checkpoint does not match its configured logical session');
      if (value.seen.length > 20000 || value.buffer.length > TELEMETRY_MAX_SAMPLES || value.pending.length > 200)
        throw new Error('DJI checkpoint exceeds bounded spool capacity');
      if (
        value.seen.length + 1 !== value.nextSequence ||
        new Set(value.seen).size !== value.seen.length ||
        value.seen.some((key) => !/^[a-f0-9]{64}$/.test(key))
      )
        throw new Error('DJI checkpoint capture identities are corrupt');
      const positions = new Set<number>();
      const pendingIds = new Set<string>();
      const validateSample = (sample: TelemetrySample) => {
        if (!sample?.original || positions.has(sample.sequence) || sample.sequence >= value.nextSequence)
          throw new Error('DJI checkpoint sample positions are corrupt');
        const bytes = Buffer.from(sample.original.bytesBase64, 'base64');
        if (
          bytes.toString('base64') !== sample.original.bytesBase64 ||
          JSON.stringify(decodeDjiOsd(sample.original.topic, bytes, this.config, sample.sequence)) !==
            JSON.stringify(sample)
        )
          throw new Error('DJI checkpoint sample does not reproduce its source bytes');
        const key = digest(Buffer.concat([Buffer.from(sample.original.topic), Buffer.from([0]), bytes]));
        if (!value.seen.includes(key)) throw new Error('DJI checkpoint sample lacks its capture identity');
        positions.add(sample.sequence);
      };
      value.buffer.forEach(validateSample);
      for (const item of value.pending) {
        if (
          !item?.segment ||
          pendingIds.has(item.id) ||
          item.id !== digest(JSON.stringify(item.segment)) ||
          !Array.isArray(item.segment.samples) ||
          item.segment.samples.length < 1 ||
          item.segment.samples.length > TELEMETRY_MAX_SAMPLES ||
          Buffer.byteLength(JSON.stringify(item.segment)) > TELEMETRY_MAX_BYTES ||
          JSON.stringify(item.segment) !== JSON.stringify(this.segment(item.segment.samples))
        )
          throw new Error('DJI checkpoint pending commitment is corrupt');
        pendingIds.add(item.id);
        item.segment.samples.forEach(validateSample);
      }
      this.state = value;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      await this.save({ version: 1, binding: this.binding, nextSequence: 1, seen: [], buffer: [], pending: [] });
    }
    this.initialized = true;
  }
  private segment(samples: TelemetrySample[]): TelemetrySegment {
    return {
      format: TELEMETRY_FORMAT,
      sourceId: this.config.sourceId,
      sourceSessionId: this.config.sourceSessionId,
      deviceId: this.config.deviceId,
      gatewayId: this.config.gatewayId,
      decoderVersion: TELEMETRY_DECODER,
      fidelity: 'synthetic_contract',
      coordinateReference: 'WGS84',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 1,
      samples,
    };
  }
  private sealState(next: State): string | null {
    if (!next.buffer.length) return null;
    if (next.pending.length >= 200)
      throw new Error('DJI durable spool capacity exceeded; delivery must recover before capture resumes');
    const segment = this.segment(next.buffer);
    const id = digest(JSON.stringify(segment));
    next.pending.push({ id, segment });
    next.buffer = [];
    return id;
  }
  /** Persist original payload and capture position before acknowledging MQTT delivery. */
  ingest(topic: string, bytes: Uint8Array): Promise<'captured' | 'duplicate'> {
    return this.queue(async () => {
      await this.initialize();
      const key = digest(Buffer.concat([Buffer.from(topic), Buffer.from([0]), Buffer.from(bytes)]));
      if (this.state.seen.includes(key)) {
        this.duplicateDeliveries++;
        return 'duplicate';
      }
      const sample = decodeDjiOsd(topic, bytes, this.config, this.state.nextSequence);
      if (this.state.seen.length >= 20000)
        throw new Error('DJI capture session capacity reached; rotate the explicitly configured logical session');
      const next = clone(this.state);
      if (
        next.buffer.length >= this.maxSamples ||
        Buffer.byteLength(JSON.stringify(this.segment([...next.buffer, sample]))) > TELEMETRY_MAX_BYTES
      )
        this.sealState(next);
      next.buffer.push(sample);
      next.seen.push(key);
      next.nextSequence++;
      await this.save(next);
      return 'captured';
    });
  }
  seal(): Promise<string | null> {
    return this.queue(async () => {
      await this.initialize();
      const next = clone(this.state);
      const id = this.sealState(next);
      if (id) await this.save(next);
      return id;
    });
  }
  private async commit(id: string): Promise<AdapterResult> {
    const pending = this.state.pending.find((item) => item.id === id);
    if (!pending) throw new Error('Unknown DJI pending segment');
    const raw = new TextEncoder().encode(JSON.stringify(pending.segment));
    const payload = describeTelemetry(pending.segment);
    const result = await retainInput(
      this.config,
      raw,
      'application/json',
      {
        kind: 'telemetry.segment',
        occurredAt: payload.lastOccurredAt,
        subject: this.config.subject,
        payload,
        fidelity: 'synthetic_contract',
      },
      `dji:segment:${this.config.sourceSessionId}:${id}`,
    );
    const next = clone(this.state);
    next.pending = next.pending.filter((item) => item.id !== id);
    await this.save(next);
    this.results.push(result);
    return result;
  }
  commitPending(id: string): Promise<AdapterResult> {
    return this.queue(async () => {
      await this.initialize();
      return this.commit(id);
    });
  }
  flush(): Promise<AdapterResult[]> {
    return this.queue(async () => {
      await this.initialize();
      const next = clone(this.state);
      if (this.sealState(next)) await this.save(next);
      const results = [];
      for (const item of [...this.state.pending]) results.push(await this.commit(item.id));
      return results;
    });
  }
  idle(): Promise<unknown> {
    return this.serial;
  }
  async start(): Promise<void> {
    await this.initialize();
    if (this.client) throw new Error('DJI adapter is already connected');
    this.closing = false;
    const topic = `thing/product/${this.config.deviceId}/osd`;
    const client = (this.client = connect(this.config.mqttUrl, {
      protocolVersion: 5,
      clientId: `ledger-adapter-${this.binding.slice(0, 32)}`,
      username: this.config.username,
      password: this.config.password,
      clean: false,
      reconnectPeriod: this.config.reconnectPeriodMs ?? 500,
      connectTimeout: 10000,
      properties: { sessionExpiryInterval: 3600, receiveMaximum: 1, maximumPacketSize: 40000 },
    }));
    client.handleMessage = (packet, callback) => {
      this.ingest(packet.topic, packet.payload as Buffer).then(
        () => callback(),
        (error) => {
          this.config.onError?.(new Error('DJI capture rejected or checkpoint unavailable'));
          callback(error);
        },
      );
    };
    client.on('error', () => this.config.onError?.(new Error('DJI MQTT transport error')));
    await new Promise<void>((resolveStart, reject) => {
      const timer = setTimeout(() => reject(new Error('DJI MQTT subscribe deadline exceeded')), 12000);
      client.on('connect', () => {
        this.reconnects++;
        client.subscribe(topic, { qos: 1 }, (error, grants) => {
          if (error || grants?.some((grant) => Number(grant.qos) > 2)) {
            const failure = new Error('DJI MQTT topic subscription denied');
            this.config.onError?.(failure);
            clearTimeout(timer);
            reject(failure);
          } else {
            clearTimeout(timer);
            resolveStart();
          }
        });
      });
    }).catch(async (error) => {
      await client.endAsync(true);
      this.client = undefined;
      throw error;
    });
    if (this.config.maxSegmentAgeMs !== undefined)
      this.timer = setInterval(() => {
        if (this.closing || this.scheduledFlush) return;
        this.scheduledFlush = true;
        void this.flush()
          .catch(() => this.config.onError?.(new Error('DJI segment remains checkpointed pending API recovery')))
          .finally(() => {
            this.scheduledFlush = false;
          });
      }, this.config.maxSegmentAgeMs);
  }
  interruptTransport(): void {
    this.client?.stream.destroy();
  }
  completeSession(): Promise<void> {
    return this.queue(async () => {
      await this.initialize();
      if (this.state.buffer.length || this.state.pending.length)
        throw new Error('DJI session still has captured bytes awaiting delivery');
      const flightId = this.config.subject.flightId;
      if (!flightId || !this.client) throw new Error('DJI session completion requires its connected flight binding');
      const view = await this.config.ledger.telemetry(flightId);
      const session = view.sessions.find(
        (value) =>
          value.sourceId === this.config.sourceId &&
          value.sourceSessionId === this.config.sourceSessionId &&
          value.deviceId === this.config.deviceId,
      );
      const samples = view.samples.filter(
        (sample) =>
          sample.sourceId === this.config.sourceId &&
          sample.sourceSessionId === this.config.sourceSessionId &&
          sample.deviceId === this.config.deviceId,
      );
      if (this.state.nextSequence === 1) {
        if (view.window.truncated)
          throw new Error('DJI session completion requires an untruncated bounded evidence view');
        if (
          view.sessions.some(
            (value) => value.sourceId === this.config.sourceId && value.sourceSessionId === this.config.sourceSessionId,
          ) ||
          view.samples.some(
            (value) => value.sourceId === this.config.sourceId && value.sourceSessionId === this.config.sourceSessionId,
          )
        )
          throw new Error('DJI empty session completion requires no matching projected claims');
      } else if (!session || session.sessionStartSequence !== 1 || session.sequenceBasis !== 'adapter_capture')
        throw new Error('DJI session completion supports only the adapter capture baseline of one');
      const positions = [...new Set(samples.map((sample) => sample.sequence))].sort((a, b) => a - b);
      if (
        positions.length !== this.state.nextSequence - 1 ||
        positions.some((position, index) => position !== index + 1)
      )
        throw new Error('DJI session completion requires every capture position to be projected');
      for (const id of new Set(samples.map((sample) => sample.receiptId))) {
        const { receipt } = await this.config.ledger.receipt(id);
        if (
          receipt.kind !== 'telemetry.segment' ||
          receipt.sourceId !== this.config.sourceId ||
          receipt.flightId !== flightId ||
          receipt.processing.status !== 'completed'
        )
          throw new Error('DJI session receipt is not completed in its flight scope');
      }
      const client = this.client;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await client.unsubscribeAsync(`thing/product/${this.config.deviceId}/osd`);
            await client.endAsync(false, { properties: { sessionExpiryInterval: 0 } });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('DJI completed session cleanup must reconnect and retry')),
              10_000,
            );
          }),
        ]);
      } catch (error) {
        await client.endAsync(true).catch(() => {});
        this.client = undefined;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.client = undefined;
      this.closing = true;
      if (this.timer) clearInterval(this.timer);
    });
  }
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.client?.endAsync(true);
    this.client = undefined;
    await this.idle();
  }
}
