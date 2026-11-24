import { Type, type Static } from '@sinclair/typebox';
import {
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
} from './observations/envelope.js';
import type { OperatorRecordBody, OperatorRecordDefinition } from './observations/operator-records/define.js';
import { OperatorRecordViewSchema } from './operator-record-api.js';
import { OPERATOR_RECORD_SOURCE_ID } from './operator-record-import.js';
import { CoverageResultSchema } from './rule-coverage.js';
import { NamedSubjectSchema } from './rule-evaluations.js';

/**
 * Records by subject: the organization's subjects listed by kind with the names its records give them, and one
 * subject's file. Documented in docs/design/record-productions.md.
 */

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Count = Type.Integer({ minimum: 0 });
const Closed = { additionalProperties: false } as const;
const SubjectKind = Type.Union(observationSubjectKindValues.map((kind) => Type.Literal(kind)));

/** At most this many subjects of one kind are listed; more are reported as truncated. */
export const RECORD_SUBJECT_LIMIT = 2000;
export const RECORD_SUBJECT_PAGE_LIMIT = 200;
/** A subject's file shows at most this many records, newest first; the rest are read through the records list. */
export const RECORD_SUBJECT_FILE_LIMIT = 500;

// Names ---------------------------------------------------------------------------------------------------------------

function zonedParts(value: string, timeZone: string): { day: string; minute: string } | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: `${parts.hour}:${parts.minute}` };
}

/**
 * The name a record gives its subject, from the record type's name fields in order: times in the organization's zone,
 * two times in a row as one span, other values as written. Undefined when the type names nothing or the record holds
 * none of its name fields.
 */
export function recordSubjectName(
  definition: Pick<OperatorRecordDefinition, 'nameFields' | 'fields'>,
  record: OperatorRecordBody,
  timeZone: string,
): string | undefined {
  const pieces: string[] = [];
  let times: { day: string; minute: string }[] = [];
  const flushTimes = () => {
    if (!times.length) return;
    const [first, last] = [times[0]!, times.at(-1)!];
    const span =
      times.length === 1
        ? `${first.day} ${first.minute}`
        : `${first.day} ${first.minute} to ${last.day === first.day ? '' : `${last.day} `}${last.minute}`;
    pieces.push(`${span} (${timeZone})`);
    times = [];
  };
  for (const name of definition.nameFields ?? []) {
    const field = definition.fields.find((candidate) => candidate.name === name);
    const value = record[name];
    if (!field || value === undefined || value === null || value === '') continue;
    const zoned = field.kind === 'date_time' && typeof value === 'string' ? zonedParts(value, timeZone) : undefined;
    if (zoned) {
      times.push(zoned);
      continue;
    }
    flushTimes();
    pieces.push(typeof value === 'object' ? String((value as { id?: unknown }).id ?? '') : String(value).trim());
  }
  flushTimes();
  const name = pieces.filter(Boolean).join(', ');
  return name ? name.slice(0, 1000) : undefined;
}

// Subjects ------------------------------------------------------------------------------------------------------------

export const RecordSubjectsQuerySchema = Type.Object(
  {
    kind: SubjectKind,
    search: Type.Optional(Type.String({ maxLength: 200, description: 'Part of a name or id, in any case.' })),
    sourceId: Type.Optional(Id),
    cursor: Type.Optional(Type.String({ maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: RECORD_SUBJECT_PAGE_LIMIT })),
  },
  {
    ...Closed,
    description: `The organization’s subjects of one kind that its records are about, by id. sourceId defaults to ${OPERATOR_RECORD_SOURCE_ID}.`,
  },
);
export type RecordSubjectsQuery = Static<typeof RecordSubjectsQuerySchema>;

