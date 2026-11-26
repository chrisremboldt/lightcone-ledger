import { Type, type Static } from '@sinclair/typebox';
import { AcceptedObservationSubjectSchema } from './observation-intake.js';
import {
  ObservationSubjectSchema,
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
} from './observations/envelope.js';
import { OPERATOR_RECORD_SOURCE_ID } from './operator-record-import.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Closed = { additionalProperties: false } as const;
const literals = <const Values extends readonly string[]>(values: Values) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const SubjectKind = literals(observationSubjectKindValues);

const EntryUnitSchema = Type.Object(
  {
    unit: Type.String(),
    label: Type.String(),
    factor: Type.Number(),
    aliases: Type.Optional(Type.Array(Type.String(), { description: 'Other names accepted for the same unit.' })),
  },
  { ...Closed, description: 'Multiply an entered value by factor to get the stored unit.' },
);
const OptionSchema = Type.Object({ value: Type.String(), label: Type.String() }, Closed);

export const OperatorRecordFieldSchema = Type.Object(
  {
    name: Type.String(),
    label: Type.String(),
    kind: literals(['text', 'long_text', 'boolean', 'date', 'date_time', 'number', 'select', 'reference'] as const),
    required: Type.Boolean(),
    replayOnly: Type.Boolean(),
    help: Type.Optional(Type.String()),
    unit: Type.Optional(Type.String()),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
    integer: Type.Optional(Type.Boolean()),
    options: Type.Optional(Type.Array(OptionSchema)),
    referenceKind: Type.Optional(Type.String()),
    requiredUnless: Type.Optional(
      Type.String({ description: 'Counts toward completeness unless this other field has a value.' }),
    ),
  },
  Closed,
);

export const RecordImportColumnSchema = Type.Object(
  {
    key: Type.String({ description: 'The CSV header or JSON property name.' }),
    label: Type.String(),
    kind: Type.String(),
    required: Type.Boolean({ description: 'Counts toward completeness; a row without it is still recorded.' }),
    replayOnly: Type.Boolean(),
    help: Type.Optional(Type.String()),
    field: Type.Optional(Type.String()),
    units: Type.Optional(
      Type.Object(
        {
          stored: Type.String(),
          stem: Type.String({ description: 'Write `stem [unit]` as the column name to enter another unit.' }),
          accepted: Type.Array(EntryUnitSchema),
        },
        Closed,
      ),
    ),
    options: Type.Optional(Type.Array(OptionSchema)),
    referenceKind: Type.Optional(Type.String()),
    subjectKinds: Type.Optional(Type.Array(SubjectKind)),
    placesRecord: Type.Optional(
      Type.Literal(true, {
        description:
          'The column places the record in time: a row with it empty is refused, not recorded as incomplete.',
      }),
    ),
    takesDate: Type.Optional(
      Type.Literal(true, {
        description: 'The column takes a date alone (2026-10-05), read as that day in the organization’s time zone.',
      }),
    ),
    requiredUnless: Type.Optional(
      Type.String({ description: 'Counts toward completeness unless this other column has a value.' }),
    ),
  },
  Closed,
);

export const OperatorRecordTypeSummarySchema = Type.Object(
  {
    recordType: ObservationTypeIdSchema,
    recordVersion: ObservationVersionSchema,
    title: Type.String(),
    description: Type.String(),
    subjectKinds: Type.Array(SubjectKind),
    secondarySubjectKinds: Type.Array(SubjectKind),
    time: Type.Object(
      {
        meaning: literals(['as_of', 'event', 'interval'] as const),
        atField: Type.Optional(Type.String()),
        startField: Type.Optional(Type.String()),
        endField: Type.Optional(Type.String()),
      },
      Closed,
    ),
    fields: Type.Array(OperatorRecordFieldSchema),
    columns: Type.Array(RecordImportColumnSchema, {
      description: 'The import columns, generated from the fields: the CSV header and the JSON record properties.',
    }),
    mayInfer: Type.Array(Type.String()),
    mayNotInfer: Type.Array(Type.String()),
    ruleRead: Type.Object(
      {
        type: ObservationTypeIdSchema,
        versions: Type.Array(ObservationVersionSchema),
        where: Type.Array(
          Type.Object({ field: Type.String(), oneOf: Type.Array(Type.Union([Type.String(), Type.Number()])) }, Closed),
        ),
        fields: Type.Array(Type.Object({ name: Type.String(), path: Type.String() }, Closed)),
      },
      {
        ...Closed,
        description:
          'How a rule reads records of this type: the observation type and versions its read takes, the conditions that select this record type (none when the type is recorded as its own observation type), and the path a rule names each field by.',
      },
    ),
  },
  Closed,
);
export type OperatorRecordTypeSummary = Static<typeof OperatorRecordTypeSummarySchema>;

