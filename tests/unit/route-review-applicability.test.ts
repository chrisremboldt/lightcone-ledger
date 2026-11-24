import { describe, expect, test } from 'vitest';
import {
  MISSION_AVOIDANCE_CANDIDATE_LIMIT,
  MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  type MissionRevisionRecord,
} from '../../packages/contracts/src/index.js';
import { areaControlCandidate } from '../../packages/contracts/fixtures/demo/v1/area-control.js';
import { missionAvoidanceMission } from '../../packages/contracts/fixtures/demo/v1/mission-avoidance.js';
import { missionRevision2Record } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  acceptedAreaControls,
  reviewConsideredControls,
  type AcceptedAreaControl,
} from '../../packages/domain/src/index.js';
import {
  registerControlType,
  registeredControlTypeDigest,
  type ControlType,
} from '../../packages/domain/src/control-types.js';
import { geodesicDistance } from '../../packages/domain/src/mission-avoidance-kernel.js';
import type { PoolClient } from '../../packages/persistence/src/index.js';

/** About one metre of latitude in degrees near the fictional route. */
const metre = 1 / 111034;
const areaType = () => ({
  id: 'control.avoidance-area',
  version: 1,
  digest: registeredControlTypeDigest('control.avoidance-area', 1)!,
});
const mission: MissionRevisionRecord = {
  ...structuredClone(missionRevision2Record),
  route: {
    ...missionRevision2Record.route,
    geometry: {
      type: 'LineString',
      coordinates: [
        [-105.01, 40],
        [-104.99, 40],
      ],
    },
  },
  lateralToleranceMeters: 20,
};
const reference = missionAvoidanceMission;

/** One accepted area control, north of the route by the given distance, with an optional reach. */
function control(
  index: number,
  northMeters: number,
  options: { reach?: number; context?: 'current' | 'review_required'; template?: { digest: string } } = {},
): AcceptedAreaControl {
  const { geometry: _geometry, ...candidate } = areaControlCandidate('outside');
  const parameters = {
    center: { latitude: 40 + northMeters * metre, longitude: -105 },
    radiusMeters: 250,
    ...(options.reach === undefined ? {} : { appliesWithinMeters: options.reach }),
  };
  return {
    candidate: {
      ...candidate,
      controlId: `example-area-${index}`,
      controlEventId: `example-area-${index}-v1`,
      controlDigest: canonicalDigest({ example: 'area', index }),
      template: { ...areaType(), ...options.template },
      context: options.context ?? 'current',
      reasons: options.context === 'review_required' ? ['assessment_changed'] : [],
    },
    circle: { center: parameters.center, radiusMeters: parameters.radiusMeters },
    safetyContext: {
      version: 'mission.avoidance-control-record-context.1',
      assessment: null,
      hazard: { id: candidate.hazardId, latestAcceptanceId: candidate.acceptance.id },
      control: { recordId: `example-area-${index}`, versionNumber: 1, status: 'open' },
    },
    title: `Fictional works area ${index}`,
    parameters,
  };
}

// A fictional pack's type whose rule finds that no control of it applies and which describes no area: route review
// never reads such a type as an area type, but its entry must still say so rather than invent one.
const neverDefinition = Object.freeze({ id: 'example.applicability.never', version: 1 });
const unplacedType: ControlType<{ measure: string }> = {
  id: 'example.unplaced-limitation',
  version: 1,
  title: 'Example unplaced limitation',
  description: 'A fictional limitation with a rule and no area.',
  appliesTo: ['area'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['measure'],
    properties: { measure: { type: 'string', minLength: 1, maxLength: 200 } },
  },
  checkedAutomatically: false,
  describe: ({ measure }) => measure,
  applicability: {
    rule: { ...neverDefinition, digest: canonicalDigest(neverDefinition) },
    definition: neverDefinition,
    evaluate: () => ({ applies: false, measured: [], declared: [], summary: 'This fictional control never applies.' }),
  },
};
registerControlType(unplacedType);

const far = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => control(from + index, 20000 + index * 10, { reach: 500 }));
const near = (count: number, from = 1000) =>
  Array.from({ length: count }, (_, index) => control(from + index, 300 + 250 + 20, { reach: 500 }));

function reviewed(controls: AcceptedAreaControl[]) {
  const review = reviewConsideredControls(controls, mission, reference);
  if (!review.complete) throw new Error(`incomplete: ${review.reason}`);
  return review;
}

