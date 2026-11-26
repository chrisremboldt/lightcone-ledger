export * from './flight-predeparture.js';
import { dueRuleEvaluationWorkSql } from './rule-evaluations.js';
import { randomUUID } from 'node:crypto';
import type {
  Command,
  MissionInput,
  CommandRecord,
  FlightCreate,
  FlightInput,
  FlightSummary,
  Input,
  InputCut,
  IssuedCredential,
  Receipt,
  ResponseMeta,
  SimulationAvoidanceDemoConfig,
  ObservationGrant,
} from '@ledger/contracts';
import { retiredCapabilityValues } from '@ledger/contracts';
import {
  appendEvent,
  appendLiveChange,
  authFromRow,
  DomainError,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import { canonicalDigest } from '@ledger/integrity';
import { getFlight } from './roster.js';
import { readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import { validateFlightFindingTreatment } from './findings.js';
import { acceptFindingTreatment, recordFindingTreatment } from './finding-work.js';
import { acceptFindingSetTreatment } from './finding-sets.js';
import { acceptPackAdoption, organization } from './adoptions.js';
import { registerFlightOrganization, validateFlightRuleSelection } from './rule-selections.js';
import { acceptOrganizationDecision } from './organization-decisions.js';
import { requireEvidenceCorrectionTarget } from './corrections.js';
import { addSmsAttachment, openSmsRecord, reviseSmsRecord, setSmsRecordLinks } from './sms-envelope.js';
import { acceptSmsDecision, isSmsDecisionCommand, type Reauthenticate } from './sms-decisions.js';
import { acknowledgeDocumentIssue } from './sms-reading.js';
export { getPrincipalAuthority } from './authority.js';
export {
  addPerson,
  administratorCapabilities,
  createOrganization,
  getOrganizationSummary,
  listPrincipalAuthority,
  operatorRecordGrant,
  validTimeZone,
  type OrganizationCreation,
  type OrganizationCreationResult,
  type SignInIdentity,
} from './principal-authority.js';
export {
  DEVELOPMENT_TOKEN_LABEL,
  issueDevelopmentToken,
  issueCredential,
  listCredentials,
  newCredentialSecret,
  newDevelopmentToken,
  revokeCredential,
} from './credentials.js';
import { issueCredential, revokeCredential } from './credentials.js';
export * from './simulation-avoidance-demo.js';
export * from './safety-report-submission.js';
import { enqueueInitialSimulationAvoidanceDemos } from './simulation-avoidance-demo.js';
export {
  projectObservationEvent,
  registerObservationProjector,
  settleObservationEvent,
  type ObservationProjector,
} from './observation-projectors.js';
import { acceptMonitoringWindowInput } from './monitoring-window.js';
import { acceptObservationInput, replaceObservationGrants } from './observations.js';
import { addPerson } from './principal-authority.js';
import { aliasSubjectIdentity, resolveObservationSubject, withdrawObservation } from './observation-corrections.js';
import {
  bridgeLegacyFlightReport,
  bridgeLegacyFlightReportCorrection,
  bridgeLegacyFlightReportLink,
  lockLegacyFlightReportCorrection,
  lockLegacyFlightReportLink,
} from './legacy-flight-report-bridge.js';
export {
  getObservationGrants,
  correctionSql,
  listObservations,
  type ObservationAuthority,
  type ObservationReadOptions,
} from './observations.js';
export {
  observationRegistry,
  observationTypeChoices,
  registerObservationRecordTypes,
  registerObservationTypes,
  validateObservation,
} from './observation-registry.js';
export {
  backfillObservationReferencesPage,
  declaredReferenceKinds,
  indexObservationReferences,
  observationReferences,
  type ReferenceBackfillPage,
  type WrittenReference,
} from './observation-references.js';
export {
  listOperatorRecords,
  operatorRecordObservationTypes,
  readRecordRows,
  recordSubjectOf,
  recordView,
  requireRecordRead,
  storedRecord,
  type RecordFilter,
  type RecordRow,
  type RecordSubject,
} from './operator-record-reads.js';
export { getRecordSubjectFile, listRecordSubjects, recordNamesOf } from './operator-record-subjects.js';
export {
  commitOperatorRecordImport,
  listOperatorRecordTypes,
  previewOperatorRecordImport,
  requireOperatorRecordDefinition,
} from './operator-record-import.js';
export {
  acceptMonitoringWindowInput,
  verifyMonitoringWindowInputSource,
  validateAcceptedMonitoringAuthority,
  projectMonitoringWindowEvent,
  getMonitoringWindow,
} from './monitoring-window.js';
export { getHazardMonitoringHistory } from './assurance-history.js';
import { acceptMissionInput } from './missions.js';
import { acceptMissionRelease } from './mission-release.js';
import { acceptMissionDeparture } from './mission-departure.js';
import { acceptMissionBriefing, acceptMissionBriefingAcknowledgement } from './mission-briefing.js';
export { getMissionBriefing, getMissionBriefingAcknowledgements } from './mission-briefing.js';
export { briefingStanding } from './briefing-standing.js';
export { projectMissionBriefingEvent } from './mission-briefing-projection.js';
export { getMissionDepartureAuthorization } from './mission-departure.js';
export { projectMissionDepartureEvent } from './mission-departure-projection.js';
export { getMissionRelease, getMissionReleaseValidity } from './mission-release.js';
export { projectMissionReleaseEvent } from './mission-release-projection.js';
export { getMissionReleaseFindings } from './mission-release-findings.js';
export {
  acceptedAreaControls,
  getMissionAvoidance,
  missionAvoidanceContextDigest,
  reviewConsideredControls,
  type AcceptedAreaControl,
} from './mission-avoidance.js';
export { getMissionRouteSuggestion } from './mission-route-suggestion.js';
export {
  getFlightMission,
  getFlightMissionRevision,
  projectMissionEvent,
  validateAcceptedMissionAuthority,
  verifyMissionInputSource,
} from './missions.js';
export {
  validateAcceptedCommandLinkAuthority,
  verifyCommandLinkInputSource,
  type VerifiedCommandLinkSource,
} from './command-link.js';
export {
  validateAcceptedCommandLinkBaselineAuthority,
  verifyCommandLinkBaselineInputSource,
  getCommandLinkBaseline,
  projectCommandLinkBaselineEvent,
} from './command-link-baseline.js';
export { flightEvaluationRecord, getFindings } from './findings.js';
export {
  findingAttention,
  getFlightsOnRecord,
  groupOpenFindings,
  listOpenFindingGroups,
  listOpenFindings,
  readOpenFindingEntries,
  selectOpenFindings,
  type AboutBounds,
  type OpenFindingEntry,
} from './open-findings.js';
export { bridgeLegacyFlightReportLink } from './legacy-flight-report-bridge.js';
export { registerSubjectFindingView, type SubjectFindingView } from './subject-findings.js';
export { acceptPackAdoption, getOrganizationCoverage, projectPackAdoption } from './adoptions.js';
export { getFlightRuleSelection, getFlightRuleSelectionRecord, refreshFlightRuleSelection } from './rule-selections.js';
export { ruleEvaluatorReference } from './rule-selections.js';
export {
  acceptOrganizationDecision,
  getOrganizationDecisions,
  projectOrganizationDecision,
} from './organization-decisions.js';
export {
  getRulePackVersion,
  getRuleSource,
  isRulePackRegistered,
  registerRulePack,
  type RetainedRuleSource,
  type RulePackRegistration,
} from './rule-pack-registry.js';
export { listRulePackVersions, rulePackOrigin } from './rule-pack-registry.js';
export {
  declaredRecordTypesProblem,
  intakeRegistry,
  organizationRecordTypes,
  recordTypesOfPacks,
  requireRecordType,
  type OrganizationRecordTypes,
} from './organization-record-types.js';
export {
  evaluateAuthorizationEvidence,
  type AuthorizationEvidenceInput,
  type AuthorizationEvidenceResult,
  type AuthorizationStatusClaim,
  type AuthorizationScope,
  type ReportedAuthorizationInterval,
} from './rules/authorization-evidence-v1.js';
export { getFlight, getFlights } from './roster.js';
export {
  openSmsRecord,
  reviseSmsRecord,
  addSmsAttachment,
  setSmsRecordLinks,
  smsDependencyBasis,
  SMS_KINDS,
} from './sms-envelope.js';
export { acceptSmsDecision, isSmsDecisionCommand, adoptedMatrix, type Reauthenticate } from './sms-decisions.js';
export {
  getSmsProgram,
  getSmsHome,
  getSmsRegister,
  type SmsRegisterPage,
  getSmsRecord,
  getSmsRecordContent,
  getSmsSigningPreview,
  readSmsAttachmentObject,
  projectSmsEvent,
  isSmsEvent,
  decisionReference,
} from './sms-reads.js';
export {
  evaluateRiskMatrix,
  riskMatrixProblems,
  coveringRiskCapability,
  highestRiskAuthority,
  matrixLabels,
} from './sms-matrix.js';
export { exampleRiskMatrix } from './sms-example-matrix.js';
export {
  findingOrigin,
  flightEvaluationView,
  getFindingPromotion,
  hazardOrigin,
  ruleEvaluationView,
  type EvaluationView,
  type FindingView,
} from './sms-origins.js';
export {
  beginProjectionSubjects,
  endProjectionSubjects,
  linkSubjectDependency,
  lockProjectionSubjects,
  readSubjectEvidence,
  retainSubjectEvidence,
} from './cuts.js';
export { observationTitle, readableName, recordFieldLabel, recordTitle } from './field-labels.js';
export {
  checkKindDefinition,
  checkKindDigest,
  checkParameterProblem,
  findCheckKind,
  latestObservations,
  listCheckKinds,
  observationField,
  registerCheckKind,
  type CheckClock,
  type CheckInputs,
  type CheckKind,
  type CheckKindDefinition,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
export {
  dateWithinMonthsV1,
  intervalCoversWindowV1,
  libraryCheckKinds,
  recordCompleteV1,
  valueWithinLimitV1,
} from './check-kind-library.js';
export { evidenceCheckKinds, evidenceDueV1, valuesDisagreeV1 } from './check-kind-evidence.js';
export {
  businessDaysWithinV1,
  combinedCheckKinds,
  fieldMatchesV1,
  intervalCoversIntersectionV1,
  localDaysTotalV1,
  totalFromOpeningV1,
} from './check-kind-library-combined.js';
export {
  deadlineCheckKinds,
  eventsAnsweredWithinV1,
  periodsEachRecordedV1,
  type EventsAnsweredWithinParams,
  type PeriodsEachRecordedParams,
} from './check-kind-library-deadlines.js';
export {
  geometryCheckKinds,
  positionInAreaV1,
  positionInAreaV2,
  type PositionInAreaParams,
  type PositionInAreaV2Params,
} from './check-kind-library-geometry.js';
export {
  authorizationCoversFlightV1,
  observedCheckKinds,
  valueFlownOrPlannedV1,
  type AuthorizationCoversFlightParams,
  type FlownMeasure,
  type FlownOrPlannedParams,
} from './check-kind-library-observed.js';
export { adoptedDocumentPurposes } from './document-purposes.js';
export { adoptedRequiredRecords, recordkeepingPlanDraft, recordkeepingPlanText } from './required-records.js';
export { RECORDS_ON_FILE_SOURCE } from './records-on-file.js';
export { onFileCheckKinds, recordInForceV1, type RecordInForceParams } from './check-kind-library-on-file.js';
export { dueCheckKinds, dueTimeOrTotalV1, type DueTimeOrTotalParams } from './check-kind-library-due.js';
export {
  flightCheckKinds,
  intervalsAtOnceV1,
  intervalsCountedBeforeV1,
  recordBeforeFlightV1,
  timeWithinDatesV1,
  type IntervalsAtOnceParams,
  type IntervalsCountedBeforeParams,
  type RecordBeforeFlightParams,
  type TimeWithinDatesParams,
} from './check-kind-library-flights.js';
export {
  windowCheckKinds,
  windowValuesWithinLimitV1,
  type WindowValuesWithinLimitParams,
} from './check-kind-library-windows.js';
export {
  adoptionParameterProblem,
  checkedRuleProblem,
  defineCheckedRule,
  withPopulation,
  runCheckedRule,
  type CheckedRuleOutcome,
  type CheckedRuleSpec,
} from './checked-rules.js';
export {
  continueAdoptionRuleEvaluations,
  continueRelatedRuleEvaluations,
  evaluateAdoptedRule,
  lockAdoptedRules,
  queueRuleEvaluationsForCorrection,
  queueRuleEvaluationsForObservation,
  type RuleEvaluationTask,
  type RuleEvaluationTrigger,
} from './rule-evaluations.js';
export { getRuleEvaluation, listRuleEvaluations, listSubjectFindings } from './rule-evaluation-reads.js';
export { getAdoptionRuleCoverage, listRuleCoverageSubjects, listSubjectsOnRecord } from './rule-coverage.js';
export { UNSECTIONED, inParagraphOrder, packSectionsProblem, placedLeaf, sectionsOf } from './rule-pack-sections.js';
export { flightFindingReadContext, inputSubjectsOf, summaryWordingOf } from './rule-evaluation-reads.js';
export { subjectNames } from './subject-names.js';
export { queueRuleEvaluationsForSubjectState, ruleEvaluationObservationDigest } from './rule-evaluations.js';
export { queueAdoptedRuleEvaluations } from './rule-evaluations.js';
export {
  registerSubjectState,
  subjectStateLoader,
  subjectStateRevision,
  type SubjectState,
  type SubjectStateLoader,
  type SubjectStateReadOptions,
} from './subject-state.js';
export { narrowRead, readUpperBound, readWindow } from './checked-rules.js';
export { isFilled, observationMatches, type CheckKindDetail } from './check-kinds.js';
export {
  exposureKindDigest,
  exposureParameterProblem,
  findExposureKind,
  libraryExposureKinds,
  listExposureKinds,
  registerExposureKind,
  type ExposureKind,
  type ExposureKindDefinition,
  type ExposureMeasure,
  type IndicatorObservation,
} from './indicator-exposure-kinds.js';
export {
  calculateIndicator,
  defineIndicator,
  findIndicatorDefinition,
  indicatorDefinitionProblem,
  listIndicatorDefinitions,
  registerIndicatorDefinition,
  type IndicatorCalculationInput,
  type IndicatorDefinitionSpec,
  type IndicatorEvent,
  type IndicatorFinding,
} from './indicators.js';
export { gatherIndicatorInputs, type IndicatorGatherRequest, type IndicatorGathering } from './indicator-gathering.js';
export { indicatorIssueId, issueEvents, type IndicatorIssue, type IssueEvaluation } from './indicators.js';
export {
  getControlIndicatorResult,
  getControlIndicatorReview,
  listControlWindowIndicatorResults,
  recordControlWindowIndicator,
  reviewControlIndicatorResult,
} from './control-indicator-results.js';
export { coveredFlightHoursV1, type CoveredFlightHoursParams } from './indicator-exposure-kinds.js';
export { type ExposureKindWording, type PluralWords } from './indicator-exposure-kinds.js';
export { indicatorReasonSentences } from './indicators.js';
export { indicatorResultWording, indicatorTitles, populationWording } from './indicator-wording.js';
export {
  calculateControlWindowIndicator,
  controlWindowIndicatorRequest,
  getControlWindow,
  listControlWindows,
  openControlWindow,
  registerRetainedControlWindowSource,
  reviseControlWindow,
  type RetainedControlWindowSource,
} from './control-windows.js';
export {
  controlParameterProblem,
  controlTypeDigest,
  controlWording,
  describeControl,
  findControlType,
  listControlTypes,
  registerControlType,
  registeredControlTypeDigest,
  type ApplicabilityPlan,
  type ControlApplicabilityDeclaration,
  type ControlType,
} from './control-types.js';
export {
  evaluateControlApplicability,
  type ControlApplicabilityEvaluation,
  type ControlApplicabilityInputs,
} from './control-applicability.js';
export { areaReachApplicability, areaReachDefinition } from './area-reach-rule.js';
export {
  describedMeasureControlType,
  operatingLimitControlType,
  operatingLimitSubjectIds,
  type OperatingLimitParameters,
} from './control-type-library.js';
export { areaControlTypes, controlArea, type ControlArea } from './control-types.js';
export { avoidanceAreaControlType, type AvoidanceAreaParameters } from './control-type-library.js';
export { getAcceptedAreaControl } from './accepted-area-control.js';
export {
  ACCEPTED_CONTROL_PACK_ID,
  acceptedControlLeafId,
  acceptedControlLeaves,
  acceptedControlPack,
  controlPeriod,
  controlsInForce,
  refreshAcceptedControlRules,
  scheduleAcceptedControlBoundaries,
  type ControlInForce,
} from './accepted-control-rules.js';
export { controlCheck, controlRules, type ControlCheck, type ControlRuleDeclaration } from './control-types.js';
export { flightControlsDigest, getFlightControls, pinFlightControls } from './mission-release-controls.js';

export async function requireRow(
  client: PoolClient,
  table: string,
  id: string,
  lock = false,
): Promise<Record<string, any>> {
  const allowed = ['uploads', 'artifacts', 'receipts', 'flight_views', 'principals', 'command_records'];
  if (!allowed.includes(table)) throw new Error('Invalid scoped table');
  const result = await client.query(`SELECT * FROM ${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!result.rows[0]) throw new DomainError(404, 'not_found', 'Record was not found within your scope');
  return result.rows[0];
}
export async function inputCut(client: PoolClient, flightId?: string, principal?: AuthContext): Promise<InputCut> {
  if (!flightId) return { streams: {}, ...(principal ? { principalRevision: principal.revision } : {}) };
  if (!principal) throw new Error('A subject evidence cut requires an authenticated principal');
  const evidence = await readSubjectEvidence(client, flightId, principal, { decision: true });
  const flight = await requireRow(client, 'flight_views', flightId);
  return { ...evidence.rendered, basisRevision: Number(flight.basis_revision) };
}
export async function authoritativeCut(
  client: PoolClient,
  flightId: string,
  principal: AuthContext,
): Promise<InputCut> {
  const evidence = await readSubjectEvidence(client, flightId, principal, { decision: true });
  const flight = await requireRow(client, 'flight_views', flightId);
  return {
    ...evidence.accepted,
    basisRevision: Number(flight.basis_revision),
    principalRevision: principal.revision,
  };
}
export async function responseMeta(
  client: PoolClient,
  requestId: string,
  principal: AuthContext,
  effectId?: string,
  flightId?: string,
): Promise<ResponseMeta> {
  const r = await client.query(
    `SELECT (SELECT COALESCE(MAX(id),0) FROM view_changes) AS revision,
     (SELECT COUNT(*) FROM work_items WHERE state<>'completed')+${dueRuleEvaluationWorkSql()} AS outstanding,
     clock_timestamp() AS now`,
  );
  const evidence = flightId ? await readSubjectEvidence(client, flightId, principal, { decision: true }) : undefined;
  const flight = flightId ? await requireRow(client, 'flight_views', flightId) : undefined;
  return {
    requestId,
    ...(effectId ? { effectId } : {}),
    projectionRevision: Number(r.rows[0].revision),
    inputCut: evidence
      ? { ...evidence.rendered, basisRevision: Number(flight!.basis_revision) }
      : { streams: {}, principalRevision: principal.revision },
    ...(evidence ? { dependencyBasis: evidence.dependencyBasis } : {}),
    computedAt: r.rows[0].now.toISOString(),
    outstandingWork: Number(r.rows[0].outstanding),
  };
}
export async function getReceipt(client: PoolClient, id: string): Promise<Receipt> {
  const row = await requireRow(client, 'receipts', id);
  const task = (await client.query('SELECT state,attempts,error FROM work_items WHERE event_id=$1', [row.event_id]))
    .rows[0];
  return receiptView(row, task);
}
export function receiptView(row: Record<string, any>, task?: Record<string, any>): Receipt {
  return {
    id: row.id,
    sourceId: row.source_id,
    kind: row.kind,
    receivedAt: row.received_at.toISOString(),
    occurredAt: row.occurred_at.toISOString(),
    status: 'accepted',
    processing: {
      status:
        task?.state === 'completed'
          ? 'completed'
          : task?.state === 'failed'
            ? 'failed'
            : task?.state === 'leased'
              ? 'processing'
              : 'pending',
      attempts: task?.attempts ?? 0,
      ...(task?.error ? { error: task.error } : {}),
    },
    linkStatus: row.link_status,
    ...(row.flight_id ? { flightId: row.flight_id } : {}),
    ...(row.order_id ? { orderId: row.order_id } : {}),
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    eventId: row.event_id,
    payload: row.payload,
  };
}
const INPUT_AUTHORITY_VERSION = 'ledger.input-authority.1';
const originatingInputKinds = new Set<Input['kind']>(['order.revision', 'intent.revision']);
const inputCapabilities: Record<
  Exclude<Input['kind'], 'command-link.baseline' | 'mission.revision' | 'monitoring.window'>,
  readonly string[]
> = {
  'order.revision': ['input:write', 'flight:create'],
  'intent.revision': ['input:write', 'flight:create'],
  'flight.observation': ['input:write'],
  'airspace.status': ['input:write'],
  'source.observation': ['input:write'],
  'telemetry.segment': ['input:write'],
  observation: ['input:write'],
};
interface AcceptedInputAuthority {
  version: typeof INPUT_AUTHORITY_VERSION;
  principalId: string;
  tenantId: string;
  principalRevision: number;
  inputKind: Input['kind'];
  sourceId: string;
  requiredCapabilities: string[];
}
export interface OriginationContext {
  principal: AuthContext;
  inputEventId: string;
  issuerPrincipalRevision: number;
  executorPrincipalId: string;
  authorityMode: 'retained_acceptance' | 'legacy_current_authority';
}
function requiredInputCapabilities(kind: Input['kind']): string[] {
  const required =
    kind === 'command-link.baseline' || kind === 'mission.revision' || kind === 'monitoring.window'
      ? undefined
      : inputCapabilities[kind];
  if (!required) throw new DomainError(400, 'unsupported_input_kind', 'Input kind has no authority policy');
  return [...required];
}
function retainInputAuthority(principal: AuthContext, input: Input): AcceptedInputAuthority {
  const requiredCapabilities = requiredInputCapabilities(input.kind);
  if (requiredCapabilities.some((capability) => !principal.capabilities.includes(capability)))
    throw new DomainError(403, 'capability_required', 'This input kind requires granted origination authority');
  return {
    version: INPUT_AUTHORITY_VERSION,
    principalId: principal.id,
    tenantId: principal.tenantId,
    principalRevision: principal.revision,
    inputKind: input.kind,
    sourceId: input.sourceId,
    requiredCapabilities,
  };
}
export async function originationContext(
  client: PoolClient,
  executor: AuthContext,
  event: JournalEvent,
): Promise<OriginationContext> {
  if (!originatingInputKinds.has(event.event_type as Input['kind']) || event.tenant_id !== executor.tenantId)
    throw new DomainError(403, 'origination_authority_invalid', 'Origination needs a scoped originating input');
  const requiredCapabilities = requiredInputCapabilities(event.event_type as Input['kind']);
  const retained = event.payload.acceptedAuthority as AcceptedInputAuthority | undefined;
  let principal: AuthContext;
  let authorityMode: OriginationContext['authorityMode'];
  if (retained !== undefined) {
    if (
      !retained ||
      retained.version !== INPUT_AUTHORITY_VERSION ||
      retained.principalId !== event.principal_id ||
      retained.tenantId !== event.tenant_id ||
      retained.inputKind !== event.event_type ||
      retained.sourceId !== event.source_id ||
      !Number.isSafeInteger(retained.principalRevision) ||
      retained.principalRevision < 1 ||
      !Array.isArray(retained.requiredCapabilities) ||
      canonicalDigest(retained.requiredCapabilities) !== canonicalDigest(requiredCapabilities)
    )
      throw new DomainError(
        403,
        'origination_authority_invalid',
        'Retained input authority does not match its immutable issuer and input',
      );
    // An accepted grant is historical authority, not the worker's authority or
    // the issuer's possibly revoked current membership. It authorizes this input only.
    principal = {
      id: retained.principalId,
      tenantId: retained.tenantId,
      name: 'Accepted origination issuer',
      revision: retained.principalRevision,
      capabilities: [...requiredCapabilities],
    };
    authorityMode = 'retained_acceptance';
  } else {
    // Old pending inputs have no historical grant. Fail closed unless the
    // original issuer can authorize this work now; never substitute the worker.
    const row = (
      await client.query('SELECT * FROM principals WHERE id=$1 AND tenant_id=$2 FOR SHARE', [
        event.principal_id,
        event.tenant_id,
      ])
    ).rows[0];
    if (!row?.active || requiredCapabilities.some((capability) => !row.capabilities.includes(capability)))
      throw new DomainError(
        403,
        'origination_authority_unavailable',
        'Legacy input has no retained grant and its issuer cannot currently authorize origination',
      );
    principal = authFromRow(row);
    authorityMode = 'legacy_current_authority';
  }
  return {
    principal,
    inputEventId: event.id,
    issuerPrincipalRevision: principal.revision,
    executorPrincipalId: executor.id,
    authorityMode,
  };
}
export async function createFlight(
  client: PoolClient,
  principal: AuthContext,
  input: FlightCreate,
  sourceId = 'partner-orders',
  causationId?: string,
  origin?: Omit<OriginationContext, 'principal'>,
): Promise<FlightSummary> {
  if (!principal.capabilities.includes('flight:create'))
    throw new DomainError(403, 'capability_required', 'Flight origination capability is required');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `origination:${principal.tenantId}:${input.originationKey}`,
  ]);
  const existing = await client.query('SELECT id FROM flight_views WHERE origination_key=$1', [input.originationKey]);
  if (existing.rows[0]) return getFlight(client, existing.rows[0].id);
  const id = randomUUID();
  const label = input.label ?? input.originationKey;
  await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight',$3)", [
    id,
    principal.tenantId,
    label,
  ]);
  const created = await appendEvent(client, principal, {
    type: 'flight.created',
    stream: `flight:${id}`,
    payload: { ...input, flightId: id, ...(origin ? { origination: origin } : {}) },
    causationId,
  });
  await client.query(
    'INSERT INTO flight_views(id,tenant_id,origination_key,label,aircraft,scheduled_start,scheduled_end,intent_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      id,
      principal.tenantId,
      input.originationKey,
      label,
      input.aircraft ?? null,
      input.scheduledStart ?? null,
      input.scheduledEnd ?? null,
      input.intentRef?.revision ?? 0,
    ],
  );
  for (const alias of input.aliases ?? [])
    await client.query(
      'INSERT INTO aliases(id,tenant_id,subject_id,source_id,external_id,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        principal.tenantId,
        id,
        alias.sourceId,
        alias.externalId,
        alias.validFrom ?? null,
        alias.validTo ?? null,
      ],
    );
  await addFulfillments(client, principal, id, input.orderRefs ?? [], sourceId);
  await retainSubjectEvidence(client, principal.tenantId, [id], created);
  const priorEvidence = await client.query<Pick<JournalEvent, 'id' | 'stream_id' | 'stream_sequence'>>(
    `WITH matching AS (
       SELECT $1::text AS event_id WHERE $1::text IS NOT NULL
       UNION SELECT event_id FROM receipts WHERE flight_id=$2
       UNION SELECT event_id FROM receipts WHERE input_subject->>'originationKey'=$3
       UNION SELECT event_id FROM receipts WHERE kind='intent.revision'
         AND COALESCE(payload->'intent'->>'originationKey',payload->>'originationKey')=$3
       UNION SELECT event_id FROM receipts WHERE kind='order.revision'
         AND payload->'fulfillments' @> jsonb_build_array(jsonb_build_object('originationKey',$3::text))
       UNION SELECT r.event_id FROM aliases a JOIN receipts r ON r.source_id=a.source_id
         AND r.input_subject->>'externalFlightId'=a.external_id
         AND (a.valid_from IS NULL OR a.valid_from<=r.occurred_at)
         AND (a.valid_to IS NULL OR a.valid_to>r.occurred_at) WHERE a.subject_id=$2
       UNION SELECT r.event_id FROM fulfillments f JOIN receipts r ON r.source_id=f.source_id
         AND COALESCE(r.order_id,r.input_subject->>'orderId',r.payload->>'externalId')=f.order_external_id
         WHERE f.flight_id=$2 AND r.kind='order.revision'
     ) SELECT DISTINCT ON(e.stream_id) e.id,e.stream_id,e.stream_sequence
       FROM matching m JOIN journal_events e ON e.id=m.event_id
       ORDER BY e.stream_id,e.stream_sequence DESC`,
    [causationId ?? null, id, input.originationKey],
  );
  for (const evidence of priorEvidence.rows) await retainSubjectEvidence(client, principal.tenantId, [id], evidence);
  await registerFlightOrganization(client, principal, id, created.id);
  return getFlight(client, id);
}
export async function addFulfillments(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  refs: NonNullable<FlightCreate['orderRefs']>,
  sourceId: string,
): Promise<void> {
  for (const ref of refs)
    await client.query(
      'INSERT INTO fulfillments(id,tenant_id,flight_id,source_id,order_external_id,order_revision,quantity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,flight_id,source_id,order_external_id) DO UPDATE SET order_revision=EXCLUDED.order_revision,quantity=EXCLUDED.quantity WHERE EXCLUDED.order_revision>fulfillments.order_revision',
      [randomUUID(), principal.tenantId, flightId, sourceId, ref.orderId, ref.revision, ref.quantity ?? null],
    );
  if (refs.length) {
    const evidence = await client.query<Pick<JournalEvent, 'id' | 'stream_id' | 'stream_sequence'>>(
      `SELECT DISTINCT ON(e.stream_id) e.id,e.stream_id,e.stream_sequence
       FROM receipts r JOIN journal_events e ON e.id=r.event_id
       WHERE r.kind='order.revision' AND r.source_id=$1
         AND COALESCE(r.order_id,r.input_subject->>'orderId',r.payload->>'externalId')=ANY($2::text[])
       ORDER BY e.stream_id,e.stream_sequence DESC`,
      [sourceId, refs.map((ref) => ref.orderId)],
    );
    for (const event of evidence.rows) await retainSubjectEvidence(client, principal.tenantId, [flightId], event);
  }
}
export async function lockOriginationKeys(client: PoolClient, tenantId: string, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort())
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`origination:${tenantId}:${key}`]);
}
export async function lockOrderIdentity(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  externalId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `order:${tenantId}:${sourceId}:${externalId}`,
  ]);
}
export async function resolveFlight(
  client: PoolClient,
  input: FlightInput,
  lock = true,
): Promise<{ id?: string; status: 'linked' | 'unresolved' | 'candidate' }> {
  if (input.subject.flightId) {
    await requireRow(client, 'flight_views', input.subject.flightId, lock);
    return { id: input.subject.flightId, status: 'linked' };
  }
  const intent =
    input.kind === 'intent.revision' ? ((input.payload.intent ?? input.payload) as Record<string, unknown>) : undefined;
  const originationKey = input.subject.originationKey ?? intent?.originationKey;
  if (typeof originationKey === 'string') {
    const row = (
      await client.query(`SELECT id FROM flight_views WHERE origination_key=$1${lock ? ' FOR UPDATE' : ''}`, [
        originationKey,
      ])
    ).rows[0];
    if (row) return { id: row.id, status: 'linked' };
  }
  if (input.subject.externalFlightId) {
    const rows = await client.query(
      'SELECT DISTINCT subject_id AS id FROM aliases WHERE source_id=$1 AND external_id=$2 AND (valid_from IS NULL OR valid_from<=$3) AND (valid_to IS NULL OR valid_to>$3)',
      [input.sourceId, input.subject.externalFlightId, input.occurredAt],
    );
    if (rows.rowCount === 1) {
      await requireRow(client, 'flight_views', rows.rows[0].id, lock);
      return { id: rows.rows[0].id, status: 'linked' };
    }
    if ((rows.rowCount ?? 0) > 1) return { status: 'candidate' };
  }
  return { status: 'unresolved' };
}
export async function acceptInput(
  client: PoolClient,
  principal: AuthContext,
  input: Input,
  options: { objectStore?: ObjectStore; grantedBy?: ObservationGrant } = {},
): Promise<Receipt> {
  if (input.kind === 'monitoring.window')
    return acceptMonitoringWindowInput(client, principal, input, options.objectStore);
  if (input.kind === 'command-link.baseline')
    throw new DomainError(
      410,
      'command_link_baseline_retired',
      'Command-link baselines are no longer accepted. Report the link state as a link.status observation and monitor the control through a control window; baselines recorded earlier stay readable and verifiable.',
    );
  if (input.kind === 'mission.revision')
    return acceptMissionInput(client, principal, input as MissionInput, options.objectStore);
  // withScope holds this issuer's latest authority row through acceptance commit.
  // This preflight precedes every artifact lookup, identity mutation and append.
  const acceptedAuthority = retainInputAuthority(principal, input);
  if (input.kind === 'observation')
    return acceptObservationInput(
      client,
      principal,
      input,
      { ...acceptedAuthority, inputKind: input.kind },
      options.grantedBy ? { grantedBy: options.grantedBy } : {},
    );
  if (input.artifactId) await requireRow(client, 'artifacts', input.artifactId);
  if (input.kind === 'telemetry.segment') {
    if (!input.artifactId || !input.sourceSessionId || input.fidelity !== 'synthetic_contract')
      throw new DomainError(
        400,
        'invalid_telemetry_descriptor',
        'Telemetry requires retained bytes, a source session, and synthetic_contract attribution',
      );
    const artifact = await requireRow(client, 'artifacts', input.artifactId);
    if (artifact.byte_length > 1048576)
      throw new DomainError(413, 'telemetry_too_large', 'Telemetry segment exceeds its 1 MiB bound');
    const sessionId = canonicalDigest({
      tenant: principal.tenantId,
      principal: principal.id,
      source: input.sourceId,
      session: input.sourceSessionId,
      device: input.payload.deviceId,
    });
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`telemetry-session:${sessionId}`]);
    const previous = (
      await client.query('SELECT descriptor FROM telemetry_segments WHERE session_id=$1 LIMIT 1', [sessionId])
    ).rows[0]?.descriptor;
    if (
      previous &&
      (previous.sessionStartSequence !== input.payload.sessionStartSequence ||
        previous.gatewayId !== input.payload.gatewayId)
    )
      throw new DomainError(
        409,
        'telemetry_session_conflict',
        'A source session retains one capture baseline and gateway binding; create a new sourceSessionId for a new configured session',
      );
  }
  const order = input.kind === 'order.revision' ? (input.payload as Record<string, any>) : undefined;
  const externalId = order ? (input.subject.orderId ?? order.externalId) : undefined;
  if (typeof externalId === 'string') await lockOrderIdentity(client, principal.tenantId, input.sourceId, externalId);
  const intent =
    input.kind === 'intent.revision' ? ((input.payload.intent ?? input.payload) as Record<string, any>) : undefined;
  const keys = [
    input.subject.originationKey,
    intent?.originationKey,
    ...(Array.isArray(order?.fulfillments) ? order.fulfillments.map((item: any) => item?.originationKey) : []),
  ].filter((key): key is string => typeof key === 'string');
  // Share origination locks with workers, so a concurrently created existing intent cannot escape basis invalidation.
  await lockOriginationKeys(client, principal.tenantId, keys);
  const link = await resolveFlight(client, input, false);
  const affected = new Set<string>(link.id ? [link.id] : []);
  if (input.subject.externalFlightId) {
    const candidates = await client.query<{ id: string }>(
      `SELECT DISTINCT subject_id AS id FROM aliases WHERE source_id=$1 AND external_id=$2
       AND (valid_from IS NULL OR valid_from<=$3) AND (valid_to IS NULL OR valid_to>$3)`,
      [input.sourceId, input.subject.externalFlightId, input.occurredAt],
    );
    for (const candidate of candidates.rows) affected.add(candidate.id);
  }
  if (typeof externalId === 'string') {
    const rows = await client.query(
      'SELECT flight_id FROM fulfillments WHERE source_id=$1 AND order_external_id=$2 ORDER BY flight_id',
      [input.sourceId, externalId],
    );
    for (const row of rows.rows) affected.add(row.flight_id);
  }
  if (keys.length) {
    const rows = await client.query('SELECT id FROM flight_views WHERE origination_key=ANY($1::text[])', [keys]);
    for (const row of rows.rows) affected.add(row.id);
  }
  for (const id of [...affected].sort())
    await client.query(
      'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=clock_timestamp() WHERE id=$1',
      [id],
    );
  const event = await appendEvent(client, principal, {
    type: input.kind,
    stream: `${input.kind === 'telemetry.segment' ? 'telemetry' : 'source'}:${principal.id}:${input.sourceId}:${input.sourceSessionId ?? 'default'}`,
    sourceId: input.sourceId,
    sessionId: input.sourceSessionId,
    occurredAt: input.occurredAt,
    effectiveAt: input.effectiveAt,
    payload: { ...input, flightId: link.id ?? null, acceptedAuthority },
    artifactId: input.artifactId,
  });
  await retainSubjectEvidence(client, principal.tenantId, [...affected], event);
  const id = randomUUID();
  await client.query(
    'INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,source_revision,flight_id,order_id,artifact_id,link_status,payload,input_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [
      id,
      principal.tenantId,
      event.id,
      input.sourceId,
      input.kind,
      input.occurredAt,
      event.received_at,
      input.sourceRevision ?? null,
      link.id ?? null,
      input.subject.orderId ?? null,
      input.artifactId ?? null,
      link.status,
      input.payload,
      input.subject,
    ],
  );
  if (input.kind === 'flight.observation')
    await bridgeLegacyFlightReport(client, principal, input, { event, receiptId: id, link }, options.objectStore);
  if (input.kind === 'telemetry.segment')
    await client.query(
      'INSERT INTO telemetry_segments(id,tenant_id,receipt_id,event_id,artifact_id,principal_id,session_id,source_id,source_session_id,device_id,descriptor,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        id,
        principal.tenantId,
        id,
        event.id,
        input.artifactId,
        principal.id,
        canonicalDigest({
          tenant: principal.tenantId,
          principal: principal.id,
          source: input.sourceId,
          session: input.sourceSessionId,
          device: input.payload.deviceId,
        }),
        input.sourceId,
        input.sourceSessionId,
        input.payload.deviceId,
        input.payload,
        event.received_at,
      ],
    );
  for (const flightId of [...affected].sort())
    await appendLiveChange(
      client,
      principal.tenantId,
      flightId,
      event.id,
      input.kind === 'telemetry.segment' ? 'telemetry.updated' : 'flight.updated',
      id,
    );
  return getReceipt(client, id);
}
async function smsCommandSubject(
  client: PoolClient,
  row: Record<string, any>,
): Promise<{ kind: 'sms'; id: string } | undefined> {
  if (row.payload.subject?.kind === 'sms') return { kind: 'sms', id: row.payload.subject.id };
  if (typeof row.payload.recordId === 'string' && row.kind.startsWith('sms.'))
    return { kind: 'sms', id: row.payload.recordId };
  if (row.kind !== 'sms.record.open') return undefined;
  const event = await client.query<{ record_id: string }>(
    "SELECT payload->>'recordId' AS record_id FROM journal_events WHERE tenant_id=$1 AND id=$2",
    [row.tenant_id, row.id],
  );
  return { kind: 'sms', id: event.rows[0].record_id };
}
export async function getCommand(client: PoolClient, id: string): Promise<CommandRecord> {
  const row = await requireRow(client, 'command_records', id);
  const sms = await smsCommandSubject(client, row);
  return {
    id: row.id,
    kind: row.kind,
    ...(row.flight_id ? { flightId: row.flight_id } : {}),
    ...(sms ? { subject: sms } : {}),
    actorId: row.actor_id,
    recordedAt: row.recorded_at.toISOString(),
    payload: row.payload,
  };
}
const commandCapabilities: Record<Command['kind'], string> = {
  'decision.record': 'decision:write',
  'finding.treat': 'decision:write',
  'finding.treat-many': 'decision:write',
  'evidence.correct': 'correction:write',
  'identity.link': 'identity:write',
  'flight.assign': 'identity:write',
  'authority.update': 'authority:write',
  'person.add': 'authority:write',
  'credential.issue': 'authority:write',
  'credential.revoke': 'authority:write',
  'rule-pack.adopt': 'pack:adopt',
  'mission.release': 'mission:release',
  'mission.departure-authorize': 'mission:release',
  'mission.brief': 'briefing:write',
  'mission.briefing-acknowledge': 'briefing:ack',
  'sms.record.open': 'sms:write',
  'sms.record.revise': 'sms:read',
  'sms.attachment.add': 'sms:write',
  'sms.record.links': 'sms:write',
  'sms.document.acknowledge': 'sms:read',
  'observation.withdraw': 'input:write',
  'observation.resolve-subject': 'input:write',
  'subject.alias': 'input:write',
};
export function commandCapability(command: Command): string {
  return commandCapabilities[command.kind];
}
function validateBasis(
  flight: Record<string, any>,
  command: Extract<Command, { kind: 'decision.record' | 'evidence.correct' | 'flight.assign'; flightId: string }>,
  principal: AuthContext,
): void {
  if (
    Number(flight.revision) !== command.expectedRevision ||
    Number(flight.basis_revision) !== command.expectedBasisRevision
  )
    throw new DomainError(409, 'stale_basis', 'Flight information changed; refresh and review the decision basis', {
      currentRevision: Number(flight.revision),
      currentBasisRevision: Number(flight.basis_revision),
    });
  if ('inputCut' in command) {
    if (
      command.inputCut.basisRevision !== command.expectedBasisRevision ||
      command.inputCut.principalRevision !== principal.revision
    )
      throw new DomainError(409, 'stale_basis', 'Displayed basis or authority no longer matches acceptance');
  }
}
function validateRenderedCut(cut: InputCut, expected: InputCut): void {
  if (canonicalDigest(cut.streams) !== canonicalDigest(expected.streams))
    throw new DomainError(
      409,
      'invalid_rendered_cut',
      'Displayed evidence changed; refresh the complete subject basis',
    );
}
export async function acceptCommand(
  client: PoolClient,
  principal: AuthContext,
  command: Command,
  store?: ObjectStore,
  options?: {
    simulationAvoidanceDemo?: SimulationAvoidanceDemoConfig;
    reauthenticate?: Reauthenticate;
    /** Receives a newly issued credential's secret, which nothing else returns or keeps. */
    issuedCredential?: (credential: IssuedCredential) => void;
  },
): Promise<CommandRecord> {
  if (!principal.capabilities.includes(commandCapability(command)))
    throw new DomainError(403, 'capability_required', 'Command exceeds granted capability');
  if (command.kind === 'sms.record.open') return openSmsRecord(client, principal, command, store);
  if (command.kind === 'sms.record.revise') return reviseSmsRecord(client, principal, command, store);
  if (command.kind === 'sms.attachment.add') return addSmsAttachment(client, principal, command);
  if (command.kind === 'sms.record.links') return setSmsRecordLinks(client, principal, command);
  if (command.kind === 'sms.document.acknowledge') return acknowledgeDocumentIssue(client, principal, command);
  if (command.kind === 'observation.withdraw') return withdrawObservation(client, principal, command);
  if (command.kind === 'observation.resolve-subject') return resolveObservationSubject(client, principal, command);
  if (command.kind === 'subject.alias') return aliasSubjectIdentity(client, principal, command);
  if (isSmsDecisionCommand(command)) {
    const accepted = await acceptSmsDecision(client, principal, command, options?.reauthenticate, store);
    // An accepted area control starts the opt-in avoidance demonstration, where one is configured.
    if (command.decision.kind === 'risk.accept')
      await enqueueInitialSimulationAvoidanceDemos(
        client,
        principal,
        command.subject.id,
        accepted.id,
        options?.simulationAvoidanceDemo,
      );
    return accepted;
  }
  if (
    command.kind === 'decision.record' &&
    ['mission.release', 'mission.departure-authorize', 'mission.brief', 'mission.briefing-acknowledge'].includes(
      command.decision.kind,
    )
  )
    throw new DomainError(
      400,
      'mission_release_command_required',
      'A mission release requires its exact mission and safety context',
    );
  if (command.kind === 'rule-pack.adopt') return acceptPackAdoption(client, principal, command);
  if (command.kind === 'finding.treat')
    return getCommand(client, await acceptFindingTreatment(client, principal, command));
  if (command.kind === 'finding.treat-many')
    return getCommand(client, await acceptFindingSetTreatment(client, principal, command));
  if (command.kind === 'mission.release') return acceptMissionRelease(client, principal, command);
  if (command.kind === 'mission.departure-authorize') return acceptMissionDeparture(client, principal, command);
  if (command.kind === 'mission.brief') return acceptMissionBriefing(client, principal, command);
  if (command.kind === 'mission.briefing-acknowledge')
    return acceptMissionBriefingAcknowledgement(client, principal, command);
  if (command.kind === 'decision.record' && 'adoption' in command)
    return acceptOrganizationDecision(client, principal, command);
  if (command.kind === 'person.add') return getCommand(client, await addPerson(client, principal, command));
  if (command.kind === 'credential.issue') {
    const issued = await issueCredential(client, principal, command);
    options?.issuedCredential?.(issued.credential);
    return getCommand(client, issued.commandId);
  }
  if (command.kind === 'credential.revoke')
    return getCommand(client, await revokeCredential(client, principal, command));
  if (command.kind === 'authority.update') {
    const target = await requireRow(client, 'principals', command.principalId, true);
    if (target.kind === 'intake')
      throw new DomainError(
        400,
        'reporting_channel_fixed',
        'The safety reporting channel holds no authority and cannot be changed',
      );
    if (Number(target.revision) !== command.expectedRevision)
      throw new DomainError(409, 'stale_authority', 'Principal authority changed');
    const granted = command.capabilities.find(
      (capability) =>
        (retiredCapabilityValues as readonly string[]).includes(capability) &&
        !target.capabilities.includes(capability),
    );
    if (granted)
      throw new DomainError(
        400,
        'capability_retired',
        `${granted} is retired and is no longer granted; a principal that holds it keeps it until it is removed`,
      );
    await client.query(
      // The command-link source grants are retained as granted; nothing updates them any more.
      'UPDATE principals SET capabilities=$1,active=$2,mission_sources=COALESCE($3::text[],mission_sources),monitoring_sources=COALESCE($4::text[],monitoring_sources),revision=revision+1 WHERE id=$5',
      [
        command.capabilities,
        command.active ?? target.active,
        command.missionSources ?? null,
        command.monitoringSources ?? null,
        target.id,
      ],
    );
    if (command.observationGrants)
      await replaceObservationGrants(client, principal.tenantId, target.id, command.observationGrants);
    const event = await appendEvent(client, principal, {
      type: command.kind,
      stream: `authority:${target.id}`,
      payload: { ...command },
    });
    await client.query(
      'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
      [event.id, principal.tenantId, command.kind, principal.id, event.received_at, command],
    );
    return getCommand(client, event.id);
  }
  // The bridged correction's lock is an identity key: it comes before the flight.
  if (command.kind === 'evidence.correct')
    await lockLegacyFlightReportCorrection(client, principal.tenantId, command.correctionOf);
  if (command.kind === 'identity.link') {
    await lockLegacyFlightReportLink(client, principal.tenantId, command.receiptId);
    // The target and the flight the receipt is linked to now, together in id order.
    const linked = (
      await client.query<{ flight_id: string | null }>('SELECT flight_id FROM receipts WHERE tenant_id=$1 AND id=$2', [
        principal.tenantId,
        command.receiptId,
      ])
    ).rows[0]?.flight_id;
    await client.query(
      'SELECT id FROM flight_views WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
      [principal.tenantId, [command.flightId, ...(linked ? [linked] : [])]],
    );
  }
  const flight = await requireRow(client, 'flight_views', command.flightId, true);
  let acceptedCut: InputCut | undefined;
  let acceptedFindingBasis: Awaited<ReturnType<typeof validateFlightFindingTreatment>> | undefined;
  let previousFlightId: string | undefined;
  if (command.kind === 'identity.link') {
    if (Number(flight.revision) !== command.expectedRevision)
      throw new DomainError(409, 'stale_revision', 'Flight changed');
    const receipt = await requireRow(client, 'receipts', command.receiptId, true);
    if (receipt.kind === 'monitoring.window')
      throw new DomainError(
        409,
        'monitoring_scope_fixed',
        'Monitoring receipts retain their exact organization and window',
      );
    if (receipt.kind === 'command-link.status' || receipt.kind === 'command-link.baseline')
      throw new DomainError(
        409,
        'command_link_scope_fixed',
        'Command-link receipts retain their exact intake flight and source session',
      );
    if (receipt.kind === 'observation')
      throw new DomainError(
        409,
        'observation_scope_fixed',
        'Observation receipts retain the subjects they were resolved to at intake',
      );
    if (receipt.kind === 'mission.revision')
      throw new DomainError(
        409,
        'mission_scope_fixed',
        'Mission receipts retain their exact intake flight and mission identity',
      );
    const previous = receipt.flight_id;
    previousFlightId = previous ?? undefined;
    const original = (await client.query<JournalEvent>('SELECT * FROM journal_events WHERE id=$1', [receipt.event_id]))
      .rows[0];
    await retainSubjectEvidence(client, principal.tenantId, [flight.id, ...(previous ? [previous] : [])], original);
    if (previous && previous !== flight.id)
      await client.query('UPDATE flight_views SET basis_revision=basis_revision+1,revision=revision+1 WHERE id=$1', [
        previous,
      ]);
    await client.query("UPDATE receipts SET flight_id=$1,link_status='linked' WHERE id=$2", [flight.id, receipt.id]);
    await client.query('UPDATE flight_views SET basis_revision=basis_revision+1,revision=revision+1 WHERE id=$1', [
      flight.id,
    ]);
  } else {
    await organization(client, principal.tenantId, 'SHARE');
    validateBasis(flight, command, principal);
    if ('inputCut' in command) {
      const evidence = await readSubjectEvidence(client, flight.id, principal, { lock: true, decision: true });
      if (command.expectedDependencyBasis !== evidence.dependencyBasis)
        throw new DomainError(409, 'stale_basis', 'Related evidence changed; refresh and review the decision basis');
      validateRenderedCut(command.inputCut, evidence.rendered);
      acceptedCut = evidence.accepted;
    }
    if (command.kind === 'decision.record') {
      if (['risk.assess', 'risk.accept', 'hazard.disposition'].includes(command.decision.kind))
        throw new DomainError(
          400,
          'hazard_reference_required',
          'A risk assessment or acceptance must identify its hazard and reviewed evidence',
        );
      if (command.findingTreatment) {
        if (command.decision.kind !== `finding.${command.findingTreatment.action}`)
          throw new DomainError(400, 'invalid_finding_action', 'The decision kind must match the finding action');
        acceptedFindingBasis = await validateFlightFindingTreatment(
          client,
          principal,
          flight.id,
          command.findingTreatment,
        );
      } else if (command.decision.kind.startsWith('finding.'))
        throw new DomainError(
          400,
          'finding_reference_required',
          'A finding action must identify the finding and evaluation',
        );
    }
    if (command.kind === 'evidence.correct') {
      await requireEvidenceCorrectionTarget(client, principal, flight.id, command.correctionOf);
    }
    if (command.kind === 'flight.assign')
      await client.query(
        'UPDATE flight_views SET aircraft=$1,basis_revision=basis_revision+1,revision=revision+1 WHERE id=$2',
        [command.aircraft, flight.id],
      );
    else
      await client.query('UPDATE flight_views SET revision=revision+1,basis_revision=basis_revision+1 WHERE id=$1', [
        flight.id,
      ]);
  }
  const basis = acceptedCut ?? (await authoritativeCut(client, flight.id, principal));
  // The accepted cut describes validation before this command is appended, including pending receipts.
  if (command.kind !== 'identity.link') basis.basisRevision = Number(flight.basis_revision);
  const relationPayload =
    command.kind === 'identity.link' ? { ...command, previousFlightId: previousFlightId ?? null } : command;
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `flight:${flight.id}`,
    payload: { ...relationPayload, acceptedInputCut: basis, ...(acceptedFindingBasis ? { acceptedFindingBasis } : {}) },
    occurredAt: command.kind === 'evidence.correct' ? command.occurredAt : undefined,
  });
  await retainSubjectEvidence(
    client,
    principal.tenantId,
    [flight.id, ...(previousFlightId ? [previousFlightId] : [])],
    event,
  );
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,flight_id,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [event.id, principal.tenantId, command.kind, flight.id, principal.id, event.received_at, command],
  );
  if (command.kind === 'evidence.correct')
    await bridgeLegacyFlightReportCorrection(client, principal, command, event, store);
  if (command.kind === 'identity.link') await bridgeLegacyFlightReportLink(client, principal, command, event);
  if (command.kind === 'decision.record')
    await client.query(
      'INSERT INTO decisions(id,tenant_id,flight_id,actor_id,kind,note,recorded_at,rendered_input_cut,accepted_input_cut,accepted_basis_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        event.id,
        principal.tenantId,
        flight.id,
        principal.id,
        command.decision.kind,
        command.decision.note,
        event.received_at,
        command.inputCut,
        basis,
        Number(flight.basis_revision),
      ],
    );
  if (command.kind === 'decision.record' && command.findingTreatment)
    await recordFindingTreatment(
      client,
      principal,
      event.id,
      command.findingTreatment,
      command.decision.note,
      event.received_at,
    );
  if (command.kind === 'flight.assign' || command.kind === 'identity.link') {
    await client.query(
      'INSERT INTO relations(id,tenant_id,flight_id,kind,revision,payload,event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        principal.tenantId,
        flight.id,
        command.kind,
        Number(flight.revision) + 1,
        relationPayload,
        event.id,
      ],
    );
    if (previousFlightId && previousFlightId !== flight.id) {
      const previous = await requireRow(client, 'flight_views', previousFlightId);
      await client.query(
        'INSERT INTO relations(id,tenant_id,flight_id,kind,revision,payload,event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          principal.tenantId,
          previousFlightId,
          command.kind,
          Number(previous.revision),
          relationPayload,
          event.id,
        ],
      );
    }
  }
  for (const id of [...new Set([flight.id, previousFlightId].filter((id): id is string => !!id))].sort())
    await appendLiveChange(client, principal.tenantId, id, event.id, 'flight.updated');
  if (command.kind !== 'identity.link') await validateFlightRuleSelection(client, principal, flight.id);
  return getCommand(client, event.id);
}
export {
  encodeHistoryCursor,
  getTimeline,
  getOrders,
  getReceipts,
  historyCursor,
  historyLimit,
  historyPrecise,
} from './history.js';
export { canonicalDigest, type JournalEvent };
export { getOrganizationPeople } from './people.js';

export { projectDocumentControl } from './sms-documents.js';
export {
  configureNoticeChannels,
  emailNoticesConfigured,
  getNoticeSettings,
  getNoticeWebhook,
  listNotices,
  noticeDeployment,
  noticeEmails,
  queueNotices,
  setNoticeWebhook,
  updateNoticeSettings,
  webhookAddressProblem,
  type NoticeDeployment,
  type NoticeDraft,
  type SmtpSettings,
} from './notices.js';
export {
  noticeDay,
  noticeLink,
  noticeSentence,
  noticeTime,
  noticeWebhookBody,
  renderNoticeEmail,
  webhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type NoticeContent,
  type NoticeEvent,
  type NoticeItem,
  type NoticeRecord,
} from './notice-content.js';
export { writeDatedNotices, type DatedNoticeOptions } from './notice-schedule.js';
