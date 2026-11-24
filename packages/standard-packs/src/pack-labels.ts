import {
  findObservationType,
  findOperatorRecordDefinition,
  isOperatorRecordDefinition,
  recordRuleRead,
  type OperatorRecordDefinition,
  type PackFileCheckedRule,
  type RuleFieldPath,
} from '@ledger/contracts';
import { observationRegistry, observationTitle, readableName, recordFieldLabel, recordTitle } from '@ledger/domain';

// The words the build printout uses for what a rule reads: records and fields by the labels the Records screen shows,
// never by a type id or a field path. Nothing here names a record type, observation type or rule.

type Read = PackFileCheckedRule['reads'][number];

const RECORD_FIELD = 'values.record.';

/** The single record type a read's conditions select, with its version when they name one. */
function selectedRecord(read: Read): { recordType: string; recordVersion: number } | undefined {
  const only = (field: string) => {
    const condition = (read.where ?? []).find((item) => item.field === field);
    return condition && 'oneOf' in condition && condition.oneOf.length === 1 ? condition.oneOf[0] : undefined;
  };
  const recordType = only('values.recordType');
  return typeof recordType === 'string'
    ? {
        recordType,
        recordVersion: typeof only('values.recordVersion') === 'number' ? (only('values.recordVersion') as number) : 1,
      }
    : undefined;
}

/** The record type stored as an observation type of its own under this observation type, if any. */
function ownRecordType(type: string, version: number): OperatorRecordDefinition | undefined {
  const definition = findOperatorRecordDefinition(observationRegistry(), type, version);
  return definition && isOperatorRecordDefinition(definition) && definition.observed ? definition : undefined;
}

/** "flight plan records", and "flight records" rather than "flight record records". */
const recordsOf = (title: string) => (/ record$/u.test(title) ? `${title}s` : `${title} records`);

/** What a person calls what a read takes, and whether those are operator records or observations. */
function readTitle(read: Read): { title: string; records: boolean } {
  const selected = selectedRecord(read);
  if (selected) return { title: recordTitle(selected.recordType, selected.recordVersion), records: true };
  const version = read.versions[0] ?? 1;
  const own = ownRecordType(read.type, version);
  if (own) return { title: recordTitle(own.recordType, own.recordVersion), records: true };
  return { title: observationTitle(read.type, version), records: false };
}

/** What a person calls the records a read takes: "flight plan records", "flight records", "wind observations". */
export function readRecordsWords(read: Read): string {
  const { title, records } = readTitle(read);
  return records ? recordsOf(title) : `${title} observations`;
}

/** The same in the singular, as it reads after "named by its": the read's own onFile words, else its title. */
export function readNoun(read: Read | undefined, fallback: string): string {
  if (!read) return readableName(fallback);
  return read.onFile ?? readTitle(read).title;
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
}

function branches(node: SchemaNode): SchemaNode[] {
  const parts = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  return parts.length ? parts.flatMap(branches) : [node];
}

/** Whether the observation type's schema has a field at the path, under any of its branches. */
function inSchema(schema: SchemaNode, path: string): boolean {
  let nodes = [schema];
  for (const part of path.split('.')) {
    nodes = nodes.flatMap(branches).flatMap((node) => (node.properties?.[part] ? [node.properties[part]!] : []));
    if (!nodes.length) return false;
  }
  return true;
}

/** A path of an observation as words: "altitude meters" for position.altitude.meters. */
function pathWords(path: string): string {
  return path
    .split('.')
    .filter((part) => part !== 'values')
    .map(readableName)
    .join(' ');
}

/** The label of one field of the records a read takes, as "the flight plan's Operating authority". */
function labelInRead(read: Read, path: string): string | undefined {
  const selected = selectedRecord(read);
  const version = read.versions[0] ?? 1;
  if (selected && path.startsWith(RECORD_FIELD)) {
    const definition = findOperatorRecordDefinition(observationRegistry(), selected.recordType, selected.recordVersion);
    const name = path.slice(RECORD_FIELD.length).split('.')[0]!;
    if (
      !definition ||
      !isOperatorRecordDefinition(definition) ||
      !definition.fields.some((field) => field.name === name)
    )
      return undefined;
    const id = path.slice(RECORD_FIELD.length).split('.').length > 1 ? ' (its id)' : '';
    return `the ${recordTitle(selected.recordType, selected.recordVersion)}’s ${recordFieldLabel(definition, name)}${id}`;
  }
  const own = ownRecordType(read.type, version);
  if (own) {
    const field = recordRuleRead(own).fields.find((item) => item.path === path);
    return field
      ? `the ${recordTitle(own.recordType, own.recordVersion)}’s ${recordFieldLabel(own, field.name)}`
      : undefined;
  }
  if (selected) return undefined;
  const observation = findObservationType(observationRegistry(), read.type, version);
  if (!observation || !inSchema(observation.schema as SchemaNode, path)) return undefined;
  const title = observationTitle(read.type, version);
  const words = pathWords(path);
  return `the ${title}’s ${words.startsWith(`${title} `) ? words.slice(title.length + 1) : words}`;
}

/** A field the rule names, by the label of the first read it may point into that has it. */
export function fieldWords(
  rule: PackFileCheckedRule,
  item: Pick<RuleFieldPath, 'path' | 'reads' | 'recordType'>,
): string {
  if (item.recordType && item.path.startsWith(RECORD_FIELD)) {
    const definition = findOperatorRecordDefinition(
      observationRegistry(),
      item.recordType.recordType,
      item.recordType.recordVersion ?? 1,
    );
    if (definition && isOperatorRecordDefinition(definition))
      return `the ${recordTitle(definition.recordType, definition.recordVersion)}’s ${recordFieldLabel(definition, item.path.slice(RECORD_FIELD.length).split('.')[0]!)}`;
  }
  const reads = item.reads.length ? rule.reads.filter((read) => item.reads.includes(read.name)) : rule.reads;
  for (const read of reads) {
    const label = labelInRead(read, item.path);
    if (label) return label;
  }
  return `the ${pathWords(item.path)}`;
}
