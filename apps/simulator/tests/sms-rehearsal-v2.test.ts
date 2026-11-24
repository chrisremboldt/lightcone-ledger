import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import { validateSmsCalculationPreparation } from '../src/sms-calculation-preparation.js';
import { validateSmsDeparturePreparation } from '../src/sms-departure-preparation.js';
import { createOperationMonitoringRuntimeState } from '../src/operation-monitoring-runtime.js';
import {
  readRetainedSmsCalculation,
  readRetainedSmsDeparture,
  readRetainedSmsPreparation,
  readRetainedSmsReview,
  retainSmsCalculation,
  retainSmsDeparture,
  retainSmsPreparation,
  retainSmsReview,
  retainSmsRevision,
} from '../src/sms-rehearsal-files.js';
import {
  prepareSmsIncident,
  validateSmsRehearsalConfig,
  validateSmsRehearsalPreparation,
} from '../src/sms-rehearsal-plan.js';
import { validateSmsReviewPreparation } from '../src/sms-review-preparation.js';
import {
  config,
  configV2,
  departureFixture,
  incidentPreparedAt,
  incidentStart,
  reviewFixture,
} from './sms-rehearsal-fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('explicit SMS rehearsal version two', () => {
  it('prepares the configured finite future promise before the first version-one reservation and retains exact recovery', () => {
    const { incident, followup, world } = departureFixture();
    const originalBytes = JSON.stringify(followup);
    expect(JSON.stringify(validateSmsRehearsalPreparation(followup, incident))).toBe(originalBytes);
    const requestedWindow = {
      start: new Date(Date.parse(followup.start) + followup.config.followup.departureOffsetMs).toISOString(),
      end: new Date(Date.parse(followup.start) + followup.config.followup.missionEndOffsetMs).toISOString(),
    };
    expect(followup.environment).toMatchObject({
      SIMULATOR_WORLD_REQUESTED_START: requestedWindow.start,
      SIMULATOR_WORLD_REQUESTED_END: requestedWindow.end,
    });
    expect(world.config.selectedDemandWindow).toEqual({
      attemptId: followup.identities.attemptId,
      ...requestedWindow,
    });
    const firstOrder = world.facts.find(
      (fact) => fact.kind === 'order' && fact.attemptId === followup.identities.attemptId,
    );
    expect(firstOrder).toMatchObject({ kind: 'order', order: { version: 1, schedule: requestedWindow, flights: [] } });
    const firstMission = world.facts.find(
      (fact) =>
        fact.kind === 'mission' && fact.attemptId === followup.identities.attemptId && fact.source.sourceRevision === 1,
    );
    expect(firstMission).toMatchObject({ kind: 'mission', source: { operatingInterval: requestedWindow } });
    expect(incident.clearEnvironment).toEqual(
      expect.arrayContaining(['SIMULATOR_WORLD_REQUESTED_START', 'SIMULATOR_WORLD_REQUESTED_END']),
    );
  });

  it('pins configured fleet resources and the first Alpha reservation through existing evidence and human review plans', () => {
    const configuration = configV2();
    expect(validateSmsRehearsalConfig(configuration)).toEqual(configuration);
    expect(() => validateSmsRehearsalConfig({ ...configuration, fleet: { alpha: 24, beta: 25 } })).toThrow();
    const missing = structuredClone(configuration);
    Reflect.deleteProperty(missing, 'capacityPreset');
    expect(() => validateSmsRehearsalConfig(missing)).toThrow();
    const fixture = reviewFixture(configuration);
    const { incident, followup, world, monitoring, revision, departure, calculation, review } = fixture;
    expect(incident.version).toBe(2);
    expect(followup.version).toBe(2);
    if (incident.version !== 2 || followup.version !== 2) throw new Error('The version-two fixture changed version');
    expect(validateSmsRehearsalPreparation(incident)).toEqual(incident);
    expect(validateSmsRehearsalPreparation(followup, incident)).toEqual(followup);
    expect(followup.selection.hazard.origin?.kind).toBe('finding');
    expect(incident.profile.predeparture).toBeNull();
    expect(followup.profile.predeparture).toEqual({
      version: 'reserve-selected-await-release.1',
      tenant: 'alpha',
      attemptId: followup.identities.attemptId,
    });
    expect(followup.identities.attemptId).toBe(`intent-${followup.runId}-alpha-0:attempt:1`);
    for (const preparation of [incident, followup]) {
      expect(preparation.profile.fleet).toEqual({ alpha: 25, beta: 25 });
      expect(preparation.profile.capacity).toMatchObject({
        id: 'alpha-25.1',
        demandIntervalMs: { alpha: 8_000, beta: 30_000 },
        flightPeople: { alpha: 25, beta: 16 },
      });
      expect(preparation.profile.timing).toEqual({
        sampleIntervalMs: 10_000,
        cruiseMetersPerSecond: 12,
        turnaroundMs: 60_000,
        chargeMs: 120_000,
      });
      expect(preparation.environment).toMatchObject({
        SIMULATOR_WORLD_FLEET_ALPHA: '25',
        SIMULATOR_WORLD_FLEET_BETA: '25',
        SIMULATOR_WORLD_CAPACITY: 'alpha-25.1',
      });
    }
    expect(incident.clearEnvironment).toContain('SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT');
    expect(followup.environment.SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT).toBe(followup.identities.attemptId);
    for (const tenant of ['alpha', 'beta'] as const) {
      expect(followup.profile.resourceIds.aircraft[tenant]).toEqual(
        world.aircraft.filter((aircraft) => aircraft.tenant === tenant).map((aircraft) => aircraft.id),
      );
      for (const kind of ['flightPeople', 'turnaroundCrews', 'chargers', 'launchPads'] as const)
        expect(followup.profile.resourceIds[kind][tenant]).toEqual(
          world.resources![kind].filter((slot) => slot.tenant === tenant).map((slot) => slot.id),
        );
    }
    const changedProfile = structuredClone(followup);
    changedProfile.profile.resourceIds.flightPeople.alpha.pop();
    expect(() => validateSmsRehearsalPreparation(changedProfile, incident)).toThrow();
    expect(world.config.predeparture).toEqual(followup.profile.predeparture);
    expect(world.config.selectedDemandWindow).toEqual({
      attemptId: followup.identities.attemptId,
      ...followup.missionChange.operatingInterval,
    });
    expect(world.reservations!.map((reservation) => reservation.id)).toEqual([followup.identities.attemptId]);
    expect(monitoring.observer.startedAt).toBe(followup.start);
    expect(monitoring.observer.flights[0]!.initialLinkObservation).toBeUndefined();
    expect(monitoring.observer.flights[0]!.observedIntervals).toEqual([]);
    expect(monitoring.observer.flights[0]!.coverageIntervals).toEqual([]);
    expect(monitoring.baseline).toBeUndefined();
    expect(() => createOperationMonitoringRuntimeState(followup.monitoring, world)).toThrow(/prospectively|fresh/i);
    expect(revision.reservationId).toBe(followup.identities.attemptId);
    expect(validateSmsDeparturePreparation(departure, followup, revision)).toEqual(departure);
    expect(departure.plan.reservationId).toBe(followup.identities.attemptId);
    expect(validateSmsCalculationPreparation(calculation, followup)).toEqual(calculation);
    expect(calculation.plan.window.period).toEqual(fixture.monitoringActual.canonical.record.source.window);
    expect(calculation.plan.window.complete).toBe(false);
    expect(fixture.monitoringActual.canonical.record.source.populationComplete).toBe(false);
    expect(validateSmsReviewPreparation(review, followup, calculation)).toEqual(review);
    expect(review.plan.result).toEqual({
      id: fixture.calculationAccepted.record.id,
      digest: canonicalDigest(fixture.calculationAccepted.record),
    });
    expect(review.plan.conclusion).toBe(JSON.parse(fixture.reviewSelectionText).conclusion);
    expect(fixture.calculationAccepted.record.result.rate).toBeNull();
  });

  it('restores exact version-two outputs and refuses a different configuration or replacing a retained version-one root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-v2-'));
    directories.push(directory);
    const fixture = reviewFixture({ ...configV2(), directory: join(directory, 'current') });
    const { configuration, incident, followup, revision, departure, calculation, review } = fixture;
    const retain = async () => {
      await retainSmsPreparation(incident);
      await retainSmsPreparation(followup);
      await retainSmsRevision(followup, revision);
      await retainSmsDeparture(followup, departure);
      await retainSmsCalculation(followup, calculation);
      await retainSmsReview(followup, review);
    };
    await retain();
    const phase = join(configuration.directory, 'followup');
    const commitments = [
      join(configuration.directory, 'rehearsal.json'),
      ...[
        'preparation.json',
        'revision.preparation.json',
        'departure.preparation.json',
        'calculation.preparation.json',
        'review.preparation.json',
      ].map((name) => join(phase, name)),
    ];
    const originals = await Promise.all(commitments.map((path) => readFile(path)));
    const outputs = [
      'world.env',
      'departure.plan.json',
      'departure.env',
      'calculation.plan.json',
      'calculation.env',
      'review.plan.json',
      'review.env',
    ].map((name) => join(phase, name));
    const derived = await Promise.all(outputs.map((path) => readFile(path)));
    await Promise.all(outputs.map((path) => unlink(path)));
    await retain();
    expect(await Promise.all(commitments.map((path) => readFile(path)))).toEqual(originals);
    expect(await Promise.all(outputs.map((path) => readFile(path)))).toEqual(derived);
    expect(await readRetainedSmsPreparation(configuration, 'followup')).toEqual(followup);
    expect(await readRetainedSmsDeparture(followup)).toEqual(departure);
    expect(await readRetainedSmsCalculation(followup)).toEqual(calculation);
    expect(await readRetainedSmsReview(followup)).toEqual(review);
    await expect(
      retainSmsPreparation(
        prepareSmsIncident(
          { ...configuration, sourcePrincipalId: 'another-source' },
          incidentStart,
          incidentPreparedAt,
        ),
      ),
    ).rejects.toThrow(/configuration/i);
    expect(await Promise.all(commitments.map((path) => readFile(path)))).toEqual(originals);
    for (const path of [
      followup.worldPath,
      ...['departure', 'calculation', 'review'].map((name) => join(phase, `${name}.journal.json`)),
    ])
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });

    const legacyDirectory = join(directory, 'legacy');
    const legacy = prepareSmsIncident({ ...config(), directory: legacyDirectory }, incidentStart, incidentPreparedAt);
    await retainSmsPreparation(legacy);
    const legacyMarker = join(legacyDirectory, 'rehearsal.json');
    const legacyCommitment = join(legacyDirectory, 'incident', 'preparation.json');
    const legacyBytes = await Promise.all([readFile(legacyMarker), readFile(legacyCommitment)]);
    await expect(
      retainSmsPreparation(
        prepareSmsIncident({ ...configV2(), directory: legacyDirectory }, incidentStart, incidentPreparedAt),
      ),
    ).rejects.toThrow(/configuration/i);
    expect(await Promise.all([readFile(legacyMarker), readFile(legacyCommitment)])).toEqual(legacyBytes);
    expect(await readRetainedSmsPreparation(legacy.config, 'incident')).toEqual(legacy);
  });
});
