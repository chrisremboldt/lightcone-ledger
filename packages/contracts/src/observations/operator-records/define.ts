import { Type, type TSchema } from '@sinclair/typebox';
import { ObservationId, UtcTime, observationSubjectScopeValues, type ObservationSubjectKind } from '../envelope.js';
import type { ObservationRegistry, OperatorRecordTypeDefinition } from '../registry.js';
import { findOperatorRecordType } from '../registry.js';

/**
 * as_of: a standing record that holds as of occurredAt (the at field when the type names one).
 * event: something that happened at the at field's instant.
 * interval: a state over [start field, end field); an absent end means none was recorded.
 */
export const operatorRecordTimeMeaningValues = ['as_of', 'event', 'interval'] as const;
export type OperatorRecordTimeMeaning = (typeof operatorRecordTimeMeaningValues)[number];

/** Which body fields carry the record's time, so intake can fill occurredAt and interval without per-type code. */
export type OperatorRecordTime =
  | { readonly meaning: 'as_of'; readonly atField?: string }
  | { readonly meaning: 'event'; readonly atField: string }
  | { readonly meaning: 'interval'; readonly startField: string; readonly endField: string };

export const operatorRecordFieldKindValues = [
  'text',
  'long_text',
  'boolean',
  'date',
  'date_time',
  'number',
  'select',
  'reference',
] as const;
export type OperatorRecordFieldKind = (typeof operatorRecordFieldKindValues)[number];

/** Each unit is also the required suffix of the field name, as in the observation vocabulary. */
export const operatorRecordUnitValues = ['Hours', 'Meters', 'MetersPerSecond', 'Percent', 'Count'] as const;
export type OperatorRecordUnit = (typeof operatorRecordUnitValues)[number];

/** duty_period: a crew.duty-period observation, identified by its source event id (source) or Ledger id (ledger). */
export const operatorRecordReferenceKindValues = ['person', 'aircraft', 'site', 'component', 'duty_period'] as const;
export type OperatorRecordReferenceKind = (typeof operatorRecordReferenceKindValues)[number];

export interface OperatorRecordSelectOption {
  readonly value: string;
  readonly label: string;
}

interface FieldCommon {
  readonly name: string;
  readonly label: string;
  /** Counts toward completeness. Never true together with replayOnly. */
  readonly required: boolean;
  /** Supports replay and explanation only; never affects completeness. */
  readonly replayOnly: boolean;
  readonly help?: string;
  /**
   * Counts toward completeness unless the named field has a value: of two fields that each say the same thing in a
   * different way, one is needed. Never set together with required.
   */
  readonly requiredUnless?: string;
  /**
   * A time that says when a report or notice was made, which takes a date alone as the column that places the record
   * does (docs/design/date-only-records.md). Only on a date_time field.
   */
  readonly takesDate?: true;
}

export type OperatorRecordField =
  | (FieldCommon & { readonly kind: 'text' | 'long_text' | 'boolean' | 'date' | 'date_time' })
  | (FieldCommon & {
      readonly kind: 'number';
      readonly unit: OperatorRecordUnit;
      readonly minimum: number;
      readonly maximum: number;
      readonly integer: boolean;
    })
  | (FieldCommon & { readonly kind: 'select'; readonly options: readonly OperatorRecordSelectOption[] })
  | (FieldCommon & { readonly kind: 'reference'; readonly referenceKind: OperatorRecordReferenceKind });

/** A registered record type with the field metadata forms, import templates and completeness read. */
export interface OperatorRecordDefinition extends OperatorRecordTypeDefinition {
  readonly title: string;
  readonly secondarySubjectKinds: readonly ObservationSubjectKind[];
  readonly time: OperatorRecordTime;
  readonly fields: readonly OperatorRecordField[];
  /**
   * Fields that give the subject the name people know it by, in display order. The latest current record of such a
   * type about a subject names it wherever the subject is shown; the name is read at display time, never stored.
   */
  readonly nameFields?: readonly string[];
  /**
   * Set when each record is recorded as an observation of the registered observation type of the same name and
   * version, which rules already read, instead of inside operator.record. idField holds the operator's own id for the
   * record and becomes the observation's source event id; the time fields become its interval or occurredAt; every
   * other field is a value of the same name.
   */
  readonly observed?: ObservedRecord;
  /**
   * Set on a record type a pack declares (docs/design/declared-record-types.md): the pack and the declaration's
   * digest, which each record of the type names. Absent on a built-in type.
   */
  readonly declaredBy?: { readonly packId: string; readonly digest: string };
}

