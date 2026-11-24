import { operationDepartureResources } from './operation-predeparture-selection.js';
import { buildOperationRouteTimeline } from './operation-route-timeline.js';
import type { OperationReservation } from './operation-predeparture.js';
import type { OperationWorld } from './operation.js';

export function scheduleOperationReservationExpiry(world: OperationWorld, reservation: OperationReservation): void {
  if (reservation.phase !== 'awaiting-release') return;
  const end = Date.parse(reservation.order.schedule.end);
  const earliest = Math.max(
    world.now,
    Date.parse(reservation.order.schedule.start),
    Date.parse(reservation.plan.operatingInterval.start),
  );
  const route = buildOperationRouteTimeline(reservation, world.config.cruiseMetersPerSecond);
  const deadline = route.status === 'supported' ? end - route.timeline.durationMs + 1 : end + 1;
  const at = Math.max(world.now, route.status === 'supported' && earliest >= deadline ? world.now : deadline);
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()))
    throw new Error('Held reservation requires a finite original customer window');
  const existing = world.events.filter(
    (event) => event.kind === 'reservation-expiry' && event.attemptId === reservation.id,
  );
  if (existing.length === 1 && existing[0]!.at === at) return;
  world.events = world.events.filter(
    (event) => event.kind !== 'reservation-expiry' || event.attemptId !== reservation.id,
  );
  world.events.push({ kind: 'reservation-expiry', at, attemptId: reservation.id, sequence: world.nextEvent++ });
  world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}

export function cancelUnreachableReservation(world: OperationWorld, reservation: OperationReservation): boolean {
  if (
    reservation.phase !== 'awaiting-release' ||
    world.attempts.some((attempt) => attempt.id === reservation.id) ||
    world.departures?.some((departure) => departure.reservationId === reservation.id)
  )
    return false;
  const end = Date.parse(reservation.order.schedule.end);
  const earliest = Math.max(
    world.now,
    Date.parse(reservation.order.schedule.start),
    Date.parse(reservation.plan.operatingInterval.start),
  );
  const route = buildOperationRouteTimeline(reservation, world.config.cruiseMetersPerSecond);
  if (route.status === 'supported' ? earliest + route.timeline.durationMs <= end : world.now <= end) {
    scheduleOperationReservationExpiry(world, reservation);
    return false;
  }
  const aircraft = world.aircraft.find((row) => row.id === reservation.aircraftId);
  const person = operationDepartureResources(world, reservation.id)?.flightPeople.find(
    (row) => row.id === reservation.personId,
  );
  if (
    !aircraft ||
    aircraft.phase !== 'reserved' ||
    aircraft.attemptId !== reservation.id ||
    aircraft.tenant !== reservation.tenant ||
    !person ||
    person.aircraftId !== aircraft.id ||
    person.tenant !== reservation.tenant
  )
    throw new Error('Expired reservation must still own its aircraft and named flight person');
  const at = new Date(world.now).toISOString();
  reservation.cancellation = {
    reason: 'requested_window_unreachable',
    note: `The retained route can no longer complete within the original customer window. Cancelled before departure by ${reservation.tenant === 'alpha' ? 'Alpha' : 'Beta'} dispatch; request a new window if the work is still needed.`,
    decidedAt: at,
    dispatcher: {
      id: `${world.config.runId}-dispatcher-${reservation.tenant}`,
      name: reservation.tenant === 'alpha' ? 'Alpha dispatch' : 'Beta dispatch',
    },
  };
  reservation.phase = 'cancelled';
  world.counters.cancelled++;
  const common = {
    tenant: reservation.tenant,
    at,
    attemptId: reservation.id,
    aircraftId: reservation.aircraftId,
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
    personId: reservation.cancellation.dispatcher.id,
    personName: reservation.cancellation.dispatcher.name,
    reason: reservation.cancellation.reason,
    note: reservation.cancellation.note,
  });
  aircraft.phase = 'ready';
  aircraft.availableAt = world.now;
  delete aircraft.attemptId;
  person.availableAt = world.now;
  delete person.aircraftId;
  const allocation = world.departureAllocations?.find((row) => row.reservationId === reservation.id);
  const pad = operationDepartureResources(world, reservation.id)?.launchPads.find(
    (row) => row.id === allocation?.padId,
  );
  if (allocation && pad?.aircraftId === aircraft.id && pad.availableAt === Date.parse(allocation.endsAt)) {
    pad.availableAt = world.now;
    delete pad.aircraftId;
  }
  world.events = world.events.filter(
    (event) => event.kind !== 'reservation-expiry' || event.attemptId !== reservation.id,
  );
  return true;
}
