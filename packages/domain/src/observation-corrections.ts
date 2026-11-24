import { randomUUID } from 'node:crypto';
import type {
  CommandRecord,
  ObservationSubjectResolveCommand,
  ObservationWithdrawCommand,
  SubjectAliasCommand,
  SubjectReference,
} from '@ledger/contracts';
import { subjectReferenceKey } from '@ledger/contracts';
import { appendEvent, DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { retainSubjectEvidence } from './cuts.js';
import { getCommand } from './index.js';
import {
  correctionSql,
  requireGrant,
  type BridgedRecordOptions,
  type ObservationCorrectionColumns,
} from './observations.js';

/**
 * Replacement, withdrawal and subject resolution of accepted observations (docs/design/observation-corrections.md).
 * Each is a new record with its own journal event; no stored observation changes. Each event lists the observations
 * it affected and every subject they were or are now about, so rules reading them are evaluated again.
 */

/** One observation a correction affected, with the subjects it was about before and after. */
export interface AffectedObservation {
  type: string;
  version: number;
  subjects: SubjectReference[];
}

type Role = 'subject' | 'secondarySubject';

interface CurrentObservation extends ObservationCorrectionColumns {
  id: string;
  event_id: string;
  source_id: string;
  observation_type: string;
  observation_version: number;
  occurred_at: Date;
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_scope: 'ledger' | 'source';
  subject_ledger_id: string | null;
  subject_resolution: string;
  secondary_subject_resolution: string | null;
  secondary_subject_kind: SubjectReference['kind'] | null;
  secondary_subject_id: string | null;
  secondary_subject_scope: 'ledger' | 'source' | null;
  secondary_subject_ledger_id: string | null;
}

async function currentObservations(
  client: PoolClient,
  tenantId: string,
  where: string,
  params: unknown[],
): Promise<CurrentObservation[]> {
  const corrections = correctionSql('NULL');
  const rows = await client.query<CurrentObservation>(
    `SELECT o.id,o.event_id,o.source_id,o.observation_type,o.observation_version,o.occurred_at,o.subject_kind,
       o.subject_id,o.subject_scope,o.subject_ledger_id,o.subject_resolution,o.secondary_subject_resolution,
       o.secondary_subject_kind,o.secondary_subject_id,
       o.secondary_subject_scope,o.secondary_subject_ledger_id,${corrections.columns}
     FROM observations o ${corrections.joins}
     WHERE o.tenant_id=$1 AND ${where} ORDER BY o.id`,
    [tenantId, ...params],
  );
  return rows.rows;
}

/** The Ledger subject a role of the observation is currently about, if any. */
function ledgerIdOf(row: CurrentObservation, role: Role): string | null {
  return role === 'subject'
    ? (row.subject_resolved_id ?? row.subject_ledger_id)
    : (row.secondary_resolved_id ?? row.secondary_subject_ledger_id);
}

function referenceOf(row: CurrentObservation, role: Role, ledgerId: string | null): SubjectReference | undefined {
  const kind = role === 'subject' ? row.subject_kind : row.secondary_subject_kind;
  const id = role === 'subject' ? row.subject_id : row.secondary_subject_id;
  if (!kind || !id) return undefined;
  return ledgerId ? { scope: 'ledger', kind, id: ledgerId } : { scope: 'source', kind, id, sourceId: row.source_id };
}

function distinct(subjects: (SubjectReference | undefined)[]): SubjectReference[] {
  const byKey = new Map<string, SubjectReference>();
  for (const subject of subjects) if (subject) byKey.set(subjectReferenceKey(subject), subject);
  return [...byKey.values()].sort((a, b) => subjectReferenceKey(a).localeCompare(subjectReferenceKey(b)));
}

/** The subjects the observation is about now, with `moved` roles about the given Ledger subjects instead. */
function subjectsOf(row: CurrentObservation, moved: Partial<Record<Role, string>> = {}): SubjectReference[] {
  return distinct(
    (['subject', 'secondarySubject'] as const).map((role) =>
      referenceOf(row, role, moved[role] ?? ledgerIdOf(row, role)),
    ),
  );
}

function ledgerIds(subjects: SubjectReference[]): string[] {
  return subjects.filter((subject) => subject.scope === 'ledger').map((subject) => subject.id);
}

function affectedOf(row: CurrentObservation, subjects: SubjectReference[]): AffectedObservation {
  return { type: row.observation_type, version: row.observation_version, subjects };
}

/** Locks an observation against concurrent corrections: group 2 of the lock order, before any row lock. */
export async function lockObservationCorrection(
  client: PoolClient,
  tenantId: string,
  observationId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `observation-correction:${tenantId}:${observationId}`,
  ]);
}

