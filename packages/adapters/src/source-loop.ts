import type { ObservationV1 } from '@ledger/contracts';
import {
  type ObservationAdapter,
  type ObservationEnvelope,
  type ObservationSink,
  type SubmissionOutcome,
  type TranslationContext,
  type VendorMessage,
  translateAndSubmit,
} from './adapter-contract.js';

/** What one message came to: observations submitted, a message translate refused, or nothing to submit. */
export interface MessageOutcome<O extends ObservationEnvelope = ObservationV1> extends SubmissionOutcome<O> {
  readonly status: 'submitted' | 'rejected' | 'empty';
}

/**
 * Receive, translate, submit: the one step every capture runs for a message, in the adapter process and in the
 * simulator. Translates with the adapter, retains the original bytes once, submits each observation under the
 * adapters' idempotency keys, so the same message submitted again changes nothing. A failure to submit is thrown.
 */
export async function submitVendorMessage<Binding, O extends ObservationEnvelope = ObservationV1>(
  adapter: ObservationAdapter<Binding, O>,
  message: VendorMessage,
  context: TranslationContext<Binding>,
  sink: ObservationSink<O>,
): Promise<MessageOutcome<O>> {
  const outcome = await translateAndSubmit(adapter, message, context, sink);
  const status = outcome.submitted.length ? 'submitted' : outcome.rejections.length ? 'rejected' : 'empty';
  return { ...outcome, status };
}

/**
 * What a failed submission means for the payload: try it again later, drop it because Ledger refused it as it is,
 * or stop because Ledger refused the credential itself (or what the credential may do).
 */
export type SubmissionFailure = 'retry' | 'refused' | 'credential';

// Read by shape rather than instanceof: the refusal may come from another copy of this package.
function refusalStatus(error: unknown): { status: number; code: string } | undefined {
  if (!(error instanceof Error) || error.name !== 'ObservationSinkRefusal') return undefined;
  const { status, code } = error as Error & { status?: unknown; code?: unknown };
  return typeof status === 'number' ? { status, code: typeof code === 'string' ? code : 'unknown' } : undefined;
}

export function classifySubmissionFailure(error: unknown): SubmissionFailure {
  const refusal = refusalStatus(error);
  if (!refusal) return 'retry';
  if (refusal.status === 401 || refusal.status === 403) return 'credential';
  if (refusal.status === 408 || refusal.status === 429 || refusal.status >= 500) return 'retry';
  return refusal.status >= 400 ? 'refused' : 'retry';
}

