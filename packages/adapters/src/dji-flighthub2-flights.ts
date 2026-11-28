import { canonicalize, sha256 } from '@ledger/integrity';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type TranslateFunction,
  type TranslationContext,
  type TranslationRejection,
  type TranslationResult,
  type VendorMessage,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';
import { jsonArrayElements, jsonMemberBytes } from './source-transports.js';

/*
 * BUILT FROM DOCUMENTATION ONLY. Nobody on this project has a FlightHub 2 project: this adapter was written from
 * the published interface documentation and has been run against the emulator in apps/emulators only, never against
 * the real product. Test it against your own project before operational use; docs/guides/deploy.md lists what to
 * compare, and docs/design/flighthub-sources.md what the documentation states and what it does not.
 */

/** The list of a project's flight tasks, as the public cloud's documentation names its path. */
export const FLIGHTHUB2_TASK_LIST_PATH = '/openapi/v2.0/flight-task/list';
const TRACK_PATH = /^\/openapi\/v2\.0\/flight-task\/([^/]+)\/track$/;

/** The path of one flight task's track. */
export const flightHub2TrackPath = (taskUuid: string): string =>
  `/openapi/v2.0/flight-task/${encodeURIComponent(taskUuid)}/track`;

export const flightHub2PointTimeUnits = ['seconds', 'milliseconds'] as const;
export type FlightHub2PointTimeUnit = (typeof flightHub2PointTimeUnits)[number];

export interface FlightHub2FlightsBinding {
  /**
   * The unit of a track point's timestamp, which the documentation does not state. A person sets it after comparing
   * a track with the product. Absent: no position is translated.
   */
  readonly pointTimeUnit?: FlightHub2PointTimeUnit;
}

/**
 * Completed flights of one project, read from the HTTP interface: one entry of the flight task list becomes one
 * flight.report@1, and the track of a completed flight task becomes one position.fix@1 per point.
 */
export const djiFlightHub2FlightsDescriptor: AdapterDescriptor = {
  id: 'dji-flighthub2-flights',
  version: '1.0.0',
  source: {
    vendor: 'DJI',
    product: 'DJI FlightHub 2 (public cloud)',
    interface:
      'HTTPS GET /openapi/v2.0/flight-task/list, one entry of data.list per message, then GET /openapi/v2.0/flight-task/{task_uuid}/track for each completed flight task, one response per message',
  },
  produces: [
    { type: 'flight.report', version: 1 },
    { type: 'position.fix', version: 1 },
  ],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from the source’s published interface documentation only. It has not been run against the real product: test it against your own project before relying on it.',
    'A flight report is made from one entry of the source’s list of flight tasks, once the source marks the task’s flight as completed. takeoffAt and landingAt are the times the source states the task actually started executing and actually completed; its documentation does not say how these relate to the moments of takeoff and touchdown, so they may include time on the ground.',
    'The source keeps one record of a flight task and changes it. At most one report of a task from this source is current: a report whose times or status word changed replaces the one on file, which stays in its history, and a copy of the record that differs only elsewhere records nothing.',
    'activity is landed because the source marks the flight completed. The source’s own status word for the task is not carried as a value; a documented word is noted on the report, and the entry is retained. A task the source does not mark completed is not reported.',
    'occurredAt of a flight report is the completion time the source states. Times are read with the offset the source writes and cut to the millisecond.',
    'The flight is named by the source’s id for the flight task. The list entry names the dock the aircraft took off from, not the aircraft; the aircraft is named only on the positions.',
    'A position is one point of the track the source returns for a completed flight task, about the aircraft the track names, with the flight task as the secondary subject. The points are the source’s record after the flight, not messages received during it. Nothing says how often the source records one, so a gap between positions shows nothing.',
    'The documentation does not state the unit of a point’s timestamp. It is read in the unit the configuration states (seconds or milliseconds since 1970-01-01 UTC), which a person sets after comparing a track with the product; without that setting no position is recorded. A point whose time, read so, is before 2020 or more than a day after the track was fetched is left out.',
    'Coordinates are read as WGS84 degrees; the documentation does not state the reference. A point’s height is not carried: the documentation states neither its unit nor what it is measured from. It stays in the retained track.',
    'The points carry no fix quality, so fix is unknown. The track’s distance and duration are not carried: the documentation states no unit for them.',
  ],
  documentation: [
    {
      reference:
        'DJI FlightHub 2 user manual, Custom Development > OpenAPI > "Public Cloud V2.0" (fh.dji.com/user-manual/en/custom-development/open-api/public-cloud-v2.html), and the interface documentation it links to, "FlightHub 2 OpenAPI V2.0 (Public Cloud)": "Authentication Tutorial", "Flight Task Tutorial". Read 2026-11-28; not pinned by digest.',
    },
    {
      reference:
        '"FlightHub 2 OpenAPI V2.0 (Public Cloud)", Flight Task > Task Query > "Get Flight Task List" (GET /openapi/v2.0/flight-task/list), the Markdown of the page as served on 2026-11-28.',
      sha256: '131b649e54769045a7557efb2f24be0155221260807f480e36681f11e9cbb473',
    },
    {
      reference:
        '"FlightHub 2 OpenAPI V2.0 (Public Cloud)", Flight Task > Task Query > "Get Flight Task Track Information" (GET /openapi/v2.0/flight-task/{task_uuid}/track), the Markdown of the page as served on 2026-11-28.',
      sha256: 'd2810b3c7ae3da1de065184f36f51ddab959b8e52be728dd9ee4b27a56d91d98',
    },
  ],
};

