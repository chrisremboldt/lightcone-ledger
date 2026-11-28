import { Type, type Static, type TObject } from '@sinclair/typebox';
import { capabilityValues, coverageResultValues, observationSubjectKindValues, rolePresets } from '@ledger/contracts';
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
  showPack,
  subjectFile,
  UsageError,
  type Context,
  type Output,
} from './commands.js';
import { findingGroups, openFindings, showFinding, treatFindingSet } from './findings.js';
import { addPerson, listPeople, listPresets } from './people.js';
import { setPerson } from './people-authority.js';
import { readFlightLog } from './read-log.js';
import { startRecordMapping } from './record-mapping.js';
import { draftPlan } from './records-plan.js';
import { flightTimeReport, occurrencesReport } from './reports.js';
import { runSafety } from './safety.js';

/**
 * The client's commands as Model Context Protocol tools. Each tool calls the same function its command does, so there
 * is one implementation of each command and two ways to call it. A tool takes no credential and no reason: the server
 * runs under the client's own credential, and a person's decision is prepared, never sent.
 */

/** What MCP says about a tool's effects. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/** Where a tool reads and writes the files it is given: relative paths are resolved where the server was started. */
export interface ToolFiles {
  path: (relative: string) => string;
  folder: string;
}

export interface ToolResult {
  output: Output;
  /** For a person's decision that was prepared and not sent: the command the person runs to send it. */
  personRuns?: string;
}

export interface LedgerTool<Input extends TObject = TObject> {
  name: string;
  title: string;
  description: string;
  input: Input;
  annotations: ToolAnnotations;
  run: (context: Context, input: Static<Input>, files: ToolFiles) => Promise<ToolResult>;
}

/** Reads Ledger and records nothing. */
const reads: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Records nothing a rule reads, but Ledger keeps each file sent to it as an upload. */
const keepsUploads: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Writes a new file on this computer; refuses to overwrite one. */
const writesLocalFile: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Appends records to Ledger. Nothing on file is changed; a row already recorded is not recorded again. */
const appendsRecords: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const Closed = { additionalProperties: false } as const;
const Text = (description: string) => Type.String({ minLength: 1, maxLength: 1000, description });
const Day = (description: string) =>
  Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: `${description}, such as 2026-06-01` });
const MonthInput = Type.Object(
  {
    month: Type.Optional(
      Type.String({
        pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$',
        description:
          'The calendar month, such as 2026-10, in the organization’s time zone. Left out: the last whole month.',
      }),
    ),
    csv: Type.Optional(Type.Boolean({ description: 'Return the lines of one CSV table instead of the report.' })),
  },
  { additionalProperties: false },
);
const SubjectKind = Type.Union(
  observationSubjectKindValues.map((kind) => Type.Literal(kind)),
  { description: 'The kind of subject.' },
);
const RecordType = Text('A record type, as record_types lists them, such as flight.record.');
const File = (description: string) =>
  Text(`${description}. A relative path is read from the folder the server was started in.`);
const Strings = (description: string) => Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { description });

const tool = <Input extends TObject>(definition: LedgerTool<Input>): LedgerTool => definition as unknown as LedgerTool;
const done = (output: Output): ToolResult => ({ output });

/** One argument as a person types it in a shell: quoted when it holds anything a shell reads. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command a person runs, with their own credential, to send what a tool prepared. */
function personCommand(words: (string | undefined | false)[]): string {
  const typed = words.filter((word): word is string => typeof word === 'string');
  return `pnpm ledger ${typed.map(shellWord).join(' ')} --reason "<their reason>"`;
}

const flags = (flag: string, values: readonly string[] | undefined) => (values ?? []).flatMap((value) => [flag, value]);
const flag = (name: string, value: string | number | undefined) => (value === undefined ? [] : [name, String(value)]);

/** A prepared decision: the command is given only when the output says it was not sent. */
function prepared(output: Output, words: (string | undefined | false)[]): ToolResult {
  const notSent = output.lines.some((line) => line.startsWith('Not sent.'));
  return notSent ? { output, personRuns: personCommand(words) } : { output };
}

