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
import { fitCoordinates, type Coordinate } from '../../apps/web/src/geography.js';
import {
  applicabilityCountWords,
  briefingOthersWords,
  departureBriefingWords,
  notApplicableHeading,
} from '../../apps/web/src/flight-controls.js';
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

const metresPerDegree = 111_320;

/** The planar distance in metres from a point to a route, near enough for choosing a point well clear of it. */
function distanceToRoute(point: Coordinate, route: Coordinate[]): number {
  const scale = Math.cos((point.latitude * Math.PI) / 180);
  const local = (at: Coordinate) => ({
    x: (at.longitude - point.longitude) * metresPerDegree * scale,
    y: (at.latitude - point.latitude) * metresPerDegree,
  });
  let nearest = Infinity;
  for (let index = 1; index < route.length; index++) {
    const from = local(route[index - 1]!);
    const to = local(route[index]!);
    const length = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
    const t = length ? Math.max(0, Math.min(1, -(from.x * (to.x - from.x) + from.y * (to.y - from.y)) / length)) : 0;
    nearest = Math.min(nearest, Math.hypot(from.x + t * (to.x - from.x), from.y + t * (to.y - from.y)));
  }
  return nearest;
}

/** Of a grid over the middle of the route map's view, the point farthest from the route. */
function clearPointInView(route: Coordinate[]): { point: Coordinate; clearance: number } {
  const view = fitCoordinates(route)!;
  const middle = { latitude: (view.north + view.south) / 2, longitude: (view.west + view.east) / 2 };
  const latitudeSpan = (view.north - view.south) * 0.3;
  const longitudeSpan = (view.east - view.west) * 0.3;
  let best = { point: middle, clearance: distanceToRoute(middle, route) };
  for (let row = -5; row <= 5; row++)
    for (let column = -5; column <= 5; column++) {
      const point = {
        latitude: middle.latitude + (row / 5) * latitudeSpan,
        longitude: middle.longitude + (column / 5) * longitudeSpan,
      };
      const clearance = distanceToRoute(point, route);
      if (clearance > best.clearance) best = { point, clearance };
    }
  return best;
}

