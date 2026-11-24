import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { LedgerClient } from '../../packages/contracts/src/client.js';
import type { TelemetryResponse, TelemetrySegment, TimelineResponse } from '../../packages/contracts/src/index.js';
import { djiOsdBytes } from '../../apps/emulators/src/dji.js';
import { decodeDjiOsd } from '../../packages/adapters/src/dji-osd.js';

const api = (process.env.LEDGER_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const operator = 'ledger-dev-alpha-operator',
  sourceToken = 'ledger-dev-alpha-source';
const headers = { authorization: `Bearer ${operator}` };
const source = new LedgerClient(api, sourceToken),
  client = new LedgerClient(api, operator);

async function fixture() {
  const key = randomUUID();
  const { flight } = await client.createFlight(
    {
      originationKey: `browser:telemetry:${key}`,
      label: `Telemetry browser ${key.slice(0, 6)}`,
      aircraft: `DJI-browser-telemetry-${key}-alpha-01`,
      scheduledStart: new Date(Date.now() - 180000).toISOString(),
      scheduledEnd: new Date(Date.now() + 600000).toISOString(),
    },
    key,
  );
  return {
    flight,
    session: `browser-session-${key}`,
    device: `browser-device-${key}`,
    gateway: `browser-gateway-${key}`,
    sourceId: `browser-dji-${key}`,
    base: Date.now() - 120000,
    horizontalSpeed: 11.99995664453861,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function segment(
  context: Fixture,
  sequences: number[],
  longitudeOffset = 0,
  sourceTicks: Record<number, number> = {},
) {
  const samples = sequences.map((sequence) => {
    const tick = sourceTicks[sequence] ?? sequence;
    const point = {
      occurredAt: new Date(context.base + tick * 1000).toISOString(),
      latitude: 38.89 + tick * 0.00001,
      longitude: -77.03 + tick * 0.000025 + longitudeOffset,
      horizontalSpeed: context.horizontalSpeed,
      ...(sequence === 40 ? {} : { height: 150 + tick }),
    };
    return decodeDjiOsd(
      `thing/product/${context.device}/osd`,
      djiOsdBytes(point, context.gateway),
      { deviceId: context.device, gatewayId: context.gateway },
      sequence,
    );
  });
  const body: TelemetrySegment = {
    format: 'ledger.telemetry-segment.1',
    sourceId: context.sourceId,
    sourceSessionId: context.session,
    deviceId: context.device,
    gatewayId: context.gateway,
    decoderVersion: 'dji-osd.synthetic.1',
    fidelity: 'synthetic_contract',
    coordinateReference: 'WGS84',
    sequenceBasis: 'adapter_capture',
    sessionStartSequence: 1,
    samples,
  };
  const { artifact } = await source.upload(
    new TextEncoder().encode(JSON.stringify(body)),
    'application/json',
    randomUUID(),
  );
  const times = samples.map((sample) => sample.occurredAt).sort();
  const { receipt } = await source.input(
    {
      sourceId: body.sourceId,
      sourceSessionId: body.sourceSessionId,
      kind: 'telemetry.segment',
      occurredAt: times.at(-1)!,
      subject: { flightId: context.flight.id },
      artifactId: artifact.id,
      fidelity: 'synthetic_contract',
      payload: {
        format: body.format,
        deviceId: body.deviceId,
        gatewayId: body.gatewayId,
        decoderVersion: body.decoderVersion,
        sequenceBasis: body.sequenceBasis,
        sessionStartSequence: body.sessionStartSequence,
        sampleCount: samples.length,
        firstSequence: Math.min(...sequences),
        lastSequence: Math.max(...sequences),
        firstOccurredAt: times[0]!,
        lastOccurredAt: times.at(-1)!,
      },
    },
    randomUUID(),
  );
  return receipt;
}

async function snapshot(request: APIRequestContext, flightId: string) {
  const response = await request.get(`${api}/v1/flights/${flightId}/telemetry`, { headers });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as TelemetryResponse;
}
async function complete(request: APIRequestContext, receiptId: string) {
  await expect
    .poll(async () => (await client.receipt(receiptId)).receipt.processing.status, { timeout: 20000 })
    .toBe('completed');
}
async function openMap(page: Page, flightId: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByTestId(`flight-row-${flightId}`).click();
  await expect(page.getByTestId('timeline-scroll')).toBeVisible();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByTestId('telemetry-lens')).toBeVisible();
}

test('persisted map keeps the sample, focus, and extent through capture gaps, late and conflicting claims', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(60000);
  const context = await fixture();
  const receipt = await segment(
    context,
    Array.from({ length: 40 }, (_, index) => index + 1).filter((sequence) => sequence !== 3),
  );
  await complete(request, receipt.id);
  const before = await snapshot(request, context.flight.id);
  expect(before.samples).toHaveLength(39);
  expect(before.gaps).toHaveLength(1);
  // Rules adopted earlier in the organization evaluate the new flight after its intake completes, and each recorded
  // evaluation moves the decision basis. Decide on the record once nothing about the flight is still being processed.
  let basis!: TimelineResponse;
  await expect
    .poll(async () => (basis = (await client.timeline(context.flight.id)) as TimelineResponse).flight.outstandingWork, {
      timeout: 20000,
    })
    .toBe(0);
  const { command } = await client.command(
    {
      kind: 'decision.record',
      flightId: context.flight.id,
      expectedRevision: basis.flight.revision,
      expectedBasisRevision: basis.flight.basisRevision,
      inputCut: basis.meta.inputCut,
      expectedDependencyBasis: basis.meta.dependencyBasis!,
      decision: { kind: 'reviewed', note: 'Fictional telemetry review with the viewed capture gap retained.' },
    },
    randomUUID(),
  );
  await expect
    .poll(async () => (await client.timeline(context.flight.id)).items.some((item) => item.id === command.id), {
      timeout: 20000,
    })
    .toBe(true);
  const watchRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/flights/${context.flight.id}/watch`)) watchRequests.push(request.url());
  });
  await openMap(page, context.flight.id);
  const rosterRow = page.getByTestId(`flight-row-${context.flight.id}`);
  const rosterIdentity = rosterRow.locator('.flight-row-aircraft');
  const identityPrefix = rosterIdentity.locator('.flight-row-aircraft-prefix');
  const identitySuffix = rosterIdentity.locator('.flight-row-aircraft-suffix');
  const fullIdentity = rosterRow.locator('.flight-row-aircraft-full');
  await expect(identityPrefix).toBeVisible();
  await expect(identityPrefix).toHaveText(context.flight.aircraft!.slice(0, -17));
  await expect(identitySuffix).toBeVisible();
  await expect(identitySuffix).toHaveText(context.flight.aircraft!.slice(-17));
  await expect(rosterRow).toHaveAccessibleDescription(context.flight.aircraft!);
  expect(
    await rosterIdentity.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const prefix = element.firstElementChild!.getBoundingClientRect();
      const suffix = element.lastElementChild!.getBoundingClientRect();
      return (
        prefix.width > 0 &&
        Math.abs(prefix.top - suffix.top) < 1 &&
        Math.abs(prefix.bottom - suffix.bottom) < 1 &&
        prefix.left >= bounds.left &&
        suffix.right <= bounds.right + 1 &&
        element.scrollWidth <= element.clientWidth
      );
    }),
  ).toBe(true);
  const flightSearch = page.getByRole('searchbox', { name: 'Find flight', exact: true });
  await flightSearch.focus();
  await rosterRow.hover();
  await expect(fullIdentity).toBeVisible();
  await expect(fullIdentity).toHaveText(context.flight.aircraft!);
  await expect(flightSearch).toBeFocused();
  await flightSearch.press('Escape');
  await expect(fullIdentity).toBeHidden();
  await page.mouse.move(0, 0);
  await expect(fullIdentity).toBeHidden();
  await page.keyboard.press('Tab');
  await rosterRow.focus();
  await expect(rosterRow).toBeFocused();
  await expect(fullIdentity).toBeVisible();
  await rosterRow.press('Escape');
  await expect(fullIdentity).toBeHidden();
  await page.getByRole('button', { name: 'Map', exact: true }).focus();
  await page.mouse.move(0, 0);
  const fleet = page.getByTestId('fleet-map');
  const baseMarkerCount = await fleet.locator('.fleet-flight').count();
  const baseRouteCount = await fleet.locator('.fleet-route').count();
  const retainedPosition = fleet.locator('.fleet-flight[aria-pressed="true"] .fleet-position');
  await expect(retainedPosition).toHaveCount(0);
  await fleet.getByRole('button', { name: 'Show all positions' }).click();
  await expect(retainedPosition).toHaveCount(1);
  await fleet.getByRole('button', { name: 'Show request area' }).click();
  await expect(retainedPosition).toHaveCount(0);
  const selectedMarker = fleet.locator('.fleet-flight[aria-pressed="true"]');
  await expect(selectedMarker).toHaveCount(1);
  const markerNode = (await selectedMarker.elementHandle())!;
  const labelOverlay = fleet.locator('svg.fleet-map > .fleet-labels');
  const selectedContext = labelOverlay.locator(`.fleet-context[data-flight-id="${context.flight.id}"]`);
  await expect(labelOverlay).toHaveAttribute('aria-hidden', 'true');
  await expect(labelOverlay).toHaveCSS('pointer-events', 'none');
  expect(await labelOverlay.evaluate((element) => element === element.parentElement!.lastElementChild)).toBe(true);
  expect(await selectedContext.evaluate((element) => element === element.parentElement!.lastElementChild)).toBe(true);
  await selectedMarker.focus();
  await expect(selectedMarker).toBeFocused();
  await expect(selectedContext).toHaveClass(/is-focused/);
  for (const key of ['Enter', 'Space']) {
    await selectedMarker.press(key);
    await expect(selectedMarker).toBeFocused();
    await expect(selectedMarker).toHaveAttribute('aria-pressed', 'true');
    expect(await selectedMarker.evaluate((element, original) => element === original, markerNode)).toBe(true);
  }
  const selectedGlyph = selectedMarker.locator('.fleet-place');
  await selectedGlyph.scrollIntoViewIfNeeded();
  const hoverPoint = await selectedGlyph.evaluate((glyph) => {
    const bounds = glyph.getBoundingClientRect();
    for (let y = Math.ceil(bounds.top); y < bounds.bottom; y++) {
      for (let x = Math.ceil(bounds.left); x < bounds.right; x++) {
        if (document.elementFromPoint(x, y) === glyph) return { x, y };
      }
    }
    return null;
  });
  expect(hoverPoint, 'The selected marker must expose a native pointer hit area').not.toBeNull();
  await page.mouse.move(hoverPoint!.x, hoverPoint!.y);
  expect(await selectedMarker.evaluate((element) => element.matches(':hover'))).toBe(true);
  await expect(selectedContext.locator('.fleet-context-title')).toBeVisible();
  await expect(selectedContext.locator('.fleet-aircraft')).toContainText('DJI-browser-telemetry-');
  await expect(selectedContext.locator('.fleet-aircraft')).toContainText(context.flight.aircraft!.slice(-15));
  await expect(selectedContext).toHaveCSS('pointer-events', 'none');
  await expect(fleet.locator('.fleet-flight')).toHaveCount(baseMarkerCount);
  await expect(fleet.locator('.fleet-route')).toHaveCount(baseRouteCount);
  await markerNode.dispose();
  const map = page.getByTestId('telemetry-coordinate-map');
  const lens = page.getByTestId('telemetry-lens');
  await expect(map).toBeVisible();
  await expect(map.locator('.telemetry-point')).toHaveCount(39);
  await expect(map.locator('.telemetry-track')).toHaveCount(37);
  await expect(lens.locator('.telemetry-summary')).toContainText(/0\s*received out of order/);
  await expect(map).toHaveAttribute('aria-label', /WGS84/);
  await expect(page.getByTestId('telemetry-sample-inspector')).toContainText('Datum unknown');
  await expect(page.getByTestId('decision-basis')).toContainText('Fictional telemetry review');
  const chosen = before.samples.find((sample) => sample.sequence === 10)!;
  expect(chosen.speedMetersPerSecond).toBe(context.horizontalSpeed);
  const chosenButton = page.getByTestId(`telemetry-sample-${chosen.id}`);
  await chosenButton.click();
  await expect(
    page
      .getByTestId('telemetry-sample-inspector')
      .locator('dt')
      .filter({ hasText: /^Reported speed$/ })
      .locator('..')
      .locator('dd'),
  ).toHaveText('12 m/s');
  await chosenButton.focus();
  const sampleOffsetBefore = await chosenButton.evaluate(
    (element) => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top,
  );
  const gridBefore = await map.locator('.telemetry-graticule').innerHTML();
  const lateReceipt = await segment(context, [3]);
  await complete(request, lateReceipt.id);
  await expect(map.locator('.telemetry-point')).toHaveCount(40);
  await expect(map.locator('.telemetry-track')).toHaveCount(39);
  await expect(map.locator('.telemetry-late-ring')).toHaveCount(1);
  await expect(lens.locator('.telemetry-summary')).toContainText(/1\s*received out of order/);
  await expect(lens.locator('.telemetry-legend')).toContainText('Received out of order');
  await expect(lens.locator('.sample-late small')).toHaveText('Received out of order');
  await expect(chosenButton).toBeFocused();
  await expect(chosenButton).toHaveAttribute('aria-pressed', 'true');
  const sampleOffsetAfter = await chosenButton.evaluate(
    (element) => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top,
  );
  expect(sampleOffsetAfter).toBeCloseTo(sampleOffsetBefore, 0);
  expect(await map.locator('.telemetry-graticule').innerHTML()).toBe(gridBefore);
  const conflicting = await segment(context, [13], 0.1);
  await complete(request, conflicting.id);
  await expect(map.locator('.telemetry-point')).toHaveCount(41);
  await expect(lens).toContainText('outside the retained map extent');
  await expect(lens).toContainText('conflicting samples');
  await expect(chosenButton).toBeFocused();
  expect(await map.locator('.telemetry-graticule').innerHTML()).toBe(gridBefore);
  await page.getByRole('button', { name: 'Fit observed track', exact: true }).click();
  await expect.poll(() => map.locator('.telemetry-graticule').innerHTML()).not.toBe(gridBefore);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByTestId(`timeline-item-${command.id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-anchor-id="${command.id}"] .on-time`)).toHaveText('Received');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(chosenButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => watchRequests.length).toBeGreaterThan(0);
  expect(
    watchRequests.every((url) => !/[?&](?:token|jwt|authorization)=/i.test(url) && !url.includes('ledger-dev')),
  ).toBe(true);
  await lens.screenshot({ path: testInfo.outputPath('telemetry-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileContexts = fleet.locator('.fleet-context-strip');
  const mobileSelectedContext = mobileContexts.locator(`.fleet-context-summary[data-flight-id="${context.flight.id}"]`);
  await expect(mobileContexts).toBeVisible();
  await expect(mobileSelectedContext).toContainText(context.flight.label);
  await expect(mobileSelectedContext).toContainText(context.flight.aircraft!);
  await expect(mobileSelectedContext).toContainText(/Last known|Observed/);
  await expect(mobileSelectedContext).not.toContainText(/no position/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await lens.screenshot({ path: testInfo.outputPath('telemetry-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  const receiptPanel = page.getByTestId('receipt-inspector');
  const recorded = page.getByTestId('telemetry-record-inspection');
  const recordValue = (label: string) =>
    recorded
      .locator('dt')
      .filter({ hasText: new RegExp(`^${label}$`) })
      .locator('..')
      .locator('dd');
  const rollingWindowRoute = `**/v1/flights/${context.flight.id}/telemetry`;
  const omitInspectedSegment = async (route: Route) => {
    const response = await route.fetch();
    const data = (await response.json()) as TelemetryResponse;
    const samples = data.samples.filter((sample) => sample.receiptId !== receipt.id);
    await route.fulfill({
      response,
      json: {
        ...data,
        samples,
        sessions: data.sessions.map((session) => ({
          ...session,
          latestSample: samples.filter((sample) => sample.sourceSessionId === session.sourceSessionId).at(-1) ?? null,
        })),
        segments: data.segments.filter((segment) => segment.receiptId !== receipt.id),
        window: { ...data.window, truncated: true },
      },
    });
  };
  const artifactRoute = `**/v1/artifacts/${receipt.artifactId}/content`;
  let artifactReads = 0;
  const failFirstArtifactRead = async (route: Route) => {
    artifactReads++;
    if (artifactReads > 1) return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'recorded_telemetry_unavailable', message: 'Recorded telemetry temporarily unavailable.' },
      }),
    });
  };
  let releaseOldArtifact = () => {};
  const heldArtifactReads: Promise<void>[] = [];
  let holdArtifact = false;
  let oldArtifactReady = false;
  const oldArtifactGate = new Promise<void>((resolve) => {
    releaseOldArtifact = resolve;
  });
  const holdOldArtifact = (route: Route) => {
    if (!holdArtifact) return route.continue();
    const delivered = (async () => {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      oldArtifactReady = true;
      await oldArtifactGate;
      await route.fulfill({ response }).catch(() => {});
    })();
    heldArtifactReads.push(delivered);
    return delivered;
  };
  const expectLateCapture = async () => {
    await expect(recorded.getByLabel('Position sample', { exact: true })).toHaveCount(0);
    for (const [label, value] of Object.entries({
      Latitude: '38.890030° N',
      Longitude: '77.029925° W',
      Altitude: /^153 m\s*Ellipsoidal$/,
      'Horizontal speed': '12 m/s',
    }))
      await expect(recordValue(label)).toHaveText(value);
  };
  const captureRecord = async (kind: 'multiple' | 'single') => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await receiptPanel.screenshot({ path: testInfo.outputPath(`telemetry-record-${kind}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await receiptPanel.screenshot({ path: testInfo.outputPath(`telemetry-record-${kind}-phone.png`) });
    } finally {
      await page.setViewportSize({ width: 1440, height: 960 });
    }
  };
  await page.route(rollingWindowRoute, omitInspectedSegment);
  await page.route(artifactRoute, failFirstArtifactRead);
  try {
    await expect(map.locator('.telemetry-point')).toHaveCount(2);
    await expect(chosenButton).toHaveCount(0);
    await page
      .getByTestId('telemetry-sample-inspector')
      .getByRole('button', { name: 'Inspect segment receipt', exact: true })
      .click();
    await expect(recorded.getByRole('heading', { name: 'Recorded telemetry', exact: true })).toBeVisible();
    await expect(recorded).toContainText('Recorded telemetry temporarily unavailable.');
    await expect(recordValue('Latitude')).toHaveCount(0);
    await recorded.getByRole('button', { name: 'Retry telemetry', exact: true }).click();
    const positionSample = recorded.getByLabel('Position sample', { exact: true });
    await expect(positionSample).toHaveValue('40');
    await expect(positionSample.locator('option[value="40"]')).toHaveText(/^Capture 40 · /);
    await expect(recordValue('Altitude')).toHaveText(/^Not reported\s*Datum unknown$/);
    await expect(recordValue('Latitude')).toHaveText('38.890400° N');
    await expect(recordValue('Longitude')).toHaveText('77.029000° W');
    await positionSample.selectOption('10');
    for (const [label, value] of Object.entries({
      Latitude: '38.890100° N',
      Longitude: '77.029750° W',
      Altitude: /^160 m\s*Ellipsoidal$/,
      'Horizontal speed': '12 m/s',
    }))
      await expect(recordValue(label)).toHaveText(value);
    await captureRecord('multiple');
    expect(artifactReads).toBe(2);
    await page.unroute(artifactRoute, failFirstArtifactRead);

    const lateRecord = page.getByTestId(`timeline-item-${lateReceipt.eventId}`);
    await lateRecord.click();
    await expect(lateRecord).toContainText('1 position sample');
    await expect(lateRecord).not.toContainText('1 position samples');
    await expectLateCapture();
    await captureRecord('single');
    await page.route(artifactRoute, holdOldArtifact);
    holdArtifact = true;
    await page.getByTestId(`timeline-item-${chosen.eventId}`).click();
    await expect.poll(() => oldArtifactReady).toBe(true);
    await expect(recordValue('Latitude')).toHaveCount(0);
    await lateRecord.click();
    await expectLateCapture();
    holdArtifact = false;
    releaseOldArtifact();
    await Promise.all(heldArtifactReads);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(lateRecord).toHaveAttribute('aria-pressed', 'true');
    await expectLateCapture();
  } finally {
    holdArtifact = false;
    releaseOldArtifact();
    await Promise.allSettled(heldArtifactReads);
    await page.unroute(artifactRoute, failFirstArtifactRead);
    await page.unroute(artifactRoute, holdOldArtifact);
    await page.unroute(rollingWindowRoute, omitInspectedSegment);
  }
  await page.getByTestId(`timeline-item-${chosen.eventId}`).click();
  await expect(
    receiptPanel
      .locator('dt')
      .filter({ hasText: /^Receipt processing$/ })
      .locator('..')
      .locator('dd'),
  ).toHaveText(/^completed$/i);
  await expect(receiptPanel.locator('.correction-lineage')).toHaveCount(0);
  await expect(receiptPanel).toContainText('Receipt time is never backdated.');
  await receiptPanel.getByText('Receipt and processing trace', { exact: true }).click();
  await expect(receiptPanel.locator('.processing-trace')).toContainText(chosen.eventId);
  await page.getByTestId(`timeline-item-${chosen.eventId}`).click();
  await page.getByRole('button', { name: 'Append correction', exact: true }).click();
  const correction = page.getByTestId('correction-form');
  const correctionNote = 'Keep this unsubmitted correction while navigating back to the map.';
  await correction.getByLabel('Reason for correction').fill(correctionNote);
  const correctionBasis = await correction.locator('.draft-basis > span').first().innerText();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(chosenButton).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('review-map').click();
  await expect(page.getByTestId('decision-form')).toHaveCount(0);
  await expect(correction.getByLabel('Reason for correction')).toHaveValue(correctionNote);
  await expect(correction.getByLabel('Reason for correction')).toBeFocused();
  await expect(correction.locator('.draft-basis > span').first()).toHaveText(correctionBasis);
  await expect(
    page.getByText('Finish or close the open correction before reviewing the map.', { exact: true }),
  ).toBeVisible();
});
