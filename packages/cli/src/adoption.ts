import { randomUUID } from 'node:crypto';
import {
  adoptionCommand,
  adoptionStands,
  overlappingAdoptions,
  revisionCommand,
  successorCommand,
  zonedInstantText,
  type AdoptionMode,
  type AdoptionParameterValues,
  type Command,
  type CurrentPrincipalResponse,
  type OrganizationCoverageResponse,
  type PackAdoptionCommand,
  type PackAdoptionRecord,
  type RuleAdoptionParameter,
  type RulePackVersion,
} from '@ledger/contracts';
import { readPack, RefusalError, UsageError, type Context, type Output } from './commands.js';
import { shortRuleId } from './format.js';
import { onFreshBasis } from './fresh-basis.js';
import { personSendsIt, refuseUnlessPerson } from './persons-decision.js';
import { checkedByLabels, leafCheckedBy, modeWords } from './words.js';

export interface AdoptionRequest {
  packId: string;
  version?: number;
  mode?: string;
  from?: string;
  until?: string;
  /** `<rule id>.<name>=<value>`, the rule id whole or after the pack id. */
  set: string[];
  /** `<name>=<value>` for every rule that asks for that name. */
  setAll: string[];
  /** The person's own reason. Without it nothing is sent. */
  reason?: string;
}

/** Milliseconds a zone is ahead of UTC at an instant. */
function zoneOffset(instant: number, zone: string): number {
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
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - instant;
}

/** The instant a calendar day starts in a zone. */
export function startOfDay(year: number, month: number, day: number, zone: string): string {
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall - zoneOffset(wall, zone);
  instant = wall - zoneOffset(instant, zone);
  return new Date(instant).toISOString();
}

/**
 * A date as the person gave it: a calendar day in the organization's zone (from its start; until its end), or an
 * exact time with its offset.
 */
export function adoptionInstant(
  text: string,
  zone: string,
  edge: 'from' | 'until',
): { instant: string; words: string } {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const check = new Date(Date.UTC(year, month - 1, date));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date)
      throw new UsageError(`${text} is not a date.`);
    const instant = edge === 'from' ? startOfDay(year, month, date, zone) : startOfDay(year, month, date + 1, zone);
    return {
      instant,
      words: `${edge === 'from' ? 'the start' : 'the end'} of ${text} in ${zone} (${instant})`,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text.trim()))
    throw new UsageError(
      `--${edge} is a date such as 2026-06-01 (in your organization's time zone) or a time with its offset such as 2026-06-01T06:00:00Z: ${text}`,
    );
  const instant = new Date(text.trim()).toISOString();
  return { instant, words: instant };
}

function parseValue(parameter: RuleAdoptionParameter, text: string): string | number | boolean {
  if (parameter.valueType === 'boolean') {
    if (/^(true|yes)$/i.test(text)) return true;
    if (/^(false|no)$/i.test(text)) return false;
    throw new UsageError(`${parameter.name} is true or false: ${text}`);
  }
  if (parameter.valueType === 'number' || parameter.valueType === 'integer') {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || (parameter.valueType === 'integer' && !Number.isInteger(value)))
      throw new UsageError(
        `${parameter.name} is ${parameter.valueType === 'integer' ? 'a whole number' : 'a number'}: ${text}`,
      );
    return value;
  }
  return text;
}

function assignment(text: string, flag: string): [string, string] {
  const split = text.indexOf('=');
  if (split < 1) throw new UsageError(`${flag} is <name>=<value>: ${text}`);
  return [text.slice(0, split).trim(), text.slice(split + 1)];
}

interface ChosenValue {
  leafId: string;
  ruleTitle: string;
  parameter: RuleAdoptionParameter;
  value: string | number | boolean;
  from: string;
}

/** Values an earlier adoption supplied, carried to the rules that ask for them under the same rule and name. */
export interface CarriedValues {
  values: AdoptionParameterValues;
  /** Where they came from, in the words the printout gives after a carried value. */
  from: string;
}

/**
 * Every value the pack asks for, from --set, then --set-all, then the values carried from the adoption this one
 * replaces, then the organization's zone for a timeZone.
 */
