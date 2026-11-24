import { missionBriefingControls, type MissionAvoidanceCandidate, type MissionBriefingRecord } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

/** A briefing selected for one release candidate, as departure progress names it. */
export interface BriefingSelection {
  controlEventId: string;
  briefing: { id: string };
}

/** Whether a briefing lists this exact candidate. A briefing covers exactly the controls it lists. */
export function briefingCovers(briefing: MissionBriefingRecord, candidate: MissionAvoidanceCandidate): boolean {
  return missionBriefingControls(briefing).some(
    ({ reference }) =>
      reference.controlEventId === candidate.controlEventId &&
      canonicalDigest(reference.acceptance) === canonicalDigest(candidate.acceptance),
  );
}

/**
 * The release candidates no selected briefing covers. One briefing may cover several candidates, and a candidate may
 * be covered by any briefing that lists it.
 */
export function uncoveredCandidates(
  candidates: readonly MissionAvoidanceCandidate[],
  selections: readonly BriefingSelection[],
  briefings: ReadonlyMap<string, MissionBriefingRecord>,
): MissionAvoidanceCandidate[] {
  return candidates.filter((candidate) => {
    const selection = selections.find((entry) => entry.controlEventId === candidate.controlEventId);
    const briefing = selection && briefings.get(selection.briefing.id);
    return !briefing || !briefingCovers(briefing, candidate);
  });
}
