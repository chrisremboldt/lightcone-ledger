import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  documentAcknowledgementStatement,
  type DocumentBody,
  type Principal,
  type SmsBasis,
  type SmsDocumentAssignment,
  type SmsDocumentIssue,
  type SmsDocumentReadingProgress,
  type SmsDocumentReviewDue,
  type SmsHomeResponse,
  type SmsPersonReading,
  type SmsRecordDetailResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { byteSize, counted, timeZoneName } from './format.js';
import { plainError } from './sms-labels.js';
import { AttachmentForm, FailureNotice, LinkForm, ReviseForm, StatusForm, useCommand } from './SmsForms.js';
import {
  centralDateTimeInput,
  documentDate,
  documentTime,
  fromCentralDateTimeInput,
  reviewState,
} from './sms-document-dates.js';
import {
  adopterNames,
  documentState,
  isActive,
  isPast,
  issueLabel,
  issueStatusLabel,
  isUnissued,
  versionLabel,
  type DocumentState,
} from './sms-document-state.js';

export function AcknowledgeIssue({
  client,
  detail,
  issue,
  principal,
  heading = true,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  issue: SmsDocumentIssue;
  principal: Principal;
  heading?: boolean;
  onRecorded: () => void;
}) {
  const recipient = issue.recipients.find((entry) => entry.id === principal.id);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const command = useCommand(client);
  if (!recipient) return null;
  if (recipient.acknowledgedAt)
    return (
      <Notice tone="neutral" title="Your acknowledgement is recorded">
        {documentTime(recipient.acknowledgedAt)} · {issueLabel(issue)}
      </Notice>
    );
  if (!isActive(issue))
    return (
      <p className="muted">
        Your reading assignment is retained. This issue is {issueStatusLabel(issue).toLowerCase()}.
      </p>
    );
  const statement = documentAcknowledgementStatement(issue);
  const unreadable = issue.attachmentIds.some(
    (id) => !detail.attachments.find((attachment) => attachment.id === id)?.readable,
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || unreadable) return;
    const result = await command.submit({
      kind: 'sms.document.acknowledge',
      recordId: detail.record.id,
      issueId: issue.id,
      contentDigest: issue.contentDigest,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (result) onRecorded();
  }
  return (
    <form
      className="action-form safety-form sms-acknowledge"
      onSubmit={(event) => void save(event)}
      aria-label="Acknowledge document"
    >
      {heading && (
        <>
          <h4>Your reading assignment</h4>
          <p>
            {recipient.dueAt
              ? `Acknowledge by ${documentTime(recipient.dueAt)}.`
              : 'Your personal acknowledgement is required.'}
          </p>
        </>
      )}
      <label className="sms-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          required
          disabled={unreadable}
        />
        {statement}
      </label>
      {unreadable && (
        <p className="rail-muted">
          You need access to every issued file before acknowledging this revision. Contact the document owner.
        </p>
      )}
      <label>
        Note (optional)
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <FailureNotice failure={command.failure} />
      {command.unknownResult ? (
        <Button
          kind="next"
          type="button"
          disabled={command.pending}
          onClick={() => {
            void command.retry().then((result) => {
              if (result) onRecorded();
            });
          }}
        >
          {command.pending ? 'Retrying…' : 'Retry exact acknowledgement request'}
        </Button>
      ) : (
        <Button kind="primary" type="submit" disabled={!confirmed || unreadable || command.pending}>
          {command.pending ? 'Recording…' : 'Record my acknowledgement'}
        </Button>
      )}
    </form>
  );
}

function RecipientPicker({
  home,
  selected,
  excluded = [],
  onChange,
}: {
  home: SmsHomeResponse;
  selected: string[];
  excluded?: string[];
  onChange: (ids: string[]) => void;
}) {
  const people = home.people.filter((person) => !excluded.includes(person.id));
  return (
    <fieldset className="sms-controls">
      <legend>Named readers</legend>
      <p className="safety-form-note">This exact list is retained. Each reader acknowledges this issue personally.</p>
      {people.length > 1 && (
        <div className="sms-rail-buttons">
          <Button
            type="button"
            kind="quiet"
            disabled={selected.length === people.length}
            onClick={() => onChange(people.map((person) => person.id))}
          >
            Select everyone ({people.length})
          </Button>
          <Button type="button" kind="quiet" disabled={!selected.length} onClick={() => onChange([])}>
            Clear
          </Button>
        </div>
      )}
      {people.map((person) => (
        <label className="sms-check" key={person.id}>
          <input
            type="checkbox"
            checked={selected.includes(person.id)}
            onChange={(event) =>
              onChange(event.target.checked ? [...selected, person.id] : selected.filter((id) => id !== person.id))
            }
          />
          {person.name}
        </label>
      ))}
      {people.length === 0 && <p className="rail-muted">Everyone in the directory is already assigned.</p>}
    </fieldset>
  );
}

function DocumentBasisNotice({
  detail,
  basis,
  disabled,
  onReview,
}: {
  detail: SmsRecordDetailResponse;
  basis: SmsBasis;
  disabled: boolean;
  onReview: () => void;
}) {
  if (basis.revision === detail.basis.revision && basis.dependencyBasis === detail.basis.dependencyBasis) return null;
  return (
    <Notice title="The record changed while this form was open">
      Review the updated record before continuing. Your selections and note are kept.
      <Button type="button" kind="quiet" disabled={disabled} onClick={onReview}>
        Review updated record
      </Button>
    </Notice>
  );
}

type Attachment = SmsRecordDetailResponse['attachments'][number];
const signable = (attachment: Attachment) => attachment.readable && attachment.confidentiality === 'ordinary';

function ReviewFileChoice({
  attachment,
  checked,
  onChange,
}: {
  attachment: Attachment;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="sms-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={!signable(attachment)}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {attachment.label}
        <small className="mono"> · {byteSize(attachment.byteLength)}</small>
        {attachment.confidentiality !== 'ordinary' ? (
          <small> · supporting evidence only; excluded from issued content</small>
        ) : (
          !attachment.readable && <small> · permission required</small>
        )}
      </span>
    </label>
  );
}

export function ReviewForm({
  client,
  detail,
  onCancel,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  onCancel: () => void;
  onRecorded: () => void;
}) {
  const version = detail.current.versionNumber;
  const label = versionLabel(detail.current);
  const received = (detail.current.body as DocumentBody).origin === 'received';
  const attachedHere = detail.attachments.filter((attachment) => attachment.documentVersion?.versionNumber === version);
  const earlier = detail.attachments.filter((attachment) => attachment.documentVersion?.versionNumber !== version);
  const [basis, setBasis] = useState<SmsBasis>(detail.basis);
  const [attachmentIds, setAttachmentIds] = useState<string[]>(() =>
    attachedHere.filter(signable).map((attachment) => attachment.id),
  );
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand(client);
  const choose = (id: string) => (checked: boolean) =>
    setAttachmentIds(checked ? [...attachmentIds, id] : attachmentIds.filter((entry) => entry !== id));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!confirmed && !command.unknownResult) return;
    const result = await command.submit({
      kind: 'decision.record',
      subject: { kind: 'sms', id: detail.record.id },
      expectedRevision: basis.revision,
      expectedDependencyBasis: basis.dependencyBasis,
      decision: {
        kind: 'document.review',
        versionNumber: version,
        attachmentIds,
        note: note.trim(),
      },
    });
    if (result) onRecorded();
  }
  return (
    <form
      className="action-form safety-form sms-review-form"
      aria-label="Review document revision"
      onSubmit={(event) => void save(event)}
    >
      <h3>Review {label}</h3>
      <p className="safety-form-note">
        {received
          ? "Check the issuer's file against the details above, then choose the exact files to sign and issue."
          : 'Check the text and details above, then choose the exact files to sign and issue.'}{' '}
        The review freezes them for the adoption signature.
      </p>
      <fieldset className="sms-controls">
        <legend>Files attached to {label}</legend>
        {attachedHere.map((attachment) => (
          <ReviewFileChoice
            key={attachment.id}
            attachment={attachment}
            checked={attachmentIds.includes(attachment.id)}
            onChange={choose(attachment.id)}
          />
        ))}
        {attachedHere.length === 0 && (
          <p className="rail-muted">
            {received
              ? "No files are attached to this revision. Attach the issuer's file first."
              : 'No files are attached to this revision. Attach one first, or review the text.'}
          </p>
        )}
      </fieldset>
      {earlier.length > 0 && (
        <details
          className="sms-review-earlier"
          open={earlier.some((attachment) => attachmentIds.includes(attachment.id))}
        >
          <summary>Files from earlier revisions · {earlier.length}</summary>
          <p className="safety-form-note">Select one only if this revision still uses it unchanged.</p>
          {earlier.map((attachment) => (
            <ReviewFileChoice
              key={attachment.id}
              attachment={attachment}
              checked={attachmentIds.includes(attachment.id)}
              onChange={choose(attachment.id)}
            />
          ))}
        </details>
      )}
      <label>
        Review note
        <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} required />
      </label>
      <label className="sms-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          required={!command.unknownResult}
        />
        {received
          ? 'I reviewed the selected files and details for this revision.'
          : 'I reviewed the working text and selected files for this revision.'}
      </label>
      <DocumentBasisNotice
        detail={detail}
        basis={basis}
        disabled={command.pending || command.unknownResult}
        onReview={() => {
          setBasis(detail.basis);
          setConfirmed(false);
          command.setFailure(null);
        }}
      />
      <FailureNotice failure={command.failure} />
      <div className="sms-form-actions">
        {command.unknownResult ? (
          <Button
            kind="primary"
            type="button"
            disabled={command.pending}
            onClick={() => {
              void command.retry().then((result) => {
                if (result) onRecorded();
              });
            }}
          >
            {command.pending ? 'Retrying…' : 'Retry exact review request'}
          </Button>
        ) : (
          <Button kind="primary" type="submit" disabled={command.pending || (!command.unknownResult && !confirmed)}>
            {command.pending ? 'Recording…' : 'Record review'}
          </Button>
        )}
        <Button kind="quiet" type="button" disabled={command.pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function IssueForm({
  client,
  detail,
  home,
  adoptionId,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  adoptionId: string;
  onRecorded: () => void;
}) {
  const [basis, setBasis] = useState<SmsBasis>(detail.basis);
  const [effective, setEffective] = useState('');
  const [until, setUntil] = useState('');
  const [deadline, setDeadline] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand(client);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!confirmed && !command.unknownResult) return;
    try {
      const result = await command.submit({
        kind: 'decision.record',
        subject: { kind: 'sms', id: detail.record.id },
        expectedRevision: basis.revision,
        expectedDependencyBasis: basis.dependencyBasis,
        decision: {
          kind: 'document.issue',
          versionNumber: detail.current.versionNumber,
          adoptionId,
          ...(effective ? { effectiveFrom: fromCentralDateTimeInput(effective) } : {}),
          ...(until ? { effectiveUntil: fromCentralDateTimeInput(until) } : {}),
          recipientIds: recipients,
          ...(deadline ? { acknowledgementDueAt: fromCentralDateTimeInput(deadline) } : {}),
          note: note.trim(),
        },
      });
      if (result) onRecorded();
    } catch (error) {
      command.setFailure(plainError(error));
    }
  }
  return (
    <form
      className="action-form safety-form"
      aria-label="Issue document revision"
      onSubmit={(event) => void save(event)}
    >
      <h3>Issue {versionLabel(detail.current)}</h3>
      <p className="safety-form-note">
        The signed revision and its files become the controlled issue. A scheduled replacement leaves today's issue in
        force until its effective time.
      </p>
      <label>
        Effective from · {timeZoneName()} time
        <input type="datetime-local" value={effective} onChange={(event) => setEffective(event.target.value)} />
      </label>
      <p className="safety-form-note">Leave blank to issue immediately. An issue cannot be backdated.</p>
      <label>
        Effective until · {timeZoneName()} time (optional)
        <input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} />
      </label>
      <RecipientPicker home={home} selected={recipients} onChange={setRecipients} />
      <label>
        Acknowledgement due · {timeZoneName()} time (optional)
        <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
      </label>
      <label>
        Issue note
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} required />
      </label>
      <label className="sms-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          required={!command.unknownResult}
        />
        I reviewed the signed revision, effective dates and named readers.
      </label>
      <DocumentBasisNotice
        detail={detail}
        basis={basis}
        disabled={command.pending || command.unknownResult}
        onReview={() => {
          setBasis(detail.basis);
          setConfirmed(false);
          command.setFailure(null);
        }}
      />
      <FailureNotice failure={command.failure} />
      {command.unknownResult ? (
        <Button
          kind="primary"
          type="button"
          disabled={command.pending}
          onClick={() => {
            void command.retry().then((result) => {
              if (result) onRecorded();
            });
          }}
        >
          {command.pending ? 'Retrying…' : 'Retry exact issue request'}
        </Button>
      ) : (
        <Button kind="primary" type="submit" disabled={command.pending || (!command.unknownResult && !confirmed)}>
          {command.pending ? 'Issuing…' : effective ? 'Schedule issue' : 'Issue now'}
        </Button>
      )}
    </form>
  );
}

