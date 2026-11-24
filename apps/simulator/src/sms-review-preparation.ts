import { canonicalDigest, parseStrictJson, sha256 } from '@ledger/integrity';
import {
  recordedResultOf,
  validateControlEffectivenessJournal,
  type ControlEffectivenessJournal,
} from './control-effectiveness-plan.js';
import {
  validateControlEffectivenessReviewPlan,
  type ControlEffectivenessReviewPlan,
} from './control-effectiveness-review-plan.js';
import { validateSmsCalculationPreparation, type SmsCalculationPreparation } from './sms-calculation-preparation.js';
import type { SmsFollowupPreparation } from './sms-rehearsal-plan.js';

export interface SmsReviewSelection {
  version: 1;
  principalId: string;
  principalName: string;
  conclusion: 'effective' | 'ineffective' | 'inconclusive';
  note: string;
}

export interface SmsReviewPreparation {
  version: 1;
  kind: 'sms-rehearsal-review-preparation';
  followupDigest: string;
  calculationPreparationDigest: string;
  preparedAt: string;
  actual: ControlEffectivenessJournal;
  selectionText: string;
  selectionSha256: string;
  selection: SmsReviewSelection;
  plan: ControlEffectivenessReviewPlan;
  planBytes: string;
  planSha256: string;
}

export const maxSmsReviewSelectionBytes = 32 * 1024;
const maxActualBytes = 1024 * 1024;
const maxPreparationBytes = 2 * 1024 * 1024;
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);

function invalid(): never {
  throw new Error('Review preparation requires the exact accepted calculation and an explicit named human judgment');
}

function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

function id(value: unknown): value is string {
  return (
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return at;
}

function selected(text: string): SmsReviewSelection {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxSmsReviewSelectionBytes) return invalid();
  let value: unknown;
  try {
    value = parseStrictJson(text, { maxBytes: maxSmsReviewSelectionBytes });
  } catch {
    return invalid();
  }
  if (
    !fields(value, ['version', 'principalId', 'principalName', 'conclusion', 'note']) ||
    value.version !== 1 ||
    !id(value.principalId) ||
    !id(value.principalName) ||
    typeof value.conclusion !== 'string' ||
    !['effective', 'ineffective', 'inconclusive'].includes(value.conclusion) ||
    typeof value.note !== 'string' ||
    !value.note.trim() ||
    value.note.length > 4000
  )
    return invalid();
  return {
    version: 1,
    principalId: value.principalId,
    principalName: value.principalName,
    conclusion: value.conclusion as SmsReviewSelection['conclusion'],
    note: value.note,
  };
}

export function prepareSmsReview(
  followup: SmsFollowupPreparation,
  calculation: SmsCalculationPreparation,
  actual: ControlEffectivenessJournal,
  selectionText: string,
  preparedAt: string,
): SmsReviewPreparation {
  const selection = selected(selectionText);
  const retainedCalculation = validateSmsCalculationPreparation(calculation, followup);
  if (
    !fields(actual, ['version', 'kind', 'apiUrl', 'planDigest', 'tenantId', 'principalId', 'actions']) ||
    Buffer.byteLength(JSON.stringify(actual), 'utf8') > maxActualBytes
  )
    return invalid();
  const calculationPlan = retainedCalculation.plan;
  const journal = validateControlEffectivenessJournal(actual, calculationPlan);
  const recorded = recordedResultOf(journal);
  if (
    journal.apiUrl !== calculationPlan.apiUrl ||
    journal.tenantId !== calculationPlan.tenantId ||
    journal.principalId !== calculationPlan.principalId ||
    journal.planDigest !== canonicalDigest(calculationPlan) ||
    journal.actions.length !== 2 ||
    !recorded
  )
    return invalid();
  const record = recorded.record;
  if (
    !same(record.request.window, followup.monitoring.monitoring.window) ||
    utc(retainedCalculation.preparedAt) > utc(record.recordedAt) ||
    utc(record.recordedAt) > utc(preparedAt)
  )
    return invalid();
  const plan = validateControlEffectivenessReviewPlan({
    version: 2,
    apiUrl: calculationPlan.apiUrl,
    tenantId: calculationPlan.tenantId,
    principalId: selection.principalId,
    result: { id: record.id, digest: recorded.digest },
    conclusion: selection.conclusion,
    note: selection.note,
  });
  const planBytes = JSON.stringify(plan, null, 2) + '\n';
  const result: SmsReviewPreparation = {
    version: 1,
    kind: 'sms-rehearsal-review-preparation',
    followupDigest: canonicalDigest(followup),
    calculationPreparationDigest: canonicalDigest(retainedCalculation),
    preparedAt,
    actual: structuredClone(journal),
    selectionText,
    selectionSha256: sha256(selectionText),
    selection,
    plan,
    planBytes,
    planSha256: sha256(planBytes),
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxPreparationBytes) return invalid();
  return result;
}

export function validateSmsReviewPreparation(
  value: unknown,
  followup: SmsFollowupPreparation,
  calculation: SmsCalculationPreparation,
): SmsReviewPreparation {
  if (
    !fields(value, [
      'version',
      'kind',
      'followupDigest',
      'calculationPreparationDigest',
      'preparedAt',
      'actual',
      'selectionText',
      'selectionSha256',
      'selection',
      'plan',
      'planBytes',
      'planSha256',
    ]) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > maxPreparationBytes
  )
    return invalid();
  const retained = value as unknown as SmsReviewPreparation;
  const expected = prepareSmsReview(
    followup,
    calculation,
    retained.actual,
    retained.selectionText,
    retained.preparedAt,
  );
  if (!same(value, expected)) return invalid();
  return expected;
}
