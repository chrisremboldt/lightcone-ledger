import { describe, expect, it } from 'vitest';
import type { SimulationAvoidanceDemoCycleResponse } from '../../packages/contracts/src/index.js';
import {
  areaControlAcceptance,
  areaControlHazardId,
  areaControlRecordId,
  areaControlVersion,
} from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import {
  simulationAvoidanceDemoCycle,
  simulationAvoidanceDemoProgress,
} from '../../packages/contracts/fixtures/demo/v1/simulation-avoidance-demo.js';
import {
  demoCanRepeat,
  demoControlReference,
  retainDemoProgress,
  validateDemoCycle,
} from '../../apps/web/src/avoidance-demo.js';
import { canonicalDigest } from '../../apps/web/src/safety.js';

const version = {
  hazardId: areaControlHazardId,
  controlId: areaControlRecordId,
  versionNumber: areaControlVersion.versionNumber,
  versionId: areaControlVersion.id,
  bodyDigest: areaControlVersion.bodyDigest,
};
const reference = demoControlReference(version, areaControlAcceptance);

async function recordedCycle(): Promise<SimulationAvoidanceDemoCycleResponse> {
  const cycle = { ...structuredClone(simulationAvoidanceDemoCycle), control: structuredClone(reference) };
  const { expectedRevision, ...reported } = simulationAvoidanceDemoProgress;
  const progress = {
    ...reported,
    id: 'demo-progress-one',
    cycleId: cycle.id,
    revision: expectedRevision + 1,
    actorId: cycle.source.principalId,
    recordedAt: '2026-10-18T15:01:00.000Z',
    references: {
      execution: {
        runId: 'world-one',
        reservationId: 'reservation-one',
        flightId: 'flight-one',
        aircraftId: 'aircraft-one',
        sourceMissionId: 'source-mission-one',
      },
    },
  };
  return {
    cycle,
    digest: await canonicalDigest(cycle),
    progress,
    progressDigest: await canonicalDigest(progress),
    processing: 'completed',
    readAt: '2026-10-18T15:01:10.000Z',
  };
}

describe('accepted-control demo presentation', () => {
  it('names the exact control record version and the signed risk acceptance that binds it', () => {
    expect(reference).toEqual({
      hazardId: areaControlHazardId,
      controlId: areaControlRecordId,
      controlVersion: areaControlVersion.versionNumber,
      controlEventId: areaControlVersion.id,
      controlDigest: areaControlVersion.bodyDigest,
      acceptance: {
        id: areaControlAcceptance.id,
        acceptedRevision: areaControlAcceptance.acceptedRevision,
        digest: areaControlAcceptance.signature.contentDigest,
      },
    });
  });

  it('does not manufacture a reference from an unsigned decision, another kind or another hazard', () => {
    const { signature, ...unsigned } = areaControlAcceptance;
    void signature;
    expect(() => demoControlReference(version, unsigned)).toThrow('signed risk acceptance');
    expect(() => demoControlReference(version, { ...areaControlAcceptance, kind: 'risk.assess' })).toThrow(
      'signed risk acceptance',
    );
    expect(() => demoControlReference(version, { ...areaControlAcceptance, subjectId: 'another-hazard' })).toThrow(
      'signed risk acceptance',
    );
  });

  it('matches exact accepted control, cycle, flight and retained progress before navigation', async () => {
    const result = await recordedCycle();
    await expect(
      validateDemoCycle(result, reference, { cycleId: result.cycle.id, flightId: 'flight-one' }),
    ).resolves.toBeUndefined();
    await expect(validateDemoCycle(result, reference, { flightId: 'another-flight' })).rejects.toThrow('progress');
    await expect(validateDemoCycle(result, reference, { cycleId: 'another-cycle' })).rejects.toThrow(
      'accepted control',
    );
    const transplanted = structuredClone(result);
    transplanted.cycle.control.acceptance.id = 'another-acceptance';
    transplanted.digest = await canonicalDigest(transplanted.cycle);
    await expect(validateDemoCycle(transplanted, reference)).rejects.toThrow('accepted control');
    const newerVersion = structuredClone(result);
    newerVersion.cycle.control.controlEventId = 'newer-control-version';
    newerVersion.digest = await canonicalDigest(newerVersion.cycle);
    await expect(validateDemoCycle(newerVersion, reference)).rejects.toThrow('accepted control');
    const changedProgress = structuredClone(result);
    changedProgress.progress!.references.execution!.flightId = 'another-flight';
    await expect(validateDemoCycle(changedProgress, reference)).rejects.toThrow('progress');
  });

  it('retains newer progress and permits another flight only after a recorded terminal cycle', async () => {
    const earlier = await recordedCycle();
    const completed = structuredClone(earlier);
    completed.progress!.revision = 7;
    completed.progress!.phase = 'monitoring_available';
    completed.readAt = '2026-10-18T15:20:00.000Z';
    const delayed = { ...earlier, readAt: '2026-10-18T15:21:00.000Z' };
    expect(retainDemoProgress(completed, delayed)).toBe(completed);
    expect(demoCanRepeat(completed)).toBe(true);
    for (const phase of ['blocked', 'departure_unknown', 'airborne', 'monitoring'] as const) {
      expect(demoCanRepeat({ ...completed, progress: { ...completed.progress!, phase } })).toBe(false);
    }
    expect(demoCanRepeat({ ...completed, progress: { ...completed.progress!, phase: 'abandoned' } })).toBe(true);
  });
});
