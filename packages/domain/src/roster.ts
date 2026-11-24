import { getFlightPredepartureSummaries } from './flight-predeparture.js';
import type { FlightOperationSummary, FlightQuery, FlightSummary } from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { encodeHistoryCursor, historyCursor, historyPrecise } from './history.js';
import { dueRuleEvaluationWorkSql } from './rule-evaluations.js';
import { registerSubjectState, subjectStateRevision, type SubjectState } from './subject-state.js';

type Timestamp = Date | string | null;
interface FlightRow {
  id: string;
  label: string;
  origination_key: string;
  revision: string;
  basis_revision: string;
  activity: FlightSummary['activity'];
  coverage: FlightSummary['coverage'];
  aircraft: string | null;
  scheduled_start: Timestamp;
  scheduled_end: Timestamp;
  last_occurred_at: Timestamp;
  last_received_at: Timestamp;
  source_ids: string[];
  conflict_count: number;
  order_ids: string[];
  outstanding_work: string;
  unresolved_count: string;
  unresolved_received_at: Timestamp;
  authorization_status: string | null;
  authorization_at: Timestamp;
  authorization_received_at: Timestamp;
  departed_at: Timestamp;
  cancelled_order_at: Timestamp;
  cancelled_order_received_at: Timestamp;
  conflict_received_at: Timestamp;
  latitude: number | null;
  longitude: number | null;
  position_occurred_at: Timestamp;
  position_received_at: Timestamp;
  actor_name: string | null;
  decision_kind: string | null;
  decision_recorded_at: Timestamp;
  open_finding_count: number;
  unowned_finding_count: number;
  priority_finding_title: string | null;
  has_evaluations: boolean;
  page_time?: string;
  operation?: FlightOperationSummary;
}

// RLS keeps JSON key predicates above the receipt indexes, so project matching keys once.
const unresolvedInputs = `unresolved_inputs AS MATERIALIZED (
  SELECT r.id,r.source_id,r.occurred_at,r.received_at,
    r.input_subject->>'originationKey' AS origination_key,
    r.input_subject->>'externalFlightId' AS external_flight_id
  FROM receipts r WHERE r.tenant_id=current_setting('ledger.tenant_id',true)
    AND r.link_status IN ('unresolved','candidate')
    AND (r.input_subject->>'originationKey' IS NOT NULL OR r.input_subject->>'externalFlightId' IS NOT NULL)
)`;
const unresolvedReceipts = `SELECT r.id,r.received_at FROM unresolved_inputs r
  WHERE r.origination_key=f.origination_key
  UNION
  SELECT r.id,r.received_at FROM aliases a
  JOIN unresolved_inputs r ON r.source_id=a.source_id AND r.external_flight_id=a.external_id
  WHERE a.tenant_id=f.tenant_id AND a.subject_id=f.id
    AND (a.valid_from IS NULL OR a.valid_from<=r.occurred_at)
    AND (a.valid_to IS NULL OR a.valid_to>r.occurred_at)`;
const outstandingWorkInputs = `outstanding_work_inputs AS MATERIALIZED (
  SELECT r.flight_id AS receipt_flight_id,e.payload->>'flightId' AS event_flight_id
  FROM work_items w
  LEFT JOIN receipts r ON r.tenant_id=w.tenant_id AND r.event_id=w.event_id
  JOIN journal_events e ON e.tenant_id=w.tenant_id AND e.id=w.event_id
  WHERE w.tenant_id=current_setting('ledger.tenant_id',true) AND w.state<>'completed'
)`;
const currentClaim = `NOT EXISTS (SELECT 1 FROM claims replacement WHERE replacement.correction_of=c.id)`;
const adverseAuthorization = `c.kind='airspace.status'
  AND c.payload->>'status' IN ('STATUS_DENIED','STATUS_RESCINDED','STATUS_REVOKED')`;

// A flight's own evaluations, or the generic evaluator's about the flight (its subject key is ledger/flight/<id>).
const evaluated = `(EXISTS(SELECT 1 FROM flight_evaluations e WHERE e.flight_id=f.id)
  OR EXISTS(SELECT 1 FROM rule_evaluations r WHERE r.tenant_id=f.tenant_id AND r.subject_key='ledger/flight/'||f.id))`;
