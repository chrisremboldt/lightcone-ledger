import { openAccount } from './account-fixture.js';
import { test, expect, type APIRequestContext, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  CommandResponse,
  FlightListResponse,
  MissionAvoidanceResponse,
  MissionBriefingAcknowledgementCommand,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingCommand,
  MissionBriefingRecordResponse,
  MissionReleaseCommand,
  MissionReleaseRecordResponse,
  MissionReleaseValidityResponse,
  MissionSource,
  OrganizationPeopleResponse,
  TimelineResponse,
} from '@ledger/contracts';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  acceptedControl,
  api,
  authorization,
  command,
  createFlight,
  mission,
  principal,
  releaseAuthor,
  releaseFindingsDigest,
  source,
} from './mission-fixture.js';

async function readSnapshot<T>(request: APIRequestContext, path: string, token?: string): Promise<T> {
  let snapshot: T | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`${api}${path}`, { headers: authorization(token) });
        if (response.status() === 409 && (await response.json()).error?.code === 'concurrent_change') return false;
        expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
        snapshot = (await response.json()) as T;
        return true;
      },
      { message: `Read a coherent snapshot from ${path}` },
    )
    .toBe(true);
  return snapshot!;
}

test('Dana briefs an exact release and Sam personally reviews its retained content after the mission changes', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(12_000);
  const identity = randomUUID();
  const sourceId = `browser-briefing-${identity}`;
  const dana = await principal(request);
  const sam = await principal(request, releaseAuthor);
  const originalSource = await principal(request, source);
  const addedSourceCapabilities = ['mission:write'].filter(
    (capability) => !originalSource.capabilities.some((current) => current === capability),
  );
  const wantedAuthorCapabilities = ['briefing:write', 'mission:release'] as const;
  const addedAuthorCapabilities: typeof dana.capabilities = wantedAuthorCapabilities.filter(
    (capability) => !dana.capabilities.includes(capability),
  );
  if (!dana.capabilities.some((capability) => ['risk:accept:medium', 'risk:accept:high'].includes(capability)))
    addedAuthorCapabilities.push('risk:accept:medium');
  let sourceGranted = false;
  let authorGranted = false;
  let acknowledgementGranted = false;
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let firstAccepted: CommandResponse | undefined;
  let omittedFlightId: string | undefined;
  const rosterPath = (url: URL) => url.pathname === '/v1/flights';
  const omitCapturedFlight = async (route: Route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.searchParams.get('view') !== 'monitor' || !omittedFlightId) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const roster = (await response.json()) as FlightListResponse;
    await route.fulfill({
      response,
      json: { ...roster, flights: roster.flights.filter((row) => row.id !== omittedFlightId) },
    });
  };
  const loseFirstBriefingReply = async (route: Route) => {
    const sent = route.request();
    if (sent.method() !== 'POST' || sent.postDataJSON()?.kind !== 'mission.brief') {
      await route.continue();
      return;
    }
    attempts.push({ key: sent.headers()['idempotency-key'], body: sent.postData() });
    if (attempts.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.status(), await accepted.text()).toBe(201);
      firstAccepted = (await accepted.json()) as CommandResponse;
      await route.abort('failed');
    } else await route.continue();
  };
  async function screenshot(name: string, fullPage = true) {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path, fullPage });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }

  try {
    await command(request, {
      kind: 'authority.update',
      principalId: originalSource.id,
      expectedRevision: originalSource.revision,
      capabilities: [...new Set([...originalSource.capabilities, 'mission:write' as const])],
      missionSources: [...originalSource.missionSources, sourceId],
    });
    sourceGranted = true;
    if (addedAuthorCapabilities.length) {
      await command(request, {
        kind: 'authority.update',
        principalId: dana.id,
        expectedRevision: dana.revision,
        capabilities: [...dana.capabilities, ...addedAuthorCapabilities],
      });
      authorGranted = true;
    }

    const starts = Math.floor((Date.now() + 8 * 24 * 60 * 60_000) / 60_000) * 60_000;
    const interval = { start: new Date(starts).toISOString(), end: new Date(starts + 60 * 60_000).toISOString() };
    const hazard = await acceptedControl(request, sourceId, identity, interval, dana);
    const { control } = hazard;
    const aircraft = `Browser briefing aircraft ${identity.slice(0, 6)}`;
    const flight = await createFlight(
      request,
      `Mission briefing ${identity.slice(0, 6)}`,
      aircraft,
      starts,
      starts + 60 * 60_000,
    );
    const first: MissionSource = {
      sourceMissionId: `browser-briefing-mission-${identity}`,
      sourceRevision: 1,
      occurredAt: new Date().toISOString(),
      aircraftId: aircraft,
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-87.635, 41.88],
            [-87.635, 41.885],
            [-87.625, 41.885],
            [-87.625, 41.88],
          ],
        },
      },
      lateralToleranceMeters: 30,
      altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
      operatingInterval: interval,
    };
    const missionReceipt = await mission(request, flight.id, sourceId, first);
    const preview = () => readSnapshot<MissionAvoidanceResponse>(request, `/v1/flights/${flight.id}/mission-avoidance`);
    await expect.poll(async () => (await preview()).status).toBe('outside');
    const reviewed = await preview();
    expect(reviewed.mission?.eventId).toBe(missionReceipt.eventId);
    expect(reviewed.candidateCompleteness.status).toBe('complete');
    const candidate = reviewed.candidates.find((entry) => entry.controlEventId === control.id)!;
    expect(candidate).toMatchObject({
      hazardId: hazard.id,
      controlId: control.controlId,
      controlVersion: control.controlVersion,
      controlDigest: control.bodyDigest,
      geometry: 'outside',
      context: 'current',
    });
    const releaseBody: MissionReleaseCommand = {
      kind: 'mission.release',
      flightId: flight.id,
      aircraftId: aircraft,
      mission: reviewed.mission!,
      calculation: {
        id: reviewed.calculation.id,
        version: reviewed.calculation.version,
        digest: reviewed.calculation.digest,
      },
      policy: {
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      },
      expectedContextDigest: reviewed.contextDigest!,
      expectedFindingsDigest: await releaseFindingsDigest(request, flight.id),
      expectedPrincipalRevision: (await principal(request)).revision,
      departureWindow: {
        start: new Date(starts + 5 * 60_000).toISOString(),
        end: new Date(starts + 30 * 60_000).toISOString(),
      },
      note: 'Release this exact clear route for the named market avoidance briefing.',
    };
    const released = await command(request, releaseBody);
    const releaseId = released.command.id;
    const releasePath = `/v1/flights/${flight.id}/mission-releases/${releaseId}`;
    const release = await readSnapshot<MissionReleaseRecordResponse>(request, releasePath);
    expect(release.digest).toBe(canonicalDigest(release.release));
    await expect
      .poll(async () => {
        const status = await readSnapshot<MissionReleaseValidityResponse>(request, `${releasePath}/validity`);
        return { status: status.status, processing: status.processing };
      })
      .toEqual({ status: 'scheduled', processing: 'completed' });

    const directorySam = (
      await readSnapshot<OrganizationPeopleResponse>(
        request,
        `/v1/organization/people?search=${encodeURIComponent(sam.name)}&limit=100`,
      )
    ).people.find((person) => person.id === sam.id)!;
    const directoryDana = (
      await readSnapshot<OrganizationPeopleResponse>(
        request,
        `/v1/organization/people?search=${encodeURIComponent(dana.name)}&limit=100`,
      )
    ).people.find((person) => person.id === dana.id)!;
    expect(directorySam).toMatchObject({ id: sam.id, name: sam.name, kind: 'human', revision: sam.revision });
    expect(directoryDana).toMatchObject({ id: dana.id, name: dana.name, kind: 'human' });

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('operator');
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await expect(page.locator('.topbar-user')).toContainText(directoryDana.name);
    const selectedFlight = page.getByTestId(`flight-row-${flight.id}`);
    await selectedFlight.click();
    await page.getByTestId(`timeline-item-${releaseId}`).click();
    await page
      .getByTestId('mission-inspection')
      .getByRole('button', { name: /^Review mission, release and briefing/ })
      .click();
    const missionWorkspace = page.getByRole('region', { name: 'Mission review', exact: true });
    await missionWorkspace.getByRole('button', { name: /^Prepare briefing/ }).click();
    const workspace = page.getByRole('region', { name: 'Mission briefing', exact: true });
    await expect(workspace.getByRole('heading', { name: 'Mission briefing', exact: true })).toBeVisible();
    await expect(
      workspace.getByRole('region', { name: 'Controls in scope for this flight', exact: true }),
    ).toBeVisible();
    await workspace.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
    const form = workspace.getByTestId('mission-briefing-form');
    await expect(form.getByLabel('Message', { exact: true })).toHaveValue('');
    const recipients = form.getByRole('group', { name: 'Recipients', exact: true });
    await expect(recipients.getByRole('checkbox', { checked: true })).toHaveCount(0);
    const peopleRead = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/v1/organization/people' && url.searchParams.get('search') === directorySam.name;
    });
    await recipients.getByLabel('Find people', { exact: true }).fill(directorySam.name);
    const peopleResponse = await peopleRead;
    expect(peopleResponse.status()).toBe(200);
    expect(((await peopleResponse.json()) as OrganizationPeopleResponse).people).toContainEqual(directorySam);
    const samChoice = recipients.getByRole('checkbox', { name: directorySam.name, exact: true });
    const samResult = recipients
      .getByRole('list', { name: 'Available people', exact: true })
      .getByRole('listitem')
      .filter({ has: page.getByRole('checkbox', { name: directorySam.name, exact: true }) });
    await expect(samResult).toHaveCount(1, { timeout: 10_000 });
    await samResult.getByText('Identity details', { exact: true }).click({ timeout: 10_000 });
    await expect(samResult).toContainText(directorySam.id);
    await samChoice.check();
    await expect(recipients.getByRole('checkbox', { checked: true })).toHaveCount(1);
    // A new briefing covers every control in the release until the author narrows it; this one covers one control.
    const covered = form.getByRole('group', { name: /^Controls this briefing covers/ });
    for (const box of await covered.getByRole('checkbox').all()) await box.uncheck();
    await covered.locator(`input[id$="-control-${control.id}"]`).check();
    const message =
      'Sam: review the market avoidance circle and keep this exact route and corridor outside it. Report a changed condition before proceeding.';
    await form.getByLabel('Message', { exact: true }).fill(message);
    await expect(form.getByRole('button', { name: 'Record briefing', exact: true })).toBeEnabled();
    const hiddenReads: string[] = [];
    const observeHiddenRead = (sent: Request) => {
      if (sent.method() !== 'GET') return;
      const url = new URL(sent.url());
      if (
        [
          `/v1/flights/${flight.id}/timeline`,
          `/v1/flights/${flight.id}/mission`,
          `/v1/flights/${flight.id}/mission-avoidance`,
        ].includes(url.pathname) ||
        (url.pathname === '/v1/orders' && url.searchParams.get('flightId') === flight.id)
      )
        hiddenReads.push(`${url.pathname}${url.search}`);
    };
    page.on('request', observeHiddenRead);
    try {
      await page.waitForTimeout(3200);
      expect(hiddenReads, 'Hidden flight and mission-review panels must not start reads while briefing').toEqual([]);
    } finally {
      page.off('request', observeHiddenRead);
    }
    await workspace.getByRole('button', { name: /Return to mission review/ }).click();
    await expect(workspace).toBeHidden();
    await missionWorkspace.getByRole('button', { name: /^Prepare briefing/ }).click();
    await expect(form.getByLabel('Message', { exact: true })).toHaveValue(message);
    await expect(covered.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await expect(covered.locator(`input[id$="-control-${control.id}"]`)).toBeChecked();
    await expect(samChoice).toBeChecked();
    await expect(recipients.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await expect(form.getByRole('button', { name: 'Record briefing', exact: true })).toBeEnabled();
    await screenshot('mission-briefing-authoring.png');

    await page.route('**/v1/commands', loseFirstBriefingReply);
    await form.getByRole('button', { name: 'Record briefing', exact: true }).click();
    const retry = workspace.getByRole('button', { name: 'Retry same action', exact: true });
    await expect(retry).toBeVisible();
    expect(firstAccepted).toBeDefined();
    await expect(form.getByLabel('Message', { exact: true })).toHaveValue(message);
    await expect(form.getByLabel('Message', { exact: true })).toBeDisabled();
    await expect(samChoice).toBeChecked();
    await expect(samChoice).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Record briefing', exact: true })).toBeDisabled();
    await screenshot('mission-briefing-unknown-response.png');
    const recoveredResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') && response.request().postDataJSON()?.kind === 'mission.brief',
    );
    await retry.click();
    const recovered = await recoveredResponse;
    expect(recovered.status(), await recovered.text()).toBe(201);
    const result = (await recovered.json()) as CommandResponse;
    expect(result.command).toEqual(firstAccepted!.command);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.key).toBeTruthy();
    expect(attempts[1]).toEqual(attempts[0]);
    await page.unroute('**/v1/commands', loseFirstBriefingReply);
    const submitted = recovered.request().postDataJSON() as MissionBriefingCommand;
    const controlReference = {
      hazardId: candidate.hazardId,
      controlId: candidate.controlId,
      controlVersion: candidate.controlVersion,
      controlEventId: candidate.controlEventId,
      controlDigest: candidate.controlDigest,
      acceptance: candidate.acceptance,
    };
    expect(submitted).toEqual({
      kind: 'mission.brief',
      flightId: flight.id,
      purpose: 'informational',
      release: { id: releaseId, digest: release.digest },
      controls: [controlReference],
      recipientPrincipalIds: [directorySam.id],
      message,
      expectedPrincipalRevision: directoryDana.revision,
      // The screen pins the controls list it showed; a changed list would refuse the briefing.
      expectedControlsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const briefingId = result.command.id;
    const briefingPath = `/v1/flights/${flight.id}/briefings/${briefingId}`;
    const retained = await readSnapshot<MissionBriefingRecordResponse>(request, briefingPath);
    expect(retained.digest).toBe(canonicalDigest(retained.briefing));
    expect(retained.standing.status).toBe('in_force');
    // The record never changes; only the instant its standing is read moves.
    const unchanged = (read: MissionBriefingRecordResponse) => ({
      ...read,
      standing: { ...read.standing, evaluatedAt: retained.standing.evaluatedAt },
    });
    expect(retained.briefing).toMatchObject({
      id: briefingId,
      flightId: flight.id,
      organizationId: release.release.organizationId,
      purpose: 'informational',
      context: {
        release: { id: releaseId, digest: release.digest },
        mission: reviewed.mission,
        aircraftId: aircraft,
        contextDigest: reviewed.contextDigest,
        releasePolicy: releaseBody.policy,
        controls: [controlReference],
      },
      content: {
        message,
        controls: [
          {
            title: control.label,
            description: control.description,
            area: control.area,
            effectiveFrom: control.effectiveFrom,
            effectiveUntil: control.effectiveUntil,
          },
        ],
      },
      actor: {
        id: directoryDana.id,
        name: directoryDana.name,
        principalRevision: submitted.expectedPrincipalRevision,
        checkedCapabilities: ['flight:read', 'briefing:write'],
      },
    });
    expect(retained.briefing.population.recipients).toEqual([
      {
        principalId: directorySam.id,
        name: directorySam.name,
        kind: 'human',
        principalRevision: directorySam.revision,
      },
    ]);
    const { digest: populationDigest, ...population } = retained.briefing.population;
    expect(populationDigest).toBe(canonicalDigest(population));
    const recorded = workspace.getByRole('region', { name: 'Recorded briefing', exact: true });
    await expect(recorded).toContainText(message);
    await expect(recorded).toContainText(`Recorded by ${directoryDana.name}`);
    await expect(recorded.getByTestId('briefing-standing')).toContainText('In force until');
    await expect(recorded).toContainText(directorySam.name);
    await expect(recorded).toContainText('Named recipients · 0 / 1 acknowledged');
    await expect(workspace.getByRole('button', { name: 'Acknowledge my review', exact: true })).toHaveCount(0);
    await expect(workspace).toContainText('You are not a named recipient of this briefing.');
    await screenshot('mission-briefing-recorded.png');
    const nextBriefing = workspace.getByRole('button', { name: 'Prepare another briefing', exact: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await nextBriefing.scrollIntoViewIfNeeded();
    await nextBriefing.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await screenshot('mission-briefing-next-mobile.png', false);
    await page.setViewportSize({ width: 1440, height: 960 });
    await nextBriefing.hover();
    await screenshot('mission-briefing-next-desktop.png', false);
    await expect
      .poll(async () => {
        const timeline = await readSnapshot<TimelineResponse>(request, `/v1/flights/${flight.id}/timeline`);
        return timeline.items.filter((item) => item.id === briefingId).length;
      })
      .toBe(1);

    await mission(request, flight.id, sourceId, {
      ...first,
      sourceRevision: 2,
      occurredAt: new Date().toISOString(),
      lateralToleranceMeters: 35,
    });
    await expect
      .poll(async () => (await readSnapshot<MissionReleaseValidityResponse>(request, `${releasePath}/validity`)).status)
      .toBe('changed');
    expect(unchanged(await readSnapshot<MissionBriefingRecordResponse>(request, briefingPath))).toEqual(retained);
    if (!sam.capabilities.includes('briefing:ack')) {
      const current = await principal(request, releaseAuthor);
      await command(request, {
        kind: 'authority.update',
        principalId: current.id,
        expectedRevision: current.revision,
        capabilities: [...current.capabilities, 'briefing:ack'],
      });
      acknowledgementGranted = true;
    }
    const currentSam = await principal(request, releaseAuthor);
    if (acknowledgementGranted) expect(currentSam.revision).toBeGreaterThan(directorySam.revision);
    await openAccount(page);
    await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('actor');
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await expect(page.locator('.topbar-user')).toContainText(directorySam.name);
    await selectedFlight.click();
    const briefingItem = page.getByTestId(`timeline-item-${briefingId}`);
    await briefingItem.click();
    const inspector = page.getByTestId('mission-inspection');
    await inspector.getByRole('button', { name: /^Review briefing/ }).click();
    await expect(recorded).toContainText(message);
    await expect(workspace.getByRole('region', { name: 'Current release status', exact: true })).toContainText(
      'Release context has changed',
    );
    omittedFlightId = flight.id;
    const filteredRoster = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'GET' &&
        rosterPath(url) &&
        url.searchParams.get('view') === 'monitor' &&
        response.status() === 200
      );
    });
    await page.route(rosterPath, omitCapturedFlight);
    await filteredRoster;
    await expect(selectedFlight).toHaveCount(0);
    await expect(workspace.getByRole('heading', { name: 'Mission briefing', exact: true })).toBeVisible();
    await expect(workspace.locator('.thread-crumbs')).toContainText(flight.label);
    await expect(recorded).toContainText(message);
    const acknowledgement = workspace.getByTestId('briefing-acknowledgement-form');
    const reviewedExact = acknowledgement.getByRole('checkbox', {
      name: 'I reviewed this exact briefing',
      exact: true,
    });
    const acknowledge = acknowledgement.getByRole('button', { name: 'Acknowledge my review', exact: true });
    await expect(reviewedExact).not.toBeChecked();
    await expect(reviewedExact).toBeEnabled();
    await expect(acknowledge).toBeDisabled();
    await reviewedExact.check();
    const acknowledgementResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') &&
        response.request().postDataJSON()?.kind === 'mission.briefing-acknowledge',
    );
    await acknowledge.click();
    const acknowledged = await acknowledgementResponse;
    expect(acknowledged.status(), await acknowledged.text()).toBe(201);
    const acknowledgementBody = acknowledged.request().postDataJSON() as MissionBriefingAcknowledgementCommand;
    expect(acknowledgementBody).toEqual({
      kind: 'mission.briefing-acknowledge',
      flightId: flight.id,
      briefing: { id: briefingId, digest: retained.digest },
      populationDigest,
      attestation: 'reviewed_exact_briefing',
      expectedPrincipalRevision: currentSam.revision,
    });
    let coverage: MissionBriefingAcknowledgementsResponse;
    await expect
      .poll(async () => {
        coverage = await readSnapshot<MissionBriefingAcknowledgementsResponse>(
          request,
          `${briefingPath}/acknowledgements`,
          releaseAuthor,
        );
        const row = coverage.recipients.find((entry) => entry.recipientPrincipalId === directorySam.id);
        return { accepted: Boolean(row?.acknowledgement), processing: row?.processing };
      })
      .toEqual({ accepted: true, processing: 'completed' });
    expect(coverage!).toMatchObject({
      briefing: { id: briefingId, digest: retained.digest },
      purpose: 'informational',
      scope: 'declared_recipients_only',
      population: retained.briefing.population,
      releaseValidity: { release: { id: releaseId, digest: release.digest }, status: 'changed' },
    });
    expect(coverage!.recipients).toHaveLength(1);
    const review = coverage!.recipients[0]!.acknowledgement!;
    expect(review.digest).toBe(canonicalDigest(review.record));
    expect(review.record).toMatchObject({
      flightId: flight.id,
      briefing: { id: briefingId, digest: retained.digest },
      populationDigest,
      recipientPrincipalId: directorySam.id,
      attestation: 'reviewed_exact_briefing',
      actor: {
        id: directorySam.id,
        name: directorySam.name,
        kind: 'human',
        principalRevision: currentSam.revision,
        checkedCapabilities: ['flight:read', 'briefing:ack'],
      },
    });
    expect(unchanged(await readSnapshot<MissionBriefingRecordResponse>(request, briefingPath, releaseAuthor))).toEqual(
      retained,
    );
    await expect(recorded).toContainText('Named recipients · 1 / 1 acknowledged');
    await expect(recorded).toContainText('Flight record updated');
    await expect(workspace).toContainText('Your review is recorded.');
    await screenshot('mission-briefing-personal-review.png');
    await recorded.getByRole('button', { name: /^View briefing in flight record/ }).click();
    await expect(workspace).toBeHidden();
    await expect(selectedFlight).toHaveCount(0);
    await expect(
      page.getByTestId('timeline-scroll').getByRole('heading', { name: flight.label, exact: true }),
    ).toBeVisible();
    await expect(briefingItem).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector).toContainText(message);
    await expect(inspector).toContainText(`Recorded by ${directoryDana.name}`);
    await expect(inspector).toContainText(directorySam.name);
    await expect(inspector).toContainText('Named recipients · 1 / 1 acknowledged');
    await expect(inspector).toContainText('Release context has changed');
  } finally {
    await page.unroute(rosterPath, omitCapturedFlight).catch(() => {});
    await page.unroute('**/v1/commands', loseFirstBriefingReply).catch(() => {});
    try {
      if (sourceGranted) {
        const current = await principal(request, source);
        await command(request, {
          kind: 'authority.update',
          principalId: current.id,
          expectedRevision: current.revision,
          capabilities: current.capabilities.filter((capability) => !addedSourceCapabilities.includes(capability)),
          missionSources: current.missionSources.filter((grant) => grant !== sourceId),
        });
      }
    } finally {
      try {
        if (acknowledgementGranted) {
          const current = await principal(request, releaseAuthor);
          await command(request, {
            kind: 'authority.update',
            principalId: current.id,
            expectedRevision: current.revision,
            capabilities: current.capabilities.filter((capability) => capability !== 'briefing:ack'),
          });
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
  }
});
