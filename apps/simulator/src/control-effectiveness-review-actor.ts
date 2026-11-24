import { randomUUID } from 'node:crypto';
import type { LedgerClient } from '@ledger/adapters';
import { ControlIndicatorReviewResponseSchema, ControlIndicatorReviewSchema } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  ActorPending,
  action,
  checkContract,
  checkPrincipal,
  lockJournal,
  pending,
  same,
  saveJournal,
  submit,
  type ServedOperation,
} from './indicator-actor-common.js';
import {
  readControlEffectivenessReviewJournal,
  reviewJournalKind,
  validateControlEffectivenessReviewJournal,
  validateControlEffectivenessReviewPlan,
  validateRecordedReview,
  type ControlEffectivenessReviewJournal,
  type ControlEffectivenessReviewPlan,
  type RecordedReview,
} from './control-effectiveness-review-plan.js';

// Records a person's review of one recorded indicator result and confirms it with an exact read. The request is kept
// with its key before it is sent, so a retry replays it exactly and never records a second review.

export interface ControlEffectivenessReviewActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  attempts: number;
  reviewId?: string;
  reviewDigest?: string;
  record?: 'confirmed' | 'unconfirmed';
}

export const reviewsPath = '/v1/control-indicator-reviews';
export const reviewPath = '/v1/control-indicator-reviews/{reviewId}';

const operations: ServedOperation[] = [
  {
    path: reviewsPath,
    method: 'post',
    operationId: 'reviewControlIndicatorResult',
    status: 201,
    body: ControlIndicatorReviewSchema,
    response: ControlIndicatorReviewResponseSchema,
    keyed: true,
  },
  {
    path: reviewPath,
    method: 'get',
    operationId: 'getControlIndicatorReview',
    status: 200,
    response: ControlIndicatorReviewResponseSchema,
  },
];

export async function runControlEffectivenessReview(
  value: ControlEffectivenessReviewPlan,
  statePath: string,
  ledger: LedgerClient,
): Promise<ControlEffectivenessReviewActorResult> {
  let journal: ControlEffectivenessReviewJournal | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let stage = 'journal';
  let bound = false;
  let plan: ControlEffectivenessReviewPlan;
  const validate = (journalValue: unknown) => validateControlEffectivenessReviewJournal(journalValue, plan);
  try {
    plan = validateControlEffectivenessReviewPlan(value);
    const url = new URL(ledger.baseUrl);
    if (url.origin !== plan.apiUrl || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
      pending('api_changed', 'The client differs from the plan’s pinned API origin');
    unlock = await lockJournal(statePath, 'Control effectiveness review');
    journal = await readControlEffectivenessReviewJournal(statePath);
    const body = JSON.stringify({ result: plan.result, conclusion: plan.conclusion, note: plan.note });
    if (journal) {
      if (
        journal.planDigest !== canonicalDigest(plan) ||
        journal.apiUrl !== plan.apiUrl ||
        journal.tenantId !== plan.tenantId ||
        journal.principalId !== plan.principalId ||
        (journal.actions[0] && journal.actions[0].payload !== body)
      )
        pending('journal_mismatch', 'The retained review belongs to another plan, API or principal');
      validate(journal);
    } else
      journal = {
        version: 2,
        kind: reviewJournalKind,
        apiUrl: plan.apiUrl,
        planDigest: canonicalDigest(plan),
        tenantId: plan.tenantId,
        principalId: plan.principalId,
        actions: [],
      };
    let review = journal.actions[0];
    if (review?.status === 'rejected')
      return {
        status: 'rejected',
        code: review.rejection!.code,
        reason: 'This retained review request was definitively rejected',
        attempts: 1,
      };
    bound = true;
    stage = 'preparation';
    if (!review) {
      const key = `simulator:control-indicator-review:${randomUUID()}`;
      await checkContract(ledger, key, operations);
      const principal = await checkPrincipal(ledger, plan, ['decision:write', 'flight:read']);
      if (principal.kind !== 'human') pending('human_required', 'A review is authored by a person');
      review = action<RecordedReview>('review', key, body);
      journal.actions.push(review);
      await saveJournal(statePath, journal, validate);
    } else await checkPrincipal(ledger, plan, ['evidence:read']);
    if (review.status === 'submitted') {
      stage = 'submission';
      await submit(
        review,
        (request, key) => ledger.request<unknown>(reviewsPath, { method: 'POST', body: JSON.stringify(request) }, key),
        (response) => validateRecordedReview(response, plan),
      );
      await saveJournal(statePath, journal, validate);
      if (review.rejection)
        return {
          status: 'rejected',
          code: review.rejection!.code,
          reason: 'The server rejected this exact review; no replacement will be recorded',
          attempts: 1,
        };
    }
    const recorded = review.accepted!;
    stage = 'confirmation';
    const confirmed = validateRecordedReview(
      await ledger.request<unknown>(reviewPath.replace('{reviewId}', encodeURIComponent(recorded.record.id))),
      plan,
    );
    if (!same(confirmed, recorded)) pending('review_unconfirmed', 'The exact read did not confirm the recorded review');
    return {
      status: 'accepted',
      code: 'review_confirmed',
      reason: 'The recorded review has a fresh exact read',
      attempts: 1,
      reviewId: recorded.record.id,
      reviewDigest: recorded.digest,
      record: 'confirmed',
    };
  } catch (error) {
    const recorded = bound && journal?.actions[0]?.status === 'accepted' ? journal.actions[0].accepted : undefined;
    return {
      status: recorded ? 'accepted' : 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending
          ? error.message
          : stage === 'submission'
            ? 'The outcome is uncertain; retry with this journal to replay the identical request and key'
            : 'The review could not be confirmed; retain its plan and journal before retrying',
      attempts: journal?.actions.length ?? 0,
      ...(recorded
        ? { reviewId: recorded.record.id, reviewDigest: recorded.digest, record: 'unconfirmed' as const }
        : {}),
    };
  } finally {
    await unlock?.();
  }
}
