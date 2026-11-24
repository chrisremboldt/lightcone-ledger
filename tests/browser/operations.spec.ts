import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Request as BrowserRequest,
  type Route,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type {
  CommandResponse,
  FlightListResponse,
  FlightResponse,
  Input,
  OrderListResponse,
  ReceiptResponse,
  SmsFindingPromotionResponse,
  TimelineResponse,
} from '@ledger/contracts';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const alpha = 'ledger-dev-alpha-operator';
const beta = 'ledger-dev-beta-operator';
const source = 'ledger-dev-alpha-source';
const authorization = (token = alpha) => ({ authorization: `Bearer ${token}` });
const writeHeaders = (token = alpha) => ({ ...authorization(token), 'idempotency-key': randomUUID() });

async function createFlight(
  request: APIRequestContext,
  name: string,
  token = alpha,
  schedule?: { scheduledStart: string; scheduledEnd: string },
) {
  const response = await request.post(`${api}/v1/flights`, {
    headers: writeHeaders(token),
    data: {
      originationKey: `browser:${randomUUID()}`,
      label: `${name} ${randomUUID().slice(0, 6)}`,
      aircraft: 'Browser test aircraft',
      scheduledStart: new Date(Date.now() - 60 * 60_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 60 * 60_000).toISOString(),
      ...schedule,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as FlightResponse).flight;
}

async function input(request: APIRequestContext, body: Input) {
  const options = { headers: writeHeaders(source), data: body };
  let response = await request.post(`${api}/v1/inputs`, options);
  for (const delayMs of [100, 250]) {
    if (response.status() !== 409 || (await response.json()).error?.code !== 'concurrent_change') break;
    await setTimeout(delayMs);
    response = await request.post(`${api}/v1/inputs`, options);
  }
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as ReceiptResponse).receipt;
}

async function timeline(request: APIRequestContext, flightId: string, token = alpha) {
  const response = await request.get(`${api}/v1/flights/${flightId}/timeline`, { headers: authorization(token) });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as TimelineResponse;
}

async function completed(request: APIRequestContext, receiptId: string) {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${api}/v1/receipts/${receiptId}`, { headers: authorization() });
        return ((await response.json()) as ReceiptResponse).receipt.processing.status;
      },
      { message: 'Worker must finish this accepted public-API receipt', timeout: 15000 },
    )
    .toBe('completed');
}

async function login(page: Page, operator = 'Alpha Dispatch') {
  await page.goto('/');
  await chooseOperator(page, operator);
}

async function chooseOperator(page: Page, operator: string) {
  await page.getByRole('radio', { name: operator, exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
}

async function selectFlight(page: Page, flightId: string) {
  const row = page.getByTestId(`flight-row-${flightId}`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('timeline-scroll')).toBeVisible();
}

test('late insertion preserves the selected record, focus, and timeline anchor', async ({
  page,
  request,
}, testInfo) => {
  const flight = await createFlight(request, 'Late arrival review');
  const started = Date.now() - 3 * 60 * 60_000;
  const receipts = [];
  for (let index = 0; index < 12; index++)
    receipts.push(
      await input(request, {
        sourceId: `browser-anchor-${flight.id}`,
        kind: 'flight.observation',
        occurredAt: new Date(started + index * 60_000).toISOString(),
        subject: { flightId: flight.id },
        payload: { title: `Recorded observation ${index + 1}`, activity: 'active' },
      }),
    );
  await completed(request, receipts.at(-1)!.id);
  await login(page);
  await selectFlight(page, flight.id);
  const inspected = receipts[8]!;
  const item = page.getByTestId(`timeline-item-${inspected.eventId}`);
  await item.click();
  await expect(item).toBeFocused();
  const before = await item.boundingBox();
  expect(before).not.toBeNull();
  const late = await input(request, {
    sourceId: `browser-anchor-${flight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date(started - 60_000).toISOString(),
    subject: { flightId: flight.id },
    payload: { title: 'Earlier occurrence received later', activity: 'active' },
  });
  await completed(request, late.id);
  await expect(page.getByTestId('late-arrivals')).toBeVisible();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  await expect(item).toBeFocused();
  const after = await item.boundingBox();
  expect(Math.abs(after!.y - before!.y), 'Selected row keeps its viewport time anchor').toBeLessThanOrEqual(2);
  await expect(page.getByTestId('receipt-inspector')).toContainText(`Recorded observation 9`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('late-arrival-desktop.png') });
  await page.getByRole('button', { name: 'Review arrivals' }).click();
  await expect(page.getByTestId(`timeline-item-${late.eventId}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('late-arrivals')).toHaveCount(0);
});

test('switching operators isolates the flight monitor and direct API access', async ({ page, request }) => {
  const alphaFlight = await createFlight(request, 'Alpha isolation');
  const betaFlight = await createFlight(request, 'Beta isolation', beta);
  await login(page);
  await selectFlight(page, alphaFlight.id);
  await expect(page.getByTestId(`flight-row-${betaFlight.id}`)).toHaveCount(0);
  const forbidden = await request.get(`${api}/v1/flights/${alphaFlight.id}`, { headers: authorization(beta) });
  expect(forbidden.status()).toBe(404);
  await page.getByRole('button', { name: 'Switch operator' }).click();
  await chooseOperator(page, 'Beta Inspection');
  await selectFlight(page, betaFlight.id);
  await expect(page.getByTestId(`flight-row-${alphaFlight.id}`)).toHaveCount(0);
  await expect(page.getByText('Beta Inspection', { exact: true })).toBeVisible();
});

test('a stale decision conflicts, retains the draft, and records only after basis review', async ({
  page,
  request,
}, testInfo) => {
  const flight = await createFlight(request, 'Decision basis review');
  const original = await input(request, {
    sourceId: `browser-decision-${flight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date().toISOString(),
    subject: { flightId: flight.id },
    payload: { title: 'Activity basis', activity: 'active' },
  });
  await completed(request, original.id);
  await login(page);
  await selectFlight(page, flight.id);
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  const form = page.getByTestId('decision-form');
  const note = 'Hold until the newly received discrepancy has been reviewed.';
  await form.getByLabel('Decision rationale').fill(note);
  const changed = await input(request, {
    sourceId: `browser-decision-${flight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    subject: { flightId: flight.id },
    payload: { title: 'Late conflicting observation', activity: 'active', landingTime: '2026-10-01T15:00:00.000Z' },
  });
  await completed(request, changed.id);
  await expect(form).toContainText('record changed');
  const response = page.waitForResponse(
    (reply) => reply.url().endsWith('/v1/commands') && reply.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Record decision', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByText('The viewed basis has changed', { exact: true })).toBeVisible();
  await expect(form.getByLabel('Decision rationale')).toHaveValue(note);
  expect((await timeline(request, flight.id)).decisions).toHaveLength(0);
  await form.getByRole('button', { name: 'Refresh basis' }).click();
  await expect(form).not.toContainText('record changed');
  await form.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(page.getByText('Decision recorded with its input basis.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await timeline(request, flight.id)).decisions.length).toBe(1);
  const recorded = (await timeline(request, flight.id)).decisions[0]!;
  await expect(page.getByTestId(`timeline-item-${recorded.id}`)).toHaveCount(1);
  await expect(page.getByTestId('decision-basis')).not.toContainText('Later evidence is present');
  const retainedBasis = structuredClone(recorded.renderedInputCut);
  const later = await input(request, {
    sourceId: `browser-decision-${flight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date().toISOString(),
    subject: { flightId: flight.id },
    payload: { title: 'Evidence after the accepted decision', activity: 'landed' },
  });
  await completed(request, later.id);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find flight' }).fill(flight.id);
  await selectFlight(page, flight.id);
  await expect(page.getByTestId('decision-basis')).toContainText('Later evidence is present');
  await expect(page.getByTestId(`timeline-item-${later.eventId}`)).toHaveCount(1);
  expect((await timeline(request, flight.id)).decisions[0]!.renderedInputCut).toEqual(retainedBasis);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('pinned-decision-desktop.png') });
});

