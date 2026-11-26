import React from 'react';
import { createRoot } from 'react-dom/client';
import { LedgerClient } from '@ledger/contracts/client';
import { RECORD_LINK_PAGE } from '@ledger/contracts';
import { Button, Mark, Spinner } from '@ledger/ui';
import '@fontsource/open-sans/latin-400.css';
import '@fontsource/open-sans/latin-600.css';
import '@fontsource/open-sans/latin-700.css';
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-500.css';
import '@ledger/ui/styles.css';
import './styles/shell.css';
import './styles/gate.css';
import './styles/roster.css';
import './styles/record.css';
import './styles/inspector.css';
import './styles/rail.css';
import './styles/map.css';
import './styles/safety.css';
import './styles/mission.css';
import './styles/spatial.css';
import './styles/sms.css';
import './styles/records.css';
import './styles/reports.css';
import './styles/print.css';
import { App, type AppProps } from './App.js';
import { SmsApp, type ConfirmIdentity } from './SmsApp.js';
import { DeploymentGate, OpenIdSignIn } from './OpenIdSignIn.js';
import {
  beginSignIn,
  isCallback,
  readSignInConfiguration,
  relayConfirmation,
  type IssuerEntry,
} from './openid-connect.js';
import { SafetyRecordLink } from './area-controls.js';
import { blankSignedInReport, PublicReportPage, SubmitReportDialog } from './SafetyReportSubmission.js';
import { SharedRecordsPage } from './SharedRecordsPage.js';
import { safetyDestinationPlace, type FlightLinks, type SafetyDestination } from './safety-navigation.js';
import { forgetPlaces, goTo, usePlace } from './place.js';
import { useFirstDay } from './FirstDay.js';
import { FirstDayContext } from './first-day-context.js';
import { opensOnFirstDay } from './first-steps.js';
import { operators } from './labels.js';
import { fictionalPeople } from './demo/fictional-organizations.js';
import { developmentToken, heldOrganizations, offeredOrganizations } from './local-sign-in.js';
import { appFetch, demonstration, mode } from './transport.js';
import { openFoldedSectionsForPrint } from './print.js';
import { registerAppShell } from './app-shell.js';
import { NoticeChoices } from './NoticeSettings.js';
import { OutboxProvider, WaitingOnDevice } from './DeviceOutbox.js';

const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
// A demonstration build has no API: it shows the fictional people and answers from a recording.
const localAllowed =
  demonstration || (import.meta.env.DEV && import.meta.env.VITE_LEDGER_ENV === 'local' && isLoopback);
const apiUrl = import.meta.env.VITE_API_URL ?? '';
const localProfiles = import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo' ? operators : [];
// Written out here and below so an ordinary production build drops these branches entirely.
const localPeople = import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo' ? fictionalPeople : [];

// The walkthrough card is opt-in: it appears only in a dev build started with VITE_LEDGER_WALKTHROUGH=1.
const WalkthroughGuide =
  import.meta.env.DEV && import.meta.env.VITE_LEDGER_WALKTHROUGH === '1'
    ? React.lazy(() => import('./walkthrough/WalkthroughGuide.js'))
    : null;

// A simulated person who uses the real screens: in local development, and in a demonstration build.
const AutopilotLayer =
  import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo'
    ? React.lazy(() => import('./autopilot/AutopilotLayer.js'))
    : null;
