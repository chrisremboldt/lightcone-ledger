import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  MissionReleaseAvoidanceSchema,
  MissionReleaseCommandSchema,
  MissionReleaseFindingsResponseSchema,
  MissionReleaseRecordResponseSchema,
  MissionReleaseValidityResponseSchema,
  MissionRevisionRecordSchema,
  type FlightMissionResponse,
  type FlightResponse,
  type MissionAvoidanceCalculation,
  type MissionAvoidanceResponse,
  type MissionReleaseAvoidance,
  type MissionReleaseCommand,
  type MissionReleaseFindingsResponse,
  type MissionReleasePolicy,
  type MissionRevisionRecord,
  type Principal,
} from '@ledger/contracts';
import {
  FlightMissionResponseSchema,
  FlightResponseSchema,
  MissionAvoidanceResponseSchema,
} from '@ledger/contracts/openapi';
import { areaControlTypes } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import type { OracleReader } from './attempt-oracle.js';
import { OracleReadError } from './oracle-api.js';

export interface MissionReleasePlan {
  version: 2;
  apiUrl: string;
  tenantId: string;
  principalId: string;
  flightId: string;
  aircraftId: string;
  mission: MissionReleaseCommand['mission'];
  calculation: MissionReleaseCommand['calculation'];
  policy: MissionReleaseCommand['policy'];
  expectedContextDigest: string;
  /** The digest of the open findings the person approving the plan reviewed. */
  expectedFindingsDigest: string;
  departureWindow: MissionReleaseCommand['departureWindow'];
  note: string;
}

export class ReleasePending extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReleasePending';
  }
}

const avoidanceInstruction =
  'At acceptance, record route-avoidance release for the exact assigned aircraft and accepted and projected mission revision using the complete outside and current avoidance context. Every accepted area control overlapping the mission interval is considered and evaluated by the applicability rule its type declares; only the controls that apply must be outside, and each that does not is recorded with what was measured, the rule that decided it and its inputs by digest. The departure window lies within the mission interval. Current validity is as-of information; final authorization after allocation issues a separate finite lease. This release alone does not permit entering flight.';
const policyDefinition = {
  id: 'ledger.demo.route-avoidance-release',
  version: 2,
  title: 'Recorded route avoidance release with open findings and control applicability',
  status: 'draft',
  scope: 'recorded_route_avoidance',
  clock: 'wall',
  mission: 'exact_accepted_and_projected_revision',
  aircraft: 'exact_current_assignment',
  avoidance: 'applicable_outside_complete_current',
  applicability: 'considered_controls_recorded',
  window: 'finite_half_open_subset_of_mission',
  comparison: 'mission_aircraft_policy_and_safety_context',
  validity: 'as_of_read_only',
  departure: 'separate_authorization_after_allocation',
  findings: 'open_active_findings_listed_and_attested',
  instruction: `${avoidanceInstruction} The release also lists the open findings from rules adopted in active mode about the flight, its organization and the subjects its records name, each with its rule, current answer and pinned evaluation, and pins that list by digest. The person releasing attests having seen them; a listed finding is not a verdict and blocks nothing. Findings from rules adopted in shadow mode are shown beside the list, recorded and not counted.`,
} as const;
export const reviewedMissionReleasePolicy: Readonly<MissionReleasePolicy> = Object.freeze({
  ...policyDefinition,
  digest: canonicalDigest(policyDefinition),
});
export const reviewedMissionReleaseCalculation: Readonly<MissionAvoidanceCalculation> = Object.freeze({
  id: 'ledger.demo.mission-site-avoidance',
  version: 1,
  digest: '7ef485fc10cbdaedab3195b727bc6ef45aebb74e9090132910376fa2bd998308',
  profile: 'ledger.local-mission-avoidance.1',
  geometry: 'ledger.wgs84-conservative-bounds.1',
  distanceBudget: 100000,
});
const requiredCapabilities = ['decision:write', 'flight:read', 'mission:release'];
const templateReference = {
  id: 'ledger.demo.site-avoidance',
  version: 1,
  digest: '522bf3c4e0d2b74e53a28a1ae4a0fd8ccda4573f7453d9c758f71ef25e7daec3',
};
const schemaAnnotations = ['description', 'title', 'examples', 'example', 'default', '$id', '$schema', '$comment'];
const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const commandShape = ajv.compile<MissionReleaseCommand>(MissionReleaseCommandSchema);
const missionShape = ajv.compile<MissionRevisionRecord>(MissionRevisionRecordSchema);
const avoidanceShape = ajv.compile<MissionReleaseAvoidance>(MissionReleaseAvoidanceSchema);
const flightShape = ajv.compile<FlightResponse>(FlightResponseSchema);
const missionReadShape = ajv.compile<FlightMissionResponse>(FlightMissionResponseSchema);
const avoidanceReadShape = ajv.compile<MissionAvoidanceResponse>(MissionAvoidanceResponseSchema);
const findingsReadShape = ajv.compile<MissionReleaseFindingsResponse>(MissionReleaseFindingsResponseSchema);
type JsonObject = Record<string, unknown>;
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);

