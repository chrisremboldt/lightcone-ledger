import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  circleCoordinates,
  circlesInView,
  coordinateLabel,
  displayDistance,
  fitCoordinates,
  fitViewAspect,
  offsetCoordinate,
  projectCoordinate,
  unprojectCoordinate,
  zoomGeographicView,
  type Coordinate,
  type GeographicView,
  type MapFrame,
} from './geography.js';

export interface SpatialLine {
  id: string;
  label: string;
  points: Coordinate[];
  kind: 'mission' | 'proposed' | 'observed';
  corridorMeters?: number;
  className?: string;
  sampleIds?: [string, string];
}
export interface SpatialPoint {
  id: string;
  label: string;
  position: Coordinate;
  kind: 'event' | 'required' | 'sample';
  selected?: boolean;
  late?: boolean;
  onSelect?: () => void;
}
export interface SpatialCircle {
  id: string;
  label: string;
  center: Coordinate;
  radiusMeters: number;
  state?: 'accepted' | 'proposed';
}
/** An area shown for context only, as a thin dashed outline. It is drawn only inside the view and never moves it. */
export interface SpatialOutline {
  id: string;
  label: string;
  /** One sentence about the area, as recorded, shown with it. */
  note: string;
  center: Coordinate;
  radiusMeters: number;
}
/** At most this many context outlines are drawn at once. */
export const SPATIAL_OUTLINE_LIMIT = 50;
export interface SpatialDraft {
  center: Coordinate | null;
  radiusMeters: number | null;
}
interface Props {
  label: string;
  lines?: SpatialLine[];
  points?: SpatialPoint[];
  controls?: SpatialCircle[];
  outlines?: SpatialOutline[];
  draft?: SpatialDraft;
  editable?: boolean;
  onChange?: (draft: SpatialDraft) => void;
  view?: GeographicView | null;
  onView?: (view: GeographicView) => void;
  testId?: string;
  canvasTestId?: string;
  coordinateGrid?: boolean;
  frame?: MapFrame;
  className?: string;
}
const path = (points: { x: number; y: number }[], closed = false) =>
  points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ') + (closed ? ' Z' : '');

