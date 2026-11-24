import { randomUUID } from 'node:crypto';
import { refreshFlightRuleSelection } from '@ledger/domain';
import { DomainError, isDatabaseUnavailable, withScope, type Pool, type PoolClient } from '@ledger/persistence';

interface RuleSelectionWorkRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  kind: 'bootstrap' | 'adoption' | 'refresh' | 'start' | 'end' | 'execution_bootstrap' | 'execution';
  flight_id: string | null;
  adoption_id: string | null;
  phase: 'accepted' | 'projected' | null;
  cursor_flight_id: string | null;
  due_at: Date;
  available_at: Date;
  state: 'pending' | 'leased' | 'completed' | 'failed';
  generation: string;
  lease_owner: string | null;
  lease_until: Date | null;
  attempts: number;
  error: string | null;
  completed_at: Date | null;
}

export interface RuleSelectionLease extends RuleSelectionWorkRow {
  state: 'leased';
  lease_owner: string;
  lease_until: Date;
  worker_id: string;
}

export interface RuleSelectionLeaseOptions {
  owner?: string;
  limit?: number;
  leaseSeconds?: number;
}

interface RuleSelectionProcessingOptions {
  beforeCommit?: () => Promise<void>;
  fanoutLimit?: number;
}

interface AdoptionBoundaryRow {
  effective_start: Date;
  effective_end: Date;
  record: { pack: { leaves: { check?: unknown; target?: { subjectKind: string } }[] } };
}

export async function leaseRuleSelections(
  pool: Pool,
  options: RuleSelectionLeaseOptions = {},
): Promise<RuleSelectionLease[]> {
  const result = await pool.query<RuleSelectionLease>(
    'SELECT * FROM ledger_lease_rule_selections($1,$2,$3,$4::text[])',
    [
      options.owner ?? randomUUID(),
      options.limit ?? 20,
      options.leaseSeconds ?? 30,
      ['bootstrap', 'adoption', 'refresh', 'start', 'end', 'execution_bootstrap', 'execution'],
    ],
  );
  return result.rows;
}

function matchesLease(current: RuleSelectionWorkRow | undefined, lease: RuleSelectionLease): boolean {
  return (
    current !== undefined &&
    current.state === 'leased' &&
    current.tenant_id === lease.tenant_id &&
    current.organization_id === lease.organization_id &&
    current.kind === lease.kind &&
    current.flight_id === lease.flight_id &&
    current.adoption_id === lease.adoption_id &&
    current.phase === lease.phase &&
    current.cursor_flight_id === lease.cursor_flight_id &&
    String(current.generation) === String(lease.generation) &&
    current.lease_owner === lease.lease_owner
  );
}

async function lockWork(client: PoolClient, lease: RuleSelectionLease): Promise<RuleSelectionWorkRow | undefined> {
  if (lease.flight_id) {
    const flight = await client.query<{ id: string }>(
      'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [lease.tenant_id, lease.flight_id],
    );
    if (!flight.rowCount) return undefined;
  }
  const work = await client.query<RuleSelectionWorkRow>(
    'SELECT * FROM selection_work WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [lease.tenant_id, lease.id],
  );
  return work.rows[0];
}

