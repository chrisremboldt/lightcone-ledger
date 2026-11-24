import { useState } from 'react';
import { HazardControlMap } from './HazardControlMap.js';
import type { GeographicView } from './geography.js';
import { controlEditors, type ControlEditor, type ControlEditorContext } from './SmsControls.js';
import type { SelectedOccurrenceLocation } from './occurrence-location.js';
import type { SpatialDraft } from './SpatialMap.js';

interface AreaParameters {
  center?: { latitude: number; longitude: number };
  radiusMeters?: number;
  site?: string;
  appliesWithinMeters?: number;
}

/** Six decimal places, about a tenth of a metre: what a person placed, without floating-point noise. */
const sixPlaces = (value: number) => Math.round(value * 1e6) / 1e6;

function decimal(text: string): number | undefined {
  return text.trim() && Number.isFinite(Number(text)) ? Number(text) : undefined;
}

/**
 * The avoidance-area control type's editor: the hazard map, with the centre, radius, site and reach as fields too. For a
 * hazard from a flight finding the map also shows that finding's occurrence positions, and one can be used as centre.
 */
export const AvoidanceAreaEditor: ControlEditor = ({ value, onChange, context }) => (
  <AreaFields value={value as AreaParameters} onChange={onChange} context={context} />
);

function AreaFields({
  value,
  onChange,
  context,
}: {
  value: AreaParameters;
  onChange: (value: Record<string, unknown>) => void;
  context?: ControlEditorContext;
}) {
  const [view, setView] = useState<GeographicView | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<SelectedOccurrenceLocation | null>(null);
  const [latitude, setLatitude] = useState(value.center ? String(value.center.latitude) : '');
  const [longitude, setLongitude] = useState(value.center ? String(value.center.longitude) : '');
  const [reach, setReach] = useState(value.appliesWithinMeters === undefined ? '' : String(value.appliesWithinMeters));
  const update = (next: {
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
    site?: string;
    appliesWithinMeters?: number;
  }) => {
    const parameters: Record<string, unknown> = {};
    if (next.latitude !== undefined && next.longitude !== undefined)
      parameters.center = { latitude: sixPlaces(next.latitude), longitude: sixPlaces(next.longitude) };
    if (next.radiusMeters !== undefined) parameters.radiusMeters = next.radiusMeters;
    if (next.site) parameters.site = next.site;
    if (next.appliesWithinMeters !== undefined) parameters.appliesWithinMeters = next.appliesWithinMeters;
    onChange(parameters);
  };
  const current = {
    latitude: decimal(latitude),
    longitude: decimal(longitude),
    radiusMeters: value.radiusMeters,
    site: value.site,
    appliesWithinMeters: value.appliesWithinMeters,
  };
  const draft: SpatialDraft = {
    center:
      current.latitude !== undefined && current.longitude !== undefined
        ? { latitude: current.latitude, longitude: current.longitude }
        : null,
    radiusMeters: value.radiusMeters ?? null,
  };
  return (
    <>
      <HazardControlMap
        active
        {...(context?.flightId && context.evaluation
          ? { client: context.client, flightId: context.flightId, evaluation: context.evaluation }
          : {})}
        draft={draft}
        editable
        onChange={(next) => {
          if (next.center) {
            setLatitude(String(sixPlaces(next.center.latitude)));
            setLongitude(String(sixPlaces(next.center.longitude)));
          }
          update({
            ...current,
            ...(next.center ? next.center : {}),
            radiusMeters: next.radiusMeters ?? undefined,
          });
        }}
        selectedEvidence={selectedEvidence}
        onSelectEvidence={setSelectedEvidence}
        view={view}
        onView={setView}
      />
      <div className="safety-form-grid">
        <label>
          Centre latitude
          <input
            inputMode="decimal"
            value={latitude}
            onChange={(event) => {
              setLatitude(event.target.value);
              update({ ...current, latitude: decimal(event.target.value) });
            }}
          />
        </label>
        <label>
          Centre longitude
          <input
            inputMode="decimal"
            value={longitude}
            onChange={(event) => {
              setLongitude(event.target.value);
              update({ ...current, longitude: decimal(event.target.value) });
            }}
          />
        </label>
        <label>
          Site (optional)
          <input
            value={value.site ?? ''}
            maxLength={200}
            onChange={(event) => update({ ...current, site: event.target.value })}
          />
        </label>
        <label>
          Applies to flights whose planned route comes within (metres)
          <input
            type="number"
            min={0}
            max={50000}
            step="any"
            value={reach}
            onChange={(event) => {
              setReach(event.target.value);
              update({ ...current, appliesWithinMeters: decimal(event.target.value) });
            }}
          />
          <small className="records-help">
            Measured from the edge of the area. Leave empty to apply to every flight in the control&apos;s interval.
          </small>
        </label>
      </div>
    </>
  );
}

controlEditors['control.avoidance-area@1'] = AvoidanceAreaEditor;