export const OperatorRecordTypesResponseSchema = Type.Object(
  {
    types: Type.Array(OperatorRecordTypeSummarySchema),
    sourceId: Type.String({ description: 'The conventional source id for records people import and enter.' }),
  },
  Closed,
);
export type OperatorRecordTypesResponse = Static<typeof OperatorRecordTypesResponseSchema>;

export const OperatorRecordTemplateParamsSchema = Type.Object(
  { recordType: ObservationTypeIdSchema, version: Type.String({ pattern: '^[1-9][0-9]{0,6}$' }) },
  Closed,
);
export type OperatorRecordTemplateParams = Static<typeof OperatorRecordTemplateParamsSchema>;
export const OperatorRecordTemplateQuerySchema = Type.Object(
  { format: Type.Optional(literals(['csv', 'json'] as const)) },
  Closed,
);
export type OperatorRecordTemplateQuery = Static<typeof OperatorRecordTemplateQuerySchema>;

export const OperatorRecordImportRequestSchema = Type.Object(
  {
    artifactId: Id,
    recordType: ObservationTypeIdSchema,
    recordVersion: ObservationVersionSchema,
    sourceId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: `The source the records are recorded under. Defaults to ${OPERATOR_RECORD_SOURCE_ID}.`,
      }),
    ),
    mappingArtifactId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          'A retained column mapping file (YAML, uploaded through /v1/uploads) that reads the file, an export in its own columns, as this record type. Each record cites the export as its original and names the mapping.',
      }),
    ),
    originalArtifactId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          'A retained file (uploaded through /v1/uploads) the import file was read from, such as an aircraft’s own log read into Ledger’s columns. Each record cites it as its original and names the import file as the reading of it. Not given with a column mapping.',
      }),
    ),
  },
  {
    ...Closed,
    description:
      'Preview or commit one retained file (uploaded through /v1/uploads) as records of one record type: CSV with a header row, or JSON with a records array; or, with a column mapping, a CSV export as it was received.',
  },
);
export type OperatorRecordImportRequest = Static<typeof OperatorRecordImportRequestSchema>;

const LocatorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('json_pointer'), value: Type.String() }, Closed),
  Type.Object(
    {
      kind: Type.Literal('byte_range'),
      value: Type.Object({ offsetBytes: Type.Integer(), lengthBytes: Type.Integer() }, Closed),
    },
    Closed,
  ),
]);
const NamedFieldSchema = Type.Object({ name: Type.String(), label: Type.String() }, Closed);
const ConversionSchema = Type.Object(
  {
    field: Type.String(),
    entered: Type.Object({ value: Type.Number(), unit: Type.String() }, Closed),
    stored: Type.Object({ value: Type.Number(), unit: Type.String() }, Closed),
  },
  Closed,
);
const TimeConversionSchema = Type.Object(
  {
    field: Type.String(),
    entered: Type.String({ description: 'The time as entered.' }),
    timeZone: Type.Optional(
      Type.String({ description: 'The zone it was read in; absent when the value stated its own offset.' }),
    ),
    stored: Time,
    precision: Type.Optional(
      Type.Literal('day', {
        description: 'A date alone was entered: the record is placed on that day in the zone, from its first instant.',
      }),
    ),
    endOfDay: Type.Optional(
      Type.Literal(true, {
        description:
          "The date alone was in the column that ends the record's interval: it is stored as the end of that day, the first instant of the next day.",
      }),
    ),
  },
  Closed,
);
const DayOnlySchema = Type.Record(
  Type.String(),
  Type.Object(
    {
      day: Type.String({ format: 'date' }),
      timeZone: Type.String(),
      nextDayAt: Time,
    },
    Closed,
  ),
  {
    description:
      'The fields given as a date alone (the one that places the record, or a time a report or notice was made): the day, the zone it is in and the first instant of the next day. The field itself holds the first instant of the day, or the end of the day (the first instant of the next day) for the field that ends the interval of the record.',
  },
);
const IntervalSchema = Type.Object({ start: Time, end: Type.Optional(Time) }, Closed);

