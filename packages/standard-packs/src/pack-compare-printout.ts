import {
  MAX_ALIGNED_WORDS,
  type Difference,
  type Occurrence,
  type PackComparison,
  type QuotationComparison,
  type ResultCounts,
  type UnquotedPassage,
} from './pack-compare.js';

// The comparison as a person reads it. It says what the words did and never whether a rule still applies.

const fromWords: Record<PackComparison['pack']['from'], string> = {
  pack_folder: 'the pack folder',
  pack_file: 'the pack file',
  built_in: 'the pack built into Ledger',
};

/** What each result is called, in the report and in its closing counts. */
export const resultWords: Record<QuotationComparison['result'], string> = {
  unchanged: 'Unchanged',
  unchanged_but_for_spacing: 'Unchanged but for spacing',
  changed: 'Changed',
  not_found: 'Not found',
};

const kindWords: Record<QuotationComparison['kind'], string> = {
  rule: 'Rule',
  purpose: 'Purpose',
  required_record: 'Required record',
  retention: 'How long, for required record',
};

const percent = (share: number) => `${Math.round(share * 100)}%`;
const bytesWords = (span: { start: number; end: number }) => `bytes ${span.start} to ${span.end}`;
const linesWords = (first: number, last: number) => (first === last ? `line ${first}` : `lines ${first} to ${last}`);

const indented = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => `${prefix}${line.trimEnd()}`)
    .join('\n');

function wrapped(words: readonly string[], prefix: string, width = 110): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(`${prefix}${line}`);
      line = '';
    }
    line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, `${prefix}${line}`] : lines;
}

/** The differences in one run of words: [-only in the quotation-] and {+only in the new text+}. */
function differenceWords(differences: readonly Difference[]): string[] {
  return differences.flatMap(({ kind, words }) =>
    kind === 'same' ? words.split(' ') : [kind === 'quotation_only' ? `[-${words}-]` : `{+${words}+}`],
  );
}

function headLines(comparison: QuotationComparison): string[] {
  const name =
    comparison.kind === 'rule'
      ? `${comparison.id} version ${comparison.version}: ${comparison.title}`
      : `${kindWords[comparison.kind]} ${comparison.id}: ${comparison.title}`;
  const { old } = comparison;
  const where = old
    ? `, ${bytesWords(old)} of ${old.sourceId}${old.line === undefined ? '' : `, line ${old.line}`}`
    : '';
  return [name, `  Quotes ${comparison.reference}${where}`];
}

const occurrenceWords = (occurrence: Occurrence) => `${bytesWords(occurrence)}, line ${occurrence.line}`;

function foundLines(comparison: QuotationComparison): string[] {
  const { occurrences } = comparison;
  const how =
    comparison.result === 'unchanged'
      ? 'the quotation is in the new text byte for byte'
      : 'the same words are in the new text with different spaces or line breaks';
  if (occurrences.length === 1)
    return [
      `  ${resultWords[comparison.result]}: ${how}, at ${occurrenceWords(occurrences[0]!)}.`,
      ...(comparison.moved
        ? ['  Moved: the pack’s other quotations found in the new text keep the order they had; this one does not.']
        : []),
    ];
  return [
    `  ${resultWords[comparison.result]}: ${how}, ${occurrences.length} times. Which one is meant is for a person to read.`,
    ...occurrences.map(
      (occurrence) =>
        `    ${occurrenceWords(occurrence)}${occurrence.exact ? ' (byte for byte)' : ' (different spacing)'}`,
    ),
  ];
}

