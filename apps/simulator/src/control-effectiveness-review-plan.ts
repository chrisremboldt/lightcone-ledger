import {
  ControlIndicatorReviewRecordSchema,
  indicatorReviewConclusionValues,
  type ControlIndicatorReviewRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  apiOrigin,
  compile,
  hasKeys,
  isDigest,
  isId,
  pending,
  readJournal,
  same,
  validateJournal,
  type ActionJournal,
} from './indicator-actor-common.js';

// The plan for a person's review of one recorded indicator result: the result by id and digest, the conclusion and
// the note, authored by the plan's principal. The review request is retained before it is sent.

export type ReviewConclusion = (typeof indicatorReviewConclusionValues)[number];

export interface ControlEffectivenessReviewPlan {
  version: 2;
  apiUrl: string;
  tenantId: string;
  principalId: string;
  result: { id: string; digest: string };
  conclusion: ReviewConclusion;
  note: string;
}

export interface RecordedReview {
  record: ControlIndicatorReviewRecord;
  digest: string;
}

export type ControlEffectivenessReviewJournal = ActionJournal<RecordedReview>;
export const reviewJournalKind = 'control-indicator-review-action';
export const maxReviewResponseBytes = 128 * 1024;

const recordShape = compile<ControlIndicatorReviewRecord>(ControlIndicatorReviewRecordSchema);

export function validateControlEffectivenessReviewPlan(value: unknown): ControlEffectivenessReviewPlan {
  if (
    !hasKeys(value, ['version', 'apiUrl', 'tenantId', 'principalId', 'result', 'conclusion', 'note']) ||
    value.version !== 2 ||
    !isId(value.tenantId) ||
    !isId(value.principalId) ||
    !hasKeys(value.result, ['id', 'digest']) ||
    !isId(value.result.id) ||
    !isDigest(value.result.digest) ||
    !indicatorReviewConclusionValues.includes(value.conclusion as ReviewConclusion) ||
    typeof value.note !== 'string' ||
    !value.note.trim() ||
    value.note.length > 4000
  )
    return pending('invalid_plan', 'The review plan requires one recorded result, a conclusion and a note');
  return {
    version: 2,
    apiUrl: apiOrigin(value.apiUrl),
    tenantId: value.tenantId,
    principalId: value.principalId,
    result: { id: value.result.id, digest: value.result.digest },
    conclusion: value.conclusion as ReviewConclusion,
    note: value.note,
  };
}

/** The recorded review as the plan asked for it: the same result, conclusion, note and author. */
export function validateRecordedReview(value: unknown, plan: ControlEffectivenessReviewPlan): RecordedReview {
  if (
    Buffer.byteLength(JSON.stringify(value ?? null)) > maxReviewResponseBytes ||
    !hasKeys(value, ['record', 'digest']) ||
    !recordShape(value.record) ||
    !isDigest(value.digest)
  )
    return pending('unsupported_response', 'The review response has an unsupported shape or exceeds its bound');
  const record = value.record;
  if (
    canonicalDigest(record) !== value.digest ||
    !same(record.result, plan.result) ||
    record.conclusion !== plan.conclusion ||
    record.note !== plan.note ||
    record.actor.id !== plan.principalId ||
    record.organizationId !== `organization:${plan.tenantId}`
  )
    return pending('acceptance_mismatch', 'The recorded review differs from the planned result, conclusion or author');
  return { record: structuredClone(record), digest: value.digest };
}

export function validateControlEffectivenessReviewJournal(
  value: unknown,
  plan?: ControlEffectivenessReviewPlan,
): ControlEffectivenessReviewJournal {
  return validateJournal<RecordedReview>(value, reviewJournalKind, ['review'], (_step, accepted) => {
    if (plan) validateRecordedReview(accepted, plan);
  });
}

export function readControlEffectivenessReviewJournal(path: string, plan?: ControlEffectivenessReviewPlan) {
  return readJournal(path, (value) => validateControlEffectivenessReviewJournal(value, plan));
}
