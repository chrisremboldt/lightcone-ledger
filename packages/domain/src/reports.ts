import {
  OPERATOR_RECORD_SOURCE_ID,
  REPORT_LIMITS,
  type ControlIndicatorResultRecord,
  type FindingsByMonth,
  type FindingsByMonthQuery,
  type IndicatorHistory,
  type PeriodSummary,
  type ReportIndicatorList,
  type ReportPeriodQuery,
  type ReportRuleCounts,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { findIndicatorDefinition } from './indicators.js';
import { validDay } from './open-findings.js';
import { operatorRecordObservationTypes, RECORD_TYPE_SQL } from './operator-record-reads.js';
import { getRulePackVersion } from './rule-pack-registry.js';
import { closedActions, settledActions, signedVersions, type SettledAction } from './sms-assurance.js';

/**
 * Reports: a summary of a period, findings opened and closed per month by rule, and an indicator's recorded results
 * over time (docs/design/reports.md). Every number is a count the database makes of recorded things, under the
 * reader's own scope; a part the reader may not read is named as not theirs, never counted as zero. Reads take no
 * row locks.
 */

/** The flights a period counts, and the plans a flight's own record is told apart from. */
const FLIGHT_RECORD = 'flight.record';
const FLIGHT_PLAN = 'flight.plan';

const has = (principal: AuthContext, capability: string) => principal.capabilities.includes(capability);
const notReadable = (capability: string) => ({ readable: false as const, capability });

function requireEvidenceRead(principal: AuthContext): void {
  if (!has(principal, 'evidence:read'))
    throw new DomainError(403, 'capability_required', 'Reading this report requires evidence:read');
}

/** The number of days from one calendar day to another, the first included and the last excluded. */
export function daysBetween(from: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Refuses a period that is not two calendar days in order, at most the longest a summary covers. */
export function checkPeriod(query: ReportPeriodQuery): void {
  for (const day of [query.from, query.until])
    if (!validDay(day))
      throw new DomainError(400, 'invalid_day', `${day} is not a calendar date; give a day such as 2026-11-01`);
  if (query.until < query.from) throw new DomainError(400, 'invalid_period', 'The last day comes before the first');
  if (daysBetween(query.from, query.until) + 1 > REPORT_LIMITS.summaryDays)
    throw new DomainError(
      400,
      'period_too_long',
      `A summary covers at most ${REPORT_LIMITS.summaryDays} days; choose a shorter period`,
    );
}

/** Each month from one to another, both included, as YYYY-MM. */
export function monthsBetween(from: string, until: string): string[] {
  const months: string[] = [];
  let [year, month] = from.split('-').map(Number) as [number, number];
  for (;;) {
    const current = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    months.push(current);
    if (current >= until) return months;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/** The month a number of months before another, as YYYY-MM. */
export function monthBefore(month: string, count: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (number - 1) - count;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

interface Bounds {
  zone: string;
  start: Date;
  end: Date;
  now: Date;
  /** What "at the end" is counted at, and that instant's day in the organization's time zone. */
  asOf: Date;
  asOfDay: string;
}

async function periodBounds(client: PoolClient, tenantId: string, from: string, until: string): Promise<Bounds> {
  const row = (
    await client.query<{ zone: string; start: Date; stop: Date; now: Date; as_of_day: string }>(
      `SELECT z.zone,($2::date::timestamp AT TIME ZONE z.zone) AS start,
         (($3::date+1)::timestamp AT TIME ZONE z.zone) AS stop,clock_timestamp() AS now,
         to_char(least((($3::date+1)::timestamp AT TIME ZONE z.zone),clock_timestamp()) AT TIME ZONE z.zone,
           'YYYY-MM-DD') AS as_of_day
       FROM (SELECT COALESCE(time_zone,'UTC') AS zone FROM tenants WHERE id=$1) z`,
      [tenantId, from, until],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'organization_not_found', 'The organization was not found');
  const asOf = row.stop.getTime() < row.now.getTime() ? row.stop : row.now;
  return { zone: row.zone, start: row.start, end: row.stop, now: row.now, asOf, asOfDay: row.as_of_day };
}

/** Current operator records of one type about flights, neither replaced nor withdrawn, the newest for each flight. */
const currentFlightRecords = (
  recordType: string,
) => `SELECT DISTINCT ON(o.subject_id) o.subject_id,o.interval_start,o.interval_end
  FROM observations o WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=ANY($3::text[])
    AND o.subject_scope='source' AND o.subject_kind='flight' AND ${RECORD_TYPE_SQL}=${recordType}
    AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
  ORDER BY o.subject_id,o.received_at DESC,o.id DESC`;

async function flightCounts(client: PoolClient, tenantId: string, bounds: Bounds) {
  const types = operatorRecordObservationTypes();
  const row = (
    await client.query<{ flights: string; seconds: string; without: string; planned: string }>(
      `WITH flown AS (${currentFlightRecords('$4')}),planned AS (${currentFlightRecords('$7')})
       SELECT
         (SELECT count(*) FROM flown WHERE interval_start>=$5 AND interval_start<$6) AS flights,
         (SELECT COALESCE(floor(sum(EXTRACT(EPOCH FROM interval_end-interval_start))),0) FROM flown
           WHERE interval_start>=$5 AND interval_start<$6 AND interval_end>interval_start) AS seconds,
         (SELECT count(*) FROM flown WHERE interval_start>=$5 AND interval_start<$6
           AND (interval_end IS NULL OR interval_end<=interval_start)) AS without,
         (SELECT count(*) FROM planned p WHERE p.interval_start>=$5 AND p.interval_start<$6
           AND NOT EXISTS(SELECT 1 FROM flown f WHERE f.subject_id=p.subject_id)) AS planned`,
      [tenantId, OPERATOR_RECORD_SOURCE_ID, types, FLIGHT_RECORD, bounds.start, bounds.end, FLIGHT_PLAN],
    )
  ).rows[0]!;
  return {
    readable: true as const,
    flights: Number(row.flights),
    flightSeconds: Number(row.seconds),
    withoutDuration: Number(row.without),
    plannedWithoutRecord: Number(row.planned),
  };
}

/**
 * Each finding the generic evaluator opened, with the tab its latest result puts it on: counted, proposed (a shadow
 * adoption) or relieved (a waiver relieves the rule). `f`, `v` and `r` are the finding, its view and that result.
 */
const findingRows = `SELECT f.pack_id,f.leaf_id,f.opened_at,v.status,v.closed_at,v.action_due_on,v.action_done_at,v.id,
    r.record->'rule'->>'title' AS rule_title,(r.record->'pack'->>'version')::int AS pack_version,
    CASE WHEN r.record->'adoption'->>'mode'='shadow' THEN 'proposed' WHEN r.outcome='relieved' THEN 'relieved'
      ELSE 'counted' END AS tab
  FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
  JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
  WHERE f.tenant_id=$1`;

interface RuleRow {
  pack_id: string;
  leaf_id: string;
  rule_title: string | null;
  pack_version: number | null;
}

/** A pack's title as the pack names itself, read once per pack version. */
function packTitles(): (packId: string, version: number | null) => string {
  const titles = new Map<string, string>();
  return (packId, version) => {
    const key = `${packId}@${version ?? ''}`;
    if (!titles.has(key)) titles.set(key, (version && getRulePackVersion(packId, version)?.title) || packId);
    return titles.get(key)!;
  };
}

/** Rules with something to count, by pack title and then rule id. */
export function orderedRules<Rule extends { packTitle: string; ruleId: string }>(rules: Rule[]): Rule[] {
  return [...rules].sort(
    (left, right) =>
      (left.packTitle < right.packTitle ? -1 : left.packTitle > right.packTitle ? 1 : 0) ||
      (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0),
  );
}

async function findingCounts(client: PoolClient, tenantId: string, bounds: Bounds) {
  const rows = (
    await client.query<
      RuleRow & { opened: string; closed: string; open_at_end: string; proposed: string; relieved: string }
    >(
      `SELECT pack_id,leaf_id,(array_agg(rule_title ORDER BY opened_at DESC,id DESC))[1] AS rule_title,
         (array_agg(pack_version ORDER BY opened_at DESC,id DESC))[1] AS pack_version,
         count(*) FILTER (WHERE tab='counted' AND opened_at>=$2 AND opened_at<$3) AS opened,
         count(*) FILTER (WHERE tab='counted' AND closed_at>=$2 AND closed_at<$3) AS closed,
         count(*) FILTER (WHERE tab='counted' AND opened_at<$4 AND (status<>'resolved' OR closed_at>=$4)) AS open_at_end,
         count(*) FILTER (WHERE tab='proposed' AND opened_at>=$2 AND opened_at<$3) AS proposed,
         count(*) FILTER (WHERE tab='relieved' AND opened_at>=$2 AND opened_at<$3) AS relieved
       FROM (${findingRows} AND f.opened_at<$3) AS finding
       GROUP BY pack_id,leaf_id`,
      [tenantId, bounds.start, bounds.end, bounds.asOf],
    )
  ).rows;
  const packTitle = packTitles();
  const rules: ReportRuleCounts[] = rows
    .map((row) => ({
      packId: row.pack_id,
      packTitle: packTitle(row.pack_id, row.pack_version),
      ruleId: row.leaf_id,
      ruleTitle: row.rule_title ?? row.leaf_id,
      opened: Number(row.opened),
      closed: Number(row.closed),
      openAtEnd: Number(row.open_at_end),
    }))
    .filter((rule) => rule.opened + rule.closed + rule.openAtEnd > 0);
  const sum = (pick: (row: (typeof rows)[number]) => string) =>
    rows.reduce((total, row) => total + Number(pick(row)), 0);
  return {
    readable: true as const,
    rules: orderedRules(rules),
    total: {
      opened: rules.reduce((total, rule) => total + rule.opened, 0),
      closed: rules.reduce((total, rule) => total + rule.closed, 0),
      openAtEnd: rules.reduce((total, rule) => total + rule.openAtEnd, 0),
    },
    proposed: sum((row) => row.proposed),
    relieved: sum((row) => row.relieved),
  };
}

async function findingActionCounts(client: PoolClient, tenantId: string, bounds: Bounds) {
  const row = (
    await client.query<{ open: string; overdue: string }>(
      `SELECT count(*) AS open,count(*) FILTER (WHERE action_due_on<$3::date) AS overdue
       FROM (${findingRows}) AS finding
       WHERE tab='counted' AND action_due_on IS NOT NULL AND opened_at<$2
         AND (action_done_at IS NULL OR action_done_at>=$2) AND (closed_at IS NULL OR closed_at>=$2)
         AND EXISTS(SELECT 1 FROM finding_treatments t WHERE t.tenant_id=$1 AND t.finding_id=finding.id
           AND t.action='plan' AND t.recorded_at<$2)`,
      [tenantId, bounds.asOf, bounds.asOfDay],
    )
  ).rows[0]!;
  return { readable: true as const, open: Number(row.open), overdue: Number(row.overdue) };
}

/** The settled actions open at an instant, and of those the ones due before its day: set by then, not yet closed. */
export function actionsOpenAt(actions: readonly SettledAction[], asOf: Date, asOfDay: string) {
  const open = actions.filter(
    (entry) =>
      Date.parse(entry.setAt) < asOf.getTime() &&
      (!entry.closed || Date.parse(entry.closed.recordedAt) >= asOf.getTime()),
  );
  return { open: open.length, overdue: open.filter((entry) => entry.action.dueOn < asOfDay).length };
}

async function assuranceActionCounts(client: PoolClient, tenantId: string, bounds: Bounds) {
  const records = await client.query<{ id: string }>(
    `SELECT r.id FROM sms_records r WHERE r.tenant_id=$1 AND r.kind='assurance'
       AND EXISTS(SELECT 1 FROM decisions d WHERE d.tenant_id=r.tenant_id AND d.subject_id=r.id
         AND d.kind='assurance.sign' AND d.recorded_at<$2)
     ORDER BY r.id`,
    [tenantId, bounds.asOf],
  );
  const counts = { open: 0, overdue: 0 };
  for (const record of records.rows) {
    const signed = (await signedVersions(client, tenantId, record.id)).filter(
      (version) => Date.parse(version.signedAt) < bounds.asOf.getTime(),
    );
    const found = actionsOpenAt(
      settledActions(signed, await closedActions(client, tenantId, record.id)),
      bounds.asOf,
      bounds.asOfDay,
    );
    counts.open += found.open;
    counts.overdue += found.overdue;
  }
  return { readable: true as const, ...counts };
}

/** A hazard as it stood at an instant: whether a close was its latest close or reopening, and its latest assessment. */
export interface HazardAt {
  closed: boolean;
  level: string | null;
  /** The levels of the matrix version that assessment cites, least to most serious. */
  levels: { id: string; label: string }[];
}

/** Hazards open at an instant by level, least serious first, as the matrices that assessed them name the levels. */
export function hazardLevels(hazards: readonly HazardAt[]) {
  const open = hazards.filter((hazard) => !hazard.closed);
  const levels = new Map<string, { level: string; label: string; count: number; rank: number }>();
  for (const hazard of open) {
    if (!hazard.level) continue;
    const rank = hazard.levels.findIndex((entry) => entry.id === hazard.level);
    const label = hazard.levels[rank]?.label ?? hazard.level;
    const held = levels.get(hazard.level) ?? { level: hazard.level, label, count: 0, rank };
    held.count += 1;
    held.rank = Math.max(held.rank, rank);
    levels.set(hazard.level, held);
  }
  return {
    levels: [...levels.values()]
      .sort((left, right) => left.rank - right.rank || (left.level < right.level ? -1 : 1))
      .map(({ level, label, count }) => ({ level, label, count })),
    notAssessed: open.filter((hazard) => !hazard.level).length,
    total: open.length,
  };
}

async function hazardCounts(client: PoolClient, tenantId: string, bounds: Bounds) {
  const rows = await client.query<{
    closing: string | null;
    level: string | null;
    levels: { id: string; label: string }[] | null;
  }>(
    `SELECT closing.kind AS closing,assessed.level,
       (SELECT jsonb_agg(jsonb_build_object('id',l->>'id','label',l->>'label'))
        FROM sms_record_versions m,jsonb_array_elements(m.body->'levels') l
        WHERE m.tenant_id=r.tenant_id AND m.record_id=assessed.matrix_id AND m.version_number=assessed.matrix_version)
         AS levels
     FROM sms_records r
     LEFT JOIN LATERAL (SELECT d.kind FROM decisions d WHERE d.tenant_id=r.tenant_id AND d.subject_id=r.id
       AND d.kind IN ('record.close','record.reopen') AND d.recorded_at<$2
       ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) closing ON true
     LEFT JOIN LATERAL (SELECT d.record->'outcome'->'residual'->>'level' AS level,
         d.record->'outcome'->'matrix'->>'recordId' AS matrix_id,
         (d.record->'outcome'->'matrix'->>'versionNumber')::int AS matrix_version
       FROM decisions d WHERE d.tenant_id=r.tenant_id AND d.subject_id=r.id AND d.kind='risk.assess'
         AND d.recorded_at<$2 ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) assessed ON true
     WHERE r.tenant_id=$1 AND r.kind='hazard' AND r.opened_at<$2`,
    [tenantId, bounds.asOf],
  );
  return {
    readable: true as const,
    ...hazardLevels(
      rows.rows.map((row) => ({ closed: row.closing === 'record.close', level: row.level, levels: row.levels ?? [] })),
    ),
  };
}

/** GET /v1/reports/summary: one period's counts, each part the reader may read. */
export async function getPeriodSummary(
  client: PoolClient,
  principal: AuthContext,
  query: ReportPeriodQuery,
): Promise<PeriodSummary> {
  if (!has(principal, 'evidence:read') && !has(principal, 'sms:read'))
    throw new DomainError(403, 'capability_required', 'Reading a summary requires evidence:read or sms:read');
  checkPeriod(query);
  const tenantId = principal.tenantId;
  const bounds = await periodBounds(client, tenantId, query.from, query.until);
  const records = has(principal, 'evidence:read');
  const safety = has(principal, 'sms:read');
  return {
    period: {
      from: query.from,
      until: query.until,
      timeZone: bounds.zone,
      start: bounds.start.toISOString(),
      end: bounds.end.toISOString(),
      asOf: bounds.asOf.toISOString(),
      ended: bounds.end.getTime() <= bounds.now.getTime(),
    },
    flights: records ? await flightCounts(client, tenantId, bounds) : notReadable('evidence:read'),
    findings: records ? await findingCounts(client, tenantId, bounds) : notReadable('evidence:read'),
    findingActions: records ? await findingActionCounts(client, tenantId, bounds) : notReadable('evidence:read'),
    assuranceActions: safety ? await assuranceActionCounts(client, tenantId, bounds) : notReadable('sms:read'),
    hazards: safety ? await hazardCounts(client, tenantId, bounds) : notReadable('sms:read'),
    computedAt: bounds.now.toISOString(),
  };
}

/** GET /v1/reports/findings-by-month: counted findings opened and closed each month, by rule. */
export async function getFindingsByMonth(
  client: PoolClient,
  principal: AuthContext,
  query: FindingsByMonthQuery,
): Promise<FindingsByMonth> {
  requireEvidenceRead(principal);
  if (Boolean(query.from) !== Boolean(query.until))
    throw new DomainError(400, 'invalid_period', 'Give both the first and the last month, or neither');
  const zoned = (
    await client.query<{ zone: string; month: string; now: Date }>(
      `SELECT z.zone,to_char(clock_timestamp() AT TIME ZONE z.zone,'YYYY-MM') AS month,clock_timestamp() AS now
       FROM (SELECT COALESCE(time_zone,'UTC') AS zone FROM tenants WHERE id=$1) z`,
      [principal.tenantId],
    )
  ).rows[0]!;
  const until = query.until ?? zoned.month;
  const from = query.from ?? monthBefore(until, 11);
  if (until < from) throw new DomainError(400, 'invalid_period', 'The last month comes before the first');
  const months = monthsBetween(from, until);
  if (months.length > REPORT_LIMITS.findingMonths)
    throw new DomainError(
      400,
      'period_too_long',
      `Findings per month cover at most ${REPORT_LIMITS.findingMonths} months; choose a shorter period`,
    );
  const rows = (
    await client.query<RuleRow & { month: string; opened: string; closed: string }>(
      `WITH bounds AS (SELECT (($2||'-01')::date::timestamp AT TIME ZONE $4) AS start,
           ((($3||'-01')::date+interval '1 month')::timestamp AT TIME ZONE $4) AS stop),
         happened AS (
           SELECT pack_id,leaf_id,rule_title,pack_version,opened_at,id,'opened' AS what,opened_at AS at
           FROM (${findingRows}) AS finding,bounds WHERE tab='counted' AND opened_at>=bounds.start AND opened_at<bounds.stop
           UNION ALL
           SELECT pack_id,leaf_id,rule_title,pack_version,opened_at,id,'closed',closed_at
           FROM (${findingRows}) AS finding,bounds WHERE tab='counted' AND closed_at>=bounds.start AND closed_at<bounds.stop)
       SELECT pack_id,leaf_id,to_char(at AT TIME ZONE $4,'YYYY-MM') AS month,
         (array_agg(rule_title ORDER BY opened_at DESC,id DESC))[1] AS rule_title,
         (array_agg(pack_version ORDER BY opened_at DESC,id DESC))[1] AS pack_version,
         count(*) FILTER (WHERE what='opened') AS opened,count(*) FILTER (WHERE what='closed') AS closed
       FROM happened GROUP BY pack_id,leaf_id,month`,
      [principal.tenantId, from, until, zoned.zone],
    )
  ).rows;
  return {
    ...findingsByMonth(rows, months, packTitles()),
    period: { from, until, timeZone: zoned.zone },
    computedAt: zoned.now.toISOString(),
  };
}

/** Counts per rule and month, in the order of the months, with their totals. */
export function findingsByMonth(
  rows: readonly (RuleRow & { month: string; opened: string | number; closed: string | number })[],
  months: readonly string[],
  packTitle: (packId: string, version: number | null) => string,
): Omit<FindingsByMonth, 'period' | 'computedAt'> {
  const index = new Map(months.map((month, position) => [month, position]));
  const rules = new Map<string, FindingsByMonth['rules'][number]>();
  for (const row of rows) {
    const position = index.get(row.month);
    if (position === undefined) continue;
    const key = `${row.pack_id}\u0000${row.leaf_id}`;
    const rule = rules.get(key) ?? {
      packId: row.pack_id,
      packTitle: packTitle(row.pack_id, row.pack_version),
      ruleId: row.leaf_id,
      ruleTitle: row.rule_title ?? row.leaf_id,
      opened: months.map(() => 0),
      closed: months.map(() => 0),
    };
    rule.opened[position]! += Number(row.opened);
    rule.closed[position]! += Number(row.closed);
    rules.set(key, rule);
  }
  const listed = orderedRules([...rules.values()]);
  return {
    months: [...months],
    rules: listed,
    total: {
      opened: months.map((_, position) => listed.reduce((sum, rule) => sum + rule.opened[position]!, 0)),
      closed: months.map((_, position) => listed.reduce((sum, rule) => sum + rule.closed[position]!, 0)),
    },
  };
}

/** GET /v1/reports/indicators: each indicator with a recorded result. */
export async function listReportIndicators(client: PoolClient, principal: AuthContext): Promise<ReportIndicatorList> {
  requireEvidenceRead(principal);
  const rows = await client.query<{
    definition_id: string;
    definition_version: number;
    results: string;
    first_start: string;
    last_end: string;
  }>(
    `SELECT definition_id,definition_version,count(*) AS results,
       min((record#>>'{result,window,start}')::timestamptz) AS first_start,
       max((record#>>'{result,window,end}')::timestamptz) AS last_end
     FROM control_indicator_results WHERE tenant_id=$1 GROUP BY definition_id,definition_version`,
    [principal.tenantId],
  );
  const indicators = rows.rows.map((row) => ({
    id: row.definition_id,
    version: row.definition_version,
    title: findIndicatorDefinition(row.definition_id, row.definition_version)?.title ?? null,
    results: Number(row.results),
    firstWindowStart: new Date(row.first_start).toISOString(),
    lastWindowEnd: new Date(row.last_end).toISOString(),
  }));
  return {
    indicators: indicators.sort(
      (left, right) =>
        (left.title ?? left.id).localeCompare(right.title ?? right.id) ||
        left.id.localeCompare(right.id) ||
        left.version - right.version,
    ),
  };
}

/** GET /v1/reports/indicators/:indicatorId/versions/:version: every recorded result, by window. */
export async function getIndicatorHistory(
  client: PoolClient,
  principal: AuthContext,
  indicatorId: string,
  version: number,
): Promise<IndicatorHistory> {
  requireEvidenceRead(principal);
  const limit = REPORT_LIMITS.indicatorResults;
  const rows = await client.query<{ record: ControlIndicatorResultRecord; record_digest: string; now: Date }>(
    `SELECT record,record_digest,clock_timestamp() AS now FROM control_indicator_results
     WHERE tenant_id=$1 AND definition_id=$2 AND definition_version=$3 ORDER BY recorded_at DESC,id DESC LIMIT $4`,
    [principal.tenantId, indicatorId, version, limit + 1],
  );
  const listed = rows.rows.slice(0, limit);
  for (const row of listed)
    if (canonicalDigest(row.record) !== row.record_digest)
      throw new DomainError(500, 'retained_record_mismatch', 'A recorded indicator result does not match its digest');
  const definition = findIndicatorDefinition(indicatorId, version);
  if (!definition && !listed.length)
    throw new DomainError(
      404,
      'indicator_not_found',
      'No indicator with this id and version is registered or recorded',
    );
  return {
    definition: {
      id: indicatorId,
      version,
      title: definition?.title ?? null,
      description: definition?.description ?? null,
      unitLabel: definition?.unit.label ?? null,
      limit: definition?.limit ? { rate: definition.limit.rate, label: definition.limit.label } : null,
    },
    results: listed
      .map(({ record, record_digest: digest }) => ({
        id: record.id,
        digest,
        windowId: record.windowId,
        hazardId: record.control.hazardId,
        window: { start: record.result.window.start, end: record.result.window.end },
        recordedAt: record.recordedAt,
        recordedThrough: record.result.recordedThrough,
        status: record.result.status,
        eventCount: record.result.eventCount,
        exposure: { decimal: record.result.exposure.decimal, unit: record.result.exposure.unit },
        rate: record.result.rate ? { decimal: record.result.rate.decimal, label: record.result.rate.label } : null,
      }))
      .sort(
        (left, right) =>
          left.window.start.localeCompare(right.window.start) ||
          left.window.end.localeCompare(right.window.end) ||
          left.recordedAt.localeCompare(right.recordedAt) ||
          left.id.localeCompare(right.id),
      ),
    truncated: rows.rows.length > limit,
    computedAt: (rows.rows[0]?.now ?? new Date()).toISOString(),
  };
}
