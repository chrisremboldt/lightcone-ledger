import {
  isPackFileCheckedRule,
  PACK_FILE_FORMAT,
  smsRecordKindValues,
  PackFileIdPattern,
  PackFileCheckedRuleSchema,
  PackFileCoverageRuleSchema,
  type PackFile,
  type PackFilePurpose,
  type PackFileRequiredRecord,
  type PackFileRule,
  type PackFileSource,
  type RulePackSection,
  type RulePackWaiver,
} from '@ledger/contracts';
import { withPopulation } from '@ledger/domain';
import { sha256 } from '@ledger/integrity';
import {
  findObligationType,
  limitedToCitingFlights,
  obligationParameterProblems,
  type EvidenceMode,
  type ObligationParameters,
} from '@ledger/pack-example-waiver';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { fieldPathProblems } from './pack-field-paths.js';
import { PackFileError, packFileVersion, verifiedPackFile } from './pack-files.js';
import { obligationParametersWithUnits, parametersWithUnits } from './pack-units.js';

/** The id the single source document of a described pack takes in its pack file. */
export const DESCRIBED_SOURCE_ID = 'source';

const idPattern = new RegExp(PackFileIdPattern);
const ajv = new Ajv({ strict: false, allErrors: false, allowUnionTypes: true });
const validCheckedRule = ajv.compile(structuredClone(PackFileCheckedRuleSchema));
const validCoverageRule = ajv.compile(structuredClone(PackFileCoverageRuleSchema));

/** How a rule is covered, in the words pnpm pack:build prints. */
export const coverageWords = {
  automated: 'Checked automatically',
  manual: 'Checked by a person',
  unsupported: 'Not supported yet',
} as const;

// How a waiver obligation no check serves is carried: a person checks it, or nothing covers it yet.
const uncheckedCoverage: Record<EvidenceMode, 'manual' | 'unsupported'> = {
  computed: 'unsupported',
  record_complete: 'unsupported',
  attested: 'manual',
  field_check: 'manual',
  unsupported: 'unsupported',
};

type Fields = Record<string, unknown>;

// What a description calls its source, and the source kind every rule quoting it takes.
const sourceKinds: Record<string, PackFileSource['kind']> = {
  waiver: 'waiver_or_exemption',
  procedure: 'operator_procedure',
};

/** What a description writes for which flights a waiver's conditions cover, as a person reads it. */
export const conditionsCoverWords: Record<RulePackWaiver['conditionsCover'], string> = {
  flights_citing_certificate: 'flights whose plan cites the certificate',
  every_flight: 'every flight',
};

const calendarDate = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Where a quotation was found: UTF-8 byte offsets into the source and the line it starts on. */
export interface FoundQuotation {
  start: number;
  end: number;
  line: number;
}

/** What the builder reports for each described rule or provision. */
export interface BuiltRuleReport {
  label: string;
  title: string;
  quoted: string;
  line: number;
  rule: PackFileRule;
  /** The document purpose the provision's obligation looks for, quoting the provision. */
  purpose?: PackFilePurpose;
  /** Each obligation parameter the description wrote with its unit: as written, and what it is kept as. */
  written?: Record<string, { text: string; kept: number; unit: string }>;
}

export interface BuiltPack {
  file: PackFile;
  reports: BuiltRuleReport[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean);
const wordsPattern = (list: readonly string[]) => new RegExp(list.map(escapeRegExp).join('\\s+'), 'gu');
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const shortened = (text: string, limit = 80) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

function allMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push(match);
    pattern.lastIndex = match.index + 1;
  }
  return found;
}

/** Explains where an absent quotation stops matching the source, from its longest opening that does match. */
function absentExplanation(text: string, quoted: readonly string[]): string {
  for (let count = quoted.length - 1; count >= 1; count--) {
    const match = allMatches(text, wordsPattern(quoted.slice(0, count)))[0];
    if (!match) continue;
    const after = text.slice(match.index + match[0].length).trimStart();
    return ` Its first ${count} words match at line ${lineAt(text, match.index)}; after them the source reads "${shortened(after, 60)}" where the quotation reads "${shortened(quoted.slice(count).join(' '), 60)}".`;
  }
  return ' Not even its first word appears in the source.';
}

