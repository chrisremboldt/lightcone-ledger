import type { OrganizationDecisionCommand, Principal } from '@ledger/contracts';
import { AdoptionPending, verifyAdoptionPackReferences, type AdoptionReader } from './pack-adoption-review.js';
import { OracleReadError } from './oracle-api.js';

export interface ReviewPlan {
  version: 1;
  apiUrl: string;
  tenantId: string;
  principalId: string;
  adoption: OrganizationDecisionCommand['adoption'];
  note: string;
  export: boolean;
}
export type ReviewReader = Pick<AdoptionReader, 'json'>;

type JsonObject = Record<string, unknown>;
function pending(code: string, reason: string): never {
  throw new AdoptionPending(code, reason);
}
function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    pending(code, 'Adoption review information has an unsupported object shape');
  return value as JsonObject;
}
function exact(value: JsonObject, keys: string[], code: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    pending(code, 'Adoption review information has missing or unsupported fields');
}
function text(value: unknown, code: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    pending(code, 'Adoption review identity is missing or unsupported');
  return value as string;
}
function integer(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) pending(code, 'Adoption review revision is invalid');
  return value as number;
}
function digest(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) pending(code, 'Adoption review digest is invalid');
  return value as string;
}
function list(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100) pending(code, 'Adoption review list exceeds its supported scope');
  return value as unknown[];
}
function sanitized(error: unknown): never {
  if (error instanceof AdoptionPending) throw error;
  if (error instanceof OracleReadError) pending(error.code, 'A required public adoption review read is unavailable');
  return pending('unsupported_response', 'Public adoption review information is malformed or unsupported');
}

export function validateReviewPlan(value: unknown): ReviewPlan {
  const code = 'plan_invalid';
  const plan = object(value, code);
  exact(plan, ['version', 'apiUrl', 'tenantId', 'principalId', 'adoption', 'note', 'export'], code);
  if (plan.version !== 1 || typeof plan.export !== 'boolean')
    pending(code, 'Adoption review plan version or export choice is unsupported');
  try {
    const url = new URL(text(plan.apiUrl, code, 2048));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      pending(code, 'Adoption review API must be an HTTP(S) origin without credentials');
  } catch {
    pending(code, 'Adoption review API must be an HTTP(S) origin without credentials');
  }
  text(plan.tenantId, code);
  text(plan.principalId, code);
  if (
    typeof plan.note !== 'string' ||
    !plan.note.trim() ||
    plan.note.length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plan.note)
  )
    pending(code, 'Adoption review note is missing or unsupported');
  const adoption = object(plan.adoption, code);
  exact(adoption, ['id', 'acceptedRevision', 'pack'], code);
  text(adoption.id, code);
  integer(adoption.acceptedRevision, code, 1);
  const pack = object(adoption.pack, code);
  exact(pack, ['packId', 'version', 'digest'], code);
  text(pack.packId, code);
  integer(pack.version, code, 1);
  digest(pack.digest, code);
  return structuredClone(plan) as unknown as ReviewPlan;
}

