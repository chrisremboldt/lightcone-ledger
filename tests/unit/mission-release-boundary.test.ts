import { describe, expect, test } from 'vitest';
import { releaseControlBoundary } from '../../packages/domain/src/mission-release-boundary.js';

// Accepted controls of one fictional organization, each bound by a hazard acceptance, with its effective interval.
function bound(name: string, effectiveFrom: string, effectiveUntil: string | null, version = 1) {
  return {
    hazardId: `hazard-${name}`,
    controlId: `control-${name}`,
    versionNumber: version,
    controlEventId: `control-${name}-v${version}`,
    acceptanceId: `acceptance-${name}`,
    effectiveFrom,
    effectiveUntil,
  };
}

/** A release that recorded these controls as not applying to its flight. */
function release(...notApplying: ReturnType<typeof bound>[]) {
  return {
    basis: {
      avoidance: {
        notApplicable: notApplying.map((control) => ({
          hazardId: control.hazardId,
          controlId: control.controlId,
          controlVersion: control.versionNumber,
          controlEventId: control.controlEventId,
          acceptance: { id: control.acceptanceId },
        })),
      },
    },
  };
}

const after = '2026-11-20T10:00:00.000Z';
const far = bound('far', '2026-11-20T09:00:00.000Z', '2026-11-20T10:05:00.000Z');
const near = bound('near', '2026-11-20T09:00:00.000Z', '2026-11-20T10:20:00.000Z');
const upcomingFar = bound('upcoming-far', '2026-11-20T10:10:00.000Z', null);

describe('the next control boundary that can matter to a release', () => {
  test('a control the release recorded as not applying ends nothing; every other control still does', () => {
    expect(releaseControlBoundary([far, near], release(), after)).toBe(far.effectiveUntil);
    expect(releaseControlBoundary([far, near], release(far), after)).toBe(near.effectiveUntil);
    // An upcoming control the release considered and found not to apply: neither its start counts.
    expect(releaseControlBoundary([far, near, upcomingFar], release(far, upcomingFar), after)).toBe(
      near.effectiveUntil,
    );
    expect(releaseControlBoundary([far, upcomingFar], release(far, upcomingFar), after)).toBeNull();
  });

  test('a control of any other type, or one the release did not consider, counts', () => {
    // A rule control, a person-checked control or an area control outside the operating interval: not recorded as
    // not applying, so the release names none of them.
    const rule = bound('rule', '2026-11-20T10:02:00.000Z', null);
    expect(releaseControlBoundary([far, rule], release(far), after)).toBe(rule.effectiveFrom);
  });

  test('another version, event or acceptance of a control recorded as not applying counts', () => {
    const revised = bound('far', '2026-11-20T09:00:00.000Z', '2026-11-20T10:03:00.000Z', 2);
    expect(releaseControlBoundary([revised, near], release(far), after)).toBe(revised.effectiveUntil);
    const otherEvent = { ...far, controlEventId: 'control-far-v1-again' };
    expect(releaseControlBoundary([otherEvent, near], release(far), after)).toBe(far.effectiveUntil);
    const reaccepted = { ...far, acceptanceId: 'acceptance-far-again' };
    expect(releaseControlBoundary([reaccepted, near], release(far), after)).toBe(far.effectiveUntil);
    const otherHazard = { ...far, hazardId: 'hazard-other' };
    expect(releaseControlBoundary([otherHazard, near], release(far), after)).toBe(far.effectiveUntil);
  });

  test('only instants after the evaluation count, and none at all gives null', () => {
    expect(releaseControlBoundary([near], release(), near.effectiveUntil!)).toBeNull();
    expect(releaseControlBoundary([near], release(), near.effectiveFrom)).toBe(near.effectiveUntil);
    expect(releaseControlBoundary([], release(), after)).toBeNull();
  });
});
