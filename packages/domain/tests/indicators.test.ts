import { describe, expect, it } from 'vitest';
import { INDICATOR_LIMITS, type IndicatorDefinition, type SubjectReference } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { IndicatorObservation } from '../src/indicator-exposure-kinds.js';
import {
  calculateIndicator,
  defineIndicator,
  findIndicatorDefinition,
  registerIndicatorDefinition,
  type IndicatorCalculationInput,
  type IndicatorDefinitionSpec,
  type IndicatorEvent,
  issueEvents,
  type IssueEvaluation,
} from '../src/indicators.js';

// The example definition exists only in this test: made-up readings of a made-up type, per flight hour.
const tails = ['tail-1', 'tail-2'].map((id): SubjectReference => ({
  scope: 'source',
  kind: 'aircraft',
  id,
  sourceId: 'made-up-log',
}));
const spec: IndicatorDefinitionSpec = {
  id: 'made-up.severe-readings-per-flight-hour',
  version: 1,
  title: 'Severe made-up readings per 100 flight hours',
  description: 'Made-up readings of severe or worse, per 100 reported flight hours.',
  scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
  events: {
    kind: 'observations',
    type: 'made-up.reading',
    versions: [1],
    condition: { field: 'values.severity', operator: 'one_of', values: ['severe', 'extreme'] },
  },
  exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
  window: { maxMilliseconds: 31 * 24 * 60 * 60 * 1000 },
  completeness: { exposureMustExceed: '1', populationDeclaredComplete: true, coverageWithoutGaps: true },
  unit: { per: 100, label: 'per 100 flight hours', fractionDigits: 3 },
};
const definition = defineIndicator(spec);

function observation(
  id: string,
  type: string,
  subjects: SubjectReference[],
  occurredAt: string,
  values: Record<string, unknown>,
): IndicatorObservation {
  return { id, type, version: 1, occurredAt, subjects, observation: { type, version: 1, occurredAt, values } };
}
function reading(id: string, tail: number, occurredAt: string, severity: string): IndicatorEvent {
  return { kind: 'observation', ...observation(id, 'made-up.reading', [tails[tail]!], occurredAt, { severity }) };
}
function flight(id: string, tail: number, takeoffAt: string, landingAt?: string): IndicatorObservation {
  const subjects: SubjectReference[] = [
    { scope: 'source', kind: 'flight', id: `flight-${id}`, sourceId: 'made-up-log' },
    tails[tail]!,
  ];
  return observation(id, 'flight.report', subjects, takeoffAt, { takeoffAt, ...(landingAt ? { landingAt } : {}) });
}

// Two hours of reported flight in the window.
const flights = [
  flight('f1', 0, '2026-11-03T08:00:00.000Z', '2026-11-03T09:00:00.000Z'),
  flight('f2', 1, '2026-11-04T08:00:00.000Z', '2026-11-04T09:00:00.000Z'),
];
function input(overrides: Partial<IndicatorCalculationInput> = {}): IndicatorCalculationInput {
  return {
    window: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-08T00:00:00.000Z' },
    recordedThrough: '2026-11-09T00:00:00.000Z',
    control: { id: 'made-up-control', version: 1 },
    population: { subjects: tails, complete: true, declaredBy: { kind: 'person', id: 'safety-lead' } },
    selection: { complete: true, exceeded: [] },
    events: [],
    exposure: flights,
    ...overrides,
  };
}

