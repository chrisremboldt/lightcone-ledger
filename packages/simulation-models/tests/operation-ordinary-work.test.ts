import { describe, expect, it } from 'vitest';
import { entityRandom } from '../src/index.js';
import {
  createOperation,
  type OperationAttempt,
  type OperationTenant,
  type OperationWorld,
  type WorldFact,
} from '../src/operation.js';
import {
  applyOrdinaryIncidentBudget,
  enableOperationOrdinaryWork,
  ordinaryWorkStatus,
  recordOrdinaryIncidentReceipt,
  reserveOrdinaryIncident,
  type OrdinaryIncidentBudget,
  type OrdinaryIncidentKind,
} from '../src/operation-ordinary-work.js';

const start = Date.parse('2026-10-17T14:00:00.000Z');
const iso = (offset = 0) => new Date(start + offset).toISOString();

function fresh(runId: string) {
  return createOperation({ runId, start: iso(), demandIntervalMs: 150_000, fleet: { alpha: 3, beta: 2 } });
}

function attempt(world: OperationWorld, index: number, tenant: OperationTenant = 'alpha'): OperationAttempt {
  const intentId = `intent-${world.config.runId}-${tenant}-${index}`;
  return {
    id: `${intentId}:attempt:1`,
    intentId,
    demandId: `order-${intentId}`,
    tenant,
    aircraftId: `DJI-${world.config.runId}-${tenant}-01`,
    personId: `${world.config.runId}-person-${tenant}-01`,
    sourceSessionId: `${intentId}-capture-1`,
    siteId: world.sites[0].id,
    origin: { longitude: -87.63, latitude: 41.88 },
    destination: { longitude: -87.62, latitude: 41.89 },
    departure: iso(),
    landing: iso(120_000),
    travelMs: 120_000,
    phase: 'flying',
  };
}

function candidates(world: OperationWorld, kind: OrdinaryIncidentKind, tenant: OperationTenant = 'alpha') {
  const selected: OperationAttempt[] = [];
  for (let index = 0; index < 10_000 && selected.length < 3; index++) {
    const candidate = attempt(world, index, tenant);
    const roll = entityRandom(world.config.seed, `${candidate.id}:ordinary-incident`)();
    if (kind === 'command-link' ? roll < 0.05 : roll >= 0.05 && roll < 0.1) selected.push(candidate);
  }
  if (selected.length !== 3) throw new Error('Fixture seed must supply three selected incidents');
  return selected;
}

function budget(world: OperationWorld): OrdinaryIncidentBudget {
  const tenant = () => ({
    complete: true,
    unresolved: { 'command-link': 0, 'landing-disagreement': 0 },
    reservations: [],
  });
  return { checkedAt: new Date(world.now).toISOString(), tenants: { alpha: tenant(), beta: tenant() } };
}

function report(selected: OperationAttempt): Extract<WorldFact, { kind: 'landing-report' }> {
  return {
    kind: 'landing-report',
    sequence: 1,
    at: iso(210_000),
    tenant: selected.tenant,
    attemptId: selected.id,
    aircraftId: selected.aircraftId,
    sourceSessionId: `${selected.sourceSessionId}-buffered-person`,
    sourceId: `simulation-person-${selected.tenant}-buffered`,
    incidentId: `${selected.id}:landing-disagreement`,
    incidentCause: 'handset-clock-offset',
    reportAt: iso(210_000),
    reportedLandingAt: iso(150_000),
    personId: `ground-${selected.tenant}`,
    personName: 'Ground reporter',
  };
}

function loss(selected: OperationAttempt): Extract<WorldFact, { kind: 'command-link' }> {
  return {
    kind: 'command-link',
    sequence: 1,
    at: iso(30_000),
    tenant: selected.tenant,
    attemptId: selected.id,
    aircraftId: selected.aircraftId,
    sourceSessionId: `${selected.sourceSessionId}-command-link-1`,
    sourceId: 'command-link',
    sourceEventId: `${selected.id}:lost`,
    incidentId: `${selected.id}:radio-interruption:1`,
    status: 'lost',
    position: selected.origin,
  };
}

