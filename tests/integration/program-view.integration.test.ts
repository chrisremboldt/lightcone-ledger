import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { callProgramOperator, readLeasedProgramOperator, type ProgramReadLease } from '../../apps/workers/src/index.js';
import type {
  ProgramGrant,
  ProgramGrantCreated,
  ProgramOperatorAnswers,
  ProgramOperatorList,
  ProgramViewDocument,
} from '../../packages/contracts/src/index.js';
import { isProgramViewDocument } from '../../packages/contracts/src/program-view-check.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

const PACK = 'ledger.part107';
const SECRET = /^ledger-program-[A-Za-z0-9_-]{43}$/;

/**
 * A program owner follows an operator through a grant, on one deployment: one app serves both organizations, and the
 * program owner's worker calls that app's own address, as it would call another Ledger. The grant answers counts and
 * nothing that names a subject, a person or a safety report; unknown, expired and revoked secrets answer alike.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('A program owner’s view of the operators it contracts', () => {
  const pool = createPool();
  const workers = createPool(process.env.WORKER_DATABASE_URL);
  let operator: CoverageTenant;
  let owner: CoverageTenant;
  let app: Awaited<ReturnType<typeof createApp>>;
  let address: string;
  let standIn: Server;
  let standInAddress: string;
  let people: string[];
  let production: { id: string };
  let made: ProgramGrantCreated;
  let followedId: string;
  const reportText = 'A distinctive narrative about the east tower guy wire';
  const personName = 'Quillon Example';

  /** The local app, which reads an http:// operator, as both organizations use it. */
  const call = (principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomBytes(8).toString('hex'),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  /** The read an operator's Ledger answers: no sign-in, the secret in the body. */
  const unsigned = (secret: string) => app.inject({ method: 'POST', url: '/v1/program-view', payload: { secret } });
  const plain = (response: { statusCode: number; json: () => any }) => {
    const { requestId: _requestId, ...rest } = response.json();
    return { status: response.statusCode, ...rest };
  };

  /** Holds an operator's schedule lease as a worker would, for one read. */
  async function leaseFor(tenant: CoverageTenant, operatorId: string): Promise<ProgramReadLease> {
    const leased = await tenant.admin.query(
      `UPDATE program_operator_schedules SET lease_owner='test-owner',lease_until=clock_timestamp()+interval '1 minute',
         generation=generation+1 WHERE tenant_id=$1 AND operator_id=$2 RETURNING generation`,
      [tenant.tenantId, operatorId],
    );
    return {
      tenant_id: tenant.tenantId,
      operator_id: operatorId,
      generation: String(leased.rows[0].generation),
      lease_owner: 'test-owner',
      worker_id: `${tenant.tenantId}:worker`,
    };
  }
  async function follow(name: string, at: string, secret: string): Promise<string> {
    const added = await call(owner.actor, 'POST', '/v1/program-operators', { name, address: at, secret });
    expect(added.statusCode, added.body).toBe(201);
    return added.json().operator.id;
  }
  const listed = async () => {
    const response = await call(owner.actor, 'GET', '/v1/program-operators');
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as ProgramOperatorList;
  };

  beforeAll(async () => {
    operator = await coverageTenant('program-operator');
    owner = await coverageTenant('program-owner');
    await operator.admin.query('UPDATE tenants SET name=$1 WHERE id=$2', ['Example Ridge Survey', operator.tenantId]);
    await owner.admin.query('UPDATE tenants SET name=$1 WHERE id=$2', ['Fictional Valley Power', owner.tenantId]);
    await operator.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      `${operator.tenantId}:person`,
      operator.tenantId,
      personName,
      'human',
      ['evidence:read'],
    ]);
    people = [`${operator.prefix}-PILOT-AVERY`, `${operator.prefix}-PILOT-BLAKE`];
    await operator.importRecords(
      'person.certificate',
      people.map((subjectId, index) => ({
        subjectId,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: `RP-DISTINCT-${index}`,
        recordedStatus: 'suspended',
      })),
    );
    await operator.adopt(getRulePackVersion(PACK, 2)!, 'active');
    await operator.settle();
    const reported = await operator.call(operator.actor, 'POST', '/v1/safety-reports', {
      whatWasSeen: reportText,
      named: false,
    });
    expect(reported.statusCode, reported.body).toBe(201);
    app = await createApp({ pool, env: 'local', objectStore: new MemoryObjectStore() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    address = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // Produced through this app, so its link opens the kept file here.
    const produced = await call(operator.operator, 'POST', '/v1/record-productions', {
      subjects: [{ kind: 'person', id: people[0] }],
      reason: `Asked for by ${personName}`,
      requestedBy: personName,
    });
    expect(produced.statusCode, produced.body).toBe(201);
    production = produced.json().record;
    standIn = createServer((request, response) => {
      const path = request.url ?? '';
      if (path.startsWith('/slow/')) setTimeout(() => response.end('{}'), 2_000);
      else if (path.startsWith('/big/')) {
        response.setHeader('content-type', 'application/json');
        response.write('{"version":"');
        response.end('x'.repeat(2 * 1_048_576) + '"}');
      } else if (path.startsWith('/redirect/'))
        response.writeHead(302, { location: `${address}/v1/program-view` }).end();
      else if (path.startsWith('/broken/')) response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      else response.writeHead(500).end('An internal error with private words');
    });
    await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
    standInAddress = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (operator && owner) await settleOwnedWork([operator.prefix, owner.prefix]);
    await app?.close();
    await new Promise((resolve) => (standIn ? standIn.close(resolve) : resolve(undefined)));
    await operator?.close();
    await owner?.close();
    await pool.end();
    await workers.end();
  });

  it('makes a grant whose secret is shown once and kept only as its hash', async () => {
    const response = await call(operator.actor, 'POST', '/v1/program-grants', {
      programOwner: 'Fictional Valley Power',
      packs: [PACK],
      openFindings: true,
      productions: [production.id],
    });
    expect(response.statusCode, response.body).toBe(201);
    made = response.json();
    expect(made.secret).toMatch(SECRET);
    expect(made.grant).toMatchObject({ state: 'in_force', programOwner: 'Fictional Valley Power', readCount: 0 });
    expect((Date.parse(made.grant.expiresAt) - Date.parse(made.grant.createdAt)) / 86_400_000).toBe(90);
    expect(made.grant.covers.packs.map((pack) => pack.packId)).toEqual([PACK]);
    expect(made.grant.covers.productions.map((set) => set.id)).toEqual([production.id]);

    const kept = await operator.admin.query('SELECT secret_sha256 FROM program_grants WHERE id=$1', [made.grant.id]);
    expect(kept.rows[0].secret_sha256).toBe(createHash('sha256').update(made.secret).digest('hex'));
    // The API's role cannot read the hash back, and the list never holds the secret.
    await expect(pool.query('SELECT secret_sha256 FROM program_grants LIMIT 1')).rejects.toThrow(/permission denied/);
    const list = await call(operator.actor, 'GET', '/v1/program-grants');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(made.secret);
    expect(list.body).not.toContain(kept.rows[0].secret_sha256);
    // The set's link ends with the grant.
    const link = await operator.admin.query(
      'SELECT expires_at,program_grant_id,note FROM record_production_links WHERE id=$1',
      [made.grant.covers.productions[0]!.linkId],
    );
    expect(link.rows[0]).toMatchObject({ program_grant_id: made.grant.id });
    expect(link.rows[0].expires_at.toISOString()).toBe(made.grant.expiresAt);
    // A retry of the same request cannot be shown the secret again; a grant of nothing is refused.
    const empty = await call(operator.actor, 'POST', '/v1/program-grants', {
      programOwner: 'Fictional Valley Power',
      packs: [],
      openFindings: false,
      productions: [],
    });
    expect(empty.json().error.code).toBe('program_grant_empty');
    const unknownPack = await call(operator.actor, 'POST', '/v1/program-grants', {
      programOwner: 'Fictional Valley Power',
      packs: ['example.not-adopted'],
      openFindings: false,
      productions: [],
    });
    expect(unknownPack.json().error.code).toBe('pack_not_adopted');
    // Only whoever manages authority makes one.
    const refused = await call(operator.operator, 'POST', '/v1/program-grants', {
      programOwner: 'Fictional Valley Power',
      packs: [],
      openFindings: true,
      productions: [],
    });
    expect(refused.statusCode).toBe(403);
  });

  it('answers counts only, and keeps each read with the parts read and nothing about who read it', async () => {
    const response = await unsigned(made.secret);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
    });
    const document = response.json() as ProgramViewDocument;
    expect(isProgramViewDocument(document)).toBe(true);
    expect(Object.keys(document).sort()).toEqual([
      'grantExpiresAt',
      'madeAt',
      'openFindings',
      'operator',
      'packs',
      'records',
      'version',
    ]);
    expect(document).toMatchObject({
      version: 'ledger.program-view.1',
      operator: { name: 'Example Ridge Survey' },
      grantExpiresAt: made.grant.expiresAt,
    });
    const pack = document.packs![0]!;
    expect(pack).toMatchObject({ packId: PACK, version: 2, mode: 'active' });
    const certificate = pack.rules.find((rule) => rule.ruleId === 'ledger.part107.107.12.b')!;
    // Counted by the same code as the Rules screen's coverage.
    const coverage = (await call(operator.actor, 'GET', '/v1/organization/coverage')).json();
    const adoption = coverage.adoptions.find((entry: any) => entry.pack.packId === PACK);
    const screen = (await call(operator.actor, 'GET', `/v1/organization/coverage/adoptions/${adoption.id}`)).json();
    const shown = screen.rules.find((rule: any) => rule.leafId === certificate.ruleId);
    expect(certificate).toEqual({
      ruleId: shown.leafId,
      title: shown.title,
      citation: shown.paragraph,
      checkedBy: shown.checkedBy,
      counts: shown.counts,
      complete: shown.complete,
    });
    expect(pack.rules).toHaveLength(screen.rules.length);
    expect(Object.keys(certificate).sort()).toEqual(['checkedBy', 'citation', 'complete', 'counts', 'ruleId', 'title']);
    const open = document.openFindings!.rules.find((rule) => rule.ruleId === 'ledger.part107.107.12.b')!;
    expect(open).toMatchObject({ packId: PACK, open: 2, oldestAgeDays: 0 });
    expect(document.openFindings!.total).toBeGreaterThanOrEqual(2);
    expect(document.records).toHaveLength(1);
    expect(Object.keys(document.records![0]!).sort()).toEqual(['expiresAt', 'producedAt', 'records', 'secret']);

    // The link it carries opens the set, as any link does.
    const set = await app.inject({
      method: 'POST',
      url: '/v1/shared-records',
      payload: { secret: document.records![0]!.secret },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().set.records).toBe(document.records![0]!.records);

    // Nothing names a subject, a person, a record's value or the safety report.
    const text = JSON.stringify(document);
    const names = (
      await operator.admin.query<{ name: string }>('SELECT name FROM principals WHERE tenant_id=$1', [
        operator.tenantId,
      ])
    ).rows.map((row) => row.name);
    for (const forbidden of [
      ...people,
      operator.prefix,
      operator.tenantId,
      personName,
      ...names,
      'RP-DISTINCT',
      reportText,
      'east tower',
      production.id,
      made.secret,
    ])
      expect(text, forbidden).not.toContain(forbidden);

    const reads = await operator.admin.query('SELECT * FROM program_grant_reads WHERE grant_id=$1', [made.grant.id]);
    expect(reads.rows).toHaveLength(1);
    expect(Object.keys(reads.rows[0]).sort()).toEqual(['grant_id', 'id', 'parts', 'read_at', 'tenant_id']);
    expect(reads.rows[0].parts).toEqual([`pack:${PACK}`, 'open_findings', `records:${production.id}`]);
    const grants = (await call(operator.actor, 'GET', '/v1/program-grants')).json().grants as ProgramGrant[];
    expect(grants.find((grant) => grant.id === made.grant.id)).toMatchObject({ readCount: 1 });
  });

  it('follows the operator, keeps its secret for the workers only, and keeps every answer', async () => {
    followedId = await follow('Ridge crews', address, made.secret);
    const before = await listed();
    expect(JSON.stringify(before)).not.toContain(made.secret);
    expect(before.operators.find((row) => row.id === followedId)).toMatchObject({
      state: 'not_read',
      lastRead: null,
      lastAnswer: null,
    });
    await expect(pool.query('SELECT secret FROM program_operators LIMIT 1')).rejects.toThrow(/permission denied/);
    // Outside a local Ledger an http:// address, or one on a private network, is refused.
    expect(await callProgramOperator(address, made.secret, { httpAddresses: false })).toMatchObject({
      outcome: 'failed',
      reason: expect.stringMatching(/https:\/\//),
    });
    expect(await callProgramOperator('https://10.0.0.7', made.secret, { httpAddresses: false })).toMatchObject({
      outcome: 'failed',
      reason: expect.stringMatching(/private network/),
    });

    expect(await readLeasedProgramOperator(workers, await leaseFor(owner, followedId), { httpAddresses: true })).toBe(
      true,
    );
    const after = (await listed()).operators.find((row) => row.id === followedId)!;
    expect(after.state).toBe('read');
    expect(after.lastAnswer!.document).toMatchObject({ operator: { name: 'Example Ridge Survey' } });
    expect(after.lastAnswer!.document.packs![0]!.packId).toBe(PACK);
    const kept = await owner.admin.query(
      'SELECT outcome,sha256,byte_length FROM program_operator_answers WHERE operator_id=$1',
      [followedId],
    );
    expect(kept.rows).toEqual([
      { outcome: 'answered', sha256: after.lastAnswer!.sha256, byte_length: expect.any(Number) },
    ]);
    // A worker that lost its lease keeps nothing.
    const lost = { ...(await leaseFor(owner, followedId)), generation: '0' };
    expect(await readLeasedProgramOperator(workers, lost, { httpAddresses: true })).toBe(false);
    // A fresh read falls due now.
    const asked = await call(owner.actor, 'POST', `/v1/program-operators/${followedId}/read`);
    expect(asked.statusCode, asked.body).toBe(202);
    await owner.admin.query(
      'UPDATE program_operator_schedules SET lease_owner=NULL,lease_until=NULL WHERE operator_id=$1',
      [followedId],
    );
    const due = await owner.admin.query(
      'SELECT available_at<=clock_timestamp() AS due FROM program_operator_schedules WHERE operator_id=$1',
      [followedId],
    );
    expect(due.rows[0].due).toBe(true);
  });

  it('records a slow, failing, oversized or redirecting operator as a failure in its own words', async () => {
    const options = { httpAddresses: true, timeoutMs: 500 };
    const outcomes = {
      slow: await callProgramOperator(`${standInAddress}/slow`, made.secret, options),
      big: await callProgramOperator(`${standInAddress}/big`, made.secret, options),
      redirect: await callProgramOperator(`${standInAddress}/redirect`, made.secret, options),
      broken: await callProgramOperator(`${standInAddress}/broken`, made.secret, options),
      failing: await callProgramOperator(`${standInAddress}/failing`, made.secret, options),
    };
    expect(outcomes).toEqual({
      slow: { outcome: 'failed', reason: 'The operator’s Ledger did not answer within 1 seconds' },
      big: { outcome: 'failed', reason: 'The answer was larger than 1024 KiB, so it was not kept' },
      redirect: { outcome: 'failed', reason: 'The operator’s Ledger answered with a redirect, which is not followed' },
      broken: { outcome: 'failed', reason: 'The answer is not a program view this Ledger reads' },
      failing: { outcome: 'failed', reason: 'The operator’s Ledger answered 500' },
    });
    // Through the worker: the failure is kept, and the row says so with the last answer.
    const failingId = await follow('Alpha Dispatch crews', `${standInAddress}/failing`, made.secret);
    expect(await readLeasedProgramOperator(workers, await leaseFor(owner, failingId), { httpAddresses: true })).toBe(
      true,
    );
    const row = (await listed()).operators.find((entry) => entry.id === failingId)!;
    expect(row).toMatchObject({
      state: 'failed',
      lastRead: { outcome: 'failed', reason: 'The operator’s Ledger answered 500' },
      lastAnswer: null,
    });
    expect(JSON.stringify(row)).not.toContain('private words');
    // Alphabetical by the program owner's own names.
    expect((await listed()).operators.map((entry) => entry.name)).toEqual(['Alpha Dispatch crews', 'Ridge crews']);
  });

  it('answers an unknown, expired or revoked secret alike', async () => {
    const unknown = plain(await unsigned(`ledger-program-${randomBytes(32).toString('base64url')}`));
    expect(unknown).toEqual({
      status: 404,
      error: {
        code: 'program_grant_not_in_use',
        message: 'This grant opens nothing. It may have expired or been revoked.',
      },
    });
    const expiredSecret = `ledger-program-${randomBytes(32).toString('base64url')}`;
    await operator.admin.query(
      `INSERT INTO program_grants(id,tenant_id,program_owner,secret_sha256,packs,open_findings,create_event_id,created_by,
         created_at,expires_at)
       SELECT 'program-grant-expired-'||$1,tenant_id,'Fictional Valley Power',$2,'{}',true,create_event_id,created_by,
         clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day' FROM program_grants WHERE id=$3`,
      [operator.prefix, createHash('sha256').update(expiredSecret).digest('hex'), made.grant.id],
    );
    expect(plain(await unsigned(expiredSecret))).toEqual(unknown);
    const malformed = await unsigned('not a secret');
    expect(plain(malformed)).toEqual(unknown);

    const revoked = await call(operator.actor, 'POST', `/v1/program-grants/${made.grant.id}/revoke`, {
      reason: 'The contract ended',
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().grant).toMatchObject({ state: 'revoked', revokeReason: 'The contract ended' });
    expect(plain(await unsigned(made.secret))).toEqual(unknown);
    const again = await call(operator.actor, 'POST', `/v1/program-grants/${made.grant.id}/revoke`, { reason: 'Twice' });
    expect(again.statusCode).toBe(409);
    // Its link ends with it.
    const link = await operator.admin.query(
      'SELECT revoked_at FROM record_production_links WHERE program_grant_id=$1',
      [made.grant.id],
    );
    expect(link.rows[0].revoked_at).not.toBeNull();
    // No read was kept for any of these.
    const reads = await operator.admin.query('SELECT count(*) FROM program_grant_reads WHERE tenant_id=$1', [
      operator.tenantId,
    ]);
    expect(Number(reads.rows[0].count)).toBe(2);

    // The program owner's row says the grant ended and shows the last answer with its date.
    await owner.admin.query(
      "UPDATE program_operator_schedules SET available_at=clock_timestamp()-interval '1 second' WHERE operator_id=$1",
      [followedId],
    );
    expect(await readLeasedProgramOperator(workers, await leaseFor(owner, followedId), { httpAddresses: true })).toBe(
      true,
    );
    const row = (await listed()).operators.find((entry) => entry.id === followedId)!;
    expect(row.state).toBe('ended');
    expect(row.lastRead).toMatchObject({ outcome: 'not_in_use' });
    expect(row.lastAnswer?.document.operator.name).toBe('Example Ridge Survey');
    const answers = (
      await call(owner.actor, 'GET', `/v1/program-operators/${followedId}/answers`)
    ).json() as ProgramOperatorAnswers;
    expect(answers.answers.map((answer) => answer.outcome)).toEqual(['not_in_use', 'answered']);
  });

  it('removes an operator with who and why, erases its secret, keeps its answers and reads it no more', async () => {
    const removed = await call(owner.actor, 'POST', `/v1/program-operators/${followedId}/remove`, {
      reason: 'The contract ended',
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const kept = await owner.admin.query('SELECT secret,removed_by,remove_reason FROM program_operators WHERE id=$1', [
      followedId,
    ]);
    expect(kept.rows[0]).toEqual({ secret: null, removed_by: owner.actor.id, remove_reason: 'The contract ended' });
    const list = await listed();
    expect(list.operators.map((entry) => entry.id)).not.toContain(followedId);
    expect(list.removed[0]).toMatchObject({ id: followedId, removedBy: { id: owner.actor.id } });
    const answers = await owner.admin.query('SELECT count(*) FROM program_operator_answers WHERE operator_id=$1', [
      followedId,
    ]);
    expect(Number(answers.rows[0].count)).toBe(2);
    const leased = await workers.query("SELECT * FROM ledger_lease_program_reads('test-owner-removed',100,60)");
    expect(leased.rows.map((row) => row.operator_id)).not.toContain(followedId);
    await owner.admin.query(
      'UPDATE program_operator_schedules SET lease_owner=NULL,lease_until=NULL WHERE tenant_id=$1',
      [owner.tenantId],
    );
  });

  it('keeps each organization’s grants, reads, operators and answers to itself', async () => {
    const operatorGrants = (await call(owner.actor, 'GET', '/v1/program-grants')).json().grants as ProgramGrant[];
    expect(operatorGrants).toEqual([]);
    expect(
      (await call(owner.actor, 'POST', `/v1/program-grants/${made.grant.id}/revoke`, { reason: 'No' })).statusCode,
    ).toBe(404);
    expect((await call(operator.actor, 'GET', '/v1/program-operators')).json().operators).toEqual([]);
    expect((await call(operator.actor, 'GET', `/v1/program-operators/${followedId}/answers`)).statusCode).toBe(404);
    const client = await pool.connect();
    try {
      for (const [table, tenant] of [
        ['program_grants', operator],
        ['program_grant_reads', operator],
        ['program_operators', owner],
        ['program_operator_schedules', owner],
        ['program_operator_answers', owner],
      ] as const) {
        const other = tenant === operator ? owner : operator;
        await client.query('BEGIN');
        await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [other.tenantId]);
        const seen = await client.query(`SELECT count(tenant_id) AS count FROM ${table} WHERE tenant_id=$1`, [
          tenant.tenantId,
        ]);
        expect(Number(seen.rows[0].count), table).toBe(0);
        await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [tenant.tenantId]);
        const own = await client.query(`SELECT count(tenant_id) AS count FROM ${table} WHERE tenant_id=$1`, [
          tenant.tenantId,
        ]);
        expect(Number(own.rows[0].count), table).toBeGreaterThan(0);
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });
});
