import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  ObservationHeaderSchema,
  findObservationType,
  isOperatorRecordDefinition,
  listObservationTypes,
  recordTimeDisagreement,
  standardObservationRegistry,
  registerObservationType,
  requestShapeRefusal,
  type SchemaError,
  registerOperatorRecordType,
  type ObservationRegistry,
  type ObservationTypeChoice,
  type ObservationTypeDefinition,
  type OperatorRecordTypeDefinition,
} from '@ledger/contracts';
import { DomainError } from '@ledger/persistence';

// One process can load this module both from source and from its build (tests do), so the registry lives on a
// process-wide key that both copies share. It starts with the built-in version-1 vocabulary and operator record types.
const registryKey = Symbol.for('ledger.observation-registry.1');
const holder: { registry: ObservationRegistry } = ((
  globalThis as Record<symbol, { registry: ObservationRegistry } | undefined>
)[registryKey] ??= { registry: standardObservationRegistry });

/** Adds observation types to the registry intake validates against. A registered type and version is never replaced. */
export function registerObservationTypes(...definitions: ObservationTypeDefinition[]): void {
  holder.registry = definitions.reduce(registerObservationType, holder.registry);
}

/** Adds record types that operator-record observations may carry. */
export function registerObservationRecordTypes(...definitions: OperatorRecordTypeDefinition[]): void {
  holder.registry = definitions.reduce(registerOperatorRecordType, holder.registry);
}

export function observationRegistry(): ObservationRegistry {
  return holder.registry;
}

interface SchemaNode {
  type?: unknown;
  title?: unknown;
  properties?: Record<string, SchemaNode>;
}

/** The numeric fields a schema titles under values, as dot paths, in declaration order. Arrays are not entered. */
function titledNumericFields(node: SchemaNode | undefined, path: string): ObservationTypeChoice['numericFields'] {
  if (!node || node.type !== 'object' || !node.properties) return [];
  return Object.entries(node.properties).flatMap(([name, property]) => {
    const field = `${path}.${name}`;
    if ((property.type === 'number' || property.type === 'integer') && typeof property.title === 'string')
      return [{ field, title: property.title }];
    return titledNumericFields(property, field);
  });
}

/** One registered observation type by the title a person knows it by, with the numeric fields it titles. */
export function observationTypeChoice(definition: ObservationTypeDefinition): ObservationTypeChoice {
  const values = (definition.schema as SchemaNode).properties?.values;
  return {
    type: definition.type,
    version: definition.version,
    title: definition.title ?? definition.type,
    subjectKinds: [...definition.subjectKinds],
    numericFields: titledNumericFields(values, 'values'),
  };
}

/** Every registered observation type as a person picks one, ordered by title. */
export function observationTypeChoices(): ObservationTypeChoice[] {
  return listObservationTypes(holder.registry)
    .map(observationTypeChoice)
    .sort((a, b) => a.title.localeCompare(b.title) || a.type.localeCompare(b.type) || a.version - b.version);
}

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: false, verbose: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
type TSchema = ObservationTypeDefinition['schema'];
const compiled = new WeakMap<TSchema, ValidateFunction>();
function validatorFor(schema: TSchema): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}
const validateHeader = validatorFor(ObservationHeaderSchema);

function describe(errors: ErrorObject[] | null | undefined, part: string): string {
  return requestShapeRefusal((errors ?? []) as SchemaError[], part);
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new DomainError(400, 'invalid_observation', message, details);
}

/**
 * Validates one observation against the registry: its type and version must be registered, the whole object must
 * match that version's schema, an interval must start before it ends, and a record carried inside it (for a type
 * whose values name a recordType and recordVersion) must match a registered record type.
 */
export function validateObservation(
  registry: ObservationRegistry,
  observation: unknown,
): { definition: ObservationTypeDefinition; observation: Record<string, any> } {
  if (!validateHeader(observation))
    invalid(`Observation type and version are required: ${describe(validateHeader.errors, 'observation')}`);
  const header = observation as { type: string; version: number };
  const definition = findObservationType(registry, header.type, header.version);
  if (!definition)
    throw new DomainError(
      400,
      'unregistered_observation_type',
      `Observation type ${header.type} version ${header.version} is not registered`,
      { type: header.type, version: header.version },
    );
  const validate = validatorFor(definition.schema);
  if (!validate(observation))
    invalid(`Observation ${header.type}@${header.version}: ${describe(validate.errors, 'observation')}`, {
      type: header.type,
      version: header.version,
    });
  const value = observation as Record<string, any>;
  const interval = value.interval as { start: string; end?: string } | undefined;
  if (interval?.end !== undefined && Date.parse(interval.start) >= Date.parse(interval.end))
    invalid('Observation interval must start before it ends');
  if (definition.intervalRequired && !interval)
    invalid(`Observation ${header.type}@${header.version} needs an interval`);
  if (definition.timing !== 'interval' && interval) invalid(`Observation ${header.type} does not take an interval`);
  validateCarriedRecord(registry, value);
  return { definition, observation: value };
}

function validateCarriedRecord(registry: ObservationRegistry, observation: Record<string, any>): void {
  const values = observation.values as Record<string, unknown>;
  if (!('recordType' in values) || !('recordVersion' in values) || !('record' in values)) return;
  const key = `${String(values.recordType)}@${String(values.recordVersion)}`;
  const recordType = Object.hasOwn(registry.recordTypes, key) ? registry.recordTypes[key] : undefined;
  if (!recordType)
    throw new DomainError(400, 'unregistered_record_type', `Record type ${key} is not registered`, {
      recordType: values.recordType,
      recordVersion: values.recordVersion,
    });
  if (isOperatorRecordDefinition(recordType) && recordType.observed)
    invalid(`Record type ${key} is recorded as a ${recordType.recordType} observation, not inside operator.record`);
  const subjectKind = observation.subject.kind as string;
  if (!(recordType.subjectKinds as readonly string[]).includes(subjectKind))
    invalid(`Record type ${key} does not describe a ${subjectKind}`);
  const declaration = isOperatorRecordDefinition(recordType) ? recordType.declaredBy : undefined;
  if (declaration && values.declarationDigest !== declaration.digest)
    invalid(
      values.declarationDigest === undefined
        ? `Record type ${key} is declared by pack ${declaration.packId}: name the declaration the record is written under in values.declarationDigest (${declaration.digest})`
        : `Record ${key} names declaration ${String(values.declarationDigest)}, but the declaration your organization's adopted pack ${declaration.packId} pins is ${declaration.digest}`,
    );
  if (!declaration && values.declarationDigest !== undefined)
    invalid(`Record type ${key} is built into Ledger; a record of it names no declaration`);
  const validate = validatorFor(recordType.schema);
  if (!validate(values.record)) invalid(`Record ${key}: ${describe(validate.errors, 'record')}`);
  // The body's time fields are the source of truth for the envelope's time.
  if (isOperatorRecordDefinition(recordType)) {
    const disagreement = recordTimeDisagreement(recordType, values.record as Record<string, unknown>, {
      occurredAt: observation.occurredAt,
      interval: observation.interval,
    });
    if (disagreement)
      throw new DomainError(400, 'record_time_disagreement', `Record ${key}: ${disagreement}`, {
        recordType: values.recordType,
        recordVersion: values.recordVersion,
      });
  }
}
