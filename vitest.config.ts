import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'packages/**/*.test.ts',
      'apps/emulators/**/*.test.ts',
      'apps/simulator/**/*.test.ts',
      'apps/adapter-host/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts', '**/*.transport.test.ts'],
    setupFiles: ['tests/register-standard-packs.ts'],
    // Generous: several simulator tests do real file work and time out on a busy machine at a tighter limit.
    testTimeout: 60000,
  },
});
