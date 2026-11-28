import { expect, test, type Page } from '@playwright/test';

// The reports: reachable from the bar without costing it a row, each at an address that carries what it is of, each
// number counted by the API, every chart told in a sentence with its numbers in a table, and each page printing
// without the screen's choices. Runs on the seeded stack.

// Signing in is kept in the page only: a report's address is opened first and signed in at.
async function openAs(page: Page, organization: string, person: string, address = '/') {
  await page.goto(address);
  await page.getByRole('radio', { name: organization, exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations' }).click();
}

async function print(page: Page) {
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
}

const bar = (page: Page) => page.getByRole('navigation', { name: 'Sections', exact: true });
const reportsNav = (page: Page) => page.getByRole('navigation', { name: 'Reports', exact: true });

test.afterEach(async ({ page }) => {
  await page.emulateMedia({ media: 'screen' });
});

test('Reports sits in the bar on one row at 1440 px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAs(page, 'Alpha Dispatch', 'operator');
  const reports = bar(page).getByRole('link', { name: 'Reports', exact: true });
  await expect(reports).toBeVisible();
  const flights = bar(page).getByRole('link', { name: 'Flights', exact: true });
  const [first, last] = [await flights.boundingBox(), await reports.boundingBox()];
  expect(Math.abs(first!.y - last!.y)).toBeLessThan(2);
  const overflow = await page.locator('.topbar').evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await reports.click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page).toHaveTitle('Reports · Ledger');
  await expect(reports).toHaveAttribute('aria-current', 'page');
});

