import { isRetainedDocumentSource, type PackFile, type PackFileQuote, type RulePackVersion } from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';
import { PackFileError } from './pack-files.js';

// Compares the quotations a pack pins with a new source text: what the words did, quotation by quotation, and which
// passages of the new text no rule quotes. Ordinary code, the same answer for the same inputs; it never says whether
// a rule still applies (docs/design/pack-compare.md).

export type QuotationKind = 'rule' | 'purpose' | 'required_record' | 'retention';

/** One quotation a pack pins: its exact bytes, and where they sat in the text it quotes when the pack holds that. */
export interface PinnedQuotation {
  kind: QuotationKind;
  id: string;
  version?: number;
  title: string;
  reference: string;
  bytes: Buffer;
  old?: { sourceId: string; start: number; end: number; line?: number };
}

/** A pack version as the comparison reads it: every quotation it pins, rules first and in the pack's order. */
export interface ComparedPack {
  packId: string;
  version: number;
  title: string;
  from: 'pack_folder' | 'pack_file' | 'built_in';
  quotations: PinnedQuotation[];
}

/** Bytes of the new text as given: from `start` up to, not including, `end`, and the line `start` is on. */
export interface Span {
  start: number;
  end: number;
  line: number;
}

export interface Occurrence extends Span {
  /** True when the pinned bytes are there byte for byte; false when only the spacing differs. */
  exact: boolean;
}

export type CompareResult = 'unchanged' | 'unchanged_but_for_spacing' | 'changed' | 'not_found';

export interface Difference {
  kind: 'same' | 'quotation_only' | 'new_text_only';
  words: string;
}

/** The stretch of the new text nearest to a quotation that is not in it, and what differs word by word. */
export interface NearestPassage extends Span {
  lastLine: number;
  /** The whole lines of the new text that hold the stretch. */
  text: string;
  matchedWords: number;
  quotationWords: number;
  share: number;
  differences: Difference[];
}

export interface QuotationComparison {
  kind: QuotationKind;
  id: string;
  version?: number;
  title: string;
  reference: string;
  /** The pinned words with their spacing made uniform. */
  quotation: string;
  old?: PinnedQuotation['old'];
  result: CompareResult;
  occurrences: Occurrence[];
  /** True when it is in the new text once, and out of the order the pack's other quotations keep. */
  moved: boolean;
  nearest?: NearestPassage;
}

export interface UnquotedPassage extends Span {
  opening: string;
  /** The rules reported as changed whose nearest passage lies here. */
  nearestTo: string[];
}

export interface ResultCounts {
  compared: number;
  unchanged: number;
  unchangedButForSpacing: number;
  changed: number;
  notFound: number;
  moved: number;
  moreThanOnce: number;
}

export interface PackComparison {
  pack: { packId: string; version: number; title: string; from: ComparedPack['from'] };
  newText: { byteLength: number; sha256: string; encoding: 'utf-8'; comparedAs: string };
  method: {
    steps: string[];
    nearest: { measure: string; matchScore: number; passedOverCost: number; threshold: number };
    passages: { cutBy: 'paragraph_designators' | 'blank_lines'; designatorLines: number; cut: string };
  };
  rules: QuotationComparison[];
  otherQuotations: QuotationComparison[];
  passages: { total: number; unquoted: UnquotedPassage[] };
  counts: { rules: ResultCounts; otherQuotations: ResultCounts; passages: { total: number; quotedByNoRule: number } };
}

/** A word matched in order scores this; a word passed over in the quotation or the new text costs one. */
const MATCH_SCORE = 3;
const PASSED_OVER_COST = 1;
/** Below this share of the quotation's words matched in the nearest stretch, the result is "Not found". */
export const NEAREST_THRESHOLD = 0.6;
/** The alignment table grows with the square of the quotation; a longer quotation gets no nearest passage. */
export const MAX_ALIGNED_WORDS = 4000;
/** Designators are used to cut the text when at least this many of its lines begin with one. */
const MIN_DESIGNATOR_LINES = 2;

const flat = (text: string) => text.replace(/\s+/gu, ' ').trim();
const wordsOf = (text: string) => text.split(/\s+/u).filter(Boolean);

