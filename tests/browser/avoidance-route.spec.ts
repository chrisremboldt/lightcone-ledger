import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DjiMqttAdapter, LedgerClient, MissionAdapter } from '../../packages/adapters/src/index.js';
import type {
  CommandResponse,
  FlightListResponse,
  FlightMissionResponse,
  FlightPredepartureResponse,
  MissionAvoidanceResponse,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingCommand,
  MissionReleaseRecordResponse,
  MissionRouteSuggestionResponse,
  MissionSource,
  Principal,
  ReceiptResponse,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
  TelemetryResponse,
} from '@ledger/contracts';
import { operationCapacityPreset } from '../../packages/simulation-models/dist/operation.js';
import { OperationDelivery } from '../../apps/simulator/src/operation-delivery.js';
import { OperationOrdinaryDispatchRuntime } from '../../apps/simulator/src/operation-ordinary-runtime.js';
import { initialOperationCheckpoint, OperationStore } from '../../apps/simulator/src/operation-state.js';
import { scenarioConfig } from '../../apps/simulator/src/scenario.js';
import {
  acceptedControl,
  api,
  authorization,
  command,
  complete,
  createFlight,
  localMinute,
  mission,
  operator,
  principal,
  read,
  source,
  writeHeaders,
  attestReleaseFindings,
} from './mission-fixture.js';
import { routeFixtureWorld, sourcePass } from './operation-fixture.js';

/** A hazard on the safety record from a lost-link finding at the centre, with an accepted avoidance area there. */
function acceptedCircle(
  request: APIRequestContext,
  sourceId: string,
  identity: string,
  interval: MissionSource['operatingInterval'],
  owner: Principal,
  center: { latitude: number; longitude: number },
  radiusMeters = 70,
) {
  return acceptedControl(
    request,
    sourceId,
    identity,
    interval,
    owner,
    { center, radiusMeters },
    identity.startsWith('first-')
      ? 'Outbound route precaution'
      : identity.startsWith('second-')
        ? 'Service approach precaution'
        : 'Required service location closed',
  );
}

