import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appFetch, demonstration } from './transport.js';
import { LedgerClient } from '@ledger/contracts/client';
import { readsOnly, standardRiskMatrix } from '@ledger/contracts';
import type {
  Principal,
  SmsHomeResponse,
  SmsRecordKind,
  SmsRecordSummary,
  SmsRegisterResponse,
  CurrentPrincipalResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { setTimeZone, shortId, time, timeZoneLabel } from './format.js';
import { seededOrganization } from './labels.js';
import { authorityLabels, plainError } from './sms-labels.js';
import { PeriodExportForm } from './SmsExport.js';
import { DraftDocumentForm, IdentifyHazardForm } from './SmsForms.js';
import { SmsRecordView } from './SmsRecord.js';
import { DocumentReviewsDue, MyDocumentReading, OrganizationReading } from './SmsDocumentControl.js';
import { DocumentLibrary } from './SmsDocumentLibrary.js';
import { RegisterMore } from './SmsRegisterTools.js';
import { FindingHazard, HazardRegister, RecordRow } from './SmsHazards.js';
import { FirstSteps } from './FirstSteps.js';
import { firstStepPlace, type FirstStepTarget } from './first-steps.js';
import { RiskMatrixForm } from './RiskMatrixForm.js';
import { mayRecordReports, ReportsRegister } from './SmsReports.js';
import { AssuranceActionsDue, AssuranceRegister } from './SmsAssurance.js';
import type { FlightFinding, FlightLinks } from './safety-navigation.js';
import { readFailureOutcome } from './read-failure.js';
import { barSection, goTo, placeTitle, usePlace, type Place } from './place.js';
import { OrganizationBadge } from './OrganizationBadge.js';
import { offeredSections, PlaceLink, TopBar } from './TopBar.js';
import { SectionArea, SectionUnavailable } from './SectionArea.js';

/** Whether a person reads the controlled documents and no other safety record. */
export function onlyDocuments(principal: Pick<Principal, 'capabilities'>): boolean {
  return principal.capabilities.includes('document:read') && !principal.capabilities.includes('sms:read');
}

/** A new sign-in at the identity provider, which a signature needs; returns when it happened. */
export type ConfirmIdentity = () => Promise<{ authenticatedAt: string }>;
export interface SmsAppProps {
  apiUrl: string;
  token: string | (() => Promise<string | null>);
  /** Reporting a safety concern, which the bar keeps one click away. */
  report?: ReactNode;
  account?: ReactNode;
  local?: boolean;
  confirmIdentity?: ConfirmIdentity;
  /** Present when the safety section sits beside the flights, in one organization that flies. */
  flights?: FlightLinks;
}
export type Screen =
  | { view: 'home' }
  | { view: 'register' }
  | { view: 'documents'; drafting?: boolean }
  | { view: 'reports' }
  | { view: 'assurance' }
  | { view: 'new-matrix' }
  | { view: 'finding'; finding: FlightFinding }
  | {
      view: 'record';
      id: string;
      kind: SmsRecordKind;
      sign?: boolean;
      issueId?: string;
      read?: boolean;
      from?: FlightFinding;
    };

/** The screen a safety place shows, with what the move to it kept: the finding a hazard came from, a signature to start. */
function screenOf(place: Place, extras: Record<string, unknown>): Screen {
  if (place.section !== 'safety') return { view: 'home' };
  const from = extras.from as FlightFinding | undefined;
  switch (place.view) {
    case 'hazards':
      return { view: 'register' };
    case 'documents':
      return { view: 'documents', ...(extras.drafting ? { drafting: true } : {}) };
    case 'new-risk-matrix':
      return { view: 'new-matrix' };
    case 'finding':
      return {
        view: 'finding',
        finding: {
          findingId: place.findingId,
          ...(place.flightId ? { flightId: place.flightId } : {}),
          flightLabel:
            typeof extras.flightLabel === 'string'
              ? extras.flightLabel
              : place.flightId
                ? `flight ${shortId(place.flightId)}`
                : 'the finding',
        },
      };
    case 'record':
      return {
        view: 'record',
        id: place.id,
        kind: place.kind,
        ...(place.issueId ? { issueId: place.issueId } : {}),
        ...(extras.sign ? { sign: true } : {}),
        ...(extras.read ? { read: true } : {}),
        ...(from ? { from } : {}),
      };
    default:
      return { view: place.view };
  }
}

/** The place a safety screen has, and what the move to it keeps that the address does not hold. */
export function safetyPlace(screen: Screen): { place: Place; extras: Record<string, unknown> } {
  switch (screen.view) {
    case 'register':
      return { place: { section: 'safety', view: 'hazards' }, extras: {} };
    case 'documents':
      return { place: { section: 'safety', view: 'documents' }, extras: screen.drafting ? { drafting: true } : {} };
    case 'new-matrix':
      return { place: { section: 'safety', view: 'new-risk-matrix' }, extras: {} };
    case 'finding':
      return {
        place: {
          section: 'safety',
          view: 'finding',
          findingId: screen.finding.findingId,
          ...(screen.finding.flightId ? { flightId: screen.finding.flightId } : {}),
        },
        extras: { flightLabel: screen.finding.flightLabel },
      };
    case 'record':
      return {
        place: {
          section: 'safety',
          view: 'record',
          kind: screen.kind,
          id: screen.id,
          ...(screen.issueId ? { issueId: screen.issueId } : {}),
        },
        extras: {
          ...(screen.sign ? { sign: true } : {}),
          ...(screen.read ? { read: true } : {}),
          ...(screen.from ? { from: screen.from } : {}),
        },
      };
    default:
      return { place: { section: 'safety', view: screen.view }, extras: {} };
  }
}

export function SmsApp({ apiUrl, token, report, account, local = false, confirmIdentity, flights }: SmsAppProps) {
  const client = useMemo(() => new LedgerClient(apiUrl, token, appFetch), [apiUrl, token]);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const { place, extras } = usePlace();
  const screen = screenOf(place, extras);
  const setScreen = (next: Screen) => {
    const { place: shown, extras: kept } = safetyPlace(next);
    goTo(shown, { extras: kept });
  };
  const inSafety = place.section === 'safety';
  useEffect(() => {
    document.title = placeTitle(place);
  }, [place]);
  const [home, setHome] = useState<SmsHomeResponse | null>(null);
  const [register, setRegister] = useState<SmsRegisterResponse | null>(null);
  const [documents, setDocuments] = useState<SmsRecordSummary[] | null>(null);
  const [reports, setReports] = useState<SmsRecordSummary[] | null>(null);
  const [assurance, setAssurance] = useState<SmsRecordSummary[] | null>(null);
  // The first page of each register, as read: its registers read the pages after it.
  const [reportRegister, setReportRegister] = useState<SmsRegisterResponse | null>(null);
  const [assuranceRegister, setAssuranceRegister] = useState<SmsRegisterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownDocuments, setOwnDocuments] = useState(0);
  // Where the documents and risk matrices read so far end, for the documents register to read further.
  const [documentsAfter, setDocumentsAfter] = useState<DocumentPages>([]);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const principalRef = useRef<Principal | null>(null);
  const documentsOnly = Boolean(principal && onlyDocuments(principal));
  // A person who reads only the documents has no safety home or other register: Safety opens on the documents.
  useEffect(() => {
    if (!documentsOnly || !inSafety || screen.view === 'documents' || screen.view === 'record') return;
    goTo({ section: 'safety', view: 'documents' }, { replace: true });
  }, [documentsOnly, inSafety, screen.view]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        // A person who reads the controlled documents and no other safety record reads only those registers.
        const known = principalRef.current;
        const documentsOnly = Boolean(known && onlyDocuments(known));
        const none = async (): Promise<SmsRegisterResponse> => ({
          records: [],
          limit: 0,
          hasMore: false,
          nextCursor: null,
          computedAt: new Date().toISOString(),
        });
        const [session, shownHome, shownRegister, shownDocuments, shownMatrices, shownReports, shownAssurance] =
          await Promise.all([
            client.request<CurrentPrincipalResponse>('/v1/me'),
            client.request<SmsHomeResponse>('/v1/sms/home'),
            documentsOnly ? none() : client.request<SmsRegisterResponse>('/v1/sms/records?kind=hazard'),
            client.request<SmsRegisterResponse>('/v1/sms/records?kind=document'),
            client.request<SmsRegisterResponse>('/v1/sms/records?kind=risk_matrix'),
            documentsOnly ? none() : client.request<SmsRegisterResponse>('/v1/sms/records?kind=report'),
            // A demonstration recorded before safety assurance records existed has no such read; it shows none.
            documentsOnly
              ? none()
              : client.request<SmsRegisterResponse>('/v1/sms/records?kind=assurance').catch(() => null),
          ]);
        if (stopped) return;
        principalRef.current = session.principal;
        setTimeZone(session.organization?.timeZone);
        setOrganizationName(session.organization?.name ?? null);
        setPrincipal(session.principal);
        setReports(shownReports.records);
        setAssurance(shownAssurance?.records ?? []);
        setReportRegister(shownReports);
        setAssuranceRegister(shownAssurance ?? { ...shownReports, records: [], hasMore: false, nextCursor: null });
        setHome(shownHome);
        setRegister(shownRegister);
        setDocuments([...shownDocuments.records, ...shownMatrices.records]);
        setOwnDocuments(shownDocuments.records.length);
        setDocumentsAfter(
          [
            { kind: 'document' as const, cursor: shownDocuments.nextCursor },
            { kind: 'risk_matrix' as const, cursor: shownMatrices.nextCursor },
          ].filter((page): page is DocumentPages[number] => page.cursor !== null),
        );
        setError(null);
      } catch (failure) {
        if (stopped) return;
        // A person who reads only the documents was refused the other registers: read again knowing who they are.
        if (!principalRef.current) {
          const session = await client.request<CurrentPrincipalResponse>('/v1/me').catch(() => null);
          if (stopped) return;
          principalRef.current = session?.principal ?? null;
          if (session && onlyDocuments(session.principal)) {
            void poll();
            return;
          }
        }
        // The session and its registers name no record the API could hide behind a 404.
        if (readFailureOutcome(failure, false) === 'access_lost') {
          setHome(null);
          setRegister(null);
        }
        setError(plainError(failure).message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 4000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, reload]);

  const open = (record: Pick<SmsRecordSummary, 'id' | 'kind'>, sign = false, issueId?: string, read = false) =>
    setScreen({ view: 'record', id: record.id, kind: record.kind, sign, issueId, read });
  const start = (target: FirstStepTarget) => {
    const { place: shown, extras: kept } = firstStepPlace(target);
    goTo(shown, { extras: kept });
  };
  const recordScreen = screen.view === 'record' ? screen : null;
  const onReports = screen.view === 'reports' || recordScreen?.kind === 'report';
  const onAssurance = screen.view === 'assurance' || recordScreen?.kind === 'assurance';
  const onDocuments =
    screen.view === 'documents' ||
    screen.view === 'new-matrix' ||
    (recordScreen !== null && !['hazard', 'report', 'assurance'].includes(recordScreen.kind));
  // An organization that flies keeps its adopted matrix in the program card. Documents appears for whoever may
  // start one, and for everyone once the organization records one.
  const flightReader = Boolean(principal?.capabilities.includes('flight:read'));
  const mayStartDocuments = Boolean(principal?.capabilities.includes('sms:configure'));
  const showDocuments = !flightReader || mayStartDocuments || ownDocuments > 0 || onDocuments;
  const showReports =
    Boolean(principal && (mayRecordReports(principal) || principal.capabilities.includes('sms:configure'))) ||
    (reports?.length ?? 0) > 0 ||
    onReports;
  // Safety assurance appears for whoever may record one, and for everyone once the organization records one.
  const showAssurance =
    Boolean(principal?.capabilities.includes('sms:write')) || (assurance?.length ?? 0) > 0 || onAssurance;
  const seeded = Boolean(principal && seededOrganization(principal.tenantId));
  const offered = offeredSections(principal, Boolean(flights));
  const attentionCount = home
    ? new Set(
        [...home.attention.waitingOnMe, ...home.attention.needsAssessment, ...home.attention.overdue]
          .map((item) => item.id)
          .concat(
            (home.reading ?? []).filter((item) => !item.acknowledgedAt).map((item) => item.recordId),
            (home.readingProgress ?? []).filter((item) => item.overdue > 0).map((item) => item.recordId),
            (home.reviewsDue ?? []).filter((item) => item.overdue).map((item) => item.recordId),
            (home.assuranceActions ?? []).flatMap((group) =>
              group.actions.filter((action) => action.overdue).map((action) => action.recordId),
            ),
          ),
      ).size
    : null;

  return (
    <div className="workspace sms-workspace">
      <TopBar
        principal={principal}
        organizationName={organizationName}
        section={barSection(place)}
        offered={offered}
        report={report}
        account={account}
        status={principal && <OrganizationBadge tenantId={principal.tenantId} local={local} />}
      />
      {!inSafety && (
        <SectionArea
          place={place}
          client={client}
          principal={principal}
          offered={offered}
          onOpenDocument={(id) => {
            setScreen({ view: 'record', id, kind: 'document' });
            refresh();
          }}
        />
      )}
      {inSafety && principal && !offered.includes('safety') && <SectionUnavailable section="safety" />}
      <main className="operations" hidden={!inSafety || Boolean(principal && !offered.includes('safety'))}>
        <aside className="roster sms-nav" aria-label="Safety navigation">
          <div className="roster-head">
            <h1>Safety management</h1>
            <nav className="sms-nav-links">
              {!documentsOnly && (
                <>
                  <button
                    aria-current={screen.view === 'home' ? 'page' : undefined}
                    onClick={() => setScreen({ view: 'home' })}
                  >
                    Safety home
                    {attentionCount !== null && attentionCount > 0 && (
                      <span className="sms-count">{attentionCount}</span>
                    )}
                  </button>
                  <button
                    aria-current={
                      screen.view !== 'home' && !onDocuments && !onReports && !onAssurance ? 'page' : undefined
                    }
                    onClick={() => setScreen({ view: 'register' })}
                  >
                    Hazard register
                    {register && (
                      <span className="sms-count sms-count--quiet">
                        {register.records.length}
                        {register.hasMore ? '+' : ''}
                      </span>
                    )}
                  </button>
                </>
              )}
              {(showDocuments || documentsOnly) && (
                <button
                  aria-current={onDocuments ? 'page' : undefined}
                  onClick={() => setScreen({ view: 'documents' })}
                >
                  Documents
                  {documents && <span className="sms-count sms-count--quiet">{documents.length}</span>}
                </button>
              )}
              {showReports && !documentsOnly && (
                <button aria-current={onReports ? 'page' : undefined} onClick={() => setScreen({ view: 'reports' })}>
                  Safety reports
                  {reports && <span className="sms-count sms-count--quiet">{reports.length}</span>}
                </button>
              )}
              {showAssurance && !documentsOnly && (
                <button
                  aria-current={onAssurance ? 'page' : undefined}
                  onClick={() => setScreen({ view: 'assurance' })}
                >
                  Safety assurance
                  {assurance && <span className="sms-count sms-count--quiet">{assurance.length}</span>}
                </button>
              )}
            </nav>
          </div>
          <ProgramCard key={screen.view === 'home' ? 'home' : 'elsewhere'} home={home} open={screen.view === 'home'} />
          <p
            className={`connection ${error ? 'connection--error' : home ? 'connection--current' : 'connection--stale'}`}
          >
            <i aria-hidden="true" />
            {error
              ? 'Updates interrupted'
              : home
                ? `Current as of ${time(home.computedAt)} ${timeZoneLabel()}`
                : 'Connecting'}
          </p>
        </aside>
        <section className="thread-workspace" aria-label="Safety workspace">
          {error && (
            <Notice
              tone="alert"
              title={home ? 'Updates interrupted · showing the last record received' : 'Ledger is unavailable'}
            >
              {error} Retrying every few seconds.
            </Notice>
          )}
          {!home && !error && (
            <div className="thread-main">
              <Spinner label="Loading the safety record" />
            </div>
          )}
          {home && principal && screen.view === 'home' && (
            <SafetyHome
              home={home}
              principal={principal}
              client={client}
              documents={documents ?? []}
              reports={reports ?? []}
              onOpen={open}
              onStart={start}
              onChanged={refresh}
            />
          )}
          {home && principal && screen.view === 'register' && register && (
            <HazardRegister
              register={register}
              home={home}
              principal={principal}
              client={client}
              flights={flights}
              onOpen={open}
              onChanged={refresh}
            />
          )}
          {home && principal && screen.view === 'finding' && (
            <FindingHazard
              key={screen.finding.findingId}
              client={client}
              principal={principal}
              home={home}
              finding={screen.finding}
              flights={flights}
              onOpened={(id) => {
                refresh();
                setScreen({ view: 'record', id, kind: 'hazard', from: screen.finding });
              }}
            />
          )}
          {home && principal && screen.view === 'documents' && documents && (
            <DocumentsRegister
              key={screen.drafting ? 'drafting' : 'listing'}
              drafting={screen.drafting}
              documents={documents}
              after={documentsAfter}
              home={home}
              principal={principal}
              client={client}
              onOpen={open}
              onChanged={refresh}
            />
          )}
          {home && principal && screen.view === 'reports' && reportRegister && (
            <ReportsRegister
              register={reportRegister}
              principal={principal}
              client={client}
              onOpen={open}
              onChanged={refresh}
            />
          )}
          {home && principal && screen.view === 'assurance' && assuranceRegister && (
            <AssuranceRegister
              register={assuranceRegister}
              home={home}
              principal={principal}
              client={client}
              reports={reports ?? []}
              onOpen={open}
              onChanged={refresh}
            />
          )}
          {home && principal && screen.view === 'new-matrix' && (
            <div className="thread-main safety-main">
              <p className="thread-crumbs">Safety / Documents / New risk matrix</p>
              <RiskMatrixForm
                client={client}
                principal={principal}
                start={standardRiskMatrix}
                onRecorded={(id) => {
                  refresh();
                  setScreen({ view: 'record', id, kind: 'risk_matrix' });
                }}
                onCancel={() => setScreen({ view: 'home' })}
              />
            </div>
          )}
          {home && principal && screen.view === 'record' && (
            <SmsRecordView
              key={screen.id}
              id={screen.id}
              client={client}
              principal={principal}
              home={home}
              startSigning={screen.sign ?? false}
              startIssueId={screen.issueId}
              startReading={screen.read}
              confirmIdentity={confirmIdentity}
              from={screen.from}
              flights={flights}
              onBack={(kind) =>
                setScreen({
                  view:
                    kind === 'hazard'
                      ? 'register'
                      : kind === 'report'
                        ? 'reports'
                        : kind === 'assurance'
                          ? 'assurance'
                          : 'documents',
                })
              }
              onOpen={(record) => open(record)}
              onChanged={refresh}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function ProgramCard({ home, open }: { home: SmsHomeResponse | null; open: boolean }) {
  const [expanded, setExpanded] = useState(
    () => open && (typeof window === 'undefined' || !window.matchMedia('(max-width: 700px)').matches),
  );
  const matrix = home?.program.matrix;
  return (
    <details className="sms-program" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Safety program and authority</summary>
      <div className="sms-program-content">
        <h2>Risk matrix</h2>
        {!home && <Spinner label="Loading" />}
        {home && !matrix && (
          <p className="rail-muted">No risk matrix is adopted yet. Hazards can be recorded but not assessed.</p>
        )}
        {matrix && (
          <>
            <strong>{matrix.version.body.name}</strong>
            <small>
              Version {matrix.version.versionNumber} · 5 × 5 · adopted {time(matrix.adoption.recordedAt, true)}{' '}
              {timeZoneLabel()}
            </small>
            {matrix.signature && <small>Signed by {matrix.signature.signer.name}</small>}
          </>
        )}
        {home && home.people.length > 0 && (
          <>
            <h2>Risk acceptance authority</h2>
            <ul className="sms-people">
              {home.people.map((person) => (
                <li key={person.id}>
                  <span>{person.name}</span>
                  <small>{person.authority ? authorityLabels[person.authority] : 'No risk acceptance authority'}</small>
                  {person.adopts && <small>Adopts SMS documentation</small>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

function AttentionGroup({
  title,
  description,
  records,
  empty,
  action,
  onOpen,
}: {
  title: string;
  description: string;
  records: SmsRecordSummary[];
  empty: string;
  action?: string;
  onOpen: (record: SmsRecordSummary) => void;
}) {
  return (
    <section className="safety-section sms-attention" aria-label={title}>
      <div className="safety-section-heading">
        <h3>
          {title} <span className="sms-count sms-count--quiet">{records.length}</span>
        </h3>
      </div>
      <p className="muted">{description}</p>
      {records.length === 0 ? (
        <p className="sms-empty">{empty}</p>
      ) : (
        <div className="hazard-register">
          {records.map((record) => (
            <RecordRow key={record.id} record={record} action={action} onOpen={() => onOpen(record)} />
          ))}
        </div>
      )}
    </section>
  );
}

function DocumentWork({
  toReview,
  toIssue,
  onOpen,
}: {
  toReview: SmsRecordSummary[];
  toIssue: SmsRecordSummary[];
  onOpen: (record: SmsRecordSummary) => void;
}) {
  const count = toReview.length + toIssue.length;
  return (
    <section className="safety-section sms-attention" aria-label="Documents to review or issue">
      <div className="safety-section-heading">
        <h3>
          Documents to review or issue{' '}
          <span className={count ? 'sms-count' : 'sms-count sms-count--quiet'}>{count}</span>
        </h3>
      </div>
      <p className="muted">
        Working revisions that need your review before signature, and signed revisions that readers cannot see until you
        issue them.
      </p>
      {count === 0 ? (
        <p className="sms-empty">No document revision is waiting for review or issue.</p>
      ) : (
        <div className="hazard-register">
          {toIssue.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              stage="Signed, ready to issue"
              action="Issue"
              onOpen={() => onOpen(record)}
            />
          ))}
          {toReview.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              stage="Draft, awaiting review"
              action="Review"
              onOpen={() => onOpen(record)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SafetyHome({
  home,
  principal,
  client,
  documents,
  reports,
  onOpen,
  onStart,
  onChanged,
}: {
  home: SmsHomeResponse;
  principal: Principal;
  client: LedgerClient;
  documents: SmsRecordSummary[];
  reports: SmsRecordSummary[];
  onOpen: (record: Pick<SmsRecordSummary, 'id' | 'kind'>, sign?: boolean, issueId?: string, read?: boolean) => void;
  onStart: (target: FirstStepTarget) => void;
  onChanged: () => void;
}) {
  const waiting = home.attention.waitingOnMe;
  const otherDocuments = home.attention.documentsAwaitingAdoption.filter((record) => !record.waitingOnMe);
  const others = home.attention.awaitingAcceptance.filter((record) => !record.waitingOnMe);
  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main">
        <p className="thread-crumbs">Safety / Home</p>
        <div className="thread-title">
          <h2>What needs attention</h2>
          {waiting.length > 0 ? (
            <Badge tone="advisory">
              {waiting.length} {waiting.length === 1 ? 'signature' : 'signatures'} waiting on you
            </Badge>
          ) : (
            <Badge>Nothing waiting on your signature</Badge>
          )}
        </div>
        <p className="safety-intro">
          Decisions, document reading and safety work that need attention across your organization.
        </p>
        <p className="safety-intro report-entry">
          <PlaceLink place={{ section: 'reports', report: 'home' }}>Reports</PlaceLink>: a summary of a period to print
          or save, findings by month and indicators over time.
        </p>
        <FirstSteps home={home} documents={documents} reports={reports} principal={principal} onStart={onStart} />
        <MyDocumentReading
          reading={home.reading ?? []}
          onOpen={(assignment) =>
            onOpen({ id: assignment.recordId, kind: 'document' }, false, assignment.issueId, true)
          }
        />
        {principal.capabilities.includes('sms:write') && (
          <>
            <DocumentWork
              toReview={home.attention.documentsToReview}
              toIssue={home.attention.documentsToIssue}
              onOpen={(record) => onOpen(record)}
            />
            <OrganizationReading
              progress={home.readingProgress ?? []}
              people={home.readingByPerson ?? []}
              onOpen={(entry) => onOpen({ id: entry.recordId, kind: 'document' }, false, entry.issueId)}
            />
            <DocumentReviewsDue
              reviews={home.reviewsDue ?? []}
              onOpen={(entry) => onOpen({ id: entry.recordId, kind: 'document' })}
            />
          </>
        )}
        <AssuranceActionsDue
          groups={home.assuranceActions ?? []}
          onOpen={(recordId) => onOpen({ id: recordId, kind: 'assurance' })}
        />
        <AttentionGroup
          title="Signatures waiting on you"
          description="Risk acceptances within your authority, and documents and safety assurance records waiting for your signature."
          records={waiting}
          empty="Nothing is waiting on your signature."
          action="Review and sign"
          onOpen={(record) => onOpen(record, true)}
        />
        <AttentionGroup
          title="Awaiting risk acceptance by someone else"
          description="Assessed hazards that need a person with higher authority to accept the residual risk."
          records={others}
          empty="No other hazards are awaiting acceptance."
          onOpen={(record) => onOpen(record)}
        />
        <AttentionGroup
          title="Hazards needing assessment"
          description="Identified hazards with no current assessment on the adopted risk matrix."
          records={home.attention.needsAssessment}
          empty="Every identified hazard has a current assessment."
          action="Assess"
          onOpen={(record) => onOpen(record)}
        />
        <AttentionGroup
          title="Awaiting a signature by someone else"
          description="Draft SMS documentation and safety assurance records that need a signature from someone with adoption authority."
          records={otherDocuments}
          empty="No other document or safety assurance record is awaiting a signature."
          onOpen={(record) => onOpen(record)}
        />
        <AttentionGroup
          title="Overdue"
          description="Hazards past their due date that are not yet accepted."
          records={home.attention.overdue}
          empty="Nothing is overdue."
          onOpen={(record) => onOpen(record)}
        />
      </div>
      <aside className="rail safety-rail" aria-label="Safety actions">
        <IdentifyHazardForm
          client={client}
          principal={principal}
          home={home}
          onOpened={(id) => {
            onChanged();
            onOpen({ id, kind: 'hazard' });
          }}
        />
        <PeriodExportForm client={client} principal={principal} />
      </aside>
    </div>
  );
}

/** The kinds of document record with more to read, and the cursor of the next page of each. */
type DocumentPages = { kind: 'document' | 'risk_matrix'; cursor: string }[];

/**
 * Documents and risk matrices after the first page of each, read on request. The library searches and filters the
 * ones read, so while more remain the register says so.
 */
function useLaterDocuments(client: LedgerClient, first: SmsRecordSummary[], after: DocumentPages) {
  const [later, setLater] = useState<{ records: SmsRecordSummary[]; after: DocumentPages } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const remaining = later ? later.after : after;
  const shown = new Set(first.map((record) => record.id));
  const documents = [...first, ...(later?.records ?? []).filter((record) => !shown.has(record.id))];
  async function more() {
    setLoading(true);
    setFailure(null);
    try {
      const pages = await Promise.all(
        remaining.map(async ({ kind, cursor }) => ({
          kind,
          page: await client.request<SmsRegisterResponse>(`/v1/sms/records?${new URLSearchParams({ kind, cursor })}`),
        })),
      );
      setLater((previous) => ({
        records: [...(previous?.records ?? []), ...pages.flatMap(({ page }) => page.records)],
        after: pages.flatMap(({ kind, page }) => (page.nextCursor ? [{ kind, cursor: page.nextCursor }] : [])),
      }));
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setLoading(false);
    }
  }
  return { documents, more: remaining.length ? more : null, loading, failure };
}

function DocumentsRegister({
  drafting: startDrafting,
  documents: first,
  after,
  home,
  principal,
  client,
  onOpen,
  onChanged,
}: {
  drafting?: boolean;
  documents: SmsRecordSummary[];
  after: DocumentPages;
  home: SmsHomeResponse;
  principal: Principal;
  client: LedgerClient;
  onOpen: (record: Pick<SmsRecordSummary, 'id' | 'kind'>) => void;
  onChanged: () => void;
}) {
  const [opened, setOpened] = useState<boolean | null>(startDrafting ? true : null);
  const read = useLaterDocuments(client, first, after);
  const documents = read.documents;
  const drafting = opened ?? documents.length === 0;
  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main">
        <p className="thread-crumbs">Safety / Documents</p>
        <div className="thread-title">
          <h2>Controlled documents</h2>
          <Badge>
            {documents.length}
            {read.more ? '+' : ''} recorded
          </Badge>
        </div>
        <p className="safety-intro">
          Policy, procedures, received OEM manuals and other controlled documents. Review and sign each revision, set
          when it takes effect and assign named readers. Earlier issues and acknowledgements stay on record.
        </p>
        {documents.length === 0 ? (
          <div className="safety-empty">
            <h3>No documents recorded yet</h3>
            {!readsOnly(principal.capabilities) && (
              <p>Record an authored or received document with the form beside this page.</p>
            )}
          </div>
        ) : (
          <DocumentLibrary documents={documents} onOpen={onOpen} />
        )}
        {read.more && (
          <p className="sms-register-hint">
            More documents are on file than are listed here; the search and filters cover the ones listed.
          </p>
        )}
        <RegisterMore label="More documents" list={read} />
      </div>
      <aside className="rail safety-rail" aria-label="Document actions" hidden={readsOnly(principal.capabilities)}>
        {drafting || !principal.capabilities.includes('sms:write') ? (
          <>
            <DraftDocumentForm
              client={client}
              principal={principal}
              home={home}
              onOpened={(id) => {
                onChanged();
                onOpen({ id, kind: 'document' });
              }}
            />
            {documents.length > 0 && (
              <Button kind="quiet" onClick={() => setOpened(false)}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <section className="safety-next-action sms-next-step">
            <span className="safety-stage-label">Record</span>
            <p>
              Start a policy or procedure your organization writes, or record a manual received from a manufacturer.
            </p>
            <Button kind="next" onClick={() => setOpened(true)}>
              Record a document
            </Button>
          </section>
        )}
      </aside>
    </div>
  );
}
