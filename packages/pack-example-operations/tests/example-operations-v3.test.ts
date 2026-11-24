import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf } from '../../contracts/src/index.js';
import type { CheckInputs, CheckObservation } from '../../domain/src/check-kinds.js';
import {
  adoptionParameterProblem,
  checkedRuleProblem,
  checkParameters,
  narrowRead,
  runCheckedRule,
} from '../../domain/src/checked-rules.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  BATTERY_AT_LANDING_LEAF_ID,
  BATTERY_FOR_FLIGHT_LEAF_ID,
  BATTERY_RESERVE_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
  exampleOperationsVersionOne,
  exampleOperationsVersionThree,
  exampleOperationsVersionTwo,
} from '../src/index.js';

const start = Date.parse('2026-10-05T09:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const takeoffAt = at(60);
const landingAt = at(600);
const reserve = 30;
const parameters = { [BATTERY_FOR_FLIGHT_LEAF_ID]: { limit: reserve } };

/** A made-up battery every minute from before takeoff to after landing, dipping below the reserve twice. */
const levels = [95, 90, 80, 70, 60, 28, 27, 45, 40, 29, 35, 20, 10];
const batteries: CheckObservation[] = levels.map((level, index) => ({
  id: `battery-${String(index).padStart(2, '0')}`,
  type: 'battery.state',
  version: 1,
  occurredAt: at(index * 60),
  observation: { values: { totalRemainingPercent: level } },
}));

function report(activity: 'active' | 'landed'): CheckObservation {
  return {
    id: `report-${activity}`,
    type: 'flight.report',
    version: 1,
    occurredAt: activity === 'active' ? takeoffAt : landingAt,
    observation: { values: { activity, takeoffAt, ...(activity === 'landed' ? { landingAt } : {}) } },
  };
}

const leaf = () =>
  exampleOperationsVersionThree().leaves.find((item) => item.id === BATTERY_FOR_FLIGHT_LEAF_ID) as CheckedRuleLeaf;

/** Narrows every read in order as the evaluator does, then runs the rule at the given time. */
function evaluate(
  window: CheckObservation[],
  values: CheckObservation[],
  evaluatedAt: string,
  recorded: CheckObservation[] = [],
) {
  const rule = leaf();
  const given: Record<string, CheckObservation[]> = { window, values, recorded };
  const inputs: Record<string, readonly CheckObservation[]> = {};
  for (const read of rule.reads)
    inputs[read.name] = narrowRead(
      read,
      [...given[read.name]!].filter((item) => item.occurredAt <= evaluatedAt).reverse(),
      inputs as CheckInputs,
    );
  return runCheckedRule(rule, checkParameters(rule, parameters), inputs, { mode: 'wall', evaluatedAt });
}

describe('example operating procedures pack, version 3', () => {
  it('registers version 3 beside the unchanged versions 1 and 2, adding the rule for the whole flight', () => {
    expect(getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 1)!.digest).toBe(exampleOperationsVersionOne().digest);
    expect(getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 2)!.digest).toBe(exampleOperationsVersionTwo().digest);
    const pack = exampleOperationsVersionThree();
    expect(getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 3)!.digest).toBe(pack.digest);
    expect(pack.leaves.map((item) => item.id)).toEqual([
      BATTERY_RESERVE_LEAF_ID,
      BATTERY_AT_LANDING_LEAF_ID,
      BATTERY_FOR_FLIGHT_LEAF_ID,
    ]);
    expect(pack.leaves.slice(0, 2)).toEqual(exampleOperationsVersionTwo().leaves);
    expect(checkedRuleProblem(leaf())).toBeUndefined();
    expect(leaf()).toMatchObject({
      target: { subjectKind: 'flight' },
      related: [{ name: 'aircraft', from: { read: 'window', field: 'secondarySubject' } }],
      check: { kind: 'window.values-within-limit', version: 1, params: { comparison: 'at_least' } },
    });
    const both = {
      [BATTERY_RESERVE_LEAF_ID]: { limit: 25 },
      [BATTERY_AT_LANDING_LEAF_ID]: { limit: 25 },
      ...parameters,
    };
    expect(adoptionParameterProblem(pack, both)).toBeUndefined();
    expect(adoptionParameterProblem(pack, { ...both, [BATTERY_FOR_FLIGHT_LEAF_ID]: { limit: 0 } })).toBeDefined();
  });

  it('names each stretch below the reserve from takeoff to landing, the same after landing as during the flight', () => {
    const during = evaluate([report('active')], batteries, at(570));
    const afterLanding = evaluate([report('active'), report('landed')], batteries, at(720));
    expect(during).toMatchObject({ outcome: 'attention', details: { windowClosed: false, runCount: 2 } });
    expect(afterLanding).toMatchObject({
      outcome: 'attention',
      evidenceState: 'supported',
      details: { windowClosed: true, runCount: 2, valuesChecked: 10, worstValue: 27 },
    });
    expect(afterLanding.issues).toEqual(during.issues);
    expect(afterLanding.issueTimes).toEqual([
      { issue: `outside-from:${at(300)}`, start: at(300), end: at(420) },
      { issue: `outside-from:${at(540)}`, start: at(540), end: at(600) },
    ]);
    expect(afterLanding.summary).toBe(
      `The battery was below the ${reserve}% reserve during the flight from ${at(300)}, 2 stretch(es) and 180 s in all; the lowest was 27% at ${at(360)}.`,
    );
    // Readings after landing, lower still, change nothing.
    expect(evaluate([report('landed')], batteries, at(86_400))).toEqual(afterLanding);
  });

  it('is insufficient when the aircraft reports no battery during the flight', () => {
    expect(evaluate([report('landed')], batteries.slice(0, 1), at(720))).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'values_missing',
    });
  });

  it('reads the battery at landing in the operator’s own flight record when no battery and no flight is reported', () => {
    const logged = (batteryAtLandingPercent: number): CheckObservation => ({
      id: `record-${batteryAtLandingPercent}`,
      type: 'operator.record',
      version: 1,
      occurredAt: at(700),
      interval: { start: takeoffAt, end: landingAt },
      observation: {
        values: {
          recordType: 'flight.record',
          recordVersion: 1,
          record: { takeoffAt, landingAt, batteryAtLandingPercent },
        },
      },
    });
    const low = evaluate([], [], at(720), [logged(18)]);
    expect(low).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'recorded_outside_limit',
      issues: [`outside-from:${landingAt}`],
      details: { basis: 'recorded', recordedValue: 18, worstValue: null },
    });
    expect(low.summary).toBe(
      'No battery remaining is reported; the result rests on the operator’s own record. Read the battery remaining at landing in the operator’s flight record: 18 %, outside the limit, at least 30 %.',
    );
    expect(evaluate([], [], at(720), [logged(40)])).toMatchObject({
      outcome: 'pass',
      reasonCode: 'recorded_within_limit',
    });
    // With the flight's reports and its battery on record, the reports are read and the logged value named beside them.
    const reported = evaluate([report('landed')], batteries, at(720), [logged(40)]);
    expect(reported.details).toMatchObject({ basis: 'reported', recordedValue: 40 });
    expect(reported.summary).toContain('The battery remaining at landing in the operator’s flight record is 40 %');
    expect(evaluate([], [], at(720))).toMatchObject({ outcome: 'not_applicable', reasonCode: 'not_flown_on_file' });
  });
});
