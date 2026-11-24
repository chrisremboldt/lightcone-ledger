import { describe, expect, it } from 'vitest';
import { checkKindDigest, checkParameterProblem, findCheckKind, type CheckObservation } from '../src/check-kinds.js';
import { evidenceDueV1, valuesDisagreeV1 } from '../src/check-kind-evidence.js';

// The cases of the former flight evaluator, expressed with the generic kinds and made-up observation types.

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt });

function report(id: string, values: Record<string, unknown>): CheckObservation {
  const occurredAt = '2026-10-15T14:20:00.000Z';
  return {
    id,
    type: 'made-up.report',
    version: 1,
    occurredAt,
    observation: { type: 'made-up.report', version: 1, occurredAt, values },
  };
}

function state(values: Record<string, unknown>): CheckObservation {
  const occurredAt = '2026-10-15T14:00:00.000Z';
  return { id: 'state-1', type: 'made-up.state', version: 1, occurredAt, observation: { occurredAt, ...values } };
}

const disagree = { fields: ['values.doneAt', 'values.finishedAt'], valueType: 'utc_instant' as const };
const due = { ...disagree, deadlineField: 'plannedEnd', graceSeconds: 300 };
const planned = state({ plannedEnd: '2026-10-15T14:20:00.000Z' });

describe('values.disagree', () => {
  it('registers with a schema that takes the compared fields as parameters', () => {
    // The registry keeps the first copy registered (source or build), so compare definitions, not identity.
    expect(checkKindDigest(findCheckKind('values.disagree', 1)!)).toBe(checkKindDigest(valuesDisagreeV1));
    expect(checkParameterProblem('values.disagree', 1, disagree)).toBeUndefined();
    expect(checkParameterProblem('values.disagree', 1, { fields: [], valueType: 'utc_instant' })).toBeDefined();
  });

  it('records distinct valid values as conflicting with the observations that report them', () => {
    const first = report('a', { doneAt: '2026-10-15T14:20:00Z' });
    const second = report('b', { finishedAt: '2026-10-15T14:22:00Z' });
    const outcome = valuesDisagreeV1.evaluate(disagree, { reports: [second, first] }, clock('2026-10-15T15:00:00Z'));
    expect(outcome).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      reasonCode: 'values_disagree',
      evidence: ['b', 'a'],
      details: { values: '2026-10-15T14:20:00.000Z, 2026-10-15T14:22:00.000Z', valueCount: 2, reportCount: 2 },
    });
    expect(
      valuesDisagreeV1.evaluate(disagree, { reports: [first, second] }, clock('2026-10-15T15:00:00Z')).outcome,
    ).toBe('attention');
  });

  it('compares equivalent UTC instants as one value', () => {
    const outcome = valuesDisagreeV1.evaluate(
      disagree,
      {
        reports: [report('a', { doneAt: '2026-10-15T14:20:00Z' }), report('b', { doneAt: '2026-10-15T14:20:00.000Z' })],
      },
      clock('2026-10-15T15:00:00Z'),
    );
    expect(outcome).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      evidence: ['a', 'b'],
      details: { values: '2026-10-15T14:20:00.000Z', valueCount: 1, reportCount: 2 },
    });
  });

  it('ignores invalid values and is insufficient when none is valid', () => {
    const invalid = report('a', { doneAt: '2026-02-30T14:20:00Z', finishedAt: 'not-a-time' });
    expect(valuesDisagreeV1.evaluate(disagree, { reports: [invalid] }, clock('2026-10-15T15:00:00Z'))).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'value_missing',
      evidence: [],
      details: { values: null, valueCount: 0, reportCount: 1 },
    });
  });

  it('declares every detail it returns', () => {
    expect(valuesDisagreeV1.details?.map((detail) => detail.name)).toEqual(['values', 'valueCount', 'reportCount']);
  });
});

describe('evidence.due', () => {
  it('awaits evidence until the deadline from the subject state plus the grace, and names that boundary', () => {
    expect(evidenceDueV1.evaluate(due, { evidence: [], state: [planned] }, clock('2026-10-15T14:24:59.999Z'))).toEqual(
      expect.objectContaining({
        evidenceState: 'insufficient',
        outcome: 'pending',
        reasonCode: 'evidence_awaited',
        nextBoundary: '2026-10-15T14:25:00.000Z',
        details: {
          dueAt: '2026-10-15T14:25:00.000Z',
          graceSeconds: 300,
          evidenceFound: false,
          evidenceValues: null,
        },
      }),
    );
  });

  it('needs attention from the deadline on, and clears when evidence arrives', () => {
    const overdue = evidenceDueV1.evaluate(due, { evidence: [], state: [planned] }, clock('2026-10-15T14:25:00Z'));
    expect(overdue).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'evidence_overdue',
    });
    expect(overdue.nextBoundary).toBeUndefined();
    const landed = evidenceDueV1.evaluate(
      due,
      { evidence: [report('late', { doneAt: '2026-10-15T14:19:00.000Z' })], state: [planned] },
      clock('2026-10-15T14:25:00Z'),
    );
    expect(landed).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      evidence: ['late'],
      details: {
        dueAt: '2026-10-15T14:25:00.000Z',
        graceSeconds: 300,
        evidenceFound: true,
        evidenceValues: '2026-10-15T14:19:00.000Z',
      },
    });
    expect(landed.nextBoundary).toBeUndefined();
  });

  it('does not count invalid values as evidence and does not fabricate an absent deadline', () => {
    const invalid = report('a', { doneAt: '2026-02-30T14:20:00Z', finishedAt: 'not-a-time' });
    expect(
      evidenceDueV1.evaluate(due, { evidence: [invalid], state: [planned] }, clock('2026-10-15T14:26:00Z')),
    ).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention' });
    const unknown = evidenceDueV1.evaluate(due, { evidence: [], state: [state({})] }, clock('2026-10-15T14:26:00Z'));
    expect(unknown).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'deadline_unavailable',
      details: { dueAt: null, graceSeconds: 300, evidenceFound: false, evidenceValues: null },
    });
    expect(unknown.nextBoundary).toBeUndefined();
  });

  it('declares every detail it returns, so a rule can word its results with them', () => {
    expect(evidenceDueV1.details?.map((detail) => detail.name)).toEqual([
      'dueAt',
      'graceSeconds',
      'evidenceFound',
      'evidenceValues',
    ]);
  });
});
