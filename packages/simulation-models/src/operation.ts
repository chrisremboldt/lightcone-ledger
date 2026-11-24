import { entityRandom, type PartnerOrder } from './index.js';
import { places, yards, type Coordinate } from './places.js';
import {
  availableResource,
  createOperationResources,
  occupyResource,
  releaseResource,
  validateOperationCapacity,
  type OperationCapacity,
  type OperationResourcePools,
} from './operation-capacity.js';
import {
  commandLinkLossAt,
  createCommandLinkEpisode,
  operationPhases,
  type CommandLinkEpisode,
  type CommandLinkHold,
} from './operation-command-link.js';
import { operationMissionSource, type OperationMissionSource } from './operation-mission.js';
import { createOperationReservation, predepartureStatus, type OperationReservation } from './operation-predeparture.js';
import {
  holdsOperationAttempt,
  holdsWorldOperationAttempt,
  validateOperationPredeparture,
  type OperationPredeparture,
} from './operation-predeparture-selection.js';
import { operationRoutePoint, type OperationRouteTimeline } from './operation-route-timeline.js';
import type { OperationDepartureAllocation, OperationDepartureCommit } from './operation-departure.js';
import { cancelUnreachableReservation, scheduleOperationReservationExpiry } from './operation-reservation-expiry.js';
import { ordinaryWorkStatus, scheduleOrdinaryIncident, type OrdinaryWorkState } from './operation-ordinary-work.js';
import {
  operationAdditiveFlight,
  operationHeldResources,
  ordinaryPlanningAt,
  registerOperationOrdinaryFlight,
  validateOperationOrdinaryDispatch,
  type OperationOrdinaryDispatch,
  type OperationDemoResourcePriority,
} from './operation-ordinary-dispatch.js';
import {
  initializeOperationSimulatedLink,
  transitionOperationSimulatedLink,
  validateOperationSimulatedLink,
  type OperationSimulatedLink,
  type OperationSimulatedLinkConfig,
} from './operation-simulated-link.js';

export { capacityStatus, operationCapacityPreset } from './operation-capacity.js';
export type { OperationCapacity, OperationResourcePools, OperationResourceSlot } from './operation-capacity.js';
export { commandLinkEpisodeStatus } from './operation-command-link.js';
export type { CommandLinkEpisode, CommandLinkHold } from './operation-command-link.js';
export * from './operation-monitoring.js';
export * from './operation-ordinary-work.js';
export * from './operation-ordinary-dispatch.js';
export { operationCommandLinkReading } from './operation-simulated-link.js';
export type {
  OperationCommandLinkReading,
  OperationSimulatedLink,
  OperationSimulatedLinkConfig,
  OperationSimulatedLinkState,
} from './operation-simulated-link.js';
export { operationMissionSource } from './operation-mission.js';
export type { OperationMissionSource } from './operation-mission.js';
export { reviseOperationReservation, adoptOperationMissionSource } from './operation-predeparture.js';
export { validateOperationMissionSource } from './operation-mission-validation.js';
export {
  holdsOperationAttempt,
  holdsWorldOperationAttempt,
  operationDepartureResources,
  validateOperationPredeparture,
} from './operation-predeparture-selection.js';
export type {
  OperationPredeparture,
  OperationReservation,
  OperationReservationChange,
} from './operation-predeparture.js';
export { buildOperationRouteTimeline, operationRoutePoint } from './operation-route-timeline.js';
export type {
  OperationRoutePhase,
  OperationRouteTimeline,
  OperationRouteTimelineResult,
  OperationRoutePause,
  OperationRoutePoint,
} from './operation-route-timeline.js';
export { operationReservationFit } from './operation-route-fit.js';
export type { OperationReservationFitOptions, OperationReservationFit } from './operation-route-fit.js';
export { operationRouteCommandLinkLossAt } from './operation-route-command-link.js';
export { allocateOperationDeparture, consumeOperationDeparture } from './operation-departure.js';
export type {
  OperationDepartureReference,
  OperationDepartureMissionReference,
  OperationDepartureRequest,
  OperationDeparturePermit,
  OperationDepartureFitWitness,
  OperationDepartureAllocationInput,
  OperationDepartureAllocation,
  OperationDepartureConsumeInput,
  OperationDepartureCurrentControls,
  OperationDepartureCommit,
} from './operation-departure.js';

export * from './operation-demo-flight.js';
import type { OperationDemoFlight } from './operation-demo-flight.js';

