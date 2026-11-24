import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@ledger/integrity';
import {
  advanceOperation,
  createOperation,
  enableOperationOrdinaryWork,
  operationCapacityPreset,
} from '../../../packages/simulation-models/src/operation.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import {
  commandLinkDeliveryStatus,
  interruptionFrame,
  telemetryDeliveryStatus,
} from '../src/operation-delivery-policy.js';
import * as operationHistory from '../src/operation-history.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationCheckpoint,
  type OperationHistoryBatch,
  type OperationReceipt,
} from '../src/operation-state.js';

function initialCheckpoint(): OperationCheckpoint {
  const world = createOperation({
    runId: 'checkpoint-test',
    start: '2026-10-15T14:00:00.000Z',
    fleet: { alpha: 1, beta: 1 },
  });
  return initialOperationCheckpoint(world, { mode: 'manual', wallAt: world.now, paused: false });
}

function cancelledSelectedCheckpoint(): OperationCheckpoint {
  const runId = 'cancelled-selected-state';
  const start = Date.parse('2026-10-15T14:00:00.000Z');
  const attemptId = `intent-${runId}-alpha-0:attempt:1`;
  const world = createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId,
    start: new Date(start).toISOString(),
    fleet: { alpha: 2, beta: 1 },
    missionPlan: 'dispatch-plan.1',
    predeparture: { version: 'reserve-selected-await-release.1', tenant: 'alpha', attemptId },
    selectedDemandWindow: {
      attemptId,
      start: new Date(start + 60_000).toISOString(),
      end: new Date(start + 15 * 60_000).toISOString(),
    },
  });
  advanceOperation(world, start + 15 * 60_000 + 1);
  const state = initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false });
  state.departureJob = {
    version: 'operation.departure-job.1',
    flightId: 'cancelled-selected-flight',
    reservationId: attemptId,
    departureAttemptId: `${attemptId}:departure:1`,
    planDigest: 'a'.repeat(64),
  };
  return state;
}

