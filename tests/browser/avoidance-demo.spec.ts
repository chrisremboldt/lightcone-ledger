import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DjiMqttAdapter } from '../../packages/adapters/src/index.js';
import type {
  CommandResponse,
  ErrorResponse,
  FlightMissionResponse,
  MissionAvoidanceResponse,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingCommand,
  MissionReleaseCommand,
  MissionRouteSuggestionResponse,
  ControlWindowResponse,
  SimulationAvoidanceDemoCycleResponse,
  SimulationAvoidanceDemoListResponse,
  TelemetryResponse,
  TimelineResponse,
} from '@ledger/contracts';
import {
  cancelOperationDemoFlight,
  createOperation,
  type OperationDepartureCommit,
} from '../../packages/simulation-models/dist/operation.js';
import { yards, type Coordinate } from '../../packages/simulation-models/dist/places.js';
import { OperationDemoRuntime } from '../../apps/simulator/src/operation-demo-runtime.js';
import { OperationDelivery } from '../../apps/simulator/src/operation-delivery.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationHistoryBatch,
} from '../../apps/simulator/src/operation-state.js';
import { readOperationHistory } from '../../apps/simulator/src/operation-history.js';
import { scenarioConfig } from '../../apps/simulator/src/scenario.js';
import {
  acceptedControl,
  api,
  authorization,
  command,
  complete,
  localMinute,
  operator,
  principal,
  read,
  releaseAuthor,
  source,
  attestReleaseFindings,
  type AcceptedAreaControl,
} from './mission-fixture.js';

type Cycle = SimulationAvoidanceDemoCycleResponse;

async function retainedDepartures(store: OperationStore, reservationId: string) {
  const commits = (store.state.world.departures ?? []).filter((row) => row.reservationId === reservationId);
  for await (const { value } of readOperationHistory<OperationHistoryBatch>(
    store.historyDirectory,
    store.state.historyBatches,
  )) {
    for (const cycle of value.demoCycles ?? []) {
      const recovery = cycle.archivedRecovery as { commit?: OperationDepartureCommit } | undefined;
      if (recovery?.commit?.reservationId === reservationId) commits.push(recovery.commit);
    }
  }
  return commits;
}

function demoFixtureGeography(identity: string) {
  const cell = Number.parseInt(identity.slice(0, 8), 16) % (512 * 512);
  const offset = { latitude: 2 + (cell % 512) * 0.05, longitude: 2 + Math.floor(cell / 512) * 0.05 };
  const originalYards = Object.fromEntries(Object.entries(yards).map(([id, yard]) => [id, { ...yard }]));
  const shift = (position: Coordinate): Coordinate => ({
    latitude: position.latitude + offset.latitude,
    longitude: position.longitude + offset.longitude,
  });
  const fixtureYards = Object.fromEntries(
    Object.entries(originalYards).map(([id, yard]) => [id, { ...yard, ...shift(yard) }]),
  );
  return {
    install: () => Object.assign(yards, fixtureYards),
    restore: () => Object.assign(yards, originalYards),
    shift,
  };
}

async function exactCycle(request: APIRequestContext, id: string): Promise<Cycle> {
  return read<Cycle>(request, `/v1/simulation/avoidance-demos/${encodeURIComponent(id)}`);
}

async function cyclesFor(request: APIRequestContext, hazard: AcceptedAreaControl) {
  const query = new URLSearchParams({ controlEventId: hazard.control.id, acceptanceId: hazard.acceptance.id });
  return read<SimulationAvoidanceDemoListResponse>(
    request,
    `/v1/hazards/${encodeURIComponent(hazard.id)}/avoidance-demos?${query}`,
  );
}

