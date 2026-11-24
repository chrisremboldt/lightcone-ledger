import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalize } from '@ledger/integrity';
import {
  advanceOperation,
  captureOperationMonitoringBaseline,
  setOperationMonitoringAvailability,
  observeOperationMonitoring,
  operationCommandLinkReading,
  compactOperation,
  holdsOperationAttempt,
  upgradeOperationWorld,
  recordOrdinaryIncidentReceipt,
  type OperationArchive,
  type OperationWorld,
  operationAdditiveFlight,
  retireOperationOrdinaryFlight,
} from '@ledger/simulation-models/operation';
import { validateOperationOrdinarySources, validateOperationOrdinaryTransition } from './operation-ordinary-state.js';
import { validateOperationDemoCycles, validateOperationDemoTransition } from './operation-demo-runtime.js';
import { prepareWorldFact, type PreparedWorldFact } from './operation-delivery.js';
import { readOperationBatch, retireOperationBatches, writeOperationBatch } from './operation-history.js';
import type { OperationDeparturePreparation } from './operation-departure-journal.js';
import {
  operationMonitoringStatusAllowed,
  validateOperationMonitoringRuntimeState,
  type OperationMonitoringRuntimeState,
} from './operation-monitoring-runtime.js';
import {
  commandLinkDeliveryPending,
  departureDeliveryChannel,
  missionDeliveryPending,
  ordinaryDeliveryPending,
  interruptionFrame,
  telemetryDeliveryInterrupted,
} from './operation-delivery-policy.js';

export interface OperationReceipt {
  sequence: number;
  attemptId: string;
  receiptId: string;
}
export interface OperationHistoryBatch {
  runId: string;
  revision: number;
  facts: PreparedWorldFact[];
  demand: OperationArchive['demand'];
  attempts: OperationArchive['attempts'];
  receipts: OperationReceipt[];
  demoCycles?: Array<import('./operation-demo-runtime.js').OperationDemoCycleState & { archivedRecovery?: unknown }>;
  ordinaryFlights?: Array<
    import('./operation-ordinary-state.js').OperationOrdinaryFlightState & { archivedRecovery?: unknown }
  >;
}
export interface OperationReservationRevisionReceipt {
  version: 'operation.reservation-revision.1';
  planDigest: string;
  runId: string;
  reservationId: string;
  sourceRevision: number;
  sourceDigest: string;
  occurredAt: string;
}
export interface OperationCheckpoint {
  storageVersion: 2;
  revision: number;
  historyBatches: number;
  world: OperationWorld;
  clock: { mode: 'live' | 'manual'; wallAt: number; paused: boolean };
  pending: Record<string, PreparedWorldFact[]>;
  accepted: number;
  departureJob?: {
    version: 'operation.departure-job.1';
    flightId: string;
    reservationId: string;
    departureAttemptId: string;
    planDigest: string;
  };
  departureRequests?: Record<string, OperationDeparturePreparation>;
  reservationRevision?: OperationReservationRevisionReceipt;
  monitoring?: OperationMonitoringRuntimeState;
  demoCycles?: Record<string, import('./operation-demo-runtime.js').OperationDemoCycleState>;
  demoDiscovery?: { sourcePrincipalId: string; principalRevision: number; cursor: string };
  demoDepartureJobs?: Record<string, NonNullable<OperationCheckpoint['departureJob']>>;
  ordinaryFlights?: Record<string, import('./operation-ordinary-state.js').OperationOrdinaryFlightState>;
  ordinaryDepartureJobs?: Record<string, NonNullable<OperationCheckpoint['departureJob']>>;
  migration?: { prepared: Record<string, PreparedWorldFact>; receipts: Record<string, string> };
}
interface PreviousCheckpoint {
  world: OperationWorld;
  clock: OperationCheckpoint['clock'];
  prepared: Record<string, PreparedWorldFact>;
  receipts: Record<string, string>;
}
interface PendingTransaction {
  baseRevision: number;
  next: OperationCheckpoint;
  archive: OperationHistoryBatch;
}
const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');

