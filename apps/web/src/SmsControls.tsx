import { useState, type FormEvent, type ReactNode } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { OccurrenceEvaluation } from './occurrence-location.js';
import type {
  ControlBody,
  ControlParameterChoice,
  ControlTypeDefinition,
  ObservationTypeChoice,
  SmsBasis,
  SmsHazardControl,
  SmsHomeResponse,
  SmsLinkedRecord,
  SmsRecordDetailResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { ControlIndicators } from './ControlIndicators.js';
import { json, timeZoneLabel } from './format.js';
import { centralDateTimeInput, documentTime, fromCentralDateTimeInput } from './sms-document-dates.js';
import { statusPresentation } from './sms-labels.js';
import { FailureNotice, useCommand } from './SmsForms.js';

/** What an editor may show beside the parameters: for a hazard from a flight finding, that flight and evaluation. */
export interface ControlEditorContext {
  client: LedgerClient;
  flightId?: string;
  evaluation?: OccurrenceEvaluation;
}

/** A screen for a control type's parameters. Without one, the form is generated from the type's parameter schema. */
export type ControlEditor = (props: {
  type: ControlTypeDefinition;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  context?: ControlEditorContext;
  /** The registered observation types a parameter may name, by title, with their titled numeric fields. */
  observationTypes?: readonly ObservationTypeChoice[];
}) => ReactNode;

/** Special editors by `${id}@${version}`. Control types register theirs here; none is built in. */
export const controlEditors: Record<string, ControlEditor> = {};

const typeKey = (type: { id: string; version: number }) => `${type.id}@${type.version}`;

interface PropertySchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  maxLength?: number;
}

/** The properties a generated form can show, or null when the schema needs a special editor or raw JSON. */
function generatedFields(schema: Record<string, unknown>): [string, PropertySchema, boolean][] | null {
  const properties = schema.properties as Record<string, PropertySchema> | undefined;
  if (schema.type !== 'object' || !properties) return null;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const fields = Object.entries(properties).map(([name, property]) => [name, property, required.has(name)] as const);
  const supported = fields.every(
    ([, property]) =>
      Array.isArray(property.enum) || ['string', 'number', 'integer', 'boolean'].includes(String(property.type)),
  );
  return supported ? fields.map((field) => [...field]) : null;
}

const observationKey = (choice: { type: string; version: number }) => `${choice.type}@${choice.version}`;

/** A parameter the person picks from registered observation types or their numeric fields, by title. */
function ChoiceParameter({
  id,
  name,
  choice,
  value,
  observationTypes,
  onChange,
}: {
  id: string;
  name: string;
  choice: ControlParameterChoice;
  value: Record<string, unknown>;
  observationTypes: readonly ObservationTypeChoice[];
  onChange: (value: Record<string, unknown>) => void;
}) {
  if (choice.from === 'observation_type') {
    const offered = observationTypes.filter((entry) => entry.numericFields.length > 0);
    const current =
      typeof value[name] === 'string' && typeof value[choice.versionParameter] === 'number'
        ? observationKey({ type: value[name] as string, version: value[choice.versionParameter] as number })
        : '';
    const versions = (type: string) => offered.filter((entry) => entry.type === type).length;
    return (
      <select
        id={id}
        value={current}
        onChange={(event) => {
          const picked = offered.find((entry) => observationKey(entry) === event.target.value);
          // A field chosen for the earlier type is not a field of this one.
          const next = Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== name && key !== choice.versionParameter),
          );
          onChange(picked ? { ...next, [name]: picked.type, [choice.versionParameter]: picked.version } : next);
        }}
      >
        <option value="">Choose</option>
        {current && !offered.some((entry) => observationKey(entry) === current) && (
          <option value={current}>{current}</option>
        )}
        {offered.map((entry) => (
          <option key={observationKey(entry)} value={observationKey(entry)} title={observationKey(entry)}>
            {entry.title}
            {versions(entry.type) > 1 ? ` · version ${entry.version}` : ''}
          </option>
        ))}
      </select>
    );
  }
  const type = observationTypes.find(
    (entry) => entry.type === value[choice.typeParameter] && entry.version === value[choice.versionParameter],
  );
  const current = typeof value[name] === 'string' ? (value[name] as string) : '';
  const fields = type?.numericFields ?? [];
  return (
    <select
      id={id}
      value={current}
      disabled={!type}
      onChange={(event) => {
        const next = { ...value };
        if (event.target.value) next[name] = event.target.value;
        else delete next[name];
        onChange(next);
      }}
    >
      <option value="">{type ? 'Choose' : 'Choose an observation type first'}</option>
      {current && !fields.some((field) => field.field === current) && <option value={current}>{current}</option>}
      {fields.map((field) => (
        <option key={field.field} value={field.field} title={field.field}>
          {field.title}
        </option>
      ))}
    </select>
  );
}

