import { describe, expect, it } from 'vitest';
import { readableQuote } from '../src/index.js';

describe('A quoted paragraph as a person reads it', () => {
  it('drops a retained document’s element tags, breaks between paragraphs and reads entities', () => {
    expect(
      readableQuote(
        '<P>(a) A remote pilot in command &amp; crew must keep\n  the record.</P>\n<PRTPAGE P="923"/>\n<P>(b) Each record is kept for the operator&#8217;s 24 months.</P>',
      ),
    ).toBe(
      '(a) A remote pilot in command & crew must keep the record.\n\n(b) Each record is kept for the operator’s 24 months.',
    );
  });

  it('leaves text without tags as it is, including a comparison written with angle brackets', () => {
    const text = 'Keep wind < 10 m/s and gusts > 2 m/s apart.\nSecond line.';
    expect(readableQuote(text)).toBe(text);
  });
});

describe('A quoted paragraph from plain text wrapped to a line length', () => {
  it('joins the wrapped lines and keeps each paragraph on its own line', () => {
    expect(
      readableQuote(
        '(3) Records of each flight performed under this part which \nincludes--\n    (i) The time, date, and duration of the flight;\n    (iv) The individual flight paths of each flight including origin, \ndestination, and altitude(s);',
      ),
    ).toBe(
      '(3) Records of each flight performed under this part which includes--\n(i) The time, date, and duration of the flight;\n(iv) The individual flight paths of each flight including origin, destination, and altitude(s);',
    );
  });
});
