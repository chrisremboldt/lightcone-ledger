import {
  LOCAL_TIME_MARK,
  zonedWallTime,
  type OperatorRecordTypeSummary,
  type OperatorRecordView,
  type Principal,
} from '@ledger/contracts';
import { time, timeZone, timeZoneLabel } from './format.js';

/** Helpers for the Records area. They read only a record type's field metadata, never a record type by name. */

export type RecordTypeSummary = OperatorRecordTypeSummary;
export type RecordField = RecordTypeSummary['fields'][number];
export type RecordColumn = RecordTypeSummary['columns'][number];

export interface RecordDraft {
  subjectId: string;
  subjectKind: string;
  secondarySubjectId: string;
  secondarySubjectKind: string;
  values: Record<string, string>;
  units: Record<string, string>;
}

export const typeKey = (type: Pick<RecordTypeSummary, 'recordType' | 'recordVersion'>) =>
  `${type.recordType}@${type.recordVersion}`;

export function canKeepRecords(principal: Principal | null, sourceId: string): boolean {
  return Boolean(
    principal?.capabilities.includes('input:write') &&
    principal.observationGrants?.some(
      (grant) => grant.sourceId === sourceId && grant.observationType === 'operator.record',
    ),
  );
}

export function columnFor(type: RecordTypeSummary, field: string): RecordColumn | undefined {
  return type.columns.find((column) => column.field === field);
}

export function emptyDraft(type: RecordTypeSummary): RecordDraft {
  return {
    subjectId: '',
    subjectKind: type.subjectKinds.length === 1 ? type.subjectKinds[0]! : '',
    secondarySubjectId: '',
    secondarySubjectKind: type.secondarySubjectKinds.length === 1 ? type.secondarySubjectKinds[0]! : '',
    values: {},
    units: Object.fromEntries(
      type.columns.filter((column) => column.units).map((column) => [column.field!, column.units!.stored]),
    ),
  };
}

/**
 * A recorded UTC time as the form's datetime-local input shows it: the organization's wall-clock time. The form says
 * which zone, and submits the time under a [local] column, so the import reads it in the same zone.
 */
export const localInputValue = (value: string, zone: string = timeZone()) => zonedWallTime(value, zone) ?? value;

function draftValue(field: RecordField, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (field.kind === 'boolean') return value ? 'yes' : 'no';
  if (field.kind === 'date_time') return localInputValue(String(value));
  if (field.kind === 'reference') return String((value as { id?: unknown }).id ?? '');
  return String(value);
}

/** A correction starts from the record it replaces, in stored units. */
export function draftFromRecord(type: RecordTypeSummary, record: OperatorRecordView): RecordDraft {
  const draft = emptyDraft(type);
  return {
    ...draft,
    subjectId: record.subject.id,
    subjectKind: record.subject.kind,
    secondarySubjectId: record.secondarySubject?.id ?? '',
    secondarySubjectKind: record.secondarySubject?.kind ?? draft.secondarySubjectKind,
    values: Object.fromEntries(
      type.fields
        .map((field) => [field.name, draftValue(field, record.record[field.name])] as const)
        .filter(([, value]) => value !== ''),
    ),
  };
}

function entryValue(field: RecordField, value: string): unknown {
  if (field.kind === 'number') return Number.isFinite(Number(value)) && value.trim() !== '' ? Number(value) : value;
  if (field.kind === 'boolean') return value === 'yes';
  return value.trim();
}

/** The one-record JSON document a form submits; it is retained as the original bytes of the entry. */
export function entryDocument(type: RecordTypeSummary, draft: RecordDraft, replaces?: string) {
  const record: Record<string, unknown> = { subjectId: draft.subjectId.trim() };
  if (type.subjectKinds.length > 1) record.subjectKind = draft.subjectKind;
  if (draft.secondarySubjectId.trim()) {
    record.secondarySubjectId = draft.secondarySubjectId.trim();
    if (type.secondarySubjectKinds.length > 1) record.secondarySubjectKind = draft.secondarySubjectKind;
  }
  for (const field of type.fields) {
    const value = draft.values[field.name] ?? '';
    if (!value.trim()) continue;
    const units = columnFor(type, field.name)?.units;
    const unit = draft.units[field.name];
    const key =
      field.kind === 'date_time'
        ? `${field.name} [${LOCAL_TIME_MARK}]`
        : units && unit && unit !== units.stored
          ? `${units.stem} [${unit}]`
          : field.name;
    record[key] = entryValue(field, value);
  }
  if (replaces) record.replaces = replaces;
  return { recordType: type.recordType, recordVersion: type.recordVersion, records: [record] };
}

const optionLabel = (field: RecordField, value: unknown) =>
  field.options?.find((option) => option.value === value)?.label ?? String(value);

/** A field's value as a person reads it; a time placed by a date alone (dayOnly) is shown as that date. */
export function displayValue(field: RecordField, value: unknown, unitLabel?: string, day?: string): string {
  if (value === undefined || value === null || value === '') return '—';
  switch (field.kind) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'select':
      return optionLabel(field, value);
    case 'number':
      return `${value}${unitLabel ? ` ${unitLabel}` : ''}`;
    case 'reference': {
      const reference = value as { id?: string; scope?: string };
      return reference.scope === 'ledger' ? `${reference.id} (Ledger id)` : String(reference.id);
    }
    case 'date_time':
      return day ? `${day} (date only)` : `${time(String(value), true)} ${timeZoneLabel()}`;
    default:
      return String(value);
  }
}

/** A short line naming a record: its first two required fields that have values. */
export function recordHeadline(type: RecordTypeSummary, record: Record<string, unknown>): string {
  const shown = type.fields
    .filter((field) => field.required && record[field.name] !== undefined && field.kind !== 'long_text')
    .slice(0, 2)
    .map((field) => displayValue(field, record[field.name], columnFor(type, field.name)?.units?.stored));
  return shown.join(' · ') || type.title;
}

/** The original bytes a record came from, narrowed to its row or JSON record when the locator says where. */
export function originalExcerpt(bytes: Uint8Array, locator: OperatorRecordView['origin']['locator']): string {
  const text = new TextDecoder();
  if (locator?.kind === 'byte_range')
    return text.decode(
      bytes.subarray(locator.value.offsetBytes, locator.value.offsetBytes + locator.value.lengthBytes),
    );
  const whole = text.decode(bytes);
  if (locator?.kind !== 'json_pointer') return whole;
  try {
    let value: unknown = JSON.parse(whole);
    for (const part of locator.value.split('/').slice(1))
      value = (value as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    return JSON.stringify(value, null, 2);
  } catch {
    return whole;
  }
}
