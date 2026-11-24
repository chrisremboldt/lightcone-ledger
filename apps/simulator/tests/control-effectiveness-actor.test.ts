import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerClient } from '@ledger/contracts/client';
import type {
  ControlIndicatorResultRecord,
  ControlIndicatorReviewRecord,
  ControlWindow,
  ControlWindowOpen,
  IndicatorResult,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import { runControlEffectiveness } from '../src/control-effectiveness-actor.js';
import { runControlEffectivenessCli } from '../src/control-effectiveness-cli.js';
import { readControlEffectivenessJournal, type ControlEffectivenessPlan } from '../src/control-effectiveness-plan.js';
import { runControlEffectivenessReview } from '../src/control-effectiveness-review-actor.js';
import type { ControlEffectivenessReviewPlan } from '../src/control-effectiveness-review-plan.js';

// A fictional organization's accepted control, its window and one recorded indicator result, served by a fake API.

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function journalPath(name: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-indicator-actor-'));
  directories.push(directory);
  return join(directory, name);
}

const apiUrl = 'http://indicator-actor.test';
const tenantId = 'tenant-fictional';
const principalId = 'principal-fictional-safety';
const indicator = { id: 'made-up.losses-per-flight-hour', version: 1, digest: 'a'.repeat(64) };
const opening: ControlWindowOpen = {
  control: {
    kind: 'control_record',
    hazardId: 'hazard-fictional',
    recordId: 'control-fictional',
    versionNumber: 1,
    bodyDigest: 'c'.repeat(64),
    acceptanceId: 'acceptance-fictional',
  },
  period: { start: '2026-10-15T14:15:00.000Z', end: '2026-10-15T14:20:00.000Z' },
  subjectKind: 'flight',
  subjects: [{ scope: 'ledger', kind: 'flight', id: 'flight-fictional' }],
  complete: true,
  expectedObservations: [
    { type: 'flight.report', versions: [1] },
    { type: 'link.status', versions: [1] },
  ],
  indicators: [indicator],
  note: 'The rehearsal flight.',
};
const plan: ControlEffectivenessPlan = { version: 2, apiUrl, tenantId, principalId, window: opening, indicator };
const window: ControlWindow = {
  id: 'window-fictional',
  variant: 'generic',
  organizationId: `organization:${tenantId}`,
  control: opening.control,
  period: opening.period,
  population: {
    subjectKind: 'flight',
    subjects: opening.subjects,
    complete: true,
    declaredBy: { kind: 'person', id: principalId },
  },
  expectedObservations: opening.expectedObservations,
  indicators: [indicator],
  openedAt: '2026-10-15T14:21:00.000Z',
  revision: {
    number: 1,
    id: 'revision-fictional',
    recordedAt: '2026-10-15T14:21:00.000Z',
    digest: 'b'.repeat(64),
    note: 'The rehearsal flight.',
  },
};
const result: IndicatorResult = {
  version: 'ledger.indicator-result.1',
  definition: indicator,
  exposureKind: { id: 'exposure.covered-flight-hours', version: 1, digest: 'c'.repeat(64) },
  control: { id: 'control-fictional', version: 1 },
  window: opening.period,
  recordedThrough: '2026-10-15T14:21:00.000Z',
  status: 'supported',
  eventCount: 1,
  exposure: {
    value: { numerator: '1', denominator: '12' },
    decimal: '0.083333',
    unit: 'flight_hour',
    coverage: 'checked',
    gaps: [],
    conflicts: [],
  },
  rate: { value: { numerator: '12', denominator: '1' }, decimal: '12.000000', per: 1, label: 'per flight hour' },
  reasons: [],
  eventsPlacedBy: ['issue'],
  population: {
    subjectCount: 1,
    digest: 'd'.repeat(64),
    complete: true,
    declaredBy: { kind: 'person', id: principalId },
  },
  counted: { events: ['issue:fictional'], exposure: ['flight-report-fictional'] },
  inputDigest: 'e'.repeat(64),
};
const record: ControlIndicatorResultRecord = {
  format: 'ledger.control-indicator-result.1',
  id: 'result-fictional',
  organizationId: window.organizationId,
  windowId: window.id,
  windowRevision: 1,
  windowRevisionDigest: window.revision.digest,
  control: opening.control,
  request: {
    definition: { id: indicator.id, version: indicator.version },
    window: opening.period,
    recordedThrough: window.revision.recordedAt,
    population: { subjects: opening.subjects, complete: true, declaredBy: { kind: 'person', id: principalId } },
  },
  selection: 'complete',
  result,
  actorId: principalId,
  recordedAt: '2026-10-15T14:22:00.000Z',
};
const recorded = { record, digest: canonicalDigest(record) };
const currentness = {
  status: 'current' as const,
  checkedAt: '2026-10-15T14:23:00.000Z',
  inputDigest: result.inputDigest,
};
const principal = {
  id: principalId,
  tenantId,
  name: 'Fictional safety lead',
  kind: 'human',
  active: true,
  revision: 3,
  capabilities: ['monitoring:write', 'decision:write', 'evidence:read', 'flight:read'],
  commandLinkSources: [],
  missionSources: [],
  monitoringSources: [],
};

interface Server {
  calls: string[];
  posts: { path: string; body: string; key: string }[];
  lose: Set<string>;
  refuse?: string;
}
function fakeApi(server: Server, review?: { record: ControlIndicatorReviewRecord; digest: string }): typeof fetch {
  return async (url, init) => {
    const request = new URL(String(url));
    const method = init?.method ?? 'GET';
    server.calls.push(`${method} ${request.pathname}`);
    if (request.pathname === '/openapi.json') return Response.json(openApiDocument);
    if (request.pathname === '/v1/me') return Response.json({ principal });
    if (method === 'POST') {
      const key = new Headers(init?.headers).get('idempotency-key')!;
      server.posts.push({ path: request.pathname, body: init!.body as string, key });
      if (server.refuse === request.pathname)
        return Response.json({ error: { code: 'stale_basis', message: 'Refused' } }, { status: 409 });
      if (server.lose.delete(request.pathname)) throw new Error('Response lost after the request was accepted');
      if (request.pathname === '/v1/control-windows') return Response.json({ window }, { status: 201 });
      if (request.pathname === `/v1/control-windows/${window.id}/indicator-results`)
        return Response.json({ ...recorded, currentness }, { status: 201 });
      if (request.pathname === '/v1/control-indicator-reviews') return Response.json(review, { status: 201 });
    }
    if (request.pathname === `/v1/control-indicator-results/${record.id}`)
      return Response.json({ ...recorded, currentness });
    if (review && request.pathname === `/v1/control-indicator-reviews/${review.record.id}`)
      return Response.json(review);
    return Response.json({ error: { code: 'not_found', message: 'Not served' } }, { status: 404 });
  };
}

describe('the simulator records a control’s indicator result through a window', () => {
  it('opens the window, records the result, and replays a lost request with the same bytes and key', async () => {
    const statePath = await journalPath('calculation.journal.json');
    const server: Server = {
      calls: [],
      posts: [],
      lose: new Set([`/v1/control-windows/${window.id}/indicator-results`]),
    };
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(server));
    const first = await runControlEffectiveness(plan, statePath, ledger);
    expect(first).toMatchObject({ status: 'pending', code: 'result_unavailable', attempts: 2 });
    const journal = (await readControlEffectivenessJournal(statePath, plan))!;
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(journal).toMatchObject({ version: 2, planDigest: canonicalDigest(plan), tenantId, principalId });
    expect(journal.actions.map((entry) => [entry.step, entry.status])).toEqual([
      ['window', 'accepted'],
      ['result', 'submitted'],
    ]);
    expect(journal.actions[1]!.payloadSha256).toBe(sha256(journal.actions[1]!.payload));
    expect(JSON.parse(journal.actions[1]!.payload)).toEqual({
      definition: indicator,
      expectedRevision: { number: 1, digest: window.revision.digest },
    });

    const second = await runControlEffectiveness(plan, statePath, ledger);
    expect(second).toMatchObject({
      status: 'accepted',
      code: 'result_confirmed',
      windowId: window.id,
      resultId: record.id,
      resultDigest: recorded.digest,
      resultStatus: 'supported',
      record: 'confirmed',
      currentness,
    });
    const recordings = server.posts.filter((post) => post.path.endsWith('/indicator-results'));
    expect(recordings).toHaveLength(2);
    expect(recordings[1]).toEqual(recordings[0]);
    expect(server.posts.filter((post) => post.path === '/v1/control-windows')).toHaveLength(1);
    // Done: a third run only reads.
    const posts = server.posts.length;
    expect((await runControlEffectiveness(plan, statePath, ledger)).status).toBe('accepted');
    expect(server.posts).toHaveLength(posts);
  });

  it('keeps a definitive refusal and never sends a replacement', async () => {
    const statePath = await journalPath('calculation.journal.json');
    const server: Server = {
      calls: [],
      posts: [],
      lose: new Set(),
      refuse: `/v1/control-windows/${window.id}/indicator-results`,
    };
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(server));
    expect(await runControlEffectiveness(plan, statePath, ledger)).toMatchObject({
      status: 'rejected',
      code: 'stale_basis',
    });
    expect(await runControlEffectiveness(plan, statePath, ledger)).toMatchObject({
      status: 'rejected',
      code: 'stale_basis',
    });
    expect(server.posts).toHaveLength(2);
  });

  it('refuses a plan whose window does not cite the indicator, and requests outside its scope', async () => {
    const statePath = await journalPath('calculation.journal.json');
    const server: Server = { calls: [], posts: [], lose: new Set() };
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(server));
    const other = { ...plan, window: { ...opening, indicators: [{ ...indicator, version: 2 }] } };
    expect(await runControlEffectiveness(other, statePath, ledger)).toMatchObject({
      status: 'pending',
      code: 'invalid_plan',
    });
    expect(server.calls).toEqual([]);
    const cli = await runControlEffectivenessCli(
      {
        SIMULATOR_EFFECTIVENESS_PLAN: '/nonexistent/plan.json',
        SIMULATOR_EFFECTIVENESS_STATE: statePath,
        SIMULATOR_EFFECTIVENESS_TOKEN: 't',
      },
      fakeApi(server),
    );
    expect(cli.status).toBe('pending');
  });
});

