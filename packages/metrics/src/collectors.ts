import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { MetricsRegistry } from './registry.js';

/** The process's own figures: CPU time, memory, how late the event loop runs, and when it started. */
export function registerProcessMetrics(registry: MetricsRegistry): void {
  const cpu = registry.counter('ledger_process_cpu_seconds_total', 'CPU time the process has used, user and system.');
  const resident = registry.gauge('ledger_process_resident_memory_bytes', 'Resident memory of the process.');
  const heap = registry.gauge('ledger_process_heap_used_bytes', 'JavaScript heap in use.');
  const started = registry.gauge(
    'ledger_process_start_time_seconds',
    'When the process started, in seconds since the Unix epoch.',
  );
  const delay = registry.gauge(
    'ledger_process_event_loop_delay_seconds',
    'The longest delay of the event loop since the previous collection: how late timers and I/O callbacks ran.',
  );
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  started.set({}, Math.round((Date.now() - process.uptime() * 1000) / 1000));
  registry.onCollect(() => {
    const usage = process.cpuUsage();
    cpu.setTotal({}, (usage.user + usage.system) / 1e6);
    const memory = process.memoryUsage();
    resident.set({}, memory.rss);
    heap.set({}, memory.heapUsed);
    delay.set({}, Number.isFinite(loop.max) ? loop.max / 1e9 : 0);
    loop.reset();
  });
}

/** What a connection pool reports about itself; node-postgres's Pool has these. */
export interface PoolFigures {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly options?: { max?: number };
}

/** A database pool's connections in use and idle, and the requests waiting for one, under the pool's role name. */
export function registerPoolMetrics(registry: MetricsRegistry, poolName: 'api' | 'workers', pool: PoolFigures): void {
  const connections = registry.gauge(
    'ledger_database_pool_connections',
    'Connections the pool holds open, in use or idle.',
    ['pool', 'state'],
  );
  const waiting = registry.gauge(
    'ledger_database_pool_waiting_requests',
    'Queries waiting for a connection because every connection of the pool is in use.',
    ['pool'],
  );
  const max = registry.gauge('ledger_database_pool_max_connections', 'The most connections the pool opens.', ['pool']);
  registry.onCollect(() => {
    connections.set({ pool: poolName, state: 'in_use' }, pool.totalCount - pool.idleCount);
    connections.set({ pool: poolName, state: 'idle' }, pool.idleCount);
    waiting.set({ pool: poolName }, pool.waitingCount);
    if (pool.options?.max !== undefined) max.set({ pool: poolName }, pool.options.max);
  });
}
