import type {
  DocumentBody,
  SmsDecisionInput,
  SmsDecisionRecord,
  SmsDocumentAcknowledgement,
  SmsDocumentAdoptionOutcome,
  SmsDocumentControl,
  SmsDocumentDistributionOutcome,
  SmsDocumentIssue,
  SmsDocumentIssueOutcome,
  SmsDocumentPeriodicReviewOutcome,
  SmsDocumentReviewOutcome,
  SmsDocumentWithdrawalOutcome,
} from '@ledger/contracts';
import { planBlanks, RECORDKEEPING_PLAN_DOCUMENT_TYPE } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { currentVersion, type SmsRecordRow, type SmsVersionRow } from './sms-envelope.js';

export interface DocumentAttachment {
  id: string;
  label: string;
  sha256: string;
  confidentiality: 'ordinary';
}

export async function documentDecisions(client: PoolClient, record: SmsRecordRow): Promise<SmsDecisionRecord[]> {
  const rows = await client.query<{ record: SmsDecisionRecord }>(
    `SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND record->>'version'='sms.decision.1'
     ORDER BY accepted_revision DESC`,
    [record.tenant_id, record.id],
  );
  return rows.rows.map(({ record: decision }) => decision);
}

export async function documentAcknowledgements(
  client: PoolClient,
  tenantId: string,
  recordIds: string[],
): Promise<SmsDocumentAcknowledgement[]> {
  const rows = await client.query<{ record: SmsDocumentAcknowledgement }>(
    `SELECT record FROM sms_document_acknowledgements WHERE tenant_id=$1 AND record_id=ANY($2)
     ORDER BY recorded_at,id`,
    [tenantId, recordIds],
  );
  return rows.rows.map(({ record }) => record);
}

/** Reviews and signatures recorded before the latest retirement belong to issues that retirement ended. */
function lifecycleStart(decisions: SmsDecisionRecord[]): number {
  return decisions.find((item) => item.kind === 'record.close')?.acceptedRevision ?? 0;
}

function currentReview(decisions: SmsDecisionRecord[], versionNumber: number): SmsDecisionRecord | undefined {
  const start = lifecycleStart(decisions);
  return decisions.find(
    (decision) =>
      decision.kind === 'document.review' &&
      decision.acceptedRevision > start &&
      (decision.outcome as SmsDocumentReviewOutcome).document.versionNumber === versionNumber,
  );
}

function currentAdoption(decisions: SmsDecisionRecord[], versionNumber: number): SmsDecisionRecord | undefined {
  const start = lifecycleStart(decisions);
  return decisions.find(
    (decision) =>
      decision.kind === 'document.adopt' &&
      decision.acceptedRevision > start &&
      (decision.outcome as SmsDocumentAdoptionOutcome).document.versionNumber === versionNumber,
  );
}

export async function reviewedDocument(
  client: PoolClient,
  record: SmsRecordRow,
): Promise<SmsDecisionRecord | undefined> {
  return currentReview(await documentDecisions(client, record), record.version_number);
}

export async function documentFiles(
  client: PoolClient,
  record: SmsRecordRow,
  ids: string[],
): Promise<DocumentAttachment[]> {
  if (new Set(ids).size !== ids.length)
    throw new DomainError(400, 'duplicate_document_file', 'Choose each document file only once');
  const files = await client.query<DocumentAttachment>(
    `SELECT id,label,sha256,confidentiality FROM sms_attachments
     WHERE tenant_id=$1 AND record_id=$2 AND id=ANY($3) ORDER BY id`,
    [record.tenant_id, record.id, ids],
  );
  if (files.rows.length !== ids.length || files.rows.some((file) => file.confidentiality !== 'ordinary'))
    throw new DomainError(400, 'document_file_unavailable', 'Choose ordinary files attached to this document');
  return files.rows;
}

async function recipientPopulation(client: PoolClient, tenantId: string, ids: string[]) {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new DomainError(400, 'invalid_document_recipients', 'Choose at least one person, with no duplicates');
  const people = await client.query<{ id: string; name: string; revision: string }>(
    `SELECT id,name,revision FROM principals WHERE tenant_id=$1 AND id=ANY($2)
     AND active AND kind='human' AND 'sms:read'=ANY(capabilities) ORDER BY id COLLATE "C" FOR SHARE`,
    [tenantId, ids],
  );
  if (people.rows.length !== ids.length)
    throw new DomainError(
      400,
      'recipient_unavailable',
      'Each recipient must be an active person in your organization with SMS access',
    );
  return people.rows.map((person) => ({
    id: person.id,
    name: person.name,
    principalRevision: Number(person.revision),
  }));
}

function isoTime(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new DomainError(400, 'invalid_document_date', `${label} must be a valid date and time`);
  return new Date(parsed).toISOString();
}

