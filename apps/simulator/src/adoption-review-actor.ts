import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CommandResponse,
  OrganizationDecisionCommand,
  OrganizationDecisionsResponse,
  SubjectDecisionRecord,
  SubjectExportResponse,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type { OracleReader } from './attempt-oracle.js';
import {
  checkReviewAuthority,
  reviewShownAdoption,
  validateReviewPlan,
  type ReviewPlan,
} from './adoption-review-plan.js';
import {
  lockReviewJournal,
  readReviewJournal,
  saveReviewJournal,
  type ReviewAction,
  type ReviewJournal,
} from './adoption-review-journal.js';
import { OracleReadError } from './oracle-api.js';
import { definitiveRejection } from './pack-adoption-actor.js';
import { AdoptionPending } from './pack-adoption-review.js';
import { readPrivateText } from './private-journal.js';
import {
  maxSubjectExportBytes,
  retainReviewBundle,
  validateReviewExport,
  verifyReviewExport,
} from './review-export.js';

export interface ReviewActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  attempts: number;
  decisionId?: string;
  processing?: 'pending' | 'projected' | 'failed' | 'unknown';
  exportId?: string;
  manifestDigest?: string;
  verification?: 'verified' | 'integrity_only';
  bundlePath?: string;
}
type Submit = (
  endpoint: '/v1/commands' | '/v1/subject-exports',
  payload: string,
  key: string,
) => Promise<CommandResponse | SubjectExportResponse>;
type Processing = NonNullable<ReviewActorResult['processing']>;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

function retainedReview(action: ReviewAction, plan: ReviewPlan): OrganizationDecisionCommand {
  const command = JSON.parse(action.payload) as OrganizationDecisionCommand;
  if (
    command.kind !== 'decision.record' ||
    !same(command.subject, { kind: 'organization' }) ||
    command.decision?.kind !== 'adoption.review' ||
    command.decision.note !== plan.note ||
    !same(command.adoption, plan.adoption) ||
    !revision(command.expectedRevision) ||
    command.inputCut?.basisRevision !== command.expectedRevision ||
    !revision(command.inputCut.principalRevision) ||
    !object(command.inputCut.streams) ||
    Object.values(command.inputCut.streams).some((position) => !revision(position)) ||
    !digest(command.expectedDependencyBasis)
  )
    throw new AdoptionPending(
      'journal_mismatch',
      'The retained review differs from the pinned plan or displayed basis',
    );
  return command;
}

function checkJournal(journal: ReviewJournal, plan: ReviewPlan): void {
  if (
    journal.planDigest !== canonicalDigest(plan) ||
    journal.tenantId !== plan.tenantId ||
    journal.principalId !== plan.principalId ||
    journal.endpoint !== '/v1/commands'
  )
    throw new AdoptionPending(
      'journal_mismatch',
      'The review journal belongs to a different plan, principal or API origin',
    );
  for (const [index, action] of journal.actions.entries()) {
    retainedReview(action, plan);
    if (
      (action.status === 'accepted' && (!action.decisionId || action.rejection)) ||
      (action.status === 'submitted' && (action.decisionId || action.rejection)) ||
      (action.status === 'rejected' && (!action.rejection || action.decisionId)) ||
      (index < journal.actions.length - 1 &&
        (action.status !== 'rejected' || action.rejection?.status !== 409 || action.rejection.code !== 'stale_basis'))
    )
      throw new AdoptionPending('journal_mismatch', 'The retained review action sequence is inconsistent');
  }
  const exported = journal.export;
  if (!exported) return;
  const action = journal.actions.at(-1);
  if (
    !plan.export ||
    action?.status !== 'accepted' ||
    exported.endpoint !== '/v1/subject-exports' ||
    !same(JSON.parse(exported.payload), {
      subject: { kind: 'organization' },
      decisionId: action.decisionId,
      scope: 'whole_tenant_prefixes',
    }) ||
    (exported.status === 'accepted' && (!exported.record || exported.rejection)) ||
    (exported.status === 'submitted' && (exported.record || exported.rejection)) ||
    (exported.status === 'rejected' && (!exported.rejection || exported.record))
  )
    throw new AdoptionPending('journal_mismatch', 'The retained export is not attached to this accepted review');
  if (exported.record) validateReviewExport(exported.record, plan, action.decisionId!);
}

function confirmedReview(response: CommandResponse, action: ReviewAction, plan: ReviewPlan): string {
  const command = response?.command;
  if (
    !command ||
    !id(command.id) ||
    command.kind !== 'decision.record' ||
    command.flightId !== undefined ||
    command.actorId !== plan.principalId ||
    !same(command.payload, JSON.parse(action.payload)) ||
    typeof command.recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(command.recordedAt))
  )
    throw new AdoptionPending('review_unconfirmed', 'The command response did not confirm this exact retained review');
  return command.id;
}