describe('operation checkpoints', () => {
  it('retains an ordinary incident receipt after its delivery queue and completed attempt are compacted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-ordinary-incident-receipt-'));
    try {
      const path = join(directory, 'world.json');
      const world = createOperation({
        runId: 'ordinary-receipt-state',
        start: '2026-10-17T14:00:00.000Z',
        fleet: { alpha: 3, beta: 2 },
        demandIntervalMs: 150_000,
        sampleIntervalMs: 10_000,
        incident: 'landing-disagreement',
      });
      advanceOperation(world, world.now);
      const selected = structuredClone(world.attempts[0]!);
      enableOperationOrdinaryWork(world);
      let store = new OperationStore(
        path,
        initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false }),
      );
      await store.update((state) => advanceOperation(state.world, Date.parse(selected.landing) + 90_000));
      const report = structuredClone(
        store.state.pending[selected.id]!.find((entry) => entry.fact.kind === 'landing-report')!,
      );
      expect(report.fact.kind).toBe('landing-report');
      expect(store.state.world.attempts.some((attempt) => attempt.id === selected.id)).toBe(false);
      expect(store.state.world.facts).toEqual([]);
      expect(store.state.world.ordinaryWork!.incidents[0].evidenceReceiptId).toBeUndefined();
      await expect(store.accept(report, 'out-of-order-incident-receipt')).rejects.toThrow('pending delivery head');
      expect(store.state.world.ordinaryWork!.incidents[0].evidenceReceiptId).toBeUndefined();
      while (store.state.pending[selected.id]![0].fact.sequence !== report.fact.sequence) {
        const head = store.pendingHeads().find((entry) => entry.fact.attemptId === selected.id)!;
        await store.accept(head, `ordinary-receipt-${head.fact.sequence}`);
      }
      expect(store.pendingHeads()).toContainEqual(report);
      const receiptId = 'accepted-ordinary-landing-receipt';
      await store.accept(report, receiptId);
      expect(store.state.pending[selected.id]).toBeUndefined();
      const reservation = structuredClone(store.state.world.ordinaryWork!.incidents[0]);
      expect(reservation).toMatchObject({
        attemptId: selected.id,
        aircraftId: selected.aircraftId,
        sourceSessionId: `${selected.sourceSessionId}-buffered-person`,
        incidentId: `${selected.id}:landing-disagreement`,
        evidenceReceiptId: receiptId,
      });
      const restored = (await readOperationCheckpoint(path))!;
      expect(restored.world.ordinaryWork!.incidents).toEqual([reservation]);
      store = new OperationStore(path, restored);
      await store.update((state) => advanceOperation(state.world, state.world.now + 1000));
      expect(store.state.world.ordinaryWork!.incidents).toEqual([reservation]);
      expect(store.state.pending[selected.id]).toBeUndefined();
      expect(await readOperationCheckpoint(path)).toEqual(store.state);
      const batches: OperationHistoryBatch[] = [];
      for await (const batch of operationHistory.readOperationHistory<OperationHistoryBatch>(
        store.historyDirectory,
        store.state.historyBatches,
      ))
        batches.push(batch.value);
      expect(
        batches.flatMap((batch) => batch.facts).filter((entry) => entry.fact.sequence === report.fact.sequence),
      ).toEqual([report]);
      expect(
        batches.flatMap((batch) => batch.receipts).filter((receipt) => receipt.sequence === report.fact.sequence),
      ).toEqual([{ sequence: report.fact.sequence, attemptId: selected.id, receiptId }]);
      expect(batches.flatMap((batch) => batch.attempts).filter((attempt) => attempt.id === selected.id)).toEqual([
        { ...selected, phase: 'landed' },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a cancelled selected reservation and its departure history while ordinary work continues', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-cancelled-selected-state-'));
    try {
      const path = join(directory, 'world.json');
      const store = new OperationStore(path, cancelledSelectedCheckpoint());
      await store.update(() => {});
      const tombstone = structuredClone(store.state.world.reservations![0]!);
      expect(tombstone.phase).toBe('cancelled');
      expect(tombstone.cancellation?.reason).toBe('requested_window_unreachable');
      const job = structuredClone(store.state.departureJob);
      const demandBefore = store.state.world.counters.demand;
      await store.update((state) => advanceOperation(state.world, state.world.now + 60_000));
      expect(store.state.world.counters.demand).toBeGreaterThan(demandBefore);
      expect(store.state.world.reservations).toEqual([tombstone]);
      expect(store.state.departureJob).toEqual(job);
      const retained = structuredClone(store.state);
      await expect(
        store.update((state) => {
          state.world.reservations = [];
        }),
      ).rejects.toThrow('Cancelled selected reservation');
      await expect(
        store.update((state) => {
          const reservation = state.world.reservations![0]!;
          reservation.cancellation!.note = 'Changed after cancellation';
          reservation.plan.sourceRevision++;
          reservation.order.schedule.end = new Date(state.world.now + 60_000).toISOString();
        }),
      ).rejects.toThrow('Cancelled selected reservation');
      await expect(
        store.update((state) => {
          delete state.departureJob;
        }),
      ).rejects.toThrow('retained departure history');
      expect(store.state).toEqual(retained);
      expect(await readOperationCheckpoint(path)).toEqual(retained);
      expect(store.state.world.attempts.some((attempt) => attempt.id === tombstone.id)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a pending transaction that reopens a cancelled selected reservation and recovers its unchanged original', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-cancelled-selected-recovery-'));
    try {
      const path = join(directory, 'world.json');
      const store = new OperationStore(path, cancelledSelectedCheckpoint());
      await store.update(() => {});
      const retained = structuredClone(store.state);
      const writeBatch = vi
        .spyOn(operationHistory, 'writeOperationBatch')
        .mockRejectedValueOnce(new Error('Injected archive interruption'));
      try {
        await expect(store.update((state) => advanceOperation(state.world, state.world.now + 60_000))).rejects.toThrow(
          'Injected archive interruption',
        );
      } finally {
        writeBatch.mockRestore();
      }
      const pendingPath = `${path}.pending`;
      const original = await readFile(pendingPath, 'utf8');
      const envelope = JSON.parse(original) as { version: number; body: string; sha256: string };
      const transaction = JSON.parse(envelope.body) as { next: OperationCheckpoint };
      transaction.next.world.reservations![0]!.phase = 'awaiting-release';
      delete transaction.next.world.reservations![0]!.cancellation;
      const body = JSON.stringify(transaction);
      const altered = JSON.stringify({ ...envelope, body, sha256: sha256(body) }) + '\n';
      await writeFile(pendingPath, altered);
      const restored = (await readOperationCheckpoint(path))!;
      const refused = new OperationStore(path, restored);
      await expect(refused.update(() => {})).rejects.toThrow('Cancelled selected reservation');
      expect(refused.state).toEqual(retained);
      expect(await readFile(pendingPath, 'utf8')).toBe(altered);
      expect(await readOperationCheckpoint(path)).toEqual(retained);
      await writeFile(pendingPath, original);
      const resumed = new OperationStore(path, restored);
      await resumed.update(() => {});
      expect(resumed.state.world.reservations).toEqual(retained.world.reservations);
      expect(resumed.state.departureJob).toEqual(retained.departureJob);
      expect(resumed.state.world.now).toBe(retained.world.now + 60_000);
      await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains exact command-link reports through restart while ordinary evidence keeps moving', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-command-link-state-'));
    try {
      const path = join(directory, 'world.json');
      const world = createOperation({
        ...operationCapacityPreset('illustrative-25.1'),
        runId: 'held-command-link',
        start: '2026-10-15T14:00:00.000Z',
        fleet: { alpha: 2, beta: 1 },
        commandLinkEpisode: 'canal-market-relay.1',
      });
      const start = world.now;
      let store = new OperationStore(
        path,
        initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
      );
      expect(commandLinkDeliveryStatus(world, {}).commandLinkDelivery).toEqual({
        state: 'awaiting reports',
        pendingReports: 0,
      });
      await store.update((state) => advanceOperation(state.world, start + 95_000));
      const lost = Object.values(store.state.pending)
        .flat()
        .filter((entry) => entry.fact.kind === 'command-link');
      expect(lost.length).toBeGreaterThan(0);
      expect(lost.every((entry) => entry.fact.kind === 'command-link' && entry.fact.status === 'lost')).toBe(true);
      const restored = await readOperationCheckpoint(path);
      expect(restored).toEqual(store.state);
      store = new OperationStore(path, restored!);
      expect(store.pendingCommandLinkHeads()).toEqual(lost);
      await store.update((state) => advanceOperation(state.world, start + 121_000));
      const reports = structuredClone(
        Object.values(store.state.pending)
          .flat()
          .filter((entry) => entry.fact.kind === 'command-link'),
      );
      expect(
        reports.filter((entry) => entry.fact.kind === 'command-link' && entry.fact.status === 'lost'),
      ).toHaveLength(reports.length / 2);
      for (const report of lost) expect(reports).toContainEqual(report);
      const attemptId = lost[0]!.fact.attemptId;
      const restoration = reports.find(
        (entry) =>
          entry.fact.attemptId === attemptId && entry.fact.kind === 'command-link' && entry.fact.status === 'restored',
      )!;
      await expect(store.accept(restoration, 'out-of-order-restoration')).rejects.toThrow('pending delivery head');
      const positions = store.state.pending[attemptId]!.filter((entry) => entry.fact.kind === 'position');
      await expect(store.accept(positions.at(-1)!, 'out-of-order-position')).rejects.toThrow('pending delivery head');
      let positionsAfterLoss = 0;
      const drain = async () => {
        while (store.pendingHeads().length) {
          const head = store.pendingHeads()[0]!;
          if (head.fact.kind === 'position' && Date.parse(head.fact.at) >= start + 90_000) positionsAfterLoss++;
          await store.accept(head, `receipt-${head.fact.sequence}`);
        }
      };
      await drain();
      expect(positionsAfterLoss).toBeGreaterThan(0);
      expect(Object.values(store.state.pending).flat()).toEqual(reports);
      expect(commandLinkDeliveryStatus(store.state.world, store.state.pending).commandLinkDelivery).toEqual({
        state: 'pending',
        pendingReports: reports.length,
      });
      await store.update((state) => advanceOperation(state.world, start + 400_000));
      await drain();
      expect(store.state.world.attempts.some((attempt) => attempt.id === attemptId)).toBe(false);
      expect(Object.values(store.state.pending).flat()).toEqual(reports);
      expect(store.pendingHeads()).toEqual([]);
      expect(await readOperationCheckpoint(path)).toEqual(store.state);
      const archived: OperationHistoryBatch[] = [];
      for await (const batch of operationHistory.readOperationHistory<OperationHistoryBatch>(
        store.historyDirectory,
        store.state.historyBatches,
      ))
        archived.push(batch.value);
      const originals = archived.flatMap((batch) => batch.facts).filter((entry) => entry.fact.kind === 'command-link');
      expect(originals.sort((left, right) => left.fact.sequence - right.fact.sequence)).toEqual(
        [...reports].sort((left, right) => left.fact.sequence - right.fact.sequence),
      );
      expect(
        archived
          .flatMap((batch) => batch.receipts)
          .some((receipt) => reports.some((report) => report.fact.sequence === receipt.sequence)),
      ).toBe(false);
      expect(archived.flatMap((batch) => batch.attempts).some((attempt) => attempt.id === attemptId)).toBe(true);
      while (store.pendingCommandLinkHeads().length) {
        const head = store.pendingCommandLinkHeads()[0]!;
        await store.accept(head, `command-link-receipt-${head.fact.sequence}`);
      }
      expect(store.state.pending).toEqual({});
      expect(commandLinkDeliveryStatus(store.state.world, store.state.pending).commandLinkDelivery).toEqual({
        state: 'drained',
        pendingReports: 0,
      });
      expect(await readOperationCheckpoint(path)).toEqual(store.state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('lets same-attempt HTTP and native work pass held telemetry, then replays exact frames in order after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-'));
    try {
      const path = join(directory, 'world.json');
      const world = createOperation({
        runId: 'held-telemetry',
        start: '2026-10-15T14:00:00.000Z',
        profile: 'telemetry-delivery-interruption',
      });
      advanceOperation(world, world.now);
      const attempt = world.attempts[0]!;
      const interruption = world.telemetryDeliveryInterruption!;
      const assignment = world.facts.find((fact) => fact.kind === 'order' && fact.order.version === 2);
      if (assignment?.kind !== 'order') throw new Error('World assignment missing');
      let store = new OperationStore(
        path,
        initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false }),
      );
      await store.update(() => {});
      while (store.pendingHeads().length) {
        const prepared = store.pendingHeads()[0]!;
        await store.accept(prepared, `receipt-${prepared.fact.sequence}`);
      }
      const acceptedBeforeHold = store.state.accepted;
      let httpSequence = -1;
      let nativeSequence = -1;
      await store.update((state) => {
        advanceOperation(state.world, Date.parse(interruption.startsAt) + 10_000);
        httpSequence = state.world.nextFact++;
        state.world.facts.push({
          ...assignment,
          sequence: httpSequence,
          at: new Date(state.world.now).toISOString(),
          order: { ...assignment.order, version: 3, updated_at: new Date(state.world.now).toISOString() },
        });
        nativeSequence = state.world.nextFact++;
        const person = state.world.people.find((person) => person.id === attempt.personId)!;
        state.world.facts.push({
          kind: 'landing',
          sequence: nativeSequence,
          tenant: attempt.tenant,
          attemptId: attempt.id,
          aircraftId: attempt.aircraftId,
          sourceSessionId: attempt.sourceSessionId,
          at: new Date(state.world.now).toISOString(),
          personId: person.id,
          personName: person.name,
        });
      });
      const held = structuredClone(
        store.state.pending[attempt.id]!.filter((prepared) => prepared.fact.kind === 'position'),
      );
      expect(held.length).toBeGreaterThan(1);
      expect(
        interruptionFrame(store.state.world, {
          ...held[0]!.fact,
          attemptId: 'later-attempt',
          sourceSessionId: 'later-capture',
        }),
      ).toBe(true);
      const httpHead = store.pendingHeads().find((prepared) => prepared.fact.attemptId === attempt.id)!;
      expect(httpHead.fact.sequence).toBe(httpSequence);
      const unchanged = structuredClone(store.state);
      await expect(store.accept(held[1]!, 'out-of-order-position')).rejects.toThrow('pending delivery head');
      await expect(
        store.accept(
          { ...held[0]!, bytesBase64: Buffer.from('changed wire bytes').toString('base64') },
          'changed-frame',
        ),
      ).rejects.toThrow('pending delivery head');
      expect(store.state).toEqual(unchanged);
      const otherHead = store.pendingHeads().find((prepared) => prepared.fact.attemptId !== attempt.id)!;
      expect(otherHead).toEqual(store.state.pending[otherHead.fact.attemptId]![0]);
      await store.accept(otherHead, 'other-flight-receipt');
      await store.accept(httpHead, 'http-during-interruption');
      const nativeHead = store.pendingHeads().find((prepared) => prepared.fact.attemptId === attempt.id)!;
      expect(nativeHead.fact.sequence).toBe(nativeSequence);
      const restored = await readOperationCheckpoint(path);
      expect(restored!.pending[attempt.id]!.filter((prepared) => prepared.fact.kind === 'position')).toEqual(held);
      expect(restored!.accepted).toBe(acceptedBeforeHold + 2);
      store = new OperationStore(path, restored!);
      expect(store.pendingHeads().find((prepared) => prepared.fact.attemptId === attempt.id)).toEqual(nativeHead);
      await store.update((state) => advanceOperation(state.world, Date.parse(interruption.endsAt)));
      expect(store.pendingHeads().find((prepared) => prepared.fact.attemptId === attempt.id)).toEqual(held[0]);
      await store.accept(nativeHead, 'native-finished-after-recovery');
      const chronological = structuredClone(store.state.pending[attempt.id]!);
      expect(chronological.every((prepared) => prepared.fact.kind === 'position')).toBe(true);
      expect(chronological.map((prepared) => prepared.fact.sequence)).toEqual(
        chronological.map((prepared) => prepared.fact.sequence).sort((left, right) => left - right),
      );
      await expect(store.accept(chronological[1]!, 'late-out-of-order-position')).rejects.toThrow(
        'pending delivery head',
      );
      for (const prepared of chronological) {
        expect(store.pendingHeads().find((head) => head.fact.attemptId === attempt.id)).toEqual(prepared);
        await store.accept(prepared, `recovered-${prepared.fact.sequence}`);
      }
      expect(store.state.pending[attempt.id]).toBeUndefined();
      await expect(store.accept(nativeHead, 'duplicate-native')).rejects.toThrow('pending delivery head');
      expect(store.state.accepted).toBe(acceptedBeforeHold + 3 + chronological.length);
      await store.update((state) => advanceOperation(state.world, Date.parse(interruption.endsAt) + 10_000));
      expect(store.pendingHeads().some((prepared) => prepared.fact.attemptId === attempt.id)).toBe(true);
      expect(telemetryDeliveryStatus(store.state.world, store.state.pending).telemetryDelivery).toMatchObject({
        state: 'recovered',
        bufferedFrames: 0,
      });
      const batches: OperationHistoryBatch[] = [];
      for await (const batch of operationHistory.readOperationHistory<OperationHistoryBatch>(
        store.historyDirectory,
        store.state.historyBatches,
      ))
        batches.push(batch.value);
      const receipts = batches.flatMap((batch) => batch.receipts);
      expect(receipts.filter((receipt) => receipt.sequence === nativeSequence)).toEqual([
        { sequence: nativeSequence, attemptId: attempt.id, receiptId: 'native-finished-after-recovery' },
      ]);
      expect(receipts.filter((receipt) => receipt.sequence === httpSequence)).toEqual([
        { sequence: httpSequence, attemptId: attempt.id, receiptId: 'http-during-interruption' },
      ]);
      const archivedFacts = batches.flatMap((batch) => batch.facts);
      for (const prepared of held)
        expect(archivedFacts.find((fact) => fact.fact.sequence === prepared.fact.sequence)).toEqual(prepared);
      expect(await readOperationCheckpoint(path)).toEqual(store.state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('catches a live world up after a scheduler pause and a checkpoint restart', () => {
    const initial = initialCheckpoint();
    initial.clock.mode = 'live';
    advanceLiveClock(initial, initial.world.now + 30_000, false);
    const beforePause = structuredClone(initial);
    advanceLiveClock(initial, beforePause.world.now + 60_000, true);
    expect(initial.world).toEqual(beforePause.world);
    const resumed = JSON.parse(JSON.stringify(initial)) as OperationCheckpoint;
    advanceLiveClock(resumed, beforePause.world.now + 120_000, false);
    const expected = initialCheckpoint();
    advanceOperation(expected.world, beforePause.world.now + 120_000);
    expect(resumed.world).toEqual(expected.world);
    expect(resumed.clock).toEqual({ mode: 'live', wallAt: resumed.world.now, paused: false });
  });
  it('retains concurrent updates together across a checkpoint restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-'));
    try {
      const path = join(directory, 'world.json');
      const initial = initialCheckpoint();
      initial.clock.mode = 'live';
      const store = new OperationStore(path, initial);
      await Promise.all([
        store.update((state) => {
          advanceOperation(state.world, state.world.now + 30_000);
          state.clock.wallAt += 30_000;
        }),
        store.update((state) => {
          advanceOperation(state.world, state.world.now + 30_000);
          state.clock.wallAt += 30_000;
        }),
      ]);

      const restored = await readOperationCheckpoint(path);
      expect(restored).toEqual(store.state);
      expect(restored!.world.now).toBe(initial.world.now + 60_000);
      expect(restored!.clock.wallAt).toBe(initial.clock.wallAt + 60_000);
      expect(restored!.world.counters.demand).toBe(3);
      expect(restored!.accepted).toBe(0);
      expect(Object.values(restored!.pending).flat().length).toBe(restored!.world.nextFact);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps completed history durable while the checkpoint and pending heads track only active work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-'));
    try {
      const path = join(directory, 'world.json');
      const config = {
        runId: 'sustained-checkpoint',
        start: '2026-10-15T14:00:00.000Z',
        sampleIntervalMs: 60_000,
        demandIntervalMs: 120_000,
        turnaroundMs: 1000,
        chargeMs: 1000,
      };
      const world = createOperation(config);
      const start = world.now;
      let store = new OperationStore(
        path,
        initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
      );
      const accepted: OperationReceipt[] = [];
      let earlyBytes = 0;
      for (const minutes of [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 58]) {
        await store.update((state) => advanceOperation(state.world, start + minutes * 60_000));
        while (store.pendingHeads().length) {
          for (const prepared of store.pendingHeads()) {
            const receipt = {
              sequence: prepared.fact.sequence,
              attemptId: prepared.fact.attemptId,
              receiptId: `receipt-${prepared.fact.sequence}`,
            };
            await store.accept(prepared, receipt.receiptId);
            accepted.push(receipt);
          }
        }
        if (minutes === 8) {
          expect(store.state.world.counters.attempts).toBe(5);
          earlyBytes = Buffer.byteLength(await readFile(path, 'utf8'));
          const restored = await readOperationCheckpoint(path);
          expect(restored).toEqual(store.state);
          store = new OperationStore(path, restored!);
        }
      }
      expect(store.state.world.counters.attempts).toBe(30);
      expect(store.state.accepted).toBe(accepted.length);
      expect(store.pendingHeads()).toEqual([]);
      expect(store.state.world.demand).toEqual([]);
      expect(store.state.world.facts).toEqual([]);
      expect(store.state.world.attempts.length).toBeLessThanOrEqual(store.state.world.aircraft.length);
      expect(store.state.world.events.length).toBeLessThanOrEqual(store.state.world.aircraft.length * 4 + 3);
      expect(Buffer.byteLength(await readFile(path, 'utf8'))).toBeLessThan(earlyBytes * 2);

      await store.update((state) => advanceOperation(state.world, start + 60 * 60_000));
      const pendingHeads = structuredClone(store.pendingHeads());
      expect(pendingHeads.length).toBeGreaterThan(0);
      expect(pendingHeads.length).toBeLessThanOrEqual(store.state.world.aircraft.length);
      expect(pendingHeads.every((prepared) => prepared.fact.sequence >= accepted.length)).toBe(true);
      const restored = await readOperationCheckpoint(path);
      store = new OperationStore(path, restored!);
      expect(store.pendingHeads()).toEqual(pendingHeads);

      const batches: OperationHistoryBatch[] = [];
      for await (const batch of operationHistory.readOperationHistory<OperationHistoryBatch>(
        store.historyDirectory,
        store.state.historyBatches,
      )) {
        batches.push(batch.value);
      }
      const expected = createOperation(config);
      advanceOperation(expected, start + 60 * 60_000);
      expect(batches).toHaveLength(store.state.historyBatches);
      expect(batches.flatMap((batch) => batch.facts)).toEqual(expected.facts.map(prepareWorldFact));
      expect(batches.flatMap((batch) => batch.receipts)).toEqual(accepted);
      expect(new Set(batches.flatMap((batch) => batch.receipts.map((receipt) => receipt.sequence))).size).toBe(
        accepted.length,
      );
      expect(batches.flatMap((batch) => batch.demand)).toHaveLength(expected.counters.attempts);
      const byIdentity = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
      expect(batches.flatMap((batch) => batch.attempts).sort(byIdentity)).toEqual(
        expected.attempts.filter((attempt) => attempt.phase === 'landed').sort(byIdentity),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('recovers a marked transaction after an interrupted archive write without duplicating history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-'));
    try {
      const path = join(directory, 'world.json');
      const initial = initialCheckpoint();
      initial.clock.mode = 'live';
      const store = new OperationStore(path, initial);
      await store.update(() => {});
      const writeBatch = vi
        .spyOn(operationHistory, 'writeOperationBatch')
        .mockRejectedValueOnce(new Error('Injected archive interruption'));
      try {
        await expect(store.update((state) => advanceOperation(state.world, state.world.now + 120_000))).rejects.toThrow(
          'Injected archive interruption',
        );
      } finally {
        writeBatch.mockRestore();
      }
      const transaction = JSON.parse(await readFile(`${path}.pending`, 'utf8')) as { body: string };
      const marked = JSON.parse(transaction.body) as { archive: OperationHistoryBatch; next: OperationCheckpoint };
      const restored = await readOperationCheckpoint(path);
      const resumed = new OperationStore(path, restored!);
      await resumed.update(() => {});
      expect(resumed.state.pending).toEqual(marked.next.pending);
      expect(resumed.state.historyBatches).toBe(1);
      await expect(readFile(`${path}.pending`)).rejects.toMatchObject({ code: 'ENOENT' });
      const prepared = resumed.pendingHeads()[0]!;
      await resumed.accept(prepared, `receipt-${prepared.fact.sequence}`);

      const batches: OperationHistoryBatch[] = [];
      for await (const batch of operationHistory.readOperationHistory<OperationHistoryBatch>(
        resumed.historyDirectory,
        resumed.state.historyBatches,
      )) {
        batches.push(batch.value);
      }
      expect(batches).toHaveLength(2);
      expect(batches.flatMap((batch) => batch.facts)).toEqual(marked.archive.facts);
      expect(batches.flatMap((batch) => batch.receipts)).toEqual([
        {
          sequence: prepared.fact.sequence,
          attemptId: prepared.fact.attemptId,
          receiptId: `receipt-${prepared.fact.sequence}`,
        },
      ]);
      expect(await readOperationCheckpoint(path)).toEqual(resumed.state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('archives an offline preview without accumulating undeliverable pending jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-'));
    try {
      const path = join(directory, 'world.json');
      const store = new OperationStore(path, initialCheckpoint());
      await store.update((state) => advanceOperation(state.world, state.world.now + 600_000));

      expect(store.state.world.nextFact).toBeGreaterThan(0);
      expect(store.state.world.facts).toEqual([]);
      expect(store.pendingHeads()).toEqual([]);
      expect(store.state.accepted).toBe(0);
      const batches: OperationHistoryBatch[] = [];
      for await (const batch of operationHistory.readOperationHistory<OperationHistoryBatch>(
        store.historyDirectory,
        store.state.historyBatches,
      )) {
        batches.push(batch.value);
      }
      expect(batches.flatMap((batch) => batch.facts)).toHaveLength(store.state.world.nextFact);
      expect(await readOperationCheckpoint(path)).toEqual(store.state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects corrupt bytes and a mismatched commitment instead of resetting the run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-operation-'));
    try {
      const path = join(directory, 'world.json');
      expect(await readOperationCheckpoint(path)).toBeUndefined();
      await new OperationStore(path, initialCheckpoint()).update(() => {});
      const envelope = JSON.parse(await readFile(path, 'utf8')) as { body: string; sha256: string };

      await writeFile(path, '{');
      await expect(readOperationCheckpoint(path)).rejects.toBeInstanceOf(SyntaxError);

      await writeFile(path, JSON.stringify({ ...envelope, body: `${envelope.body} ` }));
      await expect(readOperationCheckpoint(path)).rejects.toThrow('commitment is invalid; refusing to reset');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
