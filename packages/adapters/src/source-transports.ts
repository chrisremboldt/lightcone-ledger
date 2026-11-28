import { connect, type MqttClient } from 'mqtt';
import { sha256 } from '@ledger/integrity';
import type { VendorMessage } from './adapter-contract.js';
import { defaultRetryPolicy, pause, retryDelay, type RetryPolicy, type SourceLoopEvent } from './source-loop.js';

/** Hands one received message to the loop. Resolves once the loop holds it. */
export type Receive = (message: VendorMessage) => Promise<void>;

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * A URL a source's secret may be sent to: TLS, or plain only on this host, or on a private network the operator
 * says they control. Never with credentials, a query or a fragment in it.
 */
export function transportUrl(
  value: string,
  label: string,
  protocols: { tls: string; plain: string },
  privateNetwork: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (![protocols.tls, protocols.plain].includes(url.protocol))
    throw new Error(`${label} must start with ${protocols.tls}// (or ${protocols.plain}// on this host)`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${label} must not carry a user name, password, query or fragment`);
  if (url.protocol === protocols.plain && !LOOPBACK.includes(url.hostname) && !privateNetwork)
    throw new Error(
      `${label} sends a secret without TLS to another host; use ${protocols.tls}// or, on a private network you control, pass --private-network`,
    );
  return url;
}

/** The broker refused the account itself. Retrying cannot help: a person has to act. */
export class BrokerAccountRefused extends Error {
  constructor(readonly account: string) {
    super(`The broker refused the account ${account}: check its password and run pnpm broker:files again`);
    this.name = 'BrokerAccountRefused';
  }
}

export interface BrokerSubscriptionConfig {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly topic: string;
  /** Stable across restarts, so the broker keeps the session and what arrived while the process was away. */
  readonly clientId: string;
  readonly contentType?: string;
  readonly retry?: RetryPolicy;
  readonly random?: () => number;
  readonly log?: (event: SourceLoopEvent) => void;
  /** How long the broker keeps the session after a disconnect. Default one day. */
  readonly sessionExpirySeconds?: number;
}

// MQTT 5 reason codes for a refused connection: bad user name or password, not authorized, banned.
const ACCOUNT_REFUSED = new Set([134, 135, 138]);

/**
 * A subscription to one topic on the message broker, QoS 1, with a persistent session. A message is acknowledged
 * to the broker once the loop holds it. After a lost connection it reconnects with capped, jittered backoff; the
 * broker redelivers what it had not had acknowledged.
 */
export class BrokerSubscription {
  private client?: MqttClient;
  private stopping = false;
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private failure?: (error: Error) => void;
  readonly failed: Promise<never>;
  connections = 0;