/**
 * Finds a quotation in the source text by its exact words, in order. Any run of spaces and line breaks in the
 * quotation matches any run in the source, so a quotation may be wrapped differently; every other character must
 * match exactly. The span is the source's own bytes. Throws when the quotation is absent, or appears more than once
 * and no occurrence (counting from 1) says which.
 */
export function findQuotation(text: string, quotation: string, occurrence?: number): FoundQuotation {
  const quoted = words(quotation);
  if (quoted.length === 0) throw new PackFileError('The quotation is empty.');
  const matches = allMatches(text, wordsPattern(quoted));
  if (matches.length === 0)
    throw new PackFileError(
      `The quotation "${shortened(quotation)}" is not in the source.${absentExplanation(text, quoted)} Copy the words exactly as the source has them, including punctuation.`,
    );
  if (occurrence === undefined && matches.length > 1)
    throw new PackFileError(
      `The quotation "${shortened(quotation)}" appears ${matches.length} times in the source, at lines ${matches.map((match) => lineAt(text, match.index)).join(', ')}. Quote more of the provision, or add occurrence: N (1 for the first) to say which.`,
    );
  const match = matches[(occurrence ?? 1) - 1];
  if (!match)
    throw new PackFileError(
      `The quotation "${shortened(quotation)}" appears ${matches.length} time${matches.length === 1 ? '' : 's'}; there is no occurrence ${occurrence}.`,
    );
  const start = Buffer.byteLength(text.slice(0, match.index), 'utf8');
  return { start, end: start + Buffer.byteLength(match[0], 'utf8'), line: lineAt(text, match.index) };
}

function fieldProblem(fields: Fields, name: string, type: 'string' | 'number', where: string): string | undefined {
  const value = fields[name];
  if (type === 'string' && (typeof value !== 'string' || value.trim() === ''))
    return `${where} needs ${name}: some text`;
  if (type === 'number' && (!Number.isSafeInteger(value) || (value as number) < 1))
    return `${where} needs ${name}: a whole number of at least 1`;
  return undefined;
}

function required(fields: Fields, checks: [string, 'string' | 'number'][], where: string): void {
  for (const [name, type] of checks) {
    const problem = fieldProblem(fields, name, type, where);
    if (problem) throw new PackFileError(problem);
  }
}

function asFields(value: unknown, where: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PackFileError(`${where} must be a set of named values`);
  return value as Fields;
}

function asList(value: unknown, where: string): Fields[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PackFileError(`${where} must be a list`);
  return value.map((item, index) => asFields(item, `${where} item ${index + 1}`));
}

function occurrenceOf(fields: Fields, where: string): number | undefined {
  if (fields.occurrence === undefined) return undefined;
  if (!Number.isSafeInteger(fields.occurrence) || (fields.occurrence as number) < 1)
    throw new PackFileError(`${where}: occurrence must be a whole number of at least 1`);
  return fields.occurrence as number;
}

const leadingFields = ['id', 'version', 'title', 'quote', 'target', 'reads', 'check', 'adoptionParameters'];

/** The rule with its fields in reading order, so a pack file reads top-down. */
function ordered(rule: Fields): Fields {
  const leading = leadingFields.filter((name) => Object.hasOwn(rule, name));
  const rest = Object.keys(rule).filter((name) => !leadingFields.includes(name));
  return Object.fromEntries([...leading, ...rest].map((name) => [name, rule[name]]));
}

/** Checks a built rule against the pack file schema and says which rule and field is wrong. */
function validated(built: Fields, where: string): PackFileRule {
  const rule = ordered(built);
  const valid = 'coverage' in rule ? validCoverageRule : validCheckedRule;
  if (valid(rule)) return rule as PackFileRule;
  const error = valid.errors![0]!;
  const extra = error.params && 'additionalProperty' in error.params ? ` (${error.params.additionalProperty})` : '';
  throw new PackFileError(`${where}: ${error.instancePath || 'the rule'} ${error.message ?? 'is not valid'}${extra}`);
}

