import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  SmsRecordDetailResponseSchema,
  type FlightResponse,
  type SmsAcceptanceOutcome,
  type SmsAssessmentOutcome,
  type SmsRecordDetailResponse,
} from '@ledger/contracts';
import { FlightResponseSchema } from '@ledger/contracts/openapi';
import { decisionReference } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import type { OperationMonitoringControlReference } from '@ledger/simulation-models/operation';
import type { SmsIncidentPreparation } from './sms-rehearsal-plan.js';

/**
 * The accepted control a rehearsal follow-up monitors, as a person selected it from the safety record: the hazard
 * promoted from the incident flight's finding, the avoidance area accepted on it, and the incident flight.
 */
export interface SmsAcceptedControlSelection {
  version: 2;
  hazardId: string;
  controlId: string;
  controlVersion: number;
  hazard: SmsRecordDetailResponse;
  control: SmsRecordDetailResponse;
  origin: FlightResponse;
}
const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const recordShape = ajv.compile<SmsRecordDetailResponse>(SmsRecordDetailResponseSchema);
const flightShape = ajv.compile<FlightResponse>(FlightResponseSchema);
function invalid(): never {
  throw new Error(
    'Control selection must retain one exact accepted Alpha control on a hazard promoted from the incident flight, in effect over the followup interval',
  );
}

export function validateSmsAcceptedControlSelection(
  value: unknown,
  incident: SmsIncidentPreparation,
  start: string,
  end: string,
): {
  selection: SmsAcceptedControlSelection;
  reference: OperationMonitoringControlReference;
} {
  const names = ['version', 'hazardId', 'controlId', 'controlVersion', 'hazard', 'control', 'origin'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    !names.every((name) => Object.hasOwn(value, name)) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 4 * 1024 * 1024
  )
    return invalid();
  const selected = value as SmsAcceptedControlSelection;
  if (
    selected.version !== 2 ||
    !recordShape(selected.hazard) ||
    !recordShape(selected.control) ||
    !flightShape(selected.origin)
  )
    return invalid();
  const { hazard, control } = selected;
  const original = selected.origin.flight;
  const origin = hazard.origin;
  const acceptance = hazard.decisions.find((decision) => decision.kind === 'risk.accept');
  const accepted = acceptance?.outcome as SmsAcceptanceOutcome | undefined;
  const assessment = hazard.decisions.find((decision) => decision.id === accepted?.assessmentId);
  const assessed = (assessment?.outcome as SmsAssessmentOutcome | undefined)?.controls.find(
    (entry) => entry.recordId === selected.controlId,
  );
  const version = control.versions.find((entry) => entry.versionNumber === selected.controlVersion);
  const body = version?.body as { hazardId?: unknown; effectiveFrom?: unknown; effectiveUntil?: unknown } | undefined;
  const listed = hazard.controls?.find((entry) => entry.id === selected.controlId);
  if (
    !acceptance ||
    !assessment ||
    !assessed ||
    !version ||
    !listed ||
    !acceptance.signature ||
    hazard.record.id !== selected.hazardId ||
    hazard.record.kind !== 'hazard' ||
    hazard.record.status === 'closed' ||
    control.record.id !== selected.controlId ||
    control.record.kind !== 'control' ||
    control.record.status === 'closed' ||
    origin?.kind !== 'finding' ||
    origin.subject.kind !== 'flight' ||
    origin.subject.id !== original.id ||
    original.originationKey !== incident.identities.attemptId ||
    original.aircraft !== incident.identities.aircraftId ||
    !listed.accepted ||
    listed.versionNumber !== selected.controlVersion ||
    listed.bodyDigest !== version.bodyDigest ||
    assessed.versionNumber !== selected.controlVersion ||
    assessed.bodyDigest !== version.bodyDigest ||
    accepted!.assessmentDigest !== canonicalDigest(assessment.outcome) ||
    body?.hazardId !== hazard.record.id ||
    typeof body.effectiveFrom !== 'string' ||
    Date.parse(body.effectiveFrom) > Date.parse(start) ||
    (body.effectiveUntil !== undefined && Date.parse(String(body.effectiveUntil)) < Date.parse(end)) ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(start) >= Date.parse(end)
  )
    return invalid();
  const chronology = [incident.start, assessment.recordedAt, acceptance.recordedAt, start].map(Date.parse);
  if (chronology.some((clock, index) => !Number.isFinite(clock) || (index > 0 && clock < chronology[index - 1]!)))
    return invalid();
  return {
    selection: structuredClone(selected),
    reference: {
      hazardId: hazard.record.id,
      controlId: control.record.id,
      controlVersion: version.versionNumber,
      controlEventId: version.id,
      controlDigest: version.bodyDigest,
      acceptance: decisionReference(acceptance),
    },
  };
}
