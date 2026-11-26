import {
  OPERATOR_RECORD_SOURCE_ID,
  applyRecordMapping,
  describeConversion,
  describeTimeConversion,
  enteredValues,
  findOperatorRecordDefinition,
  interpretRecordRow,
  isOperatorRecordDefinition,
  missingFieldLabel,
  missingRequiredFields,
  mappingLimitation,
  observedRecordValues,
  recordRuleRead,
  operatorRecordTime,
  parseRecordFile,
  recordIntervalProblem,
  recordFileFormat,
  recordImportColumns,
  type OperatorRecordCommitResponse,
  type OperatorRecordCommitRow,
  type OperatorRecordDefinition,
  type OperatorRecordImportRequest,
  type OperatorRecordPreviewResponse,
  type OperatorRecordPreviewRow,
  type OperatorRecordTypeSummary,
  type ParsedRecordRow,
  type ObservationInput,
  type ObservationSubject,
  type RecordMapping,
  type RecordRowInterpretation,
} from '@ledger/contracts';
import { readRecordMappingFile } from '@ledger/contracts/record-mapping-file';
import { sha256 } from '@ledger/integrity';
import { DomainError, type AuthContext, type ObjectStore, type PoolClient } from '@ledger/persistence';
import { acceptInput, requireRow } from './index.js';
import { observationRegistry, validateObservation } from './observation-registry.js';
import { lockObservationTargets } from './observations.js';
import { organizationIdOf } from './rule-evaluations.js';
import { organizationTimeZone } from './organization-zone.js';

/**
 * File import and hand entry of operator records. Every row becomes an operator.record observation accepted through
 * generic observation intake, citing the retained file as its original bytes. Nothing here names a record type: the
 * field metadata of the registered type drives parsing, validation, completeness and time.
 */

const CARRIER = { type: 'operator.record', version: 1 } as const;
// A hand-entered or imported record states what the operator recorded against the published record schema.
const FIDELITY = 'documented_schema_conformant';

/**
 * The file is the source session and the row is the source event, so committing the same file twice finds the rows
 * it already recorded.
 */
function sourceEventId(row: number): string {
  return `row-${row}`;
}

function definitions(): OperatorRecordDefinition[] {
  return Object.values(observationRegistry().recordTypes).filter(isOperatorRecordDefinition);
}

export function listOperatorRecordTypes(): OperatorRecordTypeSummary[] {
  return definitions()
    .map((definition) => ({
      recordType: definition.recordType,
      recordVersion: definition.recordVersion,
      title: definition.title,
      description: definition.description,
      subjectKinds: [...definition.subjectKinds],
      secondarySubjectKinds: [...definition.secondarySubjectKinds],
      time: { ...definition.time },
      fields: definition.fields.map((field) => ({ ...field })) as OperatorRecordTypeSummary['fields'],
      columns: recordImportColumns(definition) as OperatorRecordTypeSummary['columns'],
      mayInfer: [...definition.mayInfer],
      mayNotInfer: [...definition.mayNotInfer],
      ruleRead: recordRuleRead(definition),
    }))
    .sort((left, right) => left.recordType.localeCompare(right.recordType) || left.recordVersion - right.recordVersion);
}

export function requireOperatorRecordDefinition(recordType: string, recordVersion: number): OperatorRecordDefinition {
  const definition = findOperatorRecordDefinition(observationRegistry(), recordType, recordVersion);
  if (!definition)
    throw new DomainError(
      404,
      'record_type_not_found',
      `Record type ${recordType} version ${recordVersion} is not registered`,
    );
  return definition;
}

interface RetainedFile {
  artifactId: string;
  contentType: string;
  bytes: Uint8Array;
}