function property(schema: unknown, name: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const properties = (schema as JsonObject).properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as JsonObject)[name]
    : undefined;
}
function literals(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const schema = value as JsonObject;
  if (typeof schema.const === 'string') return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum.filter((entry): entry is string => typeof entry === 'string');
  const alternatives = schema.anyOf ?? schema.oneOf;
  return Array.isArray(alternatives) ? alternatives.flatMap(literals) : [];
}
function hasLiteral(schema: unknown, name: string, value: string): boolean {
  return literals(property(schema, name)).includes(value);
}
function required(schema: unknown, keys: string[]): void {
  const code = 'contract_pending';
  const fields = list(object(schema, code).required, code);
  if (!keys.every((key) => fields.includes(key))) pending(code, 'Served adoption review schema lacks required fields');
}
function contentSchema(value: unknown): unknown {
  const code = 'contract_pending';
  return object(object(object(value, code).content, code)['application/json'], code).schema;
}
function responseSchema(operation: JsonObject, status: string): unknown {
  return contentSchema(object(operation.responses, 'contract_pending')[status]);
}
function idempotency(operation: JsonObject): void {
  const found = list(operation.parameters, 'contract_pending').some((value) => {
    const parameter = object(value, 'contract_pending');
    return (
      parameter.in === 'header' &&
      String(parameter.name).toLowerCase() === 'idempotency-key' &&
      parameter.required === true
    );
  });
  if (!found) pending('contract_pending', 'Served adoption review mutation lacks required idempotency');
}
function capabilities(plan: ReviewPlan): string[] {
  return ['flight:read', 'decision:write', ...(plan.export ? ['evidence:read'] : [])];
}
function checkContract(value: unknown, plan: ReviewPlan): void {
  const code = 'contract_pending';
  const document = object(value, code);
  if (
    document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1' ||
    object(document.info, code).version !== '0.1.0'
  )
    pending(code, 'Served adoption review contract version is unavailable');
  const paths = object(document.paths, code);
  const operation = (path: string, method: string) => object(object(paths[path], code)[method], code);
  const me = responseSchema(operation('/v1/me', 'get'), '200');
  const granted = literals(object(property(property(me, 'principal'), 'capabilities'), code).items);
  if (!capabilities(plan).every((capability) => granted.includes(capability)))
    pending(code, 'Served capability schema lacks adoption review authority');
  operation('/v1/organization/coverage', 'get');
  operation('/v1/organization/decisions', 'get');
  const commands = operation('/v1/commands', 'post');
  idempotency(commands);
  const schema = object(contentSchema(commands.requestBody), code);
  const review = list(schema.anyOf ?? schema.oneOf, code).find(
    (variant) =>
      hasLiteral(variant, 'kind', 'decision.record') &&
      hasLiteral(property(variant, 'subject'), 'kind', 'organization') &&
      hasLiteral(property(variant, 'decision'), 'kind', 'adoption.review'),
  );
  if (!review) pending(code, 'Served commands lack the organization adoption-review variant');
  required(review, [
    'kind',
    'subject',
    'expectedRevision',
    'inputCut',
    'expectedDependencyBasis',
    'adoption',
    'decision',
  ]);
  required(property(review, 'inputCut'), ['streams', 'basisRevision', 'principalRevision']);
  required(property(review, 'adoption'), ['id', 'acceptedRevision', 'pack']);
  required(property(property(review, 'adoption'), 'pack'), ['packId', 'version', 'digest']);
  required(property(review, 'decision'), ['kind', 'note']);
  if (!plan.export) return;
  const create = operation('/v1/subject-exports', 'post');
  idempotency(create);
  const input = contentSchema(create.requestBody);
  required(input, ['subject', 'decisionId', 'scope']);
  if (
    !hasLiteral(property(input, 'subject'), 'kind', 'organization') ||
    !hasLiteral(input, 'scope', 'whole_tenant_prefixes')
  )
    pending(code, 'Served subject export does not support organization tenant prefixes');
  const record = property(responseSchema(create, '201'), 'record');
  required(record, [
    'id',
    'tenantId',
    'format',
    'subject',
    'decisionId',
    'scope',
    'byteLength',
    'bundleSha256',
    'manifestDigest',
  ]);
  if (
    !hasLiteral(record, 'format', 'ledger.subject-evidence.2') ||
    !hasLiteral(record, 'scope', 'whole_tenant_prefixes') ||
    !hasLiteral(property(record, 'subject'), 'kind', 'organization')
  )
    pending(code, 'Served subject export record is not the supported v2 organization format');
  operation('/v1/subject-exports/{id}', 'get');
  const bundle = responseSchema(operation('/v1/subject-exports/{id}/content', 'get'), '200');
  required(bundle, ['format', 'manifest', 'manifestDigest', 'decision', 'actor', 'adoption', 'ruleSources', 'cuts']);
  if (
    !hasLiteral(bundle, 'format', 'ledger.subject-evidence.2') ||
    !hasLiteral(property(bundle, 'manifest'), 'scope', 'whole_tenant_prefixes') ||
    !hasLiteral(property(property(bundle, 'manifest'), 'subject'), 'kind', 'organization')
  )
    pending(code, 'Served subject download is not the supported v2 organization format');
}

export async function checkReviewAuthority(plan: ReviewPlan, api: ReviewReader): Promise<Principal> {
  try {
    const checked = validateReviewPlan(plan);
    checkContract(await api.json<unknown>('/openapi.json'), checked);
    const principal = object(
      object(await api.json<unknown>('/v1/me'), 'authority_pending').principal,
      'authority_pending',
    );
    const granted = list(principal.capabilities, 'authority_pending');
    if (
      principal.id !== checked.principalId ||
      principal.tenantId !== checked.tenantId ||
      typeof principal.name !== 'string' ||
      granted.some((entry) => typeof entry !== 'string') ||
      !capabilities(checked).every((capability) => granted.includes(capability))
    )
      pending('authority_pending', 'Authenticated principal or tenant lacks the pinned adoption review authority');
    integer(principal.revision, 'authority_pending');
    return principal as unknown as Principal;
  } catch (error) {
    return sanitized(error);
  }
}

