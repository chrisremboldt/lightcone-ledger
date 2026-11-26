import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { canonicalDigest, canonicalize, entryHash, INTEGRITY_VERSION, sha256 } from '@ledger/integrity';
import { loadMigrations } from './schema.js';
export {
  DiskObjectStore,
  MemoryObjectStore,
  S3ObjectStore,
  assertObjectStoreReady,
  createObjectStore,
  objectStoreSetting,
  readBoundedObject,
  writeBoundedObject,
  type ObjectStore,
  type ObjectReadOptions,
  type ObjectWriteOptions,
} from './objects.js';
export type { PoolClient } from 'pg';
export type Pool = pg.Pool;
export interface AuthContext {
  id: string;
  tenantId: string;
  name: string;
  kind?: string;
  capabilities: string[];
  commandLinkSources?: string[];
  missionSources?: string[];
  monitoringSources?: string[];
  revision: number;
}
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (error: Error & { code?: string }) =>
    console.error('Database pool connection lost', { code: error.code ?? 'unknown' }),
  );
  // The pool listens for a connection's error only while the connection is idle. A connection lost while checked out
  // (inside a transaction, between two of its statements) would otherwise emit an unhandled 'error' and end the
  // process. Its pending and later statements still fail, and the pool discards it when it is released.
  pool.on('connect', (client) =>
    client.on('error', (error: Error & { code?: string }) =>
      console.error('Database connection lost while in use', { code: error.code ?? 'unknown' }),
    ),
  );
  return pool;
}
const UNAVAILABLE_CODES = new Set([
  '53300',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const UNAVAILABLE_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'is not queryable',
  'Client was closed',
];
/**
 * Whether an error means the database could not be reached or dropped the connection, rather than refusing a
 * statement: connection exceptions (class 08), no connection slot left (53300), an administrator or crash shutdown, a
 * server still starting or recovering (class 57P), and the driver's own errors for a connection that is gone.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && (code.startsWith('08') || code.startsWith('57P') || UNAVAILABLE_CODES.has(code)))
    return true;
  if (error instanceof AggregateError && error.errors.some(isDatabaseUnavailable)) return true;
  return UNAVAILABLE_MESSAGES.some((message) => error.message.includes(message));
}
/** The wait before the next attempt after a number of consecutive failures: a quarter second doubling to five. */
export function databaseRetryDelay(failures: number): number {
  return Math.min(5000, 250 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
}
/**
 * Runs an operation, and while the database cannot be reached waits and runs it again; any other error is thrown.
 * For a process starting before its database, or while the database restarts.
 */
export async function untilDatabaseReachable<T>(
  operation: () => Promise<T>,
  onWait: (error: Error & { code?: string }, delayMs: number) => void = (error, delayMs) =>
    console.error('Waiting for the database', { code: error.code ?? 'unknown', retryInMs: delayMs }),
): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await operation();
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      const delayMs = databaseRetryDelay(failures);
      onWait(error as Error & { code?: string }, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
/**
 * Rolls a transaction back. On a connection that is gone there is nothing to roll back: the caller keeps the error
 * that ended the transaction, and the pool discards the connection when it is released.
 */
export async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    if (!isDatabaseUnavailable(error)) throw error;
  }
}
async function assertRuntimeRole(pool: Pool, name: 'ledger_app' | 'ledger_worker'): Promise<void> {
  const {
    rows: [role],
  } = await pool.query(
    "SELECT current_user AS name,rolsuper,rolbypassrls,(SELECT tableowner=current_user FROM pg_tables WHERE schemaname='public' AND tablename='principals') AS owns_tables FROM pg_roles WHERE rolname=current_user",
  );
  if (role?.name !== name || role.rolsuper || role.rolbypassrls || role.owns_tables)
    throw new Error(`Runtime requires the non-owner ${name} role without RLS bypass`);
}
/** The variables that hold the database owner's connection, which only migrations and the setup commands use. */
export const OWNER_CONNECTION_VARIABLES = ['DATABASE_ADMIN_URL', 'LEDGER_DATABASE_OWNER_PASSWORD'] as const;

/**
 * Refuses to start the API or the workers with the database owner's connection outside local development and tests:
 * the owner can change every table and bypass the roles the API and the workers run as. Throws with a sentence naming
 * the variables to remove.
 */
export function refuseOwnerConnection(processName: 'API' | 'workers', env: NodeJS.ProcessEnv = process.env): void {
  const ledgerEnv = env.LEDGER_ENV || (env.NODE_ENV === 'production' ? 'staging' : 'local');
  if (ledgerEnv === 'local' || ledgerEnv === 'test') return;
  const given = OWNER_CONNECTION_VARIABLES.filter((name) => env[name]);
  if (!given.length) return;
  throw new Error(
    `The ${processName} will not start with the database owner's connection (${given.join(', ')}). Only migrations ` +
      'and the setup commands use it: remove it from the environment the API and the workers are given, and keep it ' +
      'in the owner file they never read (ledger-owner.env in docs/guides/deploy.md).',
  );
}
export async function assertApplicationRole(pool: Pool): Promise<void> {
  await assertRuntimeRole(pool, 'ledger_app');
}
export async function assertWorkerRole(pool: Pool): Promise<void> {
  await assertRuntimeRole(pool, 'ledger_worker');
}
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ledger:migrations'))");
    const password =
      process.env.DATABASE_APP_PASSWORD ??
      process.env.LEDGER_APP_PASSWORD ??
      (process.env.LEDGER_ENV === 'staging' ? undefined : 'ledger_app_local');
    if (!password) throw new Error('LEDGER_APP_PASSWORD is required to create the non-owner application role');
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname='ledger_app'");
    if (!exists.rowCount)
      await client.query(
        "CREATE ROLE ledger_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '" +
          password.replaceAll("'", "''") +
          "'",
      );
    const workerPassword =
      process.env.DATABASE_WORKER_PASSWORD ??
      (process.env.LEDGER_ENV === 'staging' ? undefined : 'ledger-local-worker');
    if (!workerPassword) throw new Error('DATABASE_WORKER_PASSWORD is required to create the non-owner worker role');
    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='ledger_worker'")).rowCount)
      await client.query(
        "CREATE ROLE ledger_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD '" +
          workerPassword.replaceAll("'", "''") +
          "'",
      );
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,name text,checksum text,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    );
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS name text,ADD COLUMN IF NOT EXISTS checksum text',
    );
    for (const migration of await loadMigrations()) {
      const applied = (
        await client.query('SELECT name,checksum FROM schema_migrations WHERE version=$1', [migration.version])
      ).rows[0];
      if (applied?.checksum) {
        if (applied.checksum !== migration.checksum || applied.name !== migration.name)
          throw new Error(`Applied migration ${migration.name} no longer matches its immutable checksum`);
        continue;
      }
      // Adopt the initial local skeleton's unchecksummed version once; all future migrations are immutable.
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3) ON CONFLICT(version) DO UPDATE SET name=EXCLUDED.name,checksum=EXCLUDED.checksum',
        [migration.version, migration.name, migration.checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
interface PrincipalAuthorityRow {
  id: string;
  tenant_id: string;
  name: string;
  kind?: string;
  capabilities: string[];
  command_link_sources?: string[];
  mission_sources?: string[];
  monitoring_sources?: string[];
  revision: string | number;
}
export function authFromRow(row: PrincipalAuthorityRow): AuthContext {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    capabilities: row.capabilities,
    commandLinkSources: row.command_link_sources ?? [],
    missionSources: row.mission_sources ?? [],
    monitoringSources: row.monitoring_sources ?? [],
    revision: Number(row.revision),
  };
}
export async function authenticate(
  pool: Pool,
  identity: { token?: string; issuer?: string; subject?: string },
): Promise<AuthContext | null> {
  const result = await pool.query('SELECT * FROM ledger_authenticate($1,$2,$3)', [
    identity.token ? sha256(identity.token) : null,
    identity.issuer ?? null,
    identity.subject ?? null,
  ]);
  const row = result.rows[0];
  return row?.active ? authFromRow(row) : null;
}
/**
 * Whether an identity provider's account (issuer and subject) is tied to anyone in Ledger, active or not. Read only to
 * say why a verified sign-in was refused.
 */
