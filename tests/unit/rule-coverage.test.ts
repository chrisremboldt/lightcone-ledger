import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf, RulePopulation } from '../../packages/contracts/src/index.js';
import { findCheckKind } from '../../packages/domain/src/check-kinds.js';
import { defineCheckedRule, runCheckedRule, withPopulation } from '../../packages/domain/src/checked-rules.js';
import {
  countResults,
  missingRecords,
  resultOf,
  standingResult,
  type LatestResult,
} from '../../packages/domain/src/rule-coverage.js';
import { conditionSql, joiningRoles, populationPosition } from '../../packages/domain/src/rule-populations.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };

function certificateRule(population: RulePopulation = { of: 'on_record' }): CheckedRuleLeaf {
  return defineCheckedRule(
    withPopulation(
      {
        id: 'test.coverage.certificate',
        version: 1,
        title: 'Certificate recorded as held',
        source: { kind: 'operator_procedure', reference: 'Fictional procedure 1', text: 'Hold a certificate.' },
        target: { subjectKind: 'person' },
        reads: [
          {
            name: 'subject',
            type: 'operator.record',
            versions: [1],
            about: 'target',
            required: false,
            select: 'latest',
            where: [{ field: 'values.recordType', oneOf: ['person.certificate'] }],
          },
        ],
        check: {
          kind: findCheckKind('value.one-of', 1)!,
          params: { field: 'values.record.recordedStatus', expected: ['held'] },
        },
      },
      population,
      { subject: 'fictional certificate' },
    ),
  );
}

function latest(outcome: string, reasonCode: string, extra: Partial<LatestResult> = {}): LatestResult {
  return {
    id: `${outcome}-${reasonCode}`,
    related: false,
    relatedKey: '',
    outcome,
    evidenceState: 'supported',
    reasonCode,
    summary: '',
    recordedAt: clock.evaluatedAt,
    inputs: [],
    ...extra,
  };
}

describe('a rule with a population', () => {
  it('requires the read that names its record, and says the record is not on file when it is absent', () => {
    const leaf = certificateRule();
    expect(leaf.population).toEqual({ of: 'on_record' });
    expect(leaf.reads[0]).toMatchObject({ required: true, onFile: 'fictional certificate' });
    expect(runCheckedRule(leaf, leaf.check.params, { subject: [] }, clock)).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary: 'No fictional certificate on file.',
    });
  });

  it('refuses a record name on a read that is not required, and a name for a read it does not have', () => {
    const leaf = certificateRule();
    const { digest: _digest, ...content } = leaf;
    expect(() =>
      defineCheckedRule({
        ...content,
        check: { kind: findCheckKind('value.one-of', 1)!, params: leaf.check.params },
        source: { kind: 'operator_procedure', reference: 'Fictional procedure 1', text: 'Hold a certificate.' },
        reads: [{ ...leaf.reads[0]!, required: false }],
      }),
    ).toThrow(/does not require it/);
    expect(() => withPopulation(content, { of: 'on_record' }, { missing: 'anything' })).toThrow(/No read missing/);
  });
});

