import type { OrganizationCoverageResponse, PackAdoptionCommand, Principal, RulePackVersion } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { c2CompanyReferences, sameC2Reference } from './adoption-selection-validation.js';
import { OracleReadError } from './oracle-api.js';

export interface AdoptionPlan {
  version: 1;
  apiUrl: string;
  tenantId: string;
  principalId: string;
  pack: PackAdoptionCommand['pack'];
  effectiveInterval: PackAdoptionCommand['effectiveInterval'];
  note: string;
  mode: PackAdoptionCommand['mode'];
}
export interface AdoptionReader {
  json<T>(path: string): Promise<T>;
  bytes(path: string): Promise<Uint8Array>;
}
export class AdoptionPending extends Error {
  constructor(
    public readonly code: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'AdoptionPending';
  }
}

type JsonObject = Record<string, unknown>;
type Reference = { id: string; version: number; digest: string };
const dependencies = [
  'flight.activity',
  'flight.scheduledEnd',
  'flight.observations',
  'authorization.status',
  'authorization.scope',
  'clock.wall',
];
const observationFields = ['activity', 'state', 'phase', 'landingTime', 'landedAt'];
const authorizationFields = [
  'authorizationId',
  'status',
  'authorizationRecord.startTime',
  'authorizationRecord.endTime',
  'callback.startTime',
  'callback.duration',
];
const commandLinkFields = [
  'sourceId',
  'sourceSessionId',
  'occurredAt',
  'subject.flightId',
  'payload.sourceEventId',
  'payload.incidentId',
  'payload.aircraftId',
  'payload.status',
];
const commandLinkDependencies = ['command-link.reports', 'command-link.scope', 'clock.wall'];
const commandLinkBindingId = 'ledger.command-link-status';
const commandLinkPackDigest = '46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188';
const fail = (code: string, reason: string): never => {
  throw new AdoptionPending(code, reason);
};
function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail(code, 'Adoption information has an unsupported object shape');
  return value as JsonObject;
}
function exact(value: JsonObject, keys: string[], code: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail(code, 'Adoption information has missing or unsupported fields');
}
function text(value: unknown, code: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    fail(code, 'Adoption text or identity is missing or unsupported');
  return value as string;
}
function integer(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(code, 'Adoption revision or offset is invalid');
  return value as number;
}
function digest(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(code, 'Adoption content digest is invalid');
  return value as string;
}
function utc(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    fail(code, 'Adoption time must be explicit UTC with millisecond precision');
  const time = Date.parse(value as string);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code, 'Adoption time is invalid');
  return value as string;
}
function list(value: unknown, code: string, maximum = 100): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(code, 'Adoption list exceeds the supported scope');
  return value as unknown[];
}
function reference(value: unknown, code: string, strict = false): Reference {
  const entry = object(value, code);
  if (strict) exact(entry, ['id', 'version', 'digest'], code);
  return { id: text(entry.id, code), version: integer(entry.version, code, 1), digest: digest(entry.digest, code) };
}
function references(value: unknown, code: string, strict = false): Reference[] {
  const entries = list(value, code).map((entry) => reference(entry, code, strict));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    fail(code, 'Adoption references contain duplicate identities');
  return entries;
}
function contentDigest(value: JsonObject, code: string): void {
  const { digest: retained, ...content } = value;
  if (digest(retained, code) !== canonicalDigest(content))
    fail(code, 'Retained adoption content does not match its digest');
}
function matchingReferences(configured: Reference[], retained: Reference[]): boolean {
  const ordered = (values: Reference[]) => values.map((value) => canonicalDigest(value)).sort();
  return canonicalDigest(ordered(configured)) === canonicalDigest(ordered(retained));
}
function checkCommandLinkPack(pack: JsonObject, code: string): void {
  const leaves = list(pack.leaves, code).map((entry) => object(entry, code));
  const bindings = list(pack.bindings, code).map((entry) => object(entry, code));
  // Only the retained built-in review reads the dedicated command-link binding; from pack version 5 the review is a
  // checked rule reading link.status observations, reviewed like any checked rule.
  const commandLink =
    (pack.packId === 'ledger.demo-procedures' && pack.version === 3) ||
    bindings.some((binding) => binding.id === commandLinkBindingId || binding.inputKind === 'command-link.status');
  if (!commandLink) return;
  if (
    pack.packId !== 'ledger.demo-procedures' ||
    pack.version !== 3 ||
    pack.digest !== commandLinkPackDigest ||
    !leaves.some((leaf) => sameC2Reference(leaf, c2CompanyReferences.leaf)) ||
    !bindings.some((binding) => binding.id === commandLinkBindingId && binding.version === 1)
  )
    fail(code, 'Command-link adoption requires the exact reviewed company catalog version 3');
}
function rethrow(error: unknown): never {
  if (error instanceof AdoptionPending) throw error;
  if (error instanceof OracleReadError) fail(error.code, 'A required public adoption read is unavailable');
  return fail('unsupported_response', 'Public adoption information is malformed or unsupported');
}