function pending(code: string, message: string): never {
  throw new ReleasePending(code, message);
}
function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return pending(code, 'Mission release information has an unsupported object shape');
  return value as JsonObject;
}
function keys(value: JsonObject, fields: string[], code: string): void {
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)))
    pending(code, 'Mission release information has missing or unsupported fields');
}
function text(value: unknown, code: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    return pending(code, 'Mission release identity or text is invalid');
  return value;
}
function utc(value: unknown, code: string): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return pending(code, 'Mission release requires a finite UTC clock');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    return pending(code, 'Mission release requires a valid UTC calendar time');
  return time;
}
function window(value: MissionReleaseCommand['departureWindow'], code: string): void {
  if (utc(value.start, code) >= utc(value.end, code)) pending(code, 'The authored departure window must be ordered');
}
function fields(plan: MissionReleasePlan) {
  return {
    flightId: plan.flightId,
    aircraftId: plan.aircraftId,
    mission: plan.mission,
    calculation: plan.calculation,
    policy: plan.policy,
    expectedContextDigest: plan.expectedContextDigest,
    expectedFindingsDigest: plan.expectedFindingsDigest,
    departureWindow: plan.departureWindow,
    note: plan.note,
  };
}

export function validateMissionReleasePlan(value: unknown): MissionReleasePlan {
  const code = 'plan_invalid';
  const plan = object(value, code);
  keys(
    plan,
    [
      'version',
      'apiUrl',
      'tenantId',
      'principalId',
      'flightId',
      'aircraftId',
      'mission',
      'calculation',
      'policy',
      'expectedContextDigest',
      'expectedFindingsDigest',
      'departureWindow',
      'note',
    ],
    code,
  );
  if (plan.version !== 2) pending(code, 'Mission release plan version is unsupported');
  try {
    const url = new URL(text(plan.apiUrl, code, 2048));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      pending(code, 'Mission release API must be an HTTP(S) origin without credentials');
  } catch {
    pending(code, 'Mission release API must be an HTTP(S) origin without credentials');
  }
  text(plan.tenantId, code);
  text(plan.principalId, code);
  const typed = plan as unknown as MissionReleasePlan;
  if (!commandShape({ kind: 'mission.release', ...fields(typed), expectedPrincipalRevision: 1 }))
    pending(code, 'Mission release plan does not match the supported command fields');
  text(plan.flightId, code);
  text(plan.aircraftId, code);
  if (
    typeof plan.note !== 'string' ||
    !plan.note.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plan.note)
  )
    pending(code, 'Mission release requires an authored note');
  window(typed.departureWindow, code);
  const { id, version, digest } = reviewedMissionReleaseCalculation;
  if (!same(plan.calculation, { id, version, digest }))
    pending('calculation_unsupported', 'Only the exact reviewed mission avoidance calculation is supported');
  if (
    !same(plan.policy, {
      id: reviewedMissionReleasePolicy.id,
      version: reviewedMissionReleasePolicy.version,
      digest: reviewedMissionReleasePolicy.digest,
    })
  )
    pending('policy_unsupported', 'Only the exact reviewed route avoidance release policy is supported');
  return structuredClone(typed);
}

