import { useState } from 'react';
import type { FlightSummary } from '@ledger/contracts';
import { age } from './format.js';
import { fitCoordinates, projectCoordinate, type Coordinate, type MapFrame } from './geography.js';
import { activityPresentation, aircraftLabel, currentPictureMs } from './labels.js';
import { locate, yards } from './places.js';

const frame: MapFrame = { width: 760, height: 228, left: 12, right: 12, top: 18, bottom: 12 };

interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(left: LabelBox, right: LabelBox) {
  return (
    left.x < right.x + right.width + 6 &&
    left.x + left.width + 6 > right.x &&
    left.y < right.y + right.height + 6 &&
    left.y + left.height + 6 > right.y
  );
}

function compact(value: string) {
  return value.length > 48 ? `${value.slice(0, 28)}…${value.slice(-15)}` : value;
}

function contextBox(point: { x: number; y: number }, lines: string[], occupied: LabelBox[]): LabelBox {
  const width = Math.max(116, ...lines.map((line) => line.length * 6 + 16));
  const height = lines.length * 14 + 10;
  const sides = point.x < frame.width / 2 ? [point.x + 12, point.x - width - 12] : [point.x - width - 12, point.x + 12];
  const candidates = sides.flatMap((x) =>
    [point.y - 20, point.y + 16, point.y - height - 16, 6, frame.height - height - 6].map((y) => ({
      x: Math.max(6, Math.min(frame.width - width - 6, x)),
      y: Math.max(6, Math.min(frame.height - height - 6, y)),
      width,
      height,
    })),
  );
  return candidates.find((box) => occupied.every((other) => !overlaps(box, other))) ?? candidates[0]!;
}