describe('route review splits the considered controls by applicability', () => {
  test('controls that apply are candidates and the rest are listed with their records', () => {
    const review = reviewed([...far(3), ...near(2)]);
    expect(review.count).toBe(2);
    expect(review.candidates.map((entry) => entry.controlId)).toEqual(['example-area-1000', 'example-area-1001']);
    expect(review.candidates.every((entry) => entry.geometry === 'outside')).toBe(true);
    expect(review.notApplicable.map((entry) => entry.controlId)).toEqual([
      'example-area-0',
      'example-area-1',
      'example-area-2',
    ]);
    for (const entry of review.notApplicable) {
      expect(entry).not.toHaveProperty('geometry');
      expect(entry.applicability).toMatchObject({
        outcome: 'does_not_apply',
        basis: 'rule',
        inputs: { mission: reference },
      });
      expect(entry.applicabilityDigest).toBe(canonicalDigest(entry.applicability));
      // The recorded clearance is a true lower bound, and not the whole route's length short of it.
      const area = entry.applicability.inputs.control.controlId;
      const index = Number(area.slice('example-area-'.length));
      const nearest = geodesicDistance({ latitude: 40 + (20000 + index * 10) * metre, longitude: -105 }, 40, -105)!;
      const clearance = entry.applicability.measured[0]!.value as number;
      expect(clearance).toBeLessThanOrEqual(nearest - 250 - 20);
      expect(clearance).toBeGreaterThan(nearest - 250 - 20 - 1200);
    }
    for (const entry of review.candidates)
      expect(entry.applicability).toMatchObject({ outcome: 'applies', basis: 'rule' });
    // Preimages stay parallel to their lists; every considered area is kept for a detour.
    expect(review.candidateContexts.map((entry) => entry.controlEventId)).toEqual(
      review.candidates.map((entry) => entry.controlEventId),
    );
    expect(review.notApplicableContexts.map((entry) => entry.controlEventId)).toEqual(
      review.notApplicable.map((entry) => entry.controlEventId),
    );
    expect(review.circles).toHaveLength(2);
    expect(review.considered).toHaveLength(5);
  });

  test('each control that does not apply carries its title and the area its type describes', () => {
    const review = reviewed([control(4, 20000, { reach: 500 })]);
    const [entry] = review.notApplicable;
    expect(entry).toMatchObject({
      controlId: 'example-area-4',
      title: 'Fictional works area 4',
      area: { center: { latitude: 40 + 20000 * metre, longitude: -105 }, radiusMeters: 250 },
    });
    // The type's own area() answer, without its site or the reach: the reach is under the record's declared.
    expect(Object.keys(entry!.area!).sort()).toEqual(['center', 'radiusMeters']);
    const sited = control(5, 20000, { reach: 500 });
    sited.parameters = { ...(sited.parameters as object), site: 'Fictional depot' };
    expect(reviewed([sited]).notApplicable[0]!.area).toEqual(entry!.area);
  });

  test('a control whose type describes no area is listed with its title and a null area', () => {
    const unplaced = control(6, 20000);
    unplaced.candidate.template = {
      id: unplacedType.id,
      version: 1,
      digest: registeredControlTypeDigest(unplacedType.id, 1)!,
    };
    unplaced.parameters = { measure: 'Keep clear of the fictional works.' };
    const [entry] = reviewed([unplaced]).notApplicable;
    expect(entry).toMatchObject({ title: 'Fictional works area 6', area: null });
    expect(entry!.applicability).toMatchObject({ outcome: 'does_not_apply', basis: 'rule' });
  });

  test('a control under review and a control with no reach both stay candidates', () => {
    const review = reviewed([
      control(1, 20000, { reach: 500, context: 'review_required' }),
      control(2, 20000),
      control(3, 20000, { reach: 500 }),
    ]);
    expect(review.candidates.map((entry) => [entry.controlId, entry.applicability.basis])).toEqual([
      ['example-area-1', 'under_review'],
      ['example-area-2', 'undetermined'],
    ]);
    expect(review.candidates[1]!.applicability.reasons).toEqual(['no_reach_declared']);
    expect(review.notApplicable.map((entry) => entry.controlId)).toEqual(['example-area-3']);
  });

  test('every case that cannot be evaluated applies and reaches the candidates', () => {
    const unknownType = control(1, 20000, { reach: 500, template: { digest: 'f'.repeat(64) } });
    const invalid = control(2, 20000, { reach: 500 });
    invalid.parameters = { ...(invalid.parameters as object), appliesWithinMeters: -1 };
    const outsideProfile = control(3, 20000, { reach: 500 });
    outsideProfile.parameters = {
      center: { latitude: 85, longitude: -105 },
      radiusMeters: 250,
      appliesWithinMeters: 1,
    };
    const review = reviewed([unknownType, invalid, outsideProfile]);
    expect(review.notApplicable).toEqual([]);
    expect(review.candidates.map((entry) => [entry.applicability.basis, entry.applicability.reasons])).toEqual([
      ['no_rule', ['control_type_unavailable']],
      ['no_rule', ['control_parameters_invalid']],
      ['undetermined', ['control_geometry_outside_profile']],
    ]);
  });

  test(`at most ${MISSION_AVOIDANCE_CANDIDATE_LIMIT} controls may apply; any number below the considered bound may not`, () => {
    const crowded = reviewed([...near(MISSION_AVOIDANCE_CANDIDATE_LIMIT), ...far(400)]);
    expect(crowded.candidates).toHaveLength(MISSION_AVOIDANCE_CANDIDATE_LIMIT);
    expect(crowded.notApplicable).toHaveLength(400);
    const over = reviewConsideredControls(
      [...near(MISSION_AVOIDANCE_CANDIDATE_LIMIT + 1), ...far(10)],
      mission,
      reference,
    );
    expect(over).toEqual({
      complete: false,
      count: MISSION_AVOIDANCE_CANDIDATE_LIMIT + 1,
      reason: 'candidate_limit_exceeded',
    });
  });
});

