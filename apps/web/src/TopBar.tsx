import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Capability, Principal } from '@ledger/contracts';
import { Mark } from '@ledger/ui';
import { time, timeZone, timeZoneLabel, timeZoneName } from './format.js';
import { organizationLabel, roleLabel } from './labels.js';
import { FirstDayContext } from './first-day-context.js';
import { addressOf, goTo, lastPlaceIn, sections, usePlace, type BarSection, type Place } from './place.js';
import { themeChoice, themeChoices, useTheme } from './theme.js';

/** Where each section of the bar opens. */
const sectionPlaces: Record<BarSection, Place> = {
  flights: { section: 'flights' },
  safety: { section: 'safety', view: 'home' },
  records: { section: 'records', pane: 'subjects' },
  rules: { section: 'rules', pane: 'coverage' },
  reports: { section: 'reports', report: 'home' },
  people: { section: 'people' },
};

/**
 * The sections a person may open: Flights when the organization records flights, Safety with safety read or document
 * read, Records and Rules with evidence read, Reports with evidence or safety read, People with authority to manage it.
 */
export function offeredSections(principal: Principal | null, flights: boolean): BarSection[] {
  const may = (capability: Capability) => Boolean(principal?.capabilities.includes(capability));
  const offered: Record<BarSection, boolean> = {
    flights,
    safety: may('sms:read') || may('document:read'),
    records: may('evidence:read'),
    rules: may('evidence:read'),
    reports: may('evidence:read') || may('sms:read'),
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

/** Below this width the bar is one row, and the rest of it opens from a menu. */
const narrowQuery = '(max-width: 719.98px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(narrowQuery);
    const follow = () => setNarrow(query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  return narrow;
}

/**
 * The one bar every screen shows: the organization, the time, the sections the person may open, the way to report a
 * safety concern, and the person, whose name opens their account and the theme. On a narrow screen it is the brand,
 * the current section and a menu that holds the rest.
 */
export function TopBar({
  principal,
  organizationName,
  status,
  section,
  offered,
  report,
  account,
}: {
  principal: Principal | null;
  organizationName: string | null;
  /** Whether the organization is a simulation, and whether updates arrive. */
  status?: ReactNode;
  section: BarSection | null;
  offered: BarSection[];
  /** Reporting a safety concern: always one click away. */
  report?: ReactNode;
  /** What belongs to the account, such as signing out. */
  account?: ReactNode;
}) {
  const narrow = useNarrow();
  // "Setup" leads to the first-day list while a step of it is not on file, for a person who may take one.
  const setup = useContext(FirstDayContext).offersSetup;
  const onSetup = usePlace().place.section === 'setup';
  const organization = principal ? organizationLabel(principal.tenantId, organizationName) : 'Loading organization';
  const brand = (
    <PlaceLink className="brand" place={{ section: 'start' }}>
      <Mark />
      <span>LEDGER</span>
    </PlaceLink>
  );
  const operator = (
    <span className="topbar-operator">
      <span className="topbar-label">Organization</span>
      <strong>{organization}</strong>
    </span>
  );
  const person = principal && (
    <>
      <span className="avatar" aria-hidden="true">
        {initials(principal.name)}
      </span>
      <span>
        {principal.name} <small>· {roleLabel(principal.id)}</small>
      </span>
    </>
  );
  const sectionLinks = offered.length > 0 && (
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
  );
  if (narrow)
    return (
      <header className="topbar topbar--narrow">
        {brand}
        <span className="topbar-current">{onSetup ? 'Setup' : sections.find(([value]) => value === section)?.[1]}</span>
        <Disclosure name="topbar-menu" buttonClassName="topbar-menu-button" panelClassName="topbar-menu" label="Menu">
          {operator}
          {status}
          <Clock />
          {person && <span className="topbar-user">{person}</span>}
          {sectionLinks}
          <div className="topbar-account">
            {report}
            {account}
            <ThemeSwitch />
          </div>
        </Disclosure>
        <PrintHeading organization={organization} />
      </header>
    );
  return (
    <header className="topbar">
      {brand}
      <span className="topbar-divider" />
      {operator}
      {status}
      <span className="topbar-spacer" />
      <Clock />
      <span className="topbar-divider" />
      {sectionLinks}
      {report}
      <Disclosure
        name="topbar-account"
        buttonClassName="topbar-user"
        panelClassName="topbar-account-panel"
        label={person ?? 'Account'}
      >
        {account}
        <ThemeSwitch />
      </Disclosure>
      <PrintHeading organization={organization} />
    </header>
  );
}

/**
 * A button that opens a panel below it: the narrow bar's menu, and the person's account. Opening it moves focus into
 * the panel; Escape, a click outside it, or following a link or button in it closes it, and Escape returns focus to
 * the button. Choosing a theme keeps it open.
 */
function Disclosure({
  name,
  label,
  buttonClassName,
  panelClassName,
  children,
}: {
  /** What the panel is, for its id: a page can hold two bars, one of them hidden. */
  name: string;
  label: ReactNode;
  buttonClassName: string;
  panelClassName: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = `${name}-${useId()}`;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { place } = usePlace();
  useEffect(() => setOpen(false), [place]);
  useEffect(() => {
    if (!open) return;
    // The sections come first when the panel has them; the badge above them is not where a person is going.
    (
      panel.current?.querySelector<HTMLElement>('nav a[href]') ??
      panel.current?.querySelector<HTMLElement>('a[href], button, select, summary')
    )?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const close = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="topbar-disclosure" onKeyDown={close}>
      <button
        ref={button}
        type="button"
        className={`button ${buttonClassName}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((shown) => !shown)}
      >
        {label}
      </button>
      <div
        ref={panel}
        id={id}
        className={panelClassName}
        hidden={!open}
        onClick={(event) => {
          // A link or a button in the panel does its work and closes it; the theme and the simulation's details stay.
          const followed = (event.target as Element).closest('a[href], button');
          if (followed && panel.current?.contains(followed)) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The theme switch: a select, so the same control serves the wide bar and the narrow bar's menu. */
function ThemeSwitch() {
  const [choice, choose] = useTheme();
  return (
    <label className="theme-switch">
      <span className="sr-only">Theme</span>
      <select value={choice} onChange={(event) => choose(themeChoice(event.target.value))}>
        {themeChoices.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * What a printed page carries at its top, in place of the bar: the organization, the place's title, and when it was
 * printed, in the organization's time zone. Read again just before printing.
 */
function PrintHeading({ organization }: { organization: string }) {
  const [printed, setPrinted] = useState(printMoment);
  const { place } = usePlace();
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPrinted(printMoment()));
    const before = () => setPrinted(printMoment());
    window.addEventListener('beforeprint', before);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('beforeprint', before);
    };
  }, [place]);
  return (
    // Drawn from attributes, so the screen's text holds the organization's name once, in the bar.
    <div className="print-heading" aria-hidden="true">
      <strong data-print={organization} />
      <span data-print={printed.title} />
      <span data-print={`Printed ${printed.at}`} />
    </div>
  );
}

function printMoment() {
  const at = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone(),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  return { title: document.title.replace(/ · Ledger$/, ''), at: `${at} ${timeZoneName()}` };
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
