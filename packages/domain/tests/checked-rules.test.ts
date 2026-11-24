import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import type { RulePackVersion } from '@ledger/contracts';
import { valueWithinLimitV1 } from '../src/check-kind-library.js';
import type { CheckObservation } from '../src/check-kinds.js';
import {
  adoptionParameterProblem,
  checkedRuleProblem,
  checkParameters,
  defineCheckedRule,
  evaluatedSubjectDecision,
  runCheckedRule,
  type CheckedRuleSpec,
} from '../src/checked-rules.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-03T00:00:00.000Z' };

function reading(id: string, values: Record<string, unknown>): CheckObservation {
  const occurredAt = '2026-11-02T10:00:00.000Z';
  return { id, type: 'made-up.reading', version: 1, occurredAt, observation: { occurredAt, values } };
}

const spec: CheckedRuleSpec = {
  id: 'example.reading-floor',
  version: 1,
  title: 'Reading stays at or above the floor',
  source: {
    kind: 'operator_procedure',
    reference: 'Example procedure 1',
    text: 'Keep the reading at or above the floor.',
  },
  target: { subjectKind: 'aircraft' },
  reads: [
    { name: 'subject', type: 'made-up.reading', versions: [1], about: 'target', required: true, select: 'latest' },
    { name: 'phase', type: 'made-up.phase', versions: [1], about: 'target', required: false, select: 'latest' },
  ],
  check: { kind: valueWithinLimitV1, params: { field: 'values.level', comparison: 'at_least' } },
  adoptionParameters: [{ name: 'limit', title: 'Floor', valueType: 'number', minimum: 0, maximum: 100 }],
  applicability: [{ input: 'phase', field: 'values.phase', oneOf: ['active'], whenAbsent: 'not_applicable' }],
};
const rule = defineCheckedRule(spec);

function pack(leaves: RulePackVersion['leaves']): RulePackVersion {
  const content = {
    packId: 'example.pack',
    version: 1,
    title: 'Example pack',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves,
  };
  return { ...content, digest: canonicalDigest(content) };
}

describe('a checked rule is data run by the engine', () => {
  const parameters = checkParameters(rule, { [rule.id]: { limit: 20 } });
  const active = [reading('p', { phase: 'active' })];

  it('runs the check when the rule applies and its required inputs are present', () => {
    expect(runCheckedRule(rule, parameters, { subject: [reading('r', { level: 12 })], phase: active }, clock)).toEqual({
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      summary: 'The latest reported value for the level is 12; the limit is at least 20.',
      evidence: ['r'],
    });
  });

  it('decides applicability and missing required inputs without calling the check', () => {
    expect(
      runCheckedRule(rule, parameters, { subject: [reading('r', { level: 12 })], phase: [] }, clock),
    ).toMatchObject({ applicability: 'not_applicable', evidenceState: 'not_applicable', outcome: 'not_applicable' });
    expect(
      runCheckedRule(
        rule,
        parameters,
        { subject: [reading('r', { level: 12 })], phase: [reading('p', { phase: 'parked' })] },
        clock,
      ),
    ).toMatchObject({ outcome: 'not_applicable', reasonCode: 'condition_not_met', evidence: ['p'] });
    expect(runCheckedRule(rule, parameters, { subject: [], phase: active }, clock)).toMatchObject({
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
    });
  });

  it('says a required record is on file for a later time, and from when the rule reads it', () => {
    const later = '2026-11-04T09:00:00.000Z';
    expect(runCheckedRule(rule, parameters, { subject: [], phase: active }, clock, { subject: later })).toEqual({
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_for_later_time',
      summary: `A reading is on file for a later time; the rule reads it from ${later}.`,
      evidence: [],
      nextBoundary: later,
    });
    // Named on file, a record with nothing later is still not on file; one with a later record says so.
    const onFile = defineCheckedRule({
      ...spec,
      reads: [
        { ...spec.reads[0]!, onFile: 'level reading' },
        { ...spec.reads[1]!, required: true, onFile: 'phase record' },
      ],
      applicability: [],
    });
    expect(runCheckedRule(onFile, parameters, {}, clock)).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No level reading on file. No phase record on file.',
    });
    expect(runCheckedRule(onFile, parameters, {}, clock, { subject: later })).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: `A level reading is on file for a later time; the rule reads it from ${later}. No phase record on file.`,
    });
    expect(runCheckedRule(onFile, parameters, {}, clock, { subject: later, phase: later })).toMatchObject({
      reasonCode: 'record_for_later_time',
      nextBoundary: later,
    });
    // A read that reads plans takes later records itself, so an empty one has none.
    const plans = defineCheckedRule({ ...spec, reads: [{ ...spec.reads[0]!, plans: true }, spec.reads[1]!] });
    expect(runCheckedRule(plans, parameters, { subject: [], phase: active }, clock, { subject: later })).toMatchObject({
      reasonCode: 'required_input_missing',
    });
  });

  it('refuses a leaf that does not match its digest or pins another check definition', () => {
    expect(checkedRuleProblem(rule)).toBeUndefined();
    expect(checkedRuleProblem({ ...rule, title: 'Edited' })).toMatch(/digest/);
    const { digest: _, ...content } = rule;
    const repinned = { ...content, check: { ...content.check, definitionDigest: 'a'.repeat(64) } };
    expect(checkedRuleProblem({ ...repinned, digest: canonicalDigest(repinned) })).toMatch(/different definition/);
  });

  it('checks the parameter values an adoption supplies', () => {
    const adopted = pack([rule]);
    expect(adoptionParameterProblem(adopted, { [rule.id]: { limit: 20 } })).toBeUndefined();
    expect(adoptionParameterProblem(adopted, undefined)).toMatch(/needs parameter limit/);
    expect(adoptionParameterProblem(adopted, { [rule.id]: { limit: 120 } })).toMatch(/not a valid number/);
    expect(adoptionParameterProblem(adopted, { [rule.id]: { limit: 20, extra: 1 } })).toMatch(/does not declare/);
    expect(adoptionParameterProblem(adopted, { other: { limit: 20 } })).toMatch(/takes no adoption parameters/);
  });
});