function acknowledgementDeadline(value: string | undefined, receivedAt: string): string | null {
  if (!value) return null;
  const due = isoTime(value, 'Acknowledgement deadline');
  if (Date.parse(due) <= Date.parse(receivedAt))
    throw new DomainError(400, 'invalid_acknowledgement_deadline', 'Choose an acknowledgement deadline in the future');
  return due;
}

const ended = (issue: SmsDocumentIssue) => issue.status === 'retired' || issue.status === 'withdrawn';

type DocumentDecision = Extract<
  SmsDecisionInput,
  {
    kind:
      'document.review' | 'document.issue' | 'document.distribute' | 'document.withdraw' | 'document.periodic-review';
  }
>;
/** Issue and distribution outcomes are settled against the journal's received time, so "now" means acceptance. */
type DocumentOutcome = SmsDecisionRecord['outcome'] | ((receivedAt: string) => SmsDecisionRecord['outcome']);

/**
 * A recordkeeping plan is reviewed and issued only once the organization has filled every blank its draft left
 * (docs/design/required-records.md); the refusal names the first.
 */
function requireNoPlanBlank(body: DocumentBody): void {
  if (body.documentType !== RECORDKEEPING_PLAN_DOCUMENT_TYPE) return;
  const blanks = planBlanks(body.text);
  if (blanks.length)
    throw new DomainError(
      409,
      'plan_blank_unfilled',
      `This recordkeeping plan still has ${blanks.length === 1 ? 'a blank' : `${blanks.length} blanks`} to fill in, the first for ${blanks[0]}. Replace each “[To be filled in: …]” with the organization’s own words in a new revision.`,
      { blanks },
    );
}

