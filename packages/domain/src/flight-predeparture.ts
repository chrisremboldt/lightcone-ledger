import { randomUUID } from 'node:crypto';
import {
  FLIGHT_PREDEPARTURE_EVENT,
  FLIGHT_PREDEPARTURE_LIMITS as limits,
  type FlightPredepartureConfig,
  type FlightPredepartureSource,
  type FlightPredepartureProgress,
  type FlightPredepartureProgressRecord,
  type FlightPredepartureProgressResponse,
  type FlightPredepartureResponse,
  type FlightPredepartureSummary,
  type MissionRevisionRecord,
  type MissionReleaseRecord,
  type MissionBriefingRecord,
  type MissionDeparturePermit,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type PoolClient, type JournalEvent } from '@ledger/persistence';
import { getFlightMission } from './missions.js';
import { getMissionReleaseValidity } from './mission-release.js';
import { briefingCovers, uncoveredCandidates } from './briefing-coverage.js';
import { briefingLapsed, briefingStandings } from './briefing-standing.js';

const streamName = (flightId: string) => `flight:predeparture:${flightId}`;
const same = (left: unknown, right: unknown) =>
  left === undefined || right === undefined ? left === right : canonicalDigest(left) === canonicalDigest(right);
const terminal = (phase: string) => ['departed', 'cancelled'].includes(phase);
const conflict = (message: string): never => {
  throw new DomainError(409, 'predeparture_reference_invalid', message);
};
const missionReference = (mission: MissionRevisionRecord) => ({
  missionId: mission.missionId,
  eventId: mission.id,
  sourceRevision: mission.sourceRevision,
  contentDigest: mission.contentDigest,
  recordDigest: canonicalDigest(mission),
});
const processing = (state: string | null): FlightPredepartureSummary['processing'] =>
  state === 'leased' ? 'processing' : state === 'completed' || state === 'failed' ? state : 'pending';
const configuredSource = (config: FlightPredepartureConfig | undefined, tenantId: string) =>
  config?.tenants.find((row) => row.tenantId === tenantId)?.source;
