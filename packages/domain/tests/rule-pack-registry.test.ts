import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RulePackVersion } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  getRulePackVersion,
  getRuleSource,
  isRulePackRegistered,
  registerRulePack,
  type RetainedRuleSource,
} from '../src/rule-pack-registry.js';

function draftVersion(packId: string, version: number, title = 'Fictional checklist'): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId,
    version,
    title,
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves: [],
  };
  return { ...content, digest: canonicalDigest(content) };
}

function retainedSource(sourceId: string, text = 'Fictional operator manual'): RetainedRuleSource {
  const bytes = Buffer.from(text, 'utf8');
  return {
    sourceId,
    url: 'https://example.test/manual.txt',
    sha256: sha256(bytes),
    byteLength: bytes.length,
    contentType: 'text/plain; charset=utf-8',
    readPath: `/v1/rule-sources/${sourceId}/content`,
    filename: 'manual.txt',
    bytes,
  };
}

const uniqueId = (label: string) => `test.${label}-${randomUUID()}`;

describe('rule pack registry', () => {
  it('resolves exact registered versions and sources as isolated copies', async () => {
    const packId = uniqueId('pack');
    const sourceId = uniqueId('source');
    const versions = [draftVersion(packId, 1), draftVersion(packId, 2, 'Fictional checklist revised')];
    registerRulePack({ packId, versions, sources: [retainedSource(sourceId)] });
    expect(isRulePackRegistered(packId)).toBe(true);
    expect(getRulePackVersion(packId, 2)).toEqual(versions[1]);
    expect(getRulePackVersion(packId, 3)).toBeUndefined();
    expect(getRulePackVersion(uniqueId('unknown'), 1)).toBeUndefined();
    const changed = getRulePackVersion(packId, 1)!;
    changed.title = 'Caller replacement';
    versions[0].title = 'Registration caller replacement';
    expect(getRulePackVersion(packId, 1)!.title).toBe('Fictional checklist');
    const source = (await getRuleSource(sourceId))!;
    expect(source.bytes.toString('utf8')).toBe('Fictional operator manual');
    source.bytes.fill(0);
    expect((await getRuleSource(sourceId))!.bytes.toString('utf8')).toBe('Fictional operator manual');
    expect(await getRuleSource(uniqueId('unknown'))).toBeUndefined();
  });

  it('refuses a version whose content changed without a new digest', () => {
    const packId = uniqueId('changed');
    const changed = { ...draftVersion(packId, 1), title: 'Changed after pinning' };
    expect(() => registerRulePack({ packId, versions: [changed] })).toThrow(
      `Rule pack ${packId} version 1 does not match its digest`,
    );
    expect(isRulePackRegistered(packId)).toBe(false);
  });

  it('refuses duplicate packs, versions and sources without partial registration', async () => {
    const packId = uniqueId('duplicate');
    registerRulePack({ packId, versions: [draftVersion(packId, 1)] });
    expect(() => registerRulePack({ packId, versions: [draftVersion(packId, 2)] })).toThrow(
      `Rule pack ${packId} is already registered`,
    );
    expect(getRulePackVersion(packId, 2)).toBeUndefined();

    const repeated = uniqueId('repeated');
    expect(() =>
      registerRulePack({ packId: repeated, versions: [draftVersion(repeated, 1), draftVersion(repeated, 1)] }),
    ).toThrow(`Rule pack ${repeated} version 1 is listed twice`);
    const foreign = uniqueId('foreign');
    expect(() => registerRulePack({ packId: foreign, versions: [draftVersion(packId, 1)] })).toThrow(
      `Rule pack ${foreign} contains a version of ${packId}`,
    );
    expect(() => registerRulePack({ packId: foreign, versions: [] })).toThrow(`Rule pack ${foreign} has no versions`);

    const sourceId = uniqueId('source');
    const first = uniqueId('first');
    registerRulePack({ packId: first, versions: [draftVersion(first, 1)], sources: [retainedSource(sourceId)] });
    const second = uniqueId('second');
    expect(() =>
      registerRulePack({
        packId: second,
        versions: [draftVersion(second, 1)],
        sources: [retainedSource(sourceId, 'Another fictional manual')],
      }),
    ).toThrow(`Rule source ${sourceId} is already registered`);
    expect(isRulePackRegistered(second)).toBe(false);
    expect((await getRuleSource(sourceId))!.bytes.toString('utf8')).toBe('Fictional operator manual');
  });

  it('refuses retained source bytes that do not match their pinned hash', async () => {
    const packId = uniqueId('tampered');
    const sourceId = uniqueId('source');
    const tampered = { ...retainedSource(sourceId), bytes: Buffer.from('Fictional operator manuaL', 'utf8') };
    expect(() => registerRulePack({ packId, versions: [draftVersion(packId, 1)], sources: [tampered] })).toThrow(
      `Rule source ${sourceId} does not match its pinned bytes`,
    );
    expect(isRulePackRegistered(packId)).toBe(false);
    expect(await getRuleSource(sourceId)).toBeUndefined();
  });
});