export function validateAdoptionPlan(value: unknown): AdoptionPlan {
  const code = 'plan_invalid';
  const plan = object(value, code);
  exact(plan, ['version', 'apiUrl', 'tenantId', 'principalId', 'pack', 'effectiveInterval', 'note', 'mode'], code);
  if (plan.mode !== 'shadow' && plan.mode !== 'active') fail(code, 'Adoption mode must be shadow or active');
  if (plan.version !== 1) fail(code, 'Adoption plan version is unsupported');
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
      fail(code, 'Adoption API must be an HTTP(S) origin without credentials');
  } catch {
    fail(code, 'Adoption API must be an HTTP(S) origin without credentials');
  }
  text(plan.tenantId, code);
  text(plan.principalId, code);
  if (
    typeof plan.note !== 'string' ||
    !plan.note.trim() ||
    plan.note.length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plan.note)
  )
    fail(code, 'Adoption note is missing or unsupported');
  const pack = object(plan.pack, code);
  exact(pack, ['packId', 'version', 'digest', 'leaves', 'bindings'], code);
  text(pack.packId, code);
  integer(pack.version, code, 1);
  digest(pack.digest, code);
  references(pack.leaves, code, true);
  references(pack.bindings, code, true);
  checkCommandLinkPack(pack, code);
  const interval = object(plan.effectiveInterval, code);
  exact(interval, ['start', 'end'], code);
  if (utc(interval.end, code) <= utc(interval.start, code)) fail(code, 'Adoption interval must have positive duration');
  return structuredClone(plan) as unknown as AdoptionPlan;
}

function literals(value: unknown): string[] {
  const schema = object(value, 'contract_pending');
  if (typeof schema.const === 'string') return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum.filter((entry): entry is string => typeof entry === 'string');
  const alternatives = schema.anyOf ?? schema.oneOf;
  return Array.isArray(alternatives) ? alternatives.flatMap(literals) : [];
}
function schemaContent(value: unknown): JsonObject {
  return object(
    object(object(value, 'contract_pending').content, 'contract_pending')['application/json'],
    'contract_pending',
  );
}
function checkContract(value: unknown): void {
  const code = 'contract_pending';
  const document = object(value, code);
  if (
    document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1' ||
    object(document.info, code).version !== '0.1.0'
  )
    fail(code, 'Served adoption contract version is unavailable');
  const paths = object(document.paths, code);
  for (const path of [
    '/v1/me',
    '/v1/organization/coverage',
    '/v1/rule-packs/{packId}/versions/{version}',
    '/v1/rule-sources/{sourceId}/content',
  ])
    object(object(paths[path], code).get, code);
  const me = object(object(paths['/v1/me'], code).get, code);
  const response = object(object(me.responses, code)['200'], code);
  const principal = object(object(object(schemaContent(response).schema, code).properties, code).principal, code);
  const capabilities = object(principal.properties, code).capabilities;
  const available = literals(object(capabilities, code).items);
  if (!['pack:adopt', 'flight:read'].every((capability) => available.includes(capability)))
    fail(code, 'Served capability schema lacks adoption authority');
  const command = object(object(paths['/v1/commands'], code).post, code);
  if (
    !Array.isArray(command.parameters) ||
    !command.parameters.some((entry) => {
      const parameter = object(entry, code);
      return (
        parameter.in === 'header' &&
        String(parameter.name).toLowerCase() === 'idempotency-key' &&
        parameter.required === true
      );
    })
  )
    fail(code, 'Served commands do not require an idempotency key');
  const schema = object(schemaContent(command.requestBody).schema, code);
  const alternatives = list(schema.anyOf ?? schema.oneOf, code);
  const adoption = alternatives
    .map((entry) => object(entry, code))
    .find((entry) => literals(object(entry.properties, code).kind).includes('rule-pack.adopt'));
  if (!adoption) return fail(code, 'Served commands do not support organization pack adoption');
  const fields = [
    'kind',
    'expectedRevision',
    'inputCut',
    'expectedDependencyBasis',
    'pack',
    'effectiveInterval',
    'note',
    'mode',
  ];
  const required = list(adoption.required, code);
  if (!fields.every((field) => required.includes(field)))
    fail(code, 'Served adoption command lacks its retained-basis requirements');
  const properties = object(adoption.properties, code);
  const cut = object(properties.inputCut, code);
  const cutRequired = list(cut.required, code);
  if (!['streams', 'basisRevision', 'principalRevision'].every((field) => cutRequired.includes(field)))
    fail(code, 'Served adoption command lacks its displayed organization cut');
}

