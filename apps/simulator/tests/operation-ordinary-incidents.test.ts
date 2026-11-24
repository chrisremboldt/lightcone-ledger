import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  applyOrdinaryIncidentBudget,
  compactOperation,
  createOperation,
  enableOperationOrdinaryWork,
  operationCommandLinkReading,
  type OperationAttempt,
  type OperationWorld,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';

const start = Date.parse('2026-10-19T14:00:00.000Z');
const stepMs = 30_000;
const horizonMs = 48 * 60 * 60_000;
type RadioFact = Extract<WorldFact, { kind: 'command-link' }>;
type FaultFact = Extract<WorldFact, { kind: 'command-link' | 'landing-report' }>;

function fresh(runId: string): OperationWorld {
  const world = createOperation({
    runId,
    seed: 71031,
    start: new Date(start).toISOString(),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
    sampleIntervalMs: 10_000,
  });
  enableOperationOrdinaryWork(world);
  return world;
}

function advanceWithEmptyPublicBudget(world: OperationWorld, at: number): void {
  const tenant = () => ({
    complete: true,
    unresolved: { 'command-link': 0, 'landing-disagreement': 0 },
    reservations: [],
  });
  applyOrdinaryIncidentBudget(world, {
    checkedAt: new Date(world.now).toISOString(),
    tenants: { alpha: tenant(), beta: tenant() },
  });
  advanceOperation(world, at);
}