describe(`route review reads at most ${MISSION_AVOIDANCE_CONSIDERED_LIMIT} considered controls`, () => {
  /** A client that answers the considered-controls query with rows for the given controls. */
  function client(count: number): PoolClient {
    const rows = Array.from({ length: count }, (_, index) => {
      const { candidate, parameters } = control(index, 20000, { reach: 500 });
      return {
        acceptance_id: candidate.acceptance.id,
        hazard_id: candidate.hazardId,
        control_id: candidate.controlId,
        control_version_number: 1,
        control_body_digest: candidate.controlDigest,
        control_type_id: candidate.template.id,
        control_type_version: candidate.template.version,
        control_type_digest: candidate.template.digest,
        effective_from: new Date('2026-10-15T14:00:00Z'),
        effective_until: null,
        control_event_id: candidate.controlEventId,
        control_title: `Fictional works area ${index}`,
        control_body: { hazardId: candidate.hazardId, controlType: candidate.template, parameters },
        control_current_version: 1,
        control_status: 'open',
        acceptance: { id: candidate.acceptance.id, kind: 'risk.accept', outcome: {}, actor: {} },
        accepted_assessment: { id: candidate.assessment.id, outcome: {} },
        current_assessment: null,
        body_bytes: '1024',
        acceptance_bytes: '1024',
        accepted_assessment_bytes: '1024',
        current_assessment_bytes: null,
      };
    });
    return { query: async () => ({ rows, rowCount: rows.length }) } as unknown as PoolClient;
  }
  const interval = { start: '2026-10-15T14:05:00Z', end: '2026-10-15T14:20:00Z' };

  test('up to the bound the read is complete; above it the review is incomplete', async () => {
    const atBound = await acceptedAreaControls(client(MISSION_AVOIDANCE_CONSIDERED_LIMIT), 'tenant', interval);
    expect(atBound).toMatchObject({ complete: true, count: MISSION_AVOIDANCE_CONSIDERED_LIMIT });
    const over = await acceptedAreaControls(client(MISSION_AVOIDANCE_CONSIDERED_LIMIT + 1), 'tenant', interval);
    expect(over).toEqual({
      complete: false,
      count: MISSION_AVOIDANCE_CONSIDERED_LIMIT + 1,
      reason: 'considered_limit_exceeded',
    });
  });

  test('the considered controls at the bound are each evaluated', async () => {
    const read = await acceptedAreaControls(client(MISSION_AVOIDANCE_CONSIDERED_LIMIT), 'tenant', interval);
    if (!read.complete) throw new Error('incomplete');
    // The fake acceptances carry no signature, so their context is unsupported: each applies, past the 64 bound.
    expect(reviewConsideredControls(read.controls, mission, reference)).toMatchObject({
      complete: false,
      reason: 'candidate_limit_exceeded',
    });
    const current = read.controls.map((entry) => ({
      ...entry,
      candidate: { ...entry.candidate, context: 'current' as const, reasons: [] },
    }));
    const review = reviewed(current);
    expect(review.candidates).toHaveLength(0);
    expect(review.notApplicable).toHaveLength(MISSION_AVOIDANCE_CONSIDERED_LIMIT);
    expect(review.notApplicable[7]).toMatchObject({ title: 'Fictional works area 7', area: { radiusMeters: 250 } });
  });
});
