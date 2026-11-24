import type { OperatorRecordDefinition } from './define.js';

/** The observation type every operator record is stored in, unless its type is recorded as its own observation. */
export const OPERATOR_RECORD_CARRIER = { type: 'operator.record', version: 1 } as const;

const RECORD_FIELD = 'values.record.';

/** How a rule reads one record type: the observation type and version, the selection if any, and each field's path. */
export interface RecordRuleRead {
  type: string;
  versions: number[];
  /** The conditions that take this record type out of what the observation type holds; empty when it holds only it. */
  where: { field: string; oneOf: (string | number)[] }[];
  /** Every field of the record, by name, with the path a rule names it by. */
  fields: { name: string; path: string }[];
}

/**
 * The read a rule writes for a record type. A record type recorded as its own observation (`observed`) is read as
 * that observation type with no selection: its id is the source event id, its time fields the observation's interval
 * or time, and every other field a value of the same name. Every other record type is read inside operator.record,
 * selected by its record type, each field under values.record.
 */
export function recordRuleRead(definition: OperatorRecordDefinition): RecordRuleRead {
  if (!definition.observed)
    return {
      ...OPERATOR_RECORD_CARRIER,
      versions: [OPERATOR_RECORD_CARRIER.version],
      where: [{ field: 'values.recordType', oneOf: [definition.recordType] }],
      fields: definition.fields.map((field) => ({ name: field.name, path: `${RECORD_FIELD}${field.name}` })),
    };
  const time = definition.time;
  const timePaths: Record<string, string> =
    time.meaning === 'interval'
      ? { [time.startField]: 'interval.start', [time.endField]: 'interval.end' }
      : time.atField
        ? { [time.atField]: 'occurredAt' }
        : {};
  const idField = definition.observed.idField;
  return {
    type: definition.recordType,
    versions: [definition.recordVersion],
    where: [],
    fields: definition.fields.map((field) => ({
      name: field.name,
      path: field.name === idField ? 'sourceEventId' : (timePaths[field.name] ?? `values.${field.name}`),
    })),
  };
}

/** The read as a rule writes it in a pack description, in YAML, indented to sit under `reads:` list item. */
export function recordRuleReadYaml(read: RecordRuleRead): string[] {
  return [
    `type: ${read.type}`,
    `versions: [${read.versions.join(', ')}]`,
    ...(read.where.length
      ? [
          'where:',
          ...read.where.flatMap((condition) => [
            `  - field: ${condition.field}`,
            `    oneOf: [${condition.oneOf.join(', ')}]`,
          ]),
        ]
      : []),
  ];
}
