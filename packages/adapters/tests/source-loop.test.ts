import { describe, expect, it } from 'vitest';
import type { ObservationV1 } from '@ledger/contracts';
import {
  InMemoryObservationSink,
  type ObservationSink,
  type RetainOriginalRequest,
  type TranslationContext,
  type VendorMessage,
} from '../src/adapter-contract.js';
import { djiOsdPositionAdapter, type DjiOsdBinding } from '../src/dji-osd-position.js';
import { ObservationSinkRefusal } from '../src/http-observation-sink.js';
import {
  CredentialRefused,
  classifySubmissionFailure,
  retryDelay,
  SourceLoop,
  type SourceLoopEvent,
} from '../src/source-loop.js';
import { ServiceCredentialRefused, ServicePoll, transportUrl } from '../src/source-transports.js';
import { djiOsdBytes } from '../../../apps/emulators/src/dji.js';

const binding = { deviceId: 'LOOP-AIRCRAFT-01', gatewayId: 'LOOP-DOCK-01' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const topic = `thing/product/${binding.deviceId}/osd`;
const fast = { initialMs: 1, maxMs: 4 };

function message(index: number, gatewayId = binding.gatewayId): VendorMessage {
  return {
    bytes: djiOsdBytes(
      {
        occurredAt: new Date(Date.parse('2026-10-01T17:00:00.000Z') + index * 1000).toISOString(),
        latitude: 41.881234,
        longitude: -87.631234,
        horizontalSpeed: 7,
      },
      gatewayId,
      { tid: `tid-loop-${index}`, bid: `bid-loop-${index}` },
    ),
    contentType: 'application/json',
    transport: { topic },
    capturedAt: new Date().toISOString(),
  };
}

/** The in-memory sink, with a switch that makes submissions fail the way an unreachable or refusing API does. */
class ScriptedSink implements ObservationSink {
  readonly stored = new InMemoryObservationSink();
  readonly keys: string[] = [];
  failure?: () => Error;
  async retainOriginal(request: RetainOriginalRequest) {
    if (this.failure) throw this.failure();
    return this.stored.retainOriginal(request);
  }
  async submitObservation(observation: ObservationV1, key: string) {
    this.keys.push(key);
    if (this.failure) throw this.failure();
    return this.stored.submitObservation(observation, key);
  }
}

const unreachable = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const refused = (status: number, code: string) => () =>
  new ObservationSinkRefusal('submit_observation', status, code, 'Refused by the fake');

function loopWith(sink: ObservationSink, options: { delivery?: 'latest' | 'every'; queueLimit?: number } = {}) {
  const events: SourceLoopEvent[] = [];
  const loop = new SourceLoop({
    adapter: djiOsdPositionAdapter,
    context,
    sink,
    delivery: options.delivery ?? 'latest',
    queueLimit: options.queueLimit,
    retry: fast,
    random: () => 0.5,
    log: (event) => events.push(event),
  });
  return { loop, events };
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('the source loop', () => {
  it('backs off by doubling to a cap, jittered between half and all of the wait', () => {
    const policy = { initialMs: 500, maxMs: 60_000 };
    expect([0, 1, 2, 3].map((attempt) => retryDelay(attempt, policy, () => 1))).toEqual([500, 1000, 2000, 4000]);
    expect(retryDelay(20, policy, () => 1)).toBe(60_000);
    expect(retryDelay(20, policy, () => 0)).toBe(30_000);
    expect(retryDelay(1000, policy, () => 0.5)).toBe(45_000);
  });

  it('sorts a failed submission into try again, refused as it is, or a refused credential', () => {
    expect(classifySubmissionFailure(unreachable())).toBe('retry');
    expect(classifySubmissionFailure(refused(503, 'unavailable')())).toBe('retry');
    expect(classifySubmissionFailure(refused(429, 'rate_limited')())).toBe('retry');
    expect(classifySubmissionFailure(refused(400, 'invalid_observation')())).toBe('refused');
    expect(classifySubmissionFailure(refused(409, 'idempotency_conflict')())).toBe('refused');
    expect(classifySubmissionFailure(refused(401, 'unauthenticated')())).toBe('credential');
    expect(classifySubmissionFailure(refused(403, 'forbidden')())).toBe('credential');
  });

  it('submits again after a failed submission, under the same keys, without a duplicate', async () => {
    const sink = new ScriptedSink();
    sink.failure = unreachable;
    const { loop, events } = loopWith(sink);
    const running = loop.start();
    await loop.offer(message(1));
    await until(() => loop.stats.retries >= 2);
    sink.failure = undefined;
    await until(() => loop.stats.submittedMessages === 1);
    expect(sink.stored.observations).toHaveLength(1);
    expect(new Set(sink.keys).size).toBe(1);
    expect(events.filter((event) => event.event === 'submission_failed_retrying').length).toBeGreaterThanOrEqual(2);
    expect(events.find((event) => event.event === 'submission_failed_retrying')?.message).toContain('ECONNREFUSED');

    // A restarted process receives the same message again: the keys are the same, so nothing new is stored.
    const restarted = loopWith(sink).loop;
    const again = restarted.start();
    await restarted.offer(message(1));
    expect(await restarted.stop(1000)).toBe(0);
    expect(sink.stored.observations).toHaveLength(1);
    expect(await loop.stop(1000)).toBe(0);
    await Promise.all([running, again]);
  });

  it('keeps the newest positions when Ledger cannot be reached, and says how many it dropped', async () => {
    const sink = new ScriptedSink();
    sink.failure = unreachable;
    const { loop, events } = loopWith(sink, { queueLimit: 3 });
    const running = loop.start();
    for (const index of [1, 2, 3, 4, 5]) await loop.offer(message(index));
    expect(loop.stats).toMatchObject({ received: 5, dropped: 2, queued: 3 });
    expect(events.filter((event) => event.event === 'queue_full_dropping_oldest')).toHaveLength(1);
    sink.failure = undefined;
    await until(() => loop.stats.queued === 0);
    expect(sink.stored.observations.map((entry) => entry.observation.sourceEventId)).toEqual([
      'tid-loop-3',
      'tid-loop-4',
      'tid-loop-5',
    ]);
    expect(events.find((event) => event.event === 'queue_recovered')).toMatchObject({ dropped: 2 });
    await loop.stop(1000);
    await running;
  });

  it('drops no event: a full queue holds the transport until there is room', async () => {
    const sink = new ScriptedSink();
    sink.failure = unreachable;
    const { loop } = loopWith(sink, { delivery: 'every', queueLimit: 2 });
    const running = loop.start();
    await loop.offer(message(1));
    await loop.offer(message(2));
    let held = true;
    const third = loop.offer(message(3)).then(() => (held = false));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(held).toBe(true);
    sink.failure = undefined;
    await third;
    await until(() => loop.stats.queued === 0);
    expect(loop.stats).toMatchObject({ received: 3, dropped: 0, submittedMessages: 3 });
    await loop.stop(1000);
    await running;
  });

  it('drops a payload Ledger refuses as invalid, logs why, and goes on', async () => {
    const sink = new ScriptedSink();
    sink.failure = refused(400, 'invalid_observation');
    const { loop, events } = loopWith(sink);
    const running = loop.start();
    await loop.offer(message(1));
    await until(() => loop.stats.refused === 1);
    sink.failure = undefined;
    await loop.offer(message(2));
    await until(() => loop.stats.submittedMessages === 1);
    expect(loop.stats.retries).toBe(0);
    expect(events.find((event) => event.event === 'payload_refused')).toMatchObject({
      status: 400,
      code: 'invalid_observation',
    });
    await loop.stop(1000);
    await running;
  });

  it('logs a message the adapter will not translate, once per period', async () => {
    const sink = new ScriptedSink();
    const { loop, events } = loopWith(sink);
    const running = loop.start();
    for (const index of [1, 2, 3]) await loop.offer(message(index, 'ANOTHER-DOCK'));
    await until(() => loop.stats.rejected === 3);
    expect(events.filter((event) => event.event === 'message_rejected')).toHaveLength(1);
    expect(sink.stored.observations).toHaveLength(0);
    loop.summary();
    await loop.offer(message(4, 'ANOTHER-DOCK'));
    await until(() => loop.stats.rejected === 4);
    expect(events.filter((event) => event.event === 'message_rejected')).toHaveLength(2);
    await loop.stop(1000);
    await running;
  });

  it('stops when Ledger refuses the credential', async () => {
    const sink = new ScriptedSink();
    sink.failure = refused(401, 'unauthenticated');
    const { loop } = loopWith(sink);
    const running = loop.start();
    await loop.offer(message(1));
    const failure = await running.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialRefused);
    expect(failure).toMatchObject({ status: 401, code: 'unauthenticated' });
    await expect(loop.offer(message(2))).rejects.toThrow('stopping');
  });

  it('flushes what it holds on shutdown, and says what it could not', async () => {
    const sink = new ScriptedSink();
    const { loop } = loopWith(sink);
    for (const index of [1, 2, 3]) await loop.offer(message(index));
    const running = loop.start();
    expect(await loop.stop(5000)).toBe(0);
    await running;
    expect(sink.stored.observations).toHaveLength(3);
    await expect(loop.offer(message(4))).rejects.toThrow('stopping');

    const down = new ScriptedSink();
    down.failure = unreachable;
    const stuck = loopWith(down).loop;
    const stuckRunning = stuck.start();
    for (const index of [1, 2]) await stuck.offer(message(index));
    expect(await stuck.stop(50)).toBe(2);
    await stuckRunning;
  });

  it('never logs a payload or its position', async () => {
    const sink = new ScriptedSink();
    sink.failure = unreachable;
    const { loop, events } = loopWith(sink, { queueLimit: 1 });
    const running = loop.start();
    await loop.offer(message(1));
    await loop.offer(message(2, 'ANOTHER-DOCK'));
    await until(() => loop.stats.retries >= 1);
    sink.failure = undefined;
    await until(() => loop.stats.queued === 0);
    loop.summary();
    await loop.stop(1000);
    await running;
    const logged = JSON.stringify(events);
    expect(logged).not.toMatch(/41\.88|87\.63|tid-loop/);
  });
});

describe('polling a service', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('hands over a response only when it changed, and tries again after a failed read', async () => {
    const answers: (() => Response)[] = [
      () => json(200, { operation: { authorizations: [] } }),
      () => json(200, { operation: { authorizations: [] } }),
      () => json(503, { message: 'busy' }),
      () => json(200, { operation: { authorizations: [{ id: 'A' }] } }),
    ];
    const seen: { headers: Headers }[] = [];
    const received: VendorMessage[] = [];
    const events: SourceLoopEvent[] = [];
    const poll = new ServicePoll(
      {
        url: 'https://service.example.invalid/v1/operations/op-1/laanc',
        headers: { authorization: 'Bearer fictional-secret-token' },
        intervalMs: 5,
        retry: fast,
        fetcher: (async (_url: string, init: RequestInit) => {
          seen.push({ headers: new Headers(init.headers) });
          return (answers.shift() ?? answers[answers.length - 1] ?? (() => json(200, {})))();
        }) as typeof fetch,
        log: (event) => events.push(event),
      },
      async (message) => {
        received.push(message);
      },
    );
    const running = poll.start();
    await until(() => received.length === 2);
    await poll.stop();
    await running;
    expect(received.map((item) => item.transport)).toEqual([
      { method: 'GET', path: '/v1/operations/op-1/laanc' },
      { method: 'GET', path: '/v1/operations/op-1/laanc' },
    ]);
    expect(poll.unchanged).toBe(1);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fictional-secret-token');
    expect(events.map((event) => event.event)).toContain('poll_failed_retrying');
    expect(JSON.stringify(events)).not.toContain('fictional-secret-token');
  });

  it('stops when the service refuses its credential', async () => {
    const poll = new ServicePoll(
      {
        url: 'https://service.example.invalid/v1/operations/op-1/laanc',
        headers: {},
        intervalMs: 1000,
        fetcher: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
      },
      async () => {},
    );
    await expect(poll.start()).rejects.toBeInstanceOf(ServiceCredentialRefused);
  });

  it('sends a secret without TLS only on this host or a private network the operator names', () => {
    const tls = { tls: 'mqtts:', plain: 'mqtt:' };
    expect(transportUrl('mqtt://127.0.0.1:1883', 'Broker', tls, false).port).toBe('1883');
    expect(() => transportUrl('mqtt://broker:1883', 'Broker', tls, false)).toThrow('--private-network');
    expect(transportUrl('mqtt://broker:1883', 'Broker', tls, true).hostname).toBe('broker');
    expect(transportUrl('mqtts://broker.example.invalid', 'Broker', tls, false).protocol).toBe('mqtts:');
    expect(() => transportUrl('mqtts://user:pw@broker.example.invalid', 'Broker', tls, false)).toThrow('password');
  });
});
