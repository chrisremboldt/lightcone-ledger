import type {
  FlightControl,
  FlightControlNotApplicable,
  FlightControlResult,
  MissionAvoidanceNotApplicable,
} from '@ledger/contracts';
import type { Tone } from '@ledger/ui';
import type { SpatialOutline } from './SpatialMap.js';

// How the controls in scope for a flight read to a person. A result is what the evidence shows now; it is never a
// verdict on the flight and blocks nothing.

const resultWords: Record<FlightControlResult['result'], string> = {
  pass: 'Pass',
  attention: 'Needs attention',
  insufficient: 'Insufficient evidence',
  not_applicable: 'Does not apply',
  needs_confirmation: 'Needs a person’s confirmation',
};

const resultTones: Record<FlightControlResult['result'], Tone> = {
  pass: 'planned',
  attention: 'attention',
  insufficient: 'advisory',
  not_applicable: 'neutral',
  needs_confirmation: 'advisory',
};

const checkWords: Record<FlightControl['check'], string> = {
  rule: 'Checked by the organization’s rule',
  route_review: 'Checked by route review',
  person: 'Confirmed by a person',
};

export function controlResultWords(result: FlightControlResult['result']): string {
  return resultWords[result];
}

export function controlResultTone(result: FlightControlResult['result']): Tone {
  return resultTones[result];
}

export function controlCheckWords(check: FlightControl['check']): string {
  return checkWords[check];
}

/**
 * When a control outside its effective interval applies, in words: "Takes effect on …" for one accepted to take
 * effect later, "Ended on …" for one whose interval ended. Null for a control in force now.
 */
export function controlPeriodWords(control: FlightControl['control'], time: (iso: string) => string): string | null {
  if (control.period === 'upcoming') return `Takes effect on ${time(control.effectiveFrom)}`;
  if (control.period === 'ended' && control.effectiveUntil) return `Ended on ${time(control.effectiveUntil)}`;
  return null;
}

/** Whom a result is about, when the control is checked once per subject. */
export function controlResultSubject(result: FlightControlResult): string | null {
  return result.subject ? `${result.subject.kind} ${result.subject.id}` : null;
}

/** How many of the listed controls have a result that asks a person to look: attention or insufficient evidence. */
export function controlsToReview(controls: readonly FlightControl[]): number {
  return controls.filter((control) =>
    control.results.some((result) => result.result === 'attention' || result.result === 'insufficient'),
  ).length;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * Route review's count, telling the controls that apply to the route from those that overlap the mission interval and
 * do not.
 */
export function applicabilityCountWords(applies: number, doNotApply: number): string {
  if (!applies && !doNotApply) return 'No accepted control overlaps the mission interval';
  const applying = `${applies} accepted ${plural(applies, 'control applies', 'controls apply')} to this route`;
  return doNotApply ? `${applying}; ${doNotApply} more overlap the mission interval and do not apply` : applying;
}

/** The heading of the section that lists the controls route review recorded as not applying. */
export function notApplicableHeading(count: number): string {
  return `Do not apply to this route (${count})`;
}

/** Which rule decided that a control does not apply, for which mission revision and control version. */
export function decidedByWords(
  rule: { id: string; version: number } | null,
  missionRevision: number,
  controlVersion: number,
): string {
  const by = rule ? `${rule.id} version ${rule.version}` : 'no applicability rule';
  return `Decided by ${by} for mission revision ${missionRevision} and control version ${controlVersion}.`;
}

/** The one line under a briefing's controls that counts the controls of its release that do not apply. */
export function briefingOthersWords(count: number): string {
  return count === 1
    ? '1 other accepted control overlaps this flight’s interval and does not apply to its route; the release lists it with its measurement.'
    : `${count} other accepted controls overlap this flight’s interval and do not apply to its route; the release lists each with its measurement.`;
}

/** Departure progress: how many of the release's controls need a briefing, and how many do not apply. */
export function departureBriefingWords(needBriefing: number, doNotApply: number): string {
  const need = `${needBriefing} ${plural(needBriefing, 'control needs', 'controls need')} a briefing.`;
  return doNotApply ? `${need} ${doNotApply} ${plural(doNotApply, 'does', 'do')} not apply to this route.` : need;
}

/** A long list of controls that do not apply is shown this many at a time. */
export const NOT_APPLICABLE_PAGE_SIZE = 50;

/** The entries shown after the person asked for the given number of pages, and how many remain. */
export function notApplicablePage<T>(entries: readonly T[], pages: number): { shown: T[]; remaining: number } {
  const shown = entries.slice(0, Math.max(1, pages) * NOT_APPLICABLE_PAGE_SIZE);
  return { shown, remaining: entries.length - shown.length };
}

/** One control that does not apply, as a list shows it: what names it, the recorded sentence and what decided it. */
export interface NotApplicableEntry {
  key: string;
  controlId: string;
  title: string;
  /** The sentence the applicability record holds, shown as recorded. */
  summary: string;
  decidedBy?: string;
}

/**
 * The controls a route review or release recorded as not applying to the given mission revision, from the entries
 * alone: each carries its title.
 */
export function avoidanceNotApplicableEntries(
  entries: readonly MissionAvoidanceNotApplicable[],
  missionRevision: number,
): NotApplicableEntry[] {
  return entries.map((entry) => ({
    key: entry.controlEventId,
    controlId: entry.controlId,
    title: entry.title,
    summary: entry.applicability.summary,
    decidedBy: decidedByWords(entry.applicability.rule, missionRevision, entry.controlVersion),
  }));
}

/**
 * The map outlines of the controls a route review or release recorded as not applying, from the entries alone: each
 * placed at the area its type describes, with its recorded sentence. An entry with no area is listed but not drawn.
 */
export function notApplicableOutlines(entries: readonly MissionAvoidanceNotApplicable[]): SpatialOutline[] {
  return entries.flatMap((entry) =>
    entry.area
      ? [
          {
            id: entry.controlEventId,
            label: entry.title,
            note: entry.applicability.summary,
            center: entry.area.center,
            radiusMeters: entry.area.radiusMeters,
          },
        ]
      : [],
  );
}

/** The compact entries of a flight's controls list that route review recorded as not applying. */
export function listedNotApplicableEntries(entries: readonly FlightControlNotApplicable[]): NotApplicableEntry[] {
  return entries.map((entry) => ({
    key: `${entry.control.id}:${entry.control.versionNumber}`,
    controlId: entry.control.id,
    title: entry.control.title,
    summary: entry.summary,
  }));
}

/**
 * The recorded sentence a route-review result applies by, looked up by the applicability digest the list shows, in the
 * route review or release that recorded it. Null when the result records no applicability or the sentence is not at
 * hand.
 */
export function appliesBecause(
  result: FlightControlResult,
  recorded: ReadonlyMap<string, string> | undefined,
): string | null {
  if (result.applicability?.outcome !== 'applies') return null;
  return recorded?.get(result.applicability.digest) ?? null;
}

/** The sentences of the applicability records a route review or release holds, by record digest. */
export function applicabilitySentences(
  entries: readonly { applicabilityDigest: string; applicability: { summary: string } }[],
): Map<string, string> {
  return new Map(entries.map((entry) => [entry.applicabilityDigest, entry.applicability.summary]));
}