test('operational polling keeps completed records in searchable history without refreshing source capabilities', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const historySearch = `History roster ${randomUUID()}`;
  const activeFlight = await createFlight(request, 'Live roster regression');
  await createFlight(request, 'Upcoming route review', alpha, {
    scheduledStart: new Date(Date.now() + 15 * 60_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 45 * 60_000).toISOString(),
  });
  const upcomingSourceId = `browser-overview-orders-${activeFlight.id}`;
  for (let index = 0; index < 3; index++) {
    const externalId = `overview-order-${randomUUID()}`;
    const order = await input(request, {
      sourceId: upcomingSourceId,
      kind: 'order.revision',
      sourceRevision: 1,
      occurredAt: new Date().toISOString(),
      subject: { orderId: externalId },
      payload: {
        externalId,
        label: `Upcoming clinic supplies ${index + 1}`,
        revision: 1,
        status: 'accepted',
        scheduledStart: new Date(Date.now() + 15 * 60_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
        fulfillments: [],
      },
    });
    await completed(request, order.id);
  }
  const upcomingRead = await request.get(
    `${api}/v1/orders?view=awaiting-current&sourceId=${encodeURIComponent(upcomingSourceId)}`,
    { headers: authorization() },
  );
  expect(upcomingRead.ok(), await upcomingRead.text()).toBe(true);
  const upcomingOrderIds = ((await upcomingRead.json()) as OrderListResponse).orders.map((order) => order.id);
  expect(upcomingOrderIds).toHaveLength(3);
  const overdueFlight = await createFlight(request, 'Elapsed requested plan', alpha, {
    scheduledStart: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    scheduledEnd: new Date(Date.now() - 60 * 60_000).toISOString(),
  });
  const olderFlight = await createFlight(request, `${historySearch} older`);
  const landedFlight = await createFlight(request, `${historySearch} newer`);
  const historicalIssue = await createFlight(request, 'Conflicting completed reports');
  const active = await input(request, {
    sourceId: `browser-roster-${activeFlight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date().toISOString(),
    subject: { flightId: activeFlight.id },
    payload: { title: 'Active flight remains in the operation', activity: 'active' },
  });
  const landed = await input(request, {
    sourceId: `browser-roster-${landedFlight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date().toISOString(),
    subject: { flightId: landedFlight.id },
    payload: { title: 'Completed flight evidence remains available', activity: 'landed' },
  });
  const olderLanding = await input(request, {
    sourceId: `browser-roster-${olderFlight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date().toISOString(),
    subject: { flightId: olderFlight.id },
    payload: { title: 'Earlier flight completed after its newer peer', activity: 'landed' },
  });
  await Promise.all([
    completed(request, active.id),
    completed(request, landed.id),
    completed(request, olderLanding.id),
  ]);
  for (const [index, minutesAgo] of [3, 0].entries()) {
    const report = await input(request, {
      sourceId: `browser-roster-${historicalIssue.id}-${index}`,
      kind: 'flight.observation',
      occurredAt: new Date().toISOString(),
      subject: { flightId: historicalIssue.id },
      payload: {
        title: `Landing report ${index + 1}`,
        activity: 'landed',
        landingTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      },
    });
    await completed(request, report.id);
  }
  let historicalBasis: TimelineResponse | undefined;
  await expect
    .poll(async () => {
      historicalBasis = await timeline(request, historicalIssue.id);
      return { findings: historicalBasis.findings?.length ?? 0, outstanding: historicalBasis.flight.outstandingWork };
    })
    .toEqual({ findings: 1, outstanding: 0 });
  const finding = historicalBasis!.findings![0]!;
  const hazardTitle = `Completed-flight landing review ${randomUUID()}`;
  // The finding becomes a hazard on the safety record, which keeps the finding and its evaluation as its origin.
  const promotion = await request.get(`${api}/v1/sms/findings/${finding.id}/promotion`, { headers: authorization() });
  expect(promotion.status(), await promotion.text()).toBe(200);
  const shownPromotion = (await promotion.json()) as SmsFindingPromotionResponse;
  const operatorId = (
    (await (await request.get(`${api}/v1/me`, { headers: authorization() })).json()) as {
      principal: { id: string };
    }
  ).principal.id;
  const opening = {
    kind: 'sms.record.open',
    record: {
      kind: 'hazard',
      schema: 'sms.hazard.1',
      title: hazardTitle,
      ownerId: operatorId,
      body: {
        description: 'Retain the disagreement while inspecting its flight from the operational categories.',
        consequence: 'Landing records that disagree could hide where the aircraft actually landed.',
        source: { kind: 'finding' },
      },
    },
    origin: {
      kind: 'finding',
      findingId: finding.id,
      evaluationId: shownPromotion.origin.evaluationId,
      expectedDependencyBasis: shownPromotion.basis.dependencyBasis,
    },
  };
  const opened = await request.post(`${api}/v1/commands`, { headers: writeHeaders(), data: opening });
  expect(opened.status(), await opened.text()).toBe(201);
  const hazardId = ((await opened.json()) as CommandResponse).command.subject!.id;

  async function captureScope(name: string, category: string) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`${name}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: category, exact: true }).click();
    const heading = page.getByTestId('operation-overview').getByRole('heading', { level: 2 });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${name}-390.png`) });
    await page.getByTestId('operation-overview').getByRole('button', { name: 'Choose a flight', exact: true }).click();
    const first = page.locator('.flight-row').first();
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  const flightRequests: URL[] = [];
  const sourceRequests: URL[] = [];
  const retainedReads: string[] = [];
  const pendingRetainedReads = new Set<BrowserRequest>();
  page.on('request', (sent) => {
    if (sent.method() !== 'GET') return;
    const url = new URL(sent.url());
    if (url.pathname === '/v1/flights') flightRequests.push(url);
    if (url.pathname === '/v1/sources') sourceRequests.push(url);
    if ([`/v1/flights/${olderFlight.id}/timeline`, `/v1/flights/${olderFlight.id}/mission`].includes(url.pathname)) {
      retainedReads.push(url.pathname);
      pendingRetainedReads.add(sent);
    }
  });
  page.on('requestfinished', (sent) => pendingRetainedReads.delete(sent));
  page.on('requestfailed', (sent) => pendingRetainedReads.delete(sent));
  const monitorPolls = () =>
    flightRequests.filter(
      (url) =>
        url.searchParams.get('view') === 'monitor' &&
        !url.searchParams.has('cursor') &&
        !url.searchParams.get('search'),
    ).length;
  const freshHistory = async (after = Date.now()) => {
    const response = await page.waitForResponse((reply) => {
      const url = new URL(reply.url());
      return (
        reply.request().method() === 'GET' &&
        reply.request().timing().startTime >= after &&
        url.pathname === '/v1/flights' &&
        url.searchParams.get('view') === 'history' &&
        url.searchParams.get('search') === historySearch &&
        !url.searchParams.has('cursor')
      );
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as FlightListResponse;
  };
  const historyRows = () =>
    page
      .getByRole('complementary', { name: 'Flight monitor' })
      .locator('[data-testid^="flight-row-"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
  const overview = page.getByTestId('operation-overview');
  async function expectOverview(title: string) {
    await expect(overview).toBeVisible();
    await expect(overview.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('[data-testid^="flight-row-"][aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByTestId('fleet-map').locator('.fleet-flight[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByTestId('timeline-scroll')).toBeHidden();
    await expect(page.getByTestId('decision-form')).toBeHidden();
    await expect(page.getByText('Selected flight retained outside this view', { exact: true })).toHaveCount(0);
  }
  // Hazards opens the one register in the safety section; the hazard opens on its safety record page.
  const safety = page.getByTestId('sms-record');
  const register = page.locator('[aria-label="Recorded hazards"]');
  async function openRegisteredHazard() {
    await views.getByRole('button', { name: 'Hazards', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Hazard register', exact: true })).toBeVisible();
    const rows = register.locator('[data-testid^="sms-row-"]');
    for (let index = 0; index < 20; index++) {
      await expect(rows.first()).toBeVisible();
      const row = register.getByTestId(`sms-row-${hazardId}`);
      if (await row.isVisible()) {
        await row.click();
        await expect(safety).toContainText(hazardTitle);
        return;
      }
      const shown = await rows.count();
      const more = page.getByRole('button', { name: 'More hazards', exact: true });
      await expect(more).toBeVisible();
      await more.click();
      await expect.poll(() => rows.count()).toBeGreaterThan(shown);
    }
    throw new Error('The opened hazard was not found within 20 register pages');
  }
  // The origin section leads back to the flight the hazard came from.
  const originFlight = () =>
    safety
      .getByTestId('hazard-origin')
      .getByRole('button', { name: /^(Return to .+|Open the finding on its flight)$/ });

  await login(page);
  const views = page.locator('[aria-label="Flight views"]');
  await expect(views.getByRole('button', { name: 'Operation', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const scopes = page.getByRole('group', { name: 'Operation scope' });
  const historicalAttention = scopes.getByRole('button', { name: 'Historical issues', exact: true });
  const flightSearch = page.getByRole('searchbox', { name: 'Find flight' });
  await expect(scopes.getByRole('button', { name: 'Current', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectOverview('Current operation');
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await expect(historicalAttention).toHaveAttribute('aria-describedby', /\S+/);
  const emptySearch = `No matching current flight ${randomUUID()}`;
  const emptyCurrentRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.ok() &&
      url.pathname === '/v1/flights' &&
      url.searchParams.get('view') === 'monitor' &&
      url.searchParams.get('search') === emptySearch
    );
  });
  await flightSearch.fill(emptySearch);
  expect(((await (await emptyCurrentRead).json()) as FlightListResponse).flights).toEqual([]);
  await expect(page.getByRole('complementary', { name: 'Flight monitor' }).locator('.flight-row')).toHaveCount(0);
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await flightSearch.fill('');
  await selectFlight(page, activeFlight.id);
  await expect(page.getByTestId(`flight-row-${landedFlight.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`flight-row-${overdueFlight.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`flight-row-${historicalIssue.id}`)).toHaveCount(0);
  await expect.poll(() => sourceRequests.length).toBe(1);
  await expect(page.getByTestId(`timeline-item-${active.eventId}`)).toBeVisible();
  await scopes.getByRole('button', { name: 'Current', exact: true }).click();
  await expectOverview('Current operation');
  const currentPolls = monitorPolls();
  await expect.poll(monitorPolls).toBeGreaterThan(currentPolls);
  await expectOverview('Current operation');
  for (const id of upcomingOrderIds) await expect(page.getByTestId(`awaiting-order-${id}`)).toBeVisible();
  await captureScope('current-operation-overview', 'Current');

  await views.getByRole('button', { name: 'History', exact: true }).click();
  await expectOverview('Flight history');
  await expect(historicalAttention).toBeVisible();
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await flightSearch.fill(`  ${historySearch}  `);
  const history = await freshHistory();
  expect(history.flights.map((flight) => flight.id)).toEqual([landedFlight.id, olderFlight.id]);
  const initialOrder = [landedFlight.id, olderFlight.id].map((id) => `flight-row-${id}`);
  await expect.poll(historyRows).toEqual(initialOrder);
  await captureScope('history-overview', 'History');
  await expect(page.getByText('Newest by creation time', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      flightRequests.some(
        (url) => url.searchParams.get('view') === 'history' && url.searchParams.get('search') === historySearch,
      ),
    )
    .toBe(true);
  await selectFlight(page, landedFlight.id);
  await expect(page.getByTestId(`timeline-item-${landed.eventId}`)).toBeVisible();
  await expect(page.getByTestId(`flight-row-${activeFlight.id}`)).toHaveCount(0);
  await selectFlight(page, olderFlight.id);
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  const draft = page.getByTestId('decision-form');
  const note = 'Keep this earlier flight selected while history receives later evidence and newly created flights.';
  await draft.getByLabel('Judgment').selectOption('hold');
  await draft.getByLabel('Decision rationale').fill(note);
  const late = await input(request, {
    sourceId: `browser-roster-${olderFlight.id}`,
    kind: 'source.observation',
    occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    subject: { flightId: olderFlight.id },
    payload: { title: 'Earlier evidence received after the newer flight record' },
  });
  await completed(request, late.id);
  expect((await freshHistory()).flights.map((flight) => flight.id)).toEqual([landedFlight.id, olderFlight.id]);
  await expect.poll(historyRows).toEqual(initialOrder);
  await expect(page.getByTestId(`timeline-item-${late.eventId}`)).toBeVisible();
  await expect(page.getByTestId(`flight-row-${olderFlight.id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);

  const newestFlight = await createFlight(request, `${historySearch} newest`);
  const newestLanding = await input(request, {
    sourceId: `browser-roster-${newestFlight.id}`,
    kind: 'flight.observation',
    occurredAt: new Date().toISOString(),
    subject: { flightId: newestFlight.id },
    payload: { title: 'Newly created flight enters completed history', activity: 'landed' },
  });
  await completed(request, newestLanding.id);
  const refreshedOrder = [newestFlight.id, landedFlight.id, olderFlight.id];
  expect((await freshHistory()).flights.map((flight) => flight.id)).toEqual(refreshedOrder);
  await expect.poll(historyRows).toEqual(refreshedOrder.map((id) => `flight-row-${id}`));
  await expect(page.getByTestId(`flight-row-${olderFlight.id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
  const selectedRecordId = await page
    .getByTestId('timeline-scroll')
    .locator('[data-testid^="timeline-item-"][aria-pressed="true"]')
    .getAttribute('data-testid');
  expect(selectedRecordId).not.toBeNull();
  const historyRoute = (url: URL) =>
    url.pathname === '/v1/flights' &&
    url.searchParams.get('view') === 'history' &&
    url.searchParams.get('search') === historySearch;
  let limitedCursor: string | null | undefined;
  let rejectedContinuation = false;
  const recoverHistory = async (route: Route) => {
    const url = new URL(route.request().url());
    if (limitedCursor === undefined && !url.searchParams.has('cursor')) {
      url.searchParams.set('limit', '1');
      const response = await route.fetch({ url: url.href });
      expect(response.status(), await response.text()).toBe(200);
      const limitedPage = (await response.json()) as FlightListResponse;
      expect(limitedPage.flights.map((flight) => flight.id)).toEqual([newestFlight.id]);
      expect(limitedPage.nextCursor).not.toBeNull();
      limitedCursor = limitedPage.nextCursor;
      await route.fulfill({ response });
      return;
    }
    if (!rejectedContinuation && url.searchParams.get('cursor') === limitedCursor) {
      rejectedContinuation = true;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'cursor_scope_mismatch', message: 'History read scope changed.' } }),
      });
      return;
    }
    await route.continue();
  };
  await page.route(historyRoute, recoverHistory);
  try {
    expect((await freshHistory()).flights.map((flight) => flight.id)).toEqual([newestFlight.id]);
    await expect.poll(historyRows).toEqual([`flight-row-${newestFlight.id}`]);
    const recovered = freshHistory();
    await page.getByRole('button', { name: 'More history', exact: true }).click();
    expect((await recovered).flights.map((flight) => flight.id)).toEqual(refreshedOrder);
    expect(rejectedContinuation).toBe(true);
    await expect.poll(historyRows).toEqual(refreshedOrder.map((id) => `flight-row-${id}`));
    await expect(page.getByText('History refreshed to newest records.', { exact: true })).toBeVisible();
    await expect(page.getByTestId(`flight-row-${olderFlight.id}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId(selectedRecordId!)).toHaveAttribute('aria-pressed', 'true');
    await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
    await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
  } finally {
    await page.unroute(historyRoute, recoverHistory);
  }
  await freshHistory();
  await expect(page.getByText('History refreshed to newest records.', { exact: true })).toBeVisible();
  await flightSearch.fill(`${historySearch} newest`);
  await expect.poll(historyRows).toEqual([`flight-row-${newestFlight.id}`]);
  await expect(page.getByTestId(`flight-row-${olderFlight.id}`)).toHaveCount(0);
  const fleet = page.getByTestId('fleet-map');
  await expect(fleet.locator('.fleet-flight')).toHaveCount(1);
  await expect(fleet.locator('.fleet-flight[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByText('Selected flight retained outside this view', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId(selectedRecordId!)).toHaveAttribute('aria-pressed', 'true');
  await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
  await flightSearch.fill(olderFlight.id);
  await expect.poll(historyRows).toEqual([`flight-row-${olderFlight.id}`]);
  await expect(page.getByText('History refreshed to newest records.', { exact: true })).toHaveCount(0);
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
  expect(sourceRequests).toHaveLength(1);
  await views.getByRole('button', { name: 'Operation', exact: true }).click();
  await expectOverview('Current operation');
  await flightSearch.fill(overdueFlight.id);
  await scopes.getByRole('button', { name: 'Overdue', exact: true }).click();
  await expectOverview('Overdue work');
  const overdueRow = page.getByTestId(`flight-row-${overdueFlight.id}`);
  await expect(overdueRow).toContainText('Plan window elapsed');
  await expect(overdueRow).toContainText('Requested window:');
  await expect(overdueRow).not.toContainText('Cancelled');
  await captureScope('overdue-overview', 'Overdue');
  await flightSearch.fill(historicalIssue.id);
  const historicalRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.ok() &&
      url.pathname === '/v1/flights' &&
      url.searchParams.get('view') === 'historical-issues' &&
      url.searchParams.get('search') === historicalIssue.id
    );
  });
  await historicalAttention.click();
  await historicalRead;
  await expectOverview('Historical issues');
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await expect(page.getByTestId(`flight-row-${historicalIssue.id}`)).toContainText('Landing time disagreement');
  await captureScope('historical-issues-overview', 'Historical issues');
  await scopes.getByRole('button', { name: 'Current', exact: true }).click();
  await expectOverview('Current operation');
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await views.getByRole('button', { name: 'Hazards', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hazard register', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to flights', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Return to ${olderFlight.label}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to flights', exact: true }).click();
  await expectOverview('Current operation');

  await openRegisteredHazard();
  const originTimelineRoute = `**/v1/flights/${historicalIssue.id}/timeline*`;
  let releaseOrigin!: () => void;
  const originGate = new Promise<void>((resolve) => {
    releaseOrigin = resolve;
  });
  let originReadReady = false;
  let holdOrigin = true;
  const pendingOriginReads: Promise<void>[] = [];
  const heldOrigin = (route: Route) => {
    if (!holdOrigin) return route.continue();
    const delivered = (async () => {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      originReadReady = true;
      await originGate;
      await route.fulfill({ response });
    })();
    pendingOriginReads.push(delivered);
    return delivered;
  };
  await page.route(originTimelineRoute, heldOrigin);
  try {
    await originFlight().click();
    await expect.poll(() => originReadReady).toBe(true);
    await views.getByRole('button', { name: 'History', exact: true }).click();
    await expectOverview('Flight history');
    holdOrigin = false;
    releaseOrigin();
    await Promise.all(pendingOriginReads);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expectOverview('Flight history');
    await expect(safety).toBeHidden();
  } finally {
    holdOrigin = false;
    releaseOrigin();
    await Promise.allSettled(pendingOriginReads);
    await page.unroute(originTimelineRoute, heldOrigin);
  }
  await expectOverview('Flight history');
  await flightSearch.fill(olderFlight.id);
  await selectFlight(page, olderFlight.id);
  await expect(page.getByTestId(selectedRecordId!)).toHaveAttribute('aria-pressed', 'true');
  await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);

  await openRegisteredHazard();
  const failedOrigin = async (route: Route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'origin_read_failed', message: 'Origin flight read failed.' } }),
    });
  };
  await page.route(originTimelineRoute, failedOrigin);
  try {
    const failed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/flights/${historicalIssue.id}/timeline` && response.status() === 500,
    );
    await originFlight().click();
    expect((await failed).status()).toBe(500);
    // The safety section closes on the way back; a failed origin read leaves the selected flight and its draft.
    await expect(safety).toBeHidden();
    await expect(overview).toBeHidden();
    await expect(draft).toBeVisible();
    await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
    await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
    await expect(page.getByTestId(selectedRecordId!)).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await page.unroute(originTimelineRoute, failedOrigin);
  }
  await draft.getByRole('button', { name: 'Refresh basis', exact: true }).click();
  await expect(draft).not.toContainText('record changed');
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let acceptedDecision: CommandResponse | undefined;
  const commandRoute = '**/v1/commands';
  const loseFirstReply = async (route: Route) => {
    const sent = route.request();
    if (
      sent.method() !== 'POST' ||
      sent.postDataJSON()?.kind !== 'decision.record' ||
      sent.postDataJSON()?.flightId !== olderFlight.id
    ) {
      await route.continue();
      return;
    }
    attempts.push({ key: sent.headers()['idempotency-key'], body: sent.postData() });
    if (attempts.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.status(), await accepted.text()).toBe(201);
      acceptedDecision = (await accepted.json()) as CommandResponse;
      await route.abort('failed');
    } else await route.continue();
  };
  await page.route(commandRoute, loseFirstReply);
  try {
    await draft.getByRole('button', { name: 'Record decision', exact: true }).click();
    const actions = page.locator('.actions-card');
    const retry = actions.getByRole('button', { name: 'Retry same action', exact: true });
    await expect(actions.getByText('Confirm the recorded result', { exact: true })).toBeVisible();
    await expect(actions).toContainText('The result is unknown. Recover it with the identical retained request');
    await expect(draft.getByLabel('Judgment')).toBeDisabled();
    await expect(draft.getByLabel('Decision rationale')).toBeDisabled();
    await expect(draft.getByRole('button', { name: 'Record decision', exact: true })).toBeDisabled();
    await expect(retry).toBeEnabled();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.key).toBeTruthy();
    expect(JSON.parse(attempts[0]!.body!)).toMatchObject({
      kind: 'decision.record',
      flightId: olderFlight.id,
      decision: { kind: 'hold', note },
    });
    await expect.poll(async () => (await timeline(request, olderFlight.id)).decisions.length).toBe(1);
    await views.getByRole('button', { name: 'History', exact: true }).click();
    await expectOverview('Flight history');
    await expect.poll(() => pendingRetainedReads.size).toBe(0);
    expect(retainedReads).toEqual(
      expect.arrayContaining([`/v1/flights/${olderFlight.id}/timeline`, `/v1/flights/${olderFlight.id}/mission`]),
    );
    const pausedReads = retainedReads.length;
    const overviewAt = Date.now();
    const historyPoll = page.waitForResponse((reply) => {
      const url = new URL(reply.url());
      return (
        reply.ok() &&
        reply.request().timing().startTime >= overviewAt &&
        url.pathname === '/v1/flights' &&
        url.searchParams.get('view') === 'history' &&
        url.searchParams.get('search') === olderFlight.id
      );
    });
    await views.getByRole('button', { name: 'History', exact: true }).click();
    await historyPoll;
    await expectOverview('Flight history');
    expect(retainedReads).toHaveLength(pausedReads);
    expect(attempts).toHaveLength(1);
    await selectFlight(page, olderFlight.id);
    await expect(page.getByTestId(selectedRecordId!)).toHaveAttribute('aria-pressed', 'true');
    await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
    await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
    await expect(actions.getByText('Confirm the recorded result', { exact: true })).toBeVisible();
    await expect(draft.getByLabel('Judgment')).toBeDisabled();
    await expect(draft.getByLabel('Decision rationale')).toBeDisabled();
    await expect(draft.getByRole('button', { name: 'Record decision', exact: true })).toBeDisabled();
    const retried = page.waitForResponse(
      (reply) => reply.url().endsWith('/v1/commands') && reply.request().method() === 'POST',
    );
    await retry.click();
    const recovered = await retried;
    expect(recovered.status(), await recovered.text()).toBe(201);
    expect(((await recovered.json()) as CommandResponse).command.id).toBe(acceptedDecision!.command.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(page.getByText('Decision recorded with its input basis.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await timeline(request, olderFlight.id)).decisions.length).toBe(1);
    expect((await timeline(request, olderFlight.id)).decisions[0]!.id).toBe(acceptedDecision!.command.id);
  } finally {
    await page.unroute(commandRoute, loseFirstReply);
  }
  await views.getByRole('button', { name: 'Operation', exact: true }).click();
  await scopes.getByRole('button', { name: 'Current', exact: true }).click();
  await expectOverview('Current operation');
  await flightSearch.fill('');
  await selectFlight(page, activeFlight.id);
  await expect(page.getByTestId(`flight-row-${landedFlight.id}`)).toHaveCount(0);
  const previousPolls = monitorPolls();
  await expect.poll(monitorPolls, { timeout: 12000, intervals: [250] }).toBeGreaterThanOrEqual(previousPolls + 3);
  expect(
    flightRequests.every((url) =>
      ['monitor', 'overdue', 'historical-issues', 'history'].includes(url.searchParams.get('view') ?? ''),
    ),
  ).toBe(true);

  const presenceRoute = (url: URL) =>
    url.pathname === '/v1/flights' &&
    url.searchParams.get('view') === 'historical-issues' &&
    url.searchParams.get('limit') === '1' &&
    url.searchParams.size === 2;
  let presenceMode: 'failed' | 'empty' | 'hold-alpha' = 'failed';
  let oldAlphaReady = false;
  let releaseOldAlpha = () => {};
  const oldAlphaGate = new Promise<void>((resolve) => {
    releaseOldAlpha = resolve;
  });
  const heldPresenceReads: Promise<void>[] = [];
  const controlledPresence = (route: Route) => {
    const delivered = (async () => {
      const credential = route.request().headers().authorization;
      if (presenceMode === 'failed') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'attention_unavailable', message: 'Historical issues check temporarily unavailable.' },
          }),
        });
        return;
      }
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      if (presenceMode === 'hold-alpha' && credential === `Bearer ${alpha}`) {
        expect(((await response.json()) as FlightListResponse).flights.length).toBeGreaterThan(0);
        oldAlphaReady = true;
        await oldAlphaGate;
        await route.fulfill({ response }).catch(() => {});
        return;
      }
      const data = (await response.json()) as FlightListResponse;
      await route.fulfill({ response, json: { ...data, flights: [], nextCursor: null } });
    })();
    heldPresenceReads.push(delivered);
    return delivered;
  };
  const failedPresence = page.waitForResponse(
    (response) => presenceRoute(new URL(response.url())) && response.status() === 503,
  );
  await page.route(presenceRoute, controlledPresence);
  try {
    await (await failedPresence).finished();
    await expect(historicalAttention).toHaveAttribute('title', /Refresh interrupted/);
    await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
    presenceMode = 'empty';
    const freshEmpty = await page.waitForResponse(
      (response) => presenceRoute(new URL(response.url())) && response.ok(),
    );
    expect(((await freshEmpty.json()) as FlightListResponse).flights).toEqual([]);
    await expect(historicalAttention).toHaveAttribute('data-attention', 'clear');
    presenceMode = 'hold-alpha';
    await expect.poll(() => oldAlphaReady).toBe(true);
    const betaPresence = page.waitForResponse(
      (response) =>
        presenceRoute(new URL(response.url())) &&
        response.ok() &&
        response.request().headers().authorization === `Bearer ${beta}`,
    );
    await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
    await chooseOperator(page, 'Beta Inspection');
    await betaPresence;
    await expect(page.getByText('Beta Inspection', { exact: true })).toBeVisible();
    await expect(historicalAttention).toHaveAttribute('data-attention', 'clear');
    releaseOldAlpha();
    await Promise.all(heldPresenceReads);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(historicalAttention).toHaveAttribute('data-attention', 'clear');
    await expect(page.getByTestId(`flight-row-${historicalIssue.id}`)).toHaveCount(0);
  } finally {
    presenceMode = 'empty';
    releaseOldAlpha();
    await Promise.allSettled(heldPresenceReads);
    await page.unroute(presenceRoute, controlledPresence);
  }
  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await chooseOperator(page, 'Alpha Dispatch');
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await expect(page.locator('.flight-row').first()).toBeVisible();
  const searchedMonitor = (url: URL) =>
    url.pathname === '/v1/flights' &&
    url.searchParams.get('view') === 'monitor' &&
    url.searchParams.get('search') === activeFlight.id;
  let releaseSearchedMonitor!: () => void;
  const searchedMonitorGate = new Promise<void>((resolve) => {
    releaseSearchedMonitor = resolve;
  });
  let searchedMonitorReady = false;
  const pendingSearchedMonitor: Promise<void>[] = [];
  const holdSearchedMonitor = (route: Route) => {
    const delivered = (async () => {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      searchedMonitorReady = true;
      await searchedMonitorGate;
      await route.fulfill({ response });
    })();
    pendingSearchedMonitor.push(delivered);
    return delivered;
  };
  await page.route(searchedMonitor, holdSearchedMonitor);
  try {
    const searched = page.waitForResponse((response) => searchedMonitor(new URL(response.url())) && response.ok());
    await flightSearch.fill(activeFlight.id);
    await scopes.getByRole('button', { name: 'Current', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await scopes.getByRole('button', { name: 'Current', exact: true }).click();
    await expect.poll(() => searchedMonitorReady).toBe(true);
    await expectOverview('Current operation');
    const heading = overview.getByRole('heading', { name: 'Current operation', exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    releaseSearchedMonitor();
    await (await searched).finished();
    await expect(page.getByTestId(`flight-row-${activeFlight.id}`)).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
  } finally {
    releaseSearchedMonitor();
    await Promise.allSettled(pendingSearchedMonitor);
    await page.unroute(searchedMonitor, holdSearchedMonitor);
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  await captureScope('historical-attention-current', 'Current');
  await flightSearch.fill(historicalIssue.id);
  await historicalAttention.click();
  await expectOverview('Historical issues');
  await expect(page.getByTestId(`flight-row-${historicalIssue.id}`)).toBeVisible();
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
  await captureScope('historical-attention-selected', 'Historical issues');
  await expect(historicalAttention).toHaveAttribute('data-attention', 'present');
});
