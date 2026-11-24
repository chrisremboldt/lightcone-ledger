import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { drainOwnedWork, settleOwnedWork } from './worker-queue.js';
import type {
  Capability,
  SmsAssessmentOutcome,
  SmsDecisionInput,
  SmsExportRecord,
  SmsRecordContentResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
} from '../../packages/contracts/src/index.js';
import { exampleRiskMatrix } from '../../packages/domain/src/sms-example-matrix.js';
import { controlTypeDigest, registerControlType, type ControlType } from '../../packages/domain/src/control-types.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { verifySmsExport } from '../../tools/verifier/sms-export.mjs';
import { adoptShownPack, reviewShownAdoption } from '../../packages/contracts/fixtures/demo/v1/ready.js';

type Role = 'safety' | 'executive' | 'pilot' | 'operator';

// A control type that exists only in this test: registering it is all a new control needs.
const heaterControl: ControlType<{ aircraftId: string; minimumMinutes: number }> = {
  id: 'toy.rotor-heater-preflight',
  version: 1,
  title: 'Toy rotor heater preflight',
  description: 'Run the fictional rotor heater for a minimum time before flight.',
  appliesTo: ['aircraft', 'time_window'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['aircraftId', 'minimumMinutes'],
    properties: {
      aircraftId: { type: 'string', minLength: 1, maxLength: 200 },
      minimumMinutes: { type: 'integer', minimum: 1, maximum: 60 },
    },
  },
  checkedAutomatically: true,
  describe: ({ aircraftId, minimumMinutes }) => `Run the rotor heater on ${aircraftId} for ${minimumMinutes} minutes`,
};
interface Tenant {
  id: string;
  token: Record<Role, string>;
  principal: Record<Role, string>;
}