function DistributionForm({
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
  const issues = (detail.documentControl?.issues ?? []).filter((issue) =>
    ['current', 'scheduled'].includes(issue.status),
  );
  const [basis, setBasis] = useState<SmsBasis>(detail.basis);
  const [issueId, setIssueId] = useState(detail.documentControl?.effectiveIssue?.id ?? issues[0]?.id ?? '');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [deadline, setDeadline] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand(client);
  const issue = issues.find((entry) => entry.id === issueId);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!issue || (!confirmed && !command.unknownResult)) return;
    try {
      const result = await command.submit({
        kind: 'decision.record',
        subject: { kind: 'sms', id: detail.record.id },
        expectedRevision: basis.revision,
        expectedDependencyBasis: basis.dependencyBasis,
        decision: {
          kind: 'document.distribute',
          issueId: issue.id,
          recipientIds: recipients,
          ...(deadline ? { acknowledgementDueAt: fromCentralDateTimeInput(deadline) } : {}),
          note: note.trim(),
        },
      });
      if (result) onRecorded();
    } catch (error) {
      command.setFailure(plainError(error));
    }
  }
  return (
    <form className="action-form safety-form" aria-label="Distribute document" onSubmit={(event) => void save(event)}>
      <h3>Add readers</h3>
      <label>
        Issue
        <select
          value={issueId}
          onChange={(event) => {
            setIssueId(event.target.value);
            setRecipients([]);
          }}
        >
          {issues.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {issueLabel(entry)} · {issueStatusLabel(entry)}
            </option>
          ))}
        </select>
      </label>
      <RecipientPicker
        home={home}
        selected={recipients}
        excluded={issue?.recipients.map((entry) => entry.id)}
        onChange={setRecipients}
      />
      <label>
        Acknowledgement due · {timeZoneName()} time (optional)
        <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
      </label>
      <label>
        Distribution note
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} required />
      </label>
      <label className="sms-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          required={!command.unknownResult}
        />
        Assign these readers to the selected issued revision.
      </label>
      <DocumentBasisNotice
        detail={detail}
        basis={basis}
        disabled={command.pending || command.unknownResult}
        onReview={() => {
          setBasis(detail.basis);
          setConfirmed(false);
          command.setFailure(null);
        }}
      />
      <FailureNotice failure={command.failure} />
      {command.unknownResult ? (
        <Button
          kind="next"
          type="button"
          disabled={command.pending}
          onClick={() => {
            void command.retry().then((result) => {
              if (result) onRecorded();
            });
          }}
        >
          {command.pending ? 'Retrying…' : 'Retry exact distribution request'}
        </Button>
      ) : (
        <Button
          kind="next"
          type="submit"
          disabled={command.pending || (!command.unknownResult && (!recipients.length || !confirmed))}
        >
          {command.pending ? 'Assigning…' : 'Assign reading'}
        </Button>
      )}
    </form>
  );
}

