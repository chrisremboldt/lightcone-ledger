import 'dotenv/config';
import { startWorkers, type WorkerRuntime } from './runtime.js';
let workers: WorkerRuntime;
try {
  workers = startWorkers();
} catch (error) {
  // A setting the start refuses, said plainly and without a stack.
  console.error((error as Error).message);
  process.exit(1);
}
process.on('SIGTERM', () => void workers.stop());
process.on('SIGINT', () => void workers.stop());
await workers.done;
