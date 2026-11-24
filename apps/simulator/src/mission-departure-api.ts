import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  MissionDepartureAcceptedCommandSchema,
  MissionDepartureAuthorizationCommandSchema,
  MissionDepartureAuthorizationResultSchema,
  MissionReleaseRecordResponseSchema,
  MissionReleaseValidityResponseSchema,
  MissionRevisionRecordSchema,
  type MissionDepartureAuthorizationCommand,
  type MissionDepartureAuthorizationResponse,
  type MissionDepartureAuthorizationResult,
  type MissionDeparturePolicy,
  type MissionReleaseRecordResponse,
  type MissionRevisionRecord,
  type Principal,
} from '@ledger/contracts';
import {
  CommandResponseSchema,
  FlightMissionResponseSchema,
  FlightResponseSchema,
  ResponseMetaSchema,
} from '@ledger/contracts/openapi';
import { canonicalDigest } from '@ledger/integrity';
import type { OracleReader } from './attempt-oracle.js';
import { validateMissionDeparturePlan, type MissionDeparturePlan } from './mission-departure-plan.js';
import { ReleasePending } from './mission-release-plan.js';
import { OracleReadError } from './oracle-api.js';

const policyDefinition = {
  id: 'ledger.demo.route-avoidance-departure',
  version: 1,
  clock: 'wall',
  permitSeconds: 30,
  authorization: 'finite_lease_at_authorized_at',
  replay: 'same_original_unexpired_lease',
  renewal: 'unsupported',
  uniqueness: 'tenant_flight_and_attempt_and_allocation',
  operationFit: 'producer_checks_before_authorization_and_at_consumption',
  expiry: 'earliest_of_30_seconds_release_end_or_selection_boundary',
  instruction:
    'After retaining one live exclusive reservation and conservatively checking full remaining operation fit, atomically validate the exact release at authorizedAt and issue at most one nonrenewable lease per tenant and Ledger flight. Tenant/allocation identity binds one flight and attempt, not a pad name. The lease ends at the earliest of 30 seconds, release-window end or relevant selection boundary. Later safety changes do not revoke this issued lease. Exact original-key retries return the same unexpired lease without fresh safety or principal-revision comparison and never extend it; expired retries fail. No new key, attempt or allocation can obtain another authorization for this flight, including when its first lease expired unused. Before POST, the producer checks route duration, known holds, margin and conservative lease handoff delay against mission end. At consumption, it refreshes fit and atomically retains the exact pinned mission, aircraft, route, live exclusive allocation, fit witness, once-per-flight consumption and physical transition across restart. An unused expired lease leaves the flight held or abandoned; there is no replacement protocol. Allocation and operation fit are producer commitments, not Ledger resource or aircraft-performance certification.',
} as const;
export const reviewedMissionDeparturePolicy: Readonly<MissionDeparturePolicy> = Object.freeze({
  ...policyDefinition,
  digest: canonicalDigest(policyDefinition),
});
const responseSchema = {
  type: 'object',
  properties: {
    command: MissionDepartureAcceptedCommandSchema,
    authorization: MissionDepartureAuthorizationResultSchema,
    meta: ResponseMetaSchema,
  },
  required: ['command', 'authorization', 'meta'],
  additionalProperties: false,
};
const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const requestShape = ajv.compile<MissionDepartureAuthorizationCommand>(MissionDepartureAuthorizationCommandSchema);
const responseShape = ajv.compile<MissionDepartureAuthorizationResponse>(responseSchema);
const missionShape = ajv.compile<MissionRevisionRecord>(MissionRevisionRecordSchema);
const releaseShape = ajv.compile<MissionReleaseRecordResponse>(MissionReleaseRecordResponseSchema);
const capabilities = ['decision:write', 'flight:read', 'mission:release'];
const annotations = ['description', 'title', 'examples', 'example', 'default', '$id', '$schema', '$comment'];
type JsonObject = Record<string, unknown>;
type AllocationReference = MissionDepartureAuthorizationCommand['allocation'];
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);

