import { Type, type Static } from '@sinclair/typebox';
import { MissionAvoidanceMissionReferenceSchema } from './mission-avoidance.js';
import { MissionBriefingControlReferenceSchema } from './mission-briefing.js';

/** Bounds of a monitoring window a source reports for an accepted control (the name is kept from its first use). */
export const CONTROL_EFFECTIVENESS_LIMITS = {
  maxFlights: 32,
  maxIntervalsPerField: 16,
  maxC2Records: 128,
  maxMonitoringOriginalBytes: 128 * 1024,
  maxC2OriginalBytes: 64 * 1024,
  maxResolvedInputBytes: 4 * 1024 * 1024,
  maxWindowMilliseconds: 60 * 60 * 1000,
} as const;

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const PositiveRevision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Interval = Type.Object({ start: Time, end: Time }, Closed);
const Intervals = Type.Array(Interval, { maxItems: CONTROL_EFFECTIVENESS_LIMITS.maxIntervalsPerField });
const ControlReference = MissionBriefingControlReferenceSchema;

export const MonitoringReportSourceSchema = Type.Object(
  {
    sourceSessionId: Id,
    sourceWindowId: Id,
    sourceRevision: PositiveRevision,
    occurredAt: Time,
    control: ControlReference,
    window: Interval,
    populationComplete: Type.Boolean(),
    completeThrough: Time,
    flights: Type.Array(
      Type.Object(
        {
          flightId: Id,
          aircraftId: Id,
          mission: MissionAvoidanceMissionReferenceSchema,
          c2SourceId: Id,
          c2SourceSessionId: Id,
          historyStart: Time,
          observedIntervals: Intervals,
          coverageIntervals: Type.Union([Intervals, Type.Null()]),
          gaps: Type.Array(
            Type.Object(
              {
                interval: Interval,
                kind: Type.Union(['exposure', 'c2_monitor', 'telemetry_delivery'].map((value) => Type.Literal(value))),
              },
              Closed,
            ),
            { maxItems: CONTROL_EFFECTIVENESS_LIMITS.maxIntervalsPerField },
          ),
          declaredC2SourceEventIds: Type.Array(Id, {
            uniqueItems: true,
            maxItems: CONTROL_EFFECTIVENESS_LIMITS.maxC2Records,
          }),
        },
        Closed,
      ),
      { maxItems: CONTROL_EFFECTIVENESS_LIMITS.maxFlights },
    ),
  },
  {
    ...Closed,
    description:
      'Proposed monitoring source JSON, not live intake. Retain at most 128 KiB of exact original bytes. Report observed airborne exposure in the named control/site context, never planned or held durations inferred from telemetry. The population is a declared sample, not proof of all-fleet or geographic coverage. populationComplete and completeThrough are explicit source commitments for this sample, not C2 finality; completeThrough must reach window.end. historyStart declares the session baseline start, never a caller-selected lookback that omits older accepted reports. Declared membership must include baseline and carry-in. If a selected retained report precedes historyStart, correct the source historyStart and membership in a new revision before recomputing. The calculator checks finite ordered intervals, a window of at most one hour and at most 128 C2 records across all flights. No producer aggregate loss count, exposure total or rate is accepted.',
  },
);
export type MonitoringReportSource = Static<typeof MonitoringReportSourceSchema>;

export const MonitoringReportInputSchema = Type.Object(
  {
    sourceId: Id,
    sourceSessionId: Id,
    kind: Type.Literal('monitoring.window'),
    occurredAt: Time,
    artifactId: Id,
    fidelity: Type.Literal('synthetic_contract'),
    payload: Type.Omit(MonitoringReportSourceSchema, ['sourceSessionId', 'occurredAt']),
  },
  {
    ...Closed,
    description:
      'Standalone proposed normalized input. Organization scope derives from authentication; no flight subject or caller-selected organization is accepted. Session and occurrence time copy the exact source, with all remaining fields copied into payload. Proposed input:write and monitoring:write authority and an explicit source grant remain outside live capabilities and intake.',
  },
);
export type MonitoringReportInput = Static<typeof MonitoringReportInputSchema>;

