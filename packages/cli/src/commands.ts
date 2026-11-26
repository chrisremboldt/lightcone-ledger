import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  adoptionStands,
  isCheckedRuleLeaf,
  ruleFieldPaths,
  type AdoptionRuleCoverageResponse,
  type CoverageResult,
  type CurrentPrincipalResponse,
  type OperatorRecordCommitResponse,
  type OperatorRecordListResponse,
  type OperatorRecordPreviewResponse,
  type OperatorRecordTypeSummary,
  type OperatorRecordTypesResponse,
  type OrganizationCoverageResponse,
  type PackAdoptionRecord,
  type RuleCoverageSubject,
  type RulePackVersion,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { ruleReadLines } from './record-rule-read.js';
import { cell, plural, shortRuleId, subjectWords, table, withIndefiniteArticle, wrap, wrappedTable } from './format.js';
import {
  checkedByLabels,
  completeness,
  coverageResultLabels,
  coverageResultOrder,
  leafCheckedBy,
  missingWords,
  populationWords,
  sectionWords,
} from './words.js';

/** What a command found: its data for --json, and the lines a person reads. */
export interface Output {
  data: unknown;
  lines: string[];
  /** True when the API recorded nothing for some of what was asked, such as a refused row. */
  refused?: boolean;
}

/** A mistake in what was asked, said before anything is sent. */
export class UsageError extends Error {}
/** Something the client will not do, such as adopting with a service's credential. */
export class RefusalError extends Error {}

export interface Context {
  client: LedgerClient;
  /** Prints a line at once, before the command goes on; used to say who something will be recorded as. */
  say: (line: string) => void;
  /** Waits before a command is sent again; a test passes one that does not wait. */
  pause?: (milliseconds: number) => Promise<void>;
}

const kindWords: Record<string, string> = {
  human: 'a person',
  service: 'a service',
  source: 'a source',
  worker: 'a worker',
};

export async function me(context: Context): Promise<Output> {
  const read = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  const { principal, organization } = read;
  const grants = principal.observationGrants ?? [];
  return {
    data: read,
    lines: [
      `Signed in as ${principal.name} (${principal.id}), ${kindWords[principal.kind ?? 'human'] ?? principal.kind}.`,
      organization
        ? `Organization: ${organization.name} (${organization.id}), time zone ${organization.timeZone}.`
        : 'Organization: not returned.',
      `May: ${principal.capabilities.length ? principal.capabilities.join(', ') : 'nothing beyond reading who it is'}.`,
      grants.length
        ? `May record: ${grants.map((grant) => `${grant.observationType} under ${grant.sourceId}`).join('; ')}.`
        : 'May record: no observation grants.',
    ],
  };
}

/** The principal a command will be recorded as, in one sentence. */
async function recordedAs(client: LedgerClient): Promise<CurrentPrincipalResponse> {
  return client.request<CurrentPrincipalResponse>('/v1/me');
}

async function recordTypes(client: LedgerClient): Promise<OperatorRecordTypesResponse> {
  return client.request<OperatorRecordTypesResponse>('/v1/operator-records/types');
}

export async function recordType(client: LedgerClient, name: string): Promise<OperatorRecordTypeSummary> {
  const { types } = await recordTypes(client);
  const found = types.filter((type) => type.recordType === name).sort((a, b) => b.recordVersion - a.recordVersion)[0];
  if (!found) throw new UsageError(`${name} is not a record type. pnpm ledger records types lists them.`);
  return found;
}

export async function listRecordTypes(context: Context): Promise<Output> {
  const read = await recordTypes(context.client);
  return {
    data: read,
    lines: table(
      ['Record type', 'Version', 'Title', 'About'],
      read.types.map((type) => [
        type.recordType,
        String(type.recordVersion),
        type.title,
        type.subjectKinds.length ? type.subjectKinds.join(' or ') : 'your organization',
      ]),
    ),
  };
}

