import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MissionDepartureAcceptedCommandSchema,
  MissionDepartureAuthorizationCommandSchema,
  MissionDepartureAuthorizationResultSchema,
  type MissionDepartureAuthorizationCommand,
  type MissionDepartureAuthorizationResponse,
  type Principal,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  missionDepartureAuthorizationResponse,
  missionDeparturePermit,
  missionReleaseRecordResponse,
  missionReleaseValidityCurrent,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { openApiDocument, ResponseMetaSchema } from '../../../packages/contracts/src/openapi.js';
import {
  buildOperationRouteTimeline,
  createOperation,
  operationCapacityPreset,
  operationPoint,
  reviseOperationReservation,
} from '../../../packages/simulation-models/src/operation.js';
import type { MissionDeparturePlan } from '../src/mission-departure-plan.js';
import { ReleasePending } from '../src/mission-release-plan.js';
import { DEPARTURE_CONTROLS_READS, runOperationDeparture } from '../src/operation-departure-consumer.js';
import { ApiError } from '@ledger/contracts/client';
import { hostedActionClock, type OperationActionClock } from '../src/operation-action-clock.js';
import { advanceRunnerClock } from '../src/operation-target.js';
import * as departureJournal from '../src/operation-departure-journal.js';
import { readOperationHistory } from '../src/operation-history.js';
import {
  advanceLiveClock,
  initialOperationCheckpoint,
  OperationStore,
  readOperationCheckpoint,
  type OperationHistoryBatch,
} from '../src/operation-state.js';

const start = Date.parse('2026-10-15T14:00:00.000Z');
const departureTime = start + 16 * 60_000;
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function supportedDocument() {
  const document = structuredClone(openApiDocument);
  const post = document.paths['/v1/commands'].post;
  const request = post.requestBody.content['application/json'];
  if (request.schema.anyOf.some((branch) => branch.properties.kind.const === 'mission.departure-authorize'))
    return document;
  Reflect.set(request, 'schema', { anyOf: [request.schema, MissionDepartureAuthorizationCommandSchema] });
  const response = post.responses[201].content['application/json'];
  Reflect.set(response, 'schema', {
    anyOf: [
      response.schema,
      {
        type: 'object',
        properties: {
          command: MissionDepartureAcceptedCommandSchema,
          authorization: MissionDepartureAuthorizationResultSchema,
          meta: ResponseMetaSchema,
        },
        required: ['command', 'authorization', 'meta'],
        additionalProperties: false,
      },
    ],
  });
  return document;
}

async function journalAt(path: string) {
  const envelope = JSON.parse(await readFile(path, 'utf8')) as { version: number; body: string; sha256: string };
  expect(envelope.version).toBe(1);
  expect(envelope.sha256).toBe(sha256(envelope.body));
  return JSON.parse(envelope.body) as Awaited<ReturnType<typeof departureJournal.readDepartureJournal>>;
}

