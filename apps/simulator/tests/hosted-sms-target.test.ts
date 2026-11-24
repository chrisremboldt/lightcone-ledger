import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperation, operationCapacityPreset } from '@ledger/simulation-models/operation';
import { assertHostedSmsWorld, loadHostedSmsTarget } from '../src/hosted-sms-target.js';
import { operationTarget } from '../src/operation-target.js';
import { prepareSmsFollowup, prepareSmsIncident, type SmsRehearsalPreparation } from '../src/sms-rehearsal-plan.js';
import {
  config,
  incidentStart,
  incidentPreparedAt,
  followupStart,
  followupPreparedAt,
  selection,
} from './sms-rehearsal-fixtures.js';

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  envelope: vi.fn(),
  text: vi.fn(),
  preparation: vi.fn(),
  revision: vi.fn(),
  departure: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  lstat: mocks.metadata,
}));
vi.mock('../src/private-journal.js', async (original) => ({
  ...(await original<typeof import('../src/private-journal.js')>()),
  readJournalEnvelope: mocks.envelope,
  readPrivateText: mocks.text,
}));
vi.mock('../src/sms-rehearsal-files.js', () => ({
  readRetainedSmsPreparation: mocks.preparation,
  readRetainedSmsRevision: mocks.revision,
  readRetainedSmsDeparture: mocks.departure,
}));

function configuration() {
  return {
    ...config(),
    version: 3 as const,
    target: 'isolated-staging.1' as const,
    directory: '/data/ledger/world/sms/sms-unit',
    apiUrl: 'http://127.0.0.1:4000',
    emulatorUrl: 'http://127.0.0.1:4002',
    ports: { mqtt: 1884, callback: 4003 },
    fleet: { alpha: 3 as const, beta: 2 as const },
    capacityPreset: 'illustrative-25.1' as const,
    predepartureProfile: 'reserve-selected-await-release.1' as const,
    followup: { ...config().followup, windowEndOffsetMs: 420_000 },
  };
}

function environment(preparation: SmsRehearsalPreparation) {
  return { ...preparation.environment, SIMULATOR_WORLD_MODE: 'live' };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.metadata.mockImplementation(async (path: string) => ({
    isDirectory: () => !path.endsWith('monitoring.plan.json'),
    isFile: () => path.endsWith('monitoring.plan.json'),
    isSymbolicLink: () => false,
    mode: path.endsWith('monitoring.plan.json') ? 0o600 : 0o700,
    size: 100,
  }));
});

describe('retained hosted SMS target', () => {
  it('binds a modest incident world to its exact private preparation before permitting hosted delivery', async () => {
    const preparation = prepareSmsIncident(configuration(), incidentStart, incidentPreparedAt);
    const env = environment(preparation);
    mocks.envelope.mockResolvedValue(preparation);
    mocks.preparation.mockResolvedValue(preparation);
    const target = operationTarget(env, preparation.worldPath);
    await expect(loadHostedSmsTarget(env, target)).resolves.toEqual({ preparation });
    const world = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId: preparation.runId,
      start: preparation.start,
      seed: preparation.config.seed,
      fleet: preparation.config.fleet,
      missionPlan: 'dispatch-plan.1',
      commandLinkEpisode: 'canal-market-relay.1',
    });
    expect(() => assertHostedSmsWorld(preparation, world)).not.toThrow();
    world.config.fleet = { ...world.config.fleet, alpha: 25 };
    expect(() => assertHostedSmsWorld(preparation, world)).toThrow('exact prepared profile');
    await expect(loadHostedSmsTarget({ ...env, SIMULATOR_WORLD_FLEET_ALPHA: '25' }, target)).rejects.toThrow(
      'settings differ',
    );
    expect(() =>
      operationTarget({ ...env, SIMULATOR_WORLD_SMS_PREPARATION: undefined }, preparation.worldPath),
    ).toThrow('retained preparation');
  });

  it('requires separate actual revision and release preparations and refuses unsafe phase ancestors', async () => {
    const incident = prepareSmsIncident(configuration(), incidentStart, incidentPreparedAt);
    const preparation = prepareSmsFollowup(
      configuration(),
      followupStart,
      followupPreparedAt,
      incident,
      selection(incident),
    );
    mocks.text.mockResolvedValue(JSON.stringify(preparation.monitoring, null, 2) + '\n');
    const env = {
      ...environment(preparation),
      SIMULATOR_WORLD_REVISION_PLAN: `${configuration().directory}/followup/revision.plan.json`,
    };
    mocks.envelope.mockResolvedValue(preparation);
    mocks.preparation.mockResolvedValue(preparation);
    const target = operationTarget(env, preparation.worldPath);
    await expect(loadHostedSmsTarget(env, target)).rejects.toThrow('actual reservation');
    await expect(
      loadHostedSmsTarget({ ...env, SIMULATOR_WORLD_DEPARTURE_PLAN: 'another-plan' }, target),
    ).rejects.toThrow('separate stages');
    mocks.metadata.mockResolvedValueOnce({ isDirectory: () => true, isSymbolicLink: () => true, mode: 0o700 });
    await expect(loadHostedSmsTarget(env, target)).rejects.toThrow('private regular directories');
    expect(mocks.departure).not.toHaveBeenCalled();
  });
});
