import { useEffect, useRef, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  DocumentBody,
  Principal,
  SmsDecisionRecord,
  SmsDocumentDistributionOutcome,
  SmsDocumentIssue,
  SmsDocumentPeriodicReviewOutcome,
  SmsDocumentReviewOutcome,
  SmsRecordDetailResponse,
  SmsRecordVersion,
} from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { byteSize, json } from './format.js';
import { documentTypeLabels, plainError, saveBytes } from './sms-labels.js';
import { documentDate, documentTime, reviewState } from './sms-document-dates.js';
import { documentFileName } from './sms-document-reader.js';
import {
  carriedForward,
  documentAttention,
  documentState,
  documentTextName,
  revisionFieldLabels,
  isActive,
  isEnded,
  isPast,
  issueLabel,
  issueStatusLabel,
  isUnissued,
  stageLabel,
  versionLabel,
  type AttentionItem,
  type DocumentState,
} from './sms-document-state.js';
import { DocumentText } from './SmsDocumentText.js';
import { DocumentComparison } from './SmsDocumentCompare.js';
import { AcknowledgeIssue, ReviewForm } from './SmsDocumentControl.js';
import { SmsDocumentServes } from './SmsDocumentPurposes.js';

/** Document-level identity shown under the title; revision details live with each revision. */
export function DocumentIdentity({ detail }: { detail: SmsRecordDetailResponse }) {
  const state = documentState(detail);
  const body = (state.effectiveVersion ?? state.working).body as DocumentBody;
  return (
    <>
      {body.documentNumber && <span className="mono">{body.documentNumber}</span>}
      <span>{documentTypeLabels[body.documentType]}</span>
      <span>
        {body.origin === 'received' && body.source
          ? `Received from ${body.source.organization}`
          : 'Authored by our organization'}
      </span>
    </>
  );
}

export function SmsDocumentRecord({
  client,
  detail,
  principal,
  startIssueId,
  showReaders,
  reviewing,
  onCancelReview,
  onRead,
  onReadWorking,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  principal: Principal;
  startIssueId?: string;
  showReaders: boolean;
  reviewing: boolean;
  onCancelReview: () => void;
  onRead: (issueId: string) => void;
  onReadWorking: () => void;
  onRecorded: () => void;
}) {
  const state = documentState(detail);
  return (
    <>
      <InForceSummary
        client={client}
        detail={detail}
        principal={principal}
        state={state}
        showReaders={showReaders}
        onRead={onRead}
        onRecorded={onRecorded}
      />
      <RevisionView
        client={client}
        detail={detail}
        state={state}
        canManage={principal.capabilities.includes('sms:write') || principal.capabilities.includes('sms:adopt')}
        startIssueId={startIssueId}
        reviewing={reviewing}
        onCancelReview={onCancelReview}
        onReadWorking={onReadWorking}
        onRecorded={onRecorded}
      />
      <RevisionHistory detail={detail} onRead={onRead} />
    </>
  );
}

