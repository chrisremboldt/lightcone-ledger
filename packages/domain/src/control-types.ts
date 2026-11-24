import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  ControlTypeDefinitionSchema,
  type CheckedRuleLeaf,
  type ControlParameterChoice,
  type ControlScope,
  type ControlApplicabilityOutcome,
  type ControlTypeDefinition,
  type ControlTypeDefinitionContent,
  type MissionRevisionRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

/**
 * A control type: what a control applies to, the parameters it records, how it reads to a person and whether a
 * deterministic check can follow it. Registering a type is all a new control needs; no core module names one.
 * A published id and version is never changed; a changed definition is a new version.
 */
export interface ControlType<Parameters = any> {
  id: string;
  version: number;
  title: string;
  description: string;
  appliesTo: readonly ControlScope[];
  /** JSON Schema for the parameters. A screen without a special editor for the type generates its form from it. */
  parameterSchema: Readonly<Record<string, unknown>>;
  checkedAutomatically: boolean;
  /** One plain sentence for a person, from valid parameters. Never a verdict on the control. */
  describe(parameters: Parameters): string;
  /**
   * The first problem the parameter schema cannot express, such as a reference to another registry, or undefined.
   * Runs only on parameters that match the schema. Like describe, it is not part of the digest.
   */
  validate?(parameters: Parameters): string | undefined;
  /**
   * For a type that applies to an area: the circle its valid parameters describe. Route review keeps every planned
   * route clear of each accepted control whose type has one. Like describe, it is not part of the digest.
   */
  area?(parameters: Parameters): ControlArea;
  /**
   * For a type a rule checks: the rules its valid parameters become once the control is accepted, at most one per
   * target subject kind. Like describe, it is not part of the digest; the leaves it produces are pinned instead.
   */
  rules?(parameters: Parameters): ControlRuleDeclaration[];
  /**
   * Parameters a person picks by title from what the registries hold, by parameter name, so a form offers named
   * things instead of asking for raw names. Descriptive data: not part of the digest.
   */
  parameterChoices?: Readonly<Record<string, ControlParameterChoice>>;
  /**
   * The control in the words a person knows its parameters by, for screens. describe stays the recorded wording a
   * rule quotes; this is read at display and never recorded. Not part of the digest.
   */
  wording?(parameters: Parameters): string;
  /**
   * For a type whose controls bear only on some flights: the rule that decides from the accepted parameters and the
   * flight's plan whether a control applies. Its identity is part of the digest, so a changed rule is a new type
   * version; registration refuses a definition whose digest is not the rule's.
   */
  applicability?: ControlApplicabilityDeclaration<Parameters>;
}

/** The fields of the exact mission revision an applicability rule may read. */
export interface ApplicabilityPlan {
  mission: Pick<
    MissionRevisionRecord,
    'aircraftId' | 'sourceMissionId' | 'route' | 'lateralToleranceMeters' | 'altitude' | 'operatingInterval'
  >;
}

/**
 * A pinned applicability rule. evaluate is pure: it sees deep-frozen copies of the parameters and the plan, and no
 * clock, database or registry. The definition is the frozen description its digest covers.
 */
export interface ControlApplicabilityDeclaration<Parameters = any> {
  rule: { id: string; version: number; digest: string };
  definition: Readonly<{ id: string; version: number }>;
  evaluate(parameters: Parameters, plan: ApplicabilityPlan): ControlApplicabilityOutcome;
}

/** What a control type declares for one checked rule; Ledger adds the id, version, title and source. */
export interface ControlRuleDeclaration {
  target: CheckedRuleLeaf['target'];
  /** When the control names its subjects: only these subject ids are in its scope. */
  subjectIds?: readonly string[];
  reads: CheckedRuleLeaf['reads'];
  check: { kind: string; version: number; params: Record<string, unknown> };
  applicability?: CheckedRuleLeaf['applicability'];
  wording?: CheckedRuleLeaf['wording'];
}

/** A closed horizontal circle in WGS84 degrees, at all altitudes, and the name of the site it refers to if any. */
export interface ControlArea {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  site?: string;
}

interface ControlTypeRegistry {
  types: Map<string, { type: ControlType; digest: string; validate: ValidateFunction }>;
}

// One process can load this module both from source and from its build (tests do), so the registrations live on a
// process-wide key that both copies share.
const registryKey = Symbol.for('ledger.control-type-registry.1');
const registry: ControlTypeRegistry = ((globalThis as Record<symbol, ControlTypeRegistry | undefined>)[registryKey] ??=
  { types: new Map() });

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const validDefinition = ajv.compile(structuredClone(ControlTypeDefinitionSchema));

function key(id: string, version: number): string {
  return `${id}@${version}`;
}

/** The declared definition of a control type: what its digest covers. The describe function is not part of it. */
export function controlTypeDefinitionContent(type: ControlType): ControlTypeDefinitionContent {
  return structuredClone({
    id: type.id,
    version: type.version,
    title: type.title,
    description: type.description,
    appliesTo: [...type.appliesTo],
    parameterSchema: type.parameterSchema as Record<string, unknown>,
    checkedAutomatically: type.checkedAutomatically,
    ...(type.applicability ? { applicability: { ...type.applicability.rule } } : {}),
  });
}

export function controlTypeDigest(type: ControlType): string {
  return canonicalDigest({ format: 'ledger.control-type.1', ...controlTypeDefinitionContent(type) });
}

