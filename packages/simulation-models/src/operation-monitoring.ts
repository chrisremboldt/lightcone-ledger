import { validateOperationMissionSource } from './operation-mission-validation.js';
import type { OperationMissionSource } from './operation-mission.js';
import type { OperationTenant, OperationWorld, WorldFact } from './operation.js';

export interface OperationMonitoringInterval {
  start: string;
  end: string;
}
export interface OperationMonitoringControlReference {
  hazardId: string;
  controlId: string;
  controlVersion: number;
  controlEventId: string;
  controlDigest: string;
  acceptance: { id: string; acceptedRevision: number; digest: string };
}
export type OperationMonitoringLinkState = 'up' | 'down' | 'unknown';
export interface OperationMonitoringBaselineObservation {
  version: 'operation.command-link-baseline-observation.1';
  state: OperationMonitoringLinkState;
  occurredAt: string;
}
export interface OperationMonitoringPlan {
  version: 1;
  runId: string;
  tenant: OperationTenant;
  sourceId: string;
  sourceSessionId: string;
  sourceWindowId: string;
  control: OperationMonitoringControlReference;
  window: OperationMonitoringInterval;
  flights: Array<{
    attemptId: string;
    initialLinkState: OperationMonitoringLinkState;
    monitoringAvailable: boolean;
  }>;
}
export interface OperationMonitoringFlightSnapshot {
  attemptId: string;
  aircraftId?: string;
  c2SourceId?: string;
  c2SourceSessionId?: string;
  departureAt?: string;
  landingAt?: string;
  baseline?: { state: OperationMonitoringLinkState; occurredAt: string };
  initialLinkObservation?: OperationMonitoringBaselineObservation;
  executedMission?: OperationMissionSource;
  executedMissionOriginalBytesBase64?: string;
  observedIntervals: OperationMonitoringInterval[];
  coverageIntervals: OperationMonitoringInterval[];
  gaps: Array<{ kind: 'c2_monitor' | 'telemetry_delivery'; interval: OperationMonitoringInterval }>;
  reports: Array<Extract<WorldFact, { kind: 'command-link' }>>;
}
export interface OperationMonitoringSnapshot {
  version: 'operation.monitoring-snapshot.1';
  plan: OperationMonitoringPlan;
  startedAt: string;
  observedThrough: string;
  completedAt?: string;
  nextFact: number;
  complete: boolean;
  failure?: { code: string; reason: string };
  flights: OperationMonitoringFlightSnapshot[];
}
interface ObservedFlight extends OperationMonitoringFlightSnapshot {
  initialLinkState: OperationMonitoringLinkState;
  monitoringAvailable: boolean;
  telemetryDeliveryAvailable: boolean;
  latestMission?: OperationMissionSource;
  latestMissionOriginalBytesBase64?: string;
}
export interface OperationMonitoringObserver {
  version: 'operation.monitoring-observer.1';
  futureDemo?: { cycleId: string; registeredAt: string; firstFact: number };
  plan: OperationMonitoringPlan;
  planJson: string;
  startedAt: string;
  observedThrough: string;
  completedAt?: string;
  nextFact: number;
  failure?: { code: string; reason: string };
  flights: ObservedFlight[];
}
export interface OperationMonitoringAvailability {
  monitoringAvailable?: boolean;
  telemetryDeliveryAvailable?: boolean;
}