async function readRetainedFile(client: PoolClient, store: ObjectStore, artifactId: string): Promise<RetainedFile> {
  const row = await requireRow(client, 'artifacts', artifactId).catch((error: unknown) => {
    if (error instanceof DomainError && error.status === 404)
      throw new DomainError(404, 'artifact_not_found', 'The file was not found within your scope');
    throw error;
  });
  const bytes = await store.get(row.object_key);
  if (bytes.byteLength !== row.byte_length || sha256(bytes) !== row.sha256)
    throw new DomainError(409, 'artifact_integrity_failure', 'Retained bytes do not match the receipt commitment');
  return { artifactId, contentType: row.content_type, bytes };
}

/** The id of a retained file within the principal's scope, without reading its bytes. */
async function requireRetainedArtifact(client: PoolClient, artifactId: string): Promise<string> {
  await requireRow(client, 'artifacts', artifactId).catch((error: unknown) => {
    if (error instanceof DomainError && error.status === 404)
      throw new DomainError(404, 'artifact_not_found', 'The original file was not found within your scope');
    throw error;
  });
  return artifactId;
}

/** A sentence for a record read from another file, kept with it so a later reader can find the row it came from. */
function readFromLimitation(original: string, importFile: string, row: number): string {
  return `Read from its original file, retained as file ${original}, through row ${row} of file ${importFile}, which holds what was read from the original in Ledger’s own columns. A value in that file the original does not hold was added to it, not read from the original.`;
}

async function hasGrant(client: PoolClient, principal: AuthContext, sourceId: string): Promise<boolean> {
  if (!principal.capabilities.includes('input:write')) return false;
  const granted = await client.query(
    'SELECT 1 FROM observation_grants WHERE tenant_id=$1 AND principal_id=$2 AND source_id=$3 AND observation_type=$4',
    [principal.tenantId, principal.id, sourceId, CARRIER.type],
  );
  return Boolean(granted.rowCount);
}

interface EvaluatedRow {
  preview: OperatorRecordPreviewRow;
  observation?: Record<string, unknown>;
  /** The earlier row of the same file whose record this row replaces, named by its recordId (a produced file). */
  replacesRow?: number;
}

interface Evaluation {
  definition: OperatorRecordDefinition;
  timeZone: string;
  sourceId: string;
  format: 'csv' | 'json';
  problems: string[];
  rows: EvaluatedRow[];
  mapping?: OperatorRecordPreviewResponse['mapping'];
}

/** The retained column mapping a request names, read against the record type, or the problems with it. */
async function readMapping(
  client: PoolClient,
  store: ObjectStore,
  definition: OperatorRecordDefinition,
  artifactId: string,
): Promise<{ mapping: RecordMapping } | { problems: string[] }> {
  const file = await readRetainedFile(client, store, artifactId);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    return { problems: ['The mapping: the file is not UTF-8 text.'] };
  }
  const read = readRecordMappingFile(definition, text);
  return 'mapping' in read
    ? { mapping: read.mapping }
    : { problems: read.problems.map((problem) => `The mapping: ${problem}`) };
}

const named = (definition: OperatorRecordDefinition, names: string[]) =>
  names.map((name) => ({ name, label: missingFieldLabel(definition, name) }));

function refused(parsed: ParsedRecordRow, reasons: readonly string[], partial: Partial<OperatorRecordPreviewRow> = {}) {
  return {
    preview: {
      row: parsed.row,
      locator: parsed.locator,
      ...partial,
      status: 'refused' as const,
      missingRequired: partial.missingRequired ?? [],
      conversions: partial.conversions ?? [],
      timeConversions: partial.timeConversions ?? [],
      reasons: [...reasons],
    },
  };
}

