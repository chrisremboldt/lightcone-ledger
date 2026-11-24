import type {
  EvidenceEnvelope,
  FlightEvidenceBundle,
  MissionRevisionRecord,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import type {
  MonitoringReportInputV2,
  MonitoringReportSourceV2,
} from '../../packages/contracts/src/monitoring-window.js';
import { monitoringSourceV2 } from '../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { appendCommandLinkBaselineHistory } from './command-link-baseline-history-fixture.js';
import { appendMissionHistory } from './mission-history-fixture.js';
import { appendJournalHistory } from './journal-history-fixture.js';

type Bundle = FlightEvidenceBundle | SubjectEvidenceBundle;

export function appendMonitoringWindowHistory<T extends Bundle>(bundle: T): T {
  const tenantId = bundle.manifest.tenantId;
  const organizationId = `organization:${tenantId}`;
  const flightId =
    bundle.manifest.subject.kind === 'flight' ? bundle.manifest.subject.id : 'unrelated-mission-flight-0';
  appendCommandLinkBaselineHistory(bundle, { flightId });
  appendMissionHistory(bundle);
  const entries = bundle.entries.map((entry) => JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope);
  const baseline = entries.find((entry) => entry.eventId === 'native-c2-event-0')!;
  const baselineReceipt = bundle.receipts.find((receipt) => receipt.eventId === baseline.eventId)!;
  const baselineArtifact = bundle.artifacts.find((artifact) => artifact.id === baseline.artifactId)!;
  const { acceptedAuthority: baselineAuthority, flightId: _derivedFlight, ...baselineInput } = baseline.payload;
  const baselineRecord = {
    eventId: baseline.eventId,
    receiptId: baselineReceipt.id,
    recordedAt: baseline.receivedAt,
    input: baselineInput,
    authority: baselineAuthority,
    original: {
      artifactId: baselineArtifact.id,
      sha256: baselineArtifact.sha256,
      byteLength: baselineArtifact.byteLength,
    },
  };
  const missionEvent = entries.find((entry) => entry.eventId === 'mission-event-0')!;
  const mission: MissionRevisionRecord = {
    ...(missionEvent.payload.acceptance as Omit<MissionRevisionRecord, 'id' | 'recordedAt'>),
    id: missionEvent.eventId,
    recordedAt: missionEvent.receivedAt,
  };
  const source: MonitoringReportSourceV2 = {
    ...monitoringSourceV2,
    // The accepted control record and its risk acceptance are safety records outside the export.
    flights: [
      {
        ...monitoringSourceV2.flights[0]!,
        flightId,
        mission: {
          missionId: mission.missionId,
          sourceRevision: mission.sourceRevision,
          eventId: mission.id,
          contentDigest: mission.contentDigest,
          recordDigest: canonicalDigest(mission),
        },
        baseline: {
          eventId: baseline.eventId,
          receiptId: baselineReceipt.id,
          sourceEventId: String((baselineInput.payload as Record<string, unknown>).sourceEventId),
          digest: canonicalDigest(baselineRecord),
        },
        declaredC2SourceEventIds: ['native-loss', 'native-restored'],
      },
    ],
  };
  const correction: MonitoringReportSourceV2 = {
    ...source,
    sourceRevision: 2,
    occurredAt: '2026-10-15T14:20:03Z',
    populationComplete: false,
    completeThrough: '2026-10-15T14:19:00Z',
    flights: source.flights.map((flight) => ({
      ...flight,
      observedIntervals: [],
      coverageIntervals: null,
      gaps: [{ interval: source.window, kind: 'exposure' }],
    })),
  };
  const streamId = 'monitoring-window-stream';
  const events = [source, correction].map((raw, index): EvidenceEnvelope => {
    const { sourceSessionId, occurredAt, ...payload } = raw;
    const input: MonitoringReportInputV2 = {
      sourceId: 'monitoring-source',
      sourceSessionId,
      kind: 'monitoring.window',
      occurredAt,
      artifactId: `monitoring-artifact-${index}`,
      fidelity: 'synthetic_contract',
      payload,
    };
    const bytes = Buffer.from(JSON.stringify(raw, null, 2) + '\n');
    const receivedAt = new Date(Date.parse(occurredAt) + 1000).toISOString();
    const eventId = `monitoring-event-${index}`;
    const authority = {
      principalId: 'monitoring-adapter',
      tenantId,
      principalRevision: 2,
      capabilities: ['input:write', 'monitoring:write', 'flight:read'],
      checkedCapabilities: ['input:write', 'monitoring:write'],
      sourceId: input.sourceId,
      grantedSources: [input.sourceId, 'another-monitoring-source'],
      policyVersion: 'ledger.monitoring-authority.1',
    };
    bundle.receipts.push({
      tenantId,
      id: `monitoring-receipt-${index}`,
      eventId,
      sourceId: input.sourceId,
      kind: input.kind,
      occurredAt,
      receivedAt,
      sourceRevision: String(raw.sourceRevision),
      artifactId: input.artifactId,
      payload,
      inputSubject: { organizationId },
    });
    bundle.artifacts.push({
      tenantId,
      id: input.artifactId,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      contentType: 'application/json',
      bytesBase64: bytes.toString('base64'),
    });
    return {
      eventId,
      tenantId,
      streamId,
      sequence: String(index + 1),
      type: input.kind,
      schemaVersion: 1,
      principalId: authority.principalId,
      sourceId: input.sourceId,
      sourceSessionId,
      occurredAt,
      effectiveAt: null,
      receivedAt,
      causationId: null,
      artifactId: input.artifactId,
      payload: { ...input, organizationId, acceptedAuthority: authority },
    };
  });
  appendJournalHistory(bundle, events, `source:monitoring-adapter:monitoring-source:${source.sourceSessionId}`);
  bundle.manifest.counts = {
    ...bundle.manifest.counts,
    receipts: bundle.receipts.length,
    artifacts: bundle.artifacts.length,
    artifactBytes: bundle.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
  };
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
