import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Signs in through the test issuer instead of a development token. It needs a stack set up for it, so it runs only
 * when LEDGER_BROWSER_TEST_ISSUER names the issuer:
 *
 *   pnpm test-issuer                                   # http://127.0.0.1:4010, client ledger-local
 *   LEDGER_OIDC_ISSUER=http://127.0.0.1:4010 LEDGER_OIDC_CLIENT_ID=ledger-local pnpm dev
 *   LEDGER_OIDC_ISSUER=http://127.0.0.1:4010 LEDGER_OIDC_CLIENT_ID=ledger-local pnpm org:create \
 *     --name "Fictional Test Survey" --time-zone America/Denver --admin "Test Administrator" \
 *     --sign-in-issuer http://127.0.0.1:4010 --sign-in-subject test-administrator
 *   LEDGER_BROWSER_TEST_ISSUER=http://127.0.0.1:4010 pnpm test:browser openid-connect
 *
 * A subject is tied to one person only, so it runs once per database.
 */
const issuer = process.env.LEDGER_BROWSER_TEST_ISSUER;

async function signInAs(page: Page, person: string) {
  await page.goto('/');
  await page.getByRole('button', { name: `Sign in through ${new URL(issuer!).host}` }).click();
  await expect(page.getByRole('heading', { name: 'Test issuer' })).toBeVisible();
  await page.getByRole('link', { name: person, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test.skip(!issuer, 'Set LEDGER_BROWSER_TEST_ISSUER to run against a stack configured with the test issuer');

test('an administrator signs in through the provider, adds a person, and that person signs in', async ({ page }) => {
  const name = `Fictional Person ${randomUUID().slice(0, 6).toUpperCase()}`;
  await signInAs(page, 'Test Administrator');
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });
  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Start from').selectOption({ label: 'Pilot' });
  await add.getByLabel('Sign-in account (subject)').fill('test-person');
  await add.getByRole('button', { name: 'Add person' }).click();
  await expect(area.getByText(`${name} was added. The addition is recorded.`)).toBeVisible();
  await expect(area.getByRole('form', { name: `What ${name} may do` })).toContainText(
    'Tied to an identity-provider account',
  );

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInAs(page, 'Test Person');
  await expect(page.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
});