function WithdrawForm({
  client,
  detail,
  scheduled,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  scheduled: SmsDocumentIssue[];
  onRecorded: () => void;
}) {
  const [basis, setBasis] = useState<SmsBasis>(detail.basis);
  const [issueId, setIssueId] = useState(scheduled[0]!.id);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand(client);
  const issue = scheduled.find((entry) => entry.id === issueId);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!issue || (!confirmed && !command.unknownResult)) return;
    const result = await command.submit({
      kind: 'decision.record',
      subject: { kind: 'sms', id: detail.record.id },
      expectedRevision: basis.revision,
      expectedDependencyBasis: basis.dependencyBasis,
      decision: { kind: 'document.withdraw', issueId: issue.id, note: note.trim() },
    });
    if (result) onRecorded();
  }
  return (
    <form
      className="action-form safety-form"
      aria-label="Withdraw scheduled issue"
      onSubmit={(event) => void save(event)}
    >
      <h3>Withdraw a scheduled issue</h3>
      <p className="safety-form-note">
        A withdrawn issue never takes effect. Its readers are released and the record keeps what was scheduled. The
        signed revision can then be issued again with new dates or readers.
      </p>
      {scheduled.length > 1 ? (
        <label>
          Scheduled issue
          <select value={issueId} onChange={(event) => setIssueId(event.target.value)}>
            {scheduled.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {issueLabel(entry)} · effective {documentTime(entry.effectiveFrom)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        issue && (
          <p>
            <strong>{issueLabel(issue)}</strong> · effective {documentTime(issue.effectiveFrom)} ·{' '}
            {issue.recipients.length} {issue.recipients.length === 1 ? 'reader' : 'readers'}
          </p>
        )
      )}
      <label>
        Reason for withdrawal
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} required />
      </label>
      <label className="sms-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          required={!command.unknownResult}
        />
        Withdraw this issue before it takes effect.
      </label>
      <DocumentBasisNotice
        detail={detail}
        basis={basis}
        disabled={command.pending || command.unknownResult}
        onReview={() => {
          setBasis(detail.basis);
          setConfirmed(false);
          command.setFailure(null);
        }}
      />
      <FailureNotice failure={command.failure} />
      {command.unknownResult ? (
        <Button
          kind="next"
          type="button"
          disabled={command.pending}
          onClick={() => {
            void command.retry().then((result) => {
              if (result) onRecorded();
            });
          }}
        >
          {command.pending ? 'Retrying…' : 'Retry exact withdrawal request'}
        </Button>
      ) : (
        <Button kind="next" type="submit" disabled={command.pending || !confirmed}>
          {command.pending ? 'Withdrawing…' : 'Withdraw issue'}
        </Button>
      )}
    </form>
  );
}