/** The other names accepted for units, as in "(also kt, kts)". */
function aliasWords(units: readonly { unit: string; aliases?: readonly string[] }[]): string {
  const aliases = units.flatMap((unit) => (unit.aliases ?? []).map((alias) => `${alias} for ${unit.unit}`));
  return aliases.length ? ` (also ${aliases.join(', ')})` : '';
}

/** What the columns that place a record in time need, which differs from every other required column. */
function placingLines(columns: OperatorRecordTypeSummary['columns']): string[] {
  const [first, ...others] = columns.filter((column) => column.placesRecord);
  if (!first) return [];
  const dated = first.takesDate
    ? " When only the date is known, write the date alone (2026-11-10): it is read as that day in the organization's time zone, and a check with a deadline reads the instant of that day least favourable to you and says only a date is on record."
    : '';
  const rest = others.length ? ` ${others.map((column) => column.key).join(' and ')} may be left empty.` : '';
  const ends = others.filter((column) => column.takesDate).map((column) => column.key);
  const endOfDay = ends.length
    ? ` A date alone in ${ends.join(' or ')} is the end of that day, so the same date in both is the whole day.`
    : '';
  return [
    `${first.key} places the record in time: a row with it empty is refused, not recorded.${rest}${dated}${endOfDay}`,
  ];
}

export async function recordColumns(context: Context, name: string): Promise<Output> {
  const type = await recordType(context.client, name);
  const what = (column: OperatorRecordTypeSummary['columns'][number]) =>
    [
      column.kind,
      column.options ? `one of ${column.options.map((option) => option.value).join(', ')}` : '',
      column.units
        ? `stored in ${column.units.stored}; for another unit name the column ${column.units.accepted.map((unit) => `"${column.units!.stem} [${unit.unit}]"`).join(' or ')}${aliasWords(column.units.accepted)}`
        : '',
      column.kind === 'date_time'
        ? `UTC (2026-11-10T15:00:00Z) or with an offset (2026-11-10T09:00-06:00); name the column "${column.key} [local]" to write 2026-11-10 09:00 in the organization's time zone${column.takesDate ? "; or the date alone (2026-11-10), read as that day in the organization's time zone" : ''}`
        : '',
      column.subjectKinds ? `${withIndefiniteArticle(column.subjectKinds.join(' or '))} id` : '',
    ]
      .filter(Boolean)
      .join('; ');
  return {
    data: type,
    lines: [
      `${type.title} (${type.recordType} version ${type.recordVersion}): ${type.description}`,
      '',
      ...table(
        ['Column', 'Required', 'What it holds', 'Meaning'],
        type.columns.map((column) => [
          column.key,
          column.placesRecord && column.required
            ? 'places the record'
            : column.required
              ? 'required'
              : column.requiredUnless
                ? `required unless ${column.requiredUnless}`
                : '',
          what(column),
          column.help ?? column.label,
        ]),
      ),
      '',
      ...placingLines(type.columns),
      'A required column left empty still records the row, marked incomplete.',
      ...ruleReadLines(type),
    ],
  };
}

export async function recordTemplate(context: Context, name: string): Promise<Output> {
  const type = await recordType(context.client, name);
  const csv = await context.client.request<string>(
    `/v1/operator-records/types/${encodeURIComponent(type.recordType)}/versions/${type.recordVersion}/template`,
  );
  return { data: { recordType: type.recordType, recordVersion: type.recordVersion, csv }, lines: [csv.trimEnd()] };
}

type ImportResponse = OperatorRecordPreviewResponse | OperatorRecordCommitResponse;