function checkVisibleReview(record: SubjectDecisionRecord, action: ReviewAction, plan: ReviewPlan): Processing {
  const command = retainedReview(action, plan);
  const subject = { kind: 'organization', id: `organization:${plan.tenantId}` };
  if (
    record.id !== action.decisionId ||
    !same(record.subject, subject) ||
    record.kind !== 'adoption.review' ||
    record.note !== plan.note ||
    !same(record.adoption, plan.adoption) ||
    record.acceptedRevision !== command.expectedRevision + 1 ||
    record.acceptedBasisRevision !== command.expectedRevision ||
    !same(record.renderedInputCut, command.inputCut) ||
    record.dependencyBasis !== command.expectedDependencyBasis ||
    canonicalDigest(record.basisManifest) !== record.dependencyBasis ||
    record.actor?.id !== plan.principalId ||
    record.actor.principalRevision !== command.inputCut.principalRevision ||
    record.actor.policyVersion !== 'ledger.organization-review-authority.1' ||
    record.actor.historicalProfile !== 'retained' ||
    !same(record.actor.scope, subject) ||
    !same(record.actor.checkedCapabilities, ['decision:write']) ||
    !record.actor.capabilities?.includes('decision:write') ||
    !['pending', 'projected', 'failed'].includes(record.processing?.status)
  )
    throw new AdoptionPending(
      'review_commitment_mismatch',
      'The visible review differs from the retained command or authority basis',
    );
  return record.processing.status as Processing;
}

async function reviewProcessing(api: OracleReader, action: ReviewAction, plan: ReviewPlan): Promise<Processing> {
  for (let attempt = 0; attempt < (plan.export ? 1 : 3); attempt++) {
    const view = await api.json<OrganizationDecisionsResponse>('/v1/organization/decisions');
    if (
      view?.organization?.id !== `organization:${plan.tenantId}` ||
      !revision(view.organization.revision) ||
      !revision(view.organization.projectedRevision) ||
      view.organization.projectedRevision > view.organization.revision ||
      !Array.isArray(view.decisions) ||
      view.decisions.length > 100 ||
      view.limit !== 100 ||
      typeof view.hasOlder !== 'boolean'
    )
      throw new AdoptionPending(
        'review_history_unavailable',
        'Organization history did not return a supported scoped view',
      );
    const records = view.decisions.filter((record) => record.id === action.decisionId);
    if (records.length > 1)
      throw new AdoptionPending('review_commitment_mismatch', 'Organization history duplicated the retained review');
    const processing = records[0] ? checkVisibleReview(records[0], action, plan) : 'unknown';
    if (plan.export || processing === 'projected' || processing === 'failed' || attempt === 2) return processing;
    await delay(100);
  }
  return 'unknown';
}

async function exportReview(
  plan: ReviewPlan,
  statePath: string,
  journal: ReviewJournal,
  api: OracleReader,
  submit: Submit,
): Promise<Pick<ReviewActorResult, 'exportId' | 'manifestDigest' | 'verification' | 'bundlePath'>> {
  const action = journal.actions.at(-1)!;
  if (!journal.export) {
    const payload = JSON.stringify({
      subject: { kind: 'organization' },
      decisionId: action.decisionId!,
      scope: 'whole_tenant_prefixes',
    });
    journal.export = {
      endpoint: '/v1/subject-exports',
      key: `simulator:review-export:${randomUUID()}`,
      payload,
      payloadSha256: sha256(payload),
      status: 'submitted',
    };
    await saveReviewJournal(statePath, journal);
  }
  const exported = journal.export;
  if (exported.status === 'rejected')
    throw new AdoptionPending(
      exported.rejection!.code,
      'The retained export was definitively rejected; its action will not be replaced',
    );
  if (exported.status === 'submitted') {
    let response: SubjectExportResponse;
    try {
      response = (await submit('/v1/subject-exports', exported.payload, exported.key)) as SubjectExportResponse;
    } catch (error) {
      const rejection = definitiveRejection(error);
      if (!rejection || (rejection.status === 409 && rejection.code !== 'idempotency_conflict')) throw error;
      exported.status = 'rejected';
      exported.rejection = rejection;
      await saveReviewJournal(statePath, journal);
      throw new AdoptionPending(rejection.code, 'The server definitively rejected the retained export action');
    }
    exported.record = validateReviewExport(response?.record, plan, action.decisionId!);
    exported.status = 'accepted';
    await saveReviewJournal(statePath, journal);
  }
  const record = exported.record!;
  const bundlePath = `${resolve(statePath)}.bundle.json`;
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(await readPrivateText(bundlePath, maxSubjectExportBytes), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    bytes = await api.bytes(`/v1/subject-exports/${encodeURIComponent(record.id)}/content`);
  }
  const verification = await verifyReviewExport(bytes, record, plan, retainedReview(action, plan));
  await retainReviewBundle(bundlePath, bytes, record.bundleSha256);
  return { exportId: record.id, manifestDigest: record.manifestDigest, verification, bundlePath };
}

