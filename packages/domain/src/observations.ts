import { randomUUID } from 'node:crypto';
import {
  OBSERVATION_PAGE_LIMIT,
  listObservationTypes,
  subjectReferenceKey,
  type AcceptedObservation,
  type AcceptedObservationSubject,
  type ObservationGrant,
  type ObservationInput,
  type ObservationListResponse,
  type ObservationQuery,
  type ObservationSubject,
  type ObservationSubjectResolution,
  type Receipt,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, appendLiveChange, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { lockSubjects, retainSubjectEvidence } from './cuts.js';
import { encodeHistoryCursor, historyCursor, historyLimit, historyPrecise } from './history.js';
import { getReceipt } from './index.js';
import { prepareReplacement, replacedLedgerIds } from './observation-corrections.js';
import { indexObservationReferences } from './observation-references.js';
import { observationRegistry, validateObservation } from './observation-registry.js';
import { intakeRegistry } from './organization-record-types.js';

const CONTENT_VERSION = 'ledger.observation-content.1';

/** The authority acceptInput retained for this input, plus the grant that let this source send this type. */
export interface ObservationAuthority {
  version: string;
  principalId: string;
  tenantId: string;
  principalRevision: number;
  inputKind: 'observation';
  sourceId: string;
  requiredCapabilities: string[];
  grant: ObservationGrant;
}

export interface ResolvedSubject {
  submitted: ObservationSubject;
  ledgerId?: string;
  resolution: ObservationSubjectResolution;
}

export async function resolveSubject(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  subject: ObservationSubject,
  occurredAt: string,
): Promise<ResolvedSubject> {
  if (subject.scope === 'ledger') {
    const row = (
      await client.query<{ kind: string }>('SELECT kind FROM subjects WHERE tenant_id=$1 AND id=$2', [
        tenantId,
        subject.id,
      ])
    ).rows[0];
    if (row?.kind !== subject.kind)
      throw new DomainError(
        404,
        'subject_not_found',
        `No Ledger ${subject.kind} ${subject.id} was found within your scope; send the source's own id with scope source`,
      );
    return { submitted: subject, ledgerId: subject.id, resolution: 'ledger' };
  }
  const matches = await client.query<{ id: string }>(
    `SELECT DISTINCT a.subject_id AS id FROM aliases a
     JOIN subjects s ON s.tenant_id=a.tenant_id AND s.id=a.subject_id AND s.kind=$4
     WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.external_id=$3
       AND (a.valid_from IS NULL OR a.valid_from<=$5) AND (a.valid_to IS NULL OR a.valid_to>$5)
     ORDER BY a.subject_id LIMIT 2`,
    [tenantId, sourceId, subject.id, subject.kind, occurredAt],
  );
  if (matches.rows.length === 1) return { submitted: subject, ledgerId: matches.rows[0]!.id, resolution: 'alias' };
  return { submitted: subject, resolution: matches.rows.length ? 'ambiguous' : 'unresolved' };
}

/**
 * Locks, before a batch of observations is accepted one by one in its own order, the flight views and the subjects
 * their intake will lock, each table in id order. Each intake then finds its rows already held. A subject that does
 * not resolve here is left to that observation's own intake, which refuses it as it would alone.
 */
export async function lockObservationTargets(
  client: PoolClient,
  tenantId: string,
  inputs: readonly ObservationInput[],
): Promise<void> {
  const flights = new Set<string>();
  const subjects = new Set<string>();
  for (const input of inputs) {
    const observation = input.payload as { subject: ObservationSubject; secondarySubject?: ObservationSubject };
    for (const subject of [observation.subject, observation.secondarySubject]) {
      if (!subject) continue;
      const resolved = await resolveSubject(client, tenantId, input.sourceId, subject, input.occurredAt).catch(
        () => undefined,
      );
      if (!resolved?.ledgerId) continue;
      subjects.add(resolved.ledgerId);
      if (subject.kind === 'flight') flights.add(resolved.ledgerId);
    }
    if (input.replaces) for (const id of await replacedLedgerIds(client, tenantId, input.replaces)) subjects.add(id);
  }
  // The lock an intake's UPDATE of the view takes.
  await client.query(
    'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR NO KEY UPDATE',
    [tenantId, [...flights]],
  );
  await lockSubjects(client, tenantId, [...subjects], 'UPDATE');
}

export async function requireGrant(client: PoolClient, principal: AuthContext, grant: ObservationGrant): Promise<void> {
  // withScope holds the principal row FOR SHARE until commit, and authority.update locks it FOR UPDATE before it
  // replaces grants, so a concurrent revocation waits for this acceptance.
  const granted = await client.query(
    'SELECT 1 FROM observation_grants WHERE tenant_id=$1 AND principal_id=$2 AND source_id=$3 AND observation_type=$4',
    [principal.tenantId, principal.id, grant.sourceId, grant.observationType],
  );
  if (!granted.rowCount)
    throw new DomainError(
      403,
      'observation_grant_required',
      `Source ${grant.sourceId} is not granted observation type ${grant.observationType}`,
      { ...grant },
    );
}

function receiptLink(primary: ResolvedSubject, flightId: string | undefined): Receipt['linkStatus'] {
  if (flightId || primary.ledgerId) return 'linked';
  return primary.resolution === 'ambiguous' ? 'candidate' : 'unresolved';
}

/**
 * A record made on behalf of an older input kind or command (the legacy flight-report bridge). It needs no
 * observation grant, because the older input's own capability authorized it, and its event names the older event.
 */
export interface BridgedRecordOptions {
  bridgedFrom?: string;
  /**
   * The grant that authorizes the observation in place of a grant for its own type: an operator record entered under
   * the operator-records source is authorized by the operator.record grant, whichever type it is recorded as.
   */
  grantedBy?: ObservationGrant;
}

/** Accepts one observation of any registered type. Called by acceptInput after it has checked input authority. */
export async function acceptObservationInput(
  client: PoolClient,
  principal: AuthContext,
  input: ObservationInput,
  inputAuthority: Omit<ObservationAuthority, 'grant'>,
  options: BridgedRecordOptions = {},
): Promise<Receipt> {
  const registry = await intakeRegistry(client, principal.tenantId, input.payload);
  const { definition, observation } = validateObservation(registry, input.payload);
  if (input.occurredAt !== observation.occurredAt)
    throw new DomainError(400, 'invalid_observation', 'Input occurredAt must equal the observation occurredAt');
  const grant =
    options.grantedBy?.sourceId === input.sourceId
      ? options.grantedBy
      : { sourceId: input.sourceId, observationType: definition.type };
  // A record bridged from an older input kind was authorized by that input's own capability.
  if (!options.bridgedFrom) await requireGrant(client, principal, grant);
  const acceptedAuthority: ObservationAuthority = { ...inputAuthority, grant };
  const artifactId = observation.originalArtifactId as string;
  const artifact = await client.query('SELECT 1 FROM artifacts WHERE tenant_id=$1 AND id=$2', [
    principal.tenantId,
    artifactId,
  ]);
  if (!artifact.rowCount)
    throw new DomainError(404, 'artifact_not_found', 'The original artifact was not found within your scope');
  const sessionId = observation.sourceSessionId as string | undefined;
  const sourceEventId = observation.sourceEventId as string | undefined;
  const contentDigest = canonicalDigest({
    version: CONTENT_VERSION,
    sourceId: input.sourceId,
    observation,
    ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
  });
  if (sourceEventId !== undefined) {
    const identity = { tenant: principal.tenantId, source: input.sourceId, session: sessionId ?? null };
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `observation-event:${canonicalDigest({ ...identity, type: definition.type, event: sourceEventId })}`,
    ]);
    const previous = (
      await client.query<{ receipt_id: string; content_digest: string }>(
        `SELECT receipt_id,content_digest FROM observations WHERE tenant_id=$1 AND source_id=$2
         AND COALESCE(source_session_id,'')=$3 AND observation_type=$4 AND source_event_id=$5`,
        [principal.tenantId, input.sourceId, sessionId ?? '', definition.type, sourceEventId],
      )
    ).rows[0];
    if (previous) {
      if (previous.content_digest !== contentDigest)
        throw new DomainError(
          409,
          'source_event_conflict',
          'This source event already retains a different observation of this type',
        );
      return getReceipt(client, previous.receipt_id);
    }
  }
  const replacement = input.replaces
    ? await prepareReplacement(client, principal, input.sourceId, input.replaces, options)
    : undefined;
  const occurredAt = observation.occurredAt as string;
  const primary = await resolveSubject(client, principal.tenantId, input.sourceId, observation.subject, occurredAt);
  const secondary = observation.secondarySubject
    ? await resolveSubject(client, principal.tenantId, input.sourceId, observation.secondarySubject, occurredAt)
    : undefined;
  const resolved = [primary, secondary].filter((item): item is ResolvedSubject => !!item?.ledgerId);
  const flights = [
    ...new Set(resolved.filter((item) => item.submitted.kind === 'flight').map((item) => item.ledgerId!)),
  ];
  for (const id of [...flights].sort())
    await client.query(
      'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, id],
    );
  const subjects = {
    subject: subjectView(primary),
    ...(secondary ? { secondarySubject: subjectView(secondary) } : {}),
  };
  const event = await appendEvent(client, principal, {
    type: input.kind,
    stream: `source:${principal.id}:${input.sourceId}:${sessionId ?? 'default'}`,
    sourceId: input.sourceId,
    sessionId,
    occurredAt,
    payload: {
      ...input,
      subjects,
      acceptedAuthority,
      ...(replacement ? { affected: [replacement.affected] } : {}),
      ...(options.bridgedFrom ? { bridgedFrom: options.bridgedFrom } : {}),
    },
    artifactId,
    ...(options.bridgedFrom ? { causationId: options.bridgedFrom } : {}),
  });
  await retainSubjectEvidence(
    client,
    principal.tenantId,
    [...resolved.map((item) => item.ledgerId!), ...(replacement?.ledgerIds ?? [])],
    event,
  );
  const flightId = primary.submitted.kind === 'flight' && primary.ledgerId ? primary.ledgerId : flights[0];
  const receiptId = randomUUID();
  await client.query(
    `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,flight_id,artifact_id,link_status,payload,input_subject)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      receiptId,
      principal.tenantId,
      event.id,
      input.sourceId,
      input.kind,
      occurredAt,
      event.received_at,
      flightId ?? null,
      artifactId,
      receiptLink(primary, flightId),
      observation,
      subjects,
    ],
  );
  const interval = observation.interval as { start: string; end?: string } | undefined;
  await client.query(
    `INSERT INTO observations(id,tenant_id,receipt_id,event_id,artifact_id,principal_id,source_id,source_session_id,
       source_event_id,observation_type,observation_version,subject_kind,subject_id,subject_scope,subject_ledger_id,
       subject_resolution,secondary_subject_kind,secondary_subject_id,secondary_subject_scope,secondary_subject_ledger_id,
       secondary_subject_resolution,occurred_at,interval_start,interval_end,received_at,fidelity,content_digest,observation,
       replaces_observation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
    [
      event.id,
      principal.tenantId,
      receiptId,
      event.id,
      artifactId,
      principal.id,
      input.sourceId,
      sessionId ?? null,
      sourceEventId ?? null,
      definition.type,
      definition.version,
      primary.submitted.kind,
      primary.submitted.id,
      primary.submitted.scope,
      primary.ledgerId ?? null,
      primary.resolution,
      secondary?.submitted.kind ?? null,
      secondary?.submitted.id ?? null,
      secondary?.submitted.scope ?? null,
      secondary?.ledgerId ?? null,
      secondary?.resolution ?? null,
      occurredAt,
      interval?.start ?? null,
      interval?.end ?? null,
      event.received_at,
      observation.fidelity,
      contentDigest,
      observation,
      input.replaces ?? null,
    ],
  );
  await indexObservationReferences(client, principal.tenantId, event.id, input.sourceId, observation);
  for (const id of [...flights].sort())
    await appendLiveChange(client, principal.tenantId, id, event.id, 'flight.updated', receiptId);
  return getReceipt(client, receiptId);
}

