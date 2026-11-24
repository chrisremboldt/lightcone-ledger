import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import { demoProceduresRulePack } from '../src/rules/demo-procedures-pack.js';
import { getRulePackVersion } from '../src/rule-pack-registry.js';
import { authorizationEvidenceLeafV1, authorizationStatusBindingV1 } from '../src/rules/authorization-evidence-v1.js';
import { commandLinkEvidenceLeafV1, commandLinkStatusBindingV1 } from '../src/rules/command-link-evidence-v1.js';
import { flightObservationBindingV1, flightRuleLeavesV1 } from '../src/rules/demo-procedures-v1.js';

vi.mock('../src/evaluator.js', () => {
  throw new Error('Retained rule packs must not load the active evaluator registry');
});

describe('draft procedure pack catalog', () => {
  it('registers exactly the versions the domain assembles', () => {
    expect(demoProceduresRulePack.versions.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const version of demoProceduresRulePack.versions)
      expect(getRulePackVersion(demoProceduresRulePack.packId, version.version)).toEqual(version);
  });

  it('refuses to load a changed procedure without a new pack version', async () => {
    vi.resetModules();
    vi.doMock('../src/rules/demo-procedures-v1.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/rules/demo-procedures-v1.js')>();
      const [first, ...rest] = original.flightRuleLeavesV1;
      return { ...original, flightRuleLeavesV1: [{ ...first, title: `${first.title} revised` }, ...rest] };
    });
    try {
      await expect(import('../src/rules/demo-procedures-pack.js')).rejects.toThrow(
        'Rule pack ledger.demo-procedures version 1 changed without a new pack version',
      );
    } finally {
      vi.doUnmock('../src/rules/demo-procedures-v1.js');
      vi.resetModules();
    }
  });

  it('preserves the exact serialized version-one response independently of active evaluator metadata', () => {
    const pack = getRulePackVersion('ledger.demo-procedures', 1)!;
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(pack).toMatchObject({
      packId: 'ledger.demo-procedures',
      version: 1,
      title: 'Demo flight procedures',
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
      digest: '83c479d2eb9d7e0f2687ae6fa06cc54efdbfb0ff46a6118391db19d764d676d5',
    });
    expect(sha256(Buffer.from(JSON.stringify(pack), 'utf8'))).toBe(
      '2256d06353ae2b7202130cf1e10cad6ef184496887f770c8e0a051a4d805eab3',
    );
    expect(getRulePackVersion('ledger.demo-procedures', 7)).toBeUndefined();
    expect(getRulePackVersion('unknown', 1)).toBeUndefined();
  });

  it('retains each source snippet as exact UTF-8 bytes and binds the canonical content digests', () => {
    const originalBindings = [flightObservationBindingV1, authorizationStatusBindingV1, commandLinkStatusBindingV1];
    const originalLeaves = [...flightRuleLeavesV1, authorizationEvidenceLeafV1, commandLinkEvidenceLeafV1];
    for (const version of [1, 2, 3]) {
      const pack = getRulePackVersion('ledger.demo-procedures', version)!;
      for (const binding of pack.bindings) {
        const original = originalBindings.find((candidate) => candidate.id === binding.id)!;
        const { digest, ...content } = binding;
        expect(content).toEqual(original);
        expect(digest).toBe(canonicalDigest(content));
      }
      for (const leaf of pack.leaves) {
        if (!('bindingId' in leaf)) throw new Error('Company procedures must retain their automated bindings');
        const original = originalLeaves.find((candidate) => candidate.id === leaf.id)!;
        const binding = pack.bindings.find(
          (candidate) => candidate.id === leaf.bindingId && candidate.version === leaf.bindingVersion,
        )!;
        const bytes = Buffer.from(original.source.text, 'utf8');
        expect(leaf.source.text).toBe(original.source.text);
        expect(leaf.source.encoding).toBe('utf-8');
        expect(leaf.source.byteLength).toBe(bytes.length);
        expect(leaf.source.sha256).toBe(sha256(bytes));
        expect(leaf.source.textSpan.unit).toBe('utf8_byte');
        expect(bytes.subarray(leaf.source.textSpan.start, leaf.source.textSpan.end).toString('utf8')).toBe(
          original.source.text.slice(original.source.textSpan.start, original.source.textSpan.end),
        );
        expect(leaf).toMatchObject({
          version: original.version,
          bindingId: binding.id,
          bindingVersion: binding.version,
          bindingDigest: binding.digest,
          coverage: 'automated',
        });
        const { digest, ...content } = leaf;
        expect(digest).toBe(canonicalDigest(content));
      }
      const { digest, ...content } = pack;
      expect(digest).toBe(canonicalDigest(content));
    }
  });

  it('adds the authorization procedure only in the explicit version-two catalog', () => {
    const original = getRulePackVersion('ledger.demo-procedures', 1)!;
    const pack = getRulePackVersion('ledger.demo-procedures', 2)!;
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(pack).toMatchObject({
      packId: original.packId,
      version: 2,
      title: original.title,
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
      digest: '2c5a817396018cd1104d0a162435a8e39326fb4c2ebb0445ff1874749d197a10',
    });
    expect(pack.bindings).toHaveLength(2);
    expect(pack.leaves).toHaveLength(3);
    expect(pack.bindings[0]).toEqual(original.bindings[0]);
    expect(pack.leaves.slice(0, 2)).toEqual(original.leaves);
    expect(pack.bindings[1]).toMatchObject({
      id: 'ledger.authorization-status',
      version: 1,
      inputKind: 'airspace.status',
      intervalHandling: 'reported_utc_half_open_required',
      callbackDurationUnit: 'minute',
    });
    expect(pack.leaves[2]).toMatchObject({
      id: 'ledger.demo.authorization-evidence-recorded',
      version: 1,
      dependencies: ['authorization.status', 'authorization.scope', 'clock.wall'],
      bindingId: pack.bindings[1].id,
      bindingVersion: pack.bindings[1].version,
      bindingDigest: pack.bindings[1].digest,
    });
  });

  it('adds the command-link procedure only in the explicit version-three catalog', () => {
    const previous = getRulePackVersion('ledger.demo-procedures', 2)!;
    const pack = getRulePackVersion('ledger.demo-procedures', 3)!;
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(pack).toMatchObject({
      packId: previous.packId,
      version: 3,
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
      digest: '46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188',
    });
    expect(pack.bindings).toHaveLength(3);
    expect(pack.leaves).toHaveLength(4);
    expect(pack.bindings.slice(0, 2)).toEqual(previous.bindings);
    expect(pack.leaves.slice(0, 3)).toEqual(previous.leaves);
    expect(pack.bindings[2]).toMatchObject({
      id: commandLinkStatusBindingV1.id,
      version: 1,
      inputKind: 'command-link.status',
      correctionHandling: 'immutable_receipts_selected_by_caller',
    });
    expect(pack.leaves[3]).toMatchObject({
      id: commandLinkEvidenceLeafV1.id,
      version: 1,
      bindingId: pack.bindings[2].id,
      bindingVersion: pack.bindings[2].version,
      bindingDigest: pack.bindings[2].digest,
      dependencies: ['command-link.reports', 'command-link.scope', 'clock.wall'],
      coverage: 'automated',
    });
  });

  it('isolates retained definitions and every pack version from caller mutation', () => {
    const original = getRulePackVersion('ledger.demo-procedures', 1)!;
    const changed = getRulePackVersion('ledger.demo-procedures', 1)!;
    const originalVersionTwo = getRulePackVersion('ledger.demo-procedures', 2)!;
    const changedVersionTwo = getRulePackVersion('ledger.demo-procedures', 2)!;
    const originalVersionThree = getRulePackVersion('ledger.demo-procedures', 3)!;
    const changedVersionThree = getRulePackVersion('ledger.demo-procedures', 3)!;
    const retainedLeaves = structuredClone(flightRuleLeavesV1);
    const retainedBinding = structuredClone(flightObservationBindingV1);
    changed.leaves[0].source.text = 'Caller replacement';
    changed.leaves[0].source.textSpan.start = 5;
    changed.leaves[0].dependencies.push('clock.wall');
    changed.bindings[0].supportedFields.pop();
    changed.leaves.pop();
    changedVersionTwo.leaves[0].source.text = 'Caller replacement through version two';
    changedVersionTwo.bindings.pop();
    changedVersionThree.leaves[3].source.text = 'Caller replacement through version three';
    changedVersionThree.bindings.pop();
    expect(getRulePackVersion('ledger.demo-procedures', 1)).toEqual(original);
    expect(getRulePackVersion('ledger.demo-procedures', 2)).toEqual(originalVersionTwo);
    expect(getRulePackVersion('ledger.demo-procedures', 3)).toEqual(originalVersionThree);
    expect(flightRuleLeavesV1).toEqual(retainedLeaves);
    expect(flightObservationBindingV1).toEqual(retainedBinding);
    expect(Object.isFrozen(flightRuleLeavesV1)).toBe(true);
    expect(Object.isFrozen(flightRuleLeavesV1[0].source.textSpan)).toBe(true);
    expect(Object.isFrozen(flightObservationBindingV1.supportedFields)).toBe(true);
  });
});
