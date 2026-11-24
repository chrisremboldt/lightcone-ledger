import { operationAdditiveFlight } from './operation-ordinary-dispatch.js';
import type { PartnerOrder } from './index.js';
import { plannedOperationMissionSource, type OperationMissionSource } from './operation-mission.js';
import { validateOperationMissionSource } from './operation-mission-validation.js';
import { operationReservationFit } from './operation-route-fit.js';
import { holdsWorldOperationAttempt, operationDepartureResources } from './operation-predeparture-selection.js';
import { scheduleOperationReservationExpiry } from './operation-reservation-expiry.js';
import type { OperationAttempt, OperationDemand, OperationWorld, WorldFact } from './operation.js';
import { operationPhases } from './operation-command-link.js';

export type { OperationPredeparture } from './operation-predeparture-selection.js';
export interface OperationReservation extends Omit<
  OperationAttempt,
  'departure' | 'landing' | 'phase' | 'commandLinkHold' | 'simulatedLink'
> {
  reservedAt: string;
  phase: 'awaiting-release' | 'cancelled';
  cancellation?: PartnerOrder['cancellation'];
  plan: OperationMissionSource;
  order: PartnerOrder;
}

export interface OperationReservationChange {
  sourceRevision: number;
  route?: OperationMissionSource['route'];
  operatingInterval?: OperationMissionSource['operatingInterval'];
}

export function createOperationReservation(
  identity: Omit<OperationAttempt, 'departure' | 'landing' | 'phase' | 'commandLinkHold' | 'simulatedLink'>,
  demand: OperationDemand,
  at: number,
  duration: number,
  planning?: { cruiseMetersPerSecond: number; holdAllowanceMs: number },
): OperationReservation {
  const reservedAt = new Date(at).toISOString();
  const interval =
    demand.window && Date.parse(demand.window.start) > at
      ? { ...demand.window }
      : { start: new Date(at + 60_000).toISOString(), end: new Date(at + 60_000 + duration).toISOString() };
  const plan = plannedOperationMissionSource(identity, {
    sourceRevision: 1,
    occurredAt: reservedAt,
    operatingInterval: interval,
  });
  if (planning) {
    const available = demand.window ? { ...demand.window } : { ...interval };
    plan.routePlanning = {
      version: 'mission.route-planning.1',
      requiredLocations: [
        { role: 'launch', position: [identity.origin.longitude, identity.origin.latitude] },
        { role: 'service', position: [identity.destination.longitude, identity.destination.latitude] },
        { role: 'return', position: [identity.origin.longitude, identity.origin.latitude] },
      ],
      cruiseMetersPerSecond: planning.cruiseMetersPerSecond,
      ascentMs: operationPhases.ascentMs,
      serviceMs: operationPhases.dwellMs,
      descentMs: operationPhases.descentMs,
      holdAllowanceMs: planning.holdAllowanceMs,
      handoffAllowanceMs: 30_000,
      marginMs: 10_000,
      customerInterval: { ...available },
      resourceInterval: { ...available },
    };
  }
  return {
    ...identity,
    reservedAt,
    phase: 'awaiting-release',
    plan,
    order: {
      order_id: demand.id,
      version: 2,
      updated_at: reservedAt,
      state: 'accepted',
      schedule: demand.window ? { ...demand.window } : { ...interval },
      requested_work: { name: demand.label },
      flights: [
        { flight_intent_id: demand.intentId, attempt: 1, order_refs: [demand.id], aircraft_id: identity.aircraftId },
      ],
    },
  };
}

