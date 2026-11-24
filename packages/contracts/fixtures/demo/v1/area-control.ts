import { canonicalDigest } from '../../../../integrity/src/index.js';
import type {
  ControlApplicabilityRecord,
  ControlBody,
  MissionAvoidanceCandidate,
  MissionAvoidanceMissionReference,
  MissionBriefingControlRecordContent,
  MissionReleaseControlRecordContext,
  SmsAcceptanceOutcome,
  SmsAssessmentOutcome,
  SmsDecisionRecord,
  SmsRecordVersion,
} from '../../../src/index.js';

/**
 * The registered area control type route review reads, pinned by id, version and digest (control.avoidance-area in
 * packages/domain/src/control-type-library.ts; tests compare this digest with the registered one).
 */
export const avoidanceAreaControlType = {
  id: 'control.avoidance-area',
  version: 1,
  digest: '2395def95d291518f6f44e8cccfbdcf9415c56a6ae6fa67f97fd8044031af6d3',
  title: 'Route avoidance area',
} as const;
const pinnedType = {
  id: avoidanceAreaControlType.id,
  version: avoidanceAreaControlType.version,
  digest: avoidanceAreaControlType.digest,
};

export const areaControlOrganizationId = 'organization:fixture-tenant';
export const areaControlHazardId = 'fixture-site-hazard';
export const areaControlRecordId = 'fixture-riverside-avoidance-area';
const hazardId = areaControlHazardId;
const controlId = areaControlRecordId;
const safetyLead = { id: 'fixture-control-owner', name: 'Morgan Reed' };
const executive = { id: 'fixture-risk-author', name: 'Jordan Park' };

/** The control record body as proposed on the safety-record hazard. */
export const areaControlBody = {
  hazardId,
  controlType: pinnedType,
  parameters: {
    center: { latitude: 38.5848, longitude: -121.5045 },
    radiusMeters: 300,
    site: 'Riverside work site',
  },
  effectiveFrom: '2026-10-15T14:15:00Z',
  effectiveUntil: '2026-10-15T15:00:00Z',
} satisfies ControlBody;
/** The words the registered type gives these parameters. */
export const areaControlDescription =
  'Keep planned routes clear of the circle of 300 m around 38.5848, -121.5045 (Riverside work site), at all altitudes.';

/** Version 1 of the control record; its id is the version event a candidate cites. */
export const areaControlVersion = {
  id: 'fixture-riverside-avoidance-area-v1',
  versionNumber: 1,
  revision: 1,
  schema: 'sms.control.1',
  title: 'Riverside avoidance area',
  body: areaControlBody,
  bodyDigest: canonicalDigest(areaControlBody),
  owner: safetyLead,
  dueAt: null,
  links: [],
  recordedBy: safetyLead,
  recordedAt: '2026-10-15T14:13:30Z',
} satisfies SmsRecordVersion;

const hazardBody = {
  description: 'A fictional riverside work site lies near the delivery routes.',
  consequence: 'An aircraft could pass low over people working at the site.',
  source: { kind: 'manual' },
};
/** Version 1 of the hazard record the control is proposed on. */
export const areaControlHazardVersion = {
  ...areaControlVersion,
  id: 'fixture-site-hazard-v1',
  schema: 'sms.hazard.1',
  title: 'Work site near the delivery routes',
  body: hazardBody,
  bodyDigest: canonicalDigest(hazardBody),
  recordedAt: '2026-10-15T14:12:00Z',
} satisfies SmsRecordVersion;

const matrix = { recordId: 'fixture-risk-matrix', versionNumber: 1, bodyDigest: canonicalDigest({ matrix: 1 }) };
const assessmentOutcome = {
  matrix,
  initial: { severity: 'major', likelihood: 'occasional', level: 'high', acceptance: 'high' },
  controls: [
    {
      recordId: controlId,
      versionNumber: areaControlVersion.versionNumber,
      bodyDigest: areaControlVersion.bodyDigest,
      title: areaControlVersion.title,
      controlType: pinnedType,
      type: avoidanceAreaControlType.title,
      description: areaControlDescription,
      effectiveFrom: areaControlBody.effectiveFrom,
      effectiveUntil: areaControlBody.effectiveUntil,
    },
  ],
  residual: { severity: 'minor', likelihood: 'remote', level: 'low', acceptance: 'low' },
  newHazardCheck: { answer: 'none_identified' },
  assessedVersion: { versionNumber: 1, bodyDigest: areaControlHazardVersion.bodyDigest },
} satisfies SmsAssessmentOutcome;
/** The hazard's risk assessment listing the control. */
export const areaControlAssessment = {
  version: 'sms.decision.1',
  id: 'fixture-site-hazard-assessment',
  subjectId: hazardId,
  kind: 'risk.assess',
  note: 'Assessed with the avoidance area in place.',
  acceptedRevision: 3,
  acceptedBasisRevision: 2,
  outcome: assessmentOutcome,
  actor: {
    policyVersion: 'ledger.sms-decision-authority.1',
    principalId: safetyLead.id,
    name: safetyLead.name,
    kind: 'person',
    principalRevision: 1,
    capabilities: ['decision:write'],
    checkedCapabilities: ['decision:write'],
  },
  dependencyBasis: canonicalDigest({ fixtureBasis: 'assessment' }),
  recordedAt: '2026-10-15T14:13:45Z',
} satisfies SmsDecisionRecord;

