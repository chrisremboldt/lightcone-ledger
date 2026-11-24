import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandLinkStatusAdapter, HttpObservationSink, LedgerClient, translateAndSubmit } from '@ledger/adapters';
import type { ControlWindow, ControlWindowOpen, Input, Upload, UploadCreate } from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';
import {
  advanceOperation,
  compactOperation,
  createOperation,
  operationCapacityPreset,
} from '../../../packages/simulation-models/src/operation.js';
import {
  createOperationMonitoringRuntimeState,
  OperationMonitoringRuntime,
  operationMonitoringStatusAllowed,
  type OperationMonitoringRuntimePlan,
} from '../src/operation-monitoring-runtime.js';
import { loadOperationMonitoringRuntime } from '../src/operation-monitoring-options.js';
import { runOperation } from '../src/operation.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
} from '../src/operation-state.js';

const directories: string[] = [];
const start = Date.parse('2026-10-16T14:00:00.000Z');
const iso = (offset: number) => new Date(start + offset).toISOString();
const flightId = 'ledger-selected-flight';
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(monitored = true) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-monitoring-runtime-'));
  directories.push(directory);
  const path = join(directory, 'world.json');
  const runId = 'monitoring-runtime';
  const attemptId = `intent-${runId}-alpha-0:attempt:1`;
  const world = createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId,
    start: iso(0),
    seed: 71031,
    fleet: { alpha: 1, beta: 1 },
    missionPlan: 'dispatch-plan.1',
    commandLinkEpisode: 'canal-market-relay.1',
    ...(monitored
      ? { simulatedLink: { version: 'simulated-link.1' as const, attemptId, initialState: 'up' as const } }
      : {}),
  });
  const initialWorld = structuredClone(world);
  const plan: OperationMonitoringRuntimePlan = {
    version: 1,
    apiUrl: 'http://monitoring-runtime.invalid',
    principalId: 'world-monitoring-source',
    radioInitialState: 'up',
    monitoring: {
      version: 1,
      runId,
      tenant: 'alpha',
      sourceId: 'simulation-monitoring',
      sourceSessionId: `${runId}:monitoring:1`,
      sourceWindowId: `${runId}:window:1`,
      control: {
        hazardId: 'selected-hazard',
        controlId: 'selected-control',
        controlVersion: 1,
        controlEventId: 'selected-control-event',
        controlDigest: '1'.repeat(64),
        acceptance: { id: 'selected-acceptance', acceptedRevision: 4, digest: '2'.repeat(64) },
      },
      window: { start: iso(150_000), end: iso(600_000) },
      flights: [{ attemptId, initialLinkState: 'up', monitoringAvailable: true }],
    },
  };
  const checkpoint = initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false });
  if (monitored) checkpoint.monitoring = createOperationMonitoringRuntimeState(plan, world);
  let store = new OperationStore(path, checkpoint);
  const state = { loseWindow: false };
  const calls: string[] = [];
  const windowRequests: Array<{ key: string; body: string }> = [];
  const inputs: Input[] = [];
  const uploads = new Map<string, { bytes?: Buffer; upload: Upload }>();
  const uploadKeys = new Map<string, string>();
  const opened = new Map<string, ControlWindow>();
  const principal = () => ({
    id: plan.principalId,
    tenantId: 'tenant-alpha',
    name: 'Fictional monitoring source',
    revision: 3,
    capabilities: ['input:write', 'flight:read', 'monitoring:write'],
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [plan.monitoring.sourceId],
  });
  const fetcher: typeof fetch = async (url, init) => {
    const request = new URL(String(url));
    const path = request.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const key = new Headers(init?.headers).get('idempotency-key') ?? '';
    if (path === '/v1/me') return Response.json({ principal: principal() });
    if (path === '/v1/flights') {
      const observed = store.state.monitoring!.observer.flights[0]!;
      expect(request.searchParams.get('search')).toBe(observed.aircraftId);
      expect(request.searchParams.get('limit')).toBe('200');
      const flight = (id: string, originationKey: string) => ({
        id,
        label: 'Fictional monitored flight',
        originationKey,
        aircraft: observed.aircraftId,
        revision: 1,
        basisRevision: 1,
        activity: 'active',
        coverage: 'recorded',
        orderIds: [],
        sourceIds: ['partner-orders'],
        unresolvedCount: 0,
        conflictCount: 0,
        outstandingWork: 0,
      });
      return Response.json({
        flights: [flight('wrong-attempt', 'another-attempt'), flight(flightId, attemptId)],
        nextCursor: null,
        meta: {
          requestId: 'runtime-roster',
          projectionRevision: 0,
          inputCut: { streams: {}, principalRevision: 3 },
          computedAt: new Date(store.state.world.now).toISOString(),
          outstandingWork: 0,
        },
      });
    }
    if (path === '/v1/control-windows' && method === 'POST') {
      const body = init!.body as string;
      windowRequests.push({ key, body });
      const persisted = (await readOperationCheckpoint(join(directory, 'world.json')))!.monitoring!;
      expect(persisted.controlWindow).toMatchObject({ key, request: JSON.parse(body) });
      const open = JSON.parse(body) as ControlWindowOpen;
      if (!opened.has(key))
        opened.set(key, {
          id: `window-${opened.size + 1}`,
          variant: 'generic',
          organizationId: 'organization:tenant-alpha',
          control: open.control,
          period: open.period,
          population: {
            subjectKind: open.subjectKind,
            subjects: open.subjects,
            complete: open.complete,
            declaredBy: { kind: 'source', id: plan.principalId },
          },
          expectedObservations: open.expectedObservations,
          indicators: open.indicators,
          openedAt: new Date(store.state.world.now).toISOString(),
          revision: {
            number: 1,
            id: 'window-revision-1',
            recordedAt: new Date(store.state.world.now).toISOString(),
            digest: '3'.repeat(64),
            note: open.note,
          },
        });
      if (state.loseWindow) {
        state.loseWindow = false;
        throw new Error('Lost control window response after it was opened');
      }
      return Response.json({ window: opened.get(key) }, { status: 201 });
    }
    if (path === '/v1/uploads' && method === 'POST') {
      const body = JSON.parse(init!.body as string) as UploadCreate;
      let id = uploadKeys.get(key);
      if (!id) {
        id = `upload-${uploads.size}`;
        uploadKeys.set(key, id);
        uploads.set(id, {
          upload: { id, status: 'pending', contentType: body.contentType, byteLength: body.byteLength },
        });
      }
      return Response.json({ upload: uploads.get(id)!.upload });
    }
    const upload = path.match(/^\/v1\/uploads\/([^/]+)\/(content|finalize)$/);
    if (upload) {
      const value = uploads.get(upload[1]!)!;
      if (upload[2] === 'content') {
        value.bytes = Buffer.from(init!.body as Uint8Array);
        value.upload.status = 'stored';
        value.upload.sha256 = sha256(value.bytes);
        return Response.json({ upload: value.upload });
      }
      return Response.json({
        artifact: {
          id: `artifact-${upload[1]}`,
          uploadId: value.upload.id,
          sha256: sha256(value.bytes!),
          byteLength: value.bytes!.length,
          contentType: value.upload.contentType,
          key: `${value.upload.id}/content`,
        },
      });
    }
    if (path !== '/v1/inputs' || method !== 'POST') throw new Error(`Unexpected runtime request ${method} ${path}`);
    const input = JSON.parse(init!.body as string) as Input;
    inputs.push(input);
    return Response.json({ receipt: { id: `receipt-${key}`, kind: input.kind } }, { status: 201 });
  };
  const ledger = new LedgerClient(plan.apiUrl, 'test-source-credential', fetcher);
  const runtime = () => new OperationMonitoringRuntime({ plan, ledger });
  const advance = async (offset: number) => store.update((next) => advanceLiveClock(next, start + offset, false));
  const restart = async () => {
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
  };
  const deliverStatuses = async () => {
    for (const prepared of store.pendingCommandLinkHeads()) {
      const fact = prepared.fact;
      if (
        fact.kind !== 'command-link' ||
        fact.attemptId !== attemptId ||
        !operationMonitoringStatusAllowed(store.state.monitoring, fact.attemptId)
      )
        continue;
      const outcome = await translateAndSubmit(
        commandLinkStatusAdapter,
        {
          bytes: Buffer.from(prepared.bytesBase64, 'base64'),
          contentType: 'application/json',
          transport: {},
          capturedAt: fact.at,
        },
        {
          subjects: { scope: 'ledger', ids: { flight: { [fact.sourceSessionId]: flightId } } },
          binding: { sourceSessionId: fact.sourceSessionId, aircraftId: fact.aircraftId },
        },
        new HttpObservationSink({ ledger, sourceId: fact.sourceId }),
      );
      await store.accept(prepared, outcome.submitted[0]!.receiptId);
    }
  };
  await advance(0);
  return {
    directory,
    path,
    plan,
    attemptId,
    initialWorld,
    state,
    calls,
    windowRequests,
    inputs,
    uploads,
    fetcher,
    runtime,
    advance,
    restart,
    deliverStatuses,
    store: () => store,
  };
}

