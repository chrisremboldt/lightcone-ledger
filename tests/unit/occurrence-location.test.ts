import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { draftCommandLinkFinding } from '../../packages/contracts/fixtures/demo/v1/c2-execution.js';
import { landingDisagreementRuleEvaluation } from '../../packages/contracts/fixtures/demo/v1/landing-hazards.js';
import type { CitedValueRow } from '../../apps/web/src/evaluation-reads.js';
import type {
  EvaluationRecord,
  Receipt,
  TelemetryResponse,
  TelemetrySampleView,
  TimelineItem,
} from '../../packages/contracts/src/index.js';
import { TelemetryQuerySchema } from '../../packages/contracts/src/telemetry.js';
import {
  occurrenceReferences,
  resolveOccurrenceLocations,
  selectOccurrenceLocation,
  type OccurrenceReportRead,
} from '../../apps/web/src/occurrence-location.js';

const eventTime = '2026-10-18T14:00:30.000Z';
function evaluation(): EvaluationRecord {
  const result = structuredClone(draftCommandLinkFinding.latestEvaluation);
  result.flightId = 'flight-one';
  result.explanation = {
    kind: 'command_link',
    code: 'loss',
    summary: 'A retained loss',
    evaluatedAt: eventTime,
    evidence: [
      {
        eventId: 'loss-event',
        receiptId: 'loss-receipt',
        sourceId: 'radio',
        occurredAt: eventTime,
        flightId: result.flightId,
        sourceSessionId: 'radio-session',
        sourceEventId: 'native-loss',
        incidentId: 'incident-one',
        aircraftId: 'aircraft-one',
        status: 'lost',
      },
    ],
    groups: [
      {
        sourceId: 'radio',
        sourceSessionId: 'radio-session',
        incidentId: 'incident-one',
        aircraftId: 'aircraft-one',
        state: 'unresolved',
        lossEventIds: ['loss-event'],
        restorationEventIds: [],
      },
    ],
  };
  return result;
}
function report(position?: { latitude: number; longitude: number }): OccurrenceReportRead {
  const payload = {
    sourceEventId: 'native-loss',
    incidentId: 'incident-one',
    aircraftId: 'aircraft-one',
    status: 'lost',
    ...(position ? { position } : {}),
  };
  const item: TimelineItem = {
    id: 'loss-event',
    lane: 'observed',
    kind: 'command-link.status',
    title: 'Title is not location semantics',
    occurredAt: eventTime,
    receivedAt: eventTime,
    actorId: 'source',
    sourceId: 'radio',
    payload: { ...payload, sourceSessionId: 'radio-session' },
    receiptId: 'loss-receipt',
    artifactId: 'source-original',
    linkStatus: 'linked',
  };
  const receipt: Receipt = {
    id: 'loss-receipt',
    eventId: 'loss-event',
    sourceId: 'radio',
    flightId: 'flight-one',
    kind: 'command-link.status',
    occurredAt: eventTime,
    receivedAt: eventTime,
    status: 'accepted',
    processing: { status: 'completed', attempts: 1 },
    linkStatus: 'linked',
    payload,
  };
  return { eventId: 'loss-event', item, receipt };
}
function sample(sequence: number, seconds: number, extras: Partial<TelemetrySampleView> = {}): TelemetrySampleView {
  return {
    sequence,
    occurredAt: new Date(Date.parse(eventTime) + seconds * 1000).toISOString(),
    latitude: 41 + sequence * 0.001,
    longitude: -87,
    altitudeMeters: null,
    altitudeReference: 'unknown',
    original: { topic: 'retained-source-topic' },
    id: `capture-${sequence}`,
    segmentId: 'segment-one',
    receiptId: 'capture-receipt',
    eventId: 'capture-event',
    artifactId: 'capture-original',
    sourceId: 'dji',
    sourceSessionId: 'capture-session',
    deviceId: 'aircraft-device',
    sampleOffset: 0,
    receivedAt: eventTime,
    originalSha256: 'a'.repeat(64),
    durable: true,
    conflict: false,
    ...extras,
  };
}
function snapshot(samples: TelemetrySampleView[], extras: Partial<TelemetryResponse> = {}): TelemetryResponse {
  return {
    flightId: 'flight-one',
    flightRevision: 2,
    status: 'durable_only',
    samples,
    sessions: [],
    segments: [],
    gaps: [],
    cursor: 'cursor',
    window: {
      sampleLimit: 240,
      sessionLimit: 16,
      segmentLimit: 20,
      gapLimit: 128,
      truncated: false,
      occurrence: { around: eventTime, from: '2026-10-18T13:59:30.000Z', until: '2026-10-18T14:01:30.000Z' },
    },
    meta: {} as TelemetryResponse['meta'],
    ...extras,
  };
}
function resolve(reports = [report()], telemetry: TelemetryResponse[] = []) {
  return resolveOccurrenceLocations({ flightId: 'flight-one', evaluation: evaluation(), reports, telemetry });
}

