import { Type, type Static } from '@sinclair/typebox';
import { TelemetrySegmentDescriptorSchema } from './telemetry.js';
import type { HistoryPage } from './history.js';
import type { FlightOperationSummary } from './operation.js';
import { FindingSetTreatmentCommandSchema, FindingTreatmentCommandSchema, FindingTreatmentSchema } from './findings.js';
import type { FindingRecord } from './findings.js';
import type { EvaluationInputSubjects, EvaluationSummaryWording } from './rule-evaluations.js';
import { InputCutSchema } from './input-cut.js';
import type { InputCut } from './input-cut.js';
import { PackAdoptionCommandSchema } from './adoptions.js';
import { OrganizationDecisionCommandSchema } from './subject-decisions.js';
import { CommandLinkBaselineInputSchema } from './command-link-baseline.js';
import { MonitoringReportInputV2Schema, type MonitoringReportInputV2 } from './monitoring-window.js';
import { MissionInputSchema } from './missions.js';
import {
  MissionReleaseCommandSchema,
  MissionDepartureAuthorizationCommandSchema,
  type MissionDepartureAuthorizationResult,
} from './mission-release.js';
import { MissionBriefingCommandSchema, MissionBriefingAcknowledgementCommandSchema } from './mission-briefing.js';
import { SmsCommandSchemas, SmsConfidentialitySchema, type SmsConfidentiality } from './sms.js';
export { InputCutSchema, type InputCut } from './input-cut.js';
import { FidelitySchema, type Fidelity } from './fidelity.js';
import {
  ObservationCorrectionCommandSchemas,
  ObservationGrantsSchema,
  ObservationInputConstraintSchema,
  type ObservationGrant,
} from './observation-intake.js';
export { fidelityValues, FidelitySchema, type Fidelity } from './fidelity.js';
import { CredentialCommandSchemas, type IssuedCredential } from './credentials.js';

export const capabilityValues = [
  'input:write',
  'flight:create',
  'flight:read',
  'order:read',
  'decision:write',
  'correction:write',
  'identity:write',
  'authority:write',
  'evidence:read',
  'pack:adopt',
  'monitoring:write',
  'risk:accept:low',
  'risk:accept:medium',
  'risk:accept:high',
  'mission:write',
  'mission:release',
  'briefing:write',
  'briefing:ack',
  'sms:read',
  'sms:write',
  'sms:configure',
  'sms:adopt',
  'sms:restricted:read',
  'sms:report:read',
  'document:read',
] as const;
/**
 * The capabilities that only read. A principal that holds some and nothing else changes nothing: the API refuses every
 * request of theirs that is not a read, and the screens offer them no action. Documented in
 * docs/design/shared-links.md.
 */
export const readCapabilityValues = [
  'flight:read',
  'order:read',
  'evidence:read',
  'document:read',
  'sms:read',
  'sms:restricted:read',
  'sms:report:read',
] as const satisfies readonly (typeof capabilityValues)[number][];
/** Whether a principal holding these capabilities only reads: they hold at least one, and every one reads. */
export function readsOnly(capabilities: readonly string[]): boolean {
  return (
    capabilities.length > 0 &&
    capabilities.every((capability) => (readCapabilityValues as readonly string[]).includes(capability))
  );
}
/**
 * RETAINED: capabilities no longer granted. command-link:write authorized the retired command-link intake; a principal
 * granted it earlier keeps it until it is removed, and authority records accepted under it keep it, but
 * authority.update refuses to grant it anew.
 */
export const retiredCapabilityValues = ['command-link:write'] as const;
export type Capability = (typeof capabilityValues)[number] | (typeof retiredCapabilityValues)[number];
export const CapabilitySchema = Type.Union(
  [...capabilityValues, ...retiredCapabilityValues].map((value) => Type.Literal(value)),
);

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const JsonObject = Type.Record(Type.String(), Type.Unknown());

export interface ResponseMeta {
  requestId: string;
  effectId?: string;
  projectionRevision: number;
  inputCut: InputCut;
  dependencyBasis?: string;
  computedAt: string;
  outstandingWork: number;
}
export interface Principal {
  id: string;
  tenantId: string;
  name: string;
  kind?: AuthorityPrincipal['kind'];
  capabilities: Capability[];
  revision: number;
  commandLinkSources: string[];
  missionSources: string[];
  monitoringSources?: string[];
  observationGrants?: ObservationGrant[];
}