export function reviseOperationReservation(
  world: OperationWorld,
  attemptId: string,
  change: OperationReservationChange,
): OperationMissionSource {
  if (
    typeof change !== 'object' ||
    change === null ||
    Array.isArray(change) ||
    !Object.hasOwn(change, 'sourceRevision') ||
    Object.keys(change).some((key) => !['sourceRevision', 'route', 'operatingInterval'].includes(key)) ||
    (!Object.hasOwn(change, 'route') && !Object.hasOwn(change, 'operatingInterval')) ||
    !Number.isSafeInteger(change.sourceRevision) ||
    change.sourceRevision < 1
  )
    throw new Error('A reservation revision requires a positive source revision and an explicit route or interval');
  const reservation = world.reservations?.find((row) => row.id === attemptId);
  if (
    !reservation ||
    !holdsWorldOperationAttempt(world, reservation.tenant, reservation.id) ||
    reservation.phase !== 'awaiting-release' ||
    world.attempts.some((attempt) => attempt.id === attemptId)
  )
    throw new Error('Only a retained held reservation can revise its mission plan');
  const aircraft = world.aircraft.find((row) => row.id === reservation.aircraftId);
  const flightPerson = operationDepartureResources(world, reservation.id)?.flightPeople.find(
    (row) => row.id === reservation.personId,
  );
  if (
    !aircraft ||
    aircraft.tenant !== reservation.tenant ||
    aircraft.phase !== 'reserved' ||
    aircraft.attemptId !== reservation.id ||
    aircraft.personId !== reservation.personId ||
    !flightPerson ||
    flightPerson.tenant !== reservation.tenant ||
    flightPerson.aircraftId !== reservation.aircraftId
  )
    throw new Error('Held reservation no longer owns its aircraft and named flight person');
  validateOperationMissionSource(reservation.plan);
  if (
    reservation.plan.sourceMissionId !== `${reservation.id}:mission` ||
    reservation.plan.aircraftId !== reservation.aircraftId
  )
    throw new Error('Held mission identity no longer matches its reservation');
  if (change.sourceRevision <= reservation.plan.sourceRevision)
    throw new Error('Mission source revision must exceed the current held plan revision');
  if (
    !Number.isSafeInteger(world.now) ||
    !Number.isFinite(new Date(world.now).getTime()) ||
    !Number.isSafeInteger(world.nextFact) ||
    world.nextFact < 0 ||
    world.nextFact >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('Reservation revision requires a valid world clock and fact sequence');
  const plan = {
    ...reservation.plan,
    sourceRevision: change.sourceRevision,
    occurredAt: new Date(world.now).toISOString(),
    route: Object.hasOwn(change, 'route') ? change.route : reservation.plan.route,
    operatingInterval: Object.hasOwn(change, 'operatingInterval')
      ? change.operatingInterval
      : reservation.plan.operatingInterval,
  };
  validateOperationMissionSource(plan);
  if (
    Date.parse(plan.operatingInterval.start) < Date.parse(reservation.order.schedule.start) ||
    Date.parse(plan.operatingInterval.end) > Date.parse(reservation.order.schedule.end)
  )
    throw new Error(
      'Mission revision must remain within the original customer window; dispatch must explicitly revise the request',
    );
  const retainedPlan = structuredClone(plan);
  const result = structuredClone(plan);
  const fact: Extract<WorldFact, { kind: 'mission' }> = {
    sequence: world.nextFact,
    kind: 'mission',
    tenant: reservation.tenant,
    at: plan.occurredAt,
    attemptId: reservation.id,
    aircraftId: reservation.aircraftId,
    sourceId: 'mission-planner',
    source: structuredClone(plan),
  };
  world.facts.push(fact);
  world.nextFact++;
  reservation.plan = retainedPlan;
  scheduleOperationReservationExpiry(world, reservation);
  return result;
}

export function adoptOperationMissionSource(
  world: OperationWorld,
  reservationId: string,
  source: OperationMissionSource,
  publicAcceptance: { receiptId: string; originalBytesBase64: string },
  fitOptions: { marginMs: number; handoffAllowanceMs: number },
): void {
  const reservation = world.reservations?.find((row) => row.id === reservationId);
  const additive = operationAdditiveFlight(world, reservationId);
  if (
    !reservation ||
    reservation.phase !== 'awaiting-release' ||
    (world.config.predeparture?.version !== 'reserve-selected-await-release.1' && !additive) ||
    !holdsWorldOperationAttempt(world, reservation.tenant, reservation.id) ||
    world.attempts.some((attempt) => attempt.id === reservation.id) ||
    world.departureAllocations?.some((row) => !additive || row.reservationId === reservationId) ||
    world.departures?.some((row) => !additive || row.reservationId === reservationId)
  )
    throw new Error('Only the selected unallocated held reservation can adopt a public mission');
  validateOperationMissionSource(reservation.plan);
  validateOperationMissionSource(source);
  function same(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right))
      return left.length === right.length && left.every((value, index) => same(value, right[index]));
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const first = left as Record<string, unknown>;
    const second = right as Record<string, unknown>;
    return (
      Object.keys(first).length === Object.keys(second).length &&
      Object.keys(first).every((key) => Object.hasOwn(second, key) && same(first[key], second[key]))
    );
  }
  if (
    !reservation.plan.routePlanning ||
    reservation.plan.routePlanning.cruiseMetersPerSecond !== world.config.cruiseMetersPerSecond ||
    reservation.plan.routePlanning.ascentMs !== operationPhases.ascentMs ||
    reservation.plan.routePlanning.serviceMs !== operationPhases.dwellMs ||
    reservation.plan.routePlanning.descentMs !== operationPhases.descentMs ||
    !same(source.routePlanning, reservation.plan.routePlanning) ||
    source.sourceMissionId !== reservation.plan.sourceMissionId ||
    source.aircraftId !== reservation.aircraftId ||
    source.sourceRevision <= reservation.plan.sourceRevision ||
    Date.parse(source.occurredAt) > world.now ||
    !same(source.operatingInterval, reservation.plan.operatingInterval) ||
    !same(source.altitude, reservation.plan.altitude) ||
    source.lateralToleranceMeters !== reservation.plan.lateralToleranceMeters ||
    !publicAcceptance.receiptId ||
    !publicAcceptance.originalBytesBase64
  )
    throw new Error(
      'Public mission must preserve the exact held identity, planning constraints and operating interval',
    );
  const aircraft = world.aircraft.find((row) => row.id === reservation.aircraftId);
  const person = operationDepartureResources(world, reservation.id)?.flightPeople.find(
    (row) => row.id === reservation.personId,
  );
  if (
    !aircraft ||
    aircraft.tenant !== reservation.tenant ||
    aircraft.phase !== 'reserved' ||
    aircraft.attemptId !== reservation.id ||
    aircraft.personId !== reservation.personId ||
    aircraft.maintenanceUntil > world.now ||
    !person ||
    person.tenant !== reservation.tenant ||
    person.aircraftId !== aircraft.id
  )
    throw new Error('The held mission no longer owns its aircraft and named flight person');
  const proposed = structuredClone(world);
  proposed.reservations!.find((row) => row.id === reservation.id)!.plan = structuredClone(source);
  const fit = operationReservationFit(proposed, reservation.id, {
    marginMs: Math.max(fitOptions.marginMs, source.routePlanning!.marginMs),
    handoffAllowanceMs: Math.max(fitOptions.handoffAllowanceMs, source.routePlanning!.handoffAllowanceMs),
  });
  if (fit.status !== 'fits') throw new Error(`The public mission does not fit: ${fit.reason}`);
  if (!Number.isSafeInteger(world.nextFact) || world.nextFact < 0 || world.nextFact >= Number.MAX_SAFE_INTEGER)
    throw new Error('Public mission adoption requires a finite fact sequence');
  reservation.plan = structuredClone(source);
  world.facts.push({
    sequence: world.nextFact++,
    kind: 'mission',
    tenant: reservation.tenant,
    at: new Date(world.now).toISOString(),
    attemptId: reservation.id,
    aircraftId: reservation.aircraftId,
    sourceId: 'mission-planner',
    source: structuredClone(source),
    publicAcceptance: { ...publicAcceptance },
  });
  scheduleOperationReservationExpiry(world, reservation);
}

