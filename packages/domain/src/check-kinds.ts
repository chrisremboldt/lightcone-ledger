import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  ObservationTypeIdPattern,
  RuleNamePattern,
  type CheckDetails,
  type IssueTime,
  type RuleReadCondition,
  type SummaryRecordSource,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

export type CheckEvidenceState = 'supported' | 'insufficient' | 'conflicting' | 'not_applicable';
export type CheckOutcome = 'pass' | 'attention' | 'pending' | 'not_applicable';

/** One accepted observation as a check sees it. `observation` is the complete accepted observation object. */
export interface CheckObservation {
  id: string;
  /**
   * The source that reported the observation. A check may use it to keep reports of different sources apart, and
   * for nothing else.
   */
  sourceId?: string;
  type: string;
  version: number;
  occurredAt: string;
  interval?: { start: string; end?: string };
  observation: Readonly<Record<string, unknown>>;
}

/** Declared inputs by name, each newest first (by span start, then id). */
export type CheckInputs = Readonly<Record<string, readonly CheckObservation[]>>;

export interface CheckClock {
  mode: 'wall';
  evaluatedAt: string;
  /**
   * The effective dates of the adoption the rule is evaluated under. Given only to a kind that declares
   * `adoptionDates`; the evaluation record keeps them under its adoption, not in its clock.
   */
  adoption?: { start: string; end: string };
  /**
   * The organization's IANA time zone. The evaluation states every UTC instant of the summary in it, with its name;
   * a kind needs it only to place something on the organization's calendar days.
   */
  timeZone?: string;
}

export interface CheckResult {
  evidenceState: CheckEvidenceState;
  outcome: CheckOutcome;
  reasonCode: string;
  summary: string;
  /** Ids of the observations the result relied on. */
  evidence: string[];
  /** The next instant at which the answer could change with no new input. */
  nextBoundary?: string;
  /** Named values for screens, later steps and the rule's wording. Only details the kind declares are kept. */
  details?: CheckDetails;
  /**
   * Stable names of the distinct things that need a person's attention. Kept only when the kind declares issues; a
   * resolved finding then reopens only for an issue its resolving evaluation did not name.
   */
  issues?: string[];
  /** When each named issue happened. Kept only when the kind declares that its issues are timed. */
  issueTimes?: IssueTime[];
  /**
   * Records the check left out because the operator recorded them as needing nothing, in words. They follow the
   * summary, or the rule's wording; when nothing else was counted they are the summary.
   */
  notCounted?: string;
}

export interface CheckKindIssues {
  /** What one issue names, such as one reported episode. */
  description: string;
  /** Declared when the kind says when each issue happened: what the start and end of an issue are. */
  timed?: string;
}

export interface CheckKindDetail {
  name: string;
  description: string;
}

export interface CheckKindInput {
  name: string;
  description: string;
  /** An optional input may be left out of a rule's reads. */
  optional?: boolean;
}

/**
 * A check kind is a pure, versioned predicate. It performs no I/O and names no regulation, rule, vendor or problem:
 * the rule supplies the observation types and parameters. A published id and version is never changed; a changed
 * definition is a new version.
 */
export interface CheckKind<Params = any> {
  id: string;
  version: number;
  title: string;
  description: string;
  inputs: readonly CheckKindInput[];
  /** JSON Schema for the parameters, fixed ones from the rule plus those the organization sets on adoption. */
  parameterSchema: Readonly<Record<string, unknown>>;
  /** The details the kind can return. A rule's wording may name only these. */
  details?: readonly CheckKindDetail[];
  /** Declared when the kind names the things that need attention; see `CheckResult.issues`. */
  issues?: CheckKindIssues;
  /**
   * Details whose values the kind's own summaries state word for word, such as UTC instants, so a screen can show
   * them in a person's terms. For display only: outside the definition and its digest.
   */
  summaryValues?: readonly string[];
  /**
   * Fields of the evaluation record, from a closed set, whose UTC instants the kind's own summaries state word for
   * word although they are not details. For display only, like `summaryValues`.
   */
  summaryRecordValues?: readonly SummaryRecordSource[];
  /**
   * Declared when the kind reads the adoption's effective dates from the clock: what it uses them for. The dates are
   * then part of what an evaluation read, so a revision that changes them evaluates the rule again.
   */
  adoptionDates?: string;
  evaluate(params: Params, inputs: CheckInputs, clock: CheckClock): CheckResult;
}

export interface CheckKindDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  inputs: CheckKindInput[];
  parameterSchema: Record<string, unknown>;
  details?: CheckKindDetail[];
  issues?: CheckKindIssues;
  adoptionDates?: string;
}

interface CheckKindRegistry {
  kinds: Map<string, { kind: CheckKind; digest: string; validate: ValidateFunction }>;
}

// One process can load this module both from source and from its build (tests do), so the registrations live on a
// process-wide key that both copies share.
const registryKey = Symbol.for('ledger.check-kind-registry.1');
const registry: CheckKindRegistry = ((globalThis as Record<symbol, CheckKindRegistry | undefined>)[registryKey] ??= {
  kinds: new Map(),
});

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const idPattern = new RegExp(ObservationTypeIdPattern);
const detailNamePattern = new RegExp(RuleNamePattern);

function key(id: string, version: number): string {
  return `${id}@${version}`;
}