function pending(code: string, reason: string): never {
  throw new ReleasePending(code, reason);
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return pending('contract_pending', 'The served departure contract has an unsupported shape');
  return value as JsonObject;
}
function property(value: unknown, name: string): unknown {
  return object(object(value).properties)[name];
}
function alternatives(value: unknown, depth = 0): JsonObject[] {
  const schema = object(value);
  if (depth > 8 || (schema.anyOf !== undefined && schema.oneOf !== undefined))
    pending('contract_pending', 'The served departure alternatives are unsupported');
  const children = schema.anyOf ?? schema.oneOf;
  if (children === undefined) return [schema];
  if (
    Object.keys(schema).some((key) => !['anyOf', 'oneOf', ...annotations].includes(key)) ||
    !Array.isArray(children) ||
    !children.length ||
    children.length > 64
  )
    return pending('contract_pending', 'The served departure alternatives are unsupported');
  const result = children.flatMap((child) => alternatives(child, depth + 1));
  if (result.length > 64) pending('contract_pending', 'The served departure alternatives exceed their bound');
  return result;
}
function validationSchema(value: unknown, depth = 0, propertyMap = false): unknown {
  if (depth > 48) pending('contract_pending', 'The served departure schema exceeds its nesting bound');
  if (Array.isArray(value)) return value.map((child) => validationSchema(child, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => propertyMap || !annotations.includes(key))
      .map(([key, child]) => [
        key,
        validationSchema(
          child,
          depth + 1,
          !propertyMap && ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key),
        ),
      ]),
  );
}
function schemaMatches(value: unknown, expected: unknown): void {
  if (!same(validationSchema(object(value)), validationSchema(expected)))
    pending('contract_pending', 'The served departure schema differs from the supported profile');
}
function content(value: unknown): unknown {
  return object(object(object(value).content)['application/json']).schema;
}
function response(operation: JsonObject): unknown {
  return content(object(operation.responses)['200']);
}
function checkContract(value: unknown): void {
  const document = object(value);
  if (
    document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1' ||
    object(document.info).version !== '0.1.0'
  )
    pending('contract_pending', 'The served departure contract version is unsupported');
  const bearer = object(object(object(document.components).securitySchemes).bearerAuth);
  if (bearer.type !== 'http' || bearer.scheme !== 'bearer')
    pending('contract_pending', 'The served departure authentication is unsupported');
  const paths = object(document.paths);
  const operation = (path: string, method: 'get' | 'post') => {
    const operation = object(object(paths[path])[method]);
    const security = operation.security ?? document.security;
    if (
      !Array.isArray(security) ||
      !security.length ||
      security.some((value) => {
        const requirement = object(value);
        return Object.keys(requirement).length !== 1 || !same(requirement.bearerAuth, []);
      })
    )
      pending('contract_pending', 'Served departure operations must require bearer authentication');
    return operation;
  };
  const principal = property(response(operation('/v1/me', 'get')), 'principal');
  const required = object(principal).required;
  if (
    !Array.isArray(required) ||
    !['id', 'tenantId', 'revision', 'capabilities'].every((field) => required.includes(field))
  )
    pending('contract_pending', 'The served departure principal is unsupported');
  const available = alternatives(object(property(principal, 'capabilities')).items);
  if (
    !capabilities.every((capability) =>
      available.some(
        (entry) => entry.const === capability || (Array.isArray(entry.enum) && entry.enum.includes(capability)),
      ),
    )
  )
    pending('contract_pending', 'The served departure capabilities are unavailable');
  for (const [path, schema] of [
    ['/v1/flights/{id}', FlightResponseSchema],
    ['/v1/flights/{id}/mission', FlightMissionResponseSchema],
    ['/v1/flights/{id}/mission-releases/{releaseId}', MissionReleaseRecordResponseSchema],
    ['/v1/flights/{id}/mission-releases/{releaseId}/validity', MissionReleaseValidityResponseSchema],
  ] as const)
    schemaMatches(response(operation(path, 'get')), schema);
  const submit = operation('/v1/commands', 'post');
  const inherited = object(paths['/v1/commands']).parameters;
  if (
    (inherited !== undefined && !Array.isArray(inherited)) ||
    (submit.parameters !== undefined && !Array.isArray(submit.parameters))
  )
    pending('contract_pending', 'The served departure parameters are unsupported');
  let keys = 0;
  for (const value of [...(inherited ?? []), ...(submit.parameters ?? [])]) {
    const parameter = object(value);
    if (
      Object.hasOwn(parameter, '$ref') ||
      typeof parameter.name !== 'string' ||
      !['header', 'path', 'query', 'cookie'].includes(String(parameter.in)) ||
      (parameter.required !== undefined && typeof parameter.required !== 'boolean')
    )
      pending('contract_pending', 'The served departure parameters are unsupported');
    if (parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key') {
      if (parameter.required !== true) pending('contract_pending', 'The served departure requires an idempotency key');
      schemaMatches(parameter.schema, { type: 'string', minLength: 1 });
      keys++;
    } else if (parameter.required === true)
      pending('contract_pending', 'The served departure requires unsupported parameters');
  }
  if (keys !== 1) pending('contract_pending', 'The served departure idempotency support is unavailable');
  const request = object(submit.requestBody);
  if (request.required !== true) pending('contract_pending', 'The served departure requires a JSON request');
  const requests = alternatives(content(request)).filter(
    (branch) => object(property(branch, 'kind')).const === 'mission.departure-authorize',
  );
  if (requests.length !== 1) pending('contract_pending', 'Final departure authorization is unavailable or ambiguous');
  schemaMatches(requests[0], MissionDepartureAuthorizationCommandSchema);
  const envelopes = alternatives(content(object(submit.responses)['201'])).filter((branch) => {
    const properties = branch.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      !Object.hasOwn(properties, 'authorization')
    )
      return false;
    return true;
  });
  const specific = envelopes.filter(
    (branch) => object(property(property(branch, 'command'), 'kind')).const === 'mission.departure-authorize',
  );
  if (specific.length) {
    if (specific.length !== 1) pending('contract_pending', 'The served departure response is ambiguous');
    schemaMatches(specific[0], responseSchema);
  } else {
    if (envelopes.length !== 1)
      pending('contract_pending', 'The served departure response is unavailable or ambiguous');
    const kind = property(property(envelopes[0], 'command'), 'kind');
    const finalKinds = alternatives(kind).filter((branch) => branch.const === 'mission.departure-authorize');
    if (finalKinds.length !== 1) pending('contract_pending', 'The served response omits final departure authorization');
    schemaMatches(finalKinds[0], { type: 'string', const: 'mission.departure-authorize' });
    schemaMatches(envelopes[0], {
      ...CommandResponseSchema,
      properties: {
        ...CommandResponseSchema.properties,
        command: {
          ...CommandResponseSchema.properties.command,
          properties: { ...CommandResponseSchema.properties.command.properties, kind },
        },
        authorization: MissionDepartureAuthorizationResultSchema,
      },
    });
  }
}

