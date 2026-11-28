import { useState, type FormEvent } from 'react';
import {
  OPERATOR_RECORD_SOURCE_ID,
  SUBJECT_RECORD_PAGE_LIMIT,
  type Capability,
  type FindingsByMonth,
  type IndicatorHistory,
  type OperatorRecordTypesResponse,
  type OperatorRecordView,
  type PeriodSummary,
  type Principal,
  type RecordSubjectFile,
  type ReportIndicatorList,
  type RuleEvaluationListResponse,
  type SubjectFindingListResponse,
  type SubjectReference,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Badge, Button, Notice } from '@ledger/ui';
import { EvaluationReads } from './EvaluationReads.js';
import { explainedEvaluation, summaryText, withReadContext } from './evaluation-reads.js';
import { findingStatusLabels } from './finding-work.js';
import { counted, ctDay, time, timeRange, timeZone, timeZoneLabel } from './format.js';
import { columnFor, displayValue, recordHeadline, recordTime as recordTimeText } from './operator-records.js';
import { calendarDay, goTo, type Place, type ReportView } from './place.js';
import { FlightTimePage, OccurrencesPage } from './MonthReports.js';
import { ProgramGrantsPage, ProgramOperatorsPage } from './ProgramView.js';
import { IndicatorChart, MonthlyChart } from './ReportCharts.js';
import { CountLink, NotYours, PrintButton, Shown, useRead } from './ReportParts.js';
import { monthLabel } from './report-charts.js';
import { hoursAndMinutes, periodChoices, readingNeeds } from './report-periods.js';
import { coverageResultLabels } from './rule-coverage.js';
import { SubjectPicker } from './SubjectPicker.js';
import { subjectLabel } from './subject-label.js';
import { PlaceLink } from './TopBar.js';

/**
 * Reports a person reads, prints or saves: a summary of a period, findings opened and closed per month by rule, an
 * indicator's recorded results over time, one flight's file, and a month's flight time by aircraft and occurrences.
 * Every number is counted by the API from recorded things and links to the list it counts; a part the person may not
 * read is named as not theirs, never shown as zero. A safety report's content appears on none of them.
 */

const reports = (view: ReportView): Place => ({ section: 'reports', ...view });
/** The pages open to everyone who opens Reports: each names a part its reader may not read, or needs another permission. */
const partsSayWhoMayRead: ReportView['report'][] = ['home', 'summary', 'flight-time', 'occurrences', 'grants'];
const may = (principal: Principal | null, capability: Capability) =>
  Boolean(principal?.capabilities.includes(capability));

/** The organization's day today, YYYY-MM-DD. */
const today = () => ctDay(Date.now());