/** How the mapping read the export: what each column became, what was not read, constants and rows left out. */
export function mappingLines(mapping: OperatorRecordPreviewResponse['mapping']): string[] {
  if (!mapping) return [];
  return [
    `The mapping (file ${mapping.artifactId}) read the export’s columns as:`,
    ...mapping.columns.map((column) => `  ${column.source}: ${column.becomes}`),
    mapping.unread.length ? `Not read: ${mapping.unread.join(', ')}.` : 'Every column of the export was read.',
    ...(mapping.constants.length
      ? [
          `Stated by the mapping for every row, not held by the export: ${mapping.constants.map((constant) => `${constant.field} = ${constant.value}`).join('; ')}.`,
        ]
      : []),
    ...mapping.leftOut.map((row) => `  Row ${row.row}: left out by the mapping; ${row.reason}`),
  ];
}

/** A reason about a column heading, the same for every row that fills the column. */
const columnReason = (reason: string) => reason.startsWith('Column "');

/** The heading problems once, then each row with what is left of its reasons. */
export function importRowLines(response: Pick<ImportResponse, 'rows'>): string[] {
  const columns = [...new Set(response.rows.flatMap((row) => row.reasons.filter(columnReason)))];
  const lines: string[] = columns.length ? ['The columns:', ...columns.map((reason) => `  ${reason}`)] : [];
  for (const row of response.rows) {
    const who = row.subject ? ` (${row.subject.id})` : '';
    const own = row.reasons.filter((reason) => !columnReason(reason));
    const reasons = own.length ? own.join(' ') : 'Only the columns above.';
    if (row.status === 'refused') lines.push(`  Row ${row.row}${who}: refused. ${reasons}`);
    else if (row.missingRequired.length)
      lines.push(
        `  Row ${row.row}${who}: incomplete; nothing in ${row.missingRequired.map((field) => field.name).join(', ')}.`,
      );
    for (const conversion of row.conversions)
      lines.push(
        `  Row ${row.row}${who}: ${conversion.field} ${conversion.entered.value} ${conversion.entered.unit} kept as ${conversion.stored.value} ${conversion.stored.unit}.`,
      );
    for (const conversion of row.timeConversions ?? [])
      lines.push(
        `  Row ${row.row}${who}: ${conversion.field} ${conversion.entered}${conversion.timeZone ? ` in ${conversion.timeZone}` : ''} kept as ${conversion.stored}.`,
      );
    for (const note of row.notes ?? []) lines.push(`  Row ${row.row}${who}: ${note}`);
  }
  return lines;
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new UsageError(`Cannot read ${path}.`);
  }
}

/** The other files an import reads beside the file itself: a column mapping, or the original the file was read from. */
export interface ImportFiles {
  mapping?: string;
  original?: string;
}

/** The largest file Ledger keeps as an upload. */
const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

async function sendFile(
  context: Context,
  name: string,
  path: string,
  commit: boolean,
  files: ImportFiles = {},
): Promise<{ response: ImportResponse; as: CurrentPrincipalResponse; original?: string }> {
  const { mapping: mappingPath, original: originalPath } = files;
  if (mappingPath && originalPath)
    throw new UsageError(
      'Give --mapping or --original, not both: a file read from another file is already in Ledger’s own columns.',
    );
  const type = await recordType(context.client, name);
  const bytes = readBytes(path);
  const mappingBytes = mappingPath === undefined ? undefined : readBytes(mappingPath);
  const originalBytes = originalPath === undefined ? undefined : readBytes(originalPath);
  if (originalBytes && originalBytes.byteLength > UPLOAD_LIMIT_BYTES)
    throw new UsageError(
      `${basename(originalPath!)} is ${(originalBytes.byteLength / 1024 / 1024).toFixed(1)} MB; Ledger keeps a file of at most 10 MB, so it cannot be kept as the original. Nothing was sent.`,
    );
  const as = await recordedAs(context.client);
  const json = /\.json$/i.test(path);
  const file = mappingPath
    ? `${basename(path)} with the mapping ${basename(mappingPath)}`
    : originalPath
      ? `${basename(path)}, read from ${basename(originalPath)}`
      : basename(path);
  const kept = mappingPath || originalPath ? 'the two files themselves as uploads' : 'the file itself as an upload';
  context.say(
    commit
      ? `Importing ${file} as ${type.recordType} records, recorded as ${as.principal.name} (${as.principal.id}).`
      : `Checking ${file} as ${type.recordType} records. No record is made from it and no rule reads it; Ledger keeps ${kept} by ${as.principal.name}, as it keeps every file sent to it.`,
  );
  const key = randomUUID();
  const { artifact } = await context.client.upload(
    new Uint8Array(bytes),
    json ? 'application/json' : 'text/csv',
    key,
    basename(path),
  );
  const mapping = mappingBytes
    ? (
        await context.client.upload(
          new Uint8Array(mappingBytes),
          'application/yaml',
          `${key}:mapping`,
          basename(mappingPath!),
        )
      ).artifact
    : undefined;
  const original = originalBytes
    ? (
        await context.client.upload(
          new Uint8Array(originalBytes),
          'application/octet-stream',
          `${key}:original`,
          basename(originalPath!),
        )
      ).artifact
    : undefined;
  const response = await context.client.request<ImportResponse>(
    `/v1/operator-records/imports${commit ? '' : '/preview'}`,
    {
      method: 'POST',
      body: JSON.stringify({
        artifactId: artifact.id,
        recordType: type.recordType,
        recordVersion: type.recordVersion,
        ...(mapping ? { mappingArtifactId: mapping.id } : {}),
        ...(original ? { originalArtifactId: original.id } : {}),
      }),
    },
    `${key}:import`,
  );
  return { response, as, ...(original ? { original: original.id } : {}) };
}