function InForceSummary({
  client,
  detail,
  principal,
  state,
  showReaders,
  onRead,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  principal: Principal;
  state: DocumentState;
  showReaders: boolean;
  onRead: (issueId: string) => void;
  onRecorded: () => void;
}) {
  const { effective } = state;
  const retired = detail.record.status === 'closed';
  const attention = documentAttention(detail, state);
  const mine = effective?.recipients.find((recipient) => recipient.id === principal.id);
  const mustAcknowledge = Boolean(mine && !mine.acknowledgedAt);
  const reviewDueAt = detail.documentControl?.reviewDueAt ?? null;
  const review = reviewState(reviewDueAt);
  return (
    <section className="sms-in-force" data-testid="sms-issued-document" aria-label="Revision in force">
      <div className="sms-in-force-head">
        <span className={`sms-state-word sms-state-word--${effective ? 'in-force' : 'none'}`}>
          {retired ? 'Retired' : effective ? 'In force' : 'Not in force'}
        </span>
        <h3>
          {effective
            ? `${issueLabel(effective)} in force`
            : retired
              ? 'No revision is in force'
              : 'No revision has been issued'}
        </h3>
        {effective && (
          <Button kind={mustAcknowledge ? 'next' : 'secondary'} onClick={() => onRead(effective.id)}>
            {mustAcknowledge ? 'Read and acknowledge' : 'Read document'}
          </Button>
        )}
      </div>
      <dl className="sms-ledger-rows">
        {effective && (
          <>
            <div>
              <dt>Effective</dt>
              <dd className="mono">
                {documentTime(effective.effectiveFrom)}
                {effective.effectiveUntil ? ` until ${documentTime(effective.effectiveUntil)}` : ' · no end date'}
              </dd>
            </div>
            <div>
              <dt>{effective.attachmentIds.length === 1 ? 'Issued file' : 'Issued files'}</dt>
              <dd>
                <IssueFiles client={client} detail={detail} attachmentIds={effective.attachmentIds} compact />
              </dd>
            </div>
            <div>
              <dt>Readers</dt>
              <dd>
                <ReadingCount issue={effective} />
              </dd>
            </div>
            <div>
              <dt>Next review</dt>
              <dd>
                {reviewDueAt ? (
                  <span className={review === 'overdue' ? 'sms-overdue mono' : 'mono'}>
                    {documentTime(reviewDueAt)}
                  </span>
                ) : (
                  <span className="muted">Not scheduled</span>
                )}
              </dd>
            </div>
          </>
        )}
        {state.scheduled
          .filter((issue) => issue.id !== effective?.id)
          .map((issue) => (
            <div key={issue.id}>
              <dt>Scheduled</dt>
              <dd>
                {issueLabel(issue)} takes effect <span className="mono">{documentTime(issue.effectiveFrom)}</span>
              </dd>
            </div>
          ))}
        {state.hasSuccessor && isUnissued(state.stage) && !retired && (
          <div>
            <dt>Working revision</dt>
            <dd>
              {versionLabel(state.working)} · {stageLabel(state)}
            </dd>
          </div>
        )}
      </dl>
      {attention.length > 0 && <AttentionList items={attention} />}
      {mine?.acknowledgedAt && (
        <p className="sms-in-force-note">
          You acknowledged {issueLabel(effective!)} on <span className="mono">{documentTime(mine.acknowledgedAt)}</span>
          .
        </p>
      )}
      {effective && mustAcknowledge && (
        <AcknowledgeIssue
          key={effective.id}
          client={client}
          detail={detail}
          issue={effective}
          principal={principal}
          onRecorded={onRecorded}
        />
      )}
      {[effective, ...state.scheduled]
        .filter((issue, index, all): issue is SmsDocumentIssue => Boolean(issue) && all.indexOf(issue) === index)
        .map((issue, index, shown) => (
          <ReadersTable
            key={issue.id}
            issue={issue}
            caption={shown.length > 1 ? `Readers of ${issueLabel(issue)}` : 'Readers'}
            scrollIntoView={showReaders && index === 0}
          />
        ))}
    </section>
  );
}

function ReadingCount({ issue }: { issue: SmsDocumentIssue }) {
  const acknowledged = issue.recipients.filter((recipient) => recipient.acknowledgedAt).length;
  const pending = issue.recipients.filter((recipient) => !recipient.acknowledgedAt && recipient.dueAt);
  const nextDue = pending
    .map((recipient) => recipient.dueAt!)
    .filter((due) => !isPast(due))
    .sort()[0];
  if (!issue.recipients.length) return <span className="muted">None assigned</span>;
  return (
    <>
      {acknowledged} of {issue.recipients.length} acknowledged
      {nextDue && (
        <span className="muted">
          {' '}
          · next due <span className="mono">{documentTime(nextDue)}</span>
        </span>
      )}
    </>
  );
}

