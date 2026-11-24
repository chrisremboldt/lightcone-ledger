import { describe, expect, it } from 'vitest';
import {
  DECISION_PACKET_V2_LIMITATIONS as PUBLIC_LIMITATIONS,
  DECISION_PACKET_V2_LIMITS as PUBLIC_LIMITS,
} from '../../packages/contracts/src/decision-packets.js';
import {
  BundleVerificationError,
  DECISION_PACKET_V2_LIMITATIONS,
  DECISION_PACKET_V2_LIMITS,
  verifyDecisionPacketV2,
} from '../../tools/verifier/decision-packet-v2.mjs';

const anchor = '0'.repeat(64);
function packet(events: unknown[] = [], artifacts: unknown[] = []) {
  return { format: 'ledger.decision-packet.2', manifest: {}, manifestDigest: anchor, events, receipts: [], artifacts };
}
function failure(value: unknown): string {
  try {
    verifyDecisionPacketV2(value, { expectedManifestDigest: anchor });
    return 'unexpected_success';
  } catch (error) {
    expect(error).toBeInstanceOf(BundleVerificationError);
    return (error as BundleVerificationError).issues[0].code;
  }
}

describe('execution packet verification bounds', () => {
  it('uses the exact public version-two depth, byte and limitation policy', () => {
    expect(DECISION_PACKET_V2_LIMITS).toEqual(PUBLIC_LIMITS);
    expect(DECISION_PACKET_V2_LIMITATIONS).toEqual(PUBLIC_LIMITATIONS);
    expect(DECISION_PACKET_V2_LIMITS.maxReferenceDepth).toBe(3);
    expect(() => verifyDecisionPacketV2(packet())).toThrow('independently retained');
  });

  it('rejects counts and original or envelope bounds before parsing nested records', () => {
    expect(failure(packet(Array.from({ length: PUBLIC_LIMITS.maxEvents + 1 }, () => null)))).toBe('packet_bound');
    expect(failure(packet([{ canonicalEnvelope: 'x'.repeat(PUBLIC_LIMITS.maxEnvelopeBytes + 1) }]))).toBe(
      'packet_envelope_bound',
    );
    expect(failure(packet([], [{ byteLength: 1, bytesBase64: 'x'.repeat(100000) }]))).toBe('packet_original_bound');
    const originals = Array.from({ length: 17 }, () => ({ byteLength: 65536, bytesBase64: '' }));
    expect(failure(packet([], originals))).toBe('packet_original_bound');
  });
});
