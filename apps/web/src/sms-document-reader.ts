import type {
  DocumentBody,
  SmsAttachment,
  SmsDocumentAdoptionOutcome,
  SmsDocumentIssue,
  SmsDecisionRecord,
  SmsDocumentIssueOutcome,
  SmsDocumentReviewOutcome,
  SmsRecordDetailResponse,
  SmsRecordVersion,
  SmsSignatureRecord,
} from '@ledger/contracts';
import { canonicalize } from '@ledger/integrity/canonical';

export interface IssuedDocumentContent {
  issue: SmsDocumentIssue;
  version: SmsRecordVersion;
  body: DocumentBody;
  files: SmsAttachment[];
  signature: SmsSignatureRecord;
}

export async function documentBytesDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const valueDigest = (value: unknown) => documentBytesDigest(new TextEncoder().encode(canonicalize(value)));

export async function issuedDocumentContent(
  detail: SmsRecordDetailResponse,
  issueId: string,
): Promise<IssuedDocumentContent> {
  const unavailable = () =>
    new Error('The retained content does not match this issue. Reload the record or contact the document owner.');
  const issue = detail.documentControl?.issues.find((entry) => entry.id === issueId);
  const decision = detail.decisions.find((entry) => entry.id === issueId && entry.kind === 'document.issue');
  if (!issue || !decision || detail.record.kind !== 'document') throw unavailable();
  const outcome = decision.outcome as SmsDocumentIssueOutcome;
  const version = detail.versions.find((entry) => entry.versionNumber === issue.versionNumber);
  const adoption = detail.decisions.find((entry) => entry.id === issue.adoptionId && entry.kind === 'document.adopt');
  const adopted = adoption?.outcome as SmsDocumentAdoptionOutcome | undefined;
  const signature = detail.signatures.find((entry) => entry.decisionId === issue.adoptionId);
  const review = detail.decisions.find((entry) => entry.id === issue.reviewId && entry.kind === 'document.review');
  if (
    !version?.body ||
    !signature ||
    !adoption?.signature ||
    !adopted ||
    outcome.document.recordId !== detail.record.id ||
    outcome.document.versionNumber !== version.versionNumber ||
    outcome.document.bodyDigest !== version.bodyDigest ||
    outcome.adoptionId !== issue.adoptionId ||
    outcome.reviewId !== issue.reviewId ||
    adopted.reviewId !== issue.reviewId ||
    !review ||
    outcome.contentDigest !== issue.contentDigest ||
    adopted.document.recordId !== detail.record.id ||
    adopted.document.versionNumber !== version.versionNumber ||
    adopted.document.bodyDigest !== version.bodyDigest ||
    signature.id !== adoption.signature.id ||
    signature.contentDigest !== issue.contentDigest ||
    adoption.signature.contentDigest !== issue.contentDigest ||
    signature.content.meaning !== 'document.adopt' ||
    signature.meaning !== 'document.adopt' ||
    signature.subjectId !== detail.record.id ||
    signature.signer.id !== signature.content.signer.id ||
    signature.content.subject.id !== detail.record.id ||
    signature.content.subject.title !== version.title ||
    issue.title !== version.title ||
    !signature.content.bindings.some(
      (binding) =>
        binding.kind === 'record_version' &&
        binding.recordId === detail.record.id &&
        binding.versionNumber === version.versionNumber &&
        binding.bodyDigest === version.bodyDigest,
    )
  )
    throw unavailable();
  const [bodyDigest, contentDigest, reviewDigest] = await Promise.all([
    valueDigest(version.body),
    valueDigest(signature.content),
    valueDigest(review.outcome),
  ]);
  if (
    bodyDigest !== version.bodyDigest ||
    contentDigest !== issue.contentDigest ||
    !signature.content.bindings.some(
      (binding) =>
        binding.kind === 'decision' && binding.decisionId === review.id && binding.outcomeDigest === reviewDigest,
    )
  )
    throw unavailable();
  const signedFiles = signature.content.bindings.filter((binding) => binding.kind === 'attachment');
  if (
    issue.attachmentIds.length !== outcome.attachments.length ||
    new Set(issue.attachmentIds).size !== issue.attachmentIds.length ||
    adopted.attachments.length !== outcome.attachments.length ||
    signedFiles.length !== outcome.attachments.length ||
    new Set(signedFiles.map((binding) => binding.attachmentId)).size !== signedFiles.length
  )
    throw unavailable();
  const files = issue.attachmentIds.map((id) => {
    const retained = outcome.attachments.find((entry) => entry.id === id);
    const file = detail.attachments.find((entry) => entry.id === id);
    if (
      !retained ||
      !file ||
      file.sha256 !== retained.sha256 ||
      !adopted.attachments.some((entry) => entry.id === id && entry.sha256 === retained.sha256) ||
      !signature.content.bindings.some(
        (binding) => binding.kind === 'attachment' && binding.attachmentId === id && binding.sha256 === retained.sha256,
      )
    )
      throw unavailable();
    return file;
  });
  return { issue, version, body: version.body as DocumentBody, files, signature };
}

export interface WorkingDocumentContent {
  version: SmsRecordVersion;
  body: DocumentBody;
  /** The files frozen by its review, or before review the files attached to it. */
  files: SmsAttachment[];
  review: SmsDecisionRecord | undefined;
}

export async function workingDocumentContent(
  detail: SmsRecordDetailResponse,
  review: SmsDecisionRecord | undefined,
): Promise<WorkingDocumentContent> {
  const unavailable = () =>
    new Error('The retained content does not match this revision. Reload the record or contact the document owner.');
  const version = detail.current;
  const reviewed = review?.outcome as SmsDocumentReviewOutcome | undefined;
  if (detail.record.kind !== 'document' || !version.body) throw unavailable();
  if (
    reviewed &&
    (reviewed.document.recordId !== detail.record.id ||
      reviewed.document.versionNumber !== version.versionNumber ||
      reviewed.document.bodyDigest !== version.bodyDigest)
  )
    throw unavailable();
  if ((await valueDigest(version.body)) !== version.bodyDigest) throw unavailable();
  const files = reviewed
    ? reviewed.attachments.map((retained) => {
        const file = detail.attachments.find((entry) => entry.id === retained.id);
        if (!file || file.sha256 !== retained.sha256) throw unavailable();
        return file;
      })
    : detail.attachments.filter((entry) => entry.documentVersion?.versionNumber === version.versionNumber);
  return { version, body: version.body as DocumentBody, files, review };
}

export async function checkDocumentFile(
  bytes: Uint8Array,
  file: Pick<SmsAttachment, 'byteLength' | 'sha256'>,
): Promise<void> {
  if (bytes.byteLength !== file.byteLength || (await documentBytesDigest(bytes)) !== file.sha256)
    throw new Error('These bytes do not match the retained file. Reload the record or contact the document owner.');
}

export const isPdfDocument = (file: Pick<SmsAttachment, 'contentType'>) =>
  file.contentType.split(';')[0].trim().toLowerCase() === 'application/pdf';

export const documentFileName = (file: Pick<SmsAttachment, 'contentType' | 'label'>) =>
  isPdfDocument(file) && !/\.pdf$/i.test(file.label) ? `${file.label}.pdf` : file.label;
