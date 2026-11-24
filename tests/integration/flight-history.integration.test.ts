import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type { EvidenceEnvelope, FlightListResponse, FlightSummary } from '../../packages/contracts/src/index.js';
import { historyPrecise } from '../../packages/domain/src/history.js';
import {
  canonicalDigest,
  canonicalize,
  entryHash,
  INTEGRITY_VERSION,
  sha256,
} from '../../packages/integrity/src/index.js';
import {
  appendEvent,
  createPool,
  MemoryObjectStore,
  withScope,
  type AuthContext,
  type PoolClient,
} from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

interface Fixture {
  tenantId: string;
  principalId: string;
  tokens: Record<'operator' | 'otherReader', string>;
}
interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Immutable flight creation history', () => {
  const prefix = `flight-history-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix, 'tenant-alpha']);
    await app?.close();
    await pool.end();
    await admin.end();
  });

  async function fixture(suffix: string): Promise<Fixture> {
    const tenantId = `${prefix}:${suffix}`;
    const tokens = {} as Fixture['tokens'];
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional flight history operator']);
    for (const role of ['operator', 'otherReader'] as const) {
      const id = `${tenantId}:${role}`;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)", [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'operator' ? ['flight:read', 'flight:create'] : ['flight:read'],
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    return { tenantId, principalId: `${tenantId}:operator`, tokens };
  }

  function get(f: Fixture, values: Record<string, string> = {}, role: keyof Fixture['tokens'] = 'operator') {
    return app.inject({
      method: 'GET',
      url: `/v1/flights?${new URLSearchParams({ view: 'history', ...values })}`,
      headers: { authorization: `Bearer ${f.tokens[role]}` },
    });
  }
  async function page(f: Fixture, values: Record<string, string> = {}): Promise<FlightListResponse> {
    const response = await get(f, values);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<FlightListResponse>();
  }

  async function retainedCreation(client: PoolClient, who: AuthContext, id: string, receivedAt: string) {
    const streamId = randomUUID();
    const eventId = randomUUID();
    const payload = { flightId: id, originationKey: id, label: id };
    // Append the complete original envelope directly so PostgreSQL microseconds survive the fixture.
    const envelope: EvidenceEnvelope = {
      eventId,
      tenantId: who.tenantId,
      streamId,
      sequence: '1',
      type: 'flight.created',
      schemaVersion: 1,
      principalId: who.id,
      sourceId: null,
      sourceSessionId: null,
      occurredAt: null,
      effectiveAt: null,
      receivedAt,
      causationId: null,
      artifactId: null,
      payload,
    };
    const digest = canonicalDigest(envelope);
    const hash = entryHash(who.tenantId, streamId, 1, '', digest);
    await client.query('INSERT INTO streams(id,tenant_id,name,sequence,head_hash) VALUES($1,$2,$3,1,$4)', [
      streamId,
      who.tenantId,
      `flight:${id}`,
      hash,
    ]);
    await client.query(
      `INSERT INTO journal_events(tenant_id,id,stream_id,stream_sequence,event_type,principal_id,received_at,
       payload,envelope_digest,previous_hash,entry_hash,encoding_version,immutable_envelope)
       VALUES($1,$2,$3,1,'flight.created',$4,$5,$6,$7,'',$8,$9,$10)`,
      [
        who.tenantId,
        eventId,
        streamId,
        who.id,
        receivedAt,
        payload,
        digest,
        hash,
        INTEGRITY_VERSION,
        canonicalize(envelope),
      ],
    );
    await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight',$1)", [id, who.tenantId]);
  }
  async function historyFlight(f: Fixture, suffix: string, receivedAt: string) {
    const id = `${f.tenantId}:${suffix}`;
    await withScope(pool, { id: f.principalId, tenantId: f.tenantId }, async (client, who) => {
      await retainedCreation(client, who, id, receivedAt);
      await client.query(
        "INSERT INTO flight_views(id,tenant_id,origination_key,label,activity) VALUES($1,$2,$1,$1,'landed')",
        [id, who.tenantId],
      );
    });
    return id;
  }

  it('orders by original receipt microseconds and C ties while a continuation excludes newer creations and ignores late evidence', async () => {
    const f = await fixture('chronology');
    const oldest = await historyFlight(f, 'z-oldest', '2026-10-01T12:00:00.123455Z');
    const tiedLower = await historyFlight(f, 'Z-tie', '2026-10-01T12:00:00.123456Z');
    const tiedUpper = await historyFlight(f, 'a-tie', '2026-10-01T12:00:00.123456Z');
    const newest = await historyFlight(f, 'a-newest', '2026-10-01T12:00:00.123457Z');
    const first = await page(f, { limit: '2' });
    expect(first.flights.map((flight) => flight.id)).toEqual([newest, tiedUpper]);
    expect(first.nextCursor).toBeTruthy();
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))).toMatchObject({
      upper: { id: newest, time: '2026-10-01T12:00:00.123457Z' },
      position: { id: tiedUpper, time: '2026-10-01T12:00:00.123456Z' },
    });

    const later = await historyFlight(f, 'newly-created', '2026-10-01T12:00:00.999999Z');
    await withScope(pool, { id: f.principalId, tenantId: f.tenantId }, async (client, who) => {
      const event = await appendEvent(client, who, {
        type: 'flight.observation',
        stream: `flight:${oldest}`,
        occurredAt: '2026-10-01T12:00:01.000Z',
        payload: { flightId: oldest, activity: 'landed' },
      });
      await client.query(
        `INSERT INTO claims(id,tenant_id,event_id,flight_id,kind,payload,occurred_at)
         VALUES($1,$2,$3,$4,'flight.observation',$5,$6)`,
        [randomUUID(), who.tenantId, event.id, oldest, event.payload, event.occurred_at],
      );
      await client.query(
        `UPDATE flight_views SET label='Updated after landing',aircraft='Retained aircraft',
         scheduled_start='2027-01-01T12:00:00Z',last_received_at=$2,revision=revision+1 WHERE id=$1`,
        [oldest, event.received_at],
      );
    });
    const continued = await page(f, { limit: '2', cursor: first.nextCursor! });
    expect(continued.flights.map((flight) => flight.id)).toEqual([tiedLower, oldest]);
    expect(continued.nextCursor).toBeNull();
    expect(continued.flights[1]!.label).toBe('Updated after landing');
    expect((await page(f)).flights.map((flight) => flight.id)).toEqual([later, newest, tiedUpper, tiedLower, oldest]);
  });

  it('rejects malformed or differently scoped history cursors, isolates tenants and supports bounded ordered index keysets', async () => {
    const f = await fixture('scope');
    const foreign = await fixture('foreign');
    const ids = [];
    for (const suffix of ['a', 'b', 'c']) ids.push(await historyFlight(f, suffix, '2026-10-02T12:00:00.000001Z'));
    const foreignId = await historyFlight(foreign, 'foreign', '2026-10-03T12:00:00.000001Z');
    const first = await page(f, { limit: '1', search: `  ${f.tenantId}  ` });
    expect(first.flights.map((flight) => flight.id)).toEqual([ids[2]]);
    const cursor = first.nextCursor!;
    const continued = await page(f, { limit: '2', search: f.tenantId, cursor });
    expect(continued.flights.map((flight) => flight.id)).toEqual([ids[1], ids[0]]);
    expect(continued.nextCursor).toBeNull();
    expect((await page(foreign)).flights.map((flight) => flight.id)).toEqual([foreignId]);
    for (const raw of ['not_valid_json', ids[0]!]) {
      const response = await get(f, { cursor: raw });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe('invalid_history_cursor');
    }
    for (const response of [
      await get(f, { search: f.tenantId, cursor }, 'otherReader'),
      await get(foreign, { search: f.tenantId, cursor }),
      await get(f, { search: 'changed search', cursor }),
      ...(await Promise.all(
        ['monitor', 'overdue', 'historical-issues'].map((view) => get(f, { search: f.tenantId, cursor, view })),
      )),
      await app.inject({
        method: 'GET',
        url: `/v1/receipts?cursor=${encodeURIComponent(cursor)}`,
        headers: { authorization: `Bearer ${f.tokens.operator}` },
      }),
    ]) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe('cursor_scope_mismatch');
    }
    await admin.query('UPDATE principals SET revision=revision+1 WHERE tenant_id=$1 AND id=$2', [
      f.tenantId,
      f.principalId,
    ]);
    const revised = await get(f, { search: f.tenantId, cursor });
    expect(revised.statusCode, revised.body).toBe(400);
    expect(revised.json().error.code).toBe('cursor_scope_mismatch');

    await withScope(pool, { id: f.principalId, tenantId: f.tenantId }, async (client) => {
      // Exercise ordered index capability even when sorting this tiny fixture costs less.
      await client.query('SET LOCAL enable_seqscan=off');
      await client.query('SET LOCAL enable_sort=off');
      const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
      for (const continuation of [false, true]) {
        const bounds = continuation
          ? `AND (created_at,id COLLATE "C")<=($2::timestamptz,$3::text COLLATE "C")
             AND (created_at,id COLLATE "C")<($4::timestamptz,$5::text COLLATE "C")`
          : '';
        const values = continuation
          ? [f.tenantId, '2026-10-02T12:00:00.000001Z', ids[2], '2026-10-02T12:00:00.000001Z', ids[1]]
          : [f.tenantId];
        const result = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
          `EXPLAIN (FORMAT JSON) SELECT id,${historyPrecise('created_at')} AS page_time
           FROM flight_views WHERE tenant_id=$1 ${bounds}
           ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 2`,
          values,
        );
        const plan = result.rows[0]!['QUERY PLAN'][0]!.Plan;
        const details = `flight_creation_history: ${continuation ? 'continuation' : 'first page'}\n${JSON.stringify(plan)}`;
        const all = nodes(plan);
        expect(
          all.some((node) => node['Node Type'].includes('Sort')),
          details,
        ).toBe(false);
        expect(
          all.some((node) => node['Node Type'] === 'Seq Scan'),
          details,
        ).toBe(false);
        const index = all.find((node) => node['Index Name'] === 'flight_creation_history');
        expect(index?.['Index Cond'], details).toContain('tenant_id');
        if (continuation) expect(index?.['Index Cond'], details).toContain('created_at');
      }
    });
  });

  it('creates once across retried keys and derives an immutable creation identity and time from the original event', async () => {
    const f = await fixture('creation');
    const payload = { originationKey: `${f.tenantId}:origin`, label: 'Creation retry' };
    const key = randomUUID();
    const create = (idempotencyKey: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/flights',
        payload,
        headers: { authorization: `Bearer ${f.tokens.operator}`, 'idempotency-key': idempotencyKey },
      });
    const responses = await Promise.all([create(key), create(key), create(randomUUID())]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    const id = responses[0]!.json<{ flight: FlightSummary }>().flight.id;
    expect(responses.map((response) => response.json<{ flight: FlightSummary }>().flight.id)).toEqual([id, id, id]);
    await withScope(pool, { id: f.principalId, tenantId: f.tenantId }, async (client, who) => {
      const created = await client.query<{ created_at: string; event_time: string; matches: boolean }>(
        `SELECT ${historyPrecise('f.created_at')} AS created_at,${historyPrecise('e.received_at')} AS event_time,
         f.created_at=e.received_at AS matches FROM flight_views f
         JOIN streams s ON s.tenant_id=f.tenant_id AND s.name='flight:'||f.id
         JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id AND e.event_type='flight.created'
         WHERE f.id=$1`,
        [id],
      );
      expect(created.rows).toHaveLength(1);
      expect(created.rows[0]!.matches).toBe(true);
      expect(created.rows[0]!.created_at).toBe(created.rows[0]!.event_time);
      const later = await appendEvent(client, who, {
        type: 'flight.observation',
        stream: `flight:${id}`,
        payload: { flightId: id, activity: 'landed' },
      });
      await client.query(
        "UPDATE flight_views SET activity='landed',last_received_at=$2,revision=revision+1 WHERE id=$1",
        [id, later.received_at],
      );
      const unchanged = await client.query<{ created_at: string }>(
        `SELECT ${historyPrecise('created_at')} AS created_at FROM flight_views WHERE id=$1`,
        [id],
      );
      expect(unchanged.rows[0]!.created_at).toBe(created.rows[0]!.created_at);

      async function forbidden(sql: string, values: unknown[]) {
        await client.query('SAVEPOINT forbidden_creation_change');
        try {
          await expect(client.query(sql, values)).rejects.toMatchObject({ code: '23514' });
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT forbidden_creation_change');
          await client.query('RELEASE SAVEPOINT forbidden_creation_change');
        }
      }
      for (const [column, value] of [
        ['created_at', '2020-01-01T00:00:00Z'],
        ['id', `${id}-replacement`],
        ['tenant_id', 'tenant-alpha'],
      ])
        await forbidden(`UPDATE flight_views SET ${column}=$2 WHERE id=$1`, [id, value]);

      const missing = `${f.tenantId}:missing-original`;
      await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight',$1)", [
        missing,
        who.tenantId,
      ]);
      await forbidden('INSERT INTO flight_views(id,tenant_id,origination_key,label) VALUES($1,$2,$1,$1)', [
        missing,
        who.tenantId,
      ]);
      const mismatch = `${f.tenantId}:mismatched-time`;
      await retainedCreation(client, who, mismatch, '2026-10-01T12:00:00.123456Z');
      await forbidden(
        `INSERT INTO flight_views(id,tenant_id,origination_key,label,created_at)
         VALUES($1,$2,$1,$1,'2026-10-01T12:00:00.123455Z')`,
        [mismatch, who.tenantId],
      );
    });
  });

  it('backfills exact original microseconds including legacy creations and refuses an invented time for an orphan', async () => {
    const migration = await readFile(
      new URL('../../packages/persistence/migrations/0038_flight_creation_history.sql', import.meta.url),
      'utf8',
    );
    const end = migration.indexOf('CREATE INDEX flight_creation_history');
    expect(end).toBeGreaterThan(0);
    const backfill = migration.slice(0, end);
    const rollback = new Error('Roll back temporary creation backfill fixture');
    await expect(
      withScope(pool, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client) => {
        await client.query('SET LOCAL search_path=pg_temp,public');
        await client.query(
          'CREATE TEMP TABLE flight_views(id text,tenant_id text,origination_key text) ON COMMIT DROP',
        );
        await client.query('CREATE TEMP TABLE streams(id text,tenant_id text,name text) ON COMMIT DROP');
        await client.query(`CREATE TEMP TABLE journal_events(
        tenant_id text,stream_id text,stream_sequence bigint,event_type text,payload jsonb,received_at timestamptz
      ) ON COMMIT DROP`);
        const times = ['2026-10-01T12:00:00.123455Z', '2026-10-01T12:00:00.123456Z', '2026-10-01T12:00:00.123457Z'];
        await client.query(`INSERT INTO flight_views VALUES
        ('ordinary','tenant-alpha','ordinary-origin'),('legacy','tenant-alpha','legacy-origin'),
        ('orphan','tenant-alpha','orphan-origin')`);
        await client.query(`INSERT INTO streams VALUES
        ('ordinary-stream','tenant-alpha','flight:ordinary'),('legacy-stream','tenant-alpha','flight:legacy'),
        ('orphan-stream','tenant-alpha','flight:orphan')`);
        await client.query(
          `INSERT INTO journal_events VALUES
        ('tenant-alpha','ordinary-stream',1,'flight.created','{"flightId":"ordinary","originationKey":"ordinary-origin"}',$1),
        ('tenant-alpha','legacy-stream',1,'flight.created','{"flightId":"legacy"}',$2)`,
          times.slice(0, 2),
        );
        await client.query('SAVEPOINT before_creation_backfill');
        try {
          await expect(client.query(backfill)).rejects.toMatchObject({ code: '23514' });
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT before_creation_backfill');
          await client.query('RELEASE SAVEPOINT before_creation_backfill');
        }
        await client.query(
          `INSERT INTO journal_events VALUES
        ('tenant-alpha','orphan-stream',1,'flight.created','{"flightId":"orphan","originationKey":"orphan-origin"}',$1)`,
          [times[2]],
        );
        await client.query(backfill);
        const migrated = await client.query<{ id: string; created_at: string }>(
          `SELECT id,${historyPrecise('created_at')} AS created_at FROM flight_views ORDER BY created_at,id COLLATE "C"`,
        );
        expect(migrated.rows).toEqual([
          { id: 'ordinary', created_at: times[0] },
          { id: 'legacy', created_at: times[1] },
          { id: 'orphan', created_at: times[2] },
        ]);
        const column = await client.query<{ attnotnull: boolean }>(
          "SELECT attnotnull FROM pg_attribute WHERE attrelid='pg_temp.flight_views'::regclass AND attname='created_at'",
        );
        expect(column.rows[0]!.attnotnull).toBe(true);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