const limits = { flights: 32, reports: 128, intervals: 16, windowMs: 3_600_000 };
const clone = <T>(value: T): T => structuredClone(value);
const iso = (at: number): string => new Date(at).toISOString();
const id = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function keys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function time(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    throw new Error('Monitoring requires a finite UTC clock');
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error('Monitoring requires a finite UTC clock');
  return at;
}
function linkState(value: unknown): value is OperationMonitoringLinkState {
  return value === 'up' || value === 'down' || value === 'unknown';
}
function validatePlan(plan: OperationMonitoringPlan): void {
  if (
    !keys(plan, [
      'version',
      'runId',
      'tenant',
      'sourceId',
      'sourceSessionId',
      'sourceWindowId',
      'control',
      'window',
      'flights',
    ]) ||
    plan.version !== 1 ||
    ![plan.runId, plan.sourceId, plan.sourceSessionId, plan.sourceWindowId].every(id) ||
    !['alpha', 'beta'].includes(plan.tenant) ||
    !keys(plan.control, ['hazardId', 'controlId', 'controlVersion', 'controlEventId', 'controlDigest', 'acceptance']) ||
    ![plan.control.hazardId, plan.control.controlId, plan.control.controlEventId].every(id) ||
    !revision(plan.control.controlVersion) ||
    !digest(plan.control.controlDigest) ||
    !keys(plan.control.acceptance, ['id', 'acceptedRevision', 'digest']) ||
    !id(plan.control.acceptance.id) ||
    !revision(plan.control.acceptance.acceptedRevision) ||
    !digest(plan.control.acceptance.digest) ||
    !keys(plan.window, ['start', 'end']) ||
    !Array.isArray(plan.flights) ||
    plan.flights.length < 1 ||
    plan.flights.length > limits.flights ||
    plan.flights.some(
      (flight) =>
        !keys(flight, ['attemptId', 'initialLinkState', 'monitoringAvailable']) ||
        !id(flight.attemptId) ||
        !linkState(flight.initialLinkState) ||
        typeof flight.monitoringAvailable !== 'boolean',
    ) ||
    new Set(plan.flights.map((flight) => flight.attemptId)).size !== plan.flights.length
  )
    throw new Error('Monitoring requires one exact bounded source, control, window and selected population');
  const start = time(plan.window.start);
  const end = time(plan.window.end);
  if (start >= end || end - start > limits.windowMs)
    throw new Error('Monitoring window must be positive and at most one hour');
}
function sameMonitoringWorld(observer: OperationMonitoringObserver, world: OperationWorld): boolean {
  if (!observer.futureDemo) return time(world.config.start) === time(observer.startedAt);
  const pin = observer.futureDemo;
  const demo = world.demoFlights?.find((flight) => flight.cycleId === pin.cycleId);
  return Boolean(
    demo &&
    observer.flights.length === 1 &&
    demo.attemptId === observer.flights[0]!.attemptId &&
    demo.createdAt === pin.registeredAt &&
    time(demo.createdAt) <= time(observer.startedAt) &&
    Number.isSafeInteger(pin.firstFact) &&
    pin.firstFact >= 0 &&
    pin.firstFact <= observer.nextFact,
  );
}

function validateObserver(observer: OperationMonitoringObserver): void {
  validatePlan(observer.plan);
  if (
    observer.version !== 'operation.monitoring-observer.1' ||
    JSON.stringify(observer.plan) !== observer.planJson ||
    !Number.isSafeInteger(observer.nextFact) ||
    observer.nextFact < 0 ||
    observer.flights.length !== observer.plan.flights.length ||
    observer.flights.some((flight, index) => flight.attemptId !== observer.plan.flights[index]!.attemptId)
  )
    throw new Error('Monitoring observer identity or selected population changed');
  const observedThrough = time(observer.observedThrough);
  if (observedThrough < time(observer.startedAt)) throw new Error('Monitoring observer clock changed');
  for (const flight of observer.flights) {
    const observation = flight.initialLinkObservation;
    if (observation === undefined) continue;
    if (
      !keys(observation, ['version', 'state', 'occurredAt']) ||
      observation.version !== 'operation.command-link-baseline-observation.1' ||
      !linkState(observation.state) ||
      !flight.departureAt ||
      time(observation.occurredAt) < time(flight.departureAt) ||
      time(observation.occurredAt) > observedThrough
    )
      throw new Error('Monitoring initial link observation changed its version, state or clock');
  }
}

export function createOperationMonitoringObserver(
  world: OperationWorld,
  value: OperationMonitoringPlan,
): OperationMonitoringObserver {
  validatePlan(value);
  if (
    world.config.runId !== value.runId ||
    world.now !== time(world.config.start) ||
    world.nextFact !== 0 ||
    Object.values(world.counters).some((count) => count !== 0) ||
    world.facts.length ||
    world.demand.length ||
    world.attempts.length ||
    world.reservations?.length ||
    world.departureAllocations?.length ||
    world.departures?.length ||
    time(value.window.start) < world.now
  )
    throw new Error('Monitoring must begin prospectively on an entirely fresh operation world');
  const plan = clone(value);
  return {
    version: 'operation.monitoring-observer.1',
    plan,
    planJson: JSON.stringify(plan),
    startedAt: iso(world.now),
    observedThrough: iso(world.now),
    nextFact: 0,
    flights: plan.flights.map((flight) => ({
      ...flight,
      telemetryDeliveryAvailable: true,
      observedIntervals: [],
      coverageIntervals: [],
      gaps: [],
      reports: [],
    })),
  };
}