function subjectView(subject: ResolvedSubject): AcceptedObservationSubject {
  return {
    ...subject.submitted,
    ...(subject.ledgerId ? { ledgerId: subject.ledgerId } : {}),
    resolution: subject.resolution,
  };
}

/** Replaces a principal's observation grants. Every granted type must be registered in some version. */
export async function replaceObservationGrants(
  client: PoolClient,
  tenantId: string,
  principalId: string,
  grants: ObservationGrant[],
): Promise<void> {
  const registered = new Set(listObservationTypes(observationRegistry()).map((definition) => definition.type));
  const unknown = grants.find((grant) => !registered.has(grant.observationType));
  if (unknown)
    throw new DomainError(
      400,
      'unregistered_observation_type',
      `Observation type ${unknown.observationType} is not registered`,
      { observationType: unknown.observationType },
    );
  await client.query('DELETE FROM observation_grants WHERE tenant_id=$1 AND principal_id=$2', [tenantId, principalId]);
  for (const grant of grants)
    await client.query(
      'INSERT INTO observation_grants(tenant_id,principal_id,source_id,observation_type) VALUES($1,$2,$3,$4)',
      [tenantId, principalId, grant.sourceId, grant.observationType],
    );
}

export async function getObservationGrants(
  client: PoolClient,
  tenantId: string,
  principalId: string,
): Promise<ObservationGrant[]> {
  const rows = await client.query<{ source_id: string; observation_type: string }>(
    `SELECT source_id,observation_type FROM observation_grants WHERE tenant_id=$1 AND principal_id=$2
     ORDER BY source_id COLLATE "C",observation_type COLLATE "C"`,
    [tenantId, principalId],
  );
  return rows.rows.map((row) => ({ sourceId: row.source_id, observationType: row.observation_type }));
}