/** Which file each record cites as its original, when it is not the import file. */
const originalLines = (original: string | undefined, files: ImportFiles) =>
  original && files.original
    ? [
        `Each record cites ${basename(files.original)}, kept as file ${original}, as its original, and names the row of this file it was read through.`,
      ]
    : [];

export async function checkRecords(
  context: Context,
  name: string,
  path: string,
  files: ImportFiles = {},
): Promise<Output> {
  const { response, original } = await sendFile(context, name, path, false, files);
  const preview = response as OperatorRecordPreviewResponse;
  const { summary } = preview;
  return {
    data: preview,
    refused: summary.refused > 0 || preview.problems.length > 0,
    lines: [
      ...preview.problems.map((problem) => `The file: ${problem}`),
      ...mappingLines(preview.mapping),
      ...originalLines(original, files),
      `${plural(summary.rows, 'row')}: ${summary.acceptable} can be recorded (${summary.incomplete} of them incomplete), ${summary.alreadyRecorded} already recorded, ${summary.refused} refused.`,
      ...(preview.granted
        ? []
        : ['This credential may not import these records: it needs input:write and a grant for the source.']),
      ...importRowLines(preview),
    ],
  };
}

export async function importRecords(
  context: Context,
  name: string,
  path: string,
  files: ImportFiles = {},
): Promise<Output> {
  const { response, original } = await sendFile(context, name, path, true, files);
  const committed = response as OperatorRecordCommitResponse;
  const { summary } = committed;
  return {
    data: committed,
    refused: summary.refused > 0 || committed.problems.length > 0,
    lines: [
      ...committed.problems.map((problem) => `The file: ${problem}`),
      ...mappingLines(committed.mapping),
      ...originalLines(original, files),
      `${plural(summary.rows, 'row')}: ${summary.recorded} recorded (${summary.incomplete} of them incomplete), ${summary.alreadyRecorded} already recorded, ${summary.refused} refused.`,
      ...(summary.recorded ? [] : ['Nothing was recorded from this file.']),
      ...importRowLines(committed),
    ],
  };
}

/** A time the list shows: the date alone when the record keeps only a date for the field that holds it. */
function shownTime(record: OperatorRecordListResponse['records'][number], value: string): string {
  const field = Object.keys(record.dayOnly ?? {}).find(
    (name) => Date.parse(String(record.record[name])) === Date.parse(value),
  );
  return field ? record.dayOnly![field]!.day : value;
}