export async function checkAdoptionAuthority(plan: AdoptionPlan, api: AdoptionReader): Promise<Principal> {
  try {
    const checked = validateAdoptionPlan(plan);
    checkContract(await api.json<unknown>('/openapi.json'));
    const response = object(await api.json<unknown>('/v1/me'), 'authority_pending');
    const principal = object(response.principal, 'authority_pending');
    if (principal.id !== checked.principalId || principal.tenantId !== checked.tenantId)
      fail('authority_pending', 'Authenticated adoption principal or tenant differs from the pinned plan');
    integer(principal.revision, 'authority_pending');
    const capabilities = list(principal.capabilities, 'authority_pending');
    if (
      typeof principal.name !== 'string' ||
      capabilities.some((entry) => typeof entry !== 'string') ||
      !['pack:adopt', 'flight:read'].every((capability) => capabilities.includes(capability))
    )
      fail('authority_pending', 'Authenticated principal lacks supported adoption authority');
    return principal as unknown as Principal;
  } catch (error) {
    return rethrow(error);
  }
}

function checkBinding(value: unknown): JsonObject {
  const code = 'pack_pending';
  const binding = object(value, code);
  reference(binding, code);
  const flight = binding.inputKind === 'flight.observation';
  const authorization = binding.inputKind === 'airspace.status';
  const commandLink = binding.inputKind === 'command-link.status';
  if (!flight && !authorization && !commandLink) fail(code, 'Catalog source binding is unsupported');
  exact(
    binding,
    [
      'id',
      'version',
      'inputKind',
      'supportedFields',
      'correctionHandling',
      'digest',
      ...(authorization ? ['intervalHandling', 'callbackDurationUnit'] : []),
    ],
    code,
  );
  if (
    binding.correctionHandling !==
      (commandLink ? 'immutable_receipts_selected_by_caller' : 'active_claims_selected_by_caller') ||
    (authorization &&
      (binding.intervalHandling !== 'reported_utc_half_open_required' || binding.callbackDurationUnit !== 'minute'))
  )
    fail(code, 'Catalog source binding semantics are unsupported');
  const fields = commandLink ? commandLinkFields : flight ? observationFields : authorizationFields;
  if (list(binding.supportedFields, code).some((entry) => typeof entry !== 'string' || !fields.includes(entry)))
    fail(code, 'Catalog source binding fields are unsupported');
  if (
    commandLink &&
    (binding.id !== commandLinkBindingId ||
      binding.version !== 1 ||
      canonicalDigest(binding.supportedFields) !== canonicalDigest(commandLinkFields))
  )
    fail(code, 'Command-link source binding version or fields are unsupported');
  contentDigest(binding, code);
  return binding;
}

