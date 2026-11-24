import { useContext } from 'react';
import { Button } from '@ledger/ui';
import { SafetyRecordLink, type AreaControl } from './area-controls.js';
import { missionTime } from './missionRelease.js';

/**
 * An accepted area control from the safety record: what it asks, its area, its hazard and where it came from. A
 * declared reach is part of the wording its type gives it. With the applicability record route review made for a
 * flight, the summary also shows that record's sentence as recorded: why the control applies, including that it
 * declares no reach.
 */
export function AreaControlSummary({
  control,
  version,
  applicability,
}: {
  control: AreaControl;
  version: number;
  applicability?: { summary: string };
}) {
  const openRecord = useContext(SafetyRecordLink);
  const { area, effective, hazard } = control;
  return (
    <div className="mission-control-summary" data-testid="area-control-summary">
      <strong>
        {control.title} · control version {version}
      </strong>
      <span>{control.wording}</span>
      {applicability && <span data-testid="area-control-applicability">{applicability.summary}</span>}
      <span>
        {area.radiusMeters} m radius around {area.center.latitude.toFixed(5)}, {area.center.longitude.toFixed(5)}
        {area.site ? ` · ${area.site}` : ''} · all altitudes · owner {control.owner.name}
      </span>
      <span>
        Effective {missionTime(effective.from)} – {effective.until ? missionTime(effective.until) : 'until withdrawn'}
      </span>
      <span>
        {control.sourceLabel} · hazard{' '}
        {openRecord ? (
          <Button type="button" kind="quiet" onClick={() => openRecord(hazard.id)}>
            {hazard.title ?? hazard.id}
          </Button>
        ) : (
          (hazard.title ?? hazard.id)
        )}
      </span>
    </div>
  );
}