export type OperationTenant = 'alpha' | 'beta';
export interface OperationConfig {
  runId: string;
  seed: number;
  start: string;
  fleet: Record<OperationTenant, number>;
  demandIntervalMs: number;
  sampleIntervalMs: number;
  cruiseMetersPerSecond: number;
  turnaroundMs: number;
  chargeMs: number;
  incident: 'none' | 'landing-disagreement';
  profile?: 'telemetry-delivery-interruption';
  capacity?: OperationCapacity;
  commandLinkEpisode?: 'canal-market-relay.1';
  missionPlan?: 'dispatch-plan.1';
  predeparture?: OperationPredeparture;
  selectedDemandWindow?: { attemptId: string; start: string; end: string };
  simulatedLink?: OperationSimulatedLinkConfig;
}
export interface OperationAircraft {
  id: string;
  tenant: OperationTenant;
  personId: string;
  phase: 'ready' | 'reserved' | 'flying' | 'turnaround' | 'charging' | 'waiting-turnaround' | 'waiting-charge';
  availableAt: number;
  maintenanceUntil: number;
  attemptId?: string;
}
export interface OperationPerson {
  id: string;
  tenant: OperationTenant;
  name: string;
}
export interface OperationDemand {
  id: string;
  intentId: string;
  tenant: OperationTenant;
  requestedAt: string;
  siteId: string;
  label: string;
  window?: { start: string; end: string };
  cancellation?: PartnerOrder['cancellation'];
  attemptId?: string;
}
export interface OperationAttempt {
  id: string;
  intentId: string;
  demandId: string;
  tenant: OperationTenant;
  aircraftId: string;
  personId: string;
  sourceSessionId: string;
  siteId: string;
  origin: Coordinate;
  destination: Coordinate;
  departure: string;
  landing: string;
  travelMs: number;
  phase: 'flying' | 'landed';
  commandLinkHold?: CommandLinkHold;
  simulatedLink?: OperationSimulatedLink;
  routeTimeline?: OperationRouteTimeline;
  ordinaryIncident?:
    { kind: 'command-link'; incidentId: string; lostAt: string; restoredAt: string } | { kind: 'landing-disagreement' };
}
export interface TelemetryDeliveryInterruption {
  id: string;
  aircraftId: string;
  attemptId: string;
  sourceSessionId: string;
  startsAt: string;
  endsAt: string;
}
interface FactIdentity {
  sequence: number;
  tenant: OperationTenant;
  at: string;
  attemptId: string;
  sourceSessionId: string;
}
interface FlightFactIdentity extends FactIdentity {
  aircraftId: string;
}
export type WorldFact =
  | (FactIdentity & { kind: 'order'; aircraftId?: string; order: PartnerOrder })
  | (Omit<FlightFactIdentity, 'sourceSessionId'> & {
      kind: 'mission';
      sourceId: 'mission-planner';
      source: OperationMissionSource;
      publicAcceptance?: { receiptId: string; originalBytesBase64: string };
    })
  | (FlightFactIdentity &
      (
        | {
            kind: 'position';
            point: Coordinate & { occurredAt: string; height: number; horizontalSpeed: number };
          }
        | { kind: 'departure' | 'landing'; personId: string; personName: string }
        | {
            kind: 'cancellation';
            personId: string;
            personName: string;
            reason: 'requested_window_unreachable';
            note: string;
          }
        | {
            kind: 'command-link';
            sourceId: 'command-link';
            sourceEventId: string;
            incidentId: string;
            status: 'lost' | 'restored';
            position: { longitude: number; latitude: number };
          }
        | {
            kind: 'landing-report';
            sourceId: string;
            reportAt: string;
            reportedLandingAt: string;
            incidentId: string;
            incidentCause: 'handset-clock-offset';
            personId: string;
            personName: string;
          }
      ));
type ScheduledEvent = {
  at: number;
  sequence: number;
} & (
  | { kind: 'demand'; index: number; tenant?: OperationTenant }
  | { kind: 'dispatch'; tenant: OperationTenant }
  | { kind: 'demand-expiry'; demandId: string }
  | { kind: 'reservation-expiry'; attemptId: string }
  | { kind: 'position' | 'landing' | 'landing-report'; attemptId: string }
  | { kind: 'command-link-lost' | 'command-link-restored'; attemptId: string }
  | { kind: 'ordinary-command-link-lost' | 'ordinary-command-link-restored'; attemptId: string }
  | { kind: 'charging' | 'ready'; aircraftId: string }
  | { kind: 'turnaround-complete' | 'charge-complete'; aircraftId: string }
);
type NewEvent = ScheduledEvent extends infer Event
  ? Event extends ScheduledEvent
    ? Omit<Event, 'sequence'>
    : never
  : never;
export interface OperationWorld {
  version: 'operation-world.1' | 'operation-world.2';
  config: OperationConfig;
  now: number;
  nextEvent: number;
  nextFact: number;
  counters: { demand: number; attempts: number; landed: number; cancelled: number };
  events: ScheduledEvent[];
  aircraft: OperationAircraft[];
  people: OperationPerson[];
  sites: Array<{ id: string; name: string; coordinate: Coordinate }>;
  demand: OperationDemand[];
  attempts: OperationAttempt[];
  reservations?: OperationReservation[];
  demoFlights?: OperationDemoFlight[];
  departureAllocations?: OperationDepartureAllocation[];
  departures?: OperationDepartureCommit[];
  facts: WorldFact[];
  pads: Record<OperationTenant, number>;
  chargers: Record<OperationTenant, number>;
  telemetryDeliveryInterruption?: TelemetryDeliveryInterruption;
  resources?: OperationResourcePools;
  demoResources?: OperationResourcePools;
  commandLinkEpisode?: CommandLinkEpisode;
  ordinaryWork?: OrdinaryWorkState;
  ordinaryDispatch?: OperationOrdinaryDispatch;
  demoResourcePriority?: OperationDemoResourcePriority;
}
export interface OperationArchive {
  facts: WorldFact[];
  demand: OperationDemand[];
  attempts: OperationAttempt[];
}
type PreviousOperationWorld = Omit<OperationWorld, 'nextFact' | 'counters'> &
  Partial<Pick<OperationWorld, 'nextFact' | 'counters'>>;

export function upgradeOperationWorld(world: PreviousOperationWorld): OperationWorld {
  validateOperationOrdinaryDispatch(world as OperationWorld);
  const selected = world.config.predeparture;
  if (selected?.version === 'reserve-selected-await-release.1') {
    validateOperationPredeparture(world.config);
    if (
      !world.resources ||
      !Array.isArray(world.reservations) ||
      world.reservations.filter((reservation) => !operationAdditiveFlight(world as OperationWorld, reservation.id))
        .length > 1 ||
      world.reservations.some(
        (reservation) =>
          !reservation ||
          !holdsWorldOperationAttempt(world, reservation.tenant, reservation.id) ||
          !['awaiting-release', 'cancelled'].includes(reservation.phase) ||
          (reservation.phase === 'cancelled' &&
            (reservation.cancellation?.reason !== 'requested_window_unreachable' ||
              !reservation.cancellation.note ||
              !Number.isFinite(Date.parse(reservation.cancellation.decidedAt)) ||
              !reservation.cancellation.dispatcher?.id ||
              !reservation.cancellation.dispatcher.name ||
              world.departures?.some((commit) => commit.reservationId === reservation.id))) ||
          world.attempts.some((attempt) => attempt.id === reservation.id),
      ) ||
      world.attempts.some(
        (attempt) =>
          attempt.id === selected.attemptId &&
          (!holdsWorldOperationAttempt(world, attempt.tenant, attempt.id) ||
            !world.departures?.some(
              (commit) => commit.attemptId === attempt.id && commit.reservationId === attempt.id,
            )),
      )
    )
      throw new Error('Selected predeparture world must retain only its held reservation or exact departure');
  }
  world.nextFact ??= world.facts.reduce((next, fact) => Math.max(next, fact.sequence + 1), 0);
  world.counters ??= {
    demand: world.demand.length,
    attempts: world.attempts.length,
    landed: world.attempts.filter((attempt) => attempt.phase === 'landed').length,
    cancelled: world.demand.filter((demand) => demand.cancellation).length,
  };
  world.counters.cancelled ??= 0;
  return world as OperationWorld;
}