export async function checkMissionDepartureAuthority(
  planValue: MissionDeparturePlan,
  api: OracleReader,
  fresh = true,
): Promise<Principal> {
  try {
    const plan = validateMissionDeparturePlan(planValue);
    if (fresh) checkContract(await api.json<unknown>('/openapi.json'));
    const current = object(object(await api.json<unknown>('/v1/me')).principal);
    if (
      current.id !== plan.principalId ||
      current.tenantId !== plan.tenantId ||
      current.active === false ||
      typeof current.name !== 'string' ||
      !Number.isSafeInteger(current.revision) ||
      Number(current.revision) < (fresh ? 1 : 0) ||
      !Array.isArray(current.capabilities) ||
      current.capabilities.length > 200 ||
      !current.capabilities.every((value) => typeof value === 'string') ||
      !(fresh ? capabilities : ['flight:read']).every((capability) =>
        (current.capabilities as string[]).includes(capability),
      )
    )
      pending('authority_pending', 'The authenticated departure principal, scope or authority differs from the plan');
    return structuredClone(current) as unknown as Principal;
  } catch (error) {
    if (error instanceof ReleasePending) throw error;
    if (error instanceof OracleReadError) pending(error.code, 'A required departure authority read is unavailable');
    return pending('unsupported_response', 'Departure authority information is malformed or unsupported');
  }
}

export function validateMissionDepartureRequest(
  value: unknown,
  planValue: MissionDeparturePlan,
  allocationRef: AllocationReference,
): MissionDepartureAuthorizationCommand {
  const plan = validateMissionDeparturePlan(planValue);
  if (
    !requestShape(value) ||
    value.flightId !== plan.flightId ||
    value.aircraftId !== plan.aircraftId ||
    value.departureAttemptId !== plan.departureAttemptId ||
    !same(value.release, plan.release) ||
    !same(value.allocation, allocationRef)
  )
    return pending(
      'commitment_mismatch',
      'The retained departure request differs from the approved plan or allocation',
    );
  return structuredClone(value);
}

