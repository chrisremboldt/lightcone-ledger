import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  FlightPredepartureProgress,
  FlightPredepartureProgressResponse,
  MissionRevisionRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  activateOperationOrdinaryDispatch,
  advanceOperation,
  createOperation,
  enableOperationOrdinaryWork,
} from '@ledger/simulation-models/operation';
import { missionReleaseRecordResponse } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import { OperationOrdinaryDispatchRuntime } from '../src/operation-ordinary-runtime.js';
import { initialOperationCheckpoint, OperationStore, readOperationCheckpoint } from '../src/operation-state.js';

const start = Date.parse('2026-10-18T23:00:00.000Z');
const now = start + 600_000;
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-ordinary-source-'));
  directories.push(directory);
  const path = join(directory, 'world.json');
  const world = createOperation({
    runId: 'ordinary-runtime',
    start: iso(start),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
  });
  enableOperationOrdinaryWork(world);
  activateOperationOrdinaryDispatch(world);
  advanceOperation(world, now);
  const reservation = world.reservations![0]!;
  expect(reservation.tenant).toBe('alpha');
  let store = new OperationStore(path, initialOperationCheckpoint(world, { mode: 'live', wallAt: now, paused: false }));
  const record: MissionRevisionRecord = {
    ...structuredClone(missionReleaseRecordResponse.release.basis.mission),
    ...structuredClone(reservation.plan),
    flightId: 'ordinary-public-flight',
    sourceId: 'mission-planner',
    missionId: 'ordinary-mission',
    id: 'ordinary-revision-1',
  };
  let status: 'outside' | 'intersects' = 'intersects';
  let actorKind: string | undefined = 'service';
  let loseReply = false;
  let latest: FlightPredepartureProgressResponse | undefined;
  const accepted = new Map<string, FlightPredepartureProgressResponse>();
  const sends: Array<{ body: string; key: string }> = [];
  const commands: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/openapi.json') return json(openApiDocument);
    if (url.pathname === '/v1/me') {
      const actor = new Headers(init?.headers).get('authorization') === 'Bearer actor-alpha';
      return json({
        principal: {
          id: actor ? 'alpha-service' : 'alpha-source',
          tenantId: 'tenant-alpha',
          name: 'Alpha source',
          ...(actorKind && actor ? { kind: actorKind } : {}),
          revision: 1,
          capabilities: ['input:write', 'flight:read', 'mission:write', 'decision:write', 'mission:release'],
          missionSources: ['mission-planner'],
          commandLinkSources: [],
        },
      });
    }
    if (url.pathname === '/v1/flights')
      return json({
        flights: [{ id: record.flightId, originationKey: reservation.id, aircraft: reservation.aircraftId }],
        nextCursor: null,
      });
    if (url.pathname.endsWith('/predeparture/progress')) {
      const body = String(init?.body);
      const key = new Headers(init?.headers).get('idempotency-key')!;
      sends.push({ body, key });
      if (!accepted.has(key)) {
        const { expectedRevision, ...content } = JSON.parse(body) as FlightPredepartureProgress;
        const progress = {
          ...content,
          id: `progress-${expectedRevision + 1}`,
          flightId: record.flightId,
          revision: expectedRevision + 1,
          recordedAt: iso(now),
          source: {
            principalId: 'alpha-source',
            missionSourceId: 'mission-planner',
            automaticReleasePrincipalId: 'alpha-service',
          },
        };
        latest = { progress, digest: canonicalDigest(progress) };
        accepted.set(key, latest);
      }
      if (loseReply) {
        loseReply = false;
        throw new Error('Real acceptance reply was lost');
      }
      return json(accepted.get(key));
    }
    if (url.pathname.endsWith('/predeparture')) return json({ enabled: true, progress: latest?.progress ?? null });
    if (url.pathname.endsWith('/mission'))
      return json({ acceptedHead: { record, processing: { status: 'completed' } }, projectedHead: record });
    if (url.pathname.endsWith('/mission-avoidance'))
      return json({
        mission: {
          missionId: record.missionId,
          sourceRevision: record.sourceRevision,
          eventId: record.id,
          contentDigest: record.contentDigest,
          recordDigest: canonicalDigest(record),
        },
        status,
        contextDigest: 'a'.repeat(64),
        candidateCompleteness: { status: 'complete' },
        candidates: status === 'intersects' ? [{ geometry: 'intersects', context: 'current' }] : [],
      });
    if (url.pathname.endsWith('/timeline')) return json({ items: [], decisions: [] });
    if (url.pathname === '/v1/commands') {
      commands.push(JSON.parse(String(init?.body)));
      throw new Error('Automatic commands are unexpected in this fixture');
    }
    throw new Error(`Unexpected source request ${url.pathname}`);
  };
  const runtime = () =>
    new OperationOrdinaryDispatchRuntime({
      apiUrl: 'http://ordinary.example',
      directory: join(directory, 'source'),
      tenants: {
        alpha: {
          sourceToken: 'source-alpha',
          actorToken: 'actor-alpha',
          sourcePrincipalId: 'alpha-source',
          automaticReleasePrincipalId: 'alpha-service',
        },
        beta: {
          sourceToken: 'source-beta',
          actorToken: 'actor-beta',
          sourcePrincipalId: 'beta-source',
          automaticReleasePrincipalId: 'beta-service',
        },
      },
      fetcher,
      now: () => now,
    });
  return {
    reservation,
    sends,
    commands,
    record,
    runtime,
    store: () => store,
    loseReply: () => {
      loseReply = true;
    },
    clear: () => {
      status = 'outside';
      record.sourceRevision = 2;
      record.id = 'ordinary-revision-2';
    },
    actorKind: (kind?: string) => {
      actorKind = kind;
    },
    restart: async () => {
      store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    },
  };
}

describe('ordinary dispatch source recovery', () => {
  it('replays an unknown original status and keeps human review after a now-clear mission revision', async () => {
    const test = await fixture();
    test.loseReply();
    await expect(test.runtime().run(test.store())).rejects.toThrow();
    const retained = test.store().state.ordinaryFlights![test.reservation.id]!.pendingProgress;
    expect(retained).toEqual(test.sends[0]);
    await test.restart();
    await test.runtime().run(test.store());
    expect(test.sends[1]).toEqual(test.sends[0]);
    expect(test.store().state.ordinaryFlights![test.reservation.id]!.needsHumanReview).toBe(true);
    test.clear();
    await test.runtime().run(test.store());
    const flight = test.store().state.ordinaryFlights![test.reservation.id]!;
    expect(flight.progress!.progress.phase).toBe('awaiting_release');
    expect(flight.progress!.progress.needsHumanReview).toBe(true);
    expect(flight.references!.mission.sourceRevision).toBe(2);
    expect(test.commands).toEqual([]);
  });

  it('never authors an automatic release through a human or unknown-kind credential', async () => {
    const test = await fixture();
    test.clear();
    test.actorKind('human');
    await test.runtime().run(test.store());
    expect(test.store().state.ordinaryFlights![test.reservation.id]!.progress!.progress.phase).toBe('blocked');
    expect(test.commands).toEqual([]);
    test.actorKind(undefined);
    await test.runtime().run(test.store());
    expect(test.commands).toEqual([]);
    expect(test.store().state.world.attempts).toEqual([]);
  });
});
