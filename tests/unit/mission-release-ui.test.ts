import { expect, test } from 'vitest';
import { missionCurrentRead } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import {
  missionReleaseAvoidance,
  missionReleaseCommand,
  missionReleaseFindingsResponse,
  missionReleasePolicy,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  buildMissionReleaseCommand,
  findingChanges,
  RELEASE_POLICY,
  releaseBasis,
  releaseReadiness,
  type MissionReview,
} from '../../apps/web/src/missionRelease.js';

function review(): MissionReview {
  const mission = structuredClone(missionCurrentRead);
  return {
    flight: {
      id: mission.acceptedHead.record.flightId,
      label: 'Reviewed flight',
      originationKey: 'mission-release-fixture',
      revision: 1,
      basisRevision: 1,
      activity: 'planned',
      coverage: 'recorded',
      aircraft: mission.acceptedHead.record.aircraftId,
      orderIds: [],
      sourceIds: [],
      unresolvedCount: 0,
      conflictCount: 0,
      outstandingWork: 0,
    },
    mission,
    preview: { ...structuredClone(missionReleaseAvoidance), meta: structuredClone(mission.meta) },
    findings: structuredClone(missionReleaseFindingsResponse),
  };
}

test('release commands pin the exact reviewed mission, comparison and immutable policy', () => {
  const shown = review();
  expect(RELEASE_POLICY).toEqual(missionReleasePolicy);
  expect(
    buildMissionReleaseCommand(
      shown,
      missionReleaseCommand.expectedPrincipalRevision,
      missionReleaseCommand.departureWindow,
      missionReleaseCommand.note,
    ),
  ).toEqual(missionReleaseCommand);
  shown.preview.candidateCompleteness = { ...shown.preview.candidateCompleteness, status: 'incomplete', count: 65 };
  shown.preview.reasons = ['candidate_limit_exceeded'];
  expect(releaseReadiness(shown)).toContain(
    'More than 64 accepted controls apply to this mission. Review the overlapping controls before release.',
  );
  expect(() => buildMissionReleaseCommand(shown, 3, missionReleaseCommand.departureWindow, 'Review')).toThrow();
});

test('release draft identity ignores telemetry and read clocks but changes with safety or aircraft context', () => {
  const shown = review();
  const later = structuredClone(shown);
  later.flight.revision += 10;
  later.flight.basisRevision += 10;
  later.preview.evaluatedAt = '2026-10-15T14:15:00Z';
  later.preview.previewDigest = 'f'.repeat(64);
  later.preview.meta.computedAt = later.preview.evaluatedAt;
  later.preview.meta.inputCut.basisRevision = 99;
  later.mission.meta.computedAt = later.preview.evaluatedAt;
  expect(releaseBasis(later)).toBe(releaseBasis(shown));
  later.preview.contextDigest = 'e'.repeat(64);
  expect(releaseBasis(later)).not.toBe(releaseBasis(shown));
  later.preview.contextDigest = shown.preview.contextDigest;
  later.flight.aircraft = 'different-aircraft';
  expect(releaseBasis(later)).not.toBe(releaseBasis(shown));
});

test('the release pins the listed open findings, and a changed list changes the draft and shows what changed', () => {
  const shown = review();
  const later = structuredClone(shown);
  later.findings!.proposed = [];
  later.findings!.readAt = '2026-10-15T14:20:00Z';
  expect(releaseBasis(later)).toBe(releaseBasis(shown));
  const [listed] = shown.findings!.basis.findings;
  const changed = { ...listed!, status: 'acknowledged' as const };
  later.findings!.basis = { ...later.findings!.basis, findings: [changed], digest: 'd'.repeat(64) };
  expect(releaseBasis(later)).not.toBe(releaseBasis(shown));
  expect(findingChanges(shown.findings!.basis.findings, later.findings!.basis.findings)).toEqual({
    added: [],
    removed: [],
    changed: [changed],
  });
  expect(findingChanges(shown.findings!.basis.findings, [])).toEqual({ added: [], removed: [listed], changed: [] });
  later.findings = null;
  expect(releaseReadiness(later)).toContain(
    'The open findings for this flight could not be read. Refresh the mission review before release.',
  );
  expect(() =>
    buildMissionReleaseCommand(later, 3, missionReleaseCommand.departureWindow, missionReleaseCommand.note),
  ).toThrow();
});