interface BuildContext {
  packId: string;
  /** The sections the description lists; each provision or rule then names one. */
  sections: RulePackSection[];
  reference: string;
  text: string;
  /** What a waiver description states; absent for a procedure. */
  waiver?: RulePackWaiver;
}

const normalized = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : undefined;

/** A date as YAML gives it: the text as written, or a date YAML read from an unquoted value. */
function dateOf(value: unknown, where: string): string {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof text !== 'string' || !calendarDate.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))
    throw new PackFileError(`${where} needs a date written as year-month-day, such as 2026-06-01`);
  return text;
}

/**
 * The waiver a description states: its certificate number as flight plans cite it, the dates it states it is
 * effective, and which flights its conditions cover. Required of a waiver; it has no default.
 */
function waiverOf(value: unknown): RulePackWaiver {
  const choices = Object.values(conditionsCoverWords)
    .map((words) => `"${words}"`)
    .join(' or ');
  if (value === undefined)
    throw new PackFileError(
      `A waiver description needs a waiver section: certificateNumber, effective (from and through) and conditionsCover, which is ${choices}. The template explains each.`,
    );
  const waiver = asFields(value, 'waiver');
  const unknown = Object.keys(waiver).find(
    (name) => !['certificateNumber', 'effective', 'conditionsCover'].includes(name),
  );
  if (unknown)
    throw new PackFileError(`waiver has ${unknown}, which is not certificateNumber, effective or conditionsCover`);
  required(waiver, [['certificateNumber', 'string']], 'waiver');
  const effective = asFields(waiver.effective, 'waiver effective');
  const from = dateOf(effective.from, 'waiver effective from');
  const through = dateOf(effective.through, 'waiver effective through');
  if (through < from) throw new PackFileError(`waiver effective through (${through}) is before from (${from})`);
  const cover = Object.entries(conditionsCoverWords).find(
    ([, words]) => words === normalized(waiver.conditionsCover),
  )?.[0] as RulePackWaiver['conditionsCover'] | undefined;
  if (!cover) throw new PackFileError(`waiver needs conditionsCover: ${choices}`);
  return {
    certificateNumber: (waiver.certificateNumber as string).trim(),
    conditionsCover: cover,
    effective: { from, through },
  };
}

/** A rule limited to the flights whose plan cites the waiver's certificate, when the description says so. */
function coveredBy<Rule extends Fields>(rule: Rule, certificateNumber: string, where: string): Rule {
  try {
    return limitedToCitingFlights(rule as never, certificateNumber) as Rule;
  } catch (error) {
    throw new PackFileError(`${where}: ${(error as Error).message}`);
  }
}

function quoteOf(context: BuildContext, fields: Fields, where: string, reference: string) {
  try {
    const found = findQuotation(context.text, fields.quote as string, occurrenceOf(fields, where));
    return { found, quote: { source: DESCRIBED_SOURCE_ID, start: found.start, end: found.end, reference } };
  } catch (error) {
    throw new PackFileError(`${where}: ${(error as Error).message}`);
  }
}

const provisionKeys = [
  'number',
  'section',
  'title',
  'quote',
  'occurrence',
  'obligation',
  'parameters',
  'ruleVersion',
  'coverage',
  'waitingFor',
];

/** The waiver library's sentence for an obligation no check serves, without its leading "A person:". */
function libraryStatement(waitingFor: string | undefined): string | undefined {
  const sentence = waitingFor?.replace(/^A person:\s*/u, '');
  return sentence && `${sentence[0]!.toUpperCase()}${sentence.slice(1)}`;
}

