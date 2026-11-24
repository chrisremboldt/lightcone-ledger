import { describe, expect, it } from 'vitest';
import { diffLines, withContext } from '../../apps/web/src/sms-document-diff.js';

describe('document revision diff', () => {
  it('shows exactly the lines a revision added and removed', () => {
    const before = ['1. Scope', '2. Wind limit 25 kt', '3. Crew', '4. Records'].join('\n');
    const after = ['1. Scope', '2. Wind limit 20 kt', '3. Crew', '3a. Visual observer', '4. Records'].join('\n');
    expect(diffLines(before, after)).toEqual([
      { kind: 'same', text: '1. Scope' },
      { kind: 'removed', text: '2. Wind limit 25 kt' },
      { kind: 'added', text: '2. Wind limit 20 kt' },
      { kind: 'same', text: '3. Crew' },
      { kind: 'added', text: '3a. Visual observer' },
      { kind: 'same', text: '4. Records' },
    ]);
  });

  it('rebuilds both texts from the diff', () => {
    const before = 'a\nb\nc\nd\ne\nf';
    const after = 'b\nc\nx\ne\nf\ng';
    const lines = diffLines(before, after);
    const text = (kind: 'removed' | 'added') =>
      lines
        .filter((line) => line.kind !== kind)
        .map((line) => line.text)
        .join('\n');
    expect(text('added')).toBe(before);
    expect(text('removed')).toBe(after);
  });

  it('folds unchanged lines away from changes', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) => (index === 10 ? 'changed' : line));
    const blocks = withContext(diffLines(before.join('\n'), after.join('\n')));
    expect(blocks[0]).toEqual({ kind: 'skipped', count: 8 });
    expect(blocks.at(-1)).toEqual({ kind: 'skipped', count: 7 });
    expect(blocks.filter((block) => block.kind !== 'skipped')).toHaveLength(6);
  });
});