test('an applied detour clears two accepted controls and its exact source revision drives simulator telemetry', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  const identity = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ledger-browser-avoidance-'));
  const originalOperator = await principal(request);
  const originalSource = await principal(request, source);
  const sourceId = `browser-route-c2-${identity}`;
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
          'risk:accept:medium' as const,
          'briefing:write' as const,
          'briefing:ack' as const,
        ]),
      ],
      missionSources: [...new Set([...originalOperator.missionSources, 'mission-planner'])],
    });
    operatorGranted = true;
    const owner = await principal(request);
    const start = Date.now() - 5 * 60_000;
    const runId = `browser-route-${identity.slice(0, 16)}`;
    const attemptId = `intent-${runId}-alpha-0:attempt:1`;
    const preset = operationCapacityPreset('illustrative-25.1');
    const { world, clock, inGeography } = routeFixtureWorld({
      ...preset,
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
    expect(world.ordinaryDispatch!.flights).toContainEqual(
      expect.objectContaining({ attemptId, customerInterval: reservation.order.schedule }),
    );
    expect(world.demoFlights ?? []).toHaveLength(0);
    expect(reservation.plan.routePlanning?.requiredLocations).toHaveLength(3);
    const delivery = new OperationDelivery({ ...scenarioConfig({ LEDGER_API_URL: api }), stateDirectory: directory });
    const orders = store.state.pending[attemptId]!.filter((entry) => entry.fact.kind === 'order');
    const order = orders.at(-1)!;
    if (order.fact.kind !== 'order') throw new Error('Selected reservation must retain its originating order');
    for (const revision of orders) {
      const orderAccepted = await delivery.deliver(revision);
      await complete(request, orderAccepted.receiptId);
      await store.accept(revision, orderAccepted.receiptId);
    }
    let flight: FlightListResponse['flights'][number];
    await expect
      .poll(async () => {
        const found = await read<FlightListResponse>(
          request,
          `/v1/flights?search=${encodeURIComponent(order.fact.kind === 'order' ? order.fact.order.order_id : '')}&limit=200`,
        );
        flight = found.flights.find((row) => row.originationKey === attemptId)!;
        return Boolean(flight);
      })
      .toBe(true);
    expect(flight!.orderIds).toHaveLength(1);
    const initial = store.state.pending[attemptId]!.find((entry) => entry.fact.kind === 'mission')!;
    const missionAdapter = new MissionAdapter({
      ledger: new LedgerClient(api, source),
      tenantId: 'tenant-alpha',
      sourceId: 'mission-planner',
      sourceMissionId: reservation.plan.sourceMissionId,
      aircraftId: reservation.aircraftId,
      flightId: flight!.id,
    });
    const initialSubmission = await missionAdapter.prepare(Buffer.from(initial.bytesBase64, 'base64'));
    const initialAccepted = await missionAdapter.send(initialSubmission);
    await complete(request, initialAccepted.receipt.receipt.id);
    await store.accept(initial, initialAccepted.receipt.receipt.id);
    const center = (fraction: number) => ({
      longitude:
        reservation.origin.longitude + (reservation.destination.longitude - reservation.origin.longitude) * fraction,
      latitude:
        reservation.origin.latitude + (reservation.destination.latitude - reservation.origin.latitude) * fraction,
    });
    const first = await acceptedCircle(
      request,
      sourceId,
      `first-${identity}`,
      reservation.plan.operatingInterval,
      owner,
      center(0.3),
    );
    const second = await acceptedCircle(
      request,
      sourceId,
      `second-${identity}`,
      reservation.plan.operatingInterval,
      owner,
      center(0.7),
    );
    const controls = [first.control, second.control];
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
    const runSource = async () => {
      await store.update((state) => clock(state, Date.now()));
      await sourcePass(() => inGeography(() => runtime.run(store)));
    };
    const sourceProgress = () => read<FlightPredepartureResponse>(request, `/v1/flights/${flight!.id}/predeparture`);
    async function untilPhase(phase: NonNullable<FlightPredepartureResponse['progress']>['phase']) {
      let result: FlightPredepartureResponse;
      await expect
        .poll(
          async () => {
            await runSource();
            result = await sourceProgress();
            return result.progress?.phase;
          },
          { timeout: 20_000, message: `Ordinary customer flight must reach ${phase}` },
        )
        .toBe(phase);
      return result!;
    }
    const held = await untilPhase('awaiting_route');
    expect(held.enabled).toBe(true);
    expect(held.progress).toMatchObject({
      needsHumanReview: true,
      execution: { runId, reservationId: attemptId },
      source: { principalId: originalSource.id, automaticReleasePrincipalId: originalSource.id },
    });
    expect(store.state.world.departures ?? []).toHaveLength(0);
    const preview = () => read<MissionAvoidanceResponse>(request, `/v1/flights/${flight!.id}/mission-avoidance`);
    await expect
      .poll(async () => {
        const current = await preview();
        return (
          current.status === 'intersects' &&
          controls.every((control) =>
            current.candidates.some(
              (candidate) => candidate.controlEventId === control.id && candidate.context === 'current',
            ),
          )
        );
      })
      .toBe(true);

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await page.getByTestId(`flight-row-${flight!.id}`).click();
    await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Mission review', exact: true });
    const missionProgress = workspace
      .locator('.mission-review-view')
      .getByRole('region', { name: 'Flight departure progress', exact: true });
    await expect(missionProgress).toContainText('Held · route review required');
    async function screenshot(name: string, target?: Locator) {
      const path = testInfo.outputPath(name);
      if (target) {
        await target.scrollIntoViewIfNeeded();
        await target.screenshot({ path });
      } else await page.screenshot({ path });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    }
    await screenshot('ordinary-flight-held-desktop.png', missionProgress);
    await page.setViewportSize({ width: 390, height: 844 });
    await missionProgress.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('ordinary-flight-held-390.png');
    await page.setViewportSize({ width: 1440, height: 960 });
    const detour = workspace.getByTestId('mission-detour');
    await expect(detour).toBeVisible();
    await detour.getByLabel('Additional clearance (m)', { exact: true }).fill('25');
    const suggestedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/flights/${flight!.id}/mission/route-suggestion`) &&
        response.request().method() === 'POST',
    );
    await detour.getByRole('button', { name: 'Suggest detour', exact: true }).click();
    const response = await suggestedResponse;
    expect(response.ok(), await response.text()).toBe(true);
    const suggestion = (await response.json()) as MissionRouteSuggestionResponse;
    expect(suggestion.status).toBe('suggested');
    expect(suggestion.timeFit.status).toBe('fits');
    expect(suggestion.distance!.changeMeters).toBeGreaterThan(0);
    expect(suggestion.proposedRoute!.geometry.coordinates.length).toBeGreaterThan(3);
    expect(
      controls.every((control) => suggestion.candidates.some((candidate) => candidate.controlEventId === control.id)),
    ).toBe(true);
    await expect(detour).toContainText(/original/i);
    await expect(detour).toContainText(/proposed|suggested/i);
    await expect(workspace.getByTestId('mission-route-coordinate-map')).toBeVisible();
    await workspace
      .getByTestId('mission-route')
      .screenshot({ path: testInfo.outputPath('avoidance-route-suggested-desktop.png') });
    await page.setViewportSize({ width: 1440, height: 1600 });
    await detour.screenshot({ path: testInfo.outputPath('avoidance-route-workflow-desktop.png') });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.setViewportSize({ width: 390, height: 844 });
    await detour.scrollIntoViewIfNeeded();
    await expect(detour.getByRole('button', { name: 'Apply suggested mission revision', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await workspace
      .getByTestId('mission-route')
      .screenshot({ path: testInfo.outputPath('avoidance-route-suggested-390.png') });
    await detour
      .getByRole('button', { name: 'Apply suggested mission revision', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('avoidance-route-application-390.png') });
    await page.setViewportSize({ width: 390, height: 2000 });
    await detour.screenshot({ path: testInfo.outputPath('avoidance-route-workflow-390.png') });
    await page.setViewportSize({ width: 1440, height: 960 });

    const submissions: Array<{ body: string; key: string }> = [];
    let firstReceipt: ReceiptResponse['receipt'] | undefined;
    const inputPattern = '**/v1/inputs';
    await page.route(inputPattern, async (route) => {
      const requestBody = route.request().postDataJSON() as {
        kind?: string;
        subject?: { flightId?: string };
        sourceRevision?: number;
      };
      if (
        requestBody.kind !== 'mission.revision' ||
        requestBody.subject?.flightId !== flight!.id ||
        requestBody.sourceRevision !== 2
      )
        return route.continue();
      submissions.push({ body: route.request().postData()!, key: route.request().headers()['idempotency-key']! });
      if (submissions.length !== 1) return route.continue();
      const accepted = await route.fetch();
      expect(accepted.status(), await accepted.text()).toBe(201);
      firstReceipt = ((await accepted.json()) as ReceiptResponse).receipt;
      await route.abort('failed');
    });
    try {
      await detour.getByRole('button', { name: 'Apply suggested mission revision', exact: true }).click();
      await expect(detour.getByRole('button', { name: 'Retry same mission revision', exact: true })).toBeVisible();
      await workspace.getByRole('button', { name: `Return to ${flight!.label}`, exact: true }).click();
      await expect(workspace).toBeHidden();
      await page.getByTestId(`flight-row-${first.origin.flightId}`).click();
      await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
      await expect(workspace).toContainText('No mission recorded');
      await workspace.getByRole('button', { name: /^Return to / }).click();
      await page.getByTestId(`flight-row-${flight!.id}`).click();
      await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
      await expect(detour.getByRole('button', { name: 'Retry same mission revision', exact: true })).toBeEnabled();
      const replayedResponse = page.waitForResponse(
        (result) =>
          result.url().endsWith('/v1/inputs') &&
          result.request().method() === 'POST' &&
          result.request().postDataJSON()?.kind === 'mission.revision',
      );
      await detour.getByRole('button', { name: 'Retry same mission revision', exact: true }).click();
      const replayed = await replayedResponse;
      expect(replayed.status(), await replayed.text()).toBe(201);
      expect(((await replayed.json()) as ReceiptResponse).receipt.id).toBe(firstReceipt!.id);
      await expect(detour).toContainText('Mission revision 2 projected');
    } finally {
      await page.unroute(inputPattern);
    }
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    const head = await read<FlightMissionResponse>(request, `/v1/flights/${flight!.id}/mission`);
    expect(head.acceptedHead!.record.sourceRevision).toBe(2);
    expect(head.acceptedHead!.record.id).toBe(firstReceipt!.eventId);
    expect(head.projectedHead).toEqual(head.acceptedHead!.record);
    expect(head.projectedHead!.route).toEqual(suggestion.proposedRoute);
    expect(head.projectedHead!.routePlanning).toEqual(reservation.plan.routePlanning);
    expect(head.projectedHead!.operatingInterval).toEqual(reservation.plan.operatingInterval);
    await expect
      .poll(async () => {
        const current = await preview();
        return (
          current.status === 'outside' &&
          current.candidateCompleteness.status === 'complete' &&
          controls.every((control) =>
            current.candidates.some(
              (candidate) => candidate.controlEventId === control.id && candidate.geometry === 'outside',
            ),
          )
        );
      })
      .toBe(true);
    const humanRelease = await untilPhase('awaiting_release');
    expect(humanRelease.progress!.needsHumanReview).toBe(true);
    expect(humanRelease.progress!.references.release).toBeUndefined();
    expect(store.state.ordinaryFlights![attemptId]!.automaticReleasePlan).toBeUndefined();
    expect(store.state.world.departures ?? []).toHaveLength(0);
    await workspace.getByRole('button', { name: 'Prepare release', exact: true }).click();
    const releaseForm = workspace.getByTestId('mission-release-form');
    const departureStart = Math.floor(Date.now() / 60_000) * 60_000;
    await releaseForm
      .getByLabel('Departure window starts', { exact: true })
      .fill(await localMinute(page, departureStart));
    await releaseForm
      .getByLabel('Departure window ends', { exact: true })
      .fill(await localMinute(page, departureStart + 10 * 60_000));
    await releaseForm
      .getByLabel('Release note', { exact: true })
      .fill('Release the exact accepted detour around both controls, preserving delivery and return.');
    const releaseResponse = page.waitForResponse(
      (result) =>
        result.url().endsWith('/v1/commands') &&
        result.request().method() === 'POST' &&
        result.request().postDataJSON()?.kind === 'mission.release',
    );
    await attestReleaseFindings(releaseForm);
    await releaseForm.getByRole('button', { name: 'Record mission release', exact: true }).click();
    const acceptedRelease = await releaseResponse;
    expect(acceptedRelease.status(), await acceptedRelease.text()).toBe(201);
    const releaseId = ((await acceptedRelease.json()) as CommandResponse).command.id;
    const release = await read<MissionReleaseRecordResponse>(
      request,
      `/v1/flights/${flight!.id}/mission-releases/${releaseId}`,
    );
    await expect(workspace.getByText('Recorded release', { exact: true })).toBeVisible();
    await expect(workspace.getByText('Reading the accepted release', { exact: true })).toBeHidden();
    await workspace.getByRole('button', { name: 'Review revised route', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1600 });
    await workspace
      .getByTestId('mission-route')
      .screenshot({ path: testInfo.outputPath('avoidance-route-released-desktop.png') });
    await page.setViewportSize({ width: 1440, height: 960 });
    expect(release.release.actor).toMatchObject({ id: owner.id, name: owner.name, kind: 'human' });
    const briefingStage = await untilPhase('awaiting_briefing');
    expect(briefingStage.progress!.references.release).toEqual({ id: releaseId, digest: release.digest });
    expect(store.state.world.departures ?? []).toHaveLength(0);
    // One briefing round covers every accepted control in the release, however many there are.
    const requiredControls = release.release.basis.avoidance.candidates;
    const requiredIds = requiredControls.map((control) => control.controlEventId);
    await expect(missionProgress.locator('.predeparture-briefings > li')).toHaveCount(requiredControls.length);
    await missionProgress.getByRole('button', { name: 'Prepare the controls briefing →', exact: true }).click();
    const briefing = page.getByRole('region', { name: 'Mission briefing', exact: true });
    await briefing.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
    const form = briefing.getByTestId('mission-briefing-form');
    await expect(
      form.getByRole('group', { name: /^Controls this briefing covers/ }).getByRole('checkbox', { checked: true }),
    ).toHaveCount(requiredControls.length);
    await form
      .getByLabel('Message', { exact: true })
      .fill('Review every accepted area listed here and the exact released customer route before dispatch.');
    await form
      .getByRole('group', { name: 'Recipients', exact: true })
      .getByRole('checkbox', { name: new RegExp(owner.name) })
      .check();
    const recorded = page.waitForResponse(
      (result) => result.url().endsWith('/v1/commands') && result.request().postDataJSON()?.kind === 'mission.brief',
    );
    await form.getByRole('button', { name: 'Record briefing', exact: true }).click();
    const recordedResponse = await recorded;
    expect(recordedResponse.status(), await recordedResponse.text()).toBe(201);
    const briefingCommand = recordedResponse.request().postDataJSON() as MissionBriefingCommand;
    expect(briefingCommand.controls.map((control) => control.controlEventId)).toEqual(requiredIds);
    expect(briefingCommand.recipientPrincipalIds).toEqual([owner.id]);
    const briefingId = ((await recordedResponse.json()) as CommandResponse).command.id;
    await expect
      .poll(
        async () => {
          await runSource();
          const named = (await sourceProgress()).progress!.references.briefings;
          return requiredIds.every((id) =>
            named.some((entry) => entry.controlEventId === id && entry.briefing.id === briefingId),
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(store.state.world.departures ?? []).toHaveLength(0);
    await expect(briefing).toContainText('source can check this held flight for departure');
    // The review screen shows every control the briefing lists before the person acknowledges it.
    await expect(briefing.getByTestId('briefing-controls-covered').getByRole('article')).toHaveCount(
      requiredControls.length,
    );
    const review = briefing.getByRole('checkbox', {
      name:
        requiredControls.length > 1
          ? `I reviewed this exact briefing and each of the ${requiredControls.length} controls it lists`
          : 'I reviewed this exact briefing',
      exact: true,
    });
    await review.check();
    await screenshot('ordinary-flight-briefing-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await review.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('ordinary-flight-briefing-390.png');
    await page.setViewportSize({ width: 1440, height: 960 });
    await briefing.getByRole('button', { name: 'Acknowledge my review', exact: true }).click();
    await expect
      .poll(
        async () => {
          const coverage = await read<MissionBriefingAcknowledgementsResponse>(
            request,
            `/v1/flights/${flight!.id}/briefings/${briefingId}/acknowledgements`,
          );
          return (
            coverage.recipients.length === 1 &&
            coverage.recipients.every(
              (recipient) =>
                recipient.recipientPrincipalId === owner.id &&
                recipient.acknowledgement?.record.actor.id === owner.id &&
                recipient.processing === 'completed',
            )
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await briefing.getByRole('button', { name: '← Return to mission review', exact: true }).click();
    await expect
      .poll(
        async () => {
          await runSource();
          return store.state.world.departures?.filter((entry) => entry.reservationId === attemptId).length ?? 0;
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    const reviewed = await sourceProgress();
    expect(reviewed.progress!.needsHumanReview).toBe(true);
    expect(reviewed.progress!.references.briefings.map((entry) => entry.briefing.id)).toEqual(
      requiredIds.map(() => briefingId),
    );
    expect(
      store.state.world.ordinaryDispatch!.flights.find((entry) => entry.attemptId === attemptId)!.customerInterval,
    ).toEqual(reservation.order.schedule);
    const attempt = store.state.world.attempts.find((row) => row.id === reservation.id)!;
    expect(attempt.routeTimeline!.plan.route).toEqual(suggestion.proposedRoute);
    expect(attempt.routeTimeline!.plan.sourceRevision).toBe(2);
    const native = store.state.pending[attemptId]!.find((entry) => entry.fact.kind === 'departure')!;
    const deliveryConfig = scenarioConfig({ LEDGER_API_URL: api });
    const departedDelivery = new OperationDelivery({
      ...deliveryConfig,
      stateDirectory: directory,
      tokens: { ...deliveryConfig.tokens, alpha: { source, actor: source } },
      departureBinding: (id) =>
        id === attemptId
          ? {
              flightId: flight!.id,
              tenantId: 'tenant-alpha',
              aircraftId: attempt.aircraftId,
              sourceSessionId: attempt.sourceSessionId,
            }
          : undefined,
    });
    const departureEvidence = await departedDelivery.deliver(native);
    await complete(request, departureEvidence.receiptId);
    await store.accept(native, departureEvidence.receiptId);
    const departed = await untilPhase('departed');
    expect(departed.progress!.references.departureReceipt).toBe(departureEvidence.receiptId);
    expect(store.state.world.departures!.filter((entry) => entry.reservationId === attemptId)).toHaveLength(1);
    const travel = attempt.routeTimeline!.phases.find(
      (phase) => phase.kind === 'travel' && phase.endMs - phase.startMs >= 5000,
    )!;
    const targetAt = Date.parse(attempt.departure) + Math.ceil((travel.startMs + travel.endMs) / 2 / 1000) * 1000;
    await expect.poll(() => Date.now(), { timeout: 90_000, intervals: [1000] }).toBeGreaterThanOrEqual(targetAt);
    await store.update((state) => clock(state, Date.now()));
    const positions = store.state.pending[attemptId]!.filter((entry) => entry.fact.kind === 'position');
    const sample = positions.find((entry) => entry.fact.kind === 'position' && Date.parse(entry.fact.at) >= targetAt)!;
    expect(sample.fact.kind).toBe('position');
    if (sample.fact.kind !== 'position') throw new Error('The revised flight must emit a position');
    const elapsed = Date.parse(sample.fact.at) - Date.parse(attempt.departure);
    expect(elapsed).toBeGreaterThanOrEqual(travel.startMs);
    expect(elapsed).toBeLessThan(travel.endMs);
    const fraction = (elapsed - travel.startMs) / (travel.endMs - travel.startMs);
    const expected = {
      longitude: travel.from.longitude + (travel.to.longitude - travel.from.longitude) * fraction,
      latitude: travel.from.latitude + (travel.to.latitude - travel.from.latitude) * fraction,
    };
    const latitudeScale = 111_320;
    const longitudeScale =
      latitudeScale * Math.cos(((reservation.origin.latitude + reservation.destination.latitude) * Math.PI) / 360);
    const originalX = (reservation.destination.longitude - reservation.origin.longitude) * longitudeScale;
    const originalY = (reservation.destination.latitude - reservation.origin.latitude) * latitudeScale;
    const originalLength = Math.hypot(originalX, originalY);
    expect(originalLength).toBeGreaterThan(0);
    const distanceFromOriginalLine = (point: { longitude: number; latitude: number }) => {
      const x = (point.longitude - reservation.origin.longitude) * longitudeScale;
      const y = (point.latitude - reservation.origin.latitude) * latitudeScale;
      return Math.abs(x * originalY - y * originalX) / originalLength;
    };
    expect(distanceFromOriginalLine(expected)).toBeGreaterThan(5);
    expect(sample.fact.point).toMatchObject({ longitude: expected.longitude, latitude: expected.latitude });
    const capture = new DjiMqttAdapter({
      ledger: new LedgerClient(api, source),
      tenantId: 'tenant-alpha',
      sourceId: 'dji-osd',
      sourceSessionId: attempt.sourceSessionId,
      deviceId: attempt.aircraftId,
      gatewayId: `GW-${attempt.aircraftId}`,
      subject: { flightId: flight!.id },
      statePath: join(directory, 'capture.json'),
      mqttUrl: 'mqtt://127.0.0.1:1',
      username: 'in-process-wire-capture',
      password: 'mqtt-transport-disabled',
    });
    await capture.initialize();
    for (const position of positions)
      await capture.ingest(`thing/product/${attempt.aircraftId}/osd`, Buffer.from(position.bytesBase64, 'base64'));
    const segments = await capture.flush();
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) await complete(request, segment.receipt.receipt.id);
    const telemetry = await read<TelemetryResponse>(request, `/v1/flights/${flight!.id}/telemetry`);
    const retained = telemetry.samples.find(
      (point) =>
        point.sourceSessionId === attempt.sourceSessionId &&
        Date.parse(point.occurredAt) === Date.parse(sample.fact.at),
    );
    expect(retained).toBeDefined();
    expect(retained!.longitude).toBeCloseTo(expected.longitude, 7);
    expect(retained!.latitude).toBeCloseTo(expected.latitude, 7);
    expect(distanceFromOriginalLine(retained!)).toBeGreaterThan(5);
    const firstHistory = await read<{ mission: MissionSource }>(
      request,
      `/v1/flights/${flight!.id}/mission/revisions/1`,
    );
    expect(firstHistory.mission.route).toEqual(reservation.plan.route);

    const closedService = await acceptedCircle(
      request,
      sourceId,
      `destination-${identity}`,
      reservation.plan.operatingInterval,
      owner,
      reservation.destination,
      80,
    );
    await expect.poll(async () => (await preview()).status).toBe('intersects');
    const infeasibleBasis = await preview();
    const infeasible = await request.post(`${api}/v1/flights/${flight!.id}/mission/route-suggestion`, {
      headers: authorization(),
      data: {
        expectedMission: infeasibleBasis.mission,
        expectedContextDigest: infeasibleBasis.contextDigest,
        clearanceMeters: 25,
      },
    });
    expect(infeasible.ok(), await infeasible.text()).toBe(true);
    const noRoute = (await infeasible.json()) as MissionRouteSuggestionResponse;
    expect(noRoute.status).toBe('infeasible');
    expect(noRoute.reasons).toContain('required_location_inside_avoidance_corridor');
    expect(noRoute.proposedRoute).toBeNull();
    const closedCandidate = workspace.locator('.mission-candidate').filter({ hasText: closedService.control.id });
    await expect(closedCandidate).toContainText('Context current');
    const previewProvenance = workspace
      .locator('details.mission-provenance')
      .filter({ has: page.getByText('Mission and preview provenance', { exact: true }) })
      .locator('pre');
    await expect
      .poll(async () => {
        const raw = await previewProvenance.textContent();
        return raw ? (JSON.parse(raw) as { preview: MissionAvoidanceResponse }).preview.contextDigest : null;
      })
      .toBe(infeasibleBasis.contextDigest);
    await expect(detour.getByRole('button', { name: 'Suggest detour', exact: true })).toBeEnabled();
    const infeasibleResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/flights/${flight!.id}/mission/route-suggestion`) &&
        response.request().method() === 'POST',
    );
    await detour.getByRole('button', { name: 'Suggest detour', exact: true }).click();
    const reviewedResponse = await infeasibleResponse;
    expect(reviewedResponse.request().postDataJSON()).toMatchObject({
      expectedMission: infeasibleBasis.mission,
      expectedContextDigest: infeasibleBasis.contextDigest,
      clearanceMeters: 25,
    });
    expect(reviewedResponse.ok(), await reviewedResponse.text()).toBe(true);
    const reviewedSuggestion = (await reviewedResponse.json()) as MissionRouteSuggestionResponse;
    expect(reviewedSuggestion.status).toBe('infeasible');
    expect(reviewedSuggestion.reasons).toContain('required_location_inside_avoidance_corridor');
    await expect(detour.getByText('No feasible route', { exact: true })).toBeVisible();
    await expect(detour).toContainText('No detour can preserve that location');
    await expect(detour.getByRole('button', { name: 'Apply suggested mission revision', exact: true })).toHaveCount(0);
    await detour.getByText('No feasible route', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('avoidance-route-infeasible-desktop.png') });
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

