import type { FlightRuleSelectionConvergence, FlightRuleSelectionRecord, InputCut } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { AdoptionSelectionResult, AdoptionSelectionTarget } from './adoption-selection-reader.js';

type JsonObject = Record<string, unknown>;
export const c2CompanyReferences = {
  pack: {
    id: 'ledger.demo-procedures',
    version: 3,
    digest: '46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188',
  },
  // The retained lost-link leaf is named by its content digest, which covers its id.
  leaf: { version: 1, digest: '77f0b870a2b60221f39b3a35687cc5dac8f525adcdbf18e273d56517aa0a84e3' },
  binding: {
    id: 'ledger.command-link-status',
    version: 1,
    digest: 'a8d3e22580e514d8a1910aef848325d08ac621e44ffc266d533c1a6f1bdc7eb0',
  },
};
/** Whether a retained reference is the expected one: the same version and digest, and id where one is named. */
export function sameC2Reference(value: unknown, expected: { id?: string; version: number; digest: string }): boolean {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return (
    entry.version === expected.version &&
    entry.digest === expected.digest &&
    (expected.id === undefined || entry.id === expected.id)
  );
}
export const c2SelectionExecutionProfile = {
  policyVersion: 'ledger.company-c2-execution.1',
  evaluator: {
    id: 'ledger.command-link-evidence',
    version: 1,
    digest: 'c25bef5721e555b19b3db564f6999d0fae967db642e7e5a56cd5dba490f46482',
  },
} as const;

class InvalidSelection extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}
function invalid(reason: string, code = 'unsupported_selection'): never {
  throw new InvalidSelection(code, reason);
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid('Selection information has an unsupported object shape');
  return value as JsonObject;
}
function keys(value: JsonObject, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid('Selection information has missing or unsupported fields');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    return invalid('Selection identity is missing or unsupported');
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    return invalid('Selection revision or frontier is invalid');
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid('Selection digest is invalid');
  return value;
}
function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid('Selection time requires explicit UTC');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    return invalid('Selection time is invalid');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid('Selection information requires a supported list');
  return value;
}
function choice(value: unknown, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value))
    return invalid('Selection state or execution semantics are unsupported');
  return value;
}
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);

function cut(value: unknown, retained = false): InputCut {
  const valueObject = object(value);
  keys(valueObject, ['streams'], ['basisRevision', 'principalRevision']);
  const streams = object(valueObject.streams);
  for (const [streamId, sequence] of Object.entries(streams)) {
    id(streamId);
    integer(sequence);
  }
  for (const field of ['basisRevision', 'principalRevision']) {
    if (retained || valueObject[field] !== undefined) integer(valueObject[field]);
  }
  return valueObject as unknown as InputCut;
}
function metadata(value: unknown): void {
  const meta = object(value);
  keys(
    meta,
    ['requestId', 'projectionRevision', 'inputCut', 'computedAt', 'outstandingWork'],
    ['effectId', 'dependencyBasis'],
  );
  id(meta.requestId);
  if (meta.effectId !== undefined) id(meta.effectId);
  integer(meta.projectionRevision);
  integer(meta.outstandingWork);
  cut(meta.inputCut);
  utc(meta.computedAt);
  if (meta.dependencyBasis !== undefined) digest(meta.dependencyBasis);
}
function convergence(value: unknown): FlightRuleSelectionConvergence {
  const valueObject = object(value);
  keys(valueObject, ['status', 'reason']);
  const status = choice(valueObject.status, ['current', 'pending']);
  if (status === 'current') {
    if (valueObject.reason !== null) invalid('Current selection convergence must have no pending reason');
  } else choice(valueObject.reason, ['bootstrap', 'organization_changed', 'boundary_due']);
  return valueObject as unknown as FlightRuleSelectionConvergence;
}
function reference(value: unknown, expected: { id?: string; version: number; digest: string }): void {
  const entry = object(value);
  keys(entry, ['id', 'version', 'digest']);
  id(entry.id);
  integer(entry.version, 1);
  digest(entry.digest);
  if (!sameC2Reference(entry, expected))
    invalid('Selection references an unsupported company pack, C2 leaf or binding');
}
function interval(value: unknown): { start: string; end: string } {
  const valueObject = object(value);
  keys(valueObject, ['start', 'end']);
  const start = utc(valueObject.start);
  const end = utc(valueObject.end);
  if (Date.parse(start) >= Date.parse(end)) invalid('Selection requires a finite half-open effective interval');
  return { start, end };
}

