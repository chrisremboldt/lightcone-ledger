import { expect, test, type Page } from '@playwright/test';

// A printed page holds the place that is open and nothing else: a screen kept mounted but hidden, such as the flights
// while Rules or Safety is open, stays hidden on paper. The bar gives way to a heading of the organization.

async function openAs(page: Page, organization: string, person: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: organization, exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations' }).click();
}

async function print(page: Page) {
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
}

test.afterEach(async ({ page }) => {
  await page.emulateMedia({ media: 'screen' });
});

test('an organization with flights prints Rules and Safety without its flights', async ({ page }) => {
  await openAs(page, 'Alpha Dispatch', 'operator');
  const flights = page.getByRole('heading', { name: 'Current operation', exact: true });
  await expect(flights).toBeVisible();

  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  const rules = page.getByRole('main', { name: 'Rules' });
  await expect(rules.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();
  await print(page);
  const heading = page.locator('.print-heading');
  await expect(heading).toBeVisible();
  await expect(heading.locator('strong')).toHaveAttribute('data-print', 'Alpha Dispatch');
  await expect(heading.locator('span').last()).toHaveAttribute('data-print', /^Printed .+ \d{2}:\d{2} /);
  await expect(page.getByRole('heading', { name: 'Adopted rule packs' }).first()).toBeVisible();
  await expect(flights).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeHidden();

  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('link', { name: 'Safety', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
  await print(page);
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
  await expect(flights).toBeHidden();
});

test('an organization without flights prints Rules without its safety home', async ({ page }) => {
  await openAs(page, 'Fictional Valley Power', 'safety');
  const home = page.getByRole('heading', { name: 'What needs attention' });
  await expect(home).toBeVisible();
  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  await expect(home).toBeHidden();
  await print(page);
  await expect(page.locator('.print-heading strong')).toHaveAttribute('data-print', 'Fictional Valley Power');
  await expect(page.getByRole('main', { name: 'Rules and findings' })).toBeVisible();
  await expect(home).toBeHidden();
});
