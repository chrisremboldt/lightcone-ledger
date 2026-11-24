import { test, expect, type APIRequestContext, type Locator, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { isLostLinkEvaluation, linkStatusGrant, linkStatusRevocation, reportLinkStatus } from './mission-fixture.js';
import { centralDateTimeInput } from '../../apps/web/src/sms-document-dates.js';
import type {
  Command,
  CommandLinkSource,
  CommandResponse,
  FindingRecord,
  FlightResponse,
  Principal,
  ReceiptResponse,
  SmsRecordDetailResponse,
  TimelineResponse,
} from '@ledger/contracts';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const operator = 'ledger-dev-alpha-operator';
const riskReviewer = 'ledger-dev-alpha-actor';
const source = 'ledger-dev-alpha-source';
const authorization = (token = operator) => ({ authorization: `Bearer ${token}` });
const writeHeaders = (token = operator) => ({ ...authorization(token), 'idempotency-key': randomUUID() });

async function read<T>(request: APIRequestContext, path: string, token = operator): Promise<T> {
  const response = await request.get(`${api}${path}`, { headers: authorization(token) });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function principal(request: APIRequestContext, token = operator) {
  return (await read<{ principal: Principal }>(request, '/v1/me', token)).principal;
}

async function command(request: APIRequestContext, body: Command) {
  const response = await request.post(`${api}/v1/commands`, { headers: writeHeaders(), data: body });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<CommandResponse>;
}

async function complete(request: APIRequestContext, receiptId: string) {
  await expect
    .poll(async () => (await read<ReceiptResponse>(request, `/v1/receipts/${receiptId}`)).receipt.processing.status, {
      message: 'Worker must finish the accepted command-link report',
      timeout: 20_000,
    })
    .toBe('completed');
}

/** One command-link report through the adapter and the generic intake, finished by the worker. */
async function report(request: APIRequestContext, flightId: string, sourceId: string, raw: CommandLinkSource) {
  const receipt = await reportLinkStatus(request, sourceId, flightId, raw);
  await complete(request, receipt.id);
  return receipt;
}

function commandLinkFinding(finding: FindingRecord) {
  return isLostLinkEvaluation(finding.latestEvaluation);
}

test('a finding becomes an assessed hazard with an authored accepted control and preserves its flight context', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = randomUUID();
  const sourceId = `browser-safety-${identity}`;
  const author = await principal(request);
  const reviewer = await principal(request, riskReviewer);
  const originalSource = await principal(request, source);
  const addedRiskCapability = !reviewer.capabilities.some((capability) =>
    ['risk:accept:medium', 'risk:accept:high'].includes(capability),
  );
  let sourceGranted = false;
  let riskGranted = false;

  try {
    await command(request, linkStatusGrant(originalSource, sourceId));
    sourceGranted = true;
    if (addedRiskCapability) {
      await command(request, {
        kind: 'authority.update',
        principalId: reviewer.id,
        expectedRevision: reviewer.revision,
        capabilities: [...reviewer.capabilities, 'risk:accept:medium'],
      });
      riskGranted = true;
    }

    const created = await request.post(`${api}/v1/flights`, {
      headers: writeHeaders(),
      data: {
        originationKey: `browser:safety:${identity}`,
        label: `Safety review ${identity.slice(0, 6)}`,
        aircraft: 'Browser safety aircraft',
        scheduledStart: new Date(Date.now() - 5 * 60_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { flight } = (await created.json()) as FlightResponse;
    const occurredAt = Date.now() - 2 * 60_000;
    const lost: CommandLinkSource = {
      sourceSessionId: `browser-safety-session-${identity}`,
      sourceEventId: `lost-${identity}`,
      incidentId: `browser-safety-incident-${identity}`,
      aircraftId: flight.aircraft!,
      occurredAt: new Date(occurredAt).toISOString(),
      status: 'lost',
    };
    const receipt = await report(request, flight.id, sourceId, lost);
    const timeline = () => read<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`);
    await expect
      .poll(async () => {
        const shown = await timeline();
        return {
          finding: shown.findings?.some(commandLinkFinding),
          outstandingWork: shown.flight.outstandingWork,
        };
      })
      .toEqual({ finding: true, outstandingWork: 0 });
    const origin = (await timeline()).findings!.find(commandLinkFinding)!;

    const selectedFlight = page.getByTestId(`flight-row-${flight.id}`);
    const selectedRecord = page.getByTestId(`timeline-item-${receipt.eventId}`);
    const finding = page.getByTestId('finding-detail');
    const exactEvidenceReads: string[] = [];
    const limitedTimelineRoute = (url: URL) => url.pathname === `/v1/flights/${flight.id}/timeline`;
    const limitTimeline = async (route: Route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get('selectedItemId');
      if (target) exactEvidenceReads.push(target);
      url.searchParams.set('limit', '1');
      await route.fulfill({ response: await route.fetch({ url: url.href }) });
    };
    await page.route(limitedTimelineRoute, limitTimeline);
    try {
      await page.goto('/');
      await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
      await page.getByRole('button', { name: 'Open operations' }).click();
      await selectedFlight.click();
      await expect(selectedFlight).toHaveAttribute('aria-pressed', 'true');
      await expect(finding).toContainText(origin.latestEvaluation.title);
      await expect(selectedRecord).toHaveCount(0);
      const planLane = page.getByRole('group', { name: 'Show lane' }).getByRole('button', { name: /^Plan\b/ });
      await planLane.click();
      await finding.getByRole('button', { name: 'Take responsibility', exact: true }).click();
      const treatment = finding.getByTestId('finding-treatment-form');
      const note = 'Retain this ownership draft while I inspect the exact source of the reported interruption.';
      await treatment.getByLabel('What you will check', { exact: true }).fill(note);
      const trigger = finding.getByRole('button', { name: 'Show triggering evidence', exact: true });
      await trigger.focus();
      await trigger.press('Enter');
      await expect(selectedRecord).toBeVisible();
      await expect(selectedRecord).toHaveAttribute('aria-pressed', 'true');
      await expect(selectedRecord.locator('xpath=ancestor::*[@data-anchor-id][1]')).toHaveAttribute(
        'data-anomaly-kind',
        'command-link-loss',
      );
      await expect(selectedRecord).toBeFocused();
      await expect(selectedRecord).toBeInViewport();
      await selectedRecord.press('Enter');
      await expect(selectedRecord).toBeVisible();
      await expect(planLane).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page.getByText('Showing selected Flight evidence outside the Plan filter.', { exact: true }),
      ).toBeVisible();
      await expect(treatment.getByLabel('What you will check', { exact: true })).toHaveValue(note);
      expect(exactEvidenceReads).toContain(receipt.eventId);
      await page.screenshot({ path: testInfo.outputPath('c2-triggering-evidence-desktop.png') });

      const learnedOrder = page.getByRole('button', { name: 'When we learned it', exact: true });
      await learnedOrder.click();
      await trigger.click();
      await expect(selectedRecord).toBeFocused();
      await expect(learnedOrder).toHaveAttribute('aria-pressed', 'true');
      await expect(planLane).toHaveAttribute('aria-pressed', 'true');
      await expect(treatment.getByLabel('What you will check', { exact: true })).toHaveValue(note);
      await page.getByRole('button', { name: 'Show only Plan', exact: true }).click();
      await expect(selectedRecord).toBeHidden();
      await expect(planLane).toHaveAttribute('aria-pressed', 'true');
      await page.setViewportSize({ width: 390, height: 844 });
      await trigger.click();
      await expect(selectedRecord).toBeFocused();
      await expect(selectedRecord).toBeInViewport();
      await expect
        .poll(() =>
          selectedRecord.evaluate((button) => {
            const header = button.closest('.record-timeline')?.querySelector('.timeline-lanes');
            return button.getBoundingClientRect().top - (header?.getBoundingClientRect().bottom ?? 0);
          }),
        )
        .toBeGreaterThanOrEqual(0);
      await expect(treatment.getByLabel('What you will check', { exact: true })).toHaveValue(note);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('c2-triggering-evidence-phone.png') });
      await treatment.getByRole('button', { name: 'Close finding action', exact: true }).click();
      await page
        .getByRole('group', { name: 'Show lane' })
        .getByRole('button', { name: /^All\b/ })
        .click();
    } finally {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.unroute(limitedTimelineRoute, limitTimeline);
    }
    await page.screenshot({ path: testInfo.outputPath('safety-origin-flight.png') });
    await finding.getByRole('button', { name: 'Open safety workspace', exact: true }).click();

    // The finding is promoted to a hazard on the safety record, the one register the safety program uses.
    const opening = page.getByRole('form', { name: 'Open a hazard from this finding', exact: true });
    await expect(page.getByTestId('finding-hazard')).toContainText(flight.label);
    const title = `Command-link risk ${identity.slice(0, 6)}`;
    const narrative = 'Review the reported interruption at Canal Market and retain its original finding.';
    await opening.getByLabel('Hazard', { exact: true }).fill(title);
    await opening.getByLabel('What could go wrong, and where').fill(narrative);
    await opening.getByLabel('Worst credible outcome').fill('Uncontrolled descent over the fictional market.');
    const openedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.kind === 'sms.record.open',
    );
    await opening.getByRole('button', { name: 'Open hazard', exact: true }).click();
    const opened = await openedResponse;
    expect(opened.status(), await opened.text()).toBe(201);
    const { command: openedCommand } = (await opened.json()) as CommandResponse;
    const hazardId = openedCommand.subject!.id;
    const detail = () => read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
    expect((await detail()).origin).toMatchObject({
      kind: 'finding',
      findingId: origin.id,
      evaluationId: origin.latestEvaluation.id,
      subject: { kind: 'flight', id: flight.id },
    });
    const record = page.getByTestId('sms-record');
    await expect(record.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(record.getByTestId('hazard-origin')).toContainText(`Return to ${flight.label}`);

    // The register lists it newest first, with its origin.
    await page
      .locator('.sms-nav-links')
      .getByRole('button', { name: /^Hazard register/ })
      .click();
    const row = page.getByTestId(`sms-row-${hazardId}`);
    await expect(row).toContainText('From a finding');
    await row.click();

    await page.getByRole('button', { name: 'Propose a control', exact: true }).click();
    const proposal = page.getByRole('form', { name: 'Propose a control', exact: true });
    await proposal.getByLabel('Control type').selectOption({ label: 'Route avoidance area' });
    const controlLabel = 'Canal Market avoidance circle';
    await proposal.getByLabel('Control', { exact: true }).fill(controlLabel);
    const occurrenceMap = proposal.getByTestId('hazard-control-map');
    await expect(occurrenceMap).toContainText('Location remains unknown.');
    await expect(occurrenceMap.getByRole('button', { name: 'Use this evidence location', exact: true })).toHaveCount(0);
    await occurrenceMap.getByRole('combobox', { name: /^View an operating site/ }).selectOption('Canal Market');
    const map = occurrenceMap.getByTestId('avoidance-editor-map');
    const mapCanvas = map.getByRole('group', {
      name: 'Hazard evidence positions, historical observed track and mission corridor',
      exact: true,
    });
    await occurrenceMap.getByLabel('Proposed radius (m)', { exact: true }).fill('100');
    await map.getByRole('button', { name: 'Place center', exact: true }).click();
    const emptyBounds = await mapCanvas.boundingBox();
    expect(emptyBounds).not.toBeNull();
    await mapCanvas.click({ position: { x: emptyBounds!.width * 0.6, y: emptyBounds!.height * 0.55 } });
    const latitude = proposal.getByLabel('Centre latitude', { exact: true });
    const longitude = proposal.getByLabel('Centre longitude', { exact: true });
    expect(Number.isFinite(Number(await latitude.inputValue()))).toBe(true);
    await expect(map.getByTestId('control-center-handle')).toBeVisible();

    // A restoration report with a position arrives; the finding is evaluated again and the map shows the position.
    const restoredReceipt = await report(request, flight.id, sourceId, {
      ...lost,
      sourceEventId: `restored-${identity}`,
      occurredAt: new Date(occurredAt + 60_000).toISOString(),
      status: 'restored',
      position: { latitude: 41.8873, longitude: -87.6398 },
    });
    const directLocation = occurrenceMap
      .locator('.occurrence-location')
      .filter({ hasText: 'Position in the cited source report' });
    await expect(directLocation).toContainText('At the occurrence time', { timeout: 30_000 });
    await expect(directLocation.locator('pre')).toContainText(restoredReceipt.id);
    await directLocation.getByRole('button', { name: 'Use this evidence location', exact: true }).click();
    await expect(latitude).toHaveValue('41.8873');
    await expect(longitude).toHaveValue('-87.6398');
    await map.screenshot({ path: testInfo.outputPath('safety-map-proposal-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await occurrenceMap.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await occurrenceMap.screenshot({ path: testInfo.outputPath('safety-map-proposal-390.png') });
    await page.setViewportSize({ width: 1440, height: 960 });
    // A short interval, as before, so this area does not reach other tests' routes.
    await proposal
      .getByLabel('Until (CT, optional)')
      .fill(centralDateTimeInput(new Date(Date.now() + 2 * 60_000).toISOString()).slice(0, 16));
    await proposal.getByRole('button', { name: 'Propose control', exact: true }).click();
    const controls = record.getByTestId('sms-hazard-controls');
    await expect(controls).toContainText(controlLabel);
    await expect(controls).toContainText('41.8873, -87.6398');

    await page.getByRole('button', { name: 'Assess risk', exact: true }).click();
    const assessment = page.getByRole('form', { name: 'Assess risk', exact: true });
    await assessment.getByLabel('Severity').nth(0).selectOption('hazardous');
    await assessment.getByLabel('Likelihood').nth(0).selectOption('probable');
    await assessment.getByLabel('Severity').nth(1).selectOption('major');
    await assessment.getByLabel('Likelihood').nth(1).selectOption('remote');
    await assessment.getByLabel('We checked and found none').check();
    const assessmentRationale = 'A major consequence is possible; the avoidance area keeps later routes clear.';
    await assessment.getByLabel('Basis for this assessment').fill(assessmentRationale);
    await assessment.getByRole('button', { name: 'Record assessment', exact: true }).click();
    await expect(record.getByText('Medium residual risk')).toBeVisible();
    await expect(page.getByTestId('accept-unavailable')).toBeVisible();
    const assessed = (await detail()).decisions.find((decision) => decision.kind === 'risk.assess')!;
    expect(assessed).toMatchObject({ note: assessmentRationale, actor: { principalId: author.id } });
    await page.screenshot({ path: testInfo.outputPath('safety-assessment.png') });

    // The way back leads to the flight as it was left.
    await page
      .getByRole('button', { name: `Return to ${flight.label}`, exact: true })
      .first()
      .click();
    await expect(selectedFlight).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('finding-detail')).toContainText(origin.latestEvaluation.title);

    // A person granted medium risk acceptance reaches the same record from the same finding and signs.
    await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('actor');
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await expect(page.locator('.topbar-user')).toContainText(reviewer.name);
    await selectedFlight.click();
    await finding.getByRole('button', { name: 'Open safety workspace', exact: true }).click();
    await expect(record.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(record.getByTestId('sms-hazard-controls')).toContainText(controlLabel);
    await page.getByRole('button', { name: 'Review and sign acceptance', exact: true }).click();
    const sign = page.getByRole('form', { name: 'Sign', exact: true });
    await sign.getByLabel('I have reviewed the content and the intent statement.').check();
    const acceptanceRationale = 'Accept the assessed risk with this exact avoidance area.';
    await sign.getByLabel('Rationale for accepting').fill(acceptanceRationale);
    await sign.getByLabel('Fixture credential').fill(riskReviewer);
    await sign.getByRole('button', { name: 'Confirm it’s you' }).click();
    await expect(sign).toContainText('Confirmed. Sign within five minutes');
    await sign.getByRole('button', { name: 'Sign and accept risk' }).click();
    await expect(record.getByText('Risk accepted', { exact: true })).toBeVisible();
    const accepted = await detail();
    expect(accepted.decisions.find((decision) => decision.kind === 'risk.accept')).toMatchObject({
      note: acceptanceRationale,
      actor: { principalId: reviewer.id },
    });
    await expect(record.getByTestId('sms-hazard-controls')).toContainText('Accepted with the risk');
    await page.screenshot({ path: testInfo.outputPath('safety-accepted-control.png') });

    // Its control opens on its own page, with the control's windows for monitoring.
    await record.getByTestId('sms-hazard-controls').getByRole('button', { name: controlLabel }).click();
    await expect(page.getByTestId('control-indicators')).toBeVisible();
  } finally {
    try {
      if (sourceGranted) {
        const current = await principal(request, source);
        await command(request, linkStatusRevocation(current, sourceId));
      }
    } finally {
      if (riskGranted) {
        const current = await principal(request, riskReviewer);
        await command(request, {
          kind: 'authority.update',
          principalId: current.id,
          expectedRevision: current.revision,
          capabilities: current.capabilities.filter((capability) => capability !== 'risk:accept:medium'),
        });
      }
    }
  }
});

test('conflicting landing reports retain source context through guided correction and explicit finding resolution', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const identity = randomUUID();
  const author = await principal(request);
  const created = await request.post(`${api}/v1/flights`, {
    headers: writeHeaders(),
    data: {
      originationKey: `browser:landing-safety:${identity}`,
      label: `Landing safety review ${identity.slice(0, 6)}`,
      aircraft: 'Landing review aircraft',
      scheduledStart: new Date(Date.now() - 10 * 60_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { flight } = (await created.json()) as FlightResponse;
  const timeline = () => read<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`);
  await expect.poll(async () => (await timeline()).flight.outstandingWork).toBe(0);
  const firstLanding = new Date(Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000).toISOString();
  const secondLanding = new Date(Date.parse(firstLanding) + 30_000).toISOString();
  const reportRecordedAt = new Date(Date.parse(secondLanding) + 2 * 60_000).toISOString();
  const reportNote = 'Ground handset clock was 30 seconds fast; report queued until the connection returned.';

  async function landingReport(sourceId: string, title: string, landingTime: string) {
    const options = {
      headers: writeHeaders(source),
      data: {
        sourceId,
        kind: 'flight.observation',
        occurredAt: landingTime,
        subject: { flightId: flight.id },
        payload: {
          title,
          activity: 'landed',
          landingTime,
          ...(sourceId === 'postflight-log' ? { personName: 'Morgan Lee', reportRecordedAt, note: reportNote } : {}),
        },
      },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request.post(`${api}/v1/inputs`, options);
      if (
        attempt < 2 &&
        response.status() === 409 &&
        ((await response.json()) as { error?: { code?: string } }).error?.code === 'concurrent_change'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      expect(response.status(), await response.text()).toBe(201);
      const { receipt } = (await response.json()) as ReceiptResponse;
      await complete(request, receipt.id);
      return receipt;
    }
    throw new Error('The landing report did not finish its bounded intake attempt');
  }

  const aircraft = await landingReport('aircraft-live', 'Aircraft landing report', firstLanding);
  const postflight = await landingReport('postflight-log', 'Post-flight landing report', secondLanding);
  const landingFinding = (record: FindingRecord) =>
    record.latestEvaluation.leafId === 'ledger.demo.landing-disagreement';
  await expect
    .poll(async () => {
      const current = await timeline();
      return {
        outcome: current.findings?.find(landingFinding)?.latestEvaluation.outcome,
        outstandingWork: current.flight.outstandingWork,
      };
    })
    .toEqual({ outcome: 'attention', outstandingWork: 0 });
  const origin = (await timeline()).findings!.find(landingFinding)!;
  expect(origin.latestEvaluation).toMatchObject({
    leafVersion: 2,
    bindingId: 'ledger.demo-procedures',
    bindingVersion: 6,
    evidenceState: 'conflicting',
  });
  expect(origin.latestEvaluation.explanation.evidence.map((evidence) => evidence.eventId).sort()).toEqual(
    [aircraft.eventId, postflight.eventId].sort(),
  );

  const displayedTime = (value: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  async function expectLandingReports(container: Locator) {
    const reports = container.getByTestId('landing-reports');
    await expect(reports.getByRole('heading', { name: 'Reported landing times', exact: true })).toBeVisible();
    const aircraftReport = reports.locator('[data-testid="landing-report"][data-source-id="aircraft-live"]');
    const postflightReport = reports.locator('[data-testid="landing-report"][data-source-id="postflight-log"]');
    await expect(aircraftReport).toContainText('Aircraft live feed');
    await expect(aircraftReport).toContainText(displayedTime(firstLanding));
    await expect(postflightReport).toContainText('Post-flight log');
    await expect(postflightReport).toContainText(displayedTime(secondLanding));
  }

  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations', exact: true }).click();
  await page.getByRole('button', { name: 'Historical issues', exact: true }).click();
  await page.getByTestId(`flight-row-${flight.id}`).click();
  const finding = page.getByTestId('finding-detail');
  await expect(finding.getByRole('heading', { name: 'Landing time disagreement', exact: true })).toBeVisible();
  await page.getByTestId(`timeline-item-${origin.latestEvaluation.id}`).click();
  const actions = page.locator('.actions-card');
  await expect(actions.getByRole('button', { name: 'Append correction', exact: true })).toBeDisabled();
  await expect(actions).toContainText(/source report/i);
  await actions.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('landing-generated-check-guard.png') });
  await finding.getByRole('button', { name: 'Take responsibility', exact: true }).click();
  let treatment = finding.getByTestId('finding-treatment-form');
  await treatment
    .getByLabel('What you will check', { exact: true })
    .fill('I will compare both retained landing reports.');
  await treatment.getByRole('button', { name: 'Take responsibility', exact: true }).click();
  await expect(finding).toContainText(`${author.name} owns this finding`);
  await finding.getByRole('button', { name: 'Reconcile landing reports', exact: true }).click();
  const reconciliation = finding.getByTestId('landing-reconciliation');
  const aircraftClaim = reconciliation.locator('[data-testid="reconciliation-report"][data-source-id="aircraft-live"]');
  const postflightClaim = reconciliation.locator(
    '[data-testid="reconciliation-report"][data-source-id="postflight-log"]',
  );
  await expect(reconciliation.getByTestId('reconciliation-report')).toHaveCount(2);
  await expect(aircraftClaim).toContainText('Aircraft live feed');
  await expect(aircraftClaim).toContainText(displayedTime(firstLanding));
  await expect(postflightClaim).toContainText('Post-flight log');
  await expect(postflightClaim).toContainText(displayedTime(secondLanding));
  await expect(postflightClaim).toContainText('Morgan Lee');
  await expect(postflightClaim).toContainText(displayedTime(reportRecordedAt));
  await expect(postflightClaim).toContainText(reportNote);
  await postflightClaim.getByRole('button', { name: 'Review source report', exact: true }).click();
  await expect(page.getByTestId('receipt-inspector')).toContainText(postflight.id);
  await expect(page.getByTestId(`timeline-item-${postflight.eventId}`)).toHaveAttribute('aria-pressed', 'true');
  await reconciliation
    .getByRole('heading', { name: 'Reconcile landing reports', exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'auto' }));
  await page.screenshot({ path: testInfo.outputPath('landing-reconciliation-comparison-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await reconciliation
    .getByRole('heading', { name: 'Reconcile landing reports', exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'auto' }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('landing-reconciliation-comparison-390.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await postflightClaim.getByRole('button', { name: 'Correct this report', exact: true }).click();
  const correction = reconciliation.getByTestId('landing-correction-form');
  const confirmedTime = correction.locator(`input[type="radio"][value="${firstLanding}"]`);
  const correctionReason = correction.getByLabel('What confirms this correction?', { exact: true });
  const appendCorrection = correction.getByRole('button', { name: 'Append landing correction', exact: true });
  await expect(appendCorrection).toBeDisabled();
  await confirmedTime.check();
  await expect(appendCorrection).toBeDisabled();
  const correctionNote =
    'I checked the aircraft controller touchdown log and confirmed that the ground handset entry was 30 seconds fast.';
  await correctionReason.fill(correctionNote);
  await expect(appendCorrection).toBeEnabled();
  await correction.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('landing-reconciliation-authored-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await appendCorrection.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await correction.screenshot({ path: testInfo.outputPath('landing-reconciliation-authored-390.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await finding.getByRole('button', { name: 'Open safety workspace', exact: true }).click();

  // The finding lands on the safety record's promotion form, with the reports it compares.
  await expectLandingReports(page.getByTestId('finding-hazard').locator('.safety-origin'));
  const title = `Landing report risk ${identity.slice(0, 6)}`;
  const narrative =
    'Assess the operational risk revealed by the aircraft and post-flight reports disagreeing by 30 seconds.';
  const opening = page.getByRole('form', { name: 'Open a hazard from this finding', exact: true });
  await opening.getByLabel('Hazard', { exact: true }).fill(title);
  await opening.getByLabel('What could go wrong, and where').fill(narrative);
  await opening.getByLabel('Worst credible outcome').fill('A flight record that misstates when the aircraft landed.');
  await page.screenshot({ path: testInfo.outputPath('landing-hazard-opening-desktop.png') });
  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/commands') &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.kind === 'sms.record.open',
  );
  await opening.getByRole('button', { name: 'Open hazard', exact: true }).click();
  const opened = await openedResponse;
  expect(opened.status(), await opened.text()).toBe(201);
  const { command: openedCommand } = (await opened.json()) as CommandResponse;
  const hazardId = openedCommand.subject!.id;
  const detail = () => read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
  const originalOrigin = (await detail()).origin;
  expect(originalOrigin).toMatchObject({
    kind: 'finding',
    findingId: origin.id,
    evaluationId: origin.latestEvaluation.id,
    subject: { kind: 'flight', id: flight.id },
  });

  const hazard = page.getByTestId('sms-record');
  await expect(hazard).toContainText(`Owner ${author.name}`);
  await expectLandingReports(hazard.getByTestId('hazard-origin'));
  await page.getByRole('button', { name: 'Assess risk', exact: true }).click();
  const assessment = page.getByRole('form', { name: 'Assess risk', exact: true });
  const assessmentNote =
    'Both original reports are retained. Review the conflicting touchdown time before closing the flight finding.';
  await assessment.getByLabel('Severity').nth(0).selectOption('minor');
  await assessment.getByLabel('Likelihood').nth(0).selectOption('remote');
  await assessment.getByLabel('Severity').nth(1).selectOption('minor');
  await assessment.getByLabel('Likelihood').nth(1).selectOption('remote');
  await assessment.getByLabel('We checked and found none').check();
  await assessment.getByLabel('Basis for this assessment').fill(assessmentNote);
  await assessment.getByRole('button', { name: 'Record assessment', exact: true }).click();
  await expect
    .poll(async () => (await detail()).decisions.find((decision) => decision.kind === 'risk.assess')?.note)
    .toBe(assessmentNote);
  const assessed = (await detail()).decisions.find((decision) => decision.kind === 'risk.assess')!;
  expect(assessed).toMatchObject({ actor: { principalId: author.id } });
  await expect(hazard).toContainText(assessmentNote);
  await expect(page.getByRole('button', { name: /Issue selected packet/ })).toHaveCount(0);
  const returnToResponse = hazard
    .getByTestId('hazard-origin')
    .getByRole('button', { name: `Return to ${flight.label}` });
  await expect(returnToResponse).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('landing-hazard-assessed-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await returnToResponse.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('landing-hazard-next-step-mobile.png') });
  await returnToResponse.click();
  await expect(hazard).toBeHidden();
  await expect(finding).toContainText(`${author.name} owns this finding`);
  await expect(confirmedTime).toBeChecked();
  await expect(correctionReason).toHaveValue(correctionNote);
  await finding.getByRole('button', { name: 'Record response', exact: true }).click();
  treatment = finding.getByTestId('finding-treatment-form');
  const responseNote =
    'I compared the two reports and will correct the post-flight time to the verified aircraft touchdown.';
  await treatment.getByLabel('Response and reason', { exact: true }).fill(responseNote);
  await page.screenshot({ path: testInfo.outputPath('landing-flight-response-mobile.png') });
  await treatment.getByRole('button', { name: 'Record response', exact: true }).click();
  await expect
    .poll(async () => (await timeline()).findings!.find((record) => record.id === origin.id)!.treatments.at(-1)?.note)
    .toBe(responseNote);
  await expect.poll(async () => (await timeline()).flight.outstandingWork).toBe(0);
  await expect(finding.getByRole('button', { name: 'Close the finding', exact: true })).toBeEnabled();

  await page.setViewportSize({ width: 1440, height: 960 });
  const respondedTimeline = await timeline();
  const responseTreatment = respondedTimeline
    .findings!.find((record) => record.id === origin.id)!
    .treatments.find((record) => record.action === 'respond' && record.note === responseNote)!;
  const responseItem = respondedTimeline.items.find((item) => item.id === responseTreatment.id)!;
  expect(responseItem).toMatchObject({
    kind: 'decision.record',
    payload: {
      decision: { kind: 'finding.respond', note: responseNote },
      findingTreatment: { findingId: origin.id, action: 'respond' },
      acceptedFindingBasis: {
        leafId: 'ledger.demo.landing-disagreement',
        leafVersion: 2,
        bindingId: 'ledger.demo-procedures',
        bindingVersion: 6,
      },
    },
  });
  const responseRecord = page.getByTestId(`timeline-item-${responseItem.id}`);
  await responseRecord.click();
  await expect(responseRecord).toHaveAttribute('aria-pressed', 'true');
  const inspector = page.getByTestId('receipt-inspector');
  await expect(inspector).toContainText(responseNote);
  await expect(inspector.getByRole('region', { name: 'Selected C2 decision packet', exact: true })).toHaveCount(0);
  await expect(inspector.getByTestId('decision-packet')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Issue selected packet', exact: true })).toHaveCount(0);
  await expect(appendCorrection).toBeDisabled();
  await expect(confirmedTime).toBeChecked();
  await expect(correctionReason).toHaveValue(correctionNote);
  await correction.getByRole('button', { name: 'Refresh basis', exact: true }).click();
  await expect(confirmedTime).toBeChecked();
  await expect(correctionReason).toHaveValue(correctionNote);
  await expect(appendCorrection).toBeEnabled();
  const correctionAttempts: { body: string | null; key: string | undefined }[] = [];
  let acceptedCorrection: CommandResponse | undefined;
  const loseFirstCorrectionReply = async (route: Route) => {
    const sent = route.request();
    if (sent.method() !== 'POST' || sent.postDataJSON()?.kind !== 'evidence.correct') return route.continue();
    correctionAttempts.push({ body: sent.postData(), key: sent.headers()['idempotency-key'] });
    if (correctionAttempts.length === 1) {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      acceptedCorrection = (await response.json()) as CommandResponse;
      await route.abort('failed');
    } else await route.continue();
  };
  await page.route('**/v1/commands', loseFirstCorrectionReply);
  try {
    await appendCorrection.click();
    const retry = reconciliation.getByRole('button', { name: 'Retry original correction', exact: true });
    await expect(retry).toBeVisible();
    expect(acceptedCorrection).toBeDefined();
    expect(correctionAttempts).toHaveLength(1);
    expect(correctionAttempts[0]!.key).toBeTruthy();
    expect(JSON.parse(correctionAttempts[0]!.body!)).toMatchObject({
      kind: 'evidence.correct',
      flightId: flight.id,
      correctionOf: postflight.eventId,
      occurredAt: postflight.occurredAt,
      note: correctionNote,
      payload: { ...postflight.payload, landingTime: firstLanding },
    });
    await expect(confirmedTime).toBeDisabled();
    await expect(correctionReason).toBeDisabled();
    await expect(appendCorrection).toBeDisabled();
    await page.getByRole('button', { name: 'Current', exact: true }).click();
    await expect(reconciliation).toBeHidden();
    await page.getByRole('button', { name: 'Historical issues', exact: true }).click();
    await page.getByTestId(`flight-row-${flight.id}`).click();
    await expect(retry).toBeVisible();
    await expect(confirmedTime).toBeChecked();
    await expect(correctionReason).toHaveValue(correctionNote);
    const recovered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.kind === 'evidence.correct',
    );
    await retry.click();
    const response = await recovered;
    expect(response.status(), await response.text()).toBe(201);
    expect(((await response.json()) as CommandResponse).command).toEqual(acceptedCorrection!.command);
    expect(correctionAttempts).toHaveLength(2);
    expect(correctionAttempts[1]).toEqual(correctionAttempts[0]);
  } finally {
    await page.unroute('**/v1/commands', loseFirstCorrectionReply);
  }
  await expect(finding).toContainText('The latest result is supported by the record; a person closes this finding.');
  const correctionResult = reconciliation.locator('.landing-correction-result');
  await expect(correctionResult).toContainText('Touchdown claim corrected to');
  await expect(correctionResult).toContainText(`${displayedTime(firstLanding)} CT`);
  await expect(correctionResult).toContainText(`Recorded by ${author.name}`);
  await expect(correctionResult).toContainText(
    'The evidence check cleared. The finding remains open until its owner closes it.',
  );
  await expect(
    reconciliation.getByRole('heading', { name: 'Reports reviewed before this correction', exact: true }),
  ).toBeVisible();
  await expect(postflightClaim).toContainText('Claim before correction');
  await expect(postflightClaim).toContainText(displayedTime(secondLanding));
  await expect(correctionResult.getByRole('button', { name: 'Show recorded correction', exact: true })).toBeEnabled();
  expect((await timeline()).findings!.find((record) => record.id === origin.id)!.status).toBe('responding');
  expect((await read<ReceiptResponse>(request, `/v1/receipts/${aircraft.id}`)).receipt.payload).toEqual(
    aircraft.payload,
  );
  expect((await read<ReceiptResponse>(request, `/v1/receipts/${postflight.id}`)).receipt.payload).toEqual(
    postflight.payload,
  );
  await correctionResult.evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'auto' }));
  await page.screenshot({ path: testInfo.outputPath('landing-reconciliation-evidence-cleared.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await correctionResult.evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'auto' }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('landing-reconciliation-evidence-cleared-390.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  // A corrected flight report clears the check, but a report is not a record people keep: the owner closes it.
  await expect(finding.getByTestId('finding-closure')).toHaveCount(0);
  await finding.getByRole('button', { name: 'Close the finding', exact: true }).click();
  treatment = finding.getByTestId('finding-treatment-form');
  await treatment.getByLabel('Corrected by a new record', { exact: true }).check();
  await treatment
    .getByLabel('Why it is closed', { exact: true })
    .fill('The reported times now agree after the retained correction; the hazard assessment remains on record.');
  await treatment.getByRole('button', { name: 'Close the finding', exact: true }).click();
  // The state badge, and the treatment history's own "Closed" entry, both say it.
  await expect(finding.getByText('Closed', { exact: true }).first()).toBeVisible();
  await expect(finding.getByTestId('finding-closure')).toContainText('Closed by');
  await expect(correctionResult).toContainText('The finding is closed.');
  await expect(correctionResult).not.toContainText('The finding remains open');
  await finding
    .getByRole('heading', { name: 'Landing time disagreement', exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'auto' }));
  await page.screenshot({ path: testInfo.outputPath('landing-reconciliation-resolved.png') });
  const finalTimeline = await timeline();
  const resolved = finalTimeline.findings!.find((record) => record.id === origin.id)!;
  expect(resolved.status).toBe('resolved');
  expect(resolved.initialEvaluation).toEqual(origin.initialEvaluation);
  expect(resolved.treatments.map((record) => record.action)).toEqual(['acknowledge', 'respond', 'close']);
  expect(resolved.closure).toMatchObject({ by: 'person', reason: 'corrected_by_record' });
  expect(finalTimeline.items.find((item) => item.id === postflight.eventId)?.payload.landingTime).toBe(secondLanding);
  expect(finalTimeline.items.find((item) => item.kind === 'evidence.correct')).toMatchObject({
    correctionOf: postflight.eventId,
    payload: { landingTime: firstLanding },
  });
  await page.getByRole('button', { name: 'Hazards', exact: true }).click();
  await page.getByTestId(`sms-row-${hazardId}`).click();
  await expectLandingReports(hazard.getByTestId('hazard-origin'));
  const retained = await detail();
  expect(retained.origin).toEqual(originalOrigin);
  expect(retained.decisions.filter((decision) => decision.kind === 'risk.assess')).toEqual([assessed]);
  expect(retained.decisions.some((decision) => decision.kind === 'risk.accept')).toBe(false);
});