export function validateMissionReleaseCommand(value: unknown, planValue: MissionReleasePlan): MissionReleaseCommand {
  const plan = validateMissionReleasePlan(planValue);
  if (!commandShape(value)) pending('journal_mismatch', 'The retained release request has an unsupported shape');
  const { kind: _kind, expectedPrincipalRevision: _revision, ...retained } = value;
  if (!same(retained, fields(plan)))
    pending('journal_mismatch', 'The retained release request differs from the explicitly approved plan');
  window(value.departureWindow, 'journal_mismatch');
  return structuredClone(value);
}

export function validateMissionReleaseMission(value: unknown, planValue: MissionReleasePlan): MissionRevisionRecord {
  const plan = validateMissionReleasePlan(planValue);
  if (!missionShape(value)) pending('mission_unsupported', 'The exact mission record is unsupported');
  const reference = {
    missionId: value.missionId,
    sourceRevision: value.sourceRevision,
    eventId: value.id,
    contentDigest: value.contentDigest,
    recordDigest: canonicalDigest(value),
  };
  if (value.flightId !== plan.flightId || value.aircraftId !== plan.aircraftId || !same(reference, plan.mission))
    pending('mission_changed', 'The visible mission differs from the explicitly approved revision or aircraft');
  if (value.authority.tenantId !== plan.tenantId || !value.authority.grantedSources.includes(value.sourceId))
    pending('mission_unsupported', 'The exact mission has unsupported retained source authority');
  utc(value.occurredAt, 'mission_unsupported');
  utc(value.recordedAt, 'mission_unsupported');
  const start = utc(value.operatingInterval.start, 'mission_unsupported');
  const end = utc(value.operatingInterval.end, 'mission_unsupported');
  if (start >= end || value.altitude.minimum > value.altitude.maximum)
    pending('mission_unsupported', 'The exact mission has an invalid interval or altitude band');
  if (utc(plan.departureWindow.start, 'plan_invalid') < start || utc(plan.departureWindow.end, 'plan_invalid') > end)
    pending('window_outside_mission', 'The authored departure window is outside the exact mission interval');
  return structuredClone(value);
}

export function validateMissionReleaseAvoidance(
  value: unknown,
  planValue: MissionReleasePlan,
): MissionReleaseAvoidance {
  const plan = validateMissionReleasePlan(planValue);
  if (!avoidanceShape(value)) pending('avoidance_unsupported', 'A complete outside and current comparison is required');
  utc(value.evaluatedAt, 'avoidance_unsupported');
  if (!same(value.mission, plan.mission) || !same(value.calculation, reviewedMissionReleaseCalculation))
    pending('avoidance_changed', 'The comparison uses another mission or calculation');
  if (
    value.candidateCompleteness.count !== value.candidates.length ||
    value.candidateCompleteness.considered !== value.candidates.length + value.notApplicable.length
  )
    pending('avoidance_unsupported', 'The comparison candidate count is inconsistent');
  const controls = new Set<string>();
  const acceptances = new Set<string>();
  const versions = new Set<string>();
  for (const candidate of value.candidates) {
    const version = canonicalDigest([candidate.hazardId, candidate.controlId, candidate.controlVersion]);
    if (controls.has(candidate.controlEventId) || acceptances.has(candidate.acceptance.id) || versions.has(version))
      pending('avoidance_unsupported', 'The comparison repeats an accepted control version');
    controls.add(candidate.controlEventId);
    acceptances.add(candidate.acceptance.id);
    versions.add(version);
    // Besides the flight-side site template, any registered control type that describes an area, pinned by digest:
    // route review compares such areas on the safety record the same way.
    if (
      !same(candidate.template, templateReference) &&
      !areaControlTypes().some((type) => same(candidate.template, type))
    )
      pending('avoidance_unsupported', 'The comparison contains an unsupported control template');
    if (utc(candidate.interval.start, 'avoidance_unsupported') >= utc(candidate.interval.end, 'avoidance_unsupported'))
      pending('avoidance_unsupported', 'A compared control has an invalid interval');
  }
  const { id, version, digest } = value.calculation;
  const contextDigest = canonicalDigest({
    version: 'mission.avoidance-context.1',
    mission: value.mission,
    calculation: { id, version, digest },
    candidates: value.candidates,
    notApplicable: value.notApplicable,
    consideredTypes: value.consideredTypes,
    candidateCompleteness: value.candidateCompleteness,
  });
  const { previewDigest, ...preview } = value;
  if (contextDigest !== value.contextDigest || previewDigest !== canonicalDigest(preview))
    pending('avoidance_unsupported', 'The comparison content commitments are inconsistent');
  if (value.contextDigest !== plan.expectedContextDigest)
    pending('avoidance_changed', 'The narrow safety context differs from the explicitly approved comparison');
  return structuredClone(value);
}

