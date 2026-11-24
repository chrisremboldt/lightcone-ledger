import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../../integrity/src/index.js';
import { indicatorDefinitionProblem } from '../../domain/src/indicators.js';
import {
  BATTERY_AT_LANDING_LEAF_ID,
  BATTERY_FOR_FLIGHT_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
  exampleOperationsIndicators,
  exampleOperationsVersionThree,
  lowReserveLandingsPer100FlightsV1,
  reserveExceedancesPerFlightHourV1,
} from '../src/index.js';

describe('example operating procedures indicators', () => {
  it('are definitions over the rules of version 3, pinned by digest, using the library exposure kinds', () => {
    const rules = exampleOperationsVersionThree().leaves.map((leaf) => leaf.id);
    for (const definition of exampleOperationsIndicators()) {
      expect(indicatorDefinitionProblem(definition)).toBeUndefined();
      const { digest, ...content } = definition;
      expect(digest).toBe(canonicalDigest(content));
      expect(definition.scope).toEqual({ kind: 'subject_kind', subjectKind: 'flight' });
      expect(definition.events).toMatchObject({ packId: EXAMPLE_OPERATIONS_PACK_ID });
      expect(rules).toContain((definition.events as { ruleId: string }).ruleId);
    }
  });

  it('count each low-reserve landing once per flight, and each stretch below the reserve per flight hour', () => {
    expect(lowReserveLandingsPer100FlightsV1()).toMatchObject({
      events: { kind: 'findings', ruleId: BATTERY_AT_LANDING_LEAF_ID },
      exposure: { kind: 'exposure.flights', version: 1 },
      unit: { per: 100, label: 'per 100 flights' },
    });
    expect(reserveExceedancesPerFlightHourV1()).toMatchObject({
      events: { kind: 'issues', ruleId: BATTERY_FOR_FLIGHT_LEAF_ID },
      exposure: { kind: 'exposure.flight-hours', version: 1 },
      unit: { per: 1, label: 'per flight hour' },
    });
    expect(reserveExceedancesPerFlightHourV1().events).not.toHaveProperty('countEach');
  });
});
