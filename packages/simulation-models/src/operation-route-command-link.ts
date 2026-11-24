import type { CommandLinkEpisode } from './operation-command-link.js';
import { validateOperationMissionSource } from './operation-mission-validation.js';
import type { OperationRoutePhase, OperationRouteTimeline } from './operation-route-timeline.js';
import type { Coordinate } from './places.js';

function invalid(): never {
  throw new Error('Invalid route command-link timeline, departure or episode');
}

function coordinate(value: Coordinate): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isFinite(value.latitude) &&
    Math.abs(value.latitude) <= 90 &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.longitude) <= 180
  );
}

function samePoint(first: Coordinate, second: Coordinate): boolean {
  return first.latitude === second.latitude && first.longitude === second.longitude;
}

function time(value: string): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return at;
}

function validate(
  timeline: OperationRouteTimeline,
  departureAt: number,
  episode: CommandLinkEpisode,
): [number, number] {
  if (
    !timeline ||
    timeline.version !== 'held-polyline.1' ||
    !Number.isSafeInteger(departureAt) ||
    !Number.isFinite(new Date(departureAt).getTime()) ||
    !Number.isSafeInteger(timeline.durationMs) ||
    timeline.durationMs <= 0 ||
    !Number.isSafeInteger(departureAt + timeline.durationMs) ||
    !Number.isFinite(new Date(departureAt + timeline.durationMs).getTime()) ||
    !Number.isFinite(timeline.cruiseMetersPerSecond) ||
    timeline.cruiseMetersPerSecond <= 0 ||
    !Array.isArray(timeline.phases) ||
    timeline.phases.length < 3 ||
    timeline.phases.length > 258 ||
    !episode ||
    !coordinate(episode.center) ||
    !Number.isFinite(episode.radiusMeters) ||
    episode.radiusMeters < 0
  )
    return invalid();
  validateOperationMissionSource(timeline.plan);
  if (
    !Number.isSafeInteger(timeline.serviceVertexIndex) ||
    timeline.serviceVertexIndex < 0 ||
    timeline.serviceVertexIndex >= timeline.plan.route.geometry.coordinates.length
  )
    return invalid();
  let previousEnd = 0;
  let previousPoint: Coordinate | undefined;
  for (const phase of timeline.phases) {
    if (
      !phase ||
      !['ascent', 'travel', 'service', 'descent'].includes(phase.kind) ||
      !Number.isSafeInteger(phase.startMs) ||
      phase.startMs !== previousEnd ||
      !Number.isSafeInteger(phase.endMs) ||
      phase.endMs <= phase.startMs ||
      !coordinate(phase.from) ||
      !coordinate(phase.to) ||
      (previousPoint !== undefined && !samePoint(previousPoint, phase.from)) ||
      (phase.kind !== 'travel' && !samePoint(phase.from, phase.to)) ||
      !Number.isFinite(phase.distanceMeters) ||
      phase.distanceMeters < 0
    )
      return invalid();
    if (!samePoint(phase.from, phase.to)) {
      const from = projected(phase.from, episode.center);
      const to = projected(phase.to, episode.center);
      if (from.x === to.x && from.y === to.y) return invalid();
    }
    previousEnd = phase.endMs;
    previousPoint = phase.to;
  }
  if (previousEnd !== timeline.durationMs) return invalid();
  const begins = time(episode.startsAt);
  const ends = time(episode.endsAt);
  if (begins >= ends) return invalid();
  return [begins, Math.min(ends, departureAt + timeline.durationMs)];
}

function projected(point: Coordinate, center: Coordinate): { x: number; y: number } {
  return {
    x: (point.longitude - center.longitude) * Math.cos((center.latitude * Math.PI) / 180) * 111_320,
    y: (point.latitude - center.latitude) * 111_320,
  };
}

function circleFractions(phase: OperationRoutePhase, episode: CommandLinkEpisode): [number, number] | undefined {
  const from = projected(phase.from, episode.center);
  const to = projected(phase.to, episode.center);
  const fromInside = Math.hypot(from.x, from.y) <= episode.radiusMeters;
  const toInside = Math.hypot(to.x, to.y) <= episode.radiusMeters;
  if (samePoint(phase.from, phase.to)) return fromInside ? [0, 1] : undefined;
  if (from.x === to.x && from.y === to.y) return invalid();
  if (fromInside && toInside) return [0, 1];
  const scale = Math.max(Math.abs(from.x), Math.abs(from.y), Math.abs(to.x), Math.abs(to.y), episode.radiusMeters);
  if (!scale) return invalid();
  const x = from.x / scale;
  const y = from.y / scale;
  const dx = to.x / scale - x;
  const dy = to.y / scale - y;
  const radius = episode.radiusMeters / scale;
  const length = Math.hypot(dx, dy);
  if (!length) return invalid();
  const ux = dx / length;
  const uy = dy / length;
  const nearest = -(x * ux + y * uy);
  const perpendicular = Math.abs(x * uy - y * ux);
  if (perpendicular > radius) return undefined;
  const halfChord = Math.sqrt((radius - perpendicular) * (radius + perpendicular));
  const first = Math.max(0, (nearest - halfChord) / length);
  const last = Math.min(1, (nearest + halfChord) / length);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return invalid();
  return first <= last ? [first, last] : undefined;
}

export function operationRouteCommandLinkLossAt(
  timeline: OperationRouteTimeline,
  departureAt: number,
  episode: CommandLinkEpisode,
): number | undefined {
  const [begins, ends] = validate(timeline, departureAt, episode);
  if (begins >= ends) return undefined;
  for (const phase of timeline.phases) {
    const fractions = circleFractions(phase, episode);
    if (!fractions) continue;
    const [first, last] = fractions;
    const duration = phase.endMs - phase.startMs;
    const entry = departureAt + phase.startMs + first * duration;
    const exit = departureAt + phase.startMs + last * duration;
    const at = Math.ceil(Math.max(begins, entry));
    if (at <= exit && at < ends) return at;
  }
  return undefined;
}
