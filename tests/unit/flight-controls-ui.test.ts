import { describe, expect, test } from 'vitest';
import type { FlightControl } from '../../packages/contracts/src/index.js';
import {
  controlCheckWords,
  controlPeriodWords,
  controlResultSubject,
  controlResultTone,
  controlResultWords,
  controlsToReview,
} from '../../apps/web/src/flight-controls.js';

const control = (results: FlightControl['results'], check: FlightControl['check'] = 'rule'): FlightControl => ({
  hazard: { id: 'hazard-fictional', title: 'Battery exhausted before landing' },
  control: {
    id: 'control-fictional',
    versionNumber: 1,
    bodyDigest: 'a'.repeat(64),
    title: 'Battery reserve',
    type: { id: 'control.toy', version: 1, digest: 'b'.repeat(64), title: 'Toy' },
    description: 'Keep the fictional reserve.',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveUntil: null,
    period: 'current',
  },
  check,
  results,
});

describe('controls in scope for a flight', () => {
  test('states each result in plain words and never as a verdict', () => {
    for (const result of ['pass', 'attention', 'insufficient', 'not_applicable', 'needs_confirmation'] as const)
      expect(controlResultWords(result)).not.toMatch(/\b(compliant|authori[sz]ed|go|no-go|approved)\b/i);
    expect(controlResultWords('needs_confirmation')).toBe('Needs a person’s confirmation');
    expect(controlResultTone('attention')).toBe('attention');
    expect(controlCheckWords('route_review')).toBe('Checked by route review');
  });

  test('names the subject a result is about and counts the controls a person should look at', () => {
    const subject = { scope: 'source' as const, kind: 'aircraft' as const, id: 'tail-7', sourceId: 'fictional' };
    expect(controlResultSubject({ result: 'pass', summary: 'Within the limit.', subject })).toBe('aircraft tail-7');
    expect(controlResultSubject({ result: 'needs_confirmation', summary: 'A person confirms it.' })).toBeNull();
    expect(
      controlsToReview([
        control([{ result: 'attention', summary: 'Below the limit.' }]),
        control([{ result: 'pass', summary: 'Within the limit.' }]),
        control([{ result: 'insufficient', summary: 'Not evaluated yet.' }]),
        control([{ result: 'needs_confirmation', summary: 'A person confirms it.' }], 'person'),
      ]),
    ).toBe(2);
  });

  test('says when a control outside its interval starts or ended', () => {
    const { control: current } = control([{ result: 'pass', summary: 'Within the limit.' }]);
    const time = (iso: string) => iso.slice(0, 10);
    expect(controlPeriodWords(current, time)).toBeNull();
    expect(
      controlPeriodWords({ ...current, effectiveFrom: '2026-12-01T00:00:00.000Z', period: 'upcoming' }, time),
    ).toBe('Takes effect on 2026-12-01');
    expect(controlPeriodWords({ ...current, effectiveUntil: '2026-02-01T00:00:00.000Z', period: 'ended' }, time)).toBe(
      'Ended on 2026-02-01',
    );
  });
});
