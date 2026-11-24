import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  OpenFinding,
  OpenFindingGroupsResponse,
  OpenFindingsResponse,
  SubjectFindingListResponse,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const CERTIFICATE_RULE = 'ledger.part107.107.12.b';
const FLIGHTS = 60;
const DAY = 86_400_000;

describe('open findings by rule, and one decision for many', () => {
  let tenant: CoverageTenant;
  let service: AuthContext;
  let colleague: AuthContext;
  let now: number;
  let aircraft: string;

  async function principal(id: string, name: string, kind: string, capabilities: string[]): Promise<AuthContext> {
    const added: AuthContext = {
      id: `${tenant.tenantId}:${id}`,
      tenantId: tenant.tenantId,
      name,
      kind,
      capabilities,
      revision: 1,
    };
    await tenant.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      added.id,
      tenant.tenantId,
      name,
      kind,
      capabilities,
    ]);
    await tenant.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${added.id}`),
      added.id,
    ]);
    return added;
  }

  const flight = (index: number) => `${tenant.prefix}-FLT-${String(index).padStart(3, '0')}`;
  const plan = (index: number, daysAgo: number) => ({
    subjectId: flight(index),
    secondarySubjectId: aircraft,
    windowStartsAt: new Date(now - daysAgo * DAY).toISOString(),
    windowEndsAt: new Date(now - daysAgo * DAY + 3_600_000).toISOString(),
    operationKind: 'inspection',
    plannedOriginDescription: 'North substation pad',
    plannedDestinationDescription: 'North substation pad',
    routeSummary: 'Transmission line segment 14',
  });

  async function groups(query = ''): Promise<OpenFindingGroupsResponse> {
    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/open-findings/groups${query}`);
    expect(read.statusCode, read.body).toBe(200);
    return read.json() as OpenFindingGroupsResponse;
  }

  async function everyFinding(query: string): Promise<OpenFinding[]> {
    const found: OpenFinding[] = [];
    let cursor = '';
    do {
      const read = await tenant.call(
        tenant.actor,
        'GET',
        `/v1/organization/open-findings?limit=200&${query}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(read.statusCode, read.body).toBe(200);
      const page = read.json() as OpenFindingsResponse;
      found.push(...page.findings);
      cursor = page.page.nextCursor ?? '';
    } while (cursor);
    return found;
  }

  function decide(by: AuthContext, shown: OpenFinding[], fields: Record<string, unknown>) {
    const first = shown[0]!;
    return tenant.call(by, 'POST', '/v1/commands', {
      kind: 'finding.treat-many',
      selection: { packId: first.packId, ruleId: first.ruleId, ...((fields.selection as object) ?? {}) },
      findings: shown.map((item) => ({ findingId: item.id, evaluationId: item.evaluationId })),
      shownCount: shown.length,
      ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'selection')),
    });
  }

  beforeAll(async () => {
    tenant = await coverageTenant('finding-sets');
    now = Date.parse(await databaseNow(tenant.admin));
    aircraft = `${tenant.prefix}-RIDGE-AC-1`;
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.actor.id)}`,
    );
    expect(current.statusCode, current.body).toBe(200);
    tenant.actor.capabilities = [...current.json().principal.capabilities, 'decision:write'];
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.actor.id,
      expectedRevision: current.json().principal.revision,
      capabilities: tenant.actor.capabilities,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    service = await principal('agent', 'Records agent', 'service', ['evidence:read', 'flight:read', 'decision:write']);
    colleague = await principal('colleague', 'Avery Example', 'human', [
      'evidence:read',
      'flight:read',
      'decision:write',
    ]);
    // Three rare findings: three pilots whose certificate on file is suspended.
    await tenant.importRecords(
      'person.certificate',
      ['A', 'B', 'C'].map((letter) => ({
        subjectId: `${tenant.prefix}-PILOT-${letter}`,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: `RP-0000${letter}`,
        recordedStatus: 'suspended',
      })),
    );
    // Sixty flights flown on sixty days, the latest three weeks ago.
    await tenant.importRecords(
      'flight.plan',
      Array.from({ length: FLIGHTS }, (_, index) => plan(index + 1, 80 - index)),
    );
    // In effect over the flights' days, as an operator adopting over its history adopts.
    await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active', {
      effectiveInterval: { start: new Date(now - 120 * DAY).toISOString(), end: new Date(now + DAY).toISOString() },
    });
    await tenant.settle();
  }, 600_000);
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  let repeated: OpenFindingGroupsResponse['groups'][number];

  it('groups the open findings by rule, the rules with the fewest first, with the counts a reader needs', async () => {
    const read = await groups();
    const opens = read.groups.map((group) => group.open);
    expect(opens).toEqual([...opens].sort((a, b) => a - b));
    expect(read.total).toEqual({ findings: opens.reduce((sum, open) => sum + open, 0), rules: read.groups.length });
    expect(read.total.findings).toBe(read.counts.counted);
    const rare = read.groups.find((group) => group.ruleId === CERTIFICATE_RULE)!;
    expect(rare).toMatchObject({ packId: 'ledger.part107', open: 3, subjects: 3, owned: 0 });
    const found = read.groups.find((group) => group.open === FLIGHTS && group.subjects === FLIGHTS);
    expect(found, JSON.stringify(read.groups.map(({ ruleId, open }) => [ruleId, open]))).toBeDefined();
    repeated = found!;
    expect(read.groups.indexOf(rare)).toBeLessThan(read.groups.indexOf(repeated));
    // A flight's finding is about its window: the earliest and latest flight.
    expect(repeated.aboutFrom).toBe(plan(1, 80).windowStartsAt);
    expect(repeated.aboutUntil).toBe(plan(FLIGHTS, 80 - (FLIGHTS - 1)).windowStartsAt);

    const most = await groups('?order=most');
    expect(most.groups.map((group) => group.open)).toEqual([...opens].sort((a, b) => b - a));
    const people = await groups('?subjectKind=person');
    expect(people.groups.every((group) => group.ruleId !== repeated.ruleId)).toBe(true);
  });

  it('lists one rule’s findings, each with the evaluation a decision pins and the day it is about', async () => {
    const listed = await everyFinding(`ruleId=${encodeURIComponent(repeated.ruleId)}`);
    expect(listed).toHaveLength(FLIGHTS);
    expect(new Set(listed.map((item) => item.subject.id)).size).toBe(FLIGHTS);
    expect(listed.every((item) => item.ruleId === repeated.ruleId && item.evaluationId)).toBe(true);
    const until = new Date(now - 40 * DAY).toISOString().slice(0, 10);
    const narrowed = await everyFinding(`ruleId=${encodeURIComponent(repeated.ruleId)}&aboutUntil=${until}`);
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThan(FLIGHTS);
    expect(narrowed.every((item) => item.aboutAt < `${until}T24`)).toBe(true);
  });

  it('refuses a decision about many findings from a service, as it refuses one', async () => {
    const shown = await everyFinding(`ruleId=${encodeURIComponent(repeated.ruleId)}`);
    const refused = await decide(service, shown, { action: 'acknowledge', note: 'Taken by the agent' });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('person_required');
  });

  it('takes sixty findings and closes them in one decision each, refusing a set that changed after it was shown', async () => {
    let shown = await everyFinding(`ruleId=${encodeURIComponent(repeated.ruleId)}`);
    const notOwned = await decide(tenant.actor, shown, {
      action: 'close',
      reason: 'accepted',
      note: 'Our log did not record this item before November.',
    });
    expect(notOwned.statusCode, notOwned.body).toBe(409);
    expect(notOwned.json().error.code).toBe('finding_owner_required');
    const taken = await decide(tenant.actor, shown, { action: 'acknowledge', note: 'I will review the old log.' });
    expect(taken.statusCode, taken.body).toBe(201);
    expect((await groups()).groups.find((group) => group.ruleId === repeated.ruleId)).toMatchObject({
      open: FLIGHTS,
      owned: FLIGHTS,
    });

    // Shown sixty; a sixty-first flight is recorded and evaluated before the person commits.
    shown = await everyFinding(`ruleId=${encodeURIComponent(repeated.ruleId)}`);
    expect(shown).toHaveLength(FLIGHTS);
    await tenant.importRecords('flight.plan', [plan(FLIGHTS + 1, 2)]);
    await tenant.settle();
    const close = { action: 'close', reason: 'accepted', note: 'Our log did not record this item before November.' };
    const stale = await decide(tenant.actor, shown, close);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('stale_finding_set');
    expect(stale.json().error.message).toContain('60 were shown, 61 match now');

    // The sixty-first is about a later day: the same sixty, narrowed by the days they are about, close as one.
    const until = new Date(now - 5 * DAY).toISOString().slice(0, 10);
    const closed = await decide(tenant.actor, shown, { ...close, selection: { aboutUntil: until } });
    expect(closed.statusCode, closed.body).toBe(201);
    const decisionId = closed.json().command.id as string;
    const recorded = await tenant.admin.query('SELECT kind,payload FROM command_records WHERE tenant_id=$1 AND id=$2', [
      tenant.tenantId,
      decisionId,
    ]);
    expect(recorded.rows[0].kind).toBe('finding.treat-many');
    expect(recorded.rows[0].payload.shownCount).toBe(FLIGHTS);
    expect(recorded.rows[0].payload.findings.map((item: { findingId: string }) => item.findingId).sort()).toEqual(
      shown.map((item) => item.id).sort(),
    );
    const treatments = await tenant.admin.query(
      'SELECT count(*)::int AS count FROM finding_treatments WHERE tenant_id=$1 AND decision_id=$2',
      [tenant.tenantId, decisionId],
    );
    expect(treatments.rows[0].count).toBe(FLIGHTS);
    const events = await tenant.admin.query(
      "SELECT count(*)::int AS count FROM journal_events WHERE tenant_id=$1 AND event_type='finding.treat-many'",
      [tenant.tenantId],
    );
    expect(events.rows[0].count).toBe(2);

    // Each finding shows the decision, with the reason and the note.
    const one = shown[0]!;
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/findings?subjectKind=flight&subjectId=${encodeURIComponent(one.subject.id)}&subjectScope=source&sourceId=${tenant.sourceId}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const finding = (read.json() as SubjectFindingListResponse).findings.find((item) => item.id === one.id)!;
    expect(finding.status).toBe('resolved');
    expect(finding.closure).toMatchObject({ by: 'person', reason: 'accepted', note: close.note });
    expect(finding.treatments.map((item) => item.action)).toEqual(['acknowledge', 'close']);
    expect(finding.treatments[1]!.decision).toEqual({ id: decisionId, findingCount: FLIGHTS });

    // Nothing is suppressed: the later flight's finding stays open, and only its owner closes it.
    const left = await everyFinding(`ruleId=${encodeURIComponent(repeated.ruleId)}`);
    expect(left.map((item) => item.subject.id)).toEqual([flight(FLIGHTS + 1)]);
    const byColleague = await decide(colleague, left, close);
    expect(byColleague.json().error.code).toBe('finding_owner_required');
  });
});
