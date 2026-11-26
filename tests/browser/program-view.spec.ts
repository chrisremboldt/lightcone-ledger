import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * An operator grants a program owner a read of its open findings, the program owner follows it and sees its row, and
 * the operator revokes the grant. Both organizations are on the seeded stack: the program owner's worker reads the
 * operator at this stack's own address, as on a deployment that serves both. Needs the seeded stack with the workers
 * running.
 */

// Signing in is kept in the page only: the address is opened first and signed in at, and the page is never reloaded.
async function openAs(page: Page, organization: string, address: string) {
  await page.goto(address);
  await page.getByRole('radio', { name: organization, exact: true }).check();
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
}

test('an operator makes and revokes a grant, and the program owner follows it and sees its row', async ({
  page,
  browser,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const programOwner = `Beta Inspection program ${run}`;
  await openAs(page, 'Alpha Dispatch', '/reports/grants');
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
  // The secret is shown once on screen and never printed.
  await page.emulateMedia({ media: 'print' });
  await expect(report.getByTestId('program-grant-secret')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await report.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(report.getByTestId('program-grant-secret')).toHaveCount(0);
  const grant = report.getByRole('article', { name: `Grant to ${programOwner}`, exact: true });
  await expect(grant.getByText('In force', { exact: true })).toBeVisible();
  await expect(grant).toContainText('Open findings by rule');

  const context = await browser.newContext();
  const owner = await context.newPage();
  try {
    await openAs(owner, 'Beta Inspection', '/reports/operators');
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
          await view.getByRole('button', { name: 'Show the latest reads', exact: true }).click();
          return (await row.getByTestId('program-operator-state').textContent()) ?? '';
        },
        { timeout: 30_000 },
      )
      .toMatch(/^Read /);
    await expect(row.getByText('Read', { exact: true })).toBeVisible();
    await expect(row.getByRole('region', { name: 'Open findings', exact: true })).toBeVisible();

    await grant.getByRole('button', { name: 'Revoke this grant', exact: true }).click();
    await grant.getByRole('textbox', { name: 'Why it is revoked', exact: true }).fill('The contract ended');
    await grant.getByRole('button', { name: 'Revoke at once', exact: true }).click();
    await expect(grant.getByText('Revoked', { exact: true }).first()).toBeVisible();
    await expect(grant).toContainText('The contract ended');

    await row.getByRole('button', { name: 'Ask for a fresh read', exact: true }).click();
    await expect
      .poll(
        async () => {
          await view.getByRole('button', { name: 'Show the latest reads', exact: true }).click();
          return (await row.getByTestId('program-operator-state').textContent()) ?? '';
        },
        { timeout: 30_000 },
      )
      .toMatch(/opens nothing/);
    await expect(row.getByText('Grant ended', { exact: true })).toBeVisible();
    // The last answer is still shown, with its date, not as current.
    await expect(row.getByRole('region', { name: 'Open findings', exact: true })).toBeVisible();
    await expect(row.getByTestId('program-operator-state')).toContainText('not as current');

    // The grants page opened afresh lists the grant with its reads.
    const again = await context.newPage();
    await openAs(again, 'Alpha Dispatch', '/reports/grants');
    const listed = again
      .getByRole('region', { name: 'Report', exact: true })
      .getByRole('article', { name: `Grant to ${programOwner}`, exact: true });
    await expect(listed.getByText('Revoked', { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});
