import { randomUUID } from 'node:crypto';
import { MISSION_MAX_POSITIONS, MISSION_SOURCE_MAX_BYTES, missionRoutePlanningReasons } from '@ledger/contracts';
import type {
  FlightMissionResponse,
  FlightMissionRevisionResponse,
  MissionAuthority,
  MissionBinding,
  MissionInput,
  MissionRevisionRecord,
  Receipt,
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
import { linkSubjectDependency, retainSubjectEvidence } from './cuts.js';
import { getReceipt, responseMeta } from './index.js';

interface PrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  capabilities: string[];
  command_link_sources: string[];
  mission_sources: string[];
  revision: string;
}
interface ArtifactRow {
  object_key: string;
  byte_length: number;
  sha256: string;
  content_type: string;
}
interface MissionRow {
  id: string;
  source_id: string;
  source_mission_id: string;
  flight_id: string;
  aircraft_id: string;
}
interface RevisionRow {
  id: string;
  source_revision: string;
  receipt_id: string;
  content_digest: string;
  record: MissionRevisionRecord;
}
export interface VerifiedMissionSource {
  sha256: string;
  byteLength: number;
  contentDigest: string;
}

const SOURCE_BYTES_LIMIT = MISSION_SOURCE_MAX_BYTES;
const REQUIRED_CAPABILITIES = ['input:write', 'mission:write'] as const;
const AUTHORITY_VERSION = 'ledger.mission-authority.1';
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function keys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function sourceGrants(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id) && new Set(value).size === value.length;
}
function utc(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.startsWith('0000-') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
  )
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}
function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function normalizedInput(input: MissionInput): void {
  const fail = () =>
    new DomainError(400, 'mission_source_invalid', 'Mission evidence must match its typed planned-geometry contract');
  if (
    !keys(
      input,
      ['sourceId', 'kind', 'sourceRevision', 'occurredAt', 'subject', 'artifactId', 'fidelity', 'payload'],
      ['flightId', 'acceptedAuthority', 'acceptance'],
    ) ||
    input.kind !== 'mission.revision' ||
    input.fidelity !== 'synthetic_contract' ||
    !id(input.sourceId) ||
    !id(input.artifactId) ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1 ||
    !utc(input.occurredAt) ||
    !keys(input.subject, ['flightId']) ||
    !id(input.subject.flightId) ||
    !keys(
      input.payload,
      ['sourceMissionId', 'aircraftId', 'route', 'lateralToleranceMeters', 'altitude', 'operatingInterval'],
      ['routePlanning'],
    ) ||
    !id(input.payload.sourceMissionId) ||
    !id(input.payload.aircraftId)
  )
    throw fail();
  const { route, altitude, operatingInterval } = input.payload;
  if (
    !keys(route, ['coordinateReference', 'coordinateOrder', 'segmentInterpolation', 'geometry']) ||
    route.coordinateReference !== 'WGS84' ||
    route.coordinateOrder !== 'longitude_latitude' ||
    route.segmentInterpolation !== 'linear_longitude_latitude' ||
    !keys(route.geometry, ['type', 'coordinates']) ||
    route.geometry.type !== 'LineString' ||
    !Array.isArray(route.geometry.coordinates) ||
    route.geometry.coordinates.length < 2 ||
    route.geometry.coordinates.length > MISSION_MAX_POSITIONS ||
    !route.geometry.coordinates.every(
      (position) =>
        Array.isArray(position) &&
        position.length === 2 &&
        boundedNumber(position[0], -180, 180) &&
        boundedNumber(position[1], -90, 90),
    ) ||
    !boundedNumber(input.payload.lateralToleranceMeters, 0, 1000) ||
    !keys(altitude, ['minimum', 'maximum', 'unit', 'reference']) ||
    altitude.unit !== 'm' ||
    altitude.reference !== 'AGL' ||
    !boundedNumber(altitude.minimum, 0, 10000) ||
    !boundedNumber(altitude.maximum, 0, 10000) ||
    altitude.minimum > altitude.maximum ||
    !keys(operatingInterval, ['start', 'end']) ||
    !utc(operatingInterval.start) ||
    !utc(operatingInterval.end) ||
    Date.parse(operatingInterval.start) >= Date.parse(operatingInterval.end)
  )
    throw fail();
  if (
    input.payload.routePlanning !== undefined &&
    missionRoutePlanningReasons(input.payload.routePlanning, route.geometry.coordinates, operatingInterval).length
  )
    throw fail();
  if ('flightId' in input && input.flightId !== input.subject.flightId) throw fail();
}