export interface CurrentPrincipalResponse {
  principal: Principal;
  /** Absent only from recordings made before the organization was returned. */
  organization?: OrganizationSummary;
}

export const AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES = 256 * 1024;
export const AuthorityPrincipalParamsSchema = Type.Object({ id: Id }, { additionalProperties: false });
export type AuthorityPrincipalParams = Static<typeof AuthorityPrincipalParamsSchema>;
export const AuthorityPrincipalSchema = Type.Object(
  {
    id: Id,
    tenantId: Id,
    name: Type.String(),
    kind: Type.Union([Type.Literal('human'), Type.Literal('source'), Type.Literal('worker'), Type.Literal('service')]),
    active: Type.Boolean(),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    capabilities: Type.Array(CapabilitySchema),
    commandLinkSources: Type.Array(Id, { maxItems: 100 }),
    missionSources: Type.Array(Id, { maxItems: 100 }),
    monitoringSources: Type.Array(Id, { maxItems: 100 }),
    observationGrants: Type.Optional(ObservationGrantsSchema),
  },
  { additionalProperties: false },
);
export type AuthorityPrincipal = Static<typeof AuthorityPrincipalSchema>;
export const AuthorityPrincipalResponseSchema = Type.Object(
  { principal: AuthorityPrincipalSchema },
  {
    additionalProperties: false,
    description: `Current complete authority of one same-tenant principal, including inactive targets. Requires authority:write. Private, no-store. Foreign and missing targets return 404. No credentials or authentication subjects are included. The complete response is at most ${AUTHORITY_PRINCIPAL_MAX_RESPONSE_BYTES} UTF-8 bytes; oversized authority fails with 413 without truncation. Read its revision and preserve existing capabilities/source grants when using authority.update; a concurrent change conflicts with expectedRevision.`,
  },
);
export type AuthorityPrincipalResponse = Static<typeof AuthorityPrincipalResponseSchema>;
export const PRINCIPAL_AUTHORITY_LIST_LIMIT = 1000;
export const PrincipalAuthorityEntrySchema = Type.Object(
  {
    ...AuthorityPrincipalSchema.properties,
    signInLinked: Type.Boolean({
      description: 'Whether an identity-provider account is tied to this principal. The identity itself is not shown.',
    }),
    noticeEmail: Type.Union([Type.String(), Type.Null()], {
      description: 'The address a person gets email notices at; null when none is kept, and then no email is sent.',
    }),
  },
  { additionalProperties: false },
);
export type PrincipalAuthorityEntry = Static<typeof PrincipalAuthorityEntrySchema>;
export const PrincipalAuthorityListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(
      Type.String({ minLength: 1, maxLength: 4096, description: 'The nextCursor of the previous page.' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: PRINCIPAL_AUTHORITY_LIST_LIMIT, default: PRINCIPAL_AUTHORITY_LIST_LIMIT }),
    ),
    order: Type.Optional(
      Type.Union([Type.Literal('name'), Type.Literal('recent')], {
        description:
          'name (the default): by name, then id. recent: the most recently added first, by when Ledger recorded the addition; those it recorded none for (put on file by a seed) last, by id.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type PrincipalAuthorityListQuery = Static<typeof PrincipalAuthorityListQuerySchema>;
export const PrincipalAuthorityListResponseSchema = Type.Object(
  {
    principals: Type.Array(PrincipalAuthorityEntrySchema, { maxItems: PRINCIPAL_AUTHORITY_LIST_LIMIT }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.String(), Type.Null()], {
      description: 'Send as cursor to read the next page; null on the last page.',
    }),
  },
  {
    additionalProperties: false,
    description: `Every person, source and service of the organization, active and inactive, with their current complete authority, ordered by name and then id (or most recently added first), a page at a time. Workers are not listed. Requires authority:write. Private, no-store. At most ${PRINCIPAL_AUTHORITY_LIST_LIMIT} entries a page; hasMore says whether more exist.`,
  },
);
export type PrincipalAuthorityListResponse = Static<typeof PrincipalAuthorityListResponseSchema>;

/** The organization the signed-in principal belongs to. timeZone is an IANA zone name; every screen shows times in it. */
export const OrganizationSummarySchema = Type.Object(
  { id: Id, name: Type.String(), timeZone: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);
export type OrganizationSummary = Static<typeof OrganizationSummarySchema>;

const ProviderUrl = Type.String({ minLength: 1, maxLength: 500, pattern: '^https?://' });
/** What the web app reads before anyone signs in. Every value is public; nothing here is a secret. */
export const SignInConfigurationSchema = Type.Object(
  {
    deploymentName: Type.String({ minLength: 1, maxLength: 80 }),
    issuers: Type.Array(
      Type.Object(
        {
          issuer: ProviderUrl,
          clientId: Type.String({ minLength: 1 }),
          label: Type.String({ minLength: 1, maxLength: 80 }),
          authorizationEndpoint: Type.Optional(ProviderUrl),
          tokenEndpoint: Type.Optional(ProviderUrl),
          endSessionEndpoint: Type.Optional(ProviderUrl),
        },
        { additionalProperties: false },
      ),
    ),
    developmentTokens: Type.Boolean({
      description: 'Whether the API accepts development tokens: only in local development and tests.',
    }),
  },
  {
    additionalProperties: false,
    description:
      "The deployment's name and the OpenID Connect issuers people sign in through, with the endpoints the API discovered for each. An issuer whose provider cannot be reached is listed without endpoints. No authentication.",
  },
);
export type SignInConfiguration = Static<typeof SignInConfigurationSchema>;

/** Principal kinds a person with authority:write can add. Workers belong to Ledger itself and are never added. */
export const addablePrincipalKindValues = ['human', 'source', 'service'] as const;
export const PersonAddCommandSchema = Type.Object(
  {
    kind: Type.Literal('person.add'),
    name: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    principalKind: Type.Union(addablePrincipalKindValues.map((value) => Type.Literal(value))),
    capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
    observationGrants: Type.Optional(ObservationGrantsSchema),
    note: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        pattern: '\\S',
        description:
          'Why the person is added with this authority, in the words of the person adding them. Kept with the addition.',
      }),
    ),
    signIn: Type.Optional(
      Type.Object(
        {
          issuer: Type.Optional(ProviderUrl),
          subject: Type.String({ minLength: 1, maxLength: 200 }),
        },
        {
          additionalProperties: false,
          description:
            "The OpenID Connect account this person signs in with: the provider's subject (user id), and the issuer, which must be one the deployment accepts and defaults to the issuer of the person adding them. Only for a human.",
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Adds a person, source or service to the organization with the given authority. Requires authority:write. Change what they may do, or deactivate them, with authority.update; no one is ever deleted.',
  },
);
export type PersonAddCommand = Static<typeof PersonAddCommandSchema>;

export const UploadCreateSchema = Type.Object(
  {
    contentType: Type.String({ minLength: 1, maxLength: 200 }),
    byteLength: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
    filename: Type.Optional(Type.String({ maxLength: 200 })),
    confidentiality: Type.Optional(SmsConfidentialitySchema),
  },
  {
    additionalProperties: false,
    description:
      'Confidentiality is fixed at creation. Safety-report and restricted asset uploads are stored apart from ordinary artifacts and never appear in ordinary exports.',
  },
);
export type UploadCreate = Static<typeof UploadCreateSchema>;
export interface Upload {
  id: string;
  status: 'pending' | 'stored' | 'finalized' | 'failed';
  contentType: string;
  byteLength: number;
  sha256?: string;
  artifactId?: string;
  expiresAt?: string;
  confidentiality?: SmsConfidentiality;
}
export interface Artifact {
  id: string;
  uploadId: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  key: string;
  confidentiality?: SmsConfidentiality;
}
export interface UploadResponse {
  upload: Upload;
  meta: ResponseMeta;
}
export interface ArtifactResponse {
  artifact: Artifact;
  meta: ResponseMeta;
}

const inputKindValues = [
  'order.revision',
  'intent.revision',
  'flight.observation',
  'airspace.status',
  'source.observation',
  'telemetry.segment',
  'command-link.baseline',
  'mission.revision',
  'monitoring.window',
  'observation',
] as const;
/**
 * RETAINED: kinds no longer accepted as input. Command-link reports arrive as link.status observations; receipts of
 * reports accepted earlier keep their kind.
 */
export const retiredInputKindValues = ['command-link.status'] as const;
export const ReceiptKindSchema = Type.Union(
  [...inputKindValues, ...retiredInputKindValues].map((value) => Type.Literal(value)),
);
export const InputSchema = Type.Object(
  {
    sourceId: Id,
    sourceSessionId: Type.Optional(Id),
    kind: Type.Union(inputKindValues.map((value) => Type.Literal(value))),
    occurredAt: Time,
    effectiveAt: Type.Optional(Time),
    sourceRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    subject: Type.Optional(
      Type.Object(
        {
          flightId: Type.Optional(Id),
          orderId: Type.Optional(Id),
          externalFlightId: Type.Optional(Id),
          originationKey: Type.Optional(Id),
        },
        { additionalProperties: false },
      ),
    ),
    payload: JsonObject,
    artifactId: Type.Optional(Id),
    fidelity: Type.Optional(FidelitySchema),
    replaces: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          'Observation inputs only: the id of an accepted observation, from the same source, that this observation replaces. An observation is replaced or withdrawn once.',
      }),
    ),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { kind: { not: { const: 'observation' } } }, required: ['kind'] },
        then: {
          not: { required: ['replaces'], description: 'Only an input of kind observation replaces an earlier one.' },
        },
      },
      {
        if: { properties: { kind: { const: 'monitoring.window' } }, required: ['kind'] },
        then: MonitoringReportInputV2Schema,
        else: {
          if: { properties: { kind: { const: 'observation' } }, required: ['kind'] },
          then: ObservationInputConstraintSchema,
          else: { required: ['subject'] },
        },
      },
      {
        if: { properties: { kind: { const: 'mission.revision' } }, required: ['kind'] },
        then: MissionInputSchema,
      },
      {
        if: { properties: { kind: { const: 'command-link.baseline' } }, required: ['kind'] },
        then: CommandLinkBaselineInputSchema,
      },
      {
        if: { properties: { kind: { const: 'telemetry.segment' } }, required: ['kind'] },
        then: {
          required: ['sourceSessionId', 'artifactId', 'fidelity'],
          properties: { payload: TelemetrySegmentDescriptorSchema, fidelity: Type.Literal('synthetic_contract') },
        },
      },
    ],
  },
);
type InputFields = Static<typeof InputSchema>;
export type FlightInput = Omit<InputFields, 'kind' | 'subject' | 'replaces'> & {
  kind: Exclude<InputFields['kind'], 'monitoring.window' | 'observation'>;
  subject: NonNullable<InputFields['subject']>;
};
/** One observation from the vocabulary; payload is the observation object, validated against its registered type. */
export interface ObservationInput {
  sourceId: string;
  kind: 'observation';
  occurredAt: string;
  payload: Record<string, unknown>;
  replaces?: string;
  subject?: never;
  sourceSessionId?: never;
  artifactId?: never;
  fidelity?: never;
  effectiveAt?: never;
  sourceRevision?: never;
}
export type Input = FlightInput | (MonitoringReportInputV2 & { subject?: never; replaces?: never }) | ObservationInput;
export interface Receipt {
  id: string;
  sourceId: string;
  kind: Input['kind'] | (typeof retiredInputKindValues)[number];
  receivedAt: string;
  occurredAt: string;
  status: 'accepted';
  processing: { status: 'pending' | 'processing' | 'completed' | 'failed'; attempts: number; error?: string };
  linkStatus: 'unresolved' | 'candidate' | 'linked';
  flightId?: string;
  orderId?: string;
  artifactId?: string;
  eventId: string;
  payload: Record<string, unknown>;
}
export interface ReceiptResponse {
  receipt: Receipt;
  meta: ResponseMeta;
}
export interface ReceiptListResponse {
  receipts: Receipt[];
  page: HistoryPage;
  meta: ResponseMeta;
}