async function insertRefreshes(
  client: PoolClient,
  lease: RuleSelectionLease,
  flightIds: string[],
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO selection_work(id,tenant_id,organization_id,kind,flight_id,adoption_id,phase,due_at,available_at)
     SELECT child.id,$3,$4,$8,child.flight_id,$5,$6,$7,$7
     FROM unnest($1::text[],$2::text[]) AS child(id,flight_id) ON CONFLICT DO NOTHING`,
    [
      flightIds.map(() => randomUUID()),
      flightIds,
      lease.tenant_id,
      lease.organization_id,
      lease.adoption_id,
      lease.phase,
      now,
      lease.kind === 'execution_bootstrap' ? 'execution' : 'refresh',
    ],
  );
}

async function insertBoundaries(
  client: PoolClient,
  lease: RuleSelectionLease,
  flightIds: string[],
  now: Date,
): Promise<void> {
  if (!lease.adoption_id) return;
  const adoption = (
    await client.query<AdoptionBoundaryRow>(
      'SELECT effective_start,effective_end,record FROM organization_pack_adoptions WHERE tenant_id=$1 AND organization_id=$2 AND id=$3',
      [lease.tenant_id, lease.organization_id, lease.adoption_id],
    )
  ).rows[0];
  if (!adoption)
    throw new DomainError(409, 'selection_adoption_missing', 'Rule selection work has no retained adoption');
  // Only a pack with checked rules about flights changes a flight's selection.
  if (!adoption.record.pack.leaves.some((leaf) => leaf.check && leaf.target?.subjectKind === 'flight')) return;
  const boundaries = [
    { kind: 'start', at: adoption.effective_start },
    { kind: 'end', at: adoption.effective_end },
  ] as const;
  for (const boundary of boundaries) {
    if (boundary.at.getTime() <= now.getTime()) continue;
    await client.query(
      `INSERT INTO selection_work(id,tenant_id,organization_id,kind,flight_id,adoption_id,due_at,available_at)
       SELECT child.id,$3,$4,$5,child.flight_id,$6,$7,$7
       FROM unnest($1::text[],$2::text[]) AS child(id,flight_id) ON CONFLICT DO NOTHING`,
      [
        flightIds.map(() => randomUUID()),
        flightIds,
        lease.tenant_id,
        lease.organization_id,
        boundary.kind,
        lease.adoption_id,
        boundary.at,
      ],
    );
  }
}

async function fanout(
  client: PoolClient,
  lease: RuleSelectionLease,
  limit: number,
): Promise<{ cursor: string | null; more: boolean }> {
  const page = await client.query<{ id: string }>(
    `SELECT id FROM flight_views WHERE tenant_id=$1
     AND ($2::text IS NULL OR id>$2::text)
     ORDER BY id LIMIT $3`,
    [lease.tenant_id, lease.cursor_flight_id, limit + 1],
  );
  const flightIds = page.rows.slice(0, limit).map((row) => row.id);
  if (flightIds.length) {
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    await insertRefreshes(client, lease, flightIds, now);
    await insertBoundaries(client, lease, flightIds, now);
  }
  return { cursor: flightIds.at(-1) ?? lease.cursor_flight_id, more: page.rows.length > limit };
}

export async function processRuleSelectionLease(
  pool: Pool,
  lease: RuleSelectionLease,
  options: RuleSelectionProcessingOptions = {},
): Promise<boolean> {
  const fanoutLimit = options.fanoutLimit ?? 100;
  if (!Number.isSafeInteger(fanoutLimit) || fanoutLimit < 1 || fanoutLimit > 100)
    throw new Error('Rule selection fanout limit must be an integer from 1 to 100');
  return withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client, principal) => {
    const current = await lockWork(client, lease);
    if (!matchesLease(current, lease)) return false;
    const validity = await client.query<{ lease_valid: boolean }>(
      'SELECT lease_until>clock_timestamp() AS lease_valid FROM selection_work WHERE tenant_id=$1 AND id=$2',
      [lease.tenant_id, lease.id],
    );
    if (!validity.rows[0]?.lease_valid) return false;
    let progress = { cursor: lease.cursor_flight_id, more: false };
    if (lease.flight_id) {
      // The generic evaluator queues the selected rules itself, from the observations and state they read.
      await refreshFlightRuleSelection(client, principal, lease.flight_id);
    } else progress = await fanout(client, lease, fanoutLimit);
    if (options.beforeCommit) await options.beforeCommit();
    const completed = await client.query(
      `UPDATE selection_work SET state=$1,cursor_flight_id=$2,
       attempts=CASE WHEN $1='pending' THEN 0 ELSE attempts END,error=NULL,
       available_at=CASE WHEN $1='pending' THEN clock_timestamp() ELSE available_at END,
       completed_at=CASE WHEN $1='completed' THEN clock_timestamp() ELSE NULL END,lease_owner=NULL,lease_until=NULL
       WHERE tenant_id=$3 AND id=$4 AND generation=$5 AND lease_owner=$6 AND state='leased' AND lease_until>clock_timestamp()`,
      [
        progress.more ? 'pending' : 'completed',
        progress.cursor,
        lease.tenant_id,
        lease.id,
        lease.generation,
        lease.lease_owner,
      ],
    );
    if (completed.rowCount !== 1)
      throw new DomainError(409, 'worker_lease_expired', 'Worker lost its rule selection lease before commit');
    return true;
  });
}

async function retryRuleSelection(pool: Pool, lease: RuleSelectionLease, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    const current = await lockWork(client, lease);
    if (!matchesLease(current, lease)) return;
    await client.query(
      `UPDATE selection_work SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,error=$1,
       available_at=clock_timestamp()+make_interval(secs=>LEAST(attempts,10)),lease_owner=NULL,lease_until=NULL
       WHERE tenant_id=$2 AND id=$3 AND generation=$4 AND lease_owner=$5 AND state='leased'`,
      [message.slice(0, 500), lease.tenant_id, lease.id, lease.generation, lease.lease_owner],
    );
  });
}

export async function runDueRuleSelections(pool: Pool, options: RuleSelectionLeaseOptions = {}): Promise<number> {
  const leases = await leaseRuleSelections(pool, options);
  let completed = 0;
  for (const lease of leases) {
    try {
      if (await processRuleSelectionLease(pool, lease)) completed++;
    } catch (error) {
      // A lost connection is not recorded as the work's error: the worker waits for the database, and the work is
      // leased again once its lease runs out.
      if (isDatabaseUnavailable(error)) throw error;
      await retryRuleSelection(pool, lease, error);
    }
  }
  return completed;
}
