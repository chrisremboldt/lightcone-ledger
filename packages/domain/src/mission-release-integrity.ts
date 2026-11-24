import { Ajv } from 'ajv';
import {
  ControlApplicabilityRecordSchema,
  evaluationOutcomeValues,
  evidenceStateValues,
  MISSION_AVOIDANCE_CANDIDATE_LIMIT,
  MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  MISSION_RELEASE_FINDING_LIMIT,
  MISSION_RELEASE_FINDING_SUBJECT_LIMIT,
  MISSION_RELEASE_MAX_RECORD_BYTES,
  MISSION_SOURCE_MAX_BYTES,
  missionReleaseFindingStatusValues,
  observationSubjectKindValues,
  subjectReferenceKey,
  type MissionReleaseFindings,
  type MissionReleaseRecord,
  type MissionReleaseControlRecordContext,
  type ControlApplicabilityRecord,
  type MissionAvoidanceMissionReference,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import { DomainError } from '@ledger/persistence';
import { calculationMeta } from './mission-avoidance-definition.js';
import { isRegisteredMissionReleasePolicy } from './mission-release-policy.js';
import { verifyMissionInputSource } from './missions.js';
import { findingIdFor } from './rule-evaluations.js';
import { missionAvoidanceContextDigest } from './mission-avoidance-context.js';
import { findControlType, registeredControlTypeDigest } from './control-types.js';

const validApplicabilityRecord = new Ajv({
  strict: false,
  strictNumbers: true,
  allErrors: false,
}).compile<ControlApplicabilityRecord>(structuredClone(ControlApplicabilityRecordSchema));

const requiredCapabilities = ['decision:write', 'flight:read', 'mission:release'];
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function failure(): DomainError {
  return new DomainError(
    409,
    'release_integrity_failure',
    'The retained mission release is inconsistent or unsupported',
  );
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw failure();
}

function keys(value: unknown, required: string[], optional: string[] = []): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function time(value: unknown): number {
  requireValue(
    typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value),
  );
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19));
  return parsed;
}

function reference(value: { id: string; digest: string; acceptedRevision?: number }, accepted = false): void {
  requireValue(
    keys(value, accepted ? ['id', 'digest', 'acceptedRevision'] : ['id', 'digest']) &&
      id(value.id) &&
      digest(value.digest),
  );
  if (accepted) requireValue(revision(value.acceptedRevision, 1));
}

/** The retained context of a candidate read from an area control record accepted on a safety-record hazard. */
function controlRecordContextShape(context: MissionReleaseControlRecordContext): void {
  requireValue(keys(context, ['version', 'assessment', 'hazard', 'control']));
  reference(context.assessment, true);
  requireValue(
    keys(context.hazard, ['id', 'latestAcceptanceId']) &&
      id(context.hazard.id) &&
      id(context.hazard.latestAcceptanceId),
  );
  requireValue(
    keys(context.control, ['recordId', 'versionNumber', 'status']) &&
      id(context.control.recordId) &&
      revision(context.control.versionNumber, 1) &&
      id(context.control.status),
  );
}

/** A not-applicable entry's title and the area its type describes, or null, as a screen reads them. */
function placedEntryShape(entry: MissionReleaseRecord['basis']['avoidance']['notApplicable'][number]): boolean {
  const { title, area } = entry;
  if (typeof title !== 'string' || !title.length || title.length > 200) return false;
  if (area === null) return true;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  return (
    keys(area, ['center', 'radiusMeters']) &&
    keys(area.center, ['latitude', 'longitude']) &&
    finite(area.center.latitude) &&
    Math.abs(area.center.latitude) <= 90 &&
    finite(area.center.longitude) &&
    Math.abs(area.center.longitude) <= 180 &&
    finite(area.radiusMeters) &&
    area.radiusMeters > 0
  );
}

type ReleasedEntry =
  | MissionReleaseRecord['basis']['avoidance']['candidates'][number]
  | MissionReleaseRecord['basis']['avoidance']['notApplicable'][number];

/**
 * An entry's applicability record: its shape and digest, evaluated for the release's mission and the entry's own
 * control version and type. A control that does not apply was found so by the rule its registered type declares.
 */
