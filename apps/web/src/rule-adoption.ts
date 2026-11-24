import { revisionCommand } from '@ledger/contracts';
import type {
  AdoptionMode,
  AdoptionParameterValues,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  PackAdoptionRecord,
  RuleAdoptionParameter,
  RulePackSummary,
  RulePackVersion,
  RuleEvaluationRecord,
  SubjectFindingRecord,
} from '@ledger/contracts';

export { adoptionCommand, successorCommand } from '@ledger/contracts';

export const modeLabels: Record<AdoptionMode, string> = {
  active: 'Active: findings counted',
  shadow: 'Shadow: findings recorded, not counted',
};

/** The plain-word label every shadow result carries. */
export const proposedLabel = 'Proposed rule: recorded, not counted';

/** Why a pack can be adopted only in shadow, or null when either mode is open to it. */
export function shadowOnlyReason(pack: RulePackVersion): string | null {
  return pack.leaves.some((leaf) => leaf.source.kind === 'proposed_regulation')
    ? 'This pack quotes proposed rule text, which is not in force. It can be adopted only in shadow: its findings are recorded and shown as proposed, never counted in what a person attests to.'
    : null;
}

/** Why a pack can be adopted only as active, or null. Rules the built-in flight evaluator runs record no mode. */
export function activeOnlyReason(pack: RulePackVersion): string | null {
  return pack.leaves.some((leaf) => 'bindingId' in leaf)
    ? 'This pack has rules the built-in flight evaluator runs, which cannot record findings in shadow. It can be adopted only as active.'
    : null;
}

/** The modes a person may choose for a pack, most cautious first. */
export function allowedModes(pack: RulePackVersion): AdoptionMode[] {
  if (shadowOnlyReason(pack)) return ['shadow'];
  if (activeOnlyReason(pack)) return ['active'];
  return ['shadow', 'active'];
}

export interface ParameterField {
  leafId: string;
  leafTitle: string;
  parameter: RuleAdoptionParameter;
}

/** Every value the pack's rules ask the adopting organization to supply, in the order the pack declares them. */
export function parameterFields(pack: RulePackVersion): ParameterField[] {
  return pack.leaves.flatMap((leaf) =>
    'adoptionParameters' in leaf
      ? leaf.adoptionParameters.map((parameter) => ({ leafId: leaf.id, leafTitle: leaf.title, parameter }))
      : [],
  );
}

/** The typed value of one form entry, or undefined when the entry is not a valid value for the parameter. */
export function parameterValue(parameter: RuleAdoptionParameter, entry: string): string | number | boolean | undefined {
  if (parameter.valueType === 'boolean') return entry === 'true' ? true : entry === 'false' ? false : undefined;
  if (parameter.valueType === 'string') {
    if (!entry) return undefined;
    return !parameter.options || parameter.options.includes(entry) ? entry : undefined;
  }
  if (!entry.trim()) return undefined;
  const value = Number(entry);
  if (!Number.isFinite(value) || (parameter.valueType === 'integer' && !Number.isSafeInteger(value))) return undefined;
  if (parameter.minimum !== undefined && value < parameter.minimum) return undefined;
  if (parameter.maximum !== undefined && value > parameter.maximum) return undefined;
  return value;
}

export function fieldKey(field: Pick<ParameterField, 'leafId'> & { parameter: { name: string } }): string {
  return `${field.leafId}/${field.parameter.name}`;
}

/** One value the form asks for once: a parameter several rules declare alike, and the fields it fills. */
export interface ParameterQuestion {
  key: string;
  parameter: RuleAdoptionParameter;
  fields: ParameterField[];
}

/**
 * The values to ask for, each once: rules that declare the same parameter alike (name, title, type, options and
 * bounds) share one answer, in the order the pack first declares it.
 */
export function parameterQuestions(fields: readonly ParameterField[]): ParameterQuestion[] {
  const questions = new Map<string, ParameterQuestion>();
  for (const field of fields) {
    const { name, title, valueType, options, minimum, maximum } = field.parameter;
    const key = JSON.stringify([name, title, valueType, options ?? null, minimum ?? null, maximum ?? null]);
    const question = questions.get(key);
    if (question) question.fields.push(field);
    else questions.set(key, { key, parameter: field.parameter, fields: [field] });
  }
  return [...questions.values()];
}

/** The form entries with one question's answer given to every field it fills. */
export function answered(
  entries: Readonly<Record<string, string>>,
  question: ParameterQuestion,
  value: string,
): Record<string, string> {
  return { ...entries, ...Object.fromEntries(question.fields.map((field) => [fieldKey(field), value])) };
}

/** The parameter values for the command, or the first field whose entry is missing or invalid. */
export function parameterValues(
  fields: readonly ParameterField[],
  entries: Readonly<Record<string, string>>,
): { values?: AdoptionParameterValues; invalid?: ParameterField } {
  const values: AdoptionParameterValues = {};
  for (const field of fields) {
    const value = parameterValue(field.parameter, entries[fieldKey(field)] ?? '');
    if (value === undefined) return { invalid: field };
    values[field.leafId] = { ...(values[field.leafId] ?? {}), [field.parameter.name]: value };
  }
  return fields.length ? { values } : {};
}