function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="sms-attention-list" aria-label="Needs attention">
      {items.map((item) => (
        <li key={item.text} className={`sms-attention-item sms-attention-item--${item.tone}`}>
          <span className="sms-attention-mark" aria-hidden="true" />
          {item.text}
        </li>
      ))}
    </ul>
  );
}

type Recipient = SmsDocumentIssue['recipients'][number];

function readerOrder(recipient: Recipient): number {
  if (recipient.acknowledgedAt) return 2;
  return recipient.dueAt && isPast(recipient.dueAt) ? 0 : 1;
}

function ReaderRow({ issue, recipient }: { issue: SmsDocumentIssue; recipient: Recipient }) {
  const overdue = !recipient.acknowledgedAt && recipient.dueAt && isPast(recipient.dueAt);
  const state = recipient.acknowledgedAt
    ? 'Acknowledged'
    : !isActive(issue)
      ? 'Not acknowledged'
      : overdue
        ? 'Overdue'
        : 'Pending';
  const when = recipient.acknowledgedAt ?? recipient.dueAt;
  return (
    <tr>
      <th scope="row">{recipient.name}</th>
      <td className={overdue ? 'sms-overdue' : recipient.acknowledgedAt ? 'sms-recorded' : undefined}>{state}</td>
      <td className="mono">
        {when ? `${recipient.acknowledgedAt ? '' : 'due '}${documentTime(when)}` : 'No deadline'}
      </td>
    </tr>
  );
}

