import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerClient } from '@ledger/contracts/client';
import { canonicalDigest } from '@ledger/integrity';
import { runHazardRecord } from '../src/hazard-actor.js';
import { runHazardCli } from '../src/hazard-cli.js';
import { runRiskAcceptance } from '../src/hazard-control-actor.js';
import { runHazardControlCli } from '../src/hazard-control-cli.js';
import {
  hazardRecordJournalKind,
  hazardRecordSteps,
  readHazardJournal,
  type HazardRecordPlan,
  type RiskAcceptancePlan,
} from '../src/hazard-plan.js';

// A fictional organization's safety lead records a hazard on the safety record from a flight finding, and its
// accountable executive signs the risk acceptance, against a fake API.

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'ledger-hazard-actor-'));
  directories.push(created);
  return created;
}

const apiUrl = 'http://hazard-actor.test';
const tenantId = 'tenant-fictional';
const safetyLead = 'principal-fictional-safety';
const executive = 'principal-fictional-executive';
const evaluationDigest = 'e'.repeat(64);
const areaType = { id: 'control.avoidance-area', version: 1, digest: 'a'.repeat(64), title: 'Route avoidance area' };
const recordPlan: HazardRecordPlan = {
  version: 2,
  apiUrl,
  tenantId,
  principalId: safetyLead,
  finding: { findingId: 'finding-fictional', evaluationId: 'evaluation-fictional', evaluationDigest },
  hazard: {
    title: 'Link lost over the fictional quarry',
    description: 'The flight lost its link over the quarry.',
    consequence: 'Loss of the aircraft over workers.',
  },
  control: {
    title: 'Keep routes clear of the quarry',
    center: { latitude: 41.89, longitude: -87.64 },
    radiusMeters: 250,
    effectiveFrom: '2026-10-15T14:00:00.000Z',
    effectiveUntil: null,
  },
  assessment: {
    initial: { severity: 'major', likelihood: 'occasional' },
    residual: { severity: 'minor', likelihood: 'remote' },
    note: 'Assessed with the avoidance area in place.',
  },
};
const acceptancePlan: RiskAcceptancePlan = {
  version: 2,
  apiUrl,
  tenantId,
  principalId: executive,
  hazardId: 'hazard-fictional',
  assessmentId: 'command-3',
  note: 'Residual risk accepted with the avoidance area in place.',
};

interface Server {
  as: string;
  posts: { path: string; body: unknown; key: string; headers: Headers }[];
  replies: Map<string, unknown>;
  lose: number[];
  refuse?: string;
  signing?: 'local_fixture' | 'openid_connect';
}
function server(as: string): Server {
  return { as, posts: [], replies: new Map(), lose: [] };
}
function command(server: Server, body: { kind: string }, index: number) {
  const subject =
    index === 1
      ? 'hazard-fictional'
      : index === 2
        ? 'control-fictional'
        : (body as { subject?: { id: string } }).subject!.id;
  return {
    command: {
      id: `command-${index + (server.as === executive ? 3 : 0)}`,
      kind: body.kind,
      actorId: server.as,
      recordedAt: '2026-10-15T14:05:00.000Z',
      payload: body,
      subject: { kind: 'sms', id: subject },
    },
    meta: {},
  };
}
function fakeApi(server: Server): typeof fetch {
  return async (url, init) => {
    const request = new URL(String(url));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (request.pathname === '/v1/me')
      return Response.json({
        principal: {
          id: server.as,
          tenantId,
          revision: 1,
          active: true,
          capabilities: ['sms:read', 'sms:write', 'decision:write', 'flight:read'],
        },
      });
    if (request.pathname === '/v1/sms/findings/finding-fictional/promotion')
      return Response.json({
        origin: { evaluationId: 'evaluation-fictional', evaluationDigest },
        basis: { dependencyBasis: 'b'.repeat(64) },
        existingHazard: null,
      });
    if (request.pathname === '/v1/sms/records/hazard-fictional')
      return Response.json({
        record: { id: 'hazard-fictional', kind: 'hazard' },
        basis: { revision: 2, dependencyBasis: 'c'.repeat(64) },
        decisions: [{ id: 'command-3', kind: 'risk.assess' }],
        matrix: { record: { id: 'matrix-fictional' }, version: { versionNumber: 1 } },
        controlTypes: [areaType],
        controls: [{ id: 'control-fictional', versionNumber: 1 }],
      });
    if (request.pathname === '/v1/sms/records/hazard-fictional/signing')
      return Response.json({
        meaning: 'risk.accept',
        available: true,
        content: {},
        contentDigest: 'd'.repeat(64),
        intent: 'I accept the residual risk.',
        reauthentication: server.signing ?? 'local_fixture',
        basis: { revision: 3, dependencyBasis: 'f'.repeat(64) },
      });
    if (method === 'POST' && request.pathname === '/v1/local/reauthentications')
      return Response.json({ grant: 'grant-fictional', expiresAt: '2026-10-15T14:10:00.000Z' }, { status: 201 });
    if (method === 'POST' && request.pathname === '/v1/commands') {
      const key = headers.get('idempotency-key')!;
      const body = JSON.parse(init!.body as string);
      server.posts.push({ path: request.pathname, body, key, headers });
      if (server.refuse !== undefined && server.refuse === (body.decision?.kind ?? body.record?.kind))
        return Response.json({ error: { code: 'stale_basis', message: 'Refused' } }, { status: 409 });
      if (!server.replies.has(key)) server.replies.set(key, command(server, body, server.replies.size + 1));
      if (server.lose.includes(server.posts.length)) throw new Error('Response lost after the request was accepted');
      return Response.json(server.replies.get(key), { status: 201 });
    }
    return Response.json({ error: { code: 'not_found', message: 'Not served' } }, { status: 404 });
  };
}