const ENTRY_MAX_BYTES = 256 * 1024;
export const FLIGHTHUB2_TRACK_MAX_BYTES = 8 * 1024 * 1024;
const MAX_POINTS = 20_000;
const MAX_ID_LENGTH = 200;
const EARLIEST_POINT_MS = Date.UTC(2020, 0, 1);
const AHEAD_OF_FETCH_MS = 86_400_000;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;
/** The task statuses the documentation lists. */
const taskStatuses = [
  'waiting',
  'starting_failure',
  'executing',
  'paused',
  'terminated',
  'success',
  'suspended',
  'timeout',
  'partially_done',
  'preparing',
  'queue_for_takeoff',
];
const mappedEntryKeys = ['uuid', 'flight_status', 'run_at', 'completed_at'];
const mappedPointKeys = ['timestamp', 'latitude', 'longitude'];

class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > MAX_ID_LENGTH)
    throw new Refusal(`${field} must be an id of 1 to ${MAX_ID_LENGTH} characters`);
  return value;
}

/** A documented date-time (RFC 3339, with its offset) as a UTC instant cut to the millisecond. */
function utcTime(value: unknown, field: string): string {
  const match = typeof value === 'string' ? DATE_TIME.exec(value) : null;
  const instant = match
    ? Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? '').slice(0, 3).padEnd(3, '0')}${match[4]!.toUpperCase()}`)
    : NaN;
  if (!Number.isFinite(instant)) throw new Refusal(`${field} must be a date and time with its offset`);
  return new Date(instant).toISOString();
}

function decode(message: VendorMessage, maxBytes: number): Record<string, unknown> {
  const decoded = decodeStrictJson(message.bytes, maxBytes);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`);
  if (!isRecord(decoded.value)) throw new Refusal('The message must be one JSON object');
  return decoded.value;
}

/** One entry of the flight task list, once the source marks its flight completed, as one flight report. */
function translateTaskEntry(message: VendorMessage, context: TranslationContext<unknown>): TranslationResult {
  const entry = decode(message, ENTRY_MAX_BYTES);
  const taskUuid = identifier(entry.uuid, 'uuid');
  // Documented as text: "1: incomplete; 2: completed".
  if (entry.flight_status !== '2')
    throw new Refusal('The flight task is not marked completed (flight_status is not "2"); it is not reported');
  const takeoffAt = utcTime(entry.run_at, 'run_at');
  const landingAt = utcTime(entry.completed_at, 'completed_at');
  if (landingAt < takeoffAt) throw new Refusal('completed_at is before run_at');
  // The status is noted for people only when it is a documented word; any other stays unmapped.
  const statusNoted = typeof entry.status === 'string' && taskStatuses.includes(entry.status);
  const subject = subjectFor(context.subjects, 'flight', taskUuid);
  if (!subject) throw new Refusal(`No Ledger flight is bound to the flight task ${taskUuid}`);
  const draft: ObservationDraft = {
    type: 'flight.report',
    version: 1,
    subject,
    occurredAt: landingAt,
    // The source gives a completion no id of its own: the id is the task and a digest of what the report states, so
    // it changes exactly when the statement does. A copy of the entry that differs elsewhere (the media upload
    // status, for one) states the same event; one whose times or status changed replaces the report on file.
    sourceEventId: `flight-task:${taskUuid.length > 120 ? sha256(taskUuid).slice(0, 32) : taskUuid}:${sha256(
      canonicalize({ takeoffAt, landingAt, status: statusNoted ? entry.status : null }),
    ).slice(0, 32)}`,
    values: { activity: 'landed', takeoffAt, landingAt },
    ...(statusNoted
      ? { extraLimitations: [`The source states the status of this flight task as ${String(entry.status)}.`] }
      : {}),
  };
  return {
    drafts: [draft],
    rejections: [],
    unmapped: unknownKeys(entry, statusNoted ? [...mappedEntryKeys, 'status'] : mappedEntryKeys),
  };
}

