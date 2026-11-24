import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@ledger/integrity';
import type { CheckedRuleLeaf, RulePackVersion } from '@ledger/contracts';
import { evidenceDueV1 } from '../src/check-kind-evidence.js';
import { valueWithinLimitV1 } from '../src/check-kind-library.js';
import { windowValuesWithinLimitV1 } from '../src/check-kind-library-windows.js';
import {
  checkKindDefinition,
  checkKindDigest,
  registerCheckKind,
  type CheckInputs,
  type CheckKind,
  type CheckObservation,
} from '../src/check-kinds.js';
import { checkedRuleProblem, defineCheckedRule, narrowRead, runCheckedRule } from '../src/checked-rules.js';
import { registerRulePack } from '../src/rule-pack-registry.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-03T00:00:00.000Z' };
const source = { kind: 'operator_procedure' as const, reference: 'Example procedure 9', text: 'Keep records.' };

function record(id: string, at: string, values: Record<string, unknown>): CheckObservation {
  return { id, type: 'operator.record', version: 1, occurredAt: at, observation: { occurredAt: at, values } };
}

function state(values: Record<string, unknown>): CheckObservation {
  return { id: 'state', type: 'flight.state', version: 1, occurredAt: clock.evaluatedAt, observation: values };
}

/** Narrows every read in order as the evaluator does, then runs the rule. */
function run(leaf: CheckedRuleLeaf, given: Record<string, CheckObservation[]>, parameters = leaf.check.params) {
  const inputs: Record<string, readonly CheckObservation[]> = {};
  if (leaf.subjectState) inputs[leaf.subjectState.name] = given[leaf.subjectState.name] ?? [];
  for (const read of leaf.reads) inputs[read.name] = narrowRead(read, given[read.name] ?? [], inputs as CheckInputs);
  return runCheckedRule(leaf, parameters, inputs, clock);
}

function pack(packId: string, leaves: RulePackVersion['leaves']): RulePackVersion {
  const content = {
    packId,
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

// A check kind made up for these tests: it reports the subject's status as a detail.
const reportedStatusV1: CheckKind<Record<string, never>> = {
  id: 'example.reported-status',
  version: 1,
  title: 'Status is reported',
  description: 'Supported when the subject state holds a status; the status is returned as a detail.',
  inputs: [{ name: 'state', description: 'The subject state.' }],
  parameterSchema: { type: 'object', additionalProperties: false },
  details: [
    { name: 'status', description: 'The reported status.' },
    { name: 'dueAt', description: 'Never returned; lets a test name a declared detail that is absent.' },
  ],
  evaluate(_params, inputs) {
    const status = inputs.state?.[0]?.observation.status;
    return typeof status === 'string'
      ? {
          evidenceState: 'supported',
          outcome: 'pass',
          reasonCode: 'status_reported',
          summary: 'A status is reported.',
          evidence: [],
          details: { status, undeclared: 'dropped' },
        }
      : {
          evidenceState: 'insufficient',
          outcome: 'pending',
          reasonCode: 'status_missing',
          summary: 'No status is reported.',
          evidence: [],
        };
  },
};
registerCheckKind(reportedStatusV1);

describe('a read narrowed by field', () => {
  const leaf = defineCheckedRule({
    id: 'example.battery-log-floor',
    version: 1,
    title: 'Battery log stays above the floor',
    source,
    target: { subjectKind: 'aircraft' },
    reads: [
      {
        name: 'subject',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: true,
        select: 'latest',
        where: [{ field: 'values.recordType', oneOf: ['example.battery-log'] }],
      },
    ],
    check: { kind: valueWithinLimitV1, params: { field: 'values.record.level', comparison: 'at_least', limit: 20 } },
  });

  it('is insufficient when a required read narrowed by record type finds only other record types', () => {
    const other = record('crew', '2026-11-02T10:00:00.000Z', { recordType: 'example.crew-log', record: { level: 5 } });
    expect(run(leaf, { subject: [other] })).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
    });
  });

  it('selects the latest matching record even when a newer record of another type exists', () => {
    const newer = record('crew', '2026-11-02T11:00:00.000Z', { recordType: 'example.crew-log', record: { level: 5 } });
    const battery = record('battery', '2026-11-02T10:00:00.000Z', {
      recordType: 'example.battery-log',
      record: { level: 12 },
    });
    expect(run(leaf, { subject: [newer, battery] })).toMatchObject({ outcome: 'attention', evidence: ['battery'] });
  });

  it('treats absent, null and blank values as not filled, and false as filled', () => {
    const read = {
      ...leaf.reads[0]!,
      select: 'all' as const,
      where: [{ field: 'values.flag', filled: true as const }],
    };
    const at = '2026-11-02T10:00:00.000Z';
    const given = [
      record('absent', at, {}),
      record('null', at, { flag: null }),
      record('blank', at, { flag: ' ' }),
      record('false', at, { flag: false }),
      record('text', at, { flag: 'yes' }),
    ];
    expect(narrowRead(read, given, {}).map((item) => item.id)).toEqual(['false', 'text']);
  });

  it('leaves the digest of a leaf that uses none of the new parts unchanged', () => {
    const { digest, ...content } = leaf;
    expect(canonicalDigest(content)).toBe(digest);
    expect(Object.keys(leaf)).not.toContain('subjectState');
    expect(Object.keys(leaf)).not.toContain('wording');
    expect(checkKindDigest(valueWithinLimitV1)).toBe(leaf.check.definitionDigest);
  });
});