export function createFutureOperationMonitoringObserver(
  world: OperationWorld,
  value: OperationMonitoringPlan,
): OperationMonitoringObserver {
  validatePlan(value);
  const selected = value.flights[0];
  const demo = world.demoFlights?.find((flight) => flight.attemptId === selected?.attemptId);
  const reservation = world.reservations?.find((row) => row.id === selected?.attemptId);
  if (
    value.flights.length !== 1 ||
    !demo ||
    demo.tenant !== value.tenant ||
    world.config.runId !== value.runId ||
    !reservation ||
    reservation.phase !== 'awaiting-release' ||
    world.attempts.some((row) => row.id === demo.attemptId) ||
    world.departures?.some((row) => row.reservationId === demo.attemptId) ||
    time(value.window.start) <= world.now ||
    time(demo.createdAt) > world.now
  )
    throw new Error('Future monitoring requires one registered demo reservation before its physical departure');
  return {
    version: 'operation.monitoring-observer.1',
    futureDemo: { cycleId: demo.cycleId, registeredAt: demo.createdAt, firstFact: world.nextFact },
    plan: clone(value),
    planJson: JSON.stringify(value),
    startedAt: iso(world.now),
    observedThrough: iso(world.now),
    nextFact: world.nextFact,
    flights: value.flights.map((flight) => ({
      ...flight,
      telemetryDeliveryAvailable: true,
      latestMission: clone(reservation.plan),
      observedIntervals: [],
      coverageIntervals: [],
      gaps: [],
      reports: [],
    })),
  };
}

