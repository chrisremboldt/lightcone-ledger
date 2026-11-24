import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { commandLinkLossAt } from '../../../packages/simulation-models/src/operation-command-link.js';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  operationCapacityPreset,
  operationPoint,
  operationSummary,
  upgradeOperationWorld,
  type OperationArchive,
  type OperationAttempt,
  type OperationWorld,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { places } from '../../../packages/simulation-models/src/places.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();

function relayWorld(runId: string): OperationWorld {
  return createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId,
    start: iso(start),
    seed: 71031,
    commandLinkEpisode: 'canal-market-relay.1',
  });
}

function normalWorld(world: OperationWorld): OperationWorld {
  const config = { ...world.config };
  delete config.commandLinkEpisode;
  return createOperation(config);
}

function commandLinkFacts(facts: WorldFact[]) {
  return facts.filter((fact): fact is Extract<WorldFact, { kind: 'command-link' }> => fact.kind === 'command-link');
}

function physicalPoint(point: { latitude: number; longitude: number; height: number }) {
  return { latitude: point.latitude, longitude: point.longitude, height: point.height };
}

function withoutSequence({ sequence: _sequence, ...fact }: WorldFact) {
  return fact;
}

describe('physical command-link relay episode', () => {
  it('holds overlapping flights at their loss positions while telemetry and unrelated flights continue', () => {
    const world = relayWorld('relay-overlap');
    const normal = normalWorld(world);
    advanceOperation(world, start + 119_999);
    advanceOperation(normal, world.now);
    const episode = world.commandLinkEpisode!;
    const affected = world.attempts.filter((attempt) => attempt.commandLinkHold);
    expect(episode).toMatchObject({
      center: places['Canal Market'],
      radiusMeters: 450,
      startsAt: iso(start + 90_000),
      endsAt: iso(start + 120_000),
    });
    expect(affected.length).toBeGreaterThanOrEqual(2);
    expect(new Set(episode.affectedAttemptIds)).toEqual(new Set(affected.map((attempt) => attempt.id)));
    expect(commandLinkFacts(world.facts).every((fact) => fact.status === 'lost')).toBe(true);

    for (const attempt of affected) {
      const hold = attempt.commandLinkHold!;
      expect(physicalPoint(operationPoint(attempt, world.now))).toEqual(hold.point);
      expect(operationPoint(attempt, world.now).horizontalSpeed).toBe(0);
      expect(hold.incidentId).toBe(episode.id);
      expect(hold.sourceSessionId).not.toBe(attempt.sourceSessionId);
      expect(hold.holdMs).toBe(start + 120_000 - Date.parse(hold.lostAt));
    }
    const heldFrames = world.facts.filter(
      (fact) =>
        fact.kind === 'position' &&
        affected.some(
          (attempt) =>
            attempt.id === fact.attemptId && Date.parse(fact.at) >= Date.parse(attempt.commandLinkHold!.lostAt),
        ),
    );
    expect(heldFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of heldFrames) {
      if (frame.kind !== 'position') throw new Error('Expected held position');
      const attempt = affected.find((attempt) => attempt.id === frame.attemptId)!;
      expect(frame.sourceSessionId).toBe(attempt.sourceSessionId);
      expect(frame.point.horizontalSpeed).toBe(0);
      expect(physicalPoint(frame.point)).toEqual(attempt.commandLinkHold!.point);
    }

    const unaffected = world.attempts.filter((attempt) => !attempt.commandLinkHold);
    expect(unaffected.length).toBeGreaterThan(0);
    expect(unaffected.some((attempt) => operationPoint(attempt, world.now).horizontalSpeed > 0)).toBe(true);
    for (const attempt of unaffected) {
      expect(attempt).toEqual(normal.attempts.find((other) => other.id === attempt.id));
      const factsFor = (candidate: OperationWorld) =>
        candidate.facts.filter((fact) => fact.attemptId === attempt.id).map(withoutSequence);
      expect(factsFor(world)).toEqual(factsFor(normal));
    }

    advanceOperation(world, start + 130_000);
    const links = commandLinkFacts(world.facts);
    expect(links).toHaveLength(affected.length * 2);
    expect(new Set(links.map((fact) => fact.sourceEventId)).size).toBe(links.length);
    expect(new Set(links.map((fact) => fact.sourceSessionId)).size).toBe(affected.length);
    for (const attempt of affected) {
      const hold = attempt.commandLinkHold!;
      const reports = links.filter((fact) => fact.attemptId === attempt.id);
      expect(reports.map((fact) => fact.status)).toEqual(['lost', 'restored']);
      expect(reports.map((fact) => fact.at)).toEqual([hold.lostAt, hold.restoredAt]);
      for (const report of reports) {
        expect(report).toMatchObject({
          sourceId: 'command-link',
          tenant: attempt.tenant,
          aircraftId: attempt.aircraftId,
          sourceSessionId: hold.sourceSessionId,
          incidentId: episode.id,
          position: { latitude: hold.point.latitude, longitude: hold.point.longitude },
        });
      }
      const before = normal.attempts.find((other) => other.id === attempt.id)!;
      const resumed = operationPoint(attempt, start + 122_500);
      expect(physicalPoint(resumed)).toEqual(physicalPoint(operationPoint(before, Date.parse(hold.lostAt) + 2_500)));
      const frames = world.facts.filter(
        (fact) => fact.kind === 'position' && fact.attemptId === attempt.id && Date.parse(fact.at) >= start + 120_000,
      );
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        if (frame.kind !== 'position') throw new Error('Expected resumed position');
        expect(physicalPoint(frame.point)).toEqual(
          physicalPoint(operationPoint(before, Date.parse(frame.at) - hold.holdMs)),
        );
      }
    }
    expect(affected.some((attempt) => operationPoint(attempt, start + 122_500).horizontalSpeed > 0)).toBe(true);
  });

  it('retains the vendor schedule while actual landing, pilot release and ground work move later', () => {
    const world = relayWorld('relay-return');
    advanceOperation(world, start + 120_000);
    const attempt = world.attempts.find((candidate) => candidate.commandLinkHold)!;
    const hold = attempt.commandLinkHold!;
    const actualLanding = Date.parse(attempt.landing);
    const nominalLanding = Date.parse(hold.nominalLanding);
    const originalOrders = world.facts.filter((fact) => fact.kind === 'order' && fact.attemptId === attempt.id);
    const originalBytes = JSON.stringify(originalOrders);
    expect(originalOrders.map((fact) => fact.order.version)).toEqual([1, 2]);
    const requestedWindow = originalOrders[0]!.order.schedule;
    expect(originalOrders.map((fact) => fact.order.schedule)).toEqual([requestedWindow, requestedWindow]);
    expect(actualLanding).toBe(nominalLanding + hold.holdMs);

    advanceOperation(world, nominalLanding);
    expect(attempt.phase).toBe('flying');
    const pilot = world.resources!.flightPeople.find((slot) => slot.id === attempt.personId)!;
    expect(pilot).toMatchObject({ aircraftId: attempt.aircraftId, availableAt: actualLanding });
    expect(world.aircraft.find((aircraft) => aircraft.id === attempt.aircraftId)).toMatchObject({
      phase: 'flying',
      availableAt: actualLanding,
    });
    advanceOperation(world, actualLanding - 1);
    expect(world.facts.some((fact) => fact.kind === 'landing' && fact.attemptId === attempt.id)).toBe(false);
    expect(world.resources!.turnaroundQueue).not.toContain(attempt.aircraftId);
    expect(world.resources!.turnaroundCrews.some((slot) => slot.aircraftId === attempt.aircraftId)).toBe(false);
    expect(world.resources!.chargers.some((slot) => slot.aircraftId === attempt.aircraftId)).toBe(false);

    advanceOperation(world, actualLanding);
    expect(attempt.phase).toBe('landed');
    expect(world.facts.filter((fact) => fact.kind === 'landing' && fact.attemptId === attempt.id)).toMatchObject([
      { at: attempt.landing, personId: attempt.personId, sourceSessionId: attempt.sourceSessionId },
    ]);
    expect(pilot.aircraftId).not.toBe(attempt.aircraftId);
    expect(
      world.resources!.turnaroundQueue.includes(attempt.aircraftId) ||
        world.resources!.turnaroundCrews.some((slot) => slot.aircraftId === attempt.aircraftId),
    ).toBe(true);
    const earliestReady = actualLanding + world.config.turnaroundMs + world.config.chargeMs;
    advanceOperation(world, actualLanding + world.config.turnaroundMs - 1);
    expect(world.resources!.chargers.some((slot) => slot.aircraftId === attempt.aircraftId)).toBe(false);
    advanceOperation(world, earliestReady - 1);
    expect(
      world.attempts
        .filter((candidate) => candidate.aircraftId === attempt.aircraftId)
        .map((candidate) => candidate.id),
    ).toEqual([attempt.id]);
    expect(world.aircraft.find((aircraft) => aircraft.id === attempt.aircraftId)!.phase).not.toBe('ready');
    expect(JSON.stringify(world.facts.filter((fact) => fact.kind === 'order' && fact.attemptId === attempt.id))).toBe(
      originalBytes,
    );
  });

  it('replays exact reports and event identities across loss, restoration, JSON restart and compaction', () => {
    const initial = relayWorld('relay-replay');
    initial.config.incident = 'landing-disagreement';
    initial.config.profile = 'telemetry-delivery-interruption';
    const uninterrupted = createOperation(initial.config);
    advanceOperation(uninterrupted, start + 20 * 60_000);
    const summary = operationSummary(uninterrupted);
    const expected = compactOperation(uninterrupted);

    let resumed = createOperation(initial.config);
    const archived: OperationArchive = { facts: [], demand: [], attempts: [] };
    for (const elapsed of [0, 89_999, 90_000, 90_001, 110_123, 119_999, 120_000, 120_001, 301_337, 20 * 60_000]) {
      advanceOperation(resumed, start + elapsed);
      const batch = compactOperation(resumed);
      archived.facts.push(...batch.facts);
      archived.demand.push(...batch.demand);
      archived.attempts.push(...batch.attempts);
      resumed = upgradeOperationWorld(JSON.parse(JSON.stringify(resumed)));
    }
    expect(JSON.stringify(archived.facts)).toBe(JSON.stringify(expected.facts));
    const byIdentity = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
    expect(archived.attempts.sort(byIdentity)).toEqual(expected.attempts.sort(byIdentity));
    expect(archived.demand.sort(byIdentity)).toEqual(expected.demand.sort(byIdentity));
    expect(resumed).toEqual(uninterrupted);
    expect(operationSummary(resumed)).toEqual(summary);
    expect(resumed.telemetryDeliveryInterruption).toBeDefined();
    const holds = archived.attempts.flatMap((attempt) => (attempt.commandLinkHold ? [attempt.commandLinkHold] : []));
    expect(holds.length).toBeGreaterThanOrEqual(2);
    expect(resumed.commandLinkEpisode!.extraAirborneMs).toBe(holds.reduce((sum, hold) => sum + hold.holdMs, 0));
    expect(
      resumed.commandLinkEpisode!.affectedAttemptIds.every(
        (id) => !resumed.attempts.some((attempt) => attempt.id === id),
      ),
    ).toBe(true);
    const links = commandLinkFacts(archived.facts);
    expect(new Set(links.map((fact) => fact.sourceEventId)).size).toBe(links.length);
    for (const attempt of archived.attempts.filter((candidate) => candidate.commandLinkHold)) {
      const reports = links.filter((fact) => fact.attemptId === attempt.id);
      const landing = archived.facts.find((fact) => fact.kind === 'landing' && fact.attemptId === attempt.id)!;
      expect(reports.map((fact) => fact.status)).toEqual(['lost', 'restored']);
      expect(reports[0]!.sequence).toBeLessThan(reports[1]!.sequence);
      expect(reports[1]!.sequence).toBeLessThan(landing.sequence);
      expect(landing.at).toBe(attempt.landing);
    }
    const report = archived.facts.find((fact) => fact.kind === 'landing-report');
    if (report?.kind !== 'landing-report') throw new Error('Expected buffered landing report');
    const reportedAttempt = archived.attempts.find((attempt) => attempt.id === report.attemptId)!;
    expect(report.at).toBe(iso(Date.parse(reportedAttempt.landing) + 90_000));
    expect(report.reportedLandingAt).toBe(iso(Date.parse(reportedAttempt.landing) + 30_000));
    expect(report.sourceSessionId).not.toBe(reportedAttempt.commandLinkHold?.sourceSessionId);
  });

  it('preserves default and version-one bytes and keeps telemetry delivery interruption physically separate', () => {
    const normal = createOperation({ runId: 'capacity-absent', start: iso(start) });
    expect(createHash('sha256').update(JSON.stringify(normal.config)).digest('hex')).toBe(
      '32a6bf752d0fbaa6d35fda5e9670f3a05f4531c22a9df1f493019d884a2c8ef6',
    );
    expect(Object.hasOwn(normal.config, 'commandLinkEpisode')).toBe(false);
    expect(Object.hasOwn(normal, 'commandLinkEpisode')).toBe(false);
    const interrupted = createOperation({ ...normal.config, profile: 'telemetry-delivery-interruption' });
    advanceOperation(normal, start + 600_000);
    advanceOperation(interrupted, normal.now);
    expect(JSON.stringify(interrupted.facts)).toBe(JSON.stringify(normal.facts));
    expect(interrupted.attempts).toEqual(normal.attempts);
    expect(interrupted.aircraft).toEqual(normal.aircraft);
    expect(commandLinkFacts(interrupted.facts)).toEqual([]);
    expect(interrupted.attempts.every((attempt) => !Object.hasOwn(attempt, 'commandLinkHold'))).toBe(true);

    const legacy = createOperation({ runId: 'legacy-replay', start: iso(start) });
    legacy.version = 'operation-world.1';
    advanceOperation(legacy, start + 600_000);
    expect(createHash('sha256').update(JSON.stringify(legacy.facts)).digest('hex')).toBe(
      '572fb9d9ef8043ee07546c4b8ff62fef964e03c474de169ef214748acfa09ecb',
    );
    expect(() =>
      createOperation({ ...relayWorld('invalid').config, commandLinkEpisode: 'unknown' as 'canal-market-relay.1' }),
    ).toThrow('Unknown command-link episode');
    expect(() =>
      createOperation({ runId: 'no-capacity', start: iso(start), commandLinkEpisode: 'canal-market-relay.1' }),
    ).toThrow('requires finite operation capacity');
  });

  it('finds later circle entry between samples, excludes the end instant and resumes the remaining route once', () => {
    const episode = relayWorld('relay-boundary').commandLinkEpisode!;
    const center = places['Canal Market']!;
    const longitudeMeters = Math.cos((center.latitude * Math.PI) / 180) * 111_320;
    const departure = start + 50_123;
    const attempt: OperationAttempt = {
      id: 'analytic-attempt',
      intentId: 'analytic-intent',
      demandId: 'analytic-demand',
      tenant: 'alpha',
      aircraftId: 'analytic-aircraft',
      personId: 'analytic-person',
      sourceSessionId: 'analytic-telemetry-session',
      siteId: episode.siteId,
      origin: { latitude: center.latitude, longitude: center.longitude - 900 / longitudeMeters },
      destination: { ...center },
      departure: iso(departure),
      landing: iso(departure + 222_000),
      travelMs: 81_000,
      phase: 'flying',
    };
    const lossAt = commandLinkLossAt(attempt, episode)!;
    expect(Math.abs(lossAt - (departure + 60_500))).toBeLessThanOrEqual(1);
    expect((lossAt - departure) % 10_000).toBeGreaterThan(0);
    expect(lossAt).toBeGreaterThan(Date.parse(episode.startsAt));
    expect(commandLinkLossAt(attempt, { ...episode, endsAt: iso(lossAt) })).toBeUndefined();
    const holdMs = Date.parse(episode.endsAt) - lossAt;
    const held: OperationAttempt = {
      ...attempt,
      landing: iso(Date.parse(attempt.landing) + holdMs),
      commandLinkHold: {
        incidentId: episode.id,
        sourceSessionId: 'analytic-command-link-session',
        lostAt: iso(lossAt),
        restoredAt: episode.endsAt,
        point: physicalPoint(operationPoint(attempt, lossAt)),
        nominalLanding: attempt.landing,
        holdMs,
        extraAirborneMs: holdMs,
      },
    };
    const end = Date.parse(episode.endsAt);
    expect(physicalPoint(operationPoint(held, end - 1))).toEqual(held.commandLinkHold!.point);
    expect(operationPoint(held, end - 1).horizontalSpeed).toBe(0);
    expect(physicalPoint(operationPoint(held, end))).toEqual(held.commandLinkHold!.point);
    expect(operationPoint(held, end).horizontalSpeed).toBeGreaterThan(0);
    expect(physicalPoint(operationPoint(held, end + 5_000))).toEqual(
      physicalPoint(operationPoint(attempt, lossAt + 5_000)),
    );
    const arrival = departure + 20_000 + attempt.travelMs;
    expect(operationPoint(held, arrival + holdMs + 1).horizontalSpeed).toBe(0);
    const afterDwell = arrival + 20_000 + 1;
    expect(operationPoint(held, afterDwell + holdMs).horizontalSpeed).toBeGreaterThan(0);
    expect(physicalPoint(operationPoint(held, afterDwell + holdMs))).toEqual(
      physicalPoint(operationPoint(attempt, afterDwell)),
    );
    expect(physicalPoint(operationPoint(held, Date.parse(held.landing)))).toEqual(
      physicalPoint(operationPoint(attempt, Date.parse(attempt.landing))),
    );
  });
});
