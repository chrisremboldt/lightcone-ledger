import type { TestProject } from 'vitest/node';
import { createApp } from '../../apps/api/src/index.js';
import { adoptSeededRiskMatrices } from '../../apps/api/src/seed-risk-matrix.js';
import { adoptSeededRulePacks } from '../../apps/api/src/seed-rule-packs.js';
import { createPool, MemoryObjectStore, migrate, seed } from '../../packages/persistence/src/index.js';

export default async function setup(project: TestProject) {
  const env = project.config.env as Record<string, string>;
  const database = env.LEDGER_TEST_DATABASE!;
  const server = new URL(env.DATABASE_ADMIN_URL!);
  server.pathname = '/postgres';
  const bootstrap = createPool(server.toString());
  try {
    const exists = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
    if (!exists.rowCount) await bootstrap.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
  } finally {
    await bootstrap.end();
  }
  const admin = createPool(env.DATABASE_ADMIN_URL);
  try {
    await migrate(admin);
    await seed(admin);
  } finally {
    await admin.end();
  }
  // The seeded organizations adopt their matrix and procedures through the API, as a person would.
  const pool = createPool(env.DATABASE_URL);
  const app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
  try {
    await app.ready();
    await adoptSeededRiskMatrices(app);
    await adoptSeededRulePacks(app);
  } finally {
    await app.close();
    await pool.end();
  }
}
