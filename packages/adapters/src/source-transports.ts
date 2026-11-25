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
  /** The one URL read on each poll. */
  readonly url: string;
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

/**
 * Reads one URL of a service on an interval and hands each response that differs from the last one handed over to
 * the loop. A failed read is tried again with capped, jittered backoff; a refused credential stops it.
 */
export class ServicePoll {
  private readonly halt = new AbortController();
  private running?: Promise<void>;
  private lastDigest?: string;
  private lastParts = new Set<string>();
  polls = 0;
  unchanged = 0;

  constructor(
    private readonly config: ServicePollConfig,
    private readonly receive: Receive,
  ) {
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1)
      throw new Error('The poll interval is a positive number of milliseconds');
  }

  private log(event: SourceLoopEvent): void {
    this.config.log?.(event);
  }

  /** Polls until stopped. The promise rejects with ServiceCredentialRefused. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  private async read(): Promise<Uint8Array> {
    const response = await (this.config.fetcher ?? fetch)(this.config.url, {
      headers: { ...this.config.headers, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([this.halt.signal, AbortSignal.timeout(this.config.timeoutMs ?? 10_000)]),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceCredentialRefused(response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`the service answered ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > (this.config.maxBytes ?? 1024 * 1024))
      throw new Error(`the response is larger than ${this.config.maxBytes ?? 1024 * 1024} bytes`);
    return bytes;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    const path = new URL(this.config.url).pathname;
    while (!this.halt.signal.aborted) {
      let wait = this.config.intervalMs;
      try {
        const bytes = await this.read();
        this.polls++;
        attempt = 0;
        const capturedAt = new Date().toISOString();
        const hand = (part: Uint8Array) =>
          this.receive({
            bytes: part,
            contentType: 'application/json',
            transport: { method: 'GET', path },
            capturedAt,
          });
        if (this.config.split) {
          // An empty response (204, no content) holds no messages.
          const parts = bytes.byteLength ? (this.config.split(bytes) ?? [bytes]) : [];
          const digests = parts.map(sha256);
          const fresh = parts.filter((_, index) => !this.lastParts.has(digests[index]!));
          if (!fresh.length) this.unchanged++;
          for (const part of fresh) await hand(part);
          this.lastParts = new Set(digests);
        } else {
          const digest = sha256(bytes);
          if (digest === this.lastDigest) this.unchanged++;
          else {
            await hand(bytes);
            this.lastDigest = digest;
          }
        }
      } catch (error) {
        if (error instanceof ServiceCredentialRefused) throw error;
        if (this.halt.signal.aborted) return;
        wait = retryDelay(attempt++, this.config.retry ?? defaultRetryPolicy, this.config.random);
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
