import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  MISSION_RELEASE_MAX_RECORD_BYTES,
  MissionReleaseAcceptedCommandSchema,
  MissionReleaseRecordResponseSchema,
  MissionReleaseValidityResponseSchema,
  type MissionReleaseCommandResponse,
  type MissionReleaseRecord,
  type MissionReleaseRecordResponse,
  type MissionReleaseValidityResponse,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { OracleReader } from './attempt-oracle.js';
import type { MissionReleaseActorResult } from './mission-release-actor.js';
import {
  ReleasePending,
  reviewedMissionReleasePolicy,
  validateMissionReleaseAvoidance,
  validateMissionReleaseCommand,
  validateMissionReleaseMission,
  type MissionReleasePlan,
} from './mission-release-plan.js';
import { OracleReadError } from './oracle-api.js';

type Accepted = MissionReleaseCommandResponse['command'];
const ajv = new Ajv({ strict: false, strictNumbers: true });
const installFormats = addFormats as unknown as (instance: Ajv) => void;
installFormats(ajv);
const acceptedSchema = ajv.compile<Accepted>(MissionReleaseAcceptedCommandSchema);
const recordSchema = ajv.compile<MissionReleaseRecordResponse>(MissionReleaseRecordResponseSchema);
const validitySchema = ajv.compile<MissionReleaseValidityResponse>(MissionReleaseValidityResponseSchema);
const same = (first: unknown, second: unknown) => canonicalDigest(first) === canonicalDigest(second);

function mismatch(): never {
  throw new ReleasePending('commitment_mismatch', 'The release confirmation differs from its retained action or basis');
}

function utc(value: string): number {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return mismatch();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return mismatch();
  return at;
}

export function validateMissionReleaseAccepted(
  value: unknown,
  action: { payload: string },
  plan: MissionReleasePlan,
): Accepted {
  let payload: unknown;
  try {
    payload = JSON.parse(action.payload);
  } catch {
    return mismatch();
  }
  const command = validateMissionReleaseCommand(payload, plan);
  if (
    !acceptedSchema(value) ||
    value.actorId !== plan.principalId ||
    value.flightId !== plan.flightId ||
    !same(value.payload, command)
  )
    return mismatch();
  utc(value.recordedAt);
  return structuredClone(value);
}

function basis(record: MissionReleaseRecord, plan: MissionReleasePlan): void {
  const { renderedInputCut: rendered, acceptedInputCut: accepted, basisManifest: manifest } = record.basis;
  const principalRevision = record.actor.principalRevision;
  if (
    !Number.isSafeInteger(rendered.basisRevision) ||
    Number(rendered.basisRevision) < 0 ||
    !Number.isSafeInteger(accepted.basisRevision) ||
    Number(accepted.basisRevision) < 0 ||
    rendered.principalRevision !== principalRevision ||
    accepted.principalRevision !== principalRevision ||
    manifest.subjectId !== plan.flightId ||
    manifest.principalId !== plan.principalId ||
    manifest.principalRevision !== principalRevision
  )
    mismatch();
  const subjects = new Set(manifest.subjects);
  if (
    subjects.size !== manifest.subjects.length ||
    !subjects.has(plan.flightId) ||
    !subjects.has(record.basis.mission.missionId) ||
    !subjects.has(record.organizationId) ||
    manifest.subjects.some((subject) => subject.startsWith('organization:') && subject !== record.organizationId)
  )
    mismatch();
  const edges = new Set<string>();
  for (const edge of manifest.edges) {
    const key = JSON.stringify([edge.subjectId, edge.dependencySubjectId]);
    if (!subjects.has(edge.subjectId) || !subjects.has(edge.dependencySubjectId) || edges.has(key)) mismatch();
    edges.add(key);
  }
  if (
    !edges.has(JSON.stringify([plan.flightId, record.organizationId])) ||
    !edges.has(JSON.stringify([plan.flightId, record.basis.mission.missionId]))
  )
    mismatch();
  const renderedStreams = new Map<string, number>();
  const acceptedStreams = new Map<string, number>();
  const frontiers = new Set<string>();
  for (const frontier of manifest.frontiers) {
    const key = JSON.stringify([frontier.subjectId, frontier.streamId]);
    if (!subjects.has(frontier.subjectId) || frontiers.has(key)) mismatch();
    frontiers.add(key);
  }
  for (const frontier of [...manifest.frontiers, ...(manifest.authority ? [manifest.authority] : [])]) {
    if (
      !Number.isSafeInteger(frontier.sequence) ||
      !Number.isSafeInteger(frontier.projectedSequence) ||
      frontier.projectedSequence > frontier.sequence
    )
      mismatch();
    renderedStreams.set(
      frontier.streamId,
      Math.max(renderedStreams.get(frontier.streamId) ?? 0, frontier.projectedSequence),
    );
    acceptedStreams.set(frontier.streamId, Math.max(acceptedStreams.get(frontier.streamId) ?? 0, frontier.sequence));
  }
  if (
    !same(rendered.streams, Object.fromEntries(renderedStreams)) ||
    !same(accepted.streams, Object.fromEntries(acceptedStreams))
  )
    mismatch();
}

