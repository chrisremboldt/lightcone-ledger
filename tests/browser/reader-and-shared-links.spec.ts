import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * A reader added from the Reader preset sees no action they cannot take; a dispatcher makes and revokes a link to one
 * produced set; the page the link opens needs no sign-in. Needs the seeded stack.
 */

const operator = { authorization: 'Bearer ledger-dev-alpha-operator' };

async function produceSet(request: APIRequestContext, run: string): Promise<string> {
  const produced = await request.post('/v1/record-productions', {
    headers: { ...operator, 'idempotency-key': randomUUID() },
    data: { reason: `Records asked for at an inspection ${run}`, requestedBy: 'Inspector, regional office' },
  });
  expect(produced.status()).toBe(201);
  return (await produced.json()).record.id as string;
}

test('a reader added from the Reader preset is offered nothing they cannot do', async ({ page, browser }) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const name = `Fictional Inspector ${run}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });
  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(name);
  await add.getByLabel('Start from').selectOption({ label: 'Reader' });
  await add.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(area.getByText(`${name} was added. The addition is recorded.`, { exact: true })).toBeVisible();
  const part = area.getByRole('region', { name: `Development token for ${name}`, exact: true });
  await part.getByRole('button', { name: 'Issue a development token', exact: true }).click();
  const token = (await part.getByLabel('New development token', { exact: true }).textContent())?.trim() ?? '';
  expect(token).toMatch(/^ledger-dev-[A-Za-z0-9_-]{32}$/);

  const context = await browser.newContext();
  const theirs = await context.newPage();
  try {
    await theirs.goto('/');
    await theirs.getByText('Use a development token', { exact: true }).click();
    await theirs.getByLabel('Development token', { exact: true }).fill(token);
    await theirs.getByRole('button', { name: 'Open with this token', exact: true }).click();
    // A reader opens on the records.
    await expect(theirs.getByRole('main', { name: 'Operator records' })).toBeVisible();
    await expect(theirs.getByRole('link', { name: 'Records', exact: true })).toBeVisible();
    await expect(theirs.getByRole('link', { name: 'Rules', exact: true })).toBeVisible();
    await expect(theirs.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
    // Reporting a safety concern is open to everyone who signs in, a reader too.
    await expect(theirs.getByRole('button', { name: 'Report a safety concern', exact: true })).toBeVisible();

    await theirs.getByRole('link', { name: 'Records', exact: true }).click();
    const records = theirs.getByRole('main', { name: 'Operator records' });
    await expect(records.getByRole('button', { name: 'Produced records', exact: true })).toBeVisible();
    for (const action of ['Produce records', 'Import a file', 'Enter a record'])
      await expect(records.getByRole('button', { name: action, exact: true })).toHaveCount(0);

    // Under Safety a reader has the controlled documents and no other register.
    await theirs.getByRole('link', { name: 'Safety', exact: true }).click();
    const navigation = theirs.getByRole('complementary', { name: 'Safety navigation' });
    await expect(navigation.getByRole('button', { name: /^Documents/ })).toBeVisible();
    for (const register of [/^Safety home/, /^Hazard register/, /^Safety reports/, /^Safety assurance/])
      await expect(navigation.getByRole('button', { name: register })).toHaveCount(0);
    await expect(theirs.getByRole('complementary', { name: 'Document actions' })).toBeHidden();
  } finally {
    await context.close();
  }
});

test('a dispatcher makes a link to one produced set, sees it opened, and revokes it at once', async ({ page }) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const id = await produceSet(page.request, run);
  // Signing in is kept in the page only, so the set's own address is opened first and signed in at.
  const openSet = async () => {
    await page.goto(`/records/produced/${id}`);
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
  };
  await openSet();
  const set = page.getByTestId('produced-set');
  await expect(set.getByText('No link has been made to this set.', { exact: true })).toBeVisible();
  const form = set.getByRole('form', { name: 'Make a link' });
  await expect(form.getByLabel('Days it opens the set', { exact: true })).toHaveValue('7');
  await form.getByLabel('Who the link is for', { exact: true }).fill(`Inspector, regional office ${run}`);
  await form.getByRole('button', { name: 'Make a link', exact: true }).click();
  const address = (await set.getByTestId('record-link-address').textContent())?.trim() ?? '';
  expect(address).toMatch(/\/shared#ledger-records-[A-Za-z0-9_-]{43}$/);
  await set.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(set.getByTestId('record-link-address')).toHaveCount(0);

  const secret = address.split('#')[1]!;
  const opened = await page.request.post('/v1/shared-records', { data: { secret } });
  expect(opened.status()).toBe(200);
  await openSet();
  const entry = page.getByRole('article', { name: `Link for Inspector, regional office ${run}`, exact: true });
  await expect(entry.getByText('Opens the set', { exact: true })).toBeVisible();
  await expect(
    entry.getByRole('table', { name: `Openings of the link for Inspector, regional office ${run}` }),
  ).toContainText('The page');

  await entry.getByRole('button', { name: 'Revoke this link', exact: true }).click();
  await entry.getByLabel('Why it is revoked', { exact: true }).fill('The inspection is over');
  await entry.getByRole('button', { name: 'Revoke at once', exact: true }).click();
  await expect(entry.getByText('Revoked', { exact: true }).first()).toBeVisible();
  await expect(entry).toContainText('The inspection is over');
  expect((await page.request.post('/v1/shared-records', { data: { secret } })).status()).toBe(404);
});

test('the page a link opens needs no sign-in, shows the set and its files, and says plainly when it opens nothing', async ({
  browser,
  request,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const id = await produceSet(request, run);
  const made = await request.post(`/v1/record-productions/${id}/links`, {
    headers: { ...operator, 'idempotency-key': randomUUID() },
    data: { note: `Auditor ${run}` },
  });
  expect(made.status()).toBe(201);
  const { secret, link } = await made.json();

  // A fresh browser: no sign-in, no token, nothing stored.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  try {
    // The API serves this page with no-store, no-referrer and noindex (tests/unit/web-app.test.ts); pnpm dev does not.
    // One visit is one opening: the page asks for the set once, also under pnpm dev, which runs effects twice.
    let asked = 0;
    visitor.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/v1/shared-records') asked += 1;
    });
    await visitor.goto(`/shared#${secret}`);
    const shared = visitor.getByTestId('shared-records');
    await expect(shared.getByRole('heading', { level: 1 })).toBeVisible();
    expect(asked).toBe(1);
    await expect(shared).toContainText(`Records asked for at an inspection ${run}`);
    await expect(shared).toContainText('Inspector, regional office');
    await expect(shared.getByRole('button', { name: 'Download the whole .zip', exact: true })).toBeVisible();
    const files = shared.getByRole('table', { name: 'Files in the set' });
    await expect(files).toContainText('manifest.json');
    await shared.getByRole('button', { name: 'Read index.html', exact: true }).click();
    await expect(shared.getByRole('region', { name: 'Reading index.html' })).toBeVisible();
    await expect(visitor.getByRole('link', { name: 'Records', exact: true })).toHaveCount(0);

    const revoked = await request.post(`/v1/record-production-links/${link.id}/revoke`, {
      headers: operator,
      data: { reason: 'Shared by mistake' },
    });
    expect(revoked.status()).toBe(200);
    await visitor.reload();
    await expect(visitor.getByText('No records to show', { exact: true })).toBeVisible();
    await expect(
      visitor.getByText('This link does not open any records. It may have expired or been revoked.', { exact: true }),
    ).toBeVisible();
    await visitor.goto(`/shared#ledger-records-${'A'.repeat(43)}`);
    await expect(
      visitor.getByText('This link does not open any records. It may have expired or been revoked.', { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