interface ObservationRow {
  id: string;
  receipt_id: string;
  event_id: string;
  artifact_id: string;
  source_id: string;
  source_session_id: string | null;
  source_event_id: string | null;
  observation_type: string;
  observation_version: number;
  subject_kind: AcceptedObservationSubject['kind'];
  subject_id: string;
  subject_scope: AcceptedObservationSubject['scope'];
  subject_ledger_id: string | null;
  subject_resolution: ObservationSubjectResolution;
  secondary_subject_kind: AcceptedObservationSubject['kind'] | null;
  secondary_subject_id: string | null;
  secondary_subject_scope: AcceptedObservationSubject['scope'] | null;
  secondary_subject_ledger_id: string | null;
  secondary_subject_resolution: ObservationSubjectResolution | null;
  occurred_at: Date;
  interval_start: Date | null;
  interval_end: Date | null;
  received_at: Date;
  fidelity: AcceptedObservation['fidelity'];
  observation: Record<string, unknown>;
  replaces_observation_id: string | null;
  page_time: string;
}

/** What corrections recorded since intake say about an observation, as read at one evidence cut. */
export interface ObservationCorrectionColumns {
  subject_resolution_id: string | null;
  subject_resolved_id: string | null;
  secondary_resolution_id: string | null;
  secondary_resolved_id: string | null;
  replaced_by: string | null;
  withdrawal_id: string | null;
  withdrawal_event_id: string | null;
  withdrawal_reason: string | null;
  withdrawal_recorded_at: Date | null;
  withdrawal_principal_id: string | null;
}