describe('evidence occurrence locations', () => {
  it('pins direct source positions to all retained C2 identities, without borrowing later telemetry', () => {
    const direct = { latitude: 0, longitude: 0 };
    const result = resolve([report(direct)], [snapshot([sample(1, 0)])]).occurrences[0]!;
    expect(result.position).toEqual(direct);
    expect(result.method).toBe('source_report');
    expect(result.candidates[0]!.signedOffsetMs).toBe(0);
    for (const field of ['sourceSessionId', 'incidentId', 'aircraftId', 'sourceEventId', 'status'] as const) {
      const read = report(direct);
      read.item!.payload[field] = 'another-scope';
      expect(resolve([read]).occurrences[0]!.status).toBe('missing');
    }
    for (const field of ['flightId', 'sourceId', 'eventId', 'occurredAt'] as const) {
      const read = report(direct);
      read.receipt![field] = 'another-scope';
      expect(resolve([read]).occurrences[0]!.status).toBe('missing');
    }
  });

  it('reads the direct position of a report that arrived as a link.status observation', () => {
    const direct = { latitude: 41.5, longitude: -87.5 };
    const observed = (position?: typeof direct): OccurrenceReportRead => {
      const read = report(position);
      const observation = {
        type: 'link.status',
        version: 1,
        subject: { kind: 'flight', id: 'flight-one', scope: 'ledger' },
        secondarySubject: { kind: 'aircraft', id: 'aircraft-one', scope: 'source' },
        occurredAt: eventTime,
        sourceEventId: 'native-loss',
        sourceSessionId: 'radio-session',
        ...(position ? { position: { latitudeDegrees: position.latitude, longitudeDegrees: position.longitude } } : {}),
        values: { link: 'command_control', state: 'down', report: 'transition', sourceEpisodeId: 'incident-one' },
      };
      return {
        ...read,
        item: { ...read.item!, kind: 'observation', payload: observation },
        receipt: { ...read.receipt!, kind: 'observation', payload: observation },
      };
    };
    const result = resolve([observed(direct)]).occurrences[0]!;
    expect(result).toMatchObject({ position: direct, method: 'source_report' });
    const sample = observed(direct);
    (sample.item!.payload.values as Record<string, unknown>).report = 'sample';
    expect(resolve([sample]).occurrences[0]!.status).toBe('missing');
  });

  it('uses a bounded historical bracket within one telemetry track and names the interpolation', () => {
    const result = resolve([report()], [snapshot([sample(10, -10), sample(11, 10)])]).occurrences[0]!;
    expect(result.method).toBe('interpolated');
    expect(result.position!.latitude).toBeCloseTo(41.0105);
    expect(result.candidates[0]!.bracketOffsetsMs).toEqual([-10_000, 10_000]);
    expect(result.candidates[0]!.sampleIds).toEqual(['capture-10', 'capture-11']);
    expect(result.candidates[0]!.uncertainty).toContain('accuracy are unknown');
    expect(result.candidates[0]!.sourceSessionId).toBe('capture-session');
  });

  it('never interpolates across capture gaps, different sessions, time reversal or conflicting claims', () => {
    const pair = [sample(10, -10), sample(11, 10)];
    const cases = [
      snapshot([pair[0]!, { ...pair[1]!, sequence: 12 }]),
      snapshot([pair[0]!, { ...pair[1]!, sourceSessionId: 'other-session' }]),
      snapshot([pair[0]!, { ...pair[1]!, conflict: true }]),
      snapshot([sample(9, 20), ...pair]),
      snapshot(pair, {
        gaps: [
          {
            sessionId: 'session',
            sourceId: 'dji',
            sourceSessionId: 'capture-session',
            deviceId: 'aircraft-device',
            fromSequence: 11,
            toSequence: 11,
          },
        ],
      }),
    ];
    for (const window of cases) expect(resolve([report()], [window]).occurrences[0]!.method).not.toBe('interpolated');
    const nearby = resolve([report()], [snapshot([sample(10, -12)])]).occurrences[0]!;
    expect(nearby.method).toBe('nearby');
    expect(nearby.candidates[0]!.signedOffsetMs).toBe(-12_000);
  });

  it('keeps truncated, multiple-track and tied/conflicting evidence ambiguous rather than averaging', () => {
    const window = snapshot([sample(10, 0)]);
    window.window.truncated = true;
    expect(resolve([report()], [window]).occurrences[0]!.status).toBe('ambiguous');
    for (const samples of [
      [sample(10, 0), sample(11, 0)],
      [sample(10, 0), sample(10, 0, { id: 'other-track', sourceSessionId: 'other-session' })],
      [sample(10, 0, { conflict: true })],
    ]) {
      const result = resolve([report()], [snapshot(samples)]).occurrences[0]!;
      expect(result.status).toBe('ambiguous');
      expect(result.position).toBeUndefined();
    }
  });

  it('retains an exact selected location when a reread reorders tracks or changes interpolation captures', () => {
    const first = resolve([report()], [snapshot([sample(10, -10), sample(11, 10)])]).occurrences[0]!;
    const selected = selectOccurrenceLocation(evaluation(), first, first.candidates[0]!);
    const reordered = resolve(
      [report()],
      [
        snapshot([
          sample(1, 0, { id: 'other-track', sourceSessionId: 'other-session' }),
          sample(10, -10),
          sample(11, 10),
        ]),
      ],
    ).occurrences[0]!;
    expect(selectOccurrenceLocation(evaluation(), reordered, reordered.candidates[0]!).id).not.toBe(selected.id);
    expect(selectOccurrenceLocation(evaluation(), reordered, reordered.candidates[1]!).id).toBe(selected.id);
    const revisedBracket = resolve(
      [report()],
      [snapshot([sample(10, -10), sample(11, 8, { id: 'late-capture', latitude: 41.02 })])],
    ).occurrences[0]!;
    expect(
      revisedBracket.candidates.map(
        (candidate) => selectOccurrenceLocation(evaluation(), revisedBracket, candidate).id,
      ),
    ).not.toContain(selected.id);
    const retainedPosition = { ...selected.candidate.position };
    first.candidates[0]!.position.latitude = 0;
    expect(selected.candidate.position).toEqual(retainedPosition);
    expect(selected.candidate.sampleIds).toEqual(['capture-10', 'capture-11']);
  });

  it('keeps unprocessed telemetry uncertainty separate from an exact retained source position', () => {
    const window = snapshot([sample(10, 0)]);
    window.segments.push({
      id: 'pending',
      receiptId: 'pending-receipt',
      eventId: 'pending-event',
      artifactId: 'pending-original',
      sourceId: 'dji',
      sourceSessionId: 'capture-session',
      deviceId: 'aircraft-device',
      sampleCount: 1,
      firstSequence: 11,
      lastSequence: 11,
      firstOccurredAt: eventTime,
      lastOccurredAt: eventTime,
      receivedAt: eventTime,
      processing: { status: 'pending', attempts: 0 },
    });
    expect(resolve([report()], [window]).occurrences[0]!.status).toBe('ambiguous');
    expect(resolve([report({ latitude: 41, longitude: -87 })], [window]).occurrences[0]!.method).toBe('source_report');
  });

  it('does not use recent windows, another flight, another event time or distant captures as fallback', () => {
    const recent = snapshot([sample(10, 0)]);
    delete recent.window.occurrence;
    const wrongTime = snapshot([sample(10, 0)]);
    wrongTime.window.occurrence!.around = '2026-10-18T15:00:30Z';
    for (const window of [
      recent,
      wrongTime,
      snapshot([sample(10, 0)], { flightId: 'flight-two' }),
      snapshot([sample(10, 40)]),
    ])
      expect(resolve([report()], [window]).occurrences[0]!.status).toBe('missing');
    expect(resolve().occurrences[0]!.position).toBeUndefined();
    expect(resolve([{ eventId: 'loss-event', error: 'Exact source unavailable' }]).occurrences[0]!.reason).toBe(
      'Exact source unavailable',
    );
  });

  it('keeps each landing claim and correction clock distinct from the source-report arrival', () => {
    // A disagreement finding from an adopted rule: the reports' times come from the observations it cites.
    const source = structuredClone(landingDisagreementRuleEvaluation) as EvaluationRecord;
    source.flightId = 'flight-one';
    const row = (eventId: string, sourceId: string, value: string, time: string | null): CitedValueRow => ({
      observationId: eventId,
      eventId,
      receiptId: eventId === 'correction' ? '' : `${eventId}-receipt`,
      sourceId,
      occurredAt: eventTime,
      field: 'values.landingAt',
      value,
      valid: time !== null,
      ...(time ? { normalizedTime: time } : {}),
      reportedTime: time,
    });
    const cited = [
      row('landing', 'crew', '2026-10-18T13:59:00Z', '2026-10-18T13:59:00.000Z'),
      row('correction', 'operator-correction', 'unreadable', null),
    ];
    const correction: OccurrenceReportRead = {
      eventId: 'correction',
      item: {
        id: 'correction',
        kind: 'evidence.correct',
        lane: 'evidence',
        title: 'Correction',
        actorId: 'human',
        occurredAt: eventTime,
        receivedAt: eventTime,
        payload: { landingTime: 'unreadable' },
        correctionOf: 'landing',
        linkStatus: 'linked',
      },
    };
    const resolved = resolveOccurrenceLocations({
      flightId: 'flight-one',
      evaluation: source,
      reports: [correction],
      telemetry: [snapshot([sample(10, 0)])],
      cited,
    });
    expect(resolved.occurrences.find((entry) => entry.report.eventId === 'correction')!.status).toBe('located');
    correction.item!.payload.landingTime = 'changed-after-the-evaluation';
    expect(
      resolveOccurrenceLocations({
        flightId: 'flight-one',
        evaluation: source,
        reports: [correction],
        telemetry: [snapshot([sample(10, 0)])],
        cited,
      }).occurrences.find((entry) => entry.report.eventId === 'correction')!.status,
    ).toBe('missing');
    expect(occurrenceReferences(source)).toEqual([]);
    expect(
      occurrenceReferences(source, cited).map((reference) => [reference.eventTime, reference.eventTimeBasis]),
    ).toEqual([
      ['2026-10-18T13:59:00.000Z', 'reported_landing'],
      [eventTime, 'reported_occurrence'],
    ]);
  });
});

it('bounds the additive historical telemetry query without defaulting ordinary snapshots into history', () => {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(TelemetryQuerySchema);
  expect(validate({})).toBe(true);
  expect(validate({ around: eventTime })).toBe(true);
  expect(validate({ around: eventTime, windowSeconds: 300 })).toBe(true);
  for (const query of [
    { windowSeconds: 60 },
    { around: eventTime, windowSeconds: 301 },
    { around: 'yesterday' },
    { around: eventTime, windowSeconds: 0 },
    { around: eventTime, windowSeconds: 1.5 },
    { around: eventTime, latest: true },
  ])
    expect(validate(query)).toBe(false);
});
