import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@ledger/contracts';
import {
  citedLandingReport,
  landingFromLocalInput,
  localLandingInput,
  retainedReportText,
} from '../../apps/web/src/landing-reconciliation.js';
import type { LandingReportRow } from '../../apps/web/src/safety.js';

const report: LandingReportRow = {
  eventId: 'event-landing',
  receiptId: 'receipt-landing',
  sourceId: 'ground-report',
  occurredAt: '2026-10-19T04:11:50.123Z',
  field: 'landingTime',
  value: '2026-10-19T04:10:50.123Z',
  valid: true,
  normalizedTime: '2026-10-19T04:10:50.123Z',
  reportedTime: '2026-10-19T04:10:50.123Z',
};
const item: TimelineItem = {
  id: report.eventId,
  receiptId: report.receiptId,
  sourceId: report.sourceId,
  lane: 'observed',
  kind: 'flight.observation',
  title: 'Any source title',
  actorId: 'source-principal',
  occurredAt: report.occurredAt,
  receivedAt: '2026-10-19T04:11:51Z',
  linkStatus: 'linked',
  payload: { activity: 'landed', landingTime: report.value, personName: 'Morgan Lee', note: 'Handset clock was fast.' },
};

describe('landing reconciliation source selection', () => {
  it('keeps authored seconds and rejects invalid local dates rather than silently rolling the touchdown forward', () => {
    const local = localLandingInput('2026-10-19T04:10:20.000Z');
    expect(landingFromLocalInput(local)).toBe('2026-10-19T04:10:20.000Z');
    expect(landingFromLocalInput('2026-02-30T12:10:20')).toBeNull();
    expect(landingFromLocalInput('2026-10-19T25:10:20')).toBeNull();
    expect(landingFromLocalInput('')).toBeNull();
  });
  it('requires the exact cited event, receipt, source and value rather than a matching title or nearby report', () => {
    expect(citedLandingReport(item, report, 'flight-a')).toBe(item);
    for (const changed of [
      { ...item, id: 'different-event' },
      { ...item, receiptId: 'different-receipt' },
      { ...item, sourceId: 'other-operator-report' },
      { ...item, payload: { ...item.payload, landingTime: '2026-10-19T04:10:20.123Z' } },
      { ...item, kind: 'evaluation.recorded' },
    ])
      expect(citedLandingReport(changed, report, 'flight-a')).toBeNull();
    expect(citedLandingReport(item, { ...report, eventId: `${report.eventId}:flight-a` }, 'flight-a')).toBe(item);
    expect(citedLandingReport(item, { ...report, eventId: `${report.eventId}:flight-b` }, 'flight-a')).toBeNull();
  });

  it('reads an exact retained correction claim without exposing its command wrapper as source values', () => {
    const correction: TimelineItem = {
      ...item,
      id: 'correction-a',
      kind: 'evidence.correct',
      sourceId: undefined,
      receiptId: undefined,
      payload: {
        correctionOf: item.id,
        payload: { ...item.payload, landingTime: '2026-10-19T04:10:20.123Z' },
        note: 'Confirmed with crew.',
      },
    };
    const corrected: LandingReportRow = {
      ...report,
      eventId: correction.id,
      receiptId: '',
      sourceId: 'operator-correction',
      value: '2026-10-19T04:10:20.123Z',
    };
    expect(citedLandingReport(correction, corrected, 'flight-a')).toBe(correction);
    expect(retainedReportText(correction, 'note')).toBe('Handset clock was fast.');
    expect(retainedReportText(correction, 'personName')).toBe('Morgan Lee');
    expect(retainedReportText(correction, 'missing')).toBeNull();
  });
});