/** Whether journal event `event` lies inside the jsonb evidence cut `cut`; a null cut holds every event. */
function inCut(event: string, cut: string): string {
  return `(${cut}::jsonb IS NULL OR ((${cut}::jsonb)->>${event}.stream_id)::bigint>=${event}.stream_sequence)`;
}

function resolutionJoin(role: 'subject' | 'secondarySubject', alias: string, cut: string): string {
  const column = role === 'subject' ? 'subject' : 'secondary_subject';
  return `LEFT JOIN LATERAL (
    SELECT r.id,r.ledger_subject_id FROM observation_subject_resolutions r
    JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
    WHERE r.tenant_id=o.tenant_id AND ${inCut('re', cut)} AND (
      (r.observation_id=o.id AND r.role='${role}')
      OR (r.observation_id IS NULL AND o.${column}_scope='source' AND o.${column}_resolution='unresolved'
        AND r.source_id=o.source_id AND r.subject_kind=o.${column}_kind AND r.external_id=o.${column}_id
        AND (r.valid_from IS NULL OR r.valid_from<=o.occurred_at) AND (r.valid_to IS NULL OR r.valid_to>o.occurred_at)))
    ORDER BY re.received_at DESC,r.id DESC LIMIT 1) ${alias} ON true`;
}

/**
 * Joins (on observation alias `o`) the replacement, withdrawal and subject resolutions recorded for an observation
 * whose journal events lie inside the evidence cut bound to SQL parameter `cut`, as ObservationCorrectionColumns.
 */
