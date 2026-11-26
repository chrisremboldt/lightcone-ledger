import { isDatabaseUnavailable, type Pool } from '@ledger/persistence';
import type { MetricsRegistry } from '@ledger/metrics';

/**
 * The queues the workers lease from. A queue added later adds its name here, reports through the same observer and
 * is counted by ledger_queue_figures() in a migration; a queue that holds evaluation work is listed in
 * EVALUATION_QUEUES too.
 */
export const WORK_QUEUES = [
  'projection',
  'rule_selection',
  'evaluation_deadline',
  'rule_evaluation',
  'notice_delivery',
  'notice_schedule',
  'program_read',
] as const;
export type WorkQueue = (typeof WORK_QUEUES)[number];
const EVALUATION_QUEUES: readonly WorkQueue[] = ['rule_selection', 'evaluation_deadline', 'rule_evaluation'];

/** What became of one leased item. */
export type LeaseOutcome = 'completed' | 'lost' | 'failed';
/** What one attempt to send a notice came to, as its attempt is recorded. */
export type NoticeOutcome = 'sent' | 'failed' | 'given_up';

/** Told what the workers lease and what becomes of it. Every method is optional to call and must not throw. */
export interface WorkObserver {
  /** A pass leased this many items from the queue. */
  leased(queue: WorkQueue, count: number): void;
  /** One leased item had been ready to run since this time. */
  waited(queue: WorkQueue, readySince: Date): void;
  settled(queue: WorkQueue, outcome: LeaseOutcome): void;
  /** The pass is done with the queue: it holds none of its leases any more. */
  finished(queue: WorkQueue): void;
  /** An attempt to send a notice was recorded, by its channel. */
  noticeAttempted(channel: 'email' | 'webhook', outcome: NoticeOutcome): void;
}

/** When a leased item became ready to run: when it was due, or when it was last made available, whichever is later. */
export function readySince(lease: { available_at: Date; due_at?: Date }): Date {
  return lease.due_at && lease.due_at > lease.available_at ? lease.due_at : lease.available_at;
}

// Read by shape rather than instanceof: the error may come from another copy of the persistence package.
function lostLease(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'worker_lease_expired';
}

/**
 * Runs each leased item in order, as every queue's loop does: an item whose lease was lost or whose run failed has
 * its retry recorded, and a lost connection stops the pass with the work left for its lease to run out.
 */
export async function runLeases<L>(
  queue: WorkQueue,
  leases: readonly L[],
  observer: WorkObserver | undefined,
  run: (lease: L) => Promise<boolean>,
  retry: (lease: L, error: unknown) => Promise<void>,
  ready?: (lease: L) => Date,
): Promise<number> {
  observer?.leased(queue, leases.length);
  if (ready) for (const lease of leases) observer?.waited(queue, ready(lease));
  let completed = 0;
  try {
    for (const lease of leases) {
      try {
        if (await run(lease)) {
          completed++;
          observer?.settled(queue, 'completed');
        } else observer?.settled(queue, 'lost');
      } catch (error) {
        // A lost connection is not recorded as the work's error: the worker waits for the database, and the work is
        // leased again once its lease runs out.
        if (isDatabaseUnavailable(error)) throw error;
        observer?.settled(queue, lostLease(error) ? 'lost' : 'failed');
        await retry(lease, error);
      }
    }
  } finally {
    observer?.finished(queue);
  }
  return completed;
}

const WAIT_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 3600];

