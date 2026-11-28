import type { IncomingMessage, ServerResponse } from 'node:http';

/*
 * A stand-in for the flight task interface of DJI FlightHub 2's public cloud (OpenAPI V2.0), answering in the shapes
 * its published documentation describes, with invented flights.
 *
 * BUILT FROM DOCUMENTATION ONLY. Nobody on this project has a FlightHub 2 project, so nothing here was compared with
 * the real product. Where the documentation is silent this stand-in had to choose; each such choice is marked "not
 * documented" below and says nothing about what the product does. An adapter that passes against this stand-in has
 * been shown to read the documented shapes, no more.
 */

/** Fixed test values of the stand-in: the organization key it accepts and the one project it holds. */
export const FLIGHTHUB2_EMULATOR_TOKEN = 'flighthub2-emulator-organization-key';
export const FLIGHTHUB2_EMULATOR_PROJECT = '7d0c2f4e-5a1b-4c3d-9e8f-0a1b2c3d4e5f';
const ORGANIZATION = '2b9d6c1a-3e4f-4a5b-8c7d-6e5f4a3b2c1d';
/** Documented: the list "currently returns the first 100 entries". */
const LIST_LIMIT = 100;

/** The task statuses the documentation lists. */
export const flightHub2TaskStatuses = [
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
] as const;

export interface EmulatedTrackPoint {
  readonly occurredAt: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly height: number;
}

export interface EmulatedFlightTask {
  readonly uuid: string;
  readonly name: string;
  readonly dockSn: string;
  readonly droneSn: string;
  readonly waylineUuid: string;
  /** Planned start and end. */
  readonly beginAt: string;
  readonly endAt: string;
  /** Actual start and completion; absent until they happen. */
  runAt?: string;
  completedAt?: string;
  status: (typeof flightHub2TaskStatuses)[number];
  mediaUploadStatus: 'to_upload' | 'uploading' | 'upload_finished';
  /** False: the track answers 404 although the task is completed (not documented whether this can happen). */
  trackAvailable?: boolean;
  readonly points: readonly EmulatedTrackPoint[];
}

/** The documented date-time form, as its example writes it: UTC with six fractional digits. */
const dateTime = (instant: string): string => new Date(instant).toISOString().replace('Z', '000Z');

/** One entry of `data.list`, with the documented fields. */
export function flightTaskEntry(task: EmulatedFlightTask): Record<string, unknown> {
  return {
    uuid: task.uuid,
    name: task.name,
    task_type: 'immediate',
    status: task.status,
    sn: task.dockSn,
    landing_dock_sn: '',
    wayline_uuid: task.waylineUuid,
    begin_at: dateTime(task.beginAt),
    end_at: dateTime(task.endAt),
    // Not documented: what a task that has not started or not completed carries here. This stand-in leaves them out.
    ...(task.runAt ? { run_at: dateTime(task.runAt) } : {}),
    ...(task.completedAt ? { completed_at: dateTime(task.completedAt) } : {}),
    media_upload_status: task.mediaUploadStatus,
    resumable_status: 'manual',
    is_break_point_resume: false,
    current_waypoint_index: task.completedAt ? 6 : 2,
    total_waypoints: 6,
    flight_type: '1',
    // Documented: "1: incomplete; 2: completed".
    flight_status: task.completedAt ? '2' : '1',
    folder_id: 4200 + (Number.parseInt(task.uuid.slice(-4), 16) % 1000),
    operations: [{ operator_account: 'avery.example' }],
    exceptions: [],
  };
}

/** The exact text of a list response holding these tasks' entries. */
export function flightTaskListBody(tasks: readonly EmulatedFlightTask[]): string {
  return JSON.stringify({ code: 0, message: '', data: { list: tasks.map(flightTaskEntry) } });
}

/**
 * The exact text of a task's track response. Not documented: the unit of a point's timestamp, of the height, of the
 * distance and of the duration. This stand-in writes the timestamp in the unit asked for, heights and distance in
 * meters and the duration in seconds; none of that is a statement about the product.
 */
export function flightTaskTrackBody(task: EmulatedFlightTask, timestampUnit: 'seconds' | 'milliseconds'): string {
  const times = task.points.map((point) => Date.parse(point.occurredAt));
  const flown = task.points.reduce((meters, point, index) => {
    const previous = task.points[index - 1];
    if (!previous) return meters;
    const north = (point.latitude - previous.latitude) * 111_320;
    const east = (point.longitude - previous.longitude) * 111_320 * Math.cos((point.latitude * Math.PI) / 180);
    return meters + Math.hypot(north, east);
  }, 0);
  return JSON.stringify({
    code: 0,
    message: 'OK',
    data: {
      name: task.name,
      wayline_uuid: task.waylineUuid,
      track: {
        track_id: `track-${task.uuid}`,
        drone_sn: task.droneSn,
        flight_distance: Math.round(flown),
        flight_duration: times.length ? Math.round((times.at(-1)! - times[0]!) / 1000) : 0,
        points: task.points.map((point, index) => ({
          timestamp: timestampUnit === 'seconds' ? Math.floor(times[index]! / 1000) : times[index]!,
          latitude: point.latitude,
          longitude: point.longitude,
          height: point.height,
        })),
      },
    },
  });
}

