import { describe, expect, it } from 'vitest';
import type {
  CommandLinkInput,
  IndicatorResult,
  MonitoringReportSource,
  MonitoringReportSourceV2,
  ResolvedCommandLinkBaseline,
  SubjectReference,
} from '../../packages/contracts/src/index.js';
import {
  baselineEvidence,
  baselineSource,
  monitoringRecord,
  monitoringRecordV2,
  monitoringSource,
  monitoringSourceV2,
  resolvedBaseline,
} from '../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import type { CheckObservation } from '../../packages/domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../packages/domain/src/checked-rules.js';
import type { IndicatorObservation } from '../../packages/domain/src/indicator-exposure-kinds.js';
import { calculateIndicator, issueEvents, type IssueEvaluation } from '../../packages/domain/src/indicators.js';
import { commandLinkLossesPerFlightHourV1 } from '../../packages/domain/src/rules/demo-command-link-indicator-v1.js';
import { commandLinkLossLeafV2 } from '../../packages/domain/src/rules/demo-command-link-v2.js';
import '../../packages/domain/src/rules/demo-procedures-pack.js';

// The command-link losses indicator over the monitoring windows a source reports for an accepted control: each
// command-link report as the link.status transition the adapter records, the monitor's coverage as link.status
// samples, and the observed airborne interval as a flight report. The numbers are those the retired draft
// control-effectiveness calculation stated for the same windows; calculations recorded under it stay as retained
// history, and the indicator gives the same numbers.

/** A command-link report as retained: the input, its receipt identity and its processing state. */
interface Report {
  eventId: string;
  receiptId: string;
  recordedAt: string;
  input: CommandLinkInput & {
    subject: { flightId: string };
    payload: { sourceEventId: string; incidentId: string; aircraftId: string; status: 'lost' | 'restored' };
  };
  processing: 'pending' | 'completed' | 'failed';
}
/** A monitoring window with the command-link evidence selected for it. */
interface Input {
  control: { controlId: string; controlVersion: number };
  clock: { mode: 'wall'; evaluatedAt: string };
  monitoring: { record: { sourceId: string; source: MonitoringReportSource | MonitoringReportSourceV2 } };
  c2Reports: Report[];
  c2Baselines?: ResolvedCommandLinkBaseline[];
  selection: { complete: boolean };
}
type Scope = Input['monitoring']['record']['source']['flights'][number];

function report(
  source: MonitoringReportSource | MonitoringReportSourceV2,
  sourceEventId: string,
  status: 'lost' | 'restored',
  occurredAt: string,
  incidentId: string,
): Report {
  const flight = source.flights[0]!;
  return {
    eventId: `fixture-${sourceEventId}-event`,
    receiptId: `fixture-${sourceEventId}-receipt`,
    recordedAt: new Date(Date.parse(occurredAt) + 1000).toISOString(),
    input: {
      sourceId: flight.c2SourceId,
      sourceSessionId: flight.c2SourceSessionId,
      kind: 'command-link.status',
      occurredAt,
      subject: { flightId: flight.flightId },
      artifactId: `fixture-status-${sourceEventId}-original`,
      fidelity: 'synthetic_contract',
      payload: { sourceEventId, incidentId, aircraftId: flight.aircraftId, status },
    },
    processing: 'completed',
  };
}
const control = {
  controlId: monitoringSource.control.controlId,
  controlVersion: monitoringSource.control.controlVersion,
};
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T14:20:03Z' };
/** A version 1 window: the session history before it reported a loss and its restoration. */
function resolved(source: MonitoringReportSource, c2Reports?: Report[]): Input {
  return {
    control,
    clock,
    monitoring: { record: { sourceId: monitoringRecord.sourceId, source } },
    c2Reports: c2Reports ?? [
      report(source, 'baseline-loss', 'lost', '2026-10-15T14:13:00Z', 'fixture-baseline-incident'),
      report(source, 'baseline-restoration', 'restored', '2026-10-15T14:14:00Z', 'fixture-baseline-incident'),
    ],
    selection: { complete: true },
  };
}
/** A version 2 window: the session opened with a native baseline. */
function resolvedV2(baseline: ResolvedCommandLinkBaseline = baselineEvidence, c2Reports: Report[] = []): Input {
  return {
    control,
    clock,
    monitoring: { record: { sourceId: monitoringRecordV2.sourceId, source: monitoringSourceV2 } },
    c2Reports,
    c2Baselines: [baseline],
    selection: { complete: true },
  };
}
const flight = monitoringSource.flights[0]!;
const window = monitoringSource.window;
const carryInReports = (source: MonitoringReportSource | MonitoringReportSourceV2, incidentId: string) => [
  report(source, 'baseline-loss', 'lost', '2026-10-15T14:14:00Z', incidentId),
  report(source, 'baseline-restoration', 'restored', '2026-10-15T14:16:00Z', incidentId),
];
const supportedInput = resolved(monitoringSource);
const cases = {
  carryIn: resolved(monitoringSource, carryInReports(monitoringSource, 'fixture-baseline-incident')),
  carryInV2: resolvedV2(baselineEvidence, carryInReports(monitoringSourceV2, 'fixture-native-incident')),
  noExposure: resolved({ ...monitoringSource, flights: [{ ...flight, observedIntervals: [] }] }),
  missingCoverage: resolved({ ...monitoringSource, flights: [{ ...flight, coverageIntervals: null }] }),
  c2Gap: resolved({
    ...monitoringSource,
    flights: [
      {
        ...flight,
        gaps: [{ kind: 'c2_monitor', interval: { start: '2026-10-15T14:17:00Z', end: '2026-10-15T14:18:00Z' } }],
      },
    ],
  }),
  incompletePopulation: resolved({ ...monitoringSource, populationComplete: false }),
  telemetryDeliveryGap: resolved({
    ...monitoringSource,
    flights: [{ ...flight, gaps: [{ kind: 'telemetry_delivery', interval: window }] }],
  }),
  pending: (() => {
    const input = resolved(monitoringSource);
    input.c2Reports[1]!.processing = 'pending';
    return input;
  })(),
  down: resolvedV2(resolvedBaseline({ ...baselineSource, state: 'down' })),
  unknown: resolvedV2(resolvedBaseline({ ...baselineSource, state: 'unknown' })),
};

