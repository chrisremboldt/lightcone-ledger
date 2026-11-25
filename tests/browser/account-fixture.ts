import type { Page } from '@playwright/test';

/** Opens the account from the person's name in the wide bar, where "Switch operator" and "Sign out" are. */
export async function openAccount(page: Page): Promise<void> {
  await page.locator('.topbar button.topbar-user:visible').click();
}