function lineStartsOf(bytes: Buffer): Int32Array {
  const starts = [0];
  for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) starts.push(at + 1);
  return Int32Array.from(starts);
}

/** The line a byte is on, counting from 1. */
function lineOf(lineStarts: Int32Array, offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** The new text as the comparison reads it: its bytes untouched, and its words with where each one sits. */
export interface NewText {
  bytes: Buffer;
  words: string[];
  wordStart: Int32Array;
  wordEnd: Int32Array;
  /** Line breaks between a word and the one before it: 0, 1, or 2 when at least one blank line lies between. */
  breaksBefore: Uint8Array;
  lineStarts: Int32Array;
  wordIds: Int32Array;
  idOfWord: Map<string, number>;
}

/**
 * Reads the new text exactly as the file holds it: the bytes are never re-encoded, and every span reported is in
 * them. Throws when the bytes are not UTF-8.
 */
export function readNewText(bytes: Buffer, name = 'The new text'): NewText {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PackFileError(
      `${name} is not valid UTF-8 text. The new text is compared exactly as the file holds it and is never re-encoded: save it as UTF-8 and compare again.`,
    );
  }
  const words: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const breaks: number[] = [];
  const idOfWord = new Map<string, number>();
  const ids: number[] = [];
  let character = 0;
  let byte = 0;
  for (const match of text.matchAll(/\S+/gu)) {
    const gap = text.slice(character, match.index);
    byte += Buffer.byteLength(gap, 'utf8');
    breaks.push(Math.min(2, gap.split('\n').length - 1));
    starts.push(byte);
    byte += Buffer.byteLength(match[0], 'utf8');
    ends.push(byte);
    character = match.index + match[0].length;
    words.push(match[0]);
    if (!idOfWord.has(match[0])) idOfWord.set(match[0], idOfWord.size);
    ids.push(idOfWord.get(match[0])!);
  }
  return {
    bytes,
    words,
    wordStart: Int32Array.from(starts),
    wordEnd: Int32Array.from(ends),
    breaksBefore: Uint8Array.from(breaks),
    lineStarts: lineStartsOf(bytes),
    wordIds: Int32Array.from(ids),
    idOfWord,
  };
}

const spanAt = (text: NewText, start: number, end: number): Span => ({
  start,
  end,
  line: lineOf(text.lineStarts, start),
});

/** Step one: every place the pinned bytes are in the new text, byte for byte. */
function exactOccurrences(text: NewText, pinned: Buffer): Span[] {
  const found: Span[] = [];
  if (pinned.length === 0) return found;
  for (let at = text.bytes.indexOf(pinned); at >= 0; at = text.bytes.indexOf(pinned, at + 1))
    found.push(spanAt(text, at, at + pinned.length));
  return found;
}

/**
 * Step two: every place the quotation's words are in the new text in order, with any run of spaces and line breaks
 * between them. This is how pnpm pack:build finds a quotation, so a quotation found here once builds as it is: the
 * first word may end a longer run of characters and the last may begin one.
 */
function spacedOccurrences(text: NewText, quoted: readonly string[]): Span[] {
  const found: Span[] = [];
  const count = quoted.length;
  if (count === 0) return found;
  const first = quoted[0]!;
  const last = quoted[count - 1]!;
  if (count === 1) {
    text.words.forEach((word, index) => {
      for (let at = word.indexOf(first); at >= 0; at = word.indexOf(first, at + 1)) {
        const start = text.wordStart[index]! + Buffer.byteLength(word.slice(0, at), 'utf8');
        found.push(spanAt(text, start, start + Buffer.byteLength(first, 'utf8')));
      }
    });
    return found;
  }
  for (let index = 0; index + count <= text.words.length; index++) {
    if (count > 2 && text.words[index + 1] !== quoted[1]) continue;
    if (!text.words[index]!.endsWith(first) || !text.words[index + count - 1]!.startsWith(last)) continue;
    let same = true;
    for (let offset = 2; same && offset < count - 1; offset++) same = text.words[index + offset] === quoted[offset];
    if (!same) continue;
    found.push(
      spanAt(
        text,
        text.wordEnd[index]! - Buffer.byteLength(first, 'utf8'),
        text.wordStart[index + count - 1]! + Buffer.byteLength(last, 'utf8'),
      ),
    );
  }
  return found;
}

