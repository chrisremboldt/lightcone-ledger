import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  FINDING_PACKET_FORMAT,
  FINDING_PACKET_LIMITATIONS,
  FINDING_PACKET_LIMITS,
  FINDING_PACKET_V2_FORMAT,
  FINDING_PACKET_V2_LIMITATIONS,
  FINDING_PACKET_V2_LIMITS,
  type EvidenceEnvelope,
  type FindingPacket,
  type FindingPacketV2,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest, canonicalize, entryHash, sha256 } from '../../packages/integrity/src/index.js';
import {
  assembleFindingPacket,
  assembleFindingPacketV2,
  originalsLeftOut,
} from '../../packages/evidence/src/finding-packet-assembly.js';
import {
  BATTERY_RESERVE_LEAF_ID,
  batteryReserveLeafV1,
  exampleOperationsVersionOne,
} from '../../packages/pack-example-operations/src/index.js';
import * as verifier from '../../tools/verifier/finding-packet.mjs';
import { toyFinding, toyIssue, verifyOffline, type ToyFindingOptions } from './finding-packet-fixture.js';
import { forbiddenLiterals, repositoryRoot, scanSource } from './generalisation-guard-scan.js';

const { verifyFindingPacket } = verifier;
const battery = {
  leaf: batteryReserveLeafV1(),
  pack: exampleOperationsVersionOne(),
  observationType: 'battery.state',
  parameters: { limit: 30 },
};

function packet(options: ToyFindingOptions = {}): FindingPacket {
  return assembleFindingPacket(toyFinding(options).sources, toyIssue);
}

function failure(value: FindingPacket, expectedManifestDigest?: string): { code: string; path: string } {
  try {
    verifyFindingPacket(value, { expectedManifestDigest });
  } catch (error: any) {
    return error.issues[0];
  }
  throw new Error('The tampered packet verified');
}

const envelopeOf = (value: FindingPacket, index: number) =>
  JSON.parse(value.events[index]!.canonicalEnvelope) as EvidenceEnvelope;
const eventIndex = (value: FindingPacket, eventId: string) =>
  value.events.findIndex((entry) => JSON.parse(entry.canonicalEnvelope).eventId === eventId);

/** Changes one event's envelope and re-encodes its entry, keeping its previous hash. */
function rewriteEvent(value: FindingPacket, eventId: string, change: (envelope: EvidenceEnvelope) => void): void {
  const index = eventIndex(value, eventId);
  const envelope = envelopeOf(value, index);
  change(envelope);
  const entry = value.events[index]!;
  entry.canonicalEnvelope = canonicalize(envelope);
  entry.envelopeDigest = sha256(entry.canonicalEnvelope);
  entry.entryHash = entryHash(
    value.manifest.tenantId,
    envelope.streamId,
    BigInt(envelope.sequence),
    entry.previousHash,
    entry.envelopeDigest,
  );
}

/** Changes the evaluation recorded in its event and restates its digest in the manifest. */
function rewriteEvaluation(value: FindingPacket, change: (evaluation: any) => void): void {
  const summary = value.manifest.evaluations[0]!;
  rewriteEvent(value, summary.id, (envelope) => change(envelope.payload.evaluation));
  const envelope = envelopeOf(value, eventIndex(value, summary.id));
  summary.digest = canonicalDigest({ ...(envelope.payload.evaluation as object), recordedAt: envelope.receivedAt });
}

/** Restates every inventory digest from the included records, then the manifest digest. */
function reseal(value: FindingPacket, inventory = true): FindingPacket {
  if (inventory)
    for (const item of value.manifest.inventory) {
      const record =
        item.kind === 'event'
          ? value.events[eventIndex(value, item.id)]
          : item.kind === 'receipt'
            ? value.receipts.find((receipt) => receipt.id === item.id)
            : item.kind === 'artifact'
              ? value.artifacts.find((artifact) => artifact.id === item.id)
              : value.origins.find((origin) => origin.recordId === item.id);
      item.digest = canonicalDigest(record);
    }
  value.manifestDigest = canonicalDigest(value.manifest);
  return value;
}