function executionProfile(record: JsonObject, state: string): void {
  const execution = object(record.execution);
  if (record.version === 'flight.rule-selection.1') {
    keys(execution, ['status', 'baseline']);
    if (execution.status !== 'inactive' || execution.baseline !== 'builtin_draft')
      invalid('Version 1 selection requires inactive execution with the built-in draft baseline');
    return;
  }
  keys(execution, ['status', 'baseline', 'policyVersion', 'evaluator']);
  const evaluator = object(execution.evaluator);
  keys(evaluator, ['id', 'version', 'digest']);
  if (
    execution.baseline !== 'builtin_draft' ||
    execution.policyVersion !== c2SelectionExecutionProfile.policyVersion ||
    !same(evaluator, c2SelectionExecutionProfile.evaluator)
  )
    invalid('Selection requires the reviewed company C2 execution policy and evaluator');
  if (execution.status !== (state === 'eligible' ? 'active' : 'inactive'))
    invalid('Selection execution disagrees with its retained adoption eligibility');
}

function retainedBasis(record: JsonObject, flightId: string, organizationId: string): void {
  const manifest = object(record.basisManifest);
  keys(manifest, [
    'version',
    'subjectId',
    'principalId',
    'principalRevision',
    'subjects',
    'edges',
    'frontiers',
    'authority',
  ]);
  if (manifest.version !== 'subject-evidence.1' || manifest.subjectId !== flightId)
    invalid('Retained selection basis has an unsupported version or subject');
  id(manifest.principalId);
  const principalRevision = integer(manifest.principalRevision);
  const subjects = list(manifest.subjects).map(id);
  const subjectIds = new Set(subjects);
  if (subjects.length !== subjectIds.size || !subjectIds.has(flightId) || !subjectIds.has(organizationId))
    invalid('Retained selection basis must include its flight and organization exactly once');
  if (subjects.some((subjectId) => subjectId.startsWith('organization:') && subjectId !== organizationId))
    invalid('Retained selection basis references another organization');
  const edges = new Map<string, string[]>();
  const edgeKeys = new Set<string>();
  for (const value of list(manifest.edges)) {
    const edge = object(value);
    keys(edge, ['subjectId', 'dependencySubjectId', 'eventId']);
    const subjectId = id(edge.subjectId);
    const dependencySubjectId = id(edge.dependencySubjectId);
    id(edge.eventId);
    const key = JSON.stringify([subjectId, dependencySubjectId]);
    if (!subjectIds.has(subjectId) || !subjectIds.has(dependencySubjectId) || edgeKeys.has(key))
      invalid('Retained selection dependency edges are inconsistent');
    edgeKeys.add(key);
    edges.set(subjectId, [...(edges.get(subjectId) ?? []), dependencySubjectId]);
  }
  if (!edgeKeys.has(JSON.stringify([flightId, organizationId])))
    invalid('Retained selection basis lacks its flight-to-organization dependency');
  const reached = new Set([flightId]);
  const pending = [flightId];
  for (let index = 0; index < pending.length; index++) {
    for (const dependency of edges.get(pending[index]!) ?? []) {
      if (reached.has(dependency)) continue;
      reached.add(dependency);
      pending.push(dependency);
    }
  }
  if (reached.size !== subjectIds.size) invalid('Retained selection basis contains unrelated subjects');
  const accepted = new Map<string, number>();
  const rendered = new Map<string, number>();
  const positions = (frontier: JsonObject) => {
    const streamId = id(frontier.streamId);
    const sequence = integer(frontier.sequence);
    const projected = integer(frontier.projectedSequence);
    if (projected > sequence) invalid('Retained selection projection exceeds its accepted frontier');
    accepted.set(streamId, Math.max(accepted.get(streamId) ?? 0, sequence));
    rendered.set(streamId, Math.max(rendered.get(streamId) ?? 0, projected));
  };
  const frontierKeys = new Set<string>();
  const populatedSubjects = new Set<string>();
  for (const value of list(manifest.frontiers)) {
    const frontier = object(value);
    keys(frontier, ['subjectId', 'streamId', 'sequence', 'projectedSequence']);
    const subjectId = id(frontier.subjectId);
    const key = JSON.stringify([subjectId, id(frontier.streamId)]);
    if (!subjectIds.has(subjectId) || frontierKeys.has(key)) invalid('Retained selection frontiers are inconsistent');
    frontierKeys.add(key);
    positions(frontier);
    if (Number(frontier.sequence) > 0) populatedSubjects.add(subjectId);
  }
  if (
    !populatedSubjects.has(flightId) ||
    (Number(record.adoptionRevision) > 0 && !populatedSubjects.has(organizationId))
  )
    invalid('Retained selection basis omits its known flight or adoption evidence frontier');
  if (manifest.authority !== null) {
    const authority = object(manifest.authority);
    keys(authority, ['streamId', 'sequence', 'projectedSequence']);
    positions(authority);
  }
  const renderedCut = cut(record.renderedInputCut, true);
  const acceptedCut = cut(record.acceptedInputCut, true);
  if (
    renderedCut.principalRevision !== principalRevision ||
    acceptedCut.principalRevision !== principalRevision ||
    renderedCut.basisRevision !== acceptedCut.basisRevision ||
    !same(renderedCut.streams, Object.fromEntries(rendered)) ||
    !same(acceptedCut.streams, Object.fromEntries(accepted)) ||
    digest(record.dependencyBasis) !== canonicalDigest(manifest)
  )
    invalid(
      'Retained selection cuts or dependency commitment differ from their basis manifest',
      'selection_basis_invalid',
    );
}