/** From the flights, opens the accepted control's own page in the safety section: register, hazard, then control. */
async function openControlRecord(page: Page, hazard: AcceptedAreaControl) {
  await page.getByRole('button', { name: 'Hazards', exact: true }).click();
  const register = page.locator('[aria-label="Recorded hazards"]');
  const rows = register.locator('[data-testid^="sms-row-"]');
  const row = register.getByTestId(`sms-row-${hazard.id}`);
  for (let index = 0; index < 20 && !(await row.isVisible()); index++) {
    await expect(rows.first()).toBeVisible();
    if (await row.isVisible()) break;
    const shown = await rows.count();
    await page.getByRole('button', { name: 'More hazards', exact: true }).click();
    await expect.poll(() => rows.count()).toBeGreaterThan(shown);
  }
  await row.click();
  const record = page.getByTestId('sms-record');
  await record
    .getByTestId('sms-hazard-controls')
    .getByRole('button', { name: hazard.control.label, exact: true })
    .click();
  await expect(record.getByRole('heading', { name: hazard.control.label, exact: true })).toBeVisible();
}

class DemoHarness {
  private runtime: OperationDemoRuntime;
  private delivery: OperationDelivery;
  private work: Promise<void> | null = null;
  private stopped = true;
  failure: unknown;

  constructor(
    readonly directory: string,
    readonly request: APIRequestContext,
    public store: OperationStore,
    readonly departurePrincipalId: string,
  ) {
    this.runtime = this.makeRuntime();
    this.delivery = this.makeDelivery();
  }
  private makeRuntime() {
    return new OperationDemoRuntime({
      apiUrl: api,
      sourceToken: source,
      actorToken: releaseAuthor,
      departurePrincipalId: this.departurePrincipalId,
      directory: join(this.directory, 'demo'),
    });
  }
  private makeDelivery() {
    const config = scenarioConfig({ LEDGER_API_URL: api });
    return new OperationDelivery({
      ...config,
      stateDirectory: this.directory,
      transport: {
        partnerOrder: async (prepared, ingest) => ingest(Buffer.from(prepared.bytesBase64, 'base64')),
        commandLink: async (prepared, ingest) => ingest(Buffer.from(prepared.bytesBase64, 'base64')),
        mission: async (prepared, ingest) => ingest(Buffer.from(prepared.bytesBase64, 'base64')),
        position: async (prepared, capture) => {
          const adapter = new DjiMqttAdapter({
            ...capture,
            mqttUrl: 'mqtt://127.0.0.1:1',
            username: 'retained-source-bytes',
            password: 'transport-disabled',
          });
          await adapter.initialize();
          await adapter.ingest(`thing/product/${capture.deviceId}/osd`, Buffer.from(prepared.bytesBase64, 'base64'));
          await adapter.flush();
        },
      },
      departureBinding: (attemptId) => {
        const execution = Object.values(this.store.state.demoCycles ?? {}).find(
          (cycle) => cycle.flight?.attemptId === attemptId,
        )?.references.execution;
        const reservation = this.store.state.world.reservations?.find((row) => row.id === attemptId);
        return execution && reservation
          ? {
              flightId: execution.flightId,
              tenantId: 'tenant-alpha',
              aircraftId: execution.aircraftId,
              sourceSessionId: reservation.sourceSessionId,
            }
          : undefined;
      },
    });
  }
  async step() {
    await this.store.update((state) => advanceLiveClock(state, Date.now(), false));
    await this.runtime.run(this.store);
    const attempts = new Set(this.store.state.world.demoFlights?.map((flight) => flight.attemptId));
    const prepared = [
      ...this.store.pendingHeads(),
      ...this.store.pendingMissionHeads(),
      ...this.store.pendingCommandLinkHeads(),
    ].filter((entry) => attempts.has(entry.fact.attemptId));
    for (const entry of prepared) {
      if (
        entry.fact.kind === 'mission' &&
        (this.store.state.pending[entry.fact.attemptId] ?? []).some((pending) => pending.fact.kind === 'order')
      )
        continue;
      const accepted = await this.delivery.deliver(entry);
      await complete(this.request, accepted.receiptId);
      await this.store.accept(entry, accepted.receiptId);
    }
    await this.runtime.run(this.store);
  }
  start() {
    this.stopped = false;
    this.work = (async () => {
      try {
        while (!this.stopped) {
          await this.step();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        this.failure = error;
      }
    })();
  }
  async stop() {
    this.stopped = true;
    await this.work;
    this.work = null;
  }
  async restart() {
    await this.stop();
    if (this.failure) throw this.failure;
    const state = await readOperationCheckpoint(join(this.directory, 'world.json'));
    if (!state) throw new Error('The actual world checkpoint must survive restart');
    this.store = new OperationStore(join(this.directory, 'world.json'), state);
    this.runtime = this.makeRuntime();
    this.delivery = this.makeDelivery();
    this.start();
  }
  async until(id: string, condition: (cycle: Cycle) => boolean, timeout = 30_000): Promise<Cycle> {
    let result: Cycle;
    await expect
      .poll(
        async () => {
          if (this.failure) throw this.failure;
          result = await exactCycle(this.request, id);
          return condition(result);
        },
        {
          timeout,
          intervals: [500, 1000],
          message: 'Actual source coordinator must reach the next retained demo stage',
        },
      )
      .toBe(true);
    return result!;
  }
}

test('an accepted control prepares a held flight, follows the human detour and briefing, and retains monitoring across another cycle', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(11 * 60_000);
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(api).hostname);
  const identity = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ledger-browser-control-demo-'));
  const originalOperator = await principal(request);
  const originalSource = await principal(request, source);
  const originalActor = await principal(request, releaseAuthor);
  let operatorGranted = false;
  let sourceGranted = false;
  let actorGranted = false;
  let harness: DemoHarness | undefined;
  let completed = false;
  const geography = demoFixtureGeography(identity);