describe('indicator definitions', () => {
  it('are data pinned by digest, with the exposure kind pinned by its own digest', () => {
    const { digest, ...content } = definition;
    expect(digest).toBe(canonicalDigest(content));
    expect(definition).toMatchObject({
      format: 'ledger.indicator-definition.1',
      exposure: { kind: 'exposure.flight-hours' },
    });
    expect(definition.exposure.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('register once per id and version, and refuse a changed or unverifiable definition', () => {
    registerIndicatorDefinition(definition);
    registerIndicatorDefinition(structuredClone(definition));
    expect(findIndicatorDefinition(definition.id, 1)).toEqual(definition);
    const changed = defineIndicator({ ...spec, title: 'Changed title' });
    expect(() => registerIndicatorDefinition(changed)).toThrow(/already registered/);
    expect(() => registerIndicatorDefinition({ ...definition, title: 'Tampered' })).toThrow(/digest/);
    expect(() => defineIndicator({ ...spec, exposure: { kind: 'exposure.unknown', version: 1, params: {} } })).toThrow(
      /not registered/,
    );
    expect(() =>
      defineIndicator({ ...spec, exposure: { kind: 'exposure.flight-hours', version: 1, params: { x: 1 } } }),
    ).toThrow(/parameters/);
    const pinned: IndicatorDefinition = {
      ...definition,
      exposure: { ...definition.exposure, definitionDigest: 'a'.repeat(64) },
    };
    const { digest: _digest, ...content } = pinned;
    expect(() => registerIndicatorDefinition({ ...pinned, digest: canonicalDigest(content) })).toThrow(
      /not registered with that digest/,
    );
  });
});

describe('the indicator calculation', () => {
  it('states a zero rate for zero events over adequate exposure', () => {
    const result = calculateIndicator(
      definition,
      input({ events: [reading('e1', 0, '2026-11-03T08:30:00.000Z', 'light')] }),
    );
    expect(result).toMatchObject({
      version: 'ledger.indicator-result.1',
      status: 'supported',
      eventCount: 0,
      exposure: { value: { numerator: '2', denominator: '1' }, decimal: '2.000', unit: 'flight_hour', gaps: [] },
      rate: { value: { numerator: '0', denominator: '1' }, decimal: '0.000', per: 100, label: 'per 100 flight hours' },
      reasons: [],
      control: { id: 'made-up-control', version: 1 },
      definition: { id: definition.id, version: 1, digest: definition.digest },
      counted: { events: [], exposure: ['f1', 'f2'] },
    });
  });

  it('is insufficient, never a zero rate, for zero events with unknown exposure', () => {
    const none = calculateIndicator(definition, input({ exposure: [] }));
    expect(none).toMatchObject({
      status: 'insufficient',
      eventCount: 0,
      rate: null,
      reasons: ['exposure_not_positive'],
    });
    // A flight with no reported landing leaves exposure unknown even though other flights are measured.
    const open = calculateIndicator(
      definition,
      input({ exposure: [...flights, flight('f3', 0, '2026-11-05T08:00:00.000Z')] }),
    );
    expect(open).toMatchObject({ status: 'insufficient', rate: null, reasons: ['exposure_coverage_gaps'] });
    expect(open.exposure.gaps).toEqual([
      { code: 'landing_unreported', subjectKey: 'source/made-up-log/flight/flight-f3', observationIds: ['f3'] },
    ]);
  });

  it('is insufficient when exposure is not above the declared minimum', () => {
    const result = calculateIndicator(definition, input({ exposure: [flights[0]!] }));
    expect(result).toMatchObject({ status: 'insufficient', rate: null, reasons: ['exposure_not_above_minimum'] });
    expect(result.exposure.decimal).toBe('1.000');
  });

  it('is conflicting when inputs disagree, and states no rate', () => {
    const disagreeing = flight('f1b', 0, '2026-11-03T08:00:00.000Z', '2026-11-03T09:30:00.000Z');
    const flightConflict = calculateIndicator(
      definition,
      input({ exposure: [...flights, { ...disagreeing, subjects: flights[0]!.subjects }] }),
    );
    expect(flightConflict).toMatchObject({
      status: 'conflicting',
      rate: null,
      reasons: ['exposure_conflicting', 'exposure_not_above_minimum'],
    });
    expect(flightConflict.exposure.conflicts[0]).toMatchObject({ code: 'landing_reports_disagree' });
    const identity = calculateIndicator(
      definition,
      input({
        events: [
          reading('e1', 0, '2026-11-03T08:30:00.000Z', 'severe'),
          reading('e1', 0, '2026-11-03T08:30:00.000Z', 'light'),
        ],
      }),
    );
    expect(identity).toMatchObject({ status: 'conflicting', reasons: ['event_identity_conflict'] });
  });

  it('scales the exact rate and rounds only its decimal form', () => {
    const events = [
      reading('e1', 0, '2026-11-03T08:30:00.000Z', 'severe'),
      reading('e2', 1, '2026-11-04T08:30:00.000Z', 'extreme'),
      reading('e3', 1, '2026-11-04T08:40:00.000Z', 'light'),
      reading('e4', 1, '2026-11-09T08:40:00.000Z', 'severe'),
    ];
    const per100 = calculateIndicator(definition, input({ events }));
    expect(per100).toMatchObject({
      status: 'supported',
      eventCount: 2,
      rate: { value: { numerator: '100', denominator: '1' }, decimal: '100.000' },
      counted: { events: ['e1', 'e2'] },
    });
    const perHour = defineIndicator({
      ...spec,
      id: 'made-up.severe-readings-per-hour',
      completeness: { ...spec.completeness, exposureMustExceed: '0' },
      unit: { per: 1, label: 'per flight hour', fractionDigits: 3 },
    });
    const third = calculateIndicator(
      perHour,
      input({
        events: [events[0]!],
        exposure: [...flights, flight('f3', 0, '2026-11-05T08:00:00.000Z', '2026-11-05T09:00:00.000Z')],
      }),
    );
    expect(third.rate).toEqual({
      value: { numerator: '1', denominator: '3' },
      decimal: '0.333',
      per: 1,
      label: 'per flight hour',
    });
  });

  it('digests exactly the identifiers counted, independent of input order', () => {
    const events = [
      reading('e1', 0, '2026-11-03T08:30:00.000Z', 'severe'),
      reading('e2', 1, '2026-11-04T08:30:00.000Z', 'severe'),
    ];
    const first = calculateIndicator(definition, input({ events }));
    const reordered = calculateIndicator(
      definition,
      input({ events: [...events].reverse(), exposure: [...flights].reverse() }),
    );
    expect(reordered).toEqual(first);
    // An event outside the window or the condition is not counted and leaves the digest alone.
    const ignored = calculateIndicator(
      definition,
      input({ events: [...events, reading('e9', 0, '2026-11-03T08:31:00.000Z', 'light')] }),
    );
    expect(ignored.inputDigest).toBe(first.inputDigest);
    const fewer = calculateIndicator(definition, input({ events: [events[0]!] }));
    expect(fewer.inputDigest).not.toBe(first.inputDigest);
    const otherControl = calculateIndicator(
      definition,
      input({ events, control: { id: 'made-up-control', version: 2 } }),
    );
    expect(otherControl.inputDigest).not.toBe(first.inputDigest);
    // Calculating twice gives the same result.
    expect(calculateIndicator(definition, input({ events }))).toEqual(first);
  });

  it('counts only subjects in the declared population and requires it declared complete', () => {
    const outsider: SubjectReference = { scope: 'source', kind: 'aircraft', id: 'tail-9', sourceId: 'made-up-log' };
    const result = calculateIndicator(
      definition,
      input({
        events: [
          {
            kind: 'observation',
            ...observation('e1', 'made-up.reading', [outsider], '2026-11-03T08:30:00.000Z', { severity: 'severe' }),
          },
        ],
      }),
    );
    expect(result).toMatchObject({ status: 'supported', eventCount: 0 });
    const undeclared = calculateIndicator(
      definition,
      input({ population: { subjects: tails, complete: false, declaredBy: null } }),
    );
    expect(undeclared).toMatchObject({ status: 'insufficient', reasons: ['population_not_declared_complete'] });
    const wrongKind = calculateIndicator(
      definition,
      input({
        population: { ...input().population, subjects: [...tails, { scope: 'ledger', kind: 'person', id: 'p1' }] },
      }),
    );
    expect(wrongKind).toMatchObject({ status: 'insufficient', reasons: ['population_outside_scope'] });
  });

  it('is insufficient when the selection was incomplete or the window was still open at the cut', () => {
    expect(
      calculateIndicator(definition, input({ selection: { complete: false, exceeded: ['events'] } })),
    ).toMatchObject({ status: 'insufficient', reasons: ['selection_incomplete'] });
    expect(calculateIndicator(definition, input({ recordedThrough: '2026-11-07T00:00:00.000Z' }))).toMatchObject({
      status: 'insufficient',
      reasons: ['window_open_at_cut'],
    });
  });

  it('counts findings the named rule opened, by the time they were opened', () => {
    const findings = defineIndicator({
      ...spec,
      id: 'made-up.finding-rate',
      events: { kind: 'findings', packId: 'made-up.pack', ruleId: 'made-up.rule' },
    });
    const finding = (id: string, openedAt: string, ruleId = 'made-up.rule'): IndicatorEvent => ({
      kind: 'finding',
      id,
      subject: tails[0]!,
      packId: 'made-up.pack',
      ruleId,
      openedAt,
    });
    const result = calculateIndicator(
      findings,
      input({
        events: [
          finding('finding-1', '2026-11-03T09:00:00.000Z'),
          finding('finding-2', '2026-11-03T09:00:00.000Z', 'made-up.other-rule'),
          finding('finding-3', '2026-10-30T09:00:00.000Z'),
        ],
      }),
    );
    expect(result).toMatchObject({ status: 'supported', eventCount: 1, counted: { events: ['finding-1'] } });
    expect(result.rate?.decimal).toBe('50.000');
  });

  it('places a finding or an issue opened on a plan in the window the plan is about, not the one it opened in', () => {
    const findings = defineIndicator({
      ...spec,
      id: 'made-up.plan-finding-rate',
      events: { kind: 'findings', packId: 'made-up.pack', ruleId: 'made-up.rule' },
    });
    // Opened inside this window on a plan about the next one; opened before this window on a plan about it.
    const planned = (id: string, openedAt: string, plannedFrom: string): IndicatorEvent => ({
      kind: 'finding',
      id,
      subject: tails[0]!,
      packId: 'made-up.pack',
      ruleId: 'made-up.rule',
      openedAt,
      plannedFrom,
    });
    const events = [
      planned('for-next-week', '2026-11-07T20:00:00.000Z', '2026-11-08T09:00:00.000Z'),
      planned('for-this-week', '2026-10-31T20:00:00.000Z', '2026-11-02T09:00:00.000Z'),
    ];
    expect(calculateIndicator(findings, input({ events }))).toMatchObject({ counted: { events: ['for-this-week'] } });
    const next = { start: '2026-11-08T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z' };
    expect(
      calculateIndicator(findings, input({ events, window: next, recordedThrough: '2026-11-16T00:00:00.000Z' })),
    ).toMatchObject({ counted: { events: ['for-next-week'] } });

    const rule = { packId: 'made-up.pack', ruleId: 'made-up.rule' };
    const [issue] = issueEvents(rule, tails[0]!, [
      {
        recordedAt: '2026-11-07T20:00:00.000Z',
        clock: { mode: 'wall', evaluatedAt: '2026-11-07T20:00:00.000Z' },
        evidenceState: 'supported',
        issues: ['unlisted'],
        readAsPlans: { from: '2026-11-08T09:00:00.000Z', observationIds: ['plan-1'] },
      },
    ]);
    expect(issue!.time).toEqual({ placedBy: 'evaluation', start: '2026-11-08T09:00:00.000Z' });
  });

  it('counts each issue a rule named once, placed by when it happened', () => {
    const issues = defineIndicator({
      ...spec,
      id: 'made-up.issue-rate',
      events: { kind: 'issues', packId: 'made-up.pack', ruleId: 'made-up.rule' },
    });
    const evaluation = (
      recordedAt: string,
      times: { issue: string; start?: string; end?: string; endUnknown?: true }[],
      evidenceState: IssueEvaluation['evidenceState'] = 'insufficient',
    ): IssueEvaluation => ({
      recordedAt,
      clock: { mode: 'wall', evaluatedAt: recordedAt },
      evidenceState,
      issues: times.map((time) => time.issue),
      issueTimes: times.flatMap(({ start, ...rest }) => (start ? [{ ...rest, start }] : [])),
    });
    const rule = { packId: 'made-up.pack', ruleId: 'made-up.rule' };
    const events = issueEvents(rule, tails[0]!, [
      // Begun before the window and ended inside it: counted, once, as the latest evaluation places it.
      evaluation('2026-10-31T23:00:01.000Z', [{ issue: 'a', start: '2026-10-31T23:00:00.000Z' }]),
      evaluation(
        '2026-11-01T01:00:01.000Z',
        [{ issue: 'a', start: '2026-10-31T23:00:00.000Z', end: '2026-11-01T01:00:00.000Z' }],
        'supported',
      ),
      // Begun and ended before the window: not counted.
      evaluation('2026-10-30T00:00:01.000Z', [
        { issue: 'b', start: '2026-10-29T00:00:00.000Z', end: '2026-10-30T00:00:00.000Z' },
      ]),
      // No time from the kind: placed by the evaluation that first named it.
      evaluation('2026-11-02T00:00:01.000Z', [{ issue: 'c' }]),
      evaluation('2026-11-09T00:00:02.000Z', [{ issue: 'c' }]),
    ]);
    expect(Object.fromEntries(events.map((event) => [event.issue, event.time]))).toEqual({
      a: { placedBy: 'issue', start: '2026-10-31T23:00:00.000Z', end: '2026-11-01T01:00:00.000Z' },
      b: { placedBy: 'issue', start: '2026-10-29T00:00:00.000Z', end: '2026-10-30T00:00:00.000Z' },
      c: { placedBy: 'evaluation', start: '2026-11-02T00:00:01.000Z' },
    });
    const result = calculateIndicator(issues, input({ events }));
    expect(result).toMatchObject({ status: 'supported', eventCount: 2, eventsPlacedBy: ['evaluation', 'issue'] });
    expect(result.rate?.decimal).toBe('100.000');
    // The same issue of another rule or of a subject outside the population is not counted.
    const other = issueEvents({ ...rule, ruleId: 'made-up.other-rule' }, tails[0]!, [
      evaluation('2026-11-02T00:00:01.000Z', [{ issue: 'c' }]),
    ]);
    const outside = issueEvents(rule, { scope: 'ledger', kind: 'aircraft', id: 'tail-9' }, [
      evaluation('2026-11-02T00:00:01.000Z', [{ issue: 'c' }]),
    ]);
    expect(calculateIndicator(issues, input({ events: [...events, ...other, ...outside] })).eventCount).toBe(2);
    // An issue begun before the window whose end is unknown cannot be placed.
    const unplaced = issueEvents(rule, tails[1]!, [
      evaluation('2026-10-31T00:00:01.000Z', [{ issue: 'd', start: '2026-10-31T00:00:00.000Z', endUnknown: true }]),
    ]);
    expect(calculateIndicator(issues, input({ events: [...events, ...unplaced] }))).toMatchObject({
      status: 'insufficient',
      rate: null,
      reasons: ['event_time_undetermined'],
    });
    // One that continues from before the window is in it.
    const continuing = issueEvents(rule, tails[1]!, [
      evaluation('2026-10-31T00:00:01.000Z', [{ issue: 'e', start: '2026-10-31T00:00:00.000Z' }]),
    ]);
    expect(calculateIndicator(issues, input({ events: [...events, ...continuing] })).eventCount).toBe(3);
    // An issue in the window whose latest naming evaluation conflicts makes the result conflicting.
    const conflicting = issueEvents(rule, tails[1]!, [
      evaluation('2026-11-03T00:00:01.000Z', [{ issue: 'f', start: '2026-11-03T00:00:00.000Z' }], 'conflicting'),
    ]);
    expect(calculateIndicator(issues, input({ events: [...events, ...conflicting] }))).toMatchObject({
      status: 'conflicting',
      reasons: ['event_evidence_conflicting'],
    });
    // Evaluations still due make it insufficient.
    expect(
      calculateIndicator(issues, input({ events, selection: { complete: true, exceeded: [], pending: true } })),
    ).toMatchObject({ status: 'insufficient', reasons: ['evaluations_pending'] });
    // Evaluations recorded after the cut are stated as a limitation, not a change of status.
    expect(
      calculateIndicator(
        issues,
        input({ events, selection: { complete: true, exceeded: [], evaluatedAfterCut: true } }),
      ),
    ).toMatchObject({ status: 'supported', eventCount: 2, limitations: ['evaluations_recorded_after_cut'] });
  });

  it('counts issues across several rules, each issue once or each subject once', () => {
    const rules = [
      { packId: 'made-up.pack', ruleId: 'made-up.at-start' },
      { packId: 'made-up.pack', ruleId: 'made-up.throughout' },
    ];
    const selection = { kind: 'issues' as const, ...rules[0]!, alsoRules: [rules[1]!] };
    const perIssue = defineIndicator({ ...spec, id: 'made-up.issues-across-rules', events: selection });
    const perSubject = defineIndicator({
      ...spec,
      id: 'made-up.subjects-across-rules',
      events: { ...selection, countEach: 'subject' },
    });
    const named = (issue: string, start: string, evidenceState: IssueEvaluation['evidenceState'] = 'supported') => ({
      recordedAt: start,
      clock: { mode: 'wall' as const, evaluatedAt: start },
      evidenceState,
      issues: [issue],
      issueTimes: [{ issue, start, end: start }],
    });
    const events = [
      // tail-1: one issue at the start and two in the window under the second rule.
      ...issueEvents(rules[0]!, tails[0]!, [named('a', '2026-11-03T09:00:00.000Z')]),
      ...issueEvents(rules[1]!, tails[0]!, [
        named('b', '2026-11-03T09:05:00.000Z'),
        named('c', '2026-11-03T09:20:00.000Z'),
      ]),
      // tail-2: one issue, and one under a rule the selection does not name.
      ...issueEvents(rules[1]!, tails[1]!, [named('a', '2026-11-04T09:00:00.000Z')]),
      ...issueEvents({ ...rules[0]!, ruleId: 'made-up.other' }, tails[1]!, [named('z', '2026-11-04T09:00:00.000Z')]),
    ];
    expect(calculateIndicator(perIssue, input({ events }))).toMatchObject({ status: 'supported', eventCount: 4 });
    const subjects = calculateIndicator(perSubject, input({ events }));
    expect(subjects).toMatchObject({ status: 'supported', eventCount: 2, eventsPlacedBy: ['issue'] });
    expect(subjects.counted.events).toHaveLength(2);
    expect(subjects.counted.events.every((id) => id.startsWith('subject:'))).toBe(true);
    // An issue that cannot be placed matters only for a subject no other issue counts.
    const unplaced = issueEvents(rules[1]!, tails[0]!, [
      {
        ...named('d', '2026-10-31T00:00:00.000Z'),
        issueTimes: [{ issue: 'd', start: '2026-10-31T00:00:00.000Z', endUnknown: true as const }],
      },
    ]);
    expect(calculateIndicator(perSubject, input({ events: [...events, ...unplaced] }))).toMatchObject({
      status: 'supported',
      eventCount: 2,
    });
    expect(calculateIndicator(perIssue, input({ events: [...events, ...unplaced] }))).toMatchObject({
      status: 'insufficient',
      reasons: ['event_time_undetermined'],
    });
  });

  it('refuses unbounded or malformed inputs', () => {
    expect(() =>
      calculateIndicator(
        definition,
        input({ window: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-15T00:00:00.000Z' } }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      calculateIndicator(
        definition,
        input({ window: { start: '2026-11-08T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' } }),
      ),
    ).toThrow(TypeError);
    const many = Array.from({ length: INDICATOR_LIMITS.maxEvents + 1 }, (_, index) =>
      reading(`e${index}`, 0, '2026-11-03T08:30:00.000Z', 'severe'),
    );
    expect(() => calculateIndicator(definition, input({ events: many }))).toThrow(RangeError);
    expect(() => calculateIndicator({ ...definition, title: 'Tampered' }, input())).toThrow(/digest/);
  });
});
