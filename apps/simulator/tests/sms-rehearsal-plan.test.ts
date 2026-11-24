import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import {
  advanceOperation,
  createOperation,
  operationCapacityPreset,
  reviseOperationReservation,
} from '../../../packages/simulation-models/src/operation.js';
import type { SmsAcceptedControlSelection } from '../src/sms-rehearsal-control.js';
import { readRetainedSmsRevision, retainSmsPreparation, retainSmsRevision } from '../src/sms-rehearsal-files.js';
import {
  prepareSmsFollowup,
  prepareSmsIncident,
  prepareSmsRevision,
  validateSmsRehearsalConfig,
} from '../src/sms-rehearsal-plan.js';

import {
  config,
  prepared,
  incidentStart,
  incidentPreparedAt,
  followupStart,
  followupPreparedAt,
} from './sms-rehearsal-fixtures.js';

describe('explicit SMS rehearsal preparation', () => {
  it('requires complete credential-free local configuration and rejects unknown fields and aliased ports', () => {
    const configuration = config();
    expect(validateSmsRehearsalConfig(configuration)).toEqual(configuration);
    expect(() => validateSmsRehearsalConfig({ ...configuration, token: 'must-not-be-retained' })).toThrow();
    expect(() =>
      validateSmsRehearsalConfig({
        ...configuration,
        followup: { ...configuration.followup, password: 'must-not-be-retained' },
      }),
    ).toThrow();
    const userinfo = new URL(configuration.apiUrl);
    userinfo.username = 'fixture-user';
    expect(() => validateSmsRehearsalConfig({ ...configuration, apiUrl: userinfo.href })).toThrow();
    expect(() =>
      validateSmsRehearsalConfig({ ...configuration, ports: { ...configuration.ports, mqtt: 14300 } }),
    ).toThrow();
    const missing = structuredClone(configuration);
    Reflect.deleteProperty(missing, 'seed');
    expect(() => validateSmsRehearsalConfig(missing)).toThrow();
  });

  it('derives repeatable fresh identities from explicit UTC clocks and retains independent immutable configuration', () => {
    const configuration = config();
    const before = structuredClone(configuration);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Preparation must use its supplied clocks');
    });
    try {
      const first = prepareSmsIncident(configuration, incidentStart, incidentPreparedAt);
      expect(prepareSmsIncident(configuration, incidentStart, incidentPreparedAt)).toEqual(first);
      expect(first).toMatchObject({
        phase: 'incident',
        start: incidentStart,
        preparedAt: incidentPreparedAt,
        configDigest: canonicalDigest(configuration),
      });
      expect(first.identities).toMatchObject({
        intentId: `intent-${first.runId}-alpha-0`,
        attemptId: `intent-${first.runId}-alpha-0:attempt:1`,
        aircraftId: `DJI-${first.runId}-alpha-01`,
        sourceMissionId: `${first.identities.attemptId}:mission`,
        commandLinkSourceSessionId: `${first.identities.sourceSessionId}-command-link-1`,
      });
      expect(first.environment).toMatchObject({
        LEDGER_API_URL: configuration.apiUrl,
        EMULATOR_BASE_URL: configuration.emulatorUrl,
        SIMULATOR_WORLD_START: incidentStart,
        SIMULATOR_WORLD_RUN_ID: first.runId,
        SIMULATOR_WORLD_COMMAND_LINK_EPISODE: 'canal-market-relay.1',
      });
      expect(configuration).toEqual(before);
      first.config.followup.route.geometry.coordinates[0]![0] = 0;
      expect(configuration).toEqual(before);
      expect(() => prepareSmsIncident(configuration, '2026-10-15T14:00:00-05:00', incidentPreparedAt)).toThrow();
      expect(() => prepareSmsIncident(configuration, incidentStart, '2026-10-15T13:59:59.000Z')).toThrow();
      expect(() => prepareSmsIncident(configuration, incidentStart, '2026-10-15T14:00:30.001Z')).toThrow();
    } finally {
      clock.mockRestore();
    }
  });

  it('pins the actual accepted public control and rejects changed, foreign, stale or chronologically impossible selection', () => {
    const { configuration, incident, selected, followup } = prepared();
    const version = selected.control.versions[0]!;
    const acceptance = selected.hazard.decisions.find((decision) => decision.kind === 'risk.accept')!;
    expect(followup.monitoring.monitoring.control).toEqual({
      hazardId: selected.hazard.record.id,
      controlId: selected.control.record.id,
      controlVersion: version.versionNumber,
      controlEventId: version.id,
      controlDigest: version.bodyDigest,
      acceptance: {
        id: acceptance.id,
        acceptedRevision: acceptance.acceptedRevision,
        digest: acceptance.signature!.contentDigest,
      },
    });
    expect(followup.start).toBe(followupStart);
    expect(followup.identities).not.toEqual(incident.identities);
    expect(followup.worldPath).not.toBe(incident.worldPath);
    expect(followup.environment).toMatchObject({
      SIMULATOR_WORLD_REQUESTED_START: followup.missionChange.operatingInterval.start,
      SIMULATOR_WORLD_REQUESTED_END: followup.missionChange.operatingInterval.end,
    });
    expect(incident.clearEnvironment).toEqual(
      expect.arrayContaining([
        'SIMULATOR_WORLD_REQUESTED_START',
        'SIMULATOR_WORLD_REQUESTED_END',
        'SIMULATOR_WORLD_ORDINARY_WORK',
      ]),
    );
    expect(followup.monitoring.monitoring.window).toEqual({
      start: '2026-10-15T14:22:00.000Z',
      end: '2026-10-15T14:30:00.000Z',
    });
    expect(prepareSmsFollowup(configuration, followupStart, followupPreparedAt, incident, selected)).toEqual(followup);
    const changedConfig = structuredClone(configuration);
    changedConfig.followup.radioInitialState = 'down';
    expect(() => prepareSmsFollowup(changedConfig, followupStart, followupPreparedAt, incident, selected)).toThrow(
      /configuration/i,
    );
    const changes: Array<(value: SmsAcceptedControlSelection) => void> = [
      (value) => {
        value.hazard.controls![0]!.bodyDigest = '0'.repeat(64);
      },
      (value) => {
        value.hazard.controls![0]!.accepted = false;
      },
      (value) => {
        value.hazard.record.status = 'closed';
      },
      (value) => {
        value.control.record.status = 'closed';
      },
      (value) => {
        value.origin.flight.originationKey = 'another-incident';
      },
      (value) => {
        value.hazard.decisions = value.hazard.decisions.filter((decision) => decision.kind !== 'risk.accept');
      },
      (value) => {
        value.hazard.decisions.find((decision) => decision.kind === 'risk.accept')!.recordedAt =
          '2026-10-15T14:20:00.001Z';
      },
    ];
    for (const change of changes) {
      const altered = structuredClone(selected);
      change(altered);
      expect(() => prepareSmsFollowup(configuration, followupStart, followupPreparedAt, incident, altered)).toThrow();
    }
    expect(selected).toEqual(followup.selection);
  });

  it('binds and retains revision two against the actual held source plan without changing ownership or creating a departure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-revision-'));
    try {
      const { configuration, incident, followup } = prepared({ ...config(), directory });
      const world = createOperation({
        ...operationCapacityPreset('illustrative-25.1'),
        runId: followup.runId,
        start: followup.start,
        seed: configuration.seed,
        fleet: configuration.fleet,
        missionPlan: 'dispatch-plan.1',
        selectedDemandWindow: {
          attemptId: followup.identities.attemptId,
          ...followup.missionChange.operatingInterval,
        },
        predeparture: { version: 'reserve-await-release.1', tenant: 'alpha' },
      });
      advanceOperation(world, Date.parse(followupPreparedAt));
      const actual = world.reservations!.find((row) => row.id === followup.identities.attemptId)!;
      const before = structuredClone(actual);
      expect(actual.order.schedule).toEqual(followup.missionChange.operatingInterval);
      expect(actual.plan.operatingInterval).toEqual(followup.missionChange.operatingInterval);
      const revision = prepareSmsRevision(followup, actual);
      expect(revision).toEqual({
        version: 1,
        runId: world.config.runId,
        tenant: 'alpha',
        reservationId: actual.id,
        aircraftId: actual.aircraftId,
        expectedPlan: { sourceRevision: 1, digest: canonicalDigest(actual.plan) },
        change: {
          sourceRevision: 2,
          route: configuration.followup.route,
          operatingInterval: { start: '2026-10-15T14:21:00.000Z', end: '2026-10-15T14:35:00.000Z' },
        },
      });
      expect(actual).toEqual(before);
      const resources = structuredClone(world.resources);
      const source = reviseOperationReservation(world, revision.reservationId, revision.change);
      expect(source).toMatchObject({
        sourceRevision: 2,
        sourceMissionId: followup.identities.sourceMissionId,
        aircraftId: followup.identities.aircraftId,
        route: configuration.followup.route,
        operatingInterval: revision.change.operatingInterval,
      });
      expect(world.resources).toEqual(resources);
      expect(world.attempts.some((attempt) => attempt.id === actual.id)).toBe(false);
      expect(world.reservations![0]!.phase).toBe('awaiting-release');
      expect(() => prepareSmsRevision(followup, actual)).toThrow();
      expect(() => prepareSmsRevision(followup, { ...before, aircraftId: 'another-aircraft' })).toThrow();
      await retainSmsPreparation(incident);
      await retainSmsPreparation(followup);
      await retainSmsRevision(followup, revision);
      expect(await readRetainedSmsRevision(followup)).toEqual(revision);
      const path = join(directory, 'followup', 'revision.plan.json');
      const commitmentPath = join(directory, 'followup', 'revision.preparation.json');
      const originalBytes = await readFile(path);
      const commitment = await readFile(commitmentPath);
      await unlink(path);
      expect(await readRetainedSmsRevision(followup)).toEqual(revision);
      await retainSmsRevision(followup, revision);
      expect(await readFile(path)).toEqual(originalBytes);
      const changed = structuredClone(revision);
      changed.expectedPlan.digest = '0'.repeat(64);
      await writeFile(path, JSON.stringify(changed, null, 2) + '\n');
      const changedBytes = await readFile(path);
      await expect(readRetainedSmsRevision(followup)).rejects.toThrow(/changed/i);
      await expect(retainSmsRevision(followup, revision)).rejects.toThrow(/changed/i);
      expect(await readFile(path)).toEqual(changedBytes);
      expect(await readFile(commitmentPath)).toEqual(commitment);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