describe('who joins a population', () => {
  const interval = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };
  const observation = (occurredAt: string, recordType = 'operation.role-assignment', role = 'pilot_in_command') => ({
    content: {
      id: 'observation-1',
      type: 'operator.record',
      version: 1,
      occurredAt,
      observation: { values: { recordType, record: { role } } },
    },
  });
  const scope = (population: RulePopulation) => ({ tenantId: 't', kind: 'person' as const, population, interval });

  it('takes every subject a record names for a population on record', () => {
    expect(joiningRoles(scope({ of: 'on_record' }), observation('2020-01-01T00:00:00.000Z'))).toEqual({
      roles: ['subject', 'secondarySubject'],
      references: true,
    });
  });

  it('takes subjects only from a record whose time falls in the adoption dates', () => {
    const dates = scope({ of: 'in_adoption_dates' });
    expect(joiningRoles(dates, observation('2026-10-05T00:00:00.000Z')).roles).toHaveLength(2);
    expect(joiningRoles(dates, observation('2026-09-30T23:59:59.000Z'))).toEqual({ roles: [], references: false });
  });

  it('takes the designated field only from a designating record', () => {
    const pilots = scope({
      of: 'designated',
      by: {
        type: 'operator.record',
        versions: [1],
        where: [{ field: 'values.record.role', oneOf: ['pilot_in_command'] }],
        field: 'values.record.personId',
      },
    });
    expect(joiningRoles(pilots, observation('2026-10-05T00:00:00.000Z'))).toEqual({
      roles: [],
      references: true,
      field: 'values.record.personId',
    });
    expect(
      joiningRoles(pilots, observation('2026-10-05T00:00:00.000Z', 'operation.role-assignment', 'visual_observer')),
    ).toEqual({ roles: [], references: false });
  });

  it('orders members by scope, source and id', () => {
    expect(populationPosition({ scope: 'ledger', kind: 'person', id: 'a' })).toBe('ledger\u001f\u001fa');
    expect(populationPosition({ scope: 'source', kind: 'person', id: 'a', sourceId: 's' })).toBe(
      'source\u001fs\u001fa',
    );
  });

  it('reads a designating condition as SQL over the same field', () => {
    const parameters: unknown[] = [];
    const parameter = (value: unknown) => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    const value = '(o.observation #> $1::text[])';
    const values = '(SELECT jsonb_array_elements($2::jsonb))';
    // A field holding a list matches when the list holds one of the values, as the in-memory read does.
    expect(conditionSql({ field: 'values.record.role', oneOf: ['pilot_in_command'] }, parameter)).toBe(
      `(CASE WHEN jsonb_typeof(${value})='array' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(${value}) e
    WHERE e.value IN ${values}) ELSE ${value} IN ${values} END)`,
    );
    expect(parameters).toEqual([['values', 'record', 'role'], '["pilot_in_command"]']);
  });
});

describe('coverage counts', () => {
  it('counts each latest result, and an unknown result as other', () => {
    expect(resultOf(latest('pass', 'value_expected'))).toBe('supported');
    expect(resultOf(latest('attention', 'value_unexpected'))).toBe('attention');
    expect(resultOf(latest('pending', 'record_not_on_file'))).toBe('no_record');
    expect(resultOf(latest('pending', 'date_missing'))).toBe('pending');
    // A record on file for a later time is waiting, not missing.
    expect(resultOf(latest('pending', 'record_for_later_time'))).toBe('pending');
    expect(resultOf(latest('not_applicable', 'condition_not_met'))).toBe('not_applicable');
    expect(resultOf(latest('relieved', 'relieved_by_waiver'))).toBe('relieved');
    expect(
      countResults([latest('pass', 'x'), latest('pending', 'record_not_on_file'), undefined, latest('later', 'x')]),
    ).toEqual({
      supported: 1,
      attention: 0,
      no_record: 1,
      pending: 0,
      not_applicable: 0,
      relieved: 0,
      other: 1,
      not_evaluated: 1,
    });
  });

  it('counts a target evaluated per related subject by the related result asking most of a person', () => {
    const target = latest('not_applicable', 'evaluated_per_related_subject');
    const passed = latest('pass', 'value_expected', { related: true, relatedKey: 'a' });
    const missing = latest('pending', 'record_not_on_file', { related: true, relatedKey: 'b' });
    const dropped = latest('attention', 'related_subject_not_named', { related: true, relatedKey: 'c' });
    expect(standingResult([target, passed, missing, dropped])).toBe(missing);
    expect(standingResult([target])).toBe(target);
    const problem = latest('pending', 'related_subject_missing');
    expect(standingResult([problem, passed])).toBe(problem);
    expect(standingResult([])).toBeUndefined();
  });

  it('names the records a result found not on file', () => {
    const leaf = certificateRule();
    const result = latest('pending', 'record_not_on_file', { inputs: [{ name: 'subject', observationIds: [] }] });
    expect(missingRecords(leaf, result)).toEqual(['fictional certificate']);
    expect(missingRecords(leaf, latest('pass', 'value_expected'))).toEqual([]);
    expect(missingRecords(leaf, undefined)).toEqual([]);
  });
});
