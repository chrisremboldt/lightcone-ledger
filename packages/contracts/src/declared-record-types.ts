import { Type, type Static } from '@sinclair/typebox';
import { ObservationTypeIdPattern, observationSubjectKindValues } from './observations/envelope.js';
import {
  defineOperatorRecordType,
  operatorRecordUnitValues,
  timeFieldNames,
  type OperatorRecordDefinition,
  type OperatorRecordField,
} from './observations/operator-records/define.js';

/**
 * Record types a pack file declares, as data (docs/design/declared-record-types.md). A declaration becomes the same
 * OperatorRecordDefinition a built-in type is, through defineOperatorRecordType, so every reader of record types
 * reads it the same way.
 */

const Closed = { additionalProperties: false } as const;
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Words = (maxLength: number, description?: string) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S', ...(description ? { description } : {}) });
const literals = <const Values extends readonly string[]>(values: Values) =>
  Type.Unsafe<Values[number]>(Type.Union(values.map((value) => Type.Literal(value))));

/** A field name, as a built-in type writes one: lowercase first, then letters and digits. */
export const DeclaredFieldNamePattern = '^[a-z][a-zA-Z0-9]{0,59}$';
/** A pack that declares record types has a one-word id: the domain of every type it declares. */
export const DeclaringPackIdPattern = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';

/** The subjects a reference field of a declared type may name. */
export const declaredReferenceKindValues = ['person', 'aircraft', 'site', 'component'] as const;

const fieldCommon = {
  name: Type.String({ pattern: DeclaredFieldNamePattern }),
  label: Words(100, 'What the operator calls the field.'),
  help: Type.Optional(Words(300, 'One line in the operator’s words: what to write.')),
  required: Type.Optional(
    Type.Boolean({ description: 'Counts toward completeness. A record without it is still kept, as incomplete.' }),
  ),
};

