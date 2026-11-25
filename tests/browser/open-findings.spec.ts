import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CurrentPrincipalResponse,
  FlightResponse,
  OpenFindingsResponse,
  TimelineResponse,
} from '@ledger/contracts';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const authorization = { authorization: 'Bearer ledger-dev-alpha-operator' };

async function timeline(request: APIRequestContext, flightId: string) {
  const response = await request.get(`${api}/v1/flights/${flightId}/timeline`, { headers: authorization });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as TimelineResponse;
}

test('a dispatcher finds an open finding in the list, takes it, records an action and closes it with a reason', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const seeded = await request.get(`${api}/v1/me`, { headers: authorization });
  test.skip(!seeded.ok(), 'Needs the seeded fictional organizations: Alpha Dispatch adopts the landing rule');
  // A flight whose landing is overdue: the adopted landing rule opens a finding about it that nobody owns.
  const label = `Open finding list ${randomUUID().slice(0, 6)}`;
  const created = await request.post(`${api}/v1/flights`, {
    headers: { ...authorization, 'idempotency-key': randomUUID() },
    data: {
      originationKey: `browser-open-finding:${randomUUID()}`,
      label,
      aircraft: 'Browser finding aircraft',
      scheduledStart: new Date(Date.now() - 40 * 60_000).toISOString(),
      scheduledEnd: new Date(Date.now() - 20 * 60_000).toISOString(),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const flight = ((await created.json()) as FlightResponse).flight;
  await expect
    .poll(async () => (await timeline(request, flight.id)).findings?.length ?? 0, { timeout: 60_000 })
    .toBe(1);

  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  const rules = page.getByRole('main', { name: 'Rules and findings' });
  await rules
    .getByRole('navigation', { name: 'Rules views' })
    .getByRole('button', { name: 'Open findings', exact: true })
    .click();
  const list = page.getByTestId('open-findings');
  await expect(list.getByRole('heading', { name: 'Open findings', exact: true })).toBeVisible();
  await expect(list.getByTestId('open-findings-attention')).toContainText('no owner');

  // Counted findings first; the proposed ones are on their own tab and labelled as never counted.
  const tabs = list.getByRole('navigation', { name: 'Which findings' });
  await tabs.getByRole('button', { name: /^Proposed, not counted · \d+$/ }).click();
  await expect(list.getByTestId('proposed-note')).toContainText('never counted');
  await tabs.getByRole('button', { name: /^Counted · \d+$/ }).click();
  // The list opens grouped by rule; every finding, oldest first, is one choice away.
  await list
    .getByRole('navigation', { name: 'How findings are shown' })
    .getByRole('button', { name: 'Every finding, oldest first', exact: true })
    .click();
  await list.getByLabel('Subject', { exact: true }).selectOption({ label: 'Flights' });
  await list.getByLabel('Owner', { exact: true }).selectOption({ label: 'Nobody yet' });
  const row = list.getByRole('button', { name: new RegExp(`^Open the finding about ${label}`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('No owner');
  await row.click();

  const detail = page.getByTestId('open-finding-detail');
  const card = detail.getByTestId('subject-finding').first();
  await expect(card.getByTestId('finding-owner')).toHaveText('Nobody owns this finding');
  const work = card.getByTestId('finding-work');
  await work.getByRole('button', { name: 'Take responsibility', exact: true }).click();
  let form = work.getByTestId('finding-work-form');
  await form.getByLabel('What you will check', { exact: true }).fill('I will get the landing report from the crew.');
  await form.getByRole('button', { name: 'Take responsibility', exact: true }).click();
  await expect(card.getByTestId('finding-owner')).toHaveText('Dana Ortiz owns this finding');

  await work.getByRole('button', { name: 'Record an action', exact: true }).click();
  form = work.getByTestId('finding-work-form');
  await form.getByLabel(/^Due on/).fill('2030-01-15');
  await form.getByLabel('The action', { exact: true }).fill('Ask the crew for the landing report.');
  await form.getByRole('button', { name: 'Record an action', exact: true }).click();
  await expect(card.getByTestId('finding-action')).toHaveText(
    'Action: Ask the crew for the landing report. · due 2030-01-15',
  );

  await work.getByRole('button', { name: 'Record what was done', exact: true }).click();
  form = work.getByTestId('finding-work-form');
  await form.getByLabel('What was done', { exact: true }).fill('Asked the crew; no report exists for this flight.');
  await form.getByRole('button', { name: 'Record what was done', exact: true }).click();
  await expect(card.getByTestId('finding-action')).toContainText(' · done');

  await work.getByRole('button', { name: 'Close the finding', exact: true }).click();
  form = work.getByTestId('finding-work-form');
  await expect(form.getByRole('button', { name: 'Close the finding', exact: true })).toBeDisabled();
  await form.getByLabel('Accepted, with the reason stated', { exact: true }).check();
  await form.getByLabel('Why it is closed', { exact: true }).fill('The flight was cancelled on the pad; no landing.');
  await form.getByRole('button', { name: 'Close the finding', exact: true }).click();
  await expect(card.getByTestId('finding-closure')).toHaveText(
    'Closed by Dana Ortiz: Accepted, with the reason stated. The flight was cancelled on the pad; no landing.',
  );
  await expect(work.getByRole('button', { name: 'Close the finding', exact: true })).toHaveCount(0);

  await detail.getByRole('button', { name: 'Back to open findings', exact: true }).click();
  await expect(list.getByRole('button', { name: new RegExp(`^Open the finding about ${label}`) })).toHaveCount(0);
  const recorded = (await timeline(request, flight.id)).findings![0]!;
  expect(recorded.status).toBe('resolved');
  expect(recorded.treatments.map((item) => item.action)).toEqual(['acknowledge', 'plan', 'respond', 'close']);
});

test('a dispatcher reads the open findings by rule and takes and closes every finding of one rule as one decision', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const seeded = await request.get(`${api}/v1/me`, { headers: authorization });
  test.skip(!seeded.ok(), 'Needs the seeded fictional organizations: Alpha Dispatch adopts the landing rule');
  // Two flights whose landing is overdue: the adopted landing rule opens a finding about each that nobody owns.
  const flights: string[] = [];
  for (const index of [1, 2]) {
    const created = await request.post(`${api}/v1/flights`, {
      headers: { ...authorization, 'idempotency-key': randomUUID() },
      data: {
        originationKey: `browser-finding-set:${randomUUID()}`,
        label: `Finding set ${index} ${randomUUID().slice(0, 6)}`,
        aircraft: 'Browser finding aircraft',
        scheduledStart: new Date(Date.now() - 40 * 60_000).toISOString(),
        scheduledEnd: new Date(Date.now() - 20 * 60_000).toISOString(),
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    flights.push(((await created.json()) as FlightResponse).flight.id);
  }
  for (const flightId of flights)
    await expect
      .poll(async () => (await timeline(request, flightId)).findings?.length ?? 0, { timeout: 60_000 })
      .toBe(1);
  const opened = await request.get(`${api}/v1/organization/open-findings?subjectKind=flight&owner=none&limit=200`, {
    headers: authorization,
  });
  expect(opened.ok(), await opened.text()).toBeTruthy();
  const ours = ((await opened.json()) as OpenFindingsResponse).findings.find((item) => item.subject.id === flights[0])!;
  expect(ours).toBeDefined();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: ((await seeded.json()) as CurrentPrincipalResponse).organization?.timeZone ?? 'UTC',
  }).format(new Date());

  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  const rules = page.getByRole('main', { name: 'Rules and findings' });
  await rules
    .getByRole('navigation', { name: 'Rules views' })
    .getByRole('button', { name: 'Open findings', exact: true })
    .click();
  const list = page.getByTestId('open-findings');
  await expect(
    list
      .getByRole('navigation', { name: 'How findings are shown' })
      .getByRole('button', { name: 'By rule', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(list.getByLabel('Rules', { exact: true })).toHaveValue('fewest');
  await expect(list.getByTestId('open-finding-groups-total')).toHaveText(/^\d+ open findings? under \d+ rules?\.$/);
  await list.getByLabel('Subject', { exact: true }).selectOption({ label: 'Flights' });
  // Narrowed to findings about today, so the decision covers only flights of this day.
  await list.getByLabel(/^About from/).fill(today);
  await list.getByLabel('About until', { exact: true }).fill(today);
  const group = list.getByRole('button', {
    name: `Open the findings of ${ours.ruleTitle} (${ours.packTitle})`,
    exact: true,
  });
  await expect(group).toBeVisible();
  await group.click();

  const one = list.getByTestId('open-finding-rule');
  await expect(one.getByRole('heading', { name: ours.ruleTitle, exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: new RegExp(`^Open the finding about `) }).first()).toBeVisible();
  const set = one.getByTestId('finding-set');
  await set.getByRole('button', { name: 'Take responsibility for all of them', exact: true }).click();
  let form = set.getByTestId('finding-set-form');
  const heading = form.getByRole('heading', { name: /^Take responsibility for all \d+$/ });
  await expect(heading).toBeVisible();
  const count = Number((await heading.textContent())!.replace(/\D+/g, ''));
  expect(count).toBeGreaterThanOrEqual(2);
  await expect(form.getByTestId('finding-set-scope')).toContainText(
    `One decision about ${count} counted open findings`,
  );
  await form.getByLabel('What you will check', { exact: true }).fill('I will get the landing reports from the crews.');
  await form.getByRole('button', { name: `Take responsibility for all ${count}`, exact: true }).click();
  await expect(set.getByRole('status')).toHaveText(
    `Take responsibility for all ${count}: recorded with your name as one decision.`,
  );

  await set.getByRole('button', { name: 'Close all of them', exact: true }).click();
  form = set.getByTestId('finding-set-form');
  const close = form.getByRole('button', { name: `Close all ${count}`, exact: true });
  await expect(close).toBeDisabled();
  await form.getByLabel('Accepted, with the reason stated', { exact: true }).check();
  await form.getByLabel('Why they are closed', { exact: true }).fill('These flights were cancelled on the pad.');
  await close.click();
  await expect(set.getByRole('status')).toHaveText(`Close all ${count}: recorded with your name as one decision.`);

  for (const flightId of flights) {
    const recorded = (await timeline(request, flightId)).findings![0]!;
    expect(recorded.status).toBe('resolved');
    expect(recorded.treatments.map((item) => item.action)).toEqual(['acknowledge', 'close']);
    expect(recorded.treatments[1]!.decision?.findingCount).toBe(count);
  }
  await one.getByRole('button', { name: 'Back to every rule', exact: true }).click();
  await expect(list.getByTestId('open-finding-groups-total')).toBeVisible();
});

/**
 * The home of an organization with no order source, from `pnpm org:create` alone. Run it against a stack with a
 * database of its own, after creating the organization on a local database without a sign-in issuer, which gives its
 * administrator a development token:
 *
 *   pnpm org:create --name "Example Ridge Survey" --time-zone America/Denver --admin "Avery Example"
 *   LEDGER_BROWSER_NEW_ORGANIZATION_TOKEN=<the printed ledger-dev- token> pnpm test:browser open-findings
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

test('an organization without an order source has its flights on record under Flights, each opening its file', async ({
  page,
}) => {
  test.skip(!newOrganizationToken, 'Set LEDGER_BROWSER_NEW_ORGANIZATION_TOKEN to a token pnpm org:create printed');
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 6).toUpperCase();
  await page.goto('/');
  // A database with none of the fictional organizations leads with the token field; one with them keeps it behind a
  // disclosure. Wait for the screen to settle on one, then open the disclosure if it is there.
  const field = page.getByLabel('Development token', { exact: true });
  const disclosure = page.getByText('Use a development token', { exact: true });
  await expect(field.or(disclosure).first()).toBeVisible();
  if (await disclosure.count()) await disclosure.click();
  await field.fill(newOrganizationToken!);
  await page.getByRole('button', { name: 'Open with this token', exact: true }).click();
  // Until it adopts a rule pack, the organization opens on its first-day list; Flights opens its flights on record.
  await expect(page).toHaveURL(/\/(setup|flights)$/);
  if (page.url().endsWith('/setup')) await page.getByRole('link', { name: 'Flights', exact: true }).click();

  const home = page.getByTestId('records-home');
  await expect(home.getByRole('heading', { name: 'Flights on record', exact: true })).toBeVisible();
  await expect(home.getByRole('region', { name: 'Needs attention' })).toBeVisible();
  // The order board stays mounted, hidden, behind the home; nothing of it is on screen.
  await expect(page.getByText(/Unlinked evidence/).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(/flights on this page/).filter({ visible: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Records', exact: true }).click();
  const area = page.getByRole('main', { name: 'Operator records' });
  await importFile(area, 'Flight plan', 'flight.plan.csv', run, 3);
  await importFile(area, 'Role assignment', 'operation.role-assignment.csv', run, 3);
  await page.getByRole('link', { name: 'Flights', exact: true }).click();

  // The fixture plans two flights in November 2026 and one on 2026-12-01, upcoming until that day passes. The
  // November ones are recent, the later window first.
  const ours = (list: Locator) => list.getByTestId('flight-on-record').filter({ hasText: `${run}-RIDGE-FLT-` });
  const upcoming = ours(home.getByTestId('flights-upcoming'));
  const recent = home.getByTestId('flights-recent');
  const flights = ours(recent).filter({ hasNotText: `${run}-RIDGE-FLT-3` });
  await expect(ours(home)).toHaveCount(3);
  if (Date.now() < Date.parse('2026-12-01T16:00:00Z')) await expect(upcoming).toContainText(`${run}-RIDGE-FLT-3`);
  await expect(flights).toHaveCount(2);
  await expect(flights.first()).toContainText(`${run}-RIDGE-FLT-2`);
  await expect(flights.nth(1)).toContainText(`${run}-RIDGE-FLT-1`);
  await expect(flights.nth(1)).toContainText(`Pilot in command: ${run}-RIDGE-P-01`);
  await expect(flights.nth(1)).toContainText(`Aircraft: ${run}-RIDGE-AC-1`);

  await recent.getByRole('button', { name: `Open the file of flight ${run}-RIDGE-FLT-1`, exact: true }).click();
  const file = page.getByTestId('subject-file');
  await expect(file).toBeVisible();
  await expect(file).toContainText(`flight · your id ${run}-RIDGE-FLT-1`);
});