/** The parameters a choice sets on its own, such as the version that comes with a chosen observation type. */
function governedParameters(choices: Readonly<Record<string, ControlParameterChoice>>): Set<string> {
  return new Set(
    Object.values(choices).flatMap((choice) => (choice.from === 'observation_type' ? [choice.versionParameter] : [])),
  );
}

function GeneratedParameters({ type, value, onChange, observationTypes }: Parameters<ControlEditor>[0]) {
  const fields = generatedFields(type.parameterSchema);
  const choices = observationTypes?.length ? (type.parameterChoices ?? {}) : {};
  const governed = governedParameters(choices);
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  if (!fields)
    return (
      <>
        <label htmlFor="control-parameters">Parameters (JSON)</label>
        <textarea
          id="control-parameters"
          rows={6}
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value);
            try {
              onChange(JSON.parse(event.target.value) as Record<string, unknown>);
            } catch {
              // Kept as typed; Ledger refuses parameters that do not match the type.
            }
          }}
        />
      </>
    );
  const set = (name: string, next: unknown) => {
    const copy = { ...value };
    if (next === '' || next === undefined) delete copy[name];
    else copy[name] = next;
    onChange(copy);
  };
  return (
    <>
      {fields.map(([name, property, required]) => {
        const id = `control-parameter-${name}`;
        const label = `${property.title ?? name}${required ? '' : ' (optional)'}`;
        const current = value[name];
        if (governed.has(name)) return null;
        const choice = choices[name];
        if (choice)
          return (
            <div key={name} className="sms-control-row">
              <label htmlFor={id}>{label}</label>
              <ChoiceParameter
                id={id}
                name={name}
                choice={choice}
                value={value}
                observationTypes={observationTypes ?? []}
                onChange={onChange}
              />
            </div>
          );
        if (property.type === 'boolean')
          return (
            <label key={name} className="sms-check">
              <input type="checkbox" checked={current === true} onChange={(event) => set(name, event.target.checked)} />
              {label}
            </label>
          );
        const control = Array.isArray(property.enum) ? (
          <select id={id} value={String(current ?? '')} onChange={(event) => set(name, event.target.value)}>
            <option value="">Choose</option>
            {property.enum.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
        ) : property.type === 'number' || property.type === 'integer' ? (
          <input
            id={id}
            type="number"
            step={property.type === 'integer' ? 1 : 'any'}
            value={current === undefined ? '' : String(current)}
            onChange={(event) => set(name, event.target.value === '' ? '' : Number(event.target.value))}
            required={required}
          />
        ) : (property.maxLength ?? 1000) > 200 ? (
          <textarea
            id={id}
            rows={3}
            value={String(current ?? '')}
            onChange={(event) => set(name, event.target.value)}
            required={required}
          />
        ) : (
          <input id={id} value={String(current ?? '')} onChange={(event) => set(name, event.target.value)} />
        );
        return (
          <div key={name} className="sms-control-row">
            <label htmlFor={id}>
              {label}
              {property.description && <small className="records-help">{property.description}</small>}
            </label>
            {control}
          </div>
        );
      })}
    </>
  );
}

