import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';
import type { PackComparison, QuotationComparison } from './pack-compare.js';
import { PackFileError } from './pack-files.js';
import {
  quotationSites,
  SETTLE_FIELD,
  type QuotationSite,
  type SettleMarker,
  type SettleResult,
} from './pack-settle.js';

// The start of a pack folder's next version, written from a comparison with the new text: the new source, the
// version raised by one, and the description as it was. A quotation the new text holds once is left alone; every
// other one gains the marker pnpm pack:build refuses, for a person to settle. Nothing is rewritten by guess.

/** What was written, and which quotations were left for a person. */
export interface NextVersion {
  folder: string;
  version: number;
  sourceFile: string;
  kept: number;
  toSettle: { label: string; result: SettleResult }[];
}

type Fields = Record<string, unknown>;

/** The comparison of the quotation a description's item carries, matched as the builder numbers them. */
function comparisonAt(comparison: PackComparison, site: QuotationSite, provisions: number): QuotationComparison {
  const { rules, otherQuotations } = comparison;
  const records = otherQuotations.filter((other) => other.kind === 'required_record');
  const found =
    site.list === 'provisions'
      ? rules[site.index]
      : site.list === 'rules'
        ? rules[provisions + site.index]
        : site.list === 'purposes'
          ? otherQuotations.find((other) => other.kind === 'purpose' && other.id === site.fields.id)
          : site.retention
            ? otherQuotations.find((other) => other.kind === 'retention' && other.id === records[site.index]?.id)
            : records[site.index];
  if (!found) throw new PackFileError(`${site.label} has no quotation in the comparison; build the folder first`);
  return found;
}

const flat = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** The marker a quotation gets, or undefined when the new text holds it once and the description finds that one. */
function markerOf(compared: QuotationComparison, occurrence: unknown): SettleMarker | undefined {
  const was = compared.quotation;
  if (compared.result === 'changed')
    return { result: 'changed', was, nearest: flat(compared.nearest!.text), nearestLine: compared.nearest!.line };
  if (compared.result === 'not_found') return { result: 'not_found', was };
  const lines = compared.occurrences.map((found) => found.line);
  if (lines.length > 1) return { result: 'more_than_once', was, lines };
  if (typeof occurrence === 'number' && occurrence !== 1)
    return { result: 'occurrence_out_of_date', was, lines, occurrence };
  return undefined;
}

/** Puts the marker after the item's quotation, so the old words and what was found read together. */
function mark(document: Document, site: QuotationSite, marker: SettleMarker): void {
  const path = site.retention ? [site.list, site.index, 'retention'] : [site.list, site.index];
  const item = document.getIn(path);
  if (!isMap(item)) throw new PackFileError(`${site.label} is not a set of named values`);
  const after = item.items.findIndex(
    (pair) => isScalar(pair.key) && (pair.key.value === 'occurrence' || pair.key.value === 'quote'),
  );
  const pair = document.createPair(SETTLE_FIELD, marker);
  if (isScalar(pair.key))
    pair.key.commentBefore = ` Left by pnpm pack:compare for a person: settle it, then delete ${SETTLE_FIELD}.`;
  item.items.splice(after < 0 ? item.items.length : after + 1, 0, pair);
}

function sourceFileOf(description: Fields): string {
  const source = description.source as { file?: unknown } | undefined;
  return typeof source?.file === 'string' ? source.file : 'source.txt';
}

/**
 * Writes the start of the next version into an empty folder: the new text under the source's file name, byte for
 * byte, and pack.yaml with its comments kept, its version raised by one and a marker on every quotation that is not
 * in the new text exactly once.
 */
export function writeNextVersion(
  folder: string,
  target: string,
  comparison: PackComparison,
  newText: Buffer,
): NextVersion {
  if (existsSync(target) && readdirSync(target).length)
    throw new PackFileError(`${target} already holds files; give --write-next a new or empty folder`);
  const document = parseDocument(readFileSync(join(folder, 'pack.yaml'), 'utf8'));
  const description = document.toJS() as Fields;
  const version = (description.pack as { version: number }).version + 1;
  document.setIn(['pack', 'version'], version);
  const sites = quotationSites(description);
  const provisions = sites.filter((site) => site.list === 'provisions').length;
  const toSettle: NextVersion['toSettle'] = [];
  for (const site of sites) {
    const marker = markerOf(comparisonAt(comparison, site, provisions), site.fields.occurrence);
    if (!marker) continue;
    mark(document, site, marker);
    toSettle.push({ label: site.label, result: marker.result });
  }
  const sourceFile = sourceFileOf(description);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, sourceFile), newText);
  writeFileSync(join(target, 'pack.yaml'), document.toString({ lineWidth: 0, flowCollectionPadding: false }));
  return { folder: target, version, sourceFile, kept: sites.length - toSettle.length, toSettle };
}

const settleWords: Record<SettleResult, string> = {
  changed: 'its words changed',
  not_found: 'nothing near its words is in the new text',
  more_than_once: 'its words are in the new text more than once',
  occurrence_out_of_date: 'its words are in the new text once, and its occurrence says otherwise',
};

/** What the command prints about the folder it wrote. */
export function nextVersionLines(next: NextVersion): string[] {
  const count = (total: number) => `${total} quotation${total === 1 ? '' : 's'}`;
  return [
    `Wrote the start of version ${next.version} in ${next.folder}`,
    `  ${next.sourceFile} is the new text, byte for byte. pack.yaml is the description as it was, with version ${next.version}.`,
    `  ${count(next.kept)} kept as written: the new text holds each once.`,
    ...(next.toSettle.length
      ? [
          `  ${count(next.toSettle.length)} marked with ${SETTLE_FIELD} for a person; pnpm pack:build refuses the folder until each is settled:`,
          ...next.toSettle.map((item) => `    ${item.label}: ${settleWords[item.result]}`),
        ]
      : [`  Nothing is marked with ${SETTLE_FIELD}.`]),
    '  Everything else in the description (titles, parameters, checks, a waiver’s stated dates) was copied unchanged: read it against the new text.',
    `  Then build it into the folder that holds the earlier pack file, so rule versions follow it: pnpm pack:build ${next.folder} --out <that folder>`,
    '',
  ];
}