export async function listRecords(
  context: Context,
  name: string,
  options: { subject?: string; limit?: number },
): Promise<Output> {
  const type = await recordType(context.client, name);
  const query = new URLSearchParams({ recordType: type.recordType, recordVersion: String(type.recordVersion) });
  if (options.subject) query.set('subjectId', options.subject);
  if (options.limit) query.set('limit', String(options.limit));
  const read = await context.client.request<OperatorRecordListResponse>(`/v1/operator-records?${query}`);
  return {
    data: read,
    lines: [
      ...table(
        ['Subject', 'When', 'Complete', 'Record', 'Ledger id (for replaces)'],
        read.records.map((record) => [
          `${record.subject.id}${record.secondarySubject ? ` / ${record.secondarySubject.id}` : ''}`,
          record.interval
            ? `${shownTime(record, record.interval.start)} to ${record.interval.end ? shownTime(record, record.interval.end) : 'open'}`
            : shownTime(record, record.occurredAt),
          record.complete ? 'yes' : `no: nothing in ${record.missingRequired.map((field) => field.name).join(', ')}`,
          cell(
            Object.entries(record.record)
              .map(
                ([field, value]) =>
                  `${field}=${record.dayOnly?.[field]?.day ?? (typeof value === 'string' ? value : JSON.stringify(value))}`,
              )
              .join('; ') + (record.replacedBy ? ' (replaced)' : ''),
            90,
          ),
          record.observationId,
        ]),
      ),
      ...(read.page.hasMore ? [`The newest ${read.page.returned} are shown; give --subject to see older ones.`] : []),
    ],
  };
}

/** The packs on offer, newest version first within each pack; only the latest of each unless every version is asked for. */
export function offeredPacks<T extends { packId: string; version: number }>(packs: readonly T[], all: boolean): T[] {
  const latest = new Map<string, number>();
  for (const pack of packs) latest.set(pack.packId, Math.max(latest.get(pack.packId) ?? 0, pack.version));
  return packs
    .filter((pack) => all || latest.get(pack.packId) === pack.version)
    .sort((a, b) => (a.packId === b.packId ? b.version - a.version : a.packId < b.packId ? -1 : 1));
}

export async function listPacks(context: Context, options: { all?: boolean } = {}): Promise<Output> {
  const read = await context.client.rulePacks();
  const shown = offeredPacks(read.packs, options.all === true);
  const earlier = read.packs.length - shown.length;
  return {
    data: options.all ? read : { ...read, packs: shown },
    lines: [
      ...table(
        ['Pack', 'Version', 'Title', 'From'],
        shown.map((pack) => [
          pack.packId,
          String(pack.version),
          pack.title,
          pack.origin.kind === 'built_in' ? 'ships with Ledger' : `your file ${pack.origin.file}`,
        ]),
      ),
      ...(earlier
        ? ['', `The latest version of each pack. ${plural(earlier, 'earlier version')} also offered: --all lists them.`]
        : []),
    ],
  };
}

/** The pack version asked for, or the highest this Ledger offers. */
export async function readPack(client: LedgerClient, packId: string, version?: number): Promise<RulePackVersion> {
  if (version === undefined) {
    const offered = (await client.rulePacks()).packs.filter((pack) => pack.packId === packId);
    if (!offered.length)
      throw new UsageError(`This Ledger offers no pack ${packId}. pnpm ledger packs list shows the packs it offers.`);
    version = Math.max(...offered.map((pack) => pack.version));
  }
  return (await client.rulePackVersion(packId, version)).pack;
}

/** For each rule a check runs, the field paths it reads and where it names each, as the pack file was built. */
function fieldLines(pack: RulePackVersion): string[] {
  const rules = pack.leaves.flatMap((leaf) =>
    isCheckedRuleLeaf(leaf)
      ? [
          `  ${shortRuleId(pack.packId, leaf.id)}: ${[
            ...new Set(ruleFieldPaths(leaf).map((item) => `${item.path} (${item.where})`)),
          ].join('; ')}`,
        ]
      : [],
  );
  return rules.length ? ['', 'Fields each rule reads, as the pack file was built:', ...rules] : [];
}

