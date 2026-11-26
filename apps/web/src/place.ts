import { useSyncExternalStore } from 'react';
import { smsRecordKindValues, type SmsRecordKind } from '@ledger/contracts';
import { recordSubjectKinds, type RecordSubjectKind } from './record-subject-kinds.js';

/**
 * Where a person is in Ledger: a section, the pane inside it and the thing open there. Each place has one address and
 * each address names one place, so a link, a refresh, and the browser's back and forward all keep the place.
 *
 * An address never carries a safety report's title, narrative or reporter, a token, or free text typed into a filter;
 * only ids and plain choices.
 */
export type Place =
  /** The bare address: the workspace opens on the first section the organization uses. */
  | { section: 'start' }
  /** The organization's first day: each setup step, what is on file for it and the action that starts it. */
  | { section: 'setup' }
  | { section: 'flights'; flightId?: string; findingId?: string; mission?: boolean }
  | { section: 'safety'; view: SafetyView; choices?: RegisterChoices }
  | { section: 'safety'; view: 'record'; kind: SmsRecordKind; id: string; issueId?: string }
  /** Opening a hazard from a finding, on a flight when flightId is given. */
  | { section: 'safety'; view: 'finding'; findingId: string; flightId?: string }
  | { section: 'records'; pane: 'subjects'; kind?: RecordSubjectKind; id?: string }
  | { section: 'records'; pane: 'produce' | 'produced' | 'required' }
  | { section: 'records'; pane: RecordTypePane; type?: string }
  | { section: 'rules'; pane: 'coverage'; packId?: string }
  | { section: 'rules'; pane: 'open'; owner?: 'none'; subject?: FindingSubject }
  | { section: 'rules'; pane: 'subjects' }
  | { section: 'people'; personId?: string }
  /** The organization's notices, and its webhook for them. */
  | { section: 'people'; pane: NoticesPane }
  /** An address that names no place here. */
  | { section: 'unknown'; path: string };

export type Section = Place['section'];
export type SafetyView = 'home' | 'hazards' | 'documents' | 'reports' | 'assurance' | 'new-risk-matrix';
export type RecordTypePane = 'browse' | 'import' | 'enter';
export type NoticesPane = 'notices' | 'webhook';
/**
 * The plain choices a safety register is narrowed by: its state, its type and its order. A search's text and the days
 * are typed, and never go in the address.
 */
export interface RegisterChoices {
  state?: string;
  type?: string;
  order?: string;
}
const choiceNames = ['state', 'type', 'order'] as const;
/** A choice is a plain value from a list, never text a person typed. */
const plainChoice = /^[a-z][a-z0-9_-]{0,39}$/;
/** The subject a finding is about, by which its findings are read: a Ledger subject, or a source's by its source id. */
export interface FindingSubject {
  kind: string;
  id: string;
  sourceId?: string;
}

/** The sections in the bar, in its order. */
export const sections = [
  ['flights', 'Flights'],
  ['safety', 'Safety'],
  ['records', 'Records'],
  ['rules', 'Rules'],
  ['people', 'People'],
] as const;
export type BarSection = (typeof sections)[number][0];

const recordKindSegments: Record<SmsRecordKind, string> = {
  hazard: 'hazards',
  control: 'controls',
  document: 'documents',
  risk_matrix: 'risk-matrices',
  report: 'reports',
  assurance: 'assurance',
};
const safetyViewSegments: Record<Exclude<SafetyView, 'home' | 'new-risk-matrix'>, SmsRecordKind> = {
  hazards: 'hazard',
  documents: 'document',
  reports: 'report',
  assurance: 'assurance',
};
const recordTypePanes: readonly RecordTypePane[] = ['browse', 'import', 'enter'];
/** Query parameters a place owns; every other parameter of the address, such as ?autopilot=, is kept as it is. */
export const placeParameters = ['flight', 'owner', ...choiceNames] as const;

/** An id as one segment of a path. `@` and `:` are allowed in a segment and keep a record type such as person.training@1 readable. */
function segment(id: string): string {
  return encodeURIComponent(id).replaceAll('%40', '@').replaceAll('%3A', ':');
}