const terminalIssuesPredicate = `(f.open_finding_count>0 OR (
  (f.conflict_count>0 AND NOT ${evaluated} AND (
    d.kind IS DISTINCT FROM 'resolve' OR EXISTS (
      SELECT 1 FROM claims c LEFT JOIN receipts r ON r.id=c.receipt_id
      JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
      WHERE c.flight_id=f.id AND (c.payload ? 'landingTime' OR c.payload ? 'landedAt')
        AND ${currentClaim} AND COALESCE(r.received_at,e.received_at)>d.recorded_at
    )
  )) OR EXISTS (
    SELECT 1 FROM claims c LEFT JOIN receipts r ON r.id=c.receipt_id
    JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
    WHERE c.flight_id=f.id AND ${adverseAuthorization} AND ${currentClaim}
      AND (d.kind IS DISTINCT FROM 'resolve' OR COALESCE(r.received_at,e.received_at)>d.recorded_at)
  ) OR EXISTS (
    SELECT 1 FROM (${unresolvedReceipts}) r
      WHERE d.kind IS DISTINCT FROM 'resolve' OR r.received_at>d.recorded_at
  )
))`;

const requestedWindowValid = `(f.scheduled_start IS NULL OR f.scheduled_end IS NULL OR f.scheduled_start<f.scheduled_end)`;
const requestedWindowElapsed = `(${requestedWindowValid} AND f.scheduled_end<=clock.as_of)`;
const freshActive = `(f.activity='active' AND (
  (activity.activity='active' AND activity.occurred_at BETWEEN clock.as_of-interval '90 seconds' AND clock.as_of)
  OR recent_position.occurred_at BETWEEN clock.as_of-interval '90 seconds' AND clock.as_of
))`;

