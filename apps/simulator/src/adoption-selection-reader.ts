import type { FlightRuleSelectionConvergence, FlightRuleSelectionRecord } from '@ledger/contracts';
import type { OracleReader } from './attempt-oracle.js';
import { retainedAcceptedAdoption } from './pack-adoption-actor.js';
import { readAdoptionJournal } from './pack-adoption-journal.js';
import { AdoptionPending, validateAdoptionPlan, type AdoptionPlan } from './pack-adoption-review.js';
import { OracleReadError } from './oracle-api.js';
import { c2SelectionExecutionProfile, validateAdoptionSelection } from './adoption-selection-validation.js';

export interface AdoptionSelectionTarget {
  plan: AdoptionPlan;
  flightId: string;
  adoptionId: string;
  acceptedRevision: number;
}

export interface AdoptionSelectionResult {
  kind: 'flight-rule-selection';
  status: 'match' | 'pending' | 'unverifiable';
  code: string;
  reason: string;
  flightId: string;
  adoptionId?: string;
  acceptedRevision?: number;
  asOf?: string;
  convergence?: FlightRuleSelectionConvergence;
  execution?: FlightRuleSelectionRecord['execution'];
  retained?: Pick<
    FlightRuleSelectionRecord,
    | 'id'
    | 'clock'
    | 'selection'
    | 'adoptionRevision'
    | 'projectedAdoptionRevision'
    | 'nextBoundary'
    | 'selectionDigest'
    | 'dependencyBasis'
  >;
  usage?: { requests: number; bytes: number };
}

class UnsupportedSelectionRead extends Error {}
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function schema(value: unknown): JsonObject {
  if (!object(value)) throw new UnsupportedSelectionRead('The served selection read schema is unsupported');
  return value;
}
function schemaAlternatives(value: unknown, depth = 0): JsonObject[] {
  if (depth > 8) throw new UnsupportedSelectionRead('The served selection schema union is too deep');
  const entry = schema(value);
  if (Object.hasOwn(entry, '$ref') || Object.hasOwn(entry, 'allOf'))
    throw new UnsupportedSelectionRead('The served selection schema uses unsupported references or composition');
  const unions = ['anyOf', 'oneOf'].filter((key) => Object.hasOwn(entry, key));
  if (!unions.length) return [entry];
  const annotations = ['title', 'description', '$comment', 'examples', 'default'];
  const choices = entry[unions[0]!];
  if (
    unions.length !== 1 ||
    Object.keys(entry).some((key) => key !== unions[0] && !annotations.includes(key)) ||
    !Array.isArray(choices) ||
    !choices.length ||
    choices.length > 32
  )
    throw new UnsupportedSelectionRead('The served selection schema union is malformed or ambiguous');
  return choices.flatMap((choice) => schemaAlternatives(choice, depth + 1));
}
function literals(value: unknown): string[] {
  return schemaAlternatives(value).flatMap((entry) =>
    typeof entry.const === 'string'
      ? [entry.const]
      : Array.isArray(entry.enum)
        ? entry.enum.filter((choice): choice is string => typeof choice === 'string')
        : [],
  );
}
function exactLiterals(value: unknown, expected: string[]): boolean {
  return JSON.stringify(literals(value).sort()) === JSON.stringify([...expected].sort());
}
function objectProperties(value: unknown, fields: string[]): JsonObject {
  const entry = schema(value);
  const properties = schema(entry.properties);
  if (
    entry.type !== 'object' ||
    entry.additionalProperties !== false ||
    !Array.isArray(entry.required) ||
    JSON.stringify([...entry.required].sort()) !== JSON.stringify([...fields].sort()) ||
    JSON.stringify(Object.keys(properties).sort()) !== JSON.stringify([...fields].sort())
  )
    throw new UnsupportedSelectionRead('The served selection execution shape is unsupported');
  return properties;
}
function checkSelectionBranch(record: JsonObject, version: string): void {
  const properties = schema(record.properties);
  const required = record.required;
  if (
    record.type !== 'object' ||
    record.additionalProperties !== false ||
    !Array.isArray(required) ||
    !['version', 'execution'].every((field) => required.includes(field)) ||
    !exactLiterals(properties.version, [version])
  )
    throw new UnsupportedSelectionRead('The served selection record discriminator is unsupported');
  const versionTwo = version === 'flight.rule-selection.2';
  const execution = objectProperties(
    properties.execution,
    versionTwo ? ['status', 'baseline', 'policyVersion', 'evaluator'] : ['status', 'baseline'],
  );
  if (
    !exactLiterals(execution.status, versionTwo ? ['active', 'inactive'] : ['inactive']) ||
    !exactLiterals(execution.baseline, ['builtin_draft'])
  )
    throw new UnsupportedSelectionRead('The served selection baseline or execution states are unsupported');
  if (!versionTwo) return;
  const evaluator = objectProperties(execution.evaluator, ['id', 'version', 'digest']);
  const digest = schema(evaluator.digest);
  if (
    schema(execution.policyVersion).const !== c2SelectionExecutionProfile.policyVersion ||
    schema(evaluator.id).const !== c2SelectionExecutionProfile.evaluator.id ||
    schema(evaluator.version).const !== c2SelectionExecutionProfile.evaluator.version ||
    digest.type !== 'string' ||
    digest.pattern !== '^[a-f0-9]{64}$'
  )
    throw new UnsupportedSelectionRead('The served selection execution policy or evaluator is unsupported');
}
function checkContract(value: unknown): ReadonlySet<string> {
  const document = schema(value);
  if (
    document['x-ledger-demo-contract-version'] !== 'ledger.demo-contract.1' ||
    schema(document.info).version !== '0.1.0'
  )
    throw new UnsupportedSelectionRead('The served selection contract version is unsupported');
  const paths = schema(document.paths);
  const path = paths['/v1/flights/{id}/rule-selection'];
  if (!object(path) || !object(path.get))
    throw new AdoptionPending('selection_contract_pending', 'The served API does not yet offer the selection read');
  const operation = path.get;
  const response = schema(schema(operation.responses)['200']);
  const body = schema(schema(schema(response.content)['application/json']).schema);
  const properties = schema(body.properties);
  const required = body.required;
  if (
    !Array.isArray(required) ||
    !['selection', 'asOf', 'convergence', 'meta'].every((field) => required.includes(field))
  )
    throw new UnsupportedSelectionRead('The served selection response is missing its retained and current views');
  const selection = schema(properties.selection);
  if (!Object.hasOwn(selection, 'anyOf') && !Object.hasOwn(selection, 'oneOf'))
    throw new UnsupportedSelectionRead('The served selection record version is unsupported');
  const versions = new Set<string>();
  for (const record of schemaAlternatives(selection)) {
    if (!object(record.properties) || !object(record.properties.version)) continue;
    const version = record.properties.version.const;
    if (version !== 'flight.rule-selection.1' && version !== 'flight.rule-selection.2') continue;
    if (versions.has(version))
      throw new UnsupportedSelectionRead('The served selection schema repeats a supported version branch');
    checkSelectionBranch(record, version);
    versions.add(version);
  }
  if (!versions.size) throw new UnsupportedSelectionRead('The served selection schema has no supported version branch');
  const convergence = schema(schema(properties.convergence).properties);
  if (!['pending', 'current'].every((state) => literals(convergence.status).includes(state)))
    throw new UnsupportedSelectionRead('The served selection semantics require a new contract review');
  const me = schema(schema(paths['/v1/me']).get);
  const meResponse = schema(schema(me.responses)['200']);
  const meBody = schema(schema(schema(meResponse.content)['application/json']).schema);
  const principal = schema(schema(schema(meBody.properties).principal).properties);
  if (!literals(schema(principal.capabilities).items).includes('flight:read'))
    throw new UnsupportedSelectionRead('The served principal schema does not support flight reads');
  return versions;
}