/** The workers' figures: what each queue leased, how long it had waited, the leases held, lost and failed. */
export function workerMetrics(registry: MetricsRegistry): WorkObserver & { passed(ok: boolean): void } {
  const leased = registry.counter('ledger_queue_leased_total', 'Items this process leased, by queue.', ['queue']);
  const lastPass = registry.gauge(
    'ledger_queue_leased_last_pass',
    'Items the last pass leased from the queue, at most 20 a pass: 20 means more were waiting.',
    ['queue'],
  );
  const oldest = registry.gauge(
    'ledger_queue_oldest_wait_seconds',
    'How long the longest-waiting item the last pass leased had been ready to run; 0 when the pass leased none.',
    ['queue'],
  );
  const wait = registry.histogram(
    'ledger_queue_wait_seconds',
    'How long each leased item had been ready to run before this process leased it.',
    ['queue'],
    WAIT_BUCKETS,
  );
  const notices = registry.counter(
    'ledger_notices_total',
    'Attempts to send a notice, by channel: sent, failed (tried again later) or given up.',
    ['kind', 'outcome'],
  );
  const held = registry.gauge('ledger_worker_leases_held', 'Leases this process holds now.', ['queue']);
  const outcomes = registry.counter(
    'ledger_worker_leases_total',
    'Leased items by what became of them: completed, lost (another worker or the lease running out took it) or failed (retried later).',
    ['queue', 'outcome'],
  );
  const passes = registry.counter('ledger_worker_passes_total', 'Passes over the queues, by outcome.', ['outcome']);
  const lastPassAt = registry.gauge(
    'ledger_worker_last_pass_timestamp_seconds',
    'When the last pass over the queues ended, in seconds since the Unix epoch.',
  );
  const longest = new Map<WorkQueue, number>();
  for (const queue of WORK_QUEUES) {
    leased.inc({ queue }, 0);
    held.set({ queue }, 0);
    oldest.set({ queue }, 0);
    lastPass.set({ queue }, 0);
    for (const outcome of ['completed', 'lost', 'failed'] as const) outcomes.inc({ queue, outcome }, 0);
  }
  for (const outcome of ['completed', 'failed']) passes.inc({ outcome }, 0);
  for (const kind of ['email', 'webhook'])
    for (const outcome of ['sent', 'failed', 'given_up']) notices.inc({ kind, outcome }, 0);
  return {
    leased(queue, count) {
      leased.inc({ queue }, count);
      lastPass.set({ queue }, count);
      held.set({ queue }, count);
      longest.set(queue, 0);
    },
    waited(queue, since) {
      const seconds = Math.max(0, (Date.now() - since.getTime()) / 1000);
      wait.observe({ queue }, seconds);
      longest.set(queue, Math.max(longest.get(queue) ?? 0, seconds));
    },
    settled(queue, outcome) {
      held.dec({ queue });
      outcomes.inc({ queue, outcome });
    },
    finished(queue) {
      held.set({ queue }, 0);
      oldest.set({ queue }, longest.get(queue) ?? 0);
    },
    noticeAttempted(kind, outcome) {
      notices.inc({ kind, outcome });
    },
    passed(ok) {
      passes.inc({ outcome: ok ? 'completed' : 'failed' });
      lastPassAt.set({}, Math.round(Date.now() / 1000));
    },
  };
}

interface QueueFigures {
  queue: string;
  ready: string;
  leased: string;
  oldest_ready_seconds: number;
}

/**
 * Every queue's depth across all organizations, read at each collection from ledger_queue_figures(), which returns
 * counts and ages only. When the database cannot be read the figures keep their last values and the read's time says
 * how old they are.
 */
export function registerQueueDepth(registry: MetricsRegistry, pool: Pick<Pool, 'query'>): void {
  const ready = registry.gauge(
    'ledger_queue_ready_items',
    'Items ready to run now in each queue, across every organization: due and not leased, or with a lease run out.',
    ['queue'],
  );
  const leased = registry.gauge(
    'ledger_queue_leased_items',
    'Items held under a live lease in each queue, across every organization.',
    ['queue'],
  );
  const oldest = registry.gauge(
    'ledger_queue_oldest_ready_seconds',
    'How long the longest-ready item of each queue has waited, across every organization; 0 when none is ready.',
    ['queue'],
  );
  const lag = registry.gauge(
    'ledger_evaluation_lag_seconds',
    'How far evaluation is behind: the longest wait among the ready items of the evaluation queues.',
  );
  const readAt = registry.gauge(
    'ledger_queue_figures_timestamp_seconds',
    'When the queue figures were last read from the database, in seconds since the Unix epoch.',
  );
  registry.onCollect(async () => {
    let rows: QueueFigures[];
    try {
      rows = (await pool.query<QueueFigures>('SELECT * FROM ledger_queue_figures()')).rows;
    } catch {
      return;
    }
    const known = new Set<string>(WORK_QUEUES);
    let behind = 0;
    for (const row of rows) {
      if (!known.has(row.queue)) continue;
      const queue = row.queue as WorkQueue;
      ready.set({ queue }, Number(row.ready));
      leased.set({ queue }, Number(row.leased));
      oldest.set({ queue }, Number(row.oldest_ready_seconds));
      if (EVALUATION_QUEUES.includes(queue)) behind = Math.max(behind, Number(row.oldest_ready_seconds));
    }
    lag.set({}, behind);
    readAt.set({}, Math.round(Date.now() / 1000));
  });
}
