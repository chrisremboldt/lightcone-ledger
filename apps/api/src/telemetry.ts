import type {
  TelemetryQuery,
  TelemetryGap,
  TelemetryResponse,
  TelemetrySampleView,
  TelemetrySessionView,
  TelemetrySegmentView,
  TelemetrySegmentDescriptor,
  FlightWatchMessage,
} from '@ledger/contracts';
import { canonicalize } from '@ledger/integrity';
import { DomainError, LIVE_RETAINED_NOTICES, type AuthContext, type PoolClient } from '@ledger/persistence';
import { requireRow, responseMeta } from '@ledger/domain';

interface SampleRow {
  id: string;
  session_id: string;
  segment_id: string;
  receipt_id: string;
  event_id: string;
  artifact_id: string;
  source_id: string;
  source_session_id: string;
  device_id: string;
  sample_offset: number;
  received_at: Date;
  original_sha256: string;
  conflict: boolean;
  sample: Pick<
    TelemetrySampleView,
    | 'sequence'
    | 'occurredAt'
    | 'latitude'
    | 'longitude'
    | 'altitudeMeters'
    | 'altitudeReference'
    | 'speedMetersPerSecond'
    | 'original'
  >;
}
interface SessionRow {
  session_id: string;
  source_id: string;
  source_session_id: string;
  device_id: string;
  start: string;
  last_received: Date;
}
interface SequenceRow {
  highest: string | null;
  duplicates: string;
  conflicts: string;
  gap_count: string;
  missing: string;
}
interface RangeRow {
  first: string;
  last: string;
}
interface SegmentRow {
  id: string;
  receipt_id: string;
  event_id: string;
  artifact_id: string;
  source_id: string;
  source_session_id: string;
  device_id: string;
  received_at: Date;
  descriptor: TelemetrySegmentDescriptor;
  state: string;
  attempts: number;
  error: string | null;
}
interface Cursor {
  v: 1;
  t: string;
  p: string;
  r: number;
  f: string;
  n: number;
}
export function liveCursor(principal: AuthContext, flightId: string, sequence: number): string {
  return Buffer.from(
    canonicalize({ v: 1, t: principal.tenantId, p: principal.id, r: principal.revision, f: flightId, n: sequence }),
  ).toString('base64url');
}
export function parseLiveCursor(value: string): Cursor {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new DomainError(400, 'invalid_cursor', 'Watch cursor is malformed');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8'),
      cursor = JSON.parse(decoded);
    if (
      Buffer.from(decoded).toString('base64url') !== value ||
      canonicalize(cursor) !== decoded ||
      Object.keys(cursor).sort().join(',') !== 'f,n,p,r,t,v' ||
      cursor.v !== 1 ||
      ![cursor.t, cursor.p, cursor.f].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200) ||
      !Number.isSafeInteger(cursor.r) ||
      cursor.r < 1 ||
      !Number.isSafeInteger(cursor.n) ||
      cursor.n < 0
    )
      throw new Error();
    return cursor;
  } catch {
    throw new DomainError(400, 'invalid_cursor', 'Watch cursor is malformed');
  }
}
async function head(client: PoolClient, flightId: string): Promise<number> {
  return Number(
    (await client.query('SELECT sequence FROM flight_live_heads WHERE flight_id=$1', [flightId])).rows[0]?.sequence ??
      0,
  );
}
const joined = `FROM telemetry_samples s JOIN telemetry_segments g ON g.tenant_id=s.tenant_id AND g.id=s.segment_id JOIN receipts r ON r.tenant_id=g.tenant_id AND r.id=g.receipt_id`;
function sample(row: SampleRow): TelemetrySampleView {
  return {
    ...row.sample,
    id: row.id,
    segmentId: row.segment_id,
    receiptId: row.receipt_id,
    eventId: row.event_id,
    artifactId: row.artifact_id,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    deviceId: row.device_id,
    sampleOffset: row.sample_offset,
    receivedAt: row.received_at.toISOString(),
    originalSha256: row.original_sha256,
    durable: true,
    conflict: row.conflict,
  };
}
const select = `SELECT s.*,g.receipt_id,g.event_id,g.artifact_id,g.source_id,g.source_session_id,g.device_id,EXISTS(SELECT 1 FROM telemetry_samples c JOIN telemetry_segments cg ON cg.tenant_id=c.tenant_id AND cg.id=c.segment_id JOIN receipts cr ON cr.id=cg.receipt_id AND cr.tenant_id=cg.tenant_id WHERE c.session_id=s.session_id AND c.sequence=s.sequence AND c.claim_digest<>s.claim_digest AND cr.flight_id=r.flight_id) AS conflict`;

