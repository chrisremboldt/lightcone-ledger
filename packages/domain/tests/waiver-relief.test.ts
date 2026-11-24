import { describe, expect, it } from 'vitest';
import { reliefStatement, type CheckedRuleLeaf, type PackAdoptionAcceptance } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { findCheckKind } from '../src/check-kinds.js';
import { defineCheckedRule, type CheckedRuleOutcome } from '../src/checked-rules.js';
import '../src/check-kind-library.js';
import {
  coveringProvisions,
  provisionKey,
  reliefDigestPart,
  reliefFor,
  relievedAnswer,
  type ProvisionResult,
} from '../src/waiver-relief.js';

const RELIEVED = { packId: 'test.relieved-pack', ruleId: 'test.relieved-pack.rule', subjectKind: 'flight' as const };

function provision(
  id: string,
  relieves = [{ packId: RELIEVED.packId, ruleIds: [RELIEVED.ruleId] }],
  subjectKind: 'flight' | 'organization' = 'flight',
): CheckedRuleLeaf {
  return defineCheckedRule({
    id,
    version: 1,
    title: `Provision ${id}`,
    source: { kind: 'waiver_or_exemption', reference: `Invented waiver, ${id}`, text: `Invented provision ${id}.` },
    target: { subjectKind },
    reads: [
      { name: 'subject', type: 'flight.report', versions: [1], about: 'target', required: true, select: 'latest' },
    ],
    check: { kind: findCheckKind('value.one-of', 1)!, params: { field: 'values.activity', expected: ['landed'] } },
    relieves,
  });
}