export function SpatialMap({
  label,
  lines = [],
  points = [],
  controls = [],
  outlines = [],
  draft,
  editable = false,
  onChange,
  view: retainedView,
  onView,
  testId = 'spatial-map',
  canvasTestId,
  coordinateGrid = false,
  frame: fixedFrame,
  className = '',
}: Props) {
  const id = `spatial-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(720);
  const frame: MapFrame = fixedFrame ?? {
    width,
    height: width < 500 ? 350 : 400,
    left: 16,
    right: 16,
    top: 16,
    bottom: 30,
  };
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => {
      if (element.clientWidth > 0) setWidth(Math.max(280, Math.round(element.clientWidth)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const svg = useRef<SVGSVGElement>(null);
  const [localView, setLocalView] = useState<GeographicView | null>(null);
  const [placing, setPlacing] = useState(false);
  const gesture = useRef<{
    id: number;
    kind: 'pan' | 'center' | 'radius';
    start: { x: number; y: number };
    view: GeographicView;
    draft?: SpatialDraft;
    moved: boolean;
  } | null>(null);
  const focusContext = [
    ...lines.flatMap((line) =>
      line.corridorMeters
        ? line.points.flatMap((point) => circleCoordinates(point, line.corridorMeters!))
        : line.points,
    ),
    ...points.map((point) => point.position),
    ...(draft?.center ? circleCoordinates(draft.center, draft.radiusMeters ?? 0) : []),
  ];
  const areaContext = controls.flatMap((control) => circleCoordinates(control.center, control.radiusMeters));
  const fit = fitCoordinates(focusContext.length ? focusContext : areaContext, frame);
  const allAreas = fitCoordinates([...focusContext, ...areaContext], frame);
  const retained = retainedView ?? localView ?? fit;
  const view = retained ? fitViewAspect(retained, frame) : null;
  const outsideAreas = view
    ? controls.filter((control) => !projectCoordinate(control.center, view, frame).inside).length
    : 0;
  const outlined = view ? circlesInView(outlines, view, SPATIAL_OUTLINE_LIMIT, frame) : { shown: [], more: 0 };
  const changeView = (next: GeographicView) => {
    setLocalView(next);
    onView?.(next);
  };
  function pointAt(event: { clientX: number; clientY: number }) {
    const matrix = svg.current!.getScreenCTM();
    if (!matrix) return { x: frame.width / 2, y: frame.height / 2 };
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  }
  function begin(event: PointerEvent<SVGElement>, kind: 'pan' | 'center' | 'radius') {
    if (!view || (kind !== 'pan' && !editable)) return;
    event.preventDefault();
    event.stopPropagation();
    changeView(view);
    svg.current?.setPointerCapture(event.pointerId);
    const start = pointAt(event);
    if (kind !== 'pan' && draft?.center && draft.radiusMeters) {
      const center = projectCoordinate(draft.center, view, frame);
      const radius = projectCoordinate(offsetCoordinate(draft.center, draft.radiusMeters, 0), view, frame);
      kind =
        Math.hypot(start.x - center.x, start.y - center.y) <= Math.hypot(start.x - radius.x, start.y - radius.y)
          ? 'center'
          : 'radius';
    }
    gesture.current = { id: event.pointerId, kind, start, view, draft, moved: false };
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.id) return;
    const point = pointAt(event);
    active.moved ||= Math.hypot(point.x - active.start.x, point.y - active.start.y) > 3;
    if (active.kind === 'pan') {
      const longitude =
        -((point.x - active.start.x) / (frame.width - frame.left - frame.right)) *
        (active.view.east - active.view.west);
      const latitude =
        ((point.y - active.start.y) / (frame.height - frame.top - frame.bottom)) *
        (active.view.north - active.view.south);
      const next = {
        ...active.view,
        west: active.view.west + longitude,
        east: active.view.east + longitude,
        south: active.view.south + latitude,
        north: active.view.north + latitude,
      };
      if (next.south >= -85 && next.north <= 85) changeView(next);
    } else if (editable && onChange && active.draft) {
      const position = unprojectCoordinate(point, active.view, frame);
      if (active.kind === 'center') onChange({ ...active.draft, center: position });
      else if (active.draft.center)
        onChange({
          ...active.draft,
          radiusMeters: Math.max(1, Math.min(10000, Math.round(displayDistance(active.draft.center, position)))),
        });
    }
  }
  function end(event: PointerEvent<SVGSVGElement>) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.id) return;
    if (editable && placing && !active.moved && active.kind === 'pan' && onChange) {
      onChange({
        center: unprojectCoordinate(pointAt(event), active.view, frame),
        radiusMeters: draft?.radiusMeters ?? null,
      });
      setPlacing(false);
    }
    gesture.current = null;
    if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  }
  function nudge(event: KeyboardEvent<SVGElement>, kind: 'center' | 'radius') {
    if (!editable || !draft?.center || !onChange) return;
    const step = event.shiftKey ? 100 : 10;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    if (kind === 'center') onChange({ ...draft, center: offsetCoordinate(draft.center, ...direction) });
    else
      onChange({
        ...draft,
        radiusMeters: Math.max(1, Math.min(10000, (draft.radiusMeters ?? 1) + (direction[0] || direction[1]))),
      });
  }
  const center = view && draft?.center ? projectCoordinate(draft.center, view, frame) : null;
  const handle =
    view && draft?.center && draft.radiusMeters
      ? projectCoordinate(offsetCoordinate(draft.center, draft.radiusMeters, 0), view, frame)
      : null;
  const middle = view ? { longitude: (view.west + view.east) / 2, latitude: (view.north + view.south) / 2 } : null;
  const oneMeter =
    view && middle
      ? Math.abs(
          projectCoordinate(offsetCoordinate(middle, 1, 0), view, frame).x - projectCoordinate(middle, view, frame).x,
        )
      : 0;
  const scaleMeters = oneMeter ? 10 ** Math.floor(Math.log10(100 / oneMeter)) : 0;
  const scaleX = coordinateGrid ? frame.left + 10 : 24;
  const scaleY = coordinateGrid ? frame.height - frame.bottom - 10 : frame.height - 20;
  const controlList =
    controls.length > 0 ? (
      <ul className="spatial-area-list" aria-label="Avoidance areas on this map">
        {controls.map((control, index) => (
          <li key={control.id}>
            <b>{index + 1}</b> {control.label} · {control.radiusMeters.toLocaleString()} m ·{' '}
            {control.state === 'proposed' ? 'Proposed' : 'Accepted'}
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <figure className={`spatial-map ${className}`} ref={container} data-testid={testId}>
      <div className="spatial-toolbar" aria-label="Map controls">
        {editable && (
          <button
            type="button"
            className={placing ? 'is-active' : ''}
            aria-pressed={placing}
            onClick={() => setPlacing((previous) => !previous)}
          >
            Place center
          </button>
        )}
        <button
          type="button"
          disabled={!view}
          onClick={() => view && changeView(zoomGeographicView(view, 0.65))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          disabled={!view}
          onClick={() => view && changeView(zoomGeographicView(view, 1 / 0.65))}
          aria-label="Zoom out"
        >
          −
        </button>
        <button type="button" disabled={!fit} onClick={() => fit && changeView(fit)}>
          Fit / reset
        </button>
        {controls.length > 0 && focusContext.length > 0 && (
          <button type="button" disabled={!allAreas} onClick={() => allAreas && changeView(allAreas)}>
            Show all areas
          </button>
        )}
        {editable && draft?.center && (
          <button
            type="button"
            onClick={() => draft.center && onChange?.({ ...draft, center: offsetCoordinate(draft.center, 10, 0) })}
          >
            Move east 10 m
          </button>
        )}
        <span>N ↑ · metres</span>
      </div>
      {placing && (
        <p className="spatial-instruction" role="status">
          Click or tap the map to place the proposed center. Drag the center or radius handle to adjust it.
        </p>
      )}
      {view ? (
        <svg
          ref={svg}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          data-testid={canvasTestId}
          role="group"
          tabIndex={0}
          aria-label={label}
          className={placing ? 'is-placing' : ''}
          onPointerDown={(event) => begin(event, 'pan')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={() => {
            gesture.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setPlacing(false);
              return;
            }
            if (event.key === 'Enter' && placing && editable && middle) {
              event.preventDefault();
              onChange?.({ center: middle, radiusMeters: draft?.radiusMeters ?? null });
              setPlacing(false);
              return;
            }
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              changeView(zoomGeographicView(view, 0.65));
              return;
            }
            if (event.key === '-') {
              event.preventDefault();
              changeView(zoomGeographicView(view, 1 / 0.65));
              return;
            }
            const movement: Record<string, [number, number]> = {
              ArrowLeft: [-0.15, 0],
              ArrowRight: [0.15, 0],
              ArrowUp: [0, 0.15],
              ArrowDown: [0, -0.15],
            };
            const delta = movement[event.key];
            if (!delta) return;
            event.preventDefault();
            const dx = (view.east - view.west) * delta[0],
              dy = (view.north - view.south) * delta[1];
            if (view.south + dy >= -85 && view.north + dy <= 85)
              changeView({
                ...view,
                west: view.west + dx,
                east: view.east + dx,
                south: view.south + dy,
                north: view.north + dy,
              });
          }}
        >
          <defs>
            <clipPath id={id}>
              <rect
                x={frame.left}
                y={frame.top}
                width={frame.width - frame.left - frame.right}
                height={frame.height - frame.top - frame.bottom}
              />
            </clipPath>
          </defs>
          {coordinateGrid ? (
            <g className="telemetry-graticule" aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => {
                const longitude = view.west + ((view.east - view.west) * index) / 4;
                const { x } = projectCoordinate({ latitude: view.south, longitude }, view, frame);
                return (
                  <g key={`x${index}`}>
                    <line x1={x} x2={x} y1={frame.top} y2={frame.height - frame.bottom} />
                    <text x={x} y={frame.height - 17} textAnchor="middle">
                      {coordinateLabel(longitude, 'longitude', 3)}
                    </text>
                  </g>
                );
              })}
              {Array.from({ length: 5 }, (_, index) => {
                const latitude = view.south + ((view.north - view.south) * index) / 4;
                const { y } = projectCoordinate({ latitude, longitude: view.west }, view, frame);
                return (
                  <g key={`y${index}`}>
                    <line x1={frame.left} x2={frame.width - frame.right} y1={y} y2={y} />
                    <text x={frame.left - 8} y={y + 3} textAnchor="end">
                      {coordinateLabel(latitude, 'latitude', 3)}
                    </text>
                  </g>
                );
              })}
            </g>
          ) : (
            <g className="spatial-grid" aria-hidden="true">
              {Array.from({ length: 7 }, (_, index) => (
                <g key={index}>
                  <line
                    x1={frame.left + (index * (frame.width - frame.left - frame.right)) / 6}
                    x2={frame.left + (index * (frame.width - frame.left - frame.right)) / 6}
                    y1={frame.top}
                    y2={frame.height - frame.bottom}
                  />
                  <line
                    x1={frame.left}
                    x2={frame.width - frame.right}
                    y1={frame.top + (index * (frame.height - frame.top - frame.bottom)) / 6}
                    y2={frame.top + (index * (frame.height - frame.top - frame.bottom)) / 6}
                  />
                </g>
              ))}
            </g>
          )}
          <g clipPath={`url(#${id})`}>
            {controls.map((control, index) => (
              <g key={control.id}>
                <path
                  key={control.id}
                  className={`spatial-area spatial-area--${control.state ?? 'accepted'}`}
                  d={path(
                    circleCoordinates(control.center, control.radiusMeters).map((point) =>
                      projectCoordinate(point, view, frame),
                    ),
                    true,
                  )}
                >
                  <title>
                    {control.label} · {control.radiusMeters} m
                  </title>
                </path>
                <text
                  className="spatial-control-number"
                  x={projectCoordinate(control.center, view, frame).x}
                  y={projectCoordinate(control.center, view, frame).y}
                  textAnchor="middle"
                >
                  {index + 1}
                </text>
              </g>
            ))}
            {outlined.shown.map((outline) => {
              const original = outlines.find((entry) => entry.id === outline.id)!;
              const edge = (radius: number) =>
                path(
                  circleCoordinates(original.center, radius).map((point) => projectCoordinate(point, view, frame)),
                  true,
                );
              const top = projectCoordinate(offsetCoordinate(original.center, 0, original.radiusMeters), view, frame);
              return (
                <g key={outline.id} className="spatial-outline" data-outline-id={outline.id}>
                  <title>
                    {original.label} · {original.note}
                  </title>
                  <path className="spatial-outline-area" d={edge(original.radiusMeters)} />
                  <text x={top.x} y={top.y - 6} textAnchor="middle">
                    Does not apply
                  </text>
                </g>
              );
            })}
            {lines.map((line) => (
              <g key={line.id} className={`spatial-line spatial-line--${line.kind}`}>
                <title>{line.label}</title>
                {Boolean(line.corridorMeters) && (
                  <path
                    className="spatial-corridor"
                    style={{ strokeWidth: Math.max(1, 2 * line.corridorMeters! * oneMeter) }}
                    d={path(line.points.map((point) => projectCoordinate(point, view, frame)))}
                  />
                )}
                <path
                  className={line.className}
                  data-from-sample-id={line.sampleIds?.[0]}
                  data-to-sample-id={line.sampleIds?.[1]}
                  d={path(line.points.map((point) => projectCoordinate(point, view, frame)))}
                />
              </g>
            ))}
            {points.map((point) => {
              const projected = projectCoordinate(point.position, view, frame);
              return (
                <g
                  key={point.id}
                  className={`spatial-point spatial-point--${point.kind} ${point.selected ? 'is-selected' : ''}`}
                  role={point.onSelect ? 'button' : undefined}
                  tabIndex={point.onSelect ? 0 : undefined}
                  aria-label={point.label}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={point.onSelect}
                  onKeyDown={(event) => {
                    if (point.onSelect && ['Enter', ' '].includes(event.key)) {
                      event.preventDefault();
                      point.onSelect();
                    }
                  }}
                >
                  <title>{point.label}</title>
                  {point.late && <circle className="telemetry-late-ring" cx={projected.x} cy={projected.y} r={6} />}
                  <circle
                    className={
                      point.kind === 'sample' ? `telemetry-point ${point.selected ? 'is-selected' : ''}` : undefined
                    }
                    cx={projected.x}
                    cy={projected.y}
                    r={point.kind === 'sample' ? (point.selected ? 4 : 2.5) : 6}
                  />
                  {point.kind !== 'sample' && (
                    <text
                      x={projected.x > 155 ? projected.x - 12 : projected.x + 12}
                      y={projected.y - 24}
                      textAnchor={projected.x > 155 ? 'end' : 'start'}
                    >
                      {point.label.length > 36 ? `${point.label.slice(0, 35)}…` : point.label}
                    </text>
                  )}
                </g>
              );
            })}
            {draft?.center && (
              <path
                className="spatial-area spatial-area--draft"
                d={path(
                  circleCoordinates(draft.center, draft.radiusMeters ?? 0).map((point) =>
                    projectCoordinate(point, view, frame),
                  ),
                  true,
                )}
              />
            )}
            {center && (
              <g
                className={`spatial-draft-center ${editable ? 'is-editable' : ''}`}
                role={editable ? 'button' : undefined}
                tabIndex={editable ? 0 : undefined}
                aria-label="Proposed control center. Arrow keys move 10 metres; Shift moves 100 metres."
                onPointerDown={(event) => begin(event, 'center')}
                onKeyDown={(event) => nudge(event, 'center')}
                data-testid="control-center-handle"
              >
                <circle
                  cx={center.x}
                  cy={center.y}
                  r={22}
                  style={{
                    fill: 'transparent',
                    stroke: 'transparent',
                    strokeWidth: 24,
                    vectorEffect: 'non-scaling-stroke',
                  }}
                />
                <circle cx={center.x} cy={center.y} r={10} />
                <path d={`M${center.x - 5},${center.y}h10 M${center.x},${center.y - 5}v10`} />
              </g>
            )}
            {center && handle && (
              <g
                className="spatial-radius"
                role={editable ? 'slider' : undefined}
                tabIndex={editable ? 0 : undefined}
                aria-label="Avoidance radius"
                aria-valuemin={1}
                aria-valuemax={10000}
                aria-valuenow={draft?.radiusMeters ?? undefined}
                aria-valuetext={`${draft?.radiusMeters} metres`}
                onPointerDown={(event) => begin(event, 'radius')}
                onKeyDown={(event) => nudge(event, 'radius')}
                data-testid="control-radius-handle"
              >
                <line x1={center.x} y1={center.y} x2={handle.x} y2={handle.y} />
                <circle
                  cx={handle.x}
                  cy={handle.y}
                  r={22}
                  style={{
                    fill: 'transparent',
                    stroke: 'transparent',
                    strokeWidth: 24,
                    vectorEffect: 'non-scaling-stroke',
                  }}
                />
                <circle cx={handle.x} cy={handle.y} r={10} />
                <text x={handle.x} y={handle.y + 30} textAnchor="middle">
                  {Math.round(draft?.radiusMeters ?? 0).toLocaleString()} m
                </text>
              </g>
            )}
          </g>
          {scaleMeters > 0 && (
            <g className="spatial-scale" aria-label={`Distance scale ${scaleMeters} metres`}>
              <path d={`M${scaleX},${scaleY}v6 h${scaleMeters * oneMeter}v-6`} />
              <text x={scaleX} y={scaleY - 8}>
                {scaleMeters >= 1000 ? `${scaleMeters / 1000} km` : `${scaleMeters} m`}
              </text>
            </g>
          )}
        </svg>
      ) : (
        <div className="spatial-empty">
          <p>
            No spatial evidence or mission area is available. Choose a known map area or enter a manual location in
            advanced details.
          </p>
          {editable && (
            <button
              type="button"
              onClick={() => changeView({ referenceLongitude: 0, west: -180, east: 180, south: -80, north: 80 })}
            >
              Open world view for manual placement
            </button>
          )}
        </div>
      )}
      {outsideAreas > 0 && (
        <p className="spatial-instruction">
          {outsideAreas} area centres outside this view. Show all areas to locate them.
        </p>
      )}
      {controls.length > 3 ? (
        <details className="spatial-area-details">
          <summary>({controls.length}) avoidance areas</summary>
          {controlList}
        </details>
      ) : (
        controlList
      )}
      {outlined.shown.length > 0 && (
        <ul className="spatial-outline-list" aria-label="Areas that do not apply, in this view">
          {outlined.shown.map((outline) => (
            <li key={outline.id}>
              {outline.label} · {outline.note}
            </li>
          ))}
        </ul>
      )}
      {outlined.more > 0 && (
        <p className="spatial-instruction">
          {outlined.more} more areas that do not apply reach into this view. Zoom in to see them.
        </p>
      )}
      <figcaption>
        {editable
          ? 'Pan by dragging the background. Tab to handles and use arrow keys; Shift adjusts 100 m. Tap Place center, then tap the map. '
          : ''}
        WGS84 · north up. Use +/− to zoom and Fit / reset to return to the evidence and routes.
      </figcaption>
    </figure>
  );
}
