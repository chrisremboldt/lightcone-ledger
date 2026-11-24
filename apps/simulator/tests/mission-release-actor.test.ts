import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@ledger/contracts/client';
import type { MissionReleaseCommandResponse, Principal } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  missionReleaseAvoidance,
  missionReleaseCommand,
  missionReleaseCommandResponse,
  missionReleaseRecordResponse,
  missionReleaseValidityChanged,
  missionReleaseValidityCurrent,
  missionReleaseValidityExpired,
  missionReleaseValidityPending,
  missionReleaseFindingsResponse,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { missionCurrentRead } from '../../../packages/contracts/fixtures/demo/v1/missions.js';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import { runMissionRelease } from '../src/mission-release-actor.js';
import type { MissionReleaseJournal } from '../src/mission-release-journal.js';
import type { MissionReleasePlan } from '../src/mission-release-plan.js';
import { OracleReadError } from '../src/oracle-api.js';

const directories: string[] = [];
const flightPath = `/v1/flights/${encodeURIComponent(missionReleaseCommand.flightId)}`;
const releasePath = `${flightPath}/mission-releases/${encodeURIComponent(missionReleaseCommandResponse.command.id)}`;
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function withoutReleaseSupport() {
  const document = structuredClone(openApiDocument);
  Reflect.deleteProperty(document.paths, '/v1/flights/{id}/mission-releases/{releaseId}');
  Reflect.deleteProperty(document.paths, '/v1/flights/{id}/mission-releases/{releaseId}/validity');
  return document;
}

async function journalAt(path: string): Promise<MissionReleaseJournal> {
  const envelope = JSON.parse(await readFile(path, 'utf8')) as { version: number; body: string; sha256: string };
  expect(envelope.version).toBe(1);
  expect(envelope.sha256).toBe(sha256(envelope.body));
  return JSON.parse(envelope.body) as MissionReleaseJournal;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-release-actor-'));
  directories.push(directory);
  const statePath = join(directory, 'release.json');
  const { kind: _kind, expectedPrincipalRevision: _revision, ...approved } = structuredClone(missionReleaseCommand);
  const plan: MissionReleasePlan = {
    version: 2,
    apiUrl: 'http://release-actor.test',
    tenantId: 'fixture-tenant',
    principalId: missionReleaseCommandResponse.command.actorId,
    ...approved,
  };
  const actor = missionReleaseRecordResponse.release.actor;
  const principal = {
    id: actor.id,
    tenantId: plan.tenantId,
    name: actor.name,
    kind: actor.kind,
    active: true,
    revision: actor.principalRevision,
    capabilities: [...actor.capabilities],
    commandLinkSources: [],
    missionSources: [],
  };
  const document = structuredClone(openApiDocument);
  const mission = structuredClone(missionCurrentRead);
  const preview = {
    ...structuredClone(missionReleaseAvoidance),
    meta: structuredClone(missionReleaseCommandResponse.meta),
  };
  const record = structuredClone(missionReleaseRecordResponse);
  const values = new Map<string, unknown>([
    ['/openapi.json', document],
    ['/v1/me', { principal, meta: structuredClone(missionReleaseCommandResponse.meta) }],
    [
      flightPath,
      {
        flight: {
          id: plan.flightId,
          label: 'Held authored mission',
          originationKey: 'fictional-held-attempt',
          revision: 7,
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
        meta: structuredClone(missionReleaseCommandResponse.meta),
      },
    ],
    [`${flightPath}/mission`, mission],
    [`${flightPath}/mission/revisions/${plan.mission.sourceRevision}`, { mission: mission.projectedHead }],
    [`${flightPath}/mission-avoidance`, preview],
    [`${flightPath}/mission-release-findings`, structuredClone(missionReleaseFindingsResponse)],
    [releasePath, record],
    [`${releasePath}/validity`, structuredClone(missionReleaseValidityCurrent)],
  ]);
  const reads: string[] = [];
  const hooks: { beforeRead?: (path: string) => Promise<void> } = {};
  const api = {
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      await hooks.beforeRead?.(path);
      if (!values.has(path)) throw new Error(`Unexpected release GET ${path}`);
      const value = values.get(path);
      if (value instanceof Error) throw value;
      return structuredClone(value) as T;
    },
    async bytes(path: string): Promise<Uint8Array> {
      throw new Error(`Release authorship must not download or upload source bytes: ${path}`);
    },
    usage: () => ({ requests: reads.length, bytes: 0 }),
  };
  const submit = vi.fn(async (payload: string, _key: string): Promise<MissionReleaseCommandResponse> => ({
    ...structuredClone(missionReleaseCommandResponse),
    command: { ...structuredClone(missionReleaseCommandResponse.command), payload: JSON.parse(payload) },
  }));
  return {
    plan,
    statePath,
    principal,
    document,
    mission,
    preview,
    record,
    values,
    reads,
    hooks,
    api,
    submit,
    run: (post: (payload: string, key: string) => Promise<MissionReleaseCommandResponse> = submit) =>
      runMissionRelease(plan, statePath, api, post),
  };
}

