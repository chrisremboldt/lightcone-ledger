import type {
  DocumentBody,
  SmsDecisionRecord,
  SmsDocumentAdoptionOutcome,
  SmsDocumentIssue,
  SmsDocumentReviewOutcome,
  SmsHomeResponse,
  SmsRecordDetailResponse,
  SmsRecordVersion,
} from '@ledger/contracts';
import { documentDate, documentTime, reviewState } from './sms-document-dates.js';

export const issueLabel = (issue: SmsDocumentIssue) => issue.revisionLabel ?? `Version ${issue.versionNumber}`;
export const versionLabel = (version: SmsRecordVersion) =>
  (version.body as DocumentBody | null)?.revisionLabel ?? `Version ${version.versionNumber}`;
export const issueStatusLabel = (issue: SmsDocumentIssue) =>
  ({
    current: 'In force',
    scheduled: 'Scheduled',
    expired: 'Expired',
    superseded: 'Superseded',
    retired: 'Retired',
    withdrawn: 'Withdrawn',
  })[issue.status];
/** A received document is its issuer's file; text kept from earlier received revisions is the organization's notes. */
export const documentTextName = (body: DocumentBody | null | undefined) =>
  body?.origin === 'received' ? 'Notes for readers' : 'Document text';
export const revisionFieldLabels = (body: DocumentBody | null | undefined) =>
  body?.origin === 'received'
    ? { summary: "Issuer's summary", reason: 'Why we adopted it' }
    : { summary: 'Summary', reason: 'Reason' };
export const isActive = (issue: SmsDocumentIssue) => issue.status === 'current' || issue.status === 'scheduled';
export const isEnded = (issue: SmsDocumentIssue) => issue.status === 'retired' || issue.status === 'withdrawn';
export const isPast = (iso: string) => new Date(iso).getTime() < Date.now();

export type WorkingStage = 'draft' | 'reviewed' | 'signed' | 'signed_unreviewed' | 'scheduled' | 'in_force' | 'ended';

export interface DocumentState {
  effective: SmsDocumentIssue | null;
  effectiveVersion: SmsRecordVersion | undefined;
  working: SmsRecordVersion;
  /** The live issue of the working version, if it has been issued. */
  workingIssue: SmsDocumentIssue | undefined;
  stage: WorkingStage;
  review: SmsDecisionRecord | undefined;
  adoption: SmsDecisionRecord | undefined;
  canIssue: boolean;
  scheduled: SmsDocumentIssue[];
  /** The working version is a revision other than the one in force. */
  hasSuccessor: boolean;
}

export function documentState(detail: SmsRecordDetailResponse): DocumentState {
  const control = detail.documentControl;
  const issues = control?.issues ?? [];
  const working = detail.current;
  const effective = control?.effectiveIssue ?? null;
  const latestReview = control?.latestReview ?? undefined;
  const reviewOutcome = latestReview?.outcome as SmsDocumentReviewOutcome | undefined;
  const review = reviewOutcome?.document.versionNumber === working.versionNumber ? latestReview : undefined;
  const adoption = control?.latestAdoption ?? undefined;
  const canIssue = Boolean(
    adoption && review && (adoption.outcome as SmsDocumentAdoptionOutcome).reviewId === review.id,
  );
  const workingIssue = issues.find((issue) => issue.versionNumber === working.versionNumber && !isEnded(issue));
  const stage: WorkingStage = workingIssue
    ? workingIssue.status === 'current'
      ? 'in_force'
      : workingIssue.status === 'scheduled'
        ? 'scheduled'
        : 'ended'
    : adoption
      ? canIssue
        ? 'signed'
        : 'signed_unreviewed'
      : review
        ? 'reviewed'
        : 'draft';
  return {
    effective,
    effectiveVersion: effective
      ? detail.versions.find((version) => version.versionNumber === effective.versionNumber)
      : undefined,
    working,
    workingIssue,
    stage,
    review,
    adoption,
    canIssue,
    scheduled: issues.filter((issue) => issue.status === 'scheduled'),
    hasSuccessor: !effective || effective.versionNumber !== working.versionNumber,
  };
}

