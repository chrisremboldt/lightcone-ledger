import { ObservationFieldPathPattern, type CheckDetails, type IssueTime } from '@ledger/contracts';
import {
  observationField,
  registerCheckKind,
  utcMillis,
  type CheckClock,
  type CheckInputs,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';

// Check kinds over episodes: reports of a state that opens at one instant and closes at a later one. The rule names
// the fields that identify an episode, the state field and the values that open and close it; nothing here knows
// what the state describes.

const fieldPath = { type: 'string', pattern: ObservationFieldPathPattern, maxLength: 400 } as const;
const stateValue = { type: 'string', minLength: 1, maxLength: 200 } as const;
const stateValues = { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: stateValue } as const;

export interface EpisodeOpenParams {
  scopeFields: string[];
  stateField: string;
  opening: string[];
  closing: string[];
  /** A session the source reports in; its first transition binds the session to the values of `sessionBinds`. */
  sessionField?: string;
  sessionBinds?: string[];
  /** Which episodes need a person's attention: only those not closed, or every recorded episode. */
  attention: 'open' | 'any';
}

type EpisodeState = 'open' | 'closed' | 'conflicting';

interface Transition {
  observation: CheckObservation;
  scope: string;
  opens: boolean;
  at: number;
  session?: string;
  binding?: string;
}

interface Episode {
  scope: string;
  openings: Transition[];
  closings: Transition[];
  state: EpisodeState;
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function byTime(left: Transition, right: Transition): number {
  return left.at - right.at || compare(left.observation.id, right.observation.id);
}

function identity(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/** The observation as a transition, undefined when its state neither opens nor closes, or null when unreadable. */
function transitionOf(
  observation: CheckObservation,
  params: EpisodeOpenParams,
  now: number,
): Transition | undefined | null {
  const state = observationField(observation, params.stateField);
  const opens = params.opening.includes(state as string);
  if (!opens && !params.closing.includes(state as string)) return undefined;
  // Reports of different sources never share an episode or a session, whatever ids they carry.
  const source = observation.sourceId ?? null;
  const scope = params.scopeFields.map((field) => identity(observationField(observation, field)));
  const at = utcMillis(observation.occurredAt);
  if (scope.some((part) => part === undefined) || at === undefined || at > now) return null;
  const episode = JSON.stringify([source, ...scope]);
  if (!params.sessionField) return { observation, scope: episode, opens, at };
  const session = identity(observationField(observation, params.sessionField));
  const binding = (params.sessionBinds ?? []).map((field) => identity(observationField(observation, field)));
  if (session === undefined || binding.some((part) => part === undefined)) return null;
  return {
    observation,
    scope: episode,
    opens,
    at,
    session: JSON.stringify([source, session]),
    binding: JSON.stringify(binding),
  };
}

/** Earliest first; at one instant, by the values bound, so the first transition does not depend on arrival. */
function byTimeAndBinding(left: Transition, right: Transition): number {
  return (
    left.at - right.at ||
    compare(left.binding ?? '', right.binding ?? '') ||
    compare(left.observation.id, right.observation.id)
  );
}

/**
 * The transitions whose session is bound, by its first transition, to the values they carry; and those left out.
 * The first transition of a session is found among the transitions and, when given, the session's other
 * transitions about any subject.
 */
function bound(
  transitions: readonly Transition[],
  session?: { others: readonly Transition[] },
): { kept: Transition[]; leftOut: Transition[] } {
  const first = new Map<string, Transition>();
  const ids = new Set(transitions.map((item) => item.observation.id));
  const pool = session
    ? [...transitions, ...session.others.filter((item) => !ids.has(item.observation.id))].sort(byTimeAndBinding)
    : [...transitions].sort(byTime);
  for (const item of pool) if (item.session !== undefined && !first.has(item.session)) first.set(item.session, item);
  const kept: Transition[] = [];
  const leftOut: Transition[] = [];
  for (const item of transitions)
    (item.session === undefined || first.get(item.session)!.binding === item.binding ? kept : leftOut).push(item);
  return { kept, leftOut };
}

function episodeState(openings: readonly Transition[], closings: readonly Transition[]): EpisodeState {
  const latestOpening = Math.max(...openings.map((item) => item.at));
  const latestClosing = closings.length ? Math.max(...closings.map((item) => item.at)) : undefined;
  if (latestClosing === latestOpening) return 'conflicting';
  return latestClosing !== undefined && latestClosing > latestOpening ? 'closed' : 'open';
}

/** Episodes with at least one opening, in scope order; each scope's openings and closings in time order. */
function episodesOf(transitions: readonly Transition[]): Episode[] {
  const scopes = new Map<string, Transition[]>();
  for (const item of transitions) scopes.set(item.scope, [...(scopes.get(item.scope) ?? []), item]);
  return [...scopes.entries()]
    .sort(([left], [right]) => compare(left, right))
    .flatMap(([scope, items]) => {
      const openings = items.filter((item) => item.opens).sort(byTime);
      const closings = items.filter((item) => !item.opens).sort(byTime);
      return openings.length ? [{ scope, openings, closings, state: episodeState(openings, closings) }] : [];
    });
}

/** When the episode an opening report begins lasted: to its first strictly later closing, or on, or unknown. */
function openingTime(issue: string, opening: Transition, episode: Episode): IssueTime {
  const start = new Date(opening.at).toISOString();
  const closing = episode.closings.find((item) => item.at > opening.at);
  if (closing) return { issue, start, end: new Date(closing.at).toISOString() };
  if (episode.closings.some((item) => item.at === opening.at)) return { issue, start, endUnknown: true };
  return { issue, start };
}

function result(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  details: CheckDetails,
  issues: string[],
  issueTimes: IssueTime[],
): CheckResult {
  return {
    evidenceState,
    outcome,
    reasonCode,
    summary,
    evidence: evidence.map((item) => item.id),
    details,
    issues,
    issueTimes,
  };
}

export const episodeOpenV1: CheckKind<EpisodeOpenParams> = {
  id: 'episode.open',
  version: 1,
  title: 'Reported episode',
  description:
    'Observations whose state field holds an opening or a closing value are transitions. The scope fields together name one episode, and an episode exists once it has an opening. With a session field, the first transition of each session binds it to the values of the bound fields, and a later transition in that session naming other values is left out, as a source may not move a session. An episode is closed when its latest closing is strictly later than its latest opening, conflicting when both are at the same instant, and open otherwise. An open or conflicting episode needs attention; when every episode is closed the evidence is supported. A transition whose scope fields or time cannot be read, or whose time is after the evaluation, makes the evidence insufficient and needs attention. Closings without an opening are not an episode, and without any episode the check is insufficient. Reports of different sources never share an episode or a session. The attention parameter says which episodes a person reviews: open ones only, or every recorded episode, closed or not; each opening report of such an episode is one issue, named by the source and scope of the episode and by the report, and so is each unreadable transition. Absence of a closing is never read as a closing, and a closed episode says nothing about the state between reports.',
  inputs: [{ name: 'transitions', description: 'Observations that report a state opening or closing an episode.' }],
  details: [
    { name: 'episodeCount', description: 'How many episodes have an opening.' },
    { name: 'openEpisodeCount', description: 'How many episodes lack a strictly later closing.' },
    { name: 'conflictingEpisodeCount', description: 'How many episodes close at the instant of their latest opening.' },
    { name: 'closedEpisodeCount', description: 'How many episodes have a strictly later closing.' },
    { name: 'unreadableCount', description: 'How many transitions have an unreadable scope or time.' },
    {
      name: 'leftOutCount',
      description: 'How many transitions name other bound values than the first transition of their session.',
    },
    { name: 'transitionCount', description: 'How many transitions the check read.' },
    {
      name: 'latestOpenedAt',
      description: 'The latest opening of an episode that is open or conflicting, a UTC instant; null when none.',
    },
    {
      name: 'latestClosedAt',
      description: 'The latest closing of a closed episode, a UTC instant; null when no episode is closed.',
    },
  ],
  issues: {
    description:
      'One opening report of an episode to review, named by the episode source, scope fields and the report, or one unreadable transition, named by its observation.',
    timed:
      'An opening report starts at its own time and ends at the first closing of its episode strictly later; with none, it continues, unless a closing reports the same instant, when its end is unknown. An unreadable transition has no time.',
  },
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['scopeFields', 'stateField', 'opening', 'closing', 'attention'],
    properties: {
      scopeFields: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: fieldPath },
      stateField: fieldPath,
      opening: stateValues,
      closing: stateValues,
      sessionField: fieldPath,
      sessionBinds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: fieldPath },
      attention: { enum: ['open', 'any'] },
    },
  },
  evaluate: (params, inputs, clock) => evaluateEpisodes(params, inputs, clock, false),
};

