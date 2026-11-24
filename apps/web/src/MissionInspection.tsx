import { useEffect, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import { resolveAreaControl, type AreaControl } from './area-controls.js';
import { AreaControlSummary } from './AreaControlSummary.js';
import { RecordedReleaseFindings } from './ReleaseFindings.js';
import type {
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingControlRecordContent,
  MissionBriefingRecord,
  MissionReleaseRecord,
  MissionReleaseValidityResponse,
  TimelineItem,
} from '@ledger/contracts';
import { missionBriefingControls } from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { dayTime, errorMessage } from './format.js';
import { missionTime } from './missionRelease.js';
import {
  MissionReadFailure,
  readFailureCause,
  readFailureStep,
  subjectReadOutcome,
  type ReadFailureStep,
} from './read-failure.js';

type ControlContent = MissionBriefingControlRecordContent;
type Detail =
  | { kind: 'briefing'; record: MissionBriefingRecord }
  | {
      kind: 'release';
      record: MissionReleaseRecord;
      controls: { control: AreaControl; version: number; applicability: { summary: string } }[];
    };

const validityLabels: Record<MissionReleaseValidityResponse['status'], string> = {
  scheduled: 'Departure window has not started',
  current: 'Release context matches now',
  expired: 'Departure window ended',
  changed: 'Release context has changed',
  pending: 'Current release context is unconfirmed',
};

export function MissionInspection({
  active,
  client,
  flightId,
  item,
  onMission,
}: {
  active: boolean;
  client: LedgerClient;
  flightId: string;
  item: TimelineItem;
  onMission?: (releaseId?: string, briefingId?: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [coverage, setCoverage] = useState<MissionBriefingAcknowledgementsResponse | null>(null);
  const [validity, setValidity] = useState<MissionReleaseValidityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const acceptance = item.payload.acceptance as { briefing?: { id?: unknown } } | undefined;
  const briefingId =
    item.kind === 'mission.brief'
      ? item.id
      : typeof acceptance?.briefing?.id === 'string'
        ? acceptance.briefing.id
        : null;

  useEffect(() => {
    setDetail(null);
    setCoverage(null);
    setValidity(null);
    setError(null);
  }, [client, flightId, item.id, item.kind, briefingId]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    /** The record and its current status are what this view is about; its controls are listed by the release. */
    function failed(failure: unknown, readAgain: boolean): ReadFailureStep {
      if (stopped) return 'keep';
      const step = readFailureStep(subjectReadOutcome(failure), readAgain);
      if (step === 'read_again') return step;
      setCoverage(null);
      setValidity(null);
      if (step === 'clear') setDetail(null);
      setError(errorMessage(readFailureCause(failure)));
      return step;
    }

    async function refresh() {
      if (stopped) return;
      try {
        if (item.kind === 'mission.release') {
          const response = await client.missionReleaseValidity(flightId, item.id);
          if (!stopped) setValidity(response);
        } else if (briefingId) {
          const response = await client.missionBriefingAcknowledgements(flightId, briefingId);
          if (!stopped) {
            setCoverage(response);
            setValidity(response.releaseValidity);
          }
        }
        if (!stopped) setError(null);
      } catch (failure) {
        if (failed(failure, false) === 'clear' || stopped) return;
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 3000);
    }

    async function read(readAgainIfStale = true): Promise<void> {
      try {
        if (item.kind === 'mission.release') {
          const { release } = await client.missionRelease(flightId, item.id);
          if (stopped) return;
          const controls = await Promise.all(
            release.basis.avoidance.candidates.map(async (candidate) => {
              const control = await resolveAreaControl(client, candidate).catch((failure: unknown) => {
                if (failure instanceof ApiError) throw new MissionReadFailure('control', failure);
                throw new Error('The exact accepted control could not be matched.');
              });
              return { control, version: candidate.controlVersion, applicability: candidate.applicability };
            }),
          );
          if (!stopped) setDetail({ kind: 'release', record: release, controls });
        } else if (briefingId) {
          const { briefing } = await client.missionBriefing(flightId, briefingId);
          if (!stopped) setDetail({ kind: 'briefing', record: briefing });
        } else {
          throw new Error('The retained briefing reference is unavailable.');
        }
        if (!stopped) await refresh();
      } catch (failure) {
        // A control changed after the release listed it: one immediate read again, then on the polling interval.
        if (failed(failure, readAgainIfStale) === 'read_again') return read(false);
        if (!stopped && subjectReadOutcome(failure) === 'stale') timer = setTimeout(() => void read(), 3000);
      }
    }
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, flightId, item.id, item.kind, briefingId, reload, active]);

  const reviewed = coverage?.recipients.filter((recipient) => recipient.acknowledgement !== null).length;
  return (
    <div className="mission-inspection" data-testid="mission-inspection">
      {!detail && !error && <Spinner label="Reading the exact mission record" />}
      {error && (
        <Notice tone="attention" title="Mission details unavailable">
          {error}{' '}
          <Button kind="quiet" onClick={() => setReload((value) => value + 1)}>
            Retry details
          </Button>
        </Notice>
      )}
      {detail?.kind === 'briefing' && (
        <>
          <div className="mission-inspection-heading">
            <strong>Exact briefing · mission revision {detail.record.context.mission.sourceRevision}</strong>
            <Badge tone="neutral">Informational</Badge>
          </div>
          {onMission && (
            <Button kind="quiet" onClick={() => onMission(detail.record.context.release.id, detail.record.id)}>
              Review briefing →
            </Button>
          )}
          <blockquote className="mission-message">{detail.record.content.message}</blockquote>
          <p className="mission-inspection-note">
            Recorded by {detail.record.actor.name} at {dayTime(detail.record.recordedAt)}
          </p>
          {missionBriefingControls(detail.record).map(({ reference, content }) => (
            <ControlSummary key={reference.controlEventId} content={content} version={reference.controlVersion} />
          ))}
          <div className="briefing-recipients">
            <strong>
              Named recipients · {reviewed ?? '—'} / {detail.record.population.recipients.length} acknowledged
            </strong>
            <ul>
              {detail.record.population.recipients.map((recipient) => {
                const row = coverage?.recipients.find((entry) => entry.recipientPrincipalId === recipient.principalId);
                const acknowledgement = row?.acknowledgement?.record;
                return (
                  <li key={recipient.principalId}>
                    <span>{recipient.name}</span>
                    <span>
                      {acknowledgement
                        ? `Acknowledged ${dayTime(acknowledgement.recordedAt)}`
                        : coverage
                          ? 'No acknowledgement recorded'
                          : 'Checking acknowledgements…'}
                      {acknowledgement &&
                        row?.processing !== 'completed' &&
                        ` · projection ${row?.processing ?? 'unconfirmed'}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mission-inspection-note">Named recipients only · delivery is not recorded.</p>
          </div>
        </>
      )}
      {detail?.kind === 'release' && (
        <>
          <strong>Accepted release · mission revision {detail.record.basis.mission.sourceRevision}</strong>
          {onMission && (
            <Button kind="quiet" onClick={() => onMission(item.id)}>
              Review mission, release and briefing →
            </Button>
          )}
          <p className="mission-message">{detail.record.note}</p>
          <p className="mission-inspection-note">
            Accepted by {detail.record.actor.name} at {dayTime(detail.record.recordedAt)} · planned route outside{' '}
            {detail.controls.length} accepted control{detail.controls.length === 1 ? '' : 's'}
            {detail.record.basis.avoidance.notApplicable.length > 0 &&
              ` · ${detail.record.basis.avoidance.notApplicable.length} more do not apply to this route`}
          </p>
          {detail.controls.map(({ control, version, applicability }, index) => (
            <AreaControlSummary key={index} control={control} version={version} applicability={applicability} />
          ))}
          <p className="mission-inspection-note">
            Departure window · {missionTime(detail.record.departureWindow.start)}–
            {missionTime(detail.record.departureWindow.end)}
          </p>
          <RecordedReleaseFindings release={detail.record} />
        </>
      )}
      {detail && (
        <div className="mission-current-validity" aria-live="polite">
          <strong>Current release status</strong>
          <span>{validity ? validityLabels[validity.status] : 'Current status unavailable'}</span>
          {validity && <small>Checked {dayTime(validity.evaluatedAt)}</small>}
          <p className="mission-inspection-note">
            Historical acceptance stays recorded. Departure authorization is separate.
          </p>
        </div>
      )}
    </div>
  );
}

function ControlSummary({ content, version }: { content: ControlContent; version: number }) {
  return (
    <div className="mission-control-summary">
      <strong>
        {content.title} · control version {version}
      </strong>
      <span>{content.description}</span>
      <span>
        Effective {missionTime(content.effectiveFrom)}–
        {content.effectiveUntil ? missionTime(content.effectiveUntil) : 'until withdrawn'}
      </span>
    </div>
  );
}
