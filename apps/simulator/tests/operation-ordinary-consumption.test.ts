import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import { missionDeparturePermit } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  activateOperationOrdinaryDispatch,
  advanceOperation,
  allocateOperationDeparture,
  consumeOperationDeparture,
  createOperation,
  enableOperationOrdinaryWork,
  operationReservationFit,
  type OperationDepartureConsumeInput,
} from '../../../packages/simulation-models/src/operation.js';

const start = Date.parse('2026-10-18T23:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const digest = 'a'.repeat(64);
function held() {
  const world = createOperation({
    runId: 'ordinary-consume',
    start: iso(start),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
  });
  enableOperationOrdinaryWork(world);
  activateOperationOrdinaryDispatch(world);
  advanceOperation(world, start + 900_000);
  const reservation = world.reservations!.find((row) => row.tenant === 'alpha')!;
  const allocation = allocateOperationDeparture(world, {
    id: 'ordinary-allocation',
    flightId: 'ordinary-flight',
    reservationId: reservation.id,
    departureAttemptId: 'ordinary-departure',
    mission: {
      missionId: 'mission',
      sourceRevision: 1,
      eventId: 'mission-revision',
      contentDigest: digest,
      recordDigest: digest,
    },
    release: { id: 'service-release', digest },
    durationMs: 90_000,
  });
  const request = {
    kind: 'mission.departure-authorize' as const,
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    departureAttemptId: allocation.departureAttemptId,
    allocation: { id: allocation.id, digest: canonicalDigest(allocation) },
    expectedPrincipalRevision: 3,
  };
  const permit = {
    ...structuredClone(missionDeparturePermit),
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    mission: allocation.mission,
    departureAttemptId: allocation.departureAttemptId,
    allocation: request.allocation,
    contextDigest: digest,
    authorizedAt: iso(world.now),
    validUntil: iso(world.now + 30_000),
    actor: {
      ...structuredClone(missionDeparturePermit.actor),
      scope: { kind: 'flight' as const, id: allocation.flightId },
    },
  };
  const permitDigest = canonicalDigest(permit);
  const fit = operationReservationFit(world, reservation.id, { marginMs: 10_000 });
  expect(fit.status).toBe('fits');
  const avoidance = {
    evaluatedAt: iso(world.now),
    status: 'outside',
    contextDigest: digest,
    mission: allocation.mission,
    candidateCompleteness: { status: 'complete' },
    candidates: [],
  };
  const releaseValidity = {
    evaluatedAt: iso(world.now),
    release: allocation.release,
    status: 'current',
    processing: 'completed',
    currentContextDigest: digest,
    nextBoundary: iso(world.now + 30_000),
  };
  const input: OperationDepartureConsumeInput = {
    allocation,
    request,
    requestBytes: JSON.stringify(request),
    permit,
    permitDigest,
    caller: {
      apiUrl: 'http://ledger.example',
      tenantId: 'tenant-alpha',
      principalId: permit.actor.id,
      planDigest: digest,
      requestKey: 'ordinary-original-key',
      payloadSha256: digest,
    },
    fit: {
      version: 'mission.departure-fit.1',
      permit: { id: permit.id, digest: permitDigest },
      mission: allocation.mission,
      aircraftId: allocation.aircraftId,
      evaluatedAt: iso(world.now),
      remainingDurationMs: fit.nominalDurationMs!,
      holdAllowanceMs: fit.holdAllowanceMs!,
      marginMs: 10_000,
      requiredCompletionAt: fit.requiredCompletionAt!,
    },
    currentControls: {
      version: 'operation.departure-current-controls.1',
      readStartedAt: iso(world.now),
      readFinishedAt: iso(world.now),
      avoidance,
      avoidanceDigest: canonicalDigest(avoidance),
      releaseValidity,
      releaseValidityDigest: canonicalDigest(releaseValidity),
    },
  };
  return { world, input };
}

describe('ordinary consume-time control guard', () => {
  it('requires fresh complete current public reads and consumes the original permit once', () => {
    const { world, input } = held();
    const unchanged = structuredClone(world);
    const missing = structuredClone(input);
    delete missing.currentControls;
    expect(() => consumeOperationDeparture(world, missing)).toThrow('exact allocation');
    expect(world).toEqual(unchanged);
    const committed = consumeOperationDeparture(world, input);
    expect(committed.currentControls).toEqual(input.currentControls);
    expect(world.attempts.find((row) => row.id === committed.attemptId)?.routeTimeline?.plan).toEqual(
      input.allocation.sourcePlan,
    );
    expect(world.departures).toHaveLength(1);
    expect(() => consumeOperationDeparture(world, input)).toThrow('no retained departure');
  });

  it('refuses a newly changed outside control context and a boundary crossed after the read without altering the permit', () => {
    const { world, input } = held();
    const unchanged = structuredClone(world);
    const changed = structuredClone(input);
    changed.currentControls!.avoidance.contextDigest = 'b'.repeat(64);
    changed.currentControls!.avoidanceDigest = canonicalDigest(changed.currentControls!.avoidance);
    expect(() => consumeOperationDeparture(world, changed)).toThrow('final controls');
    const aged = structuredClone(input);
    aged.currentControls!.releaseValidity.nextBoundary = iso(world.now);
    aged.currentControls!.releaseValidityDigest = canonicalDigest(aged.currentControls!.releaseValidity);
    expect(() => consumeOperationDeparture(world, aged)).toThrow('final controls');
    expect(world).toEqual(unchanged);
    expect(input.permit).toEqual(changed.permit);
    expect(world.departures ?? []).toHaveLength(0);
  });
});