/** Up to this many left-out observation ids are named in the details; the count names them all. */
const LEFT_OUT_NAMED = 20;

function leftOutNames(leftOut: readonly Transition[]): string | null {
  if (!leftOut.length) return null;
  const ids = leftOut
    .map((item) => item.observation.id)
    .sort(compare)
    .slice(0, LEFT_OUT_NAMED);
  return ids.join(' ').slice(0, 1000);
}

function evaluateEpisodes(
  params: EpisodeOpenParams,
  inputs: CheckInputs,
  clock: CheckClock,
  acrossSubjects: boolean,
): CheckResult {
  const now = utcMillis(clock.evaluatedAt)!;
  const read = (inputs.transitions ?? []).map((observation) => ({
    observation,
    transition: transitionOf(observation, params, now),
  }));
  const unreadable = read.filter((item) => item.transition === null).map((item) => item.observation);
  // Other transitions of a session matter only for which came first; unreadable or future ones are not counted.
  const others = acrossSubjects
    ? (inputs.sessionTransitions ?? []).flatMap((observation) => transitionOf(observation, params, now) ?? [])
    : undefined;
  const { kept: transitions, leftOut } = bound(
    read.flatMap((item) => (item.transition ? [item.transition] : [])),
    others ? { others } : undefined,
  );
  const episodes = episodesOf(transitions);
  const unsettled = episodes.filter((episode) => episode.state !== 'closed');
  const latestOpening = unsettled.flatMap((episode) => episode.openings.map((item) => item.at));
  const closed = episodes.filter((episode) => episode.state === 'closed');
  const latestClosing = closed.flatMap((episode) => episode.closings.map((item) => item.at));
  // Each opening report of an episode needing review is one issue, so a later opening is a new thing to review.
  const issueTimes = (params.attention === 'any' ? episodes : unsettled).flatMap((episode) =>
    episode.openings.map((opening) =>
      openingTime(`episode:${episode.scope}:${opening.observation.id}`, opening, episode),
    ),
  );
  const issues = [
    ...issueTimes.map((time) => time.issue),
    ...unreadable.map((observation) => `unreadable:${observation.id}`),
  ];
  const details = {
    episodeCount: episodes.length,
    openEpisodeCount: episodes.filter((episode) => episode.state === 'open').length,
    conflictingEpisodeCount: episodes.filter((episode) => episode.state === 'conflicting').length,
    closedEpisodeCount: closed.length,
    unreadableCount: unreadable.length,
    leftOutCount: leftOut.length,
    transitionCount: transitions.length + unreadable.length,
    latestOpenedAt: latestOpening.length ? new Date(Math.max(...latestOpening)).toISOString() : null,
    latestClosedAt: latestClosing.length ? new Date(Math.max(...latestClosing)).toISOString() : null,
    ...(acrossSubjects ? { leftOutObservations: leftOutNames(leftOut) } : {}),
  };
  // Openings first, earliest first, so the first cited observation is the one that opened an episode.
  const cited = [
    ...transitions.filter((item) => item.opens).sort(byTime),
    ...transitions.filter((item) => !item.opens).sort(byTime),
  ].map((item) => item.observation);
  if (unreadable.length)
    return result(
      'insufficient',
      'attention',
      'transition_unreadable',
      'A transition has an unreadable scope or time, or occurs after the evaluation time. Closing cannot be established.',
      [...cited, ...unreadable],
      details,
      issues,
      issueTimes,
    );
  if (details.conflictingEpisodeCount)
    return result(
      'conflicting',
      'attention',
      'episode_conflicting',
      'An episode opens and closes at the same latest instant. Review the conflicting reports.',
      cited,
      details,
      issues,
      issueTimes,
    );
  if (details.openEpisodeCount)
    return result(
      'insufficient',
      'attention',
      'episode_open',
      'An episode lacks a strictly later closing in the same scope.',
      cited,
      details,
      issues,
      issueTimes,
    );
  if (!episodes.length)
    return result(
      'insufficient',
      'pending',
      'episode_unavailable',
      'No opening is reported. Closings alone do not establish anything.',
      cited,
      details,
      issues,
      issueTimes,
    );
  return result(
    'supported',
    'pass',
    'episodes_closed',
    'Every episode has a strictly later closing in the same scope.',
    cited,
    details,
    issues,
    issueTimes,
  );
}

