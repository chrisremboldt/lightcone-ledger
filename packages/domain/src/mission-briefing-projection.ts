import {
  MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES,
  MISSION_BRIEFING_MAX_RECORD_BYTES,
  MISSION_RELEASE_MAX_RECORD_BYTES,
  type ControlBody,
  type MissionBriefingAcknowledgementCommand,
  type MissionBriefingAcknowledgementRecord,
  type MissionBriefingCommand,
  type MissionBriefingRecord,
  type MissionReleaseRecord,
  missionBriefingControls,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type JournalEvent, type PoolClient } from '@ledger/persistence';
import {
  assertMissionBriefingAcknowledgementRecord,
  assertMissionBriefingRecord,
  briefingControlReference,
  controlRecordBriefingContent,
} from './mission-briefing-integrity.js';
import { assertMissionReleaseRecord } from './mission-release-integrity.js';

type BriefingRecord = MissionBriefingRecord | MissionBriefingAcknowledgementRecord;
type BriefingCommand = MissionBriefingCommand | MissionBriefingAcknowledgementCommand;

interface RecordMetadata {
  actor_id: string;
  record_digest: string;
  recorded_at: Date;
  record_bytes: number;
  stream_name: string;
}

interface CommandRow<T extends BriefingCommand> {
  command_kind: string | null;
  command_flight_id: string | null;
  command_actor_id: string | null;
  command_recorded_at: Date | null;
  command_payload: T | null;
}

interface BriefingMetadata extends RecordMetadata {
  organization_id: string;
  release_id: string;
  release_digest: string;
  retained_release_digest: string;
  valid_until: Date;
  release_bytes: number;
  control_bytes: number;
}

/** A briefed control as accepted: an area control record version. */
interface ControlVersion {
  eventId: string;
  recordId: string;
  versionNumber: number;
  bodyDigest: string;
  title: string;
  body: ControlBody;
}

interface BriefingRow extends CommandRow<MissionBriefingCommand> {
  record: MissionBriefingRecord;
  release: MissionReleaseRecord;
  control_versions: ControlVersion[] | null;
}

function retainedControlsMatch(record: MissionBriefingRecord, row: BriefingRow): boolean {
  return missionBriefingControls(record).every(({ reference, content }) => {
    const version = row.control_versions?.find((entry) => entry.eventId === reference.controlEventId);
    return (
      version !== undefined &&
      version.recordId === reference.controlId &&
      version.versionNumber === reference.controlVersion &&
      version.bodyDigest === reference.controlDigest &&
      version.body.hazardId === reference.hazardId &&
      canonicalDigest(content) === canonicalDigest(controlRecordBriefingContent(version) ?? null)
    );
  });
}

/** The control version events a briefing record lists, as SQL over the briefing row aliased b. */
const listedControlEvents = `SELECT entry->>'controlEventId' FROM jsonb_array_elements(b.record#>'{context,controls}') entry`;

interface AcknowledgementMetadata extends RecordMetadata {
  briefing_id: string;
  briefing_digest: string;
  population_digest: string;
  recipient_principal_id: string;
  retained_briefing_digest: string;
  briefing_valid_until: Date;
  briefing_bytes: number;
}

interface AcknowledgementRow extends CommandRow<MissionBriefingAcknowledgementCommand> {
  record: MissionBriefingAcknowledgementRecord;
  briefing: MissionBriefingRecord;
}

/** Every control the briefing lists is an exact candidate of its release, once and in the release's order. */
function listsReleasedCandidates(record: MissionBriefingRecord, release: MissionReleaseRecord): boolean {
  const references = release.basis.avoidance.candidates.map((candidate) =>
    canonicalDigest(briefingControlReference(candidate)),
  );
  const positions = missionBriefingControls(record).map(({ reference }) =>
    references.indexOf(canonicalDigest(reference)),
  );
  return positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!));
}

function mismatch(): DomainError {
  return new DomainError(
    409,
    'mission_briefing_commitment_mismatch',
    'Briefing history differs from its immutable acceptance and command',
  );
}

function assertCommitment(
  event: JournalEvent,
  record: BriefingRecord,
  metadata: RecordMetadata,
  row: CommandRow<BriefingCommand>,
  command: BriefingCommand,
): void {
  const { id, recordedAt, ...acceptance } = record;
  if (
    id !== event.id ||
    recordedAt !== event.received_at.toISOString() ||
    record.flightId !== event.payload.flightId ||
    record.actor.id !== event.principal_id ||
    metadata.actor_id !== event.principal_id ||
    metadata.recorded_at.getTime() !== event.received_at.getTime() ||
    metadata.stream_name !== `flight:${record.flightId}` ||
    canonicalDigest(record) !== metadata.record_digest ||
    row.command_kind !== event.event_type ||
    row.command_flight_id !== record.flightId ||
    row.command_actor_id !== event.principal_id ||
    row.command_recorded_at?.getTime() !== event.received_at.getTime() ||
    canonicalDigest(row.command_payload) !== canonicalDigest(command) ||
    canonicalDigest(event.payload) !== canonicalDigest({ ...command, acceptance, declaredSubjects: [record.flightId] })
  )
    throw mismatch();
}