/** The declared definition of a check kind: what its identity digest covers. The function source is not part of it. */
export function checkKindDefinition(kind: CheckKind): CheckKindDefinition {
  return structuredClone({
    id: kind.id,
    version: kind.version,
    title: kind.title,
    description: kind.description,
    inputs: kind.inputs.map((input) => ({ ...input })),
    parameterSchema: kind.parameterSchema as Record<string, unknown>,
    // Present only when declared, so the digests of kinds that declare none are unchanged.
    ...(kind.details ? { details: kind.details.map((detail) => ({ ...detail })) } : {}),
    ...(kind.issues ? { issues: { ...kind.issues } } : {}),
    ...(kind.adoptionDates ? { adoptionDates: kind.adoptionDates } : {}),
  });
}

export function checkKindDigest(kind: CheckKind): string {
  return canonicalDigest({ format: 'ledger.check-kind.1', ...checkKindDefinition(kind) });
}

/**
 * Registers a check kind. Registering the same id and version again is accepted only with an identical declared
 * definition, and keeps the first registration.
 */
export function registerCheckKind(kind: CheckKind): void {
  if (!idPattern.test(kind.id)) throw new Error(`Check kind id ${kind.id} must be a lowercase domain.noun id`);
  if (!Number.isSafeInteger(kind.version) || kind.version < 1)
    throw new Error(`Check kind ${kind.id} needs a positive integer version`);
  const names = kind.inputs.map((input) => input.name);
  if (new Set(names).size !== names.length) throw new Error(`Check kind ${kind.id} declares an input twice`);
  const details = (kind.details ?? []).map((detail) => detail.name);
  if (new Set(details).size !== details.length) throw new Error(`Check kind ${kind.id} declares a detail twice`);
  const badDetail = details.find((name) => !detailNamePattern.test(name));
  if (badDetail) throw new Error(`Check kind ${kind.id} detail ${badDetail} must be a rule name`);
  const undeclared = (kind.summaryValues ?? []).find((name) => !details.includes(name));
  if (undeclared) throw new Error(`Check kind ${kind.id} summary value ${undeclared} is not a declared detail`);
  const shadowing = details.find((name) => name === 'nextBoundary' || /^evidence\d+OccurredAt$/.test(name));
  if (shadowing) throw new Error(`Check kind ${kind.id} detail ${shadowing} is the name of a recorded field`);
  const digest = checkKindDigest(kind);
  const existing = registry.kinds.get(key(kind.id, kind.version));
  if (existing) {
    if (existing.digest !== digest)
      throw new Error(`Check kind ${kind.id} version ${kind.version} is already registered with another definition`);
    return;
  }
  registry.kinds.set(key(kind.id, kind.version), {
    kind,
    digest,
    validate: ajv.compile(structuredClone(kind.parameterSchema)),
  });
}

export function findCheckKind(id: string, version: number): CheckKind | undefined {
  return registry.kinds.get(key(id, version))?.kind;
}

export function registeredCheckKindDigest(id: string, version: number): string | undefined {
  return registry.kinds.get(key(id, version))?.digest;
}

export function listCheckKinds(): CheckKindDefinition[] {
  return [...registry.kinds.values()].map(({ kind }) => checkKindDefinition(kind));
}

/** Returns a description of the first problem, or undefined when the parameters match the kind's schema. */
export function checkParameterProblem(id: string, version: number, params: unknown): string | undefined {
  const entry = registry.kinds.get(key(id, version));
  if (!entry) return `Check kind ${id} version ${version} is not registered`;
  if (entry.validate(params)) return undefined;
  const first = entry.validate.errors?.[0];
  return `Check ${id} parameters ${first?.instancePath || '/'} ${first?.message ?? 'are invalid'}`;
}

/** Reads a dot-separated path from an observation's own properties. Absent paths read as undefined. */
export function observationField(observation: CheckObservation, path: string): unknown {
  let value: unknown = observation.observation;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** True when a value counts as filled: absent, null and blank text are not; false and zero are. */
export function isFilled(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
}

/** True when a field's value is one of the values, or, for a field that holds a list, the list holds one of them. */
export function valueIsOneOf(value: unknown, oneOf: readonly unknown[]): boolean {
  return Array.isArray(value)
    ? value.some((item) => oneOf.includes(item))
    : oneOf.some((expected) => expected === (value as string | number | boolean));
}

/**
 * True when the observation meets every condition: a field equal to one of the values (a list holding one of them),
 * or a filled field.
 */
export function observationMatches(
  observation: CheckObservation,
  conditions: readonly RuleReadCondition[] = [],
): boolean {
  return conditions.every((condition) => {
    const value = observationField(observation, condition.field);
    return 'filled' in condition ? isFilled(value) : valueIsOneOf(value, condition.oneOf);
  });
}

export function spanStart(observation: CheckObservation): string {
  return observation.interval?.start ?? observation.occurredAt;
}

/** The observations sharing the newest span start. Inputs arrive newest first. */
export function latestObservations(observations: readonly CheckObservation[]): CheckObservation[] {
  const first = observations[0];
  if (!first) return [];
  const newest = Date.parse(spanStart(first));
  return observations.filter((observation) => Date.parse(spanStart(observation)) === newest);
}

const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Milliseconds for a strict UTC instant ending in Z, or undefined. */
export function utcMillis(value: unknown): number | undefined {
  if (typeof value !== 'string' || !utcPattern.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return time;
}
