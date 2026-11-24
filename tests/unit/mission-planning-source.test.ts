import { describe, expect, it } from 'vitest';
import type { MissionInput, MissionRoutePlanning, MissionReleaseRecord } from '../../packages/contracts/src/index.js';
import { missionAuthority, missionInput, missionSource } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { verifyMissionInputSource } from '../../packages/domain/src/missions.js';
import { verifyMissionReceipt } from '../../tools/verifier/mission.mjs';
import { missionReleaseRecord } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { assertMissionReleaseRecord } from '../../packages/domain/src/mission-release-integrity.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { areaControlApplicability } from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import { missionAvoidanceContextDigest } from '../../packages/domain/src/mission-avoidance-context.js';

const planning: MissionRoutePlanning = {
  version: 'mission.route-planning.1',
  requiredLocations: [
    { role: 'launch', position: missionSource.route.geometry.coordinates[0]! },
    { role: 'service', position: missionSource.route.geometry.coordinates[1]! },
    { role: 'return', position: missionSource.route.geometry.coordinates.at(-1)! },
  ],
  cruiseMetersPerSecond: 15,
  ascentMs: 20_000,
  serviceMs: 20_000,
  descentMs: 20_000,
  holdAllowanceMs: 0,
  handoffAllowanceMs: 30_000,
  marginMs: 10_000,
  customerInterval: missionSource.operatingInterval,
  resourceInterval: missionSource.operatingInterval,
};

describe('retained mission planning source', () => {
  it('binds optional planning to original bytes and verifies it through ordinary mission evidence', () => {
    const input: MissionInput = {
      ...missionInput,
      payload: { ...missionInput.payload, routePlanning: structuredClone(planning) },
    };
    const bytes = Buffer.from(JSON.stringify({ ...missionSource, routePlanning: planning }));
    const verified = verifyMissionInputSource(input, bytes);
    const original = { sha256: verified.sha256, byteLength: verified.byteLength };
    const envelope = {
      type: 'mission.revision',
      sourceId: input.sourceId,
      occurredAt: input.occurredAt,
      sourceSessionId: null,
      effectiveAt: null,
      artifactId: input.artifactId,
      principalId: missionAuthority.principalId,
      tenantId: missionAuthority.tenantId,
      payload: {
        ...input,
        flightId: input.subject.flightId,
        acceptedAuthority: missionAuthority,
        acceptance: {
          version: 'flight.mission.1',
          missionId: 'retained-mission',
          flightId: input.subject.flightId,
          sourceId: input.sourceId,
          ...input.payload,
          sourceRevision: input.sourceRevision,
          occurredAt: input.occurredAt,
          receiptId: 'retained-receipt',
          artifactId: input.artifactId,
          original,
          contentDigest: verified.contentDigest,
          authority: missionAuthority,
        },
      },
    };
    const artifacts = new Map([
      [input.artifactId, { contentType: 'application/json', bytesBase64: bytes.toString('base64') }],
    ]);
    expect(verifyMissionReceipt(envelope, { id: 'retained-receipt' }, artifacts, '$')).toMatchObject({
      missionId: 'retained-mission',
      sourceRevision: 1,
    });
    const changed = structuredClone(input);
    changed.payload.routePlanning!.cruiseMetersPerSecond = 20;
    expect(() => verifyMissionInputSource(changed, bytes)).toThrow();
    const missingService = structuredClone(input);
    missingService.payload.routePlanning!.requiredLocations[1]!.position = [0, 0];
    const invalidBytes = Buffer.from(
      JSON.stringify({ sourceRevision: input.sourceRevision, occurredAt: input.occurredAt, ...missingService.payload }),
    );
    expect(() => verifyMissionInputSource(missingService, invalidBytes)).toThrow();
  });

  it('retains planning in an exact release basis without dropping its required-stop validation', () => {
    const release: MissionReleaseRecord = structuredClone(missionReleaseRecord);
    const mission = release.basis.mission;
    const coordinates = mission.route.geometry.coordinates;
    mission.routePlanning = {
      ...structuredClone(planning),
      customerInterval: mission.operatingInterval,
      resourceInterval: mission.operatingInterval,
      requiredLocations: [
        { role: 'launch', position: coordinates[0]! },
        { role: 'service', position: coordinates[1]! },
        { role: 'return', position: coordinates.at(-1)! },
      ],
    };
    const recommit = () => {
      const { sourceRevision, occurredAt } = mission;
      const payload = {
        sourceMissionId: mission.sourceMissionId,
        aircraftId: mission.aircraftId,
        route: mission.route,
        lateralToleranceMeters: mission.lateralToleranceMeters,
        altitude: mission.altitude,
        operatingInterval: mission.operatingInterval,
        routePlanning: mission.routePlanning,
      };
      const verified = verifyMissionInputSource(
        {
          kind: 'mission.revision',
          sourceId: mission.sourceId,
          sourceRevision,
          occurredAt,
          subject: { flightId: mission.flightId },
          artifactId: mission.artifactId,
          fidelity: 'synthetic_contract',
          payload,
        },
        Buffer.from(JSON.stringify({ sourceRevision, occurredAt, ...payload })),
      );
      mission.original = { sha256: verified.sha256, byteLength: verified.byteLength };
      mission.contentDigest = verified.contentDigest;
      const avoidance = release.basis.avoidance;
      avoidance.mission = {
        missionId: mission.missionId,
        sourceRevision,
        eventId: mission.id,
        contentDigest: mission.contentDigest,
        recordDigest: canonicalDigest(mission),
      };
      // Each applicability record names the exact mission revision it was evaluated for.
      avoidance.candidates = avoidance.candidates.map((candidate) => ({
        ...candidate,
        ...areaControlApplicability(candidate, avoidance.mission),
      }));
      avoidance.contextDigest = missionAvoidanceContextDigest({
        mission: avoidance.mission,
        calculation: {
          id: avoidance.calculation.id,
          version: avoidance.calculation.version,
          digest: avoidance.calculation.digest,
        },
        candidates: avoidance.candidates,
        notApplicable: avoidance.notApplicable,
        consideredTypes: avoidance.consideredTypes,
        candidateCompleteness: avoidance.candidateCompleteness,
      });
      const { previewDigest: _digest, ...preview } = avoidance;
      avoidance.previewDigest = canonicalDigest(preview);
    };
    recommit();
    expect(() => assertMissionReleaseRecord(release)).not.toThrow();
    mission.routePlanning.requiredLocations[1]!.position = [0, 0];
    expect(() => assertMissionReleaseRecord(release)).toThrow();
  });
});
