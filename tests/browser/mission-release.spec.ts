import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  CommandResponse,
  FlightMissionRevisionResponse,
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseRecordResponse,
  MissionReleaseValidityResponse,
  MissionSource,
} from '@ledger/contracts';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  api,
  authorization,
  releaseAuthor,
  source,
  read,
  principal,
  command,
  createFlight,
  mission,
  acceptedControl,
  localMinute,
  attestReleaseFindings,
  releaseFindingsDigest,
} from './mission-fixture.js';

test('a revised clear route permits Sam to record an exact release after refreshing a retained draft', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = randomUUID();
  const sourceId = `browser-release-${identity}`;
  const dispatcher = await principal(request);
  const sam = await principal(request, releaseAuthor);
  const originalSource = await principal(request, source);
  const addedSourceCapabilities = ['mission:write'].filter(
    (capability) => !originalSource.capabilities.some((current) => current === capability),
  );
  const addedRiskCapability = !dispatcher.capabilities.some((capability) =>
    ['risk:accept:medium', 'risk:accept:high'].includes(capability),
  );
  let sourceGranted = false;
  let riskGranted = false;
  let releaseGranted = false;

  try {
    await command(request, {
      kind: 'authority.update',
      principalId: originalSource.id,
      expectedRevision: originalSource.revision,
      capabilities: [...new Set([...originalSource.capabilities, 'mission:write' as const])],
      missionSources: [...originalSource.missionSources, sourceId],
    });
    sourceGranted = true;
    if (addedRiskCapability) {
      await command(request, {
        kind: 'authority.update',
        principalId: dispatcher.id,
        expectedRevision: dispatcher.revision,
        capabilities: [...dispatcher.capabilities, 'risk:accept:medium'],
      });
      riskGranted = true;
    }
    if (!sam.capabilities.includes('mission:release')) {
      await command(request, {
        kind: 'authority.update',
        principalId: sam.id,
        expectedRevision: sam.revision,
        capabilities: [...sam.capabilities, 'mission:release'],
      });
      releaseGranted = true;
    }

    const starts = Math.floor((Date.now() + 7 * 24 * 60 * 60_000) / 60_000) * 60_000 + 250;
    const interval = { start: new Date(starts).toISOString(), end: new Date(starts + 60 * 60_000).toISOString() };
    const hazard = await acceptedControl(request, sourceId, identity, interval, dispatcher);
    const { control, acceptance } = hazard;
    const aircraft = `Browser route aircraft ${identity.slice(0, 6)}`;
    const flight = await createFlight(
      request,
      `Route release ${identity.slice(0, 6)}`,
      aircraft,
      starts,
      starts + 60 * 60_000,
    );
    const first: MissionSource = {
      sourceMissionId: `browser-release-mission-${identity}`,
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
            [-87.625, 41.88],
          ],
        },
      },
      lateralToleranceMeters: 30,
      altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
      operatingInterval: interval,
    };
    await mission(request, flight.id, sourceId, first);
    const preview = () =>
      read<MissionAvoidanceResponse>(request, `/v1/flights/${flight.id}/mission-avoidance`, releaseAuthor);
    await expect.poll(async () => (await preview()).status).toBe('intersects');
    const blocked = await preview();
    expect(blocked.candidates.find((candidate) => candidate.controlEventId === control.id)).toMatchObject({
      geometry: 'intersects',
      context: 'current',
    });

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('actor');
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await expect(page.locator('.topbar-user')).toContainText(sam.name);
    const selectedFlight = page.getByTestId(`flight-row-${flight.id}`);
    const originFlight = page.getByTestId(`flight-row-${hazard.origin.flightId}`);
    const flightWindows = page.getByTestId('flight-windows');
    const requestedWindow = page.getByTestId('requested-window');
    const missionWindow = page.getByTestId('mission-window');
    const centralTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    await originFlight.click();
    await expect(flightWindows).toContainText('No mission recorded');
    const missionPattern = `**/v1/flights/${flight.id}/mission`;
    let releaseMission!: () => void;
    const missionGate = new Promise<void>((resolve) => {
      releaseMission = resolve;
    });
    let missionReadStarted = false;
    let missionReadDelivered = false;
    let holdMissionReads = true;
    const pendingMissionReads: Promise<void>[] = [];
    await page.route(missionPattern, (route) => {
      if (!holdMissionReads) return route.continue();
      missionReadStarted = true;
      const delivered = (async () => {
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(200);
        await missionGate;
        await route.fulfill({ response });
        missionReadDelivered = true;
      })();
      pendingMissionReads.push(delivered);
      return delivered;
    });
    try {
      await selectedFlight.click();
      await expect.poll(() => missionReadStarted).toBe(true);
      await expect(flightWindows).toContainText('Checking recorded mission');
      await expect(requestedWindow).toContainText(centralTime.format(new Date(interval.start)));
      await expect(requestedWindow).toContainText(centralTime.format(new Date(interval.end)));
      await originFlight.click();
      await expect(originFlight).toHaveAttribute('aria-pressed', 'true');
      await expect(flightWindows).toContainText('No mission recorded');
      holdMissionReads = false;
      releaseMission();
      await Promise.all(pendingMissionReads);
      await expect.poll(() => missionReadDelivered).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await expect(originFlight).toHaveAttribute('aria-pressed', 'true');
      await expect(flightWindows).toContainText('No mission recorded');
      await expect(missionWindow).not.toContainText('Revision 1');
    } finally {
      holdMissionReads = false;
      releaseMission();
      await Promise.allSettled(pendingMissionReads);
      await page.unroute(missionPattern);
    }
    await selectedFlight.click();
    await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Mission review', exact: true });
    await expect(workspace.getByRole('heading', { name: 'Mission route and release', exact: true })).toBeVisible();
    await expect(workspace).toContainText('Mission revision 1');
    await expect(workspace).toContainText('Route intersects an accepted control');
    await expect(workspace).toContainText(control.label);
    await expect(workspace).toContainText(control.description);
    await expect(workspace.getByRole('button', { name: 'Prepare release', exact: true })).toBeDisabled();
    // The accepted controls in scope are listed beside route review, each with its current result.
    await expect(
      workspace.getByRole('region', { name: 'Controls in scope for this flight', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mission-route-intersects.png') });

    const second: MissionSource = {
      ...first,
      sourceRevision: 2,
      occurredAt: new Date().toISOString(),
      route: {
        ...first.route,
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
    };
    await mission(request, flight.id, sourceId, second);
    await expect(workspace).toContainText('Mission revision 2');
    await expect(workspace).toContainText('Outside accepted avoidance areas');
    await workspace.getByRole('button', { name: 'Prepare release', exact: true }).click();
    const form = workspace.getByTestId('mission-release-form');
    await expect(form.getByLabel('Departure window starts', { exact: true })).toBeFocused();
    expect(
      await form
        .getByLabel('Departure window starts', { exact: true })
        .evaluate((field: HTMLInputElement) => Date.parse(field.value)),
    ).toBe(starts);
    await expect(
      form.getByText('The departure window must fit within this exact mission’s operating interval.', { exact: true }),
    ).toHaveCount(0);
    const window = {
      start: Math.floor(starts / 60_000) * 60_000 + 5 * 60_000,
      end: Math.floor(starts / 60_000) * 60_000 + 30 * 60_000,
    };
    const from = await localMinute(page, window.start);
    const until = await localMinute(page, window.end);
    const note = 'Release the exact revised route and its corridor outside the accepted market avoidance area.';
    await form.getByLabel('Departure window starts', { exact: true }).fill(from);
    await form.getByLabel('Departure window ends', { exact: true }).fill(until);
    await form.getByLabel('Release note', { exact: true }).fill(note);
    await expect(form.getByRole('region', { name: 'Open findings in this release' })).toBeVisible();
    await attestReleaseFindings(form);
    await expect(form.getByRole('button', { name: 'Record mission release', exact: true })).toBeEnabled();

    const third: MissionSource = {
      ...second,
      sourceRevision: 3,
      occurredAt: new Date().toISOString(),
      lateralToleranceMeters: 35,
      operatingInterval: {
        start: new Date(starts + 2 * 60_000).toISOString(),
        end: new Date(starts + 58 * 60_000).toISOString(),
      },
    };
    const revised = await mission(request, flight.id, sourceId, third);
    await expect(form).toContainText('Your draft is retained.');
    await expect(form.getByLabel('Release note', { exact: true })).toHaveValue(note);
    await expect(form.getByLabel('Departure window starts', { exact: true })).toHaveValue(from);
    await expect(form.getByLabel('Departure window ends', { exact: true })).toHaveValue(until);
    await expect(form.getByRole('button', { name: 'Record mission release', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('mission-release-draft-refresh.png') });
    await form.getByRole('button', { name: 'Refresh basis', exact: true }).click();
    await expect(workspace).toContainText('Mission revision 3');
    await expect(form.getByLabel('Release note', { exact: true })).toHaveValue(note);
    await expect(form.getByLabel('Departure window starts', { exact: true })).toHaveValue(from);
    await expect(form.getByLabel('Departure window ends', { exact: true })).toHaveValue(until);
    await attestReleaseFindings(form);
    await expect(form.getByRole('button', { name: 'Record mission release', exact: true })).toBeEnabled();
    const current = await preview();
    const findingsDigest = await releaseFindingsDigest(request, flight.id, releaseAuthor);
    expect(current.status).toBe('outside');
    expect(current.candidateCompleteness.status).toBe('complete');
    const recordedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.kind === 'mission.release',
    );
    await form.getByRole('button', { name: 'Record mission release', exact: true }).click();
    const recorded = await recordedResponse;
    expect(recorded.status(), await recorded.text()).toBe(201);
    const submitted = recorded.request().postDataJSON() as MissionReleaseCommand;
    const result = (await recorded.json()) as CommandResponse;
    const releaseId = result.command.id;
    expect(submitted).toMatchObject({
      kind: 'mission.release',
      flightId: flight.id,
      aircraftId: aircraft,
      mission: current.mission,
      expectedContextDigest: current.contextDigest,
      expectedFindingsDigest: findingsDigest,
      departureWindow: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
      note,
    });
    const exactPath = `/v1/flights/${flight.id}/mission-releases/${releaseId}`;
    const retained = await read<MissionReleaseRecordResponse>(request, exactPath, releaseAuthor);
    expect(retained.digest).toBe(canonicalDigest(retained.release));
    expect(retained.release).toMatchObject({
      version: 'flight.mission-release.2',
      id: releaseId,
      flightId: flight.id,
      aircraftId: aircraft,
      departureWindow: submitted.departureWindow,
      note,
      actor: {
        id: sam.id,
        name: sam.name,
        principalRevision: submitted.expectedPrincipalRevision,
        checkedCapabilities: ['decision:write', 'flight:read', 'mission:release'],
      },
      basis: {
        mission: { id: revised.eventId, sourceRevision: 3, route: third.route, lateralToleranceMeters: 35 },
        avoidance: {
          status: 'outside',
          contextDigest: submitted.expectedContextDigest,
          candidateCompleteness: { status: 'complete' },
        },
        findings: { digest: findingsDigest },
      },
    });
    expect(retained.release.basis.avoidance.candidates).toEqual(current.candidates);
    const candidate = retained.release.basis.avoidance.candidates.find((item) => item.controlEventId === control.id)!;
    expect(candidate).toMatchObject({
      hazardId: hazard.id,
      controlId: control.controlId,
      controlVersion: control.controlVersion,
      controlDigest: control.bodyDigest,
      acceptance: { id: acceptance.id, digest: acceptance.digest },
      geometry: 'outside',
      context: 'current',
    });
    const exactMission = await read<FlightMissionRevisionResponse>(
      request,
      `/v1/flights/${flight.id}/mission/revisions/3`,
      releaseAuthor,
    );
    expect(retained.release.basis.mission).toEqual(exactMission.mission);
    expect(canonicalDigest(exactMission.mission)).toBe(submitted.mission.recordDigest);
    const originalMission = await read<FlightMissionRevisionResponse>(
      request,
      `/v1/flights/${flight.id}/mission/revisions/1`,
      releaseAuthor,
    );
    expect(originalMission.mission.route).toEqual(first.route);
    await expect
      .poll(async () => {
        const response = await request.get(`${api}${exactPath}/validity`, {
          headers: authorization(releaseAuthor),
        });
        if (response.status() === 409 && (await response.json()).error?.code === 'concurrent_change') return null;
        expect(response.ok(), await response.text()).toBeTruthy();
        const validity = (await response.json()) as MissionReleaseValidityResponse;
        return { status: validity.status, processing: validity.processing, digest: validity.currentContextDigest };
      })
      .toEqual({ status: 'scheduled', processing: 'completed', digest: submitted.expectedContextDigest });
    expect(await read<MissionReleaseRecordResponse>(request, exactPath, releaseAuthor)).toEqual(retained);
    await expect(workspace.getByText('Recorded release', { exact: true })).toBeVisible();
    await expect(workspace).toContainText('Current release status');
    await expect(workspace).toContainText('Departure window has not started');
    await expect(workspace).toContainText(note);
    await page.screenshot({ path: testInfo.outputPath('mission-release-recorded.png') });

    await workspace.getByRole('button', { name: `Return to ${flight.label}`, exact: true }).click();
    await expect(workspace).toBeHidden();
    await expect(selectedFlight).toHaveAttribute('aria-pressed', 'true');
    await expect(requestedWindow).toContainText(centralTime.format(new Date(interval.start)));
    await expect(requestedWindow).toContainText(centralTime.format(new Date(interval.end)));
    await expect(missionWindow).toContainText('Current mission window');
    await expect(missionWindow).toContainText(centralTime.format(new Date(third.operatingInterval.start)));
    await expect(missionWindow).toContainText(centralTime.format(new Date(third.operatingInterval.end)));
    await expect(missionWindow).toContainText('Revision 3');
    const releaseItem = page.getByTestId(`timeline-item-${releaseId}`);
    await releaseItem.click();
    await expect(releaseItem).toHaveAttribute('aria-pressed', 'true');
    const inspector = page.getByTestId('mission-inspection');
    await expect(inspector).toContainText(note);
    await expect(inspector).toContainText(sam.name);
    await expect(inspector).toContainText(control.label);
    await expect(inspector).toContainText('Current release status');
    await expect(inspector).toContainText('Departure window has not started');
  } finally {
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
        if (releaseGranted) {
          const current = await principal(request, releaseAuthor);
          await command(request, {
            kind: 'authority.update',
            principalId: current.id,
            expectedRevision: current.revision,
            capabilities: current.capabilities.filter((capability) => capability !== 'mission:release'),
          });
        }
      } finally {
        if (riskGranted) {
          const current = await principal(request);
          await command(request, {
            kind: 'authority.update',
            principalId: current.id,
            expectedRevision: current.revision,
            capabilities: current.capabilities.filter((capability) => capability !== 'risk:accept:medium'),
          });
        }
      }
    }
  }
});
