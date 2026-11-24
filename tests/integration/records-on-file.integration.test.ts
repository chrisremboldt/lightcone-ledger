import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdoptionRuleCoverageResponse,
  DocumentBodyV2,
  DocumentPurposesResponse,
  RuleCoverageSubjectsResponse,
  SmsBasis,
  SmsDecisionInput,
  Principal,
  SmsHomeResponse,
  SmsRecordDetailResponse,
  SmsRegisterResponse,
} from '../../packages/contracts/src/index.js';
import { firstSteps } from '../../apps/web/src/first-steps.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// What the organization keeps on file is recorded as neutral observations about it, which rules read like any other
// (docs/design/on-file-checks.md). Proposed § 108.560(a): a safety policy issued and in effect.
const POLICY_RULE = 'ledger.nprm.108.560.a.safety-policy';
const POLICY = 'part108-nprm.safety-policy';
const TYPE = 'organization.record-in-force';

type Role = 'safety' | 'executive';
const capabilities: Record<Role, string[]> = {
  safety: [
    'sms:read',
    'sms:write',
    'sms:report:read',
    'sms:restricted:read',
    'input:write',
    'decision:write',
    'evidence:read',
    'flight:read',
  ],
  executive: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read'],
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('what is on file, read by the Part 108 rules in shadow', () => {
  let tenant: CoverageTenant;
  let other: CoverageTenant;
  const pool = createPool();
  const people = {} as Record<Role, AuthContext>;
  let adoptionId: string;
  let documentId: string;
  let marker: string;

  beforeAll(async () => {
    tenant = await coverageTenant('records-on-file');
    marker = `MARKER-${tenant.prefix}`;
    other = await coverageTenant('records-on-file-other');
    for (const role of Object.keys(capabilities) as Role[]) {
      people[role] = {
        tenantId: tenant.tenantId,
        id: `${tenant.tenantId}:${role}`,
        revision: 1,
        kind: 'human',
        name: `Fictional ${role} lead`,
        capabilities: capabilities[role],
      };
      await tenant.admin.query(
        "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)",
        [people[role].id, tenant.tenantId, people[role].name, capabilities[role]],
      );
      await tenant.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${people[role].id}`),
        people[role].id,
      ]);
    }
  });
  afterAll(async () => {
    await settleOwnedWork([tenant.prefix, other.prefix]);
    await tenant?.close();
    await other?.close();
    await pool.end();
  });

  async function command(principal: AuthContext, payload: unknown, headers: Record<string, string> = {}) {
    const response = await tenant.call(principal, 'POST', '/v1/commands', payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as { id: string; subject: { id: string } };
  }
  async function detail(id: string): Promise<SmsRecordDetailResponse> {
    const response = await tenant.call(people.safety, 'GET', `/v1/sms/records/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  const decision = (id: string, basis: SmsBasis, input: SmsDecisionInput) => ({
    kind: 'decision.record' as const,
    subject: { kind: 'sms' as const, id },
    expectedRevision: basis.revision,
    expectedDependencyBasis: basis.dependencyBasis,
    decision: input,
  });
  async function decide(id: string, input: SmsDecisionInput) {
    return command(people.safety, decision(id, (await detail(id)).basis, input));
  }
  const body = (
    revision: string,
    purposes: string[],
    documentType: DocumentBodyV2['documentType'] = 'safety_policy',
  ): DocumentBodyV2 => ({
    origin: 'authored',
    documentType,
    revisionLabel: `Rev ${revision}`,
    summary: 'The fictional operator’s safety policy.',
    text: `Revision ${revision}: safety comes before schedule.`,
    changeReason: revision === 'A' ? 'Initial issue.' : 'Name the reporting channel.',
    purposes,
  });
  const draft = (
    revision: string,
    purposes: string[],
    title = 'Fictional safety policy',
    documentType: DocumentBodyV2['documentType'] = 'safety_policy',
  ) => ({
    kind: 'document',
    schema: 'sms.document.2',
    title,
    ownerId: people.safety.id,
    body: body(revision, purposes, documentType),
  });

  /** Reviews, signs with a fresh reauthentication, and issues the latest revision. */
  async function reviewSignAndIssue(id: string, effectiveFrom?: string) {
    await decide(id, {
      kind: 'document.review',
      versionNumber: (await detail(id)).record.versionNumber,
      attachmentIds: [],
      note: 'Reviewed this revision.',
    });
    const preview = await tenant.call(people.executive, 'GET', `/v1/sms/records/${id}/signing?meaning=document.adopt`);
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json();
    expect(shown.available, shown.reason).toBe(true);
    const grant = await tenant.call(people.executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${people.executive.id}`,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    const signed = await command(
      people.executive,
      decision(id, shown.basis, {
        kind: 'document.adopt',
        versionNumber: (await detail(id)).record.versionNumber,
        note: 'Adopted for the fictional operation.',
        signature: { intent: shown.intent, contentDigest: shown.contentDigest, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant },
    );
    return decide(id, {
      kind: 'document.issue',
      versionNumber: (await detail(id)).record.versionNumber,
      adoptionId: signed.id,
      recipientIds: [],
      note: 'Issued to the fictional crews.',
      ...(effectiveFrom ? { effectiveFrom } : {}),
    });
  }

  /** A restricted file on the document, which is never reviewed, issued or recorded on file. */
  async function attachRestricted(id: string) {
    const bytes = Buffer.from(`${marker} restricted asset detail`);
    const created = await tenant.call(people.safety, 'POST', '/v1/uploads', {
      contentType: 'text/plain',
      byteLength: bytes.byteLength,
      filename: `${marker}.txt`,
      confidentiality: 'restricted_asset_information',
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await tenant.call(people.safety, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, {
      'content-type': 'application/octet-stream',
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await tenant.call(people.safety, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    await command(people.safety, {
      kind: 'sms.attachment.add',
      recordId: id,
      expectedRevision: (await detail(id)).basis.revision,
      attachment: { uploadId, label: `${marker} restricted file` },
    });
  }

  async function policyCoverage() {
    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(read.statusCode, read.body).toBe(200);
    return (read.json() as AdoptionRuleCoverageResponse).rules.find((rule) => rule.leafId === POLICY_RULE)!;
  }
  async function policyEvaluation(result: string) {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${POLICY_RULE}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const subjects = (read.json() as RuleCoverageSubjectsResponse).subjects.filter(
      (item) => item.subject.id === `organization:${tenant.tenantId}`,
    );
    expect(subjects).toHaveLength(1);
    return subjects[0]!;
  }
  async function recordsInForce(tenantId: string) {
    const rows = await tenant.admin.query<{ id: string; observation: Record<string, any>; current: boolean }>(
      `SELECT o.id,o.observation,NOT EXISTS(SELECT 1 FROM observations r WHERE r.replaces_observation_id=o.id)
         AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.observation_id=o.id) AS current
       FROM observations o WHERE o.tenant_id=$1 AND o.observation_type=$2 ORDER BY o.received_at,o.id`,
      [tenantId, TYPE],
    );
    return rows.rows;
  }

  it('offers the adopted pack’s purposes, and refuses one no adopted pack declares', async () => {
    adoptionId = await tenant.adopt(getRulePackVersion('ledger.part108-nprm', 3)!, 'shadow');
    await tenant.settle();
    const offered = await tenant.call(people.safety, 'GET', '/v1/organization/document-purposes');
    expect(offered.statusCode, offered.body).toBe(200);
    const purposes = (offered.json() as DocumentPurposesResponse).purposes;
    expect(purposes.find((purpose) => purpose.id === POLICY)).toMatchObject({
      title: 'Safety policy',
      declaredBy: [{ packId: 'ledger.part108-nprm', version: 3, reference: 'Proposed 14 CFR 108.560(a)' }],
    });
    const refused = await tenant.call(people.safety, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: draft('A', ['fictional.not-declared']),
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('unknown_document_purpose');
  });

  it('turns from not on file to the issued revision in shadow, follows its successor, and stops at retirement', async () => {
    expect((await policyCoverage()).counts).toMatchObject({ no_record: 1 });
    // A purpose ticked on a draft puts nothing on file.
    documentId = (await command(people.safety, { kind: 'sms.record.open', record: draft('A', [POLICY]) })).subject.id;
    await attachRestricted(documentId);
    await tenant.settle();
    expect(await recordsInForce(tenant.tenantId)).toEqual([]);
    expect((await policyEvaluation('no_record')).evaluation).toMatchObject({ summary: 'No safety policy on file.' });

    await reviewSignAndIssue(documentId);
    await tenant.settle();
    expect((await policyCoverage()).counts).toMatchObject({ supported: 1, no_record: 0 });
    const supported = await policyEvaluation('supported');
    expect(supported.evaluation!.summary).toMatch(
      /^In force: “Fictional safety policy”, revision Rev A, since \d{4}-\d{2}-\d{2}, serving it by its type\. Ledger does not read the document: /,
    );
    expect((await recordsInForce(tenant.tenantId)).map((row) => row.observation.values)).toEqual([
      expect.objectContaining({
        recordKind: 'document',
        recordId: documentId,
        title: 'Fictional safety policy',
        revision: 'Rev A',
        documentType: 'safety_policy',
        purposes: [POLICY],
      }),
    ]);

    // Revision B supersedes it: the first is replaced with an end, the second is named.
    const shown = await detail(documentId);
    await command(people.safety, {
      kind: 'sms.record.revise',
      recordId: documentId,
      expectedRevision: shown.basis.revision,
      record: draft('B', [POLICY]),
    });
    await reviewSignAndIssue(documentId);
    await tenant.settle();
    expect((await policyEvaluation('supported')).evaluation!.summary).toMatch(/revision Rev B, since/);
    const byRevision = (rows: Awaited<ReturnType<typeof recordsInForce>>) =>
      rows
        .filter((row) => row.current)
        .sort((a, b) => String(a.observation.values.revision).localeCompare(String(b.observation.values.revision)));
    const current = byRevision(await recordsInForce(tenant.tenantId));
    expect(current.map((row) => [row.observation.values.revision, row.observation.interval.end !== undefined])).toEqual(
      [
        ['Rev A', true],
        ['Rev B', false],
      ],
    );
    expect(current[0]!.observation.interval.end).toBe(current[1]!.observation.interval.start);

    // Revision C, issued to take effect next week, ends B then; withdrawn before it does, B runs on again.
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await command(people.safety, {
      kind: 'sms.record.revise',
      recordId: documentId,
      expectedRevision: (await detail(documentId)).basis.revision,
      record: draft('C', [POLICY]),
    });
    const scheduled = await reviewSignAndIssue(documentId, later);
    await tenant.settle();
    const ahead = byRevision(await recordsInForce(tenant.tenantId));
    expect(ahead.map((row) => [row.observation.values.revision, row.observation.interval])).toEqual([
      ['Rev A', current[0]!.observation.interval],
      ['Rev B', { start: current[1]!.observation.interval.start, end: later }],
      ['Rev C', { start: later }],
    ]);
    expect((await policyEvaluation('supported')).evaluation!.summary).toMatch(/revision Rev B, since/);
    await decide(documentId, { kind: 'document.withdraw', issueId: scheduled.id, note: 'Not needed after all.' });
    await tenant.settle();
    expect(byRevision(await recordsInForce(tenant.tenantId)).map((row) => row.observation.interval)).toEqual([
      current[0]!.observation.interval,
      current[1]!.observation.interval,
    ]);

    // Retired, nothing of it is in force any more.
    await decide(documentId, { kind: 'record.close', note: 'Replaced by the operations manual.' });
    await tenant.settle();
    const retired = await policyEvaluation('no_record');
    expect(retired.evaluation!.summary).toMatch(
      /^No safety policy on file\. The latest, “Fictional safety policy”, revision Rev B, was in force from \d{4}-\d{2}-\d{2} until \d{4}-\d{2}-\d{2}\.$/,
    );
    expect(retired.finding).toBeNull();
  });

  /** The Safety home's list of what is on file, read from the same responses the Safety area reads. */
  async function homeSteps() {
    const read = async <T>(url: string) => {
      const response = await tenant.call(people.safety, 'GET', url);
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as T;
    };
    const [home, documents, matrices, reports] = await Promise.all([
      read<SmsHomeResponse>('/v1/sms/home'),
      read<SmsRegisterResponse>('/v1/sms/records?kind=document'),
      read<SmsRegisterResponse>('/v1/sms/records?kind=risk_matrix'),
      read<SmsRegisterResponse>('/v1/sms/records?kind=report'),
    ]);
    return firstSteps({
      home,
      documents: [...documents.records, ...matrices.records],
      reports: reports.records,
      principal: { id: people.safety.id, capabilities: people.safety.capabilities as Principal['capabilities'] },
    });
  }

  it('agrees with the Safety home on a safety policy issued with no purpose ticked, naming the same record', async () => {
    const id = (
      await command(people.safety, {
        kind: 'sms.record.open',
        record: draft('1', [], 'Fictional operator safety policy'),
      })
    ).subject.id;
    await reviewSignAndIssue(id);
    await tenant.settle();
    const step = (await homeSteps()).find((item) => item.key === 'policy')!;
    expect(step).toMatchObject({ onFile: true, detail: 'Fictional operator safety policy, Rev 1, in force' });
    const rule = await policyEvaluation('supported');
    expect(rule.evaluation!.summary).toMatch(
      /^In force: “Fictional operator safety policy”, revision Rev 1, since \d{4}-\d{2}-\d{2}, serving it by its type\./,
    );
    await decide(id, { kind: 'record.close', note: 'Replaced by the handbook.' });
    await tenant.settle();
  });

  it('counts a document of another type ticked as the safety policy, and says it was ticked', async () => {
    const id = (
      await command(people.safety, {
        kind: 'sms.record.open',
        record: draft('1', [POLICY], 'Fictional operations handbook', 'procedure'),
      })
    ).subject.id;
    await reviewSignAndIssue(id);
    await tenant.settle();
    const rule = await policyEvaluation('supported');
    expect(rule.evaluation!.summary).toMatch(
      /^In force: “Fictional operations handbook”, revision Rev 1, since \d{4}-\d{2}-\d{2}, ticked as serving it\./,
    );
    // The Safety home's list reads only documents of the safety policy type, so it says none is in force here.
    expect((await homeSteps()).find((item) => item.key === 'policy')).toMatchObject({ onFile: false });
    await decide(id, { kind: 'record.close', note: 'Retired after the check.' });
    await tenant.settle();
  });

  it('keeps what is on file to its organization, and carries nothing from a safety report or a restricted attachment', async () => {
    await command(people.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: `${marker} report title`,
        ownerId: people.safety.id,
        body: {
          narrative: `${marker} report narrative`,
          received: { channel: 'phone' },
          reporter: { name: `${marker} reporter` },
        },
      },
    });
    const hazard = await command(people.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: `${marker} hazard title`,
        ownerId: people.safety.id,
        body: {
          description: `${marker} hazard description`,
          consequence: 'A fictional consequence.',
          source: { kind: 'manual_identification' },
        },
      },
    });
    await tenant.settle();
    const held = await recordsInForce(tenant.tenantId);
    expect(held.find((row) => row.observation.values.recordId === hazard.subject.id)?.observation.values).toEqual({
      recordKind: 'hazard',
      recordId: hazard.subject.id,
      purposes: [],
      riskAssessed: false,
      riskAccepted: false,
    });
    expect(JSON.stringify(held)).not.toContain(marker);
    const artifacts = await tenant.admin.query<{ id: string }>(
      `SELECT DISTINCT o.artifact_id AS id FROM observations o WHERE o.tenant_id=$1 AND o.observation_type=$2`,
      [tenant.tenantId, TYPE],
    );
    expect(artifacts.rows.length).toBeGreaterThan(0);

    // Through the API's own role, another organization sees none of them.
    const seen = (principal: AuthContext) =>
      withScope(pool, principal, async (client) =>
        Number(
          (await client.query('SELECT COUNT(*) AS count FROM observations WHERE observation_type=$1', [TYPE])).rows[0]
            .count,
        ),
      );
    expect(await seen(people.safety)).toBe(held.length);
    expect(await seen(other.actor)).toBe(0);
    expect(await recordsInForce(other.tenantId)).toEqual([]);
  });
});
