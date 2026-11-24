import { useEffect, useRef, useState, type FormEvent } from 'react';
import { time, timeZone, timeZoneName } from './format.js';
import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import type {
  Command,
  CommandResponse,
  DocumentBody,
  DocumentBodyV2,
  DocumentType,
  HazardBody,
  Principal,
  RiskMatrixBody,
  SmsBasis,
  SmsCurrentLink,
  SmsHomeResponse,
  SmsLink,
  SmsRecordDetailResponse,
  SmsRecordKind,
  SmsRecordSummary,
  SmsRegisterResponse,
} from '@ledger/contracts';
import { documentTypeValues } from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { centralDateTimeInput, documentTime, fromCentralDateTimeInput } from './sms-document-dates.js';
import { SmsDocumentPurposes } from './SmsDocumentPurposes.js';
import {
  documentTypeLabels,
  levelName,
  levelTone,
  linkRelationLabels,
  plainError,
  recordKindLabels,
} from './sms-labels.js';

/** Keeps one idempotency key per draft so an unknown result is retried exactly, not duplicated. */
export function useCommand(client: LedgerClient) {
  const request = useRef<{ key: string; body: string; headers: Record<string, string> } | null>(null);
  const [pending, setPending] = useState(false);
  const [unknownResult, setUnknownResult] = useState(false);
  const [failure, setFailure] = useState<{ code?: string; message: string } | null>(null);
  async function submit(body: Command, headers: Record<string, string> = {}): Promise<CommandResponse | null> {
    request.current ??= { key: crypto.randomUUID(), body: JSON.stringify(body), headers };
    return sendRetained();
  }
  async function sendRetained(): Promise<CommandResponse | null> {
    const retained = request.current;
    if (!retained) return null;
    setPending(true);
    setFailure(null);
    try {
      const result = await client.request<CommandResponse>(
        '/v1/commands',
        { method: 'POST', body: retained.body, headers: retained.headers },
        retained.key,
      );
      request.current = null;
      setUnknownResult(false);
      return result;
    } catch (error) {
      const unknown = !(error instanceof ApiError) || error.status >= 500;
      if (!unknown) request.current = null;
      setUnknownResult(unknown);
      setFailure(
        unknown
          ? { message: 'The result is unknown. Your draft and request are kept; submit again to retry it exactly.' }
          : plainError(error),
      );
      return null;
    } finally {
      setPending(false);
    }
  }
  return { submit, retry: sendRetained, pending, failure, setFailure, unknownResult };
}

export function FailureNotice({ failure }: { failure: { code?: string; message: string } | null }) {
  if (!failure) return null;
  const stale = failure.code === 'stale_basis' || failure.code === 'signed_content_changed';
  return (
    <Notice tone={stale ? 'attention' : 'alert'} title={stale ? 'The record changed' : 'Not recorded'}>
      {failure.message}
      {stale ? ' Your draft is kept.' : ''}
    </Notice>
  );
}

export function IdentifyHazardForm({
  client,
  principal,
  home,
  onOpened,
}: {
  client: LedgerClient;
  principal: Principal;
  home: SmsHomeResponse;
  onOpened: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    title: '',
    description: '',
    consequence: '',
    operation: '',
    ownerId: principal.id,
    due: '',
  });
  const command = useCommand(client);
  if (!principal.capabilities.includes('sms:write'))
    return (
      <div className="safety-register-guidance">
        <h3>Identify a hazard</h3>
        <p className="rail-muted">
          Recording hazards needs permission to edit SMS records. Tell your safety manager about the hazard, or report
          it once reporting opens.
        </p>
      </div>
    );
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
        ...(draft.due ? { dueAt: dueDate(draft.due) } : {}),
        body: {
          description: draft.description.trim(),
          consequence: draft.consequence.trim(),
          ...(draft.operation.trim() ? { operation: draft.operation.trim() } : {}),
          source: { kind: 'manual_identification' },
        },
      },
    });
    if (!result?.command.subject) return;
    setDraft({ title: '', description: '', consequence: '', operation: '', ownerId: principal.id, due: '' });
    onOpened(result.command.subject.id);
  }
  return (
    <form className="action-form safety-form" onSubmit={(event) => void save(event)} aria-label="Identify a hazard">
      <h3>Identify a hazard</h3>
      <p className="safety-form-note">Recorded as a manual identification. No flight is needed.</p>
      <label htmlFor="hazard-title">Hazard</label>
      <input id="hazard-title" value={draft.title} onChange={set('title')} maxLength={200} required />
      <label htmlFor="hazard-description">What could go wrong, and where</label>
      <textarea id="hazard-description" rows={4} value={draft.description} onChange={set('description')} required />
      <label htmlFor="hazard-consequence">Worst credible outcome</label>
      <textarea id="hazard-consequence" rows={2} value={draft.consequence} onChange={set('consequence')} required />
      <label htmlFor="hazard-operation">Operation or system affected (optional)</label>
      <input id="hazard-operation" value={draft.operation} onChange={set('operation')} maxLength={200} />
      <div className="safety-form-grid">
        <label>
          Owner
          <select value={draft.ownerId} onChange={set('ownerId')}>
            {home.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due
          <input type="date" value={draft.due} onChange={set('due')} />
        </label>
      </div>
      <p className="safety-form-note">
        Hazards are ordinary records. Keep restricted asset detail in a restricted attachment on the hazard.
      </p>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending}>
        {command.pending ? 'Recording…' : 'Record hazard'}
      </Button>
    </form>
  );
}

