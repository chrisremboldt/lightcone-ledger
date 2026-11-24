import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { FlightResponse, ReceiptResponse, TimelineResponse } from '@ledger/contracts';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const authorization = { authorization: 'Bearer ledger-dev-alpha-operator' };

async function timeline(request: APIRequestContext, flightId: string) {
  const response = await request.get(`${api}/v1/flights/${flightId}/timeline`, { headers: authorization });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as TimelineResponse;
}

test('an overdue finding is owned, records a response, and is closed by its owner once a later report clears it', async ({
  page,
  request,
}, testInfo) => {
  const landingDeadline = Date.now() + 15_000;
  const created = await request.post(`${api}/v1/flights`, {
    headers: { ...authorization, 'idempotency-key': randomUUID() },
    data: {
      originationKey: `browser-finding:${randomUUID()}`,
      label: `Landing evidence review ${randomUUID().slice(0, 6)}`,
      aircraft: 'Browser finding aircraft',
      scheduledStart: new Date(Date.now() - 30 * 60_000).toISOString(),
      scheduledEnd: new Date(landingDeadline - 5 * 60_000).toISOString(),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const flight = ((await created.json()) as FlightResponse).flight;
  await expect
    .poll(async () => {
      const response = await timeline(request, flight.id);
      return { findings: response.findings?.length ?? 0, outstandingWork: response.flight.outstandingWork };
    })
    .toEqual({ findings: 0, outstandingWork: 0 });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('button', { name: 'Overdue', exact: true }).click();
  await page.getByTestId(`flight-row-${flight.id}`).click();
  const panel = page.getByTestId('findings-panel');
  await expect(panel).toHaveCount(0);
  await page.locator('.actions-card').getByRole('button', { name: 'Record decision', exact: true }).click();
  const genericForm = page.getByTestId('decision-form');
  const legacyNote = 'I am reviewing the record before marking the landing issue resolved.';
  await genericForm.getByLabel('Judgment').selectOption('resolve');
  await genericForm.getByLabel('Decision rationale').fill(legacyNote);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const original = (await timeline(request, flight.id)).findings![0]!;
  await expect(panel).toContainText(original.initialEvaluation.title);
  await expect(panel).toContainText('Nobody has taken responsibility');
  await expect(genericForm.getByLabel('Judgment')).toHaveValue('resolve');
  await expect(genericForm.getByLabel('Decision rationale')).toHaveValue(legacyNote);
  await expect(genericForm.locator('option[value="resolve"]')).toBeDisabled();
  await expect(genericForm.getByRole('button', { name: 'Record decision', exact: true })).toBeDisabled();
  await expect(genericForm).toContainText('Your draft is kept.');
  await expect(genericForm).toContainText('Take responsibility, respond or resolve in Recorded findings above.');
  const genericNote = 'Hold further dispatch until the crew landing evidence is checked.';
  await genericForm.getByLabel('Judgment').selectOption('hold');
  await expect(
    genericForm.locator('option[value="acknowledge"], option[value="respond"], option[value="resolve"]'),
  ).toHaveCount(0);
  await genericForm.getByLabel('Decision rationale').fill(genericNote);
  await panel.getByRole('button', { name: 'Take responsibility', exact: true }).click();
  let form = panel.getByTestId('finding-treatment-form');
  await form.getByLabel('What you will check').fill('I will obtain the landing report from the crew.');
  await form.getByRole('button', { name: 'Take responsibility', exact: true }).click();
  await expect(panel).toContainText('Dana Ortiz owns this finding');
  await expect(genericForm.getByLabel('Judgment')).toHaveValue('hold');
  await expect(genericForm.getByLabel('Decision rationale')).toHaveValue(genericNote);
  await genericForm.getByRole('button', { name: 'Close action form', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Close the finding', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Record response', exact: true }).click();
  form = panel.getByTestId('finding-treatment-form');
  const responseNote = 'I asked the crew for the landing report.';
  await form.getByLabel('Response and reason').fill(responseNote);
  const recordedResponse = page.waitForResponse(
    (reply) => reply.url().endsWith('/v1/commands') && reply.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Record response', exact: true }).click();
  expect((await recordedResponse).status()).toBe(201);
  await expect(panel.getByText('Treatment history · 2', { exact: true })).toBeVisible();
  const landed = await request.post(`${api}/v1/inputs`, {
    headers: { authorization: 'Bearer ledger-dev-alpha-source', 'idempotency-key': randomUUID() },
    data: {
      sourceId: `browser-finding-${flight.id}`,
      kind: 'flight.observation',
      occurredAt: new Date().toISOString(),
      subject: { flightId: flight.id },
      payload: {
        title: 'Crew landing report',
        activity: 'landed',
        landingTime: new Date(Date.now() - 12 * 60_000).toISOString(),
      },
    },
  });
  expect(landed.ok(), await landed.text()).toBeTruthy();
  const receipt = ((await landed.json()) as ReceiptResponse).receipt;
  // The later report clears the check, but a report is not a record people keep: the finding stays open for a person.
  await expect(panel).toContainText('The latest result is supported by the record; a person closes this finding.', {
    timeout: 30_000,
  });
  await expect(panel.getByTestId('finding-closure')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close the finding', exact: true }).click();
  form = panel.getByTestId('finding-treatment-form');
  await expect(form.getByRole('button', { name: 'Close the finding', exact: true })).toBeDisabled();
  await form.getByLabel('The condition ended; what it reported still happened', { exact: true }).check();
  await form.getByLabel('Why it is closed', { exact: true }).fill('Landing evidence is now recorded and checked.');
  await form.getByRole('button', { name: 'Close the finding', exact: true }).click();
  // The state badge, and the treatment history's own "Closed" entry, both say it.
  await expect(panel.getByTestId('finding-detail').getByText('Closed', { exact: true }).first()).toBeVisible();
  await expect(panel.getByTestId('finding-closure')).toContainText('Closed by Dana Ortiz');
  await panel.getByText('Treatment history · 3', { exact: true }).click();
  await expect(panel).toContainText(responseNote);
  await panel.getByText('Original finding and evidence', { exact: true }).click();
  await expect(panel).toContainText(original.initialEvaluation.explanation.summary);
  const recorded = (await timeline(request, flight.id)).findings![0]!;
  expect(recorded.id).toBe(original.id);
  expect(recorded.initialEvaluation).toEqual(original.initialEvaluation);
  expect(recorded.status).toBe('resolved');
  expect(recorded.closure).toMatchObject({ by: 'person', reason: 'condition_ended' });
  expect(recorded.treatments.map((treatment) => treatment.action)).toEqual(['acknowledge', 'respond', 'close']);
  expect(recorded.latestEvaluation.explanation.evidence.some((evidence) => evidence.receiptId === receipt.id)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('recorded-finding-treatment.png') });
});
