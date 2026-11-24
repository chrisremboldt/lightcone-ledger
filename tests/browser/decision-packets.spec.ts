import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  CommandLinkSource,
  CommandResponse,
  FindingPacketResponse,
  FindingPacketV2,
  TimelineResponse,
} from '@ledger/contracts';
import { command, complete, createFlight, read, reportLinkStatus, withLinkStatusGrant } from './mission-fixture.js';

// The lost-link review runs on the generic evaluator, so a treatment of its finding offers the generic finding packet.
// A person issues it from the decision record, keeps the manifest digest shown, downloads the bytes and verifies them
// offline. The older decision packet is no longer issued.
test('a person issues a lost-link finding packet from the decision record and it verifies offline', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = randomUUID();
  const sourceId = `browser-packet-${identity}`;
  const packetWrites: string[] = [];
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    if (
      sent.method() === 'POST' &&
      ['/v1/exports', '/v1/decision-packets', '/v1/finding-packets'].includes(url.pathname)
    )
      packetWrites.push(url.pathname);
  });

  {
    const flight = await createFlight(
      request,
      `Selected packet review ${identity.slice(0, 6)}`,
      'Browser packet aircraft',
      Date.now() - 10 * 60_000,
      Date.now() + 30 * 60_000,
    );
    const raw: CommandLinkSource = {
      sourceSessionId: `browser-packet-session-${identity}`,
      sourceEventId: `loss-${identity}`,
      incidentId: `browser-packet-incident-${identity}`,
      aircraftId: flight.aircraft!,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'lost',
    };
    // The link monitor holds the link.status grant for this source while it reports.
    const receipt = await withLinkStatusGrant(request, sourceId, () =>
      reportLinkStatus(request, sourceId, flight.id, raw),
    );
    await complete(request, receipt.id);
    await expect
      .poll(async () => {
        const shown = await read<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`);
        return (
          shown.flight.outstandingWork === 0 &&
          shown.findings?.some((finding) => finding.latestEvaluation.title === 'Reported command-link loss')
        );
      })
      .toBe(true);

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    const flightRow = page.getByTestId(`flight-row-${flight.id}`);
    await expect(flightRow).toBeVisible();
    await flightRow.click();
    const findings = page.getByTestId('findings-panel');
    await expect(findings.getByTestId('finding-detail')).toContainText('Reported command-link loss');
    await findings.getByRole('button', { name: 'Take responsibility', exact: true }).click();
    const form = findings.getByTestId('finding-treatment-form');
    await form.getByLabel('What you will check', { exact: true }).fill('Review the original reported interruption.');
    const acknowledged = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/commands' &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.findingTreatment?.action === 'acknowledge',
    );
    await form.getByRole('button', { name: 'Take responsibility', exact: true }).click();
    const acknowledgement = await acknowledged;
    expect(acknowledgement.status(), await acknowledgement.text()).toBe(201);
    const acknowledgedCommand = (await acknowledgement.json()) as CommandResponse;
    const decisionId = acknowledgedCommand.command.id;
    const findingId = String(
      (acknowledgedCommand.command.payload.findingTreatment as { findingId: string } | undefined)?.findingId,
    );
    await expect
      .poll(async () => {
        const shown = await read<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`);
        return shown.flight.outstandingWork === 0 && shown.decisions.some((decision) => decision.id === decisionId);
      })
      .toBe(true);
    const decisionRow = page.getByTestId(`timeline-item-${decisionId}`);
    await decisionRow.click();
    await expect(decisionRow).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="decision-packet"]:visible')).toHaveCount(0);
    const panel = page.locator('[data-testid="decision-finding-packet"]:visible');
    await expect(panel).toHaveCount(1);
    await expect(panel.getByRole('heading', { name: 'Finding packet', exact: true })).toBeVisible();
    expect(packetWrites).toEqual([]);

    const issued = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/finding-packets' && response.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: 'Issue a finding packet', exact: true }).click();
    const issueResponse = await issued;
    expect(issueResponse.status(), await issueResponse.text()).toBe(201);
    const record = ((await issueResponse.json()) as FindingPacketResponse).record;
    expect(record).toMatchObject({ findingId, format: 'ledger.finding-packet.2' });
    expect(packetWrites).toEqual(['/v1/finding-packets']);
    await expect(panel.getByRole('status')).toContainText('Finding packet confirmed');
    const shownDigest = panel.getByTestId('packet-manifest-digest');
    await expect(shownDigest).toHaveText(record.manifestDigest);
    await expect(panel.getByTestId('packet-originals')).toContainText('none left out');

    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download selected packet', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`ledger-finding-packet-${record.id}.json`);
    const file = testInfo.outputPath('finding-packet.json');
    await download.saveAs(file);
    const packet = JSON.parse(await readFile(file, 'utf8')) as FindingPacketV2;
    expect(packet.artifacts.map((item) => item.id)).toContain(receipt.artifactId);
    expect(packet.artifacts.every((item) => item.bytesBase64 !== null)).toBe(true);
    const verified = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../tools/verifier/finding-packet-cli.mjs', import.meta.url)),
        file,
        '--expected-manifest-sha256',
        (await shownDigest.textContent())!,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      status: 'verified',
      format: 'ledger.finding-packet.2',
      findingId,
      originals: { leftOut: [] },
    });

    // The decision record still offers the packets issued for the finding after a person moves away and back.
    await flightRow.click();
    await decisionRow.click();
    await expect(
      page.locator('[data-testid="decision-finding-packet"]:visible').getByTestId('packet-manifest-digest'),
    ).toHaveText(record.manifestDigest);
    expect(receipt.id).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('lost-link-finding-packet.png'), fullPage: true });
  }
});
