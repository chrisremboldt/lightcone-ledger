import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openAccount } from './account-fixture.js';

// Entering records without a connection (docs/design/offline-entry.md), on the seeded pnpm dev stack. The other specs
// block service workers (playwright.config.ts); this one needs the app's own to open without a connection.

test.use({ serviceWorkers: 'allow' });

const dana = 'ledger-dev-alpha-operator';

async function openAs(page: Page, person: 'operator' | 'actor') {
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report a safety concern', exact: true })).toBeVisible();
}

/** Opens the app once so its service worker is installed, then again so every file the app loads passes through it. */
async function installApp(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect(page.getByRole('button', { name: 'Open operations', exact: true })).toBeVisible();
}

async function openRecordForm(page: Page, title: string) {
  const area = page.getByRole('main', { name: 'Operator records' });
  await area.getByRole('button', { name: 'Enter a record', exact: true }).click();
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: title });
  return area.getByRole('form', { name: `Enter ${title}`, exact: true });
}

/** The operator records about one subject, read from the API as Dana. */
async function recordsAbout(page: Page, recordType: string, subjectId: string) {
  const response = await page.request.get(`/v1/operator-records?${new URLSearchParams({ recordType, subjectId })}`, {
    headers: { authorization: `Bearer ${dana}` },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).records as { observationId: string; limitations: string[]; receivedAt: string }[];
}

/** How many entries this browser keeps, read from its database without their content. */
const keptOnDevice = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const opened = indexedDB.open('ledger-outbox');
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const database = opened.result;
          if (!database.objectStoreNames.contains('entries')) return resolve(0);
          const counted = database.transaction('entries').objectStore('entries').count();
          counted.onsuccess = () => resolve(counted.result);
          counted.onerror = () => reject(counted.error);
        };
      }),
  );

test('three entries made without a connection are kept through a reload and arrive once, as the person who wrote them', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 6).toUpperCase();
  const preflightSubject = `${run}-ALPHA-FLIGHT-31`;
  const flightSubject = `${run}-ALPHA-FLIGHT-32`;
  const narrative = `Loose strap on the spare battery case ${run}`;
  await installApp(page);
  await openAs(page, 'operator');
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  await expect(
    page.getByRole('main', { name: 'Operator records' }).getByLabel('Record type', { exact: true }),
  ).toBeEnabled();

  await context.setOffline(true);
  const preflight = await openRecordForm(page, 'Preflight assessment');
  await preflight.getByRole('combobox', { name: /^Subject id/ }).fill(preflightSubject);
  await preflight.getByLabel(/^Assessed at/).fill('2026-11-25T08:40');
  await preflight.getByRole('button', { name: 'Record entry', exact: true }).click();
  await expect(preflight.getByRole('status').filter({ hasText: 'Kept on this device' })).toBeVisible();
  await expect(preflight.getByTestId('outbox-count')).toHaveText(
    /^1 of your entries waits on this device to be sent\./,
  );

  const flight = await openRecordForm(page, 'Flight record');
  await flight.getByRole('combobox', { name: /^Subject id/ }).fill(flightSubject);
  await flight.getByLabel(/^Takeoff at/).fill('2026-11-25T09:30');
  await flight.getByLabel(/^Takeoff place/).fill('Alpha yard');
  await flight.getByRole('button', { name: 'Record entry', exact: true }).click();
  await expect(flight.getByTestId('outbox-count')).toHaveText(/^2 of your entries wait on this device to be sent\./);

  await page.getByRole('button', { name: 'Report a safety concern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a safety concern' });
  await dialog.getByLabel('What happened or what you saw', { exact: true }).fill(narrative);
  await dialog.getByRole('button', { name: 'Send report', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Your report is kept on this device', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await keptOnDevice(page)).toBe(3);

  // Reloaded with no connection: the app opens, signed out, and says only that entries wait.
  await page.reload();
  await expect(page.getByTestId('outbox-waiting-signed-out')).toHaveText(
    '3 entries made on this device wait to be sent. They are sent once the person who wrote them signs in again.',
  );
  await expect(page.getByText(narrative)).toHaveCount(0);

  // Someone else signs in: they are told another person's entries wait, and none is sent or shown.
  await context.setOffline(false);
  await page.reload();
  await openAs(page, 'actor');
  await page.getByRole('button', { name: 'Report a safety concern', exact: true }).click();
  const theirs = page.getByRole('dialog', { name: 'Report a safety concern' });
  await expect(theirs.getByTestId('outbox-others')).toBeVisible();
  await expect(theirs.getByTestId('outbox-count')).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'Show what is kept on this device', exact: true })).toHaveCount(0);
  await theirs.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await recordsAbout(page, 'flight.preflight-assessment', preflightSubject)).toEqual([]);
  expect(await recordsAbout(page, 'flight.record', flightSubject)).toEqual([]);
  expect(await keptOnDevice(page)).toBe(3);

  // The person who wrote them signs in again: each arrives once, with the time the device wrote it.
  await openAccount(page);
  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAs(page, 'operator');
  await expect.poll(() => keptOnDevice(page), { timeout: 60_000 }).toBe(0);
  const [assessed] = await recordsAbout(page, 'flight.preflight-assessment', preflightSubject);
  const flown = await recordsAbout(page, 'flight.record', flightSubject);
  expect(flown).toHaveLength(1);
  expect(assessed!.limitations.some((line) => /by the clock of the device it was entered on/.test(line))).toBe(true);
  await page.getByRole('button', { name: 'Report a safety concern', exact: true }).click();
  const mine = page.getByRole('dialog', { name: 'Report a safety concern' });
  await mine.getByRole('button', { name: 'Show what is kept on this device', exact: true }).click();
  const receipts = mine.getByRole('list', { name: 'Sent from this device', exact: true });
  await expect(receipts.getByTestId('outbox-receipt')).toHaveCount(3);
  await expect(receipts.getByTestId('outbox-receipt').filter({ hasText: 'Safety report' })).toContainText(
    /Received\. Receipt code [0-9A-Z]{4}(-[0-9A-Z]{4}){4}/,
  );
  await expect(mine.getByText(narrative)).toHaveCount(0);
});

