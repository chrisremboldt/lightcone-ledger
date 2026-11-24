import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Command, FindingRecord, Principal, ReceiptResponse, TimelineResponse } from '@ledger/contracts';
import { isLostLinkEvaluation, linkStatusGrant, linkStatusRevocation, reportLinkStatus } from './mission-fixture.js';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const operator = 'ledger-dev-alpha-operator';
const source = 'ledger-dev-alpha-source';
const mapName = 'Hazard evidence positions, historical observed track and mission corridor';
const writeHeaders = (token: string) => ({ authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() });

async function read<T>(request: APIRequestContext, path: string, token = operator): Promise<T> {
  const response = await request.get(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

const principal = async (request: APIRequestContext, token: string) =>
  (await read<{ principal: Principal }>(request, '/v1/me', token)).principal;

async function command(request: APIRequestContext, body: Command) {
  const response = await request.post(`${api}/v1/commands`, { headers: writeHeaders(operator), data: body });
  expect(response.status(), await response.text()).toBe(201);
}

async function post<T>(request: APIRequestContext, path: string, token: string, data?: unknown): Promise<T> {
  const response = await request.post(`${api}${path}`, { headers: writeHeaders(token), data });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<T>;
}

/** A flight whose link monitor reported a lost link with no position, so a finding opens. */
async function lostLinkFlight(request: APIRequestContext, sourceId: string, identity: string) {
  const { flight } = await post<{ flight: { id: string; aircraft: string } }>(request, '/v1/flights', operator, {
    originationKey: `browser:pointer:${identity}`,
    label: `Pointer placement ${identity.slice(0, 6)}`,
    aircraft: 'Pointer aircraft',
    scheduledStart: new Date(Date.now() - 5 * 60_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const receipt = await reportLinkStatus(request, sourceId, flight.id, {
    sourceSessionId: `browser-pointer-session-${identity}`,
    sourceEventId: `lost-${identity}`,
    incidentId: `browser-pointer-incident-${identity}`,
    aircraftId: flight.aircraft,
    occurredAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    status: 'lost',
  });
  await expect
    .poll(async () => (await read<ReceiptResponse>(request, `/v1/receipts/${receipt.id}`)).receipt.processing.status, {
      timeout: 20_000,
    })
    .toBe('completed');
  const commandLink = (finding: FindingRecord) => isLostLinkEvaluation(finding.latestEvaluation);
  await expect
    .poll(async () => {
      const timeline = await read<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`);
      return Boolean(timeline.findings?.some(commandLink)) && timeline.flight.outstandingWork === 0;
    })
    .toBe(true);
  return flight;
}

/**
 * Run one pointer action of the simulated person against the map editor on screen, through the
 * same player module the application uses (the development server serves it by path).
 */
async function perform(page: Page, action: 'clickAt' | 'drag', ...points: { x: number; y: number }[]) {
  return page.evaluate(
    async ({ action, points, mapName }) => {
      const player = '/src/autopilot/player.ts';
      const locators = '/src/autopilot/locators.ts';
      const { play, snapshot } = await import(/* @vite-ignore */ player);
      const { page: screen } = await import(/* @vite-ignore */ locators);
      const map = screen.testId('avoidance-editor-map');
      const target = action === 'clickAt' ? map.labelled(mapName) : map.testId('control-center-handle');
      await play(
        {
          id: 'pointer-check',
          operator: 'alpha',
          title: 'Pointer check',
          summary: '',
          run: (actor: Record<string, (...values: unknown[]) => Promise<void>>) => actor[action]!(target, ...points),
        },
        0.05,
      );
      const { status, problem } = snapshot();
      return status === 'done' ? status : `${status}: ${problem}`;
    },
    { action, points, mapName },
  );
}

const scenes = [
  { id: 'hazard', title: 'A hazard is identified, assessed and accepted' },
  { id: 'documents', title: 'A procedure is written, signed, issued and acknowledged' },
  { id: 'landing', title: 'A landing report goes missing' },
  { id: 'lostlink', title: 'A lost control link becomes a hazard' },
  { id: 'decision', title: 'New evidence arrives mid-decision' },
  { id: 'wind', title: 'Wind at a dock rises above the adopted limit' },
  { id: 'rules', title: 'One flight checked against today’s rules and proposed ones' },
];

/** A scene that loses its place reports why; surface that instead of a bare timeout. */
async function finished(page: Page) {
  const session = page.getByTestId('autopilot');
  await expect
    .poll(() => session.getAttribute('data-status'), { timeout: 150_000, intervals: [500] })
    .toMatch(/^(done|failed)$/);
  expect(await session.getByRole('status').textContent()).toContain('Scene complete');
  return session;
}

test('the simulated person identifies, assesses and signs a hazard through the real screens', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?autopilot=hazard&pace=fast');
  await expect(page.getByTestId('autopilot')).toContainText('Simulated person');
  const session = await finished(page);

  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: /Link loss near energized line at Tower \d+/ })).toBeVisible();
  await expect(record.getByText('Risk accepted', { exact: true })).toBeVisible();
  const signature = page.getByTestId('sms-signature');
  await expect(signature).toContainText('I, Morgan Ellis, accept the predicted residual risk of High');
  await expect(signature).toContainText('Accepts high risk');

  await session.getByRole('button', { name: 'Close' }).click();
  await expect(session).toHaveCount(0);
});

test('the simulated people take a procedure from draft to a personal acknowledgement', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?autopilot=documents&pace=fast');
  await finished(page);
  const reader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await expect(reader).toContainText(/Battery handling procedure BH-\d+/);
  await expect(reader).toContainText('You acknowledged Revision 1 on');
});

test('the simulated dispatcher owns a finding the landing rule opened and closes it after the late report', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/?autopilot=landing&pace=fast');
  await finished(page);
  const panel = page.getByTestId('findings-panel');
  // The state badge, and the treatment history's own "Closed" entry, both say it.
  await expect(panel.getByTestId('finding-detail').getByText('Closed', { exact: true }).first()).toBeVisible();
  await expect(panel).toContainText('Dana Ortiz owns this finding');
  await expect(panel.getByTestId('finding-closure')).toContainText(
    'Closed by Dana Ortiz: The condition ended; what it reported still happened.',
  );
  await expect(panel).toContainText('Landing evidence is now recorded and checked.');
});

test('the simulated people take a lost-link finding through a hazard, a placed control and its acceptance', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/?autopilot=lostlink&pace=fast');
  await finished(page);
  // The flights stay open, hidden, behind the safety section; each has its own top bar.
  await expect(page.locator('.topbar-user').filter({ visible: true })).toContainText('Sam Rivera');
  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: /Control link loss near Canal Market \d+/ })).toBeVisible();
  await expect(record.getByText('Risk accepted', { exact: true })).toBeVisible();
  await expect(record.getByTestId('hazard-origin')).toContainText('From a finding');
  await expect(record.getByTestId('sms-hazard-controls')).toContainText(/Avoid the Canal Market approach \d+/);
  await expect(record.getByTestId('sms-hazard-controls')).toContainText('Accepted with the risk');
  const signature = page.getByTestId('sms-signature');
  await expect(signature).toContainText('I, Sam Rivera, accept the predicted residual risk of Medium');
});

test('the simulated cursor places a control centre at a point on the map and drags it', async ({ page, request }) => {
  test.setTimeout(120_000);
  const identity = randomUUID();
  const sourceId = `browser-pointer-${identity}`;
  const monitor = await principal(request, source);
  await command(request, linkStatusGrant(monitor, sourceId));
  try {
    const flight = await lostLinkFlight(request, sourceId, identity);
    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await page.getByTestId(`flight-row-${flight.id}`).click();
    const finding = page.getByTestId('finding-detail');
    await expect(finding).toBeVisible({ timeout: 30_000 });
    await finding.getByRole('button', { name: 'Open safety workspace', exact: true }).click();
    const opening = page.getByRole('form', { name: 'Open a hazard from this finding', exact: true });
    await opening.getByLabel('Hazard', { exact: true }).fill(`Pointer placement ${identity.slice(0, 6)}`);
    await opening.getByLabel('What could go wrong, and where').fill('A hazard to place a control centre on.');
    await opening.getByLabel('Worst credible outcome').fill('A fictional outcome.');
    await opening.getByRole('button', { name: 'Open hazard', exact: true }).click();
    await expect(page.getByTestId('hazard-origin')).toBeVisible();
    await page.getByRole('button', { name: 'Propose a control', exact: true }).click();
    const proposal = page.getByRole('form', { name: 'Propose a control', exact: true });
    await proposal.getByLabel('Control type').selectOption({ label: 'Route avoidance area' });
    // The finding's occurrence evidence loads beside the map; wait for it so the map does not move under the click.
    await expect(
      page.getByTestId('hazard-control-map').getByRole('button', { name: 'Refresh evidence locations' }),
    ).toBeVisible();
    await expect(page.getByTestId('hazard-control-map')).toContainText('Location remains unknown.');

    const editor = page.getByTestId('hazard-control-map');
    await editor.getByRole('combobox', { name: /^View an operating site/ }).selectOption('Canal Market');
    await editor.getByLabel('Proposed radius (m)', { exact: true }).fill('100');
    const map = editor.getByTestId('avoidance-editor-map');
    await map.getByRole('button', { name: 'Place center', exact: true }).click();
    const canvas = map.getByRole('group', { name: mapName, exact: true });
    await canvas.scrollIntoViewIfNeeded();
    const latitude = proposal.getByLabel('Centre latitude', { exact: true });
    const longitude = proposal.getByLabel('Centre longitude', { exact: true });
    await expect(latitude).toHaveValue('');

    expect(await perform(page, 'clickAt', { x: 0.6, y: 0.55 })).toBe('done');
    const handle = map.getByTestId('control-center-handle');
    await expect(handle).toBeVisible();
    const box = (await canvas.boundingBox())!;
    const placed = (await handle.locator('circle').last().boundingBox())!;
    expect(Math.abs(placed.x + placed.width / 2 - (box.x + box.width * 0.6))).toBeLessThan(1.5);
    expect(Math.abs(placed.y + placed.height / 2 - (box.y + box.height * 0.55))).toBeLessThan(1.5);
    const before = { latitude: Number(await latitude.inputValue()), longitude: Number(await longitude.inputValue()) };
    expect(Number.isFinite(before.latitude) && before.latitude !== 0).toBe(true);
    expect(Number.isFinite(before.longitude) && before.longitude !== 0).toBe(true);
    await expect(map.getByRole('button', { name: 'Place center', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // The radius handle's wide grip overlaps the centre; the map tells them apart by distance, as for a person.
    expect(await perform(page, 'drag', { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 })).toBe('done');
    await expect.poll(async () => Number(await longitude.inputValue())).toBeGreaterThan(before.longitude);
    const moved = (await handle.locator('circle').last().boundingBox())!;
    expect(moved.x - placed.x).toBeGreaterThan(30);
  } finally {
    const current = await principal(request, source);
    await command(request, linkStatusRevocation(current, sourceId));
  }
});

test('the simulated dispatcher is refused a stale decision and records it after review', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?autopilot=decision&pace=fast');
  await finished(page);
  await expect(page.getByText('Decision recorded with its input basis.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('decision-basis')).toContainText('Holding this record open');
});

test('the simulated people adopt a wind limit, turn its finding into an accepted limit, and see it at the next release', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/?autopilot=wind&pace=fast');
  await finished(page);
  const controls = page.getByRole('region', { name: 'Controls in scope for this flight', exact: true });
  const limit = controls
    .locator('.flight-control')
    .filter({ hasText: /Wind limit at docks \d+/ })
    .last();
  await expect(limit).toContainText('Checked by the organization’s rule');
  await expect(limit.locator('[data-result="pass"]')).toContainText('Pass');
});

test('the simulated people check one flight against active and shadow packs and see only counted findings in its release', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/?autopilot=rules&pace=fast');
  await finished(page);
  const counted = page.getByTestId('release-findings-counted');
  await expect(counted).toContainText('Height of at most 300 feet above ground');
  await expect(counted).toContainText('Remote pilot in command recorded is a listed pilot');
  await expect(counted).not.toContainText('Coordinator handover names its handover procedure');
  const proposed = page.getByTestId('release-findings-proposed');
  await expect(proposed).toContainText('Proposed rule: recorded, not counted');
  await expect(proposed).toContainText('Coordinator handover names its handover procedure');
  await expect(proposed).toContainText('Latest training record holds date, materials, provider and evidence');
});

test('a person can start a scene from the sign-in screen, pause it and take over', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Fictional Valley Power', exact: true }).check();
  const offered = page.getByRole('region', { name: 'Simulated sessions' });
  await expect(offered.getByRole('button')).toHaveCount(2);
  await offered.getByRole('button', { name: /A hazard is identified, assessed and accepted/ }).click();
  const session = page.getByTestId('autopilot');
  await expect(session).toHaveAttribute('data-status', 'running');
  await session.getByRole('button', { name: 'Pause' }).click();
  await expect(session).toHaveAttribute('data-status', 'paused');
  await session.getByRole('button', { name: 'Take over' }).click();
  await expect(session).toHaveCount(0);
});

test('the sign-in screen describes the chosen organization and offers its scenes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await expect(page.getByText('Rules are checked on every flight')).toBeVisible();
  await expect(page.getByText('Proposed rules are recorded, not counted')).toBeVisible();
  // Scenes are grouped by what they show.
  const rulesGroup = page.getByRole('group', { name: 'Rules and findings', exact: true });
  await expect(rulesGroup.getByRole('button', { name: /A landing report goes missing/ })).toBeVisible();
  await expect(rulesGroup.getByRole('button', { name: /One flight checked against today’s rules/ })).toBeVisible();
  const controlGroup = page.getByRole('group', { name: 'From a finding to a control', exact: true });
  await expect(controlGroup.getByRole('button')).toHaveCount(2);
  await expect(
    controlGroup.getByRole('button', { name: /Wind at a dock rises above the adopted limit/ }),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Beta Inspection', exact: true }).check();
  await expect(page.getByText('Stale decisions are refused')).toBeVisible();
  await expect(page.getByRole('button', { name: /New evidence arrives mid-decision/ })).toBeVisible();
  await page.getByRole('radio', { name: 'Fictional Valley Power', exact: true }).check();
  await expect(page.getByText('Documents are controlled by revision')).toBeVisible();
});

for (const scene of scenes) {
  test(`the recording of “${scene.title}” replays without asking the API for anything`, async ({ page }) => {
    test.setTimeout(180_000);
    const asked: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/v1/')) asked.push(request.url());
    });
    await page.goto(`/?autopilot=${scene.id}&replay=1&pace=fast`);
    await expect(page.getByTestId('autopilot')).toContainText('Simulated person · recorded');
    await finished(page);
    expect(asked).toEqual([]);
  });
}
