import 'dotenv/config';
import { startWorkers } from './runtime.js';
const workers = startWorkers();
process.on('SIGTERM', () => void workers.stop());
process.on('SIGINT', () => void workers.stop());
await workers.done;
