import { places, type Coordinate } from './places.js';
import type { OperationAttempt, OperationConfig, OperationWorld } from './operation.js';

export const operationPhases = { ascentMs: 20_000, dwellMs: 20_000, descentMs: 20_000 } as const;

export interface CommandLinkEpisode {
  id: string;
  siteId: string;
  center: Coordinate;
  radiusMeters: number;
  startsAt: string;
  endsAt: string;
  affectedAttemptIds: string[];
  extraAirborneMs: number;
}

export interface CommandLinkHold {
  incidentId: string;
  sourceSessionId: string;
  lostAt: string;
  restoredAt: string;
  point: Coordinate & { height: number };
  nominalLanding: string;
  holdMs: number;
  extraAirborneMs: number;
}

export function createCommandLinkEpisode(config: OperationConfig, start: number): CommandLinkEpisode {
  return {
    id: `${config.runId}:incident:canal-market-relay:1`,
    siteId: `${config.runId}-site-canal-market`,
    center: { ...places['Canal Market']! },
    radiusMeters: 450,
    startsAt: new Date(start + 90_000).toISOString(),
    endsAt: new Date(start + 120_000).toISOString(),
    affectedAttemptIds: [],
    extraAirborneMs: 0,
  };
}

function projected(point: Coordinate, center: Coordinate): { x: number; y: number } {
  return {
    x: (point.longitude - center.longitude) * Math.cos((center.latitude * Math.PI) / 180) * 111_320,
    y: (point.latitude - center.latitude) * 111_320,
  };
}

function circleFractions(attempt: OperationAttempt, episode: CommandLinkEpisode): [number, number] | undefined {
  const origin = projected(attempt.origin, episode.center);
  const destination = projected(attempt.destination, episode.center);
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  const a = dx * dx + dy * dy;
  const c = origin.x * origin.x + origin.y * origin.y - episode.radiusMeters ** 2;
  if (a === 0) return c <= 0 ? [0, 1] : undefined;
  const b = 2 * (origin.x * dx + origin.y * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const first = Math.max(0, (-b - root) / (2 * a));
  const last = Math.min(1, (-b + root) / (2 * a));
  return first <= last ? [first, last] : undefined;
}

export function commandLinkLossAt(attempt: OperationAttempt, episode: CommandLinkEpisode): number | undefined {
  const fractions = circleFractions(attempt, episode);
  if (!fractions) return undefined;
  const [first, last] = fractions;
  const departure = Date.parse(attempt.departure);
  const outbound = departure + operationPhases.ascentMs;
  const arrival = outbound + attempt.travelMs;
  const inbound = arrival + operationPhases.dwellMs;
  const descent = inbound + attempt.travelMs;
  const intervals: Array<[number, number]> = [
    ...(first === 0 ? [[departure, outbound] as [number, number]] : []),
    [outbound + first * attempt.travelMs, outbound + last * attempt.travelMs],
    ...(last === 1 ? [[arrival, inbound] as [number, number]] : []),
    [inbound + (1 - last) * attempt.travelMs, inbound + (1 - first) * attempt.travelMs],
    ...(first === 0 ? [[descent, Date.parse(attempt.landing)] as [number, number]] : []),
  ];
  const begins = Date.parse(episode.startsAt);
  const ends = Math.min(Date.parse(episode.endsAt), Date.parse(attempt.landing));
  for (const [entry, exit] of intervals) {
    const at = Math.ceil(Math.max(begins, entry));
    if (at <= exit && at < ends) return at;
  }
  return undefined;
}

export function commandLinkEpisodeStatus(world: OperationWorld) {
  const episode = world.commandLinkEpisode;
  if (!episode) return {};
  const holds = world.attempts.flatMap((attempt) => (attempt.commandLinkHold ? [attempt.commandLinkHold] : []));
  const state =
    world.now < Date.parse(episode.startsAt)
      ? 'scheduled'
      : world.now < Date.parse(episode.endsAt)
        ? 'active'
        : 'restored';
  return {
    commandLinkEpisode: {
      id: episode.id,
      siteId: episode.siteId,
      radiusMeters: episode.radiusMeters,
      startsAt: episode.startsAt,
      endsAt: episode.endsAt,
      state,
      affected: episode.affectedAttemptIds.length,
      held: holds.filter((hold) => world.now >= Date.parse(hold.lostAt) && world.now < Date.parse(hold.restoredAt))
        .length,
      extraAirborneMs: episode.extraAirborneMs,
    },
  };
}
