import { canonicalize, sha256 } from '@ledger/integrity';
import type { ObservationPosition, PositionFixObservationV1 } from '@ledger/contracts';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type OriginalLocator,
  type TranslateFunction,
  type TranslationRejection,
  type TranslationResult,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';
import { type ListedItem, jsonArrayElements, jsonMemberBytes } from './source-transports.js';

/**
 * Skydio Cloud flights and their recorded telemetry, read from the service's REST interface on a schedule.
 *
 * NOT RUN AGAINST THE REAL SERVICE. Nobody on the project has an account. Everything here is built from the
 * published API reference (apidocs.skydio.com, read on 2026-11-28) and run against the emulator in
 * apps/emulators/src/skydio.ts only, which was written from the same pages. Test it against your own account before
 * operational use; docs/guides/deploy.md lists what to compare. Only fields the reference describes are read. Where
 * it is silent on a unit, a datum or a zone, the value is left out rather than guessed.
 *
 * One flight object of the list (GET /v0/flights) becomes one flight.report; a flight the service later lists
 * differently replaces its earlier report. The data part of a flight's telemetry answer (GET
 * /v1/flight/{flight_id}/telemetry), read once the list says telemetry has been uploaded, becomes position.fix
 * observations. Webhooks exist in the service and are not used: Ledger would have to be reachable from it.
 */
export const skydioCloudFlightsDescriptor: AdapterDescriptor = {
  id: 'skydio-cloud-flights',
  version: '1.0.0',
  source: {
    vendor: 'Skydio',
    product: 'Skydio Cloud API',
    interface:
      'HTTPS GET /api/v0/flights, one flight object of data.flights per message; then GET /api/v1/flight/{flight_id}/telemetry once has_telemetry is true, the data member of the answer per message',
  },
  produces: [
    { type: 'flight.report', version: 1 },
    { type: 'position.fix', version: 1 },
  ],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from the service’s published interface reference only. It has not been run against the service: nobody on the project has an account. Test it against your own account before operational use.',
    'A flight report states what the service listed for the flight when it was read: its takeoff and landing times and the aircraft’s serial number as the service gives it. A flight listed with a takeoff and no landing is reported with its takeoff only; that does not say the aircraft is in the air.',
    'occurredAt of a flight report is the latest time the flight states, its landing or else its takeoff: the service gives no time for the statement itself.',
    'A flight the service later lists differently replaces its earlier report as a correction; the earlier report stays on file as replaced.',
    'The position of a flight report is the takeoff place the service lists, which the reference says is filled in once the flight’s telemetry has been uploaded. The service lists no landing place.',
    'Times are read as the reference describes them: a date and time, in UTC when it carries no zone, to at most a microsecond, cut to the millisecond.',
    'Positions are read from the flight’s recorded telemetry once the service says it has been uploaded, which can be long after the flight. Each is the aircraft’s satellite-based latitude and longitude at the sample’s time, on the aircraft’s own clock. The reference names no datum for them; they are carried as WGS84, the datum of the satellite system it names.',
    'The height of a position is the sample’s height above the takeoff point in meters, which the reference describes as estimated from the aircraft’s visual and barometric systems. It is not a height above the ground under the aircraft. A sample without it carries the satellite-based altitude above sea level instead, with the vertical accuracy the receiver estimated; the reference names no sea-level model.',
    'Ground speed is computed from the north and east parts of the satellite-based velocity, which the reference gives in meters per second. The down part, the second altitude estimate, attitude, camera and battery values are not read; they stay in the retained original.',
    'No fix quality is reported. The count of satellites used and the receiver’s horizontal accuracy estimate are carried when the sample gives them.',
    'At most 240 positions are carried for a flight. A flight with more is thinned to the first in each of equal periods, its last, its highest and its fastest, and each of its positions says so. The path between two positions is not recorded, and a gap does not show that anything was lost.',
    'The reference describes a sample’s time both as a date and time and as a count of microseconds; only a date and time is read, and a sample whose time is anything else is not carried.',
    'The retained original is the flight’s own object cut from the service’s list, or the data part of its telemetry answer, exactly as sent. The rest of each answer (its status, error code and the time of the answer) is not kept.',
    'The service is asked on a schedule for the flights that took off within a look-back period. A flight that changes, or whose telemetry is uploaded, after it has left that period is not read again.',
  ],
  documentation: [
    {
      reference:
        'Skydio Cloud API reference, Get Flights (apidocs.skydio.com/reference/flights_get_v0_flights.md, OpenAPI 3.1.0 definition, API version 0.0.1), read 2026-11-28: the query parameters, the Flight object and Pagination.',
      sha256: '09d88163c425315846434b1fd8ea39726c33a78bc11d4f0a8580a6acaf74077e',
    },
    {
      reference:
        'Skydio Cloud API reference, Get Telemetry for Flight, version 1 (apidocs.skydio.com/reference/telemetry_get_v1_flight_flight_id_telemetry.md), read 2026-11-28: aligned_telemetry and the unit each field’s description states.',
      sha256: '31c1c22ea4a93ef137b70ced86b2c3207b5c76840d73686feaa3edc640c5bd47',
    },
    {
      reference:
        'Skydio Cloud API reference, Introduction (apidocs.skydio.com/reference/introduction.md), read 2026-11-28: the response fields, the HTTP errors with Retry-After on 429, and the timestamp formats.',
      sha256: '258974022c2ec12aff249cada662327d3b84ada04a76e04e0100e05a829c306c',
    },
    {
      reference:
        'Skydio Cloud API reference, Authentication (apidocs.skydio.com/reference/authentication.md), read 2026-11-28: the API token as the whole value of the Authorization header, and the Flights and Flight Telemetry read scopes.',
      sha256: 'c917b90325dedf17c4a5c7ff77f7667b35bb2059e413f4c7af59bbac29de3e0e',
    },
  ],
};

