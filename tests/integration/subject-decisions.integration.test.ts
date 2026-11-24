import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, type WorkLease } from '../../apps/workers/src/index.js';
import { leaseExpired, projectOwnedWork, settleOwnedWork } from './worker-queue.js';
import type {
  Capability,
  OrganizationCoverageResponse,
  OrganizationDecisionCommand,
  OrganizationDecisionsResponse,
  PackAdoptionRecord,
  RulePackVersion,
  SubjectDecisionAcceptance,
  SubjectEvidenceBundle,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { OrganizationDecisionsResponseSchema } from '../../packages/contracts/src/openapi.js';
import { adoptShownPack, reviewShownAdoption } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { BundleVerificationError, verifyBundle } from '../../tools/verifier/index.mjs';

interface Fixture {
  actor: AuthContext;
  worker: AuthContext;
  token: string;
  readerToken: string;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL organization review evidence', () => {
  const prefix = `subject-review-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const capabilities: Capability[] = [
    'flight:read',
    'flight:create',
    'decision:write',
    'authority:write',
    'evidence:read',
    'pack:adopt',
  ];
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validateHistory = ajv.compile(OrganizationDecisionsResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });
  async function fixture(name: string): Promise<Fixture> {
    const tenantId = `${prefix}:${name}`;
    const actor: AuthContext = {
      id: `${tenantId}:actor`,
      tenantId,
      name: 'Fictional organization reviewer',
      kind: 'human',
      revision: 1,
      capabilities,
    };
    const worker: AuthContext = { ...actor, id: `${tenantId}:worker`, kind: 'worker', name: 'Fictional review worker' };
    const reader = { ...actor, id: `${tenantId}:reader`, capabilities: ['flight:read'] };
    const token = `ledger-dev-${tenantId}:actor`;
    const readerToken = `ledger-dev-${tenantId}:reader`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name}`]);
    for (const principal of [actor, worker, reader])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
    for (const [credential, principalId] of [
      [token, actor.id],
      [readerToken, reader.id],
    ])
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(credential),
        principalId,
      ]);
    return { actor, worker, token, readerToken };
  }
  function call(
    f: Fixture,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    key: string = randomUUID(),
    token = f.token,
  ) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload });
  }
  async function coverage(f: Fixture): Promise<OrganizationCoverageResponse> {
    const response = await call(f, 'GET', '/v1/organization/coverage');
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function history(f: Fixture): Promise<OrganizationDecisionsResponse> {
    const response = await call(f, 'GET', '/v1/organization/decisions');
    expect(response.statusCode, response.body).toBe(200);
    expect(validateHistory(response.json()), JSON.stringify(validateHistory.errors)).toBe(true);
    expect(response.json().meta.requestId).toBe(response.headers['x-request-id']);
    return response.json();
  }
  async function adopt(f: Fixture, future = false): Promise<PackAdoptionRecord> {
    const response = await call(f, 'GET', '/v1/rule-packs/ledger.part108-nprm/versions/1');
    expect(response.statusCode, response.body).toBe(200);
    const pack = response.json().pack as RulePackVersion;
    const now = Date.now();
    const interval = future
      ? { start: new Date(now + 86_400_000).toISOString(), end: new Date(now + 172_800_000).toISOString() }
      : { start: new Date(now - 60_000).toISOString(), end: new Date(now + 60_000).toISOString() };
    const command = adoptShownPack(
      await coverage(f),
      pack,
      interval,
      'Adopt the exact draft for fictional review.',
      'shadow',
    );
    const accepted = await call(f, 'POST', '/v1/commands', command);
    expect(accepted.statusCode, accepted.body).toBe(201);
    return (await coverage(f)).adoptions.find((adoption) => adoption.id === accepted.json().command.id)!;
  }
  async function draft(f: Fixture, adoption: PackAdoptionRecord): Promise<OrganizationDecisionCommand> {
    return reviewShownAdoption(
      await history(f),
      adoption,
      'Reviewed this exact adoption and its retained proposed source.',
    );
  }
  async function accept(f: Fixture, command: OrganizationDecisionCommand, key: string = randomUUID()) {
    const response = await call(f, 'POST', '/v1/commands', command, key);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().command).not.toHaveProperty('flightId');
    expect(response.json().meta.effectId).toBe(response.json().command.id);
    expect(response.json().meta.inputCut.basisRevision).toBe(command.expectedRevision + 1);
    return response.json().command.id as string;
  }
  async function lease(f: Fixture, eventId?: string, leaseSeconds = 30): Promise<WorkLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const task = (
        await client.query<WorkLease>(
          `SELECT w.* FROM work_items w WHERE (w.state='pending' OR (w.state='leased' AND w.lease_until<clock_timestamp()))
         AND w.available_at<=clock_timestamp() AND ($1::text IS NULL OR w.event_id=$1)
         AND NOT EXISTS(SELECT 1 FROM work_items previous WHERE previous.stream_id=w.stream_id AND previous.stream_sequence<w.stream_sequence AND previous.state NOT IN ('completed','failed'))
         ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE`,
          [eventId ?? null],
        )
      ).rows[0];
      if (!task) return null;
      const row = (
        await client.query<WorkLease>(
          "UPDATE work_items SET state='leased',lease_owner=$1,generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>$3::double precision) WHERE id=$2 RETURNING *",
          [prefix, task.id, leaseSeconds],
        )
      ).rows[0];
      return { ...row, worker_id: f.worker.id };
    });
  }
  async function drain(f: Fixture) {
    await projectOwnedWork(admin, workerPool, [f.worker.tenantId]);
  }

  it('records only an exact adoption citation and preserves its acceptance through projection', async () => {
    const f = await fixture('citation');
    const adoption = await adopt(f);
    await drain(f);
    const command = await draft(f, adoption);
    for (const citation of [
      { ...command.adoption, acceptedRevision: adoption.acceptedRevision + 1 },
      { ...command.adoption, pack: { ...command.adoption.pack, digest: '0'.repeat(64) } },
    ]) {
      const rejected = await call(f, 'POST', '/v1/commands', { ...command, adoption: citation });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().error.code).toBe('invalid_adoption_reference');
    }
    const id = await accept(f, command);
    const pending = await history(f);
    expect(pending.organization).toMatchObject({ revision: 2, projectedRevision: 1 });
    expect(pending.decisions[0]).toMatchObject({
      id,
      subject: { kind: 'organization', id: pending.organization.id },
      adoption: command.adoption,
      acceptedRevision: 2,
      acceptedBasisRevision: 1,
      processing: { status: 'pending' },
    });
    expect(canonicalDigest(pending.decisions[0].basisManifest)).toBe(pending.decisions[0].dependencyBasis);
    expect((await admin.query('SELECT id FROM receipts WHERE event_id=$1', [id])).rowCount).toBe(0);
    await drain(f);
    const projected = await history(f);
    expect(projected.organization.projectedRevision).toBe(2);
    expect(projected.decisions[0]).toEqual({ ...pending.decisions[0], processing: { status: 'projected' } });
    expect((await coverage(f)).adoptions[0].coverage).toEqual(adoption.coverage);
  });

  it('rejects stale pending organization evidence while replaying an identical review exactly once', async () => {
    const f = await fixture('pending');
    const adoption = await adopt(f);
    await drain(f);
    const staleDraft = await draft(f, adoption);
    await adopt(f, true);
    const moved = await call(f, 'POST', '/v1/commands', staleDraft);
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json().error.code).toBe('stale_basis');
    const command = await draft(f, adoption);
    const key = randomUUID();
    const retries = await Promise.all([
      call(f, 'POST', '/v1/commands', command, key),
      call(f, 'POST', '/v1/commands', command, key),
    ]);
    for (const response of retries) expect(response.statusCode, response.body).toBe(201);
    expect(retries[0].json().command.id).toBe(retries[1].json().command.id);
    const changed = await call(
      f,
      'POST',
      '/v1/commands',
      { ...command, decision: { ...command.decision, note: 'Different review intent' } },
      key,
    );
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('idempotency_conflict');
    const pending = await history(f);
    expect(pending.decisions).toHaveLength(1);
    expect(pending.decisions[0].acceptedInputCut.streams).not.toEqual(pending.decisions[0].renderedInputCut.streams);
    const competing = await draft(f, adoption);
    const raced = await Promise.all([
      call(f, 'POST', '/v1/commands', competing, randomUUID()),
      call(f, 'POST', '/v1/commands', competing, randomUUID()),
    ]);
    expect(raced.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(raced.find((response) => response.statusCode === 409)!.json().error.code).toBe('stale_basis');
    expect((await history(f)).decisions).toHaveLength(2);
    const beforeProjection = await draft(f, adoption);
    await drain(f);
    const changedProjection = await call(f, 'POST', '/v1/commands', beforeProjection);
    expect(changedProjection.statusCode, changedProjection.body).toBe(409);
    expect(changedProjection.json().error.code).toBe('stale_basis');
  });

  it('isolates review history and retains the acceptance-time reviewer after authority changes', async () => {
    const f = await fixture('authority');
    const other = await fixture('foreign');
    const adoption = await adopt(f);
    await drain(f);
    const command = await draft(f, adoption);
    const denied = await call(f, 'POST', '/v1/commands', command, randomUUID(), f.readerToken);
    expect(denied.statusCode, denied.body).toBe(403);
    const foreign = reviewShownAdoption(await history(other), adoption, 'This citation belongs to another tenant.');
    const outside = await call(other, 'POST', '/v1/commands', foreign);
    expect(outside.statusCode, outside.body).toBe(404);
    expect(outside.json().error.code).toBe('adoption_not_found');
    const id = await accept(f, command);
    const original = (
      await admin.query<{ record: SubjectDecisionAcceptance }>('SELECT record FROM decisions WHERE id=$1', [id])
    ).rows[0].record;
    expect(original.actor).toEqual({
      id: f.actor.id,
      name: f.actor.name,
      kind: 'human',
      principalRevision: 1,
      capabilities,
      checkedCapabilities: ['decision:write'],
      policyVersion: 'ledger.organization-review-authority.1',
      historicalProfile: 'retained',
      scope: original.subject,
    });
    const changed = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: f.actor.id,
      expectedRevision: 1,
      capabilities: capabilities.filter((capability) => capability !== 'decision:write'),
    });
    expect(changed.statusCode, changed.body).toBe(201);
    await drain(f);
    expect((await history(f)).decisions[0].actor).toEqual(original.actor);
    expect((await history(other)).decisions).toEqual([]);
    expect(
      (await admin.query<{ record: SubjectDecisionAcceptance }>('SELECT record FROM decisions WHERE id=$1', [id]))
        .rows[0].record,
    ).toEqual(original);
  });

  it('rolls back review projection under a stale or expired worker lease', async () => {
    const f = await fixture('fence');
    const adoption = await adopt(f);
    await drain(f);
    const id = await accept(f, await draft(f, adoption));
    const work = (await lease(f, id, 2))!;
    expect(await processLease(workerPool, { ...work, generation: String(Number(work.generation) - 1) })).toBe(false);
    await expect(
      processLease(workerPool, work, { beforeCommit: () => leaseExpired(admin, 'work_items', work.id) }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    const pending = await history(f);
    expect(pending.organization.projectedRevision).toBe(1);
    expect(pending.decisions[0].processing.status).toBe('pending');
    expect((await admin.query('SELECT id FROM organization_decision_views WHERE id=$1', [id])).rowCount).toBe(0);
    const fresh = (await lease(f, id))!;
    expect(await processLease(workerPool, work)).toBe(false);
    expect(await processLease(workerPool, fresh)).toBe(true);
    expect((await history(f)).decisions[0].processing.status).toBe('projected');
  });

  it('exports a pinned v2 review with offline source bytes while keeping organization and flight exports separate', async () => {
    const f = await fixture('evidence');
    const other = await fixture('export-foreign');
    const adoption = await adopt(f);
    expect(adoption.processing.status).toBe('pending');
    const id = await accept(f, await draft(f, adoption));
    const pending = await history(f);
    expect(pending.organization).toMatchObject({ revision: 2, projectedRevision: 0 });
    const reviewed = pending.decisions[0];
    expect(reviewed.processing.status).toBe('pending');
    expect(reviewed.acceptedInputCut.streams).not.toEqual(reviewed.renderedInputCut.streams);
    await adopt(f, true);
    const authority = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: f.actor.id,
      expectedRevision: 1,
      capabilities: capabilities.filter((capability) => capability !== 'decision:write'),
    });
    expect(authority.statusCode, authority.body).toBe(201);
    const payload = { subject: { kind: 'organization' }, decisionId: id, scope: 'whole_tenant_prefixes' };
    const key = randomUUID();
    const issued = await call(f, 'POST', '/v1/subject-exports', payload, key);
    expect(issued.statusCode, issued.body).toBe(201);
    const record = issued.json().record;
    const replay = await call(f, 'POST', '/v1/subject-exports', payload, key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().record).toEqual(record);
    const listed = await call(f, 'GET', `/v1/subject-exports?decisionId=${id}`);
    expect(listed.json().records.map((item: { id: string }) => item.id)).toEqual([record.id]);
    expect((await call(f, 'GET', `/v1/subject-exports/${record.id}`)).json().record).toEqual(record);
    const content = await call(f, 'GET', `/v1/subject-exports/${record.id}/content`);
    expect(content.statusCode, content.body.slice(0, 200)).toBe(200);
    expect(sha256(content.rawPayload)).toBe(record.bundleSha256);
    expect(content.headers['x-manifest-sha256']).toBe(record.manifestDigest);
    const bundle = content.json<SubjectEvidenceBundle>();
    expect(bundle.format).toBe('ledger.subject-evidence.2');
    expect(bundle.decision).toEqual((({ processing, ...acceptance }) => acceptance)(reviewed));
    expect(bundle.actor).toEqual(reviewed.actor);
    expect(bundle.adoption.id).toBe(adoption.id);
    expect(bundle.adoption.pack).toEqual(adoption.pack);
    expect(verifyBundle(bundle, { expectedManifestDigest: record.manifestDigest }).status).toBe('verified');
    expect(bundle.ruleSources).toHaveLength(1);
    expect(sha256(Buffer.from(bundle.ruleSources[0].bytesBase64, 'base64'))).toBe(bundle.ruleSources[0].sha256);
    const changedCitation = structuredClone(bundle);
    changedCitation.decision.adoption.pack.digest = '0'.repeat(64);
    expect(() => verifyBundle(changedCitation, { expectedManifestDigest: record.manifestDigest })).toThrow(
      BundleVerificationError,
    );
    const changedSource = structuredClone(bundle);
    changedSource.ruleSources[0].bytesBase64 = Buffer.from('Different retained source').toString('base64');
    expect(() => verifyBundle(changedSource, { expectedManifestDigest: record.manifestDigest })).toThrow(
      BundleVerificationError,
    );
    expect((await call(other, 'GET', `/v1/subject-exports/${record.id}`)).statusCode).toBe(404);
    expect((await call(other, 'GET', `/v1/subject-exports/${record.id}/content`)).statusCode).toBe(404);
    expect((await call(other, 'GET', '/v1/subject-exports')).json().records).toEqual([]);
    expect((await call(f, 'GET', `/v1/exports/${record.id}`)).statusCode).toBe(404);
    expect((await call(f, 'GET', `/v1/exports/${record.id}/content`)).statusCode).toBe(404);
    expect((await call(f, 'GET', '/v1/exports')).json().records).toEqual([]);

    const created = await call(f, 'POST', '/v1/flights', {
      originationKey: `${prefix}:legacy-export`,
      label: 'Legacy flight review compatibility',
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id;
    await drain(f);
    const timeline = (await call(f, 'GET', `/v1/flights/${flightId}/timeline`)).json<TimelineResponse>();
    const decision = await call(
      f,
      'POST',
      '/v1/commands',
      {
        kind: 'decision.record',
        flightId,
        expectedRevision: timeline.flight.revision,
        expectedBasisRevision: timeline.flight.basisRevision,
        inputCut: timeline.meta.inputCut,
        expectedDependencyBasis: timeline.meta.dependencyBasis!,
        decision: { kind: 'reviewed', note: 'Ordinary flight review still uses its original contract.' },
      },
      randomUUID(),
      f.readerToken,
    );
    expect(decision.statusCode).toBe(403);
    const restored = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: f.actor.id,
      expectedRevision: 2,
      capabilities,
    });
    expect(restored.statusCode, restored.body).toBe(201);
    await drain(f);
    const current = (await call(f, 'GET', `/v1/flights/${flightId}/timeline`)).json<TimelineResponse>();
    const legacyDecision = await call(f, 'POST', '/v1/commands', {
      kind: 'decision.record',
      flightId,
      expectedRevision: current.flight.revision,
      expectedBasisRevision: current.flight.basisRevision,
      inputCut: current.meta.inputCut,
      expectedDependencyBasis: current.meta.dependencyBasis!,
      decision: { kind: 'reviewed', note: 'Ordinary flight review still uses its original contract.' },
    });
    expect(legacyDecision.statusCode, legacyDecision.body).toBe(201);
    await drain(f);
    const legacyExport = await call(f, 'POST', '/v1/exports', {
      flightId,
      decisionId: legacyDecision.json().command.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(legacyExport.statusCode, legacyExport.body).toBe(201);
    const legacyContent = await call(f, 'GET', `/v1/exports/${legacyExport.json().record.id}/content`);
    expect(legacyContent.statusCode, legacyContent.body.slice(0, 200)).toBe(200);
    expect(legacyContent.json().format).toBe('ledger.flight-evidence.2');
    expect(
      verifyBundle(legacyContent.json(), { expectedManifestDigest: legacyExport.json().record.manifestDigest }).status,
    ).toBe('verified');
    expect((await call(f, 'GET', `/v1/subject-exports/${legacyExport.json().record.id}`)).statusCode).toBe(404);
    expect((await call(f, 'GET', '/v1/subject-exports')).json().records.map((item: { id: string }) => item.id)).toEqual(
      [record.id],
    );
    expect((await call(f, 'GET', '/v1/exports')).json().records.map((item: { id: string }) => item.id)).toEqual([
      legacyExport.json().record.id,
    ]);
  });
});
