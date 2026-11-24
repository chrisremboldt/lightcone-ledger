import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  ControlIndicatorResultListResponse,
  ControlWindow,
  ControlWindowOpen,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
} from '@ledger/contracts';
import { commandLinkLossesPerFlightHourV1 } from '../../packages/domain/src/rules/demo-procedures-pack.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  api,
  command,
  createFlight,
  linkStatusGrant,
  linkStatusRevocation,
  operator,
  principal,
  read,
  source,
  writeHeaders,
} from './mission-fixture.js';

// A control accepted on a safety-record hazard has its indicator result recorded through a window opened for it,
// and a person reviews the recorded result, all on the control's own page in the safety section.

/** A hazard on the safety record with one avoidance area, assessed and its risk accepted by the dispatcher. */
async function acceptedControlRecord(
  request: Parameters<typeof principal>[0],
  identity: string,
  interval: { start: string; end: string },
) {
  const dispatcher = await principal(request);
  const decide = async (hazardId: string, decision: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const shown = await read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
    const response = await request.post(`${api}/v1/commands`, {
      headers: { ...writeHeaders(), ...headers },
      data: {
        kind: 'decision.record',
        subject: { kind: 'sms', id: hazardId },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
  };
  const hazardTitle = `Link loss near the fictional depot ${identity.slice(0, 6)}`;
  const hazardId = (
    await command(request, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: hazardTitle,
        ownerId: dispatcher.id,
        body: {
          description: 'The control link drops near the fictional depot.',
          consequence: 'Uncontrolled descent near the depot.',
          source: { kind: 'manual_identification' },
        },
      },
    } as never)
  ).command.subject!.id;
  const opened = await read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
  const type = opened.controlTypes!.find((entry) => entry.title === 'Route avoidance area')!;
  const controlTitle = `Keep clear of the depot ${identity.slice(0, 6)}`;
  const controlId = (
    await command(request, {
      kind: 'sms.record.open',
      record: {
        kind: 'control',
        schema: 'sms.control.1',
        title: controlTitle,
        ownerId: dispatcher.id,
        body: {
          hazardId,
          controlType: { id: type.id, version: type.version, digest: type.digest },
          // Well away from the market routes other specs plan, so this area reaches none of them.
          parameters: { center: { latitude: 41.7, longitude: -87.95 }, radiusMeters: 150 },
          effectiveFrom: interval.start,
          effectiveUntil: interval.end,
        },
      },
    } as never)
  ).command.subject!.id;
  await decide(hazardId, {
    kind: 'risk.assess',
    note: 'Assessed with the avoidance area in place.',
    matrix: { recordId: opened.matrix!.record.id, versionNumber: opened.matrix!.version.versionNumber },
    initial: { severity: 'major', likelihood: 'remote' },
    controls: [{ recordId: controlId, versionNumber: 1 }],
    residual: { severity: 'minor', likelihood: 'remote' },
    newHazardCheck: { answer: 'none_identified' },
  });
  const assessed = await read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
  const assessmentId = assessed.decisions.find((decision) => decision.kind === 'risk.assess')!.id;
  const signing = await read<SmsSigningPreviewResponse>(
    request,
    `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`,
  );
  const grant = await request.post(`${api}/v1/local/reauthentications`, {
    headers: writeHeaders(),
    data: { credential: operator },
  });
  expect(grant.status(), await grant.text()).toBe(201);
  await decide(
    hazardId,
    {
      kind: 'risk.accept',
      note: 'Residual risk accepted with the avoidance area in place.',
      assessmentId,
      signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
    },
    { 'x-ledger-reauthentication': ((await grant.json()) as { grant: string }).grant },
  );
  const accepted = await read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
  const control = accepted.controls!.find((entry) => entry.id === controlId)!;
  expect(control.accepted).toBe(true);
  return {
    hazardId,
    hazardTitle,
    controlTitle,
    control: {
      kind: 'control_record' as const,
      hazardId,
      recordId: controlId,
      versionNumber: 1,
      bodyDigest: control.bodyDigest,
      acceptanceId: accepted.decisions.find((decision) => decision.kind === 'risk.accept')!.id,
    },
  };
}

test('a control’s indicator result is recorded through its window and reviewed by a person', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = randomUUID();
  const sourceId = `browser-assurance-${identity}`;
  const author = await principal(request);
  const originalSource = await principal(request, source);
  const addedAuthorCapabilities: typeof author.capabilities = (
    ['decision:write', 'monitoring:write', 'evidence:read', 'flight:read', 'risk:accept:low'] as const
  ).filter((capability) => !author.capabilities.includes(capability));
  let sourceGranted = false;
  let authorGranted = false;

  async function screenshot(name: string) {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }

  try {
    // 1. Grants: the source reports link status; the operator opens windows and reviews results.
    await command(request, linkStatusGrant(originalSource, sourceId));
    sourceGranted = true;
    if (addedAuthorCapabilities.length) {
      await command(request, {
        kind: 'authority.update',
        principalId: author.id,
        expectedRevision: author.revision,
        capabilities: [...author.capabilities, ...addedAuthorCapabilities],
      });
      authorGranted = true;
    }

    // 2. A control accepted on a safety-record hazard, and a flight to monitor.
    const start = Date.now() - 120_000;
    const interval = { start: new Date(start).toISOString(), end: new Date(Date.now() + 30 * 60_000).toISOString() };
    const accepted = await acceptedControlRecord(request, identity, interval);
    const flight = await createFlight(
      request,
      `Assurance sample ${identity.slice(0, 6)}`,
      `Browser assurance aircraft ${identity.slice(0, 6)}`,
      start,
      Date.now() + 30 * 60_000,
    );

    // 3. A window for the control over the last half hour, declared complete, for the command-link loss indicator.
    const indicator = commandLinkLossesPerFlightHourV1();
    const opening: ControlWindowOpen = {
      control: accepted.control,
      period: {
        start: new Date(Date.now() - 30 * 60_000).toISOString(),
        end: new Date(Date.now() - 1000).toISOString(),
      },
      subjectKind: 'flight',
      subjects: [{ scope: 'ledger', kind: 'flight', id: flight.id }],
      complete: true,
      expectedObservations: [
        { type: 'flight.report', versions: [1] },
        { type: 'link.status', versions: [1] },
      ],
      indicators: [{ id: indicator.id, version: indicator.version, digest: indicator.digest }],
      note: 'The browser assurance flight is the only flight in this window.',
    };
    const opened = await request.post(`${api}/v1/control-windows`, { headers: writeHeaders(), data: opening });
    expect(opened.status(), await opened.text()).toBe(201);
    const window = ((await opened.json()) as { window: ControlWindow }).window;

    // 4. The operator opens the safety section from the flights, then the hazard and its control from the register.
    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('operator');
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await page.getByRole('button', { name: 'Hazards', exact: true }).click();
    await page.getByTestId(`sms-row-${accepted.hazardId}`).click();
    const hazardRecord = page.getByTestId('sms-record');
    await expect(hazardRecord.getByRole('heading', { name: accepted.hazardTitle })).toBeVisible();
    await hazardRecord.getByTestId('sms-hazard-controls').getByRole('button', { name: accepted.controlTitle }).click();
    const assurance = page.getByTestId('sms-record');
    await expect(assurance.getByRole('heading', { name: accepted.controlTitle })).toBeVisible();

    // 5. The window and its indicator result are shown in plain words: the indicator's title and description, the
    // population and who declared it by name, what was counted, the exposure, and why no rate is stated.
    const indicators = assurance.getByTestId('control-indicators');
    await expect(indicators).toContainText(indicator.title);
    await expect(indicators).toContainText(indicator.description);
    await expect(indicators).toContainText(`Covers 1 flight, declared complete by ${author.name}`);
    const current = indicators.getByTestId('control-indicator-result').first();
    await expect(current).toContainText('Counted0 issues');
    await expect(current).toContainText('Exposure0 flight hours');
    await expect(current).toContainText('Exposure gapsNone');
    await expect(current).toContainText(`Population1 flight, declared complete by ${author.name}`);
    // No flight report or link reports were received for the flight, so the result states no rate, and says why.
    await expect(current).toContainText('Insufficient evidence');
    await expect(current).toContainText('No rate stated');
    await expect(current.getByRole('list', { name: 'Reasons', exact: true })).toContainText(
      'No exposure was measured in the window, so no rate can be stated.',
    );
    // Identifiers, codes and digests are only in folded details.
    const shown = await indicators.innerText();
    for (const raw of [indicator.id, indicator.digest, 'exposure_not_positive', author.id, ' subjects'])
      expect(shown).not.toContain(raw);
    await indicators.getByText('Window identifiers', { exact: true }).first().click();
    await expect(indicators).toContainText(window.id);
    await screenshot('assurance-indicator-result.png');

    // 6. The operator records the result; it is listed in the same words, with its digest in a folded detail.
    await indicators.getByRole('button', { name: 'Record this result', exact: true }).click();
    const recordedItem = indicators.getByTestId('control-indicator-recorded').first();
    await expect(recordedItem).toContainText('window revision 1');
    await expect(recordedItem).toContainText('No exposure was measured in the window, so no rate can be stated.');
    const recorded = await read<ControlIndicatorResultListResponse>(
      request,
      `/v1/control-windows/${window.id}/indicator-results`,
    );
    expect(recorded.results).toHaveLength(1);
    const result = recorded.results[0]!;
    expect(result.digest).toBe(canonicalDigest(result.record));
    expect(result.record).toMatchObject({ windowId: window.id, windowRevision: 1, result: { status: 'insufficient' } });
    expect(await recordedItem.innerText()).not.toContain(result.digest);
    await recordedItem.getByText('Recorded result identifiers', { exact: true }).click();
    await expect(recordedItem).toContainText(result.digest);

    // 7. A result that states no rate can only be reviewed as inconclusive; the person records that review.
    const reviewForm = recordedItem.getByRole('form', { name: 'Review this result', exact: true });
    // The label wraps its select, so its text includes the options; address the control by its role and name.
    const conclusion = reviewForm.getByRole('combobox', { name: 'Conclusion', exact: true });
    await expect(conclusion.locator('option')).toHaveText(['inconclusive']);
    await expect(reviewForm.getByRole('button', { name: 'Record review', exact: true })).toBeDisabled();
    await reviewForm.getByLabel('Note', { exact: true }).fill('No reports were received for the window flight.');
    await reviewForm.getByRole('button', { name: 'Record review', exact: true }).click();
    await expect(recordedItem.getByRole('list', { name: 'Reviews', exact: true })).toContainText('inconclusive');
    const reviewed = await read<ControlIndicatorResultListResponse>(
      request,
      `/v1/control-windows/${window.id}/indicator-results`,
    );
    expect(reviewed.reviews).toHaveLength(1);
    expect(reviewed.reviews[0]!.record).toMatchObject({
      result: { id: result.record.id, digest: result.digest },
      conclusion: 'inconclusive',
      actor: { id: author.id },
    });
    await screenshot('assurance-indicator-reviewed.png');
  } finally {
    try {
      if (sourceGranted) {
        const current = await principal(request, source);
        await command(request, linkStatusRevocation(current, sourceId));
      }
    } finally {
      if (authorGranted) {
        const current = await principal(request);
        await command(request, {
          kind: 'authority.update',
          principalId: current.id,
          expectedRevision: current.revision,
          capabilities: current.capabilities.filter((capability) => !addedAuthorCapabilities.includes(capability)),
        });
      }
    }
  }
});
