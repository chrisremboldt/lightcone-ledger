import { expect, test } from 'vitest';
import {
  missionReleasePolicy,
  missionReleaseRecord,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import type { MissionReleaseRecord } from '../../packages/contracts/src/index.js';
import { assertMissionReleaseRecord } from '../../packages/domain/src/mission-release-integrity.js';
import {
  missionReleasePolicy as currentPolicy,
  registeredMissionReleasePolicy,
} from '../../packages/domain/src/mission-release-policy.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';

test('a release is checked against the one registered policy', () => {
  expect(registeredMissionReleasePolicy(2)?.digest).toBe(missionReleasePolicy.digest);
  expect(currentPolicy.digest).toBe(missionReleasePolicy.digest);
  for (const version of [1, 3, '2']) expect(registeredMissionReleasePolicy(version)).toBeUndefined();
  const { digest, ...definition } = currentPolicy;
  expect(canonicalDigest(definition)).toBe(digest);
  expect(() => assertMissionReleaseRecord(missionReleaseRecord)).not.toThrow();
});

test('a release keeps its version, policy and findings section together', () => {
  const superseded = {
    ...missionReleaseRecord,
    version: 'flight.mission-release.1',
  } as unknown as MissionReleaseRecord;
  expect(() => assertMissionReleaseRecord(superseded)).toThrow();
  const otherPolicy = {
    ...missionReleaseRecord,
    policy: { ...missionReleaseRecord.policy, version: 1 },
  } as unknown as MissionReleaseRecord;
  expect(() => assertMissionReleaseRecord(otherPolicy)).toThrow();
  const { findings: _findings, ...withoutFindings } = missionReleaseRecord.basis;
  const unlisted = { ...missionReleaseRecord, basis: withoutFindings } as unknown as MissionReleaseRecord;
  expect(() => assertMissionReleaseRecord(unlisted)).toThrow();
});

test('a findings section must reproduce its digest, order and finding identities', () => {
  const findings = missionReleaseRecord.basis.findings;
  const record = (section: unknown) =>
    ({ ...missionReleaseRecord, basis: { ...missionReleaseRecord.basis, findings: section } }) as MissionReleaseRecord;
  expect(() => assertMissionReleaseRecord(record({ ...findings, digest: 'e'.repeat(64) }))).toThrow();
  const renamed = findings.findings.map((finding) => ({ ...finding, id: 'finding:another' }));
  const { digest: _digest, ...body } = { ...findings, findings: renamed };
  expect(() => assertMissionReleaseRecord(record({ ...body, digest: canonicalDigest(body) }))).toThrow();
  const reversed = { ...findings, subjects: [...findings.subjects].reverse() };
  const { digest: _reversed, ...unordered } = reversed;
  expect(() => assertMissionReleaseRecord(record({ ...unordered, digest: canonicalDigest(unordered) }))).toThrow();
  const withoutFlight = { ...findings, subjects: findings.subjects.filter((entry) => entry.reason !== 'flight') };
  const { digest: _flight, ...unread } = withoutFlight;
  expect(() => assertMissionReleaseRecord(record({ ...unread, digest: canonicalDigest(unread) }))).toThrow();
});