export function compactOperation(world: OperationWorld, retainedReservationId?: string): OperationArchive {
  upgradeOperationWorld(world);
  const scheduledAttempts = new Set(world.events.flatMap((event) => ('attemptId' in event ? [event.attemptId] : [])));
  const archived: OperationArchive = {
    facts: world.facts,
    demand: world.demand.filter((demand) => demand.attemptId || demand.cancellation),
    attempts: world.attempts.filter((attempt) => attempt.phase === 'landed' && !scheduledAttempts.has(attempt.id)),
  };
  const archivedAttempts = new Set(archived.attempts.map((attempt) => attempt.id));
  world.facts = [];
  world.demand = world.demand.filter((demand) => !demand.attemptId && !demand.cancellation);
  world.attempts = world.attempts.filter((attempt) => !archivedAttempts.has(attempt.id));
  if (world.config.predeparture?.version !== 'reserve-selected-await-release.1' && world.reservations)
    world.reservations = world.reservations.filter(
      (reservation) =>
        reservation.phase !== 'cancelled' ||
        reservation.id === retainedReservationId ||
        operationAdditiveFlight(world, reservation.id),
    );
  return archived;
}

export function assertOperationDemandWindows(world: OperationWorld): void {
  if (
    world.version === 'operation-world.2' &&
    world.demand.some(
      (demand) =>
        !demand.attemptId &&
        !demand.cancellation &&
        (!demand.window ||
          !Number.isFinite(Date.parse(demand.window.start)) ||
          Date.parse(demand.window.start) < Date.parse(demand.requestedAt) ||
          !Number.isFinite(Date.parse(demand.window.end)) ||
          Date.parse(demand.window.end) <= Date.parse(demand.window.start)),
    )
  )
    throw new Error('Queued demand needs its original finite window; start a fresh world');
}
const tenants = ['alpha', 'beta'] as const;
const names = {
  alpha: ['Maya Chen', 'Luis Ortega', 'Nia Brooks', 'Owen Patel', 'Amara Reed'],
  beta: ['Iris Morgan', 'Theo Reyes', 'Samira Ali', 'Jonah Park', 'Elena Cruz'],
};
const destinations = {
  alpha: ['Oakview', 'Mercy North', 'Eastside Clinic', 'Canal Market', 'Ridge Pharmacy', 'Westfield Lab'],
  beta: ['Feeder 12', 'Hilltop', 'Mile 41', 'Array C', 'Elm Park', 'Grid 3', 'Route 9'],
};
const iso = (time: number) => new Date(time).toISOString();
const { ascentMs, dwellMs, descentMs } = operationPhases;

function schedule(world: OperationWorld, event: NewEvent): void {
  if (
    event.kind === 'dispatch' &&
    world.events.some((row) => row.kind === 'dispatch' && row.tenant === event.tenant && row.at === event.at)
  )
    return;
  world.events.push({ ...event, sequence: world.nextEvent++ });
  world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}

export function createOperation(
  config: Partial<OperationConfig> & Pick<OperationConfig, 'runId' | 'start'>,
): OperationWorld {
  let resolved: OperationConfig = {
    seed: 71031,
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 30_000,
    sampleIntervalMs: 10_000,
    cruiseMetersPerSecond: 12,
    turnaroundMs: 60_000,
    chargeMs: 120_000,
    incident: 'none',
    ...config,
  };
  if (!/^[A-Za-z0-9-]{1,40}$/.test(resolved.runId) || !Number.isSafeInteger(resolved.seed))
    throw new Error('World requires a short stable run identity and integer seed');
  validateOperationSimulatedLink(resolved);
  if (resolved.simulatedLink) resolved.simulatedLink = structuredClone(resolved.simulatedLink);
  if (!['none', 'landing-disagreement'].includes(resolved.incident)) throw new Error('Unknown world incident');
  if (resolved.profile !== undefined && resolved.profile !== 'telemetry-delivery-interruption')
    throw new Error('Unknown world profile');
  if (resolved.missionPlan !== undefined && resolved.missionPlan !== 'dispatch-plan.1')
    throw new Error('Unknown mission plan profile');
  if (resolved.capacity) validateOperationCapacity(resolved.capacity);
  validateOperationPredeparture(resolved);
  if (resolved.predeparture?.version === 'reserve-selected-await-release.1') resolved = structuredClone(resolved);
  if (resolved.commandLinkEpisode !== undefined) {
    if (resolved.commandLinkEpisode !== 'canal-market-relay.1') throw new Error('Unknown command-link episode');
    if (!resolved.capacity) throw new Error('A command-link episode requires finite operation capacity');
  }
  const start = Date.parse(resolved.start);
  if (!Number.isFinite(start)) throw new Error('World start must be a UTC timestamp');
  resolved.start = iso(start);
  if (resolved.selectedDemandWindow) {
    const window = resolved.selectedDemandWindow;
    if (
      Object.keys(window).sort().join(',') !== 'attemptId,end,start' ||
      !holdsOperationAttempt(resolved, 'alpha', window.attemptId) ||
      !Number.isSafeInteger(Date.parse(window.start)) ||
      !Number.isSafeInteger(Date.parse(window.end)) ||
      !window.start.endsWith('Z') ||
      !window.end.endsWith('Z') ||
      Date.parse(window.start) < start ||
      Date.parse(window.end) <= Date.parse(window.start)
    )
      throw new Error('A selected demand window requires one held Alpha request and a finite future UTC interval');
    resolved.selectedDemandWindow = structuredClone(window);
  }
  for (const tenant of tenants)
    if (!Number.isSafeInteger(resolved.fleet[tenant]) || resolved.fleet[tenant] < 1 || resolved.fleet[tenant] > 25)
      throw new Error('World fleet must contain 1–25 aircraft per operator');
  for (const field of ['demandIntervalMs', 'sampleIntervalMs', 'turnaroundMs', 'chargeMs'] as const)
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] < 1000)
      throw new Error(`World ${field} must be at least one second`);
  if (
    !Number.isFinite(resolved.cruiseMetersPerSecond) ||
    resolved.cruiseMetersPerSecond < 1 ||
    resolved.cruiseMetersPerSecond > 25
  )
    throw new Error('World cruise speed must be 1–25 m/s');
  const world: OperationWorld = {
    version: 'operation-world.2',
    config: resolved,
    now: start,
    nextEvent: 0,
    nextFact: 0,
    counters: { demand: 0, attempts: 0, landed: 0, cancelled: 0 },
    events: [],
    aircraft: [],
    people: [],
    sites: Object.entries(places).map(([name, coordinate]) => ({
      id: `${resolved.runId}-site-${name.toLowerCase().replaceAll(' ', '-')}`,
      name,
      coordinate: { ...coordinate },
    })),
    demand: [],
    attempts: [],
    facts: [],
    pads: { alpha: start, beta: start },
    chargers: { alpha: start, beta: start },
  };
  if (resolved.capacity) world.resources = createOperationResources(resolved, start);
  if (resolved.predeparture) world.reservations = [];
  if (resolved.commandLinkEpisode) world.commandLinkEpisode = createCommandLinkEpisode(resolved, start);
  for (const tenant of tenants) {
    const flightPeople = resolved.capacity?.flightPeople[tenant] ?? resolved.fleet[tenant];
    for (let index = 0; index < flightPeople; index++) {
      const suffix = `${tenant}-${String(index + 1).padStart(2, '0')}`;
      const personId = `${resolved.runId}-person-${suffix}`;
      world.people.push({
        id: personId,
        tenant,
        name: `${names[tenant][index % names[tenant].length]}${index >= names[tenant].length ? ` ${Math.floor(index / names[tenant].length) + 1}` : ''}`,
      });
    }
    for (let index = 0; index < resolved.fleet[tenant]; index++) {
      const suffix = `${tenant}-${String(index + 1).padStart(2, '0')}`;
      world.aircraft.push({
        id: `DJI-${resolved.runId}-${suffix}`,
        tenant,
        personId: `${resolved.runId}-person-${tenant}-${String((index % flightPeople) + 1).padStart(2, '0')}`,
        phase: 'ready',
        availableAt: start,
        maintenanceUntil: start,
      });
    }
    for (const slot of world.resources?.turnaroundCrews.filter((slot) => slot.tenant === tenant) ?? []) {
      world.people.push({
        id: slot.id,
        tenant,
        name: `${tenant === 'alpha' ? 'Alpha' : 'Beta'} ground crew ${world.people.filter((person) => person.tenant === tenant).length - flightPeople + 1}`,
      });
    }
  }
  if (resolved.incident === 'landing-disagreement')
    world.people.push({ id: `${resolved.runId}-person-alpha-ground`, tenant: 'alpha', name: 'Avery Collins' });
  if (resolved.capacity) {
    for (const tenant of tenants) schedule(world, { kind: 'demand', at: start, index: 0, tenant });
  } else schedule(world, { kind: 'demand', at: start, index: 0 });
  return world;
}