const rowStatus = <const Values extends readonly string[]>(values: Values, description: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );

const rowProperties = {
  row: Type.Integer({ minimum: 1, description: 'Data row (CSV, after the header) or record (JSON) number.' }),
  locator: LocatorSchema,
  subject: Type.Optional(ObservationSubjectSchema),
  secondarySubject: Type.Optional(ObservationSubjectSchema),
  replaces: Type.Optional(Type.String({ description: 'The record this row replaces.' })),
  record: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  dayOnly: Type.Optional(DayOnlySchema),
  occurredAt: Type.Optional(Time),
  interval: Type.Optional(IntervalSchema),
  complete: Type.Optional(Type.Boolean()),
  missingRequired: Type.Array(NamedFieldSchema, {
    description: 'Required fields with no value. The record is still recorded, as incomplete.',
  }),
  conversions: Type.Array(ConversionSchema),
  timeConversions: Type.Array(TimeConversionSchema, {
    description:
      'Times entered in the organization’s time zone, with an offset or as a date alone, and the UTC instant recorded.',
  }),
  reasons: Type.Array(Type.String(), { description: 'Why the row is refused, in plain words.' }),
  notes: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'What the row gave that is not used, in plain words, such as a subject id for a record about your own organization. The row is still recorded.',
    }),
  ),
  observationId: Type.Optional(Id),
  receiptId: Type.Optional(Id),
};

export const OperatorRecordPreviewRowSchema = Type.Object(
  {
    ...rowProperties,
    status: rowStatus(
      ['acceptable', 'already_recorded', 'refused'] as const,
      'acceptable: committing records it. already_recorded: this row of this file is already recorded. refused: see reasons.',
    ),
  },
  Closed,
);
export type OperatorRecordPreviewRow = Static<typeof OperatorRecordPreviewRowSchema>;
export const OperatorRecordCommitRowSchema = Type.Object(
  { ...rowProperties, status: rowStatus(['recorded', 'already_recorded', 'refused'] as const, 'What commit did.') },
  Closed,
);
export type OperatorRecordCommitRow = Static<typeof OperatorRecordCommitRowSchema>;

const MappingReadSchema = Type.Object(
  {
    artifactId: Id,
    columns: Type.Array(
      Type.Object(
        {
          source: Type.String({ description: 'The export’s heading.' }),
          becomes: Type.String({ description: 'What the mapping reads it as, in plain words.' }),
        },
        Closed,
      ),
    ),
    unread: Type.Array(Type.String(), { description: 'The export’s columns the mapping does not read.' }),
    constants: Type.Array(Type.Object({ field: Type.String(), value: Type.String() }, Closed), {
      description: 'Values the mapping states for every row, which the export does not hold.',
    }),
    leftOut: Type.Array(Type.Object({ row: Type.Integer({ minimum: 1 }), reason: Type.String() }, Closed), {
      description: 'Rows of the export the mapping leaves out, by their value in a column. They are not in rows.',
    }),
  },
  { ...Closed, description: 'How the column mapping read the export.' },
);

const fileProperties = {
  artifactId: Id,
  sourceId: Id,
  recordType: ObservationTypeIdSchema,
  recordVersion: ObservationVersionSchema,
  format: literals(['csv', 'json'] as const),
  problems: Type.Array(Type.String(), { description: 'Problems with the whole file; such a file yields no rows.' }),
  mapping: Type.Optional(MappingReadSchema),
};

export const OperatorRecordPreviewResponseSchema = Type.Object(
  {
    ...fileProperties,
    granted: Type.Boolean({ description: 'Whether you may commit: input:write and a grant for this source.' }),
    summary: Type.Object(
      {
        rows: Type.Integer(),
        acceptable: Type.Integer(),
        incomplete: Type.Integer(),
        alreadyRecorded: Type.Integer(),
        refused: Type.Integer(),
      },
      Closed,
    ),
    rows: Type.Array(OperatorRecordPreviewRowSchema),
  },
  { ...Closed, description: 'What committing this file would record. Nothing is written.' },
);
export type OperatorRecordPreviewResponse = Static<typeof OperatorRecordPreviewResponseSchema>;

