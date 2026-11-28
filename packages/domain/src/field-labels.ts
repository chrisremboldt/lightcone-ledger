import {
  findObservationType,
  findOperatorRecordDefinition,
  type ObservationTypeDefinition,
  type OperatorRecordDefinition,
  type RuleRead,
} from '@ledger/contracts';
import { observationField, type CheckObservation } from './check-kinds.js';
import { observationRegistry } from './observation-registry.js';

// What a person calls a record, an observation and a field, for the summaries they read. A path or a type id stays in
// the machine-readable details of an evaluation; nothing here names a particular record or observation type.

const RECORD_FIELD = 'values.record.';

/** A name a person can read: the last part of a path or id, with its words apart and in lower case. */
export function readableName(name: string): string {
  const last =
    name
      .split(/[.@]/)
      .filter((part) => part && !/^\d+$/.test(part))
      .at(-1) ?? name;
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase();
}

/** A title as it reads inside a sentence: its first letter lowered unless the first word is an initialism. */
function inSentence(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title[0]!.toLowerCase() + title.slice(1) : title;
}

function recordDefinition(recordType: unknown, recordVersion: unknown): OperatorRecordDefinition | undefined {
  if (typeof recordType !== 'string' || typeof recordVersion !== 'number') return undefined;
  return findOperatorRecordDefinition(observationRegistry(), recordType, recordVersion);
}

/** What a person calls a record type, such as "flight plan"; a readable form of its id when it is not registered. */
export function recordTitle(recordType: string, recordVersion: number): string {
  const definition = recordDefinition(recordType, recordVersion);
  return definition ? inSentence(definition.title) : readableName(recordType);
}

/** What a person calls an observation type, such as "wind reading"; a readable form of its id without a title. */
export function observationTitle(type: string, version: number): string {
  const definition = findObservationType(observationRegistry(), type, version);
  return definition?.title ? inSentence(definition.title) : readableName(type);
}

interface SchemaNode {
  title?: unknown;
  properties?: Record<string, SchemaNode>;
}

/** The title the observation type's schema gives the field at the path, if any. */
function schemaTitle(definition: ObservationTypeDefinition, path: string): string | undefined {
  let node: SchemaNode | undefined = definition.schema as SchemaNode;
  for (const part of path.split('.')) node = node?.properties?.[part];
  return typeof node?.title === 'string' ? node.title : undefined;
}

/** The label of one record field, such as "Operating authority"; a readable form of its name when it has none. */
export function recordFieldLabel(definition: OperatorRecordDefinition | undefined, name: string): string {
  return definition?.fields.find((field) => field.name === name)?.label ?? readableName(name);
}

/** The labels of record fields named in the order given. */
export function recordFieldLabels(recordType: string, recordVersion: number, names: readonly string[]): string[] {
  const definition = recordDefinition(recordType, recordVersion);
  return names.map((name) => recordFieldLabel(definition, name));
}

function labelIn(observation: CheckObservation, path: string): string | undefined {
  const record = recordDefinition(
    observationField(observation, 'values.recordType'),
    observationField(observation, 'values.recordVersion'),
  );
  if (record && path.startsWith(RECORD_FIELD)) {
    const name = path.slice(RECORD_FIELD.length).split('.')[0]!;
    return `the ${inSentence(record.title)}’s ${recordFieldLabel(record, name)}`;
  }
  const definition = findObservationType(observationRegistry(), observation.type, observation.version);
  if (!definition) return undefined;
  const title = definition.title ? inSentence(definition.title) : readableName(definition.type);
  return `the ${title}’s ${schemaTitle(definition, path) ?? readableName(path)}`;
}

/**
 * A field as a person reads it, from the record or observation type of the observations that hold it: "the flight
 * plan’s Operating authority". Without such an observation, a readable form of the field's name: "the operating
 * authority reference".
 */
