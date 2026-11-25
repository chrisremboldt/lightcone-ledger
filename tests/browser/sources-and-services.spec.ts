import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('an administrator issues a source a credential, sees its secret once, and revokes it', async ({ page }) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const name = `Fictional Dock Adapter ${run}`;
  const label = `Hangar host ${run}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });

  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Kind').selectOption({ label: 'A source that reports to Ledger' });
  await add.getByLabel('Submit reports and records', { exact: true }).check();
  await add.getByRole('button', { name: 'Add person' }).click();
  await expect(area.getByText(`${name} was added. The addition is recorded.`)).toBeVisible();

  const part = area.getByRole('region', { name: 'Sources and services' });
  const issue = part.getByRole('form', { name: 'Issue a credential' });
  await issue.getByLabel(/^For/).selectOption({ label: `${name} (Source)` });
  await issue.getByLabel(/^Label/).fill(label);
  await issue.getByLabel(/^Accepted for/).selectOption({ label: '30 days' });
  await issue.getByRole('button', { name: 'Issue credential' }).click();

  const secret = (await part.getByLabel('Credential secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^ledger-service-[A-Za-z0-9_-]{43}$/);
  const me = await page.request.get('/v1/me', { headers: { authorization: `Bearer ${secret}` } });
  expect(me.status()).toBe(200);
  expect((await me.json()).principal.name).toBe(name);

  await part.getByRole('button', { name: 'I have stored it' }).click();
  await expect(part.getByLabel('Credential secret')).toHaveCount(0);
  const row = part.getByRole('row', { name: new RegExp(label) });
  await expect(row).toContainText('In use');
  await expect(row).toContainText('by Dana Ortiz');
  await expect(part).not.toContainText(secret);

  await row.getByRole('button', { name: `Revoke ${label}` }).click();
  await row.getByRole('button', { name: 'Revoke now' }).click();
  await expect(part.getByText(`The credential “${label}” was revoked. The revocation is recorded.`)).toBeVisible();
  await expect(part.getByRole('row', { name: new RegExp(label) })).toContainText('Revoked');
  const refused = await page.request.get('/v1/me', { headers: { authorization: `Bearer ${secret}` } });
  expect(refused.status()).toBe(401);
});