export function verifyMissionInputSource(input: MissionInput, bytes: Uint8Array): VerifiedMissionSource {
  normalizedInput(input);
  if (bytes.byteLength > SOURCE_BYTES_LIMIT)
    throw new DomainError(413, 'mission_source_too_large', 'Mission source exceeds its 64 KiB bound');
  try {
    const source: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    const expected = { sourceRevision: input.sourceRevision, occurredAt: input.occurredAt, ...input.payload };
    if (canonicalize(source) !== canonicalize(expected)) throw new Error('Source mapping differs');
  } catch {
    throw new DomainError(
      400,
      'mission_source_invalid',
      'Mission input must reproduce its exact original UTF-8 JSON source',
    );
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
      version: 'ledger.mission-content.1',
      sourceId: input.sourceId,
      flightId: input.subject.flightId,
      sourceRevision: input.sourceRevision,
      occurredAt: input.occurredAt,
      fidelity: input.fidelity,
      payload: input.payload,
      original,
    }),
  };
}

export function validateAcceptedMissionAuthority(event: JournalEvent): MissionAuthority {
  const retained: unknown = event.payload.acceptedAuthority;
  if (
    event.event_type !== 'mission.revision' ||
    event.source_session_id !== null ||
    ('effective_at' in event && event.effective_at !== null) ||
    !keys(retained, [
      'version',
      'principalId',
      'tenantId',
      'principalRevision',
      'inputKind',
      'sourceId',
      'requiredCapabilities',
      'grantedSources',
    ]) ||
    retained.version !== AUTHORITY_VERSION ||
    retained.principalId !== event.principal_id ||
    retained.tenantId !== event.tenant_id ||
    !Number.isSafeInteger(retained.principalRevision) ||
    Number(retained.principalRevision) < 1 ||
    retained.inputKind !== event.event_type ||
    retained.sourceId !== event.source_id ||
    !Array.isArray(retained.requiredCapabilities) ||
    canonicalDigest(retained.requiredCapabilities) !== canonicalDigest(REQUIRED_CAPABILITIES) ||
    !sourceGrants(retained.grantedSources) ||
    !retained.grantedSources.includes(retained.sourceId as string)
  )
    throw new DomainError(
      403,
      'mission_authority_invalid',
      'Retained mission authority does not match its immutable issuer and source',
    );
  return retained as unknown as MissionAuthority;
}

function validateBinding(mission: MissionRow, input: MissionInput): void {
  if (
    mission.source_id !== input.sourceId ||
    mission.source_mission_id !== input.payload.sourceMissionId ||
    mission.flight_id !== input.subject.flightId ||
    mission.aircraft_id !== input.payload.aircraftId
  )
    throw new DomainError(
      409,
      'mission_binding_conflict',
      'The mission identity is fixed to its original flight, source and reported aircraft',
    );
}

