import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  PROGRAM_READ_LATE_SECONDS,
  PROGRAM_VIEW_PATH,
  type ProgramOperator,
  type ProgramOperatorAdd,
  type ProgramOperatorAnswer,
  type ProgramOperatorAnswers,
  type ProgramOperatorList,
  type ProgramOperatorState,
  type ProgramViewDocument,
} from '@ledger/contracts';
import { isProgramViewDocument } from '@ledger/contracts/program-view-check';
import { appendEvent, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';

/**
 * The operators a program owner follows (docs/design/program-owner-view.md): added and removed by whoever manages
 * authority, read hourly by a worker, and shown side by side from the answers kept. The secret an operator gave is
 * written here and never read back; only the workers' role reads it.
 */

const ANSWERS_SHOWN = 200;
const REMOVED_SHOWN = 50;

function requireAuthority(principal: AuthContext): void {
  if (!principal.capabilities.includes('authority:write'))
    throw new DomainError(403, 'capability_required', 'Operators are followed by a person with authority:write');
}
function requireRead(principal: AuthContext): void {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'capability_required', 'Reading the operators you follow requires evidence:read');
}

function inRange(parts: number[], base: number[], bits: number): boolean {
  let left = bits;
  for (let index = 0; index < base.length && left > 0; index++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if (((parts[index] ?? 0) & mask) !== (base[index]! & mask)) return false;
  }
  return true;
}

const PRIVATE_V4: [number[], number][] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 168], 16],
];

/** Whether an address literal is loopback, private, link-local or unspecified. */
export function privateAddressLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(bare);
  if (kind === 4) {
    const parts = bare.split('.').map(Number);
    return PRIVATE_V4.some(([base, bits]) => inRange(parts, base, bits));
  }
  if (kind === 6) {
    if (bare === '::' || bare === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    if (mapped) return privateAddressLiteral(mapped[1]!);
    // An address parser writes a mapped IPv4 address in hexadecimal: ::ffff:a00:1 is 10.0.0.1.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
    if (hex) {
      const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
      return privateAddressLiteral(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    return /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare);
  }
  return false;
}

/**
 * Whether an operator's address may be read: https, or http on a local Ledger. Outside a local Ledger it may not name
 * this computer or a private network by its address.
 */
export function programAddressProblem(address: string, httpAllowed: boolean): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return 'Give the full address of the operator’s Ledger, such as https://ledger.example.org';
  }
  if (parsed.username || parsed.password) return 'An address with a name or password in it is not read';
  if (parsed.search || parsed.hash) return 'Give the address of the operator’s Ledger without ? or #';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && httpAllowed))
    return httpAllowed
      ? 'The address starts with https:// or, on a local Ledger, http://'
      : 'The address must start with https://; only a local Ledger reads an http:// address';
  if (!httpAllowed) {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || privateAddressLiteral(host))
      return 'Only a local Ledger reads an address on this computer or a private network';
  }
  return undefined;
}

/** Where an operator's Ledger answers a grant. */
export function programViewUrl(address: string): string {
  return `${address.replace(/\/+$/, '')}${PROGRAM_VIEW_PATH}`;
}

/** The document an answer's bytes hold, or null when they are not a program view this Ledger reads. */
export function programAnswerDocument(bytes: Uint8Array): ProgramViewDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  return isProgramViewDocument(value) ? value : null;
}

/** What a row says of an operator, from its last read and its last answer. */
export function programOperatorState(
  lastRead: Pick<ProgramOperatorAnswer, 'readAt' | 'outcome'> | null,
  lastAnswer: { document: Pick<ProgramViewDocument, 'grantExpiresAt'> } | null,
  now: Date,
): ProgramOperatorState {
  if (!lastRead) return 'not_read';
  if (lastRead.outcome === 'not_in_use') return 'ended';
  if (lastAnswer && Date.parse(lastAnswer.document.grantExpiresAt) <= now.getTime()) return 'ended';
  if (lastRead.outcome === 'failed') return 'failed';
  if (now.getTime() - Date.parse(lastRead.readAt) > PROGRAM_READ_LATE_SECONDS * 1000) return 'late';
  return 'read';
}

