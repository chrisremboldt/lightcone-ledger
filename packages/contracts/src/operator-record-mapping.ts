import type { ObservationSubjectKind } from './observations/envelope.js';
import type { OperatorRecordDefinition, OperatorRecordField } from './observations/operator-records/define.js';
import {
  LOCAL_TIME_MARK,
  aboutOwnOrganization,
  dateAloneFields,
  entryUnitNamed,
  entryUnitNames,
  interpretRecordRow,
  recordEntryUnits,
  recordImportSubjectColumns,
  statesItsOwnZone,
  unitStem,
  type ParsedRecordFile,
  type ParsedRecordRow,
  type RecordRowContext,
  type RecordRowInterpretation,
} from './operator-record-import.js';

/**
 * A column mapping: for one record type, which column of an operator's own export is which field, with the unit,
 * time zone and date style the export uses, the export's words for a field's options, values the export never states
 * because they are the same for every row, and rows to leave out. A mapping is data: it holds no expression and no
 * arithmetic. Applying one is a pure function that turns the export's rows into the import's own rows, which are then
 * read exactly as an import file is. Documented in docs/design/operator-record-import.md, "Column mappings".
 */

export const recordMappingZones = ['organization', 'utc'] as const;
export type RecordMappingZone = (typeof recordMappingZones)[number];

export interface RecordMappingColumn {
  /** The export's heading. */
  readonly source: string;
  readonly field: string;
  /** For a number: the unit the export writes it in. */
  readonly unit?: string;
  /** For a time: whether the export's times are in the organization's zone or UTC. */
  readonly zone?: RecordMappingZone;
  /** For a time: how the export writes one, such as MM/DD/YYYY h:mm A. */
  readonly style?: string;
  /** For a date, or a time column that takes a date alone: how the export writes a date. */
  readonly dateStyle?: string;
  /** The export's words for the field's options, by the word as written. */
  readonly words?: Readonly<Record<string, string>>;
}

export interface RecordMappingSubject {
  readonly column: string;
  /** The subject kind, when the record type allows more than one. */
  readonly kind?: ObservationSubjectKind;
  /** Or the column that holds the subject kind. */
  readonly kindColumn?: string;
}

export interface RecordMappingLeaveOut {
  readonly column: string;
  /** Leave the row out when the column holds one of these, ignoring case and surrounding spaces. */
  readonly is: readonly string[];
}

export interface RecordMapping {
  readonly recordType: string;
  readonly recordVersion: number;
  readonly subject?: RecordMappingSubject;
  readonly relatedSubject?: RecordMappingSubject;
  readonly columns: readonly RecordMappingColumn[];
  /** Export columns the mapping lists and does not read. */
  readonly notRead: readonly string[];
  readonly constants: readonly { readonly field: string; readonly value: string }[];
  readonly leaveOut: readonly RecordMappingLeaveOut[];
}

/** The line of a key or item in the mapping file, by its path in the document; undefined when not known. */
export type RecordMappingLines = (path: readonly (string | number)[]) => number | undefined;

const topKeys = [
  'recordType',
  'recordVersion',
  'times',
  'subject',
  'relatedSubject',
  'columns',
  'constants',
  'leaveOut',
];
const columnKeys = ['field', 'unit', 'zone', 'style', 'dateStyle', 'words'];
const timeKeys = ['zone', 'style', 'dateStyle'];
const subjectKeys = ['column', 'kind', 'kindColumn'];
const leaveOutKeys = ['column', 'is'];

// Styles -------------------------------------------------------------------------------------------------------------

const styleTokens = ['YYYY', 'MM', 'M', 'DD', 'D', 'HH', 'H', 'hh', 'h', 'mm', 'ss', 'A'] as const;
type StyleToken = (typeof styleTokens)[number];
const styleLiterals = new Set([' ', '/', '-', '.', ':', ',', 'T']);
const tokenPattern: Record<StyleToken, string> = {
  YYYY: '(\\d{4})',
  MM: '(\\d{2})',
  M: '(\\d{1,2})',
  DD: '(\\d{2})',
  D: '(\\d{1,2})',
  HH: '(\\d{2})',
  H: '(\\d{1,2})',
  hh: '(\\d{2})',
  h: '(\\d{1,2})',
  mm: '(\\d{2})',
  ss: '(\\d{2})',
  A: '([AaPp][Mm])',
};

