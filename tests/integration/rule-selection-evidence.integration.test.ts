import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  processLease,
  processRuleSelectionLease,
  type RuleSelectionLease,
  type WorkLease,
} from '../../apps/workers/src/index.js';
import type {
  Command,
  EvidenceEnvelope,
  ExportResponse,
  FlightEvidenceBundle,
  FlightRuleSelectionResponse,
  OrganizationCoverageResponse,
  RulePackVersionResponse,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL rule-selection evidence compatibility', () => {
  const prefix = `selection-evidence-${randomUUID()}`;
  const tenantId = `${prefix}:tenant`;
  const token = `ledger-dev-${prefix}`;
  const operator: AuthContext = {
    id: `${prefix}:operator`,
    tenantId,
    name: 'Fictional selection reviewer',
    kind: 'human',
    capabilities: ['flight:create', 'flight:read', 'evidence:read', 'decision:write', 'pack:adopt'],
    revision: 1,
  };
  const worker: AuthContext = {
    ...operator,
    id: `${prefix}:worker`,
    name: 'Fictional selection worker',
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read'],
  };
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workers = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
      tenantId,
      'Fictional selection evidence operator',
    ]);
    for (const principal of [operator, worker])
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(token),
      operator.id,
    ]);
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix], { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workers.end();
  });

  function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    });
  }

  async function drain(): Promise<void> {
    for (let index = 0; index < 40; index++) {
      const work = await withScope(workers, worker, async (client) => {
        const candidate = (
          await client.query<WorkLease>(
            `SELECT w.* FROM work_items w WHERE w.state='pending' AND w.available_at<=clock_timestamp()
           AND NOT EXISTS(SELECT 1 FROM journal_events e WHERE e.tenant_id=w.tenant_id AND e.id=w.event_id AND e.event_type='flight.rule-selection.recorded')
           AND NOT EXISTS(SELECT 1 FROM work_items p WHERE p.stream_id=w.stream_id AND p.stream_sequence<w.stream_sequence AND p.state NOT IN ('completed','failed'))
           ORDER BY w.available_at,w.id LIMIT 1 FOR UPDATE`,
          )
        ).rows[0];
        if (!candidate) return undefined;
        const row = (
          await client.query<WorkLease>(
            "UPDATE work_items SET state='leased',generation=generation+1,lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$2 RETURNING *",
            [prefix, candidate.id],
          )
        ).rows[0];
        return { ...row, worker_id: worker.id };
      });
      if (work) {
        expect(await processLease(workers, work, { objectStore: store })).toBe(true);
        continue;
      }
      const selection = await withScope(workers, worker, async (client) => {
        const candidate = (
          await client.query<RuleSelectionLease>(
            "SELECT * FROM selection_work WHERE state='pending' AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT 1 FOR UPDATE",
          )
        ).rows[0];
        if (!candidate) return undefined;
        const row = (
          await client.query<RuleSelectionLease>(
            "UPDATE selection_work SET state='leased',generation=generation+1,attempts=attempts+1,lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$2 RETURNING *",
            [prefix, candidate.id],
          )
        ).rows[0];
        return { ...row, worker_id: worker.id };
      });
      if (!selection) return;
      expect(await processRuleSelectionLease(workers, selection)).toBe(true);
    }
    throw new Error('Selection evidence fixture did not drain');
  }

  it('retains a rendered selection as an opaque flight-v2 effect without supplying historical decision authority or basis', async () => {
    const packRead = await call('GET', '/v1/rule-packs/ledger.demo-procedures/versions/5');
    expect(packRead.statusCode, packRead.body).toBe(200);
    const pack = packRead.json<RulePackVersionResponse>().pack;
    const coverage = (await call('GET', '/v1/organization/coverage')).json<OrganizationCoverageResponse>();
    const now = Date.now();
    const adoption = await call(
      'POST',
      '/v1/commands',
      adoptShownPack(
        coverage,
        pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 60 * 60_000).toISOString() },
        'Retain the exact company procedure selection without activating execution.',
        'active',
      ),
    );
    expect(adoption.statusCode, adoption.body).toBe(201);
    await drain();
    const created = await call('POST', '/v1/flights', { originationKey: prefix, label: 'Selected company procedure' });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await drain();
    const read = await call('GET', `/v1/flights/${flightId}/rule-selection`);
    expect(read.statusCode, read.body).toBe(200);
    const shownSelection = read.json<FlightRuleSelectionResponse>();
    expect(shownSelection.convergence.status).toBe('current');
    const selection = shownSelection.selection!;
    expect(selection).toMatchObject({
      flightId,
      selection: { state: 'eligible', adoption: { id: adoption.json().command.id } },
      execution: { status: 'active', evaluator: { id: 'ledger.rule-evaluator' } },
    });
    expect(canonicalDigest(selection.basisManifest)).toBe(selection.dependencyBasis);
    const rendered = (
      await admin.query<{ state: string; sequence: string; projected_sequence: string }>(
        `SELECT w.state,e.stream_sequence::text AS sequence,p.sequence::text AS projected_sequence
       FROM journal_events e JOIN work_items w ON w.tenant_id=e.tenant_id AND w.event_id=e.id
       JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id
       WHERE e.tenant_id=$1 AND e.id=$2`,
        [tenantId, selection.id],
      )
    ).rows[0];
    expect(rendered.state).toBe('completed');
    expect(Number(rendered.projected_sequence)).toBeGreaterThanOrEqual(Number(rendered.sequence));
    const shown = (await call('GET', `/v1/flights/${flightId}/timeline`)).json<TimelineResponse>();
    const decision: Command = {
      kind: 'decision.record',
      flightId,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      decision: { kind: 'review', note: 'Reviewed the flight with the retained company selection.' },
    };
    const accepted = await call('POST', '/v1/commands', decision);
    expect(accepted.statusCode, accepted.body).toBe(201);
    await drain();
    const issued = await call('POST', '/v1/exports', {
      flightId,
      decisionId: accepted.json().command.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const record = issued.json<ExportResponse>().record;
    const content = await call('GET', `/v1/exports/${record.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    const bundle = content.json<FlightEvidenceBundle>();
    expect(verifyBundle(bundle, { expectedManifestDigest: record.manifestDigest }).status).toBe('verified');
    expect(bundle.format).toBe('ledger.flight-evidence.2');
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    expect(bundle.actor.historicalProfile).toBe('not_retained');
    const effect = bundle.entries
      .map((entry) => JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope)
      .find((event) => event.eventId === selection.id)!;
    expect(effect).toMatchObject({
      type: 'flight.rule-selection.recorded',
      artifactId: null,
      payload: { selection, declaredSubjects: [flightId] },
    });
    expect(bundle.receipts.some((receipt) => receipt.eventId === selection.id)).toBe(false);
    for (const inventory of [bundle.interpretations.rendered, bundle.interpretations.accepted])
      expect(inventory.events.find((event) => event.eventId === selection.id)?.type).toBe(
        'flight.rule-selection.recorded',
      );
  });
});
