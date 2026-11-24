import { describe, expect, it } from 'vitest';
import type {
  DocumentBody,
  SignedContent,
  SmsAttachment,
  SmsAuthoritySnapshot,
  SmsDecisionRecord,
  SmsDocumentAdoptionOutcome,
  SmsDocumentIssue,
  SmsDocumentIssueOutcome,
  SmsDocumentReviewOutcome,
  SmsRecordDetailResponse,
  SmsRecordVersion,
  SmsSignatureRecord,
} from '../../packages/contracts/src/sms.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import {
  checkDocumentFile,
  issuedDocumentContent,
  workingDocumentContent,
} from '../../apps/web/src/sms-document-reader.js';

const sourceBytes = new TextEncoder().encode('Retained manufacturer instructions.\n');
const recordedAt = '2026-10-23T14:00:00Z';

function issuedFixture(): SmsRecordDetailResponse {
  const body: DocumentBody = {
    documentType: 'procedure',
    origin: 'authored',
    summary: 'The issued procedure.',
    text: '# Isolation\nFollow the retained instructions.\n',
    changeReason: 'Initial issue',
    revisionLabel: 'A',
  };
  const version = {
    versionNumber: 1,
    title: 'Aircraft isolation procedure',
    body,
    bodyDigest: canonicalDigest(body),
  } as unknown as SmsRecordVersion;
  const draft = { ...version, versionNumber: 2, body: { ...body, text: 'Unissued working draft.' } };
  const document = { recordId: 'document-1', versionNumber: 1, bodyDigest: version.bodyDigest };
  const attachments = [{ id: 'file-1', sha256: sha256(sourceBytes) }];
  const actor: SmsAuthoritySnapshot = {
    policyVersion: 'ledger.sms-decision-authority.1',
    principalId: 'executive-1',
    name: 'Fictional Executive',
    kind: 'human',
    principalRevision: 1,
    capabilities: ['sms:read', 'sms:adopt', 'decision:write'],
    checkedCapabilities: ['decision:write', 'sms:adopt'],
    satisfyingCapability: 'sms:adopt',
  };
  const review = {
    id: 'review-1',
    subjectId: 'document-1',
    kind: 'document.review',
    outcome: { document, attachments },
  } as unknown as SmsDecisionRecord;
  const content: SignedContent = {
    version: 'sms.signed-content.1',
    meaning: 'document.adopt',
    intent: 'I adopt revision A of this procedure.',
    tenantId: 'fictional-utility',
    subject: { id: 'document-1', kind: 'document', revision: 4, title: version.title },
    signer: { id: actor.principalId, name: actor.name },
    bindings: [
      { kind: 'record_version', ...document },
      { kind: 'decision', decisionId: review.id, outcomeDigest: canonicalDigest(review.outcome) },
      { kind: 'attachment', attachmentId: 'file-1', sha256: attachments[0].sha256 },
    ],
    statement: { title: version.title, versionNumber: 1, document: body },
  };
  const contentDigest = canonicalDigest(content);
  const adoption = {
    id: 'adoption-1',
    subjectId: 'document-1',
    kind: 'document.adopt',
    outcome: { document, attachments, reviewId: review.id },
    signature: { id: 'signature-1', contentDigest },
  } as unknown as SmsDecisionRecord;
  const signature: SmsSignatureRecord = {
    id: 'signature-1',
    decisionId: adoption.id,
    subjectId: 'document-1',
    subjectRevision: 4,
    signer: content.signer,
    meaning: 'document.adopt',
    intent: content.intent,
    content,
    contentDigest,
    authority: actor,
    reauthentication: { method: 'local_fixture', verifiedAt: recordedAt },
    signedAt: recordedAt,
  };
  const issue: SmsDocumentIssue = {
    id: 'issue-1',
    versionNumber: 1,
    revisionLabel: 'A',
    title: version.title,
    status: 'current',
    effectiveFrom: recordedAt,
    effectiveUntil: null,
    adoptionId: adoption.id,
    reviewId: review.id,
    contentDigest,
    attachmentIds: ['file-1'],
    supersedes: null,
    issuedBy: { id: 'safety-1', name: 'Fictional Safety Manager' },
    issuedAt: recordedAt,
    recipients: [],
  };
  const issued = {
    id: issue.id,
    subjectId: 'document-1',
    kind: 'document.issue',
    outcome: {
      document,
      adoptionId: adoption.id,
      reviewId: review.id,
      contentDigest,
      attachments,
      effectiveFrom: recordedAt,
      effectiveUntil: null,
      supersedes: null,
      recipients: [],
      acknowledgementDueAt: null,
    },
  } as unknown as SmsDecisionRecord;
  const file = {
    id: 'file-1',
    label: 'Issued instructions',
    sha256: attachments[0].sha256,
    byteLength: sourceBytes.length,
    contentType: 'text/plain',
    confidentiality: 'ordinary',
    readable: true,
  } as SmsAttachment;
  return {
    record: { id: 'document-1', kind: 'document', versionNumber: 2 },
    current: draft,
    versions: [draft, version],
    attachments: [file, { ...file, id: 'later-file', label: 'Unissued working file', sha256: 'c'.repeat(64) }],
    decisions: [issued, adoption, review],
    signatures: [signature],
    documentControl: { issues: [issue], effectiveIssue: issue, latestReview: null },
  } as unknown as SmsRecordDetailResponse;
}

