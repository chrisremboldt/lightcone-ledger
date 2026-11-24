import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import type { MonitoringWindowAdapterResult, PreparedMonitoringWindowInput } from '@ledger/adapters';
import {
  CONTROL_EFFECTIVENESS_LIMITS,
  MONITORING_WINDOW_MAX_READ_BYTES,
  MissionRevisionRecordSchema,
  MonitoringRecordV2Schema,
  MonitoringReportInputV2Schema,
  MonitoringReportSourceV2Schema,
  type MissionRevisionRecord,
  type MonitoringRecordV2,
  type MonitoringReportSourceV2,
} from '@ledger/contracts';
import { ReceiptResponseSchema } from '@ledger/contracts/openapi';
import { canonicalDigest, parseStrictJson, sha256 } from '@ledger/integrity';
import { commandLinkLossesPerFlightHourV1 } from '@ledger/domain/builtin-packs';
import { validateControlEffectivenessPlan, type ControlEffectivenessPlan } from './control-effectiveness-plan.js';
import type { OperationMonitoringFlightBinding as OperationCommandLinkBaselineBinding } from './operation-monitoring-runtime.js';
import type { SmsFollowupPreparation } from './sms-rehearsal-plan.js';

export interface SmsCalculationSelection {
  version: 1;
  principalId: string;
}
export interface SmsCalculationActual {
  binding: OperationCommandLinkBaselineBinding;
  mission: MissionRevisionRecord;
  submission: PreparedMonitoringWindowInput;
  accepted: MonitoringWindowAdapterResult;
  canonical: { record: MonitoringRecordV2; digest: string };
}
export interface SmsCalculationPreparation {
  version: 1;
  kind: 'sms-rehearsal-calculation-preparation';
  followupDigest: string;
  preparedAt: string;
  actual: SmsCalculationActual;
  selectionText: string;
  selectionSha256: string;
  selection: SmsCalculationSelection;
  plan: ControlEffectivenessPlan;
  planBytes: string;
  planSha256: string;
}

const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const sourceShape = ajv.compile<MonitoringReportSourceV2>(MonitoringReportSourceV2Schema);
const inputShape = ajv.compile(MonitoringReportInputV2Schema);
const recordShape = ajv.compile<MonitoringRecordV2>(MonitoringRecordV2Schema);
const missionShape = ajv.compile<MissionRevisionRecord>(MissionRevisionRecordSchema);
const receiptShape = ajv.compile(ReceiptResponseSchema);
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);
const limits = CONTROL_EFFECTIVENESS_LIMITS;
const maxActualBytes = 1024 * 1024;
const maxPreparationBytes = 2 * 1024 * 1024;
const maxSelectionBytes = 16 * 1024;
function invalid(): never {
  throw new Error(
    'Calculation preparation requires the exact retained followup monitoring source, receipt and canonical record',
  );
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
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return at;
}
function duration(interval: { start: string; end: string }): number {
  const value = utc(interval.end) - utc(interval.start);
  if (!Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}
function selected(text: string): SmsCalculationSelection {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxSelectionBytes) return invalid();
  let value: unknown;
  try {
    value = parseStrictJson(text, { maxBytes: maxSelectionBytes });
  } catch {
    return invalid();
  }
  if (!fields(value, ['version', 'principalId']) || value.version !== 1 || !id(value.principalId)) return invalid();
  return { version: 1, principalId: value.principalId };
}
function sourceOriginal(submission: PreparedMonitoringWindowInput): MonitoringReportSourceV2 {
  if (
    typeof submission.bytesBase64 !== 'string' ||
    submission.bytesBase64.length > 4 * Math.ceil(limits.maxMonitoringOriginalBytes / 3)
  )
    return invalid();
  const bytes = Buffer.from(submission.bytesBase64, 'base64');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > limits.maxMonitoringOriginalBytes ||
    bytes.toString('base64') !== submission.bytesBase64 ||
    sha256(bytes) !== submission.sha256
  )
    return invalid();
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), {
      maxBytes: limits.maxMonitoringOriginalBytes,
    });
  } catch {
    return invalid();
  }
  if (
    !sourceShape(value) ||
    duration(value.window) > limits.maxWindowMilliseconds ||
    utc(value.completeThrough) > utc(value.occurredAt) ||
    value.flights.length !== 1 ||
    value.flights.reduce((count, flight) => count + flight.declaredC2SourceEventIds.length + 1, 0) > limits.maxC2Records
  )
    return invalid();
  for (const flight of value.flights)
    for (const interval of [
      ...flight.observedIntervals,
      ...(flight.coverageIntervals ?? []),
      ...flight.gaps.map((gap) => gap.interval),
    ])
      if (duration(interval) <= 0 || utc(interval.end) > utc(value.occurredAt)) return invalid();
  return value;
}

