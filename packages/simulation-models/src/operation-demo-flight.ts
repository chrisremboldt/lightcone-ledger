import { operationHeldResources } from './operation-ordinary-dispatch.js';
import { occupyResource } from './operation-capacity.js';
import { createOperationReservation, type OperationReservation } from './operation-predeparture.js';
import type { OperationMonitoringControlReference } from './operation-monitoring.js';
import type { OperationTenant, OperationWorld, WorldFact } from './operation.js';
import { yards, type Coordinate } from './places.js';
import { operationDepartureResources } from './operation-predeparture-selection.js';
import { scheduleOperationReservationExpiry } from './operation-reservation-expiry.js';

export interface OperationDemoCircle {
  center: Coordinate;
  radiusMeters: number;
}

export interface OperationDemoFlight {
  version: 'operation.demo-flight.1';
  cycleId: string;
  tenant: OperationTenant;
  attemptId: string;
  control: OperationMonitoringControlReference;
  createdAt: string;
  window: { start: string; end: string };
  origin: Coordinate;
  destination: Coordinate;
  radioInitialState: 'up';
}

export type OperationDemoPreparation =
  { status: 'ready'; flight: OperationDemoFlight } | { status: 'blocked'; reason: string };

const distance = (first: Coordinate, second: Coordinate) =>
  Math.hypot(
    (second.latitude - first.latitude) * 111_320,
    (second.longitude - first.longitude) * 111_320 * Math.cos(((first.latitude + second.latitude) * Math.PI) / 360),
  );

export function prepareOperationDemoFlight(
  world: OperationWorld,
  input: {
    cycleId: string;
    tenant: OperationTenant;
    control: OperationMonitoringControlReference;
    circle: OperationDemoCircle;
    circles: OperationDemoCircle[];
    effectiveFrom: string;
    effectiveUntil: string;
    window?: { start: string; end: string };
  },
): OperationDemoPreparation {
  const blocked = (reason: string): OperationDemoPreparation => ({ status: 'blocked', reason });
  if (
    !input.cycleId ||
    input.cycleId.length > 100 ||
    /[\u0000-\u0020\u007f]/.test(input.cycleId) ||
    world.version !== 'operation-world.2'
  )
    return blocked('demo_profile_unsupported');
  const origin = yards[`tenant-${input.tenant}`];
  const circles = [input.circle, ...input.circles];
  if (
    !origin ||
    circles.length > 65 ||
    circles.some(
      (circle) =>
        !Number.isFinite(circle.center.latitude) ||
        Math.abs(circle.center.latitude) > 70 ||
        !Number.isFinite(circle.center.longitude) ||
        Math.abs(circle.center.longitude) > 170 ||
        !Number.isFinite(circle.radiusMeters) ||
        circle.radiusMeters <= 0 ||
        circle.radiusMeters > 5000,
    )
  )
    return blocked('demo_geometry_unsupported');
  // This conservative source check does not replace the public WGS84 feasibility check.
  if (circles.some((circle) => distance(origin, circle.center) <= circle.radiusMeters + 150))
    return blocked('required_launch_inside_avoidance');
  const range = distance(origin, input.circle.center);
  if (range > 15_000) return blocked('demo_location_outside_operation');
  const destination = [300, 600, 1200, 2400, 4800, 9600]
    .map((extra) => {
      const scale = 1 + (input.circle.radiusMeters + extra) / range;
      return {
        latitude: origin.latitude + (input.circle.center.latitude - origin.latitude) * scale,
        longitude: origin.longitude + (input.circle.center.longitude - origin.longitude) * scale,
      };
    })
    .find(
      (point) =>
        distance(origin, point) < 24_000 &&
        circles.every((circle) => distance(point, circle.center) > circle.radiusMeters + 150),
    );
  if (!destination) return blocked('required_service_inside_avoidance');
  const start = input.window
    ? Date.parse(input.window.start)
    : Math.max(world.now + 60_000, Date.parse(input.effectiveFrom));
  const end = input.window
    ? Date.parse(input.window.end)
    : Math.min(world.now + 25 * 60_000, Date.parse(input.effectiveUntil));
  if (start < Date.parse(input.effectiveFrom) || end > Date.parse(input.effectiveUntil) || end <= world.now)
    return blocked('control_interval_too_short');
  const routeMs = Math.ceil((distance(origin, destination) * 2 * 1000) / world.config.cruiseMetersPerSecond) + 60_000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start < routeMs + 6 * 60_000)
    return blocked('control_interval_too_short');
  return {
    status: 'ready',
    flight: {
      version: 'operation.demo-flight.1',
      cycleId: input.cycleId,
      tenant: input.tenant,
      attemptId: `demo-${world.config.runId}-${input.cycleId}:attempt:1`,
      control: structuredClone(input.control),
      createdAt: new Date(world.now).toISOString(),
      window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      origin: { latitude: origin.latitude, longitude: origin.longitude },
      destination,
      radioInitialState: 'up',
    },
  };
}

