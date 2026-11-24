import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  PEOPLE_DIRECTORY_DEFAULT_LIMIT,
  PEOPLE_DIRECTORY_MAX_LIMIT,
  PEOPLE_DIRECTORY_MAX_PERSON_BYTES,
  PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES,
  type OrganizationPeopleResponse,
  type OrganizationPerson,
} from '../../packages/contracts/src/index.js';
import { OrganizationPeopleResponseSchema } from '../../packages/contracts/src/openapi.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

interface Fixture {
  tenantId: string;
  readerId: string;
  tokens: Record<'reader' | 'otherReader' | 'restricted' | 'inactive', string>;
}
interface PersonFixture {
  id: string;
  name: string;
  kind?: 'human' | 'source' | 'worker' | 'service';
  active?: boolean;
  revision?: number;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Authenticated organization people directory', () => {
  const prefix = `people-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validResponse = ajv.compile(OrganizationPeopleResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    await app?.close();
    await pool.end();
    await admin.end();
  });

  async function fixture(suffix: string): Promise<Fixture> {
    const tenantId = `${prefix}:${suffix}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional people directory']);
    const tokens = {} as Fixture['tokens'];
    for (const role of ['reader', 'otherReader', 'restricted', 'inactive'] as const) {
      const id = `${tenantId}:${role}`;
      const capabilities = role === 'restricted' ? ['order:read'] : ['flight:read'];
      tokens[role] = `ledger-dev-${id}`;
      await admin.query(
        "INSERT INTO principals(id,tenant_id,name,kind,capabilities,active) VALUES($1,$2,$3,'service',$4,$5)",
        [id, tenantId, `Fictional ${role}`, capabilities, role !== 'inactive'],
      );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    return { tenantId, readerId: `${tenantId}:reader`, tokens };
  }

  async function person(f: Fixture, value: PersonFixture) {
    await admin.query(
      `INSERT INTO principals(id,tenant_id,name,kind,capabilities,revision,active,sign_in_issuer,sign_in_subject,
       command_link_sources,mission_sources,monitoring_sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10)`,
      [
        value.id,
        f.tenantId,
        value.name,
        value.kind ?? 'human',
        ['decision:write'],
        value.revision ?? 1,
        value.active ?? true,
        'https://private-identity.invalid',
        value.id,
        ['private-source-grant'],
      ],
    );
  }

  const get = (f: Fixture, query = '', role: keyof Fixture['tokens'] = 'reader') =>
    app.inject({
      method: 'GET',
      url: `/v1/organization/people${query ? `?${query}` : ''}`,
      headers: { authorization: `Bearer ${f.tokens[role]}` },
    });
  async function page(f: Fixture, query = '') {
    const response = await get(f, query);
    expect(response.statusCode, response.body).toBe(200);
    expect(validResponse(response.json()), JSON.stringify(validResponse.errors)).toBe(true);
    expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThanOrEqual(PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES);
    return response.json<OrganizationPeopleResponse>();
  }

  it('returns only minimal active tenant humans to a flight reader and rejects unavailable authority or tenant routing', async () => {
    const f = await fixture('membership');
    const foreign = await fixture('foreign');
    const expected: OrganizationPerson[] = [
      { id: `${f.tenantId}:person-a`, name: 'Dana Ortiz', kind: 'human', revision: 3 },
      { id: `${f.tenantId}:person-b`, name: 'Sam Rivera', kind: 'human', revision: 5 },
    ];
    for (const value of expected) await person(f, value);
    await person(f, { id: `${f.tenantId}:inactive-human`, name: 'Inactive human', active: false });
    for (const kind of ['source', 'worker', 'service'] as const)
      await person(f, { id: `${f.tenantId}:${kind}`, name: `Excluded ${kind}`, kind });
    const other = {
      id: `${foreign.tenantId}:person`,
      name: 'Foreign private person',
      kind: 'human' as const,
      revision: 2,
    };
    await person(foreign, other);

    const response = await get(f);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const listed = await page(f);
    expect(listed.people).toEqual(expected);
    expect(listed.page).toMatchObject({
      limit: PEOPLE_DIRECTORY_DEFAULT_LIMIT,
      returned: 2,
      hasMore: false,
      nextCursor: null,
      selection: 'initial',
      order: 'id_ascending',
      consistency: 'live_directory',
    });
    expect((await page(foreign)).people).toEqual([other]);
    expect((await page(f, 'search=Foreign')).people).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/organization/people' })).statusCode).toBe(401);
    const denied = await get(f, '', 'restricted');
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('capability_required');
    expect((await get(f, '', 'inactive')).statusCode).toBe(401);
    const routed = await get(f, new URLSearchParams({ tenantId: foreign.tenantId }).toString());
    expect(routed.statusCode, routed.body).toBe(400);
    expect(routed.json().error.code).toBe('invalid_request');
  });

