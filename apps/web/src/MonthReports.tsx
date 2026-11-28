import { useState, type FormEvent, type ReactNode } from 'react';
import {
  flightTimeCsv,
  flightWithoutTimeWords,
  NO_IDENTITY_RECORD,
  occurrencesCsv,
  type FlightTimeByAircraft,
  type OccurrencesByMonth,
  type ReportMonthPeriod,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Button } from '@ledger/ui';
import { counted, time, timeZoneLabel } from './format.js';
import { calendarMonth, goTo, type Place } from './place.js';
import { monthLabel } from './report-charts.js';
import { hoursAndMinutes } from './report-periods.js';
import { CountLink, NotYours, PrintButton, Shown, useRead } from './ReportParts.js';
import { saveBytes } from './sms-labels.js';
import { PlaceLink } from './TopBar.js';

/**
 * Two reports of a calendar month, to prepare what an operator sends: flight time by aircraft, and the occurrences
 * recorded. Both say what was counted and from which records, and name no rule. Ledger sends nothing: a person sends
 * what they prepare, and records that they did on the entry form each page leads to.
 */

type MonthReport = 'flight-time' | 'occurrences';
const monthPlace = (report: MonthReport, month?: string): Place => ({
  section: 'reports',
  report,
  ...(month ? { month } : {}),
});
const browse = (type: string): Place => ({ section: 'records', pane: 'browse', type });
const fileOf = (kind: 'aircraft' | 'flight', id: string): Place => ({ section: 'records', pane: 'subjects', kind, id });

/** The record that says a report was provided, and the two fields of it a month fills. */
const PROVIDED_REPORT = 'organization.report@1';
const sentPlace = (period: ReportMonthPeriod): Place => ({
  section: 'records',
  pane: 'enter',
  type: PROVIDED_REPORT,
  fill: { periodStartsOn: period.from, periodEndsOn: period.until },
});

/** A month a person picks, or the last whole one; each opens the report at an address of its own. */
function MonthChooser({ report, month }: { report: MonthReport; month: string }) {
  const [chosen, setChosen] = useState(month);
  const valid = calendarMonth(chosen);
  return (
    <div className="report-period" aria-label="Choose a month">
      <form
        className="report-period-days"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (valid) goTo(monthPlace(report, chosen));
        }}
      >
        <label>
          Month <input type="month" value={chosen} onChange={(event) => setChosen(event.target.value)} required />
        </label>
        <Button type="submit" disabled={!valid}>
          Show this month
        </Button>
        <PlaceLink className="button button--quiet" place={monthPlace(report)}>
          The last whole month
        </PlaceLink>
      </form>
    </div>
  );
}

function DownloadCsv({ name, csv }: { name: string; csv: () => string }) {
  return (
    <Button kind="secondary" onClick={() => saveBytes(new TextEncoder().encode(csv()), name, 'text/csv')}>
      Download as CSV
    </Button>
  );
}

function Made({ period, computedAt, from, belongs }: MadeProps) {
  return (
    <p className="report-made">
      Made {time(computedAt, true)} {timeZoneLabel()} from {from}. The month runs from the start of {period.from} to the
      end of {period.until}, in {period.timeZone}. {belongs}
      {!period.ended && ' The month has not ended: this counts what is on file so far.'}
    </p>
  );
}
interface MadeProps {
  period: ReportMonthPeriod;
  computedAt: string;
  from: string;
  belongs: string;
}

/** Ledger sends nothing: the person who sent a report made from the page records that, with the period filled in. */
function RecordSent({ period }: { period: ReportMonthPeriod }) {
  return (
    <section aria-label="When you have sent this" className="report-sent">
      <h3>When you have sent this</h3>
      <p className="records-note">
        Ledger sends nothing to anyone. When you have sent a report made from this page, record that it was provided:
        the entry form opens with the period {period.from} to {period.until} filled in, and you complete and record it.
      </p>
      <PlaceLink className="button button--secondary" place={sentPlace(period)}>
        Record that this was sent
      </PlaceLink>
    </section>
  );
}

function Page({
  crumb,
  heading,
  report,
  month,
  actions,
  children,
}: {
  crumb: string;
  heading: string;
  report: MonthReport;
  month?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <p className="thread-crumbs">Reports / {crumb}</p>
      <div className="thread-title">
        <h2>{heading}</h2>
        <div className="report-actions">
          {actions}
          <PrintButton />
        </div>
      </div>
      {month && <MonthChooser key={month} report={report} month={month} />}
      {children}
    </>
  );
}

export function FlightTimePage({ client, month }: { client: LedgerClient; month?: string }) {
  const loaded = useRead(() => client.flightTimeByAircraft(month ? { month } : {}), `flight-time/${month ?? ''}`);
  const report = loaded.state === 'loaded' ? loaded.value : null;
  const shown = report?.period.month ?? month;
  return (
    <Page
      crumb="Flight time by aircraft"
      heading={shown ? `Flight time by aircraft, ${monthLabel(shown)}` : 'Flight time by aircraft'}
      report="flight-time"
      month={shown}
      actions={
        report?.flights.readable && (
          <DownloadCsv
            name={`flight-time-${report.period.month}.csv`}
            csv={() => (report.flights.readable ? flightTimeCsv(report.period, report.flights) : '')}
          />
        )
      }
    >
      <Shown loaded={loaded} label="Adding up the flight records on file">
        {(value) => <FlightTimeView report={value} />}
      </Shown>
    </Page>
  );
}

