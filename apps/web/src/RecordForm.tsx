import { useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import { aboutOwnOrganization, type OperatorRecordCommitResponse } from '@ledger/contracts';
import { Button, Notice } from '@ledger/ui';
import {
  columnFor,
  emptyDraft,
  entryDocument,
  type RecordDraft,
  type RecordField,
  type RecordTypeSummary,
} from './operator-records.js';
import { plainError } from './sms-labels.js';
import { timeZoneLabel, timeZoneName } from './format.js';
import { SubjectPicker } from './SubjectPicker.js';
import { searchableKinds } from './subject-picker.js';
import { OutboxSummary, useOutbox } from './DeviceOutbox.js';
import type { OutboxEntry } from './outbox.js';

/** What a field that only explains a record is for, said where a person enters it. */
const explainsRecord = 'Explains the record to a later reader; it never counts toward a complete record.';

/**
 * One form for every operator record type, generated from its field metadata. A submission is uploaded as a
 * one-record JSON document, so the submitted payload is the retained original, and committed like any import.
 */
export function RecordForm({
  client,
  type,
  sourceId,
  initial,
  replaces,
  onRecorded,
  onCancel,
}: {
  client: LedgerClient;
  type: RecordTypeSummary;
  sourceId: string;
  initial?: RecordDraft;
  replaces?: string;
  onRecorded: (result: OperatorRecordCommitResponse) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<RecordDraft>(() => initial ?? emptyDraft(type));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string[] | null>(null);
  const outbox = useOutbox();
  // A refused entry kept on this device, being corrected here.
  const [revising, setRevising] = useState<OutboxEntry | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const replacing = revising?.content.kind === 'record' ? revising.content.replaces : replaces;
  const id = (name: string) => `record-${type.recordType}-${name}`.replaceAll('.', '-');
  const setValue = (name: string, value: string) =>
    setDraft((previous) => ({ ...previous, values: { ...previous.values, [name]: value } }));

  /** Keeps the entry on this device first, then sends it: it reaches Ledger now, or when the connection returns. */
  async function keepAndSend(entered: RecordDraft, kept: NonNullable<typeof outbox>) {
    const { entry, outcome } = await kept.save(
      (writtenAt) => ({
        kind: 'record',
        title: type.title,
        subject: ownOrganization ? 'your organization' : entered.subjectId.trim(),
        recordType: type.recordType,
        recordVersion: type.recordVersion,
        sourceId,
        document: JSON.stringify(entryDocument(type, entered, replacing, writtenAt), null, 2),
        draft: entered,
        ...(replacing ? { replaces: replacing } : {}),
      }),
      revising ?? undefined,
    );
    if (outcome.kind === 'acknowledged') {
      setRevising(null);
      if (outcome.recorded) onRecorded(outcome.recorded);
    } else if (outcome.kind === 'refused') {
      // Refused while the person is here: the form still holds what they typed, so the device keeps no copy.
      if (!revising) await kept.discard(entry.id);
      setFailure(outcome.reasons);
    } else {
      setRevising(null);
      setDraft(initial ?? emptyDraft(type));
      setKept(outcome.reason);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    setKept(null);
    try {
      // A record about the operator's own organization names no subject id; it is about the Ledger organization.
      const entered = ownOrganization ? { ...draft, subjectId: '' } : draft;
      if (outbox) return await keepAndSend(entered, outbox);
      const bytes = new TextEncoder().encode(JSON.stringify(entryDocument(type, entered, replaces), null, 2));
      const { artifact } = await client.upload(bytes, 'application/json', crypto.randomUUID());
      const result = await client.request<OperatorRecordCommitResponse>('/v1/operator-records/imports', {
        method: 'POST',
        body: JSON.stringify({
          artifactId: artifact.id,
          recordType: type.recordType,
          recordVersion: type.recordVersion,
          sourceId,
        }),
      });
      const row = result.rows[0];
      if (row?.status === 'recorded') onRecorded(result);
      else setFailure(row?.reasons.length ? row.reasons : ['The record was not recorded.']);
    } catch (error) {
      setFailure([plainError(error).message]);
    } finally {
      setPending(false);
    }
  }

  const subjectColumn = type.columns.find((column) => column.key === 'subjectId');
  const ownOrganization = aboutOwnOrganization(type) || draft.subjectKind === 'organization';
  return (
    <form
      className="action-form records-form"
      aria-label={replaces ? `Correct ${type.title}` : `Enter ${type.title}`}
      onSubmit={(event) => void submit(event)}
    >
      <h3>
        {replaces
          ? `Correct this ${type.title.toLowerCase()} record`
          : `Enter ${/^[aeiou]/i.test(type.title) ? 'an' : 'a'} ${type.title.toLowerCase()} record`}
      </h3>
      <p className="records-note">
        {replaces
          ? 'The correction is a new record that names the one it replaces. Nothing is edited in place.'
          : 'Fields marked required count toward a complete record. An incomplete record is still recorded and shown as incomplete.'}
      </p>
      {ownOrganization && <p className="records-note">This record is about your own organization.</p>}
      {type.fields.some((field) => field.kind === 'date_time') && (
        <p className="records-note">Times are entered in your organization’s time zone, {timeZoneName()}.</p>
      )}
      <div className="records-form-grid">
        {subjectColumn && !ownOrganization && (
          <>
            <label htmlFor={id('subjectId')}>
              {subjectColumn.label} <small>{subjectColumn.help}</small>
            </label>
            <SubjectPicker
              client={client}
              sourceId={sourceId}
              id={id('subjectId')}
              kinds={searchableKinds(type.subjectKinds, draft.subjectKind)}
              value={draft.subjectId}
              onChange={(value) => setDraft((previous) => ({ ...previous, subjectId: value }))}
              onChoose={(option) => setDraft((previous) => ({ ...previous, subjectKind: option.kind }))}
              sayNew
              readOnly={Boolean(replaces)}
              required
            />
          </>
        )}
        {type.subjectKinds.length > 1 && (
          <>
            <label htmlFor={id('subjectKind')}>Subject kind</label>
            <select
              id={id('subjectKind')}
              value={draft.subjectKind}
              disabled={Boolean(replaces)}
              onChange={(event) => setDraft({ ...draft, subjectKind: event.target.value })}
              required
            >
              <option value="">Choose</option>
              {type.subjectKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </>
        )}
        {type.secondarySubjectKinds.length > 0 && (
          <>
            <label htmlFor={id('secondarySubjectId')}>
              Related {type.secondarySubjectKinds.join(' or ')} id <small>Optional</small>
            </label>
            <SubjectPicker
              client={client}
              sourceId={sourceId}
              id={id('secondarySubjectId')}
              kinds={searchableKinds(type.secondarySubjectKinds, draft.secondarySubjectKind)}
              value={draft.secondarySubjectId}
              onChange={(value) => setDraft((previous) => ({ ...previous, secondarySubjectId: value }))}
              onChoose={(option) => setDraft((previous) => ({ ...previous, secondarySubjectKind: option.kind }))}
              sayNew
            />
            {type.secondarySubjectKinds.length > 1 && (
              <>
                <label htmlFor={id('secondarySubjectKind')}>Related subject kind</label>
                <select
                  id={id('secondarySubjectKind')}
                  value={draft.secondarySubjectKind}
                  onChange={(event) => setDraft({ ...draft, secondarySubjectKind: event.target.value })}
                >
                  <option value="">Choose</option>
                  {type.secondarySubjectKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </>
            )}
          </>
        )}
        {type.fields.map((field) => (
          <FieldInput
            key={field.name}
            client={client}
            sourceId={sourceId}
            id={id(field.name)}
            field={field}
            type={type}
            value={draft.values[field.name] ?? ''}
            unit={draft.units[field.name]}
            onChange={(value) => setValue(field.name, value)}
            onUnit={(unit) =>
              setDraft((previous) => ({ ...previous, units: { ...previous.units, [field.name]: unit } }))
            }
          />
        ))}
      </div>
      {kept && (
        <Notice tone="neutral" title="Kept on this device">
          {kept} The entry is kept on this device and sent under your sign-in when Ledger can take it.
        </Notice>
      )}
      {failure && (
        <Notice tone="alert" title="Not recorded">
          <ul className="records-reasons">
            {failure.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="records-actions">
        <Button kind="primary" type="submit" disabled={pending}>
          {pending ? 'Recording…' : replaces ? 'Record correction' : 'Record entry'}
        </Button>
        {onCancel && (
          <Button type="button" kind="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <OutboxSummary
        kind="record"
        onCorrect={(entry) => {
          if (entry.content.kind !== 'record') return;
          setKept(null);
          if (entry.content.recordType !== type.recordType || entry.content.recordVersion !== type.recordVersion)
            return setFailure([`Choose ${entry.content.title} as the record type to correct this entry.`]);
          setFailure(entry.state.status === 'refused' ? entry.state.reasons : null);
          setDraft(entry.content.draft);
          setRevising(entry);
        }}
      />
    </form>
  );
}

function FieldInput({
  client,
  sourceId,
  id,
  field,
  type,
  value,
  unit,
  onChange,
  onUnit,
}: {
  client: LedgerClient;
  sourceId: string;
  id: string;
  field: RecordField;
  type: RecordTypeSummary;
  value: string;
  unit?: string;
  onChange: (value: string) => void;
  onUnit: (unit: string) => void;
}) {
  const label = (
    <label htmlFor={id}>
      {field.label}
      {field.kind === 'date_time' ? ` (${timeZoneLabel()})` : ''}{' '}
      <small>{field.required ? 'Required' : 'Optional'}</small>
      {field.help && <small className="records-help">{field.help}</small>}
      {field.replayOnly && <small className="records-help">{explainsRecord}</small>}
    </label>
  );
  const change = (event: { target: { value: string } }) => onChange(event.target.value);
  switch (field.kind) {
    case 'long_text':
      return (
        <>
          {label}
          <textarea id={id} rows={3} value={value} onChange={change} maxLength={10_000} />
        </>
      );
    case 'boolean':
      return (
        <>
          {label}
          <select id={id} value={value} onChange={change}>
            <option value="">Not recorded</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </>
      );
    case 'select':
      return (
        <>
          {label}
          <select id={id} value={value} onChange={change}>
            <option value="">Not recorded</option>
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      );
    case 'date':
      return (
        <>
          {label}
          <input id={id} type="date" value={value} onChange={change} />
        </>
      );
    case 'date_time':
      return (
        <>
          {label}
          <input id={id} type="datetime-local" step={1} value={value} onChange={change} />
        </>
      );
    case 'number': {
      const units = columnFor(type, field.name)?.units;
      return (
        <>
          {label}
          <span className="records-number">
            <input id={id} type="number" step="any" value={value} onChange={change} />
            {units && units.accepted.length > 1 ? (
              <select
                aria-label={`${field.label} unit`}
                value={unit ?? units.stored}
                onChange={(event) => onUnit(event.target.value)}
              >
                {units.accepted.map((option) => (
                  <option key={option.unit} value={option.unit}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="records-unit">{units?.accepted[0]?.label}</span>
            )}
          </span>
          {units && unit && unit !== units.stored && value && (
            <small className="records-help">
              Recorded in {units.accepted[0]!.label}: {value} {unit} ×{' '}
              {units.accepted.find((option) => option.unit === unit)?.factor}
            </small>
          )}
        </>
      );
    }
    case 'reference': {
      const placeholder = `Your id for the ${field.referenceKind?.replace('_', ' ')}`;
      const kinds = searchableKinds(field.referenceKind ? [field.referenceKind] : []);
      return (
        <>
          {label}
          {kinds.length ? (
            <SubjectPicker
              client={client}
              sourceId={sourceId}
              id={id}
              kinds={kinds}
              value={value}
              onChange={onChange}
              sayNew
              placeholder={placeholder}
            />
          ) : (
            <input id={id} value={value} onChange={change} maxLength={200} placeholder={placeholder} />
          )}
        </>
      );
    }
    default:
      return (
        <>
          {label}
          <input id={id} value={value} onChange={change} maxLength={1000} />
        </>
      );
  }
}