describe('the simulated safety lead records a hazard on the safety record', () => {
  it('promotes the finding, proposes the avoidance area and assesses it, replaying a lost request exactly', async () => {
    const statePath = join(await directory(), 'hazard.journal.json');
    const api = server(safetyLead);
    api.lose = [2];
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(api));
    expect(await runHazardRecord(recordPlan, statePath, ledger)).toMatchObject({
      status: 'pending',
      code: 'control_unavailable',
      hazardId: 'hazard-fictional',
    });
    const journal = (await readHazardJournal(statePath, hazardRecordJournalKind, hazardRecordSteps, safetyLead))!;
    expect(journal.planDigest).toBe(canonicalDigest(recordPlan));
    expect(journal.actions.map((entry) => [entry.step, entry.status])).toEqual([
      ['hazard', 'accepted'],
      ['control', 'submitted'],
    ]);
    expect(await runHazardRecord(recordPlan, statePath, ledger)).toMatchObject({
      status: 'accepted',
      code: 'hazard_assessed',
      hazardId: 'hazard-fictional',
      controlId: 'control-fictional',
      assessmentId: 'command-3',
    });
    const [opening, proposal, replay, assessment] = api.posts;
    expect(replay!.key).toBe(proposal!.key);
    expect(replay!.body).toEqual(proposal!.body);
    expect(opening!.body).toMatchObject({
      kind: 'sms.record.open',
      record: { kind: 'hazard', ownerId: safetyLead },
      origin: { kind: 'finding', findingId: 'finding-fictional', evaluationId: 'evaluation-fictional' },
    });
    expect(proposal!.body).toMatchObject({
      record: {
        kind: 'control',
        body: {
          hazardId: 'hazard-fictional',
          controlType: { id: areaType.id, version: 1, digest: areaType.digest },
          parameters: { center: recordPlan.control.center, radiusMeters: 250 },
        },
      },
    });
    expect(assessment!.body).toMatchObject({
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'hazard-fictional' },
      expectedRevision: 2,
      decision: {
        kind: 'risk.assess',
        controls: [{ recordId: 'control-fictional', versionNumber: 1 }],
        evidence: { evaluationId: 'evaluation-fictional' },
      },
    });
    expect(await runHazardRecord(recordPlan, statePath, ledger)).toMatchObject({ status: 'accepted', attempts: 3 });
    expect(api.posts).toHaveLength(4);
  });

  it('refuses a plan whose reviewed evaluation is no longer the latest, and keeps a definitive refusal', async () => {
    const stale = { ...recordPlan, finding: { ...recordPlan.finding, evaluationDigest: '0'.repeat(64) } };
    const api = server(safetyLead);
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(api));
    expect(await runHazardRecord(stale, join(await directory(), 'stale.json'), ledger)).toMatchObject({
      status: 'pending',
      code: 'stale_finding',
    });
    expect(api.posts).toHaveLength(0);
    const refusing = server(safetyLead);
    refusing.refuse = 'risk.assess';
    const statePath = join(await directory(), 'refused.json');
    const refused = new LedgerClient(apiUrl, 'token', fakeApi(refusing));
    expect(await runHazardRecord(recordPlan, statePath, refused)).toMatchObject({
      status: 'rejected',
      code: 'stale_basis',
    });
    expect(await runHazardRecord(recordPlan, statePath, refused)).toMatchObject({ status: 'rejected' });
    expect(refusing.posts).toHaveLength(3);
  });
});

