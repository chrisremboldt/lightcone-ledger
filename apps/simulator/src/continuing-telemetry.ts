import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LedgerClient, DjiMqttAdapter, digest, type DjiAdapterConfig } from '@ledger/adapters';
import { DjiOsdEmulator, type DjiEmulatorConfig } from '@ledger/emulators';
import type { FlightSummary, TelemetryResponse } from '@ledger/contracts';
import { locate, yards } from '@ledger/simulation-models/places';
import {
  CONTINUING_MODEL,
  ROUTE_DURATION_MS,
  SOURCE_INTERVAL_MS,
  SEGMENT_INTERVAL_MS,
  DRAIN_MARGIN_MS,
  continuingExpectations,
  routeBytes,
  type ContinuingRoute,
  type SimulationTenant,
  type TelemetryFault,
} from './continuing-telemetry-model.js';
import {
  readContinuingState,
  writeContinuingState,
  type ContinuingState,
  type FlightLifecycle,
  type Publication,
} from './continuing-telemetry-state.js';
import { localBrokerAccount } from './local-broker.js';

interface Credential {
  username: string;
  password: string;
}
export interface ContinuingTelemetryConfig {
  apiUrl: string;
  /** Each organization's broker listener: the development broker gives each its own. */
  mqttUrls: Record<SimulationTenant, string>;
  interval: number;
  directory: string;
  seed: number;
  tokens: Record<SimulationTenant, string>;
  credentials: Record<SimulationTenant, { device: Credential; adapter: Credential }>;
  faults: TelemetryFault[];
}
export interface AdapterPort {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<unknown[]>;
  completeSession(): Promise<void>;
  interruptTransport(): void;
  readonly stats: {
    captured: number;
    buffered: number;
    pending: number;
    duplicateDeliveries: number;
    connections: number;
  };
}
interface DevicePort {
  start(): Promise<void>;
  publishBytes(bytes: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}
interface Runtime {
  adapter: AdapterPort;
  device: DevicePort;
}
class ContinuingSafetyError extends Error {
  constructor(readonly code: string) {
    super(`Continuing telemetry stopped: ${code}`);
  }
}
export interface ContinuingDependencies {
  client(tenant: SimulationTenant): LedgerClient;
  adapter(config: DjiAdapterConfig): AdapterPort;
  device(config: DjiEmulatorConfig): DevicePort;
  now(): number;
  sleep(ms: number): Promise<void>;
}
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
export function landingObservationTime(
  flight: Pick<FlightSummary, 'id' | 'activity' | 'scheduledEnd'>,
  telemetry?: Pick<ContinuingTelemetry, 'owns' | 'landingTime'>,
  now = Date.now(),
): string | undefined {
  if (telemetry?.owns(flight.id)) return telemetry.landingTime(flight.id);
  return flight.activity === 'active' && flight.scheduledEnd && Date.parse(flight.scheduledEnd) <= now
    ? flight.scheduledEnd
    : undefined;
}
export function continuingTelemetryConfig(
  apiUrl: string,
  interval: number,
  tokens: Record<SimulationTenant, string>,
  env: NodeJS.ProcessEnv = process.env,
): ContinuingTelemetryConfig {
  if ((env.LEDGER_ENV ?? 'local') !== 'local' || env.NODE_ENV === 'production' || !local(apiUrl))
    throw new Error(
      'Continuing telemetry is restricted to the local isolated fictional fixture; hosted enablement remains gated',
    );
  if (!Number.isFinite(interval) || interval < ROUTE_DURATION_MS + DRAIN_MARGIN_MS)
    throw new Error(
      'Continuing telemetry requires arrivals at least 150 seconds apart for its two-minute route and drain margin',
    );
  const faults = (env.SIMULATOR_TELEMETRY_FAULTS ?? '').split(',').filter(Boolean) as TelemetryFault[];
  if (
    faults.some((fault) => !['duplicate', 'late', 'reconnect'].includes(fault)) ||
    new Set(faults).size !== faults.length
  )
    throw new Error('Invalid continuing telemetry fault flags');
  // The device and the adapter both connect as the organization's seeded source.
  const credential = (tenant: SimulationTenant): Credential => {
    const { username, password } = localBrokerAccount(tenant);
    return { username, password };
  };
  const seed = Number(env.SIMULATOR_SEED ?? 71031);
  if (!Number.isSafeInteger(seed)) throw new Error('Invalid continuing telemetry seed');
  return {
    apiUrl,
    mqttUrls: { alpha: localBrokerAccount('alpha').mqttUrl, beta: localBrokerAccount('beta').mqttUrl },
    interval,
    tokens,
    seed,
    directory: resolve(env.SIMULATOR_TELEMETRY_DIR ?? '.local/simulator/continuing-telemetry'),
    credentials: {
      alpha: { device: credential('alpha'), adapter: credential('alpha') },
      beta: { device: credential('beta'), adapter: credential('beta') },
    },
    faults,
  };
}

export class ContinuingTelemetry {
  private state!: ContinuingState;
  private initialized = false;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly runtimes = new Map<SimulationTenant, Runtime>();
  private readonly lastPauseLog = new Map<SimulationTenant, number>();
  private readonly binding: string;
  private readonly statePath: string;
  private readonly dependencies: ContinuingDependencies;
  constructor(
    private readonly config: ContinuingTelemetryConfig,
    dependencies: Partial<ContinuingDependencies> = {},
  ) {
    if (
      !local(config.apiUrl) ||
      !Object.values(config.mqttUrls).every(local) ||
      config.interval < ROUTE_DURATION_MS + DRAIN_MARGIN_MS
    )
      throw new Error('Invalid local continuing telemetry target or resource interval');
    this.binding = digest(
      JSON.stringify({
        version: CONTINUING_MODEL,
        apiUrl: config.apiUrl,
        mqttUrls: config.mqttUrls,
        seed: config.seed,
        tenants: ['tenant-alpha', 'tenant-beta'],
      }),
    );
    this.statePath = join(config.directory, 'lifecycle.json');
    this.dependencies = {
      client: (tenant) =>
        new LedgerClient(config.apiUrl, config.tokens[tenant], (url, init) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
        ),
      adapter: (value) => new DjiMqttAdapter(value),
      device: (value) => new DjiOsdEmulator(value),
      now: Date.now,
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      ...dependencies,
    };
  }
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.serial.then(action);
    this.serial = task.catch(() => {});
    return task;
  }
  private async save() {
    await writeContinuingState(this.statePath, this.state);
  }
  private checkpointPath(route: ContinuingRoute) {
    return join(this.config.directory, `${route.tenant}-${digest(route.sourceSessionId)}.json`);
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const tenant of ['alpha', 'beta'] as const) {
      const identity = await this.dependencies.client(tenant).request<{ principal: { tenantId: string } }>('/v1/me');
      if (identity.principal.tenantId !== `tenant-${tenant}`)
        throw new Error('Continuing telemetry requires its distinct fictional tenant source principals');
    }
    const retained = await readContinuingState(this.statePath, this.binding);
    if (!retained) {
      const files = await readdir(this.config.directory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      if (files.some((file) => /^(?:alpha|beta)-[a-f0-9]{64}\.json$/.test(file)))
        throw new ContinuingSafetyError('lifecycle_missing_with_retained_capture');
    }
    this.state = retained ?? { version: 1, binding: this.binding, active: {}, recent: [] };
    for (const flight of [...Object.values(this.state.active), ...this.state.recent]) {
      if (flight.checkpointPath !== this.checkpointPath(flight.route))
        throw new Error('Continuing telemetry capture path does not match its logical session');
      if ('phase' in flight)
        for (const publication of [flight.publication, flight.latePublication])
          if (
            publication &&
            !Buffer.from(routeBytes(flight.route, publication.index)).equals(
              Buffer.from(publication.bytesBase64, 'base64'),
            )
          )
            throw new ContinuingSafetyError('retained_publication_commitment_mismatch');
    }
    this.initialized = true;
    await this.save();
  }
  private async prepare(tenant: SimulationTenant, flight: FlightLifecycle): Promise<Runtime> {
    const existing = this.runtimes.get(tenant);
    if (existing) return existing;
    if (flight.adapterInitialized) {
      const stat = await lstat(flight.checkpointPath).catch(() => {
        throw new ContinuingSafetyError('capture_checkpoint_missing');
      });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ContinuingSafetyError('capture_checkpoint_unsafe');
    }
    const adapter = this.dependencies.adapter({
      ledger: this.dependencies.client(tenant),
      tenantId: `tenant-${tenant}`,
      sourceId: 'dji-osd',
      sourceSessionId: flight.route.sourceSessionId,
      deviceId: `DJI-${tenant.toUpperCase()}-01`,
      gatewayId: `DJI-${tenant.toUpperCase()}-GATEWAY`,
      mqttUrl: this.config.mqttUrls[tenant],
      ...this.config.credentials[tenant].adapter,
      statePath: flight.checkpointPath,
      subject: { flightId: flight.route.flightId },
      maxSegmentAgeMs: SEGMENT_INTERVAL_MS,
    });
    const device = this.dependencies.device({
      mqttUrl: this.config.mqttUrls[tenant],
      ...this.config.credentials[tenant].device,
      deviceId: `DJI-${tenant.toUpperCase()}-01`,
      gatewayId: `DJI-${tenant.toUpperCase()}-GATEWAY`,
      clientId: `ledger-continuing-device-${tenant}`,
    });
    try {
      await adapter.initialize();
    } catch {
      throw new ContinuingSafetyError('capture_checkpoint_invalid');
    }
    try {
      flight.adapterInitialized = true;
      await this.save();
      await adapter.start();
      await device.start();
    } catch (error) {
      await adapter.stop().catch(() => {});
      await device.stop().catch(() => {});
      throw error;
    }
    const runtime = { adapter, device };
    this.runtimes.set(tenant, runtime);
    return runtime;
  }
  canStart(tenant: SimulationTenant, intentId: string): boolean {
    return !this.state?.active[tenant] || this.state.active[tenant]?.route.intentId === intentId;
  }
  owns(flightId: string): boolean {
    return (
      Object.values(this.state?.active ?? {}).some((flight) => flight.route.flightId === flightId) ||
      (this.state?.recent ?? []).some((flight) => flight.route.flightId === flightId)
    );
  }
  get activeCount(): number {
    return Object.keys(this.state?.active ?? {}).length;
  }
  get recent() {
    return structuredClone(this.state?.recent ?? []);
  }
  get status() {
    return Object.values(this.state?.active ?? {}).map((flight) => ({
      tenant: flight.route.tenant,
      flightId: flight.route.flightId,
      sourceSessionId: flight.route.sourceSessionId,
      phase: flight.phase,
      emittedSamples: flight.emittedIndices.length,
      skippedSourceTicks: flight.skippedIndices.length,
      errorCount: flight.errorCount,
      pause: flight.pause,
    }));
  }
  begin(tenant: SimulationTenant, intentId: string, flightId: string, label: string): Promise<ContinuingRoute> {
    return this.queue(async () => {
      await this.initialize();
      const completed = this.state.recent.find(
        (flight) => flight.route.intentId === intentId && flight.route.tenant === tenant,
      );
      if (completed) {
        if (completed.route.flightId !== flightId) throw new Error('Continuing intent changed flight identity');
        return completed.route;
      }
      let flight = this.state.active[tenant];
      if (flight && (flight.route.intentId !== intentId || flight.route.flightId !== flightId))
        throw new Error('Continuing telemetry device is still reserved by another flight');
      if (!flight) {
        const origin = yards[`tenant-${tenant}`]!;
        const destination = locate(label, origin).coordinate;
        const route: ContinuingRoute = {
          version: CONTINUING_MODEL,
          tenant,
          intentId,
          flightId,
          sourceSessionId: `continuing-dji:${tenant}:${intentId}:1`,
          startedAt: new Date(this.dependencies.now()).toISOString(),
          seed: this.config.seed,
          path: {
            label,
            origin: { latitude: origin.latitude, longitude: origin.longitude },
            destination: { ...destination },
          },
        };
        const publication = {
          index: 0,
          bytesBase64: Buffer.from(routeBytes(route, 0)).toString('base64'),
          duplicate: false,
        };
        flight = {
          route,
          phase: 'capturing',
          checkpointPath: this.checkpointPath(route),
          nextIndex: 1,
          publication,
          emittedIndices: [],
          skippedIndices: [],
          faults: [...this.config.faults],
          duplicateDone: false,
          reconnectDone: false,
          adapterInitialized: false,
          errorCount: 0,
        };
        this.state.active[tenant] = flight;
        await this.save();
      }
      const runtime = await this.prepare(tenant, flight);
      const elapsed = this.dependencies.now() - Date.parse(flight.route.startedAt);
      if (flight.nextIndex === 0 && !flight.publication && elapsed >= 0 && elapsed < SOURCE_INTERVAL_MS) {
        flight.publication = {
          index: 0,
          bytesBase64: Buffer.from(routeBytes(flight.route, 0)).toString('base64'),
          duplicate: false,
        };
        flight.nextIndex = 1;
        await this.save();
      }
      if (flight.publication) {
        await this.publish(flight, runtime, flight.publication);
        flight.publication = undefined;
        await this.save();
      }
      return structuredClone(flight.route);
    });
  }
  landingTime(flightId: string): string | undefined {
    const flight = Object.values(this.state.active).find((value) => value.route.flightId === flightId);
    return flight?.phase === 'draining'
      ? new Date(Date.parse(flight.route.startedAt) + ROUTE_DURATION_MS).toISOString()
      : undefined;
  }
  markLanding(flightId: string, receiptId: string): Promise<void> {
    return this.queue(async () => {
      const flight = Object.values(this.state.active).find((value) => value.route.flightId === flightId);
      if (flight) {
        if (flight.landingReceiptId && flight.landingReceiptId !== receiptId)
          throw new Error('Continuing landing receipt changed');
        flight.landingReceiptId = receiptId;
        await this.save();
      }
    });
  }
  private async publish(flight: FlightLifecycle, runtime: Runtime, publication: Publication): Promise<void> {
    const bytes = Buffer.from(publication.bytesBase64, 'base64'),
      needed = new Set([...flight.emittedIndices, publication.index]).size;
    await runtime.device.publishBytes(bytes);
    const deadline = this.dependencies.now() + 5000;
    while (runtime.adapter.stats.captured < needed) {
      if (this.dependencies.now() >= deadline)
        throw new Error('Continuing source publication remains checkpointed awaiting capture');
      await this.dependencies.sleep(25);
    }
    if (publication.duplicate) {
      await runtime.device.publishBytes(bytes);
      flight.duplicateDone = true;
    }
    if (!flight.emittedIndices.includes(publication.index)) flight.emittedIndices.push(publication.index);
  }
  private async assertInventory(flight: FlightLifecycle, view: TelemetryResponse): Promise<void> {
    const expected = continuingExpectations(flight.route, flight.emittedIndices);
    const samples = view.samples.filter(
      (sample) => sample.sourceId === 'dji-osd' && sample.sourceSessionId === flight.route.sourceSessionId,
    );
    if (view.window.truncated) throw new ContinuingSafetyError('evidence_view_truncated');
    if (samples.length > expected.sampleCount) throw new ContinuingSafetyError('source_inventory_commitment_mismatch');
    if (samples.length < expected.sampleCount) throw new Error('Continuing capture positions are awaiting projection');
    if (
      JSON.stringify(samples.map((sample) => sample.originalSha256).sort()) !== JSON.stringify(expected.originalDigests)
    )
      throw new ContinuingSafetyError('source_inventory_commitment_mismatch');
    const retained: string[] = [];
    for (const artifactId of new Set(samples.map((sample) => sample.artifactId))) {
      const bytes = await this.dependencies.client(flight.route.tenant).evidence(artifactId);
      const artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (
        artifact.sourceSessionId !== flight.route.sourceSessionId ||
        artifact.sourceId !== 'dji-osd' ||
        !Array.isArray(artifact.samples)
      )
        throw new ContinuingSafetyError('retained_artifact_session_mismatch');
      for (const sample of artifact.samples) {
        const original = sample?.original?.bytesBase64;
        if (typeof original !== 'string' || Buffer.from(original, 'base64').toString('base64') !== original)
          throw new ContinuingSafetyError('retained_original_encoding_invalid');
        retained.push(digest(Buffer.from(original, 'base64')));
      }
    }
    if (JSON.stringify(retained.sort()) !== JSON.stringify(expected.originalDigests))
      throw new ContinuingSafetyError('retained_original_commitment_mismatch');
    const latest = view.sessions.find(
      (session) => session.sourceSessionId === flight.route.sourceSessionId,
    )?.latestSample;
    if (
      expected.latest &&
      (!latest ||
        latest.occurredAt !== expected.latest.occurredAt ||
        latest.latitude !== expected.latest.latitude ||
        latest.longitude !== expected.latest.longitude)
    )
      throw new ContinuingSafetyError('source_time_latest_mismatch');
  }
  tick(): Promise<void> {
    return this.queue(async () => {
      await this.initialize();
      for (const tenant of ['alpha', 'beta'] as const) {
        const flight = this.state.active[tenant];
        if (!flight) continue;
        let stage = 'prepare';
        try {
          const runtime = await this.prepare(tenant, flight);
          let elapsed = this.dependencies.now() - Date.parse(flight.route.startedAt);
          stage = 'source_capture';
          if (flight.publication) {
            await this.publish(flight, runtime, flight.publication);
            flight.publication = undefined;
            await this.save();
          }
          if (flight.latePublication && elapsed >= 70_000) {
            await this.publish(flight, runtime, flight.latePublication);
            flight.latePublication = undefined;
            await this.save();
          }
          if (flight.phase === 'capturing') {
            elapsed = this.dependencies.now() - Date.parse(flight.route.startedAt);
            const dueIndex = Math.floor(elapsed / SOURCE_INTERVAL_MS);
            if (dueIndex > 60 && flight.nextIndex <= 60) {
              for (let index = flight.nextIndex; index <= 60; index++)
                if (!flight.skippedIndices.includes(index)) flight.skippedIndices.push(index);
              flight.nextIndex = 61;
              await this.save();
            } else if (dueIndex <= 60 && dueIndex >= flight.nextIndex) {
              for (let index = flight.nextIndex; index < dueIndex; index++)
                if (!flight.skippedIndices.includes(index)) flight.skippedIndices.push(index);
              const publication: Publication = {
                index: dueIndex,
                bytesBase64: Buffer.from(routeBytes(flight.route, dueIndex)).toString('base64'),
                duplicate: flight.faults.includes('duplicate') && dueIndex >= 10 && !flight.duplicateDone,
              };
              flight.nextIndex = dueIndex + 1;
              if (flight.faults.includes('late') && dueIndex === 20) flight.latePublication = publication;
              else flight.publication = publication;
              await this.save();
              if (flight.publication) {
                await this.publish(flight, runtime, flight.publication);
                flight.publication = undefined;
                await this.save();
              }
            }
            if (flight.faults.includes('reconnect') && elapsed >= 60_000 && !flight.reconnectDone) {
              flight.reconnectDone = true;
              await this.save();
              runtime.adapter.interruptTransport();
            }
            if (
              elapsed >= ROUTE_DURATION_MS &&
              flight.nextIndex === 61 &&
              !flight.publication &&
              !flight.latePublication
            ) {
              flight.phase = 'draining';
              await this.save();
            }
          }
          if (flight.phase === 'draining') {
            stage = 'final_flush';
            await runtime.adapter.flush();
            if (flight.landingReceiptId) {
              stage = 'landing_projection';
              const landing = await this.dependencies.client(tenant).receipt(flight.landingReceiptId);
              if (landing.receipt.processing.status === 'failed')
                throw new ContinuingSafetyError('landing_receipt_failed');
              if (landing.receipt.processing.status !== 'completed') continue;
              if (landing.receipt.flightId !== flight.route.flightId || landing.receipt.kind !== 'flight.observation')
                throw new Error('Continuing landing receipt belongs to another flight');
              stage = 'evidence_projection';
              await this.assertInventory(
                flight,
                await this.dependencies.client(tenant).telemetry(flight.route.flightId),
              );
              stage = 'session_cleanup';
              await runtime.adapter.completeSession();
              await runtime.device.stop();
              this.runtimes.delete(tenant);
              if (this.state.recent.length === 32) {
                if (this.state.recent[0]!.cleanupPending)
                  throw new ContinuingSafetyError('completed_checkpoint_cleanup_backlog');
                this.state.recent.shift();
              }
              this.state.recent.push({
                route: flight.route,
                checkpointPath: flight.checkpointPath,
                emittedIndices: flight.emittedIndices,
                skippedIndices: flight.skippedIndices,
                landingReceiptId: flight.landingReceiptId,
                cleanupPending: true,
              });
              delete this.state.active[tenant];
              await this.save();
            }
          }
          if (flight.pause) {
            flight.pause = undefined;
            await this.save();
          }
        } catch (error) {
          flight.errorCount++;
          const code = error instanceof ContinuingSafetyError ? error.code : 'temporarily_unavailable';
          flight.pause = { stage, code, at: new Date(this.dependencies.now()).toISOString() };
          await this.save();
          const last = this.lastPauseLog.get(tenant);
          if (
            last === undefined ||
            this.dependencies.now() - last >= 60_000 ||
            error instanceof ContinuingSafetyError
          ) {
            this.lastPauseLog.set(tenant, this.dependencies.now());
            console.error(
              JSON.stringify({
                event: 'continuing_telemetry_paused',
                tenant,
                flightId: flight.route.flightId,
                sourceSessionId: flight.route.sourceSessionId,
                stage,
                code,
                attempts: flight.errorCount,
              }),
            );
          }
          if (stage === 'session_cleanup') {
            const runtime = this.runtimes.get(tenant);
            if (runtime) {
              await runtime.adapter.stop().catch(() => {});
              await runtime.device.stop().catch(() => {});
              this.runtimes.delete(tenant);
            }
          }
          if (error instanceof ContinuingSafetyError) throw error;
        }
      }
      const cleanup = this.state.recent.filter((flight) => flight.cleanupPending);
      for (const completed of cleanup) {
        await unlink(completed.checkpointPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        completed.cleanupPending = false;
      }
      if (cleanup.length) await this.save();
    });
  }
  async stop(): Promise<void> {
    await this.serial;
    const results = await Promise.allSettled(
      [...this.runtimes.values()].flatMap((runtime) => [runtime.device.stop(), runtime.adapter.stop()]),
    );
    this.runtimes.clear();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
