import { operationPhases } from './operation-command-link.js';
import { validateOperationMissionSource } from './operation-mission-validation.js';
import type { OperationMissionSource } from './operation-mission.js';
import type { OperationReservation } from './operation-predeparture.js';
import type { Coordinate } from './places.js';

export interface OperationRoutePhase {
  kind: 'ascent' | 'travel' | 'service' | 'descent';
  startMs: number;
  endMs: number;
  from: Coordinate;
  to: Coordinate;
  distanceMeters: number;
}

export interface OperationRouteTimeline {
  version: 'held-polyline.1';
  plan: OperationMissionSource;
  cruiseMetersPerSecond: number;
  serviceVertexIndex: number;
  phases: OperationRoutePhase[];
  durationMs: number;
}

export type OperationRouteTimelineResult =
  { status: 'supported'; timeline: OperationRouteTimeline } | { status: 'unsupported'; reason: string };

export interface OperationRoutePause {
  startsAtMs: number;
  durationMs: number;
}

export interface OperationRoutePoint extends Coordinate {
  horizontalSpeed: number;
  phase: OperationRoutePhase['kind'] | 'held' | 'complete';
  motionElapsedMs: number;
}

function validCoordinate(point: Coordinate): boolean {
  return (
    point !== null &&
    typeof point === 'object' &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180 &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90
  );
}

function samePoint(first: Coordinate, second: Coordinate): boolean {
  return first.longitude === second.longitude && first.latitude === second.latitude;
}

function localDistance(first: Coordinate, second: Coordinate): number {
  return (
    Math.hypot(
      second.latitude - first.latitude,
      (second.longitude - first.longitude) * Math.cos(((first.latitude + second.latitude) * Math.PI) / 360),
    ) * 111_320
  );
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

export function buildOperationRouteTimeline(
  reservation: OperationReservation,
  cruiseMetersPerSecond: number,
): OperationRouteTimelineResult {
  try {
    validateOperationMissionSource(reservation.plan);
    if (
      reservation.phase !== 'awaiting-release' ||
      reservation.plan.sourceMissionId !== `${reservation.id}:mission` ||
      reservation.plan.aircraftId !== reservation.aircraftId
    )
      throw new Error('Held route identity does not match its reservation');
    if (!validCoordinate(reservation.origin) || !validCoordinate(reservation.destination))
      throw new Error('Held route requires valid launch and service coordinates');
    if (!Number.isFinite(cruiseMetersPerSecond) || cruiseMetersPerSecond <= 0)
      throw new Error('Held route requires a finite positive cruise speed');
    const plan = structuredClone(reservation.plan);
    const points = plan.route.geometry.coordinates.map(([longitude, latitude]) => ({ longitude, latitude }));
    if (!samePoint(points[0]!, reservation.origin) || !samePoint(points.at(-1)!, reservation.origin))
      throw new Error('Held route must begin and end at its retained launch site');
    const serviceVertexIndex = points.findIndex((point) => samePoint(point, reservation.destination));
    if (serviceVertexIndex < 0) throw new Error('Held route must retain an explicit service destination vertex');

    const phases: OperationRoutePhase[] = [];
    let durationMs = 0;
    function append(kind: OperationRoutePhase['kind'], from: Coordinate, to: Coordinate, duration: number) {
      const endMs = durationMs + duration;
      if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(endMs))
        throw new Error('Held route duration exceeds the supported finite clock');
      phases.push({
        kind,
        startMs: durationMs,
        endMs,
        from: { ...from },
        to: { ...to },
        distanceMeters: kind === 'travel' ? localDistance(from, to) : 0,
      });
      durationMs = endMs;
    }
    append('ascent', points[0]!, points[0]!, operationPhases.ascentMs);
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!;
      if (index > 0) {
        const previous = points[index - 1]!;
        if (!samePoint(previous, point)) {
          const travelMs = Math.max(1, Math.ceil((localDistance(previous, point) / cruiseMetersPerSecond) * 1000));
          append('travel', previous, point, travelMs);
        }
      }
      if (index === serviceVertexIndex) append('service', point, point, operationPhases.dwellMs);
    }
    append('descent', points.at(-1)!, points.at(-1)!, operationPhases.descentMs);
    return {
      status: 'supported',
      timeline: freezeSnapshot({
        version: 'held-polyline.1',
        plan,
        cruiseMetersPerSecond,
        serviceVertexIndex,
        phases,
        durationMs,
      }),
    };
  } catch (error) {
    return { status: 'unsupported', reason: error instanceof Error ? error.message : 'Unsupported held route' };
  }
}

