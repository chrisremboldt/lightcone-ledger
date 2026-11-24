import type { Principal } from '@ledger/contracts';
import type { OperationConfig } from '@ledger/simulation-models/operation';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ScenarioConfig } from './scenario.js';

type JsonObject = Record<string, unknown>;
type Role = 'source' | 'actor';
type Tenant = 'alpha' | 'beta';
export interface OperationReadiness {
  apiVersion: '0.1.0';
  contractVersion: 'ledger.demo-contract.1';
  principals: Record<Tenant, Record<Role, Principal>>;
}

export function assertHostedOrdinarySourceTokens(tokens: ScenarioConfig['tokens']): void {
  for (const tenant of ['alpha', 'beta'] as const)
    if (!tokens[tenant].source.startsWith('ledger-service-'))
      fail(`${tenant} ordinary hosted source requires a ledger-service credential`);
}

const requiredCapabilities = {
  source: ['input:write', 'flight:create', 'flight:read', 'order:read'],
  actor: ['input:write', 'flight:read'],
} as const;
const fail = (message: string): never => {
  throw new Error(`World readiness: ${message}`);
};
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} is missing or invalid`);
  return value as JsonObject;
}
function literals(value: unknown): string[] {
  const schema = object(value, 'input kind schema');
  if (typeof schema.const === 'string') return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum.filter((entry): entry is string => typeof entry === 'string');
  const alternatives = schema.anyOf ?? schema.oneOf;
  return Array.isArray(alternatives) ? alternatives.flatMap(literals) : [];
}
function stringProperty(properties: JsonObject, name: string, label: string): void {
  if (object(properties[name], `${label}.${name}`).type !== 'string') fail(`${label}.${name} must accept strings`);
}
function operation(paths: JsonObject, path: string, method: string): JsonObject {
  return object(object(paths[path], path)[method], `${method.toUpperCase()} ${path}`);
}
function requestSchema(endpoint: JsonObject, label: string): JsonObject {
  const body = object(endpoint.requestBody, `${label} request body`);
  const content = object(body.content, `${label} request content`);
  return object(object(content['application/json'], `${label} JSON content`).schema, `${label} JSON schema`);
}
function mutation(paths: JsonObject, path: string, method: string): JsonObject {
  const endpoint = operation(paths, path, method);
  const key = Array.isArray(endpoint.parameters)
    ? endpoint.parameters.find((parameter) => {
        const value = object(parameter, `${path} parameter`);
        return value.in === 'header' && String(value.name).toLowerCase() === 'idempotency-key';
      })
    : undefined;
  if (!key || object(key, `${path} idempotency header`).required !== true)
    fail(`${method.toUpperCase()} ${path} must require Idempotency-Key`);
  return endpoint;
}
function checkFlightSubjects(input: JsonObject): void {
  const validator = new Ajv({ strict: false });
  (addFormats as unknown as (instance: Ajv) => void)(validator);
  let validate: ValidateFunction;
  try {
    validate = validator.compile(input);
  } catch {
    return fail('served /v1/inputs schema cannot validate world inputs');
  }
  const occurredAt = '2026-01-01T00:00:00Z';
  const common = {
    sourceId: 'readiness-probe',
    sourceSessionId: 'readiness-probe',
    occurredAt,
    artifactId: 'readiness-probe',
    fidelity: 'synthetic_contract',
  };
  const telemetry = {
    format: 'ledger.telemetry-segment.1',
    deviceId: 'readiness-probe',
    gatewayId: 'readiness-probe',
    decoderVersion: 'dji-osd.synthetic.1',
    sequenceBasis: 'adapter_capture',
    sessionStartSequence: 0,
    sampleCount: 1,
    firstSequence: 0,
    lastSequence: 0,
    firstOccurredAt: occurredAt,
    lastOccurredAt: occurredAt,
  };
  for (const kind of ['order.revision', 'flight.observation', 'telemetry.segment']) {
    const candidate = { ...common, kind, payload: kind === 'telemetry.segment' ? telemetry : {} };
    if (!validate({ ...candidate, subject: { originationKey: 'readiness-probe' } }))
      fail(`served /v1/inputs schema does not accept the world ${kind} shape`);
    if (validate(candidate)) fail(`served /v1/inputs schema must require subject for ${kind}`);
  }
}
function checkSchema(value: unknown): void {
  const document = object(value, 'served OpenAPI document');
  if (object(document.info, 'OpenAPI info').version !== '0.1.0') fail('served API version must be 0.1.0');
  if (document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1')
    fail('served demo contract version must be ledger.demo-contract.1');
  const paths = object(document.paths, 'OpenAPI paths');
  for (const path of [
    '/v1/me',
    '/v1/flights',
    '/v1/flights/{id}',
    '/v1/flights/{id}/telemetry',
    '/v1/receipts/{id}',
    '/v1/orders',
  ])
    operation(paths, path, 'get');
  const input = requestSchema(mutation(paths, '/v1/inputs', 'post'), '/v1/inputs');
  const properties = object(input.properties, '/v1/inputs properties');
  const kinds = literals(properties.kind);
  for (const kind of ['order.revision', 'flight.observation', 'telemetry.segment'])
    if (!kinds.includes(kind)) fail(`served /v1/inputs schema does not accept ${kind}`);
  for (const field of ['sourceId', 'sourceSessionId', 'artifactId', 'occurredAt'])
    stringProperty(properties, field, '/v1/inputs');
  for (const field of ['sourceId', 'kind', 'occurredAt', 'payload'])
    if (!Array.isArray(input.required) || !input.required.includes(field))
      fail(`served /v1/inputs schema must require ${field}`);
  const subject = object(object(properties.subject, '/v1/inputs subject').properties, '/v1/inputs subject properties');
  for (const field of ['originationKey', 'orderId']) stringProperty(subject, field, '/v1/inputs subject');
  const telemetry = Array.isArray(input.allOf)
    ? input.allOf.find((clause) => {
        const condition = object(clause, 'input condition').if;
        if (!condition) return false;
        const selector = object(object(condition, 'input condition').properties, 'input condition properties');
        return literals(selector.kind).includes('telemetry.segment');
      })
    : undefined;
  if (!telemetry) fail('served /v1/inputs schema lacks its telemetry requirements');
  const then = object(object(telemetry, 'telemetry condition').then, 'telemetry requirements');
  for (const field of ['sourceSessionId', 'artifactId', 'fidelity'])
    if (!Array.isArray(then.required) || !then.required.includes(field)) fail(`telemetry intake must require ${field}`);
  checkFlightSubjects(input);
  const upload = requestSchema(mutation(paths, '/v1/uploads', 'post'), '/v1/uploads');
  const uploadProperties = object(upload.properties, '/v1/uploads properties');
  stringProperty(uploadProperties, 'contentType', '/v1/uploads');
  if (object(uploadProperties.byteLength, '/v1/uploads byteLength').type !== 'integer')
    fail('/v1/uploads must accept an integer byteLength');
  const content = mutation(paths, '/v1/uploads/{id}/content', 'put');
  if (
    !object(object(content.requestBody, 'upload content request').content, 'upload content media')[
      'application/octet-stream'
    ]
  )
    fail('upload content must accept application/octet-stream');
  mutation(paths, '/v1/uploads/{id}/finalize', 'post');
}

export function assertOperationSourceReadiness(
  readiness: OperationReadiness,
  config: Pick<OperationConfig, 'commandLinkEpisode' | 'missionPlan'>,
  ordinaryWork = false,
): void {
  const requireSource = (capability: 'mission:write', grants: 'missionSources', sourceId: string) => {
    for (const tenant of ['alpha', 'beta'] as const) {
      const principal = readiness.principals[tenant].source;
      if (!principal.capabilities.includes(capability)) fail(`${tenant} source requires ${capability}`);
      if (!Array.isArray(principal[grants]) || !principal[grants].includes(sourceId))
        fail(`${tenant} source requires ${sourceId} in ${grants}`);
    }
  };
  // Link reports arrive as link.status observations under the command-link source.
  if (config.commandLinkEpisode || ordinaryWork)
    for (const tenant of ['alpha', 'beta'] as const) {
      const grants = readiness.principals[tenant].source.observationGrants;
      if (
        !Array.isArray(grants) ||
        !grants.some((grant) => grant.sourceId === 'command-link' && grant.observationType === 'link.status')
      )
        fail(`${tenant} source requires a link.status observation grant for command-link`);
    }
  if (config.missionPlan) requireSource('mission:write', 'missionSources', 'mission-planner');
}

export async function checkOperationReadiness(
  config: Pick<ScenarioConfig, 'apiUrl' | 'tokens'>,
  fetcher: typeof fetch = fetch,
): Promise<OperationReadiness> {
  const request = async (path: string, label: string, token?: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return fail(`${label} is unavailable`);
    }
    if (!response.ok) fail(`${label} returned HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      return fail(`${label} returned invalid JSON`);
    }
  };
  checkSchema(await request('/openapi.json', 'GET /openapi.json'));
  const principals = {} as OperationReadiness['principals'];
  await Promise.all(
    (['alpha', 'beta'] as const).map(async (tenant) => {
      const roles = {} as Record<Role, Principal>;
      await Promise.all(
        (['source', 'actor'] as const).map(async (role) => {
          const label = `${tenant} ${role} GET /v1/me`;
          const principal = object(
            object(await request('/v1/me', label, config.tokens[tenant][role]), label).principal,
            `${label} principal`,
          );
          if (
            typeof principal.id !== 'string' ||
            !principal.id ||
            typeof principal.name !== 'string' ||
            !Number.isSafeInteger(principal.revision) ||
            Number(principal.revision) < 0
          )
            fail(`${label} returned an invalid principal identity`);
          if (principal.tenantId !== `tenant-${tenant}`) fail(`${label} must authenticate tenant-${tenant}`);
          if (
            !Array.isArray(principal.capabilities) ||
            principal.capabilities.some((capability) => typeof capability !== 'string')
          )
            fail(`${label} returned invalid capabilities`);
          const capabilities = principal.capabilities as string[];
          const missing = requiredCapabilities[role].filter((capability) => !capabilities.includes(capability));
          if (missing.length) fail(`${tenant} ${role} requires ${missing.join(', ')}`);
          roles[role] = principal as unknown as Principal;
        }),
      );
      if (roles.source.id === roles.actor.id) fail(`${tenant} source and actor must use distinct principal identities`);
      principals[tenant] = roles;
    }),
  );
  return { apiVersion: '0.1.0', contractVersion: 'ledger.demo-contract.1', principals };
}