const acceptanceOutcome = {
  assessmentId: areaControlAssessment.id,
  assessmentDigest: canonicalDigest(assessmentOutcome),
  matrix,
  level: 'low',
  acceptance: 'low',
} satisfies SmsAcceptanceOutcome;
/** What the accountable person signed when accepting the residual risk. */
export const areaControlSigningContent = {
  meaning: 'risk.accept',
  intent: 'I accept the residual risk of this hazard with the listed controls in place.',
  hazard: { id: hazardId, versionNumber: 1, bodyDigest: areaControlHazardVersion.bodyDigest },
  outcome: acceptanceOutcome,
};
/** The signed risk acceptance binding the control version. */
export const areaControlAcceptance = {
  ...areaControlAssessment,
  id: 'fixture-site-hazard-acceptance',
  kind: 'risk.accept',
  note: 'Residual risk accepted with the avoidance area in place.',
  acceptedRevision: 4,
  acceptedBasisRevision: 3,
  outcome: acceptanceOutcome,
  actor: {
    policyVersion: 'ledger.sms-decision-authority.1',
    principalId: executive.id,
    name: executive.name,
    kind: 'person',
    principalRevision: 2,
    capabilities: ['decision:write', 'risk:accept:high'],
    checkedCapabilities: ['decision:write', 'risk:accept:high'],
    satisfyingCapability: 'risk:accept:high',
  },
  dependencyBasis: canonicalDigest({ fixtureBasis: 'acceptance' }),
  signature: {
    id: 'fixture-site-hazard-acceptance-signature',
    contentDigest: canonicalDigest(areaControlSigningContent),
  },
  recordedAt: '2026-10-15T14:14:00Z',
} satisfies SmsDecisionRecord;

/** How a reader cites a decision: by its signed content digest, or an assessment by its outcome digest. */
export function decisionCitation(record: SmsDecisionRecord) {
  return {
    id: record.id,
    acceptedRevision: record.acceptedRevision,
    digest: record.signature?.contentDigest ?? canonicalDigest(record.outcome),
  };
}

/** What route review read the candidate against: the current assessment and acceptance and the control's version. */
export const areaControlContext = {
  version: 'mission.avoidance-control-record-context.1',
  assessment: decisionCitation(areaControlAssessment),
  hazard: { id: hazardId, latestAcceptanceId: areaControlAcceptance.id },
  control: { recordId: controlId, versionNumber: areaControlVersion.versionNumber, status: 'open' },
} satisfies MissionReleaseControlRecordContext;

/** The acceptance-time authority a candidate retains. */
export const areaControlAuthority = {
  policyVersion: 'ledger.sms-decision-authority.1',
  principalId: areaControlAcceptance.actor.principalId,
  principalRevision: areaControlAcceptance.actor.principalRevision,
  satisfyingCapability: 'risk:accept:high',
} as const;

/** The accepted control record as one route review candidate. */
export function areaControlCandidate(
  geometry: MissionAvoidanceCandidate['geometry'],
  control: {
    controlId: string;
    version: { id: string; versionNumber: number; bodyDigest: string; body: ControlBody };
    context: MissionReleaseControlRecordContext;
  } = { controlId, version: areaControlVersion, context: areaControlContext },
): MissionAvoidanceCandidate {
  const { version, context } = control;
  return {
    hazardId,
    controlId: control.controlId,
    controlVersion: version.versionNumber,
    controlEventId: version.id,
    controlDigest: version.bodyDigest,
    template: version.body.controlType,
    acceptance: decisionCitation(areaControlAcceptance),
    assessment: decisionCitation(areaControlAssessment),
    authority: areaControlAuthority,
    interval: { start: version.body.effectiveFrom, end: version.body.effectiveUntil! },
    geometry,
    context: 'current',
    safetyContextDigest: canonicalDigest(context),
    reasons: [],
  };
}

/** The applicability rule the area type declares, pinned by digest (area-reach-rule.ts). */
export const areaReachRule = {
  id: 'ledger.control-applicability.area-reach',
  version: 1,
  digest: '4667a798dbaac5e9e22960c29b909906616a56b1ac1f12fdd7214633147d9f62',
} as const;

/**
 * What route review records about whether a candidate applies to one mission revision. The fixture controls declare no
 * reach, so they apply to every flight in their interval; one whose hazard was assessed again applies until a person
 * signs again.
 */
export function areaControlApplicability(
  candidate: MissionAvoidanceCandidate,
  mission: MissionAvoidanceMissionReference,
): { applicability: ControlApplicabilityRecord & { outcome: 'applies' }; applicabilityDigest: string } {
  const underReview = candidate.context !== 'current';
  const applicability: ControlApplicabilityRecord & { outcome: 'applies' } = {
    version: 'control.applicability.1',
    outcome: 'applies',
    basis: underReview ? 'under_review' : 'undetermined',
    rule: { ...areaReachRule },
    inputs: {
      mission,
      control: {
        controlId: candidate.controlId,
        versionNumber: candidate.controlVersion,
        controlEventId: candidate.controlEventId,
        bodyDigest: candidate.controlDigest,
      },
      controlType: { ...candidate.template },
    },
    measured: [],
    declared: [],
    summary: underReview
      ? 'The hazard assessment has changed since this control was accepted, so it applies until a person signs again.'
      : 'This control declares no reach, so it applies to every flight in its interval.',
    reasons: underReview ? ['review_required'] : ['no_reach_declared'],
  };
  return { applicability, applicabilityDigest: canonicalDigest(applicability) };
}

/** The control as a briefing carries it, in the words its registered type gives it. */
export const areaControlBriefingContent = {
  controlType: avoidanceAreaControlType,
  title: areaControlVersion.title,
  description: areaControlDescription,
  parameters: areaControlBody.parameters,
  area: areaControlBody.parameters,
  effectiveFrom: areaControlBody.effectiveFrom,
  effectiveUntil: areaControlBody.effectiveUntil,
} satisfies MissionBriefingControlRecordContent;