export const MonitoringRecordSchema = Type.Object(
  {
    version: Type.Literal('monitoring.window.1'),
    id: Id,
    organizationId: Id,
    sourceId: Id,
    source: MonitoringReportSourceSchema,
    original: Type.Object(
      {
        artifactId: Id,
        sha256: Digest,
        byteLength: Type.Integer({ minimum: 1, maximum: CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes }),
      },
      Closed,
    ),
    recordedAt: Time,
    authority: Type.Object(
      {
        principalId: Id,
        tenantId: Id,
        principalRevision: PositiveRevision,
        capabilities: Type.Array(Type.String()),
        checkedCapabilities: Type.Tuple([Type.Literal('input:write'), Type.Literal('monitoring:write')]),
        sourceId: Id,
        grantedSources: Type.Array(Id, { uniqueItems: true, maxItems: 100 }),
        policyVersion: Type.Literal('ledger.monitoring-authority.1'),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'Proposed immutable monitoring record with actual acceptance-time source authority.' },
);
export type MonitoringRecord = Static<typeof MonitoringRecordSchema>;

// Version 2: the monitoring window a source reports for an accepted control record.
export const MONITORING_WINDOW_MAX_READ_BYTES = 256 * 1024;
const Flight = Type.Omit(MonitoringReportSourceSchema.properties.flights.items, ['historyStart']);

export const MonitoringReportSourceV2Schema = Type.Object(
  {
    ...MonitoringReportSourceSchema.properties,
    version: Type.Literal('monitoring.window.2'),
    flights: Type.Array(
      Type.Object(
        {
          ...Flight.properties,
          baseline: Type.Object({ eventId: Id, receiptId: Id, sourceEventId: Id, digest: Digest }, Closed),
        },
        Closed,
      ),
      { maxItems: CONTROL_EFFECTIVENESS_LIMITS.maxFlights },
    ),
  },
  {
    ...Closed,
    description:
      'V2 monitoring source, bounded to 128 KiB of strict original bytes, 32 flights and 128 declared incident identities plus baseline references combined. Preserve the declared observed-airborne sample, reported coverage and explicit populationComplete/completeThrough commitments. The control is a control record version that a risk acceptance on its safety-record hazard binds: controlEventId is the version’s event, controlDigest its body digest, and acceptance the risk acceptance with the hazard revision it accepted and the digest of the content its signer signed. Each flight cites its exact accepted mission and native baseline. The first revision pins control, window and sorted flight/aircraft/mission/C2-session/baseline bindings permanently for this source/session/window; later contiguous revisions may correct intervals, gaps, completeness and declared incident membership. Incomplete samples, partial coverage and completeThrough before window.end remain retained evidence without establishing a rate. Reported observed, coverage and gap intervals must have positive finite duration and end no later than occurredAt. completeThrough cannot exceed occurredAt, and occurredAt cannot exceed server receipt. No historyStart or other lower bound, producer aggregate count, exposure total or rate is accepted. Calculation and human review execution remain separate.',
  },
);
export type MonitoringReportSourceV2 = Static<typeof MonitoringReportSourceV2Schema>;

export const MonitoringReportInputV2Schema = Type.Object(
  {
    ...MonitoringReportInputSchema.properties,
    payload: Type.Omit(MonitoringReportSourceV2Schema, ['sourceSessionId', 'occurredAt']),
  },
  {
    ...Closed,
    description:
      'Monitoring input carrying monitoring.window.2 in payload. Session and occurredAt copy the source lexically; payload copies every remaining source field. Organization scope derives from authentication; no subject or organization selector is accepted. New delivery requires input:write, monitoring:write and an explicit sourceId in /v1/me monitoringSources. authority.update omission preserves grants and [] revokes them; no automatic grants or reuse of C2/mission source grants. Exact original-principal endpoint/key/body recovery retains the accepted receipt under active authentication and input:write. New keys, including semantic retries, require current monitoring authority.',
  },
);
export type MonitoringReportInputV2 = Static<typeof MonitoringReportInputV2Schema>;

export const MonitoringRecordV2Schema = Type.Object(
  {
    ...MonitoringRecordSchema.properties,
    version: Type.Literal('monitoring.window.2'),
    source: MonitoringReportSourceV2Schema,
  },
  {
    ...Closed,
    description:
      'Immutable V2 monitoring record with exact source originals and captured ledger.monitoring-authority.1 policy. The ID is the accepted receipt eventId. Historical exact accepted control, acceptance, mission, flight and native baseline references must belong to this tenant and have completed projection. This informational record changes no release policy or incident finding. V1 proposed records retain their original shape and interpretation.',
  },
);
export type MonitoringRecordV2 = Static<typeof MonitoringRecordV2Schema>;

export const MonitoringWindowParamsSchema = Type.Object({ monitoringId: Id }, Closed);
export type MonitoringWindowParams = Static<typeof MonitoringWindowParamsSchema>;
export const MonitoringWindowRecordResponseSchema = Type.Object(
  {
    monitoring: MonitoringRecordV2Schema,
    digest: Digest,
    processing: Type.Union(['pending', 'processing', 'completed', 'failed'].map((state) => Type.Literal(state))),
  },
  {
    ...Closed,
    description:
      'Exact authenticated organization monitoring record, bounded to 256 KiB of JSON. Digest commits monitoring only; processing is current worker state. Original bytes remain available through the artifact endpoint and ordinary evidence exports. This read does not calculate effectiveness.',
  },
);
export type MonitoringWindowRecordResponse = Static<typeof MonitoringWindowRecordResponseSchema>;