export function telemetryOccurrenceWindow(query: TelemetryQuery) {
  const around = Date.parse(query.around ?? '');
  const seconds = query.windowSeconds ?? 60;
  if (!Number.isFinite(around) || !Number.isInteger(seconds) || seconds < 1 || seconds > 300)
    throw new DomainError(
      400,
      'invalid_telemetry_window',
      'Historical telemetry needs an occurrence time and a window from 1 to 300 seconds.',
    );
  return {
    around: new Date(around).toISOString(),
    from: new Date(around - seconds * 1000).toISOString(),
    until: new Date(around + seconds * 1000).toISOString(),
  };
}

async function historicalTelemetrySnapshot(
  client: PoolClient,
  who: AuthContext,
  flightId: string,
  requestId: string,
  query: TelemetryQuery,
): Promise<TelemetryResponse> {
  const occurrence = telemetryOccurrenceWindow(query);
  await client.query("SELECT set_config('statement_timeout','5000',true)");
  const flight = await requireRow(client, 'flight_views', flightId);
  const sessionRows = (
    await client.query<SessionRow>(
      `SELECT g.session_id,g.source_id,g.source_session_id,g.device_id,MIN((g.descriptor->>'sessionStartSequence')::bigint) AS start,MAX(g.received_at) AS last_received FROM telemetry_segments g JOIN receipts r ON r.tenant_id=g.tenant_id AND r.id=g.receipt_id WHERE r.flight_id=$1 AND (g.descriptor->>'lastOccurredAt')::timestamptz >= $2::timestamptz AND (g.descriptor->>'firstOccurredAt')::timestamptz <= $3::timestamptz GROUP BY g.session_id,g.source_id,g.source_session_id,g.device_id ORDER BY g.session_id LIMIT 17`,
      [flightId, occurrence.from, occurrence.until],
    )
  ).rows;
  const sessionIds = sessionRows.slice(0, 16).map((row) => row.session_id);
  const sampleRows = (
    await client.query<SampleRow>(
      `WITH unique_claims AS (SELECT DISTINCT ON(s.session_id,s.sequence,s.claim_digest) s.id ${joined} WHERE r.flight_id=$1 AND s.session_id=ANY($2::text[]) AND s.occurred_at BETWEEN $3::timestamptz AND $4::timestamptz ORDER BY s.session_id,s.sequence,s.claim_digest,s.received_at,s.id) ${select} ${joined} JOIN unique_claims u ON u.id=s.id ORDER BY s.occurred_at,s.id LIMIT 241`,
      [flightId, sessionIds, occurrence.from, occurrence.until],
    )
  ).rows;
  let truncated = sessionRows.length > 16 || sampleRows.length > 240;
  const sessions: TelemetrySessionView[] = [];
  const gaps: TelemetryGap[] = [];
  for (const session of sessionRows.slice(0, 16)) {
    const sequenceRows = (
      await client.query<SequenceRow>(
        `WITH positions AS (SELECT s.sequence,COUNT(*) AS copies,COUNT(DISTINCT s.claim_digest) AS claims ${joined} WHERE r.flight_id=$1 AND s.session_id=$2 AND s.occurred_at BETWEEN $3::timestamptz AND $4::timestamptz GROUP BY s.sequence), ranges AS (SELECT LAG(sequence) OVER(ORDER BY sequence)+1 AS first,sequence-1 AS last FROM positions) SELECT (SELECT MAX(sequence) FROM positions) AS highest,(SELECT COALESCE(SUM(copies-claims),0) FROM positions) AS duplicates,(SELECT COUNT(*) FROM positions WHERE claims>1) AS conflicts,(SELECT COUNT(*) FROM ranges WHERE last>=first) AS gap_count,(SELECT COALESCE(SUM(last-first+1),0) FROM ranges WHERE last>=first) AS missing`,
        [flightId, session.session_id, occurrence.from, occurrence.until],
      )
    ).rows[0];
    const retained = sampleRows.slice(0, 240).filter((row) => row.session_id === session.session_id);
    sessions.push({
      id: session.session_id,
      sourceId: session.source_id,
      sourceSessionId: session.source_session_id,
      deviceId: session.device_id,
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: Number(session.start),
      highestSequence: Number(sequenceRows.highest ?? session.start),
      latestSample: retained.length ? sample(retained[retained.length - 1]!) : null,
      lastReceivedAt: session.last_received.toISOString(),
      gapCount: Number(sequenceRows.gap_count),
      missingSequenceCount: Number(sequenceRows.missing),
      duplicateCount: Number(sequenceRows.duplicates),
      conflictCount: Number(sequenceRows.conflicts),
    });
    const rangeRows = (
      await client.query<RangeRow>(
        `WITH positions AS (SELECT DISTINCT s.sequence ${joined} WHERE r.flight_id=$1 AND s.session_id=$2 AND s.occurred_at BETWEEN $3::timestamptz AND $4::timestamptz), ranges AS (SELECT LAG(sequence) OVER(ORDER BY sequence)+1 AS first,sequence-1 AS last FROM positions) SELECT first,last FROM ranges WHERE last>=first ORDER BY first LIMIT $5`,
        [flightId, session.session_id, occurrence.from, occurrence.until, Math.max(1, 129 - gaps.length)],
      )
    ).rows;
    if (rangeRows.length > 128 - gaps.length) truncated = true;
    for (const range of rangeRows.slice(0, 128 - gaps.length))
      gaps.push({
        sessionId: session.session_id,
        sourceId: session.source_id,
        sourceSessionId: session.source_session_id,
        deviceId: session.device_id,
        fromSequence: Number(range.first),
        toSequence: Number(range.last),
      });
  }
  const rows = (
    await client.query<SegmentRow>(
      `SELECT g.*,w.state,w.attempts,w.error FROM telemetry_segments g JOIN receipts r ON r.id=g.receipt_id AND r.tenant_id=g.tenant_id JOIN work_items w ON w.event_id=g.event_id AND w.tenant_id=g.tenant_id WHERE r.flight_id=$1 AND (g.descriptor->>'lastOccurredAt')::timestamptz >= $2::timestamptz AND (g.descriptor->>'firstOccurredAt')::timestamptz <= $3::timestamptz ORDER BY g.received_at,g.id LIMIT 21`,
      [flightId, occurrence.from, occurrence.until],
    )
  ).rows;
  if (rows.length > 20) truncated = true;
  const segments: TelemetrySegmentView[] = rows.slice(0, 20).map((row) => ({
    id: row.id,
    receiptId: row.receipt_id,
    eventId: row.event_id,
    artifactId: row.artifact_id,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    deviceId: row.device_id,
    sampleCount: row.descriptor.sampleCount,
    firstSequence: row.descriptor.firstSequence,
    lastSequence: row.descriptor.lastSequence,
    firstOccurredAt: row.descriptor.firstOccurredAt,
    lastOccurredAt: row.descriptor.lastOccurredAt,
    receivedAt: row.received_at.toISOString(),
    processing: {
      status:
        row.state === 'leased'
          ? 'processing'
          : row.state === 'completed'
            ? 'completed'
            : row.state === 'failed'
              ? 'failed'
              : 'pending',
      attempts: row.attempts,
      ...(row.error ? { error: row.error } : {}),
    },
  }));
  return {
    flightId,
    flightRevision: Number(flight.revision),
    status: 'durable_only',
    samples: sampleRows.slice(0, 240).map(sample),
    sessions,
    segments,
    gaps,
    cursor: liveCursor(who, flightId, await head(client, flightId)),
    window: { sampleLimit: 240, sessionLimit: 16, segmentLimit: 20, gapLimit: 128, truncated, occurrence },
    meta: await responseMeta(client, requestId, who, undefined, flightId),
  };
}

