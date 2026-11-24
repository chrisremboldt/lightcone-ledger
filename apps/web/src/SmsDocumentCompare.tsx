import { lazy, Suspense, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  DocumentBody,
  SmsAttachment,
  SmsDocumentReviewOutcome,
  SmsRecordDetailResponse,
  SmsRecordVersion,
} from '@ledger/contracts';
import { Spinner } from '@ledger/ui';
import { documentTypeLabels } from './sms-labels.js';
import { documentTime } from './sms-document-dates.js';
import { diffLines, withContext } from './sms-document-diff.js';
import { isPdfDocument } from './sms-document-reader.js';
import { documentTextName, revisionFieldLabels, versionLabel as revisionName } from './sms-document-state.js';

const SmsPdfCompare = lazy(() => import('./SmsPdfCompare.js'));

const versionLabel = (version: SmsRecordVersion) =>
  `${revisionName(version)} · Ledger version ${version.versionNumber}`;

function facts(version: SmsRecordVersion): [string, string][] {
  const body = version.body as DocumentBody;
  const labels = revisionFieldLabels(body);
  return [
    ['Title', version.title],
    ['Type', documentTypeLabels[body.documentType]],
    ['Document number', body.documentNumber ?? ''],
    ['Revision', body.revisionLabel ?? ''],
    [labels.summary, body.summary],
    [labels.reason, body.changeReason ?? ''],
    ['Review due', body.reviewDueAt ? documentTime(body.reviewDueAt) : ''],
    ['Source organization', body.source?.organization ?? ''],
    ['Source revision', body.source?.revision ?? ''],
    ['Source reference', body.source?.reference ?? ''],
  ];
}

function reviewOutcome(detail: SmsRecordDetailResponse, versionNumber: number) {
  const review = detail.decisions.find(
    (decision) =>
      decision.kind === 'document.review' &&
      (decision.outcome as SmsDocumentReviewOutcome).document.versionNumber === versionNumber,
  );
  return review?.outcome as SmsDocumentReviewOutcome | undefined;
}

/** The files a version was reviewed with; a version never reviewed has no frozen file set. */
function reviewedFiles(detail: SmsRecordDetailResponse, versionNumber: number) {
  const review = reviewOutcome(detail, versionNumber);
  if (!review) return null;
  return review.attachments.map((file) => ({
    sha256: file.sha256,
    label: detail.attachments.find((attachment) => attachment.id === file.id)?.label ?? 'Retained file',
  }));
}

/** The PDFs a version was reviewed with, or before review the PDFs attached to it. */
function versionPdfs(detail: SmsRecordDetailResponse, versionNumber: number): SmsAttachment[] {
  const review = reviewOutcome(detail, versionNumber);
  const files = review
    ? review.attachments.flatMap((file) => detail.attachments.filter((attachment) => attachment.id === file.id))
    : detail.attachments.filter((attachment) => attachment.documentVersion?.versionNumber === versionNumber);
  return files.filter(isPdfDocument);
}

