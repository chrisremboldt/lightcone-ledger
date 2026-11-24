import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdoptionRuleCoverageResponse,
  AssuranceBody,
  RuleCoverageSubjectsResponse,
  SmsBasis,
  SmsDecisionInput,
  SmsHomeResponse,
  SmsRecordDetailResponse,
  SmsRegisterResponse,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

// Safety assurance records (docs/design/assurance-records.md): an audit with two actions, one closed and one that
// opens a hazard, a review of safety performance, and the counts the Part 108 pack's safety management rule reads.
const RULE = 'ledger.nprm.108.560.a.safety-assurance';
const TYPE = 'organization.record-in-force';

type Role = 'safety' | 'executive' | 'crew' | 'reader';
const capabilities: Record<Role, string[]> = {
  safety: ['sms:read', 'sms:write', 'sms:report:read', 'decision:write', 'evidence:read'],
  executive: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read'],
  crew: ['sms:read', 'sms:write', 'decision:write'],
  reader: ['sms:read'],
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('safety assurance records, counted by the Part 108 rules', () => {
  let tenant: CoverageTenant;
  const people = {} as Record<Role, AuthContext>;
  let adoptionId: string;
  let auditId: string;
  let today: string;
  let yesterday: string;
  let nextWeek: string;

  beforeAll(async () => {
    tenant = await coverageTenant('assurance-records');
    for (const role of Object.keys(capabilities) as Role[]) {
      people[role] = {
        tenantId: tenant.tenantId,
        id: `${tenant.tenantId}:${role}`,
        revision: 1,
        kind: 'human',
        name: `Avery Example ${role}`,
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
    const now = Date.parse(await databaseNow(tenant.admin));
    const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    [today, yesterday, nextWeek] = [day(0), day(-1), day(7)];
  });
  afterAll(async () => {
    await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  async function post(principal: AuthContext, payload: unknown, headers: Record<string, string> = {}) {
    return tenant.call(principal, 'POST', '/v1/commands', payload, headers);
  }
  async function command(principal: AuthContext, payload: unknown, headers: Record<string, string> = {}) {
    const response = await post(principal, payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as { id: string; subject: { id: string } };
  }
  async function detail(id: string, principal = people.safety): Promise<SmsRecordDetailResponse> {
    const response = await tenant.call(principal, 'GET', `/v1/sms/records/${id}`);
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
  const record = (title: string, body: AssuranceBody) => ({
    kind: 'assurance' as const,
    schema: 'sms.assurance.1' as const,
    title,
    ownerId: people.safety.id,
    body,
  });
  async function open(title: string, body: AssuranceBody): Promise<string> {
    return (await command(people.safety, { kind: 'sms.record.open', record: record(title, body) })).subject.id;
  }
  async function sign(id: string) {
    const preview = await tenant.call(people.executive, 'GET', `/v1/sms/records/${id}/signing?meaning=assurance.sign`);
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json();
    expect(shown.available, shown.reason).toBe(true);
    const grant = await tenant.call(people.executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${people.executive.id}`,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    return command(
      people.executive,
      decision(id, shown.basis, {
        kind: 'assurance.sign',
        versionNumber: (await detail(id)).record.versionNumber,
        note: 'Signed as the record of what was done.',
        signature: { intent: shown.intent, contentDigest: shown.contentDigest, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant.json().grant },
    );
  }
  async function closeAction(principal: AuthContext, id: string, actionId: string, note: string) {
    return post(principal, decision(id, (await detail(id, principal)).basis, { kind: 'action.close', actionId, note }));
  }
  async function evaluation(result: string) {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${RULE}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const subjects = (read.json() as RuleCoverageSubjectsResponse).subjects.filter(
      (item) => item.subject.id === `organization:${tenant.tenantId}`,
    );
    expect(subjects).toHaveLength(1);
    return subjects[0]!.evaluation!;
  }

  it('reads nothing on file for a new organization that adopted the Part 108 pack in shadow', async () => {
    const started = Date.parse(await databaseNow(tenant.admin));
    adoptionId = await tenant.adopt(getRulePackVersion('ledger.part108-nprm', 3)!, 'shadow', {
      effectiveInterval: {
        start: new Date(started - 10 * 86_400_000).toISOString(),
        end: new Date(started + 30 * 86_400_000).toISOString(),
      },
    });
    await tenant.settle();
    const coverage = await tenant.call(tenant.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(coverage.statusCode, coverage.body).toBe(200);
    const rule = (coverage.json() as AdoptionRuleCoverageResponse).rules.find((entry) => entry.leafId === RULE)!;
    expect(rule.counts).toMatchObject({ no_record: 1 });
    const register = await tenant.call(people.reader, 'GET', '/v1/sms/records?kind=assurance');
    expect((register.json() as SmsRegisterResponse).records).toEqual([]);
  });

  it('refuses a body its type does not ask for, and an action owner who is not a person here', async () => {
    const audit: AssuranceBody = {
      assuranceType: 'audit',
      performedOn: today,
      scope: 'Preflight records of the fictional survey crews.',
      examined: 'Ten flight records and their preflight assessments.',
      findings: [],
      actions: [],
      occurredOn: today,
    };
    const refused = await post(people.safety, { kind: 'sms.record.open', record: record('Refused audit', audit) });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'invalid_assurance_record' });
    const { occurredOn, ...plain } = audit;
    void occurredOn;
    const unowned = await post(people.safety, {
      kind: 'sms.record.open',
      record: record('Refused audit', {
        ...plain,
        actions: [{ id: 'A1', what: 'Retrain.', ownerId: 'nobody-here', dueOn: nextWeek }],
      }),
    });
    expect(unowned.statusCode, unowned.body).toBe(400);
    expect(unowned.json().error.code).toBe('action_owner_unavailable');
  });

  it('records an audit with two actions, sets them by a signature, closes one and opens a hazard from the other', async () => {
    auditId = await open('Preflight records audit, RIDGE-AUD-1', {
      assuranceType: 'audit',
      performedOn: yesterday,
      completedOn: today,
      scope: 'Preflight records of the fictional survey crews.',
      examined: 'Ten flight records and their preflight assessments, RIDGE-AC-1 and RIDGE-AC-2.',
      findings: [
        { id: 'F1', text: 'Two preflight assessments were signed after takeoff.' },
        { id: 'F2', text: 'The battery log of RIDGE-AC-2 had gaps.' },
      ],
      actions: [
        {
          id: 'A1',
          what: 'Brief the crews on signing before takeoff.',
          ownerId: people.crew.id,
          dueOn: nextWeek,
          findingId: 'F1',
        },
        {
          id: 'A2',
          what: 'Find why the battery log has gaps.',
          ownerId: people.safety.id,
          dueOn: yesterday,
          findingId: 'F2',
        },
      ],
    });
    const drafted = await detail(auditId);
    expect(drafted.record).toMatchObject({
      kind: 'assurance',
      status: 'draft',
      recordClass: 'safety_assurance_output',
    });
    expect(drafted.assurance!.actions.map((action) => [action.id, action.state])).toEqual([
      ['A1', 'proposed'],
      ['A2', 'proposed'],
    ]);
    // An action is set when a version listing it is signed, not before.
    const early = await closeAction(people.crew, auditId, 'A1', 'Briefed.');
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.code).toBe('action_not_set');

    // Only someone with the authority to adopt safety documentation signs it.
    const preview = await tenant.call(
      people.safety,
      'GET',
      `/v1/sms/records/${auditId}/signing?meaning=assurance.sign`,
    );
    expect(preview.json()).toMatchObject({ available: false });
    await sign(auditId);
    const signed = await detail(auditId);
    expect(signed.record.status).toBe('signed');
    expect(signed.signatures[0]).toMatchObject({ meaning: 'assurance.sign' });
    expect(signed.assurance!.actions.map((action) => [action.id, action.state, action.overdue])).toEqual([
      ['A1', 'open', false],
      ['A2', 'open', true],
    ]);

    const home = await tenant.call(people.reader, 'GET', '/v1/sms/home');
    expect(home.statusCode, home.body).toBe(200);
    expect(
      (home.json() as SmsHomeResponse).assuranceActions.map((group) => [
        group.owner.id,
        group.actions.map((action) => [action.actionId, action.overdue]),
      ]),
    ).toEqual([
      [people.safety.id, [['A2', true]]],
      [people.crew.id, [['A1', false]]],
    ]);

    // Neither a reader nor someone else's action: the action's owner closes A1, recording what was done.
    const notOwner = await closeAction(people.reader, auditId, 'A1', 'Briefed.');
    expect(notOwner.statusCode, notOwner.body).toBe(403);
    const closed = await closeAction(people.crew, auditId, 'A1', 'Briefed all three crews on 2026 procedures.');
    expect(closed.statusCode, closed.body).toBe(201);
    const after = await detail(auditId);
    expect(after.record.status).toBe('signed');
    expect(after.assurance!.actions.find((action) => action.id === 'A1')).toMatchObject({
      state: 'closed',
      closed: { by: { id: people.crew.id }, note: 'Briefed all three crews on 2026 procedures.' },
    });

    // A2 opens a hazard that keeps it as its origin.
    const hazard = await command(people.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: 'Battery state unknown at launch',
        ownerId: people.safety.id,
        body: {
          description: 'Gaps in the battery log leave the state of charge at launch unknown.',
          consequence: 'Loss of power over the survey area.',
          source: { kind: 'assurance' },
        },
      },
      origin: { kind: 'assurance', recordId: auditId, versionNumber: 1, item: { kind: 'action', id: 'A2' } },
    });
    const opened = await detail(hazard.subject.id);
    expect(opened.origin).toMatchObject({
      kind: 'assurance',
      recordId: auditId,
      versionNumber: 1,
      assuranceType: 'audit',
      item: { kind: 'action', id: 'A2' },
    });
    expect(opened.links).toContainEqual(
      expect.objectContaining({ relation: 'derived_from', target: { kind: 'sms_record', id: auditId } }),
    );
    expect((await detail(auditId)).assurance!.hazards).toEqual([
      { item: { kind: 'action', id: 'A2' }, record: expect.objectContaining({ id: hazard.subject.id }) },
    ]);

    // A revision keeps the closed action as it was closed.
    const revised = await post(people.safety, {
      kind: 'sms.record.revise',
      recordId: auditId,
      expectedRevision: (await detail(auditId)).basis.revision,
      record: record('Preflight records audit, RIDGE-AUD-1', {
        ...(after.current.body as AssuranceBody),
        actions: (after.current.body as AssuranceBody).actions.filter((action) => action.id !== 'A1'),
      }),
    });
    expect(revised.statusCode, revised.body).toBe(400);
    expect(revised.json().error.code).toBe('closed_action_changed');
  });

  it('links an investigation to the report it started from without copying it, readable without reading reports', async () => {
    const report = await command(people.safety, {
      kind: 'sms.record.open',
      confidentiality: 'safety_report',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: 'Crew report RIDGE-REP-SECRET',
        ownerId: people.safety.id,
        body: { narrative: 'RIDGE-REP-SECRET narrative.', received: { channel: 'email' } },
      },
    });
    const investigation = await open('Possible non-compliance, RIDGE-INV-1', {
      assuranceType: 'noncompliance_investigation',
      performedOn: today,
      scope: 'Whether a flight left without a preflight assessment.',
      examined: 'The flight record and the crew’s statements.',
      findings: [],
      actions: [],
      fromReport: report.subject.id,
    });
    const read = await detail(investigation, people.reader);
    expect(read.links).toEqual([
      expect.objectContaining({ relation: 'derived_from', target: { kind: 'sms_record', id: report.subject.id } }),
    ]);
    expect(JSON.stringify(read)).not.toContain('RIDGE-REP-SECRET');
  });

  it('records a review of safety performance and reads the counts from the Part 108 shadow coverage', async () => {
    const review = await open('Quarterly review of safety performance', {
      assuranceType: 'management_review',
      performedOn: today,
      scope: 'Safety performance of the survey operation this quarter.',
      examined: 'The hazard register, the open actions and the audit RIDGE-AUD-1.',
      findings: [],
      actions: [],
    });
    await sign(review);
    await tenant.settle();

    const values = await tenant.admin.query<{ values: Record<string, unknown>; interval: { end?: string } }>(
      `SELECT o.observation->'values' AS values,o.observation->'interval' AS interval FROM observations o
       WHERE o.tenant_id=$1 AND o.observation_type=$2 AND o.observation#>>'{values,recordKind}'='assurance'
         AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.replaces_observation_id=o.id)
       ORDER BY o.observation#>>'{values,recordId}',o.observation#>>'{values,actionId}' NULLS FIRST`,
      [tenant.tenantId, TYPE],
    );
    // What is on file names the records' types and dates, never their content.
    expect(JSON.stringify(values.rows)).not.toMatch(/battery|Preflight|RIDGE/);
    expect(
      values.rows
        .filter((row) => row.values.item === 'action')
        .map((row) => [row.values.actionId, Boolean(row.interval.end)]),
    ).toEqual(
      expect.arrayContaining([
        ['A1', true],
        ['A2', false],
      ]),
    );

    const counted = await evaluation('supported');
    expect(counted.summary).toContain('2 signed safety assurance records on file since');
    expect(counted.summary).toContain('audits of operational processes and systems: 1');
    expect(counted.summary).toContain('reviews of safety performance by the accountable executive: 1');
    expect(counted.summary).toContain('Actions they set: 1 open, 1 of them past the due date.');
    expect(counted.summary).not.toMatch(/\bcomplian|conform/i);
  });
});
