import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('an administrator adds a pilot, changes what they may do and deactivates them, and no one is deleted', async ({
  page,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const name = `Fictional Pilot ${run}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });

  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Start from').selectOption({ label: 'Pilot' });
  await expect(add.getByLabel('Acknowledge a briefing')).toBeChecked();
  await expect(add.getByLabel('Manage people and what they may do')).not.toBeChecked();
  await add.getByRole('button', { name: 'Add person' }).click();
  await expect(area.getByText(`${name} was added. The addition is recorded.`)).toBeVisible();

  const person = area.getByRole('form', { name: `What ${name} may do` });
  await expect(person).toContainText('No identity-provider account tied');
  await person.getByLabel('Plan missions').check();
  await person.getByRole('button', { name: 'Save what they may do' }).click();
  await expect(area.getByText(`What ${name} may do was changed. The change is recorded.`)).toBeVisible();
  await expect(person.locator('dd', { hasText: 'Plan missions' })).toBeVisible();

  await person.getByRole('button', { name: 'Deactivate' }).click();
  await expect(area.getByText(`${name} was deactivated. The change is recorded.`)).toBeVisible();
  const listed = area
    .getByRole('complementary', { name: 'People list' })
    .getByRole('button', { name: new RegExp(name) });
  await expect(listed).toContainText('Inactive');
  await expect(person.getByRole('button', { name: 'Reactivate' })).toBeVisible();

  // The administrator cannot lock themselves out from this screen.
  await area.getByRole('button', { name: /Dana Ortiz/ }).click();
  const self = area.getByRole('form', { name: 'What Dana Ortiz may do' });
  await self.getByRole('button', { name: 'Deactivate' }).click();
  await expect(self).toContainText('You cannot deactivate yourself');
});
