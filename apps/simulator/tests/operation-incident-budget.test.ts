import { describe, expect, it } from 'vitest';
import type { EvaluationRecord, FindingRecord, FlightSummary } from '@ledger/contracts';
import type {
  OperationTenant,
  OrdinaryIncidentKind,
  OrdinaryIncidentReservation,
} from '../../../packages/simulation-models/src/operation.js';
import { readOrdinaryIncidentBudget } from '../src/operation-incident-budget.js';

const at = '2026-10-17T14:00:00.000Z';
const now = () => Date.parse(at);
const config = {
  apiUrl: 'http://ledger.test',
  tokens: {
    alpha: { source: 'alpha-source', actor: 'unused-alpha-actor' },
    beta: { source: 'beta-source', actor: 'unused-beta-actor' },
  },
};
type View = 'monitor' | 'overdue' | 'historical-issues';
interface PublicFlight {
  flight: FlightSummary;
  findings: FindingRecord[];
  views: View[];
}

function reservation(tenant: OperationTenant, kind: OrdinaryIncidentKind, index = 0): OrdinaryIncidentReservation {
  const attemptId = `intent-budget-run-${tenant}-${index}:attempt:1`;
  return {
    attemptId,
    tenant,
    kind,
    aircraftId: `DJI-budget-${tenant}-${index}`,
    sourceSessionId: `${attemptId}${kind === 'command-link' ? '-command-link-1' : '-buffered-person'}`,
    incidentId: `${attemptId}:${kind === 'command-link' ? 'radio-interruption:1' : 'landing-disagreement'}`,
    evidenceReceiptId: `receipt-${tenant}-${index}`,
  };
}

function evaluation(incident: OrdinaryIncidentReservation, flightId: string): EvaluationRecord {
  const evidence = {
    eventId: 'original-event',
    receiptId: incident.evidenceReceiptId!,
    sourceId: incident.kind === 'command-link' ? 'command-link' : `simulation-person-${incident.tenant}-buffered`,
    occurredAt: at,
  };
  // Both kinds come from the generic evaluator; the check kind, not the rule, names the incident.
  const commandLink = incident.kind === 'command-link';
  return {
    id: `evaluation-${flightId}`,
    flightId,
    leafId: commandLink ? 'fictional.lost-link-review' : 'fictional.landing-review',
    leafVersion: 2,
    bindingId: 'ledger.demo-procedures',
    bindingVersion: 5,
    applicability: 'applicable',
    evidenceState: commandLink ? 'insufficient' : 'conflicting',
    outcome: 'attention',
    title: 'Incident needs review',
    explanation: {
      kind: 'rule',
      code: commandLink ? 'episode_open' : 'values_disagree',
      summary: commandLink ? 'Loss reported' : 'Landing reports disagree',
      evidence: [
        {
          ...evidence,
          observationId: evidence.eventId,
          type: commandLink ? 'link.status' : 'flight.report',
          version: 1,
        },
      ],
      details: commandLink ? { openEpisodeCount: 1 } : { valueCount: 2 },
      parameters: {},
      inputs: [],
      ruleEvaluation: {
        pack: { id: 'ledger.demo-procedures', version: 5, digest: 'b'.repeat(64) },
        ruleDigest: 'c'.repeat(64),
        check: commandLink ? { kind: 'episode.open', version: 1 } : { kind: 'values.disagree', version: 1 },
        mode: 'active',
        subjectKey: `ledger/flight/${flightId}`,
      },
      evaluatedAt: at,
    },
    clock: { mode: 'wall', evaluatedAt: at },
    inputCut: { streams: {} },
    acceptedInputCut: { streams: {} },
    dependencyBasis: 'a'.repeat(64),
    recordedAt: at,
  };
}