export function predepartureStatus(world: OperationWorld) {
  if (!world.config.predeparture) return {};
  return {
    reserved: world.reservations!.filter((reservation) => reservation.phase === 'awaiting-release').length,
    predeparture: {
      mode: world.config.predeparture.version,
      tenant: world.config.predeparture.tenant,
      ...(world.config.predeparture.version === 'reserve-selected-await-release.1'
        ? { attemptId: world.config.predeparture.attemptId }
        : {}),
      consumer: 'unavailable',
      reservations: world
        .reservations!.filter(
          (reservation) =>
            reservation.phase === 'awaiting-release' ||
            world.config.predeparture?.version === 'reserve-selected-await-release.1',
        )
        .map((reservation) => ({
          attemptId: reservation.id,
          aircraftId: reservation.aircraftId,
          personId: reservation.personId,
          sourceMissionId: reservation.plan.sourceMissionId,
          sourceRevision: reservation.plan.sourceRevision,
          plannedInterval: { ...reservation.plan.operatingInterval },
          phase: reservation.phase,
          planTiming: world.now > Date.parse(reservation.plan.operatingInterval.start) ? 'slipped' : 'scheduled',
          execution: operationReservationFit(world, reservation.id, { marginMs: 10_000, handoffAllowanceMs: 30_000 }),
          reason: reservation.cancellation?.reason ?? 'release_consumer_unavailable',
          ...(reservation.cancellation ? { cancellation: structuredClone(reservation.cancellation) } : {}),
        })),
    },
  };
}
