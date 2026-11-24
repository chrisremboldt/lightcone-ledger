import {
  findObservationType,
  isOperatorRecordDefinition,
  recordRuleRead,
  ruleFieldPaths,
  type OperatorRecordDefinition,
  type OperatorRecordField,
  type PackFileCheckedRule,
  type RuleFieldPath,
} from '@ledger/contracts';
import { observationRegistry } from '@ledger/domain';

// A field path a rule names is checked against the registered schema of what it reads: the record type a read narrows
// to, or the observation type it reads. Nothing here names a record type, check kind or rule.

const RECORD_PREFIX = 'values.record.';

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: unknown;
}

type Read = PackFileCheckedRule['reads'][number];

/** Either the path reaches a value, or a sentence says why it does not. */
type Resolution = { ok: true } | { ok: false; problem: string };

function branches(node: SchemaNode): SchemaNode[] {
  const parts = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  return parts.length ? parts.flatMap(branches) : [node];
}

/** The schemas a property may have under every branch of a node. */
function propertyOf(node: SchemaNode, name: string): SchemaNode[] {
  return branches(node).flatMap((branch) => (branch.properties?.[name] ? [branch.properties[name]!] : []));
}

function propertyNames(node: SchemaNode): string[] {
  return [...new Set(branches(node).flatMap((branch) => Object.keys(branch.properties ?? {})))];
}

const isReference = (node: SchemaNode) =>
  branches(node).some((branch) => branch.properties?.id && branch.properties?.scope);

const isGroup = (node: SchemaNode) => branches(node).some((branch) => branch.properties || branch.type === 'object');

/** A path into an observation type's schema. */
function resolveInSchema(schema: SchemaNode, path: string, item: RuleFieldPath, title: string): Resolution {
  let nodes = [schema];
  const parts = path.split('.');
  for (const [index, part] of parts.entries()) {
    const next = nodes.flatMap((node) => propertyOf(node, part));
    if (!next.length) {
      const at = parts.slice(0, index).join('.');
      const names = [...new Set(nodes.flatMap(propertyNames))];
      return {
        ok: false,
        problem: `${title} have no field ${parts.slice(0, index + 1).join('.')}.${names.length ? ` Under ${at || 'the observation'} they have: ${names.join(', ')}.` : ''}`,
      };
    }
    nodes = next;
  }
  if (item.compared && nodes.some(isReference))
    return {
      ok: false,
      problem: `${path} of ${title} is a reference to another subject, stored as its id and scope; read ${path}.id.`,
    };
  if (item.compared && nodes.every(isGroup))
    return {
      ok: false,
      problem: `${path} of ${title} is a group of fields: ${nodes.flatMap(propertyNames).join(', ')}.`,
    };
  return { ok: true };
}

function fieldWords(field: OperatorRecordField): string {
  switch (field.kind) {
    case 'number':
      return `${field.name} (number, ${field.unit})`;
    case 'reference':
      return `${field.name} (reference to a ${field.referenceKind}: read ${field.name}.id)`;
    case 'select':
      return `${field.name} (one of ${field.options.map((option) => option.value).join(', ')})`;
    default:
      return `${field.name} (${field.kind.replace('_', ' ')})`;
  }
}

/** A path into the body of an operator record. */
function resolveInRecord(definition: OperatorRecordDefinition, path: string, item: RuleFieldPath): Resolution {
  const [name, ...rest] = path.slice(RECORD_PREFIX.length).split('.');
  const title = `${definition.recordType} records (version ${definition.recordVersion})`;
  const field = definition.fields.find((candidate) => candidate.name === name);
  if (!field)
    return {
      ok: false,
      problem: `${title} have no field ${name}. Their fields: ${definition.fields.map(fieldWords).join('; ')}.`,
    };
  if (field.kind === 'reference') {
    if (!rest.length)
      return item.compared
        ? {
            ok: false,
            problem: `${name} of ${title} is a reference to a ${field.referenceKind}, stored as its id and scope; read ${path}.id.`,
          }
        : { ok: true };
    if (rest.length === 1 && (rest[0] === 'id' || rest[0] === 'scope')) return { ok: true };
    return { ok: false, problem: `${name} of ${title} is a reference; read ${RECORD_PREFIX}${name}.id.` };
  }
  if (rest.length) return { ok: false, problem: `${name} of ${title} is a ${field.kind} value with no fields inside.` };
  return { ok: true };
}

const registry = () => observationRegistry();

function recordDefinitions(): OperatorRecordDefinition[] {
  return Object.values(registry().recordTypes).filter(isOperatorRecordDefinition);
}

