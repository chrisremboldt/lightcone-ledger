import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  advanceLiveClock,
} from '../src/operation-state.js';
import { createOperationMonitoringRuntimeState } from '../src/operation-monitoring-runtime.js';
import { simulationAvoidanceDemoCycle } from '../../../packages/contracts/fixtures/demo/v1/simulation-avoidance-demo.js';
import { canonicalDigest } from '@ledger/integrity';
import { missionDeparturePermit } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  createOperation,
  advanceOperation,
  prepareOperationDemoFlight,
  reserveOperationDemoFlight,
  cancelOperationDemoFlight,
  allocateOperationDeparture,
  consumeOperationDeparture,
  operationReservationFit,
  reviseOperationReservation,
  adoptOperationMissionSource,
  createFutureOperationMonitoringObserver,
  observeOperationMonitoring,
  captureOperationMonitoringBaseline,
  operationCommandLinkReading,
  operationMonitoringSnapshot,
  compactOperation,
  type OperationWorld,
  type OperationDepartureAllocation,
  type OperationDepartureConsumeInput,
  type OperationDeparturePermit,
} from '../../../packages/simulation-models/src/operation.js';
import { places, yards } from '../../../packages/simulation-models/src/places.js';
const start = Date.parse('2026-10-18T17:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const digest = 'a'.repeat(64);
const control = {
  hazardId: 'h',
  controlId: 'c',
  controlVersion: 1,
  controlEventId: 'ce',
  controlDigest: digest,
  acceptance: { id: 'accept', acceptedRevision: 4, digest },
};
function world() {
  const result = createOperation({
    runId: 'ordinary-demo',
    start: iso(start),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
  });
  advanceOperation(result, start);
  return result;
}
function prepare(value: OperationWorld, id = 'avoidance-demo:one') {
  return prepareOperationDemoFlight(value, {
    cycleId: id,
    tenant: 'alpha',
    control,
    circle: { center: places['Canal Market']!, radiusMeters: 70 },
    circles: [],
    effectiveFrom: iso(start - 1000),
    effectiveUntil: iso(start + 3600_000),
  });
}
function consumption(world: OperationWorld, allocation: OperationDepartureAllocation): OperationDepartureConsumeInput {
  const request = {
    kind: 'mission.departure-authorize' as const,
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    departureAttemptId: allocation.departureAttemptId,
    allocation: { id: allocation.id, digest: canonicalDigest(allocation) },
    expectedPrincipalRevision: 3,
  };
  const permit: OperationDeparturePermit = {
    ...structuredClone(missionDeparturePermit),
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    mission: allocation.mission,
    departureAttemptId: allocation.departureAttemptId,
    allocation: request.allocation,
    authorizedAt: iso(world.now),
    validUntil: iso(world.now + 30_000),
    actor: {
      ...structuredClone(missionDeparturePermit.actor),
      scope: { kind: 'flight', id: allocation.flightId },
    },
  };
  const permitDigest = canonicalDigest(permit);
  const fit = operationReservationFit(world, allocation.reservationId, { marginMs: 10_000 });
  if (fit.status !== 'fits') throw new Error(fit.reason);
  return {
    allocation,
    caller: {
      apiUrl: 'http://ledger.example',
      tenantId: `tenant-${world.aircraft.find((aircraft) => aircraft.id === allocation.aircraftId)!.tenant}`,
      principalId: permit.actor.id,
      planDigest: digest,
      requestKey: 'departure-key-beta-1',
      payloadSha256: digest,
    },
    request,
    requestBytes: JSON.stringify(request),
    permit,
    permitDigest,
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
  };
}

describe('future avoidance demo on an ordinary retained world', () => {
  it('preserves ordinary configuration and current airborne work while reserving and cancelling a new exact job', () => {
    const value = world();
    const config = structuredClone(value.config);
    const ordinaryAttempt = structuredClone(value.attempts[0]!);
    const prepared = prepare(value);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw new Error('fixture');
    const reservation = reserveOperationDemoFlight(value, prepared.flight)!;
    expect(value.config).toEqual(config);
    expect(value.resources).toBeUndefined();
    expect(
      value.demoResources?.flightPeople.some(
        (slot) => slot.id === reservation.personId && slot.aircraftId === reservation.aircraftId,
      ),
    ).toBe(true);
    expect(value.attempts[0]).toEqual(ordinaryAttempt);
    expect(reservation.plan.routePlanning?.requiredLocations.map((entry) => entry.role)).toEqual([
      'launch',
      'service',
      'return',
    ]);
    expect(reservation.plan.routePlanning?.customerInterval).toEqual(reservation.order.schedule);
    expect(reserveOperationDemoFlight(value, prepared.flight)).toBe(reservation);
    const nextFact = value.nextFact;
    cancelOperationDemoFlight(value, reservation.id, 'No safe route fits the original requested work.');
    expect(value.aircraft.find((entry) => entry.id === reservation.aircraftId)?.phase).toBe('ready');
    expect(
      value.demoResources?.flightPeople.find((slot) => slot.id === reservation.personId)?.aircraftId,
    ).toBeUndefined();
    expect(value.facts.slice(-2).map((entry) => entry.kind)).toEqual(['order', 'cancellation']);
    cancelOperationDemoFlight(value, reservation.id, 'No safe route fits the original requested work.');
    expect(value.nextFact).toBe(nextFact + 2);
  });
  it('keeps the actual launch and chooses an unblocked service before publishing fixed required stops', () => {
    const value = world();
    const input = {
      cycleId: 'bad-launch',
      tenant: 'alpha' as const,
      control,
      circle: { center: yards['tenant-alpha']!, radiusMeters: 100 },
      circles: [],
      effectiveFrom: iso(start),
      effectiveUntil: iso(start + 3600_000),
    };
    const before = structuredClone(value);
    expect(prepareOperationDemoFlight(value, input)).toEqual({
      status: 'blocked',
      reason: 'required_launch_inside_avoidance',
    });
    expect(value).toEqual(before);
    const original = prepare(value);
    if (original.status !== 'ready') throw new Error('fixture');
    const alternate = prepareOperationDemoFlight(value, {
      ...input,
      circle: { center: places['Canal Market']!, radiusMeters: 70 },
      circles: [{ center: original.flight.destination, radiusMeters: 80 }],
    });
    expect(alternate.status).toBe('ready');
    if (alternate.status !== 'ready') throw new Error('fixture');
    expect(alternate.flight.origin).toEqual(original.flight.origin);
    expect(alternate.flight.destination).not.toEqual(original.flight.destination);
  });
  it('observes the new session prospectively, flies its revised polyline and returns the aircraft through legacy charging', () => {
    const value = world();
    const prepared = prepare(value);
    if (prepared.status !== 'ready') throw new Error('fixture');
    const reservation = reserveOperationDemoFlight(value, prepared.flight)!;
    const route = structuredClone(reservation.plan.route);
    const [origin, service] = route.geometry.coordinates;
    route.geometry.coordinates = [
      origin!,
      [origin![0] - 0.002, service![1] + 0.002],
      service!,
      [origin![0] - 0.002, service![1] + 0.002],
      origin!,
    ];
    reviseOperationReservation(value, reservation.id, { sourceRevision: 2, route });
    advanceOperation(value, start + 60_000);
    const observer = createFutureOperationMonitoringObserver(value, {
      version: 1,
      runId: value.config.runId,
      tenant: 'alpha',
      sourceId: 'operation-monitoring',
      sourceSessionId: 'demo-monitoring',
      sourceWindowId: 'demo-window',
      control,
      window: { start: iso(value.now + 10_000), end: iso(value.now + 60_000) },
      flights: [{ attemptId: reservation.id, initialLinkState: 'unknown', monitoringAvailable: true }],
    });
    const boundary = observer.nextFact;
    expect(boundary).toBe(value.nextFact);
    compactOperation(value);
    const allocation = allocateOperationDeparture(value, {
      id: 'demo-allocation',
      flightId: 'demo-flight',
      reservationId: reservation.id,
      departureAttemptId: 'demo-departure',
      mission: {
        missionId: 'demo-mission',
        sourceRevision: 2,
        eventId: 'demo-revision',
        contentDigest: digest,
        recordDigest: digest,
      },
      release: { id: 'demo-release', digest },
      durationMs: 90_000,
    });
    const committed = consumeOperationDeparture(value, consumption(value, allocation));
    const other = prepareOperationDemoFlight(value, {
      cycleId: 'avoidance-demo:beta',
      tenant: 'beta',
      control,
      circle: { center: places['Canal Market']!, radiusMeters: 70 },
      circles: [],
      effectiveFrom: iso(start),
      effectiveUntil: iso(start + 3600_000),
      window: { start: iso(value.now), end: iso(value.now + 25 * 60_000) },
    });
    if (other.status !== 'ready') throw new Error(other.reason);
    const otherReservation = reserveOperationDemoFlight(value, other.flight)!;
    const source = { ...structuredClone(otherReservation.plan), sourceRevision: 2, occurredAt: iso(value.now) };
    adoptOperationMissionSource(
      value,
      otherReservation.id,
      source,
      { receiptId: 'other-public-revision', originalBytesBase64: 'retained-other-original' },
      { marginMs: 10_000, handoffAllowanceMs: 30_000 },
    );
    expect(otherReservation.plan).toEqual(source);
    expect(value.departures).toEqual([committed]);
    observeOperationMonitoring(observer, value);
    expect(operationCommandLinkReading(value, reservation.id)?.state).toBe('up');
    captureOperationMonitoringBaseline(observer, value, reservation.id, 'up');
    expect(observer.flights[0]?.initialLinkObservation?.occurredAt).toBe(committed.departureAt);
    expect(() => createFutureOperationMonitoringObserver(value, observer.plan)).toThrow(
      'before its physical departure',
    );
    compactOperation(value);
    advanceOperation(value, value.now + 60_000);
    observeOperationMonitoring(observer, value);
    const snapshot = operationMonitoringSnapshot(observer);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.failure).toBeUndefined();
    expect(snapshot.flights[0]?.executedMission?.route).toEqual(route);
    expect(snapshot.flights[0]?.observedIntervals).toEqual([observer.plan.window]);
    const positions = value.facts.filter((fact) => fact.kind === 'position' && fact.attemptId === reservation.id);
    expect(
      positions.some(
        (fact) => fact.kind === 'position' && fact.point.longitude < reservation.origin.longitude - 0.0001,
      ),
    ).toBe(true);
    advanceOperation(
      value,
      Date.parse(value.attempts.find((attempt) => attempt.id === reservation.id)!.landing) +
        value.config.turnaroundMs +
        value.config.chargeMs +
        600_000,
    );
    expect(
      value.events.filter(
        (event) =>
          'aircraftId' in event &&
          event.aircraftId === reservation.aircraftId &&
          ['charging', 'ready'].includes(event.kind),
      ).length,
    ).toBeLessThanOrEqual(2);
    expect(value.config.capacity).toBeUndefined();
    expect(value.resources).toBeUndefined();
  });
  it('retains an explicit native-monitoring gap across process restart instead of claiming offline coverage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-demo-offline-'));
    try {
      const value = world();
      const prepared = prepare(value);
      if (prepared.status !== 'ready') throw new Error('fixture');
      const reservation = reserveOperationDemoFlight(value, prepared.flight)!;
      advanceOperation(value, start + 60_000);
      const monitoring = createOperationMonitoringRuntimeState(
        {
          version: 1,
          apiUrl: 'http://ledger.example',
          principalId: 'principal-alpha-source',
          radioInitialState: 'up',
          monitoring: {
            version: 1,
            runId: value.config.runId,
            tenant: 'alpha',
            sourceId: 'operation-monitoring',
            sourceSessionId: 'restart-monitoring',
            sourceWindowId: 'restart-window',
            control,
            window: { start: iso(start + 70_000), end: iso(start + 200_000) },
            flights: [{ attemptId: reservation.id, initialLinkState: 'unknown', monitoringAvailable: true }],
          },
        },
        value,
        true,
      );
      const state = initialOperationCheckpoint(value, { mode: 'live', wallAt: value.now, paused: false });
      const cycle = { ...structuredClone(simulationAvoidanceDemoCycle), id: prepared.flight.cycleId };
      state.demoCycles = {
        [cycle.id]: {
          version: 'operation.demo-cycle.1',
          cycle,
          cycleDigest: canonicalDigest(cycle),
          publicRevision: 0,
          references: {},
          flight: prepared.flight,
          monitoring,
        },
      };
      const path = join(directory, 'world.json');
      const store = new OperationStore(path, state, { resumeAt: value.now });
      await store.update((next) => {
        const allocation = allocateOperationDeparture(next.world, {
          id: 'resume-allocation',
          flightId: 'resume-flight',
          reservationId: reservation.id,
          departureAttemptId: 'resume-departure',
          mission: { missionId: 'm', sourceRevision: 1, eventId: 'me', contentDigest: digest, recordDigest: digest },
          release: { id: 'r', digest },
          durationMs: 90_000,
        });
        consumeOperationDeparture(next.world, consumption(next.world, allocation));
      });
      await store.update((next) => advanceLiveClock(next, start + 100_000, false));
      const baseline = structuredClone(
        store.state.demoCycles[cycle.id]!.monitoring!.observer.flights[0]!.initialLinkObservation,
      );
      const resumed = new OperationStore(path, (await readOperationCheckpoint(path))!, { resumeAt: start + 140_000 });
      await resumed.update(() => {});
      await resumed.update((next) => advanceLiveClock(next, start + 140_000, false));
      await resumed.update((next) => advanceLiveClock(next, start + 200_000, false));
      const snapshot = operationMonitoringSnapshot(resumed.state.demoCycles![cycle.id]!.monitoring!.observer);
      expect(snapshot.failure).toBeUndefined();
      expect(snapshot.complete).toBe(true);
      expect(snapshot.flights[0]!.initialLinkObservation).toEqual(baseline);
      expect(snapshot.flights[0]!.gaps).toContainEqual({
        kind: 'c2_monitor',
        interval: { start: iso(start + 100_000), end: iso(start + 140_000) },
      });
      expect(snapshot.flights[0]!.coverageIntervals).toEqual([
        { start: iso(start + 70_000), end: iso(start + 100_000) },
        { start: iso(start + 140_000), end: iso(start + 200_000) },
      ]);
      expect(snapshot.plan.window).toEqual(monitoring.plan.monitoring.window);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
