import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  MonitoringReportSourceSchema,
  type MissionRevisionRecord,
  type MonitoringReportSource,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  createOperationMonitoringObserver,
  observeOperationMonitoring,
  operationMonitoringSnapshot,
  type OperationMonitoringSnapshot,
} from '../../../packages/simulation-models/src/operation-monitoring.js';
import {
  advanceOperation,
  createOperation,
  operationCapacityPreset,
} from '../../../packages/simulation-models/src/operation.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import {
  prepareOperationMonitoringSource,
  retainOperationMonitoringSource,
  type OperationMonitoringPublicBinding,
  type PreparedOperationMonitoringSource,
} from '../src/operation-monitoring-source.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const validateSource = ajv.compile(MonitoringReportSourceSchema);

function fixture(options: { episode?: boolean; initialLinkState?: 'up' | 'unknown'; windowStartMs?: number } = {}) {
  const runId = 'monitoring-source';
  const world = createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId,
    start: iso(start),
    seed: 71031,
    fleet: { alpha: 1, beta: 1 },
    missionPlan: 'dispatch-plan.1',
    ...(options.episode === false ? {} : { commandLinkEpisode: 'canal-market-relay.1' as const }),
  });
  const attemptId = `intent-${runId}-alpha-0:attempt:1`;
  const observer = createOperationMonitoringObserver(world, {
    version: 1,
    runId,
    tenant: 'alpha',
    sourceId: 'operation-monitor',
    sourceSessionId: `${runId}:monitoring-session`,
    sourceWindowId: `${runId}:window:1`,
    control: {
      hazardId: 'ledger-hazard',
      controlId: 'ledger-control',
      controlVersion: 1,
      controlEventId: 'ledger-control-event',
      controlDigest: 'a'.repeat(64),
      acceptance: { id: 'ledger-risk-acceptance', acceptedRevision: 7, digest: 'b'.repeat(64) },
    },
    window: { start: iso(start + (options.windowStartMs ?? 0)), end: iso(start + 600_000) },
    flights: [{ attemptId, initialLinkState: options.initialLinkState ?? 'up', monitoringAvailable: true }],
  });
  const close = () => {
    advanceOperation(world, start + 600_000);
    observeOperationMonitoring(observer, world);
    return operationMonitoringSnapshot(observer);
  };
  return { world, observer, attemptId, close };
}

function publicBindings(snapshot: OperationMonitoringSnapshot): OperationMonitoringPublicBinding[] {
  return snapshot.flights.map((observed, index) => {
    const source = observed.executedMission;
    if (!source || !observed.aircraftId) throw new Error('Expected an observed executed mission');
    const bytes = observed.executedMissionOriginalBytesBase64
      ? Buffer.from(observed.executedMissionOriginalBytesBase64, 'base64')
      : Buffer.from(JSON.stringify(source), 'utf8');
    const { sourceRevision, occurredAt, ...payload } = structuredClone(source);
    const flightId = `ledger-flight-${index}`;
    const original = { sha256: sha256(bytes), byteLength: bytes.length };
    const mission: MissionRevisionRecord = {
      version: 'flight.mission.1',
      id: `ledger-mission-event-${index}`,
      missionId: `ledger-mission-${index}`,
      flightId,
      sourceId: 'mission-planner',
      sourceRevision,
      occurredAt,
      recordedAt: iso(Date.parse(occurredAt) + 1),
      receiptId: `ledger-mission-receipt-${index}`,
      artifactId: `ledger-mission-artifact-${index}`,
      ...payload,
      original,
      contentDigest: canonicalDigest({
        version: 'ledger.mission-content.1',
        sourceId: 'mission-planner',
        flightId,
        sourceRevision,
        occurredAt,
        fidelity: 'synthetic_contract',
        payload,
        original: { ...original, bytesBase64: bytes.toString('base64') },
      }),
      authority: {
        version: 'ledger.mission-authority.1',
        principalId: 'world-mission-source',
        tenantId: 'tenant-alpha',
        principalRevision: 2,
        inputKind: 'mission.revision',
        sourceId: 'mission-planner',
        requiredCapabilities: ['input:write', 'mission:write'],
        grantedSources: ['mission-planner'],
      },
    };
    return {
      attemptId: observed.attemptId,
      flight: { id: flightId, originationKey: observed.attemptId, aircraft: observed.aircraftId },
      mission,
    };
  });
}

