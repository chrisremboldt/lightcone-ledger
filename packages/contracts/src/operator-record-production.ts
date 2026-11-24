import { Type, type Static } from '@sinclair/typebox';
import { ObservationTypeIdSchema, observationSubjectKindValues } from './observations/envelope.js';
import type { OperatorRecordDefinition, OperatorRecordField } from './observations/operator-records/define.js';
import {
  csvCell,
  enteredColumn,
  OPERATOR_RECORD_SOURCE_ID,
  producedRecordColumns,
  recordImportColumns,
  storedUnit,
} from './operator-record-import.js';

/**
 * Producing records on request: one .zip a person can open and an inspector can read, holding a CSV per record type
 * in the import template's columns, a printable index and a manifest of digests. Documented in
 * docs/design/record-productions.md.
 */

export const RECORD_PRODUCTION_FORMAT = 'ledger.record-production.1';

/**
 * Bounds of one produced file. 10,000 records is several years of one aircraft's or person's records, or most of a
 * year of a small fleet's, at about 400 bytes a CSV row; originals are each at most 10 MiB (the upload limit).
 */
export const RECORD_PRODUCTION_LIMITS = {
  maxRecords: 10_000,
  maxSubjects: 50,
  maxOriginalBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 96 * 1024 * 1024,
} as const;
export type RecordProductionLimits = { readonly [Key in keyof typeof RECORD_PRODUCTION_LIMITS]: number };

export const RECORD_PRODUCTION_PAGE_LIMIT = 100;

// CSV -------------------------------------------------------------------------------------------------------------------

interface ExportSubject {
  readonly kind: string;
  readonly id: string;
  readonly scope: 'ledger' | 'source';
}

/** One record as a produced CSV row. */
export interface ProducedRecordRow {
  readonly recordId: string;
  readonly subject: ExportSubject;
  readonly secondarySubject?: ExportSubject;
  readonly record: Readonly<Record<string, unknown>>;
  readonly replaces?: string;
  readonly replacedBy?: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly originalFile: string;
  readonly originalSha256: string;
  /** What intake noted about the record, such as a unit conversion. */
  readonly limitations: readonly string[];
  /** What was written for each field the import converted. */
  readonly entered?: Readonly<Record<string, string>>;
  /** The placing fields given as a date alone, by field name. */
  readonly dayOnly?: Readonly<Record<string, { readonly day: string }>>;
}

/** A field whose value may have been entered in another unit or zone, so its produced file shows it as entered. */
const shownAsEntered = (field: OperatorRecordField) => field.kind === 'number' || field.kind === 'date_time';

export function producedCsvColumns(definition: OperatorRecordDefinition): string[] {
  return [
    ...recordImportColumns(definition).flatMap((column) => {
      const field = definition.fields.find((candidate) => candidate.name === column.key);
      return field && shownAsEntered(field) ? [column.key, enteredColumn(column.key)] : [column.key];
    }),
    ...Object.values(producedRecordColumns),
  ];
}

/**
 * A value as it was entered: what the import converted it from, else the stored value with its unit; a date alone
 * says so. Undefined for a field with no value.
 */
export function enteredValue(
  field: OperatorRecordField,
  value: unknown,
  row: Pick<ProducedRecordRow, 'entered' | 'dayOnly'>,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const written = row.entered?.[field.name];
  if (written) return written;
  const day = row.dayOnly?.[field.name]?.day;
  if (day) return `${day} (date only)`;
  if (field.kind === 'number')
    return field.unit === 'Count' ? String(value) : `${value} ${storedUnit(field.unit).unit}`;
  return String(value);
}

function fieldCell(
  definition: OperatorRecordDefinition,
  name: string,
  value: unknown,
  notes: string[],
): string | undefined {
  const field = definition.fields.find((candidate) => candidate.name === name);
  if (!field || value === undefined || value === null) return undefined;
  if (field.kind === 'boolean') return value ? 'yes' : 'no';
  if (field.kind === 'reference') {
    const reference = value as { id?: unknown; scope?: unknown };
    if (reference.scope === 'ledger') notes.push(`${field.label} (${field.name}) names Ledger id ${reference.id}.`);
    return String(reference.id ?? '');
  }
  return String(value);
}

function subjectCells(subject: ExportSubject | undefined, role: string, notes: string[]): { id: string; kind: string } {
  if (!subject) return { id: '', kind: '' };
  // A record about the operator's own organization has no subject id: the importing organization is its subject.
  if (subject.kind === 'organization' && subject.scope === 'ledger') return { id: '', kind: subject.kind };
  if (subject.scope === 'ledger') notes.push(`The ${role} ${subject.kind} ${subject.id} is a Ledger id.`);
  return { id: subject.id, kind: subject.kind };
}