type NewFact = WorldFact extends infer Fact ? (Fact extends WorldFact ? Omit<Fact, 'sequence'> : never) : never;
function record(world: OperationWorld, fact: NewFact): void {
  world.facts.push({ ...fact, sequence: world.nextFact++ });
}
function identity(attempt: OperationAttempt, at: number): Omit<FlightFactIdentity, 'sequence'> {
  return {
    tenant: attempt.tenant,
    at: iso(at),
    attemptId: attempt.id,
    aircraftId: attempt.aircraftId,
    sourceSessionId: attempt.sourceSessionId,
  };
}
function routeDistance(origin: Coordinate, destination: Coordinate): number {
  return (
    Math.hypot(
      destination.latitude - origin.latitude,
      (destination.longitude - origin.longitude) * Math.cos(((origin.latitude + destination.latitude) * Math.PI) / 360),
    ) * 111_320
  );
}

export function operationPoint(
  attempt: OperationAttempt,
  at: number,
): Coordinate & { occurredAt: string; height: number; horizontalSpeed: number } {
  const hold = attempt.commandLinkHold;
  if (attempt.routeTimeline) {
    const point = operationRoutePoint(
      attempt.routeTimeline,
      at - Date.parse(attempt.departure),
      hold
        ? { startsAtMs: Date.parse(hold.lostAt) - Date.parse(attempt.departure), durationMs: hold.holdMs }
        : undefined,
    );
    const duration = attempt.routeTimeline.durationMs;
    return {
      occurredAt: iso(at),
      latitude: point.latitude,
      longitude: point.longitude,
      height:
        200 +
        40 * Math.max(0, Math.min(1, point.motionElapsedMs / ascentMs, (duration - point.motionElapsedMs) / descentMs)),
      horizontalSpeed: point.horizontalSpeed,
    };
  }
  const heldElapsed = hold ? Math.max(0, Math.min(at - Date.parse(hold.lostAt), hold.holdMs)) : 0;
  const elapsed = at - Date.parse(attempt.departure) - heldElapsed;
  const returnAt = ascentMs + attempt.travelMs + dwellMs;
  const outbound = Math.max(0, Math.min(1, (elapsed - ascentMs) / attempt.travelMs));
  const inbound = Math.max(0, Math.min(1, (elapsed - returnAt) / attempt.travelMs));
  const fraction = outbound - inbound;
  const cruising = (elapsed >= ascentMs && outbound < 1) || (elapsed >= returnAt && inbound < 1);
  const duration = Date.parse(hold?.nominalLanding ?? attempt.landing) - Date.parse(attempt.departure);
  const held = hold && at >= Date.parse(hold.lostAt) && at < Date.parse(hold.restoredAt);
  return {
    occurredAt: iso(at),
    latitude: attempt.origin.latitude + (attempt.destination.latitude - attempt.origin.latitude) * fraction,
    longitude: attempt.origin.longitude + (attempt.destination.longitude - attempt.origin.longitude) * fraction,
    height: 200 + 40 * Math.max(0, Math.min(1, elapsed / ascentMs, (duration - elapsed) / descentMs)),
    horizontalSpeed:
      !held && cruising ? routeDistance(attempt.origin, attempt.destination) / (attempt.travelMs / 1000) : 0,
  };
}