export function chooseValues(
  pack: RulePackVersion,
  set: readonly string[],
  setAll: readonly string[],
  timeZone: string,
  carried?: CarriedValues,
): ChosenValue[] {
  const asked = pack.leaves.flatMap((leaf) =>
    'adoptionParameters' in leaf ? leaf.adoptionParameters.map((parameter) => ({ leaf, parameter })) : [],
  );
  const specific = new Map<string, string>();
  for (const text of set) {
    const [key, value] = assignment(text, '--set');
    const dot = key.lastIndexOf('.');
    if (dot < 1) throw new UsageError(`--set is <rule id>.<name>=<value>: ${text}`);
    const [rule, name] = [key.slice(0, dot), key.slice(dot + 1)];
    const match = asked.find(
      ({ leaf, parameter }) =>
        parameter.name === name && (leaf.id === rule || shortRuleId(pack.packId, leaf.id) === rule),
    );
    if (!match)
      throw new UsageError(
        `No rule of ${pack.packId} asks for ${key}. pnpm ledger packs show ${pack.packId} lists what each asks for.`,
      );
    specific.set(`${match.leaf.id}\u0000${name}`, value);
  }
  const everywhere = new Map(setAll.map((text) => assignment(text, '--set-all')));
  for (const name of everywhere.keys())
    if (!asked.some(({ parameter }) => parameter.name === name))
      throw new UsageError(`No rule of ${pack.packId} asks for ${name}.`);
  const missing: string[] = [];
  const chosen: ChosenValue[] = [];
  for (const { leaf, parameter } of asked) {
    const own = specific.get(`${leaf.id}\u0000${parameter.name}`);
    const shared = everywhere.get(parameter.name);
    const kept = carried?.values[leaf.id]?.[parameter.name];
    const text = own ?? shared;
    if (text === undefined && kept !== undefined) {
      chosen.push({ leafId: leaf.id, ruleTitle: leaf.title, parameter, value: kept, from: carried!.from });
      continue;
    }
    const given = text ?? (parameter.name === 'timeZone' ? timeZone : undefined);
    if (given === undefined) {
      missing.push(
        `${shortRuleId(pack.packId, leaf.id)}.${parameter.name} (${parameter.title}${parameter.options ? `; one of ${parameter.options.join(', ')}` : ''})`,
      );
      continue;
    }
    chosen.push({
      leafId: leaf.id,
      ruleTitle: leaf.title,
      parameter,
      value: parseValue(parameter, given),
      from: own !== undefined ? '--set' : shared !== undefined ? '--set-all' : "your organization's time zone",
    });
  }
  if (missing.length)
    throw new UsageError(
      `The pack asks for values you have not given. Give each with --set <rule>.<name>=<value>, or one value for every rule with --set-all <name>=<value>:\n  ${missing.join('\n  ')}`,
    );
  return chosen;
}

function parameterValues(chosen: readonly ChosenValue[]): AdoptionParameterValues | undefined {
  const values: AdoptionParameterValues = {};
  for (const item of chosen) (values[item.leafId] ??= {})[item.parameter.name] = item.value;
  return chosen.length ? values : undefined;
}

type Interval = PackAdoptionCommand['effectiveInterval'];

/** What adopting the pack does to what the organization has adopted already. */
export type AdoptionAction =
  | { kind: 'adopt' }
  /** A later version replaces the earlier adoption from the new start; the earlier one ends there. */
  | { kind: 'succeed'; earlier: PackAdoptionRecord }
  /** The same version again with a new mode, dates or values; the revision replaces the adoption whole. */
  | { kind: 'revise'; adoption: PackAdoptionRecord; changes: string[] };

export interface AdoptionPlan {
  action: AdoptionAction;
  mode: AdoptionMode;
  interval: Interval;
  chosen: ChosenValue[];
  /** The lines that say when the adoption is in effect and what it replaces. */
  lines: string[];
}

/** An instant in the organization's zone with the zone's name, as every adoption date is printed. */
function zoned(instant: string, zone: string): string {
  return zonedInstantText(instant, zone) ?? instant;
}

function intervalWords(interval: Interval, zone: string): string {
  return `from ${zoned(interval.start, zone)} until ${zoned(interval.end, zone)}`;
}

