import {
  type CommandRecord,
  type MissionDepartureAuthorizationCommand,
  type MissionDepartureAuthorizationResult,
  type MissionDeparturePermit,
  type MissionReleaseAvoidance,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  appendEvent,
  appendLiveChange,
  authFromRow,
  DomainError,
  type AuthContext,
  type PoolClient,
} from '@ledger/persistence';
import { organization } from './adoptions.js';
import { readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import { getMissionReleaseState } from './mission-release.js';
import { controlsSeenForCommand, noControlsSeen } from './mission-release-controls.js';
import { missionDeparturePolicy } from './mission-departure-policy.js';
import { assertMissionDepartureAuthorization } from './mission-departure-integrity.js';
import { MISSION_DEPARTURE_MAX_RECORD_BYTES, type MissionDepartureIssuanceBasis } from './mission-departure-types.js';

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
interface DepartureRow {
  permit: MissionDeparturePermit;
  permit_digest: string;
  issuance_basis: MissionDepartureIssuanceBasis;
}
const requiredCapabilities = ['decision:write', 'flight:read', 'mission:release'] as const;

/** The route review a departure re-checked, without the controls that do not apply: its release records them. */
function reviewedWithoutNotApplicable(preview: MissionReleaseAvoidance): MissionDepartureIssuanceBasis['avoidance'] {
  const { notApplicable: _notApplicable, ...reviewed } = preview;
  return reviewed;
}

export async function acceptMissionDeparture(
  client: PoolClient,
  principal: AuthContext,
  command: MissionDepartureAuthorizationCommand,
): Promise<CommandRecord> {
  const author = (
    await client.query<PrincipalRow>(
      `SELECT id,tenant_id,name,kind,capabilities,command_link_sources,mission_sources,revision
       FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`,
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!author) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  if (!requiredCapabilities.every((capability) => author.capabilities.includes(capability)))
    throw new DomainError(
      403,
      'capability_required',
      'Departure authorization requires decision, flight read and release authority',
    );
  const current = authFromRow(author);
  const flight = (
    await client.query<{ id: string; aircraft: string | null; basis_revision: string }>(
      'SELECT id,aircraft,basis_revision FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [current.tenantId, command.flightId],
    )
  ).rows[0];
  if (!flight) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  await organization(client, current.tenantId, 'SHARE');
  await client.query('SELECT id FROM subjects WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [current.tenantId, flight.id]);
  if (
    (
      await client.query('SELECT id FROM mission_departure_authorizations WHERE tenant_id=$1 AND flight_id=$2', [
        current.tenantId,
        flight.id,
      ])
    ).rowCount
  )
    throw new DomainError(
      409,
      'departure_flight_already_authorized',
      'This flight already has its only departure authorization',
    );
  if (current.revision !== command.expectedPrincipalRevision)
    throw new DomainError(409, 'stale_authority', 'Authority changed; review departure authorization again');
  const state = await getMissionReleaseState(client, current, flight.id, command.release.id);
  if (
    state.digest !== command.release.digest ||
    state.release.aircraftId !== command.aircraftId ||
    flight.aircraft !== command.aircraftId
  )
    throw new DomainError(
      409,
      'departure_release_not_current',
      'Review the exact release and assigned aircraft before departure',
    );
  if (state.validity.status !== 'current' || !state.snapshot)
    throw new DomainError(409, 'departure_release_not_current', 'Departure requires a current completed release', {
      status: state.validity.status,
      reasons: state.validity.reasons,
    });
  const snapshot = state.snapshot;
  const evidence = await readSubjectEvidence(client, flight.id, current);
  // An authorization pins the controls list its authorizer saw; with none in scope that list is empty.
  const controls =
    (await controlsSeenForCommand(client, current, flight.id, command.expectedControlsDigest)) ?? noControlsSeen();
  const issuanceBasis: MissionDepartureIssuanceBasis = {
    version: 'mission.departure-issuance.2',
    release: state.release,
    avoidance: reviewedWithoutNotApplicable(snapshot.preview as MissionReleaseAvoidance),
    candidateContexts: snapshot.candidateContexts as MissionDepartureIssuanceBasis['candidateContexts'],
    renderedInputCut: { ...evidence.rendered, basisRevision: Number(flight.basis_revision) },
    acceptedInputCut: { ...evidence.accepted, basisRevision: Number(flight.basis_revision) },
    basisManifest: evidence.basisManifest,
    controls,
  };
  const staticPermit: Omit<MissionDeparturePermit, 'id' | 'authorizedAt' | 'validUntil'> = {
    version: 'flight.mission-departure-permit.1',
    flightId: flight.id,
    aircraftId: command.aircraftId,
    release: { ...command.release },
    mission: state.release.basis.avoidance.mission,
    contextDigest: state.release.basis.avoidance.contextDigest,
    departureAttemptId: command.departureAttemptId,
    allocation: { ...command.allocation },
    policy: { ...missionDeparturePolicy },
    actor: {
      id: author.id,
      name: author.name,
      kind: author.kind,
      active: true,
      principalRevision: current.revision,
      capabilities: [...author.capabilities],
      commandLinkSources: [...author.command_link_sources],
      missionSources: [...author.mission_sources],
      checkedCapabilities: [...requiredCapabilities],
      policyVersion: 'ledger.mission-departure-authority.1',
      scope: { kind: 'flight', id: flight.id },
    },
  };
  const registerRevision = (
    await client.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
      current.tenantId,
    ])
  ).rows[0].revision;
  const event = await appendEvent(client, current, {
    type: command.kind,
    stream: `flight:${flight.id}`,
    payload: { ...command, acceptance: { permit: staticPermit, issuanceBasis }, declaredSubjects: [flight.id] },
  });
  const authorizedAt = event.received_at.toISOString();
  // A lease never outlives the basis it was issued on. Besides the release window, that basis changes without any
  // new decision where one of the organization's accepted controls starts or stops being in force; the snapshot read
  // the earliest such instant after its evaluation. All of the organization's controls count, not only those in
  // scope for this flight: the earlier end is the safe one.
  const validUntil = new Date(
    Math.min(
      event.received_at.getTime() + missionDeparturePolicy.permitSeconds * 1000,
      Date.parse(state.release.departureWindow.end),
      ...(snapshot.nextBoundary ? [Date.parse(snapshot.nextBoundary)] : []),
    ),
  ).toISOString();
  if (
    Date.parse(validUntil) <= event.received_at.getTime() ||
    event.received_at.getTime() < Date.parse(state.release.departureWindow.start)
  )
    throw new DomainError(
      409,
      'departure_release_not_current',
      'The release or evaluated context reached its departure boundary',
    );
  const permit: MissionDeparturePermit = { ...staticPermit, id: event.id, authorizedAt, validUntil };
  assertMissionDepartureAuthorization(permit, issuanceBasis);
  const digest = canonicalDigest(permit);
  const size = (
    await client.query<{ size: number }>('SELECT octet_length($1::jsonb::text)+octet_length($2::jsonb::text) AS size', [
      permit,
      issuanceBasis,
    ])
  ).rows[0].size;
  if (size > MISSION_DEPARTURE_MAX_RECORD_BYTES)
    throw new DomainError(
      409,
      'departure_record_budget_exceeded',
      'The retained departure authorization exceeds its record budget',
    );
  const payload = { permit, digest };
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,flight_id,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [event.id, current.tenantId, command.kind, flight.id, current.id, event.received_at, payload],
  );
  try {
    await client.query(
      `INSERT INTO mission_departure_authorizations(id,tenant_id,flight_id,release_id,release_digest,departure_attempt_id,
       allocation_id,allocation_digest,actor_id,authorized_at,valid_until,register_revision,permit,permit_digest,issuance_basis,original_command,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        event.id,
        current.tenantId,
        flight.id,
        command.release.id,
        command.release.digest,
        command.departureAttemptId,
        command.allocation.id,
        command.allocation.digest,
        current.id,
        authorizedAt,
        validUntil,
        registerRevision,
        permit,
        digest,
        issuanceBasis,
        command,
        event.received_at,
      ],
    );
  } catch (error) {
    const violation = error as { code?: string; constraint?: string };
    if (violation.code === '23505') {
      switch (violation.constraint) {
        case 'mission_departure_one_per_flight':
          throw new DomainError(
            409,
            'departure_flight_already_authorized',
            'This flight already has its only departure authorization',
          );
        case 'mission_departure_attempt_binding':
          throw new DomainError(
            409,
            'departure_attempt_conflict',
            'This departure attempt already has an authorization',
          );
        case 'mission_departure_allocation_binding':
          throw new DomainError(
            409,
            'departure_allocation_conflict',
            'This allocation already has a departure authorization',
          );
        default:
          throw new DomainError(
            409,
            'departure_uniqueness_conflict',
            'Departure authorization conflicts with an existing record',
          );
      }
    }
    throw error;
  }
  await retainSubjectEvidence(client, current.tenantId, [flight.id], event);
  await client.query(
    'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=$1 WHERE tenant_id=$2 AND id=$3',
    [event.received_at, current.tenantId, flight.id],
  );
  await appendLiveChange(client, current.tenantId, flight.id, event.id, 'flight.updated');
  return {
    id: event.id,
    kind: command.kind,
    flightId: flight.id,
    actorId: current.id,
    recordedAt: authorizedAt,
    payload,
  };
}

export async function getMissionDepartureAuthorization(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  commandId: string,
  disposition: 'issued' | 'replayed',
): Promise<MissionDepartureAuthorizationResult> {
  const metadata = (
    await client.query<{ size: number; valid_until: Date }>(
      `SELECT octet_length(permit::text)+octet_length(issuance_basis::text) AS size,valid_until
       FROM mission_departure_authorizations WHERE tenant_id=$1 AND id=$2 AND flight_id=$3 AND actor_id=$4`,
      [principal.tenantId, commandId, flightId, principal.id],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(
      404,
      'departure_authorization_not_found',
      'Departure authorization was not found within your scope',
    );
  if (metadata.size > MISSION_DEPARTURE_MAX_RECORD_BYTES)
    throw new DomainError(
      409,
      'departure_record_budget_exceeded',
      'The retained departure authorization exceeds its record budget',
    );
  const row = (
    await client.query<DepartureRow>(
      'SELECT permit,permit_digest,issuance_basis FROM mission_departure_authorizations WHERE tenant_id=$1 AND id=$2 AND flight_id=$3 AND actor_id=$4',
      [principal.tenantId, commandId, flightId, principal.id],
    )
  ).rows[0];
  assertMissionDepartureAuthorization(row.permit, row.issuance_basis);
  if (
    canonicalDigest(row.permit) !== row.permit_digest ||
    row.permit.id !== commandId ||
    row.permit.flightId !== flightId ||
    row.permit.actor.id !== principal.id ||
    row.permit.validUntil !== metadata.valid_until.toISOString()
  )
    throw new DomainError(
      409,
      'departure_integrity_failure',
      'The retained departure authorization commitment does not match',
    );
  const evaluatedAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  if (Date.parse(evaluatedAt) >= metadata.valid_until.getTime())
    throw new DomainError(
      409,
      'departure_permit_expired',
      'The original departure authorization expired; this flight remains held',
    );
  return { permit: row.permit, digest: row.permit_digest, evaluatedAt, disposition };
}
