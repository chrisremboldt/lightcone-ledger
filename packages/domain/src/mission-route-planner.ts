import {
  MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  missionRoutePlanningReasons,
  type MissionRevisionRecord,
  type MissionRoute,
  type MissionRouteSuggestion,
  type MissionRouteTimeFit,
} from '@ledger/contracts';
import { evaluateMissionAvoidanceGeometry, type MissionAvoidanceCircle } from './mission-avoidance-kernel.js';

type Position = [longitude: number, latitude: number];
interface Point {
  x: number;
  y: number;
  position: Position;
}
interface Obstacle {
  x: number;
  y: number;
  radius: number;
}
export type MissionRouteSearchResult = Pick<
  MissionRouteSuggestion,
  'status' | 'proposedRoute' | 'distance' | 'timeFit' | 'reasons'
>;

const MAX_SEARCH_CHECKS = 2_000_000;
const CIRCLE_VERTICES = 16;
const RADIANS = Math.PI / 180;
const unsupportedFit = (reasons: string[]): MissionRouteTimeFit => ({
  status: 'unsupported',
  model: 'held-polyline.1',
  reasons,
});
const samePosition = (first: readonly number[], second: readonly number[]) =>
  first[0] === second[0] && first[1] === second[1];

function route(coordinates: Position[]): MissionRoute {
  return {
    coordinateReference: 'WGS84',
    coordinateOrder: 'longitude_latitude',
    segmentInterpolation: 'linear_longitude_latitude',
    geometry: { type: 'LineString', coordinates },
  };
}

export function modeledRouteDistance(coordinates: readonly (readonly number[])[]): number {
  let distance = 0;
  for (let index = 1; index < coordinates.length; index++) {
    const first = coordinates[index - 1]!;
    const second = coordinates[index]!;
    distance +=
      Math.hypot(
        second[1]! - first[1]!,
        (second[0]! - first[0]!) * Math.cos(((first[1]! + second[1]!) * Math.PI) / 360),
      ) * 111_320;
  }
  return distance;
}

export function modeledMissionTimeFit(
  mission: MissionRevisionRecord,
  proposed: MissionRoute,
  evaluatedAt: string,
): MissionRouteTimeFit {
  const planning = mission.routePlanning;
  if (!planning) return unsupportedFit(['route_planning_context_missing']);
  const reasons = missionRoutePlanningReasons(planning, proposed.geometry.coordinates, mission.operatingInterval);
  if (reasons.length) return unsupportedFit(reasons);
  const evaluated = Date.parse(evaluatedAt);
  if (!Number.isSafeInteger(evaluated)) return unsupportedFit(['planning_clock_invalid']);
  let travelMs = 0;
  for (let index = 1; index < proposed.geometry.coordinates.length; index++) {
    const first = proposed.geometry.coordinates[index - 1]!;
    const second = proposed.geometry.coordinates[index]!;
    if (!samePosition(first, second))
      travelMs += Math.max(
        1,
        Math.ceil((modeledRouteDistance([first, second]) / planning.cruiseMetersPerSecond) * 1000),
      );
  }
  const serviceCount = planning.requiredLocations.filter((location) => location.role === 'service').length;
  const nominalDurationMs = travelMs + planning.ascentMs + planning.serviceMs * serviceCount + planning.descentMs;
  const requiredMs = nominalDurationMs + planning.holdAllowanceMs + planning.marginMs;
  const departure = Math.max(
    evaluated + planning.handoffAllowanceMs,
    ...[mission.operatingInterval, planning.customerInterval, planning.resourceInterval].map((interval) =>
      Date.parse(interval.start),
    ),
  );
  const end = Math.min(
    ...[mission.operatingInterval, planning.customerInterval, planning.resourceInterval].map((interval) =>
      Date.parse(interval.end),
    ),
  );
  const completion = departure + requiredMs;
  const latestDeparture = end - requiredMs;
  if (
    ![travelMs, nominalDurationMs, requiredMs, departure, end, completion, latestDeparture].every(
      Number.isSafeInteger,
    ) ||
    ![departure, completion, latestDeparture].every((time) => Number.isFinite(new Date(time).getTime()))
  )
    return unsupportedFit(['planning_duration_outside_bounds']);
  return {
    status: completion <= end ? 'fits' : 'insufficient',
    model: 'held-polyline.1',
    departureAt: new Date(departure).toISOString(),
    requiredCompletionAt: new Date(completion).toISOString(),
    latestDepartureAt: new Date(latestDeparture).toISOString(),
    nominalDurationMs,
    travelMs,
    holdAllowanceMs: planning.holdAllowanceMs,
    handoffAllowanceMs: planning.handoffAllowanceMs,
    marginMs: planning.marginMs,
    slackMs: end - completion,
    reasons: completion <= end ? [] : ['mission_interval_insufficient'],
  };
}