export async function telemetrySnapshot(
  client: PoolClient,
  who: AuthContext,
  flightId: string,
  requestId: string,
  query: TelemetryQuery = {},
): Promise<TelemetryResponse> {
  if (query.around !== undefined || query.windowSeconds !== undefined)
    return historicalTelemetrySnapshot(client, who, flightId, requestId, query);
  await client.query("SELECT set_config('statement_timeout','5000',true)");
  const flight = await requireRow(client, 'flight_views', flightId);
  const sessionRows = (
    await client.query<SessionRow>(
      `SELECT g.session_id,g.source_id,g.source_session_id,g.device_id,MIN((g.descriptor->>'sessionStartSequence')::bigint) AS start,MAX(g.received_at) AS last_received FROM telemetry_segments g JOIN receipts r ON r.tenant_id=g.tenant_id AND r.id=g.receipt_id WHERE r.flight_id=$1 GROUP BY g.session_id,g.source_id,g.source_session_id,g.device_id ORDER BY last_received DESC,g.session_id LIMIT 17`,
      [flightId],
    )
  ).rows;
  const sessions: TelemetrySessionView[] = [],
    gaps: TelemetryGap[] = [];
  let truncated = sessionRows.length > 16;
  const sessionIds = sessionRows.slice(0, 16).map((row) => row.session_id);
  const samplesRows = (
    await client.query<SampleRow>(
      `WITH unique_claims AS (SELECT DISTINCT ON(s.session_id,s.sequence,s.claim_digest) s.id ${joined} WHERE r.flight_id=$1 AND s.session_id=ANY($2::text[]) ORDER BY s.session_id,s.sequence,s.claim_digest,s.received_at,s.id) ${select} ${joined} JOIN unique_claims u ON u.id=s.id ORDER BY s.occurred_at DESC,s.id DESC LIMIT 241`,
      [flightId, sessionIds],
    )
  ).rows;
  if (samplesRows.length > 240) truncated = true;
  for (const session of sessionRows.slice(0, 16)) {
    const sequenceRows = await client.query<SequenceRow>(
      `WITH positions AS (SELECT s.sequence,COUNT(*) AS copies,COUNT(DISTINCT s.claim_digest) AS claims ${joined} WHERE r.flight_id=$1 AND s.session_id=$2 GROUP BY s.sequence),gaps AS (SELECT COALESCE(LAG(sequence) OVER(ORDER BY sequence),$3::bigint-1)+1 AS first,sequence-1 AS last FROM positions) SELECT (SELECT MAX(sequence) FROM positions) AS highest,(SELECT COALESCE(SUM(copies-claims),0) FROM positions) AS duplicates,(SELECT COUNT(*) FROM positions WHERE claims>1) AS conflicts,(SELECT COUNT(*) FROM gaps WHERE last>=first) AS gap_count,(SELECT COALESCE(SUM(last-first+1),0) FROM gaps WHERE last>=first) AS missing`,
      [flightId, session.session_id, session.start],
    );
    const stats = sequenceRows.rows[0];
    const latest = (
      await client.query<SampleRow>(
        `${select} ${joined} WHERE r.flight_id=$1 AND s.session_id=$2 ORDER BY s.occurred_at DESC,s.id DESC LIMIT 1`,
        [flightId, session.session_id],
      )
    ).rows[0];
    sessions.push({
      id: session.session_id,
      sourceId: session.source_id,
      sourceSessionId: session.source_session_id,
      deviceId: session.device_id,
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: Number(session.start),
      highestSequence: Number(stats.highest ?? session.start),
      latestSample: latest ? sample(latest) : null,
      lastReceivedAt: session.last_received.toISOString(),
      gapCount: Number(stats.gap_count),
      missingSequenceCount: Number(stats.missing),
      duplicateCount: Number(stats.duplicates),
      conflictCount: Number(stats.conflicts),
    });
    if (gaps.length < 128) {
      const ranges = (
        await client.query<RangeRow>(
          `WITH positions AS (SELECT DISTINCT s.sequence ${joined} WHERE r.flight_id=$1 AND s.session_id=$2),ranges AS (SELECT COALESCE(LAG(sequence) OVER(ORDER BY sequence),$3::bigint-1)+1 AS first,sequence-1 AS last FROM positions) SELECT first,last FROM ranges WHERE last>=first ORDER BY first LIMIT $4`,
          [flightId, session.session_id, session.start, 129 - gaps.length],
        )
      ).rows;
      for (const range of ranges.slice(0, 128 - gaps.length))
        gaps.push({
          sessionId: session.session_id,
          sourceId: session.source_id,
          sourceSessionId: session.source_session_id,
          deviceId: session.device_id,
          fromSequence: Number(range.first),
          toSequence: Number(range.last),
        });
    }
    if (sessions.reduce((n, s) => n + s.gapCount, 0) > 128) truncated = true;
  }
  const rows = (
    await client.query<SegmentRow>(
      `SELECT g.*,w.state,w.attempts,w.error FROM telemetry_segments g JOIN receipts r ON r.id=g.receipt_id AND r.tenant_id=g.tenant_id JOIN work_items w ON w.event_id=g.event_id AND w.tenant_id=g.tenant_id WHERE r.flight_id=$1 ORDER BY g.received_at DESC,g.id DESC LIMIT 21`,
      [flightId],
    )
  ).rows;
  if (rows.length > 20) truncated = true;
  const segments: TelemetrySegmentView[] = rows.slice(0, 20).map((row) => ({
    id: row.id,
    receiptId: row.receipt_id,
    eventId: row.event_id,
    artifactId: row.artifact_id,
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    deviceId: row.device_id,
    sampleCount: row.descriptor.sampleCount,
    firstSequence: row.descriptor.firstSequence,
    lastSequence: row.descriptor.lastSequence,
    firstOccurredAt: row.descriptor.firstOccurredAt,
    lastOccurredAt: row.descriptor.lastOccurredAt,
    receivedAt: row.received_at.toISOString(),
    processing: {
      status:
        row.state === 'leased'
          ? 'processing'
          : row.state === 'completed'
            ? 'completed'
            : row.state === 'failed'
              ? 'failed'
              : 'pending',
      attempts: row.attempts,
      ...(row.error ? { error: row.error } : {}),
    },
  }));
  return {
    flightId,
    flightRevision: Number(flight.revision),
    status: 'durable_only',
    samples: samplesRows.slice(0, 240).map(sample),
    sessions,
    segments,
    gaps,
    cursor: liveCursor(who, flightId, await head(client, flightId)),
    window: { sampleLimit: 240, sessionLimit: 16, segmentLimit: 20, gapLimit: 128, truncated },
    meta: await responseMeta(client, requestId, who, undefined, flightId),
  };
}
export async function liveChanges(
  client: PoolClient,
  who: AuthContext,
  flightId: string,
  cursor: Cursor,
): Promise<FlightWatchMessage[]> {
  await client.query("SELECT set_config('statement_timeout','5000',true)");
  await requireRow(client, 'flight_views', flightId);
  if (cursor.t !== who.tenantId || cursor.p !== who.id || cursor.f !== flightId || cursor.r !== who.revision)
    return [{ type: 'resync_required', flightId, reason: 'scope_changed' }];
  const current = await head(client, flightId);
  if (cursor.n > current || cursor.n < Math.max(0, current - LIVE_RETAINED_NOTICES))
    return [{ type: 'resync_required', flightId, reason: 'expired_cursor' }];
  if (current - cursor.n > 128) return [{ type: 'resync_required', flightId, reason: 'backlog' }];
  const rows = (
    await client.query(
      'SELECT * FROM flight_live_changes WHERE flight_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 128',
      [flightId, cursor.n],
    )
  ).rows;
  return rows.map((row) => ({
    type: row.type,
    flightId,
    revision: Number(row.sequence),
    cursor: liveCursor(who, flightId, Number(row.sequence)),
    eventId: row.event_id,
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
  }));
}
