import { describe, expect, it } from 'vitest';
import {
  localizeInstants,
  summaryRecordValues,
  type RuleEvaluationRecord,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  listCheckKinds,
  registerCheckKind,
  registeredCheckKindDigest,
  type CheckKind,
} from '../../packages/domain/src/check-kinds.js';
import { wordedSummary } from '../../apps/web/src/wording.js';
import { evidenceDueV1 } from '../../packages/domain/src/check-kind-evidence.js';
import { intervalCoversIntersectionV1 } from '../../packages/domain/src/check-kind-library-combined.js';
import { intervalCoversWindowV2 } from '../../packages/domain/src/check-kind-library-records.js';
import { checkSummaryWording, defineCheckedRule, runCheckedRule } from '../../packages/domain/src/checked-rules.js';
import { summaryWordingOf } from '../../packages/domain/src/rule-evaluation-reads.js';

// A check kind's own summary may be filled again at display from the details and times it records. Nothing an evaluation
// records or digests changes: the digests below were taken on the main branch before summary values existed.

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T15:00:00.000Z' };

function observation(id: string, occurredAt: string, fields: Record<string, unknown>, interval?: object) {
  return {
    id,
    type: 'flight.report',
    version: 1,
    occurredAt,
    ...(interval ? { interval } : {}),
    observation: { occurredAt, ...(interval ? { interval } : {}), ...fields },
  };
}

function rule(kind: CheckKind, params: Record<string, unknown>) {
  return defineCheckedRule({
    id: `fictional.${kind.id}`,
    version: 1,
    title: 'Fictional rule',
    source: { kind: 'operator_procedure', reference: 'fictional.procedure', text: 'Review the reports.' },
    target: { subjectKind: 'flight' },
    reads: kind.inputs.map((input) => ({
      name: input.name,
      type: 'flight.report',
      versions: [1],
      about: 'target' as const,
      required: false,
      select: 'all' as const,
    })),
    check: { kind, params },
  });
}

function overdue() {
  const due = { fields: ['values.doneAt'], valueType: 'utc_instant', deadlineField: 'plannedEnd', graceSeconds: 300 };
  const leaf = rule(evidenceDueV1, due);
  const state = observation('state-1', '2026-10-15T14:00:00.000Z', { plannedEnd: '2026-10-15T14:20:00.000Z' });
  return { leaf, outcome: runCheckedRule(leaf, due, { evidence: [], state: [state] }, clock) };
}

function covered() {
  const params = { openEnd: 'stated', whenDisjoint: 'attention' };
  const leaf = rule(intervalCoversIntersectionV1, params);
  const window = (id: string, start: string, end: string) =>
    observation(id, '2026-10-15T09:00:00.000Z', {}, { start, end });
  const outcome = runCheckedRule(
    leaf,
    params,
    {
      interval: [window('duty-1', '2026-10-15T10:00:00.000Z', '2026-10-15T13:00:00.000Z')],
      window: [window('flight-1', '2026-10-15T10:30:00.000Z', '2026-10-15T12:00:00.000Z')],
      otherWindow: [window('site-1', '2026-10-15T11:00:00.000Z', '2026-10-15T12:30:00.000Z')],
    },
    clock,
  );
  return { leaf, outcome };
}

function inEffect() {
  const params = { openEnd: 'stated' };
  const leaf = rule(intervalCoversWindowV2, params);
  const duty = observation(
    'duty-1',
    '2026-10-15T09:00:00.000Z',
    {},
    {
      start: '2026-10-15T10:00:00.000Z',
      end: '2026-10-15T18:00:00.000Z',
    },
  );
  return { leaf, outcome: runCheckedRule(leaf, params, { interval: [duty] }, clock) };
}