export async function signInAccountTied(pool: Pool, identity: { issuer: string; subject: string }): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM ledger_authenticate(NULL,$1,$2)', [identity.issuer, identity.subject]);
  return Boolean(result.rowCount);
}
export async function withScope<T>(
  pool: Pool,
  context: Pick<AuthContext, 'id' | 'tenantId'>,
  operation: (client: PoolClient, principal: AuthContext) => Promise<T>,
  capability?: string,
  consistentRead = false,
  statementTimeoutMs?: number,
  // A transaction that will change the caller's own principal row takes it FOR UPDATE here, first, rather than
  // upgrading its FOR SHARE later, which deadlocks against another such transaction holding FOR SHARE too.
  principalLock: 'SHARE' | 'UPDATE' = 'SHARE',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(consistentRead ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    // Without just-in-time compilation: PostgreSQL compiles a statement whose estimated cost is high, and the
    // estimates of the evaluator's correlated reads over the partitioned journal are high while the reads take a few
    // milliseconds. Compiling them took hundreds of milliseconds each, inside the transaction.
    await client.query(
      "SELECT set_config('ledger.tenant_id',$1,true),set_config('ledger.principal_id',$2,true),set_config('jit','off',true)",
      [context.tenantId, context.id],
    );
    if (statementTimeoutMs !== undefined)
      await client.query("SELECT set_config('statement_timeout',$1,true)", [
        String(Math.max(1, Math.floor(statementTimeoutMs))),
      ]);
    const current = await client.query(`SELECT * FROM principals WHERE id=$1 AND tenant_id=$2 FOR ${principalLock}`, [
      context.id,
      context.tenantId,
    ]);
    if (!current.rows[0]?.active) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
    const principal = authFromRow(current.rows[0]);
    if (capability && !principal.capabilities.includes(capability))
      throw new DomainError(403, 'capability_required', `Capability ${capability} is required`);
    const value = await operation(client, principal);
    await client.query('COMMIT');
    return value;
  } catch (error: any) {
    await rollback(client);
    if (error.code === '40001' || error.code === '40P01')
      throw new DomainError(409, 'concurrent_change', 'Relevant records changed; refresh the basis and retry');
    throw error;
  } finally {
    client.release();
  }
}
export interface JournalEvent {
  id: string;
  tenant_id: string;
  stream_id: string;
  stream_sequence: string;
  event_type: string;
  principal_id: string;
  source_id: string | null;
  source_session_id: string | null;
  occurred_at: Date | null;
  received_at: Date;
  payload: Record<string, any>;
  artifact_id: string | null;
  causation_id: string | null;
}
export const LIVE_RETAINED_NOTICES = 1024;
export async function appendLiveChange(
  client: PoolClient,
  tenantId: string,
  flightId: string,
  eventId: string,
  type: 'telemetry.updated' | 'flight.updated',
  receiptId?: string,
): Promise<void> {
  await client.query('INSERT INTO flight_live_heads(tenant_id,flight_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    tenantId,
    flightId,
  ]);
  const {
    rows: [head],
  } = await client.query(
    'UPDATE flight_live_heads SET sequence=sequence+1 WHERE tenant_id=$1 AND flight_id=$2 RETURNING sequence',
    [tenantId, flightId],
  );
  await client.query(
    'INSERT INTO flight_live_changes(tenant_id,flight_id,sequence,type,event_id,receipt_id) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId, flightId, head.sequence, type, eventId, receiptId ?? null],
  );
  await client.query('DELETE FROM flight_live_changes WHERE tenant_id=$1 AND flight_id=$2 AND sequence<=$3', [
    tenantId,
    flightId,
    String(BigInt(head.sequence) - BigInt(LIVE_RETAINED_NOTICES)),
  ]);
}
export async function appendEvent(
  client: PoolClient,
  principal: AuthContext,
  options: {
    type: string;
    stream: string;
    payload: Record<string, unknown> | ((event: { id: string; receivedAt: string }) => Record<string, unknown>);
    sourceId?: string;
    sessionId?: string;
    occurredAt?: string;
    effectiveAt?: string;
    artifactId?: string;
    causationId?: string;
    id?: string;
  },
): Promise<JournalEvent> {
  const streamId = randomUUID();
  await client.query('INSERT INTO streams(id,tenant_id,name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,name) DO NOTHING', [
    streamId,
    principal.tenantId,
    options.stream,
  ]);
  const {
    rows: [head],
  } = await client.query('SELECT * FROM streams WHERE tenant_id=$1 AND name=$2 FOR UPDATE', [
    principal.tenantId,
    options.stream,
  ]);
  const id = options.id ?? randomUUID();
  const sequence = BigInt(head.sequence) + 1n;
  const {
    rows: [clock],
  } = await client.query('SELECT clock_timestamp() AS now');
  const receivedAt = clock.now.toISOString();
  const payload = typeof options.payload === 'function' ? options.payload({ id, receivedAt }) : options.payload;
  const envelope = {
    eventId: id,
    tenantId: principal.tenantId,
    streamId: head.id,
    sequence: sequence.toString(),
    type: options.type,
    schemaVersion: 1,
    principalId: principal.id,
    sourceId: options.sourceId ?? null,
    sourceSessionId: options.sessionId ?? null,
    occurredAt: options.occurredAt ?? null,
    effectiveAt: options.effectiveAt ?? null,
    receivedAt,
    causationId: options.causationId ?? null,
    artifactId: options.artifactId ?? null,
    payload,
  };
  const digest = canonicalDigest(envelope);
  const hash = entryHash(principal.tenantId, head.id, sequence, head.head_hash, digest);
  const result = await client.query(
    `INSERT INTO journal_events(tenant_id,id,stream_id,stream_sequence,event_type,principal_id,source_id,source_session_id,occurred_at,effective_at,received_at,causation_id,payload,artifact_id,envelope_digest,previous_hash,entry_hash,encoding_version,immutable_envelope)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [
      principal.tenantId,
      id,
      head.id,
      sequence.toString(),
      options.type,
      principal.id,
      options.sourceId ?? null,
      options.sessionId ?? null,
      options.occurredAt ?? null,
      options.effectiveAt ?? null,
      receivedAt,
      options.causationId ?? null,
      payload,
      options.artifactId ?? null,
      digest,
      head.head_hash,
      hash,
      INTEGRITY_VERSION,
      canonicalize(envelope),
    ],
  );
  await client.query('UPDATE streams SET sequence=$1,head_hash=$2 WHERE id=$3', [sequence.toString(), hash, head.id]);
  await client.query('INSERT INTO outbox(id,tenant_id,event_id) VALUES($1,$2,$3)', [
    randomUUID(),
    principal.tenantId,
    id,
  ]);
  await client.query('INSERT INTO work_items(id,tenant_id,event_id,stream_id,stream_sequence) VALUES($1,$2,$3,$4,$5)', [
    randomUUID(),
    principal.tenantId,
    id,
    head.id,
    sequence.toString(),
  ]);
  return result.rows[0];
}
export async function idempotent<T>(
  client: PoolClient,
  principal: AuthContext,
  endpoint: string,
  key: string,
  content: unknown,
  effect: () => Promise<{ id: string; value: T }>,
  replay: (id: string) => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  if (!key || key.length > 200)
    throw new DomainError(400, 'idempotency_key_required', 'A bounded Idempotency-Key header is required');
  const digest = canonicalDigest(content);
  // The key-specific lock never serializes unrelated producers or commands.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${principal.tenantId}\u0000${principal.id}\u0000${endpoint}\u0000${key}`.replaceAll('\u0000', '|'),
  ]);
  const old = await client.query(
    'SELECT * FROM idempotency_keys WHERE tenant_id=$1 AND principal_id=$2 AND endpoint=$3 AND producer_key=$4',
    [principal.tenantId, principal.id, endpoint, key],
  );
  if (old.rows[0]) {
    if (old.rows[0].digest !== digest)
      throw new DomainError(409, 'idempotency_conflict', 'This key already identifies different content');
    return { value: await replay(old.rows[0].effect_id), replayed: true };
  }
  const result = await effect();
  await client.query(
    'INSERT INTO idempotency_keys(tenant_id,principal_id,endpoint,producer_key,digest,effect_id) VALUES($1,$2,$3,$4,$5,$6)',
    [principal.tenantId, principal.id, endpoint, key, digest, result.id],
  );
  return { value: result.value, replayed: false };
}
/** The zone every fictional seeded organization declares. */
export const SEEDED_TIME_ZONE = 'America/Chicago';
/** The fictional flight organizations; each also adopts the example risk matrix and procedures through the API seed. */
export const seededOrganizations = ['alpha', 'beta'] as const;
/** Every fictional organization the local seeds create: the two above and the utility (apps/api/src/seed-utility.ts). */
export const seededFictionalOrganizationIds: readonly string[] = [
  ...seededOrganizations.map((name) => `tenant-${name}`),
  'tenant-utility',
];
const seededPeople: Record<string, string> = {
  'alpha-operator': 'Dana Ortiz',
  'alpha-actor': 'Sam Rivera',
  'beta-operator': 'Lee Park',
  'beta-actor': 'Jordan Hale',
};
export async function seed(pool: Pool): Promise<{ tenantIds: string[]; tokens: Record<string, string> }> {
  if (process.env.LEDGER_ENV === 'staging' || process.env.NODE_ENV === 'production')
    throw new Error('Development token seeds are forbidden outside isolated local/test environments');
  const client = await pool.connect();
  const tokens: Record<string, string> = {};
  try {
    await client.query('BEGIN');
    for (const name of seededOrganizations) {
      const tenant = `tenant-${name}`;
      await client.query('INSERT INTO tenants(id,name,time_zone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        tenant,
        `${name[0]!.toUpperCase()}${name.slice(1)} Synthetic Operations`,
        SEEDED_TIME_ZONE,
      ]);
      const capabilities: Record<string, string[]> = {
        source: ['input:write', 'flight:create', 'flight:read', 'order:read', 'evidence:read'],
        actor: [
          'input:write',
          'flight:read',
          'order:read',
          'evidence:read',
          'decision:write',
          'correction:write',
          'identity:write',
          'sms:read',
        ],
        operator: [
          'input:write',
          'flight:create',
          'flight:read',
          'order:read',
          'evidence:read',
          'decision:write',
          'correction:write',
          'identity:write',
          'authority:write',
          'sms:read',
          'sms:write',
          'sms:configure',
          'sms:adopt',
          // The dispatcher adopts the organization's operating procedures (see apps/api/src/seed-rule-packs.ts).
          'pack:adopt',
          // No risk acceptance authority is seeded: an administrator grants it to a named person.
        ],
        worker: ['input:write', 'flight:create', 'flight:read', 'order:read', 'evidence:read', 'identity:write'],
      };
      for (const role of ['source', 'actor', 'operator', 'worker']) {
        const id = `principal-${name}-${role}`;
        await client.query(
          `INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(id) DO UPDATE SET capabilities=EXCLUDED.capabilities,revision=principals.revision+1
           WHERE principals.capabilities IS DISTINCT FROM EXCLUDED.capabilities`,
          [
            id,
            tenant,
            seededPeople[`${name}-${role}`] ?? `${name} ${role}`,
            role === 'actor' || role === 'operator' ? 'human' : role,
            capabilities[role],
          ],
        );
        // The dispatcher keeps the organization's operator records: import and hand entry under the
        // conventional operator-records source (OPERATOR_RECORD_SOURCE_ID in @ledger/contracts).
        if (role === 'operator')
          await client.query(
            `INSERT INTO observation_grants(tenant_id,principal_id,source_id,observation_type)
             VALUES($1,$2,'operator-records','operator.record') ON CONFLICT DO NOTHING`,
            [tenant, id],
          );
        if (role !== 'worker') {
          const token = `ledger-dev-${name}-${role}`;
          tokens[`${name}-${role}`] = token;
          await client.query(
            'INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [sha256(token), id],
          );
        }
      }
    }
    await client.query('COMMIT');
    return { tenantIds: seededOrganizations.map((name) => `tenant-${name}`), tokens };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
