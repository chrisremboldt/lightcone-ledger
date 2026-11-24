import 'dotenv/config';
import {
  assertWorkerRole,
  createObjectStore,
  createPool,
  databaseRetryDelay,
  refuseOwnerConnection,
  untilDatabaseReachable,
} from '@ledger/persistence';
import { examplePacksEnabled, registerPackFolder, registerStandardPacks } from '@ledger/standard-packs';
import { runOnce } from './index.js';
refuseOwnerConnection('workers');
if (!process.env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required for the isolated worker role');
// The same choice the API makes, so both processes hold the same packs.
registerStandardPacks({ examples: examplePacksEnabled() });
// The same folder the API reads, so both processes hold the same packs.
registerPackFolder(process.env.LEDGER_PACKS_DIR);
const pool = createPool(process.env.WORKER_DATABASE_URL);
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
// The workers start while their database is still starting, and pick their work up again whenever it comes back.
await untilDatabaseReachable(() => assertWorkerRole(pool));
const objectStore = createObjectStore();
let failures = 0;
try {
  while (!stopping) {
    try {
      const completed = await runOnce(pool, { objectStore, trace: (entry) => console.log(JSON.stringify(entry)) });
      failures = 0;
      if (!completed) await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error: any) {
      failures++;
      console.error('Worker database operation failed', { code: error.code ?? 'unknown' });
      await new Promise((resolve) => setTimeout(resolve, databaseRetryDelay(failures)));
    }
  }
} finally {
  await pool.end();
}