/**
 * Registers a control type. Registering the same id and version again is accepted only with an identical declared
 * definition, and keeps the first registration.
 */
export function registerControlType(type: ControlType): void {
  const content = controlTypeDefinitionContent(type);
  if (!validDefinition(content)) {
    const first = validDefinition.errors?.[0];
    throw new Error(`Control type ${type.id}: ${first?.instancePath || '/'} ${first?.message ?? 'is invalid'}`);
  }
  const problem = type.applicability && applicabilityRuleProblem(type.applicability);
  if (problem) throw new Error(`Control type ${type.id}: ${problem}`);
  const digest = controlTypeDigest(type);
  const existing = registry.types.get(key(type.id, type.version));
  if (existing) {
    if (existing.digest !== digest)
      throw new Error(`Control type ${type.id} version ${type.version} is already registered with another definition`);
    return;
  }
  registry.types.set(key(type.id, type.version), {
    type,
    digest,
    validate: ajv.compile(structuredClone(type.parameterSchema)),
  });
}

function applicabilityRuleProblem({ rule, definition }: ControlApplicabilityDeclaration): string | undefined {
  if (definition.id !== rule.id || definition.version !== rule.version)
    return `applicability rule ${rule.id} version ${rule.version} names another definition`;
  if (canonicalDigest(definition) !== rule.digest)
    return `applicability rule ${rule.id} version ${rule.version} does not match its digest`;
  return undefined;
}

export function findControlType(id: string, version: number): ControlType | undefined {
  return registry.types.get(key(id, version))?.type;
}

export function registeredControlTypeDigest(id: string, version: number): string | undefined {
  return registry.types.get(key(id, version))?.digest;
}

export function listControlTypes(): ControlTypeDefinition[] {
  return [...registry.types.values()]
    .map(({ type, digest }) => ({
      ...controlTypeDefinitionContent(type),
      digest,
      ...(type.parameterChoices ? { parameterChoices: structuredClone({ ...type.parameterChoices }) } : {}),
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id) || a.version - b.version);
}

/** Returns the first problem with a pinned type and its parameters, or undefined when both are acceptable. */
export function controlParameterProblem(
  pinned: { id: string; version: number; digest: string },
  parameters: unknown,
): string | undefined {
  const entry = registry.types.get(key(pinned.id, pinned.version));
  if (!entry) return `Control type ${pinned.id} version ${pinned.version} is not registered`;
  if (entry.digest !== pinned.digest)
    return `Control type ${pinned.id} version ${pinned.version} is registered with another definition`;
  if (!entry.validate(parameters)) {
    const first = entry.validate.errors?.[0];
    return `Control parameters ${first?.instancePath || '/'} ${first?.message ?? 'are invalid'}`;
  }
  return entry.type.validate?.(parameters);
}

/** Every registered type that describes an area, pinned by id, version and digest. */
export function areaControlTypes(): { id: string; version: number; digest: string }[] {
  return [...registry.types.values()]
    .filter(({ type }) => type.area !== undefined)
    .map(({ type, digest }) => ({ id: type.id, version: type.version, digest }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}

/** The area a control covers, or undefined when its pinned type is not registered here or describes no area. */
export function controlArea(
  pinned: { id: string; version: number; digest: string },
  parameters: Record<string, unknown>,
): ControlArea | undefined {
  const entry = registry.types.get(key(pinned.id, pinned.version));
  if (!entry?.type.area || entry.digest !== pinned.digest || controlParameterProblem(pinned, parameters))
    return undefined;
  return entry.type.area(parameters);
}

/** The control as its registered type describes it, or undefined when the pinned type is not registered here. */
export function describeControl(
  pinned: { id: string; version: number; digest: string },
  parameters: Record<string, unknown>,
): string | undefined {
  const entry = registry.types.get(key(pinned.id, pinned.version));
  if (!entry || entry.digest !== pinned.digest || !entry.validate(parameters)) return undefined;
  return entry.type.describe(parameters);
}

/**
 * The control in the words its registered type gives a person, or undefined when the type gives none or the pinned
 * type is not registered here. For display only; the recorded wording is describeControl's.
 */
export function controlWording(
  pinned: { id: string; version: number; digest: string },
  parameters: Record<string, unknown>,
): string | undefined {
  const entry = registry.types.get(key(pinned.id, pinned.version));
  if (!entry?.type.wording || entry.digest !== pinned.digest || !entry.validate(parameters)) return undefined;
  return entry.type.wording(parameters);
}

/** The rules an accepted control becomes, or undefined when its pinned type is not registered here or declares none. */
export function controlRules(
  pinned: { id: string; version: number; digest: string },
  parameters: Record<string, unknown>,
): ControlRuleDeclaration[] | undefined {
  const entry = registry.types.get(key(pinned.id, pinned.version));
  if (!entry?.type.rules || entry.digest !== pinned.digest || controlParameterProblem(pinned, parameters))
    return undefined;
  return entry.type.rules(parameters);
}

/**
 * How a control is checked: by the rules its type declares, by route review for a type that describes an area, or by
 * a person. Undefined when its pinned type is not registered here.
 */
export function controlCheck(pinned: { id: string; version: number; digest: string }): ControlCheck | undefined {
  const entry = registry.types.get(key(pinned.id, pinned.version));
  if (!entry || entry.digest !== pinned.digest) return undefined;
  if (entry.type.rules) return 'rule';
  if (entry.type.area) return 'route_review';
  return 'person';
}

export type ControlCheck = 'rule' | 'route_review' | 'person';
