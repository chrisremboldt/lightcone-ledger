import { describe, expect, it } from 'vitest';
import {
  isCheckedRuleLeaf,
  type AdoptionParameterValues,
  type CheckedRuleLeaf,
  type RuleAdoptionParameter,
  type RuleRead,
} from '../../packages/contracts/src/index.js';
import { findCheckKind, type CheckInputs, type CheckObservation } from '../../packages/domain/src/check-kinds.js';
import { checkParameters, runCheckedRule } from '../../packages/domain/src/checked-rules.js';
import { standardRulePacks } from '../../packages/standard-packs/src/index.js';

// A summary a person reads names what was read by the record type's title and its fields' labels, never by a field
// path or a record type id. Every shipped rule is evaluated on no input and on records that are there but empty.

const EVALUATED_AT = '2026-10-15T12:00:00.000Z';
const EARLIER = '2026-10-15T11:00:00.000Z';
const ADOPTION = { start: '2026-10-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };

function parameterValue(parameter: RuleAdoptionParameter): string | number | boolean {
  if (parameter.valueType === 'boolean') return false;
  if (parameter.valueType === 'string')
    return parameter.options?.[0] ?? (/timeZone$/i.test(parameter.name) ? 'UTC' : 'Invented value');
  return parameter.minimum !== undefined && parameter.minimum > 0 ? parameter.minimum : 1;
}

function adoptionValues(leaf: CheckedRuleLeaf): AdoptionParameterValues {
  if (!leaf.adoptionParameters.length) return {};
  return {
    [leaf.id]: Object.fromEntries(leaf.adoptionParameters.map((item) => [item.name, parameterValue(item)])),
  };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let at = target;
  for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as Record<string, unknown>;
  at[parts.at(-1)!] = value;
}

/** A record of the read's type that meets its conditions and the rule's applicability, and holds nothing else. */
function partialObservation(leaf: CheckedRuleLeaf, read: RuleRead): CheckObservation {
  const observation: Record<string, unknown> = {};
  for (const condition of read.where ?? [])
    setPath(observation, condition.field, 'filled' in condition ? 'Invented value' : condition.oneOf[0]);
  for (const condition of leaf.applicability.filter((item) => item.input === read.name))
    setPath(observation, condition.field, condition.oneOf[0]);
  if (read.type === 'operator.record') {
    const values = (observation.values ??= {}) as Record<string, unknown>;
    values.record ??= {};
  }
  return { id: `partial-${read.name}`, type: read.type, version: read.versions[0]!, occurredAt: EARLIER, observation };
}

function evaluations(leaf: CheckedRuleLeaf) {
  const parameters = checkParameters(leaf, adoptionValues(leaf)[leaf.id] ? adoptionValues(leaf) : undefined);
  const kind = findCheckKind(leaf.check.kind, leaf.check.version);
  const clock = {
    mode: 'wall' as const,
    evaluatedAt: EVALUATED_AT,
    ...(kind?.adoptionDates ? { adoption: ADOPTION } : {}),
  };
  const partial: CheckInputs = Object.fromEntries([
    ...(leaf.subjectState
      ? [
          [
            leaf.subjectState.name,
            [
              {
                id: 'state',
                type: `${leaf.target.subjectKind}.state`,
                version: 1,
                occurredAt: EVALUATED_AT,
                observation: {},
              },
            ],
          ],
        ]
      : []),
    ...leaf.reads.map((read) => [read.name, [partialObservation(leaf, read)]]),
  ]);
  return [
    { input: 'no input', outcome: runCheckedRule(leaf, parameters, {}, clock) },
    { input: 'partial input', outcome: runCheckedRule(leaf, parameters, partial, clock) },
  ];
}

const shippedLeaves = standardRulePacks().flatMap((registration) =>
  registration.versions.flatMap((pack) =>
    pack.leaves.filter(isCheckedRuleLeaf).map((leaf) => ({ name: `${pack.packId}@${pack.version} ${leaf.id}`, leaf })),
  ),
);

describe('summaries name records and fields as a person does', () => {
  it('evaluates shipped rules', () => {
    expect(shippedLeaves.length).toBeGreaterThan(50);
  });

  it.each(shippedLeaves)('$name', ({ leaf }) => {
    for (const { input, outcome } of evaluations(leaf)) {
      const where = `${input}: ${outcome.summary}`;
      expect(outcome.summary, where).not.toContain('values.');
      expect(outcome.summary, where).not.toMatch(/\b[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+@\d+/);
      expect(outcome.summary, where).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b/);
    }
  });
});