const watchScene = (id: string) => {
  // Written out so an ordinary production build drops the import, and the scenes with it.
  if (import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo')
    void import('./autopilot/AutopilotLayer.js').then((layer) => layer.start(id));
};

type OperatorKey = (typeof operators)[number]['key'];
interface SceneListing {
  id: string;
  operator: OperatorKey;
  title: string;
  shows: string;
  summary: string;
}
interface Story {
  lede: string;
  points: { title: string; text: string }[];
}

const kind = demonstration ? 'recorded' : 'live';

/** What the sign-in screen says depends on which organization is chosen. */
const stories: Record<OperatorKey, Story> = {
  alpha: {
    lede: `A ${kind} simulated delivery operation: the rules it adopts, the evidence its sources report, and what its people decide.`,
    points: [
      {
        title: 'Rules are checked on every flight',
        text: 'Alpha adopts rule packs: Part 107, its waiver, its own procedures. When the evidence falls short of one, Ledger records a finding and asks who owns it.',
      },
      {
        title: 'Proposed rules are recorded, not counted',
        text: 'A pack quoting proposed text, such as Part 108, runs in shadow. Its findings are shown apart and never enter a release.',
      },
      {
        title: 'A finding can become a control',
        text: 'A person opens a hazard from it and proposes a control. Once someone with the authority accepts it, each flight’s release lists it with its result.',
      },
    ],
  },
  beta: {
    lede: `A ${kind} simulated inspection operation, where the record keeps changing after the aircraft is airborne.`,
    points: [
      {
        title: 'Every decision pins what was known',
        text: 'A decision records exactly which inputs the dispatcher saw.',
      },
      {
        title: 'Stale decisions are refused',
        text: 'If new evidence arrived in the meantime, Ledger says so and keeps the draft.',
      },
      {
        title: 'Operators stay separate',
        text: 'Each organization sees only its own flights, people and records.',
      },
    ],
  },
  utility: {
    lede: 'A utility drone program’s safety management system, on the same record as its flights.',
    points: [
      {
        title: 'A hazard becomes a record',
        text: 'Anyone can raise one. It gets an owner, an assessment and a next step.',
      },
      {
        title: 'Authority decides who can accept risk',
        text: 'Ledger works out the level from the adopted matrix and names who may sign.',
      },
      {
        title: 'Documents are controlled by revision',
        text: 'Review, signature, issue and each reader’s acknowledgement are tied to one exact revision.',
      },
    ],
  },
};

/** What the sign-in screen says when no fictional organization is chosen: what Ledger is, with no fictional name. */
const ledgerStory: Story = {
  lede: 'An operational record and rule checker for drone programs. It keeps what an operation knew, decided and did, and checks that record against the rules the organization has adopted.',
  points: [
    {
      title: 'Records',
      text: 'Every input and command is appended to a hash-chained journal, with the original bytes beside the values read from them. A correction is a new record, never an edit.',
    },
    {
      title: 'Rule checks',
      text: 'An organization adopts an exact version of a rule pack for a date range. Ledger reports, rule by rule, what is checked automatically, what needs a person, and what is not supported.',
    },
    {
      title: 'Safety records',
      text: 'Reports, hazards, risk acceptance, controls and controlled documents, on the same record as the flights.',
    },
  ],
};

/**
 * The sign-in screen. With a fictional organization chosen it tells that organization's story and says the data is
 * fictional; without one it says what Ledger is and names nothing fictional.
 */
function Gate({ children, operator }: { children: React.ReactNode; operator?: OperatorKey }) {
  const story = operator ? stories[operator] : ledgerStory;
  const fictional = demonstration || operator !== undefined;
  return (
    <main className="gate">
      <header className="gate-brand">
        <Mark size={22} />
        <span>LEDGER</span>
      </header>
      <div className="gate-body">
        <section className="gate-story">
          <h1>A record you can act on.</h1>
          <p className="gate-lede">{story.lede}</p>
          <ol className="gate-previews">
            {story.points.map((preview) => (
              <li key={preview.title}>
                <strong>{preview.title}</strong>
                <span>{preview.text}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="gate-panel">
          {children}
          <WaitingOnDevice />
        </section>
      </div>
      <footer className="gate-foot">
        {fictional ? (
          <span className="simulation-pill">
            <i className="pulse" />
            {demonstration ? 'Fictional people and data' : 'Live simulation · fictional operators'}
          </span>
        ) : (
          <span>Lightcone Ledger</span>
        )}
        <span>{demonstration ? 'Recorded demonstration' : localAllowed ? 'Local development' : 'Private staging'}</span>
      </footer>
    </main>
  );
}

interface Program {
  active: boolean;
  /** Absent from recordings made before it was added; such a recording keeps the switch on active alone. */
  flights?: boolean;
}

/**
 * One shell under one bar. An organization that records flights opens on them, with Safety, Records, Rules and People
 * beside them; an organization without flights opens on its safety home, as it always has. Where a person is lives in
 * the address, so a link, a refresh, and back and forward keep the place.
 */
function Workspace({ account, ...rest }: AppProps & { confirmIdentity?: ConfirmIdentity }) {
  const [reporting, setReporting] = React.useState(false);
  // An unsent report stays here, in memory only, while the page is open: closing the dialog keeps it.
  const [reportDraft, setReportDraft] = React.useState(blankSignedInReport);
  const noticeClient = React.useMemo(
    () => new LedgerClient(rest.apiUrl, rest.token, appFetch),
    [rest.apiUrl, rest.token],
  );
  // Any signed-in person can report a safety concern from every screen.
  const props = {
    ...rest,
    report: <Button onClick={() => setReporting(true)}>Report a safety concern</Button>,
    account: (
      <>
        {account}
        {/* The demonstration replays recorded answers, and holds no one's notices. */}
        {!demonstration && <NoticeChoices client={noticeClient} />}
      </>
    ),
  };
  // Outside the bar: the flights keep a bar of their own, hidden, behind the safety section.
  const dialog = reporting && (
    <SubmitReportDialog
      client={new LedgerClient(rest.apiUrl, rest.token, appFetch)}
      draft={reportDraft}
      onDraft={setReportDraft}
      onClose={() => setReporting(false)}
    />
  );
  const [program, setProgram] = React.useState<Program | null>(null);
  const [failed, setFailed] = React.useState(false);
  const { place } = usePlace();
  const client = React.useMemo(
    () => new LedgerClient(props.apiUrl, props.token, appFetch),
    [props.apiUrl, props.token],
  );
  const firstDay = useFirstDay(client, place.section);
  // The person an entry kept on this device belongs to; it is sent only under their sign-in.
  const signedIn = firstDay.decision?.principal;
  const person = React.useMemo(
    () => (signedIn ? { principalId: signedIn.id, tenantId: signedIn.tenantId, name: signedIn.name } : null),
    [signedIn],
  );
  // Where this person was in each section is theirs alone: forgotten when they leave.
  React.useEffect(() => forgetPlaces, []);
  React.useEffect(() => {
    let stopped = false;
    client
      .request<Program>('/v1/sms/program')
      .then((shown) => !stopped && setProgram(shown))
      .catch(() => !stopped && setFailed(true));
    return () => {
      stopped = true;
    };
  }, [client]);
  const openSafety = React.useCallback((destination: SafetyDestination) => {
    const { place: shown, extras } = safetyDestinationPlace(destination);
    goTo(shown, { extras });
  }, []);
  const openRecord = React.useCallback((record: string) => openSafety({ view: 'record', id: record }), [openSafety]);
  const links = React.useMemo<FlightLinks>(
    () => ({
      onFlight: (finding) =>
        goTo(
          finding
            ? { section: 'flights', flightId: finding.flightId, findingId: finding.findingId }
            : { section: 'flights' },
        ),
      onDemoMission: (flight, demo) =>
        goTo({ section: 'flights', flightId: flight.id, mission: true }, { extras: { flight, demo } }),
    }),
    [],
  );
  const known = (failed || program !== null) && firstDay.decision !== undefined;
  // Keep the rule that picks the first screen: flights for an organization that records them, else its safety home.
  const opensOnFlights = failed || (program !== null && (program.flights ?? !program.active));
  // Before the first rule pack is adopted, a person who reads flights and may add people, keep records or adopt packs
  // opens on the first-day list instead.
  const opensOnSetup =
    opensOnFlights &&
    Boolean(firstDay.decision && opensOnFirstDay(firstDay.decision.principal, firstDay.decision.adoptions));
  // A person who reads records and not the safety records, such as a reader, opens on the records.
  const starting = firstDay.decision?.principal.capabilities;
  const opensOnRecords = Boolean(starting && !starting.includes('sms:read') && starting.includes('evidence:read'));
  React.useEffect(() => {
    if (!known) return;
    if (place.section === 'start' || (place.section === 'flights' && !opensOnFlights))
      goTo(
        opensOnSetup
          ? { section: 'setup' }
          : opensOnFlights
            ? { section: 'flights' }
            : opensOnRecords
              ? { section: 'records', pane: 'subjects' }
              : { section: 'safety', view: 'home' },
        { replace: true },
      );
  }, [known, opensOnFlights, opensOnSetup, opensOnRecords, place.section]);
  if (!known)
    return props.local && localAllowed ? (
      <Gate>
        <Spinner label="Opening your organization" />
      </Gate>
    ) : (
      <DeploymentGate local={props.local}>
        <Spinner label="Opening your organization" />
      </DeploymentGate>
    );
  if (!opensOnFlights)
    return (
      <OutboxProvider client={client} person={person}>
        <FirstDayContext.Provider value={firstDay.shown}>
          <SmsApp {...props} />
          {dialog}
        </FirstDayContext.Provider>
      </OutboxProvider>
    );
  const inSafety = place.section === 'safety';
  return (
    <OutboxProvider client={client} person={person}>
      <FirstDayContext.Provider value={firstDay.shown}>
        <SafetyRecordLink.Provider value={openRecord}>
          {dialog}
          <div style={{ display: inSafety ? 'none' : 'contents' }}>
            <App {...props} onOpenSafety={openSafety} />
          </div>
          {inSafety && <SmsApp {...props} flights={links} />}
        </SafetyRecordLink.Provider>
      </FirstDayContext.Provider>
    </OutboxProvider>
  );
}

/**
 * In local development with the test issuer (or another provider) configured for the API: signs in through it
 * instead of a development token. Shown only when the API reports an issuer.
 */
function LocalIdentityProvider() {
  const [issuers, setIssuers] = React.useState<IssuerEntry[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    let stopped = false;
    readSignInConfiguration(apiUrl)
      .then((configuration) => !stopped && setIssuers(configuration.issuers))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, []);
  if (!issuers.length) return null;
  return (
    <div className="local-identity-provider">
      {issuers.map((entry) => (
        <Button
          key={entry.issuer}
          type="button"
          disabled={!entry.authorizationEndpoint}
          onClick={() => void beginSignIn(entry).catch((error: Error) => setProblem(error.message))}
        >
          Sign in through {entry.label}
        </Button>
      ))}
      {problem && <small className="gate-note">{problem}</small>}
    </div>
  );
}

/**
 * For an organization made with pnpm org:create on a local database, whose people hold development tokens rather
 * than being one of the fictional people above: the first administrator's, or one issued on the People screen. The
 * API accepts such a token only in local and test.
 */
function DevelopmentTokenEntry({ onOpen, lead = false }: { onOpen: (token: string) => void; lead?: boolean }) {
  const [token, setToken] = React.useState('');
  const valid = developmentToken(token);
  // Its own form, so Enter in the field opens this token and never the person chosen above.
  const form = (
    <form
      className="local-token-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onOpen(valid);
      }}
    >
      <label className="local-person-choice" htmlFor="local-token">
        <span id="local-token-label">Development token</span>
        <input
          id="local-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-labelledby="local-token-label"
          aria-describedby="local-token-description"
        />
        <small id="local-token-description">
          Yours: the one pnpm org:create printed, or one an administrator issued you on the People screen. It starts
          with ledger-dev-.
        </small>
      </label>
      <Button kind={lead ? 'primary' : 'secondary'} type="submit" disabled={!valid}>
        Open with this token
      </Button>
    </form>
  );
  if (lead)
    return (
      <section className="local-token local-token--lead" aria-label="Open your organization">
        <p className="gate-invite">
          This database holds none of the fictional organizations. Open your own with your development token: the one
          pnpm org:create printed, or one an administrator issued you on the People screen.
        </p>
        {form}
      </section>
    );
  return (
    <details className="local-token">
      <summary>Use a development token</summary>
      {form}
    </details>
  );
}

/**
 * The ids of the seeded organizations the database holds, null until read: a seeded organization is held when the
 * API knows the development token of its first person. A recording holds every fictional organization it shows.
 */
function useHeldOrganizations(): string[] | null {
  const recorded = demonstration || mode() === 'replay';
  const [held, setHeld] = React.useState<string[] | null>(() =>
    recorded ? localProfiles.map((item) => `tenant-${item.key}`) : null,
  );
  React.useEffect(() => {
    if (recorded) return;
    let stopped = false;
    void heldOrganizations(localProfiles, localPeople, (token) =>
      fetch(`${apiUrl.replace(/\/$/, '')}/v1/me`, { headers: { authorization: `Bearer ${token}` } }).then(
        (response) => response.ok,
        () => false,
      ),
    ).then((found) => !stopped && setHeld(found));
    return () => {
      stopped = true;
    };
  }, [recorded]);
  return held;
}

function LocalSession() {
  const held = useHeldOrganizations();
  const offered = offeredOrganizations(localProfiles, held);
  const [chosenProfile, setProfile] = React.useState<(typeof operators)[number]['key'] | null>(null);
  const profile = offered.find((item) => item.key === chosenProfile)?.key ?? offered[0]?.key ?? operators[0].key;
  const [chosenRole, setPerson] = React.useState<string | null>(null);
  const person =
    localPeople.find((item) => item.operator === profile && item.role === chosenRole)?.role ??
    localPeople.find((item) => item.operator === profile)?.role ??
    'operator';
  const [active, setActive] = React.useState<string | null>(null);
  const [sceneList, setSceneList] = React.useState<SceneListing[]>([]);
  React.useEffect(() => {
    if (import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo')
      void import('./autopilot/scenes.js').then((module) => setSceneList(module.scenes));
  }, []);
  const guide = (
    <React.Suspense fallback={null}>
      {WalkthroughGuide && <WalkthroughGuide />}
      {AutopilotLayer && <AutopilotLayer />}
    </React.Suspense>
  );
  if (active)
    return (
      <>
        <Workspace
          key={active}
          apiUrl={apiUrl}
          token={active}
          local
          account={
            <Button
              onClick={() => {
                // Another person starts at the first screen, not at a place this one opened.
                goTo({ section: 'start' }, { replace: true });
                setActive(null);
              }}
            >
              Switch operator
            </Button>
          }
        />
        {guide}
      </>
    );
  if (held === null)
    return (
      <Gate>
        <Spinner label="Reading which organizations this database holds" />
      </Gate>
    );
  if (!offered.length && import.meta.env.DEV && !demonstration)
    return (
      <>
        <Gate>
          <div className="gate-form">
            <DevelopmentTokenEntry onOpen={setActive} lead />
            {mode() !== 'replay' && <LocalIdentityProvider />}
          </div>
        </Gate>
        {guide}
      </>
    );
  const chosen = offered.find((item) => item.key === profile);
  const watchable = sceneList.filter((scene) => scene.operator === profile);
  const groups = [...new Set(watchable.map((scene) => scene.shows))];
  const people = localPeople.filter((item) => item.operator === chosen?.key);
  const chosenPerson = people.find((item) => item.role === person);
  return (
    <>
      <Gate operator={chosen ? profile : undefined}>
        <form
          className="gate-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosenPerson) setActive(chosenPerson.token);
          }}
        >
          <fieldset className="operator-choice">
            <legend>Operator</legend>
            {offered.map((item) => (
              <label key={item.key} className="operator-card">
                <input
                  type="radio"
                  name="operator"
                  value={item.key}
                  checked={profile === item.key}
                  onChange={() => {
                    setProfile(item.key);
                    setPerson(null);
                  }}
                  aria-labelledby={`operator-${item.key}`}
                  aria-describedby={`operator-${item.key}-description`}
                />
                <span className="operator-card-text">
                  <strong id={`operator-${item.key}`}>{item.name}</strong>
                  <span id={`operator-${item.key}-description`}>{item.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="local-person-choice" htmlFor="local-person">
            <span id="local-person-label">Person</span>
            <select
              id="local-person"
              aria-labelledby="local-person-label"
              aria-describedby="local-person-description"
              value={person}
              onChange={(event) => setPerson(event.target.value)}
              required
            >
              {people.map((item) => (
                <option key={item.role} value={item.role}>
                  {item.name} · {item.title}
                </option>
              ))}
            </select>
            <small id="local-person-description">Actions are recorded as the selected person.</small>
          </label>
          <Button kind={demonstration ? 'secondary' : 'primary'} type="submit" disabled={!chosenPerson}>
            Open operations
          </Button>
          {/* A replayed recording asks the API for nothing, so it offers no provider sign-in. */}
          {import.meta.env.DEV && !demonstration && mode() !== 'replay' && <LocalIdentityProvider />}
          {watchable.length > 0 && (
            <section className="gate-scenes" aria-label="Simulated sessions">
              <h2>Watch a simulated person use Ledger</h2>
              {groups.map((group) => (
                <div key={group} className="gate-scene-group" role="group" aria-label={group}>
                  <h3>{group}</h3>
                  {watchable
                    .filter((scene) => scene.shows === group)
                    .map((scene) => (
                      <button key={scene.id} type="button" className="gate-scene" onClick={() => watchScene(scene.id)}>
                        <strong>{scene.title}</strong>
                        <span>{scene.summary}</span>
                      </button>
                    ))}
                </div>
              ))}
            </section>
          )}
          {demonstration && (
            <small className="gate-note">
              A recorded demonstration with fictional people and data. Nothing you do here is saved.
            </small>
          )}
        </form>
        {/* Written out so an ordinary production build drops the token entry. */}
        {import.meta.env.DEV && !demonstration && <DevelopmentTokenEntry onOpen={setActive} />}
      </Gate>
      {guide}
    </>
  );
}

// In local development a sign-in through a configured provider comes back here with its answer in the address.
// Read once, before the sign-in takes the answer out of the address.
const returningFromProvider = import.meta.env.DEV && !demonstration && isCallback(window.location.href);

function Root() {
  // The page a link to one produced set opens: no sign-in, and its secret stays in the address after #.
  if (window.location.pathname === RECORD_LINK_PAGE) return <SharedRecordsPage apiUrl={apiUrl} />;
  // The page a reporting link opens: no sign-in, and its token stays in the address after #.
  if (window.location.pathname === '/report')
    return (
      <DeploymentGate>
        <PublicReportPage apiUrl={apiUrl} />
      </DeploymentGate>
    );
  // The confirmation window of a signature: it only hands the provider's answer back to the page that opened it.
  if (relayConfirmation())
    return (
      <DeploymentGate>
        <Spinner label="Returning to Ledger" />
      </DeploymentGate>
    );
  if (localAllowed && !returningFromProvider) return <LocalSession />;
  return (
    <OpenIdSignIn
      apiUrl={apiUrl}
      workspace={(signedIn) => (
        <Workspace
          key={signedIn.sessionKey}
          apiUrl={apiUrl}
          token={signedIn.token}
          account={signedIn.account}
          confirmIdentity={signedIn.confirmIdentity}
          local={signedIn.local}
        />
      )}
    />
  );
}

openFoldedSectionsForPrint();
// Written out so a demonstration build registers no service worker: it keeps nothing.
if (import.meta.env.VITE_LEDGER_ENV !== 'demo') registerAppShell();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
