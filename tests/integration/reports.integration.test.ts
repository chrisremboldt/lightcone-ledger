import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FindingsByMonth,
  IndicatorHistory,
  PeriodSummary,
  ReportIndicatorList,
  SmsFindingPromotionResponse,
  SubjectFindingListResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

const CERTIFICATE_RULE = 'ledger.part107.107.12.b';

/**
 * The reports count what an organization has on file, under its own scope: flights and flight time from its flight
 * records, findings by rule, actions and hazards. A person who may not read a part is told so, never shown a zero;
 * another organization's records are never counted.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Reports of what is on file', () => {
  let tenant: CoverageTenant;
  let other: CoverageTenant;
  let reader: AuthContext;
  let safetyOnly: AuthContext;
  const started = Date.now();
  const hoursAgo = (hours: number) => new Date(started - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
  // The test organizations keep UTC; a period of yesterday and today holds everything recorded below.
  const today = new Date(started).toISOString().slice(0, 10);
  const yesterday = new Date(started - 86_400_000).toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  async function person(on: CoverageTenant, id: string, name: string, capabilities: string[]): Promise<AuthContext> {
    const principal: AuthContext = {
      id: `${on.tenantId}:${id}`,
      tenantId: on.tenantId,
      name,
      kind: 'human',
      capabilities,
      revision: 1,
    };
    await on.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      principal.id,
      on.tenantId,
      name,
      'human',
      capabilities,
    ]);
    await on.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${principal.id}`),
      principal.id,
    ]);
    return principal;
  }

  async function read<T>(on: CoverageTenant, who: AuthContext, url: string): Promise<T> {
    const response = await on.call(who, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }

  const summary = (on: CoverageTenant, who: AuthContext, from = yesterday, until = today) =>
    read<PeriodSummary>(on, who, `/v1/reports/summary?from=${from}&until=${until}`);

  async function certificateFindings(): Promise<SubjectFindingRecord[]> {
    const found: SubjectFindingRecord[] = [];
    for (const id of ['AVERY', 'BLAKE', 'CASEY']) {
      const listed = await read<SubjectFindingListResponse>(
        tenant,
        tenant.actor,
        `/v1/findings?subjectKind=person&subjectId=${tenant.prefix}-PILOT-${id}&subjectScope=source&sourceId=${tenant.sourceId}`,
      );
      found.push(listed.findings.find((item) => item.ruleId === CERTIFICATE_RULE)!);
    }
    return found;
  }

  const treat = (finding: SubjectFindingRecord, treatment: Record<string, unknown>, note: string) =>
    tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'finding.treat',
      treatment: { findingId: finding.id, evaluationId: finding.latestEvaluation.id, ...treatment },
      note,
    });

  beforeAll(async () => {
    tenant = await coverageTenant('reports');
    other = await coverageTenant('reports-other');
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.actor.id)}`,
    );
    tenant.actor.capabilities = [...current.json().principal.capabilities, 'decision:write', 'sms:read', 'sms:write'];
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.actor.id,
      expectedRevision: current.json().principal.revision,
      capabilities: tenant.actor.capabilities,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    reader = await person(tenant, 'reader', 'Riley Example', ['evidence:read', 'document:read']);
    safetyOnly = await person(tenant, 'safety', 'Sam Example', ['sms:read']);

    const id = (name: string) => `${tenant.prefix}-${name}`;
    const flown = (flight: string, takeoff: number, landing: number) => ({
      subjectId: id(flight),
      secondarySubjectId: id('AC-1'),
      takeoffAt: hoursAgo(takeoff),
      landingAt: hoursAgo(landing),
      takeoffLocation: 'Ridge road pullout',
      landingLocations: 'Ridge road pullout',
      maxHeightFlownAboveGroundMeters: 90,
    });
    // Two flights flown, an hour and half an hour; a third planned with no flight record.
    await tenant.importRecords('flight.record', [flown('FLT-1', 3, 2), flown('FLT-2', 5, 4.5)]);
    await tenant.importRecords('flight.plan', [
      {
        subjectId: id('FLT-3'),
        secondarySubjectId: id('AC-1'),
        windowStartsAt: hoursAgo(1),
        windowEndsAt: hoursAgo(0.5),
        operationKind: 'inspection',
        plannedOriginDescription: 'North pad',
        plannedDestinationDescription: 'North pad',
        routeSummary: 'Fictional ridge line survey',
      },
    ]);
    await tenant.importRecords(
      'person.certificate',
      ['AVERY', 'BLAKE', 'CASEY'].map((name) => ({
        subjectId: id(`PILOT-${name}`),
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: `RP-${name}`,
        recordedStatus: 'suspended',
      })),
    );
    await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active');
    await tenant.settle();

    const [avery, blake, casey] = await certificateFindings();
    // Casey's finding is taken and closed; Avery's is taken with an action long overdue.
    for (const finding of [avery!, casey!])
      expect((await treat(finding, { action: 'acknowledge' }, 'Taken')).statusCode).toBe(201);
    expect((await treat(avery!, { action: 'plan', dueOn: '2000-01-01' }, 'Ask for the certificate')).statusCode).toBe(
      201,
    );
    expect((await treat(casey!, { action: 'close', reason: 'recorded_in_error' }, 'Wrong pilot')).statusCode).toBe(201);
    // A hazard opened from Blake's finding, not yet assessed.
    const promotion = await read<SmsFindingPromotionResponse>(
      tenant,
      tenant.actor,
      `/v1/sms/findings/${encodeURIComponent(blake!.id)}/promotion`,
    );
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
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix, other?.prefix].filter(Boolean) as string[]);
    await tenant?.close();
    await other?.close();
  });

  it('counts flights, flight time, findings by rule, actions and hazards of the period', async () => {
    const counted = await summary(tenant, tenant.actor);
    expect(counted.period).toMatchObject({ from: yesterday, until: today, timeZone: 'UTC', ended: false });
    expect(counted.flights).toEqual({
      readable: true,
      flights: 2,
      flightSeconds: 5400,
      withoutDuration: 0,
      plannedWithoutRecord: 1,
    });
    if (!counted.findings.readable) throw new Error('findings unreadable');
    const certificate = counted.findings.rules.find((rule) => rule.ruleId === CERTIFICATE_RULE);
    expect(certificate).toMatchObject({ packId: 'ledger.part107', opened: 3, closed: 1, openAtEnd: 2 });
    expect(certificate!.packTitle).toBe(getRulePackVersion('ledger.part107', 2)!.title);
    expect(counted.findings.total.opened).toBe(counted.findings.rules.reduce((sum, rule) => sum + rule.opened, 0));
    expect(counted.findingActions).toEqual({ readable: true, open: 1, overdue: 1 });
    expect(counted.assuranceActions).toEqual({ readable: true, open: 0, overdue: 0 });
    expect(counted.hazards).toEqual({ readable: true, levels: [], notAssessed: 1, total: 1 });
  });

  it('counts nothing of a period before the records', async () => {
    const before = await summary(tenant, tenant.actor, '2020-01-01', '2020-01-31');
    expect(before.period.ended).toBe(true);
    expect(before.flights).toMatchObject({ flights: 0, flightSeconds: 0, plannedWithoutRecord: 0 });
    expect(before.findings).toMatchObject({ rules: [], total: { opened: 0, closed: 0, openAtEnd: 0 } });
    expect(before.hazards).toMatchObject({ total: 0 });
  });

  it('counts findings opened and closed each month, by rule', async () => {
    const monthly = await read<FindingsByMonth>(tenant, tenant.actor, '/v1/reports/findings-by-month');
    expect(monthly.months).toHaveLength(12);
    expect(monthly.months.at(-1)).toBe(thisMonth);
    const certificate = monthly.rules.find((rule) => rule.ruleId === CERTIFICATE_RULE)!;
    expect(certificate.opened.at(-1)).toBe(3);
    expect(certificate.closed.at(-1)).toBe(1);
    expect(certificate.opened.slice(0, -1).every((count) => count === 0)).toBe(true);
    const chosen = await read<FindingsByMonth>(
      tenant,
      tenant.actor,
      `/v1/reports/findings-by-month?from=${thisMonth}&until=${thisMonth}`,
    );
    expect(chosen.months).toEqual([thisMonth]);
    for (const url of [
      `/v1/reports/findings-by-month?from=${thisMonth}`,
      '/v1/reports/findings-by-month?from=2020-01&until=2026-12',
    ])
      expect((await tenant.call(tenant.actor, 'GET', url)).statusCode, url).toBe(400);
  });

  it('names a part a person may not read as not theirs, never as zero', async () => {
    const asReader = await summary(tenant, reader);
    expect(asReader.flights).toMatchObject({ readable: true, flights: 2 });
    expect(asReader.hazards).toEqual({ readable: false, capability: 'sms:read' });
    expect(asReader.assuranceActions).toEqual({ readable: false, capability: 'sms:read' });
    const asSafety = await summary(tenant, safetyOnly);
    expect(asSafety.flights).toEqual({ readable: false, capability: 'evidence:read' });
    expect(asSafety.findings).toEqual({ readable: false, capability: 'evidence:read' });
    expect(asSafety.hazards).toMatchObject({ readable: true, total: 1 });
    expect((await tenant.call(safetyOnly, 'GET', '/v1/reports/findings-by-month')).statusCode).toBe(403);
    expect((await tenant.call(safetyOnly, 'GET', '/v1/reports/indicators')).statusCode).toBe(403);
  });

  it('never counts another organization’s records', async () => {
    const elsewhere = await summary(other, other.actor);
    expect(elsewhere.flights).toMatchObject({ flights: 0, flightSeconds: 0, plannedWithoutRecord: 0 });
    expect(elsewhere.findings).toMatchObject({ rules: [], total: { opened: 0, closed: 0, openAtEnd: 0 } });
    expect(elsewhere.findingActions).toMatchObject({ open: 0, overdue: 0 });
    const monthly = await read<FindingsByMonth>(other, other.actor, '/v1/reports/findings-by-month');
    expect(monthly.rules).toEqual([]);
  });

  it('refuses a period that is not one', async () => {
    for (const query of [
      `from=${today}&until=${yesterday}`,
      'from=2026-02-30&until=2026-03-01',
      'from=2020-01-01&until=2026-01-01',
    ])
      expect((await tenant.call(tenant.actor, 'GET', `/v1/reports/summary?${query}`)).statusCode, query).toBe(400);
  });

  it('lists indicators with recorded results, and reads one indicator’s history', async () => {
    const listed = await read<ReportIndicatorList>(tenant, tenant.actor, '/v1/reports/indicators');
    expect(listed.indicators).toEqual([]);
    const history = await read<IndicatorHistory>(
      tenant,
      reader,
      '/v1/reports/indicators/example-airspace.excursions-per-flight-hour/versions/1',
    );
    expect(history).toMatchObject({
      definition: { id: 'example-airspace.excursions-per-flight-hour', version: 1, limit: null },
      results: [],
      truncated: false,
    });
    expect(history.definition.title).toBeTruthy();
    const unknown = await tenant.call(tenant.actor, 'GET', '/v1/reports/indicators/test.unknown/versions/1');
    expect(unknown.statusCode).toBe(404);
  });
});
