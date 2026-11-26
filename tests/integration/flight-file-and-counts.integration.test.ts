import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  OpenFindingGroupsResponse,
  OpenFindingsResponse,
  PeriodSummary,
  ProgramViewDocument,
  RecordSubjectFile,
  RuleEvaluationListResponse,
  RulePackVersion,
  SubjectFindingListResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion, registerRulePack } from '../../packages/domain/src/rule-pack-registry.js';
import { buildPackFile, registerStandardPacks, verifiedPackFile } from '../../packages/standard-packs/src/index.js';
import { flightFileQuery } from '../../apps/web/src/ReportsArea.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

const DAY = 86_400_000;
const PART107 = 'ledger.part107';
const CERTIFICATE_RULE = 'ledger.part107.107.12.b';
const LINE_OF_SIGHT_RULE = 'ledger.part107.107.31.a';

/**
 * One organization's state, read the ways a person reads it: one flight's file, by Ledger's own id for a flight
 * Ledger holds and by the operator's own id for one its records name; and how many findings are open, on the
 * open-findings list, in the summary of a period and in what a program owner reads under a grant. Where two reads
 * claim the same number they give the same one; coverage counts subjects by their latest result, on purpose not the
 * same thing, and the state below makes it differ.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('One flight’s file, and open findings counted alike', () => {
  let tenant: CoverageTenant;
  let waiver: RulePackVersion;
  let ledgerFlight: string;
  const started = Date.now();
  const at = (days: number) => new Date(started + days * DAY).toISOString();
  const id = (name: string) => `${tenant.prefix}-${name}`;
  const today = new Date(started).toISOString().slice(0, 10);

  async function read<T>(url: string): Promise<T> {
    const response = await tenant.call(tenant.actor, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }
  const subjectFindings = (query: ReturnType<typeof flightFileQuery>) =>
    read<SubjectFindingListResponse>(`/v1/findings?${new URLSearchParams(query as Record<string, string>)}`);
  async function personFinding(person: string, ruleId: string): Promise<SubjectFindingRecord | undefined> {
    const found = await read<SubjectFindingListResponse>(
      `/v1/findings?subjectKind=person&subjectId=${id(person)}&subjectScope=source&sourceId=${tenant.sourceId}`,
    );
    return found.findings.find((item) => item.ruleId === ruleId);
  }
  const treat = (finding: SubjectFindingRecord, treatment: Record<string, unknown>, note: string) =>
    tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'finding.treat',
      treatment: { findingId: finding.id, evaluationId: finding.latestEvaluation.id, ...treatment },
      note,
    });
  const certificate = (person: string, status: string, number: string) => ({
    subjectId: id(person),
    credentialKind: 'remote_pilot_certificate',
    credentialNumber: number,
    recordedStatus: status,
  });
  const plan = (flight: string, visualMode: string, authority?: string) => ({
    subjectId: flight,
    windowStartsAt: at(0.05),
    windowEndsAt: at(0.07),
    operationKind: 'inspection',
    plannedOriginDescription: 'North pad',
    plannedDestinationDescription: 'North pad',
    routeSummary: 'Fictional ridge line survey',
    visualMode,
    ...(authority ? { operatingAuthorityReference: authority } : {}),
  });

  beforeAll(async () => {
    registerStandardPacks({ examples: true });
    tenant = await coverageTenant('flight-file-counts');
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.actor.id)}`,
    );
    tenant.actor.capabilities = [...current.json().principal.capabilities, 'flight:create', 'decision:write'];
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.actor.id,
      expectedRevision: current.json().principal.revision,
      capabilities: tenant.actor.capabilities,
    });
    expect(granted.statusCode, granted.body).toBe(201);

    // A waiver of one provision that relieves Part 107's line-of-sight rule for a flight citing it.
    const quote = 'Operations beyond visual line of sight are permitted only under Certificate of Waiver EX-0457.';
    const source = `Certificate of Waiver EX-0457 (invented for this test)\n\n1. ${quote}\n`;
    waiver = verifiedPackFile(
      buildPackFile(
        {
          pack: { id: `test-${process.pid}.waiver-ex-0457`, version: 1, title: 'Waiver EX-0457 (invented)' },
          source: { file: 'source.txt', kind: 'waiver', reference: 'Certificate of Waiver EX-0457' },
          waiver: {
            certificateNumber: 'EX-0457',
            effective: { from: at(-30).slice(0, 10), through: at(300).slice(0, 10) },
            conditionsCover: 'every flight',
          },
          provisions: [
            {
              number: 1,
              title: 'Relief from visual line of sight',
              quote,
              obligation: 'authority.flight-cites-certificate',
              parameters: {
                certificateNumber: 'EX-0457',
                effectiveFrom: at(-30).slice(0, 10),
                effectiveThrough: at(300).slice(0, 10),
              },
              relieves: [{ packId: PART107, ruleIds: [LINE_OF_SIGHT_RULE] }],
            },
          ],
        } as never,
        source,
      ).file,
    ).version;
    registerRulePack({ packId: waiver.packId, versions: [waiver] });

    // A flight Ledger holds by its own id, with records about it under that id.
    const created = await tenant.call(tenant.actor, 'POST', '/v1/flights', {
      originationKey: `${tenant.prefix}-ledger`,
    });
    expect(created.statusCode, created.body).toBe(201);
    ledgerFlight = created.json().flight.id;
    const exported = [
      { recordType: 'flight.plan', record: plan('', 'beyond_visual_line_of_sight') },
      {
        recordType: 'operation.role-assignment',
        record: {
          personId: { id: id('PILOT-A'), scope: 'source' },
          role: 'visual_observer',
          startsAt: at(0.05),
          endsAt: at(0.07),
        },
      },
    ];
    const exportId = await tenant.upload(Buffer.from(JSON.stringify(exported)));
    for (const [index, record] of exported.entries()) {
      const { subjectId: _subjectId, ...values } = record.record as Record<string, unknown>;
      const sent = await tenant.call(tenant.operator, 'POST', '/v1/inputs', {
        sourceId: tenant.sourceId,
        kind: 'observation',
        occurredAt: at(0.05),
        payload: {
          type: 'operator.record',
          version: 1,
          subject: { kind: 'flight', id: ledgerFlight, scope: 'ledger' },
          occurredAt: at(0.05),
          interval: { start: at(0.05), end: at(0.07) },
          sourceEventId: `${record.recordType}-${index}`,
          values: { recordType: record.recordType, recordVersion: 1, record: values },
          fidelity: 'synthetic_contract',
          limitations: ['Sent by the fictional planning tool of this test.'],
          originalArtifactId: exportId,
          originalLocator: { kind: 'json_pointer', value: `/${index}` },
        },
      });
      expect(sent.statusCode, sent.body).toBeLessThan(300);
    }
    // Flights the operator's records name by its own ids: one with two findings, one a waiver will relieve.
    await tenant.importRecords('flight.plan', [
      plan(id('FLT-TWO'), 'beyond_visual_line_of_sight'),
      plan(id('FLT-RELIEVED'), 'beyond_visual_line_of_sight', 'EX-0457'),
    ]);
    await tenant.importRecords('person.certificate', [
      certificate('PILOT-A', 'suspended', 'RP-A'),
      certificate('PILOT-B', 'suspended', 'RP-B'),
      certificate('PILOT-C', 'suspended', 'RP-C'),
    ]);
    await tenant.importRecords('person.training', [
      { subjectId: id('PILOT-C'), trainingKind: 'initial', courseTitle: 'Fictional course', completedOn: '2026-01-15' },
    ]);
    await tenant.adopt(getRulePackVersion(PART107, 2)!, 'active');
    await tenant.adopt(getRulePackVersion('ledger.part108-nprm', 3)!, 'shadow');
    await tenant.settle();

    // Pilot A's finding is closed; pilot B's is closed and then opened again by a later record.
    for (const person of ['PILOT-A', 'PILOT-B']) {
      const finding = (await personFinding(person, CERTIFICATE_RULE))!;
      expect(finding, person).toBeDefined();
      expect((await treat(finding, { action: 'acknowledge' }, 'Taken')).statusCode).toBe(201);
      const closed = await treat(finding, { action: 'close', reason: 'recorded_in_error' }, 'Closed for the test');
      expect(closed.statusCode, closed.body).toBe(201);
    }
    await tenant.importRecords('person.certificate', [certificate('PILOT-B', 'revoked', 'RP-B2')]);
    await tenant.settle();
    // The waiver is adopted after Part 107: the line-of-sight finding opened, then the waiver relieved it.
    await tenant.adopt(waiver, 'active', { effectiveInterval: { start: at(-30), end: at(1) } });
    await tenant.settle();
  }, 240_000);
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  for (const which of ['ledger', 'source'] as const)
    it(`reads a flight’s records, rule results and findings by ${which === 'ledger' ? 'Ledger’s own id' : 'the operator’s own id'}`, async () => {
      const flightId = which === 'ledger' ? ledgerFlight : id('FLT-TWO');
      const file = await read<RecordSubjectFile>(
        `/v1/operator-records/subjects/flight/${encodeURIComponent(flightId)}?sourceId=${tenant.sourceId}`,
      );
      expect(file.subject).toMatchObject({ kind: 'flight', id: flightId, scope: which });
      expect(file.groups.flatMap((group) => group.records).length).toBeGreaterThan(0);
      expect(file.rules.length).toBeGreaterThan(0);
      expect(file.findings.length).toBeGreaterThan(0);
      // The page asks for the rule results and findings about the subject the file resolved the id to.
      const query = flightFileQuery(file.subject);
      const evaluations = await read<RuleEvaluationListResponse>(
        `/v1/evaluations?${new URLSearchParams(query as Record<string, string>)}`,
      );
      const findings = await subjectFindings(query);
      expect(evaluations.evaluations.map((item) => item.id)).toEqual(
        expect.arrayContaining(file.rules.map((rule) => rule.evaluation.id)),
      );
      expect(findings.findings.map((item) => item.id)).toEqual(
        expect.arrayContaining(file.findings.map((item) => item.id)),
      );
      // The list of the organization's flights names the flight Ledger holds by its label, not as the organization.
      const listed = await read<{ subjects: { subject: { id: string; scope: string; name: string } }[] }>(
        `/v1/operator-records/subjects?kind=flight`,
      );
      const row = listed.subjects.find((item) => item.subject.id === flightId)!;
      expect(row.subject.scope).toBe(which);
      expect(row.subject.name).not.toBe('Your organization');
    });

  it('the state holds a closed finding, a reopened one, a relieved one, proposed ones and two about one flight', async () => {
    const groups = await read<OpenFindingGroupsResponse>('/v1/organization/open-findings/groups');
    expect(groups.counts.proposed).toBeGreaterThan(0);
    expect(groups.counts.relieved).toBeGreaterThan(0);
    expect((await personFinding('PILOT-A', CERTIFICATE_RULE))!.status).toBe('resolved');
    expect((await personFinding('PILOT-B', CERTIFICATE_RULE))!.status).not.toBe('resolved');
    const open = await read<OpenFindingsResponse>('/v1/organization/open-findings?limit=200');
    const perSubject = new Map<string, number>();
    for (const finding of open.findings) {
      const key = `${finding.subject.scope} ${finding.subject.kind} ${finding.subject.id}`;
      perSubject.set(key, (perSubject.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perSubject.values())).toBeGreaterThanOrEqual(2);
  });

  it('counts the same open findings alike on the list, in the summary and for a program owner', async () => {
    const groups = await read<OpenFindingGroupsResponse>('/v1/organization/open-findings/groups');
    const listed = new Map(groups.groups.map((group) => [`${group.packId} ${group.ruleId}`, group.open]));
    expect(groups.total.findings).toBe(groups.counts.counted);

    const summary = await read<PeriodSummary>(`/v1/reports/summary?from=${today}&until=${today}`);
    if (!summary.findings.readable) throw new Error('findings unreadable');
    expect(summary.period.ended).toBe(false);
    const summarized = new Map(
      summary.findings.rules
        .filter((rule) => rule.openAtEnd > 0)
        .map((rule) => [`${rule.packId} ${rule.ruleId}`, rule.openAtEnd]),
    );
    expect(summarized).toEqual(listed);
    expect(summary.findings.total.openAtEnd).toBe(groups.total.findings);

    const made = await tenant.call(tenant.actor, 'POST', '/v1/program-grants', {
      programOwner: 'Fictional Valley Power',
      packs: [PART107],
      openFindings: true,
      productions: [],
    });
    expect(made.statusCode, made.body).toBe(201);
    const answered = await tenant.call(tenant.actor, 'POST', '/v1/program-view', { secret: made.json().secret });
    expect(answered.statusCode, answered.body).toBe(200);
    const document = answered.json() as ProgramViewDocument;
    expect(document.openFindings!.total).toBe(groups.total.findings);
    expect(new Map(document.openFindings!.rules.map((rule) => [`${rule.packId} ${rule.ruleId}`, rule.open]))).toEqual(
      listed,
    );

    // Coverage counts subjects by their latest result, on purpose not open findings: the flight the waiver relieves
    // has an open finding the list does not count, and coverage counts the flight as relieved.
    const relieved = await read<SubjectFindingListResponse>(
      `/v1/findings?subjectKind=flight&subjectId=${id('FLT-RELIEVED')}&subjectScope=source&sourceId=${tenant.sourceId}`,
    );
    expect(relieved.findings.find((item) => item.ruleId === LINE_OF_SIGHT_RULE)!.status).not.toBe('resolved');
    const coverage = document.packs!.find((pack) => pack.packId === PART107)!;
    expect(coverage.rules.find((rule) => rule.ruleId === LINE_OF_SIGHT_RULE)!.counts!.relieved).toBe(1);
  });
});
