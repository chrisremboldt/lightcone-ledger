import 'dotenv/config';
import { createPool, seed } from './index.js';
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  const result = await seed(pool);
  console.log('Seeded isolated synthetic tenants:', result.tenantIds.join(', '));
} finally {
  await pool.end();
}
