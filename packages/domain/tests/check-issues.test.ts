import { describe, expect, it } from 'vitest';
import { checkKindDefinition, registerCheckKind, type CheckKind } from '../src/check-kinds.js';
import { defineCheckedRule, runCheckedRule } from '../src/checked-rules.js';

// A check result may name the distinct things that need a person's attention. They are kept only when the kind
// declares issues, so kinds that declare none keep their definition digests and their results.

function kind(id: string, declared: boolean): CheckKind {
  return {
    id,
    version: 1,
    title: 'Fictional issue check',
    description: 'Names one issue per observation it reads.',
    inputs: [{ name: 'reports', description: 'Any observations.' }],
    parameterSchema: { type: 'object', additionalProperties: false },
    ...(declared ? { issues: { description: 'One observation to review.' } } : {}),
    evaluate: (_params, inputs) => ({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'named',
      summary: 'Named.',
      evidence: [],
      issues: [...(inputs.reports ?? []).map((item) => `report:${item.id}`), 'report:b'],
    }),
  };
}

function rule(check: CheckKind) {
  return defineCheckedRule({
    id: `fictional.${check.id}`,
    version: 1,
    title: 'Fictional rule',
    source: { kind: 'operator_procedure', reference: 'fictional.procedure', text: 'Review each report.' },
    target: { subjectKind: 'flight' },
    reads: [{ name: 'reports', type: 'flight.report', versions: [1], about: 'target', required: false, select: 'all' }],
    check: { kind: check },
  });
}

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T11:00:00.000Z' };
const report = (id: string) => ({
  id,
  type: 'flight.report',
  version: 1,
  occurredAt: clock.evaluatedAt,
  observation: {},
});

describe('check result issues', () => {
  it('keeps the issues a declaring kind names, sorted and distinct', () => {
    const declaring = kind('fictional.issues', true);
    registerCheckKind(declaring);
    const outcome = runCheckedRule(rule(declaring), {}, { reports: [report('c'), report('b')] }, clock);
    expect(outcome.issues).toEqual(['report:b', 'report:c']);
    expect(checkKindDefinition(declaring).issues).toEqual({ description: 'One observation to review.' });
  });

  it('leaves issues out of the result and the definition when a kind declares none', () => {
    const silent = kind('fictional.no-issues', false);
    registerCheckKind(silent);
    const outcome = runCheckedRule(rule(silent), {}, { reports: [report('c')] }, clock);
    expect(outcome).not.toHaveProperty('issues');
    expect(checkKindDefinition(silent)).not.toHaveProperty('issues');
  });
});
