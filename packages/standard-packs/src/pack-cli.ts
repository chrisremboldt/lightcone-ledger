import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isPackFileCheckedRule,
  ruleFieldPaths,
  type PackFile,
  type PackFileCheckedRule,
  type PackFileQuote,
  type PackFileRule,
} from '@ledger/contracts';
import { findCheckKind, getRulePackVersion, listRulePackVersions, sectionsOf } from '@ledger/domain';
import { AUTHORITY_READ } from '@ledger/pack-example-waiver';
import { checkKindsPrintout } from './check-kind-printout.js';
import { earlierPackFile, ruleVersionLines, withRuleVersions } from './pack-rule-versions.js';
import { buildPackFolder, conditionsCoverWords, coverageWords, type BuiltRuleReport } from './pack-builder.js';
import { PackFileError } from './pack-files.js';
import { fieldsReadWords, parametersWords } from './pack-printout.js';
import { readsLine, relatedWords } from './pack-reads.js';
import { packFileCollision, readPackFile } from './pack-folder.js';
import { packTemplate, packTemplateKinds, type PackTemplateKind } from './pack-templates.js';
import { registerStandardPacks } from './index.js';

const usage = `Usage:
  pnpm pack:new <folder> --kind waiver|procedure   start a pack folder from a template
  pnpm pack:build <folder> [--out <folder>]        build <id>-v<version>.pack.json from the folder
  pnpm pack:check <file>                           verify a pack file as startup does, and list its rules
  pnpm pack:list [<pack id>]                       list the packs built into Ledger, or one pack's rules by section
  pnpm pack:kinds [<kind>[@<version>]]             what each check kind asks, its inputs and its parameters`;

