import type {
  DecisionRecord,
  HistoryPage,
  HistoryQuery,
  OrderQuery,
  OrderSummary,
  ReceiptQuery,
  Receipt,
  TimelineItem,
  TimelineQuery,
} from '@ledger/contracts';
import { InputSchema } from '@ledger/contracts';
import { canonicalize } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { receiptView, requireRow } from './index.js';
import { getFindings } from './findings.js';
import { flightFindingReadContext } from './rule-evaluation-reads.js';

type Position = { id: string; time: string | null };
interface OrderRow {
  id: string;
  external_id: string;
  source_id: string;
  revision: string;
  status: string;
  flight_ids: string[];
  payload: Record<string, unknown>;
}
interface ReceiptRow {
  id: string;
  source_id: string;
  kind: Receipt['kind'];
  received_at: Date;
  occurred_at: Date;
  link_status: Receipt['linkStatus'];
  flight_id: string | null;
  order_id: string | null;
  artifact_id: string | null;
  event_id: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'leased' | 'completed' | 'failed' | null;
  attempts: number | null;
  error: string | null;
  page_time: string;
}
interface Cursor {
  v: 1;
  tenant: string;
  principal: string;
  authority: number;
  resource: string;
  filter: string;
  upper: Position;
  position: Position;
}
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function precise(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
const filterKey = (filters: Record<string, string | undefined>) =>
  canonicalize(Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)));

export function historyLimit(value: unknown, fallback = 200, maximum = 500): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value)))
    throw new DomainError(400, 'invalid_page_limit', `Page limit must be an integer from 1 to ${maximum}`);
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new DomainError(400, 'invalid_page_limit', `Page limit must be an integer from 1 to ${maximum}`);
  return limit;
}
function positionValid(value: unknown): value is Position {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Position;
  return (
    Object.keys(point).sort().join(',') === 'id,time' &&
    typeof point.id === 'string' &&
    point.id.length > 0 &&
    [...point.id].length <= 200 &&
    (point.time === null || validTimestamp(point.time))
  );
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !timestamp.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value);
  // Date.parse normalizes invalid Gregorian dates. Reject that rollover without
  // truncating the original PostgreSQL microseconds used by the keyset query.
  return Number.isFinite(date.getTime()) && date.toISOString() === `${value.slice(0, 23)}Z`;
}
function cursor(
  value: string | undefined,
  who: AuthContext,
  resource: string,
  filters: Record<string, string | undefined>,
  timed: boolean,
): Cursor | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || !value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(bytes) as Cursor;
    if (
      Buffer.from(bytes).toString('base64url') !== value ||
      canonicalize(parsed) !== bytes ||
      Object.keys(parsed).sort().join(',') !== 'authority,filter,position,principal,resource,tenant,upper,v' ||
      parsed.v !== 1 ||
      !positionValid(parsed.upper) ||
      !positionValid(parsed.position) ||
      !Number.isSafeInteger(parsed.authority)
    )
      throw new Error();
    if (
      parsed.tenant !== who.tenantId ||
      parsed.principal !== who.id ||
      parsed.authority !== who.revision ||
      parsed.resource !== resource ||
      parsed.filter !== filterKey(filters)
    )
      throw new DomainError(
        400,
        'cursor_scope_mismatch',
        'This history cursor belongs to a different tenant, authority, flight, or filter. Start a fresh page.',
      );
    if ((parsed.position.time !== null) !== timed || (parsed.upper.time !== null) !== timed) throw new Error();
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(400, 'invalid_history_cursor', 'History cursor is malformed. Start a fresh page.');
  }
}
export function encodeHistoryCursor(
  who: AuthContext,
  resource: string,
  filters: Record<string, string | undefined>,
  upper: Position,
  position: Position,
): string {
  const next: Cursor = {
    v: 1,
    tenant: who.tenantId,
    principal: who.id,
    authority: who.revision,
    resource,
    filter: filterKey(filters),
    upper,
    position,
  };
  return Buffer.from(canonicalize(next)).toString('base64url');
}

function page(
  rows: Record<string, any>[],
  limit: number,
  prior: Cursor | null,
  who: AuthContext,
  resource: string,
  filters: Record<string, string | undefined>,
  order: HistoryPage['order'],
  upper?: Position,
): HistoryPage {
  const visible = rows.slice(0, limit),
    hasMore = rows.length > limit;
  const point = (row: Record<string, any>): Position => ({ id: row.id, time: row.page_time ?? null });
  return {
    limit,
    returned: visible.length,
    hasMore,
    nextCursor: hasMore
      ? encodeHistoryCursor(who, resource, filters, prior?.upper ?? upper ?? point(visible[0]!), point(visible.at(-1)!))
      : null,
    selection: prior ? 'continuation' : 'initial',
    order,
    consistency: 'live_projection',
  };
}
export { cursor as historyCursor, page as historyPage, precise as historyPrecise };