/** Text fields are trimmed and blank optional ones dropped, so a generated form sends only what was filled in. */
function cleanParameters(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([name, entry]) => [name, typeof entry === 'string' ? entry.trim() : entry] as const)
      .filter(([, entry]) => entry !== ''),
  );
}

/**
 * Proposes a control on a hazard, or records a new version of one. The form is chosen by the control type: its
 * special editor if it has one, otherwise a form generated from its parameter schema.
 */
export function ControlForm({
  client,
  detail,
  home,
  context,
  onRecorded,
}: {
  client: LedgerClient;
  /** The hazard to propose a control on, or the control to revise. */
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  context?: ControlEditorContext;
  onRecorded: () => void;
}) {
  const revising = detail.record.kind === 'control';
  const existing = revising ? (detail.current.body as ControlBody) : undefined;
  const types = detail.controlTypes ?? [];
  const [basis] = useState<SmsBasis>(detail.basis);
  const [typeChoice, setTypeChoice] = useState(() =>
    existing ? typeKey(existing.controlType) : types[0] ? typeKey(types[0]) : '',
  );
  const [title, setTitle] = useState(revising ? detail.current.title : '');
  const [ownerId, setOwnerId] = useState(detail.record.owner.id);
  const [parameters, setParameters] = useState<Record<string, unknown>>(existing?.parameters ?? {});
  const [effectiveFrom, setEffectiveFrom] = useState(
    centralDateTimeInput(existing?.effectiveFrom ?? new Date().toISOString()),
  );
  const [effectiveUntil, setEffectiveUntil] = useState(
    existing?.effectiveUntil ? centralDateTimeInput(existing.effectiveUntil) : '',
  );
  const command = useCommand(client);
  const type = types.find((entry) => typeKey(entry) === typeChoice);
  if (!types.length)
    return (
      <Notice tone="neutral" title="No control types">
        No control types are registered, so no control can be proposed yet.
      </Notice>
    );
  const Editor = type ? (controlEditors[typeKey(type)] ?? GeneratedParameters) : undefined;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!type) return;
    const record = {
      kind: 'control' as const,
      schema: 'sms.control.1' as const,
      title: title.trim(),
      ownerId,
      ...(revising && detail.current.links.length ? { links: detail.current.links } : {}),
      body: {
        hazardId: existing?.hazardId ?? detail.record.id,
        controlType: { id: type.id, version: type.version, digest: type.digest },
        parameters: cleanParameters(parameters),
        effectiveFrom: fromCentralDateTimeInput(effectiveFrom),
        ...(effectiveUntil ? { effectiveUntil: fromCentralDateTimeInput(effectiveUntil) } : {}),
      },
    };
    const result = await command.submit(
      revising
        ? { kind: 'sms.record.revise', recordId: detail.record.id, expectedRevision: basis.revision, record }
        : { kind: 'sms.record.open', record },
    );
    if (result) onRecorded();
  }
  return (
    <form
      className="action-form safety-form"
      onSubmit={(event) => void save(event)}
      aria-label={revising ? 'Edit control' : 'Propose a control'}
    >
      <h3>{revising ? 'Edit control' : 'Propose a control'}</h3>
      <label htmlFor="control-type">Control type</label>
      <select
        id="control-type"
        value={typeChoice}
        disabled={revising}
        onChange={(event) => {
          setTypeChoice(event.target.value);
          setParameters({});
        }}
      >
        {types.map((entry) => (
          <option key={typeKey(entry)} value={typeKey(entry)} title={entry.description}>
            {entry.title}
          </option>
        ))}
      </select>
      {type && (
        <p className="safety-form-note">
          {type.description} {type.checkedAutomatically ? 'Ledger can check it from records.' : 'A person checks it.'}
        </p>
      )}
      <label htmlFor="control-title">Control</label>
      <input id="control-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      {type && Editor && (
        <Editor
          key={typeKey(type)}
          type={type}
          value={parameters}
          onChange={setParameters}
          context={context}
          observationTypes={detail.observationTypes}
        />
      )}
      <div className="safety-form-grid">
        <label>
          Owner
          <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
            {home.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          In effect from ({timeZoneLabel()})
          <input
            type="datetime-local"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            required
          />
        </label>
        <label>
          Until ({timeZoneLabel()}, optional)
          <input
            type="datetime-local"
            value={effectiveUntil}
            onChange={(event) => setEffectiveUntil(event.target.value)}
          />
        </label>
      </div>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending || !title.trim()}>
        {command.pending ? 'Recording…' : revising ? 'Record new version' : 'Propose control'}
      </Button>
    </form>
  );
}