export function FleetMap({
  flights,
  selectedId,
  tenantId,
  scopeLabel,
  onSelect,
}: {
  flights: FlightSummary[];
  selectedId: string | null;
  tenantId?: string;
  scopeLabel: string;
  onSelect: (id: string) => void;
}) {
  const [showAllPositions, setShowAllPositions] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // The map places flights around a simulated yard; an organization of its own has none, so it shows no map.
  const yard = yards[tenantId ?? ''];
  if (!yard) return null;
  const marks = flights.map((flight) => {
    const place = locate(flight.label, yard);
    const coordinate = place.coordinate;
    const reported = flight.picture?.lastPosition;
    const observedAge = reported ? Date.now() - Date.parse(reported.occurredAt) : Infinity;
    const fresh = observedAge >= 0 && observedAge <= currentPictureMs;
    return { flight, place, coordinate, reported, fresh, status: activityPresentation(flight) };
  });
  const routes: Coordinate[] = [yard, ...marks.map((mark) => mark.coordinate)];
  const localView = fitCoordinates(routes, frame)!;
  const distant = marks.filter((mark) => mark.reported && !projectCoordinate(mark.reported, localView, frame).inside);
  const points = showAllPositions
    ? [...routes, ...marks.flatMap((mark) => (mark.reported ? [mark.reported] : []))]
    : routes;
  const view = fitCoordinates(points, frame);
  const yardPoint = view ? projectCoordinate(yard, view, frame) : null;
  const occupied: LabelBox[] = yardPoint
    ? [{ x: yardPoint.x + 8, y: yardPoint.y - 8, width: yard.name.length * 6, height: 16 }]
    : [];
  const engaged = marks.filter(
    (mark) => mark.flight.id === selectedId || mark.flight.id === hoveredId || mark.flight.id === focusedId,
  );
  const contexts = view
    ? [
        ...engaged.filter((mark) => mark.flight.id === selectedId),
        ...engaged.filter((mark) => mark.flight.id !== selectedId),
      ].map((mark) => {
        const point = projectCoordinate(mark.coordinate, view, frame);
        const reported = mark.reported ? projectCoordinate(mark.reported, view, frame) : null;
        const lines = [
          compact(mark.place.name),
          compact(`${aircraftLabel(mark.flight.aircraft)}${mark.reported ? '' : ' · no position'}`),
          mark.status.label,
        ];
        if (reported?.inside && mark.reported)
          lines.push(`${mark.fresh ? 'Observed' : 'Last known'} ${age(mark.reported.occurredAt)}`);
        const box = contextBox(point, lines, occupied);
        occupied.push(box);
        return { mark, point, reported, lines, box };
      })
    : [];
  const sites = new Map(marks.filter((mark) => mark.place.named).map((mark) => [mark.place.name, mark.coordinate]));
  const siteLabels = view
    ? [...sites]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, coordinate]) => {
          if (engaged.some((mark) => mark.place.name === name)) return [];
          const point = projectCoordinate(coordinate, view, frame);
          const width = name.length * 6;
          const box = { x: Math.min(point.x + 8, frame.width - width - 6), y: point.y - 16, width, height: 14 };
          if (occupied.some((other) => overlaps(box, other))) return [];
          occupied.push(box);
          return [{ name, box }];
        })
    : [];
  return (
    <section className="fleet" aria-label="Fleet map" data-testid="fleet-map">
      <div className="fleet-heading">
        <h2>{scopeLabel} · this page</h2>
        <p>
          Schematic lines show original requests. Revised mission routes are in the flight record. Dots show reported
          positions; each position keeps its own observation time.
        </p>
      </div>
      {view ? (
        <svg
          className="fleet-map"
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          role="group"
          aria-label="Original request schematic and reported positions"
        >
          {[
            ...marks.filter((mark) => mark.flight.id !== selectedId),
            ...marks.filter((mark) => mark.flight.id === selectedId),
          ].map((mark) => {
            const from = projectCoordinate(yard, view, frame);
            const to = projectCoordinate(mark.coordinate, view, frame);
            const selected = mark.flight.id === selectedId;
            return (
              <line
                key={`${mark.flight.id}-route`}
                className={`fleet-route ${selected ? 'is-selected' : ''}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              >
                <title>{mark.flight.label} · original request connection, schematic</title>
              </line>
            );
          })}
          <g className="fleet-yard">
            {(() => {
              const point = projectCoordinate(yard, view, frame);
              return (
                <>
                  <rect x={point.x - 5} y={point.y - 5} width={10} height={10} />
                  <text x={point.x + 8} y={point.y + 4}>
                    {yard.name}
                  </text>
                </>
              );
            })()}
          </g>
          {marks.map((mark) => {
            const point = projectCoordinate(mark.coordinate, view, frame);
            const reported = mark.reported ? projectCoordinate(mark.reported, view, frame) : null;
            const selected = mark.flight.id === selectedId;
            return (
              <g
                key={mark.flight.id}
                className={`fleet-flight ${selected ? 'is-selected' : ''} ${mark.reported ? '' : 'is-unreported'}`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${mark.flight.label}. ${mark.status.label}. ${mark.status.detail ?? ''} Original request to ${mark.place.name}. ${
                  mark.reported
                    ? `Last position observed ${age(mark.reported.occurredAt)}, received ${age(mark.reported.receivedAt)}${mark.fresh ? '' : ', not current'}`
                    : 'No position reported'
                }`}
                onMouseEnter={() => setHoveredId(mark.flight.id)}
                onMouseLeave={() => setHoveredId((previous) => (previous === mark.flight.id ? null : previous))}
                onFocus={() => setFocusedId(mark.flight.id)}
                onBlur={() => setFocusedId((previous) => (previous === mark.flight.id ? null : previous))}
                onClick={() => onSelect(mark.flight.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(mark.flight.id);
                  }
                }}
              >
                <circle className="fleet-place" cx={point.x} cy={point.y} r={selected ? 5 : 3.5} />
                {reported?.inside && mark.reported && (
                  <circle
                    className={`fleet-position ${mark.fresh ? 'is-fresh' : 'is-stale'}`}
                    cx={reported.x}
                    cy={reported.y}
                    r={5}
                  />
                )}
              </g>
            );
          })}
          <g className="fleet-labels" aria-hidden="true">
            {siteLabels.map(({ name, box }) => (
              <text key={name} className="fleet-site-label" x={box.x} y={box.y + 11}>
                {name}
              </text>
            ))}
            {[
              ...contexts.filter(({ mark }) => mark.flight.id !== selectedId),
              ...contexts.filter(({ mark }) => mark.flight.id === selectedId),
            ].map(({ mark, point, reported, lines, box }) => (
              <g
                key={mark.flight.id}
                data-flight-id={mark.flight.id}
                className={`fleet-context ${mark.flight.id === selectedId ? 'is-selected' : ''} ${mark.flight.id === focusedId ? 'is-focused' : ''} ${mark.reported ? '' : 'is-unreported'}`}
              >
                <circle className="fleet-context-ring" cx={point.x} cy={point.y} r={8} />
                {reported?.inside && <circle className="fleet-context-ring" cx={reported.x} cy={reported.y} r={9} />}
                <line
                  className="fleet-context-connector"
                  x1={point.x}
                  y1={point.y}
                  x2={Math.max(box.x, Math.min(box.x + box.width, point.x))}
                  y2={Math.max(box.y, Math.min(box.y + box.height, point.y))}
                />
                <rect className="fleet-context-card" x={box.x} y={box.y} width={box.width} height={box.height} rx={3} />
                <foreignObject x={box.x + 8} y={box.y + 4} width={box.width - 16} height={box.height - 8}>
                  <div className="fleet-context-copy">
                    {lines.map((line, index) => (
                      <div
                        key={index}
                        className={
                          index === 0
                            ? 'fleet-context-title'
                            : index === 1
                              ? 'fleet-aircraft'
                              : index === 2
                                ? 'fleet-activity'
                                : `fleet-age ${mark.fresh ? '' : 'is-stale'}`
                        }
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                </foreignObject>
              </g>
            ))}
          </g>
        </svg>
      ) : (
        <p className="fleet-empty">Places appear when flights do.</p>
      )}
      {contexts.length > 0 && (
        <div className="fleet-context-strip">
          {contexts.map(({ mark, reported }) => (
            <div
              key={mark.flight.id}
              data-flight-id={mark.flight.id}
              className={`fleet-context-summary ${mark.flight.id === selectedId ? 'is-selected' : ''} ${mark.flight.id === focusedId ? 'is-focused' : ''}`}
            >
              <p className="fleet-context-name">
                <span className="fleet-context-kind">
                  {mark.flight.id === selectedId
                    ? 'Selected'
                    : mark.flight.id === focusedId
                      ? 'Keyboard focus'
                      : 'Hovered'}{' '}
                  ·{' '}
                </span>
                {mark.flight.label}
              </p>
              <p className="fleet-context-aircraft">{aircraftLabel(mark.flight.aircraft)}</p>
              <p className="fleet-context-status" title={mark.status.detail ?? undefined}>
                {mark.status.label}
              </p>
              <p className={`fleet-context-status ${mark.fresh ? '' : 'is-stale'}`}>
                {mark.reported
                  ? `${mark.fresh ? 'Observed' : 'Last known'} ${age(mark.reported.occurredAt)}${reported?.inside ? '' : ' · outside shown area'}`
                  : 'No position reported'}
              </p>
            </div>
          ))}
        </div>
      )}
      {distant.length > 0 && (
        <p className="fleet-outliers">
          {distant.length} reported position{distant.length === 1 ? '' : 's'} outside the request area · retained
          <button onClick={() => setShowAllPositions((previous) => !previous)}>
            {showAllPositions ? 'Show request area' : 'Show all positions'}
          </button>
        </p>
      )}
    </section>
  );
}
