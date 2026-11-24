import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  RetainedDocumentSource,
  RuleEvaluationRecord,
  RulePackVersion,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  defineCheckedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { rotorIcingObservation, rotorIcingType } from '../unit/rotor-icing-observation.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// The rule, its observation type and its pack exist only in this test.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Shadow and active adoption modes on PostgreSQL', () => {
  const prefix = `adoption-mode-${randomUUID()}`;
  const tenantId = `${prefix}:tenant`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-sensor`;
  const type = 'rotor.mode-reading';
  let app: Awaited<ReturnType<typeof createApp>>;
  let artifactId: string;

  const rule = defineCheckedRule({
    id: 'test.mode-temperature-floor',
    version: 1,
    title: 'Outside air stays above the floor',
    source: {
      kind: 'operator_procedure',
      reference: 'Fictional procedure 9.1',
      text: 'Stop while the outside air is at or below zero Celsius.',
    },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'subject', type, versions: [1], about: 'target', required: true, select: 'latest' }],
    check: {
      kind: findCheckKind('value.within-limit', 1)!,
      params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above', limit: 0 },
    },
  });
  const content = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional floor procedure',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [rule],
  };
  const pack: RulePackVersion = { ...content, digest: canonicalDigest(content) };

  // An invented retained document with one paragraph quoted as in-force text and one as proposed text.
  const documentId = `${prefix}-notice`;
  const documentBytes = Buffer.from(
    '<p>Invented rules.</p>\n    (a) Keep a record of each person.\n    (b) Keep a record of each aircraft.\n',
  );
  function quoted(kind: RetainedDocumentSource['kind'], paragraph: string): RetainedDocumentSource {
    const start = documentBytes.indexOf(paragraph);
    return {
      kind,
      reference: `Invented section 1${paragraph.trim().slice(0, 3)}`,
      text: paragraph,
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(paragraph),
      sha256: sha256(Buffer.from(paragraph)),
      textSpan: { start, end: start + Buffer.byteLength(paragraph), unit: 'utf8_byte', sourceId: documentId },
      document: {
        sourceId: documentId,
        url: 'https://example.invalid/invented-rules.htm',
        sha256: sha256(documentBytes),
        byteLength: documentBytes.length,
        contentType: 'text/html; charset=utf-8',
        readPath: `/v1/rule-sources/${documentId}/content`,
      },
    };
  }
  function quotedRule(id: string, source: RetainedDocumentSource) {
    return defineCheckedRule({
      id,
      version: 1,
      title: 'Person record held',
      source,
      target: { subjectKind: 'person' },
      reads: [
        { name: 'record', type: 'operator.record', versions: [1], about: 'target', required: false, select: 'latest' },
      ],
      check: {
        kind: findCheckKind('record.complete', 2)!,
        params: { recordType: 'person.standing', recordVersion: 1 },
      },
    });
  }
  function quotingPack(packId: string, leaves: RulePackVersion['leaves']): RulePackVersion {
    const quotingContent = { ...content, packId, title: 'Fictional quoted rules', leaves };
    return { ...quotingContent, digest: canonicalDigest(quotingContent) };
  }
  const inForce = quoted('regulation', '    (a) Keep a record of each person.\n');
  const proposedText = quoted('proposed_regulation', '    (b) Keep a record of each aircraft.\n');
  const inForcePack = quotingPack(`${prefix}.in-force`, [quotedRule('test.mode-in-force', inForce)]);
  const mixedPack = quotingPack(`${prefix}.mixed`, [
    quotedRule('test.mode-in-force', inForce),
    quotedRule('test.mode-proposed', proposedText),
  ]);
  const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional adopter' };
  const actor: AuthContext = {
    ...base,
    id: `${tenantId}:actor`,
    capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt', 'input:write'],
  };
  const worker: AuthContext = {
    ...base,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read'],
  };
  const source: AuthContext = {
    ...base,
    id: `${tenantId}:source`,
    kind: 'source',
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  const interval = {
    start: new Date(Date.now() - 60_000).toISOString(),
    end: new Date(Date.now() + 3_600_000).toISOString(),
  };

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function coverage(): Promise<OrganizationCoverageResponse> {
    const response = await call(actor, 'GET', '/v1/organization/coverage');
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function retained(packId: string, version: number): Promise<RulePackVersion> {
    const response = await call(actor, 'GET', `/v1/rule-packs/${encodeURIComponent(packId)}/versions/${version}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().pack;
  }
  async function draft(
    shown: RulePackVersion,
    mode: PackAdoptionCommand['mode'],
    extra: Partial<PackAdoptionCommand> = {},
  ): Promise<PackAdoptionCommand> {
    return { ...adoptShownPack(await coverage(), shown, interval, 'Fictional adoption mode review.', mode), ...extra };
  }
  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await runOwnedWork(admin, workerPool, [prefix])) continue;
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }
  async function upload(): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional reading log' }));
    const created = await call(source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${source.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  async function report(sourceEventId: string, celsius: number): Promise<void> {
    const observation = rotorIcingObservation(
      {
        subject: { kind: 'aircraft', id: 'tail-9', scope: 'source' },
        sourceEventId,
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        values: { severity: 'light', outsideAirTemperatureCelsius: celsius },
      },
      type,
    );
    const response = await call(source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt: observation.occurredAt,
      payload: { ...observation, originalArtifactId: artifactId },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }
  const subjectQuery = new URLSearchParams({
    subjectKind: 'aircraft',
    subjectId: 'tail-9',
    subjectScope: 'source',
    sourceId,
  }).toString();
  async function evaluations(): Promise<RuleEvaluationRecord[]> {
    const response = await call(actor, 'GET', `/v1/evaluations?${subjectQuery}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }
  async function findings(): Promise<SubjectFindingRecord[]> {
    const response = await call(actor, 'GET', `/v1/findings?${subjectQuery}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }

  beforeAll(async () => {
    registerObservationTypes(rotorIcingType(type));
    registerRulePack({ packId: pack.packId, versions: [pack] });
    const { document } = inForce;
    registerRulePack({
      packId: inForcePack.packId,
      versions: [inForcePack],
      sources: [{ ...document, filename: 'invented-rules.htm', bytes: documentBytes }],
    });
    registerRulePack({ packId: mixedPack.packId, versions: [mixedPack] });
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional mode operator']);
    for (const principal of [actor, worker, source]) {
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${principal.id}`),
        principal.id,
      ]);
    }
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: [{ sourceId, observationType: type }],
    });
    expect(granted.statusCode, granted.body).toBe(201);
    artifactId = await upload();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('lists every registered pack version a person may adopt', async () => {
    const listed = await call(actor, 'GET', '/v1/rule-packs');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().packs).toContainEqual({
      packId: pack.packId,
      version: 1,
      title: pack.title,
      digest: pack.digest,
      origin: { kind: 'built_in' },
    });
  });

  it('requires a mode and adopts a pack that cites proposed text only in shadow', async () => {
    const { mode: _mode, ...modeless } = await draft(pack, 'active');
    const missing = await call(actor, 'POST', '/v1/commands', modeless);
    expect(missing.statusCode, missing.body).toBe(400);

    const proposed = await retained('ledger.part108-nprm', 1);
    const refused = await call(actor, 'POST', '/v1/commands', await draft(proposed, 'active'));
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'adoption_mode_refused' });
    expect(refused.json().error.message).toContain('proposed rule text, which is not in force');

    const builtIn = await retained('ledger.demo-procedures', 3);
    const unrecordable = await call(actor, 'POST', '/v1/commands', await draft(builtIn, 'shadow'));
    expect(unrecordable.statusCode, unrecordable.body).toBe(400);
    expect(unrecordable.json().error.code).toBe('adoption_mode_refused');

    const shadow = await call(actor, 'POST', '/v1/commands', await draft(proposed, 'shadow'));
    expect(shadow.statusCode, shadow.body).toBe(201);
    await settle();
    const adopted = (await coverage()).adoptions.find((item) => item.id === shadow.json().command.id);
    expect(adopted).toMatchObject({ mode: 'shadow', state: 'effective', pack: { packId: proposed.packId } });
  });

  it('stamps evaluations with the mode in effect, and a mode change is a new revision that rewrites nothing', async () => {
    const shadow = await call(actor, 'POST', '/v1/commands', await draft(pack, 'shadow'));
    expect(shadow.statusCode, shadow.body).toBe(201);
    const shadowId = shadow.json().command.id as string;
    await settle();
    await report('reading-1', -3);
    const [first] = await evaluations();
    expect(first).toMatchObject({ outcome: 'attention', adoption: { id: shadowId, mode: 'shadow' } });
    const [shadowFinding] = await findings();
    expect(shadowFinding).toMatchObject({ mode: 'shadow', status: 'open', latestEvaluation: { id: first!.id } });

    const unchanged = await call(actor, 'POST', '/v1/commands', await draft(pack, 'shadow', { revises: shadowId }));
    expect(unchanged.statusCode, unchanged.body).toBe(400);
    expect(unchanged.json().error.code).toBe('adoption_unchanged');
    const overlapping = await call(actor, 'POST', '/v1/commands', await draft(pack, 'active'));
    expect(overlapping.statusCode, overlapping.body).toBe(409);
    expect(overlapping.json().error.code).toBe('adoption_interval_overlap');

    const active = await call(actor, 'POST', '/v1/commands', await draft(pack, 'active', { revises: shadowId }));
    expect(active.statusCode, active.body).toBe(201);
    const activeId = active.json().command.id as string;
    await settle();
    const shown = (await coverage()).adoptions;
    expect(shown.find((item) => item.id === shadowId)).toMatchObject({
      mode: 'shadow',
      state: 'revised',
      revisedBy: activeId,
    });
    expect(shown.find((item) => item.id === activeId)).toMatchObject({
      mode: 'active',
      state: 'effective',
      revises: shadowId,
    });
    const again = await call(actor, 'POST', '/v1/commands', await draft(pack, 'active', { revises: shadowId }));
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('adoption_already_revised');

    // The mode change evaluates the subject again without waiting for new data.
    const [reevaluated, before] = await evaluations();
    expect(reevaluated).toMatchObject({
      outcome: 'attention',
      adoption: { id: activeId, mode: 'active' },
      trigger: { kind: 'adoption', eventId: activeId },
      evidence: first!.evidence,
    });
    expect(before).toEqual(first);
    const [reevaluatedFinding] = await findings();
    expect(reevaluatedFinding).toMatchObject({ id: shadowFinding!.id, mode: 'active', status: 'open' });

    await report('reading-2', -5);
    const [latest, , earlier] = await evaluations();
    expect(latest).toMatchObject({ outcome: 'attention', adoption: { id: activeId, mode: 'active' } });
    expect(earlier).toEqual(first);
    const recorded = await admin.query(
      `SELECT e.payload->'evaluation'->'adoption'->>'mode' AS mode FROM journal_events e WHERE e.id=$1`,
      [first!.id],
    );
    expect(recorded.rows[0].mode).toBe('shadow');
    const [finding] = await findings();
    expect(finding).toMatchObject({
      id: shadowFinding!.id,
      mode: 'active',
      initialEvaluation: { id: first!.id, adoption: { mode: 'shadow' } },
      latestEvaluation: { id: latest!.id, adoption: { mode: 'active' } },
    });
    const rows = await admin.query(
      'SELECT id,mode,revises_id FROM organization_pack_adoptions WHERE tenant_id=$1 AND pack_id=$2 ORDER BY accepted_revision',
      [tenantId, pack.packId],
    );
    expect(rows.rows).toEqual([
      { id: shadowId, mode: 'shadow', revises_id: null },
      { id: activeId, mode: 'active', revises_id: shadowId },
    ]);
  });

  it('adopts a pack quoting only in-force text in active mode, and refuses one that also quotes proposed text', async () => {
    const mixed = await call(actor, 'POST', '/v1/commands', await draft(await retained(mixedPack.packId, 1), 'active'));
    expect(mixed.statusCode, mixed.body).toBe(400);
    expect(mixed.json().error).toMatchObject({ code: 'adoption_mode_refused' });
    const shown = await retained(inForcePack.packId, 1);
    expect(shown.leaves.map((leaf) => leaf.source.kind)).toEqual(['regulation']);
    const active = await call(actor, 'POST', '/v1/commands', await draft(shown, 'active'));
    expect(active.statusCode, active.body).toBe(201);
    await settle();
  });
});