function adoptionWords(adoption: PackAdoptionRecord, zone: string): string {
  return `adoption ${adoption.id} of ${adoption.pack.packId} version ${adoption.pack.version} (${adoption.mode}, ${intervalWords(adoption.effectiveInterval, zone)}, adopted by ${adoption.actor.name})`;
}

/** True when the adoption, or one it revises, succeeds an earlier version: its start is where that version ends. */
function startsWhereEarlierEnds(adoption: PackAdoptionRecord, adoptions: readonly PackAdoptionRecord[]): boolean {
  for (let current: PackAdoptionRecord | undefined = adoption, depth = 0; current && depth < 100; depth++) {
    if (current.succeeds) return true;
    const revised: string | undefined = current.revises;
    current = revised ? adoptions.find((item) => item.id === revised) : undefined;
  }
  return false;
}

function parseMode(text: string | undefined): AdoptionMode | undefined {
  if (text === undefined) return undefined;
  if (text !== 'active' && text !== 'shadow') throw new UsageError('--mode is active or shadow.');
  return text;
}

function sameValues(left: AdoptionParameterValues | undefined, right: AdoptionParameterValues | undefined): boolean {
  const flat = (values: AdoptionParameterValues | undefined) =>
    JSON.stringify(
      Object.entries(values ?? {})
        .flatMap(([leaf, named]) => Object.entries(named).map(([name, value]) => [leaf, name, value]))
        .sort((a, b) => (`${a[0]}\u0000${a[1]}` < `${b[0]}\u0000${b[1]}` ? -1 : 1)),
    );
  return flat(left) === flat(right);
}

/**
 * What adopting the pack would do, from the adoptions the organization is shown: a new adoption; a successor when an
 * earlier version is adopted over the dates, from the start given or now, ending the earlier one there; or a revision
 * when the same version is, with the mode, dates and values given and the rest kept. Never sends anything.
 */
export function planAdoption(
  pack: RulePackVersion,
  adoptions: readonly PackAdoptionRecord[],
  request: AdoptionRequest,
  zone: string,
  now: number,
): AdoptionPlan {
  const requestedMode = parseMode(request.mode);
  const from = request.from === undefined ? undefined : adoptionInstant(request.from, zone, 'from');
  const until = request.until === undefined ? undefined : adoptionInstant(request.until, zone, 'until');
  const stated = pack.waiver?.effective;
  const statedFrom = stated && adoptionInstant(stated.from, zone, 'from');
  const statedUntil = stated && adoptionInstant(stated.through, zone, 'until');
  const start = from ?? statedFrom;
  const end = until ?? statedUntil;
  const standing = adoptions.filter((adoption) => adoption.pack.packId === pack.packId && adoptionStands(adoption));
  const meeting =
    start && end
      ? overlappingAdoptions(standing, pack.packId, { start: start.instant, end: end.instant })
      : standing.filter((adoption) => adoption.state !== 'expired');
  if (meeting.length > 1)
    throw new UsageError(
      [
        `Your organization has ${meeting.length} adoptions of ${pack.packId} over those dates:`,
        ...meeting.map((adoption) => `  ${adoptionWords(adoption, zone)}`),
        'Give --from and --until that meet only one of them.',
      ].join('\n'),
    );
  const existing = meeting[0];
  if (!existing) return newAdoption(pack, request, zone, requestedMode, { from, until, statedFrom, statedUntil });
  if (existing.pack.version > pack.version)
    throw new UsageError(
      `Version ${existing.pack.version} of ${pack.packId} is adopted over those dates: ${adoptionWords(existing, zone)}. An earlier version does not replace a later one; give --from and --until outside its dates to adopt version ${pack.version} apart from it.`,
    );
  const carried = existing.parameters ? { values: existing.parameters, from: `adoption ${existing.id}` } : undefined;
  const chosen = chooseValues(pack, request.set, request.setAll, zone, carried);
  const mode = requestedMode ?? existing.mode;
  if (existing.pack.version < pack.version)
    return successor(pack, existing, { mode, chosen, zone, now, from, until, statedUntil });
  return revision(pack, existing, adoptions, { mode, chosen, zone, from, until });
}

