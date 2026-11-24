import { scheduleOrdinaryIncident } from './operation-ordinary-work.js';
import { operationAdditiveFlight } from './operation-ordinary-dispatch.js';
import { occupyResource } from './operation-capacity.js';
import type { OperationMissionSource } from './operation-mission.js';
import { validateOperationMissionSource } from './operation-mission-validation.js';
import type { OperationReservation } from './operation-predeparture.js';
import { holdsWorldOperationAttempt, operationDepartureResources } from './operation-predeparture-selection.js';
import { operationReservationFit } from './operation-route-fit.js';
import { operationRouteCommandLinkLossAt } from './operation-route-command-link.js';
import { buildOperationRouteTimeline, operationRoutePoint } from './operation-route-timeline.js';
import { initializeOperationSimulatedLink } from './operation-simulated-link.js';
import type { OperationAttempt, OperationWorld, WorldFact } from './operation.js';

export interface OperationDepartureReference {
  id: string;
  digest: string;
}

export interface OperationDepartureMissionReference {
  missionId: string;
  sourceRevision: number;
  eventId: string;
  contentDigest: string;
  recordDigest: string;
}

export interface OperationDepartureRequest {
  kind: 'mission.departure-authorize';
  flightId: string;
  aircraftId: string;
  release: OperationDepartureReference;
  departureAttemptId: string;
  allocation: OperationDepartureReference;
  expectedPrincipalRevision: number;
  expectedControlsDigest?: string;
}

export interface OperationDeparturePermit {
  version: 'flight.mission-departure-permit.1';
  id: string;
  flightId: string;
  aircraftId: string;
  release: OperationDepartureReference;
  mission: OperationDepartureMissionReference;
  contextDigest: string;
  departureAttemptId: string;
  allocation: OperationDepartureReference;
  authorizedAt: string;
  validUntil: string;
  policy: {
    id: 'ledger.demo.route-avoidance-departure';
    version: 1;
    digest: string;
    clock: 'wall';
    permitSeconds: 30;
    authorization: 'finite_lease_at_authorized_at';
    replay: 'same_original_unexpired_lease';
    renewal: 'unsupported';
    uniqueness: 'tenant_flight_and_attempt_and_allocation';
    operationFit: 'producer_checks_before_authorization_and_at_consumption';
    expiry: 'earliest_of_30_seconds_release_end_or_selection_boundary';
    instruction: string;
  };
  actor: {
    id: string;
    name: string;
    kind: string;
    active: true;
    principalRevision: number;
    capabilities: string[];
    commandLinkSources: string[];
    missionSources: string[];
    checkedCapabilities: ['decision:write', 'flight:read', 'mission:release'];
    scope: { kind: 'flight'; id: string };
    policyVersion: 'ledger.mission-departure-authority.1';
  };
}

export interface OperationDepartureFitWitness {
  version: 'mission.departure-fit.1';
  permit: OperationDepartureReference;
  mission: OperationDepartureMissionReference;
  aircraftId: string;
  evaluatedAt: string;
  remainingDurationMs: number;
  holdAllowanceMs: number;
  marginMs: number;
  requiredCompletionAt: string;
}

export interface OperationDepartureAllocationInput {
  id: string;
  flightId: string;
  reservationId: string;
  departureAttemptId: string;
  mission: OperationDepartureMissionReference;
  release: OperationDepartureReference;
  durationMs: number;
}

export interface OperationDepartureAllocation extends Omit<OperationDepartureAllocationInput, 'durationMs'> {
  version: 'operation.departure-allocation.1';
  sourcePlan: OperationMissionSource;
  aircraftId: string;
  personId: string;
  sourceSessionId: string;
  padId: string;
  startsAt: string;
  endsAt: string;
}

export interface OperationDepartureConsumeInput {
  allocation: OperationDepartureAllocation;
  caller: {
    apiUrl: string;
    tenantId: string;
    principalId: string;
    planDigest: string;
    requestKey: string;
    payloadSha256: string;
  };
  request: OperationDepartureRequest;
  requestBytes: string;
  permit: OperationDeparturePermit;
  permitDigest: string;
  fit: OperationDepartureFitWitness;
  currentControls?: OperationDepartureCurrentControls;
}