export function verifyAdoptionPackReferences(expected: PackAdoptionCommand['pack'], value: unknown): RulePackVersion {
  try {
    const code = 'pack_pending';
    const pack = object(value, code);
    exact(pack, ['packId', 'version', 'title', 'status', 'review', 'adopted', 'bindings', 'leaves', 'digest'], code);
    if (
      pack.packId !== expected.packId ||
      pack.version !== expected.version ||
      pack.digest !== expected.digest ||
      pack.status !== 'draft' ||
      pack.review !== 'ai_drafted' ||
      pack.adopted !== false
    )
      fail(code, 'Exact configured draft pack version or digest is unavailable');
    text(pack.title, code);
    const leaves = list(pack.leaves, code).map((entry) => object(entry, code));
    const bindings = list(pack.bindings, code).map(checkBinding);
    checkCommandLinkPack(pack, code);
    if (
      !matchingReferences(expected.leaves, references(leaves, code)) ||
      !matchingReferences(expected.bindings, references(bindings, code))
    )
      fail(code, 'Configured leaf or binding references differ from the exact catalog version');
    for (const leaf of leaves) contentDigest(leaf, code);
    contentDigest(pack, code);
    return structuredClone(pack) as unknown as RulePackVersion;
  } catch (error) {
    return rethrow(error);
  }
}

async function checkSources(leaves: JsonObject[], bindings: JsonObject[], api: AdoptionReader): Promise<void> {
  const documents = new Map<string, { commitment: string; bytes: Uint8Array }>();
  for (const leaf of leaves) {
    const code = 'source_pending';
    const automated = leaf.coverage === 'automated';
    if (!automated && leaf.coverage !== 'manual' && leaf.coverage !== 'unsupported')
      fail(code, 'Catalog coverage is unsupported');
    // A checked rule runs on the generic evaluator: no binding, and the registry has verified its shape.
    const checkedRule = automated && 'check' in leaf && 'reads' in leaf;
    if (!checkedRule)
      exact(
        leaf,
        [
          'id',
          'version',
          'title',
          'source',
          'review',
          'adopted',
          'dependencies',
          'coverage',
          'digest',
          ...(automated ? ['bindingId', 'bindingVersion', 'bindingDigest'] : []),
        ],
        code,
      );
    text(leaf.title, code);
    if (leaf.review !== 'ai_drafted' || leaf.adopted !== false) fail(code, 'Catalog review scope is unsupported');
    const binding =
      automated && !checkedRule
        ? bindings.find(
            (entry) =>
              entry.id === leaf.bindingId &&
              entry.version === leaf.bindingVersion &&
              entry.digest === leaf.bindingDigest,
          )
        : undefined;
    if (automated && !checkedRule && !binding)
      fail(code, 'Catalog leaf does not identify an exact available source binding');
    const commandLink = binding?.inputKind === 'command-link.status';
    const declared = checkedRule ? [] : list(leaf.dependencies, code);
    const supportedDependencies = commandLink ? commandLinkDependencies : dependencies;
    if (
      declared.some((entry) => typeof entry !== 'string' || !supportedDependencies.includes(entry)) ||
      (!automated && declared.length)
    )
      fail(code, 'Catalog dependencies are unsupported');
    if (commandLink && (leaf.version !== 1 || canonicalDigest(declared) !== canonicalDigest(commandLinkDependencies)))
      fail(code, 'Command-link procedure version or dependencies are unsupported');
    const source = object(leaf.source, code);
    const procedure = source.kind === 'operator_procedure';
    const retained = source.kind === 'proposed_regulation' || source.kind === 'regulation';
    if (checkedRule ? !procedure && !retained : automated ? !procedure : !retained)
      fail(code, 'Catalog source scope is unsupported');
    exact(
      source,
      ['kind', 'reference', 'text', 'encoding', 'byteLength', 'sha256', 'textSpan', ...(procedure ? [] : ['document'])],
      code,
    );
    text(source.reference, code);
    if (source.encoding !== 'utf-8' || typeof source.text !== 'string')
      return fail(code, 'Catalog source encoding is unsupported');
    const bytes = Buffer.from(source.text, 'utf8');
    if (
      new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== source.text ||
      integer(source.byteLength, code) !== bytes.length ||
      digest(source.sha256, code) !== sha256(bytes)
    )
      fail(code, 'Catalog source bytes differ from their retained commitment');
    const span = object(source.textSpan, code);
    exact(span, ['start', 'end', 'unit', ...(procedure ? [] : ['sourceId'])], code);
    const start = integer(span.start, code);
    const end = integer(span.end, code);
    if (span.unit !== 'utf8_byte' || end < start) fail(code, 'Catalog source span is unsupported');
    if (procedure) {
      if (end > bytes.length) fail(code, 'Procedure span exceeds its retained source text');
      if (commandLink && (source.reference !== 'ledger.demo-procedures.3' || start !== 0 || end !== bytes.length))
        fail(code, 'Command-link procedure must retain the complete reviewed source span');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
    } else {
      const document = object(source.document, code);
      exact(document, ['sourceId', 'url', 'sha256', 'byteLength', 'contentType', 'readPath'], code);
      const sourceId = text(document.sourceId, code);
      const path = `/v1/rule-sources/${encodeURIComponent(sourceId)}/content`;
      if (
        span.sourceId !== sourceId ||
        document.readPath !== path ||
        !['text/html; charset=utf-8', 'application/xml; charset=utf-8'].includes(String(document.contentType))
      )
        fail(code, 'Regulatory source must use its retained API document');
      text(document.url, code, 2048);
      const length = integer(document.byteLength, code, 1);
      digest(document.sha256, code);
      const commitment = canonicalDigest(document);
      let retained = documents.get(sourceId);
      if (!retained) {
        const original = await api.bytes(path);
        if (original.byteLength !== length || sha256(original) !== document.sha256)
          fail(code, 'Retained regulatory document differs from its content commitment');
        retained = { commitment, bytes: original };
        documents.set(sourceId, retained);
      }
      if (
        retained.commitment !== commitment ||
        end > retained.bytes.byteLength ||
        !bytes.equals(retained.bytes.subarray(start, end))
      )
        fail(code, 'Regulatory source span differs from its retained document bytes');
    }
    contentDigest(leaf, code);
  }
}