function workingFixture(): SmsRecordDetailResponse {
  const detail = issuedFixture();
  detail.current.bodyDigest = canonicalDigest(detail.current.body);
  detail.attachments[1].documentVersion = { versionNumber: 2 } as SmsAttachment['documentVersion'];
  return detail;
}

function reviewOf(detail: SmsRecordDetailResponse, fileIds: string[]): SmsDecisionRecord {
  const document = { recordId: 'document-1', versionNumber: 2, bodyDigest: detail.current.bodyDigest };
  const attachments = fileIds.map((id) => ({ id, sha256: detail.attachments.find((file) => file.id === id)!.sha256 }));
  return {
    id: 'review-2',
    kind: 'document.review',
    outcome: { document, attachments },
  } as unknown as SmsDecisionRecord;
}

describe('exact issued document reading', () => {
  it('opens the issued version and file manifest while a later working draft and file exist', async () => {
    const detail = issuedFixture();
    const selected = await issuedDocumentContent(detail, 'issue-1');
    expect(selected.version.versionNumber).toBe(1);
    expect(selected.body.text).toBe('# Isolation\nFollow the retained instructions.\n');
    expect(selected.files.map((file) => file.id)).toEqual(['file-1']);
    expect(detail.current.versionNumber).toBe(2);
  });

  it('still opens the issue after the signer’s directory name changes', async () => {
    const detail = issuedFixture();
    detail.signatures[0].signer = { ...detail.signatures[0].signer, name: 'Fictional Executive (renamed)' };
    await expect(issuedDocumentContent(detail, 'issue-1')).resolves.toMatchObject({ version: { versionNumber: 1 } });
  });

  it('refuses missing or changed retained content and mismatched signature records', async () => {
    const missingBody = issuedFixture();
    missingBody.versions[1].body = null;
    const changedBody = issuedFixture();
    changedBody.versions[1].body!.text = 'Instructions changed without a new signed revision.';
    const missingSignature = issuedFixture();
    missingSignature.signatures = [];
    const wrongSignature = issuedFixture();
    wrongSignature.signatures[0].subjectId = 'another-record';
    const changedSignedContent = issuedFixture();
    changedSignedContent.signatures[0].content.intent = 'A changed signing intent.';
    const changedFileBinding = issuedFixture();
    changedFileBinding.attachments[0].sha256 = 'd'.repeat(64);
    const missingReview = issuedFixture();
    missingReview.decisions = missingReview.decisions.filter((decision) => decision.kind !== 'document.review');
    for (const detail of [
      missingBody,
      changedBody,
      missingSignature,
      wrongSignature,
      changedSignedContent,
      changedFileBinding,
      missingReview,
    ]) {
      await expect(issuedDocumentContent(detail, 'issue-1')).rejects.toThrow(/does not match this issue/);
    }
  });

  it('does not let unsigned manifest changes omit a file included in the adoption signature', async () => {
    const detail = issuedFixture();
    detail.documentControl!.issues[0].attachmentIds = [];
    (detail.decisions[0].outcome as SmsDocumentIssueOutcome).attachments = [];
    (detail.decisions[1].outcome as SmsDocumentAdoptionOutcome).attachments = [];
    await expect(issuedDocumentContent(detail, 'issue-1')).rejects.toThrow(/does not match this issue/);
  });

  it('opens a reviewed working revision with only the files its review froze', async () => {
    const detail = workingFixture();
    const reviewed = reviewOf(detail, ['later-file']);
    detail.attachments.push({ ...detail.attachments[1], id: 'after-review', label: 'Attached after review' });
    const selected = await workingDocumentContent(detail, reviewed);
    expect(selected.version.versionNumber).toBe(2);
    expect(selected.files.map((file) => file.id)).toEqual(['later-file']);
    const unreviewed = await workingDocumentContent(detail, undefined);
    expect(unreviewed.files.map((file) => file.id)).toEqual(['later-file', 'after-review']);
  });

  it('refuses a working revision whose text or frozen file no longer matches', async () => {
    const changedText = workingFixture();
    const changedTextReview = reviewOf(changedText, ['later-file']);
    changedText.current.body!.text = 'Changed after review.';
    const changedFile = workingFixture();
    const changedFileReview = reviewOf(changedFile, ['later-file']);
    changedFile.attachments[1].sha256 = 'e'.repeat(64);
    const otherVersion = workingFixture();
    const otherVersionReview = reviewOf(otherVersion, ['later-file']);
    (otherVersionReview.outcome as SmsDocumentReviewOutcome).document.versionNumber = 1;
    for (const [detail, review] of [
      [changedText, changedTextReview],
      [changedFile, changedFileReview],
      [otherVersion, otherVersionReview],
    ] as const) {
      await expect(workingDocumentContent(detail, review)).rejects.toThrow(/does not match this revision/);
    }
  });

  it('checks downloaded bytes against the retained length and SHA-256', async () => {
    const file = issuedFixture().attachments[0];
    await expect(checkDocumentFile(sourceBytes, file)).resolves.toBeUndefined();
    const altered = new Uint8Array(sourceBytes);
    altered[0] ^= 1;
    await expect(checkDocumentFile(altered, file)).rejects.toThrow(/do not match the retained file/);
  });
});
