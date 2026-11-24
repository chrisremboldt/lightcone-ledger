import { expect, test } from 'vitest';
import type {
  OrganizationCoverageResponse,
  PackAdoptionRecord,
  RuleEvaluationRecord,
  RulePackVersion,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { defineCheckedRule, findCheckKind } from '../../packages/domain/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  adoptionCommand,
  allowedModes,
  canChangeMode,
  carriedEntries,
  findingsByMode,
  latestRelieved,
  modeChangeCommand,
  newerVersion,
  packOriginLabel,
  parameterFields,
  parameterValues,
  shadowOnlyReason,
  successorCommand,
  versionChanges,
} from '../../apps/web/src/rule-adoption.js';

const ruleSpec: Parameters<typeof defineCheckedRule>[0] = {
  id: 'test.adoption-ui-floor',
  version: 1,
  title: 'Outside air stays above the floor',
  source: { kind: 'operator_procedure', reference: 'Fictional procedure 4.2', text: 'Stop at the floor.' },
  target: { subjectKind: 'aircraft' },
  reads: [
    { name: 'subject', type: 'fictional.reading', versions: [1], about: 'target', required: true, select: 'latest' },
  ],
  check: {
    kind: findCheckKind('value.within-limit', 1)!,
    params: { field: 'values.outsideAirTemperatureCelsius', comparison: 'above' },
  },
  adoptionParameters: [{ name: 'limit', title: 'Lowest temperature', valueType: 'number', minimum: -50, maximum: 50 }],
};
const rule = defineCheckedRule(ruleSpec);

function pack(leaves: RulePackVersion['leaves'], version = 1): RulePackVersion {
  const content = {
    packId: 'test.adoption-ui',
    version,
    title: 'Fictional floor procedure',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves,
  };
  return { ...content, digest: canonicalDigest(content) };
}

