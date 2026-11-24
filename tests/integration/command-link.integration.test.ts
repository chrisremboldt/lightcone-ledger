import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  processEvaluationLease,
  processLease,
  runDueRuleEvaluations,
  runDueRuleSelections,
  type EvaluationLease,
  type WorkLease,
} from '../../apps/workers/src/index.js';
import { leaseExpired, projectOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';
import type {
  Command,
  CommandLinkInput,
  CommandLinkSource,
  CommandLinkBaselineInput,
  CommandLinkBaselineSource,
  CommandLinkBaselineRecordResponse,
  EvaluationRecord,
  FindingRecord,
  OrganizationCoverageResponse,
  OrganizationDecisionsResponse,
  Receipt,
  RulePackVersion,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack, reviewShownAdoption } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { commandLinkObservationInput } from '../../packages/contracts/fixtures/demo/v1/command-link.js';
import {
  grantRetainedCommandLinkAuthority,
  recordRetainedCommandLinkBaseline,
  recordRetainedCommandLinkReport,
} from './retained-command-link-intake.js';
import {
  translateAndSubmit,
  type ObservationSink,
  type TranslationContext,
} from '../../packages/adapters/src/adapter-contract.js';
import {
  commandLinkStatusAdapter,
  type CommandLinkStatusBinding,
} from '../../packages/adapters/src/command-link-status.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from '../../packages/domain/src/rules/command-link-evidence-v1.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';

type Role = 'operator' | 'sourceA' | 'sourceB' | 'ungranted' | 'ordinary';
interface Fixture {
  tenantId: string;
  sourceId: string;
  worker: AuthContext;
  principals: Record<Role, string>;
  tokens: Record<Role, string>;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL reported command-link evidence', () => {
  const prefix = `command-link-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  const sourceCapabilities = ['input:write', 'flight:read', 'evidence:read'];
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix], { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });
  async function fixture(suffix: string, granted = true, adopt = true): Promise<Fixture> {
    const tenantId = `${prefix}:${suffix}`;
    const principals = {} as Record<Role, string>;
    const tokens = {} as Record<Role, string>;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional command-link operator']);
    const roles: Record<Role, string[]> = {
      operator: [
        'input:write',
        'flight:create',
        'flight:read',
        'evidence:read',
        'decision:write',
        'identity:write',
        'authority:write',
        'pack:adopt',
      ],
      sourceA: sourceCapabilities,
      sourceB: sourceCapabilities,
      ungranted: sourceCapabilities,
      ordinary: ['input:write', 'flight:read', 'evidence:read'],
    };
    for (const [role, capabilities] of Object.entries(roles) as [Role, string[]][]) {
      const id = `${tenantId}:${role}`;
      principals[role] = id;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'operator' ? 'human' : 'source',
        capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    const worker: AuthContext = {
      id: `${tenantId}:worker`,
      tenantId,
      name: 'Fictional command-link worker',
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read'],
      revision: 1,
    };
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
      worker.id,
      tenantId,
      worker.name,
      worker.capabilities,
    ]);
    const f = { tenantId, sourceId: `${tenantId}:link`, worker, principals, tokens };
    if (granted) {
      await grant(f, 'sourceA', [f.sourceId]);
      await grant(f, 'sourceB', [f.sourceId]);
    }
    // The lost-link review runs only where an organization adopted the procedures that hold it.
    if (adopt) await adoptProcedures(f);
    return f;
  }
  async function adoptProcedures(f: Fixture, settle = true) {
    const shown = await call(f, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(f, 'GET', '/v1/rule-packs/ledger.demo-procedures/versions/6');
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    const adopted = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack as RulePackVersion,
        { start: new Date(now - 86_400_000).toISOString(), end: new Date(now + 86_400_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    if (settle) await drain(f);
    else await project(f);
  }
  /** Projects pending journal work only, without running rule selections or the generic evaluator. */
  async function project(f: Fixture) {
    await projectOwnedWork(admin, workerPool, [f.tenantId], { objectStore: store });
  }
  function call(
    f: Fixture,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    role: Role = 'operator',
    key = randomUUID(),
  ) {
    return app.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${f.tokens[role]}`,
        'idempotency-key': key,
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
    });
  }
  /** Grants the role link.status observations under the fixture's source. */
  async function grant(f: Fixture, role: Role, sources: string[]) {
    const current = await call(f, 'GET', '/v1/me', undefined, role);
    expect(current.statusCode, current.body).toBe(200);
    const response = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: f.principals[role],
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: sources.map((sourceId) => ({ sourceId, observationType: 'link.status' })),
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  async function lease(f: Fixture, eventId?: string, seconds = 30): Promise<WorkLease | null> {
    return withScope(workerPool, f.worker, async (client) => {
      const candidate = (
        await client.query<WorkLease>(
          `SELECT w.* FROM work_items w WHERE (w.state='pending' OR (w.state='leased' AND w.lease_until<clock_timestamp()))
         AND w.available_at<=clock_timestamp() AND ($1::text IS NULL OR w.event_id=$1)
         AND NOT EXISTS(SELECT 1 FROM work_items p WHERE p.stream_id=w.stream_id AND p.stream_sequence<w.stream_sequence AND p.state NOT IN ('completed','failed'))
         ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE`,
          [eventId ?? null],
        )
      ).rows[0];
      if (!candidate) return null;
      const row = (
        await client.query<WorkLease>(
          "UPDATE work_items SET state='leased',generation=generation+1,lease_owner=$1,lease_until=clock_timestamp()+make_interval(secs=>$3::double precision) WHERE id=$2 RETURNING *",
          [prefix, candidate.id, seconds],
        )
      ).rows[0];
      return { ...row, worker_id: f.worker.id };
    });
  }
  async function drain(f: Fixture) {
    for (let index = 0; index < 120; index++) {
      await project(f);
      // Rule selections and the generic evaluator run after projection, as the worker loop runs them.
      const settled = await withOwnedWork(
        admin,
        [f.tenantId],
        async () =>
          (await runDueRuleSelections(workerPool, { limit: 100 })) +
          (await runDueRuleEvaluations(workerPool, { limit: 100 })),
      );
      if (!settled) return;
    }
    throw new Error('Command-link fixture did not drain');
  }
  async function flight(f: Fixture, suffix: string) {
    const response = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:${suffix}`, label: suffix });
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    return response.json().flight.id as string;
  }
  async function timeline(f: Fixture, flightId: string): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${flightId}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function source(f: Fixture, eventId = 'loss–1', overrides: Partial<CommandLinkSource> = {}): CommandLinkSource {
    return {
      sourceSessionId: `${f.tenantId}:session`,
      sourceEventId: eventId,
      incidentId: `${f.tenantId}:incident`,
      aircraftId: 'fictional-aircraft-1',
      occurredAt: '2026-10-01T17:00:00.000Z',
      status: 'lost',
      position: { longitude: -97.7, latitude: 30.2 },
      ...overrides,
    };
  }
  async function artifact(f: Fixture, bytes: Buffer, role: Role = 'sourceA') {
    const upload = await call(
      f,
      'POST',
      '/v1/uploads',
      { byteLength: bytes.length, contentType: 'application/json' },
      role,
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const id = upload.json().upload.id;
    const stored = await call(f, 'PUT', `/v1/uploads/${id}/content`, bytes, role);
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(f, 'POST', `/v1/uploads/${id}/finalize`, undefined, role);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  async function input(
    f: Fixture,
    flightId: string,
    raw: CommandLinkSource,
    role: Role = 'sourceA',
    bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`),
  ): Promise<CommandLinkInput> {
    const { sourceSessionId, occurredAt, ...payload } = raw;
    return {
      sourceId: f.sourceId,
      sourceSessionId,
      kind: 'command-link.status',
      occurredAt,
      subject: { flightId },
      artifactId: await artifact(f, bytes, role),
      fidelity: 'synthetic_contract',
      payload,
    };
  }
  /**
   * Sends a report as a link monitor does now: its original bytes are already uploaded; this sends the link.status
   * observation the command-link adapter makes of them. Any other body is sent as it is.
   */
  async function accepted(
    f: Fixture,
    body: CommandLinkInput | Record<string, unknown>,
    role: Role = 'sourceA',
    key = randomUUID(),
  ): Promise<Receipt> {
    const sent =
      body.kind === 'command-link.status'
        ? (() => {
            const { sourceSessionId, occurredAt, payload, artifactId, subject, sourceId } = body as CommandLinkInput;
            return commandLinkObservationInput(
              { sourceSessionId, occurredAt, ...payload },
              artifactId,
              subject.flightId,
              sourceId,
            );
          })()
        : body;
    const response = await call(f, 'POST', '/v1/inputs', sent, role, key);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt;
  }
  /** Records a report or baseline as the retired intake did, for tests of the evidence it left. */
  async function retained(f: Fixture, body: CommandLinkInput | CommandLinkBaselineInput, role: Role = 'sourceA') {
    await grantRetainedCommandLinkAuthority(admin, f.tenantId, f.principals[role], f.sourceId);
    const principal = { id: f.principals[role], tenantId: f.tenantId };
    return body.kind === 'command-link.status'
      ? recordRetainedCommandLinkReport(pool, principal, body, store)
      : recordRetainedCommandLinkBaseline(pool, principal, body, store);
  }
  async function baseline(
    f: Fixture,
    flightId: string,
    overrides: Partial<CommandLinkBaselineSource> = {},
    role: Role = 'sourceA',
  ): Promise<CommandLinkBaselineInput> {
    const raw: CommandLinkBaselineSource = {
      version: 'command-link.baseline.1',
      sourceId: f.sourceId,
      sourceSessionId: `${f.tenantId}:session`,
      sourceEventId: 'initial-state',
      flightId,
      aircraftId: 'fictional-aircraft-1',
      occurredAt: '2026-10-01T16:59:00.000Z',
      state: 'up',
      ...overrides,
    };
    const { sourceId, sourceSessionId, occurredAt, flightId: boundFlight, ...payload } = raw;
    return {
      kind: 'command-link.baseline',
      sourceId,
      sourceSessionId,
      occurredAt,
      subject: { flightId: boundFlight },
      artifactId: await artifact(f, Buffer.from(`${JSON.stringify(raw, null, 2)}\n`), role),
      fidelity: 'synthetic_contract',
      payload,
    };
  }
  function decision(shown: TimelineResponse) {
    return {
      kind: 'decision.record',
      flightId: shown.flight.id,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      decision: { kind: 'review', note: 'Reviewed the reported evidence.' },
    };
  }
  function linkFinding(shown: TimelineResponse): FindingRecord {
    const finding = shown.findings?.find((item) => item.latestEvaluation.leafId === COMMAND_LINK_LOSS_LEAF_ID);
    expect(finding).toBeDefined();
    return finding!;
  }
  function treatment(
    shown: TimelineResponse,
    finding: FindingRecord,
    action: 'acknowledge' | 'respond' | 'resolve',
  ): Command {
    return {
      ...decision(shown),
      kind: 'decision.record',
      findingTreatment: { findingId: finding.id, evaluationId: finding.latestEvaluation.id, action },
      decision: { kind: `finding.${action}`, note: `${action}: reviewed the reported command-link evidence.` },
    };
  }
  async function record(f: Fixture, flightId: string) {
    const response = await call(f, 'POST', '/v1/commands', decision(await timeline(f, flightId)));
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    return response.json().command.id as string;
  }

  it('refuses the retired intakes, and keeps a baseline recorded earlier readable, fenced and tenant-scoped', async () => {
    const f = await fixture('baseline');
    const other = await fixture('baseline-foreign');
    const flightId = await flight(f, 'baseline flight');
    const otherFlight = await flight(f, 'other baseline flight');
    const body = await baseline(f, flightId);
    const refused = await call(f, 'POST', '/v1/inputs', body, 'sourceA');
    expect(refused.statusCode, refused.body).toBe(410);
    expect(refused.json().error.code).toBe('command_link_baseline_retired');
    const report = await input(f, flightId, source(f));
    const unsupported = await call(f, 'POST', '/v1/inputs', report, 'sourceA');
    expect(unsupported.statusCode, unsupported.body).toBe(400);
    const receipt = await retained(f, body);
    const path = `/v1/flights/${flightId}/command-link-baselines/${receipt.eventId}`;
    const read = async () => {
      const response = await call(f, 'GET', path);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload.length).toBeLessThanOrEqual(65536);
      return response.json<CommandLinkBaselineRecordResponse>();
    };
    const pending = await read();
    expect(pending.processing).toBe('pending');
    expect(pending.digest).toBe(canonicalDigest(pending.baseline));
    expect(pending.baseline).toMatchObject({
      eventId: receipt.eventId,
      receiptId: receipt.id,
      input: body,
      authority: { principalId: f.principals.sourceA, tenantId: f.tenantId, grantedSources: [f.sourceId] },
      original: { artifactId: body.artifactId },
    });
    expect(pending.baseline).not.toHaveProperty('originalBytesBase64');
    expect((await call(other, 'GET', path)).statusCode).toBe(404);
    expect(
      (await call(f, 'GET', `/v1/flights/${otherFlight}/command-link-baselines/${receipt.eventId}`)).statusCode,
    ).toBe(404);
    expect(
      await withScope(
        pool,
        { tenantId: other.tenantId, id: other.principals.operator },
        async (client) =>
          (await client.query('SELECT id FROM command_link_baselines WHERE id=$1', [receipt.eventId])).rowCount,
      ),
    ).toBe(0);
    await expect(admin.query('UPDATE command_link_baselines SET id=id WHERE id=$1', [receipt.eventId])).rejects.toThrow(
      'append-only',
    );
    const expired = (await lease(f, receipt.eventId, 2))!;
    await expect(
      processLease(workerPool, expired, {
        objectStore: store,
        beforeCommit: () => leaseExpired(admin, 'work_items', expired.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect((await timeline(f, flightId)).items.some((item) => item.id === receipt.eventId)).toBe(false);
    const reclaimed = (await lease(f, receipt.eventId))!;
    expect(await processLease(workerPool, expired, { objectStore: store })).toBe(false);
    expect(await processLease(workerPool, reclaimed, { objectStore: store })).toBe(true);
    const completed = await read();
    expect(completed).toEqual({ ...pending, processing: 'completed' });
    const shown = await timeline(f, flightId);
    expect(shown.items.find((item) => item.id === receipt.eventId)).toMatchObject({
      kind: 'command-link.baseline',
      lane: 'observed',
      actorId: f.principals.sourceA,
      artifactId: body.artifactId,
    });
    const linked = await call(f, 'POST', '/v1/commands', {
      kind: 'identity.link',
      receiptId: receipt.id,
      flightId: otherFlight,
      expectedRevision: (await timeline(f, otherFlight)).flight.revision,
    });
    expect(linked.statusCode, linked.body).toBe(409);
    expect(linked.json().error.code).toBe('command_link_scope_fixed');
    // Nothing new is written to the retained tables for a report that arrives as an observation.
    const before = await admin.query(
      'SELECT COUNT(*)::int AS count FROM command_link_source_events WHERE tenant_id=$1',
      [f.tenantId],
    );
    await accepted(f, await input(f, flightId, source(f, 'loss–2', { sourceSessionId: `${f.tenantId}:observed` })));
    await drain(f);
    expect(
      (
        await admin.query('SELECT COUNT(*)::int AS count FROM command_link_source_events WHERE tenant_id=$1', [
          f.tenantId,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect(
      (await admin.query('SELECT COUNT(*)::int AS count FROM command_link_sessions WHERE tenant_id=$1', [f.tenantId]))
        .rows[0].count,
    ).toBe(1);
    expect(linkFinding(await timeline(f, flightId)).latestEvaluation.outcome).toBe('attention');
  });

  it('pins pending reports and fences their findings without changing physical state or landing checks', async () => {
    const f = await fixture('basis-fence');
    const flightId = await flight(f, 'reported link');
    const unrelatedId = await flight(f, 'quiet flight');
    const before = await timeline(f, flightId);
    const unrelated = await timeline(f, unrelatedId);
    const landingEvaluations = (
      await admin.query<{ id: string; record: EvaluationRecord }>(
        'SELECT id,record FROM flight_evaluations WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id<>$3 ORDER BY id',
        [f.tenantId, flightId, COMMAND_LINK_LOSS_LEAF_ID],
      )
    ).rows;
    const body = await input(f, flightId, source(f));
    const receipt = await accepted(f, body);
    const stale = await call(f, 'POST', '/v1/commands', decision(before));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('stale_basis');
    const pending = await timeline(f, flightId);
    expect(pending.items.some((item) => item.id === receipt.eventId)).toBe(false);
    const reviewed = await call(f, 'POST', '/v1/commands', decision(pending));
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const basis = (
      await admin.query<{
        rendered_input_cut: { streams: Record<string, number> };
        accepted_input_cut: { streams: Record<string, number> };
      }>('SELECT rendered_input_cut,accepted_input_cut FROM decisions WHERE id=$1', [reviewed.json().command.id])
    ).rows[0];
    expect(basis.accepted_input_cut.streams).not.toEqual(basis.rendered_input_cut.streams);
    const work = (await lease(f, receipt.eventId, 2))!;
    expect(await processLease(workerPool, { ...work, generation: String(Number(work.generation) - 1) })).toBe(false);
    await expect(
      processLease(workerPool, work, { beforeCommit: () => leaseExpired(admin, 'work_items', work.id) }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect((await timeline(f, flightId)).items.some((item) => item.id === receipt.eventId)).toBe(false);
    expect((await timeline(f, flightId)).findings).toEqual(before.findings);
    expect(
      (
        await admin.query('SELECT id FROM flight_evaluations WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id=$3', [
          f.tenantId,
          flightId,
          COMMAND_LINK_LOSS_LEAF_ID,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query('SELECT id FROM findings WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id=$3', [
          f.tenantId,
          flightId,
          COMMAND_LINK_LOSS_LEAF_ID,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT id FROM journal_events WHERE tenant_id=$1 AND event_type='rule-evaluation.recorded' AND causation_id=$2",
          [f.tenantId, receipt.eventId],
        )
      ).rowCount,
    ).toBe(0);
    const fresh = (await lease(f, receipt.eventId))!;
    expect(await processLease(workerPool, work)).toBe(false);
    expect(await processLease(workerPool, fresh)).toBe(true);
    await drain(f);
    const restoration = await accepted(
      f,
      await input(
        f,
        flightId,
        source(f, 'restoration–1', { status: 'restored', occurredAt: '2026-10-01T17:00:30.000Z' }),
      ),
    );
    await drain(f);
    const after = await timeline(f, flightId);
    expect(after.items.find((item) => item.id === receipt.eventId)).toMatchObject({
      occurredAt: body.occurredAt,
      title: 'Command link reported lost',
    });
    expect(after.items.find((item) => item.id === restoration.eventId)?.title).toBe('Command link reported restored');
    expect(after.flight).toMatchObject({
      activity: before.flight.activity,
      coverage: before.flight.coverage,
      conflictCount: before.flight.conflictCount,
    });
    expect(after.flight.picture?.lastPosition).toEqual(before.flight.picture?.lastPosition);
    const finding = linkFinding(after);
    expect(finding.status).toBe('open');
    expect(finding.owner).toBeNull();
    expect(finding.initialEvaluation.outcome).toBe('attention');
    expect(finding.latestEvaluation.outcome).toBe('pass');
    expect(finding.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toEqual(
      expect.arrayContaining([receipt.eventId, restoration.eventId]),
    );
    expect(
      (
        await admin.query<{ id: string; record: EvaluationRecord }>(
          'SELECT id,record FROM flight_evaluations WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id<>$3 ORDER BY id',
          [f.tenantId, flightId, COMMAND_LINK_LOSS_LEAF_ID],
        )
      ).rows,
    ).toEqual(landingEvaluations);
    expect(
      Number(
        (
          await admin.query('SELECT COUNT(*) AS count FROM claims WHERE tenant_id=$1 AND flight_id=$2', [
            f.tenantId,
            flightId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    const quiet = await timeline(f, unrelatedId);
    expect(quiet.flight.operation).toBeDefined();
    expect(unrelated.flight.operation).toBeDefined();
    const earlierReadAt = unrelated.flight.operation!.asOf;
    const laterReadAt = quiet.flight.operation!.asOf;
    expect(quiet.flight).toEqual({
      ...unrelated.flight,
      operation: { ...unrelated.flight.operation!, asOf: laterReadAt },
    });
    expect(Date.parse(laterReadAt)).toBeGreaterThan(Date.parse(earlierReadAt));
    expect(quiet.meta.dependencyBasis).toBe(unrelated.meta.dependencyBasis);
  });

  it('retains ownership through restoration and reopens the same review for a late loss after explicit resolution', async () => {
    const f = await fixture('finding-lifecycle');
    const flightId = await flight(f, 'command-link review');
    const loss = await accepted(f, await input(f, flightId, source(f)));
    await drain(f);
    let shown = await timeline(f, flightId);
    const original = linkFinding(shown);
    expect(original.status).toBe('open');
    expect(original.latestEvaluation.outcome).toBe('attention');
    expect(original.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toContain(loss.eventId);
    for (const action of ['acknowledge', 'respond'] as const) {
      const response = await call(f, 'POST', '/v1/commands', treatment(shown, linkFinding(shown), action));
      expect(response.statusCode, response.body).toBe(201);
      await drain(f);
      shown = await timeline(f, flightId);
    }
    expect(linkFinding(shown)).toMatchObject({ status: 'responding', owner: { id: f.principals.operator } });
    const unresolved = await call(f, 'POST', '/v1/commands', treatment(shown, linkFinding(shown), 'resolve'));
    expect(unresolved.statusCode, unresolved.body).toBe(409);
    expect(unresolved.json().error.code).toBe('finding_evidence_required');
    const restoration = await accepted(
      f,
      await input(
        f,
        flightId,
        source(f, 'restoration–1', { status: 'restored', occurredAt: '2026-10-01T17:00:30.000Z' }),
      ),
    );
    const stale = await call(f, 'POST', '/v1/commands', treatment(shown, linkFinding(shown), 'resolve'));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('stale_basis');
    await drain(f);
    shown = await timeline(f, flightId);
    const restored = linkFinding(shown);
    expect(restored).toMatchObject({
      id: original.id,
      status: 'responding',
      owner: { id: f.principals.operator },
      latestEvaluation: { outcome: 'pass', evidenceState: 'supported' },
    });
    expect(restored.initialEvaluation).toEqual(original.initialEvaluation);
    expect(restored.treatments.map((item) => item.action)).toEqual(['acknowledge', 'respond']);
    expect(restored.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toEqual(
      expect.arrayContaining([loss.eventId, restoration.eventId]),
    );
    const resolved = await call(f, 'POST', '/v1/commands', treatment(shown, restored, 'resolve'));
    expect(resolved.statusCode, resolved.body).toBe(201);
    const acceptance = (
      await admin.query<{ payload: { acceptedFindingBasis: EvaluationRecord } }>(
        'SELECT payload FROM journal_events WHERE tenant_id=$1 AND id=$2',
        [f.tenantId, resolved.json().command.id],
      )
    ).rows[0];
    expect(acceptance.payload.acceptedFindingBasis).toEqual(restored.latestEvaluation);
    await drain(f);
    expect(linkFinding(await timeline(f, flightId)).status).toBe('resolved');
    const lateLoss = await accepted(
      f,
      await input(f, flightId, source(f, 'late-loss–2', { occurredAt: '2026-10-01T17:00:10.000Z' })),
    );
    await drain(f);
    shown = await timeline(f, flightId);
    const reopened = linkFinding(shown);
    expect(reopened).toMatchObject({ id: original.id, status: 'acknowledged', owner: { id: f.principals.operator } });
    expect(reopened.initialEvaluation).toEqual(original.initialEvaluation);
    expect(reopened.latestEvaluation.id).not.toBe(restored.latestEvaluation.id);
    expect(reopened.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toContain(lateLoss.eventId);
    expect(reopened.treatments.map((item) => item.action)).toEqual(['acknowledge', 'respond', 'resolve']);
    expect(
      (
        await admin.query('SELECT id FROM findings WHERE tenant_id=$1 AND (flight_id=$2 OR subject_id=$2)', [
          f.tenantId,
          flightId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('asks a person to review the same losses whatever order their reports arrive in', async () => {
    const f = await fixture('arrival-order');
    const lossAt = '2026-10-01T17:00:00.000Z';
    const restoredAt = '2026-10-01T17:00:30.000Z';
    const loss = (flightId: string) =>
      input(f, flightId, source(f, 'loss–1', { sourceSessionId: `${flightId}:session`, occurredAt: lossAt }));
    const restoration = (flightId: string) =>
      input(
        f,
        flightId,
        source(f, 'restoration–1', {
          sourceSessionId: `${flightId}:session`,
          status: 'restored',
          occurredAt: restoredAt,
        }),
      );
    const issues = async (evaluationId: string) =>
      (
        await admin.query<{ issues: string[] }>(
          "SELECT record->'issues' AS issues FROM rule_evaluations WHERE tenant_id=$1 AND id=$2",
          [f.tenantId, evaluationId],
        )
      ).rows[0]!.issues;
    const settled = async (flightId: string) => {
      const finding = linkFinding(await timeline(f, flightId));
      return {
        status: finding.status,
        outcome: finding.latestEvaluation.outcome,
        evidenceState: finding.latestEvaluation.evidenceState,
        code: finding.latestEvaluation.explanation.code,
        summary: finding.latestEvaluation.explanation.summary,
        issues: (await issues(finding.latestEvaluation.id)).map((issue) => issue.replace(flightId, 'flight')),
      };
    };
    // Each flight has its own capture session, so the issues name equal scopes once the flight id is set aside.
    const orders: Record<string, (flightId: string) => Promise<void>> = {
      'loss then restoration': async (flightId) => {
        await accepted(f, await loss(flightId));
        await drain(f);
        await accepted(f, await restoration(flightId));
        await drain(f);
      },
      'restoration then loss': async (flightId) => {
        await accepted(f, await restoration(flightId));
        await drain(f);
        await accepted(f, await loss(flightId));
        await drain(f);
      },
      'one batch': async (flightId) => {
        await accepted(f, await loss(flightId));
        await accepted(f, await restoration(flightId));
        await drain(f);
      },
    };
    const results: unknown[] = [];
    for (const [name, arrive] of Object.entries(orders)) {
      const flightId = await flight(f, `arrival ${name}`);
      await arrive(flightId);
      const result = await settled(flightId);
      expect(result, name).toMatchObject({ status: 'open', outcome: 'pass', evidenceState: 'supported' });
      expect(result.issues, name).toHaveLength(1);
      results.push({ ...result, issues: result.issues.map((issue) => issue.replace(/:[^:]*$/, '')) });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);

    // After a person resolves the review, a second restoration report of the reviewed loss asks for nothing new.
    const flightId = await flight(f, 'arrival after resolution');
    await orders['one batch']!(flightId);
    for (const action of ['acknowledge', 'resolve'] as const) {
      const response = await call(
        f,
        'POST',
        '/v1/commands',
        treatment(await timeline(f, flightId), linkFinding(await timeline(f, flightId)), action),
      );
      expect(response.statusCode, response.body).toBe(201);
      await drain(f);
    }
    expect(linkFinding(await timeline(f, flightId)).status).toBe('resolved');
    await accepted(
      f,
      await input(
        f,
        flightId,
        source(f, 'restoration–2', {
          sourceSessionId: `${flightId}:session`,
          status: 'restored',
          occurredAt: '2026-10-01T17:00:40.000Z',
        }),
      ),
    );
    await drain(f);
    let shown = linkFinding(await timeline(f, flightId));
    expect(shown.status).toBe('resolved');
    expect(shown.latestEvaluation.explanation.evidence).toHaveLength(3);

    // A loss of another incident, reported after the resolution and timed before its own restoration, is new.
    await accepted(
      f,
      await input(
        f,
        flightId,
        source(f, 'restoration–3', {
          sourceSessionId: `${flightId}:session`,
          incidentId: `${f.tenantId}:incident-2`,
          status: 'restored',
          occurredAt: '2026-10-01T17:00:50.000Z',
        }),
      ),
    );
    await drain(f);
    expect(linkFinding(await timeline(f, flightId)).status).toBe('resolved');
    const lateLoss = await accepted(
      f,
      await input(
        f,
        flightId,
        source(f, 'late-loss–3', {
          sourceSessionId: `${flightId}:session`,
          incidentId: `${f.tenantId}:incident-2`,
          occurredAt: '2026-10-01T17:00:45.000Z',
        }),
      ),
    );
    await drain(f);
    shown = linkFinding(await timeline(f, flightId));
    expect(shown).toMatchObject({ status: 'acknowledged', latestEvaluation: { outcome: 'pass' } });
    const named = await issues(shown.latestEvaluation.id);
    expect(named).toHaveLength(2);
    expect(named.some((issue) => issue.includes('incident-2') && issue.endsWith(lateLoss.eventId))).toBe(true);
  });

  it('requires unambiguous occurred restoration evidence before resolving a reported command-link finding', async () => {
    const f = await fixture('finding-restoration');
    for (const scenario of [
      {
        name: 'future',
        occurredAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        evidenceState: 'insufficient',
      },
      { name: 'tied', occurredAt: '2026-10-01T17:00:00.000Z', evidenceState: 'conflicting' },
    ] as const) {
      const flightId = await flight(f, `${scenario.name} restoration`);
      const sourceSessionId = `${f.tenantId}:${scenario.name}:session`;
      await accepted(f, await input(f, flightId, source(f, `${scenario.name}-loss`, { sourceSessionId })));
      await drain(f);
      let shown = await timeline(f, flightId);
      const owned = await call(f, 'POST', '/v1/commands', treatment(shown, linkFinding(shown), 'acknowledge'));
      expect(owned.statusCode, owned.body).toBe(201);
      await drain(f);
      await accepted(
        f,
        await input(
          f,
          flightId,
          source(f, `${scenario.name}-restoration`, {
            sourceSessionId,
            status: 'restored',
            occurredAt: scenario.occurredAt,
          }),
        ),
      );
      await drain(f);
      shown = await timeline(f, flightId);
      const finding = linkFinding(shown);
      expect(finding.latestEvaluation).toMatchObject({ outcome: 'attention', evidenceState: scenario.evidenceState });
      expect(finding.status).toBe('acknowledged');
      const resolved = await call(f, 'POST', '/v1/commands', treatment(shown, finding, 'resolve'));
      expect(resolved.statusCode, resolved.body).toBe(409);
      expect(resolved.json().error.code).toBe('finding_evidence_required');
    }
  });

  it('bootstraps already projected loss and restoration under a reclaimable fence without new source evidence', async () => {
    // Reports retained before the organization adopted the procedures; the bootstrap work queues the generic review.
    const f = await fixture('finding-upgrade', true, false);
    const flightId = await flight(f, 'pre-evaluator reported loss');
    const loss = await retained(f, await input(f, flightId, source(f)));
    const restoration = await retained(
      f,
      await input(
        f,
        flightId,
        source(f, 'restoration–1', { status: 'restored', occurredAt: '2026-10-01T17:00:30.000Z' }),
      ),
    );
    const sourceEvents = [loss.eventId, restoration.eventId];
    // Reproduce completed source projection from before C2 evaluation was installed.
    await withScope(workerPool, f.worker, async (client) => {
      await client.query(
        `INSERT INTO timeline_items(id,tenant_id,flight_id,lane,kind,title,occurred_at,received_at,actor_id,source_id,payload,receipt_id,artifact_id,link_status)
         SELECT e.id,e.tenant_id,r.flight_id,'observed',e.event_type,'Command link reported '||(e.payload->'payload'->>'status'),
         e.occurred_at,e.received_at,e.principal_id,e.source_id,(e.payload->'payload')||jsonb_build_object('sourceSessionId',e.source_session_id),r.id,e.artifact_id,'linked'
         FROM journal_events e JOIN receipts r ON r.tenant_id=e.tenant_id AND r.event_id=e.id
         WHERE e.tenant_id=$1 AND e.id=ANY($2::text[])`,
        [f.tenantId, sourceEvents],
      );
      await client.query(
        `INSERT INTO projection_offsets(tenant_id,stream_id,sequence,projector_version)
         SELECT tenant_id,stream_id,MAX(stream_sequence),'thread.1' FROM journal_events
         WHERE tenant_id=$1 AND id=ANY($2::text[]) GROUP BY tenant_id,stream_id
         ON CONFLICT(tenant_id,stream_id) DO UPDATE SET sequence=EXCLUDED.sequence,projector_version=EXCLUDED.projector_version`,
        [f.tenantId, sourceEvents],
      );
      await client.query(
        "UPDATE work_items SET state='completed',completed_at=clock_timestamp() WHERE tenant_id=$1 AND event_id=ANY($2::text[])",
        [f.tenantId, sourceEvents],
      );
      await client.query(
        `UPDATE flight_views SET revision=revision+2,
         last_received_at=(SELECT MAX(received_at) FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[])),
         source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$3]::text[])) WHERE tenant_id=$1 AND id=$4`,
        [f.tenantId, sourceEvents, f.sourceId, flightId],
      );
      await client.query(
        'INSERT INTO view_changes(tenant_id,flight_id,event_id) SELECT tenant_id,$3,id FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[])',
        [f.tenantId, sourceEvents, flightId],
      );
    });
    const decisionId = await record(f, flightId);
    const before = await timeline(f, flightId);
    expect(before.items.map((item) => item.id)).toEqual(expect.arrayContaining(sourceEvents));
    expect(before.findings).toHaveLength(0);
    expect(
      (
        await admin.query('SELECT id FROM flight_evaluations WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id=$3', [
          f.tenantId,
          flightId,
          COMMAND_LINK_LOSS_LEAF_ID,
        ])
      ).rowCount,
    ).toBe(0);
    const oldJournal = (
      await admin.query<{ id: string; immutable_envelope: string }>(
        'SELECT id,immutable_envelope FROM journal_events WHERE tenant_id=$1 ORDER BY id',
        [f.tenantId],
      )
    ).rows;
    const oldDecision = (
      await admin.query<{ record: unknown }>(
        'SELECT to_jsonb(d) AS record FROM decisions d WHERE tenant_id=$1 AND id=$2',
        [f.tenantId, decisionId],
      )
    ).rows[0];
    const oldReceipts = (
      await admin.query<{ record: unknown }>(
        'SELECT to_jsonb(r) AS record FROM receipts r WHERE tenant_id=$1 ORDER BY id',
        [f.tenantId],
      )
    ).rows;
    // Only the migration's retained-work statement: its lease functions were since replaced by 0062.
    const migration = await readFile(
      new URL('../../packages/persistence/migrations/0019_bootstrap_command_link_findings.sql', import.meta.url),
      'utf8',
    );
    const bootstrap = migration.slice(migration.indexOf('WITH retained AS MATERIALIZED'));
    await admin.query(bootstrap);
    await admin.query(bootstrap);
    const jobs = await admin.query<{
      id: string;
      trigger_event_id: string;
      leaf_id: string;
      binding_id: string;
      state: string;
    }>(
      'SELECT id,trigger_event_id,leaf_id,binding_id,state FROM evaluation_deadlines WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id=$3',
      [f.tenantId, flightId, COMMAND_LINK_LOSS_LEAF_ID],
    );
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0]).toMatchObject({
      id: `command-link-bootstrap.1:${flightId}`,
      trigger_event_id: loss.eventId,
      leaf_id: COMMAND_LINK_LOSS_LEAF_ID,
      state: 'pending',
    });
    await expect(
      pool.query('SELECT * FROM ledger_lease_evaluations($1,$2,$3,$4::text[])', [
        prefix,
        1,
        30,
        [COMMAND_LINK_LOSS_LEAF_ID],
      ]),
    ).rejects.toThrow('permission denied');
    const probe = await workerPool.connect();
    try {
      // The lease names no rule: every form leases the retained work, and only an explicit list narrows it.
      for (const [sql, parameters, included] of [
        ['SELECT id,leaf_id FROM ledger_lease_evaluations($1,$2,$3)', [prefix, 100, 30], true],
        ['SELECT id,leaf_id FROM ledger_lease_evaluations($1,$2,$3,NULL)', [prefix, 100, 30], true],
        [
          'SELECT id,leaf_id FROM ledger_lease_evaluations($1,$2,$3,$4::text[])',
          [prefix, 100, 30, [COMMAND_LINK_LOSS_LEAF_ID]],
          true,
        ],
        ['SELECT id,leaf_id FROM ledger_lease_evaluations($1,$2,$3,$4::text[])', [prefix, 100, 30, ['other']], false],
      ] as const) {
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('ledger.tenant_id',$1,true),set_config('ledger.principal_id',$2,true)", [
          f.tenantId,
          f.worker.id,
        ]);
        await probe.query("UPDATE evaluation_deadlines SET available_at='epoch' WHERE tenant_id=$1 AND id=$2", [
          f.tenantId,
          jobs.rows[0].id,
        ]);
        const leased = await probe.query<Pick<EvaluationLease, 'id' | 'leaf_id'>>(sql, [...parameters]);
        expect(
          leased.rows.some((job) => job.id === jobs.rows[0].id),
          `${sql} ${leased.rowCount}`,
        ).toBe(included);
        await probe.query('ROLLBACK');
      }
    } finally {
      probe.release();
    }
    await adoptProcedures(f, false);
    async function leaseBootstrap(seconds: number): Promise<EvaluationLease | undefined> {
      return withScope(workerPool, f.worker, async (client) => {
        const row = (
          await client.query<EvaluationLease>(
            `UPDATE evaluation_deadlines SET state='leased',generation=generation+1,attempts=attempts+1,
           lease_owner=$1,lease_until=clock_timestamp()+make_interval(secs=>$2::double precision)
           WHERE tenant_id=$3 AND id=$4 AND available_at<=clock_timestamp()
           AND (state='pending' OR (state='leased' AND lease_until<clock_timestamp())) RETURNING *`,
            [prefix, seconds, f.tenantId, jobs.rows[0].id],
          )
        ).rows[0];
        return row ? { ...row, worker_id: f.worker.id } : undefined;
      });
    }
    const expired = (await leaseBootstrap(2))!;
    expect(expired).toBeDefined();
    expect(Number(expired.generation)).toBe(1);
    expect(
      await processEvaluationLease(workerPool, { ...expired, generation: String(Number(expired.generation) - 1) }),
    ).toBe(false);
    await expect(
      processEvaluationLease(workerPool, expired, {
        beforeCommit: () => leaseExpired(admin, 'evaluation_deadlines', expired.id),
      }),
    ).rejects.toMatchObject({ code: 'worker_lease_expired' });
    expect((await timeline(f, flightId)).findings).toHaveLength(0);
    const fresh = (await leaseBootstrap(30))!;
    expect(fresh).toBeDefined();
    expect(Number(fresh.generation)).toBeGreaterThan(Number(expired.generation));
    expect(await processEvaluationLease(workerPool, expired)).toBe(false);
    expect(await processEvaluationLease(workerPool, fresh)).toBe(true);
    expect(
      (
        await admin.query('SELECT 1 FROM rule_evaluation_work WHERE tenant_id=$1 AND subject_id=$2 AND leaf_id=$3', [
          f.tenantId,
          flightId,
          COMMAND_LINK_LOSS_LEAF_ID,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
    await drain(f);
    const after = await timeline(f, flightId);
    // A restored loss still needs a person: its finding opens on the restored answer.
    const finding = linkFinding(after);
    expect(finding).toMatchObject({
      status: 'open',
      owner: null,
      latestEvaluation: { outcome: 'pass', evidenceState: 'supported' },
    });
    expect(finding.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toEqual(
      expect.arrayContaining(sourceEvents),
    );
    expect(finding.initialEvaluation).toEqual(finding.latestEvaluation);
    expect(after.meta.dependencyBasis).not.toBe(before.meta.dependencyBasis);
    expect(
      (
        await admin.query<{ events: number; receipts: number }>(
          `SELECT (SELECT COUNT(*)::int FROM journal_events WHERE tenant_id=$1 AND event_type='command-link.status') AS events,
           (SELECT COUNT(*)::int FROM receipts WHERE tenant_id=$1 AND kind='command-link.status') AS receipts`,
          [f.tenantId],
        )
      ).rows[0],
    ).toEqual({ events: 2, receipts: 2 });
    expect(
      (
        await admin.query<{ id: string; immutable_envelope: string }>(
          'SELECT id,immutable_envelope FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id',
          [f.tenantId, oldJournal.map((event) => event.id)],
        )
      ).rows,
    ).toEqual(oldJournal);
    expect(
      (
        await admin.query<{ record: unknown }>(
          'SELECT to_jsonb(d) AS record FROM decisions d WHERE tenant_id=$1 AND id=$2',
          [f.tenantId, decisionId],
        )
      ).rows[0],
    ).toEqual(oldDecision);
    expect(
      (
        await admin.query<{ record: unknown }>(
          'SELECT to_jsonb(r) AS record FROM receipts r WHERE tenant_id=$1 ORDER BY id',
          [f.tenantId],
        )
      ).rows,
    ).toEqual(oldReceipts);
    await admin.query(bootstrap);
    expect(
      (
        await admin.query(
          'SELECT id,state FROM evaluation_deadlines WHERE tenant_id=$1 AND flight_id=$2 AND leaf_id=$3',
          [f.tenantId, flightId, COMMAND_LINK_LOSS_LEAF_ID],
        )
      ).rows,
    ).toEqual([{ id: jobs.rows[0].id, state: 'completed' }]);
    expect(
      (
        await admin.query('SELECT id FROM rule_evaluations WHERE tenant_id=$1 AND subject_id=$2 AND leaf_id=$3', [
          f.tenantId,
          flightId,
          COMMAND_LINK_LOSS_LEAF_ID,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('retains native baseline and reported-link bytes in flight-v2 targets, unrelated prefixes and organization-v2 exports', async () => {
    const f = await fixture('exports');
    const flightId = await flight(f, 'linked evidence');
    const unrelatedId = await flight(f, 'unrelated export');
    const baselineBody = await baseline(f, flightId);
    const baselineReceipt = await retained(f, baselineBody);
    const raw = source(f);
    const body = await input(f, flightId, raw);
    const receipt = await retained(f, body);
    await drain(f);
    const evaluationId = linkFinding(await timeline(f, flightId)).latestEvaluation.id;
    const ownDecision = await record(f, flightId);
    const otherDecision = await record(f, unrelatedId);
    const pack = (await call(f, 'GET', '/v1/rule-packs/ledger.part108-nprm/versions/1')).json().pack as RulePackVersion;
    const coverage = (await call(f, 'GET', '/v1/organization/coverage')).json<OrganizationCoverageResponse>();
    const now = Date.now();
    const adoption = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        coverage,
        pack,
        { start: new Date(now - 1000).toISOString(), end: new Date(now + 60000).toISOString() },
        'Retain the proposed pack for review.',
        'shadow',
      ),
    );
    expect(adoption.statusCode, adoption.body).toBe(201);
    const adopted = (await call(f, 'GET', '/v1/organization/coverage'))
      .json<OrganizationCoverageResponse>()
      .adoptions.find((item) => item.id === adoption.json().command.id)!;
    const shown = (await call(f, 'GET', '/v1/organization/decisions')).json<OrganizationDecisionsResponse>();
    const review = await call(
      f,
      'POST',
      '/v1/commands',
      reviewShownAdoption(shown, adopted, 'Reviewed alongside the reported link evidence.'),
    );
    expect(review.statusCode, review.body).toBe(201);
    await drain(f);
    for (const target of [
      {
        path: '/v1/exports',
        request: { flightId, decisionId: ownDecision, scope: 'whole_tenant_prefixes' },
        format: 'ledger.flight-evidence.2',
      },
      {
        path: '/v1/exports',
        request: { flightId: unrelatedId, decisionId: otherDecision, scope: 'whole_tenant_prefixes' },
        format: 'ledger.flight-evidence.2',
      },
      {
        path: '/v1/subject-exports',
        request: {
          subject: { kind: 'organization' },
          decisionId: review.json().command.id,
          scope: 'whole_tenant_prefixes',
        },
        format: 'ledger.subject-evidence.2',
      },
    ]) {
      const issued = await call(f, 'POST', target.path, target.request);
      expect(issued.statusCode, issued.body).toBe(201);
      const metadata = issued.json().record;
      expect(metadata.format).toBe(target.format);
      const content = await call(f, 'GET', `${target.path}/${metadata.id}/content`);
      expect(content.statusCode, content.body.slice(0, 200)).toBe(200);
      expect(content.headers['x-evidence-format']).toBe(target.format);
      expect(sha256(content.rawPayload)).toBe(metadata.bundleSha256);
      const bundle = content.json();
      expect(verifyBundle(bundle, { expectedManifestDigest: metadata.manifestDigest }).status).toBe('verified');
      const retained = bundle.artifacts.find((item: { id: string }) => item.id === body.artifactId);
      expect(Buffer.from(retained.bytesBase64, 'base64')).toEqual(Buffer.from(`${JSON.stringify(raw, null, 2)}\n`));
      expect(bundle.receipts.find((item: { id: string }) => item.id === receipt.id)?.kind).toBe('command-link.status');
      expect(bundle.receipts.find((item: { id: string }) => item.id === baselineReceipt.id)?.kind).toBe(
        'command-link.baseline',
      );
      const baselineArtifact = bundle.artifacts.find((item: { id: string }) => item.id === baselineBody.artifactId);
      expect(sha256(Buffer.from(baselineArtifact.bytesBase64, 'base64'))).toBe(baselineArtifact.sha256);
      const tampered = structuredClone(bundle);
      tampered.artifacts.find((item: { id: string }) => item.id === baselineBody.artifactId).bytesBase64 =
        Buffer.from('{}').toString('base64');
      expect(() => verifyBundle(tampered, { expectedManifestDigest: metadata.manifestDigest })).toThrow();
      expect(
        bundle.entries
          .map((item: { canonicalEnvelope: string }) => JSON.parse(item.canonicalEnvelope))
          .find((item: { eventId: string }) => item.eventId === evaluationId),
      ).toMatchObject({
        type: 'rule-evaluation.recorded',
        payload: { evaluation: { rule: { id: COMMAND_LINK_LOSS_LEAF_ID } } },
      });
    }
  });

  it('reads a report sent as a link.status observation as the dedicated intake read it, and follows its withdrawal', async () => {
    const f = await fixture('observation-path');
    const current = (await call(f, 'GET', '/v1/me', undefined, 'sourceA')).json().principal;
    const granted = await call(f, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: f.principals.sourceA,
      expectedRevision: current.revision,
      capabilities: current.capabilities,
      observationGrants: [{ sourceId: f.sourceId, observationType: 'link.status' }],
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const sink: ObservationSink = {
      retainOriginal: async (request) => ({ artifactId: await artifact(f, Buffer.from(request.bytes)) }),
      submitObservation: async (observation, key) => ({
        receiptId: (
          await accepted(
            f,
            { sourceId: f.sourceId, kind: 'observation', occurredAt: observation.occurredAt, payload: observation },
            'sourceA',
            key,
          )
        ).id,
      }),
    };
    async function observe(flightId: string, raw: CommandLinkSource) {
      const context: TranslationContext<CommandLinkStatusBinding> = {
        subjects: { scope: 'ledger', ids: { flight: { [raw.sourceSessionId]: flightId } } },
        binding: { sourceSessionId: raw.sourceSessionId, aircraftId: raw.aircraftId },
      };
      const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
      const outcome = await translateAndSubmit(
        commandLinkStatusAdapter,
        { bytes, contentType: 'application/json', transport: {}, capturedAt: '2026-10-01T17:01:00.000Z' },
        context,
        sink,
      );
      expect(outcome.rejections).toEqual([]);
      const receipt = await call(f, 'GET', `/v1/receipts/${outcome.submitted[0]!.receiptId}`);
      expect(receipt.statusCode, receipt.body).toBe(200);
      return receipt.json().receipt as Receipt;
    }
    const restoredAt = { status: 'restored' as const, occurredAt: '2026-10-01T17:00:30.000Z' };
    const legacyFlight = await flight(f, 'dedicated intake');
    await retained(f, await input(f, legacyFlight, source(f)));
    await retained(f, await input(f, legacyFlight, source(f, 'restoration–1', restoredAt)));
    await drain(f);
    const observedFlight = await flight(f, 'observation intake');
    const sourceSessionId = `${f.tenantId}:observed-session`;
    const loss = await observe(observedFlight, source(f, 'loss–1', { sourceSessionId }));
    const restoration = await observe(observedFlight, source(f, 'restoration–1', { ...restoredAt, sourceSessionId }));
    expect(loss.kind).toBe('observation');
    await drain(f);

    const legacy = linkFinding(await timeline(f, legacyFlight));
    let shown = await timeline(f, observedFlight);
    const observed = linkFinding(shown);
    const comparable = (finding: FindingRecord) => ({
      status: finding.status,
      initial: [finding.initialEvaluation.outcome, finding.initialEvaluation.evidenceState],
      latest: [finding.latestEvaluation.outcome, finding.latestEvaluation.evidenceState],
      code: finding.latestEvaluation.explanation.code,
      // Both forms are read as the same link.status observations; only their record identities differ.
      reports: finding.latestEvaluation.explanation.evidence.map((report) => ({
        sourceId: report.sourceId,
        occurredAt: report.occurredAt,
        type: 'type' in report ? report.type : undefined,
      })),
    });
    expect(comparable(observed)).toEqual(comparable(legacy));
    expect(observed.latestEvaluation.explanation.evidence.map((item) => item.eventId).sort()).toEqual(
      [loss.eventId, restoration.eventId].sort(),
    );
    expect(shown.items.find((item) => item.id === loss.eventId)).toMatchObject({
      kind: 'observation',
      title: 'Command link reported lost',
      lane: 'observed',
    });

    // A report naming the observed session with another aircraft was refused by the dedicated intake; now it is
    // retained as an observation and left out of the review.
    const rebound = await observe(
      observedFlight,
      source(f, 'loss–3', {
        sourceSessionId,
        aircraftId: 'fictional-aircraft-2',
        occurredAt: '2026-10-01T17:00:40.000Z',
      }),
    );
    await drain(f);
    shown = await timeline(f, observedFlight);
    expect(shown.items.some((item) => item.id === rebound.eventId)).toBe(false);
    expect(linkFinding(shown).latestEvaluation.outcome).toBe('pass');

    const withdrawn = await call(
      f,
      'POST',
      '/v1/commands',
      { kind: 'observation.withdraw', observationId: restoration.eventId, reason: 'Sent for the wrong capture.' },
      'sourceA',
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    await drain(f);
    const reopened = linkFinding(await timeline(f, observedFlight));
    expect(reopened.latestEvaluation).toMatchObject({ outcome: 'attention', evidenceState: 'insufficient' });
    expect(reopened.latestEvaluation.explanation.evidence.map((item) => item.eventId)).toEqual([loss.eventId]);
  });
});
