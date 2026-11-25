import { test, expect, type APIRequestContext } from '@playwright/test';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');

/** Whether this database holds the seeded fictional organizations: the API knows a seeded person's token. */
async function seeded(request: APIRequestContext): Promise<boolean> {
  const response = await request.get(`${api}/v1/me`, {
    headers: { authorization: 'Bearer ledger-dev-alpha-operator' },
  });
  return response.ok();
}

// The first hour of an organization of its own on a local stack: the sign-in screen offers only the organizations the
// database holds and opens a development token on Enter; the adopt form offers the latest version of each pack, with
// earlier versions behind a disclosure, and takes the first and last day of the adoption.

test('Enter in the development token field opens that token, not the person chosen above', async ({
  page,
  request,
}) => {
  test.skip(!(await seeded(request)), 'Needs the seeded fictional organizations to choose one above the field');
  await page.goto('/');
  await page.getByRole('radio', { name: 'Beta Inspection', exact: true }).check();
  await page.getByText('Use a development token', { exact: true }).click();
  const field = page.getByLabel('Development token', { exact: true });
  await field.fill('ledger-dev-alpha-operator');
  const opened = page.waitForRequest(
    (request) =>
      request.url().endsWith('/v1/me') && request.headers().authorization === 'Bearer ledger-dev-alpha-operator',
  );
  await field.press('Enter');
  await opened;
  await expect(page.getByRole('button', { name: 'Switch operator', exact: true })).toBeVisible();
});

test('a database without the fictional organizations leads with the development token', async ({ page }) => {
  // As an unseeded database answers: no seeded person's development token is known.
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unauthenticated', message: 'Credential is invalid' }, requestId: 'r' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Open your organization', exact: true })).toContainText(
    'This database holds none of the fictional organizations.',
  );
  await expect(page.getByRole('radio', { name: 'Alpha Dispatch', exact: true })).toHaveCount(0);
  // Without a fictional organization the screen says what Ledger is and names nothing fictional.
  await expect(page.getByText(/^An operational record and rule checker for drone programs\./)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Alpha');
  await expect(page.locator('body')).not.toContainText('simulat');
  await expect(page.locator('body')).not.toContainText('fictional operators');
  await expect(page.getByRole('button', { name: 'Open operations', exact: true })).toHaveCount(0);
  const open = page.getByRole('button', { name: 'Open with this token', exact: true });
  await expect(open).toBeDisabled();
  await page.getByLabel('Development token', { exact: true }).fill('ledger-dev-example-token');
  await expect(open).toBeEnabled();
});

test('the adopt form offers the latest version of each pack and takes the adoption’s first and last day', async ({
  page,
  request,
}) => {
  test.skip(!(await seeded(request)), 'Needs the seeded fictional organizations to open Alpha Dispatch');
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  const form = page.getByRole('main', { name: 'Rules and findings' }).getByTestId('adopt-pack');

  const latest = form.getByLabel('Rule pack', { exact: true });
  await expect(
    latest.getByRole('option', {
      name: 'Part 108 NPRM checks (shadow only) · version 3 · built into Ledger',
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    latest.getByRole('option', { name: 'Part 108 NPRM coverage · version 1 · built into Ledger', exact: true }),
  ).toHaveCount(0);

  // Earlier versions sit behind their own disclosure.
  await form.getByText('Earlier versions', { exact: true }).click();
  await form
    .getByLabel('Earlier version', { exact: true })
    .selectOption({ label: 'Part 108 NPRM coverage · version 1 · built into Ledger' });
  await expect(form.getByTestId('adopt-pack-rules').getByRole('listitem').first()).toBeVisible();

  // A pack with no certificate starts today, for a year; the days can start before today.
  await latest.selectOption({ label: 'Part 107 checks (14 CFR as of 2026-01-01) · version 2 · built into Ledger' });
  const from = form.getByLabel('From the start of', { exact: true });
  const through = form.getByLabel('To the end of', { exact: true });
  await expect(from).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await from.fill('2026-01-01');
  await through.fill('2026-12-31');
  await expect(form.getByTestId('adopt-dates-meaning')).toHaveText(
    'The rules cover flights and records inside these dates: from the start of January 1, 2026 to the end of December 31, 2026, in America/Chicago. Anything recorded about a time before or after them is not counted under this adoption.',
  );
  await form.getByLabel('Reason, kept with the adoption', { exact: true }).fill('Records from this year.');
  await through.fill('2025-12-31');
  await expect(form.getByTestId('adopt-dates-meaning')).toHaveText('The last day is before the first day.');
  await expect(form.getByRole('button', { name: 'Adopt in shadow', exact: true })).toBeDisabled();
});