describe('the simulated accountable executive signs the risk acceptance', () => {
  it('signs with a fresh local confirmation and replays the recorded acceptance without signing again', async () => {
    const statePath = join(await directory(), 'acceptance.json');
    const api = server(executive);
    api.lose = [1];
    const ledger = new LedgerClient(apiUrl, 'ledger-dev-executive', fakeApi(api));
    expect(await runRiskAcceptance(acceptancePlan, statePath, ledger, 'ledger-dev-executive')).toMatchObject({
      status: 'pending',
      code: 'acceptance_unavailable',
    });
    expect(await runRiskAcceptance(acceptancePlan, statePath, ledger, 'ledger-dev-executive')).toMatchObject({
      status: 'accepted',
      code: 'risk_accepted',
      acceptanceId: 'command-4',
    });
    const [first, replay] = api.posts;
    expect(replay!.key).toBe(first!.key);
    expect(first!.headers.get('x-ledger-reauthentication')).toBe('grant-fictional');
    expect(first!.body).toEqual({
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'hazard-fictional' },
      expectedRevision: 3,
      expectedDependencyBasis: 'f'.repeat(64),
      decision: {
        kind: 'risk.accept',
        note: acceptancePlan.note,
        assessmentId: 'command-3',
        signature: { intent: 'I accept the residual risk.', contentDigest: 'd'.repeat(64), reviewed: true },
      },
    });
  });

  it('leaves the acceptance to a person where only a person can confirm it is them', async () => {
    const api = server(executive);
    api.signing = 'openid_connect';
    const ledger = new LedgerClient(apiUrl, 'token', fakeApi(api));
    expect(
      await runRiskAcceptance(acceptancePlan, join(await directory(), 'person.json'), ledger, 'token'),
    ).toMatchObject({ status: 'pending', code: 'person_required' });
    expect(api.posts).toHaveLength(0);
  });
});

describe('the hazard command lines', () => {
  it('run each actor from its plan, journal and credential within their pinned requests', async () => {
    const root = await directory();
    await writeFile(join(root, 'hazard.plan.json'), JSON.stringify(recordPlan), { mode: 0o600 });
    await writeFile(join(root, 'acceptance.plan.json'), JSON.stringify(acceptancePlan), { mode: 0o600 });
    const hazard = await runHazardCli(
      {
        SIMULATOR_HAZARD_PLAN: join(root, 'hazard.plan.json'),
        SIMULATOR_HAZARD_STATE: join(root, 'hazard.journal.json'),
        SIMULATOR_HAZARD_TOKEN: 'ledger-dev-safety',
      },
      fakeApi(server(safetyLead)),
    );
    expect(hazard).toMatchObject({ status: 'accepted', hazardId: 'hazard-fictional' });
    const acceptance = await runHazardControlCli(
      {
        SIMULATOR_CONTROL_PLAN: join(root, 'acceptance.plan.json'),
        SIMULATOR_CONTROL_STATE: join(root, 'acceptance.journal.json'),
        SIMULATOR_CONTROL_TOKEN: 'ledger-dev-executive',
      },
      fakeApi(server(executive)),
    );
    expect(acceptance).toMatchObject({ status: 'accepted', code: 'risk_accepted' });
    expect(await runHazardCli({}, fakeApi(server(safetyLead)))).toMatchObject({
      status: 'pending',
      code: 'configuration_missing',
    });
  });
});
