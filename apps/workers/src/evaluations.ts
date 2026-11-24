import { randomUUID } from 'node:crypto';
import { queueAdoptedRuleEvaluations } from '@ledger/domain';
import { DomainError, isDatabaseUnavailable, withScope, type Pool, type PoolClient } from '@ledger/persistence';

interface EvaluationDeadlineRow {
  id: string;
  tenant_id: string;
  flight_id: string;
  trigger_event_id: string;
  leaf_id: string;
  binding_id: string;
  due_at: Date;
  clock_mode: 'wall';
  state: 'pending' | 'leased' | 'completed' | 'failed';
  generation: string;
  lease_owner: string | null;
  lease_until: Date | null;
  attempts: number;
  error: string | null;
  available_at: Date;
  completed_at: Date | null;
}

export interface EvaluationLease extends EvaluationDeadlineRow {
  state: 'leased';
  lease_owner: string;
  lease_until: Date;
  worker_id: string;
}

export interface EvaluationLeaseOptions {
  owner?: string;
  limit?: number;
  leaseSeconds?: number;
}

interface EvaluationProcessingOptions {
  beforeCommit?: () => Promise<void>;
}

export async function leaseEvaluations(pool: Pool, options: EvaluationLeaseOptions = {}): Promise<EvaluationLease[]> {
  // Retained evaluation work names a rule; any rule is leased, and the adoptions in effect decide what runs.
  const result = await pool.query<EvaluationLease>('SELECT * FROM ledger_lease_evaluations($1,$2,$3,NULL)', [
    options.owner ?? randomUUID(),
    options.limit ?? 20,
    options.leaseSeconds ?? 30,
  ]);
  return result.rows;
}

function matchesLease(current: EvaluationDeadlineRow | undefined, lease: EvaluationLease): boolean {
  return (
    current !== undefined &&
    current.state === 'leased' &&
    current.tenant_id === lease.tenant_id &&
    current.flight_id === lease.flight_id &&
    current.trigger_event_id === lease.trigger_event_id &&
    current.leaf_id === lease.leaf_id &&
    current.binding_id === lease.binding_id &&
    current.clock_mode === lease.clock_mode &&
    String(current.generation) === String(lease.generation) &&
    current.lease_owner === lease.lease_owner
  );
}

async function lockDeadline(client: PoolClient, lease: EvaluationLease): Promise<EvaluationDeadlineRow | undefined> {
  const flight = await client.query<{ id: string }>('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [
    lease.flight_id,
  ]);
  if (!flight.rowCount) return undefined;
  const deadline = await client.query<EvaluationDeadlineRow>(
    'SELECT * FROM evaluation_deadlines WHERE id=$1 FOR UPDATE',
    [lease.id],
  );
  return deadline.rows[0];
}

export async function processEvaluationLease(
  pool: Pool,
  lease: EvaluationLease,
  options: EvaluationProcessingOptions = {},
): Promise<boolean> {
  return withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client, principal) => {
    const current = await lockDeadline(client, lease);
    if (!matchesLease(current, lease)) return false;
    const validity = await client.query<{ lease_valid: boolean }>(
      'SELECT lease_until>clock_timestamp() AS lease_valid FROM evaluation_deadlines WHERE id=$1',
      [lease.id],
    );
    if (!validity.rows[0]?.lease_valid) return false;

    // The generic evaluator runs the named rule wherever an adoption in effect holds it; otherwise nothing runs.
    await queueAdoptedRuleEvaluations(
      client,
      principal.tenantId,
      { scope: 'ledger', kind: 'flight', id: lease.flight_id },
      { kind: 'observation', eventId: lease.trigger_event_id },
      lease.leaf_id,
    );
    if (options.beforeCommit) await options.beforeCommit();
    const completed = await client.query(
      "UPDATE evaluation_deadlines SET state='completed',completed_at=clock_timestamp(),lease_until=NULL,error=NULL WHERE id=$1 AND generation=$2 AND lease_owner=$3 AND state='leased' AND lease_until>clock_timestamp()",
      [lease.id, lease.generation, lease.lease_owner],
    );
    if (completed.rowCount !== 1)
      throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease before commit');
    return true;
  });
}

async function retryEvaluation(pool: Pool, lease: EvaluationLease, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    const current = await lockDeadline(client, lease);
    if (!matchesLease(current, lease)) return;
    await client.query(
      `UPDATE evaluation_deadlines SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,error=$1,
       available_at=clock_timestamp()+make_interval(secs=>LEAST(attempts,10)),lease_until=NULL
       WHERE id=$2 AND generation=$3 AND lease_owner=$4 AND state='leased'`,
      [message.slice(0, 500), lease.id, lease.generation, lease.lease_owner],
    );
  });
}

export async function runDueEvaluations(pool: Pool, options: EvaluationLeaseOptions = {}): Promise<number> {
  const leases = await leaseEvaluations(pool, options);
  let completed = 0;
  for (const lease of leases) {
    try {
      if (await processEvaluationLease(pool, lease)) completed++;
    } catch (error) {
      // A lost connection is not recorded as the work's error: the worker waits for the database, and the work is
      // leased again once its lease runs out.
      if (isDatabaseUnavailable(error)) throw error;
      await retryEvaluation(pool, lease, error);
    }
  }
  return completed;
}
