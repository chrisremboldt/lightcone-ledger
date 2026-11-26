import { createHash, randomUUID } from 'node:crypto';
import { programAddressProblem, programAnswerDocument, programViewUrl } from '@ledger/domain';
import { DomainError, withScope, type Pool } from '@ledger/persistence';
import { runLeases, type WorkObserver } from './work-metrics.js';

/**
 * Reading the operators a program owner follows (docs/design/program-owner-view.md). A worker leases an operator's
 * schedule, calls the operator's Ledger outside any transaction, and keeps the answer or the failure only while it
 * still holds the lease. Every answer and every failure is a row; nothing is updated.
 */

export const PROGRAM_READ_TIMEOUT_MS = 10_000;
/** The largest answer kept, in bytes. */
export const PROGRAM_READ_MAX_BYTES = 1_048_576;
/** How often an operator is read, in seconds. */
export const PROGRAM_READ_INTERVAL_SECONDS = 3600;

export interface ProgramReadOptions {
  /** Whether an http:// address is read: only on a local Ledger. */
  httpAddresses: boolean;
  /** How the call is made; a test replaces it. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  intervalSeconds?: number;
  owner?: string;
  limit?: number;
  leaseSeconds?: number;
  observer?: WorkObserver;
}

export interface ProgramReadLease {
  tenant_id: string;
  operator_id: string;
  generation: string;
  lease_owner: string;
  worker_id: string;
}

/** What one call came to, as it is kept. */
export type ProgramCall =
  | { outcome: 'answered'; document: unknown; sha256: string; byteLength: number }
  | { outcome: 'not_in_use' | 'failed'; reason: string };

export async function leaseProgramReads(
  pool: Pool,
  options: { owner?: string; limit?: number; leaseSeconds?: number } = {},
): Promise<ProgramReadLease[]> {
  return (
    await pool.query<ProgramReadLease>('SELECT * FROM ledger_lease_program_reads($1,$2,$3)', [
      options.owner ?? randomUUID(),
      options.limit ?? 20,
      options.leaseSeconds ?? 60,
    ])
  ).rows;
}

class TooLarge extends Error {}

/** The body, read as it arrives and given up past the bound. */
async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new TooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/** A short reason a call failed, in Ledger's own words; never the answer's text. */
export function programCallFailure(error: unknown, timeoutMs: number): string {
  const failure = error as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = failure?.cause?.code ?? failure?.code;
  if (failure?.name === 'TimeoutError' || failure?.cause?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT')
    return `The operator’s Ledger did not answer within ${Math.round(timeoutMs / 1000)} seconds`;
  if (code && UNREACHABLE.has(code)) return `Could not reach the operator’s Ledger (${code})`;
  if (code?.startsWith('ERR_TLS') || code?.includes('CERT')) return 'The operator’s Ledger’s certificate was refused';
  return 'Could not read the operator’s Ledger';
}

/** Calls an operator's Ledger with the grant's secret, with a time limit, no redirect and a bound on the answer. */
export async function callProgramOperator(
  address: string,
  secret: string,
  options: Pick<ProgramReadOptions, 'httpAddresses' | 'fetch' | 'timeoutMs' | 'maxBytes'>,
): Promise<ProgramCall> {
  const problem = programAddressProblem(address, options.httpAddresses);
  if (problem) return { outcome: 'failed', reason: problem };
  const timeoutMs = options.timeoutMs ?? PROGRAM_READ_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PROGRAM_READ_MAX_BYTES;
  const limitWords = `${Math.round(maxBytes / 1024)} KiB`;
  try {
    const response = await (options.fetch ?? fetch)(programViewUrl(address), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Ledger program view' },
      body: JSON.stringify({ secret }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { outcome: 'failed', reason: 'The operator’s Ledger answered with a redirect, which is not followed' };
    }
    const bytes = await boundedBody(response, maxBytes);
    if (response.status === 404) {
      let code: unknown;
      try {
        code = JSON.parse(Buffer.from(bytes).toString('utf8'))?.error?.code;
      } catch {}
      if (code === 'program_grant_not_in_use')
        return {
          outcome: 'not_in_use',
          reason: 'The operator’s Ledger answered that this grant opens nothing: it may have expired or been revoked',
        };
    }
    if (response.status < 200 || response.status > 299)
      return { outcome: 'failed', reason: `The operator’s Ledger answered ${response.status}` };
    const document = programAnswerDocument(bytes);
    if (!document) return { outcome: 'failed', reason: 'The answer is not a program view this Ledger reads' };
    return {
      outcome: 'answered',
      document,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof TooLarge)
      return { outcome: 'failed', reason: `The answer was larger than ${limitWords}, so it was not kept` };
    return { outcome: 'failed', reason: programCallFailure(error, timeoutMs) };
  }
}

const leaseHeld = `SELECT available_at FROM program_operator_schedules WHERE tenant_id=$1 AND operator_id=$2
  AND generation=$3 AND lease_owner=$4 AND lease_until>clock_timestamp()`;

/** Reads one leased operator and keeps what came of it. Returns false when the lease was lost and nothing was kept. */
export async function readLeasedProgramOperator(
  pool: Pool,
  lease: ProgramReadLease,
  options: ProgramReadOptions,
): Promise<boolean> {
  const scope = { id: lease.worker_id, tenantId: lease.tenant_id };
  const params = [lease.tenant_id, lease.operator_id, lease.generation, lease.lease_owner];
  const operator = await withScope(pool, scope, async (client) => {
    const held = await client.query<{ available_at: Date }>(leaseHeld, params);
    if (!held.rowCount) return null;
    options.observer?.waited('program_read', held.rows[0]!.available_at);
    return (
      (
        await client.query<{ address: string; secret: string | null }>(
          'SELECT address,secret FROM program_operators WHERE tenant_id=$1 AND id=$2 AND removed_at IS NULL',
          [lease.tenant_id, lease.operator_id],
        )
      ).rows[0] ?? null
    );
  });
  if (!operator?.secret) return false;
  const call = await callProgramOperator(operator.address, operator.secret, options);
  return withScope(pool, scope, async (client) => {
    // The worker's own schedule row first; a worker that lost its lease keeps nothing.
    const held = await client.query(`${leaseHeld} FOR UPDATE`, params);
    if (!held.rowCount) return false;
    await client.query(
      `INSERT INTO program_operator_answers(id,tenant_id,operator_id,read_at,outcome,document,sha256,byte_length,reason)
       VALUES($1,$2,$3,clock_timestamp(),$4,$5,$6,$7,$8)`,
      call.outcome === 'answered'
        ? [
            randomUUID(),
            lease.tenant_id,
            lease.operator_id,
            'answered',
            call.document,
            call.sha256,
            call.byteLength,
            null,
          ]
        : [randomUUID(), lease.tenant_id, lease.operator_id, call.outcome, null, null, null, call.reason.slice(0, 300)],
    );
    const done = await client.query(
      `UPDATE program_operator_schedules SET lease_owner=NULL,lease_until=NULL,
         available_at=clock_timestamp()+make_interval(secs=>$1)
       WHERE tenant_id=$2 AND operator_id=$3 AND generation=$4 AND lease_until>clock_timestamp()`,
      [options.intervalSeconds ?? PROGRAM_READ_INTERVAL_SECONDS, lease.tenant_id, lease.operator_id, lease.generation],
    );
    if (done.rowCount !== 1) throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease before commit');
    return true;
  });
}

async function releaseRead(pool: Pool, lease: ProgramReadLease): Promise<void> {
  await withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    await client.query(
      `UPDATE program_operator_schedules SET lease_owner=NULL,lease_until=NULL,
         available_at=clock_timestamp()+interval '60 seconds'
       WHERE tenant_id=$1 AND operator_id=$2 AND generation=$3 AND lease_owner=$4`,
      [lease.tenant_id, lease.operator_id, lease.generation, lease.lease_owner],
    );
  });
}

/** One pass: the followed operators whose read is due. */
export async function runDueProgramReads(pool: Pool, options: ProgramReadOptions): Promise<number> {
  return runLeases(
    'program_read',
    await leaseProgramReads(pool, options),
    options.observer,
    (lease) => readLeasedProgramOperator(pool, lease, options),
    (lease) => releaseRead(pool, lease),
  );
}