test('an entry sent twice from the device is one record', async ({ page, context }) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 6).toUpperCase();
  const subject = `${run}-ALPHA-FLIGHT-41`;
  await installApp(page);
  await openAs(page, 'operator');
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  await expect(
    page.getByRole('main', { name: 'Operator records' }).getByLabel('Record type', { exact: true }),
  ).toBeEnabled();
  await context.setOffline(true);
  const flight = await openRecordForm(page, 'Flight record');
  await flight.getByRole('combobox', { name: /^Subject id/ }).fill(subject);
  await flight.getByLabel(/^Takeoff at/).fill('2026-11-25T10:15');
  await flight.getByLabel(/^Takeoff place/).fill('Alpha yard');
  await flight.getByRole('button', { name: 'Record entry', exact: true }).click();
  await expect(flight.getByTestId('outbox-count')).toBeVisible();
  // The entry as the device stored it, key and bytes included.
  const stored = await page.evaluate(
    () =>
      new Promise<unknown[]>((resolve) => {
        const opened = indexedDB.open('ledger-outbox');
        opened.onsuccess = () => {
          const all = opened.result.transaction('entries').objectStore('entries').getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );
  expect(stored).toHaveLength(1);

  // Back online, the page sends what waits: at once, or on its next try within half a minute.
  await context.setOffline(false);
  await expect.poll(() => keptOnDevice(page), { timeout: 60_000 }).toBe(0);
  const [first] = await recordsAbout(page, 'flight.record', subject);

  // The same entry, as if the first answer had been lost: put back and sent again under the same key.
  await page.evaluate(
    (entry) =>
      new Promise<void>((resolve) => {
        const opened = indexedDB.open('ledger-outbox');
        opened.onsuccess = () => {
          const transaction = opened.result.transaction('entries', 'readwrite');
          transaction.objectStore('entries').put(entry);
          transaction.oncomplete = () => resolve();
        };
      }),
    stored[0],
  );
  await page.reload();
  await openAs(page, 'operator');
  await expect.poll(() => keptOnDevice(page), { timeout: 60_000 }).toBe(0);
  const again = await recordsAbout(page, 'flight.record', subject);
  expect(again.map((record) => record.observationId)).toEqual([first!.observationId]);
});
