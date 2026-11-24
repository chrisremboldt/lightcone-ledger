import { parse as parseYaml } from 'yaml';
import {
  assuranceBodyProblems,
  assuranceTypeValues,
  documentTypeValues,
  recordedReportChannelValues,
  riskAcceptanceValues,
  riskMatrixProblems,
  type AssuranceBody,
  type DocumentBodyV2,
  type HazardBody,
  type ReportBody,
  type RiskMatrixBody,
  type SmsPersonRef,
  type SmsRecordDraft,
  type SmsRecordKind,
} from '@ledger/contracts';
import { startOfDay } from './adoption.js';

/** The kinds of file `pnpm ledger safety` reads, and the record kind each opens. */
export const safetyFileKinds = {
  matrix: 'risk_matrix',
  hazards: 'hazard',
  document: 'document',
  assurance: 'assurance',
  report: 'report',
} as const satisfies Record<string, SmsRecordKind>;
export type SafetyFileKind = keyof typeof safetyFileKinds;

/** What a file is read against: who may be named, the organization's zone and its current day. */
export interface FileContext {
  people: readonly SmsPersonRef[];
  zone: string;
  /** The organization's current day, YYYY-MM-DD. */
  today: string;
}

/** One record a file would open, under the organization's own id. */
export interface DraftItem {
  kind: SmsRecordKind;
  reference: string;
  /** How the client names it. Never a safety report's title or narrative. */
  name: string;
  /** Absent when the item has problems. A control's hazardId is filled in when its hazard is on file. */
  draft?: SmsRecordDraft;
  confidentiality?: 'safety_report';
  /** For a control: the reference of the hazard it is proposed on. */
  hazardReference?: string;
  problems: string[];
}

/** A hazard row's before and after positions, as a person assesses with them. */
export interface AssessmentRow {
  reference: string;
  initial: { severity: string; likelihood: string } | null;
  residual: { severity: string; likelihood: string } | null;
  newHazards: string;
}

export interface ReadFile {
  items: DraftItem[];
  /** Problems with the file as a whole. */
  problems: string[];
  assessments: AssessmentRow[];
}

export class FileProblem extends Error {}

/** The control type a register's mitigations become: what is done, owned by the record owner, from a date. */
export const PLAIN_CONTROL_TYPE = { id: 'control.described-measure', version: 1 } as const;

const ReferencePattern = /^\S(?:.*\S)?$/;

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function referenceProblems(reference: string): string[] {
  if (!reference) return ['It has no id: give the organization’s own id for it, such as H-001.'];
  if (reference.length > 80 || !ReferencePattern.test(reference))
    return [`The id ${reference} has more than 80 characters.`];
  return [];
}

function lengthProblem(what: string, value: string, max: number, required = true): string[] {
  if (!value) return required ? [`Give ${what}.`] : [];
  return value.length > max ? [`${capitalized(what)} has more than ${max} characters.`] : [];
}

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** A person by Ledger id or by full name, exactly as the People list shows it. */
export function personId(context: FileContext, named: string, role: string): { id?: string; problem?: string } {
  if (!named) return { problem: `Give the ${role}: a person's full name or Ledger id.` };
  const byId = context.people.find((person) => person.id === named);
  if (byId) return { id: byId.id };
  const byName = context.people.filter((person) => person.name.toLowerCase() === named.toLowerCase());
  if (byName.length === 1) return { id: byName[0]!.id };
  if (byName.length > 1)
    return { problem: `${byName.length} people are named ${named}; give the ${role} by Ledger id.` };
  return {
    problem: `The ${role}, ${named}, is nobody who may read safety records here. pnpm ledger people list shows each person's full name and id.`,
  };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function validDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!));
  return date.getUTCMonth() === +match[2]! - 1 && date.getUTCDate() === +match[3]!;
}

