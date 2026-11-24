import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  DocumentBody,
  Principal,
  SmsAttachment,
  SmsDocumentIssue,
  SmsRecordDetailResponse,
  SmsRecordVersion,
} from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { AcknowledgeIssue } from './SmsDocumentControl.js';
import SmsTextReader from './SmsTextReader.js';
import { documentTime } from './sms-document-dates.js';
import {
  documentState,
  documentTextName,
  isActive,
  isPast,
  issueLabel,
  revisionFieldLabels,
  stageLabel,
  versionLabel,
} from './sms-document-state.js';
import { byteSize } from './format.js';
import { documentTypeLabels, plainError, saveBytes } from './sms-labels.js';
import {
  checkDocumentFile,
  documentFileName,
  isPdfDocument,
  issuedDocumentContent,
  workingDocumentContent,
  type IssuedDocumentContent,
  type WorkingDocumentContent,
} from './sms-document-reader.js';
import './styles/sms-reader.css';

const SmsPdfReader = lazy(() => import('./SmsPdfReader.js'));
const statusLabels = {
  current: 'In force',
  scheduled: 'Scheduled',
  superseded: 'Superseded',
  expired: 'Expired',
  retired: 'Retired',
  withdrawn: 'Withdrawn',
};

/** An issued revision, or the working revision someone is reviewing or signing. */
export type ReaderSource = { issueId: string } | { working: true };

type ReaderContent = ({ kind: 'issued' } & IssuedDocumentContent) | ({ kind: 'working' } & WorkingDocumentContent);

async function loadContent(detail: SmsRecordDetailResponse, source: ReaderSource): Promise<ReaderContent> {
  if ('issueId' in source) return { kind: 'issued', ...(await issuedDocumentContent(detail, source.issueId)) };
  return { kind: 'working', ...(await workingDocumentContent(detail, documentState(detail).review)) };
}

async function downloadRetainedFile(client: LedgerClient, file: SmsAttachment) {
  const { bytes } = await client.download(`/v1/sms/attachments/${encodeURIComponent(file.id)}/content`);
  await checkDocumentFile(bytes, file);
  return bytes;
}

function RetainedFile({ client, file }: { client: LedgerClient; file: SmsAttachment }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    if (!file.readable || !isPdfDocument(file)) return;
    setBytes(null);
    setError(null);
    downloadRetainedFile(client, file)
      .then((received) => {
        if (!stopped) setBytes(received);
      })
      .catch((failure: unknown) => {
        if (!stopped) setError(plainError(failure).message);
      });
    return () => {
      stopped = true;
    };
  }, [client, file, attempt]);
  if (!file.readable)
    return <Notice title="Permission required">Contact the document owner for access to this file.</Notice>;
  if (!isPdfDocument(file))
    return (
      <Notice title="Download this file to read it">
        This file format opens in its own application. Download the original above.
      </Notice>
    );
  if (error)
    return (
      <Notice tone="alert" title="PDF unavailable">
        {error}
        <Button kind="quiet" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </Notice>
    );
  if (!bytes) return <Spinner label="Checking the PDF" />;
  return (
    <Suspense fallback={<Spinner label="Opening PDF reader" />}>
      <SmsPdfReader bytes={bytes} label={file.label} />
    </Suspense>
  );
}

function standing(issue: SmsDocumentIssue, issues: SmsDocumentIssue[]): string | null {
  const inForce = issues.find((entry) => entry.status === 'current');
  const replacement = inForce && inForce.id !== issue.id ? ` ${issueLabel(inForce)} is in force.` : '';
  switch (issue.status) {
    case 'current':
      return null;
    case 'scheduled':
      return `Not yet in force. ${issueLabel(issue)} takes effect ${documentTime(issue.effectiveFrom)}.`;
    case 'superseded':
      return `Superseded. Do not work from this revision.${replacement}`;
    case 'expired':
      return `Expired${issue.effectiveUntil ? ` ${documentTime(issue.effectiveUntil)}` : ''}.${replacement}`;
    case 'retired':
      return 'Retired. This document is no longer in force.';
    case 'withdrawn':
      return 'Withdrawn before it took effect. It was never in force.';
  }
}

function workingStanding(detail: SmsRecordDetailResponse): string {
  const effective = detail.documentControl?.effectiveIssue;
  return `Not issued. Readers cannot see this revision until it is signed and issued; do not work from it.${
    effective ? ` ${issueLabel(effective)} is in force.` : ''
  }`;
}

