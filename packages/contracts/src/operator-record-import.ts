import type { ObservationSubject, ObservationSubjectKind } from './observations/envelope.js';
import {
  timeFieldNames,
  type OperatorRecordBody,
  type OperatorRecordDefinition,
  type OperatorRecordField,
  type OperatorRecordUnit,
} from './observations/operator-records/define.js';
import { instantsOfWallTime, knownTimeZone, utcText, zoneOffset } from './zoned-time.js';

/**
 * File import and hand entry for operator records. Everything here is derived from a record type's field metadata,
 * so a new record type needs no import or form code. Documented in docs/design/operator-record-import.md.
 */

/** The conventional source under which an organization's people import and enter operator records. */
export const OPERATOR_RECORD_SOURCE_ID = 'operator-records';
export const OPERATOR_RECORD_IMPORT_MAX_ROWS = 2000;

export interface RecordEntryUnit {
  readonly unit: string;
  readonly label: string;
  /** Multiply an entered value by this to get the stored unit. */
  readonly factor: number;
  /** Other names a person writes for the same unit, such as kt for knots. */
  readonly aliases?: readonly string[];
}

/** Units a number may be entered in. The first is the stored unit; the others are converted explicitly. */
export const recordEntryUnits: Record<OperatorRecordUnit, readonly RecordEntryUnit[]> = {
  Meters: [
    { unit: 'm', label: 'meters', factor: 1 },
    { unit: 'ft', label: 'feet', factor: 0.3048 },
    { unit: 'mi', label: 'statute miles', factor: 1609.344, aliases: ['sm'] },
    { unit: 'nm', label: 'nautical miles', factor: 1852 },
  ],
  MetersPerSecond: [
    { unit: 'm/s', label: 'meters per second', factor: 1 },
    { unit: 'kn', label: 'knots', factor: 1852 / 3600, aliases: ['kt', 'kts'] },
    { unit: 'mph', label: 'statute miles per hour', factor: 0.44704 },
  ],
  Hours: [{ unit: 'h', label: 'hours', factor: 1, aliases: ['hr', 'hrs'] }],
  Percent: [{ unit: '%', label: 'percent', factor: 1, aliases: ['percent', 'pct'] }],
  Count: [{ unit: 'count', label: 'count', factor: 1 }],
};

export const storedUnit = (unit: OperatorRecordUnit): RecordEntryUnit => recordEntryUnits[unit][0]!;

/** The entry unit a written unit name means, by its name or another name for it, ignoring case and spaces. */
export function entryUnitNamed(unit: OperatorRecordUnit, written: string): RecordEntryUnit | undefined {
  const name = written.trim().toLowerCase();
  return recordEntryUnits[unit].find(
    (candidate) => candidate.unit === name || (candidate.aliases ?? []).includes(name),
  );
}

/** Every name a unit may be written with, for a sentence that lists them. */
export function entryUnitNames(unit: OperatorRecordUnit): string[] {
  return recordEntryUnits[unit].flatMap((candidate) => [candidate.unit, ...(candidate.aliases ?? [])]);
}

/** Converts an entered value to the stored unit, rounded to a millionth so the conversion is repeatable. */
export function convertToStoredUnit(value: number, unit: OperatorRecordUnit, entered: string): number | undefined {
  const factor = entryUnitNamed(unit, entered)?.factor;
  if (factor === undefined) return undefined;
  return Math.round(value * factor * 1_000_000) / 1_000_000;
}

// Columns ------------------------------------------------------------------------------------------------------------

export const recordImportSubjectColumns = {
  subjectId: 'subjectId',
  subjectKind: 'subjectKind',
  secondarySubjectId: 'secondarySubjectId',
  secondarySubjectKind: 'secondarySubjectKind',
  replaces: 'replaces',
} as const;
const subjectColumnKeys = new Set<string>(Object.values(recordImportSubjectColumns));

/**
 * Columns a produced CSV adds after the import template's (operator-record-production.ts). The importer reads none of
 * them as a record value: `recordId` lets a later row's `replaces` name an earlier row of the same file, and the rest
 * say when and by whom the record was recorded, what replaced it, where it came from and what was noted about it.
 */
export const producedRecordColumns = {
  recordId: 'recordId',
  recordedAt: 'recordedAt',
  recordedBy: 'recordedBy',
  replacedBy: 'replacedBy',
  originalFile: 'originalFile',
  originalSha256: 'originalSha256',
  notes: 'notes',
} as const;
const producedColumnKeys = new Set<string>(Object.values(producedRecordColumns));

/** The produced column beside a field that shows the value as it was entered, with its unit or zone. */
export const ENTERED_COLUMN_SUFFIX = ' as entered';
export const enteredColumn = (field: string) => `${field}${ENTERED_COLUMN_SUFFIX}`;

/**
 * What was written for each field the import converted, keyed by field: "200 ft", "2026-09-22 10:00 in
 * America/Chicago", "2026-10-05 (date only)".
 */
export function enteredValues(
  conversions: readonly RecordUnitConversion[],
  timeConversions: readonly RecordTimeConversion[],
): Record<string, string> {
  return Object.fromEntries([
    ...conversions.map((conversion) => [conversion.field, `${conversion.entered.value} ${conversion.entered.unit}`]),
    ...timeConversions.map((conversion) => [
      conversion.field,
      conversion.precision === 'day'
        ? `${conversion.entered} (date only)`
        : `${conversion.entered}${conversion.timeZone ? ` in ${conversion.timeZone}` : ''}`,
    ]),
  ]);
}