/** pnpm runs scripts from the repository root; a path is read from where the command was typed. */
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new PackFileError(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function onlyArgument(args: string[], what: string): string {
  const unknown = args.find((arg) => arg.startsWith('--'));
  if (unknown) throw new PackFileError(`${unknown} is not an option of this command`);
  if (args.length !== 1) throw new PackFileError(`Give exactly one ${what}`);
  return args[0]!;
}

const indented = (text: string, prefix = '    ') =>
  text
    .trimEnd()
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');

/** Who a rule covers, in the words the coverage view uses; a rule without a population waits for a record. */
function coversLine(rule: PackFileCheckedRule): string {
  const kind = rule.target.subjectKind;
  const citing = rule.applicability.find(
    (condition) =>
      condition.input === AUTHORITY_READ && condition.field === 'values.record.operatingAuthorityReference',
  );
  const related = (rule.related ?? []).map((relation) => `, and ${relatedWords(rule, relation.name)}`).join('');
  if (citing)
    return `covers each flight whose latest plan cites ${citing.oneOf.join(' or ')}${related}; for any other flight it does not apply, and a flight with no plan on file is reported as "No flight plan on file"`;
  if (kind === 'organization') return 'covers the organization, once';
  if (!rule.population)
    return `covers each ${kind}${related} once a record it reads is on file; it declares no population`;
  if (rule.population.of === 'on_record') return `covers every ${kind} on record${related}`;
  if (rule.population.of === 'in_adoption_dates')
    return `covers each ${kind} with records in the adoption's dates${related}`;
  return `covers each ${kind} a designating record names${related}`;
}

/** What a waiver pack states about its waiver, printed once above its rules. */
function waiverLines(file: PackFile): string[] {
  if (!file.waiver) return [];
  const { certificateNumber, conditionsCover, effective } = file.waiver;
  return [
    `  Certificate ${certificateNumber}, stated effective ${effective.from} through ${effective.through}`,
    `  Its conditions cover ${conditionsCoverWords[conditionsCover]}${conditionsCover === 'flights_citing_certificate' ? ` (the latest plan cites ${certificateNumber})` : ''}`,
  ];
}

/** The records the pack says are kept: what holds each and how long its words say. */
function recordLines(file: PackFile): string[] {
  const sources = new Map(file.sources.map((source) => [source.id, Buffer.from(source.text, 'utf8')]));
  const words = (quote: PackFileQuote) =>
    sources.get(quote.source)!.subarray(quote.start, quote.end).toString('utf8').replace(/\s+/gu, ' ').trim();
  return (file.requiredRecords ?? []).flatMap((record) => [
    `Required record ${record.id}: ${record.title}`,
    `  Kept by ${record.keptBy}; held in ${record.heldBy.map((holder) => (holder.kind === 'operator_record' ? holder.recordType : `safety records (${holder.recordKind})`)).join(', ')}`,
    `  How long: ${record.retention ? `“${words(record.retention.quote)}”` : 'the source states no period'}`,
    '',
  ]);
}

/** The stored unit a parameter is kept in: the one the rule's check states, else the hours a duration's name says. */
const unitOf = (rule: PackFileCheckedRule, name: string) =>
  typeof rule.check.params.unit === 'string' ? ` ${rule.check.params.unit}` : /Hours$/u.test(name) ? ' h' : '';

function checkLines(rule: PackFileCheckedRule): string[] {
  const kind = findCheckKind(rule.check.kind, rule.check.version);
  const lines = [
    `  ${coverageWords.automated} by ${rule.check.kind} version ${rule.check.version}${kind ? ` (${kind.title})` : ''} about ${rule.target.subjectKind === 'organization' ? 'the organization' : `each ${rule.target.subjectKind}`}`,
    `    ${coversLine(rule)}`,
    `    reads ${readsLine(rule)}`,
    `    fields read: ${fieldsReadWords(rule)}`,
    `    fixed parameters: ${parametersWords(rule)}`,
    ...Object.entries(rule.check.written ?? {}).map(
      ([name, text]) =>
        `    ${name} written as ${text}, kept as ${String(rule.check.params[name])}${unitOf(rule, name)}`,
    ),
  ];
  for (const relief of rule.relieves ?? [])
    lines.push(
      `    relieves ${relief.ruleIds.join(', ')} of ${relief.packId} while this pack is adopted in active mode`,
    );
  if (rule.adoptionParameters.length)
    lines.push(
      `    set on adoption: ${rule.adoptionParameters.map((parameter) => `${parameter.name} (${parameter.title})`).join(', ')}`,
    );
  return lines;
}

function describeRule(rule: PackFileRule, quoted: string, where: string): string {
  return [
    `${rule.id} version ${rule.version}: ${rule.title}`,
    `  Quotes ${where}:`,
    indented(quoted),
    ...(isPackFileCheckedRule(rule) ? checkLines(rule) : [`  ${coverageWords[rule.coverage]}: ${rule.waitingFor}`]),
  ].join('\n');
}

function describeReport(report: BuiltRuleReport): string {
  return [
    describeRule(report.rule, report.quoted, `source.txt line ${report.line}`),
    ...Object.entries(report.written ?? {}).map(
      ([name, written]) => `    ${name} written as ${written.text}, kept as ${written.kept} ${written.unit}`,
    ),
  ].join('\n');
}

/** How many rules the file holds, and how many of them each kind of coverage covers. */
function coverageCounts(file: PackFile): string {
  const count = (coverage: keyof typeof coverageWords) =>
    file.rules.filter((rule) => (isPackFileCheckedRule(rule) ? 'automated' : rule.coverage) === coverage).length;
  const parts = (['automated', 'manual', 'unsupported'] as const)
    .map((coverage) => [coverage, count(coverage)] as const)
    .filter(([, total]) => total > 0)
    .map(([coverage, total]) => `${total} ${coverageWords[coverage].toLowerCase()}`);
  return `${file.rules.length} rule${file.rules.length === 1 ? '' : 's'} (${parts.join(', ')})`;
}

function scaffold(args: string[]): void {
  const kind = option(args, '--kind') as PackTemplateKind | undefined;
  if (!kind || !packTemplateKinds.includes(kind))
    throw new PackFileError(`Say which template with --kind ${packTemplateKinds.join(' or ')}`);
  const folder = fromCaller(onlyArgument(args, 'folder'));
  if (existsSync(folder) && readdirSync(folder).length)
    throw new PackFileError(`${folder} already holds files; give a new or empty folder`);
  mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(packTemplate(kind))) writeFileSync(join(folder, name), content);
  console.log(`Started a ${kind} pack in ${folder}:
  source.txt  replace its placeholder with the exact text of your ${kind}
  pack.yaml   describe the pack and its ${kind === 'waiver' ? 'provisions' : 'rules'}; its comments list what this Ledger has
Then run: pnpm pack:build ${folder}`);
}

