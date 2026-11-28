import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type { Readable, Writable } from 'node:stream';
import { adoptPack } from './adoption.js';
import {
  adoptedPacks,
  checkRecords,
  coverage,
  importRecords,
  listPacks,
  listRecords,
  listRecordTypes,
  me,
  recordColumns,
  recordTemplate,
  RefusalError,
  showPack,
  subjectFile,
  UsageError,
  type Context,
  type Output,
} from './commands.js';
import { ConfigurationError, readConnection } from './config.js';
import { findingGroups, openFindings, showFinding, treatFindingSet } from './findings.js';
import { refusalWords } from './format.js';
import { serveMcp } from './mcp.js';
import { readFlightLog } from './read-log.js';
import { startRecordMapping } from './record-mapping.js';
import { draftPlan, produceRecords } from './records-plan.js';
import { addPerson, listPeople, listPresets } from './people.js';
import { issuePersonToken, setPerson } from './people-authority.js';
import { runSafety } from './safety.js';
import { coverageResultChoices, parseCoverageResult } from './words.js';

export const usage = `Usage: pnpm ledger <noun> <verb> [options]

  me                                     who the credential is, its organization and what it may do
  records types                          the record types and what each is about
  records columns <type>                 each column of a record type, what it holds and what it means
  records template <type> [--out <file>] an empty CSV file with the header row
  records check <type> <file> [--mapping <file> | --original <file>]
                                         what importing a CSV or JSON file would record; makes no record (the file is
                                         kept as an upload). With --mapping, the file is an export in its own columns,
                                         read through a column mapping: what each column became, what was not read,
                                         and each refused row. With --original, the file was read from another file,
                                         such as an aircraft's log, and each record cites that file as its original
  records import <type> <file> [--mapping <file> | --original <file>]
                                         import a CSV or JSON file, or an export through its column mapping; Ledger
                                         keeps the export as received and the mapping with the records, or the
                                         original the file was read from
  records read-log <log> [--format ulog|dataflash|tlog|gutma] [--out <file.csv>]
                                         read an aircraft's own log (PX4 .ulg, ArduPilot .bin, MAVLink .tlog) or a
                                         GUTMA flight log a fleet product exported (JSON) into a flight.record CSV:
                                         one row per whole flight, only what the log holds, and what it could not
                                         read; works offline and sends nothing
  records mapping <type> <export.csv> [--out <file>]
                                         start a column mapping from an export: every column listed, none assigned,
                                         and the record type's fields as comments; nothing is guessed
  records list <type> [--subject <id>] [--limit <n>]
  records subject <kind>:<id>            what is on file about one subject: its records by type, the rules that have
                                         read it with their latest result, and its open findings
  records produce --reason "<why>" --requested-by "<who asked>" --out <file.zip>
              [--subject <kind>:<id>]... [--type <type>]... [--from <date>] [--until <date>] [--originals]
              [--with-flights]           produce records on request as one .zip you can verify offline; a person's
                                         flights are listed, and --with-flights includes their records
  packs list [--all]                     the latest version of each rule pack this Ledger offers; --all lists
                                         earlier versions too
  packs adopted                          the packs your organization has adopted, each version, mode and dates
  packs show <pack> [--version <n>]      a pack's rules, how each is checked, the fields each reads and what it
                                         asks on adoption
  packs adopt <pack> [--version <n>] [--mode active|shadow] [--from <date>] [--until <date>]
              [--set <rule>.<name>=<value>]... [--set-all <name>=<value>]... [--reason "<why>"]
                                         prints the adoption; sends it only with --reason, with a person's credential;
                                         --mode, --from and --until are required for a first adoption unless the pack
                                         states a waiver's dates. When an earlier version is adopted over those dates,
                                         the new version replaces it from --from, or from now; when the same version
                                         is, it is revised with the mode, dates and values given, the rest kept
  coverage [--pack <pack>] [--rule <rule>] [--result <result>]
                                         each rule, how it is checked, who it covers and its counts; with --rule
                                         or --result, the subjects behind a count and the sentence for each
  findings list [--pack <pack>] [--rule <rule>] [--all] [--proposed] [--subject-kind <kind>] [--from <date>]
              [--until <date>]           the open findings grouped by rule, the rules with the fewest first; --rule
                                         lists one rule's findings and --all every finding, oldest first, with owner
                                         and the sentence behind each; --proposed lists those of rules in shadow;
                                         --from and --until are the days the findings are about. The list ends with
                                         each adopted pack's results that say a record is not on file, which open no
                                         finding, and the command that lists them
  findings show <finding> [--subject <kind>:<id>]
                                         one finding: the evaluation that opened it and the latest, the records each
                                         read, what each found not on file, and the decisions about it; a finding no
                                         longer open is found by the subject it is about
  findings take --rule <rule> [--pack <pack>] [--subject-kind <kind>] [--from <date>] [--until <date>]
              [--reason "<why>"]         prints every open finding of the rule; takes them all as one decision
                                         only with --reason, with a person's credential
  findings close --rule <rule> --as <why> [same options as take]
                                         the same, closing them all: --as corrected-by-record, accepted,
                                         condition-ended or recorded-in-error; you must own each first
  plan draft [--out <file>] [--open]     a recordkeeping plan drafted from the records your adopted packs require;
                                         opened as a draft controlled document only with --open, by a person
  people list                            everyone in the organization and what each may do
  people presets                         the role presets and exactly what each grants
  people add --name "<full name>" [--preset <preset>] [--capability <capability>]...
              [--grant <source id>:<observation type>]... [--sign-in-subject <subject> [--sign-in-issuer <url>]]
              [--reason "<why>"]          prints the addition; sends it only with --reason, with a person's credential
  people set <person> [--preset <preset>] [--capability <capability>]... [--remove-capability <capability>]...
              [--grant <source id>:<observation type>]... [--remove-grant <source id>:<observation type>]...
              [--reason "<why>"]          prints what the person may do now and after; sends the change only with
                                         --reason, with a person's credential. <person> is their id or full name
  people token <person> [--reason "<why>"]
                                         on a local Ledger, prints the issue of a development token for the person;
                                         issues it, shown once, only with --reason, with a person's credential
  mcp                                    serve these reading commands, checks and imports as tools to an agent that
                                         speaks the Model Context Protocol, on standard input and output; a person's
                                         decision is prepared, never sent
  safety home                            what safety records are on file and what is not, what waits for a person,
                                         actions due and overdue
  safety control-types                   every control type and what a control of it needs
  safety template matrix|hazards|document|assurance|report [--out <file>]
                                         an example file in your own ids
  safety check <kind> <file>             what drafting the file would open; records nothing
  safety draft <kind> <file>             opens each record of the file as a draft, under your own ids; one on file
                                         already is not opened again. A report needs a person cleared to read reports
  safety assess <hazards.csv> [--hazard <id>]... [--reason "<why>"]
  safety accept <hazard> [--reason "<why>"]
  safety adopt matrix|document <id> [--reason "<why>"]
  safety review <document> [--reason "<why>"]
  safety issue <document> --recipient "<name>"|everyone... [--from <date>] [--reason "<why>"]
  safety sign <assurance record> [--reason "<why>"]
  safety close-action <assurance record> <action> [--reason "<what was done>"]
                                         a person's decisions: each prints what it would record and sends it only
                                         with --reason and a person's credential. A signature on a local Ledger is
                                         confirmed with the person's own development token; on a deployment the
                                         person signs in the browser

Options:
  --json   print the API's data as JSON instead of text
A command refuses an option it does not read.

Where the API is and the credential come from LEDGER_API_URL and LEDGER_TOKEN, or from a git-ignored
.ledger/credentials file holding those two lines. A credential is never given as an argument.
A date is a day in your organization's time zone (2026-06-01) or a time with its offset (2026-06-01T06:00:00Z).
In an import file a time is UTC (2026-11-10T16:05:00Z) or has its offset (2026-11-10T09:05-07:00); under a heading
ending in [local], such as "takeoffAt [local]", it may be 2026-11-10 09:05 in your organization's time zone. A number
column takes its unit in the heading, such as "maxHeightFlownAboveGround [ft]" (ft, mi, sm, nm, kn, kt, kts, mph).
Results: attention, no_record, pending, not_evaluated, other, relieved, supported, not_applicable.`;