test('a flight shows the control that applies and explains, on every screen, the controls that do not', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  const identity = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ledger-browser-applicability-'));
  const originalOperator = await principal(request);
  const originalSource = await principal(request, source);
  const sourceId = `browser-applicability-${identity}`;
  let operatorGranted = false;
  let sourceGranted = false;
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
          'briefing:write' as const,
          'risk:accept:medium' as const,
        ]),
      ],
      missionSources: [...new Set([...originalOperator.missionSources, 'mission-planner'])],
    });
    operatorGranted = true;
    const owner = await principal(request);

    // An ordinary customer flight whose source reports departure progress, as in departure-stale-control.spec.ts.
    const start = Date.now() - 5 * 60_000;
    const runId = `browser-applicability-${identity.slice(0, 16)}`;
    const attemptId = `intent-${runId}-alpha-0:attempt:1`;
    const { world, clock, inGeography } = routeFixtureWorld({
      ...operationCapacityPreset('illustrative-25.1'),
      runId,
      start: new Date(start).toISOString(),
      seed: 71047,
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
    let head: FlightMissionResponse | undefined;
    await expect
      .poll(async () => {
        head = await read<FlightMissionResponse>(request, `/v1/flights/${flightId}/mission`);
        return Boolean(head.projectedHead);
      })
      .toBe(true);
    const route = head!.projectedHead!.route.geometry.coordinates.map(([longitude, latitude]) => ({
      longitude: longitude!,
      latitude: latitude!,
    }));
    const northmost = Math.max(...route.map((point) => point.latitude));
    const middleLongitude =
      (Math.min(...route.map((point) => point.longitude)) + Math.max(...route.map((point) => point.longitude))) / 2;
    const interval = reservation.plan.operatingInterval;

    // One area about 3 km north of the route whose reach covers it, so it applies and the route stays outside it; one
    // about 33 km north with a 500 m reach, and one in the middle of the route's map with a 1 m reach: neither applies.
    const near = await acceptedControl(
      request,
      sourceId,
      `near-${identity}`,
      interval,
      owner,
      {
        center: { latitude: northmost + 0.03, longitude: middleLongitude },
        radiusMeters: 70,
        appliesWithinMeters: 5000,
      },
      `Applies within its reach ${identity.slice(0, 6)}`,
    );
    const far = await acceptedControl(
      request,
      sourceId,
      `far-${identity}`,
      interval,
      owner,
      { center: { latitude: northmost + 0.3, longitude: middleLongitude }, radiusMeters: 70, appliesWithinMeters: 500 },
      `Far quarry ${identity.slice(0, 6)}`,
    );
    const clear = clearPointInView(route);
    expect(clear.clearance, 'The route map must have room for an area clear of the route').toBeGreaterThan(
      head!.projectedHead!.lateralToleranceMeters + 150,
    );
    const local = await acceptedControl(
      request,
      sourceId,
      `local-${identity}`,
      interval,
      owner,
      { center: clear.point, radiusMeters: 20, appliesWithinMeters: 1 },
      `Nearby yard ${identity.slice(0, 6)}`,
    );

    const preview = () => read<MissionAvoidanceResponse>(request, `/v1/flights/${flightId}/mission-avoidance`);
    let reviewed: MissionAvoidanceResponse | undefined;
    await expect
      .poll(async () => {
        reviewed = await preview();
        const listed = (id: string) => reviewed!.notApplicable.some((entry) => entry.controlEventId === id);
        return (
          reviewed.status === 'outside' &&
          reviewed.candidates.some((entry) => entry.controlEventId === near.control.id) &&
          listed(far.control.id) &&
          listed(local.control.id)
        );
      })
      .toBe(true);
    const nearCandidate = reviewed!.candidates.find((entry) => entry.controlEventId === near.control.id)!;
    const farEntry = reviewed!.notApplicable.find((entry) => entry.controlEventId === far.control.id)!;
    const localEntry = reviewed!.notApplicable.find((entry) => entry.controlEventId === local.control.id)!;
    expect(nearCandidate.applicability).toMatchObject({ outcome: 'applies', basis: 'rule' });
    expect(farEntry.applicability).toMatchObject({ outcome: 'does_not_apply', basis: 'rule' });
    expect(farEntry.applicability.summary).toMatch(/^The planned corridor stays at least [\d ]+ m from the area/);
    const rule = farEntry.applicability.rule!;
    const missionRevision = reviewed!.mission!.sourceRevision;

    // The source releases the clear route itself or holds it for a person; either way a release is recorded.
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
      const current = await preview();
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      const releaseBody: MissionReleaseCommand = {
        kind: 'mission.release',
        flightId,
        aircraftId: reservation.aircraftId,
        mission: current.mission!,
        calculation: {
          id: current.calculation.id,
          version: current.calculation.version,
          digest: current.calculation.digest,
        },
        policy: {
          id: missionReleasePolicy.id,
          version: missionReleasePolicy.version,
          digest: missionReleasePolicy.digest,
        },
        expectedContextDigest: current.contextDigest!,
        expectedFindingsDigest: await releaseFindingsDigest(request, flightId),
        expectedPrincipalRevision: (await principal(request)).revision,
        departureWindow: { start: new Date(now).toISOString(), end: new Date(now + 10 * 60_000).toISOString() },
        note: 'Release this exact clear route; the areas that do not apply are recorded beside it.',
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
    const { release } = await read<MissionReleaseRecordResponse>(
      request,
      `/v1/flights/${flightId}/mission-releases/${progress!.references.release!.id}`,
    );
    const { avoidance } = release.basis;
    expect(avoidance.candidates.map((entry) => entry.controlEventId)).toContain(near.control.id);
    expect(avoidance.notApplicable.map((entry) => entry.controlEventId)).toEqual(
      expect.arrayContaining([far.control.id, local.control.id]),
    );
    const shown = await preview();

    // Every screen lists and places a control that does not apply from its route review or release entry alone, so
    // the page never reads the exact version of one.
    const notApplying = new Set(
      [...shown.notApplicable, ...avoidance.notApplicable].map(
        (entry) => `/v1/area-controls/${encodeURIComponent(entry.hazardId)}/${encodeURIComponent(entry.controlId)}/`,
      ),
    );
    const notApplyingReads: string[] = [];
    page.on('request', (sent) => {
      const { pathname } = new URL(sent.url());
      if ([...notApplying].some((prefix) => pathname.startsWith(prefix))) notApplyingReads.push(pathname);
    });

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await page.getByTestId(`flight-row-${flightId}`).click();
    await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Mission review', exact: true });
    const review = workspace.locator('.mission-review-view');

    // Departure progress counts the controls that need a briefing apart from those that do not apply.
    const departure = review.getByRole('region', { name: 'Flight departure progress', exact: true });
    await expect(departure.getByTestId('departure-briefing-count')).toHaveText(
      departureBriefingWords(avoidance.candidates.length, avoidance.notApplicable.length),
    );

    // Mission review: the count line, the candidate as today with its recorded sentence, then the collapsed section.
    await expect(review.getByTestId('route-review-count')).toContainText(
      applicabilityCountWords(shown.candidates.length, shown.notApplicable.length),
    );
    const candidateSummary = review.getByTestId('area-control-summary').filter({ hasText: near.control.label });
    await expect(candidateSummary).toContainText(
      'Applies to flights whose planned route comes within 5 000 m of the area.',
    );
    await expect(candidateSummary.getByTestId('area-control-applicability')).toHaveText(
      nearCandidate.applicability.summary,
    );
    const section = review.getByTestId('route-review-not-applicable');
    await expect(section.locator('summary')).toHaveText(notApplicableHeading(shown.notApplicable.length));
    await expect(section.locator(`[data-control-id="${far.control.controlId}"]`)).toHaveCount(0);
    await section.locator('summary').click();
    if (shown.notApplicable.length > 50)
      await expect(section.getByRole('button', { name: /^Show more/ })).toBeVisible();
    const farRow = section.locator(`[data-control-id="${far.control.controlId}"]`);
    if (!(await farRow.count())) {
      const more = section.getByRole('button', { name: /^Show more/ });
      while (!(await farRow.count()) && (await more.count())) await more.click();
    }
    await expect(farRow).toContainText(far.control.label);
    await expect(farRow).toContainText(`Does not apply ${farEntry.applicability.summary}`);
    await expect(farRow).toContainText(
      `Decided by ${rule.id} version ${rule.version} for mission revision ${missionRevision} and control version ${far.control.controlVersion}.`,
    );
    await expect(workspace).not.toContainText(/\b(compliant|authori[sz]ed|no-go)\b/i);

    // The map draws the area that does not apply in the route's view, dashed, with its recorded sentence; not the far one.
    const map = review.getByTestId('mission-route-coordinate-map');
    await expect(map.locator(`[data-outline-id="${local.control.id}"]`)).toHaveCount(1);
    await expect(map.locator(`[data-outline-id="${far.control.id}"]`)).toHaveCount(0);
    await expect(map.getByRole('list', { name: 'Areas that do not apply, in this view' })).toContainText(
      `${local.control.label} · ${localEntry.applicability.summary}`,
    );

    // The controls list keeps the compact entry with its badge and recorded sentence.
    const controls = review.getByRole('region', { name: 'Controls in scope for this flight', exact: true });
    const listed = controls
      .getByTestId('flight-controls-not-applicable')
      .locator(`[data-control-id="${far.control.controlId}"]`);
    if (!(await listed.count())) {
      const more = controls.getByTestId('flight-controls-not-applicable').getByRole('button', { name: /^Show more/ });
      while (!(await listed.count()) && (await more.count())) await more.click();
    }
    await expect(listed).toContainText(far.control.label);
    await expect(listed).toContainText(`Does not apply ${farEntry.applicability.summary}`);
    await expect(
      controls.locator(`[data-control-id="${near.control.controlId}"]`).getByTestId('control-applies-because'),
    ).toHaveText(`Applies · ${nearCandidate.applicability.summary}`);

    // The briefing lists only the controls that apply, with one line counting the others; it opens to their sentences.
    await departure.getByRole('button', { name: 'Review recorded release →', exact: true }).click();
    await workspace.getByRole('button', { name: 'Prepare briefing →', exact: true }).click();
    const briefing = page.getByRole('region', { name: 'Mission briefing', exact: true });
    await expect(briefing.getByRole('heading', { name: 'Mission briefing', exact: true })).toBeVisible();
    const releaseBasis = briefing.getByRole('region', { name: 'Briefing release basis', exact: true });
    const others = briefingOthersWords(avoidance.notApplicable.length);
    if (await releaseBasis.isVisible()) {
      await expect(releaseBasis.getByTestId('briefing-not-applicable').locator('summary')).toHaveText(others);
      await expect(releaseBasis.getByTestId('area-control-summary').filter({ hasText: far.control.label })).toHaveCount(
        0,
      );
    }
    await briefing.getByRole('button', { name: /^(Prepare briefing|Prepare another briefing)$/ }).click();
    const form = briefing.getByTestId('mission-briefing-form');
    const covered = form.getByRole('group', { name: /^Controls this briefing covers/ });
    await expect(covered.locator(`input[id$="-control-${near.control.id}"]`)).toHaveCount(1);
    await expect(covered.locator(`input[id$="-control-${far.control.id}"]`)).toHaveCount(0);
    const formOthers = form.getByTestId('briefing-not-applicable');
    await expect(formOthers.locator('summary')).toHaveText(others);
    await formOthers.locator('summary').click();
    const formFarRow = formOthers.locator(`[data-control-id="${far.control.controlId}"]`);
    if (!(await formFarRow.count())) {
      const more = formOthers.getByRole('button', { name: /^Show more/ });
      while (!(await formFarRow.count()) && (await more.count())) await more.click();
    }
    await expect(formFarRow).toContainText(far.control.label);
    await expect(formFarRow).toContainText(`Does not apply ${farEntry.applicability.summary}`);
    expect(notApplyingReads, 'No screen reads the exact version of a control that does not apply').toEqual([]);
  } finally {
    try {
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
