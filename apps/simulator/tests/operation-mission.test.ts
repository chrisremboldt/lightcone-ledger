import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionSourceSchema } from '../../../packages/contracts/src/missions.js';
import {
  advanceOperation,
  createOperation,
  operationCapacityPreset,
  upgradeOperationWorld,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { missionPlanOptions } from '../src/operation.js';
import { prepareWorldFact, type PreparedWorldFact } from '../src/operation-delivery.js';
import { missionDeliveryStatus } from '../src/operation-delivery-policy.js';
import { readOperationHistory } from '../src/operation-history.js';
import {
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationHistoryBatch,
} from '../src/operation-state.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const directories: string[] = [];
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateSource = ajv.compile(MissionSourceSchema);
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function missionFacts(facts: WorldFact[]) {
  return facts.filter((fact): fact is Extract<WorldFact, { kind: 'mission' }> => fact.kind === 'mission');
}

function missionWorld(runId: string) {
  return createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId,
    start: new Date(start).toISOString(),
    seed: 71031,
    missionPlan: 'dispatch-plan.1',
    commandLinkEpisode: 'canal-market-relay.1',
  });
}

describe('authored world mission sources', () => {
  it('requires a fresh explicit selection and leaves absent-profile and older checkpoint behavior unchanged', () => {
    const normal = createOperation({ runId: 'mission-absent', start: new Date(start).toISOString() });
    const originalConfig = JSON.stringify(normal.config);
    const legacy = structuredClone(normal);
    legacy.version = 'operation-world.1';
    for (const world of [normal, upgradeOperationWorld(JSON.parse(JSON.stringify(legacy)))]) {
      advanceOperation(world, start + 180_000);
      expect(missionFacts(world.facts)).toEqual([]);
      expect(Object.hasOwn(world.config, 'missionPlan')).toBe(false);
      expect(missionDeliveryStatus(world, {})).toEqual({});
      expect(JSON.stringify(world.config)).toBe(originalConfig);
    }
    const selected = missionWorld('mission-selected').config;
    const env = { SIMULATOR_WORLD_MISSION_PLAN: 'dispatch-plan.1' };
    expect(missionPlanOptions({})).toEqual({});
    expect(missionPlanOptions(env)).toEqual({ missionPlan: 'dispatch-plan.1' });
    expect(missionPlanOptions({}, selected)).toEqual({});
    expect(missionPlanOptions(env, selected)).toEqual({ missionPlan: 'dispatch-plan.1' });
    expect(() => missionPlanOptions(env, normal.config)).toThrow('retained in its checkpoint');
    expect(() => missionPlanOptions({ SIMULATOR_WORLD_MISSION_PLAN: '' })).toThrow('must be dispatch-plan.1');
    expect(() => createOperation({ ...normal.config, missionPlan: 'unknown' as 'dispatch-plan.1' })).toThrow('mission');
  });

  it('retains exact schema-valid dispatch plans and nominal geometry and times while a physical C2 hold delays landing', () => {
    const world = missionWorld('mission-immutable');
    const { commandLinkEpisode: _episode, ...normalConfig } = world.config;
    const normal = createOperation(normalConfig);
    advanceOperation(world, start + 89_999);
    const dispatched = missionFacts(world.facts).map(prepareWorldFact);
    expect(dispatched.length).toBeGreaterThan(0);
    advanceOperation(world, start + 121_000);
    advanceOperation(normal, world.now);
    const missions = missionFacts(world.facts);
    expect(missions).toHaveLength(world.attempts.length);
    expect(new Set(missions.map((fact) => fact.source.sourceMissionId)).size).toBe(missions.length);
    for (const fact of missions) {
      const attempt = world.attempts.find((candidate) => candidate.id === fact.attemptId)!;
      const initial = normal.attempts.find((candidate) => candidate.id === fact.attemptId)!;
      const prepared = prepareWorldFact(fact);
      const bytes = Buffer.from(prepared.bytesBase64, 'base64');
      expect(bytes.toString('utf8')).toBe(JSON.stringify(fact.source));
      expect(validateSource(JSON.parse(bytes.toString('utf8'))), JSON.stringify(validateSource.errors)).toBe(true);
      expect(fact).not.toHaveProperty('sourceSessionId');
      expect(fact).toMatchObject({
        sourceId: 'mission-planner',
        aircraftId: attempt.aircraftId,
        at: attempt.departure,
      });
      expect(fact.source).toEqual({
        sourceRevision: 1,
        occurredAt: attempt.departure,
        sourceMissionId: `${attempt.id}:mission`,
        aircraftId: attempt.aircraftId,
        route: {
          coordinateReference: 'WGS84',
          coordinateOrder: 'longitude_latitude',
          segmentInterpolation: 'linear_longitude_latitude',
          geometry: {
            type: 'LineString',
            coordinates: [
              [attempt.origin.longitude, attempt.origin.latitude],
              [attempt.destination.longitude, attempt.destination.latitude],
              [attempt.origin.longitude, attempt.origin.latitude],
            ],
          },
        },
        lateralToleranceMeters: 30,
        altitude: { minimum: 0, maximum: 60, unit: 'm', reference: 'AGL' },
        operatingInterval: { start: initial.departure, end: initial.landing },
      });
      const assignment = world.facts.find(
        (candidate) =>
          candidate.attemptId === attempt.id && candidate.kind === 'order' && candidate.order.version === 2,
      )!;
      const departure = world.facts.find(
        (candidate) => candidate.attemptId === attempt.id && candidate.kind === 'departure',
      )!;
      expect(assignment.sequence).toBeLessThan(fact.sequence);
      expect(fact.sequence).toBeLessThan(departure.sequence);
    }
    const held = world.attempts.filter((attempt) => attempt.commandLinkHold);
    expect(held.length).toBeGreaterThanOrEqual(2);
    for (const attempt of held) {
      const source = missions.find((fact) => fact.attemptId === attempt.id)!.source;
      expect(source.operatingInterval.end).toBe(attempt.commandLinkHold!.nominalLanding);
      expect(Date.parse(attempt.landing)).toBeGreaterThan(Date.parse(source.operatingInterval.end));
    }
    for (const prepared of dispatched) {
      expect(prepareWorldFact(world.facts.find((fact) => fact.sequence === prepared.fact.sequence)!)).toEqual(prepared);
    }
    const restarted = upgradeOperationWorld(JSON.parse(JSON.stringify(world)));
    expect(missionFacts(restarted.facts).map(prepareWorldFact)).toEqual(missions.map(prepareWorldFact));
  });

  it('preserves mission source bytes and receipt history across restart while each delivery kind drains independently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-mission-state-'));
    directories.push(directory);
    const path = join(directory, 'world.json');
    const world = createOperation({
      ...missionWorld('mission-pending').config,
      fleet: { alpha: 2, beta: 1 },
      sampleIntervalMs: 60_000,
    });
    let store = new OperationStore(
      path,
      initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
    );
    await store.update((state) => advanceOperation(state.world, start + 121_000));
    const original = structuredClone(store.pendingMissionHeads());
    expect(original.length).toBeGreaterThan(0);
    expect(store.pendingCommandLinkHeads().length).toBeGreaterThan(0);
    expect(
      store.pendingHeads().every((entry) => entry.fact.kind !== 'mission' && entry.fact.kind !== 'command-link'),
    ).toBe(true);
    const first = original[0]!.fact;
    if (first.kind !== 'mission') throw new Error('Expected a retained mission source');
    let nextRevision: PreparedWorldFact | undefined;
    await store.update((state) => {
      const at = new Date(state.world.now).toISOString();
      const fact: Extract<WorldFact, { kind: 'mission' }> = {
        ...structuredClone(first),
        sequence: state.world.nextFact++,
        at,
        source: { ...structuredClone(first.source), sourceRevision: 2, occurredAt: at },
      };
      state.world.facts.push(fact);
      nextRevision = prepareWorldFact(fact);
    });
    const restored = await readOperationCheckpoint(path);
    store = new OperationStore(path, restored!);
    expect(store.pendingMissionHeads()).toEqual(original);
    expect(missionDeliveryStatus(store.state.world, store.state.pending)).toEqual({
      missionDelivery: { sourceId: 'mission-planner', consumer: 'available', pendingPlans: original.length + 1 },
    });
    const bytesBefore = await readFile(path, 'utf8');
    await expect(store.accept(nextRevision!, `canonical-mission-${nextRevision!.fact.sequence}`)).rejects.toThrow(
      'pending delivery head',
    );
    expect(await readFile(path, 'utf8')).toBe(bytesBefore);
    await store.accept(original[0]!, `canonical-mission-${first.sequence}`);
    expect(store.pendingMissionHeads().find((entry) => entry.fact.attemptId === first.attemptId)).toEqual(nextRevision);
    const remaining = structuredClone(store.pendingMissionHeads());
    let ordinary = 0;
    let reports = 0;
    while (store.pendingHeads().length || store.pendingCommandLinkHeads().length) {
      const head = store.pendingHeads()[0] ?? store.pendingCommandLinkHeads()[0]!;
      if (head.fact.kind === 'command-link') reports++;
      else ordinary++;
      await store.accept(head, `fixture-receipt-${head.fact.sequence}`);
    }
    expect(ordinary).toBeGreaterThan(0);
    expect(reports).toBeGreaterThan(0);
    expect(Object.values(store.state.pending).flat()).toEqual(remaining);
    expect(store.pendingMissionHeads()).toEqual(remaining);
    expect(store.state.accepted).toBe(ordinary + reports + 1);
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    expect(store.pendingMissionHeads()).toEqual(remaining);
    while (store.pendingMissionHeads().length) {
      const head = store.pendingMissionHeads()[0]!;
      await store.accept(head, `canonical-mission-${head.fact.sequence}`);
    }
    expect(store.state.pending).toEqual({});
    expect(store.state.accepted).toBe(ordinary + reports + original.length + 1);
    expect(missionDeliveryStatus(store.state.world, store.state.pending)).toEqual({
      missionDelivery: { sourceId: 'mission-planner', consumer: 'available', pendingPlans: 0 },
    });
    const batches: OperationHistoryBatch[] = [];
    for await (const batch of readOperationHistory<OperationHistoryBatch>(
      store.historyDirectory,
      store.state.historyBatches,
    ))
      batches.push(batch.value);
    const archived = batches.flatMap((batch) => batch.facts).filter((entry) => entry.fact.kind === 'mission');
    expect(archived).toEqual([...original, nextRevision]);
    const receipts = batches.flatMap((batch) => batch.receipts);
    for (const prepared of archived)
      expect(receipts.filter((receipt) => receipt.sequence === prepared.fact.sequence)).toEqual([
        {
          sequence: prepared.fact.sequence,
          attemptId: prepared.fact.attemptId,
          receiptId: `canonical-mission-${prepared.fact.sequence}`,
        },
      ]);
    const final = await readOperationCheckpoint(path);
    expect(final).toEqual(store.state);
    expect(new OperationStore(path, final!).pendingMissionHeads()).toEqual([]);
  });
});