export interface InventedFlight {
  readonly uuid: string;
  readonly name?: string;
  /** When the task started executing. */
  readonly runAt: string;
  /** Minutes flown; absent for a task still executing. */
  readonly minutes?: number;
  readonly dockSn?: string;
  readonly droneSn?: string;
  readonly pointEverySeconds?: number;
}

/** An invented flight task: an out-and-back line from an invented dock, a point every few seconds. */
export function inventedFlightTask(flight: InventedFlight): EmulatedFlightTask {
  const start = Date.parse(flight.runAt);
  const flownSeconds = (flight.minutes ?? 4) * 60;
  const step = flight.pointEverySeconds ?? 5;
  const points: EmulatedTrackPoint[] = [];
  for (let second = 0; second <= flownSeconds; second += step) {
    const out = 1 - Math.abs(1 - (2 * second) / flownSeconds);
    points.push({
      occurredAt: new Date(start + second * 1000).toISOString(),
      latitude: Number((39.97 + out * 0.004).toFixed(7)),
      longitude: Number((-86.13 + out * 0.003).toFixed(7)),
      height: Number((260 + out * 60).toFixed(1)),
    });
  }
  return {
    uuid: flight.uuid,
    name: flight.name ?? 'North fence line',
    dockSn: flight.dockSn ?? 'RIDGE-DOCK-1',
    droneSn: flight.droneSn ?? 'RIDGE-AC-1',
    waylineUuid: '0c6f1d2e-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    beginAt: flight.runAt,
    endAt: new Date(start + flownSeconds * 1000).toISOString(),
    runAt: flight.runAt,
    ...(flight.minutes === undefined ? {} : { completedAt: new Date(start + flownSeconds * 1000).toISOString() }),
    status: flight.minutes === undefined ? 'executing' : 'success',
    mediaUploadStatus: flight.minutes === undefined ? 'to_upload' : 'upload_finished',
    points,
  };
}

