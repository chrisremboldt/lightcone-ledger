import { recordRuleReadYaml, type OperatorRecordTypeSummary } from '@ledger/contracts';
import { table } from './format.js';

/**
 * The read a rule in a pack description writes for this record type, and the path it names each column by: what
 * `pnpm pack:build` checks every read and path against.
 */
export function ruleReadLines(type: OperatorRecordTypeSummary): string[] {
  const read = type.ruleRead;
  if (!read) return [];
  const own = read.where.length === 0;
  return [
    '',
    own
      ? `How a rule reads these records: each is stored as a ${read.type} observation of its own, not inside operator.record, so a read takes type ${read.type} with no where on values.recordType, and names a column by the path below.`
      : `How a rule reads these records: inside operator.record, selected by values.recordType, and a column by the path below.`,
    '    reads:',
    '      - name: <the input the check kind reads; pnpm pack:kinds lists them>',
    ...recordRuleReadYaml(read).map((line) => `        ${line}`),
    '',
    ...table(
      ['Column', 'Path in a rule'],
      read.fields.map((field) => [field.name, field.path]),
    ),
  ];
}
