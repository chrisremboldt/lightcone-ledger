import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { CheckedRuleLeafSchema, type AcceptedObservation, type CheckedRuleLeaf } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { dateWithinMonthsV2 } from '../src/check-kind-library-records.js';
import { defineCheckedRule, type CheckedRuleSpec } from '../src/checked-rules.js';
import { relatedPlan, resolveRelatedSet, type RelatedLookup } from '../src/related-subjects.js';
import { findingIdFor, ruleEvaluationObservationDigest } from '../src/rule-evaluations.js';

const validLeaf = new Ajv({ strict: false }).compile(CheckedRuleLeafSchema);

const source = {
  kind: 'operator_procedure' as const,
  reference: 'Example procedure 4.1 (invented for this test)',
  text: 'Each person assigned to a flight completes recurrent training within the months the organization sets.',
};

const assignments: CheckedRuleLeaf['reads'][number] = {
  name: 'assignments',
  type: 'operator.record',
  versions: [1],
  about: 'target',
  required: true,
  select: 'all',
  where: [{ field: 'values.recordType', oneOf: ['operation.role-assignment'] }],
};
const training: CheckedRuleLeaf['reads'][number] = {
  name: 'subject',
  type: 'operator.record',
  versions: [1],
  about: { related: 'person' },
  required: false,
  select: 'all',
  where: [{ field: 'values.recordType', oneOf: ['person.training'] }],
};

function trainingSpec(overrides: Partial<CheckedRuleSpec> = {}): CheckedRuleSpec {
  return {
    id: 'example.assigned-person-training',
    version: 1,
    title: 'Every assigned person’s recurrent training',
    source,
    target: { subjectKind: 'flight' },
    related: [
      {
        name: 'person',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'insufficient',
        from: { read: 'assignments', field: 'values.record.personId' },
      },
    ],
    reads: [assignments, training],
    check: {
      kind: dateWithinMonthsV2,
      params: { select: { recordType: 'person.training', recordVersion: 1 }, field: 'values.record.completedOn' },
    },
    adoptionParameters: [{ name: 'months', title: 'Months since training', valueType: 'integer', minimum: 1 }],
    ...overrides,
  };
}

describe('a leaf declares the subjects its records name', () => {
  it('leaves related out of a leaf that declares none, so its digest is unchanged', () => {
    const { related: _related, ...spec } = trainingSpec({ reads: [assignments, { ...training, about: 'target' }] });
    const leaf = defineCheckedRule(spec);
    expect('related' in leaf).toBe(false);
    const { digest, ...content } = leaf;
    expect(digest).toBe(canonicalDigest(content));
    expect(validLeaf(leaf)).toBe(true);
  });

  it('accepts a leaf that fans out over a reference field and reads about the related subject', () => {
    const leaf = defineCheckedRule(trainingSpec());
    expect(leaf.related).toEqual(trainingSpec().related);
    expect(validLeaf(leaf)).toBe(true);
  });
});