function FlightTimeView({ report }: { report: FlightTimeByAircraft }) {
  const { period, flights } = report;
  return (
    <div className="report-summary" data-testid="flight-time-report">
      <Made
        period={period}
        computedAt={report.computedAt}
        from="the flight records on file"
        belongs="A flight belongs to the month of its takeoff."
      />
      <section aria-label="Flight time by aircraft" data-testid="flight-time-aircraft">
        {!flights.readable ? (
          <NotYours part="Flights and flight time" capability={flights.capability} />
        ) : flights.aircraft.length === 0 ? (
          <p className="records-note">No flight record with a takeoff in this month is on file.</p>
        ) : (
          <FlightTimeTable flights={flights} />
        )}
      </section>
      <section aria-label="What this report counts" className="report-limits">
        <h3>What this report counts, and what it does not</h3>
        <ul className="records-reasons">
          <li>
            Each flight with a flight record on file whose takeoff is in the month, under the aircraft its record names
            by your own id. A record that was replaced or withdrawn is not counted.
          </li>
          <li>
            Flight time is the recorded takeoff to the recorded landing, added up to the second and shown in hours and
            whole minutes. The CSV file gives decimal hours to one place, with the seconds beside them.
          </li>
          <li>
            A flight with no landing time on file is counted as a flight, listed under its aircraft, and adds no time.
          </li>
          <li>
            A flight known only from a source’s report or from a plan, with no flight record, is not counted, as in the
            summary of a period.
          </li>
          <li>
            A registration and serial number are those of the aircraft’s identity record: the latest on file by the end
            of the month, or, when none was on file by then, the first one recorded after it, which the row says.
          </li>
        </ul>
      </section>
      <RecordSent period={period} />
    </div>
  );
}

type ReadableFlights = Extract<FlightTimeByAircraft['flights'], { readable: true }>;