function ReadersTable({
  issue,
  caption,
  scrollIntoView,
}: {
  issue: SmsDocumentIssue;
  caption: string;
  scrollIntoView: boolean;
}) {
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    if (scrollIntoView) table.current?.scrollIntoView({ block: 'center' });
  }, [scrollIntoView]);
  if (!issue.recipients.length) return null;
  const readers = [...issue.recipients].sort((a, b) => readerOrder(a) - readerOrder(b) || a.name.localeCompare(b.name));
  const outstanding = readers.filter((recipient) => !recipient.acknowledgedAt);
  const acknowledged = readers.filter((recipient) => recipient.acknowledgedAt);
  const foldAcknowledged = readers.length > 8 && acknowledged.length > 0;
  return (
    <>
      <table className="sms-ledger-table" ref={table} aria-label={caption}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Reader</th>
            <th scope="col">State</th>
            <th scope="col">Date</th>
          </tr>
        </thead>
        <tbody>
          {(foldAcknowledged ? outstanding : readers).map((recipient) => (
            <ReaderRow key={recipient.id} issue={issue} recipient={recipient} />
          ))}
        </tbody>
      </table>
      {foldAcknowledged && (
        <details className="safety-history">
          <summary>{acknowledged.length} acknowledged</summary>
          <table className="sms-ledger-table">
            <tbody>
              {acknowledged.map((recipient) => (
                <ReaderRow key={recipient.id} issue={issue} recipient={recipient} />
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

export function IssueFiles({
  client,
  detail,
  attachmentIds,
  compact = false,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  attachmentIds: string[];
  compact?: boolean;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  async function download(attachment: SmsRecordDetailResponse['attachments'][number]) {
    setFailure(null);
    try {
      const { bytes } = await client.download(`/v1/sms/attachments/${encodeURIComponent(attachment.id)}/content`);
      saveBytes(bytes, documentFileName(attachment), attachment.contentType);
    } catch (error) {
      setFailure(plainError(error).message);
    }
  }
  if (attachmentIds.length === 0)
    return <span className="muted">No files. The document text is the issued content.</span>;
  return (
    <>
      {failure && (
        <Notice tone="alert" title="File unavailable">
          {failure}
        </Notice>
      )}
      <ul className={compact ? 'sms-file-lines' : 'sms-attachments'}>
        {attachmentIds.map((id) => {
          const attachment = detail.attachments.find((entry) => entry.id === id);
          if (!attachment) return <li key={id}>Retained file unavailable.</li>;
          return (
            <li key={id}>
              <span>
                <strong>{attachment.label}</strong>
                <small className="mono">{byteSize(attachment.byteLength)}</small>
              </span>
              {attachment.readable ? (
                <Button kind="quiet" onClick={() => void download(attachment)}>
                  Download original
                </Button>
              ) : (
                <small className="rail-muted">Permission is required to read this file.</small>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

type RevisionTab = 'in_force' | 'working' | 'compare';

function RevisionView({
  client,
  detail,
  state,
  canManage,
  startIssueId,
  reviewing,
  onCancelReview,
  onReadWorking,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  state: DocumentState;
  canManage: boolean;
  startIssueId?: string;
  reviewing: boolean;
  onCancelReview: () => void;
  onReadWorking: () => void;
  onRecorded: () => void;
}) {
  const { effective, effectiveVersion, working } = state;
  const [chosen, setChosen] = useState<RevisionTab | null>(() =>
    startIssueId && effective ? (startIssueId === effective.id ? 'in_force' : 'working') : null,
  );
  const [shownVersion, setShownVersion] = useState(working.versionNumber);
  if (shownVersion !== working.versionNumber) {
    setShownVersion(working.versionNumber);
    setChosen(null);
  }
  const draftNeedsWork = canManage && state.hasSuccessor && isUnissued(state.stage);
  const automatic: RevisionTab = effective && !draftNeedsWork ? 'in_force' : 'working';
  const section = useRef<HTMLElement>(null);
  const tabs: { value: RevisionTab; label: string; detail: string }[] = [
    ...(effective ? [{ value: 'in_force' as const, label: 'In force', detail: issueLabel(effective) }] : []),
    ...(state.hasSuccessor
      ? [{ value: 'working' as const, label: workingTabLabel(state), detail: versionLabel(working) }]
      : []),
    ...(detail.versions.length > 1 ? [{ value: 'compare' as const, label: 'Compare', detail: '' }] : []),
  ];
  const wanted = reviewing ? 'working' : (chosen ?? automatic);
  const tab = tabs.some((entry) => entry.value === wanted) ? wanted : (tabs[0]?.value ?? 'working');
  useEffect(() => {
    if (reviewing) section.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [reviewing]);
  return (
    <section className="safety-section sms-revision" data-testid="sms-revision" ref={section}>
      <div className="safety-section-heading">
        <h3>Revision</h3>
      </div>
      {tabs.length > 1 && (
        <div className="thread-tabs sms-revision-tabs" role="group" aria-label="Show revision">
          {tabs.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className="thread-tab"
              aria-pressed={tab === entry.value}
              disabled={reviewing && entry.value !== 'working'}
              onClick={() => setChosen(entry.value)}
            >
              {entry.label}
              {entry.detail && <span className="tab-count">{entry.detail}</span>}
            </button>
          ))}
        </div>
      )}
      {tab === 'compare' ? (
        <DocumentComparison client={client} detail={detail} />
      ) : tab === 'in_force' && effective && effectiveVersion ? (
        <RevisionPanel client={client} detail={detail} version={effectiveVersion} issue={effective} />
      ) : (
        <div data-testid="sms-working-document">
          <RevisionPanel
            client={client}
            detail={detail}
            version={working}
            issue={state.workingIssue}
            state={state}
            onRead={isUnissued(state.stage) ? onReadWorking : undefined}
          />
          {reviewing && (
            <ReviewForm client={client} detail={detail} onCancel={onCancelReview} onRecorded={onRecorded} />
          )}
        </div>
      )}
    </section>
  );
}

function workingTabLabel(state: DocumentState): string {
  switch (state.stage) {
    case 'draft':
      return 'Draft';
    case 'reviewed':
      return 'Reviewed draft';
    case 'signed':
    case 'signed_unreviewed':
      return 'Signed draft';
    case 'scheduled':
      return 'Scheduled';
    default:
      return state.workingIssue ? issueStatusLabel(state.workingIssue) : 'Latest';
  }
}

function RevisionPanel({
  client,
  detail,
  version,
  issue,
  state,
  onRead,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  version: SmsRecordVersion;
  issue?: SmsDocumentIssue;
  state?: DocumentState;
  onRead?: () => void;
}) {
  const body = version.body as DocumentBody;
  const signature = issue && detail.signatures.find((entry) => entry.decisionId === issue.adoptionId);
  const files = revisionFiles(detail, version, issue, state);
  const carried = carriedForward(detail, version);
  const effective = detail.documentControl?.effectiveIssue;
  const readable = Boolean(onRead && (files.ids.length || body.text));
  const signingNext = state?.stage === 'reviewed' && detail.actions.adopt.available;
  return (
    <div className="sms-revision-panel">
      <div className="sms-revision-line">
        {state && !issue && (
          <Badge tone={state.stage === 'draft' ? 'attention' : 'advisory'}>{stageLabel(state)}</Badge>
        )}
        {state && issue && issue.status === 'scheduled' && <Badge tone="advisory">{stageLabel(state)}</Badge>}
        <span>
          {issue ? (
            <>
              Issued <span className="mono">{documentTime(issue.issuedAt)}</span> by {issue.issuedBy.name}
              {signature && <> · signed by {signature.signer.name}</>} · effective{' '}
              <span className="mono">{documentTime(issue.effectiveFrom)}</span>
              {issue.effectiveUntil && (
                <>
                  {' '}
                  until <span className="mono">{documentTime(issue.effectiveUntil)}</span>
                </>
              )}
            </>
          ) : (
            <>
              Recorded <span className="mono">{documentTime(version.recordedAt)}</span> by {version.recordedBy.name}
              {effective && <>. It does not replace {issueLabel(effective)} in force until it is issued.</>}
            </>
          )}
        </span>
        {readable && (
          <span className="sms-revision-read">
            <Button kind={signingNext ? 'next' : 'secondary'} onClick={onRead}>
              Read {versionLabel(version)}
            </Button>
          </span>
        )}
      </div>
      <dl className="sms-ledger-rows">
        <div>
          <dt>Revision</dt>
          <dd>
            {versionLabel(version)} <span className="muted">· Ledger version {version.versionNumber}</span>
          </dd>
        </div>
        <div>
          <dt>{revisionFieldLabels(body).summary}</dt>
          <dd>{body.summary}</dd>
        </div>
        <SmsDocumentServes client={client} documentType={body.documentType} purposes={body.purposes ?? []} />
        {body.changeReason && (
          <div>
            <dt>{revisionFieldLabels(body).reason}</dt>
            <dd>{body.changeReason}</dd>
          </div>
        )}
        {body.source && (
          <>
            <div>
              <dt>Source</dt>
              <dd>
                {body.source.organization}
                {body.source.reference && <span className="mono"> · {body.source.reference}</span>} · revision{' '}
                {body.source.revision}
              </dd>
            </div>
            <div>
              <dt>Source issued</dt>
              <dd className="mono">
                {body.source.issuedAt ? documentTime(body.source.issuedAt) : <span className="muted">Not given</span>}
              </dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd className="mono">{documentTime(body.source.receivedAt)}</dd>
            </div>
          </>
        )}
      </dl>
      {carried.length > 0 && (
        <Notice title={`Repeated from the previous revision`}>
          This revision&apos;s {carried.join(', ')} {carried.length === 1 ? 'is' : 'are'} identical to the revision
          before it. Check {carried.length === 1 ? 'it' : 'them'} against the source document.
        </Notice>
      )}
      <h4 className="sms-subhead">{files.heading}</h4>
      {files.ids.length ? (
        <IssueFiles client={client} detail={detail} attachmentIds={files.ids} />
      ) : (
        <p className="muted">{files.empty}</p>
      )}
      {body.text && (
        <>
          <h4 className="sms-subhead">{documentTextName(body)}</h4>
          <p className="sms-text-role">{textRole(body, files.ids.length > 0, Boolean(issue))}</p>
          <DocumentText text={body.text} label={`${versionLabel(version)} ${documentTextName(body).toLowerCase()}`} />
        </>
      )}
    </div>
  );
}

function textRole(body: DocumentBody, hasFiles: boolean, issued: boolean): string {
  if (body.origin === 'received')
    return hasFiles
      ? "Your organization's notes on this revision. The file above is the document; readers acknowledge both."
      : "Your organization's notes on this revision. Attach the issuer's file; these notes do not replace it.";
  if (hasFiles) return `${issued ? 'Issued' : 'To be issued'} together with the files above.`;
  return issued ? 'This text is the issued content.' : 'This text is the content to review and sign.';
}

function revisionFiles(
  detail: SmsRecordDetailResponse,
  version: SmsRecordVersion,
  issue: SmsDocumentIssue | undefined,
  state: DocumentState | undefined,
): { heading: string; ids: string[]; empty: string } {
  if (issue)
    return {
      heading: issue.attachmentIds.length === 1 ? 'Issued file' : 'Issued files',
      ids: issue.attachmentIds,
      empty: 'This revision was issued without files.',
    };
  if (state?.review)
    return {
      heading: 'Files frozen at review',
      ids: (state.review.outcome as SmsDocumentReviewOutcome).attachments.map((file) => file.id),
      empty: 'The review selected no files; the text is the content to sign.',
    };
  return {
    heading: 'Files attached to this revision',
    ids: detail.attachments
      .filter((attachment) => attachment.documentVersion?.versionNumber === version.versionNumber)
      .map((attachment) => attachment.id),
    empty:
      (version.body as DocumentBody).origin === 'received'
        ? 'No file attached yet. Attach the source document before review.'
        : 'No files attached. The text is the content to review.',
  };
}

const decisionTitles: Partial<Record<SmsDecisionRecord['kind'], string>> = {
  'document.review': 'Reviewed',
  'document.adopt': 'Signed adoption',
  'document.issue': 'Issued',
  'document.distribute': 'Readers added',
  'document.withdraw': 'Scheduled issue withdrawn',
  'document.periodic-review': 'Periodic review: still current',
};

function decisionVersion(decision: SmsDecisionRecord, issues: SmsDocumentIssue[]): number | null {
  const outcome = decision.outcome as {
    document?: { versionNumber: number };
    versionNumber?: number;
    issueId?: string;
  };
  if (outcome.document) return outcome.document.versionNumber;
  if (outcome.versionNumber) return outcome.versionNumber;
  return issues.find((issue) => issue.id === outcome.issueId)?.versionNumber ?? null;
}

interface Step {
  label: string;
  at?: string;
  who?: string;
  note?: string;
}

function revisionSteps(
  version: SmsRecordVersion,
  decisions: SmsDecisionRecord[],
  issue: SmsDocumentIssue | undefined,
): Step[] {
  const latest = (kind: SmsDecisionRecord['kind']) => decisions.filter((decision) => decision.kind === kind).at(-1);
  const review = latest('document.review');
  const adoption = latest('document.adopt');
  return [
    { label: 'Recorded', at: version.recordedAt, who: version.recordedBy.name },
    { label: 'Reviewed', at: review?.recordedAt, who: review?.actor.name },
    { label: 'Signed', at: adoption?.recordedAt, who: adoption?.actor.name },
    issue
      ? {
          label: issue.status === 'withdrawn' ? 'Withdrawn' : 'Issued',
          at: issue.issuedAt,
          who: issue.issuedBy.name,
          note: issue.status === 'scheduled' ? `Effective ${documentDate(issue.effectiveFrom)}` : undefined,
        }
      : { label: 'Issued' },
  ];
}

function RevisionHistory({ detail, onRead }: { detail: SmsRecordDetailResponse; onRead: (issueId: string) => void }) {
  const issues = detail.documentControl?.issues ?? [];
  const documentDecisions = detail.decisions
    .filter((decision) => decision.kind in decisionTitles)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  return (
    <section className="safety-section" data-testid="sms-revision-history">
      <h3>Revision history</h3>
      <ol className="sms-revisions">
        {detail.versions.map((version) => {
          const decisions = documentDecisions.filter(
            (decision) => decisionVersion(decision, issues) === version.versionNumber,
          );
          const versionIssues = issues.filter((issue) => issue.versionNumber === version.versionNumber);
          const issue = versionIssues.find((entry) => !isEnded(entry)) ?? versionIssues.at(-1);
          const later = decisions.filter((decision) =>
            ['document.distribute', 'document.withdraw', 'document.periodic-review'].includes(decision.kind),
          );
          return (
            <li key={version.versionNumber} className="sms-revision-entry">
              <div className="sms-revision-entry-head">
                <strong>{versionLabel(version)}</strong>
                <span className="muted mono">Ledger version {version.versionNumber}</span>
                {issue && (
                  <Badge tone={issue.status === 'current' ? 'planned' : 'neutral'}>{issueStatusLabel(issue)}</Badge>
                )}
                {issue && issue.status !== 'withdrawn' && (
                  <Button kind="quiet" onClick={() => onRead(issue.id)}>
                    Read
                  </Button>
                )}
              </div>
              <ol className="sms-revision-steps" aria-label={`${versionLabel(version)} steps`}>
                {revisionSteps(version, decisions, issue).map((step) => (
                  <li key={step.label} className={step.at ? 'is-recorded' : undefined}>
                    <span>{step.label}</span>
                    {step.at ? (
                      <>
                        <b className="mono">{documentTime(step.at)}</b>
                        <small>
                          {step.who}
                          {step.note && ` · ${step.note}`}
                        </small>
                      </>
                    ) : (
                      <small>Not yet</small>
                    )}
                  </li>
                ))}
              </ol>
              {later.length > 0 && (
                <ul className="sms-revision-events">
                  {later.map((decision) => (
                    <li key={decision.id}>
                      <span className="mono">{documentTime(decision.recordedAt)}</span>
                      <span>
                        {decisionTitles[decision.kind]} · {decision.actor.name}
                        {laterDetail(decision)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {decisions.length > 0 && <DecisionDetails detail={detail} decisions={decisions} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function laterDetail(decision: SmsDecisionRecord): string {
  if (decision.kind === 'document.distribute') {
    const count = (decision.outcome as SmsDocumentDistributionOutcome).recipients.length;
    return ` · ${count} ${count === 1 ? 'reader' : 'readers'}`;
  }
  if (decision.kind === 'document.periodic-review')
    return ` · next due ${documentDate((decision.outcome as SmsDocumentPeriodicReviewOutcome).nextReviewDueAt)}`;
  return '';
}

function DecisionDetails({ detail, decisions }: { detail: SmsRecordDetailResponse; decisions: SmsDecisionRecord[] }) {
  const signed = decisions.some((decision) => detail.signatures.some((entry) => entry.decisionId === decision.id));
  return (
    <details className="safety-history">
      <summary>
        {signed ? 'Decisions and signature' : 'Decisions'} · {decisions.length}
      </summary>
      {decisions.map((decision) => {
        const signature = detail.signatures.find((entry) => entry.decisionId === decision.id);
        return (
          <div className="sms-decision" key={decision.id} data-testid={signature ? 'sms-signature' : undefined}>
            <p className="sms-decision-head">
              <strong>{decisionTitles[decision.kind]}</strong> · {decision.actor.name} ·{' '}
              <span className="mono">{documentTime(decision.recordedAt)}</span>
            </p>
            <p className="safety-narrative">{decision.note}</p>
            {signature && <blockquote className="sms-intent">{signature.intent}</blockquote>}
            <details className="safety-history">
              <summary>{signature ? 'Signed content, authority and digest' : 'Retained decision'}</summary>
              <pre>{json(signature ?? decision)}</pre>
            </details>
          </div>
        );
      })}
    </details>
  );
}