/** The sentence the adapter process prints first when it starts. */
export const SKYDIO_CLOUD_START_NOTICE =
  'This adapter was built from the service’s published API reference and has NOT been run against the real service: test it against your own account before operational use. docs/guides/deploy.md lists what to compare.';

/** Ledger keeps one original of at most 10 MiB; a telemetry answer larger than that cannot be retained whole. */
export const SKYDIO_TELEMETRY_MAX_BYTES = 10 * 1024 * 1024;
const FLIGHT_MAX_BYTES = 256 * 1024;
/** A rule reads at most 500 positions in a flight's window; two flights of one aircraft still fit under it. */
export const SKYDIO_MAX_POSITIONS_PER_FLIGHT = 240;
const FLIGHTS_PER_PAGE = 100;
const FLIGHTS_PATH = '/api/v0/flights';
const TELEMETRY_PATH = /\/api\/v1\/flight\/([^/]+)\/telemetry$/;
const MAX_ID_LENGTH = 200;

const flightKeys = ['flight_id', 'vehicle_serial', 'takeoff', 'landing', 'takeoff_latitude', 'takeoff_longitude'];
const telemetryKeys = ['flight', 'flight_telemetry'];
const telemetryFlightKeys = ['flight_id', 'vehicle_serial'];
const sampleKeys = [
  'timestamp',
  'gps_latitude',
  'gps_longitude',
  'gps_altitude',
  'gps_horizontal_accuracy',
  'gps_vertical_accuracy',
  'gps_num_satellites_used',
  'gps_velocity',
  'height_above_takeoff',
];

class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);

// The formats the reference lists: YYYY-MM-DDThh:mm:ss, optionally with one to six fractional digits, optionally
// followed by Z or an offset in hours and minutes. Without a zone the time is UTC.
const SERVICE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/;