function FlightTimeTable({ flights }: { flights: ReadableFlights }) {
  const notRecorded = <span className="report-absent">not in the identity record</span>;
  return (
    <>
      <div className="report-wide">
        <table className="report-numbers">
          <thead>
            <tr>
              <th scope="col">Aircraft</th>
              <th scope="col">Registration number</th>
              <th scope="col">Serial number</th>
              <th scope="col">Flights</th>
              <th scope="col">Flight time, takeoff to landing</th>
            </tr>
          </thead>
          <tbody>
            {flights.aircraft.map((aircraft) => {
              const named = aircraft.aircraftId;
              const missing = flights.withoutTime.filter((flight) => flight.aircraftId === named);
              return (
                <tr key={named ?? ''} data-testid="flight-time-row" data-aircraft={named ?? ''}>
                  <th scope="row">
                    {named ?? 'No aircraft named on the flight record'}
                    {aircraft.identity?.recordedAfterMonth && (
                      <small>Its identity record was recorded after the month ended.</small>
                    )}
                    {missing.length > 0 && (
                      <ul className="records-reasons report-without-time" aria-label="Flights that add no time">
                        {missing.map((flight) => (
                          <li key={flight.flightId}>
                            Flight <PlaceLink place={fileOf('flight', flight.flightId)}>{flight.flightId}</PlaceLink>,
                            took off {time(flight.takeoffAt, true)} {timeZoneLabel()}:{' '}
                            {flightWithoutTimeWords[flight.reason]}. In the flights, not in the time.
                          </li>
                        ))}
                      </ul>
                    )}
                    {aircraft.withoutTime > missing.length && (
                      <small>
                        {counted(aircraft.withoutTime - missing.length, 'more flight')} with no flight time on file, not
                        listed here.
                      </small>
                    )}
                  </th>
                  {aircraft.identity ? (
                    <>
                      <td>{aircraft.identity.registrationNumber ?? notRecorded}</td>
                      <td>{aircraft.identity.serialNumber ?? notRecorded}</td>
                    </>
                  ) : (
                    <td colSpan={2}>
                      {named === null ? '—' : <span className="report-absent">{NO_IDENTITY_RECORD}</span>}
                    </td>
                  )}
                  <td>
                    <CountLink
                      count={aircraft.flights}
                      place={named === null ? browse('flight.record@1') : fileOf('aircraft', named)}
                      label={named === null ? 'flights naming no aircraft' : `flights of ${named}`}
                    />
                  </td>
                  <td>{hoursAndMinutes(aircraft.flightSeconds)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr data-testid="flight-time-total">
              <th scope="row">Every aircraft: {flights.total.aircraft}</th>
              <td colSpan={2} />
              <td>
                <CountLink count={flights.total.flights} place={browse('flight.record@1')} label="flights" />
              </td>
              <td>{hoursAndMinutes(flights.total.flightSeconds)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {flights.total.withoutTime > 0 && (
        <p className="records-note">
          {counted(flights.total.withoutTime, 'flight')} counted above with no flight time on file: in the flights, not
          in the time.
        </p>
      )}
    </>
  );
}

export function OccurrencesPage({ client, month }: { client: LedgerClient; month?: string }) {
  const loaded = useRead(() => client.occurrencesByMonth(month ? { month } : {}), `occurrences/${month ?? ''}`);
  const report = loaded.state === 'loaded' ? loaded.value : null;
  const shown = report?.period.month ?? month;
  return (
    <Page
      crumb="Occurrences by month"
      heading={shown ? `Occurrences recorded, ${monthLabel(shown)}` : 'Occurrences recorded'}
      report="occurrences"
      month={shown}
      actions={
        report?.occurrences.readable && (
          <DownloadCsv
            name={`occurrences-${report.period.month}.csv`}
            csv={() => (report.occurrences.readable ? occurrencesCsv(report.period, report.occurrences) : '')}
          />
        )
      }
    >
      <Shown loaded={loaded} label="Reading the occurrence records on file">
        {(value) => <OccurrencesView report={value} />}
      </Shown>
    </Page>
  );
}

type ReadableOccurrences = Extract<OccurrencesByMonth['occurrences'], { readable: true }>;

function OccurrencesView({ report }: { report: OccurrencesByMonth }) {
  const { period, occurrences } = report;
  return (
    <div className="report-summary" data-testid="occurrences-report">
      <Made
        period={period}
        computedAt={report.computedAt}
        from="the occurrence records on file"
        belongs="An occurrence belongs to the month it occurred in."
      />
      {occurrences.readable ? (
        <OccurrenceTypes occurrences={occurrences} />
      ) : (
        <section aria-label="Occurrences by type">
          <NotYours part="Occurrences" capability={occurrences.capability} />
        </section>
      )}
      <section aria-label="What this report counts" className="report-limits">
        <h3>What this report counts, and what it does not</h3>
        <ul className="records-reasons">
          <li>
            Each occurrence record on file that occurred in the month, of every occurrence record type your organization
            has, by type. A record that was replaced or withdrawn is not counted.
          </li>
          <li>
            Each is listed with its date, the flight and aircraft its record names by your own ids, and the fields its
            record holds, as recorded. Nothing is added to it.
          </li>
          <li>A type with none on file for the month says only that none was recorded.</li>
          <li>Safety reports are not occurrence records: nothing of a safety report appears here.</li>
        </ul>
      </section>
      <RecordSent period={period} />
    </div>
  );
}

function OccurrenceTypes({ occurrences }: { occurrences: ReadableOccurrences }) {
  const listed = occurrences.types.reduce((sum, type) => sum + type.occurrences.length, 0);
  return (
    <>
      <section aria-label="Occurrences by type" data-testid="occurrence-counts">
        <table className="report-numbers">
          <thead>
            <tr>
              <th scope="col">Record type</th>
              <th scope="col">On file for the month</th>
            </tr>
          </thead>
          <tbody>
            {occurrences.types.map((type) => (
              <tr
                key={`${type.recordType}@${type.recordVersion}`}
                data-testid="occurrence-type"
                data-type={type.recordType}
              >
                <th scope="row">{type.title}</th>
                <td>
                  <CountLink
                    count={type.count}
                    place={browse(`${type.recordType}@${type.recordVersion}`)}
                    label={`${type.title} records`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Every type</th>
              <td>{occurrences.total}</td>
            </tr>
          </tfoot>
        </table>
        {occurrences.truncated && (
          <p className="records-note">
            The first {counted(listed, 'occurrence')} of the month are listed below; all {occurrences.total} are
            counted.
          </p>
        )}
      </section>
      {occurrences.types
        .filter((type) => type.occurrences.length > 0)
        .map((type) => (
          <section
            key={`${type.recordType}@${type.recordVersion}`}
            aria-label={type.title}
            data-testid="occurrence-list"
          >
            <h3>{type.title}</h3>
            <div className="report-wide">
              <table className="report-numbers report-occurrences">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Flight</th>
                    <th scope="col">Aircraft</th>
                    <th scope="col">As recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {type.occurrences.map((item) => (
                    <tr key={item.recordId} data-testid="occurrence-row">
                      <th scope="row">
                        {item.dateOnly
                          ? `${item.occurredOn} (date only)`
                          : `${time(item.occurredAt, true)} ${timeZoneLabel()}`}
                      </th>
                      <td>
                        {item.flightId ? (
                          <PlaceLink place={fileOf('flight', item.flightId)}>{item.flightId}</PlaceLink>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {item.aircraftId ? (
                          <PlaceLink place={fileOf('aircraft', item.aircraftId)}>{item.aircraftId}</PlaceLink>
                        ) : (
                          '—'
                        )}
                        {item.about.map((subject) => (
                          <small key={`${subject.kind} ${subject.id}`}>
                            {subject.kind} {subject.id}
                          </small>
                        ))}
                      </td>
                      <td>
                        <dl className="records-fields">
                          {item.fields.map((field) => (
                            <div key={field.name}>
                              <dt>{field.label}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
    </>
  );
}
