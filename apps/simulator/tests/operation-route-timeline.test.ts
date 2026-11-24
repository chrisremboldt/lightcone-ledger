import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  buildOperationRouteTimeline,
  compactOperation,
  createOperation,
  operationCapacityPreset,
  operationReservationFit,
  operationRoutePoint,
  reviseOperationReservation,
  adoptOperationMissionSource,
  upgradeOperationWorld,
  type OperationReservation,
} from '../../../packages/simulation-models/src/operation.js';
import type { Coordinate } from '../../../packages/simulation-models/src/places.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();

function heldWorld(runId: string, episode = false) {
  const preset = operationCapacityPreset('illustrative-25.1');
  const world = createOperation({
    ...preset,
    runId,
    start: iso(start),
    fleet: { alpha: 1, beta: 1 },
    capacity: {
      ...preset.capacity,
      flightPeople: { alpha: 1, beta: 1 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    predeparture: {
      version: 'reserve-selected-await-release.1',
      tenant: 'alpha',
      attemptId: `intent-${runId}-alpha-0:attempt:1`,
    },
    selectedDemandWindow: {
      attemptId: `intent-${runId}-alpha-0:attempt:1`,
      start: iso(start),
      end: iso(start + 3_600_000),
    },
    ...(episode ? { commandLinkEpisode: 'canal-market-relay.1' as const } : {}),
  });
  advanceOperation(world, start);
  return world;
}

function timelineFor(reservation: OperationReservation, speed: number) {
  const result = buildOperationRouteTimeline(reservation, speed);
  expect(result.status).toBe('supported');
  if (result.status !== 'supported') throw new Error(result.reason);
  return result.timeline;
}

function detour(reservation: OperationReservation) {
  const { origin, destination } = reservation;
  const waypoint = [origin.longitude + 0.001, origin.latitude + 0.001] as [number, number];
  return {
    ...structuredClone(reservation.plan.route),
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [origin.longitude, origin.latitude],
        waypoint,
        [destination.longitude, destination.latitude],
        [...waypoint],
        [destination.longitude, destination.latitude],
        [origin.longitude - 0.001, origin.latitude + 0.002],
        [origin.longitude, origin.latitude],
      ] as Array<[number, number]>,
    },
  };
}

function distance(from: Coordinate, to: Coordinate) {
  return (
    Math.hypot(
      to.latitude - from.latitude,
      (to.longitude - from.longitude) * Math.cos(((from.latitude + to.latitude) * Math.PI) / 360),
    ) * 111_320
  );
}

function location(point: Coordinate) {
  return { longitude: point.longitude, latitude: point.latitude };
}