function demandFlight(world: OperationWorld, tenant: OperationTenant, siteId: string) {
  const site = world.sites.find((row) => row.id === siteId)!;
  const origin = yards[`tenant-${tenant}`]!;
  const travelMs = Math.ceil((routeDistance(origin, site.coordinate) / world.config.cruiseMetersPerSecond) * 1000);
  return { site, origin, travelMs, duration: ascentMs + travelMs * 2 + dwellMs + descentMs };
}

function cancelUnreachableDemand(world: OperationWorld, tenant: OperationTenant): void {
  if (world.version !== 'operation-world.2') return;
  for (const demand of world.demand) {
    if (demand.tenant !== tenant || demand.attemptId || demand.cancellation) continue;
    if (!demand.window) throw new Error('Queued demand needs its original finite window; start a fresh world');
    const { duration } = demandFlight(world, tenant, demand.siteId);
    const earliestDeparture = Math.max(world.now, Date.parse(demand.window.start));
    if (earliestDeparture + duration <= Date.parse(demand.window.end)) continue;
    const at = iso(world.now);
    demand.cancellation = {
      reason: 'requested_window_unreachable',
      note: `No aircraft can complete this ${tenant === 'alpha' ? 'medical delivery' : 'inspection'} within its requested window. Cancelled by dispatch; request a new delivery window if the work is still needed.`,
      decidedAt: at,
      dispatcher: {
        id: `${world.config.runId}-dispatcher-${tenant}`,
        name: tenant === 'alpha' ? 'Alpha dispatch' : 'Beta dispatch',
      },
    };
    world.counters.cancelled++;
    record(world, {
      kind: 'order',
      tenant,
      at,
      attemptId: `${demand.intentId}:attempt:1`,
      sourceSessionId: `${demand.intentId}-capture-1`,
      order: {
        order_id: demand.id,
        version: 2,
        updated_at: at,
        state: 'cancelled',
        schedule: { ...demand.window },
        requested_work: { name: demand.label },
        cancellation: structuredClone(demand.cancellation),
        flights: [],
      },
    });
  }
}