export interface RecordImportColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: OperatorRecordField['kind'] | 'subject_id' | 'subject_kind' | 'record_id';
  readonly required: boolean;
  readonly replayOnly: boolean;
  readonly help?: string;
  /** For a field: the record field the column fills. */
  readonly field?: string;
  /** For a number: the stored unit and the units it may be entered in, written `stem [unit]` as a column name. */
  readonly units?: { readonly stored: string; readonly stem: string; readonly accepted: readonly RecordEntryUnit[] };
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly referenceKind?: string;
  readonly subjectKinds?: readonly ObservationSubjectKind[];
  /** The column places the record in time: a row with it empty is refused. */
  readonly placesRecord?: true;
  /** The column takes a date alone, read as that day in the organization's time zone. */
  readonly takesDate?: true;
  /** Counts toward completeness unless this other column has a value. */
  readonly requiredUnless?: string;
}

/**
 * The fields that take a date alone: the time fields that place a record, and the fields that say when a report or
 * notice was made (takesDate), unless the record type is recorded as its own observation type, which has no place to
 * keep the precision (docs/design/date-only-records.md).
 */
export function dateAloneFields(definition: OperatorRecordDefinition): string[] {
  if (definition.observed) return [];
  const placing = timeFieldNames(definition.time);
  return [
    ...placing,
    ...definition.fields.filter((field) => field.takesDate && !placing.includes(field.name)).map((field) => field.name),
  ];
}

/** The part of a number field's name before its unit suffix: plannedMaxHeightAboveGroundMeters → plannedMaxHeightAboveGround. */
export function unitStem(field: OperatorRecordField & { kind: 'number' }): string {
  return field.name.endsWith(field.unit) ? field.name.slice(0, -field.unit.length) : field.name;
}

/**
 * A record type whose only subject kind is the organization: such a record is about the operator's own organization,
 * so its import and entry ask for no subject.
 */
export function aboutOwnOrganization(definition: { readonly subjectKinds: readonly string[] }): boolean {
  return definition.subjectKinds.length === 1 && definition.subjectKinds[0] === 'organization';
}

const OWN_ORGANIZATION = 'organization';

/** One column per field, in field order, after the subject columns the record type uses. */
export function recordImportColumns(definition: OperatorRecordDefinition): RecordImportColumn[] {
  const others = definition.subjectKinds.filter((kind) => kind !== OWN_ORGANIZATION);
  const subjects: RecordImportColumn[] = aboutOwnOrganization(definition)
    ? []
    : [
        {
          key: recordImportSubjectColumns.subjectId,
          label: 'Subject id',
          kind: 'subject_id',
          required: others.length === definition.subjectKinds.length,
          replayOnly: false,
          help:
            others.length === definition.subjectKinds.length
              ? `The operator’s own id for the ${definition.subjectKinds.join(' or ')} this record is about.`
              : `The operator’s own id for the ${others.join(' or ')} this record is about. Leave it blank when the subject kind is organization: the record is then about your own organization.`,
          subjectKinds: definition.subjectKinds,
        },
      ];
  if (definition.subjectKinds.length > 1)
    subjects.push({
      key: recordImportSubjectColumns.subjectKind,
      label: 'Subject kind',
      kind: 'subject_kind',
      required: true,
      replayOnly: false,
      options: definition.subjectKinds.map((kind) => ({ value: kind, label: kind })),
      subjectKinds: definition.subjectKinds,
    });
  if (definition.secondarySubjectKinds.length) {
    subjects.push({
      key: recordImportSubjectColumns.secondarySubjectId,
      label: 'Related subject id',
      kind: 'subject_id',
      required: false,
      replayOnly: false,
      help: `Optional: the operator’s own id for a related ${definition.secondarySubjectKinds.join(' or ')}.`,
      subjectKinds: definition.secondarySubjectKinds,
    });
    if (definition.secondarySubjectKinds.length > 1)
      subjects.push({
        key: recordImportSubjectColumns.secondarySubjectKind,
        label: 'Related subject kind',
        kind: 'subject_kind',
        required: false,
        replayOnly: false,
        options: definition.secondarySubjectKinds.map((kind) => ({ value: kind, label: kind })),
        subjectKinds: definition.secondarySubjectKinds,
      });
  }
  const placing = new Set(timeFieldNames(definition.time));
  const dated = new Set(dateAloneFields(definition));
  const fields = definition.fields.map((field): RecordImportColumn => {
    const common = {
      key: field.name,
      label: field.label,
      kind: field.kind,
      required: field.required,
      replayOnly: field.replayOnly,
      field: field.name,
      ...(field.help ? { help: field.help } : {}),
      ...(placing.has(field.name) ? { placesRecord: true as const } : {}),
      ...(dated.has(field.name) ? { takesDate: true as const } : {}),
      ...(field.requiredUnless ? { requiredUnless: field.requiredUnless } : {}),
    };
    if (field.kind === 'number')
      return {
        ...common,
        units: { stored: storedUnit(field.unit).unit, stem: unitStem(field), accepted: recordEntryUnits[field.unit] },
      };
    if (field.kind === 'select') return { ...common, options: field.options };
    if (field.kind === 'reference') return { ...common, referenceKind: field.referenceKind };
    return common;
  });
  const replaces: RecordImportColumn = {
    key: recordImportSubjectColumns.replaces,
    label: 'Replaces record',
    kind: 'record_id',
    required: false,
    replayOnly: false,
    help: 'Leave blank for a new record. To correct a record, give the Ledger id of the record this one replaces.',
  };
  return [...subjects, ...fields, replaces];
}

