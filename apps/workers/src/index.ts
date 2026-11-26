import { randomUUID } from 'node:crypto';
import {
  appendLiveChange,
  DomainError,
  withScope,
  type JournalEvent,
  type ObjectStore,
  type Pool,
} from '@ledger/persistence';
import { projectEvent, PROJECTOR_VERSION } from '@ledger/projections';
import { runDueEvaluations } from './evaluations.js';
import { runDueRuleEvaluations } from './rule-evaluations.js';
import { runDueRuleSelections } from './rule-selections.js';
import { runDueNotices, type NoticeWorkerOptions } from './notices.js';
import { runDueProgramReads, type ProgramReadOptions } from './program-reads.js';
import { runLeases, type WorkObserver } from './work-metrics.js';
export { startWorkers, type WorkerRuntime, type WorkerRuntimeOptions } from './runtime.js';
export {
  WORK_QUEUES,
  registerQueueDepth,
  runLeases,
  workerMetrics,
  type WorkObserver,
  type WorkQueue,
} from './work-metrics.js';
export {
  leaseEvaluations,
  processEvaluationLease,
  runDueEvaluations,
  type EvaluationLease,
  type EvaluationLeaseOptions,
} from './evaluations.js';
export {
  leaseRuleEvaluations,
  processRuleEvaluationLease,
  runDueRuleEvaluations,
  type RuleEvaluationLease,
  type RuleEvaluationLeaseOptions,
} from './rule-evaluations.js';
export {
  failureReason,
  leaseNotices,
  leaseNoticeSchedules,
  processNoticeSchedule,
  runDueNotices,
  sendLeasedNotice,
  NOTICE_RETRY_DELAYS,
  type NoticeLease,
  type NoticeTransport,
  type NoticeWorkerOptions,
  type OutgoingCall,
  type OutgoingEmail,
  type ScheduleLease,
} from './notices.js';
export {
  callProgramOperator,
  leaseProgramReads,
  programCallFailure,
  readLeasedProgramOperator,
  runDueProgramReads,
  PROGRAM_READ_INTERVAL_SECONDS,
  PROGRAM_READ_MAX_BYTES,
  PROGRAM_READ_TIMEOUT_MS,
  type ProgramCall,
  type ProgramReadLease,
  type ProgramReadOptions,
} from './program-reads.js';
export {
  leaseRuleSelections,
  processRuleSelectionLease,
  runDueRuleSelections,
  type RuleSelectionLease,
  type RuleSelectionLeaseOptions,
} from './rule-selections.js';