/** A revision that changes only the mode of an adoption; pack, interval and parameters stay as adopted. */
export function modeChangeCommand(
  shown: OrganizationCoverageResponse,
  adoption: PackAdoptionRecord,
  mode: AdoptionMode,
  note: string,
): PackAdoptionCommand {
  return revisionCommand(shown, adoption, { mode, note });
}

/** True when a person may change this adoption's mode: it is the latest revision and the pack allows the other mode. */
export function canChangeMode(adoption: PackAdoptionRecord): boolean {
  const other: AdoptionMode = adoption.mode === 'active' ? 'shadow' : 'active';
  return (
    !adoption.revisedBy &&
    !adoption.succeededBy &&
    adoption.processing.status === 'projected' &&
    (adoption.state === 'effective' || adoption.state === 'scheduled') &&
    allowedModes(adoption.pack).includes(other)
  );
}

/** Findings split by the mode of their latest evaluation: counted ones, and proposed ones recorded but not counted. */
export function findingsByMode(findings: readonly SubjectFindingRecord[]): {
  counted: SubjectFindingRecord[];
  proposed: SubjectFindingRecord[];
  relieved: SubjectFindingRecord[];
} {
  const relieved = (finding: SubjectFindingRecord) => finding.latestEvaluation.outcome === 'relieved';
  return {
    counted: findings.filter((finding) => finding.mode === 'active' && !relieved(finding)),
    proposed: findings.filter((finding) => finding.mode === 'shadow' && !relieved(finding)),
    relieved: findings.filter(relieved),
  };
}

/** The plain-word label every relieved result carries. */
export const relievedLabel = 'Relieved by a waiver: recorded, not counted';

/**
 * The latest evaluation of each rule (and related subject) among evaluations listed newest first, where that latest
 * evaluation is relieved: what a subject's screen lists under relieved, finding or not.
 */
export function latestRelieved(evaluations: readonly RuleEvaluationRecord[]): RuleEvaluationRecord[] {
  const latest = new Map<string, RuleEvaluationRecord>();
  for (const evaluation of evaluations) {
    const key = JSON.stringify([evaluation.pack.id, evaluation.rule.id, evaluation.related?.subjectKey ?? '']);
    if (!latest.has(key)) latest.set(key, evaluation);
  }
  return [...latest.values()].filter((evaluation) => evaluation.outcome === 'relieved');
}

/**
 * The catalogue as the adopt form offers it: the latest version of each pack, the organization's own files first and
 * then those built into Ledger (a group with nothing in it is left out), and every earlier version apart.
 */
export function offeredPacks(catalog: readonly RulePackSummary[]): {
  latest: { label: string; packs: RulePackSummary[] }[];
  earlier: RulePackSummary[];
} {
  const latest = new Map<string, number>();
  for (const pack of catalog) latest.set(pack.packId, Math.max(latest.get(pack.packId) ?? 0, pack.version));
  const isLatest = (pack: RulePackSummary) => latest.get(pack.packId) === pack.version;
  const own = (pack: RulePackSummary) => pack.origin.kind !== 'built_in';
  return {
    latest: [
      { label: 'Your organization’s files', packs: catalog.filter((pack) => own(pack) && isLatest(pack)) },
      { label: 'Built into Ledger', packs: catalog.filter((pack) => !own(pack) && isLatest(pack)) },
    ].filter((group) => group.packs.length > 0),
    // Offered behind a disclosure: an organization adopts the latest version unless it has a reason not to.
    earlier: catalog.filter((pack) => !isLatest(pack)),
  };
}

/**
 * The entries an adopt form starts with: a value a check takes under the name timeZone starts as the organization's
 * own zone, which the person adopting may change.
 */
export function startingEntries(fields: readonly ParameterField[], zone: string): Record<string, string> {
  return Object.fromEntries(
    fields
      .filter(
        ({ parameter }) => parameter.name === 'timeZone' && parameter.valueType === 'string' && !parameter.options,
      )
      .map((field) => [fieldKey(field), zone]),
  );
}

/** The rules of other packs a pack's rules relieve while it is adopted as active, by the relieving rule. */
export function packReliefs(pack: RulePackVersion): { leafId: string; packId: string; ruleIds: string[] }[] {
  return pack.leaves.flatMap((leaf) =>
    'relieves' in leaf && leaf.relieves
      ? leaf.relieves.map((relief) => ({ leafId: leaf.id, packId: relief.packId, ruleIds: [...relief.ruleIds] }))
      : [],
  );
}

/** Where a pack in the catalogue came from, in the words the adopt form shows beside it. */
export function packOriginLabel(origin: RulePackSummary['origin']): string {
  return origin.kind === 'built_in' ? 'built into Ledger' : `organization file ${origin.file}`;
}

/**
 * The newest registered version of the adoption's pack when it is newer and the adoption may be succeeded by it: the
 * adoption is the latest revision, in effect, and no later version succeeds it yet. Otherwise null.
 */