interface OperatorRow {
  id: string;
  name: string;
  address: string;
  added_by: string;
  added_by_name: string;
  added_at: Date;
  available_at: Date | null;
}
interface AnswerRow {
  id: string;
  operator_id: string;
  read_at: Date;
  outcome: ProgramOperatorAnswer['outcome'];
  reason: string | null;
  sha256: string | null;
  byte_length: number | null;
}

function answer(row: AnswerRow): ProgramOperatorAnswer {
  return {
    id: row.id,
    readAt: row.read_at.toISOString(),
    outcome: row.outcome,
    reason: row.reason,
    sha256: row.sha256,
    byteLength: row.byte_length,
  };
}

async function readOperators(client: PoolClient, tenantId: string, id?: string): Promise<ProgramOperator[]> {
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const rows = (
    await client.query<OperatorRow>(
      `SELECT o.id,o.name,o.address,o.added_by,p.name AS added_by_name,o.added_at,s.available_at
       FROM program_operators o
       JOIN principals p ON p.tenant_id=o.tenant_id AND p.id=o.added_by
       LEFT JOIN program_operator_schedules s ON s.tenant_id=o.tenant_id AND s.operator_id=o.id
       WHERE o.tenant_id=$1 AND o.removed_at IS NULL AND ($2::text IS NULL OR o.id=$2)`,
      [tenantId, id ?? null],
    )
  ).rows;
  const ids = rows.map((row) => row.id);
  const last = await client.query<AnswerRow>(
    `SELECT DISTINCT ON(operator_id) id,operator_id,read_at,outcome,reason,sha256,byte_length
     FROM program_operator_answers WHERE tenant_id=$1 AND operator_id=ANY($2::text[])
     ORDER BY operator_id,read_at DESC,id DESC`,
    [tenantId, ids],
  );
  const answered = await client.query<{
    operator_id: string;
    read_at: Date;
    sha256: string;
    document: ProgramViewDocument;
  }>(
    `SELECT DISTINCT ON(operator_id) operator_id,read_at,sha256,document
     FROM program_operator_answers WHERE tenant_id=$1 AND operator_id=ANY($2::text[]) AND outcome='answered'
     ORDER BY operator_id,read_at DESC,id DESC`,
    [tenantId, ids],
  );
  const lastBy = new Map(last.rows.map((row) => [row.operator_id, answer(row)]));
  const answerBy = new Map(
    answered.rows.map((row) => [
      row.operator_id,
      { readAt: row.read_at.toISOString(), sha256: row.sha256, document: row.document },
    ]),
  );
  return rows
    .map((row): ProgramOperator => {
      const lastRead = lastBy.get(row.id) ?? null;
      const lastAnswer = answerBy.get(row.id) ?? null;
      return {
        id: row.id,
        name: row.name,
        address: row.address,
        addedBy: { id: row.added_by, name: row.added_by_name },
        addedAt: row.added_at.toISOString(),
        nextReadAt: row.available_at?.toISOString() ?? null,
        state: programOperatorState(lastRead, lastAnswer, now),
        lastRead,
        lastAnswer,
      };
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) || (left.id < right.id ? -1 : 1),
    );
}

/** GET /v1/program-operators: the operators followed, in alphabetical order, each with its last read and answer. */
export async function listProgramOperators(
  client: PoolClient,
  principal: AuthContext,
  httpAllowed: boolean,
): Promise<ProgramOperatorList> {
  requireRead(principal);
  const operators = await readOperators(client, principal.tenantId);
  const removed = await client.query<{
    id: string;
    name: string;
    removed_at: Date;
    removed_by: string;
    removed_by_name: string;
    remove_reason: string;
  }>(
    `SELECT o.id,o.name,o.removed_at,o.removed_by,p.name AS removed_by_name,o.remove_reason FROM program_operators o
     JOIN principals p ON p.tenant_id=o.tenant_id AND p.id=o.removed_by
     WHERE o.tenant_id=$1 AND o.removed_at IS NOT NULL ORDER BY o.removed_at DESC,o.id LIMIT $2`,
    [principal.tenantId, REMOVED_SHOWN],
  );
  const asOf = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  return {
    asOf: asOf.toISOString(),
    operators,
    removed: removed.rows.map((row) => ({
      id: row.id,
      name: row.name,
      removedAt: row.removed_at.toISOString(),
      removedBy: { id: row.removed_by, name: row.removed_by_name },
      reason: row.remove_reason,
    })),
    httpAllowed,
  };
}

