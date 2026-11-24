import {
  MISSION_BRIEFING_MAX_RECORD_BYTES,
  MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES,
  MISSION_BRIEFING_MAX_CONTROLS,
  MISSION_BRIEFING_MAX_RECIPIENTS,
  missionBriefingControls,
  type MissionBriefingControlReference,
  type MissionBriefingRecord,
  type MissionBriefingAcknowledgementRecord,
  type MissionAvoidanceCandidate,
  type ControlBody,
  type MissionBriefingControlRecordContent,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import { DomainError } from '@ledger/persistence';
import { controlArea, describeControl, findControlType } from './control-types.js';
import { registeredMissionReleasePolicy } from './mission-release-policy.js';
import { isFlightControlsSeen } from './mission-release-controls.js';

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);
const keys = (value: unknown, expected: string[]): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid briefing commitment');
}
function time(value: unknown): number {
  requireValue(
    typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value),
  );
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19));
  return parsed;
}
function reference(value: { id: string; digest: string }): boolean {
  return keys(value, ['id', 'digest']) && id(value.id) && digest(value.digest);
}
function actor(record: MissionBriefingRecord | MissionBriefingAcknowledgementRecord, acknowledge: boolean): void {
  const value = record.actor;
  requireValue(
    keys(value, [
      'id',
      'name',
      'kind',
      'active',
      'principalRevision',
      'capabilities',
      'scope',
      'checkedCapabilities',
      'policyVersion',
    ]),
  );
  requireValue(
    id(value.id) &&
      typeof value.name === 'string' &&
      typeof value.kind === 'string' &&
      value.active === true &&
      revision(value.principalRevision),
  );
  requireValue(
    Array.isArray(value.capabilities) && value.capabilities.every((capability) => typeof capability === 'string'),
  );
  const required = ['flight:read', acknowledge ? 'briefing:ack' : 'briefing:write'];
  requireValue(
    same(value.checkedCapabilities, required) &&
      required.every((capability) => value.capabilities.includes(capability)),
  );
  requireValue(
    value.policyVersion ===
      (acknowledge ? 'ledger.mission-briefing-acknowledgement-authority.1' : 'ledger.mission-briefing-authority.1'),
  );
  requireValue(same(value.scope, { kind: 'flight', id: record.flightId }));
  if (acknowledge) requireValue(value.kind === 'human');
}
export function briefingControlReference(candidate: MissionAvoidanceCandidate): MissionBriefingControlReference {
  const { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance } = candidate;
  return { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance };
}
/**
 * The briefed content of an area control record version, from its registered type, or undefined when the type is not
 * registered here or describes no area.
 */
export function controlRecordBriefingContent(version: {
  title: string;
  body: ControlBody;
}): MissionBriefingControlRecordContent | undefined {
  const { controlType, parameters, effectiveFrom, effectiveUntil } = version.body;
  const type = findControlType(controlType.id, controlType.version);
  const area = controlArea(controlType, parameters);
  const description = describeControl(controlType, parameters);
  if (!type || !area || description === undefined) return undefined;
  return {
    controlType: { ...controlType, title: type.title },
    title: version.title,
    description,
    parameters,
    area,
    effectiveFrom,
    effectiveUntil: effectiveUntil ?? null,
  };
}

function controlRecordContent(instruction: MissionBriefingControlRecordContent): void {
  requireValue(
    keys(instruction, ['controlType', 'title', 'description', 'parameters', 'area', 'effectiveFrom', 'effectiveUntil']),
  );
  const { controlType, title, parameters, effectiveFrom, effectiveUntil } = instruction;
  requireValue(keys(controlType, ['id', 'version', 'digest', 'title']));
  const { title: _typeTitle, ...pinned } = controlType;
  requireValue(
    same(
      instruction,
      controlRecordBriefingContent({
        title,
        body: {
          hazardId: '',
          controlType: pinned,
          parameters,
          effectiveFrom,
          ...(effectiveUntil ? { effectiveUntil } : {}),
        },
      }),
    ),
  );
  // A control record keeps its times as written, which may carry an offset.
  requireValue(effectiveUntil === null || Date.parse(effectiveFrom) < Date.parse(effectiveUntil));
}

function controlReference(control: MissionBriefingControlReference): void {
  requireValue(
    keys(control, ['hazardId', 'controlId', 'controlVersion', 'controlEventId', 'controlDigest', 'acceptance']),
  );
  requireValue(
    [control.hazardId, control.controlId, control.controlEventId].every(id) &&
      revision(control.controlVersion) &&
      digest(control.controlDigest),
  );
  requireValue(
    keys(control.acceptance, ['id', 'acceptedRevision', 'digest']) &&
      id(control.acceptance.id) &&
      revision(control.acceptance.acceptedRevision) &&
      digest(control.acceptance.digest),
  );
}

