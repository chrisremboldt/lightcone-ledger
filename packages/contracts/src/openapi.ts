import { Type } from '@sinclair/typebox';
import {
  RecordProductionCreateSchema,
  RecordProductionListResponseSchema,
  RecordProductionQuerySchema,
  RecordProductionResponseSchema,
} from './operator-record-production.js';
import {
  RecordLinkCreatedSchema,
  RecordLinkCreateSchema,
  RecordLinkListSchema,
  RecordLinkResponseSchema,
  RecordLinkRevokeSchema,
  SharedRecordsFileRequestSchema,
  SharedRecordsRequestSchema,
  SharedRecordsSchema,
} from './record-production-links.js';
import {
  ProgramGrantCreatedSchema,
  ProgramGrantCreateSchema,
  ProgramGrantListSchema,
  ProgramGrantResponseSchema,
  ProgramGrantRevokeSchema,
  ProgramOperatorAddSchema,
  ProgramOperatorAnswersSchema,
  ProgramOperatorListSchema,
  ProgramOperatorRemoveSchema,
  ProgramOperatorResponseSchema,
  ProgramViewDocumentSchema,
  ProgramViewRequestSchema,
} from './program-view.js';
import {
  RecordSubjectFileSchema,
  RecordSubjectQuerySchema,
  RecordSubjectsQuerySchema,
  RecordSubjectsResponseSchema,
} from './operator-record-subjects.js';
import { RecordkeepingPlanDraftResponseSchema, RequiredRecordsResponseSchema } from './required-records.js';
import { AcceptedAreaControlParamsSchema, AcceptedAreaControlResponseSchema } from './area-controls.js';
import {
  FlightPredepartureConfigSchema,
  FlightPredepartureProgressSchema,
  FlightPredepartureProgressRecordSchema,
  FlightPredepartureProgressResponseSchema,
  FlightPredepartureResponseSchema,
} from './flight-predeparture.js';
import { FlightOperationSummarySchema } from './operation.js';
import { CredentialListQuerySchema, CredentialListResponseSchema, IssuedCredentialSchema } from './credentials.js';
import { DevelopmentTokenRequestSchema, DevelopmentTokenResponseSchema } from './development-tokens.js';
import { RolePresetListResponseSchema } from './people.js';
import {
  NoticeEmailUpdateSchema,
  NoticeListQuerySchema,
  NoticeListResponseSchema,
  NoticeSettingsChangeResponseSchema,
  NoticeSettingsResponseSchema,
  NoticeSettingsUpdateSchema,
  NoticeWebhookResponseSchema,
  NoticeWebhookSetResponseSchema,
  NoticeWebhookUpdateSchema,
} from './notices.js';
import {
  AdoptionRuleCoverageResponseSchema,
  RuleCoverageSubjectsQuerySchema,
  RuleCoverageSubjectsResponseSchema,
  SubjectsOnRecordQuerySchema,
  SubjectsOnRecordResponseSchema,
} from './rule-coverage.js';
import {
  LocalReauthenticationResponseSchema,
  LocalReauthenticationSchema,
  SmsExportCreateSchema,
  SmsExportResponseSchema,
  SmsFindingPromotionResponseSchema,
  SmsHomeResponseSchema,
  SmsRecordContentResponseSchema,
  SmsRecordDetailResponseSchema,
  SmsRegisterQuerySchema,
  SmsRegisterResponseSchema,
  SmsSigningPreviewQuerySchema,
  SmsSigningPreviewResponseSchema,
  SmsControlTypeListResponseSchema,
  REAUTHENTICATION_HEADER,
} from './sms.js';
import { routeDescriptions } from './route-descriptions.js';
import {
  FindingsByMonthQuerySchema,
  FindingsByMonthSchema,
  IndicatorHistorySchema,
  PeriodSummarySchema,
  ReportIndicatorListSchema,
  ReportPeriodQuerySchema,
} from './reports.js';
import {
  LinkSafetyReportSchema,
  SafetyReportLinkIssuedSchema,
  SafetyReportLinkIssueSchema,
  SafetyReportLinkListSchema,
  SafetyReportLinkResponseSchema,
  SafetyReportReceiptQuerySchema,
  SafetyReportReceiptSchema,
  SafetyReportStatusSchema,
  SignedInSafetyReportSchema,
} from './safety-report-submission.js';
import {
  FindingActionSchema,
  FindingClosureSchema,
  FindingDecisionReferenceSchema,
  findingClosingReasons,
  findingTreatmentActions,
} from './rule-evaluations.js';
import {
  FlightsOnRecordResponseSchema,
  OpenFindingGroupsQuerySchema,
  OpenFindingGroupsResponseSchema,
  OpenFindingsQuerySchema,
  OpenFindingsResponseSchema,
} from './open-findings.js';
export { EvaluationRecordSchema } from './findings.js';
export { FlightMissionRevisionResponseSchema } from './missions.js';
import {
  AcceptedObservationSchema,
  ObservationGrantsSchema,
  ObservationListResponseSchema,
  ObservationQuerySchema,
} from './observation-intake.js';
import { CheckedRuleLeafSchema } from './checked-rules.js';
import {
  EvaluationInputSubjectsSchema,
  EvaluationSummaryWordingSchema,
  RuleEvaluationListResponseSchema,
  RuleEvaluationRecordSchema,
  RuleEvaluationResponseSchema,
  SubjectFindingListResponseSchema,
  SubjectFindingRecordSchema,
  SubjectRecordQuerySchema,
  SubjectReferenceSchema,
} from './rule-evaluations.js';
import {
  ControlWindowIndicatorParamsSchema,
  ControlWindowIndicatorResponseSchema,
  ControlWindowListResponseSchema,
  ControlWindowOpenSchema,
  ControlWindowQuerySchema,
  ControlWindowResponseSchema,
  ControlWindowReviseSchema,
} from './control-windows.js';
import {
  ControlIndicatorRecordSchema,
  ControlIndicatorResultListResponseSchema,
  ControlIndicatorResultResponseSchema,
  ControlIndicatorReviewResponseSchema,
  ControlIndicatorReviewSchema,
} from './control-indicator-results.js';
import {
  OperatorRecordCommitResponseSchema,
  OperatorRecordImportRequestSchema,
  OperatorRecordListResponseSchema,
  OperatorRecordPreviewResponseSchema,
  OperatorRecordQuerySchema,
  OperatorRecordTemplateParamsSchema,
  OperatorRecordTypesResponseSchema,
} from './operator-record-api.js';
import {
  AliasSchema,
  CapabilitySchema,
  AuthorityPrincipalParamsSchema,
  AuthorityPrincipalSchema,
  AuthorityPrincipalResponseSchema,
  OrganizationSummarySchema,
  PrincipalAuthorityListQuerySchema,
  PrincipalAuthorityListResponseSchema,
  CommandSchema,
  ExportCreateSchema,
  ExportRecordSchema,
  FidelitySchema,
  FlightCreateSchema,
  FlightQuerySchema,
  InputCutSchema,
  InputSchema,
  ReceiptKindSchema,
  HistoryPageSchema,
  OrganizationPeopleQuerySchema,
  OrganizationPersonSchema,
  OrganizationPeoplePageSchema,
  PEOPLE_DIRECTORY_MAX_LIMIT,
  PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES,
  TimelineQuerySchema,
  OrderQuerySchema,
  ReceiptQuerySchema,
  RulePackVersionParamsSchema,
  RulePackVersionResponseSchema,
  DocumentPurposesResponseSchema,
  RulePackListResponseSchema,
  RulePackOriginSchema,
  RuleSourceParamsSchema,
  OrganizationSchema,
  PackAdoptionRecordSchema,
  SubjectDecisionRecordSchema,
  SubjectExportCreateSchema,
  SubjectExportRecordSchema,
  SubjectEvidenceBundleSchema,
  DecisionPacketCreateSchema,
  DecisionPacketQuerySchema,
  DecisionPacketRecordSchema,
  DecisionPacketManifestSchema,
  DecisionPacketSchema,
  DecisionPacketManifestV2Schema,
  DecisionPacketV2Schema,
  FindingPacketCreateSchema,
  FindingPacketListResponseSchema,
  FindingPacketQuerySchema,
  FindingPacketManifestSchema,
  FindingPacketRecordSchema,
  FindingPacketSchema,
  FindingPacketManifestV2Schema,
  FindingPacketV2Schema,
  FlightRuleSelectionRecordSchema,
  FlightRuleSelectionRecordV1Schema,
  FlightRuleSelectionRecordV2Schema,
  FlightRuleSelectionRecordV3Schema,
  FlightRuleSelectionRecordParamsSchema,
  FlightRuleSelectionRecordResponseSchema,
  FlightRuleSelectionConvergenceSchema,
  EvaluationRecordSchema,
  HazardParamsSchema,
  TelemetryDataSchema,
  TelemetryQuerySchema,
  TelemetrySegmentSchema,
  UploadCreateSchema,
  MissionSourceSchema,
  MissionInputSchema,
  MissionAuthoritySchema,
  MissionBindingSchema,
  MissionRevisionRecordSchema,
  MissionProcessingSchema,
  FlightMissionParamsSchema,
  FlightMissionRevisionParamsSchema,
  FlightMissionRevisionResponseSchema,
  CommandLinkBaselineSourceSchema,
  CommandLinkBaselineInputSchema,
  CommandLinkBaselineAuthoritySchema,
  CommandLinkBaselineRecordSchema,
  CommandLinkBaselineRecordResponseSchema,
  FlightCommandLinkBaselineParamsSchema,
  MonitoringReportSourceV2Schema,
  MonitoringReportInputV2Schema,
  MonitoringRecordV2Schema,
  MonitoringWindowParamsSchema,
  MonitoringWindowRecordResponseSchema,
  AssuranceHistoryQuerySchema,
  SimulationAvoidanceDemoPrepareSchema,
  SimulationAvoidanceDemoCycleSchema,
  SimulationAvoidanceDemoProgressSchema,
  SimulationAvoidanceDemoProgressRecordSchema,
  SimulationAvoidanceDemoProgressResponseSchema,
  SimulationAvoidanceDemoCycleResponseSchema,
  SimulationAvoidanceDemoListResponseSchema,
  SimulationAvoidanceDemoControlQuerySchema,
  SimulationAvoidanceDemoQuerySchema,
  SimulationAvoidanceDemoPreparationQuerySchema,
  SimulationAvoidanceDemoPreparationContextSchema,
  AssuranceHistoryPageSchema,
  HazardMonitoringHistoryQuerySchema,
  MonitoringWindowSummarySchema,
  HazardMonitoringHistoryResponseSchema,
  MissionAvoidancePreviewSchema,
  MissionAvoidanceCandidateSchema,
  MissionAvoidanceCalculationSchema,
  FlightMissionAvoidanceParamsSchema,
  MissionRoutePlanningSchema,
  MissionRouteSuggestionRequestSchema,
  MissionRouteSuggestionSchema,
  MissionRouteTimeFitSchema,
  FlightMissionReleaseParamsSchema,
  FlightMissionReleaseFindingsParamsSchema,
  MissionReleaseFindingsResponseSchema,
  FlightControlsParamsSchema,
  FlightControlsResponseSchema,
  MissionReleaseCommandSchema,
  MissionReleasePolicySchema,
  MissionReleaseRecordSchema,
  MissionReleaseRecordResponseSchema,
  MissionReleaseValidityResponseSchema,
  MissionDepartureAuthorizationCommandSchema,
  MissionDeparturePolicySchema,
  MissionDeparturePermitSchema,
  MissionDepartureAuthorizationResultSchema,
  FlightMissionBriefingParamsSchema,
  MissionBriefingCommandSchema,
  MissionBriefingAcknowledgementCommandSchema,
  MissionBriefingPopulationSchema,
  MissionBriefingRecordSchema,
  MissionBriefingAcknowledgementRecordSchema,
  MissionBriefingRecordResponseSchema,
  MissionBriefingAcknowledgementsResponseSchema,
  SignInConfigurationSchema,
} from './index.js';
const S = Type.String();
const N = Type.Integer({ minimum: 0 });
const Time = Type.String({ format: 'date-time' });
const O = Type.Record(S, Type.Unknown());
const stringEnum = (...values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
export const ResponseMetaSchema = Type.Object({
  requestId: S,
  effectId: Type.Optional(S),
  projectionRevision: N,
  inputCut: InputCutSchema,
  dependencyBasis: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  computedAt: Time,
  outstandingWork: N,
});
export const FlightMissionResponseSchema = Type.Object(
  {
    binding: Type.Union([MissionBindingSchema, Type.Null()]),
    acceptedHead: Type.Union([
      Type.Object(
        { record: MissionRevisionRecordSchema, processing: MissionProcessingSchema },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    projectedHead: Type.Union([MissionRevisionRecordSchema, Type.Null()]),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);
export const OrganizationPeopleResponseSchema = Type.Object(
  {
    people: Type.Array(OrganizationPersonSchema, { maxItems: PEOPLE_DIRECTORY_MAX_LIMIT }),
    page: OrganizationPeoplePageSchema,
    meta: ResponseMetaSchema,
  },
  {
    additionalProperties: false,
    description: `Active same-tenant humans only; requires current authentication and flight:read. Private, no-store. Complete serialized response is at most ${PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES} UTF-8 bytes. Oversized identities or pages fail explicitly with 413; reduce page size or narrow search for an oversized page. This live directory is not briefing eligibility or a frozen recipient population.`,
  },
);
export const MissionAvoidanceResponseSchema = Type.Object(
  { ...MissionAvoidancePreviewSchema.properties, meta: ResponseMetaSchema },
  { additionalProperties: false, description: MissionAvoidancePreviewSchema.description },
);
export const MissionRouteSuggestionResponseSchema = Type.Object(
  { ...MissionRouteSuggestionSchema.properties, meta: ResponseMetaSchema },
  { additionalProperties: false, description: MissionRouteSuggestionSchema.description },
);
export const FlightRuleSelectionResponseSchema = Type.Object(
  {
    selection: Type.Union([FlightRuleSelectionRecordSchema, Type.Null()]),
    asOf: Time,
    convergence: FlightRuleSelectionConvergenceSchema,
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);
export const OrganizationCoverageResponseSchema = Type.Object(
  {
    organization: OrganizationSchema,
    asOf: Time,
    adoptions: Type.Array(PackAdoptionRecordSchema),
    packOrigins: Type.Array(
      Type.Object(
        { packId: S, version: Type.Integer({ minimum: 1 }), origin: RulePackOriginSchema },
        { additionalProperties: false },
      ),
      {
        description:
          'Where each pack version the listed adoptions name came from, once per version. A version this Ledger has not registered, such as the accepted-controls pack, is not listed.',
      },
    ),
    limit: Type.Literal(100),
    hasOlder: Type.Boolean(),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);
export const OrganizationDecisionsResponseSchema = Type.Object(
  {
    organization: OrganizationSchema,
    decisions: Type.Array(SubjectDecisionRecordSchema),
    limit: Type.Literal(100),
    hasOlder: Type.Boolean(),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);
export const FindingRecordSchema = Type.Object({
  id: S,
  flightId: S,
  status: stringEnum('open', 'acknowledged', 'responding', 'resolved'),
  owner: Type.Union([Type.Object({ id: S, name: S }), Type.Null()]),
  openedAt: Time,
  initialEvaluation: EvaluationRecordSchema,
  latestEvaluation: EvaluationRecordSchema,
  treatments: Type.Array(
    Type.Object({
      id: S,
      evaluationId: S,
      action: stringEnum(...findingTreatmentActions),
      actorId: S,
      actorName: S,
      note: S,
      recordedAt: Time,
      assignee: Type.Optional(Type.Object({ id: S, name: S })),
      dueOn: Type.Optional(S),
      reason: Type.Optional(stringEnum(...findingClosingReasons)),
      decision: Type.Optional(FindingDecisionReferenceSchema),
    }),
  ),
  hasOlderTreatments: Type.Boolean(),
  action: Type.Optional(FindingActionSchema),
  closure: Type.Optional(FindingClosureSchema),
});
export const FindingsResponseSchema = Type.Object({
  findings: Type.Array(FindingRecordSchema),
  inputSubjects: Type.Optional(EvaluationInputSubjectsSchema),
  summaryWording: Type.Optional(EvaluationSummaryWordingSchema),
  meta: ResponseMetaSchema,
});
export const TelemetryResponseSchema = Type.Object(
  { ...TelemetryDataSchema.properties, meta: ResponseMetaSchema },
  { additionalProperties: false },
);
export const FlightSummarySchema = Type.Object({
  id: S,
  label: S,
  originationKey: S,
  revision: N,
  basisRevision: N,
  operation: Type.Optional(FlightOperationSummarySchema),
  activity: stringEnum('unknown', 'planned', 'active', 'landed', 'cancelled'),
  coverage: stringEnum('unknown', 'partial', 'conflicting', 'recorded'),
  aircraft: Type.Optional(S),
  scheduledStart: Type.Optional(Time),
  scheduledEnd: Type.Optional(Time),
  lastOccurredAt: Type.Optional(Time),
  lastReceivedAt: Type.Optional(Time),
  orderIds: Type.Array(S),
  sourceIds: Type.Array(S),
  unresolvedCount: N,
  conflictCount: N,
  outstandingWork: N,
  findingSummary: Type.Optional(Type.Object({ openCount: N, unownedCount: N, latestTitle: Type.Optional(S) })),
  picture: Type.Optional(
    Type.Object({
      authorization: Type.Optional(stringEnum('denied', 'rescinded', 'revoked')),
      authorizationAt: Type.Optional(Time),
      authorizationReceivedAt: Type.Optional(Time),
      departedAt: Type.Optional(Time),
      cancelledOrderAt: Type.Optional(Time),
      cancelledOrderReceivedAt: Type.Optional(Time),
      conflictReceivedAt: Type.Optional(Time),
      unresolvedReceivedAt: Type.Optional(Time),
      lastPosition: Type.Optional(
        Type.Object({ latitude: Type.Number(), longitude: Type.Number(), occurredAt: Time, receivedAt: Time }),
      ),
      latestDecision: Type.Optional(Type.Object({ actorName: S, kind: S, recordedAt: Time })),
    }),
  ),
});
export const ReceiptSchema = Type.Object({
  id: S,
  sourceId: S,
  kind: ReceiptKindSchema,
  receivedAt: Time,
  occurredAt: Time,
  status: Type.Literal('accepted'),
  processing: Type.Object({
    status: stringEnum('pending', 'processing', 'completed', 'failed'),
    attempts: N,
    error: Type.Optional(S),
  }),
  linkStatus: stringEnum('unresolved', 'candidate', 'linked'),
  flightId: Type.Optional(S),
  orderId: Type.Optional(S),
  artifactId: Type.Optional(S),
  eventId: S,
  payload: O,
});
export const TimelineItemSchema = Type.Object({
  id: S,
  lane: stringEnum('plan', 'observed', 'evidence', 'decisions', 'checks'),
  kind: S,
  title: S,
  occurredAt: Time,
  receivedAt: Time,
  actorId: S,
  sourceId: Type.Optional(S),
  payload: O,
  receiptId: Type.Optional(S),
  artifactId: Type.Optional(S),
  correctionOf: Type.Optional(S),
  linkStatus: stringEnum('unresolved', 'candidate', 'linked'),
});
export const DecisionRecordSchema = Type.Object({
  id: S,
  flightId: S,
  actorId: S,
  kind: S,
  note: S,
  recordedAt: Time,
  renderedInputCut: InputCutSchema,
  acceptedInputCut: InputCutSchema,
  acceptedBasisRevision: N,
});
export const FlightResponseSchema = Type.Object({ flight: FlightSummarySchema, meta: ResponseMetaSchema });
export const FlightListResponseSchema = Type.Object({
  flights: Type.Array(FlightSummarySchema),
  meta: ResponseMetaSchema,
  nextCursor: Type.Optional(Type.Union([S, Type.Null()])),
});
export const TimelineResponseSchema = Type.Object({
  flight: FlightSummarySchema,
  items: Type.Array(TimelineItemSchema),
  decisions: Type.Array(DecisionRecordSchema),
  findings: Type.Optional(Type.Array(FindingRecordSchema)),
  inputSubjects: Type.Optional(EvaluationInputSubjectsSchema),
  summaryWording: Type.Optional(EvaluationSummaryWordingSchema),
  selectedItem: Type.Union([TimelineItemSchema, Type.Null()]),
  selectedDecision: Type.Union([DecisionRecordSchema, Type.Null()]),
  window: Type.Object({ items: HistoryPageSchema, decisions: HistoryPageSchema }),
  availableCommands: Type.Array(CapabilitySchema),
  meta: ResponseMetaSchema,
});
export const ReceiptResponseSchema = Type.Object({ receipt: ReceiptSchema, meta: ResponseMetaSchema });
export const ReceiptListResponseSchema = Type.Object({
  receipts: Type.Array(ReceiptSchema),
  page: HistoryPageSchema,
  meta: ResponseMetaSchema,
});
export const UploadSchema = Type.Object({
  id: S,
  status: stringEnum('pending', 'stored', 'finalized', 'failed'),
  contentType: S,
  byteLength: N,
  sha256: Type.Optional(S),
  artifactId: Type.Optional(S),
  expiresAt: Type.Optional(Time),
});
export const UploadResponseSchema = Type.Object({ upload: UploadSchema, meta: ResponseMetaSchema });
export const ArtifactResponseSchema = Type.Object({
  artifact: Type.Object({ id: S, uploadId: S, sha256: S, byteLength: N, contentType: S, key: S }),
  meta: ResponseMetaSchema,
});
export const CommandResponseSchema = Type.Object({
  command: Type.Object({
    id: S,
    kind: CommandSchema.anyOf
      ? stringEnum(
          'decision.record',
          'evidence.correct',
          'identity.link',
          'flight.assign',
          'authority.update',
          'person.add',
          'credential.issue',
          'credential.revoke',
          'rule-pack.adopt',
          'mission.release',
          'mission.departure-authorize',
          'mission.brief',
          'mission.briefing-acknowledge',
          'sms.record.open',
          'sms.record.revise',
          'sms.attachment.add',
          'sms.record.links',
          'sms.document.acknowledge',
          'observation.withdraw',
          'observation.resolve-subject',
          'subject.alias',
        )
      : S,
    flightId: Type.Optional(S),
    subject: Type.Optional(Type.Object({ kind: Type.Literal('sms'), id: S }, { additionalProperties: false })),
    actorId: S,
    recordedAt: Time,
    payload: O,
  }),
  authorization: Type.Optional(MissionDepartureAuthorizationResultSchema),
  credential: Type.Optional(IssuedCredentialSchema),
  meta: ResponseMetaSchema,
});
export const OrderListResponseSchema = Type.Object({
  orders: Type.Array(
    Type.Object({ id: S, externalId: S, sourceId: S, revision: N, status: S, flightIds: Type.Array(S), payload: O }),
  ),
  page: HistoryPageSchema,
  meta: ResponseMetaSchema,
});
export const SourceListResponseSchema = Type.Object({
  capabilities: Type.Array(
    Type.Object({
      sourceId: S,
      capability: S,
      fidelity: FidelitySchema,
      schemaDigest: Type.Optional(S),
      limitations: Type.Array(S),
    }),
  ),
  meta: ResponseMetaSchema,
});
export const PrincipalResponseSchema = Type.Object({
  principal: Type.Object({
    id: S,
    tenantId: S,
    name: S,
    kind: Type.Optional(AuthorityPrincipalSchema.properties.kind),
    capabilities: Type.Array(CapabilitySchema),
    revision: N,
    commandLinkSources: Type.Array(S),
    missionSources: Type.Array(S),
    monitoringSources: Type.Array(S),
    observationGrants: Type.Optional(ObservationGrantsSchema),
  }),
  organization: Type.Optional(OrganizationSummarySchema),
});
export const ErrorResponseSchema = Type.Object({
  error: Type.Object({ code: S, message: S, details: Type.Optional(O) }),
  requestId: S,
});
export const ExportResponseSchema = Type.Object({ record: ExportRecordSchema, meta: ResponseMetaSchema });
export const SubjectExportResponseSchema = Type.Object({ record: SubjectExportRecordSchema, meta: ResponseMetaSchema });
export const SubjectExportListResponseSchema = Type.Object({
  records: Type.Array(SubjectExportRecordSchema),
  limit: N,
  hasMore: Type.Boolean(),
  meta: ResponseMetaSchema,
});
export const DecisionPacketResponseSchema = Type.Object(
  { record: DecisionPacketRecordSchema, requestId: S },
  { additionalProperties: false },
);
export const FindingPacketResponseSchema = Type.Object(
  { record: FindingPacketRecordSchema, requestId: S },
  { additionalProperties: false },
);
export const DecisionPacketListResponseSchema = Type.Object(
  {
    records: Type.Array(DecisionPacketRecordSchema, { maxItems: 20 }),
    limit: Type.Literal(20),
    hasMore: Type.Boolean(),
    requestId: S,
  },
  { additionalProperties: false },
);
export const ExportListResponseSchema = Type.Object({
  records: Type.Array(ExportRecordSchema),
  limit: N,
  hasMore: Type.Boolean(),
  meta: ResponseMetaSchema,
});
export const DecisionEvidenceBundleSchema = Type.Object({
  format: Type.Literal('ledger.decision-evidence.1'),
  manifest: O,
  manifestDigest: S,
  streams: Type.Array(O),
  entries: Type.Array(
    Type.Object({ canonicalEnvelope: S, envelopeDigest: S, previousHash: S, entryHash: S, encodingVersion: S }),
  ),
  receipts: Type.Array(O),
  artifacts: Type.Array(Type.Object({ tenantId: S, id: S, sha256: S, byteLength: N, contentType: S, bytesBase64: S })),
  decision: DecisionRecordSchema,
  actor: Type.Object({
    id: S,
    authorityRevision: Type.Union([N, Type.Null()]),
    historicalProfile: Type.Literal('not_retained'),
  }),
  cuts: Type.Object({ rendered: InputCutSchema, accepted: InputCutSchema, issuance: InputCutSchema }),
  snapshot: O,
  interpreter: O,
  interpretations: Type.Object({ rendered: O, accepted: O, issuance: O }),
});
const FlightEvidenceFormatSchema = Type.Literal('ledger.flight-evidence.2');
const FlightEvidenceSubjectSchema = Type.Object(
  { kind: Type.Literal('flight'), id: S },
  { additionalProperties: false },
);
export const FlightEvidenceBundleSchema = Type.Object(
  {
    ...DecisionEvidenceBundleSchema.properties,
    format: FlightEvidenceFormatSchema,
    manifest: Type.Object(
      {
        format: FlightEvidenceFormatSchema,
        exportId: S,
        tenantId: S,
        scope: Type.Literal('whole_tenant_prefixes'),
        flightId: S,
        subject: FlightEvidenceSubjectSchema,
        decisionId: S,
        issuedBy: S,
        issuedAt: Time,
        versions: Type.Object({
          integrity: Type.Literal('ledger.v6.sha256.jcs.1'),
          interpretation: Type.Literal('evidence-cut.1'),
          snapshot: Type.Literal('thread.1'),
        }),
        counts: ExportRecordSchema.properties.counts,
        limits: ExportRecordSchema.properties.limits,
        sectionDigests: Type.Object(
          Object.fromEntries(
            [
              'streams',
              'entries',
              'receipts',
              'artifacts',
              'decision',
              'actor',
              'cuts',
              'snapshot',
              'interpreter',
              'interpretations',
              'basisManifest',
            ].map((name) => [name, Type.String({ pattern: '^[a-f0-9]{64}$' })]),
          ),
          { additionalProperties: false },
        ),
        interpretationDigests: Type.Object({ rendered: S, accepted: S, issuance: S }),
        limitations: Type.Array(S),
      },
      { additionalProperties: false },
    ),
    basisManifest: Type.Object({ status: Type.Literal('not_retained') }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
const response = (schema: unknown, description = 'Success') => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotency = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 } };
const signedDecisionWords = 'risk.accept, matrix.adopt, document.adopt or assurance.sign';
const reauthentication = {
  name: REAUTHENTICATION_HEADER,
  in: 'header',
  required: false,
  schema: { type: 'string', minLength: 1 },
  description: `Only for a signed decision (${signedDecisionWords}) on a local Ledger: the grant POST /v1/local/reauthentications returned, used once. On a deployment the signer instead signs in again at the identity provider.`,
};
const queryParameters = (schema: { properties: Record<string, unknown> }) =>
  Object.entries(schema.properties).map(([name, value]) => ({
    name,
    in: 'query',
    schema: value,
    description:
      name.includes('Cursor') || name === 'cursor'
        ? 'Opaque continuation scoped to tenant, principal authority, route and filters. Current read models, not a frozen historical snapshot.'
        : undefined,
  }));
const identifier = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const operation = (operationId: string, schema: unknown, status = 200, body?: unknown, parameters: unknown[] = []) => ({
  operationId,
  security: [{ bearerAuth: [] }],
  parameters,
  ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  responses: {
    [status]: response(schema),
    400: response(ErrorResponseSchema, 'Invalid request'),
    401: response(ErrorResponseSchema, 'Authentication required'),
    403: response(ErrorResponseSchema, 'Missing capability'),
    404: response(ErrorResponseSchema, 'Scoped object unavailable'),
    409: response(ErrorResponseSchema, 'Stale basis or conflicting idempotency content'),
    429: response(ErrorResponseSchema, 'Bounded intake exceeded'),
  },
});
const assuranceHistoryQueryParameters = (schema: { properties: Record<string, unknown>; required?: string[] }) =>
  queryParameters(schema).map((parameter) => ({
    ...parameter,
    required: schema.required?.includes(parameter.name) ?? false,
    description:
      parameter.name === 'cursor'
        ? 'Opaque accepted-history continuation scoped to tenant, current reader authority, route and exact parent/filter IDs. Pages are not a frozen snapshot.'
        : parameter.description,
  }));
const assuranceHistoryOperation = (operationId: string, schema: unknown, parameters: unknown[]) => ({
  ...operation(operationId, schema, 200, undefined, parameters),
  responses: {
    ...operation(operationId, schema).responses,
    200: {
      ...response(schema),
      headers: {
        'Cache-Control': {
          description: 'Accepted history is private and must not be stored in a cache.',
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    413: response(ErrorResponseSchema, 'Retained summary or complete history page exceeds its byte bound'),
  },
});
/** Gives every operation its summary and description from routeDescriptions, keyed by operationId. */
const describePaths = <T extends object>(paths: T): T =>
  Object.fromEntries(
    Object.entries(paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item as Record<string, { operationId: string }>).map(([method, value]) => {
          const text = routeDescriptions[value.operationId];
          // operationId, summary and description lead each operation; the descriptions here replace any written inline.
          return [method, text ? Object.assign({ operationId: value.operationId, ...text }, value, text) : value];
        }),
      ),
    ]),
  ) as T;
export const openApiDocument = {
  openapi: '3.1.0',
  'x-ledger-demo-contract-version': 'ledger.demo-contract.1',
  info: {
    title: 'Lightcone Ledger API',
    version: '0.1.0',
    description:
      'Operational evidence API with bounded durable telemetry. Every product mutation passes through authenticated receipts or commands.',
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Alias: AliasSchema,
      TelemetrySegment: TelemetrySegmentSchema,
      DecisionPacketCreate: DecisionPacketCreateSchema,
      DecisionPacketRecord: DecisionPacketRecordSchema,
      DecisionPacketManifest: DecisionPacketManifestSchema,
      DecisionPacket: DecisionPacketSchema,
      DecisionPacketManifestV2: DecisionPacketManifestV2Schema,
      DecisionPacketV2: DecisionPacketV2Schema,
      DecisionPacketResponse: DecisionPacketResponseSchema,
      DecisionPacketListResponse: DecisionPacketListResponseSchema,
      FindingPacketCreate: FindingPacketCreateSchema,
      FindingPacketRecord: FindingPacketRecordSchema,
      FindingPacketManifest: FindingPacketManifestSchema,
      FindingPacket: FindingPacketSchema,
      FindingPacketManifestV2: FindingPacketManifestV2Schema,
      FindingPacketV2: FindingPacketV2Schema,
      FindingPacketResponse: FindingPacketResponseSchema,
      FindingPacketListResponse: FindingPacketListResponseSchema,
      FlightRuleSelectionRecord: FlightRuleSelectionRecordSchema,
      FlightRuleSelectionRecordV1: FlightRuleSelectionRecordV1Schema,
      FlightRuleSelectionRecordV2: FlightRuleSelectionRecordV2Schema,
      FlightRuleSelectionRecordV3: FlightRuleSelectionRecordV3Schema,
      FlightRuleSelectionResponse: FlightRuleSelectionResponseSchema,
      FlightRuleSelectionRecordResponse: FlightRuleSelectionRecordResponseSchema,
      OrganizationPerson: OrganizationPersonSchema,
      OrganizationPeopleResponse: OrganizationPeopleResponseSchema,
      AuthorityPrincipal: AuthorityPrincipalSchema,
      AuthorityPrincipalResponse: AuthorityPrincipalResponseSchema,
      PrincipalAuthorityListResponse: PrincipalAuthorityListResponseSchema,
      CredentialListResponse: CredentialListResponseSchema,
      RolePresetListResponse: RolePresetListResponseSchema,
      DevelopmentTokenRequest: DevelopmentTokenRequestSchema,
      DevelopmentTokenResponse: DevelopmentTokenResponseSchema,
      OrganizationSummary: OrganizationSummarySchema,
      AcceptedObservation: AcceptedObservationSchema,
      ObservationListResponse: ObservationListResponseSchema,
      CheckedRuleLeaf: CheckedRuleLeafSchema,
      SubjectReference: SubjectReferenceSchema,
      RuleEvaluationRecord: RuleEvaluationRecordSchema,
      RuleEvaluationListResponse: RuleEvaluationListResponseSchema,
      RuleEvaluationResponse: RuleEvaluationResponseSchema,
      SubjectFindingRecord: SubjectFindingRecordSchema,
      SubjectFindingListResponse: SubjectFindingListResponseSchema,
      AcceptedAreaControlResponse: AcceptedAreaControlResponseSchema,
      MissionSource: MissionSourceSchema,
      MissionRoutePlanning: MissionRoutePlanningSchema,
      MissionRouteSuggestionRequest: MissionRouteSuggestionRequestSchema,
      MissionRouteSuggestionResponse: MissionRouteSuggestionResponseSchema,
      MissionRouteTimeFit: MissionRouteTimeFitSchema,
      MissionInput: MissionInputSchema,
      MissionAuthority: MissionAuthoritySchema,
      MissionBinding: MissionBindingSchema,
      MissionRevisionRecord: MissionRevisionRecordSchema,
      FlightMissionResponse: FlightMissionResponseSchema,
      FlightMissionRevisionResponse: FlightMissionRevisionResponseSchema,
      CommandLinkBaselineSource: CommandLinkBaselineSourceSchema,
      CommandLinkBaselineInput: CommandLinkBaselineInputSchema,
      CommandLinkBaselineAuthority: CommandLinkBaselineAuthoritySchema,
      CommandLinkBaselineRecord: CommandLinkBaselineRecordSchema,
      CommandLinkBaselineRecordResponse: CommandLinkBaselineRecordResponseSchema,
      MonitoringReportSourceV2: MonitoringReportSourceV2Schema,
      MonitoringReportInputV2: MonitoringReportInputV2Schema,
      MonitoringRecordV2: MonitoringRecordV2Schema,
      MonitoringWindowRecordResponse: MonitoringWindowRecordResponseSchema,
      AssuranceHistoryQuery: AssuranceHistoryQuerySchema,
      FlightPredepartureConfig: FlightPredepartureConfigSchema,
      FlightPredepartureProgress: FlightPredepartureProgressSchema,
      FlightPredepartureProgressRecord: FlightPredepartureProgressRecordSchema,
      FlightPredepartureProgressResponse: FlightPredepartureProgressResponseSchema,
      FlightPredepartureResponse: FlightPredepartureResponseSchema,
      SimulationAvoidanceDemoPrepare: SimulationAvoidanceDemoPrepareSchema,
      SimulationAvoidanceDemoCycle: SimulationAvoidanceDemoCycleSchema,
      SimulationAvoidanceDemoProgress: SimulationAvoidanceDemoProgressSchema,
      SimulationAvoidanceDemoProgressRecord: SimulationAvoidanceDemoProgressRecordSchema,
      SimulationAvoidanceDemoCycleResponse: SimulationAvoidanceDemoCycleResponseSchema,
      SimulationAvoidanceDemoListResponse: SimulationAvoidanceDemoListResponseSchema,
      SimulationAvoidanceDemoPreparationContext: SimulationAvoidanceDemoPreparationContextSchema,
      AssuranceHistoryPage: AssuranceHistoryPageSchema,
      HazardMonitoringHistoryQuery: HazardMonitoringHistoryQuerySchema,
      MonitoringWindowSummary: MonitoringWindowSummarySchema,
      HazardMonitoringHistoryResponse: HazardMonitoringHistoryResponseSchema,
      MissionAvoidanceCandidate: MissionAvoidanceCandidateSchema,
      MissionAvoidanceCalculation: MissionAvoidanceCalculationSchema,
      MissionAvoidanceResponse: MissionAvoidanceResponseSchema,
      MissionReleaseCommand: MissionReleaseCommandSchema,
      MissionReleasePolicy: MissionReleasePolicySchema,
      MissionReleaseRecord: MissionReleaseRecordSchema,
      MissionReleaseRecordResponse: MissionReleaseRecordResponseSchema,
      MissionReleaseValidityResponse: MissionReleaseValidityResponseSchema,
      MissionReleaseFindingsResponse: MissionReleaseFindingsResponseSchema,
      FlightControlsResponse: FlightControlsResponseSchema,
      MissionDepartureAuthorizationCommand: MissionDepartureAuthorizationCommandSchema,
      MissionDeparturePolicy: MissionDeparturePolicySchema,
      MissionDeparturePermit: MissionDeparturePermitSchema,
      MissionDepartureAuthorizationResult: MissionDepartureAuthorizationResultSchema,
      MissionBriefingCommand: MissionBriefingCommandSchema,
      MissionBriefingAcknowledgementCommand: MissionBriefingAcknowledgementCommandSchema,
      MissionBriefingPopulation: MissionBriefingPopulationSchema,
      MissionBriefingRecord: MissionBriefingRecordSchema,
      MissionBriefingAcknowledgementRecord: MissionBriefingAcknowledgementRecordSchema,
      MissionBriefingRecordResponse: MissionBriefingRecordResponseSchema,
      MissionBriefingAcknowledgementsResponse: MissionBriefingAcknowledgementsResponseSchema,
    },
  },
  paths: describePaths({
    '/v1/flights/{id}/predeparture': {
      get: operation('flightPredeparture', FlightPredepartureResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/flights/{id}/predeparture/progress': {
      post: operation(
        'recordFlightPredepartureProgress',
        FlightPredepartureProgressResponseSchema,
        201,
        FlightPredepartureProgressSchema,
        [identifier('id'), idempotency],
      ),
    },
    '/v1/simulation/avoidance-demos/{cycleId}/preparation-context': {
      post: operation(
        'simulationAvoidanceDemoPreparationContext',
        SimulationAvoidanceDemoPreparationContextSchema,
        200,
        SimulationAvoidanceDemoPreparationQuerySchema,
        [identifier('cycleId')],
      ),
    },
    '/v1/hazards/{id}/avoidance-demos': {
      post: operation(
        'prepareSimulationAvoidanceDemo',
        SimulationAvoidanceDemoCycleResponseSchema,
        201,
        SimulationAvoidanceDemoPrepareSchema,
        [identifier('id'), idempotency],
      ),
      get: assuranceHistoryOperation('hazardSimulationAvoidanceDemos', SimulationAvoidanceDemoListResponseSchema, [
        identifier('id'),
        ...assuranceHistoryQueryParameters(SimulationAvoidanceDemoControlQuerySchema),
      ]),
    },
    '/v1/simulation/avoidance-demos/requests': {
      get: assuranceHistoryOperation(
        'simulationAvoidanceDemoRequests',
        SimulationAvoidanceDemoListResponseSchema,
        assuranceHistoryQueryParameters(SimulationAvoidanceDemoQuerySchema),
      ),
    },
    '/v1/simulation/avoidance-demos/{cycleId}': {
      get: assuranceHistoryOperation('simulationAvoidanceDemo', SimulationAvoidanceDemoCycleResponseSchema, [
        identifier('cycleId'),
      ]),
    },
    '/v1/simulation/avoidance-demos/{cycleId}/progress': {
      post: operation(
        'recordSimulationAvoidanceDemoProgress',
        SimulationAvoidanceDemoProgressResponseSchema,
        201,
        SimulationAvoidanceDemoProgressSchema,
        [identifier('cycleId'), idempotency],
      ),
    },
    '/v1/sign-in': {
      get: {
        operationId: 'signInConfiguration',
        security: [],
        parameters: [],
        responses: { 200: response(SignInConfigurationSchema) },
      },
    },
    '/v1/me': { get: operation('currentPrincipal', PrincipalResponseSchema) },
    '/v1/authority/principals': {
      get: operation(
        'principalAuthorities',
        PrincipalAuthorityListResponseSchema,
        200,
        undefined,
        queryParameters(PrincipalAuthorityListQuerySchema),
      ),
    },
    '/v1/authority/credentials': {
      get: operation(
        'credentials',
        CredentialListResponseSchema,
        200,
        undefined,
        queryParameters(CredentialListQuerySchema),
      ),
    },
    '/v1/authority/presets': {
      get: operation('rolePresets', RolePresetListResponseSchema),
    },
    '/v1/authority/principals/{id}/notice-email': {
      put: operation('setPersonNoticeEmail', NoticeSettingsChangeResponseSchema, 200, NoticeEmailUpdateSchema, [
        identifier('id'),
      ]),
    },
    '/v1/notices/settings': {
      get: operation('noticeSettings', NoticeSettingsResponseSchema),
      put: operation('updateNoticeSettings', NoticeSettingsChangeResponseSchema, 200, NoticeSettingsUpdateSchema),
    },
    '/v1/notices': {
      get: operation('notices', NoticeListResponseSchema, 200, undefined, queryParameters(NoticeListQuerySchema)),
    },
    '/v1/notices/webhook': {
      get: operation('noticeWebhook', NoticeWebhookResponseSchema),
      put: operation('setNoticeWebhook', NoticeWebhookSetResponseSchema, 200, NoticeWebhookUpdateSchema),
    },
    '/v1/authority/principals/{id}/development-token': {
      post: {
        ...operation('issueDevelopmentToken', DevelopmentTokenResponseSchema, 201, undefined, [identifier('id')]),
        requestBody: { required: false, content: { 'application/json': { schema: DevelopmentTokenRequestSchema } } },
      },
    },
    '/v1/authority/principals/{id}': {
      get: {
        ...operation('principalAuthority', AuthorityPrincipalResponseSchema, 200, undefined, [
          { ...identifier('id'), schema: AuthorityPrincipalParamsSchema.properties.id },
        ]),
        responses: {
          ...operation('principalAuthority', AuthorityPrincipalResponseSchema).responses,
          413: response(ErrorResponseSchema, 'Complete principal authority exceeds its response byte bound'),
        },
      },
    },
    '/v1/organization/people': {
      get: {
        ...operation(
          'organizationPeople',
          OrganizationPeopleResponseSchema,
          200,
          undefined,
          queryParameters(OrganizationPeopleQuerySchema),
        ),
        responses: {
          ...operation('organizationPeople', OrganizationPeopleResponseSchema).responses,
          413: response(ErrorResponseSchema, 'Directory identity or page exceeds its byte bound'),
        },
      },
    },
    '/v1/organization/coverage': { get: operation('organizationCoverage', OrganizationCoverageResponseSchema) },
    '/v1/organization/coverage/adoptions/{adoptionId}': {
      get: {
        ...operation('adoptionRuleCoverage', AdoptionRuleCoverageResponseSchema, 200, undefined, [
          identifier('adoptionId'),
        ]),
        description:
          'Each rule of one adoption: how it is checked, the size of its population and its members counted by their latest evaluation under the adoption. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/organization/coverage/adoptions/{adoptionId}/rules/{leafId}/subjects': {
      get: {
        ...operation('ruleCoverageSubjects', RuleCoverageSubjectsResponseSchema, 200, undefined, [
          identifier('adoptionId'),
          identifier('leafId'),
          ...queryParameters(RuleCoverageSubjectsQuerySchema),
        ]),
        description:
          'The members of one rule’s population behind one count, with each one’s name, latest evaluation, open finding and the records not on file. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/organization/open-findings': {
      get: {
        ...operation(
          'openFindings',
          OpenFindingsResponseSchema,
          200,
          undefined,
          queryParameters(OpenFindingsQuerySchema),
        ),
        description:
          'The open findings across every subject, oldest first, by tab and filter. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/organization/open-findings/groups': {
      get: {
        ...operation(
          'openFindingGroups',
          OpenFindingGroupsResponseSchema,
          200,
          undefined,
          queryParameters(OpenFindingGroupsQuerySchema),
        ),
        description:
          'The open findings grouped by pack and rule: how many are open, about how many subjects, how many owned, the oldest, fewest first unless order=most. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/organization/flights-on-record': {
      get: {
        ...operation('flightsOnRecord', FlightsOnRecordResponseSchema),
        description:
          'The flights the organization’s current flight plan records give, upcoming then recent. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/organization/subjects': {
      get: {
        ...operation(
          'subjectsOnRecord',
          SubjectsOnRecordResponseSchema,
          200,
          undefined,
          queryParameters(SubjectsOnRecordQuerySchema).map((parameter) => ({
            ...parameter,
            required: parameter.name === 'kind',
          })),
        ),
        description:
          'Subjects of one kind the organization has on record, with names, for picking one. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/organization/document-purposes': {
      get: {
        ...operation('documentPurposes', DocumentPurposesResponseSchema),
        description:
          'The document purposes the organization’s adopted rule packs declare, for ticking on a controlled document. Requires sms:read.',
      },
    },
    '/v1/organization/required-records': {
      get: {
        ...operation('requiredRecords', RequiredRecordsResponseSchema),
        description:
          'The records the organization’s adopted rule packs say must be kept, each with the quoted paragraph, who keeps it, the Ledger records that hold it, how many are on file and what time they cover, and the retention the text states. Never says a requirement is met. Requires evidence:read.',
      },
    },
    '/v1/organization/recordkeeping-plan/draft': {
      get: {
        ...operation('recordkeepingPlanDraft', RecordkeepingPlanDraftResponseSchema),
        description:
          'A recordkeeping plan drafted from the required records read now, as a controlled document body to open with sms.record.open, with the blanks only the organization can fill. Records nothing. Requires evidence:read.',
      },
    },
    '/v1/organization/decisions': { get: operation('organizationDecisions', OrganizationDecisionsResponseSchema) },
    '/v1/organization/monitoring-windows/{monitoringId}': {
      get: operation('monitoringWindow', MonitoringWindowRecordResponseSchema, 200, undefined, [
        { ...identifier('monitoringId'), schema: MonitoringWindowParamsSchema.properties.monitoringId },
      ]),
    },
    '/v1/hazards/{id}/monitoring-windows': {
      get: assuranceHistoryOperation('hazardMonitoringWindows', HazardMonitoringHistoryResponseSchema, [
        { ...identifier('id'), schema: HazardParamsSchema.properties.id },
        ...assuranceHistoryQueryParameters(HazardMonitoringHistoryQuerySchema),
      ]),
    },
    '/v1/area-controls/{hazardId}/{controlId}/versions/{version}': {
      get: operation(
        'acceptedAreaControl',
        AcceptedAreaControlResponseSchema,
        200,
        undefined,
        Object.entries(AcceptedAreaControlParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/rule-sources/{sourceId}/content': {
      get: {
        ...operation('ruleSourceContent', S, 200, undefined, [
          { name: 'sourceId', in: 'path', required: true, schema: RuleSourceParamsSchema.properties.sourceId },
        ]),
        responses: {
          ...operation('ruleSourceContent', S).responses,
          200: {
            description: 'Original retained rule-source document bytes; SHA-256 is in X-Content-SHA256.',
            content: {
              'text/html': { schema: { type: 'string', format: 'binary' } },
              'application/xml': { schema: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
    '/v1/rule-packs': { get: operation('rulePacks', RulePackListResponseSchema) },
    '/v1/rule-packs/{packId}/versions/{version}': {
      get: operation(
        'rulePackVersion',
        RulePackVersionResponseSchema,
        200,
        undefined,
        Object.entries(RulePackVersionParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/flights': {
      get: operation('listFlights', FlightListResponseSchema, 200, undefined, queryParameters(FlightQuerySchema)),
      post: operation('createFlight', FlightResponseSchema, 201, FlightCreateSchema, [idempotency]),
    },
    '/v1/flights/{id}': { get: operation('getFlight', FlightResponseSchema, 200, undefined, [identifier('id')]) },
    '/v1/flights/{id}/timeline': {
      get: operation('flightTimeline', TimelineResponseSchema, 200, undefined, [
        identifier('id'),
        ...queryParameters(TimelineQuerySchema),
      ]),
    },
    '/v1/flights/{id}/findings': {
      get: operation('flightFindings', FindingsResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/flights/{id}/rule-selection': {
      get: operation('flightRuleSelection', FlightRuleSelectionResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/flights/{id}/mission': {
      get: operation('flightMission', FlightMissionResponseSchema, 200, undefined, [
        { ...identifier('id'), schema: FlightMissionParamsSchema.properties.id },
      ]),
    },
    '/v1/flights/{id}/mission/revisions/{revision}': {
      get: operation(
        'flightMissionRevision',
        FlightMissionRevisionResponseSchema,
        200,
        undefined,
        Object.entries(FlightMissionRevisionParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/flights/{id}/command-link-baselines/{baselineId}': {
      get: operation(
        'commandLinkBaseline',
        CommandLinkBaselineRecordResponseSchema,
        200,
        undefined,
        Object.entries(FlightCommandLinkBaselineParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/flights/{id}/rule-selections/{selectionId}': {
      get: operation('flightRuleSelectionRecord', FlightRuleSelectionRecordResponseSchema, 200, undefined, [
        { ...identifier('id'), schema: FlightRuleSelectionRecordParamsSchema.properties.id },
        { ...identifier('selectionId'), schema: FlightRuleSelectionRecordParamsSchema.properties.selectionId },
      ]),
    },
    '/v1/flights/{id}/telemetry': {
      get: operation('flightTelemetry', TelemetryResponseSchema, 200, undefined, [
        identifier('id'),
        ...queryParameters(TelemetryQuerySchema),
      ]),
    },
    '/v1/flights/{id}/watch': {
      get: {
        ...operation('watchFlight', S, 200, undefined, [
          identifier('id'),
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string', maxLength: 2048 },
            description: 'Scoped snapshot or previous event cursor. Not an authentication credential.',
          },
          {
            name: 'Last-Event-ID',
            in: 'header',
            schema: { type: 'string', maxLength: 2048 },
            description: 'Resume cursor; must agree with cursor when both are supplied.',
          },
        ]),
        responses: {
          200: {
            description:
              'Authenticated UTF-8 SSE notifications: telemetry.updated, flight.updated, resync_required or stream.closed. Event id is a scoped cursor; obtain the initial cursor and durable samples from the telemetry snapshot. Updates contain identifiers and revision only. Resync requires a new snapshot; access_revoked requires clearing private state. Reconnect with a fresh bearer token. No token is accepted in the URL.',
            content: { 'text/event-stream': { schema: Type.String() } },
          },
          400: response(ErrorResponseSchema, 'Invalid cursor'),
          401: response(ErrorResponseSchema, 'Authentication required'),
          403: response(ErrorResponseSchema, 'Missing capability'),
          404: response(ErrorResponseSchema, 'Scoped flight unavailable'),
          429: response(ErrorResponseSchema, 'Live connection limit'),
        },
      },
    },
    '/v1/orders': {
      get: operation('listOrders', OrderListResponseSchema, 200, undefined, queryParameters(OrderQuerySchema)),
    },
    '/v1/inputs': { post: operation('submitInput', ReceiptResponseSchema, 201, InputSchema, [idempotency]) },
    '/v1/observations': {
      get: {
        ...operation(
          'listObservations',
          ObservationListResponseSchema,
          200,
          undefined,
          queryParameters(ObservationQuerySchema).map((parameter) => ({
            ...parameter,
            required:
              (ObservationQuerySchema.required as readonly string[] | undefined)?.includes(parameter.name) ?? false,
          })),
        ),
        description:
          'Accepted observations of one type for one subject. Requires evidence:read. Private, no-store. The time span and ordering are described on the query schema.',
      },
    },
    '/v1/evaluations': {
      get: {
        ...operation(
          'listRuleEvaluations',
          RuleEvaluationListResponseSchema,
          200,
          undefined,
          queryParameters(SubjectRecordQuerySchema).map((parameter) => ({
            ...parameter,
            required:
              (SubjectRecordQuerySchema.required as readonly string[] | undefined)?.includes(parameter.name) ?? false,
          })),
        ),
        description:
          'Evaluations of adopted rules recorded for one subject reference, newest first. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/evaluations/{id}': {
      get: {
        ...operation('getRuleEvaluation', RuleEvaluationResponseSchema, 200, undefined, [identifier('id')]),
        description: 'One recorded rule evaluation. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/findings': {
      get: {
        ...operation(
          'listSubjectFindings',
          SubjectFindingListResponseSchema,
          200,
          undefined,
          queryParameters(SubjectRecordQuerySchema).map((parameter) => ({
            ...parameter,
            required:
              (SubjectRecordQuerySchema.required as readonly string[] | undefined)?.includes(parameter.name) ?? false,
          })),
        ),
        description:
          'Findings the generic evaluator opened for one subject reference, newest first. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/operator-records/types': {
      get: {
        ...operation('listOperatorRecordTypes', OperatorRecordTypesResponseSchema),
        description:
          'Registered operator record types with their field metadata and the import columns generated from it. Requires evidence:read.',
      },
    },
    '/v1/operator-records/types/{recordType}/versions/{version}/template': {
      get: {
        operationId: 'operatorRecordTemplate',
        security: [{ bearerAuth: [] }],
        parameters: [
          { ...identifier('recordType'), schema: OperatorRecordTemplateParamsSchema.properties.recordType },
          { ...identifier('version'), schema: OperatorRecordTemplateParamsSchema.properties.version },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['csv', 'json'] } },
        ],
        responses: {
          200: {
            description: 'An empty import file for the record type: a CSV header row, or a JSON records document.',
            content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } } },
          },
          404: response(ErrorResponseSchema, 'Record type not registered'),
        },
      },
    },
    '/v1/operator-records/imports/preview': {
      post: {
        ...operation(
          'previewOperatorRecordImport',
          OperatorRecordPreviewResponseSchema,
          200,
          OperatorRecordImportRequestSchema,
        ),
        description:
          'Parses and validates every row of a retained file against the record type and reports, per row, what would be recorded or why it is refused. Writes nothing. Requires input:write.',
      },
    },
    '/v1/operator-records/imports': {
      post: {
        ...(() => {
          const committed = operation(
            'commitOperatorRecordImport',
            OperatorRecordCommitResponseSchema,
            201,
            OperatorRecordImportRequestSchema,
          );
          return {
            ...committed,
            responses: {
              200: response(
                OperatorRecordCommitResponseSchema,
                'No row was recorded: each was refused or already recorded',
              ),
              ...committed.responses,
            },
          };
        })(),
        description:
          'Records every acceptable row of a retained file as an operator.record observation through generic intake, citing the file and the row. Answers 201 when at least one row was recorded and 200, with the same body, when none was. Committing the same file again records nothing new. Requires input:write and an observation grant for operator.record under the source.',
      },
    },
    '/v1/operator-records': {
      get: {
        ...operation(
          'listOperatorRecords',
          OperatorRecordListResponseSchema,
          200,
          undefined,
          queryParameters(OperatorRecordQuerySchema),
        ),
        summary: 'Read records by type, subject and dates',
        description:
          'Records by record type, by subject (as its subject, related subject or through a reference) and by the time they are about, newest first and then by id, a page at a time, with completeness, origin and replacement. Replaced records are included. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/operator-records/subjects': {
      get: {
        ...operation(
          'listRecordSubjects',
          RecordSubjectsResponseSchema,
          200,
          undefined,
          queryParameters(RecordSubjectsQuerySchema).map((parameter) => ({
            ...parameter,
            required: parameter.name === 'kind',
          })),
        ),
        summary: 'List the subjects your records are about',
        description:
          'Subjects of one kind that records are about, by your own id, with the name their records give them, how many records are about each and how many findings about each are open. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/operator-records/subjects/{kind}/{id}': {
      get: {
        ...operation('getRecordSubjectFile', RecordSubjectFileSchema, 200, undefined, [
          identifier('kind'),
          identifier('id'),
          ...queryParameters(RecordSubjectQuerySchema),
        ]),
        summary: 'Read one subject’s file',
        description:
          'Every record about one subject grouped by type, what replaced what, the rules that have evaluated it with the latest result of each, and its open findings. Requires evidence:read. Private, no-store.',
      },
    },
    '/v1/record-productions': {
      post: {
        ...operation('createRecordProduction', RecordProductionResponseSchema, 201, RecordProductionCreateSchema, [
          idempotency,
        ]),
        responses: {
          ...operation('createRecordProduction', RecordProductionResponseSchema, 201, RecordProductionCreateSchema)
            .responses,
          413: response(
            ErrorResponseSchema,
            'production_too_large: the selection holds more records, originals or bytes than one file holds',
          ),
        },
        summary: 'Produce records on request',
        description:
          'Produces the chosen records as one .zip: a CSV per record type in the import template’s columns plus when and by whom each was recorded and what replaced it, a printable index.html, and manifest.json with the SHA-256 of every file. Originals are listed, and included when asked. Safety reports and restricted attachments are never included. A recorded command with its own journal event. Requires evidence:read.',
      },
      get: {
        ...operation(
          'listRecordProductions',
          RecordProductionListResponseSchema,
          200,
          undefined,
          queryParameters(RecordProductionQuerySchema),
        ),
        summary: 'List produced records',
        description: 'Every production of records, newest first, with who, when, why, who asked and the selection.',
      },
    },
    '/v1/record-productions/{id}': {
      get: {
        ...operation('getRecordProduction', RecordProductionResponseSchema, 200, undefined, [identifier('id')]),
        summary: 'Read one production of records',
      },
    },
    '/v1/record-productions/{id}/content': {
      get: {
        operationId: 'readRecordProductionBytes',
        security: [{ bearerAuth: [] }],
        summary: 'Download a production of records',
        parameters: [identifier('id')],
        responses: {
          200: {
            description:
              'The kept .zip, checked against its recorded SHA-256. Keep X-Manifest-SHA256 apart from the file to verify it later.',
            content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
            headers: {
              'X-Evidence-Format': { schema: { type: 'string', enum: ['ledger.record-production.1'] } },
              'X-Content-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
              'X-Manifest-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
            },
          },
          404: response(ErrorResponseSchema, 'Scoped object unavailable'),
          409: response(ErrorResponseSchema, 'Kept bytes differ from their record'),
        },
      },
    },
    '/v1/record-productions/{id}/links': {
      post: {
        ...operation('createRecordLink', RecordLinkCreatedSchema, 201, RecordLinkCreateSchema, [
          identifier('id'),
          idempotency,
        ]),
        summary: 'Make a link to one produced set',
        description:
          'A link that opens this produced set to someone who does not sign in, until it expires (7 days unless given, 90 at most) or is revoked. Its secret is 256 random bits, returned once; Ledger keeps only its SHA-256. Recorded with who made it and the note. Requires evidence:read.',
      },
      get: {
        ...operation('listRecordLinks', RecordLinkListSchema, 200, undefined, [identifier('id')]),
        summary: 'List the links to one produced set',
        description:
          'Every link made to this set, newest first, with its state, who made and revoked it and why, and each time it was opened. Never a secret. Requires evidence:read.',
      },
    },
    '/v1/record-production-links/{id}/revoke': {
      post: {
        ...operation('revokeRecordLink', RecordLinkResponseSchema, 200, RecordLinkRevokeSchema, [identifier('id')]),
        summary: 'Revoke a link to a produced set',
        description:
          'The link opens nothing from now on. Recorded with who revoked it and why. Requires evidence:read.',
      },
    },
    '/v1/shared-records': {
      post: {
        ...operation('openSharedRecords', SharedRecordsSchema, 200, SharedRecordsRequestSchema),
        security: [],
        summary: 'Open the produced set a link opens',
        description:
          'No sign-in: the secret from the link finds the set. Each opening is kept, with its time and nothing about who opened it. Expired, revoked and unknown links all answer 404 record_link_not_in_use. Answered with Cache-Control no-store, Referrer-Policy no-referrer and X-Robots-Tag noindex.',
      },
    },
    '/v1/shared-records/file': {
      post: {
        operationId: 'readSharedRecordsFile',
        security: [],
        summary: 'Read one file of the set a link opens',
        requestBody: { required: true, content: { 'application/json': { schema: SharedRecordsFileRequestSchema } } },
        responses: {
          200: {
            description: 'The file, checked against the SHA-256 its manifest lists. The opening is kept.',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          404: response(ErrorResponseSchema, 'record_link_not_in_use, or no file by that name in the set'),
          409: response(ErrorResponseSchema, 'Kept bytes differ from their record'),
        },
      },
    },
    '/v1/shared-records/archive': {
      post: {
        operationId: 'readSharedRecordsArchive',
        security: [],
        summary: 'Download the whole set a link opens',
        requestBody: { required: true, content: { 'application/json': { schema: SharedRecordsRequestSchema } } },
        responses: {
          200: {
            description: 'The kept .zip, checked against its recorded SHA-256. The opening is kept.',
            content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
            headers: {
              'X-Content-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
              'X-Manifest-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
            },
          },
          404: response(ErrorResponseSchema, 'record_link_not_in_use'),
          409: response(ErrorResponseSchema, 'Kept bytes differ from their record'),
        },
      },
    },
    '/v1/program-grants': {
      post: {
        ...operation('createProgramGrant', ProgramGrantCreatedSchema, 201, ProgramGrantCreateSchema, [idempotency]),
      },
      get: {
        ...operation('listProgramGrants', ProgramGrantListSchema),
      },
    },
    '/v1/program-grants/{id}/revoke': {
      post: {
        ...operation('revokeProgramGrant', ProgramGrantResponseSchema, 200, ProgramGrantRevokeSchema, [
          identifier('id'),
        ]),
      },
    },
    '/v1/program-view': {
      post: {
        ...operation('readProgramView', ProgramViewDocumentSchema, 200, ProgramViewRequestSchema),
        security: [],
      },
    },
    '/v1/program-operators': {
      get: {
        ...operation('listProgramOperators', ProgramOperatorListSchema),
      },
      post: {
        ...operation('addProgramOperator', ProgramOperatorResponseSchema, 201, ProgramOperatorAddSchema),
      },
    },
    '/v1/program-operators/{id}/answers': {
      get: {
        ...operation('listProgramOperatorAnswers', ProgramOperatorAnswersSchema, 200, undefined, [identifier('id')]),
      },
    },
    '/v1/program-operators/{id}/read': {
      post: {
        ...operation('askProgramRead', ProgramOperatorResponseSchema, 202, undefined, [identifier('id')]),
      },
    },
    '/v1/program-operators/{id}/remove': {
      post: {
        ...operation(
          'removeProgramOperator',
          Type.Object({ operatorId: Type.String() }, { additionalProperties: false }),
          200,
          ProgramOperatorRemoveSchema,
          [identifier('id')],
        ),
      },
    },
    '/v1/control-windows': {
      post: {
        ...operation('openControlWindow', ControlWindowResponseSchema, 201, ControlWindowOpenSchema, [idempotency]),
        description:
          'Opens a window for an accepted control: the period, the subjects it covers and whether they are declared complete, the observation types it expects and the indicator definitions it is for. Requires monitoring:write.',
      },
      get: {
        ...operation(
          'listControlWindows',
          ControlWindowListResponseSchema,
          200,
          undefined,
          queryParameters(ControlWindowQuerySchema).map((parameter) => ({
            ...parameter,
            required: parameter.name !== 'controlVersion',
          })),
        ),
        description:
          'Every window for one control, newest first, including older source-reported windows in the same shape. Requires evidence:read.',
      },
    },
    '/v1/control-windows/{windowId}': {
      get: {
        ...operation('getControlWindow', ControlWindowResponseSchema, 200, undefined, [identifier('windowId')]),
        description: 'One window with its current revision. Requires evidence:read.',
      },
    },
    '/v1/control-windows/{windowId}/revisions': {
      post: {
        ...operation('reviseControlWindow', ControlWindowResponseSchema, 201, ControlWindowReviseSchema, [
          identifier('windowId'),
          idempotency,
        ]),
        description:
          'Declares the population of the window again. The control, period and expectations stay as opened. Requires monitoring:write.',
      },
    },
    '/v1/control-windows/{windowId}/indicators/{indicatorId}/versions/{version}': {
      get: {
        ...operation(
          'calculateControlWindowIndicator',
          ControlWindowIndicatorResponseSchema,
          200,
          undefined,
          Object.entries(ControlWindowIndicatorParamsSchema.properties).map(([name, schema]) => ({
            name,
            in: 'path',
            required: true,
            schema,
          })),
        ),
        description:
          'Calculates one of the window’s indicators from its declared population, at the evidence cut of its current revision. Requires evidence:read.',
      },
    },
    '/v1/control-windows/{windowId}/indicator-results': {
      post: {
        ...operation(
          'recordControlIndicatorResult',
          ControlIndicatorResultResponseSchema,
          201,
          ControlIndicatorRecordSchema,
          [identifier('windowId'), idempotency],
        ),
        description:
          'Records one indicator result for the window at its current revision, with the request that produced it. A changed window or definition conflicts. Requires decision:write.',
      },
      get: {
        ...operation('listControlIndicatorResults', ControlIndicatorResultListResponseSchema, 200, undefined, [
          identifier('windowId'),
        ]),
        description: 'Recorded results for the window and the reviews of them, newest first. Requires evidence:read.',
      },
    },
    '/v1/control-indicator-results/{resultId}': {
      get: {
        ...operation('getControlIndicatorResult', ControlIndicatorResultResponseSchema, 200, undefined, [
          identifier('resultId'),
        ]),
        description:
          'One recorded result, and whether gathering its request again reads the same inputs. Requires evidence:read.',
      },
    },
    '/v1/reports/summary': {
      get: operation(
        'periodSummary',
        PeriodSummarySchema,
        200,
        undefined,
        queryParameters(ReportPeriodQuerySchema).map((parameter) => ({ ...parameter, required: true })),
      ),
    },
    '/v1/reports/findings-by-month': {
      get: operation(
        'findingsByMonth',
        FindingsByMonthSchema,
        200,
        undefined,
        queryParameters(FindingsByMonthQuerySchema),
      ),
    },
    '/v1/reports/indicators': {
      get: operation('reportIndicators', ReportIndicatorListSchema),
    },
    '/v1/reports/indicators/{indicatorId}/versions/{version}': {
      get: operation('indicatorHistory', IndicatorHistorySchema, 200, undefined, [
        identifier('indicatorId'),
        identifier('version'),
      ]),
    },
    '/v1/control-indicator-reviews': {
      post: {
        ...operation(
          'reviewControlIndicatorResult',
          ControlIndicatorReviewResponseSchema,
          201,
          ControlIndicatorReviewSchema,
          [idempotency],
        ),
        description:
          'A person reviews one recorded indicator result, cited by digest. Requires an active human with decision:write and flight:read.',
      },
    },
    '/v1/control-indicator-reviews/{reviewId}': {
      get: {
        ...operation('getControlIndicatorReview', ControlIndicatorReviewResponseSchema, 200, undefined, [
          identifier('reviewId'),
        ]),
        description: 'One recorded review of an indicator result. Requires evidence:read.',
      },
    },
    '/v1/receipts': {
      get: operation('listReceipts', ReceiptListResponseSchema, 200, undefined, queryParameters(ReceiptQuerySchema)),
    },
    '/v1/receipts/{id}': { get: operation('getReceipt', ReceiptResponseSchema, 200, undefined, [identifier('id')]) },
    '/v1/uploads': { post: operation('createUpload', UploadResponseSchema, 201, UploadCreateSchema, [idempotency]) },
    '/v1/uploads/{id}': { get: operation('getUpload', UploadResponseSchema, 200, undefined, [identifier('id')]) },
    '/v1/uploads/{id}/content': {
      put: {
        ...operation('putUploadBytes', UploadResponseSchema, 200, undefined, [identifier('id'), idempotency]),
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    },
    '/v1/uploads/{id}/finalize': {
      post: operation('finalizeUpload', ArtifactResponseSchema, 201, undefined, [identifier('id'), idempotency]),
    },
    '/v1/artifacts/{id}': { get: operation('getArtifact', ArtifactResponseSchema, 200, undefined, [identifier('id')]) },
    '/v1/artifacts/{id}/content': {
      get: {
        operationId: 'readArtifactBytes',
        security: [{ bearerAuth: [] }],
        parameters: [identifier('id')],
        responses: {
          200: {
            description: 'Original bytes',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          404: response(ErrorResponseSchema, 'Scoped object unavailable'),
        },
      },
    },
    '/v1/commands': {
      post: operation('submitCommand', CommandResponseSchema, 201, CommandSchema, [idempotency, reauthentication]),
    },
    '/v1/sms/control-types': { get: operation('smsControlTypes', SmsControlTypeListResponseSchema) },
    '/v1/sms/program': {
      get: operation('smsProgram', Type.Object({ active: Type.Boolean() }, { additionalProperties: false })),
    },
    '/v1/sms/home': { get: operation('smsHome', SmsHomeResponseSchema) },
    '/v1/sms/records': {
      get: operation('smsRegister', SmsRegisterResponseSchema, 200, undefined, queryParameters(SmsRegisterQuerySchema)),
    },
    '/v1/sms/records/{id}': {
      get: operation('smsRecord', SmsRecordDetailResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/sms/records/{id}/signing': {
      get: operation('smsSigningPreview', SmsSigningPreviewResponseSchema, 200, undefined, [
        identifier('id'),
        ...queryParameters(SmsSigningPreviewQuerySchema),
      ]),
    },
    '/v1/sms/findings/{findingId}/promotion': {
      get: operation('smsFindingPromotion', SmsFindingPromotionResponseSchema, 200, undefined, [
        identifier('findingId'),
      ]),
    },
    '/v1/sms/records/{id}/content': {
      get: operation('smsRecordContent', SmsRecordContentResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/sms/attachments/{id}/content': {
      get: {
        operationId: 'smsAttachmentContent',
        security: [{ bearerAuth: [] }],
        parameters: [identifier('id')],
        description:
          'Original attachment bytes. Restricted classes need the matching capability and each disclosure is retained.',
        responses: {
          200: {
            description: 'Original bytes',
            content: { 'application/octet-stream': { schema: { type: 'string' } } },
          },
          403: response(ErrorResponseSchema, 'Missing capability for this confidentiality class'),
          404: response(ErrorResponseSchema, 'Scoped object unavailable'),
        },
      },
    },
    '/v1/sms/exports/{id}/packet': {
      get: {
        operationId: 'smsExportPacket',
        security: [{ bearerAuth: [] }],
        parameters: [identifier('id')],
        description: 'A human-readable reading copy rendered from the retained, integrity-checked export bundle.',
        responses: {
          200: { description: 'HTML packet', content: { 'text/html': { schema: { type: 'string' } } } },
          404: response(ErrorResponseSchema, 'Scoped object unavailable'),
        },
      },
    },
    '/v1/safety-reports': {
      post: operation('submitSafetyReport', SafetyReportReceiptSchema, 201, SignedInSafetyReportSchema),
    },
    '/v1/safety-report-links/submissions': {
      post: {
        ...operation('submitSafetyReportThroughLink', SafetyReportReceiptSchema, 201, LinkSafetyReportSchema),
        security: [],
      },
    },
    '/v1/safety-reports/receipt': {
      post: {
        ...operation('safetyReportReceiptStatus', SafetyReportStatusSchema, 200, SafetyReportReceiptQuerySchema),
        security: [],
      },
    },
    '/v1/sms/report-links': {
      get: operation('safetyReportLinks', SafetyReportLinkListSchema),
      post: operation('issueSafetyReportLink', SafetyReportLinkIssuedSchema, 201, SafetyReportLinkIssueSchema, [
        idempotency,
      ]),
    },
    '/v1/sms/report-links/{id}/revoke': {
      post: operation('revokeSafetyReportLink', SafetyReportLinkResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/sms/exports': {
      post: operation('createSmsExport', SmsExportResponseSchema, 201, SmsExportCreateSchema, [idempotency]),
    },
    '/v1/sms/exports/{id}': {
      get: operation('smsExport', SmsExportResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/sms/exports/{id}/content': {
      get: {
        operationId: 'smsExportContent',
        security: [{ bearerAuth: [] }],
        parameters: [identifier('id')],
        description: 'The ledger.sms-export.1 bundle. Verify it offline with tools/verifier/sms-cli.mjs.',
        responses: {
          200: {
            description: 'Canonical JSON bundle',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          404: response(ErrorResponseSchema, 'Scoped object unavailable'),
        },
      },
    },
    '/v1/local/reauthentications': {
      post: {
        ...operation('localReauthentication', LocalReauthenticationResponseSchema, 201, LocalReauthenticationSchema),
      },
    },
    '/v1/sources': { get: operation('sourceCapabilities', SourceListResponseSchema) },
    '/v1/exports': {
      post: operation('createDecisionExport', ExportResponseSchema, 201, ExportCreateSchema, [idempotency]),
      get: operation('listDecisionExports', ExportListResponseSchema, 200, undefined, [
        { name: 'flightId', in: 'query', schema: { type: 'string' } },
        { name: 'decisionId', in: 'query', schema: { type: 'string' } },
      ]),
    },
    '/v1/decision-packets': {
      post: {
        ...operation('createDecisionPacket', DecisionPacketResponseSchema, 201, DecisionPacketCreateSchema, [
          idempotency,
        ]),
        deprecated: true,
        description:
          'No longer issues packets: every request is refused with 410 decision_packet_retired. Issue a finding packet for the finding instead. Decision packets issued earlier stay readable.',
        responses: {
          ...operation('createDecisionPacket', DecisionPacketResponseSchema).responses,
          410: response(ErrorResponseSchema, 'Decision packets are no longer issued'),
        },
      },
      get: operation(
        'listDecisionPackets',
        DecisionPacketListResponseSchema,
        200,
        undefined,
        queryParameters(DecisionPacketQuerySchema),
      ),
    },
    '/v1/decision-packets/{id}': {
      get: operation('getDecisionPacket', DecisionPacketResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/decision-packets/{id}/content': {
      get: {
        ...operation(
          'readDecisionPacketBytes',
          Type.Union([DecisionPacketSchema, DecisionPacketV2Schema]),
          200,
          undefined,
          [identifier('id')],
        ),
        responses: {
          ...operation('readDecisionPacketBytes', Type.Union([DecisionPacketSchema, DecisionPacketV2Schema])).responses,
          200: {
            ...response(
              Type.Union([DecisionPacketSchema, DecisionPacketV2Schema]),
              'Exact selected C2 finding-treatment packet bytes; no journal membership, complete-prefix, historical display, evaluator replay or present-health claim.',
            ),
            headers: {
              'X-Evidence-Format': {
                schema: { type: 'string', enum: ['ledger.decision-packet.1', 'ledger.decision-packet.2'] },
              },
              'X-Content-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
              'X-Manifest-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
            },
          },
        },
      },
    },
    '/v1/finding-packets': {
      post: operation('createFindingPacket', FindingPacketResponseSchema, 201, FindingPacketCreateSchema, [
        idempotency,
      ]),
      get: operation(
        'listFindingPackets',
        FindingPacketListResponseSchema,
        200,
        undefined,
        queryParameters(FindingPacketQuerySchema),
      ),
    },
    '/v1/finding-packets/{id}': {
      get: operation('getFindingPacket', FindingPacketResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/finding-packets/{id}/content': {
      get: {
        ...operation(
          'readFindingPacketBytes',
          Type.Union([FindingPacketSchema, FindingPacketV2Schema]),
          200,
          undefined,
          [identifier('id')],
        ),
        responses: {
          ...operation('readFindingPacketBytes', Type.Union([FindingPacketSchema, FindingPacketV2Schema])).responses,
          200: {
            ...response(
              Type.Union([FindingPacketSchema, FindingPacketV2Schema]),
              'Exact packet bytes for one finding: its evaluations, the records they read and the decisions recorded about it. No journal membership, complete-prefix, evaluator replay or determination that a requirement is met.',
            ),
            headers: {
              'X-Evidence-Format': {
                schema: { type: 'string', enum: ['ledger.finding-packet.1', 'ledger.finding-packet.2'] },
              },
              'X-Content-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
              'X-Manifest-SHA256': { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
            },
          },
        },
      },
    },
    '/v1/subject-exports': {
      post: operation('createSubjectExport', SubjectExportResponseSchema, 201, SubjectExportCreateSchema, [
        idempotency,
      ]),
      get: operation('listSubjectExports', SubjectExportListResponseSchema, 200, undefined, [
        { name: 'decisionId', in: 'query', schema: { type: 'string' } },
      ]),
    },
    '/v1/subject-exports/{id}': {
      get: operation('getSubjectExport', SubjectExportResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/subject-exports/{id}/content': {
      get: {
        operationId: 'readSubjectExportBytes',
        security: [{ bearerAuth: [] }],
        parameters: [identifier('id')],
        responses: {
          200: response(
            SubjectEvidenceBundleSchema,
            'Immutable subject bundle bytes and retained-record verification; no evaluator replay or historical browser reconstruction.',
          ),
          401: response(ErrorResponseSchema, 'Authentication required'),
          403: response(ErrorResponseSchema, 'Evidence capability required'),
          404: response(ErrorResponseSchema, 'Scoped export unavailable'),
          409: response(ErrorResponseSchema, 'Retained bytes failed integrity verification'),
        },
      },
    },
    '/v1/exports/{id}': {
      get: operation('getDecisionExport', ExportResponseSchema, 200, undefined, [identifier('id')]),
    },
    '/v1/exports/{id}/content': {
      get: {
        operationId: 'readDecisionExportBytes',
        security: [{ bearerAuth: [] }],
        parameters: [identifier('id')],
        responses: {
          200: {
            ...response(
              Type.Union([DecisionEvidenceBundleSchema, FlightEvidenceBundleSchema]),
              'Immutable complete JSON bundle bytes. The explicit format selects verification; stored v1 bundles stay unchanged. X-Content-SHA256 hashes these bytes and X-Manifest-SHA256 is the canonical manifest anchor.',
            ),
            headers: {
              'X-Evidence-Format': {
                description: 'The format of the retained bytes, including legacy downloads.',
                schema: { type: 'string', enum: ['ledger.decision-evidence.1', 'ledger.flight-evidence.2'] },
              },
            },
          },
          401: response(ErrorResponseSchema, 'Authentication required'),
          403: response(ErrorResponseSchema, 'Evidence capability required'),
          404: response(ErrorResponseSchema, 'Scoped export unavailable'),
          409: response(ErrorResponseSchema, 'Retained bytes failed integrity verification'),
        },
      },
    },
    '/v1/flights/{id}/mission-avoidance': {
      get: operation('flightMissionAvoidance', MissionAvoidanceResponseSchema, 200, undefined, [
        { ...identifier('id'), schema: FlightMissionAvoidanceParamsSchema.properties.id },
      ]),
    },
    '/v1/flights/{id}/mission/route-suggestion': {
      post: operation(
        'flightMissionRouteSuggestion',
        MissionRouteSuggestionResponseSchema,
        200,
        MissionRouteSuggestionRequestSchema,
        [{ ...identifier('id'), schema: FlightMissionAvoidanceParamsSchema.properties.id }],
      ),
    },
    '/v1/flights/{id}/mission-releases/{releaseId}': {
      get: operation(
        'flightMissionRelease',
        MissionReleaseRecordResponseSchema,
        200,
        undefined,
        Object.entries(FlightMissionReleaseParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/flights/{id}/mission-release-findings': {
      get: operation('flightMissionReleaseFindings', MissionReleaseFindingsResponseSchema, 200, undefined, [
        { ...identifier('id'), schema: FlightMissionReleaseFindingsParamsSchema.properties.id },
      ]),
    },
    '/v1/flights/{id}/controls': {
      get: operation('flightControls', FlightControlsResponseSchema, 200, undefined, [
        { ...identifier('id'), schema: FlightControlsParamsSchema.properties.id },
      ]),
    },
    '/v1/flights/{id}/mission-releases/{releaseId}/validity': {
      get: operation(
        'flightMissionReleaseValidity',
        MissionReleaseValidityResponseSchema,
        200,
        undefined,
        Object.entries(FlightMissionReleaseParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/flights/{id}/briefings/{briefingId}': {
      get: operation(
        'flightMissionBriefing',
        MissionBriefingRecordResponseSchema,
        200,
        undefined,
        Object.entries(FlightMissionBriefingParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
    '/v1/flights/{id}/briefings/{briefingId}/acknowledgements': {
      get: operation(
        'flightMissionBriefingAcknowledgements',
        MissionBriefingAcknowledgementsResponseSchema,
        200,
        undefined,
        Object.entries(FlightMissionBriefingParamsSchema.properties).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema,
        })),
      ),
    },
  }),
};