/** Reads, interprets and validates every row. Writes nothing. */
async function evaluate(
  client: PoolClient,
  principal: AuthContext,
  store: ObjectStore,
  request: OperatorRecordImportRequest,
  recordedAt: string,
): Promise<Evaluation> {
  const definition = requireOperatorRecordDefinition(request.recordType, request.recordVersion);
  const sourceId = request.sourceId ?? OPERATOR_RECORD_SOURCE_ID;
  const timeZone = await organizationTimeZone(client, principal.tenantId);
  const file = await readRetainedFile(client, store, request.artifactId);
  const format = recordFileFormat(file.contentType, file.bytes);
  const parsed = parseRecordFile(file.bytes, format);
  if (request.mappingArtifactId && request.originalArtifactId)
    return {
      definition,
      timeZone,
      sourceId,
      format,
      problems: [
        'A file read from another file is already in Ledger’s own columns: give a column mapping or the original file, not both.',
      ],
      rows: [],
    };
  const original = request.originalArtifactId
    ? await requireRetainedArtifact(client, request.originalArtifactId)
    : undefined;
  if (request.mappingArtifactId)
    return evaluateMapped(client, principal, store, request, recordedAt, {
      definition,
      sourceId,
      timeZone,
      file,
      parsed,
    });
  const problems = [...parsed.problems];
  if (
    format === 'json' &&
    !problems.length &&
    (parsed.recordType !== definition.recordType || parsed.recordVersion !== definition.recordVersion)
  )
    problems.push(
      `The file states record type ${parsed.recordType ?? '(none)'} version ${parsed.recordVersion ?? '(none)'}, not ${definition.recordType} version ${definition.recordVersion}.`,
    );
  if (problems.length) return { definition, timeZone, sourceId, format, problems, rows: [] };
  const replacedInFile = new Map<string, number>();
  const ownIds = new Map<string, number>();
  const fileRecords = new Map<string, EvaluatedRow>();
  const rows: EvaluatedRow[] = [];
  for (const row of parsed.rows) {
    const reading = row.problem ? undefined : interpretRecordRow(definition, row.cells, { timeZone });
    const evaluated = !reading
      ? refused(row, [row.problem!])
      : await evaluateRow(
          client,
          principal,
          definition,
          file,
          sourceId,
          row,
          reading,
          recordedAt,
          { replacedInFile, fileRecords, ownIds },
          original ? readFromLimitation(original, file.artifactId, row.row) : undefined,
          original,
        );
    rows.push(evaluated);
    if (reading?.recordId && !fileRecords.has(reading.recordId)) fileRecords.set(reading.recordId, evaluated);
  }
  return { definition, timeZone, sourceId, format, problems, rows };
}

/**
 * An export in its own columns, read through a retained column mapping. Each record cites the export as its original,
 * at the export's own row, and names the mapping.
 */
async function evaluateMapped(
  client: PoolClient,
  principal: AuthContext,
  store: ObjectStore,
  request: OperatorRecordImportRequest,
  recordedAt: string,
  read: {
    definition: OperatorRecordDefinition;
    sourceId: string;
    timeZone: string;
    file: RetainedFile;
    parsed: ReturnType<typeof parseRecordFile>;
  },
): Promise<Evaluation> {
  const { definition, sourceId, timeZone, file, parsed } = read;
  const mappingArtifactId = request.mappingArtifactId!;
  const base = { definition, timeZone, sourceId, format: parsed.format };
  const loaded = await readMapping(client, store, definition, mappingArtifactId);
  if ('problems' in loaded) return { ...base, problems: loaded.problems, rows: [] };
  const mapped = applyRecordMapping(definition, loaded.mapping, parsed, { timeZone });
  const mapping = {
    artifactId: mappingArtifactId,
    columns: [...mapped.columns],
    unread: [...mapped.unread],
    constants: [...mapped.constants],
    leftOut: [...mapped.leftOut],
  };
  if (mapped.problems.length) return { ...base, problems: [...mapped.problems], rows: [], mapping };
  const limitation = mappingLimitation(mappingArtifactId, loaded.mapping.constants);
  const inFile = {
    replacedInFile: new Map<string, number>(),
    fileRecords: new Map<string, EvaluatedRow>(),
    ownIds: new Map<string, number>(),
  };
  const rows: EvaluatedRow[] = [];
  for (const row of mapped.rows)
    rows.push(
      await evaluateRow(
        client,
        principal,
        definition,
        file,
        sourceId,
        row,
        row.reading,
        recordedAt,
        inFile,
        limitation,
      ),
    );
  return { ...base, problems: [], rows, mapping };
}