async function fixture(runId: string, sampleIntervalMs = 5000, publicDetour = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-departure-consumer-'));
  directories.push(directory);
  const statePath = join(directory, 'world.json');
  const journalPath = join(directory, 'departure.json');
  const preset = operationCapacityPreset('illustrative-25.1');
  let now = departureTime;
  let store = new OperationStore(
    statePath,
    initialOperationCheckpoint(
      createOperation({
        ...preset,
        runId,
        start: iso(start),
        fleet: { alpha: 5, beta: 2 },
        capacity: {
          ...preset.capacity,
          flightPeople: { alpha: 4, beta: 2 },
          turnaroundCrews: { alpha: 2, beta: 1 },
          chargers: { alpha: 2, beta: 1 },
          launchPads: { alpha: 2, beta: 1 },
        },
        sampleIntervalMs,
        predeparture: {
          version: 'reserve-selected-await-release.1',
          tenant: 'alpha',
          attemptId: `intent-${runId}-alpha-0:attempt:1`,
        },
        selectedDemandWindow: {
          attemptId: `intent-${runId}-alpha-0:attempt:1`,
          start: iso(start + 15 * 60_000),
          end: iso(start + 40 * 60_000),
        },
      }),
      { mode: 'live', wallAt: start, paused: false },
    ),
  );
  await store.update((state) => {
    advanceLiveClock(state, start, false);
    reviseOperationReservation(state.world, state.world.reservations![0]!.id, {
      sourceRevision: 2,
      operatingInterval: { start: iso(start + 15 * 60_000), end: iso(start + 40 * 60_000) },
    });
    advanceLiveClock(state, now, false);
  });
  const reservation = structuredClone(store.state.world.reservations![0]!);
  const release = JSON.parse(
    JSON.stringify(missionReleaseRecordResponse, (_key, value: unknown) =>
      value === 'fixture-tenant'
        ? 'tenant-alpha'
        : value === 'organization:fixture-tenant'
          ? 'organization:tenant-alpha'
          : value,
    ),
  ) as typeof missionReleaseRecordResponse;
  const mission = release.release.basis.mission;
  const publishedSource = structuredClone(reservation.plan);
  if (publicDetour) {
    publishedSource.sourceRevision++;
    publishedSource.occurredAt = iso(now - 1_000).replace('.000Z', 'Z');
    const [origin, destination] = publishedSource.route.geometry.coordinates;
    const waypoint = [(origin![0] + destination![0]) / 2 + 0.001, (origin![1] + destination![1]) / 2 + 0.001] as [
      number,
      number,
    ];
    publishedSource.route.geometry.coordinates = [origin!, waypoint, destination!, [...waypoint], [...origin!]];
  }
  const sourceBytes = Buffer.from(JSON.stringify(publishedSource, null, 2) + '\n');
  const { sourceRevision, occurredAt, ...sourcePayload } = publishedSource;
  Object.assign(mission, publishedSource, {
    flightId: release.release.flightId,
    recordedAt: iso(start + 1_000),
    original: {
      sha256: sha256(sourceBytes),
      byteLength: sourceBytes.byteLength,
    },
    contentDigest: canonicalDigest({
      version: 'ledger.mission-content.1',
      sourceId: mission.sourceId,
      flightId: mission.flightId,
      sourceRevision,
      occurredAt,
      fidelity: 'synthetic_contract',
      payload: sourcePayload,
      original: {
        sha256: sha256(sourceBytes),
        byteLength: sourceBytes.byteLength,
        bytesBase64: sourceBytes.toString('base64'),
      },
    }),
  });
  release.release.aircraftId = reservation.aircraftId;
  const reference = {
    missionId: mission.missionId,
    sourceRevision: mission.sourceRevision,
    eventId: mission.id,
    contentDigest: mission.contentDigest,
    recordDigest: canonicalDigest(mission),
  };
  const avoidance = release.release.basis.avoidance;
  avoidance.mission = reference;
  for (const candidate of avoidance.candidates) {
    const context = release.release.basis.candidateContexts.find(
      (entry) => entry.controlEventId === candidate.controlEventId && entry.acceptanceId === candidate.acceptance.id,
    )!.context;
    candidate.safetyContextDigest = canonicalDigest(context);
  }
  const { id, version, digest } = avoidance.calculation;
  avoidance.contextDigest = canonicalDigest({
    version: 'mission.avoidance-context.1',
    mission: reference,
    calculation: { id, version, digest },
    candidates: avoidance.candidates,
    notApplicable: avoidance.notApplicable,
    consideredTypes: avoidance.consideredTypes,
    candidateCompleteness: avoidance.candidateCompleteness,
  });
  const { previewDigest: _preview, ...preview } = avoidance;
  avoidance.previewDigest = canonicalDigest(preview);
  release.digest = canonicalDigest(release.release);
  const plan: MissionDeparturePlan = {
    version: 1,
    apiUrl: 'http://departure.test',
    tenantId: 'tenant-alpha',
    principalId: release.release.actor.id,
    runId,
    reservationId: reservation.id,
    flightId: release.release.flightId,
    aircraftId: reservation.aircraftId,
    release: { id: release.release.id, digest: release.digest },
    mission: reference,
    departureAttemptId: `${reservation.id}:departure:1`,
    marginMs: 10_000,
    latencyMarginMs: 1_000,
    handoffAllowanceMs: 5_000,
    allocationDurationMs: 90_000,
  };
  const principal = {
    id: plan.principalId,
    tenantId: plan.tenantId,
    name: release.release.actor.name,
    revision: release.release.actor.principalRevision,
    capabilities: ['decision:write', 'flight:read', 'mission:release'],
    commandLinkSources: [],
    missionSources: [],
  };
  const reads: string[] = [];
  // The controls in scope as the API lists them; a revision changes the list and so its digest.
  let controlsRevision = 1;
  const controlsList = () => {
    const controls = [{ revision: controlsRevision }];
    return {
      flightId: plan.flightId,
      readAt: iso(now),
      controls,
      complete: true,
      notApplicable: [],
      mission: null,
      digest: canonicalDigest({
        version: 'flight.controls-seen.1',
        controls,
        notApplicable: [],
        complete: true,
        mission: null,
      }),
    };
  };
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      const flightPath = `/v1/flights/${encodeURIComponent(plan.flightId)}`;
      let value: unknown;
      if (path === '/openapi.json') value = supportedDocument();
      else if (path === '/v1/me') value = { principal };
      else if (path === flightPath)
        value = {
          flight: {
            id: plan.flightId,
            label: 'Explicit held reservation',
            originationKey: reservation.intentId,
            revision: 8,
            basisRevision: 7,
            activity: 'planned',
            coverage: 'recorded',
            aircraft: plan.aircraftId,
            orderIds: [],
            sourceIds: ['mission-planner'],
            unresolvedCount: 0,
            conflictCount: 0,
            outstandingWork: 999,
          },
          meta: { ...missionDepartureAuthorizationResponse.meta, computedAt: iso(now) },
        };
      else if (path === `${flightPath}/mission`)
        value = {
          binding: {
            missionId: mission.missionId,
            flightId: plan.flightId,
            sourceId: mission.sourceId,
            sourceMissionId: mission.sourceMissionId,
            aircraftId: plan.aircraftId,
          },
          acceptedHead: { record: mission, processing: { status: 'completed', attempts: 1 } },
          projectedHead: mission,
          meta: { ...missionDepartureAuthorizationResponse.meta, computedAt: iso(now) },
        };
      else if (path === `${flightPath}/mission-releases/${encodeURIComponent(plan.release.id)}`) value = release;
      else if (path === `${flightPath}/controls`) value = controlsList();
      else if (path === `/v1/receipts/${encodeURIComponent(mission.receiptId)}`)
        value = {
          receipt: {
            id: mission.receiptId,
            kind: 'mission.revision',
            status: 'accepted',
            processing: { status: 'completed', attempts: 1 },
            linkStatus: 'linked',
            eventId: mission.id,
            flightId: plan.flightId,
            sourceId: mission.sourceId,
            artifactId: mission.artifactId,
            occurredAt: new Date(mission.occurredAt).toISOString(),
            payload: sourcePayload,
          },
        };
      else if (path === `/v1/artifacts/${encodeURIComponent(mission.artifactId)}`)
        value = {
          artifact: {
            id: mission.artifactId,
            contentType: 'application/json',
            byteLength: sourceBytes.byteLength,
            sha256: sha256(sourceBytes),
          },
        };
      else if (path === `${flightPath}/mission-releases/${encodeURIComponent(plan.release.id)}/validity`)
        value = {
          ...missionReleaseValidityCurrent,
          release: plan.release,
          evaluatedAt: iso(now),
          currentContextDigest: avoidance.contextDigest,
        };
      else throw new Error(`Unexpected departure GET ${path}`);
      return structuredClone(value) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      if (path === `/v1/artifacts/${encodeURIComponent(mission.artifactId)}/content`) return sourceBytes;
      throw new Error(`Unexpected departure byte read ${path}`);
    },
    usage: () => ({ requests: reads.length, bytes: 0 }),
  };
  const responses = new Map<string, MissionDepartureAuthorizationResponse>();
  function authorize(payload: string, key: string) {
    let response = responses.get(key);
    const disposition = response ? 'replayed' : 'issued';
    if (!response) {
      const request = JSON.parse(payload) as MissionDepartureAuthorizationCommand;
      const permit = {
        ...structuredClone(missionDeparturePermit),
        id: `${runId}-permit`,
        flightId: plan.flightId,
        aircraftId: plan.aircraftId,
        release: plan.release,
        mission: plan.mission,
        contextDigest: avoidance.contextDigest,
        departureAttemptId: plan.departureAttemptId,
        allocation: request.allocation,
        authorizedAt: iso(now),
        validUntil: iso(now + 30_000),
        actor: {
          ...structuredClone(missionDeparturePermit.actor),
          id: plan.principalId,
          principalRevision: request.expectedPrincipalRevision,
          scope: { kind: 'flight' as const, id: plan.flightId },
        },
      };
      const digest = canonicalDigest(permit);
      response = {
        command: {
          id: permit.id,
          kind: 'mission.departure-authorize',
          flightId: plan.flightId,
          actorId: plan.principalId,
          recordedAt: permit.authorizedAt,
          payload: { permit, digest },
        },
        authorization: { permit, digest, evaluatedAt: iso(now), disposition: 'issued' },
        meta: {
          ...missionDepartureAuthorizationResponse.meta,
          requestId: `${runId}-authorization`,
          effectId: permit.id,
          computedAt: iso(now),
        },
      };
      responses.set(key, response);
    }
    return {
      ...structuredClone(response),
      authorization: { ...structuredClone(response.authorization), evaluatedAt: iso(now), disposition },
      meta: { ...response.meta, computedAt: iso(now) },
    } satisfies MissionDepartureAuthorizationResponse;
  }
  const submit = vi.fn(async (payload: string, key: string) => authorize(payload, key));
  return {
    plan,
    statePath,
    journalPath,
    reservation,
    publishedSource,
    sourceBytes,
    release,
    reads,
    principal,
    api,
    authorize,
    submit,
    get store() {
      return store;
    },
    get now() {
      return now;
    },
    controlsDigest: () => controlsList().digest,
    changeControls() {
      controlsRevision++;
    },
    setNow(value: number) {
      now = value;
    },
    async tick(elapsed: number) {
      now += elapsed;
      await store.update((state) => advanceLiveClock(state, now, false));
    },
    async restart() {
      store = new OperationStore(statePath, (await readOperationCheckpoint(statePath))!);
    },
    run: (
      post: (payload: string, key: string) => Promise<MissionDepartureAuthorizationResponse> = submit,
      clock?: OperationActionClock,
      freshPrincipal?: (principal: Principal) => void,
    ) => runOperationDeparture(plan, journalPath, store, api, post, () => now, clock, freshPrincipal),
  };
}