const taskId = (number: number): string => `a1b2c3d4-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

/** Two completed flights and one in progress, placed in the hours before `now`. */
export function inventedFlightTasks(now = Date.now()): EmulatedFlightTask[] {
  const at = (minutesAgo: number) => new Date(Math.floor(now / 60_000) * 60_000 - minutesAgo * 60_000).toISOString();
  return [
    inventedFlightTask({ uuid: taskId(1), runAt: at(180), minutes: 12 }),
    inventedFlightTask({ uuid: taskId(2), name: 'Substation roof', runAt: at(60), minutes: 8 }),
    inventedFlightTask({ uuid: taskId(3), name: 'North fence line', runAt: at(3) }),
  ];
}

/** The one project the stand-in holds. */
export class FlightHub2Project {
  readonly token = FLIGHTHUB2_EMULATOR_TOKEN;
  readonly uuid = FLIGHTHUB2_EMULATOR_PROJECT;
  /** Not documented: see flightTaskTrackBody. */
  pointTimestampUnit: 'seconds' | 'milliseconds' = 'seconds';
  /** Every request answered, for tests: the path with its query. */
  readonly requests: string[] = [];
  constructor(public tasks: EmulatedFlightTask[] = inventedFlightTasks()) {}

  /** Marks a task completed, as the source would once its flight ends. */
  complete(uuid: string, completedAt: string): void {
    const task = this.tasks.find((candidate) => candidate.uuid === uuid);
    if (!task) throw new Error(`No flight task ${uuid}`);
    Object.assign(task, { completedAt, status: 'success', mediaUploadStatus: 'uploading' });
  }
}

export interface FlightHub2Answer {
  readonly status: 200 | 400 | 401 | 403 | 404;
  /** Empty: the documentation shows no body for this answer. */
  readonly body: string;
}

const refusal = (status: 400 | 401 | 403, code: number, message: string): FlightHub2Answer => ({
  status,
  body: JSON.stringify({ code, message, data: {} }),
});
const TRACK = /^\/openapi\/v2\.0\/flight-task\/([^/]+)\/track$/;
const listFilters = ['sn', 'name', 'begin_at', 'end_at', 'task_type', 'status', 'flight_task_type'];
const seconds = (text: string | null): number | undefined =>
  text !== null && /^\d{1,12}$/.test(text) ? Number(text) : undefined;

function listAnswer(project: FlightHub2Project, query: URLSearchParams): FlightHub2Answer {
  if ([...query.keys()].some((key) => !listFilters.includes(key))) return refusal(400, 200400, 'Bad Request');
  const begin = seconds(query.get('begin_at'));
  const end = seconds(query.get('end_at'));
  // Documented: the two times are "used in pair".
  if ((query.has('begin_at') || query.has('end_at')) && (begin === undefined || end === undefined || end < begin))
    return refusal(400, 200400, 'Bad Request');
  const sns = query.get('sn')?.split(',').filter(Boolean);
  const statuses = query.get('status')?.split(',').filter(Boolean);
  const name = query.get('name');
  const matching = project.tasks
    // Not documented: which of a task's times the two filters apply to. This stand-in uses the planned start.
    .filter(
      (task) =>
        begin === undefined || (Date.parse(task.beginAt) >= begin * 1000 && Date.parse(task.beginAt) <= end! * 1000),
    )
    .filter((task) => !sns || sns.includes(task.dockSn))
    .filter((task) => !statuses || statuses.includes(task.status))
    .filter((task) => !name || task.name.includes(name))
    .filter((task) => !query.get('task_type') || query.get('task_type') === 'immediate')
    .filter((task) => !query.get('flight_task_type') || query.get('flight_task_type') === '1')
    // Not documented: the order, and so which entries are "the first 100". This stand-in lists the latest first.
    .sort((a, b) => Date.parse(b.beginAt) - Date.parse(a.beginAt) || a.uuid.localeCompare(b.uuid));
  return { status: 200, body: flightTaskListBody(matching.slice(0, LIST_LIMIT)) };
}

/**
 * Answers one request to the documented interface, or returns undefined for a path that is not part of it. A
 * missing or wrong X-User-Token answers 401 and a wrong X-Project-Uuid 403, as the documentation's authentication
 * pages describe.
 */
export function answerFlightHub2Request(
  project: FlightHub2Project,
  method: string,
  path: string,
  query: URLSearchParams,
  header: (name: string) => string | undefined,
): FlightHub2Answer | undefined {
  if (!path.startsWith('/openapi/v2.0/')) return undefined;
  project.requests.push(`${path}${[...query.keys()].length ? `?${query.toString()}` : ''}`);
  if (header('x-user-token') !== project.token) return refusal(401, 200401, 'Unauthorized');
  if (method !== 'GET') return { status: 404, body: '' };
  if (path === '/openapi/v2.0/system_status') return { status: 200, body: JSON.stringify({ code: 0, message: '' }) };
  if (path === '/openapi/v2.0/project')
    return {
      status: 200,
      body: JSON.stringify({
        code: 0,
        message: '',
        data: {
          list: [
            {
              name: 'Example Ridge Survey',
              introduction: 'Invented project of the stand-in',
              uuid: project.uuid,
              org_uuid: ORGANIZATION,
              created_at: 1790000000,
              updated_at: 1790000000,
              project_work_center_point: { latitude: 39.97, longitude: -86.13 },
            },
          ],
        },
      }),
    };
  if (header('x-project-uuid') !== project.uuid) return refusal(403, 200403, 'Forbidden');
  if (path === '/openapi/v2.0/flight-task/list') return listAnswer(project, query);
  const track = TRACK.exec(path);
  const task = track ? project.tasks.find((candidate) => candidate.uuid === decodeURIComponent(track[1]!)) : undefined;
  // Documented for 404: "Task does not exist or does not belong to specified project". Not documented: what a task
  // that has not completed answers. This stand-in answers 404 for it too.
  if (!task || !task.completedAt || task.trackAvailable === false) return { status: 404, body: '' };
  return { status: 200, body: flightTaskTrackBody(task, project.pointTimestampUnit) };
}

/** Serves the stand-in on an HTTP server. Returns false for a path that is not part of the interface. */
export function handleFlightHub2Request(
  project: FlightHub2Project,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): boolean {
  const answer = answerFlightHub2Request(project, request.method ?? 'GET', url.pathname, url.searchParams, (name) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  });
  if (!answer) return false;
  response.writeHead(answer.status, {
    ...(answer.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'cache-control': 'no-store',
    'x-ledger-simulation': 'documented-flight-tasks',
  });
  response.end(answer.body);
  return true;
}

/** The stand-in as a fetch, for tests and for a process run against it without a listener. */
export function flightHub2Fetcher(project: FlightHub2Project): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init.headers);
    const answer = answerFlightHub2Request(
      project,
      init.method ?? 'GET',
      url.pathname,
      url.searchParams,
      (name) => headers.get(name) ?? undefined,
    ) ?? { status: 404 as const, body: '' };
    return new Response(answer.body || null, {
      status: answer.status,
      headers: answer.body ? { 'content-type': 'application/json; charset=utf-8' } : {},
    });
  }) as typeof fetch;
}
