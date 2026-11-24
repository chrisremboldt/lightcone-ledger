import {
  findOperatorRecordDefinition,
  isOperatorRecordDefinition,
  missingFieldLabel,
  missingReplayFields,
  missingRequiredFields,
  observationSubjectKindValues,
  OPERATOR_RECORD_PAGE_LIMIT,
  OPERATOR_RECORD_SOURCE_ID,
  observedRecordBody,
  type AcceptedObservationSubject,
  type ObservationSubjectResolution,
  type OperatorRecordDefinition,
  type OperatorRecordListResponse,
  type OperatorRecordQuery,
  type OperatorRecordView,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { encodeHistoryCursor, historyCursor, historyPrecise } from './history.js';
import { observationRegistry } from './observation-registry.js';
import { organizationIdOf } from './rule-evaluations.js';

/**
 * Reading operator records by record type, by subject and by the time they are about. A record is about a subject as
 * its subject, its related subject, or through a reference field whose kind is the subject's kind; which fields those
 * are comes from the registered field metadata, never from a record type's name.
 */

export const OPERATOR_RECORD_CARRIER = 'operator.record';

export function operatorRecordDefinitions(): OperatorRecordDefinition[] {
  return Object.values(observationRegistry().recordTypes).filter(isOperatorRecordDefinition);
}

/**
 * The observation types operator records are kept as: the operator.record carrier, and each record type recorded as
 * its own observation type.
 */
export function operatorRecordObservationTypes(): string[] {
  return [
    OPERATOR_RECORD_CARRIER,
    ...new Set(
      operatorRecordDefinitions()
        .filter((definition) => definition.observed)
        .map((definition) => definition.recordType),
    ),
  ];
}

/** SQL for a stored record's type and version: the carried record type, or the observation's own type. */
export const RECORD_TYPE_SQL = `COALESCE(o.observation->'values'->>'recordType',o.observation_type)`;
export const RECORD_VERSION_SQL = `COALESCE((o.observation->'values'->>'recordVersion')::integer,o.observation_version)`;

/** The reference fields of every registered record type that may name a subject of the kind (any kind if none). */
export function referenceFieldsOf(kind: string | undefined): { types: string[]; fields: string[]; kinds: string[] } {
  const found = { types: [] as string[], fields: [] as string[], kinds: [] as string[] };
  for (const definition of operatorRecordDefinitions())
    for (const field of definition.fields)
      if (field.kind === 'reference' && (!kind || field.referenceKind === kind)) {
        found.types.push(definition.recordType);
        found.fields.push(field.name);
        found.kinds.push(field.referenceKind);
      }
  return found;
}

/** A subject records are read about: the operator's own id for it, or the Ledger organization itself. */
export interface RecordSubject {
  kind: string;
  id: string;
  scope: 'ledger' | 'source';
}

/** The Ledger organization is the subject of records about the operator's own organization; any other id is theirs. */
export function recordSubjectOf(tenantId: string, kind: string, id: string): RecordSubject {
  return kind === 'organization' && id === organizationIdOf(tenantId)
    ? { kind, id, scope: 'ledger' }
    : { kind, id, scope: 'source' };
}

export interface RecordFilter {
  sourceId: string;
  recordTypes?: readonly string[];
  recordVersion?: number;
  subjectKind?: string;
  subjects?: readonly RecordSubject[];
  from?: string;
  to?: string;
}

export interface RecordRow {
  id: string;
  receipt_id: string;
  event_id: string;
  source_id: string;
  principal_id: string;
  principal_name: string | null;
  artifact_id: string;
  content_type: string;
  byte_length: number;
  artifact_sha256: string;
  filename: string | null;
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
  observation_type: string;
  observation_version: number;
  occurred_at: Date;
  interval_start: Date | null;
  interval_end: Date | null;
  received_at: Date;
  observation: Record<string, any>;
  replaces_observation_id: string | null;
  replaced_by: string | null;
  about: OperatorRecordView['about'] | null;
  page_time: string;
}

const RECORD_COLUMNS = `o.id,o.receipt_id,o.event_id,o.source_id,o.principal_id,o.artifact_id,o.subject_kind,o.subject_id,
  o.subject_scope,o.subject_ledger_id,o.subject_resolution,o.secondary_subject_kind,o.secondary_subject_id,
  o.secondary_subject_scope,o.secondary_subject_ledger_id,o.secondary_subject_resolution,o.observation_type,
  o.observation_version,o.occurred_at,
  o.interval_start,o.interval_end,o.received_at,o.observation,o.replaces_observation_id,
  a.content_type,a.byte_length,a.sha256 AS artifact_sha256,u.filename,p.name AS principal_name,
  (SELECT r.id FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id) AS replaced_by,
  ${historyPrecise('o.span_start')} AS page_time`;

/**
 * Records matching a filter, newest first by the time they are about and then by id, after a position, at most
 * `limit` rows. With subjects, each row says how it is about the first subject it matches.
 */
export async function readRecordRows(
  client: PoolClient,
  tenantId: string,
  filter: RecordFilter,
  limit: number,
  after?: { time: string; id: string },
): Promise<RecordRow[]> {
  const subjects = filter.subjects ?? [];
  const references = referenceFieldsOf(undefined);
  const params: unknown[] = [
    tenantId,
    filter.sourceId,
    operatorRecordObservationTypes(),
    filter.recordTypes?.length ? [...filter.recordTypes] : null,
    filter.recordVersion ?? null,
    filter.subjectKind ?? null,
    filter.from ?? null,
    filter.to ?? null,
    after?.time ?? null,
    after?.id ?? null,
    limit,
    // Parameters an unused clause would leave untyped are sent only when the subject clause uses them.
    ...(subjects.length
      ? [
          subjects.map((subject) => subject.kind),
          subjects.map((subject) => subject.id),
          subjects.map((subject) => subject.scope),
          references.types,
          references.fields,
          references.kinds,
        ]
      : []),
  ];
  // The subjects a row is about: its subject, its related subject, and each source id its reference fields name.
  const aboutRow = `(SELECT matched.how FROM unnest($12::text[],$13::text[],$14::text[]) WITH ORDINALITY AS s(kind,id,scope,n),
      LATERAL (
        SELECT 'subject' AS how WHERE o.subject_kind=s.kind AND o.subject_id=s.id AND o.subject_scope=s.scope
        UNION ALL SELECT 'related_subject' WHERE o.secondary_subject_kind=s.kind AND o.secondary_subject_id=s.id
          AND o.secondary_subject_scope=s.scope
        UNION ALL SELECT 'reference' WHERE s.scope='source' AND EXISTS(
          SELECT 1 FROM unnest($15::text[],$16::text[],$17::text[]) AS f(record_type,field,kind)
          WHERE f.kind=s.kind AND f.record_type=o.observation->'values'->>'recordType'
            AND o.observation#>>ARRAY['values','record',f.field,'scope']='source'
            AND o.observation#>>ARRAY['values','record',f.field,'id']=s.id)
      ) AS matched ORDER BY s.n,CASE matched.how WHEN 'subject' THEN 0 WHEN 'related_subject' THEN 1 ELSE 2 END LIMIT 1)`;
  const rows = await client.query<RecordRow>(
    `SELECT * FROM (
       SELECT ${RECORD_COLUMNS},o.span_start,${subjects.length ? aboutRow : 'NULL::text'} AS about
       FROM observations o
       JOIN artifacts a ON a.tenant_id=o.tenant_id AND a.id=o.artifact_id
       LEFT JOIN uploads u ON u.tenant_id=a.tenant_id AND u.id=a.upload_id
       LEFT JOIN principals p ON p.tenant_id=o.tenant_id AND p.id=o.principal_id
       WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=ANY($3::text[])
         AND ($4::text[] IS NULL OR ${RECORD_TYPE_SQL}=ANY($4::text[]))
         AND ($5::integer IS NULL OR ${RECORD_VERSION_SQL}=$5)
         AND ($6::text IS NULL OR o.subject_kind=$6)
         AND ($7::timestamptz IS NULL OR COALESCE(o.interval_end,o.span_start)>=$7)
         AND ($8::timestamptz IS NULL OR o.span_start<$8)
         AND ($9::timestamptz IS NULL OR (o.span_start,o.id)<($9::timestamptz,$10::text))
     ) AS rows WHERE ${subjects.length ? 'about IS NOT NULL' : 'true'}
     ORDER BY span_start DESC,id DESC LIMIT $11`,
    params,
  );
  return rows.rows;
}

function subjectView(
  kind: AcceptedObservationSubject['kind'],
  id: string,
  scope: AcceptedObservationSubject['scope'],
  ledgerId: string | null,
  resolution: ObservationSubjectResolution,
): AcceptedObservationSubject {
  return { kind, id, scope, ...(ledgerId ? { ledgerId } : {}), resolution };
}

const named = (definition: OperatorRecordDefinition, names: string[]) =>
  names.map((name) => ({ name, label: missingFieldLabel(definition, name) }));

/** A stored record's type, version and body, whether carried in operator.record or recorded as its own type. */
export function storedRecord(row: Pick<RecordRow, 'observation' | 'observation_type' | 'observation_version'>): {
  recordType: string;
  recordVersion: number;
  record: Record<string, any>;
  dayOnly?: Record<string, { day: string; timeZone: string; nextDayAt: string }>;
} {
  if (row.observation_type === OPERATOR_RECORD_CARRIER || 'recordType' in (row.observation.values ?? {}))
    return row.observation.values as {
      recordType: string;
      recordVersion: number;
      record: Record<string, any>;
      dayOnly?: Record<string, { day: string; timeZone: string; nextDayAt: string }>;
    };
  const definition = findOperatorRecordDefinition(observationRegistry(), row.observation_type, row.observation_version);
  return {
    recordType: row.observation_type,
    recordVersion: row.observation_version,
    record: definition ? observedRecordBody(definition, row.observation) : {},
  };
}

export function recordView(row: RecordRow): OperatorRecordView {
  const values = storedRecord(row);
  const definition = findOperatorRecordDefinition(observationRegistry(), values.recordType, values.recordVersion);
  const missingRequired = definition ? named(definition, missingRequiredFields(definition, values.record)) : [];
  const missingReplay = definition ? named(definition, missingReplayFields(definition, values.record)) : [];
  return {
    observationId: row.id,
    receiptId: row.receipt_id,
    sourceId: row.source_id,
    recordType: values.recordType,
    recordVersion: values.recordVersion,
    subject: subjectView(
      row.subject_kind,
      row.subject_id,
      row.subject_scope,
      row.subject_ledger_id,
      row.subject_resolution,
    ),
    ...(row.secondary_subject_kind && row.secondary_subject_id && row.secondary_subject_scope
      ? {
          secondarySubject: subjectView(
            row.secondary_subject_kind,
            row.secondary_subject_id,
            row.secondary_subject_scope,
            row.secondary_subject_ledger_id,
            row.secondary_subject_resolution!,
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
    record: values.record,
    ...(values.dayOnly ? { dayOnly: values.dayOnly } : {}),
    complete: !missingRequired.length,
    missingRequired,
    missingReplay,
    limitations: row.observation.limitations ?? [],
    origin: {
      artifactId: row.artifact_id,
      ...(row.filename ? { filename: row.filename } : {}),
      contentType: row.content_type,
      byteLength: row.byte_length,
      ...(row.observation.originalLocator ? { locator: row.observation.originalLocator } : {}),
      recordedBy: { id: row.principal_id, ...(row.principal_name ? { name: row.principal_name } : {}) },
    },
    ...(row.replaces_observation_id ? { replaces: row.replaces_observation_id } : {}),
    ...(row.replaced_by ? { replacedBy: row.replaced_by } : {}),
    ...(row.about ? { about: row.about } : {}),
  };
}

export function requireRecordRead(principal: AuthContext): void {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'capability_required', 'Reading operator records requires evidence:read');
}

/** GET /v1/operator-records: records by type, subject and time, newest first, a page at a time. */
export async function listOperatorRecords(
  client: PoolClient,
  principal: AuthContext,
  query: OperatorRecordQuery,
): Promise<OperatorRecordListResponse> {
  requireRecordRead(principal);
  if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    throw new DomainError(400, 'invalid_time_range', 'from must be before to');
  const limit = Math.min(query.limit ?? 100, OPERATOR_RECORD_PAGE_LIMIT);
  const sourceId = query.sourceId ?? OPERATOR_RECORD_SOURCE_ID;
  const filters = {
    recordType: query.recordType,
    recordVersion: query.recordVersion === undefined ? undefined : String(query.recordVersion),
    subjectKind: query.subjectKind,
    subjectId: query.subjectId,
    from: query.from,
    to: query.to,
    sourceId,
  };
  const prior = historyCursor(query.cursor, principal, 'operator-records', filters, true);
  const subjects = query.subjectId
    ? query.subjectKind
      ? [{ kind: query.subjectKind, id: query.subjectId, scope: 'source' as const }]
      : observationSubjectKindValues.map((kind) => ({
          kind,
          id: query.subjectId!,
          scope: 'source' as const,
        }))
    : undefined;
  const rows = await readRecordRows(
    client,
    principal.tenantId,
    {
      sourceId,
      ...(query.recordType ? { recordTypes: query.recordType.split(',') } : {}),
      ...(query.recordVersion !== undefined ? { recordVersion: query.recordVersion } : {}),
      // A subject id names the subject; its kind narrows it, so the kind filter applies only without an id.
      ...(query.subjectKind && !query.subjectId ? { subjectKind: query.subjectKind } : {}),
      ...(subjects ? { subjects } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    },
    limit + 1,
    prior ? { time: prior.position.time!, id: prior.position.id } : undefined,
  );
  const visible = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = visible.at(-1);
  const position = last ? { id: last.id, time: last.page_time } : null;
  return {
    records: visible.map(recordView),
    page: {
      limit,
      returned: visible.length,
      hasMore,
      nextCursor:
        hasMore && position
          ? encodeHistoryCursor(principal, 'operator-records', filters, prior?.upper ?? position, position)
          : null,
    },
  };
}