/** A provision no check runs: carried with its words and what a person confirms, or why nothing covers it yet. */
function coverageRule(fields: Fields, where: string, coverage: unknown, waitingFor: unknown, title: string) {
  if (coverage !== 'manual' && coverage !== 'unsupported')
    throw new PackFileError(`${where} needs coverage: manual (a person checks it) or unsupported`);
  if (typeof waitingFor !== 'string' || waitingFor.trim() === '')
    throw new PackFileError(
      `${where} needs waitingFor: ${coverage === 'manual' ? 'what the person confirms' : 'why nothing checks it yet'}`,
    );
  const unknown = Object.keys(fields).find((name) => !provisionKeys.includes(name));
  if (unknown) throw new PackFileError(`${where} has ${unknown}, which a provision no check runs does not take`);
  return { title, coverage, waitingFor };
}

/**
 * A waiver provision. The obligation type it carries becomes the rule the waiver library builds for it; a provision
 * no check serves (or one that names no obligation and says how it is covered) is carried as a rule a person checks,
 * or one not supported yet. Every provision becomes a rule.
 */
function provisionReport(context: BuildContext, fields: Fields, index: number): BuiltRuleReport {
  const number = String(fields.number ?? '').toLowerCase();
  const where = `Provision ${fields.number ?? index + 1}${typeof fields.title === 'string' ? ` (${fields.title})` : ''}`;
  if (!idPattern.test(number)) throw new PackFileError(`${where} needs number: letters and digits, such as 3 or 4a`);
  required(
    fields,
    [
      ['title', 'string'],
      ['quote', 'string'],
    ],
    where,
  );
  if (fields.ruleVersion !== undefined) required(fields, [['ruleVersion', 'number']], where);
  const reference = `${context.reference}, provision ${fields.number as string}: ${fields.title as string}`;
  const { found, quote } = quoteOf(context, fields, where, reference);
  const head = {
    id: `${context.packId}.provision-${number}`,
    version: (fields.ruleVersion as number | undefined) ?? 1,
    quote,
    ...sectionOf(context, fields, where),
    paragraph: `Provision ${fields.number as string}`,
  };
  const quoted = Buffer.from(context.text, 'utf8').subarray(found.start, found.end).toString('utf8');
  let writtenParameters: BuiltRuleReport['written'];
  const report = (rule: Fields) => ({
    label: where,
    title: fields.title as string,
    quoted,
    line: found.line,
    rule: validated(rule, where),
    ...(writtenParameters && Object.keys(writtenParameters).length ? { written: writtenParameters } : {}),
  });
  if (fields.obligation === undefined) {
    if (fields.coverage === undefined)
      throw new PackFileError(
        `${where} needs obligation: one of the types the template lists, or coverage: manual and waitingFor: what a person confirms`,
      );
    return report({
      ...head,
      ...coverageRule(fields, where, fields.coverage, fields.waitingFor, fields.title as string),
    });
  }
  required(fields, [['obligation', 'string']], where);
  const type = findObligationType(fields.obligation as string);
  if (!type)
    throw new PackFileError(
      `${where} names obligation ${fields.obligation as string}, which is not one this Ledger has. Run pnpm pack:new with --kind waiver to see the list in the template.`,
    );
  const { parameters, written } = obligationParametersWithUnits(
    type.parameters,
    asFields(fields.parameters ?? {}, `${where} parameters`) as ObligationParameters,
    where,
  );
  writtenParameters = written;
  const problems = obligationParameterProblems(type, parameters);
  if (problems.length) throw new PackFileError(`${where}: ${problems.join('; ')}`);
  if (fields.coverage !== undefined)
    throw new PackFileError(`${where}: coverage is given only for a provision that names no obligation`);
  if (!type.check)
    return report({
      ...head,
      ...coverageRule(
        fields,
        where,
        uncheckedCoverage[type.evidence],
        fields.waitingFor ?? libraryStatement(type.waitingFor),
        type.title,
      ),
    });
  if (fields.waitingFor !== undefined)
    throw new PackFileError(`${where}: waitingFor is given only for a provision no check runs`);
  // Fields this builder does not know, such as a declaration a later rule field adds, pass through to the rule and
  // are validated against the pack file schema.
  const passed = Object.fromEntries(Object.entries(fields).filter(([name]) => !provisionKeys.includes(name)));
  // The obligation type's own population and the records it requires, as the waiver library's packs carry them: a
  // subject the provision covers with nothing on file is reported, not passed over.
  const checked = type.check(parameters);
  const populated = type.covers ? withPopulation(checked, type.covers.population, type.covers.onFile) : checked;
  const { check, ...spec } =
    context.waiver?.conditionsCover === 'flights_citing_certificate'
      ? limitedToCitingFlights(populated, context.waiver.certificateNumber)
      : populated;
  const purpose = type.purpose?.(parameters);
  return withPurpose(
    purpose && { ...purpose, quote },
    report({
      ...spec,
      adoptionParameters: spec.adoptionParameters ?? [],
      applicability: spec.applicability ?? [],
      // A relieving provision is named for what it grants, so a relieved result can say which provision relieved it.
      ...(fields.relieves ? { title: `Provision ${fields.number as string}: ${fields.title as string}` } : {}),
      ...passed,
      ...head,
      check: { kind: check.kind.id, version: check.kind.version, params: check.params ?? {} },
    }),
  );
}