/** A CSV template: one header row of column names. */
export function recordCsvTemplate(definition: OperatorRecordDefinition): string {
  return `${recordImportColumns(definition)
    .map((column) => csvCell(column.key))
    .join(',')}\r\n`;
}

/** A JSON template: the record type and one record with every column set to null. */
export function recordJsonTemplate(definition: OperatorRecordDefinition): string {
  const record = Object.fromEntries(recordImportColumns(definition).map((column) => [column.key, null]));
  return `${JSON.stringify(
    { recordType: definition.recordType, recordVersion: definition.recordVersion, records: [record] },
    null,
    2,
  )}\n`;
}

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// Parsing ------------------------------------------------------------------------------------------------------------

export type RecordFileFormat = 'csv' | 'json';
export type RecordRowLocator =
  { kind: 'json_pointer'; value: string } | { kind: 'byte_range'; value: { offsetBytes: number; lengthBytes: number } };

export interface ParsedRecordRow {
  /** 1-based data row (CSV, after the header) or record (JSON) number. */
  readonly row: number;
  readonly locator: RecordRowLocator;
  readonly cells: Readonly<Record<string, unknown>>;
  /** A problem with the row's shape found while parsing, before any value is read. */
  readonly problem?: string;
}

export interface ParsedRecordFile {
  readonly format: RecordFileFormat;
  readonly rows: readonly ParsedRecordRow[];
  /** Problems with the whole file. A file with any of these yields no rows. */
  readonly problems: readonly string[];
  readonly recordType?: string;
  readonly recordVersion?: number;
  /** A CSV file's header row, in order, as written. */
  readonly columns?: readonly string[];
  /** When a JSON file says it was written, by the clock of the device that wrote it. */
  readonly writtenAt?: string;
}

export function recordFileFormat(contentType: string, bytes: Uint8Array): RecordFileFormat {
  if (/json/i.test(contentType)) return 'json';
  if (/csv|comma-separated/i.test(contentType)) return 'csv';
  const first = [...bytes.subarray(0, 64)].find((byte) => ![0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(byte));
  return first === 0x7b ? 'json' : 'csv';
}

const utf8 = new TextEncoder();
const utf8Length = (text: string) => utf8.encode(text).byteLength;

function decode(bytes: Uint8Array): { text: string; offset: number } | undefined {
  try {
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), offset: bom ? 3 : 0 };
  } catch {
    return undefined;
  }
}

export function parseRecordFile(bytes: Uint8Array, format: RecordFileFormat): ParsedRecordFile {
  const decoded = decode(bytes);
  if (!decoded) return { format, rows: [], problems: ['The file is not UTF-8 text.'] };
  return format === 'json' ? parseJsonRecords(decoded.text) : parseCsvRecords(decoded.text, decoded.offset);
}

interface CsvLine {
  cells: string[];
  start: number;
  end: number;
}

/** RFC 4180: comma separated, double quotes around a cell that holds a comma, quote or line break. */
function csvLines(text: string): { lines: CsvLine[]; problem?: string } {
  const lines: CsvLine[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let start = 0;
  let index = 0;
  const finishLine = (end: number) => {
    cells.push(cell);
    lines.push({ cells, start, end });
    cells = [];
    cell = '';
  };
  while (index < text.length) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 2;
        continue;
      }
      if (character === '"') quoted = false;
      else cell += character;
      index++;
      continue;
    }
    if (character === '"' && cell === '') quoted = true;
    else if (character === ',') {
      cells.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      finishLine(index);
      index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
      start = index;
      continue;
    } else cell += character;
    index++;
  }
  if (quoted) return { lines, problem: 'The file ends inside a quoted value; a closing double quote is missing.' };
  if (cell !== '' || cells.length) finishLine(text.length);
  return { lines };
}

function parseCsvRecords(text: string, baseOffset: number): ParsedRecordFile {
  const { lines, problem } = csvLines(text);
  if (problem) return { format: 'csv', rows: [], problems: [problem] };
  const [header, ...data] = lines.filter((line) => line.cells.some((cell) => cell.trim() !== ''));
  if (!header) return { format: 'csv', rows: [], problems: ['The file has no header row.'] };
  const keys = header.cells.map((cell) => cell.trim());
  const duplicate = keys.find((key, index) => key !== '' && keys.indexOf(key) !== index);
  if (duplicate) return { format: 'csv', rows: [], problems: [`The header names column "${duplicate}" twice.`] };
  if (data.length > OPERATOR_RECORD_IMPORT_MAX_ROWS)
    return { format: 'csv', rows: [], problems: [tooManyRows(data.length)] };
  let position = 0;
  let offset = baseOffset;
  const byteOffset = (index: number) => {
    offset += utf8Length(text.slice(position, index));
    position = index;
    return offset;
  };
  const rows = data.map((line, index): ParsedRecordRow => {
    const offsetBytes = byteOffset(line.start);
    const lengthBytes = utf8Length(text.slice(line.start, line.end));
    const cells: Record<string, string> = {};
    line.cells.forEach((value, column) => {
      if (column < keys.length) cells[keys[column]!] = value;
    });
    return {
      row: index + 1,
      locator: { kind: 'byte_range', value: { offsetBytes, lengthBytes } },
      cells,
      ...(line.cells.length > keys.length
        ? { problem: `The row has ${line.cells.length} values but the header has ${keys.length} columns.` }
        : {}),
    };
  });
  return { format: 'csv', rows, problems: [], columns: keys };
}

