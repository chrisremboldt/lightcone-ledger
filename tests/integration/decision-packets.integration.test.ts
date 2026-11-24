import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  processRuleSelectionLease,
  runDueRuleEvaluations,
  type RuleSelectionLease,
} from '../../apps/workers/src/index.js';
import { projectOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';
import type {
  Command,
  CommandLinkInput,
  CommandLinkSource,
  DecisionPacket,
  DecisionPacketRecord,
  DecisionPacketV2,
  EvaluationRecord,
  EvidenceEnvelope,
  FindingRecord,
  FlightRuleSelectionRecordV2,
  Input,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/index.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from '../../packages/domain/src/rules/command-link-evidence-v1.js';
import { recordRetainedCommandLinkEvaluations } from './retained-command-link-evaluation.js';
import { recordRetainedCommandLinkReport } from './retained-command-link-intake.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { canonicalDigest, canonicalize, entryHash, sha256 } from '../../packages/integrity/src/index.js';
import { createDecisionPacket } from '../../packages/evidence/src/decision-packets.js';
import {
  appendEvent,
  createPool,
  MemoryObjectStore,
  withScope,
  type AuthContext,
  type DomainError,
  type ObjectReadOptions,
} from '../../packages/persistence/src/index.js';
import { verifyDecisionPacket } from '../../tools/verifier/decision-packet.mjs';
import { verifyDecisionPacketV2 } from '../../tools/verifier/decision-packet-v2.mjs';
import { verifyBundle } from '../../tools/verifier/index.mjs';

class CountingObjectStore extends MemoryObjectStore {
  reads: string[] = [];
  override async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array> {
    this.reads.push(key);
    return super.get(key, options);
  }
}

type Role = 'operator' | 'source' | 'reader';
interface Fixture {
  tenantId: string;
  sourceId: string;
  operator: AuthContext;
  worker: AuthContext;
  tokens: Record<Role, string>;
}

// Decision packets are no longer issued through the API: the route refuses new issues. These tests issue them with the
// retained assembly code, as they were issued before, and show that they stay readable, listed and verifiable.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL selected decision packets', () => {
  const prefix = `packet-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workers = createPool(process.env.WORKER_DATABASE_URL);
  const store = new CountingObjectStore();
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
    await workers.end();
  });

  async function fixture(name: string): Promise<Fixture> {
    const tenantId = `${prefix}:${name}`;
    const sourceId = `${tenantId}:command-link`;
    const tokens = {} as Record<Role, string>;
    const operator: AuthContext = {
      id: `${tenantId}:operator`,
      tenantId,
      name: 'Fictional packet reviewer',
      kind: 'human',
      capabilities: ['input:write', 'flight:create', 'flight:read', 'evidence:read', 'decision:write', 'pack:adopt'],
      revision: 1,
    };
    const worker: AuthContext = {
      ...operator,
      id: `${tenantId}:worker`,
      name: 'Fictional packet worker',
      kind: 'worker',
      // The generic evaluator reads observations as this worker.
      capabilities: ['flight:read', 'evidence:read'],
    };
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional packet operator']);
    for (const [role, capabilities] of Object.entries({
      operator: operator.capabilities,
      source: ['input:write', 'command-link:write'],
      reader: ['flight:read'],
    }) as [Role, string[]][]) {
      const id = `${tenantId}:${role}`;
      tokens[role] = `ledger-dev-${id}`;
      await admin.query(
        'INSERT INTO principals(id,tenant_id,name,kind,capabilities,command_link_sources) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          tenantId,
          role === 'operator' ? operator.name : `Fictional ${role}`,
          role === 'source' ? 'source' : 'human',
          capabilities,
          role === 'source' ? [sourceId] : [],
        ],
      );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(tokens[role]),
        id,
      ]);
    }
    await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
      worker.id,
      tenantId,
      worker.name,
      worker.capabilities,
    ]);
    return { tenantId, sourceId, operator, worker, tokens };
  }

  function call(
    f: Fixture,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    key = randomUUID(),
    role: Role = 'operator',
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

  /** Issues a packet in the older format as the retired route did. */
  function issueOlder(f: Fixture, body: { flightId: string; decisionId: string }): Promise<DecisionPacketRecord> {
    return withScope(pool, f.operator, (client, principal) => createDecisionPacket(client, principal, body, store));
  }
  async function refusedOlder(f: Fixture, body: { flightId: string; decisionId: string }) {
    try {
      await issueOlder(f, body);
    } catch (error) {
      const { status, code } = error as DomainError;
      if (typeof status !== 'number') throw error;
      return { status, code };
    }
    throw new Error('The older packet was issued');
  }

  async function drain(f: Fixture): Promise<void> {
    await projectOwnedWork(admin, workers, [f.tenantId], { objectStore: store });
    // The older packet format covers retained lost-link evaluations only; this tenant adopted nothing, and its
    // reports are given the evaluations the retired evaluator recorded for them.
    await withScope(workers, f.worker, (client, principal) => recordRetainedCommandLinkEvaluations(client, principal));
  }

  async function flight(f: Fixture, name: string): Promise<string> {
    const response = await call(f, 'POST', '/v1/flights', { originationKey: `${f.tenantId}:${name}`, label: name });
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    return response.json().flight.id;
  }
  async function selectionDrain(f: Fixture) {
    for (let count = 0; count < 60; count++) {
      const lease = await withScope(workers, f.worker, async (client) => {
        const row = (
          await client.query<RuleSelectionLease>(`SELECT * FROM selection_work
          WHERE (state='pending' AND available_at<=clock_timestamp() AND due_at<=clock_timestamp())
            OR (state='leased' AND lease_until<clock_timestamp())
          ORDER BY available_at,id LIMIT 1 FOR UPDATE`)
        ).rows[0];
        if (!row) return null;
        const leased = (
          await client.query<RuleSelectionLease>(
            `UPDATE selection_work SET state='leased',generation=generation+1,
          lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$2 RETURNING *`,
            [prefix, row.id],
          )
        ).rows[0];
        return { ...leased, worker_id: f.worker.id };
      });
      if (!lease) return;
      expect(await processRuleSelectionLease(workers, lease)).toBe(true);
    }
    throw new Error('Selection fixture did not drain');
  }
  async function boundary(at: string) {
    await admin.query('SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp()),0)+0.03)', [at]);
  }
  function rewritePacket(packet: DecisionPacketV2, mutate: (event: EvidenceEnvelope) => void): DecisionPacketV2 {
    const changed = structuredClone(packet);
    changed.events = changed.events.map((entry) => {
      const event = JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope;
      mutate(event);
      const envelopeDigest = canonicalDigest(event);
      return {
        ...entry,
        canonicalEnvelope: canonicalize(event),
        envelopeDigest,
        entryHash: entryHash(
          event.tenantId,
          event.streamId,
          BigInt(event.sequence),
          entry.previousHash,
          envelopeDigest,
        ),
      };
    });
    for (const item of changed.manifest.inventory)
      if (item.kind === 'event')
        item.digest = canonicalDigest(
          changed.events.find((entry) => JSON.parse(entry.canonicalEnvelope).eventId === item.id)!,
        );
    changed.manifestDigest = canonicalDigest(changed.manifest);
    return changed;
  }
  async function thread(f: Fixture, id: string): Promise<TimelineResponse> {
    const response = await call(f, 'GET', `/v1/flights/${id}/timeline`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function finding(shown: TimelineResponse): FindingRecord {
    const value = shown.findings?.find((item) => item.latestEvaluation.leafId === COMMAND_LINK_LOSS_LEAF_ID);
    expect(value).toBeDefined();
    return value!;
  }
  function command(
    shown: TimelineResponse,
    action?: 'acknowledge' | 'respond' | 'resolve',
    selected = action ? finding(shown) : undefined,
  ): Command {
    return {
      kind: 'decision.record',
      flightId: shown.flight.id,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      ...(selected && action
        ? { findingTreatment: { findingId: selected.id, evaluationId: selected.latestEvaluation.id, action } }
        : {}),
      decision: { kind: action ? `finding.${action}` : 'review', note: 'Reviewed the retained flight evidence.' },
    };
  }
  async function treat(f: Fixture, flightId: string, action: 'acknowledge' | 'respond' | 'resolve'): Promise<string> {
    const response = await call(f, 'POST', '/v1/commands', command(await thread(f, flightId), action));
    expect(response.statusCode, response.body).toBe(201);
    await drain(f);
    return response.json().command.id;
  }
  function report(f: Fixture, eventId: string, overrides: Partial<CommandLinkSource> = {}): CommandLinkSource {
    return {
      sourceSessionId: `${f.tenantId}:session`,
      sourceEventId: eventId,
      incidentId: `${f.tenantId}:incident`,
      aircraftId: 'fictional-aircraft',
      occurredAt: '2026-10-01T17:00:00.000Z',
      status: 'lost',
      ...overrides,
    };
  }
  async function observe(
    f: Fixture,
    flightId: string,
    raw: CommandLinkSource,
    byteLength?: number,
  ): Promise<{ eventId: string; artifactId: string }> {
    const bytes = Buffer.from(byteLength ? JSON.stringify(raw).padEnd(byteLength, ' ') : `${JSON.stringify(raw)}\n`);
    const uploaded = await call(
      f,
      'POST',
      '/v1/uploads',
      { byteLength: bytes.length, contentType: 'application/json' },
      randomUUID(),
      'source',
    );
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const uploadId = uploaded.json().upload.id;
    const written = await call(f, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, randomUUID(), 'source');
    expect(written.statusCode, written.body).toBe(200);
    const finalized = await call(f, 'POST', `/v1/uploads/${uploadId}/finalize`, undefined, randomUUID(), 'source');
    expect(finalized.statusCode, finalized.body).toBe(201);
    const { sourceSessionId, occurredAt, ...payload } = raw;
    const input: CommandLinkInput = {
      sourceId: f.sourceId,
      sourceSessionId,
      kind: 'command-link.status',
      occurredAt,
      subject: { flightId },
      artifactId: finalized.json().artifact.id,
      fidelity: 'synthetic_contract',
      payload,
    };
    // Packets of the older format were issued over reports the retired intake recorded; record one as it did.
    const receipt = await recordRetainedCommandLinkReport(
      pool,
      { id: `${f.tenantId}:source`, tenantId: f.tenantId },
      input,
      store,
    );
    return { eventId: receipt.eventId, artifactId: input.artifactId };
  }

  it('isolates and retries retained C2 resolution packets while later evidence and legacy exports stay independent', async () => {
    const f = await fixture('retained');
    const foreign = await fixture('foreign');
    const flightId = await flight(f, 'retained C2 resolution');
    const loss = await observe(f, flightId, report(f, 'loss-one'));
    await drain(f);
    const acknowledgement = await treat(f, flightId, 'acknowledge');
    const restoration = await observe(
      f,
      flightId,
      report(f, 'restoration-one', { status: 'restored', occurredAt: '2026-10-01T17:00:30.000Z' }),
    );
    await drain(f);
    const selectedEvaluation = finding(await thread(f, flightId)).latestEvaluation;
    const decisionId = await treat(f, flightId, 'resolve');
    const legacyKey = randomUUID();
    const legacyRequest = { flightId, decisionId, scope: 'whole_tenant_prefixes' };
    const legacy = await call(f, 'POST', '/v1/exports', legacyRequest, legacyKey);
    expect(legacy.statusCode, legacy.body).toBe(201);
    const legacyRecord = legacy.json().record;
    const legacyContent = await call(f, 'GET', `/v1/exports/${legacyRecord.id}/content`);
    expect(verifyBundle(legacyContent.json(), { expectedManifestDigest: legacyRecord.manifestDigest }).status).toBe(
      'verified',
    );

    const request = { flightId, decisionId };
    const record = await issueOlder(f, request);
    expect(record).toMatchObject({ format: 'ledger.decision-packet.1', flightId, decisionId });
    const content = await call(f, 'GET', `/v1/decision-packets/${record.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['x-evidence-format']).toBe('ledger.decision-packet.1');
    expect(content.headers['x-content-sha256']).toBe(record.packetSha256);
    expect(content.headers['x-manifest-sha256']).toBe(record.manifestDigest);
    expect(sha256(content.rawPayload)).toBe(record.packetSha256);
    const packet = content.json<DecisionPacket>();
    expect(verifyDecisionPacket(packet, { expectedManifestDigest: record.manifestDigest })).toMatchObject({
      status: 'verified',
      decisionId,
      evaluationId: selectedEvaluation.id,
    });
    const events = packet.events.map(
      (entry: { canonicalEnvelope: string }) => JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope,
    );
    expect(events.map((event: EvidenceEnvelope) => event.eventId)).toEqual(
      expect.arrayContaining([decisionId, selectedEvaluation.id, loss.eventId, restoration.eventId]),
    );
    expect(packet.artifacts.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([loss.artifactId, restoration.artifactId]),
    );
    // The route no longer issues decision packets, for a new key or for the decision a packet was issued for.
    for (const body of [request, { flightId, decisionId: acknowledgement }]) {
      const refused = await call(f, 'POST', '/v1/decision-packets', body);
      expect(refused.statusCode, refused.body).toBe(410);
      expect(refused.json().error).toMatchObject({
        code: 'decision_packet_retired',
        message: expect.stringMatching(/no longer issued.*finding packet/),
      });
    }
    const listed = await call(f, 'GET', `/v1/decision-packets?flightId=${flightId}&decisionId=${decisionId}`);
    expect(listed.json()).toEqual({ records: [record], limit: 20, hasMore: false, requestId: expect.any(String) });
    expect((await call(f, 'GET', `/v1/decision-packets/${record.id}`)).json()).toEqual({
      record,
      requestId: expect.any(String),
    });
    for (const path of [`/v1/decision-packets/${record.id}`, `/v1/decision-packets/${record.id}/content`]) {
      expect((await call(foreign, 'GET', path)).statusCode).toBe(404);
      expect((await call(f, 'GET', path, undefined, randomUUID(), 'reader')).statusCode).toBe(403);
    }
    expect((await call(foreign, 'GET', '/v1/decision-packets')).json().records).toEqual([]);
    const outside = await withScope(pool, foreign.operator, (client) =>
      client.query('SELECT id FROM decision_packet_records WHERE id=$1', [record.id]),
    );
    expect(outside.rowCount).toBe(0);
    await expect(
      admin.query('UPDATE decision_packet_records SET metadata=metadata WHERE id=$1', [record.id]),
    ).rejects.toThrow('append-only');
    expect((await call(f, 'POST', '/v1/decision-packets', request, randomUUID(), 'reader')).statusCode).toBe(403);
    expect((await call(f, 'GET', '/v1/decision-packets', undefined, randomUUID(), 'reader')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/decision-packets' })).statusCode).toBe(401);
    expect(
      (await call(f, 'POST', '/v1/decision-packets', { ...request, scope: 'whole_tenant_prefixes' })).statusCode,
    ).toBe(400);

    const tampered = structuredClone(packet);
    tampered.manifest.issuedAt = new Date(Date.now() + 60_000).toISOString();
    tampered.manifestDigest = canonicalDigest(tampered.manifest);
    expect(() => verifyDecisionPacket(tampered, { expectedManifestDigest: record.manifestDigest })).toThrow(
      'Manifest differs from its independently retained digest',
    );
    const laterLoss = await observe(f, flightId, report(f, 'loss-two', { occurredAt: '2026-10-01T17:01:00.000Z' }));
    await drain(f);
    await treat(f, flightId, 'respond');
    const laterRestoration = await observe(
      f,
      flightId,
      report(f, 'restoration-two', { status: 'restored', occurredAt: '2026-10-01T17:01:30.000Z' }),
    );
    await drain(f);
    await treat(f, flightId, 'resolve');
    expect(finding(await thread(f, flightId)).latestEvaluation.id).not.toBe(selectedEvaluation.id);
    expect((await call(f, 'GET', `/v1/decision-packets/${record.id}/content`)).rawPayload).toEqual(content.rawPayload);
    const fresh = await issueOlder(f, request);
    const freshContent = (await call(f, 'GET', `/v1/decision-packets/${fresh.id}/content`)).json<DecisionPacket>();
    expect(freshContent.events).toEqual(packet.events);
    expect(freshContent.receipts).toEqual(packet.receipts);
    expect(freshContent.artifacts).toEqual(packet.artifacts);
    expect(
      freshContent.events.map(
        (entry: { canonicalEnvelope: string }) => (JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope).eventId,
      ),
    ).not.toEqual(expect.arrayContaining([laterLoss.eventId, laterRestoration.eventId]));
    const legacyRetry = await call(f, 'POST', '/v1/exports', legacyRequest, legacyKey);
    expect(legacyRetry.json().record).toEqual(legacyRecord);
    expect((await call(f, 'GET', `/v1/exports/${legacyRecord.id}/content`)).rawPayload).toEqual(
      legacyContent.rawPayload,
    );
    expect((await call(f, 'GET', `/v1/exports?flightId=${flightId}&decisionId=${decisionId}`)).json().records).toEqual([
      legacyRecord,
    ]);
    expect((await call(f, 'GET', `/v1/exports/${record.id}`)).statusCode).toBe(404);
    expect((await call(f, 'GET', `/v1/decision-packets/${legacyRecord.id}`)).statusCode).toBe(404);
  });

  it('rejects ordinary decisions and landing treatments without claiming a selected C2 evidence set', async () => {
    const f = await fixture('unsupported');
    // The landing checks run on the generic evaluator for an organization that adopted the procedures.
    const now = Date.now();
    const adopted = await call(
      f,
      'POST',
      '/v1/commands',
      adoptShownPack(
        (await call(f, 'GET', '/v1/organization/coverage')).json(),
        getRulePackVersion('ledger.demo-procedures', 4)!,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await drain(f);
    const flightId = await flight(f, 'unsupported packet decisions');
    const ordinary = await call(f, 'POST', '/v1/commands', command(await thread(f, flightId)));
    expect(ordinary.statusCode, ordinary.body).toBe(201);
    await drain(f);
    for (const [sourceId, landingTime] of [
      ['live', '2026-10-01T17:00:00.000Z'],
      ['buffered', '2026-10-01T17:01:00.000Z'],
    ]) {
      const input: Input = {
        sourceId: `${f.tenantId}:${sourceId}`,
        kind: 'flight.observation',
        occurredAt: landingTime,
        subject: { flightId },
        payload: { activity: 'landed', landingTime },
      };
      const response = await call(f, 'POST', '/v1/inputs', input);
      expect(response.statusCode, response.body).toBe(201);
    }
    await drain(f);
    while (await withOwnedWork(admin, [f.tenantId], () => runDueRuleEvaluations(workers, { limit: 100 })))
      await drain(f);
    const shown = await thread(f, flightId);
    const landing = shown.findings!.find(
      (item) => item.latestEvaluation.leafId === 'ledger.demo.landing-disagreement',
    )!;
    expect(landing).toBeDefined();
    const acknowledgement = await call(f, 'POST', '/v1/commands', command(shown, 'acknowledge', landing));
    expect(acknowledgement.statusCode, acknowledgement.body).toBe(201);
    for (const decisionId of [ordinary.json().command.id, acknowledgement.json().command.id]) {
      store.reads.length = 0;
      expect(await refusedOlder(f, { flightId, decisionId })).toEqual({
        status: 409,
        code: 'unsupported_decision_packet',
      });
      expect(store.reads).toEqual([]);
    }
    expect((await call(f, 'GET', '/v1/decision-packets')).json().records).toEqual([]);
  });

  it('issues and verifies selected envelopes above the source parser limit within the packet envelope budget', async () => {
    const f = await fixture('large-envelope');
    const flightId = await flight(f, 'large retained cuts');
    const loss = await observe(f, flightId, report(f, 'loss-one'));
    await drain(f);
    const evaluationId = finding(await thread(f, flightId)).latestEvaluation.id;
    const acknowledgement = await treat(f, flightId, 'acknowledge');
    const shown = await thread(f, flightId);
    const originals = await admin.query<{ id: string; immutable_envelope: string }>(
      'SELECT id,immutable_envelope FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[])',
      [f.tenantId, [evaluationId, acknowledgement]],
    );
    const originalEvaluation = JSON.parse(
      originals.rows.find((row) => row.id === evaluationId)!.immutable_envelope,
    ) as EvidenceEnvelope;
    const originalDecision = JSON.parse(
      originals.rows.find((row) => row.id === acknowledgement)!.immutable_envelope,
    ) as EvidenceEnvelope;
    const basis = structuredClone(originalDecision.payload.acceptedFindingBasis) as EvaluationRecord;
    const streamIds = Array.from({ length: 1000 }, () => randomUUID());
    const emptyPositions = Object.fromEntries(streamIds.map((id) => [id, 0]));
    basis.inputCut.streams = { ...basis.inputCut.streams, ...emptyPositions };
    basis.acceptedInputCut.streams = { ...basis.acceptedInputCut.streams, ...emptyPositions };
    const target = await withScope(pool, f.operator, async (client, principal) => {
      await client.query(
        `INSERT INTO streams(id,tenant_id,name)
         SELECT id,$1,'packet-large-cut:'||id FROM unnest($2::text[]) AS retained(id)`,
        [f.tenantId, streamIds],
      );
      const { id: _id, recordedAt: _recordedAt, rule: _rule, ...result } = basis;
      const evaluated = await appendEvent(client, f.worker, {
        type: 'evaluation.recorded',
        stream: `packet-large-evaluation:${flightId}`,
        causationId: loss.eventId,
        payload: { ...originalEvaluation.payload, evaluation: result },
      });
      basis.id = evaluated.id;
      basis.recordedAt = evaluated.received_at.toISOString();
      const cut = {
        ...shown.meta.inputCut,
        streams: {
          ...shown.meta.inputCut.streams,
          ...emptyPositions,
          [evaluated.stream_id]: Number(evaluated.stream_sequence),
        },
      };
      const note = 'Reviewed the selected C2 evidence with a large retained cut.';
      const decided = await appendEvent(client, principal, {
        type: 'decision.record',
        stream: `flight:${flightId}`,
        payload: {
          ...originalDecision.payload,
          expectedRevision: shown.flight.revision,
          expectedBasisRevision: shown.flight.basisRevision,
          inputCut: cut,
          acceptedInputCut: cut,
          acceptedFindingBasis: basis,
          findingTreatment: { findingId: finding(shown).id, evaluationId: evaluated.id, action: 'acknowledge' },
          decision: { kind: 'finding.acknowledge', note },
        },
      });
      await client.query(
        'INSERT INTO decisions(id,tenant_id,flight_id,actor_id,kind,note,recorded_at,rendered_input_cut,accepted_input_cut,accepted_basis_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)',
        [
          decided.id,
          f.tenantId,
          flightId,
          principal.id,
          'finding.acknowledge',
          note,
          decided.received_at,
          cut,
          shown.flight.basisRevision,
        ],
      );
      return { decisionId: decided.id, evaluationId: evaluated.id };
    });
    const selected = await admin.query<{ id: string; bytes: number }>(
      'SELECT id,octet_length(immutable_envelope) AS bytes FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[])',
      [f.tenantId, [target.decisionId, target.evaluationId]],
    );
    expect(selected.rowCount).toBe(2);
    for (const entry of selected.rows) {
      expect(entry.bytes).toBeGreaterThan(64 * 1024);
      expect(entry.bytes).toBeLessThanOrEqual(256 * 1024);
    }
    const record = await issueOlder(f, { flightId, decisionId: target.decisionId });
    const content = await call(f, 'GET', `/v1/decision-packets/${record.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    const packet = content.json<DecisionPacket>();
    expect(verifyDecisionPacket(packet, { expectedManifestDigest: record.manifestDigest })).toMatchObject({
      status: 'verified',
      decisionId: target.decisionId,
      evaluationId: target.evaluationId,
    });
    expect(packet.artifacts).toHaveLength(1);
    expect(packet.artifacts[0]).toMatchObject({ id: loss.artifactId });
    expect(packet.artifacts[0].byteLength).toBeLessThan(1024);
  });

  it('fails closed when a retained evaluation declares a C2 event that is absent from immutable history', async () => {
    const f = await fixture('missing-reference');
    const flightId = await flight(f, 'missing retained C2 reference');
    await observe(f, flightId, report(f, 'loss-one'));
    await drain(f);
    const evaluation = finding(await thread(f, flightId)).latestEvaluation;
    const acknowledgement = await treat(f, flightId, 'acknowledge');
    const rows = await admin.query<{ id: string; immutable_envelope: string }>(
      'SELECT id,immutable_envelope FROM journal_events WHERE tenant_id=$1 AND id=ANY($2::text[])',
      [f.tenantId, [evaluation.id, acknowledgement]],
    );
    const originalEvaluation = JSON.parse(
      rows.rows.find((row) => row.id === evaluation.id)!.immutable_envelope,
    ) as EvidenceEnvelope;
    const originalDecision = JSON.parse(
      rows.rows.find((row) => row.id === acknowledgement)!.immutable_envelope,
    ) as EvidenceEnvelope;
    const basis = structuredClone(originalDecision.payload.acceptedFindingBasis) as EvaluationRecord;
    if (!('kind' in basis.explanation) || basis.explanation.kind !== 'command_link')
      throw new Error('Expected typed C2 evidence');
    const absent = randomUUID();
    basis.explanation.evidence[0].eventId = absent;
    basis.explanation.groups[0].lossEventIds = [absent];
    const decisionId = await withScope(pool, f.operator, async (client, principal) => {
      const { id: _id, recordedAt: _recordedAt, rule: _rule, ...result } = basis;
      const evaluated = await appendEvent(client, principal, {
        type: 'evaluation.recorded',
        stream: `packet-reference-fixture:${flightId}`,
        causationId: absent,
        payload: { ...originalEvaluation.payload, evaluation: result },
      });
      basis.id = evaluated.id;
      basis.recordedAt = evaluated.received_at.toISOString();
      const shown = await thread(f, flightId);
      const cut = {
        ...shown.meta.inputCut,
        streams: { ...shown.meta.inputCut.streams, [evaluated.stream_id]: Number(evaluated.stream_sequence) },
      };
      const note = 'A synthetic retained reference must fail closed.';
      const retained = await appendEvent(client, principal, {
        type: 'decision.record',
        stream: `flight:${flightId}`,
        payload: {
          ...originalDecision.payload,
          inputCut: cut,
          acceptedInputCut: cut,
          acceptedFindingBasis: basis,
          findingTreatment: { findingId: finding(shown).id, evaluationId: evaluated.id, action: 'acknowledge' },
          decision: { kind: 'finding.acknowledge', note },
        },
      });
      await client.query(
        'INSERT INTO decisions(id,tenant_id,flight_id,actor_id,kind,note,recorded_at,rendered_input_cut,accepted_input_cut,accepted_basis_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)',
        [
          retained.id,
          f.tenantId,
          flightId,
          principal.id,
          'finding.acknowledge',
          note,
          retained.received_at,
          cut,
          shown.flight.basisRevision,
        ],
      );
      return retained.id;
    });
    store.reads.length = 0;
    expect(await refusedOlder(f, { flightId, decisionId })).toEqual({
      status: 409,
      code: 'decision_packet_reference_invalid',
    });
    expect(store.reads).toEqual([]);
    expect((await call(f, 'GET', `/v1/decision-packets?decisionId=${decisionId}`)).json().records).toEqual([]);
  });

  it('rejects an over-budget selected original set before reading any object bytes', async () => {
    const f = await fixture('original-budget');
    const flightId = await flight(f, 'bounded originals');
    for (let index = 0; index < 17; index++) {
      await observe(
        f,
        flightId,
        report(f, `loss-${index}`, { occurredAt: `2026-10-01T17:00:${String(index).padStart(2, '0')}.000Z` }),
        64 * 1024,
      );
    }
    await drain(f);
    const decisionId = await treat(f, flightId, 'acknowledge');
    store.reads.length = 0;
    expect(await refusedOlder(f, { flightId, decisionId })).toEqual({
      status: 429,
      code: 'decision_packet_budget_exceeded',
    });
    expect(store.reads).toEqual([]);
    expect((await call(f, 'GET', `/v1/decision-packets?decisionId=${decisionId}`)).json().records).toEqual([]);
  });
});
