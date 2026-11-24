import { describe, expect, it } from 'vitest';
import { MissionReleaseAcceptedCommandSchema, type Principal } from '@ledger/contracts';
import { openApiDocument, ResponseMetaSchema } from '@ledger/contracts/openapi';
import { canonicalDigest } from '@ledger/integrity';
import {
  missionReleaseAvoidance,
  missionReleaseCommand,
  missionReleaseFindingsResponse,
  missionReleasePolicy,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { missionCurrentRead } from '../../../packages/contracts/fixtures/demo/v1/missions.js';
import type { OracleReader } from '../src/attempt-oracle.js';
import {
  checkMissionReleaseAuthority,
  prepareMissionReleaseCommand,
  reviewedMissionReleasePolicy,
  validateMissionReleaseCommand,
  validateMissionReleasePlan,
  type MissionReleasePlan,
} from '../src/mission-release-plan.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown) => value as JsonObject;
function operation(document: JsonObject, path: string, method = 'get'): JsonObject {
  return object(object(object(document.paths)[path])[method]);
}
function bodySchema(value: JsonObject): JsonObject {
  return object(object(object(value.content)['application/json']).schema);
}
function responseSchema(value: JsonObject, status = '200'): JsonObject {
  return bodySchema(object(object(value.responses)[status]));
}
function property(value: JsonObject, name: string): JsonObject {
  return object(object(value.properties)[name]);
}
function fixture() {
  const { kind: _kind, expectedPrincipalRevision: _revision, ...approved } = structuredClone(missionReleaseCommand);
  const plan: MissionReleasePlan = {
    version: 2,
    apiUrl: 'https://release-plan.test',
    tenantId: 'fixture-tenant',
    principalId: 'resolved-release-author',
    ...approved,
  };
  const principal = {
    id: plan.principalId,
    tenantId: plan.tenantId,
    name: 'Taylor Singh',
    revision: 3,
    capabilities: ['decision:write', 'flight:read', 'mission:release'],
    commandLinkSources: [],
    missionSources: [],
  } as unknown as Principal;
  const document = structuredClone(openApiDocument) as unknown as JsonObject;
  const path = `/v1/flights/${plan.flightId}`;
  const meta = {
    ...structuredClone(missionCurrentRead.meta),
    computedAt: '2026-10-15T14:14:31Z',
    outstandingWork: 999,
  };
  const pages = new Map<string, unknown>([
    ['/openapi.json', document],
    ['/v1/me', { principal }],
    [
      path,
      {
        flight: {
          id: plan.flightId,
          label: 'Reviewed planned mission',
          originationKey: 'fixture-intent:attempt:1',
          revision: 20,
          basisRevision: 20,
          activity: 'planned',
          coverage: 'partial',
          aircraft: plan.aircraftId,
          orderIds: [],
          sourceIds: ['mission-planner'],
          unresolvedCount: 0,
          conflictCount: 0,
          outstandingWork: 999,
        },
        meta,
      },
    ],
    [`${path}/mission`, structuredClone(missionCurrentRead)],
    [`${path}/mission-avoidance`, { ...structuredClone(missionReleaseAvoidance), meta }],
    [`${path}/mission-release-findings`, structuredClone(missionReleaseFindingsResponse)],
  ]);
  const calls: string[] = [];
  const api: OracleReader = {
    async json<T>(path: string): Promise<T> {
      calls.push(path);
      if (!pages.has(path)) throw new Error('Unexpected public read');
      return structuredClone(pages.get(path)) as T;
    },
    async bytes() {
      throw new Error('Release planning must not download bytes');
    },
    usage() {
      return { requests: calls.length, bytes: 0 };
    },
  };
  return { plan, principal, document, pages, calls, api, path };
}

describe('explicit mission release plan and public review', () => {
  it('pins every authored field and exact reviewed policy while retaining lexical clocks', () => {
    const f = fixture();
    expect(reviewedMissionReleasePolicy).toEqual(missionReleasePolicy);
    const approved = validateMissionReleasePlan(f.plan);
    f.plan.note = 'Changed after validation';
    expect(approved.note).toBe(missionReleaseCommand.note);
    const command = { ...missionReleaseCommand, expectedPrincipalRevision: 9 };
    expect(validateMissionReleaseCommand(command, approved)).toEqual(command);
    expect(() =>
      validateMissionReleaseCommand(
        {
          ...command,
          departureWindow: {
            ...command.departureWindow,
            start: '2026-10-15T14:15:00.000Z',
          },
        },
        approved,
      ),
    ).toThrow();
    expect(() =>
      validateMissionReleasePlan({ ...approved, policy: { ...approved.policy, digest: 'f'.repeat(64) } }),
    ).toThrow();
    expect(() =>
      validateMissionReleasePlan({
        ...approved,
        departureWindow: {
          ...approved.departureWindow,
          start: '2026-02-30T14:15:00Z',
        },
      }),
    ).toThrow();
    expect(() => validateMissionReleasePlan({ ...approved, action: 'authorize' })).toThrow();
  });

  it('requires advertised release support, exact schema fields, bearer authentication and idempotency', async () => {
    const absent = fixture();
    delete object(absent.document.paths)['/v1/flights/{id}/mission-releases/{releaseId}'];
    await expect(checkMissionReleaseAuthority(absent.plan, absent.api)).rejects.toMatchObject({
      code: 'contract_pending',
    });
    expect(absent.calls).toEqual(['/openapi.json']);
    const supported = fixture();
    expect(await checkMissionReleaseAuthority(supported.plan, supported.api)).toEqual(supported.principal);
    const specific = fixture();
    const submit = operation(specific.document, '/v1/commands', 'post');
    const originalResponse = responseSchema(submit, '201');
    object(object(object(object(submit.responses)['201']).content)['application/json']).schema = {
      anyOf: [
        originalResponse,
        {
          type: 'object',
          properties: { command: MissionReleaseAcceptedCommandSchema, meta: ResponseMetaSchema },
          required: ['command', 'meta'],
        },
      ],
    };
    expect(await checkMissionReleaseAuthority(specific.plan, specific.api)).toEqual(specific.principal);
    const anonymous = fixture();
    operation(anonymous.document, '/v1/flights/{id}/mission-releases/{releaseId}').security = [{}];
    await expect(checkMissionReleaseAuthority(anonymous.plan, anonymous.api)).rejects.toMatchObject({
      code: 'contract_pending',
    });
    const weakened = fixture();
    const branches = bodySchema(object(operation(weakened.document, '/v1/commands', 'post').requestBody))
      .anyOf as unknown[];
    const releaseIndex = branches.findIndex((branch) => property(object(branch), 'kind').const === 'mission.release');
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    const command = structuredClone(object(branches[releaseIndex]));
    command.required = (command.required as string[]).filter((field) => field !== 'expectedContextDigest');
    branches[releaseIndex] = command;
    await expect(checkMissionReleaseAuthority(weakened.plan, weakened.api)).rejects.toMatchObject({
      code: 'contract_pending',
    });
    const noKey = fixture();
    operation(noKey.document, '/v1/commands', 'post').parameters = [];
    await expect(checkMissionReleaseAuthority(noKey.plan, noKey.api)).rejects.toMatchObject({
      code: 'contract_pending',
    });
    const unsupportedRequirements: Array<(document: JsonObject) => void> = [
      (document) => {
        const submit = operation(document, '/v1/commands', 'post');
        (submit.parameters as unknown[]).push({
          name: 'releaseMode',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        });
      },
      (document) => {
        object(object(document.paths)['/v1/commands']).parameters = [
          { name: 'Tenant-Label', in: 'header', required: true, schema: { type: 'string' } },
        ];
      },
      (document) => {
        bodySchema(object(operation(document, '/v1/commands', 'post').requestBody)).required = ['unsupportedField'];
      },
      (document) => {
        const parameters = operation(document, '/v1/commands', 'post').parameters as JsonObject[];
        parameters[0]!.schema = { type: 'string', minLength: 1, pattern: '^vendor-key-' };
      },
    ];
    for (const change of unsupportedRequirements) {
      const unsupported = fixture();
      change(unsupported.document);
      await expect(checkMissionReleaseAuthority(unsupported.plan, unsupported.api)).rejects.toMatchObject({
        code: 'contract_pending',
      });
      expect(unsupported.calls).toEqual(['/openapi.json']);
    }
  });

  it('uses current write authority only for fresh work and preserves identity plus read authority in recovery', async () => {
    const f = fixture();
    f.principal.capabilities = ['flight:read'];
    f.principal.revision = 99;
    await expect(checkMissionReleaseAuthority(f.plan, f.api)).rejects.toMatchObject({ code: 'authority_pending' });
    f.calls.length = 0;
    f.pages.set('/openapi.json', {});
    expect(await checkMissionReleaseAuthority(f.plan, f.api, false)).toEqual(f.principal);
    expect(f.calls).toEqual(['/v1/me']);
    f.principal.id = 'another-principal';
    await expect(checkMissionReleaseAuthority(f.plan, f.api, false)).rejects.toMatchObject({
      code: 'authority_pending',
    });
    f.principal.id = f.plan.principalId;
    f.principal.capabilities = [];
    await expect(checkMissionReleaseAuthority(f.plan, f.api, false)).rejects.toMatchObject({
      code: 'authority_pending',
    });
  });

  it('prepares only exact accepted/projected mission and comparison pins, without an ordinary-work gate', async () => {
    const f = fixture();
    expect(await prepareMissionReleaseCommand(f.plan, f.api, f.principal)).toEqual(missionReleaseCommand);
    expect(f.calls).toEqual([
      f.path,
      `${f.path}/mission`,
      `${f.path}/mission-avoidance`,
      `${f.path}/mission-release-findings`,
    ]);
    const findings = object(f.pages.get(`${f.path}/mission-release-findings`));
    object(findings.basis).digest = 'e'.repeat(64);
    await expect(prepareMissionReleaseCommand(f.plan, f.api, f.principal)).rejects.toMatchObject({
      code: 'findings_changed',
    });
    f.pages.set(`${f.path}/mission-release-findings`, structuredClone(missionReleaseFindingsResponse));
    const mission = object(f.pages.get(`${f.path}/mission`));
    object(object(mission.acceptedHead).processing).status = 'failed';
    await expect(prepareMissionReleaseCommand(f.plan, f.api, f.principal)).rejects.toMatchObject({
      code: 'mission_pending',
    });
    object(object(mission.acceptedHead).processing).status = 'completed';
    const comparison = object(f.pages.get(`${f.path}/mission-avoidance`));
    const candidates = comparison.candidates as JsonObject[];
    candidates[0]!.safetyContextDigest = 'f'.repeat(64);
    const calculation = object(comparison.calculation);
    comparison.contextDigest = canonicalDigest({
      version: 'mission.avoidance-context.1',
      mission: comparison.mission,
      calculation: { id: calculation.id, version: calculation.version, digest: calculation.digest },
      candidates,
      notApplicable: comparison.notApplicable,
      consideredTypes: comparison.consideredTypes,
      candidateCompleteness: comparison.candidateCompleteness,
    });
    const { meta: _meta, previewDigest: _previewDigest, ...body } = comparison;
    comparison.previewDigest = canonicalDigest(body);
    await expect(prepareMissionReleaseCommand(f.plan, f.api, f.principal)).rejects.toMatchObject({
      code: 'avoidance_changed',
    });
  });
});