/** The single values a list of conditions requires at a field. */
function required(read: Read, field: string): unknown[] {
  return (read.where ?? []).flatMap((condition) =>
    condition.field === field && 'oneOf' in condition ? [...condition.oneOf] : [],
  );
}

/** The record types a read takes: those its conditions or a selection name, else every one registered. */
function recordTypesOf(read: Read | undefined, item: RuleFieldPath): OperatorRecordDefinition[] | string {
  const named = item.recordType
    ? [item.recordType.recordType]
    : read
      ? required(read, 'values.recordType').filter((value): value is string => typeof value === 'string')
      : [];
  const versions = item.recordType?.recordVersion
    ? [item.recordType.recordVersion]
    : read
      ? required(read, 'values.recordVersion').filter((value): value is number => typeof value === 'number')
      : [];
  const all = recordDefinitions();
  if (!named.length) return all;
  const missing = named.filter((type) => !all.some((definition) => definition.recordType === type));
  if (missing.length)
    return `It reads ${missing.join(' and ')} records, and this Ledger registers no record type ${missing.join(' or ')}.`;
  return all.filter(
    (definition) =>
      named.includes(definition.recordType) && (!versions.length || versions.includes(definition.recordVersion)),
  );
}

/** Whether the path reaches a value in what one read takes. */
function resolveInRead(read: Read | undefined, item: RuleFieldPath): Resolution[] {
  const types = read ? read.versions.map((version) => findObservationType(registry(), read.type, version)) : [];
  // Operator records arrive inside one observation type, whose values hold the record type and the record body.
  const recordCarrier =
    !read ||
    types.some(
      (type) =>
        type &&
        propertyOf(type.schema as SchemaNode, 'values').some(
          (values) => propertyOf(values, 'record').length > 0 && propertyOf(values, 'recordType').length > 0,
        ),
    );
  if (item.path.startsWith(RECORD_PREFIX) && (recordCarrier || item.recordType)) {
    const definitions = recordTypesOf(read, item);
    if (typeof definitions === 'string') return [{ ok: false, problem: definitions }];
    return definitions.map((definition) => resolveInRecord(definition, item.path, item));
  }
  if (!read) return [{ ok: true }];
  return types.map((type): Resolution =>
    type
      ? resolveInSchema(
          type.schema as SchemaNode,
          item.path,
          item,
          `${read.type} observations (version ${type.version})`,
        )
      : { ok: true },
  );
}

/**
 * A read that selects by values.recordType a record type stored as its own observation type finds nothing: no
 * operator.record holds it. The problem says the read to write instead and the path of each of its fields.
 */
function ownObservationProblems(read: Read): string[] {
  const named = required(read, 'values.recordType').filter((value): value is string => typeof value === 'string');
  return recordDefinitions()
    .filter((definition) => definition.observed && named.includes(definition.recordType))
    .map((definition) => {
      const ruleRead = recordRuleRead(definition);
      return `Read ${read.name} selects ${definition.recordType} records by values.recordType, but ${definition.recordType} records are not stored inside operator.record: each is a ${ruleRead.type} observation of its own, so this read would find none. Write the read as type: ${ruleRead.type}, versions: [${ruleRead.versions.join(', ')}], with no condition on values.recordType, and name its fields ${ruleRead.fields.map((field) => `${field.name} as ${field.path}`).join(', ')} (pnpm ledger records columns ${definition.recordType} prints the same).`;
    });
}

/**
 * The problem with each field path the rule names that reaches nothing in what it reads: a field the record type or
 * observation type does not have, a path into a record type this Ledger does not register, or a reference compared
 * without its id. A path counts when it reaches a value in any read it may point into. Paths outside `values` (the
 * observation's own time and subject) are not checked here.
 */
export function fieldPathProblems(rule: PackFileCheckedRule): string[] {
  const reads = new Map(rule.reads.map((read) => [read.name, read]));
  const problems: string[] = rule.reads.flatMap(ownObservationProblems);
  for (const item of ruleFieldPaths(rule)) {
    if (!item.path.startsWith('values.')) continue;
    const named = item.reads.length ? item.reads : [...reads.keys()];
    // A read the rule does not list, such as the subject-state read, holds what Ledger keeps about the subject.
    if (item.reads.length && !item.reads.some((name) => reads.has(name))) continue;
    const resolutions = named.flatMap((name) => resolveInRead(reads.get(name), item));
    if (!resolutions.length || resolutions.some((resolution) => resolution.ok)) continue;
    const first = resolutions.find((resolution) => !resolution.ok) as { problem: string };
    problems.push(`${item.where} names ${item.path}: ${first.problem}`);
  }
  return [...new Set(problems)];
}