describe('one explicit reservation departure consumer', () => {
  it('pins the controls it read and reads them again when they changed before the command', async () => {
    const f = await fixture('controls-changed-once');
    const pinned: string[] = [];
    const post = vi.fn(async (body: string, key: string) => {
      const request = JSON.parse(body) as MissionDepartureAuthorizationCommand;
      pinned.push(request.expectedControlsDigest!);
      if (request.expectedControlsDigest !== f.controlsDigest())
        throw new ApiError(409, { error: { code: 'flight_controls_changed', message: 'Changed' } });
      return f.authorize(body, key);
    });
    const shown = f.controlsDigest();
    // The list changes after the review read it, before the command commits.
    const read = f.api.json.bind(f.api);
    let changed = false;
    vi.spyOn(f.api, 'json').mockImplementation(async <T>(path: string): Promise<T> => {
      const value = await read<T>(path);
      if (path.endsWith('/controls') && !changed) {
        changed = true;
        f.changeControls();
      }
      return value;
    });
    expect((await f.run(post)).status).toBe('departed');
    expect(pinned).toEqual([shown, f.controlsDigest()]);
    expect(new Set(post.mock.calls.map(([, key]) => key)).size).toBe(2);
    const journal = (await journalAt(f.journalPath))!;
    expect(JSON.parse(journal.request.payload).expectedControlsDigest).toBe(f.controlsDigest());
    expect(journal.status).toBe('departed');
  });

  it('records the refusal as an outcome when the controls keep changing', async () => {
    const f = await fixture('controls-keep-changing');
    const post = vi.fn(async (_body: string, _key: string) => {
      f.changeControls();
      throw new ApiError(409, { error: { code: 'flight_controls_changed', message: 'Changed' } });
    });
    expect(await f.run(post)).toMatchObject({ status: 'abandoned', code: 'flight_controls_changed' });
    expect(post).toHaveBeenCalledTimes(DEPARTURE_CONTROLS_READS);
    expect((await journalAt(f.journalPath))!).toMatchObject({
      status: 'abandoned',
      rejection: { status: 409, code: 'flight_controls_changed' },
    });
    expect(f.store.state.world.departures ?? []).toEqual([]);
  });

  it('recovers an accepted unknown original request after write-grant loss but refuses physical consumption', async () => {
    const f = await fixture('ordinary-recovery-authority');
    await markOrdinary(f);
    const fresh = vi.fn((principal: Principal) => {
      if (!principal.capabilities.includes('mission:release'))
        throw new ReleasePending(
          'automatic_release_authority_unavailable',
          'Current service departure authority is required',
        );
    });
    const post = vi.fn(async (body: string, key: string) => {
      const accepted = f.authorize(body, key);
      if (post.mock.calls.length === 1) throw new Error('Accepted original permit reply lost');
      return accepted;
    });
    expect((await f.run(post, undefined, fresh)).status).toBe('held');
    const original = (await journalAt(f.journalPath))!.request;
    f.principal.capabilities = ['flight:read'];
    f.principal.revision++;
    expect(await f.run(post, undefined, fresh)).toMatchObject({
      status: 'abandoned',
      code: 'automatic_release_authority_unavailable',
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    expect((await journalAt(f.journalPath))!.request).toEqual(original);
    expect((await journalAt(f.journalPath))!.authorization).toBeDefined();
    expect(f.store.state.world.departures ?? []).toHaveLength(0);
  });

  it('checks all current controls after an ordinary permit and retains the exact reads with once-only consumption', async () => {
    const f = await fixture('ordinary-final-control-read');
    await markOrdinary(f);
    const read = f.api.json.bind(f.api);
    let submitted = false;
    let pendingControls = true;
    vi.spyOn(f.api, 'json').mockImplementation(async <T>(path: string): Promise<T> => {
      if (path.endsWith('/mission-avoidance')) {
        expect(submitted).toBe(true);
        const { previewDigest: _digest, ...preview } = f.release.release.basis.avoidance;
        const current = {
          ...preview,
          evaluatedAt: iso(f.now),
          ...(pendingControls
            ? {
                status: 'insufficient',
                candidates: preview.candidates.map((candidate) => ({ ...candidate, context: 'pending' })),
              }
            : {}),
        };
        return {
          ...current,
          previewDigest: canonicalDigest(current),
          meta: { ...missionDepartureAuthorizationResponse.meta, computedAt: iso(f.now) },
        } as T;
      }
      return read<T>(path);
    });
    const post = vi.fn(async (body: string, key: string) => {
      submitted = true;
      return f.authorize(body, key);
    });
    expect(await f.run(post)).toMatchObject({ status: 'held', code: 'current_controls_pending' });
    const original = (await journalAt(f.journalPath))!.request;
    await f.restart();
    pendingControls = false;
    expect((await f.run(post)).status).toBe('departed');
    expect((await journalAt(f.journalPath))!.request).toEqual(original);
    const commit = f.store.state.world.departures![0]!;
    expect(commit.currentControls!.avoidanceDigest).toBe(canonicalDigest(commit.currentControls!.avoidance));
    expect(commit.currentControls!.releaseValidityDigest).toBe(
      canonicalDigest(commit.currentControls!.releaseValidity),
    );
    expect(commit.currentControls!.avoidance.contextDigest).toBe(commit.permit.contextDigest);
    await f.restart();
    expect((await f.run(post)).status).toBe('departed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.store.state.world.departures).toEqual([commit]);
  });

  it('holds an issued ordinary permit when a new outside control changes its context and never renews the request', async () => {
    const f = await fixture('ordinary-final-control-race');
    await markOrdinary(f);
    const read = f.api.json.bind(f.api);
    let issued = false;
    vi.spyOn(f.api, 'json').mockImplementation(async <T>(path: string): Promise<T> => {
      if (path.endsWith('/mission-avoidance')) {
        expect(issued).toBe(true);
        const { previewDigest: _digest, ...preview } = f.release.release.basis.avoidance;
        const current = { ...preview, evaluatedAt: iso(f.now), contextDigest: 'b'.repeat(64) };
        return {
          ...current,
          previewDigest: canonicalDigest(current),
          meta: { ...missionDepartureAuthorizationResponse.meta, computedAt: iso(f.now) },
        } as T;
      }
      return read<T>(path);
    });
    const post = vi.fn(async (body: string, key: string) => {
      issued = true;
      return f.authorize(body, key);
    });
    expect(await f.run(post)).toMatchObject({ status: 'abandoned', code: 'current_controls_changed' });
    const original = await journalAt(f.journalPath);
    await f.restart();
    expect(await f.run(post)).toMatchObject({ status: 'abandoned', code: 'current_controls_changed' });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await journalAt(f.journalPath))!.request).toEqual(original!.request);
    expect((await journalAt(f.journalPath))!.authorization).toEqual(original!.authorization);
    expect(f.store.state.world.departures ?? []).toHaveLength(0);
  });

  it('holds an exact source revision when its original bytes disagree and safely retries before allocation', async () => {
    const f = await fixture('departure-public-original', 5000, true);
    const before = structuredClone(f.store.state.world.reservations![0]!.plan);
    vi.spyOn(f.api, 'bytes').mockResolvedValueOnce(new TextEncoder().encode('{}'));
    expect(await f.run()).toMatchObject({ status: 'held', code: 'mission_adoption_original' });
    expect(f.store.state.world.reservations![0]!.plan).toEqual(before);
    expect(f.store.state.world.departureAllocations ?? []).toEqual([]);
    expect(f.store.state.departureRequests).toBeUndefined();
    expect(f.submit).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ status: 'departed' });
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('adopts the exact projected source detour and flies it through the normal selected departure path', async () => {
    const f = await fixture('departure-public-detour', 1000, true);
    const previouslyAccepted = f.store.state.accepted;
    expect(f.store.state.world.reservations![0]!.plan.sourceRevision).toBe(2);
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'departed', flightId: f.plan.flightId });
    expect(f.store.state.accepted).toBe(previouslyAccepted + 1);
    expect(f.store.state.world.nextFact - f.store.state.accepted).toBe(
      Object.values(f.store.state.pending).flat().length,
    );
    const attempt = f.store.state.world.attempts.find((row) => row.id === f.plan.reservationId)!;
    expect(attempt.routeTimeline!.plan).toEqual(f.publishedSource);
    expect(attempt.routeTimeline!.plan.sourceRevision).toBe(3);
    const travel = attempt.routeTimeline!.phases.filter((phase) => phase.kind === 'travel');
    const phase = travel[0]!;
    const midpointAt = Date.parse(attempt.departure) + Math.floor((phase.startMs + phase.endMs) / 2);
    await f.tick(midpointAt - f.now);
    const position = Object.values(f.store.state.pending)
      .flat()
      .findLast((entry) => entry.fact.kind === 'position' && entry.fact.attemptId === attempt.id);
    expect(position?.fact.kind).toBe('position');
    if (position?.fact.kind !== 'position') throw new Error('The revised flight must emit telemetry');
    const expected = operationPoint(attempt, Date.parse(position.fact.at));
    expect(position.fact.point).toMatchObject({ longitude: expected.longitude, latitude: expected.latitude });
    expect(expected.longitude).toBeGreaterThanOrEqual(Math.min(phase.from.longitude, phase.to.longitude));
    expect(expected.longitude).toBeLessThanOrEqual(Math.max(phase.from.longitude, phase.to.longitude));
    const history = [];
    for await (const batch of readOperationHistory<OperationHistoryBatch>(
      f.store.historyDirectory,
      f.store.state.historyBatches,
    ))
      history.push(batch.value);
    const adopted = history
      .flatMap((batch) => batch.facts)
      .filter((entry) => entry.fact.kind === 'mission' && entry.fact.publicAcceptance);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.bytesBase64).toBe(f.sourceBytes.toString('base64'));
    expect(history.flatMap((batch) => batch.receipts)).toContainEqual({
      sequence: adopted[0]!.fact.sequence,
      attemptId: attempt.id,
      receiptId: f.release.release.basis.mission.receiptId,
    });
    expect(
      Object.values(f.store.state.pending)
        .flat()
        .some((entry) => entry.fact.kind === 'mission' && entry.fact.publicAcceptance),
    ).toBe(false);
    await f.restart();
    expect(await f.run()).toMatchObject({ status: 'departed' });
    expect(f.store.state.accepted).toBe(previouslyAccepted + 1);
    expect(f.store.state.world.nextFact - f.store.state.accepted).toBe(
      Object.values(f.store.state.pending).flat().length,
    );
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('waits for hosted catch-up before allocation and recovers the exact physical commit while stopping', async () => {
    const f = await fixture('departure-hosted-clock', 60_000);
    let stopping = false;
    const clock = hostedActionClock(() => stopping);
    const world = structuredClone(f.store.state.world);
    const queued = f.run(f.submit, clock);
    stopping = true;
    expect(await queued).toMatchObject({ status: 'held', code: 'world_stopping' });
    expect(f.store.state.departureJob).toBeUndefined();
    expect(f.reads).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
    stopping = false;
    f.setNow(f.now + 1001);
    expect(await f.run(f.submit, clock)).toMatchObject({ status: 'held', code: 'world_clock_lagging' });
    expect(f.store.state.world).toEqual(world);
    expect(f.store.state.departureJob).toBeUndefined();
    expect(f.store.state.departureRequests).toBeUndefined();
    expect(f.submit).not.toHaveBeenCalled();
    await f.store.update((state) => {
      advanceRunnerClock(state, f.now, false, { environment: 'staging', mqttPort: 1884 });
    });
    expect(await f.run(f.submit, clock)).toMatchObject({ status: 'departed', flightId: f.plan.flightId });
    const commit = structuredClone(f.store.state.world.departures![0]!);
    const request = structuredClone(f.store.state.departureRequests![f.plan.flightId]!);
    expect(f.submit.mock.calls).toEqual([[request.request.payload, request.request.key]]);
    await f.store.update((state) => {
      state.clock.paused = true;
    });
    await f.restart();
    f.reads.splice(0);
    stopping = true;
    f.setNow(f.now + 3_600_000);
    expect(await f.run(f.submit, clock)).toMatchObject({ status: 'departed', attemptId: commit.attemptId });
    expect(f.reads).toEqual([]);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.store.state.world.departures).toEqual([commit]);
    expect(f.store.state.departureRequests![f.plan.flightId]).toEqual(request);
  });

  it('refuses a physical commit when hosted stop arrives with its authorization response', async () => {
    const f = await fixture('departure-hosted-stop', 60_000);
    let stopping = false;
    const clock = hostedActionClock(() => stopping);
    const post = vi.fn(async (payload: string, key: string) => {
      const response = f.authorize(payload, key);
      stopping = true;
      return response;
    });
    expect(await f.run(post, clock)).toMatchObject({ status: 'abandoned', code: 'world_stopping' });
    const original = structuredClone(f.store.state.departureRequests![f.plan.flightId]!);
    expect(f.store.state.world.departures ?? []).toEqual([]);
    expect(f.store.state.world.attempts.some((attempt) => attempt.id === f.plan.reservationId)).toBe(false);
    expect(post.mock.calls).toEqual([[original.request.payload, original.request.key]]);
    expect(await f.run(post, clock)).toMatchObject({ status: 'abandoned', code: 'world_stopping' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.store.state.departureRequests![f.plan.flightId]).toEqual(original);
  });

  it('commits a clock-triggered cancellation after authorization and never replays its pinned job', async () => {
    const f = await fixture('departure-cancelled-window', 60_000);
    const route = buildOperationRouteTimeline(f.reservation, f.store.state.world.config.cruiseMetersPerSecond);
    if (route.status !== 'supported') throw new Error('The consumer fixture needs its retained route');
    const cancellationAt = Date.parse(f.reservation.order.schedule.end) - route.timeline.durationMs + 1;
    const save = departureJournal.saveDepartureJournal;
    vi.spyOn(departureJournal, 'saveDepartureJournal').mockImplementation(async (path, journal, plan) => {
      await save(path, journal, plan);
      if (journal.status === 'authorized') f.setNow(cancellationAt);
    });
    const expected = { status: 'abandoned', code: 'requested_window_unreachable' };
    const result = await f.run();
    expect(result).toMatchObject(expected);
    const job = structuredClone(f.store.state.departureJob!);
    const original = structuredClone(f.store.state.departureRequests![f.plan.flightId]!);
    const journalBytes = await readFile(f.journalPath, 'utf8');
    expect((await journalAt(f.journalPath))!).toMatchObject({ status: 'authorized', request: original.request });
    expect(f.store.state.world.reservations!.find((row) => row.id === f.plan.reservationId)).toMatchObject({
      phase: 'cancelled',
      cancellation: { decidedAt: iso(cancellationAt), note: result.reason },
      order: f.reservation.order,
      plan: f.reservation.plan,
    });
    expect(f.store.state.world.departures ?? []).toEqual([]);
    expect(f.store.state.world.attempts.some((row) => row.id === f.plan.reservationId)).toBe(false);
    expect(f.store.state.world.aircraft.find((row) => row.id === f.plan.aircraftId)?.phase).not.toBe('reserved');
    expect(f.store.state.world.aircraft.find((row) => row.id === f.plan.aircraftId)?.attemptId).not.toBe(
      f.plan.reservationId,
    );
    expect(
      f.store.state.world.resources!.flightPeople.find((row) => row.id === f.reservation.personId)!.availableAt,
    ).toBeGreaterThanOrEqual(cancellationAt);
    await f.restart();
    f.reads.splice(0);
    expect(await f.run()).toMatchObject({ ...expected, reason: result.reason });
    expect(f.reads).toEqual([]);
    expect(f.submit.mock.calls).toEqual([[original.request.payload, original.request.key]]);
    expect(f.store.state.departureJob).toEqual(job);
    expect(f.store.state.departureRequests![f.plan.flightId]).toEqual(original);
    expect(f.store.state.world.departureAllocations).toEqual([original.allocation]);
    expect(await readFile(f.journalPath, 'utf8')).toBe(journalBytes);
  });

  it('keeps background motion independent of an uncertain POST and recovers its exact durable request before consuming', async () => {
    const f = await fixture('departure-loss');
    expect(
      await runOperationDeparture(
        { ...f.plan, reservationId: 'not-a-held-reservation' },
        `${f.journalPath}.mistyped`,
        f.store,
        f.api,
        f.submit,
        () => f.now,
      ),
    ).toMatchObject({ status: 'held', code: 'reservation_changed' });
    expect(f.store.state.departureJob).toBeUndefined();
    expect(f.reads).toEqual([]);
    expect(f.submit).not.toHaveBeenCalled();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let lose!: () => void;
    const lost = new Promise<void>((resolve) => {
      lose = resolve;
    });
    const post = vi.fn(async (payload: string, key: string) => {
      const journal = (await journalAt(f.journalPath))!;
      expect((await stat(f.journalPath)).mode & 0o777).toBe(0o600);
      expect(journal).toMatchObject({
        principalId: f.plan.principalId,
        tenantId: f.plan.tenantId,
        apiUrl: f.plan.apiUrl,
        request: { payload, key, payloadSha256: sha256(payload) },
      });
      expect(f.store.state.world.departureAllocations).toEqual([journal.allocation]);
      expect(journal.request.startedAt).toBe(iso(departureTime));
      expect(JSON.parse(payload).allocation).toEqual({
        id: journal.allocation.id,
        digest: canonicalDigest(journal.allocation),
      });
      expect(f.store.state.departureRequests![f.plan.flightId]).toMatchObject({
        planDigest: canonicalDigest(f.plan),
        principalId: f.plan.principalId,
        tenantId: f.plan.tenantId,
        allocation: journal.allocation,
        release: f.release,
        request: { payload, key, payloadSha256: sha256(payload) },
      });
      expect(f.store.state.world.attempts.some((attempt) => attempt.id === f.plan.reservationId)).toBe(false);
      const response = f.authorize(payload, key);
      if (post.mock.calls.length === 1) {
        entered();
        await lost;
        throw new Error('Response lost after permit issuance');
      }
      return response;
    });
    const running = f.run(post);
    expect(await Promise.race([started.then(() => null), running])).toBeNull();
    const before = f.store.state.world.nextFact;
    await f.tick(5_000);
    expect(f.store.state.world.nextFact).toBeGreaterThan(before);
    expect(f.store.state.world.reservations!.some((row) => row.id === f.plan.reservationId)).toBe(true);
    lose();
    expect((await running).status).toBe('held');
    const retained = (await journalAt(f.journalPath))!;
    await f.restart();
    f.principal.revision++;
    f.principal.capabilities = ['flight:read'];
    f.reads.splice(0);
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation(async (change) => {
      const journal = await journalAt(f.journalPath);
      const prior = f.store.state.world.departures?.length ?? 0;
      await update(change);
      if ((f.store.state.world.departures?.length ?? 0) > prior) expect(journal!.authorization).toBeDefined();
    });
    expect(await f.run(post)).toMatchObject({
      status: 'departed',
      attemptId: f.plan.reservationId,
      flightId: f.plan.flightId,
    });
    expect(post.mock.calls[1]).toEqual([retained.request!.payload, retained.request!.key]);
    expect(f.reads).toEqual(['/v1/me']);
    const commit = f.store.state.world.departures![0]!;
    expect(commit.departureAt).toBe(iso(f.now));
    expect(Date.parse(commit.departureAt)).toBeGreaterThan(Date.parse(commit.permit.authorizedAt));
    expect(commit.caller).toMatchObject({
      apiUrl: f.plan.apiUrl,
      principalId: f.plan.principalId,
      requestKey: retained.request!.key,
      payloadSha256: sha256(retained.request!.payload),
    });
    expect(commit.fit.evaluatedAt).toBe(commit.departureAt);
    expect(f.store.state.world.reservations).toHaveLength(0);
    await f.run(post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(f.store.state.world.departures).toHaveLength(1);
  });

  it('never takes off with an expired response, a backdated caller clock or an allocation that lost its pad', async () => {
    const expired = await fixture('departure-expired');
    const late = vi.fn(async (payload: string, key: string) => {
      const response = expired.authorize(payload, key);
      await expired.tick(30_000);
      return response;
    });
    expect((await expired.run(late)).status).toBe('abandoned');
    expect(expired.store.state.world.departures ?? []).toEqual([]);
    expect((await expired.run(late)).status).toBe('abandoned');
    expect(late).toHaveBeenCalledTimes(1);
    const unsubmitted = await fixture('departure-allocation-expired');
    const beforePost = vi
      .spyOn(departureJournal, 'saveDepartureJournal')
      .mockRejectedValueOnce(new Error('Crash before companion save and first POST'));
    expect((await unsubmitted.run()).status).toBe('held');
    beforePost.mockRestore();
    expect(unsubmitted.submit).not.toHaveBeenCalled();
    const original = structuredClone(unsubmitted.store.state.departureRequests![unsubmitted.plan.flightId]!);
    unsubmitted.reads.splice(0);
    const persistUpdate = unsubmitted.store.update.bind(unsubmitted.store);
    let persistenceStalled = false;
    const slowPersistence = vi.spyOn(unsubmitted.store, 'update').mockImplementation(async (change) => {
      await persistUpdate(change);
      if (!persistenceStalled && unsubmitted.reads.includes('/v1/me')) {
        persistenceStalled = true;
        unsubmitted.setNow(Date.parse(original.allocation.endsAt) + 1);
      }
    });
    expect(await unsubmitted.run()).toMatchObject({ status: 'held', code: 'allocation_unavailable' });
    expect(persistenceStalled).toBe(true);
    expect(unsubmitted.submit).not.toHaveBeenCalled();
    slowPersistence.mockRestore();
    await unsubmitted.tick(0);
    await unsubmitted.restart();
    expect(await unsubmitted.run()).toMatchObject({ status: 'held', code: 'allocation_unavailable' });
    expect(unsubmitted.submit).not.toHaveBeenCalled();
    expect(unsubmitted.store.state.departureRequests![unsubmitted.plan.flightId]).toEqual(original);
    expect(unsubmitted.store.state.world.departureAllocations).toEqual([original.allocation]);
    expect(unsubmitted.store.state.world.departures ?? []).toEqual([]);
    expect(
      unsubmitted.store.state.world.attempts.some((attempt) => attempt.id === unsubmitted.plan.reservationId),
    ).toBe(false);
    const backdated = await fixture('departure-backdated');
    backdated.setNow(backdated.now - 1);
    expect((await backdated.run()).status).toBe('held');
    expect(backdated.submit).not.toHaveBeenCalled();
    const lost = await fixture('departure-pad-lost');
    const withoutPad = vi.fn(async (payload: string, key: string) => {
      const response = lost.authorize(payload, key);
      await lost.store.update((state) => {
        const allocation = state.world.departureAllocations![0]!;
        const pad = state.world.resources!.launchPads.find((row) => row.id === allocation.padId)!;
        delete pad.aircraftId;
        pad.availableAt = state.world.now;
      });
      return response;
    });
    expect((await lost.run(withoutPad)).status).toBe('abandoned');
    expect(lost.store.state.world.departures ?? []).toEqual([]);
    expect(lost.store.state.world.reservations!.some((row) => row.id === lost.plan.reservationId)).toBe(true);
    expect(withoutPad).toHaveBeenCalledTimes(1);
  });

  it('recovers an already committed departure after journal confirmation fails even when the original permit has expired', async () => {
    const f = await fixture('departure-commit');
    const save = departureJournal.saveDepartureJournal;
    let beforeSubmission = true;
    const failure = vi
      .spyOn(departureJournal, 'saveDepartureJournal')
      .mockImplementation(async (path, journal, plan) => {
        if (journal.status === 'submitted' && beforeSubmission) {
          beforeSubmission = false;
          throw new Error('Crash after preparation checkpoint but before companion journal');
        }
        if (journal.status === 'departed' && f.store.state.world.departures?.length)
          throw new Error('Crash after world checkpoint commit');
        await save(path, journal, plan);
      });
    expect((await f.run()).status).toBe('held');
    expect(f.submit).not.toHaveBeenCalled();
    const prepared = structuredClone(f.store.state.departureRequests![f.plan.flightId]!);
    const job = structuredClone(f.store.state.departureJob!);
    expect(job).toEqual({
      version: 'operation.departure-job.1',
      flightId: f.plan.flightId,
      reservationId: f.plan.reservationId,
      departureAttemptId: f.plan.departureAttemptId,
      planDigest: canonicalDigest(f.plan),
    });
    const preparedCheckpoint = await readFile(f.statePath, 'utf8');
    await f.restart();
    await f.run();
    expect(f.submit.mock.calls[0]).toEqual([prepared.request.payload, prepared.request.key]);
    const commit = structuredClone(f.store.state.world.departures![0]!);
    expect(commit).toBeDefined();
    expect((await journalAt(f.journalPath))!.status).toBe('authorized');
    expect(commit.fit).toMatchObject({
      version: 'mission.departure-fit.1',
      mission: f.plan.mission,
      aircraftId: f.plan.aircraftId,
      evaluatedAt: commit.departureAt,
    });
    expect(Date.parse(commit.fit.requiredCompletionAt)).toBeLessThanOrEqual(
      Date.parse(f.reservation.plan.operatingInterval.end),
    );
    failure.mockRestore();
    const committedCheckpoint = await readFile(f.statePath, 'utf8');
    const authorizedJournal = (await journalAt(f.journalPath))!;
    await departureJournal.saveDepartureJournal(
      f.journalPath,
      {
        ...authorizedJournal,
        status: 'departed',
        consumed: { attemptId: commit.attemptId, departureAt: commit.departureAt },
      },
      f.plan,
    );
    await writeFile(f.statePath, preparedCheckpoint);
    await f.restart();
    expect(await f.run()).toMatchObject({ status: 'held', code: 'checkpoint_mismatch' });
    expect(f.store.state.world.departures ?? []).toEqual([]);
    expect(f.store.state.world.attempts.some((attempt) => attempt.id === f.plan.reservationId)).toBe(false);
    expect(f.submit).toHaveBeenCalledTimes(1);
    await writeFile(f.statePath, committedCheckpoint);
    await f.restart();
    await departureJournal.saveDepartureJournal(f.journalPath, authorizedJournal, f.plan);
    const physical = f.store.state.world.attempts.find((attempt) => attempt.id === commit.attemptId)!;
    const groundReadyAt =
      Date.parse(physical.landing) + f.store.state.world.config.turnaroundMs + f.store.state.world.config.chargeMs + 1;
    await f.tick(groundReadyAt - f.now);
    await f.restart();
    expect(f.store.state.world.attempts.some((attempt) => attempt.id === commit.attemptId)).toBe(false);
    f.reads.splice(0);
    const changedSelection: MissionDeparturePlan = {
      ...f.plan,
      flightId: 'another-ledger-flight',
      departureAttemptId: `${f.plan.reservationId}:departure:2`,
    };
    const otherPost = vi.fn(async () => {
      throw new Error('A second selected job cannot submit');
    });
    for (const changed of [changedSelection, { ...f.plan, marginMs: f.plan.marginMs + 1 }]) {
      expect(
        await runOperationDeparture(changed, `${f.journalPath}.different`, f.store, f.api, otherPost, () => f.now),
      ).toMatchObject({ status: 'held', code: 'departure_job_conflict' });
    }
    expect(otherPost).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ status: 'departed', attemptId: commit.attemptId, flightId: commit.flightId });
    expect(f.reads).toEqual([]);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.store.state.departureJob).toEqual(job);
    expect(f.store.state.world.departureAllocations).toEqual([prepared.allocation]);
    expect(f.store.state.departureRequests).toEqual({ [f.plan.flightId]: prepared });
    expect(f.store.state.world.departures).toEqual([commit]);
    const facts = [];
    for await (const batch of readOperationHistory<OperationHistoryBatch>(
      f.store.historyDirectory,
      f.store.state.historyBatches,
    ))
      facts.push(...batch.value.facts);
    expect(
      facts.filter((entry) => entry.fact.attemptId === commit.attemptId && entry.fact.kind === 'departure'),
    ).toHaveLength(1);
  });

  it('keeps physical motion and other deliveries progressing while its native and telemetry originals await independent retry', async () => {
    const f = await fixture('departure-delivery');
    let head = f.store.pendingHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId);
    while (head) {
      await f.store.accept(head, `order-${head.fact.sequence}`);
      head = f.store.pendingHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId);
    }
    let mission = f.store.pendingMissionHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId);
    while (mission) {
      await f.store.accept(mission, `mission-${mission.fact.sequence}`);
      mission = f.store.pendingMissionHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId);
    }
    expect((await f.run()).status).toBe('departed');
    const native = structuredClone(
      f.store.pendingHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId)!,
    );
    expect(native.fact.kind).toBe('departure');
    await f.tick(25_000);
    expect(f.store.pendingHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId)).toEqual(native);
    const attempt = f.store.state.world.attempts.find((row) => row.id === f.plan.reservationId)!;
    expect(operationPoint(attempt, f.now).horizontalSpeed).toBeGreaterThan(0);
    const frames = structuredClone(
      f.store.state.pending[f.plan.reservationId]!.filter((entry) => entry.fact.kind === 'position'),
    );
    expect(frames.length).toBeGreaterThan(2);
    const other = f.store.pendingHeads().find((entry) => entry.fact.tenant === 'beta')!;
    await f.store.accept(other, `other-${other.fact.sequence}`);
    await f.restart();
    expect(f.store.pendingHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId)).toEqual(native);
    await f.store.accept(native, 'native-departure');
    for (const frame of frames.slice(0, 2)) {
      expect(f.store.pendingHeads().find((entry) => entry.fact.attemptId === f.plan.reservationId)).toEqual(frame);
      await f.store.accept(frame, `telemetry-${frame.fact.sequence}`);
    }
    expect(f.store.state.world.departures).toHaveLength(1);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
});

async function markOrdinary(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.update((state) => {
    state.world.ordinaryDispatch = {
      version: 'accepted-controls.1',
      activatedAt: iso(f.now),
      planningLeadMs: 300_000,
      flights: [
        {
          version: 'operation.ordinary-flight.1',
          attemptId: f.plan.reservationId,
          tenant: 'alpha',
          aircraftId: f.plan.aircraftId,
          registeredAt: iso(f.now),
          customerInterval: { ...f.reservation.order.schedule },
        },
      ],
    };
    state.ordinaryFlights = {
      [f.plan.reservationId]: {
        version: 'operation.ordinary-source.1',
        reservationId: f.plan.reservationId,
        tenant: 'alpha',
        sourcePrincipalId: 'principal-alpha-source',
        automaticReleasePrincipalId: f.plan.principalId,
        publicRevision: 0,
        needsHumanReview: true,
        flightId: f.plan.flightId,
        departurePlan: f.plan,
        references: { mission: f.plan.mission, release: f.plan.release, briefings: [] },
      },
    };
  });
}
