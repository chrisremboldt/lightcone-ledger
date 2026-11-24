import type {
  MissionAvoidanceCandidate,
  MissionAvoidanceNotApplicable,
  MissionRevisionRecord,
  MissionRoute as Route,
} from '@ledger/contracts';
import type { AreaControl } from './area-controls.js';
import { notApplicableOutlines } from './flight-controls.js';
import { SpatialMap, type SpatialLine, type SpatialPoint } from './SpatialMap.js';
import type { Coordinate } from './geography.js';

interface Props {
  mission: MissionRevisionRecord;
  controls: { candidate: MissionAvoidanceCandidate; control: AreaControl }[];
  /** Considered areas recorded as not applying to this route: drawn for context near it, never fitted. */
  notApplicable?: MissionAvoidanceNotApplicable[];
  proposedRoute?: Route | null;
}
const radians = Math.PI / 180;
function validCoordinate(point: Coordinate) {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 80 &&
    Math.abs(point.longitude) <= 180
  );
}
function routeIssue(mission: MissionRevisionRecord, points: Coordinate[]): string | null {
  if (
    mission.route.coordinateReference !== 'WGS84' ||
    mission.route.coordinateOrder !== 'longitude_latitude' ||
    mission.route.segmentInterpolation !== 'linear_longitude_latitude' ||
    mission.route.geometry.type !== 'LineString' ||
    points.length < 2 ||
    points.length > 256 ||
    !points.every(validCoordinate)
  )
    return 'This route is outside the local coordinate plot. Review its exact mission geometry in the record details.';
  if (
    !Number.isFinite(mission.lateralToleranceMeters) ||
    mission.lateralToleranceMeters < 0 ||
    mission.lateralToleranceMeters > 1000
  )
    return 'The declared corridor is outside the local plot. Review the recorded mission and comparison reasons.';
  let lengthBound = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const longitudeDelta = point.longitude - previous.longitude;
    if (Math.abs(longitudeDelta) > 180)
      return 'This route crosses the antimeridian by direct longitude interpolation. The local plot cannot display it faithfully.';
    lengthBound +=
      6400000 * Math.hypot((point.latitude - previous.latitude) * radians, longitudeDelta * radians) + 0.001;
  }
  return lengthBound > 50000
    ? 'This route exceeds the local 50 km plotting profile. Review the exact mission and comparison reasons.'
    : null;
}

export function MissionRoute({ mission, controls, notApplicable = [], proposedRoute }: Props) {
  const points = mission.route.geometry.coordinates.map(([longitude, latitude]) => ({ longitude, latitude }));
  const issue = routeIssue(mission, points);
  if (issue)
    return (
      <p className="mission-route-empty" role="status">
        {issue}
      </p>
    );
  const lines: SpatialLine[] = [
    {
      id: mission.id,
      label: `Original mission revision ${mission.sourceRevision}`,
      kind: 'mission',
      points,
      corridorMeters: mission.lateralToleranceMeters,
    },
  ];
  if (proposedRoute)
    lines.push({
      id: 'suggested-detour',
      label: 'Proposed detour',
      kind: 'proposed',
      corridorMeters: mission.lateralToleranceMeters,
      points: proposedRoute.geometry.coordinates.map(([longitude, latitude]) => ({ longitude, latitude })),
    });
  const required: SpatialPoint[] = mission.routePlanning?.requiredLocations.map((location, index) => ({
    id: `required:${index}`,
    label: location.role === 'launch' ? 'Launch' : location.role === 'return' ? 'Return' : `Service ${index}`,
    position: { longitude: location.position[0], latitude: location.position[1] },
    kind: 'required',
  })) ?? [
    { id: 'start', label: 'Start', position: points[0]!, kind: 'required' },
    { id: 'end', label: 'End', position: points.at(-1)!, kind: 'required' },
  ];
  const uniqueRequired = required.reduce<SpatialPoint[]>((result, point) => {
    const same = result.find(
      (existing) =>
        existing.position.latitude === point.position.latitude &&
        existing.position.longitude === point.position.longitude,
    );
    if (same) same.label = `${same.label} / ${point.label.toLowerCase()}`;
    else result.push({ ...point });
    return result;
  }, []);
  return (
    <div className="mission-route" data-testid="mission-route">
      <div className="spatial-legend">
        <span>
          {proposedRoute ? 'Original' : 'Planned'} route · corridor {mission.lateralToleranceMeters} m each side
        </span>
        {proposedRoute && <span className="is-proposed">Proposed detour · same corridor</span>}
        <span className="is-control">Accepted avoidance areas</span>
        {notApplicable.length > 0 && <span className="is-not-applicable">Do not apply to this route · dashed</span>}
      </div>
      <SpatialMap
        label={`Planned mission revision ${mission.sourceRevision}, required locations and ${controls.length} accepted avoidance areas`}
        lines={lines}
        points={uniqueRequired}
        controls={controls.map(({ control }) => ({
          id: control.eventId,
          label: control.title,
          center: control.area.center,
          radiusMeters: control.area.radiusMeters,
          state: 'accepted',
        }))}
        outlines={notApplicableOutlines(notApplicable)}
        testId="mission-route-coordinate-map"
      />
    </div>
  );
}
