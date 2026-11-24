import { describe, expect, it } from 'vitest';
import {
  MissionDepartureAcceptedCommandSchema,
  MissionDepartureAuthorizationCommandSchema,
  MissionDepartureAuthorizationResultSchema,
  type MissionDepartureAuthorizationResponse,
  type Principal,
} from '@ledger/contracts';
import { CommandResponseSchema, openApiDocument, ResponseMetaSchema } from '@ledger/contracts/openapi';
import { canonicalDigest } from '@ledger/integrity';
import {
  missionDepartureAuthorization,
  missionDepartureAuthorizationResponse,
  missionDeparturePolicy,
  missionReleaseRecordResponse,
} from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import type { OracleReader } from '../src/attempt-oracle.js';
import {
  checkMissionDepartureAuthority,
  reviewedMissionDeparturePolicy,
  validateMissionDepartureRequest,
  validateMissionDepartureResponse,
} from '../src/mission-departure-api.js';
import type { MissionDeparturePlan } from '../src/mission-departure-plan.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown) => value as JsonObject;
function fixture(served: boolean | 'generic' = true) {
  const request = structuredClone(missionDepartureAuthorization);
  const response = structuredClone(missionDepartureAuthorizationResponse);
  const release = structuredClone(missionReleaseRecordResponse);
  const mission = release.release.basis.mission;
  const plan: MissionDeparturePlan = {
    version: 1,
    apiUrl: 'https://departure-api.test',
    tenantId: 'fixture-tenant',
    principalId: response.command.actorId,
    runId: 'departure-api-test',
    reservationId: 'held-reservation',
    flightId: request.flightId,
    aircraftId: request.aircraftId,
    release: request.release,
    mission: response.authorization.permit.mission,
    departureAttemptId: request.departureAttemptId,
    marginMs: 1000,
    latencyMarginMs: 1000,
    handoffAllowanceMs: 10_000,
    allocationDurationMs: 60_000,
  };
  const principal: Principal = {
    id: plan.principalId,
    tenantId: plan.tenantId,
    name: 'Taylor Singh',
    revision: request.expectedPrincipalRevision,
    capabilities: ['decision:write', 'flight:read', 'mission:release'],
    commandLinkSources: [],
    missionSources: [],
  };
  const document = structuredClone(openApiDocument) as unknown as JsonObject;
  const submit = object(object(object(document.paths)['/v1/commands']).post);
  const requestContent = object(object(object(submit.requestBody).content)['application/json']);
  const responseContent = object(object(object(object(submit.responses)['201']).content)['application/json']);
  const branches = object(requestContent.schema).anyOf as JsonObject[];
  object(requestContent.schema).anyOf = branches.filter(
    (branch) => object(object(branch.properties).kind).const !== 'mission.departure-authorize',
  );
  if (served) {
    requestContent.schema = { oneOf: [requestContent.schema, { anyOf: [MissionDepartureAuthorizationCommandSchema] }] };
    responseContent.schema = {
      anyOf: [
        responseContent.schema,
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
    };
    if (served === 'generic') {
      const generic = structuredClone(CommandResponseSchema) as unknown as JsonObject;
      const command = object(object(generic.properties).command);
      const kind = object(object(command.properties).kind);
      const kinds = kind.anyOf as JsonObject[];
      if (!kinds.some((branch) => branch.const === 'mission.departure-authorize'))
        kinds.push({ type: 'string', const: 'mission.departure-authorize' });
      object(generic.properties).authorization = MissionDepartureAuthorizationResultSchema;
      responseContent.schema = generic;
    }
  }
  const calls: string[] = [];
  const api: OracleReader = {
    async json<T>(path: string): Promise<T> {
      calls.push(path);
      if (path === '/openapi.json') return structuredClone(document) as T;
      if (path === '/v1/me') return { principal: structuredClone(principal) } as T;
      throw new Error('Unexpected public read');
    },
    async bytes() {
      throw new Error('Departure authority does not download bytes');
    },
    usage() {
      return { requests: calls.length, bytes: 0 };
    },
  };
  const startedAt = Date.parse('2026-10-15T14:15:59.999Z');
  const receivedAt = Date.parse('2026-10-15T14:16:00.001Z');
  const validate = (value: unknown = response, start = startedAt, end = receivedAt) =>
    validateMissionDepartureResponse(value, request, plan, request.allocation, mission, release, start, end);
  return {
    plan,
    request,
    response,
    release,
    mission,
    principal,
    document,
    submit,
    requestContent,
    responseContent,
    calls,
    api,
    validate,
  };
}

function resign(response: MissionDepartureAuthorizationResponse): void {
  response.authorization.digest = canonicalDigest(response.authorization.permit);
  response.command.payload = {
    permit: structuredClone(response.authorization.permit),
    digest: response.authorization.digest,
  };
}

describe('bounded final departure API support and commitments', () => {
  it('holds on the current unserved proposal and accepts only the exact advertised final branch', async () => {
    const proposed = fixture(false);
    await expect(checkMissionDepartureAuthority(proposed.plan, proposed.api)).rejects.toMatchObject({
      code: 'contract_pending',
    });
    expect(proposed.calls).toEqual(['/openapi.json']);
    const supported = fixture();
    expect(await checkMissionDepartureAuthority(supported.plan, supported.api)).toEqual(supported.principal);
    expect(supported.calls).toEqual(['/openapi.json', '/v1/me']);
    const generic = fixture('generic');
    expect(await checkMissionDepartureAuthority(generic.plan, generic.api)).toEqual(generic.principal);
    const incomplete = fixture('generic');
    delete object(object(incomplete.responseContent.schema).properties).authorization;
    await expect(checkMissionDepartureAuthority(incomplete.plan, incomplete.api)).rejects.toMatchObject({
      code: 'contract_pending',
    });
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        object(f.requestContent.schema).required = ['futureApproval'];
      },
      (f: ReturnType<typeof fixture>) => {
        object(object(f.document.paths)['/v1/commands']).parameters = [
          { name: 'Future-Approval', in: 'header', required: true, schema: { type: 'string' } },
        ];
      },
      (f: ReturnType<typeof fixture>) => {
        const parameters = f.submit.parameters as JsonObject[];
        parameters[0]!.schema = { type: 'string', minLength: 1, pattern: '^future-key-' };
      },
    ]) {
      const changed = fixture();
      change(changed);
      await expect(checkMissionDepartureAuthority(changed.plan, changed.api)).rejects.toMatchObject({
        code: 'contract_pending',
      });
      expect(changed.calls).toEqual(['/openapi.json']);
    }
  });

  it('recovers only the pinned identity with read authority without refreshing issuance gates', async () => {
    const f = fixture(false);
    f.principal.capabilities = ['flight:read'];
    f.principal.revision += 10;
    expect(await checkMissionDepartureAuthority(f.plan, f.api, false)).toEqual(f.principal);
    expect(f.calls).toEqual(['/v1/me']);
    f.principal.tenantId = 'another-tenant';
    await expect(checkMissionDepartureAuthority(f.plan, f.api, false)).rejects.toMatchObject({
      code: 'authority_pending',
    });
  });

  it('pins requests and the full accepted permit command independently of response metadata', () => {
    const f = fixture();
    expect(reviewedMissionDeparturePolicy).toEqual(missionDeparturePolicy);
    expect(validateMissionDepartureRequest(f.request, f.plan, f.request.allocation)).toEqual(f.request);
    expect(f.validate()).toEqual(f.response.authorization);
    expect(() =>
      validateMissionDepartureRequest(
        { ...f.request, departureAttemptId: 'replacement-attempt' },
        f.plan,
        f.request.allocation,
      ),
    ).toThrow();
    const rewritten = structuredClone(f.response);
    rewritten.command.payload = structuredClone(f.request);
    expect(() => f.validate(rewritten)).toThrow();
    const changedActor = structuredClone(f.response);
    changedActor.authorization.permit.actor.principalRevision++;
    resign(changedActor);
    expect(() => f.validate(changedActor)).toThrow();
    const changedMission = structuredClone(f.response);
    changedMission.authorization.permit.mission.recordDigest = 'f'.repeat(64);
    resign(changedMission);
    expect(() => f.validate(changedMission)).toThrow();
    const changedContext = structuredClone(f.response);
    changedContext.authorization.permit.contextDigest = 'e'.repeat(64);
    resign(changedContext);
    expect(() => f.validate(changedContext)).toThrow();
  });

  it('retains the original unexpired lease on replay and rejects impossible clocks or renewed bounds', () => {
    const f = fixture();
    const issued = structuredClone(f.response);
    issued.authorization.evaluatedAt = '2026-10-15T14:16:00.001Z';
    expect(f.validate(issued)).toEqual(issued.authorization);
    const replay = structuredClone(f.response);
    replay.authorization.disposition = 'replayed';
    replay.authorization.evaluatedAt = '2026-10-15T14:16:10Z';
    expect(f.validate(replay, Date.parse('2026-10-15T14:16:09.999Z'), Date.parse('2026-10-15T14:16:10.001Z'))).toEqual(
      replay.authorization,
    );
    expect(() => f.validate(replay)).toThrow();
    const expired = structuredClone(replay);
    expired.authorization.evaluatedAt = expired.authorization.permit.validUntil;
    expect(() => f.validate(expired, Date.parse('2026-10-15T14:16:29Z'), Date.parse('2026-10-15T14:16:31Z'))).toThrow();
    const renewed = structuredClone(f.response);
    renewed.authorization.permit.validUntil = '2026-10-15T14:16:30.001Z';
    resign(renewed);
    expect(() => f.validate(renewed)).toThrow();
    const calendar = structuredClone(f.response);
    calendar.authorization.permit.validUntil = '2026-02-30T14:16:30Z';
    resign(calendar);
    expect(() => f.validate(calendar)).toThrow();
    expect(() => f.validate(f.response, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
