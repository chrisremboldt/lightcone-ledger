import { diffLines } from './sms-document-diff.js';

export interface WordPiece {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** Part of a change repeated on most pages, such as a revision mark in a running footer. */
  running?: boolean;
}

export interface WordChange {
  removed: string;
  added: string;
}

export type PageChange =
  | { kind: 'changed'; fromPage: number; toPage: number; pieces: WordPiece[] }
  | { kind: 'added'; toPage: number; text: string }
  | { kind: 'removed'; fromPage: number; text: string };

export interface PdfComparison {
  fromPages: number;
  toPages: number;
  unchanged: number;
  running: WordChange[];
  pages: PageChange[];
}

const SAME_PAGE = 0.5;
const RUNNING_SHARE = 0.6;
const RUNNING_MIN_PAGES = 3;
const MAX_ALIGNMENT_CELLS = 1_000_000;

export const pageText = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim();

const words = (text: string) => (text ? text.split(' ') : []);

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Pairs pages that are recognisably the same page, keeping their order. */
function alignPages(from: string[], to: string[]): [number | null, number | null][] {
  if ((from.length + 1) * (to.length + 1) > MAX_ALIGNMENT_CELLS)
    return Array.from({ length: Math.max(from.length, to.length) }, (_, index) => [
      index < from.length ? index : null,
      index < to.length ? index : null,
    ]);
  const width = to.length + 1;
  const matches = (i: number, j: number) => similarity(from[i]!, to[j]!) >= SAME_PAGE;
  const best = new Uint32Array((from.length + 1) * width);
  for (let i = from.length - 1; i >= 0; i -= 1)
    for (let j = to.length - 1; j >= 0; j -= 1)
      best[i * width + j] = matches(i, j)
        ? best[(i + 1) * width + j + 1]! + 1
        : Math.max(best[(i + 1) * width + j]!, best[i * width + j + 1]!);
  const pairs: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (matches(i, j) && best[i * width + j] === best[(i + 1) * width + j + 1]! + 1) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (best[(i + 1) * width + j]! >= best[i * width + j + 1]!) {
      pairs.push([i, null]);
      i += 1;
    } else {
      pairs.push([null, j]);
      j += 1;
    }
  }
  while (i < from.length) pairs.push([i++, null]);
  while (j < to.length) pairs.push([null, j++]);
  return pairs;
}

interface Segment {
  same?: string[];
  removed?: string[];
  added?: string[];
}

function segments(before: string, after: string): Segment[] {
  const result: Segment[] = [];
  for (const token of diffLines(words(before).join('\n'), words(after).join('\n'))) {
    const last = result[result.length - 1];
    if (token.kind === 'same') {
      if (last?.same) last.same.push(token.text);
      else result.push({ same: [token.text] });
      continue;
    }
    let change = last && !last.same ? last : undefined;
    if (!change) {
      change = { removed: [], added: [] };
      result.push(change);
    }
    change[token.kind]!.push(token.text);
  }
  return result;
}

const changeKey = (segment: Segment) => `${segment.removed!.join(' ')}\u0000${segment.added!.join(' ')}`;

/** Compares two PDFs page by page from their extracted text. */
export function comparePdfText(from: string[], to: string[]): PdfComparison {
  const pairs = alignPages(from, to);
  const paired = pairs
    .filter((pair): pair is [number, number] => pair[0] !== null && pair[1] !== null)
    .map(([fromIndex, toIndex]) => ({ fromIndex, toIndex, segments: segments(from[fromIndex]!, to[toIndex]!) }));
  const pagesWithChange = new Map<string, number>();
  for (const page of paired)
    for (const key of new Set(page.segments.filter((segment) => !segment.same).map(changeKey)))
      pagesWithChange.set(key, (pagesWithChange.get(key) ?? 0) + 1);
  const running = new Set(
    paired.length >= RUNNING_MIN_PAGES
      ? [...pagesWithChange].filter(([, count]) => count >= paired.length * RUNNING_SHARE).map(([key]) => key)
      : [],
  );
  const changedPages = new Map<number, PageChange>();
  let unchanged = 0;
  for (const page of paired) {
    const changes = page.segments.filter((segment) => !segment.same);
    if (!changes.some((segment) => !running.has(changeKey(segment)))) {
      unchanged += 1;
      continue;
    }
    const pieces = page.segments.flatMap((segment): WordPiece[] => {
      if (segment.same) return [{ kind: 'same', text: segment.same.join(' ') }];
      const repeated = running.has(changeKey(segment));
      return [
        ...(segment.removed!.length
          ? [{ kind: 'removed' as const, text: segment.removed!.join(' '), running: repeated }]
          : []),
        ...(segment.added!.length
          ? [{ kind: 'added' as const, text: segment.added!.join(' '), running: repeated }]
          : []),
      ];
    });
    changedPages.set(page.toIndex, { kind: 'changed', fromPage: page.fromIndex + 1, toPage: page.toIndex + 1, pieces });
  }
  const pages = pairs.flatMap(([fromIndex, toIndex]): PageChange[] => {
    if (fromIndex === null) return [{ kind: 'added', toPage: toIndex! + 1, text: to[toIndex!]! }];
    if (toIndex === null) return [{ kind: 'removed', fromPage: fromIndex + 1, text: from[fromIndex]! }];
    const changed = changedPages.get(toIndex);
    return changed ? [changed] : [];
  });
  return {
    fromPages: from.length,
    toPages: to.length,
    unchanged,
    running: [...running].map((key) => {
      const [removed, added] = key.split('\u0000');
      return { removed: removed!, added: added! };
    }),
    pages,
  };
}
