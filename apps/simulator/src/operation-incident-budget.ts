import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  EvaluationRecord,
  FindingRecord,
  FindingsResponse,
  FlightListResponse,
  FlightResponse,
  FlightSummary,
  Principal,
  ResponseMeta,
} from '@ledger/contracts';
import {
  FindingsResponseSchema,
  FlightListResponseSchema,
  FlightResponseSchema,
  PrincipalResponseSchema,
} from '@ledger/contracts/openapi';
import type {
  OperationTenant,
  OrdinaryIncidentBudget,
  OrdinaryIncidentKind,
  OrdinaryIncidentReservation,
} from '@ledger/simulation-models/operation';
import { OracleApi, OracleReadError } from './oracle-api.js';
import type { ScenarioConfig } from './scenario.js';

const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const principalShape = ajv.compile<{ principal: Principal }>(PrincipalResponseSchema);
const listShape = ajv.compile<FlightListResponse>(FlightListResponseSchema);
const flightShape = ajv.compile<FlightResponse>(FlightResponseSchema);
const findingsShape = ajv.compile<FindingsResponse>(FindingsResponseSchema);
const tenants = ['alpha', 'beta'] as const;
const views = ['monitor', 'overdue', 'historical-issues'] as const;
const incidentKinds: readonly OrdinaryIncidentKind[] = ['command-link', 'landing-disagreement'];
type TenantBudget = OrdinaryIncidentBudget['tenants'][OperationTenant];

function unavailable(code: string): never {
  throw new OracleReadError('unverifiable', code, 'The ordinary incident budget is incomplete');
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s/\\]/.test(value);
}

function orderId(reservation: OrdinaryIncidentReservation): string {
  const match = /^intent-([A-Za-z0-9_-]{1,100})-(alpha|beta)-(0|[1-9]\d*):attempt:1$/.exec(reservation.attemptId);
  if (!match || match[2] !== reservation.tenant || !Number.isSafeInteger(Number(match[3])))
    unavailable('invalid_reservation');
  return `order-${match[1]}-${match[2]}-${match[3]}`;
}