export interface ObservedRecord {
  readonly idField: string;
}

export type OperatorRecordBody = Readonly<Record<string, unknown>>;

// Field builders --------------------------------------------------------------------------------------------------

export interface FieldOptions {
  readonly required?: boolean;
  readonly replayOnly?: boolean;
  readonly help?: string;
  readonly requiredUnless?: string;
  readonly takesDate?: boolean;
}
const common = (name: string, label: string, options: FieldOptions = {}): FieldCommon => ({
  name,
  label,
  required: options.required ?? false,
  replayOnly: options.replayOnly ?? false,
  ...(options.help ? { help: options.help } : {}),
  ...(options.requiredUnless ? { requiredUnless: options.requiredUnless } : {}),
  ...(options.takesDate ? { takesDate: true as const } : {}),
});

export const recordField = {
  text: (name: string, label: string, options?: FieldOptions): OperatorRecordField => ({
    ...common(name, label, options),
    kind: 'text',
  }),
  longText: (name: string, label: string, options?: FieldOptions): OperatorRecordField => ({
    ...common(name, label, options),
    kind: 'long_text',
  }),
  boolean: (name: string, label: string, options?: FieldOptions): OperatorRecordField => ({
    ...common(name, label, options),
    kind: 'boolean',
  }),
  date: (name: string, label: string, options?: FieldOptions): OperatorRecordField => ({
    ...common(name, label, options),
    kind: 'date',
  }),
  dateTime: (name: string, label: string, options?: FieldOptions): OperatorRecordField => ({
    ...common(name, label, options),
    kind: 'date_time',
  }),
  number: (
    name: string,
    label: string,
    unit: OperatorRecordUnit,
    options: FieldOptions & { minimum?: number; maximum?: number } = {},
  ): OperatorRecordField => ({
    ...common(name, label, options),
    kind: 'number',
    unit,
    minimum: options.minimum ?? 0,
    maximum: options.maximum ?? defaultMaximum[unit],
    integer: unit === 'Count',
  }),
  select: (
    name: string,
    label: string,
    options: readonly (readonly [value: string, label: string])[],
    fieldOptions?: FieldOptions,
  ): OperatorRecordField => ({
    ...common(name, label, fieldOptions),
    kind: 'select',
    options: options.map(([value, optionLabel]) => ({ value, label: optionLabel })),
  }),
  reference: (
    name: string,
    label: string,
    referenceKind: OperatorRecordReferenceKind,
    options?: FieldOptions,
  ): OperatorRecordField => ({ ...common(name, label, options), kind: 'reference', referenceKind }),
};

const defaultMaximum: Record<OperatorRecordUnit, number> = {
  Hours: 1_000_000,
  Meters: 100_000,
  MetersPerSecond: 1_000,
  Percent: 100,
  Count: 10_000,
};

// Schema ------------------------------------------------------------------------------------------------------------

const nonBlank = '\\S';
const CalendarDate = Type.String({
  format: 'date',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}$',
  description: 'Calendar date as recorded (YYYY-MM-DD), with no time of day or time zone.',
});

function fieldSchema(definition: OperatorRecordField): TSchema {
  const described = { description: definition.help ?? definition.label };
  switch (definition.kind) {
    case 'text':
      return Type.String({ minLength: 1, maxLength: 1000, pattern: nonBlank, ...described });
    case 'long_text':
      return Type.String({ minLength: 1, maxLength: 10_000, pattern: nonBlank, ...described });
    case 'boolean':
      return Type.Boolean(described);
    case 'date':
      return Type.String({ ...CalendarDate, ...described });
    case 'date_time':
      return Type.String({ ...UtcTime, ...described });
    case 'number': {
      const bounds = { minimum: definition.minimum, maximum: definition.maximum, ...described };
      return definition.integer ? Type.Integer(bounds) : Type.Number(bounds);
    }
    case 'select':
      return Type.Union(
        definition.options.map((option) => Type.Literal(option.value)),
        described,
      );
    case 'reference':
      return Type.Object(
        {
          id: ObservationId,
          scope: Type.Union(
            observationSubjectScopeValues.map((scope) => Type.Literal(scope)),
            {
              description:
                'ledger: a Ledger identifier. source: the identifier in the operator’s file, resolved by intake through aliases.',
            },
          ),
        },
        { additionalProperties: false, ...described },
      );
  }
}

