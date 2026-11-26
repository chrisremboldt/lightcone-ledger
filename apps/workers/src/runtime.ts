import {
  assertObjectStoreReady,
  assertWorkerRole,
  createObjectStore,
  createPool,
  databaseRetryDelay,
  refuseOwnerConnection,
  untilDatabaseReachable,
  type ObjectStore,
} from '@ledger/persistence';
import { configureNoticeChannels, noticeDeployment } from '@ledger/domain';
import { registerPoolMetrics, type MetricsRegistry } from '@ledger/metrics';
import { examplePacksEnabled, registerPackFolder, registerStandardPacks } from '@ledger/standard-packs';
import { runOnce } from './index.js';
import { registerQueueDepth, workerMetrics } from './work-metrics.js';

export interface WorkerRuntime {
  /** Asks the loop to stop after the work it holds, and waits for it. */
  stop(): Promise<void>;
  /** Settles when the loop has stopped and its connections are closed. */
  done: Promise<void>;
}

export interface WorkerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  objectStore?: ObjectStore;
  trace?: (entry: unknown) => void;
  /** The process's metrics; unset, the loop measures nothing. */
  metrics?: MetricsRegistry;
}

/**
 * The workers' loop, as their own process runs it and as the one-process start runs it beside the API: the worker
 * role's own connections, the same leases and fencing, the same packs as the API.
 */
export function startWorkers(options: WorkerRuntimeOptions = {}): WorkerRuntime {
  const env = options.env ?? process.env;
  refuseOwnerConnection('workers', env);
  if (!env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required for the isolated worker role');
  // Email notices need a mail server and the address links open at; a start with one and not the other is refused.
  const deployment = noticeDeployment(env);
  configureNoticeChannels({ email: Boolean(deployment.smtp) });
  const ledgerEnv = env.LEDGER_ENV ?? (env.NODE_ENV === 'production' ? 'staging' : 'local');
  const notices = { deployment, httpWebhooks: ledgerEnv === 'local' };
  const programReads = { httpAddresses: ledgerEnv === 'local' };
  // The same choice the API makes, so both hold the same packs.
  registerStandardPacks({ examples: examplePacksEnabled(env) });
  // The same folder the API reads, so both hold the same packs.
  registerPackFolder(env.LEDGER_PACKS_DIR);
  const pool = createPool(env.WORKER_DATABASE_URL);
  const observer = options.metrics ? workerMetrics(options.metrics) : undefined;
  if (options.metrics) {
    registerPoolMetrics(options.metrics, 'workers', pool);
    registerQueueDepth(options.metrics, pool);
  }
  const trace = options.trace ?? ((entry: unknown) => console.log(JSON.stringify(entry)));
  let stopping = false;
  let wake: (() => void) | undefined;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const done = (async () => {
    try {
      // The workers start while their database is still starting, and pick their work up again whenever it comes back.
      await untilDatabaseReachable(() => assertWorkerRole(pool));
      await assertObjectStoreReady(env);
      const objectStore = options.objectStore ?? createObjectStore(env);
      let failures = 0;
      while (!stopping) {
        try {
          const completed = await runOnce(pool, { objectStore, notices, programReads, trace, observer });
          observer?.passed(true);
          failures = 0;
          if (!completed) await pause(250);
        } catch (error: any) {
          failures++;
          observer?.passed(false);
          console.error('Worker database operation failed', { code: error.code ?? 'unknown' });
          await pause(databaseRetryDelay(failures));
        }
      }
    } finally {
      await pool.end();
    }
  })();
  return {
    done,
    async stop() {
      stopping = true;
      wake?.();
      await done.catch(() => undefined);
    },
  };
}