describe('the latest observation at or before an instant another read records', () => {
  const leaf = defineCheckedRule({
    id: 'example.battery-at-landing',
    version: 1,
    title: 'Battery at landing stays above the floor',
    source,
    target: { subjectKind: 'flight' },
    reads: [
      { name: 'landing', type: 'example.landing', versions: [1], about: 'target', required: false, select: 'latest' },
      {
        name: 'subject',
        type: 'example.battery',
        versions: [1],
        about: 'target',
        required: true,
        select: { latestAtOrBefore: { read: 'landing', field: 'values.landedAt' } },
      },
    ],
    check: { kind: valueWithinLimitV1, params: { field: 'values.level', comparison: 'at_least', limit: 20 } },
  });
  const battery = (id: string, at: string, level: number) => record(id, at, { level });

  it('selects the reading at or before the landing, not a later one', () => {
    const landing = record('landing', '2026-11-02T10:30:00.000Z', { landedAt: '2026-11-02T10:20:00.000Z' });
    const readings = [
      battery('after', '2026-11-02T10:25:00.000Z', 50),
      battery('at', '2026-11-02T10:20:00.000Z', 15),
      battery('before', '2026-11-02T10:10:00.000Z', 60),
    ];
    expect(run(leaf, { landing: [landing], subject: readings })).toMatchObject({
      outcome: 'attention',
      evidence: ['at'],
    });
  });

  it('reads nothing without a valid anchor, so a required read is insufficient', () => {
    const readings = [battery('before', '2026-11-02T10:10:00.000Z', 60)];
    expect(run(leaf, { landing: [], subject: readings })).toMatchObject({ reasonCode: 'required_input_missing' });
    const unclear = record('landing', '2026-11-02T10:30:00.000Z', { landedAt: 'not a time' });
    expect(run(leaf, { landing: [unclear], subject: readings })).toMatchObject({
      reasonCode: 'required_input_missing',
    });
  });

  it('refuses an anchor that is not an earlier read or the subject state', () => {
    const { digest: _, ...content } = leaf;
    const reordered = { ...content, reads: [...content.reads].reverse() };
    expect(checkedRuleProblem({ ...reordered, digest: canonicalDigest(reordered) })).toMatch(
      /not the subject state or an earlier read/,
    );
  });
});

