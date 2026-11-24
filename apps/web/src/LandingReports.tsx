import type { LedgerClient } from '@ledger/contracts/client';
import { Spinner } from '@ledger/ui';
import { useCitedObservations } from './evaluation-reads.js';
import { json, time, timeZoneLabel } from './format.js';
import { sourceLabel } from './labels.js';
import { isLandingDisagreementFinding, landingReportRows, type SafetyEvaluation } from './safety.js';

/** The reports a disagreement finding cites, laid out by the time each states. */
export function LandingReports({
  client,
  flightId,
  evaluation,
}: {
  client: LedgerClient | null;
  flightId: string;
  evaluation: SafetyEvaluation;
}) {
  const disagreement = isLandingDisagreementFinding(evaluation);
  const cited = useCitedObservations(disagreement ? client : null, { kind: 'flight', id: flightId }, evaluation);
  if (!disagreement) return null;
  const reports = landingReportRows(evaluation, cited.observations);
  return (
    <section aria-label="Reported landing times" data-testid="landing-reports">
      <h4>Reported landing times</h4>
      {cited.loading && <Spinner label="Reading the cited reports" />}
      {cited.error && <p className="muted">{cited.error}</p>}
      {reports.length ? (
        <ul className="finding-evidence">
          {reports.map((report, index) => (
            <li
              key={`${report.eventId}:${report.field}:${index}`}
              data-testid="landing-report"
              data-source-id={report.sourceId}
            >
              <strong>{sourceLabel(report.sourceId)}</strong>
              <small>
                {report.reportedTime ? (
                  <>
                    Reported landing{' '}
                    <time className="mono" dateTime={report.reportedTime}>
                      {time(report.reportedTime, true)} {timeZoneLabel()}
                    </time>
                  </>
                ) : (
                  <>Landing time could not be read: {report.value}</>
                )}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        !cited.loading && <p className="muted">No reported landing time is included in this evaluation.</p>
      )}
      <details className="safety-history">
        <summary>Reported values and references</summary>
        <pre>
          {json({
            evaluationId: evaluation.id,
            reports: reports.map(({ reportedTime: _reportedTime, ...report }) => report),
          })}
        </pre>
      </details>
    </section>
  );
}
