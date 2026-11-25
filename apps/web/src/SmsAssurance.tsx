import { useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  assuranceTypes,
  assuranceTypeValues,
  type AssuranceBody,
  type AssuranceItemRef,
  type AssuranceType,
  type AssuranceTypeField,
  type Principal,
  type SmsAssuranceActionView,
  type SmsHomeResponse,
  type SmsLinkedRecord,
  type SmsRecordDetailResponse,
  type SmsRecordSummary,
  type SmsRegisterResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { ctDay, time, timeZoneLabel } from './format.js';
import {
  assuranceDraft,
  assuranceFieldsAsked,
  assuranceFormFrom,
  emptyAssuranceForm,
  nextItemId,
  type AssuranceFormState,
} from './assurance-form.js';
import { FailureNotice, useCommand } from './SmsForms.js';
import { RecordRow } from './SmsHazards.js';
import { RegisterMore, RegisterTools, useRegisterList } from './SmsRegisterTools.js';
import { narrowed, registerCount, useRegisterQuery } from './sms-register-query.js';

// Safety assurance records (docs/design/assurance-records.md): audits, evaluations, investigations, reviews, change
// assessments and hazard notices, with the actions they set.

export function assuranceTypeLabel(type: AssuranceType): string {
  return assuranceTypes[type].title;
}

const fieldLabels: Record<AssuranceTypeField, string> = {
  occurredOn: 'When the occurrence happened',
  fromReport: 'Safety report it started from (optional)',
  system: 'The system or change described',
  counterpart: 'The other organization',
};

const today = () => ctDay(Date.now());

/** Every safety assurance record, newest first, with the form to record one beside it. */
const assuranceStatuses = [
  { value: 'draft', label: 'Draft, not signed' },
  { value: 'signed', label: 'Signed' },
];
const assuranceTypeChoices = assuranceTypeValues.map((value) => ({ value, label: assuranceTypeLabel(value) }));

export function AssuranceRegister({
  register,
  home,
  principal,
  client,
  reports,
  onOpen,
  onChanged,
}: {
  register: SmsRegisterResponse;
  home: SmsHomeResponse;
  principal: Principal;
  client: LedgerClient;
  reports: SmsRecordSummary[];
  onOpen: (record: Pick<SmsRecordSummary, 'id' | 'kind'>) => void;
  onChanged: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [query, setQuery] = useRegisterQuery();
  const list = useRegisterList(client, 'assurance', register, query);
  const records = list.records ?? [];
  const mayWrite = principal.capabilities.includes('sms:write');
  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main">
        <p className="thread-crumbs">Safety / Safety assurance</p>
        <div className="thread-title">
          <h2>Safety assurance</h2>
          <Badge>{list.records ? registerCount(records.length, Boolean(list.more), query) : '…'}</Badge>
        </div>
        <p className="safety-intro">
          Audits, evaluations of the safety program, investigations, reviews of safety performance by the accountable
          executive, assessments of new or changed systems, and hazard notices sent or received. Each says what it
          covered, what it looked at, what it found and the actions it set. A person with the authority to adopt safety
          documentation signs each version; signing sets its actions.
        </p>
        {!recording && (register.records.length > 0 || narrowed(query)) && (
          <RegisterTools
            noun="safety assurance records"
            query={query}
            onQuery={setQuery}
            searchLabel="Title or reference"
            searchHint="Search finds a record by its title or your reference for it."
            statuses={assuranceStatuses}
            types={assuranceTypeChoices}
            orders={['newest', 'oldest']}
          />
        )}
        {recording && mayWrite ? (
          <AssuranceForm
            client={client}
            home={home}
            principal={principal}
            reports={reports}
            onRecorded={(id) => {
              setRecording(false);
              onChanged();
              onOpen({ id, kind: 'assurance' });
            }}
            onCancel={() => setRecording(false)}
          />
        ) : !list.records ? (
          <Spinner label="Reading safety assurance records" />
        ) : records.length === 0 && narrowed(query) ? (
          <p className="sms-empty">No safety assurance records match. Try other words, another state or type.</p>
        ) : records.length === 0 ? (
          <div className="safety-empty">
            <h3>No safety assurance record yet</h3>
            <p>Nothing is on file until a person records one and it is signed.</p>
          </div>
        ) : (
          <div className="hazard-register" aria-label="Safety assurance records">
            {records.map((record) => (
              <RecordRow key={record.id} record={record} stage={assuranceStage(record)} onOpen={() => onOpen(record)} />
            ))}
          </div>
        )}
        {!recording && <RegisterMore label="More safety assurance records" list={list} />}
      </div>
      <aside className="rail safety-rail" aria-label="Safety assurance actions">
        <section className="safety-next-action sms-next-step">
          <span className="safety-stage-label">Record</span>
          {mayWrite ? (
            <>
              <p>Record an audit, a review, an investigation or another safety assurance activity.</p>
              <Button kind="next" aria-expanded={recording} onClick={() => setRecording(!recording)}>
                Record a safety assurance record
              </Button>
            </>
          ) : (
            <p className="rail-muted">Recording one needs permission to edit safety records.</p>
          )}
        </section>
      </aside>
    </div>
  );
}

/** How a register row reads: the type, whether it is signed, and its open and overdue actions. */
function assuranceStage(record: SmsRecordSummary): string {
  const assurance = record.assurance;
  const signed = record.status === 'signed' ? 'Signed' : 'Draft, not signed';
  if (!assurance) return signed;
  const actions = assurance.openActions
    ? ` · ${assurance.openActions} open ${assurance.openActions === 1 ? 'action' : 'actions'}${assurance.overdueActions ? `, ${assurance.overdueActions} overdue` : ''}`
    : '';
  return `${assuranceTypeLabel(assurance.assuranceType)} · ${signed}${actions}`;
}

/** Opens a safety assurance record, or records a new version of one. The type selects the fields it asks for. */
export function AssuranceForm({
  client,
  home,
  principal,
  reports = [],
  revising,
  onRecorded,
  onCancel,
}: {
  client: LedgerClient;
  home: SmsHomeResponse;
  principal: Principal;
  reports?: SmsRecordSummary[];
  revising?: SmsRecordDetailResponse;
  onRecorded: (id: string) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<AssuranceFormState>(() =>
    revising ? assuranceFormFrom(revising.current.title, revising.current.body as AssuranceBody) : emptyAssuranceForm(),
  );
  const [basis] = useState(revising?.basis);
  const [shown, setShown] = useState(false);
  const command = useCommand(client);
  const draft = assuranceDraft(state, today());
  const owners = home.people.filter((person) => person.writes || person.id === principal.id);
  const set = <K extends keyof AssuranceFormState>(field: K, value: AssuranceFormState[K]) =>
    setState((previous) => ({ ...previous, [field]: value }));
  const text = (field: keyof AssuranceFormState) => (event: { target: { value: string } }) =>
    set(field, event.target.value as never);
  const closed = new Set(
    (revising?.assurance?.actions ?? []).filter((action) => action.state === 'closed').map((action) => action.id),
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (draft.problems.length) return;
    const record = {
      kind: 'assurance' as const,
      schema: 'sms.assurance.1' as const,
      title: draft.title,
      ownerId: revising?.record.owner.id ?? principal.id,
      ...(revising?.current.links.length ? { links: revising.current.links } : {}),
      body: draft.body,
    };
    const result = await command.submit(
      revising && basis
        ? { kind: 'sms.record.revise', recordId: revising.record.id, expectedRevision: basis.revision, record }
        : { kind: 'sms.record.open', record },
    );
    if (result?.command.subject) onRecorded(result.command.subject.id);
  }

  return (
    <form
      className="action-form safety-form assurance-form"
      onSubmit={(event) => void save(event)}
      aria-label={revising ? 'Revise the safety assurance record' : 'Record a safety assurance record'}
    >
      <h3>{revising ? 'Record a new version' : 'Record a safety assurance record'}</h3>
      <label htmlFor="assurance-type">Kind of record</label>
      <select
        id="assurance-type"
        value={state.assuranceType}
        disabled={Boolean(revising)}
        onChange={(event) => set('assuranceType', event.target.value as AssuranceType)}
      >
        {assuranceTypeValues.map((type) => (
          <option key={type} value={type}>
            {assuranceTypeLabel(type)}
          </option>
        ))}
      </select>
      {revising && <p className="safety-form-note">A record keeps the kind it was opened with.</p>}
      <label htmlFor="assurance-title">Title</label>
      <input id="assurance-title" value={state.title} onChange={text('title')} maxLength={200} required />
      <div className="safety-form-grid">
        <label>
          Performed on
          <input type="date" value={state.performedOn} max={today()} onChange={text('performedOn')} required />
        </label>
        <label>
          Completed on (optional)
          <input type="date" value={state.completedOn} max={today()} onChange={text('completedOn')} />
        </label>
      </div>
      {assuranceFieldsAsked(state.assuranceType).map(({ field }) =>
        field === 'occurredOn' ? (
          <label key={field}>
            {fieldLabels[field]}
            <input type="date" value={state.occurredOn} max={today()} onChange={text('occurredOn')} />
          </label>
        ) : field === 'fromReport' ? (
          <label key={field}>
            {fieldLabels[field]}
            <select value={state.fromReport} onChange={text('fromReport')}>
              <option value="">Not from a safety report</option>
              {reports.map((report) => (
                <option key={report.id} value={report.id}>
                  {report.title}
                </option>
              ))}
              {state.fromReport && !reports.some((report) => report.id === state.fromReport) && (
                <option value={state.fromReport}>The linked safety report</option>
              )}
            </select>
            <small className="safety-form-note">
              Linked, never copied: people who cannot read safety reports can still read this record.
            </small>
          </label>
        ) : (
          <label key={field}>
            {fieldLabels[field]}
            <input value={state[field]} onChange={text(field)} maxLength={field === 'counterpart' ? 200 : 2000} />
          </label>
        ),
      )}
      <label htmlFor="assurance-scope">What it covered</label>
      <textarea id="assurance-scope" rows={2} value={state.scope} onChange={text('scope')} required />
      <label htmlFor="assurance-examined">What it looked at</label>
      <textarea id="assurance-examined" rows={3} value={state.examined} onChange={text('examined')} required />

      <fieldset className="assurance-items">
        <legend>What it found</legend>
        {state.findings.length === 0 && <p className="safety-form-note">No findings. An audit can find nothing.</p>}
        {state.findings.map((finding, index) => (
          <div key={finding.id} className="assurance-item">
            <label>
              Finding {finding.id}
              <textarea
                rows={2}
                value={finding.text}
                onChange={(event) =>
                  set(
                    'findings',
                    state.findings.map((row, at) => (at === index ? { ...row, text: event.target.value } : row)),
                  )
                }
              />
            </label>
            <Button
              type="button"
              kind="quiet"
              onClick={() =>
                set(
                  'findings',
                  state.findings.filter((_, at) => at !== index),
                )
              }
            >
              Remove finding {finding.id}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          kind="quiet"
          onClick={() => set('findings', [...state.findings, { id: nextItemId('F', state.findings), text: '' }])}
        >
          Add a finding
        </Button>
      </fieldset>

      <fieldset className="assurance-items">
        <legend>Actions it sets</legend>
        <p className="safety-form-note">
          Each action has what is to be done, an owner and a due date. Actions are set when this version is signed.
        </p>
        {state.actions.map((action, index) => {
          const locked = closed.has(action.id);
          const change = (patch: Partial<typeof action>) =>
            set(
              'actions',
              state.actions.map((row, at) => (at === index ? { ...row, ...patch } : row)),
            );
          return (
            <div key={action.id} className="assurance-item">
              <label>
                Action {action.id}
                <textarea
                  rows={2}
                  value={action.what}
                  disabled={locked}
                  onChange={(event) => change({ what: event.target.value })}
                />
              </label>
              <div className="safety-form-grid">
                <label>
                  Owner of action {action.id}
                  <select
                    value={action.ownerId}
                    disabled={locked}
                    onChange={(event) => change({ ownerId: event.target.value })}
                  >
                    <option value="">Choose a person</option>
                    {owners.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Due date of action {action.id}
                  <input
                    type="date"
                    value={action.dueOn}
                    disabled={locked}
                    onChange={(event) => change({ dueOn: event.target.value })}
                  />
                </label>
              </div>
              {state.findings.length > 0 && (
                <label>
                  Finding action {action.id} answers (optional)
                  <select
                    value={action.findingId}
                    disabled={locked}
                    onChange={(event) => change({ findingId: event.target.value })}
                  >
                    <option value="">None</option>
                    {state.findings.map((finding) => (
                      <option key={finding.id} value={finding.id}>
                        {finding.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {locked ? (
                <p className="safety-form-note">Action {action.id} is closed and stays as it was closed.</p>
              ) : (
                <Button
                  type="button"
                  kind="quiet"
                  onClick={() =>
                    set(
                      'actions',
                      state.actions.filter((_, at) => at !== index),
                    )
                  }
                >
                  Remove action {action.id}
                </Button>
              )}
            </div>
          );
        })}
        <Button
          type="button"
          kind="quiet"
          onClick={() =>
            set('actions', [
              ...state.actions,
              { id: nextItemId('A', state.actions), what: '', ownerId: '', dueOn: '', findingId: '' },
            ])
          }
        >
          Add an action
        </Button>
      </fieldset>

      {shown && draft.problems.length > 0 && (
        <Notice tone="attention" title="Not ready to record">
          <ul data-testid="assurance-problems">
            {draft.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
      <FailureNotice failure={command.failure} />
      <div className="sms-rail-buttons">
        <Button kind="primary" type="submit" disabled={command.pending}>
          {command.pending ? 'Recording…' : revising ? 'Record the new version' : 'Record as a draft'}
        </Button>
        <Button type="button" kind="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What the record holds: its type's facts, what it found, its actions and the hazards opened from it. */
export function AssuranceSections({
  client,
  detail,
  home,
  principal,
  onOpen,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  principal: Principal;
  onOpen: (record: SmsLinkedRecord) => void;
  onRecorded: () => void;
}) {
  const body = detail.current.body as AssuranceBody;
  const view = detail.assurance;
  const [hazardFrom, setHazardFrom] = useState<AssuranceItemRef | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const hazardsOf = (item: AssuranceItemRef) =>
    (view?.hazards ?? []).filter((entry) => entry.item.kind === item.kind && entry.item.id === item.id);
  const mayOpenHazard = principal.capabilities.includes('sms:write');
  const hazardButton = (item: AssuranceItemRef) =>
    mayOpenHazard && (
      <Button
        kind="quiet"
        aria-expanded={hazardFrom?.kind === item.kind && hazardFrom.id === item.id}
        onClick={() => setHazardFrom(hazardFrom?.id === item.id && hazardFrom.kind === item.kind ? null : item)}
      >
        Open a hazard from {item.kind} {item.id}
      </Button>
    );
  return (
    <>
      <section className="safety-section" data-testid="assurance-facts">
        <div className="safety-section-heading">
          <h3>{assuranceTypeLabel(body.assuranceType)}</h3>
          {view?.signedVersion ? (
            <Badge tone="planned">Version {view.signedVersion} signed</Badge>
          ) : (
            <Badge tone="attention">Not signed yet</Badge>
          )}
        </div>
        <dl className="safety-facts">
          <div>
            <dt>Performed</dt>
            <dd>{body.completedOn ? `${body.performedOn} to ${body.completedOn}` : body.performedOn}</dd>
          </div>
          {body.occurredOn && (
            <div>
              <dt>Occurrence</dt>
              <dd>{body.occurredOn}</dd>
            </div>
          )}
          {body.system && (
            <div>
              <dt>System or change</dt>
              <dd>{body.system}</dd>
            </div>
          )}
          {body.counterpart && (
            <div>
              <dt>{body.assuranceType === 'hazard_notice_sent' ? 'Sent to' : 'Received from'}</dt>
              <dd>{body.counterpart}</dd>
            </div>
          )}
          {body.fromReport && (
            <div>
              <dt>Started from</dt>
              <dd>A safety report, linked below. Nothing of it is copied here.</dd>
            </div>
          )}
          <div>
            <dt>What it covered</dt>
            <dd>{body.scope}</dd>
          </div>
          <div>
            <dt>What it looked at</dt>
            <dd>{body.examined}</dd>
          </div>
        </dl>
      </section>

      <section className="safety-section" aria-label="What it found">
        <h3>What it found</h3>
        {body.findings.length === 0 && <p className="sms-empty">No findings recorded.</p>}
        <ul className="assurance-list">
          {body.findings.map((finding) => (
            <li key={finding.id} data-testid={`assurance-finding-${finding.id}`}>
              <strong>{finding.id}</strong> {finding.text}
              <HazardLinks hazards={hazardsOf({ kind: 'finding', id: finding.id })} onOpen={onOpen} />
              {hazardButton({ kind: 'finding', id: finding.id })}
              {hazardFrom?.kind === 'finding' && hazardFrom.id === finding.id && (
                <HazardFromAssuranceForm
                  client={client}
                  detail={detail}
                  home={home}
                  principal={principal}
                  item={hazardFrom}
                  onOpened={(id) => {
                    setHazardFrom(null);
                    onRecorded();
                    onOpen({ id, kind: 'hazard', title: '', status: '', confidentiality: 'ordinary' });
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="safety-section" aria-label="Actions">
        <h3>Actions</h3>
        {(view?.actions ?? []).length === 0 && <p className="sms-empty">No actions recorded.</p>}
        <ul className="assurance-list">
          {(view?.actions ?? []).map((action) => (
            <li key={action.id} data-testid={`assurance-action-${action.id}`}>
              <ActionLine action={action} />
              {action.closed && (
                <p className="muted">
                  Closed by {action.closed.by.name}, {time(action.closed.at, true)} {timeZoneLabel()}:{' '}
                  {action.closed.note}
                </p>
              )}
              <HazardLinks hazards={hazardsOf({ kind: 'action', id: action.id })} onOpen={onOpen} />
              <div className="sms-rail-buttons">
                {action.state === 'open' &&
                  (action.close.available ? (
                    <Button
                      kind="quiet"
                      aria-expanded={closing === action.id}
                      onClick={() => setClosing(closing === action.id ? null : action.id)}
                    >
                      Close action {action.id}
                    </Button>
                  ) : (
                    <small className="rail-muted">{action.close.reason}</small>
                  ))}
                {action.state !== 'proposed' && hazardButton({ kind: 'action', id: action.id })}
              </div>
              {closing === action.id && (
                <CloseActionForm
                  client={client}
                  detail={detail}
                  action={action}
                  onRecorded={() => {
                    setClosing(null);
                    onRecorded();
                  }}
                />
              )}
              {hazardFrom?.kind === 'action' && hazardFrom.id === action.id && (
                <HazardFromAssuranceForm
                  client={client}
                  detail={detail}
                  home={home}
                  principal={principal}
                  item={hazardFrom}
                  onOpened={(id) => {
                    setHazardFrom(null);
                    onRecorded();
                    onOpen({ id, kind: 'hazard', title: '', status: '', confidentiality: 'ordinary' });
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ActionLine({ action }: { action: SmsAssuranceActionView }) {
  const state =
    action.state === 'closed'
      ? { label: 'Closed', tone: 'neutral' as const }
      : action.state === 'proposed'
        ? { label: 'Set when signed', tone: 'advisory' as const }
        : action.overdue
          ? { label: 'Overdue', tone: 'attention' as const }
          : { label: 'Open', tone: 'planned' as const };
  return (
    <p>
      <strong>{action.id}</strong> {action.what}{' '}
      <small className="muted">
        · {action.owner.name} · due {action.dueOn}
        {action.findingId ? ` · answers ${action.findingId}` : ''}
      </small>{' '}
      <Badge tone={state.tone}>{state.label}</Badge>
    </p>
  );
}

function HazardLinks({
  hazards,
  onOpen,
}: {
  hazards: NonNullable<SmsRecordDetailResponse['assurance']>['hazards'];
  onOpen: (record: SmsLinkedRecord) => void;
}) {
  if (!hazards.length) return null;
  return (
    <p className="muted">
      Hazards opened from it:{' '}
      {hazards.map((entry) => (
        <Button
          key={entry.record.id}
          kind="quiet"
          onClick={() => onOpen({ ...entry.record, kind: 'hazard', confidentiality: 'ordinary' })}
        >
          {entry.record.title}
        </Button>
      ))}
    </p>
  );
}

/** Records what was done on an open action and closes it. */
function CloseActionForm({
  client,
  detail,
  action,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  action: SmsAssuranceActionView;
  onRecorded: () => void;
}) {
  const [basis] = useState(detail.basis);
  const [note, setNote] = useState('');
  const command = useCommand(client);
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await command.submit({
      kind: 'decision.record',
      subject: { kind: 'sms', id: detail.record.id },
      expectedRevision: basis.revision,
      expectedDependencyBasis: basis.dependencyBasis,
      decision: { kind: 'action.close', actionId: action.id, note: note.trim() },
    });
    if (result) onRecorded();
  }
  return (
    <form
      className="action-form safety-form"
      onSubmit={(event) => void save(event)}
      aria-label={`Close action ${action.id}`}
    >
      <label htmlFor={`close-${action.id}`}>What was done</label>
      <textarea
        id={`close-${action.id}`}
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        required
      />
      <p className="safety-form-note">Closing keeps the action as it was set, with what was done and who closed it.</p>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending || !note.trim()}>
        {command.pending ? 'Recording…' : `Close action ${action.id}`}
      </Button>
    </form>
  );
}

/** Opens a hazard from a finding or an action of the current version; the hazard keeps it as its origin. */
function HazardFromAssuranceForm({
  client,
  detail,
  home,
  principal,
  item,
  onOpened,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  principal: Principal;
  item: AssuranceItemRef;
  onOpened: (id: string) => void;
}) {
  const [versionNumber] = useState(detail.record.versionNumber);
  const [draft, setDraft] = useState({ title: '', description: '', consequence: '', ownerId: principal.id });
  const command = useCommand(client);
  const set = (field: keyof typeof draft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [field]: event.target.value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await command.submit({
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: draft.title.trim(),
        ownerId: draft.ownerId,
        body: {
          description: draft.description.trim(),
          consequence: draft.consequence.trim(),
          source: { kind: 'assurance' },
        },
      },
      origin: { kind: 'assurance', recordId: detail.record.id, versionNumber, item },
    });
    if (result?.command.subject) onOpened(result.command.subject.id);
  }
  const key = `${item.kind}-${item.id}`;
  return (
    <form
      className="action-form safety-form"
      onSubmit={(event) => void save(event)}
      aria-label={`Open a hazard from ${item.kind} ${item.id}`}
    >
      <p className="safety-form-note">
        The hazard keeps {item.kind} {item.id} of version {versionNumber} as where it came from.
      </p>
      <label htmlFor={`hazard-title-${key}`}>Hazard</label>
      <input id={`hazard-title-${key}`} value={draft.title} onChange={set('title')} maxLength={200} required />
      <label htmlFor={`hazard-description-${key}`}>What could go wrong, and where</label>
      <textarea
        id={`hazard-description-${key}`}
        rows={3}
        value={draft.description}
        onChange={set('description')}
        required
      />
      <label htmlFor={`hazard-consequence-${key}`}>Worst credible outcome</label>
      <textarea
        id={`hazard-consequence-${key}`}
        rows={2}
        value={draft.consequence}
        onChange={set('consequence')}
        required
      />
      <label htmlFor={`hazard-owner-${key}`}>Owner</label>
      <select id={`hazard-owner-${key}`} value={draft.ownerId} onChange={set('ownerId')}>
        {home.people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending}>
        {command.pending ? 'Recording…' : 'Open the hazard'}
      </Button>
    </form>
  );
}

/** The rail's next step: sign the draft, or what a signed version means. */
export function AssuranceNextStep({ detail, onSign }: { detail: SmsRecordDetailResponse; onSign: () => void }) {
  const signed = detail.record.status === 'signed';
  return (
    <section className="safety-next-action">
      <span className="safety-stage-label">Next step</span>
      {signed ? (
        <p>
          Version {detail.record.versionNumber} is signed. A new version needs a new signature; closing an action does
          not.
        </p>
      ) : (
        <>
          <p>
            Version {detail.record.versionNumber} is a draft. Its actions are set when someone with the authority to
            adopt safety documentation signs it.
          </p>
          {detail.actions.adopt.available ? (
            <Button kind="next" onClick={onSign}>
              Review and sign
            </Button>
          ) : (
            <p className="rail-muted" data-testid="sign-unavailable">
              {detail.actions.adopt.reason}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The Safety home's list: open actions due in the next 30 days and overdue ones, by owner. */
export function AssuranceActionsDue({
  groups,
  onOpen,
}: {
  groups: SmsHomeResponse['assuranceActions'];
  onOpen: (recordId: string) => void;
}) {
  const count = groups.reduce((sum, group) => sum + group.actions.length, 0);
  const overdue = groups.reduce((sum, group) => sum + group.actions.filter((action) => action.overdue).length, 0);
  return (
    <section className="safety-section sms-attention" aria-label="Safety assurance actions due">
      <div className="safety-section-heading">
        <h3>
          Safety assurance actions due{' '}
          <span className={overdue ? 'sms-count' : 'sms-count sms-count--quiet'}>{count}</span>
        </h3>
      </div>
      <p className="muted">Open actions due in the next 30 days, and those past their due date, by owner.</p>
      {count === 0 ? (
        <p className="sms-empty">No safety assurance action is due in the next 30 days or overdue.</p>
      ) : (
        groups.map((group) => (
          <div key={group.owner.id} className="assurance-owner" data-testid={`actions-due-${group.owner.id}`}>
            <h4>{group.owner.name}</h4>
            <ul className="assurance-list">
              {group.actions.map((action) => (
                <li key={`${action.recordId}-${action.actionId}`}>
                  <button className="hazard-row sms-row" onClick={() => onOpen(action.recordId)}>
                    <span>
                      <strong>
                        {action.actionId} · {action.what}
                      </strong>
                      <small>
                        {action.recordTitle} · {assuranceTypeLabel(action.assuranceType)} · due {action.dueOn}
                      </small>
                    </span>
                    <span className="sms-row-facts">
                      {action.overdue && <Badge tone="attention">Overdue</Badge>}
                      <span className="sms-row-action">Open →</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