/**
 * Locks an observation against concurrent corrections and returns it if it is current: found within the caller's
 * tenant, not replaced and not withdrawn. The caller must hold the grant to submit it.
 */
async function requireCurrent(
  client: PoolClient,
  principal: AuthContext,
  observationId: string,
  options: BridgedRecordOptions = {},
) {
  await lockObservationCorrection(client, principal.tenantId, observationId);
  const [row] = await currentObservations(client, principal.tenantId, 'o.id=$2', [observationId]);
  if (!row) throw new DomainError(404, 'observation_not_found', 'The observation was not found within your scope');
  if (!options.bridgedFrom)
    await requireGrant(
      client,
      principal,
      options.grantedBy?.sourceId === row.source_id
        ? options.grantedBy
        : { sourceId: row.source_id, observationType: row.observation_type },
    );
  if (row.replaced_by)
    throw new DomainError(409, 'observation_replaced', `Observation ${row.id} was already replaced`, {
      replacedBy: row.replaced_by,
    });
  if (row.withdrawal_id)
    throw new DomainError(409, 'observation_withdrawn', `Observation ${row.id} was already withdrawn`, {
      withdrawalId: row.withdrawal_id,
    });
  return row;
}

/** An observation as corrections leave it: its source, the Ledger subject it is about now, and whether it is current. */
export async function observationStanding(
  client: PoolClient,
  tenantId: string,
  observationId: string,
): Promise<
  | {
      sourceId: string;
      ledgerId: string | null;
      current: boolean;
      replacedBy: string | null;
      withdrawalEventId: string | null;
    }
  | undefined
> {
  const [row] = await currentObservations(client, tenantId, 'o.id=$2', [observationId]);
  if (!row) return undefined;
  return {
    sourceId: row.source_id,
    ledgerId: ledgerIdOf(row, 'subject'),
    current: !row.replaced_by && !row.withdrawal_id,
    replacedBy: row.replaced_by,
    withdrawalEventId: row.withdrawal_event_id,
  };
}

/** The Ledger subjects an observation is currently about, which replacing it touches; none when it is not found. */
export async function replacedLedgerIds(
  client: PoolClient,
  tenantId: string,
  observationId: string,
): Promise<string[]> {
  const [row] = await currentObservations(client, tenantId, 'o.id=$2', [observationId]);
  return row ? ledgerIds(subjectsOf(row)) : [];
}

/** Checks that an observation submitted under sourceId may replace observationId, and what that affects. */
export async function prepareReplacement(
  client: PoolClient,
  principal: AuthContext,
  sourceId: string,
  observationId: string,
  options: BridgedRecordOptions = {},
): Promise<{ affected: AffectedObservation; ledgerIds: string[] }> {
  const replaced = await requireCurrent(client, principal, observationId, options);
  if (replaced.source_id !== sourceId)
    throw new DomainError(
      409,
      'replacement_source_mismatch',
      `Observation ${replaced.id} was accepted under source ${replaced.source_id}; replace it under that source`,
    );
  const subjects = subjectsOf(replaced);
  return { affected: affectedOf(replaced, subjects), ledgerIds: ledgerIds(subjects) };
}

function bridged(options: BridgedRecordOptions): { bridgedFrom?: string } {
  return options.bridgedFrom ? { bridgedFrom: options.bridgedFrom } : {};
}

async function recordCommand(
  client: PoolClient,
  principal: AuthContext,
  event: JournalEvent,
  payload: Record<string, unknown>,
): Promise<CommandRecord> {
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, principal.tenantId, event.event_type, principal.id, event.received_at, payload],
  );
  return getCommand(client, event.id);
}