export async function acceptMissionInput(
  client: PoolClient,
  principal: AuthContext,
  input: MissionInput,
  objectStore?: ObjectStore,
): Promise<Receipt> {
  const actor = (
    await client.query<PrincipalRow>(
      'SELECT id,tenant_id,name,kind,capabilities,command_link_sources,mission_sources,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!actor) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  if (REQUIRED_CAPABILITIES.some((capability) => !actor.capabilities.includes(capability)))
    throw new DomainError(403, 'capability_required', 'Mission evidence requires input:write and mission:write');
  if (!sourceGrants(actor.mission_sources) || !actor.mission_sources.includes(input.sourceId))
    throw new DomainError(403, 'source_grant_required', 'This mission source must be explicitly granted');
  normalizedInput(input);
  const current = authFromRow(actor);
  const artifact = (
    await client.query<ArtifactRow>(
      'SELECT object_key,byte_length,sha256,content_type FROM artifacts WHERE tenant_id=$1 AND id=$2',
      [current.tenantId, input.artifactId],
    )
  ).rows[0];
  if (!artifact)
    throw new DomainError(404, 'artifact_not_found', 'Mission source artifact was not found within your scope');
  if (artifact.content_type !== 'application/json')
    throw new DomainError(400, 'mission_source_invalid', 'Mission original source must be application/json');
  if (artifact.byte_length > SOURCE_BYTES_LIMIT)
    throw new DomainError(413, 'mission_source_too_large', 'Mission source exceeds its 64 KiB bound');
  let bytes: Uint8Array;
  try {
    if (!objectStore) throw new Error('No object store supplied');
    bytes = await readBoundedObject(objectStore, artifact.object_key, {
      maxBytes: artifact.byte_length,
      timeoutMs: 10000,
    });
  } catch {
    throw new DomainError(409, 'artifact_unavailable', 'Original mission source bytes are unavailable');
  }
  if (bytes.byteLength !== artifact.byte_length || sha256(bytes) !== artifact.sha256)
    throw new DomainError(
      409,
      'artifact_integrity_failure',
      'Original mission source bytes differ from their retained digest',
    );
  const verified = verifyMissionInputSource(input, bytes);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `mission:${canonicalDigest({ tenantId: current.tenantId, sourceId: input.sourceId, sourceMissionId: input.payload.sourceMissionId })}`,
  ]);
  const previous = (
    await client.query<RevisionRow>(
      `SELECT r.* FROM missions m JOIN mission_revisions r ON r.tenant_id=m.tenant_id AND r.mission_id=m.id
     WHERE m.tenant_id=$1 AND m.source_id=$2 AND m.source_mission_id=$3 AND r.source_revision=$4`,
      [current.tenantId, input.sourceId, input.payload.sourceMissionId, input.sourceRevision],
    )
  ).rows[0];
  if (previous) {
    if (previous.content_digest !== verified.contentDigest)
      throw new DomainError(
        409,
        'source_revision_conflict',
        'This mission revision already retains different content or original bytes',
      );
    return getReceipt(client, previous.receipt_id);
  }
  let mission = (
    await client.query<MissionRow>(
      'SELECT * FROM missions WHERE tenant_id=$1 AND source_id=$2 AND source_mission_id=$3',
      [current.tenantId, input.sourceId, input.payload.sourceMissionId],
    )
  ).rows[0];
  if (mission) validateBinding(mission, input);
  const flight = await client.query<{ id: string }>(
    'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [current.tenantId, input.subject.flightId],
  );
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const flightMission = (
    await client.query<MissionRow>('SELECT * FROM missions WHERE tenant_id=$1 AND flight_id=$2', [
      current.tenantId,
      input.subject.flightId,
    ])
  ).rows[0];
  if (flightMission) validateBinding(flightMission, input);
  mission ??= flightMission;
  const missionId = mission?.id ?? randomUUID(),
    receiptId = randomUUID();
  if (!mission)
    await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'mission',$3)", [
      missionId,
      current.tenantId,
      input.payload.sourceMissionId,
    ]);
  const acceptedAuthority: MissionAuthority = {
    version: AUTHORITY_VERSION,
    principalId: current.id,
    tenantId: current.tenantId,
    principalRevision: current.revision,
    inputKind: 'mission.revision',
    sourceId: input.sourceId,
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    grantedSources: [...actor.mission_sources],
  };
  const acceptance: Omit<MissionRevisionRecord, 'id' | 'recordedAt'> = {
    version: 'flight.mission.1',
    missionId,
    flightId: input.subject.flightId,
    sourceId: input.sourceId,
    ...structuredClone(input.payload),
    sourceRevision: input.sourceRevision,
    occurredAt: input.occurredAt,
    receiptId,
    artifactId: input.artifactId,
    original: { sha256: verified.sha256, byteLength: verified.byteLength },
    contentDigest: verified.contentDigest,
    authority: acceptedAuthority,
  };
  const event = await appendEvent(client, current, {
    type: input.kind,
    stream: `source:${current.id}:${input.sourceId}`,
    sourceId: input.sourceId,
    occurredAt: input.occurredAt,
    artifactId: input.artifactId,
    payload: { ...input, flightId: input.subject.flightId, acceptedAuthority, acceptance },
  });
  const record: MissionRevisionRecord = { ...acceptance, id: event.id, recordedAt: event.received_at.toISOString() };
  await client.query(
    `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,source_revision,flight_id,artifact_id,link_status,payload,input_subject)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'linked',$11,$12)`,
    [
      receiptId,
      current.tenantId,
      event.id,
      input.sourceId,
      input.kind,
      input.occurredAt,
      event.received_at,
      input.sourceRevision,
      input.subject.flightId,
      input.artifactId,
      input.payload,
      input.subject,
    ],
  );
  if (!mission)
    await client.query(
      'INSERT INTO missions(id,tenant_id,source_id,source_mission_id,flight_id,aircraft_id,first_event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        missionId,
        current.tenantId,
        input.sourceId,
        input.payload.sourceMissionId,
        input.subject.flightId,
        input.payload.aircraftId,
        event.id,
      ],
    );
  await client.query(
    'INSERT INTO mission_revisions(id,tenant_id,mission_id,flight_id,source_revision,receipt_id,artifact_id,content_digest,record,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      event.id,
      current.tenantId,
      missionId,
      input.subject.flightId,
      input.sourceRevision,
      receiptId,
      input.artifactId,
      verified.contentDigest,
      record,
      event.received_at,
    ],
  );
  await retainSubjectEvidence(client, current.tenantId, [input.subject.flightId, missionId], event);
  if (!mission) await linkSubjectDependency(client, current.tenantId, input.subject.flightId, missionId, event.id);
  await client.query(
    'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [current.tenantId, input.subject.flightId],
  );
  await appendLiveChange(client, current.tenantId, input.subject.flightId, event.id, 'flight.updated', receiptId);
  return getReceipt(client, receiptId);
}

