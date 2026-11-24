// The shapes an operating area record states, as a person types them: a circle by its centre and radius, or a
// corridor by the points along its line and a half-width. The entry form, an imported file and the check that places
// positions against the area read the same bound and the same way of writing a point.

/** The largest radius of a circle and the largest half-width of a corridor, in meters: 50 km. */
export const OPERATING_AREA_SIZE_LIMIT_METERS = 50_000;
/** The most points a corridor's line may have. */
export const CORRIDOR_POINT_LIMIT = 200;

export interface StatedPoint {
  latitude: number;
  longitude: number;
}

const decimal = /^[-+]?\d{1,3}(\.\d+)?$/;

/** One point written as latitude, longitude in decimal degrees, such as "39.5012, -105.2034". */
export function parsePoint(text: string): StatedPoint | string {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== 2 || !parts.every((part) => decimal.test(part)))
    return `“${text.trim()}” is not a latitude and longitude in decimal degrees, such as 39.5012, -105.2034`;
  const [latitude, longitude] = parts.map(Number) as [number, number];
  if (Math.abs(latitude) > 90) return `${latitude} is not a latitude: it is beyond 90 degrees`;
  if (Math.abs(longitude) > 180) return `${longitude} is not a longitude: it is beyond 180 degrees`;
  return { latitude, longitude };
}

/**
 * The points of a corridor's line, in order, written as latitude, longitude pairs separated by semicolons, such as
 * "39.50, -105.20; 39.52, -105.15". A trailing semicolon is allowed.
 */
export function parsePoints(text: string): StatedPoint[] | string {
  const written = text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (written.length < 2) return 'a corridor needs at least two points, separated by semicolons';
  if (written.length > CORRIDOR_POINT_LIMIT)
    return `a corridor has at most ${CORRIDOR_POINT_LIMIT} points; this one has ${written.length}`;
  const points: StatedPoint[] = [];
  for (const [index, part] of written.entries()) {
    const point = parsePoint(part);
    if (typeof point === 'string') return `point ${index + 1}: ${point}`;
    points.push(point);
  }
  return points;
}