function PageChanges({
  client,
  detail,
  from,
  to,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  from: SmsRecordVersion;
  to: SmsRecordVersion;
}) {
  const fromPdfs = versionPdfs(detail, from.versionNumber);
  const toPdfs = versionPdfs(detail, to.versionNumber);
  const [fromId, setFromId] = useState(fromPdfs[0]?.id);
  const [toId, setToId] = useState(toPdfs[0]?.id);
  const fromFile = fromPdfs.find((file) => file.id === fromId) ?? fromPdfs[0];
  const toFile = toPdfs.find((file) => file.id === toId) ?? toPdfs[0];
  if (!fromFile || !toFile) return <p className="muted">Page changes appear when both revisions have a PDF.</p>;
  if (!fromFile.readable || !toFile.readable)
    return <p className="muted">You need access to both PDFs to compare their pages.</p>;
  const filePicker = (label: string, files: SmsAttachment[], value: string, onChange: (id: string) => void) => (
    <label className="sms-issue-picker">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {files.map((file) => (
          <option key={file.id} value={file.id}>
            {file.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <p className="sms-text-role">
        Compared from the text in each PDF. The PDFs are the documents; check these changes against the issuer&apos;s
        revision highlights.
      </p>
      {(fromPdfs.length > 1 || toPdfs.length > 1) && (
        <div className="sms-compare-pickers">
          {filePicker('From file', fromPdfs, fromFile.id, setFromId)}
          {filePicker('To file', toPdfs, toFile.id, setToId)}
        </div>
      )}
      {fromFile.sha256 === toFile.sha256 ? (
        <p className="muted">Both revisions use the same PDF.</p>
      ) : (
        <Suspense fallback={<Spinner label="Opening the page comparison" />}>
          <SmsPdfCompare
            key={`${fromFile.id}-${toFile.id}`}
            client={client}
            from={fromFile}
            to={toFile}
            fromLabel={revisionName(from)}
            toLabel={revisionName(to)}
          />
        </Suspense>
      )}
    </>
  );
}

function FileChanges({
  detail,
  from,
  to,
}: {
  detail: SmsRecordDetailResponse;
  from: SmsRecordVersion;
  to: SmsRecordVersion;
}) {
  const before = reviewedFiles(detail, from.versionNumber);
  const after = reviewedFiles(detail, to.versionNumber);
  if (!before || !after)
    return (
      <p className="muted">
        Files are compared once both versions are reviewed; review freezes each version&apos;s file set.
      </p>
    );
  const removed = before.filter((file) => !after.some((other) => other.sha256 === file.sha256));
  const added = after.filter((file) => !before.some((other) => other.sha256 === file.sha256));
  if (!removed.length && !added.length) return <p className="muted">Both versions use the same files.</p>;
  return (
    <ul className="sms-diff-fields">
      {removed.map((file) => (
        <li key={`removed-${file.sha256}`} className="sms-diff-removed">
          <span>Removed file</span>
          <span>{file.label}</span>
        </li>
      ))}
      {added.map((file) => (
        <li key={`added-${file.sha256}`} className="sms-diff-added">
          <span>Added file</span>
          <span>{file.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function DocumentComparison({ client, detail }: { client: LedgerClient; detail: SmsRecordDetailResponse }) {
  const versions = detail.versions;
  const effective = detail.documentControl?.effectiveIssue?.versionNumber;
  const latest = versions[0]!;
  const initialFrom =
    effective && effective !== latest.versionNumber ? effective : (versions[1]?.versionNumber ?? latest.versionNumber);
  const [fromNumber, setFromNumber] = useState(initialFrom);
  const [toNumber, setToNumber] = useState(latest.versionNumber);
  const from = versions.find((version) => version.versionNumber === fromNumber) ?? versions[1]!;
  const to = versions.find((version) => version.versionNumber === toNumber) ?? latest;
  const before = facts(from);
  const after = facts(to);
  const changedFacts = after.filter(([, value], index) => value !== before[index]![1]);
  const text = withContext(diffLines((from.body as DocumentBody).text ?? '', (to.body as DocumentBody).text ?? ''));
  const textChanged = text.some((block) => block.kind === 'added' || block.kind === 'removed');
  const picker = (label: string, value: number, onChange: (value: number) => void) => (
    <label className="sms-issue-picker">
      {label}
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {versions.map((version) => (
          <option key={version.versionNumber} value={version.versionNumber}>
            {versionLabel(version)}
            {version.versionNumber === effective ? ' · in force' : ''}
          </option>
        ))}
      </select>
    </label>
  );
  const received = (to.body as DocumentBody).origin === 'received';
  const textName = documentTextName(to.body as DocumentBody);
  const hasText = Boolean((from.body as DocumentBody).text || (to.body as DocumentBody).text);
  const pages = (
    <>
      <h4 className="sms-subhead">Changed pages</h4>
      <PageChanges
        key={`${from.versionNumber}-${to.versionNumber}`}
        client={client}
        detail={detail}
        from={from}
        to={to}
      />
    </>
  );
  return (
    <div data-testid="sms-document-compare">
      <p className="sms-text-role">
        Compares the details, text and files of two revisions. For PDFs, Ledger lists the pages whose wording changed.
      </p>
      <div className="sms-compare-pickers">
        {picker('From', from.versionNumber, setFromNumber)}
        {picker('To', to.versionNumber, setToNumber)}
      </div>
      {from.versionNumber === to.versionNumber ? (
        <p className="muted">Choose two different versions.</p>
      ) : (
        <>
          <h4 className="sms-subhead">Details</h4>
          {changedFacts.length === 0 ? (
            <p className="muted">No details changed.</p>
          ) : (
            <ul className="sms-diff-fields">
              {changedFacts.map(([label, value]) => {
                const previous = before.find(([name]) => name === label)![1];
                return (
                  <li key={label}>
                    <span>{label}</span>
                    <span>
                      {previous && <del>{previous}</del>}
                      {previous && value && ' → '}
                      {value ? <ins>{value}</ins> : <em>removed</em>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {received && pages}
          {hasText && <h4 className="sms-subhead">{textName}</h4>}
          {!hasText ? null : !textChanged ? (
            <p className="muted">Unchanged.</p>
          ) : (
            <div className="sms-diff-text" aria-label="Text changes">
              {text.map((block, index) =>
                block.kind === 'skipped' ? (
                  <div key={index} className="sms-diff-skipped">
                    {block.count} unchanged {block.count === 1 ? 'line' : 'lines'}
                  </div>
                ) : (
                  <div key={index} className={`sms-diff-line sms-diff-${block.kind}`}>
                    <span aria-hidden="true">
                      {block.kind === 'added' ? '+' : block.kind === 'removed' ? '−' : ' '}
                    </span>
                    <span>
                      {block.kind !== 'same' && (
                        <span className="sr-only">{block.kind === 'added' ? 'Added: ' : 'Removed: '}</span>
                      )}
                      {block.text || '\u00a0'}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
          <h4 className="sms-subhead">Files</h4>
          <FileChanges detail={detail} from={from} to={to} />
          {!received && pages}
        </>
      )}
    </div>
  );
}