export const isUnissued = (stage: WorkingStage) =>
  stage === 'draft' || stage === 'reviewed' || stage === 'signed' || stage === 'signed_unreviewed';

export function stageLabel(state: DocumentState): string {
  switch (state.stage) {
    case 'draft':
      return 'Draft, awaiting review';
    case 'reviewed':
      return 'Reviewed, awaiting signature';
    case 'signed':
      return 'Signed, ready to issue';
    case 'signed_unreviewed':
      return 'Signed before review, cannot be issued';
    case 'scheduled':
      return `Scheduled for ${documentDate(state.workingIssue!.effectiveFrom)}`;
    case 'in_force':
      return 'In force';
    case 'ended':
      return issueStatusLabel(state.workingIssue!);
  }
}

export function adopterNames(home: SmsHomeResponse): string {
  const names = home.people.filter((person) => person.adopts).map((person) => person.name);
  if (!names.length) return 'someone with adoption authority';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export type AttentionTone = 'alert' | 'attention' | 'advisory';
export interface AttentionItem {
  tone: AttentionTone;
  text: string;
}

/** What needs someone's attention on this document, most urgent first. */
export function documentAttention(detail: SmsRecordDetailResponse, state: DocumentState): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { effective } = state;
  if (detail.record.status === 'closed') return items;
  if (effective) {
    const overdue = effective.recipients.filter(
      (recipient) => !recipient.acknowledgedAt && recipient.dueAt && isPast(recipient.dueAt),
    ).length;
    if (overdue)
      items.push({
        tone: 'attention',
        text: `${overdue} ${overdue === 1 ? 'reader is' : 'readers are'} overdue to acknowledge ${issueLabel(effective)}.`,
      });
    const reviewDueAt = detail.documentControl?.reviewDueAt ?? null;
    const review = reviewState(reviewDueAt);
    if (review === 'overdue')
      items.push({ tone: 'attention', text: `Periodic review was due ${documentTime(reviewDueAt!)}.` });
    else if (review === 'due_soon')
      items.push({ tone: 'advisory', text: `Periodic review is due ${documentTime(reviewDueAt!)}.` });
    if (!effective.recipients.length)
      items.push({ tone: 'advisory', text: `No one is assigned to read ${issueLabel(effective)}.` });
  }
  if (state.stage === 'signed_unreviewed')
    items.push({
      tone: 'attention',
      text: `${versionLabel(state.working)} was signed before review and cannot be issued. Record a new revision.`,
    });
  const carried = effective && state.effectiveVersion ? carriedForward(detail, state.effectiveVersion) : [];
  if (carried.length)
    items.push({
      tone: 'advisory',
      text: `${issueLabel(effective!)} repeats the previous revision's ${listWords(carried)}. Check them against the issued file.`,
    });
  return items;
}

/** Received-document details that a new revision left identical to the revision before it. */
export function carriedForward(detail: SmsRecordDetailResponse, version: SmsRecordVersion): string[] {
  const body = version.body as DocumentBody | null;
  if (body?.origin !== 'received') return [];
  const previous = detail.versions.find((entry) => entry.versionNumber === version.versionNumber - 1);
  const before = previous?.body as DocumentBody | null | undefined;
  if (!before || before.origin !== 'received' || before.source?.revision === body.source?.revision) return [];
  const same: string[] = [];
  if (body.source?.issuedAt && body.source.issuedAt === before.source?.issuedAt) same.push('source issue date');
  if (body.source?.receivedAt === before.source?.receivedAt) same.push('received time');
  if (body.summary === before.summary) same.push('summary');
  if (body.text && body.text === before.text) same.push('notes for readers');
  return same;
}

function listWords(words: string[]): string {
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
