import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  LedgerClient,
  DjiMqttAdapter,
  digest,
  DJI_LIMITATIONS,
  DJI_DOCUMENTATION_DIGEST,
  type AdapterResult,
} from '@ledger/adapters';
import { DjiOsdEmulator, djiOsdBytes, qos1ReconnectFault, type DjiWorldPoint } from '@ledger/emulators';
import type { TelemetryResponse } from '@ledger/contracts';
import { acquireControlLease } from './control-lease.js';
import { localBrokerAccount } from './local-broker.js';

type MqttCredential = { username: string; password: string };
type FixtureCredentials = { device: MqttCredential; adapter: MqttCredential };
export interface DjiScenarioConfig {
  environment: 'local' | 'staging';
  apiUrl: string;
  /** Each organization's broker listener: the development broker gives each its own. */
  mqttUrls: { alpha: string; beta: string };
  emulatorUrl?: string;
  adminKey?: string;
  reportDirectory: string;
  checkpointDirectory: string;
  seed: number;
  start: string;
  tokens: { alpha: string; beta: string };
  mqttCredentials: { alpha: FixtureCredentials; beta: FixtureCredentials };
}
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
export function djiScenarioConfig(env: NodeJS.ProcessEnv = process.env): DjiScenarioConfig {
  const apiUrl = env.LEDGER_API_URL ?? 'http://127.0.0.1:4000';
  if ((env.LEDGER_ENV ?? 'local') !== 'local' || env.NODE_ENV === 'production' || !local(apiUrl))
    throw new Error('This DJI scenario is restricted to the local fictional fixture');
  const reportDirectory = env.DJI_REPORT_DIR ?? '.local/scenarios/dji-osd';
  // The device and the adapter both connect as the organization's seeded source.
  const credentials = (tenant: 'alpha' | 'beta'): FixtureCredentials => {
    const { username, password } = localBrokerAccount(tenant);
    return { device: { username, password }, adapter: { username, password } };
  };
  return {
    environment: 'local',
    apiUrl,
    mqttUrls: { alpha: localBrokerAccount('alpha').mqttUrl, beta: localBrokerAccount('beta').mqttUrl },
    emulatorUrl: env.EMULATOR_BASE_URL ?? 'http://127.0.0.1:4002',
    adminKey: env.EMULATOR_ADMIN_KEY ?? 'ledger-local-emulator-admin',
    reportDirectory,
    checkpointDirectory: env.DJI_CHECKPOINT_DIR ?? reportDirectory,
    seed: Number(env.DJI_SCENARIO_SEED ?? 73031),
    start: env.DJI_SCENARIO_START ?? '2026-10-01T17:00:00.000Z',
    tokens: {
      alpha: env.ALPHA_SOURCE_TOKEN ?? 'ledger-dev-alpha-source',
      beta: env.BETA_SOURCE_TOKEN ?? 'ledger-dev-beta-source',
    },
    mqttCredentials: { alpha: credentials('alpha'), beta: credentials('beta') },
  };
}
export function assertDjiStagingContext(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.LEDGER_ENV !== 'staging' ||
    env.LEDGER_SIMULATION_TARGET !== 'isolated' ||
    env.FLY_APP_NAME !== 'ledger-staging'
  )
    throw new Error('Hosted DJI scenario requires the dedicated isolated ledger-staging Fly app');
}
function stagingSecret(key: string, value: string) {
  if (!value || value !== value.trim() || value.length < 24 || /^(?:ledger-local-|ledger-dev-)/.test(value))
    throw new Error(`Hosted DJI scenario requires a separately provisioned ${key}`);
  return value;
}
export function djiStagingScenarioConfig(env: NodeJS.ProcessEnv = process.env): DjiScenarioConfig {
  assertDjiStagingContext(env);
  const required = (key: string) => {
    const value = env[key];
    if (!value || value !== value.trim()) throw new Error(`Hosted DJI scenario requires ${key}`);
    return value;
  };
  const secret = (key: string) => stagingSecret(key, required(key));
  const credentials = (tenant: 'ALPHA' | 'BETA'): FixtureCredentials => {
    const credential = (kind: 'DEVICE' | 'ADAPTER'): MqttCredential => {
      const username = required(`DJI_${tenant}_${kind}_USERNAME`);
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(username) || /^(?:ledger-local-|ledger-dev-)/.test(username))
        throw new Error('Hosted DJI scenario requires scoped MQTT usernames');
      return { username, password: secret(`DJI_${tenant}_${kind}_PASSWORD`) };
    };
    return { device: credential('DEVICE'), adapter: credential('ADAPTER') };
  };
  const config: DjiScenarioConfig = {
    environment: 'staging',
    apiUrl: env.DJI_SCENARIO_API_URL ?? 'http://127.0.0.1:4000',
    mqttUrls: { alpha: env.DJI_MQTT_URL ?? 'mqtt://127.0.0.1:1883', beta: env.DJI_MQTT_URL ?? 'mqtt://127.0.0.1:1883' },
    emulatorUrl: env.EMULATOR_BASE_URL ?? 'http://127.0.0.1:4002',
    adminKey: secret('EMULATOR_ADMIN_KEY'),
    reportDirectory: required('DJI_REPORT_DIR'),
    checkpointDirectory: required('DJI_CHECKPOINT_DIR'),
    seed: Number(env.DJI_SCENARIO_SEED ?? 73031),
    start: env.DJI_SCENARIO_START ?? '2026-10-01T17:00:00.000Z',
    tokens: { alpha: secret('ALPHA_SOURCE_TOKEN'), beta: secret('BETA_SOURCE_TOKEN') },
    mqttCredentials: { alpha: credentials('ALPHA'), beta: credentials('BETA') },
  };
  assertDjiScenarioTarget(config);
  djiWorld(config.seed, config.start);
  return config;
}
function assertDjiScenarioTarget(config: DjiScenarioConfig) {
  if (config.environment === 'staging') {
    if (
      config.apiUrl !== 'http://127.0.0.1:4000' ||
      Object.values(config.mqttUrls).some((url) => url !== 'mqtt://127.0.0.1:1883') ||
      config.emulatorUrl !== 'http://127.0.0.1:4002' ||
      config.checkpointDirectory !== '/data/ledger/dji-checkpoints' ||
      config.reportDirectory !== '/data/ledger/dji-reports'
    )
      throw new Error('Hosted DJI scenario requires fixed loopback services and dedicated fixture directories');
    stagingSecret('emulator admin key', config.adminKey ?? '');
    const allCredentials = Object.values(config.mqttCredentials).flatMap((tenant) => [tenant.device, tenant.adapter]);
    for (const credential of allCredentials) {
      if (
        !/^[A-Za-z0-9._-]{1,128}$/.test(credential.username) ||
        /^(?:ledger-local-|ledger-dev-)/.test(credential.username)
      )
        throw new Error('Hosted DJI scenario requires scoped MQTT usernames');
      stagingSecret('MQTT password', credential.password);
    }
    for (const token of Object.values(config.tokens)) stagingSecret('source token', token);
    if (
      allCredentials.length !== 4 ||
      new Set(allCredentials.map((value) => value.username)).size !== 4 ||
      new Set([...allCredentials.map((value) => value.password), ...Object.values(config.tokens)]).size !== 6
    )
      throw new Error('Hosted DJI scenario requires distinct tenant and role credentials');
  } else if (
    config.environment !== 'local' ||
    !local(config.apiUrl) ||
    !Object.values(config.mqttUrls).every(local) ||
    !local(config.emulatorUrl ?? 'http://127.0.0.1:4002')
  )
    throw new Error('Local-only DJI scenario target required');
}
export function djiWorld(seed = 73031, start = '2026-10-01T17:00:00.000Z') {
  if (!Number.isSafeInteger(seed) || !Number.isFinite(Date.parse(start)))
    throw new Error('Invalid DJI hidden-world seed or time');
  const offset = (Math.abs(seed) % 100) * 0.000001;
  const point = (second: number, index: number): DjiWorldPoint => ({
    occurredAt: new Date(Date.parse(start) + second * 1000).toISOString(),
    latitude: 41.88 + offset + index * 0.001,
    longitude: -87.63 - index * 0.001,
    height: 200 + index * 10,
    horizontalSpeed: 10 + index,
  });
  return {
    seed,
    start,
    alpha: [point(0, 0), point(2, 1), point(4, 2), point(6, 3), point(3, 4)],
    beta: [{ ...point(1, 0), latitude: 41.87, longitude: -87.65 }],
    expected: {
      alphaCapturePositions: [1, 2, 3, 4, 5],
      gap: { fromSequence: 1, toSequence: 2 },
      latestAlpha: point(6, 3),
      betaSamples: 1,
    },
    limitations: [...DJI_LIMITATIONS],
  };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 30000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await pause(50);
  } while (Date.now() < until);
  throw new Error(`DJI scenario timeout: ${label}`);
}
function childRpc(child: ChildProcess) {
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  child.on('message', (message: any) => {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
  });
  child.on('exit', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Local capture child exited'));
    }
    pending.clear();
  });
  return (action: string, config?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.delete(id);
          reject(new Error('Local capture child deadline exceeded'));
        }, 15000),
      });
      child.send({ id, action, ...(config ? { config } : {}) });
    });
}
async function watch(config: DjiScenarioConfig, flightId: string, cursor: string) {
  const controller = new AbortController();
  const messages: any[] = [];
  const response = await fetch(
    `${config.apiUrl}/v1/flights/${encodeURIComponent(flightId)}/watch?cursor=${encodeURIComponent(cursor)}`,
    { headers: { authorization: `Bearer ${config.tokens.alpha}` }, signal: controller.signal },
  );
  if (response.status !== 200 || !response.body) throw new Error('DJI scenario watch unavailable');
  const reader = response.body.getReader();
  const completion = (async () => {
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) messages.push(JSON.parse(data.slice(6)));
        }
      }
    } catch {
      if (!controller.signal.aborted) throw new Error('DJI watch transport failed');
    }
  })();
  return {
    messages,
    async close() {
      controller.abort();
      await completion;
    },
  };
}
export async function runDjiScenario(config: DjiScenarioConfig = djiScenarioConfig()) {
  assertDjiScenarioTarget(config);
  if (config.environment === 'staging') assertDjiStagingContext();
  const world = djiWorld(config.seed, config.start),
    runId = `dji-osd-${randomUUID()}`;
  let assertControl = () => {};
  const clients = {
    alpha: new LedgerClient(config.apiUrl, config.tokens.alpha, (url, init) => {
      assertControl();
      return fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    }),
    beta: new LedgerClient(config.apiUrl, config.tokens.beta, (url, init) => {
      assertControl();
      return fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    }),
  };
  if (config.environment === 'staging')
    for (const tenant of ['alpha', 'beta'] as const) {
      const who = await clients[tenant].request<{ principal: { tenantId: string } }>('/v1/me');
      if (who.principal.tenantId !== `tenant-${tenant}`)
        throw new Error('Hosted DJI scenario requires the fictional Alpha and Beta source principals');
    }
  const controlLease = await acquireControlLease(
    config.emulatorUrl ?? 'http://127.0.0.1:4002',
    config.adminKey ?? 'ledger-local-emulator-admin',
    'scenario',
  );
  try {
    assertControl = () => {
      controlLease.headers();
    };
    const eventually = <T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean) =>
      waitFor(
        label,
        () => {
          controlLease.headers();
          return read();
        },
        (value) => {
          controlLease.headers();
          return ready(value);
        },
      );
    controlLease.headers();
    await mkdir(config.reportDirectory, { recursive: true, mode: 0o700 });
    const runDirectory = join(config.checkpointDirectory, runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const createdAlpha = await clients.alpha.createFlight(
        { originationKey: `${runId}:alpha`, label: 'Rooftop survey · Dock 1' },
        `${runId}:alpha:flight`,
      ),
      createdBeta = await clients.beta.createFlight(
        { originationKey: `${runId}:beta`, label: 'Tower inspection · Site 4' },
        `${runId}:beta:flight`,
      );
    const flightIds = { alpha: createdAlpha.flight.id, beta: createdBeta.flight.id };
    const makeConfig = (tenant: 'alpha' | 'beta') => ({
      ledger: clients[tenant],
      tenantId: `tenant-${tenant}`,
      sourceId: 'dji-osd',
      sourceSessionId: `${runId}:${tenant}`,
      deviceId: `DJI-${tenant.toUpperCase()}-01`,
      gatewayId: `DJI-${tenant.toUpperCase()}-GATEWAY`,
      mqttUrl: config.mqttUrls[tenant],
      ...config.mqttCredentials[tenant].adapter,
      statePath: join(runDirectory, `${tenant}-checkpoint.json`),
      subject: { flightId: flightIds[tenant] },
    });
    const alphaConfig = makeConfig('alpha'),
      beta = new DjiMqttAdapter(makeConfig('beta'));
    let alpha: DjiMqttAdapter | undefined;
    const fault = await qos1ReconnectFault(Number(new URL(config.mqttUrls.alpha).port || 1883));
    const alphaDevice = new DjiOsdEmulator({
      mqttUrl: fault.url,
      deviceId: alphaConfig.deviceId,
      gatewayId: alphaConfig.gatewayId,
      ...config.mqttCredentials.alpha.device,
      clientId: `${runId}-alpha`,
    });
    const betaDevice = new DjiOsdEmulator({
      mqttUrl: config.mqttUrls.beta,
      deviceId: 'DJI-BETA-01',
      gatewayId: 'DJI-BETA-GATEWAY',
      ...config.mqttCredentials.beta.device,
      clientId: `${runId}-beta`,
    });
    const childPath = new URL(
      import.meta.url.endsWith('.ts') ? './dji-capture-child.ts' : './dji-capture-child.js',
      import.meta.url,
    );
    const child = fork(fileURLToPath(childPath), [], {
      execArgv: process.execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const rpc = childRpc(child);
    const originalBytes: Uint8Array[] = [];
    const emissions: AdapterResult[] = [];
    const assertions: Array<{ name: string; passed: boolean; expected: unknown; actual: unknown }> = [];
    const equal = (name: string, expected: unknown, actual: unknown) =>
      assertions.push({ name, expected, actual, passed: JSON.stringify(expected) === JSON.stringify(actual) });
    let stream: Awaited<ReturnType<typeof watch>> | undefined;
    async function settle(result: AdapterResult) {
      controlLease.headers();
      emissions.push(result);
      await eventually(
        'durable segment worker completion',
        () => clients.alpha.receipt(result.receipt.receipt.id),
        (value) => value.receipt.processing.status === 'completed',
      );
    }
    try {
      const { ledger, ...childConfig } = alphaConfig;
      await rpc('configure', { ...childConfig, apiUrl: config.apiUrl, ledgerToken: config.tokens.alpha });
      await beta.start();
      await alphaDevice.start();
      await betaDevice.start();
      await betaDevice.publish(world.beta[0]!, { tid: `${runId}:beta:1`, bid: `${runId}:beta:1` });
      await eventually(
        'beta capture',
        async () => beta.stats,
        (value) => value.captured === 1,
      );
      const betaResult = (await beta.flush())[0]!;
      await eventually(
        'beta worker completion',
        () => clients.beta.receipt(betaResult.receipt.receipt.id),
        (value) => value.receipt.processing.status === 'completed',
      );
      const betaBefore = await clients.beta.telemetry(flightIds.beta);
      for (let index = 0; index < 2; index++) {
        const raw = djiOsdBytes(world.alpha[index]!, alphaConfig.gatewayId, {
          tid: `${runId}:alpha:${index + 1}`,
          bid: `${runId}:alpha:${index + 1}`,
        });
        originalBytes.push(raw);
        await alphaDevice.publishBytes(raw);
      }
      const childStats = await eventually(
        'durable alpha capture and QoS retransmission',
        () => rpc('stats'),
        (value) => value.captured === 2 && value.duplicateDeliveries >= 1,
      );
      const heldId = await rpc('seal');
      const exit = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL');
      equal('capture process actually terminated before upload', 'SIGKILL', await exit);
      alpha = new DjiMqttAdapter(alphaConfig);
      await alpha.start();
      equal('SIGKILL recovery preserves pending segment', 1, alpha.stats.pending);
      equal(
        'logical source session survives process restart',
        alphaConfig.sourceSessionId,
        alpha.stats.sourceSessionId,
      );
      await alphaDevice.publishBytes(originalBytes[0]!);
      await eventually(
        'duplicate after process restart',
        async () => alpha!.stats,
        (value) => value.duplicateDeliveries >= 1,
      );
      equal('same retained source bytes do not allocate another position', 3, alpha.stats.nextSequence);
      alpha.interruptTransport();
      await eventually(
        'MQTT subscriber reconnect',
        async () => alpha!.stats,
        (value) => value.connections >= 2,
      );
      for (let index = 2; index < 4; index++) {
        const raw = djiOsdBytes(world.alpha[index]!, alphaConfig.gatewayId, {
          tid: `${runId}:alpha:${index + 1}`,
          bid: `${runId}:alpha:${index + 1}`,
        });
        originalBytes.push(raw);
        await alphaDevice.publishBytes(raw);
      }
      await eventually(
        'next alpha bounded segment',
        async () => alpha!.stats,
        (value) => value.captured === 4,
      );
      const newerId = await alpha.seal();
      const newerResult = await alpha.commitPending(newerId!);
      await settle(newerResult);
      const gap = await clients.alpha.telemetry(flightIds.alpha);
      equal(
        'missing durable adapter-capture positions are shown',
        world.expected.gap,
        gap.gaps[0] ? { fromSequence: gap.gaps[0].fromSequence, toSequence: gap.gaps[0].toSequence } : null,
      );
      equal(
        'latest sample follows source time before held segment',
        world.expected.latestAlpha.occurredAt,
        gap.sessions[0]?.latestSample?.occurredAt,
      );
      stream = await watch(config, flightIds.alpha, gap.cursor);
      const heldResult = await alpha.commitPending(heldId);
      await settle(heldResult);
      await eventually(
        'SSE durable segment notice',
        async () => stream!.messages,
        (value) =>
          value.some(
            (message) => message.type === 'telemetry.updated' && message.receiptId === heldResult.receipt.receipt.id,
          ),
      );
      equal(
        'SSE notice names this durable receipt',
        true,
        stream.messages.some(
          (message) => message.type === 'telemetry.updated' && message.receiptId === heldResult.receipt.receipt.id,
        ),
      );
      await stream.close();
      stream = undefined;
      const filled = await clients.alpha.telemetry(flightIds.alpha);
      equal('delayed original segment closes capture-position gap', [], filled.gaps);
      equal(
        'older delayed segment cannot roll back latest source-time point',
        world.expected.latestAlpha.occurredAt,
        filled.sessions[0]?.latestSample?.occurredAt,
      );
      stream = await watch(config, flightIds.alpha, filled.cursor);
      const late = djiOsdBytes(world.alpha[4]!, alphaConfig.gatewayId, {
        tid: `${runId}:alpha:5`,
        bid: `${runId}:alpha:5`,
      });
      originalBytes.push(late);
      await alphaDevice.publishBytes(late);
      await eventually(
        'late source-time capture',
        async () => alpha!.stats,
        (value) => value.captured === 5,
      );
      const lateResult = (await alpha.flush())[0]!;
      await settle(lateResult);
      await eventually(
        'resumed SSE notice',
        async () => stream!.messages,
        (value) =>
          value.some(
            (message) => message.type === 'telemetry.updated' && message.receiptId === lateResult.receipt.receipt.id,
          ),
      );
      const final = await clients.alpha.telemetry(flightIds.alpha),
        betaAfter = await clients.beta.telemetry(flightIds.beta);
      equal(
        'all independently expected capture positions are durable',
        world.expected.alphaCapturePositions,
        [...new Set(final.samples.map((sample) => sample.sequence))].sort((a, b) => a - b),
      );
      equal(
        'late arrival remains visible',
        true,
        final.samples.some((sample) => sample.occurredAt === world.alpha[4]!.occurredAt),
      );
      equal(
        'higher capture position with older source time does not move current point backward',
        world.expected.latestAlpha.occurredAt,
        final.sessions[0]?.latestSample?.occurredAt,
      );
      equal(
        'current point coordinates match hidden world',
        [world.expected.latestAlpha.latitude, world.expected.latestAlpha.longitude],
        [final.sessions[0]?.latestSample?.latitude, final.sessions[0]?.latestSample?.longitude],
      );
      equal(
        'durable samples carry ellipsoid reference',
        true,
        final.samples.every((sample) => sample.durable && sample.altitudeReference === 'ellipsoid'),
      );
      equal(
        'beta telemetry is unaffected by alpha activity',
        betaBefore.samples.map((sample) => sample.id),
        betaAfter.samples.map((sample) => sample.id),
      );
      equal('beta expected sample count', world.expected.betaSamples, betaAfter.samples.length);
      const forbidden = await fetch(`${config.apiUrl}/v1/flights/${flightIds.alpha}/telemetry`, {
        headers: { authorization: `Bearer ${config.tokens.beta}` },
      });
      equal('wrong tenant cannot read alpha telemetry', 404, forbidden.status);
      const retainedRaw: Uint8Array[] = [];
      for (const emission of emissions) {
        const blob = JSON.parse(new TextDecoder().decode(await clients.alpha.evidence(emission.artifactId)));
        for (const sample of blob.samples) retainedRaw.push(Buffer.from(sample.original.bytesBase64, 'base64'));
      }
      equal(
        'every Alpha original MQTT byte string is retained exactly',
        originalBytes.map((bytes) => digest(bytes)).sort(),
        retainedRaw.map((bytes) => digest(bytes)).sort(),
      );
      equal(
        'MQTT lost PUBACK causes actual retransmission',
        true,
        fault.droppedAck &&
          fault.publishes.length >= 2 &&
          fault.publishes[1]!.messageId === fault.publishes[0]!.messageId,
      );
      equal('pre-crash MQTT duplicate is suppressed', true, childStats.duplicateDeliveries >= 1);
      equal('post-restart MQTT duplicate does not create durable copies', 0, final.sessions[0]?.duplicateCount);
      equal(
        'fixture is explicitly synthetic and capture-sequenced',
        'adapter_capture',
        final.sessions[0]?.sequenceBasis,
      );
      const report = {
        status: assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
        scenario: 'dji-osd-mqtt.1',
        environment: config.environment,
        scope: 'isolated-fictional-tenants',
        runId,
        checkedAt: new Date().toISOString(),
        sourceDocumentationDigest: DJI_DOCUMENTATION_DIGEST,
        flightIds,
        world,
        emissions: emissions.map((result) => {
          const { id, sourceId, kind, receivedAt, occurredAt, status, artifactId, eventId, payload } =
            result.receipt.receipt;
          return {
            receiptId: id,
            eventId,
            artifactId: result.artifactId,
            sha256: result.sha256,
            receiptEvidence: { id, sourceId, kind, receivedAt, occurredAt, status, artifactId, eventId, payload },
          };
        }),
        assertions,
        transport: {
          lostPuback: fault.droppedAck,
          publisherReconnects: alphaDevice.connections,
          publishAttempts: fault.publishes,
          captureProcessKilled: 'SIGKILL',
          subscriberConnections: alpha.stats.connections,
        },
        snapshots: { gap, filled, final, beta: betaAfter },
        limitations: [
          ...DJI_LIMITATIONS,
          `This bounded ${config.environment} fictional scenario verifies selected OSD capture and durable SSE references, not live DJI credentials, device firmware, broker hardware failure or throughput.`,
        ],
      };
      controlLease.headers();
      await writeFile(join(config.reportDirectory, 'evidence-report.json'), JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      });
      if (report.status !== 'passed') throw new Error('DJI scenario assertion failed; inspect private evidence report');
      return report;
    } finally {
      if (stream) await stream.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await alphaDevice.stop();
      await betaDevice.stop();
      await alpha?.stop();
      await beta.stop();
      await fault.close();
    }
  } finally {
    await controlLease.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runDjiScenario();
  console.log(
    `DJI MQTT scenario: ${report.status}; ${report.assertions.length} assertions. Evidence report: ${join(djiScenarioConfig().reportDirectory, 'evidence-report.json')}`,
  );
}