export const STYLE_WORDS =
  'YYYY (year), MM or M (month), DD or D (day), HH or H (hour 0 to 23), hh or h (hour 1 to 12, with A for AM or PM), mm (minutes), ss (seconds), separated by spaces, /, -, ., :, a comma or T';

interface CompiledStyle {
  readonly written: string;
  readonly pattern: RegExp;
  readonly tokens: readonly StyleToken[];
}

/** A style split into its tokens, or the reason it is not one. */
function compileStyle(style: string, kind: 'time' | 'date'): CompiledStyle | { problem: string } {
  const tokens: StyleToken[] = [];
  let pattern = '';
  let index = 0;
  while (index < style.length) {
    const token = styleTokens.find((candidate) => style.startsWith(candidate, index));
    if (token) {
      tokens.push(token);
      pattern += tokenPattern[token];
      index += token.length;
      continue;
    }
    const character = style[index]!;
    if (!styleLiterals.has(character))
      return {
        problem: `style "${style}" has "${character}", which a style does not use. A style is written with ${STYLE_WORDS}.`,
      };
    pattern += character === ' ' ? '\\s+' : character.replace(/[.\\/-]/, (literal) => `\\${literal}`);
    index++;
  }
  const has = (...wanted: StyleToken[]) => wanted.some((token) => tokens.includes(token));
  if (new Set(tokens).size !== tokens.length) return { problem: `style "${style}" names a part twice.` };
  if (!has('YYYY') || !has('MM', 'M') || !has('DD', 'D'))
    return { problem: `style "${style}" needs the year (YYYY), the month (MM or M) and the day (DD or D).` };
  const hour = has('HH', 'H', 'hh', 'h');
  if (kind === 'date' && (hour || has('mm', 'ss', 'A')))
    return { problem: `dateStyle "${style}" is for a date alone and takes no hour, minutes, seconds or AM/PM.` };
  if (kind === 'time' && (!hour || !has('mm')))
    return { problem: `style "${style}" needs the hour (HH, H, hh or h) and the minutes (mm).` };
  if (has('hh', 'h') !== has('A'))
    return {
      problem: `style "${style}": an hour from 1 to 12 (hh or h) goes with AM or PM (A), and A goes only with hh or h.`,
    };
  if (has('HH', 'H') && has('hh', 'h')) return { problem: `style "${style}" names the hour twice.` };
  return { written: style, pattern: new RegExp(`^${pattern}$`), tokens };
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** The parts a cell written in a style names, undefined when it is not written so, or 'invalid' when no real time. */
function readStyled(style: CompiledStyle, raw: string): WallParts | 'invalid' | undefined {
  const match = style.pattern.exec(raw);
  if (!match) return undefined;
  const parts: Partial<Record<StyleToken, string>> = {};
  style.tokens.forEach((token, index) => (parts[token] = match[index + 1]));
  const number = (...tokens: StyleToken[]) => {
    const found = tokens.find((token) => parts[token] !== undefined);
    return found === undefined ? undefined : Number(parts[found]);
  };
  const year = number('YYYY')!;
  const month = number('MM', 'M')!;
  const day = number('DD', 'D')!;
  let hour = number('HH', 'H', 'hh', 'h') ?? 0;
  const minute = number('mm') ?? 0;
  const second = number('ss');
  if (parts.A !== undefined) {
    if (hour < 1 || hour > 12) return 'invalid';
    const afternoon = parts.A.toUpperCase() === 'PM';
    hour = (hour % 12) + (afternoon ? 12 : 0);
  }
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || (second ?? 0) > 59) return 'invalid';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return 'invalid';
  return { year, month, day, hour, minute, ...(second === undefined ? {} : { second }) };
}