function RevisionChanges({
  label,
  version,
  body,
  issues,
}: {
  label: string;
  version: SmsRecordVersion;
  body: DocumentBody;
  issues: SmsDocumentIssue[];
}) {
  const replacesEarlier = issues.some(
    (issue) => issue.versionNumber < version.versionNumber && issue.status !== 'withdrawn',
  );
  const heading = replacesEarlier ? `What changed in ${label}` : `About ${label}`;
  return (
    <section className="sms-reader-changes" aria-label={heading}>
      <span className="sms-reader-changes-label">{heading}</span>
      <p>{body.summary}</p>
      {body.changeReason && (
        <p className="sms-reader-changes-reason">
          <span>{revisionFieldLabels(body).reason}</span> {body.changeReason}
        </p>
      )}
    </section>
  );
}

function AcknowledgementBar({
  client,
  detail,
  issue,
  recipient,
  principal,
  onRecorded,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  issue: SmsDocumentIssue;
  recipient: SmsDocumentIssue['recipients'][number];
  principal: Principal;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (recipient.acknowledgedAt)
    return (
      <footer className="sms-reader-assignment sms-reader-assignment--done">
        <p>
          <span className="sms-reader-assignment-state">Acknowledged</span>
          You acknowledged {issueLabel(issue)} on <span className="mono">{documentTime(recipient.acknowledgedAt)}</span>
          .
        </p>
      </footer>
    );
  if (!isActive(issue))
    return (
      <footer className="sms-reader-assignment sms-reader-assignment--closed">
        <p>
          <span className="sms-reader-assignment-state">Not acknowledged</span>
          Your reading assignment for {issueLabel(issue)} is retained. This revision no longer needs acknowledging.
        </p>
      </footer>
    );
  const overdue = Boolean(recipient.dueAt && isPast(recipient.dueAt));
  return (
    <footer className={`sms-reader-assignment sms-reader-assignment--${overdue ? 'overdue' : 'pending'}`}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="sms-reader-assignment-state">
            {overdue ? 'Acknowledgement overdue' : 'Acknowledgement required'}
          </span>
          <span className="sms-reader-assignment-text">
            Read {issueLabel(issue)}, then record that you have read it.
            {recipient.dueAt && (
              <span className="mono">
                {' '}
                {overdue ? 'Was due' : 'Due'} {documentTime(recipient.dueAt)}
              </span>
            )}
          </span>
          <span className="button button--next sms-reader-assignment-toggle" aria-hidden="true">
            {open ? 'Hide' : 'Acknowledge'}
          </span>
        </summary>
        <div className="sms-reader-assignment-form">
          <AcknowledgeIssue
            key={issue.id}
            client={client}
            detail={detail}
            issue={issue}
            principal={principal}
            heading={false}
            onRecorded={onRecorded}
          />
        </div>
      </details>
    </footer>
  );
}

interface WorkingAction {
  state: string;
  text: string;
  label: string;
  onClick: () => void;
}

function workingAction(
  detail: SmsRecordDetailResponse,
  content: WorkingDocumentContent,
  principal: Principal,
  onSign: (() => void) | undefined,
  onReview: (() => void) | undefined,
): WorkingAction | null {
  const state = documentState(detail);
  const label = versionLabel(content.version);
  if (state.working.versionNumber !== content.version.versionNumber || state.review?.id !== content.review?.id)
    return null;
  if (state.stage === 'reviewed' && detail.actions.adopt.available && onSign)
    return {
      state: 'Signature required',
      text: `Read ${label}, then sign to adopt it.`,
      label: 'Sign adoption',
      onClick: onSign,
    };
  const writable = (['sms:write', 'decision:write'] as const).every((capability) =>
    principal.capabilities.includes(capability),
  );
  if (state.stage === 'draft' && writable && onReview)
    return {
      state: 'Review required',
      text: `Read ${label}, then record your review and choose the files to sign.`,
      label: 'Review revision',
      onClick: onReview,
    };
  return null;
}

function WorkingActionBar({ action }: { action: WorkingAction }) {
  return (
    <footer className="sms-reader-assignment sms-reader-assignment--pending">
      <div className="sms-reader-assignment-action">
        <span className="sms-reader-assignment-state">{action.state}</span>
        <span className="sms-reader-assignment-text">{action.text}</span>
        <Button kind="next" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    </footer>
  );
}

function RevisionFacts({ content }: { content: ReaderContent }) {
  const { body } = content;
  return (
    <dl className="safety-facts">
      <div>
        <dt>Document number</dt>
        <dd>{body.documentNumber ?? 'Not assigned'}</dd>
      </div>
      <div>
        <dt>Type</dt>
        <dd>{documentTypeLabels[body.documentType]}</dd>
      </div>
      <div>
        <dt>Ledger version</dt>
        <dd>{content.version.versionNumber}</dd>
      </div>
      {content.kind === 'issued' ? (
        <>
          <div>
            <dt>Signed by</dt>
            <dd>
              {content.signature.content.signer.name} · {documentTime(content.signature.signedAt)}
            </dd>
          </div>
          <div>
            <dt>Issued by</dt>
            <dd>
              {content.issue.issuedBy.name} · {documentTime(content.issue.issuedAt)}
            </dd>
          </div>
        </>
      ) : (
        <>
          <div>
            <dt>Recorded by</dt>
            <dd>
              {content.version.recordedBy.name} · {documentTime(content.version.recordedAt)}
            </dd>
          </div>
          <div>
            <dt>Reviewed by</dt>
            <dd>
              {content.review
                ? `${content.review.actor.name} · ${documentTime(content.review.recordedAt)}`
                : 'Not reviewed yet'}
            </dd>
          </div>
        </>
      )}
      {body.source && (
        <>
          <div>
            <dt>Source</dt>
            <dd>{body.source.organization}</dd>
          </div>
          {body.source.reference && (
            <div>
              <dt>Source reference</dt>
              <dd>{body.source.reference}</dd>
            </div>
          )}
          <div>
            <dt>Source revision</dt>
            <dd>{body.source.revision}</dd>
          </div>
          {body.source.issuedAt && (
            <div>
              <dt>Source issued</dt>
              <dd>{documentTime(body.source.issuedAt)}</dd>
            </div>
          )}
          <div>
            <dt>Received</dt>
            <dd>{documentTime(body.source.receivedAt)}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

function filesGroupLabel(content: ReaderContent): string {
  const many = content.files.length !== 1;
  if (content.kind === 'issued') return many ? 'Issued files' : 'Issued file';
  if (content.review) return many ? 'Files frozen at review' : 'File frozen at review';
  return many ? 'Attached files' : 'Attached file';
}

function ContentPicker({
  content,
  selectedId,
  onSelect,
}: {
  content: ReaderContent;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const text = content.body.text ? documentTextName(content.body) : null;
  const count = content.files.length + (text ? 1 : 0);
  if (count < 2) {
    const only = content.files[0];
    return (
      <div className="sms-reader-content-picker">
        <span className="sms-reader-picker-label">Content</span>
        <span className="sms-reader-picker-single">
          {only ? only.label : text}
          <span className="mono">{only ? byteSize(only.byteLength) : 'Recorded in Ledger'}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="sms-reader-content-picker">
      <span className="sms-reader-picker-label">Content</span>
      <div className="sms-reader-picker">
        <span className="sms-reader-picker-count" aria-hidden="true">
          <b>{count}</b> {text ? 'items' : 'files'}
        </span>
        <select aria-label="Content" value={selectedId} onChange={(event) => onSelect(event.target.value)}>
          {content.files.length > 0 && (
            <optgroup label={filesGroupLabel(content)}>
              {content.files.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </optgroup>
          )}
          {text && (
            <optgroup label="Recorded in Ledger">
              <option value="text">{text}</option>
            </optgroup>
          )}
        </select>
      </div>
    </div>
  );
}

export default function SmsDocumentReader({
  client,
  detail,
  source,
  principal,
  onRecorded,
  onClose,
  onSign,
  onReview,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  source: ReaderSource;
  principal: Principal;
  onRecorded: () => void;
  onClose: () => void;
  onSign?: () => void;
  onReview?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot] = useState(detail);
  const [initialSource] = useState(source);
  const [content, setContent] = useState<ReaderContent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const working = 'working' in source;
  const issueId = 'issueId' in source ? source.issueId : null;
  const liveIssue = issueId ? detail.documentControl?.issues.find((entry) => entry.id === issueId) : undefined;
  const issue = liveIssue ?? (content?.kind === 'issued' ? content.issue : undefined);
  const recipient = issue?.recipients.find((entry) => entry.id === principal.id);
  const file = content?.files.find((entry) => entry.id === selectedId);
  const unavailableTitle = working ? 'Revision content unavailable' : 'Issued content unavailable';

  useEffect(() => {
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    loadContent(snapshot, initialSource)
      .then((retained) => {
        if (stopped) return;
        setContent(retained);
        const sourceFile = retained.body.origin === 'received' ? retained.files[0] : undefined;
        setSelectedId(sourceFile?.id ?? (retained.body.text ? 'text' : (retained.files[0]?.id ?? 'text')));
      })
      .catch((error: unknown) => {
        if (!stopped) setFailure(plainError(error).message);
      });
    return () => {
      stopped = true;
    };
  }, [snapshot, initialSource]);

  async function download() {
    if (!file) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      saveBytes(await downloadRetainedFile(client, file), documentFileName(file), file.contentType);
    } catch (error) {
      setDownloadError(plainError(error).message);
    } finally {
      setDownloading(false);
    }
  }

  const label = content
    ? content.kind === 'issued'
      ? issueLabel(content.issue)
      : versionLabel(content.version)
    : working
      ? versionLabel(detail.current)
      : null;
  const action = content?.kind === 'working' ? workingAction(detail, content, principal, onSign, onReview) : null;

  return createPortal(
    <dialog
      ref={dialog}
      className="sms-reader"
      aria-label="Document reader"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="sms-reader-header">
        <Button kind="quiet" onClick={onClose} autoFocus>
          <span aria-hidden="true">←</span> Document record
        </Button>
        <div className="sms-reader-title">
          <p className="eyebrow">
            {content ? (
              <>
                {content.body.documentNumber && <span className="mono">{content.body.documentNumber}</span>}
                {documentTypeLabels[content.body.documentType]}
                {content.body.source ? ` · ${content.body.source.organization}` : ''}
              </>
            ) : (
              'Document reader'
            )}
          </p>
          <h2>{content?.version.title ?? issue?.title ?? detail.current.title}</h2>
        </div>
        {working ? (
          <div className="sms-reader-identity sms-reader-identity--working">
            <span className="sms-reader-state">Not issued</span>
            <strong>{label}</strong>
            <span>{stageLabel(documentState(detail))}</span>
          </div>
        ) : (
          issue && (
            <div className={`sms-reader-identity sms-reader-identity--${issue.status}`}>
              <span className="sms-reader-state">{statusLabels[issue.status]}</span>
              <strong>{issueLabel(issue)}</strong>
              <span className="mono">
                {documentTime(issue.effectiveFrom)}
                {issue.effectiveUntil ? ` – ${documentTime(issue.effectiveUntil)}` : ''}
              </span>
            </div>
          )
        )}
      </header>
      {working ? (
        <p className="sms-reader-standing sms-reader-standing--working" role="note">
          {workingStanding(detail)}
        </p>
      ) : (
        issue &&
        standing(issue, detail.documentControl?.issues ?? []) && (
          <p className={`sms-reader-standing sms-reader-standing--${issue.status}`} role="note">
            {standing(issue, detail.documentControl?.issues ?? [])}
          </p>
        )
      )}
      {failure ? (
        <div className="sms-reader-message">
          <Notice tone="alert" title={unavailableTitle}>
            {failure}
          </Notice>
        </div>
      ) : !content ? (
        <Spinner label={working ? 'Checking the revision' : 'Checking issued revision'} />
      ) : (
        <>
          <RevisionChanges
            label={label!}
            version={content.version}
            body={content.body}
            issues={snapshot.documentControl?.issues ?? []}
          />
          <div className="sms-reader-controls">
            <ContentPicker
              content={content}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setDownloadError(null);
              }}
            />
            <details className="sms-reader-revision">
              <summary>Revision details</summary>
              <div className="sms-reader-revision-panel">
                <RevisionFacts content={content} />
                <details className="sms-reader-digests">
                  <summary>Content identifiers</summary>
                  <dl>
                    {content.kind === 'issued' ? (
                      <>
                        <dt>Issue</dt>
                        <dd>{content.issue.id}</dd>
                        <dt>Issued content SHA-256</dt>
                        <dd>{content.issue.contentDigest}</dd>
                      </>
                    ) : (
                      content.review && (
                        <>
                          <dt>Review</dt>
                          <dd>{content.review.id}</dd>
                        </>
                      )
                    )}
                    <dt>Text revision SHA-256</dt>
                    <dd>{content.version.bodyDigest}</dd>
                    {file && (
                      <>
                        <dt>File SHA-256</dt>
                        <dd>{file.sha256}</dd>
                      </>
                    )}
                  </dl>
                </details>
              </div>
            </details>
            {file?.readable && (
              <Button kind="quiet" disabled={downloading} onClick={() => void download()}>
                {downloading ? 'Downloading…' : 'Download original'}
              </Button>
            )}
          </div>
          {downloadError && (
            <Notice tone="alert" title="Download unavailable">
              {downloadError}
            </Notice>
          )}
          <section className="sms-reader-content" aria-label={working ? 'Revision content' : 'Issued content'}>
            {selectedId === 'text' && content.body.text ? (
              <SmsTextReader text={content.body.text} label={documentTextName(content.body)} />
            ) : file ? (
              <RetainedFile key={file.id} client={client} file={file} />
            ) : (
              <Notice title={unavailableTitle}>
                {working
                  ? 'Attach a file or record the document text to read this revision.'
                  : 'Select a retained file to read this issue.'}
              </Notice>
            )}
          </section>
          {content.kind === 'issued' && recipient && issue && (
            <AcknowledgementBar
              client={client}
              detail={detail}
              issue={issue}
              recipient={recipient}
              principal={principal}
              onRecorded={onRecorded}
            />
          )}
          {action && <WorkingActionBar action={action} />}
        </>
      )}
    </dialog>,
    document.body,
  );
}
