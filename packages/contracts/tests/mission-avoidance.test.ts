import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../../integrity/src/index.js';
import { LedgerClient } from '../src/client.js';
import { FlightMissionAvoidanceParamsSchema } from '../src/index.js';
import { MissionAvoidanceResponseSchema } from '../src/openapi.js';
import {
  missionAvoidanceIncomplete,
  missionAvoidanceIntersects,
  missionAvoidanceOutside,
  missionAvoidanceReviewRequired,
  missionAvoidanceUnavailable,
} from '../fixtures/demo/v1/mission-avoidance.js';
import {
  areaControlAcceptance,
  areaControlAssessment,
  areaControlBody,
  areaControlContext,
  areaControlDescription,
  areaControlVersion,
  avoidanceAreaControlType,
} from '../fixtures/demo/v1/area-control.js';
import { avoidanceAreaControlType as registeredAreaType } from '../../domain/src/control-type-library.js';
import { controlTypeDigest, describeControl } from '../../domain/src/control-types.js';
import { missionRevision2Record } from '../fixtures/demo/v1/missions.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('bounded mission avoidance preview handoff', () => {
  it('retains exact mission and accepted-control references while separating geometry, stale context and incomplete selection', () => {
    const validate = ajv.compile(MissionAvoidanceResponseSchema);
    for (const shown of [
      missionAvoidanceOutside,
      missionAvoidanceIntersects,
      missionAvoidanceReviewRequired,
      missionAvoidanceIncomplete,
      missionAvoidanceUnavailable,
    ]) {
      expect(validate(shown), JSON.stringify(validate.errors)).toBe(true);
      const { previewDigest, meta: _meta, ...preview } = shown;
      expect(previewDigest).toBe(canonicalDigest(preview));
      if (shown.contextDigest)
        expect(shown.contextDigest).toBe(
          canonicalDigest({
            version: 'mission.avoidance-context.1',
            mission: shown.mission,
            calculation: {
              id: shown.calculation.id,
              version: shown.calculation.version,
              digest: shown.calculation.digest,
            },
            candidates: shown.candidates,
            notApplicable: shown.notApplicable,
            consideredTypes: shown.consideredTypes,
            candidateCompleteness: shown.candidateCompleteness,
          }),
        );
    }
    expect(missionAvoidanceOutside.mission).toEqual({
      missionId: missionRevision2Record.missionId,
      sourceRevision: missionRevision2Record.sourceRevision,
      eventId: missionRevision2Record.id,
      contentDigest: missionRevision2Record.contentDigest,
      recordDigest: canonicalDigest(missionRevision2Record),
    });
    const candidate = missionAvoidanceOutside.candidates[0]!;
    expect(candidate.controlEventId).toBe(areaControlVersion.id);
    expect(candidate.controlDigest).toBe(canonicalDigest(areaControlBody));
    expect(candidate.template).toEqual(areaControlBody.controlType);
    expect(candidate.interval).toEqual({ start: areaControlBody.effectiveFrom, end: areaControlBody.effectiveUntil });
    expect(candidate.acceptance).toEqual({
      id: areaControlAcceptance.id,
      acceptedRevision: areaControlAcceptance.acceptedRevision,
      digest: areaControlAcceptance.signature.contentDigest,
    });
    expect(candidate.assessment).toEqual({
      id: areaControlAssessment.id,
      acceptedRevision: areaControlAssessment.acceptedRevision,
      digest: canonicalDigest(areaControlAssessment.outcome),
    });
    expect(areaControlAcceptance.outcome.assessmentDigest).toBe(candidate.assessment.digest);
    expect(candidate.authority).toEqual({
      policyVersion: 'ledger.sms-decision-authority.1',
      principalId: areaControlAcceptance.actor.principalId,
      principalRevision: areaControlAcceptance.actor.principalRevision,
      satisfyingCapability: areaControlAcceptance.actor.satisfyingCapability,
    });
    expect(candidate.safetyContextDigest).toBe(canonicalDigest(areaControlContext));
    expect(areaControlContext.assessment).toEqual(candidate.assessment);
    expect(missionAvoidanceIntersects.candidates[0]!.hazardId).toBe(candidate.hazardId);
    expect(missionAvoidanceIntersects.candidates[0]!.controlId).not.toBe(candidate.controlId);
    expect(missionAvoidanceReviewRequired.status).toBe('insufficient');
    expect(missionAvoidanceReviewRequired.candidates[0]!.geometry).toBe('outside');
    expect(missionAvoidanceReviewRequired.candidates[0]!.context).toBe('review_required');
    expect(missionAvoidanceReviewRequired.candidates[0]!.safetyContextDigest).not.toBe(candidate.safetyContextDigest);
    expect(missionAvoidanceIncomplete.contextDigest).toBeNull();
  });

  it('pins the registered area control type and the words it gives the parameters', () => {
    expect(avoidanceAreaControlType.digest).toBe(controlTypeDigest(registeredAreaType));
    expect(avoidanceAreaControlType).toMatchObject({
      id: registeredAreaType.id,
      version: registeredAreaType.version,
      title: registeredAreaType.title,
    });
    expect(describeControl(areaControlBody.controlType, areaControlBody.parameters)).toBe(areaControlDescription);
  });

  it('bounds the public response, rejects release claims and uses the scoped encoded read path', async () => {
    const validate = ajv.compile(MissionAvoidanceResponseSchema);
    expect(validate({ ...missionAvoidanceOutside, status: 'released' })).toBe(false);
    expect(validate({ ...missionAvoidanceOutside, release: true })).toBe(false);
    const { safetyContextDigest: _safetyContextDigest, ...missingSafetyContext } =
      missionAvoidanceOutside.candidates[0]!;
    expect(validate({ ...missionAvoidanceOutside, candidates: [missingSafetyContext] })).toBe(false);
    expect(
      validate({
        ...missionAvoidanceOutside,
        status: 'insufficient',
        candidates: [
          {
            ...missionAvoidanceOutside.candidates[0],
            controlVersion: 2,
            authority: null,
            geometry: 'insufficient',
            context: 'unsupported',
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        ...missionAvoidanceOutside,
        candidates: Array.from({ length: 65 }, () => missionAvoidanceOutside.candidates[0]),
      }),
    ).toBe(false);
    expect(
      validate({
        ...missionAvoidanceOutside,
        calculation: { ...missionAvoidanceOutside.calculation, distanceBudget: 100001 },
      }),
    ).toBe(false);
    const params = ajv.compile(FlightMissionAvoidanceParamsSchema);
    expect(params({ id: 'flight/one' })).toBe(true);
    expect(params({ id: '' })).toBe(false);
    const paths: string[] = [];
    const client = new LedgerClient('https://ledger.invalid', 'fixture-token', async (input) => {
      paths.push(String(input));
      return Response.json(missionAvoidanceOutside);
    });
    expect(await client.missionAvoidance('flight/one')).toEqual(missionAvoidanceOutside);
    expect(paths).toEqual(['https://ledger.invalid/v1/flights/flight%2Fone/mission-avoidance']);
  });
});