interface Edge {
  instant: string;
  words: string;
}

function newAdoption(
  pack: RulePackVersion,
  request: AdoptionRequest,
  zone: string,
  mode: AdoptionMode | undefined,
  edges: { from?: Edge; until?: Edge; statedFrom?: Edge; statedUntil?: Edge },
): AdoptionPlan {
  if (!mode) throw new UsageError('--mode is active or shadow.');
  const start = edges.from ?? edges.statedFrom;
  const end = edges.until ?? edges.statedUntil;
  if (!start || !end) throw new UsageError('--from and --until are required: the dates the adoption is in effect.');
  if (Date.parse(end.instant) <= Date.parse(start.instant)) throw new UsageError('--until is after --from.');
  return {
    action: { kind: 'adopt' },
    mode,
    interval: { start: start.instant, end: end.instant },
    chosen: chooseValues(pack, request.set, request.setAll, zone),
    lines: [
      `From: ${start.words}${edges.from ? '' : ', the first date the certificate states'}`,
      `Until: ${end.words}${edges.until ? '' : ', the last date the certificate states'}`,
    ],
  };
}

function successor(
  pack: RulePackVersion,
  earlier: PackAdoptionRecord,
  choice: {
    mode: AdoptionMode;
    chosen: ChosenValue[];
    zone: string;
    now: number;
    from?: Edge;
    until?: Edge;
    statedUntil?: Edge;
  },
): AdoptionPlan {
  const { zone } = choice;
  const earlierStart = Date.parse(earlier.effectiveInterval.start);
  const earlierEnd = Date.parse(earlier.effectiveInterval.end);
  const replaced = `Version ${pack.version} replaces ${adoptionWords(earlier, zone)}`;
  const now = Math.floor(choice.now / 1000) * 1000;
  const earlierFrom = zoned(earlier.effectiveInterval.start, zone);
  const earlierUntil = zoned(earlier.effectiveInterval.end, zone);
  if (!choice.from && now <= earlierStart)
    throw new UsageError(
      `${replaced}, which starts at ${earlierFrom}, after now. Give --from: a time after that start for version ${pack.version} to take over from then, or that start or earlier to replace version ${earlier.pack.version} for its whole period.`,
    );
  if (!choice.from && now >= earlierEnd) throw new UsageError(`${replaced}, which ended at ${earlierUntil}.`);
  const start = choice.from?.instant ?? new Date(now).toISOString();
  if (Date.parse(start) >= earlierEnd)
    throw new UsageError(
      `${replaced}, which ends at ${earlierUntil}; --from gives ${zoned(start, zone)}. Give --from before that end: after ${earlierFrom} for version ${pack.version} to take over from then, or ${earlierFrom} or earlier to replace version ${earlier.pack.version} for its whole period. Leave --from out to start it now.`,
    );
  const whole = Date.parse(start) <= earlierStart;
  const endEdge = choice.until ?? choice.statedUntil;
  const end = endEdge?.instant ?? earlier.effectiveInterval.end;
  if (Date.parse(end) <= Date.parse(start)) throw new UsageError('--until is after the start of the new version.');
  if (whole && Date.parse(end) < earlierEnd)
    throw new UsageError(
      `${replaced}. Starting at or before ${earlierFrom}, version ${pack.version} replaces it for its whole period, so it is in effect at least until ${earlierUntil}, where version ${earlier.pack.version} was to end; ${choice.until ? '--until' : 'the last date the certificate states'} gives ${zoned(end, zone)}. Give --until at or after that end.`,
    );
  const endSource = choice.until
    ? ''
    : choice.statedUntil
      ? ', the last date the certificate states'
      : `, where version ${earlier.pack.version} was to end`;
  const earlierLine = whole
    ? `Version ${earlier.pack.version} is replaced for its whole period: it is in effect at no time, and version ${pack.version} covers every day it covered. Its adoption stays on the record as replaced; what was recorded under it keeps it, and every subject it covered is evaluated again under version ${pack.version}. A finding opened under version ${earlier.pack.version} stays open, and the evaluation under version ${pack.version} of the same rule becomes its latest.`
    : `Version ${earlier.pack.version} stays in effect until ${zoned(start, zone)} and ends there; what was recorded under it keeps it.`;
  return {
    action: { kind: 'succeed', earlier },
    mode: choice.mode,
    interval: { start, end },
    chosen: choice.chosen,
    lines: [
      `Replaces: ${adoptionWords(earlier, zone)}.`,
      earlierLine,
      `Version ${pack.version} is in effect from ${zoned(start, zone)}${choice.from ? '' : ', now'} until ${zoned(end, zone)}${endSource}.`,
    ],
  };
}

