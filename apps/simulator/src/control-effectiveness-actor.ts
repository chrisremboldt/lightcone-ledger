import { randomUUID } from 'node:crypto';
import type { LedgerClient } from '@ledger/adapters';
import {
  ControlIndicatorRecordSchema,
  ControlIndicatorResultResponseSchema,
  ControlWindowOpenSchema,
  ControlWindowResponseSchema,
  type ControlIndicatorResultResponse,
  type ControlWindow,
} from '@ledger/contracts';
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
  calculationJournalKind,
  readControlEffectivenessJournal,
  validateControlEffectivenessJournal,
  validateControlEffectivenessPlan,
  validateOpenedWindow,
  validateRecordedResult,
  type CalculationAccepted,
  type ControlEffectivenessJournal,
  type ControlEffectivenessPlan,
  type RecordedIndicatorResult,
} from './control-effectiveness-plan.js';

// Records a control's indicator result: opens the planned window for the accepted control, records the indicator's
// result through it at the window's revision, and confirms the recorded result with an exact read. Each request is
// kept in the journal with its key before it is sent, so a retry replays it exactly and never makes a second one.

export interface ControlEffectivenessActorResult {
  status: 'pending' | 'accepted' | 'rejected';
  code: string;
  reason: string;
  attempts: number;
  windowId?: string;
  resultId?: string;
  resultDigest?: string;
  resultStatus?: RecordedIndicatorResult['record']['result']['status'];
  record?: 'confirmed' | 'unconfirmed';
  currentness?: ControlIndicatorResultResponse['currentness'];
}

export const windowsPath = '/v1/control-windows';
export const resultsPath = '/v1/control-windows/{windowId}/indicator-results';
export const resultPath = '/v1/control-indicator-results/{resultId}';

const operations: ServedOperation[] = [
  {
    path: windowsPath,
    method: 'post',
    operationId: 'openControlWindow',
    status: 201,
    body: ControlWindowOpenSchema,
    response: ControlWindowResponseSchema,
    keyed: true,
  },
  {
    path: resultsPath,
    method: 'post',
    operationId: 'recordControlIndicatorResult',
    status: 201,
    body: ControlIndicatorRecordSchema,
    response: ControlIndicatorResultResponseSchema,
    keyed: true,
  },
  {
    path: resultPath,
    method: 'get',
    operationId: 'getControlIndicatorResult',
    status: 200,
    response: ControlIndicatorResultResponseSchema,
  },
];

