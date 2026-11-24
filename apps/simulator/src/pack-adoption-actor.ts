import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CommandResponse,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  PackAdoptionRecord,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type { OracleReader } from './attempt-oracle.js';
import { OracleReadError } from './oracle-api.js';
import {
  lockAdoptionJournal,
  readAdoptionJournal,
  saveAdoptionJournal,
  type ActionJournal,
  type AdoptionAction,
} from './pack-adoption-journal.js';
import {
  AdoptionPending,
  checkAdoptionAuthority,
  reviewAdoption,
  validateAdoptionPlan,
  verifyAdoptionPackReferences,
  type AdoptionPlan,
} from './pack-adoption-review.js';

export interface AdoptionActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  actionKey?: string;
  adoptionId?: string;
  processing?: 'pending' | 'projected' | 'failed' | 'unknown';
  state?: 'pending' | 'scheduled' | 'effective' | 'expired' | 'unknown';
  coverage?: Array<{ leafId: string; coverage: string; evidenceState: string }>;
  attempts: number;
}

const endpoint = '/v1/commands';
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const utc = (value: unknown): value is string =>
  typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);

function retainedCommand(action: AdoptionAction, plan: AdoptionPlan): PackAdoptionCommand {
  const command = JSON.parse(action.payload) as PackAdoptionCommand;
  if (
    command.kind !== 'rule-pack.adopt' ||
    !same(command.pack, plan.pack) ||
    !same(command.effectiveInterval, plan.effectiveInterval) ||
    command.note !== plan.note ||
    command.mode !== plan.mode ||
    !revision(command.expectedRevision) ||
    !object(command.inputCut) ||
    command.inputCut.basisRevision !== command.expectedRevision ||
    !revision(command.inputCut.principalRevision) ||
    !object(command.inputCut.streams) ||
    Object.values(command.inputCut.streams).some((value) => !revision(value)) ||
    !digest(command.expectedDependencyBasis)
  )
    throw new AdoptionPending('journal_mismatch', 'The retained command no longer matches the configured adoption');
  return command;
}

function checkJournal(journal: ActionJournal, plan: AdoptionPlan): void {
  if (
    journal.planDigest !== canonicalDigest(plan) ||
    journal.principalId !== plan.principalId ||
    journal.tenantId !== plan.tenantId ||
    journal.endpoint !== endpoint
  )
    throw new AdoptionPending(
      'journal_mismatch',
      'The journal belongs to a different adoption plan or acting principal',
    );
  for (const [index, action] of journal.actions.entries()) {
    retainedCommand(action, plan);
    if (
      (action.status === 'accepted' && (!action.adoptionId || action.rejection !== undefined)) ||
      (action.status === 'submitted' && (action.adoptionId !== undefined || action.rejection !== undefined)) ||
      (action.status === 'rejected' && (!action.rejection || action.adoptionId !== undefined)) ||
      (index < journal.actions.length - 1 &&
        (action.status !== 'rejected' || action.rejection?.status !== 409 || action.rejection.code !== 'stale_basis'))
    )
      throw new AdoptionPending('journal_mismatch', 'The retained adoption action sequence is inconsistent');
  }
}

export function retainedAcceptedAdoption(
  journal: ActionJournal,
  plan: AdoptionPlan,
): { adoptionId: string; acceptedRevision: number } {
  checkJournal(journal, plan);
  const action = journal.actions.at(-1);
  if (action?.status !== 'accepted' || !action.adoptionId)
    throw new AdoptionPending('adoption_unconfirmed', 'Selection inspection requires an existing accepted adoption');
  const acceptedRevision = retainedCommand(action, plan).expectedRevision + 1;
  if (!Number.isSafeInteger(acceptedRevision))
    throw new AdoptionPending('journal_mismatch', 'The retained adoption revision is unsupported');
  return { adoptionId: action.adoptionId, acceptedRevision };
}

function acceptedResponse(value: CommandResponse, action: AdoptionAction, plan: AdoptionPlan): string {
  const command = value?.command;
  if (
    !command ||
    !id(command.id) ||
    command.kind !== 'rule-pack.adopt' ||
    command.actorId !== plan.principalId ||
    command.flightId !== undefined ||
    !utc(command.recordedAt) ||
    !same(command.payload, JSON.parse(action.payload))
  )
    throw new AdoptionPending(
      'acceptance_unconfirmed',
      'The command response did not confirm this exact retained adoption',
    );
  return command.id;
}