const dayText = (parts: WallParts) => `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;

/** Ledger's own forms, read when the mapping names no style. */
const LEDGER_TIME_STYLES = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm'];
const LEDGER_DATE_STYLE = 'YYYY-MM-DD';
const ledgerTimeStyles = LEDGER_TIME_STYLES.map((style) => compileStyle(style, 'time') as CompiledStyle);
const ledgerDateStyle = compileStyle(LEDGER_DATE_STYLE, 'date') as CompiledStyle;

// Loading ------------------------------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const scalarText = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;

function optionsOf(field: OperatorRecordField): readonly string[] | undefined {
  if (field.kind === 'select') return field.options.map((option) => option.value);
  if (field.kind === 'boolean') return ['yes', 'no', 'true', 'false'];
  return undefined;
}

/** A unit for a number column, needed unless the field's unit is written only one way. */
function unitProblem(field: OperatorRecordField & { kind: 'number' }, unit: string | undefined): string | undefined {
  const units = recordEntryUnits[field.unit];
  if (unit === undefined)
    return units.length > 1
      ? `${field.name} is a number; say the unit the export writes it in with unit: (${entryUnitNames(field.unit).join(', ')}). A cell that carries its own unit still wins.`
      : undefined;
  return entryUnitNamed(field.unit, unit)
    ? undefined
    : `unit "${unit}" is not accepted for ${field.name}; use ${entryUnitNames(field.unit).join(', ')}.`;
}

/** Why a constant for a number is not a number with a unit the field takes; undefined when it is. */
function constantNumberProblem(field: OperatorRecordField & { kind: 'number' }, value: string): string | undefined {
  const match = /^-?\d+(?:\.\d+)?\s*(\S*)$/.exec(value);
  if (!match) return `"${value}" is not a number.`;
  const unit = match[1] || undefined;
  if (unit === undefined && recordEntryUnits[field.unit].length > 1)
    return `write the number with its unit (${entryUnitNames(field.unit).join(', ')}), such as ${value} ${recordEntryUnits[field.unit][1]!.unit}.`;
  return unit === undefined || entryUnitNamed(field.unit, unit)
    ? undefined
    : `unit "${unit}" is not accepted; use ${entryUnitNames(field.unit).join(', ')}.`;
}

/**
 * Reads a parsed mapping document against the record type it is for. A mapping that names a field the record type
 * does not have, an option it does not offer, or anything else it cannot read is refused here, with the line.
 */
export function loadRecordMapping(
  definition: OperatorRecordDefinition,
  document: unknown,
  lineOf: RecordMappingLines = () => undefined,
): { mapping: RecordMapping; problems: readonly [] } | { problems: readonly string[] } {
  const problems: string[] = [];
  const at = (path: readonly (string | number)[], problem: string) => {
    const line = lineOf(path);
    problems.push(line === undefined ? problem : `Line ${line}: ${problem}`);
  };
  if (!isObject(document)) return { problems: ['The mapping must be a set of keys, starting with recordType.'] };
  for (const key of Object.keys(document))
    if (!topKeys.includes(key)) at([key], `"${key}" is not part of a mapping. A mapping has ${topKeys.join(', ')}.`);
  if (document.recordType !== definition.recordType || Number(document.recordVersion) !== definition.recordVersion)
    at(
      ['recordType'],
      `The mapping is for ${scalarText(document.recordType) ?? '(no recordType)'} version ${scalarText(document.recordVersion) ?? '(no recordVersion)'}, not ${definition.recordType} version ${definition.recordVersion}.`,
    );
  const fieldNamed = (name: string) => definition.fields.find((field) => field.name === name);
  const fieldList = definition.fields.map((field) => field.name).join(', ');

  const times = document.times ?? {};
  if (!isObject(times)) at(['times'], 'times holds zone, style and dateStyle.');
  const timeDefaults = isObject(times) ? times : {};
  for (const key of Object.keys(timeDefaults))
    if (!timeKeys.includes(key)) at(['times', key], `times takes ${timeKeys.join(', ')}, not "${key}".`);

  const readZone = (value: unknown, path: (string | number)[]): RecordMappingZone | undefined => {
    if (value === undefined || value === null) return undefined;
    if ((recordMappingZones as readonly unknown[]).includes(value)) return value as RecordMappingZone;
    at(path, `zone is organization (the organization’s time zone) or utc, not "${scalarText(value) ?? ''}".`);
    return undefined;
  };
  const readStyle = (value: unknown, path: (string | number)[], kind: 'time' | 'date'): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const text = scalarText(value);
    const compiled = text
      ? compileStyle(text, kind)
      : { problem: `${kind === 'time' ? 'style' : 'dateStyle'} must be text.` };
    if ('problem' in compiled) {
      at(path, compiled.problem);
      return undefined;
    }
    return text;
  };
  const defaultZone = readZone(timeDefaults.zone, ['times', 'zone']);
  const defaultStyle = readStyle(timeDefaults.style, ['times', 'style'], 'time');
  const defaultDateStyle = readStyle(timeDefaults.dateStyle, ['times', 'dateStyle'], 'date');

  const columns: RecordMappingColumn[] = [];
  const notRead: string[] = [];
  const filled = new Map<string, string>();
  const rawColumns = document.columns ?? {};
  if (!isObject(rawColumns)) at(['columns'], 'columns lists each column of the export, by its heading.');
  for (const [source, entry] of Object.entries(isObject(rawColumns) ? rawColumns : {})) {
    const path = ['columns', source];
    if (entry === null || entry === undefined) {
      notRead.push(source);
      continue;
    }
    const spec: Record<string, unknown> = isObject(entry) ? entry : { field: entry };
    for (const key of Object.keys(spec))
      if (!columnKeys.includes(key))
        at([...path, key], `column "${source}" takes ${columnKeys.join(', ')}, not "${key}".`);
    const name = scalarText(spec.field);
    if (!name) {
      at(path, `column "${source}" names no field; give the field it holds, or ~ to leave it unread.`);
      continue;
    }
    const field = fieldNamed(name);
    if (!field) {
      at(path, `column "${source}": ${definition.recordType} has no field "${name}". Its fields: ${fieldList}.`);
      continue;
    }
    if (filled.has(field.name)) {
      at(path, `columns "${filled.get(field.name)}" and "${source}" both fill ${field.name}.`);
      continue;
    }
    filled.set(field.name, source);
    const unit = spec.unit === undefined || spec.unit === null ? undefined : scalarText(spec.unit);
    if (field.kind === 'number') {
      const problem = unitProblem(field, unit);
      if (problem) at(path, `column "${source}": ${problem}`);
    } else if (unit !== undefined) at([...path, 'unit'], `column "${source}": ${field.name} takes no unit.`);
    const isTime = field.kind === 'date_time';
    const zone = readZone(spec.zone, [...path, 'zone']) ?? (isTime ? defaultZone : undefined);
    if (!isTime && spec.zone !== undefined) at([...path, 'zone'], `column "${source}": ${field.name} is not a time.`);
    if (isTime && !zone)
      at(
        path,
        `column "${source}" holds times: say whether they are in the organization’s time zone or in UTC, with zone: organization or zone: utc (under times for every column).`,
      );
    if (!isTime && spec.style !== undefined) at([...path, 'style'], `column "${source}": ${field.name} is not a time.`);
    const style = isTime ? (readStyle(spec.style, [...path, 'style'], 'time') ?? defaultStyle) : undefined;
    const takesDay = field.kind === 'date' || (isTime && dateAloneFields(definition).includes(field.name));
    if (!takesDay && spec.dateStyle !== undefined)
      at([...path, 'dateStyle'], `column "${source}": ${field.name} does not take a date alone.`);
    const dateStyle = takesDay
      ? (readStyle(spec.dateStyle, [...path, 'dateStyle'], 'date') ?? defaultDateStyle)
      : undefined;
    let words: Record<string, string> | undefined;
    if (spec.words !== undefined && spec.words !== null) {
      const options = optionsOf(field);
      if (!options) at([...path, 'words'], `column "${source}": ${field.name} has no options to translate words into.`);
      else if (!isObject(spec.words))
        at([...path, 'words'], `column "${source}": words lists each word and its option.`);
      else {
        words = {};
        for (const [word, option] of Object.entries(spec.words)) {
          const value = scalarText(option);
          if (!value || !options.includes(value))
            at(
              [...path, 'words', word],
              `column "${source}": "${scalarText(option) ?? ''}" is not an option of ${field.name}; its options are ${options.join(', ')}.`,
            );
          else words[word.trim().toLowerCase()] = value;
        }
      }
    }
    columns.push({
      source,
      field: field.name,
      ...(unit !== undefined && field.kind === 'number' ? { unit } : {}),
      ...(zone ? { zone } : {}),
      ...(style ? { style } : {}),
      ...(dateStyle ? { dateStyle } : {}),
      ...(words ? { words } : {}),
    });
  }

  const constants: { field: string; value: string }[] = [];
  const rawConstants = document.constants ?? {};
  if (!isObject(rawConstants)) at(['constants'], 'constants lists a field and the value every row has.');
  for (const [name, raw] of Object.entries(isObject(rawConstants) ? rawConstants : {})) {
    const path = ['constants', name];
    const field = fieldNamed(name);
    const value = scalarText(raw);
    if (!field) at(path, `${definition.recordType} has no field "${name}". Its fields: ${fieldList}.`);
    else if (filled.has(name))
      at(path, `${name} is filled from column "${filled.get(name)}"; give it a constant or a column, not both.`);
    else if (!value) at(path, `the constant for ${name} has no value.`);
    else if (field.kind === 'date_time')
      at(path, `${name} is a time; a time comes from the export, not from the mapping.`);
    else if (optionsOf(field) && !optionsOf(field)!.includes(value))
      at(path, `"${value}" is not an option of ${name}; its options are ${optionsOf(field)!.join(', ')}.`);
    else if (field.kind === 'number' && constantNumberProblem(field, value))
      at(path, `the constant for ${name}: ${constantNumberProblem(field, value)}`);
    else constants.push({ field: name, value });
  }

  const readSubject = (key: 'subject' | 'relatedSubject', kinds: readonly ObservationSubjectKind[]) => {
    const raw = document[key];
    const role = key === 'subject' ? 'subject' : 'related subject';
    if (raw === undefined || raw === null) return undefined;
    if (!isObject(raw)) {
      at([key], `${key} holds column, and kind or kindColumn.`);
      return undefined;
    }
    for (const name of Object.keys(raw))
      if (!subjectKeys.includes(name)) at([key, name], `${key} takes ${subjectKeys.join(', ')}, not "${name}".`);
    const column = scalarText(raw.column);
    if (!column) return undefined;
    if (!kinds.length) {
      at([key], `${definition.recordType} records have no ${role}.`);
      return undefined;
    }
    const kind = raw.kind === undefined || raw.kind === null ? undefined : scalarText(raw.kind);
    const kindColumn = raw.kindColumn === undefined || raw.kindColumn === null ? undefined : scalarText(raw.kindColumn);
    if (kind && !(kinds as readonly string[]).includes(kind))
      at([key, 'kind'], `the ${role} of ${definition.recordType} is ${kinds.join(' or ')}, not "${kind}".`);
    if (kind && kindColumn) at([key], `${key} takes kind or kindColumn, not both.`);
    if (!kind && !kindColumn && kinds.length > 1)
      at(
        [key],
        `the ${role} may be ${kinds.join(' or ')}: say which with kind:, or the column that says with kindColumn:.`,
      );
    return {
      column,
      ...(kind ? { kind: kind as ObservationSubjectKind } : {}),
      ...(kindColumn ? { kindColumn } : {}),
    };
  };
  const ownKinds = definition.subjectKinds.filter((kind) => kind !== 'organization');
  const ownOrganization = aboutOwnOrganization(definition);
  if (ownOrganization && document.subject !== undefined && document.subject !== null)
    at(['subject'], `${definition.recordType} records are about your own organization and take no subject.`);
  const subject = ownOrganization ? undefined : readSubject('subject', definition.subjectKinds);
  if (!subject && !ownOrganization && ownKinds.length === definition.subjectKinds.length)
    at(
      ['subject'],
      `${definition.recordType} records are about a ${ownKinds.join(' or ')}: give the column that holds your own id for it, with subject: column:.`,
    );
  const relatedSubject = readSubject('relatedSubject', definition.secondarySubjectKinds);

  const leaveOut: RecordMappingLeaveOut[] = [];
  const rawLeaveOut = document.leaveOut ?? [];
  if (!Array.isArray(rawLeaveOut))
    at(['leaveOut'], 'leaveOut is a list of a column and the values that leave a row out.');
  (Array.isArray(rawLeaveOut) ? rawLeaveOut : []).forEach((entry: unknown, index) => {
    const path = ['leaveOut', index];
    if (!isObject(entry)) return at(path, 'each leaveOut entry has column and is.');
    for (const name of Object.keys(entry))
      if (!leaveOutKeys.includes(name))
        at([...path, name], `leaveOut takes ${leaveOutKeys.join(', ')}, not "${name}".`);
    const column = scalarText(entry.column);
    const values = (Array.isArray(entry.is) ? entry.is : [entry.is]).map(scalarText).filter(Boolean) as string[];
    if (!column || !values.length)
      return at(path, 'each leaveOut entry has column and is, the values that leave a row out.');
    leaveOut.push({ column, is: values });
  });

  if (problems.length) return { problems };
  return {
    mapping: {
      recordType: definition.recordType,
      recordVersion: definition.recordVersion,
      ...(subject ? { subject } : {}),
      ...(relatedSubject ? { relatedSubject } : {}),
      columns,
      notRead,
      constants,
      leaveOut,
    },
    problems: [],
  };
}

// Applying -----------------------------------------------------------------------------------------------------------

/** What one column of the export became. */
export interface RecordMappingColumnUse {
  readonly source: string;
  readonly becomes: string;
}

export interface MappedRecordRow {
  /** The export's own data row number and where it is in the export. */
  readonly row: number;
  readonly locator: ParsedRecordRow['locator'];
  /** The row in the import's own columns. */
  readonly cells: Readonly<Record<string, string>>;
  /** The row read as an import row is read, with each time as the export wrote it. */
  readonly reading: RecordRowInterpretation;
}

export interface MappedRecordFile {
  readonly rows: readonly MappedRecordRow[];
  readonly leftOut: readonly { readonly row: number; readonly reason: string }[];
  readonly columns: readonly RecordMappingColumnUse[];
  /** Export columns the mapping did not read. */
  readonly unread: readonly string[];
  readonly constants: RecordMapping['constants'];
  /** Problems with the whole export; such an export yields no rows. */
  readonly problems: readonly string[];
}

const cellText = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

function zoneWords(zone: RecordMappingZone, context: RecordRowContext): string {
  return zone === 'utc' ? 'UTC' : `the organization’s time zone${context.timeZone ? ` (${context.timeZone})` : ''}`;
}

function describeColumn(definition: OperatorRecordDefinition, column: RecordMappingColumn, context: RecordRowContext) {
  const field = definition.fields.find((candidate) => candidate.name === column.field)!;
  const parts = [`${field.name} (${field.label})`];
  if (column.unit) parts.push(`in ${column.unit}`);
  if (column.zone)
    parts.push(
      `times in ${zoneWords(column.zone, context)} written ${column.style ?? 'as 2026-11-10 09:05'}${column.dateStyle ? `, a date alone written ${column.dateStyle}` : ''}`,
    );
  else if (column.dateStyle) parts.push(`dates written ${column.dateStyle}`);
  if (column.words)
    parts.push(
      `with ${Object.entries(column.words)
        .map(([word, option]) => `${word} read as ${option}`)
        .join(', ')}`,
    );
  return parts.join(', ');
}

/** The import column a mapped column fills: the field, with the unit or [local] in brackets. */
function importKey(definition: OperatorRecordDefinition, column: RecordMappingColumn): string {
  const field = definition.fields.find((candidate) => candidate.name === column.field)!;
  if (field.kind === 'number' && column.unit) return `${unitStem(field)} [${column.unit}]`;
  if (field.kind === 'date_time' && column.zone === 'organization') return `${field.name} [${LOCAL_TIME_MARK}]`;
  return field.name;
}

type CellRead = { value: string; written?: string } | { problem: string };

/** A time cell in the import's own form: a wall time for a local column, a time with its offset for a UTC one. */
function readTimeCell(
  field: OperatorRecordField,
  column: RecordMappingColumn,
  raw: string,
  takesDay: boolean,
): CellRead {
  if (statesItsOwnZone(raw)) return { value: raw };
  const styles = column.style ? [compileStyle(column.style, 'time') as CompiledStyle] : ledgerTimeStyles;
  const named = `${field.label} (${field.name})`;
  for (const style of styles) {
    const parts = readStyled(style, raw);
    if (parts === 'invalid') return { problem: `${named}: "${raw}" is not a real date and time.` };
    if (!parts) continue;
    const time = `${pad(parts.hour)}:${pad(parts.minute)}${parts.second === undefined ? '' : `:${pad(parts.second)}`}`;
    return column.zone === 'utc'
      ? {
          value: `${dayText(parts)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second ?? 0)}+00:00`,
          written: raw,
        }
      : { value: `${dayText(parts)} ${time}`, written: raw };
  }
  const dateStyle = column.dateStyle ? (compileStyle(column.dateStyle, 'date') as CompiledStyle) : ledgerDateStyle;
  const day = takesDay ? readStyled(dateStyle, raw) : undefined;
  if (day === 'invalid') return { problem: `${named}: "${raw}" is not a real date.` };
  if (day) {
    if (column.zone === 'utc')
      return {
        problem: `${named}: "${raw}" is a date with no time. A date alone is read as a day in the organization’s time zone, and the mapping says this column’s times are in UTC; give the time.`,
      };
    return { value: dayText(day), written: raw };
  }
  const style = column.style
    ? `as ${column.style}, the style the mapping gives for column "${column.source}"`
    : `as 2026-11-10 09:05, Ledger’s own form, and the mapping gives no style for column "${column.source}"`;
  return {
    problem: `${named}: "${raw}" is not written ${style}${takesDay ? `; nor is it a date alone written as ${column.dateStyle ?? LEDGER_DATE_STYLE}` : ''}.`,
  };
}

function readCell(
  definition: OperatorRecordDefinition,
  column: RecordMappingColumn,
  raw: string,
  takesDay: boolean,
): CellRead {
  const field = definition.fields.find((candidate) => candidate.name === column.field)!;
  if (field.kind === 'date_time') return readTimeCell(field, column, raw, takesDay);
  if (field.kind === 'date' && column.dateStyle) {
    const day = readStyled(compileStyle(column.dateStyle, 'date') as CompiledStyle, raw);
    if (day === 'invalid') return { problem: `${field.label} (${field.name}): "${raw}" is not a real date.` };
    if (!day)
      return {
        problem: `${field.label} (${field.name}): "${raw}" is not written as ${column.dateStyle}, the style the mapping gives for column "${column.source}".`,
      };
    return { value: dayText(day) };
  }
  const word =
    column.words && Object.hasOwn(column.words, raw.toLowerCase()) ? column.words[raw.toLowerCase()] : undefined;
  return { value: word ?? raw };
}

/** A reading with each time conversion stating the time as the export wrote it, and the zone the mapping gave. */
function withWrittenTimes(
  reading: RecordRowInterpretation,
  written: ReadonlyMap<string, { text: string; zone?: RecordMappingZone }>,
): RecordRowInterpretation {
  return {
    ...reading,
    timeConversions: reading.timeConversions.map((conversion) => {
      const as = written.get(conversion.field);
      if (!as) return conversion;
      return { ...conversion, entered: as.text, ...(as.zone === 'utc' ? { timeZone: 'UTC' } : {}) };
    }),
  };
}

/**
 * Turns an export's rows into the import's own rows by a mapping, and reads each as an import row is read. Same inputs,
 * same output. It never fills in a value the export did not hold, except the constants the mapping states, and never
 * guesses a unit or a zone: a cell it cannot read is refused with the reason, in the words the import uses.
 */
export function applyRecordMapping(
  definition: OperatorRecordDefinition,
  mapping: RecordMapping,
  file: ParsedRecordFile,
  context: RecordRowContext = {},
): MappedRecordFile {
  const heading = file.columns ?? [];
  const problems = [...file.problems];
  if (file.format !== 'csv') problems.push('A column mapping reads a CSV export, with one header row.');
  const read = new Set<string>();
  const columns: RecordMappingColumnUse[] = [];
  const use = (source: string, becomes: string) => {
    read.add(source);
    columns.push({ source, becomes });
  };
  for (const [subject, key, role] of [
    [mapping.subject, recordImportSubjectColumns.subjectId, 'subject'],
    [mapping.relatedSubject, recordImportSubjectColumns.secondarySubjectId, 'related subject'],
  ] as const) {
    if (!subject) continue;
    const kinds = role === 'subject' ? definition.subjectKinds : definition.secondarySubjectKinds;
    use(subject.column, `${key}: your own id for the ${role}, ${subject.kind ?? kinds.join(' or ')}`);
    if (subject.kindColumn) use(subject.kindColumn, `the ${role}’s kind`);
  }
  for (const column of mapping.columns) use(column.source, describeColumn(definition, column, context));
  for (const rule of mapping.leaveOut)
    use(rule.column, `leaves out a row where it is ${rule.is.map((value) => `"${value}"`).join(' or ')}`);
  if (!problems.length)
    for (const source of read)
      if (!heading.includes(source))
        problems.push(
          `The mapping reads column "${source}", which the export does not have. Its columns: ${heading.join(', ')}.`,
        );
  const unread = heading.filter((source) => source !== '' && !read.has(source));
  const base = { columns, unread, constants: mapping.constants };
  if (problems.length) return { ...base, rows: [], leftOut: [], problems };

  const dated = new Set(dateAloneFields(definition));
  const rows: MappedRecordRow[] = [];
  const leftOut: { row: number; reason: string }[] = [];
  for (const row of file.rows) {
    const cell = (source: string) => cellText(row.cells[source]).trim();
    const leaving = mapping.leaveOut.find((rule) =>
      rule.is.some((value) => value.toLowerCase() === cell(rule.column).toLowerCase()),
    );
    if (leaving) {
      leftOut.push({ row: row.row, reason: `${leaving.column} is "${cell(leaving.column)}".` });
      continue;
    }
    const cells: Record<string, string> = {};
    const written = new Map<string, { text: string; zone?: RecordMappingZone }>();
    const mappingProblems: string[] = row.problem ? [row.problem] : [];
    const subjectCells = (subject: RecordMappingSubject | undefined, idKey: string, kindKey: string) => {
      if (!subject) return;
      cells[idKey] = cell(subject.column);
      const kind = subject.kind ?? (subject.kindColumn ? cell(subject.kindColumn) : '');
      if (kind) cells[kindKey] = kind;
    };
    subjectCells(mapping.subject, recordImportSubjectColumns.subjectId, recordImportSubjectColumns.subjectKind);
    subjectCells(
      mapping.relatedSubject,
      recordImportSubjectColumns.secondarySubjectId,
      recordImportSubjectColumns.secondarySubjectKind,
    );
    for (const column of mapping.columns) {
      const raw = cell(column.source);
      if (!raw) continue;
      const result = readCell(definition, column, raw, dated.has(column.field));
      if ('problem' in result) {
        mappingProblems.push(result.problem);
        continue;
      }
      cells[importKey(definition, column)] = result.value;
      if (result.written)
        written.set(column.field, { text: result.written, ...(column.zone ? { zone: column.zone } : {}) });
    }
    // A number constant carries its own unit, which wins over the stored unit the bare field name means.
    for (const constant of mapping.constants) cells[constant.field] = constant.value;
    const interpreted = withWrittenTimes(interpretRecordRow(definition, cells, context), written);
    const reading = mappingProblems.length
      ? { ...interpreted, problems: [...mappingProblems, ...interpreted.problems] }
      : interpreted;
    rows.push({ row: row.row, locator: row.locator, cells, reading });
  }
  return { ...base, rows, leftOut, problems: [] };
}

/** A sentence for a record read through a mapping, kept with it so a later reader can repeat the reading. */
export function mappingLimitation(mappingArtifactId: string, constants: RecordMapping['constants']): string {
  const stated = constants.length
    ? ` The mapping states ${constants.map((constant) => constant.field).join(', ')} for every row; the original does not hold ${constants.length === 1 ? 'it' : 'them'}.`
    : '';
  return `Read from its original file through the column mapping retained as file ${mappingArtifactId}.${stated}`;
}