test('an avoidance area accepted on a safety-record hazard is named on the review of a flight through it', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const identity = randomUUID();
  const sourceId = `browser-area-record-${identity}`;
  const dispatcher = await principal(request);
  const originalSource = await principal(request, source);
  const addedSourceCapability = !originalSource.capabilities.includes('mission:write');
  const addedRiskCapability = !dispatcher.capabilities.includes('risk:accept:high');
  let sourceGranted = false;
  let riskGranted = false;
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
        capabilities: [...dispatcher.capabilities, 'risk:accept:high'],
      });
      riskGranted = true;
    }

    // A flight planned through a fictional market, nine days out so no other test's area overlaps it.
    const starts = Math.floor((Date.now() + 9 * 24 * 60 * 60_000) / 60_000) * 60_000 + 750;
    const interval = { start: new Date(starts).toISOString(), end: new Date(starts + 60 * 60_000).toISOString() };
    const aircraft = `Browser area aircraft ${identity.slice(0, 6)}`;
    const flight = await createFlight(
      request,
      `Area record ${identity.slice(0, 6)}`,
      aircraft,
      starts,
      starts + 3_600_000,
    );
    const raw: MissionSource = {
      sourceMissionId: `browser-area-record-mission-${identity}`,
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
            [-87.645, 41.89],
            [-87.635, 41.89],
          ],
        },
      },
      lateralToleranceMeters: 30,
      altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
      operatingInterval: interval,
    };
    await mission(request, flight.id, sourceId, raw);

    // The dispatcher identifies the hazard on the safety record and its risk is accepted with an avoidance area.
    const hazardTitle = `Crowds at the fictional market ${identity.slice(0, 6)}`;
    const hazardId = (
      await command(request, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: hazardTitle,
          ownerId: dispatcher.id,
          body: {
            description: 'Crowds gather at the fictional market on delivery routes.',
            consequence: 'A forced landing among people.',
            source: { kind: 'manual_identification' },
          },
        },
      } as never)
    ).command.subject!.id;
    const opened = await read<SmsRecordDetailResponse>(request, `/v1/sms/records/${hazardId}`);
    const type = opened.controlTypes!.find((entry) => entry.title === 'Route avoidance area')!;
    const controlTitle = `Keep deliveries clear of the market ${identity.slice(0, 6)}`;
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
            parameters: { center: { latitude: 41.89, longitude: -87.64 }, radiusMeters: 200, site: 'Fictional market' },
            effectiveFrom: interval.start,
            effectiveUntil: interval.end,
          },
        },
      } as never)
    ).command.subject!.id;
    await decide(hazardId, {
      kind: 'risk.assess',
      note: 'Assessed with the delivery crews, with the avoidance area in place.',
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
    await expect
      .poll(
        async () =>
          (await read<MissionAvoidanceResponse>(request, `/v1/flights/${flight.id}/mission-avoidance`)).status,
      )
      .toBe('intersects');

    // The mission review names the area, its type wording and its hazard, with no lookup error.
    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    await page.getByTestId(`flight-row-${flight.id}`).click();
    await page.getByRole('button', { name: 'Review mission route', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Mission review', exact: true });
    await expect(workspace).toContainText('Route intersects an accepted control');
    await expect(workspace.getByRole('heading', { name: controlTitle })).toBeVisible();
    // Other areas accepted on the safety record may also reach this route; read this test's own.
    const summary = workspace.getByTestId('area-control-summary').filter({ hasText: controlTitle });
    await expect(summary).toContainText(
      'Keep planned routes clear of the circle of 200 m around 41.89, -87.64 (Fictional market), at all altitudes.',
    );
    await expect(summary).toContainText('Route avoidance area on the safety record');
    await expect(workspace).not.toContainText('could not be matched');

    // Its hazard opens on the safety record, and flights stay open behind it.
    await summary.getByRole('button', { name: hazardTitle }).click();
    await expect(page.getByTestId('sms-record').getByRole('heading', { name: hazardTitle })).toBeVisible();
    await page.getByRole('button', { name: 'Return to flights' }).click();
    await expect(workspace.getByRole('heading', { name: controlTitle })).toBeVisible();
  } finally {
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
    if (riskGranted) {
      const current = await principal(request);
      await command(request, {
        kind: 'authority.update',
        principalId: current.id,
        expectedRevision: current.revision,
        capabilities: current.capabilities.filter((capability) => capability !== 'risk:accept:high'),
      });
    }
  }
});