function validateTimeline(timeline: OperationRouteTimeline) {
  if (
    timeline.version !== 'held-polyline.1' ||
    !Number.isSafeInteger(timeline.durationMs) ||
    timeline.durationMs <= 0 ||
    !Array.isArray(timeline.phases) ||
    timeline.phases.length === 0
  )
    throw new Error('Invalid held route timeline');
  let previousEnd = 0;
  let previousPoint: Coordinate | undefined;
  for (const phase of timeline.phases) {
    if (
      !['ascent', 'travel', 'service', 'descent'].includes(phase.kind) ||
      !Number.isSafeInteger(phase.startMs) ||
      phase.startMs !== previousEnd ||
      !Number.isSafeInteger(phase.endMs) ||
      phase.endMs <= phase.startMs ||
      !validCoordinate(phase.from) ||
      !validCoordinate(phase.to) ||
      (previousPoint !== undefined && !samePoint(previousPoint, phase.from)) ||
      (phase.kind !== 'travel' && !samePoint(phase.from, phase.to)) ||
      !Number.isFinite(phase.distanceMeters) ||
      phase.distanceMeters < 0
    )
      throw new Error('Invalid held route phase');
    previousEnd = phase.endMs;
    previousPoint = phase.to;
  }
  if (previousEnd !== timeline.durationMs) throw new Error('Invalid held route duration');
}

export function operationRoutePoint(
  timeline: OperationRouteTimeline,
  elapsedMs: number,
  pause?: OperationRoutePause,
): OperationRoutePoint {
  validateTimeline(timeline);
  if (!Number.isFinite(elapsedMs) || Math.abs(elapsedMs) > Number.MAX_SAFE_INTEGER)
    throw new Error('Held route sample requires a finite elapsed clock');
  let motionElapsedMs = Math.max(0, elapsedMs);
  let held = false;
  if (pause) {
    const endsAtMs = pause.startsAtMs + pause.durationMs;
    if (
      !Number.isSafeInteger(pause.startsAtMs) ||
      pause.startsAtMs < 0 ||
      pause.startsAtMs > timeline.durationMs ||
      !Number.isSafeInteger(pause.durationMs) ||
      pause.durationMs < 0 ||
      !Number.isSafeInteger(endsAtMs) ||
      !Number.isSafeInteger(timeline.durationMs + pause.durationMs)
    )
      throw new Error('Held route pause requires a finite bounded interval');
    motionElapsedMs -= Math.min(Math.max(motionElapsedMs - pause.startsAtMs, 0), pause.durationMs);
    held = elapsedMs >= pause.startsAtMs && elapsedMs < endsAtMs;
  }
  motionElapsedMs = Math.min(motionElapsedMs, timeline.durationMs);
  if (motionElapsedMs === timeline.durationMs)
    return {
      ...timeline.phases.at(-1)!.to,
      horizontalSpeed: 0,
      phase: 'complete',
      motionElapsedMs,
    };
  const phase = timeline.phases.find((candidate) => motionElapsedMs < candidate.endMs)!;
  const fraction = (motionElapsedMs - phase.startMs) / (phase.endMs - phase.startMs);
  return {
    longitude: phase.from.longitude + (phase.to.longitude - phase.from.longitude) * fraction,
    latitude: phase.from.latitude + (phase.to.latitude - phase.from.latitude) * fraction,
    horizontalSpeed:
      held || phase.kind !== 'travel' ? 0 : phase.distanceMeters / ((phase.endMs - phase.startMs) / 1000),
    phase: held ? 'held' : phase.kind,
    motionElapsedMs,
  };
}