export async function showPack(context: Context, packId: string, version?: number): Promise<Output> {
  const pack = await readPack(context.client, packId, version);
  const listed = (await context.client.rulePacks()).packs.find(
    (item) => item.packId === pack.packId && item.version === pack.version,
  );
  const ownFile = listed !== undefined && listed.origin.kind !== 'built_in';
  return {
    data: pack,
    lines: [
      `${pack.title} (${pack.packId} version ${pack.version})`,
      ...(pack.sections ?? [{ id: '', title: '' }]).flatMap((section) => {
        const leaves = pack.sections ? pack.leaves.filter((leaf) => leaf.section === section.id) : pack.leaves;
        return [
          '',
          ...(section.title ? [section.title] : []),
          ...table(
            ['Rule', 'Paragraph', 'Title', 'How it is checked', 'Asks on adoption'],
            leaves.map((leaf) => [
              shortRuleId(pack.packId, leaf.id),
              leaf.paragraph ?? '',
              leaf.title,
              checkedByLabels[leafCheckedBy(leaf)],
              'adoptionParameters' in leaf
                ? leaf.adoptionParameters.map((parameter) => `${parameter.name} (${parameter.title})`).join(', ')
                : '',
            ]),
          ),
        ];
      }),
      ...(ownFile ? fieldLines(pack) : []),
    ],
  };
}

/** The adoptions coverage reads: those that stand (neither revised nor succeeded), of one pack when one is named. */
export function standingAdoptions(shown: OrganizationCoverageResponse, packId?: string): PackAdoptionRecord[] {
  const adoptions = shown.adoptions.filter(
    (adoption) => adoptionStands(adoption) && (!packId || adoption.pack.packId === packId),
  );
  if (packId && !adoptions.length)
    throw new UsageError(
      `Your organization has not adopted ${packId}. pnpm ledger coverage lists what it has adopted.`,
    );
  return adoptions;
}

function ruleFor(coverage: AdoptionRuleCoverageResponse, wanted: string) {
  const rule = coverage.rules.find(
    (item) => item.leafId === wanted || shortRuleId(coverage.packId, item.leafId) === wanted,
  );
  if (!rule)
    throw new UsageError(
      `${coverage.packId} has no rule ${wanted}. Its rules: ${coverage.rules.map((item) => shortRuleId(coverage.packId, item.leafId)).join(', ')}.`,
    );
  return rule;
}

