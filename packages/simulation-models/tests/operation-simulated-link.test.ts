import { describe, expect, it } from 'vitest';
import { missionDeparturePermit } from '../../contracts/fixtures/demo/v1/mission-release.js';
import { canonicalDigest, sha256 } from '../../integrity/src/index.js';
import {
  advanceOperation,
  allocateOperationDeparture,
  compactOperation,
  consumeOperationDeparture,
  createOperation,
  operationCapacityPreset,
  operationCommandLinkReading,
  operationReservationFit,
  reviseOperationReservation,
  type OperationDeparturePermit,
  type OperationSimulatedLinkState,
  type OperationWorld,
} from '../src/operation.js';

const start = Date.parse('2026-10-16T14:00:00.000Z');
const iso = (offset: number) => new Date(start + offset).toISOString();
const selectedAttempt = (runId: string) => `intent-${runId}-alpha-0:attempt:1`;

function fresh(runId: string, initialState?: OperationSimulatedLinkState, held = false) {
  return createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId,
    start: iso(0),
    fleet: { alpha: 1, beta: 1 },
    commandLinkEpisode: 'canal-market-relay.1',
    ...(held
      ? {
          predeparture: { version: 'reserve-await-release.1' as const, tenant: 'alpha' as const },
          selectedDemandWindow: { attemptId: selectedAttempt(runId), start: iso(60_000), end: iso(3_600_000) },
        }
      : {}),
    ...(initialState !== undefined
      ? { simulatedLink: { version: 'simulated-link.1' as const, attemptId: selectedAttempt(runId), initialState } }
      : {}),
  });
}

function departHeld(world: OperationWorld): void {
  const reservation = world.reservations!.find((row) => row.id === selectedAttempt(world.config.runId))!;
  reviseOperationReservation(world, reservation.id, {
    sourceRevision: 2,
    operatingInterval: { start: iso(60_000), end: reservation.order.schedule.end },
  });
  const digest = 'a'.repeat(64);
  const allocation = allocateOperationDeparture(world, {
    id: 'selected-allocation',
    flightId: 'selected-flight',
    reservationId: reservation.id,
    departureAttemptId: 'selected-departure',
    mission: {
      missionId: 'selected-mission',
      sourceRevision: reservation.plan.sourceRevision,
      eventId: 'selected-mission-event',
      contentDigest: digest,
      recordDigest: digest,
    },
    release: { id: 'selected-release', digest },
    durationMs: 90_000,
  });
  const request = {
    kind: 'mission.departure-authorize' as const,
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    departureAttemptId: allocation.departureAttemptId,
    allocation: { id: allocation.id, digest: canonicalDigest(allocation) },
    expectedPrincipalRevision: missionDeparturePermit.actor.principalRevision,
  };
  const permit: OperationDeparturePermit = {
    ...structuredClone(missionDeparturePermit),
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    mission: allocation.mission,
    departureAttemptId: allocation.departureAttemptId,
    allocation: request.allocation,
    authorizedAt: new Date(world.now).toISOString(),
    validUntil: new Date(world.now + 30_000).toISOString(),
    actor: { ...structuredClone(missionDeparturePermit.actor), scope: { kind: 'flight', id: allocation.flightId } },
  };
  const fit = operationReservationFit(world, reservation.id, { marginMs: 10_000 });
  if (fit.status !== 'fits') throw new Error(fit.reason);
  const requestBytes = JSON.stringify(request);
  const permitDigest = canonicalDigest(permit);
  consumeOperationDeparture(world, {
    allocation,
    caller: {
      apiUrl: 'http://ledger.invalid',
      tenantId: 'tenant-alpha',
      principalId: permit.actor.id,
      planDigest: digest,
      requestKey: 'selected-departure-key',
      payloadSha256: sha256(requestBytes),
    },
    request,
    requestBytes,
    permit,
    permitDigest,
    fit: {
      version: 'mission.departure-fit.1',
      permit: { id: permit.id, digest: permitDigest },
      mission: allocation.mission,
      aircraftId: allocation.aircraftId,
      evaluatedAt: new Date(world.now).toISOString(),
      remainingDurationMs: fit.nominalDurationMs!,
      holdAllowanceMs: fit.holdAllowanceMs!,
      marginMs: 10_000,
      requiredCompletionAt: fit.requiredCompletionAt!,
    },
  });
}

