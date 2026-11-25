import { test, expect, type Page } from '@playwright/test';

async function openAs(page: Page, organization: string, person?: string) {
  await page.getByRole('radio', { name: organization, exact: true }).check();
  if (person) await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption(person);
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
}

const bar = (page: Page) => page.getByRole('navigation', { name: 'Sections', exact: true });

test('every section has an address and a title, and back and forward keep the place', async ({ page }) => {
  await page.goto('/');
  await openAs(page, 'Alpha Dispatch');
  // The bare address opens the first screen the organization uses: its flights.
  await expect(page).toHaveURL(/\/flights$/);
  await expect(page).toHaveTitle('Flights · Ledger');
  await expect(bar(page).getByRole('link', { name: 'Flights', exact: true })).toHaveAttribute('aria-current', 'page');

  await bar(page).getByRole('link', { name: 'Rules', exact: true }).click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page).toHaveTitle('Adopted rule packs · Rules · Ledger');
  await expect(bar(page).getByRole('link', { name: 'Rules', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(bar(page).getByRole('link', { name: 'Flights', exact: true })).not.toHaveAttribute('aria-current');
  // No section closes over another: there is no close button.
  await expect(page.getByRole('button', { name: 'Close rules', exact: true })).toHaveCount(0);

  const area = page.getByRole('main', { name: 'Rules and findings' });
  await area.getByRole('navigation', { name: 'Rules views' }).getByRole('button', { name: 'Open findings' }).click();
  await expect(page).toHaveURL(/\/rules\/findings$/);
  await expect(page).toHaveTitle('Open findings · Rules · Ledger');

  await bar(page).getByRole('link', { name: 'Safety', exact: true }).click();
  await expect(page).toHaveURL(/\/safety$/);
  await expect(page.getByRole('heading', { name: 'What needs attention', exact: true })).toBeVisible();
  await page
    .locator('.sms-nav-links')
    .getByRole('button', { name: /^Hazard register/ })
    .click();
  await expect(page).toHaveURL(/\/safety\/hazards$/);
  await expect(page).toHaveTitle('Hazard register · Safety · Ledger');

  await page.goBack();
  await expect(page).toHaveURL(/\/safety$/);
  await expect(page.getByRole('heading', { name: 'What needs attention', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/rules\/findings$/);
  await expect(page.getByTestId('open-findings')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/safety$/);
  await expect(page.getByRole('heading', { name: 'What needs attention', exact: true })).toBeVisible();

  // Rules in the bar returns to Rules where it was left.
  await bar(page).getByRole('link', { name: 'Rules', exact: true }).click();
  await expect(page).toHaveURL(/\/rules\/findings$/);
});

test('a link opens its place after signing in, and an address that names nothing says so', async ({ page }) => {
  await page.goto('/rules/coverage/ledger.demo-procedures');
  await openAs(page, 'Alpha Dispatch');
  await expect(page).toHaveURL(/\/rules\/coverage\/ledger\.demo-procedures$/);
  const coverage = page.getByTestId('organization-coverage');
  await expect(coverage.getByTestId('adoption').first()).toBeVisible();
  await expect(coverage.getByRole('link', { name: 'All adopted rule packs', exact: true })).toBeVisible();

  await page.goto('/records/aircraft');
  await openAs(page, 'Alpha Dispatch');
  await expect(page).toHaveTitle('Aircraft · Records · Ledger');
  await expect(
    page
      .getByRole('navigation', { name: 'Records lists' })
      .getByRole('button', { name: 'People, aircraft and flights' }),
  ).toHaveAttribute('aria-current', 'page');

  await page.goto('/nowhere/at/all');
  await openAs(page, 'Alpha Dispatch');
  await expect(page).toHaveTitle('Not found here · Ledger');
  await expect(page.getByText('Ledger has no screen at this address.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Open your first screen', exact: true }).click();
  await expect(page).toHaveURL(/\/flights$/);

  await page.goto('/flights/no-such-flight');
  await openAs(page, 'Alpha Dispatch');
  await expect(page.getByText('Flight unavailable', { exact: true })).toBeVisible();
  await expect(
    page.getByText('This flight is not on record for your organization, or your role cannot read it.', {
      exact: false,
    }),
  ).toBeVisible();
});

test('an organization without flights opens on its safety home, and a flights address leads there', async ({
  page,
}) => {
  await page.goto('/flights');
  await openAs(page, 'Fictional Valley Power');
  await expect(page).toHaveURL(/\/safety$/);
  await expect(page.getByRole('heading', { name: 'What needs attention', exact: true })).toBeVisible();
  await expect(bar(page).getByRole('link', { name: 'Flights', exact: true })).toHaveCount(0);
  await expect(bar(page).getByRole('link', { name: 'Safety', exact: true })).toHaveAttribute('aria-current', 'page');
  await bar(page).getByRole('link', { name: 'Records', exact: true }).click();
  await expect(page).toHaveURL(/\/records$/);
  await expect(page.getByRole('main', { name: 'Operator records', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'What needs attention', exact: true })).toBeVisible();
});

test('a section the person may not open says so, with a way back', async ({ page }) => {
  // A pilot does not manage people.
  await page.goto('/people');
  await openAs(page, 'Alpha Dispatch', 'actor');
  await expect(bar(page).getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
  await expect(page.getByText('People is not available to you', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open your first screen', exact: true }).click();
  await expect(page).toHaveURL(/\/flights$/);
});

test('an unsent report survives moving between places and never reaches the address', async ({ page }) => {
  await page.goto('/');
  await openAs(page, 'Alpha Dispatch');
  await page.getByRole('button', { name: 'Report a safety concern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a safety concern' });
  const words = 'Loose propeller guard on the spare aircraft';
  await dialog.getByLabel('What happened or what you saw', { exact: true }).fill(words);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await bar(page).getByRole('link', { name: 'Safety', exact: true }).click();
  await bar(page).getByRole('link', { name: 'Rules', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/safety$/);
  expect(page.url()).not.toContain('propeller');
  expect(JSON.stringify(await page.evaluate(() => window.history.state))).not.toContain('propeller');

  await page.getByRole('button', { name: 'Report a safety concern', exact: true }).click();
  await expect(dialog.getByLabel('What happened or what you saw', { exact: true })).toHaveValue(words);
});

test('a register keeps its plain choices in the address, and an opened person has an address', async ({ page }) => {
  await page.goto('/');
  await openAs(page, 'Alpha Dispatch');
  await bar(page).getByRole('link', { name: 'Safety', exact: true }).click();
  const register = page.locator('.sms-nav-links').getByRole('button', { name: /^Hazard register/ });
  await register.click();
  // The register offers its search and choices once it holds a hazard.
  const identify = page.getByRole('form', { name: 'Identify a hazard' });
  await identify.getByLabel('Hazard', { exact: true }).fill('Gusts between the fictional depot sheds');
  await identify.getByLabel('What could go wrong, and where').fill('Gusts funnel between the sheds.');
  await identify.getByLabel('Worst credible outcome').fill('Loss of control on departure.');
  await identify.getByRole('button', { name: 'Record hazard' }).click();
  await expect(page).toHaveURL(/\/safety\/hazards\/[^/?]+$/);
  await register.click();
  await page.getByRole('combobox', { name: 'Order', exact: true }).selectOption('oldest');
  await expect(page).toHaveURL(/\/safety\/hazards\?order=oldest$/);
  await page.getByRole('searchbox', { name: 'Find hazards', exact: true }).fill('gusts');
  await page.waitForTimeout(500);
  expect(page.url()).not.toContain('gusts');

  await bar(page).getByRole('link', { name: 'People', exact: true }).click();
  const list = page.getByRole('complementary', { name: 'People list', exact: true });
  await list.locator('.records-item').first().click();
  await expect(page).toHaveURL(/\/people\/[^/]+$/);
  const opened = page.url();
  await page.goBack();
  await expect(page).toHaveURL(/\/people$/);
  await page.goForward();
  await expect(page).toHaveURL(opened);
  await expect(list.locator('.records-item[aria-current="true"]')).toHaveCount(1);
});