/** Ledger refused the credential, or what it may do. Retrying cannot help: a person has to act. */
export class CredentialRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Ledger refused the credential with ${status} ${code}`);
    this.name = 'CredentialRefused';
  }
}

export interface RetryPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
}
export const defaultRetryPolicy: RetryPolicy = { initialMs: 500, maxMs: 60_000 };

/**
 * The wait before retry number `attempt` (from 0): doubling from the initial wait up to the cap, then jittered to
 * between half and all of it, so processes that lost the same service do not all come back at the same instant.
 */
export function retryDelay(attempt: number, policy: RetryPolicy = defaultRetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxMs, policy.initialMs * 2 ** Math.min(Math.max(attempt, 0), 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** Resolves after `ms`, or as soon as the signal aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * How the loop treats its queue when Ledger cannot be reached. `latest`: periodic state such as positions, where a
 * newer message supersedes an older one; when the queue is full the oldest is dropped and counted. `every`: events,
 * none of which may be lost; when the queue is full the transport is held until there is room.
 */
export type DeliveryKind = 'latest' | 'every';

/** One line of the loop's log. Never carries a secret or a payload's content. */
export interface SourceLoopEvent {
  readonly event: string;
  readonly message: string;
  readonly [detail: string]: unknown;
}

export interface SourceLoopConfig<Binding, O extends ObservationEnvelope = ObservationV1> {
  readonly adapter: ObservationAdapter<Binding, O>;
  readonly context: TranslationContext<Binding>;
  readonly sink: ObservationSink<O>;
  readonly delivery: DeliveryKind;
  /** Messages held while Ledger cannot be reached. Default 10,000. */
  readonly queueLimit?: number;
  readonly retry?: RetryPolicy;
  readonly random?: () => number;
  readonly log?: (event: SourceLoopEvent) => void;
}

export interface SourceLoopStats {
  received: number;
  submittedMessages: number;
  observations: number;
  rejected: number;
  refused: number;
  dropped: number;
  retries: number;
  queued: number;
}

const DEFAULT_QUEUE_LIMIT = 10_000;
const MAX_LOGGED_REASONS = 50;
const STOP_GRACE_MS = 2_000;

/**
 * Receives messages from a transport, translates them with one adapter and submits them to Ledger, in order. A
 * submission that fails for a reason that may pass (Ledger unreachable, busy or failing) is retried with capped,
 * jittered backoff under the same idempotency keys; one Ledger refuses as invalid is dropped and the reason logged;
 * a refused credential stops the loop. The queue is bounded (see DeliveryKind).
 */
export class SourceLoop<Binding, O extends ObservationEnvelope = ObservationV1> {
  private readonly queue: VendorMessage[] = [];
  private readonly spaceWaiters: (() => void)[] = [];
  private wake?: () => void;
  private closed = false;
  private readonly halt = new AbortController();
  private running?: Promise<void>;
  private readonly limit: number;
  private readonly counts: Omit<SourceLoopStats, 'queued'> = {
    received: 0,
    submittedMessages: 0,
    observations: 0,
    rejected: 0,
    refused: 0,
    dropped: 0,
    retries: 0,
  };
  private droppedSinceLogged = 0;
  private readonly loggedReasons = new Set<string>();
  private firstSubmitted = false;

  constructor(private readonly config: SourceLoopConfig<Binding, O>) {
    this.limit = config.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error('The queue limit is a positive integer');
  }

  get stats(): SourceLoopStats {
    return { ...this.counts, queued: this.queue.length };
  }

  private log(event: SourceLoopEvent): void {
    this.config.log?.(event);
  }

  /**
   * Takes one message from the transport. Resolves once the loop holds it; for `every` delivery with a full queue,
   * only when there is room, so the transport can hold the source back.
   */
  async offer(message: VendorMessage): Promise<void> {
    if (this.closed) throw new Error('The source loop is stopping and takes no more messages');
    if (this.config.delivery === 'every')
      while (this.queue.length >= this.limit && !this.closed) {
        await new Promise<void>((resolve) => this.spaceWaiters.push(resolve));
      }
    else if (this.queue.length >= this.limit) {
      this.queue.shift();
      this.counts.dropped++;
      if (this.droppedSinceLogged++ === 0)
        this.log({
          event: 'queue_full_dropping_oldest',
          message: `The queue holds ${this.limit} messages; the oldest is dropped for each new one until Ledger accepts again.`,
          limit: this.limit,
        });
    }
    if (this.closed) throw new Error('The source loop is stopping and takes no more messages');
    this.counts.received++;
    this.queue.push(message);
    this.wake?.();
  }

  /** Starts submitting. The promise settles when the loop stops: it rejects with CredentialRefused. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  private async next(): Promise<VendorMessage | undefined> {
    while (!this.queue.length) {
      if (this.closed || this.halt.signal.aborted) return undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
    return this.queue[0];
  }

  private release(): void {
    this.queue.shift();
    this.spaceWaiters.shift()?.();
    if (this.droppedSinceLogged && !this.queue.length) {
      this.log({
        event: 'queue_recovered',
        message: `Ledger is accepting again; ${this.droppedSinceLogged} of the oldest messages were dropped while it was not.`,
        dropped: this.droppedSinceLogged,
      });
      this.droppedSinceLogged = 0;
    }
  }

  private logOnce(key: string, event: SourceLoopEvent): void {
    if (this.loggedReasons.has(key)) return;
    if (this.loggedReasons.size < MAX_LOGGED_REASONS) this.loggedReasons.add(key);
    this.log(event);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    for (;;) {
      const message = await this.next();
      if (!message || this.halt.signal.aborted) return;
      try {
        const outcome = await submitVendorMessage(this.config.adapter, message, this.config.context, this.config.sink);
        attempt = 0;
        this.counted(outcome);
        this.release();
      } catch (error) {
        const failure = classifySubmissionFailure(error);
        const { status, code } = error as { status?: number; code?: string };
        if (failure === 'credential') {
          this.closed = true;
          this.halt.abort();
          for (const resolve of this.spaceWaiters.splice(0)) resolve();
          throw new CredentialRefused(status ?? 0, code ?? 'unknown');
        }
        if (failure === 'refused') {
          this.counts.refused++;
          this.logOnce(`refused:${status}:${code}`, {
            event: 'payload_refused',
            message: `Ledger refused a payload as it is (${status} ${code}); it is not sent again.`,
            status,
            code,
          });
          this.release();
          continue;
        }
        const wait = retryDelay(attempt++, this.config.retry, this.config.random);
        this.counts.retries++;
        this.log({
          event: 'submission_failed_retrying',
          message: `Could not submit to Ledger (${describeFailure(error)}); trying the same payload again in ${wait} ms.`,
          attempt,
          waitMs: wait,
          queued: this.queue.length,
        });
        await pause(wait, this.halt.signal);
      }
    }
  }

  private counted(outcome: MessageOutcome<O>): void {
    if (outcome.status === 'submitted') {
      this.counts.submittedMessages++;
      this.counts.observations += outcome.submitted.length;
      if (!this.firstSubmitted) {
        this.firstSubmitted = true;
        this.log({
          event: 'first_submitted',
          message: `Ledger accepted the first message: ${outcome.submitted.length} observation(s), receipt ${outcome.submitted[0]!.receiptId}.`,
          receipts: outcome.submitted.map((item) => item.receiptId),
        });
      }
    }
    if (outcome.status === 'rejected') {
      this.counts.rejected++;
      for (const rejection of outcome.rejections)
        this.logOnce(`rejected:${rejection.reason}`, {
          event: 'message_rejected',
          message: `The adapter did not translate a message: ${rejection.reason}`,
          reason: rejection.reason,
          ...(rejection.locator ? { locator: rejection.locator.value } : {}),
        });
    }
    if (outcome.status === 'submitted' && outcome.rejections.length)
      for (const rejection of outcome.rejections)
        this.logOnce(`rejected:${rejection.reason}`, {
          event: 'part_rejected',
          message: `The adapter left part of a message out: ${rejection.reason}`,
          reason: rejection.reason,
        });
  }

  /** Logs the counts so far, and lets a reason already logged be logged again in the next period. */
  summary(): SourceLoopStats {
    const stats = this.stats;
    this.loggedReasons.clear();
    this.log({
      event: 'summary',
      message: `Received ${stats.received}, submitted ${stats.submittedMessages} (${stats.observations} observations), translation refused ${stats.rejected}, Ledger refused ${stats.refused}, dropped ${stats.dropped}, queued ${stats.queued}.`,
      ...stats,
    });
    return stats;
  }

  /**
   * Takes no more messages and keeps submitting until the queue is empty or the deadline passes. Resolves with the
   * number of messages left unsubmitted.
   */
  async stop(deadlineMs: number): Promise<number> {
    this.closed = true;
    for (const resolve of this.spaceWaiters.splice(0)) resolve();
    this.wake?.();
    const running = this.running?.catch(() => {});
    if (running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([running, new Promise<void>((resolve) => (timer = setTimeout(resolve, deadlineMs)))]);
      clearTimeout(timer);
    }
    this.halt.abort();
    this.wake?.();
    // A submission already sent is given a moment to answer; its message counts as unsubmitted if it does not.
    if (running) await Promise.race([running, pause(STOP_GRACE_MS)]);
    return this.queue.length;
  }
}

/** A failure in words that carry no secret and no payload content. */
export function describeFailure(error: unknown): string {
  const refusal = refusalStatus(error);
  if (refusal) return `Ledger answered ${refusal.status} ${refusal.code}`;
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: unknown } }).cause;
    const words = error.message.slice(0, 200);
    return typeof cause?.code === 'string' ? `${words}: ${cause.code}` : words;
  }
  return 'an unknown failure';
}
