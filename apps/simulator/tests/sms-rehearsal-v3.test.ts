import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import { assertHostedSmsWorld } from '../src/hosted-sms-target.js';
import { validateSmsCalculationPreparation } from '../src/sms-calculation-preparation.js';
import { validateSmsDeparturePreparation } from '../src/sms-departure-preparation.js';
import { validateSmsRehearsalConfig, validateSmsRehearsalPreparation } from '../src/sms-rehearsal-plan.js';
import { validateSmsReviewPreparation } from '../src/sms-review-preparation.js';
import { configV3, reviewFixture } from './sms-rehearsal-fixtures.js';

describe('isolated staging SMS preparation', () => {
  it('pins the modest fleet, actual resource identities and selected attempt through the existing human story plans', () => {
    const configuration = configV3();
    expect(validateSmsRehearsalConfig(configuration)).toEqual(configuration);
    const fixture = reviewFixture(configuration);
    const { incident, followup, world, revision, departure, calculation, review } = fixture;
    if (incident.version !== 3 || followup.version !== 3) throw new Error('The hosted fixture changed version');
    expect(validateSmsRehearsalPreparation(incident)).toEqual(incident);
    expect(validateSmsRehearsalPreparation(followup, incident)).toEqual(followup);
    expect(incident.profile.predeparture).toBeNull();
    expect(followup.profile.predeparture).toEqual({
      version: 'reserve-selected-await-release.1',
      tenant: 'alpha',
      attemptId: `intent-${followup.runId}-alpha-0:attempt:1`,
    });
    for (const preparation of [incident, followup]) {
      expect(preparation.profile.fleet).toEqual({ alpha: 3, beta: 2 });
      expect(preparation.profile.capacity).toMatchObject({
        id: 'illustrative-25.1',
        demandIntervalMs: { alpha: 24000, beta: 30000 },
        flightPeople: { alpha: 16, beta: 16 },
        turnaroundCrews: { alpha: 4, beta: 3 },
        chargers: { alpha: 8, beta: 6 },
        launchPads: { alpha: 2, beta: 1 },
      });
      expect(preparation.environment).toMatchObject({
        LEDGER_ENV: 'staging',
        LEDGER_SIMULATION_TARGET: 'isolated',
        FLY_APP_NAME: 'ledger-staging',
        LEDGER_API_URL: 'http://127.0.0.1:4000',
        EMULATOR_BASE_URL: 'http://127.0.0.1:4002',
        SIMULATOR_WORLD_FLEET_ALPHA: '3',
        SIMULATOR_WORLD_FLEET_BETA: '2',
        SIMULATOR_WORLD_CAPACITY: 'illustrative-25.1',
        SIMULATOR_WORLD_BROKER_PROFILE: 'hosted.2',
        SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:1884',
        SIMULATOR_WORLD_MQTT_PORT: '1884',
        SIMULATOR_WORLD_CALLBACK_PORT: '4003',
        SIMULATOR_WORLD_SMS_PREPARATION: `${configuration.directory}/${preparation.phase}/preparation.json`,
      });
      expect(preparation.worldPath).toBe(`${configuration.directory}/${preparation.phase}/world.json`);
    }
    expect(incident.clearEnvironment).toContain('SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT');
    expect(incident.clearEnvironment).toEqual(
      expect.arrayContaining(['SIMULATOR_WORLD_REQUESTED_START', 'SIMULATOR_WORLD_REQUESTED_END']),
    );
    expect(followup.environment.SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT).toBe(followup.identities.attemptId);
    expect(followup.environment).toMatchObject({
      SIMULATOR_WORLD_REQUESTED_START: followup.missionChange.operatingInterval.start,
      SIMULATOR_WORLD_REQUESTED_END: followup.missionChange.operatingInterval.end,
    });
    expect(world.config.selectedDemandWindow).toEqual({
      attemptId: followup.identities.attemptId,
      ...followup.missionChange.operatingInterval,
    });
    expect(() => assertHostedSmsWorld(followup, world)).not.toThrow();
    const changedWindow = structuredClone(world);
    changedWindow.config.selectedDemandWindow!.end = new Date(
      Date.parse(followup.missionChange.operatingInterval.end) + 60_000,
    ).toISOString();
    expect(() => assertHostedSmsWorld(followup, changedWindow)).toThrow('exact prepared profile');
    for (const tenant of ['alpha', 'beta'] as const) {
      expect(followup.profile.resourceIds.aircraft[tenant]).toEqual(
        world.aircraft.filter((row) => row.tenant === tenant).map((row) => row.id),
      );
      for (const kind of ['flightPeople', 'turnaroundCrews', 'chargers', 'launchPads'] as const)
        expect(followup.profile.resourceIds[kind][tenant]).toEqual(
          world.resources![kind].filter((row) => row.tenant === tenant).map((row) => row.id),
        );
    }
    expect(world.reservations!.map((row) => row.id)).toEqual([followup.identities.attemptId]);
    expect(revision.version).toBe(1);
    expect(validateSmsDeparturePreparation(departure, followup, revision)).toEqual(departure);
    expect(departure.plan.reservationId).toBe(followup.identities.attemptId);
    expect(validateSmsCalculationPreparation(calculation, followup)).toEqual(calculation);
    expect(validateSmsReviewPreparation(review, followup, calculation)).toEqual(review);
    expect(review.plan.result.digest).toBe(canonicalDigest(fixture.calculationAccepted.record));
    const altered = structuredClone(followup);
    altered.profile.capacity.demandIntervalMs.alpha = 8000;
    expect(() => validateSmsRehearsalPreparation(altered, incident)).toThrow(/exact inputs/i);
  });

  it('refuses profile, target and path substitutions before preparing a hosted world', () => {
    const configuration = configV3();
    for (const change of [
      { target: 'local' },
      { directory: '/tmp/sms-unit' },
      { directory: '/data/ledger/world/sms/other' },
      { directory: '/data/ledger/world/sms/alias/../sms-unit' },
      { fleet: { alpha: 25, beta: 25 } },
      { capacityPreset: 'alpha-25.1' },
      { predepartureProfile: 'reserve-await-release.1' },
      { apiUrl: 'http://127.0.0.1:14300' },
      { emulatorUrl: 'http://127.0.0.1:14302' },
      { ports: { mqtt: 1883, callback: 4003 } },
      { ports: { mqtt: 1884, callback: 14303 } },
      { followup: { ...configuration.followup, windowEndOffsetMs: 600000 } },
      { unsupported: true },
    ])
      expect(() => validateSmsRehearsalConfig({ ...configuration, ...change })).toThrow();
  });
});