  constructor(
    private readonly config: BrokerSubscriptionConfig,
    private readonly receive: Receive,
  ) {
    if (!config.username || !config.password) throw new Error('The broker account needs a user name and a password');
    if (!config.topic || /[+#]/.test(config.topic)) throw new Error('The topic is one topic, without wildcards');
    this.failed = new Promise<never>((_, reject) => (this.failure = reject));
    this.failed.catch(() => {});
  }

  private log(event: SourceLoopEvent): void {
    this.config.log?.(event);
  }

  private fail(error: Error): void {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    void this.client?.endAsync(true).catch(() => {});
    this.failure?.(error);
  }

  /** Resolves once the first subscription is granted; rejects if the broker refuses the account or the topic. */
  start(): Promise<void> {
    const { config } = this;
    const client = (this.client = connect(config.url, {
      protocolVersion: 5,
      clientId: config.clientId,
      username: config.username,
      password: config.password,
      clean: false,
      // Reconnection is this class's own, with backoff and jitter.
      reconnectPeriod: 0,
      connectTimeout: 10_000,
      resubscribe: false,
      properties: { sessionExpiryInterval: config.sessionExpirySeconds ?? 86_400, receiveMaximum: 20 },
    }));
    client.handleMessage = (packet, callback) => {
      const message: VendorMessage = {
        bytes: new Uint8Array(packet.payload as Buffer),
        contentType: config.contentType ?? 'application/json',
        transport: { topic: packet.topic },
        capturedAt: new Date().toISOString(),
      };
      this.receive(message).then(
        () => callback(),
        (error: Error) => callback(error),
      );
    };
    const subscribed = new Promise<void>((resolve, reject) => {
      this.failed.catch(reject);
      client.on('connect', () => {
        this.attempt = 0;
        this.connections++;
        client.subscribe(config.topic, { qos: 1 }, (error, granted) => {
          if (error || !granted?.length || granted.some((grant) => grant.qos > 2)) {
            this.fail(new Error(`The broker refused the subscription to ${config.topic} for ${config.username}`));
            return;
          }
          this.log({
            event: 'broker_subscribed',
            message: `Subscribed to ${config.topic} as ${config.username}.`,
            topic: config.topic,
            connections: this.connections,
          });
          resolve();
        });
      });
    });
    client.on('error', (error: Error & { code?: unknown }) => {
      if (typeof error.code === 'number' && ACCOUNT_REFUSED.has(error.code)) {
        this.fail(new BrokerAccountRefused(config.username));
        return;
      }
      this.log({
        event: 'broker_error',
        message: `The broker connection failed: ${typeof error.code === 'string' ? error.code : error.message.slice(0, 200)}.`,
      });
    });
    client.on('close', () => {
      if (this.stopping) return;
      const wait = retryDelay(this.attempt++, config.retry ?? defaultRetryPolicy, config.random);
      this.log({
        event: 'broker_disconnected',
        message: `Not connected to the broker; trying again in ${wait} ms.`,
        attempt: this.attempt,
        waitMs: wait,
      });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopping) client.reconnect();
      }, wait);
    });
    return subscribed;
  }

  /** Ends the connection; the broker keeps the session and what is not yet acknowledged. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    await this.client?.endAsync(false).catch(() => this.client?.endAsync(true));
    this.client = undefined;
  }
}

/** The service refused the credential the process polls it with. Retrying cannot help: a person has to act. */
export class ServiceCredentialRefused extends Error {
  constructor(readonly status: number) {
    super(`The service refused the access token with ${status}: issue a new one and start the process again`);
    this.name = 'ServiceCredentialRefused';
  }
}

export interface ServicePollConfig {
  /** The URL read on each poll; a function when it depends on the time of the poll, such as a look-back window. */
  readonly url: string | ((now: Date) => string);
  /** Sent with each request. They hold secrets and are never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly random?: () => number;
  readonly fetcher?: typeof fetch;
  readonly log?: (event: SourceLoopEvent) => void;
  /**
   * Cuts a response into the messages it holds, each its own exact bytes, or returns undefined when it cannot, and
   * the response is handed over whole. With it, each poll hands over only the parts the previous poll did not hold.
   */
  readonly split?: (bytes: Uint8Array) => Uint8Array[] | undefined;
  /**
   * With split: what a part is known by from one poll to the next. A part is handed over when the previous poll held
   * none with its key. Default: the digest of its bytes.
   */
  readonly partKey?: (part: Uint8Array) => string;
  /**
   * Reads the polled response as a list of items, each to be read at its own path on the same host, or returns
   * undefined when it cannot. With it, each poll reads and hands over the items whose key the previous poll did not
   * list, each as its own message; the list itself is not handed over unless split cuts it into parts too.
   */
  readonly follow?: (bytes: Uint8Array) => readonly ListedItem[] | undefined;
  /**
   * With follow: cuts an item's response down to the part that is handed over, its own exact bytes, or returns
   * undefined, and the response is handed over whole.
   */
  readonly followedPart?: (bytes: Uint8Array) => Uint8Array | undefined;
  /**
   * With split or follow: the path and query of the list's next page, read from a page and the URL it was read at,
   * or undefined at the last page. Every page is read on the polled host before anything is handed over.
   */
  readonly nextPage?: (bytes: Uint8Array, url: string) => string | undefined;
}

