import { canonicalDigest, sha256 } from '../../../../integrity/src/index.js';
import type {
  CommandLinkBaselineInput,
  CommandLinkBaselineSource,
  ResolvedCommandLinkBaseline,
} from '../../../src/command-link-baseline.js';
import type {
  MonitoringRecord,
  MonitoringRecordV2,
  MonitoringReportInput,
  MonitoringReportInputV2,
  MonitoringReportSource,
  MonitoringReportSourceV2,
} from '../../../src/monitoring-window.js';
import { areaControlOrganizationId } from './area-control.js';
import { missionReleaseRecord } from './mission-release.js';
import { missionRevision2Record } from './missions.js';

/** The accepted area control record the window reports on, cited as a briefing cites it. */
const candidate = missionReleaseRecord.basis.avoidance.candidates[0]!;
const control = {
  hazardId: candidate.hazardId,
  controlId: candidate.controlId,
  controlVersion: candidate.controlVersion,
  controlEventId: candidate.controlEventId,
  controlDigest: candidate.controlDigest,
  acceptance: candidate.acceptance,
};
const mission = {
  missionId: missionRevision2Record.missionId,
  sourceRevision: missionRevision2Record.sourceRevision,
  eventId: missionRevision2Record.id,
  contentDigest: missionRevision2Record.contentDigest,
  recordDigest: canonicalDigest(missionRevision2Record),
};
const window = { start: '2026-10-15T14:15:00Z', end: '2026-10-15T14:20:00Z' };
const flight = {
  flightId: missionRevision2Record.flightId,
  aircraftId: missionRevision2Record.aircraftId,
  mission,
  c2SourceId: 'command-link',
  c2SourceSessionId: 'fixture-monitoring-c2-session',
  historyStart: '2026-10-15T14:12:00Z',
  observedIntervals: [window],
  coverageIntervals: [window],
  gaps: [],
  declaredC2SourceEventIds: ['baseline-loss', 'baseline-restoration'],
} satisfies MonitoringReportSource['flights'][number];
/** Version 1 monitoring source: retained in its original shape. */
export const monitoringSource = {
  sourceSessionId: 'fixture-monitoring-session',
  sourceWindowId: 'fixture-control-window',
  sourceRevision: 1,
  occurredAt: '2026-10-15T14:20:01Z',
  control,
  window,
  populationComplete: true,
  completeThrough: window.end,
  flights: [flight],
} satisfies MonitoringReportSource;

function original(value: unknown, artifactId: string) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  return {
    original: { artifactId, sha256: sha256(bytes), byteLength: bytes.byteLength },
    originalBytesBase64: bytes.toString('base64'),
  };
}
const monitoringOriginal = original(monitoringSource, 'fixture-monitoring-original');
/** The exact original bytes of the version 1 source. */
export const monitoringOriginalBytesBase64 = monitoringOriginal.originalBytesBase64;
const { sourceSessionId: v1Session, occurredAt: v1Occurred, ...v1Payload } = monitoringSource;
export const monitoringInput = {
  sourceId: 'monitoring-source',
  sourceSessionId: v1Session,
  kind: 'monitoring.window',
  occurredAt: v1Occurred,
  artifactId: monitoringOriginal.original.artifactId,
  fidelity: 'synthetic_contract',
  payload: v1Payload,
} satisfies MonitoringReportInput;
export const monitoringRecord = {
  version: 'monitoring.window.1',
  id: 'fixture-monitoring-window-event',
  organizationId: areaControlOrganizationId,
  sourceId: monitoringInput.sourceId,
  source: monitoringSource,
  original: monitoringOriginal.original,
  recordedAt: '2026-10-15T14:20:02Z',
  authority: {
    principalId: 'fixture-monitoring-principal',
    tenantId: 'fixture-tenant',
    principalRevision: 2,
    capabilities: ['input:write', 'monitoring:write'],
    checkedCapabilities: ['input:write', 'monitoring:write'],
    sourceId: monitoringInput.sourceId,
    grantedSources: [monitoringInput.sourceId],
    policyVersion: 'ledger.monitoring-authority.1',
  },
} satisfies MonitoringRecord;

export const baselineSource = {
  version: 'command-link.baseline.1',
  sourceId: flight.c2SourceId,
  sourceSessionId: 'fixture-native-c2-session',
  sourceEventId: 'native-session-baseline',
  flightId: flight.flightId,
  aircraftId: flight.aircraftId,
  occurredAt: '2026-10-15T14:12:00Z',
  state: 'up',
} satisfies CommandLinkBaselineSource;