const operationJoins = `CROSS JOIN (SELECT statement_timestamp() AS as_of) clock
  LEFT JOIN LATERAL (
    SELECT kind,recorded_at FROM decisions
    WHERE tenant_id=f.tenant_id AND flight_id=f.id AND f.activity IN ('landed','cancelled')
    ORDER BY recorded_at DESC,id DESC LIMIT 1
  ) d ON true
  LEFT JOIN missions m ON m.tenant_id=f.tenant_id AND m.flight_id=f.id
  LEFT JOIN LATERAL (
    SELECT r.id,r.source_revision,r.record->'operatingInterval' AS operating_interval FROM mission_revisions r
    WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY r.source_revision DESC LIMIT 1
  ) accepted ON true
  LEFT JOIN work_items mission_work ON mission_work.tenant_id=m.tenant_id AND mission_work.event_id=accepted.id
  LEFT JOIN mission_projection_views mission_view ON mission_view.tenant_id=m.tenant_id AND mission_view.mission_id=m.id
  LEFT JOIN mission_revisions projected ON projected.tenant_id=m.tenant_id AND projected.id=mission_view.current_revision_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(c.payload->>'activity',c.payload->>'state',c.payload->>'phase') AS activity,
      c.occurred_at,COALESCE(r.received_at,e.received_at) AS received_at
    FROM claims c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
    LEFT JOIN receipts r ON r.tenant_id=c.tenant_id AND r.id=c.receipt_id
    WHERE c.tenant_id=f.tenant_id AND c.flight_id=f.id AND ${currentClaim}
      AND (c.receipt_id IS NULL OR r.flight_id=f.id)
      AND c.occurred_at<=clock.as_of
      AND COALESCE(c.payload->>'activity',c.payload->>'state',c.payload->>'phase') IN ('planned','active','landed','cancelled')
    ORDER BY c.occurred_at DESC NULLS LAST,COALESCE(c.source_revision,-1) DESC,c.id DESC LIMIT 1
  ) activity ON true
  LEFT JOIN LATERAL (
    SELECT s.occurred_at FROM telemetry_samples s
    JOIN telemetry_segments g ON g.tenant_id=s.tenant_id AND g.id=s.segment_id
    JOIN receipts r ON r.tenant_id=g.tenant_id AND r.id=g.receipt_id
    WHERE f.activity='active' AND r.tenant_id=f.tenant_id AND r.flight_id=f.id
      AND s.occurred_at BETWEEN clock.as_of-interval '90 seconds' AND clock.as_of
    ORDER BY s.occurred_at DESC,s.id DESC LIMIT 1
  ) recent_position ON true
  CROSS JOIN LATERAL (
    SELECT CASE WHEN accepted.id IS NULL THEN 'none'
      WHEN mission_work.state='completed' AND projected.id=accepted.id THEN 'current'
      WHEN mission_work.state='failed' THEN 'failed'
      WHEN mission_work.state='leased' THEN 'processing' ELSE 'pending' END AS state
  ) mission
  CROSS JOIN LATERAL (
    SELECT CASE WHEN mission.state='current' THEN jsonb_build_object('basis','mission',
        'start',accepted.operating_interval->>'start','end',accepted.operating_interval->>'end')
      WHEN mission.state='none' AND ${requestedWindowValid}
        AND (f.scheduled_start IS NOT NULL OR f.scheduled_end IS NOT NULL)
        THEN jsonb_strip_nulls(jsonb_build_object('basis','requested',
          'start',${historyPrecise('f.scheduled_start')},'end',${historyPrecise('f.scheduled_end')}))
      ELSE NULL END AS operating_window,
      CASE WHEN mission.state='current' THEN (accepted.operating_interval->>'end')::timestamptz
        WHEN mission.state='none' AND ${requestedWindowValid} THEN f.scheduled_end ELSE NULL END AS window_end
  ) planning
  CROSS JOIN LATERAL (
    SELECT CASE WHEN f.activity IN ('landed','cancelled')
        THEN CASE WHEN ${terminalIssuesPredicate} THEN 'historical-issues' ELSE 'history' END
      WHEN ${freshActive} THEN 'current'
      WHEN planning.window_end<=clock.as_of OR (mission.state NOT IN ('none','current') AND ${requestedWindowElapsed})
        THEN 'overdue' ELSE 'current' END AS scope,
      CASE WHEN f.activity IN ('landed','cancelled')
        THEN CASE WHEN ${terminalIssuesPredicate} THEN 'terminal-issues' ELSE 'terminal' END
      WHEN ${freshActive} THEN 'reported-active'
      WHEN mission.state NOT IN ('none','current') THEN 'plan-unconfirmed'
      WHEN planning.window_end<=clock.as_of
        THEN CASE WHEN f.activity='active' THEN 'status-unconfirmed' ELSE 'window-elapsed' END
      WHEN planning.window_end IS NULL THEN 'needs-planning' ELSE 'plan-window' END AS reason
  ) operation`;

const operationSummary = `jsonb_build_object('scope',operation.scope,'asOf',${historyPrecise('clock.as_of')},
  'reason',operation.reason,'window',planning.operating_window,
  'mission',jsonb_strip_nulls(jsonb_build_object('state',mission.state,
    'accepted',CASE WHEN accepted.id IS NOT NULL THEN jsonb_build_object('id',accepted.id,
      'sourceRevision',accepted.source_revision,'operatingInterval',accepted.operating_interval) END,
    'projected',CASE WHEN projected.id IS NOT NULL THEN jsonb_build_object('id',projected.id,
      'sourceRevision',projected.source_revision,'operatingInterval',projected.record->'operatingInterval') END)))
  || CASE WHEN recent_position.occurred_at IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('positionOccurredAt',${historyPrecise('recent_position.occurred_at')}) END
  || CASE WHEN activity.activity IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('activityReport',
    jsonb_build_object('activity',activity.activity,'occurredAt',${historyPrecise('activity.occurred_at')},
      'receivedAt',${historyPrecise('activity.received_at')})) END`;

