import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerClient, MissionAdapter } from '../../packages/adapters/src/index.js';
import type {
  FlightListResponse,
  FlightMissionResponse,
  FlightPredepartureResponse,
  MissionAvoidanceResponse,
  MissionReleaseCommand,
  MissionReleaseRecordResponse,
} from '@ledger/contracts';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { operationCapacityPreset } from '../../packages/simulation-models/dist/operation.js';
import { OperationDelivery } from '../../apps/simulator/src/operation-delivery.js';
import { OperationOrdinaryDispatchRuntime } from '../../apps/simulator/src/operation-ordinary-runtime.js';
import { initialOperationCheckpoint, OperationStore } from '../../apps/simulator/src/operation-state.js';
import { scenarioConfig } from '../../apps/simulator/src/scenario.js';
import {
  acceptedControl,
  api,
  command,
  complete,
  principal,
  read,
  releaseFindingsDigest,
  source,
} from './mission-fixture.js';
import { routeFixtureWorld, sourcePass } from './operation-fixture.js';

test('a control read answered 404 once leaves the departure progress usable without a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const identity = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ledger-browser-departure-stale-'));
  const originalOperator = await principal(request);
  const originalSource = await principal(request, source);
  const sourceId = `browser-departure-stale-${identity}`;
  let operatorGranted = false;
  let sourceGranted = false;
  let controlPattern: string | undefined;
  try {
    await command(request, {
      kind: 'authority.update',
      principalId: originalSource.id,
      expectedRevision: originalSource.revision,
      capabilities: [
        ...new Set([
          ...originalSource.capabilities,
          'input:write' as const,
          'mission:write' as const,
          'decision:write' as const,
          'mission:release' as const,
        ]),
      ],
      missionSources: [...new Set([...originalSource.missionSources, 'mission-planner'])],
    });
    sourceGranted = true;
    await command(request, {
      kind: 'authority.update',
      principalId: originalOperator.id,
      expectedRevision: originalOperator.revision,
      capabilities: [
        ...new Set([
          ...originalOperator.capabilities,
          'input:write' as const,
          'mission:write' as const,
          'mission:release' as const,
          'decision:write' as const,
          'risk:accept:medium' as const,
        ]),
      ],
      missionSources: [...new Set([...originalOperator.missionSources, 'mission-planner'])],
    });
    operatorGranted = true;
    const owner = await principal(request);

    // An ordinary customer flight whose source reports departure progress, as in avoidance-route.spec.ts.
    const start = Date.now() - 5 * 60_000;
    const runId = `browser-departure-${identity.slice(0, 16)}`;
    const attemptId = `intent-${runId}-alpha-0:attempt:1`;
    const { world, clock, inGeography } = routeFixtureWorld({
      ...operationCapacityPreset('illustrative-25.1'),
      runId,
      start: new Date(start).toISOString(),
      seed: 71031,
      fleet: { alpha: 1, beta: 1 },
      sampleIntervalMs: 1000,
      predeparture: { version: 'reserve-selected-await-release.1', tenant: 'alpha', attemptId },
      selectedDemandWindow: {
        attemptId,
        start: new Date(start + 60_000).toISOString(),
        end: new Date(start + 30 * 60_000).toISOString(),
      },
    });
    const store = new OperationStore(
      join(directory, 'world.json'),
      initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
    );
    await store.update(() => {});
    const reservation = structuredClone(store.state.world.reservations!.find((row) => row.id === attemptId)!);
    const delivery = new OperationDelivery({ ...scenarioConfig({ LEDGER_API_URL: api }), stateDirectory: directory });
    const orders = store.state.pending[attemptId]!.filter((entry) => entry.fact.kind === 'order');
    const order = orders.at(-1)!;
    if (order.fact.kind !== 'order') throw new Error('Selected reservation must retain its originating order');
    const orderId = order.fact.order.order_id;
    for (const revision of orders) {
      const accepted = await delivery.deliver(revision);
      await complete(request, accepted.receiptId);
      await store.accept(revision, accepted.receiptId);
    }
    let flight: FlightListResponse['flights'][number] | undefined;
    await expect
      .poll(async () => {
        const found = await read<FlightListResponse>(
          request,
          `/v1/flights?search=${encodeURIComponent(orderId)}&limit=200`,
        );
        flight = found.flights.find((row) => row.originationKey === attemptId);
        return Boolean(flight);
      })
      .toBe(true);
    const flightId = flight!.id;
    const initial = store.state.pending[attemptId]!.find((entry) => entry.fact.kind === 'mission')!;
    const missionAdapter = new MissionAdapter({
      ledger: new LedgerClient(api, source),
      tenantId: 'tenant-alpha',
      sourceId: 'mission-planner',
      sourceMissionId: reservation.plan.sourceMissionId,
      aircraftId: reservation.aircraftId,
      flightId,
    });
    const submitted = await missionAdapter.send(
      await missionAdapter.prepare(Buffer.from(initial.bytesBase64, 'base64')),
    );
    await complete(request, submitted.receipt.receipt.id);
    await store.accept(initial, submitted.receipt.receipt.id);

    // One accepted area well clear of the route, so the route stays clear and the release still lists the control.
    let head: FlightMissionResponse | undefined;
    await expect
      .poll(async () => {
        head = await read<FlightMissionResponse>(request, `/v1/flights/${flightId}/mission`);
        return Boolean(head.projectedHead);
      })
      .toBe(true);
    const coordinates = head!.projectedHead!.route.geometry.coordinates;
    const longitudes = coordinates.map(([longitude]) => longitude!);
    const latitudes = coordinates.map(([, latitude]) => latitude!);
    const hazard = await acceptedControl(
      request,
      sourceId,
      identity,
      reservation.plan.operatingInterval,
      owner,
      {
        center: {
          latitude: Math.max(...latitudes) + 0.03,
          longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
        },
        radiusMeters: 70,
      },
      `Departure progress precaution ${identity.slice(0, 6)}`,
    );
    const { control } = hazard;

    const runtime = new OperationOrdinaryDispatchRuntime({
      apiUrl: api,
      directory: join(directory, 'ordinary'),
      clock,
      tenants: {
        alpha: {
          sourceToken: source,
          actorToken: source,
          sourcePrincipalId: originalSource.id,
          automaticReleasePrincipalId: originalSource.id,
        },
        beta: {
          sourceToken: 'ledger-dev-beta-source',
          actorToken: 'ledger-dev-beta-source',
          sourcePrincipalId: 'principal-beta-source',
          automaticReleasePrincipalId: 'principal-beta-source',
        },
      },
    });
    async function sourceProgress() {
      await store.update((state) => clock(state, Date.now()));
      await sourcePass(() => inGeography(() => runtime.run(store)));
      return read<FlightPredepartureResponse>(request, `/v1/flights/${flightId}/predeparture`);
    }
    // The source releases a clear route itself or holds it for a human release; either way the progress names a release.
    let progress: FlightPredepartureResponse['progress'] = null;
    await expect
      .poll(
        async () => {
          progress = (await sourceProgress()).progress;
          return Boolean(progress?.references.release) || progress?.phase === 'awaiting_release';
        },
        { timeout: 30_000, message: 'The ordinary flight must reach a release' },
      )
      .toBe(true);
    if (!progress!.references.release) {
      const reviewed = await read<MissionAvoidanceResponse>(request, `/v1/flights/${flightId}/mission-avoidance`);
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      const releaseBody: MissionReleaseCommand = {
        kind: 'mission.release',
        flightId,
        aircraftId: reservation.aircraftId,
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
        expectedFindingsDigest: await releaseFindingsDigest(request, flightId),
        expectedPrincipalRevision: (await principal(request)).revision,
        departureWindow: { start: new Date(now).toISOString(), end: new Date(now + 10 * 60_000).toISOString() },
        note: 'Release this exact clear route; one accepted area is listed beside it.',
      };
      await command(request, releaseBody);
      await expect
        .poll(
          async () => {
            progress = (await sourceProgress()).progress;
            return Boolean(progress?.references.release);
          },
          { timeout: 30_000, message: 'The departure progress must name the recorded release' },
        )
        .toBe(true);
    }
    const release = await read<MissionReleaseRecordResponse>(
      request,
      `/v1/flights/${flightId}/mission-releases/${progress!.references.release!.id}`,
    );
    expect(release.release.basis.avoidance.candidates.map((candidate) => candidate.controlEventId)).toContain(
      control.id,
    );

    // The first read of the released control is answered 404, as it would be if the listed version were no longer
    // reachable after the progress listed it. Every later read reaches the API.
    controlPattern = `**/v1/area-controls/${encodeURIComponent(control.hazardId)}/${encodeURIComponent(control.controlId)}/versions/${control.controlVersion}`;
    let controlReads = 0;
    await page.route(controlPattern, async (route) => {
      controlReads++;
      if (controlReads > 1) return route.continue();
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
    // Records whether the panel ever cleared or reported interrupted updates; the markers are gone if the page reloads.
    await page.evaluate(() => {
      const marker = window as unknown as { departureUnavailable?: boolean; departureInterrupted?: boolean };
      marker.departureUnavailable = false;
      marker.departureInterrupted = false;
      new MutationObserver(() => {
        const text = document.body.innerText;
        if (text.includes('Departure progress unavailable')) marker.departureUnavailable = true;
        if (text.includes('Departure updates interrupted')) marker.departureInterrupted = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByTestId(`flight-row-${flightId}`).click();
    const panel = page.getByRole('region', { name: 'Flight departure progress', exact: true });

    // The panel read the listed control again at once and shows the release it belongs to.
    await expect.poll(() => controlReads).toBeGreaterThanOrEqual(2);
    await expect(panel).toContainText(`Release recorded by ${release.release.actor.name}`);
    await expect(panel).not.toContainText('Departure updates interrupted');
    expect(
      await page.evaluate(() => {
        const marker = window as unknown as { departureUnavailable?: boolean; departureInterrupted?: boolean };
        return { unavailable: marker.departureUnavailable, interrupted: marker.departureInterrupted };
      }),
    ).toEqual({ unavailable: false, interrupted: false });
  } finally {
    try {
      if (controlPattern) await page.unroute(controlPattern);
      if (sourceGranted) {
        const current = await principal(request, source);
        await command(request, {
          kind: 'authority.update',
          principalId: current.id,
          expectedRevision: current.revision,
          capabilities: originalSource.capabilities,
          missionSources: originalSource.missionSources,
        });
      }
    } finally {
      try {
        if (operatorGranted) {
          const current = await principal(request);
          await command(request, {
            kind: 'authority.update',
            principalId: current.id,
            expectedRevision: current.revision,
            capabilities: originalOperator.capabilities,
            missionSources: originalOperator.missionSources,
          });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
