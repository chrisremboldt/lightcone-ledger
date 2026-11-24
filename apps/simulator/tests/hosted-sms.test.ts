import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareHostedSms } from '../src/hosted-sms.js';
import * as privateJournal from '../src/private-journal.js';
import * as retention from '../src/sms-rehearsal-files.js';
import * as operationState from '../src/operation-state.js';
import type { SmsDeparturePreparation } from '../src/sms-departure-preparation.js';
import { config, configV3, departureFixture, incidentStart } from './sms-rehearsal-fixtures.js';

const configPath = '/private/sms-hosted-config.json';
const staging = {
  LEDGER_ENV: 'staging',
  LEDGER_SIMULATION_TARGET: 'isolated',
  FLY_APP_NAME: 'ledger-staging',
  LEDGER_API_URL: 'http://127.0.0.1:4000',
  EMULATOR_BASE_URL: 'http://127.0.0.1:4002',
  SIMULATOR_SMS_CONFIG: configPath,
};

afterEach(() => vi.restoreAllMocks());

describe('hosted SMS preparation entrypoint', () => {
  it('requires the explicit version-three actual target and returns preparation without starting or printing a world', async () => {
    const configuration = configV3();
    const read = vi.spyOn(privateJournal, 'readPrivateText').mockResolvedValue(JSON.stringify(configuration));
    const retained = vi.spyOn(retention, 'readRetainedSmsPreparation').mockResolvedValue(undefined);
    const retain = vi.spyOn(retention, 'retainSmsPreparation').mockImplementation(async (value) => value);
    const world = vi.spyOn(operationState, 'readOperationCheckpoint').mockRejectedValue(new Error('No world read'));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No source calls'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(incidentStart) + 1000);
    const env = { ...staging, SIMULATOR_SMS_PHASE: 'incident', SIMULATOR_SMS_START: incidentStart };
    for (const change of [
      { LEDGER_ENV: 'local' },
      { LEDGER_SIMULATION_TARGET: 'production' },
      { FLY_APP_NAME: 'ledger-production' },
      { LEDGER_API_URL: 'http://127.0.0.1:14300' },
      { EMULATOR_BASE_URL: 'http://127.0.0.1:14302' },
    ])
      expect(await prepareHostedSms({ ...env, ...change })).toMatchObject({ status: 'pending' });
    read.mockResolvedValue(JSON.stringify(config()));
    expect(await prepareHostedSms(env)).toMatchObject({ status: 'pending' });
    expect(retained).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    read.mockClear();
    read.mockResolvedValue(JSON.stringify(configuration));
    expect(await prepareHostedSms(env)).toMatchObject({
      status: 'prepared',
      phase: 'incident',
      worldPath: `${configuration.directory}/incident/world.json`,
      file: `${configuration.directory}/incident/world.env`,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(configPath, 128 * 1024);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]![0].environment).not.toHaveProperty('SIMULATOR_WORLD_MONITORING_TOKEN');
    expect(retain.mock.calls[0]![0].environment).not.toHaveProperty('SIMULATOR_WORLD_DEPARTURE_TOKEN');
    expect(world).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('requires the exact actual world profile once, then reuses its retained departure snapshot without reading a clock or world', async () => {
    const fixture = departureFixture(configV3());
    const { followup } = fixture;
    const selectionPath = '/private/sms-hosted-departure-selection.json';
    vi.spyOn(privateJournal, 'readPrivateText').mockImplementation(async (path) => {
      if (path === configPath) return JSON.stringify(fixture.configuration);
      if (path === selectionPath) return fixture.selectionText;
      throw new Error('Unexpected preparation input');
    });
    vi.spyOn(retention, 'readRetainedSmsPreparation').mockResolvedValue(followup);
    const retained = vi.spyOn(retention, 'readRetainedSmsDeparture').mockResolvedValue(undefined);
    vi.spyOn(retention, 'readRetainedSmsRevision').mockResolvedValue(fixture.revision);
    let snapshot: SmsDeparturePreparation | undefined;
    const retain = vi.spyOn(retention, 'retainSmsDeparture').mockImplementation(async (_followup, value) => {
      snapshot = value;
      return value;
    });
    const checkpoint = operationState.initialOperationCheckpoint(fixture.world, {
      mode: 'live',
      wallAt: fixture.world.now,
      paused: false,
    });
    checkpoint.reservationRevision = fixture.actual.revisionReceipt;
    checkpoint.monitoring = fixture.monitoring;
    const world = vi.spyOn(operationState, 'readOperationCheckpoint');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.preparedAt));
    const env = {
      ...staging,
      SIMULATOR_SMS_PHASE: 'departure',
      SIMULATOR_SMS_DEPARTURE_SELECTION: selectionPath,
    };
    const changedCapacity = structuredClone(checkpoint);
    changedCapacity.world.config.capacity!.demandIntervalMs.alpha = 8000;
    world.mockResolvedValue(changedCapacity);
    expect(await prepareHostedSms(env)).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('world profile'),
    });
    const changedResources = structuredClone(checkpoint);
    changedResources.world.resources!.chargers[0]!.id = 'unrelated-charger';
    world.mockResolvedValue(changedResources);
    expect(await prepareHostedSms(env)).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('resource identities'),
    });
    expect(retain).not.toHaveBeenCalled();
    world.mockClear();
    world.mockResolvedValue(checkpoint);
    const first = await prepareHostedSms(env);
    expect(first).toMatchObject({ status: 'prepared', phase: 'departure' });
    expect(world).toHaveBeenCalledExactlyOnceWith(followup.worldPath);
    expect(snapshot).toEqual(fixture.departure);
    retained.mockResolvedValue(snapshot);
    world.mockClear();
    world.mockRejectedValue(new Error('A retained retry must not read the world'));
    now.mockImplementation(() => {
      throw new Error('A retained retry must not read the clock');
    });
    expect(await prepareHostedSms(env)).toEqual(first);
    expect(world).not.toHaveBeenCalled();
    expect(snapshot).toEqual(fixture.departure);
  });
});
