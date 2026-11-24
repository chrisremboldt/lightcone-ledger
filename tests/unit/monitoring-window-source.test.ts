import { describe, expect, it } from 'vitest';
import {
  monitoringInputV2,
  monitoringSourceV2,
  monitoringRecordV2,
} from '../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import type { MonitoringReportSourceV2 } from '../../packages/contracts/src/index.js';
import {
  verifyMonitoringWindowInputSource,
  validateAcceptedMonitoringAuthority,
} from '../../packages/domain/src/monitoring-window.js';
import type { JournalEvent } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';

function verify(source: MonitoringReportSourceV2) {
  const { sourceSessionId, occurredAt, ...payload } = source;
  const bytes = Buffer.from(JSON.stringify(source));
  return verifyMonitoringWindowInputSource({ ...monitoringInputV2, sourceSessionId, occurredAt, payload }, bytes);
}

describe('monitoring source retention', () => {
  it('commits exact original bytes and enforces the shared declared-record and observed-clock bounds', () => {
    const bytes = Buffer.from(JSON.stringify(monitoringSourceV2));
    const verified = verifyMonitoringWindowInputSource(monitoringInputV2, bytes);
    expect(verified).toMatchObject({ sha256: sha256(bytes), byteLength: bytes.length });
    expect(verifyMonitoringWindowInputSource({ ...monitoringInputV2, artifactId: 'another-upload' }, bytes)).toEqual(
      verified,
    );
    expect(
      verifyMonitoringWindowInputSource(monitoringInputV2, Buffer.from(JSON.stringify(monitoringSourceV2, null, 2)))
        .contentDigest,
    ).not.toBe(verified.contentDigest);
    const bounded = structuredClone(monitoringSourceV2);
    bounded.flights[0]!.declaredC2SourceEventIds = Array.from({ length: 127 }, (_, index) => `status-${index}`);
    expect(() => verify(bounded)).not.toThrow();
    bounded.flights[0]!.declaredC2SourceEventIds.push('over-bound');
    expect(() => verify(bounded)).toThrow();
    const future = structuredClone(monitoringSourceV2);
    future.flights[0]!.observedIntervals = [
      { start: future.occurredAt, end: new Date(Date.parse(future.occurredAt) + 1).toISOString() },
    ];
    expect(() => verify(future)).toThrow();
  });

  it('rejects ambiguous originals and authority without the exact issuer, capability or source grant', () => {
    const raw = JSON.stringify(monitoringSourceV2);
    expect(() =>
      verifyMonitoringWindowInputSource(monitoringInputV2, Buffer.from('{"sourceRevision":1,' + raw.slice(1))),
    ).toThrow();
    expect(() => verifyMonitoringWindowInputSource(monitoringInputV2, Buffer.from([0xff]))).toThrow();
    expect(() =>
      verifyMonitoringWindowInputSource(
        monitoringInputV2,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)]),
      ),
    ).toThrow();
    expect(() => verifyMonitoringWindowInputSource(monitoringInputV2, Buffer.alloc(128 * 1024 + 1, 0x20))).toThrow();
    const authority = structuredClone(monitoringRecordV2.authority);
    const event = {
      event_type: 'monitoring.window',
      source_id: monitoringInputV2.sourceId,
      source_session_id: monitoringInputV2.sourceSessionId,
      principal_id: authority.principalId,
      tenant_id: authority.tenantId,
      payload: {
        ...monitoringInputV2,
        organizationId: monitoringRecordV2.organizationId,
        acceptedAuthority: authority,
      },
      effective_at: null,
    } as unknown as JournalEvent;
    expect(validateAcceptedMonitoringAuthority(event)).toEqual(authority);
    authority.grantedSources = [];
    expect(() => validateAcceptedMonitoringAuthority(event)).toThrow();
  });
});