describe('offline verification of the generic finding packet', () => {
  test('keeps the format constants of the packet contract', () => {
    expect(verifier.FINDING_PACKET_FORMAT).toBe(FINDING_PACKET_FORMAT);
    expect({ ...verifier.FINDING_PACKET_LIMITS }).toEqual({ ...FINDING_PACKET_LIMITS });
    expect([...verifier.FINDING_PACKET_LIMITATIONS]).toEqual([...FINDING_PACKET_LIMITATIONS]);
  });

  test('verifies a toy finding and a battery reserve finding with the same code', () => {
    const toy = packet({ mode: 'shadow' });
    const reserve = packet({ rule: battery });
    expect(reserve.manifest.finding.ruleId).toBe(BATTERY_RESERVE_LEAF_ID);
    for (const value of [toy, reserve]) {
      const result = verifyFindingPacket(value, { expectedManifestDigest: value.manifestDigest });
      expect(result).toMatchObject({
        status: 'verified',
        format: FINDING_PACKET_FORMAT,
        findingId: value.manifest.finding.id,
        manifestDigest: value.manifestDigest,
        authenticity: { checked: true },
        counts: value.manifest.counts,
      });
      expect(result.notChecked.length).toBeGreaterThan(0);
    }
    for (const options of [
      { sourceKind: 'proposed_regulation' as const },
      { subjectState: { name: 'toy-state', kind: 'aircraft' as const, revision: null, state: null } },
    ]) {
      const value = packet(options);
      expect(verifyFindingPacket(value, { expectedManifestDigest: value.manifestDigest }).status).toBe('verified');
    }
  });

  test('says it checked internal consistency only when no digest was kept separately', () => {
    const value = packet();
    const result = verifyFindingPacket(value);
    expect(result.status).toBe('internally_consistent');
    expect(result.authenticity).toEqual({
      checked: false,
      message: expect.stringMatching(/only the internal consistency.*not that it is the packet that was issued/),
    });
    expect(failure(value, canonicalDigest({ toy: 'kept elsewhere' }))).toMatchObject({ code: 'packet_anchor' });
  });

  const tampered: [string, string, (value: FindingPacket) => FindingPacket][] = [
    ['a: a field outside the format', 'packet_shape', (value) => reseal(Object.assign(value, { extra: true }))],
    [
      'a: a manifest that differs from its digest',
      'packet_manifest_digest',
      (value) => {
        value.manifest.issuedBy = 'toy-someone-else';
        return value;
      },
    ],
    [
      'b: an envelope that does not round-trip',
      'packet_envelope_bytes',
      (value) => {
        value.events[0]!.canonicalEnvelope = JSON.stringify(envelopeOf(value, 0), null, 1);
        return value;
      },
    ],
    [
      'b: an envelope digest that does not recompute',
      'packet_entry',
      (value) => {
        value.events[0]!.envelopeDigest = canonicalDigest({ toy: 'other' });
        return reseal(value);
      },
    ],
    [
      'b: an entry hash that does not recompute',
      'packet_entry',
      (value) => {
        value.events[0]!.entryHash = canonicalDigest({ toy: 'other' });
        return reseal(value);
      },
    ],
    [
      'b: another encoding version',
      'packet_encoding',
      (value) => {
        (value.events[0] as { encodingVersion: string }).encodingVersion = 'ledger.v5.sha256';
        return reseal(value);
      },
    ],
    [
      'b: an event of another tenant',
      'packet_tenant',
      (value) => {
        rewriteEvent(value, 'toy-adoption', (envelope) => (envelope.tenantId = 'toy-other-tenant'));
        return reseal(value);
      },
    ],
    [
      'b: an entry that does not link to the included entry before it',
      'packet_chain',
      (value) => {
        value.events[eventIndex(value, 'toy-observation-1')]!.previousHash = canonicalDigest({ toy: 'gap' });
        rewriteEvent(value, 'toy-observation-1', () => undefined);
        return reseal(value);
      },
    ],
    [
      'c: an inventory digest that does not match',
      'packet_inventory',
      (value) => {
        value.manifest.inventory[0]!.digest = canonicalDigest({ toy: 'other' });
        return reseal(value, false);
      },
    ],
    [
      'c: an included record left out of the inventory',
      'packet_inventory',
      (value) => {
        value.manifest.inventory = value.manifest.inventory.filter((item) => item.kind !== 'artifact');
        return reseal(value);
      },
    ],
    [
      'c: a receipt no evaluation read',
      'packet_inventory',
      (value) => {
        value.receipts.push({ ...value.receipts[0]!, id: 'toy-receipt-unread' });
        return reseal(value);
      },
    ],
    [
      'c: counts that differ from the records',
      'packet_counts',
      (value) => {
        value.manifest.counts.receipts = 2;
        return reseal(value);
      },
    ],
    [
      'd: an evaluation digest that is not its record',
      'packet_evaluation',
      (value) => {
        rewriteEvent(value, 'toy-evaluation-1', (envelope) => {
          (envelope.payload.evaluation as { summary: string }).summary = 'Changed after the fact.';
        });
        return reseal(value);
      },
    ],
    [
      'd: an evaluation of another rule',
      'packet_evaluation',
      (value) => {
        rewriteEvaluation(value, (evaluation) => (evaluation.rule.id = 'toy.another-rule'));
        return reseal(value);
      },
    ],
    [
      "d: evaluations that do not start at the finding's initial evaluation",
      'packet_evaluation',
      (value) => {
        value.manifest.finding.initialEvaluationId = 'toy-evaluation-0';
        return reseal(value);
      },
    ],
    [
      'e: a pack whose digest does not recompute',
      'packet_adoption',
      (value) => {
        rewriteEvent(value, 'toy-adoption', (envelope) => {
          (envelope.payload.acceptance as { pack: { title: string } }).pack.title = 'Changed pack';
        });
        const envelope = envelopeOf(value, eventIndex(value, 'toy-adoption'));
        value.manifest.adoptions[0]!.digest = canonicalDigest({
          ...(envelope.payload.acceptance as object),
          id: envelope.eventId,
          acceptedAt: envelope.receivedAt,
        });
        return reseal(value);
      },
    ],
    [
      'e: an adoption whose mode differs from the evaluation',
      'packet_adoption',
      (value) => {
        rewriteEvaluation(value, (evaluation) => (evaluation.adoption.mode = 'active'));
        value.manifest.evaluations[0]!.mode = 'active';
        return reseal(value);
      },
    ],
    [
      "f: a read outside the evaluation's input cut",
      'packet_observation',
      (value) => {
        rewriteEvaluation(value, (evaluation) => (evaluation.inputCut.streams['toy-source-stream'] = 1));
        return reseal(value);
      },
    ],
    [
      'f: a receipt that does not link to its observation',
      'packet_observation',
      (value) => {
        value.receipts[0]!.eventId = 'toy-observation-0';
        return reseal(value);
      },
    ],
    [
      'f: evidence the evaluation did not read',
      'packet_observation',
      (value) => {
        rewriteEvaluation(value, (evaluation) => (evaluation.evidence[0].observationId = 'toy-observation-0'));
        return reseal(value);
      },
    ],
    [
      "g: a correction outside the evaluation's input cut",
      'packet_correction',
      (value) => {
        rewriteEvaluation(value, (evaluation) => (evaluation.inputCut.streams['toy-correction'] = 0));
        return reseal(value);
      },
    ],
    [
      'g: a correction event missing from the packet',
      'packet_correction',
      (value) => {
        value.manifest.evaluations[0]!.corrections[0]!.eventId = 'toy-missing-withdrawal';
        return reseal(value);
      },
    ],
    [
      'h: a subject-state digest that differs from the recorded state',
      'packet_subject_state',
      (value) => {
        value.manifest.evaluations[0]!.subjectState = {
          name: 'toy-state',
          kind: 'aircraft',
          revision: null,
          digest: canonicalDigest({ toy: 'state' }),
        };
        return reseal(value);
      },
    ],
    [
      "i: a hazard origin that pins none of the packet's evaluations",
      'packet_hazard',
      (value) => {
        (value.origins[0]!.origin as { evaluationDigest: string }).evaluationDigest = canonicalDigest({ toy: 'x' });
        value.manifest.decisions.hazards[0]!.originDigest = canonicalDigest(value.origins[0]);
        return reseal(value);
      },
    ],
    [
      'i: an assessment that is not of the hazard',
      'packet_hazard',
      (value) => {
        rewriteEvent(value, 'toy-assessment', (envelope) => {
          envelope.payload.acceptance = { subjectId: 'toy-other-hazard', kind: 'risk.assess' };
        });
        return reseal(value);
      },
    ],
    [
      'j: statements that do not match the adoption modes',
      'packet_statements',
      (value) => {
        value.manifest.statements = value.manifest.statements.slice(1);
        return reseal(value);
      },
    ],
    [
      'a treatment that names no evaluation in the packet',
      'packet_treatment',
      (value) => {
        value.manifest.decisions.treatments.push({ id: 'toy-treatment', evaluationId: 'toy-other', action: 'x' });
        return reseal(value);
      },
    ],
  ];

  test.each(tampered)('refuses %s', (_, code, tamper) => {
    for (const options of [{ mode: 'shadow' as const }, { mode: 'shadow' as const, rule: battery }]) {
      const value = tamper(structuredClone(packet(options)));
      const issue = failure(value, value.manifestDigest);
      expect(issue.code).toBe(code);
      expect(issue.path).toMatch(/^\$/);
    }
  });

  test('the CLI verifies the packet bytes offline and exits by what it could check', () => {
    const value = packet({ rule: battery });
    const bytes = canonicalize(value);
    const verified = verifyOffline(bytes, ['--expected-manifest-sha256', value.manifestDigest]);
    expect(verified).toMatchObject({ status: 0, result: { status: 'verified', manifestDigest: value.manifestDigest } });
    expect(verifyOffline(bytes)).toMatchObject({
      status: 2,
      result: { status: 'internally_consistent', authenticity: { checked: false } },
    });
    const other = verifyOffline(bytes, ['--expected-manifest-sha256', canonicalDigest({ toy: 'other' })]);
    expect(other).toMatchObject({ status: 1, result: { status: 'failed', issues: [{ code: 'packet_anchor' }] } });
    expect(verifyOffline(bytes, ['--expected-manifest-sha256', 'short']).result.issues[0].code).toBe('cli_arguments');
  });

  test('the verifier names no rule, pack, observation type or vendor and reaches only the standard library', () => {
    const forbidden = forbiddenLiterals();
    for (const name of ['finding-packet.mjs', 'finding-packet-cli.mjs']) {
      const file = `tools/verifier/${name}`;
      const text = readFileSync(join(repositoryRoot, file), 'utf8');
      expect(scanSource(file, text, forbidden), file).toEqual([]);
      for (const specific of ['battery', 'rotor', 'toy', BATTERY_RESERVE_LEAF_ID]) expect(text).not.toContain(specific);
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const source of imports) expect(source, file).toMatch(/^(node:|\.\/(integrity|finding-packet)\.mjs$)/);
    }
  });
});