/** A time of the service as a UTC instant cut to the millisecond, or undefined when it is not one of its formats. */
export function skydioTime(value: unknown): string | undefined {
  const match = typeof value === 'string' ? SERVICE_TIME.exec(value) : null;
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = '', zone = 'Z'] = match;
  // A day the month does not have is refused rather than rolled into the next month.
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || year === '0000') return undefined;
  const instant = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.slice(0, 3).padEnd(3, '0')}${zone}`,
  );
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

const number = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

/** An id that fits Ledger's 200 characters: the service's own when it fits, else its digest. */
const bounded = (id: string, room: number): string => (id.length <= room ? id : `sha256-${sha256(id).slice(0, 32)}`);

function identifier(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH || value !== value.trim())
    throw new Refusal(`${key} must be an id of 1 to ${MAX_ID_LENGTH} characters`);
  return value;
}

function optionalTime(body: Record<string, unknown>, key: string): string | undefined {
  if (!has(body, key)) return undefined;
  const time = skydioTime(body[key]);
  if (!time) throw new Refusal(`${key} is not a date and time in one of the formats the service’s reference lists`);
  return time;
}

/** The takeoff place, when the flight lists one; a place that cannot be read is left out and said. */
function takeoffPlace(body: Record<string, unknown>): { position?: ObservationPosition; notRead?: string } {
  if (!has(body, 'takeoff_latitude') && !has(body, 'takeoff_longitude')) return {};
  const { takeoff_latitude: latitude, takeoff_longitude: longitude } = body;
  if (!number(latitude, -90, 90) || !number(longitude, -180, 180))
    return {
      notRead:
        'takeoff_latitude and takeoff_longitude are not both degrees of latitude and longitude; the flight is reported without its takeoff place',
    };
  // The reference gives the takeoff place as plain numbers beside the telemetry's degrees: carried as they are.
  return { position: { latitudeDegrees: latitude, longitudeDegrees: longitude } };
}

function translateFlight(bytes: Uint8Array, context: Parameters<TranslateFunction>[1]): TranslationResult {
  const decoded = decodeStrictJson(bytes, FLIGHT_MAX_BYTES);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`);
  const body = decoded.value;
  if (!isRecord(body)) throw new Refusal('The message must be one flight object of the service’s list');
  const flightId = identifier(body, 'flight_id');
  const vehicleSerial = identifier(body, 'vehicle_serial');
  const takeoffAt = optionalTime(body, 'takeoff');
  const landingAt = optionalTime(body, 'landing');
  if (!takeoffAt && !landingAt) throw new Refusal(`Flight ${flightId} states neither a takeoff nor a landing`);
  if (takeoffAt && landingAt && Date.parse(landingAt) < Date.parse(takeoffAt))
    throw new Refusal(`Flight ${flightId} states a landing before its takeoff`);
  const subject = subjectFor(context.subjects, 'flight', flightId);
  const aircraft = subjectFor(context.subjects, 'aircraft', vehicleSerial);
  if (!subject || !aircraft) throw new Refusal(`No Ledger subject is bound to flight ${flightId} or its aircraft`);
  const place = takeoffPlace(body);
  const stated = {
    secondarySubject: aircraft,
    ...(place.position ? { position: place.position } : {}),
    values: {
      // A landing time says the flight landed. Without one the service says nothing about where the aircraft is.
      ...(landingAt ? { activity: 'landed' as const } : {}),
      ...(takeoffAt ? { takeoffAt } : {}),
      ...(landingAt ? { landingAt } : {}),
    },
  };
  const draft: ObservationDraft = {
    type: 'flight.report',
    version: 1,
    subject,
    ...stated,
    occurredAt: (landingAt ?? takeoffAt)!,
    // Changes exactly when what the report states changes: the same statement read again is the same event.
    sourceEventId: `flight:${bounded(flightId, 120)}:${sha256(canonicalize(stated)).slice(0, 32)}`,
  };
  return {
    drafts: [draft],
    rejections: place.notRead ? [{ reason: place.notRead, locator: jsonPointer('takeoff_latitude') }] : [],
    unmapped: unknownKeys(body, flightKeys),
  };
}

type PositionValues = {
  -readonly [Key in keyof PositionFixObservationV1['values']]: PositionFixObservationV1['values'][Key];
};

interface Sample {
  readonly index: number;
  readonly occurredAt: string;
  readonly time: number;
  readonly position: ObservationPosition;
  readonly values: PositionValues;
  readonly unmapped: readonly OriginalLocator[];
}

const samplePath = ['flight_telemetry', 'aligned_telemetry'] as const;

/** Counts, by reason, what was left out of a telemetry answer, so one sentence stands for thousands of samples. */
class LeftOut {
  private readonly reasons = new Map<string, { count: number; first: number }>();
  add(reason: string, index: number): void {
    const entry = this.reasons.get(reason);
    if (entry) entry.count++;
    else this.reasons.set(reason, { count: 1, first: index });
  }
  rejections(): TranslationRejection[] {
    return [...this.reasons].map(([reason, { count, first }]) => ({
      reason: `${count} sample(s): ${reason}`,
      locator: jsonPointer(...samplePath, first),
    }));
  }
}