export const tools: LedgerTool[] = [
  tool({
    name: 'who_am_i',
    title: 'Who the credential is',
    description:
      'Who the client’s credential is, its organization and time zone, what it may do and which records it may import. Every other tool runs under this credential.',
    input: Type.Object({}, Closed),
    annotations: reads,
    run: async (context) => done(await me(context)),
  }),
  tool({
    name: 'record_types',
    title: 'Record types',
    description:
      'The record types this organization can record, what each is about, and its version: the built-in ones and those of the packs it has adopted.',
    input: Type.Object({}, Closed),
    annotations: reads,
    run: async (context) => done(await listRecordTypes(context)),
  }),
  tool({
    name: 'record_columns',
    title: 'Columns of a record type',
    description:
      'Each column of a record type: whether it is required or places the record in time, what it holds (units, choices, ids) and what it means, and which adopted rules read it.',
    input: Type.Object({ recordType: RecordType }, Closed),
    annotations: reads,
    run: async (context, input) => done(await recordColumns(context, input.recordType)),
  }),
  tool({
    name: 'record_template',
    title: 'An empty CSV for a record type',
    description: 'An empty CSV file with the header row of a record type, returned as text.',
    input: Type.Object({ recordType: RecordType }, Closed),
    annotations: reads,
    run: async (context, input) => done(await recordTemplate(context, input.recordType)),
  }),
  tool({
    name: 'start_mapping',
    title: 'Start a column mapping',
    description:
      'Starts a column mapping from an export in its own columns: every column of the export listed, none assigned, and the fields of the record type as comments. Returned as YAML text; nothing is guessed and nothing is sent.',
    input: Type.Object({ recordType: RecordType, exportFile: File('The export, a CSV file') }, Closed),
    annotations: reads,
    run: async (context, input, files) =>
      done(await startRecordMapping(context, input.recordType, files.path(input.exportFile), undefined)),
  }),
  tool({
    name: 'read_flight_log',
    title: 'Read an aircraft’s own log',
    description:
      'Reads a PX4 ULog (.ulg), ArduPilot DataFlash (.bin) or MAVLink telemetry log (.tlog), or a GUTMA flight log a fleet product exported (JSON), into a flight.record CSV beside it, one row per whole flight with only what the log holds, and says what it could not read. Works on this computer and sends nothing to Ledger; then check_records and import_records with the log as the original.',
    input: Type.Object(
      {
        log: File('The log file'),
        format: Type.Optional(
          Type.Union([Type.Literal('ulog'), Type.Literal('dataflash'), Type.Literal('tlog'), Type.Literal('gutma')], {
            description: 'Only when the log does not begin as its format does.',
          }),
        ),
        out: Type.Optional(
          File('Where to write the CSV; by default beside the log. An existing file is never replaced'),
        ),
      },
      Closed,
    ),
    annotations: writesLocalFile,
    run: async (_context, input, files) =>
      done(
        await readFlightLog(files.path(input.log), {
          format: input.format,
          out: input.out === undefined ? undefined : files.path(input.out),
          folder: files.folder,
        }),
      ),
  }),
  tool({
    name: 'check_records',
    title: 'Check a file of records',
    description:
      'What importing a CSV or JSON file would record, row by row, and why each refused row is refused. With mapping, the file is an export in its own columns read through a column mapping; with original, each record would cite that file (such as an aircraft’s log) as its original. Makes no record and no rule reads it; Ledger keeps the files sent as uploads, as it keeps every file sent to it.',
    input: Type.Object(
      {
        recordType: RecordType,
        file: File('The CSV or JSON file'),
        mapping: Type.Optional(File('A column mapping (YAML) the file is read through')),
        original: Type.Optional(File('The file the rows were read from')),
      },
      Closed,
    ),
    annotations: keepsUploads,
    run: async (context, input, files) =>
      done(
        await checkRecords(context, input.recordType, files.path(input.file), {
          mapping: input.mapping === undefined ? undefined : files.path(input.mapping),
          original: input.original === undefined ? undefined : files.path(input.original),
        }),
      ),
  }),
  tool({
    name: 'import_records',
    title: 'Import a file of records',
    description:
      'Imports a CSV or JSON file, as the command-line client does with this credential: each row that can be recorded is recorded as this credential, which needs input:write and a grant for the records. A row already recorded is not recorded again, and nothing on file is changed. Check the file with check_records first.',
    input: Type.Object(
      {
        recordType: RecordType,
        file: File('The CSV or JSON file'),
        mapping: Type.Optional(File('A column mapping (YAML) the file is read through')),
        original: Type.Optional(File('The file the rows were read from')),
      },
      Closed,
    ),
    annotations: appendsRecords,
    run: async (context, input, files) =>
      done(
        await importRecords(context, input.recordType, files.path(input.file), {
          mapping: input.mapping === undefined ? undefined : files.path(input.mapping),
          original: input.original === undefined ? undefined : files.path(input.original),
        }),
      ),
  }),
  tool({
    name: 'list_records',
    title: 'Records of one type',
    description:
      'The records of one type on file, newest first, each with its Ledger id; optionally about one subject.',
    input: Type.Object(
      {
        recordType: RecordType,
        subjectId: Type.Optional(Text('Your own id for the subject, such as PIL-1')),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: 'How many records at most.' })),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) =>
      done(await listRecords(context, input.recordType, { subject: input.subjectId, limit: input.limit })),
  }),
  tool({
    name: 'subject_file',
    title: 'What is on file about a subject',
    description:
      'What is on file about one subject (a person, an aircraft, a flight): its records by type, the adopted rules that have read it with their latest result, and its findings not yet resolved.',
    input: Type.Object({ subjectKind: SubjectKind, subjectId: Text('Your own id for the subject') }, Closed),
    annotations: reads,
    run: async (context, input) => done(await subjectFile(context, `${input.subjectKind}:${input.subjectId}`)),
  }),
  tool({
    name: 'flight_time_by_aircraft',
    title: 'Flight time by aircraft for a month',
    description:
      'For one calendar month in the organization’s time zone: each aircraft the flight records name, its registration and serial number from its identity record, its flights whose takeoff is in the month and their recorded takeoff to landing time, and each flight with no landing time on file. Counts of what is on file, to prepare a report the operator sends itself; it names no rule and Ledger sends nothing. A flight with no flight record is not counted.',
    input: MonthInput,
    annotations: reads,
    run: async (context, input) => done(await flightTimeReport(context, input)),
  }),
  tool({
    name: 'occurrences_by_month',
    title: 'Occurrences recorded in a month',
    description:
      'For one calendar month in the organization’s time zone: the occurrence records on file by record type, each with its day, the flight and aircraft it names by the organization’s own ids, and the fields its record holds. Operator records only: no safety report is read. A type with none on file says only that none was recorded.',
    input: MonthInput,
    annotations: reads,
    run: async (context, input) => done(await occurrencesReport(context, input)),
  }),
  tool({
    name: 'list_packs',
    title: 'Packs on offer',
    description:
      'The rule packs this Ledger offers, the latest version of each unless all is true, and where each came from.',
    input: Type.Object({ all: Type.Optional(Type.Boolean({ description: 'List earlier versions too.' })) }, Closed),
    annotations: reads,
    run: async (context, input) => done(await listPacks(context, { all: input.all === true })),
  }),
  tool({
    name: 'adopted_packs',
    title: 'Packs adopted',
    description:
      'The packs the organization has adopted and that are in effect: each version, mode (active or shadow), state and dates.',
    input: Type.Object({}, Closed),
    annotations: reads,
    run: async (context) => done(await adoptedPacks(context)),
  }),
  tool({
    name: 'show_pack',
    title: 'A pack’s rules',
    description:
      'A pack’s rules by section: each rule’s paragraph, title, how it is checked and what it asks on adoption; for a pack from the organization’s own file, the fields each rule reads.',
    input: Type.Object(
      {
        packId: Text('The pack id, as list_packs gives it'),
        version: Type.Optional(Type.Integer({ minimum: 1, description: 'A version; the latest by default.' })),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) => done(await showPack(context, input.packId, input.version)),
  }),
  tool({
    name: 'coverage',
    title: 'Coverage',
    description:
      'For each adopted pack, each rule, how it is checked, who it covers and its latest counts by result. With rule (which needs pack) or result, the subjects behind a count and the sentence for each. A result of no_record is a record not on file, which opens no finding.',
    input: Type.Object(
      {
        pack: Type.Optional(Text('One adopted pack')),
        rule: Type.Optional(Text('One rule of the pack, whole or after the pack id')),
        result: Type.Optional(
          Type.Union(
            coverageResultValues.map((value) => Type.Literal(value)),
            { description: 'One result.' },
          ),
        ),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) => done(await coverage(context, input)),
  }),
  tool({
    name: 'list_findings',
    title: 'Open findings',
    description:
      'The open findings grouped by rule, the rules with the fewest first, ending with each adopted pack’s results that say a record is not on file. With rule, that rule’s findings; with all, every open finding, oldest first, with its owner and sentence. proposed lists those of rules adopted in shadow, which are recorded and never counted.',
    input: Type.Object(
      {
        pack: Type.Optional(Text('One pack')),
        rule: Type.Optional(Text('One rule, whole or after the pack id')),
        all: Type.Optional(Type.Boolean({ description: 'Every open finding instead of the groups. Not with rule.' })),
        proposed: Type.Optional(Type.Boolean({ description: 'Findings of rules adopted in shadow.' })),
        subjectKind: Type.Optional(SubjectKind),
        from: Type.Optional(Day('The first day the findings are about, in the organization’s time zone')),
        until: Type.Optional(Day('The last day the findings are about, in the organization’s time zone')),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) => {
      const filters = { ...input, proposed: input.proposed === true };
      if (input.rule && input.all) throw new UsageError('Give rule or all, not both.');
      return done(
        input.rule || input.all ? await openFindings(context, filters) : await findingGroups(context, filters),
      );
    },
  }),
  tool({
    name: 'show_finding',
    title: 'One finding and what it rests on',
    description:
      'One finding: what it is about, its status and owner, the evaluation that opened it and the latest, the records each evaluation read, what each found not on file, and the decisions recorded about it. A finding no longer open is found by the subject it is about.',
    input: Type.Object(
      {
        finding: Text('The finding id, as list_findings or subject_file gives it'),
        subjectKind: Type.Optional(SubjectKind),
        subjectId: Type.Optional(
          Text('The id of the subject the finding is about; needed for a finding no longer open'),
        ),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) => {
      if ((input.subjectKind === undefined) !== (input.subjectId === undefined))
        throw new UsageError('Give subjectKind and subjectId together, or neither.');
      return done(
        await showFinding(context, {
          finding: input.finding,
          subject: input.subjectKind ? `${input.subjectKind}:${input.subjectId}` : undefined,
        }),
      );
    },
  }),
  tool({
    name: 'list_people',
    title: 'People and what they may do',
    description:
      'Everyone in the organization, people, services and sources, with what each may do and which records each may import.',
    input: Type.Object({}, Closed),
    annotations: reads,
    run: async (context) => done(await listPeople(context)),
  }),
  tool({
    name: 'role_presets',
    title: 'Role presets',
    description: 'The role presets and exactly what each grants.',
    input: Type.Object({}, Closed),
    annotations: reads,
    run: async () => done(listPresets()),
  }),
  tool({
    name: 'draft_recordkeeping_plan',
    title: 'Draft a recordkeeping plan',
    description:
      'A recordkeeping plan drafted from the records the adopted packs require, as text, with the blanks only the organization can fill. Records nothing; a person opens it as a draft document.',
    input: Type.Object({}, Closed),
    annotations: reads,
    run: async (context) => done(await draftPlan(context, { open: false })),
  }),
  tool({
    name: 'prepare_adoption',
    title: 'Prepare an adoption',
    description:
      'Prepares an adoption of a pack exactly as the client prints it: what it would record, what it replaces, the values each rule takes and who it would be recorded as. Sends nothing. An adoption is a person’s decision: the result gives the command the person runs with their own credential and reason.',
    input: Type.Object(
      {
        packId: Text('The pack id'),
        version: Type.Optional(Type.Integer({ minimum: 1, description: 'A version; the latest by default.' })),
        mode: Type.Optional(
          Type.Union([Type.Literal('active'), Type.Literal('shadow')], {
            description: 'active: its findings count. shadow: recorded, never counted.',
          }),
        ),
        from: Type.Optional(Text('The first day, in the organization’s time zone, or a time with its offset')),
        until: Type.Optional(Text('The last day, in the organization’s time zone, or a time with its offset')),
        set: Type.Optional(Strings('<rule>.<name>=<value> for one rule, the rule whole or after the pack id')),
        setAll: Type.Optional(Strings('<name>=<value> for every rule that asks for that name')),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) =>
      prepared(
        await adoptPack(context, {
          packId: input.packId,
          version: input.version,
          mode: input.mode,
          from: input.from,
          until: input.until,
          set: input.set ?? [],
          setAll: input.setAll ?? [],
        }),
        [
          'packs',
          'adopt',
          input.packId,
          ...flag('--version', input.version),
          ...flag('--mode', input.mode),
          ...flag('--from', input.from),
          ...flag('--until', input.until),
          ...flags('--set', input.set),
          ...flags('--set-all', input.setAll),
        ],
      ),
  }),
  tool({
    name: 'prepare_findings_decision',
    title: 'Prepare taking or closing a rule’s findings',
    description:
      'Prepares taking (take) or closing (close) every counted open finding of one rule as one decision, narrowed by subject kind and days: lists the findings it would cover. Sends nothing. It is a person’s decision: the result gives the command the person runs with their own credential and reason.',
    input: Type.Object(
      {
        action: Type.Union([Type.Literal('take'), Type.Literal('close')]),
        rule: Text('The rule, whole or after the pack id'),
        pack: Type.Optional(Text('The pack, when the rule id names rules of more than one')),
        subjectKind: Type.Optional(SubjectKind),
        from: Type.Optional(Day('The first day the findings are about')),
        until: Type.Optional(Day('The last day the findings are about')),
        as: Type.Optional(
          Type.Union(
            ['corrected-by-record', 'accepted', 'condition-ended', 'recorded-in-error'].map((value) =>
              Type.Literal(value),
            ),
            { description: 'For close: why they are closed.' },
          ),
        ),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) =>
      prepared(await treatFindingSet(context, input), [
        'findings',
        input.action,
        '--rule',
        input.rule,
        ...flag('--pack', input.pack),
        ...flag('--subject-kind', input.subjectKind),
        ...flag('--from', input.from),
        ...flag('--until', input.until),
        ...flag('--as', input.as),
      ]),
  }),
  tool({
    name: 'prepare_person_addition',
    title: 'Prepare adding a person',
    description:
      'Prepares adding a person with a preset or capabilities and record grants, as the client prints it. Sends nothing. It is an administrator’s decision: the result gives the command they run with their own credential and reason.',
    input: Type.Object(
      {
        name: Text('Their full name'),
        preset: Type.Optional(
          Type.Union(
            rolePresets.map((preset) => Type.Literal(preset.key)),
            { description: 'A role preset, as role_presets lists them.' },
          ),
        ),
        capabilities: Type.Optional(
          Type.Array(Type.Union(capabilityValues.map((value) => Type.Literal(value))), {
            description: 'Capabilities beside the preset.',
          }),
        ),
        grants: Type.Optional(Strings('<source id>:<observation type> they may record')),
        signInSubject: Type.Optional(Text('The subject of their sign-in account')),
        signInIssuer: Type.Optional(Text('The issuer of their sign-in account')),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) =>
      prepared(
        await addPerson(context, {
          name: input.name,
          preset: input.preset,
          capabilities: input.capabilities ?? [],
          grants: input.grants ?? [],
          signInSubject: input.signInSubject,
          signInIssuer: input.signInIssuer,
        }),
        [
          'people',
          'add',
          '--name',
          input.name,
          ...flag('--preset', input.preset),
          ...flags('--capability', input.capabilities),
          ...flags('--grant', input.grants),
          ...flag('--sign-in-subject', input.signInSubject),
          ...flag('--sign-in-issuer', input.signInIssuer),
        ],
      ),
  }),
  tool({
    name: 'prepare_person_change',
    title: 'Prepare changing what a person may do',
    description:
      'Prepares a change of what a person may do: what they may do now and after. Sends nothing. It is an administrator’s decision: the result gives the command they run with their own credential and reason.',
    input: Type.Object(
      {
        person: Text('Their id or full name'),
        preset: Type.Optional(Type.Union(rolePresets.map((preset) => Type.Literal(preset.key)))),
        capabilities: Type.Optional(Type.Array(Type.Union(capabilityValues.map((value) => Type.Literal(value))))),
        removeCapabilities: Type.Optional(Type.Array(Type.Union(capabilityValues.map((value) => Type.Literal(value))))),
        grants: Type.Optional(Strings('<source id>:<observation type> to grant')),
        removeGrants: Type.Optional(Strings('<source id>:<observation type> to remove')),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input) =>
      prepared(
        await setPerson(context, {
          person: input.person,
          preset: input.preset,
          capabilities: input.capabilities ?? [],
          removeCapabilities: input.removeCapabilities ?? [],
          grants: input.grants ?? [],
          removeGrants: input.removeGrants ?? [],
        }),
        [
          'people',
          'set',
          input.person,
          ...flag('--preset', input.preset),
          ...flags('--capability', input.capabilities),
          ...flags('--remove-capability', input.removeCapabilities),
          ...flags('--grant', input.grants),
          ...flags('--remove-grant', input.removeGrants),
        ],
      ),
  }),
  tool({
    name: 'prepare_safety_decision',
    title: 'Prepare a safety decision',
    description:
      'Prepares one of a person’s safety decisions exactly as the client prints it, and sends nothing: assess (arguments: the hazard register file), accept (the hazard), adopt (matrix or document, then its id), review (the document), issue (the document; recipients and from), sign (the document or assurance record) or close-action (the assurance record and the action). The result gives the command the person runs with their own credential and reason; a signature on a deployment is made in the browser.',
    input: Type.Object(
      {
        decision: Type.Union(
          ['assess', 'accept', 'adopt', 'review', 'issue', 'sign', 'close-action'].map((value) => Type.Literal(value)),
        ),
        arguments: Strings('What the decision is about, in order, as the description says for each decision'),
        hazards: Type.Optional(Strings('For assess: only these hazards of the file')),
        recipients: Type.Optional(Strings('For issue: who it goes to, by name or id, or everyone')),
        from: Type.Optional(Text('For issue: the day it takes effect')),
      },
      Closed,
    ),
    annotations: reads,
    run: async (context, input, files) =>
      prepared(
        await runSafety(context, {
          verb: input.decision,
          args: input.arguments,
          hazards: input.hazards ?? [],
          recipients: input.recipients ?? [],
          from: input.from,
          // Sent only with a reason, which no tool takes; never the client's own credential.
          credential: '',
          path: files.path,
        }),
        [
          'safety',
          input.decision,
          ...input.arguments,
          ...flags('--hazard', input.hazards),
          ...flags('--recipient', input.recipients),
          ...flag('--from', input.from),
        ],
      ),
  }),
];