export const OperatorRecordCommitResponseSchema = Type.Object(
  {
    ...fileProperties,
    summary: Type.Object(
      {
        rows: Type.Integer(),
        recorded: Type.Integer(),
        incomplete: Type.Integer({ description: 'Rows recorded by this commit that are incomplete.' }),
        alreadyRecorded: Type.Integer(),
        refused: Type.Integer(),
      },
      Closed,
    ),
    rows: Type.Array(OperatorRecordCommitRowSchema),
  },
  Closed,
);
export type OperatorRecordCommitResponse = Static<typeof OperatorRecordCommitResponseSchema>;

export const OPERATOR_RECORD_PAGE_LIMIT = 500;
export const OperatorRecordQuerySchema = Type.Object(
  {
    recordType: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        pattern: '^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+(?:,[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+)*$',
        description: 'One record type, or several separated by commas. Every type when left out.',
      }),
    ),
    recordVersion: Type.Optional(ObservationVersionSchema),
    subjectKind: Type.Optional(SubjectKind),
    subjectId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          'The operator’s own id for a subject. Records about it as their subject, their related subject or through a reference field of its kind are returned, each with `about` saying which.',
      }),
    ),
    from: Type.Optional(
      Type.String({ format: 'date-time', description: 'Records whose time ends at or after this instant.' }),
    ),
    to: Type.Optional(
      Type.String({ format: 'date-time', description: 'Records whose time starts before this instant.' }),
    ),
    sourceId: Type.Optional(Id),
    cursor: Type.Optional(Type.String({ maxLength: 4096, description: 'The nextCursor of the previous page.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OPERATOR_RECORD_PAGE_LIMIT })),
  },
  {
    ...Closed,
    description: `Records by type, subject and the time they are about, newest first and then by id, a page at a time. Replaced records are included and carry replacedBy. sourceId defaults to ${OPERATOR_RECORD_SOURCE_ID}.`,
  },
);
export type OperatorRecordQuery = Static<typeof OperatorRecordQuerySchema>;

export const OperatorRecordViewSchema = Type.Object(
  {
    observationId: Id,
    receiptId: Id,
    sourceId: Id,
    recordType: ObservationTypeIdSchema,
    recordVersion: ObservationVersionSchema,
    subject: AcceptedObservationSubjectSchema,
    secondarySubject: Type.Optional(AcceptedObservationSubjectSchema),
    occurredAt: Time,
    interval: Type.Optional(IntervalSchema),
    receivedAt: Time,
    record: Type.Record(Type.String(), Type.Unknown()),
    dayOnly: Type.Optional(DayOnlySchema),
    complete: Type.Boolean(),
    missingRequired: Type.Array(NamedFieldSchema),
    missingReplay: Type.Array(NamedFieldSchema),
    limitations: Type.Array(Type.String()),
    origin: Type.Object(
      {
        artifactId: Id,
        filename: Type.Optional(Type.String()),
        contentType: Type.String(),
        byteLength: Type.Integer(),
        locator: Type.Optional(LocatorSchema),
        recordedBy: Type.Object({ id: Id, name: Type.Optional(Type.String()) }, Closed),
      },
      { ...Closed, description: 'The retained original bytes the record came from, and who recorded it.' },
    ),
    replaces: Type.Optional(Id),
    replacedBy: Type.Optional(Id),
    about: Type.Optional(
      Type.Union([Type.Literal('subject'), Type.Literal('related_subject'), Type.Literal('reference')], {
        description:
          'When a read named a subject: whether the record is about it as its subject, its related subject or through a reference field.',
      }),
    ),
  },
  Closed,
);
export type OperatorRecordView = Static<typeof OperatorRecordViewSchema>;

export const OperatorRecordListResponseSchema = Type.Object(
  {
    records: Type.Array(OperatorRecordViewSchema),
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
export type OperatorRecordListResponse = Static<typeof OperatorRecordListResponseSchema>;