describe('explicit simulated command-link radio', () => {
  it('reads the current retained radio state and follows actual loss/restoration through restart and compaction', () => {
    let world = fresh('simulated-radio', 'up');
    const attemptId = selectedAttempt(world.config.runId);
    expect(operationCommandLinkReading(world, attemptId)).toBeUndefined();
    advanceOperation(world, start + 1000);
    const reading = operationCommandLinkReading(world, attemptId)!;
    expect(reading).toEqual({
      version: 'operation.command-link-reading.1',
      attemptId,
      aircraftId: 'DJI-simulated-radio-alpha-01',
      sourceId: 'command-link',
      sourceSessionId: 'intent-simulated-radio-alpha-0-capture-1-command-link-1',
      state: 'up',
      occurredAt: iso(1000),
    });
    reading.state = 'down';
    expect(world.attempts.find((row) => row.id === attemptId)!.simulatedLink).toEqual({
      version: 'simulated-link.1',
      state: 'up',
      changedAt: iso(0),
    });
    expect(operationCommandLinkReading(world, 'intent-simulated-radio-beta-0:attempt:1')).toBeUndefined();
    advanceOperation(world, start + 95_000);
    expect(operationCommandLinkReading(world, attemptId)).toMatchObject({ state: 'down', occurredAt: iso(95_000) });
    expect(world.attempts.find((row) => row.id === attemptId)!.simulatedLink!.changedAt).toBe(iso(90_000));
    compactOperation(world);
    world = JSON.parse(JSON.stringify(world)) as OperationWorld;
    expect(world.facts).toEqual([]);
    expect(operationCommandLinkReading(world, attemptId)).toMatchObject({ state: 'down', occurredAt: iso(95_000) });
    advanceOperation(world, start + 120_000);
    expect(operationCommandLinkReading(world, attemptId)).toMatchObject({ state: 'up', occurredAt: iso(120_000) });
    const selected = world.attempts.find((row) => row.id === attemptId)!;
    expect(selected.simulatedLink!.changedAt).toBe(iso(120_000));
    advanceOperation(world, Date.parse(selected.landing));
    expect(operationCommandLinkReading(world, attemptId)).toBeUndefined();
  });

  it('preserves explicit down/unknown initialization and provides no reading or repair without retained opt-in state', () => {
    for (const initialState of ['down', 'unknown'] as const) {
      const world = fresh(`radio-${initialState}`, initialState);
      advanceOperation(world, start + 1000);
      const attemptId = selectedAttempt(world.config.runId);
      expect(operationCommandLinkReading(world, attemptId)).toMatchObject({
        state: initialState,
        occurredAt: iso(1000),
      });
      expect(world.facts.some((fact) => fact.kind === 'command-link')).toBe(false);
      delete world.attempts.find((row) => row.id === attemptId)!.simulatedLink;
      advanceOperation(world, start + 120_000);
      expect(operationCommandLinkReading(world, attemptId)).toBeUndefined();
    }
    const disabled = fresh('radio-disabled');
    advanceOperation(disabled, start + 120_000);
    expect(disabled.facts.some((fact) => fact.kind === 'command-link')).toBe(true);
    expect(operationCommandLinkReading(disabled, selectedAttempt(disabled.config.runId))).toBeUndefined();
    expect(() =>
      createOperation({
        runId: 'wrong-radio-run',
        start: iso(0),
        simulatedLink: { version: 'simulated-link.1', attemptId: selectedAttempt('another-run'), initialState: 'up' },
      }),
    ).toThrow(/exact attempt/i);
  });

  it('initializes the selected held radio only when its exact departure is physically consumed', () => {
    const world = fresh('radio-held', 'unknown', true);
    const attemptId = selectedAttempt(world.config.runId);
    advanceOperation(world, start + 60_000);
    expect(world.reservations!.find((row) => row.id === attemptId)).toBeDefined();
    expect(operationCommandLinkReading(world, attemptId)).toBeUndefined();
    departHeld(world);
    expect(operationCommandLinkReading(world, attemptId)).toMatchObject({ state: 'unknown', occurredAt: iso(60_000) });
    expect(world.attempts.find((row) => row.id === attemptId)!.simulatedLink).toEqual({
      version: 'simulated-link.1',
      state: 'unknown',
      changedAt: iso(60_000),
    });
  });
});