/** The address of a place: a path, and a query for the few plain choices a place holds. */
export function placeAddress(place: Place): { path: string; query: Record<string, string> } {
  const at = (...parts: string[]) => `/${parts.map(segment).join('/')}`;
  switch (place.section) {
    case 'start':
      return { path: '/', query: {} };
    case 'setup':
      return { path: '/setup', query: {} };
    case 'flights':
      if (!place.flightId) return { path: '/flights', query: {} };
      if (place.findingId) return { path: at('flights', place.flightId, 'findings', place.findingId), query: {} };
      return { path: at('flights', place.flightId, ...(place.mission ? ['mission'] : [])), query: {} };
    case 'safety':
      if (place.view === 'home') return { path: '/safety', query: {} };
      if (place.view === 'new-risk-matrix') return { path: '/safety/risk-matrices/new', query: {} };
      if (place.view === 'finding')
        return {
          path: at('safety', 'findings', place.findingId),
          query: place.flightId ? { flight: place.flightId } : {},
        };
      if (place.view === 'record')
        return {
          path: at(
            'safety',
            recordKindSegments[place.kind],
            place.id,
            ...(place.issueId && place.kind === 'document' ? ['issues', place.issueId] : []),
          ),
          query: {},
        };
      return {
        path: at('safety', place.view),
        query: Object.fromEntries(
          choiceNames.flatMap((name) => (place.choices?.[name] ? [[name, place.choices[name]!]] : [])),
        ),
      };
    case 'records':
      if (place.pane === 'subjects') {
        if (!place.kind) return { path: '/records', query: {} };
        return { path: at('records', place.kind, ...(place.id ? [place.id] : [])), query: {} };
      }
      if (!('type' in place) || !place.type) return { path: at('records', place.pane), query: {} };
      return { path: at('records', place.pane, place.type), query: {} };
    case 'rules':
      if (place.pane === 'coverage')
        return { path: place.packId ? at('rules', 'coverage', place.packId) : '/rules', query: {} };
      if (place.pane === 'subjects') return { path: '/rules/subjects', query: {} };
      if (place.subject) {
        const { sourceId, kind, id } = place.subject;
        return { path: at('rules', 'findings', ...(sourceId ? [sourceId] : []), kind, id), query: {} };
      }
      return { path: '/rules/findings', query: place.owner ? { owner: place.owner } : {} };
    case 'people':
      if ('pane' in place)
        return { path: place.pane === 'notices' ? '/people/notices' : '/people/notices/webhook', query: {} };
      return { path: place.personId ? at('people', place.personId) : '/people', query: {} };
    case 'unknown':
      return { path: place.path, query: {} };
  }
}

/** The path of a place, with its own query when it has one. */
export function placePath(place: Place): string {
  const { path, query } = placeAddress(place);
  const search = new URLSearchParams(query).toString();
  return search ? `${path}?${search}` : path;
}

