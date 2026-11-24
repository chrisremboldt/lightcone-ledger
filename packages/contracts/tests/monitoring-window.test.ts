import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { InputSchema, CommandSchema, capabilityValues } from '../src/index.js';
import {
  CONTROL_EFFECTIVENESS_LIMITS,
  MonitoringRecordSchema,
  MonitoringRecordV2Schema,
  MonitoringReportInputSchema,
  MonitoringReportInputV2Schema,
  MonitoringReportSourceSchema,
  MonitoringReportSourceV2Schema,
  MonitoringWindowRecordResponseSchema,
} from '../src/monitoring-window.js';
import {
  COMMAND_LINK_BASELINE_MAX_BYTES,
  CommandLinkBaselineAuthoritySchema,
  CommandLinkBaselineInputSchema,
  CommandLinkBaselineSourceSchema,
  ResolvedCommandLinkBaselineSchema,
} from '../src/command-link-baseline.js';
import { openApiDocument } from '../src/openapi.js';
import { LedgerClient } from '../src/client.js';
import {
  baselineEvidence,
  baselineInput,
  baselineSource,
  monitoringInput,
  monitoringInputV2,
  monitoringOriginalBytesBase64,
  monitoringOriginalBytesBase64V2,
  monitoringRecord,
  monitoringRecordV2,
  monitoringSource,
  monitoringSourceV2,
} from '../fixtures/demo/v1/monitoring-window.js';
import { missionReleaseRecord } from '../fixtures/demo/v1/mission-release.js';
import { missionRevision2Record } from '../fixtures/demo/v1/missions.js';
import { orderInput } from '../fixtures/demo/v1/ready.js';
import { canonicalDigest, parseStrictJson, sha256 } from '../../integrity/src/index.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('native monitoring window contract', () => {
  it('accepts only V2 organization-scoped monitoring and retains existing input subject requirements', () => {
    const input = ajv.compile(InputSchema);
    expect(input(monitoringInputV2), JSON.stringify(input.errors)).toBe(true);
    for (const value of [
      monitoringInput,
      { ...monitoringInputV2, subject: {} },
      { ...monitoringInputV2, organizationId: 'caller-selected' },
      { ...monitoringInputV2, payload: { ...monitoringInputV2.payload, reportedLossCount: 0 } },
      { ...monitoringInputV2, payload: { ...monitoringInputV2.payload, historyStart: monitoringInputV2.occurredAt } },
    ])
      expect(input(value)).toBe(false);
    expect(input(orderInput)).toBe(true);
    const { subject: _subject, ...withoutSubject } = orderInput;
    expect(input(withoutSubject)).toBe(false);
    expect(capabilityValues).toContain('monitoring:write');
    const command = ajv.compile(CommandSchema);
    const grant = {
      kind: 'authority.update',
      principalId: 'source',
      expectedRevision: 1,
      capabilities: ['input:write', 'monitoring:write'],
      monitoringSources: ['monitor'],
    };
    expect(command(grant), JSON.stringify(command.errors)).toBe(true);
    expect(command({ ...grant, monitoringSources: [] })).toBe(true);
    expect(command({ ...grant, monitoringSources: ['monitor', 'monitor'] })).toBe(false);
  });

  it('keeps exact immutable record digests separate from processing and encodes the authenticated read', async () => {
    const response = ajv.compile(MonitoringWindowRecordResponseSchema);
    const value = {
      monitoring: monitoringRecordV2,
      digest: canonicalDigest(monitoringRecordV2),
      processing: 'pending',
    };
    for (const processing of ['pending', 'processing', 'completed', 'failed'])
      expect(response({ ...value, processing })).toBe(true);
    expect(response({ ...value, originalBytesBase64: 'e30=' })).toBe(false);
    const calls: string[] = [];
    const ledger = new LedgerClient('https://ledger.invalid', 'fixture-token', async (input, init) => {
      calls.push(String(input));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    });
    expect(await ledger.monitoringWindow('retained / window')).toEqual(value);
    expect(calls).toEqual(['https://ledger.invalid/v1/organization/monitoring-windows/retained%20%2F%20window']);
  });
});

