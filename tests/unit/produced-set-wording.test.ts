import { describe, expect, test } from 'vitest';
import { openedTimes } from '../../apps/web/src/ProducedSet.js';

describe('how often a link to a produced set was opened', () => {
  test('is said in words a person writes', () => {
    expect(openedTimes(0)).toBe('Not yet');
    expect(openedTimes(1)).toBe('Once');
    expect(openedTimes(2)).toBe('2 times');
  });
});
