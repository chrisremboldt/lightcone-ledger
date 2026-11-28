import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// A checklist as a record type a pack declares (examples/preflight-checklist), entered on a phone: 375 px wide, on a
// touch screen, in the Records screen's own form, under the headings the pack gives its sections.
// It needs the seeded stack with that pack loaded and adopted by Alpha Dispatch:
//   pnpm pack:build examples/preflight-checklist --out .local/packs
//   set LEDGER_PACKS_DIR to the full path of .local/packs, then start pnpm dev
//   pnpm ledger packs adopt example-ridge-checklist --mode active --from <today> --until <a year on> --reason "Browser test"
//     with Alpha Dispatch's development token as LEDGER_TOKEN
// Without it, the type is not offered and the test skips.

const phone = { width: 375, height: 812 };
test.use({ viewport: phone, hasTouch: true, isMobile: true });

/** The checklist's items, by the label the form shows for each: the item in the manual's own words. */
const items = [
  'Airframe and arms free of cracks and loose fasteners',
  'Propellers undamaged and tight',
  'Motors turn freely by hand',
  'Payload and gimbal secure',
  'Flight batteries charged and latched',
  'No battery swollen or damaged',
  'Controller battery charged',
  'Controller linked and home point set',
  'Return-to-home height set for the site',
  'Launch area clear of people',
  'Wires and obstacles noted',
  'Weather within the limits of chapter 4',
];
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An item's field by its whole label, which is followed by whether it is required. */
const itemLabel = (label: string) => new RegExp(`^${escaped(label)} Required`);

/** Opens the narrow bar's menu and follows one of its links. */
async function fromMenu(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.topbar-menu').getByRole('link', { name, exact: true }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
}

test('a pilot enters a preflight checklist on a phone, section by section, and it is on file', async ({
  page,
}, testInfo) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const flight = `${run}-RIDGE-F-21`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByLabel('Person').selectOption('operator');
  await page.getByRole('button', { name: 'Open operations' }).click();
  await fromMenu(page, 'Records');
  const area = page.getByRole('main', { name: 'Operator records' });
  await area.getByRole('button', { name: 'Enter a record', exact: true }).click();
  const types = area.getByLabel('Record type', { exact: true });
  await expect(types).toBeEnabled();
  const offered = await types.locator('option').allTextContents();
  test.skip(
    !offered.includes('Preflight checklist'),
    'Needs examples/preflight-checklist loaded and adopted (see above)',
  );

  await types.selectOption({ label: 'Preflight checklist' });
  const entry = area.getByRole('form', { name: 'Enter Preflight checklist', exact: true });
  // The sections of the manual's checklist, in its order, each once.
  await expect(entry.getByRole('heading', { level: 4 })).toHaveText([
    'Airframe',
    'Batteries',
    'Control station',
    'Site',
    'Notes',
  ]);

  await entry.getByRole('combobox', { name: /^Subject id/ }).fill(flight);
  await entry.getByLabel(/^Completed at/).fill('2026-11-02T08:00');
  await entry.getByRole('combobox', { name: /^Completed by/ }).fill(`${run}-RIDGE-P-01`);
  for (const label of items) {
    const field = entry.getByLabel(itemLabel(label));
    await expect(field).toHaveValue('');
    // Every answer the manual allows is offered, after the form's own "Not recorded".
    await expect(field.locator('option')).toHaveText(['Not recorded', 'Done', 'Not applicable', 'Defect found']);
    await field.selectOption(label === 'Payload and gimbal secure' ? 'not-applicable' : 'done');
  }
  await entry.getByLabel(/^Note Optional/).fill('No payload fitted for this flight.');

  // On a phone: each label above its field, nothing past the edge of the screen, every item's control 44 px high.
  for (const label of items) {
    const field = entry.getByLabel(itemLabel(label));
    const box = (await field.boundingBox())!;
    expect(box.x, label).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, label).toBeLessThanOrEqual(phone.width);
    expect(box.height, label).toBeGreaterThanOrEqual(43.5);
    const words = (await entry
      .locator('label')
      .filter({ hasText: itemLabel(label) })
      .boundingBox())!;
    expect(words.y + words.height, label).toBeLessThanOrEqual(box.y + 2);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone.width);
  const send = entry.getByRole('button', { name: 'Record entry', exact: true });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('enter-a-preflight-checklist-375.png'), fullPage: true });
  await send.click();

  // It is on file about the flight, complete, with the answers as the form labelled them.
  const recorded = area.getByRole('button', { name: /Open Preflight checklist record/ }).first();
  await expect(recorded).toBeVisible();
  await recorded.click();
  const detail = page.getByTestId('operator-record');
  await expect(detail.getByText('Complete', { exact: true })).toBeVisible();
  await expect(detail).toContainText('Entered by hand');
  await expect(detail).toContainText('Not applicable');
});