/** A day in the organization's zone (its start, or the end of it) or a time with its offset, as an instant. */
export function instantOf(value: string, zone: string, edge: 'start' | 'end'): string | undefined {
  if (validDay(value)) {
    const [, year, month, day] = DAY.exec(value)!;
    return startOfDay(+year!, +month!, +day! + (edge === 'end' ? 1 : 0), zone);
  }
  if (TIME.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

function dateProblem(what: string, value: string): string[] {
  return value && !validDay(value) && !TIME.test(value)
    ? [`${capitalized(what)} is a date such as 2026-06-01 or a time with its offset: ${value}`]
    : [];
}

/** A CSV file as rows of named cells; a quoted cell may hold commas, quotes ("") and line breaks. */
export function parseCsv(content: string): { headings: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = content.replace(/^﻿/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new FileProblem('A quoted cell is not closed.');
  if (cell || row.length) {
    row.push(cell);
    records.push(row);
  }
  const filled = records.filter((record) => record.some((value) => value.trim()));
  const headings = (filled[0] ?? []).map((heading) => heading.trim());
  return {
    headings,
    rows: filled
      .slice(1)
      .map((record) => Object.fromEntries(headings.map((heading, at) => [heading, (record[at] ?? '').trim()]))),
  };
}

/** The values between two `---` lines at the top of a text file, and the text after them. */
export function frontMatter(content: string): { values: Record<string, unknown>; text: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) throw new FileProblem('The file starts with its stated values between two lines of three dashes (---).');
  let values: unknown;
  try {
    values = parseYaml(match[1]!);
  } catch (error) {
    // The stated values may hold what a reader must not see, so only the line is named.
    const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    throw new FileProblem(`The stated values are not valid YAML${line ? ` at line ${line + 1} of the file` : ''}.`);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new FileProblem('The stated values are names and values, one per line, such as "id: SR-26-015".');
  return { values: values as Record<string, unknown>, text: match[2]!.trim() };
}

function structured(content: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = /\.json$/i.test(path) ? JSON.parse(content) : parseYaml(content);
  } catch (error) {
    throw new FileProblem(
      `The file is not valid ${/\.json$/i.test(path) ? 'JSON' : 'YAML'}: ${(error as Error).message.split('\n')[0]}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new FileProblem('The file holds one record: names and values, such as "id: RM-1".');
  return value as Record<string, unknown>;
}

function unknownKeys(values: Record<string, unknown>, known: readonly string[]): string[] {
  const extra = Object.keys(values).filter((key) => !known.includes(key));
  return extra.length
    ? [
        `${extra.map((key) => `"${key}"`).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not read; the names it reads are ${known.join(', ')}.`,
      ]
    : [];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

// ---- risk matrix

const matrixKeys = ['id', 'title', 'owner', 'name', 'severities', 'likelihoods', 'levels', 'grid', 'cells'] as const;

function axis(values: unknown): { id: string; label: string; description: string }[] {
  return list(values).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return { id: text(item.id), label: text(item.label), description: text(item.description) };
  });
}

/** A level, severity or likelihood named by its id or its label. */
function byIdOrLabel<T extends { id: string; label: string }>(entries: readonly T[], named: string): T | undefined {
  const lower = named.toLowerCase();
  return entries.find((entry) => entry.id === named) ?? entries.find((entry) => entry.label.toLowerCase() === lower);
}

export function readMatrix(content: string, path: string, context: FileContext): ReadFile {
  const values = structured(content, path);
  const problems = unknownKeys(values, matrixKeys);
  const reference = text(values.id);
  const name = text(values.name);
  const severities = axis(values.severities);
  const likelihoods = axis(values.likelihoods);
  const levels = list(values.levels).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return {
      id: text(item.id),
      label: text(item.label),
      meaning: text(item.meaning),
      acceptance: text(item.acceptance) as RiskMatrixBody['levels'][number]['acceptance'],
    };
  });
  for (const level of levels)
    if (!(riskAcceptanceValues as readonly string[]).includes(level.acceptance))
      problems.push(
        `Level ${level.label || level.id} says who may accept it as "${level.acceptance}": give low, medium or high (the authority it needs) or not_acceptable.`,
      );
  const cells: RiskMatrixBody['cells'] = [];
  const levelId = (named: string, where: string) => {
    const level = byIdOrLabel(levels, named);
    if (!level) problems.push(`${where} names ${named || 'no level'}, which is not one of the matrix's levels.`);
    return level?.id ?? named;
  };
  if (values.grid !== undefined) {
    const grid = (values.grid ?? {}) as Record<string, unknown>;
    for (const [likelihoodName, row] of Object.entries(grid)) {
      const likelihood = byIdOrLabel(likelihoods, likelihoodName);
      if (!likelihood) {
        problems.push(`The grid has a row for ${likelihoodName}, which is not one of the likelihoods.`);
        continue;
      }
      const named = list(row).map(text);
      if (named.length !== severities.length)
        problems.push(
          `The grid row for ${likelihood.label} gives ${named.length} levels; it needs one per severity, ${severities.length}.`,
        );
      named.forEach((level, index) => {
        const severity = severities[index];
        if (severity)
          cells.push({
            severity: severity.id,
            likelihood: likelihood.id,
            level: levelId(level, `The grid row for ${likelihood.label}`),
          });
      });
    }
  } else
    for (const entry of list(values.cells)) {
      const item = (entry ?? {}) as Record<string, unknown>;
      const severity = byIdOrLabel(severities, text(item.severity));
      const likelihood = byIdOrLabel(likelihoods, text(item.likelihood));
      cells.push({
        severity: severity?.id ?? text(item.severity),
        likelihood: likelihood?.id ?? text(item.likelihood),
        level: levelId(text(item.level), `A cell`),
      });
    }
  const body: RiskMatrixBody = { name, severities, likelihoods, levels, cells };
  problems.push(...lengthProblem('the matrix name (name)', name, 120));
  if (!problems.length) problems.push(...riskMatrixProblems(body));
  const owner = personId(context, text(values.owner), 'owner');
  const title = text(values.title) || name;
  const item: DraftItem = {
    kind: 'risk_matrix',
    reference,
    name: `Risk matrix ${reference}`,
    problems: [
      ...referenceProblems(reference),
      ...(owner.problem ? [owner.problem] : []),
      ...problems,
      ...lengthProblem('the title', title, 200),
    ],
  };
  if (!item.problems.length)
    item.draft = { kind: 'risk_matrix', schema: 'sms.risk-matrix.1', title, ownerId: owner.id!, body };
  return { items: [item], problems: [], assessments: [] };
}

// ---- hazard register

export const hazardColumns = [
  ['id', 'The organization’s own id for the hazard, such as H-001. Required.'],
  ['title', 'A short name. Optional: the start of the hazard is used.'],
  ['hazard', 'The hazard: what could go wrong. Required.'],
  ['consequence', 'Its worst credible outcome. Required.'],
  ['operation', 'The operation it belongs to. Optional.'],
  ['owner', 'Who owns it: a person’s full name or Ledger id. Required.'],
  ['raised', 'The day it was raised. Optional.'],
  ['reviewDue', 'The day its next review is due. Optional.'],
  ['controls', 'The mitigations in place, separated by ";". Each becomes a control on the hazard. Optional.'],
  ['controlsFrom', 'The day the controls are in effect from. Optional: the day it was raised, or today.'],
  ['severityBefore', 'Severity before the controls, by the matrix’s id or label. Read by safety assess.'],
  ['likelihoodBefore', 'Likelihood before the controls. Read by safety assess.'],
  ['severityAfter', 'Severity with the controls in place. Read by safety assess.'],
  ['likelihoodAfter', 'Likelihood with the controls in place. Read by safety assess.'],
  ['newHazards', '"none", or the new hazards the controls may introduce. Read by safety assess.'],
] as const;

function shortTitle(words: string): string {
  const single = words.replace(/\s+/g, ' ');
  return single.length <= 120 ? single : `${single.slice(0, 119).trimEnd()}…`;
}

export function readHazards(content: string, context: FileContext): ReadFile {
  const { headings, rows } = parseCsv(content);
  const known = hazardColumns.map(([name]) => name as string);
  const lower = new Map(headings.map((heading) => [heading.toLowerCase(), heading]));
  const problems: string[] = [];
  const unknown = headings.filter((heading) => !known.some((name) => name.toLowerCase() === heading.toLowerCase()));
  if (unknown.length)
    problems.push(
      `${unknown.map((name) => `"${name}"`).join(', ')} ${unknown.length === 1 ? 'is not a column' : 'are not columns'} of a hazard register. The columns: ${known.join(', ')}.`,
    );
  for (const required of ['id', 'hazard', 'consequence', 'owner'])
    if (!lower.has(required.toLowerCase())) problems.push(`The column "${required}" is missing.`);
  if (problems.length) return { items: [], problems, assessments: [] };
  const value = (row: Record<string, string>, name: string) => row[lower.get(name.toLowerCase()) ?? ''] ?? '';
  const items: DraftItem[] = [];
  const assessments: AssessmentRow[] = [];
  const seen = new Set<string>();
  rows.forEach((row) => {
    const reference = value(row, 'id');
    const rowProblems = [...referenceProblems(reference)];
    if (reference && seen.has(reference)) rowProblems.push(`Two rows have the id ${reference}.`);
    seen.add(reference);
    const description = value(row, 'hazard');
    const consequence = value(row, 'consequence');
    const operation = value(row, 'operation');
    const title = value(row, 'title') || shortTitle(description);
    const owner = personId(context, value(row, 'owner'), 'owner');
    const raised = value(row, 'raised');
    const reviewDue = value(row, 'reviewDue');
    const controlsFrom = value(row, 'controlsFrom') || raised || context.today;
    rowProblems.push(
      ...lengthProblem('the hazard', description, 8000),
      ...lengthProblem('the consequence', consequence, 4000),
      ...lengthProblem('the operation', operation, 200, false),
      ...(title ? lengthProblem('the title', title, 200) : []),
      ...(owner.problem ? [owner.problem] : []),
      ...dateProblem('raised', raised),
      ...dateProblem('reviewDue', reviewDue),
      ...dateProblem('controlsFrom', controlsFrom),
    );
    const body: HazardBody = {
      description,
      consequence,
      ...(operation ? { operation } : {}),
      source: { kind: 'manual_identification', ...(raised ? { reference: `Raised ${raised}` } : {}) },
    };
    const dueAt = reviewDue ? instantOf(reviewDue, context.zone, 'end') : undefined;
    items.push({
      kind: 'hazard',
      reference,
      name: `Hazard ${reference}`,
      problems: rowProblems,
      ...(rowProblems.length
        ? {}
        : {
            draft: {
              kind: 'hazard',
              schema: 'sms.hazard.1',
              title,
              ownerId: owner.id!,
              ...(dueAt ? { dueAt } : {}),
              body,
            } as SmsRecordDraft,
          }),
    });
    const effectiveFrom = instantOf(controlsFrom, context.zone, 'start');
    value(row, 'controls')
      .split(';')
      .map((measure) => measure.trim())
      .filter(Boolean)
      .forEach((measure, index) => {
        const controlProblems = [
          ...lengthProblem('the measure', measure, 1000),
          ...(rowProblems.length ? [`Hazard ${reference || '(no id)'} has problems.`] : []),
        ];
        items.push({
          kind: 'control',
          reference: `${reference}/${index + 1}`,
          name: `Control ${reference}/${index + 1}`,
          hazardReference: reference,
          problems: controlProblems,
          ...(controlProblems.length || !effectiveFrom
            ? {}
            : {
                draft: {
                  kind: 'control',
                  schema: 'sms.control.1',
                  title: shortTitle(measure),
                  ownerId: owner.id!,
                  body: {
                    hazardId: '',
                    controlType: { ...PLAIN_CONTROL_TYPE, digest: '' },
                    parameters: { measure },
                    effectiveFrom,
                  },
                } as SmsRecordDraft,
              }),
        });
      });
    const position = (severity: string, likelihood: string) =>
      severity || likelihood ? { severity, likelihood } : null;
    assessments.push({
      reference,
      initial: position(value(row, 'severityBefore'), value(row, 'likelihoodBefore')),
      residual: position(value(row, 'severityAfter'), value(row, 'likelihoodAfter')),
      newHazards: value(row, 'newHazards'),
    });
  });
  if (!rows.length) problems.push('The file has a heading row and no hazards.');
  return { items, problems, assessments };
}

/** A position named by the matrix's ids or labels, as the matrix's ids. */
export function matrixPosition(
  matrix: RiskMatrixBody,
  given: { severity: string; likelihood: string },
): { position?: { severity: string; likelihood: string }; problem?: string } {
  const severity = byIdOrLabel(matrix.severities, given.severity);
  const likelihood = byIdOrLabel(matrix.likelihoods, given.likelihood);
  if (!severity) return { problem: `${given.severity || 'No severity'} is not a severity of “${matrix.name}”.` };
  if (!likelihood)
    return { problem: `${given.likelihood || 'No likelihood'} is not a likelihood of “${matrix.name}”.` };
  return { position: { severity: severity.id, likelihood: likelihood.id } };
}

// ---- document

const documentKeys = [
  'id',
  'title',
  'type',
  'owner',
  'number',
  'revision',
  'summary',
  'changeReason',
  'reviewDue',
  'purposes',
] as const;

export function readDocument(content: string, context: FileContext): ReadFile {
  const { values, text: documentText } = frontMatter(content);
  const reference = text(values.id);
  const title = text(values.title);
  const type = text(values.type);
  const summary = text(values.summary);
  const changeReason = text(values.changeReason);
  const revision = text(values.revision);
  const number = text(values.number);
  const reviewDue = text(values.reviewDue);
  const purposes = list(values.purposes).map(text).filter(Boolean);
  const owner = personId(context, text(values.owner), 'owner');
  const problems = [
    ...referenceProblems(reference),
    ...unknownKeys(values, documentKeys),
    ...lengthProblem('the title', title, 200),
    ...(type && (documentTypeValues as readonly string[]).includes(type)
      ? []
      : [`Give the type: one of ${documentTypeValues.join(', ')}.`]),
    ...lengthProblem('the summary', summary, 2000),
    ...lengthProblem('the reason for this revision (changeReason)', changeReason, 2000),
    ...lengthProblem('the revision', revision, 40, false),
    ...lengthProblem('the number', number, 80, false),
    ...lengthProblem('the text after the stated values', documentText, 100000),
    ...dateProblem('reviewDue', reviewDue),
    ...(owner.problem ? [owner.problem] : []),
  ];
  const reviewDueAt = reviewDue ? instantOf(reviewDue, context.zone, 'end') : undefined;
  const body: DocumentBodyV2 = {
    origin: 'authored',
    documentType: type as DocumentBodyV2['documentType'],
    summary,
    text: documentText,
    changeReason,
    ...(revision ? { revisionLabel: revision } : {}),
    ...(number ? { documentNumber: number } : {}),
    ...(reviewDueAt ? { reviewDueAt } : {}),
    ...(purposes.length ? { purposes } : {}),
  };
  const item: DraftItem = { kind: 'document', reference, name: `Document ${reference}`, problems };
  if (!problems.length)
    item.draft = { kind: 'document', schema: 'sms.document.2', title, ownerId: owner.id!, body } as SmsRecordDraft;
  return { items: [item], problems: [], assessments: [] };
}

// ---- safety assurance record

const assuranceKeys = [
  'id',
  'title',
  'owner',
  'type',
  'performedOn',
  'completedOn',
  'scope',
  'examined',
  'findings',
  'actions',
  'occurredOn',
  'fromReport',
  'system',
  'counterpart',
] as const;

export function readAssurance(content: string, path: string, context: FileContext): ReadFile {
  const values = structured(content, path);
  const reference = text(values.id);
  const title = text(values.title);
  const type = text(values.type);
  const owner = personId(context, text(values.owner), 'owner');
  const problems = [
    ...referenceProblems(reference),
    ...unknownKeys(values, assuranceKeys),
    ...lengthProblem('the title', title, 200),
    ...(owner.problem ? [owner.problem] : []),
  ];
  if (!(assuranceTypeValues as readonly string[]).includes(type))
    problems.push(`Give the type: one of ${assuranceTypeValues.join(', ')}.`);
  const findings = list(values.findings).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return { id: text(item.id), text: text(item.text) };
  });
  const actions = list(values.actions).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const actionOwner = personId(context, text(item.owner), `owner of action ${text(item.id)}`);
    if (actionOwner.problem) problems.push(actionOwner.problem);
    const finding = text(item.finding);
    return {
      id: text(item.id),
      what: text(item.what),
      ownerId: actionOwner.id ?? '',
      dueOn: text(item.due),
      ...(finding ? { findingId: finding } : {}),
    };
  });
  for (const finding of findings)
    problems.push(
      ...(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(finding.id)
        ? []
        : [`A finding's id is up to 20 letters and digits, such as F1: ${finding.id || '(none)'}.`]),
      ...lengthProblem(`the text of finding ${finding.id}`, finding.text, 4000),
    );
  for (const action of actions)
    problems.push(
      ...(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(action.id)
        ? []
        : [`An action's id is up to 20 letters and digits, such as A1: ${action.id || '(none)'}.`]),
      ...lengthProblem(`what action ${action.id} is to do (what)`, action.what, 2000),
    );
  const optional = (name: string) => (text(values[name]) ? { [name]: text(values[name]) } : {});
  const body = {
    assuranceType: type,
    performedOn: text(values.performedOn),
    ...optional('completedOn'),
    scope: text(values.scope),
    examined: text(values.examined),
    findings,
    actions,
    ...optional('occurredOn'),
    ...optional('fromReport'),
    ...optional('system'),
    ...optional('counterpart'),
  } as AssuranceBody;
  problems.push(
    ...lengthProblem('the scope', body.scope, 4000),
    ...lengthProblem('what it examined (examined)', body.examined, 8000),
  );
  if ((assuranceTypeValues as readonly string[]).includes(type))
    problems.push(...assuranceBodyProblems(body, context.today));
  const item: DraftItem = { kind: 'assurance', reference, name: `Safety assurance record ${reference}`, problems };
  if (!problems.length)
    item.draft = { kind: 'assurance', schema: 'sms.assurance.1', title, ownerId: owner.id!, body } as SmsRecordDraft;
  return { items: [item], problems: [], assessments: [] };
}