const roles: Record<Role, { name: string; kind: 'human'; capabilities: Capability[] }> = {
  safety: {
    name: 'Fictional Safety Manager',
    kind: 'human',
    capabilities: [
      'sms:read',
      'sms:write',
      'sms:configure',
      'sms:restricted:read',
      'sms:report:read',
      'decision:write',
      'evidence:read',
      'input:write',
      'risk:accept:low',
      'risk:accept:medium',
    ],
  },
  executive: {
    name: 'Fictional Accountable Executive',
    kind: 'human',
    capabilities: [
      'sms:read',
      'sms:adopt',
      'sms:restricted:read',
      'decision:write',
      'evidence:read',
      'risk:accept:low',
      'risk:accept:medium',
      'risk:accept:high',
    ],
  },
  pilot: { name: 'Fictional Pilot', kind: 'human', capabilities: ['sms:read', 'input:write', 'evidence:read'] },
  operator: {
    name: 'Fictional Program Operator',
    kind: 'human',
    capabilities: ['flight:create', 'flight:read', 'input:write', 'decision:write', 'evidence:read', 'pack:adopt'],
  },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL SMS record envelope and signatures', () => {
  const prefix = `sms-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const worker = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
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
    await worker.end();
  });

  async function tenant(name: string): Promise<Tenant> {
    const id = `${prefix}:${name}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [id, `Fictional utility ${name}`]);
    const token = {} as Record<Role, string>;
    const principal = {} as Record<Role, string>;
    for (const [role, person] of Object.entries(roles) as [Role, (typeof roles)[Role]][]) {
      principal[role] = `${id}:${role}`;
      token[role] = `ledger-dev-${id}:${role}`;
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal[role],
        id,
        person.name,
        person.kind,
        person.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(token[role]),
        principal[role],
      ]);
    }
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Worker','worker',$3)",
      [`${id}:worker`, id, ['input:write', 'flight:create', 'flight:read', 'evidence:read']],
    );
    return { id, token, principal };
  }
  function call(token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = {}) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function command(token: string, payload: unknown, headers = {}) {
    const response = await call(token, 'POST', '/v1/commands', payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as { id: string; subject: { id: string } };
  }
  async function detail(t: Tenant, id: string, role: Role = 'safety'): Promise<SmsRecordDetailResponse> {
    const response = await call(t.token[role], 'GET', `/v1/sms/records/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function preview(
    t: Tenant,
    id: string,
    role: Role,
    meaning: 'risk.accept' | 'matrix.adopt' | 'document.adopt',
  ) {
    const response = await call(t.token[role], 'GET', `/v1/sms/records/${id}/signing?meaning=${meaning}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as SmsSigningPreviewResponse;
  }
  async function grant(t: Tenant, role: Role) {
    const response = await call(t.token[role], 'POST', '/v1/local/reauthentications', { credential: t.token[role] });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().grant as string;
  }
  function decide(
    t: Tenant,
    id: string,
    shown: { revision: number; dependencyBasis: string },
    decision: SmsDecisionInput,
  ) {
    return {
      kind: 'decision.record' as const,
      subject: { kind: 'sms' as const, id },
      expectedRevision: shown.revision,
      expectedDependencyBasis: shown.dependencyBasis,
      decision,
    };
  }
  async function upload(t: Tenant, bytes: Buffer, confidentiality: 'ordinary' | 'restricted_asset_information') {
    const created = await call(t.token.safety, 'POST', '/v1/uploads', {
      contentType: 'text/plain',
      byteLength: bytes.byteLength,
      filename: 'fictional-asset-notes.txt',
      confidentiality,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ${t.token.safety}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(t.token.safety, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return { uploadId: id, artifact: finalized.json().artifact as { id: string; confidentiality: string } };
  }
  async function attach(t: Tenant, recordId: string, uploadId: string, label: string) {
    const shown = await detail(t, recordId);
    return command(t.token.safety, {
      kind: 'sms.attachment.add',
      recordId,
      expectedRevision: shown.basis.revision,
      attachment: { uploadId, label },
    });
  }
  async function program(t: Tenant) {
    const matrix = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'risk_matrix',
        schema: 'sms.risk-matrix.1',
        title: 'Program safety risk matrix',
        ownerId: t.principal.executive,
        body: exampleRiskMatrix,
      },
    });
    const shown = await preview(t, matrix.subject.id, 'executive', 'matrix.adopt');
    expect(shown.available, shown.reason).toBe(true);
    await command(
      t.token.executive,
      decide(t, matrix.subject.id, shown.basis, {
        kind: 'matrix.adopt',
        note: 'Adopting the program matrix for fictional testing.',
        versionNumber: 1,
        signature: { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': await grant(t, 'executive') },
    );
    return matrix.subject.id;
  }
  async function hazard(t: Tenant, title = 'Drone loses link near energized line') {
    const opened = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title,
        ownerId: t.principal.safety,
        dueAt: '2027-02-01T17:00:00Z',
        body: {
          description: 'Command link degrades when inspecting lines near the fictional river crossing.',
          consequence: 'Uncontrolled descent onto an energized conductor.',
          source: { kind: 'manual_identification' },
        },
      },
    });
    return opened.subject.id;
  }
  async function assess(t: Tenant, id: string, residual = { severity: 'hazardous', likelihood: 'remote' }) {
    const shown = await detail(t, id);
    await command(
      t.token.safety,
      decide(t, id, shown.basis, {
        kind: 'risk.assess',
        note: 'Assessed with the line crew.',
        matrix: { recordId: shown.matrix!.record.id, versionNumber: shown.matrix!.version.versionNumber },
        initial: { severity: 'catastrophic', likelihood: 'probable' },
        controls: (shown.controls ?? [])
          .filter((control) => control.status !== 'closed')
          .map((control) => ({ recordId: control.id, versionNumber: control.versionNumber })),
        residual,
        newHazardCheck: { answer: 'none_identified' },
      }),
    );
    return detail(t, id);
  }
  async function acceptAsExecutive(t: Tenant, id: string, headers?: Record<string, string>) {
    const shown = await preview(t, id, 'executive', 'risk.accept');
    expect(shown.available, shown.reason).toBe(true);
    const current = await detail(t, id, 'executive');
    return call(
      t.token.executive,
      'POST',
      '/v1/commands',
      decide(t, id, shown.basis, {
        kind: 'risk.accept',
        note: 'Residual risk accepted with the listed controls in place.',
        assessmentId: current.record.residual ? current.decisions.find((d) => d.kind === 'risk.assess')!.id : '',
        signature: { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true },
      }),
      headers ?? { 'x-ledger-reauthentication': await grant(t, 'executive') },
    );
  }
  async function drain() {
    await drainOwnedWork(admin, worker, [prefix], { objectStore: store });
  }
  async function exportRecord(t: Tenant, id: string) {
    const created = await call(t.token.safety, 'POST', '/v1/sms/exports', { recordId: id });
    expect(created.statusCode, created.body).toBe(201);
    const record = created.json().export as SmsExportRecord;
    const content = await call(t.token.safety, 'GET', `/v1/sms/exports/${record.id}/content`);
    expect(content.statusCode, content.body).toBe(200);
    return { record, bytes: content.rawPayload };
  }

  it('assesses a flight-independent hazard on the adopted matrix with a server-computed level', async () => {
    const t = await tenant('assess');
    const matrixId = await program(t);
    const id = await hazard(t);
    const opened = await detail(t, id);
    expect(opened.record).toMatchObject({ kind: 'hazard', status: 'identified', recordClass: 'srm_output' });
    expect(opened.record.confidentiality).toBe('ordinary');
    const sent = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decide(t, id, opened.basis, {
        kind: 'risk.assess',
        note: 'Client-chosen level',
        matrix: { recordId: matrixId, versionNumber: 1 },
        initial: { severity: 'minor', likelihood: 'remote', level: 'low' } as never,
        controls: [],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      }),
    );
    expect(sent.statusCode).toBe(400);
    const assessed = await assess(t, id);
    expect(assessed.record.status).toBe('awaiting_acceptance');
    const outcome = assessed.decisions[0].outcome as { initial: { level: string }; residual: { level: string } };
    expect(outcome.initial.level).toBe('high');
    expect(outcome.residual.level).toBe('high');
    const home = (await call(t.token.executive, 'GET', '/v1/sms/home')).json();
    expect(home.attention.waitingOnMe.map((item: { id: string }) => item.id)).toEqual([id]);
    expect(home.attention.awaitingAcceptance.map((item: { id: string }) => item.id)).toEqual([id]);
    const safetyHome = (await call(t.token.safety, 'GET', '/v1/sms/home')).json();
    expect(safetyHome.attention.waitingOnMe).toEqual([]);
  });

  it('refuses risk acceptance above the signer’s authority', async () => {
    const t = await tenant('authority');
    await program(t);
    const id = await hazard(t);
    const assessed = await assess(t, id);
    const shown = await preview(t, id, 'safety', 'risk.accept');
    expect(shown.available).toBe(false);
    expect(shown.reason).toMatch(/authority to accept high risk/);
    expect(assessed.actions.accept.available).toBe(false);
    const refused = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decide(t, id, assessed.basis, {
        kind: 'risk.accept',
        note: 'Trying to accept above authority.',
        assessmentId: assessed.decisions[0].id,
        signature: { intent: 'I accept.', contentDigest: '0'.repeat(64), reviewed: true },
      }),
      { 'x-ledger-reauthentication': await grant(t, 'safety') },
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('risk_authority_insufficient');
    const medium = await hazard(t, 'Bird strike during tower climb');
    await assess(t, medium, { severity: 'major', likelihood: 'remote' });
    expect((await preview(t, medium, 'safety', 'risk.accept')).available).toBe(true);
  });

  it('refuses SMS decisions from a service principal that holds the capability', async () => {
    const t = await tenant('agent');
    await program(t);
    const id = await hazard(t);
    const assessed = await assess(t, id);
    const agent = `${t.id}:agent`;
    const agentToken = `ledger-dev-${agent}`;
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Fictional agent','service',$3)",
      [agent, t.id, ['sms:read', 'sms:write', 'decision:write', 'evidence:read', 'risk:accept:high']],
    );
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(agentToken),
      agent,
    ]);
    const refused = await call(
      agentToken,
      'POST',
      '/v1/commands',
      decide(t, id, assessed.basis, {
        kind: 'risk.accept',
        note: 'An agent tries to accept the residual risk.',
        assessmentId: assessed.decisions[0].id,
        signature: { intent: 'I accept.', contentDigest: '0'.repeat(64), reviewed: true },
      }),
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('person_required');
    expect((await detail(t, id)).record.status).toBe('awaiting_acceptance');
  });

  it('requires a fresh single-use re-authentication and binds the signature to the signed content', async () => {
    const t = await tenant('signature');
    await program(t);
    const id = await hazard(t);
    await assess(t, id);
    const missing = await acceptAsExecutive(t, id, {});
    expect(missing.statusCode, missing.body).toBe(403);
    expect(missing.json().error.code).toBe('reauthentication_required');
    const wrong = await call(t.token.executive, 'POST', '/v1/local/reauthentications', { credential: t.token.safety });
    expect(wrong.statusCode).toBe(401);
    const shown = await preview(t, id, 'executive', 'risk.accept');
    const assessment = (await detail(t, id)).decisions[0].id;
    const reused = await grant(t, 'executive');
    const tampered = await call(
      t.token.executive,
      'POST',
      '/v1/commands',
      decide(t, id, shown.basis, {
        kind: 'risk.accept',
        note: 'Accepting different content.',
        assessmentId: assessment,
        signature: { intent: shown.intent!, contentDigest: canonicalDigest({ other: true }), reviewed: true },
      }),
      { 'x-ledger-reauthentication': reused },
    );
    expect(tampered.statusCode, tampered.body).toBe(409);
    expect(tampered.json().error.code).toBe('signed_content_changed');
    const accepted = await acceptAsExecutive(t, id, { 'x-ledger-reauthentication': reused });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const second = await hazard(t, 'Second hazard for grant reuse');
    await assess(t, second);
    const replayedGrant = await acceptAsExecutive(t, second, { 'x-ledger-reauthentication': reused });
    expect(replayedGrant.statusCode).toBe(403);
    const record = await detail(t, id);
    expect(record.record.status).toBe('accepted');
    const [signature] = record.signatures;
    expect(signature).toMatchObject({ meaning: 'risk.accept', signer: { id: t.principal.executive } });
    expect(signature.contentDigest).toBe(canonicalDigest(signature.content));
    expect(signature.contentDigest).toBe(shown.contentDigest);
    expect(signature.content.intent).toBe(shown.intent);
    expect(signature.authority).toMatchObject({
      principalId: t.principal.executive,
      satisfyingCapability: 'risk:accept:high',
    });
    expect(signature.reauthentication).toMatchObject({ method: 'local_fixture' });
    expect(JSON.stringify(signature.reauthentication)).not.toContain(reused);
    expect(record.decisions[0]).toMatchObject({ kind: 'risk.accept', signature: { id: signature.id } });
    const stored = await admin.query('SELECT content_canonical,content_digest FROM sms_signatures WHERE id=$1', [
      signature.id,
    ]);
    expect(sha256(stored.rows[0].content_canonical)).toBe(stored.rows[0].content_digest);
    await expect(admin.query("UPDATE sms_signatures SET intent='changed' WHERE id=$1", [signature.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(admin.query('DELETE FROM sms_signatures WHERE id=$1', [signature.id])).rejects.toThrow(/append-only/);
    const events = await admin.query('SELECT payload::text FROM journal_events WHERE tenant_id=$1', [t.id]);
    for (const row of events.rows) expect(row.payload).not.toContain(reused);
  });

  it('conflicts when the record or its matrix changes after the basis was shown', async () => {
    const t = await tenant('stale');
    const matrixId = await program(t);
    const id = await hazard(t);
    await assess(t, id);
    const shown = await preview(t, id, 'executive', 'risk.accept');
    const assessment = (await detail(t, id)).decisions[0].id;
    const notes = await upload(t, Buffer.from('Ordinary crew briefing notes.'), 'ordinary');
    await attach(t, id, notes.uploadId, 'Crew briefing notes');
    const stale = await call(
      t.token.executive,
      'POST',
      '/v1/commands',
      decide(t, id, shown.basis, {
        kind: 'risk.accept',
        note: 'Accepting the earlier view.',
        assessmentId: assessment,
        signature: { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': await grant(t, 'executive') },
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('stale_basis');
    const refreshed = await preview(t, id, 'executive', 'risk.accept');
    const matrix = await detail(t, matrixId);
    await command(t.token.safety, {
      kind: 'sms.record.revise',
      recordId: matrixId,
      expectedRevision: matrix.basis.revision,
      record: {
        kind: 'risk_matrix',
        schema: 'sms.risk-matrix.1',
        title: 'Program safety risk matrix (draft revision)',
        ownerId: t.principal.executive,
        body: { ...exampleRiskMatrix, name: 'Program safety risk matrix, draft 2' },
      },
    });
    expect((await preview(t, id, 'executive', 'risk.accept')).basis.dependencyBasis).not.toBe(
      refreshed.basis.dependencyBasis,
    );
    const dependencyMoved = await call(
      t.token.executive,
      'POST',
      '/v1/commands',
      decide(t, id, refreshed.basis, {
        kind: 'risk.accept',
        note: 'Accepting before seeing the matrix draft.',
        assessmentId: assessment,
        signature: { intent: refreshed.intent!, contentDigest: refreshed.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': await grant(t, 'executive') },
    );
    expect(dependencyMoved.statusCode, dependencyMoved.body).toBe(409);
    expect(dependencyMoved.json().error.code).toBe('stale_basis');
    await drain();
    const accepted = await acceptAsExecutive(t, id);
    expect(accepted.statusCode, accepted.body).toBe(201);
  });

  it('keeps a restricted attachment out of the SMS export and every existing export path', async () => {
    const t = await tenant('restricted');
    await program(t);
    const id = await hazard(t);
    const marker = `RESTRICTED-${randomUUID()}`;
    const restrictedBytes = Buffer.from(`${marker}: fictional substation 14 access route and gate layout.`);
    const restricted = await upload(t, restrictedBytes, 'restricted_asset_information');
    expect(restricted.artifact.confidentiality).toBe('restricted_asset_information');
    const ordinary = await upload(t, Buffer.from('Ordinary site photo caption.'), 'ordinary');
    const restrictedAttachment = await attach(t, id, restricted.uploadId, 'Substation access plan');
    await attach(t, id, ordinary.uploadId, 'Site photo caption');
    await assess(t, id);
    expect((await acceptAsExecutive(t, id)).statusCode).toBe(201);
    await drain();

    const digest = sha256(restrictedBytes);
    const base64 = restrictedBytes.toString('base64');
    const absent = (bytes: Buffer | string) => {
      const text = Buffer.from(bytes).toString('utf8');
      expect(text).not.toContain(marker);
      expect(text).not.toContain(base64);
    };
    expect((await admin.query('SELECT 1 FROM artifacts WHERE sha256=$1', [digest])).rowCount).toBe(0);
    expect(
      (await admin.query('SELECT 1 FROM journal_events WHERE artifact_id=$1', [restricted.artifact.id])).rowCount,
    ).toBe(0);
    const journal = await admin.query('SELECT payload::text AS payload FROM journal_events WHERE tenant_id=$1', [t.id]);
    for (const row of journal.rows) absent(row.payload);
    expect((await call(t.token.safety, 'GET', `/v1/artifacts/${restricted.artifact.id}/content`)).statusCode).toBe(404);
    const pilotRead = await call(t.token.pilot, 'GET', `/v1/sms/attachments/${restrictedAttachment.id}/content`);
    expect(pilotRead.statusCode).toBe(403);
    const managerRead = await call(t.token.safety, 'GET', `/v1/sms/attachments/${restrictedAttachment.id}/content`);
    expect(managerRead.statusCode).toBe(200);
    expect(managerRead.rawPayload.equals(restrictedBytes)).toBe(true);
    expect(
      (await admin.query('SELECT 1 FROM sms_restricted_disclosures WHERE attachment_id=$1', [restrictedAttachment.id]))
        .rowCount,
    ).toBe(1);

    const exported = await exportRecord(t, id);
    absent(exported.bytes);
    expect(exported.record.withheld).toEqual([
      expect.objectContaining({
        kind: 'attachment',
        id: restrictedAttachment.id,
        confidentiality: 'restricted_asset_information',
        sha256: digest,
      }),
    ]);
    const bundle = JSON.parse(exported.bytes.toString('utf8'));
    const verified = verifySmsExport(bundle, { expectedManifestDigest: exported.record.manifestDigest });
    expect(verified).toMatchObject({ status: 'verified', counts: { signatures: 2, attachments: 1, withheld: 1 } });
    expect(bundle.manifest.scope.recordIds).toHaveLength(2);

    const tamperedSignature = structuredClone(bundle);
    const acceptance = tamperedSignature.signatures.find(
      (signature: { meaning: string }) => signature.meaning === 'risk.accept',
    );
    acceptance.content.statement.residualRisk.level = 'Low';
    expect(() => verifySmsExport(tamperedSignature)).toThrow(/manifest digest|section/i);
    tamperedSignature.manifest.sectionDigests.signatures = canonicalDigest(tamperedSignature.signatures);
    tamperedSignature.manifestDigest = canonicalDigest(tamperedSignature.manifest);
    expect(() => verifySmsExport(tamperedSignature)).toThrow(/signed content does not match/i);
    const undeclared = structuredClone(bundle);
    undeclared.withheld = [];
    undeclared.manifest.sectionDigests.withheld = canonicalDigest([]);
    undeclared.manifestDigest = canonicalDigest(undeclared.manifest);
    expect(() => verifySmsExport(undeclared)).toThrow(/withheld declaration/i);

    const operator = (role: Role) => t.token[role];
    const flight = await call(operator('operator'), 'POST', '/v1/flights', {
      originationKey: `${t.id}:flight`,
      label: 'Fictional inspection flight',
    });
    expect(flight.statusCode, flight.body).toBe(201);
    await drain();
    const thread = (await call(operator('operator'), 'GET', `/v1/flights/${flight.json().flight.id}/timeline`)).json();
    const flightDecision = await command(operator('operator'), {
      kind: 'decision.record',
      flightId: thread.flight.id,
      expectedRevision: thread.flight.revision,
      expectedBasisRevision: thread.flight.basisRevision,
      inputCut: thread.meta.inputCut,
      expectedDependencyBasis: thread.meta.dependencyBasis,
      decision: { kind: 'review', note: 'Reviewed the fictional flight.' },
    });
    await drain();
    const flightExport = await call(operator('operator'), 'POST', '/v1/exports', {
      flightId: thread.flight.id,
      decisionId: flightDecision.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(flightExport.statusCode, flightExport.body).toBe(201);
    absent(
      (await call(operator('operator'), 'GET', `/v1/exports/${flightExport.json().record.id}/content`)).rawPayload,
    );

    const coverage = (await call(operator('operator'), 'GET', '/v1/organization/coverage')).json();
    const pack = (await call(operator('operator'), 'GET', '/v1/rule-packs/ledger.part108-nprm/versions/1')).json().pack;
    const now = Date.now();
    await command(
      operator('operator'),
      adoptShownPack(
        coverage,
        pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 60_000).toISOString() },
        'Adopt for the fictional export check.',
        'shadow',
      ),
    );
    await drain();
    const adoption = (await call(operator('operator'), 'GET', '/v1/organization/coverage')).json().adoptions[0];
    const review = await command(
      operator('operator'),
      reviewShownAdoption(
        (await call(operator('operator'), 'GET', '/v1/organization/decisions')).json(),
        adoption,
        'Reviewed for the fictional export check.',
      ),
    );
    await drain();
    const subjectExport = await call(operator('operator'), 'POST', '/v1/subject-exports', {
      subject: { kind: 'organization' },
      decisionId: review.id,
      scope: 'whole_tenant_prefixes',
    });
    expect(subjectExport.statusCode, subjectExport.body).toBe(201);
    absent(
      (await call(operator('operator'), 'GET', `/v1/subject-exports/${subjectExport.json().record.id}/content`))
        .rawPayload,
    );
  });

  it('keeps safety report content and its reporter behind the audited boundary', async () => {
    const t = await tenant('report');
    const other = await tenant('report-other');
    const hazardId = await hazard(t);
    const marker = `REPORT-${randomUUID()}`;
    const reporter = `Reporter-${randomUUID()}`;
    const report = (narrative: string) => ({
      kind: 'report',
      schema: 'sms.report.1',
      title: `${marker} drone drifted over the yard`,
      ownerId: t.principal.safety,
      links: [{ relation: 'cites', target: { kind: 'sms_record', id: hazardId } }],
      body: {
        narrative: `${marker}: ${narrative}`,
        siteReference: 'Fictional north yard',
        received: { channel: 'phone' },
        reporter: { name: reporter, contact: `${reporter}@example.test` },
      },
    });
    const editor = `${t.id}:editor`;
    const editorToken = `ledger-dev-${editor}`;
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Fictional SMS editor','human',$3)",
      [editor, t.id, ['sms:read', 'sms:write', 'evidence:read']],
    );
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(editorToken),
      editor,
    ]);
    const uncleared = await call(editorToken, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: report('Recorded by someone not cleared to read reports.'),
    });
    expect(uncleared.statusCode, uncleared.body).toBe(403);
    const ordinary = await call(t.token.safety, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      confidentiality: 'ordinary',
      record: report('Recorded as an ordinary record.'),
    });
    expect(ordinary.statusCode, ordinary.body).toBe(400);

    const openCommand = {
      kind: 'sms.record.open',
      record: report('The fictional crew chief saw the aircraft drift over the yard fence.'),
    };
    const openKey = { 'idempotency-key': randomUUID() };
    const opened = await command(t.token.safety, openCommand, openKey);
    const replayed = await call(t.token.safety, 'POST', '/v1/commands', openCommand, openKey);
    expect(replayed.json().command.id).toBe(opened.id);
    const id = opened.subject.id;
    const shown = await detail(t, id, 'pilot');
    expect(shown.record).toMatchObject({
      kind: 'report',
      status: 'received',
      confidentiality: 'safety_report',
      recordClass: 'safety_assurance_output',
    });
    expect(shown.record.title).toMatch(/^Safety report recorded \d{4}-\d{2}-\d{2}$/);
    expect(shown.current.body).toBeNull();
    expect(shown.actions.readContent.available).toBe(false);
    expect((await call(t.token.pilot, 'GET', `/v1/sms/records/${id}/content`)).statusCode).toBe(403);
    expect((await call(other.token.safety, 'GET', `/v1/sms/records/${id}/content`)).statusCode).toBe(404);
    const refusedRevision = await call(editorToken, 'POST', '/v1/commands', {
      kind: 'sms.record.revise',
      recordId: id,
      expectedRevision: shown.basis.revision,
      record: report('Revised by someone not cleared to read reports.'),
    });
    expect(refusedRevision.statusCode, refusedRevision.body).toBe(403);
    const revised = await command(t.token.safety, {
      kind: 'sms.record.revise',
      recordId: id,
      expectedRevision: shown.basis.revision,
      record: report('Revised after a follow-up call with the reporter.'),
    });
    await drain();

    const current = await detail(t, id);
    expect(current.record.projectedRevision).toBe(current.record.revision);
    expect(current.actions.readContent.available).toBe(true);
    const read = await call(t.token.safety, 'GET', `/v1/sms/records/${id}/content`);
    expect(read.statusCode, read.body).toBe(200);
    const content = read.json() as SmsRecordContentResponse;
    expect(content.versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(content.versions[0].body.narrative).toContain('follow-up call');
    expect(content.versions[1].body.reporter).toEqual({ name: reporter, contact: `${reporter}@example.test` });
    expect(content.versions[0].links).toEqual([{ relation: 'cites', target: { kind: 'sms_record', id: hazardId } }]);
    expect(content.versions.map((version) => version.contentDigest)).toEqual(
      current.versions.map((version) => version.bodyDigest),
    );
    const disclosures = await admin.query(
      'SELECT principal_id,capability FROM sms_restricted_disclosures WHERE record_version_id=ANY($1)',
      [content.versions.map((version) => version.id)],
    );
    expect(disclosures.rows).toEqual([
      { principal_id: t.principal.safety, capability: 'sms:report:read' },
      { principal_id: t.principal.safety, capability: 'sms:report:read' },
    ]);

    const absent = (text: string, where: string) => {
      expect(text, where).not.toContain(marker);
      expect(text, where).not.toContain(reporter);
    };
    absent(JSON.stringify(opened) + JSON.stringify(revised), 'command responses');
    absent(replayed.body, 'command replay');
    for (const [where, sql] of [
      ['journal', 'SELECT payload::text AS text FROM journal_events WHERE tenant_id=$1'],
      ['commands', 'SELECT payload::text AS text FROM command_records WHERE tenant_id=$1'],
      ['idempotency', 'SELECT row_to_json(k)::text AS text FROM idempotency_keys k WHERE tenant_id=$1'],
      ['subjects', 'SELECT label AS text FROM subjects WHERE tenant_id=$1'],
      ['records', 'SELECT title AS text FROM sms_records WHERE tenant_id=$1'],
      ['work', 'SELECT row_to_json(w)::text AS text FROM work_items w WHERE tenant_id=$1'],
    ])
      for (const row of (await admin.query<{ text: string }>(sql, [t.id])).rows) absent(row.text, where);
    await expect(
      withScope(pool, { id: t.principal.safety, tenantId: t.id }, (client) =>
        client.query('SELECT title,body FROM sms_restricted_record_versions'),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withScope(pool, { id: t.principal.pilot, tenantId: t.id }, (client) =>
        client.query('SELECT * FROM ledger_disclose_sms_record_content($1)', [id]),
      ),
    ).rejects.toThrow(/needs sms:report:read/);
    await expect(
      admin.query("UPDATE sms_restricted_record_versions SET title='changed' WHERE record_id=$1", [id]),
    ).rejects.toThrow(/append-only/);

    const exported = await exportRecord(t, id);
    absent(exported.bytes.toString('utf8'), 'export');
    expect(exported.record.withheld).toEqual(
      [...current.versions].reverse().map((version) =>
        expect.objectContaining({
          kind: 'record_body',
          id: version.id,
          confidentiality: 'safety_report',
          sha256: version.bodyDigest,
        }),
      ),
    );
    expect(exported.record.scope.recordIds).toEqual([hazardId, id].sort());
    const bundle = JSON.parse(exported.bytes.toString('utf8'));
    expect(verifySmsExport(bundle, { expectedManifestDigest: exported.record.manifestDigest })).toMatchObject({
      status: 'verified',
      counts: { withheld: 2 },
    });
  });

  it('exports a period with its dependencies and a reading copy rendered from the bundle', async () => {
    const t = await tenant('period');
    const matrixId = await program(t);
    const hazardId = await hazard(t, 'Line strike <b>near</b> the substation');
    await assess(t, hazardId);
    expect((await acceptAsExecutive(t, hazardId)).statusCode).toBe(201);
    const marker = `PERIOD-${randomUUID()}`;
    const report = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: `${marker} report`,
        ownerId: t.principal.safety,
        links: [{ relation: 'cites', target: { kind: 'sms_record', id: hazardId } }],
        body: { narrative: `${marker} narrative`, received: { channel: 'email' } },
      },
    });
    const now = Date.now();
    const period = { from: new Date(now - 3_600_000).toISOString(), to: new Date(now + 3_600_000).toISOString() };
    const empty = await call(t.token.safety, 'POST', '/v1/sms/exports', {
      period: { from: '2020-01-01T00:00:00Z', to: '2020-04-01T00:00:00Z' },
    });
    expect(empty.statusCode, empty.body).toBe(404);
    expect(empty.json().error.code).toBe('no_activity_in_period');
    const backwards = await call(t.token.safety, 'POST', '/v1/sms/exports', {
      period: { from: period.to, to: period.from },
    });
    expect(backwards.statusCode, backwards.body).toBe(400);

    const created = await call(t.token.safety, 'POST', '/v1/sms/exports', { period });
    expect(created.statusCode, created.body).toBe(201);
    const record = created.json().export as SmsExportRecord;
    expect(record.recordId).toBeNull();
    expect(record.scope).toMatchObject({ kind: 'period', from: period.from, to: period.to });
    expect(record.scope.recordIds).toEqual([matrixId, hazardId, report.subject.id].sort());
    expect(record.withheld).toEqual([expect.objectContaining({ kind: 'record_body', recordId: report.subject.id })]);
    const content = await call(t.token.safety, 'GET', `/v1/sms/exports/${record.id}/content`);
    const bundle = JSON.parse(content.rawPayload.toString('utf8'));
    expect(verifySmsExport(bundle, { expectedManifestDigest: record.manifestDigest })).toMatchObject({
      status: 'verified',
      counts: { signatures: 2, withheld: 1 },
    });
    const narrowed = structuredClone(bundle);
    narrowed.manifest.scope.selectedRecordIds = ['someone-else'];
    narrowed.manifestDigest = canonicalDigest(narrowed.manifest);
    expect(() => verifySmsExport(narrowed)).toThrow(/selected record missing/i);

    const packet = await call(t.token.safety, 'GET', `/v1/sms/exports/${record.id}/packet`);
    expect(packet.statusCode, packet.body).toBe(200);
    expect(packet.headers['content-type']).toMatch(/^text\/html/);
    expect(packet.headers['x-manifest-sha256']).toBe(record.manifestDigest);
    expect(packet.body).toContain('Line strike &lt;b&gt;near&lt;/b&gt; the substation');
    expect(packet.body).toContain('Safety report (content withheld)');
    expect(packet.body).toContain('I, Fictional Accountable Executive');
    expect(packet.body).not.toContain(marker);
  });

  it('changes links without a new version, so acceptances and adoptions stay current', async () => {
    const t = await tenant('links');
    const other = await tenant('links-other');
    const matrixId = await program(t);
    const hazardId = await hazard(t);
    await assess(t, hazardId);
    expect((await acceptAsExecutive(t, hazardId)).statusCode).toBe(201);
    const opened = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.1',
        title: 'Energized line procedure',
        ownerId: t.principal.safety,
        body: { documentType: 'procedure', revisionLabel: 'Revision 1', summary: 'Stand-off distances.' },
      },
    });
    const documentId = opened.subject.id;
    const report = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: 'Fictional link loss report',
        ownerId: t.principal.safety,
        body: { narrative: 'Fictional narrative.', received: { channel: 'phone' } },
      },
    });
    const foreignId = await hazard(other);
    const cites = { relation: 'cites', target: { kind: 'sms_record', id: documentId } } as const;
    const fromReport = { relation: 'derived_from', target: { kind: 'sms_record', id: report.subject.id } } as const;
    const waiver = {
      relation: 'affects',
      target: { kind: 'external', label: 'Fictional waiver', reference: 'FV-107-0001' },
    } as const;
    const setLinks = (role: Role, recordId: string, revision: number, links: unknown[]) =>
      call(t.token[role], 'POST', '/v1/commands', {
        kind: 'sms.record.links',
        recordId,
        expectedRevision: revision,
        links,
      });

    const before = await detail(t, hazardId);
    expect(before.record.status).toBe('accepted');
    expect(before.actions.link.available).toBe(true);
    const linked = await setLinks('safety', hazardId, before.basis.revision, [cites, fromReport, waiver]);
    expect(linked.statusCode, linked.body).toBe(201);
    const after = await detail(t, hazardId);
    expect(after.record).toMatchObject({
      status: 'accepted',
      versionNumber: before.record.versionNumber,
      revision: before.basis.revision + 1,
    });
    expect(after.links.map((link) => link.record?.title ?? null)).toEqual([
      'Energized line procedure',
      expect.stringMatching(/^Safety report recorded /),
      null,
    ]);
    expect(after.linkChanges).toHaveLength(1);
    expect(after.linkChanges[0]).toMatchObject({ added: [cites, fromReport, waiver], removed: [] });
    expect((await detail(t, documentId)).linkedFrom).toEqual([
      { relation: 'cites', record: expect.objectContaining({ id: hazardId, kind: 'hazard', status: 'accepted' }) },
    ]);
    expect((await detail(t, report.subject.id)).linkedFrom).toEqual([
      { relation: 'derived_from', record: expect.objectContaining({ id: hazardId }) },
    ]);

    const matrix = await detail(t, matrixId);
    expect((await setLinks('safety', matrixId, matrix.basis.revision, [cites])).statusCode).toBe(201);
    const home = (await call(t.token.safety, 'GET', '/v1/sms/home')).json();
    expect(home.program.matrix.record.id).toBe(matrixId);
    expect((await detail(t, matrixId)).record.status).toBe('adopted');

    const stale = await setLinks('safety', hazardId, before.basis.revision, [cites]);
    expect(stale.statusCode, stale.body).toBe(409);
    const refusals = [
      [await setLinks('safety', hazardId, after.basis.revision, [cites, fromReport, waiver]), 400, 'links_unchanged'],
      [await setLinks('safety', hazardId, after.basis.revision, [cites, cites]), 400, 'duplicate_link'],
      [
        await setLinks('safety', hazardId, after.basis.revision, [
          { relation: 'cites', target: { kind: 'sms_record', id: hazardId } },
        ]),
        400,
        'link_to_self',
      ],
      [
        await setLinks('safety', hazardId, after.basis.revision, [
          { relation: 'cites', target: { kind: 'sms_record', id: foreignId } },
        ]),
        400,
        'link_target_unavailable',
      ],
      [await setLinks('safety', report.subject.id, 1, [cites]), 409, 'restricted_links'],
      [await setLinks('pilot', hazardId, after.basis.revision, [waiver]), 403, 'capability_required'],
    ] as const;
    for (const [response, status, code] of refusals) {
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error.code).toBe(code);
    }
    expect((await detail(t, report.subject.id)).actions.link.available).toBe(false);

    const removed = await setLinks('safety', hazardId, after.basis.revision, [waiver]);
    expect(removed.statusCode, removed.body).toBe(201);
    const latest = await detail(t, hazardId);
    expect(latest.linkChanges[0]).toMatchObject({ added: [], removed: [cites, fromReport] });
    expect((await detail(t, documentId)).linkedFrom).toEqual([
      { relation: 'cites', record: expect.objectContaining({ id: matrixId }) },
    ]);
    await drain();
    expect((await detail(t, hazardId)).record.projectedRevision).toBe(latest.basis.revision);

    const exported = await exportRecord(t, hazardId);
    const bundle = JSON.parse(exported.bytes.toString('utf8'));
    expect(verifySmsExport(bundle, { expectedManifestDigest: exported.record.manifestDigest }).status).toBe('verified');
    const exportedHazard = bundle.records.find((record: { id: string }) => record.id === hazardId);
    expect(exportedHazard.links).toEqual([waiver]);
    expect(exportedHazard.linkChanges).toHaveLength(2);
    const exportedReport = bundle.records.find((record: { id: string }) => record.id === report.subject.id);
    expect(exportedReport).toMatchObject({ links: [], linkChanges: [] });
    const leaky = structuredClone(bundle);
    leaky.records.find((record: { id: string }) => record.id === report.subject.id).links = [cites];
    leaky.manifest.sectionDigests.records = canonicalDigest(leaky.records);
    leaky.manifestDigest = canonicalDigest(leaky.manifest);
    expect(() => verifySmsExport(leaky)).toThrow(/restricted record carries links/i);
    const packet = await call(t.token.safety, 'GET', `/v1/sms/exports/${exported.record.id}/packet`);
    expect(packet.body).toContain('Link changes');
    expect(packet.body).toContain('Fictional waiver (FV-107-0001)');
  });

  it('adopts a document with a signature bound to its exact version and attached file', async () => {
    const t = await tenant('document');
    await program(t);
    const opened = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.1',
        title: 'Drone program safety policy',
        ownerId: t.principal.safety,
        body: { documentType: 'safety_policy', revisionLabel: 'Revision 1', summary: 'Objectives and commitment.' },
      },
    });
    const id = opened.subject.id;
    const file = Buffer.from('%PDF-1.4 fictional signed safety policy revision 1\n');
    const pdf = await upload(t, file, 'ordinary');
    const attached = await attach(t, id, pdf.uploadId, 'Signed policy PDF');
    const refused = await preview(t, id, 'safety', 'document.adopt');
    expect(refused.available).toBe(false);
    expect(refused.reason).toMatch(/adoption authority/);
    const shown = await preview(t, id, 'executive', 'document.adopt');
    expect(shown.intent).toBe(
      'I, Fictional Accountable Executive, adopt Revision 1 of the safety policy “Drone program safety policy” for this organization’s safety management system.',
    );
    expect(shown.content!.bindings).toContainEqual({
      kind: 'attachment',
      attachmentId: attached.id,
      sha256: sha256(file),
    });
    const adopt = (role: Role, basis = shown) =>
      decide(t, id, basis.basis, {
        kind: 'document.adopt',
        note: 'Adopting the first revision.',
        versionNumber: 1,
        signature: {
          intent: basis.intent ?? 'I adopt.',
          contentDigest: basis.contentDigest ?? '0'.repeat(64),
          reviewed: true,
        },
      });
    const denied = await call(t.token.safety, 'POST', '/v1/commands', adopt('safety', refused), {
      'x-ledger-reauthentication': await grant(t, 'safety'),
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('adoption_authority_insufficient');
    await command(t.token.executive, adopt('executive'), { 'x-ledger-reauthentication': await grant(t, 'executive') });
    const adopted = await detail(t, id);
    expect(adopted.record.status).toBe('adopted');
    expect(adopted.signatures[0]).toMatchObject({ meaning: 'document.adopt', contentDigest: shown.contentDigest });
    const home = (await call(t.token.executive, 'GET', '/v1/sms/home')).json();
    expect(home.attention.documentsAwaitingAdoption.map((item: { id: string }) => item.id)).not.toContain(id);

    await command(t.token.safety, {
      kind: 'sms.record.revise',
      recordId: id,
      expectedRevision: adopted.basis.revision,
      record: {
        kind: 'document',
        schema: 'sms.document.1',
        title: 'Drone program safety policy',
        ownerId: t.principal.safety,
        body: {
          documentType: 'safety_policy',
          revisionLabel: 'Revision 2',
          summary: 'Objectives, commitment and ethics.',
        },
      },
    });
    const revised = await detail(t, id);
    expect(revised.record.status).toBe('draft');
    expect(revised.signatures).toHaveLength(1);
    expect(
      (await call(t.token.executive, 'GET', '/v1/sms/home'))
        .json()
        .attention.waitingOnMe.map((item: { id: string }) => item.id),
    ).toContain(id);

    const exported = await exportRecord(t, id);
    const bundle = JSON.parse(exported.bytes.toString('utf8'));
    expect(verifySmsExport(bundle, { expectedManifestDigest: exported.record.manifestDigest }).status).toBe('verified');
    const swapped = structuredClone(bundle);
    swapped.records[0].attachments[0].sha256 = sha256('different bytes');
    swapped.manifest.sectionDigests.records = canonicalDigest(swapped.records);
    swapped.manifestDigest = canonicalDigest(swapped.manifest);
    expect(() => verifySmsExport(swapped)).toThrow(/attachment bytes do not match/i);
  });

  it('closes and reopens a record through basis-pinned decisions', async () => {
    const t = await tenant('close');
    await program(t);
    const id = await hazard(t);
    const shown = await detail(t, id);
    const notes = await upload(t, Buffer.from('Ordinary closure notes.'), 'ordinary');
    await attach(t, id, notes.uploadId, 'Closure notes');
    const stale = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decide(t, id, shown.basis, { kind: 'record.close', note: 'Operation discontinued.' }),
    );
    expect(stale.statusCode, stale.body).toBe(409);
    const current = await detail(t, id);
    await command(
      t.token.safety,
      decide(t, id, current.basis, { kind: 'record.close', note: 'Operation discontinued.' }),
    );
    const closed = await detail(t, id);
    expect(closed.record.status).toBe('closed');
    expect(closed.actions.revise.available).toBe(false);
    expect((await call(t.token.safety, 'GET', '/v1/sms/home')).json().attention.needsAssessment).toEqual([]);
    const pilot = await call(
      t.token.pilot,
      'POST',
      '/v1/commands',
      decide(t, id, closed.basis, { kind: 'record.reopen', note: 'Pilot cannot reopen.' }),
    );
    expect(pilot.statusCode).toBe(403);
    await command(t.token.safety, decide(t, id, closed.basis, { kind: 'record.reopen', note: 'Operation resumed.' }));
    expect((await detail(t, id)).record.status).toBe('identified');
  });

  it('isolates SMS records, attachments, signatures and exports by tenant', async () => {
    const a = await tenant('isolation-a');
    const b = await tenant('isolation-b');
    await program(a);
    const id = await hazard(a);
    const restricted = await upload(
      a,
      Buffer.from('Fictional restricted tower detail.'),
      'restricted_asset_information',
    );
    const attachment = await attach(a, id, restricted.uploadId, 'Tower detail');
    await assess(a, id);
    expect((await acceptAsExecutive(a, id)).statusCode).toBe(201);
    const exported = await exportRecord(a, id);
    for (const url of [
      `/v1/sms/records/${id}`,
      `/v1/sms/records/${id}/signing?meaning=risk.accept`,
      `/v1/sms/attachments/${attachment.id}/content`,
      `/v1/sms/exports/${exported.record.id}`,
      `/v1/sms/exports/${exported.record.id}/content`,
      `/v1/sms/exports/${exported.record.id}/packet`,
    ])
      expect((await call(b.token.safety, 'GET', url)).statusCode, url).toBe(404);
    expect((await call(b.token.safety, 'POST', '/v1/sms/exports', { recordId: id })).statusCode).toBe(404);
    const foreign = await call(b.token.safety, 'POST', '/v1/commands', {
      kind: 'sms.attachment.add',
      recordId: id,
      expectedRevision: 1,
      attachment: { uploadId: restricted.uploadId, label: 'Cross-tenant attach' },
    });
    expect(foreign.statusCode).toBe(404);
    const visible = await withScope(pool, { id: b.principal.safety, tenantId: b.id }, async (client) => {
      const counts: Record<string, number> = {};
      for (const table of [
        'sms_records',
        'sms_record_versions',
        'sms_attachments',
        'sms_signatures',
        'restricted_artifacts',
        'reauthentication_grants',
        'sms_restricted_disclosures',
        'sms_exports',
      ])
        counts[table] = Number(
          (await client.query(`SELECT COUNT(*) FROM ${table} WHERE tenant_id=$1`, [a.id])).rows[0].count,
        );
      return counts;
    });
    expect(
      Object.values(visible).every((count) => count === 0),
      JSON.stringify(visible),
    ).toBe(true);
    expect((await call(b.token.safety, 'GET', '/v1/sms/home')).json().attention.awaitingAcceptance).toEqual([]);
  });

  it('proposes and accepts a control of a type registered only in this test, binding its version', async () => {
    registerControlType(heaterControl);
    const t = await tenant('controls');
    const matrixId = await program(t);
    const id = await hazard(t, 'Rotor icing on the fictional ridge route');
    const opened = await detail(t, id);
    expect(opened.actions.proposeControl.available).toBe(true);
    const listed = opened.controlTypes!.find((type) => type.id === heaterControl.id)!;
    expect(listed.digest).toBe(controlTypeDigest(heaterControl));
    const pinned = { id: listed.id, version: listed.version, digest: listed.digest };
    const draft = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      kind: 'control' as const,
      schema: 'sms.control.1' as const,
      title: 'Heater run before ridge flights',
      ownerId: t.principal.safety,
      body: { hazardId: id, controlType: pinned, parameters, effectiveFrom: '2026-12-01T00:00:00Z', ...extra },
    });
    const parameters = { aircraftId: 'toy-tail-7', minimumMinutes: 5 };
    const refusedOpen = async (record: unknown, code: string) => {
      const response = await call(t.token.safety, 'POST', '/v1/commands', { kind: 'sms.record.open', record });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe(code);
    };
    await refusedOpen(draft({ aircraftId: 'toy-tail-7', minimumMinutes: 0 }), 'invalid_control');
    await refusedOpen(
      { ...draft(parameters), body: { ...draft(parameters).body, controlType: { ...pinned, digest: 'a'.repeat(64) } } },
      'invalid_control',
    );
    await refusedOpen(draft(parameters, { effectiveUntil: '2026-11-01T00:00:00Z' }), 'invalid_effective_interval');
    await refusedOpen(
      { ...draft(parameters), body: { ...draft(parameters).body, hazardId: matrixId } },
      'hazard_unavailable',
    );

    const control = (await command(t.token.safety, { kind: 'sms.record.open', record: draft(parameters) })).subject.id;
    const proposed = await detail(t, id);
    expect(proposed.record.revision).toBe(opened.record.revision);
    expect(proposed.controls).toEqual([
      expect.objectContaining({
        id: control,
        status: 'proposed',
        versionNumber: 1,
        controlType: { ...pinned, title: heaterControl.title },
        description: 'Run the rotor heater on toy-tail-7 for 5 minutes',
        accepted: false,
      }),
    ]);
    expect((await detail(t, control)).record).toMatchObject({ kind: 'control', recordClass: 'srm_output' });

    const assessed = await assess(t, id);
    const outcome = assessed.decisions[0].outcome as SmsAssessmentOutcome;
    const controlVersion = (await detail(t, control)).current;
    expect(outcome.controls).toEqual([
      {
        recordId: control,
        versionNumber: 1,
        bodyDigest: controlVersion.bodyDigest,
        title: 'Heater run before ridge flights',
        controlType: pinned,
        type: heaterControl.title,
        description: 'Run the rotor heater on toy-tail-7 for 5 minutes',
        effectiveFrom: '2026-12-01T00:00:00Z',
        effectiveUntil: null,
      },
    ]);
    const shown = await preview(t, id, 'executive', 'risk.accept');
    expect(shown.content!.bindings).toContainEqual({
      kind: 'record_version',
      recordId: control,
      versionNumber: 1,
      bodyDigest: controlVersion.bodyDigest,
    });
    expect(shown.content!.statement.controls).toEqual(outcome.controls);
    expect(shown.intent).toContain('with the control listed');
    const accepted = await acceptAsExecutive(t, id);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const after = await detail(t, id);
    expect(after.record.status).toBe('accepted');
    expect(after.controls![0]).toMatchObject({ id: control, accepted: true });
    const rows = await admin.query(
      'SELECT control_id,control_version_number,control_type_id,control_type_digest,effective_from FROM accepted_hazard_controls WHERE tenant_id=$1 AND hazard_id=$2',
      [t.id, id],
    );
    expect(rows.rows).toEqual([
      {
        control_id: control,
        control_version_number: 1,
        control_type_id: heaterControl.id,
        control_type_digest: pinned.digest,
        effective_from: new Date('2026-12-01T00:00:00Z'),
      },
    ]);
    await expect(
      admin.query('UPDATE accepted_hazard_controls SET control_version_number=2 WHERE tenant_id=$1', [t.id]),
    ).rejects.toThrow(/append-only/);
    const { bytes } = await exportRecord(t, id);
    expect(verifySmsExport(JSON.parse(bytes.toString('utf8')))).toMatchObject({ status: 'verified' });

    // A new version of the control is not the accepted one, and an assessment must list the current version.
    const revise = async (record: unknown) => {
      const current = await detail(t, control);
      return call(t.token.safety, 'POST', '/v1/commands', {
        kind: 'sms.record.revise',
        recordId: control,
        expectedRevision: current.basis.revision,
        record,
      });
    };
    const moved = await revise({
      ...draft(parameters),
      body: { ...draft(parameters).body, hazardId: await hazard(t) },
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.json().error.code).toBe('control_hazard_fixed');
    expect((await revise(draft({ ...parameters, minimumMinutes: 8 }))).statusCode).toBe(201);
    const revised = await detail(t, id);
    expect(revised.controls![0]).toMatchObject({ versionNumber: 2, accepted: false });
    const staleVersion = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decide(t, id, revised.basis, {
        kind: 'risk.assess',
        note: 'Reassessing against the first heater version.',
        matrix: { recordId: matrixId, versionNumber: 1 },
        initial: { severity: 'catastrophic', likelihood: 'probable' },
        controls: [{ recordId: control, versionNumber: 1 }],
        residual: { severity: 'major', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      }),
    );
    expect(staleVersion.statusCode, staleVersion.body).toBe(409);
    expect(staleVersion.json().error.code).toBe('control_changed');
    await assess(t, id, { severity: 'major', likelihood: 'remote' });
    expect((await revise(draft({ ...parameters, minimumMinutes: 10 }))).statusCode).toBe(201);
    const changed = await preview(t, id, 'executive', 'risk.accept');
    expect(changed.available).toBe(false);
    expect(changed.reason).toMatch(/control changed/i);
  });
});