function boundedFetcher(fetcher: typeof fetch): typeof fetch {
  let requests = 0;
  let totalBytes = 0;
  const deadline = Date.now() + 10_000;
  return async (input, init) => {
    if (++requests > 64) unavailable('request_limit');
    if (Date.now() >= deadline) unavailable('deadline_exceeded');
    const response = await fetcher(input, init);
    if (response.redirected) {
      void response.body?.cancel().catch(() => {});
      unavailable('redirect_unsupported');
    }
    if (!response.body) return response;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const limit = url.pathname.endsWith('/findings') ? 512 * 1024 : 256 * 1024;
    let bytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (Date.now() >= deadline) unavailable('deadline_exceeded');
          if (bytes > limit) unavailable('response_byte_limit');
          if (totalBytes > 4 * 1024 * 1024) unavailable('byte_limit');
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// A finding's kind follows its check, never its rule: reported episodes still open, or reported values that
// disagree. A retained lost-link evaluation from before the generic evaluator keeps its own explanation format.
function findingKind(evaluation: EvaluationRecord): OrdinaryIncidentKind | undefined {
  const explanation = evaluation.explanation;
  if (!('kind' in explanation)) return undefined;
  if (explanation.kind === 'command_link') return 'command-link';
  if (explanation.kind !== 'rule') return undefined;
  if (explanation.ruleEvaluation.check.kind === 'episode.open') return 'command-link';
  if (explanation.ruleEvaluation.check.kind === 'values.disagree') return 'landing-disagreement';
  return undefined;
}

function hasWitness(evaluation: EvaluationRecord, reservation: OrdinaryIncidentReservation): boolean {
  if (!reservation.evidenceReceiptId) return false;
  const explanation = evaluation.explanation;
  // A generic evaluation cites the accepted report itself.
  if (reservation.kind === 'landing-disagreement' || ('kind' in explanation && explanation.kind === 'rule'))
    return explanation.evidence.some((evidence) => evidence.receiptId === reservation.evidenceReceiptId);
  if (!('kind' in explanation) || explanation.kind !== 'command_link') return false;
  const sameCapture = (row: { sourceId: string; sourceSessionId: string; incidentId: string; aircraftId: string }) =>
    row.sourceId === 'command-link' &&
    row.sourceSessionId === reservation.sourceSessionId &&
    row.incidentId === reservation.incidentId &&
    row.aircraftId === reservation.aircraftId;
  return (
    explanation.evidence.some(
      (evidence) =>
        evidence.receiptId === reservation.evidenceReceiptId &&
        evidence.flightId === evaluation.flightId &&
        evidence.status === 'lost' &&
        sameCapture(evidence),
    ) && explanation.groups.some(sameCapture)
  );
}

async function readTenant(
  config: Pick<ScenarioConfig, 'apiUrl' | 'tokens'>,
  tenant: OperationTenant,
  reservations: readonly OrdinaryIncidentReservation[],
  fetcher: typeof fetch,
  now: () => number,
  initial: boolean,
): Promise<TenantBudget> {
  try {
    if (reservations.length > 128) unavailable('reservation_limit');
    const attempts = new Set<string>();
    for (const reservation of reservations) {
      orderId(reservation);
      if (
        attempts.has(reservation.attemptId) ||
        !incidentKinds.includes(reservation.kind) ||
        ![reservation.aircraftId, reservation.sourceSessionId, reservation.incidentId].every(identity) ||
        [reservation.flightId, reservation.findingId, reservation.evidenceReceiptId].some(
          (value) => value !== undefined && !identity(value),
        ) ||
        (reservation.findingId !== undefined && reservation.flightId === undefined)
      )
        unavailable('invalid_reservation');
      attempts.add(reservation.attemptId);
    }
    const api = new OracleApi(
      config.apiUrl,
      config.tokens[tenant].source,
      { requests: 64, bytes: 4 * 1024 * 1024, timeoutMs: 10_000, requestTimeoutMs: 3000 },
      fetcher,
    );
    const read = async <T>(path: string, shape: ValidateFunction<T>): Promise<T> => {
      const value = await api.json<unknown>(path);
      if (!shape(value)) unavailable('malformed_response');
      return value;
    };
    const metadata = (meta: ResponseMeta) => {
      const at = Date.parse(meta.computedAt);
      const current = now();
      if (!Number.isSafeInteger(at) || at > current + 1000 || current - at > 60_000) unavailable('stale_response');
      if (initial && meta.outstandingWork !== 0) unavailable('baseline_pending');
    };
    const { principal } = await read('/v1/me', principalShape);
    if (principal.tenantId !== `tenant-${tenant}` || !principal.capabilities.includes('flight:read'))
      unavailable('authority_mismatch');

    const flights = new Map<string, FlightSummary>();
    const retainedFlights = new Map<string, string>();
    const remember = (flight: FlightSummary) => {
      if (!identity(flight.id) || !identity(flight.originationKey)) unavailable('malformed_flight');
      if (!flight.findingSummary) unavailable('missing_finding_summary');
      const previous = flights.get(flight.id);
      if (previous && previous.originationKey !== flight.originationKey) unavailable('flight_identity_changed');
      flights.set(flight.id, flight);
    };
    let pages = 0;
    const page = async (query: URLSearchParams) => {
      if (++pages > 10) unavailable('page_limit');
      const response = await read(`/v1/flights?${query}`, listShape);
      metadata(response.meta);
      const limit = Number(query.get('limit'));
      if (response.flights.length > limit || response.nextCursor === undefined) unavailable('malformed_page');
      if (
        response.nextCursor !== null &&
        (response.nextCursor.length === 0 || response.nextCursor.length > 4096 || /\s/.test(response.nextCursor))
      )
        unavailable('malformed_cursor');
      if (query.get('view') === 'all') {
        let previous = query.get('cursor');
        for (const flight of response.flights) {
          if (previous !== null && flight.id <= previous) unavailable('malformed_cursor');
          previous = flight.id;
        }
        if (response.nextCursor !== null && response.nextCursor !== previous) unavailable('malformed_cursor');
      }
      return response;
    };
    for (const reservation of reservations) {
      let flightId = reservation.flightId;
      if (!flightId) {
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let index = 0; index < 2; index++) {
          const query = new URLSearchParams({ view: 'all', search: orderId(reservation), limit: '25' });
          if (cursor) query.set('cursor', cursor);
          const response = await page(query);
          const matches = response.flights.filter((flight) => flight.originationKey === reservation.attemptId);
          if (matches.length > 1) unavailable('ambiguous_flight');
          flightId = matches[0]?.id;
          if (flightId || response.nextCursor === null) break;
          cursor = response.nextCursor!;
          if (seen.has(cursor)) unavailable('repeated_cursor');
          seen.add(cursor);
          if (index === 1) unavailable('page_limit');
        }
      }
      if (!flightId) continue;
      const response = await read(`/v1/flights/${encodeURIComponent(flightId)}`, flightShape);
      metadata(response.meta);
      if (response.flight.id !== flightId || response.flight.originationKey !== reservation.attemptId)
        unavailable('reservation_flight_mismatch');
      remember(response.flight);
      retainedFlights.set(reservation.attemptId, flightId);
    }
    for (const view of views) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let index = 0; index < 2; index++) {
        const query = new URLSearchParams({ view, limit: '25' });
        if (cursor) query.set('cursor', cursor);
        const response = await page(query);
        for (const flight of response.flights) remember(flight);
        if (response.nextCursor === null) break;
        cursor = response.nextCursor!;
        if (seen.has(cursor)) unavailable('repeated_cursor');
        seen.add(cursor);
        if (index === 1) unavailable('page_limit');
      }
    }

    const findings = new Map<string, FindingRecord[]>();
    const findingFlights = new Map<string, string>();
    const unresolved = { 'command-link': 0, 'landing-disagreement': 0 };
    const prioritized = new Set(retainedFlights.values());
    for (const flight of flights.values()) if (flight.findingSummary!.openCount > 0) prioritized.add(flight.id);
    if (prioritized.size > 12) unavailable('finding_read_limit');
    for (const flightId of prioritized) {
      const flight = flights.get(flightId)!;
      const response = await read(`/v1/flights/${encodeURIComponent(flightId)}/findings`, findingsShape);
      metadata(response.meta);
      const localIds = new Set<string>();
      const localKinds = new Set<OrdinaryIncidentKind>();
      let open = 0;
      let unowned = 0;
      for (const finding of response.findings) {
        if (
          !identity(finding.id) ||
          localIds.has(finding.id) ||
          finding.flightId !== flightId ||
          finding.initialEvaluation.flightId !== flightId ||
          finding.latestEvaluation.flightId !== flightId ||
          finding.initialEvaluation.leafId !== finding.latestEvaluation.leafId ||
          (findingFlights.has(finding.id) && findingFlights.get(finding.id) !== flightId)
        )
          unavailable('finding_identity_mismatch');
        localIds.add(finding.id);
        findingFlights.set(finding.id, flightId);
        const kind = findingKind(finding.latestEvaluation);
        if (findingKind(finding.initialEvaluation) !== kind) unavailable('finding_identity_mismatch');
        if (!kind && finding.status !== 'resolved') unavailable('unsupported_open_finding');
        if (kind) {
          if (localKinds.has(kind)) unavailable('ambiguous_finding');
          localKinds.add(kind);
          if (finding.status !== 'resolved') unresolved[kind]++;
        }
        if (finding.status !== 'resolved') {
          open++;
          if (finding.owner === null) unowned++;
        }
      }
      if (
        flight.findingSummary &&
        (flight.findingSummary.openCount !== open || flight.findingSummary.unownedCount !== unowned)
      )
        unavailable('finding_summary_changed');
      findings.set(flightId, response.findings);
    }
    const observations: TenantBudget['reservations'] = [];
    for (const reservation of reservations) {
      const flightId = retainedFlights.get(reservation.attemptId);
      if (!flightId) continue;
      const finding = findings.get(flightId)!.find((row) => {
        if (findingKind(row.latestEvaluation) !== reservation.kind) return false;
        if (reservation.findingId) return row.id === reservation.findingId;
        return hasWitness(row.initialEvaluation, reservation) || hasWitness(row.latestEvaluation, reservation);
      });
      observations.push({
        attemptId: reservation.attemptId,
        kind: reservation.kind,
        flightId,
        ...(finding ? { findingId: finding.id } : {}),
        status: finding?.status ?? 'unseen',
      });
    }
    return { complete: true, unresolved, reservations: observations };
  } catch (error) {
    return {
      complete: false,
      unresolved: { 'command-link': 0, 'landing-disagreement': 0 },
      reservations: [],
      reason: error instanceof OracleReadError ? error.code : 'read_unavailable',
    };
  }
}

export async function readOrdinaryIncidentBudget(
  config: Pick<ScenarioConfig, 'apiUrl' | 'tokens'>,
  reservations: readonly OrdinaryIncidentReservation[],
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  initial: Partial<Record<OperationTenant, boolean>> = {},
): Promise<OrdinaryIncidentBudget> {
  const checkedAt = new Date(now()).toISOString();
  const retained = structuredClone(reservations);
  const bounded = boundedFetcher(fetcher);
  const [alpha, beta] = await Promise.all(
    tenants.map((tenant) =>
      readTenant(
        config,
        tenant,
        retained.filter((row) => row.tenant === tenant),
        bounded,
        now,
        initial[tenant] === true,
      ),
    ),
  );
  return { checkedAt, tenants: { alpha: alpha!, beta: beta! } };
}