export function validateRetainedRuleSelection(
  value: unknown,
  context: { flightId: string; tenantId: string; asOf: string },
): FlightRuleSelectionRecord {
  const flightId = id(context.flightId);
  const organizationId = `organization:${id(context.tenantId)}`;
  const asOf = utc(context.asOf);
  const record = object(value);
  keys(record, [
    'version',
    'id',
    'flightId',
    'organizationId',
    'clock',
    'adoptionRevision',
    'projectedAdoptionRevision',
    'selection',
    'execution',
    'nextBoundary',
    'renderedInputCut',
    'acceptedInputCut',
    'dependencyBasis',
    'basisManifest',
    'selectionDigest',
  ]);
  id(record.id);
  if (
    (record.version !== 'flight.rule-selection.1' && record.version !== 'flight.rule-selection.2') ||
    record.flightId !== flightId ||
    record.organizationId !== organizationId
  )
    invalid('Selection version, flight or organization differs from the supported target');
  const clock = object(record.clock);
  keys(clock, ['mode', 'evaluatedAt']);
  if (clock.mode !== 'wall') invalid('Selection requires its retained wall clock');
  const evaluatedAt = Date.parse(utc(clock.evaluatedAt));
  if (evaluatedAt > Date.parse(asOf)) invalid('Retained selection clock is later than the public read clock');
  const acceptedRevision = integer(record.adoptionRevision);
  const projectedRevision = integer(record.projectedAdoptionRevision);
  if (projectedRevision > acceptedRevision) invalid('Projected adoption frontier exceeds accepted adoption frontier');
  const selected = object(record.selection);
  keys(selected, ['state', 'adoption']);
  const state = choice(selected.state, ['not_adopted', 'pending', 'scheduled', 'eligible', 'expired']);
  let ownBoundary: number | undefined;
  let selectedInterval: { start: string; end: string } | undefined;
  if (selected.adoption === null) {
    if (state !== 'not_adopted' || record.nextBoundary !== null)
      invalid('An absent selection cannot claim adoption or interval boundaries');
  } else {
    const adoption = object(selected.adoption);
    keys(adoption, ['id', 'acceptedRevision', 'pack', 'leaf', 'binding', 'effectiveInterval']);
    id(adoption.id);
    const revision = integer(adoption.acceptedRevision, 1);
    reference(adoption.pack, c2CompanyReferences.pack);
    reference(adoption.leaf, c2CompanyReferences.leaf);
    reference(adoption.binding, c2CompanyReferences.binding);
    selectedInterval = interval(adoption.effectiveInterval);
    const start = Date.parse(selectedInterval.start);
    const end = Date.parse(selectedInterval.end);
    if (revision > acceptedRevision || (state !== 'pending' && revision > projectedRevision))
      invalid('Selected adoption exceeds its retained adoption frontiers');
    const timedState = evaluatedAt < start ? 'scheduled' : evaluatedAt >= end ? 'expired' : 'eligible';
    if (state !== 'pending' && state !== timedState)
      invalid('Selected adoption state disagrees with its interval at the retained clock');
    ownBoundary = evaluatedAt < start ? start : evaluatedAt < end ? end : undefined;
  }
  executionProfile(record, state);
  if (record.nextBoundary === null) {
    if (ownBoundary !== undefined) invalid('Retained selection omits a known future interval boundary');
  } else {
    const boundary = object(record.nextBoundary);
    keys(boundary, ['at', 'adoptionId', 'kind']);
    id(boundary.adoptionId);
    const kind = choice(boundary.kind, ['start', 'end']);
    const at = Date.parse(utc(boundary.at));
    if (at <= evaluatedAt || (ownBoundary !== undefined && at > ownBoundary))
      invalid('Retained next boundary is inconsistent with its known interval');
    if (
      boundary.adoptionId === object(selected.adoption).id &&
      selectedInterval &&
      at !== Date.parse(selectedInterval[kind as 'start' | 'end'])
    )
      invalid('Retained boundary does not match its selected adoption interval');
  }
  const stateContent = {
    version: record.version,
    flightId: record.flightId,
    organizationId: record.organizationId,
    adoptionRevision: record.adoptionRevision,
    projectedAdoptionRevision: record.projectedAdoptionRevision,
    selection: record.selection,
    execution: record.execution,
    nextBoundary: record.nextBoundary,
  };
  if (digest(record.selectionDigest) !== canonicalDigest(stateContent))
    invalid('Retained selection differs from its declared content digest', 'selection_digest_invalid');
  retainedBasis(record, flightId, organizationId);
  return record as unknown as FlightRuleSelectionRecord;
}

