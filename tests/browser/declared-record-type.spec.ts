import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// A record type a pack declares (examples/declared-record-type), entered by hand on the Records screen and found again.
// It needs the seeded stack with that pack loaded and adopted by Alpha Dispatch:
//   pnpm pack:build examples/declared-record-type --out .local/packs
//   set LEDGER_PACKS_DIR to the full path of .local/packs, then start pnpm dev
//   pnpm ledger packs adopt example-ridge-procedures --mode active --from <today> --until <a year on> --reason "Browser test"
//     with Alpha Dispatch's development token as LEDGER_TOKEN
// Without it, the type is not offered and the test skips.
test('a dispatcher enters a record of a type the organization’s own pack declares, then finds it', async ({ page }) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const aircraft = `${run}-RIDGE-AC-9`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  const area = page.getByRole('main', { name: 'Operator records' });
  const types = area.getByLabel('Record type', { exact: true });
  await expect(types).toBeEnabled();
  const offered = await types.locator('option').allTextContents();
  test.skip(!offered.includes('Airframe check'), 'Needs examples/declared-record-type loaded and adopted (see above)');

  await types.selectOption({ label: 'Airframe check' });
  await expect(area.getByTestId('record-type-declared-by')).toHaveText(
    'Declared by your pack example-ridge-procedures, which your organization has adopted.',
  );
  await area.getByRole('button', { name: 'Enter a record', exact: true }).click();
  const entry = area.getByRole('form', { name: 'Enter Airframe check' });
  await entry.getByRole('combobox', { name: /^Subject id/ }).fill(aircraft);
  await entry.getByLabel(/^Checked at/).fill('2026-11-02T08:00:00');
  await entry.getByRole('combobox', { name: /^Inspector/ }).fill(`${run}-RIDGE-P-01`);
  await entry.getByLabel(/^Result/).selectOption('serviceable');
  await entry.getByLabel(/^Airframe hours/).fill('112.5');
  await entry.getByRole('button', { name: 'Record entry', exact: true }).click();

  // Browse finds it by the aircraft's own id, complete, with what was entered.
  await area.getByRole('button', { name: 'Browse records', exact: true }).click();
  await area.getByLabel('Subject id', { exact: true }).fill(aircraft);
  await area.getByRole('button', { name: 'Show records', exact: true }).click();
  const list = area.getByRole('region', { name: 'Airframe check records' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: /^Open Airframe check record/ }).click();
  const detail = page.getByTestId('operator-record');
  await expect(detail.getByText('Complete', { exact: true })).toBeVisible();
  await expect(detail).toContainText('Entered by hand');
  await expect(detail).toContainText('Serviceable');
});