export const RecordSubjectSummarySchema = Type.Object(
  {
    subject: NamedSubjectSchema,
    named: Type.Boolean({ description: 'Whether a record gives the subject a name; otherwise name is its id.' }),
    records: Type.Object(
      {
        about: Count,
        current: Count,
      },
      {
        ...Closed,
        description:
          'about: records about the subject, as their subject, related subject or a reference, replaced ones included. current: those not replaced.',
      },
    ),
    openFindings: Count,
    latestAt: Type.Union([Time, Type.Null()], { description: 'The latest time a record about the subject is about.' }),
  },
  Closed,
);
export type RecordSubjectSummary = Static<typeof RecordSubjectSummarySchema>;

export const RecordSubjectsResponseSchema = Type.Object(
  {
    kind: SubjectKind,
    sourceId: Id,
    subjects: Type.Array(RecordSubjectSummarySchema),
    page: Type.Object(
      { limit: Type.Integer(), hasMore: Type.Boolean(), nextCursor: Type.Union([Type.String(), Type.Null()]) },
      Closed,
    ),
    truncated: Type.Boolean({ description: `True when more than ${RECORD_SUBJECT_LIMIT} subjects of the kind exist.` }),
  },
  Closed,
);
export type RecordSubjectsResponse = Static<typeof RecordSubjectsResponseSchema>;

export const RecordSubjectParamsSchema = Type.Object({ kind: SubjectKind, id: Id }, Closed);
export type RecordSubjectParams = Static<typeof RecordSubjectParamsSchema>;
export const RecordSubjectQuerySchema = Type.Object({ sourceId: Type.Optional(Id) }, Closed);
export type RecordSubjectQuery = Static<typeof RecordSubjectQuerySchema>;

/** Whether the adoption a result came under counts it: active, or shadow for a result that is recorded and not counted. */
const AdoptionModeOfResult = Type.Union([Type.Literal('active'), Type.Literal('shadow')], {
  description: 'shadow: the pack is adopted in shadow, so the result is recorded and never counted.',
});

export const RecordSubjectRuleSchema = Type.Object(
  {
    adoptionId: Id,
    packId: Id,
    packTitle: Type.String(),
    mode: AdoptionModeOfResult,
    leafId: Id,
    title: Type.String(),
    result: CoverageResultSchema,
    evaluation: Type.Object(
      { id: Id, outcome: Type.String(), reasonCode: Type.String(), summary: Type.String(), recordedAt: Time },
      Closed,
    ),
    finding: Type.Union([Type.Object({ id: Id, status: Type.String() }, Closed), Type.Null()]),
  },
  { ...Closed, description: 'A rule that has evaluated the subject, with its latest result under the adoption.' },
);
export type RecordSubjectRule = Static<typeof RecordSubjectRuleSchema>;

export const RecordSubjectFindingSchema = Type.Object(
  {
    id: Id,
    status: Type.String(),
    packId: Id,
    mode: AdoptionModeOfResult,
    leafId: Id,
    title: Type.String(),
    openedAt: Time,
  },
  Closed,
);

export const RecordSubjectGroupSchema = Type.Object(
  {
    recordType: ObservationTypeIdSchema,
    recordVersion: ObservationVersionSchema,
    title: Type.String(),
    records: Type.Array(OperatorRecordViewSchema),
  },
  { ...Closed, description: 'Records of one type about the subject, newest first, replaced ones marked replacedBy.' },
);

export const RecordSubjectFileSchema = Type.Object(
  {
    subject: NamedSubjectSchema,
    named: Type.Boolean(),
    sourceId: Id,
    groups: Type.Array(RecordSubjectGroupSchema),
    records: Type.Object(
      { shown: Count, truncated: Type.Boolean() },
      {
        ...Closed,
        description: `At most ${RECORD_SUBJECT_FILE_LIMIT} records, newest first; read older ones from the records list by subject and dates.`,
      },
    ),
    rules: Type.Array(RecordSubjectRuleSchema),
    findings: Type.Array(RecordSubjectFindingSchema, { description: 'Findings about the subject not yet resolved.' }),
  },
  Closed,
);
export type RecordSubjectFile = Static<typeof RecordSubjectFileSchema>;
