import { describe, expect, test } from 'vitest';
import type { MissionReleaseRecord } from '../../packages/contracts/src/index.js';
import { missionReleaseRecord } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { areaReachRule } from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { missionAvoidanceContextDigest } from '../../packages/domain/src/index.js';
import { assertMissionReleaseRecord } from '../../packages/domain/src/mission-release-integrity.js';
import { verifyMissionReleaseEvent } from '../../tools/verifier/mission-release.mjs';

/** The fixture release with its one candidate recorded instead as a control that does not apply. */
function notApplying(change: (record: MissionReleaseRecord) => void = () => undefined): MissionReleaseRecord {
  const record = structuredClone(missionReleaseRecord) as MissionReleaseRecord;
  const avoidance = record.basis.avoidance;
  const { geometry: _geometry, ...candidate } = avoidance.candidates[0]!;
  const applicability = {
    ...candidate.applicability,
    outcome: 'does_not_apply' as const,
    basis: 'rule' as const,
    rule: { ...areaReachRule },
    measured: [{ name: 'clearanceAtLeastMeters', value: 19400, unit: 'm' }],
    declared: [
      { name: 'appliesWithinMeters', value: 500, unit: 'm' },
      { name: 'radiusMeters', value: 300, unit: 'm' },
    ],
    summary: 'The planned corridor stays at least 19 400 m from the area; the control applies within 500 m.',
    reasons: [],
  };
  avoidance.notApplicable = [
    {
      ...candidate,
      title: 'Fictional quarry blasting',
      area: { center: { latitude: 40.2, longitude: -105 }, radiusMeters: 300 },
      applicability,
      applicabilityDigest: canonicalDigest(applicability),
    },
  ];
  avoidance.candidates = [];
  record.basis.notApplicableContexts = record.basis.candidateContexts;
  record.basis.candidateContexts = [];
  avoidance.candidateCompleteness = { ...avoidance.candidateCompleteness, count: 0, considered: 1 };
  // The verifier reads each listed finding's evaluation from its inventory; this one lists none.
  const findings = { ...record.basis.findings, findings: [] };
  record.basis.findings = {
    ...findings,
    digest: canonicalDigest({ version: findings.version, subjects: findings.subjects, findings: findings.findings }),
  };
  change(record);
  const { id, version, digest } = avoidance.calculation;
  avoidance.contextDigest = missionAvoidanceContextDigest({ ...avoidance, calculation: { id, version, digest } });
  const { previewDigest: _previewDigest, ...preview } = avoidance;
  avoidance.previewDigest = canonicalDigest(preview);
  return record;
}

const verify = (record: MissionReleaseRecord) => {
  const { id: _id, recordedAt, acceptedRevision: _revision, ...acceptance } = record;
  const command = {
    kind: 'mission.release',
    flightId: record.flightId,
    aircraftId: record.aircraftId,
    mission: record.basis.avoidance.mission,
    calculation: {
      id: record.basis.avoidance.calculation.id,
      version: record.basis.avoidance.calculation.version,
      digest: record.basis.avoidance.calculation.digest,
    },
    policy: { id: record.policy.id, version: record.policy.version, digest: record.policy.digest },
    expectedContextDigest: record.basis.avoidance.contextDigest,
    expectedFindingsDigest: record.basis.findings.digest,
    expectedPrincipalRevision: record.actor.principalRevision,
    departureWindow: record.departureWindow,
    note: record.note,
  };
  const envelope = {
    streamId: 'stream',
    principalId: record.actor.id,
    receivedAt: recordedAt,
    payload: { ...command, acceptance, declaredSubjects: [record.flightId] },
  };
  return verifyMissionReleaseEvent(
    { envelope, path: '$.entries[0]' },
    new Map(),
    new Map([['stream', { stream: { name: `flight:${record.flightId}` } }]]),
    record.organizationId.slice('organization:'.length),
  );
};

describe('a release records each considered control that does not apply', () => {
  test('its applicability record is checked by the application and by the verifier', () => {
    const record = notApplying();
    expect(() => assertMissionReleaseRecord(record)).not.toThrow();
    expect(verify(record)).toEqual({ findings: 0 });
    const unplaced = notApplying((changed) => {
      changed.basis.avoidance.notApplicable[0]!.area = null;
    });
    expect(() => assertMissionReleaseRecord(unplaced)).not.toThrow();
    expect(verify(unplaced)).toEqual({ findings: 0 });
  });

  test('a record for another mission, an unpinned rule, a changed digest, no title or a malformed area is refused by both', () => {
    const cases: ((record: MissionReleaseRecord) => void)[] = [
      (record) => {
        const entry = record.basis.avoidance.notApplicable[0]!;
        entry.applicability.inputs.mission = { ...entry.applicability.inputs.mission!, sourceRevision: 9 };
        entry.applicabilityDigest = canonicalDigest(entry.applicability);
      },
      (record) => {
        const entry = record.basis.avoidance.notApplicable[0]!;
        entry.applicability.rule = { ...areaReachRule, digest: 'f'.repeat(64) };
        entry.applicabilityDigest = canonicalDigest(entry.applicability);
      },
      (record) => {
        record.basis.avoidance.notApplicable[0]!.applicabilityDigest = 'e'.repeat(64);
      },
      (record) => {
        const entry = record.basis.avoidance.notApplicable[0]!;
        entry.applicability.inputs.control = { ...entry.applicability.inputs.control, versionNumber: 7 };
        entry.applicabilityDigest = canonicalDigest(entry.applicability);
      },
      (record) => {
        record.basis.avoidance.candidateCompleteness.considered = 2;
      },
      (record) => {
        const entry = record.basis.avoidance.notApplicable[0]! as { title?: string };
        delete entry.title;
      },
      (record) => {
        record.basis.avoidance.notApplicable[0]!.title = '';
      },
      (record) => {
        record.basis.avoidance.notApplicable[0]!.area = {
          center: { latitude: 95, longitude: -105 },
          radiusMeters: 300,
        };
      },
      (record) => {
        record.basis.avoidance.notApplicable[0]!.area = { center: { latitude: 40, longitude: -105 }, radiusMeters: 0 };
      },
      (record) => {
        const area = { center: { latitude: 40, longitude: -105 }, radiusMeters: 300, reachMeters: 500 };
        (record.basis.avoidance.notApplicable[0] as { area: unknown }).area = area;
      },
    ];
    for (const change of cases) {
      const record = notApplying(change);
      expect(() => assertMissionReleaseRecord(record)).toThrow();
      expect(() => verify(record)).toThrow();
    }
  });
});