async function evaluateRow(
  client: PoolClient,
  principal: AuthContext,
  definition: OperatorRecordDefinition,
  file: RetainedFile,
  sourceId: string,
  parsed: ParsedRecordRow,
  reading: RecordRowInterpretation,
  recordedAt: string,
  inFile: {
    replacedInFile: Map<string, number>;
    fileRecords: ReadonlyMap<string, EvaluatedRow>;
    ownIds: Map<string, number>;
  },
  /** Said of every record of the file, such as the mapping that read it. */
  readWith?: string,
  /** The retained file the import file was read from, cited as the record's original in its place. */
  original?: string,
): Promise<EvaluatedRow> {
  const { replacedInFile, fileRecords } = inFile;
  const missingRequired = named(definition, missingRequiredFields(definition, reading.record));
  // A record about the operator's own organization is about the Ledger organization, the subject rules read.
  const subject: ObservationSubject | undefined = reading.ownOrganization
    ? { kind: 'organization', id: organizationIdOf(principal.tenantId), scope: 'ledger' }
    : reading.subject;
  const shown = {
    ...(subject ? { subject } : {}),
    ...(reading.secondarySubject ? { secondarySubject: reading.secondarySubject } : {}),
    ...(reading.replaces ? { replaces: reading.replaces } : {}),
    record: reading.record,
    ...(Object.keys(reading.dayOnly).length ? { dayOnly: reading.dayOnly } : {}),
    missingRequired,
    conversions: [...reading.conversions],
    timeConversions: [...reading.timeConversions],
    ...(reading.notes.length ? { notes: [...reading.notes] } : {}),
  };
  if (reading.problems.length || !subject) return refused(parsed, reading.problems, shown);
  const time = operatorRecordTime(definition, reading.record);
  if (time.missingTimeField)
    return refused(
      parsed,
      [
        `${named(definition, [time.missingTimeField])[0]!.label} (${time.missingTimeField}) places the record in time and is empty. Write the time${definition.observed ? '' : ', or the date alone (2026-10-05) when only the date is known'}.`,
      ],
      shown,
    );
  const ordering = recordIntervalProblem(definition, reading.record);
  if (ordering) return refused(parsed, [ordering], shown);
  const occurredAt =
    time.occurredAt ??
    (time.interval && Date.parse(time.interval.start) > Date.parse(recordedAt) ? time.interval.start : recordedAt);
  // An observed record type is recorded as its own observation type, keyed by the operator's own id for the record.
  const observed = definition.observed;
  const ownId = observed ? (reading.record[observed.idField] as string | undefined) : undefined;
  if (observed && !ownId)
    return refused(
      parsed,
      [`${named(definition, [observed.idField])[0]!.label} (${observed.idField}) is needed: records name it.`],
      shown,
    );
  if (ownId && inFile.ownIds.has(ownId) && inFile.ownIds.get(ownId) !== parsed.row)
    return refused(
      parsed,
      [`Row ${inFile.ownIds.get(ownId)} of this file already gives ${observed!.idField} ${ownId}.`],
      shown,
    );
  if (ownId) inFile.ownIds.set(ownId, parsed.row);
  const eventId = ownId ?? sourceEventId(parsed.row);
  const observationType = observed ? definition.recordType : CARRIER.type;
  const observation: Record<string, unknown> = {
    ...(observed ? { type: definition.recordType, version: definition.recordVersion } : CARRIER),
    subject,
    ...(reading.secondarySubject ? { secondarySubject: reading.secondarySubject } : {}),
    occurredAt,
    ...(time.interval ? { interval: time.interval } : {}),
    sourceSessionId: file.artifactId,
    sourceEventId: eventId,
    fidelity: FIDELITY,
    limitations: [
      ...(readWith ? [readWith] : []),
      ...reading.timeConversions.map((conversion) => describeTimeConversion(definition, conversion)),
      ...reading.conversions.map((conversion) => describeConversion(definition, conversion)),
    ],
    originalArtifactId: original ?? file.artifactId,
    // A row of the import file is no place within the file it was read from; the limitation names the row instead.
    ...(original ? {} : { originalLocator: parsed.locator }),
    values: observed
      ? observedRecordValues(definition, reading.record)
      : {
          recordType: definition.recordType,
          recordVersion: definition.recordVersion,
          record: reading.record,
          ...(Object.keys(reading.dayOnly).length ? { dayOnly: reading.dayOnly } : {}),
          ...(reading.conversions.length || reading.timeConversions.length
            ? { entered: enteredValues(reading.conversions, reading.timeConversions) }
            : {}),
        },
  };
  try {
    validateObservation(observationRegistry(), observation);
  } catch (error) {
    if (error instanceof DomainError) return refused(parsed, [error.message], shown);
    throw error;
  }
  const timeShown = {
    ...(definition.time.meaning === 'as_of' && !definition.time.atField ? {} : { occurredAt }),
    ...(time.interval ? { interval: time.interval } : {}),
  };
  const existing = await findRecordedRow(
    client,
    principal.tenantId,
    sourceId,
    file.artifactId,
    observationType,
    eventId,
  );
  if (existing)
    return {
      preview: {
        row: parsed.row,
        locator: parsed.locator,
        status: 'already_recorded',
        ...shown,
        ...timeShown,
        complete: !missingRequired.length,
        reasons: [],
        observationId: existing.id,
        receiptId: existing.receipt_id,
      },
    };
  if (ownId) {
    const sameId = await currentRecordWithId(client, principal.tenantId, sourceId, observationType, ownId);
    if (sameId && sameId !== reading.replaces)
      return refused(
        parsed,
        [
          `${named(definition, [observed!.idField])[0]!.label} ${ownId} is already recorded (record ${sameId}); to correct that record, give ${sameId} in replaces.`,
        ],
        shown,
      );
  }
  // A produced file names the record a row replaces by the recordId of an earlier row of the same file.
  const earlier = reading.replaces ? fileRecords.get(reading.replaces) : undefined;
  if (reading.replaces) {
    const reason =
      replacedInFile.has(reading.replaces) && replacedInFile.get(reading.replaces) !== parsed.row
        ? `Row ${replacedInFile.get(reading.replaces)} of this file already replaces record ${reading.replaces}.`
        : earlier
          ? earlierRowProblem(earlier, subject)
          : await replacementProblem(client, principal.tenantId, sourceId, definition, subject, reading.replaces);
    if (reason) return refused(parsed, [reason], shown);
    replacedInFile.set(reading.replaces, parsed.row);
  }
  return {
    preview: {
      row: parsed.row,
      locator: parsed.locator,
      status: 'acceptable',
      ...shown,
      ...timeShown,
      ...(earlier
        ? {
            notes: [...(shown.notes ?? []), `This row replaces the record of row ${earlier.preview.row} of this file.`],
          }
        : {}),
      complete: !missingRequired.length,
      reasons: [],
    },
    observation,
    ...(earlier ? { replacesRow: earlier.preview.row } : {}),
  };
}