function applicabilityShape(
  entry: ReleasedEntry,
  mission: MissionAvoidanceMissionReference,
  outcome: 'applies' | 'does_not_apply',
): void {
  const record = entry.applicability;
  requireValue(validApplicabilityRecord(record) && record.outcome === outcome);
  requireValue(entry.applicabilityDigest === canonicalDigest(record));
  requireValue(
    same(record.inputs.mission, mission) &&
      same(record.inputs.control, {
        controlId: entry.controlId,
        versionNumber: entry.controlVersion,
        controlEventId: entry.controlEventId,
        bodyDigest: entry.controlDigest,
      }) &&
      same(record.inputs.controlType, entry.template),
  );
  if (outcome === 'applies') return;
  const { id, version, digest: typeDigest } = entry.template;
  const declared = findControlType(id, version)?.applicability?.rule;
  requireValue(
    record.basis === 'rule' &&
      registeredControlTypeDigest(id, version) === typeDigest &&
      declared !== undefined &&
      same(record.rule, declared),
  );
}

/** The candidate fields an entry shares with every considered control. */
function consideredEntryShape(
  entry: ReleasedEntry,
  mission: MissionReleaseRecord['basis']['mission'],
  contexts: Map<string, MissionReleaseControlRecordContext>,
  controls: Set<string>,
  types: Set<string>,
): void {
  requireValue(
    [entry.hazardId, entry.controlId, entry.controlEventId].every(id) &&
      revision(entry.controlVersion, 1) &&
      digest(entry.controlDigest) &&
      entry.context === 'current' &&
      same(entry.reasons, []),
  );
  requireValue(
    keys(entry.template, ['id', 'version', 'digest']) &&
      id(entry.template.id) &&
      revision(entry.template.version, 1) &&
      digest(entry.template.digest) &&
      types.has(canonicalize(entry.template)),
  );
  reference(entry.acceptance, true);
  reference(entry.assessment, true);
  const authority = entry.authority;
  requireValue(
    keys(authority, ['policyVersion', 'principalId', 'principalRevision', 'satisfyingCapability']) &&
      authority.policyVersion === 'ledger.sms-decision-authority.1' &&
      id(authority.principalId) &&
      revision(authority.principalRevision, 1) &&
      ['risk:accept:low', 'risk:accept:medium', 'risk:accept:high'].includes(authority.satisfyingCapability),
  );
  requireValue(
    keys(entry.interval, ['start', 'end']) &&
      time(entry.interval.start) < time(entry.interval.end) &&
      time(entry.interval.start) < time(mission.operatingInterval.end) &&
      time(entry.interval.end) > time(mission.operatingInterval.start),
  );
  const key = canonicalize([entry.controlEventId, entry.acceptance.id]);
  const context = contexts.get(key);
  requireValue(
    context && same(context.assessment, entry.assessment) && canonicalDigest(context) === entry.safetyContextDigest,
  );
  contexts.delete(key);
  const control = canonicalize([entry.hazardId, entry.controlId, entry.controlVersion]);
  requireValue(!controls.has(control));
  controls.add(control);
}

/** Retained safety context preimages by control version event and acceptance, each once. */
function contextsByControl(entries: MissionReleaseRecord['basis']['candidateContexts']) {
  const contexts = new Map<string, MissionReleaseControlRecordContext>();
  for (const entry of entries) {
    requireValue(
      keys(entry, ['controlEventId', 'acceptanceId', 'context']) && id(entry.controlEventId) && id(entry.acceptanceId),
    );
    const pair = canonicalize([entry.controlEventId, entry.acceptanceId]);
    requireValue(!contexts.has(pair));
    controlRecordContextShape(entry.context);
    contexts.set(pair, entry.context);
  }
  return contexts;
}

