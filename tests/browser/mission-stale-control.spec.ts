import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { MissionAvoidanceResponse, MissionSource } from '@ledger/contracts';
import {
  source,
  read,
  principal,
  command,
  createFlight,
  mission,
  acceptedControl,
  supersedeControl,
} from './mission-fixture.js';

test('a control superseded while the mission review reads it leaves the review usable without a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const identity = randomUUID();
  const sourceId = `browser-stale-control-${identity}`;
  const dispatcher = await principal(request);
  const originalSource = await principal(request, source);
  const addedSourceCapability = !originalSource.capabilities.includes('mission:write');
  const addedRiskCapability = !dispatcher.capabilities.some((capability) =>
    ['risk:accept:medium', 'risk:accept:high'].includes(capability),
  );
  let sourceGranted = false;
  let riskGranted = false;

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

    // A flight planned through an accepted avoidance area, eleven days out so no other test's area overlaps it.
    const starts = Math.floor((Date.now() + 11 * 24 * 60 * 60_000) / 60_000) * 60_000 + 500;
    const interval = { start: new Date(starts).toISOString(), end: new Date(starts + 60 * 60_000).toISOString() };
    const hazard = await acceptedControl(request, sourceId, identity, interval, dispatcher);
    const { control } = hazard;
    const aircraft = `Browser stale control aircraft ${identity.slice(0, 6)}`;
    const flight = await createFlight(
      request,
      `Stale control ${identity.slice(0, 6)}`,
      aircraft,
      starts,
      starts + 60 * 60_000,
    );
    const raw: MissionSource = {
      sourceMissionId: `browser-stale-control-mission-${identity}`,
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
    await mission(request, flight.id, sourceId, raw);
    const preview = () => read<MissionAvoidanceResponse>(request, `/v1/flights/${flight.id}/mission-avoidance`);
    await expect
      .poll(async () => (await preview()).candidates.some((candidate) => candidate.controlEventId === control.id))
      .toBe(true);

    // The first read of the listed control version finds it superseded: the dispatcher records a new version of the
    // control through the API between the preview that lists it and the read that fetches it. The API keeps an
    // accepted version readable after a new version is recorded, so that read is answered 404 here, as it would be
    // if the listed version were no longer reachable. Every later read reaches the API.
    const controlPattern = `**/v1/area-controls/${encodeURIComponent(control.hazardId)}/${encodeURIComponent(control.controlId)}/versions/${control.controlVersion}`;
    let controlReads = 0;
    let superseded = false;
    await page.route(controlPattern, async (route) => {
      controlReads++;
      if (superseded) return route.continue();
      await supersedeControl(request, hazard, dispatcher);
      superseded = true;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'area_control_not_found',
            message: 'The accepted area control was not found within your scope',
          },
        }),
      });
    });

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    // Records whether the review ever reported lost access; the marker is gone if the page reloads.
    await page.evaluate(() => {
      const marker = window as unknown as { missionAccessChanged?: boolean };
      marker.missionAccessChanged = false;
      new MutationObserver(() => {
        if (document.body.innerText.includes('Mission access changed')) marker.missionAccessChanged = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByTestId(`flight-row-${flight.id}`).click();
    await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Mission review', exact: true });

    await expect.poll(() => superseded).toBe(true);
    await expect(workspace).toContainText('Mission revision 1');
    await expect(workspace).not.toContainText('Mission updates interrupted');
    const relisted = (await preview()).candidates.some((candidate) => candidate.controlEventId === control.id);
    if (relisted) {
      // The review read the listed control again at once and shows it.
      await expect.poll(() => controlReads).toBeGreaterThanOrEqual(2);
      await expect(workspace.getByRole('heading', { name: control.label })).toBeVisible();
    }
    await expect(workspace.getByRole('button', { name: 'Prepare release', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { missionAccessChanged?: boolean }).missionAccessChanged),
    ).toBe(false);
    await page.unroute(controlPattern);
  } finally {
    try {
      if (sourceGranted) {
        const current = await principal(request, source);
        await command(request, {
          kind: 'authority.update',
          principalId: current.id,
          expectedRevision: current.revision,
          capabilities: addedSourceCapability
            ? current.capabilities.filter((capability) => capability !== 'mission:write')
            : current.capabilities,
          missionSources: current.missionSources.filter((grant) => grant !== sourceId),
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
});
