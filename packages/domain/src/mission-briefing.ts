import {
  MISSION_BRIEFING_MAX_RECORD_BYTES,
  MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES,
  MISSION_BRIEFING_ACKNOWLEDGEMENTS_MAX_READ_BYTES,
  MISSION_BRIEFING_MAX_CONTROLS,
  MISSION_BRIEFING_MAX_RECIPIENTS,
  MISSION_RELEASE_MAX_RECORD_BYTES,
  type CommandRecord,
  type ControlBody,
  type MissionAvoidanceCandidate,
  type MissionBriefingCommand,
  type MissionBriefingControlRecordContent,
  type MissionBriefingRecord,
  type MissionBriefingRecordResponse,
  type MissionBriefingAcknowledgementCommand,
  type MissionBriefingAcknowledgementRecord,
  type MissionBriefingAcknowledgementsResponse,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import {
  appendEvent,
  appendLiveChange,
  authFromRow,
  DomainError,
  type AuthContext,
  type PoolClient,
} from '@ledger/persistence';
import { organization } from './adoptions.js';
import { briefingLapsed, briefingStandingNow } from './briefing-standing.js';
import { retainSubjectEvidence } from './cuts.js';
import { getMissionReleaseState } from './mission-release.js';
import { controlsSeenForCommand } from './mission-release-controls.js';
import {
  assertMissionBriefingRecord,
  assertMissionBriefingAcknowledgementRecord,
  briefingControlReference,
  controlRecordBriefingContent,
} from './mission-briefing-integrity.js';

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
interface BriefingMetadata {
  record_digest: string;
  release_id: string;
  release_digest: string;
  byte_length: number;
}
interface AcknowledgementMetadata {
  id: string;
  record_digest: string;
  recipient_principal_id: string;
  byte_length: number;
  state: string | null;
  projected: boolean;
}
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);