/** The height a sample states, with the datum the reference states for it. */
function sampleAltitude(sample: Record<string, unknown>, index: number, leftOut: LeftOut) {
  const { height_above_takeoff: aboveTakeoff, gps_altitude: aboveSeaLevel } = sample;
  // Both are documented in meters: the conversion is the identity.
  if (number(aboveTakeoff, -10_000, 100_000)) return { meters: aboveTakeoff, datum: 'takeoff_point' as const };
  if (has(sample, 'height_above_takeoff'))
    leftOut.add('height_above_takeoff is not a height in meters and is left out', index);
  if (number(aboveSeaLevel, -10_000, 100_000)) return { meters: aboveSeaLevel, datum: 'mean_sea_level' as const };
  if (has(sample, 'gps_altitude')) leftOut.add('gps_altitude is not an altitude in meters and is left out', index);
  return undefined;
}

function readSample(value: unknown, index: number, leftOut: LeftOut): Sample | undefined {
  if (!isRecord(value)) {
    leftOut.add('the sample is not an object and is not carried', index);
    return undefined;
  }
  const occurredAt = skydioTime(value.timestamp);
  if (!occurredAt) {
    leftOut.add('timestamp is not a date and time in a format the reference lists; the sample is not carried', index);
    return undefined;
  }
  const { gps_latitude: latitude, gps_longitude: longitude } = value;
  if (!has(value, 'gps_latitude') && !has(value, 'gps_longitude')) {
    leftOut.add('no gps_latitude and gps_longitude; the sample is not carried', index);
    return undefined;
  }
  if (!number(latitude, -90, 90) || !number(longitude, -180, 180)) {
    leftOut.add('gps_latitude and gps_longitude are not both degrees; the sample is not carried', index);
    return undefined;
  }
  const altitude = sampleAltitude(value, index, leftOut);
  const values: PositionValues = { fix: 'unknown', method: 'satellite' };
  const optional = (key: string, read: (given: unknown) => boolean) => {
    if (!has(value, key)) return false;
    if (read(value[key])) return true;
    leftOut.add(`${key} is not a value the reference describes and is left out`, index);
    return false;
  };
  if (optional('gps_num_satellites_used', (given) => Number.isInteger(given) && number(given, 0, 200)))
    values.satelliteCount = value.gps_num_satellites_used as number;
  if (optional('gps_horizontal_accuracy', (given) => number(given, 0, 100_000)))
    values.horizontalAccuracyMeters = value.gps_horizontal_accuracy as number;
  // The receiver's vertical estimate describes its own altitude, not the height above the takeoff point.
  if (optional('gps_vertical_accuracy', (given) => number(given, 0, 100_000)) && altitude?.datum === 'mean_sea_level')
    values.verticalAccuracyMeters = value.gps_vertical_accuracy as number;
  const velocity = value.gps_velocity as number[];
  const threeSpeeds = (given: unknown) =>
    Array.isArray(given) &&
    given.length === 3 &&
    given.every((part) => number(part, -500, 500)) &&
    Math.hypot(given[0] as number, given[1] as number) <= 500;
  // North and east in meters per second: the speed over the ground is the length of the two.
  if (optional('gps_velocity', threeSpeeds)) values.groundSpeedMetersPerSecond = Math.hypot(velocity[0]!, velocity[1]!);
  return {
    index,
    occurredAt,
    time: Date.parse(occurredAt),
    position: { latitudeDegrees: latitude, longitudeDegrees: longitude, ...(altitude ? { altitude } : {}) },
    values,
    unmapped: unknownKeys(value, sampleKeys, ...samplePath, index),
  };
}

/** The greatest of a measure among samples; the earliest of equals. */
function greatest(samples: readonly Sample[], measure: (sample: Sample) => number | undefined): Sample | undefined {
  let best: Sample | undefined;
  for (const sample of samples) {
    const value = measure(sample);
    if (value !== undefined && (best === undefined || value > measure(best)!)) best = sample;
  }
  return best;
}

/**
 * The positions carried for a flight: all of them up to the limit; beyond it the first in each of equal periods of
 * whole seconds, the last, the highest and the fastest. Returns the period, in seconds, when it thinned.
 */