function publicFlight(
  incident: OrdinaryIncidentReservation,
  id: string,
  status: FindingRecord['status'],
  views: View[] = ['monitor'],
): PublicFlight {
  const initial = evaluation(incident, id);
  const finding: FindingRecord = {
    id: `finding-${id}`,
    flightId: id,
    status,
    owner: status === 'open' ? null : { id: 'human-owner', name: 'Operator' },
    openedAt: at,
    initialEvaluation: initial,
    latestEvaluation: structuredClone(initial),
    treatments: [],
    hasOlderTreatments: false,
  };
  return {
    flight: {
      id,
      label: 'Ordinary flight',
      originationKey: incident.attemptId,
      revision: 1,
      basisRevision: 1,
      activity: 'landed',
      coverage: 'recorded',
      aircraft: incident.aircraftId,
      orderIds: ['linked-order'],
      sourceIds: ['command-link'],
      unresolvedCount: 0,
      conflictCount: 0,
      outstandingWork: 99,
      findingSummary: { openCount: status === 'resolved' ? 0 : 1, unownedCount: status === 'open' ? 1 : 0 },
    },
    findings: [finding],
    views,
  };
}

function fixture(rows: Partial<Record<OperationTenant, PublicFlight[]>> = {}) {
  const calls: Array<{ tenant: OperationTenant; url: URL }> = [];
  let outstandingWork = 0;
  let override: ((tenant: OperationTenant, url: URL, value: unknown) => Response | undefined) | undefined;
  const meta = () => ({
    requestId: 'bounded-read',
    projectionRevision: 1,
    inputCut: { streams: {} },
    computedAt: at,
    outstandingWork,
  });
  const fetcher: typeof fetch = async (input, init) => {
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    const credential = new Headers(init?.headers).get('authorization');
    const tenant = credential === 'Bearer alpha-source' ? 'alpha' : credential === 'Bearer beta-source' ? 'beta' : null;
    if (!tenant) throw new Error('The reader used a non-source credential');
    const url = new URL(String(input));
    calls.push({ tenant, url });
    const flights = rows[tenant] ?? [];
    let value: unknown;
    if (url.pathname === '/v1/me') {
      value = {
        principal: {
          id: `source-${tenant}`,
          tenantId: `tenant-${tenant}`,
          name: 'Simulation source',
          capabilities: ['flight:read'],
          revision: 1,
          commandLinkSources: [],
          missionSources: [],
          monitoringSources: [],
        },
      };
    } else if (url.pathname === '/v1/flights') {
      const view = url.searchParams.get('view');
      const search = url.searchParams.get('search');
      expect(url.searchParams.get('limit')).toBe('25');
      const selected = flights.filter((row) =>
        view === 'all'
          ? `order-${row.flight.originationKey.slice('intent-'.length).replace(':attempt:1', '')}` === search
          : row.views.includes(view as View),
      );
      value = { flights: selected.map((row) => row.flight), nextCursor: null, meta: meta() };
    } else {
      const [, , , id, suffix] = url.pathname.split('/');
      const row = flights.find((candidate) => candidate.flight.id === id);
      if (!row) return new Response(null, { status: 404 });
      value = suffix === 'findings' ? { findings: row.findings, meta: meta() } : { flight: row.flight, meta: meta() };
    }
    return override?.(tenant, url, value) ?? Response.json(value);
  };
  return {
    fetcher,
    calls,
    pending(value: number) {
      outstandingWork = value;
    },
    override(value: typeof override) {
      override = value;
    },
  };
}

