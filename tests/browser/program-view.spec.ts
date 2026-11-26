import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * An operator grants a program owner a read of its open findings, the program owner follows it and sees its row, and
 * the operator revokes the grant. Both organizations are on the seeded stack: the program owner's worker reads the
 * operator at this stack's own address, as on a deployment that serves both. Needs the seeded stack with the workers
 * running.
 */

async function openAs(page: Page, organization: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: organization, exact: true }).check();
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
}

test('an operator makes and revokes a grant, and the program owner follows it and sees its row', async ({
  page,
  browser,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const programOwner = `Beta Inspection program ${run}`;
  await openAs(page, 'Alpha Dispatch');
  await page.goto('/reports/grants');
  const report = page.getByRole('region', { name: 'Report', exact: true });
  await expect(report.getByRole('heading', { name: 'Shown to program owners', exact: true })).toBeVisible();
  const form = report.getByRole('form', { name: 'Make a grant' });
  await form.getByLabel('Program owner', { exact: true }).fill(programOwner);
  await expect(form.getByLabel('Days it answers', { exact: true })).toHaveValue('90');
  await form.getByLabel('How many are open for each rule, and the oldest one’s age', { exact: true }).check();
  await form.getByRole('button', { name: 'Make the grant', exact: true }).click();
  const secret = (await report.getByTestId('program-grant-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^ledger-program-[A-Za-z0-9_-]{43}$/);
  const address = (await report.getByTestId('program-grant-address').textContent())?.trim() ?? '';
  await report.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(report.getByTestId('program-grant-secret')).toHaveCount(0);
  const grant = report.getByRole('article', { name: `Grant to ${programOwner}`, exact: true });
  await expect(grant.getByText('In force', { exact: true })).toBeVisible();
  await expect(grant).toContainText('Open findings by rule');

  const context = await browser.newContext();
  const owner = await context.newPage();
  try {
    await openAs(owner, 'Beta Inspection');
    await owner.goto('/reports/operators');
    const view = owner.getByRole('region', { name: 'Report', exact: true });
    const follow = view.getByRole('form', { name: 'Follow an operator' });
    const name = `Alpha crews ${run}`;
    await follow.getByLabel('Your name for the operator', { exact: true }).fill(name);
    await follow.getByLabel('Address of its Ledger', { exact: true }).fill(address);
    await follow.getByLabel('Secret', { exact: true }).fill(secret);
    await follow.getByRole('button', { name: 'Follow the operator', exact: true }).click();
    const row = view.getByRole('article', { name, exact: true });
    await expect(row).toBeVisible();
    await expect(view).not.toContainText(secret);
    // The workers read it as soon as it is followed.
    await expect
      .poll(
        async () => {
          await owner.reload();
          return (await row.getByTestId('program-operator-state').textContent()) ?? '';
        },
        { timeout: 30_000 },
      )
      .toMatch(/^Read /);
    await expect(row.getByText('Read', { exact: true })).toBeVisible();
    await expect(row.getByRole('region', { name: 'Open findings', exact: true })).toBeVisible();

    await grant.getByRole('button', { name: 'Revoke this grant', exact: true }).click();
    await grant.getByLabel('Why it is revoked', { exact: true }).fill('The contract ended');
    await grant.getByRole('button', { name: 'Revoke at once', exact: true }).click();
    await expect(grant.getByText('Revoked', { exact: true }).first()).toBeVisible();
    await expect(grant).toContainText('The contract ended');

    await row.getByRole('button', { name: 'Ask for a fresh read', exact: true }).click();
    await expect
      .poll(
        async () => {
          await owner.reload();
          return (await row.getByTestId('program-operator-state').textContent()) ?? '';
        },
        { timeout: 30_000 },
      )
      .toMatch(/opens nothing/);
    await expect(row.getByText('Grant ended', { exact: true })).toBeVisible();
    // The last answer is still shown, with its date, not as current.
    await expect(row.getByRole('region', { name: 'Open findings', exact: true })).toBeVisible();
    await expect(row.getByTestId('program-operator-state')).toContainText('not as current');
  } finally {
    await context.close();
  }
});