function tooManyRows(count: number): string {
  return `The file has ${count} records; split it into files of at most ${OPERATOR_RECORD_IMPORT_MAX_ROWS}.`;
}

function parseJsonRecords(text: string): ParsedRecordFile {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { format: 'json', rows: [], problems: ['The file is not valid JSON.'] };
  }
  const shape = document as { recordType?: unknown; recordVersion?: unknown; records?: unknown; writtenAt?: unknown };
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(shape.records))
    return {
      format: 'json',
      rows: [],
      problems: ['The file must be a JSON object with recordType, recordVersion and a records array.'],
    };
  if (shape.writtenAt !== undefined && !writtenTime(shape.writtenAt))
    return {
      format: 'json',
      rows: [],
      problems: ['writtenAt must be a time with its offset, such as 2026-11-25T14:03:00Z.'],
    };
  const records = shape.records as unknown[];
  if (records.length > OPERATOR_RECORD_IMPORT_MAX_ROWS)
    return { format: 'json', rows: [], problems: [tooManyRows(records.length)] };
  const rows = records.map((record, index): ParsedRecordRow => {
    const object = record && typeof record === 'object' && !Array.isArray(record);
    return {
      row: index + 1,
      locator: { kind: 'json_pointer', value: `/records/${index}` },
      cells: object ? (record as Record<string, unknown>) : {},
      ...(object ? {} : { problem: 'The record is not a JSON object.' }),
    };
  });
  return {
    format: 'json',
    rows,
    problems: [],
    ...(typeof shape.recordType === 'string' ? { recordType: shape.recordType } : {}),
    ...(typeof shape.recordVersion === 'number' ? { recordVersion: shape.recordVersion } : {}),
    ...(shape.writtenAt !== undefined ? { writtenAt: writtenTime(shape.writtenAt) } : {}),
  };
}

/** A time stated with its offset, as UTC; undefined for anything else. */
function writtenTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** What a record says about the time the file it came from says it was written. */
export function describeWrittenAt(writtenAt: string): string {
  return `Written at ${writtenAt} by the clock of the device it was entered on; Ledger does not check that clock.`;
}

// Interpreting one row -------------------------------------------------------------------------------------------------

export interface RecordUnitConversion {
  readonly field: string;
  readonly entered: { readonly value: number; readonly unit: string };
  readonly stored: { readonly value: number; readonly unit: string };
}

/**
 * A time entered in the organization's zone or with an offset, and the UTC instant recorded for it. timeZone is the
 * zone it was read in; absent when the value stated its own offset.
 */
export interface RecordTimeConversion {
  readonly field: string;
  readonly entered: string;
  readonly timeZone?: string;
  readonly stored: string;
  /** day: a date alone was entered, and the record is placed on that day in the zone. */
  readonly precision?: 'day';
  /** The date alone was in the column that ends the record's interval: it is stored as the end of that day. */
  readonly endOfDay?: true;
}

/**
 * A field that takes a date alone, given as one: the day in the organization's zone, kept beside the record body as
 * values.dayOnly. The field stores the day's first instant, or, for the column that ends the record's interval, the
 * end of the day (the first instant of the following day, as an adoption's --until); nextDayAt is the first instant
 * of the following day.
 */
export interface RecordDayOnly {
  readonly day: string;
  readonly timeZone: string;
  readonly nextDayAt: string;
}

/** The bracketed word after a time field's name that says its times are in the organization's zone. */
export const LOCAL_TIME_MARK = 'local';

/** How a time may be written, for a sentence that refuses one. */
export const ACCEPTED_TIME_FORMS =
  'UTC as 2026-11-10T15:00:00Z, with its offset as 2026-11-10T09:00-06:00, or in the organization’s time zone under a heading ending in [local] as 2026-11-10 09:00';

/** How a date alone may be written in a column that places a record. */
export const ACCEPTED_DAY_FORM = 'the date alone as 2026-10-05, read as that day in the organization’s time zone';

/** What reading a row needs besides its cells. */
export interface RecordRowContext {
  /** The organization's IANA time zone, which a [local] time column is read in. */
  readonly timeZone?: string;
}

export interface RecordRowInterpretation {
  readonly subject?: ObservationSubject;
  /** The record is about the operator's own organization: the Ledger organization the import is for. */
  readonly ownOrganization?: true;
  readonly secondarySubject?: ObservationSubject;
  readonly replaces?: string;
  /** The row's own record id in a produced file, which a later row's replaces may name. */
  readonly recordId?: string;
  readonly record: OperatorRecordBody;
  readonly conversions: readonly RecordUnitConversion[];
  readonly timeConversions: readonly RecordTimeConversion[];
  /** The fields given as a date alone, by field name. */
  readonly dayOnly: Readonly<Record<string, RecordDayOnly>>;
  /** Why the row cannot be recorded. Empty when it can. */
  readonly problems: readonly string[];
  /** What the row gave that is not used, in plain words. The row is still recorded. */
  readonly notes: readonly string[];
}

type ColumnTarget = { field: OperatorRecordField; unit?: string; local?: true } | { problem: string };
type ColumnRead = { unit?: string; local?: true; dated?: boolean; endsInterval?: boolean };

/**
 * A column is a field name; a number field's stem or name followed by a unit in brackets: `ceilingAboveGround [ft]`;
 * or a time field's name followed by `[local]`, whose times are in the organization's zone.
 */