export function reserveOperationDemoFlight(
  world: OperationWorld,
  flight: OperationDemoFlight,
): OperationReservation | undefined {
  const previous = world.demoFlights?.find((row) => row.cycleId === flight.cycleId);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(flight))
      throw new Error('Demo cycle changed its retained source plan');
    return world.reservations?.find((row) => row.id === previous.attemptId);
  }
  if (world.demoFlights?.some((row) => row.tenant === flight.tenant))
    throw new Error('One active demo flight per operator is supported');
  const aircraft = world.aircraft.find(
    (row) => row.tenant === flight.tenant && row.phase === 'ready' && row.maintenanceUntil <= world.now,
  );
  const pools = operationHeldResources(world);
  const person = pools.flightPeople.find(
    (row) =>
      row.tenant === flight.tenant &&
      !row.aircraftId &&
      row.availableAt <= world.now &&
      (world.resources || row.id === aircraft?.personId),
  );
  if (!aircraft || !person) return undefined;
  if (Date.parse(flight.window.end) <= world.now + 6 * 60_000)
    throw new Error('The original demo customer window expired');
  const intentId = flight.attemptId.slice(0, -':attempt:1'.length);
  const demand = {
    id: `order-${intentId}`,
    intentId,
    tenant: flight.tenant,
    requestedAt: flight.createdAt,
    siteId: `${intentId}:service`,
    label: 'Avoidance demonstration · required service stop',
    window: { ...flight.window },
  };
  const travelMs = Math.ceil((distance(flight.origin, flight.destination) * 1000) / world.config.cruiseMetersPerSecond);
  const reservation = createOperationReservation(
    {
      id: flight.attemptId,
      intentId,
      demandId: demand.id,
      tenant: flight.tenant,
      aircraftId: aircraft.id,
      personId: person.id,
      sourceSessionId: `${intentId}:capture:1`,
      siteId: demand.siteId,
      origin: { ...flight.origin },
      destination: { ...flight.destination },
      travelMs,
    },
    demand,
    world.now,
    travelMs * 2 + 60_000,
    { cruiseMetersPerSecond: world.config.cruiseMetersPerSecond, holdAllowanceMs: 0 },
  );
  reservation.plan.operatingInterval = { ...flight.window };
  (world.demoFlights ??= []).push(structuredClone(flight));
  (world.reservations ??= []).push(reservation);
  aircraft.phase = 'reserved';
  aircraft.attemptId = reservation.id;
  aircraft.personId = person.id;
  aircraft.availableAt = world.now;
  occupyResource(person, aircraft.id, world.now);
  world.counters.demand++;
  const common = {
    tenant: flight.tenant,
    at: new Date(world.now).toISOString(),
    attemptId: reservation.id,
    aircraftId: aircraft.id,
    sourceSessionId: reservation.sourceSessionId,
  };
  const facts: Omit<Extract<WorldFact, { kind: 'order' }>, 'sequence'>[] = [
    { ...common, kind: 'order', order: { ...structuredClone(reservation.order), version: 1, flights: [] } },
    { ...common, kind: 'order', order: structuredClone(reservation.order) },
  ];
  for (const fact of facts) world.facts.push({ ...fact, sequence: world.nextFact++ });
  world.facts.push({
    kind: 'mission',
    tenant: flight.tenant,
    at: common.at,
    attemptId: reservation.id,
    aircraftId: aircraft.id,
    sourceId: 'mission-planner',
    source: structuredClone(reservation.plan),
    sequence: world.nextFact++,
  });
  scheduleOperationReservationExpiry(world, reservation);
  return reservation;
}

export function cancelOperationDemoFlight(world: OperationWorld, attemptId: string, note: string): void {
  const selected = world.demoFlights?.find((flight) => flight.attemptId === attemptId);
  const reservation = world.reservations?.find((row) => row.id === attemptId);
  if (
    !selected ||
    !reservation ||
    !note ||
    world.departureAllocations?.some((row) => row.reservationId === attemptId) ||
    world.departures?.some((row) => row.reservationId === attemptId) ||
    world.attempts.some((row) => row.id === attemptId)
  )
    throw new Error('Only an unused demo reservation can be cancelled by dispatch');
  if (reservation.phase === 'cancelled') return;
  const aircraft = world.aircraft.find((row) => row.id === reservation.aircraftId);
  const person = operationDepartureResources(world, attemptId)?.flightPeople.find(
    (row) => row.id === reservation.personId,
  );
  if (
    !aircraft ||
    aircraft.phase !== 'reserved' ||
    aircraft.attemptId !== attemptId ||
    !person ||
    person.aircraftId !== aircraft.id
  )
    throw new Error('Demo reservation lost its exclusive aircraft or flight person');
  const at = new Date(world.now).toISOString();
  const dispatcher = {
    id: `${world.config.runId}-dispatcher-${reservation.tenant}`,
    name: reservation.tenant === 'alpha' ? 'Alpha dispatch' : 'Beta dispatch',
  };
  reservation.phase = 'cancelled';
  reservation.cancellation = { reason: 'requested_window_unreachable', note, decidedAt: at, dispatcher };
  const common = {
    tenant: reservation.tenant,
    at,
    attemptId,
    aircraftId: aircraft.id,
    sourceSessionId: reservation.sourceSessionId,
  };
  world.facts.push({
    ...common,
    sequence: world.nextFact++,
    kind: 'order',
    order: {
      ...structuredClone(reservation.order),
      version: reservation.order.version + 1,
      updated_at: at,
      state: 'cancelled',
      cancellation: structuredClone(reservation.cancellation),
    },
  });
  world.facts.push({
    ...common,
    sequence: world.nextFact++,
    kind: 'cancellation',
    personId: dispatcher.id,
    personName: dispatcher.name,
    reason: 'requested_window_unreachable',
    note,
  });
  world.counters.cancelled++;
  aircraft.phase = 'ready';
  aircraft.availableAt = world.now;
  delete aircraft.attemptId;
  person.availableAt = world.now;
  delete person.aircraftId;
  world.events = world.events.filter((event) => event.kind !== 'reservation-expiry' || event.attemptId !== attemptId);
}
