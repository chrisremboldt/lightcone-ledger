import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appFetch } from './transport.js';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type {
  FlightListResponse,
  FlightsOnRecordResponse,
  FlightSummary,
  HistoryPage,
  CurrentPrincipalResponse,
  Principal,
  Receipt,
  SourceCapability,
} from '@ledger/contracts';
import { Button, Mark, Notice, Spinner } from '@ledger/ui';
import { age, errorMessage, setTimeZone, shortId, time, timeZone, timeZoneLabel } from './format.js';
import {
  activityPresentation,
  aircraftLabel,
  attentionOwner,
  attentionReasons,
  organizationLabel,
  seededOrganization,
  ownershipLine,
  picturePhrase,
  roleLabel,
  rosterGroup,
  rosterGroups,
  type RosterGroup,
} from './labels.js';
import { FlightThread } from './FlightThread.js';
import { FleetMap } from './FleetMap.js';
import { AwaitingOrders } from './AwaitingOrders.js';
import { OperationOverview } from './OperationOverview.js';
import type { FlightRequest, SafetyDestination } from './safety-navigation.js';
import { MissionWorkspace, type MissionRequest } from './MissionWorkspace.js';
import type { AvoidanceDemoMission } from './avoidance-demo.js';
import { useDecisionPacketRequests } from './decision-packet-requests.js';
import { retainFlight } from './flightSelection.js';
import { operationDisplay, operationViews, type OperationView } from './operation-display.js';
import { useHistoricalAttention } from './historical-attention.js';
import { predeparturePresentation } from './predeparture.js';
import { RecordsArea, RecordsToggle } from './RecordsArea.js';
import { RulesArea, RulesToggle, type RulesPane } from './RulesArea.js';
import { RecordsHome } from './RecordsHome.js';
import { FindingWorkContext, type FindingWorkLinks } from './finding-work-context.js';
import type { ChosenSubject } from './RecordSubjects.js';
import { PeopleArea, PeopleToggle } from './PeopleArea.js';
import { readFailureOutcome } from './read-failure.js';

type FeedState = {
  view: OperationView;
  search: string;
  cursor?: string;
  list: FlightListResponse;
  receipts: Receipt[];
  receiptPage: HistoryPage;
};
interface RosterEntry {
  flight: FlightSummary;
  reasons: string[];
  group: RosterGroup;
}
interface MissionPanel {
  scope: string;
  request: MissionRequest;
  navigation: number;
}
export interface AppProps {
  apiUrl: string;
  token: string | (() => Promise<string | null>);
  account?: ReactNode;
  local?: boolean;
  /** Opens the safety section, beside the flights, at a destination. */
  onOpenSafety?: (destination: SafetyDestination) => void;
  /** A flight finding, or a demo flight's mission, the safety section asked to show. */
  request?: FlightRequest;
}

