/**
 * A tape is a recording of every exchange the web app had with the API during one scene. Replaying
 * it lets the same scene run with no server: the screens show what Ledger actually answered when
 * the tape was made.
 *
 * The record changes only when the scene writes, so the tape is cut into epochs at each write.
 * A read is answered from the epoch the replay is in. Just before each write, and at the end, the
 * recorder reads again what the screens read recently, so each epoch ends with the settled state. A read
 * the app has not made for a while is no longer on screen; a replay that asks for it is answered from the
 * last epoch that holds it.
 */

export interface Exchange {
  status: number;
  type: string;
  body: string;
  /** When the answer arrived, in milliseconds from the start of the recording. */
  at: number;
}

export interface Tape {
  version: 1;
  scene: string;
  recordedAt: string;
  /** Reads by request, in the order they were answered, for each epoch. */
  epochs: Record<string, Exchange[]>[];
  /** Writes in the order the scene made them. */
  writes: { key: string; exchange: Exchange }[];
}

interface Described {
  method: string;
  /** Who asked, the method and the path with its query. */
  key: string;
  /** The same without the query, for a read whose query depends on the day it runs. */
  loose: string;
  url: string;
  headers: Headers;
}

function describe(input: RequestInfo | URL, init: RequestInit = {}): Described {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, window.location.origin);
  const headers = new Headers(init.headers);
  const who = (headers.get('authorization') ?? '').replace(/^Bearer /, '') || 'anonymous';
  const method = (init.method ?? 'GET').toUpperCase();
  return {
    method,
    key: `${who} ${method} ${parsed.pathname}${parsed.search}`,
    loose: `${who} ${method} ${parsed.pathname}`,
    url,
    headers,
  };
}

async function capture(response: Response, at: number): Promise<Exchange> {
  // Text only: every exchange in the recorded scenes is JSON.
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    body: await response.text(),
    at,
  };
}

/** How recently the app must have made a read for the recorder to read it again before a write. */
const RECENT_MS = 20_000;

const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Each answer names the request it answered; that alone is no change. */
const REQUEST_ID = /"requestId":"[^"]*"/g;

export function recorder(scene: string, real: typeof fetch) {
  const tape: Tape = { version: 1, scene, recordedAt: new Date().toISOString(), epochs: [{}], writes: [] };
  const reads = new Map<string, Described & { lastAt: number }>();
  const began = performance.now();
  const elapsed = () => Math.round(performance.now() - began);

  const keep = (epoch: number, key: string, exchange: Exchange) => {
    (tape.epochs[epoch]![key] ??= []).push(exchange);
  };

  async function sweep(): Promise<void> {
    const epoch = tape.epochs.length - 1;
    const recent = performance.now() - RECENT_MS;
    await Promise.all(
      [...reads.values()]
        .filter((read) => read.lastAt >= recent)
        .map(async (read) => {
          const response = await real(read.url, { headers: read.headers });
          keep(epoch, read.key, await capture(response, elapsed()));
        }),
    );
  }

  const fetcher: typeof fetch = async (input, init) => {
    const request = describe(input, init);
    if (request.method === 'GET') {
      const epoch = tape.epochs.length - 1;
      const response = await real(input, init);
      // A live stream never ends, so it cannot be kept; scenes do not rely on one.
      if (response.headers.get('content-type')?.includes('text/event-stream')) return response;
      reads.set(request.key, { ...request, lastAt: performance.now() });
      keep(epoch, request.key, await capture(response.clone(), elapsed()));
      return response;
    }
    await sweep();
    const response = await real(input, init);
    tape.writes.push({ key: request.key, exchange: await capture(response.clone(), elapsed()) });
    tape.epochs.push({});
    return response;
  };

  return {
    fetcher,
    async finish(): Promise<Tape> {
      await sweep();
      // A refresh that changed nothing but the server's clock adds nothing: keep each answer once, in order.
      const shape = (exchange: Exchange) =>
        `${exchange.status} ${exchange.body.replace(INSTANT, 'T').replace(REQUEST_ID, '')}`;
      const previous = new Map<string, Exchange>();
      // The last kept read of each path: a replay looking back for a read takes any read of the same path.
      const lastOfPath = new Map<string, string>();
      for (const epoch of tape.epochs) {
        for (const [key, exchanges] of Object.entries(epoch))
          epoch[key] = exchanges.filter(
            (exchange, index) => index === 0 || shape(exchange) !== shape(exchanges[index - 1]!),
          );
        // A read unchanged since the epoch before is answered from there by the replay, when nothing else of the
        // same path would be taken for it.
        const paths = Object.keys(epoch).map((key) => key.split('?')[0]!);
        for (const [key, exchanges] of Object.entries(epoch)) {
          const path = key.split('?')[0]!;
          const earlier = previous.get(key);
          const alone = paths.filter((other) => other === path).length === 1 && lastOfPath.get(path) === key;
          if (exchanges.length === 1 && earlier && alone && shape(earlier) === shape(exchanges[0]!)) delete epoch[key];
          else previous.set(key, exchanges.at(-1)!);
        }
        for (const key of Object.keys(epoch)) lastOfPath.set(key.split('?')[0]!, key);
      }
      return tape;
    },
  };
}