export function correctionSql(cut: string): { columns: string; joins: string } {
  return {
    columns: `pr.id AS subject_resolution_id,pr.ledger_subject_id AS subject_resolved_id,
      sr.id AS secondary_resolution_id,sr.ledger_subject_id AS secondary_resolved_id,rep.id AS replaced_by,
      wd.id AS withdrawal_id,wd.event_id AS withdrawal_event_id,wd.reason AS withdrawal_reason,
      wd.recorded_at AS withdrawal_recorded_at,wd.principal_id AS withdrawal_principal_id`,
    joins: `${resolutionJoin('subject', 'pr', cut)}
    ${resolutionJoin('secondarySubject', 'sr', cut)}
    LEFT JOIN LATERAL (
      SELECT r.id FROM observations r JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
      WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id AND ${inCut('re', cut)}) rep ON true
    LEFT JOIN LATERAL (
      SELECT w.* FROM observation_withdrawals w JOIN journal_events we ON we.tenant_id=w.tenant_id AND we.id=w.event_id
      WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id AND ${inCut('we', cut)}) wd ON true`,
  };
}

function subjectRead(
  kind: AcceptedObservationSubject['kind'],
  id: string,
  scope: AcceptedObservationSubject['scope'],
  ledgerId: string | null,
  resolution: ObservationSubjectResolution,
  resolutionId: string | null,
  resolvedId: string | null,
): AcceptedObservationSubject {
  if (resolutionId && resolvedId) return { kind, id, scope, ledgerId: resolvedId, resolution: 'record', resolutionId };
  return { kind, id, scope, ...(ledgerId ? { ledgerId } : {}), resolution };
}

function observationView(row: ObservationRow & ObservationCorrectionColumns): AcceptedObservation {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    eventId: row.event_id,
    artifactId: row.artifact_id,
    sourceId: row.source_id,
    type: row.observation_type,
    version: row.observation_version,
    subject: subjectRead(
      row.subject_kind,
      row.subject_id,
      row.subject_scope,
      row.subject_ledger_id,
      row.subject_resolution,
      row.subject_resolution_id,
      row.subject_resolved_id,
    ),
    ...(row.secondary_subject_kind && row.secondary_subject_id && row.secondary_subject_scope
      ? {
          secondarySubject: subjectRead(
            row.secondary_subject_kind,
            row.secondary_subject_id,
            row.secondary_subject_scope,
            row.secondary_subject_ledger_id,
            row.secondary_subject_resolution!,
            row.secondary_resolution_id,
            row.secondary_resolved_id,
          ),
        }
      : {}),
    occurredAt: row.occurred_at.toISOString(),
    ...(row.interval_start
      ? {
          interval: {
            start: row.interval_start.toISOString(),
            ...(row.interval_end ? { end: row.interval_end.toISOString() } : {}),
          },
        }
      : {}),
    receivedAt: row.received_at.toISOString(),
    fidelity: row.fidelity,
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    observation: row.observation,
    ...(row.replaces_observation_id ? { replaces: row.replaces_observation_id } : {}),
    ...(row.replaced_by ? { replacedBy: row.replaced_by } : {}),
    ...(row.withdrawal_id
      ? {
          withdrawal: {
            id: row.withdrawal_id,
            eventId: row.withdrawal_event_id!,
            reason: row.withdrawal_reason!,
            recordedAt: row.withdrawal_recorded_at!.toISOString(),
            recordedBy: row.withdrawal_principal_id!,
          },
        }
      : {}),
  };
}