function item(row: Record<string, any>): TimelineItem {
  return {
    id: row.id,
    lane: row.lane,
    kind: row.kind,
    title: row.title,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    actorId: row.actor_id,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    payload: row.payload,
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.correction_of ? { correctionOf: row.correction_of } : {}),
    linkStatus: row.link_status,
  };
}
function decision(row: Record<string, any>): DecisionRecord {
  return {
    id: row.id,
    flightId: row.flight_id,
    actorId: row.actor_id,
    kind: row.kind,
    note: row.note,
    recordedAt: row.recorded_at.toISOString(),
    renderedInputCut: row.rendered_input_cut,
    acceptedInputCut: row.accepted_input_cut,
    acceptedBasisRevision: Number(row.accepted_basis_revision),
  };
}
export async function getTimeline(client: PoolClient, flightId: string, who: AuthContext, query: TimelineQuery = {}) {
  await requireRow(client, 'flight_views', flightId);
  const filters = { flightId },
    limit = historyLimit(query.limit),
    decisionLimit = historyLimit(query.decisionLimit, 100, 200);
  const itemsCursor = cursor(query.cursor, who, 'timeline', filters, true),
    decisionsCursor = cursor(query.decisionCursor, who, 'decisions', filters, true);
  const timedPage = (table: string, column: string, prior: Cursor | null, size: number) =>
    client.query(
      `SELECT *,${precise(column)} AS page_time FROM ${table} WHERE flight_id=$1 AND ($2::timestamptz IS NULL OR (${column},id)<=($2::timestamptz,$3::text)) AND ($4::timestamptz IS NULL OR (${column},id)<($4::timestamptz,$5::text)) ORDER BY ${column} DESC,id DESC LIMIT $6`,
      [
        flightId,
        prior?.upper.time ?? null,
        prior?.upper.id ?? null,
        prior?.position.time ?? null,
        prior?.position.id ?? null,
        size + 1,
      ],
    );
  const events = await timedPage('timeline_items', 'received_at', itemsCursor, limit),
    records = await timedPage('decisions', 'recorded_at', decisionsCursor, decisionLimit);
  let selectedItem: TimelineItem | null = null,
    selectedDecision: DecisionRecord | null = null;
  if (query.selectedItemId) {
    const selected = (
      await client.query('SELECT * FROM timeline_items WHERE flight_id=$1 AND id=$2', [flightId, query.selectedItemId])
    ).rows[0];
    if (selected) selectedItem = item(selected);
    const record = (
      await client.query('SELECT * FROM decisions WHERE flight_id=$1 AND id=$2', [flightId, query.selectedItemId])
    ).rows[0];
    if (record) selectedDecision = decision(record);
  }
  const findings = await getFindings(client, flightId);
  return {
    items: events.rows.slice(0, limit).reverse().map(item),
    decisions: records.rows.slice(0, decisionLimit).reverse().map(decision),
    findings,
    ...(await flightFindingReadContext(client, findings)),
    selectedItem,
    selectedDecision,
    window: {
      items: page(events.rows, limit, itemsCursor, who, 'timeline', filters, 'received_ascending'),
      decisions: page(records.rows, decisionLimit, decisionsCursor, who, 'decisions', filters, 'recorded_ascending'),
    },
  };
}
export async function getOrders(client: PoolClient, who: AuthContext, query: OrderQuery = {}) {
  const view = query.view ?? 'all';
  if (!['all', 'awaiting-flight', 'awaiting-current', 'awaiting-overdue'].includes(view))
    throw new DomainError(400, 'invalid_order_filter', 'Order view is invalid');
  if (view !== 'all' && query.flightId)
    throw new DomainError(400, 'invalid_order_filter', 'Orders awaiting a flight cannot also filter by flight');
  if (query.flightId) await requireRow(client, 'flight_views', query.flightId);
  const filters = { flightId: query.flightId, sourceId: query.sourceId, view: view === 'all' ? undefined : view },
    limit = historyLimit(query.limit, 100, 200),
    prior = cursor(query.cursor, who, 'orders', filters, false);
  const requestedEnd = `CASE WHEN jsonb_typeof(o.payload->'scheduledEnd')='string'
    AND o.payload->>'scheduledEnd' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(\\.\\d{1,9})?Z$'
    AND pg_input_is_valid(o.payload->>'scheduledEnd','timestamptz')
    THEN (o.payload->>'scheduledEnd')::timestamptz END`;
  const elapsed = `(${requestedEnd})<=transaction_timestamp()`;
  const windowFilter =
    view === 'awaiting-current'
      ? ` AND NOT COALESCE(${elapsed},false)`
      : view === 'awaiting-overdue'
        ? ` AND ${elapsed}`
        : '';
  const awaitingFlight =
    view !== 'all'
      ? ` AND o.status='accepted' AND NOT EXISTS(SELECT 1 FROM fulfillments f WHERE f.tenant_id=o.tenant_id AND f.source_id=o.source_id AND f.order_external_id=o.external_id)`
      : '';
  const predicate = `($1::text IS NULL OR o.source_id=$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM fulfillments f WHERE f.tenant_id=o.tenant_id AND f.source_id=o.source_id AND f.order_external_id=o.external_id AND f.flight_id=$2))${awaitingFlight}${windowFilter}`;
  const upper = prior?.upper ?? {
    id:
      (
        await client.query<{ id: string | null }>(
          `SELECT MAX(o.id) AS id FROM operational_orders o WHERE ${predicate}`,
          [query.sourceId ?? null, query.flightId ?? null],
        )
      ).rows[0].id ?? '',
    time: null,
  };
  const rows = await client.query<OrderRow>(
    `SELECT o.*,ARRAY(SELECT f.flight_id FROM fulfillments f WHERE f.tenant_id=o.tenant_id AND f.source_id=o.source_id AND f.order_external_id=o.external_id ORDER BY f.flight_id) AS flight_ids FROM operational_orders o WHERE ${predicate} AND ($3::text IS NULL OR o.id>$3) AND o.id<=$4 ORDER BY o.id LIMIT $5`,
    [query.sourceId ?? null, query.flightId ?? null, prior?.position.id ?? null, upper.id, limit + 1],
  );
  const orders: OrderSummary[] = [];
  for (const row of rows.rows.slice(0, limit)) {
    orders.push({
      id: row.id,
      externalId: row.external_id,
      sourceId: row.source_id,
      revision: Number(row.revision),
      status: row.status,
      flightIds: row.flight_ids,
      payload: row.payload,
    });
  }
  return { orders, page: page(rows.rows, limit, prior, who, 'orders', filters, 'id_ascending', upper) };
}
export async function getReceipts(client: PoolClient, who: AuthContext, query: ReceiptQuery = {}) {
  if (query.flightId) await requireRow(client, 'flight_views', query.flightId);
  if (query.linkStatus !== undefined && !['unresolved', 'candidate', 'linked', 'unlinked'].includes(query.linkStatus))
    throw new DomainError(400, 'invalid_receipt_filter', 'Receipt linkage filter is invalid');
  if (
    query.excludeKind !== undefined &&
    !InputSchema.properties.kind.anyOf.some((kind) => kind.const === query.excludeKind)
  )
    throw new DomainError(400, 'invalid_receipt_filter', 'Excluded receipt kind is unsupported');
  const filters = {
      flightId: query.flightId,
      sourceId: query.sourceId,
      linkStatus: query.linkStatus,
      excludeKind: query.excludeKind,
    },
    limit = historyLimit(query.limit, 100, 200),
    prior = cursor(query.cursor, who, 'receipts', filters, true);
  const rows = await client.query<ReceiptRow>(
    `SELECT r.*,w.state,w.attempts,w.error,${precise('r.received_at')} AS page_time FROM receipts r LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.event_id WHERE ($1::text IS NULL OR r.flight_id=$1) AND ($2::text IS NULL OR r.source_id=$2) AND ($3::text IS NULL OR r.link_status=$3 OR ($3='unlinked' AND r.link_status IN ('unresolved','candidate'))) AND ($4::timestamptz IS NULL OR (r.received_at,r.id)<=($4::timestamptz,$5::text)) AND ($6::timestamptz IS NULL OR (r.received_at,r.id)<($6::timestamptz,$7::text)) AND ($9::text IS NULL OR r.kind<>$9) ORDER BY r.received_at DESC,r.id DESC LIMIT $8`,
    [
      query.flightId ?? null,
      query.sourceId ?? null,
      query.linkStatus ?? null,
      prior?.upper.time ?? null,
      prior?.upper.id ?? null,
      prior?.position.time ?? null,
      prior?.position.id ?? null,
      limit + 1,
      query.excludeKind ?? null,
    ],
  );
  const receipts = rows.rows
    .slice(0, limit)
    .reverse()
    .map((row) => receiptView(row, row));
  return { receipts, page: page(rows.rows, limit, prior, who, 'receipts', filters, 'received_ascending') };
}
