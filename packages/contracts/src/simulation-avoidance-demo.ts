import { Type, type Static } from '@sinclair/typebox';
import { MissionAvoidanceCandidateSchema, MissionAvoidanceMissionReferenceSchema } from './mission-avoidance.js';
import { MissionOperatingIntervalSchema } from './missions.js';
import { AreaControlCenterSchema } from './mission-briefing.js';

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Time = Type.String({ format: 'date-time' });
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);
export const SIMULATION_AVOIDANCE_DEMO_LIMITS = Object.freeze({
  page: 25,
  maxPage: 100,
  progress: 128,
  bodyBytes: 16384,
  responseBytes: 262144,
});
export const SIMULATION_AVOIDANCE_DEMO_EVENT_TYPES = [
  'simulation.avoidance-requested',
  'simulation.avoidance-queued',
  'simulation.avoidance-progress',
  'simulation.avoidance-bound',
] as const;

export const SimulationAvoidanceDemoSourceSchema = Type.Object(
  {
    principalId: Id,
    missionSourceId: Id,
    commandLinkSourceId: Id,
    monitoringSourceId: Id,
  },
  Closed,
);
export type SimulationAvoidanceDemoSource = Static<typeof SimulationAvoidanceDemoSourceSchema>;
export const SimulationAvoidanceDemoConfigSchema = Type.Object(
  {
    version: Type.Literal('simulation.avoidance-demo-config.1'),
    tenants: Type.Array(Type.Object({ tenantId: Id, source: SimulationAvoidanceDemoSourceSchema }, Closed), {
      minItems: 1,
      maxItems: 4,
    }),
  },
  Closed,
);
export type SimulationAvoidanceDemoConfig = Static<typeof SimulationAvoidanceDemoConfigSchema>;
export const SimulationAvoidanceDemoControlSchema = Type.Pick(MissionAvoidanceCandidateSchema, [
  'hazardId',
  'controlId',
  'controlVersion',
  'controlEventId',
  'controlDigest',
  'acceptance',
]);
export type SimulationAvoidanceDemoControl = Static<typeof SimulationAvoidanceDemoControlSchema>;
export const SimulationAvoidanceDemoPrepareSchema = Type.Object(
  {
    version: Type.Literal('simulation.avoidance-prepare.1'),
    control: SimulationAvoidanceDemoControlSchema,
    mode: Type.Union([Type.Literal('initial'), Type.Literal('repeat')]),
    previousCycleId: Type.Optional(Id),
    expectedPrincipalRevision: Revision,
  },
  {
    ...Closed,
    description:
      'Opt-in fictional demo preparation only. Initial requests recover one deterministic cycle for this exact control and acceptance. A repeat explicitly names its terminal predecessor and creates a fresh flight; it never replaces a departure authorization. No human safety decision is authored.',
  },
);
export type SimulationAvoidanceDemoPrepare = Static<typeof SimulationAvoidanceDemoPrepareSchema>;
export const SimulationAvoidanceDemoCycleSchema = Type.Object(
  {
    version: Type.Literal('simulation.avoidance-cycle.1'),
    id: Id,
    control: SimulationAvoidanceDemoControlSchema,
    trigger: Type.Union([Type.Literal('initial'), Type.Literal('repeat')]),
    previousCycleId: Type.Union([Id, Type.Null()]),
    requestedAt: Time,
    requestedBy: Type.Object({ id: Id, principalRevision: Revision }, Closed),
    source: SimulationAvoidanceDemoSourceSchema,
  },
  Closed,
);
export type SimulationAvoidanceDemoCycle = Static<typeof SimulationAvoidanceDemoCycleSchema>;
export const simulationAvoidanceDemoPhases = [
  'preparing',
  'held',
  'awaiting_route',
  'awaiting_release',
  'awaiting_briefing',
  'awaiting_acknowledgement',
  'ready',
  'departure_unknown',
  'airborne',
  'monitoring',
  'monitoring_available',
  'blocked',
  'abandoned',
] as const;
export const SimulationAvoidanceDemoReferencesSchema = Type.Object(
  {
    execution: Type.Optional(
      Type.Object({ runId: Id, reservationId: Id, flightId: Id, aircraftId: Id, sourceMissionId: Id }, Closed),
    ),
    mission: Type.Optional(MissionAvoidanceMissionReferenceSchema),
    release: Type.Optional(Reference),
    briefing: Type.Optional(Reference),
    baseline: Type.Optional(Reference),
    departure: Type.Optional(Type.Object({ permit: Reference, attemptId: Id, receiptId: Id }, Closed)),
    monitoring: Type.Optional(Reference),
    controlWindow: Type.Optional(
      Type.Object(
        { id: Id, digest: Digest },
        {
          ...Closed,
          description:
            'The control window the source opened for the flight: its id and the digest of its first revision. Earlier cycles cite a native baseline and a monitoring window instead; those stay as recorded.',
        },
      ),
    ),
  },
  Closed,
);
export type SimulationAvoidanceDemoReferences = Static<typeof SimulationAvoidanceDemoReferencesSchema>;
export const SimulationAvoidanceDemoProgressSchema = Type.Object(
  {
    version: Type.Literal('simulation.avoidance-progress.1'),
    expectedRevision: Type.Integer({ minimum: 0, maximum: SIMULATION_AVOIDANCE_DEMO_LIMITS.progress - 1 }),
    phase: Type.Union(simulationAvoidanceDemoPhases.map((value) => Type.Literal(value))),
    code: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_]*$' }),
    retryable: Type.Boolean(),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    references: SimulationAvoidanceDemoReferencesSchema,
  },
  {
    ...Closed,
    description:
      'Configured source coordinator only; original-key recovery and compare-and-append revision. Fixed execution identity, exact tenant-owned public records and actual human acknowledgements are verified by the server. Status reports do not supply a safety decision, measured exposure or proof of physical control.',
  },
);
export type SimulationAvoidanceDemoProgress = Static<typeof SimulationAvoidanceDemoProgressSchema>;
export const SimulationAvoidanceDemoProgressRecordSchema = Type.Object(
  {
    ...Type.Omit(SimulationAvoidanceDemoProgressSchema, ['expectedRevision']).properties,
    id: Id,
    cycleId: Id,
    revision: Revision,
    recordedAt: Time,
    actorId: Id,
  },
  Closed,
);
export type SimulationAvoidanceDemoProgressRecord = Static<typeof SimulationAvoidanceDemoProgressRecordSchema>;
export const SimulationAvoidanceDemoProgressResponseSchema = Type.Object(
  { progress: SimulationAvoidanceDemoProgressRecordSchema, digest: Digest },
  Closed,
);
export type SimulationAvoidanceDemoProgressResponse = Static<typeof SimulationAvoidanceDemoProgressResponseSchema>;
export const SimulationAvoidanceDemoCycleResponseSchema = Type.Object(
  {
    cycle: SimulationAvoidanceDemoCycleSchema,
    digest: Digest,
    progress: Type.Union([SimulationAvoidanceDemoProgressRecordSchema, Type.Null()]),
    progressDigest: Type.Union([Digest, Type.Null()]),
    processing: Type.Union([
      Type.Literal('pending'),
      Type.Literal('processing'),
      Type.Literal('completed'),
      Type.Literal('failed'),
    ]),
    readAt: Time,
  },
  Closed,
);
export type SimulationAvoidanceDemoCycleResponse = Static<typeof SimulationAvoidanceDemoCycleResponseSchema>;
export const SimulationAvoidanceDemoParamsSchema = Type.Object({ cycleId: Id }, Closed);
export type SimulationAvoidanceDemoParams = Static<typeof SimulationAvoidanceDemoParamsSchema>;
export const SimulationAvoidanceDemoQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: SIMULATION_AVOIDANCE_DEMO_LIMITS.maxPage,
        default: SIMULATION_AVOIDANCE_DEMO_LIMITS.page,
      }),
    ),
  },
  Closed,
);
export type SimulationAvoidanceDemoQuery = Static<typeof SimulationAvoidanceDemoQuerySchema>;
export const SimulationAvoidanceDemoControlQuerySchema = Type.Object(
  {
    ...SimulationAvoidanceDemoQuerySchema.properties,
    controlEventId: Id,
    acceptanceId: Id,
  },
  Closed,
);
export type SimulationAvoidanceDemoControlQuery = Static<typeof SimulationAvoidanceDemoControlQuerySchema>;
export const SimulationAvoidanceDemoListResponseSchema = Type.Object(
  {
    cycles: Type.Array(SimulationAvoidanceDemoCycleResponseSchema, {
      maxItems: SIMULATION_AVOIDANCE_DEMO_LIMITS.maxPage,
    }),
    nextCursor: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
    readAt: Time,
  },
  {
    ...Closed,
    description:
      'Bounded accepted demo-cycle discovery. Exact parent/reader/authority/resource-bound sequence cursors; reads have no side effects, supply no decision basis and do not select another control. Missing/foreign parents return 404; valid empty pages remain empty.',
  },
);
export type SimulationAvoidanceDemoListResponse = Static<typeof SimulationAvoidanceDemoListResponseSchema>;
export const SimulationAvoidanceDemoPreparationQuerySchema = Type.Object(
  { operatingInterval: MissionOperatingIntervalSchema },
  Closed,
);
export type SimulationAvoidanceDemoPreparationQuery = Static<typeof SimulationAvoidanceDemoPreparationQuerySchema>;
export const SimulationAvoidanceDemoPreparationContextSchema = Type.Object(
  {
    version: Type.Literal('simulation.avoidance-preparation-context.1'),
    cycle: Reference,
    operatingInterval: MissionOperatingIntervalSchema,
    evaluatedAt: Time,
    status: Type.Union([Type.Literal('ready'), Type.Literal('insufficient')]),
    controls: Type.Array(
      Type.Object(
        {
          ...Type.Omit(MissionAvoidanceCandidateSchema, ['geometry']).properties,
          center: AreaControlCenterSchema,
          radiusMeters: Type.Number({ exclusiveMinimum: 0, maximum: 10000 }),
        },
        Closed,
      ),
      { maxItems: 64 },
    ),
    candidateCompleteness: Type.Object(
      {
        status: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]),
        count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        limit: Type.Literal(64),
      },
      Closed,
    ),
    contextDigest: Type.Union([Digest, Type.Null()]),
    reasons: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32, uniqueItems: true }),
  },
  {
    ...Closed,
    description:
      'Configured source-only read for one exact cycle and proposed interval. Selects every overlapping accepted control using the existing avoidance register guard, candidate/context resolver and 64-candidate/2MiB bounds, before required mission locations are chosen. No route calculation, preparation side effect or release permission. Incomplete selection, stale context or a mismatched selected control remains insufficient; no client-supplied circle subset is accepted.',
  },
);
export type SimulationAvoidanceDemoPreparationContext = Static<typeof SimulationAvoidanceDemoPreparationContextSchema>;