/**
 * Every field is optional in the schema: an incomplete record is still retained and reported as incomplete.
 * The schema rejects wrong shapes (unknown fields, wrong types, blank text, non-UTC times, values out of range).
 */
export function recordBodySchema(fields: readonly OperatorRecordField[], description: string): TSchema {
  return Type.Object(
    Object.fromEntries(fields.map((definition) => [definition.name, Type.Optional(fieldSchema(definition))])),
    { additionalProperties: false, minProperties: 1, description },
  );
}

// Definition ----------------------------------------------------------------------------------------------------------

export interface OperatorRecordSpec {
  readonly recordType: string;
  readonly recordVersion: number;
  readonly title: string;
  readonly subjectKinds: readonly ObservationSubjectKind[];
  readonly secondarySubjectKinds?: readonly ObservationSubjectKind[];
  readonly time: OperatorRecordTime;
  readonly description: string;
  readonly mayInfer: readonly string[];
  readonly mayNotInfer: readonly string[];
  readonly fields: readonly OperatorRecordField[];
  readonly nameFields?: readonly string[];
  readonly observed?: ObservedRecord;
}

const operatorStatement = 'A record is what the operator recorded, not independent verification.';

export function defineOperatorRecordType(spec: OperatorRecordSpec): OperatorRecordDefinition {
  checkFields(spec);
  return Object.freeze({
    ...spec,
    secondarySubjectKinds: spec.secondarySubjectKinds ?? [],
    mayNotInfer: [...spec.mayNotInfer, operatorStatement],
    schema: recordBodySchema(spec.fields, spec.description),
  });
}

function checkFields(spec: OperatorRecordSpec): void {
  const names = new Set<string>();
  for (const definition of spec.fields) {
    if (names.has(definition.name)) throw new Error(`${spec.recordType}: duplicate field ${definition.name}`);
    names.add(definition.name);
    if (definition.required && definition.replayOnly)
      throw new Error(`${spec.recordType}: ${definition.name} cannot be both required and replay only`);
  }
  for (const definition of spec.fields) {
    const other = definition.requiredUnless;
    if (other === undefined) continue;
    if (definition.required || definition.replayOnly)
      throw new Error(
        `${spec.recordType}: ${definition.name} is required unless ${other}, so it is neither required nor replay only`,
      );
    if (!names.has(other) || other === definition.name)
      throw new Error(`${spec.recordType}: ${definition.name} is required unless ${other}, which is not another field`);
  }
  for (const definition of spec.fields)
    if (definition.takesDate && definition.kind !== 'date_time')
      throw new Error(`${spec.recordType}: ${definition.name} takes a date alone, so it must be a date_time`);
  for (const name of spec.nameFields ?? [])
    if (!names.has(name)) throw new Error(`${spec.recordType}: name field ${name} is not a field`);
  if (!spec.fields.some((definition) => definition.required))
    throw new Error(`${spec.recordType}: at least one field must be required`);
  for (const name of timeFieldNames(spec.time)) {
    const timeField = spec.fields.find((definition) => definition.name === name);
    if (timeField?.kind !== 'date_time') throw new Error(`${spec.recordType}: time field ${name} must be a date_time`);
  }
  const anchor = spec.time.meaning === 'interval' ? spec.time.startField : spec.time.atField;
  if (anchor && !spec.fields.find((definition) => definition.name === anchor)?.required)
    throw new Error(`${spec.recordType}: time field ${anchor} must be required`);
  if (spec.observed) {
    const id = spec.fields.find((definition) => definition.name === spec.observed!.idField);
    if (id?.kind !== 'text' || !id.required)
      throw new Error(`${spec.recordType}: id field ${spec.observed.idField} must be a required text field`);
  }
}