export function assertMissionBriefingRecord(record: MissionBriefingRecord): void {
  try {
    requireValue(Buffer.byteLength(canonicalize(record), 'utf8') <= MISSION_BRIEFING_MAX_RECORD_BYTES);
    const fields = ['version', 'id', 'flightId', 'organizationId', 'recordedAt', 'purpose', 'context', 'content'];
    const pinsControls = 'controls' in record;
    requireValue(keys(record, [...fields, 'population', 'actor', ...(pinsControls ? ['controls'] : [])]));
    requireValue(record.version === 'flight.mission-briefing.3' && record.purpose === 'informational');
    if (pinsControls) requireValue(isFlightControlsSeen(record.controls));
    requireValue([record.id, record.flightId, record.organizationId].every(id));
    time(record.recordedAt);
    actor(record, false);
    const { context, content, population } = record;
    requireValue(keys(context, ['release', 'mission', 'aircraftId', 'contextDigest', 'releasePolicy', 'controls']));
    requireValue(reference(context.release) && id(context.aircraftId) && digest(context.contextDigest));
    requireValue(keys(context.mission, ['missionId', 'sourceRevision', 'eventId', 'contentDigest', 'recordDigest']));
    requireValue(
      id(context.mission.missionId) &&
        id(context.mission.eventId) &&
        revision(context.mission.sourceRevision) &&
        digest(context.mission.contentDigest) &&
        digest(context.mission.recordDigest),
    );
    const releasePolicy = registeredMissionReleasePolicy(context.releasePolicy?.version);
    requireValue(
      releasePolicy &&
        same(context.releasePolicy, {
          id: releasePolicy.id,
          version: releasePolicy.version,
          digest: releasePolicy.digest,
        }),
    );
    requireValue(
      keys(content, ['message', 'controls']) &&
        typeof content.message === 'string' &&
        content.message.length > 0 &&
        content.message.length <= 4000,
    );
    const listed = record.context.controls;
    requireValue(
      Array.isArray(listed) &&
        Array.isArray(record.content.controls) &&
        listed.length > 0 &&
        listed.length <= MISSION_BRIEFING_MAX_CONTROLS &&
        record.content.controls.length === listed.length,
    );
    const controls = missionBriefingControls(record);
    // Each control once; their order is the release's, which the record alone cannot show.
    requireValue(new Set(controls.map(({ reference }) => reference.controlEventId)).size === controls.length);
    for (const control of controls) {
      controlReference(control.reference);
      controlRecordContent(control.content);
    }
    requireValue(
      keys(population, ['version', 'organizationId', 'recipients', 'digest']) &&
        population.version === 'briefing.recipient-population.1' &&
        population.organizationId === record.organizationId,
    );
    requireValue(
      Array.isArray(population.recipients) &&
        population.recipients.length > 0 &&
        population.recipients.length <= MISSION_BRIEFING_MAX_RECIPIENTS,
    );
    let previous: string | null = null;
    for (const recipient of population.recipients) {
      requireValue(
        keys(recipient, ['principalId', 'name', 'kind', 'principalRevision']) &&
          id(recipient.principalId) &&
          typeof recipient.name === 'string' &&
          recipient.kind === 'human' &&
          revision(recipient.principalRevision),
      );
      requireValue(previous === null || Buffer.compare(Buffer.from(previous), Buffer.from(recipient.principalId)) < 0);
      previous = recipient.principalId;
    }
    const { digest: populationDigest, ...preimage } = population;
    requireValue(digest(populationDigest) && populationDigest === canonicalDigest(preimage));
  } catch {
    throw new DomainError(
      409,
      'briefing_integrity_failure',
      'The retained mission briefing is inconsistent or unsupported',
    );
  }
}
export function assertMissionBriefingAcknowledgementRecord(
  record: MissionBriefingAcknowledgementRecord,
  briefing: MissionBriefingRecord,
): void {
  try {
    assertMissionBriefingRecord(briefing);
    requireValue(Buffer.byteLength(canonicalize(record), 'utf8') <= MISSION_BRIEFING_ACKNOWLEDGEMENT_MAX_RECORD_BYTES);
    requireValue(
      keys(record, [
        'version',
        'id',
        'flightId',
        'briefing',
        'populationDigest',
        'recipientPrincipalId',
        'attestation',
        'recordedAt',
        'actor',
      ]),
    );
    requireValue(
      record.version === 'flight.mission-briefing-acknowledgement.1' &&
        id(record.id) &&
        record.flightId === briefing.flightId &&
        record.attestation === 'reviewed_exact_briefing',
    );
    requireValue(
      same(record.briefing, { id: briefing.id, digest: canonicalDigest(briefing) }) &&
        record.populationDigest === briefing.population.digest,
    );
    requireValue(time(record.recordedAt) >= time(briefing.recordedAt));
    actor(record, true);
    requireValue(
      record.recipientPrincipalId === record.actor.id &&
        briefing.population.recipients.some(({ principalId }) => principalId === record.recipientPrincipalId),
    );
  } catch {
    throw new DomainError(
      409,
      'briefing_integrity_failure',
      'The retained acknowledgement is inconsistent or unsupported',
    );
  }
}