/** The section a provision or rule names, which the description's sections must list. */
function sectionOf(context: BuildContext, fields: Fields, where: string): { section?: string } {
  if (fields.section === undefined) {
    if (context.sections.length)
      throw new PackFileError(
        `${where} needs section: one of the ids the sections list gives (${context.sections.map((section) => section.id).join(', ')})`,
      );
    return {};
  }
  const section = String(fields.section);
  if (!context.sections.some((listed) => listed.id === section))
    throw new PackFileError(
      context.sections.length
        ? `${where} names section ${section}, which the sections list does not give (${context.sections.map((listed) => listed.id).join(', ')})`
        : `${where} names section ${section}, but the description lists no sections`,
    );
  return { section };
}

/** The sections a description lists, in reading order: an id and a title each. */
function sectionsOfDescription(value: unknown): RulePackSection[] {
  return asList(value, 'sections').map((fields, index) => {
    const where = `Section ${typeof fields.id === 'string' ? fields.id : index + 1}`;
    required(
      fields,
      [
        ['id', 'string'],
        ['title', 'string'],
      ],
      where,
    );
    const unknown = Object.keys(fields).find((name) => !['id', 'title'].includes(name));
    if (unknown) throw new PackFileError(`${where} has ${unknown}, which is not id or title`);
    if (!idPattern.test(fields.id as string))
      throw new PackFileError(
        `${where} needs id: lowercase words and digits joined by dots or hyphens, such as 4 or ops`,
      );
    return { id: fields.id as string, title: (fields.title as string).trim() };
  });
}

function withPurpose(purpose: PackFilePurpose | undefined, report: BuiltRuleReport): BuiltRuleReport {
  return purpose ? { ...report, purpose } : report;
}

/** A purpose the description declares itself: an id, a title and the words of the provision it serves. */
function purposeOf(context: BuildContext, fields: Fields, index: number): PackFilePurpose {
  const where = `Purpose ${typeof fields.id === 'string' ? fields.id : index + 1}`;
  required(
    fields,
    [
      ['id', 'string'],
      ['title', 'string'],
      ['quote', 'string'],
    ],
    where,
  );
  const unknown = Object.keys(fields).find(
    (name) => !['id', 'title', 'documentTypes', 'quote', 'occurrence'].includes(name),
  );
  if (unknown)
    throw new PackFileError(`${where} has ${unknown}, which is not id, title, documentTypes, quote or occurrence`);
  const reference = `${context.reference}: ${fields.title as string}`;
  return {
    id: fields.id as string,
    title: fields.title as string,
    ...(fields.documentTypes === undefined ? {} : { documentTypes: fields.documentTypes as string[] }),
    quote: quoteOf(context, fields, where, reference).quote,
  };
}