export async function projectMissionEvent(client: PoolClient, event: JournalEvent): Promise<void> {
  const authority = validateAcceptedMissionAuthority(event);
  const input = event.payload as MissionInput;
  normalizedInput(input);
  const flight = await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    event.tenant_id,
    input.subject.flightId,
  ]);
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const row = (
    await client.query<
      RevisionRow & {
        mission: MissionRow;
        flight_id: string;
        receipt_flight_id: string | null;
        receipt_artifact_id: string | null;
        receipt_event_id: string;
        receipt_kind: string;
        receipt_source_id: string;
        receipt_source_revision: string | null;
        receipt_payload: MissionInput['payload'];
        original_sha256: string;
        original_byte_length: number;
        link_status: string;
      }
    >(
      `SELECT r.*,row_to_json(m) AS mission,receipt.flight_id AS receipt_flight_id,receipt.artifact_id AS receipt_artifact_id,
     receipt.event_id AS receipt_event_id,receipt.kind AS receipt_kind,receipt.source_id AS receipt_source_id,
     receipt.source_revision AS receipt_source_revision,receipt.payload AS receipt_payload,receipt.link_status,
     a.sha256 AS original_sha256,a.byte_length AS original_byte_length
     FROM mission_revisions r JOIN missions m ON m.tenant_id=r.tenant_id AND m.id=r.mission_id
     JOIN receipts receipt ON receipt.tenant_id=r.tenant_id AND receipt.id=r.receipt_id
     JOIN artifacts a ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id WHERE r.tenant_id=$1 AND r.id=$2`,
      [event.tenant_id, event.id],
    )
  ).rows[0];
  if (!row) throw new DomainError(409, 'mission_acceptance_missing', 'The immutable mission acceptance is unavailable');
  const { id: recordId, recordedAt, ...acceptance } = row.record;
  if (
    recordId !== event.id ||
    recordedAt !== event.received_at.toISOString() ||
    row.receipt_event_id !== event.id ||
    row.record.receiptId !== row.receipt_id ||
    row.receipt_kind !== event.event_type ||
    row.receipt_source_id !== event.source_id ||
    Number(row.receipt_source_revision) !== row.record.sourceRevision ||
    row.receipt_flight_id !== row.flight_id ||
    row.link_status !== 'linked' ||
    row.receipt_artifact_id !== event.artifact_id ||
    row.record.artifactId !== event.artifact_id ||
    row.record.flightId !== row.flight_id ||
    event.payload.flightId !== row.flight_id ||
    event.payload.subject?.flightId !== row.flight_id ||
    row.record.missionId !== row.mission.id ||
    row.record.sourceRevision !== Number(row.source_revision) ||
    row.record.sourceId !== event.source_id ||
    input.sourceId !== event.source_id ||
    input.sourceRevision !== row.record.sourceRevision ||
    input.occurredAt !== row.record.occurredAt ||
    Date.parse(input.occurredAt) !== event.occurred_at?.getTime() ||
    canonicalDigest(input.payload) !==
      canonicalDigest({
        sourceMissionId: row.record.sourceMissionId,
        aircraftId: row.record.aircraftId,
        route: row.record.route,
        lateralToleranceMeters: row.record.lateralToleranceMeters,
        altitude: row.record.altitude,
        operatingInterval: row.record.operatingInterval,
        ...(row.record.routePlanning ? { routePlanning: row.record.routePlanning } : {}),
      }) ||
    row.record.contentDigest !== row.content_digest ||
    row.record.original.sha256 !== row.original_sha256 ||
    row.record.original.byteLength !== row.original_byte_length ||
    canonicalDigest(row.receipt_payload) !== canonicalDigest(input.payload) ||
    canonicalDigest(row.record.authority) !== canonicalDigest(authority) ||
    canonicalDigest(acceptance) !== canonicalDigest(event.payload.acceptance)
  )
    throw new DomainError(
      409,
      'mission_commitment_mismatch',
      'Mission acceptance differs from its immutable journal and receipt',
    );
  validateBinding(row.mission, input);
  await client.query(
    `INSERT INTO mission_projection_views(tenant_id,mission_id,flight_id,current_revision_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(tenant_id,mission_id) DO UPDATE SET current_revision_id=EXCLUDED.current_revision_id
     WHERE (SELECT source_revision FROM mission_revisions WHERE tenant_id=$1 AND id=mission_projection_views.current_revision_id)<$5`,
    [event.tenant_id, row.mission.id, row.flight_id, event.id, Number(row.source_revision)],
  );
}

