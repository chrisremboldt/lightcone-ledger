import { ruleFieldPaths, type PackFileCheckedRule, type RuleFieldPath } from '@ledger/contracts';
import { fieldWords, readRecordsWords } from './pack-labels.js';

// The fields a built rule reads and the parameters it fixes, in the words a person reads: every field by its label.

/** The conditions that only say which record type a read takes, which the line of what it reads already names. */
const recordTypeFields = new Set(['values.recordType', 'values.recordVersion']);

/** Where a rule names a field, in words. */
function whereWords(rule: PackFileCheckedRule, item: RuleFieldPath): string {
  if (item.where === 'applicability') return 'decides whether the rule applies';
  if (item.where === 'related subject') return 'names the related subject';
  const name = /^read (.+), condition$/u.exec(item.where)?.[1];
  const read = name === undefined ? undefined : rule.reads.find((candidate) => candidate.name === name);
  if (read) return `selects which ${readRecordsWords(read)} count`;
  return item.where;
}

/** Every field the rule reads, each once, by its label and where the rule names it. */
export function fieldsReadWords(rule: PackFileCheckedRule): string {
  const items = ruleFieldPaths(rule).filter((item) => !recordTypeFields.has(item.path));
  return (
    [...new Set(items.map((item) => `${fieldWords(rule, item)} (${whereWords(rule, item)})`))].join('; ') || 'none'
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

type Narrowed = RuleFieldPath['recordType'];

function conditionWords(rule: PackFileCheckedRule, condition: unknown, narrowed: Narrowed): string {
  if (!isObject(condition) || typeof condition.field !== 'string') return JSON.stringify(condition);
  const label = fieldWords(rule, { path: condition.field, reads: [], ...(narrowed ? { recordType: narrowed } : {}) });
  if (Array.isArray(condition.oneOf)) return `${label} is ${condition.oneOf.map(String).join(' or ')}`;
  if (condition.filled === true) return `${label} is filled`;
  return `${label} ${JSON.stringify(condition)}`;
}

/** A parameter's value with every field path in it named by its label. */
function valueWords(rule: PackFileCheckedRule, name: string, value: unknown, narrowed: Narrowed): string {
  if (typeof value === 'string' && (name === 'field' || /Field$/u.test(name)) && value.includes('.'))
    return fieldWords(rule, { path: value, reads: [], ...(narrowed ? { recordType: narrowed } : {}) });
  if (Array.isArray(value)) {
    if (name === 'where') return value.map((condition) => conditionWords(rule, condition, narrowed)).join(' and ');
    return `[${value.map((item) => valueWords(rule, name, item, narrowed)).join(', ')}]`;
  }
  if (isObject(value)) {
    const inner =
      typeof value.recordType === 'string'
        ? {
            recordType: value.recordType,
            ...(typeof value.recordVersion === 'number' ? { recordVersion: value.recordVersion } : {}),
          }
        : narrowed;
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${key}: ${valueWords(rule, key, item, inner)}`)
      .join('; ')} }`;
  }
  return JSON.stringify(value);
}

/** The check's fixed parameters, each by name, with fields by their labels. */
export function parametersWords(rule: PackFileCheckedRule): string {
  const entries = Object.entries(rule.check.params ?? {});
  return entries.length
    ? entries.map(([name, value]) => `${name} ${valueWords(rule, name, value, undefined)}`).join('; ')
    : 'none';
}