const nextYear = () =>
  centralDateTimeInput(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()).slice(0, 16);

function PeriodicReviewForm({
  client,
  detail,
  issue,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  issue: SmsDocumentIssue;
  onRecorded: () => void;
}) {
  const [basis, setBasis] = useState<SmsBasis>(detail.basis);
  const [next, setNext] = useState(nextYear);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useCommand(client);
  const dueAt = detail.documentControl?.reviewDueAt;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!confirmed && !command.unknownResult) return;
    try {
      const result = await command.submit({
        kind: 'decision.record',
        subject: { kind: 'sms', id: detail.record.id },
        expectedRevision: basis.revision,
        expectedDependencyBasis: basis.dependencyBasis,
        decision: {
          kind: 'document.periodic-review',
          issueId: issue.id,
          nextReviewDueAt: fromCentralDateTimeInput(next),
          note: note.trim(),
        },
      });
      if (result) onRecorded();
    } catch (error) {
      command.setFailure(plainError(error));
    }
  }
  return (
    <form
      className="action-form safety-form"
      aria-label="Record periodic review"
      onSubmit={(event) => void save(event)}
    >
      <h3>Periodic review of {issueLabel(issue)}</h3>
      <p className="safety-form-note">
        Record that the revision in force was reviewed and remains current. If it needs changes, record a new revision
        instead; it is reviewed, signed and issued like any other.
      </p>
      {dueAt && (
        <p className="safety-form-note">
          Review {isPast(dueAt) ? 'was due' : 'due'} <strong>{documentTime(dueAt)}</strong>
        </p>
      )}
      <label>
        Next review due · {timeZoneName()} time
        <input type="datetime-local" value={next} onChange={(event) => setNext(event.target.value)} required />
      </label>
      <label>
        What was reviewed
        <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} required />
      </label>
      <label className="sms-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          required={!command.unknownResult}
        />
        I reviewed {issueLabel(issue)} in force and it remains current.
      </label>
      <DocumentBasisNotice
        detail={detail}
        basis={basis}
        disabled={command.pending || command.unknownResult}
        onReview={() => {
          setBasis(detail.basis);
          setConfirmed(false);
          command.setFailure(null);
        }}
      />
      <FailureNotice failure={command.failure} />
      {command.unknownResult ? (
        <Button
          kind="next"
          type="button"
          disabled={command.pending}
          onClick={() => {
            void command.retry().then((result) => {
              if (result) onRecorded();
            });
          }}
        >
          {command.pending ? 'Retrying…' : 'Retry exact review request'}
        </Button>
      ) : (
        <Button kind="next" type="submit" disabled={command.pending || !confirmed || !next}>
          {command.pending ? 'Recording…' : 'Record periodic review'}
        </Button>
      )}
    </form>
  );
}