function basisConsistency(record: MissionReleaseRecord): void {
  const { basisManifest: manifest, renderedInputCut: rendered, acceptedInputCut: accepted } = record.basis;
  requireValue(
    keys(manifest, [
      'version',
      'subjectId',
      'principalId',
      'principalRevision',
      'subjects',
      'edges',
      'frontiers',
      'authority',
    ]),
  );
  requireValue(
    manifest.version === 'subject-evidence.1' &&
      manifest.subjectId === record.flightId &&
      manifest.principalId === record.actor.id &&
      manifest.principalRevision === record.actor.principalRevision,
  );
  requireValue(
    Array.isArray(manifest.subjects) &&
      manifest.subjects.every(id) &&
      new Set(manifest.subjects).size === manifest.subjects.length &&
      manifest.subjects.includes(record.flightId),
  );
  requireValue(Array.isArray(manifest.edges) && Array.isArray(manifest.frontiers));
  for (const edge of manifest.edges)
    requireValue(
      keys(edge, ['subjectId', 'dependencySubjectId', 'eventId']) &&
        manifest.subjects.includes(edge.subjectId) &&
        manifest.subjects.includes(edge.dependencySubjectId) &&
        id(edge.eventId),
    );
  const acceptedStreams: Record<string, number> = {};
  const renderedStreams: Record<string, number> = {};
  const pairs = new Set<string>();
  for (const frontier of manifest.frontiers) {
    requireValue(
      keys(frontier, ['subjectId', 'streamId', 'sequence', 'projectedSequence']) &&
        manifest.subjects.includes(frontier.subjectId) &&
        id(frontier.streamId),
    );
    const pair = canonicalize([frontier.subjectId, frontier.streamId]);
    requireValue(!pairs.has(pair));
    pairs.add(pair);
  }
  for (const frontier of [...manifest.frontiers, ...(manifest.authority === null ? [] : [manifest.authority])]) {
    requireValue(
      id(frontier.streamId) &&
        revision(frontier.sequence) &&
        revision(frontier.projectedSequence) &&
        frontier.projectedSequence <= frontier.sequence,
    );
    acceptedStreams[frontier.streamId] = Math.max(acceptedStreams[frontier.streamId] ?? 0, frontier.sequence);
    renderedStreams[frontier.streamId] = Math.max(renderedStreams[frontier.streamId] ?? 0, frontier.projectedSequence);
  }
  if (manifest.authority !== null)
    requireValue(keys(manifest.authority, ['streamId', 'sequence', 'projectedSequence']));
  for (const cut of [rendered, accepted]) {
    requireValue(
      keys(cut, ['streams', 'principalRevision', 'basisRevision']) &&
        cut.principalRevision === record.actor.principalRevision &&
        revision(cut.basisRevision),
    );
  }
  requireValue(
    rendered.basisRevision === accepted.basisRevision &&
      same(rendered.streams, renderedStreams) &&
      same(accepted.streams, acceptedStreams),
  );
}

const byKey = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function subjectReference(value: SubjectReference): string {
  requireValue(
    keys(value, ['scope', 'kind', 'id'], ['sourceId']) &&
      (observationSubjectKindValues as readonly string[]).includes(value.kind) &&
      id(value.id) &&
      (value.scope === 'source' ? id(value.sourceId) : value.scope === 'ledger' && value.sourceId === undefined),
  );
  return subjectReferenceKey(value);
}