function build(args: string[]): void {
  const out = option(args, '--out');
  const folder = fromCaller(onlyArgument(args, 'folder'));
  registerStandardPacks();
  const targetFolder = out ? fromCaller(out) : folder;
  const described = buildPackFolder(folder);
  const earlier = earlierPackFile([targetFolder, folder], described.file.packId, described.file.version);
  const numbered = earlier ? withRuleVersions(described, earlier) : undefined;
  const built = numbered?.built ?? described;
  const collision = packFileCollision(built.file.packId, built.file.version, built.file.digest);
  if (collision) throw new PackFileError(collision);
  mkdirSync(targetFolder, { recursive: true });
  const target = join(targetFolder, `${built.file.packId}-v${built.file.version}.pack.json`);
  writeFileSync(target, `${JSON.stringify(built.file, null, 2)}\n`);
  console.log(
    [
      `Built ${built.file.packId} version ${built.file.version}: ${built.file.title}`,
      `  ${coverageCounts(built.file)}, digest ${built.file.digest}`,
      ...waiverLines(built.file),
      ...(numbered ? ruleVersionLines(numbered.changes) : []),
      '',
      ...built.reports.map((report) => `${describeReport(report)}\n`),
      ...recordLines(built.file),
      `Wrote ${target}`,
      'Copy it into the folder LEDGER_PACKS_DIR names and restart the API and the workers.',
    ].join('\n'),
  );
}

function check(args: string[]): void {
  const path = fromCaller(onlyArgument(args, 'pack file'));
  registerStandardPacks();
  const loaded = readPackFile(path);
  const collision = packFileCollision(loaded.version.packId, loaded.version.version, loaded.version.digest);
  if (collision) throw new PackFileError(`Pack file ${path} was refused. ${collision}`);
  const file: PackFile = loaded.file;
  const sources = new Map(file.sources.map((source) => [source.id, Buffer.from(source.text, 'utf8')]));
  console.log(
    [
      `${path} loads as ${file.packId} version ${file.version}: ${file.title}`,
      `  ${coverageCounts(file)}, digest ${file.digest}`,
      ...waiverLines(file),
      '',
      ...file.rules.map((rule) => {
        const bytes = sources.get(rule.quote.source)!;
        const quoted = bytes.subarray(rule.quote.start, rule.quote.end).toString('utf8');
        return `${describeRule(rule, quoted, rule.quote.reference)}\n`;
      }),
      ...recordLines(file),
    ].join('\n'),
  );
}

/** The built-in packs, or the rules of one: the ids a waiver's provision names when it relieves a rule. */
function list(args: string[]): void {
  registerStandardPacks();
  const packs = listRulePackVersions();
  if (args.length === 0) {
    const latest = new Map(packs.map((pack) => [pack.packId, pack]));
    console.log(
      [
        'Packs built into this Ledger (latest version of each):',
        ...[...latest.values()].map((pack) => `  ${pack.packId} version ${pack.version}: ${pack.title}`),
        '',
        'List a pack’s rules with: pnpm pack:list <pack id>',
      ].join('\n'),
    );
    return;
  }
  const packId = onlyArgument(args, 'pack id');
  const newest = packs.filter((pack) => pack.packId === packId).at(-1);
  const version = newest && getRulePackVersion(packId, newest.version);
  if (!version) throw new PackFileError(`No built-in pack ${packId}. Run pnpm pack:list to see them.`);
  console.log(
    [
      `${version.packId} version ${version.version}: ${version.title}`,
      ...sectionsOf(version).flatMap(({ section, leaves }) => [
        '',
        `${section.title} (${leaves.length} ${leaves.length === 1 ? 'rule' : 'rules'})`,
        ...leaves.map(
          (leaf) =>
            `  ${leaf.id}${leaf.paragraph ? `  ${leaf.paragraph}` : ''}\n    ${leaf.title} (${coverageWords[leaf.coverage].toLowerCase()})`,
        ),
      ]),
    ].join('\n'),
  );
}

/** Every check kind, or the one named, as its registered definition states it. */
function kinds(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith('--'));
  if (unknown) throw new PackFileError(`${unknown} is not an option of this command`);
  if (args.length > 1) throw new PackFileError('Give one check kind, or none for all of them');
  registerStandardPacks();
  console.log(checkKindsPrintout(args[0]).join('\n'));
}

const commands: Record<string, (args: string[]) => void> = { new: scaffold, build, check, list, kinds };

const [command, ...args] = process.argv.slice(2);
try {
  const run = command ? commands[command] : undefined;
  if (args.includes('--help') || args.includes('-h')) console.log(usage);
  else if (!run) throw new PackFileError(usage);
  else run(args);
} catch (error) {
  console.error(error instanceof PackFileError ? error.message : (error as Error).stack);
  process.exitCode = 1;
}