describe('every observation within a window another read records', () => {
  const leaf = defineCheckedRule({
    id: 'example.battery-in-flight',
    version: 1,
    title: 'Battery in flight stays above the floor',
    source,
    target: { subjectKind: 'flight' },
    reads: [
      { name: 'window', type: 'example.report', versions: [1], about: 'target', required: false, select: 'latest' },
      {
        name: 'values',
        type: 'example.battery',
        versions: [1],
        about: 'target',
        required: false,
        select: { within: { read: 'window', startField: 'values.tookOffAt', endField: 'values.landedAt' } },
      },
    ],
    check: {
      kind: windowValuesWithinLimitV1,
      params: {
        field: 'values.level',
        comparison: 'at_least',
        limit: 20,
        coverage: 'required',
        windowSelect: {},
        windowStartField: 'values.tookOffAt',
        windowEndField: 'values.landedAt',
      },
    },
  });
  const battery = (id: string, at: string, level: number) => record(id, at, { level });
  const readings = [
    battery('after', '2026-11-02T10:25:00.000Z', 5),
    battery('landing', '2026-11-02T10:20:00.000Z', 30),
    battery('mid', '2026-11-02T10:10:00.000Z', 40),
    battery('before', '2026-11-02T09:55:00.000Z', 10),
  ];
  const narrowed = (values: Record<string, unknown>) => {
    const inputs = { window: [record('report', '2026-11-02T10:30:00.000Z', values)] };
    return narrowRead(leaf.reads[1]!, readings, inputs).map((item) => item.id);
  };

  it('selects every reading from the start to the end, or to the evaluation while no end is recorded', () => {
    expect(checkedRuleProblem(leaf)).toBeUndefined();
    const window = { tookOffAt: '2026-11-02T10:00:00.000Z', landedAt: '2026-11-02T10:20:00.000Z' };
    expect(narrowed(window)).toEqual(['landing', 'mid']);
    expect(narrowed({ tookOffAt: window.tookOffAt })).toEqual(['after', 'landing', 'mid']);
    expect(narrowed({ landedAt: window.landedAt })).toEqual([]);
    expect(narrowed({ tookOffAt: window.landedAt, landedAt: window.tookOffAt })).toEqual([]);
    const report = record('report', '2026-11-02T10:30:00.000Z', window);
    expect(run(leaf, { window: [report], values: readings })).toMatchObject({
      outcome: 'pass',
      details: { valuesChecked: 2, worstValue: 30 },
    });
  });

  it('refuses a window that is not an earlier read or the subject state', () => {
    const { digest: _, ...content } = leaf;
    const reordered = { ...content, reads: [...content.reads].reverse() };
    expect(checkedRuleProblem({ ...reordered, digest: canonicalDigest(reordered) })).toMatch(
      /not the subject state or an earlier read/,
    );
  });
});

describe('the subject’s own state', () => {
  const leaf = defineCheckedRule({
    id: 'example.evidence-after-end',
    version: 1,
    title: 'Evidence follows the scheduled end',
    source,
    target: { subjectKind: 'flight' },
    reads: [
      { name: 'evidence', type: 'example.landing', versions: [1], about: 'target', required: false, select: 'all' },
    ],
    subjectState: { name: 'state', required: true },
    check: {
      kind: evidenceDueV1,
      params: { fields: ['values.landedAt'], valueType: 'utc_instant', deadlineField: 'scheduledEnd', graceSeconds: 0 },
    },
    applicability: [{ input: 'state', field: 'status', oneOf: ['active', 'landed'], whenAbsent: 'insufficient' }],
  });

  it('reaches the check as an input and can decide applicability', () => {
    const active = state({ status: 'active', scheduledEnd: '2026-11-02T10:00:00.000Z' });
    expect(run(leaf, { state: [active] })).toMatchObject({ outcome: 'attention', reasonCode: 'evidence_overdue' });
    expect(run(leaf, { state: [state({ status: 'planned' })] })).toMatchObject({
      outcome: 'not_applicable',
      reasonCode: 'condition_not_met',
    });
  });

  it('is insufficient when required and Ledger holds no state', () => {
    const optional = { ...leaf, applicability: [] };
    expect(run(optional, {})).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'required_input_missing' });
  });

  it('may anchor a read', () => {
    const anchored = defineCheckedRule({
      id: 'example.evidence-before-end',
      version: 1,
      title: 'Evidence before the scheduled end',
      source,
      target: { subjectKind: 'flight' },
      reads: [
        {
          name: 'evidence',
          type: 'example.landing',
          versions: [1],
          about: 'target',
          required: true,
          select: { latestAtOrBefore: { read: 'state', field: 'scheduledEnd' } },
        },
      ],
      subjectState: { name: 'state', required: true },
      check: { kind: evidenceDueV1, params: leaf.check.params },
    });
    const end = '2026-11-02T10:00:00.000Z';
    const early = record('early', '2026-11-02T09:00:00.000Z', { landedAt: '2026-11-02T09:00:00.000Z' });
    const late = record('late', '2026-11-02T11:00:00.000Z', { landedAt: '2026-11-02T11:00:00.000Z' });
    expect(run(anchored, { state: [state({ scheduledEnd: end })], evidence: [late, early] })).toMatchObject({
      outcome: 'pass',
      evidence: ['early'],
    });
  });
});

