import type {
  DecisionEvidenceBundle,
  EvidenceEnvelope,
  FlightEvidenceBundle,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest, canonicalize, entryHash, INTEGRITY_VERSION } from '../../packages/integrity/src/index.js';
import { interpretEvidenceCut } from '../../packages/evidence/src/evidence-cut.mjs';

type InventoryBundle = DecisionEvidenceBundle | FlightEvidenceBundle | SubjectEvidenceBundle;

/** Appends one retained journal stream holding the effects, and reseals the bundle around it. */
export function appendJournalHistory<T extends InventoryBundle>(
  bundle: T,
  effects: EvidenceEnvelope[],
  streamName: string,
): T {
  const tenantId = bundle.manifest.tenantId;
  const streamId = effects[0].streamId;
  let previous = '';
  for (const effect of effects) {
    const envelopeDigest = canonicalDigest(effect);
    const hash = entryHash(tenantId, streamId, BigInt(effect.sequence), previous, envelopeDigest);
    bundle.entries.push({
      canonicalEnvelope: canonicalize(effect),
      envelopeDigest,
      previousHash: previous,
      entryHash: hash,
      encodingVersion: INTEGRITY_VERSION,
    });
    previous = hash;
  }
  bundle.streams.push({
    tenantId,
    id: streamId,
    name: streamName,
    headSequence: String(effects.length),
    headHash: previous,
    cutHeads: {
      rendered: { sequence: '0', hash: '' },
      accepted: { sequence: '0', hash: '' },
      issuance: { sequence: String(effects.length), hash: previous },
    },
  });
  bundle.cuts.issuance.streams[streamId] = effects.length;
  const issuedAt = effects.reduce(
    (latest, effect) => (Date.parse(effect.receivedAt) > Date.parse(latest) ? effect.receivedAt : latest),
    bundle.manifest.issuedAt,
  );
  bundle.manifest.issuedAt = issuedAt;
  bundle.snapshot.capturedAt = issuedAt;
  bundle.manifest.counts.events = bundle.entries.length;
  bundle.manifest.counts.streams = bundle.streams.length;
  for (const name of ['rendered', 'accepted', 'issuance'] as const)
    bundle.interpretations[name] = interpretEvidenceCut(bundle.entries, bundle.cuts[name], tenantId);
  bundle.manifest.sectionDigests = Object.fromEntries(
    Object.entries(bundle)
      .filter(([name]) => !['format', 'manifest', 'manifestDigest'].includes(name))
      .map(([name, value]) => [name, canonicalDigest(value)]),
  ) as typeof bundle.manifest.sectionDigests;
  bundle.manifest.interpretationDigests = {
    rendered: canonicalDigest(bundle.interpretations.rendered),
    accepted: canonicalDigest(bundle.interpretations.accepted),
    issuance: canonicalDigest(bundle.interpretations.issuance),
  };
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
