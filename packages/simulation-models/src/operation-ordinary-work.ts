import { entityRandom } from './index.js';
import type { OperationAttempt, OperationTenant, OperationWorld, WorldFact } from './operation.js';

export type OrdinaryIncidentKind = 'command-link' | 'landing-disagreement';
export interface OrdinaryIncidentReservation {
  attemptId: string;
  tenant: OperationTenant;
  kind: OrdinaryIncidentKind;
  aircraftId: string;
  sourceSessionId: string;
  incidentId: string;
  evidenceReceiptId?: string;
  flightId?: string;
  findingId?: string;
}
export interface OrdinaryIncidentBudget {
  checkedAt: string;
  tenants: Record<
    OperationTenant,
    {
      complete: boolean;
      unresolved: Record<OrdinaryIncidentKind, number>;
      reservations: Array<{
        attemptId: string;
        kind: OrdinaryIncidentKind;
        flightId: string;
        findingId?: string;
        status: 'unseen' | 'open' | 'acknowledged' | 'responding' | 'resolved';
      }>;
      reason?: string;
    }
  >;
}
export interface OrdinaryWorkState {
  version: 'upcoming-bounded-incidents.1';
  activatedAt: string;
  demandLeadMs: 900000;
  incidents: OrdinaryIncidentReservation[];
  baselineEstablished?: Partial<Record<OperationTenant, boolean>>;
  budget?: OrdinaryIncidentBudget;
}

const tenants = ['alpha', 'beta'] as const;
const kinds = ['command-link', 'landing-disagreement'] as const;
const capPerKind = 2;
const maximumObservations = 128;
const maximumBudgetAgeMs = 60_000;
const maximumClockLeadMs = 1000;
const groundNames = { alpha: 'Avery Collins', beta: 'Jordan Ellis' } as const;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error('Ordinary incident timestamps must use canonical UTC milliseconds');
  return parsed;
}

function identity(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new Error('Ordinary incidents require bounded source identities');
}

function incidentKind(value: OrdinaryIncidentKind): void {
  if (!kinds.includes(value)) throw new Error('Unknown ordinary incident kind');
}

function validateState(state: OrdinaryWorkState): void {
  if (
    state.version !== 'upcoming-bounded-incidents.1' ||
    state.demandLeadMs !== 900_000 ||
    !Array.isArray(state.incidents) ||
    state.incidents.length > tenants.length * kinds.length * capPerKind
  )
    throw new Error('Invalid bounded ordinary work state');
  timestamp(state.activatedAt);
  for (const tenant of tenants)
    if (state.baselineEstablished?.[tenant] !== undefined && typeof state.baselineEstablished[tenant] !== 'boolean')
      throw new Error('Ordinary incident baselines require operator completion flags');
  const attempts = new Set<string>();
  for (const reservation of state.incidents) {
    identity(reservation.attemptId);
    identity(reservation.aircraftId);
    identity(reservation.sourceSessionId);
    identity(reservation.incidentId);
    incidentKind(reservation.kind);
    if (!tenants.includes(reservation.tenant) || attempts.has(reservation.attemptId))
      throw new Error('Ordinary incident reservations require distinct operator attempts');
    attempts.add(reservation.attemptId);
    if (reservation.evidenceReceiptId !== undefined) identity(reservation.evidenceReceiptId);
    if (reservation.flightId !== undefined) identity(reservation.flightId);
    if (reservation.findingId !== undefined) {
      identity(reservation.findingId);
      if (!reservation.flightId || !reservation.evidenceReceiptId)
        throw new Error('An ordinary finding must pin its flight and emitted evidence receipt');
    }
  }
  for (const tenant of tenants)
    for (const kind of kinds)
      if (state.incidents.filter((row) => row.tenant === tenant && row.kind === kind).length > capPerKind)
        throw new Error('Ordinary incident reservations exceed their operator cap');
}

