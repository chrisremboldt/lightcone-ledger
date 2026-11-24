import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { runDueRuleEvaluations, runDueRuleSelections } from '../../apps/workers/src/index.js';
import { commandLinkObservationInput } from '../../packages/contracts/fixtures/demo/v1/command-link.js';
import { projectOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from '../../packages/domain/src/rules/command-link-evidence-v1.js';
import type {
  ArtifactResponse,
  OrganizationCoverageResponse,
  RulePackVersion,
  CommandLinkSource,
  FindingRecord,
  FlightResponse,
  ReceiptResponse,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import {
  bindInvestigationProposal,
  type InvestigationAdvice,
  type InvestigationContext,
  type InvestigationRequest,
  type InvestigationResponse,
  type InvestigationRunner,
} from '../../packages/contracts/src/investigation.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import {
  createPool,
  MemoryObjectStore,
  type AuthContext,
  type ObjectReadOptions,
} from '../../packages/persistence/src/index.js';

class InvestigationStore extends MemoryObjectStore {
  unavailable = new Set<string>();

  override async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array> {
    if (this.unavailable.has(key)) throw new Error('Selected fixture original is unavailable');
    return super.get(key, options);
  }
}

type Role = 'creator' | 'human' | 'noFlight' | 'noEvidence' | 'service' | 'source';
interface Fixture {
  tenantId: string;
  sourceId: string;
  tokens: Record<Role, string>;
  worker: AuthContext;
}
interface Counts {
  events: number;
  commands: number;
  decisions: number;
  keys: number;
  work: number;
  outbox: number;
  evaluations: number;
  packets: number;
  exports: number;
}

const execution = { provider: 'injected-test-host', model: 'bounded-fixture-model' };
function advice(context: InvestigationContext): InvestigationAdvice {
  return {
    summary: 'Review the reported command-link evidence within this collected context.',
    citations: context.citations.map((citation) => citation.id),
    comparison: {
      summary: 'Compare only the retained initial and selected evaluations.',
      citations: [...new Set([context.initialEvaluation.record.id, context.selectedEvaluation.record.id])],
    },
    missingEvidence: context.missingEvidence.map((fact) => ({
      id: fact.id,
      note: 'This missing-evidence fact is limited to the selected evaluation.',
    })),
    suggestedTreatment: null,
  };
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL opt-in finding investigation carrier', () => {
  const prefix = `investigation-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workers = createPool(process.env.WORKER_DATABASE_URL);
  const store = new InvestigationStore();
  const runner = vi.fn<InvestigationRunner>();
  let app: Awaited<ReturnType<typeof createApp>>;
  let unavailableApp: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      investigation: { apiOrigin: 'http://ledger.test', runner },
    });
    await app.ready();
    unavailableApp = await createApp({ pool, env: 'test', objectStore: store });
    await unavailableApp.ready();
  });
  beforeEach(() => {
    runner.mockReset().mockImplementation(async (context, signal) => {
      signal.throwIfAborted();
      return { advice: advice(context), execution };
    });
  });
  afterAll(async () => {
    await settleOwnedWork([prefix], { objectStore: store });
    await app?.close();
    await unavailableApp?.close();
    await pool.end();
    await admin.end();
    await workers.end();
  });

  async function fixture(name: string): Promise<Fixture> {
    const tenantId = `${prefix}:${name}`;
    const sourceId = `${tenantId}:command-link`;
    const tokens = {} as Record<Role, string>;
    const capabilities: Record<Role, string[]> = {
      creator: ['flight:create', 'flight:read', 'evidence:read', 'pack:adopt'],
      human: ['flight:read', 'evidence:read'],
      noFlight: ['evidence:read'],
      noEvidence: ['flight:read'],
      service: ['flight:read', 'evidence:read'],
      source: ['input:write', 'flight:read', 'evidence:read'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional investigation operator']);
    for (const role of Object.keys(capabilities) as Role[]) {
      const id = `${tenantId}:${role}`;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        id,
        tenantId,
        `Fictional ${role}`,
        role === 'source' ? 'source' : role === 'service' ? 'service' : 'human',
        capabilities[role],
      ]);
      if (role === 'source')
        await admin.query(
          "INSERT INTO observation_grants(tenant_id,principal_id,source_id,observation_type) VALUES($1,$2,$3,'link.status')",
          [tenantId, id, sourceId],
        );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    const worker: AuthContext = {
      id: `${tenantId}:worker`,
      tenantId,
      name: 'Fictional investigation worker',
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
    const f = { tenantId, sourceId, tokens, worker };
    // The lost-link review runs only where the organization adopted the procedures that hold it.
    const shown = await call(f, 'GET', '/v1/organization/coverage', undefined, 'creator');
    const retained = await call(f, 'GET', '/v1/rule-packs/ledger.demo-procedures/versions/6', undefined, 'creator');
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
      'creator',
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain(f);
    return f;
  }

  function call(
    f: Fixture,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    role: Role = 'human',
    server = app,
  ) {
    return server.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${f.tokens[role]}`,
        ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}),
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
    });
  }

  async function drain(f: Fixture): Promise<void> {
    for (let index = 0; index < 120; index++) {
      await projectOwnedWork(admin, workers, [f.tenantId], { objectStore: store });
      // Rule selections and the generic evaluator run after projection, as the worker loop runs them.
      const settled = await withOwnedWork(
        admin,
        [f.tenantId],
        async () =>
          (await runDueRuleSelections(workers, { limit: 100 })) ||
          (await runDueRuleEvaluations(workers, { limit: 100 })),
      );
      if (!settled) return;
    }
    throw new Error('The investigation fixture exceeded its bounded projection work');
  }

  async function flight(f: Fixture, name: string): Promise<string> {
    const created = await call(
      f,
      'POST',
      '/v1/flights',
      { originationKey: `${f.tenantId}:${name}`, label: name, aircraft: 'Fictional investigation aircraft' },
      'creator',
    );
    expect(created.statusCode, created.body).toBe(201);
    await drain(f);
    return created.json<FlightResponse>().flight.id;
  }

  async function observe(f: Fixture, flightId: string, restored = false): Promise<ReceiptResponse['receipt']> {
    const original: CommandLinkSource = {
      sourceSessionId: `${f.tenantId}:capture:${flightId}`,
      sourceEventId: restored ? 'restoration' : 'loss',
      incidentId: `${f.tenantId}:incident`,
      aircraftId: 'Fictional investigation aircraft',
      occurredAt: restored ? '2026-10-01T17:00:30.000Z' : '2026-10-01T17:00:00.000Z',
      status: restored ? 'restored' : 'lost',
    };
    const bytes = Buffer.from(` ${JSON.stringify(original)}\n`);
    const uploaded = await call(
      f,
      'POST',
      '/v1/uploads',
      { byteLength: bytes.byteLength, contentType: 'application/json' },
      'source',
    );
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const uploadId = uploaded.json().upload.id;
    const written = await call(f, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, 'source');
    expect(written.statusCode, written.body).toBe(200);
    const finalized = await call(f, 'POST', `/v1/uploads/${uploadId}/finalize`, undefined, 'source');
    expect(finalized.statusCode, finalized.body).toBe(201);
    const input = commandLinkObservationInput(
      original,
      finalized.json<ArtifactResponse>().artifact.id,
      flightId,
      f.sourceId,
    );
    const accepted = await call(f, 'POST', '/v1/inputs', input, 'source');
    expect(accepted.statusCode, accepted.body).toBe(201);
    return accepted.json<ReceiptResponse>().receipt;
  }

  async function displayed(f: Fixture, flightId: string, role: Role = 'human'): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${flightId}/timeline?limit=1&decisionLimit=1`, undefined, role);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TimelineResponse>();
  }

  function selected(data: TimelineResponse): FindingRecord {
    const finding = data.findings?.find((item) => item.latestEvaluation.leafId === COMMAND_LINK_LOSS_LEAF_ID);
    expect(finding).toBeDefined();
    return finding!;
  }

  function requestFor(data: TimelineResponse): InvestigationRequest {
    const finding = selected(data);
    expect(data.meta.inputCut.principalRevision).toBeGreaterThan(0);
    return {
      evaluation: { id: finding.latestEvaluation.id, digest: canonicalDigest(finding.latestEvaluation) },
      basis: {
        revision: data.flight.revision,
        basisRevision: data.flight.basisRevision,
        inputCut: {
          ...structuredClone(data.meta.inputCut),
          principalRevision: data.meta.inputCut.principalRevision!,
        },
        dependencyBasis: data.meta.dependencyBasis!,
        view: 'record',
      },
    };
  }

  const pathFor = (flightId: string, findingId: string) =>
    `/v1/flights/${encodeURIComponent(flightId)}/findings/${encodeURIComponent(findingId)}/investigation`;

  async function counts(f: Fixture): Promise<Counts> {
    return (
      await admin.query<Counts>(
        `SELECT
          (SELECT COUNT(*)::int FROM journal_events WHERE tenant_id=$1) AS events,
          (SELECT COUNT(*)::int FROM command_records WHERE tenant_id=$1) AS commands,
          (SELECT COUNT(*)::int FROM decisions WHERE tenant_id=$1) AS decisions,
          (SELECT COUNT(*)::int FROM idempotency_keys WHERE tenant_id=$1) AS keys,
          (SELECT COUNT(*)::int FROM work_items WHERE tenant_id=$1) AS work,
          (SELECT COUNT(*)::int FROM outbox WHERE tenant_id=$1) AS outbox,
          (SELECT COUNT(*)::int FROM flight_evaluations WHERE tenant_id=$1) AS evaluations,
          (SELECT COUNT(*)::int FROM decision_packet_records WHERE tenant_id=$1) AS packets,
          (SELECT COUNT(*)::int FROM export_records WHERE tenant_id=$1) AS exports`,
        [f.tenantId],
      )
    ).rows[0]!;
  }

  it('collects the exact read-only human context and returns advisory text without accepting a record', async () => {
    const f = await fixture('read-only-human');
    const flightId = await flight(f, 'Selected C2 investigation');
    const receipt = await observe(f, flightId);
    await drain(f);
    const otherFlight = await flight(f, 'Unrelated pending C2 report');
    await observe(f, otherFlight);
    try {
      const shown = await displayed(f, flightId);
      expect(shown.flight.outstandingWork).toBe(0);
      expect(shown.meta.outstandingWork).toBeGreaterThan(0);
      const finding = selected(shown);
      const request = requestFor(shown);
      const before = await counts(f);
      const response = await app.inject({
        method: 'POST',
        url: pathFor(flightId, finding.id),
        headers: { authorization: `Bearer ${f.tokens.human}`, host: 'untrusted-host.invalid' },
        payload: request,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(runner).toHaveBeenCalledOnce();
      const [context, signal] = runner.mock.calls[0]!;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(context.pin).toEqual({
        apiUrl: 'http://ledger.test',
        tenantId: f.tenantId,
        principalId: `${f.tenantId}:human`,
        principalRevision: shown.meta.inputCut.principalRevision,
        flightId,
        findingId: finding.id,
        ...request,
      });
      expect(context.allowedActions).toEqual([]);
      expect(context.citations.map((citation) => citation.receiptId)).toEqual([receipt.id]);
      expect(context.selectedEvaluation.record).toEqual(finding.latestEvaluation);
      expect(JSON.stringify(context)).not.toContain(f.tokens.human);
      expect(response.json<InvestigationResponse>()).toEqual({
        proposal: bindInvestigationProposal(context, advice(context)),
        execution,
      });
      expect(await counts(f)).toEqual(before);
      expect((await displayed(f, flightId)).findings).toEqual(shown.findings);
    } finally {
      await drain(f);
    }
  });

  it('rejects other actors, foreign or wrong parents, and substituted evaluation or displayed basis before inference', async () => {
    const f = await fixture('scope');
    const foreign = await fixture('foreign');
    const flightId = await flight(f, 'Exact finding parent');
    await observe(f, flightId);
    await drain(f);
    const otherFlight = await flight(f, 'Other same-tenant parent');
    const shown = await displayed(f, flightId);
    const finding = selected(shown);
    const request = requestFor(shown);
    const path = pathFor(flightId, finding.id);
    const before = await counts(f);
    expect((await app.inject({ method: 'POST', url: path, payload: request })).statusCode).toBe(401);
    for (const [role, code] of [
      ['service', 'human_required'],
      ['noFlight', 'capability_required'],
      ['noEvidence', 'capability_required'],
    ] as const) {
      const denied = await call(f, 'POST', path, request, role);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json().error.code).toBe(code);
    }
    expect((await call(foreign, 'POST', path, request)).statusCode).toBe(404);
    const wrongParent = await call(f, 'POST', pathFor(otherFlight, finding.id), request);
    expect(wrongParent.statusCode, wrongParent.body).toBe(404);
    expect(wrongParent.json().error.code).toBe('finding_not_found');
    const changedId = structuredClone(request);
    changedId.evaluation.id = 'unselected-evaluation';
    const changedDigest = structuredClone(request);
    changedDigest.evaluation.digest = '0'.repeat(64);
    const changedCut = structuredClone(request);
    changedCut.basis.inputCut.streams['not-in-displayed-cut'] = 1;
    for (const changed of [changedId, changedDigest, changedCut]) {
      const stale = await call(f, 'POST', path, changed);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error.code).toBe('investigation_basis_changed');
    }
    expect(runner).not.toHaveBeenCalled();
    expect(await counts(f)).toEqual(before);
  });

  it('fails cleanly without a runner and with unavailable originals, invalid advice or unfinished projection', async () => {
    const f = await fixture('unavailable');
    const flightId = await flight(f, 'Bounded unavailable context');
    const receipt = await observe(f, flightId);
    await drain(f);
    const shown = await displayed(f, flightId);
    const path = pathFor(flightId, selected(shown).id);
    const request = requestFor(shown);
    const before = await counts(f);
    const unavailable = await call(f, 'POST', path, request, 'human', unavailableApp);
    expect(unavailable.statusCode, unavailable.body).toBe(503);
    expect(unavailable.json().error.code).toBe('investigation_unavailable');
    const artifactRead = await call(f, 'GET', `/v1/artifacts/${receipt.artifactId}`);
    expect(artifactRead.statusCode, artifactRead.body).toBe(200);
    const objectKey = artifactRead.json<ArtifactResponse>().artifact.key;
    store.unavailable.add(objectKey);
    try {
      const missing = await call(f, 'POST', path, request);
      expect(missing.statusCode, missing.body).toBe(409);
      expect(missing.json().error.code).toBe('investigation_context_unavailable');
    } finally {
      store.unavailable.delete(objectKey);
    }
    expect(runner).not.toHaveBeenCalled();
    expect(await counts(f)).toEqual(before);

    runner.mockImplementationOnce(async (context) => ({
      advice: { ...advice(context), apiUrl: 'https://model-supplied.invalid' },
      execution,
    }));
    const invalid = await call(f, 'POST', path, request);
    expect(invalid.statusCode, invalid.body).toBe(502);
    expect(invalid.json().error.code).toBe('investigation_result_invalid');
    expect(runner).toHaveBeenCalledOnce();
    expect(await counts(f)).toEqual(before);

    await observe(f, flightId, true);
    const pending = await displayed(f, flightId);
    expect(pending.flight.outstandingWork).toBeGreaterThan(0);
    const pendingCounts = await counts(f);
    const unfinished = await call(f, 'POST', path, requestFor(pending));
    expect(unfinished.statusCode, unfinished.body).toBe(409);
    expect(unfinished.json().error.code).toBe('investigation_context_unavailable');
    expect(runner).toHaveBeenCalledOnce();
    expect(await counts(f)).toEqual(pendingCounts);
    await drain(f);

    const refreshed = await displayed(f, flightId);
    const beforeAuthorityChange = await counts(f);
    runner.mockImplementationOnce(async (context) => {
      const changed = await admin.query('UPDATE principals SET revision=revision+1 WHERE tenant_id=$1 AND id=$2', [
        f.tenantId,
        `${f.tenantId}:human`,
      ]);
      expect(changed.rowCount).toBe(1);
      return { advice: advice(context), execution };
    });
    const authorityChanged = await call(f, 'POST', path, requestFor(refreshed));
    expect(authorityChanged.statusCode, authorityChanged.body).toBe(409);
    expect(authorityChanged.json().error.code).toBe('investigation_basis_changed');
    expect(authorityChanged.json()).not.toHaveProperty('proposal');
    expect(authorityChanged.json()).not.toHaveProperty('execution');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(await counts(f)).toEqual(beforeAuthorityChange);
  });
});