describe('bounded ordinary incident policy', () => {
  it('activates additively and retains scheduled and compacted pending landing reports', () => {
    const world = fresh('ordinary-enable');
    const scheduled = attempt(world, 0);
    const compacted = attempt(world, 1);
    world.attempts.push(scheduled);
    world.events.push({
      kind: 'landing-report',
      at: start + 210_000,
      sequence: world.nextEvent++,
      attemptId: scheduled.id,
    });
    world.facts.push(report(scheduled));
    const original = structuredClone(world);
    const state = enableOperationOrdinaryWork(world, [report(compacted)]);
    expect(state.incidents.map((row) => row.attemptId)).toEqual([scheduled.id, compacted.id]);
    expect(state.incidents[1]).toMatchObject({
      aircraftId: compacted.aircraftId,
      sourceSessionId: `${compacted.sourceSessionId}-buffered-person`,
      incidentId: `${compacted.id}:landing-disagreement`,
    });
    expect(world.people.slice(-2)).toEqual([
      { id: 'ordinary-enable-person-alpha-ground', tenant: 'alpha', name: 'Avery Collins' },
      { id: 'ordinary-enable-person-beta-ground', tenant: 'beta', name: 'Jordan Ellis' },
    ]);
    expect({ ...world, people: original.people, ordinaryWork: undefined }).toEqual({
      ...original,
      ordinaryWork: undefined,
    });
    expect(enableOperationOrdinaryWork(world)).toBe(state);
    expect(world.people).toHaveLength(original.people.length + 2);
    const unsupported = fresh('ordinary-unsupported');
    unsupported.config.demandIntervalMs = 30_000;
    const before = structuredClone(unsupported);
    expect(() => enableOperationOrdinaryWork(unsupported)).toThrow('ordinary 3 Alpha / 2 Beta');
    expect(unsupported).toEqual(before);
  });

  it('reserves at most two of each kind per operator across repeated public observations and restart', () => {
    let world = fresh('ordinary-cap');
    enableOperationOrdinaryWork(world);
    for (const tenant of ['alpha', 'beta'] as const) {
      for (const kind of ['command-link', 'landing-disagreement'] as const) {
        const selected = candidates(world, kind, tenant);
        for (let index = 0; index < selected.length; index++) {
          applyOrdinaryIncidentBudget(world, budget(world));
          expect(reserveOrdinaryIncident(world, selected[index])).toBe(index < 2 ? kind : undefined);
        }
      }
    }
    expect(world.ordinaryWork!.incidents).toHaveLength(8);
    const before = structuredClone(world);
    world = JSON.parse(JSON.stringify(world)) as OperationWorld;
    const selected = candidates(world, 'command-link')[0];
    expect(reserveOrdinaryIncident(world, selected)).toBe('command-link');
    expect(world).toEqual(before);
    expect(ordinaryWorkStatus(world)).toMatchObject({
      ordinaryWork: {
        tenants: { alpha: { effective: { 'command-link': 2, 'landing-disagreement': 2 }, capPerKind: 2 } },
      },
    });
  });

  it('retains unseen and responding slots and releases only the exact resolved finding', () => {
    const world = fresh('ordinary-proof');
    enableOperationOrdinaryWork(world);
    applyOrdinaryIncidentBudget(world, budget(world));
    const [first, second, third] = candidates(world, 'command-link');
    reserveOrdinaryIncident(world, first);
    const unseen = budget(world);
    unseen.tenants.alpha.reservations.push({
      attemptId: first.id,
      kind: 'command-link',
      flightId: 'flight-1',
      status: 'unseen',
    });
    applyOrdinaryIncidentBudget(world, unseen);
    expect(world.ordinaryWork!.incidents[0]).toMatchObject({ flightId: 'flight-1' });
    expect(reserveOrdinaryIncident(world, second)).toBe('command-link');
    expect(reserveOrdinaryIncident(world, third)).toBeUndefined();
    recordOrdinaryIncidentReceipt(world, loss(first), 'receipt-1');
    const responding = budget(world);
    responding.tenants.alpha.unresolved['command-link'] = 1;
    responding.tenants.alpha.reservations.push({
      attemptId: first.id,
      kind: 'command-link',
      flightId: 'flight-1',
      findingId: 'finding-1',
      status: 'responding',
    });
    applyOrdinaryIncidentBudget(world, responding);
    expect(ordinaryWorkStatus(world)).toMatchObject({
      ordinaryWork: { tenants: { alpha: { pending: { 'command-link': 1 }, effective: { 'command-link': 2 } } } },
    });
    expect(reserveOrdinaryIncident(world, third)).toBeUndefined();
    applyOrdinaryIncidentBudget(world, budget(world));
    expect(reserveOrdinaryIncident(world, third)).toBeUndefined();
    const resolved = budget(world);
    resolved.tenants.alpha.reservations.push({ ...responding.tenants.alpha.reservations[0], status: 'resolved' });
    applyOrdinaryIncidentBudget(world, resolved);
    expect(world.ordinaryWork!.incidents.some((row) => row.attemptId === first.id)).toBe(false);
    expect(reserveOrdinaryIncident(world, third)).toBe('command-link');
    first.ordinaryIncident = {
      kind: 'command-link',
      incidentId: `${first.id}:radio-interruption:1`,
      lostAt: iso(30_000),
      restoredAt: iso(60_000),
    };
    expect(reserveOrdinaryIncident(world, first)).toBeUndefined();
  });

  it('pins emitted receipts and rejects conflicting or older observations without changing retained state', () => {
    const world = fresh('ordinary-binding');
    enableOperationOrdinaryWork(world);
    applyOrdinaryIncidentBudget(world, budget(world));
    const selected = candidates(world, 'landing-disagreement')[0];
    reserveOrdinaryIncident(world, selected);
    const observed = budget(world);
    observed.tenants.alpha.unresolved['landing-disagreement'] = 1;
    observed.tenants.alpha.reservations.push({
      attemptId: selected.id,
      kind: 'landing-disagreement',
      flightId: 'flight-1',
      findingId: 'finding-1',
      status: 'open',
    });
    const unbound = structuredClone(world.ordinaryWork);
    expect(() => applyOrdinaryIncidentBudget(world, observed)).toThrow('emitted evidence receipt');
    expect(world.ordinaryWork).toEqual(unbound);
    expect(() =>
      recordOrdinaryIncidentReceipt(world, { ...report(selected), sourceSessionId: 'another-session' }, 'receipt-1'),
    ).toThrow('exact emitted source');
    recordOrdinaryIncidentReceipt(world, report(selected), 'receipt-1');
    recordOrdinaryIncidentReceipt(world, report(selected), 'receipt-1');
    expect(() => recordOrdinaryIncidentReceipt(world, report(selected), 'another-receipt')).toThrow(
      'exact emitted source',
    );
    applyOrdinaryIncidentBudget(world, observed);
    const pinned = structuredClone(world.ordinaryWork);
    const conflict = structuredClone(observed);
    conflict.tenants.alpha.reservations[0].findingId = 'another-finding';
    conflict.tenants.alpha.reservations[0].status = 'resolved';
    expect(() => applyOrdinaryIncidentBudget(world, conflict)).toThrow('pinned flight or finding');
    const older = budget(world);
    older.checkedAt = iso(-1);
    expect(() => applyOrdinaryIncidentBudget(world, older)).toThrow('backward in time');
    expect(world.ordinaryWork).toEqual(pinned);
  });

  it('requires a complete fresh budget for the matching operator with only one second of clock tolerance', () => {
    const world = fresh('ordinary-fresh');
    enableOperationOrdinaryWork(world);
    expect(world.ordinaryWork!.baselineEstablished).toEqual({});
    const [first, second] = candidates(world, 'command-link');
    expect(reserveOrdinaryIncident(world, first)).toBeUndefined();
    const incomplete = budget(world);
    incomplete.tenants.alpha.complete = false;
    applyOrdinaryIncidentBudget(world, incomplete);
    expect(world.ordinaryWork!.baselineEstablished).toEqual({ beta: true });
    expect(reserveOrdinaryIncident(world, first)).toBeUndefined();
    expect(reserveOrdinaryIncident(world, candidates(world, 'command-link', 'beta')[0])).toBe('command-link');
    const ahead = budget(world);
    ahead.checkedAt = iso(1000);
    applyOrdinaryIncidentBudget(world, ahead);
    expect(world.ordinaryWork!.baselineEstablished).toEqual({ alpha: true, beta: true });
    expect(reserveOrdinaryIncident(world, first)).toBe('command-link');
    world.now = start + 61_001;
    expect(reserveOrdinaryIncident(world, second)).toBeUndefined();
    const tooFarAhead = budget(world);
    tooFarAhead.checkedAt = new Date(world.now + 1001).toISOString();
    applyOrdinaryIncidentBudget(world, tooFarAhead);
    expect(reserveOrdinaryIncident(world, second)).toBeUndefined();
    world.now++;
    expect(reserveOrdinaryIncident(world, second)).toBe('command-link');
    const laterFailure = budget(world);
    laterFailure.checkedAt = tooFarAhead.checkedAt;
    laterFailure.tenants.alpha.complete = false;
    laterFailure.tenants.beta.complete = false;
    applyOrdinaryIncidentBudget(world, laterFailure);
    expect(world.ordinaryWork!.baselineEstablished).toEqual({ alpha: true, beta: true });
  });
});