/**
 * Writes records of one type as CSV in the import template's columns plus the produced columns. Values are in their
 * stored units, so importing the file records the same values; beside each number and time, a column shows it as it
 * was entered, with its unit or zone. A date alone is written as the date.
 */
export function producedRecordCsv(definition: OperatorRecordDefinition, rows: readonly ProducedRecordRow[]): string {
  const columns = producedCsvColumns(definition);
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    const notes: string[] = [];
    const subject = subjectCells(row.subject, 'subject', notes);
    const secondary = subjectCells(row.secondarySubject, 'related subject', notes);
    const cells: Record<string, string | undefined> = {
      subjectId: subject.id,
      subjectKind: subject.kind,
      secondarySubjectId: secondary.id,
      secondarySubjectKind: secondary.kind,
      replaces: row.replaces,
      recordId: row.recordId,
      recordedAt: row.recordedAt,
      recordedBy: row.recordedBy,
      replacedBy: row.replacedBy,
      originalFile: row.originalFile,
      originalSha256: row.originalSha256,
    };
    for (const field of definition.fields) {
      const value = row.record[field.name];
      // A date alone is written as the date, as it was entered; importing it again places it on that day.
      cells[field.name] = row.dayOnly?.[field.name]?.day ?? fieldCell(definition, field.name, value, notes);
      if (shownAsEntered(field)) cells[enteredColumn(field.name)] = enteredValue(field, value, row);
    }
    cells.notes = [...row.limitations, ...notes].join(' ') || undefined;
    lines.push(columns.map((column) => csvCell(cells[column] ?? '')).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** The path of a record type's CSV inside a produced file. */
export const producedCsvPath = (recordType: string, recordVersion: number) =>
  `records/${recordType}-v${recordVersion}.csv`;

// API -------------------------------------------------------------------------------------------------------------------

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Count = Type.Integer({ minimum: 0 });
const Closed = { additionalProperties: false } as const;
const SubjectKind = Type.Union(observationSubjectKindValues.map((kind) => Type.Literal(kind)));

export const RecordProductionSubjectSchema = Type.Object(
  {
    kind: SubjectKind,
    id: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: 'Your own id; left out for your own organization.' }),
    ),
  },
  Closed,
);

export const RecordProductionSelectionSchema = Type.Object(
  {
    subjects: Type.Array(RecordProductionSubjectSchema, {
      maxItems: RECORD_PRODUCTION_LIMITS.maxSubjects,
      description:
        'The subjects whose records to produce: records about each as their subject, related subject or through a reference. Empty for every subject.',
    }),
    recordTypes: Type.Array(ObservationTypeIdSchema, {
      maxItems: 100,
      description: 'The record types to produce. Empty for every type.',
    }),
    from: Type.Union([Time, Type.Null()], { description: 'Records whose time ends at or after this instant.' }),
    to: Type.Union([Time, Type.Null()], { description: 'Records whose time starts before this instant.' }),
    includeOriginals: Type.Boolean({ description: 'Whether the original files the records came from are included.' }),
    withFlights: Type.Boolean({
      description:
        'Whether the records of the flights a selected person was assigned to are included too. They are always listed.',
    }),
    sourceId: Id,
  },
  Closed,
);
export type RecordProductionSelection = Static<typeof RecordProductionSelectionSchema>;

export const RecordProductionCreateSchema = Type.Object(
  {
    subjects: Type.Optional(RecordProductionSelectionSchema.properties.subjects),
    recordTypes: Type.Optional(RecordProductionSelectionSchema.properties.recordTypes),
    from: Type.Optional(Time),
    to: Type.Optional(Time),
    includeOriginals: Type.Optional(Type.Boolean()),
    withFlights: Type.Optional(Type.Boolean()),
    sourceId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: `Defaults to ${OPERATOR_RECORD_SOURCE_ID}.` }),
    ),
    reason: Type.String({
      minLength: 1,
      maxLength: 1000,
      pattern: '\\S',
      description: 'Why the records are produced, as it will be printed in the file.',
    }),
    requestedBy: Type.String({
      minLength: 1,
      maxLength: 300,
      pattern: '\\S',
      description: 'Who asked for them: a person, an office or an authority, in your words.',
    }),
  },
  Closed,
);
export type RecordProductionCreate = Static<typeof RecordProductionCreateSchema>;

