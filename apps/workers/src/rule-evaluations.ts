import { randomUUID } from 'node:crypto';
import {
  continueAdoptionRuleEvaluations,
  continueRelatedRuleEvaluations,
  evaluateAdoptedRule,
  refreshAcceptedControlRules,
  type RuleEvaluationTask,
} from '@ledger/domain';

type SubjectReference = RuleEvaluationTask['subject'];
import { DomainError, withScope, type Pool, type PoolClient } from '@ledger/persistence';
import { readySince, runLeases, type WorkObserver } from './work-metrics.js';

interface RuleEvaluationWorkRow {
  id: string;
  tenant_id: string;
  subject_key: string;
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
  pack_id: string;
  leaf_id: string;
  trigger_kind:
    'observation' | 'deadline' | 'state' | 'correction' | 'adoption' | 'related' | 'adoption-page' | 'control-boundary';
  trigger_event_id: string;
  due_at: Date;
  available_at: Date;
  state: 'pending' | 'leased' | 'completed' | 'failed';
  generation: string;
  lease_owner: string | null;
  lease_until: Date | null;
  attempts: number;
  error: string | null;
  completed_at: Date | null;
  continuation?: unknown;
}

export interface RuleEvaluationLease extends RuleEvaluationWorkRow {
  state: 'leased';
  lease_owner: string;
  lease_until: Date;
  worker_id: string;
}

export interface RuleEvaluationLeaseOptions {
  owner?: string;
  limit?: number;
  leaseSeconds?: number;
  observer?: WorkObserver;
}

interface RuleEvaluationProcessingOptions {
  beforeCommit?: () => Promise<void>;
}

export async function leaseRuleEvaluations(
  pool: Pool,
  options: RuleEvaluationLeaseOptions = {},
): Promise<RuleEvaluationLease[]> {
  const result = await pool.query<RuleEvaluationLease>('SELECT * FROM ledger_lease_rule_evaluations($1,$2,$3)', [
    options.owner ?? randomUUID(),
    options.limit ?? 20,
    options.leaseSeconds ?? 30,
  ]);
  return result.rows;
}

function subjectOf(lease: RuleEvaluationLease): SubjectReference {
  return lease.subject_scope === 'source'
    ? { scope: 'source', kind: lease.subject_kind, id: lease.subject_id, sourceId: lease.subject_source_id! }
    : { scope: 'ledger', kind: lease.subject_kind, id: lease.subject_id };
}

function task(lease: RuleEvaluationLease): RuleEvaluationTask {
  return {
    subject: subjectOf(lease),
    packId: lease.pack_id,
    leafId: lease.leaf_id,
    trigger:
      lease.trigger_kind === 'deadline'
        ? { kind: 'deadline', eventId: lease.trigger_event_id, dueAt: lease.due_at.toISOString() }
        : {
            kind: lease.trigger_kind as Exclude<
              RuleEvaluationLease['trigger_kind'],
              'deadline' | 'related' | 'adoption-page' | 'control-boundary'
            >,
            eventId: lease.trigger_event_id,
          },
  };
}

async function lockedWork(client: PoolClient, lease: RuleEvaluationLease): Promise<RuleEvaluationWorkRow | undefined> {
  return (
    await client.query<RuleEvaluationWorkRow>('SELECT * FROM rule_evaluation_work WHERE id=$1 FOR UPDATE', [lease.id])
  ).rows[0];
}

function holdsLease(current: RuleEvaluationWorkRow | undefined, lease: RuleEvaluationLease): boolean {
  return (
    current !== undefined &&
    current.state === 'leased' &&
    current.tenant_id === lease.tenant_id &&
    current.subject_key === lease.subject_key &&
    current.pack_id === lease.pack_id &&
    current.leaf_id === lease.leaf_id &&
    String(current.generation) === String(lease.generation) &&
    current.lease_owner === lease.lease_owner
  );
}

/** Evaluates one leased rule for one subject. Effects commit only while this worker still holds the lease. */
export async function processRuleEvaluationLease(
  pool: Pool,
  lease: RuleEvaluationLease,
  options: RuleEvaluationProcessingOptions = {},
): Promise<boolean> {
  return withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client, principal) => {
    const current = await lockedWork(client, lease);
    if (!holdsLease(current, lease)) return false;
    const validity = await client.query<{ lease_valid: boolean }>(
      'SELECT lease_until>clock_timestamp() AS lease_valid FROM rule_evaluation_work WHERE id=$1',
      [lease.id],
    );
    if (!validity.rows[0]?.lease_valid) return false;
    // A 'related' row evaluates nothing itself: it queues the next page of subjects that name its subject.
    if (lease.trigger_kind === 'related')
      await continueRelatedRuleEvaluations(client, principal, {
        subject: subjectOf(lease),
        packId: lease.pack_id,
        leafId: lease.leaf_id,
        eventId: lease.trigger_event_id,
        continuation: current!.continuation,
      });
    // An 'adoption-page' row queues the next page of subjects already on record for an adoption's rule.
    else if (lease.trigger_kind === 'adoption-page')
      await continueAdoptionRuleEvaluations(client, principal, {
        packId: lease.pack_id,
        leafId: lease.leaf_id,
        eventId: lease.trigger_event_id,
        continuation: current!.continuation,
      });
    // A 'control-boundary' row reassembles the accepted-controls pack where a control's interval starts or ends.
    else if (lease.trigger_kind === 'control-boundary')
      await refreshAcceptedControlRules(
        client,
        { ...principal, kind: principal.kind ?? 'worker' },
        { boundaryAt: lease.due_at.toISOString(), scheduledBy: lease.trigger_event_id },
      );
    else await evaluateAdoptedRule(client, principal, task(lease));
    if (options.beforeCommit) await options.beforeCommit();
    const completed = await client.query(
      `UPDATE rule_evaluation_work SET state='completed',completed_at=clock_timestamp(),lease_until=NULL,error=NULL
       WHERE id=$1 AND generation=$2 AND lease_owner=$3 AND state='leased' AND lease_until>clock_timestamp()`,
      [lease.id, lease.generation, lease.lease_owner],
    );
    if (completed.rowCount !== 1)
      throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease before commit');
    return true;
  });
}

async function retryRuleEvaluation(pool: Pool, lease: RuleEvaluationLease, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    if (!holdsLease(await lockedWork(client, lease), lease)) return;
    await client.query(
      `UPDATE rule_evaluation_work SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,error=$1,
       available_at=clock_timestamp()+make_interval(secs=>LEAST(attempts,10)),lease_until=NULL
       WHERE id=$2 AND generation=$3 AND lease_owner=$4 AND state='leased'`,
      [message.slice(0, 500), lease.id, lease.generation, lease.lease_owner],
    );
  });
}

/** The generic evaluation worker: leases due rule evaluations, from accepted observations and deadlines, and runs them. */
export async function runDueRuleEvaluations(pool: Pool, options: RuleEvaluationLeaseOptions = {}): Promise<number> {
  const leases = await leaseRuleEvaluations(pool, options);
  return runLeases(
    'rule_evaluation',
    leases,
    options.observer,
    (lease) => processRuleEvaluationLease(pool, lease),
    (lease, error) => retryRuleEvaluation(pool, lease, error),
    readySince,
  );
}