class ObservationError extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}
function fail(code: string, reason: string): never {
  throw new ObservationError(code, reason);
}
function appendInterval(values: OperationMonitoringInterval[], start: number, end: number): void {
  if (start >= end) return;
  const last = values.at(-1);
  if (last && time(last.end) === start) last.end = iso(end);
  else {
    if (values.length >= limits.intervals)
      fail('monitoring_bounds_exceeded', 'Monitoring intervals exceed the retained bound');
    values.push({ start: iso(start), end: iso(end) });
  }
}
function appendGap(
  flight: ObservedFlight,
  kind: 'c2_monitor' | 'telemetry_delivery',
  start: number,
  end: number,
): void {
  const intervals = flight.gaps.filter((gap) => gap.kind === kind).map((gap) => gap.interval);
  const previousLength = intervals.length;
  appendInterval(intervals, start, end);
  if (intervals.length !== previousLength) {
    if (flight.gaps.length >= limits.intervals)
      fail('monitoring_bounds_exceeded', 'Monitoring gaps exceed the retained bound');
    flight.gaps.push({ kind, interval: intervals.at(-1)! });
  }
  flight.gaps.sort(
    (left, right) => time(left.interval.start) - time(right.interval.start) || left.kind.localeCompare(right.kind),
  );
}
function observeInterval(observer: OperationMonitoringObserver, start: number, end: number): void {
  start = Math.max(start, time(observer.plan.window.start));
  end = Math.min(end, time(observer.plan.window.end));
  if (start >= end) return;
  for (const flight of observer.flights) {
    if (!flight.departureAt || flight.landingAt) continue;
    appendInterval(flight.observedIntervals, start, end);
    if (flight.monitoringAvailable) appendInterval(flight.coverageIntervals, start, end);
    else appendGap(flight, 'c2_monitor', start, end);
    if (!flight.telemetryDeliveryAvailable) appendGap(flight, 'telemetry_delivery', start, end);
  }
}
function bind(flight: ObservedFlight, aircraftId: string, sourceId: string, session: string): void {
  if (
    ![aircraftId, sourceId, session].every(id) ||
    (flight.aircraftId !== undefined && flight.aircraftId !== aircraftId) ||
    (flight.c2SourceId !== undefined && flight.c2SourceId !== sourceId) ||
    (flight.c2SourceSessionId !== undefined && flight.c2SourceSessionId !== session)
  )
    fail('monitoring_identity_changed', 'Selected flight changed its observed aircraft or C2 session');
  flight.aircraftId = aircraftId;
  flight.c2SourceId = sourceId;
  flight.c2SourceSessionId = session;
}
function observeFact(observer: OperationMonitoringObserver, fact: WorldFact): void {
  const flight = observer.flights.find((flight) => flight.attemptId === fact.attemptId);
  if (!flight || time(fact.at) >= time(observer.plan.window.end)) return;
  if (fact.tenant !== observer.plan.tenant)
    fail('monitoring_identity_changed', 'A selected source attempt belongs to another operator');
  if (fact.kind === 'mission' && !flight.departureAt) {
    validateOperationMissionSource(fact.source);
    if (fact.source.aircraftId !== fact.aircraftId || fact.source.sourceMissionId !== `${fact.attemptId}:mission`)
      fail('monitoring_identity_changed', 'A selected mission changed its source attempt or aircraft');
    if (
      flight.latestMission?.sourceRevision === fact.source.sourceRevision &&
      JSON.stringify(flight.latestMission) !== JSON.stringify(fact.source)
    )
      fail('monitoring_identity_changed', 'A selected mission revision changed its retained source');
    if (!flight.latestMission || fact.source.sourceRevision > flight.latestMission.sourceRevision) {
      flight.latestMission = clone(fact.source);
      flight.latestMissionOriginalBytesBase64 = fact.publicAcceptance?.originalBytesBase64;
    }
  } else if (fact.kind === 'departure') {
    if (flight.departureAt) fail('monitoring_identity_changed', 'A selected attempt departed more than once');
    bind(flight, fact.aircraftId, 'command-link', `${fact.sourceSessionId}-command-link-1`);
    if (flight.latestMission && flight.latestMission.aircraftId !== fact.aircraftId)
      fail('monitoring_identity_changed', 'The executed mission belongs to another aircraft');
    flight.departureAt = fact.at;
    // This is a prospective profile assumption, not a retained C2 source report.
    flight.baseline = { state: flight.initialLinkState, occurredAt: fact.at };
    if (flight.latestMission) {
      flight.executedMission = clone(flight.latestMission);
      if (flight.latestMissionOriginalBytesBase64)
        flight.executedMissionOriginalBytesBase64 = flight.latestMissionOriginalBytesBase64;
    }
    delete flight.latestMission;
    delete flight.latestMissionOriginalBytesBase64;
  } else if (fact.kind === 'landing') {
    if (!flight.departureAt || flight.landingAt || time(fact.at) <= time(flight.departureAt))
      fail('monitoring_history_missed', 'Selected landing has no unique observed departure');
    bind(flight, fact.aircraftId, 'command-link', `${fact.sourceSessionId}-command-link-1`);
    flight.landingAt = fact.at;
  } else if (fact.kind === 'command-link') {
    bind(flight, fact.aircraftId, fact.sourceId, fact.sourceSessionId);
    if (
      !id(fact.sourceEventId) ||
      !id(fact.incidentId) ||
      fact.sourceId !== 'command-link' ||
      !['lost', 'restored'].includes(fact.status) ||
      !Number.isFinite(fact.position?.longitude) ||
      Math.abs(fact.position.longitude) > 180 ||
      !Number.isFinite(fact.position?.latitude) ||
      Math.abs(fact.position.latitude) > 90 ||
      observer.flights.some((flight) => flight.reports.some((report) => report.sourceEventId === fact.sourceEventId))
    )
      fail('monitoring_identity_changed', 'Selected C2 source event identity is invalid or repeated');
    if (observer.flights.reduce((count, flight) => count + flight.reports.length, 0) >= limits.reports)
      fail('monitoring_bounds_exceeded', 'Selected C2 history exceeds 128 reports');
    flight.reports.push(clone(fact));
  }
}

export function observeOperationMonitoring(observer: OperationMonitoringObserver, world: OperationWorld): void {
  validateObserver(observer);
  if (observer.failure) return;
  const next = clone(observer);
  try {
    const previous = time(next.observedThrough);
    if (world.config.runId !== next.plan.runId || !sameMonitoringWorld(next, world))
      fail('monitoring_identity_changed', 'Monitoring belongs to another operation world');
    if (!Number.isSafeInteger(world.now) || world.now < previous)
      fail('monitoring_history_missed', 'The observed world clock moved backwards');
    if (next.completedAt) return;
    if (!Number.isSafeInteger(world.nextFact) || world.nextFact < next.nextFact)
      fail('monitoring_history_missed', 'The observed global fact sequence moved backwards');
    const facts = world.facts.filter((fact) => fact.sequence >= next.nextFact);
    if (facts.length !== world.nextFact - next.nextFact)
      fail('monitoring_history_missed', 'Global source facts were compacted or omitted before observation');
    let through = previous;
    for (const fact of facts) {
      if (fact.sequence !== next.nextFact)
        fail('monitoring_history_missed', 'Global source facts are missing, repeated or out of sequence');
      const at = time(fact.at);
      if (at < through || at > world.now)
        fail('monitoring_history_missed', 'A new source fact falls outside the prospective observation clock');
      if (!next.completedAt) {
        observeInterval(next, through, at);
        observeFact(next, fact);
      }
      through = at;
      next.nextFact++;
    }
    if (!next.completedAt) {
      observeInterval(next, through, world.now);
      if (world.now >= time(next.plan.window.end)) next.completedAt = iso(world.now);
    }
    next.observedThrough = iso(world.now);
    Object.assign(observer, next);
  } catch (error) {
    observer.failure = {
      code: error instanceof ObservationError ? error.code : 'monitoring_observation_invalid',
      reason: error instanceof Error ? error.message : 'Monitoring observation is invalid',
    };
  }
}