const recordKeys = ['id', 'title', 'quote', 'occurrence', 'keptBy', 'heldBy', 'retention'];

/** A record holder as a description names it: an operator record type, or safety:<kind> for a safety record. */
function holderOf(name: unknown, where: string): PackFileRequiredRecord['heldBy'][number] {
  if (typeof name !== 'string' || !name.trim())
    throw new PackFileError(`${where}: heldBy lists record type names, such as flight.record, or safety:<kind>`);
  const kind = /^safety:(.+)$/u.exec(name.trim())?.[1];
  if (kind === undefined) return { kind: 'operator_record', recordType: name.trim() };
  if (!(smsRecordKindValues as readonly string[]).includes(kind))
    throw new PackFileError(
      `${where}: safety:${kind} is not a safety record; use one of ${smsRecordKindValues.join(', ')}`,
    );
  return { kind: 'safety_record', recordKind: kind as (typeof smsRecordKindValues)[number] };
}

/** A record the source requires to be kept: what lists it, who keeps it, what holds it and how long it says. */
function requiredRecordOf(context: BuildContext, fields: Fields, index: number): PackFileRequiredRecord {
  const where = `Record ${typeof fields.id === 'string' ? fields.id : index + 1}`;
  required(
    fields,
    [
      ['id', 'string'],
      ['title', 'string'],
      ['quote', 'string'],
      ['keptBy', 'string'],
    ],
    where,
  );
  const unknown = Object.keys(fields).find((name) => !recordKeys.includes(name));
  if (unknown) throw new PackFileError(`${where} has ${unknown}, which is not ${recordKeys.join(', ')}`);
  if (!idPattern.test(fields.id as string))
    throw new PackFileError(`${where} needs id: lowercase words joined by dots or hyphens, such as flight-log`);
  if (!Array.isArray(fields.heldBy) || !fields.heldBy.length)
    throw new PackFileError(`${where} needs heldBy: the record types that hold it, such as [flight.record]`);
  const reference = `${context.reference}: ${fields.title as string}`;
  const retention = fields.retention === undefined ? undefined : asFields(fields.retention, `${where} retention`);
  if (retention) required(retention, [['quote', 'string']], `${where} retention`);
  return {
    id: `${context.packId}.${fields.id as string}`,
    title: fields.title as string,
    quote: quoteOf(context, fields, where, reference).quote,
    keptBy: fields.keptBy as string,
    heldBy: fields.heldBy.map((name) => holderOf(name, where)),
    ...(retention
      ? { retention: { quote: quoteOf(context, retention, `${where} retention`, `${reference}, how long`).quote } }
      : {}),
  };
}

const ruleKeys = ['quote', 'occurrence', 'reference', 'covers'];

/**
 * A rule's check with each limit written with its unit kept in the stored unit, and what was written beside it; and
 * the sentences for numbers written with a unit that nothing says the quantity of.
 */
function checkWithUnits(check: Fields, where: string): { check: Fields; unmeasured: string[] } {
  const { params, written: _written, ...rest } = check;
  const fixed = asFields(params ?? {}, `${where} check params`);
  if (typeof rest.kind !== 'string' || !Number.isSafeInteger(rest.version))
    return { check: { ...rest, params: fixed }, unmeasured: [] };
  const converted = parametersWithUnits({ kind: rest.kind, version: rest.version as number, params: fixed }, where);
  return {
    check: {
      ...rest,
      params: converted.params,
      ...(Object.keys(converted.written).length ? { written: converted.written } : {}),
    },
    unmeasured: converted.unmeasured,
  };
}

/** What a rule by check kind writes to limit it to the flights a waiver's conditions cover. */
const citingFlightsWords = conditionsCoverWords.flights_citing_certificate;