describe('ordinary operation incident execution', () => {
  it('executes a seeded radio interruption on its actual radio without changing physical flight timing', () => {
    const world = fresh('ordinary-radio-execution');
    let selected: OperationAttempt | undefined;
    for (let elapsed = stepMs; elapsed <= horizonMs && !selected; elapsed += stepMs) {
      advanceWithEmptyPublicBudget(world, start + elapsed);
      selected = world.attempts.find(
        (attempt) =>
          attempt.ordinaryIncident?.kind === 'command-link' && Date.parse(attempt.ordinaryIncident.lostAt) > world.now,
      );
      compactOperation(world);
    }
    if (selected?.ordinaryIncident?.kind !== 'command-link')
      throw new Error('Seed did not produce a live radio interruption');
    const incident = structuredClone(selected.ordinaryIncident);
    const landing = selected.landing;
    const aircraft = world.aircraft.find((row) => row.id === selected!.aircraftId)!;
    const availableAt = aircraft.availableAt;
    const landingEvent = structuredClone(
      world.events.find((event) => event.kind === 'landing' && event.attemptId === selected!.id),
    );
    const duration = Date.parse(landing) - Date.parse(selected.departure);
    expect(Date.parse(incident.lostAt) - Date.parse(selected.departure)).toBe(
      Math.min(60_000, Math.floor(duration / 3)),
    );
    expect(Date.parse(incident.restoredAt) - Date.parse(incident.lostAt)).toBe(30_000);
    expect(selected.commandLinkHold).toBeUndefined();
    const reports: RadioFact[] = [];
    for (const [at, state] of [
      [Date.parse(incident.lostAt) - 1, 'up'],
      [Date.parse(incident.lostAt), 'down'],
      [Date.parse(incident.restoredAt) - 1, 'down'],
      [Date.parse(incident.restoredAt), 'up'],
    ] as const) {
      advanceWithEmptyPublicBudget(world, at);
      expect(operationCommandLinkReading(world, selected.id)).toMatchObject({
        state,
        occurredAt: new Date(at).toISOString(),
        sourceSessionId: `${selected.sourceSessionId}-command-link-1`,
        aircraftId: selected.aircraftId,
      });
      expect(selected.landing).toBe(landing);
      expect(aircraft.availableAt).toBe(availableAt);
      expect(selected.commandLinkHold).toBeUndefined();
      expect(world.events.find((event) => event.kind === 'landing' && event.attemptId === selected!.id)).toEqual(
        landingEvent,
      );
      reports.push(
        ...world.facts.filter(
          (fact): fact is RadioFact => fact.kind === 'command-link' && fact.attemptId === selected!.id,
        ),
      );
      compactOperation(world);
    }
    expect(reports.map((fact) => [fact.status, fact.at])).toEqual([
      ['lost', incident.lostAt],
      ['restored', incident.restoredAt],
    ]);
    for (const report of reports)
      expect(report).toMatchObject({
        tenant: selected.tenant,
        attemptId: selected.id,
        aircraftId: selected.aircraftId,
        sourceId: 'command-link',
        sourceSessionId: `${selected.sourceSessionId}-command-link-1`,
        sourceEventId: `${selected.id}:command-link:${report.status}`,
        incidentId: incident.incidentId,
      });
  });

  it('retains both operator incident caps across restart while normal flights and attributed landing reports continue', () => {
    let world = fresh('ordinary-both-operator-caps');
    const faults: FaultFact[] = [];
    const attempts = new Map<string, OperationAttempt>();
    const physicalLandings = new Map<string, string>();
    let restarted = false;
    const retainFaults = () => {
      const reservedIds = new Set(world.ordinaryWork!.incidents.map((incident) => incident.attemptId));
      for (const attempt of world.attempts) {
        if (!reservedIds.has(attempt.id)) continue;
        if (!attempts.has(attempt.id)) attempts.set(attempt.id, structuredClone(attempt));
        expect(attempt.commandLinkHold).toBeUndefined();
      }
      for (const fact of world.facts) {
        if (fact.kind === 'command-link' || fact.kind === 'landing-report') faults.push(structuredClone(fact));
        else if (fact.kind === 'landing' && reservedIds.has(fact.attemptId))
          physicalLandings.set(fact.attemptId, fact.at);
      }
      compactOperation(world);
    };
    for (let elapsed = stepMs; elapsed <= horizonMs && world.ordinaryWork!.incidents.length < 8; elapsed += stepMs) {
      advanceWithEmptyPublicBudget(world, start + elapsed);
      retainFaults();
      if (!restarted && world.ordinaryWork!.incidents.length >= 4) {
        const reservations = structuredClone(world.ordinaryWork!.incidents);
        world = JSON.parse(JSON.stringify(world)) as OperationWorld;
        expect(world.ordinaryWork!.incidents).toEqual(reservations);
        restarted = true;
      }
    }
    expect(restarted).toBe(true);
    const reservations = structuredClone(world.ordinaryWork!.incidents);
    expect(reservations).toHaveLength(8);
    expect(new Set(reservations.map((reservation) => reservation.attemptId)).size).toBe(8);
    for (const tenant of ['alpha', 'beta'] as const)
      for (const kind of ['command-link', 'landing-disagreement'] as const)
        expect(
          reservations.filter((reservation) => reservation.tenant === tenant && reservation.kind === kind),
        ).toHaveLength(2);
    const before = structuredClone(world.counters);
    const capAt = world.now;
    for (let elapsed = stepMs; elapsed <= 2 * 60 * 60_000; elapsed += stepMs) {
      advanceWithEmptyPublicBudget(world, capAt + elapsed);
      retainFaults();
      expect(world.ordinaryWork!.incidents).toEqual(reservations);
    }
    expect(world.counters.attempts).toBeGreaterThan(before.attempts);
    expect(world.counters.landed).toBeGreaterThan(before.landed);
    expect(faults).toHaveLength(12);
    for (const reservation of reservations) {
      const attempt = attempts.get(reservation.attemptId)!;
      expect(attempt).toMatchObject({
        tenant: reservation.tenant,
        aircraftId: reservation.aircraftId,
        ordinaryIncident: { kind: reservation.kind },
      });
      const emitted = faults.filter((fact) => fact.attemptId === reservation.attemptId);
      if (reservation.kind === 'command-link') {
        expect(emitted).toHaveLength(2);
        const incident = attempt.ordinaryIncident;
        if (incident?.kind !== 'command-link') throw new Error('Radio attempt metadata missing');
        expect(emitted.map((fact) => (fact.kind === 'command-link' ? [fact.status, fact.at] : null))).toEqual([
          ['lost', incident.lostAt],
          ['restored', incident.restoredAt],
        ]);
        for (const fact of emitted)
          expect(fact).toMatchObject({
            kind: 'command-link',
            sourceId: 'command-link',
            aircraftId: reservation.aircraftId,
            sourceSessionId: reservation.sourceSessionId,
            incidentId: reservation.incidentId,
          });
      } else {
        expect(emitted).toHaveLength(1);
        const landing = physicalLandings.get(attempt.id)!;
        expect(landing).toBe(attempt.landing);
        expect(emitted[0]).toMatchObject({
          kind: 'landing-report',
          tenant: reservation.tenant,
          aircraftId: reservation.aircraftId,
          at: new Date(Date.parse(landing) + 90_000).toISOString(),
          reportAt: new Date(Date.parse(landing) + 90_000).toISOString(),
          reportedLandingAt: new Date(Date.parse(landing) + 30_000).toISOString(),
          sourceId: `simulation-person-${reservation.tenant}-buffered`,
          sourceSessionId: `${attempt.sourceSessionId}-buffered-person`,
          incidentId: reservation.incidentId,
          incidentCause: 'handset-clock-offset',
          personId: `${world.config.runId}-person-${reservation.tenant}-ground`,
          personName: reservation.tenant === 'alpha' ? 'Avery Collins' : 'Jordan Ellis',
        });
      }
    }
  });
});
