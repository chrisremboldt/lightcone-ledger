import { useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { Capability, Principal } from '@ledger/contracts';
import { Mark } from '@ledger/ui';
import { time, timeZone, timeZoneLabel } from './format.js';
import { organizationLabel, roleLabel } from './labels.js';
import { FirstDayContext } from './first-day-context.js';
import { addressOf, goTo, lastPlaceIn, sections, usePlace, type BarSection, type Place } from './place.js';

/** Where each section of the bar opens. */
const sectionPlaces: Record<BarSection, Place> = {
  flights: { section: 'flights' },
  safety: { section: 'safety', view: 'home' },
  records: { section: 'records', pane: 'subjects' },
  rules: { section: 'rules', pane: 'coverage' },
  people: { section: 'people' },
};

/**
 * The sections a person may open: Flights when the organization records flights, Safety with safety read, Records and
 * Rules with evidence read, People with authority to manage it.
 */
export function offeredSections(principal: Principal | null, flights: boolean): BarSection[] {
  const may = (capability: Capability) => Boolean(principal?.capabilities.includes(capability));
  const offered: Record<BarSection, boolean> = {
    flights,
    safety: may('sms:read'),
    records: may('evidence:read'),
    rules: may('evidence:read'),
    people: may('authority:write'),
  };
  return sections.filter(([section]) => offered[section]).map(([section]) => section);
}

/** Follows a link inside the page, leaving a modified click (a new tab or window) to the browser. */
export function follow(place: Place, extras?: Record<string, unknown>) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goTo(place, extras ? { extras } : {});
  };
}

/** A link to a place in Ledger: an ordinary link a person can copy or open in a new tab. */
export function PlaceLink({
  place,
  children,
  className,
  current,
  extras,
}: {
  place: Place;
  children: ReactNode;
  className?: string;
  current?: boolean;
  /** What the move keeps that the address does not hold. */
  extras?: Record<string, unknown>;
}) {
  return (
    <a
      className={className}
      href={addressOf(place, typeof window === 'undefined' ? '' : window.location.search)}
      aria-current={current ? 'page' : undefined}
      onClick={follow(place, extras)}
    >
      {children}
    </a>
  );
}

/** The one bar every screen shows: the organization, the time, the person, the sections they may open, the account. */
export function TopBar({
  principal,
  organizationName,
  status,
  section,
  offered,
  account,
}: {
  principal: Principal | null;
  organizationName: string | null;
  /** Whether the organization is a simulation, and whether updates arrive. */
  status?: ReactNode;
  section: BarSection | null;
  offered: BarSection[];
  account?: ReactNode;
}) {
  // "Setup" leads to the first-day list while a step of it is not on file, for a person who may take one.
  const setup = useContext(FirstDayContext).offersSetup;
  const onSetup = usePlace().place.section === 'setup';
  return (
    <header className="topbar">
      <PlaceLink className="brand" place={{ section: 'start' }}>
        <Mark />
        <span>LEDGER</span>
      </PlaceLink>
      <span className="topbar-divider" />
      <span className="topbar-operator">
        <span className="topbar-label">Organization</span>
        <strong>{principal ? organizationLabel(principal.tenantId, organizationName) : 'Loading organization'}</strong>
      </span>
      {status}
      <span className="topbar-spacer" />
      <Clock />
      <span className="topbar-divider" />
      {principal && (
        <span className="topbar-user">
          <span className="avatar" aria-hidden="true">
            {initials(principal.name)}
          </span>
          <span>
            {principal.name} <small>· {roleLabel(principal.id)}</small>
          </span>
        </span>
      )}
      {offered.length > 0 && (
        <nav className="topbar-sections" aria-label="Sections">
          {(setup || onSetup) && (
            <PlaceLink className="button button--quiet records-toggle" place={{ section: 'setup' }} current={onSetup}>
              Setup
            </PlaceLink>
          )}
          {sections
            .filter(([value]) => offered.includes(value))
            .map(([value, label]) => {
              // Another section opens where the person left it; the current one opens at its start.
              const left = section === value ? undefined : lastPlaceIn(value);
              return (
                <PlaceLink
                  key={value}
                  className="button button--quiet records-toggle"
                  place={left?.place ?? sectionPlaces[value]}
                  extras={left?.extras}
                  current={section === value}
                >
                  {label}
                </PlaceLink>
              );
            })}
        </nav>
      )}
      {account}
    </header>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function Clock() {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="clock" aria-label={`Time in ${timeZone()}`}>
      {time(now)}
      <small>{timeZoneLabel()}</small>
    </span>
  );
}
