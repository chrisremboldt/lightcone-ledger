import { randomUUID } from 'node:crypto';
import type { LedgerClient } from '@ledger/adapters';
import type { CommandRecord, SmsFindingPromotionResponse, SmsRecordDetailResponse } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  ActorPending,
  action,
  checkPrincipal,
  lockJournal,
  pending,
  saveJournal,
  submit,
  type RetainedAction,
} from './indicator-actor-common.js';
import {
  acceptedSmsCommand,
  hazardRecordJournalKind,
  hazardRecordSteps,
  readHazardJournal,
  validateHazardJournal,
  validateHazardRecordPlan,
  validateRecordDetail,
  type HazardJournal,
  type HazardRecordPlan,
} from './hazard-plan.js';

// A simulated safety lead records a hazard on the safety record: promotes the planned finding to a hazard, proposes an
// avoidance area on it and assesses it on the organization's adopted matrix with that control in place. Each request
// is kept in the journal with its key before it is sent, so a retry replays it exactly and never makes a second one.

export interface HazardActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  attempts: number;
  hazardId?: string;
  controlId?: string;
  assessmentId?: string;
}

export const commandsPath = '/v1/commands';
export const promotionPath = '/v1/sms/findings/{findingId}/promotion';
export const recordPath = '/v1/sms/records/{id}';
const avoidanceAreaType = 'control.avoidance-area';