/** An item a list names: the path it is read at, and a key that changes when the list's entry for it changes. */
export interface ListedItem {
  readonly path: string;
  readonly key: string;
  /** The service may not hold the item yet: a 404 for it is not a failure, and the next poll asks for it again. */
  readonly mayBeAbsent?: boolean;
}

/**
 * The exact bytes of each element of a JSON array, in order, or undefined when the bytes are not one JSON array.
 * Each element is cut from the response as sent, so a message retained from it is the source's own bytes.
 */
export function jsonArrayElements(bytes: Uint8Array): Uint8Array[] | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Array.isArray(JSON.parse(text))) return undefined;
  } catch {
    return undefined;
  }
  const encoder = new TextEncoder();
  const elements: Uint8Array[] = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  const close = (end: number) => {
    const element = text.slice(start, end).trim();
    if (element) elements.push(encoder.encode(element));
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[' || character === '{') {
      if (depth++ === 0) start = index + 1;
    } else if (character === ']' || character === '}') {
      if (--depth === 0) close(index);
    } else if (character === ',' && depth === 1) {
      close(index);
      start = index + 1;
    }
  }
  return elements;
}

const skipSpace = (text: string, at: number): number => {
  while (at < text.length && ' \t\n\r'.includes(text[at]!)) at++;
  return at;
};

function stringEnd(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

/** The index after the JSON value that starts at `at`, in text already known to be valid JSON. */
function valueEnd(text: string, at: number): number {
  if (text[at] === '"') return stringEnd(text, at);
  if (text[at] !== '{' && text[at] !== '[') {
    while (at < text.length && !',}] \t\n\r'.includes(text[at]!)) at++;
    return at;
  }
  let depth = 0;
  for (let index = at; index < text.length; index++) {
    const character = text[index];
    if (character === '"') index = stringEnd(text, index) - 1;
    else if (character === '{' || character === '[') depth++;
    else if ((character === '}' || character === ']') && --depth === 0) return index + 1;
  }
  return text.length;
}

/** Where the value of one key of the object at `start` begins and ends; undefined when absent or given twice. */
function memberSpan(text: string, start: number, key: string): [number, number] | undefined {
  let at = skipSpace(text, start);
  if (text[at] !== '{') return undefined;
  at = skipSpace(text, at + 1);
  let found: [number, number] | undefined;
  while (at < text.length && text[at] !== '}') {
    const nameEnd = stringEnd(text, at);
    const name = JSON.parse(text.slice(at, nameEnd)) as string;
    at = skipSpace(text, skipSpace(text, nameEnd) + 1);
    const end = valueEnd(text, at);
    if (name === key) {
      if (found) return undefined;
      found = [at, end];
    }
    at = skipSpace(text, end);
    if (text[at] === ',') at = skipSpace(text, at + 1);
  }
  return found;
}

/**
 * The exact bytes of the value at a path of object keys in a JSON document, or undefined when the bytes are not JSON,
 * a key on the path is absent or a key on the path is given twice. The value is cut from the document as sent, so a
 * message retained from it is the source's own bytes.
 */
export function jsonMemberBytes(bytes: Uint8Array, path: readonly string[]): Uint8Array | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    JSON.parse(text);
  } catch {
    return undefined;
  }
  let span: [number, number] = [0, text.length];
  for (const key of path) {
    const next = memberSpan(text, span[0], key);
    if (!next) return undefined;
    span = next;
  }
  return new TextEncoder().encode(text.slice(span[0], span[1]));
}