async function authorForCommand(
  client: PoolClient,
  principal: AuthContext,
  expectedRevision: number,
  acknowledge: boolean,
): Promise<PrincipalRow> {
  const author = (
    await client.query<PrincipalRow>(
      'SELECT id,tenant_id,name,kind,capabilities,command_link_sources,mission_sources,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!author) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  const capability = acknowledge ? 'briefing:ack' : 'briefing:write';
  if (
    !author.capabilities.includes('flight:read') ||
    !author.capabilities.includes(capability) ||
    (acknowledge && author.kind !== 'human')
  )
    throw new DomainError(
      403,
      'capability_required',
      'Briefing requires current flight read and personal briefing authority',
    );
  if (Number(author.revision) !== expectedRevision)
    throw new DomainError(409, 'stale_authority', 'Authority changed; review this action again');
  return author;
}
function actor(author: PrincipalRow, flightId: string): MissionBriefingRecord['actor'] {
  return {
    id: author.id,
    name: author.name,
    kind: author.kind,
    active: true,
    principalRevision: Number(author.revision),
    capabilities: [...author.capabilities],
    checkedCapabilities: ['flight:read', 'briefing:write'],
    policyVersion: 'ledger.mission-briefing-authority.1',
    scope: { kind: 'flight', id: flightId },
  };
}
/** A briefing command passes `UPDATE`; a read at REPEATABLE READ passes `NONE`, since its snapshot is consistent. */
async function flightForBriefing(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  lock: 'NONE' | 'SHARE' | 'UPDATE',
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2${lock === 'NONE' ? '' : ` FOR ${lock}`}`,
    [principal.tenantId, flightId],
  );
  if (!result.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  if (lock === 'UPDATE') {
    await organization(client, principal.tenantId, 'SHARE');
    const subject = await client.query('SELECT id FROM subjects WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      principal.tenantId,
      flightId,
    ]);
    if (!subject.rowCount)
      throw new DomainError(404, 'subject_not_found', 'Evidence subject was not found within your scope');
  }
}
/** A record as accepted, before its event gives it an id and a time; for each record version. */
type Accepted<T> = T extends unknown ? Omit<T, 'id' | 'recordedAt'> : never;

async function retainCommand(
  client: PoolClient,
  principal: AuthContext,
  command: MissionBriefingCommand | MissionBriefingAcknowledgementCommand,
  acceptance: Accepted<MissionBriefingRecord> | Accepted<MissionBriefingAcknowledgementRecord>,
): Promise<{ record: CommandRecord; event: Awaited<ReturnType<typeof appendEvent>> }> {
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `flight:${command.flightId}`,
    payload: { ...command, acceptance, declaredSubjects: [command.flightId] },
  });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,flight_id,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [event.id, principal.tenantId, command.kind, command.flightId, principal.id, event.received_at, command],
  );
  await retainSubjectEvidence(client, principal.tenantId, [command.flightId], event);
  await client.query(
    'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=$1 WHERE tenant_id=$2 AND id=$3',
    [event.received_at, principal.tenantId, command.flightId],
  );
  await appendLiveChange(client, principal.tenantId, command.flightId, event.id, 'flight.updated');
  return {
    event,
    record: {
      id: event.id,
      kind: command.kind,
      flightId: command.flightId,
      actorId: principal.id,
      recordedAt: event.received_at.toISOString(),
      payload: command,
    },
  };
}
async function checkRecordBytes(client: PoolClient, record: unknown, maximum: number): Promise<void> {
  const { size } = (await client.query<{ size: number }>('SELECT octet_length($1::jsonb::text) AS size', [record]))
    .rows[0];
  if (size > maximum)
    throw new DomainError(
      409,
      'briefing_record_budget_exceeded',
      'The retained briefing record exceeds its byte budget',
    );
}

const budgetExceeded = () =>
  new DomainError(
    409,
    'briefing_record_budget_exceeded',
    'The exact control record is unavailable within its byte budget',
  );

/** The briefed content of a released candidate: the exact version of an area control record it names. */
async function briefedControlContent(
  client: PoolClient,
  tenantId: string,
  candidate: MissionAvoidanceCandidate,
): Promise<MissionBriefingControlRecordContent> {
  const version = (
    await client.query<{ title: string; body: ControlBody; size: number }>(
      `SELECT title,body,octet_length(body::text) AS size FROM sms_record_versions
       WHERE tenant_id=$1 AND id=$2 AND record_id=$3 AND version_number=$4 AND body_digest=$5 AND schema='sms.control.1'`,
      [tenantId, candidate.controlEventId, candidate.controlId, candidate.controlVersion, candidate.controlDigest],
    )
  ).rows[0];
  if (!version || version.size > MISSION_RELEASE_MAX_RECORD_BYTES) throw budgetExceeded();
  const content = version.body.hazardId === candidate.hazardId ? controlRecordBriefingContent(version) : undefined;
  if (!content)
    throw new DomainError(409, 'briefing_control_mismatch', 'The retained control does not match this release');
  return content;
}

const controlsInvalid = (message: string) => new DomainError(400, 'briefing_controls_invalid', message);

/**
 * The release candidates a briefing lists: each an exact candidate of the release, named once, in the release's order.
 */
function briefedCandidates(
  candidates: MissionAvoidanceCandidate[],
  listed: MissionBriefingCommand['controls'],
): MissionAvoidanceCandidate[] {
  if (!Array.isArray(listed) || !listed.length || listed.length > MISSION_BRIEFING_MAX_CONTROLS)
    throw controlsInvalid(`List between one and ${MISSION_BRIEFING_MAX_CONTROLS} controls`);
  if (new Set(listed.map((reference) => canonicalDigest(reference))).size !== listed.length)
    throw controlsInvalid('List each control once');
  const positions = listed.map((reference) =>
    candidates.findIndex((candidate) => same(briefingControlReference(candidate), reference)),
  );
  if (positions.includes(-1))
    throw new DomainError(409, 'briefing_control_mismatch', 'Select only exact accepted controls from this release');
  if (positions.some((position, index) => index > 0 && position < positions[index - 1]!))
    throw controlsInvalid('List the controls in the order the release lists them');
  return positions.map((position) => candidates[position]!);
}

export async function acceptMissionBriefing(
  client: PoolClient,
  principal: AuthContext,
  command: MissionBriefingCommand,
): Promise<CommandRecord> {
  const author = await authorForCommand(client, principal, command.expectedPrincipalRevision, false);
  const current = authFromRow(author);
  await flightForBriefing(client, current, command.flightId, 'UPDATE');
  const ids = command.recipientPrincipalIds;
  if (!ids.length || ids.length > MISSION_BRIEFING_MAX_RECIPIENTS || new Set(ids).size !== ids.length)
    throw new DomainError(400, 'briefing_recipients_invalid', 'Select between one and 32 distinct human recipients');
  const recipients = (
    await client.query<PrincipalRow>(
      `SELECT id,tenant_id,name,kind,capabilities,command_link_sources,mission_sources,revision
       FROM principals WHERE tenant_id=$1 AND id=ANY($2::text[]) AND active AND kind='human'
       ORDER BY id COLLATE "C" FOR SHARE`,
      [current.tenantId, ids],
    )
  ).rows;
  if (recipients.length !== ids.length)
    throw new DomainError(
      400,
      'briefing_recipients_invalid',
      'Every named recipient must be an active human principal in this organization',
    );
  const state = await getMissionReleaseState(client, current, command.flightId, command.release.id);
  if (
    state.digest !== command.release.digest ||
    !['scheduled', 'current'].includes(state.validity.status) ||
    !state.snapshot
  )
    throw new DomainError(
      409,
      'briefing_release_not_current',
      'A briefing requires its exact completed current release',
      { status: state.validity.status },
    );
  const selected = briefedCandidates(state.release.basis.avoidance.candidates, command.controls);
  const contents: MissionBriefingControlRecordContent[] = [];
  for (const candidate of selected) contents.push(await briefedControlContent(client, current.tenantId, candidate));
  const population = {
    version: 'briefing.recipient-population.1' as const,
    organizationId: state.release.organizationId,
    recipients: recipients.map((recipient) => ({
      principalId: recipient.id,
      name: recipient.name,
      kind: 'human' as const,
      principalRevision: Number(recipient.revision),
    })),
  };
  // A briefing pins the controls list its author saw; with none in scope it pins none.
  const controls = await controlsSeenForCommand(client, current, command.flightId, command.expectedControlsDigest);
  const fields = {
    flightId: command.flightId,
    organizationId: state.release.organizationId,
    purpose: 'informational' as const,
    context: {
      release: { ...command.release },
      mission: state.release.basis.avoidance.mission,
      aircraftId: state.release.aircraftId,
      contextDigest: state.release.basis.avoidance.contextDigest,
      releasePolicy: {
        id: state.release.policy.id,
        version: state.release.policy.version,
        digest: state.release.policy.digest,
      },
      controls: selected.map(briefingControlReference),
    },
    content: { message: command.message, controls: contents },
    population: { ...population, digest: canonicalDigest(population) },
    actor: actor(author, command.flightId),
  };
  const acceptance = { version: 'flight.mission-briefing.3' as const, ...fields, ...(controls ? { controls } : {}) };
  const register = (
    await client.query<{ revision: string }>('SELECT revision FROM mission_avoidance_register WHERE tenant_id=$1', [
      current.tenantId,
    ])
  ).rows[0];
  // A briefing holds until the release window ends or a control that can matter to this flight starts or ends.
  const validUntil = new Date(
    Math.min(
      Date.parse(state.release.departureWindow.end),
      ...(state.controlBoundary ? [Date.parse(state.controlBoundary)] : []),
    ),
  ).toISOString();
  const retained = await retainCommand(client, current, command, acceptance);
  const record = {
    ...acceptance,
    id: retained.event.id,
    recordedAt: retained.record.recordedAt,
  } as MissionBriefingRecord;
  assertMissionBriefingRecord(record);
  await checkRecordBytes(client, record, MISSION_BRIEFING_MAX_RECORD_BYTES);
  await client.query(
    'INSERT INTO mission_briefings(id,tenant_id,flight_id,organization_id,release_id,release_digest,actor_id,register_revision,valid_until,record,record_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      record.id,
      current.tenantId,
      record.flightId,
      record.organizationId,
      record.context.release.id,
      record.context.release.digest,
      current.id,
      register.revision,
      validUntil,
      record,
      canonicalDigest(record),
      retained.event.received_at,
    ],
  );
  return retained.record;
}
export async function getMissionBriefing(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  briefingId: string,
  reading = false,
): Promise<MissionBriefingRecordResponse> {
  await flightForBriefing(client, principal, flightId, reading ? 'NONE' : 'SHARE');
  const metadata = (
    await client.query<BriefingMetadata>(
      'SELECT record_digest,release_id,release_digest,octet_length(record::text) AS byte_length FROM mission_briefings WHERE tenant_id=$1 AND flight_id=$2 AND id=$3',
      [principal.tenantId, flightId, briefingId],
    )
  ).rows[0];
  if (!metadata)
    throw new DomainError(404, 'mission_briefing_not_found', 'Mission briefing was not found within this flight');
  if (metadata.byte_length > MISSION_BRIEFING_MAX_RECORD_BYTES)
    throw new DomainError(409, 'briefing_record_budget_exceeded', 'The retained briefing exceeds its byte budget');
  const { record } = (
    await client.query<{ record: MissionBriefingRecord }>(
      'SELECT record FROM mission_briefings WHERE tenant_id=$1 AND flight_id=$2 AND id=$3',
      [principal.tenantId, flightId, briefingId],
    )
  ).rows[0];
  assertMissionBriefingRecord(record);
  if (
    record.id !== briefingId ||
    record.flightId !== flightId ||
    record.organizationId !== `organization:${principal.tenantId}` ||
    !same(record.context.release, { id: metadata.release_id, digest: metadata.release_digest }) ||
    canonicalDigest(record) !== metadata.record_digest
  )
    throw new DomainError(409, 'briefing_integrity_failure', 'The retained briefing commitment does not match');
  const standing = await briefingStandingNow(client, principal.tenantId, flightId, briefingId);
  return { briefing: record, digest: metadata.record_digest, standing };
}
export async function acceptMissionBriefingAcknowledgement(
  client: PoolClient,
  principal: AuthContext,
  command: MissionBriefingAcknowledgementCommand,
): Promise<CommandRecord> {
  const author = await authorForCommand(client, principal, command.expectedPrincipalRevision, true);
  const current = authFromRow(author);
  await flightForBriefing(client, current, command.flightId, 'UPDATE');
  const exact = await getMissionBriefing(client, current, command.flightId, command.briefing.id);
  const briefing = exact.briefing;
  if (exact.digest !== command.briefing.digest || briefing.population.digest !== command.populationDigest)
    throw new DomainError(409, 'briefing_context_mismatch', 'Review the exact briefing and recipient population');
  if (!briefing.population.recipients.some(({ principalId }) => principalId === current.id))
    throw new DomainError(
      403,
      'briefing_recipient_required',
      'Only a named recipient may acknowledge their own review',
    );
  if (
    (
      await client.query(
        'SELECT id FROM mission_briefing_acknowledgements WHERE tenant_id=$1 AND briefing_id=$2 AND recipient_principal_id=$3',
        [current.tenantId, briefing.id, current.id],
      )
    ).rowCount
  )
    throw new DomainError(
      409,
      'briefing_already_acknowledged',
      'Your acknowledgement is already recorded for this exact briefing',
    );
  // Read by the database clock after the flight lock; the commit trigger checks again at commit.
  if (exact.standing.status === 'lapsed') throw briefingLapsed(briefing.id, exact.standing);
  const acceptance: Omit<MissionBriefingAcknowledgementRecord, 'id' | 'recordedAt'> = {
    version: 'flight.mission-briefing-acknowledgement.1',
    flightId: briefing.flightId,
    briefing: { ...command.briefing },
    populationDigest: briefing.population.digest,
    recipientPrincipalId: current.id,
    attestation: command.attestation,
    actor: {
      ...actor(author, briefing.flightId),
      kind: 'human',
      checkedCapabilities: ['flight:read', 'briefing:ack'],
      policyVersion: 'ledger.mission-briefing-acknowledgement-authority.1',
    },
  };
  const retained = await retainCommand(client, current, command, acceptance);
  const record: MissionBriefingAcknowledgementRecord = {
    ...acceptance,
    id: retained.event.id,
    recordedAt: retained.record.recordedAt,
  };
  assertMissionBriefingAcknowledgementRecord(record, briefing);
  await checkRecordBytes(client, record, MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES);
  await client.query(
    'INSERT INTO mission_briefing_acknowledgements(id,tenant_id,flight_id,briefing_id,briefing_digest,population_digest,recipient_principal_id,actor_id,record,record_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      record.id,
      current.tenantId,
      record.flightId,
      briefing.id,
      exact.digest,
      briefing.population.digest,
      current.id,
      current.id,
      record,
      canonicalDigest(record),
      retained.event.received_at,
    ],
  );
  return retained.record;
}
export async function getMissionBriefingAcknowledgements(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  briefingId: string,
): Promise<MissionBriefingAcknowledgementsResponse> {
  const exact = await getMissionBriefing(client, principal, flightId, briefingId, true);
  const briefing = exact.briefing;
  const rows = (
    await client.query<AcknowledgementMetadata>(
      `SELECT a.id,a.record_digest,a.recipient_principal_id,octet_length(a.record::text) AS byte_length,w.state,p.acknowledgement_id IS NOT NULL AS projected FROM mission_briefing_acknowledgements a LEFT JOIN work_items w ON w.tenant_id=a.tenant_id AND w.event_id=a.id LEFT JOIN mission_briefing_acknowledgement_projection_views p ON p.tenant_id=a.tenant_id AND p.acknowledgement_id=a.id AND p.flight_id=a.flight_id WHERE a.tenant_id=$1 AND a.flight_id=$2 AND a.briefing_id=$3 ORDER BY a.recipient_principal_id COLLATE "C" LIMIT 33`,
      [principal.tenantId, flightId, briefingId],
    )
  ).rows;
  if (
    rows.length > MISSION_BRIEFING_MAX_RECIPIENTS ||
    rows.some((row) => row.byte_length > MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES) ||
    rows.reduce((size, row) => size + row.byte_length, Buffer.byteLength(canonicalize(briefing.population))) >
      MISSION_BRIEFING_ACKNOWLEDGEMENTS_MAX_READ_BYTES
  )
    throw new DomainError(
      409,
      'briefing_record_budget_exceeded',
      'The retained acknowledgements exceed their read budget',
    );
  const accepted = rows.length
    ? (
        await client.query<{ record: MissionBriefingAcknowledgementRecord }>(
          'SELECT record FROM mission_briefing_acknowledgements WHERE tenant_id=$1 AND flight_id=$2 AND briefing_id=$3 AND id=ANY($4::text[])',
          [principal.tenantId, flightId, briefingId, rows.map(({ id }) => id)],
        )
      ).rows
    : [];
  const records = new Map(accepted.map(({ record }) => [record.id, record]));
  const byRecipient = new Map(
    rows.map((row) => {
      const record = records.get(row.id);
      if (!record)
        throw new DomainError(409, 'briefing_integrity_failure', 'The retained acknowledgement is unavailable');
      assertMissionBriefingAcknowledgementRecord(record, briefing);
      if (
        record.id !== row.id ||
        record.recipientPrincipalId !== row.recipient_principal_id ||
        canonicalDigest(record) !== row.record_digest
      )
        throw new DomainError(
          409,
          'briefing_integrity_failure',
          'The retained acknowledgement commitment does not match',
        );
      const processing =
        row.state === 'failed'
          ? 'failed'
          : row.state === 'completed' && row.projected
            ? 'completed'
            : row.state === 'leased'
              ? 'processing'
              : 'pending';
      return [
        row.recipient_principal_id,
        { acknowledgement: { record, digest: row.record_digest }, processing },
      ] as const;
    }),
  );
  const state = await getMissionReleaseState(client, principal, flightId, briefing.context.release.id, true);
  const result: MissionBriefingAcknowledgementsResponse = {
    briefing: { id: briefing.id, digest: exact.digest },
    evaluatedAt: state.validity.evaluatedAt,
    purpose: 'informational',
    scope: 'declared_recipients_only',
    population: briefing.population,
    recipients: briefing.population.recipients.map(({ principalId }) => ({
      recipientPrincipalId: principalId,
      ...(byRecipient.get(principalId) ?? { acknowledgement: null, processing: null }),
    })),
    releaseValidity: state.validity,
    standing: exact.standing,
  };
  if (Buffer.byteLength(canonicalize(result)) > MISSION_BRIEFING_ACKNOWLEDGEMENTS_MAX_READ_BYTES)
    throw new DomainError(409, 'briefing_record_budget_exceeded', 'The acknowledgements exceed their response budget');
  return result;
}
