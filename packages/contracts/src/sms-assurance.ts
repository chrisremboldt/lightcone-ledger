import { Type, type Static, type TLiteral, type TUnion } from '@sinclair/typebox';

// Safety assurance records (docs/design/assurance-records.md): one record kind whose type selects the fields it asks
// for. The validation here is the one the web form and the domain both use.

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Day = Type.String({ format: 'date', description: 'A calendar day, YYYY-MM-DD.' });
const Text = (maxLength: number, description?: string) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S', ...(description ? { description } : {}) });
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value))) as TUnion<TLiteral<T[number]>[]>;
const strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T, description?: string) =>
  Type.Object(properties, { additionalProperties: false, ...(description ? { description } : {}) });

export const assuranceTypeValues = [
  'audit',
  'program_evaluation',
  'occurrence_investigation',
  'noncompliance_investigation',
  'management_review',
  'change_assessment',
  'hazard_notice_sent',
  'hazard_notice_received',
] as const;
export type AssuranceType = (typeof assuranceTypeValues)[number];

/** The fields only some types ask for. */
export const assuranceTypeFieldValues = ['occurredOn', 'fromReport', 'system', 'counterpart'] as const;
export type AssuranceTypeField = (typeof assuranceTypeFieldValues)[number];

export interface AssuranceTypeDefinition {
  /** What a person calls a record of this type. */
  title: string;
  /** The § 5.97 class the record carries. */
  recordClass: 'safety_assurance_output' | 'srm_output' | 'safety_communication';
  /** The type's own fields, each required or optional. */
  fields: Partial<Record<AssuranceTypeField, 'required' | 'optional'>>;
}

export const assuranceTypes: Record<AssuranceType, AssuranceTypeDefinition> = {
  audit: {
    title: 'Audit of operational processes and systems',
    recordClass: 'safety_assurance_output',
    fields: {},
  },
  program_evaluation: {
    title: 'Evaluation of the safety program',
    recordClass: 'safety_assurance_output',
    fields: {},
  },
  occurrence_investigation: {
    title: 'Investigation of an incident or accident',
    recordClass: 'safety_assurance_output',
    fields: { occurredOn: 'required', fromReport: 'optional' },
  },
  noncompliance_investigation: {
    title: 'Investigation of a report of possible non-compliance',
    recordClass: 'safety_assurance_output',
    fields: { fromReport: 'optional' },
  },
  management_review: {
    title: 'Review of safety performance by the accountable executive',
    recordClass: 'safety_assurance_output',
    fields: {},
  },
  change_assessment: {
    title: 'Assessment of a new or changed system',
    recordClass: 'srm_output',
    fields: { system: 'required' },
  },
  hazard_notice_sent: {
    title: 'Hazard notice sent to another organization',
    recordClass: 'safety_communication',
    fields: { counterpart: 'required' },
  },
  hazard_notice_received: {
    title: 'Hazard notice received from another organization',
    recordClass: 'safety_communication',
    fields: { counterpart: 'required' },
  },
};

/** A finding or action id a person reads and types, such as F1 or A2. Unique within the record. */
export const AssuranceItemIdSchema = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$' });

export const AssuranceFindingSchema = strict({ id: AssuranceItemIdSchema, text: Text(4000) });
export type AssuranceFinding = Static<typeof AssuranceFindingSchema>;

export const AssuranceActionSchema = strict(
  {
    id: AssuranceItemIdSchema,
    what: Text(2000, 'What is to be done.'),
    ownerId: Id,
    dueOn: Day,
    findingId: Type.Optional(AssuranceItemIdSchema),
  },
  'An action the record sets: what is to be done, by whom, by when, and optionally the finding it answers.',
);
export type AssuranceAction = Static<typeof AssuranceActionSchema>;

export const AssuranceBodySchema = strict(
  {
    assuranceType: literals(assuranceTypeValues),
    performedOn: Day,
    completedOn: Type.Optional(Day),
    scope: Text(4000, 'What the activity covered.'),
    examined: Text(8000, 'What it looked at: processes, records, flights, places or people.'),
    findings: Type.Array(AssuranceFindingSchema, { maxItems: 50 }),
    actions: Type.Array(AssuranceActionSchema, { maxItems: 50 }),
    occurredOn: Type.Optional(Day),
    fromReport: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: 'The safety report an investigation started from. Linked, never copied.',
      }),
    ),
    system: Type.Optional(Text(2000, 'The system or change described and analysed.')),
    counterpart: Type.Optional(Text(200, 'The other organization a hazard notice went to or came from.')),
  },
  'sms.assurance.1: a safety assurance record. Its type is fixed when it is opened and selects the fields it asks for.',
);
export type AssuranceBody = Static<typeof AssuranceBodySchema>;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) =>
  dayPattern.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

/**
 * What is wrong with an assurance body, in plain words, or nothing. `today` is the organization's current day
 * (YYYY-MM-DD); a date after it is refused. Shape is checked by the schema; this checks what the schema cannot.
 */
export function assuranceBodyProblems(body: AssuranceBody, today: string): string[] {
  const problems: string[] = [];
  const definition = assuranceTypes[body.assuranceType];
  if (!definition) return ['Choose what kind of safety assurance record this is.'];
  for (const field of assuranceTypeFieldValues) {
    const asked = definition.fields[field];
    const given = body[field] !== undefined;
    if (!asked && given) problems.push(`${withArticle(definition.title)} does not record ${fieldWords[field]}.`);
    if (asked === 'required' && !given) problems.push(`Give ${fieldWords[field]}.`);
  }
  const days: [string, string | undefined][] = [
    ['the date it was performed', body.performedOn],
    ['the date it was completed', body.completedOn],
    ['when the occurrence happened', body.occurredOn],
  ];
  for (const [words, value] of days) {
    if (value === undefined) continue;
    if (!validDay(value)) problems.push(`Give ${words} as a date.`);
    else if (value > today) problems.push(`${capitalize(words)} cannot be in the future.`);
  }
  if (body.completedOn && body.completedOn < body.performedOn)
    problems.push('The date it was completed cannot be before the date it was performed.');
  for (const id of duplicates(body.findings.map((finding) => finding.id)))
    problems.push(`Two findings are numbered ${id}.`);
  for (const id of duplicates(body.actions.map((action) => action.id)))
    problems.push(`Two actions are numbered ${id}.`);
  const findings = new Set(body.findings.map((finding) => finding.id));
  for (const action of body.actions) {
    if (!validDay(action.dueOn)) problems.push(`Give action ${action.id} a due date.`);
    if (action.findingId && !findings.has(action.findingId))
      problems.push(`Action ${action.id} answers finding ${action.findingId}, which this record does not hold.`);
  }
  return problems;
}

const fieldWords: Record<AssuranceTypeField, string> = {
  occurredOn: 'when the occurrence happened',
  fromReport: 'a safety report it started from',
  system: 'the system or change it describes',
  counterpart: 'the other organization',
};

const capitalize = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
const withArticle = (title: string) => `${/^[aeiou]/i.test(title) ? 'An' : 'A'} ${title.toLowerCase()}`;

/** The day after `day`, at midnight UTC: an action due on `day` is overdue from then. */
export function assuranceActionOverdueAt(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** A finding or action of an assurance record, as a hazard's origin names it. */
export const AssuranceItemRefSchema = strict({ kind: literals(['finding', 'action']), id: AssuranceItemIdSchema });
export type AssuranceItemRef = Static<typeof AssuranceItemRefSchema>;
