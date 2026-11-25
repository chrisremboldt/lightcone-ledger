import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixtures = join(import.meta.dirname, '..', '..', 'packages', 'contracts', 'fixtures', 'operator-records');
/** The sample file with this run's own subject ids, so repeated runs on one database stay apart. */
const sample = (name: string, run: string) =>
  Buffer.from(readFileSync(join(fixtures, name), 'utf8').replaceAll('ALPHA-', `${run}-ALPHA-`));

test('a dispatcher imports aircraft time records, then enters a training record by hand and corrects it', async ({
  page,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  const area = page.getByRole('main', { name: 'Operator records' });
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: 'Aircraft time in service' });

  // Import: check the file, see the refused row with its reason, then record the rest.
  await area.getByRole('button', { name: 'Import a file' }).click();
  await area.getByLabel('File to import').setInputFiles({
    name: 'alpha-aircraft-time.csv',
    mimeType: 'text/csv',
    buffer: sample('alpha-aircraft-time.csv', run),
  });
  await area.getByRole('button', { name: 'Check file' }).click();
  await expect(area.getByText('3 of 4 rows can be recorded')).toBeVisible();
  const rows = area.getByRole('table', { name: 'Rows in the file' });
  await expect(rows.locator('tr[data-status="refused"]')).toContainText('"ninety" is not a number');
  await expect(rows.locator('tr[data-status="acceptable"]')).toHaveCount(3);
  await area.getByRole('button', { name: 'Record 3 rows' }).click();
  await expect(area.getByText('Recorded 3 of 4 rows')).toBeVisible();
  await area.getByRole('button', { name: 'Show imported records' }).click();

  // The aircraft shows its record, with the file and row it came from.
  await area.getByLabel('Subject id').fill(`${run}-ALPHA-AC-102`);
  await area.getByRole('button', { name: 'Show records' }).click();
  await area.getByRole('button', { name: /Open Aircraft time in service record/ }).click();
  const detail = page.getByTestId('operator-record');
  await expect(detail.getByText('Complete', { exact: true })).toBeVisible();
  await expect(detail).toContainText('File alpha-aircraft-time.csv');
  await expect(detail.locator('.records-original')).toContainText(`${run}-ALPHA-AC-102,opening_balance,87.25`);
  await detail.getByRole('button', { name: 'Back to records' }).click();

  // Hand entry: an incomplete training record for a pilot.
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: 'Training' });
  await area.getByRole('button', { name: 'Enter a record' }).click();
  const entry = area.getByRole('form', { name: 'Enter Training' });
  await entry.getByLabel(/^Subject id/).fill(`${run}-ALPHA-PILOT-07`);
  await entry.getByLabel(/^Kind of training/).selectOption('recurrent');
  await entry.getByLabel(/^Course or event/).fill('Recurent emergency procedures');
  await entry.getByLabel(/^Completed on/).fill('2026-10-02');
  await entry.getByRole('button', { name: 'Record entry' }).click();
  await area.getByRole('button', { name: /Open Training record/ }).click();
  await expect(detail.getByText('Incomplete', { exact: true })).toBeVisible();
  await expect(detail).toContainText('Missing Completion evidence reference');
  await expect(detail).toContainText('Entered by hand');

  // Correction: a new record that names the one it replaces; the original is kept and marked replaced.
  await detail.getByRole('button', { name: 'Correct this record' }).click();
  const correction = detail.getByRole('form', { name: 'Correct Training' });
  await correction.getByLabel(/^Course or event/).fill('Recurrent emergency procedures');
  await correction.getByLabel(/^Completion evidence reference/).fill('TRN-2026-0412');
  await correction.getByRole('button', { name: 'Record correction' }).click();
  const list = area.getByRole('region', { name: 'Training records' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByText('Replaced', { exact: true })).toBeVisible();
  await expect(list.getByText('Correction', { exact: true })).toBeVisible();
  await list.getByRole('button', { name: /Open Training record Recurrent · Recurrent emergency procedures/ }).click();
  await expect(detail.getByText('Complete', { exact: true })).toBeVisible();
  await expect(detail).toContainText('This record replaces record');

  // A second entry offers the pilot already on file as the person types, and says when an id is new.
  await area.getByRole('button', { name: 'Enter a record' }).click();
  const again = area.getByRole('form', { name: 'Enter Training' });
  const subject = again.getByRole('combobox', { name: /^Subject id/ });
  await subject.fill(`${run}-ALPHA-PILOT`);
  const offered = again.getByRole('listbox', { name: 'Subjects on file' });
  await expect(offered.getByRole('option', { name: new RegExp(`^${run}-ALPHA-PILOT-07`) })).toBeVisible();
  await expect(again.getByRole('status').first()).toHaveText(`1 subject on file matches ${run}-ALPHA-PILOT.`);
  await subject.press('ArrowDown');
  await subject.press('Enter');
  await expect(subject).toHaveValue(`${run}-ALPHA-PILOT-07`);
  await expect(again.getByTestId('new-subject-note')).toHaveCount(0);
  await subject.fill(`${run}-ALPHA-PILOT-70`);
  await expect(again.getByTestId('new-subject-note')).toHaveText(
    `No record names ${run}-ALPHA-PILOT-70 yet: recording this makes it a new person.`,
  );

  // Closing Records returns to the operation screen as it was.
  await page.getByRole('link', { name: 'Flights', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Flight monitor' })).toBeVisible();
});
