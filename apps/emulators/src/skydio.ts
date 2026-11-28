/**
 * A stand-in for the flights and telemetry part of the Skydio Cloud REST interface, with invented flights.
 *
 * NOT RECORDED FROM THE REAL SERVICE. Nobody on the project has an account. Every shape here is written from the
 * published API reference (apidocs.skydio.com, read on 2026-11-28): the response fields (data, meta,
 * skydio_error_code, status_code, error_message), the Flight object, Pagination, the aligned_telemetry sample and
 * its units, the Authorization header holding the token itself, 401 for a token it does not know, 404 for a flight
 * or telemetry it does not hold, and 429 with Retry-After. Where the reference says nothing the emulator has to pick
 * something, and each pick is invented, not observed:
 * - the order of the list (newest takeoff first);
 * - `total_pages` 0 for an empty list;
 * - `data` as an empty object, and the words of `error_message`, in an error answer;
 * - which documented error code goes with which refusal (3300 for the token, 4400 for an unknown flight, 4700 for
 *   telemetry not uploaded, 5100 for a parameter it cannot read, 1429 for the rate limit);
 * - `metadata` in a telemetry answer, which the reference requires and does not describe: an empty object;
 * - one sample a second, and every value in a sample;
 * - a flight without a landing while it is in the air.
 * The adapter in packages/adapters/src/skydio-cloud-flights.ts reads none of these picks as fact.
 */

export interface SkydioEmulatedFlight {
  readonly flightId: string;
  readonly vehicleSerial: string;
  readonly batterySerial?: string;
  readonly userEmail?: string;
  /** UTC instants. Before `landing` the flight is listed without one; before `telemetryAt` without telemetry. */
  readonly takeoff: string;
  readonly landing?: string;
  readonly telemetryAt?: string;
  /** Where it takes off: degrees, and the ground's altitude above sea level in meters. */
  readonly home: { readonly latitude: number; readonly longitude: number; readonly seaLevelMeters: number };
  /** Seconds between telemetry samples. Default 1. */
  readonly sampleSeconds?: number;
}

export interface SkydioEmulatorState {
  flights: SkydioEmulatedFlight[];
  /** The next this many requests are answered 429, each with this Retry-After. */
  rateLimited: number;
  retryAfterSeconds: number;
}

export interface SkydioRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** The Authorization header exactly as sent. */
  readonly authorization?: string;
}

