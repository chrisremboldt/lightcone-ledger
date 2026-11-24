import type { OperationDemand, OperationTenant, OperationWorld } from './operation.js';
import type { OperationResourcePools } from './operation-capacity.js';

export interface OperationOrdinaryFlight {
  version: 'operation.ordinary-flight.1';
  attemptId: string;
  tenant: OperationTenant;
  aircraftId: string;
  registeredAt: string;
  customerInterval: { start: string; end: string };
}

export interface OperationOrdinaryDispatch {
  version: 'accepted-controls.1';
  activatedAt: string;
  planningLeadMs: 300000;
  flights: OperationOrdinaryFlight[];
}

export interface OperationDemoResourcePriority {
  cycleId: string;
  tenant: OperationTenant;
  expiresAt: string;
}

export function claimOperationDemoResources(world: OperationWorld, cycleId: string, tenant: OperationTenant): void {
  const previous = world.demoResourcePriority;
  if (previous && previous.cycleId !== cycleId && Date.parse(previous.expiresAt) > world.now)
    throw new Error('Another demo cycle already has resource priority');
  world.demoResourcePriority = { cycleId, tenant, expiresAt: new Date(world.now + 30_000).toISOString() };
}

export function clearOperationDemoResources(world: OperationWorld, cycleId: string): void {
  if (world.demoResourcePriority?.cycleId !== cycleId) return;
  const tenant = world.demoResourcePriority.tenant;
  delete world.demoResourcePriority;
  world.events.push({ kind: 'dispatch', tenant, at: world.now, sequence: world.nextEvent++ });
  world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}

export function operationAdditiveFlight(
  world: Pick<OperationWorld, 'demoFlights' | 'ordinaryDispatch'>,
  attemptId: string,
): boolean {
  return Boolean(
    world.demoFlights?.some((flight) => flight.attemptId === attemptId) ||
    world.ordinaryDispatch?.flights.some((flight) => flight.attemptId === attemptId),
  );
}

export function operationHeldResources(world: OperationWorld): OperationResourcePools {
  if (world.resources) return world.resources;
  world.demoResources ??= {
    flightPeople: world.people
      .filter((person) => world.aircraft.some((aircraft) => aircraft.personId === person.id))
      .map((person) => ({ id: person.id, tenant: person.tenant, availableAt: world.now })),
    launchPads: (['alpha', 'beta'] as const).map((tenant) => ({
      id: `${world.config.runId}-demo-pad-${tenant}`,
      tenant,
      availableAt: world.pads[tenant],
    })),
    turnaroundCrews: [],
    chargers: [],
    turnaroundQueue: [],
    chargeQueue: [],
  };
  return world.demoResources;
}

export function validateOperationOrdinaryDispatch(world: OperationWorld): void {
  const priority = world.demoResourcePriority;
  if (
    priority &&
    (!['alpha', 'beta'].includes(priority.tenant) ||
      !priority.cycleId ||
      priority.cycleId.length > 100 ||
      /[\u0000-\u0020\u007f]/.test(priority.cycleId) ||
      !Number.isSafeInteger(Date.parse(priority.expiresAt)) ||
      new Date(priority.expiresAt).toISOString() !== priority.expiresAt ||
      Date.parse(priority.expiresAt) > world.now + 30_000)
  )
    throw new Error('Demo resource priority must name a bounded cycle, operator and expiry');
  const dispatch = world.ordinaryDispatch;
  if (!dispatch) return;
  if (
    world.version !== 'operation-world.2' ||
    dispatch.version !== 'accepted-controls.1' ||
    dispatch.planningLeadMs !== 300_000 ||
    !Number.isSafeInteger(Date.parse(dispatch.activatedAt)) ||
    !Array.isArray(dispatch.flights) ||
    dispatch.flights.length > world.aircraft.length ||
    new Set(dispatch.flights.map((row) => row.attemptId)).size !== dispatch.flights.length ||
    new Set(dispatch.flights.map((row) => row.aircraftId)).size !== dispatch.flights.length
  )
    throw new Error('Ordinary dispatch requires bounded, distinct held aircraft registrations');
  for (const flight of dispatch.flights)
    if (
      flight.version !== 'operation.ordinary-flight.1' ||
      !world.aircraft.some((row) => row.id === flight.aircraftId && row.tenant === flight.tenant) ||
      !flight.attemptId ||
      flight.attemptId.length > 200 ||
      !Number.isSafeInteger(Date.parse(flight.registeredAt)) ||
      !Number.isSafeInteger(Date.parse(flight.customerInterval.start)) ||
      !Number.isSafeInteger(Date.parse(flight.customerInterval.end)) ||
      Date.parse(flight.customerInterval.start) >= Date.parse(flight.customerInterval.end)
    )
      throw new Error('Ordinary flight registration changed its physical identity or customer promise');
}