export interface OperationDepartureCurrentControls {
  version: 'operation.departure-current-controls.1';
  readStartedAt: string;
  readFinishedAt: string;
  avoidanceDigest: string;
  releaseValidityDigest: string;
  avoidance: {
    evaluatedAt: string;
    status: string;
    contextDigest: string | null;
    mission: OperationDepartureMissionReference | null;
    candidateCompleteness: { status: string };
    candidates: Array<{ geometry: string; context: string }>;
  };
  releaseValidity: {
    release: OperationDepartureReference;
    evaluatedAt: string;
    status: string;
    processing: string;
    currentContextDigest: string | null;
    nextBoundary: string | null;
  };
}

export interface OperationDepartureCommit extends OperationDepartureConsumeInput {
  version: 'operation.departure-commit.1';
  flightId: string;
  reservationId: string;
  attemptId: string;
  departureAttemptId: string;
  aircraftId: string;
  personId: string;
  sourceSessionId: string;
  departureAt: string;
}

function invalid(reason: string): never {
  throw new Error(reason);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return (
    object(value) && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function time(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid('Departure requires a strict UTC clock');
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19))
    return invalid('Departure requires a valid finite UTC clock');
  return at;
}

function iso(at: number): string {
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()))
    return invalid('Departure exceeds the supported finite clock');
  const value = new Date(at).toISOString();
  time(value);
  return value;
}

function same(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (Array.isArray(first) && Array.isArray(second))
    return first.length === second.length && first.every((value, index) => same(value, second[index]));
  if (!object(first) || !object(second)) return false;
  const names = Object.keys(first);
  return (
    names.length === Object.keys(second).length &&
    names.every((name) => Object.hasOwn(second, name) && same(first[name], second[name]))
  );
}

function reference(value: unknown): value is OperationDepartureReference {
  return keys(value, ['id', 'digest']) && id(value.id) && digest(value.digest);
}

function missionReference(value: unknown): value is OperationDepartureMissionReference {
  return (
    keys(value, ['missionId', 'sourceRevision', 'eventId', 'contentDigest', 'recordDigest']) &&
    id(value.missionId) &&
    positive(value.sourceRevision) &&
    id(value.eventId) &&
    digest(value.contentDigest) &&
    digest(value.recordDigest)
  );
}

function checkDepartureCollections(world: OperationWorld): void {
  for (const collection of [world.departureAllocations, world.departures]) {
    if (
      collection !== undefined &&
      (!Array.isArray(collection) ||
        collection.filter((entry) => !operationAdditiveFlight(world, entry.reservationId)).length > 1 ||
        collection.length > world.aircraft.length + 1)
    )
      invalid('Departure state supports at most one retained allocation and one retained commit');
  }
}

function heldReservation(world: OperationWorld, reservationId: string): OperationReservation {
  iso(world.now);
  const reservation = world.reservations?.find((row) => row.id === reservationId);
  if (
    !reservation ||
    !holdsWorldOperationAttempt(world, reservation.tenant, reservation.id) ||
    reservation.phase !== 'awaiting-release' ||
    world.attempts.some((row) => row.id === reservationId) ||
    world.departures?.some((row) => row.reservationId === reservationId)
  )
    return invalid('Departure requires an unconsumed held reservation');
  validateOperationMissionSource(reservation.plan);
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
    person.aircraftId !== reservation.aircraftId ||
    !world.people.some((row) => row.id === reservation.personId && row.tenant === reservation.tenant) ||
    reservation.plan.sourceMissionId !== `${reservation.id}:mission` ||
    reservation.plan.aircraftId !== reservation.aircraftId
  )
    return invalid('Departure reservation no longer owns its aircraft and named flight person');
  return reservation;
}