function checkClient(plan: ControlEffectivenessPlan, ledger: LedgerClient): void {
  const url = new URL(ledger.baseUrl);
  if (url.origin !== plan.apiUrl || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
    pending('api_changed', 'The client differs from the plan’s pinned API origin');
}

function bindJournal(journal: ControlEffectivenessJournal, plan: ControlEffectivenessPlan): void {
  if (
    journal.planDigest !== canonicalDigest(plan) ||
    journal.apiUrl !== plan.apiUrl ||
    journal.tenantId !== plan.tenantId ||
    journal.principalId !== plan.principalId
  )
    pending('journal_mismatch', 'The retained journal belongs to another plan, API or principal');
  const opening = journal.actions[0];
  if (opening && opening.payload !== JSON.stringify(plan.window))
    pending('journal_mismatch', 'The retained window request differs from the plan');
}

export async function runControlEffectiveness(
  value: ControlEffectivenessPlan,
  statePath: string,
  ledger: LedgerClient,
): Promise<ControlEffectivenessActorResult> {
  let journal: ControlEffectivenessJournal | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let stage = 'journal';
  let bound = false;
  const validate = (journalValue: unknown) => validateControlEffectivenessJournal(journalValue, plan);
  let plan: ControlEffectivenessPlan;
  try {
    plan = validateControlEffectivenessPlan(value);
    checkClient(plan, ledger);
    unlock = await lockJournal(statePath, 'Control effectiveness');
    journal = await readControlEffectivenessJournal(statePath);
    if (journal) {
      bindJournal(journal, plan);
      validate(journal);
    } else
      journal = {
        version: 2,
        kind: calculationJournalKind,
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
      };

    bound = true;
    stage = 'preparation';
    const fresh = journal.actions.length === 0;
    if (fresh) await checkContract(ledger, `simulator:control-window:${randomUUID()}`, operations);
    await checkPrincipal(
      ledger,
      plan,
      fresh ? ['monitoring:write', 'decision:write', 'evidence:read'] : ['evidence:read'],
    );

    let opening = journal.actions[0];
    if (!opening) {
      opening = action<CalculationAccepted>(
        'window',
        `simulator:control-window:${randomUUID()}`,
        JSON.stringify(plan.window),
      );
      journal.actions.push(opening);
      await saveJournal(statePath, journal, validate);
    }
    if (opening.status === 'submitted') {
      stage = 'window';
      await submit(
        opening,
        (body, key) =>
          ledger
            .request<{ window: ControlWindow }>(windowsPath, { method: 'POST', body: JSON.stringify(body) }, key)
            .then((response) => response.window),
        (response) => validateOpenedWindow(response, plan),
      );
      await saveJournal(statePath, journal, validate);
      if (opening.rejection)
        return {
          status: 'rejected',
          code: opening.rejection!.code,
          reason: 'The server refused to open this window; no replacement will be created',
          attempts: journal.actions.length,
        };
    }
    const window = opening.accepted as ControlWindow;

    let recording = journal.actions[1];
    if (!recording) {
      const body = {
        definition: { ...plan.indicator },
        expectedRevision: { number: window.revision.number, digest: window.revision.digest },
      };
      recording = action<CalculationAccepted>(
        'result',
        `simulator:control-indicator-result:${randomUUID()}`,
        JSON.stringify(body),
      );
      journal.actions.push(recording);
      await saveJournal(statePath, journal, validate);
    }
    if (recording.status === 'submitted') {
      stage = 'result';
      const path = resultsPath.replace('{windowId}', encodeURIComponent(window.id));
      await submit(
        recording,
        (body, key) => ledger.request<unknown>(path, { method: 'POST', body: JSON.stringify(body) }, key),
        (response) => validateRecordedResult(response, plan, window),
      );
      await saveJournal(statePath, journal, validate);
      if (recording.rejection)
        return {
          status: 'rejected',
          code: recording.rejection!.code,
          reason: 'The server refused to record this result; no replacement will be created',
          attempts: journal.actions.length,
          windowId: window.id,
        };
    }
    const recorded = recording.accepted as RecordedIndicatorResult;

    stage = 'confirmation';
    const response = await ledger.request<ControlIndicatorResultResponse>(
      resultPath.replace('{resultId}', encodeURIComponent(recorded.record.id)),
    );
    const confirmed = validateRecordedResult(response, plan, window);
    if (!same(confirmed, recorded)) pending('result_unconfirmed', 'The exact read did not confirm the recorded result');
    return {
      status: 'accepted',
      code: 'result_confirmed',
      reason: 'The recorded indicator result has a fresh exact read',
      attempts: journal.actions.length,
      windowId: window.id,
      resultId: recorded.record.id,
      resultDigest: recorded.digest,
      resultStatus: recorded.record.result.status,
      record: 'confirmed',
      currentness: structuredClone(response.currentness),
    };
  } catch (error) {
    const recorded =
      bound && journal?.actions[1]?.status === 'accepted'
        ? (journal.actions[1].accepted as RecordedIndicatorResult)
        : undefined;
    return {
      status: recorded ? 'accepted' : 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending
          ? error.message
          : ['window', 'result'].includes(stage)
            ? 'The outcome is uncertain; retry with this journal to replay the identical request and key'
            : 'The result could not be confirmed; retain its plan and journal before retrying',
      attempts: journal?.actions.length ?? 0,
      ...(recorded
        ? {
            windowId: recorded.record.windowId,
            resultId: recorded.record.id,
            resultDigest: recorded.digest,
            resultStatus: recorded.record.result.status,
            record: 'unconfirmed' as const,
          }
        : {}),
    };
  } finally {
    await unlock?.();
  }
}