/** The findings section of a version 2 release: shape, order, finding identity and its own digest. */
function findingsShape(record: MissionReleaseRecord, findings: MissionReleaseFindings, recordedAt: number): void {
  requireValue(
    keys(findings, ['version', 'subjects', 'findings', 'digest']) &&
      findings.version === 'mission.release-findings.1' &&
      Array.isArray(findings.subjects) &&
      findings.subjects.length <= MISSION_RELEASE_FINDING_SUBJECT_LIMIT &&
      Array.isArray(findings.findings) &&
      findings.findings.length <= MISSION_RELEASE_FINDING_LIMIT,
  );
  const subjectKeys: string[] = [];
  const reasons: string[] = [];
  for (const entry of findings.subjects) {
    requireValue(keys(entry, ['subject', 'subjectKey', 'reason']));
    requireValue(
      subjectReference(entry.subject) === entry.subjectKey &&
        ['flight', 'organization', 'named'].includes(entry.reason),
    );
    if (entry.reason === 'flight')
      requireValue(same(entry.subject, { scope: 'ledger', kind: 'flight', id: record.flightId }));
    if (entry.reason === 'organization')
      requireValue(same(entry.subject, { scope: 'ledger', kind: 'organization', id: record.organizationId }));
    if (entry.reason === 'named') requireValue(entry.subject.kind !== 'flight');
    requireValue(subjectKeys.length === 0 || byKey(subjectKeys.at(-1)!, entry.subjectKey) < 0);
    subjectKeys.push(entry.subjectKey);
    reasons.push(entry.reason);
  }
  requireValue(
    reasons.filter((reason) => reason === 'flight').length === 1 &&
      reasons.filter((reason) => reason === 'organization').length === 1,
  );
  const flightKey = subjectKeys[reasons.indexOf('flight')];
  const tenantId = record.organizationId.slice('organization:'.length);
  let previous: [string, string] | undefined;
  for (const finding of findings.findings) {
    requireValue(
      keys(finding, ['id', 'subject', 'subjectKey', 'status', 'rule', 'answer', 'evaluation'], ['related']) &&
        subjectReference(finding.subject) === finding.subjectKey &&
        (missionReleaseFindingStatusValues as readonly string[]).includes(finding.status),
    );
    if (finding.related !== undefined)
      requireValue(
        keys(finding.related, ['name', 'subject', 'subjectKey']) &&
          id(finding.related.name) &&
          subjectReference(finding.related.subject) === finding.related.subjectKey,
      );
    const relatedKey = finding.related?.subjectKey ?? '';
    requireValue(
      subjectKeys.includes(finding.subjectKey) ||
        (subjectKeys.includes(relatedKey) && !(finding.subject.kind === 'flight' && finding.subjectKey !== flightKey)),
    );
    const rule = finding.rule;
    requireValue(
      keys(rule, ['packId', 'id', 'version', 'title']) &&
        [rule.packId, rule.id, rule.title].every(id) &&
        revision(rule.version, 1) &&
        finding.id === findingIdFor(tenantId, finding.subjectKey, rule.packId, rule.id, relatedKey),
    );
    const answer = finding.answer;
    requireValue(
      keys(answer, ['outcome', 'evidenceState', 'summary']) &&
        (evaluationOutcomeValues as readonly string[]).includes(answer.outcome) &&
        (evidenceStateValues as readonly string[]).includes(answer.evidenceState) &&
        typeof answer.summary === 'string' &&
        answer.summary.length > 0 &&
        answer.summary.length <= 2000,
    );
    requireValue(
      keys(finding.evaluation, ['id', 'digest', 'recordedAt']) &&
        id(finding.evaluation.id) &&
        digest(finding.evaluation.digest) &&
        time(finding.evaluation.recordedAt) <= recordedAt,
    );
    const position: [string, string] = [finding.subjectKey, finding.id];
    requireValue(
      !previous ||
        byKey(previous[0], position[0]) < 0 ||
        (previous[0] === position[0] && byKey(previous[1], position[1]) < 0),
    );
    previous = position;
  }
  requireValue(
    findings.digest ===
      canonicalDigest({ version: findings.version, subjects: findings.subjects, findings: findings.findings }),
  );
}