function segmentDistance(first: Point, second: Point, center: Obstacle): number {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const length = dx * dx + dy * dy;
  const fraction =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((center.x - first.x) * dx + (center.y - first.y) * dy) / length));
  return Math.hypot(first.x + fraction * dx - center.x, first.y + fraction * dy - center.y);
}

export function suggestMissionRoute(
  mission: MissionRevisionRecord,
  circles: readonly MissionAvoidanceCircle[],
  clearanceMeters: number,
  evaluatedAt: string,
): MissionRouteSearchResult {
  const failed = (status: MissionRouteSearchResult['status'], reasons: string[]): MissionRouteSearchResult => ({
    status,
    proposedRoute: null,
    distance: null,
    timeFit: unsupportedFit(reasons),
    reasons,
  });
  if (!Number.isFinite(clearanceMeters) || clearanceMeters < 1 || clearanceMeters > 500)
    return failed('unsupported', ['planning_clearance_outside_bounds']);
  if (!mission.routePlanning) return failed('unsupported', ['route_planning_context_missing']);
  const contextReasons = missionRoutePlanningReasons(
    mission.routePlanning,
    mission.route.geometry.coordinates,
    mission.operatingInterval,
  );
  if (contextReasons.length) return failed('unsupported', contextReasons);
  if (circles.length > MISSION_AVOIDANCE_CONSIDERED_LIMIT) return failed('unsupported', ['considered_limit_exceeded']);
  if (
    circles.some(
      (circle) => !Number.isFinite(circle.radiusMeters) || circle.radiusMeters <= 0 || circle.radiusMeters > 10_000,
    )
  )
    return failed('unsupported', ['control_geometry_outside_profile']);
  const additionalTolerance = Math.max(0, ...circles.map((circle) => circle.radiusMeters + clearanceMeters - 10_000));
  const proofTolerance = mission.lateralToleranceMeters + additionalTolerance;
  const clearanceCircles = circles.map((circle) => ({
    center: { ...circle.center },
    radiusMeters: circle.radiusMeters + clearanceMeters - additionalTolerance,
  }));
  let remainingProofBudget = 100_000;
  function proof(candidate: MissionRoute) {
    const result = evaluateMissionAvoidanceGeometry({
      mission: { route: candidate, lateralToleranceMeters: proofTolerance },
      circles: clearanceCircles,
      distanceBudget: remainingProofBudget,
    });
    remainingProofBudget = result.remainingDistanceBudget;
    return result;
  }
  const originalProof = proof(mission.route);
  if (originalProof.reasons.length || originalProof.results.some((result) => result.verdict === 'insufficient'))
    return failed('unsupported', [
      ...new Set([...originalProof.reasons, ...originalProof.results.flatMap((result) => result.reasons)]),
    ]);
  const finish = (candidate: MissionRoute, unchanged: boolean): MissionRouteSearchResult => {
    const timeFit = modeledMissionTimeFit(mission, candidate, evaluatedAt);
    const originalMeters = modeledRouteDistance(mission.route.geometry.coordinates);
    const proposedMeters = modeledRouteDistance(candidate.geometry.coordinates);
    return {
      status:
        timeFit.status === 'fits'
          ? unchanged
            ? 'unchanged'
            : 'suggested'
          : timeFit.status === 'insufficient'
            ? 'infeasible'
            : 'unsupported',
      proposedRoute: candidate,
      distance: {
        model: 'held-polyline.1',
        originalMeters,
        proposedMeters,
        changeMeters: proposedMeters - originalMeters,
      },
      timeFit,
      reasons: timeFit.reasons,
    };
  };
  if (originalProof.results.every((result) => result.verdict === 'outside'))
    return finish(structuredClone(mission.route), true);

  const required = mission.routePlanning.requiredLocations.map((location) => [...location.position] as Position);
  for (const position of required) {
    const result = proof(route([position, position]));
    if (result.results.some((entry) => entry.verdict === 'intersects'))
      return failed('infeasible', ['required_location_inside_avoidance_corridor']);
    if (result.reasons.length || result.results.some((entry) => entry.verdict === 'insufficient'))
      return failed('unsupported', ['required_location_comparison_uncertain']);
  }
  const origin = required[0]!;
  const longitudeScale = 111_320 * Math.cos(origin[1] * RADIANS);
  const project = (position: Position): Point => ({
    x: (position[0] - origin[0]) * longitudeScale,
    y: (position[1] - origin[1]) * 111_320,
    position,
  });
  const unproject = (x: number, y: number): Point => ({
    x,
    y,
    position: [origin[0] + x / longitudeScale, origin[1] + y / 111_320],
  });
  const obstacles = clearanceCircles.map((circle) => ({
    ...project([circle.center.longitude, circle.center.latitude]),
    radius: (circle.radiusMeters + proofTolerance) * 1.01 + 0.1,
  }));
  const nodes: Point[] = [];
  for (const obstacle of obstacles) {
    const radialDistance = (obstacle.radius + 2) / Math.cos(Math.PI / CIRCLE_VERTICES);
    for (let index = 0; index < CIRCLE_VERTICES; index++) {
      const angle = (index / CIRCLE_VERTICES) * Math.PI * 2;
      const point = unproject(
        obstacle.x + Math.cos(angle) * radialDistance,
        obstacle.y + Math.sin(angle) * radialDistance,
      );
      if (
        Math.abs(point.position[0]) <= 180 &&
        Math.abs(point.position[1]) <= 80 &&
        obstacles.every((other) => Math.hypot(point.x - other.x, point.y - other.y) > other.radius)
      )
        nodes.push(point);
    }
  }
  let searchChecks = 0;
  let exhausted = false;
  function visible(first: Point, second: Point): boolean {
    for (const obstacle of obstacles) {
      if (++searchChecks > MAX_SEARCH_CHECKS) {
        exhausted = true;
        return false;
      }
      if (
        obstacle.x + obstacle.radius < Math.min(first.x, second.x) ||
        obstacle.x - obstacle.radius > Math.max(first.x, second.x) ||
        obstacle.y + obstacle.radius < Math.min(first.y, second.y) ||
        obstacle.y - obstacle.radius > Math.max(first.y, second.y)
      )
        continue;
      if (segmentDistance(first, second, obstacle) <= obstacle.radius) return false;
    }
    return true;
  }
  function leg(start: Point, end: Point): Point[] | null {
    if (visible(start, end)) return [start, end];
    const points = [start, end, ...nodes];
    const distances = points.map(() => Infinity);
    const previous = points.map(() => -1);
    const visited = new Set<number>();
    distances[0] = 0;
    for (let iteration = 0; iteration < points.length && !exhausted; iteration++) {
      let current = -1;
      for (let index = 0; index < points.length; index++)
        if (!visited.has(index) && (current < 0 || distances[index]! < distances[current]!)) current = index;
      if (current < 0 || !Number.isFinite(distances[current])) return null;
      if (current === 1) {
        const result: Point[] = [];
        for (let index = 1; index >= 0; index = previous[index]!) result.unshift(points[index]!);
        return result;
      }
      visited.add(current);
      for (let index = 0; index < points.length && !exhausted; index++) {
        if (visited.has(index)) continue;
        const cost =
          distances[current]! +
          Math.hypot(points[index]!.x - points[current]!.x, points[index]!.y - points[current]!.y);
        if (cost < distances[index]! && visible(points[current]!, points[index]!)) {
          distances[index] = cost;
          previous[index] = current;
        }
      }
    }
    return null;
  }
  const coordinates: Position[] = [[...required[0]!] as Position];
  for (let index = 1; index < required.length; index++) {
    const result = leg(project(required[index - 1]!), project(required[index]!));
    if (!result)
      return failed('search_exhausted', [
        exhausted ? 'planning_search_budget_exhausted' : 'no_route_found_within_search_profile',
      ]);
    coordinates.push(...result.slice(1).map((point) => [...point.position] as Position));
    if (coordinates.length > 256) return failed('search_exhausted', ['planning_route_vertex_limit_exceeded']);
  }
  const candidate = route(coordinates);
  const result = proof(candidate);
  if (result.reasons.length || result.results.some((entry) => entry.verdict !== 'outside'))
    return failed('search_exhausted', [
      ...new Set([
        'planning_candidate_not_proven_clear',
        ...result.reasons,
        ...result.results.flatMap((entry) => entry.reasons),
      ]),
    ]);
  return finish(candidate, false);
}