export interface CliIo {
  env: NodeJS.ProcessEnv;
  /** Folders a relative path and .ledger/credentials are read from: where the command was typed, then the checkout. */
  folders: string[];
  out: (line: string) => void;
  err: (line: string) => void;
  /** Replaces fetch, as a test does to call the API in process. */
  fetcher?: typeof fetch;
  /** Replaces the wait before a command is sent again, as a test does to not wait. */
  pause?: (milliseconds: number) => Promise<void>;
  /** The streams `mcp` serves on; standard input and output unless a test gives others. */
  input?: Readable;
  output?: Writable;
}

export { refusalWords };

const options = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  out: { type: 'string' },
  mapping: { type: 'string' },
  original: { type: 'string' },
  format: { type: 'string' },
  subject: { type: 'string', multiple: true },
  type: { type: 'string', multiple: true },
  to: { type: 'string' },
  all: { type: 'boolean' },
  originals: { type: 'boolean' },
  'with-flights': { type: 'boolean' },
  'requested-by': { type: 'string' },
  open: { type: 'boolean' },
  limit: { type: 'string' },
  version: { type: 'string' },
  mode: { type: 'string' },
  from: { type: 'string' },
  until: { type: 'string' },
  set: { type: 'string', multiple: true },
  'set-all': { type: 'string', multiple: true },
  reason: { type: 'string' },
  pack: { type: 'string' },
  proposed: { type: 'boolean' },
  rule: { type: 'string' },
  result: { type: 'string' },
  'subject-kind': { type: 'string' },
  as: { type: 'string' },
  token: { type: 'string' },
  name: { type: 'string' },
  preset: { type: 'string' },
  capability: { type: 'string', multiple: true },
  grant: { type: 'string', multiple: true },
  'remove-capability': { type: 'string', multiple: true },
  'remove-grant': { type: 'string', multiple: true },
  'sign-in-subject': { type: 'string' },
  'sign-in-issuer': { type: 'string' },
  hazard: { type: 'string', multiple: true },
  recipient: { type: 'string', multiple: true },
} as const;