  async function screenshot(name: string, target?: Locator) {
    const path = testInfo.outputPath(name);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }
  try {
    geography.install();
    await command(request, {
      kind: 'authority.update',
      principalId: originalSource.id,
      expectedRevision: originalSource.revision,
      capabilities: [
        ...new Set([
          ...originalSource.capabilities,
          'input:write' as const,
          'flight:read' as const,
          'mission:write' as const,
          'monitoring:write' as const,
        ]),
      ],
      missionSources: [...new Set([...originalSource.missionSources, 'mission-planner'])],
      monitoringSources: [...new Set([...(originalSource.monitoringSources ?? []), 'operation-monitoring'])],
      // Link reports arrive as link.status observations under the command-link source.
      observationGrants: [
        ...(originalSource.observationGrants ?? []).filter(
          (grant) => grant.sourceId !== 'command-link' || grant.observationType !== 'link.status',
        ),
        { sourceId: 'command-link', observationType: 'link.status' },
      ],
    });
    sourceGranted = true;
    const configuration = await request.get(`${api}/v1/simulation/avoidance-demos/requests?limit=1`, {
      headers: authorization(source),
    });
    if (configuration.status() === 404) {
      const body = (await configuration.json()) as ErrorResponse;
      if (
        body.error?.code === 'simulation_demo_not_configured' &&
        typeof body.error.message === 'string' &&
        typeof body.requestId === 'string'
      ) {
        completed = true;
        test.skip(true, 'The API has not enabled the optional repeatable avoidance demonstration.');
      }
    }
    expect(configuration.ok(), await configuration.text()).toBe(true);
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
    await command(request, {
      kind: 'authority.update',
      principalId: originalActor.id,
      expectedRevision: originalActor.revision,
      capabilities: [
        ...new Set([
          ...originalActor.capabilities,
          'input:write' as const,
          'decision:write' as const,
          'flight:read' as const,
          'mission:release' as const,
        ]),
      ],
    });
    actorGranted = true;
    const dana = await principal(request);
    const starts = Date.now() - 60_000;
    const hazard = await acceptedControl(
      request,
      'command-link',
      identity,
      { start: new Date(starts).toISOString(), end: new Date(starts + 40 * 60_000).toISOString() },
      dana,
      { center: geography.shift({ latitude: 41.884, longitude: -87.636 }), radiusMeters: 120 },
    );
    const { control } = hazard;
    const automatic = await cyclesFor(request, hazard);
    expect(automatic.cycles).toHaveLength(1);
    const initial = automatic.cycles[0]!;
    expect(initial.cycle).toMatchObject({
      trigger: 'initial',
      previousCycleId: null,
      control: {
        hazardId: hazard.id,
        controlId: control.controlId,
        controlVersion: control.controlVersion,
        controlEventId: control.id,
        controlDigest: control.bodyDigest,
        acceptance: hazard.acceptance,
      },
    });
    expect(initial.progress).toBeNull();

    const world = createOperation({
      runId: `browser-demo-${identity.slice(0, 12)}`,
      start: new Date().toISOString(),
      seed: 71031,
      // The world's opening ordinary order takes one Alpha aircraft and the initial demo flight another; the repeat
      // cycle needs a third that is ready, not landing or charging.
      fleet: { alpha: 3, beta: 1 },
      demandIntervalMs: 24 * 60 * 60_000,
      sampleIntervalMs: 10_000,
    });
    for (const site of world.sites) site.coordinate = geography.shift(site.coordinate);
    const store = new OperationStore(
      join(directory, 'world.json'),
      initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false }),
    );
    await store.update(() => {});
    harness = new DemoHarness(directory, request, store, originalActor.id);
    harness.start();
    const held = await harness.until(initial.cycle.id, (cycle) => cycle.progress?.phase === 'awaiting_route');
    const execution = held.progress!.references.execution!;
    const missionPath = `/v1/flights/${encodeURIComponent(execution.flightId)}/mission`;
    const previewPath = `/v1/flights/${encodeURIComponent(execution.flightId)}/mission-avoidance`;
    const originalMission = (await read<FlightMissionResponse>(request, missionPath)).projectedHead!;
    expect(originalMission.sourceRevision).toBe(1);
    expect((await read<MissionAvoidanceResponse>(request, previewPath)).status).toBe('intersects');
    expect(harness.store.state.world.departures ?? []).toHaveLength(0);

    await page.goto('/');
    await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
    await page.getByRole('button', { name: 'Open operations', exact: true }).click();
    // The demo flights of an accepted area control are shown on the control's own page in the safety section.
    await openControlRecord(page, hazard);
    const safety = page.getByTestId('sms-record');
    const demo = safety.getByRole('region', { name: 'Accepted control demo flight', exact: true });
    await expect(demo).toContainText('Revise the affected route');
    await expect(demo.getByRole('button', { name: 'Prepare demo flight', exact: true })).toHaveCount(0);
    await screenshot('avoidance-demo-held-desktop.png', demo);
    await page.setViewportSize({ width: 390, height: 844 });
    await demo.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('avoidance-demo-held-390.png');
    await page.setViewportSize({ width: 1440, height: 960 });
    await demo.getByRole('button', { name: 'Review affected mission →', exact: true }).click();
    const mission = page.getByRole('region', { name: 'Mission review', exact: true });
    await expect(mission.getByRole('button', { name: 'Prepare release', exact: true })).toBeDisabled();
    // The way back from a demo flight's mission is the accepted control's page.
    await mission.getByRole('button', { name: 'Return to accepted control', exact: true }).click();
    await expect(safety.getByRole('heading', { name: control.label, exact: true })).toBeVisible();
    await expect(demo).toContainText('Revise the affected route');
    await demo.getByRole('button', { name: 'Review affected mission →', exact: true }).click();
    const detour = mission.getByTestId('mission-detour');
    await detour.getByLabel('Additional clearance (m)', { exact: true }).fill('25');
    const suggested = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/flights/${execution.flightId}/mission/route-suggestion`) &&
        response.request().method() === 'POST',
    );
    await detour.getByRole('button', { name: 'Suggest detour', exact: true }).click();
    const suggestionResponse = await suggested;
    expect(suggestionResponse.ok(), await suggestionResponse.text()).toBe(true);
    const suggestion = (await suggestionResponse.json()) as MissionRouteSuggestionResponse;
    expect(suggestion.status).toBe('suggested');
    expect(suggestion.timeFit.status).toBe('fits');
    await detour.locator('.detour-comparison').scrollIntoViewIfNeeded();
    await screenshot('avoidance-demo-route-suggestion-desktop.png');
    const suggestedMap = detour.getByTestId('mission-route-coordinate-map').locator('svg');
    await suggestedMap.scrollIntoViewIfNeeded();
    await screenshot('avoidance-demo-route-map-desktop.png', suggestedMap);
    const applyRevision = detour.getByRole('button', { name: 'Apply suggested mission revision', exact: true });
    await applyRevision.scrollIntoViewIfNeeded();
    await screenshot('avoidance-demo-route-application-desktop.png');
    await applyRevision.click();
    await expect(detour).toContainText('Mission revision 2 projected');
    const adopted = (await read<FlightMissionResponse>(request, missionPath)).projectedHead!;
    expect(adopted.route).toEqual(suggestion.proposedRoute);
    expect(adopted.routePlanning).toEqual(originalMission.routePlanning);
    expect(adopted.operatingInterval).toEqual(originalMission.operatingInterval);
    await harness.until(initial.cycle.id, (cycle) => cycle.progress?.phase === 'awaiting_release');
    await expect(mission.getByRole('button', { name: 'Prepare release', exact: true })).toBeEnabled();
    await mission.getByRole('button', { name: 'Prepare release', exact: true }).click();
    const releaseForm = mission.getByTestId('mission-release-form');
    const departureStart = Math.max(
      Math.ceil(Date.parse(adopted.operatingInterval.start) / 60_000) * 60_000,
      Math.ceil(Date.now() / 60_000) * 60_000,
    );
    await releaseForm
      .getByLabel('Departure window starts', { exact: true })
      .fill(await localMinute(page, departureStart));
    await releaseForm
      .getByLabel('Departure window ends', { exact: true })
      .fill(await localMinute(page, departureStart + 10 * 60_000));
    await releaseForm
      .getByLabel('Release note', { exact: true })
      .fill('Release the reviewed detour for this held demo flight while retaining its required service and return.');
    const released = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') && response.request().postDataJSON()?.kind === 'mission.release',
    );
    await attestReleaseFindings(releaseForm);
    await releaseForm.getByRole('button', { name: 'Record mission release', exact: true }).click();
    const releaseResponse = await released;
    expect(releaseResponse.status(), await releaseResponse.text()).toBe(201);
    const releaseId = ((await releaseResponse.json()) as CommandResponse).command.id;
    expect((releaseResponse.request().postDataJSON() as MissionReleaseCommand).mission.eventId).toBe(adopted.id);
    await harness.until(initial.cycle.id, (cycle) => cycle.progress?.phase === 'awaiting_briefing');
    await mission.getByRole('button', { name: 'Prepare exact briefing →', exact: true }).click();
    const briefing = page.getByRole('region', { name: 'Mission briefing', exact: true });
    await briefing.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
    const briefingForm = briefing.getByTestId('mission-briefing-form');
    // A new briefing covers every control in the release until the author narrows it; this one covers the demo's.
    const covered = briefingForm.getByRole('group', { name: /^Controls this briefing covers/ });
    for (const box of await covered.getByRole('checkbox').all()) await box.uncheck();
    await covered.locator(`input[id$="-control-${control.id}"]`).check();
    await briefingForm
      .getByLabel('Message', { exact: true })
      .fill('Review the accepted avoidance area and the revised route before this demo flight departs.');
    const recipients = briefingForm.getByRole('group', { name: 'Recipients', exact: true });
    await recipients.getByRole('checkbox', { name: new RegExp(dana.name) }).check();
    const briefed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/commands') && response.request().postDataJSON()?.kind === 'mission.brief',
    );
    await briefingForm.getByRole('button', { name: 'Record briefing', exact: true }).click();
    const briefingResponse = await briefed;
    expect(briefingResponse.status(), await briefingResponse.text()).toBe(201);
    const briefingId = ((await briefingResponse.json()) as CommandResponse).command.id;
    expect((briefingResponse.request().postDataJSON() as MissionBriefingCommand).recipientPrincipalIds).toEqual([
      dana.id,
    ]);
    const awaitingAck = await harness.until(
      initial.cycle.id,
      (cycle) => cycle.progress?.phase === 'awaiting_acknowledgement',
    );
    expect(awaitingAck.progress!.references).toMatchObject({
      release: { id: releaseId },
      briefing: { id: briefingId },
    });
    expect(harness.store.state.world.departures ?? []).toHaveLength(0);
    await expect(briefing).toContainText('this held demo flight can depart under its recorded release');
    await briefing.getByRole('checkbox', { name: 'I reviewed this exact briefing', exact: true }).check();
    await screenshot('avoidance-demo-personal-review-desktop.png');
    await briefing.getByRole('button', { name: 'Acknowledge my review', exact: true }).click();
    await expect
      .poll(async () => {
        const acknowledged = await read<MissionBriefingAcknowledgementsResponse>(
          request,
          `/v1/flights/${execution.flightId}/briefings/${briefingId}/acknowledgements`,
        );
        return (
          acknowledged.recipients.length > 0 &&
          acknowledged.recipients.every(
            (recipient) => recipient.acknowledgement && recipient.processing === 'completed',
          )
        );
      })
      .toBe(true);
    const observing = await harness.until(
      initial.cycle.id,
      (cycle) => Boolean(cycle.progress?.references.departure),
      120_000,
    );
    const attempt = harness.store.state.world.attempts.find((row) => row.id === execution.reservationId)!;
    expect(attempt.routeTimeline!.plan.route).toEqual(adopted.route);
    expect(attempt.routeTimeline!.plan.sourceRevision).toBe(2);
    const departed = harness.store.state.world.departures!.filter(
      (row) => row.reservationId === execution.reservationId,
    );
    expect(departed).toHaveLength(1);
    const exactPhysicalCommit = structuredClone(departed[0]!);
    const exactDeparture = structuredClone(observing.progress!.references.departure!);
    await harness.restart();
    const finished = await harness.until(
      initial.cycle.id,
      (cycle) => cycle.progress?.phase === 'monitoring_available',
      7 * 60_000,
    );
    await harness.stop();
    expect(finished.progress!.references.departure).toEqual(exactDeparture);
    // Live monitoring opens a control window for the control, naming this flight; no baseline or monitoring window.
    expect(finished.progress!.references.baseline).toBeUndefined();
    expect(finished.progress!.references.monitoring).toBeUndefined();
    const windowPin = finished.progress!.references.controlWindow!;
    const { window: controlWindow } = await read<ControlWindowResponse>(request, `/v1/control-windows/${windowPin.id}`);
    expect(controlWindow.revision.digest).toBe(windowPin.digest);
    expect(controlWindow.control).toEqual({
      kind: 'control_record',
      hazardId: hazard.id,
      recordId: control.controlId,
      versionNumber: control.controlVersion,
      bodyDigest: control.bodyDigest,
      acceptanceId: hazard.acceptance.id,
    });
    expect(controlWindow.population).toMatchObject({
      subjects: [{ scope: 'ledger', kind: 'flight', id: execution.flightId }],
      complete: true,
    });
    expect(controlWindow.expectedObservations).toEqual([
      { type: 'flight.report', versions: [1] },
      { type: 'link.status', versions: [1] },
    ]);
    const telemetry = await read<TelemetryResponse>(request, `/v1/flights/${execution.flightId}/telemetry`);
    expect(telemetry.samples.length).toBeGreaterThan(0);
    const retained = await retainedDepartures(harness.store, execution.reservationId);
    expect(retained).toEqual([exactPhysicalCommit]);
    expect(retained[0]).toMatchObject({
      flightId: execution.flightId,
      aircraftId: execution.aircraftId,
      departureAttemptId: exactDeparture.attemptId,
      permit: { id: exactDeparture.permit.id, mission: finished.progress!.references.mission },
      permitDigest: exactDeparture.permit.digest,
    });
    harness.start();
    await expect(page.getByTestId('avoidance-demo-control-window').first()).toContainText(windowPin.id);
    await screenshot('avoidance-demo-control-window-desktop.png');
    await briefing.getByRole('button', { name: '← Return to mission review', exact: true }).click();
    await mission.getByRole('button', { name: 'Return to accepted control', exact: true }).click();
    await expect(demo.getByTestId('avoidance-demo-control-window')).toContainText(windowPin.id);
    await expect(demo.getByRole('button', { name: 'Prepare another demo flight', exact: true })).toBeEnabled();

    const preparationAttempts: Array<{ body: string | null; key: string | undefined }> = [];
    let repeated: Cycle | undefined;
    const preparationPath = `**/v1/hazards/${encodeURIComponent(hazard.id)}/avoidance-demos`;
    await page.route(preparationPath, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      preparationAttempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
      if (preparationAttempts.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      repeated = (await response.json()) as Cycle;
      await route.abort('failed');
    });
    try {
      await demo.getByRole('button', { name: 'Prepare another demo flight', exact: true }).click();
      await expect(demo.getByRole('button', { name: 'Recover same preparation request', exact: true })).toBeVisible();
      await demo.getByRole('button', { name: 'Recover same preparation request', exact: true }).click();
      await expect.poll(() => preparationAttempts.length).toBe(2);
      expect(preparationAttempts[1]).toEqual(preparationAttempts[0]);
      await expect(demo.getByRole('button', { name: 'Recover same preparation request', exact: true })).toBeHidden();
    } finally {
      await page.unroute(preparationPath);
    }
    expect(repeated!.cycle.previousCycleId).toBe(initial.cycle.id);
    const next = await harness.until(repeated!.cycle.id, (cycle) => cycle.progress?.phase === 'awaiting_route');
    expect(next.progress!.references.execution!.flightId).not.toBe(execution.flightId);
    expect((await exactCycle(request, initial.cycle.id)).progress!.references.controlWindow).toEqual(windowPin);
    expect((await cyclesFor(request, hazard)).cycles.map((cycle) => cycle.cycle.id)).toEqual(
      expect.arrayContaining([initial.cycle.id, repeated!.cycle.id]),
    );
    await expect(demo).toContainText('Demo flight history');
    await screenshot('avoidance-demo-next-cycle-desktop.png', demo);
    await page.setViewportSize({ width: 390, height: 844 });
    await demo.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('avoidance-demo-next-cycle-390.png');
    await page.setViewportSize({ width: 1440, height: 960 });
    await demo.getByText(/Demo flight history ·/).click();
    await demo.getByRole('button', { name: /^Initial flight/ }).click();
    // A finished cycle's mission is inspected as recorded.
    await demo.getByRole('button', { name: 'Inspect recorded mission →', exact: true }).click();
    const controlPreview = mission
      .getByRole('region', { name: 'Route avoidance preview', exact: true })
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: control.label, exact: true }) });
    await expect(controlPreview).toBeVisible();
    // The area's hazard opens on its safety record page; the mission stays open behind the safety section.
    await controlPreview.getByRole('button', { name: hazard.title, exact: true }).click();
    await expect(safety.getByRole('heading', { name: hazard.title, exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Flights', exact: true }).click();
    await expect(mission.getByRole('button', { name: 'Return to accepted control', exact: true })).toBeVisible();
    await mission.getByRole('button', { name: 'Return to accepted control', exact: true }).click();
    await expect(demo).toContainText('Demo flight history');
    await demo.getByText(/Demo flight history ·/).click();
    await demo.getByRole('button', { name: /^Initial flight/ }).click();
    await expect(demo.getByRole('button', { name: /^Initial flight/ })).toHaveAttribute('aria-current', 'true');
    await expect(demo).toContainText('Flight sample recorded');
    await harness.stop();
    await harness.store.update((state) =>
      cancelOperationDemoFlight(
        state.world,
        next.progress!.references.execution!.reservationId,
        'The fictional dispatcher cancelled this unused browser demonstration after its repeat association was checked.',
      ),
    );
    harness.start();
    await harness.until(repeated!.cycle.id, (cycle) => cycle.progress?.phase === 'abandoned');
    const retainedFlight = await read<TimelineResponse>(request, `/v1/flights/${execution.flightId}/timeline`);
    expect(retainedFlight.items.some((item) => item.id === adopted.id)).toBe(true);
    completed = true;
  } finally {
    try {
      await harness?.stop();
      for (const [saved, token, granted] of [
        [originalActor, releaseAuthor, actorGranted],
        [originalOperator, operator, operatorGranted],
        [originalSource, source, sourceGranted],
      ] as const) {
        if (!granted) continue;
        const current = await principal(request, token);
        await command(request, {
          kind: 'authority.update',
          principalId: saved.id,
          expectedRevision: current.revision,
          capabilities: saved.capabilities,
          missionSources: saved.missionSources,
          monitoringSources: saved.monitoringSources ?? [],
          observationGrants: saved.observationGrants ?? [],
        });
      }
      if (completed) await rm(directory, { recursive: true, force: true });
      else testInfo.annotations.push({ type: 'retained simulator checkpoint', description: directory });
    } finally {
      geography.restore();
    }
  }
});
