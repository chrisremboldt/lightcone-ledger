import { describe, expect, it } from 'vitest';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  operationCapacityPreset,
  operationPoint,
  reviseOperationReservation,
  adoptOperationMissionSource,
  type OperationWorld,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import {
  captureOperationMonitoringBaseline,
  createOperationMonitoringObserver,
  observeOperationMonitoring,
  operationMonitoringSnapshot,
  setOperationMonitoringAvailability,
  type OperationMonitoringObserver,
  type OperationMonitoringPlan,
} from '../../../packages/simulation-models/src/operation-monitoring.js';

const start = Date.parse('2026-10-16T14:00:00.000Z');
const iso = (offset: number) => new Date(start + offset).toISOString();
const attemptId = (world: OperationWorld) => `intent-${world.config.runId}-alpha-0:attempt:1`;

function fresh(runId: string, episode = false, held = false) {
  const preset = operationCapacityPreset('illustrative-25.1');
  return createOperation({
    ...preset,
    runId,
    start: iso(0),
    seed: 71031,
    fleet: { alpha: 1, beta: 1 },
    capacity: {
      ...preset.capacity,
      demandIntervalMs: { alpha: 120_000, beta: 120_000 },
      flightPeople: { alpha: 1, beta: 1 },
      turnaroundCrews: { alpha: 1, beta: 1 },
      chargers: { alpha: 1, beta: 1 },
      launchPads: { alpha: 1, beta: 1 },
    },
    missionPlan: 'dispatch-plan.1',
    ...(episode ? { commandLinkEpisode: 'canal-market-relay.1' as const } : {}),
    ...(held ? { predeparture: { version: 'reserve-await-release.1' as const, tenant: 'alpha' as const } } : {}),
  });
}

function plan(world: OperationWorld, begin = 60_000, end = 360_000): OperationMonitoringPlan {
  return {
    version: 1,
    runId: world.config.runId,
    tenant: 'alpha',
    sourceId: 'simulation-monitoring',
    sourceSessionId: `${world.config.runId}:monitoring:1`,
    sourceWindowId: `${world.config.runId}:window:1`,
    control: {
      hazardId: 'selected-hazard',
      controlId: 'selected-control',
      controlVersion: 1,
      controlEventId: 'selected-control-event',
      controlDigest: '1'.repeat(64),
      acceptance: { id: 'selected-acceptance', acceptedRevision: 4, digest: '2'.repeat(64) },
    },
    window: { start: iso(begin), end: iso(end) },
    flights: [{ attemptId: attemptId(world), initialLinkState: 'up', monitoringAvailable: true }],
  };
}

function observe(world: OperationWorld, observer: OperationMonitoringObserver, offset: number) {
  advanceOperation(world, start + offset);
  const before = structuredClone(world);
  observeOperationMonitoring(observer, world);
  expect(world).toEqual(before);
}