/** Every place the quotation is in the new text: byte for byte where it is, and where only its spacing differs. */
function occurrencesOf(text: NewText, pinned: Buffer, quoted: readonly string[]): Occurrence[] {
  const exact = exactOccurrences(text, pinned);
  const respaced = spacedOccurrences(text, quoted).filter(
    (span) => !exact.some((whole) => whole.start <= span.start && span.end <= whole.end),
  );
  return [
    ...exact.map((span) => ({ ...span, exact: true })),
    ...respaced.map((span) => ({ ...span, exact: false })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
}

type Step = { kind: Difference['kind']; word: string };

/** What an alignment reads: the quotation's words and the text's as numbers, and which text words fit its ends. */
interface Aligned {
  quoted: Int32Array;
  text: Int32Array;
  /**
   * A quotation may begin and end inside a longer run of characters, as pnpm pack:build allows: bit 1 marks a text
   * word the quotation's first word ends, bit 2 one its last word begins.
   */
  ends: Uint8Array;
}

function alignedOf(text: NewText, quoted: readonly string[]): Aligned {
  const first = quoted[0]!;
  const last = quoted[quoted.length - 1]!;
  const single = quoted.length === 1;
  return {
    quoted: Int32Array.from(quoted, (word) => text.idOfWord.get(word) ?? -1),
    text: text.wordIds,
    ends: Uint8Array.from(text.words, (word) =>
      single ? (word.includes(first) ? 3 : 0) : (word.endsWith(first) ? 1 : 0) | (word.startsWith(last) ? 2 : 0),
    ),
  };
}

/** True when the quotation's word in this row is the text's word in this column; rows and columns count from 1. */
function sameWord(aligned: Aligned, row: number, column: number): boolean {
  if (row === 1) return (aligned.ends[column - 1]! & 1) !== 0;
  if (row === aligned.quoted.length) return (aligned.ends[column - 1]! & 2) !== 0;
  return aligned.quoted[row - 1] === aligned.text[column - 1];
}

/** The best-scoring cell of a word-by-word local alignment: where it ends in the quotation and in the text. */
function bestAlignmentEnd(aligned: Aligned): { score: number; quotedEnd: number; textEnd: number } {
  const rows = aligned.quoted.length;
  const best = { score: 0, quotedEnd: 0, textEnd: 0 };
  let previous = new Int32Array(rows + 1);
  let current = new Int32Array(rows + 1);
  for (let column = 1; column <= aligned.text.length; column++) {
    for (let row = 1; row <= rows; row++) {
      let score = previous[row]! - PASSED_OVER_COST;
      const overQuoted = current[row - 1]! - PASSED_OVER_COST;
      if (overQuoted > score) score = overQuoted;
      if (previous[row - 1]! + MATCH_SCORE > score && sameWord(aligned, row, column))
        score = previous[row - 1]! + MATCH_SCORE;
      if (score < 0) score = 0;
      current[row] = score;
      // Strictly greater only: of equal scores the first reached, which ends first in the text, is kept.
      if (score > best.score) Object.assign(best, { score, quotedEnd: row, textEnd: column });
    }
    [previous, current] = [current, previous];
  }
  return best;
}

const STOP = 0;
const MATCHED = 1;
const TEXT_PASSED = 2;
const QUOTED_PASSED = 3;

/**
 * The alignment that ends at the best cell, walked back to where it starts. An alignment scoring above zero passes
 * over fewer text words than MATCH_SCORE times its matches, so it lies within the columns recomputed here.
 */
function alignmentBack(
  aligned: Aligned,
  quotedEnd: number,
  textEnd: number,
): { quotedStart: number; textStart: number; moves: number[] } {
  const from = Math.max(0, textEnd - (MATCH_SCORE + 1) * quotedEnd);
  const width = textEnd - from;
  const moves = new Uint8Array((quotedEnd + 1) * (width + 1));
  let previous = new Int32Array(quotedEnd + 1);
  let current = new Int32Array(quotedEnd + 1);
  for (let column = 1; column <= width; column++) {
    for (let row = 1; row <= quotedEnd; row++) {
      let score = 0;
      let move = STOP;
      if (sameWord(aligned, row, from + column) && previous[row - 1]! + MATCH_SCORE > score) {
        score = previous[row - 1]! + MATCH_SCORE;
        move = MATCHED;
      }
      if (previous[row]! - PASSED_OVER_COST > score) {
        score = previous[row]! - PASSED_OVER_COST;
        move = TEXT_PASSED;
      }
      if (current[row - 1]! - PASSED_OVER_COST > score) {
        score = current[row - 1]! - PASSED_OVER_COST;
        move = QUOTED_PASSED;
      }
      current[row] = score;
      moves[row * (width + 1) + column] = move;
    }
    [previous, current] = [current, previous];
  }
  const walked: number[] = [];
  let row = quotedEnd;
  let column = width;
  for (let move = moves[row * (width + 1) + column]!; move !== STOP; move = moves[row * (width + 1) + column]!) {
    walked.push(move);
    if (move !== QUOTED_PASSED) column -= 1;
    if (move !== TEXT_PASSED) row -= 1;
  }
  return { quotedStart: row, textStart: from + column, moves: walked.reverse() };
}

/** Runs of the same kind joined; between two shared runs, the quotation's own words come before the new text's. */
function differencesOf(steps: readonly Step[]): Difference[] {
  const differences: Difference[] = [];
  const add = (kind: Difference['kind'], words: string[]) => {
    if (words.length) differences.push({ kind, words: words.join(' ') });
  };
  let same: string[] = [];
  let quotedOnly: string[] = [];
  let textOnly: string[] = [];
  const flush = () => {
    add('quotation_only', quotedOnly);
    add('new_text_only', textOnly);
    quotedOnly = [];
    textOnly = [];
  };
  for (const step of steps) {
    if (step.kind === 'same') {
      flush();
      same.push(step.word);
      continue;
    }
    add('same', same);
    same = [];
    (step.kind === 'quotation_only' ? quotedOnly : textOnly).push(step.word);
  }
  add('same', same);
  flush();
  return differences;
}

/** The whole lines of the new text from the line `start` is on through the line `end` closes on. */
function wholeLines(text: NewText, firstLine: number, lastLine: number): string {
  const from = text.lineStarts[firstLine - 1]!;
  const to = lastLine < text.lineStarts.length ? text.lineStarts[lastLine]! : text.bytes.length;
  return text.bytes
    .subarray(from, to)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
}

/**
 * Step three: the stretch of the new text that aligns best with the quotation word by word. Undefined when no word
 * of the quotation is in the new text, or the quotation is too long to align.
 */
function nearestPassage(text: NewText, quoted: readonly string[]): NearestPassage | undefined {
  if (quoted.length === 0 || quoted.length > MAX_ALIGNED_WORDS) return undefined;
  const aligned = alignedOf(text, quoted);
  const end = bestAlignmentEnd(aligned);
  if (end.score === 0) return undefined;
  const back = alignmentBack(aligned, end.quotedEnd, end.textEnd);
  const steps: Step[] = quoted.slice(0, back.quotedStart).map((word) => ({ kind: 'quotation_only', word }));
  let row = back.quotedStart;
  let column = back.textStart;
  for (const move of back.moves) {
    if (move === MATCHED) steps.push({ kind: 'same', word: quoted[row]! });
    else if (move === TEXT_PASSED) steps.push({ kind: 'new_text_only', word: text.words[column]! });
    else steps.push({ kind: 'quotation_only', word: quoted[row]! });
    if (move !== QUOTED_PASSED) column += 1;
    if (move !== TEXT_PASSED) row += 1;
  }
  for (const word of quoted.slice(end.quotedEnd)) steps.push({ kind: 'quotation_only', word });
  const matchedWords = back.moves.filter((move) => move === MATCHED).length;
  const span = spanAt(text, text.wordStart[back.textStart]!, text.wordEnd[end.textEnd - 1]!);
  const lastLine = lineOf(text.lineStarts, span.end - 1);
  return {
    ...span,
    lastLine,
    text: wholeLines(text, span.line, lastLine),
    matchedWords,
    quotationWords: quoted.length,
    share: matchedWords / quoted.length,
    differences: differencesOf(steps),
  };
}

function compareQuotation(text: NewText, pinned: PinnedQuotation): QuotationComparison {
  const words = pinned.bytes.toString('utf8');
  const quoted = wordsOf(words);
  const occurrences = occurrencesOf(text, pinned.bytes, quoted);
  const nearest = occurrences.length ? undefined : nearestPassage(text, quoted);
  const result: CompareResult = occurrences.some((occurrence) => occurrence.exact)
    ? 'unchanged'
    : occurrences.length
      ? 'unchanged_but_for_spacing'
      : nearest && nearest.share >= NEAREST_THRESHOLD
        ? 'changed'
        : 'not_found';
  return {
    kind: pinned.kind,
    id: pinned.id,
    ...(pinned.version === undefined ? {} : { version: pinned.version }),
    title: pinned.title,
    reference: pinned.reference,
    quotation: flat(words),
    ...(pinned.old ? { old: pinned.old } : {}),
    result,
    occurrences,
    moved: false,
    ...(nearest ? { nearest } : {}),
  };
}

/**
 * Marks the quotations that left the order the others keep. Among the quotations of one source that are in the new
 * text exactly once, the longest run that still reads in the old order stays; each one outside it is marked. Of
 * equally long runs the choice follows the old order alone, so the same inputs mark the same quotations.
 */
function markMoved(comparisons: QuotationComparison[]): void {
  const bySource = new Map<string, QuotationComparison[]>();
  for (const comparison of comparisons)
    if (comparison.old && comparison.occurrences.length === 1)
      bySource.set(comparison.old.sourceId, [...(bySource.get(comparison.old.sourceId) ?? []), comparison]);
  for (const placed of bySource.values()) {
    const inOldOrder = [...placed].sort(
      (left, right) => left.old!.start - right.old!.start || left.old!.end - right.old!.end,
    );
    const newStart = inOldOrder.map((comparison) => comparison.occurrences[0]!.start);
    const length = newStart.map(() => 1);
    const before = newStart.map(() => -1);
    for (let index = 0; index < newStart.length; index++)
      for (let earlier = 0; earlier < index; earlier++)
        if (newStart[earlier]! <= newStart[index]! && length[earlier]! + 1 > length[index]!) {
          length[index] = length[earlier]! + 1;
          before[index] = earlier;
        }
    const kept = new Set<number>();
    for (let index = length.indexOf(Math.max(0, ...length)); index >= 0; index = before[index]!) kept.add(index);
    inOldOrder.forEach((comparison, index) => {
      comparison.moved = !kept.has(index);
    });
  }
}

/** A passage of the new text: its bytes, the line it starts on and the words it holds. */
interface Passage extends Span {
  firstWord: number;
  endWord: number;
}

const designatorWord = /^(?:<[^<>]*>)*(?:\([A-Za-z0-9]{1,5}\)|§)/u;
const sectionWord = /^(?:<[^<>]*>)*Sec\.$/u;

/** True for a word that begins a line with a paragraph designator: (a), (1), § 108.40, or Sec. 108.40. */
function beginsWithDesignator(text: NewText, index: number): boolean {
  if (index > 0 && text.breaksBefore[index] === 0) return false;
  const word = text.words[index]!;
  return designatorWord.test(word) || (sectionWord.test(word) && /^\d/u.test(text.words[index + 1] ?? ''));
}

/**
 * Cuts the new text into passages: at each line that begins with a paragraph designator where the text has them,
 * otherwise at blank lines. Nothing cleverer: the report says which was used.
 */
function passagesOf(text: NewText): {
  cutBy: 'paragraph_designators' | 'blank_lines';
  designatorLines: number;
  passages: Passage[];
} {
  const designated = text.words.map((_, index) => beginsWithDesignator(text, index));
  const designatorLines = designated.filter(Boolean).length;
  const cutBy = designatorLines >= MIN_DESIGNATOR_LINES ? 'paragraph_designators' : 'blank_lines';
  const starts = text.words
    .map((_, index) => index)
    .filter(
      (index) =>
        index === 0 || (cutBy === 'paragraph_designators' ? designated[index] : text.breaksBefore[index] === 2),
    );
  const passages = starts.map((firstWord, position) => {
    const endWord = starts[position + 1] ?? text.words.length;
    return { ...spanAt(text, text.wordStart[firstWord]!, text.wordEnd[endWord - 1]!), firstWord, endWord };
  });
  return { cutBy, designatorLines, passages };
}

const overlaps = (left: { start: number; end: number }, right: { start: number; end: number }) =>
  left.start < right.end && right.start < left.end;

const shortened = (text: string, limit = 100) => {
  const words = flat(text);
  return words.length > limit ? `${words.slice(0, limit - 1)}…` : words;
};

/** The passages no rule's quotation lies in, each with the rules reported as changed whose nearest passage is there. */
function unquotedPassages(text: NewText, passages: readonly Passage[], rules: readonly QuotationComparison[]) {
  const quoted = rules.flatMap((rule) => rule.occurrences);
  const changed = rules.filter((rule) => rule.result === 'changed');
  return passages
    .filter((passage) => !quoted.some((occurrence) => overlaps(passage, occurrence)))
    .map((passage): UnquotedPassage => ({
      start: passage.start,
      end: passage.end,
      line: passage.line,
      opening: shortened(text.bytes.subarray(passage.start, passage.end).toString('utf8')),
      nearestTo: changed.filter((rule) => overlaps(passage, rule.nearest!)).map((rule) => rule.id),
    }));
}

function countsOf(comparisons: readonly QuotationComparison[]): ResultCounts {
  const count = (result: CompareResult) => comparisons.filter((comparison) => comparison.result === result).length;
  return {
    compared: comparisons.length,
    unchanged: count('unchanged'),
    unchangedButForSpacing: count('unchanged_but_for_spacing'),
    changed: count('changed'),
    notFound: count('not_found'),
    moved: comparisons.filter((comparison) => comparison.moved).length,
    moreThanOnce: comparisons.filter((comparison) => comparison.occurrences.length > 1).length,
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

function methodOf(cutBy: 'paragraph_designators' | 'blank_lines', designatorLines: number, passages: number) {
  const count = `${passages} passage${passages === 1 ? '' : 's'}`;
  return {
    steps: [
      'the quotation’s exact bytes',
      'its words in order, with any run of spaces and line breaks taken as one space',
      'the nearest passage',
    ],
    nearest: {
      measure: `The nearest passage is the stretch of the new text that aligns best with the quotation word by word, scoring ${MATCH_SCORE} for each word found in order and taking ${PASSED_OVER_COST} off for each word passed over in either; when it holds fewer than ${percent(NEAREST_THRESHOLD)} of the quotation’s words the result is Not found, and of equal scores the first in the text is taken. Words are compared exactly, capitals and punctuation included.`,
      matchScore: MATCH_SCORE,
      passedOverCost: PASSED_OVER_COST,
      threshold: NEAREST_THRESHOLD,
    },
    passages: {
      cutBy,
      designatorLines,
      cut:
        cutBy === 'paragraph_designators'
          ? `The new text is cut into ${count} at each line that begins with a paragraph designator such as (a), (1), § 108.40 or Sec. 108.40 (${designatorLines} such lines).`
          : `The new text is cut into ${count} at blank lines: fewer than ${MIN_DESIGNATOR_LINES} of its lines begin with a paragraph designator such as (a), (1) or § 108.40.`,
    },
  };
}

/**
 * Compares every quotation the pack pins with the new text, in three steps: the exact bytes, then the words with
 * their spacing made uniform, then the nearest passage. The same pack and the same bytes always give the same report.
 */
export function comparePack(pack: ComparedPack, text: NewText): PackComparison {
  const comparisons = pack.quotations.map((pinned) => compareQuotation(text, pinned));
  markMoved(comparisons);
  const rules = comparisons.filter((comparison) => comparison.kind === 'rule');
  const otherQuotations = comparisons.filter((comparison) => comparison.kind !== 'rule');
  const { cutBy, designatorLines, passages } = passagesOf(text);
  const unquoted = unquotedPassages(text, passages, rules);
  return {
    pack: { packId: pack.packId, version: pack.version, title: pack.title, from: pack.from },
    newText: {
      byteLength: text.bytes.length,
      sha256: sha256(text.bytes),
      encoding: 'utf-8',
      comparedAs: 'the bytes of the file as it holds them, not re-encoded; every span is in those bytes',
    },
    method: methodOf(cutBy, designatorLines, passages.length),
    rules,
    otherQuotations,
    passages: { total: passages.length, unquoted },
    counts: {
      rules: countsOf(rules),
      otherQuotations: countsOf(otherQuotations),
      passages: { total: passages.length, quotedByNoRule: unquoted.length },
    },
  };
}

/** Every quotation a pack file pins: each rule's, then each purpose's, each required record's and its retention's. */
export function packFileQuotations(file: PackFile, from: 'pack_folder' | 'pack_file'): ComparedPack {
  const sources = new Map(
    file.sources.map((source) => {
      const bytes = Buffer.from(source.text, 'utf8');
      return [source.id, { bytes, lineStarts: lineStartsOf(bytes) }];
    }),
  );
  const pinned = (kind: QuotationKind, id: string, title: string, quote: PackFileQuote, version?: number) => {
    const source = sources.get(quote.source)!;
    return {
      kind,
      id,
      ...(version === undefined ? {} : { version }),
      title,
      reference: quote.reference,
      bytes: source.bytes.subarray(quote.start, quote.end),
      old: { sourceId: quote.source, start: quote.start, end: quote.end, line: lineOf(source.lineStarts, quote.start) },
    } satisfies PinnedQuotation;
  };
  return {
    packId: file.packId,
    version: file.version,
    title: file.title,
    from,
    quotations: [
      ...file.rules.map((rule) => pinned('rule', rule.id, rule.title, rule.quote, rule.version)),
      ...(file.purposes ?? []).map((purpose) => pinned('purpose', purpose.id, purpose.title, purpose.quote)),
      ...(file.requiredRecords ?? []).flatMap((record) => [
        pinned('required_record', record.id, record.title, record.quote),
        ...(record.retention ? [pinned('retention', record.id, record.title, record.retention.quote)] : []),
      ]),
    ],
  };
}

type QuotedSource = RulePackVersion['leaves'][number]['source'];

/**
 * Every quotation a registered pack version holds, read from the version itself: each rule's source carries its
 * quoted words, and a paragraph of a retained document carries its byte span in that document.
 */
export function registeredPackQuotations(version: RulePackVersion): ComparedPack {
  const pinned = (kind: QuotationKind, id: string, title: string, source: QuotedSource, ruleVersion?: number) => {
    const head = { kind, id, ...(ruleVersion === undefined ? {} : { version: ruleVersion }), title };
    if (isRetainedDocumentSource(source)) {
      const { start, end, sourceId } = source.textSpan;
      return {
        ...head,
        reference: source.reference,
        bytes: Buffer.from(source.text, 'utf8'),
        old: { sourceId, start, end },
      } satisfies PinnedQuotation;
    }
    // Text a rule carries whole has no place in a kept document to report.
    const whole = Buffer.from(source.text, 'utf8');
    return {
      ...head,
      reference: source.reference,
      bytes: whole.subarray(source.textSpan.start, source.textSpan.end),
    } satisfies PinnedQuotation;
  };
  return {
    packId: version.packId,
    version: version.version,
    title: version.title,
    from: 'built_in',
    quotations: [
      ...version.leaves.map((leaf) => pinned('rule', leaf.id, leaf.title, leaf.source, leaf.version)),
      ...(version.purposes ?? []).map((purpose) => pinned('purpose', purpose.id, purpose.title, purpose.source)),
      ...(version.requiredRecords ?? []).flatMap((record) => [
        pinned('required_record', record.id, record.title, record.source),
        ...(record.retention ? [pinned('retention', record.id, record.title, record.retention.source)] : []),
      ]),
    ],
  };
}
