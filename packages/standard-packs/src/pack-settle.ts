import { PackFileError } from './pack-files.js';

// What pnpm pack:compare --write-next leaves in a pack.yaml for a person to settle, and how pnpm pack:build refuses a
// description that still holds one. The marker is data in the description: nothing about it is decided by code.

/** The field a quotation of a description carries until a person has settled it. */
export const SETTLE_FIELD = 'settle';

/** Why a quotation was left for a person. */
export const settleResults = ['changed', 'not_found', 'more_than_once', 'occurrence_out_of_date'] as const;
export type SettleResult = (typeof settleResults)[number];

/** The marker: what the comparison found, the old quotation, and what the new text has nearest to it. */
export interface SettleMarker {
  result: SettleResult;
  /** The quotation the earlier version pinned, with its spacing made uniform. */
  was: string;
  /** The lines of the new text nearest to it, when its words changed. */
  nearest?: string;
  nearestLine?: number;
  /** The lines of the new text it starts on, when it is there more than once or its occurrence is out of date. */
  lines?: number[];
  occurrence?: number;
}

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const listOf = (value: unknown): Fields[] => (Array.isArray(value) ? value.filter(isFields) : []);

const named = (fields: Fields, name: string, fallback: number) =>
  typeof fields[name] === 'string' || typeof fields[name] === 'number' ? String(fields[name]) : String(fallback);

const titled = (fields: Fields) => (typeof fields.title === 'string' ? ` (${fields.title})` : '');

/** One quotation of a description: the name the builder gives the item, and where its fields are. */
export interface QuotationSite {
  label: string;
  list: 'provisions' | 'rules' | 'purposes' | 'records';
  index: number;
  /** True for the words that say how long a record is kept, under the record's retention. */
  retention: boolean;
  fields: Fields;
}

/** Every item of a description that carries a quotation, in the order the builder reads them. */
export function quotationSites(description: Fields): QuotationSite[] {
  const sites: QuotationSite[] = [];
  const add = (list: QuotationSite['list'], index: number, label: string, fields: Fields, retention = false) =>
    sites.push({ label, list, index, retention, fields });
  listOf(description.provisions).forEach((fields, index) =>
    add('provisions', index, `Provision ${named(fields, 'number', index + 1)}${titled(fields)}`, fields),
  );
  listOf(description.rules).forEach((fields, index) =>
    add('rules', index, `Rule ${named(fields, 'id', index + 1)}${titled(fields)}`, fields),
  );
  listOf(description.purposes).forEach((fields, index) =>
    add('purposes', index, `Purpose ${named(fields, 'id', index + 1)}`, fields),
  );
  listOf(description.records).forEach((fields, index) => {
    const label = `Record ${named(fields, 'id', index + 1)}`;
    add('records', index, label, fields);
    if (isFields(fields.retention)) add('records', index, `${label} retention`, fields.retention, true);
  });
  return sites;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const lineNumbers = (value: unknown) =>
  Array.isArray(value) && value.length && value.every((line) => Number.isSafeInteger(line))
    ? (value as number[]).join(', ')
    : undefined;

/** What the comparison found, and what the person does about it. */
function findingAndRemedy(marker: Fields): { found: string; remedy: string } {
  const lines = lineNumbers(marker.lines);
  switch (marker.result) {
    case 'changed':
      return {
        found: 'its words changed in the new text',
        remedy: 'Write in quote the words of the new text it should carry, or remove it',
      };
    case 'not_found':
      return {
        found: 'nothing near its words is in the new text',
        remedy: 'Remove it, or write in quote the words of the new text it should carry',
      };
    case 'more_than_once':
      return {
        found: `its words are in the new text more than once${lines ? `, starting on lines ${lines}` : ''}`,
        remedy: 'Say which with occurrence: N (1 for the first), or quote more of it',
      };
    case 'occurrence_out_of_date':
      return {
        found: `its words are in the new text once${lines ? `, on line ${lines}` : ''}, but it gives occurrence: ${String(marker.occurrence ?? 'N')}`,
        remedy: 'Remove occurrence',
      };
    default:
      return { found: 'a comparison left it for a person', remedy: 'Read it against the source' };
  }
}

function markedLines(label: string, marker: unknown): string[] {
  const fields = isFields(marker) ? marker : {};
  const { found, remedy } = findingAndRemedy(fields);
  const was = text(fields.was);
  const nearest = text(fields.nearest);
  const at = Number.isSafeInteger(fields.nearestLine) ? ` (line ${String(fields.nearestLine)})` : '';
  return [
    `  ${label}: ${found}.`,
    ...(was ? [`    Old quotation: "${was}"`] : []),
    ...(nearest ? [`    Nearest passage of the new text${at}: "${nearest}"`] : []),
    `    ${remedy}, then delete ${SETTLE_FIELD}.`,
  ];
}

/**
 * Refuses a description that still holds a quotation a person must settle, naming each with its old quotation and
 * the nearest passage of the new text. A description without the marker passes untouched.
 */
export function refuseUnsettled(description: Fields): void {
  const marked = quotationSites(description).filter((site) => site.fields[SETTLE_FIELD] !== undefined);
  if (!marked.length) return;
  const count = marked.length === 1 ? '1 quotation' : `${marked.length} quotations`;
  throw new PackFileError(
    [
      `This description was started by pnpm pack:compare and has ${count} a person must settle before it builds:`,
      ...marked.flatMap((site) => markedLines(site.label, site.fields[SETTLE_FIELD])),
    ].join('\n'),
  );
}