function copyBudget(value: OrdinaryIncidentBudget): OrdinaryIncidentBudget {
  timestamp(value.checkedAt);
  const copy: OrdinaryIncidentBudget = {
    checkedAt: value.checkedAt,
    tenants: {} as OrdinaryIncidentBudget['tenants'],
  };
  const attempts = new Set<string>();
  const findings = new Set<string>();
  for (const tenant of tenants) {
    const budget = value.tenants?.[tenant];
    if (
      !budget ||
      typeof budget.complete !== 'boolean' ||
      !Array.isArray(budget.reservations) ||
      budget.reservations.length > maximumObservations
    )
      throw new Error('Ordinary incident budgets require bounded operator observations');
    for (const kind of kinds)
      if (!Number.isSafeInteger(budget.unresolved?.[kind]) || budget.unresolved[kind] < 0)
        throw new Error('Ordinary incident counts must be nonnegative safe integers');
    if (budget.reason !== undefined && (typeof budget.reason !== 'string' || budget.reason.length > 1000))
      throw new Error('Ordinary incident budget reasons must be bounded text');
    const reservations = budget.reservations.map((row) => {
      identity(row.attemptId);
      incidentKind(row.kind);
      identity(row.flightId);
      if (attempts.has(row.attemptId)) throw new Error('An ordinary observation must identify one attempt');
      attempts.add(row.attemptId);
      if (!['unseen', 'open', 'acknowledged', 'responding', 'resolved'].includes(row.status))
        throw new Error('Unknown ordinary finding treatment status');
      if (row.status === 'unseen') {
        if (row.findingId !== undefined) throw new Error('An unseen ordinary finding cannot pin a finding');
      } else {
        identity(row.findingId!);
        if (findings.has(row.findingId!)) throw new Error('Ordinary observations must identify distinct findings');
        findings.add(row.findingId!);
      }
      return {
        attemptId: row.attemptId,
        kind: row.kind,
        flightId: row.flightId,
        ...(row.findingId !== undefined ? { findingId: row.findingId } : {}),
        status: row.status,
      };
    });
    if (budget.complete)
      for (const kind of kinds)
        if (
          reservations.filter((row) => row.kind === kind && row.status !== 'unseen' && row.status !== 'resolved')
            .length > budget.unresolved[kind]
        )
          throw new Error('A complete ordinary budget must count every unresolved finding proof');
    copy.tenants[tenant] = {
      complete: budget.complete,
      unresolved: {
        'command-link': budget.unresolved['command-link'],
        'landing-disagreement': budget.unresolved['landing-disagreement'],
      },
      reservations,
      ...(budget.reason !== undefined ? { reason: budget.reason } : {}),
    };
  }
  return copy;
}

function budgetFresh(world: OperationWorld, state: OrdinaryWorkState): boolean {
  if (!state.budget) return false;
  const age = world.now - timestamp(state.budget.checkedAt);
  return age >= -maximumClockLeadMs && age <= maximumBudgetAgeMs;
}

function counts(world: OperationWorld, tenant: OperationTenant) {
  const state = world.ordinaryWork!;
  const budget = state.budget?.tenants[tenant];
  const pending = { 'command-link': 0, 'landing-disagreement': 0 };
  for (const reservation of state.incidents.filter((row) => row.tenant === tenant)) {
    const represented = budget?.reservations.some(
      (row) =>
        row.attemptId === reservation.attemptId &&
        row.kind === reservation.kind &&
        row.flightId === reservation.flightId &&
        row.findingId !== undefined &&
        row.findingId === reservation.findingId &&
        row.status !== 'unseen' &&
        row.status !== 'resolved',
    );
    if (!represented) pending[reservation.kind]++;
  }
  const unresolved = budget?.unresolved ?? { 'command-link': 0, 'landing-disagreement': 0 };
  return {
    pending,
    unresolved: { ...unresolved },
    effective: {
      'command-link': unresolved['command-link'] + pending['command-link'],
      'landing-disagreement': unresolved['landing-disagreement'] + pending['landing-disagreement'],
    },
  };
}

function reservationForAttempt(attempt: OperationAttempt, kind: OrdinaryIncidentKind): OrdinaryIncidentReservation {
  return {
    attemptId: attempt.id,
    tenant: attempt.tenant,
    kind,
    aircraftId: attempt.aircraftId,
    sourceSessionId: `${attempt.sourceSessionId}${kind === 'command-link' ? '-command-link-1' : '-buffered-person'}`,
    incidentId: `${attempt.id}:${kind === 'command-link' ? 'radio-interruption:1' : 'landing-disagreement'}`,
  };
}