function interval(control: { effectiveFrom: string; effectiveUntil?: string | null }): string {
  const from = documentTime(control.effectiveFrom);
  return control.effectiveUntil ? `${from} to ${documentTime(control.effectiveUntil)}` : `From ${from}`;
}

const asLinked = (control: SmsHazardControl): SmsLinkedRecord => ({
  id: control.id,
  kind: 'control',
  title: control.title,
  status: control.status,
  confidentiality: 'ordinary',
});

/** The controls proposed on a hazard, each marked when the latest risk acceptance binds its current version. */
export function HazardControlsSection({
  detail,
  onOpen,
}: {
  detail: SmsRecordDetailResponse;
  onOpen: (record: SmsLinkedRecord) => void;
}) {
  const controls = detail.controls ?? [];
  return (
    <section className="safety-section" data-testid="sms-hazard-controls">
      <h3>Controls</h3>
      {controls.length === 0 ? (
        <p className="muted">No controls proposed yet.</p>
      ) : (
        <ul className="sms-control-list">
          {controls.map((control) => {
            const status = control.accepted
              ? { label: 'Accepted with the risk', tone: 'planned' as const }
              : statusPresentation(control.status);
            return (
              <li key={control.id}>
                <Badge>{control.controlType.title ?? control.controlType.id}</Badge>{' '}
                <Button kind="quiet" onClick={() => onOpen(asLinked(control))}>
                  {control.title}
                </Button>{' '}
                <Badge tone={status.tone}>{status.label}</Badge>
                <div className="muted">
                  {control.wording ?? control.description ?? 'This control type is not registered here.'} ·{' '}
                  {interval(control)} · Owner {control.owner.name} · Version {control.versionNumber}
                </div>
                {control.wording && control.description && control.wording !== control.description && (
                  <details className="sms-control-names" data-testid="control-recorded-names">
                    <summary>Names as recorded</summary>
                    <p className="mono">{control.description}</p>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A control record's own page. */
export function ControlSections({
  client,
  detail,
  onOpen,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  onOpen: (record: SmsLinkedRecord) => void;
}) {
  const body = detail.current.body as ControlBody;
  const type = detail.controlTypes?.find(
    (entry) => entry.id === body.controlType.id && entry.version === body.controlType.version,
  );
  return (
    <section className="safety-section">
      <h3>Control</h3>
      <dl className="safety-facts">
        <div>
          <dt>Hazard</dt>
          <dd>
            <Button
              kind="quiet"
              onClick={() =>
                onOpen({ id: body.hazardId, kind: 'hazard', title: 'Hazard', status: '', confidentiality: 'ordinary' })
              }
            >
              Open the hazard
            </Button>
          </dd>
        </div>
        <div>
          <dt>Control type</dt>
          <dd>
            {type
              ? `${type.title}, version ${type.version}`
              : `${body.controlType.id}, version ${body.controlType.version}`}
            {type && (type.checkedAutomatically ? ' · Ledger can check it from records' : ' · A person checks it')}
          </dd>
        </div>
        <div>
          <dt>In effect</dt>
          <dd>{interval(body)}</dd>
        </div>
      </dl>
      <details className="safety-history">
        <summary>Parameters</summary>
        <pre>{json(body.parameters)}</pre>
      </details>
      {body.hazardId && (
        <ControlIndicators
          client={client}
          query={{
            controlKind: 'control_record',
            hazardId: body.hazardId,
            controlId: detail.record.id,
            controlVersion: String(detail.current.versionNumber),
          }}
        />
      )}
    </section>
  );
}