export function definitiveRejection(error: unknown): { status: number; code: string } | undefined {
  if (
    !(error instanceof ApiError) ||
    error.status < 400 ||
    error.status >= 500 ||
    [401, 403, 404, 408, 425, 429].includes(error.status) ||
    !object(error.body) ||
    !object(error.body.error) ||
    typeof error.body.error.code !== 'string' ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(error.body.error.code)
  )
    return undefined;
  return { status: error.status, code: error.body.error.code };
}

function checkCoverage(
  view: OrganizationCoverageResponse,
  action: AdoptionAction,
  plan: AdoptionPlan,
): PackAdoptionRecord | undefined {
  const organizationId = `organization:${plan.tenantId}`;
  if (
    view?.organization?.id !== organizationId ||
    !Array.isArray(view.adoptions) ||
    view.adoptions.length > 100 ||
    view.limit !== 100 ||
    typeof view.hasOlder !== 'boolean' ||
    !utc(view.asOf)
  )
    throw new AdoptionPending('coverage_unavailable', 'Organization coverage did not return the supported scoped view');
  const matches = view.adoptions.filter((record) => record.id === action.adoptionId);
  if (!matches.length) return undefined;
  const record = matches[0]!;
  const command = retainedCommand(action, plan);
  verifyAdoptionPackReferences(plan.pack, record.pack);
  if (
    matches.length !== 1 ||
    record.organizationId !== organizationId ||
    record.scope?.kind !== 'organization' ||
    record.scope.organizationId !== organizationId ||
    record.actor?.id !== plan.principalId ||
    record.actor.principalRevision !== command.inputCut.principalRevision ||
    record.actor.policyVersion !== 'ledger.pack-adoption-authority.1' ||
    !same(record.actor.checkedCapabilities, ['pack:adopt']) ||
    !record.actor.capabilities?.includes('pack:adopt') ||
    record.acceptedRevision !== command.expectedRevision + 1 ||
    record.dependencyBasis !== command.expectedDependencyBasis ||
    !same(record.renderedInputCut, command.inputCut) ||
    !utc(record.acceptedAt) ||
    record.note !== plan.note ||
    !same(record.effectiveInterval, plan.effectiveInterval)
  )
    throw new AdoptionPending(
      'coverage_mismatch',
      'The visible adoption differs from the retained command or authority basis',
    );
  const processing = record.processing?.status;
  const expectedState =
    processing !== 'projected'
      ? 'pending'
      : Date.parse(view.asOf) < Date.parse(plan.effectiveInterval.start)
        ? 'scheduled'
        : Date.parse(view.asOf) >= Date.parse(plan.effectiveInterval.end)
          ? 'expired'
          : 'effective';
  const expectedCoverage = record.pack.leaves.map((leaf) => ({
    leafId: leaf.id,
    coverage: leaf.coverage,
    evidenceState:
      leaf.coverage === 'automated'
        ? 'inactive'
        : leaf.coverage === 'manual'
          ? 'manual_review_required'
          : 'unsupported',
  }));
  if (
    !['pending', 'projected', 'failed'].includes(processing) ||
    record.state !== expectedState ||
    !Array.isArray(record.coverage) ||
    !same(
      [...record.coverage].sort((a, b) => a.leafId.localeCompare(b.leafId)),
      expectedCoverage.sort((a, b) => a.leafId.localeCompare(b.leafId)),
    )
  )
    throw new AdoptionPending(
      'coverage_mismatch',
      'Adoption processing or leaf coverage does not match the supported contract',
    );
  return record;
}

async function trackCoverage(
  plan: AdoptionPlan,
  action: AdoptionAction,
  api: OracleReader,
  attempts: number,
): Promise<AdoptionActorResult> {
  const base = { actionKey: action.key, adoptionId: action.adoptionId!, attempts };
  for (let read = 0; read < 3; read++) {
    const view = await api.json<OrganizationCoverageResponse>('/v1/organization/coverage');
    const record = checkCoverage(view, action, plan);
    if (!record) {
      if (read < 2) {
        await delay(100);
        continue;
      }
      return {
        ...base,
        status: 'pending',
        code: 'adoption_not_visible',
        reason:
          'The accepted adoption is outside the visible coverage window or not yet visible; its retained action will not be resubmitted',
        processing: 'unknown',
        state: 'unknown',
      };
    }
    if (record.processing.status === 'pending' && read < 2) {
      await delay(100);
      continue;
    }
    return {
      ...base,
      status: record.processing.status === 'projected' ? 'accepted' : 'pending',
      code: record.processing.status === 'projected' ? 'adoption_projected' : `projection_${record.processing.status}`,
      reason:
        record.processing.status === 'projected'
          ? 'The adoption is recorded and projected; effective interval state does not activate leaf evidence'
          : record.processing.status === 'failed'
            ? 'The command was accepted, but its coverage projection failed'
            : 'The command was accepted; its coverage projection is pending',
      processing: record.processing.status as 'pending' | 'projected' | 'failed',
      state: record.state as 'pending' | 'scheduled' | 'effective' | 'expired',
      coverage: record.coverage,
    };
  }
  throw new Error('Unreachable coverage read');
}