function positiveInteger(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(text)) throw new UsageError(`${flag} is a whole number: ${text}`);
  return Number(text);
}

function needs(positionals: string[], count: number, what: string): string[] {
  if (positionals.length !== count) throw new UsageError(`Give ${what}.`);
  return positionals;
}

/** The options each command reads, besides --json and --help. A command refuses any other. */
const commandOptions: Record<string, readonly string[]> = {
  me: [],
  mcp: [],
  'records types': [],
  'records columns': [],
  'records template': ['out'],
  'records check': ['mapping', 'original'],
  'records import': ['mapping', 'original'],
  'records read-log': ['format', 'out'],
  'records mapping': ['out'],
  'records list': ['subject', 'limit'],
  'records subject': [],
  'records produce': [
    'subject',
    'type',
    'from',
    'until',
    'to',
    'originals',
    'with-flights',
    'reason',
    'requested-by',
    'out',
  ],
  'plan draft': ['out', 'open'],
  'packs list': ['all'],
  'packs adopted': [],
  'packs show': ['version'],
  'packs adopt': ['version', 'mode', 'from', 'until', 'set', 'set-all', 'reason'],
  coverage: ['pack', 'rule', 'result'],
  findings: ['pack', 'rule', 'all', 'proposed', 'subject-kind', 'from', 'until'],
  'findings show': ['subject'],
  'findings take': ['pack', 'rule', 'subject-kind', 'from', 'until', 'reason'],
  'findings close': ['pack', 'rule', 'subject-kind', 'from', 'until', 'as', 'reason'],
  'people list': [],
  'people presets': [],
  'people add': ['name', 'preset', 'capability', 'grant', 'sign-in-subject', 'sign-in-issuer', 'reason'],
  'people set': ['preset', 'capability', 'remove-capability', 'grant', 'remove-grant', 'reason'],
  'people token': ['reason'],
  'safety home': [],
  'safety control-types': [],
  'safety template': ['out'],
  'safety check': [],
  'safety draft': [],
  'safety assess': ['hazard', 'reason'],
  'safety accept': ['reason'],
  'safety adopt': ['reason'],
  'safety review': ['reason'],
  'safety issue': ['recipient', 'from', 'reason'],
  'safety sign': ['reason'],
  'safety close-action': ['reason'],
};
const commandAliases: Record<string, string> = {
  'me show': 'me',
  'coverage show': 'coverage',
  'findings list': 'findings',
};

/** Refuses, with a sentence naming it, any option the command does not read. */
function refuseUnread(command: string, values: Record<string, unknown>): void {
  const reads = commandOptions[commandAliases[command] ?? command];
  if (!reads) return;
  const unread = Object.keys(values).filter(
    (name) => values[name] !== undefined && name !== 'json' && name !== 'help' && !reads.includes(name),
  );
  if (!unread.length) return;
  const named = unread.map((name) => `--${name}`).join(', ');
  const read = reads.length ? `It reads ${reads.map((name) => `--${name}`).join(', ')}` : 'It reads no option';
  throw new UsageError(
    `${command} does not read ${named}, so nothing was done. ${read} (and --json); pnpm ledger --help lists each command's options.`,
  );
}

