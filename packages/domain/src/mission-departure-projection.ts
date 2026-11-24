import type { MissionDepartureAuthorizationCommand, MissionDeparturePermit } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { assertMissionDepartureAuthorization } from './mission-departure-integrity.js';
import { MISSION_DEPARTURE_MAX_RECORD_BYTES, type MissionDepartureIssuanceBasis } from './mission-departure-types.js';

interface AuthorizationMetadata {
  release_id: string;
  release_digest: string;
  departure_attempt_id: string;
  allocation_id: string;
  allocation_digest: string;
  actor_id: string;
  authorized_at: Date;
  valid_until: Date;
  recorded_at: Date;
  permit_digest: string;
  retained_release_digest: string;
  record_bytes: number;
  stream_name: string;
}

interface AuthorizationProjectionRow {
  permit: MissionDeparturePermit;
  issuance_basis: MissionDepartureIssuanceBasis;
  original_command: MissionDepartureAuthorizationCommand;
  command_kind: string | null;
  command_flight_id: string | null;
  command_actor_id: string | null;
  command_recorded_at: Date | null;
  command_payload: { permit: MissionDeparturePermit; digest: string } | null;
}

export async function projectMissionDepartureEvent(client: PoolClient, event: JournalEvent): Promise<void> {
  const flightId = event.payload.flightId;
  if (event.event_type !== 'mission.departure-authorize' || typeof flightId !== 'string' || !flightId)
    throw new DomainError(
      400,
      'invalid_mission_departure_event',
      'Only a departure authorization can update its history',
    );
  const flight = await client.query<{ id: string }>(
    'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [event.tenant_id, flightId],
  );
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const metadata = (
    await client.query<AuthorizationMetadata>(
      `SELECT a.release_id,a.release_digest,a.departure_attempt_id,a.allocation_id,a.allocation_digest,a.actor_id,
       a.authorized_at,a.valid_until,a.recorded_at,a.permit_digest,r.record_digest AS retained_release_digest,
       octet_length(a.permit::text)+octet_length(a.issuance_basis::text) AS record_bytes,s.name AS stream_name
       FROM mission_departure_authorizations a JOIN streams s ON s.tenant_id=a.tenant_id AND s.id=$3
       JOIN mission_releases r ON r.tenant_id=a.tenant_id AND r.id=a.release_id AND r.flight_id=a.flight_id
       WHERE a.tenant_id=$1 AND a.id=$2 AND a.flight_id=$4`,
      [event.tenant_id, event.id, event.stream_id, flightId],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(
      409,
      'mission_departure_acceptance_missing',
      'The immutable departure authorization is unavailable',
    );
  if (metadata.record_bytes > MISSION_DEPARTURE_MAX_RECORD_BYTES)
    throw new DomainError(
      409,
      'mission_departure_record_budget_exceeded',
      'The retained departure authorization exceeds its record budget',
    );
  const row = (
    await client.query<AuthorizationProjectionRow>(
      `SELECT a.permit,a.issuance_basis,a.original_command,c.kind AS command_kind,c.flight_id AS command_flight_id,
       c.actor_id AS command_actor_id,c.recorded_at AS command_recorded_at,c.payload AS command_payload
       FROM mission_departure_authorizations a LEFT JOIN command_records c ON c.tenant_id=a.tenant_id AND c.id=a.id
       WHERE a.tenant_id=$1 AND a.id=$2 AND a.flight_id=$3`,
      [event.tenant_id, event.id, flightId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      409,
      'mission_departure_acceptance_missing',
      'The immutable departure authorization is unavailable',
    );
  const permit = row.permit;
  const issuanceBasis = row.issuance_basis;
  assertMissionDepartureAuthorization(permit, issuanceBasis);
  const expectedCommand: MissionDepartureAuthorizationCommand = {
    kind: 'mission.departure-authorize',
    flightId: permit.flightId,
    aircraftId: permit.aircraftId,
    release: permit.release,
    departureAttemptId: permit.departureAttemptId,
    allocation: permit.allocation,
    expectedPrincipalRevision: permit.actor.principalRevision,
    // A command may leave the digest out only while no control is in scope.
    ...(row.original_command.expectedControlsDigest !== undefined ||
    issuanceBasis.controls.controls.length ||
    issuanceBasis.controls.notApplicable.length
      ? { expectedControlsDigest: issuanceBasis.controls.digest }
      : {}),
  };
  const { id, authorizedAt, validUntil, ...acceptedPermit } = permit;
  if (
    id !== event.id ||
    authorizedAt !== event.received_at.toISOString() ||
    permit.flightId !== flightId ||
    permit.actor.id !== event.principal_id ||
    issuanceBasis.release.organizationId !== `organization:${event.tenant_id}` ||
    metadata.stream_name !== `flight:${flightId}` ||
    metadata.authorized_at.getTime() !== event.received_at.getTime() ||
    metadata.recorded_at.getTime() !== event.received_at.getTime() ||
    metadata.valid_until.getTime() !== Date.parse(validUntil) ||
    metadata.release_id !== permit.release.id ||
    metadata.release_digest !== permit.release.digest ||
    metadata.retained_release_digest !== permit.release.digest ||
    metadata.departure_attempt_id !== permit.departureAttemptId ||
    metadata.allocation_id !== permit.allocation.id ||
    metadata.allocation_digest !== permit.allocation.digest ||
    metadata.actor_id !== permit.actor.id ||
    canonicalDigest(permit) !== metadata.permit_digest ||
    canonicalDigest(row.original_command) !== canonicalDigest(expectedCommand) ||
    row.command_kind !== 'mission.departure-authorize' ||
    row.command_flight_id !== flightId ||
    row.command_actor_id !== event.principal_id ||
    row.command_recorded_at?.getTime() !== event.received_at.getTime() ||
    canonicalDigest(row.command_payload) !== canonicalDigest({ permit, digest: metadata.permit_digest }) ||
    canonicalDigest(event.payload) !==
      canonicalDigest({
        ...expectedCommand,
        acceptance: { permit: acceptedPermit, issuanceBasis },
        declaredSubjects: [flightId],
      })
  )
    throw new DomainError(
      409,
      'mission_departure_commitment_mismatch',
      'Departure authorization differs from its immutable journal and command',
    );
  await client.query(
    `INSERT INTO mission_departure_projection_views(tenant_id,authorization_id,flight_id)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [event.tenant_id, id, flightId],
  );
}