export const OrderRefSchema = Type.Object(
  { orderId: Id, revision: Type.Integer({ minimum: 0 }), quantity: Type.Optional(Type.Number({ minimum: 0 })) },
  { additionalProperties: false },
);
export const AliasSchema = Type.Object(
  { sourceId: Id, externalId: Id, validFrom: Type.Optional(Time), validTo: Type.Optional(Time) },
  { additionalProperties: false },
);
export const FlightCreateSchema = Type.Object(
  {
    originationKey: Id,
    label: Type.Optional(Type.String({ maxLength: 200 })),
    orderRefs: Type.Optional(Type.Array(OrderRefSchema, { maxItems: 100 })),
    intentRef: Type.Optional(Type.Object({ id: Id, revision: Type.Integer({ minimum: 0 }) })),
    aliases: Type.Optional(Type.Array(AliasSchema, { maxItems: 100 })),
    aircraft: Type.Optional(Type.String({ maxLength: 200 })),
    scheduledStart: Type.Optional(Time),
    scheduledEnd: Type.Optional(Time),
  },
  { additionalProperties: false },
);
export type FlightCreate = Static<typeof FlightCreateSchema>;
export interface FlightPosition {
  latitude: number;
  longitude: number;
  occurredAt: string;
  receivedAt: string;
}
export interface FlightDecisionSummary {
  actorName: string;
  kind: string;
  recordedAt: string;
}
export interface FlightPicture {
  authorization?: 'denied' | 'rescinded' | 'revoked';
  authorizationAt?: string;
  authorizationReceivedAt?: string;
  departedAt?: string;
  cancelledOrderAt?: string;
  cancelledOrderReceivedAt?: string;
  conflictReceivedAt?: string;
  unresolvedReceivedAt?: string;
  lastPosition?: FlightPosition;
  latestDecision?: FlightDecisionSummary;
}
export interface FlightSummary {
  id: string;
  label: string;
  originationKey: string;
  revision: number;
  basisRevision: number;
  activity: 'unknown' | 'planned' | 'active' | 'landed' | 'cancelled';
  coverage: 'unknown' | 'partial' | 'conflicting' | 'recorded';
  aircraft?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  lastOccurredAt?: string;
  lastReceivedAt?: string;
  orderIds: string[];
  sourceIds: string[];
  unresolvedCount: number;
  conflictCount: number;
  outstandingWork: number;
  operation?: FlightOperationSummary;
  findingSummary?: { openCount: number; unownedCount: number; latestTitle?: string };
  picture?: FlightPicture;
}
export interface FlightResponse {
  flight: FlightSummary;
  meta: ResponseMeta;
}
export interface FlightListResponse {
  flights: FlightSummary[];
  meta: ResponseMeta;
  nextCursor?: string | null;
}
export interface OrderSummary {
  id: string;
  externalId: string;
  sourceId: string;
  revision: number;
  status: string;
  flightIds: string[];
  payload: Record<string, unknown>;
}
export interface OrderListResponse {
  orders: OrderSummary[];
  page: HistoryPage;
  meta: ResponseMeta;
}
export type TimelineLane = 'plan' | 'observed' | 'evidence' | 'decisions' | 'checks';
export interface TimelineItem {
  id: string;
  lane: TimelineLane;
  kind: string;
  title: string;
  occurredAt: string;
  receivedAt: string;
  actorId: string;
  sourceId?: string;
  payload: Record<string, unknown>;
  receiptId?: string;
  artifactId?: string;
  correctionOf?: string;
  linkStatus: 'unresolved' | 'candidate' | 'linked';
}
export interface DecisionRecord {
  id: string;
  flightId: string;
  actorId: string;
  kind: string;
  note: string;
  recordedAt: string;
  renderedInputCut: InputCut;
  acceptedInputCut: InputCut;
  acceptedBasisRevision: number;
}
export interface TimelineResponse {
  flight: FlightSummary;
  items: TimelineItem[];
  decisions: DecisionRecord[];
  findings?: FindingRecord[];
  /** The subject each input of the generic evaluations shown was about, by evaluation id; beside, never inside. */
  inputSubjects?: EvaluationInputSubjects;
  /** The rule wording the shown generic evaluations' summaries came from, by evaluation id; beside, never inside. */
  summaryWording?: EvaluationSummaryWording;
  selectedItem: TimelineItem | null;
  selectedDecision: DecisionRecord | null;
  window: { items: HistoryPage; decisions: HistoryPage };
  availableCommands: Capability[];
  meta: ResponseMeta;
}