export function prepareSmsCalculation(
  followup: SmsFollowupPreparation,
  actual: SmsCalculationActual,
  selectionText: string,
  preparedAt: string,
): SmsCalculationPreparation {
  const selection = selected(selectionText);
  if (
    !fields(actual, ['binding', 'mission', 'submission', 'accepted', 'canonical']) ||
    Buffer.byteLength(JSON.stringify(actual), 'utf8') > maxActualBytes ||
    !fields(actual.binding, ['attemptId', 'tenantId', 'sourceId', 'sourceSessionId', 'flight']) ||
    !fields(actual.binding.flight, ['id', 'originationKey', 'aircraft']) ||
    !fields(actual.submission, [
      'version',
      'apiUrl',
      'tenantId',
      'principalId',
      'key',
      'input',
      'bytesBase64',
      'sha256',
      'submissionDigest',
    ]) ||
    !fields(actual.accepted, ['receipt', 'submittedUploadArtifactId', 'sha256']) ||
    !fields(actual.canonical, ['record', 'digest']) ||
    !missionShape(actual.mission) ||
    !inputShape(actual.submission.input) ||
    !receiptShape(actual.accepted.receipt) ||
    !recordShape(actual.canonical.record) ||
    Buffer.byteLength(JSON.stringify(actual.canonical.record), 'utf8') > MONITORING_WINDOW_MAX_READ_BYTES
  )
    return invalid();
  const { binding, mission, submission, accepted, canonical } = actual;
  const ids = followup.identities;
  const expected = followup.monitoring.monitoring;
  const source = sourceOriginal(submission);
  const { sourceSessionId, occurredAt, ...payload } = source;
  const { submissionDigest, ...content } = submission;
  const key = `monitoring-window:revision:${canonicalDigest({
    version: 'ledger.monitoring-window-delivery.2',
    tenantId: 'tenant-alpha',
    sourceId: expected.sourceId,
    sourceSessionId,
    sourceWindowId: source.sourceWindowId,
    sourceRevision: 1,
  })}`;
  if (
    (followup.version !== 1 && followup.version !== 2 && followup.version !== 3) ||
    followup.version !== followup.config.version ||
    followup.kind !== 'sms-rehearsal-preparation' ||
    followup.phase !== 'followup' ||
    followup.configDigest !== canonicalDigest(followup.config) ||
    expected.tenant !== 'alpha' ||
    expected.runId !== followup.runId ||
    expected.flights.length !== 1 ||
    expected.flights[0]?.attemptId !== ids.attemptId ||
    !id(binding.flight.id) ||
    binding.attemptId !== ids.attemptId ||
    binding.tenantId !== 'tenant-alpha' ||
    binding.flight.originationKey !== ids.attemptId ||
    binding.flight.aircraft !== ids.aircraftId ||
    binding.sourceId !== 'command-link' ||
    binding.sourceSessionId !== ids.commandLinkSourceSessionId ||
    source.sourceSessionId !== expected.sourceSessionId ||
    source.sourceWindowId !== expected.sourceWindowId ||
    source.sourceRevision !== 1 ||
    !same(source.window, expected.window) ||
    !same(source.control, expected.control) ||
    submission.version !== 'ledger.monitoring-window-submission.2' ||
    submission.apiUrl !== followup.config.apiUrl ||
    submission.tenantId !== 'tenant-alpha' ||
    submission.principalId !== followup.config.sourcePrincipalId ||
    !digest(submission.sha256) ||
    !digest(submission.submissionDigest) ||
    submissionDigest !== canonicalDigest(content) ||
    submission.key !== key ||
    !id(submission.input.artifactId) ||
    !same(submission.input, {
      sourceId: expected.sourceId,
      sourceSessionId,
      kind: 'monitoring.window',
      occurredAt,
      artifactId: submission.input.artifactId,
      fidelity: 'synthetic_contract',
      payload,
    })
  )
    return invalid();
  const flight = source.flights[0]!;
  const missionReference = {
    missionId: mission.missionId,
    sourceRevision: mission.sourceRevision,
    eventId: mission.id,
    contentDigest: mission.contentDigest,
    recordDigest: canonicalDigest(mission),
  };
  if (
    flight.flightId !== binding.flight.id ||
    flight.aircraftId !== ids.aircraftId ||
    flight.c2SourceId !== binding.sourceId ||
    flight.c2SourceSessionId !== binding.sourceSessionId ||
    !same(flight.mission, missionReference) ||
    mission.flightId !== binding.flight.id ||
    mission.aircraftId !== ids.aircraftId ||
    mission.sourceId !== 'mission-planner' ||
    mission.sourceMissionId !== ids.sourceMissionId ||
    mission.authority.tenantId !== 'tenant-alpha' ||
    mission.authority.sourceId !== mission.sourceId ||
    !mission.authority.grantedSources.includes(mission.sourceId) ||
    mission.sourceRevision !== 2 ||
    mission.sourceRevision !== followup.missionChange.sourceRevision ||
    !same(mission.route, followup.missionChange.route) ||
    !same(mission.operatingInterval, followup.missionChange.operatingInterval) ||
    mission.altitude.minimum > mission.altitude.maximum ||
    duration(mission.operatingInterval) <= 0
  )
    return invalid();
  utc(mission.occurredAt);
  utc(mission.recordedAt);
  const receipt = accepted.receipt.receipt;
  const record = canonical.record;
  const authority = record.authority;
  if (
    accepted.submittedUploadArtifactId !== submission.input.artifactId ||
    accepted.sha256 !== submission.sha256 ||
    receipt.sourceId !== expected.sourceId ||
    receipt.kind !== 'monitoring.window' ||
    receipt.status !== 'accepted' ||
    receipt.linkStatus !== 'linked' ||
    !id(receipt.artifactId) ||
    !id(receipt.eventId) ||
    !id(receipt.id) ||
    receipt.flightId !== undefined ||
    receipt.orderId !== undefined ||
    utc(receipt.occurredAt) !== utc(source.occurredAt) ||
    !same(receipt.payload, payload) ||
    !digest(canonical.digest) ||
    canonical.digest !== canonicalDigest(record) ||
    record.id !== receipt.eventId ||
    record.organizationId !== 'organization:tenant-alpha' ||
    record.sourceId !== expected.sourceId ||
    !same(record.source, source) ||
    record.original.artifactId !== receipt.artifactId ||
    record.original.sha256 !== submission.sha256 ||
    record.original.byteLength !== Buffer.from(submission.bytesBase64, 'base64').byteLength ||
    utc(record.recordedAt) !== utc(receipt.receivedAt) ||
    authority.tenantId !== 'tenant-alpha' ||
    authority.sourceId !== expected.sourceId ||
    !authority.grantedSources.includes(expected.sourceId) ||
    !authority.capabilities.includes('input:write') ||
    !authority.capabilities.includes('monitoring:write') ||
    utc(followup.start) > utc(source.occurredAt) ||
    utc(source.occurredAt) > utc(record.recordedAt) ||
    utc(record.recordedAt) > utc(preparedAt)
  )
    return invalid();
  // The window covers the monitored flight over the reported period, for the accepted flight-side control, and is
  // opened for the demo procedures' command-link loss indicator.
  const indicator = commandLinkLossesPerFlightHourV1();
  const control = source.control;
  const plan = validateControlEffectivenessPlan({
    version: 2,
    apiUrl: followup.config.apiUrl,
    tenantId: 'tenant-alpha',
    principalId: selection.principalId,
    window: {
      control: {
        kind: 'control_record',
        hazardId: control.hazardId,
        recordId: control.controlId,
        versionNumber: control.controlVersion,
        bodyDigest: control.controlDigest,
        acceptanceId: control.acceptance.id,
      },
      period: { ...source.window },
      subjectKind: 'flight',
      subjects: [{ scope: 'ledger', kind: 'flight', id: binding.flight.id }],
      complete: source.populationComplete,
      expectedObservations: [
        { type: 'flight.report', versions: [1] },
        { type: 'link.status', versions: [1] },
      ],
      indicators: [{ id: indicator.id, version: indicator.version, digest: indicator.digest }],
      note: `The flight monitored in rehearsal ${followup.runId}, as its monitoring source declared it.`,
    },
    indicator: { id: indicator.id, version: indicator.version, digest: indicator.digest },
  });
  const planBytes = JSON.stringify(plan, null, 2) + '\n';
  const result: SmsCalculationPreparation = {
    version: 1,
    kind: 'sms-rehearsal-calculation-preparation',
    followupDigest: canonicalDigest(followup),
    preparedAt,
    actual: structuredClone(actual),
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

export function validateSmsCalculationPreparation(
  value: unknown,
  followup: SmsFollowupPreparation,
): SmsCalculationPreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const retained = value as SmsCalculationPreparation;
  const expected = prepareSmsCalculation(followup, retained.actual, retained.selectionText, retained.preparedAt);
  if (!same(value, expected)) return invalid();
  return expected;
}
