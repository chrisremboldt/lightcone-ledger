import { describe, expect, it } from 'vitest';
import { localizeInstants, zonedInstantText } from '../../packages/contracts/src/index.js';
import { quantityText } from '../../packages/domain/src/quantities.js';

describe('a sentence in the organization’s units and time', () => {
  it('states a quantity in the unit the rule’s text uses, with the stored value in parentheses', () => {
    expect(quantityText(121.92, 'm', 'ft')).toBe('400 ft (121.92 m)');
    expect(quantityText(3218.688, 'm', 'mi')).toBe('2 mi (3218.69 m)');
    expect(quantityText(44.756667, 'm/s', 'kn')).toBe('87 kn (44.76 m/s)');
    expect(quantityText(44.704, 'm/s', 'mph')).toBe('100 mph (44.7 m/s)');
    // No text unit, the stored unit itself, or one that does not convert: the stored value alone.
    expect(quantityText(121.92, 'm')).toBe('121.92 m');
    expect(quantityText(121.92, 'm', 'm')).toBe('121.92 m');
    expect(quantityText(12, 'm/s', 'ft')).toBe('12 m/s');
  });

  it('states every UTC instant of a sentence in the organization’s zone with its name', () => {
    expect(zonedInstantText('2026-11-10T16:05:00.000Z', 'America/Denver')).toBe('2026-11-10 09:05 America/Denver');
    expect(zonedInstantText('2026-07-01T14:00:30Z', 'America/Chicago')).toBe('2026-07-01 09:00:30 America/Chicago');
    expect(
      localizeInstants(
        'Takeoff 2026-11-10T16:05:00.000Z, landing 2026-11-10T16:47:00Z; due 2026-11-30.',
        'America/Denver',
      ),
    ).toBe('Takeoff 2026-11-10 09:05 America/Denver, landing 2026-11-10 09:47 America/Denver; due 2026-11-30.');
    expect(localizeInstants('At 2026-11-10T16:05:00Z.', undefined)).toBe('At 2026-11-10T16:05:00Z.');
    expect(localizeInstants('At 2026-11-10T16:05:00Z.', 'Mars/Olympus')).toBe('At 2026-11-10T16:05:00Z.');
  });
});