export function App({ apiUrl, token, account, local = false, onOpenSafety, request }: AppProps) {
  const client = useMemo(() => new LedgerClient(apiUrl, token, appFetch), [apiUrl, token]);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  // Where a link from the home opens the Records and Rules areas, numbered so the same link can be followed twice.
  const [recordsAt, setRecordsAt] = useState<{ subject?: ChosenSubject; sequence: number }>({ sequence: 0 });
  const [rulesAt, setRulesAt] = useState<{ pane?: RulesPane; owner?: 'none'; sequence: number }>({ sequence: 0 });
  const [recordsHome, setRecordsHome] = useState<{ scope: string; home: FlightsOnRecordResponse } | null>(null);
  const [recordsHomeError, setRecordsHomeError] = useState<string | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [feed, setFeed] = useState<FeedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(true);
  const [overviewRequest, setOverviewRequest] = useState(0);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [rosterView, setRosterView] = useState<OperationView>('monitor');
  const [operationView, setOperationView] = useState<Exclude<OperationView, 'history'>>('monitor');
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const [historyRefreshed, setHistoryRefreshed] = useState(false);
  const [sources, setSources] = useState<{ scope: string; capabilities: SourceCapability[] } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [receiptCursor, setReceiptCursor] = useState<string | undefined>();
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [mission, setMission] = useState<MissionPanel | null>(null);
  const [missionPanels, setMissionPanels] = useState<Record<string, MissionPanel>>({});
  const [showMission, setShowMission] = useState(false);
  const [focusedRecord, setFocusedRecord] = useState<{ flightId: string; id: string; sequence: number } | undefined>();
  const [focusedFinding, setFocusedFinding] = useState<{ id: string; sequence: number } | undefined>();
  const authority = useRef<string | null>(null);
  const missionTrigger = useRef<HTMLElement | null>(null);
  const selection = useRef<FlightSummary | null>(null);
  const navigation = useRef(0);
  const principalScope = principal ? `${principal.id}:${principal.tenantId}:${principal.revision}` : null;
  const packetRequests = useDecisionPacketRequests(client, principal);
  const historicalAttention = useHistoricalAttention(client, principal);
  const historicalAttentionDescription =
    historicalAttention.present === true
      ? `Historical issues need attention across this operator's records, including records outside this search.${historicalAttention.interrupted ? ` Refresh interrupted; last confirmed ${time(historicalAttention.checkedAt ?? undefined, true)} ${timeZoneLabel()}.` : ''}`
      : historicalAttention.present === false
        ? 'No historical issues found across this operator’s records.'
        : 'Historical issue status is not yet confirmed.';
  const missionActive = showMission && mission?.scope === principalScope;
  useEffect(() => {
    setMissionPanels((previous) => {
      const retained = Object.fromEntries(
        Object.entries(previous).filter(([, panel]) => panel.scope === principalScope),
      );
      if (mission && mission.scope === principalScope) retained[mission.request.flight.id] = mission;
      return retained;
    });
  }, [mission, principalScope]);

  function changeView(view: OperationView) {
    navigation.current += 1;
    setOverviewRequest((previous) => previous + 1);
    setShowOverview(true);
    setShowMission(false);
    setShowUnresolved(false);
    if (view === rosterView) return;
    setRosterView(view);
    if (view !== 'history') setOperationView(view);
    setHistoryCursor(undefined);
    setHistoryRefreshed(false);
  }

  const canSafety = Boolean(onOpenSafety && principal?.capabilities.includes('sms:read'));
  const findingWork = useMemo<FindingWorkLinks>(
    () => ({
      principal,
      ...(canSafety && principal?.capabilities.includes('sms:write')
        ? {
            openHazard: (finding, subjectLabel) =>
              onOpenSafety!({
                view: 'finding',
                finding: {
                  findingId: finding.id,
                  flightLabel: subjectLabel,
                  ...(finding.subject.scope === 'ledger' && finding.subject.kind === 'flight'
                    ? { flightId: finding.subject.id }
                    : {}),
                },
              }),
          }
        : {}),
    }),
    [principal, canSafety, onOpenSafety],
  );
  // An organization with no order source on record opens on its flights on record; one with a source, on the operation.
  const areaOpen = recordsOpen || rulesOpen || peopleOpen;
  useEffect(() => {
    if (!principalScope || !principal?.capabilities.includes('evidence:read') || areaOpen) return;
    let current = true;
    client.flightsOnRecord().then(
      (home) => {
        if (!current) return;
        setRecordsHome({ scope: principalScope, home });
        setRecordsHomeError(null);
      },
      (failure: unknown) => current && setRecordsHomeError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [client, principalScope, areaOpen]);
  const shownRecordsHome = recordsHome?.scope === principalScope ? recordsHome.home : null;
  const recordsOnly = shownRecordsHome?.orderSource === false;

  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || !principalScope || handledRequest.current === request.sequence) return;
    handledRequest.current = request.sequence;
    if (request.kind === 'demo-mission')
      openMission(request.flight, undefined, undefined, navigation.current, request.demo);
    else void inspectSafetyFlight(request.flightId, request.findingId, navigation.current);
  }, [request, principalScope]);

  function returnToFlight() {
    const destination = ++navigation.current;
    setShowOverview(false);
    setShowMission(false);
    requestAnimationFrame(() => {
      if (navigation.current !== destination) return;
      restoreWorkspaceFocus(null, '.flight-workspace-view .thread-main');
    });
  }

  function openMission(
    flight: FlightSummary,
    releaseId?: string,
    briefingId?: string,
    expectedNavigation = navigation.current,
    demo?: AvoidanceDemoMission,
  ) {
    if (!principalScope || expectedNavigation !== navigation.current) return;
    const destination = ++navigation.current;
    const capturedFlight = structuredClone(flight);
    missionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMission((previous) => ({
      scope: principalScope,
      navigation: destination,
      request: {
        sequence: (previous?.request.sequence ?? 0) + 1,
        flight: capturedFlight,
        ...(releaseId ? { releaseId } : {}),
        ...(briefingId ? { briefingId } : {}),
        ...(demo ? { demo } : {}),
      },
    }));
    setShowOverview(false);
    setShowMission(true);
    setShowUnresolved(false);
  }

  function returnFromMission(expectedNavigation: number, inspectFlight = false) {
    if (mission?.scope !== principalScope || expectedNavigation !== navigation.current) return;
    const destination = ++navigation.current;
    // A demo flight's mission was opened from its accepted control's safety record: return there.
    if (mission.request.demo && !inspectFlight && onOpenSafety) {
      const { reference } = mission.request.demo.control;
      setShowMission(false);
      setShowOverview(true);
      onOpenSafety({ view: 'record', id: reference.controlId, kind: 'control' });
      return;
    }
    const flight = retainFlight(mission.request.flight, feed?.list.flights ?? []);
    selection.current = flight;
    setSelectedId(flight.id);
    setShowOverview(false);
    setShowMission(false);
    requestAnimationFrame(() => {
      if (navigation.current !== destination) return;
      restoreWorkspaceFocus(missionTrigger.current, '.flight-workspace-view .thread-main');
    });
  }

  /** Opens a hazard or control on its safety record page; the mission stays open behind it. */
  function openSafetyRecord(id: string, kind: 'hazard' | 'control', expectedNavigation: number) {
    if (!onOpenSafety || expectedNavigation !== navigation.current) return;
    onOpenSafety({ view: 'record', id, kind });
  }

  async function inspectSafetyFlight(id: string, findingId: string, expectedNavigation: number) {
    if (expectedNavigation !== navigation.current) return;
    const destination = ++navigation.current;
    if (id === selection.current?.id) {
      setFocusedFinding((previous) => ({ id: findingId, sequence: (previous?.sequence ?? 0) + 1 }));
      returnToFlight();
      return;
    }
    const scope = authority.current;
    try {
      const result = await client.timeline(id);
      if (authority.current !== scope || navigation.current !== destination) return;
      selection.current = result.flight;
      setSelectedId(id);
      setFocusedFinding((previous) => ({ id: findingId, sequence: (previous?.sequence ?? 0) + 1 }));
      setShowUnresolved(false);
      returnToFlight();
    } catch (failure) {
      if (authority.current === scope && navigation.current === destination) setError(errorMessage(failure));
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(filter.trim());
      setHistoryCursor(undefined);
      setHistoryRefreshed(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    if (!principalScope) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshSources() {
      try {
        const result = await client.request<{ capabilities: SourceCapability[] }>('/v1/sources');
        if (!stopped) {
          setSources({ scope: principalScope!, capabilities: result.capabilities });
          setSourceError(null);
        }
      } catch (failure) {
        if (!stopped) setSourceError(errorMessage(failure));
      }
      if (!stopped) timer = setTimeout(() => void refreshSources(), 60_000);
    }
    setSourceError(null);
    void refreshSources();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, principalScope]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const session = await client.request<CurrentPrincipalResponse>('/v1/me');
        if (stopped) return;
        setTimeZone(session.organization?.timeZone);
        setOrganizationName(session.organization?.name ?? null);
        const scope = `${session.principal.id}:${session.principal.tenantId}:${session.principal.revision}`;
        let cursor = receiptCursor;
        if (authority.current && authority.current !== scope) {
          navigation.current += 1;
          setShowOverview(true);
          cursor = undefined;
          setReceiptCursor(undefined);
          setFeed(null);
          setSelectedId(null);
          selection.current = null;
          setSources(null);
          setHistoryCursor(undefined);
          setHistoryRefreshed(false);
          setMission(null);
          setShowMission(false);
        }
        authority.current = scope;
        setPrincipal(session.principal);
        const receiptRead = async () => {
          try {
            return await client.receipts({
              linkStatus: 'unlinked',
              excludeKind: 'order.revision',
              limit: 200,
              ...(cursor ? { cursor } : {}),
            });
          } catch (failure) {
            if (
              failure instanceof ApiError &&
              failure.status === 400 &&
              (failure.body as { error?: { code?: string } })?.error?.code === 'cursor_scope_mismatch'
            ) {
              if (!stopped) setReceiptCursor(undefined);
              return client.receipts({ linkStatus: 'unlinked', excludeKind: 'order.revision', limit: 200 });
            }
            throw failure;
          }
        };
        let historyRecovered = false;
        const rosterRead = async () => {
          try {
            return await client.flights({ view: rosterView, limit: 100, cursor: historyCursor, search });
          } catch (failure) {
            if (
              failure instanceof ApiError &&
              failure.status === 400 &&
              (failure.body as { error?: { code?: string } })?.error?.code === 'cursor_scope_mismatch'
            ) {
              const latest = await client.flights({ view: rosterView, limit: 100, search });
              historyRecovered = true;
              return latest;
            }
            throw failure;
          }
        };
        const [rosterResult, receiptResult] = await Promise.allSettled([rosterRead(), receiptRead()]);
        if (stopped) return;
        if (rosterResult.status === 'rejected') throw rosterResult.reason;
        if (receiptResult.status === 'rejected') throw receiptResult.reason;
        const list = rosterResult.value;
        const receipts = receiptResult.value;
        if (historyRecovered) {
          setHistoryCursor(undefined);
          setHistoryRefreshed(true);
        }
        setFeed({
          view: rosterView,
          search,
          cursor: historyRecovered ? undefined : historyCursor,
          list,
          receipts: receipts.receipts,
          receiptPage: receipts.page,
        });
        setPrincipal(session.principal);
        if (selection.current) selection.current = retainFlight(selection.current, list.flights);
        setSelectedId(selection.current?.id ?? null);
        setError(null);
        setRefreshedAt(new Date().toISOString());
      } catch (failure) {
        if (!stopped) {
          // The session and its lists name no record the API could hide behind a 404.
          if (readFailureOutcome(failure, false) === 'access_lost') {
            navigation.current += 1;
            setShowOverview(true);
            setFeed(null);
            setPrincipal(null);
            setSelectedId(null);
            selection.current = null;
            setReceiptCursor(undefined);
            setHistoryCursor(undefined);
            setHistoryRefreshed(false);
            setSources(null);
            authority.current = null;
            setMission(null);
            setShowMission(false);
          }
          setError(errorMessage(failure));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, receiptCursor, rosterView, historyCursor, search]);

  const shownFeed = feed?.view === rosterView && feed.search === search && feed.cursor === historyCursor ? feed : null;
  const flights = shownFeed?.list.flights ?? [];
  const roster: RosterEntry[] = flights.map((flight) => {
    const reasons = attentionReasons(flight);
    return { flight, reasons, group: rosterGroup(flight, reasons) };
  });
  const visibleRoster = roster;
  const visibleGroups: typeof rosterGroups =
    rosterView === 'monitor'
      ? rosterGroups
      : [{ key: 'done' as const, label: rosterView === 'history' ? 'Completed' : 'Flight records' }];
  const selected =
    roster.find((entry) => entry.flight.id === selectedId) ??
    (selection.current?.id === selectedId
      ? {
          flight: selection.current,
          reasons: attentionReasons(selection.current),
          group: rosterGroup(selection.current, attentionReasons(selection.current)),
        }
      : undefined);
  const visibleSelection = showOverview ? null : selectedId;
  const currentNavigation = navigation.current;
  const viewLabel =
    rosterView === 'history' ? 'Flight history' : operationViews.find((item) => item.view === rosterView)!.label;
  const clearUnresolved = useCallback(() => setShowUnresolved(false), []);
  const unlinkedCount = feed ? `${feed.receipts.length}${feed.receiptPage.hasMore || receiptCursor ? '+' : ''}` : '—';
  const latestReport = flights.reduce<string | undefined>((latest, flight) => {
    if (!flight.lastReceivedAt) return latest;
    return !latest || flight.lastReceivedAt > latest ? flight.lastReceivedAt : latest;
  }, undefined);
  const picture = picturePhrase(latestReport);

  return (
    <div className="workspace">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Ledger operations">
          <Mark />
          <span>LEDGER</span>
        </a>
        <span className="topbar-divider" />
        <span className="topbar-operator">
          <span className="topbar-label">Operator</span>
          <strong>{principal ? organizationLabel(principal.tenantId, organizationName) : 'Loading operator'}</strong>
        </span>
        {/* Only the seeded fictional organizations are a simulation; an organization of its own is shown as itself. */}
        {principal && seededOrganization(principal.tenantId) && (
          <SimulationPill local={local} connected={!error && Boolean(refreshedAt)} />
        )}
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
        {canSafety && <Button onClick={() => onOpenSafety!({ view: 'home' })}>Safety</Button>}
        <RecordsToggle
          principal={principal}
          open={recordsOpen}
          onToggle={() => {
            setRulesOpen(false);
            setPeopleOpen(false);
            setRecordsOpen((open) => !open);
          }}
        />
        <RulesToggle
          principal={principal}
          open={rulesOpen}
          onToggle={() => {
            setRecordsOpen(false);
            setPeopleOpen(false);
            setRulesOpen((open) => !open);
          }}
        />
        <PeopleToggle
          principal={principal}
          open={peopleOpen}
          onToggle={() => {
            setRecordsOpen(false);
            setRulesOpen(false);
            setPeopleOpen((open) => !open);
          }}
        />
        {account}
      </header>
      <FindingWorkContext.Provider value={findingWork}>
        {recordsOpen && (
          <RecordsArea
            key={recordsAt.sequence}
            client={client}
            principal={principal}
            initialSubject={recordsAt.subject}
            onOpenDocument={
              canSafety
                ? (id) => {
                    setRecordsOpen(false);
                    onOpenSafety!({ view: 'record', id, kind: 'document' });
                  }
                : undefined
            }
          />
        )}
        {rulesOpen && (
          <RulesArea
            key={rulesAt.sequence}
            client={client}
            principal={principal}
            initialPane={rulesAt.pane}
            initialOwner={rulesAt.owner}
          />
        )}
        {peopleOpen && <PeopleArea client={client} principal={principal} />}
        {recordsOnly && !areaOpen && (
          <RecordsHome
            home={shownRecordsHome}
            error={recordsHomeError}
            onOpenFlight={(flight) => {
              setRecordsAt((previous) => ({
                subject: { kind: 'flight', id: flight.id, name: flight.name },
                sequence: previous.sequence + 1,
              }));
              setRulesOpen(false);
              setPeopleOpen(false);
              setRecordsOpen(true);
            }}
            onOpenFindings={(owner) => {
              setRulesAt((previous) => ({ pane: 'open', owner, sequence: previous.sequence + 1 }));
              setRecordsOpen(false);
              setPeopleOpen(false);
              setRulesOpen(true);
            }}
            onOpenRecords={() => {
              setRecordsAt((previous) => ({ sequence: previous.sequence + 1 }));
              setRulesOpen(false);
              setPeopleOpen(false);
              setRecordsOpen(true);
            }}
          />
        )}
        <main className="operations" hidden={areaOpen || recordsOnly}>
          <aside className="roster" aria-label="Flight monitor">
            <div className="roster-head">
              <div className="roster-views" aria-label="Flight views">
                {(['monitor', 'history'] as const).map((view) => (
                  <button
                    key={view}
                    aria-pressed={
                      !missionActive && (view === 'history' ? rosterView === 'history' : rosterView !== 'history')
                    }
                    onClick={() => changeView(view === 'monitor' ? operationView : 'history')}
                  >
                    {view === 'monitor' ? 'Operation' : 'History'}
                  </button>
                ))}
                {canSafety && (
                  <button aria-pressed={false} onClick={() => onOpenSafety!({ view: 'register' })}>
                    Hazards
                  </button>
                )}
              </div>
              <div className="operation-scopes" role="group" aria-label="Operation scope">
                {operationViews.map(({ view, label }) => (
                  <button
                    key={view}
                    aria-pressed={rosterView === view}
                    aria-describedby={view === 'historical-issues' ? 'historical-attention-status' : undefined}
                    title={view === 'historical-issues' ? historicalAttentionDescription : undefined}
                    data-attention={
                      view === 'historical-issues'
                        ? historicalAttention.present === true
                          ? 'present'
                          : historicalAttention.present === false
                            ? 'clear'
                            : 'unknown'
                        : undefined
                    }
                    onClick={() => changeView(view)}
                  >
                    {label}
                    {view === 'historical-issues' && historicalAttention.present === true && (
                      <svg className="scope-annunciator" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M8 1 15 14H1Z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" />
                        <path d="M8 5v4" stroke="var(--paper)" strokeWidth="1.7" strokeLinecap="round" />
                        <circle cx="8" cy="11.5" r=".9" fill="var(--paper)" />
                      </svg>
                    )}
                    {view === 'historical-issues' && historicalAttention.present === null && (
                      <span className="scope-unconfirmed" aria-hidden="true">
                        ?
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <span id="historical-attention-status" className="sr-only">
                {historicalAttentionDescription}
              </span>
              <h1>
                {rosterView === 'history'
                  ? 'Flight history'
                  : rosterView === 'historical-issues'
                    ? viewLabel
                    : `${viewLabel} flights`}{' '}
                <span>{shownFeed ? `${flights.length}${shownFeed.list.nextCursor ? '+' : ''} shown` : '—'}</span>
              </h1>
              <p className="roster-scope-caption">
                {rosterView === 'history'
                  ? 'Recorded flights with no outstanding issues.'
                  : operationViews.find((item) => item.view === rosterView)!.description}
              </p>
              <label className="roster-search">
                <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                  <circle cx="5.5" cy="5.5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8.7 8.7L12 12" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <input
                  aria-label="Find flight"
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Flight, aircraft, or order"
                />
              </label>
            </div>
            <div className="roster-list">
              {historyRefreshed && (
                <p className="awaiting-order-status" role="status">
                  {rosterView === 'history' ? 'History' : 'Flight list'} refreshed to newest records.
                </p>
              )}
              {!shownFeed && !error && (
                <div className="roster-empty">
                  <Spinner label="Loading flight records" />
                </div>
              )}
              {shownFeed && visibleRoster.length === 0 && (
                <div className="roster-empty">
                  <strong>
                    {filter
                      ? 'No matching flights'
                      : rosterView === 'history'
                        ? 'No completed flights'
                        : `No ${viewLabel.toLowerCase()} flights`}
                  </strong>
                  <p>
                    {filter
                      ? 'Try a different flight, aircraft, or order.'
                      : rosterView === 'history'
                        ? 'Completed flights appear here once their exceptions have been handled.'
                        : 'Other operation scopes and History remain available.'}
                  </p>
                </div>
              )}
              {visibleGroups.map((group) => {
                const entries =
                  rosterView !== 'monitor' ? visibleRoster : visibleRoster.filter((entry) => entry.group === group.key);
                return (
                  <Fragment key={group.key}>
                    {((rosterView === 'monitor' && group.key === 'scheduled') || rosterView === 'overdue') &&
                      principal?.capabilities.includes('order:read') && (
                        <AwaitingOrders
                          key={`${principalScope}:${rosterView}`}
                          client={client}
                          view={rosterView === 'overdue' ? 'awaiting-overdue' : 'awaiting-current'}
                        />
                      )}
                    {entries.length > 0 && (
                      <section
                        key={group.key}
                        className={`roster-group roster-group--${group.key}`}
                        aria-label={group.label}
                      >
                        <h2>
                          {group.label} <span className="roster-count">{entries.length}</span>
                        </h2>
                        <p className="awaiting-order-status">Newest by creation time</p>
                        {entries.map((entry) => (
                          <FlightRow
                            key={entry.flight.id}
                            entry={entry}
                            showActivity={group.implies !== entry.flight.activity}
                            selected={entry.flight.id === visibleSelection}
                            onSelect={() => {
                              navigation.current += 1;
                              setShowOverview(false);
                              selection.current = entry.flight;
                              setSelectedId(entry.flight.id);
                              setShowUnresolved(false);
                              setShowMission(false);
                            }}
                          />
                        ))}
                      </section>
                    )}
                  </Fragment>
                );
              })}
              {(historyCursor || shownFeed?.list.nextCursor) && (
                <div className="history-navigation">
                  {historyCursor && (
                    <Button
                      kind="quiet"
                      onClick={() => {
                        setHistoryCursor(undefined);
                        setHistoryRefreshed(false);
                      }}
                    >
                      First page
                    </Button>
                  )}
                  {shownFeed?.list.nextCursor && (
                    <Button
                      kind="quiet"
                      disabled={shownFeed.list.nextCursor === historyCursor}
                      onClick={() => {
                        setHistoryCursor(shownFeed.list.nextCursor!);
                        setHistoryRefreshed(false);
                      }}
                    >
                      {rosterView === 'history' ? 'More history' : 'More flights'}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="roster-foot">
              <button
                className={`unlinked-card ${feed?.receipts.length ? 'has-unlinked' : ''} ${showUnresolved ? 'is-selected' : ''}`}
                aria-pressed={showUnresolved}
                disabled={showOverview || !selected}
                onClick={() => {
                  navigation.current += 1;
                  setShowMission(false);
                  setShowUnresolved(!showUnresolved);
                }}
              >
                <strong>Unlinked evidence · {unlinkedCount}</strong>
                <small>
                  {showOverview || !selected
                    ? 'Select a flight to review observations'
                    : 'Observations no flight could claim'}
                </small>
                <span className="unlinked-action">
                  {showOverview || !selected ? 'Select flight' : showUnresolved ? 'Hide' : 'Review →'}
                </span>
              </button>
              <p
                className={`connection ${error ? 'connection--error' : picture.current ? 'connection--current' : 'connection--stale'}`}
                data-testid="picture-status"
              >
                <i aria-hidden="true" />
                {error ? 'Updates interrupted' : refreshedAt ? picture.text : 'Connecting'}
              </p>
            </div>
          </aside>
          <section
            className="thread-workspace"
            aria-label={
              missionActive ? 'Mission review workspace' : showOverview ? `${viewLabel} overview` : 'Selected flight'
            }
          >
            {shownFeed && (
              <FleetMap
                flights={flights}
                selectedId={visibleSelection}
                tenantId={principal?.tenantId}
                scopeLabel={viewLabel}
                onSelect={(id) => {
                  const flight = flights.find((flight) => flight.id === id);
                  if (!flight) return;
                  navigation.current += 1;
                  setShowOverview(false);
                  selection.current = flight;
                  setSelectedId(id);
                  setShowUnresolved(false);
                  setShowMission(false);
                }}
              />
            )}
            {error && (
              <Notice
                tone="alert"
                title={feed ? 'Updates interrupted · showing last received record' : 'Ledger API unavailable'}
              >
                {error} Retrying every two seconds.
              </Notice>
            )}
            {sourceError && !error && (
              <Notice tone="attention" title="Source details unavailable">
                {sourceError} Retrying in one minute.
              </Notice>
            )}
            {showUnresolved && (
              <div className="unresolved-banner">
                <div>
                  <h2>Unlinked evidence</h2>
                  <p>Inputs waiting for a flight. Pick one to inspect it, then link it to the selected flight.</p>
                </div>
                <Button kind="quiet" onClick={clearUnresolved}>
                  Return to flight
                </Button>
              </div>
            )}
            {showOverview && !missionActive && (
              <OperationOverview
                view={rosterView}
                navigationRequest={overviewRequest}
                page={shownFeed?.list ?? null}
                search={search}
                continued={Boolean(historyCursor)}
                error={error}
                onChooseFlight={() => {
                  const row = document.querySelector<HTMLButtonElement>('.flight-row');
                  row?.scrollIntoView({ block: 'center' });
                  row?.focus({ preventScroll: true });
                }}
                onClearSearch={() => setFilter('')}
              />
            )}
            <div className="flight-workspace-view" hidden={showOverview || missionActive}>
              {selected && (
                <FlightThread
                  key={`${authority.current}:${selected.flight.id}`}
                  active={!showOverview && !missionActive}
                  client={client}
                  cacheScope={
                    principal ? `${principal.id}:${principal.tenantId}:${principal.revision}` : 'awaiting-principal'
                  }
                  selected={selected.flight}
                  crumb={rosterGroups.find((group) => group.key === selected.group)?.label}
                  principal={principal}
                  packetRequests={packetRequests}
                  unresolved={feed?.receipts ?? []}
                  receiptPage={feed?.receiptPage ?? null}
                  onOlderReceipts={() => {
                    if (feed?.receiptPage.nextCursor && feed.receiptPage.nextCursor !== receiptCursor)
                      setReceiptCursor(feed.receiptPage.nextCursor);
                  }}
                  onLatestReceipts={() => setReceiptCursor(undefined)}
                  capabilities={sources?.scope === principalScope ? sources.capabilities : []}
                  showUnresolved={showUnresolved}
                  onSafety={canSafety ? (finding) => onOpenSafety!({ view: 'finding', finding }) : undefined}
                  focusedFinding={focusedFinding}
                  onMission={(releaseId, briefingId) =>
                    openMission(selected.flight, releaseId, briefingId, currentNavigation)
                  }
                  focusedRecord={focusedRecord?.flightId === selected.flight.id ? focusedRecord : undefined}
                />
              )}
              {!selected && (
                <div className="no-selection">
                  <Mark size={36} />
                  <h2>
                    {feed
                      ? rosterView === 'history'
                        ? 'No completed flights in this view'
                        : 'No open flights in this view'
                      : 'Connecting to your operation'}
                  </h2>
                  <p>Select a flight to see its plan, reports, retained evidence and decisions.</p>
                  {!feed && !error && <Spinner label="Reading flight records" />}
                </div>
              )}
            </div>
            {principal &&
              Object.values(missionPanels)
                .filter((panel) => panel.scope === principalScope)
                .map((retained) => {
                  const current =
                    mission?.request.flight.id === retained.request.flight.id && mission.scope === principalScope
                      ? mission
                      : retained;
                  const active = Boolean(missionActive && mission?.request.flight.id === retained.request.flight.id);
                  return (
                    <div
                      key={`${principalScope}:${retained.request.flight.id}`}
                      className="mission-workspace-view"
                      hidden={!active}
                    >
                      <MissionWorkspace
                        active={active}
                        client={client}
                        principal={principal}
                        request={current.request}
                        onReturnToFlight={() => returnFromMission(current.navigation)}
                        onOpenSafetyRecord={
                          canSafety ? (id, kind) => openSafetyRecord(id, kind, current.navigation) : undefined
                        }
                        onInspectRelease={(id) => {
                          if (current.scope !== principalScope || current.navigation !== navigation.current) return;
                          setFocusedRecord((previous) => ({
                            flightId: current.request.flight.id,
                            id,
                            sequence: (previous?.sequence ?? 0) + 1,
                          }));
                          returnFromMission(current.navigation, true);
                        }}
                      />
                    </div>
                  );
                })}
          </section>
        </main>
      </FindingWorkContext.Provider>
    </div>
  );
}

function restoreWorkspaceFocus(trigger: HTMLElement | null, fallback: string) {
  const target =
    trigger?.isConnected && !trigger.closest('[hidden]')
      ? trigger
      : [...document.querySelectorAll<HTMLElement>(fallback)].find((element) => !element.closest('[hidden]'));
  target?.focus({ preventScroll: true });
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

function SimulationPill({ local, connected }: { local: boolean; connected: boolean }) {
  return (
    <details className="simulation">
      <summary className="simulation-pill">
        <i className={`pulse ${connected ? '' : 'pulse--stale'}`} aria-hidden="true" />
        Simulation · fictional operators
      </summary>
      <div className="simulation-popover">
        <h2>Simulation & limits</h2>
        <ul>
          <li>Every operator, aircraft and person is fictional.</li>
          <li>Vendor systems are emulated.</li>
          <li>Each source shows a fidelity badge for how closely it matches the real system.</li>
          <li>
            Reported activity and position freshness are shown separately. Connection alone does not confirm flight
            status.
          </li>
          <li>{local ? 'Running in local development.' : 'Running in private staging.'}</li>
        </ul>
      </div>
    </details>
  );
}

function FlightRow({
  entry,
  showActivity,
  selected,
  onSelect,
}: {
  entry: RosterEntry;
  showActivity: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { flight, reasons } = entry;
  const presentation = activityPresentation(flight);
  const operation = operationDisplay(flight);
  const predeparture = flight.operation?.predeparture ? predeparturePresentation(flight.operation.predeparture) : null;
  const current = attentionOwner(flight);
  const line = ownershipLine(flight);
  const aircraft = aircraftLabel(flight.aircraft);
  const aircraftId = `flight-aircraft-${flight.id}`;
  const [identityDismissed, setIdentityDismissed] = useState(false);
  const [identityActive, setIdentityActive] = useState(false);
  useEffect(() => {
    if (!identityActive || identityDismissed) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIdentityDismissed(true);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [identityActive, identityDismissed]);
  return (
    <button
      className={`flight-row ${entry.group === 'attention' ? 'needs-attention' : ''} ${selected ? 'is-selected' : ''} ${identityDismissed ? 'identity-dismissed' : ''}`}
      data-testid={`flight-row-${flight.id}`}
      aria-pressed={selected}
      aria-describedby={aircraftId}
      onMouseEnter={() => {
        setIdentityDismissed(false);
        setIdentityActive(true);
      }}
      onMouseLeave={(event) => setIdentityActive(event.currentTarget.matches(':focus-visible'))}
      onFocus={() => {
        setIdentityDismissed(false);
        setIdentityActive(true);
      }}
      onBlur={(event) => setIdentityActive(event.currentTarget.matches(':hover'))}
      onClick={onSelect}
    >
      <span className="flight-row-name">{flight.label}</span>
      <span className="flight-row-activity" title={presentation.detail ?? undefined}>
        {showActivity || !presentation.current ? presentation.label : ''}
      </span>
      {reasons.map((reason) => (
        <span key={reason} className="flight-row-reason">
          {reason}
        </span>
      ))}
      {operation.reason && <span className="flight-row-operation">{operation.reason}</span>}
      {predeparture && (
        <span className={`flight-row-predeparture ${predeparture.attention ? 'needs-attention' : ''}`}>
          {predeparture.label}
        </span>
      )}
      {entry.group === 'attention' && (
        <span className={current ? 'flight-row-owner' : 'flight-row-reason'}>{line}</span>
      )}
      {entry.group !== 'attention' && current && <span className="flight-row-owner">{line}</span>}
      <span className="flight-row-meta mono">
        <span className="flight-row-aircraft" aria-hidden="true">
          <span className="flight-row-aircraft-prefix">{aircraft.slice(0, -17)}</span>
          <span className="flight-row-aircraft-suffix">{aircraft.slice(-17)}</span>
        </span>
        {operation.mission && <span>{operation.mission}</span>}
        {operation.window && (
          <span>
            {operation.windowLabel}: {operation.window}
          </span>
        )}
        {operation.requested && <span>Requested window: {operation.requested}</span>}
      </span>
      <span id={aircraftId} className="flight-row-aircraft-full mono" role="tooltip">
        {aircraft}
      </span>
      <span className="flight-row-age mono">
        {flight.activity === 'active' && presentation.current && <i className="live-dot" aria-hidden="true" />}
        {presentation.observedAt
          ? `Activity observed ${age(presentation.observedAt)}`
          : flight.lastReceivedAt
            ? `Received ${age(flight.lastReceivedAt)}`
            : ''}
        {flight.operation?.activityReport && (
          <span>Report received {age(flight.operation.activityReport.receivedAt)}</span>
        )}
      </span>
      <span className="sr-only">
        Flight {shortId(flight.id)}, revision {flight.revision}
      </span>
    </button>
  );
}