function checkRecord(record: MissionReleaseRecord): void {
  requireValue(Buffer.byteLength(canonicalize(record), 'utf8') <= MISSION_RELEASE_MAX_RECORD_BYTES);
  requireValue(
    keys(record, [
      'version',
      'id',
      'flightId',
      'organizationId',
      'aircraftId',
      'acceptedRevision',
      'recordedAt',
      'actor',
      'policy',
      'departureWindow',
      'note',
      'basis',
    ]),
  );
  requireValue(
    record.version === 'flight.mission-release.2' &&
      [record.id, record.flightId, record.organizationId, record.aircraftId].every(id) &&
      revision(record.acceptedRevision, 1),
  );
  requireValue(
    typeof record.note === 'string' &&
      record.note.length > 0 &&
      record.note.length <= 4000 &&
      isRegisteredMissionReleasePolicy(record.policy),
  );
  const recordedAt = time(record.recordedAt);
  const actor = record.actor;
  requireValue(
    keys(actor, [
      'id',
      'name',
      'kind',
      'active',
      'principalRevision',
      'capabilities',
      'commandLinkSources',
      'missionSources',
      'checkedCapabilities',
      'policyVersion',
      'scope',
    ]),
  );
  requireValue(
    id(actor.id) &&
      typeof actor.name === 'string' &&
      typeof actor.kind === 'string' &&
      actor.active === true &&
      revision(actor.principalRevision, 1),
  );
  requireValue(
    strings(actor.capabilities) &&
      Array.isArray(actor.commandLinkSources) &&
      actor.commandLinkSources.every(id) &&
      Array.isArray(actor.missionSources) &&
      actor.missionSources.every(id),
  );
  requireValue(
    actor.policyVersion === 'ledger.mission-release-authority.1' &&
      same(actor.checkedCapabilities, requiredCapabilities) &&
      requiredCapabilities.every((capability) => actor.capabilities.includes(capability)),
  );
  requireValue(
    keys(actor.scope, ['kind', 'id']) && actor.scope.kind === 'flight' && actor.scope.id === record.flightId,
  );
  requireValue(
    keys(record.basis, [
      'mission',
      'avoidance',
      'candidateContexts',
      'notApplicableContexts',
      'renderedInputCut',
      'acceptedInputCut',
      'basisManifest',
      'findings',
    ]),
  );
  findingsShape(record, record.basis.findings, recordedAt);
  const { mission, avoidance, candidateContexts, notApplicableContexts } = record.basis;
  requireValue(
    keys(
      mission,
      [
        'missionId',
        'flightId',
        'sourceId',
        'sourceMissionId',
        'aircraftId',
        'version',
        'id',
        'sourceRevision',
        'occurredAt',
        'recordedAt',
        'receiptId',
        'artifactId',
        'route',
        'lateralToleranceMeters',
        'altitude',
        'operatingInterval',
        'original',
        'contentDigest',
        'authority',
      ],
      ['routePlanning'],
    ),
  );
  requireValue(
    mission.version === 'flight.mission.1' &&
      mission.flightId === record.flightId &&
      mission.aircraftId === record.aircraftId &&
      id(mission.missionId) &&
      id(mission.id) &&
      id(mission.receiptId) &&
      digest(mission.contentDigest),
  );
  requireValue(
    keys(mission.original, ['sha256', 'byteLength']) &&
      digest(mission.original.sha256) &&
      revision(mission.original.byteLength, 1) &&
      mission.original.byteLength <= MISSION_SOURCE_MAX_BYTES,
  );
  const missionAuthority = mission.authority;
  requireValue(
    keys(missionAuthority, [
      'version',
      'principalId',
      'tenantId',
      'principalRevision',
      'inputKind',
      'sourceId',
      'requiredCapabilities',
      'grantedSources',
    ]),
  );
  requireValue(
    missionAuthority.version === 'ledger.mission-authority.1' &&
      missionAuthority.inputKind === 'mission.revision' &&
      id(missionAuthority.principalId) &&
      id(missionAuthority.tenantId) &&
      revision(missionAuthority.principalRevision, 1) &&
      missionAuthority.sourceId === mission.sourceId,
  );
  requireValue(
    same(missionAuthority.requiredCapabilities, ['input:write', 'mission:write']) &&
      Array.isArray(missionAuthority.grantedSources) &&
      missionAuthority.grantedSources.length <= 100 &&
      missionAuthority.grantedSources.every(id) &&
      new Set(missionAuthority.grantedSources).size === missionAuthority.grantedSources.length &&
      missionAuthority.grantedSources.includes(mission.sourceId),
  );
  requireValue(
    record.organizationId === `organization:${mission.authority.tenantId}` && time(mission.recordedAt) <= recordedAt,
  );
  const payload = {
    sourceMissionId: mission.sourceMissionId,
    aircraftId: mission.aircraftId,
    route: mission.route,
    lateralToleranceMeters: mission.lateralToleranceMeters,
    altitude: mission.altitude,
    operatingInterval: mission.operatingInterval,
    ...(mission.routePlanning ? { routePlanning: mission.routePlanning } : {}),
  };
  verifyMissionInputSource(
    {
      sourceId: mission.sourceId,
      kind: 'mission.revision',
      sourceRevision: mission.sourceRevision,
      occurredAt: mission.occurredAt,
      subject: { flightId: record.flightId },
      artifactId: mission.artifactId,
      fidelity: 'synthetic_contract',
      payload,
    },
    Buffer.from(
      JSON.stringify({ sourceRevision: mission.sourceRevision, occurredAt: mission.occurredAt, ...payload }),
      'utf8',
    ),
  );
  requireValue(
    keys(avoidance, [
      'version',
      'evaluatedAt',
      'status',
      'mission',
      'candidates',
      'notApplicable',
      'consideredTypes',
      'candidateCompleteness',
      'calculation',
      'contextDigest',
      'previewDigest',
      'reasons',
    ]),
  );
  requireValue(
    avoidance.version === 'flight.mission-avoidance.1' &&
      avoidance.status === 'outside' &&
      same(avoidance.calculation, calculationMeta) &&
      time(avoidance.evaluatedAt) <= recordedAt,
  );
  requireValue(
    same(avoidance.mission, {
      missionId: mission.missionId,
      sourceRevision: mission.sourceRevision,
      eventId: mission.id,
      contentDigest: mission.contentDigest,
      recordDigest: canonicalDigest(mission),
    }),
  );
  requireValue(
    Array.isArray(avoidance.candidates) &&
      avoidance.candidates.length <= MISSION_AVOIDANCE_CANDIDATE_LIMIT &&
      Array.isArray(candidateContexts) &&
      candidateContexts.length === avoidance.candidates.length &&
      Array.isArray(avoidance.notApplicable) &&
      avoidance.candidates.length + avoidance.notApplicable.length <= MISSION_AVOIDANCE_CONSIDERED_LIMIT &&
      Array.isArray(notApplicableContexts) &&
      notApplicableContexts.length === avoidance.notApplicable.length,
  );
  requireValue(
    same(avoidance.candidateCompleteness, {
      status: 'complete',
      count: avoidance.candidates.length,
      limit: MISSION_AVOIDANCE_CANDIDATE_LIMIT,
      considered: avoidance.candidates.length + avoidance.notApplicable.length,
      consideredLimit: MISSION_AVOIDANCE_CONSIDERED_LIMIT,
    }) && same(avoidance.reasons, []),
  );
  requireValue(Array.isArray(avoidance.consideredTypes) && avoidance.consideredTypes.length <= 32);
  const types = new Set<string>();
  for (const type of avoidance.consideredTypes) {
    requireValue(
      keys(type, ['id', 'version', 'digest']) && id(type.id) && revision(type.version, 1) && digest(type.digest),
    );
    types.add(canonicalize(type));
  }
  requireValue(types.size === avoidance.consideredTypes.length);
  const contexts = contextsByControl(candidateContexts);
  const notApplicableByControl = contextsByControl(notApplicableContexts);
  const controls = new Set<string>();
  const entryKeys = [
    'hazardId',
    'controlId',
    'controlVersion',
    'controlEventId',
    'controlDigest',
    'template',
    'acceptance',
    'assessment',
    'authority',
    'interval',
    'context',
    'safetyContextDigest',
    'reasons',
    'applicability',
    'applicabilityDigest',
  ];
  for (const candidate of avoidance.candidates) {
    requireValue(keys(candidate, [...entryKeys, 'geometry']) && candidate.geometry === 'outside');
    consideredEntryShape(candidate, mission, contexts, controls, types);
    applicabilityShape(candidate, avoidance.mission, 'applies');
  }
  for (const entry of avoidance.notApplicable) {
    requireValue(keys(entry, [...entryKeys, 'title', 'area']) && placedEntryShape(entry));
    consideredEntryShape(entry, mission, notApplicableByControl, controls, types);
    applicabilityShape(entry, avoidance.mission, 'does_not_apply');
  }
  requireValue(contexts.size === 0 && notApplicableByControl.size === 0);
  requireValue(
    avoidance.contextDigest ===
      missionAvoidanceContextDigest({
        mission: avoidance.mission,
        calculation: { id: calculationMeta.id, version: calculationMeta.version, digest: calculationMeta.digest },
        candidates: avoidance.candidates,
        notApplicable: avoidance.notApplicable,
        consideredTypes: avoidance.consideredTypes,
        candidateCompleteness: avoidance.candidateCompleteness,
      }),
  );
  const { previewDigest, ...preview } = avoidance;
  requireValue(previewDigest === canonicalDigest(preview));
  requireValue(
    keys(record.departureWindow, ['start', 'end']) &&
      time(record.departureWindow.start) < time(record.departureWindow.end) &&
      time(record.departureWindow.start) >= time(mission.operatingInterval.start) &&
      time(record.departureWindow.end) <= time(mission.operatingInterval.end) &&
      recordedAt < time(record.departureWindow.end),
  );
  basisConsistency(record);
}

export function assertMissionReleaseRecord(record: MissionReleaseRecord): void {
  try {
    checkRecord(record);
  } catch {
    throw failure();
  }
}