export function MatrixPicker({
  matrix,
  label,
  value,
  onChange,
}: {
  matrix: RiskMatrixBody;
  label: string;
  value: { severity: string; likelihood: string };
  onChange: (value: { severity: string; likelihood: string }) => void;
}) {
  const cell = matrix.cells.find((item) => item.severity === value.severity && item.likelihood === value.likelihood);
  return (
    <fieldset className="sms-matrix-pick">
      <legend>
        {label}
        {cell && (
          <Badge
            tone={levelTone(matrix.levels.find((level) => level.id === cell.level)?.acceptance ?? 'low')}
            title="Shown from the adopted matrix; Ledger records the level it computes"
          >
            {levelName(cell.level, matrix)}
          </Badge>
        )}
      </legend>
      <div className="safety-form-grid">
        <label>
          Severity
          <select
            value={value.severity}
            onChange={(event) => onChange({ ...value, severity: event.target.value })}
            required
          >
            <option value="">Choose</option>
            {matrix.severities.map((entry) => (
              <option key={entry.id} value={entry.id} title={entry.description}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Likelihood
          <select
            value={value.likelihood}
            onChange={(event) => onChange({ ...value, likelihood: event.target.value })}
            required
          >
            <option value="">Choose</option>
            {matrix.likelihoods.map((entry) => (
              <option key={entry.id} value={entry.id} title={entry.description}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

/** The latest evaluation of the finding a hazard came from, as its record shows it; none for other hazards. */
function shownEvaluation(detail: SmsRecordDetailResponse): string | undefined {
  const evidence = detail.evidence;
  return (evidence?.sinceAssessed ?? evidence?.sinceOpened)?.latestEvaluation.id;
}

export function AssessmentForm({
  client,
  detail,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  onRecorded: () => void;
}) {
  const matrix = detail.matrix!;
  const [basis, setBasis] = useState<SmsBasis>(detail.basis);
  // For a hazard from a finding: the evaluation the assessor reviewed, as the record showed it.
  const [evaluationId, setEvaluationId] = useState(() => shownEvaluation(detail));
  const [initial, setInitial] = useState({ severity: '', likelihood: '' });
  const [residual, setResidual] = useState({ severity: '', likelihood: '' });
  const open = (detail.controls ?? []).filter((control) => control.status !== 'closed');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(open.map((control) => control.id)));
  const [newHazards, setNewHazards] = useState<'none_identified' | 'new_hazards_identified' | ''>('');
  const [newHazardNote, setNewHazardNote] = useState('');
  const [note, setNote] = useState('');
  const command = useCommand(client);
  const changed = detail.basis.revision !== basis.revision;
  const evidenceChanged =
    !changed &&
    Boolean(detail.evidence) &&
    (detail.basis.dependencyBasis !== basis.dependencyBasis || shownEvaluation(detail) !== evaluationId);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!newHazards) return;
    const result = await command.submit({
      kind: 'decision.record',
      subject: { kind: 'sms', id: detail.record.id },
      expectedRevision: basis.revision,
      expectedDependencyBasis: basis.dependencyBasis,
      decision: {
        kind: 'risk.assess',
        note: note.trim(),
        matrix: { recordId: matrix.record.id, versionNumber: matrix.version.versionNumber },
        initial,
        controls: open
          .filter((control) => chosen.has(control.id))
          .map((control) => ({ recordId: control.id, versionNumber: control.versionNumber })),
        residual,
        newHazardCheck: {
          answer: newHazards,
          ...(newHazardNote.trim() ? { note: newHazardNote.trim() } : {}),
        },
        ...(evaluationId ? { evidence: { evaluationId } } : {}),
      },
    });
    if (result) onRecorded();
  }
  return (
    <form className="action-form safety-form" onSubmit={(event) => void save(event)} aria-label="Assess risk">
      <h3>Assess risk</h3>
      <p className="safety-form-note">
        On {matrix.version.body.name}, version {matrix.version.versionNumber}. Ledger computes each level from this
        matrix.
      </p>
      {changed && (
        <Notice title="Changed since you started">
          This hazard changed after you opened the form. Recording will be refused until you review the current record;
          your draft is kept.
        </Notice>
      )}
      {evidenceChanged && (
        <Notice title="The evidence changed since you started">
          New evidence reached the finding this hazard came from. Review it on the record, then refresh the basis; your
          draft is kept.
          <Button
            kind="quiet"
            type="button"
            onClick={() => {
              setBasis(detail.basis);
              setEvaluationId(shownEvaluation(detail));
            }}
          >
            Refresh basis
          </Button>
        </Notice>
      )}
      <MatrixPicker
        matrix={matrix.version.body}
        label="Initial risk, before new controls"
        value={initial}
        onChange={setInitial}
      />
      <fieldset className="sms-controls">
        <legend>Controls the residual risk relies on</legend>
        {open.length === 0 && (
          <p className="safety-form-note">No controls are proposed on this hazard. Propose one first to rely on it.</p>
        )}
        {open.map((control) => (
          <label key={control.id} className="sms-check">
            <input
              type="checkbox"
              checked={chosen.has(control.id)}
              onChange={(event) =>
                setChosen((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) next.add(control.id);
                  else next.delete(control.id);
                  return next;
                })
              }
            />
            <span>
              {control.title}
              <small className="muted"> {control.description ?? control.controlType.id}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <MatrixPicker
        matrix={matrix.version.body}
        label="Predicted residual risk, with these controls"
        value={residual}
        onChange={setResidual}
      />
      <fieldset className="sms-new-hazards">
        <legend>Could these controls introduce a new hazard?</legend>
        <label>
          <input
            type="radio"
            name="new-hazards"
            checked={newHazards === 'none_identified'}
            onChange={() => setNewHazards('none_identified')}
            required
          />
          We checked and found none
        </label>
        <label>
          <input
            type="radio"
            name="new-hazards"
            checked={newHazards === 'new_hazards_identified'}
            onChange={() => setNewHazards('new_hazards_identified')}
          />
          Yes, they may
        </label>
        {newHazards === 'new_hazards_identified' && (
          <textarea
            aria-label="New hazards the controls may introduce"
            rows={2}
            value={newHazardNote}
            onChange={(event) => setNewHazardNote(event.target.value)}
            placeholder="Describe them, then identify each as its own hazard"
            required
          />
        )}
      </fieldset>
      <label htmlFor="assessment-note">Basis for this assessment</label>
      <textarea id="assessment-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} required />
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending || evidenceChanged}>
        {command.pending ? 'Recording…' : 'Record assessment'}
      </Button>
    </form>
  );
}

export function AttachmentForm({
  client,
  detail,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  onRecorded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const command = useCommand(client);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setUploading(true);
    setUploadFailure(null);
    key.current ??= crypto.randomUUID();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { artifact } = await client.upload(
        bytes,
        file.type || 'application/octet-stream',
        key.current,
        file.name,
        restricted ? 'restricted_asset_information' : 'ordinary',
      );
      const result = await command.submit({
        kind: 'sms.attachment.add',
        recordId: detail.record.id,
        expectedRevision: detail.basis.revision,
        attachment: { uploadId: artifact.uploadId, label: label.trim() },
      });
      if (result) {
        key.current = null;
        setFile(null);
        setLabel('');
        setRestricted(false);
        onRecorded();
      }
    } catch (error) {
      setUploadFailure(plainError(error).message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <form className="action-form safety-form" onSubmit={(event) => void save(event)} aria-label="Attach a file">
      <h3>Attach a file</h3>
      <input
        aria-label="File"
        type="file"
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          key.current = null;
        }}
        required
      />
      <label htmlFor="attachment-label">Description</label>
      <input
        id="attachment-label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={200}
        required
      />
      <p className="safety-form-note">The description is visible to everyone with SMS access and in exports.</p>
      <fieldset className="sms-new-hazards">
        <legend>Confidentiality</legend>
        <label>
          <input type="radio" name="confidentiality" checked={!restricted} onChange={() => setRestricted(false)} />
          Ordinary · included in exports
        </label>
        <label>
          <input type="radio" name="confidentiality" checked={restricted} onChange={() => setRestricted(true)} />
          Restricted asset information · stored apart, readable only by cleared people, never exported
        </label>
      </fieldset>
      {uploadFailure && (
        <Notice tone="alert" title="Upload not finished">
          {uploadFailure} Choose Attach again to retry the same upload.
        </Notice>
      )}
      <FailureNotice failure={command.failure} />
      <Button kind="next" type="submit" disabled={uploading || command.pending || !file}>
        {uploading || command.pending ? 'Attaching…' : 'Attach file'}
      </Button>
    </form>
  );
}

function OwnerAndDue({
  home,
  ownerId,
  due,
  onOwner,
  onDue,
}: {
  home: SmsHomeResponse;
  ownerId: string;
  due: string;
  onOwner: (value: string) => void;
  onDue: (value: string) => void;
}) {
  return (
    <div className="safety-form-grid">
      <label>
        Owner
        <select value={ownerId} onChange={(event) => onOwner(event.target.value)}>
          {home.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Due
        <input type="date" value={due} onChange={(event) => onDue(event.target.value)} />
      </label>
    </div>
  );
}

// A due date falls due at five in the afternoon, the organization's time.
const dueDate = (value: string) => (value ? fromCentralDateTimeInput(`${value}T17:00`) : null);
const dateInput = (value: string | null) =>
  value ? new Date(value).toLocaleDateString('en-CA', { timeZone: timeZone() }) : '';

interface DocumentDraftFields {
  documentType: DocumentType;
  origin: 'authored' | 'received';
  documentNumber: string;
  revisionLabel: string;
  changeReason: string;
  summary: string;
  text: string;
  sourceOrganization: string;
  sourceReference: string;
  sourceRevision: string;
  sourceIssuedAt: string;
  sourceReceivedAt: string;
  reviewDueAt: string;
  purposes: string[];
}

const firstReason = (origin: DocumentDraftFields['origin']) => (origin === 'authored' ? 'Initial issue' : '');
const summaryLabel = (origin: DocumentDraftFields['origin']) =>
  origin === 'received' ? "Issuer's summary of this revision" : 'Summary';
const reasonLabel = (origin: DocumentDraftFields['origin']) =>
  origin === 'received' ? 'Why we are adopting it' : 'Reason for this revision';

function DocumentFields({
  draft,
  previous,
  onChange,
}: {
  draft: DocumentDraftFields;
  /** The issued revision this draft will replace; its details are hints, never silent defaults. */
  previous?: { label: string; body: DocumentBody };
  onChange: (field: Exclude<keyof DocumentDraftFields, 'purposes'>, value: string) => void;
}) {
  const before = previous?.body;
  const received = draft.origin === 'received';
  const repeated = (field: 'summary' | 'text') =>
    before && draft[field].trim() && draft[field].trim() === (before[field] ?? '').trim();
  return (
    <>
      <label>
        Origin
        <select value={draft.origin} onChange={(event) => onChange('origin', event.target.value)}>
          <option value="authored">Authored by our organization</option>
          <option value="received">Received from another organization</option>
        </select>
      </label>
      <div className="safety-form-grid">
        <label>
          Type
          <select value={draft.documentType} onChange={(event) => onChange('documentType', event.target.value)}>
            {documentTypeValues.map((type) => (
              <option key={type} value={type}>
                {documentTypeLabels[type]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Document number (optional)
          <input
            value={draft.documentNumber}
            maxLength={80}
            onChange={(event) => onChange('documentNumber', event.target.value)}
          />
        </label>
      </div>
      <label>
        Revision label
        <input
          value={draft.revisionLabel}
          placeholder={previous ? `Previously ${previous.label}` : 'Revision 1'}
          maxLength={40}
          onChange={(event) => onChange('revisionLabel', event.target.value)}
        />
      </label>
      {draft.origin === 'received' && (
        <fieldset className="sms-controls">
          <legend>Source document</legend>
          <label>
            Issuing organization
            <input
              value={draft.sourceOrganization}
              maxLength={200}
              onChange={(event) => onChange('sourceOrganization', event.target.value)}
              required
            />
          </label>
          <label>
            Source reference (optional)
            <input
              value={draft.sourceReference}
              maxLength={200}
              onChange={(event) => onChange('sourceReference', event.target.value)}
            />
          </label>
          <label>
            Source revision
            <input
              value={draft.sourceRevision}
              maxLength={80}
              placeholder={before?.source ? `Previously ${before.source.revision}` : undefined}
              onChange={(event) => onChange('sourceRevision', event.target.value)}
              required
            />
          </label>
          <div className="safety-form-grid">
            <label>
              Issued by source (optional)
              <input
                type="date"
                value={draft.sourceIssuedAt.slice(0, 10)}
                onChange={(event) => onChange('sourceIssuedAt', event.target.value)}
              />
            </label>
            <label>
              Received · {timeZoneName()} time
              <input
                type="datetime-local"
                step="1"
                value={draft.sourceReceivedAt}
                onChange={(event) => onChange('sourceReceivedAt', event.target.value)}
                required
              />
            </label>
          </div>
          {before?.source && (
            <p className="sms-carried">
              {`${previous!.label} was source revision ${before.source.revision}`}
              {before.source.issuedAt ? `, issued ${documentTime(before.source.issuedAt)}` : ''}. Enter this
              revision&apos;s details from the new source document.
            </p>
          )}
          <p className="safety-form-note">
            Keep the received file unchanged. Review and adoption record your organization's decision to use this exact
            source revision.
          </p>
        </fieldset>
      )}
      <label htmlFor="document-summary">{summaryLabel(draft.origin)}</label>
      {received && (
        <p className="safety-form-note">
          Copy or paraphrase the issuer&apos;s revision highlights. Readers see this before they acknowledge.
        </p>
      )}
      <textarea
        id="document-summary"
        rows={received ? 3 : 2}
        value={draft.summary}
        onChange={(event) => onChange('summary', event.target.value)}
        required
      />
      {repeated('summary') && (
        <p className="sms-carried">
          This is {previous!.label}&apos;s summary. Describe what this revision says or changes.
        </p>
      )}
      <label>
        {reasonLabel(draft.origin)}
        <textarea
          rows={2}
          value={draft.changeReason}
          onChange={(event) => onChange('changeReason', event.target.value)}
          required
        />
      </label>
      {received ? (
        <>
          <p className="safety-form-note">Attach the issuer&apos;s file after saving. The file is the document.</p>
          {before?.text && (
            <p className="sms-carried">
              The notes recorded with {previous!.label} stay with that revision. Received documents no longer carry
              notes.
            </p>
          )}
        </>
      ) : (
        <>
          <label htmlFor="document-text">Document text (or attach the file after saving)</label>
          <textarea
            id="document-text"
            rows={6}
            value={draft.text}
            onChange={(event) => onChange('text', event.target.value)}
          />
          {repeated('text') && (
            <p className="sms-carried">{`This is ${previous!.label}'s text. Update it for this revision.`}</p>
          )}
        </>
      )}
      <label>
        Review due · {timeZoneName()} time (optional)
        <input
          type="datetime-local"
          step="1"
          value={draft.reviewDueAt}
          onChange={(event) => onChange('reviewDueAt', event.target.value)}
        />
      </label>
    </>
  );
}

export function DraftDocumentForm({
  client,
  principal,
  home,
  onOpened,
}: {
  client: LedgerClient;
  principal: Principal;
  home: SmsHomeResponse;
  onOpened: (id: string) => void;
}) {
  const blank = {
    title: '',
    documentType: 'safety_policy' as DocumentType,
    origin: 'authored' as const,
    documentNumber: '',
    changeReason: firstReason('authored'),
    sourceOrganization: '',
    sourceReference: '',
    sourceRevision: '',
    sourceIssuedAt: '',
    sourceReceivedAt: centralDateTimeInput(new Date().toISOString()),
    reviewDueAt: '',
    revisionLabel: '',
    summary: '',
    text: '',
    purposes: [] as string[],
    ownerId: principal.id,
    due: '',
  };
  const [draft, setDraft] = useState<Omit<typeof blank, 'origin'> & { origin: DocumentDraftFields['origin'] }>(blank);
  const command = useCommand(client);
  if (!principal.capabilities.includes('sms:write'))
    return (
      <div className="safety-register-guidance">
        <h3>Record a document</h3>
        <p className="rail-muted">Recording documents needs permission to edit SMS records.</p>
      </div>
    );
  async function save(event: FormEvent) {
    event.preventDefault();
    let body: DocumentBodyV2;
    try {
      body = documentBody(draft);
    } catch (error) {
      command.setFailure(plainError(error));
      return;
    }
    const result = await command.submit({
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: draft.title.trim(),
        ownerId: draft.ownerId,
        ...(draft.due ? { dueAt: dueDate(draft.due) } : {}),
        body,
      },
    });
    if (!result?.command.subject) return;
    setDraft(blank);
    onOpened(result.command.subject.id);
  }
  return (
    <form className="action-form safety-form" onSubmit={(event) => void save(event)} aria-label="Record a document">
      <h3>Record a document</h3>
      <p className="safety-form-note">
        Start an authored or received document. Attach its files, review the revision, then sign and issue it to
        readers.
      </p>
      <label htmlFor="document-title">Title</label>
      <input
        id="document-title"
        value={draft.title}
        maxLength={200}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        required
      />
      <DocumentFields
        draft={draft}
        onChange={(field, value) => {
          const defaultReason = field === 'origin' && draft.changeReason === firstReason(draft.origin);
          setDraft({
            ...draft,
            [field]: value,
            ...(defaultReason ? { changeReason: firstReason(value as DocumentDraftFields['origin']) } : {}),
          });
        }}
      />
      <SmsDocumentPurposes
        documentType={draft.documentType}
        client={client}
        value={draft.purposes}
        onChange={(purposes) => setDraft({ ...draft, purposes })}
      />
      <OwnerAndDue
        home={home}
        ownerId={draft.ownerId}
        due={draft.due}
        onOwner={(ownerId) => setDraft({ ...draft, ownerId })}
        onDue={(due) => setDraft({ ...draft, due })}
      />
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending}>
        {command.pending ? 'Saving…' : 'Save draft'}
      </Button>
    </form>
  );
}

function documentBody(draft: DocumentDraftFields): DocumentBodyV2 {
  const common = {
    documentType: draft.documentType,
    summary: draft.summary.trim(),
    changeReason: draft.changeReason.trim(),
    ...(draft.documentNumber.trim() ? { documentNumber: draft.documentNumber.trim() } : {}),
    ...(draft.revisionLabel.trim() ? { revisionLabel: draft.revisionLabel.trim() } : {}),
    ...(draft.origin === 'authored' && draft.text.trim() ? { text: draft.text.trim() } : {}),
    ...(draft.reviewDueAt ? { reviewDueAt: fromCentralDateTimeInput(draft.reviewDueAt) } : {}),
    ...(draft.purposes.length ? { purposes: [...draft.purposes] } : {}),
  };
  if (draft.origin === 'authored') return { ...common, origin: 'authored' };
  return {
    ...common,
    origin: 'received',
    source: {
      organization: draft.sourceOrganization.trim(),
      revision: draft.sourceRevision.trim(),
      receivedAt: fromCentralDateTimeInput(draft.sourceReceivedAt),
      ...(draft.sourceReference.trim() ? { reference: draft.sourceReference.trim() } : {}),
      ...(draft.sourceIssuedAt ? { issuedAt: draft.sourceIssuedAt } : {}),
    },
  };
}

export function ReviseForm({
  client,
  detail,
  home,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  onRecorded: () => void;
}) {
  const current = detail.current;
  const [basis] = useState<SmsBasis>(detail.basis);
  const hazard = detail.record.kind === 'hazard' ? (current.body as HazardBody) : undefined;
  const document = detail.record.kind === 'document' ? (current.body as DocumentBody) : undefined;
  const succeeding = Boolean(
    document &&
    detail.documentControl?.issues.some(
      (issue) => issue.versionNumber === current.versionNumber && issue.status !== 'withdrawn',
    ),
  );
  const previous =
    succeeding && document
      ? { label: document.revisionLabel ?? `Version ${current.versionNumber}`, body: document }
      : undefined;
  const [draft, setDraft] = useState({
    title: current.title,
    description: hazard?.description ?? '',
    consequence: hazard?.consequence ?? '',
    operation: hazard?.operation ?? '',
    documentType: document?.documentType ?? ('safety_policy' as DocumentType),
    origin: document?.origin ?? 'authored',
    documentNumber: document?.documentNumber ?? '',
    changeReason: '',
    sourceOrganization: document?.source?.organization ?? '',
    sourceReference: document?.source?.reference ?? '',
    sourceRevision: succeeding ? '' : (document?.source?.revision ?? ''),
    sourceIssuedAt: succeeding ? '' : (document?.source?.issuedAt ?? ''),
    sourceReceivedAt:
      document?.source?.receivedAt && !succeeding
        ? centralDateTimeInput(document.source.receivedAt)
        : centralDateTimeInput(new Date().toISOString()),
    reviewDueAt: document?.reviewDueAt ? centralDateTimeInput(document.reviewDueAt) : '',
    revisionLabel: succeeding ? '' : (document?.revisionLabel ?? ''),
    summary: document?.summary ?? '',
    text: document?.text ?? '',
    purposes: [...(document?.purposes ?? [])],
    ownerId: current.owner.id,
    due: dateInput(current.dueAt),
  });
  const command = useCommand(client);
  const changed = detail.basis.revision !== basis.revision;
  async function save(event: FormEvent) {
    event.preventDefault();
    let body: DocumentBodyV2 | undefined;
    if (!hazard) {
      try {
        body = documentBody(draft);
      } catch (error) {
        command.setFailure(plainError(error));
        return;
      }
    }
    const envelope = {
      title: draft.title.trim(),
      ownerId: draft.ownerId,
      dueAt: dueDate(draft.due),
      links: detail.record.confidentiality === 'ordinary' ? detail.links.map(storedLink) : current.links,
    };
    const result = await command.submit({
      kind: 'sms.record.revise',
      recordId: detail.record.id,
      expectedRevision: basis.revision,
      record: hazard
        ? {
            kind: 'hazard',
            schema: 'sms.hazard.1',
            ...envelope,
            body: {
              description: draft.description.trim(),
              consequence: draft.consequence.trim(),
              ...(draft.operation.trim() ? { operation: draft.operation.trim() } : {}),
              source: hazard.source,
            },
          }
        : { kind: 'document', schema: 'sms.document.2', ...envelope, body: body! },
    });
    if (result) onRecorded();
  }
  return (
    <form
      className="action-form safety-form"
      onSubmit={(event) => void save(event)}
      aria-label={hazard ? 'Edit hazard' : 'Record a new revision'}
    >
      <h3>{hazard ? 'Edit hazard' : 'Record a new revision'}</h3>
      <p className="safety-form-note">
        {hazard
          ? 'Saving records version ' +
            (detail.record.versionNumber + 1) +
            '. A changed hazard needs a new assessment before its risk is accepted.'
          : 'Saving records a new working revision. The current issued revision stays in force while this revision is reviewed, signed and issued.'}
      </p>
      {changed && (
        <Notice title="Changed since you started">
          This record changed after you opened the form. Saving will be refused until you review it; your draft is kept.
        </Notice>
      )}
      <label htmlFor="revise-title">Title</label>
      <input
        id="revise-title"
        value={draft.title}
        maxLength={200}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        required
      />
      {hazard ? (
        <>
          <label htmlFor="revise-description">What could go wrong, and where</label>
          <textarea
            id="revise-description"
            rows={4}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            required
          />
          <label htmlFor="revise-consequence">Worst credible outcome</label>
          <textarea
            id="revise-consequence"
            rows={2}
            value={draft.consequence}
            onChange={(event) => setDraft({ ...draft, consequence: event.target.value })}
            required
          />
          <label htmlFor="revise-operation">Operation or system affected (optional)</label>
          <input
            id="revise-operation"
            value={draft.operation}
            maxLength={200}
            onChange={(event) => setDraft({ ...draft, operation: event.target.value })}
          />
        </>
      ) : (
        <>
          <DocumentFields
            draft={draft}
            previous={previous}
            onChange={(field, value) => setDraft({ ...draft, [field]: value })}
          />
          <SmsDocumentPurposes
            documentType={draft.documentType}
            client={client}
            value={draft.purposes}
            onChange={(purposes) => setDraft({ ...draft, purposes })}
          />
        </>
      )}
      <OwnerAndDue
        home={home}
        ownerId={draft.ownerId}
        due={draft.due}
        onOwner={(ownerId) => setDraft({ ...draft, ownerId })}
        onDue={(due) => setDraft({ ...draft, due })}
      />
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending}>
        {command.pending ? 'Saving…' : `Save version ${detail.record.versionNumber + 1}`}
      </Button>
    </form>
  );
}

function storedLink({ relation, target }: SmsCurrentLink): SmsLink {
  return { relation, target };
}

function sameLink(a: SmsLink, b: SmsLink): boolean {
  return JSON.stringify(storedLink(a)) === JSON.stringify(storedLink(b));
}

export function linkTargetLabel(link: SmsCurrentLink): string {
  if (link.target.kind === 'external')
    return link.target.reference ? `${link.target.label} (${link.target.reference})` : link.target.label;
  if (link.target.kind === 'finding') return 'A finding';
  if (link.target.kind === 'flight') return 'A flight';
  return link.record?.title ?? 'A record no longer available';
}

const pickerKinds: SmsRecordKind[] = ['hazard', 'document', 'risk_matrix', 'report'];

export function LinkForm({
  client,
  detail,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  onRecorded: () => void;
}) {
  const [basis] = useState<SmsBasis>(detail.basis);
  const [links, setLinks] = useState<SmsCurrentLink[]>(detail.links);
  const [relation, setRelation] = useState<SmsLink['relation']>('cites');
  const [outside, setOutside] = useState(false);
  const [recordId, setRecordId] = useState('');
  const [label, setLabel] = useState('');
  const [reference, setReference] = useState('');
  const [candidates, setCandidates] = useState<SmsRecordSummary[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const command = useCommand(client);
  useEffect(() => {
    let stopped = false;
    Promise.all(pickerKinds.map((kind) => client.request<SmsRegisterResponse>(`/v1/sms/records?kind=${kind}`))).then(
      (registers) => {
        if (!stopped)
          setCandidates(registers.flatMap((register) => register.records).filter((r) => r.id !== detail.record.id));
      },
      (failure) => {
        if (!stopped) setLoadFailure(plainError(failure).message);
      },
    );
    return () => {
      stopped = true;
    };
  }, [client, detail.record.id]);

  const picked = candidates?.find((candidate) => candidate.id === recordId);
  const draft: SmsCurrentLink | null = outside
    ? label.trim()
      ? {
          relation,
          target: {
            kind: 'external',
            label: label.trim(),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
          },
        }
      : null
    : picked
      ? { relation, target: { kind: 'sms_record', id: picked.id }, record: picked }
      : null;
  const duplicate = draft !== null && links.some((link) => sameLink(link, draft));
  const added = links.filter((link) => !detail.links.some((before) => sameLink(before, link))).length;
  const removed = detail.links.filter((before) => !links.some((link) => sameLink(before, link))).length;
  const changed = detail.basis.revision !== basis.revision;

  function add() {
    if (!draft || duplicate) return;
    setLinks([...links, draft]);
    setRecordId('');
    setLabel('');
    setReference('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await command.submit({
      kind: 'sms.record.links',
      recordId: detail.record.id,
      expectedRevision: basis.revision,
      links: links.map(storedLink),
    });
    if (result) onRecorded();
  }
  return (
    <form className="action-form safety-form" onSubmit={(event) => void save(event)} aria-label="Change links">
      <h3>Change links</h3>
      <p className="safety-form-note">
        Links do not record a new version. Risk acceptances and adoption signatures stay current, and every change is
        kept in the record history and its exports.
      </p>
      {changed && (
        <Notice title="Changed since you started">
          This record changed after you opened the form. Saving will be refused until you review it; your draft is kept.
        </Notice>
      )}
      {links.length === 0 ? (
        <p className="rail-muted">No links.</p>
      ) : (
        <ul className="sms-link-edit">
          {links.map((link, index) => (
            <li key={index}>
              <span>
                <small>{linkRelationLabels[link.relation]}</small>
                {linkTargetLabel(link)}
              </span>
              <Button
                kind="quiet"
                type="button"
                aria-label={`Remove link to ${linkTargetLabel(link)}`}
                onClick={() => setLinks(links.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="sms-new-hazards">
        <legend>Add a link</legend>
        <label htmlFor="link-relation">Relation</label>
        <select
          id="link-relation"
          value={relation}
          onChange={(event) => setRelation(event.target.value as SmsLink['relation'])}
        >
          {Object.entries(linkRelationLabels).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
        <label>
          <input type="radio" name="link-target" checked={!outside} onChange={() => setOutside(false)} />A record in
          Ledger
        </label>
        <label>
          <input type="radio" name="link-target" checked={outside} onChange={() => setOutside(true)} />
          Something outside Ledger, such as a waiver or a manual section
        </label>
        {outside ? (
          <>
            <label htmlFor="link-label">Name</label>
            <input id="link-label" value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} />
            <label htmlFor="link-reference">Reference (optional)</label>
            <input
              id="link-reference"
              value={reference}
              maxLength={400}
              placeholder="Waiver number, section or URL"
              onChange={(event) => setReference(event.target.value)}
            />
            <p className="safety-form-note">
              Use a reference, not the content. Do not enter asset locations or restricted information.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="link-record">Record</label>
            {loadFailure ? (
              <Notice tone="alert" title="Records unavailable">
                {loadFailure}
              </Notice>
            ) : (
              <select
                id="link-record"
                value={recordId}
                disabled={!candidates}
                onChange={(event) => setRecordId(event.target.value)}
              >
                <option value="">{candidates ? 'Choose a record' : 'Loading records…'}</option>
                {pickerKinds.map((kind) => {
                  const ofKind = candidates?.filter((candidate) => candidate.kind === kind) ?? [];
                  return ofKind.length ? (
                    <optgroup key={kind} label={recordKindLabels[kind]}>
                      {ofKind.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            )}
          </>
        )}
        {duplicate && <p className="rail-muted">This link is already in the list.</p>}
        <Button kind="quiet" type="button" disabled={!draft || duplicate} onClick={add}>
          Add to the list
        </Button>
      </fieldset>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending || (added === 0 && removed === 0)}>
        {command.pending
          ? 'Saving…'
          : added === 0 && removed === 0
            ? 'No changes to save'
            : linkSaveLabel(added, removed)}
      </Button>
    </form>
  );
}

function linkSaveLabel(added: number, removed: number): string {
  const parts = [added ? `${added} added` : '', removed ? `${removed} removed` : ''].filter(Boolean);
  return `Save links (${parts.join(', ')})`;
}

export function StatusForm({
  client,
  detail,
  closing,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  closing: boolean;
  onRecorded: () => void;
}) {
  const [basis] = useState<SmsBasis>(detail.basis);
  const [note, setNote] = useState('');
  const [cited, setCited] = useState('');
  const command = useCommand(client);
  const noun = detail.record.kind === 'hazard' ? 'hazard' : detail.record.kind === 'report' ? 'report' : 'document';
  const reviews = closing && detail.record.kind === 'hazard' ? (detail.closingReviews ?? []) : [];
  const review = reviews.find((entry) => entry.id === cited);
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await command.submit({
      kind: 'decision.record',
      subject: { kind: 'sms', id: detail.record.id },
      expectedRevision: basis.revision,
      expectedDependencyBasis: basis.dependencyBasis,
      decision: {
        kind: closing ? 'record.close' : 'record.reopen',
        note: note.trim(),
        ...(review ? { review: { id: review.id, digest: review.digest } } : {}),
      },
    });
    if (result) onRecorded();
  }
  return (
    <form className="action-form safety-form" onSubmit={(event) => void save(event)} aria-label="Change status">
      <h3>{closing ? (noun === 'document' ? 'Retire document' : `Close ${noun}`) : `Reopen ${noun}`}</h3>
      <p className="safety-form-note">
        {closing
          ? `Closing keeps every version, decision and signature. A closed ${noun} leaves the attention lists.`
          : `Reopening returns the ${noun} to the status it had before it was closed.`}
      </p>
      <label htmlFor="status-note">Reason</label>
      <textarea id="status-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} required />
      {reviews.length > 0 && (
        <>
          <label htmlFor="status-review">Cite a review of a control’s indicator result (optional)</label>
          <select id="status-review" value={cited} onChange={(event) => setCited(event.target.value)}>
            <option value="">No review cited</option>
            {reviews.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.control.title} (version ${entry.control.versionNumber}): reviewed ${entry.conclusion} by ${entry.reviewer}, ${time(entry.recordedAt, true)}`}
              </option>
            ))}
          </select>
        </>
      )}
      <FailureNotice failure={command.failure} />
      <Button kind="next" type="submit" disabled={command.pending}>
        {command.pending ? 'Recording…' : closing ? 'Record closure' : 'Record reopening'}
      </Button>
    </form>
  );
}
