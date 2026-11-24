import { places } from './places.js';
import { buildOperationRouteTimeline } from './operation-route-timeline.js';
import { holdsWorldOperationAttempt } from './operation-predeparture-selection.js';
import type { OperationWorld } from './operation.js';

export interface OperationReservationFitOptions {
  marginMs: number;
  handoffAllowanceMs?: number;
}

export interface OperationReservationFit {
  status: 'fits' | 'held';
  reason?: string;
  sourceMissionId?: string;
  sourceRevision?: number;
  evaluatedAt?: string;
  departureAt?: string;
  nominalDurationMs?: number;
  holdAllowanceMs?: number;
  marginMs?: number;
  handoffAllowanceMs?: number;
  requiredCompletionAt?: string;
  latestDepartureAt?: string;
}

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

function utc(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : undefined;
}

function iso(time: number): string | undefined {
  if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) return undefined;
  const value = new Date(time).toISOString();
  return utc(value) === time ? value : undefined;
}

function commandLinkAllowance(world: OperationWorld, nominalCompletion: number): number | undefined {
  const configured = world.config.commandLinkEpisode;
  const episode = world.commandLinkEpisode;
  if (configured === undefined && episode === undefined) return 0;
  if (
    configured !== 'canal-market-relay.1' ||
    !episode ||
    episode.id !== `${world.config.runId}:incident:canal-market-relay:1` ||
    episode.siteId !== `${world.config.runId}-site-canal-market` ||
    episode.center?.latitude !== places['Canal Market']!.latitude ||
    episode.center?.longitude !== places['Canal Market']!.longitude ||
    episode.radiusMeters !== 450 ||
    !Array.isArray(episode.affectedAttemptIds) ||
    !episode.affectedAttemptIds.every(id) ||
    new Set(episode.affectedAttemptIds).size !== episode.affectedAttemptIds.length ||
    !Number.isSafeInteger(episode.extraAirborneMs) ||
    episode.extraAirborneMs < 0
  )
    return undefined;
  const start = utc(episode.startsAt);
  const end = utc(episode.endsAt);
  if (start === undefined || end === undefined || end <= start || end - start > 30_000) return undefined;
  if (end <= world.now || nominalCompletion <= start) return 0;
  return end - start;
}

export function operationReservationFit(
  world: OperationWorld,
  attemptId: string,
  options: OperationReservationFitOptions,
): OperationReservationFit {
  const metadata: Omit<OperationReservationFit, 'status' | 'reason'> = {};
  const held = (reason: string): OperationReservationFit => ({ status: 'held', reason, ...metadata });
  const reservation = world.reservations?.find((row) => row.id === attemptId);
  if (id(reservation?.plan?.sourceMissionId)) metadata.sourceMissionId = reservation.plan.sourceMissionId;
  const sourceRevision = reservation?.plan?.sourceRevision;
  if (typeof sourceRevision === 'number' && Number.isSafeInteger(sourceRevision) && sourceRevision > 0)
    metadata.sourceRevision = sourceRevision;
  const evaluatedAt = iso(world.now);
  if (!evaluatedAt) return held('world_clock_invalid');
  metadata.evaluatedAt = evaluatedAt;
  if (
    !reservation ||
    !holdsWorldOperationAttempt(world, reservation.tenant, reservation.id) ||
    reservation.phase !== 'awaiting-release' ||
    world.attempts.some((attempt) => attempt.id === attemptId)
  )
    return held('reservation_not_held');
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    !Object.hasOwn(options, 'marginMs') ||
    Object.keys(options).some((key) => !['marginMs', 'handoffAllowanceMs'].includes(key)) ||
    !Number.isSafeInteger(options.marginMs) ||
    options.marginMs <= 0
  )
    return held('fit_options_invalid');
  const handoffAllowanceMs = options.handoffAllowanceMs === undefined ? 0 : options.handoffAllowanceMs;
  if (!Number.isSafeInteger(handoffAllowanceMs) || handoffAllowanceMs < 0) return held('fit_options_invalid');
  metadata.marginMs = options.marginMs;
  metadata.handoffAllowanceMs = handoffAllowanceMs;
  const departure = world.now + handoffAllowanceMs;
  const departureAt = iso(departure);
  if (!departureAt) return held('fit_bounds_invalid');
  metadata.departureAt = departureAt;
  let result: ReturnType<typeof buildOperationRouteTimeline>;
  try {
    result = buildOperationRouteTimeline(reservation, world.config.cruiseMetersPerSecond);
  } catch {
    return held('route_timeline_unavailable');
  }
  if (result.status === 'unsupported') return held(result.reason);
  const { timeline } = result;
  if (timeline.version !== 'held-polyline.1' || !Number.isSafeInteger(timeline.durationMs) || timeline.durationMs <= 0)
    return held('fit_bounds_invalid');
  metadata.nominalDurationMs = timeline.durationMs;
  const nominalCompletion = departure + timeline.durationMs;
  if (!iso(nominalCompletion)) return held('fit_bounds_invalid');
  const holdAllowanceMs = commandLinkAllowance(world, nominalCompletion);
  if (holdAllowanceMs === undefined) return held('command_link_allowance_unavailable');
  metadata.holdAllowanceMs = holdAllowanceMs;
  const requiredDuration = timeline.durationMs + holdAllowanceMs + options.marginMs;
  if (!Number.isSafeInteger(requiredDuration)) return held('fit_bounds_invalid');
  const start = utc(timeline.plan.operatingInterval.start);
  const end = utc(timeline.plan.operatingInterval.end);
  if (start === undefined || end === undefined || start >= end) return held('fit_bounds_invalid');
  const requiredCompletion = departure + requiredDuration;
  const requiredCompletionAt = iso(requiredCompletion);
  const latestDepartureAt = iso(end - requiredDuration);
  if (!requiredCompletionAt || !latestDepartureAt) return held('fit_bounds_invalid');
  metadata.requiredCompletionAt = requiredCompletionAt;
  metadata.latestDepartureAt = latestDepartureAt;
  if (departure < start) return held('departure_before_plan_interval');
  if (requiredCompletion > end) return held('mission_interval_insufficient');
  return { status: 'fits', ...metadata };
}