async function dispatch(
  context: Context,
  noun: string | undefined,
  verb: string | undefined,
  rest: string[],
  values: Record<string, unknown>,
  path: (relative: string) => string,
  credential: string,
): Promise<Output> {
  const text = (name: string) => values[name] as string | undefined;
  const list = (name: string) => (values[name] as string[] | undefined) ?? [];
  const command = `${noun ?? ''} ${verb ?? ''}`.trim();
  const optionalPath = (name: string) => (text(name) === undefined ? undefined : path(text(name)!));
  const files = () => ({ mapping: optionalPath('mapping'), original: optionalPath('original') });
  refuseUnread(command, values);
  if (noun === 'safety')
    return runSafety(context, {
      verb,
      args: rest,
      reason: text('reason'),
      hazards: list('hazard'),
      recipients: list('recipient'),
      from: text('from'),
      out: text('out'),
      credential,
      path,
    });
  switch (command) {
    case 'me':
    case 'me show':
      return me(context);
    case 'records types':
      return listRecordTypes(context);
    case 'records columns':
      return recordColumns(context, needs(rest, 1, 'one record type')[0]!);
    case 'records template': {
      const output = await recordTemplate(context, needs(rest, 1, 'one record type')[0]!);
      const out = text('out');
      if (!out) return output;
      writeFileSync(path(out), (output.data as { csv: string }).csv);
      return { ...output, lines: [`Wrote ${path(out)}.`] };
    }
    case 'records check': {
      const [type, file] = needs(rest, 2, 'a record type and a file');
      return checkRecords(context, type!, path(file!), files());
    }
    case 'records import': {
      const [type, file] = needs(rest, 2, 'a record type and a file');
      return importRecords(context, type!, path(file!), files());
    }
    case 'records mapping': {
      const [type, file] = needs(rest, 2, 'a record type and the export file');
      return startRecordMapping(
        context,
        type!,
        path(file!),
        text('out') === undefined ? undefined : path(text('out')!),
      );
    }
    case 'records list': {
      const subjects = list('subject');
      if (subjects.length > 1) throw new UsageError('records list takes one --subject.');
      return listRecords(context, needs(rest, 1, 'one record type')[0]!, {
        subject: subjects[0],
        limit: positiveInteger(text('limit'), '--limit'),
      });
    }
    case 'records produce':
      if (rest.length) throw new UsageError(`records produce takes its choices as options: ${rest.join(' ')}`);
      if (text('until') !== undefined && text('to') !== undefined)
        throw new UsageError('Give the end date once: --until, or --to, which means the same.');
      return produceRecords(context, {
        subjects: list('subject'),
        types: list('type'),
        from: text('from'),
        to: text('until') ?? text('to'),
        originals: values.originals === true,
        withFlights: values['with-flights'] === true,
        reason: text('reason'),
        requestedBy: text('requested-by'),
        out: text('out') === undefined ? undefined : path(text('out')!),
      });
    case 'plan draft':
      if (rest.length) throw new UsageError(`plan draft takes only --out and --open: ${rest.join(' ')}`);
      return draftPlan(context, {
        out: text('out') === undefined ? undefined : path(text('out')!),
        open: values.open === true,
      });
    case 'records subject':
      return subjectFile(context, needs(rest, 1, 'one subject as <kind>:<id>, such as person:PIL-1')[0]!);
    case 'packs list':
      return listPacks(context, { all: values.all === true });
    case 'packs adopted':
      if (rest.length) throw new UsageError(`packs adopted takes no arguments: ${rest.join(' ')}`);
      return adoptedPacks(context);
    case 'packs show':
      return showPack(context, needs(rest, 1, 'one pack id')[0]!, positiveInteger(text('version'), '--version'));
    case 'packs adopt':
      return adoptPack(context, {
        packId: needs(rest, 1, 'one pack id')[0]!,
        version: positiveInteger(text('version'), '--version'),
        mode: text('mode'),
        from: text('from'),
        until: text('until'),
        set: list('set'),
        setAll: list('set-all'),
        reason: text('reason'),
      });
    case 'coverage':
    case 'coverage show': {
      const resultText = text('result');
      const result = resultText === undefined ? undefined : parseCoverageResult(resultText);
      if (resultText !== undefined && !result)
        throw new UsageError(
          `${resultText} is not a result. --result takes a value or the words coverage prints, or their first word: ${coverageResultChoices()}.`,
        );
      return coverage(context, { pack: text('pack'), rule: text('rule'), result });
    }
    case 'findings':
    case 'findings list': {
      const filters = {
        pack: text('pack'),
        rule: text('rule'),
        subjectKind: text('subject-kind'),
        from: text('from'),
        until: text('until'),
        proposed: values.proposed === true,
      };
      if (filters.rule && values.all === true) throw new UsageError('Give --rule or --all, not both.');
      return filters.rule || values.all === true ? openFindings(context, filters) : findingGroups(context, filters);
    }
    case 'findings show': {
      const subjects = list('subject');
      if (subjects.length > 1) throw new UsageError('findings show takes one --subject.');
      return showFinding(context, { finding: needs(rest, 1, 'one finding id')[0]!, subject: subjects[0] });
    }
    case 'findings take':
    case 'findings close':
      if (rest.length) throw new UsageError(`findings ${verb} takes its choices as options: ${rest.join(' ')}`);
      return treatFindingSet(context, {
        action: verb as 'take' | 'close',
        pack: text('pack'),
        rule: text('rule'),
        subjectKind: text('subject-kind'),
        from: text('from'),
        until: text('until'),
        as: text('as'),
        reason: text('reason'),
      });
    case 'people list':
      return listPeople(context);
    case 'people presets':
      return listPresets();
    case 'people add':
      if (rest.length) throw new UsageError(`people add takes its choices as options: ${rest.join(' ')}`);
      return addPerson(context, {
        name: text('name'),
        preset: text('preset'),
        capabilities: list('capability'),
        grants: list('grant'),
        signInSubject: text('sign-in-subject'),
        signInIssuer: text('sign-in-issuer'),
        reason: text('reason'),
      });
    case 'people set':
      return setPerson(context, {
        person: needs(rest, 1, 'one person: their id or full name')[0],
        preset: text('preset'),
        capabilities: list('capability'),
        removeCapabilities: list('remove-capability'),
        grants: list('grant'),
        removeGrants: list('remove-grant'),
        reason: text('reason'),
      });
    case 'people token':
      return issuePersonToken(context, {
        person: needs(rest, 1, 'one person: their id or full name')[0],
        reason: text('reason'),
      });
    default:
      throw new UsageError(`Unknown command: ${[noun, verb].filter(Boolean).join(' ') || '(none)'}`);
  }
}

