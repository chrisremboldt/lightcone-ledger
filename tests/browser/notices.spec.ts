import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openAccount } from './account-fixture.js';

// Notices: a person's own choices in their account, the administrator's list of every notice, and the organization's
// webhook, whose secret is shown once. Runs on the seeded stack as the fictional Alpha administrator.

async function openAlpha(page: Page, path = '/') {
  await page.goto(path);
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
}

test('a person keeps their address and chooses which notices arrive by email, in their account', async ({ page }) => {
  const address = `dana.${randomUUID().slice(0, 6)}@example.org`;
  await openAlpha(page);
  await openAccount(page);
  const bar = page.getByRole('banner');
  await bar.getByText('Email notices', { exact: true }).click();
  const form = bar.getByRole('form', { name: 'Your email notices' });
  await form.getByLabel('Your email address', { exact: true }).fill(address);
  await form.getByLabel('An action of mine is due within three days', { exact: true }).uncheck();
  await form.getByLabel('Digest', { exact: true }).selectOption({ label: 'A daily digest' });
  await form.getByRole('button', { name: 'Save my notices', exact: true }).click();
  // Saving keeps the account open to show what was saved.
  await expect(form.getByText('Your notices were saved. The change is recorded.', { exact: true })).toBeVisible();

  await page.reload();
  await openAlpha(page);
  await openAccount(page);
  await bar.getByText('Email notices', { exact: true }).click();
  await expect(form.getByLabel('Your email address', { exact: true })).toHaveValue(address);
  await expect(form.getByLabel('An action of mine is due within three days', { exact: true })).not.toBeChecked();
  await expect(form.getByLabel('A finding or an action is assigned to me', { exact: true })).toBeChecked();
  await expect(form.getByLabel('Digest', { exact: true })).toHaveValue('daily');
});

test('the People screen says who has no address, and an administrator sets one', async ({ page }) => {
  await openAlpha(page);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });
  const list = area.getByRole('complementary', { name: 'People list' });
  const without = list.getByRole('button').filter({ hasText: 'no email address: gets no email' }).first();
  await expect(without).toBeVisible();
  const name = (await without.locator('strong').textContent())!.trim();
  await without.click();
  const form = area.getByRole('form', { name: `Email notices for ${name}` });
  await expect(form).toContainText(`No email address is kept for ${name}, so they get no email notices.`);
  const address = `crew.${randomUUID().slice(0, 6)}@example.org`;
  await form.getByLabel('Email address', { exact: true }).fill(address);
  await form.getByRole('button', { name: 'Save the address', exact: true }).click();
  await expect(
    area.getByText(`${name} gets email notices at ${address}. The change is recorded.`, { exact: true }),
  ).toBeVisible();
});

test('an administrator reads every notice with its state, at an address of its own', async ({ page }) => {
  await openAlpha(page);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('link', { name: 'Notices sent', exact: true }).click();
  await expect(page).toHaveURL(/\/people\/notices$/);
  const area = page.getByRole('main', { name: 'Notices' });
  await expect(area.getByRole('heading', { name: 'Notices', exact: true })).toBeVisible();
  await area.getByLabel('State', { exact: true }).selectOption({ label: 'Given up' });
  await expect(
    area.getByRole('table', { name: 'Notices' }).or(area.getByText('No notice is given up.', { exact: true })),
  ).toBeVisible();
  await page.reload();
  await openAlpha(page, '/people/notices');
  await expect(page.getByRole('main', { name: 'Notices' })).toBeVisible();
});

test('the webhook’s secret is shown once, when it is set, and never again', async ({ page }) => {
  await openAlpha(page, '/people/notices/webhook');
  const area = page.getByRole('main', { name: 'Webhook for notices' });
  const form = area.getByRole('form', { name: 'Set the webhook' });
  await form.getByLabel('Address to post notices to', { exact: true }).fill('http://127.0.0.1:4002/_notices/webhook');
  await form.getByRole('button', { name: /^Set (the webhook|it again with a new secret)$/ }).click();
  const secret = area.getByLabel('New webhook secret', { exact: true });
  await expect(secret).toHaveText(/^[A-Za-z0-9_-]{43}$/);
  const shown = (await secret.textContent())!;
  await expect(area.getByText('http://127.0.0.1:4002/_notices/webhook', { exact: true })).toBeVisible();
  await area.getByRole('button', { name: 'I have kept it', exact: true }).click();
  await expect(secret).toHaveCount(0);

  await page.reload();
  await openAlpha(page, '/people/notices/webhook');
  await expect(page.getByRole('main', { name: 'Webhook for notices' })).toBeVisible();
  expect(await page.content()).not.toContain(shown);

  // Removed again, so the seeded organization posts nowhere during the other specs.
  await page.getByRole('button', { name: 'Remove the webhook', exact: true }).click();
  await expect(page.getByText('None set: no webhook is called', { exact: true })).toBeVisible();
});