/** A version 2 packet of the toy finding whose one read source has the given original bytes. */
function packetV2(original: Uint8Array): FindingPacketV2 {
  const { sources } = toyFinding();
  sources.artifacts = sources.artifacts.map((artifact) => ({
    ...artifact,
    sha256: sha256(original),
    byteLength: original.byteLength,
  }));
  const originals = new Map(sources.artifacts.map((artifact) => [artifact.id, original]));
  return assembleFindingPacketV2(sources, toyIssue, originals, originalsLeftOut(sources.artifacts));
}

describe('offline verification of version 2, which carries source originals', () => {
  const original = Buffer.from('{"reading":"latest","outsideAirTemperatureCelsius":-3}\n');

  test('keeps the version 2 constants of the packet contract', () => {
    expect(verifier.FINDING_PACKET_V2_FORMAT).toBe(FINDING_PACKET_V2_FORMAT);
    expect({ ...verifier.FINDING_PACKET_V2_LIMITS }).toEqual({ ...FINDING_PACKET_V2_LIMITS });
    expect([...verifier.FINDING_PACKET_V2_LIMITATIONS]).toEqual([...FINDING_PACKET_V2_LIMITATIONS]);
  });

  test('verifies a packet that carries its source bytes', () => {
    const value = packetV2(original);
    expect(value.artifacts[0]!.bytesBase64).toBe(original.toString('base64'));
    const result = verifyFindingPacket(value, { expectedManifestDigest: value.manifestDigest });
    expect(result).toMatchObject({
      status: 'verified',
      format: FINDING_PACKET_V2_FORMAT,
      counts: { originalBytes: original.byteLength, leftOutOriginals: 0 },
      originals: { carried: 1, carriedBytes: original.byteLength, leftOut: [] },
    });
    expect(result.notChecked.join(' ')).not.toMatch(/bytes are not in the packet/);
  });

  test('refuses a changed byte, naming the source whose bytes differ', () => {
    const value = packetV2(original);
    const changed = Buffer.from(value.artifacts[0]!.bytesBase64!, 'base64');
    changed[0] = changed[0]! ^ 1;
    value.artifacts[0]!.bytesBase64 = changed.toString('base64');
    expect(failure(value as never, value.manifestDigest)).toMatchObject({
      code: 'packet_original',
      path: '$.artifacts[0].bytesBase64',
      message: expect.stringMatching(/toy-artifact-1 differ from its recorded SHA-256 digest/),
    });
    const resealed = reseal(value as never);
    expect(failure(resealed, resealed.manifestDigest)).toMatchObject({ code: 'packet_original' });
  });

  test('verifies an over-bound packet and reports which bytes were left out', () => {
    const large = Buffer.alloc(FINDING_PACKET_V2_LIMITS.maxOriginalBytes + 1, 0x20);
    const value = packetV2(large);
    expect(value.artifacts[0]!.bytesBase64).toBeNull();
    expect(value.manifest.leftOutOriginals).toEqual(['toy-artifact-1']);
    expect(value.manifest.statements.at(-1)).toMatch(/original bytes of 1 source were left out/);
    expect(value.manifest.inventory.find((item) => item.kind === 'artifact')!.reason).toBe(
      'observation_source_digest_only',
    );
    const result = verifyFindingPacket(value, { expectedManifestDigest: value.manifestDigest });
    expect(result).toMatchObject({
      status: 'verified',
      counts: { originalBytes: 0, leftOutOriginals: 1 },
      originals: {
        carried: 0,
        carriedBytes: 0,
        leftOut: [{ artifactId: 'toy-artifact-1', sha256: sha256(large), byteLength: large.byteLength }],
      },
    });
    const unstated = structuredClone(value);
    unstated.manifest.statements = unstated.manifest.statements.slice(0, -1);
    expect(failure(reseal(unstated as never), canonicalDigest(unstated.manifest)).code).toBe('packet_statements');
    const unlisted = structuredClone(value);
    unlisted.manifest.leftOutOriginals = [];
    expect(failure(reseal(unlisted as never), canonicalDigest(unlisted.manifest)).code).toBe('packet_original');
  });

  test('leaves source bytes out largest first, and only as many as the bound needs', () => {
    const artifact = (id: string, byteLength: number) => ({
      tenantId: 'toy-tenant',
      id,
      sha256: canonicalDigest({ id }),
      byteLength,
      contentType: 'application/json',
    });
    const half = FINDING_PACKET_V2_LIMITS.maxOriginalBytes / 2;
    expect(originalsLeftOut([artifact('a', 10), artifact('b', 20)])).toEqual([]);
    expect(originalsLeftOut([artifact('a', half), artifact('c', half + 1), artifact('b', half + 1)])).toEqual([
      'b',
      'c',
    ]);
  });

  test('the CLI verifies a version 2 packet offline, and a version 1 packet still verifies', () => {
    const value = packetV2(original);
    const verified = verifyOffline(canonicalize(value), ['--expected-manifest-sha256', value.manifestDigest]);
    expect(verified).toMatchObject({ status: 0, result: { status: 'verified', format: FINDING_PACKET_V2_FORMAT } });
    const older = packet();
    expect(
      verifyOffline(canonicalize(older), ['--expected-manifest-sha256', older.manifestDigest]).result,
    ).toMatchObject({ status: 'verified', format: FINDING_PACKET_FORMAT });
  });
});
