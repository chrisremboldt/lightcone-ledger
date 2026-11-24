import { describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import type { CheckedRuleLeaf, RetainedDocumentSource, RulePackVersion } from '@ledger/contracts';
import { recordCompleteV2 } from '../src/check-kind-library-records.js';
import { checkedRuleProblem, defineCheckedRule } from '../src/checked-rules.js';
import { getRulePackVersion, registerRulePack } from '../src/rule-pack-registry.js';

const documentBytes = Buffer.from(
  '<p>Invented notice.</p>\n    (a) Keep a record of each person.\n    (b) Other.\n',
  'utf8',
);
const paragraph = '    (a) Keep a record of each person.\n';

function retainedSource(sourceId: string): RetainedDocumentSource {
  const start = documentBytes.indexOf(paragraph);
  const text = paragraph;
  return {
    kind: 'proposed_regulation',
    reference: 'Invented proposed section 1(a)',
    text,
    encoding: 'utf-8',
    byteLength: Buffer.byteLength(text),
    sha256: sha256(Buffer.from(text, 'utf8')),
    textSpan: { start, end: start + Buffer.byteLength(text), unit: 'utf8_byte', sourceId },
    document: {
      sourceId,
      url: 'https://example.invalid/notice.htm',
      sha256: sha256(documentBytes),
      byteLength: documentBytes.length,
      contentType: 'text/html; charset=utf-8',
      readPath: `/v1/rule-sources/${sourceId}/content`,
    },
  };
}

function leaf(source: RetainedDocumentSource): CheckedRuleLeaf {
  return defineCheckedRule({
    id: 'test.retained.record',
    version: 1,
    title: 'Person record held',
    source,
    target: { subjectKind: 'person' },
    reads: [
      { name: 'record', type: 'operator.record', versions: [1], about: 'target', required: false, select: 'latest' },
    ],
    check: { kind: recordCompleteV2, params: { recordType: 'person.standing', recordVersion: 1 } },
  });
}

function pack(packId: string, leaves: RulePackVersion['leaves']): RulePackVersion {
  const content = {
    packId,
    version: 1,
    title: 'Retained source test pack',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves,
  };
  return { ...content, digest: canonicalDigest(content) };
}

function registration(packId: string, sourceId: string, leaves: RulePackVersion['leaves']) {
  const document = retainedSource(sourceId).document;
  return {
    packId,
    versions: [pack(packId, leaves)],
    sources: [{ ...document, filename: 'notice.htm', bytes: documentBytes }],
  };
}

describe('a checked rule quoting a retained document', () => {
  it('keeps the pinned source as given and is registered when its span matches the document', () => {
    const source = retainedSource('test.retained-notice-1');
    const rule = leaf(source);
    expect(rule.source).toEqual(source);
    expect(rule.coverage).toBe('automated');
    expect(checkedRuleProblem(rule)).toBeUndefined();
    registerRulePack(registration('test.retained-pack-1', 'test.retained-notice-1', [rule]));
    expect(getRulePackVersion('test.retained-pack-1', 1)?.digest).toBe(pack('test.retained-pack-1', [rule]).digest);
  });

  it('refuses a span whose length differs from the quoted text', () => {
    const source = retainedSource('test.retained-notice-2');
    const { digest: _digest, ...content } = leaf(source);
    const stretched = {
      ...content,
      source: { ...source, textSpan: { ...source.textSpan, end: source.textSpan.end + 1 } },
    };
    expect(checkedRuleProblem({ ...stretched, digest: canonicalDigest(stretched) })).toBe(
      'Rule test.retained.record version 1 has a source span outside its text',
    );
  });

  it('refuses to register a rule whose span does not hold its text in the retained document', () => {
    const source = retainedSource('test.retained-notice-3');
    const { start, end } = source.textSpan;
    const shifted = leaf({ ...source, textSpan: { ...source.textSpan, start: start + 1, end: end + 1 } });
    expect(checkedRuleProblem(shifted)).toBeUndefined();
    expect(() => registerRulePack(registration('test.retained-pack-3', 'test.retained-notice-3', [shifted]))).toThrow(
      'Rule test.retained.record version 1 does not match its span in rule source test.retained-notice-3',
    );
    const unknown = leaf(retainedSource('test.retained-notice-missing'));
    expect(() =>
      registerRulePack({ packId: 'test.retained-pack-4', versions: [pack('test.retained-pack-4', [unknown])] }),
    ).toThrow('does not match its span in rule source test.retained-notice-missing');
  });
});