export async function runAdoptionReview(
  planValue: ReviewPlan,
  statePath: string,
  api: OracleReader,
  submit: Submit,
): Promise<ReviewActorResult> {
  let journal: ReviewJournal | undefined;
  let release: (() => Promise<void>) | undefined;
  let processing: Processing = 'unknown';
  let stage: 'journal' | 'review' | 'review_submission' | 'history' | 'export_submission' = 'journal';
  try {
    const plan = validateReviewPlan(planValue);
    release = await lockReviewJournal(statePath);
    journal = await readReviewJournal(statePath);
    if (journal) checkJournal(journal, plan);
    else
      journal = {
        version: 1,
        kind: 'adoption-review',
        planDigest: canonicalDigest(plan),
        principalId: plan.principalId,
        tenantId: plan.tenantId,
        endpoint: '/v1/commands',
        actions: [],
      };
    let action = journal.actions.at(-1);
    stage = 'review';
    if (action?.status === 'rejected' && (action.rejection?.status !== 409 || action.rejection.code !== 'stale_basis'))
      return {
        status: 'rejected',
        code: action.rejection!.code,
        reason: 'The retained review was definitively rejected; no replacement action will be created',
        attempts: journal.actions.length,
      };
    if (!action || action.status === 'rejected') {
      if (journal.actions.length >= 16)
        throw new AdoptionPending('action_limit', 'The review journal reached its bounded action limit');
      const command = await reviewShownAdoption(plan, api);
      const payload = JSON.stringify(command);
      action = {
        key: `simulator:adoption-review:${randomUUID()}`,
        payload,
        payloadSha256: sha256(payload),
        status: 'submitted',
      };
      journal.actions.push(action);
      await saveReviewJournal(statePath, journal);
    } else await checkReviewAuthority(plan, api);
    if (action.status === 'submitted') {
      stage = 'review_submission';
      const response = (await submit('/v1/commands', action.payload, action.key)) as CommandResponse;
      action.decisionId = confirmedReview(response, action, plan);
      action.status = 'accepted';
      await saveReviewJournal(statePath, journal);
    }
    stage = 'history';
    processing = await reviewProcessing(api, action, plan);
    const base = { attempts: journal.actions.length, decisionId: action.decisionId!, processing };
    if (!plan.export)
      return {
        ...base,
        status: processing === 'projected' ? 'accepted' : 'pending',
        code: processing === 'unknown' ? 'review_not_visible' : `review_${processing}`,
        reason:
          processing === 'projected'
            ? 'The informational review is accepted and projected; adoption and leaf activation are unchanged'
            : 'The informational review is accepted; projection is pending, failed or outside the bounded history window',
      };
    stage = 'export_submission';
    const exported = await exportReview(plan, statePath, journal, api, submit);
    return {
      ...base,
      ...exported,
      status: exported.verification === 'verified' ? 'accepted' : 'pending',
      code: exported.verification === 'verified' ? 'export_verified' : 'export_integrity_only',
      reason:
        exported.verification === 'verified'
          ? 'The informational review and its retained subject export are verified against the saved manifest digest'
          : 'Export integrity is verified, but complete inventory reconstruction is unavailable',
    };
  } catch (error) {
    const action = journal?.actions.at(-1);
    const rejection = stage === 'review_submission' ? definitiveRejection(error) : undefined;
    if (rejection && journal) {
      const target = action!;
      target.status = 'rejected';
      target.rejection = rejection;
      await saveReviewJournal(statePath, journal);
    }
    return {
      status: rejection || journal?.export?.status === 'rejected' ? 'rejected' : 'pending',
      code:
        rejection?.code ??
        (error instanceof AdoptionPending || error instanceof OracleReadError ? error.code : `${stage}_unavailable`),
      reason: rejection
        ? rejection.code === 'stale_basis' && stage === 'review_submission'
          ? 'The server definitively rejected the stale review basis; a later invocation may review a fresh basis and create a new action'
          : 'The server definitively rejected the retained action; its bytes and key remain recorded'
        : error instanceof AdoptionPending || error instanceof OracleReadError
          ? error.message
          : stage === 'journal'
            ? 'The review journal cannot be locked or validated; retain it and resolve any abandoned lock before retrying'
            : 'The action or download could not be confirmed; retry with this journal to preserve its exact bytes, keys and export commitments',
      attempts: journal?.actions.length ?? 0,
      ...(action?.decisionId ? { decisionId: action.decisionId, processing } : {}),
      ...(journal?.export?.record
        ? { exportId: journal.export.record.id, manifestDigest: journal.export.record.manifestDigest }
        : {}),
    };
  } finally {
    await release?.();
  }
}