function validateSelectedDeparturePin(previous: OperationCheckpoint, next: OperationCheckpoint): void {
  const previousProfile = previous.world.config.predeparture;
  const nextProfile = next.world.config.predeparture;
  const previousSelected =
    previousProfile?.version === 'reserve-selected-await-release.1' ? previousProfile : undefined;
  const nextSelected = nextProfile?.version === 'reserve-selected-await-release.1' ? nextProfile : undefined;
  if (!previousSelected && !nextSelected) return;
  if (
    !previousSelected ||
    !nextSelected ||
    previous.world.config.runId !== next.world.config.runId ||
    previousSelected.tenant !== nextSelected.tenant ||
    previousSelected.attemptId !== nextSelected.attemptId
  )
    throw new Error('Selected departure configuration is retained in its checkpoint and cannot change');
  const previousReservation = previous.world.reservations?.find((row) => row.id === previousSelected.attemptId);
  const nextReservation = next.world.reservations?.find((row) => row.id === previousSelected.attemptId);
  if (previousReservation?.phase !== 'cancelled' && nextReservation?.phase !== 'cancelled') return;
  const invalid = (): never => {
    throw new Error('Cancelled selected reservation and its retained departure history cannot change');
  };
  if (
    previousReservation?.phase === 'cancelled' &&
    canonicalize(previousReservation) !== canonicalize(nextReservation ?? null)
  )
    invalid();
  if (
    previousReservation &&
    nextReservation?.phase === 'cancelled' &&
    (canonicalize(previousReservation.plan) !== canonicalize(nextReservation.plan) ||
      canonicalize(previousReservation.order) !== canonicalize(nextReservation.order))
  )
    invalid();
  if (
    next.world.attempts.some((attempt) => attempt.id === previousSelected.attemptId) ||
    next.world.departures?.some(
      (commit) =>
        commit.attemptId === previousSelected.attemptId || commit.reservationId === previousSelected.attemptId,
    )
  )
    invalid();
  if (previous.departureJob && canonicalize(previous.departureJob) !== canonicalize(next.departureJob ?? null))
    invalid();
  for (const allocation of (previous.world.departureAllocations ?? []).filter(
    (row) => !operationAdditiveFlight(previous.world, row.reservationId),
  )) {
    const retained = next.world.departureAllocations?.find((row) => row.id === allocation.id);
    if (canonicalize(allocation) !== canonicalize(retained ?? null)) invalid();
  }
  for (const [flightId, request] of Object.entries(previous.departureRequests ?? {}).filter(
    ([, row]) => !operationAdditiveFlight(previous.world, row.reservationId),
  ))
    if (canonicalize(request) !== canonicalize(next.departureRequests?.[flightId] ?? null)) invalid();
}

function validateSelectedDeparture(state: OperationCheckpoint): void {
  const profile = state.world.config.predeparture;
  if (profile?.version !== 'reserve-selected-await-release.1') return;
  upgradeOperationWorld(state.world);
  const invalid = (): never => {
    throw new Error('Selected departure checkpoint differs from its one pinned reservation');
  };
  const selected = (attemptId: string) => holdsOperationAttempt(state.world.config, profile.tenant, attemptId);
  if (
    state.reservationRevision !== undefined &&
    (!state.reservationRevision ||
      !selected(state.reservationRevision.reservationId) ||
      state.reservationRevision.runId !== state.world.config.runId)
  )
    invalid();
  const job = state.departureJob;
  if (
    job !== undefined &&
    (!job ||
      job.version !== 'operation.departure-job.1' ||
      !selected(job.reservationId) ||
      typeof job.flightId !== 'string' ||
      !job.flightId ||
      typeof job.departureAttemptId !== 'string' ||
      !job.departureAttemptId ||
      !/^[a-f0-9]{64}$/.test(job.planDigest))
  )
    invalid();
  for (const collection of [state.world.departureAllocations, state.world.departures]) {
    if (
      collection !== undefined &&
      (!Array.isArray(collection) ||
        collection.filter((row) => !operationAdditiveFlight(state.world, row.reservationId)).length > 1)
    )
      invalid();
    for (const row of (collection ?? []).filter((row) => !operationAdditiveFlight(state.world, row.reservationId)))
      if (
        !job ||
        !row ||
        !selected(row.reservationId) ||
        row.flightId !== job.flightId ||
        row.departureAttemptId !== job.departureAttemptId
      )
        invalid();
  }
  for (const commit of (state.world.departures ?? []).filter(
    (row) => !operationAdditiveFlight(state.world, row.reservationId),
  ))
    if (
      !selected(commit.attemptId) ||
      !selected(commit.allocation?.reservationId) ||
      commit.caller?.tenantId !== `tenant-${profile.tenant}` ||
      commit.caller.planDigest !== job?.planDigest
    )
      invalid();
  const requests = state.departureRequests;
  if (
    requests !== undefined &&
    (!requests ||
      typeof requests !== 'object' ||
      Array.isArray(requests) ||
      Object.values(requests).filter((row) => !operationAdditiveFlight(state.world, row.reservationId)).length > 1)
  )
    invalid();
  for (const [flightId, prepared] of Object.entries(requests ?? {}).filter(
    ([, row]) => !operationAdditiveFlight(state.world, row.reservationId),
  ))
    if (
      !job ||
      !prepared ||
      !selected(prepared.reservationId) ||
      prepared.runId !== state.world.config.runId ||
      prepared.tenantId !== `tenant-${profile.tenant}` ||
      prepared.planDigest !== job.planDigest ||
      flightId !== job.flightId ||
      prepared.flightId !== job.flightId ||
      !selected(prepared.allocation?.reservationId) ||
      prepared.allocation.flightId !== job.flightId ||
      prepared.allocation.departureAttemptId !== job.departureAttemptId
    )
      invalid();
}