export async function runPackAdoption(
  value: AdoptionPlan,
  statePath: string,
  api: OracleReader,
  submit: (payload: string, key: string) => Promise<CommandResponse>,
): Promise<AdoptionActorResult> {
  let journal: ActionJournal | undefined;
  let release: (() => Promise<void>) | undefined;
  let stage: 'journal' | 'review' | 'submission' | 'coverage' = 'journal';
  try {
    const plan = validateAdoptionPlan(value);
    release = await lockAdoptionJournal(statePath);
    journal = await readAdoptionJournal(statePath);
    if (journal) checkJournal(journal, plan);
    else
      journal = {
        version: 1,
        planDigest: canonicalDigest(plan),
        principalId: plan.principalId,
        tenantId: plan.tenantId,
        endpoint,
        actions: [],
      };
    let action = journal.actions.at(-1);
    stage = 'review';
    if (action?.status === 'rejected' && (action.rejection?.status !== 409 || action.rejection.code !== 'stale_basis'))
      return {
        status: 'rejected',
        code: action.rejection!.code,
        reason: 'The retained command was definitively rejected; this journal will not create another action',
        actionKey: action.key,
        attempts: journal.actions.length,
      };
    if (!action || action.status === 'rejected') {
      if (journal.actions.length >= 16)
        throw new AdoptionPending('action_limit', 'The adoption journal reached its bounded action limit');
      const review = await reviewAdoption(plan, api);
      const payload = JSON.stringify(review.command);
      action = {
        key: `simulator:pack-adopt:${randomUUID()}`,
        payload,
        payloadSha256: sha256(payload),
        status: 'submitted',
      };
      journal.actions.push(action);
      await saveAdoptionJournal(statePath, journal);
    } else await checkAdoptionAuthority(plan, api);
    if (action.status === 'submitted') {
      stage = 'submission';
      try {
        const response = await submit(action.payload, action.key);
        action.adoptionId = acceptedResponse(response, action, plan);
        action.status = 'accepted';
        await saveAdoptionJournal(statePath, journal);
      } catch (error) {
        const rejection = definitiveRejection(error);
        if (!rejection) throw error;
        action.status = 'rejected';
        action.rejection = rejection;
        await saveAdoptionJournal(statePath, journal);
        return {
          status: 'rejected',
          code: rejection.code,
          reason:
            rejection.status === 409 && rejection.code === 'stale_basis'
              ? 'The server definitively rejected the stale basis; a later explicit invocation may review a fresh basis and create a new action'
              : 'The server definitively rejected this retained command',
          actionKey: action.key,
          attempts: journal.actions.length,
        };
      }
    }
    stage = 'coverage';
    return await trackCoverage(plan, action, api, journal.actions.length);
  } catch (error) {
    const action = journal?.actions.at(-1);
    return {
      status: 'pending',
      code: error instanceof AdoptionPending || error instanceof OracleReadError ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof AdoptionPending || error instanceof OracleReadError
          ? error.message
          : stage === 'journal'
            ? 'The adoption journal cannot be locked or validated; retain it and resolve any abandoned lock before retrying'
            : stage === 'submission'
              ? 'The submission outcome is uncertain; a later invocation will replay the identical retained bytes and key'
              : 'The adoption review or coverage read could not be completed; retain the journal before retrying',
      ...(action ? { actionKey: action.key } : {}),
      ...(action?.adoptionId
        ? { adoptionId: action.adoptionId, processing: 'unknown' as const, state: 'unknown' as const }
        : {}),
      attempts: journal?.actions.length ?? 0,
    };
  } finally {
    await release?.();
  }
}