/** The values of the observation an observed record is recorded as: every field but its id and time fields. */
export function observedRecordValues(
  definition: OperatorRecordDefinition,
  body: OperatorRecordBody,
): Record<string, unknown> {
  const skipped = new Set([definition.observed?.idField, ...timeFieldNames(definition.time)]);
  return Object.fromEntries(Object.entries(body).filter(([name]) => !skipped.has(name)));
}

/** An observed record's body read back from its observation: its id, its time fields and its values. */
export function observedRecordBody(
  definition: OperatorRecordDefinition,
  observation: {
    readonly sourceEventId?: unknown;
    readonly occurredAt?: unknown;
    readonly interval?: { readonly start?: unknown; readonly end?: unknown };
    readonly values?: unknown;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (definition.observed && typeof observation.sourceEventId === 'string')
    body[definition.observed.idField] = observation.sourceEventId;
  const time = definition.time;
  if (time.meaning === 'interval') {
    if (observation.interval?.start !== undefined) body[time.startField] = observation.interval.start;
    if (observation.interval?.end !== undefined) body[time.endField] = observation.interval.end;
  } else if (time.atField && observation.occurredAt !== undefined) body[time.atField] = observation.occurredAt;
  const values = observation.values && typeof observation.values === 'object' ? observation.values : {};
  for (const field of definition.fields)
    if (Object.hasOwn(values, field.name)) body[field.name] = (values as Record<string, unknown>)[field.name];
  return body;
}

export function timeFieldNames(time: OperatorRecordTime): string[] {
  if (time.meaning === 'interval') return [time.startField, time.endField];
  return time.atField ? [time.atField] : [];
}

// Completeness ------------------------------------------------------------------------------------------------------

/** Absent, null and blank text are not filled; false is an answer and counts as filled. */
export function recordFieldFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

/**
 * Names of required fields with no value, in field order, and of fields required unless another field has a value
 * when neither has one. An empty list means the record is complete.
 */
export function missingRequiredFields(definition: OperatorRecordDefinition, body: OperatorRecordBody): string[] {
  return definition.fields
    .filter(
      (candidate) =>
        (candidate.required ||
          (candidate.requiredUnless !== undefined && !recordFieldFilled(body[candidate.requiredUnless]))) &&
        !recordFieldFilled(body[candidate.name]),
    )
    .map((candidate) => candidate.name);
}

/** A missing field as a sentence names it: its label, or for a field required unless another, both labels. */
export function missingFieldLabel(definition: OperatorRecordDefinition, name: string): string {
  const field = definition.fields.find((candidate) => candidate.name === name);
  if (!field) return name;
  const other = field.requiredUnless && definition.fields.find((candidate) => candidate.name === field.requiredUnless);
  return other ? `${field.label} or ${other.label}` : field.label;
}

/**
 * Names of the given fields with no value. For a rule that reads a different set than the type's required fields.
 * Replay-only fields cannot be asked for: they never affect completeness.
 */
export function missingFields(
  definition: OperatorRecordDefinition,
  body: OperatorRecordBody,
  fieldNames: readonly string[],
): string[] {
  for (const name of fieldNames) {
    const candidate = definition.fields.find((item) => item.name === name);
    if (!candidate) throw new Error(`${definition.recordType} has no field ${name}`);
    if (candidate.replayOnly) throw new Error(`${definition.recordType}.${name} is replay only`);
  }
  return fieldNames.filter((name) => !recordFieldFilled(body[name]));
}

/** Replay-only fields with no value: thin replay, never an incomplete record. */
export function missingReplayFields(definition: OperatorRecordDefinition, body: OperatorRecordBody): string[] {
  return definition.fields
    .filter((candidate) => candidate.replayOnly && !recordFieldFilled(body[candidate.name]))
    .map((candidate) => candidate.name);
}

export function isOperatorRecordDefinition(
  definition: OperatorRecordTypeDefinition | undefined,
): definition is OperatorRecordDefinition {
  return Boolean(definition && 'fields' in definition && 'time' in definition);
}

/** Finds a registered record type that carries field metadata. */
export function findOperatorRecordDefinition(
  registry: ObservationRegistry,
  recordType: string,
  recordVersion: number,
): OperatorRecordDefinition | undefined {
  const definition = findOperatorRecordType(registry, recordType, recordVersion);
  return isOperatorRecordDefinition(definition) ? definition : undefined;
}
