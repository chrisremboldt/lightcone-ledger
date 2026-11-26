import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, OPEN_TO_READERS } from '../../apps/api/src/index.js';
import { PROGRAM_VIEW_PATHS } from '../../apps/api/src/program-view-routes.js';
import { SHARED_RECORDS_PATHS } from '../../apps/api/src/record-productions.js';
import { UNAUTHENTICATED_REPORT_PATHS } from '../../apps/api/src/safety-report-submission.js';
import { rolePresets } from '../../packages/contracts/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { caller, dispatcher } from './reader-fixtures.js';
import { settleOwnedWork } from './worker-queue.js';

/**
 * A reader, added from the Reader preset, walks every route the API registers, read from its own route table: every
 * route that changes something is refused, every read outside a reader's grants is refused, and the reads a reader is
 * for succeed. A route added later is refused to a reader until this file says otherwise.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('A reader looks and changes nothing', () => {
  const pool = createPool();
  const store = new MemoryObjectStore();
  const run = randomUUID().slice(0, 8);
  const routes: { method: string; url: string }[] = [];
  let app: Awaited<ReturnType<typeof createApp>>;
  const { call, read, importRecords, produce, addReader } = caller(() => app);
  const operator = dispatcher('alpha');
  let reader: string;
  /** Real ids for the reads a reader is for. */
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      onRoute: (route) => {
        for (const method of [route.method].flat()) routes.push({ method, url: route.url });
      },
    });
    await app.ready();
    await importRecords(operator, 'aircraft.identity', run);
    ids.aircraft = `${run}-RIDGE-AC-1`;
    ids.production = (await produce(operator, ids.aircraft)).id;
    const coverage = await read(operator, '/v1/organization/coverage');
    ids.adoption = coverage.adoptions[0].id;
    ids.matrix = (await read(operator, '/v1/sms/records?kind=risk_matrix')).records[0].id;
    // A safety report, so a reader can be refused one that exists.
    const reported = await call(operator, 'POST', '/v1/safety-reports', {
      whatWasSeen: 'A fictional near miss near the north ridge',
      named: false,
    });
    expect(reported.statusCode, reported.body).toBe(201);
    ids.report = (await read(operator, '/v1/sms/records?kind=report')).records[0].id;
    reader = (await addReader(operator, `Riley Example ${run}`)).token;
  });
  afterAll(async () => {
    await settleOwnedWork(['tenant-alpha'], { objectStore: store });
    await app?.close();
    await pool.end();
  });

  /** A route as a request: its parameters filled with the ids above where a read needs one, else a made-up id. */
  const fill = (url: string, values: Record<string, string> = {}) =>
    url.replace(/:(\w+)/g, (_whole, name: string) =>
      encodeURIComponent(values[name] ?? (['version', 'revision'].includes(name) ? '1' : `unknown-${name}`)),
    ) + (requiredQuery[url] ?? '');
  /** The query a route refuses to be asked without, so that what answers is the route itself. */
  const requiredQuery: Record<string, string> = {
    '/v1/hazards/:id/avoidance-demos': '?controlEventId=unknown&acceptanceId=unknown',
    '/v1/sms/records/:id/signing': '?meaning=document.adopt',
  };

  /**
   * The routes that take no sign-in at all: the safety report submissions, the page of a link, and the read a program
   * grant's secret opens, which answers counts only (docs/design/program-owner-view.md).
   */
  const unsigned = new Set(['/healthz', '/readyz', '/openapi.json', '/v1/sign-in']);
  const unsignedWrites = new Set([...UNAUTHENTICATED_REPORT_PATHS, ...SHARED_RECORDS_PATHS, ...PROGRAM_VIEW_PATHS]);

  /** What a reader is for (decision 1 of the reader preset), each with the request that reads it. */
  const readerReads: Record<string, string> = {
    '/v1/me': '/v1/me',
    '/v1/sms/program': '/v1/sms/program',
    '/v1/operator-records/types': '/v1/operator-records/types',
    '/v1/operator-records': '/v1/operator-records?recordType=aircraft.identity',
    '/v1/operator-records/subjects': '/v1/operator-records/subjects?kind=aircraft',
    '/v1/operator-records/subjects/:kind/:id': 'aircraft-file',
    '/v1/organization/subjects': '/v1/organization/subjects?kind=aircraft',
    '/v1/organization/flights-on-record': '/v1/organization/flights-on-record',
    '/v1/organization/required-records': '/v1/organization/required-records',
    '/v1/rule-packs': '/v1/rule-packs',
    '/v1/organization/coverage': '/v1/organization/coverage',
    '/v1/organization/coverage/adoptions/:adoptionId': 'adoption-coverage',
    '/v1/organization/open-findings': '/v1/organization/open-findings',
    '/v1/organization/open-findings/groups': '/v1/organization/open-findings/groups',
    '/v1/findings': '/v1/findings?subjectKind=aircraft&subjectId=unknown',
    '/v1/sms/home': '/v1/sms/home',
    '/v1/sms/records': '/v1/sms/records?kind=document',
    '/v1/sms/records/:id': 'matrix',
    '/v1/record-productions': '/v1/record-productions',
    '/v1/record-productions/:id': 'production',
    '/v1/record-productions/:id/content': 'production-content',
    '/v1/record-productions/:id/links': 'production-links',
    // The reports count records and findings a reader may read; a part they may not, such as hazards, is named as
    // not theirs to read (see reports.integration.test.ts).
    '/v1/reports/summary': '/v1/reports/summary?from=2026-01-01&until=2026-01-31',
    '/v1/reports/findings-by-month': '/v1/reports/findings-by-month',
    '/v1/reports/indicators': '/v1/reports/indicators',
    '/v1/reports/indicators/:indicatorId/versions/:version': 'indicator-history',
    // The operators the organization follows, under Reports: the counts their own Ledgers answered. Following and
    // removing one needs authority:write, which a reader does not hold.
    '/v1/program-operators': '/v1/program-operators',
  };
  const requestFor = (key: string, value: string) =>
    ({
      'aircraft-file': `/v1/operator-records/subjects/aircraft/${encodeURIComponent(ids.aircraft!)}`,
      'adoption-coverage': fill(key, { adoptionId: ids.adoption! }),
      matrix: fill(key, { id: ids.matrix! }),
      production: fill(key, { id: ids.production! }),
      'production-content': fill(key, { id: ids.production! }),
      'production-links': fill(key, { id: ids.production! }),
      'indicator-history': fill(key, { indicatorId: 'example-airspace.excursions-per-flight-hour', version: '1' }),
    })[value] ?? value;

  /**
   * Reads a reader's grants open besides those: evidence a reader may follow from a record, a finding or a produced
   * file. Each is asked with a made-up id here, so it answers that nothing was found, not that it is refused.
   */
  const alsoOpen = new Set([
    // A person's own choice of which notices reach them: about no record, and theirs alone.
    '/v1/notices/settings',
    '/v1/operator-records/types/:recordType/versions/:version/template',
    '/v1/organization/recordkeeping-plan/draft',
    '/v1/organization/coverage/adoptions/:adoptionId/rules/:leafId/subjects',
    '/v1/rule-packs/:packId/versions/:version',
    '/v1/rule-sources/:sourceId/content',
    '/v1/observations',
    '/v1/evaluations',
    '/v1/evaluations/:id',
    '/v1/uploads/:id',
    '/v1/artifacts/:id',
    '/v1/artifacts/:id/content',
    '/v1/exports',
    '/v1/exports/:id',
    '/v1/exports/:id/content',
    '/v1/subject-exports',
    '/v1/subject-exports/:id',
    '/v1/subject-exports/:id/content',
    '/v1/finding-packets',
    '/v1/finding-packets/:id',
    '/v1/finding-packets/:id/content',
    '/v1/decision-packets',
    '/v1/decision-packets/:id',
    '/v1/decision-packets/:id/content',
    '/v1/control-windows',
    '/v1/control-windows/:windowId',
    '/v1/control-windows/:windowId/indicators/:indicatorId/versions/:version',
    '/v1/control-windows/:windowId/indicator-results',
    '/v1/control-indicator-results/:resultId',
    '/v1/control-indicator-reviews/:reviewId',
    '/v1/hazards/:id/monitoring-windows',
    '/v1/sms/exports/:id',
    '/v1/sms/exports/:id/packet',
    '/v1/sms/exports/:id/content',
    '/v1/sms/attachments/:id/content',
    // Every read of one operator the organization follows, beside the view a reader opens.
    '/v1/program-operators/:id/answers',
  ]);

  const gets = () => routes.filter((route) => route.method === 'GET' && !unsigned.has(route.url));

  it('is a preset of reads alone', () => {
    const preset = rolePresets.find((entry) => entry.key === 'reader')!;
    expect(preset).toMatchObject({ title: 'Reader', capabilities: ['evidence:read', 'document:read'] });
    expect(routes.length).toBeGreaterThan(100);
  });

  it('is refused every route that changes something, before its body is read', async () => {
    const writes = routes.filter((route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
    expect(writes.length).toBeGreaterThan(30);
    const reached: string[] = [];
    for (const route of writes) {
      if (unsignedWrites.has(route.url) || OPEN_TO_READERS.has(`${route.method} ${route.url}`)) continue;
      const response = await call(reader, route.method, fill(route.url), {});
      if (response.statusCode !== 403 || response.json().error?.code !== 'reads_only')
        reached.push(`${route.method} ${route.url}: ${response.statusCode} ${response.body.slice(0, 120)}`);
    }
    expect(reached).toEqual([]);
    // Only these take no sign-in, and none of them reaches an organization's records but the one set a link opens and
    // the counts a grant shows.
    expect(
      writes
        .filter((route) => unsignedWrites.has(route.url))
        .map((route) => route.url)
        .sort(),
    ).toEqual([...unsignedWrites].sort());
  });

  it('may send only what is open to everyone who signs in, and what its own grants refuse', async () => {
    // These four are the whole list; a route added to it is a decision this test makes someone see.
    expect([...OPEN_TO_READERS].sort()).toEqual([
      'POST /v1/commands',
      'POST /v1/flights/:id/mission/route-suggestion',
      'POST /v1/safety-reports',
      'PUT /v1/notices/settings',
    ]);
    // A command is refused unless it acknowledges something issued to the reader, before anything else is read of it.
    for (const kind of ['person.add', 'decision.record', 'rule-pack.adopt', 'sms.record.open', 'credential.issue']) {
      const response = await call(reader, 'POST', '/v1/commands', { kind });
      expect(response.json().error?.code, `${kind}: ${response.body}`).toBe('reads_only');
    }
    const acknowledgement = await call(reader, 'POST', '/v1/commands', { kind: 'sms.document.acknowledge' });
    expect(acknowledgement.json().error?.code).not.toBe('reads_only');
    // The read sent as a POST needs flight:read, which a reader does not hold.
    for (const url of [fill('/v1/flights/:id/mission/route-suggestion')]) {
      const response = await call(reader, 'POST', url, {});
      expect(response.statusCode, `${url}: ${response.body}`).not.toBe(200);
      expect(response.statusCode).not.toBe(201);
    }
    // Reporting a safety concern is taken from anyone, signed in or through a link: a reader too. It reads nothing back.
    const reported = await call(reader, 'POST', '/v1/safety-reports', {
      whatWasSeen: 'A fictional loose guard seen during the inspection',
      named: false,
    });
    expect(reported.statusCode, reported.body).toBe(201);
    expect((await call(reader, 'GET', '/v1/sms/records?kind=report')).statusCode).toBe(403);
  });

  it('reads records, a subject’s file, the rules and their coverage, findings, documents and produced records', async () => {
    const listed = gets().filter((route) => route.url in readerReads);
    expect(listed.map((route) => route.url).sort()).toEqual(Object.keys(readerReads).sort());
    for (const route of listed) {
      const url = requestFor(route.url, readerReads[route.url]!);
      const response = await call(reader, 'GET', url);
      expect(response.statusCode, `${url}: ${response.body.slice(0, 300)}`).toBe(200);
    }
    const file = await read(reader, `/v1/operator-records/subjects/aircraft/${encodeURIComponent(ids.aircraft!)}`);
    expect(JSON.stringify(file)).toContain(ids.aircraft);
    const summary = await read(reader, '/v1/reports/summary?from=2026-01-01&until=2026-01-31');
    expect(summary.hazards).toEqual({ readable: false, capability: 'sms:read' });
    const home = await read(reader, '/v1/sms/home');
    expect(home).toMatchObject({ people: [], reportLinks: [], attention: { waitingOnMe: [], overdue: [] } });
  });

  it('is refused every other read, and the safety reports above all', async () => {
    const opened: string[] = [];
    for (const route of gets()) {
      if (route.url in readerReads) continue;
      const response = await call(reader, 'GET', fill(route.url));
      const refused = response.statusCode === 403;
      if (alsoOpen.has(route.url) ? refused : !refused)
        opened.push(`${route.url}: ${response.statusCode} ${response.body.slice(0, 160)}`);
    }
    expect(opened).toEqual([]);
    for (const kind of ['report', 'hazard', 'assurance', 'control']) {
      const register = await call(reader, 'GET', `/v1/sms/records?kind=${kind}`);
      expect(register.statusCode, `${kind}: ${register.body}`).toBe(403);
    }
    for (const url of [`/v1/sms/records/${ids.report}`, `/v1/sms/records/${ids.report}/content`]) {
      const response = await call(reader, 'GET', url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
      expect(response.body).not.toContain('north ridge');
    }
  });
});