describe('held polyline route timing', () => {
  it('publishes retained planning bounds and refuses a public revision that relaxes them or cannot fit', () => {
    const world = heldWorld('route-adoption');
    advanceOperation(world, start + 60_000);
    const reservation = world.reservations![0]!;
    reviseOperationReservation(world, reservation.id, {
      sourceRevision: 2,
      operatingInterval: { ...reservation.order.schedule },
    });
    expect(reservation.plan.routePlanning).toMatchObject({
      version: 'mission.route-planning.1',
      requiredLocations: [
        { role: 'launch', position: [reservation.origin.longitude, reservation.origin.latitude] },
        { role: 'service', position: [reservation.destination.longitude, reservation.destination.latitude] },
        { role: 'return', position: [reservation.origin.longitude, reservation.origin.latitude] },
      ],
      cruiseMetersPerSecond: world.config.cruiseMetersPerSecond,
      ascentMs: 20_000,
      serviceMs: 20_000,
      descentMs: 20_000,
      holdAllowanceMs: 0,
      handoffAllowanceMs: 30_000,
      marginMs: 10_000,
      customerInterval: reservation.order.schedule,
      resourceInterval: reservation.order.schedule,
    });
    const source = { ...structuredClone(reservation.plan), sourceRevision: 3, route: detour(reservation) };
    const original = JSON.stringify(world);
    for (const changed of [
      { ...source, aircraftId: 'another-aircraft' },
      { ...source, operatingInterval: { ...source.operatingInterval, end: iso(start + 3_600_001) } },
      { ...source, routePlanning: { ...source.routePlanning!, marginMs: 1 } },
      {
        ...source,
        route: {
          ...source.route,
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [reservation.origin.longitude, reservation.origin.latitude],
              [0, 0],
              [reservation.origin.longitude, reservation.origin.latitude],
            ] as Array<[number, number]>,
          },
        },
      },
      {
        ...source,
        route: {
          ...source.route,
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [reservation.origin.longitude, reservation.origin.latitude],
              [0, 0],
              [reservation.destination.longitude, reservation.destination.latitude],
              [reservation.origin.longitude, reservation.origin.latitude],
            ] as Array<[number, number]>,
          },
        },
      },
    ]) {
      expect(() =>
        adoptOperationMissionSource(
          world,
          reservation.id,
          changed,
          { receiptId: 'public-receipt', originalBytesBase64: 'retained-original' },
          { marginMs: 10_000, handoffAllowanceMs: 30_000 },
        ),
      ).toThrow();
      expect(JSON.stringify(world)).toBe(original);
    }
    adoptOperationMissionSource(
      world,
      reservation.id,
      source,
      { receiptId: 'public-receipt', originalBytesBase64: 'retained-original' },
      { marginMs: 10_000, handoffAllowanceMs: 30_000 },
    );
    expect(reservation.plan).toEqual(source);
    expect(world.facts.at(-1)).toMatchObject({
      kind: 'mission',
      source,
      publicAcceptance: { receiptId: 'public-receipt', originalBytesBase64: 'retained-original' },
    });
  });
  it('uses every revised detour leg and services only the first explicit destination visit', () => {
    const world = heldWorld('route-detour');
    const reservation = world.reservations![0]!;
    reviseOperationReservation(world, reservation.id, { sourceRevision: 2, route: detour(reservation) });
    const before = JSON.stringify(world);
    const timeline = timelineFor(reservation, world.config.cruiseMetersPerSecond);
    expect(timeline.version).toBe('held-polyline.1');
    expect(timeline.plan).toEqual(reservation.plan);
    expect(timeline.serviceVertexIndex).toBe(2);
    expect(timeline.phases.map((phase) => phase.kind)).toEqual([
      'ascent',
      'travel',
      'travel',
      'service',
      'travel',
      'travel',
      'travel',
      'travel',
      'descent',
    ]);
    const vertices = reservation.plan.route.geometry.coordinates.map(([longitude, latitude]) => ({
      longitude,
      latitude,
    }));
    const travel = timeline.phases.filter((phase) => phase.kind === 'travel');
    let expectedDuration = 60_000;
    for (let index = 0; index < travel.length; index++) {
      const phase = travel[index]!;
      const from = vertices[index]!;
      const to = vertices[index + 1]!;
      const travelMs = Math.ceil((distance(from, to) / world.config.cruiseMetersPerSecond) * 1000);
      expect(phase.from).toEqual(from);
      expect(phase.to).toEqual(to);
      expect(phase.distanceMeters).toBeCloseTo(distance(from, to), 8);
      expect(phase.endMs - phase.startMs).toBe(travelMs);
      expectedDuration += travelMs;
      const midpoint = operationRoutePoint(timeline, (phase.startMs + phase.endMs) / 2);
      expect(midpoint.phase).toBe('travel');
      expect(midpoint.longitude).toBeCloseTo((from.longitude + to.longitude) / 2, 10);
      expect(midpoint.latitude).toBeCloseTo((from.latitude + to.latitude) / 2, 10);
      expect(midpoint.horizontalSpeed).toBeGreaterThan(0);
      expect(midpoint.horizontalSpeed).toBeLessThanOrEqual(world.config.cruiseMetersPerSecond);
      expect(location(operationRoutePoint(timeline, phase.endMs))).toEqual(to);
    }
    const service = timeline.phases.find((phase) => phase.kind === 'service')!;
    expect(service.endMs - service.startMs).toBe(20_000);
    expect(operationRoutePoint(timeline, service.startMs)).toMatchObject({
      ...reservation.destination,
      phase: 'service',
      horizontalSpeed: 0,
    });
    expect(operationRoutePoint(timeline, service.endMs).phase).toBe('travel');
    expect(timeline.phases[0]!.endMs).toBe(20_000);
    expect(timeline.durationMs - timeline.phases.at(-1)!.startMs).toBe(20_000);
    expect(timeline.durationMs).toBe(expectedDuration);
    for (let index = 1; index < timeline.phases.length; index++)
      expect(timeline.phases[index]!.startMs).toBe(timeline.phases[index - 1]!.endMs);
    expect(JSON.stringify(world)).toBe(before);
    const snapshot = structuredClone(timeline);
    const nextRoute = structuredClone(reservation.plan.route);
    nextRoute.geometry.coordinates[1]![0] += 0.0005;
    reviseOperationReservation(world, reservation.id, { sourceRevision: 3, route: nextRoute });
    expect(reservation.plan.sourceRevision).toBe(3);
    expect(timeline.plan.sourceRevision).toBe(2);
    nextRoute.geometry.coordinates[1]![0] += 1;
    expect(timeline).toEqual(snapshot);
  });

  it('omits exact repeated-point travel and pauses the motion clock with continuous half-open hold boundaries', () => {
    const world = heldWorld('route-pause');
    const reservation = world.reservations![0]!;
    const [origin, destination] = reservation.plan.route.geometry.coordinates;
    const route = structuredClone(reservation.plan.route);
    route.geometry.coordinates = [origin!, origin!, destination!, destination!, origin!, origin!];
    reviseOperationReservation(world, reservation.id, { sourceRevision: 2, route });
    const timeline = timelineFor(reservation, world.config.cruiseMetersPerSecond);
    expect(timeline.serviceVertexIndex).toBe(2);
    expect(timeline.phases.map((phase) => phase.kind)).toEqual(['ascent', 'travel', 'service', 'travel', 'descent']);
    const travel = timeline.phases[1]!;
    const pause = { startsAtMs: travel.startMs + Math.floor((travel.endMs - travel.startMs) / 2), durationMs: 15_000 };
    const holdPoint = operationRoutePoint(timeline, pause.startsAtMs);
    expect(operationRoutePoint(timeline, pause.startsAtMs - 1, pause)).toEqual(
      operationRoutePoint(timeline, pause.startsAtMs - 1),
    );
    for (const elapsed of [pause.startsAtMs, pause.startsAtMs + pause.durationMs - 1])
      expect(operationRoutePoint(timeline, elapsed, pause)).toEqual({
        ...holdPoint,
        phase: 'held',
        horizontalSpeed: 0,
      });
    expect(operationRoutePoint(timeline, pause.startsAtMs + pause.durationMs, pause)).toEqual(holdPoint);
    expect(operationRoutePoint(timeline, pause.startsAtMs + pause.durationMs + 0.5, pause)).toEqual(
      operationRoutePoint(timeline, pause.startsAtMs + 0.5),
    );
    expect(operationRoutePoint(timeline, -1)).toMatchObject({
      ...reservation.origin,
      phase: 'ascent',
      motionElapsedMs: 0,
      horizontalSpeed: 0,
    });
    expect(operationRoutePoint(timeline, timeline.durationMs + pause.durationMs, pause)).toEqual({
      ...reservation.origin,
      phase: 'complete',
      motionElapsedMs: timeline.durationMs,
      horizontalSpeed: 0,
    });
    expect(() => operationRoutePoint(timeline, Number.NaN)).toThrow();
    expect(() => operationRoutePoint(timeline, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => operationRoutePoint(timeline, 0, { startsAtMs: 0, durationMs: Number.MAX_SAFE_INTEGER })).toThrow();

    const tiny = structuredClone(reservation);
    delete tiny.plan.routePlanning;
    tiny.origin = { longitude: 0, latitude: 90 };
    tiny.destination = { longitude: Number.MIN_VALUE, latitude: 90 };
    tiny.plan.route.geometry.coordinates = [
      [0, 90],
      [Number.MIN_VALUE, 90],
      [0, 90],
    ];
    const tinyTimeline = timelineFor(tiny, 12);
    expect(
      tinyTimeline.phases.filter((phase) => phase.kind === 'travel').map((phase) => phase.endMs - phase.startMs),
    ).toEqual([1, 1]);
    expect(tinyTimeline.durationMs).toBe(60_002);

    const across = structuredClone(reservation);
    delete across.plan.routePlanning;
    across.origin = { longitude: 179, latitude: 0 };
    across.destination = { longitude: -179, latitude: 0 };
    across.plan.route.geometry.coordinates = [
      [179, 0],
      [-179, 0],
      [179, 0],
    ];
    const acrossTimeline = timelineFor(across, 12);
    const acrossLeg = acrossTimeline.phases[1]!;
    expect(location(operationRoutePoint(acrossTimeline, (acrossLeg.startMs + acrossLeg.endMs) / 2))).toEqual({
      longitude: 0,
      latitude: 0,
    });
  });

  it('fits the exact completion deadline and handoff time without shifting departure or mutating the reservation', () => {
    const world = heldWorld('route-fit');
    const reservation = world.reservations![0]!;
    reviseOperationReservation(world, reservation.id, { sourceRevision: 2, route: detour(reservation) });
    const timeline = timelineFor(reservation, world.config.cruiseMetersPerSecond);
    const marginMs = 10_000;
    const handoffAllowanceMs = 5_000;
    const completion = start + handoffAllowanceMs + timeline.durationMs + marginMs;
    reviseOperationReservation(world, reservation.id, {
      sourceRevision: 3,
      operatingInterval: { start: iso(start + handoffAllowanceMs), end: iso(completion) },
    });
    const before = JSON.stringify(world);
    expect(operationReservationFit(world, reservation.id, { marginMs, handoffAllowanceMs })).toEqual({
      status: 'fits',
      sourceMissionId: reservation.plan.sourceMissionId,
      sourceRevision: 3,
      evaluatedAt: iso(start),
      departureAt: iso(start + handoffAllowanceMs),
      nominalDurationMs: timeline.durationMs,
      holdAllowanceMs: 0,
      marginMs,
      handoffAllowanceMs,
      requiredCompletionAt: iso(completion),
      latestDepartureAt: iso(start + handoffAllowanceMs),
    });
    expect(
      operationReservationFit(world, reservation.id, { marginMs: marginMs + 1, handoffAllowanceMs }),
    ).toMatchObject({ status: 'held', reason: 'mission_interval_insufficient' });
    expect(
      operationReservationFit(world, reservation.id, { marginMs, handoffAllowanceMs: handoffAllowanceMs + 1 }),
    ).toMatchObject({ status: 'held', reason: 'mission_interval_insufficient' });
    expect(
      operationReservationFit(world, reservation.id, { marginMs, handoffAllowanceMs: handoffAllowanceMs - 1 }),
    ).toMatchObject({
      status: 'held',
      reason: 'departure_before_plan_interval',
      departureAt: iso(start + handoffAllowanceMs - 1),
    });
    expect(JSON.stringify(world)).toBe(before);
  });

  it('retains a pure fit through JSON and compaction while holding unknown fault bounds, overflow and unsupported geometry', () => {
    const world = heldWorld('route-restart', true);
    const reservation = world.reservations![0]!;
    reviseOperationReservation(world, reservation.id, {
      sourceRevision: 2,
      route: detour(reservation),
      operatingInterval: { start: iso(start), end: reservation.order.schedule.end },
    });
    const timeline = timelineFor(reservation, world.config.cruiseMetersPerSecond);
    const options = { marginMs: 10_000 };
    const before = JSON.stringify(world);
    const fit = operationReservationFit(world, reservation.id, options);
    expect(fit).toMatchObject({
      status: 'fits',
      holdAllowanceMs: 30_000,
      requiredCompletionAt: iso(start + timeline.durationMs + 30_000 + options.marginMs),
    });
    expect(JSON.stringify(world)).toBe(before);
    compactOperation(world);
    const resumed = upgradeOperationWorld(JSON.parse(JSON.stringify(world)));
    const retained = structuredClone(resumed.reservations![0]!);
    expect(timelineFor(retained, resumed.config.cruiseMetersPerSecond)).toEqual(timeline);
    expect(operationReservationFit(resumed, retained.id, options)).toEqual(fit);
    expect(resumed.resources).toEqual(world.resources);
    advanceOperation(resumed, start + 120_000);
    expect(operationReservationFit(resumed, retained.id, options)).toMatchObject({
      status: 'fits',
      holdAllowanceMs: 0,
    });
    expect(resumed.reservations![0]).toEqual(retained);
    expect(resumed.attempts.every((attempt) => attempt.id !== retained.id)).toBe(true);
    expect(resumed.facts.filter((fact) => fact.attemptId === retained.id).every((fact) => fact.kind === 'order')).toBe(
      true,
    );
    const unknown = structuredClone(resumed);
    unknown.commandLinkEpisode!.endsAt = 'unknown';
    expect(operationReservationFit(unknown, retained.id, options)).toMatchObject({
      status: 'held',
      reason: 'command_link_allowance_unavailable',
    });
    expect(operationReservationFit(resumed, retained.id, { marginMs: Number.MAX_SAFE_INTEGER })).toMatchObject({
      status: 'held',
      reason: 'fit_bounds_invalid',
    });
    expect(
      operationReservationFit(resumed, retained.id, { marginMs: 1, handoffAllowanceMs: Number.MAX_SAFE_INTEGER }),
    ).toMatchObject({ status: 'held', reason: 'fit_bounds_invalid' });
    const unsupported = structuredClone(resumed);
    unsupported.reservations![0]!.plan.route.geometry.coordinates[0]![0] += 0.001;
    expect(
      buildOperationRouteTimeline(unsupported.reservations![0]!, unsupported.config.cruiseMetersPerSecond).status,
    ).toBe('unsupported');
    expect(operationReservationFit(unsupported, retained.id, options).status).toBe('held');
    const noService = structuredClone(retained);
    noService.plan.route.geometry.coordinates = [
      [retained.origin.longitude, retained.origin.latitude],
      [retained.origin.longitude, retained.origin.latitude],
    ];
    expect(buildOperationRouteTimeline(noService, resumed.config.cruiseMetersPerSecond).status).toBe('unsupported');
  });
});