function utc(value: string): number {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return pending('commitment_mismatch', 'The departure response has an unsupported UTC clock');
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19))
    return pending('commitment_mismatch', 'The departure response has an invalid UTC calendar clock');
  return at;
}

export function validateMissionDepartureResponse(
  value: unknown,
  requestValue: unknown,
  planValue: MissionDeparturePlan,
  allocationRef: AllocationReference,
  exactMissionRecord: MissionRevisionRecord,
  exactRelease: MissionReleaseRecordResponse,
  requestStartedAtMs: number,
  receivedAtMs: number,
): MissionDepartureAuthorizationResult {
  const plan = validateMissionDeparturePlan(planValue);
  const request = validateMissionDepartureRequest(requestValue, plan, allocationRef);
  if (!responseShape(value) || !missionShape(exactMissionRecord) || !releaseShape(exactRelease))
    return pending('commitment_mismatch', 'The departure response or exact retained evidence is unsupported');
  const { command, authorization } = value;
  const { permit, digest } = authorization;
  const authorizedAt = utc(permit.authorizedAt);
  const validUntil = utc(permit.validUntil);
  const evaluatedAt = utc(authorization.evaluatedAt);
  const mission = exactMissionRecord;
  const reference = {
    missionId: mission.missionId,
    sourceRevision: mission.sourceRevision,
    eventId: mission.id,
    contentDigest: mission.contentDigest,
    recordDigest: canonicalDigest(mission),
  };
  const release = exactRelease.release;
  const { digest: policyDigest, ...definition } = permit.policy;
  if (
    digest !== canonicalDigest(permit) ||
    !same(permit.policy, reviewedMissionDeparturePolicy) ||
    policyDigest !== canonicalDigest(definition) ||
    command.id !== permit.id ||
    command.flightId !== plan.flightId ||
    command.actorId !== plan.principalId ||
    utc(command.recordedAt) !== authorizedAt ||
    !same(command.payload, { permit, digest }) ||
    permit.flightId !== plan.flightId ||
    permit.aircraftId !== plan.aircraftId ||
    !same(permit.release, plan.release) ||
    !same(permit.mission, plan.mission) ||
    !same(reference, plan.mission) ||
    mission.flightId !== plan.flightId ||
    mission.aircraftId !== plan.aircraftId ||
    mission.authority.tenantId !== plan.tenantId ||
    permit.departureAttemptId !== plan.departureAttemptId ||
    !same(permit.allocation, allocationRef) ||
    permit.actor.id !== plan.principalId ||
    permit.actor.scope.id !== plan.flightId ||
    permit.actor.principalRevision !== request.expectedPrincipalRevision ||
    !capabilities.every((capability) => permit.actor.capabilities.includes(capability)) ||
    new Set(permit.actor.capabilities).size !== permit.actor.capabilities.length ||
    exactRelease.digest !== canonicalDigest(release) ||
    !same(plan.release, { id: release.id, digest: exactRelease.digest }) ||
    release.flightId !== plan.flightId ||
    release.organizationId !== `organization:${plan.tenantId}` ||
    release.aircraftId !== plan.aircraftId ||
    !same(release.basis.mission, mission) ||
    permit.contextDigest !== release.basis.avoidance.contextDigest ||
    authorizedAt < utc(release.departureWindow.start) ||
    validUntil > utc(release.departureWindow.end) ||
    authorizedAt < utc(mission.operatingInterval.start) ||
    validUntil > utc(mission.operatingInterval.end) ||
    validUntil <= authorizedAt ||
    validUntil - authorizedAt > 30_000 ||
    evaluatedAt < authorizedAt ||
    evaluatedAt >= validUntil ||
    !Number.isSafeInteger(requestStartedAtMs) ||
    !Number.isSafeInteger(receivedAtMs) ||
    requestStartedAtMs > receivedAtMs ||
    evaluatedAt > receivedAtMs ||
    (authorization.disposition === 'issued' && authorizedAt < requestStartedAtMs)
  )
    return pending(
      'commitment_mismatch',
      'The departure permit differs from its exact request, evidence or original finite lease',
    );
  return structuredClone(authorization);
}