describe('prospective operation monitoring', () => {
  it('observes an already-published mission at adoption time while preserving its source clock and original bytes', () => {
    const world = fresh('monitoring-public-revision', false, true);
    world.config.predeparture = {
      version: 'reserve-selected-await-release.1',
      tenant: 'alpha',
      attemptId: attemptId(world),
    };
    const observer = createOperationMonitoringObserver(world, plan(world, 0, 600_000));
    observe(world, observer, 0);
    const reservation = world.reservations![0]!;
    advanceOperation(world, start + 60_000);
    reviseOperationReservation(world, reservation.id, {
      sourceRevision: 2,
      operatingInterval: { ...reservation.order.schedule },
    });
    observeOperationMonitoring(observer, world);
    observe(world, observer, 70_000);
    const source = { ...structuredClone(reservation.plan), sourceRevision: 3, occurredAt: iso(65_000) };
    const originalBytesBase64 = Buffer.from(JSON.stringify(source, null, 2) + '\n').toString('base64');
    adoptOperationMissionSource(
      world,
      reservation.id,
      source,
      { receiptId: 'accepted-public-receipt', originalBytesBase64 },
      { marginMs: 10_000, handoffAllowanceMs: 30_000 },
    );
    observeOperationMonitoring(observer, world);
    expect(observer.failure).toBeUndefined();
    const person = world.people.find((person) => person.id === reservation.personId)!;
    world.facts.push({
      sequence: world.nextFact++,
      kind: 'departure',
      tenant: reservation.tenant,
      at: iso(70_000),
      attemptId: reservation.id,
      aircraftId: reservation.aircraftId,
      sourceSessionId: reservation.sourceSessionId,
      personId: person.id,
      personName: person.name,
    });
    observeOperationMonitoring(observer, world);
    const observed = operationMonitoringSnapshot(observer).flights[0]!;
    expect(observed.executedMission).toEqual(source);
    expect(observed.executedMissionOriginalBytesBase64).toBe(originalBytesBase64);
    expect(observed.departureAt).toBe(iso(70_000));
    expect(observed.executedMission!.occurredAt).toBe(iso(65_000));
  });
  it('retains one explicit initial observation and its original clock through later reports and JSON restart', () => {
    const world = fresh('monitoring-native-baseline', true);
    let observer = createOperationMonitoringObserver(world, plan(world));
    observe(world, observer, 0);
    expect(operationMonitoringSnapshot(observer).flights[0]!.initialLinkObservation).toBeUndefined();
    observe(world, observer, 1000);
    const before = structuredClone(world);
    const captured = captureOperationMonitoringBaseline(observer, world, attemptId(world), 'unknown');
    const expected = {
      version: 'operation.command-link-baseline-observation.1',
      state: 'unknown',
      occurredAt: iso(1000),
    };
    expect(captured).toEqual(expected);
    expect(world).toEqual(before);
    expect(operationMonitoringSnapshot(observer).flights[0]).toMatchObject({
      baseline: { state: 'up', occurredAt: iso(0) },
      initialLinkObservation: expected,
      reports: [],
      coverageIntervals: [],
    });
    captured.state = 'up';
    captured.occurredAt = iso(0);
    observer = JSON.parse(JSON.stringify(observer)) as OperationMonitoringObserver;
    observe(world, observer, 120_000);
    expect(operationMonitoringSnapshot(observer).flights[0]!.reports).toHaveLength(2);
    expect(captureOperationMonitoringBaseline(observer, world, attemptId(world), 'unknown')).toEqual(expected);
    expect(() => captureOperationMonitoringBaseline(observer, world, attemptId(world), 'up')).toThrow('retained state');
    observe(world, observer, 360_000);
    expect(operationMonitoringSnapshot(observer)).toMatchObject({ complete: true });
    advanceOperation(world, start + 400_000);
    expect(captureOperationMonitoringBaseline(observer, world, attemptId(world), 'unknown')).toEqual(expected);
    const malformed = structuredClone(observer);
    malformed.flights[0]!.initialLinkObservation!.version = 'unknown-version' as never;
    expect(() => operationMonitoringSnapshot(malformed)).toThrow('version');
  });

  it('refuses first observations before binding, across missed history, or after reports, landing and closure', () => {
    const world = fresh('monitoring-baseline-guards', true);
    const observer = createOperationMonitoringObserver(world, plan(world));
    expect(() => captureOperationMonitoringBaseline(observer, world, attemptId(world), 'up')).toThrow('departed');
    observe(world, observer, 0);
    advanceOperation(world, start + 1000);
    expect(() => captureOperationMonitoringBaseline(observer, world, attemptId(world), 'up')).toThrow('current open');
    observeOperationMonitoring(observer, world);
    expect(() => captureOperationMonitoringBaseline(observer, world, attemptId(world), 'connected' as never)).toThrow(
      'state',
    );
    const anotherWorld = structuredClone(world);
    anotherWorld.config.runId = 'different-world';
    expect(() => captureOperationMonitoringBaseline(observer, anotherWorld, attemptId(world), 'up')).toThrow(
      'same bound',
    );
    observe(world, observer, 95_000);
    expect(() => captureOperationMonitoringBaseline(observer, world, attemptId(world), 'down')).toThrow(
      'before any C2 report',
    );
    expect(operationMonitoringSnapshot(observer).flights[0]!.initialLinkObservation).toBeUndefined();

    const landedWorld = fresh('monitoring-baseline-landed');
    const landed = createOperationMonitoringObserver(landedWorld, plan(landedWorld));
    observe(landedWorld, landed, 320_000);
    expect(operationMonitoringSnapshot(landed).flights[0]!.landingAt).toBeDefined();
    expect(() => captureOperationMonitoringBaseline(landed, landedWorld, attemptId(landedWorld), 'up')).toThrow(
      'current open',
    );
    const closedWorld = fresh('monitoring-baseline-closed');
    const closed = createOperationMonitoringObserver(closedWorld, plan(closedWorld, 0, 60_000));
    observe(closedWorld, closed, 60_000);
    expect(() => captureOperationMonitoringBaseline(closed, closedWorld, attemptId(closedWorld), 'up')).toThrow(
      'current open',
    );
  });

  it('observes actual airborne time including a physical hold, separating C2 monitoring gaps from telemetry delivery', () => {
    const world = fresh('monitoring-hold', true);
    const observer = createOperationMonitoringObserver(world, plan(world));
    observe(world, observer, 0);
    const selected = world.attempts.find((attempt) => attempt.id === attemptId(world))!;
    const nominalMission = structuredClone(operationMonitoringSnapshot(observer).flights[0]!.executedMission);
    observe(world, observer, 60_000);
    setOperationMonitoringAvailability(observer, world, selected.id, { telemetryDeliveryAvailable: false });
    observe(world, observer, 95_000);
    expect(operationPoint(selected, world.now).horizontalSpeed).toBe(0);
    setOperationMonitoringAvailability(observer, world, selected.id, { monitoringAvailable: false });
    observe(world, observer, 105_000);
    setOperationMonitoringAvailability(observer, world, selected.id, { monitoringAvailable: true });
    observe(world, observer, 150_000);
    setOperationMonitoringAvailability(observer, world, selected.id, { telemetryDeliveryAvailable: true });
    observe(world, observer, 360_000);
    const snapshot = operationMonitoringSnapshot(observer);
    const flight = snapshot.flights[0]!;
    expect(snapshot).toMatchObject({ complete: true, completedAt: iso(360_000) });
    expect(flight).toMatchObject({
      attemptId: selected.id,
      aircraftId: selected.aircraftId,
      c2SourceId: 'command-link',
      c2SourceSessionId: `${selected.sourceSessionId}-command-link-1`,
      departureAt: iso(0),
      landingAt: iso(349_776),
      baseline: { state: 'up', occurredAt: iso(0) },
      observedIntervals: [{ start: iso(60_000), end: iso(349_776) }],
      coverageIntervals: [
        { start: iso(60_000), end: iso(95_000) },
        { start: iso(105_000), end: iso(349_776) },
      ],
      gaps: [
        { kind: 'telemetry_delivery', interval: { start: iso(60_000), end: iso(150_000) } },
        { kind: 'c2_monitor', interval: { start: iso(95_000), end: iso(105_000) } },
      ],
    });
    expect(flight.executedMission).toEqual(nominalMission);
    expect(flight.executedMission!.operatingInterval.end).toBe(iso(319_776));
    const actualReports = world.facts.filter((fact) => fact.kind === 'command-link' && fact.attemptId === selected.id);
    expect(flight.reports).toEqual(actualReports);
    expect(flight.reports.map((fact) => [fact.status, fact.at])).toEqual([
      ['lost', iso(90_000)],
      ['restored', iso(120_000)],
    ]);
    expect(world.attempts.some((attempt) => attempt.tenant === 'beta')).toBe(true);
  });

  it('pins the latest predeparture mission at the departure fact without inventing exposure for a held plan', () => {
    const world = fresh('monitoring-held', false, true);
    const observer = createOperationMonitoringObserver(world, plan(world, 30_000, 300_000));
    observe(world, observer, 0);
    const reservation = world.reservations![0]!;
    advanceOperation(world, start + 20_000);
    const executed = reviseOperationReservation(world, reservation.id, {
      sourceRevision: 2,
      operatingInterval: { start: iso(30_000), end: reservation.order.schedule.end },
    });
    observeOperationMonitoring(observer, world);
    expect(operationMonitoringSnapshot(observer).flights[0]).toMatchObject({
      observedIntervals: [],
      coverageIntervals: [],
      reports: [],
    });
    expect(operationMonitoringSnapshot(observer).flights[0]!.executedMission).toBeUndefined();
    advanceOperation(world, start + 40_000);
    const person = world.people.find((person) => person.id === reservation.personId)!;
    world.facts.push({
      sequence: world.nextFact++,
      kind: 'departure',
      tenant: reservation.tenant,
      at: iso(40_000),
      attemptId: reservation.id,
      aircraftId: reservation.aircraftId,
      sourceSessionId: reservation.sourceSessionId,
      personId: person.id,
      personName: person.name,
    });
    const before = structuredClone(world);
    observeOperationMonitoring(observer, world);
    expect(world).toEqual(before);
    advanceOperation(world, start + 50_000);
    reviseOperationReservation(world, reservation.id, {
      sourceRevision: 3,
      operatingInterval: { start: iso(60_000), end: reservation.order.schedule.end },
    });
    observeOperationMonitoring(observer, world);
    const flight = operationMonitoringSnapshot(observer).flights[0]!;
    expect(flight.executedMission).toEqual(executed);
    expect(flight.observedIntervals).toEqual([{ start: iso(40_000), end: iso(50_000) }]);
    expect(flight.reports).toEqual([]);
    flight.executedMission!.route.geometry.coordinates[0]![0] = 0;
    expect(operationMonitoringSnapshot(observer).flights[0]!.executedMission).toEqual(executed);
  });

  it('retains complete prewindow history across JSON restart and compaction, then freezes the completed sample', () => {
    const continuous = fresh('monitoring-replay', true);
    const expected = createOperationMonitoringObserver(continuous, plan(continuous, 100_000, 360_000));
    observe(continuous, expected, 360_123);
    let world = fresh('monitoring-replay', true);
    let observer = createOperationMonitoringObserver(world, plan(world, 100_000, 360_000));
    for (const offset of [0, 80_000, 90_000, 110_000, 120_000, 360_123]) {
      observe(world, observer, offset);
      compactOperation(world);
      world = JSON.parse(JSON.stringify(world)) as OperationWorld;
      observer = JSON.parse(JSON.stringify(observer)) as OperationMonitoringObserver;
    }
    expect(operationMonitoringSnapshot(observer)).toEqual(operationMonitoringSnapshot(expected));
    const completed = operationMonitoringSnapshot(observer);
    expect(completed.flights[0]!.reports.map((report) => report.at)).toEqual([iso(90_000), iso(120_000)]);
    expect(completed.flights[0]!.observedIntervals).toEqual([{ start: iso(100_000), end: iso(349_776) }]);
    expect(completed.completedAt).toBe(iso(360_123));
    advanceOperation(world, start + 600_000);
    compactOperation(world);
    observeOperationMonitoring(observer, world);
    const later = operationMonitoringSnapshot(observer);
    expect(later).toEqual(completed);
    expect(() =>
      setOperationMonitoringAvailability(observer, world, attemptId(world), { monitoringAvailable: false }),
    ).toThrow('prospectively');
  });

  it('refuses retroactive startup and permanently marks missed sequences or backwards clocks without reconstructing history', () => {
    const old = fresh('monitoring-old');
    advanceOperation(old, start);
    expect(() => createOperationMonitoringObserver(old, plan(old))).toThrow('fresh');
    const world = fresh('monitoring-missed', true);
    const observer = createOperationMonitoringObserver(world, plan(world));
    advanceOperation(world, start + 95_000);
    const before = structuredClone(observer);
    expect(() =>
      setOperationMonitoringAvailability(observer, world, attemptId(world), { monitoringAvailable: false }),
    ).toThrow('current observed clock');
    expect(observer).toEqual(before);
    const archive = compactOperation(world);
    observeOperationMonitoring(observer, world);
    const failed = operationMonitoringSnapshot(observer);
    expect(failed).toMatchObject({ complete: false, failure: { code: 'monitoring_history_missed' } });
    expect(failed.flights[0]!.observedIntervals).toEqual([]);
    expect(failed.flights[0]!.reports).toEqual([]);
    world.facts = archive.facts;
    observeOperationMonitoring(observer, world);
    expect(operationMonitoringSnapshot(observer)).toEqual(failed);

    const backwardsWorld = fresh('monitoring-backwards');
    const backwards = createOperationMonitoringObserver(backwardsWorld, plan(backwardsWorld));
    observe(backwardsWorld, backwards, 60_000);
    backwardsWorld.now--;
    observeOperationMonitoring(backwards, backwardsWorld);
    expect(operationMonitoringSnapshot(backwards)).toMatchObject({
      complete: false,
      failure: { code: 'monitoring_history_missed' },
    });
    const changed = structuredClone(backwards);
    changed.plan.window.end = iso(1_000_000);
    expect(() => operationMonitoringSnapshot(changed)).toThrow('identity');
  });

  it('fails closed at population, retained-report and fragmented-coverage bounds without truncating a valid sample', () => {
    const world = fresh('monitoring-bounds');
    const oversized = plan(world);
    oversized.flights = Array.from({ length: 33 }, (_, index) => ({
      ...oversized.flights[0]!,
      attemptId: `${attemptId(world)}:${index}`,
    }));
    expect(() => createOperationMonitoringObserver(world, oversized)).toThrow('bounded');
    const observer = createOperationMonitoringObserver(world, plan(world));
    observe(world, observer, 0);
    const attempt = world.attempts.find((attempt) => attempt.id === attemptId(world))!;
    world.now = start + 1;
    for (let index = 0; index < 129; index++) {
      const report: Extract<WorldFact, { kind: 'command-link' }> = {
        sequence: world.nextFact++,
        kind: 'command-link',
        tenant: attempt.tenant,
        at: iso(1),
        attemptId: attempt.id,
        aircraftId: attempt.aircraftId,
        sourceId: 'command-link',
        sourceSessionId: `${attempt.sourceSessionId}-command-link-1`,
        sourceEventId: `bounded-report-${index}`,
        incidentId: `bounded-incident-${index}`,
        status: 'restored',
        position: { ...attempt.origin },
      };
      world.facts.push(report);
    }
    observeOperationMonitoring(observer, world);
    expect(operationMonitoringSnapshot(observer)).toMatchObject({
      complete: false,
      failure: { code: 'monitoring_bounds_exceeded' },
    });
    expect(operationMonitoringSnapshot(observer).flights[0]!.reports).toEqual([]);

    const fragmentedWorld = fresh('monitoring-fragments');
    const fragmented = createOperationMonitoringObserver(fragmentedWorld, plan(fragmentedWorld, 0, 90_000));
    observe(fragmentedWorld, fragmented, 0);
    for (let index = 0; index < 17 && !fragmented.failure; index++) {
      setOperationMonitoringAvailability(fragmented, fragmentedWorld, attemptId(fragmentedWorld), {
        monitoringAvailable: false,
      });
      observe(fragmentedWorld, fragmented, index * 2000 + 1000);
      if (fragmented.failure) break;
      setOperationMonitoringAvailability(fragmented, fragmentedWorld, attemptId(fragmentedWorld), {
        monitoringAvailable: true,
      });
      observe(fragmentedWorld, fragmented, index * 2000 + 2000);
    }
    const bounded = operationMonitoringSnapshot(fragmented);
    expect(bounded).toMatchObject({ complete: false, failure: { code: 'monitoring_bounds_exceeded' } });
    expect(bounded.flights[0]!.coverageIntervals.length).toBeLessThanOrEqual(16);
    expect(bounded.flights[0]!.gaps.length).toBeLessThanOrEqual(16);
  });
});