export async function getFlights(client: PoolClient, who: AuthContext, query: FlightQuery = {}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(query.limit ?? 100)) || 100));
  const view = query.view === 'monitor' ? 'current' : (query.view ?? 'all');
  const search = query.search?.trim().slice(0, 200);
  const pattern = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null;
  if (view !== 'all') {
    const filters = { view, search: search || undefined };
    const activityScope =
      view === 'current' || view === 'overdue'
        ? "f.activity NOT IN ('landed','cancelled')"
        : "f.activity IN ('landed','cancelled')";
    const prior = historyCursor(query.cursor, who, 'flight-history', filters, true);
    const parameters: unknown[] = [who.tenantId, limit + 1, pattern, view];
    if (prior) parameters.push(prior.upper.time, prior.upper.id, prior.position.time, prior.position.id);
    const rows = await summaries(
      client,
      `SELECT f.*,${historyPrecise('f.created_at')} AS page_time,${operationSummary} AS operation
      FROM flight_views f ${operationJoins}
      WHERE f.tenant_id=$1 AND ${activityScope} AND operation.scope=$4
        AND ($3::text IS NULL OR f.id ILIKE $3 OR f.label ILIKE $3 OR f.aircraft ILIKE $3 OR EXISTS (
          SELECT 1 FROM fulfillments link WHERE link.flight_id=f.id AND link.order_external_id ILIKE $3
        ))
        ${
          prior
            ? `AND (f.created_at,f.id COLLATE "C")<=($5::timestamptz,$6::text COLLATE "C")
        AND (f.created_at,f.id COLLATE "C")<($7::timestamptz,$8::text COLLATE "C")`
            : ''
        }
      ORDER BY f.created_at DESC,f.id COLLATE "C" DESC LIMIT $2`,
      parameters,
      'created',
    );
    const visible = rows.slice(0, limit);
    return {
      flights: visible.map(flightSummary),
      nextCursor:
        rows.length > limit
          ? encodeHistoryCursor(
              who,
              'flight-history',
              filters,
              prior?.upper ?? creationPoint(visible[0]!),
              creationPoint(visible.at(-1)!),
            )
          : null,
    };
  }
  const rows = await summaries(
    client,
    `SELECT f.*,${operationSummary} AS operation FROM flight_views f ${operationJoins}
    WHERE ($1::text IS NULL OR f.id>$1)
      AND ($3::text IS NULL OR f.id ILIKE $3 OR f.label ILIKE $3 OR f.aircraft ILIKE $3 OR EXISTS (
        SELECT 1 FROM fulfillments link WHERE link.flight_id=f.id AND link.order_external_id ILIKE $3
      ))
    ORDER BY f.id LIMIT $2`,
    [query.cursor ?? null, limit + 1, pattern],
  );
  const flights = rows.slice(0, limit).map(flightSummary);
  return { flights, nextCursor: rows.length > limit ? flights.at(-1)!.id : null };
}

function creationPoint(row: FlightRow): { id: string; time: string } {
  if (!row.page_time)
    throw new DomainError(500, 'flight_history_unavailable', 'The retained flight creation time is unavailable.');
  return { id: row.id, time: row.page_time };
}

export async function getFlight(client: PoolClient, id: string): Promise<FlightSummary> {
  const rows = await summaries(
    client,
    `SELECT f.*,${operationSummary} AS operation FROM flight_views f ${operationJoins} WHERE f.id=$1`,
    [id],
  );
  if (!rows[0]) throw new DomainError(404, 'not_found', 'Record was not found within your scope');
  return flightSummary(rows[0]);
}