export const DeclaredRecordFieldSchema = Type.Union([
  Type.Object(
    { ...fieldCommon, kind: literals(['text', 'long_text', 'boolean', 'date', 'date_time'] as const) },
    Closed,
  ),
  Type.Object(
    {
      ...fieldCommon,
      kind: Type.Literal('number'),
      unit: literals(operatorRecordUnitValues),
      minimum: Type.Optional(Type.Number()),
      maximum: Type.Optional(Type.Number()),
    },
    { ...Closed, description: 'A number in a unit Ledger converts. A whole number is unit Count.' },
  ),
  Type.Object(
    {
      ...fieldCommon,
      kind: Type.Literal('select'),
      options: Type.Array(
        Type.Object(
          { value: Type.String({ pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$', maxLength: 60 }), label: Words(100) },
          Closed,
        ),
        { minItems: 1, maxItems: 50 },
      ),
    },
    Closed,
  ),
  Type.Object(
    { ...fieldCommon, kind: Type.Literal('reference'), referenceKind: literals(declaredReferenceKindValues) },
    { ...Closed, description: 'The operator’s own id for a subject on file.' },
  ),
]);
export type DeclaredRecordField = Static<typeof DeclaredRecordFieldSchema>;

const TimeField = Type.String({ pattern: DeclaredFieldNamePattern });
export const DeclaredRecordTimeSchema = Type.Union(
  [
    Type.Object({ meaning: Type.Literal('event'), atField: TimeField }, Closed),
    Type.Object({ meaning: Type.Literal('as_of'), atField: Type.Optional(TimeField) }, Closed),
    Type.Object({ meaning: Type.Literal('interval'), startField: TimeField, endField: TimeField }, Closed),
  ],
  {
    description:
      'How a record is placed in time: event at a date_time field, as_of (a standing record, optionally at a date_time field), or interval between two.',
  },
);

export const DeclaredRecordTypeSchema = Type.Object(
  {
    id: Type.String({
      pattern: ObservationTypeIdPattern,
      maxLength: 100,
      description: 'The pack id, a dot and the type’s own name, such as example-ridge-procedures.airframe-check.',
    }),
    version: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    title: Words(100),
    description: Words(500, 'One line: what a record of this type is.'),
    subjectKinds: Type.Array(literals(observationSubjectKindValues), { minItems: 1, maxItems: 6, uniqueItems: true }),
    time: DeclaredRecordTimeSchema,
    fields: Type.Array(DeclaredRecordFieldSchema, { minItems: 1, maxItems: 100 }),
  },
  { ...Closed, description: 'A record type the pack declares (docs/design/declared-record-types.md).' },
);
export type DeclaredRecordType = Static<typeof DeclaredRecordTypeSchema>;

export const RulePackRecordTypeSchema = Type.Object(
  {
    ...DeclaredRecordTypeSchema.properties,
    digest: Type.Unsafe<string>({
      ...Digest,
      description: 'ledger.v6.sha256.jcs.1 over the declaration without its digest. A record names it.',
    }),
  },
  { ...Closed, description: 'A record type the pack version declares, with its digest.' },
);
export type RulePackRecordType = Static<typeof RulePackRecordTypeSchema>;

/** What a person may infer from, and must not infer from, any declared record. */
const declaredMayInfer = ['The operator recorded this, under a record type its own pack declares.'];
const declaredMayNotInfer = ['A declared record type says nothing about what a regulation asks for.'];

function definedField(field: DeclaredRecordField): OperatorRecordField {
  const common = {
    name: field.name,
    label: field.label,
    required: field.required ?? false,
    replayOnly: false,
    ...(field.help ? { help: field.help } : {}),
  };
  switch (field.kind) {
    case 'number':
      return {
        ...common,
        kind: 'number',
        unit: field.unit,
        minimum: field.minimum ?? 0,
        maximum: field.maximum ?? declaredMaximum[field.unit],
        integer: field.unit === 'Count',
      };
    case 'select':
      return { ...common, kind: 'select', options: field.options.map((option) => ({ ...option })) };
    case 'reference':
      return { ...common, kind: 'reference', referenceKind: field.referenceKind };
    default:
      return { ...common, kind: field.kind };
  }
}

const declaredMaximum: Record<(typeof operatorRecordUnitValues)[number], number> = {
  Hours: 1_000_000,
  Meters: 100_000,
  MetersPerSecond: 1_000,
  Percent: 100,
  Count: 10_000,
};

/** Who declared a record type: the pack and the declaration's digest. Absent on a built-in type. */
export type RecordTypeDeclaration = NonNullable<OperatorRecordDefinition['declaredBy']>;

/** A pack's declaration as the definition every reader of record types reads. Throws when the definition is refused. */
export function declaredRecordDefinition(
  packId: string,
  declared: RulePackRecordType,
): OperatorRecordDefinition & { readonly declaredBy: RecordTypeDeclaration } {
  const definition = defineOperatorRecordType({
    recordType: declared.id,
    recordVersion: declared.version,
    title: declared.title,
    description: declared.description,
    subjectKinds: [...declared.subjectKinds],
    time: { ...declared.time } as OperatorRecordDefinition['time'],
    fields: declared.fields.map(definedField),
    mayInfer: declaredMayInfer,
    mayNotInfer: declaredMayNotInfer,
  });
  return Object.freeze({ ...definition, declaredBy: Object.freeze({ packId, digest: declared.digest }) });
}

/** The declaration a definition came from, or undefined for a built-in type. */
export function recordTypeDeclaration(definition: object | undefined): RecordTypeDeclaration | undefined {
  return definition && 'declaredBy' in definition ? (definition.declaredBy as RecordTypeDeclaration) : undefined;
}

const fieldNameEndings: { kinds: readonly string[]; ending: string; words: string }[] = [
  { kinds: ['date_time'], ending: 'At', words: 'a date and time field’s name ends in At, such as checkedAt' },
  { kinds: ['date'], ending: 'On', words: 'a date field’s name ends in On, such as dueOn' },
  { kinds: ['reference'], ending: 'Id', words: 'a reference field’s name ends in Id, such as inspectorId' },
];

/**
 * The problems with one declaration, in sentences a pack author can act on, or an empty list. `reserved` holds the
 * domains of the types this Ledger has without a pack: a declaring pack's id may not be one of them.
 */
export function declaredRecordTypeProblems(
  packId: string,
  declared: DeclaredRecordType,
  reserved: ReadonlySet<string>,
): string[] {
  const label = `Record type ${declared.id}`;
  const problems: string[] = [];
  if (!new RegExp(DeclaringPackIdPattern).test(packId))
    problems.push(
      `${label}: a pack that declares record types has an id of one word (lowercase letters, digits and hyphens, starting with a letter, no dots), such as example-ridge-procedures; ${packId} is not one. Every record type id is a domain and a noun, and the pack id is the domain.`,
    );
  else if (reserved.has(packId))
    problems.push(
      `${label}: ${packId} is a domain of record types built into Ledger, so a pack with that id could declare a type beside them. Give the pack an id of your own, such as example-ridge-procedures.`,
    );
  if (!declared.id.startsWith(`${packId}.`))
    problems.push(`${label} does not start with its pack id ${packId} and a dot, such as ${packId}.airframe-check.`);
  for (const field of declared.fields) {
    const where = `${label}, field ${field.name}`;
    for (const rule of fieldNameEndings)
      if (rule.kinds.includes(field.kind) && !field.name.endsWith(rule.ending))
        problems.push(`${where}: ${rule.words}.`);
    if (field.kind !== 'date_time' && field.name.endsWith('At'))
      problems.push(`${where}: only a date and time field’s name ends in At; rename it.`);
    if (field.kind === 'number' && !field.name.endsWith(field.unit))
      problems.push(`${where}: a number’s name ends in its unit, such as ${field.name}${field.unit}.`);
    if (field.kind === 'number' && field.minimum !== undefined && field.maximum !== undefined)
      if (field.minimum > field.maximum) problems.push(`${where}: its minimum is above its maximum.`);
    if (field.kind === 'select' && new Set(field.options.map((option) => option.value)).size !== field.options.length)
      problems.push(`${where}: an option value is listed twice.`);
  }
  const names = declared.fields.map((field) => field.name);
  for (const name of timeFieldNames(declared.time as OperatorRecordDefinition['time']))
    if (!names.includes(name))
      problems.push(
        `${label} is placed in time by ${name}, which is not one of its fields. Add it as a date_time field.`,
      );
  if (!problems.length)
    try {
      declaredRecordDefinition(packId, { ...declared, digest: '0'.repeat(64) });
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message.replace(`${declared.id}: `, '')}.`);
    }
  return problems;
}

const fieldShape = (field: DeclaredRecordField) =>
  field.kind === 'number'
    ? `a number in ${field.unit}`
    : field.kind === 'reference'
      ? `a reference to a ${field.referenceKind}`
      : field.kind.replace('_', ' ');

/**
 * Why a later version of a declared type cannot follow an earlier one under the same id, or an empty list. Records on
 * file are never rewritten, so a later version keeps every field with what it holds; it may add fields and options.
 */
export function declaredRecordChangeProblems(earlier: DeclaredRecordType, later: DeclaredRecordType): string[] {
  const label = `Record type ${later.id} version ${later.version}`;
  const problems: string[] = [];
  const advice = 'Records on file are never rewritten: keep the field as it was, or declare a new field or a new type.';
  for (const field of earlier.fields) {
    const kept = later.fields.find((candidate) => candidate.name === field.name);
    if (!kept) {
      problems.push(`${label} leaves out ${field.name}, which version ${earlier.version} has. ${advice}`);
      continue;
    }
    if (fieldShape(kept) !== fieldShape(field))
      problems.push(
        `${label} makes ${field.name} ${fieldShape(kept)}; in version ${earlier.version} it is ${fieldShape(field)}. ${advice}`,
      );
    if (field.kind === 'select' && kept.kind === 'select') {
      const missing = field.options.filter((option) => !kept.options.some((item) => item.value === option.value));
      if (missing.length)
        problems.push(
          `${label} leaves out option ${missing.map((option) => option.value).join(', ')} of ${field.name}, which version ${earlier.version} has. ${advice}`,
        );
    }
  }
  const lostKinds = earlier.subjectKinds.filter((kind) => !(later.subjectKinds as string[]).includes(kind));
  if (lostKinds.length)
    problems.push(`${label} leaves out subject kind ${lostKinds.join(', ')}, which version ${earlier.version} has.`);
  if (JSON.stringify(earlier.time) !== JSON.stringify(later.time))
    problems.push(`${label} places a record in time differently from version ${earlier.version}. ${advice}`);
  return problems;
}