async function projectBriefing(client: PoolClient, event: JournalEvent, flightId: string): Promise<void> {
  const metadata = (
    await client.query<BriefingMetadata>(
      `SELECT b.actor_id,b.record_digest,b.recorded_at,octet_length(b.record::text) AS record_bytes,
       b.organization_id,b.release_id,b.release_digest,b.valid_until,r.record_digest AS retained_release_digest,
       octet_length(r.record::text) AS release_bytes,
       (SELECT COALESCE(max(octet_length(v.body::text)),0) FROM sms_record_versions v WHERE v.tenant_id=b.tenant_id
        AND v.schema='sms.control.1' AND v.id IN (${listedControlEvents})) AS control_bytes,
       s.name AS stream_name
       FROM mission_briefings b JOIN streams s ON s.tenant_id=b.tenant_id AND s.id=$3
       JOIN mission_releases r ON r.tenant_id=b.tenant_id AND r.id=b.release_id AND r.flight_id=b.flight_id
       WHERE b.tenant_id=$1 AND b.id=$2 AND b.flight_id=$4`,
      [event.tenant_id, event.id, event.stream_id, flightId],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(409, 'mission_briefing_acceptance_missing', 'The immutable briefing context is unavailable');
  if (
    metadata.record_bytes > MISSION_BRIEFING_MAX_RECORD_BYTES ||
    metadata.release_bytes > MISSION_RELEASE_MAX_RECORD_BYTES ||
    metadata.control_bytes > MISSION_RELEASE_MAX_RECORD_BYTES
  )
    throw new DomainError(
      409,
      'mission_briefing_record_budget_exceeded',
      'The retained briefing context exceeds its record budget',
    );
  const row = (
    await client.query<BriefingRow>(
      `SELECT b.record,r.record AS release,
       (SELECT jsonb_agg(jsonb_build_object('eventId',v.id,'recordId',v.record_id,'versionNumber',v.version_number,
         'bodyDigest',v.body_digest,'title',v.title,'body',v.body))
        FROM sms_record_versions v WHERE v.tenant_id=b.tenant_id AND v.schema='sms.control.1'
         AND v.id IN (${listedControlEvents})) AS control_versions,
       c.kind AS command_kind,c.flight_id AS command_flight_id,
       c.actor_id AS command_actor_id,c.recorded_at AS command_recorded_at,c.payload AS command_payload
       FROM mission_briefings b JOIN mission_releases r
       ON r.tenant_id=b.tenant_id AND r.id=b.release_id AND r.flight_id=b.flight_id
       LEFT JOIN command_records c ON c.tenant_id=b.tenant_id AND c.id=b.id
       WHERE b.tenant_id=$1 AND b.id=$2 AND b.flight_id=$3`,
      [event.tenant_id, event.id, flightId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(409, 'mission_briefing_acceptance_missing', 'The immutable briefing context is unavailable');
  const { record, release } = row;
  assertMissionBriefingRecord(record);
  assertMissionReleaseRecord(release);
  const recipientIds = row.command_payload?.recipientPrincipalIds;
  if (
    !Array.isArray(recipientIds) ||
    canonicalDigest([...recipientIds].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) !==
      canonicalDigest(record.population.recipients.map(({ principalId }) => principalId))
  )
    throw mismatch();
  const command = {
    kind: 'mission.brief',
    flightId: record.flightId,
    purpose: record.purpose,
    release: record.context.release,
    controls: record.context.controls,
    recipientPrincipalIds: recipientIds,
    message: record.content.message,
    expectedPrincipalRevision: record.actor.principalRevision,
    ...(record.controls ? { expectedControlsDigest: record.controls.digest } : {}),
  } as MissionBriefingCommand;
  assertCommitment(event, record, metadata, row, command);
  if (
    !listsReleasedCandidates(record, release) ||
    !Number.isFinite(metadata.valid_until.getTime()) ||
    event.received_at.getTime() >= metadata.valid_until.getTime() ||
    metadata.organization_id !== `organization:${event.tenant_id}` ||
    record.organizationId !== metadata.organization_id ||
    release.organizationId !== metadata.organization_id ||
    metadata.release_id !== record.context.release.id ||
    release.id !== metadata.release_id ||
    metadata.release_digest !== record.context.release.digest ||
    metadata.retained_release_digest !== record.context.release.digest ||
    canonicalDigest(release) !== record.context.release.digest ||
    canonicalDigest(record.context.mission) !== canonicalDigest(release.basis.avoidance.mission) ||
    record.context.aircraftId !== release.aircraftId ||
    record.context.contextDigest !== release.basis.avoidance.contextDigest ||
    canonicalDigest(record.context.releasePolicy) !==
      canonicalDigest({ id: release.policy.id, version: release.policy.version, digest: release.policy.digest }) ||
    !retainedControlsMatch(record, row)
  )
    throw mismatch();
  await client.query(
    `INSERT INTO mission_briefing_projection_views(tenant_id,briefing_id,flight_id,projected_at)
     VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING`,
    [event.tenant_id, record.id, flightId],
  );
}

async function projectAcknowledgement(client: PoolClient, event: JournalEvent, flightId: string): Promise<void> {
  const metadata = (
    await client.query<AcknowledgementMetadata>(
      `SELECT a.actor_id,a.record_digest,a.recorded_at,octet_length(a.record::text) AS record_bytes,
       a.briefing_id,a.briefing_digest,a.population_digest,a.recipient_principal_id,
       b.record_digest AS retained_briefing_digest,b.valid_until AS briefing_valid_until,
       octet_length(b.record::text) AS briefing_bytes,s.name AS stream_name
       FROM mission_briefing_acknowledgements a JOIN streams s ON s.tenant_id=a.tenant_id AND s.id=$3
       JOIN mission_briefings b ON b.tenant_id=a.tenant_id AND b.id=a.briefing_id AND b.flight_id=a.flight_id
       WHERE a.tenant_id=$1 AND a.id=$2 AND a.flight_id=$4`,
      [event.tenant_id, event.id, event.stream_id, flightId],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(
      409,
      'mission_briefing_acknowledgement_acceptance_missing',
      'The immutable acknowledgement context is unavailable',
    );
  if (
    metadata.record_bytes > MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES ||
    metadata.briefing_bytes > MISSION_BRIEFING_MAX_RECORD_BYTES
  )
    throw new DomainError(
      409,
      'mission_briefing_record_budget_exceeded',
      'The retained acknowledgement context exceeds its record budget',
    );
  const row = (
    await client.query<AcknowledgementRow>(
      `SELECT a.record,b.record AS briefing,c.kind AS command_kind,c.flight_id AS command_flight_id,
       c.actor_id AS command_actor_id,c.recorded_at AS command_recorded_at,c.payload AS command_payload
       FROM mission_briefing_acknowledgements a JOIN mission_briefings b
       ON b.tenant_id=a.tenant_id AND b.id=a.briefing_id AND b.flight_id=a.flight_id
       LEFT JOIN command_records c ON c.tenant_id=a.tenant_id AND c.id=a.id
       WHERE a.tenant_id=$1 AND a.id=$2 AND a.flight_id=$3`,
      [event.tenant_id, event.id, flightId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      409,
      'mission_briefing_acknowledgement_acceptance_missing',
      'The immutable acknowledgement context is unavailable',
    );
  const { record, briefing } = row;
  assertMissionBriefingRecord(briefing);
  assertMissionBriefingAcknowledgementRecord(record, briefing);
  const command: MissionBriefingAcknowledgementCommand = {
    kind: 'mission.briefing-acknowledge',
    flightId: record.flightId,
    briefing: record.briefing,
    populationDigest: record.populationDigest,
    attestation: record.attestation,
    expectedPrincipalRevision: record.actor.principalRevision,
  };
  assertCommitment(event, record, metadata, row, command);
  if (
    briefing.organizationId !== `organization:${event.tenant_id}` ||
    briefing.flightId !== flightId ||
    metadata.briefing_id !== briefing.id ||
    metadata.briefing_digest !== record.briefing.digest ||
    metadata.retained_briefing_digest !== record.briefing.digest ||
    canonicalDigest(briefing) !== record.briefing.digest ||
    metadata.population_digest !== record.populationDigest ||
    metadata.population_digest !== briefing.population.digest ||
    metadata.recipient_principal_id !== record.recipientPrincipalId ||
    record.recipientPrincipalId !== event.principal_id ||
    event.received_at.getTime() >= metadata.briefing_valid_until.getTime()
  )
    throw mismatch();
  await client.query(
    `INSERT INTO mission_briefing_acknowledgement_projection_views(tenant_id,acknowledgement_id,flight_id,projected_at)
     VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING`,
    [event.tenant_id, record.id, flightId],
  );
}

export async function projectMissionBriefingEvent(client: PoolClient, event: JournalEvent): Promise<void> {
  const flightId = event.payload.flightId;
  if (
    !['mission.brief', 'mission.briefing-acknowledge'].includes(event.event_type) ||
    typeof flightId !== 'string' ||
    !flightId
  )
    throw new DomainError(
      400,
      'invalid_mission_briefing_event',
      'Only a briefing or personal acknowledgement can update its history',
    );
  const flight = await client.query<{ id: string }>(
    'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [event.tenant_id, flightId],
  );
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  if (event.event_type === 'mission.brief') await projectBriefing(client, event, flightId);
  else await projectAcknowledgement(client, event, flightId);
}