export function captureOperationMonitoringBaseline(
  observer: OperationMonitoringObserver,
  world: OperationWorld,
  attemptId: string,
  state: OperationMonitoringLinkState,
): OperationMonitoringBaselineObservation {
  validateObserver(observer);
  if (!linkState(state)) throw new Error('Monitoring initial link observation requires an explicit supported state');
  const flight = observer.flights.find((flight) => flight.attemptId === attemptId);
  if (
    world.config.runId !== observer.plan.runId ||
    !sameMonitoringWorld(observer, world) ||
    !Number.isSafeInteger(world.now) ||
    world.now < time(observer.observedThrough) ||
    !Number.isSafeInteger(world.nextFact) ||
    world.nextFact < observer.nextFact ||
    !flight ||
    !flight.departureAt ||
    !id(flight.aircraftId) ||
    flight.c2SourceId !== 'command-link' ||
    !id(flight.c2SourceSessionId)
  )
    throw new Error('Monitoring initial link observation requires the same bound departed selected flight');
  if (flight.initialLinkObservation) {
    if (flight.initialLinkObservation.state !== state)
      throw new Error('Monitoring initial link observation cannot replace its retained state');
    return clone(flight.initialLinkObservation);
  }
  if (
    observer.failure ||
    observer.completedAt ||
    flight.landingAt ||
    world.now !== time(observer.observedThrough) ||
    world.nextFact !== observer.nextFact ||
    flight.reports.length
  )
    throw new Error('Monitoring initial link observation requires a current open observer before any C2 report');
  const observation: OperationMonitoringBaselineObservation = {
    version: 'operation.command-link-baseline-observation.1',
    state,
    occurredAt: iso(world.now),
  };
  flight.initialLinkObservation = observation;
  return clone(observation);
}

export function setOperationMonitoringAvailability(
  observer: OperationMonitoringObserver,
  world: OperationWorld,
  attemptId: string,
  availability: OperationMonitoringAvailability,
): void {
  validateObserver(observer);
  const flight = observer.flights.find((flight) => flight.attemptId === attemptId);
  if (
    observer.failure ||
    observer.completedAt ||
    world.config.runId !== observer.plan.runId ||
    world.now !== time(observer.observedThrough) ||
    world.nextFact !== observer.nextFact ||
    !flight ||
    !keys(availability, [], ['monitoringAvailable', 'telemetryDeliveryAvailable']) ||
    !Object.keys(availability).length ||
    Object.values(availability).some((value) => typeof value !== 'boolean')
  )
    throw new Error('Monitoring availability can change only prospectively at the current observed clock');
  if (typeof availability.monitoringAvailable === 'boolean')
    flight.monitoringAvailable = availability.monitoringAvailable;
  if (typeof availability.telemetryDeliveryAvailable === 'boolean')
    flight.telemetryDeliveryAvailable = availability.telemetryDeliveryAvailable;
}

export function operationMonitoringSnapshot(observer: OperationMonitoringObserver): OperationMonitoringSnapshot {
  validateObserver(observer);
  return clone({
    version: 'operation.monitoring-snapshot.1',
    plan: observer.plan,
    startedAt: observer.startedAt,
    observedThrough: observer.observedThrough,
    ...(observer.completedAt ? { completedAt: observer.completedAt } : {}),
    nextFact: observer.nextFact,
    complete: !observer.failure && observer.completedAt !== undefined,
    ...(observer.failure ? { failure: observer.failure } : {}),
    flights: observer.flights.map(
      ({
        initialLinkState: _initial,
        monitoringAvailable: _monitor,
        telemetryDeliveryAvailable: _delivery,
        latestMission: _latest,
        latestMissionOriginalBytesBase64: _latestOriginal,
        ...flight
      }) => flight,
    ),
  });
}