async function summaries(
  client: PoolClient,
  selection: string,
  parameters: unknown[],
  order: 'id' | 'created' = 'id',
): Promise<FlightRow[]> {
  const result = await client.query<FlightRow>(
    `WITH ${unresolvedInputs}, ${outstandingWorkInputs}, page AS MATERIALIZED (${selection})
    SELECT f.*,${evaluated} AS has_evaluations,
      CASE WHEN f.open_finding_count>0 THEN f.latest_finding_title END AS priority_finding_title,
      refs.order_ids, work.outstanding_work, unresolved.unresolved_count, unresolved.unresolved_received_at,
      auth.status AS authorization_status, auth.occurred_at AS authorization_at,
      auth.received_at AS authorization_received_at, dep.departed_at,
      cancel.updated_at AS cancelled_order_at, cancel.received_at AS cancelled_order_received_at,
      conflict.received_at AS conflict_received_at,
      pos.latitude,pos.longitude,pos.occurred_at AS position_occurred_at,pos.received_at AS position_received_at,
      decision.actor_name,decision.kind AS decision_kind,decision.recorded_at AS decision_recorded_at
    FROM page f
    LEFT JOIN LATERAL (
      SELECT COALESCE(array_agg(order_external_id ORDER BY order_external_id),'{}') AS order_ids
      FROM fulfillments WHERE flight_id=f.id
    ) refs ON true
    LEFT JOIN LATERAL (
      SELECT (SELECT COUNT(*) FROM outstanding_work_inputs w WHERE w.receipt_flight_id=f.id OR w.event_flight_id=f.id)
        -- Evaluations about the flight that are due count too; its subject key is ledger/flight/<id>.
        +${dueRuleEvaluationWorkSql(`'ledger/flight/'||f.id`)} AS outstanding_work
    ) work ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS unresolved_count,MAX(r.received_at) AS unresolved_received_at
      FROM (${unresolvedReceipts}) r
    ) unresolved ON true
    LEFT JOIN LATERAL (
      SELECT lower(regexp_replace(c.payload->>'status','^STATUS_','')) AS status,c.occurred_at,
        COALESCE(r.received_at,e.received_at) AS received_at
      FROM claims c LEFT JOIN receipts r ON r.id=c.receipt_id
      JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
      WHERE c.flight_id=f.id AND ${adverseAuthorization} AND ${currentClaim}
      ORDER BY c.occurred_at DESC NULLS LAST,c.id DESC LIMIT 1
    ) auth ON true
    LEFT JOIN LATERAL (
      SELECT MIN(c.occurred_at) AS departed_at FROM claims c
      WHERE c.flight_id=f.id AND c.kind='flight.observation' AND c.payload->>'activity'='active'
        AND ${currentClaim}
    ) dep ON true
    LEFT JOIN LATERAL (
      SELECT o.payload->>'updated_at' AS updated_at,r.received_at
      FROM fulfillments f2
      JOIN operational_orders o ON o.source_id=f2.source_id AND o.external_id=f2.order_external_id
      LEFT JOIN receipts r ON r.event_id=o.event_id
      WHERE f2.flight_id=f.id AND o.status='cancelled' ORDER BY o.revision DESC LIMIT 1
    ) cancel ON true
    LEFT JOIN LATERAL (
      SELECT MAX(COALESCE(r.received_at,e.received_at)) AS received_at
      FROM claims c LEFT JOIN receipts r ON r.id=c.receipt_id
      JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
      WHERE c.flight_id=f.id AND (c.payload ? 'landingTime' OR c.payload ? 'landedAt') AND ${currentClaim}
    ) conflict ON true
    LEFT JOIN LATERAL (
      SELECT ST_Y(s.position::geometry) AS latitude,ST_X(s.position::geometry) AS longitude,s.occurred_at,s.received_at
      FROM telemetry_samples s
      JOIN telemetry_segments g ON g.tenant_id=s.tenant_id AND g.id=s.segment_id
      JOIN receipts r ON r.tenant_id=g.tenant_id AND r.id=g.receipt_id
      WHERE r.flight_id=f.id ORDER BY s.occurred_at DESC,s.id DESC LIMIT 1
    ) pos ON true
    LEFT JOIN LATERAL (
      SELECT p.name AS actor_name,d.kind,d.recorded_at FROM decisions d JOIN principals p ON p.id=d.actor_id
      WHERE d.flight_id=f.id ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1
    ) decision ON true
    ORDER BY ${order === 'created' ? 'f.created_at DESC,f.id COLLATE "C" DESC' : 'f.id'}`,
    parameters,
  );
  const predeparture = await getFlightPredepartureSummaries(
    client,
    result.rows.map((row) => row.id),
  );
  for (const row of result.rows) {
    const status = predeparture.get(row.id);
    if (row.operation && status) row.operation.predeparture = status;
  }
  return result.rows;
}