export function activateOperationOrdinaryDispatch(world: OperationWorld): void {
  if (world.ordinaryDispatch) {
    validateOperationOrdinaryDispatch(world);
    return;
  }
  if (world.version !== 'operation-world.2' || !Number.isSafeInteger(world.now))
    throw new Error('Ordinary control-aware dispatch requires a retained v2 operation clock');
  world.ordinaryDispatch = {
    version: 'accepted-controls.1',
    activatedAt: new Date(world.now).toISOString(),
    planningLeadMs: 300_000,
    flights: [],
  };
  operationHeldResources(world);
  for (const tenant of ['alpha', 'beta'] as const)
    world.events.push({ kind: 'dispatch', tenant, at: world.now, sequence: world.nextEvent++ });
  world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}

export function ordinaryPlanningAt(world: OperationWorld, demand: OperationDemand): number {
  const requested = Date.parse(demand.window?.start ?? '');
  return world.ordinaryDispatch && Number.isFinite(requested)
    ? Math.max(Date.parse(demand.requestedAt), requested - world.ordinaryDispatch.planningLeadMs)
    : requested;
}

export function registerOperationOrdinaryFlight(
  world: OperationWorld,
  demand: OperationDemand,
  aircraftId: string,
): OperationOrdinaryFlight {
  validateOperationOrdinaryDispatch(world);
  const dispatch = world.ordinaryDispatch;
  const aircraft = world.aircraft.find((row) => row.id === aircraftId && row.tenant === demand.tenant);
  if (
    !dispatch ||
    !demand.window ||
    demand.attemptId ||
    demand.cancellation ||
    ordinaryPlanningAt(world, demand) > world.now ||
    !aircraft ||
    aircraft.phase !== 'ready' ||
    aircraft.maintenanceUntil > world.now ||
    dispatch.flights.some((row) => row.aircraftId === aircraftId)
  )
    throw new Error('Ordinary planning needs an eligible original request and an idle owned aircraft');
  const flight: OperationOrdinaryFlight = {
    version: 'operation.ordinary-flight.1',
    attemptId: `${demand.intentId}:attempt:1`,
    tenant: demand.tenant,
    aircraftId,
    registeredAt: new Date(world.now).toISOString(),
    customerInterval: { ...demand.window },
  };
  dispatch.flights.push(flight);
  return structuredClone(flight);
}

export function retireOperationOrdinaryFlight(world: OperationWorld, attemptId: string): void {
  const flight = world.ordinaryDispatch?.flights.find((row) => row.attemptId === attemptId);
  if (!flight) throw new Error('Ordinary archival requires an exact registered flight');
  if (
    world.attempts.some((row) => row.id === attemptId && row.phase === 'flying') ||
    world.events.some((event) => 'attemptId' in event && event.attemptId === attemptId) ||
    world.reservations?.some((row) => row.id === attemptId && row.phase !== 'cancelled')
  )
    throw new Error('An active ordinary reservation or airborne attempt cannot be retired');
  world.ordinaryDispatch!.flights = world.ordinaryDispatch!.flights.filter((row) => row.attemptId !== attemptId);
  world.events.push({ kind: 'dispatch', tenant: flight.tenant, at: world.now, sequence: world.nextEvent++ });
  world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}