export async function reviewAdoption(
  plan: AdoptionPlan,
  api: AdoptionReader,
): Promise<{ principal: Principal; coverage: OrganizationCoverageResponse; command: PackAdoptionCommand }> {
  try {
    const checked = validateAdoptionPlan(plan);
    const principal = await checkAdoptionAuthority(checked, api);
    const response = object(
      await api.json<unknown>(
        `/v1/rule-packs/${encodeURIComponent(checked.pack.packId)}/versions/${checked.pack.version}`,
      ),
      'pack_pending',
    );
    const pack = verifyAdoptionPackReferences(checked.pack, response.pack);
    const leaves = pack.leaves.map((entry) => object(entry, 'pack_pending'));
    const bindings = pack.bindings.map((entry) => object(entry, 'pack_pending'));
    await checkSources(leaves, bindings, api);
    const coverage = await api.json<OrganizationCoverageResponse>('/v1/organization/coverage');
    const shown = object(coverage, 'organization_basis');
    const organization = object(shown.organization, 'organization_basis');
    const revision = integer(organization.revision, 'organization_basis');
    if (
      organization.id !== `organization:${checked.tenantId}` ||
      typeof organization.label !== 'string' ||
      integer(organization.projectedRevision, 'organization_basis') > revision
    )
      fail('organization_basis', 'Displayed organization differs from the authenticated adoption scope');
    utc(shown.asOf, 'organization_basis');
    list(shown.adoptions, 'organization_basis');
    if (shown.limit !== 100 || typeof shown.hasOlder !== 'boolean')
      fail('organization_basis', 'Organization coverage window is unsupported');
    const meta = object(shown.meta, 'organization_basis');
    const cut = object(meta.inputCut, 'organization_basis');
    exact(cut, ['streams', 'basisRevision', 'principalRevision'], 'organization_basis');
    if (cut.basisRevision !== revision || cut.principalRevision !== principal.revision)
      fail('organization_basis', 'Displayed organization cut or principal revision differs from its authority');
    const streams = object(cut.streams, 'organization_basis');
    for (const [id, sequence] of Object.entries(streams)) {
      text(id, 'organization_basis');
      integer(sequence, 'organization_basis');
    }
    const token = digest(meta.dependencyBasis, 'organization_basis');
    return {
      principal,
      coverage,
      command: {
        kind: 'rule-pack.adopt',
        expectedRevision: revision,
        inputCut: {
          streams: structuredClone(streams) as Record<string, number>,
          basisRevision: revision,
          principalRevision: principal.revision,
        },
        expectedDependencyBasis: token,
        pack: structuredClone(checked.pack),
        effectiveInterval: structuredClone(checked.effectiveInterval),
        note: checked.note,
        mode: checked.mode,
      },
    };
  } catch (error) {
    return rethrow(error);
  }
}