/** A rule written by check kind: its fields are a pack file rule's, with a short id and a quotation. */
function ruleReport(context: BuildContext, fields: Fields, index: number): BuiltRuleReport {
  const where = `Rule ${typeof fields.id === 'string' ? fields.id : index + 1}${typeof fields.title === 'string' ? ` (${fields.title})` : ''}`;
  if (fields.obligation !== undefined)
    throw new PackFileError(
      `${where} names obligation ${String(fields.obligation)}, but a rule under rules is written by check kind. An obligation goes in a provision under provisions, in a procedure exactly as in a waiver: number, title, quote, obligation and its parameters.`,
    );
  required(
    fields,
    [
      ['id', 'string'],
      ['title', 'string'],
      ['quote', 'string'],
    ],
    where,
  );
  if (!idPattern.test(fields.id as string))
    throw new PackFileError(`${where} needs id: lowercase words joined by dots or hyphens, such as wind-limit`);
  const reference =
    typeof fields.reference === 'string' ? fields.reference : `${context.reference}: ${fields.title as string}`;
  const limited = fields.covers !== undefined;
  if (limited && normalized(fields.covers) !== citingFlightsWords)
    throw new PackFileError(
      `${where}: covers takes one value, "${citingFlightsWords}"; leave it out to cover every flight`,
    );
  if (limited && !context.waiver)
    throw new PackFileError(`${where}: covers limits a rule to the flights a waiver covers; only a waiver has them`);
  if (
    limited &&
    (fields.coverage !== undefined || asFields(fields.target ?? {}, `${where} target`).subjectKind !== 'flight')
  )
    throw new PackFileError(
      `${where}: covers limits a rule about each flight; this rule is not one a check runs for flights`,
    );
  const { found, quote } = quoteOf(context, fields, where, reference);
  sectionOf(context, fields, where);
  const passed = Object.fromEntries(
    Object.entries(fields)
      .filter(([name]) => !ruleKeys.includes(name))
      .map(([name, value]) => [name, name === 'section' ? String(value) : value]),
  );
  const id = `${context.packId}.${fields.id as string}`;
  const withUnits =
    fields.coverage === undefined ? checkWithUnits(asFields(fields.check, `${where} check`), where) : undefined;
  // A rule with coverage and no check is one a person checks, or one nothing covers yet.
  const rule =
    fields.coverage !== undefined
      ? { version: 1, ...passed, id, quote }
      : {
          version: 1,
          adoptionParameters: [],
          applicability: [],
          ...passed,
          id,
          quote,
          check: withUnits!.check,
        };
  const covered = limited ? coveredBy(rule, context.waiver!.certificateNumber, where) : rule;
  const quoted = Buffer.from(context.text, 'utf8').subarray(found.start, found.end).toString('utf8');
  const built = validated(covered, where);
  if (isPackFileCheckedRule(built)) {
    const problems = fieldPathProblems(built);
    if (problems.length) throw new PackFileError(`${where}: ${problems.join(' ')}`);
  }
  if (withUnits?.unmeasured.length) throw new PackFileError(withUnits.unmeasured.join(' '));
  return { label: where, title: fields.title as string, quoted, line: found.line, rule: built };
}

/**
 * Builds a pack file from a pack description (the parsed pack.yaml) and the source text it quotes. Every quotation is
 * located by its words, every rule is built and validated exactly as startup will, and the digest is computed. Throws
 * a PackFileError naming the rule or provision and what was expected.
 */