/** Why a row cannot replace the record of an earlier row of its file; undefined when it can. */
function earlierRowProblem(earlier: EvaluatedRow, subject: { kind: string; id: string }): string | undefined {
  const row = earlier.preview.row;
  if (earlier.preview.status === 'refused')
    return `Row ${row} of this file, whose record this row replaces, is refused.`;
  const about = earlier.preview.subject;
  if (about && (about.kind !== subject.kind || about.id !== subject.id))
    return `Row ${row} of this file is about ${about.kind} ${about.id}, not ${subject.kind} ${subject.id}.`;
  return undefined;
}

async function findRecordedRow(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  artifactId: string,
  observationType: string,
  eventId: string,
): Promise<{ id: string; receipt_id: string } | undefined> {
  return (
    await client.query<{ id: string; receipt_id: string }>(
      `SELECT id,receipt_id FROM observations WHERE tenant_id=$1 AND source_id=$2 AND source_session_id=$3
       AND observation_type=$4 AND source_event_id=$5`,
      [tenantId, sourceId, artifactId, observationType, eventId],
    )
  ).rows[0];
}

/** The current record of an observed record type that holds the operator's own id, from any file. */
async function currentRecordWithId(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  observationType: string,
  ownId: string,
): Promise<string | undefined> {
  return (
    await client.query<{ id: string }>(
      `SELECT o.id FROM observations o WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=$3
         AND o.source_event_id=$4
         AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
         AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
       ORDER BY o.id LIMIT 1`,
      [tenantId, sourceId, observationType, ownId],
    )
  ).rows[0]?.id;
}