export type DocumentForm =
  'review' | 'issue' | 'distribute' | 'withdraw' | 'periodic' | 'edit' | 'attach' | 'links' | 'close' | 'reopen';

const cancelLabels: Partial<Record<DocumentForm, string>> = {
  review: 'Cancel review',
  issue: 'Cancel issuing',
  distribute: 'Cancel adding readers',
  periodic: 'Cancel periodic review',
  edit: 'Cancel new revision',
};

interface NextStep {
  text: string;
  action?: { label: string; form?: DocumentForm; sign?: true };
}

function nextStep(
  detail: SmsRecordDetailResponse,
  state: DocumentState,
  home: SmsHomeResponse,
  writable: boolean,
): NextStep {
  const label = versionLabel(state.working);
  const { effective } = state;
  if (detail.record.status === 'closed')
    return {
      text: 'This document is retired. Reopen it to review, sign and issue it again; earlier issues stay retired and every acknowledgement stays on record.',
      action: detail.actions.reopen.available ? { label: 'Reopen document', form: 'reopen' } : undefined,
    };
  switch (state.stage) {
    case 'draft':
      return {
        text: `Review ${label}: check its text and details, then choose the exact files to sign.`,
        action: writable ? { label: 'Review revision', form: 'review' } : undefined,
      };
    case 'reviewed':
      return detail.actions.adopt.available
        ? {
            text: `${label} is reviewed and its files are frozen. Sign to adopt it.`,
            action: { label: 'Review and sign adoption', sign: true },
          }
        : { text: `${label} is reviewed. It is waiting for a signature from ${adopterNames(home)}.` };
    case 'signed':
      return {
        text: `${label} is signed. Set when it takes effect and who must read it.`,
        action: writable ? { label: 'Issue revision', form: 'issue' } : undefined,
      };
    case 'signed_unreviewed':
      return {
        text: `${label} was signed before a controlled review was recorded, so it cannot be issued. Record a new revision, review its files and sign it.`,
        action: detail.actions.revise.available ? { label: 'Record a new revision', form: 'edit' } : undefined,
      };
    case 'scheduled':
      return {
        text: `${label} takes effect ${documentTime(state.workingIssue!.effectiveFrom)}. Add readers now, or withdraw it before then to change its dates.`,
      };
  }
  if (!effective)
    return {
      text: 'No revision is in force. Record a new revision to issue a replacement.',
      action: detail.actions.revise.available ? { label: 'Record a new revision', form: 'edit' } : undefined,
    };
  const review = reviewState(detail.documentControl?.reviewDueAt ?? null);
  if (review && writable)
    return {
      text: `Periodic review of ${issueLabel(effective)} ${review === 'overdue' ? 'was due' : 'is due'} ${documentTime(detail.documentControl!.reviewDueAt!)}.`,
      action: { label: 'Record periodic review', form: 'periodic' },
    };
  if (!effective.recipients.length && writable)
    return {
      text: `${issueLabel(effective)} is in force, but no one is assigned to read it.`,
      action: { label: 'Add readers', form: 'distribute' },
    };
  const unread = effective.recipients.filter((recipient) => !recipient.acknowledgedAt).length;
  return {
    text: unread
      ? `${issueLabel(effective)} is in force. ${unread} of ${counted(effective.recipients.length, 'reader')} ${unread === 1 ? 'has' : 'have'} not acknowledged it yet.`
      : `Nothing is waiting. ${issueLabel(effective)} is in force and every reader has acknowledged it.`,
  };
}