test('a summary of a period counts what is on file, at an address that carries the period, and prints', async ({
  page,
}) => {
  await openAs(page, 'Alpha Dispatch', 'operator');
  await bar(page).getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('region', { name: 'Summary of a period', exact: true })
    .getByRole('link', { name: 'Last month', exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports\/summary\/\d{4}-\d{2}-01\/\d{4}-\d{2}-\d{2}$/);
  const summary = page.getByTestId('period-summary');
  await expect(summary).toBeVisible();
  for (const part of ['Flights', 'Findings by rule', 'Actions', 'Hazards by level', 'What this summary does not count'])
    await expect(summary.getByRole('region', { name: part, exact: true })).toBeVisible();
  await expect(summary.getByText(/^Made .+ from the records on file\./)).toBeVisible();
  // Flights are counted by their flight record; the flights planned with none stand beside that count, a zero too.
  const flights = summary.getByRole('region', { name: 'Flights', exact: true });
  await expect(
    flights.getByText('Flights planned to start in the period with no flight record on file, not counted above', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(flights.getByRole('link', { name: /^\d+ flights? planned with no flight record$/ })).toBeVisible();

  await openAs(page, 'Alpha Dispatch', 'operator', '/reports/summary/2026-01-01/2026-01-31');
  await expect(page.getByRole('heading', { name: 'Summary of 2026-01-01 to 2026-01-31', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Summary 2026-01-01 to 2026-01-31 · Reports · Ledger');
  await expect(page.getByTestId('period-summary')).toBeVisible();

  await print(page);
  await expect(page.locator('.print-heading strong')).toHaveAttribute('data-print', 'Alpha Dispatch');
  await expect(page.getByRole('heading', { name: 'Summary of 2026-01-01 to 2026-01-31', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print or save as PDF', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show the summary', exact: true })).toBeHidden();
  await expect(reportsNav(page)).toBeHidden();
});

test('findings by month draw a chart told in a sentence, with its numbers in a table that prints open', async ({
  page,
}) => {
  await openAs(page, 'Alpha Dispatch', 'operator', '/reports');
  await reportsNav(page).getByRole('link', { name: 'Findings by month', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/findings$/);
  const chart = page.getByTestId('monthly-chart');
  await expect(chart).toBeVisible();
  await expect(chart.locator('figcaption')).toHaveText(/^Every rule: (From|No counted finding)/);
  await expect(chart.getByTestId('monthly-group')).toHaveCount(12);
  const numbers = chart.locator('details.report-table');
  await expect(numbers).not.toHaveAttribute('open', '');
  await print(page);
  await expect(numbers).toHaveAttribute('open', '');
  await expect(numbers.locator('tbody tr')).toHaveCount(12);
});

test('indicators over time list what is recorded, or say nothing is', async ({ page }) => {
  await openAs(page, 'Alpha Dispatch', 'operator', '/reports/indicators');
  await expect(page.getByRole('heading', { name: 'Indicators over time', exact: true })).toBeVisible();
  const listed = page.getByTestId('report-indicators');
  const none = page.getByText(/^No indicator result is recorded yet\./);
  await expect(listed.or(none)).toBeVisible();
  if (await listed.isVisible()) {
    await listed.getByRole('link').first().click();
    const chart = page.getByTestId('indicator-chart');
    await expect(chart).toBeVisible();
    // Each point is reachable by keyboard and leads to the row of the result it shows.
    const point = chart.getByTestId('indicator-point').first();
    await point.focus();
    await expect(point).toBeFocused();
    const target = await point.getAttribute('href');
    expect(target).toMatch(/^#indicator-result-/);
    await expect(page.locator(target!)).toHaveCount(1);
  }
});

test('a report at phone width keeps to the screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const address of ['/reports', '/reports/summary/2026-01-01/2026-01-31', '/reports/findings']) {
    await openAs(page, 'Alpha Dispatch', 'operator', address);
    await expect(page.getByRole('main', { name: 'Reports', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, address).toBeLessThanOrEqual(0);
  }
});

test('the Safety home and the Records home lead to the reports', async ({ page }) => {
  await openAs(page, 'Alpha Dispatch', 'operator');
  await bar(page).getByRole('link', { name: 'Safety', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention', exact: true })).toBeVisible();
  await page.locator('.report-entry').getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await bar(page).getByRole('link', { name: 'Records', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Records lists', exact: true })
    .getByRole('link', { name: 'Reports', exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports$/);
});

test('People and browse records take an order', async ({ page }) => {
  await openAs(page, 'Alpha Dispatch', 'operator', '/people');
  const people = page.getByRole('complementary', { name: 'People list', exact: true });
  await people.getByLabel('Order').selectOption({ label: 'Most recently added first' });
  await expect(people.locator('.people-list li').first()).toBeVisible();
  await openAs(page, 'Alpha Dispatch', 'operator', '/records/browse');
  const order = page.getByRole('region', { name: /records$/ }).getByLabel('Order');
  await expect(order.locator('option')).toHaveText(['Most recent first', 'By subject id']);
});

test('one flight’s file opens at its address, and says what is not on file', async ({ page }) => {
  await openAs(page, 'Alpha Dispatch', 'operator', '/reports/flights/RIDGE-FLIGHT-0000');
  const rules = page.getByTestId('flight-file-rules');
  await expect(rules).toBeVisible();
  await expect(page.getByText('No record about this flight is on file.', { exact: true })).toBeVisible();
  await expect(page.getByText('This report could not be read', { exact: true })).toHaveCount(0);
});

// After `pnpm scenario`, the seeded flights Ledger holds have findings by Ledger's own id. Without it there is no such
// finding, and this says so rather than passing on nothing. A flight known only by the organization's own id, such as
// one imported with a worked example's records, may have findings too: the first finding about a flight Ledger holds
// is the one opened.
test('a flight’s file opened from one of its findings shows its rule results and findings', async ({ page }) => {
  await openAs(page, 'Alpha Dispatch', 'operator', '/rules/findings');
  const list = page.getByTestId('open-findings');
  await list
    .getByRole('navigation', { name: 'How findings are shown' })
    .getByRole('button', { name: 'Every finding, oldest first', exact: true })
    .click();
  await list.getByLabel('Subject', { exact: true }).selectOption({ label: 'Flights' });
  const rows = list.getByRole('button', { name: /^Open the finding about / });
  // A rule's title may begin with "No" too: the list's own sentence for nothing open is matched whole.
  const none = list.getByText('No counted finding is open with these filters.', { exact: true });
  await expect(rows.first().or(none)).toBeVisible();
  const detail = page.getByTestId('open-finding-detail');
  const subject = detail.getByText(/^flight · (Ledger’s|your) id /);
  const listed = Math.min(await rows.count(), 25);
  let held = false;
  for (let index = 0; index < listed && !held; index += 1) {
    await rows.nth(index).click();
    await expect(subject).toBeVisible();
    held = (await subject.innerText()).startsWith('flight · Ledger’s id ');
    if (!held) await detail.getByRole('button', { name: 'Back to open findings', exact: true }).click();
  }
  test.skip(!held, 'No flight Ledger holds has an open finding: run `pnpm scenario` on the seeded stack first.');
  await detail.getByRole('link', { name: 'This flight’s file', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/flights\/[0-9a-f-]{36}$/);
  const file = page.getByTestId('flight-file');
  await expect(file.getByText(/^Ledger’s id [0-9a-f-]{36}\. Read /)).toBeVisible();
  await expect(file.getByTestId('flight-file-rule').first()).toBeVisible();
  await expect(file.getByText('No finding about this flight is recorded.', { exact: true })).toHaveCount(0);
  await expect(file.getByTestId('flight-file-finding').first()).toBeVisible();
});