function revision(
  pack: RulePackVersion,
  adoption: PackAdoptionRecord,
  adoptions: readonly PackAdoptionRecord[],
  choice: { mode: AdoptionMode; chosen: ChosenValue[]; zone: string; from?: Edge; until?: Edge },
): AdoptionPlan {
  const { zone } = choice;
  const interval = {
    start: choice.from?.instant ?? adoption.effectiveInterval.start,
    end: choice.until?.instant ?? adoption.effectiveInterval.end,
  };
  if (Date.parse(interval.end) <= Date.parse(interval.start)) throw new UsageError('--until is after --from.');
  const moved = (before: string, after: string) => Date.parse(before) !== Date.parse(after);
  if (moved(adoption.effectiveInterval.start, interval.start) && startsWhereEarlierEnds(adoption, adoptions))
    throw new UsageError(
      `${adoptionWords(adoption, zone)} succeeds an earlier version of the pack, which ends where it starts. A revision keeps that start; leave --from out.`,
    );
  const values = parameterValues(choice.chosen);
  const changes = [
    ...(choice.mode !== adoption.mode ? [`Mode: ${adoption.mode} becomes ${choice.mode}.`] : []),
    ...(moved(adoption.effectiveInterval.start, interval.start)
      ? [`From: ${zoned(adoption.effectiveInterval.start, zone)} becomes ${choice.from!.words}.`]
      : []),
    ...(moved(adoption.effectiveInterval.end, interval.end)
      ? [`Until: ${zoned(adoption.effectiveInterval.end, zone)} becomes ${choice.until!.words}.`]
      : []),
    ...(sameValues(adoption.parameters, values) ? [] : ['Values: as listed below.']),
  ];
  if (!changes.length)
    throw new UsageError(
      `${pack.packId} version ${pack.version} is adopted already as ${adoptionWords(adoption, zone)}, with these values. Nothing would change. To revise it, give a new --mode, --from, --until or --set.`,
    );
  return {
    action: { kind: 'revise', adoption, changes },
    mode: choice.mode,
    interval,
    chosen: choice.chosen,
    lines: [
      `Revises: ${adoptionWords(adoption, zone)}. The revision replaces it whole; what was recorded under it keeps it.`,
      ...changes.map((change) => `  ${change}`),
      `In effect ${intervalWords(interval, zone)}.`,
    ],
  };
}

/** The command for the plan, built on the coverage just read. The adoption it replaces must still stand there. */
function planCommand(
  shown: OrganizationCoverageResponse,
  pack: RulePackVersion,
  plan: AdoptionPlan,
  note: string,
): PackAdoptionCommand {
  const parameters = parameterValues(plan.chosen);
  const choice = { mode: plan.mode, note, ...(parameters ? { parameters } : {}) };
  const { action } = plan;
  if (action.kind === 'adopt') return adoptionCommand(shown, pack, { ...choice, effectiveInterval: plan.interval });
  const replaced = action.kind === 'succeed' ? action.earlier : action.adoption;
  const current = shown.adoptions.find((adoption) => adoption.id === replaced.id);
  if (!current || !adoptionStands(current))
    throw new RefusalError(
      `Not sent. Adoption ${replaced.id} was replaced while this was being sent. pnpm ledger coverage --pack ${pack.packId} shows what is adopted now; run this again to replace that.`,
    );
  if (action.kind === 'succeed')
    return successorCommand(shown, current, pack, { ...choice, start: plan.interval.start, end: plan.interval.end });
  return revisionCommand(shown, current, { ...choice, effectiveInterval: plan.interval });
}