export function ReportsArea({
  client,
  principal,
  place,
}: {
  client: LedgerClient;
  principal: Principal | null;
  place: Place & { section: 'reports' };
}) {
  const records = may(principal, 'evidence:read');
  const current = place.report;
  const lastTwelve = (): Place => reports({ report: 'findings' });
  const thisMonth = periodChoices(today())[0]!;
  return (
    <main className="records-area reports-area" aria-label="Reports">
      <aside className="roster records-nav" aria-label="Reports navigation">
        <div className="roster-head">
          <h1>Reports</h1>
          <p className="roster-scope-caption">
            Counts of what your organization has on file, to read, print or save. Each one says what it does not count.
          </p>
          <nav className="sms-nav-links records-panes" aria-label="Reports">
            <PlaceLink place={reports({ report: 'home' })} current={current === 'home'}>
              All reports
            </PlaceLink>
            <PlaceLink
              place={
                current === 'summary'
                  ? place
                  : reports({ report: 'summary', from: thisMonth.from, until: thisMonth.until })
              }
              current={current === 'summary'}
            >
              Summary of a period
            </PlaceLink>
            <PlaceLink
              place={current === 'flight-time' ? place : reports({ report: 'flight-time' })}
              current={current === 'flight-time'}
            >
              Flight time by aircraft
            </PlaceLink>
            <PlaceLink
              place={current === 'occurrences' ? place : reports({ report: 'occurrences' })}
              current={current === 'occurrences'}
            >
              Occurrences by month
            </PlaceLink>
            {records && (
              <>
                <PlaceLink place={current === 'findings' ? place : lastTwelve()} current={current === 'findings'}>
                  Findings by month
                </PlaceLink>
                <PlaceLink place={reports({ report: 'indicators' })} current={current === 'indicators'}>
                  Indicators over time
                </PlaceLink>
                <PlaceLink place={reports({ report: 'operators' })} current={current === 'operators'}>
                  Operators you follow
                </PlaceLink>
              </>
            )}
            {may(principal, 'authority:write') && (
              <PlaceLink place={reports({ report: 'grants' })} current={current === 'grants'}>
                Shown to program owners
              </PlaceLink>
            )}
          </nav>
        </div>
      </aside>
      <section className="thread-workspace" aria-label="Report">
        <div className="thread-main report-page">
          {place.report === 'home' && <ReportsHome client={client} principal={principal} />}
          {place.report === 'summary' && (
            <PeriodSummaryPage client={client} principal={principal} from={place.from} until={place.until} />
          )}
          {place.report === 'flight-time' && <FlightTimePage client={client} month={place.month} />}
          {place.report === 'occurrences' && <OccurrencesPage client={client} month={place.month} />}
          {place.report === 'grants' && <ProgramGrantsPage client={client} principal={principal} />}
          {!partsSayWhoMayRead.includes(place.report) && !records && (
            <Notice tone="neutral" title="Not yours to read">
              This report counts records and findings. Reading them needs {readingNeeds['evidence:read']}. Ask the
              person who manages authority in your organization.
            </Notice>
          )}
          {records && place.report === 'findings' && (
            <FindingsByMonthPage client={client} from={place.from} until={place.until} />
          )}
          {records && place.report === 'indicators' && !place.id && <IndicatorList client={client} />}
          {records && place.report === 'indicators' && place.id && (
            <IndicatorPage client={client} principal={principal} id={place.id} version={place.version ?? 1} />
          )}
          {records && place.report === 'flight' && <FlightFilePage client={client} flightId={place.flightId} />}
          {records && place.report === 'operators' && <ProgramOperatorsPage client={client} principal={principal} />}
        </div>
      </section>
    </main>
  );
}

function ReportsHome({ client, principal }: { client: LedgerClient; principal: Principal | null }) {
  const records = may(principal, 'evidence:read');
  const [flight, setFlight] = useState('');
  return (
    <>
      <p className="thread-crumbs">Reports</p>
      <h2>Reports</h2>
      <p className="overview-purpose">
        Each report counts recorded things only: no score and no rating. It says when it was made and what it does not
        count, and prints on its own.
      </p>
      <section className="report-card" aria-label="Summary of a period">
        <h3>Summary of a period</h3>
        <p className="records-note">
          Flights and flight time from your flight records, findings by rule, actions open and overdue, and hazards by
          level, for the days you choose.
        </p>
        <PeriodChooser />
      </section>
      <section className="report-card" aria-label="Flight time by aircraft">
        <h3>Flight time by aircraft</h3>
        <p className="records-note">
          For a calendar month: each aircraft with a flight record in it, its registration and serial number, its
          flights and their time from takeoff to landing. To prepare a report you send yourself.
        </p>
        <PlaceLink className="button button--secondary" place={reports({ report: 'flight-time' })}>
          Flight time of the last whole month
        </PlaceLink>
      </section>
      <section className="report-card" aria-label="Occurrences by month">
        <h3>Occurrences by month</h3>
        <p className="records-note">
          For a calendar month: the occurrence records on file by type, each with its date, the flight and aircraft it
          names and what was recorded.
        </p>
        <PlaceLink className="button button--secondary" place={reports({ report: 'occurrences' })}>
          Occurrences of the last whole month
        </PlaceLink>
      </section>
      {records && (
        <>
          <section className="report-card" aria-label="Findings by month">
            <h3>Findings opened and closed by month</h3>
            <p className="records-note">
              For each rule as its pack names it, the last twelve months unless you choose.
            </p>
            <PlaceLink className="button button--secondary" place={reports({ report: 'findings' })}>
              The last twelve months
            </PlaceLink>
          </section>
          <section className="report-card" aria-label="Indicators over time">
            <h3>Indicators over time</h3>
            <p className="records-note">Each indicator’s recorded results, with the limit its definition sets.</p>
            <PlaceLink className="button button--secondary" place={reports({ report: 'indicators' })}>
              The indicators with recorded results
            </PlaceLink>
          </section>
          <section className="report-card" aria-label="Operators you follow">
            <h3>Operators you follow</h3>
            <p className="records-note">
              For an organization that contracts operators: what each operator’s own Ledger shows you under its grant,
              side by side.
            </p>
            <PlaceLink className="button button--secondary" place={reports({ report: 'operators' })}>
              The operators you follow
            </PlaceLink>
          </section>
          <section className="report-card" aria-label="One flight’s file">
            <h3>One flight’s file</h3>
            <p className="records-note">
              The flight’s own records, the records about it, each rule’s result for it and its findings, on one page.
            </p>
            <form
              className="records-subject"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                if (flight.trim()) goTo(reports({ report: 'flight', flightId: flight.trim() }));
              }}
            >
              <label htmlFor="report-flight">Flight id</label>
              <SubjectPicker
                client={client}
                sourceId={OPERATOR_RECORD_SOURCE_ID}
                id="report-flight"
                kinds={['flight']}
                value={flight}
                onChange={setFlight}
                onChoose={(option) => goTo(reports({ report: 'flight', flightId: option.id }))}
                placeholder="Your id for the flight"
              />
              <Button type="submit" disabled={!flight.trim()}>
                Open its file
              </Button>
            </form>
          </section>
        </>
      )}
      {may(principal, 'authority:write') && (
        <section className="report-card" aria-label="Shown to program owners">
          <h3>Shown to program owners</h3>
          <p className="records-note">
            Grants that let an organization that contracts you read your coverage and open findings as counts, for a
            period you choose.
          </p>
          <PlaceLink className="button button--secondary" place={reports({ report: 'grants' })}>
            The grants you made
          </PlaceLink>
        </section>
      )}
    </>
  );
}

