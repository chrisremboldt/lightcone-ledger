import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AcceptedAreaControlResponse,
  Principal,
  SimulationAvoidanceDemoCycleResponse,
  SimulationAvoidanceDemoProgress,
  SimulationAvoidanceDemoProgressResponse,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  createOperation,
  advanceOperation,
  activateOperationOrdinaryDispatch,
  enableOperationOrdinaryWork,
} from '@ledger/simulation-models/operation';
import { simulationAvoidanceDemoCycle } from '../../../packages/contracts/fixtures/demo/v1/simulation-avoidance-demo.js';
import {
  areaControlBriefingContent,
  areaControlHazardId,
  areaControlRecordId,
  areaControlVersion,
} from '../../../packages/contracts/fixtures/demo/v1/area-control.js';
import { places } from '../../../packages/simulation-models/src/places.js';
import {
  OperationDemoRuntime,
  selectDemoMission,
  selectDemoRelease,
  type OperationDemoCycleState,
} from '../src/operation-demo-runtime.js';
import {
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationHistoryBatch,
} from '../src/operation-state.js';
import { readOperationHistory } from '../src/operation-history.js';

/** The accepted area control record as route review reads it, with the area and interval given. */
function areaControlRead(change: {
  center?: { latitude: number; longitude: number };
  radiusMeters?: number;
  effectiveFrom: string;
  effectiveUntil: string;
}): AcceptedAreaControlResponse {
  const parameters = {
    ...areaControlVersion.body.parameters,
    ...(change.center ? { center: change.center } : {}),
    ...(change.radiusMeters ? { radiusMeters: change.radiusMeters } : {}),
  };
  const body = {
    ...areaControlVersion.body,
    parameters,
    effectiveFrom: change.effectiveFrom,
    effectiveUntil: change.effectiveUntil,
  };
  return {
    control: {
      kind: 'control_record',
      hazard: { id: areaControlHazardId, title: 'Work site near the delivery routes' },
      controlEventId: areaControlVersion.id,
      bodyDigest: canonicalDigest(body),
      owner: areaControlVersion.owner,
      content: {
        ...areaControlBriefingContent,
        parameters,
        area: parameters,
        effectiveFrom: change.effectiveFrom,
        effectiveUntil: change.effectiveUntil,
      },
    },
  };
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const start = Date.parse('2026-10-18T17:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const principal: Principal = {
  id: 'principal-alpha-source',
  tenantId: 'tenant-alpha',
  name: 'Alpha source',
  revision: 2,
  capabilities: ['input:write', 'flight:read', 'mission:write', 'monitoring:write'],
  missionSources: ['mission-planner'],
  commandLinkSources: [],
  observationGrants: [{ sourceId: 'command-link', observationType: 'link.status' }],
  monitoringSources: ['operation-monitoring'],
};

async function fixture(ordinary = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-avoidance-demo-'));
  directories.push(directory);
  const path = join(directory, 'world.json');
  const world = createOperation({
    runId: 'same-ordinary-world',
    start: iso(start),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
  });
  if (ordinary) {
    enableOperationOrdinaryWork(world);
    activateOperationOrdinaryDispatch(world);
  }
  advanceOperation(world, start + (ordinary ? 900_000 : 0));
  const store = new OperationStore(
    path,
    initialOperationCheckpoint(world, { mode: 'live', wallAt: world.now, paused: false }),
  );
  const control = areaControlRead({
    center: places['Canal Market'],
    radiusMeters: 70,
    effectiveFrom: iso(start - 1000),
    effectiveUntil: iso(start + 3600_000),
  });
  const cycle = structuredClone(simulationAvoidanceDemoCycle);
  cycle.requestedAt = iso(start);
  cycle.control = {
    ...cycle.control,
    hazardId: areaControlHazardId,
    controlId: areaControlRecordId,
    controlVersion: areaControlVersion.versionNumber,
    controlEventId: control.control.controlEventId,
    controlDigest: control.control.bodyDigest,
  };
  const response: SimulationAvoidanceDemoCycleResponse = {
    cycle,
    digest: canonicalDigest(cycle),
    progress: null,
    progressDigest: null,
    processing: 'completed',
    readAt: iso(start),
  };
  const sends: Array<{ body: string; key: string }> = [];
  const accepted = new Map<string, SimulationAvoidanceDemoProgressResponse>();
  let loseReply = false;
  let rejectProgress = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/me') return json({ principal });
    if (url.pathname === '/v1/simulation/avoidance-demos/requests')
      return json({ cycles: [response], nextCursor: 'after-cycle-1', readAt: iso(start) });
    if (url.pathname.includes('/area-controls/')) return json(control);
    if (url.pathname.endsWith('/preparation-context')) {
      const { operatingInterval } = JSON.parse(String(init?.body));
      return json({
        version: 'simulation.avoidance-preparation-context.1',
        cycle: { id: cycle.id, digest: canonicalDigest(cycle) },
        operatingInterval,
        evaluatedAt: iso(start),
        status: 'ready',
        controls: [
          {
            ...cycle.control,
            center: control.control.content.area.center,
            radiusMeters: control.control.content.area.radiusMeters,
          },
        ],
        candidateCompleteness: { status: 'complete', count: 1, limit: 64 },
        contextDigest: 'a'.repeat(64),
        reasons: [],
      });
    }
    if (url.pathname.endsWith('/progress')) {
      const body = String(init?.body);
      const key = new Headers(init?.headers).get('idempotency-key')!;
      sends.push({ body, key });
      if (rejectProgress) {
        rejectProgress = false;
        return new Response(
          JSON.stringify({ error: { code: 'simulation_demo_reference_invalid', message: 'Release expired' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      const request = JSON.parse(body) as SimulationAvoidanceDemoProgress;
      let result = accepted.get(key);
      if (!result) {
        const { expectedRevision, ...content } = request;
        const progress = {
          ...content,
          id: `progress-${expectedRevision + 1}`,
          cycleId: cycle.id,
          revision: expectedRevision + 1,
          recordedAt: iso(start),
          actorId: principal.id,
        };
        result = { progress, digest: canonicalDigest(progress) };
        accepted.set(key, result);
        response.progress = progress;
        response.progressDigest = result.digest;
      }
      if (loseReply) {
        loseReply = false;
        throw new Error('accepted response lost');
      }
      return json(result);
    }
    if (url.pathname === '/v1/flights') return json({ flights: [], nextCursor: null });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const runtime = () =>
    new OperationDemoRuntime({
      apiUrl: 'http://127.0.0.1:4000',
      sourceToken: 'source',
      actorToken: 'actor',
      departurePrincipalId: 'principal-alpha-actor',
      directory: join(directory, 'demo'),
      now: () => start,
      fetcher,
    });
  return {
    path,
    directory,
    store,
    runtime,
    response,
    fetcher,
    sends,
    lose: () => {
      loseReply = true;
    },
    reject: () => {
      rejectProgress = true;
    },
  };
}

describe('durable same-world demo coordinator', () => {
  it('retains the next free Alpha resource across restart instead of losing it to queued ordinary work', async () => {
    const setup = await fixture(true);
    const initial = structuredClone(setup.store.state.world.reservations!.filter((row) => row.tenant === 'alpha'));
    expect(initial).toHaveLength(3);
    await setup.runtime().run(setup.store);
    const id = setup.response.cycle.id;
    expect(setup.store.state.demoCycles![id]!.flight).toBeUndefined();
    expect(setup.store.state.world.demoResourcePriority?.cycleId).toBe(id);
    const recovered = new OperationStore(setup.path, (await readOperationCheckpoint(setup.path))!);
    expect(recovered.state.world.demoResourcePriority).toEqual(setup.store.state.world.demoResourcePriority);
    let released: string | undefined;
    for (let index = 0; index < 20 && !released; index++) {
      let retired: string | undefined;
      await recovered.update((state) => {
        advanceOperation(state.world, state.world.now + 20_000);
        const expired = state.world.reservations!.find((row) => row.tenant === 'alpha' && row.phase === 'cancelled');
        if (expired) {
          released = expired.aircraftId;
          retired = expired.id;
          (state.ordinaryFlights ??= {})[expired.id] = {
            version: 'operation.ordinary-source.1',
            reservationId: expired.id,
            tenant: 'alpha',
            sourcePrincipalId: 'principal-alpha-source',
            automaticReleasePrincipalId: 'principal-alpha-actor',
            publicRevision: 0,
            needsHumanReview: false,
            terminalConfirmed: true,
          };
        }
      });
      if (retired) {
        for (const prepared of [...(recovered.state.pending[retired] ?? [])])
          await recovered.accept(prepared, `ordinary-receipt-${prepared.fact.sequence}`);
        await recovered.archiveOrdinaryFlight(retired);
        await recovered.update((state) => {
          advanceOperation(state.world, state.world.now);
          expect(state.world.aircraft.find((row) => row.id === released)?.phase).toBe('ready');
        });
      }
      await setup.runtime().run(recovered);
    }
    expect(released).toBeDefined();
    const demo = recovered.state.demoCycles![id]!.flight!;
    expect(demo).toBeDefined();
    expect(recovered.state.world.reservations!.find((row) => row.id === demo.attemptId)?.aircraftId).toBe(released);
    expect(recovered.state.world.demoResourcePriority).toBeUndefined();
    for (const original of initial) {
      const retained = recovered.state.world.reservations!.find((row) => row.id === original.id);
      if (retained) {
        expect(retained.order).toEqual(original.order);
        expect(retained.plan).toEqual(original.plan);
      }
    }
  });

  it('releases priority on repeated unknown progress recovery failures without replacing the request', async () => {
    const setup = await fixture(true);
    setup.lose();
    await expect(setup.runtime().run(setup.store)).rejects.toThrow('accepted response lost');
    const id = setup.response.cycle.id;
    const pending = structuredClone(setup.store.state.demoCycles![id]!.pendingProgress);
    expect(setup.store.state.world.demoResourcePriority).toBeUndefined();
    const recovered = new OperationStore(setup.path, (await readOperationCheckpoint(setup.path))!);
    setup.lose();
    await expect(setup.runtime().run(recovered)).rejects.toThrow('accepted response lost');
    expect(recovered.state.world.demoResourcePriority).toBeUndefined();
    expect(recovered.state.demoCycles![id]!.pendingProgress).toEqual(pending);
    expect(setup.sends[0]).toEqual(setup.sends[1]);
  });

  it('retains a definitive ready rejection and can cancel and archive the expired unused flight', async () => {
    const setup = await fixture();
    await setup.runtime().run(setup.store);
    const id = setup.response.cycle.id;
    const flight = setup.store.state.demoCycles![id]!.flight!;
    const reservation = setup.store.state.world.reservations!.find((row) => row.id === flight.attemptId)!;
    const mission = {
      missionId: 'projected-mission',
      sourceRevision: 2,
      eventId: 'projected-revision',
      contentDigest: 'a'.repeat(64),
      recordDigest: 'b'.repeat(64),
    };
    const release = { id: 'expired-release', digest: 'c'.repeat(64) };
    const request: SimulationAvoidanceDemoProgress = {
      version: 'simulation.avoidance-progress.1',
      expectedRevision: 1,
      phase: 'ready',
      code: 'human_review_complete',
      retryable: true,
      reason: 'Review completed before the release expired during its progress request.',
      references: { mission, release },
    };
    const pending = { body: JSON.stringify(request), key: 'simulator:demo-progress:ready-expired' };
    await setup.store.update((state) => {
      const cycle = state.demoCycles![id]!;
      cycle.references = structuredClone(request.references);
      cycle.pendingProgress = pending;
      cycle.departurePlan = {
        version: 1,
        apiUrl: 'http://127.0.0.1:4000',
        tenantId: 'tenant-alpha',
        principalId: 'principal-alpha-actor',
        runId: state.world.config.runId,
        reservationId: reservation.id,
        flightId: 'projected-flight',
        aircraftId: reservation.aircraftId,
        release,
        mission,
        departureAttemptId: 'not-departed',
        marginMs: 10_000,
        latencyMarginMs: 10_000,
        handoffAllowanceMs: 30_000,
        allocationDurationMs: 90_000,
      };
    });
    setup.reject();
    await expect(setup.runtime().run(setup.store)).rejects.toThrow('definitively rejected');
    expect(setup.store.state.demoCycles![id]!.pendingProgress).toBeUndefined();
    expect(setup.store.state.demoCycles![id]!.rejectedProgress).toEqual([
      { ...pending, status: 409, code: 'simulation_demo_reference_invalid', rejectedAt: iso(start) },
    ]);
    const deadline = setup.store.state.world.events.find(
      (event) => event.kind === 'reservation-expiry' && event.attemptId === reservation.id,
    )!;
    await setup.store.update((state) => advanceOperation(state.world, deadline.at));
    expect(setup.store.state.world.reservations!.find((row) => row.id === reservation.id)?.phase).toBe('cancelled');
    const originals = setup.store.state.pending[reservation.id]!;
    expect(originals.at(-1)!.fact.kind).toBe('cancellation');
    for (const original of [...originals]) await setup.store.accept(original, `receipt-${original.fact.sequence}`);
    await setup.runtime().run(setup.store);
    expect(setup.store.state.demoCycles![id]!.progress?.progress.phase).toBe('abandoned');
    expect(setup.store.state.world.departures).toBeUndefined();
    expect(setup.store.state.world.demoFlights).toHaveLength(1);
    await setup.runtime().run(setup.store);
    const retired: OperationHistoryBatch[] = [];
    for await (const { value: batch } of readOperationHistory<OperationHistoryBatch>(setup.store.historyDirectory))
      if (batch.demoCycles?.length) retired.push(batch);
    expect(retired[0]!.demoCycles![0]!.rejectedProgress?.[0]).toMatchObject(pending);
    expect(retired[0]!.demoCycles![0]!.archivedRecovery).toMatchObject({
      reservation: { id: reservation.id, personId: reservation.personId, phase: 'cancelled' },
    });
    expect(setup.sends.filter((send) => send.key === pending.key)).toEqual([pending]);
  });
  it('recovers an accepted lost progress reply with identical body/key after restart and never reserves twice', async () => {
    const setup = await fixture();
    const original = structuredClone(setup.store.state.world.config);
    setup.lose();
    await expect(setup.runtime().run(setup.store)).rejects.toThrow('accepted response lost');
    const pending = setup.store.state.demoCycles![setup.response.cycle.id]!.pendingProgress!;
    const attemptId = setup.store.state.demoCycles![setup.response.cycle.id]!.flight!.attemptId;
    const recovered = new OperationStore(setup.path, (await readOperationCheckpoint(setup.path))!);
    await setup.runtime().run(recovered);
    expect(setup.sends).toHaveLength(2);
    expect(setup.sends[0]).toEqual(setup.sends[1]);
    expect(setup.sends[0]).toEqual(pending);
    expect(recovered.state.world.demoFlights).toHaveLength(1);
    expect(recovered.state.world.reservations?.filter((row) => row.id === attemptId)).toHaveLength(1);
    expect(recovered.state.demoCycles![setup.response.cycle.id]!.publicRevision).toBe(1);
    expect(recovered.state.world.config).toEqual(original);
    expect(recovered.state.world.resources).toBeUndefined();
  });

  it('archives terminal immutable commitments before advancing discovery to another fresh cycle', async () => {
    const setup = await fixture();
    const obstruction = structuredClone(setup.response.cycle);
    const controlRead = areaControlRead({ effectiveFrom: iso(start), effectiveUntil: iso(start + 1000) });
    obstruction.control.controlDigest = controlRead.control.bodyDigest;
    setup.response.cycle = obstruction;
    setup.response.digest = canonicalDigest(obstruction);
    const sourceFetcher: typeof fetch = async (input, init) =>
      String(input).includes('/area-controls/')
        ? new Response(JSON.stringify(controlRead), { headers: { 'content-type': 'application/json' } })
        : setup.fetcher(input, init);
    const runtime = new OperationDemoRuntime({
      apiUrl: 'http://127.0.0.1:4000',
      sourceToken: 'source',
      actorToken: 'actor',
      departurePrincipalId: 'principal-alpha-actor',
      directory: join(setup.directory, 'demo'),
      now: () => start,
      fetcher: sourceFetcher,
    });
    await runtime.run(setup.store);
    expect(setup.store.state.demoCycles![obstruction.id]!.progress?.progress.phase).toBe('abandoned');
    expect(setup.store.state.world.demoResourcePriority).toBeUndefined();
    await runtime.run(setup.store);
    expect(Object.keys(setup.store.state.demoCycles!)).toHaveLength(0);
    const retired: OperationHistoryBatch[] = [];
    for await (const { value: batch } of readOperationHistory<OperationHistoryBatch>(setup.store.historyDirectory))
      if (batch.demoCycles?.length) retired.push(batch);
    expect(retired).toHaveLength(1);
    expect(retired[0]!.demoCycles![0]!.cycle).toEqual(obstruction);
    expect(retired[0]!.demoCycles![0]!.terminalConfirmed).toBe(true);
    await runtime.run(setup.store);
    expect(setup.store.state.demoDiscovery?.cursor).toBe('after-cycle-1');
    expect(setup.store.state.world.config.runId).toBe('same-ordinary-world');
    expect(setup.store.state.world.config.start).toBe(iso(start));
  });
  it('clears only current dependent review references when a human replaces a mission or release', () => {
    const mission = {
      missionId: 'mission',
      sourceRevision: 1,
      eventId: 'original',
      contentDigest: 'a'.repeat(64),
      recordDigest: 'b'.repeat(64),
    };
    const state: OperationDemoCycleState = {
      version: 'operation.demo-cycle.1',
      cycle: simulationAvoidanceDemoCycle,
      cycleDigest: canonicalDigest(simulationAvoidanceDemoCycle),
      publicRevision: 0,
      references: {
        mission,
        release: { id: 'release-old', digest: 'c'.repeat(64) },
        briefing: { id: 'brief-old', digest: 'd'.repeat(64) },
      },
    };
    const previous = structuredClone(state.references);
    selectDemoMission(state, { ...mission, sourceRevision: 2, eventId: 'new' });
    expect(state.references.release).toBeUndefined();
    expect(state.references.briefing).toBeUndefined();
    selectDemoRelease(state, { id: 'release-new', digest: 'e'.repeat(64) });
    state.references.briefing = { id: 'brief-new', digest: 'f'.repeat(64) };
    selectDemoRelease(state, { id: 'release-next', digest: 'e'.repeat(64) });
    expect(state.references.briefing).toBeUndefined();
    expect(state.references.mission?.sourceRevision).toBe(2);
    expect(previous.release?.id).toBe('release-old');
    expect(previous.briefing?.id).toBe('brief-old');
  });
  it('refreshes only the discovery cursor after a legitimate source authority revision changes', async () => {
    const setup = await fixture();
    await setup.store.update((state) => {
      state.demoDiscovery = {
        sourcePrincipalId: principal.id,
        principalRevision: principal.revision - 1,
        cursor: 'old-authority',
      };
    });
    const queries: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/requests')) {
        queries.push(url.search);
        if (url.search.includes('old-authority')) throw new Error('invalid_cursor');
      }
      return setup.fetcher(input, init);
    };
    const runtime = new OperationDemoRuntime({
      apiUrl: 'http://127.0.0.1:4000',
      sourceToken: 'source',
      actorToken: 'actor',
      departurePrincipalId: 'principal-alpha-actor',
      directory: join(setup.directory, 'demo'),
      now: () => start,
      fetcher,
    });
    await runtime.run(setup.store);
    expect(queries).toEqual(['?limit=25']);
    expect(Object.keys(setup.store.state.demoCycles!)).toEqual([setup.response.cycle.id]);
    expect(setup.store.state.world.demoFlights).toHaveLength(1);
  });
});