const definition = commandLinkLossesPerFlightHourV1();
const rule = { packId: 'ledger.demo-procedures', ruleId: commandLinkLossLeafV2.id };
const SAMPLE_EVERY = 30_000;
const flightSubject = (flightId: string): SubjectReference => ({ scope: 'ledger', kind: 'flight', id: flightId });

function linkStatus(
  id: string,
  flightId: string,
  aircraftId: string,
  occurredAt: string,
  values: Record<string, unknown>,
  session: { sourceId: string; sourceSessionId: string; sourceEventId: string },
): CheckObservation & IndicatorObservation {
  const at = new Date(Date.parse(occurredAt)).toISOString();
  return {
    id,
    sourceId: session.sourceId,
    type: 'link.status',
    version: 1,
    occurredAt: at,
    subjects: [flightSubject(flightId)],
    observation: {
      type: 'link.status',
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      secondarySubject: { kind: 'aircraft', id: aircraftId, scope: 'source' },
      occurredAt: at,
      sourceEventId: session.sourceEventId,
      sourceSessionId: session.sourceSessionId,
      values: { link: 'command_control', ...values },
    },
  };
}

/** A command-link report as the adapter records it: one link.status transition. */
function transition(report: Report) {
  const { input } = report;
  return linkStatus(
    report.eventId,
    input.subject.flightId,
    input.payload.aircraftId,
    input.occurredAt,
    {
      state: input.payload.status === 'lost' ? 'down' : 'up',
      report: 'transition',
      sourceEpisodeId: input.payload.incidentId,
    },
    { sourceId: input.sourceId, sourceSessionId: input.sourceSessionId, sourceEventId: input.payload.sourceEventId },
  );
}

function union(intervals: { start: string; end: string }[]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of intervals
    .map(({ start, end }): [number, number] => [Date.parse(start), Date.parse(end)])
    .sort((left, right) => left[0] - right[0]))
    if (merged.length && start <= merged.at(-1)![1]) merged.at(-1)![1] = Math.max(merged.at(-1)![1], end);
    else merged.push([start, end]);
  return merged;
}

/**
 * The link state a monitor would sample at an instant: as the latest report or baseline at or before it says, down
 * within a reported loss naming its episode, unknown before anything was reported.
 */
function stateAt(input: Input, scope: Scope, at: number): Record<string, unknown> {
  const reports = [
    ...input.c2Reports.map((report) => ({
      at: Date.parse(report.input.occurredAt),
      flightId: report.input.subject.flightId,
      values:
        report.input.payload.status === 'lost'
          ? { state: 'down', sourceEpisodeId: report.input.payload.incidentId }
          : { state: 'up' },
    })),
    ...(input.c2Baselines ?? []).map((baseline) => ({
      at: Date.parse(baseline.input.occurredAt),
      flightId: baseline.input.subject.flightId,
      values: { state: baseline.input.payload.state },
    })),
  ].filter((report) => report.flightId === scope.flightId && report.at <= at);
  const latest = Math.max(...reports.map((report) => report.at));
  return reports.findLast((report) => report.at === latest)?.values ?? { state: 'unknown' };
}