/** The usual periods, and two days a person picks; each opens the summary at an address of its own. */
function PeriodChooser({ from, until }: { from?: string; until?: string }) {
  const [first, setFirst] = useState(from ?? '');
  const [last, setLast] = useState(until ?? '');
  const valid = calendarDay(first) && calendarDay(last) && first <= last;
  return (
    <div className="report-period" aria-label="Choose a period">
      <ul className="report-period-choices">
        {periodChoices(today()).map((choice) => (
          <li key={choice.label}>
            <PlaceLink
              className="button button--quiet"
              place={reports({ report: 'summary', from: choice.from, until: choice.until })}
              current={choice.from === from && choice.until === until}
            >
              {choice.label}
            </PlaceLink>
          </li>
        ))}
      </ul>
      <form
        className="report-period-days"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (valid) goTo(reports({ report: 'summary', from: first, until: last }));
        }}
      >
        <label>
          First day <input type="date" value={first} onChange={(event) => setFirst(event.target.value)} required />
        </label>
        <label>
          Last day <input type="date" value={last} onChange={(event) => setLast(event.target.value)} required />
        </label>
        <Button type="submit" disabled={!valid}>
          Show the summary
        </Button>
      </form>
      <p className="records-note">Days are in your organization’s time zone, {timeZone()}.</p>
    </div>
  );
}

function PeriodSummaryPage({
  client,
  principal,
  from,
  until,
}: {
  client: LedgerClient;
  principal: Principal | null;
  from: string;
  until: string;
}) {
  const loaded = useRead(() => client.periodSummary({ from, until }), `${from}/${until}`);
  return (
    <>
      <p className="thread-crumbs">Reports / Summary of a period</p>
      <div className="thread-title">
        <h2>
          Summary of {from} to {until}
        </h2>
        <PrintButton />
      </div>
      <PeriodChooser key={`${from}/${until}`} from={from} until={until} />
      <Shown loaded={loaded} label="Counting what is on file">
        {(summary) => <PeriodSummaryView summary={summary} principal={principal} />}
      </Shown>
    </>
  );
}

const browse = (type: string): Place => ({ section: 'records', pane: 'browse', type });