/** A native command-link baseline as retained, with its exact original bytes. */
export function resolvedBaseline(source: CommandLinkBaselineSource): ResolvedCommandLinkBaseline {
  const { sourceId, sourceSessionId, flightId, occurredAt, ...payload } = source;
  const retained = original(source, `fixture-${source.sourceEventId}-original`);
  return {
    eventId: `fixture-${source.sourceEventId}-event`,
    receiptId: `fixture-${source.sourceEventId}-receipt`,
    recordedAt: new Date(Date.parse(occurredAt) + 1000).toISOString(),
    input: {
      sourceId,
      sourceSessionId,
      kind: 'command-link.baseline',
      occurredAt,
      subject: { flightId },
      artifactId: retained.original.artifactId,
      fidelity: 'synthetic_contract',
      payload,
    },
    authority: {
      version: 'ledger.command-link-baseline-authority.1',
      principalId: 'fixture-c2-source-principal',
      tenantId: monitoringRecord.authority.tenantId,
      principalRevision: 2,
      inputKind: 'command-link.baseline',
      sourceId,
      requiredCapabilities: ['input:write', 'command-link:write'],
      grantedSources: [sourceId],
    },
    ...retained,
    processing: 'completed',
  };
}
export const baselineEvidence = resolvedBaseline(baselineSource);
export const baselineInput = baselineEvidence.input satisfies CommandLinkBaselineInput;
/** The baseline as a monitoring window cites it: by the digest of its immutable record. */
export function baselineReference(record: ResolvedCommandLinkBaseline) {
  const { eventId, receiptId, recordedAt, input, authority, original } = record;
  return {
    eventId,
    receiptId,
    sourceEventId: input.payload.sourceEventId,
    digest: canonicalDigest({ eventId, receiptId, recordedAt, input, authority, original }),
  };
}
const { historyStart: _historyStart, ...scope } = flight;
export const monitoringSourceV2 = {
  ...monitoringSource,
  version: 'monitoring.window.2',
  sourceSessionId: 'fixture-native-monitoring-session',
  sourceWindowId: 'fixture-native-control-window',
  flights: [
    {
      ...scope,
      c2SourceSessionId: baselineSource.sourceSessionId,
      baseline: baselineReference(baselineEvidence),
      declaredC2SourceEventIds: [],
    },
  ],
} satisfies MonitoringReportSourceV2;
const monitoringOriginalV2 = original(monitoringSourceV2, 'fixture-native-monitoring-original');
/** The exact original bytes of the version 2 source. */
export const monitoringOriginalBytesBase64V2 = monitoringOriginalV2.originalBytesBase64;
const { sourceSessionId, occurredAt, ...payload } = monitoringSourceV2;
export const monitoringInputV2 = {
  sourceId: monitoringRecord.sourceId,
  sourceSessionId,
  kind: 'monitoring.window',
  occurredAt,
  artifactId: monitoringOriginalV2.original.artifactId,
  fidelity: 'synthetic_contract',
  payload,
} satisfies MonitoringReportInputV2;
export const monitoringRecordV2 = {
  ...monitoringRecord,
  version: 'monitoring.window.2',
  id: 'fixture-native-monitoring-event',
  source: monitoringSourceV2,
  original: monitoringOriginalV2.original,
} satisfies MonitoringRecordV2;

/** A later contiguous revision of the same window, correcting declared incident membership. */
const revision2Source = {
  ...monitoringSourceV2,
  sourceRevision: 2,
  occurredAt: '2026-10-15T14:20:04Z',
  flights: [{ ...monitoringSourceV2.flights[0]!, declaredC2SourceEventIds: ['native-late-loss'] }],
} satisfies MonitoringReportSourceV2;
const revision2Original = original(revision2Source, 'fixture-native-monitoring-revision-2-original');
export const monitoringRecordV2Revision2 = {
  ...monitoringRecordV2,
  id: 'fixture-native-monitoring-revision-2-event',
  source: revision2Source,
  recordedAt: '2026-10-15T14:20:05Z',
  original: revision2Original.original,
} satisfies MonitoringRecordV2;
export const monitoringRevision2OriginalBytesBase64 = revision2Original.originalBytesBase64;