describe('the simulator reviews a recorded indicator result', () => {
  it('records the planned review once and confirms it with an exact read', async () => {
    const statePath = await journalPath('review.journal.json');
    const reviewPlan: ControlEffectivenessReviewPlan = {
      version: 2,
      apiUrl,
      tenantId,
      principalId,
      result: { id: record.id, digest: recorded.digest },
      conclusion: 'effective',
      note: 'Reviewed with the chief pilot.',
    };
    const reviewRecord: ControlIndicatorReviewRecord = {
      format: 'ledger.control-indicator-review.1',
      id: 'review-fictional',
      organizationId: window.organizationId,
      control: opening.control,
      result: reviewPlan.result,
      resultStatus: 'supported',
      conclusion: 'effective',
      note: reviewPlan.note,
      actor: {
        id: principalId,
        name: principal.name,
        kind: 'human',
        principalRevision: 3,
        capabilities: principal.capabilities,
        checkedCapabilities: ['decision:write', 'flight:read'],
        policyVersion: 'ledger.control-effectiveness-review-authority.2',
      },
      recordedAt: '2026-10-15T14:24:00.000Z',
    };
    const review = { record: reviewRecord, digest: canonicalDigest(reviewRecord) };
    const server: Server = { calls: [], posts: [], lose: new Set(['/v1/control-indicator-reviews']) };
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(server, review));
    expect(await runControlEffectivenessReview(reviewPlan, statePath, ledger)).toMatchObject({
      status: 'pending',
      code: 'submission_unavailable',
    });
    expect(await runControlEffectivenessReview(reviewPlan, statePath, ledger)).toMatchObject({
      status: 'accepted',
      code: 'review_confirmed',
      reviewId: reviewRecord.id,
      reviewDigest: review.digest,
      record: 'confirmed',
    });
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1]).toEqual(server.posts[0]);
    expect(JSON.parse(server.posts[0]!.body)).toEqual({
      result: reviewPlan.result,
      conclusion: 'effective',
      note: reviewPlan.note,
    });
    // A changed conclusion is another plan, which the retained journal refuses.
    expect(
      await runControlEffectivenessReview({ ...reviewPlan, conclusion: 'inconclusive' }, statePath, ledger),
    ).toMatchObject({ status: 'pending', code: 'journal_mismatch' });
  });
});
