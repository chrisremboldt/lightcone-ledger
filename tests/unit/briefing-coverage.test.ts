import { describe, expect, it } from 'vitest';
import type { MissionAvoidanceCandidate, MissionBriefingRecord } from '@ledger/contracts';
import { missionBriefingRecord } from '../../packages/contracts/fixtures/demo/v1/mission-briefing.js';
import { missionReleaseRecord } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { briefingCovers, uncoveredCandidates } from '../../packages/domain/src/briefing-coverage.js';
import { briefingControlReference } from '../../packages/domain/src/mission-briefing-integrity.js';

// Three accepted area controls a release names as candidates; the fixture names one, the others are its copies.
const [first] = missionReleaseRecord.basis.avoidance.candidates;
const candidates: MissionAvoidanceCandidate[] = ['a', 'b', 'c'].map((suffix) => ({
  ...first!,
  controlEventId: `${first!.controlEventId}-${suffix}`,
}));
const content = missionBriefingRecord.content.controls[0]!;

/** A briefing listing these candidates. */
function listing(id: string, listed: MissionAvoidanceCandidate[]): MissionBriefingRecord {
  return {
    ...missionBriefingRecord,
    id,
    context: { ...missionBriefingRecord.context, controls: listed.map(briefingControlReference) },
    content: { ...missionBriefingRecord.content, controls: listed.map(() => content) },
  };
}
const select = (pairs: [MissionAvoidanceCandidate, MissionBriefingRecord][]) =>
  pairs.map(([candidate, briefing]) => ({ controlEventId: candidate.controlEventId, briefing: { id: briefing.id } }));
const byId = (...briefings: MissionBriefingRecord[]) => new Map(briefings.map((briefing) => [briefing.id, briefing]));

describe('briefing coverage of release candidates', () => {
  it('lets one briefing cover every candidate it lists', () => {
    const all = listing('briefing-all', candidates);
    expect(candidates.every((candidate) => briefingCovers(all, candidate))).toBe(true);
    expect(uncoveredCandidates(candidates, select(candidates.map((candidate) => [candidate, all])), byId(all))).toEqual(
      [],
    );
  });

  it('covers a candidate by any one briefing that lists it', () => {
    const older = listing('briefing-older', [candidates[0]!]);
    const newer = listing('briefing-newer', candidates.slice(1));
    const selections = select([
      [candidates[0]!, older],
      [candidates[1]!, newer],
      [candidates[2]!, newer],
    ]);
    expect(uncoveredCandidates(candidates, selections, byId(older, newer))).toEqual([]);
  });

  it('covers exactly the controls a briefing lists', () => {
    const two = listing('briefing-two', candidates.slice(0, 2));
    expect(briefingCovers(two, candidates[2]!)).toBe(false);
    // Naming the briefing for a control it does not list leaves that control uncovered.
    const selections = select(candidates.map((candidate) => [candidate, two]));
    expect(uncoveredCandidates(candidates, selections, byId(two))).toEqual([candidates[2]]);
    // So does selecting no briefing for it.
    expect(uncoveredCandidates(candidates, selections.slice(0, 2), byId(two))).toEqual([candidates[2]]);
    // And a briefing of another acceptance of the same control version.
    const reaccepted = { ...candidates[0]!, acceptance: { ...candidates[0]!.acceptance, acceptedRevision: 99 } };
    expect(briefingCovers(two, reaccepted)).toBe(false);
  });
});
