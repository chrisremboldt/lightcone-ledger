import { describe, expect, it } from 'vitest';
import type {
  FlightControlsResponse,
  MissionBriefingRecordResponse,
  MissionReleaseRecordResponse,
} from '@ledger/contracts';
import { missionReleaseRecordResponse } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { missionBriefingRecordResponse } from '../../../packages/contracts/fixtures/demo/v1/mission-briefing.js';
import { areaReachApplicability } from '../../../packages/domain/src/area-reach-rule.js';
import { geodesicDistance } from '../../../packages/domain/src/mission-avoidance-kernel.js';
import {
  assessFarControls,
  areaReachRule,
  FAR_CONTROL_LATERAL_TOLERANCE_METERS,
  FAR_CONTROL_ROUTE_EXTENT_METERS,
  farControlCenter,
  farControlMinimumClearance,
  farControlPlacedAtMeters,
  farControlPlacements,
  farControlProblems,
  farControlRoute,
  type FarControlObservation,
  type RecordedFarControl,
} from '../src/scenario-applicability.js';

const positions = farControlRoute.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));
const first = positions[0]!;
const controls: RecordedFarControl[] = farControlPlacements.map((placement, index) => ({
  controlId: `far-control-${index + 1}`,
  minimumClearanceMeters: farControlMinimumClearance(placement),
}));

/** The fixture release with its one candidate kept and the three far controls recorded as not applying. */
function release(clearances = controls.map((control) => control.minimumClearanceMeters + 250)) {
  const response = structuredClone(missionReleaseRecordResponse) as MissionReleaseRecordResponse;
  const avoidance = response.release.basis.avoidance;
  const { geometry: _geometry, ...candidate } = avoidance.candidates[0]!;
  avoidance.notApplicable = controls.map((control, index) => ({
    ...candidate,
    controlId: control.controlId,
    controlEventId: `${control.controlId}-version-1`,
    applicability: {
      ...candidate.applicability,
      outcome: 'does_not_apply' as const,
      basis: 'rule' as const,
      rule: { ...areaReachRule, digest: 'a'.repeat(64) },
      measured: [{ name: 'clearanceAtLeastMeters', value: clearances[index]!, unit: 'm' }],
    },
  }));
  return response;
}
function controlList(change: (list: FlightControlsResponse) => void = () => undefined): FlightControlsResponse {
  const list = {
    flightId: missionReleaseRecordResponse.release.flightId,
    controls: [],
    notApplicable: controls.map((control) => ({ control: { id: control.controlId } })),
  } as unknown as FlightControlsResponse;
  change(list);
  return list;
}
function observation(change: (value: FarControlObservation) => void = () => undefined): FarControlObservation {
  const value: FarControlObservation = {
    controls,
    releases: [release()],
    briefings: [structuredClone(missionBriefingRecordResponse) as MissionBriefingRecordResponse],
    controlLists: [controlList()],
    otherTenantVisible: [],
  };
  change(value);
  return value;
}