export function fieldLabel(
  path: string,
  observations: readonly CheckObservation[] = [],
  record?: { recordType?: string; recordVersion?: number },
): string {
  for (const observation of observations) {
    const label = labelIn(observation, path);
    if (label) return label;
  }
  const definition = recordDefinition(record?.recordType, record?.recordVersion);
  if (definition && path.startsWith(RECORD_FIELD))
    return `the ${inSentence(definition.title)}’s ${recordFieldLabel(definition, path.slice(RECORD_FIELD.length).split('.')[0]!)}`;
  return `the ${readableName(path)}`;
}

/**
 * A field by its own label alone, such as "Operating authority", for a sentence that has already named the record
 * that holds it. Without a record type that has the field, a readable form of its name.
 */
export function ownFieldLabel(
  path: string,
  observations: readonly CheckObservation[] = [],
  record?: { recordType?: string; recordVersion?: number },
): string {
  if (path.startsWith(RECORD_FIELD)) {
    const name = path.slice(RECORD_FIELD.length).split('.')[0]!;
    const definitions = [
      ...observations.map((observation) =>
        recordDefinition(
          observationField(observation, 'values.recordType'),
          observationField(observation, 'values.recordVersion'),
        ),
      ),
      recordDefinition(record?.recordType, record?.recordVersion),
    ];
    for (const definition of definitions)
      if (definition?.fields.some((field) => field.name === name)) return recordFieldLabel(definition, name);
  }
  for (const observation of observations) {
    const definition = findObservationType(observationRegistry(), observation.type, observation.version);
    const title = definition && schemaTitle(definition, path);
    if (title) return title;
  }
  return sentenceStart(readableName(path));
}

/** What a person calls the record or observation the fields are read from, such as "flight plan"; none without one. */
export function holderTitle(
  observations: readonly CheckObservation[] = [],
  record?: { recordType?: string; recordVersion?: number },
): string | undefined {
  for (const observation of observations) {
    const recordType = observationField(observation, 'values.recordType');
    const recordVersion = observationField(observation, 'values.recordVersion');
    if (typeof recordType === 'string' && typeof recordVersion === 'number')
      return recordTitle(recordType, recordVersion);
    return observationTitle(observation.type, observation.version);
  }
  return record?.recordType && record.recordVersion !== undefined
    ? recordTitle(record.recordType, record.recordVersion)
    : undefined;
}

/**
 * A recorded value as a person reads it: the option's label when the field is a record field with options, else the
 * value as written.
 */
export function valueLabel(
  path: string,
  value: string | number | boolean,
  observations: readonly CheckObservation[] = [],
  record?: { recordType?: string; recordVersion?: number },
): string {
  const definitions = [
    ...observations.map((observation) =>
      recordDefinition(
        observationField(observation, 'values.recordType'),
        observationField(observation, 'values.recordVersion'),
      ),
    ),
    recordDefinition(record?.recordType, record?.recordVersion),
  ];
  if (path.startsWith(RECORD_FIELD)) {
    const name = path.slice(RECORD_FIELD.length);
    for (const definition of definitions) {
      const field = definition?.fields.find((candidate) => candidate.name === name);
      if (field?.kind === 'select')
        return field.options.find((option) => option.value === value)?.label ?? String(value);
    }
  }
  return String(value);
}

/** The text with its first letter in upper case, to start a sentence. */
export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The single value a read's conditions require at the field, if any. */
function requiredValue(read: Pick<RuleRead, 'where'>, field: string): unknown {
  const condition = (read.where ?? []).find((item) => item.field === field);
  return condition && 'oneOf' in condition && condition.oneOf.length === 1 ? condition.oneOf[0] : undefined;
}

/**
 * What a person calls the records a read takes: its own words for them (`onFile`), the record type its conditions
 * select, or its observation type.
 */
export function readTitle(read: Pick<RuleRead, 'type' | 'versions' | 'where' | 'onFile'>): string {
  if (read.onFile) return read.onFile;
  const recordType = requiredValue(read, 'values.recordType');
  const recordVersion = requiredValue(read, 'values.recordVersion');
  if (typeof recordType === 'string')
    return typeof recordVersion === 'number' ? recordTitle(recordType, recordVersion) : readableName(recordType);
  return observationTitle(read.type, read.versions[0] ?? 1);
}