export const RecordProductionCountsSchema = Type.Object(
  {
    records: Count,
    recordTypes: Count,
    replaced: Count,
    originals: Count,
    originalsIncluded: Count,
    originalBytes: Count,
    originalsWithOtherRecords: Type.Integer({
      minimum: 0,
      description: 'Original files that also hold records this file does not, such as rows about other subjects.',
    }),
    otherRecords: Type.Integer({ minimum: 0, description: 'How many such records those files hold in all.' }),
    flights: Type.Integer({
      minimum: 0,
      description: 'Flights a selected person was assigned to, listed in the file.',
    }),
  },
  Closed,
);

export const RecordProductionSchema = Type.Object(
  {
    id: Id,
    format: Type.Literal(RECORD_PRODUCTION_FORMAT),
    eventId: Id,
    organization: Type.Object({ id: Id, name: Type.String(), timeZone: Type.String() }, Closed),
    producedBy: Type.Object({ id: Id, name: Type.Optional(Type.String()) }, Closed),
    producedAt: Time,
    reason: Type.String(),
    requestedBy: Type.String(),
    selection: RecordProductionSelectionSchema,
    counts: RecordProductionCountsSchema,
    byteLength: Type.Integer({ minimum: 1 }),
    archiveSha256: Digest,
    manifestSha256: Type.String({
      pattern: '^[a-f0-9]{64}$',
      description: 'SHA-256 of manifest.json inside the file. Keep it apart from the file to verify it later.',
    }),
    limits: Type.Object(
      { maxRecords: Count, maxSubjects: Count, maxOriginalBytes: Count, maxArchiveBytes: Count },
      Closed,
    ),
  },
  Closed,
);
export type RecordProduction = Static<typeof RecordProductionSchema>;

export const RecordProductionResponseSchema = Type.Object({ record: RecordProductionSchema }, Closed);
export const RecordProductionParamsSchema = Type.Object({ id: Id }, Closed);
export type RecordProductionParams = Static<typeof RecordProductionParamsSchema>;
export const RecordProductionQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: RECORD_PRODUCTION_PAGE_LIMIT })),
  },
  Closed,
);
export type RecordProductionQuery = Static<typeof RecordProductionQuerySchema>;
export const RecordProductionListResponseSchema = Type.Object(
  {
    records: Type.Array(RecordProductionSchema),
    page: Type.Object(
      {
        limit: Type.Integer(),
        returned: Type.Integer(),
        hasMore: Type.Boolean(),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
      },
      Closed,
    ),
  },
  Closed,
);
export type RecordProductionListResponse = Static<typeof RecordProductionListResponseSchema>;

// Manifest --------------------------------------------------------------------------------------------------------------

export interface RecordProductionManifestFile {
  readonly path: string;
  readonly role: 'index' | 'records' | 'original';
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly recordType?: string;
  readonly recordVersion?: number;
  /** Data rows of a records file. */
  readonly rows?: number;
  readonly artifactId?: string;
}

export interface RecordProductionOriginal {
  readonly artifactId: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly records: number;
  /** Records from the same file that this file does not hold, such as rows about other subjects. */
  readonly otherRecords: number;
  /** Its path in the file when originals were asked for; null when only listed. */
  readonly path: string | null;
}

export interface RecordProductionFlight {
  readonly person: string;
  readonly flight: string;
  /** The time of the record that names the person, such as the assignment's start and end. */
  readonly start: string;
  readonly end: string | null;
  readonly recordId: string;
}

export interface RecordProductionJournalPosition {
  readonly stream: string;
  readonly sequence: number;
  readonly headHash: string;
}

/** manifest.json: what the file holds, why and for whom, and the SHA-256 of every other file in it. */
export interface RecordProductionManifest {
  readonly format: typeof RECORD_PRODUCTION_FORMAT;
  readonly productionId: string;
  readonly organization: { readonly id: string; readonly name: string; readonly timeZone: string };
  readonly producedBy: { readonly id: string; readonly name?: string };
  readonly producedAt: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly selection: RecordProductionSelection;
  /** Each journal stream the records were read from, at the position it stood at when they were read. */
  readonly journal: readonly RecordProductionJournalPosition[];
  readonly counts: Static<typeof RecordProductionCountsSchema>;
  readonly limits: RecordProductionLimits;
  readonly files: readonly RecordProductionManifestFile[];
  readonly originals: readonly RecordProductionOriginal[];
  /** The flights each selected person was assigned to, by the records about the person that name a flight. */
  readonly flights: readonly RecordProductionFlight[];
  readonly statements: readonly string[];
}
