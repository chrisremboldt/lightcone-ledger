import { randomUUID } from 'node:crypto';
import { sha256 } from '@ledger/integrity';
import {
  FLIGHTHUB2_TASK_LIST_PATH,
  FLIGHTHUB2_TRACK_MAX_BYTES,
  flightHub2TrackPath,
  flightTaskEntryState,
  flightTaskListEntries,
} from './dji-flighthub2-flights.js';
import { defaultRetryPolicy, pause, retryDelay, type RetryPolicy, type SourceLoopEvent } from './source-loop.js';
import { type Receive, ServiceBusy, ServiceCredentialRefused } from './source-transports.js';

/*
 * BUILT FROM DOCUMENTATION ONLY: see the note at the top of dji-flighthub2-flights.ts. Every request here is one the
 * published documentation describes; none has been sent to the real product.
 */

/** The documented cap: the list "currently returns the first 100 entries". */
export const FLIGHTHUB2_LIST_LIMIT = 100;
const DEFAULT_LOOK_BACK_MS = 48 * 3_600_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
/** List requests one poll may spend narrowing a full answer before it stops and says so. */
const MAX_LIST_REQUESTS = 64;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

export interface FlightHub2FlightPollConfig {
  /** The service's origin, such as the documented access point of a region. */
  readonly origin: string;
  /** The organization key. Sent as X-User-Token with each request; never logged. */
  readonly userToken: string;
  /** Sent as X-Project-Uuid with each request. */
  readonly projectUuid: string;
  readonly intervalMs: number;
  /** Whether the track of each completed flight task is read. False while the unit of its timestamps is not stated. */
  readonly readTracks: boolean;
  /** How far back each poll lists flight tasks. Default 48 hours. */
  readonly lookBackMs?: number;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
  readonly log?: (event: SourceLoopEvent) => void;
}

class NotFound extends Error {}

/**
 * Reads one project's flight tasks on an interval and hands over, once each, the list entry of every task the source
 * marks completed and then that task's track, each as the source's own bytes. The list has no page parameter and
 * returns at most 100 entries, so a full answer is asked again for each half of its time range until an answer is
 * not full. A failed read is tried again with capped, jittered backoff; a refused organization key stops it.
 */
export class FlightHub2FlightPoll {
  private readonly halt = new AbortController();
  private running?: Promise<void>;
  /**
   * Completed tasks whose list entry has been handed over, each with what it stated then, and those whose track has.
   * An entry is handed over again only when a field a report is made from changes.
   */
  private reported = new Map<string, string>();
  private tracked = new Set<string>();
  /** Entries that state no completion, handed over once so the adapter says why they are not read. */
  private unread = new Set<string>();
  private listFull = false;
  private said = new Set<string>();
  private lastListing = '';
  private listRequests = 0;
  polls = 0;
  requests = 0;