function PeriodSummaryView({ summary, principal }: { summary: PeriodSummary; principal: Principal | null }) {
  const { period, flights, findings, findingActions, assuranceActions, hazards } = summary;
  const atEnd = period.ended ? 'at the end of the period' : 'now';
  const safety = may(principal, 'sms:read');
  return (
    <div className="report-summary" data-testid="period-summary">
      <p className="report-made">
        Made {time(summary.computedAt, true)} {timeZoneLabel()} from the records on file. The period runs from the start
        of {period.from} to the end of {period.until}, in {period.timeZone}.
        {!period.ended && (
          <>
            {' '}
            It has not ended: what is open “at the end” is counted as of {time(period.asOf, true)} {timeZoneLabel()}.
          </>
        )}
      </p>
      <section aria-label="Flights" data-testid="summary-flights">
        <h3>Flights</h3>
        {flights.readable ? (
          <>
            <dl className="report-facts">
              <div>
                <dt>Flights with a flight record, taking off in the period</dt>
                <dd>
                  <CountLink count={flights.flights} place={browse('flight.record@1')} one="flight" many="flights" />
                </dd>
              </div>
              <div>
                <dt>Their recorded time, takeoff to landing</dt>
                <dd>{hoursAndMinutes(flights.flightSeconds)}</dd>
              </div>
              <div>
                <dt>Flights planned to start in the period with no flight record on file, not counted above</dt>
                <dd>
                  <CountLink
                    count={flights.plannedWithoutRecord}
                    place={browse('flight.plan@1')}
                    one="flight planned with no flight record"
                    many="flights planned with no flight record"
                  />
                </dd>
              </div>
            </dl>
            {flights.withoutDuration > 0 && (
              <ul className="records-reasons" aria-label="Flights counted apart">
                <li>
                  {counted(flights.withoutDuration, 'flight')} with no landing time on file, or with a landing recorded
                  no later than the takeoff: in the flights, not in the time. Flight time by aircraft lists each.
                </li>
              </ul>
            )}
          </>
        ) : (
          <NotYours part="Flights" capability={flights.capability} />
        )}
      </section>
      <section aria-label="Findings by rule" data-testid="summary-findings">
        <h3>Findings by rule</h3>
        {findings.readable ? (
          <>
            {findings.rules.length === 0 ? (
              <p className="records-note">No counted finding opened, closed or was open {atEnd} in the period.</p>
            ) : (
              <>
                <p className="records-note" data-testid="summary-findings-counts">
                  Each number counts findings of rules adopted to count, not the subjects they are about.{' '}
                  {period.ended
                    ? 'Open at the end of the period counts the findings opened before its end and not closed by then.'
                    : 'Open now is the number Rules › Open findings lists for each rule.'}
                </p>
                <table className="report-numbers">
                  <thead>
                    <tr>
                      <th scope="col">Rule</th>
                      <th scope="col">Opened in the period</th>
                      <th scope="col">Closed in the period</th>
                      <th scope="col">Open {atEnd}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.rules.map((rule) => (
                      <tr key={`${rule.packId}/${rule.ruleId}`} data-testid="summary-rule">
                        <th scope="row">
                          <PlaceLink place={{ section: 'rules', pane: 'coverage', packId: rule.packId }}>
                            {rule.ruleTitle}
                          </PlaceLink>
                          <small>{rule.packTitle}</small>
                        </th>
                        <td>{rule.opened}</td>
                        <td>{rule.closed}</td>
                        <td>{rule.openAtEnd}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Every rule</th>
                      <td>{findings.total.opened}</td>
                      <td>{findings.total.closed}</td>
                      <td>
                        <CountLink
                          count={findings.total.openAtEnd}
                          place={{ section: 'rules', pane: 'open' }}
                          one={`finding open ${atEnd}`}
                          many={`findings open ${atEnd}`}
                        />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )}
            {(findings.proposed > 0 || findings.relieved > 0) && (
              <p className="records-note">
                Not counted: {counted(findings.proposed, 'finding')} of rules adopted to propose only, and{' '}
                {counted(findings.relieved, 'finding')} a waiver relieves, opened in the period.
              </p>
            )}
          </>
        ) : (
          <NotYours part="Findings" capability={findings.capability} />
        )}
      </section>
      <section aria-label="Actions" data-testid="summary-actions">
        <h3>Actions open {atEnd}</h3>
        <dl className="report-facts">
          <div>
            <dt>On findings</dt>
            <dd>
              {findingActions.readable ? (
                <>
                  <CountLink
                    count={findingActions.open}
                    place={{ section: 'rules', pane: 'open' }}
                    one="action on findings open"
                    many="actions on findings open"
                  />{' '}
                  open, {findingActions.overdue} of them overdue
                </>
              ) : (
                <NotYours part="Actions on findings" capability={findingActions.capability} />
              )}
            </dd>
          </div>
          <div>
            <dt>Of safety assurance records</dt>
            <dd>
              {assuranceActions.readable ? (
                <>
                  <CountLink
                    count={assuranceActions.open}
                    place={{ section: 'safety', view: 'assurance' }}
                    one="action of safety assurance records open"
                    many="actions of safety assurance records open"
                  />{' '}
                  open, {assuranceActions.overdue} of them overdue
                </>
              ) : (
                <NotYours part="Actions of safety assurance records" capability={assuranceActions.capability} />
              )}
            </dd>
          </div>
        </dl>
      </section>
      <section aria-label="Hazards by level" data-testid="summary-hazards">
        <h3>Hazards open {atEnd}, by level</h3>
        {hazards.readable ? (
          hazards.total === 0 ? (
            <p className="records-note">No hazard was open {atEnd}.</p>
          ) : (
            <table className="report-numbers">
              <thead>
                <tr>
                  <th scope="col">Level of the latest assessment</th>
                  <th scope="col">Hazards</th>
                </tr>
              </thead>
              <tbody>
                {hazards.levels.map((level) => (
                  <tr key={level.level}>
                    <th scope="row">{level.label}</th>
                    <td>{level.count}</td>
                  </tr>
                ))}
                {hazards.notAssessed > 0 && (
                  <tr>
                    <th scope="row">Not assessed yet</th>
                    <td>{hazards.notAssessed}</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Every hazard open {atEnd}</th>
                  <td>
                    {safety ? (
                      <CountLink
                        count={hazards.total}
                        place={{ section: 'safety', view: 'hazards' }}
                        one={`hazard open ${atEnd}`}
                        many={`hazards open ${atEnd}`}
                      />
                    ) : (
                      hazards.total
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          )
        ) : (
          <NotYours part="Hazards" capability={hazards.capability} />
        )}
      </section>
      <section aria-label="What this summary does not count" className="report-limits">
        <h3>What this summary does not count</h3>
        <ul className="records-reasons">
          <li>
            Flights known only from an order source, or only from a plan: a flight counts once its flight record is on
            file.
          </li>
          <li>
            Findings of rules adopted to propose only, and those a waiver relieves; they are named above when there are
            any.
          </li>
          <li>
            A finding closed and later opened again counts as open; its earlier closing is in its own history, not here.
          </li>
          <li>The content of safety reports: no report’s words appear here.</li>
        </ul>
      </section>
    </div>
  );
}

function FindingsByMonthPage({ client, from, until }: { client: LedgerClient; from?: string; until?: string }) {
  const loaded = useRead(
    () => client.findingsByMonth(from && until ? { from, until } : {}),
    `${from ?? ''}/${until ?? ''}`,
  );
  const [rule, setRule] = useState('');
  return (
    <>
      <p className="thread-crumbs">Reports / Findings by month</p>
      <div className="thread-title">
        <h2>Findings opened and closed by month</h2>
        <PrintButton />
      </div>
      <Shown loaded={loaded} label="Counting findings">
        {(monthly) => <FindingsByMonthView monthly={monthly} rule={rule} onRule={setRule} />}
      </Shown>
    </>
  );
}

function FindingsByMonthView({
  monthly,
  rule,
  onRule,
}: {
  monthly: FindingsByMonth;
  rule: string;
  onRule: (key: string) => void;
}) {
  const { period, months } = monthly;
  const [first, setFirst] = useState(period.from);
  const [last, setLast] = useState(period.until);
  const keyOf = (entry: FindingsByMonth['rules'][number]) => `${entry.packId}\u0000${entry.ruleId}`;
  const shown = monthly.rules.find((entry) => keyOf(entry) === rule);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const span = `${monthLabel(period.from)} to ${monthLabel(period.until)}`;
  return (
    <div data-testid="findings-by-month">
      <p className="report-made">
        Made {time(monthly.computedAt, true)} {timeZoneLabel()}. Counted findings from {span}, months in{' '}
        {period.timeZone}. Findings of rules adopted to propose only, and those a waiver relieves, are not counted.
      </p>
      <form
        className="report-period-days"
        aria-label="Choose the months"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (first <= last) goTo(reports({ report: 'findings', from: first, until: last }));
        }}
      >
        <label>
          First month <input type="month" value={first} onChange={(event) => setFirst(event.target.value)} />
        </label>
        <label>
          Last month <input type="month" value={last} onChange={(event) => setLast(event.target.value)} />
        </label>
        <Button type="submit" disabled={!first || !last || first > last}>
          Show these months
        </Button>
        <PlaceLink className="button button--quiet" place={reports({ report: 'findings' })}>
          The last twelve months
        </PlaceLink>
      </form>
      <label className="records-order">
        Rule{' '}
        <select value={rule} onChange={(event) => onRule(event.target.value)}>
          <option value="">Every rule</option>
          {monthly.rules.map((entry) => (
            <option key={keyOf(entry)} value={keyOf(entry)}>
              {entry.ruleTitle} · {entry.packTitle}
            </option>
          ))}
        </select>
      </label>
      <MonthlyChart
        months={months}
        opened={shown?.opened ?? monthly.total.opened}
        closed={shown?.closed ?? monthly.total.closed}
        label={shown ? `${shown.ruleTitle} (${shown.packTitle})` : 'Every rule'}
      />
      <section aria-label="By rule">
        <h3>By rule, {span}</h3>
        {monthly.rules.length === 0 ? (
          <p className="records-note">No counted finding opened or closed in these months.</p>
        ) : (
          <table className="report-numbers">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Opened</th>
                <th scope="col">Closed</th>
              </tr>
            </thead>
            <tbody>
              {monthly.rules.map((entry) => (
                <tr key={keyOf(entry)} data-testid="monthly-rule">
                  <th scope="row">
                    {entry.ruleTitle}
                    <small>{entry.packTitle}</small>
                  </th>
                  <td>{sum(entry.opened)}</td>
                  <td>{sum(entry.closed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function IndicatorList({ client }: { client: LedgerClient }) {
  const loaded = useRead<ReportIndicatorList>(() => client.reportIndicators(), 'indicators');
  return (
    <>
      <p className="thread-crumbs">Reports / Indicators over time</p>
      <h2>Indicators over time</h2>
      <p className="overview-purpose">
        Each indicator with a result recorded for a control window. A result is evidence for a person to review, never a
        verdict on the control.
      </p>
      <Shown loaded={loaded} label="Reading the indicators">
        {(list) =>
          list.indicators.length === 0 ? (
            <p className="records-note">
              No indicator result is recorded yet. A result is recorded on a hazard’s control, under Safety.
            </p>
          ) : (
            <ul className="records-items" data-testid="report-indicators">
              {list.indicators.map((indicator) => (
                <li key={`${indicator.id}@${indicator.version}`}>
                  <PlaceLink
                    className="records-item"
                    place={reports({ report: 'indicators', id: indicator.id, version: indicator.version })}
                  >
                    <span className="records-item-head">
                      <strong>{indicator.title ?? indicator.id}</strong>
                      <Badge tone="neutral">{counted(indicator.results, 'result')}</Badge>
                    </span>
                    <span className="records-item-meta">
                      Version {indicator.version} · windows from{' '}
                      {timeRange(indicator.firstWindowStart, indicator.lastWindowEnd)}
                    </span>
                  </PlaceLink>
                </li>
              ))}
            </ul>
          )
        }
      </Shown>
    </>
  );
}

function IndicatorPage({
  client,
  principal,
  id,
  version,
}: {
  client: LedgerClient;
  principal: Principal | null;
  id: string;
  version: number;
}) {
  const loaded = useRead<IndicatorHistory>(() => client.indicatorHistory(id, version), `${id}@${version}`);
  return (
    <>
      <p className="thread-crumbs">
        <PlaceLink place={reports({ report: 'indicators' })}>Reports / Indicators over time</PlaceLink>
      </p>
      <Shown loaded={loaded} label="Reading the recorded results">
        {(history) => (
          <>
            <div className="thread-title">
              <h2>{history.definition.title ?? history.definition.id}</h2>
              <PrintButton />
            </div>
            <p className="report-made">
              Version {history.definition.version}. Read {time(history.computedAt, true)} {timeZoneLabel()}.
              {history.truncated ? ' The newest results are shown; older ones remain recorded.' : ''}
            </p>
            {history.definition.description && <p className="overview-purpose">{history.definition.description}</p>}
            <IndicatorChart history={history} onOpenHazard={may(principal, 'sms:read')} />
          </>
        )}
      </Shown>
    </>
  );
}

/** One field of a record as a label and its value, for the printed file. */
function RecordFields({ view, catalog }: { view: OperatorRecordView; catalog: OperatorRecordTypesResponse | null }) {
  const type = catalog?.types.find(
    (item) => item.recordType === view.recordType && item.recordVersion === view.recordVersion,
  );
  if (!type) return null;
  const fields = type.fields.filter((field) => view.record[field.name] !== undefined && view.record[field.name] !== '');
  return (
    <dl className="records-fields">
      {fields.map((field) => (
        <div key={field.name}>
          <dt>{field.label}</dt>
          <dd>
            {displayValue(
              field,
              view.record[field.name],
              columnFor(type, field.name)?.units?.accepted[0]?.label,
              view.dayOnly?.[field.name]?.day,
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What one flight's file asks for about the flight: its evaluations and findings, as many as one page holds. The
 * subject is the one the flight's file resolved the id to: a flight Ledger holds by its own id, or one the operator's
 * records name by the operator's own id.
 */
export function flightFileQuery(subject: SubjectReference) {
  return {
    subjectKind: 'flight' as const,
    subjectId: subject.id,
    ...(subject.scope === 'source' ? { subjectScope: 'source' as const, sourceId: subject.sourceId } : {}),
    limit: SUBJECT_RECORD_PAGE_LIMIT,
  };
}

function FlightFilePage({ client, flightId }: { client: LedgerClient; flightId: string }) {
  const loaded = useRead(async () => {
    // The id alone names the flight; the file says which subject it is, and the rest is asked about that subject.
    const [file, catalog] = await Promise.all([
      client.request<RecordSubjectFile>(
        `/v1/operator-records/subjects/flight/${encodeURIComponent(flightId)}?${new URLSearchParams({ sourceId: OPERATOR_RECORD_SOURCE_ID })}`,
      ),
      client.request<OperatorRecordTypesResponse>('/v1/operator-records/types'),
    ]);
    const query = flightFileQuery(file.subject);
    const [evaluations, findings] = await Promise.all([client.ruleEvaluations(query), client.subjectFindings(query)]);
    return [file, catalog, evaluations, findings] as const;
  }, flightId);
  return (
    <Shown loaded={loaded} label="Reading the flight’s file">
      {([file, catalog, evaluations, findings]) => (
        <FlightFileView
          client={client}
          flightId={flightId}
          file={file}
          catalog={catalog}
          evaluations={evaluations}
          findings={findings}
        />
      )}
    </Shown>
  );
}

function FlightFileView({
  client,
  flightId,
  file,
  catalog,
  evaluations,
  findings,
}: {
  client: LedgerClient;
  flightId: string;
  file: RecordSubjectFile;
  catalog: OperatorRecordTypesResponse;
  evaluations: RuleEvaluationListResponse;
  findings: SubjectFindingListResponse;
}) {
  const own = file.groups
    .map((group) => ({ ...group, records: group.records.filter((record) => record.about === 'subject') }))
    .filter((group) => group.records.length);
  const about = file.groups
    .map((group) => ({ ...group, records: group.records.filter((record) => record.about !== 'subject') }))
    .filter((group) => group.records.length);
  const context = { inputSubjects: evaluations.inputSubjects, summaryWording: evaluations.summaryWording };
  const { name: _name, ...subject } = file.subject;
  const recordTime = (record: OperatorRecordView) => recordTimeText(record, { asOf: false });
  const group = (entry: (typeof own)[number]) => {
    const type = catalog.types.find(
      (item) => item.recordType === entry.recordType && item.recordVersion === entry.recordVersion,
    );
    return (
      <section
        key={`${entry.recordType}@${entry.recordVersion}`}
        aria-label={entry.title}
        className="report-record-group"
      >
        <h4>{entry.title}</h4>
        {entry.records.map((record) => (
          <article key={record.observationId} className="report-record">
            <p className="records-item-head">
              <strong>{type ? recordHeadline(type, record.record, record.dayOnly) : entry.title}</strong>
              {record.replacedBy && <Badge tone="neutral">Replaced</Badge>}
              {!record.complete && <Badge tone="attention">Incomplete</Badge>}
            </p>
            <p className="records-item-meta">
              {record.about !== 'subject' ? `${record.subject.kind} ${record.subject.id} · ` : ''}
              {recordTime(record)}
              {record.replacedBy ? ` · replaced by ${record.replacedBy}` : ''}
              {!record.complete ? ` · missing ${record.missingRequired.map((field) => field.label).join(', ')}` : ''}
            </p>
            <RecordFields view={record} catalog={catalog} />
          </article>
        ))}
      </section>
    );
  };
  return (
    <div className="report-flight" data-testid="flight-file">
      <p className="thread-crumbs">Reports / One flight’s file</p>
      <div className="thread-title">
        <h2>Flight {subjectLabel(file.subject)}</h2>
        <PrintButton />
      </div>
      <p className="report-made">
        {file.subject.scope === 'ledger' ? 'Ledger’s id' : 'Your id'} {flightId}. Read{' '}
        {time(new Date().toISOString(), true)} {timeZoneLabel()} from the records on file.
        {file.records.truncated ? ` The newest ${counted(file.records.shown, 'record')} are shown.` : ''}{' '}
        <PlaceLink place={{ section: 'records', pane: 'subjects', kind: 'flight', id: flightId }}>
          Open the flight under Records
        </PlaceLink>
      </p>
      <section aria-label="The flight’s own records">
        <h3>Its own records</h3>
        {own.length ? own.map(group) : <p className="records-note">No record about this flight is on file.</p>}
      </section>
      <section aria-label="Records about the flight">
        <h3>Records that name it</h3>
        {about.length ? about.map(group) : <p className="records-note">No other record names this flight.</p>}
      </section>
      <section aria-label="Each rule’s result" data-testid="flight-file-rules">
        <h3>Each rule’s result</h3>
        {!file.rules.length ? (
          <p className="records-note">No adopted rule has evaluated this flight yet.</p>
        ) : (
          file.rules.map((rule) => {
            const evaluation = evaluations.evaluations.find((item) => item.id === rule.evaluation.id);
            const explained = evaluation ? withReadContext(explainedEvaluation(evaluation), context) : null;
            return (
              <article key={`${rule.adoptionId}/${rule.leafId}`} className="report-rule" data-testid="flight-file-rule">
                <h4>
                  {rule.title}{' '}
                  {rule.mode === 'shadow' && <Badge tone="advisory">Proposed: recorded, not counted</Badge>}
                </h4>
                <p className="records-item-meta">
                  {rule.packTitle} · {coverageResultLabels[rule.result]} · evaluated{' '}
                  {time(rule.evaluation.recordedAt, true)} {timeZoneLabel()}
                </p>
                <p>{explained ? summaryText(explained) : rule.evaluation.summary}</p>
                {evaluation?.issues?.length ? (
                  <ul className="records-reasons" aria-label="What the rule named">
                    {evaluation.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
                {explained && <EvaluationReads client={client} subject={subject} evaluation={explained} />}
              </article>
            );
          })
        )}
      </section>
      <section aria-label="Its findings" data-testid="flight-file-findings">
        <h3>Its findings</h3>
        {!findings.findings.length ? (
          <p className="records-note">No finding about this flight is recorded.</p>
        ) : (
          <ul className="records-reasons">
            {findings.findings.map((finding) => (
              <li key={finding.id} data-testid="flight-file-finding">
                <strong>{finding.latestEvaluation.rule.title}</strong>
                {finding.mode === 'shadow' && (
                  <>
                    {' '}
                    <Badge tone="advisory">Proposed: recorded, not counted</Badge>
                  </>
                )}{' '}
                · {findingStatusLabels[finding.status]}, opened {time(finding.openedAt, true)} {timeZoneLabel()}
                {finding.owner ? ` · owner ${finding.owner.name}` : ' · no owner'}
                {finding.action ? ` · action due ${finding.action.dueOn}: ${finding.action.note}` : ''}
              </li>
            ))}
          </ul>
        )}
        {findings.page.hasMore && (
          <p className="records-note">The newest findings are shown; older ones remain recorded.</p>
        )}
      </section>
    </div>
  );
}
