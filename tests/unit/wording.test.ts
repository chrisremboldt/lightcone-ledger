import { describe, expect, it } from 'vitest';
import type { NamedSubject } from '../../packages/contracts/src/index.js';
import { time } from '../../apps/web/src/format.js';
import { wordedSummary, wordingValue } from '../../apps/web/src/wording.js';

const site: NamedSubject = {
  scope: 'source',
  kind: 'site',
  id: 'north-roof-fictional',
  sourceId: 'roof-dock-fictional',
  name: 'North roof',
};
const at = '2026-11-19T10:03:26Z';

describe('wording that packs supply, as a person reads it', () => {
  it('shows a time in the organization’s time and a subject the evaluation read by its name', () => {
    expect(wordingValue(at)).toBe(`${time(at, true)} CT`);
    expect(wordingValue(`${at}, 2026-11-19T10:05:00.000Z`)).toBe(
      `${time(at, true)} CT, ${time('2026-11-19T10:05:00.000Z', true)} CT`,
    );
    expect(wordingValue('north-roof-fictional', [site])).toBe('North roof');
    expect(wordingValue('2026-11-19')).toBe('2026-11-19');
    expect(wordingValue(14.2)).toBe('14.2');
    expect(wordingValue(null)).toBe('None');
  });

  it('fills the rule’s wording again from the recorded details, and otherwise keeps the recorded summary', () => {
    const template = 'Wind above the {limit} m/s limit from {firstRunStartedAt}; the highest was {worstValue} m/s.';
    const details = { limit: 10, firstRunStartedAt: at, worstValue: 14.2 };
    const recorded = `Wind above the 10 m/s limit from ${at}; the highest was 14.2 m/s.`;
    expect(wordedSummary(recorded, template, details)).toBe(
      `Wind above the 10 m/s limit from ${time(at, true)} CT; the highest was 14.2 m/s.`,
    );
    expect(wordedSummary(recorded, undefined, details)).toBe(recorded);
    expect(wordedSummary(recorded, template, { limit: 10 })).toBe(recorded);
  });
});