function dispatch(world: OperationWorld, tenant: OperationTenant): void {
  cancelUnreachableDemand(world, tenant);
  const priority = world.demoResourcePriority;
  if (priority?.tenant === tenant) {
    if (Date.parse(priority.expiresAt) > world.now) {
      schedule(world, { kind: 'dispatch', tenant, at: Date.parse(priority.expiresAt) });
      return;
    }
    delete world.demoResourcePriority;
  }
  const queued = world.demand.filter((row) => row.tenant === tenant && !row.attemptId && !row.cancellation);
  const demand = queued.find(
    (row) =>
      !row.window ||
      ordinaryPlanningAt(world, row) <= world.now ||
      holdsWorldOperationAttempt(world, tenant, `${row.intentId}:attempt:1`),
  );
  const nextStart = Math.min(...queued.map((row) => ordinaryPlanningAt(world, row)).filter((at) => at > world.now));
  if (Number.isFinite(nextStart)) schedule(world, { kind: 'dispatch', tenant, at: nextStart });
  if (!demand) return;
  const attemptId = `${demand.intentId}:attempt:1`;
  const aircraft = world.aircraft.find(
    (row) =>
      row.tenant === tenant &&
      row.phase === 'ready' &&
      row.maintenanceUntil <= world.now &&
      !world.ordinaryDispatch?.flights.some((flight) => flight.aircraftId === row.id),
  );
  const ordinary = Boolean(world.ordinaryDispatch);
  const privatePools = ordinary && !world.resources ? operationHeldResources(world) : undefined;
  const flightPerson = world.resources
    ? availableResource(world, 'flightPeople', tenant)
    : privatePools?.flightPeople.find(
        (row) => row.id === aircraft?.personId && !row.aircraftId && row.availableAt <= world.now,
      );
  const predeparture = ordinary || holdsWorldOperationAttempt(world, tenant, attemptId);
  const launchPad = world.resources && !predeparture ? availableResource(world, 'launchPads', tenant) : undefined;
  if (world.resources && (!aircraft || !flightPerson || (!predeparture && !launchPad))) {
    const next = Math.min(
      ...[...world.resources.flightPeople, ...(predeparture ? [] : world.resources.launchPads)]
        .filter((slot) => slot.tenant === tenant && slot.availableAt > world.now)
        .map((slot) => slot.availableAt),
      ...world.aircraft
        .filter((row) => row.tenant === tenant && row.phase === 'ready' && row.maintenanceUntil > world.now)
        .map((row) => row.maintenanceUntil),
    );
    if (Number.isFinite(next)) schedule(world, { kind: 'dispatch', tenant, at: next });
    return;
  }
  if (
    !world.resources &&
    (!aircraft || (ordinary && !flightPerson) || (!predeparture && world.pads[tenant] > world.now))
  ) {
    const next = Math.max(
      world.pads[tenant],
      Math.min(
        ...world.aircraft
          .filter((row) => row.tenant === tenant)
          .map((row) => Math.max(row.availableAt, row.maintenanceUntil)),
      ),
    );
    if (next > world.now) schedule(world, { kind: 'dispatch', tenant, at: next });
    return;
  }
  if (!aircraft) return;
  const { site, origin, travelMs, duration } = demandFlight(world, tenant, demand.siteId);
  if (predeparture) {
    if (ordinary) registerOperationOrdinaryFlight(world, demand, aircraft.id);
    const reservation = createOperationReservation(
      {
        id: attemptId,
        intentId: demand.intentId,
        demandId: demand.id,
        tenant,
        aircraftId: aircraft.id,
        personId: flightPerson!.id,
        sourceSessionId: `${demand.intentId}-capture-1`,
        siteId: site.id,
        origin: { latitude: origin.latitude, longitude: origin.longitude },
        destination: { ...site.coordinate },
        travelMs,
      },
      demand,
      world.now,
      duration,
      {
        cruiseMetersPerSecond: world.config.cruiseMetersPerSecond,
        holdAllowanceMs: world.config.commandLinkEpisode === 'canal-market-relay.1' ? 30_000 : 0,
      },
    );
    if (ordinary) reservation.plan.operatingInterval = { ...demand.window! };
    demand.attemptId = reservation.id;
    (world.reservations ??= []).push(reservation);
    aircraft.phase = 'reserved';
    aircraft.attemptId = reservation.id;
    aircraft.personId = reservation.personId;
    aircraft.availableAt = world.now;
    occupyResource(flightPerson!, aircraft.id, world.now);
    const common = {
      tenant,
      at: reservation.reservedAt,
      attemptId: reservation.id,
      aircraftId: aircraft.id,
      sourceSessionId: reservation.sourceSessionId,
    };
    record(world, { ...common, kind: 'order', order: structuredClone(reservation.order) });
    record(world, {
      kind: 'mission',
      tenant,
      at: reservation.reservedAt,
      attemptId: reservation.id,
      aircraftId: aircraft.id,
      sourceId: 'mission-planner',
      source: structuredClone(reservation.plan),
    });
    scheduleOperationReservationExpiry(world, reservation);
    schedule(world, { kind: 'dispatch', tenant, at: world.now });
    return;
  }
  const attempt: OperationAttempt = {
    id: attemptId,
    intentId: demand.intentId,
    demandId: demand.id,
    tenant,
    aircraftId: aircraft.id,
    personId: flightPerson?.id ?? aircraft.personId,
    sourceSessionId: `${demand.intentId}-capture-1`,
    siteId: site.id,
    origin: { latitude: origin.latitude, longitude: origin.longitude },
    destination: { ...site.coordinate },
    departure: iso(world.now),
    landing: iso(world.now + duration),
    travelMs,
    phase: 'flying',
  };
  initializeOperationSimulatedLink(world, attempt);
  demand.attemptId = attempt.id;
  world.attempts.push(attempt);
  world.counters.attempts++;
  if (
    world.version === 'operation-world.2' &&
    world.config.profile === 'telemetry-delivery-interruption' &&
    demand.intentId === `intent-${world.config.runId}-alpha-0`
  )
    world.telemetryDeliveryInterruption ??= {
      id: `${attempt.id}:telemetry-delivery-interruption`,
      aircraftId: attempt.aircraftId,
      attemptId: attempt.id,
      sourceSessionId: attempt.sourceSessionId,
      startsAt: iso(world.now + 60_000),
      endsAt: iso(world.now + 150_000),
    };
  aircraft.phase = 'flying';
  aircraft.attemptId = attempt.id;
  aircraft.personId = attempt.personId;
  let chargeAt: number | undefined;
  if (world.resources) {
    aircraft.availableAt = Date.parse(attempt.landing);
    occupyResource(flightPerson!, aircraft.id, aircraft.availableAt);
    occupyResource(launchPad!, aircraft.id, world.now + 10_000);
  } else {
    chargeAt = Math.max(world.now + duration + world.config.turnaroundMs, world.chargers[tenant]);
    aircraft.availableAt = chargeAt + world.config.chargeMs;
    world.chargers[tenant] = aircraft.availableAt;
    world.pads[tenant] = world.now + 10_000;
  }
  const ordinaryIncident = scheduleOrdinaryIncident(world, attempt);
  const common = identity(attempt, world.now);
  record(world, {
    ...common,
    kind: 'order',
    order: {
      order_id: demand.id,
      version: world.version === 'operation-world.2' ? 2 : 1,
      updated_at: world.version === 'operation-world.2' ? attempt.departure : demand.requestedAt,
      state: 'accepted',
      schedule: demand.window ? { ...demand.window } : { start: attempt.departure, end: attempt.landing },
      requested_work: { name: demand.label },
      flights: [{ flight_intent_id: demand.intentId, attempt: 1, order_refs: [demand.id], aircraft_id: aircraft.id }],
    },
  });
  if (world.config.missionPlan === 'dispatch-plan.1')
    record(world, {
      kind: 'mission',
      tenant: attempt.tenant,
      at: attempt.departure,
      attemptId: attempt.id,
      aircraftId: attempt.aircraftId,
      sourceId: 'mission-planner',
      source: operationMissionSource(attempt),
    });
  const person = world.people.find((row) => row.id === attempt.personId)!;
  record(world, { ...common, kind: 'departure', personId: person.id, personName: person.name });
  if (world.commandLinkEpisode) {
    const lossAt = commandLinkLossAt(attempt, world.commandLinkEpisode);
    if (lossAt !== undefined) {
      schedule(world, { kind: 'command-link-lost', at: lossAt, attemptId: attempt.id });
      schedule(world, {
        kind: 'command-link-restored',
        at: Date.parse(world.commandLinkEpisode.endsAt),
        attemptId: attempt.id,
      });
    }
  }
  schedule(world, { kind: 'position', at: world.now, attemptId: attempt.id });
  schedule(world, { kind: 'landing', at: Date.parse(attempt.landing), attemptId: attempt.id });
  if (
    world.version === 'operation-world.2' &&
    ((world.config.incident === 'landing-disagreement' &&
      !world.ordinaryWork &&
      demand.intentId === `intent-${world.config.runId}-alpha-0`) ||
      ordinaryIncident === 'landing-disagreement')
  )
    schedule(world, { kind: 'landing-report', at: Date.parse(attempt.landing) + 90_000, attemptId: attempt.id });
  if (chargeAt !== undefined) {
    schedule(world, { kind: 'charging', at: chargeAt, aircraftId: aircraft.id });
    schedule(world, { kind: 'ready', at: aircraft.availableAt, aircraftId: aircraft.id });
  }
  schedule(world, { kind: 'dispatch', at: world.resources ? world.now : world.pads[tenant], tenant });
}

function startGroundWork(world: OperationWorld, tenant: OperationTenant): void {
  const pools = world.resources!;
  for (const [kind, queue, phase, duration, completion] of [
    ['turnaroundCrews', pools.turnaroundQueue, 'turnaround', world.config.turnaroundMs, 'turnaround-complete'],
    ['chargers', pools.chargeQueue, 'charging', world.config.chargeMs, 'charge-complete'],
  ] as const) {
    for (const aircraftId of [...queue]) {
      const aircraft = world.aircraft.find((row) => row.id === aircraftId)!;
      if (aircraft.tenant !== tenant) continue;
      const slot = availableResource(world, kind, tenant);
      if (!slot) break;
      queue.splice(queue.indexOf(aircraftId), 1);
      aircraft.phase = phase;
      aircraft.availableAt = world.now + duration;
      occupyResource(slot, aircraftId, aircraft.availableAt);
      schedule(world, { kind: completion, at: aircraft.availableAt, aircraftId });
    }
  }
}

