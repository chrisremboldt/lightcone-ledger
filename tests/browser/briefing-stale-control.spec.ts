import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseValidityResponse,
  MissionSource,
} from '@ledger/contracts';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  acceptedControl,
  command,
  createFlight,
  mission,
  principal,
  read,
  releaseFindingsDigest,
  source,
} from './mission-fixture.js';

test('a control read answered 404 once leaves the briefing workspace usable without a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const identity = randomUUID();
  const sourceId = `browser-briefing-stale-${identity}`;
  const author = await principal(request);
  const originalSource = await principal(request, source);
  const addedSourceCapability = !originalSource.capabilities.includes('mission:write');
  const addedAuthorCapabilities: typeof author.capabilities = (['mission:release'] as const).filter(
    (capability) => !author.capabilities.includes(capability),
  );
  if (!author.capabilities.some((capability) => ['risk:accept:medium', 'risk:accept:high'].includes(capability)))
    addedAuthorCapabilities.push('risk:accept:medium');
  let sourceGranted = false;
  let authorGranted = false;
  let controlPattern: string | undefined;

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
        principalId: author.id,
        expectedRevision: author.revision,
        capabilities: [...author.capabilities, ...addedAuthorCapabilities],
      });
      authorGranted = true;
    }

    // A route around one accepted avoidance area, thirteen days out so no other test's area overlaps it.
    const starts = Math.floor((Date.now() + 13 * 24 * 60 * 60_000) / 60_000) * 60_000;
    const interval = { start: new Date(starts).toISOString(), end: new Date(starts + 60 * 60_000).toISOString() };
    const hazard = await acceptedControl(request, sourceId, identity, interval, author);
    const { control } = hazard;
    const aircraft = `Browser briefing stale aircraft ${identity.slice(0, 6)}`;
    const flight = await createFlight(
      request,
      `Briefing stale control ${identity.slice(0, 6)}`,
      aircraft,
      starts,
      starts + 60 * 60_000,
    );
    const raw: MissionSource = {
      sourceMissionId: `browser-briefing-stale-mission-${identity}`,
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
    await mission(request, flight.id, sourceId, raw);
    const preview = () => read<MissionAvoidanceResponse>(request, `/v1/flights/${flight.id}/mission-avoidance`);
    await expect
      .poll(async () => {
        const current = await preview();
        return current.status === 'outside' && current.candidates.some((entry) => entry.controlEventId === control.id);
      })
      .toBe(true);
    const reviewed = await preview();
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
      note: 'Release this exact clear route; one accepted area is listed beside it.',
    };
    const releaseId = (await command(request, releaseBody)).command.id;
    await expect
      .poll(
        async () =>
          (
            await read<MissionReleaseValidityResponse>(
              request,
              `/v1/flights/${flight.id}/mission-releases/${releaseId}/validity`,
            )
          ).processing,
      )
      .toBe('completed');

    // Once armed, the next read of the released control is answered 404, as it would be if the listed version were no
    // longer reachable after the release listed it. Every other read reaches the API. It is armed only when the
    // briefing opens, so the record inspection and mission review read the control as usual.
    controlPattern = `**/v1/area-controls/${encodeURIComponent(control.hazardId)}/${encodeURIComponent(control.controlId)}/versions/${control.controlVersion}`;
    let armed = false;
    let answered404 = false;
    let readsAfter404 = 0;
    await page.route(controlPattern, async (route) => {
      if (!armed || answered404) {
        if (answered404) readsAfter404++;
        return route.continue();
      }
      answered404 = true;
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
    await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('operator');
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    // Records whether the briefing ever reported lost access or interrupted updates; the markers are gone on a reload.
    await page.evaluate(() => {
      const marker = window as unknown as { briefingAccessChanged?: boolean; releaseInterrupted?: boolean };
      marker.briefingAccessChanged = false;
      marker.releaseInterrupted = false;
      new MutationObserver(() => {
        const text = document.body.innerText;
        if (text.includes('Briefing access changed')) marker.briefingAccessChanged = true;
        if (text.includes('Release updates interrupted')) marker.releaseInterrupted = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByTestId(`flight-row-${flight.id}`).click();
    await page.getByTestId(`timeline-item-${releaseId}`).click();
    await page
      .getByTestId('mission-inspection')
      .getByRole('button', { name: /^Review mission, release and briefing/ })
      .click();
    const missionWorkspace = page.getByRole('region', { name: 'Mission review', exact: true });
    await expect(missionWorkspace.getByRole('button', { name: /^Prepare briefing/ })).toBeVisible();
    armed = true;
    await missionWorkspace.getByRole('button', { name: /^Prepare briefing/ }).click();
    const workspace = page.getByRole('region', { name: 'Mission briefing', exact: true });

    // The workspace read the listed control again at once, shows it with its release, and keeps polling.
    await expect.poll(() => answered404).toBe(true);
    await expect.poll(() => readsAfter404).toBeGreaterThanOrEqual(1);
    await expect(workspace).toContainText(`${control.label} · control version ${control.controlVersion}`);
    await expect(workspace.getByRole('region', { name: 'Current release status', exact: true })).toBeVisible();
    await expect(workspace).not.toContainText('Briefing access changed');
    await expect(workspace).not.toContainText('Release updates interrupted');
    expect(
      await page.evaluate(() => {
        const marker = window as unknown as { briefingAccessChanged?: boolean; releaseInterrupted?: boolean };
        return { accessChanged: marker.briefingAccessChanged, interrupted: marker.releaseInterrupted };
      }),
    ).toEqual({ accessChanged: false, interrupted: false });
  } finally {
    try {
      if (controlPattern) await page.unroute(controlPattern);
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
