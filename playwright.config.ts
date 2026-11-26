import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 12000 },
  use: {
    baseURL: process.env.WEB_URL || 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.env.CI ? undefined : 'chrome'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 960 },
    // The web app's service worker is allowed only where a spec needs it (offline-entry.spec.ts): requests it
    // answers are not seen by page.route, which other specs use.
    serviceWorkers: 'block',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