export function resolveRecordColumn(definition: OperatorRecordDefinition, key: string): ColumnTarget {
  const bracketed = /^(.*?)\s*\[([^\]]*)\]$/.exec(key.trim());
  const name = bracketed ? bracketed[1]! : key.trim();
  const field = definition.fields.find(
    (candidate) =>
      candidate.name === name || (candidate.kind === 'number' && bracketed && unitStem(candidate) === name),
  );
  if (!field) return { problem: `Column "${key}" is not a field of ${definition.title}.` };
  if (!bracketed) return { field };
  const unit = bracketed[2]!.trim();
  if (field.kind === 'date_time')
    return unit.toLowerCase() === LOCAL_TIME_MARK
      ? { field, local: true }
      : {
          problem: `Column "${key}": write ${field.name} [${LOCAL_TIME_MARK}] for times in the organization’s time zone; a time field takes no other word in brackets.`,
        };
  if (field.kind !== 'number') return { problem: `Column "${key}": ${field.label} does not take a unit.` };
  const entry = entryUnitNamed(field.unit, unit);
  if (!entry)
    return {
      problem: `Column "${key}": unit "${unit}" is not accepted for ${field.label}; use ${entryUnitNames(field.unit).join(', ')}.`,
    };
  // The unit is kept as the person wrote it, so the recorded conversion states what was entered.
  return { field, unit: entry.unit === storedUnit(field.unit).unit ? entry.unit : unit };
}

const blank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/;
const utcTime = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/;

