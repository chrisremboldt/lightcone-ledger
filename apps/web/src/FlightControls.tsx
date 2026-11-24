import { useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { FlightControl, FlightControlsResponse } from '@ledger/contracts';
import { Badge, Notice, Spinner } from '@ledger/ui';
import { errorMessage } from './format.js';
import { missionTime } from './missionRelease.js';
import { NotApplicableControls } from './NotApplicableControls.js';
import {
  appliesBecause,
  controlCheckWords,
  controlPeriodWords,
  controlResultSubject,
  controlResultTone,
  controlResultWords,
  controlsToReview,
  listedNotApplicableEntries,
  notApplicableHeading,
} from './flight-controls.js';

function ControlItem({
  control,
  wording,
  applicability,
}: {
  control: FlightControl;
  wording?: string;
  applicability?: ReadonlyMap<string, string>;
}) {
  const { effectiveFrom, effectiveUntil } = control.control;
  const period = controlPeriodWords(control.control, missionTime);
  return (
    <li
      className="flight-control"
      data-control-id={control.control.id}
      data-check={control.check}
      data-period={control.control.period}
    >
      <strong>{control.control.title}</strong>
      {period && <Badge tone="neutral">{period}</Badge>}
      <p>{wording ?? control.control.description}</p>
      {wording && wording !== control.control.description && (
        <details className="sms-control-names" data-testid="control-recorded-names">
          <summary>Names as recorded</summary>
          <p className="mono">{control.control.description}</p>
        </details>
      )}
      <ul className="flight-control-results">
        {control.results.map((result, index) => (
          <li key={`${result.subjectKey ?? 'control'}:${index}`} data-result={result.result}>
            <Badge tone={controlResultTone(result.result)}>{controlResultWords(result.result)}</Badge>
            {controlResultSubject(result) && <span className="muted"> {controlResultSubject(result)}</span>}
            <span> {result.summary}</span>
            {appliesBecause(result, applicability) && (
              <span className="muted" data-testid="control-applies-because">
                {' '}
                Applies · {appliesBecause(result, applicability)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <small className="muted">
        {controlCheckWords(control.check)} · hazard {control.hazard.title} · version {control.control.versionNumber} ·
        effective {missionTime(effectiveFrom)}
        {effectiveUntil ? ` – ${missionTime(effectiveUntil)}` : ''}
      </small>
    </li>
  );
}

interface Props {
  client: LedgerClient;
  flightId: string;
  /** Changes when the flight or its review is refreshed, so the list is read again. */
  revision?: number | string;
  /** Told each list as read, so a briefing can pin the list the person saw by its digest. */
  onRead?: (response: FlightControlsResponse) => void;
  /** Told when a read fails, so a briefing can say why it cannot be recorded yet. */
  onReadFailed?: (message: string) => void;
  /**
   * The sentences of the applicability records the route review or release on this screen holds, by record digest: a
   * route-review result that applies shows the one its digest names.
   */
  applicability?: ReadonlyMap<string, string>;
}

/**
 * The accepted controls in scope for a flight, in their own words, each with its current result. Shown at release,
 * briefing and departure. A result blocks nothing; the person deciding reads it.
 */
export function FlightControls({ client, flightId, revision, onRead, onReadFailed, applicability }: Props) {
  const [read, setRead] = useState<{ flightId: string; response: FlightControlsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    client
      .flightControls(flightId)
      .then((response) => {
        if (!current) return;
        setRead({ flightId, response });
        setError(null);
        onRead?.(response);
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setError(errorMessage(failure));
        onReadFailed?.(errorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [client, flightId, revision, onRead, onReadFailed]);
  const response = read?.flightId === flightId ? read.response : null;
  return (
    <section className="safety-section flight-controls" aria-label="Controls in scope for this flight">
      <div className="safety-section-heading">
        <h3>Controls in scope</h3>
        {response && controlsToReview(response.controls) > 0 && (
          <Badge tone="attention">{controlsToReview(response.controls)} to review</Badge>
        )}
      </div>
      {error && <Notice title="Controls unavailable">{error}</Notice>}
      {!response && !error && <Spinner label="Reading the accepted controls in scope" />}
      {response &&
        (response.controls.length || response.notApplicable.length ? (
          <>
            <p className="muted">
              Accepted controls in force for this flight, with their current results. A result does not block anything;
              you decide.
            </p>
            <ul className="flight-control-list" data-testid="flight-controls">
              {response.controls.map((control) => (
                <ControlItem
                  key={`${control.control.id}:${control.control.versionNumber}`}
                  control={control}
                  wording={response.wording?.[control.control.bodyDigest]}
                  applicability={applicability}
                />
              ))}
            </ul>
            {response.notApplicable.length > 0 && (
              <NotApplicableControls
                heading={notApplicableHeading(response.notApplicable.length)}
                entries={listedNotApplicableEntries(response.notApplicable)}
                collapsed={false}
                testId="flight-controls-not-applicable"
              />
            )}
            {!response.complete && <p className="muted">More accepted controls are in force than are shown.</p>}
          </>
        ) : (
          <p className="muted" data-testid="flight-controls">
            No accepted control is in scope for this flight.
          </p>
        ))}
    </section>
  );
}