function binding(row: MissionRow): MissionBinding {
  return {
    missionId: row.id,
    flightId: row.flight_id,
    sourceId: row.source_id,
    sourceMissionId: row.source_mission_id,
    aircraftId: row.aircraft_id,
  };
}
async function requireFlight(client: PoolClient, tenantId: string, flightId: string): Promise<void> {
  if (!(await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2', [tenantId, flightId])).rowCount)
    throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
}
export async function getFlightMission(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
): Promise<FlightMissionResponse> {
  await requireFlight(client, principal.tenantId, flightId);
  const row = (
    await client.query<{
      mission: MissionRow;
      accepted_record: MissionRevisionRecord | null;
      projected_record: MissionRevisionRecord | null;
      state: string | null;
      attempts: number | null;
      error: string | null;
    }>(
      `SELECT row_to_json(m) AS mission,a.record AS accepted_record,p.record AS projected_record,w.state,w.attempts,w.error
     FROM missions m LEFT JOIN LATERAL(SELECT r.id,r.record FROM mission_revisions r
      WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY r.source_revision DESC LIMIT 1)a ON true
     LEFT JOIN work_items w ON w.tenant_id=m.tenant_id AND w.event_id=a.id
     LEFT JOIN mission_projection_views v ON v.tenant_id=m.tenant_id AND v.mission_id=m.id
     LEFT JOIN mission_revisions p ON p.tenant_id=v.tenant_id AND p.id=v.current_revision_id
     WHERE m.tenant_id=$1 AND m.flight_id=$2`,
      [principal.tenantId, flightId],
    )
  ).rows[0];
  return {
    binding: row ? binding(row.mission) : null,
    acceptedHead: row?.accepted_record
      ? {
          record: row.accepted_record,
          processing: {
            status:
              row.state === 'completed'
                ? 'completed'
                : row.state === 'failed'
                  ? 'failed'
                  : row.state === 'leased'
                    ? 'processing'
                    : 'pending',
            attempts: row.attempts ?? 0,
            ...(row.error ? { error: row.error } : {}),
          },
        }
      : null,
    projectedHead: row?.projected_record ?? null,
    meta: await responseMeta(client, '', principal, undefined, flightId),
  };
}
export async function getFlightMissionRevision(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  sourceRevision: number,
): Promise<FlightMissionRevisionResponse> {
  await requireFlight(client, principal.tenantId, flightId);
  const row = (
    await client.query<{ record: MissionRevisionRecord }>(
      `SELECT r.record FROM missions m JOIN mission_revisions r ON r.tenant_id=m.tenant_id AND r.mission_id=m.id
     WHERE m.tenant_id=$1 AND m.flight_id=$2 AND r.source_revision=$3`,
      [principal.tenantId, flightId, sourceRevision],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'mission_revision_not_found',
      'The exact mission revision was not found within this flight',
    );
  return { mission: row.record };
}