describe('ordinary incident public budget', () => {
  it('deduplicates relevant views across runs and reads an exact resolved reservation outside those views', async () => {
    const radio = reservation('alpha', 'command-link');
    const landing = reservation('alpha', 'landing-disagreement', 1);
    const oldLanding = reservation('alpha', 'landing-disagreement', 900);
    oldLanding.attemptId = 'intent-earlier-run-alpha-900:attempt:1';
    const beta = reservation('beta', 'command-link');
    const radioRow = publicFlight(radio, 'flight-radio', 'responding', ['monitor', 'overdue', 'historical-issues']);
    radioRow.findings[0]!.latestEvaluation.outcome = 'pass';
    const landingRow = publicFlight(landing, 'flight-closed', 'resolved', []);
    const api = fixture({
      alpha: [radioRow, landingRow, publicFlight(oldLanding, 'flight-earlier-run', 'open', ['historical-issues'])],
      beta: [publicFlight(beta, 'flight-beta', 'acknowledged')],
    });
    const budget = await readOrdinaryIncidentBudget(
      config,
      [
        { ...radio, flightId: radioRow.flight.id },
        { ...landing, flightId: landingRow.flight.id },
      ],
      api.fetcher,
      now,
    );
    expect(budget.checkedAt).toBe(at);
    expect(budget.tenants.alpha).toMatchObject({
      complete: true,
      unresolved: { 'command-link': 1, 'landing-disagreement': 1 },
      reservations: [
        { attemptId: radio.attemptId, findingId: 'finding-flight-radio', status: 'responding' },
        { attemptId: landing.attemptId, findingId: 'finding-flight-closed', status: 'resolved' },
      ],
    });
    expect(budget.tenants.beta.unresolved).toEqual({ 'command-link': 1, 'landing-disagreement': 0 });
    expect(api.calls.filter((call) => call.url.pathname === '/v1/flights/flight-radio/findings')).toHaveLength(1);
    expect(api.calls.some((call) => call.url.pathname === '/v1/flights/flight-closed')).toBe(true);
    expect(api.calls.some((call) => call.url.searchParams.get('view') === 'all')).toBe(false);
  });

  it('keeps a missing or unrelated finding unseen and searches only the retained external order identity', async () => {
    const radio = reservation('alpha', 'command-link');
    const missing = reservation('alpha', 'landing-disagreement', 1);
    const row = publicFlight(radio, 'flight-unrelated-resolved', 'resolved', []);
    for (const evaluation of [row.findings[0]!.initialEvaluation, row.findings[0]!.latestEvaluation])
      evaluation.explanation.evidence[0]!.receiptId = 'another-original-receipt';
    const api = fixture({ alpha: [row] });
    const budget = await readOrdinaryIncidentBudget(config, [radio, missing], api.fetcher, now);
    expect(budget.tenants.alpha).toEqual({
      complete: true,
      unresolved: { 'command-link': 0, 'landing-disagreement': 0 },
      reservations: [{ attemptId: radio.attemptId, kind: radio.kind, flightId: row.flight.id, status: 'unseen' }],
    });
    expect(
      api.calls
        .filter((call) => call.url.searchParams.get('view') === 'all')
        .map((call) => call.url.searchParams.get('search')),
    ).toEqual(['order-budget-run-alpha-0', 'order-budget-run-alpha-1']);
  });

  it('keeps an existing exact finding pin after corrections remove the original evidence', async () => {
    const radio = reservation('alpha', 'command-link');
    const row = publicFlight(radio, 'flight-pinned', 'resolved', []);
    row.findings[0]!.initialEvaluation.explanation.evidence = [];
    row.findings[0]!.latestEvaluation.explanation.evidence = [];
    const api = fixture({ alpha: [row] });
    const budget = await readOrdinaryIncidentBudget(
      config,
      [{ ...radio, flightId: row.flight.id, findingId: row.findings[0]!.id }],
      api.fetcher,
      now,
    );
    expect(budget.tenants.alpha.reservations[0]).toMatchObject({ findingId: row.findings[0]!.id, status: 'resolved' });
  });

  it('rejects another tenant authority and does not bind a receipt from the wrong C2 capture', async () => {
    const radio = reservation('alpha', 'command-link');
    const row = publicFlight(radio, 'flight-other-capture', 'resolved', []);
    for (const evaluation of [row.findings[0]!.initialEvaluation, row.findings[0]!.latestEvaluation]) {
      // The generic finding cites another capture's report.
      if ('kind' in evaluation.explanation) evaluation.explanation.evidence[0]!.receiptId = 'another-capture-receipt';
    }
    const api = fixture({ alpha: [row] });
    api.override((tenant, url, value) => {
      if (tenant === 'beta' && url.pathname === '/v1/me') {
        const response = value as { principal: { tenantId: string } };
        response.principal.tenantId = 'tenant-alpha';
        return Response.json(response);
      }
    });
    const budget = await readOrdinaryIncidentBudget(config, [{ ...radio, flightId: row.flight.id }], api.fetcher, now);
    expect(budget.tenants.alpha.reservations[0]).toMatchObject({ status: 'unseen' });
    expect(budget.tenants.beta).toMatchObject({ complete: false, reason: 'authority_mismatch' });
  });

  it('requires global projection quiescence only for the first operator baseline', async () => {
    const api = fixture();
    api.pending(99);
    const initial = await readOrdinaryIncidentBudget(config, [], api.fetcher, now, { alpha: true });
    expect(initial.tenants.alpha).toMatchObject({ complete: false, reason: 'baseline_pending' });
    expect(initial.tenants.beta.complete).toBe(true);
    const established = await readOrdinaryIncidentBudget(config, [], api.fetcher, now);
    expect(established.tenants.alpha.complete).toBe(true);
  });

  it('does not call an unbounded relevant scope complete when a second page still has a cursor', async () => {
    const api = fixture();
    api.override((tenant, url, value) => {
      if (tenant !== 'alpha' || url.searchParams.get('view') !== 'monitor') return;
      return Response.json({ ...(value as object), nextCursor: url.searchParams.has('cursor') ? 'page-3' : 'page-2' });
    });
    const budget = await readOrdinaryIncidentBudget(config, [], api.fetcher, now);
    expect(budget.tenants.alpha).toMatchObject({ complete: false, reason: 'page_limit', reservations: [] });
    expect(budget.tenants.beta.complete).toBe(true);
    expect(
      api.calls.filter((call) => call.tenant === 'alpha' && call.url.searchParams.get('view') === 'monitor'),
    ).toHaveLength(2);
  });

  it('suppresses new faults on a failed read or an inconsistent public finding summary', async () => {
    const incident = reservation('alpha', 'landing-disagreement');
    const row = publicFlight(incident, 'flight-inconsistent', 'resolved');
    row.flight.findingSummary = { openCount: 1, unownedCount: 1 };
    const api = fixture({ alpha: [row] });
    api.override((tenant, url) => {
      if (tenant === 'beta' && url.searchParams.get('view') === 'monitor') return new Response(null, { status: 503 });
    });
    const budget = await readOrdinaryIncidentBudget(config, [], api.fetcher, now);
    expect(budget.tenants.alpha).toMatchObject({ complete: false, reason: 'finding_summary_changed' });
    expect(budget.tenants.beta).toMatchObject({ complete: false, reason: 'api_unavailable' });
  });

  it('does not treat a missing public finding summary as an empty incident backlog', async () => {
    const incident = reservation('alpha', 'landing-disagreement');
    const row = publicFlight(incident, 'flight-missing-summary', 'open');
    delete row.flight.findingSummary;
    const api = fixture({ alpha: [row] });
    const budget = await readOrdinaryIncidentBudget(config, [], api.fetcher, now);
    expect(budget.tenants.alpha).toMatchObject({ complete: false, reason: 'missing_finding_summary' });
    expect(budget.tenants.beta.complete).toBe(true);
  });

  it('bounds a finding response by its original bytes', async () => {
    const incident = reservation('alpha', 'landing-disagreement');
    const row = publicFlight(incident, 'flight-large', 'open');
    const api = fixture({ alpha: [row] });
    api.override((tenant, url, value) => {
      if (tenant === 'alpha' && url.pathname.endsWith('/findings'))
        return new Response(JSON.stringify(value) + ' '.repeat(512 * 1024));
    });
    const budget = await readOrdinaryIncidentBudget(config, [], api.fetcher, now);
    expect(budget.tenants.alpha).toMatchObject({ complete: false, reason: 'response_byte_limit' });
    expect(budget.tenants.beta.complete).toBe(true);
  });
});