function RevisionProgress({ state, home }: { state: DocumentState; home: SmsHomeResponse }) {
  const steps = [
    {
      label: 'Reviewed',
      done: state.review,
      waiting: 'Waiting for review',
    },
    {
      label: 'Signed',
      done: state.adoption,
      waiting: state.review ? `Waiting for ${adopterNames(home)}` : 'After review',
    },
    { label: 'Issued', done: undefined, waiting: state.adoption ? 'Ready to issue' : 'After signature' },
  ];
  return (
    <ol className="sms-steps" aria-label={`${versionLabel(state.working)} progress`}>
      {steps.map((step) => (
        <li key={step.label} className={step.done ? 'is-recorded' : undefined}>
          <span>{step.label}</span>
          <small>
            {step.done ? (
              <>
                {step.done.actor.name} · <span className="mono">{documentDate(step.done.recordedAt)}</span>
              </>
            ) : (
              step.waiting
            )}
          </small>
        </li>
      ))}
    </ol>
  );
}

function RailAction({
  label,
  form,
  current,
  action,
  onToggle,
}: {
  label: string;
  form: DocumentForm;
  current: DocumentForm | null;
  action?: { available: boolean; reason?: string };
  onToggle: (form: DocumentForm) => void;
}) {
  return (
    <Button
      aria-expanded={current === form}
      disabled={action ? !action.available : false}
      title={action?.reason}
      onClick={() => onToggle(form)}
    >
      {label}
    </Button>
  );
}

function attachTarget(state: DocumentState): string {
  const label = `${versionLabel(state.working)} (Ledger version ${state.working.versionNumber})`;
  if (state.workingIssue)
    return `New files attach to ${label}, which is already issued; its issued files do not change. Record a new revision to issue a new file.`;
  if (state.review)
    return `New files attach to ${label}. Its reviewed files are frozen; review it again to include them.`;
  return `New files attach to ${label}, the working draft.`;
}

export function SmsDocumentRail({
  client,
  detail,
  principal,
  home,
  form,
  onToggle,
  onSign,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  principal: Principal;
  home: SmsHomeResponse;
  form: DocumentForm | null;
  onToggle: (form: DocumentForm) => void;
  onSign: () => void;
  onRecorded: () => void;
}) {
  const state = documentState(detail);
  const retired = detail.record.status === 'closed';
  const writable =
    (['sms:write', 'decision:write'] as const).every((capability) => principal.capabilities.includes(capability)) &&
    !retired;
  const step = nextStep(detail, state, home, writable);
  const primary = step.action?.form;
  const issues = detail.documentControl?.issues ?? [];
  const shows = (candidate: DocumentForm) => candidate !== primary;
  const actions = detail.actions;
  const unavailable = [actions.revise, actions.attach, actions.link].find((action) => !action.available)?.reason;
  return (
    <>
      <section className="safety-next-action sms-next-step">
        <span className="safety-stage-label">Next step</span>
        <p>{step.text}</p>
        {!retired && isUnissued(state.stage) && <RevisionProgress state={state} home={home} />}
        {step.action?.form && form === step.action.form ? (
          <Button kind="secondary" onClick={() => onToggle(step.action!.form!)}>
            {cancelLabels[step.action.form] ?? 'Cancel'}
          </Button>
        ) : (
          step.action && (
            <Button
              kind="primary"
              aria-expanded={step.action.form ? form === step.action.form : undefined}
              onClick={() => (step.action!.sign ? onSign() : onToggle(step.action!.form!))}
            >
              {step.action.label}
            </Button>
          )
        )}
        {state.stage === 'reviewed' && !actions.adopt.available && (
          <p className="rail-muted" data-testid="adopt-unavailable">
            {actions.adopt.reason}
          </p>
        )}
        {!writable && !retired && (
          <p className="rail-muted">
            Reviewing, issuing and assigning readers need permission to edit records and record decisions.
          </p>
        )}
      </section>
      {primary && primary !== 'review' && (
        <DocumentRailForm
          client={client}
          detail={detail}
          home={home}
          form={form}
          only={primary}
          onRecorded={onRecorded}
        />
      )}
      {writable && (issues.some(isActive) || state.effective) && (
        <section className="safety-next-action">
          <span className="safety-stage-label">Readers and review</span>
          <div className="sms-rail-buttons">
            {issues.some(isActive) && shows('distribute') && (
              <RailAction label="Add readers" form="distribute" current={form} onToggle={onToggle} />
            )}
            {state.effective && shows('periodic') && (
              <RailAction label="Record periodic review" form="periodic" current={form} onToggle={onToggle} />
            )}
            {state.scheduled.length > 0 && (
              <RailAction label="Withdraw scheduled issue" form="withdraw" current={form} onToggle={onToggle} />
            )}
          </div>
        </section>
      )}
      <DocumentRailForm
        client={client}
        detail={detail}
        home={home}
        form={form}
        only={['distribute', 'periodic', 'withdraw']}
        except={primary}
        onRecorded={onRecorded}
      />
      {!retired && (
        <section className="safety-next-action">
          <span className="safety-stage-label">Revision</span>
          <div className="sms-rail-buttons">
            {writable && state.stage === 'reviewed' && (
              <RailAction label="Review revision again" form="review" current={form} onToggle={onToggle} />
            )}
            {shows('edit') && (
              <RailAction
                label="Record a new revision"
                form="edit"
                current={form}
                action={actions.revise}
                onToggle={onToggle}
              />
            )}
            <RailAction
              label="Attach a file"
              form="attach"
              current={form}
              action={actions.attach}
              onToggle={onToggle}
            />
            <RailAction label="Change links" form="links" current={form} action={actions.link} onToggle={onToggle} />
          </div>
          {actions.attach.available && <p className="rail-muted">{attachTarget(state)}</p>}
          {unavailable && <p className="rail-muted">{unavailable}</p>}
        </section>
      )}
      <DocumentRailForm
        client={client}
        detail={detail}
        home={home}
        form={form}
        only={['edit', 'attach', 'links']}
        except={primary}
        onRecorded={onRecorded}
      />
      {!retired && actions.close.available && (
        <section className="safety-next-action sms-retire">
          <span className="safety-stage-label">Retire</span>
          <p>
            Ends the revision in force for every reader. Its issues, signatures and acknowledgements stay on record.
          </p>
          <Button kind="quiet" aria-expanded={form === 'close'} onClick={() => onToggle('close')}>
            Retire document
          </Button>
        </section>
      )}
      <DocumentRailForm
        client={client}
        detail={detail}
        home={home}
        form={form}
        only={['close']}
        onRecorded={onRecorded}
      />
    </>
  );
}

