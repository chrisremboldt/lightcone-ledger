import * as filesystem from 'node:fs/promises';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  missionDepartureAuthorization,
  missionDepartureAuthorizationResponse,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import type { MissionDeparturePlan } from '../src/mission-departure-plan.js';
import { loadOperationDepartureRuntime } from '../src/operation-departure-runtime.js';
import type { OperationStore } from '../src/operation-state.js';
import { readOperationBatch, writeOperationBatch } from '../src/operation-history.js';

const mocks = vi.hoisted(() => ({ consumer: vi.fn() }));
vi.mock('../src/operation-departure-consumer.js', () => ({ runOperationDeparture: mocks.consumer }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-departure-runtime-'));
  directories.push(directory);
  const planPath = join(directory, 'plan.json');
  const journalPath = join(directory, 'departure.json');
  const worldPath = join(directory, 'world.json');
  const plan: MissionDeparturePlan = {
    version: 1,
    apiUrl: 'http://departure-runtime.test',
    tenantId: 'fixture-tenant',
    principalId: missionDepartureAuthorizationResponse.command.actorId,
    runId: 'departure-runtime',
    reservationId: 'explicit-held-reservation',
    flightId: missionDepartureAuthorization.flightId,
    aircraftId: missionDepartureAuthorization.aircraftId,
    release: missionDepartureAuthorization.release,
    mission: missionDepartureAuthorizationResponse.authorization.permit.mission,
    departureAttemptId: missionDepartureAuthorization.departureAttemptId,
    marginMs: 1000,
    latencyMarginMs: 1000,
    handoffAllowanceMs: 10_000,
    allocationDurationMs: 60_000,
  };
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const env = {
    SIMULATOR_WORLD_DEPARTURE_PLAN: planPath,
    SIMULATOR_WORLD_DEPARTURE_STATE: journalPath,
    SIMULATOR_WORLD_DEPARTURE_TOKEN: 'fictional-departure-token',
  };
  const payload = JSON.stringify(missionDepartureAuthorization, null, 2) + '\n';
  const key = 'simulator:departure:original-runtime-key';
  return { directory, planPath, journalPath, worldPath, plan, env, payload, key };
}

describe('explicit departure live runtime', () => {
  it('does no IO when inactive and rejects partial configuration before reading or fetching', async () => {
    const open = vi.mocked(filesystem.open);
    const realpath = vi.mocked(filesystem.realpath);
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await loadOperationDepartureRuntime({}, '/absent/world.json', 'invalid unused API', fetcher),
    ).toBeUndefined();
    await expect(
      loadOperationDepartureRuntime(
        { SIMULATOR_WORLD_DEPARTURE_PLAN: '/absent/plan.json' },
        '/absent/world.json',
        'http://api.test',
        fetcher,
      ),
    ).rejects.toMatchObject({ code: 'configuration_missing' });
    expect(open).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.consumer).not.toHaveBeenCalled();
  });

  it('bounds the private plan and separates canonical plan, journal and world transaction paths', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    for (const journal of [f.planPath, f.worldPath, `${f.worldPath}.pending`, `${f.worldPath}.lock`])
      await expect(
        loadOperationDepartureRuntime(
          { ...f.env, SIMULATOR_WORLD_DEPARTURE_STATE: journal },
          f.worldPath,
          f.plan.apiUrl,
          fetcher,
        ),
      ).rejects.toMatchObject({ code: 'configuration_invalid' });
    await link(f.planPath, f.journalPath);
    await expect(loadOperationDepartureRuntime(f.env, f.worldPath, f.plan.apiUrl, fetcher)).rejects.toMatchObject({
      code: 'configuration_invalid',
    });
    await filesystem.unlink(f.journalPath);
    await expect(
      loadOperationDepartureRuntime(f.env, f.worldPath, 'https://another-api.test', fetcher),
    ).rejects.toMatchObject({
      code: 'configuration_invalid',
    });
    await writeFile(f.planPath, Buffer.alloc(128 * 1024 + 1, 32));
    await expect(loadOperationDepartureRuntime(f.env, f.worldPath, f.plan.apiUrl, fetcher)).rejects.toMatchObject({
      code: 'plan_unreadable',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.consumer).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual(['plan.json']);
  });

  it('protects a future immutable history batch reached through canonical directory aliases', async () => {
    const f = await fixture();
    const retained = join(f.directory, 'retained-originals');
    const history = `${f.worldPath}.history`;
    const alias = join(f.directory, 'history-alias');
    await mkdir(retained);
    await symlink(retained, history);
    await symlink(retained, alias);
    await writeOperationBatch(history, 1, { original: 'first mission bytes' });
    const fetcher = vi.fn<typeof fetch>();
    const env = { ...f.env, SIMULATOR_WORLD_DEPARTURE_STATE: join(alias, '2.json') };
    await expect(loadOperationDepartureRuntime(env, f.worldPath, f.plan.apiUrl, fetcher)).rejects.toMatchObject({
      code: 'configuration_invalid',
    });
    expect(await readdir(retained)).toEqual(['1.json']);
    const original = { original: 'later mission bytes' };
    await writeOperationBatch(history, 2, original);
    const bytes = await readFile(join(history, '2.json'));
    await expect(loadOperationDepartureRuntime(env, f.worldPath, f.plan.apiUrl, fetcher)).rejects.toMatchObject({
      code: 'configuration_invalid',
    });
    expect(await readOperationBatch(history, 2)).toEqual(original);
    expect(await readFile(join(history, '2.json'))).toEqual(bytes);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.consumer).not.toHaveBeenCalled();
  });

  it('creates read budgets when run starts and preserves the exact original POST bytes, key and credential', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-16T14:00:00Z');
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input));
      expect(path.origin).toBe(f.plan.apiUrl);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer fictional-departure-token');
      expect(init?.credentials).toBe('omit');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (init?.method === 'GET') {
        expect(path.pathname).toBe('/v1/me');
        expect(init.redirect).toBe('manual');
        return Response.json({ principal: { id: f.plan.principalId } });
      }
      expect(path.pathname).toBe('/v1/commands');
      expect(path.search).toBe('');
      expect(init).toMatchObject({ method: 'POST', body: f.payload, redirect: 'error', cache: 'no-store' });
      expect(headers.get('idempotency-key')).toBe(f.key);
      return Response.json(missionDepartureAuthorizationResponse);
    });
    const store = {} as OperationStore;
    const clock = vi.fn();
    mocks.consumer.mockImplementation(async (plan, journalPath, actualStore, api, submit, now, actualClock) => {
      expect(plan).toEqual(f.plan);
      expect(journalPath).toBe(f.journalPath);
      expect(actualStore).toBe(store);
      expect(now()).toBe(Date.now());
      expect(actualClock).toBe(clock);
      expect(await api.json('/v1/me')).toEqual({ principal: { id: f.plan.principalId } });
      expect(await submit(f.payload, f.key)).toEqual(missionDepartureAuthorizationResponse);
      expect(await submit(f.payload, f.key)).toEqual(missionDepartureAuthorizationResponse);
      return { status: 'held', code: 'transport_checked', reason: 'Mocked consumer boundary', flightId: plan.flightId };
    });
    const runtime = (await loadOperationDepartureRuntime(f.env, f.worldPath, f.plan.apiUrl, fetcher, { clock }))!;
    expect(fetcher).not.toHaveBeenCalled();
    vi.setSystemTime('2026-10-16T14:01:00Z');
    runtime.plan.flightId = 'mutated-public-copy';
    expect(await runtime.run(store)).toMatchObject({ status: 'held', code: 'transport_checked' });
    expect(mocks.consumer).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await readdir(f.directory)).toEqual(['plan.json']);
  });

  it('bounds POST bytes and the whole response deadline without following redirects', async () => {
    const f = await fixture();
    const canceled = vi.fn();
    let response: () => Response = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel: canceled,
        }),
        { status: 201 },
      );
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal;
      return response();
    });
    mocks.consumer.mockImplementation((_plan, _path, _store, _api, submit) => submit(f.payload, f.key));
    const runtime = (await loadOperationDepartureRuntime(f.env, f.worldPath, f.plan.apiUrl, fetcher))!;
    await expect(runtime.run({} as OperationStore)).rejects.toMatchObject({ code: 'response_too_large' });
    expect(canceled).toHaveBeenCalledTimes(1);
    response = () => new Response(null, { status: 302, headers: { location: 'https://remote.test/commands' } });
    await expect(runtime.run({} as OperationStore)).rejects.toMatchObject({ code: 'submit_scope_invalid' });
    vi.useFakeTimers();
    response = () => new Response(new ReadableStream<Uint8Array>({ cancel: canceled }), { status: 201 });
    const pending = expect(runtime.run({} as OperationStore)).rejects.toMatchObject({
      code: 'authorization_uncertain',
    });
    await vi.advanceTimersByTimeAsync(5001);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(canceled).toHaveBeenCalledTimes(2);
  });

  it('cancels in-flight public reads and original submissions when the owning runner stops', async () => {
    for (const phase of ['read', 'submit'] as const) {
      const f = await fixture();
      const controller = new AbortController();
      const canceled = vi.fn();
      let reading!: () => void;
      const bodyRead = new Promise<void>((resolve) => {
        reading = resolve;
      });
      let signal: AbortSignal | null | undefined;
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        expect(new URL(String(input)).origin).toBe(f.plan.apiUrl);
        expect(new URL(String(input)).pathname).toBe(phase === 'read' ? '/v1/me' : '/v1/commands');
        signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull: reading,
              cancel: canceled,
            },
            { highWaterMark: 0 },
          ),
        );
      });
      mocks.consumer.mockImplementation((_plan, _path, _store, api, submit) =>
        phase === 'read' ? api.json('/v1/me') : submit(f.payload, f.key),
      );
      const runtime = (await loadOperationDepartureRuntime(f.env, f.worldPath, f.plan.apiUrl, fetcher, {
        signal: controller.signal,
      }))!;
      vi.useFakeTimers();
      try {
        const rejected = expect(runtime.run({} as OperationStore)).rejects.toThrow();
        await bodyRead;
        controller.abort(new Error('The owning runner stopped'));
        await rejected;
        expect(signal?.aborted).toBe(true);
        expect(canceled).toHaveBeenCalledTimes(1);
        expect(await readdir(f.directory)).toEqual(['plan.json']);
        expect(await readFile(f.planPath, 'utf8')).toBe(JSON.stringify(f.plan));
      } finally {
        controller.abort();
        vi.useRealTimers();
      }
    }
  });
});
