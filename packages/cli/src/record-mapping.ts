import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseRecordFile, type OperatorRecordTypeSummary } from '@ledger/contracts';
import { recordType, UsageError, type Context, type Output } from './commands.js';

/**
 * Starting a column mapping from an export. A mapping is a small YAML file a
 * person reads and keeps beside the export; docs/design/operator-record-import.md, "Column mappings", has every key.
 */

const quoted = (text: string) => JSON.stringify(text);

/** One comment line per field: its name, what it holds and the words the mapping may use for it. */
function fieldComment(type: OperatorRecordTypeSummary, column: OperatorRecordTypeSummary['columns'][number]): string {
  const what = [
    column.kind === 'date_time' ? 'a time' : column.kind,
    column.placesRecord ? 'places the record' : column.required ? 'required' : '',
    column.takesDate ? 'takes a date alone' : '',
    column.units
      ? `stored in ${column.units.stored}; unit: ${column.units.accepted.flatMap((unit) => [unit.unit, ...(unit.aliases ?? [])]).join(', ')}`
      : '',
    column.options ? `options: ${column.options.map((option) => option.value).join(', ')}` : '',
    column.referenceKind ? `your own id for ${column.referenceKind.replace('_', ' ')}` : '',
  ].filter(Boolean);
  const field = type.fields.find((candidate) => candidate.name === column.field);
  return `#   ${column.key}: ${field?.label ?? column.label} (${what.join('; ')})`;
}

/** A mapping file with every column of the export listed and unassigned, and nothing guessed. */
export function mappingStart(type: OperatorRecordTypeSummary, exportName: string, headings: readonly string[]): string {
  const subjects = type.subjectKinds.filter((kind) => kind !== 'organization');
  const fieldColumns = type.columns.filter((column) => column.field);
  const lines = [
    `# Column mapping: how ${exportName} is read as ${type.recordType} version ${type.recordVersion} records (${type.title}).`,
    '# Nothing here is filled in for you. Give each column of the export the field it holds, or leave it ~ to leave it',
    '# unread. docs/design/operator-record-import.md, "Column mappings", describes every key. Check it with',
    `#   pnpm ledger records check ${type.recordType} ${exportName} --mapping <this file>`,
    `recordType: ${type.recordType}`,
    `recordVersion: ${type.recordVersion}`,
    '',
    '# The export’s times: zone is organization (your organization’s time zone) or utc, and style is how a time is',
    '# written, such as MM/DD/YYYY h:mm A for 11/10/2026 9:05 AM. Without a style, times are read as 2026-11-10 09:05.',
    '# dateStyle is how a date alone is written, such as MM/DD/YYYY, where a field takes one.',
    'times:',
    '  zone: ~',
    '  # style: MM/DD/YYYY h:mm A',
    '  # dateStyle: MM/DD/YYYY',
    '',
  ];
  if (subjects.length) {
    lines.push(
      `# The column that holds your own id for the ${type.subjectKinds.join(' or ')} each record is about.`,
      'subject:',
      '  column: ~',
    );
    if (type.subjectKinds.length > 1)
      lines.push(`  kind: ~ # one of ${type.subjectKinds.join(', ')}; or kindColumn: the column that says which`);
    lines.push('');
  }
  if (type.secondarySubjectKinds.length) {
    lines.push(
      `# The column that holds your own id for a related ${type.secondarySubjectKinds.join(' or ')}, if the export has one.`,
      'relatedSubject:',
      '  column: ~',
    );
    if (type.secondarySubjectKinds.length > 1)
      lines.push(
        `  kind: ~ # one of ${type.secondarySubjectKinds.join(', ')}; or kindColumn: the column that says which`,
      );
    lines.push('');
  }
  lines.push(
    '# Every column of the export. After the colon write the field it holds, or for a number its unit too, and for a',
    '# field with options the export’s own words for them:',
    '#   "Max Alt (ft)": { field: maxHeightFlownAboveGroundMeters, unit: ft }',
    '#   "Mission": { field: visualMode, words: { BVLOS: beyond_visual_line_of_sight } }',
    'columns:',
    ...headings.filter((heading) => heading !== '').map((heading) => `  ${quoted(heading)}: ~`),
    '',
    `# The fields of ${type.recordType} version ${type.recordVersion}:`,
    ...fieldColumns.map((column) => fieldComment(type, column)),
    '',
    '# A value for a field the export never states because it is the same for every row, such as',
    '#   operatingAuthorityReference: 107W-EX-2026-00417',
    'constants: {}',
    '',
    '# Rows to leave out by a column’s value, such as',
    '#   - { column: Status, is: [Cancelled] }',
    'leaveOut: []',
    '',
  );
  return lines.join('\n');
}

/** Reads an export's header row and writes a mapping file that lists every column, unassigned. */
export async function startRecordMapping(
  context: Context,
  name: string,
  exportPath: string,
  out: string | undefined,
): Promise<Output> {
  const type = await recordType(context.client, name);
  let bytes: Buffer;
  try {
    bytes = readFileSync(exportPath);
  } catch {
    throw new UsageError(`Cannot read ${exportPath}.`);
  }
  const parsed = parseRecordFile(new Uint8Array(bytes), 'csv');
  if (parsed.problems.length) throw new UsageError(`${basename(exportPath)}: ${parsed.problems.join(' ')}`);
  const headings = (parsed.columns ?? []).filter((heading) => heading !== '');
  const text = mappingStart(type, basename(exportPath), headings);
  const data = { recordType: type.recordType, recordVersion: type.recordVersion, columns: headings, mapping: text };
  if (!out) return { data, lines: [text.trimEnd()] };
  if (existsSync(out)) throw new UsageError(`${out} already exists; nothing was written. Give another --out.`);
  writeFileSync(out, text);
  return {
    data,
    lines: [
      `Wrote ${out}: the ${headings.length} columns of ${basename(exportPath)}, none assigned, and the fields of ${type.recordType} as comments.`,
      `Give each column the field it holds, then: pnpm ledger records check ${type.recordType} ${basename(exportPath)} --mapping ${basename(out)}`,
    ],
  };
}