/** Runs one command; returns the exit code: 0 done, 1 refused or failed, 2 a mistake in the command. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) {
    (values.help ? io.out : io.err)(usage);
    return values.help ? 0 : 2;
  }
  if (values.token !== undefined) {
    io.err('A credential is never given as an argument. Set LEDGER_TOKEN, or put it in .ledger/credentials.');
    return 2;
  }
  const json = values.json === true;
  const [noun, verb, ...rest] = positionals;
  const path = (relative: string) => resolve(io.folders[0] ?? '.', relative);
  try {
    if (noun === 'records' && verb === 'read-log') {
      // Reading a log needs no Ledger: it runs offline, before any credential is read.
      refuseUnread('records read-log', values);
      const output = await readFlightLog(path(needs(rest, 1, 'one log file')[0]!), {
        format: values.format,
        out: values.out === undefined ? undefined : path(values.out),
        folder: io.folders[0] ?? resolve('.'),
      });
      if (json) io.out(JSON.stringify(output.data, null, 2));
      else for (const line of output.lines) io.out(line);
      return output.refused ? 1 : 0;
    }
    const connection = readConnection(io.env, io.folders);
    if (noun === 'mcp') {
      // Standard output carries the protocol: nothing else may be written to it while the server runs.
      refuseUnread('mcp', values);
      if (verb !== undefined || json) throw new UsageError('mcp takes no arguments and no --json.');
      await serveMcp({
        connection,
        folder: io.folders[0] ?? resolve('.'),
        fetcher: io.fetcher,
        input: io.input ?? process.stdin,
        output: io.output ?? process.stdout,
      });
      return 0;
    }
    const client = new LedgerClient(connection.apiUrl, connection.token, io.fetcher);
    const context: Context = {
      client,
      say: (line) => (json ? io.err : io.out)(line),
      ...(io.pause ? { pause: io.pause } : {}),
    };
    const output = await dispatch(context, noun, verb, rest, values, path, connection.token);
    if (json) io.out(JSON.stringify(output.data, null, 2));
    else for (const line of output.lines) io.out(line);
    return output.refused ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigurationError) {
      io.err(error.message);
      return 2;
    }
    if (error instanceof RefusalError) {
      io.err(error.message);
      return 1;
    }
    if (error instanceof ApiError) {
      io.err(refusalWords(error));
      return 1;
    }
    io.err(`Could not reach Ledger: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