export interface SkydioAnswer {
  readonly status: 200 | 400 | 401 | 404 | 405 | 429;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const minutes = (base: string, offset: number): string => new Date(Date.parse(base) + offset * 60_000).toISOString();

/**
 * Three invented flights of two invented aircraft, placed around a time: one landed a day before it with its
 * telemetry uploaded, one landed hours before it whose telemetry arrives ten minutes after it, and one in the air
 * at it that lands eight minutes later.
 */
export function inventedSkydioFlights(base: string): SkydioEmulatedFlight[] {
  const home = { latitude: 44.5, longitude: -100.5, seaLevelMeters: 520 };
  return [
    {
      flightId: 'EXAMPLE-FLIGHT-0001',
      vehicleSerial: 'EXAMPLE-VEHICLE-01',
      batterySerial: 'EXAMPLE-BATTERY-01',
      userEmail: 'pilot.one@example.invalid',
      takeoff: minutes(base, -26 * 60),
      landing: minutes(base, -26 * 60 + 18),
      telemetryAt: minutes(base, -25 * 60),
      home,
    },
    {
      flightId: 'EXAMPLE-FLIGHT-0002',
      vehicleSerial: 'EXAMPLE-VEHICLE-02',
      batterySerial: 'EXAMPLE-BATTERY-02',
      userEmail: 'pilot.two@example.invalid',
      takeoff: minutes(base, -180),
      landing: minutes(base, -168),
      telemetryAt: minutes(base, 10),
      home: { ...home, latitude: 44.52 },
    },
    {
      flightId: 'EXAMPLE-FLIGHT-0003',
      vehicleSerial: 'EXAMPLE-VEHICLE-01',
      batterySerial: 'EXAMPLE-BATTERY-03',
      userEmail: 'pilot.one@example.invalid',
      takeoff: minutes(base, -4),
      landing: minutes(base, 8),
      telemetryAt: minutes(base, 20),
      home,
    },
  ];
}

export function skydioEmulatorState(base: string): SkydioEmulatorState {
  return { flights: inventedSkydioFlights(base), rateLimited: 0, retryAfterSeconds: 2 };
}

/** A time as the reference's examples write one: microseconds and a +00:00 offset. */
const serviceTime = (instant: string | number): string => `${new Date(instant).toISOString().slice(0, 23)}000+00:00`;

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The Flight object as the reference documents it, as the service would list the flight at `now`. */
export function skydioFlightObject(flight: SkydioEmulatedFlight, now: string): Record<string, unknown> {
  const at = Date.parse(now);
  const landed = flight.landing !== undefined && Date.parse(flight.landing) <= at;
  const uploaded = flight.telemetryAt !== undefined && Date.parse(flight.telemetryAt) <= at;
  return {
    ...(flight.batterySerial ? { battery_serial: flight.batterySerial } : {}),
    flight_id: flight.flightId,
    has_telemetry: uploaded,
    ...(landed ? { landing: serviceTime(flight.landing!) } : {}),
    takeoff: serviceTime(flight.takeoff),
    // "Populated if telemetry has been uploaded for this flight."
    ...(uploaded ? { takeoff_latitude: flight.home.latitude, takeoff_longitude: flight.home.longitude } : {}),
    ...(flight.userEmail ? { user_email: flight.userEmail } : {}),
    vehicle_serial: flight.vehicleSerial,
  };
}

const METERS_PER_DEGREE = 111_320;

/**
 * The aligned_telemetry samples of a landed flight, every field the reference documents, in the units it states:
 * a climb to 60 m above the takeoff point, a circle of 150 m radius at 8 m/s, and a descent. All values invented.
 */
export function skydioTelemetrySamples(flight: SkydioEmulatedFlight): Record<string, unknown>[] {
  if (!flight.landing) return [];
  const start = Date.parse(flight.takeoff);
  const duration = (Date.parse(flight.landing) - start) / 1000;
  const step = flight.sampleSeconds ?? 1;
  const [climb, cruiseHeight, radius, speed] = [Math.min(30, duration / 3), 60, 150, 8];
  const samples: Record<string, unknown>[] = [];
  for (let seconds = 0; seconds <= duration; seconds += step) {
    const descending = duration - seconds < climb;
    const height = descending
      ? (cruiseHeight * (duration - seconds)) / climb
      : Math.min(cruiseHeight, (cruiseHeight * seconds) / climb);
    const cruising = seconds >= climb && !descending;
    const angle = (Math.max(0, Math.min(seconds, duration - climb) - climb) * speed) / radius;
    const [east, north] = [radius * Math.sin(angle), radius * (1 - Math.cos(angle))];
    const [eastSpeed, northSpeed] = cruising ? [speed * Math.cos(angle), speed * Math.sin(angle)] : [0, 0];
    const downSpeed = cruising ? 0 : ((descending ? 1 : -1) * cruiseHeight) / climb;
    const yaw = round(((Math.atan2(eastSpeed, northSpeed) * 180) / Math.PI + 360) % 360, 2);
    const latitude = flight.home.latitude + north / METERS_PER_DEGREE;
    samples.push({
      battery_percentage: round(1 - (0.55 * seconds) / Math.max(duration, 1), 4),
      gps_altitude: round(flight.home.seaLevelMeters + height, 2),
      gps_horizontal_accuracy: 0.8,
      gps_latitude: round(latitude, 7),
      gps_longitude: round(
        flight.home.longitude + east / (METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180)),
        7,
      ),
      gps_num_satellites_used: 14,
      gps_speed_accuracy: 0.3,
      gps_velocity: [round(northSpeed, 3), round(eastSpeed, 3), round(downSpeed, 3)],
      gps_vertical_accuracy: 1.2,
      height_above_takeoff: round(height, 2),
      hybrid_altitude: round(flight.home.seaLevelMeters + height + 0.4, 2),
      hybrid_camera_orientation_rpy_ned: [0, -10, yaw],
      site_camera_orientation_quat_enu: [0, 0, 0, 1],
      site_camera_orientation_rpy_enu: [0, -10, yaw],
      site_camera_position_enu: [round(east, 2), round(north, 2), round(height, 2)],
      site_orientation_quat_enu: [0, 0, 0, 1],
      site_orientation_rpy_enu: [0, 0, yaw],
      site_position_enu: [round(east, 2), round(north, 2), round(height, 2)],
      timestamp: serviceTime(start + seconds * 1000),
    });
  }
  return samples;
}

const SERVICE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/;

/** A time parameter in one of the formats the reference lists; without a zone it is UTC. */
function parameterTime(text: string): number {
  if (!SERVICE_TIME.test(text)) return NaN;
  const cut = text.replace(/(\.\d{3})\d+/, '$1');
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(cut) ? cut : `${cut}Z`);
}

function wholeNumber(text: string | null, fallback: number, minimum: number, maximum: number): number {
  if (text === null) return fallback;
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  return value >= minimum && value <= maximum ? value : NaN;
}

const listParameters = ['vehicle_serial', 'takeoff_before', 'takeoff_since', 'per_page', 'page_number'];

/**
 * Answers GET /api/v0/flights, GET /api/v0/flight/{flight_id} and GET /api/v1/flight/{flight_id}/telemetry in the
 * shapes the reference documents, as of `now`. Undefined for any other path.
 */
