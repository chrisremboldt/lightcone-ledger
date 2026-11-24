import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advanceOperation, createOperation } from '../../../packages/simulation-models/src/operation.js';
import { runOperation } from '../src/operation.js';
import { scenarioConfig } from '../src/scenario.js';
import { initialOperationCheckpoint, OperationStore, readOperationCheckpoint } from '../src/operation-state.js';
import {
  advanceRunnerClock,
  assertFreshOperationStart,
  assertOperationCredentials,
  HOSTED_WORLD_LIMITS,
  operationTarget,
} from '../src/operation-target.js';

const statePath = '/data/ledger/rich-worlds/hosted-test.json';
const staging = {
  LEDGER_ENV: 'staging',
  LEDGER_SIMULATION_TARGET: 'isolated',
  FLY_APP_NAME: 'ledger-staging',
  LEDGER_API_URL: 'http://127.0.0.1:4000',
  EMULATOR_BASE_URL: 'http://127.0.0.1:4002',
  SIMULATOR_CALLBACK_HOST: '127.0.0.1',
  SIMULATOR_WORLD_CALLBACK_PORT: '4003',
  SIMULATOR_WORLD_MQTT_PORT: '1884',
  SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:1884',
  SIMULATOR_WORLD_BROKER_PROFILE: 'hosted.2',
  SIMULATOR_WORLD_STATE: statePath,
  SIMULATOR_WORLD_RUN_ID: 'hosted-test',
};
const hostedTarget = { environment: 'staging', mqttPort: 1884 } as const;

describe('explicit hosted world target', () => {
  it('requires the isolated staging context, private retained path and fixed loopback services', async () => {
    expect(operationTarget({}, '/tmp/local-world.json')).toEqual({ environment: 'local' });
    expect(operationTarget(staging, statePath)).toEqual(hostedTarget);
    for (const changed of [
      { FLY_APP_NAME: 'another-app' },
      { LEDGER_ENV: 'local' },
      { LEDGER_API_URL: 'https://example.invalid' },
      { SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:1883' },
      { SIMULATOR_WORLD_BINDINGS: '/data/ledger/another-world/bindings.json' },
      { SIMULATOR_WORLD_STATE: '/tmp/local-world.json' },
      { SIMULATOR_WORLD_DEPARTURE_PLAN: '/data/ledger/selected-departure.json' },
    ])
      expect(() => operationTarget({ ...staging, ...changed }, statePath)).toThrow();
    const unsafePath = '/data/ledger/rich-worlds/bad name.json';
    expect(() => operationTarget({ ...staging, SIMULATOR_WORLD_STATE: unsafePath }, unsafePath)).toThrow('persistent');
    await expect(
      runOperation({
        ...staging,
        SIMULATOR_WORLD_MODE: 'revise',
        SIMULATOR_WORLD_REVISION_PLAN: '/data/ledger/revision.json',
      }),
    ).rejects.toThrow('live ordinary dispatch only');
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-target-'));
    try {
      await expect(
        runOperation({
          LEDGER_ENV: 'staging',
          SIMULATOR_WORLD_MODE: 'broker',
          SIMULATOR_WORLD_STATE: join(directory, 'world.json'),
        }),
      ).rejects.toThrow('dedicated isolated');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts a fresh hosted world at wall time while retaining the original start on recovery', () => {
    const now = Date.now();
    expect(() => assertFreshOperationStart(hostedTarget, now, false)).not.toThrow();
    expect(() => assertFreshOperationStart(hostedTarget, now - 61_000, false)).toThrow('current UTC');
    expect(() => assertFreshOperationStart(hostedTarget, now - 86_400_000, true)).not.toThrow();
    expect(() => assertFreshOperationStart({ environment: 'local' }, now - 86_400_000, false)).not.toThrow();
  });

  it('requires separately provisioned source, actor and emulator credentials without development fallbacks', () => {
    expect(() => assertOperationCredentials(hostedTarget, scenarioConfig({}))).toThrow('separately provisioned');
    const config = scenarioConfig({
      ...staging,
      EMULATOR_ADMIN_KEY: 'staging-emulator-admin-credential',
      PARTNER_API_KEY: 'staging-partner-api-credential',
      AIRSPACE_USER_CLIENT_ID: 'staging-user-client',
      AIRSPACE_CALLBACK_SECRET: 'staging-callback-credential',
      ALPHA_SOURCE_TOKEN: 'staging-alpha-source-credential',
      ALPHA_ACTOR_TOKEN: 'staging-alpha-actor-credential',
      BETA_SOURCE_TOKEN: 'staging-beta-source-credential',
      BETA_ACTOR_TOKEN: 'staging-beta-actor-credential',
    });
    expect(() => assertOperationCredentials(hostedTarget, config)).not.toThrow();
    config.tokens.beta.source = config.tokens.alpha.source;
    expect(() => assertOperationCredentials(hostedTarget, config)).toThrow('separately provisioned');
  });

  it('bounds hosted catch-up and retains every pending original when the backlog pauses advancement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-backpressure-'));
    try {
      const world = createOperation({ runId: 'backpressure', start: '2026-10-16T18:00:00.000Z' });
      const start = world.now;
      const checkpoint = initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false });
      expect(advanceRunnerClock(checkpoint, start + 3_600_000, false, hostedTarget)).toBe(false);
      expect(world.now).toBe(start + HOSTED_WORLD_LIMITS.advanceMs);
      expect(world.facts.every((fact) => Date.parse(fact.at) <= world.now)).toBe(true);
      const path = join(directory, 'world.json');
      const store = new OperationStore(path, checkpoint);
      await store.update((state) => {
        while (state.world.nextFact < HOSTED_WORLD_LIMITS.pendingFacts)
          advanceOperation(state.world, state.world.now + 60_000);
        state.clock.wallAt = state.world.now;
      });
      const originals = JSON.stringify(store.state.pending);
      const now = store.state.world.now;
      await store.update((state) => {
        expect(advanceRunnerClock(state, now + 60_000, false, hostedTarget)).toBe(true);
      });
      const restored = await readOperationCheckpoint(path);
      expect(restored!.clock.paused).toBe(true);
      expect(restored!.world.now).toBe(now);
      expect(JSON.stringify(restored!.pending)).toBe(originals);
      expect(restored!.world.nextFact - restored!.accepted).toBeGreaterThanOrEqual(HOSTED_WORLD_LIMITS.pendingFacts);
      const resumed = new OperationStore(path, restored!);
      expect(resumed.pendingHeads()).toEqual(store.pendingHeads());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