async function subjectsBehind(
  client: LedgerClient,
  adoptionId: string,
  leafId: string,
  result: CoverageResult,
): Promise<RuleCoverageSubject[]> {
  const subjects: RuleCoverageSubject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const read = await client.ruleCoverageSubjects(adoptionId, leafId, {
      result,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    subjects.push(...read.subjects);
    if (!read.page.hasMore || !read.page.nextCursor) break;
    cursor = read.page.nextCursor;
  }
  return subjects;
}

/** The sentence behind one subject's result, as the Rules screen shows it. */
export function subjectSentence(subject: RuleCoverageSubject): string {
  return subject.missing.length ? missingWords(subject.missing) : (subject.evaluation?.summary ?? 'Not yet evaluated.');
}

/** The width the coverage table keeps to, so it reads in an ordinary terminal. */
export const COVERAGE_WIDTH = 140;

/**
 * The rules of one section as a table no wider than a terminal: the paragraph, the title with the rule's id, the
 * latest counts right after it, how it is checked and who it counts. Long titles and counts wrap.
 */
function coverageTable(read: AdoptionRuleCoverageResponse, rules: AdoptionRuleCoverageResponse['rules']): string[] {
  // A pack whose rules cite no paragraph needs no column for one.
  const paragraphs = rules.some((rule) => rule.paragraph);
  const table = wrappedTable(
    ['Paragraph', 'Rule', 'Latest results', 'How it is checked', 'Counted over'],
    rules.map((rule) => [
      rule.paragraph ?? '',
      `${rule.title} [${shortRuleId(read.packId, rule.leafId)}]`,
      [
        rule.counts
          ? coverageResultOrder
              .filter((result) => rule.counts![result])
              .map((result) => `${rule.counts![result]} · ${coverageResultLabels[result]}`)
              .join('; ')
          : '',
        rule.counts ? (completeness(rule, read.populationLimit) ?? '') : '',
      ]
        .filter(Boolean)
        .join(' '),
      checkedByLabels[rule.checkedBy],
      rule.populationSize === null ? '—' : `${populationWords(rule)}: ${rule.populationSize}`,
    ]),
    COVERAGE_WIDTH - 2,
    { 1: 4, 2: 3, 4: 2 },
    paragraphs ? [] : [0],
  );
  return table.map((line) => `  ${line}`);
}

/** A sentence wrapped to the coverage width. */
const prose = (text: string) => wrap(text, COVERAGE_WIDTH);

export interface CoverageOptions {
  pack?: string;
  rule?: string;
  result?: CoverageResult;
}

export async function coverage(context: Context, options: CoverageOptions): Promise<Output> {
  if (options.rule && !options.pack) throw new UsageError('--rule needs --pack: rule ids belong to a pack.');
  const shown = await context.client.organizationCoverage();
  const adoptions = standingAdoptions(shown, options.pack);
  const lines: string[] = [];
  const data: unknown[] = [];
  if (!adoptions.length)
    lines.push('Your organization has adopted no rule pack yet. pnpm ledger packs list shows the packs on offer.');
  for (const adoption of adoptions) {
    const read = await context.client.adoptionRuleCoverage(adoption.id);
    const listed: { leafId: string; result: CoverageResult; subjects: RuleCoverageSubject[] }[] = [];
    lines.push(
      ...prose(
        `${read.title} (${read.packId} version ${read.version}), ${read.mode}, ${adoption.state}, from ${adoption.effectiveInterval.start} until ${adoption.effectiveInterval.end}. Adoption ${read.adoptionId}. As of ${read.asOf}.`,
      ),
    );
    const rules = options.rule ? [ruleFor(read, options.rule)] : read.rules;
    if (!options.rule && !options.result)
      for (const section of read.sections) {
        const inSection = rules.filter((rule) => section.leafIds.includes(rule.leafId));
        lines.push('', ...prose(`${section.title}. ${sectionWords(section)}`));
        lines.push(...coverageTable(read, inSection));
      }
    else
      for (const rule of rules) {
        if (!rule.counts) {
          if (options.rule) lines.push(`  ${rule.title}: ${checkedByLabels[rule.checkedBy]}; no subjects are counted.`);
          continue;
        }
        const results = options.result
          ? [options.result]
          : coverageResultOrder.filter((result) => rule.counts![result]);
        for (const result of results) {
          if (!rule.counts[result]) {
            if (options.rule) lines.push(`  ${rule.title}: none ${coverageResultLabels[result].toLowerCase()}.`);
            continue;
          }
          const subjects = await subjectsBehind(context.client, read.adoptionId, rule.leafId, result);
          listed.push({ leafId: rule.leafId, result, subjects });
          lines.push(
            `  ${rule.title} (${shortRuleId(read.packId, rule.leafId)}): ${rule.counts[result]} · ${coverageResultLabels[result]}`,
          );
          for (const subject of subjects)
            lines.push(`    ${subjectWords(subject.subject)}: ${subjectSentence(subject)}`);
        }
      }
    lines.push('');
    data.push({ adoption, coverage: read, ...(listed.length ? { subjects: listed } : {}) });
  }
  return {
    data: { asOf: shown.asOf, adoptions: data },
    lines: lines.length && lines.at(-1) === '' ? lines.slice(0, -1) : lines,
  };
}