function completeGroundWork(
  world: OperationWorld,
  event: ScheduledEvent & { kind: 'turnaround-complete' | 'charge-complete'; aircraftId: string },
): void {
  const aircraft = world.aircraft.find((row) => row.id === event.aircraftId)!;
  if (event.kind === 'turnaround-complete') {
    releaseResource(world, 'turnaroundCrews', aircraft.id);
    aircraft.phase = 'waiting-charge';
    world.resources!.chargeQueue.push(aircraft.id);
  } else {
    releaseResource(world, 'chargers', aircraft.id);
    aircraft.phase = 'ready';
    aircraft.availableAt = world.now;
    delete aircraft.attemptId;
  }
  startGroundWork(world, aircraft.tenant);
  dispatch(world, aircraft.tenant);
}

function commandLinkChange(
  world: OperationWorld,
  attempt: OperationAttempt,
  kind: 'command-link-lost' | 'command-link-restored',
): void {
  const episode = world.commandLinkEpisode!;
  if (kind === 'command-link-lost') {
    if (attempt.commandLinkHold || attempt.phase !== 'flying') throw new Error('Invalid command-link loss event');
    const aircraft = world.aircraft.find((row) => row.id === attempt.aircraftId)!;
    const pilot = world.resources!.flightPeople.find(
      (slot) => slot.id === attempt.personId && slot.aircraftId === attempt.aircraftId,
    );
    if (!pilot) throw new Error('Command-link hold has no assigned flight person');
    const point = operationPoint(attempt, world.now);
    const holdMs = Date.parse(episode.endsAt) - world.now;
    if (holdMs <= 0) throw new Error('Command-link loss falls outside its episode');
    attempt.commandLinkHold = {
      incidentId: episode.id,
      sourceSessionId: `${attempt.sourceSessionId}-command-link-1`,
      lostAt: iso(world.now),
      restoredAt: episode.endsAt,
      point: { latitude: point.latitude, longitude: point.longitude, height: point.height },
      nominalLanding: attempt.landing,
      holdMs,
      extraAirborneMs: holdMs,
    };
    attempt.landing = iso(Date.parse(attempt.landing) + holdMs);
    aircraft.availableAt = Date.parse(attempt.landing);
    pilot.availableAt = aircraft.availableAt;
    episode.affectedAttemptIds.push(attempt.id);
    episode.extraAirborneMs += holdMs;
    for (const event of world.events) {
      if (
        'attemptId' in event &&
        event.attemptId === attempt.id &&
        (event.kind === 'landing' || event.kind === 'landing-report')
      )
        event.at += holdMs;
    }
    world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
  }
  const hold = attempt.commandLinkHold;
  if (!hold || attempt.phase !== 'flying') throw new Error('Invalid command-link restoration event');
  const status = kind === 'command-link-lost' ? 'lost' : 'restored';
  transitionOperationSimulatedLink(world, attempt, status === 'lost' ? 'down' : 'up');
  record(world, {
    ...identity(attempt, world.now),
    kind: 'command-link',
    sourceId: 'command-link',
    sourceSessionId: hold.sourceSessionId,
    sourceEventId: `${attempt.id}:command-link:${status}`,
    incidentId: hold.incidentId,
    status,
    position: { longitude: hold.point.longitude, latitude: hold.point.latitude },
  });
}

function ordinaryCommandLinkChange(
  world: OperationWorld,
  attempt: OperationAttempt,
  kind: 'ordinary-command-link-lost' | 'ordinary-command-link-restored',
): void {
  const incident = attempt.ordinaryIncident;
  if (incident?.kind !== 'command-link' || attempt.phase !== 'flying')
    throw new Error('Ordinary radio transition requires its retained flying attempt');
  const status = kind === 'ordinary-command-link-lost' ? 'lost' : 'restored';
  const expectedAt = status === 'lost' ? incident.lostAt : incident.restoredAt;
  if (iso(world.now) !== expectedAt) throw new Error('Ordinary radio transition differs from its retained clock');
  transitionOperationSimulatedLink(world, attempt, status === 'lost' ? 'down' : 'up');
  const point = operationPoint(attempt, world.now);
  record(world, {
    ...identity(attempt, world.now),
    kind: 'command-link',
    sourceId: 'command-link',
    sourceSessionId: `${attempt.sourceSessionId}-command-link-1`,
    sourceEventId: `${attempt.id}:command-link:${status}`,
    incidentId: incident.incidentId,
    status,
    position: { longitude: point.longitude, latitude: point.latitude },
  });
}