describe('the simulated day’s far area controls', () => {
  it('are placed at least the stated distance from the route, which stays within its stated extent', () => {
    for (const placement of farControlPlacements) {
      const distance = geodesicDistance(farControlCenter(placement), first.latitude, first.longitude)!;
      expect(farControlPlacedAtMeters(placement)).toBeLessThanOrEqual(distance);
      expect(farControlMinimumClearance(placement)).toBeGreaterThan(10 * placement.appliesWithinMeters);
    }
    let length = 0;
    for (const [index, position] of positions.slice(1).entries())
      length += geodesicDistance(positions[index]!, position.latitude, position.longitude)!;
    expect(length).toBeLessThan(FAR_CONTROL_ROUTE_EXTENT_METERS);
  });

  it('are found not to apply by the area reach rule, with at least the clearance the self-check requires', () => {
    expect(areaReachApplicability.rule).toMatchObject(areaReachRule);
    const plan = {
      mission: {
        aircraftId: 'aircraft-alpha-far-field',
        sourceMissionId: 'far-field-mission',
        route: farControlRoute,
        lateralToleranceMeters: FAR_CONTROL_LATERAL_TOLERANCE_METERS,
        altitude: { minimum: 45, maximum: 60, unit: 'm' as const, reference: 'AGL' as const },
        operatingInterval: { start: '2026-12-07T14:00:00.000Z', end: '2026-12-07T15:00:00.000Z' },
      },
    };
    for (const placement of farControlPlacements) {
      const outcome = areaReachApplicability.evaluate(
        {
          center: farControlCenter(placement),
          radiusMeters: placement.radiusMeters,
          appliesWithinMeters: placement.appliesWithinMeters,
        },
        plan,
      );
      expect(outcome.applies).toBe(false);
      const clearance =
        'measured' in outcome ? outcome.measured.find((row) => row.name === 'clearanceAtLeastMeters') : 0;
      expect(clearance).toMatchObject({ unit: 'm' });
      expect((clearance as { value: number }).value).toBeGreaterThanOrEqual(farControlMinimumClearance(placement));
    }
  });

  it('pass the self-check when every release records them as not applying and no briefing lists them', () => {
    expect(farControlProblems(observation())).toEqual([]);
    expect(assessFarControls(observation())).toMatchObject({ passed: true, expected: [], actual: [] });
  });

  it('fail the self-check when no release was recorded or a far control is missing, applies or measured too near', () => {
    const releaseId = missionReleaseRecordResponse.release.id;
    const at = (index: number) => `${releaseId}:${controls[index]!.controlId}`;
    const cases: Array<[(value: FarControlObservation) => void, string[]]> = [
      [(value) => (value.releases = []), ['releases:none_recorded']],
      [(value) => (value.controls = controls.slice(0, 2)), ['controls:not_accepted']],
      [(value) => value.releases[0]!.release.basis.avoidance.notApplicable.splice(1, 1), [`${at(1)}:not_recorded`]],
      [
        (value) => {
          const entry = value.releases[0]!.release.basis.avoidance.notApplicable[0]!;
          entry.applicability = { ...entry.applicability, outcome: 'applies', basis: 'undetermined' };
        },
        [`${at(0)}:outcome_applies`, `${at(0)}:basis_undetermined`],
      ],
      [
        (value) => {
          const entry = value.releases[0]!.release.basis.avoidance.notApplicable[2]!;
          entry.applicability = {
            ...entry.applicability,
            rule: { ...areaReachRule, version: 2, digest: 'b'.repeat(64) },
          };
        },
        [`${at(2)}:rule`],
      ],
      [
        (value) =>
          (value.releases = [
            release(controls.map((control, index) => control.minimumClearanceMeters - (index === 1 ? 1 : 0))),
          ]),
        [`${at(1)}:clearance`],
      ],
      [
        (value) => {
          const candidate = value.releases[0]!.release.basis.avoidance.candidates[0]!;
          value.releases[0]!.release.basis.avoidance.candidates.push({
            ...candidate,
            controlId: controls[0]!.controlId,
          });
        },
        [`${at(0)}:candidate`],
      ],
    ];
    for (const [change, problems] of cases) expect(farControlProblems(observation(change))).toEqual(problems);
    expect(assessFarControls(observation((value) => (value.releases = [])))).toMatchObject({ passed: false });
  });

  it('fail the self-check when a briefing or the list for briefing names one, or the second tenant can read one', () => {
    const briefed = observation((value) => {
      value.briefings[0]!.briefing.context.controls[0]!.controlId = controls[1]!.controlId;
    });
    expect(farControlProblems(briefed)).toEqual([
      `${missionBriefingRecordResponse.briefing.id}:${controls[1]!.controlId}:briefed`,
    ]);
    const listed = observation((value) => {
      value.controlLists = [
        controlList((list) => {
          (list.controls as unknown[]).push({ control: { id: controls[2]!.controlId } });
          list.notApplicable.pop();
        }),
      ];
    });
    const flightId = missionReleaseRecordResponse.release.flightId;
    expect(farControlProblems(listed)).toEqual([
      `${flightId}:${controls[2]!.controlId}:listed_for_briefing`,
      `${flightId}:${controls[2]!.controlId}:not_listed_as_not_applying`,
    ]);
    expect(farControlProblems(observation((value) => (value.otherTenantVisible = [controls[0]!.controlId])))).toEqual([
      `${controls[0]!.controlId}:visible_to_second_tenant`,
    ]);
  });
});
