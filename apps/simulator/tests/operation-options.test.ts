import { describe, expect, it } from 'vitest';
import { createOperation, operationCapacityPreset } from '../../../packages/simulation-models/src/operation.js';
import { commandLinkEpisodeOptions, demandWindowOptions, ordinaryWorkRequested } from '../src/operation.js';

it('requires the explicit bounded ordinary work profile when activating a retained world', () => {
  expect(ordinaryWorkRequested({})).toBe(false);
  expect(ordinaryWorkRequested({ SIMULATOR_WORLD_ORDINARY_WORK: 'upcoming-bounded-incidents.1' })).toBe(true);
  expect(() => ordinaryWorkRequested({ SIMULATOR_WORLD_ORDINARY_WORK: 'true' })).toThrow(
    'must be upcoming-bounded-incidents.1',
  );
});

describe('command-link episode selection', () => {
  it('requires an explicit fresh selection and preserves retained choices on resume', () => {
    const absent = createOperation({ runId: 'old-world', start: '2026-10-15T14:00:00.000Z' }).config;
    const selected = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId: 'episode-world',
      start: '2026-10-15T14:00:00.000Z',
      commandLinkEpisode: 'canal-market-relay.1',
    }).config;
    const env = { SIMULATOR_WORLD_COMMAND_LINK_EPISODE: 'canal-market-relay.1' };
    expect(commandLinkEpisodeOptions({})).toEqual({});
    expect(commandLinkEpisodeOptions(env)).toEqual({ commandLinkEpisode: 'canal-market-relay.1' });
    expect(commandLinkEpisodeOptions({}, absent)).toEqual({});
    expect(commandLinkEpisodeOptions({}, selected)).toEqual({});
    expect(commandLinkEpisodeOptions(env, selected)).toEqual({ commandLinkEpisode: 'canal-market-relay.1' });
    expect(() => commandLinkEpisodeOptions(env, absent)).toThrow('retained in its checkpoint');
    for (const value of ['', 'none', 'another-episode'])
      expect(() => commandLinkEpisodeOptions({ SIMULATOR_WORLD_COMMAND_LINK_EPISODE: value }, selected)).toThrow(
        'must be canal-market-relay.1',
      );
  });
});

it('pins an explicitly promised future customer window for the selected held request', () => {
  const env = {
    SIMULATOR_WORLD_RUN_ID: 'future-request',
    SIMULATOR_WORLD_REQUESTED_START: '2026-10-17T14:15:00.000Z',
    SIMULATOR_WORLD_REQUESTED_END: '2026-10-17T14:40:00.000Z',
  };
  const selectedDemandWindow = {
    attemptId: 'intent-future-request-alpha-0:attempt:1',
    start: env.SIMULATOR_WORLD_REQUESTED_START,
    end: env.SIMULATOR_WORLD_REQUESTED_END,
  };
  expect(demandWindowOptions(env)).toEqual({ selectedDemandWindow });
  expect(() => demandWindowOptions({ ...env, SIMULATOR_WORLD_REQUESTED_END: undefined })).toThrow('both requested');
  const world = createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId: env.SIMULATOR_WORLD_RUN_ID,
    start: '2026-10-17T14:00:00.000Z',
    predeparture: {
      version: 'reserve-selected-await-release.1',
      tenant: 'alpha',
      attemptId: selectedDemandWindow.attemptId,
    },
    selectedDemandWindow,
  });
  expect(demandWindowOptions(env, world.config)).toEqual({ selectedDemandWindow });
  expect(() =>
    demandWindowOptions({ ...env, SIMULATOR_WORLD_REQUESTED_END: '2026-10-17T14:50:00.000Z' }, world.config),
  ).toThrow('original promise');
});