describe('a condition on a record a person names', () => {
  // The rule covers a subject only while its phase record says it is active; the phase record is required and named,
  // and read twice.
  const phaseRead = {
    name: 'phase',
    type: 'made-up.phase',
    versions: [1],
    about: 'target' as const,
    required: true,
    onFile: 'phase record',
    select: 'latest' as const,
  };
  const covered = defineCheckedRule({
    ...spec,
    id: 'example.reading-floor-covered',
    reads: [phaseRead, { ...phaseRead, name: 'phaseAgain' }, spec.reads[0]!],
    applicability: [
      {
        input: 'phase',
        field: 'values.phase',
        oneOf: ['active'],
        whenAbsent: 'insufficient',
        notMetSummary: 'The phase record does not say active, so this rule does not cover the subject.',
      },
      { input: 'subject', field: 'values.level', oneOf: [99], whenAbsent: 'not_applicable' },
    ],
  });
  const parameters = checkParameters(covered, { [covered.id]: { limit: 20 } });
  const level = [reading('s', { level: 30 })];

  it('says the record is not on file before any later condition, once for two reads of it', () => {
    expect(runCheckedRule(covered, parameters, { subject: level }, clock)).toMatchObject({
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary: 'No phase record on file.',
    });
  });

  it('records the rule’s own sentence when the condition is not met', () => {
    const idle = [reading('p', { phase: 'idle' })];
    expect(runCheckedRule(covered, parameters, { phase: idle, phaseAgain: idle, subject: level }, clock)).toEqual({
      applicability: 'not_applicable',
      evidenceState: 'not_applicable',
      outcome: 'not_applicable',
      reasonCode: 'condition_not_met',
      summary: 'The phase record does not say active, so this rule does not cover the subject.',
      evidence: ['p'],
    });
  });

  it('decides it on the subject’s own records before any related subject is read', () => {
    const phase = (value: string) => [reading('p', { phase: value })];
    expect(evaluatedSubjectDecision(covered, { subject: level }, clock)).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No phase record on file.',
    });
    expect(
      evaluatedSubjectDecision(covered, { phase: phase('idle'), phaseAgain: phase('idle'), subject: level }, clock),
    ).toMatchObject({ reasonCode: 'condition_not_met' });
    // Met, the rule's other conditions are left to its own run.
    expect(
      evaluatedSubjectDecision(covered, { phase: phase('active'), phaseAgain: phase('active'), subject: level }, clock),
    ).toBeUndefined();
    // A condition on a read that names no record is left to the rule's own run, as before.
    expect(evaluatedSubjectDecision(rule, {}, clock)).toBeUndefined();
  });

  it('refuses a condition sentence that states a verdict', () => {
    expect(() =>
      defineCheckedRule({
        ...spec,
        applicability: [{ ...spec.applicability![0]!, notMetSummary: 'The flight is not authorized.' }],
      }),
    ).toThrow('has an applicability summary that states a verdict');
  });
});
