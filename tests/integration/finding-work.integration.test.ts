import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FindingTreatment,
  FlightsOnRecordResponse,
  OpenFindingsResponse,
  SmsFindingPromotionResponse,
  SubjectFindingListResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const CERTIFICATE_RULE = 'ledger.part107.107.12.b';

function certificate(subjectId: string, recordedStatus: string, replaces?: string): Record<string, unknown> {
  return {
    subjectId,
    credentialKind: 'remote_pilot_certificate',
    credentialNumber: `RP-${subjectId.slice(-6)}`,
    recordedStatus,
    ...(replaces ? { replaces } : {}),
  };
}

describe('work on a finding about a person', () => {
  let tenant: CoverageTenant;
  let colleague: AuthContext;
  let source: AuthContext;
  let people: Record<'avery' | 'blake' | 'casey', string>;
  let certificates: string[];
  let adoptionId: string;

  async function person(id: string, name: string, kind: string, capabilities: string[]): Promise<AuthContext> {
    const principal: AuthContext = {
      id: `${tenant.tenantId}:${id}`,
      tenantId: tenant.tenantId,
      name,
      kind,
      capabilities,
      revision: 1,
    };
    await tenant.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      principal.id,
      tenant.tenantId,
      name,
      kind,
      capabilities,
    ]);
    await tenant.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${principal.id}`),
      principal.id,
    ]);
    return principal;
  }

  async function findingAbout(subjectId: string): Promise<SubjectFindingRecord> {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/findings?subjectKind=person&subjectId=${encodeURIComponent(subjectId)}&subjectScope=source&sourceId=${tenant.sourceId}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const found = (read.json() as SubjectFindingListResponse).findings.find((item) => item.ruleId === CERTIFICATE_RULE);
    expect(found, subjectId).toBeDefined();
    return found!;
  }

  function treat(
    by: AuthContext,
    finding: SubjectFindingRecord,
    treatment: Omit<FindingTreatment, 'findingId' | 'evaluationId'>,
    note: string,
  ) {
    return tenant.call(by, 'POST', '/v1/commands', {
      kind: 'finding.treat',
      treatment: { findingId: finding.id, evaluationId: finding.latestEvaluation.id, ...treatment },
      note,
    });
  }

  async function openFindings(query = ''): Promise<OpenFindingsResponse> {
    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/open-findings${query}`);
    expect(read.statusCode, read.body).toBe(200);
    return read.json() as OpenFindingsResponse;
  }

  beforeAll(async () => {
    tenant = await coverageTenant('finding-work');
    people = {
      avery: `${tenant.prefix}-PILOT-AVERY`,
      blake: `${tenant.prefix}-PILOT-BLAKE`,
      casey: `${tenant.prefix}-PILOT-CASEY`,
    };
    // The actor takes the capabilities a person who works findings and opens hazards holds.
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.actor.id)}`,
    );
    expect(current.statusCode, current.body).toBe(200);
    tenant.actor.capabilities = [...current.json().principal.capabilities, 'decision:write', 'sms:read', 'sms:write'];
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.actor.id,
      expectedRevision: current.json().principal.revision,
      capabilities: tenant.actor.capabilities,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    colleague = await person('colleague', 'Avery Example', 'human', ['evidence:read', 'flight:read', 'decision:write']);
    source = await person('source', 'Fictional records feed', 'source', [
      'evidence:read',
      'flight:read',
      'decision:write',
      'pack:adopt',
    ]);
    certificates = await tenant.importRecords('person.certificate', [
      certificate(people.avery, 'suspended'),
      certificate(people.blake, 'suspended'),
      certificate(people.casey, 'held'),
    ]);
    adoptionId = await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active');
    await tenant.settle();
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('lists the findings about people with nobody owning them, oldest first', async () => {
    expect(adoptionId).toBeTruthy();
    const listed = await openFindings('?subjectKind=person');
    const about = listed.findings.filter((item) => item.ruleId === CERTIFICATE_RULE);
    expect(about.map((item) => item.subject.id).sort()).toEqual([people.avery, people.blake].sort());
    for (const item of about)
      expect(item).toMatchObject({
        subject: { scope: 'source', kind: 'person', sourceId: tenant.sourceId },
        packId: 'ledger.part107',
        mode: 'active',
        status: 'open',
        owner: null,
      });
    expect(listed.attention.unowned).toBeGreaterThanOrEqual(2);
    const opened = listed.findings.map((item) => item.openedAt);
    expect(opened).toEqual([...opened].sort());
    expect((await openFindings('?shown=proposed')).findings).toEqual([]);
  });

  it('takes a finding, assigns it, records an action and what was done, closes by a later record and by a person', async () => {
    let finding = await findingAbout(people.avery);
    // Only the owner records an action; a person takes the finding first.
    const early = await treat(
      colleague,
      finding,
      { action: 'plan', dueOn: '2000-01-01' },
      'Ask for the current certificate',
    );
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.code).toBe('finding_owner_required');

    const taken = await treat(
      tenant.actor,
      finding,
      { action: 'acknowledge' },
      'I will look at the certificate on file',
    );
    expect(taken.statusCode, taken.body).toBe(201);
    const assigned = await treat(
      tenant.actor,
      finding,
      { action: 'assign', assigneeId: colleague.id },
      'Avery keeps the training files',
    );
    expect(assigned.statusCode, assigned.body).toBe(201);
    finding = await findingAbout(people.avery);
    expect(finding.owner).toEqual({ id: colleague.id, name: 'Avery Example' });
    expect((await openFindings(`?owner=${encodeURIComponent(colleague.id)}`)).findings.map((item) => item.id)).toEqual([
      finding.id,
    ]);

    const planned = await treat(
      colleague,
      finding,
      { action: 'plan', dueOn: '2000-01-01' },
      'Ask for the current certificate',
    );
    expect(planned.statusCode, planned.body).toBe(201);
    let listed = await openFindings('?subjectKind=person');
    expect(listed.findings.find((item) => item.id === finding.id)!.action).toEqual({
      note: 'Ask for the current certificate',
      dueOn: '2000-01-01',
      overdue: true,
    });
    expect(listed.attention.overdue).toBe(1);
    const done = await treat(
      colleague,
      finding,
      { action: 'respond' },
      'Asked; the pilot sends the reinstated certificate',
    );
    expect(done.statusCode, done.body).toBe(201);
    listed = await openFindings('?subjectKind=person');
    expect(listed.findings.find((item) => item.id === finding.id)!.action).toMatchObject({ overdue: false });
    expect(listed.attention.overdue).toBe(0);

    // The reinstated certificate replaces the suspended one; the finding closes by itself and says which record.
    const [reinstated] = await tenant.importRecords('person.certificate', [
      certificate(people.avery, 'held', certificates[0]),
    ]);
    await tenant.settle();
    finding = await findingAbout(people.avery);
    expect(finding.status).toBe('resolved');
    expect(finding.closure).toMatchObject({
      by: 'record',
      evaluationId: finding.latestEvaluation.id,
      records: [{ observationId: reinstated, title: expect.any(String) }],
    });
    expect((await openFindings('?subjectKind=person')).findings.map((item) => item.id)).not.toContain(finding.id);
    const late = await treat(colleague, finding, { action: 'close', reason: 'accepted' }, 'Too late');
    expect(late.json().error.code).toBe('finding_resolved');

    // A later suspension reopens it with its owner; the owner closes it with a reason.
    await tenant.importRecords('person.certificate', [certificate(people.avery, 'suspended', reinstated)]);
    await tenant.settle();
    finding = await findingAbout(people.avery);
    expect(finding).toMatchObject({ status: 'acknowledged', owner: { id: colleague.id } });
    expect(finding.closure).toBeUndefined();
    const notOwner = await treat(tenant.actor, finding, { action: 'close', reason: 'recorded_in_error' }, 'Not mine');
    expect(notOwner.json().error.code).toBe('finding_owner_required');
    const missingReason = await treat(colleague, finding, { action: 'close' }, 'No reason');
    expect(missingReason.statusCode).toBe(400);
    const closed = await treat(
      colleague,
      finding,
      { action: 'close', reason: 'recorded_in_error' },
      'The suspension was entered against the wrong pilot',
    );
    expect(closed.statusCode, closed.body).toBe(201);
    finding = await findingAbout(people.avery);
    expect(finding.status).toBe('resolved');
    expect(finding.closure).toMatchObject({
      by: 'person',
      reason: 'recorded_in_error',
      actorName: 'Avery Example',
      note: 'The suspension was entered against the wrong pilot',
    });
    expect(finding.treatments.map((item) => item.action)).toEqual([
      'acknowledge',
      'assign',
      'plan',
      'respond',
      'close',
    ]);
    expect(finding.treatments[1]).toMatchObject({ assignee: { id: colleague.id, name: 'Avery Example' } });
  });

  it('opens a hazard from another finding about a person, keeping its origin', async () => {
    const finding = await findingAbout(people.blake);
    const shown = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/sms/findings/${encodeURIComponent(finding.id)}/promotion`,
    );
    expect(shown.statusCode, shown.body).toBe(200);
    const promotion = shown.json() as SmsFindingPromotionResponse;
    expect(promotion.origin).toMatchObject({
      kind: 'finding',
      findingId: finding.id,
      subject: { scope: 'source', kind: 'person', id: people.blake },
    });
    const opened = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: 'Pilot flying with a suspended certificate',
        ownerId: tenant.actor.id,
        body: {
          description: `Raised from: ${promotion.evaluation.summary}`,
          consequence: 'A flight flown by a pilot whose certificate is suspended.',
          source: { kind: 'finding' },
        },
      },
      origin: {
        kind: 'finding',
        findingId: promotion.origin.findingId,
        evaluationId: promotion.origin.evaluationId,
        expectedDependencyBasis: promotion.basis.dependencyBasis,
      },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const hazardId = opened.json().command.subject.id as string;
    const detail = await tenant.call(tenant.actor, 'GET', `/v1/sms/records/${hazardId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().origin).toMatchObject({ kind: 'finding', findingId: finding.id });
  });

  it('refuses an adoption, a revision and each finding decision from a principal that is not a person', async () => {
    const finding = await findingAbout(people.blake);
    const treated = await treat(source, finding, { action: 'acknowledge' }, 'Taken by the feed');
    expect(treated.statusCode, treated.body).toBe(403);
    expect(treated.json().error).toMatchObject({ code: 'person_required' });
    expect(treated.json().error.message).toMatch(/decisions of a person/);

    const shown = await tenant.call(source, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const coverage = shown.json();
    const adoption = coverage.adoptions.find((item: { id: string }) => item.id === adoptionId);
    const pack = getRulePackVersion('ledger.part107', 2)!;
    const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
      id,
      version,
      digest,
    });
    const revision = await tenant.call(source, 'POST', '/v1/commands', {
      kind: 'rule-pack.adopt',
      expectedRevision: coverage.organization.revision,
      inputCut: {
        ...coverage.meta.inputCut,
        basisRevision: coverage.organization.revision,
        principalRevision: coverage.meta.inputCut.principalRevision,
      },
      expectedDependencyBasis: coverage.meta.dependencyBasis,
      pack: {
        packId: pack.packId,
        version: pack.version,
        digest: pack.digest,
        leaves: pack.leaves.map(reference),
        bindings: pack.bindings.map(reference),
      },
      effectiveInterval: adoption.effectiveInterval,
      note: 'The feed switches the pack to shadow.',
      mode: 'shadow',
      revises: adoptionId,
    });
    expect(revision.statusCode, revision.body).toBe(403);
    expect(revision.json().error).toMatchObject({ code: 'person_required' });
    expect(revision.json().error.message).toMatch(/This credential belongs to a source/);
  });

  it('lists the flights on record from their plans, upcoming first, then recent', async () => {
    const now = Date.parse(await databaseNow(tenant.admin));
    const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    const flights = {
      soon: `${tenant.prefix}-FLT-SOON`,
      later: `${tenant.prefix}-FLT-LATER`,
      flown: `${tenant.prefix}-FLT-FLOWN`,
    };
    const aircraft = `${tenant.prefix}-RIDGE-AC-1`;
    const plan = (subjectId: string, start: number) => ({
      subjectId,
      secondarySubjectId: aircraft,
      windowStartsAt: at(start),
      windowEndsAt: at(start + 1),
      operationKind: 'inspection',
      plannedOriginDescription: 'North substation pad',
      plannedDestinationDescription: 'North substation pad',
      routeSummary: 'Transmission line segment 14',
    });
    await tenant.importRecords('flight.plan', [
      plan(flights.later, 48),
      plan(flights.flown, -24),
      plan(flights.soon, 24),
    ]);
    await tenant.importRecords('operation.role-assignment', [
      {
        subjectId: flights.soon,
        subjectKind: 'flight',
        personId: people.casey,
        role: 'pilot_in_command',
        startsAt: at(24),
        endsAt: at(25),
      },
    ]);
    const read = await tenant.call(tenant.actor, 'GET', '/v1/organization/flights-on-record');
    expect(read.statusCode, read.body).toBe(200);
    const home = read.json() as FlightsOnRecordResponse;
    expect(home.orderSource).toBe(false);
    expect(home.upcoming.map((item) => item.subject.id)).toEqual([flights.soon, flights.later]);
    expect(home.recent.map((item) => item.subject.id)).toEqual([flights.flown]);
    expect(home.upcoming[0]).toMatchObject({
      window: { start: at(24), end: at(25) },
      aircraft: { kind: 'aircraft', id: aircraft },
      pilotInCommand: { kind: 'person', id: people.casey },
      openFindings: 0,
    });
    expect(home.upcoming[1]!.pilotInCommand).toBeNull();
    expect(home.attention).toEqual((await openFindings()).attention);
  });
});
