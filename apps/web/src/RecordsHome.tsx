import type { FlightOnRecord, FlightsOnRecordResponse, NamedSubject } from '@ledger/contracts';
import { Badge, Button, Spinner } from '@ledger/ui';
import { time, timeRange, timeZoneLabel } from './format.js';
import { subjectLabel } from './subject-label.js';
import { PlaceLink } from './TopBar.js';

/**
 * The home of an organization with no order source on record: its flights as its own flight plan records give them,
 * upcoming first, then recent, and what needs attention among its open findings. Nothing here speaks of orders or of
 * evidence waiting for a flight, which such an organization has none of.
 */
export function RecordsHome({
  home,
  error,
  onOpenFlight,
  onOpenFindings,
  onOpenRecords,
}: {
  home: FlightsOnRecordResponse | null;
  error: string | null;
  onOpenFlight: (flight: NamedSubject) => void;
  /** Opens the open findings list, at the ones nobody owns when asked. */
  onOpenFindings: (owner?: 'none') => void;
  onOpenRecords: () => void;
}) {
  return (
    <main className="records-area records-home" aria-label="Flights on record" data-testid="records-home">
      <section className="thread-workspace" aria-label="Home">
        <div className="thread-main">
          <p className="thread-crumbs">Home</p>
          <h2>Flights on record</h2>
          <p className="overview-purpose">
            The flights your own flight plan records give, with the aircraft and the pilot in command your records name.
            Open one to see its file: its records, the rules that cover it and its open findings.
          </p>
          <p className="overview-purpose report-entry">
            <PlaceLink place={{ section: 'reports', report: 'home' }}>Reports</PlaceLink>: a summary of a period to
            print or save, findings by month, indicators over time and one flight’s file.
          </p>
          {!home && !error && <Spinner label="Reading the flights on record" />}
          {error && <p className="records-note">The flights on record could not be read: {error}</p>}
          {home && (
            <>
              <section className="records-home-attention" aria-label="Needs attention" data-testid="needs-attention">
                <h3>Needs attention</h3>
                <ul className="records-reasons">
                  <li>
                    <Button kind={home.attention.unowned ? 'next' : 'quiet'} onClick={() => onOpenFindings('none')}>
                      {home.attention.unowned === 1
                        ? '1 open finding has no owner'
                        : `${home.attention.unowned} open findings have no owner`}
                    </Button>
                  </li>
                  <li>
                    <Button kind={home.attention.overdue ? 'next' : 'quiet'} onClick={() => onOpenFindings()}>
                      {home.attention.overdue === 1
                        ? '1 action on a finding is overdue'
                        : `${home.attention.overdue} actions on findings are overdue`}
                    </Button>
                  </li>
                </ul>
              </section>
              <FlightGroup
                title="Upcoming"
                flights={home.upcoming}
                empty="No flight plan on record starts from now on."
                onOpenFlight={onOpenFlight}
              />
              <FlightGroup
                title="Recent"
                flights={home.recent}
                empty="No flight plan on record started before now."
                onOpenFlight={onOpenFlight}
              />
              {!home.upcoming.length && !home.recent.length && (
                <p className="records-note">
                  No flight plan is on record yet. Import or enter flight plans under Records; each one shows here.{' '}
                  <Button kind="quiet" onClick={onOpenRecords}>
                    Open records
                  </Button>
                </p>
              )}
              {home.truncated && (
                <p className="records-note">
                  More flight plans exist than this page reads; the list under Records has them all.
                </p>
              )}
              <p className="overview-read-time">
                Read <time dateTime={home.computedAt}>{time(home.computedAt, true)}</time> {timeZoneLabel()}
              </p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function FlightGroup({
  title,
  flights,
  empty,
  onOpenFlight,
}: {
  title: string;
  flights: FlightOnRecord[];
  empty: string;
  onOpenFlight: (flight: NamedSubject) => void;
}) {
  return (
    <section aria-label={`${title} flights`} data-testid={`flights-${title.toLowerCase()}`}>
      <h3>
        {title} <span className="roster-count">{flights.length}</span>
      </h3>
      {!flights.length ? (
        <p className="records-note">{empty}</p>
      ) : (
        <ol className="records-items">
          {flights.map((flight) => (
            <li key={flight.subject.id} data-testid="flight-on-record">
              <button
                className="records-item"
                aria-label={`Open the file of flight ${flight.subject.id}`}
                onClick={() => onOpenFlight(flight.subject)}
              >
                <span className="records-item-head">
                  <strong>{flight.subject.id}</strong>
                  {flight.openFindings > 0 && (
                    <Badge tone="attention">
                      {flight.openFindings === 1 ? '1 open finding' : `${flight.openFindings} open findings`}
                    </Badge>
                  )}
                </span>
                <span className="records-item-meta">{timeRange(flight.window.start, flight.window.end)}</span>
                <span className="records-item-meta">
                  Aircraft: {flight.aircraft ? subjectLabel(flight.aircraft) : 'none named in the plan'} · Pilot in
                  command: {flight.pilotInCommand ? subjectLabel(flight.pilotInCommand) : 'no role assignment on file'}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
