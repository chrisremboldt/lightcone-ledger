import { describe, expect, it } from 'vitest';
import {
  documentTextMatches,
  documentTextParts,
  documentTextSections,
  nextDocumentMatch,
} from '../../apps/web/src/sms-document-text.js';

describe('document text reading', () => {
  it('preserves every source character through outlining and match highlighting', () => {
    const text = '# Aircraft <manual>\r\n  Keep **all** text & spaces.\n\n## Check [A+B] ##\rRun [a+b].\n';
    const sections = documentTextSections(text);
    const matches = documentTextMatches(text, '[a+b]');
    const parts = documentTextParts(text, matches, sections);
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(sections.map((section) => section.title)).toEqual(['Aircraft <manual>', 'Check [A+B]']);
    expect(sections.map((section) => text.slice(section.start, section.start + section.level))).toEqual(['#', '##']);
    expect(parts.filter((part) => part.matchIndex !== null).map((part) => part.text)).toEqual(['[A+B]', '[a+b]']);
    expect(parts.filter((part) => part.marker).map((part) => part.text)).toEqual(['# ', '## ']);
    expect(parts.filter((part) => part.heading !== null && !part.marker).map((part) => part.text)).toEqual([
      'Aircraft <manual>',
      'Check ',
      '[A+B]',
      ' ##',
    ]);
  });

  it('finds literal strings without interpreting punctuation, HTML or regular expressions', () => {
    const text = 'Use [A+B], then <script>alert("x")</script>. Keep .* and .* literally.';
    expect(documentTextMatches(text, '.*').map((match) => text.slice(match.start, match.end))).toEqual(['.*', '.*']);
    expect(documentTextMatches(text, '<script>').map((match) => text.slice(match.start, match.end))).toEqual([
      '<script>',
    ]);
    expect(documentTextMatches(text, '[').map((match) => text.slice(match.start, match.end))).toEqual(['[']);
    expect(documentTextMatches(text, '')).toEqual([]);
    expect(documentTextParts('', [], [])).toEqual([]);
  });

  it('wraps search navigation in both directions without inventing empty-query matches', () => {
    expect(nextDocumentMatch(1, 2, 1)).toBe(0);
    expect(nextDocumentMatch(0, 2, -1)).toBe(1);
    expect(nextDocumentMatch(0, 0, 1)).toBe(-1);
  });
});
