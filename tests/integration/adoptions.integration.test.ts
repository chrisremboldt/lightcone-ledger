import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { processLease, type WorkLease } from '../../apps/workers/src/index.js';
import type {
  Capability,
  OrganizationCoverageResponse,
  PackAdoptionAcceptance,
  PackAdoptionCommand,
  RulePackVersion,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { OrganizationCoverageResponseSchema } from '../../packages/contracts/src/openapi.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { adoptRulePack, SeedAdoptionConflict } from '../../apps/api/src/seed-rule-packs.js';
import { getOrganizationCoverage, organization } from '../../packages/domain/src/adoptions.js';
import { getOrganizationDecisions } from '../../packages/domain/src/organization-decisions.js';
import { acceptCommand } from '../../packages/domain/src/index.js';
import { leaseExpired, lockWaitStarted, projectOwnedWork, settleOwnedWork } from './worker-queue.js';

interface Fixture {
  actor: AuthContext;
  worker: AuthContext;
  token: string;
  restrictedToken: string;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL organization pack adoption', () => {
  const prefix = `adoption-${randomUUID()}`;
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
  let app: Awaited<ReturnType<typeof createApp>>;
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validateCoverage = ajv.compile(OrganizationCoverageResponseSchema);

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
      name: 'Fictional adoption owner',
      kind: 'human',
      revision: 1,
      capabilities,
    };
    const worker: AuthContext = {
      ...actor,
      id: `${tenantId}:worker`,
      kind: 'worker',
      name: 'Fictional adoption worker',
    };
    const restricted = { ...actor, id: `${tenantId}:reader`, capabilities: ['flight:read'] };
    const token = `ledger-dev-${tenantId}:actor`;
    const restrictedToken = `ledger-dev-${tenantId}:reader`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name}`]);
    for (const principal of [actor, worker, restricted])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
    for (const [credential, principalId] of [
      [token, actor.id],
      [restrictedToken, restricted.id],
    ])
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(credential),
        principalId,
      ]);
    return { actor, worker, token, restrictedToken };
  }

  function call(
    f: Fixture,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    key = randomUUID(),
    token = f.token,
  ) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload });
  }
  async function coverage(f: Fixture): Promise<OrganizationCoverageResponse> {
    const response = await call(f, 'GET', '/v1/organization/coverage');
    expect(response.statusCode, response.body).toBe(200);
    expect(validateCoverage(response.json()), JSON.stringify(validateCoverage.errors)).toBe(true);
    expect(response.json().meta.requestId).toBe(response.headers['x-request-id']);
    return response.json();
  }
  async function pack(f: Fixture, packId = 'ledger.part108-nprm', version = 1): Promise<RulePackVersion> {
    const response = await call(f, 'GET', `/v1/rule-packs/${packId}/versions/${version}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().pack;
  }
  function interval(startOffset: number, endOffset: number) {
    const now = Date.now();
    return { start: new Date(now + startOffset).toISOString(), end: new Date(now + endOffset).toISOString() };
  }
  async function draft(
    f: Fixture,
    effectiveInterval = interval(-60_000, 60_000),
    suppliedPack?: RulePackVersion,
  ): Promise<PackAdoptionCommand> {
    const displayed = await coverage(f);
    const retained = suppliedPack ?? (await pack(f));
    return adoptShownPack(
      displayed,
      retained,
      effectiveInterval,
      'Adopt this exact proposed pack for the fictional organization review.',
      retained.leaves.some((leaf) => leaf.source.kind === 'proposed_regulation') ? 'shadow' : 'active',
    );
  }
  async function accept(f: Fixture, command: PackAdoptionCommand, key = randomUUID()) {
    const response = await call(f, 'POST', '/v1/commands', command, key);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().command).not.toHaveProperty('flightId');
    expect(response.json().meta.effectId).toBe(response.json().command.id);
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

  it('accepts an exact organization basis and derives adoption dates only after fenced projection', async () => {
    const f = await fixture('states');
    const retained = await pack(f);
    const scheduled = await accept(f, await draft(f, interval(86_400_000, 172_800_000)));
    const pending = await coverage(f);
    expect(pending.organization).toMatchObject({ revision: 1, projectedRevision: 0 });
    expect(pending.meta.inputCut.basisRevision).toBe(1);
    expect((await admin.query('SELECT id FROM receipts WHERE event_id=$1', [scheduled])).rowCount).toBe(0);
    expect(pending.adoptions[0]).toMatchObject({
      id: scheduled,
      state: 'pending',
      processing: { status: 'pending' },
      pack: retained,
    });
    await drain(f);
    const current = await accept(f, await draft(f, interval(-60_000, 60_000)));
    const expired = await accept(f, await draft(f, interval(-172_800_000, -86_400_000)));
    await drain(f);
    const projected = await coverage(f);
    expect(projected.organization).toMatchObject({ revision: 3, projectedRevision: 3 });
    expect(projected.adoptions[0].id).toBe(current);
    expect(projected.adoptions.find((adoption) => adoption.id === scheduled)?.state).toBe('scheduled');
    expect(projected.adoptions.find((adoption) => adoption.id === current)?.state).toBe('effective');
    expect(projected.adoptions.find((adoption) => adoption.id === expired)?.state).toBe('expired');
    const acceptedWhilePending = projected.adoptions.find((adoption) => adoption.id === expired)!;
    expect(acceptedWhilePending.acceptedInputCut.streams).not.toEqual(acceptedWhilePending.renderedInputCut.streams);
    for (const adoption of projected.adoptions) {
      expect(adoption.processing.status).toBe('projected');
      expect(adoption.scope).toEqual({ kind: 'organization', organizationId: projected.organization.id });
      expect(adoption.coverage).toEqual(
        retained.leaves.map((leaf) => ({
          leafId: leaf.id,
          coverage: leaf.coverage,
          evidenceState: leaf.coverage === 'manual' ? 'manual_review_required' : 'unsupported',
        })),
      );
    }
    const companyPack = await pack(f, 'ledger.demo-procedures', 2);
    const inactiveId = await accept(f, await draft(f, interval(-60_000, 60_000), companyPack));
    await drain(f);
    const inactive = (await coverage(f)).adoptions.find((adoption) => adoption.id === inactiveId)!;
    expect(inactive.coverage).toEqual(
      companyPack.leaves.map((leaf) => ({ leafId: leaf.id, coverage: 'automated', evidenceState: 'inactive' })),
    );
  });

  it('replays the same command while pending and rejects stale bases, changed content and overlapping acceptance', async () => {
    const f = await fixture('basis');
    const command = await draft(f);
    const key = randomUUID();
    const [accepted, replayed] = await Promise.all([accept(f, command, key), accept(f, command, key)]);
    expect(replayed).toBe(accepted);
    const reused = await call(f, 'POST', '/v1/commands', { ...command, note: 'Different intended adoption' }, key);
    expect(reused.statusCode, reused.body).toBe(409);
    expect(reused.json().error.code).toBe('idempotency_conflict');
    const fresh = await draft(f, command.effectiveInterval);
    for (const override of [
      { expectedRevision: command.expectedRevision },
      { inputCut: { ...fresh.inputCut, streams: { ...fresh.inputCut.streams, 'unseen-stream': 1 } } },
      { expectedDependencyBasis: '0'.repeat(64) },
    ]) {
      const stale = await call(f, 'POST', '/v1/commands', { ...fresh, ...override });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error.code).toBe('stale_basis');
    }
    const overlap = await call(f, 'POST', '/v1/commands', fresh);
    expect(overlap.statusCode, overlap.body).toBe(409);
    expect(overlap.json().error.code).toBe('adoption_interval_overlap');
    const changedPack = await call(f, 'POST', '/v1/commands', {
      ...fresh,
      pack: { ...fresh.pack, digest: '0'.repeat(64) },
    });
    expect(changedPack.statusCode, changedPack.body).toBe(400);
    expect(changedPack.json().error.code).toBe('invalid_pack_reference');
    expect((await coverage(f)).adoptions).toHaveLength(1);
    const raced = await draft(f, interval(86_400_000, 172_800_000));
    const competing = await Promise.all([
      call(f, 'POST', '/v1/commands', raced),
      call(f, 'POST', '/v1/commands', raced),
    ]);
    expect(competing.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(competing.find((response) => response.statusCode === 409)!.json().error.code).toBe('stale_basis');
    await drain(f);
  });

  it('isolates tenant organizations and retains the full adoption authority after the actor changes', async () => {
    const f = await fixture('authority');
    const other = await fixture('other-tenant');
    const command = await draft(f);
    const denied = await call(f, 'POST', '/v1/commands', command, randomUUID(), f.restrictedToken);
    expect(denied.statusCode, denied.body).toBe(403);
    const id = await accept(f, command);
    const original = (
      await admin.query<{ record: PackAdoptionAcceptance }>(
        'SELECT record FROM organization_pack_adoptions WHERE id=$1',
        [id],
      )
    ).rows[0].record;
    expect(original.actor).toEqual({
      id: f.actor.id,
      name: f.actor.name,
      kind: 'human',
      principalRevision: 1,
      capabilities,
      checkedCapabilities: ['pack:adopt'],
      policyVersion: 'ledger.pack-adoption-authority.1',
    });
    await expect(admin.query('UPDATE organization_pack_adoptions SET record=record WHERE id=$1', [id])).rejects.toThrow(
      /append-only|immutable/i,
    );
    const foreign = await coverage(other);
    expect(foreign.adoptions).toEqual([]);
    expect(foreign.organization.id).not.toBe(original.organizationId);
    expect(
      await withScope(
        pool,
        other.actor,
        async (client) => (await client.query('SELECT id FROM organization_pack_adoptions WHERE id=$1', [id])).rowCount,
      ),
    ).toBe(0);
    const changed = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: f.actor.id,
      expectedRevision: 1,
      capabilities: capabilities.filter((capability) => capability !== 'pack:adopt'),
    });
    expect(changed.statusCode, changed.body).toBe(201);
    await drain(f);
    const after = (await coverage(f)).adoptions.find((adoption) => adoption.id === id)!;
    expect(after.actor).toEqual(original.actor);
    expect(
      (
        await admin.query<{ record: PackAdoptionAcceptance }>(
          'SELECT record FROM organization_pack_adoptions WHERE id=$1',
          [id],
        )
      ).rows[0].record,
    ).toEqual(original);
    const noAuthority = await call(f, 'POST', '/v1/commands', await draft(f, interval(86_400_000, 172_800_000)));
    expect(noAuthority.statusCode, noAuthority.body).toBe(403);
  });

  it('rolls back adoption visibility under stale or lost worker leases and permits fenced recovery', async () => {
    const f = await fixture('fence');
    const id = await accept(f, await draft(f));
    const work = (await lease(f, id, 2))!;
    expect(work).not.toBeNull();
    expect(await processLease(workerPool, { ...work, generation: String(Number(work.generation) - 1) })).toBe(false);
    await expect(
      processLease(workerPool, work, { beforeCommit: () => leaseExpired(admin, 'work_items', work.id) }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    const pending = await coverage(f);
    expect(pending.organization.projectedRevision).toBe(0);
    expect(pending.adoptions[0]).toMatchObject({ id, state: 'pending', processing: { status: 'pending' } });
    expect((await admin.query('SELECT id FROM organization_pack_adoption_views WHERE id=$1', [id])).rowCount).toBe(0);
    const fresh = (await lease(f, id))!;
    expect(Number(fresh.generation)).toBeGreaterThan(Number(work.generation));
    expect(await processLease(workerPool, work)).toBe(false);
    expect(await processLease(workerPool, fresh)).toBe(true);
    expect((await coverage(f)).adoptions[0].processing.status).toBe('projected');
  });

  it('reads coverage while another transaction holds or has just changed the organization row', async () => {
    const f = await fixture('coverage-read');
    await accept(f, await draft(f));
    await drain(f);
    // The read's snapshot is taken first; an adoption is then accepted and projected, each changing the organization
    // row, before the read reaches it. The read returns its snapshot's state.
    const read = await withScope(
      pool,
      f.actor,
      async (client, principal) => {
        await client.query('SELECT 1 FROM organizations');
        await accept(f, await draft(f, interval(86_400_000, 172_800_000)));
        await drain(f);
        return getOrganizationCoverage(client, principal);
      },
      'flight:read',
      true,
    );
    expect(read.organization).toMatchObject({ revision: 1, projectedRevision: 1 });
    expect(read.adoptions).toHaveLength(1);
    // A command holding the row does not hold up the read.
    const held = await withScope(workerPool, f.worker, async (client) => {
      await organization(client, f.actor.tenantId, 'UPDATE');
      return coverage(f);
    });
    expect(held.organization).toMatchObject({ revision: 2, projectedRevision: 2 });
    expect(held.adoptions).toHaveLength(2);
  });

  it('reads organization decisions from the read’s snapshot while an adoption changes the organization row', async () => {
    const f = await fixture('decisions-read');
    await accept(f, await draft(f));
    await drain(f);
    const read = await withScope(
      pool,
      f.actor,
      async (client, principal) => {
        await client.query('SELECT 1 FROM organizations');
        await accept(f, await draft(f, interval(86_400_000, 172_800_000)));
        await drain(f);
        return getOrganizationDecisions(client, principal, true);
      },
      'flight:read',
      true,
    );
    expect(read.organization).toMatchObject({ revision: 1, projectedRevision: 1 });
  });

  it('updates a person’s own authority twice at once, in one lock order', async () => {
    const f = await fixture('own-authority');
    const update = { kind: 'authority.update' as const, principalId: f.actor.id, expectedRevision: 1, capabilities };
    // One update of the person's own authority holds their principal row as such an update takes it; the second is
    // sent while it is held.
    let second: ReturnType<typeof call> | undefined;
    const first = await withScope(
      pool,
      f.actor,
      async (client, who) => {
        second = call(f, 'POST', '/v1/commands', update);
        second.catch(() => undefined);
        await lockWaitStarted(admin);
        return acceptCommand(client, who, update);
      },
      'authority:write',
      false,
      undefined,
      'UPDATE',
    );
    expect(first.kind).toBe('authority.update');
    // The second waited for the first, which changed the revision it names.
    const refused = await second!;
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('stale_authority');
  });

  it('retains authenticated source bytes and verifies an ordinary flight decision export after adoption', async () => {
    const f = await fixture('evidence');
    const sourcePath = '/v1/rule-sources/govinfo.fr.2025-14992/content';
    expect((await app.inject({ method: 'GET', url: sourcePath })).statusCode).toBe(401);
    const source = await call(f, 'GET', sourcePath);
    expect(source.statusCode, source.body.slice(0, 200)).toBe(200);
    expect(source.rawPayload.byteLength).toBe(1386012);
    expect(source.headers['x-content-sha256']).toBe('2ebbbb6d3ecfe4757a192c1850d67373e75c18d7df52136a607737ee9672f7f7');
    expect(sha256(source.rawPayload)).toBe(source.headers['x-content-sha256']);
    expect(source.headers['content-type']).toContain('text/html');
    expect(source.headers['content-disposition']).toBe('attachment; filename="govinfo-fr-2025-14992.htm"');
    const missing = await call(f, 'GET', '/v1/rule-sources/unknown/content');
    expect(missing.statusCode, missing.body).toBe(404);
    const created = await call(f, 'POST', '/v1/flights', {
      originationKey: `${prefix}:ordinary-export`,
      label: 'Ordinary review after pack adoption',
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await drain(f);
    const shown = await call(f, 'GET', `/v1/flights/${flightId}/timeline`);
    expect(shown.statusCode, shown.body).toBe(200);
    const displayed = shown.json<TimelineResponse>();
    const adoptionId = await accept(f, await draft(f));
    await drain(f);
    const afterAdoption = await call(f, 'GET', `/v1/flights/${flightId}/timeline`);
    expect(afterAdoption.json().meta.dependencyBasis).not.toBe(displayed.meta.dependencyBasis);
    expect(afterAdoption.json().flight.basisRevision).toBe(displayed.flight.basisRevision);
    const refreshed = afterAdoption.json<TimelineResponse>();
    const decision = await call(f, 'POST', '/v1/commands', {
      kind: 'decision.record',
      flightId,
      expectedRevision: refreshed.flight.revision,
      expectedBasisRevision: refreshed.flight.basisRevision,
      inputCut: refreshed.meta.inputCut,
      expectedDependencyBasis: refreshed.meta.dependencyBasis!,
      decision: { kind: 'reviewed', note: 'Reviewed the ordinary flight record after the organization adoption.' },
    });
    expect(decision.statusCode, decision.body).toBe(201);
    await drain(f);
    const adoptionExport = await call(f, 'POST', '/v1/exports', {
      flightId,
      decisionId: adoptionId,
      scope: 'whole_tenant_prefixes',
    });
    expect(adoptionExport.statusCode, adoptionExport.body).toBe(404);
    const issued = await call(f, 'POST', '/v1/exports', {
      flightId,
      decisionId: decision.json().command.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const content = await call(f, 'GET', `/v1/exports/${issued.json().record.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    const bundle = content.json();
    expect(verifyBundle(bundle, { expectedManifestDigest: issued.json().record.manifestDigest }).status).toBe(
      'verified',
    );
    expect(bundle.decision.id).toBe(decision.json().command.id);
    const effect = bundle.entries
      .map((entry: { canonicalEnvelope: string }) => JSON.parse(entry.canonicalEnvelope))
      .find((entry: { eventId: string }) => entry.eventId === adoptionId);
    expect(effect.type).toBe('rule-pack.adopt');
    expect(effect.payload.acceptance.pack).toEqual(await pack(f));
  });

  it('seeds the procedures over an older adopted version by succeeding it, and leaves a newer one in place', async () => {
    const f = await fixture('seed-older-version');
    const older = await accept(
      f,
      await draft(f, interval(-60_000, 3_600_000), await pack(f, 'ledger.demo-procedures', 4)),
    );
    await drain(f);
    const procedures = { packId: 'ledger.demo-procedures', version: 5 };
    expect(await adoptRulePack(app, f.token, procedures, 'Seed the procedures.')).toBe(true);
    await drain(f);
    const shown = (await coverage(f)).adoptions;
    const successor = shown.find((adoption) => adoption.pack.version === 5)!;
    expect(successor).toMatchObject({ succeeds: older, state: 'effective', mode: 'active' });
    expect(shown.find((adoption) => adoption.id === older)).toMatchObject({
      state: 'succeeded',
      succeededBy: { id: successor.id, version: 5, start: successor.effectiveInterval.start },
    });
    expect(await adoptRulePack(app, f.token, procedures, 'Seed the procedures.')).toBe(false);
    const downgrade = adoptRulePack(app, f.token, { ...procedures, version: 4 }, 'Seed the procedures.');
    await expect(downgrade).resolves.toBe(false);
    const older3 = adoptRulePack(app, f.token, { ...procedures, version: 3 }, 'Seed the procedures.');
    await expect(older3).rejects.toBeInstanceOf(SeedAdoptionConflict);
    await expect(older3).rejects.toThrow(/already adopted ledger\.demo-procedures version 5.*leaves it in place/);
  });
});