function decoded(parts: string[]): string[] | null {
  try {
    return parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** The place an address names; an address that names none is the unknown place, never an empty screen. */
export function placeFromAddress(pathname: string, search = ''): Place {
  const unknown: Place = { section: 'unknown', path: pathname };
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === '') return { section: 'start' };
  const parts = decoded(trimmed.slice(1).split('/'));
  if (!parts || parts.some((part) => part === '')) return unknown;
  const query = new URLSearchParams(search);
  const [section, ...rest] = parts;
  switch (section) {
    case 'setup':
      return rest.length === 0 ? { section: 'setup' } : unknown;
    case 'flights': {
      if (rest.length === 0) return { section: 'flights' };
      const [flightId, next, findingId] = rest;
      if (rest.length === 1) return { section: 'flights', flightId: flightId! };
      if (rest.length === 2 && next === 'mission') return { section: 'flights', flightId: flightId!, mission: true };
      if (rest.length === 3 && next === 'findings') return { section: 'flights', flightId: flightId!, findingId };
      return unknown;
    }
    case 'safety':
      return safetyPlace(rest, query) ?? unknown;
    case 'records':
      return recordsPlace(rest) ?? unknown;
    case 'rules':
      return rulesPlace(rest, query) ?? unknown;
    case 'people':
      if (rest.length === 0) return { section: 'people' };
      // A person's id never is "notices": people are person-<uuid>, and other principals have prefixes of their own.
      if (rest[0] === 'notices')
        return rest.length === 1
          ? { section: 'people', pane: 'notices' }
          : rest.length === 2 && rest[1] === 'webhook'
            ? { section: 'people', pane: 'webhook' }
            : unknown;
      return rest.length === 1 ? { section: 'people', personId: rest[0]! } : unknown;
    default:
      return unknown;
  }
}

function safetyPlace(rest: string[], query: URLSearchParams): Place | null {
  if (rest.length === 0) return { section: 'safety', view: 'home' };
  const [first, id, issues, issueId] = rest;
  if (first === 'findings' && rest.length === 2) {
    const flightId = query.get('flight');
    return { section: 'safety', view: 'finding', findingId: id!, ...(flightId ? { flightId } : {}) };
  }
  if (first === 'risk-matrices' && id === 'new' && rest.length === 2)
    return { section: 'safety', view: 'new-risk-matrix' };
  const kind = smsRecordKindValues.find((value) => recordKindSegments[value] === first);
  if (!kind) return null;
  if (rest.length === 1) {
    const view = (Object.keys(safetyViewSegments) as (keyof typeof safetyViewSegments)[]).find((key) => key === first);
    if (!view) return null;
    const choices = Object.fromEntries(
      choiceNames.flatMap((name) => {
        const value = query.get(name);
        return value && plainChoice.test(value) ? [[name, value]] : [];
      }),
    ) as RegisterChoices;
    return { section: 'safety', view, ...(Object.keys(choices).length ? { choices } : {}) };
  }
  if (rest.length === 2) return { section: 'safety', view: 'record', kind, id: id! };
  if (rest.length === 4 && kind === 'document' && issues === 'issues')
    return { section: 'safety', view: 'record', kind, id: id!, issueId: issueId! };
  return null;
}

function recordsPlace(rest: string[]): Place | null {
  if (rest.length === 0) return { section: 'records', pane: 'subjects' };
  const [first, second] = rest;
  if ((first === 'produce' || first === 'produced' || first === 'required') && rest.length === 1)
    return { section: 'records', pane: first };
  const pane = recordTypePanes.find((value) => value === first);
  if (pane && rest.length <= 2) return { section: 'records', pane, ...(second ? { type: second } : {}) };
  const kind = recordSubjectKinds.find(([value]) => value === first)?.[0];
  if (kind && rest.length <= 2)
    return { section: 'records', pane: 'subjects', kind, ...(second ? { id: second } : {}) };
  return null;
}

function rulesPlace(rest: string[], query: URLSearchParams): Place | null {
  if (rest.length === 0) return { section: 'rules', pane: 'coverage' };
  const [first, ...more] = rest;
  if (first === 'coverage' && more.length <= 1)
    return { section: 'rules', pane: 'coverage', ...(more[0] ? { packId: more[0] } : {}) };
  if (first === 'subjects' && more.length === 0) return { section: 'rules', pane: 'subjects' };
  if (first === 'findings' && more.length === 0)
    return { section: 'rules', pane: 'open', ...(query.get('owner') === 'none' ? { owner: 'none' as const } : {}) };
  if (first === 'findings' && more.length === 2) {
    const [kind, id] = more as [string, string];
    return { section: 'rules', pane: 'open', subject: { kind, id } };
  }
  if (first === 'findings' && more.length === 3) {
    const [sourceId, kind, id] = more as [string, string, string];
    return { section: 'rules', pane: 'open', subject: { sourceId, kind, id } };
  }
  return null;
}

/** Whether two places are the same place. */
export function samePlace(one: Place, other: Place): boolean {
  return placePath(one) === placePath(other);
}

/** The section a place belongs to in the bar; the start, the setup list and an unknown address belong to none. */
export function barSection(place: Place): BarSection | null {
  return place.section === 'start' || place.section === 'setup' || place.section === 'unknown' ? null : place.section;
}

const recordKindLabels: Record<SmsRecordKind, string> = {
  hazard: 'Hazard',
  control: 'Control',
  document: 'Document',
  risk_matrix: 'Risk matrix',
  report: 'Safety report',
  assurance: 'Safety assurance record',
};
const safetyViewLabels: Record<SafetyView, string> = {
  home: 'Safety home',
  hazards: 'Hazard register',
  documents: 'Documents',
  reports: 'Safety reports',
  assurance: 'Safety assurance',
  'new-risk-matrix': 'New risk matrix',
};
const recordsPaneLabels: Record<'produce' | 'produced' | 'required' | RecordTypePane, string> = {
  produce: 'Produce records',
  produced: 'Produced records',
  required: 'Records your rules require',
  browse: 'Browse records',
  import: 'Import a file',
  enter: 'Enter a record',
};

/**
 * The page title: "<thing or pane> · <section> · Ledger". A thing is named by the name the screen gives it when one is
 * passed, such as a flight's label; a safety report is never named, since its title is protected.
 */
export function placeTitle(place: Place, thing?: string): string {
  const title = (...parts: (string | undefined)[]) => [...parts.filter(Boolean), 'Ledger'].join(' · ');
  switch (place.section) {
    case 'start':
      return 'Ledger';
    case 'setup':
      return title('Setup');
    case 'unknown':
      return title('Not found here');
    case 'flights':
      if (!place.flightId) return title('Flights');
      return title(
        place.findingId ? 'Finding' : place.mission ? 'Mission review' : undefined,
        thing ?? `Flight ${place.flightId}`,
        'Flights',
      );
    case 'safety':
      if (place.view === 'record')
        return title(
          place.kind === 'report' ? recordKindLabels.report : (thing ?? recordKindLabels[place.kind]),
          'Safety',
        );
      if (place.view === 'finding') return title('Hazard from a finding', 'Safety');
      return title(safetyViewLabels[place.view], 'Safety');
    case 'records':
      if (place.pane === 'subjects') {
        const kindLabel = recordSubjectKinds.find(([value]) => value === place.kind)?.[1];
        return title(
          place.id ? (thing ?? `${place.kind} ${place.id}`) : (kindLabel ?? 'People, aircraft and flights'),
          'Records',
        );
      }
      return title(recordsPaneLabels[place.pane], 'Records');
    case 'rules':
      if (place.pane === 'coverage')
        return title(place.packId ? (thing ?? place.packId) : 'Adopted rule packs', 'Rules');
      if (place.pane === 'subjects') return title('Findings by subject', 'Rules');
      return title(place.subject ? (thing ?? `Findings about ${place.subject.id}`) : 'Open findings', 'Rules');
    case 'people':
      if ('pane' in place) return title(place.pane === 'notices' ? 'Notices' : 'Webhook for notices', 'People');
      return place.personId ? title(thing ?? 'Person', 'People') : title('People');
  }
}

// The browser's address, as a store the screens subscribe to.

interface Current {
  place: Place;
  /** What the screen that moved here kept with the move, such as the flight a hazard was opened from. */
  extras: Record<string, unknown>;
}

const listeners = new Set<() => void>();
let current: Current | null = null;
/** The last place a person was at in each section, so moving back to a section returns to where they left it. */
const lastPlaces = new Map<Section, Current>();

function readAddress(): Current {
  const state = window.history.state as { extras?: Record<string, unknown> } | null;
  return {
    place: placeFromAddress(window.location.pathname, window.location.search),
    extras: state?.extras ?? {},
  };
}

function remember(shown: Current): Current {
  lastPlaces.set(shown.place.section, shown);
  return shown;
}

function notify() {
  current = remember(readAddress());
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('popstate', notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('popstate', notify);
  };
}

function snapshot(): Current {
  current ??= remember(readAddress());
  return current;
}

/** Where a person last was in a section, with what the move there kept. */
export function lastPlaceIn(section: Section): Current | undefined {
  return lastPlaces.get(section);
}

/** Forgets where a person was in each section, when another person signs in. */
export function forgetPlaces(): void {
  lastPlaces.clear();
}

/** The full address of a place, keeping every query parameter the place does not own. */
export function addressOf(place: Place, search: string): string {
  const { path, query } = placeAddress(place);
  const kept = new URLSearchParams(search);
  for (const name of placeParameters) kept.delete(name);
  for (const [name, value] of Object.entries(query)) kept.set(name, value);
  const rest = kept.toString();
  return rest ? `${path}?${rest}` : path;
}

/**
 * Moves to a place. A move a person makes is a new entry in the browser's history; a correction, such as the start
 * address resolving to the first section, replaces the current one.
 */
export function goTo(place: Place, options: { replace?: boolean; extras?: Record<string, unknown> } = {}): void {
  const address = addressOf(place, window.location.search);
  const state = { extras: options.extras ?? {} };
  const unchanged = address === `${window.location.pathname}${window.location.search}`;
  if (options.replace || unchanged) window.history.replaceState(state, '', address);
  else window.history.pushState(state, '', address);
  notify();
}

/** The current place, and what was kept with the move to it; follows back and forward. */
export function usePlace(): Current {
  return useSyncExternalStore(subscribe, snapshot);
}
