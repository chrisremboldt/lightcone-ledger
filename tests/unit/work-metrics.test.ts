import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../packages/metrics/src/index.js';
import { DomainError } from '../../packages/persistence/src/index.js';
import { readySince, registerQueueDepth, runLeases, workerMetrics } from '../../apps/workers/src/work-metrics.js';

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe('the workers metrics', () => {
  it('count each leased item by what became of it, and hold no lease after the pass', async () => {
    const registry = new MetricsRegistry();
    const observer = workerMetrics(registry);
    const retried: string[] = [];
    const leases = ['done', 'taken', 'expired', 'broken'];
    const completed = await runLeases(
      'rule_evaluation',
      leases,
      observer,
      async (lease) => {
        if (lease === 'expired') throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease');
        if (lease === 'broken') throw new Error('the rule could not run');
        return lease === 'done';
      },
      async (lease) => void retried.push(lease),
      (lease) => (lease === 'broken' ? secondsAgo(90) : secondsAgo(1)),
    );
    expect(completed).toBe(1);
    expect(retried).toEqual(['expired', 'broken']);
    const text = await registry.render();
    expect(text).toContain('ledger_worker_leases_total{queue="rule_evaluation",outcome="completed"} 1');
    expect(text).toContain('ledger_worker_leases_total{queue="rule_evaluation",outcome="lost"} 2');
    expect(text).toContain('ledger_worker_leases_total{queue="rule_evaluation",outcome="failed"} 1');
    expect(text).toContain('ledger_worker_leases_held{queue="rule_evaluation"} 0');
    expect(text).toContain('ledger_queue_leased_last_pass{queue="rule_evaluation"} 4');
    expect(text).toContain('ledger_queue_leased_total{queue="rule_evaluation"} 4');
    const oldest = Number(/ledger_queue_oldest_wait_seconds\{queue="rule_evaluation"\} (\S+)/.exec(text)![1]);
    expect(oldest).toBeGreaterThanOrEqual(89);
  });

  it('take each queue’s longest wait from its own pass', async () => {
    const registry = new MetricsRegistry();
    const observer = workerMetrics(registry);
    await runLeases(
      'projection',
      ['a'],
      observer,
      async () => true,
      async () => undefined,
      () => secondsAgo(600),
    );
    const text = await registry.render();
    expect(Number(/ledger_queue_oldest_wait_seconds\{queue="projection"\} (\S+)/.exec(text)![1])).toBeGreaterThan(599);
    expect(text).toContain('ledger_queue_oldest_wait_seconds{queue="rule_evaluation"} 0');
  });

  it('stop a pass on a lost connection without counting it against the work, and release what it held', async () => {
    const registry = new MetricsRegistry();
    const observer = workerMetrics(registry);
    const unavailable = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    await expect(
      runLeases(
        'projection',
        ['a', 'b'],
        observer,
        async () => {
          throw unavailable;
        },
        async () => undefined,
      ),
    ).rejects.toBe(unavailable);
    const text = await registry.render();
    expect(text).toContain('ledger_worker_leases_held{queue="projection"} 0');
    expect(text).toContain('ledger_worker_leases_total{queue="projection",outcome="failed"} 0');
  });

  it('take an item as ready from when it was due, or made available again, whichever is later', () => {
    const due = secondsAgo(10);
    const available = secondsAgo(30);
    expect(readySince({ available_at: available, due_at: due })).toBe(due);
    expect(readySince({ available_at: due, due_at: available })).toBe(due);
    expect(readySince({ available_at: available })).toBe(available);
  });

  it('count notices sent, failed and given up by channel only', async () => {
    const registry = new MetricsRegistry();
    const observer = workerMetrics(registry);
    observer.noticeAttempted('email', 'sent');
    observer.noticeAttempted('email', 'sent');
    observer.noticeAttempted('webhook', 'given_up');
    const text = await registry.render();
    expect(text).toContain('ledger_notices_total{kind="email",outcome="sent"} 2');
    expect(text).toContain('ledger_notices_total{kind="webhook",outcome="given_up"} 1');
    expect(text).toContain('ledger_notices_total{kind="webhook",outcome="failed"} 0');
    expect(text).toContain('ledger_worker_leases_held{queue="notice_delivery"} 0');
  });
});

describe('the queue depth across organizations', () => {
  const rows = [
    { queue: 'projection', ready: '3', leased: '1', oldest_ready_seconds: 12.5 },
    { queue: 'rule_evaluation', ready: '40', leased: '20', oldest_ready_seconds: 95 },
    { queue: 'evaluation_deadline', ready: '0', leased: '0', oldest_ready_seconds: 0 },
    { queue: 'notice_delivery', ready: '2', leased: '0', oldest_ready_seconds: 400 },
  ];

  it('gauges what ledger_queue_figures() returns, and takes the evaluation lag from the evaluation queues', async () => {
    const registry = new MetricsRegistry();
    const queries: string[] = [];
    registerQueueDepth(registry, {
      query: (async (sql: string) => {
        queries.push(sql);
        return { rows };
      }) as never,
    });
    const text = await registry.render();
    expect(queries).toEqual(['SELECT * FROM ledger_queue_figures()']);
    expect(text).toContain('ledger_queue_ready_items{queue="rule_evaluation"} 40');
    expect(text).toContain('ledger_queue_leased_items{queue="projection"} 1');
    expect(text).toContain('ledger_queue_oldest_ready_seconds{queue="notice_delivery"} 400');
    expect(text).toMatch(/^ledger_evaluation_lag_seconds 95$/m);
    expect(text).toMatch(/^ledger_queue_figures_timestamp_seconds \d+$/m);
  });

  it('keeps the last figures when the database cannot be read', async () => {
    const registry = new MetricsRegistry();
    let reachable = true;
    registerQueueDepth(registry, {
      query: (async () => {
        if (!reachable) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
        return { rows };
      }) as never,
    });
    await registry.render();
    reachable = false;
    expect(await registry.render()).toContain('ledger_queue_ready_items{queue="projection"} 3');
  });
});