export function answerSkydioRequest(
  state: SkydioEmulatorState,
  token: string,
  request: SkydioRequest,
  now: string,
): SkydioAnswer | undefined {
  const single = /^\/api\/v0\/flight\/([^/]+)$/.exec(request.path);
  const telemetry = /^\/api\/v1\/flight\/([^/]+)\/telemetry$/.exec(request.path);
  if (request.path !== '/api/v0/flights' && !single && !telemetry) return undefined;
  const meta = { time: Date.parse(now) / 1000 };
  const answer = (status: SkydioAnswer['status'], data: unknown, code = 0, message?: string, headers = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      data,
      ...(message === undefined ? {} : { error_message: message }),
      meta,
      skydio_error_code: code,
      status_code: status,
    }),
  });
  if (request.method !== 'GET') return answer(405, {}, 5000, 'Only GET is emulated');
  // The token is the whole header value: no scheme word before it.
  if (request.authorization !== token) return answer(401, {}, 3300, 'The API token is missing or not known');
  if (state.rateLimited > 0) {
    state.rateLimited--;
    return answer(429, {}, 1429, 'Too many requests', { 'retry-after': String(state.retryAfterSeconds) });
  }
  const at = Date.parse(now);
  const listed = state.flights.filter((flight) => Date.parse(flight.takeoff) <= at);
  const find = (id: string) => listed.find((flight) => flight.flightId === decodeURIComponent(id));

  if (single) {
    const flight = find(single[1]!);
    return flight
      ? answer(200, { flight: skydioFlightObject(flight, now) })
      : answer(404, {}, 4400, 'Flight not found');
  }
  if (telemetry) {
    const flight = find(telemetry[1]!);
    if (!flight) return answer(404, {}, 4400, 'Flight not found');
    const described = skydioFlightObject(flight, now);
    if (!described.has_telemetry) return answer(404, {}, 4700, 'No telemetry has been uploaded for this flight');
    return answer(200, {
      flight: described,
      flight_telemetry: { aligned_telemetry: skydioTelemetrySamples(flight) },
      metadata: {},
    });
  }

  const { query } = request;
  const unknown = [...query.keys()].find((key) => !listParameters.includes(key));
  if (unknown) return answer(400, {}, 5100, `Unsupported parameter ${unknown}`);
  const perPage = wholeNumber(query.get('per_page'), 25, 1, 500);
  const pageNumber = wholeNumber(query.get('page_number'), 1, 1, Number.MAX_SAFE_INTEGER);
  const since = query.has('takeoff_since') ? parameterTime(query.get('takeoff_since')!) : -Infinity;
  const before = query.has('takeoff_before') ? parameterTime(query.get('takeoff_before')!) : Infinity;
  if ([perPage, pageNumber, since, before].some(Number.isNaN))
    return answer(400, {}, 5100, 'A parameter is not a value the reference describes');
  const vehicle = query.get('vehicle_serial');
  const matching = listed
    .filter((flight) => vehicle === null || flight.vehicleSerial === vehicle)
    .filter((flight) => Date.parse(flight.takeoff) >= since && Date.parse(flight.takeoff) < before)
    .sort((a, b) => Date.parse(b.takeoff) - Date.parse(a.takeoff) || a.flightId.localeCompare(b.flightId));
  return answer(200, {
    flights: matching
      .slice((pageNumber - 1) * perPage, pageNumber * perPage)
      .map((flight) => skydioFlightObject(flight, now)),
    pagination: {
      current_page: pageNumber,
      max_per_page: perPage,
      total_pages: Math.ceil(matching.length / perPage),
    },
  });
}

const isText = (value: unknown, maximum = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Reads the flights a demonstration or a test gives the emulator, or says why it cannot. */
export function readSkydioEmulatedFlights(value: unknown): SkydioEmulatedFlight[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Expected flights: at most 5000 flight objects');
  return value.map((entry: Partial<SkydioEmulatedFlight> | null, index) => {
    const home = entry?.home;
    if (
      !entry ||
      !isText(entry.flightId) ||
      !isText(entry.vehicleSerial) ||
      !isTime(entry.takeoff) ||
      (entry.landing !== undefined && !isTime(entry.landing)) ||
      (entry.telemetryAt !== undefined && !isTime(entry.telemetryAt)) ||
      (entry.batterySerial !== undefined && !isText(entry.batterySerial)) ||
      (entry.userEmail !== undefined && !isText(entry.userEmail)) ||
      !home ||
      ![home.latitude, home.longitude, home.seaLevelMeters].every(Number.isFinite) ||
      (entry.sampleSeconds !== undefined && !(entry.sampleSeconds >= 0.1 && entry.sampleSeconds <= 3600))
    )
      throw new Error(
        `Flight ${index} needs flightId, vehicleSerial, takeoff and home (latitude, longitude, seaLevelMeters)`,
      );
    return {
      flightId: entry.flightId,
      vehicleSerial: entry.vehicleSerial,
      ...(entry.batterySerial ? { batterySerial: entry.batterySerial } : {}),
      ...(entry.userEmail ? { userEmail: entry.userEmail } : {}),
      takeoff: new Date(entry.takeoff).toISOString(),
      ...(entry.landing ? { landing: new Date(entry.landing).toISOString() } : {}),
      ...(entry.telemetryAt ? { telemetryAt: new Date(entry.telemetryAt).toISOString() } : {}),
      home: { latitude: home.latitude, longitude: home.longitude, seaLevelMeters: home.seaLevelMeters },
      ...(entry.sampleSeconds ? { sampleSeconds: entry.sampleSeconds } : {}),
    };
  });
}