export function enableOperationOrdinaryWork(
  world: OperationWorld,
  pendingFacts: readonly WorldFact[] = [],
): OrdinaryWorkState {
  const config = world.config;
  if (
    world.version !== 'operation-world.2' ||
    world.resources ||
    config.capacity ||
    config.predeparture ||
    config.commandLinkEpisode ||
    world.commandLinkEpisode ||
    config.simulatedLink ||
    config.profile ||
    world.telemetryDeliveryInterruption ||
    config.fleet.alpha !== 3 ||
    config.fleet.beta !== 2 ||
    config.demandIntervalMs !== 150_000 ||
    config.sampleIntervalMs !== 10_000
  )
    throw new Error('Bounded ordinary work requires the ordinary 3 Alpha / 2 Beta operation profile');
  if (world.ordinaryWork) {
    validateState(world.ordinaryWork);
    return world.ordinaryWork;
  }
  const incidents: OrdinaryIncidentReservation[] = [];
  for (const event of world.events) {
    if (event.kind !== 'landing-report' || incidents.some((row) => row.attemptId === event.attemptId)) continue;
    const attempt = world.attempts.find((row) => row.id === event.attemptId);
    if (!attempt) throw new Error('A scheduled ordinary landing report must retain its original attempt');
    incidents.push(reservationForAttempt(attempt, 'landing-disagreement'));
  }
  for (const fact of [...world.facts, ...pendingFacts]) {
    if (fact.kind !== 'landing-report') continue;
    const existing = incidents.find((row) => row.attemptId === fact.attemptId);
    if (existing) {
      if (
        existing.tenant !== fact.tenant ||
        existing.aircraftId !== fact.aircraftId ||
        existing.sourceSessionId !== fact.sourceSessionId ||
        existing.incidentId !== fact.incidentId
      )
        throw new Error('A pending ordinary landing report cannot replace its source identity');
      continue;
    }
    incidents.push({
      attemptId: fact.attemptId,
      tenant: fact.tenant,
      kind: 'landing-disagreement',
      aircraftId: fact.aircraftId,
      sourceSessionId: fact.sourceSessionId,
      incidentId: fact.incidentId,
    });
  }
  const state: OrdinaryWorkState = {
    version: 'upcoming-bounded-incidents.1',
    activatedAt: new Date(world.now).toISOString(),
    demandLeadMs: 900_000,
    incidents,
    baselineEstablished: {},
  };
  validateState(state);
  const people = tenants.map((tenant) => ({
    id: `${config.runId}-person-${tenant}-ground`,
    tenant,
    name: groundNames[tenant],
  }));
  for (const person of people) {
    const existing = world.people.find((row) => row.id === person.id);
    if (existing && (existing.tenant !== person.tenant || existing.name !== person.name))
      throw new Error('The ordinary ground reporter identity already names another person');
  }
  world.people.push(...people.filter((person) => !world.people.some((row) => row.id === person.id)));
  world.ordinaryWork = state;
  return state;
}

export function reserveOrdinaryIncident(
  world: OperationWorld,
  attempt: OperationAttempt,
): OrdinaryIncidentKind | undefined {
  const state = world.ordinaryWork;
  if (!state) return undefined;
  const existing = state.incidents.find((row) => row.attemptId === attempt.id);
  if (existing) {
    if (existing.tenant !== attempt.tenant) throw new Error('An ordinary reservation cannot change operator');
    return existing.kind;
  }
  if (attempt.ordinaryIncident || attempt.phase !== 'flying') return undefined;
  if (!tenants.includes(attempt.tenant)) throw new Error('Unknown ordinary incident operator');
  identity(attempt.id);
  const budget = state.budget?.tenants[attempt.tenant];
  if (!budget?.complete || !budgetFresh(world, state)) return undefined;
  const roll = entityRandom(world.config.seed, `${attempt.id}:ordinary-incident`)();
  const kind = roll < 0.05 ? 'command-link' : roll < 0.1 ? 'landing-disagreement' : undefined;
  if (!kind || counts(world, attempt.tenant).effective[kind] >= capPerKind) return undefined;
  const reservation = reservationForAttempt(attempt, kind);
  identity(reservation.aircraftId);
  identity(reservation.sourceSessionId);
  identity(reservation.incidentId);
  state.incidents.push(reservation);
  return kind;
}

export function scheduleOrdinaryIncident(
  world: OperationWorld,
  attempt: OperationAttempt,
): OrdinaryIncidentKind | undefined {
  const kind = reserveOrdinaryIncident(world, attempt);
  if (!kind || attempt.ordinaryIncident) return kind;
  if (kind === 'command-link') {
    const departure = Date.parse(attempt.departure);
    const duration = Date.parse(attempt.landing) - departure;
    const lostAt = departure + Math.min(60_000, Math.floor(duration / 3));
    const restoredAt = lostAt + 30_000;
    attempt.ordinaryIncident = {
      kind,
      incidentId: `${attempt.id}:radio-interruption:1`,
      lostAt: new Date(lostAt).toISOString(),
      restoredAt: new Date(restoredAt).toISOString(),
    };
    attempt.simulatedLink = { version: 'simulated-link.1', state: 'up', changedAt: attempt.departure };
    world.events.push(
      { kind: 'ordinary-command-link-lost', at: lostAt, attemptId: attempt.id, sequence: world.nextEvent++ },
      { kind: 'ordinary-command-link-restored', at: restoredAt, attemptId: attempt.id, sequence: world.nextEvent++ },
    );
    world.events.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
  } else attempt.ordinaryIncident = { kind };
  return kind;
}

