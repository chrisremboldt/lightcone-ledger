import type { MissionRouteSuggestionRequest, MissionRouteSuggestionResponse } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { responseMeta } from './index.js';
import { getMissionAvoidanceSnapshot } from './mission-avoidance.js';
import { suggestMissionRoute } from './mission-route-planner.js';

export async function getMissionRouteSuggestion(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  request: MissionRouteSuggestionRequest,
): Promise<MissionRouteSuggestionResponse> {
  const snapshot = await getMissionAvoidanceSnapshot(client, principal, flightId, true);
  // A detour keeps clear of every considered area: a control that does not apply to this route may apply to a new one.
  const { preview, mission, consideredCircles } = snapshot;
  if (
    !preview.mission ||
    !preview.contextDigest ||
    canonicalDigest(request.expectedMission) !== canonicalDigest(preview.mission) ||
    request.expectedContextDigest !== preview.contextDigest
  )
    throw new DomainError(
      409,
      'route_suggestion_context_changed',
      'The mission or accepted-control context changed. Refresh before requesting a detour.',
    );
  const complete =
    mission &&
    preview.candidateCompleteness.status === 'complete' &&
    consideredCircles.length === preview.candidates.length + preview.notApplicable.length &&
    !preview.reasons.length &&
    preview.candidates.every((candidate) => candidate.context === 'current');
  const search = complete
    ? suggestMissionRoute(mission, consideredCircles, request.clearanceMeters, preview.evaluatedAt)
    : {
        status: 'unsupported' as const,
        proposedRoute: null,
        distance: null,
        timeFit: {
          status: 'unsupported' as const,
          model: 'held-polyline.1' as const,
          reasons: ['avoidance_context_incomplete'],
        },
        reasons: [
          ...new Set([
            'avoidance_context_incomplete',
            ...preview.reasons,
            ...preview.candidates.flatMap((candidate) => candidate.reasons),
          ]),
        ].slice(0, 32),
      };
  return {
    version: 'flight.mission-route-suggestion.1',
    evaluatedAt: preview.evaluatedAt,
    mission: preview.mission,
    contextDigest: preview.contextDigest,
    clearanceMeters: request.clearanceMeters,
    candidates: preview.candidates,
    avoids: 'every_considered_area',
    consideredAreas: consideredCircles.length,
    originalRoute: mission?.route ?? null,
    ...search,
    meta: await responseMeta(client, '', principal, undefined, flightId),
  };
}
