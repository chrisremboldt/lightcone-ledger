import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('an administrator issues a person a development token, shown once, and a new one replaces it', async ({
  page,
  browser,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const name = `Fictional Pilot ${run}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });

  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Start from').selectOption({ label: 'Pilot' });
  await add.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(area.getByText(`${name} was added. The addition is recorded.`, { exact: true })).toBeVisible();

  const part = area.getByRole('region', { name: `Development token for ${name}`, exact: true });
  await expect(part).toContainText('Development tokens are for a trial on a computer that faces no network.');
  await part.getByRole('button', { name: 'Issue a development token', exact: true }).click();
  await expect(part.getByText(`Development token issued to ${name}`, { exact: true })).toBeVisible();
  const first = (await part.getByLabel('New development token', { exact: true }).textContent())?.trim() ?? '';
  expect(first).toMatch(/^ledger-dev-[A-Za-z0-9_-]{32}$/);
  const me = await page.request.get('/v1/me', { headers: { authorization: `Bearer ${first}` } });
  expect(me.status()).toBe(200);
  expect((await me.json()).principal.name).toBe(name);

  await part.getByRole('button', { name: 'I have given it to them', exact: true }).click();
  await expect(part.getByLabel('New development token', { exact: true })).toHaveCount(0);
  await expect(part).not.toContainText(first);

  // A second issue replaces the first at once.
  await part.getByRole('button', { name: 'Issue a development token', exact: true }).click();
  await expect(part.getByText(`The token ${name} held before no longer works.`, { exact: true })).toBeVisible();
  const second = (await part.getByLabel('New development token', { exact: true }).textContent())?.trim() ?? '';
  expect(second).toMatch(/^ledger-dev-[A-Za-z0-9_-]{32}$/);
  expect(second).not.toBe(first);
  const refused = await page.request.get('/v1/me', { headers: { authorization: `Bearer ${first}` } });
  expect(refused.status()).toBe(401);

  // The person signs in on the sign-in screen with their own token.
  const context = await browser.newContext();
  const theirs = await context.newPage();
  try {
    await theirs.goto('/');
    await theirs.getByText('Use a development token', { exact: true }).click();
    await theirs.getByLabel('Development token', { exact: true }).fill(second);
    await theirs.getByRole('button', { name: 'Open with this token', exact: true }).click();
    await expect(theirs.getByRole('button', { name: 'Switch operator', exact: true })).toBeVisible();
    // A pilot does not manage people, so the People screen is not offered.
    await expect(theirs.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