export function newerVersion(adoption: PackAdoptionRecord, catalog: readonly RulePackSummary[]): number | null {
  if (
    adoption.revisedBy ||
    adoption.succeededBy ||
    adoption.processing.status !== 'projected' ||
    adoption.state !== 'effective'
  )
    return null;
  const newest = Math.max(
    ...catalog.filter((item) => item.packId === adoption.pack.packId).map((item) => item.version),
  );
  return newest > adoption.pack.version ? newest : null;
}

export interface VersionChanges {
  added: RulePackVersion['leaves'];
  removed: RulePackVersion['leaves'];
  changed: RulePackVersion['leaves'];
  parameters: ParameterField[];
}

/** What adopting the newer version changes: rules added, removed and changed by id, and the values it asks for. */
export function versionChanges(from: RulePackVersion, to: RulePackVersion): VersionChanges {
  const before = new Map(from.leaves.map((leaf) => [leaf.id, leaf]));
  const after = new Set(to.leaves.map((leaf) => leaf.id));
  return {
    added: to.leaves.filter((leaf) => !before.has(leaf.id)),
    removed: from.leaves.filter((leaf) => !after.has(leaf.id)),
    changed: to.leaves.filter((leaf) => before.has(leaf.id) && before.get(leaf.id)!.digest !== leaf.digest),
    parameters: parameterFields(to),
  };
}

/** Form entries for the newer version, filled from the values the earlier adoption supplied under the same names. */
export function carriedEntries(
  fields: readonly ParameterField[],
  adoption: PackAdoptionRecord,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const field of fields) {
    const value = adoption.parameters?.[field.leafId]?.[field.parameter.name];
    if (value !== undefined) entries[fieldKey(field)] = String(value);
  }
  return entries;
}

const DAY_MS = 86_400_000;

/** The offset of a time zone from UTC at an instant, in milliseconds. */
function zoneOffset(at: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return local - Math.floor(at / 1000) * 1000;
}

/** The instant a calendar date (year-month-day) starts in a time zone. */
export function dayStartIn(date: string, zone: string): number {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const first = midnight - zoneOffset(midnight, zone);
  return midnight - zoneOffset(first, zone);
}

/** The calendar date an instant falls on in a time zone, year-month-day. */
function dateIn(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    at,
  );
}

/** A calendar date as a person reads it, such as "May 31, 2028". */
export function calendarDateWords(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(
    Date.parse(`${date}T00:00:00Z`),
  );
}

/** The calendar day a number of days after a day, year-month-day. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The days an adopt form starts with, in the organization's zone: a waiver's stated dates, else today and the day a
 * year later.
 */
export function startingDays(
  waiver: RulePackVersion['waiver'] | undefined,
  now: number,
  zone: string,
): { from: string; through: string } {
  if (waiver) return { from: waiver.effective.from, through: waiver.effective.through };
  const today = dateIn(now, zone);
  return { from: today, through: addDays(today, 364) };
}

const calendarDay = /^(\d{4})-(\d{2})-(\d{2})$/;
const realDay = (date: string) => calendarDay.test(date) && addDays(date, 0) === date;

/**
 * The adoption dates a person chose as days in the organization's zone, read as the command-line client reads them:
 * from the start of the first day to the end of the last. A problem in plain words when they are not two days in order.
 */
export function adoptionDays(
  from: string,
  through: string,
  zone: string,
): { interval: PackAdoptionCommand['effectiveInterval'] } | { problem: string } {
  if (!realDay(from)) return { problem: 'Choose the day the adoption starts.' };
  if (!realDay(through)) return { problem: 'Choose the last day of the adoption.' };
  if (through < from) return { problem: 'The last day is before the first day.' };
  return {
    interval: {
      start: new Date(dayStartIn(from, zone)).toISOString(),
      end: new Date(dayStartIn(addDays(through, 1), zone)).toISOString(),
    },
  };
}

/** What the adoption's dates mean, under the fields that set them. */
export function adoptionDaysSentence(from: string, through: string, zone: string): string {
  return `The rules cover flights and records inside these dates: from the start of ${calendarDateWords(from)} to the end of ${calendarDateWords(through)}, in ${zone}. Anything recorded about a time before or after them is not counted under this adoption.`;
}

/**
 * What a waiver states about its own dates, said against today in the organization's zone. It reports the
 * certificate's words; it never says whether the waiver is in effect.
 */
export function statedDatesSentence(waiver: NonNullable<RulePackVersion['waiver']>, now: number, zone: string): string {
  const { from, through } = waiver.effective;
  const today = dateIn(now, zone);
  const days = Math.round((Date.parse(`${through}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  const certificate = 'The certificate';
  if (days < 0)
    return `${certificate} states it is effective through ${calendarDateWords(through)}. That date has passed.`;
  const starts = today < from ? `from ${calendarDateWords(from)} ` : '';
  const remaining = days === 0 ? 'today is the last day it states' : `${days} day${days === 1 ? '' : 's'} from today`;
  return `${certificate} states it is effective ${starts}through ${calendarDateWords(through)}, ${remaining}.`;
}