function iso(value: Timestamp | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function flightSummary(row: FlightRow): FlightSummary {
  const authorization = ['denied', 'rescinded', 'revoked'].includes(row.authorization_status ?? '')
    ? (row.authorization_status as 'denied' | 'rescinded' | 'revoked')
    : undefined;
  const latitude = row.latitude == null ? undefined : Number(row.latitude);
  const longitude = row.longitude == null ? undefined : Number(row.longitude);
  const positionOccurredAt = iso(row.position_occurred_at);
  const positionReceivedAt = iso(row.position_received_at);
  const authorizationAt = iso(row.authorization_at);
  const authorizationReceivedAt = iso(row.authorization_received_at);
  const departedAt = iso(row.departed_at);
  const cancelledOrderReceivedAt = iso(row.cancelled_order_received_at);
  const cancelledOrderAt = iso(row.cancelled_order_at) ?? cancelledOrderReceivedAt;
  const conflictReceivedAt = iso(row.conflict_received_at);
  const unresolvedReceivedAt = iso(row.unresolved_received_at);
  const decisionRecordedAt = iso(row.decision_recorded_at);
  return {
    id: row.id,
    label: row.label,
    originationKey: row.origination_key,
    revision: Number(row.revision),
    basisRevision: Number(row.basis_revision),
    ...(row.operation ? { operation: row.operation } : {}),
    activity: row.activity,
    coverage: row.coverage,
    ...(row.aircraft ? { aircraft: row.aircraft } : {}),
    ...(row.scheduled_start ? { scheduledStart: iso(row.scheduled_start) } : {}),
    ...(row.scheduled_end ? { scheduledEnd: iso(row.scheduled_end) } : {}),
    ...(row.last_occurred_at ? { lastOccurredAt: iso(row.last_occurred_at) } : {}),
    ...(row.last_received_at ? { lastReceivedAt: iso(row.last_received_at) } : {}),
    orderIds: row.order_ids,
    sourceIds: row.source_ids,
    unresolvedCount: Number(row.unresolved_count),
    conflictCount: Number(row.conflict_count),
    outstandingWork: Number(row.outstanding_work),
    ...(row.has_evaluations
      ? {
          findingSummary: {
            openCount: row.open_finding_count,
            unownedCount: row.unowned_finding_count,
            ...(row.priority_finding_title ? { latestTitle: row.priority_finding_title } : {}),
          },
        }
      : {}),
    picture: {
      ...(authorization ? { authorization } : {}),
      ...(authorizationAt ? { authorizationAt } : {}),
      ...(authorizationReceivedAt ? { authorizationReceivedAt } : {}),
      ...(departedAt ? { departedAt } : {}),
      ...(cancelledOrderAt ? { cancelledOrderAt } : {}),
      ...(cancelledOrderReceivedAt ? { cancelledOrderReceivedAt } : {}),
      ...(conflictReceivedAt ? { conflictReceivedAt } : {}),
      ...(unresolvedReceivedAt ? { unresolvedReceivedAt } : {}),
      ...(latitude != null &&
      longitude != null &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      positionOccurredAt &&
      positionReceivedAt
        ? { lastPosition: { latitude, longitude, occurredAt: positionOccurredAt, receivedAt: positionReceivedAt } }
        : {}),
      ...(row.decision_kind && decisionRecordedAt
        ? {
            latestDecision: {
              actorName: String(row.actor_name),
              kind: row.decision_kind,
              recordedAt: decisionRecordedAt,
            },
          }
        : {}),
    },
  };
}

/**
 * A flight's state as rules read it: generic facts only, its status and its declared times, the scheduled end
 * being the deadline the flight declares. flight_views keeps only the current state, so this cannot read the flight
 * as of an earlier evidence cut: a replay at such a cut would read the flight as it is now. Each evaluation records
 * the state content it read, and that recorded content is the authority for what the evaluation read.
 */
async function flightState(client: PoolClient, flightId: string): Promise<SubjectState | undefined> {
  const row = (
    await client.query<{ activity: string; scheduled_start: Date | null; scheduled_end: Date | null }>(
      'SELECT activity,scheduled_start,scheduled_end FROM flight_views WHERE id=$1',
      [flightId],
    )
  ).rows[0];
  if (!row) return undefined;
  const state = {
    status: row.activity,
    ...(row.scheduled_start ? { scheduledStart: row.scheduled_start.toISOString() } : {}),
    ...(row.scheduled_end ? { scheduledEnd: row.scheduled_end.toISOString() } : {}),
  };
  return { revision: subjectStateRevision(state), state };
}

registerSubjectState('flight', flightState);
