import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  FlightMissionRevisionResponseSchema,
  MissionReleaseRecordResponseSchema,
  type FlightMissionRevisionResponse,
  type FlightResponse,
  type MissionReleaseRecordResponse,
} from '@ledger/contracts';
import { FlightResponseSchema } from '@ledger/contracts/openapi';
import { canonicalDigest, parseStrictJson, sha256 } from '@ledger/integrity';
import type { OperationReservation } from '@ledger/simulation-models/operation';
import { validateMissionDeparturePlan, type MissionDeparturePlan } from './mission-departure-plan.js';
import { validateMissionReleaseRecord } from './mission-release-confirmation.js';
import { validateMissionReleasePlan } from './mission-release-plan.js';
import {
  validateOperationReservationRevisionPlan,
  type OperationReservationRevisionPlan,
  type OperationReservationRevisionReceipt,
} from './operation-reservation-revision.js';
import type { SmsFollowupPreparation } from './sms-rehearsal-plan.js';

export interface SmsDepartureSelection {
  version: 1;
  principalId: string;
  marginMs: number;
  latencyMarginMs: number;
  handoffAllowanceMs: number;
  allocationDurationMs: number;
  flight: FlightResponse;
  mission: FlightMissionRevisionResponse;
  release: MissionReleaseRecordResponse;
}
export interface SmsDeparturePreparation {
  version: 1;
  kind: 'sms-rehearsal-departure-preparation';
  followupDigest: string;
  revisionDigest: string;
  preparedAt: string;
  actual: { reservation: OperationReservation; revisionReceipt: OperationReservationRevisionReceipt };
  selectionText: string;
  selectionSha256: string;
  selection: SmsDepartureSelection;
  plan: MissionDeparturePlan;
  planBytes: string;
  planSha256: string;
}

const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const flightShape = ajv.compile<FlightResponse>(FlightResponseSchema);
const missionShape = ajv.compile<FlightMissionRevisionResponse>(FlightMissionRevisionResponseSchema);
const releaseShape = ajv.compile<MissionReleaseRecordResponse>(MissionReleaseRecordResponseSchema);
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);
const maxSelectionBytes = 2 * 1024 * 1024;
const maxPreparationBytes = 4 * 1024 * 1024;
function invalid(): never {
  throw new Error(
    'Departure preparation requires the exact retained followup, applied mission revision and immutable public release',
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
function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return at;
}
function selection(text: string): SmsDepartureSelection {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxSelectionBytes) return invalid();
  let value: unknown;
  try {
    value = parseStrictJson(text, { maxBytes: maxSelectionBytes });
  } catch {
    return invalid();
  }
  if (
    !fields(value, [
      'version',
      'principalId',
      'marginMs',
      'latencyMarginMs',
      'handoffAllowanceMs',
      'allocationDurationMs',
      'flight',
      'mission',
      'release',
    ]) ||
    value.version !== 1 ||
    !flightShape(value.flight) ||
    !missionShape(value.mission) ||
    !releaseShape(value.release)
  )
    return invalid();
  return structuredClone(value) as unknown as SmsDepartureSelection;
}

