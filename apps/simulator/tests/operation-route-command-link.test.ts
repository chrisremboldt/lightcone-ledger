import { describe, expect, it } from 'vitest';
import type { CommandLinkEpisode } from '../../../packages/simulation-models/src/operation-command-link.js';
import { createOperationReservation } from '../../../packages/simulation-models/src/operation-predeparture.js';
import { operationRouteCommandLinkLossAt } from '../../../packages/simulation-models/src/operation-route-command-link.js';
import { buildOperationRouteTimeline } from '../../../packages/simulation-models/src/operation-route-timeline.js';
import type { Coordinate } from '../../../packages/simulation-models/src/places.js';

const departureAt = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (value: number) => new Date(value).toISOString();
const center = { longitude: 0, latitude: 0 };
const point = (x: number, y: number): Coordinate => ({ longitude: x / 111_320, latitude: y / 111_320 });

function timeline(points: Coordinate[], serviceVertexIndex = 1, speed = 10) {
  const reservation = createOperationReservation(
    {
      id: 'route-attempt',
      intentId: 'route-intent',
      demandId: 'route-order',
      tenant: 'alpha',
      aircraftId: 'route-aircraft',
      personId: 'route-person',
      sourceSessionId: 'route-capture',
      siteId: 'route-site',
      origin: { ...points[0]! },
      destination: { ...points[serviceVertexIndex]! },
      travelMs: 0,
    },
    {
      id: 'route-order',
      intentId: 'route-intent',
      tenant: 'alpha',
      requestedAt: iso(departureAt),
      siteId: 'route-site',
      label: 'Analytical route',
    },
    departureAt,
    300_000,
  );
  reservation.plan.route.geometry.coordinates = points.map(({ longitude, latitude }) => [longitude, latitude]);
  const result = buildOperationRouteTimeline(reservation, speed);
  if (result.status !== 'supported') throw new Error(result.reason);
  return result.timeline;
}

function episode(startMs = 0, endMs = 300_000, overrides: Partial<CommandLinkEpisode> = {}): CommandLinkEpisode {
  return {
    id: 'analytical-episode',
    siteId: 'analytical-site',
    center: { ...center },
    radiusMeters: 25,
    startsAt: iso(departureAt + startMs),
    endsAt: iso(departureAt + endMs),
    affectedAttemptIds: [],
    extraAirborneMs: 0,
    ...overrides,
  };
}