// ---- safety report

const reportKeys = [
  'id',
  'title',
  'owner',
  'received',
  'receivedAt',
  'occurredAt',
  'operation',
  'site',
  'reporterName',
  'reporterContact',
] as const;

/**
 * A safety report received before Ledger. Its problems never quote its title, narrative or reporter, since they are
 * readable only by people cleared to read reports.
 */
export function readReport(content: string, context: FileContext): ReadFile {
  const { values, text: narrative } = frontMatter(content);
  const reference = text(values.id);
  const channel = text(values.received);
  const receivedAt = text(values.receivedAt);
  const occurredAt = text(values.occurredAt);
  const operation = text(values.operation);
  const site = text(values.site);
  const reporterName = text(values.reporterName);
  const reporterContact = text(values.reporterContact);
  const title = text(values.title) || `Safety report ${reference}`;
  const owner = personId(context, text(values.owner), 'owner');
  const length = (what: string, value: string, max: number) =>
    value.length > max ? [`${capitalized(what)} has more than ${max} characters.`] : [];
  const problems = [
    ...referenceProblems(reference),
    ...unknownKeys(values, reportKeys),
    ...(owner.problem ? [owner.problem] : []),
    ...((recordedReportChannelValues as readonly string[]).includes(channel)
      ? []
      : [`Give how it was received (received): one of ${recordedReportChannelValues.join(', ')}.`]),
    ...(narrative ? length('the narrative', narrative, 8000) : ['Give the narrative after the stated values.']),
    ...length('the title', title, 200),
    ...length('the operation', operation, 200),
    ...length('the site', site, 200),
    ...length("the reporter's name", reporterName, 200),
    ...length("the reporter's contact", reporterContact, 200),
    ...(receivedAt && !instantOf(receivedAt, context.zone, 'start')
      ? ['receivedAt is a date such as 2026-06-01 or a time with its offset.']
      : []),
    ...(occurredAt && !instantOf(occurredAt, context.zone, 'start')
      ? ['occurredAt is a date such as 2026-06-01 or a time with its offset.']
      : []),
  ];
  const receivedInstant = receivedAt ? instantOf(receivedAt, context.zone, 'start') : undefined;
  const occurredInstant = occurredAt ? instantOf(occurredAt, context.zone, 'start') : undefined;
  const body: ReportBody = {
    narrative,
    ...(occurredInstant ? { occurredAt: occurredInstant } : {}),
    ...(operation ? { operation } : {}),
    ...(site ? { siteReference: site } : {}),
    received: {
      channel: channel as ReportBody['received']['channel'],
      ...(receivedInstant ? { receivedAt: receivedInstant } : {}),
    },
    ...(reporterName || reporterContact
      ? {
          reporter: {
            ...(reporterName ? { name: reporterName } : {}),
            ...(reporterContact ? { contact: reporterContact } : {}),
          },
        }
      : {}),
  };
  const item: DraftItem = {
    kind: 'report',
    reference,
    name: `Safety report ${reference}`,
    confidentiality: 'safety_report',
    problems,
  };
  if (!problems.length) item.draft = { kind: 'report', schema: 'sms.report.1', title, ownerId: owner.id!, body };
  return { items: [item], problems: [], assessments: [] };
}