function validCalendarDate(value: string): boolean {
  const match = calendarDate.exec(value);
  if (!match || match[1] === '0000') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validUtcTime(value: string): boolean {
  if (!utcTime.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}

const wallTimePattern = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const offsetTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A time written in UTC or with its offset, which every time column reads whatever its heading. */
export const statesItsOwnZone = (raw: string): boolean => utcTime.test(raw) || offsetTimePattern.test(raw);

/** The UTC milliseconds a wall reading names taken as UTC, or undefined when it is not a real calendar time. */
function wallReading(match: RegExpExecArray): number | undefined {
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  if (year === 0 || hour! > 23 || minute! > 59 || second! > 59) return undefined;
  const at = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month! - 1 && back.getUTCDate() === day
    ? at
    : undefined;
}

type TimeRead =
  { value: string; conversion?: Omit<RecordTimeConversion, 'field'>; dayOnly?: RecordDayOnly } | { problem: string };

/** The first instant of a local calendar day in a zone: its midnight, or the end of a gap that skips midnight. */
export function dayStartInstant(day: string, timeZone: string): number | undefined {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  for (let minutes = 0; minutes <= 180; minutes += 15) {
    const instants = instantsOfWallTime(midnight + minutes * 60_000, timeZone);
    if (instants.length) return instants[0]!;
  }
  return undefined;
}

/**
 * A date alone in a column that takes one: that day in the organization's zone, stored as its first instant, or as
 * its end (the first instant of the next day) in the column that ends the record's interval.
 */
function readDay(raw: string, named: string, timeZone: string | undefined, endOfDay: boolean): TimeRead {
  if (!validCalendarDate(raw)) return { problem: `${named}: "${raw}" is not a real date.` };
  if (!timeZone || !knownTimeZone(timeZone))
    return { problem: `${named}: the organization’s time zone is not known, so the date "${raw}" cannot be placed.` };
  const start = dayStartInstant(raw, timeZone);
  const next = dayStartInstant(
    new Date(Date.parse(`${raw}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
    timeZone,
  );
  if (start === undefined || next === undefined)
    return { problem: `${named}: the date "${raw}" cannot be placed in ${timeZone}.` };
  const stored = utcText(endOfDay ? next : start);
  return {
    value: stored,
    conversion: { entered: raw, timeZone, stored, precision: 'day', ...(endOfDay ? { endOfDay: true as const } : {}) },
    dayOnly: { day: raw, timeZone, nextDayAt: utcText(next) },
  };
}

/**
 * A time field's value: UTC with Z, or with an offset, under any heading; under a [local] heading also a wall-clock
 * time in the organization's zone. A wall time the zone skips or repeats is refused, since it names no one instant.
 */
export function readRecordTime(
  raw: string,
  named: string,
  local: boolean,
  timeZone: string | undefined,
  takesDate = false,
  /** The column ends the record's interval: a date alone there is the end of that day. */
  endsInterval = false,
): TimeRead {
  const shown = `"${raw}"`;
  if (validUtcTime(raw)) return { value: raw };
  if (calendarDate.test(raw))
    return takesDate
      ? readDay(raw, named, timeZone, endsInterval)
      : {
          problem: `${named}: ${shown} is a date with no time. This column takes a time: a date alone is taken only in the column that places the record and in a column that says when a report or notice was made; write a time here in ${ACCEPTED_TIME_FORMS}.`,
        };
  const offset = offsetTimePattern.exec(raw);
  if (offset) {
    const wall = wallReading(offset);
    if (wall === undefined) return { problem: `${named}: ${shown} is not a real date and time.` };
    const zone = offset[7]!;
    if (zone === 'Z') return { value: utcText(wall) };
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    if (Number(digits.slice(0, 2)) > 14 || Number(digits.slice(2)) > 59)
      return { problem: `${named}: ${shown} has an offset no time zone uses.` };
    const stored = utcText(wall - sign * minutes * 60_000);
    return { value: stored, conversion: { entered: raw, stored } };
  }
  const wallMatch = wallTimePattern.exec(raw);
  if (!wallMatch)
    return { problem: `${named}: ${shown} is not a time Ledger can read. Write it in ${ACCEPTED_TIME_FORMS}.` };
  if (!local)
    return {
      problem: `${named}: ${shown} does not say which time zone it is in. Name the column with [${LOCAL_TIME_MARK}] after it to read it in the organization’s time zone${timeZone ? ` (${timeZone})` : ''}, or write it in ${ACCEPTED_TIME_FORMS}.`,
    };
  if (!timeZone || !knownTimeZone(timeZone))
    return {
      problem: `${named}: the organization’s time zone is not known, so ${shown} cannot be read as a local time.`,
    };
  const wall = wallReading(wallMatch);
  if (wall === undefined) return { problem: `${named}: ${shown} is not a real date and time.` };
  const instants = instantsOfWallTime(wall, timeZone);
  if (instants.length === 0)
    return {
      problem: `${named}: ${shown} does not happen in ${timeZone}; the clocks moved forward past it that day. Give the time with its offset.`,
    };
  if (instants.length > 1)
    return {
      problem: `${named}: ${shown} happens twice in ${timeZone}, because the clocks moved back that day. Give it with its offset: ${instants
        .map((instant) => `${raw.replace(' ', 'T')}${zoneOffset(instant, timeZone)}`)
        .join(' for the first, ')} for the second.`,
    };
  const stored = utcText(instants[0]!);
  return { value: stored, conversion: { entered: raw, timeZone, stored } };
}

type Read =
  | {
      value: unknown;
      conversion?: RecordUnitConversion;
      timeConversion?: RecordTimeConversion;
      dayOnly?: RecordDayOnly;
    }
  | { problem: string };

/** A number with a unit written in the cell after it, such as 300ft or 104 m, and any words after the unit. */
const numberWithText = /^\s*(-?\d+(?:\.\d+)?)\s*(\S.*?)\s*$/;

/**
 * The number a cell holds and the unit it is in: the unit written in the cell after the number wins over the
 * heading's. Words after the unit, or anything that is not a unit, are refused with what to remove.
 */
function enteredNumber(
  field: OperatorRecordField & { kind: 'number' },
  raw: unknown,
  headingUnit: string | undefined,
  named: string,
  shown: string,
): { value: number; unit: string | undefined } | { problem: string } {
  if (typeof raw === 'number') return { value: raw, unit: headingUnit };
  const text = String(raw);
  if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(text)) return { value: Number(text), unit: headingUnit };
  const match = numberWithText.exec(text);
  if (!match) return { problem: `${named}: ${shown} is not a number.` };
  const [, number, written] = match as unknown as [string, string, string];
  const accepted = entryUnitNames(field.unit);
  const word = /^([^\s\d.]+)(.*)$/.exec(written);
  const unit = word && entryUnitNamed(field.unit, word[1]!) ? word[1]! : undefined;
  const rest = unit ? word![2]!.trim() : written;
  if (!unit)
    return {
      problem: `${named}: ${shown} has "${written}" after the number, which is not a unit Ledger reads for ${field.label}. Remove it, or write the number with one of ${accepted.join(', ')}.`,
    };
  if (rest)
    return {
      problem: `${named}: ${shown} has "${rest}" after the unit. Remove "${rest}" and keep the number and its unit, such as ${number} ${unit}.`,
    };
  const entry = entryUnitNamed(field.unit, unit)!;
  return { value: Number(number), unit: entry.unit === storedUnit(field.unit).unit ? entry.unit : unit };
}

function readValue(field: OperatorRecordField, raw: unknown, column: ColumnRead, context: RecordRowContext): Read {
  const unit = column.unit;
  const named = `${field.label} (${field.name})`;
  const shown = typeof raw === 'string' ? `"${raw.trim()}"` : JSON.stringify(raw);
  switch (field.kind) {
    case 'text':
    case 'long_text': {
      const value = text(raw);
      if (value === undefined) return { problem: `${named} must be text.` };
      const limit = field.kind === 'text' ? 1000 : 10_000;
      return value.length > limit ? { problem: `${named} is longer than ${limit} characters.` } : { value };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const word = text(raw)?.toLowerCase();
      if (word === 'true' || word === 'yes') return { value: true };
      if (word === 'false' || word === 'no') return { value: false };
      return { problem: `${named}: ${shown} is not yes or no (true or false).` };
    }
    case 'date': {
      const value = text(raw);
      return value && validCalendarDate(value)
        ? { value }
        : { problem: `${named}: ${shown} is not a date written as YYYY-MM-DD.` };
    }
    case 'date_time': {
      const value = text(raw);
      if (!value) return { problem: `${named} must be a time.` };
      const read = readRecordTime(
        value,
        named,
        Boolean(column.local),
        context.timeZone,
        Boolean(column.dated),
        Boolean(column.endsInterval),
      );
      if ('problem' in read) return read;
      return read.conversion
        ? {
            value: read.value,
            timeConversion: { field: field.name, ...read.conversion },
            ...(read.dayOnly ? { dayOnly: read.dayOnly } : {}),
          }
        : { value: read.value };
    }
    case 'number': {
      const number = enteredNumber(field, raw, unit, named, shown);
      if ('problem' in number) return number;
      const entered = number.value;
      if (!Number.isFinite(entered)) return { problem: `${named}: ${shown} is not a number.` };
      const stored = storedUnit(field.unit);
      const from = number.unit ?? stored.unit;
      const value = convertToStoredUnit(entered, field.unit, from)!;
      if (field.integer && !Number.isInteger(value)) return { problem: `${named} must be a whole number.` };
      if (value < field.minimum || value > field.maximum)
        return {
          problem: `${named}: ${entered} ${from} is outside ${field.minimum} to ${field.maximum} ${stored.unit}.`,
        };
      return from === stored.unit
        ? { value }
        : {
            value,
            conversion: {
              field: field.name,
              entered: { value: entered, unit: from },
              stored: { value, unit: stored.unit },
            },
          };
    }
    case 'select': {
      const value = text(raw)?.toLowerCase();
      const option = field.options.find(
        (candidate) => candidate.value.toLowerCase() === value || candidate.label.toLowerCase() === value,
      );
      return option
        ? { value: option.value }
        : {
            problem: `${named}: ${shown} is not one of ${field.options.map((candidate) => candidate.value).join(', ')}.`,
          };
    }
    case 'reference': {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const reference = raw as { id?: unknown; scope?: unknown };
        if (typeof reference.id === 'string' && (reference.scope === 'source' || reference.scope === 'ledger'))
          return { value: { id: reference.id.trim(), scope: reference.scope } };
        return { problem: `${named} must be an id, or an object with id and scope (source or ledger).` };
      }
      const value = text(raw);
      return value ? { value: { id: value, scope: 'source' } } : { problem: `${named} must be an id.` };
    }
  }
}

function subjectFrom(
  cells: Readonly<Record<string, unknown>>,
  idKey: string,
  kindKey: string,
  kinds: readonly ObservationSubjectKind[],
  role: string,
  problems: string[],
): ObservationSubject | undefined {
  const id = text(cells[idKey]);
  const kind = text(cells[kindKey]);
  if (!id) {
    if (kind) problems.push(`${kindKey} is given without ${idKey}.`);
    return undefined;
  }
  if (id.length > 200) {
    problems.push(`${idKey} is longer than 200 characters.`);
    return undefined;
  }
  const chosen = kind || (kinds.length === 1 ? kinds[0] : undefined);
  if (!chosen) {
    problems.push(`${kindKey} is needed: the ${role} may be ${kinds.join(', ')}.`);
    return undefined;
  }
  if (!(kinds as readonly string[]).includes(chosen)) {
    problems.push(`${kindKey} "${chosen}" is not one of ${kinds.join(', ')}.`);
    return undefined;
  }
  return { kind: chosen as ObservationSubjectKind, id, scope: 'source' };
}

/**
 * Reads one row into a record body, subjects and the record it replaces, converting entered units to stored units.
 * Blank cells are absent fields. Schema validation and intake's own checks come after this, in the domain.
 */
export function interpretRecordRow(
  definition: OperatorRecordDefinition,
  cells: Readonly<Record<string, unknown>>,
  context: RecordRowContext = {},
): RecordRowInterpretation {
  const problems: string[] = [];
  const notes: string[] = [];
  const record: Record<string, unknown> = {};
  const conversions: RecordUnitConversion[] = [];
  const timeConversions: RecordTimeConversion[] = [];
  const dayOnly: Record<string, RecordDayOnly> = {};
  const dated = new Set(dateAloneFields(definition));
  const ownOrganization =
    aboutOwnOrganization(definition) ||
    ((definition.subjectKinds as readonly string[]).includes(OWN_ORGANIZATION) &&
      text(cells[recordImportSubjectColumns.subjectKind]) === OWN_ORGANIZATION);
  const subject = ownOrganization
    ? undefined
    : subjectFrom(
        cells,
        recordImportSubjectColumns.subjectId,
        recordImportSubjectColumns.subjectKind,
        definition.subjectKinds,
        'subject',
        problems,
      );
  if (ownOrganization && !blank(cells[recordImportSubjectColumns.subjectId]))
    notes.push(
      aboutOwnOrganization(definition)
        ? `A ${definition.title.toLowerCase()} record is about your own organization; the subjectId column is not used for this record type.`
        : 'With subject kind organization the record is about your own organization; the subjectId column is not used for it.',
    );
  if (!ownOrganization && !subject && blank(cells[recordImportSubjectColumns.subjectId]))
    problems.push(
      (definition.subjectKinds as readonly string[]).includes(OWN_ORGANIZATION)
        ? 'subjectId is needed, or subjectKind organization for a record about your own organization.'
        : 'subjectId is needed.',
    );
  const secondarySubject = definition.secondarySubjectKinds.length
    ? subjectFrom(
        cells,
        recordImportSubjectColumns.secondarySubjectId,
        recordImportSubjectColumns.secondarySubjectKind,
        definition.secondarySubjectKinds,
        'related subject',
        problems,
      )
    : undefined;
  const replaces = text(cells[recordImportSubjectColumns.replaces]) || undefined;
  const recordId = text(cells[producedRecordColumns.recordId]) || undefined;
  for (const [key, raw] of Object.entries(cells)) {
    if (producedColumnKeys.has(key) || key.endsWith(ENTERED_COLUMN_SUFFIX)) continue;
    if (subjectColumnKeys.has(key)) {
      if (
        !definition.secondarySubjectKinds.length &&
        (key === recordImportSubjectColumns.secondarySubjectId ||
          key === recordImportSubjectColumns.secondarySubjectKind) &&
        !blank(raw)
      )
        problems.push(`${definition.title} has no related subject; column "${key}" must be empty.`);
      continue;
    }
    if (blank(raw)) continue;
    const target = resolveRecordColumn(definition, key);
    if ('problem' in target) {
      problems.push(target.problem);
      continue;
    }
    if (target.field.name in record) {
      problems.push(`${target.field.label} (${target.field.name}) is given in more than one column.`);
      continue;
    }
    const read = readValue(
      target.field,
      raw,
      {
        ...target,
        dated: dated.has(target.field.name),
        endsInterval: definition.time.meaning === 'interval' && definition.time.endField === target.field.name,
      },
      context,
    );
    if ('problem' in read) problems.push(read.problem);
    else {
      record[target.field.name] = read.value;
      if (read.conversion) conversions.push(read.conversion);
      if (read.timeConversion) timeConversions.push(read.timeConversion);
      if (read.dayOnly) dayOnly[target.field.name] = read.dayOnly;
    }
  }
  if (!Object.keys(record).length && !problems.length) problems.push('The row has no record values.');
  return {
    ...(subject ? { subject } : {}),
    ...(ownOrganization ? { ownOrganization: true as const } : {}),
    ...(secondarySubject ? { secondarySubject } : {}),
    ...(replaces ? { replaces } : {}),
    ...(recordId ? { recordId } : {}),
    record,
    conversions,
    timeConversions,
    dayOnly,
    problems,
    notes,
  };
}

export function describeConversion(definition: OperatorRecordDefinition, conversion: RecordUnitConversion): string {
  const label = definition.fields.find((field) => field.name === conversion.field)?.label ?? conversion.field;
  return `${label} was entered as ${conversion.entered.value} ${conversion.entered.unit} and recorded as ${conversion.stored.value} ${conversion.stored.unit}.`;
}

export function describeTimeConversion(definition: OperatorRecordDefinition, conversion: RecordTimeConversion): string {
  const label = definition.fields.find((field) => field.name === conversion.field)?.label ?? conversion.field;
  if (conversion.precision === 'day' && conversion.endOfDay)
    return `${label} was entered as ${conversion.entered}, a date with no time; it ends the record, so it is recorded as the end of that day in ${conversion.timeZone}, ${conversion.stored}.`;
  if (conversion.precision === 'day')
    return `${label} was entered as ${conversion.entered}, a date with no time; it is recorded as that day in ${conversion.timeZone}, from ${conversion.stored} to the end of the day.`;
  return `${label} was entered as ${conversion.entered}${conversion.timeZone ? ` in ${conversion.timeZone}` : ''} and recorded as ${conversion.stored}.`;
}

// Time ------------------------------------------------------------------------------------------------------------------

export interface OperatorRecordEnvelopeTime {
  readonly occurredAt?: string;
  readonly interval?: { readonly start: string; readonly end?: string };
}

/**
 * The envelope time the body's time fields give. as_of without a time field gives nothing: the caller supplies the
 * time of recording. For an interval, occurredAt is not derived; it is when the statement was made.
 */
export function operatorRecordTime(
  definition: OperatorRecordDefinition,
  record: OperatorRecordBody,
): OperatorRecordEnvelopeTime & { missingTimeField?: string } {
  const time = definition.time;
  const value = (name: string) => (typeof record[name] === 'string' ? (record[name] as string) : undefined);
  if (time.meaning === 'interval') {
    const start = value(time.startField);
    const end = value(time.endField);
    if (!start) return { missingTimeField: time.startField };
    return { interval: { start, ...(end ? { end } : {}) } };
  }
  if (!time.atField) return {};
  const at = value(time.atField);
  return at ? { occurredAt: at } : { missingTimeField: time.atField };
}

/**
 * Why a record's end time does not come after its start, in the type's own field labels, or undefined when it does
 * (or either is missing).
 */
export function recordIntervalProblem(
  definition: OperatorRecordDefinition,
  record: OperatorRecordBody,
): string | undefined {
  const time = definition.time;
  if (time.meaning !== 'interval') return undefined;
  const start = record[time.startField];
  const end = record[time.endField];
  if (typeof start !== 'string' || typeof end !== 'string') return undefined;
  const [startAt, endAt] = [Date.parse(start), Date.parse(end)];
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt > startAt) return undefined;
  const label = (name: string) => definition.fields.find((field) => field.name === name)?.label ?? name;
  return `${label(time.endField)} (${time.endField}), ${end}, is ${endAt === startAt ? 'the same time as' : 'before'} ${label(time.startField)} (${time.startField}), ${start}; it must be after it.`;
}

const sameInstant = (left: string | undefined, right: string | undefined) =>
  left === right || (left !== undefined && right !== undefined && Date.parse(left) === Date.parse(right));

/**
 * Why a submitted envelope time disagrees with the body's time fields, or undefined when it agrees. The body is the
 * source of truth; a body that leaves its time field empty does not disagree.
 */
export function recordTimeDisagreement(
  definition: OperatorRecordDefinition,
  record: OperatorRecordBody,
  envelope: OperatorRecordEnvelopeTime,
): string | undefined {
  const derived = operatorRecordTime(definition, record);
  const [startField, endField] = timeFieldNames(definition.time);
  if (definition.time.meaning === 'interval') {
    if (!derived.interval) return undefined;
    if (!envelope.interval || !sameInstant(envelope.interval.start, derived.interval.start))
      return `interval.start must equal ${startField}`;
    if (!sameInstant(envelope.interval.end, derived.interval.end))
      return derived.interval.end
        ? `interval.end must equal ${endField}`
        : `interval.end is given but ${endField} is not`;
    return undefined;
  }
  if (envelope.interval) return `${definition.recordType} records take no interval`;
  if (derived.occurredAt && !sameInstant(envelope.occurredAt, derived.occurredAt))
    return `occurredAt must equal ${startField}`;
  return undefined;
}
