import { expect, test, type Page } from '@playwright/test';
import { openAccount } from './account-fixture.js';

// The theme follows the system until a person chooses one in their account, opened from their name in the bar; the choice is kept in this browser and applied
// before the page first paints, so a reload neither flashes nor forgets it.

test.use({ colorScheme: 'light' });

async function openAs(page: Page) {
  await page.getByRole('radio', { name: 'Fictional Valley Power', exact: true }).check();
  await page.getByLabel('Person').selectOption('safety');
  await page.getByRole('button', { name: 'Open operations' }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
}

const shown = (page: Page) =>
  page.evaluate(() => ({
    chosen: document.documentElement.dataset.theme ?? null,
    stored: localStorage.getItem('ledger-theme'),
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.documentElement).backgroundColor,
  }));

test('a chosen theme is kept across a reload, and System follows the system again', async ({ page }) => {
  await page.goto('/');
  await openAs(page);
  // Reporting a safety concern stays in the bar itself; the theme is in the account.
  const bar = page.getByRole('banner');
  await expect(bar.getByRole('button', { name: 'Report a safety concern', exact: true })).toBeVisible();
  await expect(bar.getByRole('combobox', { name: 'Theme', exact: true })).toHaveCount(0);
  await openAccount(page);
  const theme = bar.getByRole('combobox', { name: 'Theme', exact: true });
  await expect(theme).toHaveValue('system');
  const light = await shown(page);
  expect(light.chosen).toBeNull();
  expect(light.background).toBe('rgb(244, 244, 242)');

  await theme.selectOption({ label: 'Dark theme' });
  // Choosing keeps the account open; Escape closes it and returns to the name.
  await expect(theme).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(theme).toBeHidden();
  await expect(page.locator('.topbar button.topbar-user:visible')).toBeFocused();
  expect(await shown(page)).toEqual({
    chosen: 'dark',
    stored: 'dark',
    scheme: 'dark',
    background: 'rgb(13, 13, 13)',
  });

  // Set by the page's head before the application runs (in development the stylesheets come with it).
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.unroute('**/src/main.tsx');
  await page.reload();
  await openAs(page);
  await openAccount(page);
  await expect(theme).toHaveValue('dark');

  await theme.selectOption({ label: 'System theme' });
  expect(await shown(page)).toEqual({
    chosen: null,
    stored: null,
    scheme: 'light dark',
    background: 'rgb(244, 244, 242)',
  });
  // A click outside the account closes it.
  await page.getByRole('heading', { name: 'What needs attention' }).click();
  await expect(theme).toBeHidden();
});

test('on a phone the theme is in the menu, which closes on Escape and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await openAs(page);
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(page.getByRole('banner').getByRole('combobox', { name: 'Theme', exact: true })).toHaveCount(0);
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const opened = page.locator('.topbar-menu');
  await expect(opened.getByRole('link', { name: 'Safety', exact: true })).toBeFocused();
  await opened.getByRole('combobox', { name: 'Theme', exact: true }).selectOption({ label: 'Light theme' });
  expect((await shown(page)).stored).toBe('light');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(opened).toBeHidden();
  await expect(menu).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