describe('a check kind’s own summary as wording', () => {
  it('keeps every registered check kind digest, with record.made-before@1, events.answered-within@1, periods.each-recorded@1, record.in-force@1, values.on-file@1, records.counted@1, records.each-in-force@1, value.recorded-as@1, record.points-total@1 and value.one-of@2 added, and these evaluation results with fields named by their labels', () => {
    const kinds = listCheckKinds()
      .map((kind) => `${kind.id}@${kind.version} ${registeredCheckKindDigest(kind.id, kind.version)}`)
      .sort();
    expect(canonicalDigest(kinds)).toBe('a22ab06a377e66eee547d19b540f79e7be93ee0e15d625dc6ccf83fb3f73e786');
    expect(canonicalDigest(overdue())).toBe('e2b923c28a17b4f8f5f737a005f31f5411f805337aa099148b20171ac76bb50a');
    expect(canonicalDigest(covered())).toBe('4bc6e3a804a62b52b8ae43cdd2a25d4560d1800480f6b7bcf137ee57f1b4e2db');
  });

  it('returns the summary with its times marked, beside the record, only when filling it gives the summary', () => {
    const { leaf, outcome } = overdue();
    expect(outcome.summary).toBe(
      'No valid value is recorded for the done at by 2026-10-15T14:25:00.000Z, 300 seconds after the flight report’s planned end.',
    );
    const record = recordOf(leaf, outcome);
    expect(summaryWordingOf([record])).toEqual({
      fictional:
        'No valid value is recorded for the done at by {dueAt}, 300 seconds after the flight report’s planned end.',
    });
    expect(
      summaryWordingOf([{ ...record, details: { ...record.details, dueAt: '2026-10-15T14:26:00.000Z' } }]),
    ).toEqual({});
    expect(summaryWordingOf([{ ...record, check: { ...record.check, definitionDigest: 'a'.repeat(64) } }])).toEqual({});
  });

  it('marks every time a summary states, or none', () => {
    const { leaf, outcome } = covered();
    const record = recordOf(leaf, outcome);
    expect(summaryWordingOf([record])).toEqual({
      fictional: 'Selected recorded intervals, joined, cover the shared window from {windowStart} to {windowEnd}.',
    });
    expect(summaryWordingOf([{ ...record, summary: `${record.summary} Stated at 2026-10-15T09:00:00.000Z.` }])).toEqual(
      {},
    );
    expect(checkSummaryWording({}, record.summary, record.details)).toBeUndefined();
  });

  it('is filled again on screens through the one wording helper, times in the organization’s time', () => {
    const { leaf, outcome } = overdue();
    const record = recordOf(leaf, outcome);
    const shown = wordedSummary(record.summary, summaryWordingOf([record]).fictional, record.details);
    expect(shown).not.toContain('2026-10-15T14:25:00.000Z');
    expect(shown).toMatch(
      /^No valid value is recorded for the done at by .+ CT, 300 seconds after the flight report’s planned end\.$/,
    );
    expect(wordedSummary(record.summary, undefined, record.details)).toBe(record.summary);
  });

  it('marks an instant the record holds besides its details, and fills it on screens from the record', () => {
    const { leaf, outcome } = inEffect();
    expect(outcome.summary).toBe('A recorded interval is in effect until 2026-10-15T18:00:00.000Z.');
    const record = recordOf(leaf, outcome);
    const template = summaryWordingOf([record]).fictional;
    expect(template).toBe('A recorded interval is in effect until {nextBoundary}.');
    expect(wordedSummary(record.summary, template, summaryRecordValues(record))).toMatch(
      /^A recorded interval is in effect until .+ CT\.$/,
    );
    expect(summaryWordingOf([{ ...record, nextBoundary: '2026-10-15T19:00:00.000Z' }])).toEqual({});
  });

  it('marks the times of a summary recorded in the organization’s zone, as an evaluation records it', () => {
    const { leaf, outcome } = overdue();
    const zone = 'America/Denver';
    const record = {
      ...recordOf(leaf, outcome),
      summary: localizeInstants(outcome.summary, zone),
      clock: { ...clock, timeZone: zone },
    } as RuleEvaluationRecord;
    expect(record.summary).toBe(
      'No valid value is recorded for the done at by 2026-10-15 08:25 America/Denver, 300 seconds after the flight report’s planned end.',
    );
    expect(summaryWordingOf([record])).toEqual({
      fictional:
        'No valid value is recorded for the done at by {dueAt}, 300 seconds after the flight report’s planned end.',
    });
    // Recorded in another zone than the record says, the summary is shown as recorded.
    expect(summaryWordingOf([{ ...record, clock: { ...clock, timeZone: 'UTC' } }])).toEqual({});
  });

  it('refuses a summary value that is not a declared detail', () => {
    expect(() => registerCheckKind({ ...evidenceDueV1, id: 'fictional.due', summaryValues: ['deadline'] })).toThrow(
      /summary value deadline is not a declared detail/,
    );
  });
});

function recordOf(leaf: ReturnType<typeof rule>, outcome: ReturnType<typeof runCheckedRule>): RuleEvaluationRecord {
  return {
    id: 'fictional',
    pack: { id: 'fictional.pack', version: 1, digest: 'b'.repeat(64) },
    rule: { id: leaf.id, digest: leaf.digest },
    check: { kind: leaf.check.kind, version: leaf.check.version, definitionDigest: leaf.check.definitionDigest },
    outcome: outcome.outcome,
    summary: outcome.summary,
    details: outcome.details,
    evidence: outcome.evidence.map((observationId) => ({ observationId, occurredAt: '2026-10-15T09:00:00.000Z' })),
    ...(outcome.nextBoundary ? { nextBoundary: outcome.nextBoundary } : {}),
  } as unknown as RuleEvaluationRecord;
}
