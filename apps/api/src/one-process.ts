import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertObjectStoreReady, refuseOwnerConnection } from '@ledger/persistence';
import { startWorkers, type WorkerRuntime } from '@ledger/workers';
import { createApp, type AppOptions } from './index.js';
import { localInvestigationOptions } from './investigation-startup.js';
import { developmentSignInNotice } from './openid-connect.js';
import { setupEnvironment } from './organization-setup.js';

export interface OneProcess {
  app: Awaited<ReturnType<typeof createApp>>;
  workers: WorkerRuntime;
  /** Stops the workers after the work they hold, then the API. */
  stop(): Promise<void>;
}

/**
 * The API, which also serves the web app, and the workers in one Node process, for a small operation. It is the same
 * code as the split start: the API connects as ledger_app and the workers as ledger_worker, each with its own pool,
 * under the same row-level security; the workers take and fence their leases exactly as in a process of their own.
 */
export async function startOneProcess(
  options: { port?: number; host?: string; app?: AppOptions; env?: NodeJS.ProcessEnv } = {},
): Promise<OneProcess> {
  const env = options.env ?? process.env;
  refuseOwnerConnection('API', env);
  refuseOwnerConnection('workers', env);
  if (!options.app?.objectStore) await assertObjectStoreReady(env);
  const app = await createApp({ logger: true, investigation: localInvestigationOptions(env), ...options.app });
  const notice = developmentSignInNotice(setupEnvironment(env));
  if (notice) app.log.warn(notice);
  await app.listen({ port: options.port ?? Number(env.PORT ?? 4000), host: options.host ?? env.HOST ?? '0.0.0.0' });
  let workers: WorkerRuntime;
  try {
    workers = startWorkers({ env, objectStore: options.app?.objectStore });
  } catch (error) {
    await app.close();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await workers.stop();
      await app.close();
    })());
  return { app, workers, stop };
}

/** The one-process start, as `node apps/api/dist/one-process.js` and the image's `one-process` command run it. */
export async function runOneProcess(): Promise<number> {
  let running: OneProcess;
  try {
    running = await startOneProcess();
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'one_process_start_failed', error: error instanceof Error ? error.message : 'unknown' }),
    );
    return 1;
  }
  let exitCode = 0;
  const stop = () => void running.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // The workers' loop ends only when asked to stop; if it ends on its own the process stops, as the split start does
  // when its workers process exits.
  await running.workers.done.catch((error) => {
    exitCode = 1;
    running.app.log.error({ error: error instanceof Error ? error.message : 'unknown' }, 'The workers stopped');
  });
  await running.stop();
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runOneProcess();