function property(value: unknown, key: string): unknown {
  return object(object(value, 'contract_pending').properties, 'contract_pending')[key];
}
function alternatives(value: unknown, depth = 0): JsonObject[] {
  const schema = object(value, 'contract_pending');
  if (depth > 8 || (schema.anyOf !== undefined && schema.oneOf !== undefined))
    pending('contract_pending', 'Served release schema alternatives are unsupported');
  const children = schema.anyOf ?? schema.oneOf;
  if (children === undefined) return [schema];
  if (Object.keys(schema).some((key) => !['anyOf', 'oneOf', ...schemaAnnotations].includes(key)))
    pending('contract_pending', 'Served release union has unsupported validation constraints');
  if (!Array.isArray(children) || children.length > 64)
    pending('contract_pending', 'Served release schema exceeds the bounded alternatives');
  const result = children.flatMap((child) => alternatives(child, depth + 1));
  if (result.length > 64) pending('contract_pending', 'Served release schema exceeds the bounded alternatives');
  return result;
}
function validationSchema(value: unknown, depth = 0, propertyMap = false): unknown {
  if (depth > 48) pending('contract_pending', 'Served release schema exceeds the supported nesting');
  if (Array.isArray(value)) return value.map((child) => validationSchema(child, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => propertyMap || !schemaAnnotations.includes(key))
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
  object(value, 'contract_pending');
  if (!same(validationSchema(value), validationSchema(expected)))
    pending('contract_pending', 'Served release schemas differ from the exact supported profile');
}
function content(value: unknown): unknown {
  return object(
    object(object(value, 'contract_pending').content, 'contract_pending')['application/json'],
    'contract_pending',
  ).schema;
}
function response(operation: JsonObject, status = '200'): unknown {
  return content(object(operation.responses, 'contract_pending')[status]);
}
function required(value: unknown, fields: string[]): void {
  const present = object(value, 'contract_pending').required;
  if (!Array.isArray(present) || !fields.every((field) => present.includes(field)))
    pending('contract_pending', 'Served release schema omits required fields');
}
function checkContract(value: unknown): void {
  const code = 'contract_pending';
  const document = object(value, code);
  if (
    document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1' ||
    object(document.info, code).version !== '0.1.0'
  )
    pending(code, 'Served release contract version is unsupported');
  const schemes = object(object(document.components, code).securitySchemes, code);
  const bearer = object(schemes.bearerAuth, code);
  if (bearer.type !== 'http' || bearer.scheme !== 'bearer')
    pending(code, 'Served release authentication is unsupported');
  const paths = object(document.paths, code);
  const operation = (path: string, method: 'get' | 'post') => {
    const value = object(object(paths[path], code)[method], code);
    const security = value.security ?? document.security;
    if (
      !Array.isArray(security) ||
      !security.length ||
      security.some((branch) => {
        const requirement = object(branch, code);
        return (
          Object.keys(requirement).length !== 1 ||
          !Array.isArray(requirement.bearerAuth) ||
          requirement.bearerAuth.length !== 0
        );
      })
    )
      pending(code, 'Served release operations require bearer authentication');
    return value;
  };
  const me = property(response(operation('/v1/me', 'get')), 'principal');
  required(me, ['id', 'tenantId', 'revision', 'capabilities']);
  const available = alternatives(object(property(me, 'capabilities'), code).items);
  if (
    !requiredCapabilities.every((capability) =>
      available.some(
        (entry) => entry.const === capability || (Array.isArray(entry.enum) && entry.enum.includes(capability)),
      ),
    )
  )
    pending(code, 'Served release authority is unavailable');
  schemaMatches(response(operation('/v1/flights/{id}', 'get')), FlightResponseSchema);
  schemaMatches(response(operation('/v1/flights/{id}/mission', 'get')), FlightMissionResponseSchema);
  schemaMatches(response(operation('/v1/flights/{id}/mission-avoidance', 'get')), MissionAvoidanceResponseSchema);
  schemaMatches(
    response(operation('/v1/flights/{id}/mission-release-findings', 'get')),
    MissionReleaseFindingsResponseSchema,
  );
  schemaMatches(
    response(operation('/v1/flights/{id}/mission-releases/{releaseId}', 'get')),
    MissionReleaseRecordResponseSchema,
  );
  schemaMatches(
    response(operation('/v1/flights/{id}/mission-releases/{releaseId}/validity', 'get')),
    MissionReleaseValidityResponseSchema,
  );
  const submit = operation('/v1/commands', 'post');
  const inherited = object(paths['/v1/commands'], code).parameters;
  if (
    (inherited !== undefined && !Array.isArray(inherited)) ||
    (submit.parameters !== undefined && !Array.isArray(submit.parameters))
  )
    pending(code, 'Served release command parameters are unsupported');
  const parameters = [...(inherited ?? []), ...(submit.parameters ?? [])];
  let idempotencyKeys = 0;
  for (const value of parameters) {
    const parameter = object(value, code);
    if (
      Object.hasOwn(parameter, '$ref') ||
      typeof parameter.name !== 'string' ||
      !['header', 'query', 'path', 'cookie'].includes(String(parameter.in)) ||
      (parameter.required !== undefined && typeof parameter.required !== 'boolean')
    )
      pending(code, 'Served release command parameters are unsupported');
    if (parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key') {
      if (parameter.required !== true) pending(code, 'Served release command requires its idempotency key');
      schemaMatches(parameter.schema, { type: 'string', minLength: 1 });
      idempotencyKeys++;
    } else if (parameter.required === true) {
      pending(code, 'Served release command requires unsupported request parameters');
    }
  }
  if (idempotencyKeys !== 1) pending(code, 'Served release command requires exact idempotency support');
  const request = object(submit.requestBody, code);
  if (request.required !== true) pending(code, 'Served release command requires a JSON body');
  const matches = alternatives(content(request)).filter(
    (branch) => object(property(branch, 'kind'), code).const === 'mission.release',
  );
  if (matches.length !== 1) pending(code, 'Served release command is unavailable or ambiguous');
  schemaMatches(matches[0], MissionReleaseCommandSchema);
  const envelopes = alternatives(response(submit, '201')).filter((entry) => {
    const properties = entry.properties;
    return (
      properties &&
      typeof properties === 'object' &&
      !Array.isArray(properties) &&
      Object.hasOwn(properties, 'command') &&
      Object.hasOwn(properties, 'meta')
    );
  });
  const specific = envelopes.filter((entry) => {
    const kind = property(property(entry, 'command'), 'kind');
    return object(kind, code).const === 'mission.release';
  });
  const supported = specific.length ? specific : envelopes;
  if (supported.length !== 1) pending(code, 'Served release command response is unavailable or ambiguous');
  const envelope = supported[0];
  required(envelope, ['command', 'meta']);
  required(property(envelope, 'command'), ['id', 'kind', 'actorId', 'recordedAt', 'payload']);
}

function principal(value: unknown, plan: MissionReleasePlan, fresh: boolean): Principal {
  const code = 'authority_pending';
  const current = object(value, code);
  if (current.id !== plan.principalId || current.tenantId !== plan.tenantId)
    pending(code, 'The authenticated release principal or tenant differs from the plan');
  text(current.name, code);
  if (!Number.isSafeInteger(current.revision) || Number(current.revision) < (fresh ? 1 : 0))
    pending(code, 'The authenticated release principal revision is unsupported');
  if (current.active === false) pending(code, 'The authenticated release principal is inactive');
  const capabilities = current.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 200 ||
    !capabilities.every((value) => typeof value === 'string')
  )
    pending(code, 'The authenticated release authority is unsupported');
  if (!(fresh ? requiredCapabilities : ['flight:read']).every((capability) => capabilities.includes(capability)))
    pending(code, 'The authenticated principal lacks the required release or read authority');
  return structuredClone(current) as unknown as Principal;
}
function rethrow(error: unknown): never {
  if (error instanceof ReleasePending) throw error;
  if (error instanceof OracleReadError) pending(error.code, 'A required public release read is unavailable');
  return pending('unsupported_response', 'Public release information is malformed or unsupported');
}
export async function checkMissionReleaseAuthority(
  planValue: MissionReleasePlan,
  api: OracleReader,
  fresh = true,
): Promise<Principal> {
  try {
    const plan = validateMissionReleasePlan(planValue);
    if (fresh) checkContract(await api.json<unknown>('/openapi.json'));
    return principal(object(await api.json<unknown>('/v1/me'), 'authority_pending').principal, plan, fresh);
  } catch (error) {
    return rethrow(error);
  }
}

