import { describe, expect, it } from 'vitest';
import { comparePdfText, pageText } from '../../apps/web/src/sms-pdf-compare.js';

const manual = (revision: number, pages: string[]) =>
  pages.map((body, index) => pageText([body, `Aircraft inspection manual Revision ${revision} page ${index + 1}`]));

describe('PDF page comparison', () => {
  it('reports a footer revision mark once and lists only pages whose content changed', () => {
    const before = manual(4, [
      'Before flight inspect each arm and confirm the battery is secured.',
      'Engine run up check the motors and listen for vibration.',
      'After landing secure the aircraft and record the inspection.',
    ]);
    const after = manual(5, [
      'Before flight inspect each arm and confirm the battery is secured.',
      'Engine run up check the motors and listen for vibration.',
      'After landing check the rotor brake, secure the aircraft and record the inspection.',
    ]);
    const result = comparePdfText(before, after);
    expect(result.running).toEqual([{ removed: '4', added: '5' }]);
    expect(result.unchanged).toBe(2);
    expect(result.pages).toHaveLength(1);
    const [page] = result.pages;
    expect(page).toMatchObject({ kind: 'changed', fromPage: 3, toPage: 3 });
    const pieces = page!.kind === 'changed' ? page!.pieces : [];
    expect(pieces.filter((piece) => piece.kind === 'added' && !piece.running).map((piece) => piece.text)).toEqual([
      'check the rotor brake,',
    ]);
  });

  it('keeps later pages paired when a page is inserted or removed', () => {
    const first = 'Before flight inspect each arm and confirm the battery is secured.';
    const second = 'Engine run up check the motors and listen for vibration.';
    const third = 'After landing secure the aircraft and record the inspection.';
    const inserted = 'Rotor brake check the brake pads for wear before every flight.';
    const result = comparePdfText([first, second, third], [first, inserted, second]);
    expect(result.pages.map((page) => page.kind)).toEqual(['added', 'removed']);
    expect(result.pages[0]).toMatchObject({ kind: 'added', toPage: 2 });
    expect(result.pages[1]).toMatchObject({ kind: 'removed', fromPage: 3 });
    expect(result.unchanged).toBe(2);
  });
});