const Revision = Type.Integer({ minimum: 0 });
export const DecisionCommandSchema = Type.Object(
  {
    kind: Type.Literal('decision.record'),
    flightId: Id,
    expectedRevision: Revision,
    expectedBasisRevision: Revision,
    inputCut: InputCutSchema,
    expectedDependencyBasis: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    findingTreatment: Type.Optional(FindingTreatmentSchema),
    decision: Type.Object({
      kind: Type.String({ minLength: 1, maxLength: 200 }),
      note: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
  },
  { additionalProperties: false },
);
export const CorrectionCommandSchema = Type.Object(
  {
    kind: Type.Literal('evidence.correct'),
    flightId: Id,
    expectedRevision: Revision,
    expectedBasisRevision: Revision,
    inputCut: InputCutSchema,
    expectedDependencyBasis: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    correctionOf: Id,
    occurredAt: Time,
    note: Type.String({ minLength: 1, maxLength: 4000 }),
    payload: JsonObject,
  },
  { additionalProperties: false },
);
export const LinkCommandSchema = Type.Object(
  { kind: Type.Literal('identity.link'), flightId: Id, receiptId: Id, expectedRevision: Revision },
  { additionalProperties: false },
);
export const AssignmentCommandSchema = Type.Object(
  {
    kind: Type.Literal('flight.assign'),
    flightId: Id,
    expectedRevision: Revision,
    expectedBasisRevision: Revision,
    aircraft: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export const AuthorityCommandSchema = Type.Object(
  {
    kind: Type.Literal('authority.update'),
    principalId: Id,
    expectedRevision: Revision,
    capabilities: Type.Array(CapabilitySchema),
    active: Type.Optional(Type.Boolean()),
    missionSources: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
    monitoringSources: Type.Optional(Type.Array(Id, { uniqueItems: true, maxItems: 100 })),
    observationGrants: Type.Optional(ObservationGrantsSchema),
    note: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        pattern: '\\S',
        description:
          'Why what the principal may do changes, in the words of the person changing it. Kept with the change.',
      }),
    ),
  },
  { additionalProperties: false },
);
export const CommandSchema = Type.Union([
  DecisionCommandSchema,
  FindingTreatmentCommandSchema,
  FindingSetTreatmentCommandSchema,
  CorrectionCommandSchema,
  LinkCommandSchema,
  AssignmentCommandSchema,
  AuthorityCommandSchema,
  PersonAddCommandSchema,
  ...CredentialCommandSchemas,
  PackAdoptionCommandSchema,
  OrganizationDecisionCommandSchema,
  MissionReleaseCommandSchema,
  MissionDepartureAuthorizationCommandSchema,
  MissionBriefingCommandSchema,
  MissionBriefingAcknowledgementCommandSchema,
  ...SmsCommandSchemas,
  ...ObservationCorrectionCommandSchemas,
]);
export type Command = Static<typeof CommandSchema>;
export interface CommandRecord {
  id: string;
  kind: Command['kind'];
  flightId?: string;
  subject?: { kind: 'sms'; id: string };
  actorId: string;
  recordedAt: string;
  payload: Record<string, unknown>;
}
export interface CommandResponse {
  command: CommandRecord;
  authorization?: MissionDepartureAuthorizationResult;
  /** Only in the response to credential.issue, and only the first time. */
  credential?: IssuedCredential;
  meta: ResponseMeta;
}
export interface ErrorResponse {
  error: { code: string; message: string; details?: Record<string, unknown> };
  requestId: string;
}
export interface SourceCapability {
  sourceId: string;
  capability: string;
  fidelity: Fidelity;
  schemaDigest?: string;
  limitations: string[];
}
export * from './evidence.js';
export * from './telemetry.js';
export * from './history.js';
export * from './operation.js';
export * from './findings.js';
export * from './open-findings.js';
export * from './rule-packs.js';
export * from './checked-rules.js';
export * from './pack-files.js';
export * from './declared-record-types.js';
export * from './required-records.js';
export * from './notices.js';
export * from './rule-evaluations.js';
export * from './rule-coverage.js';
export * from './adoptions.js';
export * from './adoption-commands.js';
export * from './rule-field-paths.js';
export * from './subject-decisions.js';
export * from './subject-evidence.js';
export * from './flight-evidence.js';
export * from './command-link-proposal.js';
export * from './decision-packets.js';
export * from './finding-packets.js';
export * from './rule-selection.js';
export * from './missions.js';
export * from './mission-route-planning.js';
export * from './mission-route-suggestion.js';
export * from './mission-avoidance.js';
export * from './control-applicability.js';
export * from './mission-release.js';
export * from './mission-briefing.js';
export * from './command-link-baseline.js';
export * from './monitoring-window.js';
export * from './people.js';
export * from './credentials.js';
export * from './assurance-history.js';
export * from './simulation-avoidance-demo.js';
export * from './area-controls.js';

export * from './flight-predeparture.js';
export * from './sms.js';
export * from './safety-report-submission.js';
export * from './sms-standard-matrix.js';
export * from './sms-matrix-rules.js';
export * from './observations/index.js';
export * from './observation-intake.js';
export * from './operator-record-import.js';
export * from './operator-record-mapping.js';
export * from './zoned-time.js';
export * from './request-shape.js';
export * from './operator-record-api.js';
export * from './operator-record-subjects.js';
export * from './operator-record-production.js';
export * from './record-production-links.js';
export * from './program-view.js';
export * from './indicators.js';
export * from './control-windows.js';
export * from './control-indicator-results.js';
export * from './reports.js';
export * from './operating-areas.js';
