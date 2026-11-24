import type { MissionAvoidanceMissionReference, MissionAvoidancePreview } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

/** The digest a release pins: everything the review compared, without the clock. */
export function missionAvoidanceContextDigest(
  context: Pick<
    MissionAvoidancePreview,
    'candidates' | 'notApplicable' | 'consideredTypes' | 'candidateCompleteness'
  > & {
    mission: MissionAvoidanceMissionReference;
    calculation: { id: string; version: number; digest: string };
  },
): string {
  return canonicalDigest({
    version: 'mission.avoidance-context.1',
    mission: context.mission,
    calculation: context.calculation,
    candidates: context.candidates,
    notApplicable: context.notApplicable,
    consideredTypes: context.consideredTypes,
    candidateCompleteness: context.candidateCompleteness,
  });
}