describe('a leaf’s related subjects are checked before it is used', () => {
  const problem = (overrides: Partial<CheckedRuleSpec>) => {
    try {
      defineCheckedRule(trainingSpec(overrides));
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };
  const relation = trainingSpec().related![0]!;

  it('refuses a read about a related subject the leaf does not declare', () => {
    expect(problem({ reads: [assignments, { ...training, about: { related: 'crew' } }] })).toMatch(
      /reads subject about crew, which is not a declared related subject/,
    );
  });

  it('refuses a related subject taken from a later read, or from no read', () => {
    expect(problem({ reads: [training, assignments] })).toMatch(/reads about person before assignments/);
    expect(problem({ related: [{ ...relation, from: { read: 'roster', field: 'values.record.personId' } }] })).toMatch(
      /from roster, which is not a read or the subject state/,
    );
  });

  it('refuses chains, two names alike and two fan-outs', () => {
    const second = { ...relation, name: 'trainer', fanOut: false, from: { read: 'subject', field: 'subject' } };
    expect(problem({ related: [relation, second] })).toMatch(/from subject, a read about another related subject/);
    expect(problem({ related: [relation, { ...relation }] })).toMatch(/names a related subject twice/);
    expect(problem({ related: [relation, { ...relation, name: 'other' }] })).toMatch(/more than one related subject/);
    expect(problem({ related: [{ ...relation, whenNone: 'empty' }] })).toMatch(/cannot read as empty/);
  });

  it('refuses a related kind the reference field does not name', () => {
    expect(problem({ related: [{ ...relation, subjectKind: 'aircraft' }] })).toMatch(
      /takes person \(aircraft\) from assignments values.record.personId, which names a person/,
    );
  });

  it('accepts a re-queue window read about the evaluated subject and refuses one read about the related subject', () => {
    const windowEnd = { read: 'assignments', field: 'values.record.endsAt' };
    expect(problem({ related: [{ ...relation, requeue: { windowEnd, endedWithinDays: 7 } }] })).toBeUndefined();
    expect(problem({ related: [{ ...relation, requeue: { windowEnd: { ...windowEnd, read: 'subject' } } }] })).toMatch(
      /re-queues person by the window of subject, which is not the subject state or a read about the evaluated subject/,
    );
  });

  it('leaves the digest of a rule without a re-queue window as it was', () => {
    const plain = defineCheckedRule(trainingSpec());
    const windowed = defineCheckedRule(
      trainingSpec({
        related: [{ ...relation, requeue: { windowEnd: { read: 'assignments', field: 'values.record.endsAt' } } }],
      }),
    );
    expect(windowed.digest).not.toBe(plain.digest);
    expect(defineCheckedRule(trainingSpec()).digest).toBe(plain.digest);
    expect('requeue' in plain.related![0]!).toBe(false);
  });
});

describe('the subjects a read names are resolved at the evidence cut', () => {
  const relation = trainingSpec().related![0]!;
  const lookup: RelatedLookup = {
    ledgerKind: (id) => ({ 'person-ledger': 'person', 'aircraft-ledger': 'aircraft' })[id],
    alias: (sourceId, kind, id) =>
      sourceId === 'roster' && kind === 'person' && id === 'p-aliased' ? 'person-ledger' : undefined,
  };
  function assignment(
    id: string,
    personId: unknown,
    overrides: Partial<AcceptedObservation> = {},
  ): AcceptedObservation {
    return {
      id,
      receiptId: `receipt-${id}`,
      eventId: id,
      artifactId: 'artifact',
      sourceId: 'roster',
      type: 'operator.record',
      version: 1,
      subject: { kind: 'flight', id: 'flight-1', scope: 'ledger', ledgerId: 'flight-1', resolution: 'ledger' },
      occurredAt: '2026-11-02T10:00:00.000Z',
      receivedAt: '2026-11-02T10:00:01.000Z',
      fidelity: 'synthetic_contract',
      observation: { values: { recordType: 'operation.role-assignment', record: { personId } } },
      ...overrides,
    } as AcceptedObservation;
  }

  it('gives each distinct subject once, with every observation that named it', () => {
    const set = resolveRelatedSet(
      relation,
      [
        assignment('a1', { id: 'p-1', scope: 'source' }),
        assignment('a2', { id: 'p-aliased', scope: 'source' }),
        assignment('a3', { id: 'person-ledger', scope: 'ledger' }),
        assignment('a4', { id: 'p-1', scope: 'source' }),
      ],
      lookup,
    );
    expect(set.blank).toEqual([]);
    expect(set.candidates).toEqual([
      {
        subject: { scope: 'ledger', kind: 'person', id: 'person-ledger' },
        subjectKey: 'ledger/person/person-ledger',
        resolved: true,
        namedBy: [
          { observationId: 'a2', field: 'values.record.personId' },
          { observationId: 'a3', field: 'values.record.personId' },
        ],
      },
      {
        subject: { scope: 'source', kind: 'person', id: 'p-1', sourceId: 'roster' },
        subjectKey: 'source/roster/person/p-1',
        resolved: true,
        namedBy: [
          { observationId: 'a1', field: 'values.record.personId' },
          { observationId: 'a4', field: 'values.record.personId' },
        ],
      },
    ]);
  });

  it('keeps a reference that names no subject of the kind under what was written, and reports blank ones', () => {
    const set = resolveRelatedSet(
      relation,
      [
        assignment('a1', { id: 'aircraft-ledger', scope: 'ledger' }),
        assignment('a2', { id: 'missing', scope: 'ledger' }),
        assignment('a3', undefined),
        assignment('a4', { id: '   ', scope: 'source' }),
        assignment('a5', 'p-1'),
      ],
      lookup,
    );
    expect(set.candidates.map((item) => [item.subjectKey, item.resolved])).toEqual([
      ['ledger/person/aircraft-ledger', false],
      ['ledger/person/missing', false],
    ]);
    expect(set.blank.map((item) => [item.observationId, item.value])).toEqual([
      ['a3', 'absent'],
      ['a4', '{"id":"   ","scope":"source"}'],
      ['a5', '"p-1"'],
    ]);
    const plan = relatedPlan([set]);
    expect(plan).toMatchObject({
      kind: 'results',
      targetProblem: {
        evidenceState: 'insufficient',
        reasonCode: 'related_reference_unresolved',
        details: { count: 3 },
      },
    });
  });

  it('reads a record that names no subject as naming none, in the rule’s own words when it gives them', () => {
    const single = {
      ...relation,
      fanOut: false,
      whenNone: 'insufficient' as const,
      whenNoneSummary: 'No person is named on the assignment.',
    };
    const plan = relatedPlan([resolveRelatedSet(single, [assignment('a1', undefined)], lookup)]);
    expect(plan).toMatchObject({
      kind: 'target_only',
      problem: {
        evidenceState: 'insufficient',
        reasonCode: 'related_subject_missing',
        summary: 'No person is named on the assignment.',
      },
    });
  });

  it('treats an ambiguous envelope subject as unresolved and reads a source identity as it is', () => {
    const byRole = { ...relation, from: { read: 'assignments', field: 'secondarySubject' } };
    const set = resolveRelatedSet(
      byRole,
      [
        assignment('a1', undefined, {
          secondarySubject: { kind: 'person', id: 'p-9', scope: 'source', resolution: 'ambiguous' },
        }),
        assignment('a2', undefined, {
          secondarySubject: { kind: 'person', id: 'p-8', scope: 'source', resolution: 'unresolved' },
        }),
        assignment('a3', undefined),
      ],
      lookup,
    );
    expect(set.candidates.map((item) => [item.subjectKey, item.resolved])).toEqual([
      ['source/roster/person/p-8', true],
      ['source/roster/person/p-9', false],
    ]);
    expect(set.blank.map((item) => item.observationId)).toEqual(['a3']);
  });

  it('reports two subjects where one is read as conflicting, and none as the leaf says', () => {
    const single = { ...relation, fanOut: false };
    const two = resolveRelatedSet(
      single,
      [assignment('a1', { id: 'p-1', scope: 'source' }), assignment('a2', { id: 'p-2', scope: 'source' })],
      lookup,
    );
    expect(relatedPlan([two])).toMatchObject({
      kind: 'target_only',
      problem: { evidenceState: 'conflicting', reasonCode: 'related_subject_conflicting', evidence: ['a1', 'a2'] },
    });
    expect(relatedPlan([resolveRelatedSet(single, [], lookup)])).toMatchObject({
      kind: 'target_only',
      problem: { evidenceState: 'insufficient', reasonCode: 'related_subject_missing' },
    });
    expect(relatedPlan([resolveRelatedSet({ ...relation, whenNone: 'not_applicable' }, [], lookup)])).toMatchObject({
      kind: 'target_only',
      problem: { outcome: 'not_applicable', reasonCode: 'related_subject_none' },
    });
    // Read as empty, a relation that names none leaves its reads empty and the check runs.
    expect(relatedPlan([resolveRelatedSet({ ...single, whenNone: 'empty' }, [], lookup)])).toEqual({
      kind: 'results',
      fixed: {},
    });
    // A record that names no subject reads as none, not as an unresolved reference.
    expect(
      relatedPlan([resolveRelatedSet({ ...single, whenNone: 'empty' }, [assignment('a0', undefined)], lookup)]),
    ).toEqual({ kind: 'results', fixed: {} });
    const one = resolveRelatedSet(single, [assignment('a1', { id: 'p-1', scope: 'source' })], lookup);
    expect(relatedPlan([one])).toMatchObject({
      kind: 'results',
      fixed: { person: { subjectKey: 'source/roster/person/p-1' } },
    });
  });

  it('refuses to evaluate part of more than fifty related subjects', () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      assignment(`a${index}`, { id: `p-${index}`, scope: 'source' }),
    );
    expect(relatedPlan([resolveRelatedSet(relation, many, lookup)])).toEqual({
      kind: 'target_only',
      problem: {
        applicability: 'applicable',
        evidenceState: 'insufficient',
        outcome: 'pending',
        reasonCode: 'related_subject_limit',
        summary: '51 related subjects are named; one evaluation reads at most 50.',
        evidence: [],
        details: { count: 51, limit: 50 },
      },
    });
    expect(relatedPlan([resolveRelatedSet(relation, many.slice(0, 50), lookup)])).toMatchObject({ kind: 'results' });
  });
});

