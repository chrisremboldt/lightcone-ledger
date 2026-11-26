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
import { examplePacksEnabled, registerPackFolder, registerStandardPacks } from '@ledger/standard-packs';
import { runOnce } from './index.js';

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
}

/**
 * The workers' loop, as their own process runs it and as the one-process start runs it beside the API: the worker
 * role's own connections, the same leases and fencing, the same packs as the API.
 */
export function startWorkers(options: WorkerRuntimeOptions = {}): WorkerRuntime {
  const env = options.env ?? process.env;
  refuseOwnerConnection('workers', env);
  if (!env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required for the isolated worker role');
  // The same choice the API makes, so both hold the same packs.
  registerStandardPacks({ examples: examplePacksEnabled(env) });
  // The same folder the API reads, so both hold the same packs.
  registerPackFolder(env.LEDGER_PACKS_DIR);
  const pool = createPool(env.WORKER_DATABASE_URL);
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
          const completed = await runOnce(pool, { objectStore, trace });
          failures = 0;
          if (!completed) await pause(250);
        } catch (error: any) {
          failures++;
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