const readAt = async (client: PoolClient) =>
  (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > limits.responseBytes)
    throw new DomainError(413, 'predeparture_response_too_large', 'The workflow exceeds its bounded read size');
  return value;
}
interface ProgressRow {
  payload: FlightPredepartureProgressResponse | null;
  bytes: number;
  state: string | null;
}
function checked(row: ProgressRow): FlightPredepartureProgressResponse {
  if (row.bytes > limits.recordBytes || !row.payload || canonicalDigest(row.payload.progress) !== row.payload.digest)
    conflict('The retained workflow commitment does not agree');
  return row.payload!;
}
async function flight(client: PoolClient, who: AuthContext, id: string) {
  const row = (
    await client.query<{ aircraft: string | null; origination_key: string; activity: string }>(
      'SELECT aircraft,origination_key,activity FROM flight_views WHERE tenant_id=$1 AND id=$2',
      [who.tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'flight_not_found', 'The flight was not found within your operator');
  return row;
}
async function latest(client: PoolClient, who: AuthContext, id: string): Promise<ProgressRow | undefined> {
  return (
    await client.query<ProgressRow>(
      `SELECT CASE WHEN octet_length(e.payload::text)<=$3 THEN e.payload END AS payload,octet_length(e.payload::text) AS bytes,w.state FROM streams s JOIN LATERAL(SELECT id,payload FROM journal_events e WHERE e.tenant_id=s.tenant_id AND e.stream_id=s.id ORDER BY e.stream_sequence DESC LIMIT 1)e ON true LEFT JOIN work_items w ON w.tenant_id=s.tenant_id AND w.event_id=e.id WHERE s.tenant_id=$1 AND s.name=$2`,
      [who.tenantId, streamName(id), limits.recordBytes],
    )
  ).rows[0];
}
async function completedRecord<T>(
  client: PoolClient,
  who: AuthContext,
  table: 'mission_revisions' | 'mission_releases' | 'mission_briefings',
  id: string,
): Promise<T> {
  const row = (
    await client.query<{ record: T | null; bytes: number; state: string; projected: boolean }>(
      `SELECT CASE WHEN octet_length(r.record::text)<=4194304 THEN r.record END AS record,octet_length(r.record::text) AS bytes,w.state,p.sequence>=e.stream_sequence AS projected FROM ${table} r JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.id LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.id LEFT JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id WHERE r.tenant_id=$1 AND r.id=$2`,
      [who.tenantId, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'predeparture_reference_not_found',
      'The exact referenced record was not found within your operator',
    );
  if (row.bytes > 4194304)
    throw new DomainError(413, 'predeparture_reference_too_large', 'The referenced record exceeds its read bound');
  if (row.state !== 'completed' || !row.projected)
    throw new DomainError(
      409,
      'predeparture_projection_pending',
      'Wait for the exact referenced record to finish projection',
    );
  return row.record!;
}
async function acknowledgementCounts(client: PoolClient, who: AuthContext, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = (
    await client.query<{ briefing_id: string; count: string }>(
      `SELECT a.briefing_id,COUNT(*)::text AS count FROM mission_briefing_acknowledgements a JOIN work_items w ON w.tenant_id=a.tenant_id AND w.event_id=a.id JOIN mission_briefing_acknowledgement_projection_views p ON p.tenant_id=a.tenant_id AND p.acknowledgement_id=a.id AND p.flight_id=a.flight_id WHERE a.tenant_id=$1 AND a.briefing_id=ANY($2::text[]) AND w.state='completed' GROUP BY a.briefing_id`,
      [who.tenantId, ids],
    )
  ).rows;
  return new Map(rows.map((row) => [row.briefing_id, Number(row.count)]));
}
export async function getFlightPredeparture(
  client: PoolClient,
  who: AuthContext,
  id: string,
  config?: FlightPredepartureConfig,
): Promise<FlightPredepartureResponse> {
  await flight(client, who, id);
  const row = await latest(client, who, id);
  const retained = row ? checked(row) : null;
  const current = await getFlightMission(client, who, id);
  const references = retained?.progress.references;
  const briefings = references?.briefings ?? [];
  const counts = await acknowledgementCounts(
    client,
    who,
    briefings.map((ref) => ref.briefing.id),
  );
  const populations = briefings.length
    ? (
        await client.query<{ id: string; recipients: number }>(
          `SELECT id,jsonb_array_length(record->'population'->'recipients') AS recipients FROM mission_briefings WHERE tenant_id=$1 AND flight_id=$2 AND id=ANY($3::text[])`,
          [who.tenantId, id, briefings.map((ref) => ref.briefing.id)],
        )
      ).rows
    : [];
  const standings = await briefingStandings(
    client,
    who.tenantId,
    id,
    briefings.map((ref) => ref.briefing.id),
  );
  return bounded({
    enabled: !!configuredSource(config, who.tenantId),
    flightId: id,
    progress: retained?.progress ?? null,
    digest: retained?.digest ?? null,
    processing: row ? processing(row.state) : null,
    readAt: await readAt(client),
    current: {
      acceptedMission: current.acceptedHead ? missionReference(current.acceptedHead.record) : null,
      projectedMission: current.projectedHead ? missionReference(current.projectedHead) : null,
      missionProcessing: current.acceptedHead?.processing.status ?? null,
      releaseValidity: references?.release
        ? await getMissionReleaseValidity(client, who, id, references.release.id, true)
        : null,
      briefings: briefings.map((ref) => ({
        ...ref,
        acknowledged: counts.get(ref.briefing.id) ?? 0,
        recipients: populations.find((row) => row.id === ref.briefing.id)!.recipients,
        standing: standings.get(ref.briefing.id)!,
      })),
    },
  });
}
export async function getFlightPredepartureProgress(
  client: PoolClient,
  who: AuthContext,
  flightId: string,
  eventId: string,
): Promise<FlightPredepartureProgressResponse> {
  await flight(client, who, flightId);
  const row = (
    await client.query<ProgressRow>(
      `SELECT CASE WHEN octet_length(payload::text)<=$4 THEN payload END AS payload,octet_length(payload::text) AS bytes,NULL::text AS state FROM command_records WHERE tenant_id=$1 AND id=$2 AND kind=$3`,
      [who.tenantId, eventId, FLIGHT_PREDEPARTURE_EVENT, limits.recordBytes],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'predeparture_progress_not_found',
      'The exact workflow acceptance was not found within your operator',
    );
  const value = checked(row);
  if (value.progress.flightId !== flightId) conflict('The original workflow acceptance belongs to another flight');
  return bounded(value);
}
export async function getFlightPredepartureSummaries(
  client: PoolClient,
  ids: string[],
): Promise<Map<string, FlightPredepartureSummary>> {
  if (!ids.length) return new Map();
  const rows = (
    await client.query<ProgressRow>(
      `SELECT CASE WHEN octet_length(e.payload::text)<=$2 THEN e.payload END AS payload,octet_length(e.payload::text) AS bytes,w.state FROM streams s JOIN LATERAL(SELECT id,payload FROM journal_events e WHERE e.tenant_id=s.tenant_id AND e.stream_id=s.id ORDER BY e.stream_sequence DESC LIMIT 1)e ON true LEFT JOIN work_items w ON w.tenant_id=s.tenant_id AND w.event_id=e.id WHERE s.tenant_id=current_setting('ledger.tenant_id') AND s.name=ANY($1::text[])`,
      [ids.map(streamName), limits.recordBytes],
    )
  ).rows;
  return new Map(
    rows.map((row) => {
      const { progress, digest } = checked(row);
      return [
        progress.flightId,
        {
          progress: { id: progress.id, digest },
          phase: progress.phase,
          code: progress.code,
          retryable: progress.retryable,
          needsHumanReview: progress.needsHumanReview,
          sourceObservedAt: progress.sourceObservedAt,
          recordedAt: progress.recordedAt,
          processing: processing(row.state),
        },
      ];
    }),
  );
}
async function validateReferences(
  client: PoolClient,
  who: AuthContext,
  flightId: string,
  source: FlightPredepartureSource,
  request: FlightPredepartureProgress,
  previous?: FlightPredepartureProgressRecord,
) {
  const { references: refs, execution } = request;
  const claimsReadiness = ['ready', 'departed'].includes(request.phase);
  if (previous) {
    if (!same(previous.source, source) || !same(previous.execution, execution))
      conflict('The exact source and execution identity cannot change');
    if (previous.needsHumanReview && !request.needsHumanReview)
      conflict('Human review remains required once this flight has been held for it');
    if (terminal(previous.phase))
      throw new DomainError(409, 'predeparture_terminal', 'The retained workflow is terminal');
    if (
      refs.mission.sourceRevision < previous.references.mission.sourceRevision ||
      (refs.mission.sourceRevision === previous.references.mission.sourceRevision &&
        !same(refs.mission, previous.references.mission))
    )
      conflict('The workflow cannot replace or move backwards from a retained mission');
    for (const key of ['permit', 'departureReceipt'] as const)
      if (previous.references[key] && !same(previous.references[key], refs[key]))
        conflict(`The retained ${key} cannot change`);
    if (
      (previous.references.permit || previous.phase === 'departure_unknown') &&
      (!same(previous.references.mission, refs.mission) ||
        !same(previous.references.release, refs.release) ||
        !same(previous.references.briefings, refs.briefings))
    )
      conflict('A possibly authorized departure retains its exact mission, release and briefings');
  }
  const selected = await flight(client, who, flightId);
  if (selected.aircraft !== execution.aircraftId || selected.origination_key !== execution.reservationId)
    conflict('The assigned flight does not match the exact source reservation and aircraft');
  const mission = await completedRecord<MissionRevisionRecord>(client, who, 'mission_revisions', refs.mission.eventId);
  if (
    !same(missionReference(mission), refs.mission) ||
    mission.flightId !== flightId ||
    mission.aircraftId !== execution.aircraftId ||
    mission.sourceMissionId !== execution.sourceMissionId ||
    mission.sourceId !== source.missionSourceId
  )
    conflict('The exact mission does not match this source, flight and aircraft');
  let release: MissionReleaseRecord | undefined;
  if (refs.release) {
    release = await completedRecord<MissionReleaseRecord>(client, who, 'mission_releases', refs.release.id);
    if (
      canonicalDigest(release) !== refs.release.digest ||
      release.flightId !== flightId ||
      !same(release.basis.avoidance.mission, refs.mission)
    )
      conflict('The release must retain this exact mission and flight');
    if (
      claimsReadiness &&
      (request.needsHumanReview
        ? release.actor.kind !== 'human'
        : release.actor.id !== source.automaticReleasePrincipalId ||
          !['source', 'service'].includes(release.actor.kind))
    )
      conflict('This path requires its actual human or configured autonomous service release');
  }
  const afterRelease = [
    'awaiting_briefing',
    'awaiting_acknowledgement',
    'ready',
    'departure_unknown',
    'departed',
  ].includes(request.phase);
  if (afterRelease && !release) conflict('This phase requires the exact recorded release');
  if (request.phase === 'ready') {
    if (!request.needsHumanReview) {
      const authority = (
        await client.query<{ kind: string; capabilities: string[] }>(
          'SELECT kind,capabilities FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
          [who.tenantId, source.automaticReleasePrincipalId],
        )
      ).rows[0];
      if (
        !authority ||
        !['source', 'service'].includes(authority.kind) ||
        !['flight:read', 'decision:write', 'mission:release'].every((capability) =>
          authority.capabilities.includes(capability),
        )
      )
        throw new DomainError(
          409,
          'predeparture_automatic_authority_unavailable',
          'The configured autonomous release principal lacks its actual active service authority',
        );
    }
    const validity = await getMissionReleaseValidity(client, who, flightId, release!.id);
    if (!['current', 'scheduled'].includes(validity.status))
      conflict('The exact release is not current or scheduled for this mission');
  }
  // One briefing may cover several controls, so several references may name it; each control is named once.
  if (new Set(refs.briefings.map((ref) => ref.controlEventId)).size !== refs.briefings.length)
    conflict('Each applicable control has at most one selected exact briefing');
  const briefingIds = [...new Set(refs.briefings.map((ref) => ref.briefing.id))];
  const counts = await acknowledgementCounts(client, who, briefingIds);
  // A briefing counts toward readiness only while it is in force, even when it was acknowledged in time.
  const standings =
    request.phase === 'ready' ? await briefingStandings(client, who.tenantId, flightId, briefingIds) : null;
  const briefings = new Map<string, MissionBriefingRecord>();
  for (const ref of refs.briefings) {
    let briefing = briefings.get(ref.briefing.id);
    if (!briefing) {
      briefing = await completedRecord<MissionBriefingRecord>(client, who, 'mission_briefings', ref.briefing.id);
      briefings.set(ref.briefing.id, briefing);
    }
    const candidate = release?.basis.avoidance.candidates.find((entry) => entry.controlEventId === ref.controlEventId);
    if (
      !release ||
      !candidate ||
      !briefingCovers(briefing, candidate) ||
      canonicalDigest(briefing) !== ref.briefing.digest ||
      briefing.flightId !== flightId ||
      !same(briefing.context.release, refs.release) ||
      (claimsReadiness && request.needsHumanReview && briefing.actor.kind !== 'human')
    )
      conflict('The briefing must retain the exact release and list the applicable accepted control');
    const standing = standings?.get(briefing.id);
    if (standing?.status === 'lapsed') throw briefingLapsed(briefing.id, standing);
    if (claimsReadiness && (counts.get(briefing.id) ?? 0) !== briefing.population.recipients.length)
      conflict('Every named recipient must personally acknowledge this exact briefing');
  }
  if (
    request.needsHumanReview &&
    claimsReadiness &&
    uncoveredCandidates(release!.basis.avoidance.candidates, refs.briefings, briefings).length
  )
    conflict('The human path requires an exact briefing listing every applicable accepted control');
  if (refs.permit) {
    const row = (
      await client.query<{ permit: MissionDeparturePermit; permit_digest: string }>(
        'SELECT permit,permit_digest FROM mission_departure_authorizations WHERE tenant_id=$1 AND id=$2 AND flight_id=$3',
        [who.tenantId, refs.permit.id, flightId],
      )
    ).rows[0];
    if (
      !row ||
      row.permit_digest !== refs.permit.digest ||
      canonicalDigest(row.permit) !== row.permit_digest ||
      row.permit.aircraftId !== execution.aircraftId ||
      !same(row.permit.mission, refs.mission) ||
      !same(row.permit.release, refs.release)
    )
      conflict('The actual departure permit must retain the exact mission, release, flight and aircraft');
    if (refs.departureReceipt) {
      const receipt = (
        await client.query<{
          payload: { activity?: string; phase?: string; aircraft?: string };
          occurred_at: Date;
          state: string;
        }>(
          `SELECT r.payload,r.occurred_at,w.state FROM receipts r JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.event_id JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.event_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.flight_id=$3 AND r.kind='flight.observation' AND e.principal_id=$4`,
          [who.tenantId, refs.departureReceipt, flightId, row.permit.actor.id],
        )
      ).rows[0];
      if (
        !receipt ||
        receipt.state !== 'completed' ||
        receipt.payload.aircraft !== execution.aircraftId ||
        !['active', 'departed', 'airborne'].includes(receipt.payload.activity ?? receipt.payload.phase ?? '') ||
        receipt.occurred_at.getTime() < Date.parse(row.permit.authorizedAt) ||
        receipt.occurred_at.getTime() >= Date.parse(row.permit.validUntil)
      )
        conflict('Departure requires the actual completed native receipt within its original permit');
    }
  }
  if (refs.departureReceipt && !refs.permit) conflict('An actual departure receipt requires its exact retained permit');
  if (request.phase === 'departed' && (!refs.permit || !refs.departureReceipt))
    conflict('Departed status requires the actual retained permit and native departure');
  if (request.phase === 'cancelled' && (selected.activity !== 'cancelled' || refs.departureReceipt))
    conflict('Cancellation requires the actual retained cancellation of the unused flight');
}
export async function recordFlightPredepartureProgress(
  client: PoolClient,
  who: AuthContext,
  id: string,
  request: FlightPredepartureProgress,
  config?: FlightPredepartureConfig,
): Promise<string> {
  const source = configuredSource(config, who.tenantId);
  if (!source)
    throw new DomainError(
      404,
      'predeparture_not_configured',
      'Predeparture source coordination is not configured for this operator',
    );
  if (
    who.id !== source.principalId ||
    !['source', 'service'].includes(who.kind ?? '') ||
    !['flight:read', 'input:write', 'mission:write'].every((capability) => who.capabilities.includes(capability)) ||
    !who.missionSources?.includes(source.missionSourceId)
  )
    throw new DomainError(
      403,
      'predeparture_source_required',
      'Only the configured active mission source may report this workflow',
    );
  await client.query('INSERT INTO streams(id,tenant_id,name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,name) DO NOTHING', [
    randomUUID(),
    who.tenantId,
    streamName(id),
  ]);
  await client.query('SELECT id FROM streams WHERE tenant_id=$1 AND name=$2 FOR UPDATE', [
    who.tenantId,
    streamName(id),
  ]);
  const old = await latest(client, who, id);
  const previous = old ? checked(old).progress : undefined;
  if ((previous?.revision ?? 0) !== request.expectedRevision)
    throw new DomainError(
      409,
      'predeparture_progress_changed',
      'Recover the original request or read the exact current workflow revision',
    );
  if (request.expectedRevision >= limits.progress)
    throw new DomainError(413, 'predeparture_progress_limit', 'The workflow reached its retained progress bound');
  if (terminal(request.phase) && request.retryable)
    throw new DomainError(400, 'predeparture_terminal_retryable', 'A terminal workflow cannot request retry');
  await validateReferences(client, who, id, source, request, previous);
  const event = await appendEvent(client, who, {
    type: FLIGHT_PREDEPARTURE_EVENT,
    stream: streamName(id),
    causationId: previous?.id ?? refsMission(request),
    payload: ({ id: eventId, receivedAt }) => {
      if (
        !Number.isFinite(Date.parse(request.sourceObservedAt)) ||
        Date.parse(request.sourceObservedAt) > Date.parse(receivedAt)
      )
        conflict('Source observation cannot be later than its server receipt');
      const { expectedRevision, ...fields } = request;
      const progress: FlightPredepartureProgressRecord = {
        ...fields,
        id: eventId,
        flightId: id,
        revision: expectedRevision + 1,
        recordedAt: receivedAt,
        source,
      };
      return { progress, digest: canonicalDigest(progress) };
    },
  });
  if (Buffer.byteLength(JSON.stringify(event.payload)) > limits.recordBytes)
    throw new DomainError(413, 'predeparture_progress_too_large', 'The workflow report exceeds its retained bound');
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, who.tenantId, event.event_type, who.id, event.received_at, event.payload],
  );
  return event.id;
}
const refsMission = (request: FlightPredepartureProgress) => request.references.mission.eventId;
export async function validateFlightPredepartureEvent(_client: PoolClient, event: JournalEvent): Promise<void> {
  const payload = event.payload as FlightPredepartureProgressResponse;
  if (
    payload.progress?.id !== event.id ||
    payload.progress.source.principalId !== event.principal_id ||
    canonicalDigest(payload.progress) !== payload.digest ||
    Date.parse(payload.progress.sourceObservedAt) > event.received_at.getTime()
  )
    conflict('The operational workflow differs from its immutable acceptance');
}