export function buildPackFile(description: unknown, sourceText: string): BuiltPack {
  const top = asFields(description, 'The description');
  const pack = asFields(top.pack, 'pack');
  required(
    pack,
    [
      ['id', 'string'],
      ['version', 'number'],
      ['title', 'string'],
    ],
    'pack',
  );
  if (!idPattern.test(pack.id as string))
    throw new PackFileError('pack needs id: lowercase words joined by dots or hyphens, such as northwind.waiver-0042');
  const source = asFields(top.source, 'source');
  required(source, [['reference', 'string']], 'source');
  const sourceKind = sourceKinds[source.kind as string];
  if (!sourceKind)
    throw new PackFileError(
      'source needs kind: waiver (a waiver or exemption you hold) or procedure (your own procedure). Only a waiver’s provision may relieve a rule of another pack.',
    );
  const unknown = Object.keys(top).find(
    (name) => !['pack', 'source', 'waiver', 'sections', 'provisions', 'rules', 'purposes', 'records'].includes(name),
  );
  if (unknown)
    throw new PackFileError(
      `The description has ${unknown}, which is not pack, source, waiver, sections, provisions, rules, purposes or records`,
    );
  if (sourceKind === 'operator_procedure' && top.waiver !== undefined)
    throw new PackFileError('A procedure has no waiver section; only a description of kind waiver states one');
  const context: BuildContext = {
    packId: pack.id as string,
    sections: sectionsOfDescription(top.sections),
    reference: source.reference as string,
    text: sourceText,
    ...(sourceKind === 'waiver_or_exemption' ? { waiver: waiverOf(top.waiver) } : {}),
  };
  const reports = [
    ...asList(top.provisions, 'provisions').map((fields, index) => provisionReport(context, fields, index)),
    ...asList(top.rules, 'rules').map((fields, index) => ruleReport(context, fields, index)),
  ];
  const rules = reports.map((report) => report.rule);
  if (rules.length === 0) throw new PackFileError('The description makes no rules: list provisions or rules');
  // Purposes the description declares come first; a provision's obligation adds the one it looks for once.
  const purposes: PackFilePurpose[] = [];
  for (const purpose of [
    ...asList(top.purposes, 'purposes').map((fields, index) => purposeOf(context, fields, index)),
    ...reports.flatMap((report) => (report.purpose ? [report.purpose] : [])),
  ])
    if (!purposes.some((declared) => declared.id === purpose.id)) purposes.push(purpose);
  const requiredRecords = asList(top.records, 'records').map((fields, index) =>
    requiredRecordOf(context, fields, index),
  );
  const bytes = Buffer.from(sourceText, 'utf8');
  const fileSource: PackFileSource = {
    id: DESCRIBED_SOURCE_ID,
    kind: sourceKind,
    reference: context.reference,
    text: sourceText,
    encoding: 'utf-8',
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
  const content: Omit<PackFile, 'digest'> = {
    format: PACK_FILE_FORMAT,
    packId: context.packId,
    version: pack.version as number,
    title: pack.title as string,
    sources: [fileSource],
    rules,
    ...(context.sections.length ? { sections: context.sections } : {}),
    ...(purposes.length ? { purposes } : {}),
    ...(requiredRecords.length ? { requiredRecords } : {}),
    ...(context.waiver ? { waiver: context.waiver } : {}),
  };
  const file: PackFile = { ...content, digest: packFileVersion(content).digest };
  // The written file is verified as startup verifies it.
  verifiedPackFile(file);
  return { file, reports };
}

/** Builds the pack file a folder describes: its pack.yaml and the source file that names. */
export function buildPackFolder(folder: string): BuiltPack {
  const descriptionPath = join(folder, 'pack.yaml');
  if (!existsSync(descriptionPath)) throw new PackFileError(`${folder} has no pack.yaml`);
  let description: unknown;
  try {
    description = parse(readFileSync(descriptionPath, 'utf8'), { prettyErrors: true });
  } catch (error) {
    throw new PackFileError(`pack.yaml is not valid YAML: ${(error as Error).message}`);
  }
  const sourceName = (description as { source?: { file?: unknown } } | null)?.source?.file ?? 'source.txt';
  if (typeof sourceName !== 'string' || sourceName.includes('/') || sourceName.includes('\\'))
    throw new PackFileError('source needs file: the name of a file in this folder');
  const sourcePath = join(folder, sourceName);
  if (!existsSync(sourcePath)) throw new PackFileError(`${folder} has no ${sourceName}`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(sourcePath));
  } catch {
    throw new PackFileError(`${sourceName} is not UTF-8 text; save it as UTF-8`);
  }
  return buildPackFile(description, text);
}
