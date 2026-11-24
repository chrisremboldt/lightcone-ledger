import { randomUUID } from 'node:crypto';
import {
  CONTROL_EFFECTIVENESS_LIMITS,
  MONITORING_WINDOW_MAX_READ_BYTES,
  subjectReferenceKey,
  type ControlWindow,
  type ControlWindowQuery,
  type MissionRevisionRecord,
  type MonitoringRecordV2,
  type MonitoringReportInputV2,
  type MonitoringWindowRecordResponse,
  type Receipt,
  type SmsDecisionRecord,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';
import {
  appendEvent,
  appendLiveChange,
  authFromRow,
  DomainError,
  readBoundedObject,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import { organization } from './adoptions.js';
import { getCommandLinkBaseline } from './command-link-baseline.js';
import { registerRetainedControlWindowSource } from './control-windows.js';
import { retainSubjectEvidence } from './cuts.js';
import { decisionReference } from './sms-reads.js';
import { getReceipt } from './index.js';

type MonitoringAuthority = MonitoringRecordV2['authority'];
type Flight = MonitoringReportInputV2['payload']['flights'][number];
interface PrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  capabilities: string[];
  monitoring_sources: string[];
  revision: string;
}
interface ArtifactRow {
  object_key: string;
  byte_length: number;
  sha256: string;
  content_type: string;
}
interface WindowRow {
  id: string;
  context_digest: string;
}
interface RevisionMetadata {
  id: string;
  window_id: string;
  organization_id: string;
  source_id: string;
  source_session_id: string;
  source_window_id: string;
  source_revision: string;
  receipt_id: string;
  artifact_id: string;
  actor_id: string;
  occurred_at: Date;
  recorded_at: Date;
  content_digest: string;
  record_digest: string;
  record_bytes: number;
  context_digest: string;
  state: string | null;
}
interface ReferenceMetadata {
  id: string;
  record_bytes: number;
  recorded_at: Date;
  state: string | null;
  projected: boolean;
}
interface MissionMetadata extends ReferenceMetadata {
  mission_id: string;
  flight_id: string;
  aircraft_id: string;
  source_revision: string;
  content_digest: string;
}
interface BaselineMetadata extends ReferenceMetadata {
  flight_id: string;
  aircraft_id: string;
  source_id: string;
  source_session_id: string;
}
interface ControlMetadata extends ReferenceMetadata {
  acceptance: SmsDecisionRecord;
  acceptance_bytes: number;
  acceptance_recorded_at: Date;
  acceptance_state: string | null;
  acceptance_projected: boolean;
}
export interface VerifiedMonitoringWindowSource {
  sha256: string;
  byteLength: number;
  contentDigest: string;
}

const REQUIRED_CAPABILITIES = ['input:write', 'monitoring:write'] as const;
const REVISION_COLUMNS = `r.id,r.window_id,r.organization_id,r.source_revision,r.receipt_id,r.artifact_id,r.actor_id,
 r.occurred_at,r.recorded_at,r.content_digest,r.record_digest,m.source_id,m.source_session_id,m.source_window_id,m.context_digest`;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function keys(value: unknown, required: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  );
}
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function interval(value: unknown, observedAt?: number): value is { start: string; end: string } {
  return (
    keys(value, ['start', 'end']) &&
    utc(value.start) &&
    utc(value.end) &&
    Date.parse(value.start) < Date.parse(value.end) &&
    (observedAt === undefined || Date.parse(value.end) <= observedAt)
  );
}
function sourceGrants(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id) && new Set(value).size === value.length;
}
function invalidSource(): DomainError {
  return new DomainError(
    400,
    'monitoring_source_invalid',
    'Monitoring evidence must match its exact typed source and observed clock',
  );
}
function normalizedInput(input: MonitoringReportInputV2): void {
  if (
    !keys(input, ['sourceId', 'sourceSessionId', 'kind', 'occurredAt', 'artifactId', 'fidelity', 'payload']) ||
    !id(input.sourceId) ||
    !id(input.sourceSessionId) ||
    input.kind !== 'monitoring.window' ||
    !utc(input.occurredAt) ||
    !id(input.artifactId) ||
    input.fidelity !== 'synthetic_contract' ||
    !keys(input.payload, [
      'version',
      'sourceWindowId',
      'sourceRevision',
      'control',
      'window',
      'populationComplete',
      'completeThrough',
      'flights',
    ])
  )
    throw invalidSource();
  const source = input.payload;
  const observedAt = Date.parse(input.occurredAt);
  if (
    source.version !== 'monitoring.window.2' ||
    !id(source.sourceWindowId) ||
    !revision(source.sourceRevision) ||
    !interval(source.window) ||
    Date.parse(source.window.end) - Date.parse(source.window.start) >
      CONTROL_EFFECTIVENESS_LIMITS.maxWindowMilliseconds ||
    typeof source.populationComplete !== 'boolean' ||
    !utc(source.completeThrough) ||
    Date.parse(source.completeThrough) > observedAt ||
    !keys(source.control, [
      'hazardId',
      'controlId',
      'controlVersion',
      'controlEventId',
      'controlDigest',
      'acceptance',
    ]) ||
    !id(source.control.hazardId) ||
    !id(source.control.controlId) ||
    !revision(source.control.controlVersion) ||
    !id(source.control.controlEventId) ||
    !digest(source.control.controlDigest) ||
    !keys(source.control.acceptance, ['id', 'acceptedRevision', 'digest']) ||
    !id(source.control.acceptance.id) ||
    !revision(source.control.acceptance.acceptedRevision) ||
    !digest(source.control.acceptance.digest) ||
    !Array.isArray(source.flights) ||
    source.flights.length > CONTROL_EFFECTIVENESS_LIMITS.maxFlights
  )
    throw invalidSource();
  let membership = 0;
  const flights = new Set<string>();
  const sessions = new Set<string>();
  for (const flight of source.flights) {
    if (
      !keys(flight, [
        'flightId',
        'aircraftId',
        'mission',
        'c2SourceId',
        'c2SourceSessionId',
        'baseline',
        'observedIntervals',
        'coverageIntervals',
        'gaps',
        'declaredC2SourceEventIds',
      ]) ||
      !id(flight.flightId) ||
      !id(flight.aircraftId) ||
      !id(flight.c2SourceId) ||
      !id(flight.c2SourceSessionId) ||
      flights.has(flight.flightId) ||
      sessions.has(canonicalDigest([flight.c2SourceId, flight.c2SourceSessionId])) ||
      !keys(flight.mission, ['missionId', 'sourceRevision', 'eventId', 'contentDigest', 'recordDigest']) ||
      !id(flight.mission.missionId) ||
      !revision(flight.mission.sourceRevision) ||
      !id(flight.mission.eventId) ||
      !digest(flight.mission.contentDigest) ||
      !digest(flight.mission.recordDigest) ||
      !keys(flight.baseline, ['eventId', 'receiptId', 'sourceEventId', 'digest']) ||
      !id(flight.baseline.eventId) ||
      !id(flight.baseline.receiptId) ||
      !id(flight.baseline.sourceEventId) ||
      !digest(flight.baseline.digest) ||
      !Array.isArray(flight.observedIntervals) ||
      flight.observedIntervals.length > CONTROL_EFFECTIVENESS_LIMITS.maxIntervalsPerField ||
      !flight.observedIntervals.every((value) => interval(value, observedAt)) ||
      (flight.coverageIntervals !== null &&
        (!Array.isArray(flight.coverageIntervals) ||
          flight.coverageIntervals.length > CONTROL_EFFECTIVENESS_LIMITS.maxIntervalsPerField ||
          !flight.coverageIntervals.every((value) => interval(value, observedAt)))) ||
      !Array.isArray(flight.gaps) ||
      flight.gaps.length > CONTROL_EFFECTIVENESS_LIMITS.maxIntervalsPerField ||
      !flight.gaps.every(
        (gap) =>
          keys(gap, ['interval', 'kind']) &&
          interval(gap.interval, observedAt) &&
          ['exposure', 'c2_monitor', 'telemetry_delivery'].includes(gap.kind),
      ) ||
      !Array.isArray(flight.declaredC2SourceEventIds) ||
      !flight.declaredC2SourceEventIds.every(id) ||
      new Set(flight.declaredC2SourceEventIds).size !== flight.declaredC2SourceEventIds.length
    )
      throw invalidSource();
    flights.add(flight.flightId);
    sessions.add(canonicalDigest([flight.c2SourceId, flight.c2SourceSessionId]));
    membership += 1 + flight.declaredC2SourceEventIds.length;
  }
  if (membership > CONTROL_EFFECTIVENESS_LIMITS.maxC2Records) throw invalidSource();
}
function windowContext(input: MonitoringReportInputV2) {
  return {
    version: 'ledger.monitoring-window-context.1',
    control: input.payload.control,
    window: input.payload.window,
    population: input.payload.flights
      .map(({ flightId, aircraftId, mission, c2SourceId, c2SourceSessionId, baseline }) => ({
        flightId,
        aircraftId,
        mission,
        c2SourceId,
        c2SourceSessionId,
        baseline,
      }))
      .sort((left, right) => (left.flightId < right.flightId ? -1 : left.flightId > right.flightId ? 1 : 0)),
  };
}
function sourceFromInput(input: MonitoringReportInputV2): MonitoringRecordV2['source'] {
  return { sourceSessionId: input.sourceSessionId, occurredAt: input.occurredAt, ...input.payload };
}
export function verifyMonitoringWindowInputSource(
  input: MonitoringReportInputV2,
  bytes: Uint8Array,
): VerifiedMonitoringWindowSource {
  normalizedInput(input);
  if (bytes.byteLength > CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes)
    throw new DomainError(413, 'monitoring_source_too_large', 'Monitoring original exceeds its 128 KiB bound');
  try {
    const source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), {
      maxBytes: CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes,
    });
    if (canonicalize(source) !== canonicalize(sourceFromInput(input))) throw new Error('Source mapping differs');
  } catch {
    throw invalidSource();
  }
  const original = {
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    bytesBase64: Buffer.from(bytes).toString('base64'),
  };
  return {
    sha256: original.sha256,
    byteLength: original.byteLength,
    contentDigest: canonicalDigest({
      version: 'ledger.monitoring-window-content.2',
      sourceId: input.sourceId,
      sourceSessionId: input.sourceSessionId,
      occurredAt: input.occurredAt,
      fidelity: input.fidelity,
      payload: input.payload,
      original,
    }),
  };
}
function acceptedAuthority(
  value: unknown,
  principalId: string,
  tenantId: string,
  sourceId: string,
): MonitoringAuthority {
  if (
    !keys(value, [
      'principalId',
      'tenantId',
      'principalRevision',
      'capabilities',
      'checkedCapabilities',
      'sourceId',
      'grantedSources',
      'policyVersion',
    ]) ||
    value.principalId !== principalId ||
    value.tenantId !== tenantId ||
    !id(principalId) ||
    !id(tenantId) ||
    !revision(value.principalRevision) ||
    value.sourceId !== sourceId ||
    !id(sourceId) ||
    value.policyVersion !== 'ledger.monitoring-authority.1' ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(id) ||
    !value.capabilities.includes('input:write') ||
    !value.capabilities.includes('monitoring:write') ||
    !Array.isArray(value.checkedCapabilities) ||
    canonicalDigest(value.checkedCapabilities) !== canonicalDigest(REQUIRED_CAPABILITIES) ||
    !sourceGrants(value.grantedSources) ||
    !value.grantedSources.includes(sourceId)
  )
    throw new DomainError(
      403,
      'monitoring_authority_invalid',
      'Retained monitoring authority differs from its immutable issuer and source',
    );
  return value as unknown as MonitoringAuthority;
}
export function validateAcceptedMonitoringAuthority(event: JournalEvent): MonitoringAuthority {
  if (
    event.event_type !== 'monitoring.window' ||
    !id(event.source_id) ||
    !id(event.source_session_id) ||
    ('effective_at' in event && event.effective_at !== null)
  )
    throw new DomainError(
      403,
      'monitoring_authority_invalid',
      'Only monitoring source evidence may use this authority',
    );
  return acceptedAuthority(event.payload.acceptedAuthority, event.principal_id, event.tenant_id, event.source_id);
}
async function originalBytes(artifact: ArtifactRow, store?: ObjectStore): Promise<Uint8Array> {
  if (artifact.content_type !== 'application/json') throw invalidSource();
  if (artifact.byte_length < 1 || artifact.byte_length > CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes)
    throw new DomainError(413, 'monitoring_source_too_large', 'Monitoring original exceeds its 128 KiB bound');
  let bytes: Uint8Array;
  try {
    if (!store) throw new Error('No object store supplied');
    bytes = await readBoundedObject(store, artifact.object_key, { maxBytes: artifact.byte_length, timeoutMs: 10000 });
  } catch {
    throw new DomainError(409, 'artifact_unavailable', 'Original monitoring bytes are unavailable');
  }
  if (bytes.byteLength !== artifact.byte_length || sha256(bytes) !== artifact.sha256)
    throw new DomainError(
      409,
      'artifact_integrity_failure',
      'Original monitoring bytes differ from their retained digest',
    );
  return bytes;
}
async function lockFlights(client: PoolClient, tenantId: string, flights: Flight[]): Promise<void> {
  const ids = flights.map((flight) => flight.flightId).sort();
  const result = await client.query(
    'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
    [tenantId, ids],
  );
  if (result.rowCount !== ids.length)
    throw new DomainError(404, 'flight_not_found', 'A monitored flight was not found within your scope');
}
async function validateReferences(
  client: PoolClient,
  principal: AuthContext,
  input: MonitoringReportInputV2,
): Promise<number> {
  const ref = input.payload.control;
  // The control is a control record version that a risk acceptance on its safety-record hazard binds.
  const control = (
    await client.query<ControlMetadata>(
      `SELECT v.id,octet_length(v.body::text) AS record_bytes,v.recorded_at,cw.state,
   cp.sequence>=ce.stream_sequence AS projected,octet_length(d.record::text) AS acceptance_bytes,d.recorded_at AS acceptance_recorded_at,
   aw.state AS acceptance_state,ap.sequence>=ae.stream_sequence AS acceptance_projected,d.record AS acceptance
   FROM accepted_hazard_controls a JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id AND h.kind='hazard'
   JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
    AND v.version_number=a.control_version_number AND v.body_digest=a.control_body_digest
   JOIN decisions d ON d.tenant_id=a.tenant_id AND d.subject_id=a.hazard_id AND d.id=a.acceptance_id AND d.kind='risk.accept'
   JOIN journal_events ce ON ce.tenant_id=v.tenant_id AND ce.id=v.id JOIN journal_events ae ON ae.tenant_id=d.tenant_id AND ae.id=d.id
   LEFT JOIN work_items cw ON cw.tenant_id=v.tenant_id AND cw.event_id=v.id LEFT JOIN work_items aw ON aw.tenant_id=d.tenant_id AND aw.event_id=d.id
   LEFT JOIN projection_offsets cp ON cp.tenant_id=ce.tenant_id AND cp.stream_id=ce.stream_id LEFT JOIN projection_offsets ap ON ap.tenant_id=ae.tenant_id AND ap.stream_id=ae.stream_id
   WHERE a.tenant_id=$1 AND v.id=$2 AND a.hazard_id=$3 AND a.control_id=$4 AND a.control_version_number=$5
    AND a.control_body_digest=$6 AND a.acceptance_id=$7 AND d.accepted_revision=$8`,
      [
        principal.tenantId,
        ref.controlEventId,
        ref.hazardId,
        ref.controlId,
        ref.controlVersion,
        ref.controlDigest,
        ref.acceptance.id,
        ref.acceptance.acceptedRevision,
      ],
    )
  ).rows[0];
  if (!control)
    throw new DomainError(
      404,
      'monitoring_reference_invalid',
      'The exact accepted control was not found within your organization',
    );
  const missions = await client.query<MissionMetadata>(
    `SELECT r.id,r.mission_id,r.flight_id,m.aircraft_id,r.source_revision,r.content_digest,r.recorded_at,
   octet_length(r.record::text) AS record_bytes,w.state,p.sequence>=e.stream_sequence AS projected
   FROM mission_revisions r JOIN missions m ON m.tenant_id=r.tenant_id AND m.id=r.mission_id
   JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.id LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.id
   LEFT JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id WHERE r.tenant_id=$1 AND r.id=ANY($2::text[])`,
    [principal.tenantId, input.payload.flights.map((flight) => flight.mission.eventId)],
  );
  const baselines = await client.query<BaselineMetadata>(
    `SELECT b.id,b.flight_id,b.aircraft_id,b.source_id,b.source_session_id,b.recorded_at,
   octet_length(b.record::text) AS record_bytes,w.state,p.sequence>=e.stream_sequence AS projected
   FROM command_link_baselines b JOIN journal_events e ON e.tenant_id=b.tenant_id AND e.id=b.id
   LEFT JOIN work_items w ON w.tenant_id=b.tenant_id AND w.event_id=b.id LEFT JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id
   WHERE b.tenant_id=$1 AND b.id=ANY($2::text[])`,
    [principal.tenantId, input.payload.flights.map((flight) => flight.baseline.eventId)],
  );
  if (missions.rowCount !== input.payload.flights.length || baselines.rowCount !== input.payload.flights.length)
    throw new DomainError(
      404,
      'monitoring_reference_invalid',
      'An exact mission or native baseline was not found within your scope',
    );
  const bytes =
    control.record_bytes +
    control.acceptance_bytes +
    [...missions.rows, ...baselines.rows].reduce((total, row) => total + row.record_bytes, 0);
  if (bytes > CONTROL_EFFECTIVENESS_LIMITS.maxResolvedInputBytes)
    throw new DomainError(
      409,
      'monitoring_references_too_large',
      'Retained monitoring references exceed their bounded read budget',
    );
  if (
    control.state !== 'completed' ||
    control.projected !== true ||
    control.acceptance_state !== 'completed' ||
    control.acceptance_projected !== true ||
    [...missions.rows, ...baselines.rows].some((row) => row.state !== 'completed' || row.projected !== true)
  )
    throw new DomainError(
      409,
      'monitoring_evidence_pending',
      'Exact monitoring references must finish projection before they are cited',
    );
  if (decisionReference(control.acceptance).digest !== ref.acceptance.digest)
    throw new DomainError(
      400,
      'monitoring_reference_invalid',
      'Monitoring must cite exact retained control and acceptance digests',
    );
  const missionRecords = await client.query<{ id: string; record: MissionRevisionRecord }>(
    'SELECT id,record FROM mission_revisions WHERE tenant_id=$1 AND id=ANY($2::text[])',
    [principal.tenantId, missions.rows.map((row) => row.id)],
  );
  for (const flight of input.payload.flights) {
    const mission = missions.rows.find((row) => row.id === flight.mission.eventId)!;
    const record = missionRecords.rows.find((row) => row.id === mission.id)!.record;
    const baseline = baselines.rows.find((row) => row.id === flight.baseline.eventId)!;
    const retained = await getCommandLinkBaseline(client, principal, flight.flightId, baseline.id);
    if (
      mission.mission_id !== flight.mission.missionId ||
      mission.flight_id !== flight.flightId ||
      mission.aircraft_id !== flight.aircraftId ||
      Number(mission.source_revision) !== flight.mission.sourceRevision ||
      mission.content_digest !== flight.mission.contentDigest ||
      canonicalDigest(record) !== flight.mission.recordDigest ||
      record.id !== mission.id ||
      record.flightId !== flight.flightId ||
      record.aircraftId !== flight.aircraftId ||
      baseline.flight_id !== flight.flightId ||
      baseline.aircraft_id !== flight.aircraftId ||
      baseline.source_id !== flight.c2SourceId ||
      baseline.source_session_id !== flight.c2SourceSessionId ||
      retained.digest !== flight.baseline.digest ||
      retained.baseline.receiptId !== flight.baseline.receiptId ||
      retained.baseline.input.payload.sourceEventId !== flight.baseline.sourceEventId
    )
      throw new DomainError(
        400,
        'monitoring_reference_invalid',
        'The monitored flight, reported aircraft, mission and native session baseline must match exactly',
      );
  }
  return Math.max(
    control.recorded_at.getTime(),
    control.acceptance_recorded_at.getTime(),
    ...missions.rows.map((row) => row.recorded_at.getTime()),
    ...baselines.rows.map((row) => row.recorded_at.getTime()),
  );
}
function response(
  record: MonitoringRecordV2,
  recordDigest: string,
  processing: MonitoringWindowRecordResponse['processing'],
): MonitoringWindowRecordResponse {
  const result = { monitoring: record, digest: recordDigest, processing };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MONITORING_WINDOW_MAX_READ_BYTES)
    throw new DomainError(409, 'monitoring_record_too_large', 'Monitoring response exceeds its 256 KiB read bound');
  return result;
}
export async function acceptMonitoringWindowInput(
  client: PoolClient,
  principal: AuthContext,
  input: MonitoringReportInputV2,
  store?: ObjectStore,
): Promise<Receipt> {
  const actor = (
    await client.query<PrincipalRow>(
      'SELECT id,tenant_id,name,kind,capabilities,monitoring_sources,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!actor) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  if (!REQUIRED_CAPABILITIES.every((capability) => actor.capabilities.includes(capability)))
    throw new DomainError(403, 'capability_required', 'Monitoring evidence requires input:write and monitoring:write');
  if (!sourceGrants(actor.monitoring_sources) || !actor.monitoring_sources.includes(input.sourceId))
    throw new DomainError(403, 'source_grant_required', 'This monitoring source must be explicitly granted');
  normalizedInput(input);
  const current = authFromRow(actor);
  const artifact = (
    await client.query<ArtifactRow>(
      'SELECT object_key,byte_length,sha256,content_type FROM artifacts WHERE tenant_id=$1 AND id=$2',
      [current.tenantId, input.artifactId],
    )
  ).rows[0];
  if (!artifact)
    throw new DomainError(404, 'artifact_not_found', 'Monitoring original was not found within your scope');
  const verified = verifyMonitoringWindowInputSource(input, await originalBytes(artifact, store));
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `monitoring-window:${canonicalDigest({ tenantId: current.tenantId, sourceId: input.sourceId, sourceSessionId: input.sourceSessionId, sourceWindowId: input.payload.sourceWindowId })}`,
  ]);
  const previous = (
    await client.query<{ receipt_id: string; content_digest: string }>(
      `SELECT r.receipt_id,r.content_digest FROM monitoring_windows m JOIN monitoring_window_revisions r ON r.tenant_id=m.tenant_id AND r.window_id=m.id
   WHERE m.tenant_id=$1 AND m.source_id=$2 AND m.source_session_id=$3 AND m.source_window_id=$4 AND r.source_revision=$5`,
      [
        current.tenantId,
        input.sourceId,
        input.sourceSessionId,
        input.payload.sourceWindowId,
        input.payload.sourceRevision,
      ],
    )
  ).rows[0];
  if (previous) {
    if (previous.content_digest !== verified.contentDigest)
      throw new DomainError(
        409,
        'source_revision_conflict',
        'This monitoring revision already retains different content or original bytes',
      );
    return getReceipt(client, previous.receipt_id);
  }
  const window = (
    await client.query<WindowRow>(
      'SELECT id,context_digest FROM monitoring_windows WHERE tenant_id=$1 AND source_id=$2 AND source_session_id=$3 AND source_window_id=$4',
      [current.tenantId, input.sourceId, input.sourceSessionId, input.payload.sourceWindowId],
    )
  ).rows[0];
  const contextDigest = canonicalDigest(windowContext(input));
  if (window && window.context_digest !== contextDigest)
    throw new DomainError(
      409,
      'monitoring_context_conflict',
      'A monitoring window permanently retains its exact control, interval and population bindings',
    );
  const latest = window
    ? Number(
        (
          await client.query<{ revision: string }>(
            'SELECT COALESCE(max(source_revision),0) AS revision FROM monitoring_window_revisions WHERE tenant_id=$1 AND window_id=$2',
            [current.tenantId, window.id],
          )
        ).rows[0].revision,
      )
    : 0;
  if (input.payload.sourceRevision !== latest + 1)
    throw new DomainError(
      409,
      'monitoring_revision_required',
      'Monitoring revisions must begin at one and advance contiguously',
    );
  await lockFlights(client, current.tenantId, input.payload.flights);
  const org = await organization(client, current.tenantId, 'SHARE');
  const latestReferenceTime = await validateReferences(client, current, input);
  const authority: MonitoringAuthority = {
    principalId: current.id,
    tenantId: current.tenantId,
    principalRevision: current.revision,
    capabilities: [...current.capabilities],
    checkedCapabilities: [...REQUIRED_CAPABILITIES],
    sourceId: input.sourceId,
    grantedSources: [...actor.monitoring_sources],
    policyVersion: 'ledger.monitoring-authority.1',
  };
  const event = await appendEvent(client, current, {
    type: input.kind,
    stream: `source:${current.id}:${input.sourceId}:${input.sourceSessionId}`,
    sourceId: input.sourceId,
    sessionId: input.sourceSessionId,
    occurredAt: input.occurredAt,
    artifactId: input.artifactId,
    payload: { ...input, organizationId: org.id, acceptedAuthority: authority },
  });
  if (Date.parse(input.occurredAt) > event.received_at.getTime() || latestReferenceTime > event.received_at.getTime())
    throw invalidSource();
  const receiptId = randomUUID();
  await client.query(
    `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,source_revision,artifact_id,link_status,payload,input_subject)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'linked',$10,$11)`,
    [
      receiptId,
      current.tenantId,
      event.id,
      input.sourceId,
      input.kind,
      input.occurredAt,
      event.received_at,
      input.payload.sourceRevision,
      input.artifactId,
      input.payload,
      { organizationId: org.id },
    ],
  );
  const record: MonitoringRecordV2 = {
    version: 'monitoring.window.2',
    id: event.id,
    organizationId: org.id,
    sourceId: input.sourceId,
    source: sourceFromInput(input),
    original: { artifactId: input.artifactId, sha256: verified.sha256, byteLength: verified.byteLength },
    recordedAt: event.received_at.toISOString(),
    authority,
  };
  const recordDigest = canonicalDigest(record);
  response(record, recordDigest, 'processing');
  const bytes = (
    await client.query<{ bytes: number }>(
      `SELECT octet_length(jsonb_build_object('monitoring',$1::jsonb,'digest',$2::text,'processing','processing')::text) AS bytes`,
      [record, recordDigest],
    )
  ).rows[0].bytes;
  if (bytes > MONITORING_WINDOW_MAX_READ_BYTES)
    throw new DomainError(409, 'monitoring_record_too_large', 'Monitoring record exceeds its retained read bound');
  const windowId = window?.id ?? randomUUID();
  if (!window)
    await client.query(
      `INSERT INTO monitoring_windows(id,tenant_id,organization_id,source_id,source_session_id,source_window_id,context_digest,first_event_id,control_event_id,acceptance_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        windowId,
        current.tenantId,
        org.id,
        input.sourceId,
        input.sourceSessionId,
        input.payload.sourceWindowId,
        contextDigest,
        event.id,
        input.payload.control.controlEventId,
        input.payload.control.acceptance.id,
      ],
    );
  await client.query(
    `INSERT INTO monitoring_window_revisions(id,tenant_id,window_id,organization_id,source_revision,receipt_id,artifact_id,actor_id,occurred_at,recorded_at,content_digest,record_digest,record)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      event.id,
      current.tenantId,
      windowId,
      org.id,
      input.payload.sourceRevision,
      receiptId,
      input.artifactId,
      current.id,
      input.occurredAt,
      event.received_at,
      verified.contentDigest,
      recordDigest,
      record,
    ],
  );
  await retainSubjectEvidence(
    client,
    current.tenantId,
    [org.id, ...input.payload.flights.map((flight) => flight.flightId)],
    event,
  );
  for (const flight of input.payload.flights) {
    await client.query(
      'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=GREATEST(last_received_at,$1) WHERE tenant_id=$2 AND id=$3',
      [event.received_at, current.tenantId, flight.flightId],
    );
    await appendLiveChange(client, current.tenantId, flight.flightId, event.id, 'flight.updated', receiptId);
  }
  return getReceipt(client, receiptId);
}
function inputFromRecord(record: MonitoringRecordV2): MonitoringReportInputV2 {
  const { sourceSessionId, occurredAt, ...payload } = record.source;
  return {
    sourceId: record.sourceId,
    sourceSessionId,
    kind: 'monitoring.window',
    occurredAt,
    artifactId: record.original.artifactId,
    fidelity: 'synthetic_contract',
    payload,
  };
}
function verifyRecord(record: MonitoringRecordV2, row: RevisionMetadata, tenantId: string): MonitoringReportInputV2 {
  const input = inputFromRecord(record);
  normalizedInput(input);
  acceptedAuthority(record.authority, row.actor_id, tenantId, row.source_id);
  if (
    !keys(record, ['version', 'id', 'organizationId', 'sourceId', 'source', 'original', 'recordedAt', 'authority']) ||
    !keys(record.original, ['artifactId', 'sha256', 'byteLength']) ||
    record.version !== 'monitoring.window.2' ||
    record.id !== row.id ||
    record.organizationId !== row.organization_id ||
    record.organizationId !== `organization:${tenantId}` ||
    record.sourceId !== row.source_id ||
    record.source.sourceSessionId !== row.source_session_id ||
    record.source.sourceWindowId !== row.source_window_id ||
    record.source.sourceRevision !== Number(row.source_revision) ||
    record.recordedAt !== row.recorded_at.toISOString() ||
    Date.parse(record.source.occurredAt) !== row.occurred_at.getTime() ||
    row.occurred_at.getTime() > row.recorded_at.getTime() ||
    record.original.artifactId !== row.artifact_id ||
    !digest(record.original.sha256) ||
    !revision(record.original.byteLength) ||
    record.original.byteLength > CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes ||
    canonicalDigest(record) !== row.record_digest ||
    canonicalDigest(windowContext(input)) !== row.context_digest
  )
    throw new DomainError(
      409,
      'monitoring_commitment_mismatch',
      'Monitoring record differs from its immutable acceptance',
    );
  return input;
}
async function loadRecord(
  client: PoolClient,
  tenantId: string,
  monitoringId: string,
): Promise<{ row: RevisionMetadata; record: MonitoringRecordV2 }> {
  const row = (
    await client.query<RevisionMetadata>(
      `SELECT ${REVISION_COLUMNS},octet_length(r.record::text) AS record_bytes,w.state
   FROM monitoring_window_revisions r JOIN monitoring_windows m ON m.tenant_id=r.tenant_id AND m.id=r.window_id
   LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.id WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, monitoringId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'monitoring_window_not_found',
      'Monitoring record was not found within your organization',
    );
  if (row.record_bytes > MONITORING_WINDOW_MAX_READ_BYTES)
    throw new DomainError(409, 'monitoring_record_too_large', 'Monitoring record exceeds its read bound');
  const record = (
    await client.query<{ record: MonitoringRecordV2 }>(
      'SELECT record FROM monitoring_window_revisions WHERE tenant_id=$1 AND id=$2',
      [tenantId, monitoringId],
    )
  ).rows[0].record;
  verifyRecord(record, row, tenantId);
  return { row, record };
}
export async function getMonitoringWindow(
  client: PoolClient,
  principal: AuthContext,
  monitoringId: string,
): Promise<MonitoringWindowRecordResponse> {
  const { row, record } = await loadRecord(client, principal.tenantId, monitoringId);
  return response(
    record,
    row.record_digest,
    row.state === 'completed'
      ? 'completed'
      : row.state === 'failed'
        ? 'failed'
        : row.state === 'leased'
          ? 'processing'
          : 'pending',
  );
}
export async function projectMonitoringWindowEvent(
  client: PoolClient,
  event: JournalEvent,
  store?: ObjectStore,
): Promise<void> {
  const authority = validateAcceptedMonitoringAuthority(event);
  const { row, record } = await loadRecord(client, event.tenant_id, event.id);
  const input = inputFromRecord(record);
  const receipt = (
    await client.query<{
      event_id: string;
      source_id: string;
      kind: string;
      source_revision: string | null;
      flight_id: string | null;
      artifact_id: string | null;
      occurred_at: Date;
      received_at: Date;
      link_status: string;
      payload: MonitoringReportInputV2['payload'];
      input_subject: { organizationId: string };
    }>(
      'SELECT event_id,source_id,kind,source_revision,flight_id,artifact_id,occurred_at,received_at,link_status,payload,input_subject FROM receipts WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [event.tenant_id, row.receipt_id],
    )
  ).rows[0];
  const artifact = (
    await client.query<ArtifactRow>(
      'SELECT object_key,byte_length,sha256,content_type FROM artifacts WHERE tenant_id=$1 AND id=$2',
      [event.tenant_id, row.artifact_id],
    )
  ).rows[0];
  const stream = (
    await client.query<{ name: string }>('SELECT name FROM streams WHERE tenant_id=$1 AND id=$2', [
      event.tenant_id,
      event.stream_id,
    ])
  ).rows[0];
  if (
    !receipt ||
    !artifact ||
    stream?.name !== `source:${event.principal_id}:${event.source_id}:${event.source_session_id}` ||
    event.received_at.getTime() !== row.recorded_at.getTime() ||
    event.occurred_at?.getTime() !== row.occurred_at.getTime() ||
    event.source_id !== row.source_id ||
    event.source_session_id !== row.source_session_id ||
    event.artifact_id !== row.artifact_id ||
    canonicalDigest(authority) !== canonicalDigest(record.authority) ||
    canonicalDigest(event.payload) !==
      canonicalDigest({ ...input, organizationId: row.organization_id, acceptedAuthority: authority }) ||
    receipt.event_id !== event.id ||
    receipt.source_id !== event.source_id ||
    receipt.kind !== event.event_type ||
    Number(receipt.source_revision) !== record.source.sourceRevision ||
    receipt.flight_id !== null ||
    receipt.link_status !== 'linked' ||
    receipt.artifact_id !== row.artifact_id ||
    receipt.occurred_at.getTime() !== row.occurred_at.getTime() ||
    receipt.received_at.getTime() !== row.recorded_at.getTime() ||
    canonicalDigest(receipt.payload) !== canonicalDigest(input.payload) ||
    canonicalDigest(receipt.input_subject) !== canonicalDigest({ organizationId: row.organization_id }) ||
    artifact.sha256 !== record.original.sha256 ||
    artifact.byte_length !== record.original.byteLength
  )
    throw new DomainError(
      409,
      'monitoring_commitment_mismatch',
      'Monitoring record differs from its immutable journal, receipt or original',
    );
  const verified = verifyMonitoringWindowInputSource(input, await originalBytes(artifact, store));
  if (verified.contentDigest !== row.content_digest)
    throw new DomainError(
      409,
      'monitoring_commitment_mismatch',
      'Monitoring source differs from its immutable content identity',
    );
  await client.query(
    'INSERT INTO monitoring_window_projection_views(tenant_id,monitoring_id,organization_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [event.tenant_id, event.id, row.organization_id],
  );
}

/** The latest revision of a source-reported window, in the shape every control window is listed in. */
function asControlWindow(windowId: string, openedAt: Date, row: RevisionMetadata, record: MonitoringRecordV2) {
  const source = record.source;
  const subjects = source.flights
    .map((flight) => ({ scope: 'ledger' as const, kind: 'flight' as const, id: flight.flightId }))
    .sort((left, right) => (subjectReferenceKey(left) < subjectReferenceKey(right) ? -1 : 1));
  const window: ControlWindow = {
    id: windowId,
    variant: 'retained',
    organizationId: record.organizationId,
    control: {
      kind: 'control_record',
      hazardId: source.control.hazardId,
      recordId: source.control.controlId,
      versionNumber: source.control.controlVersion,
      bodyDigest: source.control.controlDigest,
      acceptanceId: source.control.acceptance.id,
    },
    period: { ...source.window },
    population: {
      subjectKind: 'flight',
      subjects,
      complete: source.populationComplete,
      declaredBy: { kind: 'source', id: record.sourceId },
    },
    expectedObservations: [],
    indicators: [],
    openedAt: openedAt.toISOString(),
    revision: {
      number: source.sourceRevision,
      id: record.id,
      recordedAt: record.recordedAt,
      digest: row.record_digest,
      note: null,
    },
  };
  return window;
}

registerRetainedControlWindowSource({
  name: 'source-reported',
  async list(client: PoolClient, principal: AuthContext, query: ControlWindowQuery, limit: number) {
    if (query.controlKind !== 'control_record' || !principal.capabilities.includes('flight:read')) return [];
    const windows = await client.query<{ id: string; latest_id: string; opened_at: Date }>(
      `SELECT m.id,latest.id AS latest_id,first.recorded_at AS opened_at FROM monitoring_windows m
       JOIN sms_record_versions c ON c.tenant_id=m.tenant_id AND c.id=m.control_event_id
       JOIN accepted_hazard_controls a ON a.tenant_id=m.tenant_id AND a.acceptance_id=m.acceptance_id
        AND a.control_id=c.record_id AND a.control_version_number=c.version_number
       JOIN monitoring_window_revisions first ON first.tenant_id=m.tenant_id AND first.id=m.first_event_id
       JOIN LATERAL (SELECT id FROM monitoring_window_revisions WHERE tenant_id=m.tenant_id AND window_id=m.id
        ORDER BY source_revision DESC LIMIT 1) latest ON true
       WHERE m.tenant_id=$1 AND a.hazard_id=$2 AND a.control_id=$3 AND ($4::integer IS NULL OR a.control_version_number=$4)
       ORDER BY first.recorded_at DESC,m.id COLLATE "C" DESC LIMIT $5`,
      [
        principal.tenantId,
        query.hazardId,
        query.controlId,
        query.controlVersion === undefined ? null : Number(query.controlVersion),
        limit,
      ],
    );
    const listed: ControlWindow[] = [];
    for (const window of windows.rows) {
      const { row, record } = await loadRecord(client, principal.tenantId, window.latest_id);
      listed.push(asControlWindow(window.id, window.opened_at, row, record));
    }
    return listed;
  },
});
