import { Type, type Static } from '@sinclair/typebox';
import { DocumentPurposeIdSchema } from './observations/envelope.js';
import { DocumentBodyV2Schema, smsRecordKindValues } from './sms.js';

const Identifier = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Time = Type.String({ format: 'date-time' });
const HolderTitle = Type.String({ description: 'What a person calls this kind of record.' });

const QuotedText = Type.Object(
  {
    reference: Identifier,
    text: Type.String({ description: 'The words quoted, exactly as the pack pins them.' }),
  },
  { additionalProperties: false },
);

const OnFileSchema = Type.Object(
  {
    current: Type.Integer({
      minimum: 0,
      description: 'Records on file now: neither replaced by a correction nor withdrawn.',
    }),
    replaced: Type.Integer({
      minimum: 0,
      description: 'Earlier versions a correction replaced or a withdrawal ended. Kept, never removed.',
    }),
    earliest: Type.Union([Time, Type.Null()], {
      description: 'The earliest time a current record starts: the start of its interval, or its single time.',
    }),
    latest: Type.Union([Time, Type.Null()], {
      description:
        'The latest time a current record starts: the start of its interval, or its single time. An interval’s end is not read, since for many records it is a schedule, such as a next due time.',
    }),
  },
  { additionalProperties: false, description: 'What is on file. A count, never a judgment.' },
);
export type RequiredRecordOnFile = Static<typeof OnFileSchema>;

export const RequiredRecordViewSchema = Type.Object(
  {
    id: DocumentPurposeIdSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    keptBy: Type.String({ description: 'Who the text says keeps it, in its own words.' }),
    source: QuotedText,
    retention: Type.Union([QuotedText, Type.Null()], {
      description: 'How long the text says it is kept, in its own words; null when the text states no period.',
    }),
    declaredBy: Type.Array(
      Type.Object({ packId: Identifier, version: Version, packTitle: Identifier }, { additionalProperties: false }),
      { minItems: 1 },
    ),
    heldBy: Type.Array(
      Type.Union([
        Type.Object(
          { kind: Type.Literal('operator_record'), recordType: Identifier, title: HolderTitle, onFile: OnFileSchema },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('safety_record'),
            recordKind: Type.Union(smsRecordKindValues.map((value) => Type.Literal(value))),
            title: HolderTitle,
            onFile: OnFileSchema,
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1 },
    ),
    onFile: OnFileSchema,
  },
  { additionalProperties: false },
);
export type RequiredRecordView = Static<typeof RequiredRecordViewSchema>;

export const RequiredRecordsResponseSchema = Type.Object(
  {
    asOf: Time,
    organization: Type.Object({ name: Type.String(), timeZone: Type.String() }, { additionalProperties: false }),
    records: Type.Array(RequiredRecordViewSchema, {
      description:
        'Each record the adopted packs require, once by id, from the highest version adopted; ordered by pack, then as the pack declares them.',
    }),
  },
  {
    additionalProperties: false,
    description:
      'The records the packs the organization has adopted (in effect or still to come) say must be kept, with what is on file for each. It never says a requirement is met.',
  },
);
export type RequiredRecordsResponse = Static<typeof RequiredRecordsResponseSchema>;

/** The document type of a recordkeeping plan. */
export const RECORDKEEPING_PLAN_DOCUMENT_TYPE = 'recordkeeping_plan';

/** A blank in a recordkeeping plan's text, as the draft writes it: visible wherever the text is read. */
export const PLAN_BLANK_PATTERN = /\[To be filled in: ([^\]\n]{1,300})\]/g;

/** The blanks still in a text, in order, by what each asks for. */
export function planBlanks(text: string | undefined): string[] {
  return [...(text ?? '').matchAll(PLAN_BLANK_PATTERN)].map((match) => match[1]!.trim());
}

export const RecordkeepingPlanDraftResponseSchema = Type.Object(
  {
    asOf: Time,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: DocumentBodyV2Schema,
    blanks: Type.Array(Type.String(), {
      description:
        'What each blank in the text asks for, in order. Reviewing or issuing the plan is refused while one remains.',
    }),
    requiredRecords: Type.Integer({ minimum: 0, description: 'How many required records the draft lists.' }),
  },
  {
    additionalProperties: false,
    description:
      'A recordkeeping plan drafted from the required records read now. Nothing is recorded: open it with sms.record.open as a document owned by a person.',
  },
);
export type RecordkeepingPlanDraftResponse = Static<typeof RecordkeepingPlanDraftResponseSchema>;
