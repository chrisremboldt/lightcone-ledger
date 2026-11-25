import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrganizationCoverageResponse } from '@ledger/contracts';

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
// earlier versions behind a disclosure, and takes the first and last day of the adoption; and a new organization
// opens on its first-day list.

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

/**
 * A new organization's first screen, from `pnpm org:create` alone, walked from nothing on file to its first adoption.
 * Run it against a stack with a database of its own, on an organization that has adopted no rule pack yet, created on
 * a local database without a sign-in issuer, which gives its administrator a development token:
 *
 *   pnpm org:create --name "Example Ridge Survey" --time-zone America/Denver --admin "Avery Example"
 *   LEDGER_BROWSER_NEW_ORGANIZATION_TOKEN=<the printed ledger-dev- token> pnpm test:browser first-run
 *
 * It adopts a pack, so it runs once per organization.
 */
const newOrganizationToken = process.env.LEDGER_BROWSER_NEW_ORGANIZATION_TOKEN;
const fixtures = join(import.meta.dirname, '..', 'integration', 'fixtures', 'ridge-records');
const fixture = (name: string, run: string) =>
  Buffer.from(readFileSync(join(fixtures, name), 'utf8').replaceAll('RIDGE-', `${run}-RIDGE-`));

async function importFile(area: Locator, recordTypeTitle: string, name: string, run: string, rows: number) {
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: recordTypeTitle });
  await area.getByRole('button', { name: 'Import a file', exact: true }).click();
  await area.getByLabel('File to import').setInputFiles({ name, mimeType: 'text/csv', buffer: fixture(name, run) });
  await area.getByRole('button', { name: 'Check file', exact: true }).click();
  await area.getByRole('button', { name: `Record ${rows} rows`, exact: true }).click();
  await expect(area.getByText(new RegExp(`^Recorded ${rows} of ${rows} rows\\.$`))).toBeVisible();
}

test('a new organization opens on its first day and walks it from nothing on file to its first adoption', async ({
  page,
  request,
}) => {
  test.skip(!newOrganizationToken, 'Set LEDGER_BROWSER_NEW_ORGANIZATION_TOKEN to a token pnpm org:create printed');
  test.setTimeout(180_000);
  const read = await request.get(`${api}/v1/organization/coverage`, {
    headers: { authorization: `Bearer ${newOrganizationToken}` },
  });
  expect(read.ok(), await read.text()).toBeTruthy();
  const { adoptions } = (await read.json()) as OrganizationCoverageResponse;
  test.skip(
    adoptions.some((adoption) => ['pending', 'scheduled', 'effective'].includes(adoption.state)),
    'Needs an organization that has adopted no rule pack yet; this test adopts one, so it runs once per organization',
  );
  const run = randomUUID().slice(0, 6).toUpperCase();
  await page.goto('/');
  const field = page.getByLabel('Development token', { exact: true });
  const disclosure = page.getByText('Use a development token', { exact: true });
  await expect(field.or(disclosure).first()).toBeVisible();
  if (await disclosure.count()) await disclosure.click();
  await field.fill(newOrganizationToken!);
  await page.getByRole('button', { name: 'Open with this token', exact: true }).click();

  // Before its first adoption the organization opens on its first-day list, at its own address.
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page).toHaveTitle('Setup · Ledger');
  const setup = page.getByTestId('first-day');
  const step = (key: string) => setup.getByTestId(`setup-step-${key}`);
  const setupLink = page.getByRole('navigation', { name: 'Sections', exact: true }).getByRole('link', {
    name: 'Setup',
    exact: true,
  });
  await expect(setupLink).toHaveAttribute('aria-current', 'page');

  // 1. Only the first administrator may sign in, which is on file; the step still links to the People screen.
  await expect(step('people')).toContainText('On file');
  await expect(step('people')).toContainText(/Only .+ may sign in\./);
  const name = `First Day Person ${run}`;
  await step('people').getByRole('link', { name: 'Add a person on the People screen', exact: true }).click();
  await expect(page).toHaveURL(/\/people$/);
  const people = page.getByRole('main', { name: 'People' });
  const add = people.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Start from').selectOption({ label: 'Pilot' });
  await add.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(people.getByText(`${name} was added. The addition is recorded.`, { exact: true })).toBeVisible();
  await setupLink.click();
  await expect(step('people')).toContainText('On file');
  await expect(step('people')).toContainText(name);

  // 2. An aircraft, a pilot and a flight, imported under Records.
  await expect(step('records')).toBeVisible();
  if (await step('records').getByText('Not on file', { exact: true }).count())
    await step('records').getByRole('link', { name: 'Import or enter records under Records', exact: true }).click();
  else await page.getByRole('link', { name: 'Records', exact: true }).click();
  await expect(page).toHaveURL(/\/records(\/import)?$/);
  const records = page.getByRole('main', { name: 'Operator records' });
  await importFile(records, 'Aircraft identity and registration', 'aircraft.identity.csv', run, 2);
  await importFile(records, 'Flight plan', 'flight.plan.csv', run, 3);
  await importFile(records, 'Role assignment', 'operation.role-assignment.csv', run, 3);
  await setupLink.click();
  await expect(step('records')).toContainText('On file');

  // 3. A pack file is built and loaded on a command line: the step shows the command, never a link.
  await expect(step('pack-file')).toContainText('Not on file');
  await expect(step('pack-file')).toContainText('pnpm pack:new <name> --kind waiver');
  await expect(step('pack-file').getByRole('link')).toHaveCount(0);

  // The safety items are listed under their step, and granting authority links an administrator to People.
  await expect(
    step('safety').getByRole('link', { name: 'Grant it on the People screen', exact: true }).first(),
  ).toBeVisible();

  // 4. A rule pack adopted on the Rules screen.
  await expect(step('adoption')).toContainText('No rule pack is adopted.');
  await step('adoption').getByRole('link', { name: 'Adopt a rule pack on the Rules screen', exact: true }).click();
  const rules = page.getByRole('main', { name: 'Rules and findings' });
  const form = rules.getByTestId('adopt-pack');
  await form
    .getByLabel('Rule pack', { exact: true })
    .selectOption({ label: 'Part 107 checks (14 CFR as of 2026-01-01) · version 2 · built into Ledger' });
  await form.getByRole('radio', { name: /Active/ }).check();
  await form.getByLabel('Reason, kept with the adoption', { exact: true }).fill('The rules we fly under.');
  await form.getByRole('button', { name: 'Adopt in active', exact: true }).click();
  const adopted = rules.getByTestId('adoption').filter({ hasText: 'version 2' });
  await expect(adopted.getByText('In effect', { exact: true })).toBeVisible({ timeout: 60_000 });
  await setupLink.click();
  await expect(step('adoption')).toContainText('On file');
  await expect(step('adoption')).toContainText('version 2, active');

  // 5. Coverage is read, and said in one line rather than ticked.
  await expect(step('coverage')).toContainText(/rules? with a|no rule with a subject needing attention/);
  await expect(step('coverage').getByText('On file', { exact: true })).toHaveCount(0);
  await expect(setup).not.toContainText(/complete|ready|conform|compliant|authorized/i);
});
