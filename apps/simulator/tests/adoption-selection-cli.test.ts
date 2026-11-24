import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRulePackVersion } from '../../../packages/domain/src/rule-pack-registry.js';
import { OracleApi } from '../src/oracle-api.js';
import { runPackAdoptionCli } from '../src/pack-adoption-cli.js';

const mocks = vi.hoisted(() => {
  const request = vi.fn(async () => {
    throw new Error('The mocked actor requires no submission');
  });
  return {
    request,
    ledger: vi.fn(function () {
      return { request };
    }),
    actor: vi.fn(async () => ({
      status: 'accepted',
      code: 'adoption_projected',
      reason: 'Mocked actor result',
      attempts: 1,
    })),
    reader: vi.fn(async () => ({
      kind: 'flight-rule-selection',
      status: 'match',
      code: 'selection_matches',
      reason: 'Retained selection matches',
      flightId: 'resolved-flight-1',
      adoptionId: 'resolved-company-v3-adoption',
      acceptedRevision: 2,
    })),
  };
});
vi.mock('@ledger/adapters', () => ({ LedgerClient: mocks.ledger }));
vi.mock('../src/pack-adoption-actor.js', () => ({ runPackAdoption: mocks.actor }));
vi.mock('../src/adoption-selection-reader.js', () => ({ readAdoptionSelection: mocks.reader }));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('explicit adoption selection CLI mode', () => {
  it('dispatches to the read-only reader before any actor or write client and rejects a present empty selector', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('The mocked selection reader requires no network access');
    });
    vi.stubGlobal('fetch', fetcher);
    const directory = await mkdtemp(join(tmpdir(), 'ledger-adoption-selection-cli-'));
    directories.push(directory);
    const planPath = join(directory, 'plan.json');
    const statePath = join(directory, 'state.json');
    const pack = getRulePackVersion('ledger.demo-procedures', 3)!;
    const plan = {
      version: 1,
      apiUrl: 'http://selection.test',
      tenantId: 'fixture-tenant',
      principalId: 'fictional-selection-reader',
      pack: {
        packId: pack.packId,
        version: pack.version,
        digest: pack.digest,
        leaves: pack.leaves.map(({ id, version, digest }) => ({ id, version, digest })),
        bindings: pack.bindings.map(({ id, version, digest }) => ({ id, version, digest })),
      },
      effectiveInterval: { start: '2026-10-15T14:05:00.000Z', end: '2026-10-15T14:20:00.000Z' },
      note: 'Read one retained selection without creating another adoption.',
      mode: 'active',
    };
    const originalState = 'Reader-owned journal sentinel\n';
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
    await writeFile(statePath, originalState, { mode: 0o600 });
    const env = {
      SIMULATOR_ADOPTION_PLAN: planPath,
      SIMULATOR_ADOPTION_STATE: statePath,
      SIMULATOR_ADOPTION_TOKEN: 'fictional-read-only-token',
      SIMULATOR_ADOPTION_SELECTION_FLIGHT_ID: 'resolved-flight-1',
    };
    const matched = await runPackAdoptionCli(env);
    expect(matched).toMatchObject({ kind: 'flight-rule-selection', status: 'match' });
    expect(mocks.reader).toHaveBeenCalledExactlyOnceWith(plan, statePath, 'resolved-flight-1', expect.any(OracleApi));
    const empty = await runPackAdoptionCli({ ...env, SIMULATOR_ADOPTION_SELECTION_FLIGHT_ID: '' });
    expect(empty.status).toBe('unverifiable');
    expect(mocks.reader).toHaveBeenCalledTimes(1);
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const { SIMULATOR_ADOPTION_SELECTION_FLIGHT_ID: _selector, ...normalEnv } = env;
    const normal = await runPackAdoptionCli(normalEnv);
    expect(normal.status).toBe('accepted');
    expect(mocks.actor).toHaveBeenCalledExactlyOnceWith(plan, statePath, expect.any(OracleApi), expect.any(Function));
    expect(mocks.ledger).toHaveBeenCalledExactlyOnceWith(
      plan.apiUrl,
      env.SIMULATOR_ADOPTION_TOKEN,
      expect.any(Function),
    );
    expect(mocks.reader).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(statePath, 'utf8')).toBe(originalState);
    expect((await readdir(directory)).sort()).toEqual(['plan.json', 'state.json']);
  });
});
