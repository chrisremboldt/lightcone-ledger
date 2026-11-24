#!/usr/bin/env node
// Records a scene for the hosted demonstration.
//
// Run the scene against a freshly seeded local stack so the recording holds only seed data:
//
//   docker compose -f infra/compose.yaml down -v && docker compose -f infra/compose.yaml up -d --wait
//   pnpm build && pnpm db:migrate && pnpm db:seed
//   pnpm dev            # in another terminal
//   pnpm scenario       # optional: fills the flight boards with a simulated day
//   pnpm demo:record    # this script records every scene; name scenes to record only those
//
// The simulated person performs the scene through the real screens. Every exchange with the API is
// saved to apps/web/src/autopilot/tapes/<scene>.json, which the demonstration build replays.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// In this order, so each recording starts from the record the one before left behind.
const all = ['hazard', 'documents', 'landing', 'lostlink', 'decision', 'wind', 'rules'];
const chosen = process.argv.slice(2);
const web = process.env.WEB_URL ?? 'http://127.0.0.1:5173';

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
// Recordings are saved only after every scene has run. The development server watches the recordings folder and
// reloads any open page when a file in it changes, which would start the next scene a second time.
const recorded = [];
try {
  for (const scene of chosen.length ? chosen : all) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(`${web}/?autopilot=${encodeURIComponent(scene)}&record=1`);
    // The bar can be present twice for an instant while the page first renders; either one will do.
    const session = page.getByTestId('autopilot').first();
    await session.waitFor({ timeout: 30_000 });
    // A person's pace, so the recording holds the refreshes a visitor's replay will make.
    await page.waitForFunction(
      () => ['done', 'failed'].includes(document.querySelector('[data-testid="autopilot"]')?.dataset.status ?? ''),
      undefined,
      { timeout: 900_000 },
    );
    if ((await session.getAttribute('data-status')) !== 'done')
      throw new Error(`“${scene}” did not finish: ${await session.getByRole('status').textContent()}`);
    await page.waitForFunction(() => window.__ledgerTape !== undefined, undefined, { timeout: 120_000 });
    const tape = await page.evaluate(() => window.__ledgerTape);
    recorded.push({ scene, tape });
    const reads = tape.epochs.reduce((sum, epoch) => sum + Object.values(epoch).flat().length, 0);
    console.log(`Recorded “${scene}”: ${tape.writes.length} writes, ${reads} reads, ${tape.epochs.length} epochs`);
    await page.close();
  }
} finally {
  await browser.close();
  for (const { scene, tape } of recorded)
    await writeFile(
      new URL(`../apps/web/src/autopilot/tapes/${scene}.json`, import.meta.url),
      `${JSON.stringify(tape)}\n`,
    );
}
