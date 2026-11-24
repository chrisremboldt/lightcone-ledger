import 'dotenv/config';
import { createPool, migrate } from './index.js';
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  await migrate(pool);
  console.log('Ledger schema migration complete');
} finally {
  await pool.end();
}