export async function prepareMissionReleaseCommand(
  planValue: MissionReleasePlan,
  api: OracleReader,
  actingPrincipal: Principal,
): Promise<MissionReleaseCommand> {
  try {
    const plan = validateMissionReleasePlan(planValue);
    const current = principal(actingPrincipal, plan, true);
    const path = `/v1/flights/${encodeURIComponent(plan.flightId)}`;
    const flight = await api.json<unknown>(path);
    if (!flightShape(flight)) pending('flight_unavailable', 'The scoped current flight is unsupported');
    if (flight.flight.id !== plan.flightId || flight.flight.aircraft !== plan.aircraftId)
      pending('aircraft_changed', 'The current flight assignment differs from the approved aircraft');
    const missionRead = await api.json<unknown>(`${path}/mission`);
    if (!missionReadShape(missionRead)) pending('mission_unsupported', 'The scoped mission heads are unsupported');
    if (!missionRead.binding || !missionRead.acceptedHead || !missionRead.projectedHead)
      pending('mission_pending', 'The exact accepted and projected mission is required');
    const mission = validateMissionReleaseMission(missionRead.acceptedHead.record, plan);
    if (missionRead.acceptedHead.processing.status !== 'completed')
      pending('mission_pending', 'The approved mission has pending or failed processing');
    validateMissionReleaseMission(missionRead.projectedHead, plan);
    const { missionId, flightId, sourceId, sourceMissionId, aircraftId } = mission;
    if (!same(missionRead.binding, { missionId, flightId, sourceId, sourceMissionId, aircraftId }))
      pending('mission_changed', 'The retained mission binding differs from the approved flight and aircraft');
    const comparison = await api.json<unknown>(`${path}/mission-avoidance`);
    if (!avoidanceReadShape(comparison))
      pending('avoidance_unsupported', 'The current mission comparison is unsupported');
    const { meta, ...preview } = comparison;
    const avoidance = validateMissionReleaseAvoidance(preview, plan);
    for (const candidate of avoidance.candidates) {
      if (
        Date.parse(candidate.interval.start) >= Date.parse(mission.operatingInterval.end) ||
        Date.parse(candidate.interval.end) <= Date.parse(mission.operatingInterval.start)
      )
        pending('avoidance_unsupported', 'A compared control does not overlap the approved mission interval');
    }
    const clock = Math.max(
      utc(flight.meta.computedAt, 'clock_unsupported'),
      utc(missionRead.meta.computedAt, 'clock_unsupported'),
      utc(meta.computedAt, 'clock_unsupported'),
    );
    if (utc(avoidance.evaluatedAt, 'clock_unsupported') > utc(meta.computedAt, 'clock_unsupported'))
      pending('clock_unsupported', 'The comparison clock is ahead of its response clock');
    const findings = await api.json<unknown>(`${path}/mission-release-findings`);
    if (!findingsReadShape(findings) || findings.flightId !== plan.flightId)
      pending('findings_unsupported', 'The open findings for this flight are unsupported');
    if (findings.basis.digest !== plan.expectedFindingsDigest)
      pending('findings_changed', 'The open findings differ from the list reviewed with the plan');
    if (clock >= utc(plan.departureWindow.end, 'plan_invalid'))
      pending('window_expired', 'The authored departure window has expired at the public read clock');
    return validateMissionReleaseCommand(
      { kind: 'mission.release', ...fields(plan), expectedPrincipalRevision: current.revision },
      plan,
    );
  } catch (error) {
    return rethrow(error);
  }
}