  it('pages scoped literal name searches without duplicates and bounds whole identities and UTF-8 responses', async () => {
    const f = await fixture('pages');
    const foreign = await fixture('cursor-foreign');
    const ids = Array.from(
      { length: PEOPLE_DIRECTORY_MAX_LIMIT + 1 },
      (_, index) => `${f.tenantId}:person-${String(index).padStart(3, '0')}`,
    );
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) SELECT id,$1,'Casey Crew','human','{}' FROM unnest($2::text[]) id",
      [f.tenantId, ids],
    );
    const query = (search: string, limit = 2, cursor?: string) =>
      new URLSearchParams({ search, limit: String(limit), ...(cursor ? { cursor } : {}) }).toString();
    const first = await page(f, query('  cAsEy CrEw  '));
    expect(first.people.map((entry) => entry.id)).toEqual(ids.slice(0, 2));
    expect(first.page.hasMore).toBe(true);
    const cursor = first.page.nextCursor!;
    const continued = await page(f, query('casey crew', 2, cursor));
    expect(continued.people.map((entry) => entry.id)).toEqual(ids.slice(2, 4));
    expect(continued.page.selection).toBe('continuation');
    expect((await page(f, query('casey crew', 2, cursor))).people).toEqual(continued.people);

    for (const response of [
      await get(f, query('casey crew', 2, cursor), 'otherReader'),
      await get(foreign, query('casey crew', 2, cursor)),
      await get(f, query('different name', 2, cursor)),
    ]) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe('cursor_scope_mismatch');
    }
    const malformed = await get(f, 'cursor=not_valid_json');
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect(malformed.json().error.code).toBe('invalid_history_cursor');

    const later = `${f.tenantId}:person-999`;
    await person(f, { id: later, name: 'Casey Crew' });
    const remainder = await page(f, query('casey crew', PEOPLE_DIRECTORY_MAX_LIMIT, cursor));
    expect([...first.people, ...remainder.people].map((entry) => entry.id)).toEqual(ids);
    expect(remainder.page).toMatchObject({ hasMore: false, nextCursor: null });
    const restarted = await page(f, query('casey crew', PEOPLE_DIRECTORY_MAX_LIMIT));
    expect(restarted.people).toHaveLength(PEOPLE_DIRECTORY_MAX_LIMIT);
    expect(restarted.page.hasMore).toBe(true);
    const tail = await page(f, query('casey crew', PEOPLE_DIRECTORY_MAX_LIMIT, restarted.page.nextCursor!));
    expect([...restarted.people, ...tail.people].map((entry) => entry.id)).toEqual([...ids, later]);
    await admin.query('UPDATE principals SET revision=revision+1 WHERE tenant_id=$1 AND id=$2', [
      f.tenantId,
      f.readerId,
    ]);
    const revised = await get(f, query('casey crew', 2, cursor));
    expect(revised.statusCode, revised.body).toBe(400);
    expect(revised.json().error.code).toBe('cursor_scope_mismatch');

    const literal = 'Needle_%\\';
    const literalId = `${f.tenantId}:literal`;
    await person(f, { id: literalId, name: `${literal} Person` });
    await person(f, { id: `${f.tenantId}:decoy`, name: 'NeedleXother Person' });
    expect((await page(f, query(literal))).people.map((entry) => entry.id)).toEqual([literalId]);
    expect((await page(f, query(literalId))).people).toEqual([]);

    const unicodeSearch = '😀'.repeat(101);
    const unicodeId = `${unicodeSearch}-${randomUUID()}`;
    const unicodeIds = [`${unicodeId}-a`, `${unicodeId}-b`];
    for (const id of unicodeIds) await person(f, { id, name: `${unicodeSearch} Crew` });
    const unicodeFirst = await page(f, query(unicodeSearch, 1));
    expect(unicodeFirst.people.map((entry) => entry.id)).toEqual(unicodeIds.slice(0, 1));
    expect(unicodeFirst.page.hasMore).toBe(true);
    const unicodeNext = await page(f, query(unicodeSearch, 1, unicodeFirst.page.nextCursor!));
    expect(unicodeNext.people.map((entry) => entry.id)).toEqual(unicodeIds.slice(1));
    expect(unicodeNext.page).toMatchObject({ hasMore: false, nextCursor: null, selection: 'continuation' });

    for (let index = 0; index < 8; index++)
      await person(f, { id: `${f.tenantId}:chunk-${index}`, name: `Chunk ${index} ${'é'.repeat(5 * 1024)}` });
    const tooManyBytes = await get(f, query('Chunk', PEOPLE_DIRECTORY_MAX_LIMIT));
    expect(tooManyBytes.statusCode, tooManyBytes.body).toBe(413);
    expect(tooManyBytes.json().error.code).toBe('people_directory_page_too_large');
    expect(Buffer.byteLength(tooManyBytes.body, 'utf8')).toBeLessThanOrEqual(PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES);
    const smaller = await page(f, query('Chunk', 2));
    expect(smaller.people).toHaveLength(2);
    expect(smaller.page.hasMore).toBe(true);
    for (const entry of smaller.people)
      expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(PEOPLE_DIRECTORY_MAX_PERSON_BYTES);

    for (const value of [
      {
        id: `${f.tenantId}:large-utf8`,
        name: `Oversized UTF8 ${'😀'.repeat(PEOPLE_DIRECTORY_MAX_PERSON_BYTES / 4)}`,
        search: 'Oversized UTF8',
      },
      { id: `${f.tenantId}:large-json`, name: `Escaped JSON ${'\\'.repeat(10_000)}`, search: 'Escaped JSON' },
      { id: `${f.tenantId}:${'x'.repeat(201)}`, name: 'Oversized identity', search: 'Oversized identity' },
    ]) {
      await person(f, value);
      const response = await get(f, query(value.search));
      expect(response.statusCode, response.body).toBe(413);
      expect(response.json().error.code).toBe('people_directory_entry_too_large');
      expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThanOrEqual(PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES);
    }
  });
});