export async function prepareDocumentDecision(
  client: PoolClient,
  actor: AuthContext,
  record: SmsRecordRow,
  decision: DocumentDecision,
): Promise<{ outcome: DocumentOutcome; status: string }> {
  if (record.kind !== 'document') throw new DomainError(400, 'document_required', 'This action requires a document');
  if (record.status === 'closed') throw new DomainError(409, 'document_retired', 'This document is retired');
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const decisions = await documentDecisions(client, record);
  const versions = (
    await client.query<SmsVersionRow>(
      'SELECT * FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2 ORDER BY version_number DESC',
      [record.tenant_id, record.id],
    )
  ).rows;
  const control = projectDocumentControl(record, versions, decisions, [], now);

  if (decision.kind === 'document.review') {
    if (decision.versionNumber !== record.version_number)
      throw new DomainError(409, 'stale_basis', 'Review the latest working revision');
    if (record.status === 'adopted')
      throw new DomainError(409, 'document_already_signed', 'Record a new revision before changing a signed document');
    const version = await currentVersion(client, record);
    const body = version.body as unknown as DocumentBody;
    const files = await documentFiles(client, record, decision.attachmentIds);
    if (!body.text?.trim() && !files.length)
      throw new DomainError(400, 'document_content_required', 'Provide document text or select its retained files');
    if (body.origin === 'received' && !files.length)
      throw new DomainError(400, 'source_file_required', 'A received document needs its original source file');
    requireNoPlanBlank(body);
    if (body.origin === 'received' && body.source) {
      for (const review of decisions.filter((item) => item.kind === 'document.review')) {
        const previous = review.outcome as SmsDocumentReviewOutcome;
        const priorBody = versions.find((item) => item.version_number === previous.document.versionNumber)
          ?.body as unknown as DocumentBody;
        if (
          priorBody?.source &&
          priorBody.source.organization === body.source.organization &&
          priorBody.source.reference === body.source.reference &&
          priorBody.source.revision === body.source.revision
        ) {
          const digests = (entries: { sha256: string }[]) => entries.map((entry) => entry.sha256).sort();
          if (canonicalDigest(digests(previous.attachments)) !== canonicalDigest(digests(files)))
            throw new DomainError(
              409,
              'source_revision_conflict',
              'This source revision already has different retained files; confirm the issuer’s revision identifier',
            );
        }
      }
    }
    const outcome: SmsDocumentReviewOutcome = {
      document: { recordId: record.id, versionNumber: version.version_number, bodyDigest: version.body_digest },
      attachments: files.map(({ id, sha256 }) => ({ id, sha256 })),
    };
    return { outcome, status: 'reviewed' };
  }

  if (decision.kind === 'document.issue') {
    if (decision.versionNumber !== record.version_number || record.status !== 'adopted')
      throw new DomainError(409, 'document_not_signed', 'Sign the latest reviewed revision before issuing it');
    const adoption = currentAdoption(decisions, record.version_number);
    const adopted = adoption?.outcome as SmsDocumentAdoptionOutcome | undefined;
    if (!adoption?.signature || adoption.id !== decision.adoptionId || !adopted?.reviewId)
      throw new DomainError(
        409,
        'document_not_reviewed',
        'Choose the latest signed adoption of this reviewed revision',
      );
    const review = currentReview(decisions, record.version_number);
    if (!review || review.id !== adopted.reviewId)
      throw new DomainError(409, 'document_review_changed', 'The review changed; review and sign again');
    requireNoPlanBlank((await currentVersion(client, record)).body as unknown as DocumentBody);
    if (control.issues.some((issue) => issue.versionNumber === decision.versionNumber && !ended(issue)))
      throw new DomainError(409, 'document_already_issued', 'This revision has already been issued');
    const requestedFrom = decision.effectiveFrom ? isoTime(decision.effectiveFrom, 'Effective date') : null;
    const effectiveUntil = decision.effectiveUntil ? isoTime(decision.effectiveUntil, 'Expiry date') : null;
    const predecessor = control.issues.find((issue) => !ended(issue));
    const recipients = decision.recipientIds.length
      ? await recipientPopulation(client, actor.tenantId, decision.recipientIds)
      : [];
    const outcome = (receivedAt: string): SmsDocumentIssueOutcome => {
      const effectiveFrom = requestedFrom ?? receivedAt;
      if (Date.parse(effectiveFrom) < Date.parse(receivedAt))
        throw new DomainError(400, 'document_backdated', 'A document issue cannot be backdated');
      if (effectiveUntil && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
        throw new DomainError(400, 'invalid_effective_interval', 'Expiry must be after the effective date');
      if (predecessor && Date.parse(predecessor.effectiveFrom) >= Date.parse(effectiveFrom))
        throw new DomainError(409, 'document_issue_order', 'The successor must take effect after the preceding issue');
      return {
        document: adopted.document,
        adoptionId: adoption.id,
        reviewId: review.id,
        contentDigest: adoption.signature!.contentDigest,
        attachments: adopted.attachments,
        effectiveFrom,
        effectiveUntil,
        supersedes: predecessor?.id ?? null,
        recipients,
        acknowledgementDueAt: acknowledgementDeadline(decision.acknowledgementDueAt, receivedAt),
      };
    };
    return { outcome, status: record.status };
  }

  const issue = control.issues.find((item) => item.id === decision.issueId);
  if (!issue)
    throw new DomainError(404, 'document_issue_unavailable', 'The issued revision was not found on this document');

  if (decision.kind === 'document.withdraw') {
    if (issue.status !== 'scheduled')
      throw new DomainError(
        409,
        'document_issue_in_force',
        'Only a scheduled issue can be withdrawn; issue a successor or retire the document instead',
      );
    if (control.issues.some((later) => later.supersedes === issue.id && !ended(later)))
      throw new DomainError(409, 'document_issue_superseded', 'Withdraw the later scheduled issue first');
    const outcome = (receivedAt: string): SmsDocumentWithdrawalOutcome => {
      if (Date.parse(issue.effectiveFrom) <= Date.parse(receivedAt))
        throw new DomainError(409, 'document_issue_in_force', 'This issue took effect before it could be withdrawn');
      return { issueId: issue.id };
    };
    return { outcome, status: record.status };
  }

  if (decision.kind === 'document.periodic-review') {
    if (issue.status !== 'current')
      throw new DomainError(409, 'document_issue_not_in_force', 'Only the revision in force has a periodic review');
    const nextReviewDueAt = isoTime(decision.nextReviewDueAt, 'Next review date');
    const outcome = (receivedAt: string): SmsDocumentPeriodicReviewOutcome => {
      if (Date.parse(nextReviewDueAt) <= Date.parse(receivedAt))
        throw new DomainError(400, 'invalid_next_review', 'Choose a next review date in the future');
      return {
        issueId: issue.id,
        versionNumber: issue.versionNumber,
        contentDigest: issue.contentDigest,
        nextReviewDueAt,
      };
    };
    return { outcome, status: record.status };
  }

  if (!['current', 'scheduled'].includes(issue.status))
    throw new DomainError(409, 'document_issue_inactive', 'This issue is no longer current or scheduled');
  const recipients = await recipientPopulation(client, actor.tenantId, decision.recipientIds);
  if (recipients.some((person) => issue.recipients.some((recipient) => recipient.id === person.id)))
    throw new DomainError(409, 'document_already_assigned', 'One of these people is already assigned this issue');
  const outcome = (receivedAt: string): SmsDocumentDistributionOutcome => ({
    issueId: issue.id,
    recipients,
    acknowledgementDueAt: acknowledgementDeadline(decision.acknowledgementDueAt, receivedAt),
  });
  return { outcome, status: record.status };
}

type VersionView = { version_number?: number; versionNumber?: number; title: string; body: unknown };

export function projectDocumentControl(
  record: Pick<SmsRecordRow, 'id' | 'version_number' | 'status'>,
  versions: VersionView[],
  decisions: SmsDecisionRecord[],
  acknowledgements: SmsDocumentAcknowledgement[],
  asOf: string,
): SmsDocumentControl {
  const known = decisions
    .filter((item) => Date.parse(item.recordedAt) <= Date.parse(asOf))
    .sort((a, b) => b.acceptedRevision - a.acceptedRevision);
  const receipts = acknowledgements.filter((item) => Date.parse(item.recordedAt) <= Date.parse(asOf));
  const withdrawn = new Set(
    known
      .filter((item) => item.kind === 'document.withdraw')
      .map((item) => (item.outcome as SmsDocumentWithdrawalOutcome).issueId),
  );
  const issued = known.filter((item) => item.kind === 'document.issue');
  const active = issued.find(
    (item) =>
      !withdrawn.has(item.id) &&
      Date.parse((item.outcome as SmsDocumentIssueOutcome).effectiveFrom) <= Date.parse(asOf),
  );
  const retiredRevision = lifecycleStart(known);
  const issues = issued.map((item): SmsDocumentIssue => {
    const outcome = item.outcome as SmsDocumentIssueOutcome;
    const version = versions.find(
      (entry) => (entry.version_number ?? entry.versionNumber) === outcome.document.versionNumber,
    );
    const body = version?.body as DocumentBody | undefined;
    const recipients = outcome.recipients.map((person) => ({
      ...person,
      assignedAt: item.recordedAt,
      dueAt: outcome.acknowledgementDueAt,
    }));
    for (const distribution of known.filter((entry) => entry.kind === 'document.distribute').reverse()) {
      const addition = distribution.outcome as SmsDocumentDistributionOutcome;
      if (addition.issueId === item.id)
        recipients.push(
          ...addition.recipients.map((person) => ({
            ...person,
            assignedAt: distribution.recordedAt,
            dueAt: addition.acknowledgementDueAt,
          })),
        );
    }
    const future = Date.parse(outcome.effectiveFrom) > Date.parse(asOf);
    const status = withdrawn.has(item.id)
      ? 'withdrawn'
      : retiredRevision > item.acceptedRevision
        ? 'retired'
        : future
          ? 'scheduled'
          : active?.id !== item.id
            ? 'superseded'
            : outcome.effectiveUntil && Date.parse(outcome.effectiveUntil) <= Date.parse(asOf)
              ? 'expired'
              : 'current';
    return {
      id: item.id,
      versionNumber: outcome.document.versionNumber,
      revisionLabel: body?.revisionLabel ?? `Version ${outcome.document.versionNumber}`,
      title: version?.title ?? 'Document',
      status,
      effectiveFrom: outcome.effectiveFrom,
      effectiveUntil: outcome.effectiveUntil,
      adoptionId: outcome.adoptionId,
      reviewId: outcome.reviewId,
      contentDigest: outcome.contentDigest,
      attachmentIds: outcome.attachments.map((file) => file.id),
      supersedes: outcome.supersedes,
      issuedBy: { id: item.actor.principalId, name: item.actor.name },
      issuedAt: item.recordedAt,
      recipients: recipients.map((person) => {
        const receipt = receipts.find((entry) => entry.issueId === item.id && entry.actor.principalId === person.id);
        return { ...person, acknowledgedAt: receipt?.recordedAt ?? null, acknowledgementId: receipt?.id ?? null };
      }),
    };
  });
  const effectiveIssue = issues.find((issue) => issue.status === 'current') ?? null;
  return {
    issues,
    effectiveIssue,
    latestReview: currentReview(known, record.version_number) ?? null,
    latestAdoption: currentAdoption(known, record.version_number) ?? null,
    acknowledgements: receipts,
    reviewDueAt: effectiveIssue ? reviewDue(effectiveIssue, versions, known) : null,
  };
}

/** The latest periodic review of the revision in force sets its next review; otherwise its own text does. */
function reviewDue(issue: SmsDocumentIssue, versions: VersionView[], decisions: SmsDecisionRecord[]): string | null {
  const periodic = decisions.find(
    (item) =>
      item.kind === 'document.periodic-review' &&
      (item.outcome as SmsDocumentPeriodicReviewOutcome).issueId === issue.id,
  );
  if (periodic) return (periodic.outcome as SmsDocumentPeriodicReviewOutcome).nextReviewDueAt;
  const version = versions.find((entry) => (entry.version_number ?? entry.versionNumber) === issue.versionNumber);
  return (version?.body as DocumentBody | undefined)?.reviewDueAt ?? null;
}