function DocumentRailForm({
  client,
  detail,
  home,
  form,
  only,
  except,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  form: DocumentForm | null;
  only: DocumentForm | DocumentForm[];
  except?: DocumentForm;
  onRecorded: () => void;
}) {
  const allowed = Array.isArray(only) ? only : [only];
  if (!form || !allowed.includes(form) || form === except) return null;
  return (
    <RailFormFrame key={form}>
      <RailFormBody client={client} detail={detail} home={home} form={form} onRecorded={onRecorded} />
    </RailFormFrame>
  );
}

function RailFormFrame({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    frame.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  return (
    <div className="sms-rail-form" ref={frame}>
      {children}
    </div>
  );
}

function RailFormBody({
  client,
  detail,
  home,
  form,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  home: SmsHomeResponse;
  form: DocumentForm;
  onRecorded: () => void;
}) {
  const state = documentState(detail);
  const effective = state.effective;
  switch (form) {
    case 'issue':
      return state.adoption ? (
        <IssueForm client={client} detail={detail} home={home} adoptionId={state.adoption.id} onRecorded={onRecorded} />
      ) : null;
    case 'distribute':
      return <DistributionForm client={client} detail={detail} home={home} onRecorded={onRecorded} />;
    case 'withdraw':
      return state.scheduled.length ? (
        <WithdrawForm client={client} detail={detail} scheduled={state.scheduled} onRecorded={onRecorded} />
      ) : null;
    case 'periodic':
      return effective ? (
        <PeriodicReviewForm client={client} detail={detail} issue={effective} onRecorded={onRecorded} />
      ) : null;
    case 'edit':
      return <ReviseForm client={client} detail={detail} home={home} onRecorded={onRecorded} />;
    case 'attach':
      return <AttachmentForm client={client} detail={detail} onRecorded={onRecorded} />;
    case 'links':
      return <LinkForm client={client} detail={detail} onRecorded={onRecorded} />;
    case 'close':
    case 'reopen':
      return <StatusForm client={client} detail={detail} closing={form === 'close'} onRecorded={onRecorded} />;
    default:
      return null;
  }
}

export function MyDocumentReading({
  reading,
  onOpen,
}: {
  reading: SmsDocumentAssignment[];
  onOpen: (assignment: SmsDocumentAssignment) => void;
}) {
  const required = reading.filter((entry) => !entry.acknowledgedAt);
  return (
    <section className="safety-section sms-attention" aria-label="My reading">
      <div className="safety-section-heading">
        <h3>
          My reading <span className="sms-count sms-count--quiet">{required.length}</span>
        </h3>
      </div>
      <p className="muted">
        Controlled revisions assigned to you. Open the exact issued content before acknowledging it.
      </p>
      {required.length === 0 ? (
        <p className="sms-empty">No documents are waiting on your acknowledgement.</p>
      ) : (
        <div className="hazard-register">
          {required.map((assignment) => (
            <button
              type="button"
              className="hazard-row sms-row"
              key={assignment.issueId}
              onClick={() => onOpen(assignment)}
            >
              <span>
                <strong>{assignment.title}</strong>
                <small>
                  {assignment.revisionLabel ?? `Version ${assignment.versionNumber}`} ·{' '}
                  {assignment.status === 'scheduled'
                    ? `Effective ${documentTime(assignment.effectiveFrom)}`
                    : 'In force'}
                  {assignment.dueAt ? ` · due ${documentTime(assignment.dueAt)}` : ''}
                </small>
              </span>
              <span className="sms-row-facts">
                {assignment.dueAt && isPast(assignment.dueAt) && <Badge tone="attention">Overdue</Badge>}
                <span className="sms-row-action">Read and acknowledge →</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function OrganizationReading({
  progress,
  people,
  onOpen,
}: {
  progress: SmsDocumentReadingProgress[];
  people: SmsPersonReading[];
  onOpen: (entry: { recordId: string; issueId: string }) => void;
}) {
  const [view, setView] = useState<'documents' | 'people'>('documents');
  return (
    <section className="safety-section sms-attention" aria-label="Reading across the organization">
      <div className="safety-section-heading">
        <h3>
          Reading across the organization{' '}
          <span className="sms-count sms-count--quiet">{view === 'people' ? people.length : progress.length}</span>
        </h3>
        {progress.length > 0 && (
          <div className="roster-views sms-reading-views" aria-label="Group reading by">
            <button type="button" aria-pressed={view === 'documents'} onClick={() => setView('documents')}>
              By document
            </button>
            <button type="button" aria-pressed={view === 'people'} onClick={() => setView('people')}>
              By person
            </button>
          </div>
        )}
      </div>
      <p className="muted">
        {view === 'documents'
          ? 'Issued revisions that assigned readers have not all acknowledged, most overdue first.'
          : 'People with documents still to acknowledge, most overdue first.'}
      </p>
      {progress.length === 0 ? (
        <p className="sms-empty">Every assigned reader has acknowledged their current and scheduled issues.</p>
      ) : view === 'people' ? (
        <ul className="sms-person-reading">
          {people.map((entry) => (
            <li key={entry.person.id} data-testid={`sms-person-reading-${entry.person.id}`}>
              <div className="sms-person-reading-head">
                <strong>{entry.person.name}</strong>
                <span>
                  {entry.documents.length} to acknowledge
                  {entry.overdue > 0 && <Badge tone="attention">{entry.overdue} overdue</Badge>}
                </span>
              </div>
              <ul>
                {entry.documents.map((document) => (
                  <li key={document.issueId}>
                    <button type="button" className="sms-link-open" onClick={() => onOpen(document)}>
                      {document.title} · {document.revisionLabel ?? `Version ${document.versionNumber}`}
                    </button>
                    <small className={document.dueAt && isPast(document.dueAt) ? 'sms-overdue' : undefined}>
                      {document.dueAt
                        ? `${isPast(document.dueAt) ? 'Overdue since' : 'Due'} ${documentTime(document.dueAt)}`
                        : 'No deadline'}
                    </small>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hazard-register">
          {progress.map((entry) => (
            <button
              type="button"
              className="hazard-row sms-row"
              key={entry.issueId}
              data-testid={`sms-reading-progress-${entry.issueId}`}
              onClick={() => onOpen(entry)}
            >
              <span>
                <strong>{entry.title}</strong>
                <small>
                  {entry.revisionLabel ?? `Version ${entry.versionNumber}`} ·{' '}
                  {entry.status === 'scheduled' ? `Effective ${documentTime(entry.effectiveFrom)}` : 'In force'} ·{' '}
                  {entry.acknowledged} of {entry.assigned} acknowledged
                  {entry.nextDueAt && !isPast(entry.nextDueAt) ? ` · next due ${documentTime(entry.nextDueAt)}` : ''}
                </small>
              </span>
              <span className="sms-row-facts">
                {entry.overdue > 0 && (
                  <Badge tone="attention">
                    {entry.overdue} {entry.overdue === 1 ? 'reader' : 'readers'} overdue
                  </Badge>
                )}
                <span className="sms-row-action">See readers →</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function DocumentReviewsDue({
  reviews,
  onOpen,
}: {
  reviews: SmsDocumentReviewDue[];
  onOpen: (entry: SmsDocumentReviewDue) => void;
}) {
  return (
    <section className="safety-section sms-attention" aria-label="Documents due for periodic review">
      <div className="safety-section-heading">
        <h3>
          Documents due for periodic review <span className="sms-count sms-count--quiet">{reviews.length}</span>
        </h3>
      </div>
      <p className="muted">Revisions in force whose review date has passed or falls within 30 days.</p>
      {reviews.length === 0 ? (
        <p className="sms-empty">No document in force is due for review in the next 30 days.</p>
      ) : (
        <div className="hazard-register">
          {reviews.map((entry) => (
            <button
              type="button"
              className="hazard-row sms-row"
              key={entry.issueId}
              data-testid={`sms-review-due-${entry.recordId}`}
              onClick={() => onOpen(entry)}
            >
              <span>
                <strong>{entry.title}</strong>
                <small>
                  {entry.revisionLabel ?? `Version ${entry.versionNumber}`} in force · review{' '}
                  {entry.overdue ? 'was due' : 'due'} {documentDate(entry.reviewDueAt)}
                </small>
              </span>
              <span className="sms-row-facts">
                {entry.overdue && <Badge tone="attention">Review overdue</Badge>}
                <span className="sms-row-action">Review →</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
