import { describe, expect, it } from 'vitest';
import {
  baselineEvidence,
  baselineInput,
  baselineSource,
} from '../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import {
  validateAcceptedCommandLinkBaselineAuthority,
  verifyCommandLinkBaselineInputSource,
} from '../../packages/domain/src/command-link-baseline.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { JournalEvent } from '../../packages/persistence/src/index.js';

function retainedEvent(): JournalEvent {
  return {
    id: baselineEvidence.eventId,
    tenant_id: baselineEvidence.authority.tenantId,
    stream_id: 'fixture-baseline-stream',
    stream_sequence: '1',
    event_type: 'command-link.baseline',
    principal_id: baselineEvidence.authority.principalId,
    source_id: baselineInput.sourceId,
    source_session_id: baselineInput.sourceSessionId,
    occurred_at: new Date(baselineInput.occurredAt),
    received_at: new Date(baselineEvidence.recordedAt),
    payload: {
      ...structuredClone(baselineInput),
      flightId: baselineInput.subject.flightId,
      acceptedAuthority: structuredClone(baselineEvidence.authority),
    },
    artifact_id: baselineInput.artifactId,
    causation_id: null,
  };
}

describe('command-link baseline source retention', () => {
  it('commits exact source bytes and scope while allowing a fresh identical upload', () => {
    const bytes = Buffer.from(baselineEvidence.originalBytesBase64, 'base64');
    const verified = verifyCommandLinkBaselineInputSource(baselineInput, bytes);
    expect(verified).toMatchObject({ sha256: sha256(bytes), byteLength: bytes.byteLength });
    expect(verifyCommandLinkBaselineInputSource({ ...baselineInput, artifactId: 'fresh-original' }, bytes)).toEqual(
      verified,
    );
    expect(
      verifyCommandLinkBaselineInputSource(baselineInput, Buffer.from(JSON.stringify(baselineSource))).contentDigest,
    ).not.toBe(verified.contentDigest);
    expect(() =>
      verifyCommandLinkBaselineInputSource({ ...baselineInput, subject: { flightId: 'different-flight' } }, bytes),
    ).toThrow();
    expect(() =>
      verifyCommandLinkBaselineInputSource({ ...baselineInput, occurredAt: '2026-10-15T14:12:00.000Z' }, bytes),
    ).toThrow();
  });

  it('rejects ambiguous originals and authority that differs from the immutable issuer or source', () => {
    const text = JSON.stringify(baselineSource);
    expect(() =>
      verifyCommandLinkBaselineInputSource(
        baselineInput,
        Buffer.from(text.replace('"state":"up"', '"state":"up","state":"up"')),
      ),
    ).toThrow();
    expect(() => verifyCommandLinkBaselineInputSource(baselineInput, new Uint8Array([0xff]))).toThrow();
    expect(() =>
      verifyCommandLinkBaselineInputSource(
        baselineInput,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
      ),
    ).toThrow();
    expect(() => verifyCommandLinkBaselineInputSource(baselineInput, Buffer.alloc(65537, 0x20))).toThrowError(/64 KiB/);
    expect(validateAcceptedCommandLinkBaselineAuthority(retainedEvent())).toEqual(baselineEvidence.authority);
    const otherIssuer = retainedEvent();
    otherIssuer.principal_id = 'different-principal';
    expect(() => validateAcceptedCommandLinkBaselineAuthority(otherIssuer)).toThrow();
    const ungrantedSource = retainedEvent();
    ungrantedSource.payload.acceptedAuthority.grantedSources = [];
    expect(() => validateAcceptedCommandLinkBaselineAuthority(ungrantedSource)).toThrow();
    const differentSource = retainedEvent();
    differentSource.source_id = 'different-source';
    expect(() => validateAcceptedCommandLinkBaselineAuthority(differentSource)).toThrow();
  });
});
