import { defineConfig } from 'vitest/config';
import 'dotenv/config';

const testDatabase = process.env.LEDGER_TEST_DATABASE ?? 'ledger_test';
const onTestDatabase = (url: string | undefined) => {
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.pathname = `/${testDatabase}`;
  return parsed.toString();
};

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', '**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['tests/integration/setup.ts'],
    setupFiles: ['tests/register-standard-packs.ts'],
    env: {
      LEDGER_TEST_DATABASE: testDatabase,
      DATABASE_URL: onTestDatabase(process.env.DATABASE_URL)!,
      DATABASE_ADMIN_URL: onTestDatabase(process.env.DATABASE_ADMIN_URL)!,
      WORKER_DATABASE_URL: onTestDatabase(process.env.WORKER_DATABASE_URL)!,
    },
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
