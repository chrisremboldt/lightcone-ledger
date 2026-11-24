import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf, SubjectReference } from '../../contracts/src/index.js';
import { translateCrewRosterDuty } from '../../adapters/src/crew-roster-duty.js';
import { findCheckKind, type CheckObservation } from '../../domain/src/check-kinds.js';
import { adoptionParameterProblem, checkParameters, runCheckedRule } from '../../domain/src/checked-rules.js';
import type { IndicatorObservation } from '../../domain/src/indicator-exposure-kinds.js';
import {
  calculateIndicator,
  findIndicatorDefinition,
  registerIndicatorDefinition,
} from '../../domain/src/indicators.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  ASSIGNED_CREW_LEAF_ID,
  DUTY_PERIOD_LEAF_ID,
  EXAMPLE_CREW_PACK_ID,
  REST_BEFORE_DUTY_LEAF_ID,
  ROLLING_DUTY_LEAF_ID,
  assignmentsOutsideLimitsV1,
  exampleCrewVersionOne,
} from '../src/index.js';

// The sample roster, translated by the shipped roster adapter, and the sample role assignments, evaluated as the
// generic evaluator would once both files are recorded.
const samples = join(import.meta.dirname, '../../contracts/fixtures/operator-records');
const limits = { maxDutyHours: 10, minRestHours: 10, maxRollingDutyHours: 50, dutyRecordComplete: false };
const parameters = {
  [DUTY_PERIOD_LEAF_ID]: { maxDutyHours: limits.maxDutyHours },
  [REST_BEFORE_DUTY_LEAF_ID]: { minRestHours: limits.minRestHours, dutyRecordComplete: false },
  [ROLLING_DUTY_LEAF_ID]: { maxRollingDutyHours: limits.maxRollingDutyHours },
  [ASSIGNED_CREW_LEAF_ID]: limits,
};
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-19T00:00:00.000Z' };

const newestFirst = (a: CheckObservation, b: CheckObservation) =>
  (b.interval?.start ?? b.occurredAt).localeCompare(a.interval?.start ?? a.occurredAt) || b.id.localeCompare(a.id);

function periods(): CheckObservation[] {
  const translated = translateCrewRosterDuty(
    {
      bytes: readFileSync(join(samples, '../crew-roster/alpha-crew-roster.json')),
      contentType: 'application/json',
      transport: { path: '/imports/roster' },
      capturedAt: clock.evaluatedAt,
    },
    { subjects: { scope: 'source' }, binding: undefined },
  );
  return translated.drafts.map((draft) => {
    const period = draft as unknown as { sourceEventId: string; occurredAt: string; interval: { start: string } };
    return {
      id: period.sourceEventId,
      type: 'crew.duty-period',
      version: 1,
      occurredAt: period.occurredAt,
      interval: period.interval,
      observation: draft as unknown as Record<string, unknown>,
    };
  });
}

function assignments(): CheckObservation[] {
  const [header, ...rows] = readFileSync(join(samples, 'alpha-crew-assignments.csv'), 'utf8').trim().split('\n');
  const columns = header!.split(',');
  return rows.map((row, index) => {
    const cells = Object.fromEntries(row.split(',').map((cell, column) => [columns[column]!, cell]));
    const interval = { start: cells.startsAt!, end: cells.endsAt! };
    return {
      id: `assignment-${index + 1}`,
      type: 'operator.record',
      version: 1,
      occurredAt: interval.start,
      interval,
      observation: {
        subject: { kind: 'flight', id: cells.subjectId, scope: 'source' },
        interval,
        values: {
          recordType: 'operation.role-assignment',
          recordVersion: 1,
          record: { personId: { id: cells.personId, scope: 'source' }, role: cells.role, ...interval },
        },
      },
    };
  });
}

const personOf = (observation: CheckObservation) => (observation.observation.subject as { id: string }).id;
const leaf = (id: string) => exampleCrewVersionOne().leaves.find((item) => item.id === id) as CheckedRuleLeaf;

function perPerson(id: string) {
  const rule = leaf(id);
  const all = periods();
  return Object.fromEntries(
    ['ALPHA-OBSERVER-01', 'ALPHA-PILOT-01', 'ALPHA-PILOT-02'].map((person) => [
      person,
      runCheckedRule(
        rule,
        checkParameters(rule, parameters),
        { periods: all.filter((period) => personOf(period) === person).sort(newestFirst) },
        clock,
      ),
    ]),
  );
}

