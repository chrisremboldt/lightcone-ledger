import type { CommandRecord, SmsRecordDetailResponse } from '@ledger/contracts';
import {
  apiOrigin,
  hasKeys,
  isDigest,
  isId,
  isObject,
  pending,
  readJournal,
  validateJournal,
  type ActionJournal,
} from './indicator-actor-common.js';

// Plans for the simulated people who record a hazard on the safety record: a safety lead who promotes a finding to a
// hazard, proposes an avoidance area on it and assesses it, and an accountable person who signs the risk acceptance.

export interface MatrixPosition {
  severity: string;
  likelihood: string;
}
interface PlanIdentity {
  version: 2;
  apiUrl: string;
  tenantId: string;
  principalId: string;
}
export interface HazardRecordPlan extends PlanIdentity {
  /** The finding to promote and the evaluation the safety lead reviewed; it must still be the latest. */
  finding: { findingId: string; evaluationId: string; evaluationDigest: string };
  hazard: { title: string; description: string; consequence: string };
  control: {
    title: string;
    center: { latitude: number; longitude: number };
    radiusMeters: number;
    effectiveFrom: string;
    effectiveUntil: string | null;
  };
  assessment: { initial: MatrixPosition; residual: MatrixPosition; note: string };
}
export interface RiskAcceptancePlan extends PlanIdentity {
  hazardId: string;
  assessmentId: string;
  note: string;
}

export const hazardRecordJournalKind = 'sms-hazard-record-action';
export const hazardRecordSteps = ['hazard', 'control', 'assessment'];
export const riskAcceptanceJournalKind = 'sms-risk-acceptance-action';
export const riskAcceptanceSteps = ['acceptance'];
export const maxHazardResponseBytes = 2 * 1024 * 1024;

export type HazardJournal = ActionJournal<CommandRecord>;

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function utc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function position(value: unknown): value is MatrixPosition {
  return hasKeys(value, ['severity', 'likelihood']) && text(value.severity, 60) && text(value.likelihood, 60);
}
function coordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}
function identity(value: unknown): value is PlanIdentity & Record<string, unknown> {
  return (
    isObject(value) &&
    value.version === 2 &&
    apiOrigin(value.apiUrl) === value.apiUrl &&
    isId(value.tenantId) &&
    isId(value.principalId)
  );
}

export function validateHazardRecordPlan(value: unknown): HazardRecordPlan {
  const control = isObject(value) ? value.control : undefined;
  if (
    !identity(value) ||
    !hasKeys(value, ['version', 'apiUrl', 'tenantId', 'principalId', 'finding', 'hazard', 'control', 'assessment']) ||
    !hasKeys(value.finding, ['findingId', 'evaluationId', 'evaluationDigest']) ||
    !isId(value.finding.findingId) ||
    !isId(value.finding.evaluationId) ||
    !isDigest(value.finding.evaluationDigest) ||
    !hasKeys(value.hazard, ['title', 'description', 'consequence']) ||
    !text(value.hazard.title, 200) ||
    !text(value.hazard.description, 8000) ||
    !text(value.hazard.consequence, 4000) ||
    !hasKeys(control, ['title', 'center', 'radiusMeters', 'effectiveFrom', 'effectiveUntil']) ||
    !text(control.title, 200) ||
    !hasKeys(control.center, ['latitude', 'longitude']) ||
    !coordinate(control.center.latitude, 90) ||
    !coordinate(control.center.longitude, 180) ||
    typeof control.radiusMeters !== 'number' ||
    !(control.radiusMeters > 0 && control.radiusMeters <= 10_000) ||
    !utc(control.effectiveFrom) ||
    (control.effectiveUntil !== null &&
      (!utc(control.effectiveUntil) || Date.parse(control.effectiveUntil) <= Date.parse(control.effectiveFrom))) ||
    !hasKeys(value.assessment, ['initial', 'residual', 'note']) ||
    !position(value.assessment.initial) ||
    !position(value.assessment.residual) ||
    !text(value.assessment.note, 4000)
  )
    return pending('invalid_plan', 'The plan requires a finding, the hazard, its avoidance area and its assessment');
  return structuredClone(value) as unknown as HazardRecordPlan;
}

export function validateRiskAcceptancePlan(value: unknown): RiskAcceptancePlan {
  if (
    !identity(value) ||
    !hasKeys(value, ['version', 'apiUrl', 'tenantId', 'principalId', 'hazardId', 'assessmentId', 'note']) ||
    !isId(value.hazardId) ||
    !isId(value.assessmentId) ||
    !text(value.note, 4000)
  )
    return pending('invalid_plan', 'The plan requires a hazard, the assessment to accept and a note');
  return structuredClone(value) as unknown as RiskAcceptancePlan;
}

/** The command Ledger accepted for a retained request: the same kind, by the plan's principal, on a safety record. */
export function acceptedSmsCommand(value: unknown, payload: string, principalId: string): CommandRecord {
  const command = isObject(value) ? value.command : undefined;
  const sent = JSON.parse(payload) as { kind: string; subject?: { id: string } };
  if (
    !hasKeys(command, ['id', 'kind', 'actorId', 'recordedAt', 'payload', 'subject'], ['flightId']) ||
    !isId(command.id) ||
    command.kind !== sent.kind ||
    command.actorId !== principalId ||
    !hasKeys(command.subject, ['kind', 'id']) ||
    command.subject.kind !== 'sms' ||
    !isId(command.subject.id) ||
    (sent.subject !== undefined && command.subject.id !== sent.subject.id)
  )
    return pending('commitment_mismatch', 'The accepted command differs from the retained request');
  return command as unknown as CommandRecord;
}

/** A safety record as the actor reads it: the record asked for, of the expected kind. */
export function validateRecordDetail(value: unknown, id: string, kind: string): SmsRecordDetailResponse {
  if (
    !isObject(value) ||
    !isObject(value.record) ||
    value.record.id !== id ||
    value.record.kind !== kind ||
    !isObject(value.basis) ||
    !Array.isArray(value.decisions)
  )
    return pending('record_unavailable', `The ${kind} record could not be read as expected`);
  return value as unknown as SmsRecordDetailResponse;
}

export function validateHazardJournal(
  value: unknown,
  kind: string,
  steps: string[],
  principalId: string,
): HazardJournal {
  return validateJournal<CommandRecord>(value, kind, steps, (step, accepted) => {
    if (!hasKeys(accepted, ['id', 'kind', 'actorId', 'recordedAt', 'payload', 'subject'], ['flightId']))
      pending('journal_mismatch', `The retained ${step} answer is not a command`);
    if ((accepted as { actorId: unknown }).actorId !== principalId)
      pending('journal_mismatch', `The retained ${step} answer belongs to another principal`);
  });
}

export function readHazardJournal(
  path: string,
  kind: string,
  steps: string[],
  principalId: string,
): Promise<HazardJournal | undefined> {
  return readJournal(path, (value) => validateHazardJournal(value, kind, steps, principalId));
}
