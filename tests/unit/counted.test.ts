import { describe, expect, it } from 'vitest';
import { counted } from '../../apps/web/src/format.js';

describe('a count with its words', () => {
  it('is singular for one and plural for none and for more', () => {
    expect([0, 1, 2].map((count) => counted(count, 'rule'))).toEqual(['0 rules', '1 rule', '2 rules']);
    expect([0, 1, 2].map((count) => counted(count, 'person', 'people'))).toEqual(['0 people', '1 person', '2 people']);
    expect([0, 1, 2].map((count) => counted(count, 'finding is', 'findings are'))).toEqual([
      '0 findings are',
      '1 finding is',
      '2 findings are',
    ]);
  });
});