const actionWords: Record<AdoptionAction['kind'], { done: string; data: string }> = {
  adopt: { done: 'Adopted', data: 'adopt' },
  succeed: { done: 'Adopted; it replaces the earlier version from its start', data: 'succeed' },
  revise: { done: 'Revised', data: 'revise' },
};

/**
 * Assembles the adoption from what the organization is shown now and the exact pack version, says everything it
 * would record, what it replaces and who it would be recorded as, and sends it only with the person's own reason.
 */
export async function adoptPack(context: Context, request: AdoptionRequest): Promise<Output> {
  const { client } = context;
  parseMode(request.mode);
  const who = await client.request<CurrentPrincipalResponse>('/v1/me');
  const zone = who.organization?.timeZone ?? 'UTC';
  const pack = await readPack(client, request.packId, request.version);
  const plan = planAdoption(pack, (await client.organizationCoverage()).adoptions, request, zone, Date.now());
  const counts = { automatic: 0, person: 0, not_supported: 0 };
  for (const leaf of pack.leaves) counts[leafCheckedBy(leaf)] += 1;
  const person = who.principal.kind === undefined || who.principal.kind === 'human';
  const lines = [
    `Pack: ${pack.title} (${pack.packId} version ${pack.version})`,
    `Rules: ${pack.leaves.length}: ${counts.automatic} ${checkedByLabels.automatic.toLowerCase()}, ${counts.person} where ${checkedByLabels.person.toLowerCase()}, ${counts.not_supported} ${checkedByLabels.not_supported.toLowerCase()}.`,
    `Mode: ${modeWords[plan.mode]}.`,
    ...(pack.waiver
      ? [
          `Waiver: certificate ${pack.waiver.certificateNumber} states it is effective from ${pack.waiver.effective.from} through ${pack.waiver.effective.through}. Ledger reports the certificate's dates; it does not decide whether the waiver is in effect.`,
        ]
      : []),
    ...plan.lines,
    ...(plan.chosen.length
      ? [
          'Values it sets:',
          ...plan.chosen.map(
            (item) =>
              `  ${item.ruleTitle} (${shortRuleId(pack.packId, item.leafId)}): ${item.parameter.title} (${item.parameter.name}) = ${String(item.value)}${item.from === '--set' ? '' : `, from ${item.from}`}`,
          ),
        ]
      : ['Values it sets: none; no rule of this pack asks for one.']),
    `Reason: ${request.reason ? request.reason : 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  ];
  const { action } = plan;
  const data = {
    action: actionWords[action.kind].data,
    pack: { packId: pack.packId, version: pack.version, digest: pack.digest },
    mode: plan.mode,
    effectiveInterval: plan.interval,
    parameters: parameterValues(plan.chosen) ?? {},
    ...(action.kind === 'succeed' ? { succeeds: action.earlier.id } : {}),
    ...(action.kind === 'revise' ? { revises: action.adoption.id } : {}),
    recordedAs: { id: who.principal.id, name: who.principal.name, kind: who.principal.kind ?? 'human' },
  };
  const note = request.reason?.trim();
  refuseUnlessPerson(who, note, lines, "An adoption is a person's decision", 'The person who decides');
  if (!note)
    return {
      data: { sent: false, ...data },
      lines: [
        ...lines,
        person
          ? 'Not sent. A person adopts it by running this again with --reason "<their reason>"; the reason is kept with the adoption.'
          : personSendsIt(who, "An adoption is a person's decision", 'The person who decides'),
      ],
    };
  // Each attempt reads the coverage last, so the revision and input cut are the ones the organization is shown as the
  // command is sent.
  const { value, retried } = await onFreshBasis(context, async () => {
    const command = planCommand(await client.organizationCoverage(), pack, plan, note);
    return { command, sent: await client.command(command as Command, randomUUID()) };
  });
  const adoptionId = value.sent.command.id;
  return {
    data: { sent: true, adoptionId, ...data, retried, command: value.command },
    lines: [
      ...lines,
      ...(retried ? [`Sent after ${retried} concurrent change${retried === 1 ? '' : 's'}, on a fresh basis.`] : []),
      `${actionWords[action.kind].done}. Adoption ${adoptionId}. Its coverage: pnpm ledger coverage --pack ${pack.packId}`,
    ],
  };
}
