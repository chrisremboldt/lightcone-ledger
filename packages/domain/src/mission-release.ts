import {
  MISSION_RELEASE_MAX_RECORD_BYTES,
  type CommandRecord,
  type MissionReleaseAvoidance,
  type MissionReleaseCommand,
  type MissionReleaseRecord,
  type MissionReleaseRecordResponse,
  type MissionReleaseValidityResponse,
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
import { readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import { organization } from './adoptions.js';
import { getMissionAvoidanceSnapshot, type MissionAvoidanceSnapshot } from './mission-avoidance.js';
import { calculationMeta } from './mission-avoidance-kernel.js';
import { isRegisteredMissionReleasePolicy, missionReleasePolicy } from './mission-release-policy.js';
import { assertMissionReleaseRecord } from './mission-release-integrity.js';
import { readMissionReleaseFindings } from './mission-release-findings.js';
import { nextReleaseControlBoundary } from './mission-release-boundary.js';

export { assertMissionReleaseRecord } from './mission-release-integrity.js';

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
interface FlightRow {
  id: string;
  aircraft: string | null;
  basis_revision: string;
}
interface ReleaseMetadata {
  record_digest: string;
  byte_length: number;
  state: string | null;
  projected: boolean;
}
const requiredCapabilities = ['decision:write', 'flight:read', 'mission:release'] as const;

async function flightForRelease(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  mode: 'SHARE' | 'UPDATE' | 'NONE',
): Promise<FlightRow> {
  const row = (
    await client.query<FlightRow>(
      `SELECT id,aircraft,basis_revision FROM flight_views WHERE tenant_id=$1 AND id=$2${mode === 'NONE' ? '' : ` FOR ${mode}`}`,
      [principal.tenantId, flightId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  return row;
}

function utc(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function acceptedAvoidance(
  snapshot: MissionAvoidanceSnapshot,
  command: MissionReleaseCommand,
): MissionReleaseAvoidance {
  const preview = snapshot.preview;
  if (!preview.mission || canonicalDigest(preview.mission) !== canonicalDigest(command.mission))
    throw new DomainError(409, 'release_context_changed', 'The accepted mission changed; review its route again');
  if (preview.contextDigest && preview.contextDigest !== command.expectedContextDigest)
    throw new DomainError(409, 'release_context_changed', 'The recorded safety context changed; review it again');
  if (preview.status === 'intersects')
    throw new DomainError(
      409,
      'release_avoidance_intersection',
      'The planned route intersects an accepted avoidance circle',
    );
  if (
    !snapshot.mission ||
    preview.status !== 'outside' ||
    !preview.contextDigest ||
    preview.candidateCompleteness.status !== 'complete' ||
    preview.candidateCompleteness.count !== preview.candidates.length ||
    preview.candidateCompleteness.considered !== preview.candidates.length + preview.notApplicable.length ||
    preview.reasons.length ||
    preview.candidates.some(
      (candidate) =>
        candidate.context !== 'current' ||
        candidate.geometry !== 'outside' ||
        !candidate.authority ||
        candidate.reasons.length,
    ) ||
    // A control that does not apply was found so on current context by its rule; anything else applies.
    preview.notApplicable.some(
      (entry) =>
        entry.context !== 'current' ||
        !entry.authority ||
        entry.reasons.length ||
        entry.applicability.outcome !== 'does_not_apply' ||
        entry.applicability.basis !== 'rule',
    )
  )
    throw new DomainError(
      409,
      'release_evidence_pending',
      'Complete current mission and avoidance evidence is required',
    );
  return preview as MissionReleaseAvoidance;
}

export async function acceptMissionRelease(
  client: PoolClient,
  principal: AuthContext,
  command: MissionReleaseCommand,
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
      'Mission release requires decision, flight read and release authority',
    );
  const current = authFromRow(author);
  if (current.revision !== command.expectedPrincipalRevision)
    throw new DomainError(409, 'stale_authority', 'Authority changed; review the release again');
  const flight = await flightForRelease(client, current, command.flightId, 'UPDATE');
  const org = await organization(client, current.tenantId, 'SHARE');
  const subject = await client.query('SELECT id FROM subjects WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    current.tenantId,
    flight.id,
  ]);
  if (!subject.rowCount)
    throw new DomainError(404, 'subject_not_found', 'Evidence subject was not found within your scope');
  if (
    canonicalDigest(command.policy) !==
      canonicalDigest({
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      }) ||
    canonicalDigest(command.calculation) !==
      canonicalDigest({ id: calculationMeta.id, version: calculationMeta.version, digest: calculationMeta.digest })
  )
    throw new DomainError(
      409,
      'release_policy_changed',
      'Review the registered release policy and avoidance calculation',
    );
  const snapshot = await getMissionAvoidanceSnapshot(client, current, flight.id);
  const avoidance = acceptedAvoidance(snapshot, command);
  const mission = snapshot.mission!;
  if (flight.aircraft !== command.aircraftId || mission.aircraftId !== command.aircraftId)
    throw new DomainError(
      409,
      'release_context_changed',
      'The exact mission aircraft must match the current assignment',
    );
  const window = command.departureWindow;
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  if (
    !utc(window.start) ||
    !utc(window.end) ||
    Date.parse(window.start) >= Date.parse(window.end) ||
    Date.parse(window.start) < Date.parse(mission.operatingInterval.start) ||
    Date.parse(window.end) > Date.parse(mission.operatingInterval.end)
  )
    throw new DomainError(
      400,
      'invalid_departure_window',
      'Departure window must be nonempty and fit within the exact mission interval',
    );
  if (Date.parse(window.end) <= now)
    throw new DomainError(409, 'invalid_departure_window', 'The departure window has ended; review a new window');
  if (snapshot.nextBoundary && Date.parse(snapshot.nextBoundary) <= now)
    throw new DomainError(409, 'release_evidence_pending', 'The evaluated safety context reached its next boundary');
  const registerRevision = (
    await client.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
      current.tenantId,
    ])
  ).rows[0].revision;
  if (!command.expectedFindingsDigest)
    throw new DomainError(
      400,
      'release_findings_required',
      'Review the open findings for this flight; the release pins the list you saw',
    );
  const findings = (await readMissionReleaseFindings(client, current.tenantId, flight.id)).basis;
  if (findings.digest !== command.expectedFindingsDigest)
    throw new DomainError(
      409,
      'release_findings_changed',
      'The open findings for this flight changed; review them again',
      { findingsDigest: findings.digest },
    );
  const evidence = await readSubjectEvidence(client, flight.id, current);
  const acceptance: Omit<MissionReleaseRecord, 'id' | 'recordedAt' | 'acceptedRevision'> = {
    version: 'flight.mission-release.2',
    flightId: flight.id,
    organizationId: org.id,
    aircraftId: command.aircraftId,
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
      policyVersion: 'ledger.mission-release-authority.1',
      scope: { kind: 'flight', id: flight.id },
    },
    policy: { ...missionReleasePolicy },
    departureWindow: { ...window },
    note: command.note,
    basis: {
      mission,
      avoidance,
      candidateContexts: snapshot.candidateContexts as MissionReleaseRecord['basis']['candidateContexts'],
      notApplicableContexts: snapshot.notApplicableContexts as MissionReleaseRecord['basis']['notApplicableContexts'],
      renderedInputCut: { ...evidence.rendered, basisRevision: Number(flight.basis_revision) },
      acceptedInputCut: { ...evidence.accepted, basisRevision: Number(flight.basis_revision) },
      basisManifest: evidence.basisManifest,
      findings,
    },
  };
  const event = await appendEvent(client, current, {
    type: 'mission.release',
    stream: `flight:${flight.id}`,
    payload: { ...command, acceptance, declaredSubjects: [flight.id] },
  });
  const record: MissionReleaseRecord = {
    ...acceptance,
    id: event.id,
    recordedAt: event.received_at.toISOString(),
    acceptedRevision: Number(event.stream_sequence),
  };
  assertMissionReleaseRecord(record);
  const bytes = (await client.query<{ size: number }>('SELECT octet_length($1::jsonb::text) AS size', [record])).rows[0]
    .size;
  if (bytes > MISSION_RELEASE_MAX_RECORD_BYTES)
    throw new DomainError(
      409,
      'mission_release_record_budget_exceeded',
      'The retained mission release exceeds its record budget',
    );
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,flight_id,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [event.id, current.tenantId, command.kind, flight.id, current.id, event.received_at, command],
  );
  await client.query(
    `INSERT INTO mission_releases(id,tenant_id,flight_id,organization_id,mission_id,mission_revision_id,aircraft_id,actor_id,
     accepted_revision,departure_start,departure_end,register_revision,record,record_digest,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      record.id,
      current.tenantId,
      flight.id,
      record.organizationId,
      mission.missionId,
      mission.id,
      record.aircraftId,
      current.id,
      record.acceptedRevision,
      window.start,
      window.end,
      registerRevision,
      record,
      canonicalDigest(record),
      event.received_at,
    ],
  );
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
    recordedAt: record.recordedAt,
    payload: command,
  };
}

async function retainedRelease(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  releaseId: string,
  reading: boolean,
): Promise<{ response: MissionReleaseRecordResponse; metadata: ReleaseMetadata; flight: FlightRow }> {
  const flight = await flightForRelease(client, principal, flightId, reading ? 'NONE' : 'SHARE');
  const metadata = (
    await client.query<ReleaseMetadata>(
      `SELECT r.record_digest,octet_length(r.record::text) AS byte_length,w.state,p.release_id IS NOT NULL AS projected
       FROM mission_releases r LEFT JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.id
       LEFT JOIN mission_release_projection_views p ON p.tenant_id=r.tenant_id AND p.release_id=r.id AND p.flight_id=r.flight_id
       WHERE r.tenant_id=$1 AND r.flight_id=$2 AND r.id=$3`,
      [principal.tenantId, flightId, releaseId],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(404, 'mission_release_not_found', 'Mission release was not found within this flight');
  if (metadata.byte_length > MISSION_RELEASE_MAX_RECORD_BYTES)
    throw new DomainError(
      409,
      'mission_release_record_budget_exceeded',
      'The retained mission release exceeds its record budget',
    );
  const release = (
    await client.query<{ record: MissionReleaseRecord }>(
      'SELECT record FROM mission_releases WHERE tenant_id=$1 AND flight_id=$2 AND id=$3',
      [principal.tenantId, flightId, releaseId],
    )
  ).rows[0].record;
  assertMissionReleaseRecord(release);
  if (
    release.id !== releaseId ||
    release.flightId !== flightId ||
    release.organizationId !== `organization:${principal.tenantId}` ||
    canonicalDigest(release) !== metadata.record_digest
  )
    throw new DomainError(409, 'release_integrity_failure', 'The retained mission release commitment does not match');
  return { response: { release, digest: metadata.record_digest }, metadata, flight };
}

export async function getMissionRelease(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  releaseId: string,
): Promise<MissionReleaseRecordResponse> {
  return (await retainedRelease(client, principal, flightId, releaseId, true)).response;
}

export interface MissionReleaseState {
  release: MissionReleaseRecord;
  digest: string;
  snapshot: MissionAvoidanceSnapshot | null;
  /**
   * The earliest instant after evaluation at which an accepted control that can matter to this flight starts or ends
   * (`releaseControlBoundary`); null when none does or the release has expired.
   */
  controlBoundary: string | null;
  validity: MissionReleaseValidityResponse;
}

/** A command takes the locks the release's basis needs; a read at REPEATABLE READ passes `reading` and takes none. */
export async function getMissionReleaseState(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  releaseId: string,
  reading = false,
): Promise<MissionReleaseState> {
  const {
    response: { release, digest },
    metadata,
    flight,
  } = await retainedRelease(client, principal, flightId, releaseId, reading);
  const processing =
    metadata.state === 'leased'
      ? 'processing'
      : metadata.state === 'completed'
        ? 'completed'
        : metadata.state === 'failed'
          ? 'failed'
          : 'pending';
  let evaluatedAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  let snapshot: MissionAvoidanceSnapshot | null = null;
  let controlBoundary: string | null = null;
  const result = (
    status: MissionReleaseValidityResponse['status'],
    context: string | null,
    reasons: string[],
    boundary: string | null,
  ): MissionReleaseState => ({
    release,
    digest,
    snapshot,
    controlBoundary,
    validity: {
      release: { id: release.id, digest },
      evaluatedAt,
      status,
      processing,
      currentContextDigest: context,
      nextBoundary: boundary,
      reasons: [...new Set(reasons)].slice(0, 32),
    },
  });
  if (Date.parse(evaluatedAt) >= Date.parse(release.departureWindow.end))
    return result('expired', null, ['departure_window_expired'], null);
  snapshot = await getMissionAvoidanceSnapshot(client, principal, flightId, reading);
  evaluatedAt = snapshot.preview.evaluatedAt;
  if (Date.parse(evaluatedAt) >= Date.parse(release.departureWindow.end))
    return result('expired', null, ['departure_window_expired'], null);
  const preview = snapshot.preview;
  controlBoundary = await nextReleaseControlBoundary(client, principal.tenantId, release, evaluatedAt);
  const changes: string[] = [];
  const head = (
    await client.query<{ id: string }>(
      `SELECT r.id FROM missions m JOIN LATERAL(SELECT id FROM mission_revisions r
       WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY source_revision DESC LIMIT 1)r ON true
       WHERE m.tenant_id=$1 AND m.flight_id=$2`,
      [principal.tenantId, flightId],
    )
  ).rows[0];
  if (flight.aircraft !== release.aircraftId) changes.push('aircraft_changed');
  if (
    (head && head.id !== release.basis.mission.id) ||
    (snapshot.mission && canonicalDigest(snapshot.mission) !== canonicalDigest(release.basis.mission))
  )
    changes.push('mission_changed');
  if (
    !isRegisteredMissionReleasePolicy(release.policy) ||
    canonicalDigest(preview.calculation) !== canonicalDigest(release.basis.avoidance.calculation)
  )
    changes.push('release_policy_changed');
  const completeness = preview.candidateCompleteness;
  const released = release.basis.avoidance.candidateCompleteness;
  if (
    ((completeness.status === 'complete' ||
      completeness.count > completeness.limit ||
      completeness.considered > completeness.consideredLimit) &&
      (completeness.count !== released.count || completeness.considered !== released.considered)) ||
    (preview.contextDigest && preview.contextDigest !== release.basis.avoidance.contextDigest)
  )
    changes.push('safety_context_changed');
  const boundary =
    [release.departureWindow.start, release.departureWindow.end, controlBoundary]
      .filter((time): time is string => time !== null && Date.parse(time) > Date.parse(evaluatedAt))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  if (changes.length) return result('changed', preview.contextDigest, changes, boundary);
  if (preview.status !== 'outside' || !preview.contextDigest || preview.candidateCompleteness.status !== 'complete')
    return result('pending', preview.contextDigest, ['avoidance_evidence_pending', ...preview.reasons], boundary);
  if (!metadata.projected || metadata.state !== 'completed')
    return result(
      'pending',
      preview.contextDigest,
      [metadata.state === 'failed' ? 'release_projection_failed' : 'release_projection_pending'],
      boundary,
    );
  return result(
    Date.parse(evaluatedAt) < Date.parse(release.departureWindow.start) ? 'scheduled' : 'current',
    preview.contextDigest,
    [],
    boundary,
  );
}

export async function getMissionReleaseValidity(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  releaseId: string,
  reading = false,
): Promise<MissionReleaseValidityResponse> {
  return (await getMissionReleaseState(client, principal, flightId, releaseId, reading)).validity;
}