describe('live operation monitoring delivery runtime', () => {
  it('opens the control window once the window is observed, retaining its request and replaying it exactly across restart', async () => {
    const f = await fixture();
    expect(operationMonitoringStatusAllowed(f.store().state.monitoring, f.attemptId)).toBe(false);
    expect(await f.runtime().run(f.store())).toMatchObject({ status: 'pending', code: 'observation_pending' });
    expect(f.store().state.monitoring!.binding!.flight.id).toBe(flightId);
    expect(f.store().state.monitoring!.controlWindow).toBeUndefined();
    expect(operationMonitoringStatusAllowed(f.store().state.monitoring, f.attemptId)).toBe(true);
    expect(operationMonitoringStatusAllowed(f.store().state.monitoring, 'unselected-attempt')).toBe(true);
    await f.advance(150_000);
    await f.deliverStatuses();
    await f.advance(300_000);
    await f.deliverStatuses();
    expect(f.inputs.map((input) => (input.payload as { type: string }).type)).toEqual(['link.status', 'link.status']);
    await f.advance(600_000);
    f.state.loseWindow = true;
    expect((await f.runtime().run(f.store())).status).toBe('pending');
    const planned = structuredClone(f.store().state.monitoring!.controlWindow!);
    expect(planned.window).toBeUndefined();
    expect(planned.request).toMatchObject({
      control: {
        kind: 'control_record',
        hazardId: 'selected-hazard',
        recordId: 'selected-control',
        versionNumber: 1,
        bodyDigest: '1'.repeat(64),
        acceptanceId: 'selected-acceptance',
      },
      period: f.plan.monitoring.window,
      subjectKind: 'flight',
      subjects: [{ scope: 'ledger', kind: 'flight', id: flightId }],
      complete: true,
      expectedObservations: [
        { type: 'flight.report', versions: [1] },
        { type: 'link.status', versions: [1] },
      ],
    });
    expect(planned.request.indicators.map((indicator) => indicator.id)).toEqual([
      'demo-procedures.command-link-losses-per-flight-hour',
    ]);
    await f.restart();
    const result = await f.runtime().run(f.store());
    expect(result).toMatchObject({ status: 'accepted', controlWindowId: 'window-1' });
    expect(f.windowRequests).toHaveLength(2);
    expect(f.windowRequests[1]).toEqual(f.windowRequests[0]);
    expect(f.store().state.monitoring!.controlWindow).toEqual({
      ...planned,
      window: { id: 'window-1', digest: '3'.repeat(64) },
    });
    await f.runtime().run(f.store());
    expect(f.windowRequests).toHaveLength(2);
    expect(f.calls.some((call) => call.includes('baseline') || call.includes('monitoring-windows'))).toBe(false);
    expect(await readFile(f.path, 'utf8')).not.toContain('test-source-credential');
  });

  it('keeps unsupported selected delivery pending while ordinary motion continues, and leaves defaults and existing worlds unmonitored', async () => {
    const f = await fixture();
    expect(await loadOperationMonitoringRuntime({}, f.path, f.plan.apiUrl, f.fetcher)).toBeUndefined();
    expect(f.calls).toEqual([]);
    const planPath = join(f.directory, 'monitoring-plan.json');
    await writeFile(planPath, JSON.stringify(f.plan), { mode: 0o600 });
    const runtime = (await loadOperationMonitoringRuntime(
      {
        SIMULATOR_WORLD_MONITORING_PLAN: planPath,
        SIMULATOR_WORLD_MONITORING_TOKEN: 'test-source-credential',
      },
      f.path,
      f.plan.apiUrl,
      f.fetcher,
    ))!;
    expect((await runtime.run(f.store())).status).toBe('pending');
    expect(f.uploads.size).toBe(0);
    expect(f.windowRequests).toEqual([]);
    await f.advance(95_000);
    expect(f.store().state.world.attempts.some((attempt) => attempt.tenant === 'beta')).toBe(true);
    expect(
      f
        .store()
        .pendingHeads()
        .some((prepared) => prepared.fact.tenant === 'beta'),
    ).toBe(true);
    expect(operationMonitoringStatusAllowed(f.store().state.monitoring, f.attemptId)).toBe(true);
    expect(operationMonitoringStatusAllowed(f.store().state.monitoring, 'another-attempt')).toBe(true);
    const ordinary = f
      .store()
      .pendingHeads()
      .find((prepared) => prepared.fact.tenant === 'beta')!;
    await f.store().accept(ordinary, 'ordinary-receipt');
    expect(f.store().state.accepted).toBe(1);

    const defaultRun = await fixture(false);
    await defaultRun.advance(95_000);
    expect(defaultRun.store().state.monitoring).toBeUndefined();
    expect(operationMonitoringStatusAllowed(undefined, defaultRun.attemptId)).toBe(true);
    const before = structuredClone(defaultRun.store().state);
    expect(() => createOperationMonitoringRuntimeState(defaultRun.plan, defaultRun.store().state.world)).toThrow();
    expect(defaultRun.store().state).toEqual(before);
    const existingCheckpoint = await readFile(defaultRun.path);
    await expect(
      runOperation({
        SIMULATOR_WORLD_MODE: 'broker',
        SIMULATOR_WORLD_STATE: defaultRun.path,
        SIMULATOR_WORLD_MONITORING_PLAN: planPath,
        SIMULATOR_WORLD_MONITORING_TOKEN: 'test-source-credential',
        LEDGER_API_URL: defaultRun.plan.apiUrl,
      }),
    ).rejects.toThrow(/cannot be attached to an existing world/i);
    expect(await readFile(defaultRun.path)).toEqual(existingCheckpoint);
    const untouched = defaultRun.initialWorld;
    advanceOperation(untouched, start + 95_000);
    compactOperation(untouched);
    expect(defaultRun.store().state.world).toEqual(untouched);
    expect(defaultRun.windowRequests).toEqual([]);
  });

  it('cancels a stalled selected public read without changing retained source originals or preparing a submission', async () => {
    const f = await fixture();
    const planPath = join(f.directory, 'monitoring-plan.json');
    await writeFile(planPath, JSON.stringify(f.plan), { mode: 0o600 });
    const controller = new AbortController();
    const canceled = vi.fn();
    let reading!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).origin).toBe(f.plan.apiUrl);
      expect(new URL(String(input)).pathname).toBe('/v1/me');
      expect(init?.method ?? 'GET').toBe('GET');
      signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({ pull: reading, cancel: canceled }, { highWaterMark: 0 }));
    });
    const runtime = (await loadOperationMonitoringRuntime(
      { SIMULATOR_WORLD_MONITORING_PLAN: planPath, SIMULATOR_WORLD_MONITORING_TOKEN: 'test-source-credential' },
      f.path,
      f.plan.apiUrl,
      fetcher,
      { signal: controller.signal },
    ))!;
    const originals = JSON.stringify(f.store().state.pending);
    const world = JSON.stringify(f.store().state.world);
    vi.useFakeTimers();
    try {
      const pending = runtime.run(f.store());
      await bodyRead;
      controller.abort(new Error('The owning runner stopped'));
      expect((await pending).status).toBe('pending');
      expect(signal?.aborted).toBe(true);
      expect(canceled).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.store().state.pending)).toBe(originals);
      expect(JSON.stringify(f.store().state.world)).toBe(world);
      expect(f.store().state.monitoring!.binding).toBeUndefined();
      expect(f.store().state.monitoring!.controlWindow).toBeUndefined();
      expect(f.uploads.size).toBe(0);
      expect(f.windowRequests).toEqual([]);
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});