export function recordOrdinaryIncidentReceipt(world: OperationWorld, fact: WorldFact, receiptId: string): void {
  const kind =
    fact.kind === 'landing-report'
      ? 'landing-disagreement'
      : fact.kind === 'command-link' && fact.status === 'lost'
        ? 'command-link'
        : undefined;
  if (!kind) return;
  const reservation = world.ordinaryWork?.incidents.find(
    (row) => row.attemptId === fact.attemptId && row.kind === kind,
  );
  if (!reservation) return;
  if (fact.kind !== 'landing-report' && fact.kind !== 'command-link') return;
  identity(receiptId);
  if (
    reservation.tenant !== fact.tenant ||
    reservation.aircraftId !== fact.aircraftId ||
    reservation.sourceSessionId !== fact.sourceSessionId ||
    reservation.incidentId !== fact.incidentId ||
    (reservation.evidenceReceiptId !== undefined && reservation.evidenceReceiptId !== receiptId)
  )
    throw new Error('An ordinary incident receipt must retain its exact emitted source identity');
  reservation.evidenceReceiptId = receiptId;
}

export function applyOrdinaryIncidentBudget(world: OperationWorld, value: OrdinaryIncidentBudget): void {
  const state = world.ordinaryWork;
  if (!state) throw new Error('Ordinary work must be enabled before observing incident capacity');
  const budget = copyBudget(value);
  if (state.budget && timestamp(budget.checkedAt) < timestamp(state.budget.checkedAt))
    throw new Error('Ordinary incident observations cannot move backward in time');
  const incidents: OrdinaryIncidentReservation[] = [];
  for (const reservation of state.incidents) {
    const observation = budget.tenants[reservation.tenant].reservations.find(
      (row) => row.attemptId === reservation.attemptId && row.kind === reservation.kind,
    );
    if (!observation) {
      incidents.push({ ...reservation });
      continue;
    }
    if (
      (reservation.flightId !== undefined && reservation.flightId !== observation.flightId) ||
      (reservation.findingId !== undefined &&
        observation.findingId !== undefined &&
        reservation.findingId !== observation.findingId)
    )
      throw new Error('An ordinary incident observation cannot replace its pinned flight or finding');
    if (observation.findingId !== undefined && reservation.evidenceReceiptId === undefined)
      throw new Error('An ordinary finding must be witnessed by the emitted evidence receipt');
    if (observation.status === 'resolved') continue;
    incidents.push({
      ...reservation,
      flightId: observation.flightId,
      ...(observation.findingId !== undefined ? { findingId: observation.findingId } : {}),
    });
  }
  state.incidents = incidents;
  state.budget = budget;
  state.baselineEstablished = { ...state.baselineEstablished };
  for (const tenant of tenants) if (budget.tenants[tenant].complete) state.baselineEstablished[tenant] = true;
}

export function ordinaryWorkStatus(world: OperationWorld) {
  const state = world.ordinaryWork;
  if (!state) return {};
  const fresh = budgetFresh(world, state);
  const tenantStatus = (tenant: OperationTenant) => {
    const budget = state.budget?.tenants[tenant];
    const current = counts(world, tenant);
    const blocked = {
      'command-link': !fresh || !budget?.complete || current.effective['command-link'] >= capPerKind,
      'landing-disagreement': !fresh || !budget?.complete || current.effective['landing-disagreement'] >= capPerKind,
    };
    return {
      complete: budget?.complete ?? false,
      baselineEstablished: state.baselineEstablished?.[tenant] === true,
      fresh,
      ...(state.budget ? { checkedAt: state.budget.checkedAt } : {}),
      ...(budget?.reason !== undefined ? { reason: budget.reason } : {}),
      ...current,
      capPerKind,
      blocked,
      available: {
        'command-link': blocked['command-link'] ? 0 : Math.max(0, capPerKind - current.effective['command-link']),
        'landing-disagreement': blocked['landing-disagreement']
          ? 0
          : Math.max(0, capPerKind - current.effective['landing-disagreement']),
      },
    };
  };
  return {
    ordinaryWork: {
      version: state.version,
      activatedAt: state.activatedAt,
      demandLeadMs: state.demandLeadMs,
      tenants: { alpha: tenantStatus('alpha'), beta: tenantStatus('beta') },
    },
  };
}