export function initialOperationCheckpoint(
  world: OperationWorld,
  clock: OperationCheckpoint['clock'],
): OperationCheckpoint {
  return { storageVersion: 2, revision: 0, historyBatches: 0, world, clock, pending: {}, accepted: 0 };
}
export function advanceLiveClock(state: OperationCheckpoint, wallAt: number, paused: boolean): void {
  if (state.clock.mode !== 'live') throw new Error('A manual world cannot use the live delivery clock');
  if (!paused) {
    advanceOperation(state.world, state.world.now + Math.max(0, wallAt - state.clock.wallAt));
    state.clock.wallAt = Math.max(wallAt, state.clock.wallAt);
  }
  state.clock.paused = paused;
}
async function readCommitted<T>(path: string): Promise<T | undefined> {
  let encoded: string;
  try {
    encoded = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const envelope = JSON.parse(encoded) as { version: number; body: string; sha256: string };
  if (
    ![1, 2].includes(envelope.version) ||
    typeof envelope.body !== 'string' ||
    sha256(envelope.body) !== envelope.sha256
  )
    throw new Error('World checkpoint commitment is invalid; refusing to reset the run');
  return JSON.parse(envelope.body) as T;
}
export async function readOperationCheckpoint(path: string): Promise<OperationCheckpoint | undefined> {
  const value = await readCommitted<OperationCheckpoint | PreviousCheckpoint>(path);
  if (value === undefined) return undefined;
  if (
    !value ||
    !['operation-world.1', 'operation-world.2'].includes(value.world?.version) ||
    !['manual', 'live'].includes(value.clock?.mode) ||
    !Number.isSafeInteger(value.world.now) ||
    !Number.isSafeInteger(value.clock.wallAt)
  )
    throw new Error('World checkpoint shape is invalid; refusing to reset the run');
  upgradeOperationWorld(value.world);
  if ('storageVersion' in value) {
    if (
      value.storageVersion !== 2 ||
      !value.pending ||
      !Number.isSafeInteger(value.accepted) ||
      !Number.isSafeInteger(value.revision) ||
      !Number.isSafeInteger(value.historyBatches)
    )
      throw new Error('World checkpoint storage state is invalid');
    validateSelectedDeparture(value);
    validateOperationDemoCycles(value);
    validateOperationOrdinarySources(value);
    if (value.monitoring !== undefined) validateOperationMonitoringRuntimeState(value.monitoring, value.world);
    return value;
  }
  if (!value.prepared || !value.receipts) throw new Error('Legacy world checkpoint delivery state is invalid');
  return {
    ...initialOperationCheckpoint(value.world, value.clock),
    accepted: Object.keys(value.receipts).length,
    migration: { prepared: value.prepared, receipts: value.receipts },
  };
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 2, body, sha256: sha256(body) }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(path);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
function observeMonitoringState(state: OperationCheckpoint, monitoring: OperationMonitoringRuntimeState): void {
  const observer = monitoring.observer;
  observeOperationMonitoring(observer, state.world);
  const selected = observer.flights[0]!;
  if (
    observer.failure ||
    observer.completedAt ||
    !selected.departureAt ||
    selected.initialLinkObservation ||
    selected.landingAt ||
    !selected.monitoringAvailable ||
    selected.reports.length
  )
    return;
  const reading = operationCommandLinkReading(state.world, selected.attemptId);
  if (!reading) return;
  if (
    reading.aircraftId !== selected.aircraftId ||
    reading.sourceId !== selected.c2SourceId ||
    reading.sourceSessionId !== selected.c2SourceSessionId ||
    reading.occurredAt !== new Date(state.world.now).toISOString()
  )
    throw new Error('Simulated C2 reading differs from its selected current source session');
  captureOperationMonitoringBaseline(observer, state.world, selected.attemptId, reading.state);
}

function observeMonitoring(state: OperationCheckpoint): void {
  if (state.monitoring) observeMonitoringState(state, state.monitoring);
  for (const cycle of Object.values(state.demoCycles ?? {}))
    if (cycle.monitoring) observeMonitoringState(state, cycle.monitoring);
}

export class OperationStore {
  private serial: Promise<unknown> = Promise.resolve();
  private recovered = false;
  private readonly resumeDemoCycles: Set<string>;
  private readonly resumeDemoAt: number;
  constructor(
    private path: string,
    public state: OperationCheckpoint,
    options: { resumeAt?: number } = {},
  ) {
    this.resumeDemoAt = options.resumeAt ?? Date.now();
    this.resumeDemoCycles = new Set(
      Object.entries(state.demoCycles ?? {})
        .filter(([, cycle]) => cycle.monitoring && !cycle.monitoring.observer.completedAt)
        .map(([id]) => id),
    );
  }
  get checkpointPath(): string {
    return this.path;
  }
  get historyDirectory(): string {
    return `${this.path}.history`;
  }
  pendingHeads(): PreparedWorldFact[] {
    const interrupted = telemetryDeliveryInterrupted(this.state.world);
    return Object.values(this.state.pending).flatMap((queue) => {
      if (queue.some((prepared) => departureDeliveryChannel(this.state.world, prepared.fact))) {
        const seen = new Set<string>();
        return queue.filter((prepared) => {
          if (
            !ordinaryDeliveryPending(prepared.fact) ||
            (interrupted && interruptionFrame(this.state.world, prepared.fact))
          )
            return false;
          const channel = departureDeliveryChannel(this.state.world, prepared.fact) ?? 'order';
          if (seen.has(channel)) return false;
          seen.add(channel);
          return true;
        });
      }
      const eligible = queue.find(
        (prepared) =>
          ordinaryDeliveryPending(prepared.fact) &&
          (!interrupted || !interruptionFrame(this.state.world, prepared.fact)),
      );
      return eligible ? [eligible] : [];
    });
  }
  deliveryKey(prepared: PreparedWorldFact): string {
    const channel = departureDeliveryChannel(this.state.world, prepared.fact);
    return `${prepared.fact.attemptId}${channel ? `:${channel}` : ''}`;
  }
  pendingCommandLinkHeads(): PreparedWorldFact[] {
    return Object.values(this.state.pending).flatMap((queue) => {
      const eligible = queue.find(
        (prepared) =>
          commandLinkDeliveryPending(prepared.fact) &&
          operationMonitoringStatusAllowed(this.state.monitoring, prepared.fact.attemptId) &&
          Object.values(this.state.demoCycles ?? {}).every((cycle) =>
            operationMonitoringStatusAllowed(cycle.monitoring, prepared.fact.attemptId),
          ),
      );
      return eligible ? [eligible] : [];
    });
  }
  pendingMissionHeads(): PreparedWorldFact[] {
    return Object.values(this.state.pending).flatMap((queue) => {
      const eligible = queue.find((prepared) => missionDeliveryPending(prepared.fact));
      return eligible ? [eligible] : [];
    });
  }
  private async recover(): Promise<void> {
    if (this.recovered) return;
    const transaction = await readCommitted<PendingTransaction>(`${this.path}.pending`);
    if (transaction) {
      if (
        transaction.next.revision !== transaction.baseRevision + 1 ||
        transaction.archive.revision !== transaction.next.revision ||
        transaction.next.world.config.runId !== this.state.world.config.runId
      )
        throw new Error('World pending transaction does not match its checkpoint');
      if (
        this.state.revision !== transaction.baseRevision &&
        JSON.stringify(this.state) !== JSON.stringify(transaction.next)
      )
        throw new Error('World pending transaction has a different checkpoint revision');
      validateSelectedDeparturePin(this.state, transaction.next);
      validateOperationDemoTransition(this.state, transaction.next, transaction.archive.demoCycles?.[0]?.cycle.id);
      validateOperationOrdinaryTransition(
        this.state,
        transaction.next,
        transaction.archive.ordinaryFlights?.[0]?.reservationId,
      );
      validateSelectedDeparture(transaction.next);
      validateOperationDemoCycles(transaction.next);
      validateOperationOrdinarySources(transaction.next);
      if (transaction.next.monitoring !== undefined)
        validateOperationMonitoringRuntimeState(transaction.next.monitoring, transaction.next.world);
      await writeOperationBatch(this.historyDirectory, transaction.next.historyBatches, transaction.archive);
      await save(this.path, transaction.next);
      this.state = transaction.next;
      await unlink(`${this.path}.pending`);
      await syncDirectory(this.path);
      await retireOperationBatches(this.historyDirectory, transaction.next.historyBatches);
    }
    if (this.state.historyBatches) {
      const tail = await readOperationBatch<OperationHistoryBatch>(this.historyDirectory, this.state.historyBatches);
      if (!tail || tail.runId !== this.state.world.config.runId || tail.revision > this.state.revision)
        throw new Error('World history tail is missing or belongs to a different checkpoint');
    }
    this.recovered = true;
  }
  update(change: (state: OperationCheckpoint) => void): Promise<void> {
    return this.commit(change, []);
  }
  accept(prepared: PreparedWorldFact, receiptId: string): Promise<void> {
    const { sequence, attemptId } = prepared.fact;
    return this.commit(
      (state) => {
        const queue = state.pending[attemptId];
        if (!queue) throw new Error('World receipt does not match its pending delivery head');
        const index = queue.findIndex((entry) => entry.fact.sequence === sequence);
        const preceding = queue.slice(0, index);
        const commandLink = commandLinkDeliveryPending(prepared.fact);
        const mission = missionDeliveryPending(prepared.fact);
        const departureChannel = departureDeliveryChannel(state.world, prepared.fact);
        if (
          index < 0 ||
          JSON.stringify(queue[index]) !== JSON.stringify(prepared) ||
          (commandLink
            ? preceding.some((entry) => commandLinkDeliveryPending(entry.fact))
            : mission
              ? preceding.some((entry) => missionDeliveryPending(entry.fact))
              : departureChannel
                ? preceding.some((entry) => departureDeliveryChannel(state.world, entry.fact) === departureChannel)
                : (prepared.fact.kind === 'position' &&
                    preceding.some((entry) => ordinaryDeliveryPending(entry.fact))) ||
                  preceding.some(
                    (entry) => ordinaryDeliveryPending(entry.fact) && !interruptionFrame(state.world, entry.fact),
                  ))
        )
          throw new Error('World receipt does not match its pending delivery head');
        recordOrdinaryIncidentReceipt(state.world, prepared.fact, receiptId);
        queue.splice(index, 1);
        if (!queue.length) delete state.pending[attemptId];
        state.accepted++;
      },
      [{ sequence, attemptId, receiptId }],
    );
  }
  archiveDemoCycle(id: string): Promise<void> {
    return this.commit(
      (state) => {
        const cycle = state.demoCycles?.[id];
        if (!cycle?.terminalConfirmed || cycle.pendingProgress)
          throw new Error('Demo archival needs confirmed terminal public progress');
        const attemptId = cycle.flight?.attemptId;
        if (
          attemptId &&
          (state.pending[attemptId]?.length ||
            state.world.attempts.some((attempt) => attempt.id === attemptId && attempt.phase === 'flying'))
        )
          throw new Error('Demo archival must wait for physical landing and source delivery');
        state.world.demoFlights = state.world.demoFlights?.filter((flight) => flight.cycleId !== id);
        state.world.reservations = state.world.reservations?.filter((row) => row.id !== attemptId);
        state.world.departureAllocations = state.world.departureAllocations?.filter(
          (row) => row.reservationId !== attemptId,
        );
        state.world.departures = state.world.departures?.filter((row) => row.reservationId !== attemptId);
        if (attemptId && state.demoDepartureJobs) delete state.demoDepartureJobs[attemptId];
        if (cycle.references.execution && state.departureRequests)
          delete state.departureRequests[cycle.references.execution.flightId];
        delete state.demoCycles![id];
      },
      [],
      id,
    );
  }
  archiveOrdinaryFlight(id: string): Promise<void> {
    return this.commit(
      (state) => {
        const flight = state.ordinaryFlights?.[id];
        if (!flight?.terminalConfirmed || flight.pendingProgress || state.pending[id]?.length)
          throw new Error('Ordinary archival requires confirmed terminal progress and drained source originals');
        retireOperationOrdinaryFlight(state.world, id);
        state.world.reservations = state.world.reservations?.filter((row) => row.id !== id);
        state.world.departureAllocations = state.world.departureAllocations?.filter((row) => row.reservationId !== id);
        state.world.departures = state.world.departures?.filter((row) => row.reservationId !== id);
        if (state.ordinaryDepartureJobs) delete state.ordinaryDepartureJobs[id];
        if (flight.flightId && state.departureRequests) delete state.departureRequests[flight.flightId];
        delete state.ordinaryFlights![id];
      },
      [],
      undefined,
      id,
    );
  }
  private commit(
    change: (state: OperationCheckpoint) => void,
    receipts: OperationReceipt[],
    retiredCycleId?: string,
    retiredOrdinaryId?: string,
  ): Promise<void> {
    const pending = this.serial.then(async () => {
      await this.recover();
      const next = structuredClone(this.state);
      const retired = retiredCycleId ? structuredClone(this.state.demoCycles?.[retiredCycleId]) : undefined;
      const retiredRecovery = retired?.flight
        ? {
            departureJob: this.state.demoDepartureJobs?.[retired.flight.attemptId],
            preparation: retired.references.execution
              ? this.state.departureRequests?.[retired.references.execution.flightId]
              : undefined,
            allocation: this.state.world.departureAllocations?.find(
              (row) => row.reservationId === retired.flight!.attemptId,
            ),
            commit: this.state.world.departures?.find((row) => row.reservationId === retired.flight!.attemptId),
            flight: retired.flight,
            reservation: this.state.world.reservations?.find((row) => row.id === retired.flight!.attemptId),
          }
        : undefined;
      const retiredOrdinary = retiredOrdinaryId
        ? structuredClone(this.state.ordinaryFlights?.[retiredOrdinaryId])
        : undefined;
      const ordinaryRecovery = retiredOrdinary
        ? {
            departureJob: this.state.ordinaryDepartureJobs?.[retiredOrdinary.reservationId],
            preparation: retiredOrdinary.flightId
              ? this.state.departureRequests?.[retiredOrdinary.flightId]
              : undefined,
            allocation: this.state.world.departureAllocations?.find(
              (row) => row.reservationId === retiredOrdinary.reservationId,
            ),
            commit: this.state.world.departures?.find((row) => row.reservationId === retiredOrdinary.reservationId),
            reservation: this.state.world.reservations?.find((row) => row.id === retiredOrdinary.reservationId),
            registration: this.state.world.ordinaryDispatch?.flights.find(
              (row) => row.attemptId === retiredOrdinary.reservationId,
            ),
          }
        : undefined;
      for (const id of this.resumeDemoCycles) {
        const observer = next.demoCycles?.[id]?.monitoring?.observer;
        if (!observer || observer.completedAt || observer.failure) continue;
        setOperationMonitoringAvailability(observer, next.world, observer.flights[0]!.attemptId, {
          monitoringAvailable: false,
          telemetryDeliveryAvailable: false,
        });
      }
      change(next);
      validateSelectedDeparturePin(this.state, next);
      validateOperationDemoTransition(this.state, next, retiredCycleId);
      validateOperationOrdinaryTransition(this.state, next, retiredOrdinaryId);
      validateSelectedDeparture(next);
      validateOperationDemoCycles(next);
      validateOperationOrdinarySources(next);
      observeMonitoring(next);
      const resumed: string[] = [];
      for (const id of this.resumeDemoCycles) {
        const observer = next.demoCycles?.[id]?.monitoring?.observer;
        if (!observer || observer.completedAt || observer.failure) {
          resumed.push(id);
          continue;
        }
        if (next.world.now < this.resumeDemoAt) continue;
        setOperationMonitoringAvailability(observer, next.world, observer.flights[0]!.attemptId, {
          monitoringAvailable: observer.plan.flights[0]!.monitoringAvailable,
          telemetryDeliveryAvailable: true,
        });
        resumed.push(id);
      }
      if (resumed.length) observeMonitoring(next);
      next.revision++;
      const archived = compactOperation(next.world, next.departureJob?.reservationId);
      const migration = next.migration;
      delete next.migration;
      const facts = archived.facts.map((fact) => migration?.prepared[fact.sequence] ?? prepareWorldFact(fact));
      const retainedReceipts = new Map(Object.entries(migration?.receipts ?? {}));
      const archivedReceipts = [...receipts];
      for (const prepared of facts) {
        const previousReceipt =
          retainedReceipts.get(String(prepared.fact.sequence)) ??
          (prepared.fact.kind === 'mission' ? prepared.fact.publicAcceptance?.receiptId : undefined);
        if (previousReceipt) {
          archivedReceipts.push({
            sequence: prepared.fact.sequence,
            attemptId: prepared.fact.attemptId,
            receiptId: previousReceipt,
          });
          if (
            prepared.fact.kind === 'mission' &&
            prepared.fact.publicAcceptance &&
            !retainedReceipts.has(String(prepared.fact.sequence))
          )
            next.accepted++;
        } else if (next.clock.mode === 'live') (next.pending[prepared.fact.attemptId] ??= []).push(prepared);
        retainedReceipts.delete(String(prepared.fact.sequence));
      }
      if (retainedReceipts.size) throw new Error('Legacy world receipts have no retained original facts');
      if (next.clock.mode === 'manual') next.pending = {};
      const archive: OperationHistoryBatch = {
        runId: next.world.config.runId,
        revision: next.revision,
        facts,
        demand: archived.demand,
        attempts: archived.attempts,
        receipts: archivedReceipts,
        ...(retired ? { demoCycles: [{ ...retired, archivedRecovery: retiredRecovery }] } : {}),
        ...(retiredOrdinary ? { ordinaryFlights: [{ ...retiredOrdinary, archivedRecovery: ordinaryRecovery }] } : {}),
      };
      if (
        facts.length ||
        archive.demand.length ||
        archive.attempts.length ||
        archivedReceipts.length ||
        archive.demoCycles?.length ||
        archive.ordinaryFlights?.length
      ) {
        next.historyBatches++;
        const transaction: PendingTransaction = { baseRevision: this.state.revision, next, archive };
        await save(`${this.path}.pending`, transaction);
        await writeOperationBatch(this.historyDirectory, next.historyBatches, archive);
        await save(this.path, next);
        this.state = next;
        await unlink(`${this.path}.pending`);
        await syncDirectory(this.path);
        await retireOperationBatches(this.historyDirectory, next.historyBatches);
      } else {
        await save(this.path, next);
        this.state = next;
      }
      for (const id of resumed) this.resumeDemoCycles.delete(id);
    });
    this.serial = pending.catch(() => {
      this.recovered = false;
    });
    return pending;
  }
}

export async function lockOperation(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const identity = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try {
    const file = await open(lockPath, 'wx', 0o600);
    try {
      await file.writeFile(identity);
    } finally {
      await file.close();
    }
    return async () => {
      if ((await readFile(lockPath, 'utf8')) === identity) await unlink(lockPath);
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('World lock is invalid');
    try {
      process.kill(previous.pid, 0);
    } catch (processError) {
      if ((processError as NodeJS.ErrnoException).code === 'ESRCH')
        throw new Error(`World scheduler exited; remove only its abandoned lock ${lockPath} before resuming`);
      throw processError;
    }
    throw new Error('This world already has a running scheduler');
  }
}
