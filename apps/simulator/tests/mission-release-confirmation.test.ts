import { describe, expect, it } from 'vitest';
import type { MissionReleaseRecordResponse, MissionReleaseValidityResponse } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  missionReleaseCommand,
  missionReleaseCommandResponse,
  missionReleaseRecordResponse,
  missionReleaseValidityChanged,
  missionReleaseValidityCurrent,
  missionReleaseValidityExpired,
  missionReleaseValidityPending,
  missionReleaseValidityScheduled,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import type { OracleReader } from '../src/attempt-oracle.js';
import { confirmMissionRelease, validateMissionReleaseAccepted } from '../src/mission-release-confirmation.js';
import { ReleasePending, type MissionReleasePlan } from '../src/mission-release-plan.js';
import { OracleReadError } from '../src/oracle-api.js';

const { kind: _kind, expectedPrincipalRevision: _revision, ...approved } = missionReleaseCommand;
const plan: MissionReleasePlan = {
  version: 2,
  apiUrl: 'https://ledger.invalid',
  tenantId: 'fixture-tenant',
  principalId: missionReleaseCommandResponse.command.actorId,
  ...approved,
};
const accepted = missionReleaseCommandResponse.command;
const action = { payload: JSON.stringify(missionReleaseCommand) };
const path = `/v1/flights/${encodeURIComponent(plan.flightId)}/mission-releases/${encodeURIComponent(accepted.id)}`;

function fixture() {
  const state = {
    record: structuredClone(missionReleaseRecordResponse) as unknown,
    validity: structuredClone(missionReleaseValidityCurrent) as unknown,
    recordError: undefined as Error | undefined,
    validityError: undefined as Error | undefined,
  };
  const calls: string[] = [];
  const api: OracleReader = {
    async json<T>(request: string): Promise<T> {
      calls.push(request);
      if (request === path) {
        if (state.recordError) throw state.recordError;
        return structuredClone(state.record) as T;
      }
      if (request === `${path}/validity`) {
        if (state.validityError) throw state.validityError;
        return structuredClone(state.validity) as T;
      }
      throw new Error('Unexpected confirmation request');
    },
    async bytes() {
      throw new Error('Confirmation must not download source artifacts');
    },
    usage: () => ({ requests: calls.length, bytes: 0 }),
  };
  return { state, calls, api };
}

function rehash(record: MissionReleaseRecordResponse) {
  record.digest = canonicalDigest(record.release);
  return record;
}