function checkClient(plan: { apiUrl: string }, ledger: LedgerClient): void {
  const url = new URL(ledger.baseUrl);
  if (url.origin !== plan.apiUrl || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
    pending('api_changed', 'The client differs from the plan’s pinned API origin');
}

export function readRecord(ledger: LedgerClient, id: string, kind: string): Promise<SmsRecordDetailResponse> {
  return ledger
    .request<unknown>(recordPath.replace('{id}', encodeURIComponent(id)))
    .then((value) => validateRecordDetail(value, id, kind));
}

function decide(hazard: SmsRecordDetailResponse, decision: Record<string, unknown>) {
  return {
    kind: 'decision.record',
    subject: { kind: 'sms', id: hazard.record.id },
    expectedRevision: hazard.basis.revision,
    expectedDependencyBasis: hazard.basis.dependencyBasis,
    decision,
  };
}

async function hazardRequest(plan: HazardRecordPlan, ledger: LedgerClient) {
  const shown = await ledger.request<SmsFindingPromotionResponse>(
    promotionPath.replace('{findingId}', encodeURIComponent(plan.finding.findingId)),
  );
  if (shown.existingHazard)
    pending('hazard_already_opened', 'A hazard was already opened from this evaluation; record nothing more');
  if (
    shown.origin.evaluationId !== plan.finding.evaluationId ||
    shown.origin.evaluationDigest !== plan.finding.evaluationDigest
  )
    pending('stale_finding', 'The finding has a newer evaluation than the one the plan reviewed');
  return {
    kind: 'sms.record.open',
    record: {
      kind: 'hazard',
      schema: 'sms.hazard.1',
      title: plan.hazard.title,
      ownerId: plan.principalId,
      body: {
        description: plan.hazard.description,
        consequence: plan.hazard.consequence,
        source: { kind: 'finding' },
      },
    },
    origin: {
      kind: 'finding',
      findingId: plan.finding.findingId,
      evaluationId: plan.finding.evaluationId,
      expectedDependencyBasis: shown.basis.dependencyBasis,
    },
  };
}

function controlRequest(plan: HazardRecordPlan, hazard: SmsRecordDetailResponse) {
  const type = hazard.controlTypes?.find((entry) => entry.id === avoidanceAreaType);
  if (!type) pending('control_type_unavailable', 'The avoidance area is not offered as a control type here');
  return {
    kind: 'sms.record.open',
    record: {
      kind: 'control',
      schema: 'sms.control.1',
      title: plan.control.title,
      ownerId: plan.principalId,
      body: {
        hazardId: hazard.record.id,
        controlType: { id: type.id, version: type.version, digest: type.digest },
        parameters: { center: { ...plan.control.center }, radiusMeters: plan.control.radiusMeters },
        effectiveFrom: plan.control.effectiveFrom,
        ...(plan.control.effectiveUntil ? { effectiveUntil: plan.control.effectiveUntil } : {}),
      },
    },
  };
}

function assessmentRequest(plan: HazardRecordPlan, hazard: SmsRecordDetailResponse, controlId: string) {
  const control = hazard.controls?.find((entry) => entry.id === controlId);
  if (!hazard.matrix) pending('matrix_unavailable', 'The organization has no adopted risk matrix');
  if (!control) pending('control_unavailable', 'The proposed control is not listed on the hazard');
  return decide(hazard, {
    kind: 'risk.assess',
    note: plan.assessment.note,
    matrix: { recordId: hazard.matrix.record.id, versionNumber: hazard.matrix.version.versionNumber },
    initial: { ...plan.assessment.initial },
    controls: [{ recordId: control.id, versionNumber: control.versionNumber }],
    residual: { ...plan.assessment.residual },
    newHazardCheck: { answer: 'none_identified' },
    evidence: { evaluationId: plan.finding.evaluationId },
  });
}

function bindJournal(journal: HazardJournal, plan: HazardRecordPlan): void {
  if (
    journal.planDigest !== canonicalDigest(plan) ||
    journal.apiUrl !== plan.apiUrl ||
    journal.tenantId !== plan.tenantId ||
    journal.principalId !== plan.principalId
  )
    pending('journal_mismatch', 'The retained journal belongs to another plan, API or principal');
}

/** Sends one step's retained request, preparing it first from what the server shows now if it is not yet kept. */
async function step(
  journal: HazardJournal,
  index: number,
  prepare: () => Promise<unknown>,
  persist: () => Promise<void>,
  ledger: LedgerClient,
  principalId: string,
): Promise<RetainedAction<CommandRecord>> {
  let entry = journal.actions[index];
  if (!entry) {
    const body = await prepare();
    entry = action<CommandRecord>(
      hazardRecordSteps[index]!,
      `simulator:sms-hazard:${randomUUID()}`,
      JSON.stringify(body),
    );
    journal.actions.push(entry);
    await persist();
  }
  if (entry.status === 'submitted') {
    await submit(
      entry,
      (body, key) => ledger.request<unknown>(commandsPath, { method: 'POST', body: JSON.stringify(body) }, key),
      (response) => acceptedSmsCommand(response, entry!.payload, principalId),
    );
    await persist();
  }
  return entry;
}

export async function runHazardRecord(
  value: HazardRecordPlan,
  statePath: string,
  ledger: LedgerClient,
): Promise<HazardActorResult> {
  let journal: HazardJournal | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let stage = 'journal';
  const result = (): Partial<HazardActorResult> => {
    const [hazard, control, assessment] = (journal?.actions ?? []).map((entry) => entry.accepted?.subject?.id);
    return {
      ...(hazard ? { hazardId: hazard } : {}),
      ...(control ? { controlId: control } : {}),
      ...(assessment ? { assessmentId: journal!.actions[2]!.accepted!.id } : {}),
    };
  };
  try {
    const plan = validateHazardRecordPlan(value);
    const validate = (journalValue: unknown) =>
      validateHazardJournal(journalValue, hazardRecordJournalKind, hazardRecordSteps, plan.principalId);
    const persist = () => saveJournal(statePath, journal!, validate);
    checkClient(plan, ledger);
    unlock = await lockJournal(statePath, 'Hazard record');
    journal = await readHazardJournal(statePath, hazardRecordJournalKind, hazardRecordSteps, plan.principalId);
    if (journal) bindJournal(journal, plan);
    else
      journal = {
        version: 2,
        kind: hazardRecordJournalKind,
        apiUrl: plan.apiUrl,
        planDigest: canonicalDigest(plan),
        tenantId: plan.tenantId,
        principalId: plan.principalId,
        actions: [],
      };
    const rejected = journal.actions.find((entry) => entry.status === 'rejected');
    if (rejected)
      return {
        status: 'rejected',
        code: rejected.rejection!.code,
        reason: `The retained ${rejected.step} request was definitively rejected`,
        attempts: journal.actions.length,
        ...result(),
      };
    stage = 'preparation';
    await checkPrincipal(ledger, plan, ['sms:read', 'sms:write', 'decision:write', 'flight:read']);
    for (const [index, name] of hazardRecordSteps.entries()) {
      stage = name;
      const entry = await step(
        journal,
        index,
        async () => {
          if (index === 0) return hazardRequest(plan, ledger);
          const hazardId = journal!.actions[0]!.accepted!.subject!.id;
          const hazard = await readRecord(ledger, hazardId, 'hazard');
          if (index === 1) return controlRequest(plan, hazard);
          return assessmentRequest(plan, hazard, journal!.actions[1]!.accepted!.subject!.id);
        },
        persist,
        ledger,
        plan.principalId,
      );
      if (entry.rejection)
        return {
          status: 'rejected',
          code: entry.rejection.code,
          reason: `The server refused the ${name} request; no replacement will be created`,
          attempts: journal.actions.length,
          ...result(),
        };
    }
    return {
      status: 'accepted',
      code: 'hazard_assessed',
      reason: 'The hazard, its avoidance area and its assessment are on the safety record',
      attempts: journal.actions.length,
      ...result(),
    };
  } catch (error) {
    return {
      status: 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending
          ? error.message
          : hazardRecordSteps.includes(stage)
            ? 'The outcome is uncertain; retry with this journal to replay the identical request and key'
            : 'The hazard could not be recorded; retain its plan and journal before retrying',
      attempts: journal?.actions.length ?? 0,
      ...result(),
    };
  } finally {
    await unlock?.();
  }
}