describe('results without a related subject keep their identities', () => {
  it('keeps the id of a finding with no related subject, and gives each related subject its own', () => {
    const args = ['tenant-example', 'ledger/flight/flight-example', 'example.pack', 'example.leaf'] as const;
    // Pinned before related subjects existed: findings recorded then keep their ids.
    expect(findingIdFor(...args)).toBe('finding:6e1155e2167743c6a9aef71690f3bb72f48cceff7993ae496aec72ffb708ffde');
    expect(findingIdFor(...args, '')).toBe(findingIdFor(...args));
    const first = findingIdFor(...args, 'source/roster/person/p-1');
    expect(first).not.toBe(findingIdFor(...args));
    expect(first).not.toBe(findingIdFor(...args, 'source/roster/person/p-2'));
  });

  it('keeps the observation digest of an evaluation that reads no related subject', () => {
    const parts = {
      adoptionId: 'adoption-example',
      pack: { id: 'example.pack', version: 1, digest: 'a'.repeat(64) },
      leaf: { id: 'example.leaf', version: 1, digest: 'b'.repeat(64) },
      parameters: { months: 12 },
      inputs: [{ name: 'subject', observationIds: ['o-1'], truncated: false }],
    };
    expect(ruleEvaluationObservationDigest(parts)).toBe(
      canonicalDigest({ format: 'ledger.rule-evaluation-inputs.1', ...parts }),
    );
    expect(
      ruleEvaluationObservationDigest({
        ...parts,
        related: { name: 'person', subjectKey: 'source/roster/person/p-1', namedBy: [] },
      }),
    ).not.toBe(ruleEvaluationObservationDigest(parts));
  });
});
