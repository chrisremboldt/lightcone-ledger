import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { leaseWork, processLease } from '../../apps/workers/src/index.js';
import {
  acceptCommand,
  listObservations,
  readSubjectEvidence,
  registerObservationTypes,
} from '../../packages/domain/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { drainOwnedWork, lockWaitStarted, settleOwnedWork, withOwnedWork } from './worker-queue.js';

// The observation type below is defined only in this test. Nothing in intake, storage or reading names it.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Generic observation intake', () => {
  const pool = createPool();
  const worker = createPool(process.env.WORKER_DATABASE_URL);
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const owned = ['tenant-alpha', 'tenant-beta'];
  const store = new MemoryObjectStore();
  const prefix = `observation-${randomUUID()}`;
  const sourceId = `${prefix}-sensor`;
  const type = 'rotor.icing';
  let app: Awaited<ReturnType<typeof createApp>>;
  let flightId: string;
  let artifactId: string;
  const originalBytes = Buffer.from(JSON.stringify({ entered: 'light rotor icing', by: 'test crew' }));

  const headers = (tenant: string, role: string) => ({ authorization: `Bearer ledger-dev-${tenant}-${role}` });
  async function call(tenant: string, role: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
    return app.inject({
      method,
      url,
      headers: { ...headers(tenant, role), 'idempotency-key': `${prefix}:${randomUUID()}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  }
  async function upload(tenant: string, bytes: Buffer): Promise<string> {
    const created = await call(tenant, 'source', 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        ...headers(tenant, 'source'),
        'idempotency-key': `${prefix}:${randomUUID()}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(tenant, 'source', 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  async function grant(tenant: string, principalId: string, grants: { sourceId: string; observationType: string }[]) {
    const current = await call(tenant, 'operator', 'GET', `/v1/authority/principals/${principalId}`);
    expect(current.statusCode, current.body).toBe(200);
    const target = current.json().principal;
    return call(tenant, 'operator', 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId,
      expectedRevision: target.revision,
      capabilities: target.capabilities,
      observationGrants: grants,
    });
  }
  function input(observation: Record<string, unknown>, source = sourceId) {
    return { sourceId: source, kind: 'observation', occurredAt: observation.occurredAt, payload: observation };
  }
  async function submit(body: unknown, key = `${prefix}:${randomUUID()}`, tenant = 'alpha', role = 'source') {
    return app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: { ...headers(tenant, role), 'idempotency-key': key },
      payload: body as Record<string, unknown>,
    });
  }
  async function read(query: Record<string, string>, tenant = 'alpha', role = 'source') {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/observations?${new URLSearchParams({ type, from: '2026-11-01T00:00:00Z', to: '2026-11-03T00:00:00Z', ...query })}`,
      headers: headers(tenant, role),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(type));
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
    const flight = await call('alpha', 'source', 'POST', '/v1/flights', {
      originationKey: `${prefix}-flight`,
      aliases: [{ sourceId, externalId: `${prefix}-external` }],
    });
    expect(flight.statusCode, flight.body).toBe(201);
    flightId = flight.json().flight.id;
    artifactId = await upload('alpha', originalBytes);
    const granted = await grant('alpha', 'principal-alpha-source', [{ sourceId, observationType: type }]);
    expect(granted.statusCode, granted.body).toBe(201);
  });
  afterAll(async () => {
    await settleOwnedWork(owned, { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await worker.end();
    await admin.end();
  });

  it('accepts a test-only type through POST /v1/inputs, links its original bytes and reads it back', async () => {
    const observation = rotorIcingObservation({
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      originalArtifactId: artifactId,
    });
    const accepted = await submit(input(observation));
    expect(accepted.statusCode, accepted.body).toBe(201);
    const receipt = accepted.json().receipt;
    expect(receipt).toMatchObject({ kind: 'observation', sourceId, flightId, artifactId, linkStatus: 'linked' });

    const page = await read({ subjectKind: 'flight', subjectId: flightId });
    expect(page.observations).toHaveLength(1);
    expect(page.observations[0]).toMatchObject({
      receiptId: receipt.id,
      eventId: receipt.eventId,
      artifactId,
      sourceId,
      type,
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'ledger', ledgerId: flightId, resolution: 'ledger' },
      interval: { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T10:10:00.000Z' },
      observation,
    });
    const bytes = await call('alpha', 'source', 'GET', `/v1/artifacts/${artifactId}/content`);
    expect(bytes.rawPayload.equals(originalBytes)).toBe(true);
    const event = await withScope(pool, { id: 'principal-alpha-source', tenantId: 'tenant-alpha' }, (client) =>
      client.query('SELECT artifact_id,payload FROM journal_events WHERE id=$1', [receipt.eventId]),
    );
    expect(event.rows[0].artifact_id).toBe(artifactId);
    expect(event.rows[0].payload.acceptedAuthority.grant).toEqual({ sourceId, observationType: type });

    // A time range outside the interval finds nothing; the work item projects without error.
    expect(
      (await read({ subjectKind: 'flight', subjectId: flightId, from: '2026-11-02T10:10:00Z' })).observations,
    ).toEqual([]);
    await drainOwnedWork(admin, worker, owned, { objectStore: store });
    const processed = await call('alpha', 'source', 'GET', `/v1/receipts/${receipt.id}`);
    expect(processed.json().receipt.processing.status).toBe('completed');
  });

  it('reads at an evidence cut through the domain function', async () => {
    const principal = { id: 'principal-alpha-source', tenantId: 'tenant-alpha' };
    await withScope(pool, principal, async (client, who) => {
      const query = {
        subjectKind: 'flight' as const,
        subjectId: flightId,
        type,
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-03T00:00:00Z',
      };
      const evidence = await readSubjectEvidence(client, flightId, who);
      const inside = await listObservations(client, who, query, { evidenceCut: evidence.accepted.streams });
      expect(inside.observations.length).toBeGreaterThan(0);
      const outside = await listObservations(client, who, query, { evidenceCut: {} });
      expect(outside.observations).toEqual([]);
    });
  });

  it('replays the same key with the original receipt and conflicts on different content', async () => {
    const key = `${prefix}:replay`;
    const body = input(
      rotorIcingObservation({
        subject: { kind: 'flight', id: flightId, scope: 'ledger' },
        originalArtifactId: artifactId,
        occurredAt: '2026-11-02T11:00:00.000Z',
        interval: { start: '2026-11-02T10:50:00.000Z', end: '2026-11-02T11:00:00.000Z' },
      }),
    );
    const first = await submit(body, key);
    expect(first.statusCode, first.body).toBe(201);
    const again = await submit(body, key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().receipt.id).toBe(first.json().receipt.id);
    const changed = await submit({ ...body, payload: { ...body.payload, values: { severity: 'severe' } } }, key);
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('idempotency_conflict');
  });

  it('accepts a source event once: a resend returns the original receipt, different content conflicts', async () => {
    const observation = rotorIcingObservation({
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      originalArtifactId: artifactId,
      sourceEventId: `${prefix}-event-1`,
      occurredAt: '2026-11-02T12:00:00.000Z',
      interval: { start: '2026-11-02T11:50:00.000Z', end: '2026-11-02T12:00:00.000Z' },
    });
    const first = await submit(input(observation));
    expect(first.statusCode, first.body).toBe(201);
    const resent = await submit(input(observation));
    expect(resent.json().receipt.id).toBe(first.json().receipt.id);
    const different = await submit(input({ ...observation, values: { severity: 'moderate' } }));
    expect(different.statusCode, different.body).toBe(409);
    expect(different.json().error.code).toBe('source_event_conflict');
  });

  it('resolves a source-scoped subject through aliases and keeps an unknown one unresolved', async () => {
    const aliased = await submit(
      input(
        rotorIcingObservation({
          subject: { kind: 'flight', id: `${prefix}-external`, scope: 'source' },
          originalArtifactId: artifactId,
          occurredAt: '2026-11-02T13:00:00.000Z',
          interval: { start: '2026-11-02T12:50:00.000Z', end: '2026-11-02T13:00:00.000Z' },
        }),
      ),
    );
    expect(aliased.statusCode, aliased.body).toBe(201);
    expect(aliased.json().receipt).toMatchObject({ flightId, linkStatus: 'linked' });
    const unknown = await submit(
      input(
        rotorIcingObservation({
          subject: { kind: 'aircraft', id: `${prefix}-tail`, scope: 'source' },
          secondarySubject: { kind: 'flight', id: flightId, scope: 'ledger' },
          originalArtifactId: artifactId,
          occurredAt: '2026-11-02T14:00:00.000Z',
          interval: { start: '2026-11-02T13:50:00.000Z', end: '2026-11-02T14:00:00.000Z' },
        }),
      ),
    );
    expect(unknown.statusCode, unknown.body).toBe(201);
    expect(unknown.json().receipt).toMatchObject({ flightId, linkStatus: 'linked' });

    const byFlight = await read({ subjectKind: 'flight', subjectId: flightId, order: 'newest_first', limit: '2' });
    expect(byFlight.observations.map((item: any) => item.occurredAt)).toEqual([
      '2026-11-02T14:00:00.000Z',
      '2026-11-02T13:00:00.000Z',
    ]);
    expect(byFlight.observations[1].subject).toMatchObject({
      scope: 'source',
      ledgerId: flightId,
      resolution: 'alias',
    });
    expect(byFlight.page).toMatchObject({ hasMore: true, order: 'newest_first' });
    const next = await read({
      subjectKind: 'flight',
      subjectId: flightId,
      order: 'newest_first',
      limit: '2',
      cursor: byFlight.page.nextCursor,
    });
    expect(next.observations[0].occurredAt).toBe('2026-11-02T12:00:00.000Z');
    const bySource = await read({
      subjectKind: 'aircraft',
      subjectId: `${prefix}-tail`,
      subjectScope: 'source',
      sourceId,
    });
    expect(bySource.observations).toHaveLength(1);
    expect(bySource.observations[0].subject).toEqual({
      kind: 'aircraft',
      id: `${prefix}-tail`,
      scope: 'source',
      resolution: 'unresolved',
    });
  });

  it('refuses a source without the grant, an unregistered type, a foreign artifact and a foreign subject', async () => {
    const valid = rotorIcingObservation({
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      originalArtifactId: artifactId,
    });
    const otherSource = await submit(input(valid, `${prefix}-other-source`));
    expect(otherSource.statusCode, otherSource.body).toBe(403);
    expect(otherSource.json().error.code).toBe('observation_grant_required');
    const otherPrincipal = await submit(input(valid), undefined, 'alpha', 'actor');
    expect(otherPrincipal.statusCode, otherPrincipal.body).toBe(403);

    const unregistered = await submit(
      input(rotorIcingObservation({ originalArtifactId: artifactId }, 'rotor.unregistered')),
    );
    expect(unregistered.statusCode, unregistered.body).toBe(400);
    expect(unregistered.json().error.code).toBe('unregistered_observation_type');
    const unregisteredGrant = await grant('alpha', 'principal-alpha-actor', [
      { sourceId, observationType: 'rotor.unregistered' },
    ]);
    expect(unregisteredGrant.statusCode, unregisteredGrant.body).toBe(400);

    const backwards = await submit(
      input({ ...valid, interval: { start: '2026-11-02T10:10:00.000Z', end: '2026-11-02T10:00:00.000Z' } }),
    );
    expect(backwards.statusCode, backwards.body).toBe(400);
    const duplicated = await submit({ ...input(valid), artifactId });
    expect(duplicated.statusCode, duplicated.body).toBe(400);

    const betaArtifact = await upload('beta', Buffer.from('{"beta":true}'));
    const foreignArtifact = await submit(input({ ...valid, originalArtifactId: betaArtifact }));
    expect(foreignArtifact.statusCode, foreignArtifact.body).toBe(404);
    expect(foreignArtifact.json().error.code).toBe('artifact_not_found');

    const betaGrant = await grant('beta', 'principal-beta-source', [{ sourceId, observationType: type }]);
    expect(betaGrant.statusCode, betaGrant.body).toBe(201);
    const foreignSubject = await submit(input({ ...valid, originalArtifactId: betaArtifact }), undefined, 'beta');
    expect(foreignSubject.statusCode, foreignSubject.body).toBe(404);
    expect(foreignSubject.json().error.code).toBe('subject_not_found');
  });

  it('projects an observation while a decision on its flight holds the flight, in one lock order', async () => {
    const created = await call('alpha', 'source', 'POST', '/v1/flights', { originationKey: `${prefix}-lock-order` });
    expect(created.statusCode, created.body).toBe(201);
    const held = created.json().flight.id as string;
    await drainOwnedWork(admin, worker, owned, { objectStore: store });
    const observation = rotorIcingObservation({
      subject: { kind: 'flight', id: held, scope: 'ledger' },
      originalArtifactId: artifactId,
    });
    const accepted = await submit(input(observation));
    expect(accepted.statusCode, accepted.body).toBe(201);
    const leases = await withOwnedWork(admin, owned, () => leaseWork(worker, { limit: 100 }));
    const observationLease = leases.find((lease) => lease.event_id === accepted.json().receipt.eventId)!;
    const shown = await call('alpha', 'operator', 'GET', `/v1/flights/${held}/timeline`);
    expect(shown.statusCode, shown.body).toBe(200);
    const basis = shown.json();
    // The decision locks the flight first, as every flight command does; the observation is projected while that
    // lock is held, and only then does the decision read and retain the flight's evidence.
    let projected: Promise<boolean> | undefined;
    const recorded = await withScope(
      pool,
      { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' },
      async (client, who) => {
        await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [held]);
        projected = processLease(worker, observationLease, { objectStore: store });
        projected.catch(() => undefined);
        await lockWaitStarted(admin);
        return acceptCommand(client, who, {
          kind: 'decision.record',
          flightId: held,
          expectedRevision: basis.flight.revision,
          expectedBasisRevision: basis.flight.basisRevision,
          inputCut: basis.meta.inputCut,
          expectedDependencyBasis: basis.meta.dependencyBasis,
          decision: { kind: 'reviewed', note: 'Fictional review while the flight’s observation is projected.' },
        });
      },
    );
    expect(recorded.kind).toBe('decision.record');
    expect(await projected).toBe(true);
    for (const lease of leases.filter((lease) => lease !== observationLease))
      expect(await processLease(worker, lease, { objectStore: store })).toBe(true);
    await drainOwnedWork(admin, worker, owned, { objectStore: store });
  });

  it('keeps observations inside their tenant', async () => {
    const beta = await read({ subjectKind: 'flight', subjectId: flightId }, 'beta');
    expect(beta.observations).toEqual([]);
    const betaSource = await read(
      { subjectKind: 'aircraft', subjectId: `${prefix}-tail`, subjectScope: 'source', sourceId },
      'beta',
    );
    expect(betaSource.observations).toEqual([]);
    const alpha = await read({ subjectKind: 'flight', subjectId: flightId });
    const receipt = await call('beta', 'source', 'GET', `/v1/receipts/${alpha.observations[0].receiptId}`);
    expect(receipt.statusCode).toBe(404);
  });

  it('shows and revokes grants through authority', async () => {
    const me = await call('alpha', 'source', 'GET', '/v1/me');
    expect(me.json().principal.observationGrants).toContainEqual({ sourceId, observationType: type });
    const revoked = await grant('alpha', 'principal-alpha-source', []);
    expect(revoked.statusCode, revoked.body).toBe(201);
    const refused = await submit(
      input(
        rotorIcingObservation({
          subject: { kind: 'flight', id: flightId, scope: 'ledger' },
          originalArtifactId: artifactId,
        }),
      ),
    );
    expect(refused.statusCode, refused.body).toBe(403);
  });
});