/** One result per assignment, as the engine's fan-out narrows the assignments to the person each one names. */
function perAssignment() {
  const rule = leaf(ASSIGNED_CREW_LEAF_ID);
  const all = periods();
  return assignments().map((assignment) => {
    const values = assignment.observation.values as { record: { personId: { id: string } } };
    const person = values.record.personId.id;
    return {
      flight: personOf(assignment),
      person,
      outcome: runCheckedRule(
        rule,
        checkParameters(rule, parameters),
        { window: [assignment], periods: all.filter((period) => personOf(period) === person).sort(newestFirst) },
        clock,
      ),
    };
  });
}

describe('example crew pack', () => {
  it('ships three rules per person and one per flight over duty periods, registered with the standard packs', () => {
    const pack = getRulePackVersion(EXAMPLE_CREW_PACK_ID, 1)!;
    expect(pack.digest).toBe(exampleCrewVersionOne().digest);
    expect(pack.leaves.map((item) => item.id)).toEqual([
      DUTY_PERIOD_LEAF_ID,
      REST_BEFORE_DUTY_LEAF_ID,
      ROLLING_DUTY_LEAF_ID,
      ASSIGNED_CREW_LEAF_ID,
    ]);
    for (const id of [DUTY_PERIOD_LEAF_ID, REST_BEFORE_DUTY_LEAF_ID, ROLLING_DUTY_LEAF_ID])
      expect(leaf(id)).toMatchObject({
        target: { subjectKind: 'person' },
        reads: [{ name: 'periods', type: 'crew.duty-period', about: 'target', select: 'all' }],
        check: { kind: 'duty.within-limits', version: 1 },
      });
    expect(leaf(ASSIGNED_CREW_LEAF_ID)).toMatchObject({
      target: { subjectKind: 'flight' },
      related: [{ name: 'person', fanOut: true, from: { read: 'window', field: 'values.record.personId' } }],
      reads: [
        { name: 'window', type: 'operator.record', about: 'target' },
        { name: 'periods', type: 'crew.duty-period', about: { related: 'person' } },
      ],
    });
    expect(findCheckKind('duty.within-limits', 1)).toBeDefined();
  });

  it('is adopted only with every limit set within range', () => {
    const pack = exampleCrewVersionOne();
    expect(adoptionParameterProblem(pack, parameters)).toBeUndefined();
    expect(adoptionParameterProblem(pack, undefined)).toMatch(/needs parameter maxDutyHours/);
    expect(
      adoptionParameterProblem(pack, { ...parameters, [ASSIGNED_CREW_LEAF_ID]: { ...limits, minRestHours: 30 } }),
    ).toBeDefined();
    expect(adoptionParameterProblem(pack, { ...parameters, [DUTY_PERIOD_LEAF_ID]: { maxDutyHours: 0 } })).toBeDefined();
  });

  it('finds the long duty period and the short rest in each person’s latest duty period', () => {
    const duty = perPerson(DUTY_PERIOD_LEAF_ID);
    expect(duty['ALPHA-PILOT-02']).toMatchObject({
      outcome: 'attention',
      reasonCode: 'duty_limit_exceeded',
      summary: 'The duty period lasts 12.5 h against at most 10 h.',
      evidence: ['R-0059@1'],
    });
    expect(duty['ALPHA-PILOT-01']).toMatchObject({ outcome: 'pass' });
    expect(duty['ALPHA-OBSERVER-01']).toMatchObject({ outcome: 'pass' });

    const rest = perPerson(REST_BEFORE_DUTY_LEAF_ID);
    expect(rest['ALPHA-OBSERVER-01']).toMatchObject({
      outcome: 'attention',
      summary: 'The longest continuous recorded rest in the 24 h before the duty period is 8 h against at least 10 h.',
    });
    expect(rest['ALPHA-PILOT-01']).toMatchObject({ outcome: 'pass' });
    expect(rest['ALPHA-PILOT-02']).toMatchObject({ outcome: 'pass' });

    const rolling = perPerson(ROLLING_DUTY_LEAF_ID);
    expect(Object.values(rolling).map((result) => result.outcome)).toEqual(['pass', 'pass', 'pass']);
    expect(rolling['ALPHA-PILOT-02']!.summary).toBe(
      'Duty in the 168 h ending with the duty period totals 44.5 h against at most 50 h.',
    );
  });

  it('reads the time between two recorded duty periods as rest when the organization says its duty record is complete', () => {
    const rule = leaf(REST_BEFORE_DUTY_LEAF_ID);
    const dutyOnly = periods().filter((period) => (period.observation.values as { period: string }).period !== 'rest');
    const run = (person: string, dutyRecordComplete: boolean) =>
      runCheckedRule(
        rule,
        checkParameters(rule, {
          ...parameters,
          [REST_BEFORE_DUTY_LEAF_ID]: { minRestHours: limits.minRestHours, dutyRecordComplete },
        }),
        { periods: dutyOnly.filter((period) => personOf(period) === person).sort(newestFirst) },
        clock,
      );
    expect(run('ALPHA-OBSERVER-01', false)).toMatchObject({
      evidenceState: 'insufficient',
      summary: 'No rest is recorded in the 24 h before the duty period.',
    });
    const complete = run('ALPHA-OBSERVER-01', true);
    expect(complete.summary).toMatch(
      /^The longest continuous rest, taken from the time between recorded duty periods, in the 24 h before the duty period is [\d.]+ h against at least 10 h\.$/,
    );
    expect(complete.evidenceState).toBe('supported');
  });

  it('needs attention for each person assigned to a flight while outside a limit, and only for them', () => {
    const results = perAssignment();
    const attention = results.filter((result) => result.outcome.outcome === 'attention');
    expect(attention.map(({ flight, person }) => `${flight} ${person}`)).toEqual([
      'ALPHA-FLT-1005 ALPHA-PILOT-02',
      'ALPHA-FLT-1005 ALPHA-OBSERVER-01',
      'ALPHA-FLT-1006 ALPHA-PILOT-02',
    ]);
    expect(results.filter((result) => result.outcome.outcome === 'pass')).toHaveLength(9);
    for (const { outcome } of attention) expect(outcome.evidenceState).toBe('supported');
    // The window is the assignment, so a flight late in the long duty period cites that period.
    const late = attention[2]!.outcome;
    expect(late.evidence.slice(0, 2)).toEqual(['assignment-11', 'R-0059@1']);
  });

  it('defines assignments outside limits per 100 duty periods over the per-flight findings', () => {
    const definition = assignmentsOutsideLimitsV1();
    registerIndicatorDefinition(definition);
    expect(findIndicatorDefinition(definition.id, 1)!.digest).toBe(definition.digest);
    const person = (id: string): SubjectReference => ({ scope: 'source', kind: 'person', id, sourceId: 'roster' });
    const flight = (id: string): SubjectReference => ({ scope: 'source', kind: 'flight', id, sourceId: 'roster' });
    const duty = (id: string, who: string, start: string): IndicatorObservation => ({
      id,
      type: 'crew.duty-period',
      version: 1,
      occurredAt: start,
      interval: { start, end: start.replace('T06', 'T14') },
      subjects: [person(who)],
      observation: { values: { period: 'duty' } },
    });
    const finding = (id: string, who: string) => ({
      kind: 'finding' as const,
      id,
      subject: flight(`flight-${id}`),
      related: person(who),
      packId: EXAMPLE_CREW_PACK_ID,
      ruleId: ASSIGNED_CREW_LEAF_ID,
      openedAt: '2026-10-16T09:00:00.000Z',
    });
    const result = calculateIndicator(definition, {
      window: { start: '2026-10-12T00:00:00.000Z', end: '2026-10-19T00:00:00.000Z' },
      recordedThrough: '2026-10-19T00:00:00.000Z',
      control: null,
      population: {
        subjects: [person('crew-1'), person('crew-2')],
        complete: true,
        declaredBy: { kind: 'person', id: 'operations-lead' },
      },
      selection: { complete: true, exceeded: [] },
      events: [finding('1', 'crew-1'), finding('2', 'crew-3')],
      exposure: [
        duty('duty-1', 'crew-1', '2026-10-12T06:00:00.000Z'),
        duty('duty-2', 'crew-1', '2026-10-13T06:00:00.000Z'),
        duty('duty-3', 'crew-2', '2026-10-13T06:00:00.000Z'),
        duty('duty-4', 'crew-2', '2026-10-14T06:00:00.000Z'),
      ],
    });
    // crew-3 is not in the population, so only one finding counts: 1 / 4 * 100.
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 1,
      exposure: { value: { numerator: '4', denominator: '1' }, unit: 'duty_period' },
      rate: { decimal: '25.00', label: 'per 100 duty periods' },
    });
  });
});