function adoption(
  id: string,
  packId: string,
  mode: 'active' | 'shadow',
  leaves: CheckedRuleLeaf[],
): { id: string; record: PackAdoptionAcceptance } {
  const content = {
    packId,
    version: 1,
    title: `Invented waiver ${packId}`,
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  return {
    id,
    record: {
      id,
      acceptedRevision: 3,
      actor: { id: 'person-fictional', name: 'Robin Vale' },
      pack: { ...content, digest: canonicalDigest(content) },
      effectiveInterval: { start: '2026-10-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
      mode,
    } as unknown as PackAdoptionAcceptance,
  };
}

const attention: CheckedRuleOutcome = {
  applicability: 'applicable',
  evidenceState: 'supported',
  outcome: 'attention',
  reasonCode: 'value_unexpected',
  summary: 'The latest recorded value is other.',
  evidence: ['observation-1'],
  issues: ['issue-1'],
};

/** A provision's result that supports the subject's coverage. */
const cites: ProvisionResult = {
  evaluationId: 'evaluation-provision',
  outcome: 'pass',
  evidenceState: 'supported',
  reasonCode: 'value_expected',
  summary: 'The latest flight plan cites the certificate.',
};

/** Every provision about the relieved rule's kind of subject, each with a supported result. */
function covering(adoptions: ReturnType<typeof adoption>[]) {
  return new Map(coveringProvisions(adoptions, RELIEVED).map((item) => [provisionKey(item), cites] as const));
}

describe('finding the relief for a rule', () => {
  it('takes an active adoption before a shadow one, then the lowest pack id', () => {
    const adoptions = [
      adoption('a1', 'test.waiver-b', 'shadow', [provision('test.waiver-b.1')]),
      adoption('a2', 'test.waiver-c', 'active', [provision('test.waiver-c.1')]),
      adoption('a3', 'test.waiver-a', 'shadow', [provision('test.waiver-a.1')]),
    ];
    expect(reliefFor(adoptions, RELIEVED, covering(adoptions))).toMatchObject({
      mode: 'active',
      waiver: { adoptionId: 'a2', pack: { id: 'test.waiver-c' }, adoptedBy: { name: 'Robin Vale' } },
      provision: { ruleId: 'test.waiver-c.1', title: 'Provision test.waiver-c.1' },
    });
    expect(
      reliefFor(
        adoptions.filter(({ id }) => id !== 'a2'),
        RELIEVED,
        covering(adoptions),
      )?.waiver.pack.id,
    ).toBe('test.waiver-a');
  });

  it('finds none for a rule no adoption relieves, and never from the rule’s own pack', () => {
    const adoptions = [adoption('a1', 'test.waiver-a', 'active', [provision('test.waiver-a.1')])];
    expect(reliefFor(adoptions, { ...RELIEVED, ruleId: 'test.relieved-pack.other' })).toBeUndefined();
    const own = [
      adoption('a2', RELIEVED.packId, 'active', [
        provision('test.relieved-pack.2', [{ packId: RELIEVED.packId, ruleIds: [RELIEVED.ruleId] }]),
      ]),
    ];
    expect(reliefFor(own, RELIEVED)).toBeUndefined();
  });
});

describe('the answer recorded under relief', () => {
  const grant = (mode: 'active' | 'shadow', result: ProvisionResult | undefined = cites) => {
    const adoptions = [adoption('a1', 'test.waiver-a', mode, [provision('test.waiver-a.1')])];
    return reliefFor(
      adoptions,
      RELIEVED,
      new Map([[provisionKey({ adoptionId: 'a1', ruleId: 'test.waiver-a.1' }), result]]),
    )!;
  };

  it('is the rule’s own answer without relief', () => {
    expect(relievedAnswer(attention, undefined)).toEqual({
      outcome: 'attention',
      reasonCode: 'value_unexpected',
      summary: attention.summary,
      issues: ['issue-1'],
    });
  });

  it('is relieved under an active waiver, keeping what the rule found and due again when the waiver ends', () => {
    const answer = relievedAnswer(attention, grant('active'));
    expect(answer).toMatchObject({
      outcome: 'relieved',
      reasonCode: 'relieved_by_waiver',
      summary: 'Relieved by Provision test.waiver-a.1, Invented waiver test.waiver-a, adopted by Robin Vale.',
      nextBoundary: '2026-12-01T00:00:00.000Z',
      relief: {
        mode: 'active',
        otherwise: { outcome: 'attention', reasonCode: 'value_unexpected', issues: ['issue-1'] },
      },
    });
    expect(answer.issues).toBeUndefined();
    expect(answer.summary).not.toMatch(/\b(compliant|authori[sz]ed|permitted)\b/i);
  });

  it('keeps an earlier boundary the check names', () => {
    const answer = relievedAnswer({ ...attention, nextBoundary: '2026-11-01T00:00:00.000Z' }, grant('active'));
    expect(answer.nextBoundary).toBe('2026-11-01T00:00:00.000Z');
  });

  it('keeps the rule’s own answer under a shadow waiver, with what it would relieve beside it', () => {
    const answer = relievedAnswer(attention, grant('shadow'));
    expect(answer).toMatchObject({ outcome: 'attention', issues: ['issue-1'], relief: { mode: 'shadow' } });
    expect(answer.relief!.otherwise).toBeUndefined();
  });

  it('names the waiver adoption, its revision and mode and the provision in the observation digest', () => {
    expect(reliefDigestPart(grant('active'))).toMatchObject({ adoptionId: 'a1', acceptedRevision: 3, mode: 'active' });
    expect(canonicalDigest(reliefDigestPart(grant('active')))).not.toBe(
      canonicalDigest(reliefDigestPart(grant('shadow'))),
    );
  });
});

describe('relief only where the provision covers the subject', () => {
  const doesNotCite: ProvisionResult = {
    evaluationId: 'evaluation-provision-2',
    outcome: 'attention',
    evidenceState: 'supported',
    reasonCode: 'value_unexpected',
    summary: 'The latest flight plan does not cite the certificate.',
  };
  const adoptions = (mode: 'active' | 'shadow') => [
    adoption('a1', 'test.waiver-a', mode, [provision('test.waiver-a.1')]),
  ];
  const results = (result: ProvisionResult | undefined) =>
    new Map([[provisionKey({ adoptionId: 'a1', ruleId: 'test.waiver-a.1' }), result]]);

  it('reads the result of a provision about the same kind of subject, and of no other', () => {
    expect(coveringProvisions(adoptions('active'), RELIEVED)).toEqual([
      { adoptionId: 'a1', packId: 'test.waiver-a', ruleId: 'test.waiver-a.1' },
    ]);
    const other = [
      adoption('a2', 'test.waiver-b', 'active', [provision('test.waiver-b.1', undefined, 'organization')]),
    ];
    expect(coveringProvisions(other, RELIEVED)).toEqual([]);
    // A provision about another kind of subject relieves the rule as before, for every subject.
    const grant = reliefFor(other, RELIEVED)!;
    expect(grant.coverage).toBeUndefined();
    expect(relievedAnswer(attention, grant).outcome).toBe('relieved');
  });

  it('keeps the rule’s own result, and says why, when the provision’s check is not supported', () => {
    const grant = reliefFor(adoptions('active'), RELIEVED, results(doesNotCite))!;
    expect(grant.coverage).toEqual({ covered: false, provisionResult: doesNotCite });
    const answer = relievedAnswer(attention, grant);
    expect(answer).toMatchObject({
      outcome: 'attention',
      reasonCode: 'value_unexpected',
      summary: attention.summary,
      issues: ['issue-1'],
      nextBoundary: '2026-12-01T00:00:00.000Z',
      relief: { mode: 'active', coverage: { covered: false } },
    });
    expect(answer.relief!.otherwise).toBeUndefined();
    expect(reliefStatement(answer.relief!)).toBe(
      'Invented waiver test.waiver-a, adopted by Robin Vale, relieves this rule, but its provision Provision test.waiver-a.1 does not cover this subject, so the rule’s own result stands. The provision’s check last recorded: The latest flight plan does not cite the certificate.',
    );
  });

  it('does not relieve a subject the provision has recorded nothing for yet', () => {
    const grant = reliefFor(adoptions('active'), RELIEVED, results(undefined))!;
    expect(grant.coverage).toEqual({ covered: false });
    expect(relievedAnswer(attention, grant).outcome).toBe('attention');
    expect(reliefStatement(relievedAnswer(attention, grant).relief!)).toMatch(
      /has recorded no result for this subject yet\.$/,
    );
  });

  it('relieves the subject while the provision’s result is supported', () => {
    const grant = reliefFor(adoptions('active'), RELIEVED, results(cites))!;
    expect(grant.coverage).toEqual({ covered: true, provisionResult: cites });
    expect(relievedAnswer(attention, grant)).toMatchObject({ outcome: 'relieved', reasonCode: 'relieved_by_waiver' });
  });

  it('records in shadow what the waiver would relieve by the same test', () => {
    const covered = relievedAnswer(attention, reliefFor(adoptions('shadow'), RELIEVED, results(cites)));
    expect(reliefStatement(covered.relief!)).toMatch(/^Would be relieved by /);
    const notCovered = relievedAnswer(attention, reliefFor(adoptions('shadow'), RELIEVED, results(doesNotCite)));
    expect(notCovered.outcome).toBe('attention');
    expect(reliefStatement(notCovered.relief!)).toMatch(/^Would not be relieved by .* does not cover this subject\./);
  });

  it('prefers a provision that covers the subject, and names the provision’s result in the digest', () => {
    const both = [
      adoption('a1', 'test.waiver-a', 'active', [provision('test.waiver-a.1')]),
      adoption('a2', 'test.waiver-b', 'active', [provision('test.waiver-b.1')]),
    ];
    const mixed = new Map([
      [provisionKey({ adoptionId: 'a1', ruleId: 'test.waiver-a.1' }), doesNotCite],
      [provisionKey({ adoptionId: 'a2', ruleId: 'test.waiver-b.1' }), cites],
    ]);
    expect(reliefFor(both, RELIEVED, mixed)?.waiver.adoptionId).toBe('a2');
    const cited = reliefDigestPart(reliefFor(adoptions('active'), RELIEVED, results(cites))!);
    const notCited = reliefDigestPart(reliefFor(adoptions('active'), RELIEVED, results(doesNotCite))!);
    expect(canonicalDigest(cited)).not.toBe(canonicalDigest(notCited));
  });
});