export interface WorkLease {
  id: string;
  tenant_id: string;
  event_id: string;
  stream_id: string;
  stream_sequence: string;
  generation: string;
  worker_id: string;
  lease_owner: string;
}
export interface WorkCompletionTrace {
  event: 'projection.completed';
  tenantId: string;
  principalId: string;
  taskId: string;
  eventId: string;
  streamId: string;
  streamSequence: string;
  leaseGeneration: string;
  projectorVersion: string;
  projectionRevision: number;
  viewChangeIds: string[];
  flightIds: string[];
}
interface WorkerOptions {
  observer?: WorkObserver;
  beforeCommit?: () => Promise<void>;
  trace?: (entry: WorkCompletionTrace) => void;
  objectStore?: ObjectStore;
}
export async function leaseWork(
  pool: Pool,
  options: { owner?: string; limit?: number; leaseSeconds?: number } = {},
): Promise<WorkLease[]> {
  return (
    await pool.query('SELECT * FROM ledger_lease_work($1,$2,$3)', [
      options.owner ?? randomUUID(),
      options.limit ?? 20,
      options.leaseSeconds ?? 30,
    ])
  ).rows;
}
export async function processLease(pool: Pool, lease: WorkLease, options: WorkerOptions = {}): Promise<boolean> {
  const result = await withScope(
    pool,
    { id: lease.worker_id, tenantId: lease.tenant_id },
    async (client, principal) => {
      const current = (await client.query('SELECT * FROM work_items WHERE id=$1 FOR UPDATE', [lease.id])).rows[0];
      if (
        !current ||
        current.state !== 'leased' ||
        String(current.generation) !== String(lease.generation) ||
        current.lease_owner !== lease.lease_owner ||
        current.event_id !== lease.event_id ||
        current.stream_id !== lease.stream_id ||
        String(current.stream_sequence) !== String(lease.stream_sequence)
      )
        return false;
      if (new Date(current.lease_until).getTime() < Date.now()) return false;
      options.observer?.waited('projection', new Date(current.available_at));
      const event = (await client.query('SELECT * FROM journal_events WHERE id=$1', [lease.event_id]))
        .rows[0] as JournalEvent;
      await projectEvent(client, principal, event, { objectStore: options.objectStore });
      if (options.beforeCommit) await options.beforeCommit();
      const completed = await client.query(
        "UPDATE work_items SET state='completed',completed_at=clock_timestamp(),lease_until=NULL,error=NULL WHERE id=$1 AND generation=$2 AND state='leased' AND lease_until>clock_timestamp()",
        [lease.id, lease.generation],
      );
      if (completed.rowCount !== 1)
        throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease before commit');
      const changes = await client.query('SELECT id,flight_id FROM view_changes WHERE event_id=$1 ORDER BY id', [
        event.id,
      ]);
      const visible = await client.query('SELECT DISTINCT flight_id FROM timeline_items WHERE id=$1', [event.id]);
      const trace: WorkCompletionTrace = {
        event: 'projection.completed',
        tenantId: principal.tenantId,
        principalId: principal.id,
        taskId: current.id,
        eventId: event.id,
        streamId: event.stream_id,
        streamSequence: String(event.stream_sequence),
        leaseGeneration: String(current.generation),
        projectorVersion: PROJECTOR_VERSION,
        projectionRevision: Math.max(0, ...changes.rows.map((row) => Number(row.id))),
        viewChangeIds: changes.rows.map((row) => String(row.id)),
        flightIds: [
          ...new Set<string>(
            [...changes.rows, ...visible.rows]
              .map((row) => row.flight_id)
              .filter((id): id is string => typeof id === 'string'),
          ),
        ],
      };
      return trace;
    },
  );
  if (!result) return false;
  try {
    options.trace?.(result);
  } catch {}
  return true;
}
/** Records a failed projection for another attempt, and gives up on it after five. */
async function retryProjection(pool: Pool, lease: WorkLease, error: any): Promise<void> {
  await withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    const current = (await client.query('SELECT * FROM work_items WHERE id=$1 FOR UPDATE', [lease.id])).rows[0];
    if (!current || current.state !== 'leased' || String(current.generation) !== String(lease.generation)) return;
    await client.query(
      "UPDATE work_items SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,error=$1,available_at=clock_timestamp()+make_interval(secs=>LEAST(attempts,10)),lease_until=NULL WHERE id=$2 AND generation=$3 AND state='leased'",
      [String(error.message ?? error).slice(0, 500), lease.id, lease.generation],
    );
    const receipt = (await client.query('SELECT id,flight_id,kind FROM receipts WHERE event_id=$1', [lease.event_id]))
      .rows[0];
    if (receipt?.flight_id)
      await appendLiveChange(
        client,
        lease.tenant_id,
        receipt.flight_id,
        lease.event_id,
        receipt.kind === 'telemetry.segment' ? 'telemetry.updated' : 'flight.updated',
        receipt.id,
      );
    if (current.attempts >= 5) {
      await client.query(
        'INSERT INTO projection_offsets(tenant_id,stream_id,sequence) VALUES($1,$2,$3) ON CONFLICT(tenant_id,stream_id) DO UPDATE SET sequence=EXCLUDED.sequence WHERE projection_offsets.sequence=EXCLUDED.sequence-1',
        [lease.tenant_id, lease.stream_id, lease.stream_sequence],
      );
      await client.query('INSERT INTO view_changes(tenant_id,event_id) VALUES($1,$2)', [
        lease.tenant_id,
        lease.event_id,
      ]);
    }
  });
}
export async function runOnce(
  pool: Pool,
  options: WorkerOptions & {
    owner?: string;
    limit?: number;
    leaseSeconds?: number;
    /** Writes and sends notices too; the workers' process passes it, a test that sends none leaves it out. */
    notices?: NoticeWorkerOptions;
    /** Reads the operators program owners follow; the workers' process passes it, a test that calls out leaves it out. */
    programReads?: ProgramReadOptions;
  } = {},
): Promise<number> {
  const leases = await leaseWork(pool, options);
  let completed = await runLeases(
    'projection',
    leases,
    options.observer,
    (lease) => processLease(pool, lease, options),
    (lease, error) => retryProjection(pool, lease, error),
  );
  completed += await runDueRuleSelections(pool, options);
  completed += await runDueEvaluations(pool, options);
  completed += await runDueRuleEvaluations(pool, options);
  if (options.notices) completed += await runDueNotices(pool, { ...options.notices, observer: options.observer });
  if (options.programReads)
    completed += await runDueProgramReads(pool, { ...options.programReads, observer: options.observer });
  return completed;
}