export async function withdrawObservation(
  client: PoolClient,
  principal: AuthContext,
  command: ObservationWithdrawCommand,
  options: BridgedRecordOptions = {},
): Promise<CommandRecord> {
  const target = await requireCurrent(client, principal, command.observationId, options);
  const subjects = subjectsOf(target);
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `observation-correction:${target.id}`,
    sourceId: target.source_id,
    payload: { ...command, affected: [affectedOf(target, subjects)], ...bridged(options) },
    ...(options.bridgedFrom ? { causationId: options.bridgedFrom } : {}),
  });
  await retainSubjectEvidence(client, principal.tenantId, ledgerIds(subjects), event);
  await client.query(
    `INSERT INTO observation_withdrawals(id,tenant_id,observation_id,event_id,principal_id,reason,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [event.id, principal.tenantId, target.id, event.id, principal.id, command.reason, event.received_at],
  );
  return recordCommand(client, principal, event, command);
}

async function requireLedgerSubject(client: PoolClient, tenantId: string, id: string, kind: string): Promise<void> {
  const row = (
    await client.query<{ kind: string }>('SELECT kind FROM subjects WHERE tenant_id=$1 AND id=$2', [tenantId, id])
  ).rows[0];
  if (row?.kind !== kind)
    throw new DomainError(404, 'subject_not_found', `No Ledger ${kind} ${id} was found within your scope`);
}

/** Retains, for a Ledger subject, the latest event on each stream among the given observation events. */
async function retainObservationEvents(
  client: PoolClient,
  tenantId: string,
  subjectId: string,
  eventIds: string[],
): Promise<void> {
  const events = await client.query<Pick<JournalEvent, 'id' | 'stream_id' | 'stream_sequence'>>(
    `SELECT DISTINCT ON(stream_id) id,stream_id,stream_sequence FROM journal_events
     WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY stream_id,stream_sequence DESC`,
    [tenantId, eventIds],
  );
  for (const event of events.rows) await retainSubjectEvidence(client, tenantId, [subjectId], event);
}

export async function resolveObservationSubject(
  client: PoolClient,
  principal: AuthContext,
  command: ObservationSubjectResolveCommand,
  options: BridgedRecordOptions = {},
): Promise<CommandRecord> {
  const role = command.role ?? 'subject';
  const target = await requireCurrent(client, principal, command.observationId, options);
  const kind = role === 'subject' ? target.subject_kind : target.secondary_subject_kind;
  if (!kind)
    throw new DomainError(400, 'observation_subject_missing', `Observation ${target.id} names no secondary subject`);
  await requireLedgerSubject(client, principal.tenantId, command.ledgerSubjectId, kind);
  if (ledgerIdOf(target, role) === command.ledgerSubjectId)
    throw new DomainError(409, 'subject_unchanged', `Observation ${target.id} is already about that subject`);
  const before = subjectsOf(target);
  const after = subjectsOf(target, { [role]: command.ledgerSubjectId });
  const subjects = distinct([...before, ...after]);
  const payload = { ...command, role };
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `observation-correction:${target.id}`,
    sourceId: target.source_id,
    payload: { ...payload, affected: [affectedOf(target, subjects)], ...bridged(options) },
    ...(options.bridgedFrom ? { causationId: options.bridgedFrom } : {}),
  });
  await retainSubjectEvidence(client, principal.tenantId, ledgerIds(subjects), event);
  await retainObservationEvents(client, principal.tenantId, command.ledgerSubjectId, [target.event_id]);
  await client.query(
    `INSERT INTO observation_subject_resolutions(id,tenant_id,event_id,principal_id,recorded_at,reason,subject_kind,
       ledger_subject_id,observation_id,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event.id,
      principal.tenantId,
      event.id,
      principal.id,
      event.received_at,
      command.reason,
      kind,
      command.ledgerSubjectId,
      target.id,
      role,
    ],
  );
  return recordCommand(client, principal, event, payload);
}

async function requireSourceGrant(client: PoolClient, principal: AuthContext, sourceId: string): Promise<void> {
  const granted = await client.query(
    'SELECT 1 FROM observation_grants WHERE tenant_id=$1 AND principal_id=$2 AND source_id=$3',
    [principal.tenantId, principal.id, sourceId],
  );
  if (!granted.rowCount)
    throw new DomainError(403, 'observation_grant_required', `Source ${sourceId} is not granted any observation type`, {
      sourceId,
    });
}

/** An observation role names the identity and was unresolved at intake, at a time inside the validity ($5, $6). */
const identityRole = (column: string) =>
  `(o.${column}_scope='source' AND o.${column}_resolution='unresolved' AND o.${column}_kind=$3 AND o.${column}_id=$4)`;
const identityMatch = `(${identityRole('subject')} OR ${identityRole('secondary_subject')})
  AND ($5::timestamptz IS NULL OR o.occurred_at>=$5::timestamptz) AND ($6::timestamptz IS NULL OR o.occurred_at<$6::timestamptz)`;

