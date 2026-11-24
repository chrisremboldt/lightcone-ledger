import { canonicalDigest } from '../../../../integrity/src/index.js';
import type {
  MissionAvoidanceCalculation,
  MissionAvoidanceCandidate,
  MissionAvoidancePreview,
  MissionAvoidanceResponse,
  MissionAvoidanceReviewedCandidate,
} from '../../../src/index.js';
import {
  areaControlApplicability,
  areaControlCandidate,
  areaControlContext,
  areaControlVersion,
} from './area-control.js';
import { missionCurrentRead, missionRevision2Record } from './missions.js';

export const missionAvoidanceCalculation = {
  id: 'ledger.demo.mission-site-avoidance',
  version: 1,
  digest: '7ef485fc10cbdaedab3195b727bc6ef45aebb74e9090132910376fa2bd998308',
  profile: 'ledger.local-mission-avoidance.1',
  geometry: 'ledger.wgs84-conservative-bounds.1',
  distanceBudget: 100000,
} satisfies MissionAvoidanceCalculation;

export const missionAvoidanceMission = {
  missionId: missionRevision2Record.missionId,
  sourceRevision: missionRevision2Record.sourceRevision,
  eventId: missionRevision2Record.id,
  contentDigest: missionRevision2Record.contentDigest,
  recordDigest: canonicalDigest(missionRevision2Record),
};

const evaluatedAt = '2026-10-15T14:14:30Z';
const outsideCandidate = areaControlCandidate('outside');
/** Another accepted area control record on the same hazard, whose area covers the start of the planned route. */
const intersectingControlId = 'fixture-route-start-avoidance-area';
const intersectingBody = {
  ...areaControlVersion.body,
  parameters: { center: { longitude: -87.63, latitude: 41.88 }, radiusMeters: 300 },
};
export const missionAvoidanceIntersectingVersion = {
  ...areaControlVersion,
  id: 'fixture-route-start-avoidance-area-v1',
  title: 'Route start avoidance area',
  body: intersectingBody,
  bodyDigest: canonicalDigest(intersectingBody),
};
const intersectingCandidate = areaControlCandidate('intersects', {
  controlId: intersectingControlId,
  version: missionAvoidanceIntersectingVersion,
  context: { ...areaControlContext, control: { ...areaControlContext.control, recordId: intersectingControlId } },
});

/** A candidate as route review lists it, with its applicability record for the reviewed mission. */
export function reviewedCandidate(candidate: MissionAvoidanceCandidate): MissionAvoidanceReviewedCandidate {
  return { ...candidate, ...areaControlApplicability(candidate, missionAvoidanceMission) };
}
/** The area control types route review considers. */
export const missionAvoidanceConsideredTypes = [
  { id: areaControlVersion.body.controlType.id, version: 1, digest: areaControlVersion.body.controlType.digest },
];

function response(
  status: MissionAvoidancePreview['status'],
  shown: MissionAvoidanceCandidate[],
  overrides: Partial<Omit<MissionAvoidancePreview, 'previewDigest' | 'contextDigest'>> = {},
): MissionAvoidanceResponse {
  const candidates = shown.map(reviewedCandidate);
  const context = {
    version: 'flight.mission-avoidance.1',
    evaluatedAt,
    status,
    mission: missionAvoidanceMission,
    candidates,
    notApplicable: [],
    consideredTypes: missionAvoidanceConsideredTypes,
    candidateCompleteness: {
      status: 'complete',
      count: candidates.length,
      limit: 64,
      considered: candidates.length,
      consideredLimit: 512,
    },
    calculation: missionAvoidanceCalculation,
    reasons: [],
    ...overrides,
  } satisfies Omit<MissionAvoidancePreview, 'previewDigest' | 'contextDigest'>;
  const preview = {
    ...context,
    contextDigest:
      context.mission && context.candidateCompleteness.status === 'complete'
        ? canonicalDigest({
            version: 'mission.avoidance-context.1',
            mission: context.mission,
            calculation: {
              id: context.calculation.id,
              version: context.calculation.version,
              digest: context.calculation.digest,
            },
            candidates: context.candidates,
            notApplicable: context.notApplicable,
            consideredTypes: context.consideredTypes,
            candidateCompleteness: context.candidateCompleteness,
          })
        : null,
  };
  return {
    ...preview,
    previewDigest: canonicalDigest(preview),
    meta: {
      ...missionCurrentRead.meta,
      requestId: 'mission-avoidance-preview',
      computedAt: evaluatedAt,
      outstandingWork: 0,
    },
  };
}

export const missionAvoidanceOutside = response('outside', [outsideCandidate]);
export const missionAvoidanceIntersects = response('intersects', [intersectingCandidate]);
/** The hazard was assessed again after the acceptance: the candidate asks for review. */
const reassessedContext = {
  ...areaControlContext,
  assessment: { id: 'fixture-site-hazard-reassessment', acceptedRevision: 5, digest: 'f'.repeat(64) },
};
export const missionAvoidanceReviewRequired = response(
  'insufficient',
  [
    {
      ...outsideCandidate,
      context: 'review_required',
      safetyContextDigest: canonicalDigest(reassessedContext),
      reasons: ['assessment_changed'],
    },
  ],
  { reasons: ['candidate_context_not_current'] },
);
export const missionAvoidanceIncomplete = response('insufficient', [outsideCandidate], {
  candidateCompleteness: { status: 'incomplete', count: 65, limit: 64, considered: 65, consideredLimit: 512 },
  reasons: ['candidate_limit_exceeded'],
});
export const missionAvoidanceUnavailable = response('insufficient', [], {
  mission: null,
  reasons: ['mission_unavailable'],
});