describe('exact mission release confirmation', () => {
  it('accepts only the original scoped command and retained payload', () => {
    expect(validateMissionReleaseAccepted(accepted, action, plan)).toEqual(accepted);
    for (const changed of [
      { ...accepted, actorId: 'another-author' },
      { ...accepted, flightId: 'another-flight' },
      { ...accepted, recordedAt: '2026-02-30T14:00:00Z' },
      { ...accepted, payload: { ...missionReleaseCommand, note: 'Changed note' } },
      { ...accepted, subject: { kind: 'flight', id: plan.flightId } },
    ])
      expect(() => validateMissionReleaseAccepted(changed, action, plan)).toThrow(ReleasePending);
    expect(() => validateMissionReleaseAccepted(accepted, { payload: '{' }, plan)).toThrow(ReleasePending);
  });

  it('keeps acceptance confirmed across every as-of validity state and independent processing metadata', async () => {
    for (const view of [
      missionReleaseValidityScheduled,
      missionReleaseValidityCurrent,
      missionReleaseValidityExpired,
      missionReleaseValidityChanged,
      missionReleaseValidityPending,
      {
        ...missionReleaseValidityCurrent,
        processing: 'pending',
        reasons: ['release_projection_pending'],
        nextBoundary: null,
      } satisfies MissionReleaseValidityResponse,
    ]) {
      const f = fixture();
      f.state.validity = view;
      const before = JSON.stringify({ plan, accepted, record: f.state.record, view });
      const result = await confirmMissionRelease(plan, accepted, f.api, 1);
      expect(result).toMatchObject({
        status: 'accepted',
        record: 'confirmed',
        eventId: accepted.id,
        flightId: plan.flightId,
        releaseDigest: missionReleaseRecordResponse.digest,
        attempts: 1,
        validity: view,
      });
      expect(f.calls).toEqual([path, `${path}/validity`]);
      expect(JSON.stringify({ plan, accepted, record: f.state.record, view })).toBe(before);
    }
    const f = fixture();
    const record = structuredClone(missionReleaseRecordResponse) as MissionReleaseRecordResponse;
    record.release.acceptedRevision = 2;
    record.release.basis.renderedInputCut.basisRevision = 99;
    record.release.basis.acceptedInputCut.basisRevision = 100;
    f.state.record = rehash(record);
    f.state.validity = {
      ...missionReleaseValidityCurrent,
      release: { id: accepted.id, digest: record.digest },
    };
    expect(await confirmMissionRelease(plan, accepted, f.api, 1)).toMatchObject({
      status: 'accepted',
      record: 'confirmed',
      releaseDigest: record.digest,
    });
  });

  it('rejects altered immutable identities, nested commitments and provenance even with a recomputed outer digest', async () => {
    const changes: Array<(record: MissionReleaseRecordResponse) => void> = [
      (record) => {
        record.digest = '0'.repeat(64);
      },
      (record) => {
        record.release.organizationId = 'organization:another-tenant';
      },
      (record) => {
        record.release.basis.mission.route.geometry.coordinates[0]![0] += 0.001;
      },
      (record) => {
        record.release.actor.principalRevision++;
      },
      (record) => {
        record.release.policy.instruction += ' Changed';
      },
      (record) => {
        record.release.basis.candidateContexts[0]!.context.acceptedC2Count = '999';
      },
      (record) => {
        record.release.basis.acceptedInputCut.streams['resolved-mission-stream'] = 999;
      },
    ];
    for (const [index, change] of changes.entries()) {
      const f = fixture();
      const record = structuredClone(missionReleaseRecordResponse) as MissionReleaseRecordResponse;
      change(record);
      f.state.record = index === 0 ? record : rehash(record);
      await expect(confirmMissionRelease(plan, accepted, f.api, 1)).rejects.toBeInstanceOf(ReleasePending);
      expect(f.calls).toEqual([path]);
    }
    const f = fixture();
    const record = structuredClone(missionReleaseRecordResponse) as MissionReleaseRecordResponse;
    const missionStart = record.release.basis.mission.operatingInterval.start;
    const avoidance = record.release.basis.avoidance;
    avoidance.candidates[0]!.interval = {
      start: new Date(Date.parse(missionStart) - 60_000).toISOString(),
      end: missionStart,
    };
    avoidance.contextDigest = canonicalDigest({
      version: 'mission.avoidance-context.1',
      mission: avoidance.mission,
      calculation: plan.calculation,
      candidates: avoidance.candidates,
      notApplicable: avoidance.notApplicable,
      consideredTypes: avoidance.consideredTypes,
      candidateCompleteness: avoidance.candidateCompleteness,
    });
    const { previewDigest: _previewDigest, ...preview } = avoidance;
    avoidance.previewDigest = canonicalDigest(preview);
    f.state.record = rehash(record);
    const changedPlan = { ...plan, expectedContextDigest: avoidance.contextDigest };
    const changedAccepted = {
      ...accepted,
      payload: { ...accepted.payload, expectedContextDigest: avoidance.contextDigest },
    };
    await expect(confirmMissionRelease(changedPlan, changedAccepted, f.api, 1)).rejects.toMatchObject({
      code: 'commitment_mismatch',
    });
    expect(f.calls).toEqual([path]);
  });

  it('retains record confirmation when validity is unavailable or contradictory and never substitutes a historical permission', async () => {
    const f = fixture();
    f.state.validityError = new OracleReadError('pending', 'read_timeout', 'Read timed out');
    expect(await confirmMissionRelease(plan, accepted, f.api, 1)).toMatchObject({
      status: 'accepted',
      record: 'confirmed',
      releaseDigest: missionReleaseRecordResponse.digest,
      code: 'read_timeout',
    });
    f.state.validityError = undefined;
    for (const view of [
      {
        ...missionReleaseValidityCurrent,
        release: { id: 'another-release', digest: missionReleaseRecordResponse.digest },
      },
      { ...missionReleaseValidityCurrent, evaluatedAt: missionReleaseValidityExpired.evaluatedAt },
      { ...missionReleaseValidityCurrent, evaluatedAt: missionReleaseValidityScheduled.evaluatedAt },
      { ...missionReleaseValidityPending, currentContextDigest: '0'.repeat(64) },
    ]) {
      f.state.validity = view;
      const result = await confirmMissionRelease(plan, accepted, f.api, 1);
      expect(result).toMatchObject({ status: 'accepted', record: 'confirmed', code: 'commitment_mismatch' });
      expect(result.validity).toBeUndefined();
    }
    f.state.recordError = new OracleReadError('pending', 'not_found', 'Record unavailable');
    await expect(confirmMissionRelease(plan, accepted, f.api, 1)).rejects.toMatchObject({ code: 'not_found' });
  });
});