/** The monitor's coverage as samples every thirty seconds, none inside a gap it declared. */
function samples(input: Input, scope: Scope): IndicatorObservation[] {
  const gaps = scope.gaps.filter((gap) => gap.kind === 'c2_monitor').map((gap) => gap.interval);
  const inGap = (at: number) => gaps.some((gap) => at >= Date.parse(gap.start) && at <= Date.parse(gap.end));
  return union(scope.coverageIntervals ?? []).flatMap(([start, end]) => {
    const times: number[] = [];
    for (let at = start; at <= end; at += SAMPLE_EVERY) if (!inGap(at)) times.push(at);
    return times.map((at) =>
      linkStatus(
        `sample:${scope.flightId}:${at}`,
        scope.flightId,
        scope.aircraftId,
        new Date(at).toISOString(),
        { ...stateAt(input, scope, at), report: 'sample' },
        { sourceId: scope.c2SourceId, sourceSessionId: scope.c2SourceSessionId, sourceEventId: `sample:${at}` },
      ),
    );
  });
}

/** The observed airborne interval as one flight report with its takeoff and landing. */
function flightReport(scope: Scope): IndicatorObservation[] {
  const observed = union(scope.observedIntervals);
  if (!observed.length) return [];
  if (observed.length > 1) throw new Error('A flight report states one takeoff and one landing');
  const [takeoffAt, landingAt] = observed[0]!.map((at) => new Date(at).toISOString());
  return [
    {
      id: `flight-report:${scope.flightId}`,
      type: 'flight.report',
      version: 1,
      occurredAt: landingAt!,
      subjects: [flightSubject(scope.flightId)],
      observation: { type: 'flight.report', version: 1, occurredAt: landingAt, values: { takeoffAt, landingAt } },
    },
  ];
}

/** The lost-link rule evaluated for a flight each time one of its reports is recorded, as the evaluator does. */
function evaluations(flightId: string, reports: Report[], cut: number): IssueEvaluation[] {
  const recorded = reports
    .filter((report) => report.input.subject.flightId === flightId && report.processing === 'completed')
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  return recorded
    .filter((report) => Date.parse(report.recordedAt) <= cut)
    .map((report, index) => {
      const observations = recorded.slice(0, index + 1).map(transition);
      const transitions = narrowRead(commandLinkLossLeafV2.reads[0]!, observations, {});
      const clock = { mode: 'wall' as const, evaluatedAt: report.recordedAt };
      const outcome = runCheckedRule(commandLinkLossLeafV2, commandLinkLossLeafV2.check.params, { transitions }, clock);
      return {
        recordedAt: report.recordedAt,
        clock,
        evidenceState: outcome.evidenceState,
        ...(outcome.issues ? { issues: outcome.issues } : {}),
        ...(outcome.issueTimes ? { issueTimes: outcome.issueTimes } : {}),
      };
    });
}

function indicator(input: Input): IndicatorResult {
  const source = input.monitoring.record.source;
  const cut = Date.parse(input.clock.evaluatedAt);
  return calculateIndicator(definition, {
    window: { ...source.window },
    recordedThrough: input.clock.evaluatedAt,
    control: { id: input.control.controlId, version: input.control.controlVersion },
    population: {
      subjects: source.flights.map((scope) => flightSubject(scope.flightId)),
      complete: source.populationComplete,
      declaredBy: { kind: 'source', id: input.monitoring.record.sourceId },
    },
    selection: {
      complete: input.selection.complete,
      exceeded: [],
      // A report not yet processed is an evaluation still due.
      pending: [...input.c2Reports, ...(input.c2Baselines ?? [])].some((report) => report.processing !== 'completed'),
    },
    events: source.flights.flatMap((scope) =>
      issueEvents(rule, flightSubject(scope.flightId), evaluations(scope.flightId, input.c2Reports, cut)),
    ),
    exposure: source.flights.flatMap((scope) => [
      ...flightReport(scope),
      ...samples(input, scope),
      ...input.c2Reports.filter((report) => report.input.subject.flightId === scope.flightId).map(transition),
    ]),
  });
}

function milliseconds(result: IndicatorResult): number {
  return (Number(result.exposure.value.numerator) * 3_600_000) / Number(result.exposure.value.denominator);
}