export function allocateOperationDeparture(
  world: OperationWorld,
  input: OperationDepartureAllocationInput,
): OperationDepartureAllocation {
  checkDepartureCollections(world);
  if (
    !keys(input, ['id', 'flightId', 'reservationId', 'departureAttemptId', 'mission', 'release', 'durationMs']) ||
    !id(input.id) ||
    !id(input.flightId) ||
    !id(input.reservationId) ||
    !id(input.departureAttemptId) ||
    !missionReference(input.mission) ||
    !reference(input.release) ||
    !positive(input.durationMs) ||
    input.durationMs < 10_000 ||
    input.durationMs > 90_000
  )
    return invalid('Departure allocation requires exact identities, mission, release and a 10–90 second duration');
  if (
    operationAdditiveFlight(world, input.reservationId)
      ? world.departureAllocations?.some((row) => row.reservationId === input.reservationId) ||
        world.departures?.some((row) => row.reservationId === input.reservationId)
      : world.departureAllocations?.some((row) => !operationAdditiveFlight(world, row.reservationId)) ||
        world.departures?.some((row) => !operationAdditiveFlight(world, row.reservationId))
  )
    return invalid('Departure allocation cannot replace the one retained flight, reservation or attempt allocation');
  const reservation = heldReservation(world, input.reservationId);
  if (input.mission.sourceRevision !== reservation.plan.sourceRevision)
    return invalid('Departure allocation mission revision differs from the held source plan');
  const endsAt = iso(world.now + input.durationMs);
  const pad = operationDepartureResources(world, input.reservationId)!.launchPads.find(
    (row) => row.tenant === reservation.tenant && row.availableAt <= world.now,
  );
  if (!pad || (!world.resources && world.pads[reservation.tenant] > world.now))
    return invalid('Departure requires an exclusively available tenant launch pad');
  const allocation: OperationDepartureAllocation = {
    version: 'operation.departure-allocation.1',
    id: input.id,
    flightId: input.flightId,
    reservationId: input.reservationId,
    departureAttemptId: input.departureAttemptId,
    mission: structuredClone(input.mission),
    release: structuredClone(input.release),
    sourcePlan: structuredClone(reservation.plan),
    aircraftId: reservation.aircraftId,
    personId: reservation.personId,
    sourceSessionId: reservation.sourceSessionId,
    padId: pad.id,
    startsAt: iso(world.now),
    endsAt,
  };
  const result = structuredClone(allocation);
  occupyResource(pad, reservation.aircraftId, time(endsAt));
  if (!world.resources) world.pads[reservation.tenant] = time(endsAt);
  (world.departureAllocations ??= []).push(allocation);
  return result;
}

type FlightEvent = {
  at: number;
  attemptId: string;
  kind: 'position' | 'landing' | 'landing-report' | 'command-link-lost' | 'command-link-restored';
};