describe('monitoring window sources and native C2 baselines', () => {
  it('cites the exact accepted control record version and its signed risk acceptance', () => {
    const candidate = missionReleaseRecord.basis.avoidance.candidates[0]!;
    for (const source of [monitoringSource, monitoringSourceV2])
      expect(source.control).toEqual({
        hazardId: candidate.hazardId,
        controlId: candidate.controlId,
        controlVersion: candidate.controlVersion,
        controlEventId: candidate.controlEventId,
        controlDigest: candidate.controlDigest,
        acceptance: candidate.acceptance,
      });
    const selected = monitoringSource.flights[0]!;
    expect(selected.flightId).toBe(missionRevision2Record.flightId);
    expect(selected.aircraftId).toBe(missionRevision2Record.aircraftId);
    expect(selected.mission).toEqual({
      missionId: missionRevision2Record.missionId,
      sourceRevision: missionRevision2Record.sourceRevision,
      eventId: missionRevision2Record.id,
      contentDigest: missionRevision2Record.contentDigest,
      recordDigest: canonicalDigest(missionRevision2Record),
    });
  });

  it('retains the exact observed sample, original source bytes and captured source authority', () => {
    for (const [schema, value] of [
      [MonitoringReportSourceSchema, monitoringSource],
      [MonitoringReportInputSchema, monitoringInput],
      [MonitoringRecordSchema, monitoringRecord],
      [CommandLinkBaselineSourceSchema, baselineSource],
      [CommandLinkBaselineInputSchema, baselineInput],
      [CommandLinkBaselineAuthoritySchema, baselineEvidence.authority],
      [ResolvedCommandLinkBaselineSchema, baselineEvidence],
      [MonitoringReportSourceV2Schema, monitoringSourceV2],
      [MonitoringReportInputV2Schema, monitoringInputV2],
      [MonitoringRecordV2Schema, monitoringRecordV2],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const { sourceSessionId, occurredAt, ...payload } = monitoringSource;
    expect(monitoringInput).toEqual({
      sourceId: monitoringRecord.sourceId,
      sourceSessionId,
      kind: 'monitoring.window',
      occurredAt,
      artifactId: monitoringRecord.original.artifactId,
      fidelity: 'synthetic_contract',
      payload,
    });
    const original = Buffer.from(monitoringOriginalBytesBase64, 'base64');
    expect(original.byteLength).toBe(monitoringRecord.original.byteLength);
    expect(sha256(original)).toBe(monitoringRecord.original.sha256);
    expect(parseStrictJson(original.toString('utf8'))).toEqual(monitoringSource);
    expect(original.byteLength).toBeLessThan(CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes);
    expect(monitoringRecord.authority.sourceId).toBe(monitoringRecord.sourceId);
    expect(monitoringRecord.authority.grantedSources).toContain(monitoringRecord.sourceId);
    expect(monitoringRecord.authority.checkedCapabilities).toEqual(['input:write', 'monitoring:write']);
    expect(monitoringRecord.authority.capabilities).toEqual(monitoringRecord.authority.checkedCapabilities);
    expect(monitoringRecord.organizationId).toBe(`organization:${monitoringRecord.authority.tenantId}`);

    const {
      sourceId,
      sourceSessionId: baselineSession,
      flightId,
      occurredAt: baselineTime,
      ...baselinePayload
    } = baselineSource;
    expect(baselineInput).toEqual({
      sourceId,
      sourceSessionId: baselineSession,
      kind: 'command-link.baseline',
      occurredAt: baselineTime,
      subject: { flightId },
      artifactId: baselineEvidence.original.artifactId,
      fidelity: 'synthetic_contract',
      payload: baselinePayload,
    });
    expect(baselineSource.state).toBe('up');
    expect(baselineSource.sourceSessionId).not.toBe(monitoringSource.flights[0]!.c2SourceSessionId);
    expect(baselineInput.payload).not.toHaveProperty('incidentId');
    expect(baselineInput.payload).not.toHaveProperty('status');
    const bytes = Buffer.from(baselineEvidence.originalBytesBase64, 'base64');
    expect(bytes.byteLength).toBe(baselineEvidence.original.byteLength);
    expect(bytes.byteLength).toBeLessThan(COMMAND_LINK_BASELINE_MAX_BYTES);
    expect(sha256(bytes)).toBe(baselineEvidence.original.sha256);
    expect(parseStrictJson(bytes.toString('utf8'))).toEqual(baselineSource);
    expect(baselineEvidence.authority.inputKind).toBe(baselineInput.kind);
    expect(baselineEvidence.authority.version).toBe('ledger.command-link-baseline-authority.1');
    expect(baselineEvidence.authority.requiredCapabilities).toEqual(['input:write', 'command-link:write']);
    expect(baselineEvidence.authority.grantedSources).toContain(baselineInput.sourceId);
    expect(baselineEvidence.authority.sourceId).toBe(baselineInput.sourceId);
    expect(monitoringRecordV2.organizationId).toBe(`organization:${baselineEvidence.authority.tenantId}`);

    const { sourceSessionId: monitorSession, occurredAt: monitorTime, ...monitorPayload } = monitoringSourceV2;
    expect(monitoringInputV2).toEqual({
      sourceId: monitoringRecordV2.sourceId,
      sourceSessionId: monitorSession,
      kind: 'monitoring.window',
      occurredAt: monitorTime,
      artifactId: monitoringRecordV2.original.artifactId,
      fidelity: 'synthetic_contract',
      payload: monitorPayload,
    });
    const monitorBytes = Buffer.from(monitoringOriginalBytesBase64V2, 'base64');
    expect(monitorBytes.byteLength).toBe(monitoringRecordV2.original.byteLength);
    expect(sha256(monitorBytes)).toBe(monitoringRecordV2.original.sha256);
    expect(parseStrictJson(monitorBytes.toString('utf8'))).toEqual(monitoringSourceV2);
  });

  it('pins native baseline membership without fabricating a loss-free incident', () => {
    const { processing: _processing, originalBytesBase64: _bytes, ...immutable } = baselineEvidence;
    const declared = monitoringSourceV2.flights[0]!;
    expect(declared.baseline).toEqual({
      eventId: baselineEvidence.eventId,
      receiptId: baselineEvidence.receiptId,
      sourceEventId: baselineInput.payload.sourceEventId,
      digest: canonicalDigest(immutable),
    });
    expect(declared).not.toHaveProperty('historyStart');
    expect(declared.flightId).toBe(baselineInput.subject.flightId);
    expect(declared.aircraftId).toBe(baselineInput.payload.aircraftId);
    expect(declared.c2SourceId).toBe(baselineInput.sourceId);
    expect(declared.c2SourceSessionId).toBe(baselineInput.sourceSessionId);
    expect(Date.parse(baselineInput.occurredAt)).toBeLessThan(Date.parse(monitoringSourceV2.window.start));
    expect(declared.declaredC2SourceEventIds).toEqual([]);
  });

  it('keeps the source contracts closed and bounded', () => {
    const source = ajv.compile(MonitoringReportSourceSchema);
    expect(source({ ...monitoringSource, observedLossCount: 0 })).toBe(false);
    expect(source({ ...monitoringSource, monitoredFlightSeconds: 300 })).toBe(false);
    expect(
      source({
        ...monitoringSource,
        flights: Array.from(
          { length: CONTROL_EFFECTIVENESS_LIMITS.maxFlights + 1 },
          () => monitoringSource.flights[0]!,
        ),
      }),
    ).toBe(false);
    const selected = monitoringSource.flights[0]!;
    expect(
      source({
        ...monitoringSource,
        flights: [
          {
            ...selected,
            observedIntervals: Array.from(
              { length: CONTROL_EFFECTIVENESS_LIMITS.maxIntervalsPerField + 1 },
              () => monitoringSource.window,
            ),
          },
        ],
      }),
    ).toBe(false);
    expect(
      ajv.compile(MonitoringReportInputSchema)({ ...monitoringInput, subject: { flightId: selected.flightId } }),
    ).toBe(false);
    const baseline = ajv.compile(CommandLinkBaselineSourceSchema);
    expect(baseline({ ...baselineSource, incidentId: 'invented-incident' })).toBe(false);
    expect(baseline({ ...baselineSource, status: 'restored' })).toBe(false);
    expect(baseline({ ...baselineSource, completeThrough: monitoringSourceV2.window.end })).toBe(false);
    expect(baseline({ ...baselineSource, state: 'restored' })).toBe(false);
    expect(
      ajv.compile(CommandLinkBaselineInputSchema)({
        ...baselineInput,
        payload: { ...baselineInput.payload, flightId: baselineInput.subject.flightId },
      }),
    ).toBe(false);
    const monitoring = ajv.compile(MonitoringReportSourceV2Schema);
    expect(
      monitoring({
        ...monitoringSourceV2,
        flights: [{ ...monitoringSourceV2.flights[0]!, historyStart: baselineSource.occurredAt }],
      }),
    ).toBe(false);
    expect(monitoring({ ...monitoringSourceV2, observedLossCount: 0 })).toBe(false);
    expect(CONTROL_EFFECTIVENESS_LIMITS.maxC2Records).toBe(128);
    expect(CONTROL_EFFECTIVENESS_LIMITS.maxWindowMilliseconds).toBe(3600000);
    const input = ajv.compile(InputSchema);
    expect(input(baselineInput)).toBe(true);
    expect(input(monitoringInputV2)).toBe(true);
    expect(capabilityValues).not.toContain('command-link:baseline');
    expect(openApiDocument.paths).toHaveProperty('/v1/flights/{id}/command-link-baselines/{baselineId}');
    expect(openApiDocument.paths).toHaveProperty('/v1/organization/monitoring-windows/{monitoringId}');
  });
});