/**
 * A correction names a current record of the same type and subject, recorded under the same source. Intake checks the
 * source and currency again; this check explains a refusal row by row before anything is written.
 */
async function replacementProblem(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  definition: OperatorRecordDefinition,
  subject: { kind: string; id: string },
  replaces: string,
): Promise<string | undefined> {
  const target = (
    await client.query<{
      source_id: string;
      subject_kind: string;
      subject_id: string;
      record_type: string;
      replaced_by: string | null;
      withdrawn: boolean;
    }>(
      `SELECT o.source_id,o.subject_kind,o.subject_id,
         COALESCE(o.observation->'values'->>'recordType',o.observation_type) AS record_type,
         (SELECT r.id FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id) AS replaced_by,
         EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id) AS withdrawn
       FROM observations o WHERE o.tenant_id=$1 AND o.id=$2 AND o.observation_type=ANY($3::text[])`,
      [tenantId, replaces, [CARRIER.type, ...(definition.observed ? [definition.recordType] : [])]],
    )
  ).rows[0];
  if (!target) return `Record ${replaces} was not found, so this row cannot replace it.`;
  if (target.record_type !== definition.recordType)
    return `Record ${replaces} is a ${target.record_type} record, not ${definition.recordType}.`;
  if (target.source_id !== sourceId)
    return `Record ${replaces} was recorded under source ${target.source_id}; correct it under that source.`;
  if (target.subject_kind !== subject.kind || target.subject_id !== subject.id)
    return `Record ${replaces} is about ${target.subject_kind} ${target.subject_id}, not ${subject.kind} ${subject.id}.`;
  if (target.replaced_by)
    return `Record ${replaces} was already replaced by record ${target.replaced_by}; correct that record instead.`;
  return target.withdrawn ? `Record ${replaces} was withdrawn, so it cannot be corrected.` : undefined;
}

function summaryCounts<Status extends string>(rows: { status: Status; complete?: boolean }[]) {
  const count = (status: Status) => rows.filter((row) => row.status === status).length;
  return { count, incomplete: (status: Status) => rows.filter((row) => row.status === status && !row.complete).length };
}

/** What committing the file would record, row by row. Nothing is written. */
export async function previewOperatorRecordImport(
  client: PoolClient,
  principal: AuthContext,
  store: ObjectStore,
  request: OperatorRecordImportRequest,
): Promise<OperatorRecordPreviewResponse> {
  const evaluation = await evaluate(client, principal, store, request, new Date().toISOString());
  const rows = evaluation.rows.map((row) => row.preview);
  const { count, incomplete } = summaryCounts(rows);
  return {
    artifactId: request.artifactId,
    sourceId: evaluation.sourceId,
    recordType: evaluation.definition.recordType,
    recordVersion: evaluation.definition.recordVersion,
    format: evaluation.format,
    problems: evaluation.problems,
    ...(evaluation.mapping ? { mapping: evaluation.mapping } : {}),
    granted: await hasGrant(client, principal, evaluation.sourceId),
    summary: {
      rows: rows.length,
      acceptable: count('acceptable'),
      incomplete: incomplete('acceptable') + incomplete('already_recorded'),
      alreadyRecorded: count('already_recorded'),
      refused: count('refused'),
    },
    rows,
  };
}

/**
 * Records every acceptable row through generic observation intake, in one transaction. Rows already recorded from
 * this file are not recorded again; refused rows are reported and do not stop the others.
 */
