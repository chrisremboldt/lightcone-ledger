import {
  ASSURANCE_HISTORY_DEFAULT_LIMIT,
  ASSURANCE_HISTORY_MAX_LIMIT,
  ASSURANCE_HISTORY_MAX_RESPONSE_BYTES,
  ASSURANCE_HISTORY_MAX_SUMMARY_BYTES,
  type AssuranceHistoryPage,
  type AssuranceHistoryQuery,
  type HazardMonitoringHistoryQuery,
  type HazardMonitoringHistoryResponse,
  type MonitoringWindowSummary,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { historyCursor, historyLimit, historyPage, historyPrecise } from './history.js';

interface HistoryPoint {
  id: string;
  page_time: string;
}
interface RawHistoryPoint {
  id: string | null;
  id_bytes: number;
  page_time: string;
}
interface HistorySelection {
  points: HistoryPoint[];
  page: AssuranceHistoryPage;
}
interface HistoryScope {
  table: 'monitoring_window_revisions';
  predicate: string;
  values: string[];
}
interface SummaryBudgetRow {
  id: string;
  raw_bytes: number;
}
interface MonitoringSummaryRow {
  id: string;
  record_digest: string;
  occurred_at: Date;
  recorded_at: Date;
  source_revision: string;
  source_id: string | null;
  source_session_id: string | null;
  source_window_id: string | null;
  window_bounds: MonitoringWindowSummary['window'] | null;
}
const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
function summaryBound(condition: unknown): asserts condition {
  if (!condition)
    throw new DomainError(
      413,
      'assurance_history_summary_too_large',
      'Retained history cannot fit its bounded summary; no identities were skipped or truncated',
    );
}
function readable(who: AuthContext): void {
  if (!who.capabilities.includes('flight:read'))
    throw new DomainError(403, 'capability_required', 'Capability flight:read is required');
}
function identifier(value: string | null): string {
  summaryBound(typeof value === 'string' && value.length > 0 && [...value].length <= 200);
  return value;
}
function digest(value: string): string {
  summaryBound(/^[a-f0-9]{64}$/.test(value));
  return value;
}
function revision(value: string): number {
  const parsed = Number(value);
  summaryBound(Number.isSafeInteger(parsed) && parsed > 0);
  return parsed;
}
function timestamp(value: Date): string {
  summaryBound(value instanceof Date && Number.isFinite(value.getTime()));
  return value.toISOString();
}
function windowBounds(value: MonitoringWindowSummary['window'] | null): MonitoringWindowSummary['window'] {
  summaryBound(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'end,start',
  );
  for (const time of [value.start, value.end]) {
    summaryBound(
      typeof time === 'string' &&
        /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(time) &&
        Number.isFinite(Date.parse(time)) &&
        new Date(time).toISOString().slice(0, 19) === time.slice(0, 19),
    );
  }
  summaryBound(Date.parse(value.start) < Date.parse(value.end));
  return { start: value.start, end: value.end };
}
function boundedSummaries<T>(rows: T[]): T[] {
  for (const row of rows) summaryBound(byteSize(row) <= ASSURANCE_HISTORY_MAX_SUMMARY_BYTES);
  return rows;
}
function boundedResponse<T>(response: T): T {
  if (byteSize(response) > ASSURANCE_HISTORY_MAX_RESPONSE_BYTES)
    throw new DomainError(
      413,
      'assurance_history_page_too_large',
      'This history page exceeds its 256 KiB response bound; request a smaller limit',
    );
  return response;
}
function sameRows(rows: { id: string }[], points: HistoryPoint[]): void {
  if (rows.length !== points.length || rows.some((row, index) => row.id !== points[index].id))
    throw new DomainError(409, 'assurance_history_changed', 'Retained history could not be read coherently; retry');
}
async function readAt(client: PoolClient): Promise<string> {
  return timestamp((await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now);
}

/** The body digest of a control record version of the hazard, which monitoring cites by its version event. */
async function controlParent(
  client: PoolClient,
  who: AuthContext,
  hazardId: string,
  controlEventId: string,
): Promise<string> {
  const parent = (
    await client.query<{ body_digest: string }>(
      `SELECT v.body_digest FROM sms_record_versions v
       JOIN sms_records c ON c.tenant_id=v.tenant_id AND c.id=v.record_id AND c.kind='control'
       WHERE v.tenant_id=$1 AND v.id=$2 AND v.body->>'hazardId'=$3`,
      [who.tenantId, controlEventId, hazardId],
    )
  ).rows[0];
  if (!parent)
    throw new DomainError(404, 'control_not_found', 'The exact control version was not found within this hazard');
  return digest(parent.body_digest);
}
async function selectPoints(
  client: PoolClient,
  who: AuthContext,
  resource: string,
  filters: Record<string, string | undefined>,
  query: AssuranceHistoryQuery,
  scope: HistoryScope,
): Promise<HistorySelection> {
  const limit = historyLimit(query.limit, ASSURANCE_HISTORY_DEFAULT_LIMIT, ASSURANCE_HISTORY_MAX_LIMIT);
  const prior = historyCursor(query.cursor, who, resource, filters, true);
  const values: (string | number | null)[] = [...scope.values];
  const positions: string[] = [];
  if (prior) {
    for (const [operator, point] of [
      ['<=', prior.upper],
      ['<', prior.position],
    ] as const) {
      const offset = values.length;
      positions.push(
        `(r.recorded_at,r.id COLLATE "C")${operator}($${offset + 1}::timestamptz,$${offset + 2}::text COLLATE "C")`,
      );
      values.push(point.time, point.id);
    }
  }
  values.push(limit + 1);
  const rows = (
    await client.query<RawHistoryPoint>(
      `SELECT CASE WHEN octet_length(r.id)<=${ASSURANCE_HISTORY_MAX_SUMMARY_BYTES} THEN r.id END AS id,
       octet_length(r.id) AS id_bytes,${historyPrecise('r.recorded_at')} AS page_time
       FROM ${scope.table} r WHERE ${scope.predicate}${positions.map((position) => ` AND ${position}`).join('')}
       ORDER BY r.recorded_at DESC,r.id COLLATE "C" DESC LIMIT $${values.length}`,
      values,
    )
  ).rows;
  const points = rows.map((row) => {
    summaryBound(row.id_bytes <= ASSURANCE_HISTORY_MAX_SUMMARY_BYTES);
    return { id: identifier(row.id), page_time: row.page_time };
  });
  const page: AssuranceHistoryPage = {
    ...historyPage(points, limit, prior, who, resource, filters, 'recorded_ascending'),
    order: 'recorded_descending',
    consistency: 'accepted_history',
  };
  summaryBound(page.nextCursor === null || page.nextCursor.length <= 4096);
  return { points: points.slice(0, limit), page };
}
async function preflightSummaries(
  client: PoolClient,
  sql: string,
  values: (string | string[])[],
  points: HistoryPoint[],
): Promise<void> {
  const rows = (await client.query<SummaryBudgetRow>(sql, values)).rows;
  sameRows(rows, points);
  for (const row of rows)
    summaryBound(
      Number.isSafeInteger(row.raw_bytes) && row.raw_bytes >= 0 && row.raw_bytes <= ASSURANCE_HISTORY_MAX_SUMMARY_BYTES,
    );
  if (rows.reduce((total, row) => total + row.raw_bytes, 0) > ASSURANCE_HISTORY_MAX_RESPONSE_BYTES)
    throw new DomainError(
      413,
      'assurance_history_page_too_large',
      'This history page exceeds its response bound; request a smaller limit',
    );
}

export async function getHazardMonitoringHistory(
  client: PoolClient,
  who: AuthContext,
  hazardId: string,
  query: HazardMonitoringHistoryQuery,
): Promise<HazardMonitoringHistoryResponse> {
  readable(who);
  const controlDigest = await controlParent(client, who, hazardId, query.controlEventId);
  const { points, page } = await selectPoints(
    client,
    who,
    'assurance-monitoring',
    { hazardId, controlEventId: query.controlEventId },
    query,
    {
      table: 'monitoring_window_revisions',
      predicate: 'r.tenant_id=$1 AND r.control_event_id=$2',
      values: [who.tenantId, query.controlEventId],
    },
  );
  const values = [who.tenantId, points.map((point) => point.id), `organization:${who.tenantId}`];
  const from = `FROM monitoring_window_revisions r JOIN monitoring_windows w
    ON w.tenant_id=r.tenant_id AND w.id=r.window_id AND w.organization_id=r.organization_id
    WHERE r.tenant_id=$1 AND r.id=ANY($2::text[]) AND r.organization_id=$3`;
  await preflightSummaries(
    client,
    `SELECT r.id,octet_length(r.id)+octet_length(r.record_digest)+octet_length(w.source_id)
     +octet_length(w.source_session_id)+octet_length(w.source_window_id)+octet_length(r.window_bounds::text) AS raw_bytes
     ${from} ORDER BY r.recorded_at DESC,r.id COLLATE "C" DESC`,
    values,
    points,
  );
  const rows = (
    await client.query<MonitoringSummaryRow>(
      `SELECT r.id,r.record_digest,r.occurred_at,r.recorded_at,r.source_revision,
       CASE WHEN octet_length(w.source_id)<=${ASSURANCE_HISTORY_MAX_SUMMARY_BYTES} THEN w.source_id END AS source_id,
       CASE WHEN octet_length(w.source_session_id)<=${ASSURANCE_HISTORY_MAX_SUMMARY_BYTES} THEN w.source_session_id END AS source_session_id,
       CASE WHEN octet_length(w.source_window_id)<=${ASSURANCE_HISTORY_MAX_SUMMARY_BYTES} THEN w.source_window_id END AS source_window_id,
       CASE WHEN octet_length(r.window_bounds::text)<=${ASSURANCE_HISTORY_MAX_SUMMARY_BYTES} THEN r.window_bounds END AS window_bounds
       ${from} ORDER BY r.recorded_at DESC,r.id COLLATE "C" DESC`,
      values,
    )
  ).rows;
  sameRows(rows, points);
  const monitoring = boundedSummaries(
    rows.map((row): MonitoringWindowSummary => ({
      id: identifier(row.id),
      digest: digest(row.record_digest),
      occurredAt: timestamp(row.occurred_at),
      recordedAt: timestamp(row.recorded_at),
      sourceId: identifier(row.source_id),
      sourceSessionId: identifier(row.source_session_id),
      sourceWindowId: identifier(row.source_window_id),
      sourceRevision: revision(row.source_revision),
      window: windowBounds(row.window_bounds),
    })),
  );
  return boundedResponse({
    hazardId,
    controlEventId: query.controlEventId,
    controlDigest,
    monitoring,
    page,
    readAt: await readAt(client),
  });
}
