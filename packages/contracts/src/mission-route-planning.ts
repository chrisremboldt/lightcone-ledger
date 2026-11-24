import { Type, type Static } from '@sinclair/typebox';

const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Interval = Type.Object({ start: Time, end: Time }, { additionalProperties: false });
const Duration = Type.Integer({ minimum: 0, maximum: 86_400_000 });
export const MissionRoutePlanningSchema = Type.Object(
  {
    version: Type.Literal('mission.route-planning.1'),
    requiredLocations: Type.Array(
      Type.Object(
        {
          role: Type.Union([Type.Literal('launch'), Type.Literal('service'), Type.Literal('return')]),
          position: Type.Tuple([
            Type.Number({ minimum: -180, maximum: 180 }),
            Type.Number({ minimum: -90, maximum: 90 }),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 3, maxItems: 32 },
    ),
    cruiseMetersPerSecond: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
    ascentMs: Duration,
    serviceMs: Duration,
    descentMs: Duration,
    holdAllowanceMs: Duration,
    handoffAllowanceMs: Duration,
    marginMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    customerInterval: Interval,
    resourceInterval: Interval,
  },
  {
    additionalProperties: false,
    description:
      'Source-reported prototype planning bounds. Required locations occur in launch/service/return order as exact route vertices. Resource interval is a modeled availability bound, not a live allocation or platform authorization.',
  },
);
export type MissionRoutePlanning = Static<typeof MissionRoutePlanningSchema>;

function object(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function interval(value: unknown): value is { start: string; end: string } {
  if (!object(value, ['start', 'end'])) return false;
  const valid = (time: unknown): time is string =>
    typeof time === 'string' &&
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(time) &&
    Number.isFinite(Date.parse(time)) &&
    new Date(time).toISOString().slice(0, 19) === time.slice(0, 19);
  return valid(value.start) && valid(value.end) && Date.parse(value.start) < Date.parse(value.end);
}

export function missionRoutePlanningReasons(
  value: unknown,
  coordinates: readonly (readonly number[])[],
  operatingInterval: { start: string; end: string },
): string[] {
  if (
    !object(value, [
      'version',
      'requiredLocations',
      'cruiseMetersPerSecond',
      'ascentMs',
      'serviceMs',
      'descentMs',
      'holdAllowanceMs',
      'handoffAllowanceMs',
      'marginMs',
      'customerInterval',
      'resourceInterval',
    ]) ||
    value.version !== 'mission.route-planning.1' ||
    !Array.isArray(value.requiredLocations) ||
    value.requiredLocations.length < 3 ||
    value.requiredLocations.length > 32 ||
    typeof value.cruiseMetersPerSecond !== 'number' ||
    !Number.isFinite(value.cruiseMetersPerSecond) ||
    value.cruiseMetersPerSecond <= 0 ||
    value.cruiseMetersPerSecond > 100 ||
    !['ascentMs', 'serviceMs', 'descentMs', 'holdAllowanceMs', 'handoffAllowanceMs', 'marginMs'].every(
      (field) =>
        typeof value[field] === 'number' &&
        Number.isSafeInteger(value[field]) &&
        value[field] >= (field === 'marginMs' ? 1 : 0) &&
        value[field] <= (field === 'marginMs' ? 3_600_000 : 86_400_000),
    ) ||
    !interval(value.customerInterval) ||
    !interval(value.resourceInterval) ||
    !interval(operatingInterval)
  )
    return ['route_planning_context_invalid'];
  const locations = value.requiredLocations;
  if (
    !locations.every(
      (location, index) =>
        object(location, ['role', 'position']) &&
        location.role === (index === 0 ? 'launch' : index === locations.length - 1 ? 'return' : 'service') &&
        Array.isArray(location.position) &&
        location.position.length === 2 &&
        location.position.every(
          (coordinate, axis) =>
            typeof coordinate === 'number' &&
            Number.isFinite(coordinate) &&
            Math.abs(coordinate) <= (axis === 0 ? 180 : 90),
        ),
    )
  )
    return ['route_planning_locations_invalid'];
  const same = (first: readonly number[] | undefined, second: readonly number[]) =>
    first?.[0] === second[0] && first?.[1] === second[1];
  const typed = locations as MissionRoutePlanning['requiredLocations'];
  if (!same(coordinates[0], typed[0]!.position) || !same(coordinates.at(-1), typed.at(-1)!.position))
    return ['route_planning_required_location_missing'];
  let previous = 0;
  for (const location of typed.slice(1, -1)) {
    const next = coordinates.findIndex((position, index) => index >= previous && same(position, location.position));
    if (next < 0) return ['route_planning_required_location_missing'];
    previous = next;
  }
  for (const bound of [value.customerInterval, value.resourceInterval]) {
    if (
      Date.parse(operatingInterval.start) < Date.parse(bound.start) ||
      Date.parse(operatingInterval.end) > Date.parse(bound.end)
    )
      return ['route_planning_interval_outside_source_bounds'];
  }
  return [];
}
