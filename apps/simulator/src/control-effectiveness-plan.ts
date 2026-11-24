import {
  ControlIndicatorResultRecordSchema,
  ControlWindowOpenSchema,
  ControlWindowSchema,
  type ControlIndicatorResultRecord,
  type ControlWindow,
  type ControlWindowOpen,
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
  saveJournal,
  validateJournal,
  type ActionJournal,
} from './indicator-actor-common.js';

// The plan for recording a control's effectiveness: open a window for the accepted control, then record the result
// of one of its indicators through that window. Both requests are retained before they are sent.

export interface ControlEffectivenessPlan {
  version: 2;
  apiUrl: string;
  tenantId: string;
  principalId: string;
  window: ControlWindowOpen;
  indicator: { id: string; version: number; digest: string };
}

export interface RecordedIndicatorResult {
  record: ControlIndicatorResultRecord;
  digest: string;
}

export type CalculationAccepted = ControlWindow | RecordedIndicatorResult;
export type ControlEffectivenessJournal = ActionJournal<CalculationAccepted>;

export const calculationJournalKind = 'control-indicator-result-action';
export const calculationSteps = ['window', 'result'];
export const maxCalculationResponseBytes = 512 * 1024;

const openShape = compile<ControlWindowOpen>(ControlWindowOpenSchema);
const windowShape = compile<ControlWindow>(ControlWindowSchema);
const recordShape = compile<ControlIndicatorResultRecord>(ControlIndicatorResultRecordSchema);

export function validateControlEffectivenessPlan(value: unknown): ControlEffectivenessPlan {
  if (
    !hasKeys(value, ['version', 'apiUrl', 'tenantId', 'principalId', 'window', 'indicator']) ||
    value.version !== 2 ||
    !isId(value.tenantId) ||
    !isId(value.principalId) ||
    !openShape(value.window) ||
    !hasKeys(value.indicator, ['id', 'version', 'digest']) ||
    !isId(value.indicator.id) ||
    !Number.isSafeInteger(value.indicator.version) ||
    !isDigest(value.indicator.digest) ||
    !value.window.indicators.some((cited) => same(cited, value.indicator))
  )
    return pending(
      'invalid_plan',
      'The plan requires a window for one accepted control that cites the indicator, and a tenant and principal',
    );
  return {
    version: 2,
    apiUrl: apiOrigin(value.apiUrl),
    tenantId: value.tenantId,
    principalId: value.principalId,
    window: structuredClone(value.window),
    indicator: { id: value.indicator.id, version: Number(value.indicator.version), digest: value.indicator.digest },
  };
}

/** The opened window as the plan asked for it, in the plan's tenant. */
export function validateOpenedWindow(value: unknown, plan: ControlEffectivenessPlan): ControlWindow {
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > maxCalculationResponseBytes || !windowShape(value))
    return pending('unsupported_response', 'The window response has an unsupported shape or exceeds its bound');
  const subjectKeys = (subjects: unknown[]) => subjects.map((subject) => canonicalDigest(subject)).sort();
  if (
    value.variant !== 'generic' ||
    value.organizationId !== `organization:${plan.tenantId}` ||
    !same(value.control, plan.window.control) ||
    !same(value.period, plan.window.period) ||
    value.population.subjectKind !== plan.window.subjectKind ||
    !same(subjectKeys(value.population.subjects), subjectKeys(plan.window.subjects)) ||
    value.population.complete !== plan.window.complete ||
    !same(value.indicators, plan.window.indicators) ||
    value.revision.number !== 1
  )
    return pending('acceptance_mismatch', 'The opened window differs from the planned control, period or population');
  return structuredClone(value);
}

/** A recorded result for the plan's indicator, through the opened window, by the plan's principal. */
export function validateRecordedResult(
  value: unknown,
  plan: ControlEffectivenessPlan,
  window: ControlWindow,
): RecordedIndicatorResult {
  if (
    Buffer.byteLength(JSON.stringify(value ?? null)) > maxCalculationResponseBytes ||
    !hasKeys(value, ['record', 'digest'], ['currentness']) ||
    !recordShape(value.record) ||
    !isDigest(value.digest)
  )
    return pending('unsupported_response', 'The result response has an unsupported shape or exceeds its bound');
  const record = value.record;
  const digest = value.digest;
  if (
    canonicalDigest(record) !== digest ||
    record.windowId !== window.id ||
    record.windowRevision !== window.revision.number ||
    record.windowRevisionDigest !== window.revision.digest ||
    record.organizationId !== window.organizationId ||
    record.actorId !== plan.principalId ||
    !same(record.control, plan.window.control) ||
    !same(record.result.definition, plan.indicator)
  )
    return pending('acceptance_mismatch', 'The recorded result differs from the window, indicator or author');
  return { record: structuredClone(record), digest };
}

export function validateControlEffectivenessJournal(
  value: unknown,
  plan?: ControlEffectivenessPlan,
): ControlEffectivenessJournal {
  let window: ControlWindow | undefined;
  return validateJournal<CalculationAccepted>(value, calculationJournalKind, calculationSteps, (step, accepted) => {
    if (step === 'window') window = plan ? validateOpenedWindow(accepted, plan) : (accepted as ControlWindow);
    else if (plan && window) validateRecordedResult(accepted, plan, window);
  });
}

export function readControlEffectivenessJournal(path: string, plan?: ControlEffectivenessPlan) {
  return readJournal(path, (value) => validateControlEffectivenessJournal(value, plan));
}

/** The result a finished calculation journal recorded, for a review to cite. */
export function recordedResultOf(journal: ControlEffectivenessJournal): RecordedIndicatorResult | undefined {
  const result = journal.actions.find((entry) => entry.step === 'result' && entry.status === 'accepted');
  return result ? (result.accepted as RecordedIndicatorResult) : undefined;
}

export function saveControlEffectivenessJournal(path: string, journal: ControlEffectivenessJournal): Promise<void> {
  return saveJournal(path, journal, (value) => validateControlEffectivenessJournal(value));
}
