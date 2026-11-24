import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import type {
  Capability,
  DocumentBodyV2,
  SmsBasis,
  SmsDecisionInput,
  SmsExportRecord,
  SmsHomeResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
} from '../../packages/contracts/src/index.js';
import { leaseWork, processLease } from '../../apps/workers/src/index.js';
import { acceptCommand } from '../../packages/domain/src/index.js';
import { projectDocumentControl } from '../../packages/domain/src/sms-documents.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { verifySmsExport } from '../../tools/verifier/sms-export.mjs';
import { drainOwnedWork, lockWaitStarted, settleOwnedWork, withOwnedWork } from './worker-queue.js';

type Role = 'safety' | 'executive' | 'pilot' | 'observer';
type IssueDecision = Extract<SmsDecisionInput, { kind: 'document.issue' }>;
interface Tenant {
  id: string;
  token: Record<Role, string>;
  principal: Record<Role, string>;
}

const people: Record<Role, { name: string; capabilities: Capability[] }> = {
  safety: {
    name: 'Fictional Document Controller',
    capabilities: ['sms:read', 'sms:write', 'sms:restricted:read', 'decision:write', 'evidence:read', 'input:write'],
  },
  executive: {
    name: 'Fictional Accountable Executive',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read'],
  },
  pilot: { name: 'Fictional Pilot', capabilities: ['sms:read'] },
  observer: { name: 'Fictional Observer', capabilities: ['sms:read'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL document control and distribution', () => {
  const prefix = `sms-documents-${randomUUID()}`;
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
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Worker','worker',$3)",
      [`${id}:worker`, id, ['input:write', 'flight:create', 'flight:read', 'evidence:read']],
    );
    const token = {} as Record<Role, string>;
    const principal = {} as Record<Role, string>;
    for (const role of Object.keys(people) as Role[]) {
      principal[role] = `${id}:${role}`;
      token[role] = `ledger-dev-${id}:${role}`;
      await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)", [
        principal[role],
        id,
        people[role].name,
        people[role].capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(token[role]),
        principal[role],
      ]);
    }
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
  async function home(t: Tenant, role: Role): Promise<SmsHomeResponse> {
    const response = await call(t.token[role], 'GET', '/v1/sms/home');
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function decision(id: string, basis: SmsBasis, input: SmsDecisionInput) {
    return {
      kind: 'decision.record' as const,
      subject: { kind: 'sms' as const, id },
      expectedRevision: basis.revision,
      expectedDependencyBasis: basis.dependencyBasis,
      decision: input,
    };
  }
  async function decide(t: Tenant, id: string, input: SmsDecisionInput, role: Role = 'safety') {
    const shown = await detail(t, id, role);
    return command(t.token[role], decision(id, shown.basis, input));
  }
  function authoredBody(revision = 'A'): DocumentBodyV2 {
    return {
      origin: 'authored',
      documentType: 'procedure',
      documentNumber: 'FVP-OPS-17',
      revisionLabel: `Revision ${revision}`,
      summary: 'Lost-link procedure for the fictional utility drone program.',
      text: `Revision ${revision}: climb to the return altitude and notify the line crew.`,
      changeReason: revision === 'A' ? 'Initial issue.' : 'Clarify the call to the line crew.',
    };
  }
  async function open(t: Tenant, body: DocumentBodyV2 = authoredBody()) {
    const opened = await command(t.token.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: 'Fictional utility lost-link procedure',
        ownerId: t.principal.safety,
        body,
      },
    });
    return opened.subject.id;
  }
  async function revise(t: Tenant, id: string, body: DocumentBodyV2) {
    const shown = await detail(t, id);
    return command(t.token.safety, {
      kind: 'sms.record.revise',
      recordId: id,
      expectedRevision: shown.basis.revision,
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: shown.record.title,
        ownerId: t.principal.safety,
        body,
      },
    });
  }
  async function attach(
    t: Tenant,
    id: string,
    text: string,
    confidentiality: 'ordinary' | 'restricted_asset_information' = 'ordinary',
  ) {
    const bytes = Buffer.from(text);
    const created = await call(t.token.safety, 'POST', '/v1/uploads', {
      contentType: 'text/plain',
      byteLength: bytes.byteLength,
      filename: 'fictional-procedure.txt',
      confidentiality,
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await call(t.token.safety, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, {
      'content-type': 'application/octet-stream',
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(t.token.safety, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    const shown = await detail(t, id);
    const attached = await command(t.token.safety, {
      kind: 'sms.attachment.add',
      recordId: id,
      expectedRevision: shown.basis.revision,
      attachment: { uploadId, label: 'Fictional procedure file' },
    });
    return { id: attached.id, sha256: sha256(bytes), bytes };
  }
  async function review(t: Tenant, id: string, attachmentIds: string[] = []) {
    const shown = await detail(t, id);
    return command(
      t.token.safety,
      decision(id, shown.basis, {
        kind: 'document.review',
        versionNumber: shown.record.versionNumber,
        attachmentIds,
        note: 'Reviewed this exact revision and its selected files.',
      }),
    );
  }
  async function preview(t: Tenant, id: string): Promise<SmsSigningPreviewResponse> {
    const shown = await call(t.token.executive, 'GET', `/v1/sms/records/${id}/signing?meaning=document.adopt`);
    expect(shown.statusCode, shown.body).toBe(200);
    return shown.json();
  }
  async function adopt(t: Tenant, id: string, shown?: SmsSigningPreviewResponse) {
    shown ??= await preview(t, id);
    expect(shown.available, shown.reason).toBe(true);
    const reauthentication = await call(t.token.executive, 'POST', '/v1/local/reauthentications', {
      credential: t.token.executive,
    });
    expect(reauthentication.statusCode, reauthentication.body).toBe(201);
    const current = await detail(t, id, 'executive');
    return call(
      t.token.executive,
      'POST',
      '/v1/commands',
      decision(id, shown.basis, {
        kind: 'document.adopt',
        versionNumber: current.record.versionNumber,
        note: 'Adopted for the fictional inspection program.',
        signature: { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': reauthentication.json().grant },
    );
  }

  async function issue(
    t: Tenant,
    id: string,
    adoptionId: string,
    options: Partial<Omit<IssueDecision, 'kind' | 'versionNumber' | 'adoptionId' | 'note'>> = {},
  ) {
    const shown = await detail(t, id);
    return command(
      t.token.safety,
      decision(id, shown.basis, {
        kind: 'document.issue',
        versionNumber: shown.record.versionNumber,
        adoptionId,
        recipientIds: [t.principal.pilot],
        note: 'Issued to the fictional inspection crew.',
        ...options,
      }),
    );
  }
  function acknowledge(t: Tenant, role: Role, id: string, issueId: string, contentDigest: string) {
    return call(t.token[role], 'POST', '/v1/commands', {
      kind: 'sms.document.acknowledge',
      recordId: id,
      issueId,
      contentDigest,
    });
  }
  async function reviewedAndSigned(t: Tenant, id: string, files: string[] = []) {
    await review(t, id, files);
    const signed = await adopt(t, id);
    expect(signed.statusCode, signed.body).toBe(201);
    return signed.json().command.id as string;
  }

  it('issues the reviewed file set, preserves it during drafting, and retains each issue’s own reading records', async () => {
    const t = await tenant('lifecycle');
    const id = await open(t);
    expect((await preview(t, id)).available).toBe(false);
    const fileA = await attach(t, id, 'Revision A: climb and notify the line crew.');
    const attached = await detail(t, id);
    expect(attached.attachments.find((entry) => entry.id === fileA.id)!.documentVersion).toEqual({
      versionNumber: 1,
      bodyDigest: attached.current.bodyDigest,
    });
    const reviewed = await review(t, id, [fileA.id]);
    const stalePreview = await preview(t, id);
    const fileB = await attach(t, id, 'Revision B: climb, confirm the return and call the line crew lead.');
    const staleSignature = await adopt(t, id, stalePreview);
    expect(staleSignature.statusCode, staleSignature.body).toBe(409);
    expect(staleSignature.json().error.code).toBe('stale_basis');

    const shown = await preview(t, id);
    expect(shown.content!.bindings.filter((binding) => binding.kind === 'attachment')).toEqual([
      { kind: 'attachment', attachmentId: fileA.id, sha256: fileA.sha256 },
    ]);
    expect(shown.content!.bindings).toContainEqual(
      expect.objectContaining({ kind: 'decision', decisionId: reviewed.id }),
    );
    const signed = await adopt(t, id, shown);
    expect(signed.statusCode, signed.body).toBe(201);
    const first = await issue(t, id, signed.json().command.id);
    const issued = await detail(t, id);
    expect(issued.documentControl!.effectiveIssue).toMatchObject({
      id: first.id,
      versionNumber: 1,
      attachmentIds: [fileA.id],
      contentDigest: shown.contentDigest,
    });
    expect(issued.documentControl!.effectiveIssue!.effectiveFrom).toBe(
      issued.documentControl!.effectiveIssue!.issuedAt,
    );
    expect((await home(t, 'pilot')).reading).toContainEqual(
      expect.objectContaining({
        recordId: id,
        issueId: first.id,
        status: 'current',
        acknowledgedAt: null,
      }),
    );

    expect((await home(t, 'safety')).readingProgress).toContainEqual(
      expect.objectContaining({ recordId: id, issueId: first.id, assigned: 1, acknowledged: 0, overdue: 0 }),
    );
    expect((await home(t, 'pilot')).readingProgress).toEqual([]);

    const refused = await acknowledge(t, 'pilot', id, first.id, sha256('a different issue'));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('document_content_changed');
    const beforeReading = await detail(t, id);
    const acknowledged = await acknowledge(t, 'pilot', id, first.id, shown.contentDigest!);
    expect(acknowledged.statusCode, acknowledged.body).toBe(201);
    expect((await detail(t, id)).basis).toEqual(beforeReading.basis);
    const again = await acknowledge(t, 'pilot', id, first.id, shown.contentDigest!);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('document_already_acknowledged');
    await drainOwnedWork(admin, worker, [prefix], { objectStore: store });
    const projected = await detail(t, id);
    expect(projected.record.projectedRevision).toBe(projected.record.revision);
    expect((await home(t, 'safety')).readingProgress!.some((entry) => entry.issueId === first.id)).toBe(false);
    await decide(t, id, {
      kind: 'document.distribute',
      issueId: first.id,
      recipientIds: [t.principal.observer],
      note: 'Add the fictional incoming crew member.',
    });
    const distributed = await detail(t, id);
    expect(distributed.documentControl!.effectiveIssue!.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: t.principal.pilot, acknowledgementId: acknowledged.json().command.id }),
        expect.objectContaining({ id: t.principal.observer, acknowledgedAt: null }),
      ]),
    );
    expect(distributed.documentControl!.effectiveIssue!.recipients).toHaveLength(2);

    await revise(t, id, authoredBody('B'));
    const drafted = await detail(t, id);
    expect(drafted.record).toMatchObject({ status: 'draft', versionNumber: 2 });
    expect(drafted.documentControl!.effectiveIssue!.id).toBe(first.id);
    await review(t, id, [fileB.id]);
    const heldPreview = await preview(t, id);
    const observerReading = await acknowledge(t, 'observer', id, first.id, shown.contentDigest!);
    expect(observerReading.statusCode, observerReading.body).toBe(201);
    const signedB = await adopt(t, id, heldPreview);
    expect(signedB.statusCode, signedB.body).toBe(201);
    const nextAdoption = signedB.json().command.id as string;
    const starts = new Date(Date.now() + 3_600_000).toISOString();
    const ends = new Date(Date.parse(starts) + 3_600_000).toISOString();
    const second = await issue(t, id, nextAdoption, { effectiveFrom: starts, effectiveUntil: ends });
    const scheduled = await detail(t, id);
    expect(scheduled.documentControl!.effectiveIssue!.id).toBe(first.id);
    expect(scheduled.documentControl!.issues.find((entry) => entry.id === second.id)).toMatchObject({
      status: 'scheduled',
      versionNumber: 2,
      attachmentIds: [fileB.id],
      supersedes: first.id,
      recipients: [expect.objectContaining({ id: t.principal.pilot, acknowledgedAt: null })],
    });
    const at = (asOf: string) =>
      projectDocumentControl(
        { id, version_number: scheduled.record.versionNumber, status: scheduled.record.status },
        scheduled.versions,
        scheduled.decisions,
        scheduled.documentControl!.acknowledgements,
        asOf,
      );
    expect(at(new Date(Date.parse(starts) - 1).toISOString()).effectiveIssue!.id).toBe(first.id);
    expect(at(starts).effectiveIssue!.id).toBe(second.id);
    expect(at(starts).issues.find((entry) => entry.id === first.id)!.status).toBe('superseded');
    expect(at(ends).effectiveIssue).toBeNull();
    expect(at(ends).issues.find((entry) => entry.id === second.id)!.status).toBe('expired');
    expect(at(ends).issues.find((entry) => entry.id === first.id)!.status).toBe('superseded');

    const exported = await call(t.token.safety, 'POST', '/v1/sms/exports', { recordId: id });
    expect(exported.statusCode, exported.body).toBe(201);
    const exportRecord = exported.json().export as SmsExportRecord;
    const bytes = await call(t.token.safety, 'GET', `/v1/sms/exports/${exportRecord.id}/content`);
    expect(bytes.statusCode, bytes.body).toBe(200);
    const bundle = JSON.parse(bytes.rawPayload.toString('utf8'));
    expect(verifySmsExport(bundle, { expectedManifestDigest: exportRecord.manifestDigest }).status).toBe('verified');
    expect(bundle.decisions.map((entry: { kind: string }) => entry.kind)).toEqual(
      expect.arrayContaining(['document.review', 'document.adopt', 'document.issue', 'document.distribute']),
    );
    const exportedDocument = bundle.records.find((entry: { id: string }) => entry.id === id);
    expect(exportedDocument.documentAcknowledgements).toEqual([
      expect.objectContaining({
        issueId: first.id,
        actor: expect.objectContaining({ principalId: t.principal.pilot }),
      }),
      expect.objectContaining({
        issueId: first.id,
        actor: expect.objectContaining({ principalId: t.principal.observer }),
      }),
    ]);
    const packet = await call(t.token.safety, 'GET', `/v1/sms/exports/${exportRecord.id}/packet`);
    expect(packet.statusCode, packet.body).toBe(200);
    expect(packet.body).toContain(authoredBody('A').text);
    expect(packet.body).toContain(authoredBody('B').text);
    expect(packet.body).toContain('In force · Revision A');
    expect(packet.body).toContain('Scheduled · Revision B');
    expect(packet.body).toContain(
      'I have read Fictional utility lost-link procedure, Revision A, including its issued files.',
    );

    await decide(t, id, { kind: 'document.withdraw', issueId: second.id, note: 'The crew briefing moved.' });
    const withdrawn = await detail(t, id);
    expect(withdrawn.documentControl!.issues.find((entry) => entry.id === second.id)!.status).toBe('withdrawn');
    expect(withdrawn.documentControl!.effectiveIssue!.id).toBe(first.id);
    expect((await home(t, 'pilot')).reading!.some((entry) => entry.issueId === second.id)).toBe(false);
    const reissued = await issue(t, id, nextAdoption);
    expect((await detail(t, id)).documentControl!.effectiveIssue).toMatchObject({
      id: reissued.id,
      versionNumber: 2,
      supersedes: first.id,
    });

    await decide(t, id, {
      kind: 'record.close',
      note: 'Withdraw both issues after the fictional aircraft is retired.',
    });
    const retired = await detail(t, id);
    expect(retired.documentControl!.effectiveIssue).toBeNull();
    expect(retired.documentControl!.issues.map((entry) => entry.status).sort()).toEqual([
      'retired',
      'retired',
      'withdrawn',
    ]);
    await decide(t, id, { kind: 'record.reopen', note: 'Return the same revision to service.' });
    const reopened = await detail(t, id);
    expect(reopened.record).toMatchObject({ status: 'draft', versionNumber: 2 });
    expect(reopened.documentControl).toMatchObject({ effectiveIssue: null, latestReview: null, latestAdoption: null });
    const returnedAdoption = await reviewedAndSigned(t, id, [fileB.id]);
    const returned = await issue(t, id, returnedAdoption);
    expect((await detail(t, id)).documentControl!.effectiveIssue).toMatchObject({
      id: returned.id,
      versionNumber: 2,
      supersedes: null,
      status: 'current',
    });

    expect(scheduled.signatures[0].contentDigest).toBe(canonicalDigest(scheduled.signatures[0].content));
  });

  it('records periodic reviews of the revision in force and shows library and reading facts to document controllers', async () => {
    const t = await tenant('periodic');
    const day = 24 * 60 * 60 * 1000;
    const writtenDue = new Date(Date.now() + 10 * day).toISOString();
    const id = await open(t, { ...authoredBody(), reviewDueAt: writtenDue });
    const first = await issue(t, id, await reviewedAndSigned(t, id));

    const safetyHome = await home(t, 'safety');
    expect(safetyHome.reviewsDue).toEqual([
      expect.objectContaining({ recordId: id, issueId: first.id, reviewDueAt: writtenDue, overdue: false }),
    ]);
    expect(safetyHome.readingByPerson).toEqual([
      expect.objectContaining({
        person: { id: t.principal.pilot, name: people.pilot.name },
        documents: [expect.objectContaining({ recordId: id, issueId: first.id })],
      }),
    ]);
    const pilotHome = await home(t, 'pilot');
    expect(pilotHome.reviewsDue).toEqual([]);
    expect(pilotHome.readingByPerson).toEqual([]);

    const register = async (role: Role) => {
      const response = await call(t.token[role], 'GET', '/v1/sms/records?kind=document');
      expect(response.statusCode, response.body).toBe(200);
      return response.json().records.find((entry: { id: string }) => entry.id === id).document;
    };
    expect(await register('safety')).toMatchObject({
      documentType: 'procedure',
      documentNumber: 'FVP-OPS-17',
      inForce: { issueId: first.id, versionNumber: 1, revisionLabel: 'Revision A' },
      scheduled: null,
      reviewDueAt: writtenDue,
      reading: { assigned: 1, acknowledged: 0, overdue: 0 },
    });
    expect((await register('pilot')).reading).toBeNull();

    const periodic = (issueId: string, nextReviewDueAt: string) => ({
      kind: 'document.periodic-review' as const,
      issueId,
      nextReviewDueAt,
      note: 'Reviewed against the current fictional operations; no change needed.',
    });
    const shown = await detail(t, id);
    const past = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, shown.basis, periodic(first.id, new Date(Date.now() - day).toISOString())),
    );
    expect(past.statusCode, past.body).toBe(400);
    expect(past.json().error.code).toBe('invalid_next_review');
    const pilotReview = await call(
      t.token.pilot,
      'POST',
      '/v1/commands',
      decision(id, shown.basis, periodic(first.id, new Date(Date.now() + 365 * day).toISOString())),
    );
    expect(pilotReview.statusCode, pilotReview.body).toBe(403);

    const nextDue = new Date(Date.now() + 365 * day).toISOString();
    await decide(t, id, periodic(first.id, nextDue));
    const reviewed = await detail(t, id);
    expect(reviewed.documentControl!.reviewDueAt).toBe(nextDue);
    expect(reviewed.documentControl!.effectiveIssue!.id).toBe(first.id);
    expect((await home(t, 'safety')).reviewsDue).toEqual([]);

    await revise(t, id, authoredBody('B'));
    const starts = new Date(Date.now() + 3_600_000).toISOString();
    const second = await issue(t, id, await reviewedAndSigned(t, id), { effectiveFrom: starts });
    const scheduledReview = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, (await detail(t, id)).basis, periodic(second.id, nextDue)),
    );
    expect(scheduledReview.statusCode, scheduledReview.body).toBe(409);
    expect(scheduledReview.json().error.code).toBe('document_issue_not_in_force');
    expect((await register('safety')).scheduled).toMatchObject({ issueId: second.id, versionNumber: 2 });

    const exported = await call(t.token.safety, 'POST', '/v1/sms/exports', { recordId: id });
    expect(exported.statusCode, exported.body).toBe(201);
    const exportRecord = exported.json().export as SmsExportRecord;
    const packet = await call(t.token.safety, 'GET', `/v1/sms/exports/${exportRecord.id}/packet`);
    expect(packet.statusCode, packet.body).toBe(200);
    expect(packet.body).toContain('Periodic review');
    expect(packet.body).toContain('remains current');
  });

  it('projects an attached file while a review of the same record holds it, in one lock order', async () => {
    const t = await tenant('attachment-lock-order');
    const id = await open(t);
    await drainOwnedWork(admin, worker, [t.id], { objectStore: store });
    const file = await attach(t, id, 'Fictional procedure text attached just before its review.');
    const leases = await withOwnedWork(admin, [t.id], () => leaseWork(worker, { limit: 100 }));
    const attachmentLease = leases.find((lease) => lease.event_id === file.id)!;
    const shown = await detail(t, id);
    // The review locks the record as every record command does; the attachment is projected while that lock is held,
    // and only then does the review take the record row.
    let projected: Promise<boolean> | undefined;
    const reviewed = await withScope(pool, { id: t.principal.safety, tenantId: t.id }, async (client, who) => {
      await client.query('SELECT id FROM subjects WHERE id=$1 FOR UPDATE', [id]);
      projected = processLease(worker, attachmentLease, { objectStore: store });
      projected.catch(() => undefined);
      await lockWaitStarted(admin);
      return acceptCommand(
        client,
        who,
        decision(id, shown.basis, {
          kind: 'document.review',
          versionNumber: shown.record.versionNumber,
          attachmentIds: [file.id],
          note: 'Reviewed this exact revision and the file attached just before.',
        }),
      );
    });
    expect(reviewed.kind).toBe('decision.record');
    expect(await projected).toBe(true);
    for (const lease of leases.filter((lease) => lease !== attachmentLease))
      expect(await processLease(worker, lease, { objectStore: store })).toBe(true);
    await drainOwnedWork(admin, worker, [t.id], { objectStore: store });
  });

  it('requires a fresh review and signature for the exact working version and refuses backdated issues', async () => {
    const t = await tenant('revision-binding');
    const id = await open(t);
    await review(t, id);
    const shown = await preview(t, id);
    await revise(t, id, authoredBody('B'));
    const staleReview = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, shown.basis, {
        kind: 'document.review',
        versionNumber: 1,
        attachmentIds: [],
        note: 'Reviewing an obsolete working revision.',
      }),
    );
    expect(staleReview.statusCode, staleReview.body).toBe(409);
    expect((await preview(t, id)).available).toBe(false);
    const waitingOnExecutive = async () =>
      (await call(t.token.executive, 'GET', '/v1/sms/home'))
        .json()
        .attention.waitingOnMe.map((item: { id: string }) => item.id);
    const documentWork = async () => {
      const attention = (await call(t.token.safety, 'GET', '/v1/sms/home')).json().attention;
      const ids = (items: { id: string }[]) => items.map((item) => item.id);
      return { review: ids(attention.documentsToReview), issue: ids(attention.documentsToIssue) };
    };
    expect(await waitingOnExecutive()).not.toContain(id);
    expect((await documentWork()).review).toContain(id);
    await review(t, id);
    expect(await waitingOnExecutive()).toContain(id);
    expect(await documentWork()).toEqual({ review: [], issue: [] });
    const current = await preview(t, id);
    const grant = await call(t.token.executive, 'POST', '/v1/local/reauthentications', {
      credential: t.token.executive,
    });
    const wrongVersion = await call(
      t.token.executive,
      'POST',
      '/v1/commands',
      decision(id, current.basis, {
        kind: 'document.adopt',
        versionNumber: 1,
        note: 'Attempt to sign the preceding version.',
        signature: { intent: current.intent!, contentDigest: current.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant },
    );
    expect(wrongVersion.statusCode, wrongVersion.body).toBe(409);
    const signed = await adopt(t, id, current);
    expect(signed.statusCode, signed.body).toBe(201);
    expect((await documentWork()).issue).toEqual([id]);
    const signedDetail = await detail(t, id);
    const backdated = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, signedDetail.basis, {
        kind: 'document.issue',
        versionNumber: 2,
        adoptionId: signed.json().command.id,
        effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
        recipientIds: [],
        note: 'Attempt to replace the historical operational record.',
      }),
    );
    expect(backdated.statusCode, backdated.body).toBe(400);
    expect(backdated.json().error.code).toBe('document_backdated');
    expect((await detail(t, id)).documentControl!.issues).toEqual([]);
  });

  it('retains received source bytes and conflicts when an issuer revision is reused for different files', async () => {
    const t = await tenant('received');
    const body: DocumentBodyV2 = {
      origin: 'received',
      documentType: 'oem_manual',
      documentNumber: 'FVP-OEM-4',
      revisionLabel: 'OEM Revision 4',
      summary: 'Manufacturer instructions for the fictional inspection aircraft.',
      changeReason: 'Initial receipt from the manufacturer.',
      source: {
        organization: 'Fictional Aircraft Company',
        reference: 'OEM-OPS-4',
        revision: '4',
        issuedAt: '2026-10-01T12:00:00Z',
        receivedAt: '2026-10-20T12:00:00Z',
      },
    };
    const id = await open(t, body);
    const shown = await detail(t, id);
    const missingFile = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, shown.basis, {
        kind: 'document.review',
        versionNumber: 1,
        attachmentIds: [],
        note: 'Received without its source file.',
      }),
    );
    expect(missingFile.statusCode, missingFile.body).toBe(400);
    const issuedLater = await call(t.token.safety, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: 'Fictional manual dated after its receipt',
        ownerId: t.principal.safety,
        body: { ...body, source: { ...body.source!, issuedAt: '2026-10-22' } },
      },
    });
    expect(issuedLater.statusCode, issuedLater.body).toBe(400);
    expect(issuedLater.json().error.code).toBe('invalid_source_dates');
    const original = await attach(t, id, 'OEM revision 4: original bytes retained exactly.');
    await review(t, id, [original.id]);
    const downloaded = await call(t.token.pilot, 'GET', `/v1/sms/attachments/${original.id}/content`);
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.rawPayload).toEqual(original.bytes);
    await revise(t, id, { ...body, changeReason: 'Correct the local document description.' });
    const replacement = await attach(t, id, 'Different instructions labelled as OEM revision 4.');
    const revised = await detail(t, id);
    const conflict = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, revised.basis, {
        kind: 'document.review',
        versionNumber: 2,
        attachmentIds: [replacement.id],
        note: 'Changed source bytes.',
      }),
    );
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json().error.code).toBe('source_revision_conflict');
    await review(t, id, [original.id]);
    await revise(t, id, {
      ...body,
      source: { ...body.source!, revision: '5' },
      changeReason: 'Received OEM revision 5.',
    });
    await review(t, id, [replacement.id]);
    expect((await detail(t, id)).documentControl!.latestReview).toMatchObject({
      kind: 'document.review',
      outcome: { document: { versionNumber: 3 }, attachments: [{ id: replacement.id, sha256: replacement.sha256 }] },
    });
  });

  it('limits recipients and file selection to this tenant and requires personal human acknowledgement', async () => {
    const t = await tenant('access');
    const other = await tenant('other');
    const id = await open(t);
    const foreignId = await open(other);
    const foreignFile = await attach(other, foreignId, 'Another fictional utility’s file.');
    const restrictedFile = await attach(t, id, 'Fictional restricted asset detail.', 'restricted_asset_information');
    for (const attachmentId of [foreignFile.id, restrictedFile.id]) {
      const shown = await detail(t, id);
      const invalid = await call(
        t.token.safety,
        'POST',
        '/v1/commands',
        decision(id, shown.basis, {
          kind: 'document.review',
          versionNumber: 1,
          attachmentIds: [attachmentId],
          note: 'Invalid file selection.',
        }),
      );
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json().error.code).toBe('document_file_unavailable');
    }
    const adoptionId = await reviewedAndSigned(t, id);
    const beforeIssue = await detail(t, id);
    const foreignRecipient = await call(
      t.token.safety,
      'POST',
      '/v1/commands',
      decision(id, beforeIssue.basis, {
        kind: 'document.issue',
        versionNumber: 1,
        adoptionId,
        recipientIds: [other.principal.pilot],
        note: 'Attempt cross-tenant distribution.',
      }),
    );
    expect(foreignRecipient.statusCode, foreignRecipient.body).toBe(400);
    const issued = await issue(t, id, adoptionId);
    const current = await detail(t, id, 'observer');
    const digest = current.documentControl!.effectiveIssue!.contentDigest;
    const refused = await acknowledge(t, 'observer', id, issued.id, digest);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('document_recipient_required');
    const agentId = `${t.id}:agent`;
    const agentToken = `ledger-dev-${agentId}`;
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Fictional agent','service',$3)",
      [agentId, t.id, ['sms:read']],
    );
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(agentToken),
      agentId,
    ]);
    const agentDetail = await call(agentToken, 'GET', `/v1/sms/records/${id}`);
    expect(agentDetail.statusCode, agentDetail.body).toBe(200);
    const automated = await call(agentToken, 'POST', '/v1/commands', {
      kind: 'sms.document.acknowledge',
      recordId: id,
      issueId: issued.id,
      contentDigest: digest,
    });
    expect(automated.statusCode, automated.body).toBe(403);
    const foreignReading = await acknowledge(other, 'pilot', id, issued.id, digest);
    expect(foreignReading.statusCode, foreignReading.body).toBe(404);
    expect(automated.json().error.code).toBe('person_required');
    expect((await home(t, 'observer')).reading).toEqual([]);
    expect((await call(other.token.safety, 'GET', `/v1/sms/records/${id}`)).statusCode).toBe(404);
    expect((await home(other, 'pilot')).reading).toEqual([]);
    const hidden = await withScope(pool, { id: other.principal.safety, tenantId: other.id }, async (client) =>
      client.query('SELECT id FROM decisions WHERE subject_id=$1', [id]),
    );
    expect(hidden.rowCount).toBe(0);
  });
});