export function consumeOperationDeparture(
  world: OperationWorld,
  input: OperationDepartureConsumeInput,
): OperationDepartureCommit {
  checkDepartureCollections(world);
  if (
    world.departureAllocations?.filter((row) => row.reservationId === input.allocation?.reservationId).length !== 1 ||
    world.departures?.some((row) => row.reservationId === input.allocation?.reservationId)
  )
    return invalid('Departure consumption requires one original allocation and no retained departure commit');
  const ordinary = world.ordinaryDispatch?.flights.some(
    (flight) => flight.attemptId === input.allocation?.reservationId,
  );
  if (
    !keys(input, [
      'allocation',
      'caller',
      'request',
      'requestBytes',
      'permit',
      'permitDigest',
      'fit',
      ...(ordinary ? ['currentControls'] : []),
    ])
  )
    return invalid('Departure consumption requires the exact allocation, caller, request, permit and fit witness');
  const allocation = world.departureAllocations?.find((row) => row.id === input.allocation?.id);
  if (
    !allocation ||
    !keys(allocation, [
      'version',
      'id',
      'flightId',
      'reservationId',
      'departureAttemptId',
      'mission',
      'release',
      'sourcePlan',
      'aircraftId',
      'personId',
      'sourceSessionId',
      'padId',
      'startsAt',
      'endsAt',
    ]) ||
    allocation.version !== 'operation.departure-allocation.1' ||
    !id(allocation.id) ||
    !id(allocation.flightId) ||
    !id(allocation.reservationId) ||
    !id(allocation.departureAttemptId) ||
    !missionReference(allocation.mission) ||
    !reference(allocation.release) ||
    !id(allocation.aircraftId) ||
    !id(allocation.personId) ||
    !id(allocation.sourceSessionId) ||
    !id(allocation.padId) ||
    !same(allocation, input.allocation)
  )
    return invalid('Departure allocation differs from its retained commitment');
  const reservation = heldReservation(world, allocation.reservationId);
  if (
    world.departures?.some((row) => row.flightId === allocation.flightId) ||
    !same(allocation.sourcePlan, reservation.plan) ||
    allocation.mission.sourceRevision !== reservation.plan.sourceRevision ||
    allocation.aircraftId !== reservation.aircraftId ||
    allocation.personId !== reservation.personId ||
    allocation.sourceSessionId !== reservation.sourceSessionId
  )
    return invalid('Departure allocation no longer pins the exact held reservation and source plan');
  const startsAt = time(allocation.startsAt);
  const endsAt = time(allocation.endsAt);
  const pad = operationDepartureResources(world, allocation.reservationId)!.launchPads.find(
    (row) => row.id === allocation.padId,
  );
  if (
    world.now < startsAt ||
    world.now >= endsAt ||
    endsAt - startsAt < 10_000 ||
    endsAt - startsAt > 90_000 ||
    !pad ||
    pad.tenant !== reservation.tenant ||
    pad.aircraftId !== reservation.aircraftId ||
    pad.availableAt !== endsAt ||
    !Number.isSafeInteger(world.now + 10_000) ||
    endsAt < world.now + 10_000
  )
    return invalid('Departure requires its original live exclusive pad and ten seconds of launch occupancy');
  const { caller, request, permit, fit } = input;
  let retainedRequest: unknown;
  if (
    typeof input.requestBytes !== 'string' ||
    input.requestBytes.length === 0 ||
    input.requestBytes.length > 64 * 1024
  )
    return invalid('Departure request bytes must contain the bounded original JSON command');
  try {
    retainedRequest = JSON.parse(input.requestBytes);
  } catch {
    return invalid('Departure request bytes are not JSON');
  }
  if (!same(retainedRequest, request)) return invalid('Departure request differs from its original JSON bytes');
  if (
    !keys(caller, ['apiUrl', 'tenantId', 'principalId', 'planDigest', 'requestKey', 'payloadSha256']) ||
    typeof caller.apiUrl !== 'string' ||
    caller.apiUrl.length === 0 ||
    caller.apiUrl.length > 2048 ||
    caller.tenantId !== `tenant-${reservation.tenant}` ||
    !id(caller.principalId) ||
    !digest(caller.planDigest) ||
    !id(caller.requestKey) ||
    !digest(caller.payloadSha256) ||
    !keys(request, [
      'kind',
      'flightId',
      'aircraftId',
      'release',
      'departureAttemptId',
      'allocation',
      'expectedPrincipalRevision',
      ...(object(request) && Object.hasOwn(request, 'expectedControlsDigest') ? ['expectedControlsDigest'] : []),
    ]) ||
    (request.expectedControlsDigest !== undefined && !digest(request.expectedControlsDigest)) ||
    request.kind !== 'mission.departure-authorize' ||
    request.flightId !== allocation.flightId ||
    request.aircraftId !== allocation.aircraftId ||
    request.departureAttemptId !== allocation.departureAttemptId ||
    !same(request.release, allocation.release) ||
    !reference(request.allocation) ||
    request.allocation.id !== allocation.id ||
    !positive(request.expectedPrincipalRevision) ||
    !object(permit) ||
    permit.version !== 'flight.mission-departure-permit.1' ||
    !id(permit.id) ||
    permit.flightId !== allocation.flightId ||
    permit.aircraftId !== allocation.aircraftId ||
    permit.departureAttemptId !== allocation.departureAttemptId ||
    !same(permit.release, allocation.release) ||
    !same(permit.mission, allocation.mission) ||
    !same(permit.allocation, request.allocation) ||
    !digest(permit.contextDigest) ||
    !digest(input.permitDigest) ||
    !object(permit.actor) ||
    permit.actor.id !== caller.principalId ||
    permit.actor.principalRevision !== request.expectedPrincipalRevision ||
    permit.actor.active !== true ||
    permit.actor.scope?.kind !== 'flight' ||
    permit.actor.scope.id !== allocation.flightId
  )
    return invalid('Departure caller, authorization request and permit bindings do not match the allocation');
  const authorizedAt = time(permit.authorizedAt);
  const validUntil = time(permit.validUntil);
  if (
    authorizedAt > world.now ||
    world.now >= validUntil ||
    validUntil <= authorizedAt ||
    validUntil - authorizedAt > 30_000 ||
    authorizedAt < startsAt ||
    validUntil > time(reservation.plan.operatingInterval.end)
  )
    return invalid('Departure is outside its original finite permit interval');
  if (ordinary) {
    const review = input.currentControls;
    if (
      !keys(review, [
        'version',
        'readStartedAt',
        'readFinishedAt',
        'avoidanceDigest',
        'releaseValidityDigest',
        'avoidance',
        'releaseValidity',
      ]) ||
      review.version !== 'operation.departure-current-controls.1' ||
      !digest(review.avoidanceDigest) ||
      !digest(review.releaseValidityDigest)
    )
      return invalid('Ordinary departure requires its retained final public control reads');
    const startedAt = time(review.readStartedAt);
    const finishedAt = time(review.readFinishedAt);
    if (
      startedAt < authorizedAt ||
      finishedAt < startedAt ||
      finishedAt - startedAt > 10_000 ||
      finishedAt > world.now ||
      world.now - finishedAt > 1000 ||
      review.avoidance.status !== 'outside' ||
      review.avoidance.candidateCompleteness.status !== 'complete' ||
      !same(review.avoidance.mission, allocation.mission) ||
      review.avoidance.contextDigest !== permit.contextDigest ||
      review.avoidance.candidates.some(
        (candidate) => candidate.geometry !== 'outside' || candidate.context !== 'current',
      ) ||
      time(review.avoidance.evaluatedAt) < startedAt - 1000 ||
      time(review.avoidance.evaluatedAt) > finishedAt + 1000 ||
      !same(review.releaseValidity.release, allocation.release) ||
      review.releaseValidity.status !== 'current' ||
      review.releaseValidity.processing !== 'completed' ||
      review.releaseValidity.currentContextDigest !== permit.contextDigest ||
      (review.releaseValidity.nextBoundary !== null && time(review.releaseValidity.nextBoundary) <= world.now) ||
      time(review.releaseValidity.evaluatedAt) < startedAt - 1000 ||
      time(review.releaseValidity.evaluatedAt) > finishedAt + 1000
    )
      return invalid('Ordinary departure final controls or release changed, were uncertain, or became stale');
  }
  if (
    !keys(fit, [
      'version',
      'permit',
      'mission',
      'aircraftId',
      'evaluatedAt',
      'remainingDurationMs',
      'holdAllowanceMs',
      'marginMs',
      'requiredCompletionAt',
    ]) ||
    fit.version !== 'mission.departure-fit.1' ||
    !same(fit.permit, { id: permit.id, digest: input.permitDigest }) ||
    !same(fit.mission, allocation.mission) ||
    fit.aircraftId !== allocation.aircraftId ||
    fit.evaluatedAt !== iso(world.now)
  )
    return invalid('Departure fit witness does not pin this permit, mission, aircraft and current clock');
  const freshFit = operationReservationFit(world, reservation.id, { marginMs: fit.marginMs });
  if (
    freshFit.status !== 'fits' ||
    fit.remainingDurationMs !== freshFit.nominalDurationMs ||
    fit.holdAllowanceMs !== freshFit.holdAllowanceMs ||
    fit.requiredCompletionAt !== freshFit.requiredCompletionAt
  )
    return invalid('Departure fit witness differs from the full current operation fit');
  const built = buildOperationRouteTimeline(reservation, world.config.cruiseMetersPerSecond);
  if (built.status !== 'supported') return invalid('Departure route timeline is unavailable');
  const departureAt = iso(world.now);
  const landing = iso(world.now + built.timeline.durationMs);
  if (world.now < time(reservation.order.schedule.start) || time(landing) > time(reservation.order.schedule.end))
    return invalid('Departure cannot complete within the original requested customer window');
  const attempt: OperationAttempt = {
    id: reservation.id,
    intentId: reservation.intentId,
    demandId: reservation.demandId,
    tenant: reservation.tenant,
    aircraftId: reservation.aircraftId,
    personId: reservation.personId,
    sourceSessionId: reservation.sourceSessionId,
    siteId: reservation.siteId,
    origin: structuredClone(reservation.origin),
    destination: structuredClone(reservation.destination),
    travelMs: reservation.travelMs,
    departure: departureAt,
    landing,
    phase: 'flying',
    routeTimeline: built.timeline,
  };
  const events: FlightEvent[] = [];
  if (world.commandLinkEpisode) {
    const lossAt = operationRouteCommandLinkLossAt(built.timeline, world.now, world.commandLinkEpisode);
    if (lossAt !== undefined) {
      events.push({ kind: 'command-link-lost', at: lossAt, attemptId: attempt.id });
      events.push({ kind: 'command-link-restored', at: time(world.commandLinkEpisode.endsAt), attemptId: attempt.id });
    }
  }
  events.push({
    kind: 'position',
    at: Math.min(world.now + world.config.sampleIntervalMs, time(landing)),
    attemptId: attempt.id,
  });
  events.push({ kind: 'landing', at: time(landing), attemptId: attempt.id });
  if (
    world.version === 'operation-world.2' &&
    !world.ordinaryWork &&
    world.config.incident === 'landing-disagreement' &&
    attempt.intentId === `intent-${world.config.runId}-alpha-0`
  )
    events.push({ kind: 'landing-report', at: time(landing) + 90_000, attemptId: attempt.id });
  if (
    !Number.isSafeInteger(world.nextEvent) ||
    world.nextEvent < 0 ||
    !Number.isSafeInteger(world.nextEvent + events.length) ||
    !Number.isSafeInteger(world.nextFact) ||
    world.nextFact < 0 ||
    !Number.isSafeInteger(world.nextFact + 2) ||
    !Number.isSafeInteger(world.counters.attempts + 1) ||
    events.some((event) => !Number.isSafeInteger(event.at) || !Number.isFinite(new Date(event.at).getTime()))
  )
    return invalid('Departure event, fact or attempt counters exceed the supported finite clock');
  const commit: OperationDepartureCommit = {
    ...structuredClone(input),
    version: 'operation.departure-commit.1',
    flightId: allocation.flightId,
    reservationId: reservation.id,
    attemptId: attempt.id,
    departureAttemptId: allocation.departureAttemptId,
    aircraftId: attempt.aircraftId,
    personId: attempt.personId,
    sourceSessionId: attempt.sourceSessionId,
    departureAt,
  };
  const result = structuredClone(commit);
  const person = world.people.find((row) => row.id === attempt.personId)!;
  const common = {
    tenant: attempt.tenant,
    at: departureAt,
    attemptId: attempt.id,
    aircraftId: attempt.aircraftId,
    sourceSessionId: attempt.sourceSessionId,
  };
  const initialPoint = operationRoutePoint(built.timeline, 0);
  const facts: WorldFact[] = [
    { ...common, sequence: world.nextFact, kind: 'departure', personId: person.id, personName: person.name },
    {
      ...common,
      sequence: world.nextFact + 1,
      kind: 'position',
      point: {
        occurredAt: departureAt,
        latitude: initialPoint.latitude,
        longitude: initialPoint.longitude,
        height: 200,
        horizontalSpeed: initialPoint.horizontalSpeed,
      },
    },
  ];
  const interruption =
    world.version === 'operation-world.2' &&
    world.config.profile === 'telemetry-delivery-interruption' &&
    attempt.intentId === `intent-${world.config.runId}-alpha-0`
      ? {
          id: `${attempt.id}:telemetry-delivery-interruption`,
          aircraftId: attempt.aircraftId,
          attemptId: attempt.id,
          sourceSessionId: attempt.sourceSessionId,
          startsAt: iso(world.now + 60_000),
          endsAt: iso(world.now + 150_000),
        }
      : undefined;
  initializeOperationSimulatedLink(world, attempt);
  if (world.ordinaryDispatch?.flights.some((flight) => flight.attemptId === attempt.id)) {
    const incident = scheduleOrdinaryIncident(world, attempt);
    if (incident === 'landing-disagreement')
      events.push({ kind: 'landing-report', at: time(landing) + 90_000, attemptId: attempt.id });
  }
  world.reservations!.splice(world.reservations!.indexOf(reservation), 1);
  world.events = world.events.filter(
    (event) => event.kind !== 'reservation-expiry' || event.attemptId !== reservation.id,
  );
  world.attempts.push(attempt);
  world.counters.attempts++;
  const aircraft = world.aircraft.find((row) => row.id === attempt.aircraftId)!;
  aircraft.phase = 'flying';
  aircraft.availableAt = time(landing);
  occupyResource(
    operationDepartureResources(world, attempt.id)!.flightPeople.find((row) => row.id === attempt.personId)!,
    attempt.aircraftId,
    aircraft.availableAt,
  );
  if (!world.resources) {
    const chargeAt = Math.max(time(landing) + world.config.turnaroundMs, world.chargers[attempt.tenant]);
    aircraft.availableAt = chargeAt + world.config.chargeMs;
    world.chargers[attempt.tenant] = aircraft.availableAt;
    world.events.push({ kind: 'charging', at: chargeAt, aircraftId: aircraft.id, sequence: world.nextEvent++ });
    world.events.push({
      kind: 'ready',
      at: aircraft.availableAt,
      aircraftId: aircraft.id,
      sequence: world.nextEvent++,
    });
  }
  world.facts.push(...facts);
  world.nextFact += facts.length;
  for (const event of events) world.events.push({ ...event, sequence: world.nextEvent++ });
  world.events.sort((first, second) => first.at - second.at || first.sequence - second.sequence);
  (world.departures ??= []).push(commit);
  if (interruption) world.telemetryDeliveryInterruption ??= interruption;
  return result;
}