export function readSafetyFile(kind: SafetyFileKind, content: string, path: string, context: FileContext): ReadFile {
  if (kind === 'matrix') return readMatrix(content, path, context);
  if (kind === 'hazards') return readHazards(content, context);
  if (kind === 'document') return readDocument(content, context);
  if (kind === 'assurance') return readAssurance(content, path, context);
  return readReport(content, context);
}

// ---- templates

export const safetyTemplates: Record<SafetyFileKind, { file: string; text: string }> = {
  matrix: {
    file: 'risk-matrix.yaml',
    text: `# A risk matrix, in your own words. Levels go from least to most serious; "acceptance" says who may accept a
# risk at that level: low, medium or high (the risk acceptance a person holds on the People screen) or not_acceptable.
id: RM-1
owner: Avery Example
name: Example risk matrix
severities: # least to most severe
  - { id: negligible, label: Negligible, description: No damage; delay only. }
  - { id: minor, label: Minor, description: Repairable damage. }
  - { id: serious, label: Serious, description: Aircraft lost inside the site. }
  - { id: major, label: Major, description: Injury or aircraft lost outside the site. }
  - { id: catastrophic, label: Catastrophic, description: Death or serious injury. }
likelihoods: # least to most likely
  - { id: not_expected, label: Not expected, description: Not expected in the life of the program. }
  - { id: unlikely, label: Unlikely, description: Has happened somewhere in the industry. }
  - { id: now_and_then, label: Now and then, description: Could happen in the next few years. }
  - { id: likely, label: Likely, description: About once a year. }
  - { id: regular, label: Regular, description: Several times a year. }
levels:
  - { id: green, label: Green, meaning: Carry on. Review yearly., acceptance: low }
  - { id: yellow, label: Yellow, meaning: Acceptable with written sign-off., acceptance: high }
  - { id: red, label: Red, meaning: Stop the affected operation., acceptance: not_acceptable }
grid: # one row per likelihood; one level per severity, least to most severe
  not_expected: [green, green, green, green, yellow]
  unlikely: [green, green, yellow, yellow, yellow]
  now_and_then: [green, yellow, yellow, yellow, red]
  likely: [green, yellow, yellow, red, red]
  regular: [yellow, yellow, red, red, red]
`,
  },
  hazards: {
    file: 'hazards.csv',
    text: `${hazardColumns.map(([name]) => name).join(',')}
H-001,Loss of the control link,Loss of the control link beyond visual range,Fly-away outside the site,,Avery Example,2026-03-02,2027-03-01,"Lost-link return programmed and verified each flight; dual control link",2026-03-02,major,now_and_then,serious,unlikely,none
`,
  },
  document: {
    file: 'safety-policy.md',
    text: `---
id: POL-1
title: Safety policy
type: safety_policy
owner: Avery Example
number: POL-1
revision: "1"
summary: The organization's commitment to safety and who is accountable for it.
changeReason: First issue in Ledger of the policy in force.
reviewDue: 2027-01-15
---
The text of the document, as it is in force.
`,
  },
  assurance: {
    file: 'audit.yaml',
    text: `# A safety assurance record: an audit, a review or an investigation, with its findings and the actions it sets.
id: IA-1
title: Internal audit 1
owner: Avery Example
type: audit # ${assuranceTypeValues.join(', ')}
performedOn: 2026-02-10
completedOn: 2026-02-12
scope: Operations against the waiver and the operations manual.
examined: Flight records, training records and two flights observed.
findings:
  - { id: F1, text: Two preflight checklists were not signed. }
actions:
  - { id: A1, what: Brief every pilot on signing the checklist., owner: Avery Example, due: 2026-03-15, finding: F1 }
`,
  },
  report: {
    file: 'safety-report.md',
    text: `---
id: SR-1
owner: Avery Example
received: email # ${recordedReportChannelValues.join(', ')}
receivedAt: 2026-10-08
occurredAt: 2026-10-07
---
What the reporter wrote, as they wrote it.
`,
  },
};