export interface ObservationReadOptions {
  /**
   * Read only observations whose journal event lies inside this evidence cut (stream id to highest included
   * sequence), such as a subject's accepted input cut. Observations on streams absent from the cut are excluded, and
   * so are replacements, withdrawals and subject resolutions recorded outside it.
   */
  evidenceCut?: Record<string, number>;
  /**
   * Read the observations whose reference field at this path names the queried subject, instead of those about it:
   * the reference as written, or a source reference an alias resolution inside the cut points at the Ledger subject.
   */
  referencing?: string;
  /**
   * Read the observations with a source event id that this source reported in this capture session, about any
   * subject, instead of those about the queried subject.
   */
  session?: { sourceId: string; sourceSessionId: string };
}

/**
 * Matches (on observation alias `o`) observations whose reference at field $15 names the subject with key $14: as
 * written, or for a Ledger subject ($3, kind $2) a source reference that the latest alias resolution inside the cut
 * points at it.
 */
function referencingMatch(cut: string): string {
  return `EXISTS(SELECT 1 FROM observation_references ref WHERE ref.tenant_id=o.tenant_id AND ref.observation_id=o.id
    AND ref.field=$15 AND (ref.reference_key=$14 OR ($4::text IS NULL AND ref.reference_scope='source'
      AND ref.reference_kind=$2 AND (SELECT r.ledger_subject_id FROM observation_subject_resolutions r
        JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
        WHERE r.tenant_id=o.tenant_id AND r.observation_id IS NULL AND ${inCut('re', cut)}
          AND r.source_id=ref.reference_source_id AND r.subject_kind=ref.reference_kind AND r.external_id=ref.reference_id
          AND (r.valid_from IS NULL OR r.valid_from<=o.occurred_at) AND (r.valid_to IS NULL OR r.valid_to>o.occurred_at)
        ORDER BY re.received_at DESC,r.id DESC LIMIT 1)=$3)))`;
}

/**
 * Observations that could be about a Ledger subject: resolved to it at intake, attached to it by a subject
 * resolution, or naming a source identity an alias resolution points at it. The current subject is decided after.
 */
const ledgerCandidates = `SELECT id FROM observations WHERE tenant_id=$1 AND observation_type=$5 AND subject_ledger_id=$3
  UNION SELECT id FROM observations WHERE tenant_id=$1 AND observation_type=$5 AND secondary_subject_ledger_id=$3
  UNION SELECT observation_id FROM observation_subject_resolutions
    WHERE tenant_id=$1 AND ledger_subject_id=$3 AND observation_id IS NOT NULL
  UNION SELECT c.id FROM observation_subject_resolutions r
    JOIN observations c ON c.tenant_id=r.tenant_id AND c.source_id=r.source_id AND c.observation_type=$5
      AND ((c.subject_scope='source' AND c.subject_kind=r.subject_kind AND c.subject_id=r.external_id)
        OR (c.secondary_subject_scope='source' AND c.secondary_subject_kind=r.subject_kind
          AND c.secondary_subject_id=r.external_id))
    WHERE r.tenant_id=$1 AND r.ledger_subject_id=$3 AND r.observation_id IS NULL`;

/**
 * Lists accepted observations of one type for one subject whose time span meets [from, to), in span order. By
 * default only current observations: not replaced, not withdrawn, and for a Ledger subject under their current
 * subject, all as recorded inside the evidence cut when one is given. Requires evidence:read. Reads only the
 * caller's tenant.
 */
