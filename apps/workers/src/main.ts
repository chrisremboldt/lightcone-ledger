import 'dotenv/config';
import { startMetrics } from '@ledger/metrics';
import { startWorkers, type WorkerRuntime } from './runtime.js';
const metrics = await startMetrics(process.env);
let workers: WorkerRuntime;
try {
  workers = startWorkers({ metrics: metrics?.registry });
} catch (error) {
  // A setting the start refuses, said plainly and without a stack.
  console.error((error as Error).message);
  await metrics?.server.close();
  process.exit(1);
}
process.on('SIGTERM', () => void workers.stop());
process.on('SIGINT', () => void workers.stop());
await workers.done;
await metrics?.server.close();