export function advanceOperation(world: OperationWorld, target: number): void {
  if (!Number.isSafeInteger(target) || target < world.now || !Number.isFinite(new Date(target).getTime()))
    throw new Error('World clock must advance to a valid UTC millisecond');
  upgradeOperationWorld(world);
  assertOperationDemandWindows(world);
  for (const reservation of world.reservations ?? []) scheduleOperationReservationExpiry(world, reservation);
  while (world.events[0] && world.events[0].at <= target) {
    const event = world.events.shift()!;
    world.now = event.at;
    if (event.kind === 'demand') {
      const tenant = event.tenant ?? (event.index % 5 === 4 ? 'beta' : 'alpha');
      const random = entityRandom(world.config.seed, `demand-${event.index}`);
      const name = destinations[tenant][Math.floor(random() * destinations[tenant].length)]!;
      const site = world.sites.find((row) => row.name === name)!;
      const id = `${world.config.runId}-${tenant}-${event.index}`;
      const demand: OperationDemand = {
        id: `order-${id}`,
        intentId: `intent-${id}`,
        tenant,
        requestedAt: iso(world.now),
        siteId: site.id,
        label: `${tenant === 'alpha' ? 'Medical courier' : 'Infrastructure inspection'} · ${name}`,
      };
      world.demand.push(demand);
      if (world.version === 'operation-world.2') {
        const { duration } = demandFlight(world, tenant, site.id);
        const waitingAllowanceMs = tenant === 'alpha' ? 120_000 : 300_000;
        const requestedStart = world.now + (world.ordinaryWork?.demandLeadMs ?? 0);
        const selected = world.config.selectedDemandWindow;
        demand.window =
          selected?.attemptId === `${demand.intentId}:attempt:1`
            ? { start: selected.start, end: selected.end }
            : { start: iso(requestedStart), end: iso(requestedStart + duration + waitingAllowanceMs) };
        schedule(world, {
          kind: 'demand-expiry',
          at: Math.max(world.now, Date.parse(demand.window.end) - duration + 1),
          demandId: demand.id,
        });
        record(world, {
          kind: 'order',
          tenant,
          at: demand.requestedAt,
          attemptId: `${demand.intentId}:attempt:1`,
          sourceSessionId: `${demand.intentId}-capture-1`,
          order: {
            order_id: demand.id,
            version: 1,
            updated_at: demand.requestedAt,
            state: 'accepted',
            schedule: { ...demand.window },
            requested_work: { name: demand.label },
            flights: [],
          },
        });
      }
      world.counters.demand++;
      const demandInterval = world.config.capacity?.demandIntervalMs[tenant] ?? world.config.demandIntervalMs;
      schedule(world, {
        kind: 'demand',
        at: world.now + demandInterval,
        index: event.index + 1,
        ...(event.tenant ? { tenant: event.tenant } : {}),
      });
      dispatch(world, tenant);
    } else if (event.kind === 'dispatch') dispatch(world, event.tenant);
    else if (event.kind === 'demand-expiry') {
      const demand = world.demand.find((row) => row.id === event.demandId);
      if (demand && !demand.attemptId && !demand.cancellation) dispatch(world, demand.tenant);
    } else if (event.kind === 'reservation-expiry') {
      const reservation = world.reservations?.find((row) => row.id === event.attemptId);
      if (reservation && cancelUnreachableReservation(world, reservation)) dispatch(world, reservation.tenant);
    } else if (event.kind === 'command-link-lost' || event.kind === 'command-link-restored')
      commandLinkChange(
        world,
        world.attempts.find((attempt) => attempt.id === event.attemptId)!,
        event.kind,
      );
    else if (event.kind === 'ordinary-command-link-lost' || event.kind === 'ordinary-command-link-restored')
      ordinaryCommandLinkChange(
        world,
        world.attempts.find((attempt) => attempt.id === event.attemptId)!,
        event.kind,
      );
    else if (event.kind === 'turnaround-complete' || event.kind === 'charge-complete') completeGroundWork(world, event);
    else if (event.kind === 'charging' || event.kind === 'ready') {
      const aircraft = world.aircraft.find((row) => row.id === event.aircraftId)!;
      aircraft.phase = event.kind === 'charging' ? 'charging' : 'ready';
      if (event.kind === 'ready') {
        delete aircraft.attemptId;
        dispatch(world, aircraft.tenant);
      }
    } else if (event.kind === 'position' || event.kind === 'landing' || event.kind === 'landing-report') {
      const attempt = world.attempts.find((row) => row.id === event.attemptId)!;
      if (event.kind === 'position') {
        record(world, { ...identity(attempt, world.now), kind: 'position', point: operationPoint(attempt, world.now) });
        const next = Math.min(world.now + world.config.sampleIntervalMs, Date.parse(attempt.landing));
        if (next > world.now) schedule(world, { kind: 'position', at: next, attemptId: attempt.id });
      } else if (event.kind === 'landing-report') {
        const person = world.people.find((row) => row.id === `${world.config.runId}-person-${attempt.tenant}-ground`)!;
        record(world, {
          ...identity(attempt, world.now),
          kind: 'landing-report',
          sourceId: `simulation-person-${attempt.tenant}-buffered`,
          sourceSessionId: `${attempt.sourceSessionId}-buffered-person`,
          reportAt: iso(world.now),
          reportedLandingAt: iso(Date.parse(attempt.landing) + 30_000),
          incidentId: `${attempt.id}:landing-disagreement`,
          incidentCause: 'handset-clock-offset',
          personId: person.id,
          personName: person.name,
        });
      } else {
        attempt.phase = 'landed';
        world.counters.landed++;
        const aircraft = world.aircraft.find((row) => row.id === attempt.aircraftId)!;
        aircraft.phase = world.resources ? 'waiting-turnaround' : 'turnaround';
        const person = world.people.find((row) => row.id === attempt.personId)!;
        record(world, {
          ...identity(attempt, world.now),
          kind: 'landing',
          personId: person.id,
          personName: person.name,
        });
        if (!world.resources && operationAdditiveFlight(world, attempt.id)) {
          const slot = world.demoResources?.flightPeople.find((row) => row.aircraftId === aircraft.id);
          if (!slot) throw new Error('Held-flight landing lost its prospective flight-person reservation');
          slot.availableAt = world.now;
          delete slot.aircraftId;
        }
        if (world.resources) {
          releaseResource(world, 'flightPeople', aircraft.id);
          world.resources.turnaroundQueue.push(aircraft.id);
          startGroundWork(world, aircraft.tenant);
          dispatch(world, aircraft.tenant);
        }
      }
    }
  }
  world.now = target;
}

export function holdAircraft(world: OperationWorld, aircraftId: string, until: number): void {
  const aircraft = world.aircraft.find((row) => row.id === aircraftId);
  if (!aircraft || !Number.isSafeInteger(until) || until < world.now) throw new Error('Invalid maintenance hold');
  aircraft.maintenanceUntil = until;
  schedule(world, { kind: 'dispatch', tenant: aircraft.tenant, at: until });
}

export function operationSummary(world: OperationWorld) {
  upgradeOperationWorld(world);
  return {
    runId: world.config.runId,
    at: iso(world.now),
    demand: world.counters.demand,
    queued:
      world.counters.demand -
      world.counters.attempts -
      (world.reservations?.filter((reservation) => reservation.phase === 'awaiting-release').length ?? 0) -
      world.counters.cancelled,
    cancelled: world.counters.cancelled,
    flying: world.counters.attempts - world.counters.landed,
    landed: world.counters.landed,
    aircraft: world.aircraft.reduce<Record<string, number>>(
      (counts, row) => ({ ...counts, [row.phase]: (counts[row.phase] ?? 0) + 1 }),
      {},
    ),
    facts: world.nextFact,
    ...predepartureStatus(world),
    ...ordinaryWorkStatus(world),
  };
}