export function validateMissionReleaseRecord(
  value: unknown,
  accepted: Accepted,
  plan: MissionReleasePlan,
): MissionReleaseRecordResponse {
  if (!recordSchema(value)) return mismatch();
  const { release: record, digest } = value;
  const command = validateMissionReleaseCommand(accepted.payload, plan);
  const recordedAt = utc(record.recordedAt);
  const mission = validateMissionReleaseMission(record.basis.mission, plan);
  const avoidance = validateMissionReleaseAvoidance(record.basis.avoidance, plan);
  const { digest: policyDigest, ...policy } = record.policy;
  const start = utc(record.departureWindow.start);
  const end = utc(record.departureWindow.end);
  if (
    Buffer.byteLength(JSON.stringify(record), 'utf8') > MISSION_RELEASE_MAX_RECORD_BYTES ||
    digest !== canonicalDigest(record) ||
    record.id !== accepted.id ||
    record.flightId !== plan.flightId ||
    record.organizationId !== `organization:${plan.tenantId}` ||
    record.aircraftId !== plan.aircraftId ||
    recordedAt !== utc(accepted.recordedAt) ||
    record.actor.id !== plan.principalId ||
    record.actor.scope.id !== plan.flightId ||
    record.actor.principalRevision !== command.expectedPrincipalRevision ||
    record.actor.checkedCapabilities.some((capability) => !record.actor.capabilities.includes(capability)) ||
    new Set(record.actor.capabilities).size !== record.actor.capabilities.length ||
    !same(record.policy, reviewedMissionReleasePolicy) ||
    canonicalDigest(policy) !== policyDigest ||
    record.version !== 'flight.mission-release.2' ||
    record.basis.findings.digest !== command.expectedFindingsDigest ||
    !same(record.departureWindow, command.departureWindow) ||
    record.note !== command.note ||
    start >= end ||
    start < utc(mission.operatingInterval.start) ||
    end > utc(mission.operatingInterval.end) ||
    recordedAt >= end ||
    utc(mission.recordedAt) > recordedAt ||
    utc(avoidance.evaluatedAt) > recordedAt ||
    record.basis.candidateContexts.length !== avoidance.candidates.length ||
    record.basis.notApplicableContexts.length !== avoidance.notApplicable.length
  )
    mismatch();
  const keys = new Set<string>();
  for (const candidate of avoidance.candidates) {
    if (
      utc(candidate.interval.start) >= utc(mission.operatingInterval.end) ||
      utc(candidate.interval.end) <= utc(mission.operatingInterval.start)
    )
      mismatch();
    const key = JSON.stringify([candidate.controlEventId, candidate.acceptance.id]);
    const matching = record.basis.candidateContexts.filter(
      (entry) => entry.controlEventId === candidate.controlEventId && entry.acceptanceId === candidate.acceptance.id,
    );
    if (keys.has(key) || matching.length !== 1) mismatch();
    keys.add(key);
    const context = matching[0]!.context;
    if (canonicalDigest(context) !== candidate.safetyContextDigest || !same(context.assessment, candidate.assessment))
      mismatch();
    // A control record's context shape is checked by the release schema.
  }
  basis(record, plan);
  return value;
}

function validity(value: unknown, record: MissionReleaseRecordResponse): MissionReleaseValidityResponse {
  if (!validitySchema(value)) return mismatch();
  const at = utc(value.evaluatedAt);
  const start = utc(record.release.departureWindow.start);
  const end = utc(record.release.departureWindow.end);
  if (
    value.release.id !== record.release.id ||
    value.release.digest !== record.digest ||
    at < utc(record.release.recordedAt) ||
    (value.status === 'expired') !== at >= end ||
    (at < end &&
      value.currentContextDigest !== null &&
      value.currentContextDigest !== record.release.basis.avoidance.contextDigest &&
      value.status !== 'changed')
  )
    mismatch();
  if (value.nextBoundary !== null) utc(value.nextBoundary);
  if (value.status === 'current' || value.status === 'scheduled') {
    if (
      value.currentContextDigest !== record.release.basis.avoidance.contextDigest ||
      (value.status === 'scheduled') !== at < start
    )
      mismatch();
  }
  return structuredClone(value);
}

export async function confirmMissionRelease(
  plan: MissionReleasePlan,
  accepted: Accepted,
  api: OracleReader,
  attempts: number,
): Promise<MissionReleaseActorResult> {
  validateMissionReleaseAccepted(accepted, { payload: JSON.stringify(accepted.payload) }, plan);
  const path = `/v1/flights/${encodeURIComponent(plan.flightId)}/mission-releases/${encodeURIComponent(accepted.id)}`;
  const record = validateMissionReleaseRecord(await api.json<unknown>(path), accepted, plan);
  const result: MissionReleaseActorResult = {
    status: 'accepted',
    code: 'release_confirmed',
    reason: 'The exact release acceptance is confirmed; its as-of validity is reported separately',
    attempts,
    eventId: accepted.id,
    flightId: plan.flightId,
    record: 'confirmed',
    releaseDigest: record.digest,
  };
  try {
    result.validity = validity(await api.json<unknown>(`${path}/validity`), record);
  } catch (error) {
    result.code =
      error instanceof ReleasePending || error instanceof OracleReadError ? error.code : 'validity_unavailable';
    result.reason = 'The exact release acceptance is confirmed; its as-of validity is unconfirmed';
  }
  return result;
}