const refusal = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { code: 'recorded_demonstration', message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function replayer(tape: Tape, sceneRunning: () => boolean) {
  const recordedAt = Date.parse(tape.recordedAt);
  let epoch = 0;
  let written = 0;
  let began = performance.now();
  let reached = 0;
  const served = new Map<string, number>();

  /** Start again from the beginning. */
  function rewind(): void {
    epoch = 0;
    written = 0;
    reached = 0;
    began = performance.now();
    served.clear();
  }

  /**
   * The time it was in the recording at this point of the replay. Answers are replayed exactly as
   * recorded, because Ledger's screens check content against what was signed; the page's clock
   * follows the recording instead, so "now" is never earlier than what is on screen.
   */
  function clock(): number {
    return recordedAt + Math.max(performance.now() - began, reached);
  }

  function inEpoch(index: number, request: Described): Exchange[] | undefined {
    const recorded = tape.epochs[index]!;
    if (recorded[request.key]) return recorded[request.key];
    const similar = Object.keys(recorded).find((key) => key.split('?')[0] === request.loose);
    return similar ? recorded[similar] : undefined;
  }

  function read(request: Described): Exchange | undefined {
    const here = inEpoch(epoch, request);
    if (here) {
      const turn = served.get(`${epoch} ${request.key}`) ?? 0;
      served.set(`${epoch} ${request.key}`, turn + 1);
      return here[Math.min(turn, here.length - 1)];
    }
    for (let earlier = epoch - 1; earlier >= 0; earlier--) {
      const found = inEpoch(earlier, request);
      if (found) return found.at(-1);
    }
    for (let later = epoch + 1; later < tape.epochs.length; later++) {
      const found = inEpoch(later, request);
      if (found) return found[0];
    }
    return undefined;
  }

  const pause = () => new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

  function respond(exchange: Exchange): Response {
    reached = Math.max(reached, exchange.at ?? 0);
    const empty = exchange.status === 204 || exchange.status === 304;
    return new Response(empty ? null : exchange.body, {
      status: exchange.status,
      headers: exchange.type ? { 'content-type': exchange.type } : {},
    });
  }

  const fetcher: typeof fetch = async (input, init) => {
    const request = describe(input, init);
    if (request.method === 'GET') {
      await pause();
      const exchange = read(request);
      return exchange ? respond(exchange) : refusal(404, 'This was not part of the recorded demonstration.');
    }
    // Claim the write at once, so two requests can never take the same place in the recording.
    const next = tape.writes[written];
    if (!sceneRunning() || !next || next.key.split('?')[0] !== request.loose) {
      await pause();
      return refusal(403, 'This is a recorded demonstration. Run Ledger locally to make changes of your own.');
    }
    written += 1;
    epoch = Math.min(epoch + 1, tape.epochs.length - 1);
    await pause();
    return respond(next.exchange);
  };

  return { fetcher, rewind, clock };
}
