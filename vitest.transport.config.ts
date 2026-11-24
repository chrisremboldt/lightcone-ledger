import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/simulator/tests/**/*.transport.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