describe('explicit durable mission release actor', () => {
  it('retains a service release request across a lost acceptance reply and later write-grant loss', async () => {
    const f = await fixture();
    Reflect.set(f.principal, 'kind', 'service');
    Reflect.set(f.record.release.actor, 'kind', 'service');
    f.record.digest = canonicalDigest(f.record.release);
    const fresh = vi.fn((principal: Principal) => {
      expect(principal.kind).toBe('service');
      expect(principal.capabilities).toContain('mission:release');
    });
    const post = vi.fn(async (body: string, key: string) => {
      const response = await f.submit(body, key);
      if (post.mock.calls.length === 1) throw new Error('Accepted service release reply lost');
      return response;
    });
    expect(await runMissionRelease(f.plan, f.statePath, f.api, post, fresh)).toMatchObject({ status: 'pending' });
    const original = (await journalAt(f.statePath)).actions[0]!;
    expect(JSON.parse(original.payload)).toEqual(missionReleaseCommand);
    f.principal.capabilities = ['flight:read'];
    f.principal.revision++;
    expect(await runMissionRelease(f.plan, f.statePath, f.api, post, fresh)).toMatchObject({
      status: 'accepted',
      record: 'confirmed',
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect((await journalAt(f.statePath)).actions[0]).toMatchObject({
      key: original.key,
      payload: original.payload,
      status: 'accepted',
    });
    expect(f.record.release.actor.kind).toBe('service');
  });

  it('persists exact approved bytes before submission and the accepted command before exact record confirmation', async () => {
    const f = await fixture();
    f.hooks.beforeRead = async (path) => {
      if (path === releasePath)
        expect((await journalAt(f.statePath)).actions[0]).toMatchObject({
          status: 'accepted',
          accepted: missionReleaseCommandResponse.command,
        });
    };
    const post = vi.fn(async (payload: string, key: string) => {
      const journal = await journalAt(f.statePath);
      expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
      expect(journal).toMatchObject({
        version: 1,
        kind: 'mission-release-action',
        planDigest: canonicalDigest(f.plan),
        principalId: f.plan.principalId,
        tenantId: f.plan.tenantId,
        endpoint: '/v1/commands',
      });
      expect(journal.actions).toEqual([{ key, payload, payloadSha256: sha256(payload), status: 'submitted' }]);
      expect(JSON.parse(payload)).toEqual(missionReleaseCommand);
      return f.submit(payload, key);
    });
    expect(await f.run(post)).toMatchObject({
      status: 'accepted',
      attempts: 1,
      eventId: missionReleaseCommandResponse.command.id,
      flightId: f.plan.flightId,
      record: 'confirmed',
      releaseDigest: missionReleaseRecordResponse.digest,
      validity: missionReleaseValidityCurrent,
    });
    await f.run(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.reads).toContain(`${releasePath}/validity`);
    expect(f.reads.every((path) => !path.includes('departure'))).toBe(true);
  });

  it('replays an ambiguous acceptance with its original bytes, key and principal revision despite later context and grant changes', async () => {
    const f = await fixture();
    const post = vi.fn(async (payload: string, key: string) => {
      const response = await f.submit(payload, key);
      if (post.mock.calls.length === 1) throw new Error('Response lost after acceptance');
      return response;
    });
    expect(await f.run(post)).toMatchObject({ status: 'pending', attempts: 1 });
    const original = (await journalAt(f.statePath)).actions[0]!;
    f.principal.revision += 10;
    f.principal.capabilities = ['flight:read'];
    f.values.set('/openapi.json', withoutReleaseSupport());
    f.preview.contextDigest = '0'.repeat(64);
    f.values.set(`${releasePath}/validity`, structuredClone(missionReleaseValidityChanged));
    f.reads.splice(0);
    expect(await f.run(post)).toMatchObject({
      status: 'accepted',
      record: 'confirmed',
      attempts: 1,
      validity: missionReleaseValidityChanged,
    });
    expect(post.mock.calls[1]).toEqual([original.payload, original.key]);
    expect(JSON.parse(post.mock.calls[1]![0]).expectedPrincipalRevision).toBe(
      missionReleaseCommand.expectedPrincipalRevision,
    );
    expect(f.reads).toEqual(['/v1/me', releasePath, `${releasePath}/validity`]);
    await f.run(post);
    expect(post).toHaveBeenCalledTimes(2);
    expect((await journalAt(f.statePath)).actions).toHaveLength(1);
    f.principal.capabilities = [];
    expect(await f.run(post)).toMatchObject({ status: 'accepted', record: 'unconfirmed', attempts: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps durable acceptance separate from expired, changed or pending validity and unavailable or tampered record reads', async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ status: 'accepted', record: 'confirmed' });
    for (const validity of [
      missionReleaseValidityExpired,
      missionReleaseValidityChanged,
      missionReleaseValidityPending,
    ]) {
      f.values.set(`${releasePath}/validity`, structuredClone(validity));
      expect(await f.run()).toMatchObject({ status: 'accepted', record: 'confirmed', validity });
    }
    f.values.set(
      releasePath,
      new OracleReadError('pending', 'resource_unavailable', 'Exact release is temporarily unavailable'),
    );
    expect(await f.run()).toMatchObject({
      status: 'accepted',
      record: 'unconfirmed',
      eventId: missionReleaseCommandResponse.command.id,
    });
    f.record.release.aircraftId = 'another-aircraft';
    f.record.digest = canonicalDigest(f.record.release);
    f.values.set(releasePath, f.record);
    expect(await f.run()).toMatchObject({ status: 'accepted', record: 'unconfirmed' });
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect((await journalAt(f.statePath)).actions[0]!.status).toBe('accepted');
  });

  it('makes no submission for unsupported fresh contracts, missing authority, foreign identity or changed approved mission/context', async () => {
    const unsupported = await fixture();
    unsupported.values.set('/openapi.json', withoutReleaseSupport());
    expect((await unsupported.run()).status).toBe('pending');
    expect(unsupported.submit).not.toHaveBeenCalled();
    const authority = await fixture();
    authority.principal.capabilities = ['flight:read'];
    expect((await authority.run()).status).toBe('pending');
    expect(authority.submit).not.toHaveBeenCalled();
    const foreign = await fixture();
    foreign.principal.tenantId = 'another-tenant';
    expect((await foreign.run()).status).toBe('pending');
    foreign.principal.tenantId = foreign.plan.tenantId;
    foreign.principal.id = 'another-principal';
    expect((await foreign.run()).status).toBe('pending');
    expect(foreign.submit).not.toHaveBeenCalled();
    const mission = await fixture();
    mission.mission.acceptedHead!.record.sourceRevision++;
    expect((await mission.run()).status).toBe('pending');
    expect(mission.submit).not.toHaveBeenCalled();
    const context = await fixture();
    context.preview.contextDigest = '0'.repeat(64);
    expect((await context.run()).status).toBe('pending');
    expect(context.submit).not.toHaveBeenCalled();
  });

  it('retains a definitive rejection terminally instead of refreshing context or replacing the submission key', async () => {
    const f = await fixture();
    const post = vi.fn(async () => {
      throw new ApiError(409, { error: { code: 'release_evidence_pending' } });
    });
    expect(await f.run(post)).toMatchObject({ status: 'rejected', code: 'release_evidence_pending', attempts: 1 });
    const retained = await readFile(f.statePath, 'utf8');
    f.principal.revision++;
    f.values.set('/openapi.json', withoutReleaseSupport());
    expect(await f.run(post)).toMatchObject({ status: 'rejected', code: 'release_evidence_pending', attempts: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await readFile(f.statePath, 'utf8')).toBe(retained);
    expect((await journalAt(f.statePath)).actions).toHaveLength(1);
  });

  it('pins its plan and journal and excludes concurrent submissions without resetting an uncertain action', async () => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (response: MissionReleaseCommandResponse) => void;
    const response = new Promise<MissionReleaseCommandResponse>((resolve) => {
      finish = resolve;
    });
    const post = vi.fn(async () => {
      entered();
      return response;
    });
    const running = f.run(post);
    await started;
    expect((await f.run()).status).toBe('pending');
    expect(f.submit).not.toHaveBeenCalled();
    finish(structuredClone(missionReleaseCommandResponse));
    expect(await running).toMatchObject({ status: 'accepted', record: 'confirmed' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      (await runMissionRelease({ ...f.plan, note: 'A different approved action' }, f.statePath, f.api, f.submit))
        .status,
    ).toBe('pending');
    expect(f.submit).not.toHaveBeenCalled();
    const corrupt = JSON.parse(await readFile(f.statePath, 'utf8'));
    corrupt.sha256 = '0'.repeat(64);
    const bytes = JSON.stringify(corrupt);
    await writeFile(f.statePath, bytes);
    expect((await f.run()).status).toBe('pending');
    expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
    expect(f.submit).not.toHaveBeenCalled();
  });
});