  constructor(
    private readonly config: FlightHub2FlightPollConfig,
    private readonly receive: Receive,
  ) {
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1)
      throw new Error('The poll interval is a positive number of milliseconds');
    if (!config.userToken) throw new Error('The organization key is required');
    if (!config.projectUuid) throw new Error('The project id is required');
    if (new URL(config.origin).origin !== config.origin.replace(/\/$/, ''))
      throw new Error('The service URL is an origin, without a path');
  }

  private log(event: SourceLoopEvent): void {
    this.config.log?.(event);
  }

  /** Logs a thing worth saying once until it stops being true. */
  private sayOnce(key: string, event: SourceLoopEvent): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(event);
  }

  /** Polls until stopped. The promise rejects with ServiceCredentialRefused. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  private async read(pathAndQuery: string, maxBytes: number): Promise<Uint8Array> {
    this.requests++;
    const response = await (this.config.fetcher ?? fetch)(new URL(pathAndQuery, this.config.origin).toString(), {
      headers: {
        'X-User-Token': this.config.userToken,
        'X-Project-Uuid': this.config.projectUuid,
        'X-Request-Id': randomUUID(),
        'X-Language': 'en',
        accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.any([this.halt.signal, AbortSignal.timeout(this.config.timeoutMs ?? 20_000)]),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceCredentialRefused(response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 404) throw new NotFound('the service answered 404');
      if (response.status === 429) {
        const asked = response.headers.get('retry-after')?.trim() ?? '';
        throw new ServiceBusy(/^\d{1,9}$/.test(asked) ? Number(asked) * 1000 : undefined);
      }
      throw new Error(`the service answered ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`the response is larger than ${maxBytes} bytes`);
    return bytes;
  }

  /** The entries listed for a time range in seconds, narrowing while an answer is full. */
  private async list(beginSeconds: number, endSeconds: number): Promise<Uint8Array[]> {
    this.listRequests++;
    const entries = flightTaskListEntries(
      await this.read(`${FLIGHTHUB2_TASK_LIST_PATH}?begin_at=${beginSeconds}&end_at=${endSeconds}`, LIST_MAX_BYTES),
    );
    if (entries.length < FLIGHTHUB2_LIST_LIMIT) return entries;
    if (endSeconds - beginSeconds < 2 || this.listRequests >= MAX_LIST_REQUESTS) {
      this.listFull = true;
      this.sayOnce('list_full', {
        event: 'list_full',
        message: `The list of flight tasks returned its limit of ${FLIGHTHUB2_LIST_LIMIT} for a time range that could not be narrowed further; flight tasks beyond those were not read.`,
      });
      return entries;
    }
    const middle = Math.floor((beginSeconds + endSeconds) / 2);
    // What the two times filter is not documented: a task listed in both halves is taken once, by its id.
    return [...(await this.list(beginSeconds, middle)), ...(await this.list(middle, endSeconds))];
  }

  private async cycle(): Promise<void> {
    const now = (this.config.now ?? Date.now)();
    const capturedAt = new Date(now).toISOString();
    this.listRequests = 0;
    this.listFull = false;
    const listed = await this.list(
      Math.floor((now - (this.config.lookBackMs ?? DEFAULT_LOOK_BACK_MS)) / 1000),
      Math.ceil(now / 1000),
    );
    const seen = new Set<string>();
    let incomplete = 0;
    for (const entry of listed) {
      const { taskUuid, completion, statement = '' } = flightTaskEntryState(entry);
      const key = taskUuid ?? `entry ${sha256(entry)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (completion === 'incomplete') {
        incomplete++;
        continue;
      }
      // A task handed over before the source stated its completion is handed over again once it is completed.
      const handed = completion === 'completed' ? this.reported.get(key) === statement : this.unread.has(key);
      if (!handed) {
        await this.receive({
          bytes: entry,
          contentType: 'application/json',
          transport: { method: 'GET', path: FLIGHTHUB2_TASK_LIST_PATH },
          capturedAt,
        });
        if (completion === 'completed') this.reported.set(key, statement);
        else this.unread.add(key);
      }
      if (completion === 'completed' && taskUuid !== undefined && this.config.readTracks && !this.tracked.has(key))
        await this.readTrack(taskUuid);
    }
    // A task that has left the listed time range is forgotten; the same bytes read again give the same keys.
    this.reported = new Map([...this.reported].filter(([key]) => seen.has(key)));
    this.tracked = new Set([...this.tracked].filter((key) => seen.has(key)));
    this.unread = new Set([...this.unread].filter((key) => seen.has(key)));
    this.said = new Set([...this.said].filter((key) => (key === 'list_full' ? this.listFull : seen.has(key))));
    this.polls++;
    const listing = `${seen.size} ${incomplete}`;
    if (listing === this.lastListing) return;
    this.lastListing = listing;
    this.log({
      event: 'flight_tasks_listed',
      message: `The list holds ${seen.size} flight task(s) for the last ${Math.round((this.config.lookBackMs ?? DEFAULT_LOOK_BACK_MS) / 3_600_000)} hours: ${incomplete} not marked completed, ${seen.size - incomplete} handed to the adapter.`,
      listed: seen.size,
      incomplete,
    });
  }

  /** Hands over a completed task's track. One the source does not have yet is asked for again on the next poll. */
  private async readTrack(taskUuid: string): Promise<void> {
    const path = flightHub2TrackPath(taskUuid);
    let bytes: Uint8Array;
    try {
      bytes = await this.read(path, FLIGHTHUB2_TRACK_MAX_BYTES);
    } catch (error) {
      if (!(error instanceof NotFound)) throw error;
      this.sayOnce(taskUuid, {
        event: 'track_not_found',
        message: `The source has no track for the completed flight task ${taskUuid} (404); it is asked for again on each poll while the task is listed.`,
        task: taskUuid,
      });
      return;
    }
    await this.receive({
      bytes,
      contentType: 'application/json',
      transport: { method: 'GET', path },
      capturedAt: new Date((this.config.now ?? Date.now)()).toISOString(),
    });
    this.tracked.add(taskUuid);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.halt.signal.aborted) {
      let wait = this.config.intervalMs;
      try {
        await this.cycle();
        attempt = 0;
      } catch (error) {
        if (error instanceof ServiceCredentialRefused) throw error;
        if (this.halt.signal.aborted) return;
        wait = retryDelay(attempt++, this.config.retry ?? defaultRetryPolicy, this.config.random);
        // A wait the service asks for (429 with Retry-After) is honoured, up to fifteen minutes.
        if (error instanceof ServiceBusy && error.retryAfterMs !== undefined)
          wait = Math.max(wait, Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS));
        this.log({
          event: 'poll_failed_retrying',
          message: `Could not read the service (${(error as Error).message.slice(0, 200)}); trying again in ${wait} ms.`,
          attempt,
          waitMs: wait,
        });
      }
      await pause(wait, this.halt.signal);
    }
  }

  async stop(): Promise<void> {
    this.halt.abort();
    await this.running?.catch(() => {});
  }
}