/** The UTC instant of a point's timestamp in the configured unit, or why it is left out. */
function pointTime(timestamp: unknown, unit: FlightHub2PointTimeUnit, fetchedMs: number): string {
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0)
    throw new Refusal('timestamp must be a positive whole number');
  // The configured unit: seconds are multiplied by 1000; milliseconds are the identity.
  const milliseconds = unit === 'seconds' ? (timestamp as number) * 1000 : (timestamp as number);
  if (milliseconds < EARLIEST_POINT_MS || milliseconds > fetchedMs + AHEAD_OF_FETCH_MS)
    throw new Refusal(
      `read as ${unit}, timestamp is before 2020 or more than a day after the track was fetched; the configured unit may be wrong`,
    );
  return new Date(milliseconds).toISOString();
}

function degrees(value: unknown, limit: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit)
    throw new Refusal(`${field} must be degrees from -${limit} to ${limit}`);
  // Read as degrees: the conversion is the identity.
  return value;
}

/** The track of one completed flight task, as one position fix per point. */
function translateTrack(
  message: VendorMessage,
  context: TranslationContext<FlightHub2FlightsBinding>,
  taskUuid: string,
): TranslationResult {
  const body = decode(message, FLIGHTHUB2_TRACK_MAX_BYTES);
  if (body.code !== 0) throw new Refusal('The source answered with a code other than 0: no track was returned');
  const data = body.data;
  if (!isRecord(data) || !isRecord(data.track)) throw new Refusal('data.track must be the track object');
  const track = data.track;
  const aircraftId = identifier(track.drone_sn, 'data.track.drone_sn');
  const trackId = track.track_id === undefined || track.track_id === '' ? undefined : track.track_id;
  if (trackId !== undefined) identifier(trackId, 'data.track.track_id');
  const points = track.points;
  if (!Array.isArray(points)) throw new Refusal('data.track.points must be the list of points');
  if (points.length > MAX_POINTS) throw new Refusal(`The track holds more than ${MAX_POINTS} points`);
  const unit = context.binding.pointTimeUnit;
  if (unit === undefined)
    throw new Refusal(
      'The positions of this track are left out: the documentation does not state the unit of a point’s timestamp, and none is configured',
    );
  const fetchedMs = Date.parse(message.capturedAt);
  if (!Number.isFinite(fetchedMs)) throw new Refusal('The time the track was fetched is not a time');
  const subject = subjectFor(context.subjects, 'aircraft', aircraftId);
  if (!subject) throw new Refusal(`No Ledger aircraft is bound to the aircraft ${aircraftId}`);
  const flight = subjectFor(context.subjects, 'flight', identifier(taskUuid, 'The flight task id in the path'));
  if (!flight) throw new Refusal(`No Ledger flight is bound to the flight task ${taskUuid}`);
  // The source numbers no points; a point's place in its track is the one identity it has.
  const eventId = (index: number): string => {
    const id = `${String(trackId)} point ${index}`;
    return id.length > MAX_ID_LENGTH ? `track ${sha256(String(trackId)).slice(0, 32)} point ${index}` : id;
  };
  const drafts: ObservationDraft[] = [];
  const rejections: TranslationRejection[] = [];
  const unmapped = [
    ...unknownKeys(body, ['code', 'data']),
    ...unknownKeys(data, ['track'], 'data'),
    ...unknownKeys(track, ['track_id', 'drone_sn', 'points'], 'data', 'track'),
  ];
  for (const [index, point] of points.entries()) {
    const locator = jsonPointer('data', 'track', 'points', index);
    // What a point holds beyond the fields read is reported whether or not the point itself is carried.
    if (isRecord(point)) unmapped.push(...unknownKeys(point, mappedPointKeys, 'data', 'track', 'points', index));
    try {
      if (!isRecord(point)) throw new Refusal('a point must be an object');
      drafts.push({
        type: 'position.fix',
        version: 1,
        subject,
        secondarySubject: flight,
        occurredAt: pointTime(point.timestamp, unit, fetchedMs),
        ...(trackId === undefined ? {} : { sourceEventId: eventId(index) }),
        position: {
          latitudeDegrees: degrees(point.latitude, 90, 'latitude'),
          longitudeDegrees: degrees(point.longitude, 180, 'longitude'),
        },
        originalLocator: locator,
        values: { fix: 'unknown' },
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      rejections.push({ reason: `A point of the track is left out: ${error.message}`, locator });
    }
  }
  if (!drafts.length && !rejections.length) throw new Refusal('The track holds no points');
  return { drafts, rejections, unmapped };
}

export const translateFlightHub2Flights: TranslateFunction<FlightHub2FlightsBinding> = (message, context) => {
  try {
    const path = message.transport.path;
    if (path === FLIGHTHUB2_TASK_LIST_PATH) return translateTaskEntry(message, context);
    const track = path === undefined ? null : TRACK_PATH.exec(path);
    if (!track) return rejected('The message is neither an entry of the flight task list nor a flight task’s track');
    return translateTrack(message, context, decodeURIComponent(track[1]!));
  } catch (error) {
    if (error instanceof Refusal) return rejected(error.message);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const djiFlightHub2FlightsAdapter: ObservationAdapter<FlightHub2FlightsBinding> = {
  descriptor: djiFlightHub2FlightsDescriptor,
  translate: translateFlightHub2Flights,
};

// Cutting the list into its entries -----------------------------------------------------------------------------

/**
 * The exact bytes of each entry of `data.list` in a flight task list response, in order, so a message retained from
 * one is the source's own bytes. `data.list` may be null, as the documentation's example shows: no entries. Throws,
 * in words that carry no content, when the bytes are not that response or its code is not 0.
 */
export function flightTaskListEntries(bytes: Uint8Array): Uint8Array[] {
  let text: string;
  let body: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    body = JSON.parse(text);
  } catch {
    throw new Error('the flight task list is not JSON');
  }
  if (!isRecord(body)) throw new Error('the flight task list is not a JSON object');
  if (body.code !== 0)
    throw new Error(
      `the source answered the flight task list with code ${typeof body.code === 'number' ? body.code : 'missing'}`,
    );
  const list = isRecord(body.data) ? body.data.list : undefined;
  if (list === null) return [];
  if (!Array.isArray(list)) throw new Error('the flight task list holds no data.list');
  // Cut from the response as sent; a response naming data or list twice cannot be cut and is refused.
  const cut = jsonMemberBytes(bytes, ['data', 'list']);
  const entries = cut && jsonArrayElements(cut);
  if (!entries) throw new Error('the flight task list could not be cut into its entries');
  return entries;
}

/** What the transport needs to know of one list entry: its task and whether the source marks its flight completed. */
export function flightTaskEntryState(entry: Uint8Array): {
  taskUuid?: string;
  completion: 'completed' | 'incomplete' | 'unstated';
  /** Changes when a field a report is made from changes, and only then. */
  statement?: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(entry));
  } catch {
    return { completion: 'unstated' };
  }
  if (!isRecord(value)) return { completion: 'unstated' };
  const taskUuid =
    typeof value.uuid === 'string' && value.uuid && value.uuid.length <= MAX_ID_LENGTH ? value.uuid : undefined;
  const completion =
    value.flight_status === '2' ? 'completed' : value.flight_status === '1' ? 'incomplete' : 'unstated';
  const statement = sha256(
    canonicalize(Object.fromEntries([...mappedEntryKeys, 'status'].map((key) => [key, value[key] ?? null]))),
  );
  return { ...(taskUuid === undefined ? {} : { taskUuid }), completion, statement };
}