export function prepareSmsDeparture(
  followup: SmsFollowupPreparation,
  revisionValue: OperationReservationRevisionPlan,
  actual: SmsDeparturePreparation['actual'],
  selectionText: string,
  preparedAt: string,
): SmsDeparturePreparation {
  const revision = validateOperationReservationRevisionPlan(revisionValue);
  const selected = selection(selectionText);
  if (!fields(actual, ['reservation', 'revisionReceipt'])) return invalid();
  const { reservation, revisionReceipt } = actual;
  const ids = followup.identities;
  if (
    (followup.version !== 1 && followup.version !== 2 && followup.version !== 3) ||
    followup.version !== followup.config.version ||
    followup.kind !== 'sms-rehearsal-preparation' ||
    followup.phase !== 'followup' ||
    followup.configDigest !== canonicalDigest(followup.config) ||
    revision.version !== 1 ||
    revision.runId !== followup.runId ||
    revision.tenant !== 'alpha' ||
    revision.reservationId !== ids.attemptId ||
    revision.aircraftId !== ids.aircraftId ||
    revision.expectedPlan.sourceRevision !== 1 ||
    revision.change.sourceRevision !== 2 ||
    !same(revision.change, followup.missionChange) ||
    !reservation ||
    reservation.phase !== 'awaiting-release' ||
    reservation.tenant !== 'alpha' ||
    reservation.id !== ids.attemptId ||
    reservation.intentId !== ids.intentId ||
    reservation.aircraftId !== ids.aircraftId ||
    reservation.sourceSessionId !== ids.sourceSessionId ||
    reservation.plan?.sourceMissionId !== ids.sourceMissionId ||
    reservation.plan.aircraftId !== ids.aircraftId ||
    reservation.plan.sourceRevision !== revision.change.sourceRevision ||
    !same(reservation.plan.route, revision.change.route) ||
    !same(reservation.plan.operatingInterval, revision.change.operatingInterval) ||
    !fields(revisionReceipt, [
      'version',
      'planDigest',
      'runId',
      'reservationId',
      'sourceRevision',
      'sourceDigest',
      'occurredAt',
    ]) ||
    revisionReceipt.version !== 'operation.reservation-revision.1' ||
    revisionReceipt.planDigest !== canonicalDigest(revision) ||
    revisionReceipt.runId !== followup.runId ||
    revisionReceipt.reservationId !== reservation.id ||
    revisionReceipt.sourceRevision !== reservation.plan.sourceRevision ||
    revisionReceipt.sourceDigest !== canonicalDigest(reservation.plan) ||
    revisionReceipt.occurredAt !== reservation.plan.occurredAt
  )
    return invalid();
  const mission = selected.mission.mission;
  const record = selected.release.release;
  const source = reservation.plan;
  const sourceProjection = {
    sourceRevision: mission.sourceRevision,
    occurredAt: mission.occurredAt,
    sourceMissionId: mission.sourceMissionId,
    aircraftId: mission.aircraftId,
    route: mission.route,
    lateralToleranceMeters: mission.lateralToleranceMeters,
    altitude: mission.altitude,
    operatingInterval: mission.operatingInterval,
    ...(mission.routePlanning ? { routePlanning: mission.routePlanning } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(source), 'utf8');
  const original = { bytesBase64: bytes.toString('base64'), sha256: sha256(bytes), byteLength: bytes.byteLength };
  const { sourceRevision, occurredAt, ...payload } = source;
  const contentDigest = canonicalDigest({
    version: 'ledger.mission-content.1',
    sourceId: 'mission-planner',
    flightId: mission.flightId,
    sourceRevision,
    occurredAt,
    fidelity: 'synthetic_contract',
    payload,
    original,
  });
  if (
    selected.flight.flight.originationKey !== ids.attemptId ||
    selected.flight.flight.aircraft !== ids.aircraftId ||
    selected.flight.flight.id !== mission.flightId ||
    mission.flightId !== record.flightId ||
    mission.sourceId !== 'mission-planner' ||
    mission.authority.tenantId !== 'tenant-alpha' ||
    mission.authority.sourceId !== mission.sourceId ||
    !same(source, sourceProjection) ||
    !same(mission, record.basis.mission) ||
    mission.original.sha256 !== original.sha256 ||
    mission.original.byteLength !== original.byteLength ||
    mission.contentDigest !== contentDigest
  )
    return invalid();
  const missionReference = {
    missionId: mission.missionId,
    sourceRevision: mission.sourceRevision,
    eventId: mission.id,
    contentDigest: mission.contentDigest,
    recordDigest: canonicalDigest(mission),
  };
  const releasePlan = validateMissionReleasePlan({
    version: 2,
    apiUrl: followup.config.apiUrl,
    tenantId: 'tenant-alpha',
    principalId: record.actor.id,
    flightId: record.flightId,
    aircraftId: ids.aircraftId,
    mission: missionReference,
    calculation: {
      id: record.basis.avoidance.calculation.id,
      version: record.basis.avoidance.calculation.version,
      digest: record.basis.avoidance.calculation.digest,
    },
    policy: { id: record.policy.id, version: record.policy.version, digest: record.policy.digest },
    expectedContextDigest: record.basis.avoidance.contextDigest,
    expectedFindingsDigest: 'findings' in record.basis ? record.basis.findings.digest : '',
    departureWindow: record.departureWindow,
    note: record.note,
  });
  validateMissionReleaseRecord(
    selected.release,
    {
      id: record.id,
      kind: 'mission.release',
      flightId: record.flightId,
      actorId: record.actor.id,
      recordedAt: record.recordedAt,
      payload: {
        kind: 'mission.release',
        flightId: record.flightId,
        aircraftId: ids.aircraftId,
        mission: missionReference,
        calculation: releasePlan.calculation,
        policy: releasePlan.policy,
        expectedContextDigest: releasePlan.expectedContextDigest,
        expectedFindingsDigest: releasePlan.expectedFindingsDigest,
        expectedPrincipalRevision: record.actor.principalRevision,
        departureWindow: record.departureWindow,
        note: record.note,
      },
    },
    releasePlan,
  );
  const clocks = [
    followup.start,
    reservation.reservedAt,
    source.occurredAt,
    mission.recordedAt,
    record.recordedAt,
    preparedAt,
  ].map(utc);
  if (clocks.some((clock, index) => index > 0 && clock < clocks[index - 1]!)) return invalid();
  const expected = followup.monitoring.monitoring.control;
  const candidates = record.basis.avoidance.candidates.filter(
    (candidate) => candidate.controlEventId === expected.controlEventId,
  );
  if (candidates.length !== 1) return invalid();
  const candidate = candidates[0]!;
  const acceptance = followup.selection.hazard.decisions.find((decision) => decision.id === expected.acceptance.id);
  if (
    !acceptance ||
    candidate.hazardId !== expected.hazardId ||
    candidate.controlId !== expected.controlId ||
    candidate.controlVersion !== expected.controlVersion ||
    candidate.controlDigest !== expected.controlDigest ||
    !same(candidate.acceptance, expected.acceptance) ||
    candidate.authority?.principalId !== acceptance.actor.principalId
  )
    return invalid();
  const plan = validateMissionDeparturePlan({
    version: 1,
    apiUrl: followup.config.apiUrl,
    tenantId: 'tenant-alpha',
    principalId: selected.principalId,
    runId: followup.runId,
    reservationId: reservation.id,
    flightId: mission.flightId,
    aircraftId: ids.aircraftId,
    release: { id: record.id, digest: selected.release.digest },
    mission: missionReference,
    departureAttemptId: `${ids.attemptId}:departure:1`,
    marginMs: selected.marginMs,
    latencyMarginMs: selected.latencyMarginMs,
    handoffAllowanceMs: selected.handoffAllowanceMs,
    allocationDurationMs: selected.allocationDurationMs,
  });
  const planBytes = JSON.stringify(plan, null, 2) + '\n';
  const result: SmsDeparturePreparation = {
    version: 1,
    kind: 'sms-rehearsal-departure-preparation',
    followupDigest: canonicalDigest(followup),
    revisionDigest: canonicalDigest(revision),
    preparedAt,
    actual: structuredClone(actual),
    selectionText,
    selectionSha256: sha256(selectionText),
    selection: selected,
    plan,
    planBytes,
    planSha256: sha256(planBytes),
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxPreparationBytes) return invalid();
  return result;
}

export function validateSmsDeparturePreparation(
  value: unknown,
  followup: SmsFollowupPreparation,
  revision: OperationReservationRevisionPlan,
): SmsDeparturePreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const retained = value as SmsDeparturePreparation;
  const expected = prepareSmsDeparture(
    followup,
    revision,
    retained.actual,
    retained.selectionText,
    retained.preparedAt,
  );
  if (!same(value, expected)) return invalid();
  return expected;
}