function absentLines(comparison: QuotationComparison): string[] {
  const { nearest } = comparison;
  const quotation = wrapped(comparison.quotation.split(' '), '      ');
  if (!nearest) {
    const words = comparison.quotation.split(' ').length;
    const why =
      words > MAX_ALIGNED_WORDS
        ? `its ${words} words are more than the ${MAX_ALIGNED_WORDS} the nearest passage is looked for`
        : 'no word of it is matched there';
    return [
      `  ${resultWords.not_found}: the quotation is not in the new text, and ${why}.`,
      '    The quotation:',
      ...quotation,
    ];
  }
  const holds = `${nearest.matchedWords} of its ${nearest.quotationWords} words in order (${percent(nearest.share)})`;
  const at = `${bytesWords(nearest)}, ${linesWords(nearest.line, nearest.lastLine)}`;
  if (comparison.result === 'not_found')
    return [
      `  ${resultWords.not_found}: nothing near the quotation is in the new text. The stretch that aligns best holds ${holds}, at ${at}.`,
      '    The quotation:',
      ...quotation,
    ];
  return [
    `  ${resultWords.changed}: the quotation is not in the new text. The nearest passage holds ${holds}, at ${at}:`,
    indented(nearest.text, '      '),
    '    Word by word, [-only in the quotation-] and {+only in the new text+}:',
    ...wrapped(differenceWords(nearest.differences), '      '),
  ];
}

function comparisonLines(comparison: QuotationComparison): string[] {
  return [
    ...headLines(comparison),
    ...(comparison.occurrences.length ? foundLines(comparison) : absentLines(comparison)),
    '',
  ];
}

function passageLine(passage: UnquotedPassage): string {
  const nearest = passage.nearestTo.length
    ? ` (the nearest passage to ${passage.nearestTo.join(', ')}, reported above as changed)`
    : '';
  return `  line ${passage.line}, ${bytesWords(passage)}: “${passage.opening}”${nearest}`;
}

function countsWords(counts: ResultCounts): string {
  const results = [
    `${resultWords.unchanged} ${counts.unchanged}`,
    `${resultWords.unchanged_but_for_spacing.toLowerCase()} ${counts.unchangedButForSpacing}`,
    `${resultWords.changed.toLowerCase()} ${counts.changed}`,
    `${resultWords.not_found.toLowerCase()} ${counts.notFound}`,
  ].join(', ');
  return `${counts.compared} compared. ${results}. Of those in the new text, moved: ${counts.moved}; there more than once: ${counts.moreThanOnce}.`;
}

/** The closing counts: each result for the rules, for the pack's other quotations, and the passages no rule quotes. */
export function countsLines(comparison: PackComparison): string[] {
  const { rules, otherQuotations, passages } = comparison.counts;
  return [
    `Rules: ${countsWords(rules)}`,
    ...(otherQuotations.compared
      ? [`Other quotations (purposes and required records): ${countsWords(otherQuotations)}`]
      : []),
    `Passages of the new text: ${passages.total}, of which no rule quotes ${passages.quotedByNoRule}.`,
  ];
}

/** The report without its closing counts: how the comparison was made, each quotation, the passages no rule quotes. */
export function comparisonReportLines(comparison: PackComparison, packPath: string, textPath: string): string[] {
  const { pack, newText, method, rules, otherQuotations, passages } = comparison;
  return [
    `Compared ${pack.packId} version ${pack.version}: ${pack.title}`,
    `  ${fromWords[pack.from]} ${packPath}, with the new text ${textPath}`,
    `  The new text is compared exactly as the file holds it: ${newText.byteLength} bytes of UTF-8, not re-encoded (SHA-256 ${newText.sha256}). A span is given in bytes of that file, from its first byte up to, not including, its end.`,
    `  Each quotation is looked for in three steps: ${method.steps.join('; then ')}.`,
    `  ${method.nearest.measure}`,
    `  ${method.passages.cut}`,
    '  This says what the words did. Whether a rule’s check still means what the new words say is for a person to read.',
    '',
    ...rules.flatMap(comparisonLines),
    ...(otherQuotations.length
      ? [
          'Other quotations the pack pins: purposes and required records',
          '',
          ...otherQuotations.flatMap(comparisonLines),
        ]
      : []),
    `Passages of the new text that no rule quotes (${passages.unquoted.length} of ${passages.total})`,
    ...passages.unquoted.map(passageLine),
    '',
  ];
}