/** The supported numbers the draft calculation stated: events, monitored exposure and the rate. */
function expectSupportedNumbers(
  input: Input,
  expected: { lossGroups: number; milliseconds: number; perFlightHour: number },
) {
  const result = indicator(input);
  expect(result.status).toBe('supported');
  expect(result.eventCount).toBe(expected.lossGroups);
  expect(milliseconds(result)).toBe(expected.milliseconds);
  expect(Number(result.rate!.value.numerator) / Number(result.rate!.value.denominator)).toBe(expected.perFlightHour);
  return result;
}

describe('command-link losses per flight hour, as the draft calculation counted them', () => {
  it('gives the supported numbers of a version 1 window', () => {
    const result = expectSupportedNumbers(supportedInput, { lossGroups: 0, milliseconds: 300000, perFlightHour: 0 });
    expect(result.rate).toMatchObject({ value: { numerator: '0', denominator: '1' }, decimal: '0.000000' });
    expect(result.exposure).toMatchObject({ value: { numerator: '1', denominator: '12' }, gaps: [], conflicts: [] });
  });

  it('counts the loss before the window that is restored inside it once, at 12 per flight hour', () => {
    for (const input of [cases.carryIn, cases.carryInV2]) {
      const result = expectSupportedNumbers(input, { lossGroups: 1, milliseconds: 300000, perFlightHour: 12 });
      expect(result.rate).toMatchObject({ value: { numerator: '12', denominator: '1' }, decimal: '12.000000' });
      // Duplicate delivery and order do not change the count.
      const duplicated = structuredClone(input);
      duplicated.c2Reports.reverse();
      duplicated.c2Reports.push(structuredClone(duplicated.c2Reports[0]!));
      expect(indicator(duplicated)).toEqual(result);
    }
  });

  it('gives the supported numbers of a version 2 window with a native baseline', () => {
    expectSupportedNumbers(resolvedV2(), { lossGroups: 0, milliseconds: 300000, perFlightHour: 0 });
  });

  it('sums distinct concurrent flights, with overlapping observed intervals unioned', () => {
    const input = structuredClone(supportedInput);
    const first = input.monitoring.record.source.flights[0]!;
    first.observedIntervals = [
      { start: '2026-10-15T14:14:00Z', end: '2026-10-15T14:18:00Z' },
      { start: '2026-10-15T14:17:00Z', end: '2026-10-15T14:21:00Z' },
    ];
    const second = structuredClone(first);
    second.flightId += ':second';
    second.aircraftId += ':second';
    second.c2SourceSessionId += ':second';
    second.mission = {
      ...second.mission,
      missionId: `${second.mission.missionId}:second`,
      eventId: `${second.mission.eventId}:second`,
    };
    second.declaredC2SourceEventIds = first.declaredC2SourceEventIds.map((id) => `${id}:second`);
    (input.monitoring.record.source.flights as Scope[]).push(second);
    input.c2Reports.push(
      ...input.c2Reports.map((report) => {
        const copy = structuredClone(report);
        copy.eventId += ':second';
        copy.receiptId += ':second';
        copy.input.subject.flightId = second.flightId;
        copy.input.payload.aircraftId = second.aircraftId;
        copy.input.payload.sourceEventId += ':second';
        copy.input.sourceSessionId = second.c2SourceSessionId;
        copy.input.artifactId += ':second';
        return copy;
      }),
    );
    // The draft calculation stated two observed flights and 600 000 ms of observed exposure.
    expectSupportedNumbers(input, { lossGroups: 0, milliseconds: 600000, perFlightHour: 0 });
  });

  it('states the exact rate where the floating-point rate differs in its last digit', () => {
    const input = structuredClone(cases.carryIn);
    const flight = input.monitoring.record.source.flights[0]!;
    flight.observedIntervals = [{ start: '2026-10-15T14:15:00Z', end: '2026-10-15T14:18:30Z' }];
    const result = indicator(input);
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 1,
      rate: { value: { numerator: '120', denominator: '7' }, decimal: '17.142857' },
    });
    expect(milliseconds(result)).toBe(210000);
    // The draft calculation stored 1 × 3 600 000 / 210 000 as a double.
    expect(120 / 7).toBe(17.142857142857142);
  });

  it('counts a loss half a second before a thirty-second window, restored inside it, at 120 per flight hour', () => {
    const input = structuredClone(cases.carryIn);
    const window = { start: '2026-10-15T14:15:00Z', end: '2026-10-15T14:15:30Z' };
    const source = input.monitoring.record.source;
    source.window = window;
    source.completeThrough = window.end;
    source.flights[0]!.observedIntervals = [window];
    source.flights[0]!.coverageIntervals = [window];
    const [lost, restored] = input.c2Reports;
    lost!.input.occurredAt = '2026-10-15T14:14:59.500Z';
    lost!.recordedAt = '2026-10-15T14:15:00.500Z';
    restored!.input.occurredAt = '2026-10-15T14:15:05.000Z';
    restored!.recordedAt = '2026-10-15T14:15:06.000Z';
    const result = indicator(input);
    expect(result).toMatchObject({ status: 'supported', eventCount: 1, rate: { value: { numerator: '120' } } });
    expect(milliseconds(result)).toBe(30000);
  });

  it('states no rate where the draft calculation stated none', () => {
    const insufficient = [
      [cases.noExposure, ['exposure_not_positive']],
      [cases.missingCoverage, ['exposure_coverage_gaps', 'exposure_not_positive']],
      [cases.c2Gap, ['exposure_coverage_gaps']],
      [cases.incompletePopulation, ['population_not_declared_complete']],
    ] as const;
    for (const [input, reasons] of insufficient)
      expect(indicator(input)).toMatchObject({ status: 'insufficient', rate: null, reasons });
    const gap = indicator(cases.c2Gap);
    // The draft calculation subtracted the declared minute of monitor outage (240 000 ms monitored). With samples
    // thirty seconds apart, nothing is received from the last sample before the outage to the first after it:
    // 180 000 ms covered.
    expect(milliseconds(gap)).toBe(180000);
    expect(gap.exposure.gaps).toEqual([
      expect.objectContaining({ code: 'coverage_not_received', subjectKey: 'ledger/flight/resolved-flight-1' }),
    ]);
    const incomplete = structuredClone(supportedInput);
    incomplete.selection.complete = false;
    expect(indicator(incomplete)).toMatchObject({ status: 'insufficient', reasons: ['selection_incomplete'] });
  });

  it('keeps telemetry delivery gaps out of the measure, as the draft calculation did', () => {
    expectSupportedNumbers(cases.telemetryDeliveryGap, { lossGroups: 0, milliseconds: 300000, perFlightHour: 0 });
  });

  it('decides with the lost-link rule where the draft calculation checked a tie itself', () => {
    // A loss and a restoration at the same instant, clarified by a later restoration: the draft calculation read the
    // group as ambiguous; the lost-link rule reads the episode as closed by the later restoration, so the loss counts.
    const tied = structuredClone(cases.carryIn);
    tied.c2Reports[1]!.input.occurredAt = tied.c2Reports[0]!.input.occurredAt;
    const later = structuredClone(cases.carryIn.c2Reports[1]!);
    later.eventId += ':later';
    later.receiptId += ':later';
    later.input.payload.sourceEventId += ':later';
    later.input.artifactId += ':later';
    later.recordedAt = '2026-10-15T14:16:02.000Z';
    tied.c2Reports.push(later);
    tied.monitoring.record.source.flights[0]!.declaredC2SourceEventIds.push(later.input.payload.sourceEventId);
    expect(indicator(tied)).toMatchObject({ status: 'supported', eventCount: 1 });
    // Only an unsettled tie is conflicting.
    const unsettled = structuredClone(cases.carryIn);
    unsettled.c2Reports[0]!.input.occurredAt = unsettled.c2Reports[1]!.input.occurredAt;
    expect(indicator(unsettled)).toMatchObject({
      status: 'conflicting',
      reasons: expect.arrayContaining(['event_evidence_conflicting']),
    });
  });

  it('is never more confident than the draft calculation where it knew less', () => {
    // A report not yet processed: an evaluation is still due.
    expect(indicator(cases.pending)).toMatchObject({
      status: 'insufficient',
      rate: null,
      reasons: ['evaluations_pending'],
    });
    // Down without a reported loss, or unknown, at the window start: the state there is not established.
    for (const input of [cases.down, cases.unknown]) {
      const result = indicator(input);
      expect(result).toMatchObject({ status: 'insufficient', rate: null, reasons: ['exposure_coverage_gaps'] });
      expect(result.exposure.gaps).toMatchObject([{ code: 'state_not_established_at_window_start' }]);
    }
    const unreported = structuredClone(supportedInput);
    unreported.c2Reports = [];
    expect(indicator(unreported).exposure.gaps).toMatchObject([{ code: 'state_not_established_at_window_start' }]);
    // A loss and a restoration at the same instant before the window, never clarified: the loss cannot be placed.
    const tie = structuredClone(cases.carryIn);
    tie.c2Reports[1]!.input.occurredAt = tie.c2Reports[0]!.input.occurredAt;
    expect(indicator(tie)).toMatchObject({
      status: 'insufficient',
      rate: null,
      reasons: expect.arrayContaining(['event_time_undetermined']),
    });
  });
});
