import type { OperationMissionSource } from './operation-mission.js';

function keys(value: unknown, expected: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => expected.includes(key) || optional.includes(key)) &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function planning(value: unknown, source: Record<string, unknown>): boolean {
  if (
    !keys(value, [
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
    !boundedNumber(value.cruiseMetersPerSecond, Number.MIN_VALUE, 100) ||
    !Array.isArray(value.requiredLocations) ||
    value.requiredLocations.length < 3 ||
    value.requiredLocations.length > 32 ||
    !interval(value.customerInterval) ||
    !interval(value.resourceInterval)
  )
    return false;
  for (const name of ['ascentMs', 'serviceMs', 'descentMs', 'holdAllowanceMs', 'handoffAllowanceMs', 'marginMs']) {
    const duration = value[name];
    if (
      !boundedNumber(duration, name === 'marginMs' ? 1 : 0, name === 'marginMs' ? 3_600_000 : 86_400_000) ||
      !Number.isSafeInteger(duration)
    )
      return false;
  }
  const locations = value.requiredLocations;
  const coordinates = (source.route as OperationMissionSource['route']).geometry.coordinates;
  let nextIndex = 0;
  for (const [locationIndex, location] of locations.entries()) {
    if (
      !keys(location, ['role', 'position']) ||
      location.role !==
        (locationIndex === 0 ? 'launch' : locationIndex === locations.length - 1 ? 'return' : 'service') ||
      !Array.isArray(location.position) ||
      location.position.length !== 2 ||
      !boundedNumber(location.position[0], -180, 180) ||
      !boundedNumber(location.position[1], -90, 90)
    )
      return false;
    const position = location.position;
    const index =
      location === locations.at(-1)
        ? coordinates.length - 1
        : coordinates.findIndex(
            (point, index) => index >= nextIndex && point[0] === position[0] && point[1] === position[1],
          );
    if (
      index < nextIndex ||
      (locationIndex === 0 && index !== 0) ||
      coordinates[index]?.[0] !== position[0] ||
      coordinates[index]?.[1] !== position[1]
    )
      return false;
    nextIndex = index;
  }
  const operating = source.operatingInterval as OperationMissionSource['operatingInterval'];
  return [value.customerInterval, value.resourceInterval].every(
    (bounds) =>
      Date.parse(bounds.start) <= Date.parse(operating.start) && Date.parse(bounds.end) >= Date.parse(operating.end),
  );
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function route(value: unknown): value is OperationMissionSource['route'] {
  return (
    keys(value, ['coordinateReference', 'coordinateOrder', 'segmentInterpolation', 'geometry']) &&
    value.coordinateReference === 'WGS84' &&
    value.coordinateOrder === 'longitude_latitude' &&
    value.segmentInterpolation === 'linear_longitude_latitude' &&
    keys(value.geometry, ['type', 'coordinates']) &&
    value.geometry.type === 'LineString' &&
    Array.isArray(value.geometry.coordinates) &&
    value.geometry.coordinates.length >= 2 &&
    value.geometry.coordinates.length <= 256 &&
    Array.from(value.geometry.coordinates).every(
      (position: unknown) =>
        Array.isArray(position) &&
        position.length === 2 &&
        boundedNumber(position[0], -180, 180) &&
        boundedNumber(position[1], -90, 90),
    )
  );
}

function altitude(value: unknown): value is OperationMissionSource['altitude'] {
  return (
    keys(value, ['minimum', 'maximum', 'unit', 'reference']) &&
    value.unit === 'm' &&
    value.reference === 'AGL' &&
    boundedNumber(value.minimum, 0, 10000) &&
    boundedNumber(value.maximum, 0, 10000) &&
    value.minimum <= value.maximum
  );
}

function interval(value: unknown): value is OperationMissionSource['operatingInterval'] {
  return (
    keys(value, ['start', 'end']) &&
    utc(value.start) &&
    utc(value.end) &&
    Date.parse(value.start) < Date.parse(value.end)
  );
}

export function validateOperationMissionSource(value: unknown): asserts value is OperationMissionSource {
  if (
    !keys(
      value,
      [
        'sourceRevision',
        'occurredAt',
        'sourceMissionId',
        'aircraftId',
        'route',
        'lateralToleranceMeters',
        'altitude',
        'operatingInterval',
      ],
      ['routePlanning'],
    ) ||
    !boundedNumber(value.sourceRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(value.sourceRevision) ||
    !utc(value.occurredAt) ||
    !id(value.sourceMissionId) ||
    !id(value.aircraftId) ||
    !route(value.route) ||
    !boundedNumber(value.lateralToleranceMeters, 0, 1000) ||
    !altitude(value.altitude) ||
    !interval(value.operatingInterval) ||
    (value.routePlanning !== undefined && !planning(value.routePlanning, value))
  )
    throw new Error('Mission plan must match the bounded planned-geometry source contract');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024)
    throw new Error('Mission plan exceeds its 64 KiB source bound');
}