describe('held route command-link contact', () => {
  it('uses each declared detour segment rather than the straight destination chord', () => {
    const origin = point(-100, 0);
    const destination = point(100, 0);
    const straight = timeline([origin, destination, origin]);
    const detour = timeline(
      [origin, point(-100, 100), point(100, 100), destination, point(100, 100), point(-100, 100), origin],
      3,
    );
    const outage = episode();
    const retained = JSON.stringify({ straight, detour, outage });
    const crossing = operationRouteCommandLinkLossAt(straight, departureAt, outage)!;
    const travel = straight.phases.find((phase) => phase.kind === 'travel')!;
    const expected = departureAt + travel.startMs + (travel.endMs - travel.startMs) * (75 / 200);
    expect(Math.abs(crossing - expected)).toBeLessThanOrEqual(1);
    expect(crossing).toBeGreaterThan(departureAt + travel.startMs);
    expect(operationRouteCommandLinkLossAt(detour, departureAt, outage)).toBeUndefined();
    expect(operationRouteCommandLinkLossAt(JSON.parse(JSON.stringify(straight)), departureAt, outage)).toBe(crossing);
    expect(JSON.stringify({ straight, detour, outage })).toBe(retained);
  });

  it('includes stationary ascent, service and descent while respecting episode and operation boundaries', () => {
    const launchInCircle = timeline([center, point(100, 0), center]);
    expect(operationRouteCommandLinkLossAt(launchInCircle, departureAt, episode(5_000, 6_000))).toBe(
      departureAt + 5_000,
    );
    const descent = launchInCircle.phases.find((phase) => phase.kind === 'descent')!;
    expect(
      operationRouteCommandLinkLossAt(launchInCircle, departureAt, episode(descent.startMs + 1, descent.endMs)),
    ).toBe(departureAt + descent.startMs + 1);
    expect(
      operationRouteCommandLinkLossAt(
        launchInCircle,
        departureAt,
        episode(launchInCircle.durationMs, launchInCircle.durationMs + 1),
      ),
    ).toBeUndefined();
    expect(operationRouteCommandLinkLossAt(launchInCircle, departureAt, episode(-10_000, 0))).toBeUndefined();

    const serviceInCircle = timeline([point(-100, 0), center, point(-100, 0)]);
    const service = serviceInCircle.phases.find((phase) => phase.kind === 'service')!;
    const serviceOutage = episode(service.startMs + 1, service.endMs, { radiusMeters: 0 });
    expect(operationRouteCommandLinkLossAt(serviceInCircle, departureAt, serviceOutage)).toBe(
      departureAt + service.startMs + 1,
    );
    const crossing = operationRouteCommandLinkLossAt(serviceInCircle, departureAt, episode())!;
    expect(
      operationRouteCommandLinkLossAt(serviceInCircle, departureAt, episode(0, crossing - departureAt)),
    ).toBeUndefined();
    expect(
      operationRouteCommandLinkLossAt(serviceInCircle, departureAt, episode(crossing - departureAt, 300_000)),
    ).toBe(crossing);
  });

  it('does not invent contact from submillisecond crossings, numerical collapse or invalid clocks and phases', () => {
    const tiny = Number.MIN_VALUE;
    const submillisecond = timeline(
      [
        { longitude: -tiny, latitude: 0 },
        { longitude: tiny, latitude: 0 },
        { longitude: -tiny, latitude: 0 },
      ],
      1,
      Number.MAX_VALUE,
    );
    expect(
      submillisecond.phases.filter((phase) => phase.kind === 'travel').map((phase) => phase.endMs - phase.startMs),
    ).toEqual([1, 1]);
    expect(
      operationRouteCommandLinkLossAt(submillisecond, departureAt, episode(0, 300_000, { radiusMeters: 0 })),
    ).toBeUndefined();
    const miss = timeline([
      { longitude: -0.001, latitude: tiny },
      { longitude: 0.001, latitude: tiny },
      { longitude: -0.001, latitude: tiny },
    ]);
    expect(
      operationRouteCommandLinkLossAt(miss, departureAt, episode(0, 300_000, { radiusMeters: 0 })),
    ).toBeUndefined();

    const collapse = timeline([
      { longitude: -tiny, latitude: 90 },
      { longitude: tiny, latitude: 90 },
      { longitude: -tiny, latitude: 90 },
    ]);
    expect(collapse.phases.some((phase) => phase.kind === 'travel' && phase.distanceMeters === 0)).toBe(true);
    expect(() =>
      operationRouteCommandLinkLossAt(
        collapse,
        departureAt,
        episode(20_001, 30_000, { center: { longitude: 0, latitude: 90 }, radiusMeters: 0 }),
      ),
    ).toThrow('Invalid route command-link');

    const valid = timeline([center, point(100, 0), center]);
    const badPhase = structuredClone(valid);
    badPhase.phases.at(-1)!.distanceMeters = Number.NaN;
    expect(() => operationRouteCommandLinkLossAt(badPhase, departureAt, episode())).toThrow(
      'Invalid route command-link',
    );
    for (const invalid of [
      () => operationRouteCommandLinkLossAt(valid, Number.NaN, episode()),
      () => operationRouteCommandLinkLossAt(valid, 8_640_000_000_000_000, episode()),
      () => operationRouteCommandLinkLossAt(valid, departureAt, episode(0, 0)),
      () =>
        operationRouteCommandLinkLossAt(
          valid,
          departureAt,
          episode(0, 300_000, { radiusMeters: Number.POSITIVE_INFINITY }),
        ),
      () =>
        operationRouteCommandLinkLossAt(valid, departureAt, episode(0, 300_000, { startsAt: '2026-02-30T14:00:00Z' })),
    ])
      expect(invalid).toThrow('Invalid route command-link');
  });
});