const shown = {
  organization: { id: 'organization:fictional', label: 'Fictional operator', revision: 4, projectedRevision: 4 },
  meta: {
    inputCut: { streams: { 'organization:fictional': 4 }, principalRevision: 2 },
    dependencyBasis: 'a'.repeat(64),
  },
} as unknown as OrganizationCoverageResponse;
const interval = { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' };

test('the adoption form is generated from the parameters the pack declares and pins the shown coverage', () => {
  const shownPack = pack([rule]);
  const fields = parameterFields(shownPack);
  expect(fields.map((field) => [field.leafId, field.parameter.name])).toEqual([['test.adoption-ui-floor', 'limit']]);
  expect(parameterValues(fields, {}).invalid?.parameter.name).toBe('limit');
  expect(parameterValues(fields, { 'test.adoption-ui-floor/limit': '99' }).invalid).toBeDefined();
  const { values } = parameterValues(fields, { 'test.adoption-ui-floor/limit': '-4' });
  expect(values).toEqual({ 'test.adoption-ui-floor': { limit: -4 } });
  const command = adoptionCommand(shown, shownPack, {
    mode: 'shadow',
    effectiveInterval: interval,
    note: 'Trial',
    parameters: values!,
  });
  expect(command).toMatchObject({
    kind: 'rule-pack.adopt',
    expectedRevision: 4,
    inputCut: { basisRevision: 4, principalRevision: 2 },
    expectedDependencyBasis: 'a'.repeat(64),
    pack: { packId: shownPack.packId, digest: shownPack.digest, leaves: [{ id: rule.id, digest: rule.digest }] },
    parameters: { 'test.adoption-ui-floor': { limit: -4 } },
    mode: 'shadow',
  });
  expect(allowedModes(shownPack)).toEqual(['shadow', 'active']);
});

test('a pack quoting proposed text offers shadow only and says why', () => {
  const proposed = pack([{ ...rule, source: { ...rule.source, kind: 'proposed_regulation' } }]);
  expect(allowedModes(proposed)).toEqual(['shadow']);
  expect(shadowOnlyReason(proposed)).toContain('proposed rule text, which is not in force');
});

test('a mode change revises only the mode of the latest adoption', () => {
  const adoption = {
    id: 'adoption-1',
    pack: pack([rule]),
    mode: 'shadow',
    effectiveInterval: interval,
    parameters: { 'test.adoption-ui-floor': { limit: 0 } },
    processing: { status: 'projected' },
    state: 'effective',
  } as unknown as PackAdoptionRecord;
  expect(canChangeMode(adoption)).toBe(true);
  expect(canChangeMode({ ...adoption, revisedBy: 'adoption-2' })).toBe(false);
  expect(modeChangeCommand(shown, adoption, 'active', 'Counted now')).toMatchObject({
    mode: 'active',
    revises: 'adoption-1',
    effectiveInterval: interval,
    parameters: { 'test.adoption-ui-floor': { limit: 0 } },
    note: 'Counted now',
  });
});

test('shadow findings are kept apart from counted ones, and relieved ones from both', () => {
  const finding = (id: string, mode: string, outcome: string) => ({ id, mode, latestEvaluation: { outcome } });
  const findings = [
    finding('a', 'active', 'attention'),
    finding('b', 'shadow', 'attention'),
    finding('c', 'active', 'relieved'),
  ] as unknown as SubjectFindingRecord[];
  const split = findingsByMode(findings);
  expect(split.counted.map((item) => item.id)).toEqual(['a']);
  expect(split.proposed.map((item) => item.id)).toEqual(['b']);
  expect(split.relieved.map((item) => item.id)).toEqual(['c']);
});

test('lists a rule under relieved only when its latest evaluation is relieved', () => {
  const evaluation = (id: string, ruleId: string, outcome: string) =>
    ({ id, pack: { id: 'pack' }, rule: { id: ruleId }, outcome }) as unknown as RuleEvaluationRecord;
  // Newest first, as the evaluations read returns them.
  const relieved = latestRelieved([
    evaluation('3', 'rule-a', 'relieved'),
    evaluation('2', 'rule-b', 'attention'),
    evaluation('1', 'rule-b', 'relieved'),
  ]);
  expect(relieved.map((item) => item.id)).toEqual(['3']);
});

test('a newer registered version is offered on the latest adoption in effect, with what it changes', () => {
  const adoption = {
    id: 'adoption-1',
    pack: pack([rule]),
    mode: 'active',
    effectiveInterval: interval,
    parameters: { 'test.adoption-ui-floor': { limit: 3 } },
    processing: { status: 'projected' },
    state: 'effective',
  } as unknown as PackAdoptionRecord;
  const catalog = [
    {
      packId: 'test.adoption-ui',
      version: 1,
      title: 'Fictional floor procedure',
      digest: 'b'.repeat(64),
      origin: { kind: 'built_in' as const },
    },
    {
      packId: 'test.adoption-ui',
      version: 2,
      title: 'Fictional floor procedure',
      digest: 'c'.repeat(64),
      origin: { kind: 'built_in' as const },
    },
    {
      packId: 'test.other',
      version: 9,
      title: 'Another fictional pack',
      digest: 'd'.repeat(64),
      origin: { kind: 'built_in' as const },
    },
  ];
  expect(newerVersion(adoption, catalog)).toBe(2);
  expect(newerVersion(adoption, catalog.slice(0, 1))).toBeNull();
  expect(newerVersion({ ...adoption, revisedBy: 'adoption-2' }, catalog)).toBeNull();
  expect(
    newerVersion({ ...adoption, succeededBy: { id: 'adoption-2', version: 2, start: interval.start } }, catalog),
  ).toBeNull();
  expect(newerVersion({ ...adoption, state: 'scheduled' }, catalog)).toBeNull();
  expect(canChangeMode({ ...adoption, succeededBy: { id: 'adoption-2', version: 2, start: interval.start } })).toBe(
    false,
  );

  const changed = defineCheckedRule({ ...ruleSpec, version: 2, title: 'Outside air stays above the new floor' });
  const added = defineCheckedRule({ ...ruleSpec, id: 'test.adoption-ui-added', title: 'A second floor' });
  const newer = pack([changed, added], 2);
  const changes = versionChanges(pack([rule]), newer);
  expect(changes.added.map((leaf) => leaf.id)).toEqual(['test.adoption-ui-added']);
  expect(changes.removed).toEqual([]);
  expect(changes.changed.map((leaf) => leaf.id)).toEqual(['test.adoption-ui-floor']);
  expect(changes.parameters.map((field) => [field.leafId, field.parameter.name])).toEqual([
    ['test.adoption-ui-floor', 'limit'],
    ['test.adoption-ui-added', 'limit'],
  ]);
  expect(versionChanges(newer, pack([rule])).removed.map((leaf) => leaf.id)).toEqual(['test.adoption-ui-added']);
  expect(carriedEntries(changes.parameters, adoption)).toEqual({ 'test.adoption-ui-floor/limit': '3' });

  const start = '2026-06-01T00:00:00.000Z';
  expect(successorCommand(shown, adoption, newer, { mode: 'shadow', start, note: 'Newer procedures' })).toMatchObject({
    kind: 'rule-pack.adopt',
    succeeds: 'adoption-1',
    mode: 'shadow',
    pack: { packId: 'test.adoption-ui', version: 2, digest: newer.digest },
    effectiveInterval: { start, end: interval.end },
    note: 'Newer procedures',
  });
});

test('the adopt form says where each pack came from', () => {
  expect(packOriginLabel({ kind: 'built_in' })).toBe('built into Ledger');
  expect(packOriginLabel({ kind: 'organization_file', file: 'alpha-dispatch.waiver-exw-0042-v1.pack.json' })).toBe(
    'organization file alpha-dispatch.waiver-exw-0042-v1.pack.json',
  );
});
