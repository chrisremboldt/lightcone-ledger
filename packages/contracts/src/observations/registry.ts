import type { TSchema } from '@sinclair/typebox';
import { ObservationTypeIdPattern, type ObservationSubjectKind } from './envelope.js';

/**
 * instant: a state that held at occurredAt. event: something the source says happened at occurredAt.
 * interval: a state over [interval.start, interval.end); occurredAt is when the source made the statement.
 */
export type ObservationTiming = 'instant' | 'event' | 'interval';

export interface ObservationTypeDefinition {
  readonly type: string;
  readonly version: number;
  readonly timing: ObservationTiming;
  readonly intervalRequired: boolean;
  readonly subjectKinds: readonly ObservationSubjectKind[];
  readonly secondarySubjectKinds: readonly ObservationSubjectKind[];
  readonly description: string;
  /**
   * What a person calls this type, such as "Wind reading". Wording, like description: not part of what a version
   * promises structurally. A numeric field a person may pick by name carries a title in the schema.
   */
  readonly title?: string;
  readonly mayInfer: readonly string[];
  readonly mayNotInfer: readonly string[];
  readonly schema: TSchema;
  /**
   * The reference fields ({ id, scope } objects naming another subject) this type's observations may carry. Intake
   * indexes them so rules can read about the subjects they name. Absent: the type carries none.
   */
  readonly referenceFields?: (registry: ObservationRegistry) => readonly ObservationReferenceField[];
  /**
   * True for a record people keep: one a person enters, corrects and replaces, such as an operator's record, rather
   * than something a source reports about the world, such as a position or a wind reading. A finding that a later
   * evaluation clears closes by itself only when every input that evaluation read and the opening one did not is of
   * such a type; otherwise what the finding reported still happened, and a person closes it.
   */
  readonly keptRecord?: true;
}

/** A dot path into an observation that may hold a reference, and the kind of subject it names. */
export interface ObservationReferenceField {
  readonly field: string;
  readonly referenceKind: string;
  /** The field is a reference only in observations whose field at each path equals the value. */
  readonly when?: readonly { readonly field: string; readonly value: string | number }[];
}

/** A concrete record type carried inside an operator.record observation. Its schema validates values.record. */
export interface OperatorRecordTypeDefinition {
  readonly recordType: string;
  readonly recordVersion: number;
  readonly subjectKinds: readonly ObservationSubjectKind[];
  readonly description: string;
  readonly mayInfer: readonly string[];
  readonly mayNotInfer: readonly string[];
  readonly schema: TSchema;
}

export interface ObservationRegistry {
  readonly types: Readonly<Record<string, ObservationTypeDefinition>>;
  readonly recordTypes: Readonly<Record<string, OperatorRecordTypeDefinition>>;
}

export const emptyObservationRegistry: ObservationRegistry = Object.freeze({
  types: Object.freeze({}),
  recordTypes: Object.freeze({}),
});

const typeIdPattern = new RegExp(ObservationTypeIdPattern);

export function observationTypeKey(type: string, version: number): string {
  return `${type}@${version}`;
}

function checkIdentity(type: string, version: number, what: string): string {
  if (!typeIdPattern.test(type) || type.length > 100)
    throw new Error(`${what} id must be a lowercase dotted domain.noun: ${type}`);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${what} version must be a positive integer`);
  return observationTypeKey(type, version);
}

/** Returns a new registry; a type and version, once registered, can never be replaced. */
export function registerObservationType(
  registry: ObservationRegistry,
  definition: ObservationTypeDefinition,
): ObservationRegistry {
  const key = checkIdentity(definition.type, definition.version, 'Observation type');
  if (Object.hasOwn(registry.types, key)) throw new Error(`Observation type ${key} is already registered`);
  return Object.freeze({
    types: Object.freeze({ ...registry.types, [key]: Object.freeze({ ...definition }) }),
    recordTypes: registry.recordTypes,
  });
}

export function registerOperatorRecordType(
  registry: ObservationRegistry,
  definition: OperatorRecordTypeDefinition,
): ObservationRegistry {
  const key = checkIdentity(definition.recordType, definition.recordVersion, 'Operator record type');
  if (Object.hasOwn(registry.recordTypes, key)) throw new Error(`Operator record type ${key} is already registered`);
  return Object.freeze({
    types: registry.types,
    recordTypes: Object.freeze({ ...registry.recordTypes, [key]: Object.freeze({ ...definition }) }),
  });
}

export function findObservationType(
  registry: ObservationRegistry,
  type: string,
  version: number,
): ObservationTypeDefinition | undefined {
  const key = observationTypeKey(type, version);
  return Object.hasOwn(registry.types, key) ? registry.types[key] : undefined;
}

export function findOperatorRecordType(
  registry: ObservationRegistry,
  recordType: string,
  recordVersion: number,
): OperatorRecordTypeDefinition | undefined {
  const key = observationTypeKey(recordType, recordVersion);
  return Object.hasOwn(registry.recordTypes, key) ? registry.recordTypes[key] : undefined;
}

export function listObservationTypes(registry: ObservationRegistry): ObservationTypeDefinition[] {
  return Object.values(registry.types).sort(
    (left, right) => left.type.localeCompare(right.type) || left.version - right.version,
  );
}
