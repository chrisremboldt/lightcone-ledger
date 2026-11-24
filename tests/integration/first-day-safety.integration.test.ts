import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import {
  rolePresets,
  standardRiskMatrix,
  type Capability,
  type CommandResponse,
  type DocumentBodyV2,
  type PrincipalAuthorityEntry,
  type SigningMeaning,
  type SmsDecisionInput,
  type SmsHomeResponse,
  type SmsRecordContentResponse,
  type SmsRecordDetailResponse,
  type SmsRegisterResponse,
  type SmsSigningPreviewResponse,
} from '../../packages/contracts/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { firstSteps } from '../../apps/web/src/first-steps.js';
import { withRecordGrant } from '../../apps/web/src/people.js';
import { matrixDraftProblems, trimmedMatrix, withCellLevel } from '../../apps/web/src/risk-matrix-draft.js';
import { settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);
const template = (key: string) => rolePresets.find((entry) => entry.key === key)!;

/**
 * An organization's first day in the safety area, from `pnpm org:create` alone with nothing seeded, through the same
 * commands the screens send: the People screen grants authority, the matrix form drafts and revises a matrix, and the
 * record pages review, sign, issue, acknowledge and read.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('A new organization sets up its safety records', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const setup = parseOrganizationSetup([
    '--',
    '--name',
    `Fictional Line Survey ${run}`,
    '--time-zone',
    'America/Denver',
    '--admin',
    'Robin Vale',
    '--id',
    `first-day-safety-${run}`,
  ]);
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork([setup.tenantId], { objectStore: store });
    await app?.close();
    await pool.end();
    await admin.end();
  });

  const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function read<T>(token: string, url: string): Promise<T> {
    const response = await call(token, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }
  async function command(token: string, payload: unknown, headers = {}): Promise<CommandResponse['command']> {
    const response = await call(token, 'POST', '/v1/commands', payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command;
  }
  const detail = (token: string, id: string) => read<SmsRecordDetailResponse>(token, `/v1/sms/records/${id}`);
  const home = (token: string) => read<SmsHomeResponse>(token, '/v1/sms/home');
  const register = async (token: string, kind: string) =>
    (await read<SmsRegisterResponse>(token, `/v1/sms/records?kind=${kind}`)).records;
  /** The first steps as the safety home shows them to this person. */
  async function steps(token: string) {
    const [shown, documents, matrices, reports, me] = await Promise.all([
      home(token),
      register(token, 'document'),
      register(token, 'risk_matrix'),
      register(token, 'report'),
      read<{ principal: { id: string; capabilities: string[] } }>(token, '/v1/me'),
    ]);
    const listed = firstSteps({
      home: shown,
      documents: [...documents, ...matrices],
      reports,
      principal: me.principal,
    });
    return Object.fromEntries(listed.map((step) => [step.key, step]));
  }
  async function decide(token: string, id: string, decision: SmsDecisionInput, headers = {}) {
    const shown = await detail(token, id);
    return command(
      token,
      {
        kind: 'decision.record',
        subject: { kind: 'sms', id },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision,
      },
      headers,
    );
  }
  const preview = (token: string, id: string, meaning: SigningMeaning) =>
    read<SmsSigningPreviewResponse>(token, `/v1/sms/records/${id}/signing?meaning=${meaning}`);
  /** Signs as the signing screen does: the exact content shown, after confirming it is them. */
  async function sign(token: string, id: string, meaning: SigningMeaning, note: string) {
    const shown = await preview(token, id, meaning);
    expect(shown.available, shown.reason).toBe(true);
    const confirmed = await call(token, 'POST', '/v1/local/reauthentications', { credential: token });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const current = await detail(token, id);
    const signature = { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true as const };
    const response = await call(
      token,
      'POST',
      '/v1/commands',
      {
        kind: 'decision.record',
        subject: { kind: 'sms', id },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision:
          meaning === 'risk.accept'
            ? {
                kind: 'risk.accept',
                note,
                assessmentId: current.decisions.find((decision) => decision.kind === 'risk.assess')!.id,
                signature,
              }
            : { kind: meaning, note, versionNumber: current.record.versionNumber, signature },
      },
      { 'x-ledger-reauthentication': confirmed.json().grant },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as CommandResponse['command'];
  }

  /** Adds a person from a role on the People screen; the test API has no identity provider, so it gives them a test credential. */
  async function addPerson(administrator: string, name: string, role: string) {
    const picked = template(role);
    const added = await command(administrator, {
      kind: 'person.add',
      name,
      principalKind: 'human',
      capabilities: picked.capabilities,
      ...(picked.keepsRecords ? { observationGrants: withRecordGrant([], true) } : {}),
    });
    const id = String(added.payload.principalId);
    const token = `ledger-dev-${run}-${role}`;
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), id]);
    return { id, token };
  }
  /** Ticks or clears boxes for a person on the People screen and saves what they may do. */
  async function changeAuthority(administrator: string, id: string, add: Capability[], remove: Capability[] = []) {
    const people = await read<{ principals: PrincipalAuthorityEntry[] }>(administrator, '/v1/authority/principals');
    const person = people.principals.find((entry) => entry.id === id)!;
    const capabilities = [...new Set([...person.capabilities, ...add])].filter((value) => !remove.includes(value));
    await command(administrator, {
      kind: 'authority.update',
      principalId: id,
      expectedRevision: person.revision,
      capabilities,
      active: person.active,
      observationGrants: person.observationGrants ?? [],
    });
  }
  async function upload(token: string, text: string, confidentiality: 'ordinary' | 'restricted_asset_information') {
    const bytes = Buffer.from(text);
    const created = await call(token, 'POST', '/v1/uploads', {
      contentType: 'text/plain',
      byteLength: bytes.byteLength,
      filename: 'site-notes.txt',
      confidentiality,
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await call(token, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, {
      'content-type': 'application/octet-stream',
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect((await call(token, 'POST', `/v1/uploads/${uploadId}/finalize`)).statusCode).toBe(201);
    return uploadId;
  }

  it('drafts and adopts a matrix, accepts a risk, issues a policy and reads a report, from org:create alone', async () => {
    const created = await setUpOrganization(admin, setup, 'local', []);
    if (!created.created) throw new Error('The organization should be new');
    const administrator = created.developmentToken!;

    // Nothing is seeded: no matrix, no records, nothing fictional in the safety home.
    const empty = await home(administrator);
    expect(empty.program).toEqual({ active: false, matrix: null });
    expect(empty.people).toEqual([
      {
        id: created.administratorId,
        name: 'Robin Vale',
        authority: null,
        adopts: true,
        configures: true,
        writes: true,
        readsReports: false,
      },
    ]);
    expect(JSON.stringify(empty)).not.toMatch(/Valley Power|Alpha Dispatch|Beta Inspection|utility/);
    for (const kind of ['hazard', 'document', 'risk_matrix', 'report'])
      expect(await register(administrator, kind)).toEqual([]);
    let shown = await steps(administrator);
    expect(Object.values(shown).map((step) => [step.key, step.onFile])).toEqual([
      ['adopt', true],
      ['accept-low', false],
      ['accept-medium', false],
      ['accept-high', false],
      ['matrix', false],
      ['policy', false],
      ['reports', false],
    ]);
    expect(shown.matrix!.action).toMatchObject({ label: 'Start a risk matrix', who: 'Robin Vale', mine: true });

    const safety = await addPerson(administrator, 'Kim Arden', 'safety');
    const pilot = await addPerson(administrator, 'Lee Brook', 'pilot');
    shown = await steps(administrator);
    expect(shown.reports).toMatchObject({ onFile: true });
    expect(shown.reports!.detail).toContain('Recorded as received by Kim Arden.');

    // The matrix: started from the standard form, renamed and edited, saved as a draft, revised, then signed.
    const edited = structuredClone(standardRiskMatrix);
    edited.name = 'Line survey risk matrix';
    edited.severities[0]!.label = 'Negligible';
    edited.likelihoods[4]!.description = 'Expected on most survey days.';
    const drafted = trimmedMatrix(withCellLevel(edited, 'minor', 'frequent', 'high'));
    expect(matrixDraftProblems(drafted)).toEqual([]);
    const matrixDraft = { kind: 'risk_matrix', schema: 'sms.risk-matrix.1', title: drafted.name, body: drafted };
    const refused = await call(pilot.token, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: { ...matrixDraft, ownerId: pilot.id },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    const opened = await command(administrator, {
      kind: 'sms.record.open',
      record: { ...matrixDraft, ownerId: created.administratorId },
    });
    const matrixId = opened.subject!.id;
    expect((await detail(administrator, matrixId)).record).toMatchObject({ status: 'draft', versionNumber: 1 });
    shown = await steps(administrator);
    expect(shown.matrix).toMatchObject({
      onFile: false,
      action: { label: 'Review and sign the draft', target: { kind: 'record', id: matrixId }, mine: true },
    });
    expect((await preview(safety.token, matrixId, 'matrix.adopt')).available).toBe(false);

    const before = await detail(administrator, matrixId);
    const revisedBody = { ...drafted, levels: drafted.levels.map((level) => ({ ...level })) };
    revisedBody.levels[2]!.meaning = 'Not acceptable without further controls. Only the high risk holder accepts it.';
    await command(administrator, {
      kind: 'sms.record.revise',
      recordId: matrixId,
      expectedRevision: before.basis.revision,
      record: { ...matrixDraft, ownerId: before.record.owner.id, body: revisedBody },
    });
    await sign(administrator, matrixId, 'matrix.adopt', 'Adopted as our matrix for line survey work.');
    const adopted = await home(administrator);
    expect(adopted.program.matrix).toMatchObject({
      record: { id: matrixId, status: 'adopted' },
      version: { versionNumber: 2, body: revisedBody },
    });
    expect((await steps(administrator)).matrix).toEqual({
      key: 'matrix',
      title: 'A risk matrix in force',
      onFile: true,
      detail: 'Line survey risk matrix, version 2, adopted',
    });

    // A hazard is recorded, a control proposed and the risk assessed on the adopted matrix.
    const hazard = await command(safety.token, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: 'Loss of link behind the ridge',
        ownerId: safety.id,
        body: {
          description: 'The control link drops when the aircraft passes behind the ridge on the north survey line.',
          consequence: 'Uncontrolled descent onto the access road.',
          source: { kind: 'manual_identification' },
        },
      },
    });
    const hazardId = hazard.subject!.id;
    const identified = await detail(safety.token, hazardId);
    expect(identified.controlTypes!.map((type) => type.id).sort()).toEqual([
      'control.avoidance-area',
      'control.described-measure',
      'control.operating-limit',
    ]);
    const measure = identified.controlTypes!.find((type) => type.id === 'control.described-measure')!;
    const control = await command(safety.token, {
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: 'Relay aircraft on the north line',
        ownerId: safety.id,
        body: {
          hazardId,
          controlType: { id: measure.id, version: measure.version, digest: measure.digest },
          parameters: { measure: 'Fly a relay aircraft above the ridge whenever the north line is surveyed.' },
          effectiveFrom: new Date().toISOString(),
        },
      },
    });
    // An operating limit can be proposed from the same form; nothing reports its observations without an adapter.
    const limit = identified.controlTypes!.find((type) => type.id === 'control.operating-limit')!;
    const reported = identified.observationTypes!.find((type) => type.numericFields.length > 0)!;
    await command(safety.token, {
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: 'Reported value limit',
        ownerId: safety.id,
        body: {
          hazardId,
          controlType: { id: limit.id, version: limit.version, digest: limit.digest },
          parameters: {
            observationType: reported.type,
            observationVersion: reported.version,
            field: reported.numericFields[0]!.field,
            comparison: 'at_least',
            limit: 25,
            unit: 'percent',
            scope: 'organization',
          },
          effectiveFrom: new Date().toISOString(),
        },
      },
    });
    const proposed = await detail(safety.token, hazardId);
    expect(proposed.controls!.map((entry) => entry.status)).toEqual(['proposed', 'proposed']);
    const relay = proposed.controls!.find((entry) => entry.id === control.subject!.id)!;
    await decide(safety.token, hazardId, {
      kind: 'risk.assess',
      note: 'Assessed with the survey crew.',
      matrix: { recordId: matrixId, versionNumber: 2 },
      initial: { severity: 'catastrophic', likelihood: 'probable' },
      controls: [{ recordId: relay.id, versionNumber: relay.versionNumber }],
      residual: { severity: 'hazardous', likelihood: 'remote' },
      newHazardCheck: { answer: 'none_identified' },
    });
    const assessed = await detail(safety.token, hazardId);
    expect(assessed.record).toMatchObject({ status: 'awaiting_acceptance', residual: { level: 'high' } });
    expect(assessed.actions.accept.available).toBe(false);

    // The administrator grants high risk acceptance on the People screen; it takes effect at once.
    await changeAuthority(administrator, safety.id, ['risk:accept:high']);
    expect((await detail(safety.token, hazardId)).actions.accept.available).toBe(true);
    expect((await steps(administrator))['accept-high']).toMatchObject({ onFile: true, detail: 'Kim Arden' });
    await sign(safety.token, hazardId, 'risk.accept', 'Accepted with the relay aircraft in place.');
    expect((await detail(safety.token, hazardId)).record.status).toBe('accepted');
    await changeAuthority(administrator, safety.id, [], ['risk:accept:high']);
    expect((await steps(administrator))['accept-high']).toMatchObject({ onFile: false });

    // The safety policy is drafted, reviewed, signed, issued and acknowledged by another person.
    const policyBody: DocumentBodyV2 = {
      origin: 'authored',
      documentType: 'safety_policy',
      revisionLabel: 'Revision 1',
      summary: 'Our commitment to safe line survey work.',
      text: 'We plan each survey line with the crew, stop work when the link is in doubt, and report every concern.',
      changeReason: 'Initial issue',
    };
    const policy = await command(safety.token, {
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: 'Safety policy',
        ownerId: safety.id,
        body: policyBody,
      },
    });
    const policyId = policy.subject!.id;
    expect((await steps(safety.token)).policy).toMatchObject({
      onFile: false,
      action: { label: 'Open the draft policy', target: { id: policyId } },
    });
    await decide(safety.token, policyId, {
      kind: 'document.review',
      versionNumber: 1,
      attachmentIds: [],
      note: 'Reviewed the text of revision 1.',
    });
    const policyAdoption = await sign(administrator, policyId, 'document.adopt', 'Our policy from today.');
    await decide(safety.token, policyId, {
      kind: 'document.issue',
      versionNumber: 1,
      adoptionId: policyAdoption.id,
      recipientIds: [pilot.id],
      note: 'Issued to everyone who flies.',
    });
    const issued = (await detail(pilot.token, policyId)).documentControl!.effectiveIssue!;
    expect((await home(pilot.token)).reading).toContainEqual(
      expect.objectContaining({ recordId: policyId, issueId: issued.id, acknowledgedAt: null }),
    );
    await command(pilot.token, {
      kind: 'sms.document.acknowledge',
      recordId: policyId,
      issueId: issued.id,
      contentDigest: issued.contentDigest,
    });
    expect((await home(pilot.token)).reading).toContainEqual(
      expect.objectContaining({ recordId: policyId, acknowledgedAt: expect.any(String) }),
    );
    expect((await steps(administrator)).policy).toMatchObject({
      onFile: true,
      detail: 'Safety policy, Revision 1, in force',
    });

    // A safety report is recorded as received; who reported stays with people cleared to read reports.
    const reporter = `Reporter ${run}`;
    const report = await command(safety.token, {
      kind: 'sms.record.open',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: 'Aircraft drifted toward the road',
        ownerId: safety.id,
        body: {
          narrative:
            'During the north line survey the aircraft drifted toward the access road before the link came back.',
          received: { channel: 'phone' },
          reporter: { name: reporter },
        },
      },
    });
    const reportId = report.subject!.id;
    expect((await steps(administrator)).reports!.detail).toContain('1 safety report on file.');
    const unseen = await detail(pilot.token, reportId);
    expect(unseen.current.body).toBeNull();
    expect(unseen.actions.readContent.available).toBe(false);
    expect(JSON.stringify(unseen)).not.toContain(reporter);
    expect((await call(pilot.token, 'GET', `/v1/sms/records/${reportId}/content`)).statusCode).toBe(403);
    const content = await read<SmsRecordContentResponse>(safety.token, `/v1/sms/records/${reportId}/content`);
    expect(content.versions[0]!.body.reporter).toEqual({ name: reporter });

    // Reading safety reports is granted and taken away on the People screen, each at once.
    await changeAuthority(administrator, pilot.id, ['sms:report:read']);
    expect((await detail(pilot.token, reportId)).actions.readContent.available).toBe(true);
    const granted = await read<SmsRecordContentResponse>(pilot.token, `/v1/sms/records/${reportId}/content`);
    expect(granted.versions[0]!.body.reporter).toEqual({ name: reporter });
    await changeAuthority(administrator, pilot.id, [], ['sms:report:read']);
    expect((await call(pilot.token, 'GET', `/v1/sms/records/${reportId}/content`)).statusCode).toBe(403);

    // So are restricted attachments.
    const hazardNow = await detail(safety.token, hazardId);
    await command(safety.token, {
      kind: 'sms.attachment.add',
      recordId: hazardId,
      expectedRevision: hazardNow.basis.revision,
      attachment: {
        uploadId: await upload(safety.token, 'Access gate code and relay site.', 'restricted_asset_information'),
        label: 'Relay site access',
      },
    });
    const attachment = (await detail(pilot.token, hazardId)).attachments.find(
      (entry) => entry.label === 'Relay site access',
    )!;
    const download = () => call(pilot.token, 'GET', `/v1/sms/attachments/${attachment.id}/content`);
    expect(attachment.readable).toBe(false);
    expect((await download()).statusCode).toBe(403);
    await changeAuthority(administrator, pilot.id, ['sms:restricted:read']);
    expect(
      (await detail(pilot.token, hazardId)).attachments.find((entry) => entry.id === attachment.id)!.readable,
    ).toBe(true);
    expect((await download()).statusCode).toBe(200);
    await changeAuthority(administrator, pilot.id, [], ['sms:restricted:read']);
    expect((await download()).statusCode).toBe(403);

    // And adoption authority: a revised matrix stays a draft, the adopted version stays in force, until it is signed.
    const inForce = await detail(administrator, matrixId);
    await command(administrator, {
      kind: 'sms.record.revise',
      recordId: matrixId,
      expectedRevision: inForce.basis.revision,
      record: {
        ...matrixDraft,
        ownerId: inForce.record.owner.id,
        body: { ...revisedBody, name: 'Line survey risk matrix, 2' },
      },
    });
    expect((await home(administrator)).program.matrix!.version.versionNumber).toBe(2);
    expect((await preview(pilot.token, matrixId, 'matrix.adopt')).available).toBe(false);
    await changeAuthority(administrator, pilot.id, ['sms:adopt', 'decision:write']);
    expect((await preview(pilot.token, matrixId, 'matrix.adopt')).available).toBe(true);
    await changeAuthority(administrator, pilot.id, [], ['sms:adopt', 'decision:write']);
    expect((await preview(pilot.token, matrixId, 'matrix.adopt')).available).toBe(false);

    // With everything on file the list says what is on file, and nothing more.
    await changeAuthority(administrator, created.administratorId, ['risk:accept:high']);
    const everything = await steps(administrator);
    expect(Object.values(everything).every((step) => step.onFile && !step.action)).toBe(true);
    expect(JSON.stringify(everything)).not.toMatch(/complete|ready|conform|compliant|authorized/i);
  });
});