describe('wording supplied by the rule', () => {
  const spec = {
    id: 'example.status-worded',
    version: 1,
    title: 'Status is reported',
    source,
    target: { subjectKind: 'flight' as const },
    reads: [
      {
        name: 'note',
        type: 'example.note',
        versions: [1],
        about: 'target' as const,
        required: false,
        select: 'all' as const,
      },
    ],
    subjectState: { name: 'state', required: false },
    check: { kind: reportedStatusV1 },
  };

  it('fills placeholders from the declared details and keeps the result', () => {
    const leaf = defineCheckedRule({ ...spec, wording: { pass: 'The flight is {status}.' } });
    expect(run(leaf, { state: [state({ status: 'landed' })] })).toEqual({
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'status_reported',
      summary: 'The flight is landed.',
      evidence: [],
      details: { status: 'landed' },
    });
  });

  it('falls back to the check’s summary when a named detail is not returned or no wording is given', () => {
    const leaf = defineCheckedRule({ ...spec, wording: { pass: 'Due at {dueAt}.' } });
    expect(run(leaf, { state: [state({ status: 'landed' })] }).summary).toBe('A status is reported.');
    expect(run(leaf, { state: [] }).summary).toBe('No status is reported.');
  });

  it('is refused when a template names a detail the check kind does not declare, or states a verdict', () => {
    expect(() => defineCheckedRule({ ...spec, wording: { pass: 'Seen at {landedAt}.' } })).toThrow(
      /naming landedAt, which check kind example.reported-status does not return/,
    );
    expect(() => defineCheckedRule({ ...spec, wording: { pass: 'The flight is {status' } })).toThrow(/brace/);
    expect(() => defineCheckedRule({ ...spec, wording: { pass: 'The flight is compliant.' } })).toThrow(/verdict/);
    expect(() => defineCheckedRule({ ...spec, wording: { pass: 'Status {status}: go.' } })).toThrow(/verdict/);
    const valid = defineCheckedRule({ ...spec, wording: { pass: 'The flight is {status}.' } });
    const { digest: _, ...content } = valid;
    const tampered = { ...content, wording: { pass: 'Seen at {landedAt}.' } };
    const leaf = { ...tampered, digest: canonicalDigest(tampered) };
    expect(() => registerRulePack({ packId: 'example.worded', versions: [pack('example.worded', [leaf])] })).toThrow(
      /naming landedAt/,
    );
  });

  it('leaves the declared definition of a check kind that declares no details unchanged', () => {
    expect(Object.keys(checkKindDefinition(valueWithinLimitV1))).not.toContain('details');
    expect(checkKindDefinition(reportedStatusV1).details?.map((detail) => detail.name)).toEqual(['status', 'dueAt']);
  });
});