export async function listObservations(
  client: PoolClient,
  principal: AuthContext,
  query: ObservationQuery,
  options: ObservationReadOptions = {},
): Promise<ObservationListResponse> {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'capability_required', 'Reading observations requires evidence:read');
  const scope = query.subjectScope ?? 'ledger';
  if ((scope === 'source') !== (query.sourceId !== undefined))
    throw new DomainError(
      400,
      'invalid_observation_query',
      'sourceId is required with subjectScope source and not accepted otherwise',
    );
  const from = Date.parse(query.from),
    to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new DomainError(400, 'invalid_observation_query', 'from must be a time before to');
  const order = query.order ?? 'oldest_first';
  const include = query.include ?? 'current';
  const limit = historyLimit(query.limit, 100, OBSERVATION_PAGE_LIMIT);
  const filters = {
    subjectKind: query.subjectKind,
    subjectId: query.subjectId,
    subjectScope: scope,
    sourceId: query.sourceId,
    type: query.type,
    version: query.version === undefined ? undefined : String(query.version),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    order,
    cut: options.evidenceCut ? canonicalDigest(options.evidenceCut) : undefined,
    include: include === 'current' ? undefined : include,
    referencing: options.referencing,
    session: options.session ? JSON.stringify([options.session.sourceId, options.session.sourceSessionId]) : undefined,
  };
  const prior = historyCursor(query.cursor, principal, 'observations', filters, true);
  const descending = order === 'newest_first';
  const corrections = correctionSql('$11');
  // The subject parameters have no part in a session's match; naming them gives the unused parameters a type.
  const subjectMatch = options.session
    ? `o.source_id=$14 AND COALESCE(o.source_session_id,'')=$15 AND o.source_event_id IS NOT NULL
        AND num_nulls($2::text,$3::text,$4::text)>=0`
    : options.referencing
      ? referencingMatch('$11')
      : scope === 'ledger'
        ? `$4::text IS NULL AND ((COALESCE(pr.ledger_subject_id,o.subject_ledger_id)=$3 AND o.subject_kind=$2)
          OR (COALESCE(sr.ledger_subject_id,o.secondary_subject_ledger_id)=$3 AND o.secondary_subject_kind=$2))`
        : `o.source_id=$4::text AND ((o.subject_scope='source' AND o.subject_kind=$2 AND o.subject_id=$3)
          OR (o.secondary_subject_scope='source' AND o.secondary_subject_kind=$2 AND o.secondary_subject_id=$3))`;
  const source =
    scope === 'ledger' && !options.referencing && !options.session
      ? `(${ledgerCandidates}) candidate JOIN observations o ON o.tenant_id=$1 AND o.id=candidate.id`
      : 'observations o';
  const rows = await client.query<ObservationRow & ObservationCorrectionColumns>(
    `SELECT o.*,${corrections.columns},${historyPrecise('o.span_start')} AS page_time FROM ${source}
     JOIN journal_events e ON e.tenant_id=o.tenant_id AND e.id=o.event_id
     ${corrections.joins}
     WHERE o.tenant_id=$1 AND ${subjectMatch} AND o.observation_type=$5
       AND ($6::integer IS NULL OR o.observation_version=$6)
       AND o.span_start<$8::timestamptz
       AND CASE WHEN o.interval_end IS NOT NULL THEN o.interval_end>$7::timestamptz
         ELSE GREATEST(o.occurred_at,o.span_start)>=$7::timestamptz END
       AND ($9::timestamptz IS NULL OR (o.span_start,o.id) ${descending ? '<' : '>'} ($9::timestamptz,$10::text))
       AND ${inCut('e', '$11')}
       AND ($13::boolean OR (rep.id IS NULL AND wd.id IS NULL))
     ORDER BY o.span_start ${descending ? 'DESC' : 'ASC'},o.id ${descending ? 'DESC' : 'ASC'} LIMIT $12`,
    [
      principal.tenantId,
      query.subjectKind,
      query.subjectId,
      query.sourceId ?? null,
      query.type,
      query.version ?? null,
      filters.from,
      filters.to,
      prior?.position.time ?? null,
      prior?.position.id ?? null,
      options.evidenceCut ? JSON.stringify(options.evidenceCut) : null,
      limit + 1,
      include === 'all',
      ...(options.session ? [options.session.sourceId, options.session.sourceSessionId] : []),
      ...(options.referencing && !options.session
        ? [
            subjectReferenceKey({
              scope,
              kind: query.subjectKind as SubjectReference['kind'],
              id: query.subjectId,
              ...(scope === 'source' ? { sourceId: query.sourceId! } : {}),
            }),
            options.referencing,
          ]
        : []),
    ],
  );
  const visible = rows.rows.slice(0, limit);
  const hasMore = rows.rows.length > limit;
  const last = visible.at(-1);
  const position = last ? { id: last.id, time: last.page_time } : null;
  return {
    observations: visible.map(observationView),
    page: {
      limit,
      returned: visible.length,
      hasMore,
      nextCursor:
        hasMore && position
          ? encodeHistoryCursor(principal, 'observations', filters, prior?.upper ?? position, position)
          : null,
      order,
    },
  };
}
