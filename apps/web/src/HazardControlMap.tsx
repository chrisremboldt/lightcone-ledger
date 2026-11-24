import { useEffect, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import type { MissionRevisionRecord } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import {
  SpatialMap,
  type SpatialCircle,
  type SpatialDraft,
  type SpatialLine,
  type SpatialPoint,
} from './SpatialMap.js';
import { fitCoordinates, offsetCoordinate, type GeographicView } from './geography.js';
import { places } from './places.js';
import { sourceLabel } from './labels.js';
import { errorMessage, time, timeZoneLabel } from './format.js';
import { canonicalDigest } from './safety.js';
import { resolveAreaControl } from './area-controls.js';
import { useOccurrenceLocations } from './useOccurrenceLocations.js';
import { MissionReadFailure, readFailureCause, readFailureStep, subjectReadOutcome } from './read-failure.js';
import {
  selectOccurrenceLocation,
  type LocationCandidate,
  type OccurrenceEvaluation,
  type SelectedOccurrenceLocation,
} from './occurrence-location.js';

interface Props {
  active: boolean;
  /**
   * The flight a hazard came from, whose occurrence evidence and mission corridor the map shows. Without one the map
   * shows the area alone, as the editor of an area control on any hazard.
   */
  client?: LedgerClient;
  flightId?: string;
  evaluation?: OccurrenceEvaluation;
  draft?: SpatialDraft;
  editable: boolean;
  onChange: (draft: SpatialDraft) => void;
  selectedEvidence: SelectedOccurrenceLocation | null;
  onSelectEvidence: (selection: SelectedOccurrenceLocation) => void;
  view: GeographicView | null;
  onView: (view: GeographicView) => void;
}
const methodLabels = {
  source_report: 'Position in the cited source report',
  telemetry_exact: 'Historical telemetry at the event time',
  interpolated: 'Interpolated historical telemetry',
  nearby: 'Nearby historical telemetry',
};
function offsetLabel(candidate: LocationCandidate) {
  if (candidate.bracketOffsetsMs)
    return `Samples ${candidate.bracketOffsetsMs.map((offset) => `${offset > 0 ? '+' : ''}${offset / 1000} s`).join(' / ')} from the occurrence`;
  return candidate.signedOffsetMs === 0
    ? 'At the occurrence time'
    : `${Math.abs(candidate.signedOffsetMs) / 1000} s ${candidate.signedOffsetMs > 0 ? 'after' : 'before'} the occurrence`;
}
function occurrenceLabel(evaluation: OccurrenceEvaluation, eventId: string, index: number) {
  const explanation = evaluation.explanation;
  if ('kind' in explanation && explanation.kind === 'command_link') {
    const report = explanation.evidence.find((item) => item.eventId === eventId);
    if (report?.status === 'lost') return 'Command-link loss report';
    if (report?.status === 'restored') return 'Restoration report';
  }
  if ('kind' in explanation && explanation.kind === 'rule') return `Report ${index + 1}`;
  return `Occurrence ${index + 1}`;
}

export function HazardControlMap({
  active,
  client,
  flightId,
  evaluation,
  draft,
  editable,
  onChange,
  selectedEvidence,
  onSelectEvidence,
  view,
  onView,
}: Props) {
  const locations = useOccurrenceLocations({ active, client, flightId, evaluation });
  const [context, setContext] = useState<{
    flightId: string;
    mission: MissionRevisionRecord | null;
    controls: SpatialCircle[];
  } | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [referenceArea, setReferenceArea] = useState('');
  useEffect(() => {
    if (!active || !client || !flightId) return;
    let stopped = false;
    async function load(readAgainIfStale = true): Promise<void> {
      if (!client || !flightId) return;
      try {
        const [current, preview] = await Promise.all([
          client.flightMission(flightId),
          client.missionAvoidance(flightId),
        ]);
        const missionPending = preview.reasons.includes('mission_projection_pending');
        let mission: MissionRevisionRecord | null = null;
        if (preview.mission && !missionPending && !preview.reasons.includes('unsupported_mission')) {
          const matches = async (record: MissionRevisionRecord | null) =>
            Boolean(
              record &&
              record.flightId === flightId &&
              record.id === preview.mission!.eventId &&
              record.missionId === preview.mission!.missionId &&
              record.sourceRevision === preview.mission!.sourceRevision &&
              record.contentDigest === preview.mission!.contentDigest &&
              (await canonicalDigest(record)) === preview.mission!.recordDigest,
            );
          mission = current.projectedHead;
          if (!(await matches(mission)))
            mission = (await client.flightMissionRevision(flightId, preview.mission.sourceRevision)).mission;
          if (!(await matches(mission)))
            throw new Error(
              'The mission corridor does not match the accepted-control comparison. Refresh the map context.',
            );
        }
        const controls = await Promise.all(
          preview.candidates.map(async (candidate) => {
            const exact = await resolveAreaControl(client, candidate).catch((failure: unknown) => {
              if (failure instanceof ApiError) throw new MissionReadFailure('control', failure);
              throw new Error('An accepted area did not match its retained control.');
            });
            return {
              id: exact.eventId,
              label: exact.title,
              center: exact.area.center,
              radiusMeters: exact.area.radiusMeters,
              state: 'accepted' as const,
            };
          }),
        );
        if (!stopped) {
          setContext({ flightId, mission, controls });
          setContextError(
            missionPending
              ? 'The accepted origin mission is still processing. No earlier corridor is substituted.'
              : preview.mission && !mission
                ? 'The origin mission geometry is unsupported; corridor context is unavailable.'
                : preview.candidateCompleteness.status === 'incomplete' && preview.mission
                  ? 'The origin mission’s accepted-control selection is incomplete.'
                  : null,
          );
        }
      } catch (error) {
        if (!stopped) {
          // The flight's mission and comparison are what the map shows; a control is one the comparison listed.
          const step = readFailureStep(subjectReadOutcome(error), readAgainIfStale);
          if (step === 'read_again') return load(false);
          setContext(null);
          setContextError(
            step === 'clear'
              ? 'Access to the mission map context changed. Refresh the safety record.'
              : errorMessage(readFailureCause(error)),
          );
        }
      }
    }
    void load();
    return () => {
      stopped = true;
    };
  }, [active, client, flightId]);
  const shown = context?.flightId === flightId ? context : null;
  // Occurrence evidence is read only for a flight's evaluation, so data implies one.
  const data = evaluation ? locations.data : null;
  const lines: SpatialLine[] = [];
  if (shown?.mission)
    lines.push({
      id: shown.mission.id,
      label: `Origin mission revision ${shown.mission.sourceRevision}`,
      kind: 'mission',
      corridorMeters: shown.mission.lateralToleranceMeters,
      points: shown.mission.route.geometry.coordinates.map(([longitude, latitude]) => ({ longitude, latitude })),
    });
  const samples = data?.samples ?? [];
  const tracks = new Map<string, typeof samples>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.sourceId, sample.sourceSessionId, sample.deviceId]);
    tracks.set(key, [...(tracks.get(key) ?? []), sample]);
  }
  for (const [key, track] of tracks) {
    track.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    for (let index = 1; index < track.length; index++) {
      const from = track[index - 1]!,
        to = track[index]!;
      if (
        to.sequence !== from.sequence + 1 ||
        from.conflict ||
        to.conflict ||
        Date.parse(to.occurredAt) <= Date.parse(from.occurredAt)
      )
        continue;
      lines.push({
        id: `${key}:${from.id}:${to.id}`,
        kind: 'observed',
        label: `Historical ${sourceLabel(from.sourceId)} track`,
        points: [from, to],
      });
    }
  }
  const currentSelections = (data?.occurrences ?? []).flatMap((occurrence, index) =>
    occurrence.candidates.map((candidate) => ({
      occurrence,
      index,
      selection: selectOccurrenceLocation(evaluation!, occurrence, candidate),
    })),
  );
  const selectedInRead = Boolean(
    selectedEvidence && currentSelections.some(({ selection }) => selection.id === selectedEvidence.id),
  );
  const points: SpatialPoint[] = currentSelections.map(({ occurrence, index, selection }) => ({
    id: selection.id,
    label: occurrenceLabel(evaluation!, occurrence.report.eventId, index),
    position: selection.candidate.position,
    kind: 'event',
    selected: selectedEvidence?.id === selection.id,
    onSelect: () => onSelectEvidence(selection),
  }));
  if (selectedEvidence && !selectedInRead)
    points.push({
      id: 'retained-selected-evidence',
      label: 'Selected location · retained',
      position: selectedEvidence.candidate.position,
      kind: 'event',
      selected: true,
    });
  if (referenceArea && places[referenceArea])
    points.push({
      id: 'manual-map-reference',
      label: `Map reference: ${referenceArea}`,
      position: places[referenceArea]!,
      kind: 'required',
    });
  const controls = shown?.controls ?? [];
  return (
    <section
      className="safety-section"
      aria-label="Hazard occurrence and avoidance area"
      data-testid="hazard-control-map"
    >
      <div className="hazard-location-header">
        <h3>{flightId ? 'Occurrence and avoidance area' : 'Avoidance area'}</h3>
        {flightId && (
          <Button type="button" kind="quiet" onClick={locations.reload} disabled={locations.status === 'loading'}>
            Refresh evidence locations
          </Button>
        )}
      </div>
      <p>
        {flightId
          ? 'The evidence places the occurrence. Your proposed radius is a precaution you choose.'
          : 'Place the centre on the map or enter it, then choose the radius.'}
      </p>
      {locations.status === 'loading' && !data && (
        <Spinner label="Reading the exact reports and historical telemetry" />
      )}
      {(locations.error || contextError) && (
        <Notice title="Map context incomplete">
          {locations.error} {contextError}
        </Notice>
      )}
      {!shown?.mission && !data?.occurrences.some((occurrence) => occurrence.candidates.length) && (
        <label className="manual-map-reference">
          View an operating site · map reference only
          <select
            value={referenceArea}
            onChange={(event) => {
              setReferenceArea(event.target.value);
              const point = places[event.target.value];
              const next =
                point && fitCoordinates([offsetCoordinate(point, -750, -750), offsetCoordinate(point, 750, 750)]);
              if (next) onView(next);
            }}
          >
            <option value="">Choose an area for manual placement</option>
            {Object.keys(places)
              .sort()
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      )}
      <SpatialMap
        label="Hazard evidence positions, historical observed track and mission corridor"
        lines={lines}
        points={points}
        controls={controls}
        draft={draft}
        editable={editable}
        onChange={onChange}
        view={view}
        onView={onView}
        testId="avoidance-editor-map"
      />
      <div className="spatial-legend">
        <span>Origin mission corridor</span>
        <span className="is-observed">Observed track</span>
        <span className="is-control">Existing controls</span>
        {draft && <span className="is-proposed">Your proposal</span>}
      </div>
      <p className="safety-form-note">
        {!flightId
          ? 'This hazard has no origin flight, so no occurrence or mission corridor is shown. '
          : shown?.mission
            ? 'The origin mission and its applicable accepted areas are shown. '
            : 'No origin mission corridor is recorded. Manual map references are separate from occurrence evidence. '}
        The affected mission review checks every control applicable to that mission.
      </p>
      {editable && (
        <div className="control-map-radius">
          <label htmlFor={`radius-${flightId ?? 'area'}`}>Proposed radius (m)</label>
          <input
            id={`radius-${flightId ?? 'area'}`}
            type="number"
            min={1}
            max={10000}
            step={1}
            value={draft?.radiusMeters ?? ''}
            onChange={(event) =>
              onChange({
                center: draft?.center ?? null,
                radiusMeters: event.target.value === '' ? null : Number(event.target.value),
              })
            }
          />
          <Button
            type="button"
            kind="quiet"
            onClick={() => onChange({ center: draft?.center ?? null, radiusMeters: 100 })}
          >
            Start with 100 m
          </Button>
        </div>
      )}
      {!draft?.center && editable && (
        <p role="status">No proposed center yet. Use an evidence location, or choose Place center and tap the map.</p>
      )}
      {selectedEvidence && !selectedInRead && (
        <article className="occurrence-location is-selected" aria-label="Retained selected evidence location">
          <strong>Selected evidence location retained</strong>
          <p>
            This exact location is outside the current evidence read. Your selection and proposed circle have not
            changed.
          </p>
          <small>
            {sourceLabel(selectedEvidence.candidate.sourceId)} · {time(selectedEvidence.eventTime, true)}{' '}
            {timeZoneLabel()} · evaluation {time(selectedEvidence.evaluation.clock.evaluatedAt, true)} {timeZoneLabel()}
          </small>
          <p>{methodLabels[selectedEvidence.candidate.method]}</p>
          <small>
            {offsetLabel(selectedEvidence.candidate)}. {selectedEvidence.candidate.uncertainty}
          </small>
          {editable && (
            <Button
              type="button"
              kind="next"
              onClick={() =>
                onChange({ center: selectedEvidence.candidate.position, radiusMeters: draft?.radiusMeters ?? null })
              }
            >
              Use retained evidence location
            </Button>
          )}
          <details>
            <summary>Retained selected location details</summary>
            <pre>{JSON.stringify(selectedEvidence, null, 2)}</pre>
          </details>
        </article>
      )}
      {data && (
        <div className="occurrence-locations">
          {data.occurrences.map((occurrence, index) => (
            <article
              key={occurrence.id}
              className={`occurrence-location ${currentSelections.some(({ selection }) => selection.occurrenceId === occurrence.id && selection.id === selectedEvidence?.id) ? 'is-selected' : ''}`}
            >
              <strong>
                {occurrenceLabel(evaluation!, occurrence.report.eventId, index)} ·{' '}
                {sourceLabel(occurrence.report.sourceId)} · {time(occurrence.eventTime, true)} {timeZoneLabel()}
              </strong>
              <small>
                {occurrence.eventTimeBasis === 'reported_landing'
                  ? 'Reported landing time'
                  : 'Reported occurrence time'}{' '}
                · {occurrence.reason}
              </small>
              {occurrence.candidates.map((candidate) => {
                const selection = selectOccurrenceLocation(evaluation!, occurrence, candidate);
                const id = selection.id;
                return (
                  <div key={id}>
                    <p>{methodLabels[candidate.method]}</p>
                    <small>
                      {sourceLabel(candidate.sourceId)} · {offsetLabel(candidate)}. {candidate.uncertainty}
                    </small>
                    <Button
                      type="button"
                      kind="quiet"
                      onClick={() => onSelectEvidence(selection)}
                      aria-pressed={selectedEvidence?.id === id}
                    >
                      Inspect this location
                    </Button>
                    {editable && (
                      <Button
                        type="button"
                        kind="next"
                        onClick={() => {
                          onSelectEvidence(selection);
                          onChange({ center: candidate.position, radiusMeters: draft?.radiusMeters ?? null });
                        }}
                      >
                        Use this evidence location
                      </Button>
                    )}
                  </div>
                );
              })}
              {occurrence.status === 'missing' && (
                <p>Location remains unknown. You can place a precaution manually on the map.</p>
              )}
              <details>
                <summary>Evidence location details</summary>
                <pre>{JSON.stringify(occurrence, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      )}
      {data?.truncated && (
        <p className="safety-form-note">
          The bounded historical read is incomplete. Missing track context remains unknown.
        </p>
      )}
    </section>
  );
}