/** The service asked for a pause (429). The wait it suggests, when it suggests one, is honoured up to a bound. */
export class ServiceBusy extends Error {
  constructor(readonly retryAfterMs?: number) {
    super(
      retryAfterMs === undefined
        ? 'the service answered 429, too many requests'
        : `the service answered 429, too many requests, and asks for a wait of ${Math.ceil(retryAfterMs / 1000)} s`,
    );
    this.name = 'ServiceBusy';
  }
}

/** A read the service answered with a status other than success, a refused credential or a request to wait. */
class ServiceAnswer extends Error {
  constructor(readonly status: number) {
    super(`the service answered ${status}`);
  }
}

class ResponseTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`the response is larger than ${limit} bytes`);
  }
}

/** The whole seconds a Retry-After header states, as milliseconds; undefined when it states none. */
function retryAfterMs(header: string | null): number | undefined {
  return header !== null && /^\d{1,9}$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

// A wait the service asks for is honoured up to this long; a longer one is cut to it and asked about again.
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const MAX_LIST_PAGES = 200;

/**
 * Reads one URL of a service on an interval and hands each response that differs from the last one handed over to
 * the loop. A failed read is tried again with capped, jittered backoff, after the wait the service asks for when it
 * answers 429; a refused credential stops it.
 */
export class ServicePoll {
  private readonly halt = new AbortController();
  private running?: Promise<void>;
  private lastDigest?: string;
  private lastParts = new Set<string>();
  private lastItems = new Set<string>();
  polls = 0;
  unchanged = 0;

  constructor(
    private readonly config: ServicePollConfig,
    private readonly receive: Receive,
  ) {
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1)
      throw new Error('The poll interval is a positive number of milliseconds');
    if (config.nextPage && !config.split && !config.follow)
      throw new Error('A list read page by page is cut into parts or followed');
  }

  private log(event: SourceLoopEvent): void {
    this.config.log?.(event);
  }

  /** Polls until stopped. The promise rejects with ServiceCredentialRefused. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  private async read(url: string, accept = 'application/json'): Promise<Uint8Array> {
    const response = await (this.config.fetcher ?? fetch)(url, {
      headers: { ...this.config.headers, accept },
      redirect: 'error',
      signal: AbortSignal.any([this.halt.signal, AbortSignal.timeout(this.config.timeoutMs ?? 10_000)]),
    });
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const limit = this.config.maxBytes ?? 1024 * 1024;
      if (bytes.byteLength > limit) throw new ResponseTooLarge(limit);
      this.contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      return bytes;
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new ServiceCredentialRefused(response.status);
    if (response.status === 429) throw new ServiceBusy(retryAfterMs(response.headers.get('retry-after')));
    throw new ServiceAnswer(response.status);
  }

  private contentType = 'application/json';

  /** The polled response and, for a list read page by page, every further page, all on the polled host. */
  private async readPages(first: string): Promise<{ url: string; bytes: Uint8Array }[]> {
    const pages = [{ url: first, bytes: await this.read(first) }];
    const origin = new URL(first).origin;
    while (this.config.nextPage) {
      const last = pages.at(-1)!;
      const next = last.bytes.byteLength ? this.config.nextPage(last.bytes, last.url) : undefined;
      if (next === undefined) break;
      if (pages.length >= MAX_LIST_PAGES) throw new Error(`the list has more than ${MAX_LIST_PAGES} pages`);
      const url = new URL(next, last.url);
      if (url.origin !== origin) throw new Error('the list names its next page on another host');
      pages.push({ url: url.toString(), bytes: await this.read(url.toString()) });
    }
    return pages;
  }

  /** Hands over the parts of a list the previous poll did not hold. Returns how many. */
  private async handParts(pages: readonly Uint8Array[], hand: (part: Uint8Array) => Promise<void>): Promise<number> {
    const key = this.config.partKey ?? sha256;
    const held = new Set<string>();
    let fresh = 0;
    for (const bytes of pages) {
      // An empty response (204, no content) holds no messages.
      const parts = bytes.byteLength ? (this.config.split!(bytes) ?? [bytes]) : [];
      for (const part of parts) {
        const partKey = key(part);
        if (!this.lastParts.has(partKey) && !held.has(partKey)) {
          await hand(part);
          fresh++;
        }
        held.add(partKey);
      }
    }
    this.lastParts = held;
    return fresh;
  }

  /** Reads the items of a list the previous poll did not hold, on the polled host only. Returns how many. */
  private async followList(
    pages: readonly { url: string; bytes: Uint8Array }[],
    hand: (part: Uint8Array, path: string, contentType: string) => Promise<void>,
  ): Promise<number> {
    const listed = pages.flatMap(({ bytes }) => {
      const items = bytes.byteLength ? this.config.follow!(bytes) : [];
      if (!items) throw new Error('the list could not be read');
      return items;
    });
    const origin = new URL(pages[0]!.url).origin;
    const held = new Set<string>();
    let fresh = 0;
    try {
      for (const item of listed) {
        if (this.lastItems.has(item.key) || held.has(item.key)) {
          held.add(item.key);
          continue;
        }
        const url = new URL(item.path, pages[0]!.url);
        if (url.origin !== origin) throw new Error('the list names an item on another host');
        let bytes: Uint8Array;
        try {
          bytes = await this.read(url.toString(), '*/*');
        } catch (error) {
          // Not held yet: the item is asked for again on the next poll.
          if (item.mayBeAbsent && error instanceof ServiceAnswer && error.status === 404) continue;
          if (!(error instanceof ResponseTooLarge)) throw error;
          // Reading it again would give the same answer: it is left out, and said once.
          this.log({
            event: 'item_too_large',
            message: `${url.pathname} is larger than ${error.limit} bytes and is not read.`,
            path: url.pathname,
          });
          held.add(item.key);
          continue;
        }
        await hand(this.config.followedPart?.(bytes) ?? bytes, url.pathname, this.contentType);
        held.add(item.key);
        fresh++;
      }
    } catch (error) {
      // What was read and handed over before the failure is not read again by the next attempt.
      for (const key of held) this.lastItems.add(key);
      throw error;
    }
    this.lastItems = held;
    return fresh;
  }

  private async poll(): Promise<void> {
    const { config } = this;
    const first = typeof config.url === 'function' ? config.url(new Date()) : config.url;
    const pages = await this.readPages(first);
    this.polls++;
    const capturedAt = new Date().toISOString();
    const path = new URL(first).pathname;
    const hand = (part: Uint8Array, at = path, contentType = 'application/json') =>
      this.receive({ bytes: part, contentType, transport: { method: 'GET', path: at }, capturedAt });
    if (config.split || config.follow) {
      let fresh = 0;
      if (config.split)
        fresh += await this.handParts(
          pages.map((page) => page.bytes),
          hand,
        );
      if (config.follow) fresh += await this.followList(pages, hand);
      if (!fresh) this.unchanged++;
      return;
    }
    const bytes = pages[0]!.bytes;
    const digest = sha256(bytes);
    if (digest === this.lastDigest) this.unchanged++;
    else {
      await hand(bytes);
      this.lastDigest = digest;
    }
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.halt.signal.aborted) {
      let wait = this.config.intervalMs;
      const before = this.polls;
      try {
        await this.poll();
        attempt = 0;
      } catch (error) {
        if (error instanceof ServiceCredentialRefused) throw error;
        if (this.halt.signal.aborted) return;
        // The service answered and something after that failed: the backoff starts again.
        if (this.polls > before) attempt = 0;
        wait = retryDelay(attempt++, this.config.retry ?? defaultRetryPolicy, this.config.random);
        if (error instanceof ServiceBusy && error.retryAfterMs !== undefined)
          wait = Math.max(wait, Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS));
        this.log({
          event: error instanceof ServiceBusy ? 'poll_rate_limited' : 'poll_failed_retrying',
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
