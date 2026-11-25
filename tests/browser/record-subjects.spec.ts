import { test, expect, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixtures = join(import.meta.dirname, '..', 'integration', 'fixtures', 'ridge-records');
/** A fixture file with this run's own ids, so repeated runs on one database stay apart. */
const fixture = (name: string, run: string) =>
  Buffer.from(readFileSync(join(fixtures, name), 'utf8').replaceAll('RIDGE-', `${run}-RIDGE-`));

async function importFile(area: Locator, recordTypeTitle: string, name: string, run: string, rows: number) {
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: recordTypeTitle });
  await area.getByRole('button', { name: 'Import a file', exact: true }).click();
  await area.getByLabel('File to import').setInputFiles({ name, mimeType: 'text/csv', buffer: fixture(name, run) });
  await area.getByRole('button', { name: 'Check file', exact: true }).click();
  await area.getByRole('button', { name: `Record ${rows} rows`, exact: true }).click();
  await expect(area.getByText(new RegExp(`^Recorded ${rows} of ${rows} rows\\.$`))).toBeVisible();
}

test('a dispatcher opens the fleet, a pilot’s file, and produces the pilot’s records', async ({ page }) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const id = (own: string) => `${run}-${own}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  const area = page.getByRole('main', { name: 'Operator records' });

  await importFile(area, 'Personnel file', 'person.standing.csv', run, 2);
  await importFile(area, 'Aircraft identity and registration', 'aircraft.identity.csv', run, 2);

  // The fleet, by the names the identity records give each aircraft, beside the organization's own ids.
  await area.getByRole('button', { name: 'People, aircraft and flights', exact: true }).click();
  const kinds = area.getByRole('navigation', { name: 'Kinds of subject' });
  await kinds.getByRole('button', { name: 'Aircraft', exact: true }).click();
  await area.getByLabel('Name or id contains', { exact: true }).fill(run);
  await area.getByRole('button', { name: 'Search', exact: true }).click();
  const fleet = area.getByRole('list', { name: 'Aircraft list' });
  await expect(
    fleet.getByRole('button', {
      name: `Open the file of Example Survey Quad X8, ${id('RIDGE-REG-1')} (${id('RIDGE-AC-1')})`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(fleet.getByRole('listitem')).toHaveCount(2);

  // A pilot's file: every record about them, by type.
  await kinds.getByRole('button', { name: 'People', exact: true }).click();
  await area.getByLabel('Name or id contains', { exact: true }).fill(run);
  await area.getByRole('button', { name: 'Search', exact: true }).click();
  await area
    .getByRole('list', { name: 'People list' })
    .getByRole('button', { name: `Open the file of Avery Example (${id('RIDGE-P-01')})`, exact: true })
    .click();
  const file = page.getByTestId('subject-file');
  await expect(file.getByRole('heading', { name: `Avery Example (${id('RIDGE-P-01')})`, exact: true })).toBeVisible();
  await expect(file.getByRole('region', { name: 'Personnel file' }).getByRole('listitem')).toHaveCount(1);
  await expect(file.getByRole('region', { name: 'Open findings about this subject' })).toContainText(
    'No finding about this subject is open.',
  );

  // Producing the pilot's records: a reason and who asked, then one file to download again later.
  await file.getByRole('button', { name: 'Produce these records', exact: true }).click();
  const form = area.getByRole('form', { name: 'Produce records' });
  await expect(form.getByRole('list', { name: 'Chosen subjects' })).toContainText(id('RIDGE-P-01'));
  await form.getByLabel('Reason', { exact: true }).fill('Training records asked for at an inspection');
  await form.getByLabel('Requested by', { exact: true }).fill('Inspector, regional office');
  await form.getByRole('button', { name: 'Produce records', exact: true }).click();
  const produced = page.getByTestId('record-production');
  await expect(produced).toContainText('1 record of 1 record type');
  await expect(produced).toContainText('Training records asked for at an inspection');
  const download = page.waitForEvent('download');
  await produced.getByRole('button', { name: 'Download the .zip', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^records-\d{4}-\d{2}-\d{2}-.+\.zip$/);

  await area
    .getByRole('navigation', { name: 'Records lists' })
    .getByRole('button', { name: 'Produced records', exact: true })
    .click();
  await expect(page.getByTestId('record-production-item').first()).toContainText('Inspector, regional office');

  await page.getByRole('link', { name: 'Flights', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Flight monitor' })).toBeVisible();
});
