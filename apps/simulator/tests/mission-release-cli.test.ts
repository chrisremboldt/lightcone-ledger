import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  missionReleaseCommand,
  missionReleaseCommandResponse,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { runMissionReleaseCli } from '../src/mission-release-cli.js';
import { OracleApi } from '../src/oracle-api.js';

const mocks = vi.hoisted(() => ({ actor: vi.fn() }));
vi.mock('../src/mission-release-actor.js', () => ({ runMissionRelease: mocks.actor }));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('explicit mission release CLI', () => {
  it('uses the exact pinned command endpoint, bytes and key and takes no action on incomplete or conflicting configuration', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'ledger-release-cli-'));
    directories.push(directory);
    const planPath = join(directory, 'plan.json');
    const statePath = join(directory, 'release.json');
    const { kind: _kind, expectedPrincipalRevision: _revision, ...approved } = structuredClone(missionReleaseCommand);
    const plan = {
      version: 2,
      apiUrl: 'http://release.test',
      tenantId: 'fixture-tenant',
      principalId: missionReleaseCommandResponse.command.actorId,
      ...approved,
    };
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
    const payload = JSON.stringify(missionReleaseCommand);
    const key = 'simulator:mission-release:retained-cli-command';
    let oversized = false;
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`${plan.apiUrl}/v1/commands`);
      expect(init).toMatchObject({ method: 'POST', body: payload, redirect: 'error', credentials: 'omit' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer fictional-release-token');
      expect(headers.get('idempotency-key')).toBe(key);
      if (oversized)
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      return Response.json(missionReleaseCommandResponse);
    });
    vi.stubGlobal('fetch', fetcher);
    mocks.actor.mockImplementation(async (_plan, _path, _api, submit) => {
      expect(await submit(payload, key)).toEqual(missionReleaseCommandResponse);
      return {
        status: 'accepted',
        code: 'release_confirmed',
        reason: 'Mocked immutable release acceptance',
        attempts: 1,
        eventId: missionReleaseCommandResponse.command.id,
        flightId: plan.flightId,
        record: 'confirmed',
      };
    });
    const env = {
      SIMULATOR_RELEASE_PLAN: planPath,
      SIMULATOR_RELEASE_STATE: statePath,
      SIMULATOR_RELEASE_TOKEN: 'fictional-release-token',
    };
    expect(await runMissionReleaseCli(env)).toMatchObject({ status: 'accepted', record: 'confirmed' });
    expect(mocks.actor).toHaveBeenCalledExactlyOnceWith(plan, statePath, expect.any(OracleApi), expect.any(Function));
    expect(fetcher).toHaveBeenCalledTimes(1);
    oversized = true;
    expect(await runMissionReleaseCli(env)).toMatchObject({ status: 'pending', code: 'response_too_large' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await runMissionReleaseCli({ ...env, SIMULATOR_RELEASE_STATE: planPath })).toMatchObject({
      status: 'pending',
      code: 'configuration_invalid',
    });
    expect(await runMissionReleaseCli({ ...env, SIMULATOR_RELEASE_TOKEN: '' })).toMatchObject({
      status: 'pending',
      code: 'configuration_missing',
    });
    await writeFile(
      planPath,
      JSON.stringify({
        ...plan,
        departureWindow: { start: plan.departureWindow.start, end: plan.departureWindow.start },
      }),
    );
    expect((await runMissionReleaseCli(env)).status).toBe('pending');
    expect(mocks.actor).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual(['plan.json']);
  });
});