const v1Details = episodeOpenV1.details!;

export const episodeOpenV2: CheckKind<EpisodeOpenParams> = {
  ...episodeOpenV1,
  version: 2,
  description:
    'As version 1, and a session is bound across subjects. Observations whose state field holds an opening or a closing value are transitions. The scope fields together name one episode, and an episode exists once it has an opening. With a session field, the first transition of each session binds it to the values of the bound fields, and a later transition in that session naming other values is left out, as a source may not move a session. The first transition of a session is the earliest, at one instant the one whose bound values sort first, among the transitions and the session transitions: the transitions the same source reported in the same sessions about any subject, so a session first used for another subject is not counted here. Session transitions are used for nothing else. An episode is closed when its latest closing is strictly later than its latest opening, conflicting when both are at the same instant, and open otherwise. An open or conflicting episode needs attention; when every episode is closed the evidence is supported. A transition whose scope fields or time cannot be read, or whose time is after the evaluation, makes the evidence insufficient and needs attention. Closings without an opening are not an episode, and without any episode the check is insufficient. Reports of different sources never share an episode or a session. The attention parameter says which episodes a person reviews: open ones only, or every recorded episode, closed or not; each opening report of such an episode is one issue, named by the source and scope of the episode and by the report, and so is each unreadable transition. Left-out transitions are counted and named in the details, and are not issues. Absence of a closing is never read as a closing, and a closed episode says nothing about the state between reports.',
  inputs: [
    ...episodeOpenV1.inputs,
    {
      name: 'sessionTransitions',
      description:
        'Transitions the same source reported in the same sessions, about any subject; used only to find the first transition of each session.',
      optional: true,
    },
  ],
  details: [
    ...v1Details,
    {
      name: 'leftOutObservations',
      description: `The ids of the left-out transitions, space-separated, at most ${LEFT_OUT_NAMED}; null when none is left out.`,
    },
  ],
  evaluate: (params, inputs, clock) => evaluateEpisodes(params, inputs, clock, true),
};

export const episodeCheckKinds: readonly CheckKind[] = [episodeOpenV1, episodeOpenV2];
for (const kind of episodeCheckKinds) registerCheckKind(kind);