export function validateAdoptionSelection(value: unknown, target: AdoptionSelectionTarget): AdoptionSelectionResult {
  const result: AdoptionSelectionResult = {
    kind: 'flight-rule-selection',
    status: 'unverifiable',
    code: 'unsupported_selection',
    reason: 'Public selection information is malformed or unsupported',
    flightId: target.flightId,
  };
  const pending = (code: string, reason: string): AdoptionSelectionResult => ({
    ...result,
    status: 'pending',
    code,
    reason,
  });
  try {
    id(target.flightId);
    id(target.adoptionId);
    integer(target.acceptedRevision, 1);
    id(target.plan.tenantId);
    const pack = target.plan.pack;
    reference({ id: pack.packId, version: pack.version, digest: pack.digest }, c2CompanyReferences.pack);
    const leaf = pack.leaves.filter((entry) => sameC2Reference(entry, c2CompanyReferences.leaf));
    const binding = pack.bindings.filter((entry) => entry.id === c2CompanyReferences.binding.id);
    if (leaf.length !== 1 || binding.length !== 1) invalid('Target plan lacks its exact reviewed C2 references');
    reference(leaf[0], c2CompanyReferences.leaf);
    reference(binding[0], c2CompanyReferences.binding);
    const expectedInterval = interval(target.plan.effectiveInterval);
    result.adoptionId = target.adoptionId;
    result.acceptedRevision = target.acceptedRevision;
    const response = object(value);
    keys(response, ['selection', 'asOf', 'convergence', 'meta']);
    const asOf = utc(response.asOf);
    result.asOf = asOf;
    const current = convergence(response.convergence);
    result.convergence = structuredClone(current);
    metadata(response.meta);
    if (response.selection === null) {
      if (current.status !== 'pending' || current.reason !== 'bootstrap')
        invalid('A missing retained selection requires pending bootstrap convergence');
      return pending(
        'selection_bootstrap',
        'The flight has no retained selection yet; adoption absence is not established',
      );
    }
    const record = validateRetainedRuleSelection(response.selection, {
      flightId: target.flightId,
      tenantId: target.plan.tenantId,
      asOf,
    });
    result.execution = structuredClone(record.execution);
    const {
      id: recordId,
      clock,
      selection,
      adoptionRevision,
      projectedAdoptionRevision,
      nextBoundary,
      selectionDigest,
      dependencyBasis,
    } = record;
    result.retained = structuredClone({
      id: recordId,
      clock,
      selection,
      adoptionRevision,
      projectedAdoptionRevision,
      nextBoundary,
      selectionDigest,
      dependencyBasis,
    });
    if (current.reason === 'bootstrap') invalid('A retained selection cannot still require bootstrap');
    if (current.reason === 'boundary_due' && (!nextBoundary || Date.parse(nextBoundary.at) > Date.parse(asOf)))
      invalid('Boundary convergence does not match the retained due boundary');
    const selected = selection.adoption;
    if (!selected)
      return pending(
        'selection_not_adopted',
        'This retained selection has no adoption; historical absence is not established',
      );
    if (selected.id !== target.adoptionId)
      return pending(
        'selection_different_candidate',
        'The public read selects another adoption; it does not establish absence of the pinned adoption',
      );
    if (
      selected.acceptedRevision !== target.acceptedRevision ||
      Date.parse(selected.effectiveInterval.start) !== Date.parse(expectedInterval.start) ||
      Date.parse(selected.effectiveInterval.end) !== Date.parse(expectedInterval.end)
    )
      invalid('Selected adoption revision or interval differs from the pinned accepted plan');
    if (current.status === 'pending')
      return pending(
        'selection_refresh_pending',
        'The retained selection is waiting for organization or interval-boundary work',
      );
    if (nextBoundary && Date.parse(nextBoundary.at) <= Date.parse(asOf))
      return pending(
        'selection_boundary_due',
        'The retained selection has reached its next boundary and needs a refreshed read',
      );
    if (selection.state === 'pending')
      return pending(
        'adoption_projection_pending',
        'The selection is current but its selected adoption still awaits projection',
      );
    return {
      ...result,
      status: 'match',
      code: 'selection_matches',
      reason: 'The current selection matches the pinned adoption, retained clock, execution policy and commitments',
    };
  } catch (error) {
    return {
      ...result,
      status: 'unverifiable',
      code: error instanceof InvalidSelection ? error.code : 'unsupported_selection',
      reason:
        error instanceof InvalidSelection ? error.message : 'Public selection information is malformed or unsupported',
    };
  }
}