function organization(value: unknown, tenantId: string): { shown: JsonObject; revision: number } {
  const code = 'organization_basis';
  const shown = object(value, code);
  const target = object(shown.organization, code);
  const revision = integer(target.revision, code);
  if (
    target.id !== `organization:${tenantId}` ||
    typeof target.label !== 'string' ||
    integer(target.projectedRevision, code) > revision ||
    shown.limit !== 100 ||
    typeof shown.hasOlder !== 'boolean'
  )
    pending(code, 'Displayed organization differs from the pinned review scope or window');
  return { shown, revision };
}
function snapshotReferences(value: unknown): Array<{ id: string; version: number; digest: string }> {
  return list(value, 'adoption_unavailable').map((value) => {
    const ref = object(value, 'adoption_unavailable');
    return {
      id: text(ref.id, 'adoption_unavailable'),
      version: integer(ref.version, 'adoption_unavailable', 1),
      digest: digest(ref.digest, 'adoption_unavailable'),
    };
  });
}

export async function reviewShownAdoption(plan: ReviewPlan, api: ReviewReader): Promise<OrganizationDecisionCommand> {
  try {
    const checked = validateReviewPlan(plan);
    const principal = await checkReviewAuthority(checked, api);
    const { shown: coverage, revision: coverageRevision } = organization(
      await api.json<unknown>('/v1/organization/coverage'),
      checked.tenantId,
    );
    const matches = list(coverage.adoptions, 'adoption_unavailable')
      .map((value) => object(value, 'adoption_unavailable'))
      .filter((value) => value.id === checked.adoption.id);
    if (!matches.length)
      pending(
        'adoption_unavailable',
        'The exact retained adoption is outside the displayed coverage window or unavailable',
      );
    if (matches.length !== 1) pending('adoption_mismatch', 'Displayed coverage repeats the selected adoption');
    const adoption = matches[0]!;
    const scope = object(adoption.scope, 'adoption_mismatch');
    if (
      adoption.organizationId !== `organization:${checked.tenantId}` ||
      adoption.acceptedRevision !== checked.adoption.acceptedRevision ||
      checked.adoption.acceptedRevision > coverageRevision ||
      scope.kind !== 'organization' ||
      scope.organizationId !== adoption.organizationId
    )
      pending('adoption_mismatch', 'Displayed adoption differs from the pinned organization citation');
    const pack = object(adoption.pack, 'adoption_unavailable');
    verifyAdoptionPackReferences(
      {
        ...checked.adoption.pack,
        leaves: snapshotReferences(pack.leaves),
        bindings: snapshotReferences(pack.bindings),
      },
      pack,
    );
    const { shown, revision } = organization(await api.json<unknown>('/v1/organization/decisions'), checked.tenantId);
    if (revision < coverageRevision)
      pending('organization_basis', 'Displayed review basis predates the selected adoption coverage');
    list(shown.decisions, 'organization_basis');
    const meta = object(shown.meta, 'organization_basis');
    const cut = object(meta.inputCut, 'organization_basis');
    exact(cut, ['streams', 'basisRevision', 'principalRevision'], 'organization_basis');
    if (cut.basisRevision !== revision || cut.principalRevision !== principal.revision)
      pending(
        'organization_basis',
        'Displayed review basis differs from the current organization or principal revision',
      );
    const streams = object(cut.streams, 'organization_basis');
    for (const [id, sequence] of Object.entries(streams)) {
      text(id, 'organization_basis');
      integer(sequence, 'organization_basis');
    }
    return {
      kind: 'decision.record',
      subject: { kind: 'organization' },
      expectedRevision: revision,
      inputCut: {
        streams: structuredClone(streams) as Record<string, number>,
        basisRevision: revision,
        principalRevision: principal.revision,
      },
      expectedDependencyBasis: digest(meta.dependencyBasis, 'organization_basis'),
      adoption: structuredClone(checked.adoption),
      decision: { kind: 'adoption.review', note: checked.note },
    };
  } catch (error) {
    return sanitized(error);
  }
}
