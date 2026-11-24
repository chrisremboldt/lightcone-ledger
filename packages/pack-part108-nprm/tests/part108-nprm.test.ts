import Ajv from 'ajv';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import { getRulePackVersion, getRuleSource } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_SOURCE_ID, part108NprmRulePack } from '../src/index.js';

describe('retained Part 108 NPRM coverage', () => {
  it('serves the unchanged original document through source and built package loaders', async () => {
    const original = await readFile(new URL('../resources/govinfo-fr-2025-14992.htm', import.meta.url));
    const source = (await getRuleSource(PART108_NPRM_SOURCE_ID))!;
    expect(source.bytes).toEqual(original);
    expect(source).toMatchObject({
      sourceId: PART108_NPRM_SOURCE_ID,
      byteLength: 1386012,
      sha256: '2ebbbb6d3ecfe4757a192c1850d67373e75c18d7df52136a607737ee9672f7f7',
      contentType: 'text/html; charset=utf-8',
      filename: 'govinfo-fr-2025-14992.htm',
      readPath: `/v1/rule-sources/${PART108_NPRM_SOURCE_ID}/content`,
    });
    expect(sha256(source.bytes)).toBe(source.sha256);
    const packaged = await import('../dist/index.js');
    const [builtSource] = packaged.part108NprmRulePack().sources;
    expect(builtSource.bytes).toEqual(original);
    source.bytes.fill(0);
    expect((await getRuleSource(PART108_NPRM_SOURCE_ID))!.bytes).toEqual(original);
    expect(await getRuleSource('unknown')).toBeUndefined();
    // Slow file work: generous so a busy machine does not fail it.
  }, 60_000);

  it('pins proposed paragraphs from regulatory text as manual and unsupported coverage without bindings', async () => {
    const source = (await getRuleSource(PART108_NPRM_SOURCE_ID))!;
    const pack = getRulePackVersion('ledger.part108-nprm', 1)!;
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(pack).toMatchObject({
      packId: 'ledger.part108-nprm',
      version: 1,
      title: 'Part 108 NPRM coverage',
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
      digest: '2829a7d8708be8bdd1d97771a0fdbaca2376a70769633ae546e31b1de5298584',
      bindings: [],
    });
    expect(pack.leaves.map(({ id, coverage }) => ({ id, coverage }))).toEqual([
      { id: 'ledger.nprm.108.550.a', coverage: 'manual' },
      { id: 'ledger.nprm.108.560.a', coverage: 'unsupported' },
    ]);
    for (const leaf of pack.leaves) {
      if (leaf.source.kind !== 'proposed_regulation') throw new Error('NPRM leaves must retain proposed source text');
      const span = leaf.source.textSpan;
      const snippet = source.bytes.subarray(span.start, span.end);
      expect(span).toMatchObject({ unit: 'utf8_byte', sourceId: source.sourceId });
      expect(snippet.toString('utf8')).toBe(leaf.source.text);
      expect(snippet.length).toBe(leaf.source.byteLength);
      expect(sha256(snippet)).toBe(leaf.source.sha256);
      expect(leaf.source.document).toMatchObject({
        sourceId: source.sourceId,
        sha256: source.sha256,
        byteLength: source.byteLength,
      });
      expect(leaf.source.text.startsWith('    (a)')).toBe(true);
      expect(source.bytes.subarray(span.end, span.end + 7).toString('utf8')).toBe('    (b)');
      expect(source.bytes.subarray(span.start - 90, span.start).toString('utf8')).toContain(
        leaf.id === 'ledger.nprm.108.550.a'
          ? 'Sec.  108.550  Communication and ground risk assessments.'
          : 'Sec.  108.560  Safety management system.',
      );
      expect(leaf.dependencies).toEqual([]);
      expect(leaf).not.toHaveProperty('bindingId');
      expect(leaf).not.toHaveProperty('bindingVersion');
      expect(leaf).not.toHaveProperty('bindingDigest');
      const { digest, ...content } = leaf;
      expect(canonicalDigest(content)).toBe(digest);
    }
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
    expect(getRulePackVersion('ledger.part108-nprm', 4)).toBeUndefined();
    expect(part108NprmRulePack().versions[0]).toEqual(pack);
  });

  it('refuses to assemble when the retained document no longer matches its pinned bytes', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs')>();
      const readFileSync = (path: URL) => {
        const bytes = original.readFileSync(path);
        bytes[0] ^= 1;
        return bytes;
      };
      return { ...original, readFileSync, default: { ...original, readFileSync } };
    });
    try {
      const reloaded = await import('../src/part108-nprm-v1.js');
      expect(() => reloaded.part108NprmRulePack()).toThrow(
        'Retained Part 108 NPRM source does not match its pinned original bytes',
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
