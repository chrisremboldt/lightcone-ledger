import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import { missionDeparturePermit } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  advanceOperation,
  allocateOperationDeparture,
  buildOperationRouteTimeline,
  capacityStatus,
  compactOperation,
  consumeOperationDeparture,
  createOperation,
  operationCapacityPreset,
  operationPoint,
  operationReservationFit,
  operationRouteCommandLinkLossAt,
  operationRoutePoint,
  reviseOperationReservation,
  upgradeOperationWorld,
  type OperationDepartureAllocation,
  type OperationDepartureConsumeInput,
  type OperationDeparturePermit,
  type OperationWorld,
} from '../../../packages/simulation-models/src/operation.js';
import { places } from '../../../packages/simulation-models/src/places.js';
import { createCommandLinkEpisode } from '../../../packages/simulation-models/src/operation-command-link.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const digest = 'a'.repeat(64);

function heldWorld(runId: string, episode = false, selected = false) {
  const preset = operationCapacityPreset('illustrative-25.1');
  const world = createOperation({
    ...preset,
    runId,
    start: iso(start),
    fleet: { alpha: 1, beta: 2 },
    capacity: {
      ...preset.capacity,
      flightPeople: { alpha: 1, beta: 2 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    predeparture: selected
      ? { version: 'reserve-selected-await-release.1', tenant: 'alpha', attemptId: `intent-${runId}-alpha-0:attempt:1` }
      : { version: 'reserve-await-release.1', tenant: 'beta' },
    ...(selected
      ? {
          selectedDemandWindow: {
            attemptId: `intent-${runId}-alpha-0:attempt:1`,
            start: iso(start),
            end: iso(start + 3_600_000),
          },
        }
      : {}),
    ...(episode ? { commandLinkEpisode: 'canal-market-relay.1' as const } : {}),
  });
  advanceOperation(world, start + 60_000);
  const reservation = world.reservations![0]!;
  const route = structuredClone(reservation.plan.route);
  route.geometry.coordinates.splice(1, 0, [reservation.origin.longitude + 0.001, reservation.origin.latitude + 0.002]);
  reviseOperationReservation(world, reservation.id, {
    sourceRevision: 3,
    route,
    operatingInterval: { start: iso(world.now), end: reservation.order.schedule.end },
  });
  return world;
}

function allocate(world: OperationWorld): OperationDepartureAllocation {
  const reservation = world.reservations![0]!;
  return allocateOperationDeparture(world, {
    id: 'allocation-beta-1',
    flightId: 'ledger-flight-beta-1',
    reservationId: reservation.id,
    departureAttemptId: 'departure-beta-1',
    mission: {
      missionId: 'ledger-mission-beta-1',
      sourceRevision: reservation.plan.sourceRevision,
      eventId: 'ledger-mission-event-beta-3',
      contentDigest: digest,
      recordDigest: digest,
    },
    release: { id: 'release-beta-1', digest },
    durationMs: 90_000,
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

describe('single held reservation departure', () => {
  it('holds Alpha below 25 airborne until the selected reservation actually consumes its departure', () => {
    const runId = 'capacity-selected-departure';
    const selectedId = `intent-${runId}-alpha-0:attempt:1`;
    const world = createOperation({
      ...operationCapacityPreset('alpha-25.1'),
      runId,
      start: iso(start),
      sampleIntervalMs: 30_000,
      predeparture: { version: 'reserve-selected-await-release.1', tenant: 'alpha', attemptId: selectedId },
      selectedDemandWindow: { attemptId: selectedId, start: iso(start), end: iso(start + 3_600_000) },
    });
    for (let elapsed = 0; elapsed <= 20 * 60_000; elapsed += 5_000) {
      advanceOperation(world, start + elapsed);
      expect(world.reservations).toHaveLength(1);
      const held = world.reservations![0]!;
      const flying = world.attempts.filter((attempt) => attempt.tenant === 'alpha' && attempt.phase === 'flying');
      const counts = capacityStatus(world).capacity!.tenants.alpha;
      expect(counts.airborne).toBe(flying.length);
      expect(counts.airborne).toBeLessThanOrEqual(24);
      expect(counts.held).toBe(1);
      expect(held.id).toBe(selectedId);
      expect(new Set([...flying.map((attempt) => attempt.aircraftId), held.aircraftId]).size).toBe(flying.length + 1);
      expect(new Set([...flying.map((attempt) => attempt.personId), held.personId]).size).toBe(flying.length + 1);
      expect(world.resources!.flightPeople.find((person) => person.id === held.personId)?.aircraftId).toBe(
        held.aircraftId,
      );
      expect(world.resources!.launchPads.some((pad) => pad.aircraftId === held.aircraftId)).toBe(false);
      expect(
        flying.every(
          (attempt) =>
            world.resources!.flightPeople.find((person) => person.id === attempt.personId)?.aircraftId ===
            attempt.aircraftId,
        ),
      ).toBe(true);
      if (
        counts.airborne === 24 &&
        world.resources!.launchPads.some((pad) => pad.tenant === 'alpha' && pad.availableAt <= world.now)
      )
        break;
    }
    expect(capacityStatus(world).capacity!.tenants.alpha).toMatchObject({ airborne: 24, held: 1 });
    const held = structuredClone(world.reservations![0]!);
    expect(world.attempts.some((attempt) => attempt.id === selectedId)).toBe(false);
    reviseOperationReservation(world, selectedId, {
      sourceRevision: 2,
      operatingInterval: { start: iso(world.now), end: held.order.schedule.end },
    });
    const input = consumption(world, allocate(world));
    const commit = consumeOperationDeparture(world, input);
    const flying = world.attempts.filter((attempt) => attempt.tenant === 'alpha' && attempt.phase === 'flying');
    expect(capacityStatus(world).capacity!.tenants.alpha).toMatchObject({ airborne: 25, held: 0 });
    expect(new Set(flying.map((attempt) => attempt.aircraftId)).size).toBe(25);
    expect(new Set(flying.map((attempt) => attempt.personId)).size).toBe(25);
    expect(commit).toMatchObject({ attemptId: selectedId, aircraftId: held.aircraftId, personId: held.personId });
    expect(world.departures).toEqual([commit]);
    expect(world.facts.filter((fact) => fact.attemptId === selectedId && fact.kind === 'departure')).toHaveLength(1);
    const departed = JSON.stringify(world);
    expect(() => consumeOperationDeparture(world, input)).toThrow();
    expect(JSON.stringify(world)).toBe(departed);
    const selected = world.attempts.find((attempt) => attempt.id === selectedId)!;
    advanceOperation(world, Date.parse(selected.landing));
    compactOperation(world);
    const resumed = upgradeOperationWorld(JSON.parse(JSON.stringify(world)) as OperationWorld);
    expect(resumed.departures).toEqual([commit]);
    expect(resumed.departureAllocations).toEqual([input.allocation]);
    expect(resumed.reservations).toEqual([]);
  });

  it.each([false, true])(
    'retains an exclusive allocation and atomically starts only the pinned route (selected=%s)',
    (selected) => {
      const world = heldWorld('departure-route', false, selected);
      const held = structuredClone(world.reservations![0]!);
      const others = structuredClone(world.reservations!.slice(1));
      const allocation = allocate(world);
      expect(world.attempts.every((attempt) => attempt.tenant !== held.tenant)).toBe(true);
      expect(world.resources!.launchPads.find((pad) => pad.id === allocation.padId)).toMatchObject({
        aircraftId: held.aircraftId,
        availableAt: Date.parse(allocation.endsAt),
      });
      const input = consumption(world, allocation);
      const originalFacts = structuredClone(world.facts);
      const background = structuredClone(world.attempts);
      const commit = consumeOperationDeparture(world, input);
      const attempt = world.attempts.find((row) => row.id === held.id)!;
      expect(world.reservations).toEqual(others);
      expect(world.attempts.filter((row) => row.tenant !== held.tenant)).toEqual(background);
      expect(world.facts.slice(0, -2)).toEqual(originalFacts);
      expect(world.facts.slice(-2).map((fact) => fact.kind)).toEqual(['departure', 'position']);
      expect(commit).toMatchObject({
        ...input,
        departureAt: iso(world.now),
        attemptId: held.id,
        sourceSessionId: held.sourceSessionId,
      });
      expect(attempt.routeTimeline!.plan).toEqual(held.plan);
      const departed = structuredClone(world);
      expect(() => consumeOperationDeparture(world, input)).toThrow();
      expect(world).toEqual(departed);
      expect(attempt.landing).toBe(iso(world.now + input.fit.remainingDurationMs));
      const travel = attempt.routeTimeline!.phases.find((phase) => phase.kind === 'travel')!;
      const elapsed = travel.startMs + Math.floor((travel.endMs - travel.startMs) / 2);
      const expected = operationRoutePoint(attempt.routeTimeline!, elapsed);
      expect(operationPoint(attempt, world.now + elapsed)).toMatchObject({
        latitude: expected.latitude,
        longitude: expected.longitude,
        horizontalSpeed: expected.horizontalSpeed,
      });
      const retained = structuredClone(world.departures![0]);
      input.requestBytes = '{}';
      commit.allocation.sourcePlan.route.geometry.coordinates[0]![0] += 1;
      expect(world.departures![0]).toEqual(retained);
      const landing = Date.parse(attempt.landing);
      advanceOperation(world, landing);
      expect(attempt.phase).toBe('landed');
      expect(operationPoint(attempt, landing)).toMatchObject({ ...held.origin, horizontalSpeed: 0 });
      expect(world.aircraft.find((row) => row.id === held.aircraftId)!.phase).toBe('turnaround');
      expect(world.resources!.flightPeople.find((row) => row.id === held.personId)!.aircraftId).toBeUndefined();
    },
  );

  it('fails closed without partial mutation for changed plans, bad bindings, stale fit, expiry or lost pad ownership', () => {
    for (const change of [
      (world: OperationWorld, input: OperationDepartureConsumeInput) => {
        input.allocation.sourcePlan.sourceRevision++;
      },
      (world: OperationWorld, input: OperationDepartureConsumeInput) => {
        input.requestBytes = '{}';
      },
      (world: OperationWorld, input: OperationDepartureConsumeInput) => {
        input.fit.remainingDurationMs++;
      },
      (world: OperationWorld, input: OperationDepartureConsumeInput) => {
        input.permit.validUntil = iso(world.now);
      },
      (world: OperationWorld, input: OperationDepartureConsumeInput) => {
        world.resources!.launchPads.find((row) => row.id === input.allocation.padId)!.aircraftId = 'other-aircraft';
      },
      (world: OperationWorld, input: OperationDepartureConsumeInput) => {
        reviseOperationReservation(world, input.allocation.reservationId, {
          sourceRevision: 4,
          operatingInterval: input.allocation.sourcePlan.operatingInterval,
        });
      },
    ]) {
      const world = heldWorld('departure-refuse');
      const input = consumption(world, allocate(world));
      change(world, input);
      const before = JSON.stringify(world);
      expect(() => consumeOperationDeparture(world, input)).toThrow();
      expect(JSON.stringify(world)).toBe(before);
    }
    const world = heldWorld('departure-expiry');
    const allocation = allocate(world);
    advanceOperation(world, Date.parse(allocation.endsAt) - 9_999);
    const input = consumption(world, allocation);
    const before = JSON.stringify(world);
    expect(() => consumeOperationDeparture(world, input)).toThrow('ten seconds');
    expect(JSON.stringify(world)).toBe(before);
  });

  it('pauses the exact revised polyline and delays landing and named resource release for a bounded command-link loss', () => {
    const world = heldWorld('departure-c2', false, true);
    world.config.commandLinkEpisode = 'canal-market-relay.1';
    world.commandLinkEpisode = createCommandLinkEpisode(world.config, start);
    const reservation = world.reservations![0]!;
    const center = places['Canal Market']!;
    const route = structuredClone(reservation.plan.route);
    route.geometry.coordinates.splice(1, 0, [center.longitude, center.latitude]);
    reviseOperationReservation(world, reservation.id, { sourceRevision: 4, route });
    const built = buildOperationRouteTimeline(reservation, world.config.cruiseMetersPerSecond);
    if (built.status !== 'supported') throw new Error(built.reason);
    const arrival = built.timeline.phases.find(
      (phase) => phase.to.longitude === center.longitude && phase.to.latitude === center.latitude,
    )!.endMs;
    world.commandLinkEpisode!.startsAt = iso(world.now + arrival - 5_000);
    world.commandLinkEpisode!.endsAt = iso(world.now + arrival + 25_000);
    const allocation = allocate(world);
    const input = consumption(world, allocation);
    expect(input.fit.holdAllowanceMs).toBe(30_000);
    const expectedLoss = operationRouteCommandLinkLossAt(built.timeline, world.now, world.commandLinkEpisode!)!;
    consumeOperationDeparture(world, input);
    const attempt = world.attempts.find((row) => row.id === reservation.id)!;
    const nominalLanding = Date.parse(attempt.landing);
    advanceOperation(world, expectedLoss);
    const hold = attempt.commandLinkHold!;
    expect(hold.lostAt).toBe(iso(expectedLoss));
    expect(Date.parse(attempt.landing)).toBe(nominalLanding + hold.holdMs);
    expect(world.resources!.flightPeople.find((row) => row.id === attempt.personId)!.availableAt).toBe(
      Date.parse(attempt.landing),
    );
    expect(operationPoint(attempt, expectedLoss + 1_000)).toMatchObject({
      latitude: hold.point.latitude,
      longitude: hold.point.longitude,
      horizontalSpeed: 0,
    });
    advanceOperation(world, Date.parse(hold.restoredAt));
    const resumed = operationPoint(attempt, Date.parse(hold.restoredAt));
    const original = operationRoutePoint(built.timeline, expectedLoss - Date.parse(attempt.departure));
    expect(resumed).toMatchObject({ latitude: original.latitude, longitude: original.longitude });
    advanceOperation(world, Date.parse(attempt.landing));
    expect(world.facts.filter((fact) => fact.attemptId === attempt.id && fact.kind === 'landing')).toHaveLength(1);
  });

  it('keeps once-per-flight and allocation commitments across restart and compaction without changing old-world shape', () => {
    const ordinary = createOperation({ runId: 'departure-default', start: iso(start) });
    expect(Object.hasOwn(ordinary, 'departureAllocations')).toBe(false);
    expect(Object.hasOwn(ordinary, 'departures')).toBe(false);
    const world = heldWorld('departure-once');
    const allocation = allocate(world);
    const input = consumption(world, allocation);
    consumeOperationDeparture(world, input);
    const landing = Date.parse(world.attempts.find((row) => row.id === allocation.reservationId)!.landing);
    advanceOperation(world, landing + world.config.turnaroundMs + world.config.chargeMs + 1);
    compactOperation(world);
    const resumed = JSON.parse(JSON.stringify(world)) as OperationWorld;
    expect(resumed.departures).toEqual(world.departures);
    expect(resumed.departureAllocations).toEqual(world.departureAllocations);
    expect(resumed.departures).toHaveLength(1);
    expect(resumed.departureAllocations).toHaveLength(1);
    const before = JSON.stringify(resumed);
    expect(() => consumeOperationDeparture(resumed, input)).toThrow();
    expect(JSON.stringify(resumed)).toBe(before);
    const remaining = resumed.reservations![0]!;
    expect(() =>
      allocateOperationDeparture(resumed, {
        id: 'replacement-allocation',
        flightId: 'different-ledger-flight',
        reservationId: remaining.id,
        departureAttemptId: 'replacement-attempt',
        mission: { ...allocation.mission, sourceRevision: remaining.plan.sourceRevision },
        release: allocation.release,
        durationMs: 90_000,
      }),
    ).toThrow('cannot replace');
    expect(JSON.stringify(resumed)).toBe(before);
    expect(resumed.departures).toHaveLength(1);
    expect(resumed.departureAllocations).toHaveLength(1);
  });
});