/**
 * Records an alias from a source identity to a Ledger subject, so later observations resolve at intake, and attaches
 * the earlier observations that named it and were unresolved at intake.
 */
export async function aliasSubjectIdentity(
  client: PoolClient,
  principal: AuthContext,
  command: SubjectAliasCommand,
): Promise<CommandRecord> {
  await requireSourceGrant(client, principal, command.sourceId);
  await requireLedgerSubject(client, principal.tenantId, command.ledgerSubjectId, command.subjectKind);
  if (command.validFrom && command.validTo && Date.parse(command.validFrom) >= Date.parse(command.validTo))
    throw new DomainError(400, 'invalid_alias_validity', 'validFrom must be before validTo');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `subject-alias:${principal.tenantId}:${command.sourceId}:${command.externalId}`,
  ]);
  const overlapping = await client.query<{ subject_id: string }>(
    `SELECT a.subject_id FROM aliases a JOIN subjects s ON s.tenant_id=a.tenant_id AND s.id=a.subject_id AND s.kind=$4
     WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.external_id=$3
       AND (a.valid_to IS NULL OR $5::timestamptz IS NULL OR a.valid_to>$5::timestamptz)
       AND (a.valid_from IS NULL OR $6::timestamptz IS NULL OR a.valid_from<$6::timestamptz) LIMIT 1`,
    [
      principal.tenantId,
      command.sourceId,
      command.externalId,
      command.subjectKind,
      command.validFrom ?? null,
      command.validTo ?? null,
    ],
  );
  if (overlapping.rows[0])
    throw new DomainError(
      409,
      'alias_exists',
      `${command.externalId} under source ${command.sourceId} already resolves to ${overlapping.rows[0].subject_id}; resolve single observations instead`,
      { subjectId: overlapping.rows[0].subject_id },
    );
  const matched = await currentObservations(client, principal.tenantId, `o.source_id=$2 AND ${identityMatch}`, [
    command.sourceId,
    command.subjectKind,
    command.externalId,
    command.validFrom ?? null,
    command.validTo ?? null,
  ]);
  const affected = matched.map((row) => {
    const moved = Object.fromEntries(
      (['subject', 'secondarySubject'] as const)
        .filter((role) => namesIdentity(row, role, command))
        .map((role) => [role, command.ledgerSubjectId]),
    );
    return affectedOf(row, distinct([...subjectsOf(row), ...subjectsOf(row, moved)]));
  });
  const aliasId = randomUUID();
  const payload = { ...command, aliasId };
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `subject-alias:${command.sourceId}:${command.subjectKind}:${command.externalId}`,
    sourceId: command.sourceId,
    payload: { ...payload, affected },
  });
  await client.query(
    'INSERT INTO aliases(id,tenant_id,subject_id,source_id,external_id,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      aliasId,
      principal.tenantId,
      command.ledgerSubjectId,
      command.sourceId,
      command.externalId,
      command.validFrom ?? null,
      command.validTo ?? null,
    ],
  );
  const subjects = distinct(affected.flatMap((item) => item.subjects));
  await retainSubjectEvidence(client, principal.tenantId, [command.ledgerSubjectId, ...ledgerIds(subjects)], event);
  await retainObservationEvents(
    client,
    principal.tenantId,
    command.ledgerSubjectId,
    matched.map((row) => row.event_id),
  );
  await client.query(
    `INSERT INTO observation_subject_resolutions(id,tenant_id,event_id,principal_id,recorded_at,reason,subject_kind,
       ledger_subject_id,source_id,external_id,valid_from,valid_to,alias_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      event.id,
      principal.tenantId,
      event.id,
      principal.id,
      event.received_at,
      command.reason,
      command.subjectKind,
      command.ledgerSubjectId,
      command.sourceId,
      command.externalId,
      command.validFrom ?? null,
      command.validTo ?? null,
      aliasId,
    ],
  );
  return recordCommand(client, principal, event, payload);
}

function namesIdentity(row: CurrentObservation, role: Role, command: SubjectAliasCommand): boolean {
  const [kind, id, scope, resolution] =
    role === 'subject'
      ? [row.subject_kind, row.subject_id, row.subject_scope, row.subject_resolution]
      : [
          row.secondary_subject_kind,
          row.secondary_subject_id,
          row.secondary_subject_scope,
          row.secondary_subject_resolution,
        ];
  return scope === 'source' && resolution === 'unresolved' && kind === command.subjectKind && id === command.externalId;
}