export function thinSamples<S extends { time: number }>(
  samples: readonly S[],
  limit: number,
  extremes: readonly (S | undefined)[],
): { kept: S[]; periodSeconds?: number } {
  if (samples.length <= limit) return { kept: [...samples] };
  const first = samples[0]!.time;
  const duration = samples.at(-1)!.time - first;
  const periods = Math.max(1, limit - 2 - extremes.length);
  const periodSeconds = Math.max(1, Math.ceil(duration / 1000 / periods));
  const kept = new Set<S>([samples.at(-1)!, ...extremes.filter((sample): sample is S => sample !== undefined)]);
  let period = -1;
  for (const sample of samples) {
    const at = Math.floor((sample.time - first) / (periodSeconds * 1000));
    if (at !== period) kept.add(sample);
    period = at;
  }
  return { kept: samples.filter((sample) => kept.has(sample)), periodSeconds };
}

function translateTelemetry(
  bytes: Uint8Array,
  pathFlightId: string,
  context: Parameters<TranslateFunction>[1],
): TranslationResult {
  if (bytes.byteLength > SKYDIO_TELEMETRY_MAX_BYTES)
    throw new Refusal(
      `The telemetry of flight ${pathFlightId} is ${bytes.byteLength} bytes, more than the ${SKYDIO_TELEMETRY_MAX_BYTES} Ledger keeps as one original; none of it is read`,
    );
  const decoded = decodeStrictJson(bytes, SKYDIO_TELEMETRY_MAX_BYTES);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`);
  const body = decoded.value;
  if (!isRecord(body) || !isRecord(body.flight_telemetry))
    throw new Refusal('The message must be the data part of a telemetry answer, with its flight_telemetry');
  if (!isRecord(body.flight))
    throw new Refusal('The telemetry answer does not name its flight, so the aircraft is not known');
  const flightId = identifier(body.flight, 'flight_id');
  if (flightId !== pathFlightId)
    throw new Refusal(`The telemetry names flight ${flightId}, not the flight it was asked for`);
  const vehicleSerial = identifier(body.flight, 'vehicle_serial');
  const listed = body.flight_telemetry.aligned_telemetry;
  if (!Array.isArray(listed)) throw new Refusal('aligned_telemetry must be a list of samples');
  const subject = subjectFor(context.subjects, 'aircraft', vehicleSerial);
  const flight = subjectFor(context.subjects, 'flight', flightId);
  if (!subject || !flight) throw new Refusal(`No Ledger subject is bound to flight ${flightId} or its aircraft`);

  const leftOut = new LeftOut();
  const read: Sample[] = [];
  const notCarried: OriginalLocator[] = [];
  const times = new Set<number>();
  for (const [index, value] of listed.entries()) {
    const sample = readSample(value, index, leftOut);
    if (sample && times.has(sample.time))
      leftOut.add('the same time, to the millisecond, as an earlier sample; the sample is not carried', index);
    if (!sample || times.has(sample.time)) {
      notCarried.push(jsonPointer(...samplePath, index));
      continue;
    }
    times.add(sample.time);
    read.push(sample);
  }
  if (!read.length) {
    const reasons = leftOut.rejections();
    throw new Refusal(
      listed.length
        ? `No sample of flight ${flightId} states a position: ${reasons.map((entry) => entry.reason).join('; ')}`
        : `The telemetry of flight ${flightId} holds no samples`,
    );
  }
  const inOrder = [...read].sort((a, b) => a.time - b.time);
  const { kept, periodSeconds } = thinSamples(inOrder, SKYDIO_MAX_POSITIONS_PER_FLIGHT, [
    greatest(inOrder, (sample) => sample.position.altitude?.meters),
    greatest(inOrder, (sample) => sample.values.groundSpeedMetersPerSecond),
  ]);
  const carried = new Set(kept);
  const thinned =
    periodSeconds === undefined
      ? []
      : [
          `This flight’s telemetry held ${read.length} positions; ${kept.length} are carried: the first in each ${periodSeconds} s, the last, the highest and the fastest.`,
        ];
  const drafts: ObservationDraft[] = kept.map((sample) => ({
    type: 'position.fix',
    version: 1,
    subject,
    secondarySubject: flight,
    occurredAt: sample.occurredAt,
    sourceEventId: `flight:${bounded(flightId, 120)}:position:${sample.occurredAt}`,
    position: sample.position,
    originalLocator: jsonPointer(...samplePath, sample.index),
    values: sample.values,
    ...(thinned.length ? { extraLimitations: thinned } : {}),
  }));
  return {
    drafts,
    rejections: leftOut.rejections(),
    unmapped: [
      ...unknownKeys(body, telemetryKeys),
      ...unknownKeys(body.flight, telemetryFlightKeys, 'flight'),
      ...unknownKeys(body.flight_telemetry, ['aligned_telemetry'], 'flight_telemetry'),
      ...read.flatMap((sample) => (carried.has(sample) ? sample.unmapped : [jsonPointer(...samplePath, sample.index)])),
      ...notCarried,
    ],
  };
}

export const translateSkydioCloudFlights: TranslateFunction = (message, context) => {
  try {
    const path = message.transport.path ?? '';
    const telemetry = TELEMETRY_PATH.exec(path);
    if (telemetry) return translateTelemetry(message.bytes, decodeURIComponent(telemetry[1]!), context);
    if (path.endsWith(FLIGHTS_PATH)) return translateFlight(message.bytes, context);
    return rejected(`The message was read at ${path || 'no path'}, which is not a path this adapter reads`);
  } catch (error) {
    if (error instanceof Refusal) return rejected(error.message);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const skydioCloudFlightsAdapter: ObservationAdapter = {
  descriptor: skydioCloudFlightsDescriptor,
  translate: translateSkydioCloudFlights,
};

// Reading the service's list -------------------------------------------------------------------------------------

/** The path and query that list the flights that took off since a time, a page at a time. */
export function skydioFlightsPath(since: Date): string {
  // The reference lists YYYY-MM-DDThh:mm:ssZ among the formats the service accepts.
  const time = `${since.toISOString().slice(0, 19)}Z`;
  return `${FLIGHTS_PATH}?takeoff_since=${encodeURIComponent(time)}&per_page=${FLIGHTS_PER_PAGE}&page_number=1`;
}

/** Each flight object of one page of the list, as its own exact bytes; undefined when the page is not a list. */
export function skydioFlightParts(bytes: Uint8Array): Uint8Array[] | undefined {
  const flights = jsonMemberBytes(bytes, ['data', 'flights']);
  return flights && jsonArrayElements(flights);
}

function flightOf(part: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(part));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a flight object is known by between two reads of the list: the fields a flight report is made from. A flight
 * that changed only in a field no observation carries (has_telemetry turning true) is not handed over again.
 */
export function skydioFlightKey(part: Uint8Array): string {
  const flight = flightOf(part);
  if (!flight) return sha256(part);
  return sha256(canonicalize(Object.fromEntries(flightKeys.map((key) => [key, flight[key] ?? null]))));
}

/** The telemetry to read: one item for each flight of a page that says its telemetry has been uploaded. */
export function skydioTelemetryItems(bytes: Uint8Array): ListedItem[] | undefined {
  const parts = skydioFlightParts(bytes);
  if (!parts) return undefined;
  return parts.flatMap((part) => {
    const flight = flightOf(part);
    const id = flight?.flight_id;
    return flight?.has_telemetry === true && typeof id === 'string' && id
      ? // The reference documents 404 for this path: the upload may not have finished when the list said it had.
        [{ path: `/api/v1/flight/${encodeURIComponent(id)}/telemetry`, key: id, mayBeAbsent: true }]
      : [];
  });
}

/** The data member of a telemetry answer, as its own exact bytes: the answer without its status and time. */
export function skydioTelemetryPart(bytes: Uint8Array): Uint8Array | undefined {
  return jsonMemberBytes(bytes, ['data']);
}

/** The next page of the list, from the page count the service states; undefined at the last page. */
export function skydioNextFlightsPage(bytes: Uint8Array, url: string): string | undefined {
  let total: unknown;
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      data?: { pagination?: { total_pages?: unknown } };
    };
    total = body.data?.pagination?.total_pages;
  } catch {
    return undefined;
  }
  const at = new URL(url);
  const page = Number(at.searchParams.get('page_number') ?? '1');
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(page) || page >= (total as number)) return undefined;
  at.searchParams.set('page_number', String(page + 1));
  return `${at.pathname}${at.search}`;
}

/** How the adapter process reads the service: the list a page at a time, each flight a part, telemetry followed. */
export const skydioCloudFlightsPoll = {
  path: skydioFlightsPath,
  split: skydioFlightParts,
  partKey: skydioFlightKey,
  follow: skydioTelemetryItems,
  followedPart: skydioTelemetryPart,
  nextPage: skydioNextFlightsPage,
  /** The whole telemetry answer, a little larger than its data part. */
  maxBytes: SKYDIO_TELEMETRY_MAX_BYTES + 64 * 1024,
} as const;