export async function commitOperatorRecordImport(
  client: PoolClient,
  principal: AuthContext,
  store: ObjectStore,
  request: OperatorRecordImportRequest,
): Promise<OperatorRecordCommitResponse> {
  const sourceId = request.sourceId ?? OPERATOR_RECORD_SOURCE_ID;
  if (!(await hasGrant(client, principal, sourceId)))
    throw new DomainError(
      403,
      'observation_grant_required',
      `Recording operator records needs input:write and a grant for source ${sourceId}`,
      { sourceId, observationType: CARRIER.type },
    );
  // One commit of a file at a time, so two concurrent commits cannot both record its rows.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `operator-record-import:${principal.tenantId}:${sourceId}:${request.artifactId}`,
  ]);
  const evaluation = await evaluate(client, principal, store, request, new Date().toISOString());
  if (evaluation.problems.length)
    throw new DomainError(400, 'import_file_invalid', evaluation.problems.join(' '), {
      problems: evaluation.problems,
    });
  const input = (preview: OperatorRecordPreviewRow, observation: Record<string, unknown>): ObservationInput => ({
    sourceId,
    kind: 'observation',
    occurredAt: observation.occurredAt as string,
    payload: observation as ObservationInput['payload'],
    ...(preview.replaces ? { replaces: preview.replaces } : {}),
  });
  // The rows are recorded in file order; the flight views and subjects they lock are taken first, each in id order.
  await lockObservationTargets(
    client,
    principal.tenantId,
    evaluation.rows.flatMap(({ preview, observation, replacesRow }) =>
      preview.status === 'acceptable' && observation
        ? [input(replacesRow === undefined ? preview : { ...preview, replaces: undefined }, observation)]
        : [],
    ),
  );
  const rows: OperatorRecordCommitRow[] = [];
  const recordedRows = new Map<number, string>();
  for (const { preview: evaluated, observation, replacesRow } of evaluation.rows) {
    if (evaluated.status === 'already_recorded' && evaluated.observationId)
      recordedRows.set(evaluated.row, evaluated.observationId);
    if (evaluated.status !== 'acceptable' || !observation) {
      rows.push(evaluated as OperatorRecordCommitRow);
      continue;
    }
    const replacing = replacesRow === undefined ? evaluated.replaces : recordedRows.get(replacesRow);
    if (replacesRow !== undefined && !replacing) {
      rows.push({
        ...evaluated,
        status: 'refused',
        reasons: [`Row ${replacesRow} of this file, whose record this row replaces, was not recorded.`],
      });
      continue;
    }
    const preview = replacing ? { ...evaluated, replaces: replacing } : evaluated;
    if (preview.replaces) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `operator-record-replacement:${principal.tenantId}:${preview.replaces}`,
      ]);
      const reason = await replacementProblem(
        client,
        principal.tenantId,
        sourceId,
        evaluation.definition,
        preview.subject!,
        preview.replaces,
      );
      if (reason) {
        rows.push({ ...preview, status: 'refused', reasons: [reason] });
        continue;
      }
    }
    const receipt = await acceptInput(client, principal, input(preview, observation), {
      objectStore: store,
      // Keeping records is one permission: an observed record type is authorized by the operator.record grant.
      ...(evaluation.definition.observed ? { grantedBy: { sourceId, observationType: CARRIER.type } } : {}),
    });
    recordedRows.set(preview.row, receipt.eventId);
    rows.push({ ...preview, status: 'recorded', observationId: receipt.eventId, receiptId: receipt.id });
  }
  const { count, incomplete } = summaryCounts(rows);
  return {
    artifactId: request.artifactId,
    sourceId,
    recordType: evaluation.definition.recordType,
    recordVersion: evaluation.definition.recordVersion,
    format: evaluation.format,
    problems: [],
    ...(evaluation.mapping ? { mapping: evaluation.mapping } : {}),
    summary: {
      rows: rows.length,
      recorded: count('recorded'),
      incomplete: incomplete('recorded'),
      alreadyRecorded: count('already_recorded'),
      refused: count('refused'),
    },
    rows,
  };
}
