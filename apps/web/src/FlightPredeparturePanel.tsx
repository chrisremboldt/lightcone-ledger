import type { LedgerClient } from '@ledger/contracts/client';
import { Button, Notice } from '@ledger/ui';
import { json, time, timeZoneLabel } from './format.js';
import {
  predepartureBriefings,
  predeparturePresentation,
  predepartureReadyAttention,
  predepartureReleaseCurrent,
} from './predeparture.js';
import { useFlightPredeparture } from './useFlightPredeparture.js';
import { departureBriefingWords } from './flight-controls.js';
import { briefingStandingWords } from './briefing.js';

export function FlightPredeparturePanel({
  active,
  client,
  flightId,
  onReviewRoute,
  onReviewRelease,
  onReleaseRecord,
  onBriefing,
  status,
  compact = false,
}: {
  active: boolean;
  client: LedgerClient;
  flightId: string;
  onReviewRoute?: () => void;
  onReviewRelease?: () => void;
  onReleaseRecord?: (releaseId: string) => void;
  onBriefing?: (releaseId: string, briefingId?: string, controlEventId?: string) => void;
  status?: ReturnType<typeof useFlightPredeparture>;
  compact?: boolean;
}) {
  const loaded = useFlightPredeparture(active && status === undefined, client, flightId);
  const { read, error } = status ?? loaded;
  const response = read?.response;
  const progress = response?.progress;
  if (!progress && !error) return null;
  if (!progress || !response || !read) return <Notice title="Departure progress unavailable">{error}</Notice>;
  const presentation = predeparturePresentation(progress);
  const readyAttention = predepartureReadyAttention(response, read.release, Boolean(error));
  const releaseCurrent = predepartureReleaseCurrent(response, read.release);
  const briefings = read.release ? predepartureBriefings(response, read.release, read.controls) : [];
  const lapsed = briefings.filter((entry) => entry.lapsed);
  const needsBriefings =
    ['awaiting_briefing', 'awaiting_acknowledgement'].includes(progress.phase) ||
    (progress.phase === 'ready' && lapsed.length > 0);
  // One briefing covers every control that has none or whose briefing lapsed; the rows list what covers each control.
  const unbriefed = briefings.filter((entry) => !entry.briefing || entry.lapsed);
  const missing = unbriefed.length - lapsed.length;
  const briefingNavigation = (
    <ul className="predeparture-briefings">
      {briefings.map((entry) => (
        <li key={entry.controlEventId}>
          <strong>{entry.label}</strong>
          <span>
            {!entry.briefing
              ? 'No linked briefing recorded · covered by the controls briefing to prepare'
              : entry.lapsed && entry.standing
                ? `${briefingStandingWords(entry.standing)} ${entry.acknowledged} / ${entry.recipients} named recipients reviewed it before then.`
                : entry.recipients === undefined
                  ? 'Personal review coverage unconfirmed'
                  : `${entry.acknowledged} / ${entry.recipients} named recipients reviewed`}
          </span>
          {onBriefing && entry.briefing && (
            <Button
              kind={entry.complete ? 'quiet' : 'next'}
              onClick={() => onBriefing(read.release!.id, entry.briefing!.id, entry.controlEventId)}
            >
              {entry.complete ? 'Review briefing →' : 'Open exact personal review →'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
  const prepareBriefing = onBriefing && unbriefed.length > 0 && (
    <Button
      kind="next"
      disabled={!releaseCurrent || Boolean(error)}
      onClick={() => onBriefing(read.release!.id, undefined, unbriefed[0]!.controlEventId)}
    >
      Prepare the controls briefing →
    </Button>
  );
  return (
    <section
      className={`safety-section predeparture-progress ${presentation.attention || readyAttention ? 'needs-attention' : ''}`}
      aria-label="Flight departure progress"
    >
      <h3>{readyAttention ? 'Departure prerequisites need review' : presentation.label}</h3>
      {readyAttention && (
        <>
          <Notice tone="attention" title="Current departure basis unconfirmed">
            {readyAttention}
          </Notice>
          <p className="muted">Source last reported: {presentation.label}.</p>
        </>
      )}
      {error && <Notice title="Departure updates interrupted">{error} Last received progress stays visible.</Notice>}
      <p className="muted predeparture-clocks">
        Source observed {time(progress.sourceObservedAt, true)} {timeZoneLabel()} · recorded{' '}
        {time(progress.recordedAt, true)} {timeZoneLabel()}
      </p>
      {progress.phase === 'awaiting_route' && (
        <p>Review this mission against every accepted area. Apply and project a suitable route before human release.</p>
      )}
      {progress.phase === 'awaiting_release' && (
        <p>The flight remains held for human release, including after its route clears the accepted areas.</p>
      )}
      {needsBriefings && (
        <p>
          Every accepted area in this release needs an exact briefing that lists it, and every named recipient’s
          personal review. One briefing can cover several areas.
        </p>
      )}
      {['blocked', 'departure_unknown'].includes(progress.phase) && <p>{progress.reason}</p>}
      {progress.phase === 'ready' && !readyAttention && (
        <p>The source will check timing, allocation and final departure authorization before departure.</p>
      )}
      {progress.phase === 'evaluating' && <p>The source is checking the recorded route before dispatch.</p>}
      {read.release && (
        <p>
          Release recorded by {read.release.actor.name} · mission revision {read.release.basis.mission.sourceRevision}
        </p>
      )}
      {read.release && (
        <p className="predeparture-coverage" data-testid="departure-briefing-count">
          {departureBriefingWords(
            read.release.basis.avoidance.candidates.length,
            read.release.basis.avoidance.notApplicable.length,
          )}
        </p>
      )}
      {read.release && onReleaseRecord && (
        <Button kind="quiet" onClick={() => onReleaseRecord(read.release!.id)}>
          Review recorded release →
        </Button>
      )}
      {onReviewRoute &&
        (readyAttention ||
          ['awaiting_route', 'blocked', 'awaiting_release'].includes(progress.phase) ||
          (needsBriefings && !onBriefing)) && (
          <Button
            kind="next"
            onClick={progress.phase === 'awaiting_release' && onReviewRelease ? onReviewRelease : onReviewRoute}
          >
            {needsBriefings
              ? 'Review mission and briefings →'
              : progress.phase === 'awaiting_release' && onReviewRelease
                ? 'Review release action →'
                : 'Review mission route →'}
          </Button>
        )}
      {needsBriefings && read.release && (
        <>
          {!releaseCurrent && (
            <p role="status">
              The source-linked release is not confirmed current. Review the mission and release before preparing
              another briefing.
            </p>
          )}
          <p className="predeparture-coverage">
            Control briefings · {briefings.filter((entry) => entry.complete).length} / {briefings.length} personally
            reviewed
          </p>
          {briefings.length === 0 && <p>No accepted areas in this release require a control briefing.</p>}
          {missing > 0 && (
            <p className="predeparture-coverage">
              {missing === 1
                ? 'One area has no briefing yet; the controls briefing will cover it.'
                : `${missing} areas have no briefing yet; one controls briefing will cover all of them.`}
            </p>
          )}
          {lapsed.length > 0 && (
            <p className="predeparture-coverage" data-testid="departure-briefing-lapsed">
              {lapsed.length === 1
                ? 'The briefing for one area has lapsed and no longer counts; a new briefing is needed.'
                : `The briefings for ${lapsed.length} areas have lapsed and no longer count; a new briefing is needed.`}
            </p>
          )}
          {prepareBriefing}
          {compact && briefings.length > 0 ? (
            <details className="predeparture-navigation">
              <summary>All control briefings · {briefings.length} areas</summary>
              {briefingNavigation}
            </details>
          ) : (
            briefingNavigation
          )}
        </>
      )}
      {response.processing !== 'completed' && (
        <p className="muted">Departure report processing · {response.processing ?? 'unconfirmed'}</p>
      )}
      <p className="muted predeparture-clocks">
        Progress read {time(response.readAt, true)} {timeZoneLabel()}
      </p>
      <details className="mission-provenance">
        <summary>Source progress and exact references</summary>
        <p>{progress.reason}</p>
        <pre>{json(response)}</pre>
      </details>
    </section>
  );
}