/** Follows an operator. The secret is written for the workers and never returned; it is read within the hour. */
export async function addProgramOperator(
  client: PoolClient,
  principal: AuthContext,
  input: ProgramOperatorAdd,
  httpAllowed: boolean,
): Promise<{ operator: ProgramOperator }> {
  requireAuthority(principal);
  const name = input.name.trim();
  const address = input.address.trim();
  const problem = programAddressProblem(address, httpAllowed);
  if (problem) throw new DomainError(400, 'invalid_operator_address', problem);
  const taken = await client.query(
    'SELECT 1 FROM program_operators WHERE tenant_id=$1 AND lower(name)=lower($2) AND removed_at IS NULL',
    [principal.tenantId, name],
  );
  if (taken.rowCount)
    throw new DomainError(409, 'program_operator_name_taken', `You already follow an operator named ${name}`);
  const id = `program-operator-${randomUUID()}`;
  const event = await appendEvent(client, principal, {
    type: 'program-operator.add',
    stream: `program-operator:${id}`,
    payload: { operatorId: id, name, address },
  });
  try {
    await client.query(
      `INSERT INTO program_operators(id,tenant_id,name,address,secret,add_event_id,added_by,added_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, principal.tenantId, name, address, input.secret, event.id, principal.id, event.received_at],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new DomainError(409, 'program_operator_name_taken', `You already follow an operator named ${name}`);
    throw error;
  }
  await client.query('INSERT INTO program_operator_schedules(tenant_id,operator_id) VALUES($1,$2)', [
    principal.tenantId,
    id,
  ]);
  const [added] = await readOperators(client, principal.tenantId, id);
  return { operator: added! };
}

async function requireCurrent(client: PoolClient, tenantId: string, id: string, lock = false): Promise<void> {
  const row = (
    await client.query<{ removed_at: Date | null }>(
      `SELECT removed_at FROM program_operators WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'program_operator_not_found', 'The operator was not found in your organization');
  if (row.removed_at) throw new DomainError(409, 'program_operator_removed', 'This operator is no longer followed');
}

/** Stops following an operator. Its answers are kept; its secret is erased. */
export async function removeProgramOperator(
  client: PoolClient,
  principal: AuthContext,
  id: string,
  reason: string,
): Promise<{ operatorId: string }> {
  requireAuthority(principal);
  await requireCurrent(client, principal.tenantId, id, true);
  const why = reason.trim();
  const event = await appendEvent(client, principal, {
    type: 'program-operator.remove',
    stream: `program-operator:${id}`,
    payload: { operatorId: id, reason: why },
  });
  await client.query(
    `UPDATE program_operators SET remove_event_id=$1,removed_by=$2,removed_at=$3,remove_reason=$4,secret=NULL
     WHERE tenant_id=$5 AND id=$6`,
    [event.id, principal.id, event.received_at, why, principal.tenantId, id],
  );
  return { operatorId: id };
}

/** Asks for a fresh read: the operator's read falls due now, and a worker makes it as it makes the hourly one. */
export async function askProgramRead(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<{ operator: ProgramOperator }> {
  requireRead(principal);
  await requireCurrent(client, principal.tenantId, id);
  await client.query(
    'UPDATE program_operator_schedules SET available_at=clock_timestamp() WHERE tenant_id=$1 AND operator_id=$2',
    [principal.tenantId, id],
  );
  const [operator] = await readOperators(client, principal.tenantId, id);
  return { operator: operator! };
}

/** Every read of one operator, newest first: what was kept and what failed. The documents are not repeated. */
export async function listProgramOperatorAnswers(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<ProgramOperatorAnswers> {
  requireRead(principal);
  const found = await client.query('SELECT 1 FROM program_operators WHERE tenant_id=$1 AND id=$2', [
    principal.tenantId,
    id,
  ]);
  if (!found.rowCount)
    throw new DomainError(404, 'program_operator_not_found', 'The operator was not found in your organization');
  const rows = await client.query<AnswerRow>(
    `SELECT id,operator_id,read_at,outcome,reason,sha256,byte_length FROM program_operator_answers
     WHERE tenant_id=$1 AND operator_id=$2 ORDER BY read_at DESC,id DESC LIMIT $3`,
    [principal.tenantId, id, ANSWERS_SHOWN],
  );
  return { operatorId: id, answers: rows.rows.map(answer) };
}
