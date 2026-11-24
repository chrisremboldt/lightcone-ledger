import {
  MISSION_RELEASE_MAX_RECORD_BYTES,
  type MissionReleaseCommand,
  type MissionReleaseRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { assertMissionReleaseRecord } from './mission-release.js';

interface ReleaseMetadata {
  flight_id: string;
  record_digest: string;
  record_bytes: number;
  stream_name: string;
}

interface ReleaseProjectionRow {
  record: MissionReleaseRecord;
  command_kind: string | null;
  command_flight_id: string | null;
  command_actor_id: string | null;
  command_recorded_at: Date | null;
  command_payload: MissionReleaseCommand | null;
}

export async function projectMissionReleaseEvent(client: PoolClient, event: JournalEvent): Promise<void> {
  const flightId = event.payload.flightId;
  if (event.event_type !== 'mission.release' || typeof flightId !== 'string' || !flightId)
    throw new DomainError(
      400,
      'invalid_mission_release_event',
      'Only a recorded mission release can update its history',
    );
  const flight = await client.query<{ id: string }>(
    'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [event.tenant_id, flightId],
  );
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const metadata = (
    await client.query<ReleaseMetadata>(
      `SELECT r.flight_id,r.record_digest,octet_length(r.record::text) AS record_bytes,s.name AS stream_name
       FROM mission_releases r JOIN streams s ON s.tenant_id=r.tenant_id AND s.id=$3
       WHERE r.tenant_id=$1 AND r.id=$2 AND r.flight_id=$4`,
      [event.tenant_id, event.id, event.stream_id, flightId],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(409, 'mission_release_acceptance_missing', 'The immutable mission release is unavailable');
  if (metadata.record_bytes > MISSION_RELEASE_MAX_RECORD_BYTES)
    throw new DomainError(
      409,
      'mission_release_record_budget_exceeded',
      'The retained mission release exceeds its record budget',
    );
  const row = (
    await client.query<ReleaseProjectionRow>(
      `SELECT r.record,c.kind AS command_kind,c.flight_id AS command_flight_id,c.actor_id AS command_actor_id,
       c.recorded_at AS command_recorded_at,c.payload AS command_payload
       FROM mission_releases r LEFT JOIN command_records c ON c.tenant_id=r.tenant_id AND c.id=r.id
       WHERE r.tenant_id=$1 AND r.id=$2 AND r.flight_id=$3`,
      [event.tenant_id, event.id, flightId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(409, 'mission_release_acceptance_missing', 'The immutable mission release is unavailable');
  const record = row.record;
  assertMissionReleaseRecord(record);
  const { id, recordedAt, acceptedRevision, ...acceptance } = record;
  const mission = record.basis.mission;
  const expectedCommand: MissionReleaseCommand = {
    kind: 'mission.release',
    flightId: record.flightId,
    aircraftId: record.aircraftId,
    mission: {
      missionId: mission.missionId,
      sourceRevision: mission.sourceRevision,
      eventId: mission.id,
      contentDigest: mission.contentDigest,
      recordDigest: canonicalDigest(mission),
    },
    calculation: {
      id: record.basis.avoidance.calculation.id,
      version: record.basis.avoidance.calculation.version,
      digest: record.basis.avoidance.calculation.digest,
    },
    policy: { id: record.policy.id, version: record.policy.version, digest: record.policy.digest },
    expectedContextDigest: record.basis.avoidance.contextDigest,
    expectedFindingsDigest: record.basis.findings.digest,
    expectedPrincipalRevision: record.actor.principalRevision,
    departureWindow: record.departureWindow,
    note: record.note,
  };
  if (
    id !== event.id ||
    recordedAt !== event.received_at.toISOString() ||
    record.flightId !== flightId ||
    record.organizationId !== `organization:${event.tenant_id}` ||
    record.actor.id !== event.principal_id ||
    String(acceptedRevision) !== String(event.stream_sequence) ||
    metadata.stream_name !== `flight:${flightId}` ||
    canonicalDigest(record) !== metadata.record_digest ||
    row.command_kind !== 'mission.release' ||
    row.command_flight_id !== flightId ||
    row.command_actor_id !== event.principal_id ||
    row.command_recorded_at?.toISOString() !== recordedAt ||
    canonicalDigest(row.command_payload) !== canonicalDigest(expectedCommand) ||
    canonicalDigest(event.payload) !== canonicalDigest({ ...expectedCommand, acceptance, declaredSubjects: [flightId] })
  )
    throw new DomainError(
      409,
      'mission_release_commitment_mismatch',
      'Mission release differs from its immutable journal and command',
    );
  await client.query(
    `INSERT INTO mission_release_projection_views(tenant_id,release_id,flight_id,projected_at)
     VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING`,
    [event.tenant_id, id, flightId],
  );
}