async function checkAuthority(plan: AdoptionPlan, api: OracleReader): Promise<ReadonlySet<string>> {
  const versions = checkContract(await api.json<unknown>('/openapi.json'));
  const response = await api.json<unknown>('/v1/me');
  const principal = object(response) ? response.principal : undefined;
  if (
    !object(principal) ||
    principal.id !== plan.principalId ||
    principal.tenantId !== plan.tenantId ||
    !Array.isArray(principal.capabilities) ||
    !principal.capabilities.includes('flight:read')
  )
    throw new AdoptionPending('authority_pending', 'Selection inspection requires the pinned tenant flight reader');
  return versions;
}

export async function readAdoptionSelection(
  value: AdoptionPlan,
  statePath: string,
  flightId: string,
  api: OracleReader,
): Promise<AdoptionSelectionResult> {
  let target: AdoptionSelectionTarget | undefined;
  let stage: 'plan' | 'journal' | 'authority' | 'selection' = 'plan';
  let result: AdoptionSelectionResult;
  try {
    const plan = validateAdoptionPlan(value);
    if (
      typeof flightId !== 'string' ||
      !flightId.trim() ||
      flightId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(flightId)
    )
      throw new UnsupportedSelectionRead('Selection inspection requires one explicit supported flight ID');
    if (plan.pack.packId !== 'ledger.demo-procedures' || plan.pack.version !== 3)
      throw new UnsupportedSelectionRead('Selection inspection supports the reviewed company version-three plan');
    stage = 'journal';
    const journal = await readAdoptionJournal(statePath);
    if (!journal)
      throw new AdoptionPending('adoption_unconfirmed', 'Selection inspection requires an existing accepted adoption');
    target = { plan, flightId, ...retainedAcceptedAdoption(journal, plan) };
    stage = 'authority';
    const versions = await checkAuthority(plan, api);
    stage = 'selection';
    const shown = await api.json<unknown>(`/v1/flights/${encodeURIComponent(flightId)}/rule-selection`);
    if (
      !object(shown) ||
      (shown.selection !== null &&
        (!object(shown.selection) ||
          typeof shown.selection.version !== 'string' ||
          !versions.has(shown.selection.version)))
    )
      throw new UnsupportedSelectionRead(
        'The returned selection version is malformed or not advertised by the served contract',
      );
    result = validateAdoptionSelection(shown, target);
  } catch (error) {
    const unsupported =
      error instanceof UnsupportedSelectionRead ||
      (error instanceof AdoptionPending && ['plan_invalid', 'journal_mismatch'].includes(error.code));
    result = {
      kind: 'flight-rule-selection',
      status:
        error instanceof OracleReadError
          ? error.status
          : unsupported || (!(error instanceof AdoptionPending) && stage !== 'authority')
            ? 'unverifiable'
            : 'pending',
      code:
        error instanceof OracleReadError || error instanceof AdoptionPending
          ? error.code
          : error instanceof UnsupportedSelectionRead
            ? 'unsupported_selection_read'
            : `${stage}_unavailable`,
      reason:
        error instanceof OracleReadError ||
        error instanceof AdoptionPending ||
        error instanceof UnsupportedSelectionRead
          ? error.message
          : 'The selection inspection could not validate its retained adoption or public read',
      flightId,
      ...(target ? { adoptionId: target.adoptionId, acceptedRevision: target.acceptedRevision } : {}),
    };
  }
  return { ...result, usage: api.usage() };
}
