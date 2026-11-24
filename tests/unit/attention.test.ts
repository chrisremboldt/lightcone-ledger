import { describe, expect, it } from 'vitest';
import type { FlightSummary, TimelineItem } from '@ledger/contracts';
import {
  attentionOwner,
  attentionReasons,
  activityPresentation,
  coveragePresentation,
  highlightHeading,
  ownershipLine,
  nextStep,
  picturePhrase,
  preferredFlight,
  rosterGroup,
  threadHighlights,
} from '../../apps/web/src/labels.js';
import { missionPlace } from '../../apps/web/src/places.js';

function flight(partial: Partial<FlightSummary> & Pick<FlightSummary, 'id'>): FlightSummary {
  return {
    label: partial.label ?? partial.id,
    originationKey: partial.id,
    revision: 1,
    basisRevision: 1,
    activity: 'active',
    coverage: 'partial',
    orderIds: [],
    sourceIds: [],
    unresolvedCount: 0,
    conflictCount: 0,
    outstandingWork: 0,
    ...partial,
  };
}

const now = Date.parse('2026-10-05T18:30:00.000Z');

describe('fleet attention', () => {
  it('puts an airborne denial ahead of a quiet flight and leaves it unowned when the decision predates the report', () => {
    const quiet = flight({ id: 'quiet', label: 'Vaccine cooler · Southbank Clinic' });
    const denied = flight({
      id: 'denied',
      label: 'Pharmacy run · Eastside Clinic',
      picture: {
        authorization: 'denied',
        authorizationAt: '2026-10-05T18:15:00.000Z',
        authorizationReceivedAt: '2026-10-05T18:24:00.000Z',
        departedAt: '2026-10-05T18:16:00.000Z',
        latestDecision: {
          actorName: 'Sam Rivera',
          kind: 'proceed',
          recordedAt: '2026-10-05T18:20:00.000Z',
        },
      },
    });
    expect(attentionReasons(denied, now)).toContain('Departed after authorization was denied');
    expect(attentionOwner(denied, now)).toBeNull();
    expect(ownershipLine(denied, now)).toBe('Sam Rivera acted before this was known');
    expect(rosterGroup(denied, attentionReasons(denied, now), now)).toBe('attention');
    expect(preferredFlight([quiet, denied], now)?.id).toBe('denied');
  });

  it('treats a resolution recorded after the report as handled', () => {
    const resolved = flight({
      id: 'resolved',
      activity: 'landed',
      picture: {
        authorization: 'rescinded',
        authorizationAt: '2026-10-05T18:10:00.000Z',
        authorizationReceivedAt: '2026-10-05T18:12:00.000Z',
        departedAt: '2026-10-05T18:00:00.000Z',
        latestDecision: {
          actorName: 'Dana Ortiz',
          kind: 'resolve',
          recordedAt: '2026-10-05T18:20:00.000Z',
        },
      },
    });
    expect(attentionOwner(resolved, now)?.actorName).toBe('Dana Ortiz');
    expect(rosterGroup(resolved, attentionReasons(resolved, now), now)).toBe('done');
    expect(highlightHeading([{ tone: 'alert', text: 'Authorization rescinded' }], resolved)).toEqual({
      label: 'Resolved',
      tone: 'neutral',
    });
  });

  it('keeps recorded findings open after a generic decision and uses their own ownership', () => {
    const recorded = flight({
      id: 'recorded-finding',
      activity: 'landed',
      conflictCount: 1,
      findingSummary: { openCount: 1, unownedCount: 1, latestTitle: 'Landing reports disagree' },
      picture: { latestDecision: { actorName: 'Dana Ortiz', kind: 'resolve', recordedAt: '2026-10-05T18:29:00.000Z' } },
    });
    expect(attentionReasons(recorded, now)).toEqual(['Landing reports disagree']);
    expect(rosterGroup(recorded, attentionReasons(recorded, now), now)).toBe('attention');
    expect(attentionOwner(recorded, now)).toBeNull();
    expect(ownershipLine(recorded, now)).toBe('1 finding needs an owner');
    expect(nextStep(recorded, now)).toBeUndefined();
    expect(ownershipLine({ ...recorded, findingSummary: { ...recorded.findingSummary!, unownedCount: 0 } }, now)).toBe(
      'Finding responsibility recorded',
    );
    expect(attentionReasons({ ...recorded, findingSummary: { openCount: 0, unownedCount: 0 } }, now)).toEqual([]);
  });

  it('describes recorded landings and denials without inventing missing flight reports', () => {
    const landed = flight({ id: 'landed', activity: 'landed' });
    expect(coveragePresentation(landed).label).toBe('Landing recorded');
    expect(coveragePresentation({ ...landed, coverage: 'conflicting', conflictCount: 1 }).label).toBe(
      'Reports disagree',
    );
    const denied = flight({ id: 'denied', activity: 'planned', picture: { authorization: 'denied' } });
    expect(attentionReasons(denied, now)).toEqual(['Authorization denied']);
  });

  it('summarizes current landing reports through correction chains while retaining the history', () => {
    const landed = flight({ id: 'landed', activity: 'landed', conflictCount: 1 });
    const report = (id: string, landingTime: string, correctionOf?: string): TimelineItem => ({
      id,
      kind: correctionOf ? 'evidence.correct' : 'flight.observation',
      lane: correctionOf ? 'evidence' : 'observed',
      title: id,
      actorId: 'dispatcher',
      occurredAt: landingTime,
      receivedAt: '2026-10-05T18:20:00.000Z',
      payload: { activity: 'landed', landingTime },
      linkStatus: 'linked',
      ...(correctionOf ? { correctionOf } : {}),
    });
    const history = [
      report('original', '2026-10-05T18:10:00.000Z'),
      report('other', '2026-10-05T18:12:00.000Z'),
      report('first-correction', '2026-10-05T18:11:00.000Z', 'original:landed'),
      report('second-correction', '2026-10-05T18:14:00.000Z', 'first-correction'),
    ];
    expect(threadHighlights(history, landed)).toEqual([
      { tone: 'attention', text: 'Landing reports disagree: 13:12 (Ledger) vs 13:14 (Ledger)' },
    ]);
    expect(threadHighlights(history, { ...landed, conflictCount: 0 })).toEqual([]);
    expect(history.map((item) => item.kind)).toEqual([
      'flight.observation',
      'flight.observation',
      'evidence.correct',
      'evidence.correct',
    ]);
  });

  it('reads the clinic from a split-flight label', () => {
    expect(missionPlace('Pharmacy run · Eastside Clinic · 2 of 2')).toBe('Eastside Clinic');
    expect(missionPlace('Spare parts courier · Riverside Yard')).toBe('Riverside Yard');
  });

  it('labels receipt freshness without claiming current flight activity', () => {
    expect(picturePhrase('2026-10-05T18:29:30.000Z', now).current).toBe(true);
    expect(picturePhrase('2026-10-05T18:00:00.000Z', now)).toMatchObject({
      current: false,
      text: expect.stringContaining('Last report received'),
    });
    expect(picturePhrase('2026-10-05T18:31:00.000Z', now).current).toBe(false);
  });

  it('keeps old airborne reports unconfirmed when delayed positions or decisions arrive now', () => {
    const reported = flight({
      id: 'paused-origin',
      lastOccurredAt: '2026-10-05T18:00:00.000Z',
      lastReceivedAt: '2026-10-05T18:30:00.000Z',
      picture: {
        lastPosition: {
          latitude: 41.88,
          longitude: -87.63,
          occurredAt: '2026-10-05T18:00:00.000Z',
          receivedAt: '2026-10-05T18:30:00.000Z',
        },
      },
    });
    expect(activityPresentation(reported, now)).toMatchObject({
      label: 'Last reported airborne',
      tone: 'neutral',
      current: false,
      observedAt: '2026-10-05T18:00:00.000Z',
      detail: expect.stringContaining('unconfirmed'),
    });
    expect(activityPresentation({ ...reported, activity: 'landed' }, now).label).toBe('Landed');
    expect(activityPresentation({ ...reported, picture: undefined, lastOccurredAt: undefined }, now).current).toBe(
      false,
    );
    expect(
      activityPresentation({ ...reported, picture: { departedAt: '2026-10-05T18:29:30.000Z' } }, now),
    ).toMatchObject({
      label: 'Reported airborne',
      current: true,
    });
  });
});
