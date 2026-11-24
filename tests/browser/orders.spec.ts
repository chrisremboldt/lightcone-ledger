import { test, expect, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  FlightListResponse,
  FlightResponse,
  OrderListResponse,
  ReceiptResponse,
  TimelineResponse,
} from '@ledger/contracts';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const operator = { authorization: 'Bearer ledger-dev-alpha-operator' };
const source = { authorization: 'Bearer ledger-dev-alpha-source' };

test('an incoming order waits outside orphan evidence, then appears as a linked flight without replacing the open draft', async ({
  page,
  request,
}, testInfo) => {
  const identity = randomUUID();
  const scheduledStart = new Date(Date.now() + 15 * 60_000).toISOString();
  const scheduledEnd = new Date(Date.now() + 20 * 60_000).toISOString();
  const created = await request.post(`${api}/v1/flights`, {
    headers: { ...operator, 'idempotency-key': randomUUID() },
    data: { originationKey: `order-review:${identity}`, label: `Dispatch review ${identity}`, scheduledEnd },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const selected = ((await created.json()) as FlightResponse).flight;
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/v1/flights/${selected.id}/timeline`, { headers: operator });
      return ((await response.json()) as TimelineResponse).flight.outstandingWork;
    })
    .toBe(0);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByTestId(`flight-row-${selected.id}`).click();
  await expect(page.getByTestId('requested-window')).toContainText('By ');
  await expect(page.getByTestId('requested-window')).not.toContainText('Not recorded');
  await page.locator('.actions-card').getByRole('button', { name: 'Record decision', exact: true }).click();
  const draft = page.getByTestId('decision-form');
  await draft.getByLabel('Judgment').selectOption('hold');
  const note = 'Keep this dispatch review open while incoming work receives a flight.';
  await draft.getByLabel('Decision rationale').fill(note);

  const sourceId = `browser-orders-${identity}`;
  const externalId = `incoming-${identity}`;
  const label = `Clinic supplies ${identity}`;
  const submitOrder = async (revision: number, fulfillments: object[], window = { scheduledStart, scheduledEnd }) => {
    const response = await request.post(`${api}/v1/inputs`, {
      headers: { ...source, 'idempotency-key': randomUUID() },
      data: {
        sourceId,
        kind: 'order.revision',
        sourceRevision: revision,
        occurredAt: new Date().toISOString(),
        subject: { orderId: externalId },
        payload: { externalId, label, revision, status: 'accepted', ...window, fulfillments },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return ((await response.json()) as ReceiptResponse).receipt;
  };
  const incoming = await submitOrder(1, []);
  let orders: OrderListResponse;
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/v1/orders?view=awaiting-flight&sourceId=${sourceId}`, {
        headers: operator,
      });
      orders = (await response.json()) as OrderListResponse;
      return orders.orders.length;
    })
    .toBe(1);
  const readyAt = Date.now();
  const orderId = orders!.orders[0]!.id;
  const awaiting = page.getByTestId('awaiting-orders');
  const row = awaiting.getByTestId(`awaiting-order-${orderId}`);
  await expect(awaiting).toBeVisible();
  await expect(awaiting).toContainText('Orders across this operator · not filtered by flight search');
  let orderView: 'awaiting-current' | 'awaiting-overdue' = 'awaiting-current';
  const awaitingResponse = (response: Response, cursor?: string) => {
    const url = new URL(response.url());
    return (
      response.ok() &&
      response.request().method() === 'GET' &&
      url.pathname === '/v1/orders' &&
      url.searchParams.get('view') === orderView &&
      !url.searchParams.has('sourceId') &&
      !url.searchParams.has('flightId') &&
      url.searchParams.get('cursor') === (cursor ?? null)
    );
  };
  async function findOrder(after: number) {
    const initial = await page.waitForResponse(
      (response) => awaitingResponse(response) && response.request().timing().startTime >= after,
    );
    let visibleOrders = (await initial.json()) as OrderListResponse;
    const seenCursors = new Set<string>();
    const seenPages = new Set([JSON.stringify(visibleOrders.orders.map((order) => order.id))]);
    await expect
      .poll(() =>
        awaiting.locator('article').evaluateAll((articles) => articles.map((article) => article.dataset.testid)),
      )
      .toEqual(visibleOrders.orders.map((order) => `awaiting-order-${order.id}`));
    while (!(await row.count()) && visibleOrders.page.nextCursor) {
      const cursor = visibleOrders.page.nextCursor;
      expect(seenCursors.has(cursor), 'Awaiting-order pagination must advance its cursor').toBe(false);
      seenCursors.add(cursor);
      const more = awaiting.getByRole('button', { name: 'More orders', exact: true });
      const next = page.waitForResponse((response) => awaitingResponse(response, cursor));
      await more.click();
      visibleOrders = (await (await next).json()) as OrderListResponse;
      const pageIds = JSON.stringify(visibleOrders.orders.map((order) => order.id));
      expect(seenPages.has(pageIds), 'Awaiting-order pagination must advance its rows').toBe(false);
      seenPages.add(pageIds);
      await expect
        .poll(() =>
          awaiting.locator('article').evaluateAll((articles) => articles.map((article) => article.dataset.testid)),
        )
        .toEqual(visibleOrders.orders.map((order) => `awaiting-order-${order.id}`));
    }
  }
  await findOrder(readyAt);
  await expect(row).toContainText(label);
  await expect(row).toContainText('Upcoming · awaiting dispatch');
  await expect(row).not.toContainText('No flight linked');
  await expect(row).toContainText('Requested');
  await page.getByRole('button', { name: /Unlinked evidence/ }).click();
  await expect(page.getByRole('region', { name: 'Unlinked evidence receipts' })).toBeVisible();
  await expect(page.getByTestId(`unresolved-receipt-${incoming.id}`)).toHaveCount(0);
  await expect(draft.getByLabel('Judgment')).toHaveValue('hold');
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
  await page.getByRole('button', { name: 'Return to flight', exact: true }).click();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('awaiting-flight-order.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('upcoming-order-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  await submitOrder(2, [], {
    scheduledStart: new Date(Date.now() - 10 * 60_000).toISOString(),
    scheduledEnd: new Date(Date.now() - 60_000).toISOString(),
  });
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/v1/orders?view=awaiting-overdue&sourceId=${sourceId}`, {
        headers: operator,
      });
      return ((await response.json()) as OrderListResponse).orders.some((order) => order.id === orderId);
    })
    .toBe(true);
  orderView = 'awaiting-overdue';
  const overduePage = findOrder(Date.now());
  await page
    .getByRole('group', { name: 'Operation scope' })
    .getByRole('button', { name: 'Overdue', exact: true })
    .click();
  await overduePage;
  await expect(row).toContainText('Requested window elapsed · needs disposition');
  await expect(row).toContainText('No flight linked');
  await expect(page.getByTestId('operation-overview')).toBeVisible();
  await expect(draft).toBeHidden();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('overdue-order-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('overdue-order-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole('group', { name: 'Operation scope' })
    .getByRole('button', { name: 'Current', exact: true })
    .click();
  await expect(page.getByTestId('operation-overview')).toBeVisible();
  await page.getByTestId(`flight-row-${selected.id}`).click();
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);

  const linkedRoster = page.waitForResponse(async (response) => {
    const url = new URL(response.url());
    if (!response.ok() || url.pathname !== '/v1/flights' || url.searchParams.get('view') !== 'monitor') return false;
    const result = (await response.json()) as FlightListResponse;
    return result.flights.some((flight) => flight.originationKey === `incoming-flight:${identity}`);
  });
  await submitOrder(3, [
    { originationKey: `incoming-flight:${identity}`, label, aircraft: 'Courier 7', scheduledStart, scheduledEnd },
  ]);
  let linkedFlightId: string | undefined;
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/v1/orders?sourceId=${sourceId}`, { headers: operator });
      const linked = ((await response.json()) as OrderListResponse).orders[0];
      linkedFlightId = linked?.flightIds[0];
      return Boolean(linkedFlightId);
    })
    .toBe(true);
  await expect(row).toHaveCount(0);
  await linkedRoster;
  await expect(page.getByTestId(`flight-row-${linkedFlightId}`)).toContainText(label);
  await expect(draft.getByLabel('Decision rationale')).toHaveValue(note);
  await draft.getByRole('button', { name: 'Close action form', exact: true }).click();
  await page.getByTestId(`flight-row-${linkedFlightId}`).click();
  await expect(
    page.locator('.rail-section').filter({ has: page.getByRole('heading', { name: 'Linked orders' }) }),
  ).toContainText(label);
});