function replaceOriginalSource(
  original: PreparedOperationMonitoringSource,
  change: (source: MonitoringReportSource) => void,
) {
  const copy = structuredClone(original);
  const source = JSON.parse(Buffer.from(copy.bytesBase64, 'base64').toString('utf8')) as MonitoringReportSource;
  change(source);
  const bytes = Buffer.from(JSON.stringify(source), 'utf8');
  copy.bytesBase64 = bytes.toString('base64');
  copy.sha256 = sha256(bytes);
  copy.byteLength = bytes.length;
  return copy;
}

describe('retained operation monitoring source preparation', () => {
  it('keeps the exact imported mission original instead of reserializing its JSON for monitoring', () => {
    const scenario = fixture();
    const snapshot = scenario.close();
    const flight = snapshot.flights[0]!;
    flight.executedMissionOriginalBytesBase64 = Buffer.from(
      JSON.stringify(flight.executedMission, null, 2) + '\n',
    ).toString('base64');
    const bindings = publicBindings(snapshot);
    expect(() => prepareOperationMonitoringSource(snapshot, bindings, 1)).not.toThrow();
    delete flight.executedMissionOriginalBytesBase64;
    expect(() => prepareOperationMonitoringSource(snapshot, bindings, 1)).toThrow(/original|bytes/);
  });
  it('pins exact mission originals and real airborne exposure including the physical C2 hold', () => {
    const scenario = fixture();
    const snapshot = scenario.close();
    const bindings = publicBindings(snapshot);
    const prepared = prepareOperationMonitoringSource(snapshot, bindings, 1);
    const source = prepared.source!;
    const original = prepared.original!;
    const attempt = scenario.world.attempts.find((attempt) => attempt.id === scenario.attemptId)!;
    const hold = attempt.commandLinkHold!;

    expect(snapshot.complete).toBe(true);
    expect(hold.holdMs).toBeGreaterThan(0);
    expect(validateSource(source), JSON.stringify(validateSource.errors)).toBe(true);
    expect(prepared).toMatchObject({
      status: 'pending',
      reasons: ['baseline_contract_pending', 'c2_baseline_not_before_window', 'monitoring_intake_pending'],
    });
    expect(source.flights[0]).toMatchObject({
      flightId: bindings[0]!.flight.id,
      aircraftId: attempt.aircraftId,
      mission: {
        missionId: bindings[0]!.mission.missionId,
        eventId: bindings[0]!.mission.id,
        contentDigest: bindings[0]!.mission.contentDigest,
        recordDigest: canonicalDigest(bindings[0]!.mission),
      },
      c2SourceId: 'command-link',
      c2SourceSessionId: hold.sourceSessionId,
      observedIntervals: [{ start: attempt.departure, end: attempt.landing }],
      coverageIntervals: [{ start: attempt.departure, end: attempt.landing }],
      gaps: [],
    });
    expect(Date.parse(attempt.landing) - Date.parse(hold.nominalLanding)).toBe(hold.holdMs);
    expect(bindings[0]!.mission.operatingInterval.end).toBe(hold.nominalLanding);
    expect(original.c2Originals.map((entry) => entry.sourceEventId)).toEqual(
      source.flights[0]!.declaredC2SourceEventIds,
    );
    expect(original.c2Originals.map((entry) => entry.bytesBase64)).toEqual(
      snapshot.flights[0]!.reports.map((report) => prepareWorldFact(report).bytesBase64),
    );
    const bytes = Buffer.from(original.bytesBase64, 'base64');
    expect(bytes.toString('utf8')).toBe(JSON.stringify(source));
    expect(original.sha256).toBe(sha256(bytes));
    expect(original.byteLength).toBe(bytes.length);
    expect(original.identity).toMatchObject({
      runId: snapshot.plan.runId,
      tenantId: 'tenant-alpha',
      sourceRevision: 1,
    });
  });

  it('stays pending before closure or binding and never serializes an internal initial state as a V1 restoration', () => {
    const scenario = fixture({ episode: false });
    const early = prepareOperationMonitoringSource(operationMonitoringSnapshot(scenario.observer), [], 1);
    expect(early).toEqual({ status: 'pending', reasons: ['observation_pending'] });
    const snapshot = scenario.close();
    const bindings = publicBindings(snapshot);
    expect(prepareOperationMonitoringSource(snapshot, [], 1)).toMatchObject({
      status: 'pending',
      reasons: expect.arrayContaining(['public_bindings_pending']),
    });
    expect(prepareOperationMonitoringSource(snapshot, [], 1).source).toBeUndefined();
    const prepared = prepareOperationMonitoringSource(snapshot, bindings, 1);
    expect(prepared.reasons).toEqual([
      'baseline_contract_pending',
      'c2_baseline_not_before_window',
      'monitoring_intake_pending',
    ]);
    expect(prepared.original!.c2Originals).toEqual([]);
    expect(prepared.source!.flights[0]!.declaredC2SourceEventIds).toEqual([]);
    expect(Object.keys(prepared.source!)).not.toContain('observedLossCount');
    expect(Object.keys(prepared.source!)).not.toContain('flightSeconds');
    const unknown = structuredClone(snapshot);
    unknown.flights[0]!.baseline!.state = 'unknown';
    unknown.plan.flights[0]!.initialLinkState = 'unknown';
    expect(prepareOperationMonitoringSource(unknown, bindings, 1).reasons).toEqual([
      'c2_baseline_missing',
      'c2_baseline_not_before_window',
      'monitoring_intake_pending',
    ]);
  });

  it('retains exact revisions across JSON restart, rejects replacement or reordering, and deduplicates C2 originals', () => {
    const snapshot = fixture({ windowStartMs: 120_001 }).close();
    const bindings = publicBindings(snapshot);
    const first = prepareOperationMonitoringSource(snapshot, bindings, 1).original!;
    const firstBytes = JSON.stringify(first);
    const initial = retainOperationMonitoringSource(undefined, first);
    const restarted = JSON.parse(JSON.stringify(initial));
    expect(retainOperationMonitoringSource(restarted, JSON.parse(firstBytes))).toEqual(initial);
    expect(first.c2Originals).toHaveLength(2);
    const changedDictionary = structuredClone(initial);
    const previousDigest = changedDictionary.originals[0]!.c2OriginalDigests[0]!;
    const changedC2 = changedDictionary.c2Originals[previousDigest]!;
    const changedSource = JSON.parse(Buffer.from(changedC2.bytesBase64, 'base64').toString('utf8')) as {
      status: 'lost' | 'restored';
    };
    changedSource.status = changedSource.status === 'lost' ? 'restored' : 'lost';
    const changedBytes = Buffer.from(JSON.stringify(changedSource), 'utf8');
    Object.assign(changedC2, {
      bytesBase64: changedBytes.toString('base64'),
      sha256: sha256(changedBytes),
      byteLength: changedBytes.length,
    });
    expect(canonicalDigest(changedC2)).not.toBe(previousDigest);
    expect(() => retainOperationMonitoringSource(changedDictionary, first)).toThrow(/commit|digest|changed|original/i);
    const second = prepareOperationMonitoringSource(snapshot, bindings, 2).original!;
    const changedScope = replaceOriginalSource(second, (source) => {
      source.control.controlVersion++;
      source.window.end = iso(Date.parse(source.window.end) + 1000);
      source.flights[0]!.mission.eventId = 'another-mission-event';
    });
    expect(() => retainOperationMonitoringSource(restarted, changedScope)).toThrow(/control|window|scope/i);
    const retained = retainOperationMonitoringSource(restarted, second);
    expect(retained.originals).toHaveLength(2);
    expect(retained.originals[0]).toEqual(initial.originals[0]);
    expect(Object.values(retained.c2Originals)).toHaveLength(2);
    expect(first.key).not.toBe(second.key);
    expect(JSON.stringify(first)).toBe(firstBytes);
    const conflict = replaceOriginalSource(first, (source) => {
      source.occurredAt = iso(Date.parse(source.occurredAt) + 1);
    });
    expect(() => retainOperationMonitoringSource(retained, conflict)).toThrow(/replace|original/i);
    expect(() => retainOperationMonitoringSource(undefined, second)).toThrow(/advance|revision/i);
    expect(() =>
      retainOperationMonitoringSource(retained, prepareOperationMonitoringSource(snapshot, bindings, 4).original!),
    ).toThrow(/advance|revision/i);
  });

  it('rejects foreign flight, aircraft, tenant and changed executed-mission bindings', () => {
    const snapshot = fixture().close();
    const bindings = publicBindings(snapshot);
    const changed = [
      (binding: OperationMonitoringPublicBinding) => {
        binding.flight.originationKey = 'another-attempt';
      },
      (binding: OperationMonitoringPublicBinding) => {
        binding.flight.aircraft = 'another-aircraft';
      },
      (binding: OperationMonitoringPublicBinding) => {
        binding.mission.authority.tenantId = 'tenant-beta';
      },
      (binding: OperationMonitoringPublicBinding) => {
        binding.mission.route.geometry.coordinates[1]![0] += 0.001;
      },
    ];
    for (const change of changed) {
      const wrong = structuredClone(bindings);
      change(wrong[0]!);
      expect(() => prepareOperationMonitoringSource(snapshot, wrong, 1)).toThrow(/binding|mission|source/i);
    }
    expect(prepareOperationMonitoringSource(snapshot, bindings, 1).source).toBeDefined();
  });
});
