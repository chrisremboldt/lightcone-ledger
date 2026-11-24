import type { RuleApplicabilityCondition, RuleRead, RuleReadCondition, RuleRelatedSubject } from './checked-rules.js';

/** Where a checked rule names a field: a dot path into the observations of one or more of its reads. */
export interface RuleFieldPath {
  path: string;
  /** Where the rule names it, in words: "read plan, condition", "check parameter field". */
  where: string;
  /** The reads it may point into; empty when the rule names it for a check that may read any of them. */
  reads: string[];
  /**
   * True where the value is compared with values the rule lists or reads as a single value, so a reference ({ id,
   * scope }) must be read by its id; false where a whole reference is what is meant.
   */
  compared: boolean;
  /** The record type a selection inside the check names, when it names one. */
  recordType?: { recordType: string; recordVersion?: number };
}

/** The parts of a checked rule that name fields; a pack file rule and a registered rule both have them. */
export interface RuleWithFields {
  reads: readonly Pick<RuleRead, 'name' | 'where'>[];
  check: { params?: unknown };
  applicability?: readonly RuleApplicabilityCondition[];
  related?: readonly Pick<RuleRelatedSubject, 'from'>[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function conditionPaths(
  conditions: readonly RuleReadCondition[] | undefined,
  where: string,
  reads: string[],
  recordType?: RuleFieldPath['recordType'],
): RuleFieldPath[] {
  return (conditions ?? []).map((condition) => ({
    path: condition.field,
    where,
    reads,
    compared: 'oneOf' in condition,
    ...(recordType ? { recordType } : {}),
  }));
}

/**
 * The field paths a check's parameters name: every text value under a key `field` or ending in `Field`, at any depth,
 * and every condition of a selection. A selection's recordType narrows the paths inside it. Only the check's own
 * top-level `field`, and conditions with oneOf, are compared values.
 */
function parameterPaths(
  value: unknown,
  key: string,
  depth: number,
  recordType?: RuleFieldPath['recordType'],
): RuleFieldPath[] {
  if (Array.isArray(value)) return value.flatMap((item) => parameterPaths(item, key, depth + 1, recordType));
  if (!isObject(value)) return [];
  const narrowed =
    typeof value.recordType === 'string'
      ? {
          recordType: value.recordType,
          ...(typeof value.recordVersion === 'number' ? { recordVersion: value.recordVersion } : {}),
        }
      : recordType;
  return Object.entries(value).flatMap(([name, item]): RuleFieldPath[] => {
    if (typeof item === 'string' && (name === 'field' || /Field$/.test(name)) && item.includes('.'))
      return [
        {
          path: item,
          where: `check parameter ${depth === 0 ? name : `${key}.${name}`}`,
          reads: [],
          compared: depth === 0 && name === 'field',
          ...(narrowed ? { recordType: narrowed } : {}),
        },
      ];
    if (name === 'where' && Array.isArray(item) && item.every(isObject) && item.every((entry) => 'field' in entry))
      return conditionPaths(item as RuleReadCondition[], `check parameter ${key}.where`, [], narrowed);
    return parameterPaths(item, depth === 0 ? name : key, depth + 1, narrowed);
  });
}

/** Every field path a checked rule names, with where it names it and which reads it points into. */
export function ruleFieldPaths(rule: RuleWithFields): RuleFieldPath[] {
  return [
    ...rule.reads.flatMap((read) => conditionPaths(read.where, `read ${read.name}, condition`, [read.name])),
    ...(rule.applicability ?? []).map((condition) => ({
      path: condition.field,
      where: 'applicability',
      reads: [condition.input],
      compared: true,
    })),
    ...(rule.related ?? []).map((relation) => ({
      path: relation.from.field,
      where: 'related subject',
      reads: [relation.from.read],
      compared: false,
    })),
    ...parameterPaths(rule.check.params ?? {}, '', 0),
  ].filter((item) => item.path.includes('.'));
}
