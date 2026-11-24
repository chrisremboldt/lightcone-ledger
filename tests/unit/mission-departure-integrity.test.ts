import { describe, expect, it } from 'vitest';
import { missionDeparturePermit } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { assertMissionDepartureAuthorization } from '../../packages/domain/src/mission-departure-integrity.js';
import { missionDepartureHistoryBasis } from './mission-departure-history-fixture.js';

describe('retained departure authorization integrity', () => {
  it('checks the original lease and basis without rejecting an expired historical authorization', () => {
    const basis = missionDepartureHistoryBasis();
    expect(() => assertMissionDepartureAuthorization(missionDeparturePermit, basis)).not.toThrow();
    const extended = {
      ...missionDeparturePermit,
      validUntil: new Date(Date.parse(missionDeparturePermit.validUntil) + 1).toISOString(),
    };
    expect(() => assertMissionDepartureAuthorization(extended, basis)).toThrowError(
      expect.objectContaining({ status: 409, code: 'departure_integrity_failure' }),
    );
    const changed = structuredClone(basis);
    changed.candidateContexts[0]!.context.control.versionNumber = 99;
    expect(() => assertMissionDepartureAuthorization(missionDeparturePermit, changed)).toThrowError(
      expect.objectContaining({ status: 409, code: 'departure_integrity_failure' }),
    );
    // The basis keeps no copy of what does not apply, and its review has the release's context digest.
    const copied = { ...structuredClone(basis), avoidance: { ...basis.avoidance, notApplicable: [] } };
    const otherContext = {
      ...structuredClone(basis),
      avoidance: { ...basis.avoidance, contextDigest: 'f'.repeat(64) },
    };
    for (const refused of [copied, otherContext])
      expect(() => assertMissionDepartureAuthorization(missionDeparturePermit, refused)).toThrowError(
        expect.objectContaining({ status: 409, code: 'departure_integrity_failure' }),
      );
    // Every basis pins the controls its authorizer saw, an empty list when none was in scope.
    const { controls: _controls, ...unpinned } = basis;
    expect(() => assertMissionDepartureAuthorization(missionDeparturePermit, unpinned as typeof basis)).toThrowError(
      expect.objectContaining({ status: 409, code: 'departure_integrity_failure' }),
    );
  });
});
