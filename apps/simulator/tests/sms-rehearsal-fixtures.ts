import type {
  CommandLinkBaselineRecord,
  CommandLinkBaselineSource,
  FlightResponse,
  SmsRecordDetailResponse,
  MissionRevisionRecord,
  MonitoringRecordV2,
  SubjectBasisManifest,
} from '@ledger/contracts';
import type { MonitoringWindowAdapterResult, PreparedMonitoringWindowInput } from '@ledger/adapters';
import { areaControlTypes, decisionReference } from '@ledger/domain';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  baselineEvidence,
  monitoringRecordV2,
} from '../../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import { missionReleaseRecordResponse } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { missionRevision2Record } from '../../../packages/contracts/fixtures/demo/v1/missions.js';
import {
  advanceOperation,
  createOperation,
  observeOperationMonitoring,
  operationCapacityPreset,
  reviseOperationReservation,
} from '../../../packages/simulation-models/src/operation.js';
import { createOperationMonitoringRuntimeState } from '../src/operation-monitoring-runtime.js';
import type { OperationMonitoringFlightBinding as OperationCommandLinkBaselineBinding } from '../src/operation-monitoring-runtime.js';
import type { OperationReservationRevisionReceipt } from '../src/operation-reservation-revision.js';
import { prepareSmsDeparture, type SmsDepartureSelection } from '../src/sms-departure-preparation.js';
import { prepareSmsCalculation } from '../src/sms-calculation-preparation.js';
import type { ControlEffectivenessJournal } from '../src/control-effectiveness-plan.js';
import type { ControlIndicatorResultRecord, ControlWindow, IndicatorResult } from '@ledger/contracts';
import { prepareSmsReview } from '../src/sms-review-preparation.js';
import type { SmsAcceptedControlSelection } from '../src/sms-rehearsal-control.js';
import {
  prepareSmsFollowup,
  prepareSmsIncident,
  prepareSmsRevision,
  type SmsIncidentPreparation,
  type SmsRehearsalConfig,
  type SmsRehearsalConfigV1,
  type SmsRehearsalConfigV2,
  type SmsRehearsalConfigV3,
} from '../src/sms-rehearsal-plan.js';

export const incidentStart = '2026-10-15T14:00:00.000Z';
export const incidentPreparedAt = '2026-10-15T14:00:01.000Z';
export const followupStart = '2026-10-15T14:20:00.000Z';
export const followupPreparedAt = '2026-10-15T14:20:01.000Z';

export function config(): SmsRehearsalConfigV1 {
  return {
    version: 1,
    rehearsalId: 'sms-unit',
    directory: '/tmp/ledger-sms-rehearsal-unit',
    apiUrl: 'http://127.0.0.1:14300',
    emulatorUrl: 'http://127.0.0.1:14302',
    ports: { mqtt: 14383, callback: 14303 },
    seed: 71031,
    fleet: { alpha: 1, beta: 1 },
    sourcePrincipalId: 'sms-source-alpha',
    monitoringSourceId: 'sms-monitoring',
    followup: {
      radioInitialState: 'up',
      monitoringAvailable: true,
      departureOffsetMs: 60_000,
      windowStartOffsetMs: 120_000,
      windowEndOffsetMs: 600_000,
      missionEndOffsetMs: 900_000,
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-87.63, 41.88],
            [-87.63, 41.9],
            [-87.64655, 41.88665],
            [-87.65, 41.9],
            [-87.63, 41.88],
          ],
        },
      },
    },
  };
}

export function configV2(): SmsRehearsalConfigV2 {
  return {
    ...config(),
    version: 2,
    fleet: { alpha: 25, beta: 25 },
    capacityPreset: 'alpha-25.1',
    predepartureProfile: 'reserve-selected-await-release.1',
  };
}

export function configV3(): SmsRehearsalConfigV3 {
  return {
    ...config(),
    version: 3,
    target: 'isolated-staging.1',
    directory: '/data/ledger/world/sms/sms-unit',
    apiUrl: 'http://127.0.0.1:4000',
    emulatorUrl: 'http://127.0.0.1:4002',
    ports: { mqtt: 1884, callback: 4003 },
    fleet: { alpha: 3, beta: 2 },
    capacityPreset: 'illustrative-25.1',
    predepartureProfile: 'reserve-selected-await-release.1',
    followup: { ...config().followup, windowEndOffsetMs: 420_000 },
  };
}

function alphaScope<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll('fixture-tenant', 'tenant-alpha')) as T;
}

const smsActions = Object.fromEntries(
  [
    'revise',
    'proposeControl',
    'link',
    'attach',
    'assess',
    'accept',
    'adopt',
    'close',
    'reopen',
    'export',
    'readContent',
  ].map((name) => [name, { available: false, reason: 'Fixture record' }]),
) as SmsRecordDetailResponse['actions'];
const safetyLead = { id: 'sms-safety-lead-alpha', name: 'Fictional safety lead' };
const executive = { id: 'sms-executive-alpha', name: 'Fictional accountable executive' };

/** A safety record as the record read shows it, with only what the rehearsal reads filled in. */
function smsRecord(
  record: { id: string; kind: 'hazard' | 'control'; title: string },
  versions: SmsRecordDetailResponse['versions'],
  extra: Partial<SmsRecordDetailResponse> = {},
): SmsRecordDetailResponse {
  const current = versions.at(-1)!;
  return {
    record: {
      ...record,
      reference: null,
      status: 'open',
      recordClass: 'srm_output',
      confidentiality: 'ordinary',
      owner: safetyLead,
      dueAt: null,
      overdue: false,
      revision: current.revision,
      projectedRevision: current.revision,
      versionNumber: current.versionNumber,
      openedAt: versions[0]!.recordedAt,
      updatedAt: current.recordedAt,
      waitingOnMe: false,
    },
    current,
    versions,
    links: [],
    linkedFrom: [],
    linkChanges: [],
    attachments: [],
    decisions: [],
    signatures: [],
    matrix: null,
    assessedMatrix: null,
    actions: smsActions,
    basis: { revision: current.revision, dependencyBasis: 'b'.repeat(64) },
    computedAt: '2026-10-15T14:19:00.000Z',
    ...extra,
  };
}

export function selection(incident: SmsIncidentPreparation): SmsAcceptedControlSelection {
  const flightId = 'sms-incident-ledger-flight';
  const hazardId = 'sms-incident-hazard';
  const controlId = 'sms-incident-avoidance-area';
  const controlBody = {
    hazardId,
    controlType: { ...areaControlTypes().find((type) => type.id === 'control.avoidance-area')! },
    parameters: { center: { latitude: 41.89, longitude: -87.64 }, radiusMeters: 250 },
    effectiveFrom: '2026-10-15T14:10:00.000Z',
    effectiveUntil: '2026-10-15T15:00:00.000Z',
  };
  const controlVersion = {
    id: 'sms-incident-avoidance-area-v1',
    versionNumber: 1,
    revision: 1,
    schema: 'sms.control.1',
    title: 'Keep routes clear of the incident site',
    body: controlBody,
    bodyDigest: canonicalDigest(controlBody),
    owner: safetyLead,
    dueAt: null,
    links: [],
    recordedBy: safetyLead,
    recordedAt: '2026-10-15T14:11:00.000Z',
  };
  const hazardBody = {
    description: 'The command link to the fictional aircraft was lost over the work site.',
    consequence: 'Loss of the aircraft over people.',
    source: { kind: 'finding' },
  };
  const hazardVersion = {
    ...controlVersion,
    id: 'sms-incident-hazard-v1',
    schema: 'sms.hazard.1',
    title: 'Command link loss over the work site',
    body: hazardBody,
    bodyDigest: canonicalDigest(hazardBody),
    recordedAt: '2026-10-15T14:10:30.000Z',
  };
  const matrix = { recordId: 'sms-alpha-matrix', versionNumber: 1, digest: 'c'.repeat(64) };
  const assessment = {
    version: 'sms.decision.1' as const,
    id: 'sms-incident-assessment',
    subjectId: hazardId,
    kind: 'risk.assess' as const,
    note: 'Assessed with the avoidance area in place.',
    acceptedRevision: 3,
    acceptedBasisRevision: 2,
    outcome: {
      matrix,
      initial: { severity: 'major', likelihood: 'occasional', level: 'high', acceptance: 'high' as const },
      controls: [
        {
          recordId: controlId,
          versionNumber: 1,
          bodyDigest: controlVersion.bodyDigest,
          title: controlVersion.title,
          controlType: controlBody.controlType,
        },
      ],
      residual: { severity: 'minor', likelihood: 'remote', level: 'low', acceptance: 'low' as const },
      newHazardCheck: { answer: 'none_identified' as const },
      assessedVersion: { versionNumber: 1, bodyDigest: hazardVersion.bodyDigest },
    },
    actor: { principalId: safetyLead.id, name: safetyLead.name },
    dependencyBasis: 'd'.repeat(64),
    recordedAt: '2026-10-15T14:12:00.000Z',
  };
  const acceptance = {
    ...assessment,
    id: 'sms-incident-acceptance',
    kind: 'risk.accept' as const,
    note: 'Residual risk accepted with the avoidance area in place.',
    acceptedRevision: 4,
    acceptedBasisRevision: 3,
    outcome: {
      assessmentId: assessment.id,
      assessmentDigest: canonicalDigest(assessment.outcome),
      matrix,
      level: 'low',
      acceptance: 'low' as const,
    },
    actor: {
      principalId: executive.id,
      name: executive.name,
      principalRevision: 1,
      policyVersion: 'ledger.sms-decision-authority.1',
      satisfyingCapability: 'risk:accept:high',
    },
    signature: { id: 'sms-incident-signature', contentDigest: 'e'.repeat(64) },
    recordedAt: '2026-10-15T14:13:00.000Z',
  };
  const listed = {
    id: controlId,
    title: controlVersion.title,
    status: 'open',
    versionNumber: 1,
    bodyDigest: controlVersion.bodyDigest,
    owner: safetyLead,
    controlType: { ...controlBody.controlType, title: 'Route avoidance area' },
    parameters: controlBody.parameters,
    description: null,
    effectiveFrom: controlBody.effectiveFrom,
    effectiveUntil: controlBody.effectiveUntil,
    accepted: true,
  };
  const hazard = smsRecord(
    { id: hazardId, kind: 'hazard', title: hazardVersion.title },
    [{ ...hazardVersion, revision: 1 }],
    {
      origin: {
        kind: 'finding',
        findingId: 'sms-incident-finding',
        findingKind: 'flight',
        subject: { scope: 'ledger', kind: 'flight', id: flightId },
        subjectKey: `ledger:flight:${flightId}`,
        evaluationId: 'sms-incident-evaluation',
        evaluationDigest: 'f'.repeat(64),
        evaluationRecordedAt: '2026-10-15T14:09:00.000Z',
        rule: {
          packId: 'fictional.procedures',
          packVersion: 1,
          ruleId: 'fictional.procedures.link-review',
          ruleVersion: 1,
          ruleDigest: '1'.repeat(64),
          bindingId: null,
          bindingVersion: null,
          title: 'Review a lost link',
        },
      },
      decisions: [acceptance, assessment] as unknown as SmsRecordDetailResponse['decisions'],
      controls: [listed],
    },
  );
  hazard.record.revision = 4;
  hazard.record.projectedRevision = 4;
  hazard.basis.revision = 4;
  const control = smsRecord({ id: controlId, kind: 'control', title: controlVersion.title }, [controlVersion]);
  const origin: FlightResponse = {
    flight: {
      id: flightId,
      label: 'Retained incident flight',
      originationKey: incident.identities.attemptId,
      aircraft: incident.identities.aircraftId,
      revision: 1,
      basisRevision: 1,
      activity: 'landed',
      coverage: 'recorded',
      orderIds: [],
      sourceIds: ['partner-orders', 'command-link'],
      unresolvedCount: 0,
      conflictCount: 0,
      outstandingWork: 0,
    },
    meta: {
      requestId: 'sms-incident-flight-read',
      projectionRevision: 1,
      inputCut: { streams: {}, basisRevision: 1, principalRevision: 1 },
      dependencyBasis: 'b'.repeat(64),
      computedAt: '2026-10-15T14:19:00.000Z',
      outstandingWork: 0,
    },
  };
  return { version: 2, hazardId, controlId, controlVersion: 1, hazard, control, origin };
}

export function prepared(configuration: SmsRehearsalConfig = config()) {
  const incident = prepareSmsIncident(configuration, incidentStart, incidentPreparedAt);
  const selected = selection(incident);
  const followup = prepareSmsFollowup(configuration, followupStart, followupPreparedAt, incident, selected);
  return { configuration, incident, selected, followup };
}

export function departureFixture(configuration: SmsRehearsalConfig = config()) {
  const rehearsal = prepared(configuration);
  const { followup } = rehearsal;
  const world = createOperation({
    ...operationCapacityPreset(configuration.version !== 1 ? configuration.capacityPreset : 'illustrative-25.1'),
    runId: followup.runId,
    start: followup.start,
    seed: configuration.seed,
    fleet: configuration.fleet,
    missionPlan: 'dispatch-plan.1',
    selectedDemandWindow: {
      attemptId: followup.identities.attemptId,
      ...followup.missionChange.operatingInterval,
    },
    predeparture:
      configuration.version !== 1
        ? { version: configuration.predepartureProfile, tenant: 'alpha', attemptId: followup.identities.attemptId }
        : { version: 'reserve-await-release.1', tenant: 'alpha' },
    simulatedLink: {
      version: 'simulated-link.1',
      attemptId: followup.identities.attemptId,
      initialState: followup.monitoring.radioInitialState,
    },
  });
  const monitoring = createOperationMonitoringRuntimeState(followup.monitoring, world);
  advanceOperation(world, Date.parse(followupPreparedAt));
  const reservation = world.reservations!.find((row) => row.id === followup.identities.attemptId)!;
  const revision = prepareSmsRevision(followup, reservation);
  const source = reviseOperationReservation(world, reservation.id, revision.change);
  observeOperationMonitoring(monitoring.observer, world);
  const revisionReceipt: OperationReservationRevisionReceipt = {
    version: 'operation.reservation-revision.1',
    planDigest: canonicalDigest(revision),
    runId: followup.runId,
    reservationId: reservation.id,
    sourceRevision: source.sourceRevision,
    sourceDigest: canonicalDigest(source),
    occurredAt: source.occurredAt,
  };
  const actual = { reservation: structuredClone(reservation), revisionReceipt };
  const bytes = Buffer.from(JSON.stringify(source), 'utf8');
  const original = { sha256: sha256(bytes), byteLength: bytes.byteLength };
  const { sourceRevision, occurredAt, ...payload } = source;
  const flightId = 'sms-followup-ledger-flight';
  const mission: MissionRevisionRecord = {
    ...alphaScope(missionRevision2Record),
    ...source,
    flightId,
    missionId: 'sms-followup-ledger-mission',
    recordedAt: '2026-10-15T14:20:02.000Z',
    original,
    contentDigest: canonicalDigest({
      version: 'ledger.mission-content.1',
      sourceId: 'mission-planner',
      flightId,
      sourceRevision,
      occurredAt,
      fidelity: 'synthetic_contract',
      payload,
      original: { ...original, bytesBase64: bytes.toString('base64') },
    }),
    authority: {
      ...alphaScope(missionRevision2Record.authority),
      principalId: configuration.sourcePrincipalId,
    },
  };
  const missionReference = {
    missionId: mission.missionId,
    sourceRevision: mission.sourceRevision,
    eventId: mission.id,
    contentDigest: mission.contentDigest,
    recordDigest: canonicalDigest(mission),
  };
  const release = alphaScope(missionReleaseRecordResponse);
  const record = release.release;
  const previousFlightId = record.flightId;
  const previousMissionId = record.basis.mission.missionId;
  record.flightId = flightId;
  record.aircraftId = source.aircraftId;
  record.actor.scope.id = flightId;
  record.recordedAt = '2026-10-15T14:20:04.000Z';
  record.departureWindow = { start: '2026-10-15T14:21:00.000Z', end: '2026-10-15T14:24:00.000Z' };
  record.basis.mission = structuredClone(mission);
  const reference = followup.monitoring.monitoring.control;
  const acceptance = followup.selection.hazard.decisions.find((decision) => decision.kind === 'risk.accept')!;
  const assessment = followup.selection.hazard.decisions.find((decision) => decision.kind === 'risk.assess')!;
  const listed = followup.selection.hazard.controls!.find((entry) => entry.id === reference.controlId)!;
  const assessmentReference = decisionReference(assessment);
  const context = {
    version: 'mission.avoidance-control-record-context.1' as const,
    assessment: assessmentReference,
    hazard: { id: reference.hazardId, latestAcceptanceId: acceptance.id },
    control: { recordId: reference.controlId, versionNumber: reference.controlVersion, status: 'open' },
  };
  record.basis.candidateContexts[0]!.context =
    context as unknown as (typeof record.basis.candidateContexts)[0]['context'];
  const candidate = record.basis.avoidance.candidates[0]!;
  Object.assign(candidate, {
    hazardId: reference.hazardId,
    controlId: reference.controlId,
    controlVersion: reference.controlVersion,
    controlEventId: reference.controlEventId,
    controlDigest: reference.controlDigest,
    template: { id: listed.controlType.id, version: listed.controlType.version, digest: listed.controlType.digest },
    acceptance: structuredClone(reference.acceptance),
    assessment: assessmentReference,
    authority: {
      policyVersion: 'ledger.sms-decision-authority.1',
      principalId: acceptance.actor.principalId,
      principalRevision: acceptance.actor.principalRevision,
      satisfyingCapability: acceptance.actor.satisfyingCapability,
    },
    interval: { start: listed.effectiveFrom, end: listed.effectiveUntil },
    safetyContextDigest: canonicalDigest(context),
  });
  record.basis.candidateContexts[0]!.controlEventId = candidate.controlEventId;
  record.basis.candidateContexts[0]!.acceptanceId = candidate.acceptance.id;
  const avoidance = record.basis.avoidance;
  avoidance.evaluatedAt = '2026-10-15T14:20:03.000Z';
  avoidance.mission = missionReference;
  resealRelease(release);
  record.basis.basisManifest = JSON.parse(
    JSON.stringify(record.basis.basisManifest)
      .replaceAll(previousFlightId, flightId)
      .replaceAll(previousMissionId, mission.missionId),
  ) as SubjectBasisManifest;
  const manifest = record.basis.basisManifest;
  const renderedStreams: Record<string, number> = {};
  const acceptedStreams: Record<string, number> = {};
  for (const entry of [...manifest.frontiers, ...(manifest.authority ? [manifest.authority] : [])]) {
    renderedStreams[entry.streamId] = Math.max(renderedStreams[entry.streamId] ?? 0, entry.projectedSequence);
    acceptedStreams[entry.streamId] = Math.max(acceptedStreams[entry.streamId] ?? 0, entry.sequence);
  }
  record.basis.renderedInputCut.streams = renderedStreams;
  record.basis.acceptedInputCut.streams = acceptedStreams;
  resealRelease(release);
  const flight: FlightResponse = {
    flight: {
      ...structuredClone(rehearsal.selected.origin.flight),
      id: flightId,
      label: 'Held follow-up flight',
      originationKey: followup.identities.attemptId,
      aircraft: source.aircraftId,
      activity: 'planned',
    },
    meta: structuredClone(rehearsal.selected.origin.meta),
  };
  const selection: SmsDepartureSelection = {
    version: 1,
    principalId: 'sms-departure-author-alpha',
    marginMs: 5_000,
    latencyMarginMs: 1_000,
    handoffAllowanceMs: 1_000,
    allocationDurationMs: 30_000,
    flight,
    mission: { mission },
    release,
  };
  const selectionText = JSON.stringify(selection, null, 2) + '\n';
  const preparedAt = '2026-10-15T14:20:05.000Z';
  const departure = prepareSmsDeparture(followup, revision, actual, selectionText, preparedAt);
  return { ...rehearsal, world, monitoring, revision, actual, selection, selectionText, preparedAt, departure };
}

export function resealRelease(release: SmsDepartureSelection['release']) {
  const avoidance = release.release.basis.avoidance;
  const { id, version, digest } = avoidance.calculation;
  avoidance.contextDigest = canonicalDigest({
    version: 'mission.avoidance-context.1',
    mission: avoidance.mission,
    calculation: { id, version, digest },
    candidates: avoidance.candidates,
    notApplicable: avoidance.notApplicable,
    consideredTypes: avoidance.consideredTypes,
    candidateCompleteness: avoidance.candidateCompleteness,
  });
  const { previewDigest: _previewDigest, ...preview } = avoidance;
  avoidance.previewDigest = canonicalDigest(preview);
  release.digest = canonicalDigest(release.release);
}

export function calculationFixture(configuration: SmsRehearsalConfig = calculationConfig()) {
  const rehearsal = departureFixture(configuration);
  const { followup } = rehearsal;
  const mission = structuredClone(rehearsal.selection.mission.mission);
  const binding: OperationCommandLinkBaselineBinding = {
    attemptId: followup.identities.attemptId,
    tenantId: 'tenant-alpha',
    sourceId: 'command-link',
    sourceSessionId: followup.identities.commandLinkSourceSessionId,
    flight: {
      id: mission.flightId,
      originationKey: followup.identities.attemptId,
      aircraft: followup.identities.aircraftId,
    },
  };
  const baselineSource: CommandLinkBaselineSource = JSON.parse(
    Buffer.from(baselineEvidence.originalBytesBase64, 'base64').toString('utf8'),
  );
  Object.assign(baselineSource, {
    sourceId: binding.sourceId,
    sourceSessionId: binding.sourceSessionId,
    sourceEventId: 'sms-followup-baseline',
    flightId: mission.flightId,
    aircraftId: mission.aircraftId,
    occurredAt: followup.missionChange.operatingInterval!.start,
    state: configuration.followup.radioInitialState,
  });
  const baselineBytes = Buffer.from(JSON.stringify(baselineSource, null, 2) + '\n');
  const { sourceId, sourceSessionId, flightId, occurredAt, ...baselinePayload } = baselineSource;
  const baselineRecord: CommandLinkBaselineRecord = {
    eventId: 'sms-followup-baseline-event',
    receiptId: 'sms-followup-baseline-receipt',
    recordedAt: new Date(Date.parse(occurredAt) + 1_000).toISOString(),
    input: {
      sourceId,
      sourceSessionId,
      kind: 'command-link.baseline',
      occurredAt,
      subject: { flightId },
      artifactId: 'sms-followup-baseline-original',
      fidelity: 'synthetic_contract',
      payload: baselinePayload,
    },
    authority: {
      ...alphaScope(baselineEvidence.authority),
      sourceId,
      grantedSources: [sourceId],
    },
    original: {
      artifactId: 'sms-followup-baseline-original',
      sha256: sha256(baselineBytes),
      byteLength: baselineBytes.length,
    },
  };
  const source = structuredClone(monitoringRecordV2.source);
  source.sourceSessionId = followup.identities.monitoringSourceSessionId;
  source.sourceWindowId = followup.identities.monitoringSourceWindowId;
  source.control = structuredClone(followup.monitoring.monitoring.control);
  source.window = structuredClone(followup.monitoring.monitoring.window);
  source.occurredAt = new Date(Date.parse(source.window.end) + 1_000).toISOString();
  source.completeThrough = source.window.end;
  source.populationComplete = false;
  const selected = source.flights[0]!;
  Object.assign(selected, {
    flightId: mission.flightId,
    aircraftId: mission.aircraftId,
    mission: {
      missionId: mission.missionId,
      sourceRevision: mission.sourceRevision,
      eventId: mission.id,
      contentDigest: mission.contentDigest,
      recordDigest: canonicalDigest(mission),
    },
    c2SourceId: binding.sourceId,
    c2SourceSessionId: binding.sourceSessionId,
    baseline: {
      eventId: baselineRecord.eventId,
      receiptId: baselineRecord.receiptId,
      sourceEventId: baselineSource.sourceEventId,
      digest: canonicalDigest(baselineRecord),
    },
    observedIntervals: [
      { start: source.window.start, end: new Date(Date.parse(source.window.start) + 60_000).toISOString() },
    ],
    coverageIntervals: null,
    gaps: [{ interval: structuredClone(source.window), kind: 'c2_monitor' }],
    declaredC2SourceEventIds: [],
  });
  const bytes = Buffer.from(JSON.stringify(source, null, 2) + '\n');
  const { sourceSessionId: monitoringSession, occurredAt: sourceTime, ...payload } = source;
  const content: Omit<PreparedMonitoringWindowInput, 'submissionDigest'> = {
    version: 'ledger.monitoring-window-submission.2',
    apiUrl: configuration.apiUrl,
    tenantId: 'tenant-alpha',
    principalId: configuration.sourcePrincipalId,
    key: `monitoring-window:revision:${canonicalDigest({
      version: 'ledger.monitoring-window-delivery.2',
      tenantId: 'tenant-alpha',
      sourceId: configuration.monitoringSourceId,
      sourceSessionId: source.sourceSessionId,
      sourceWindowId: source.sourceWindowId,
      sourceRevision: source.sourceRevision,
    })}`,
    input: {
      sourceId: configuration.monitoringSourceId,
      sourceSessionId: monitoringSession,
      kind: 'monitoring.window',
      occurredAt: sourceTime,
      artifactId: 'submitted-sms-window-original',
      fidelity: 'synthetic_contract',
      payload,
    },
    bytesBase64: bytes.toString('base64'),
    sha256: sha256(bytes),
  };
  const submission = { ...content, submissionDigest: canonicalDigest(content) };
  const recordedAt = new Date(Date.parse(sourceTime) + 1_000).toISOString();
  const record: MonitoringRecordV2 = {
    version: 'monitoring.window.2',
    id: 'sms-followup-monitoring-event',
    organizationId: 'organization:tenant-alpha',
    sourceId: configuration.monitoringSourceId,
    source,
    original: {
      artifactId: 'canonical-sms-window-original',
      sha256: sha256(bytes),
      byteLength: bytes.length,
    },
    recordedAt,
    authority: {
      ...alphaScope(monitoringRecordV2.authority),
      principalId: 'earlier-monitoring-issuer-alpha',
      sourceId: configuration.monitoringSourceId,
      grantedSources: [configuration.monitoringSourceId],
    },
  };
  const accepted: MonitoringWindowAdapterResult = {
    receipt: {
      receipt: {
        id: 'sms-followup-monitoring-receipt',
        eventId: record.id,
        sourceId: record.sourceId,
        kind: 'monitoring.window',
        occurredAt: sourceTime,
        receivedAt: recordedAt,
        status: 'accepted',
        artifactId: record.original.artifactId,
        linkStatus: 'linked',
        processing: { status: 'completed', attempts: 1 },
        payload: structuredClone(payload),
      },
      meta: {
        requestId: 'sms-followup-monitoring-receipt-read',
        projectionRevision: 1,
        inputCut: { streams: {}, principalRevision: record.authority.principalRevision },
        computedAt: recordedAt,
        outstandingWork: 0,
      },
    },
    submittedUploadArtifactId: submission.input.artifactId,
    sha256: submission.sha256,
  };
  const monitoringActual = {
    binding,
    mission,
    submission,
    accepted,
    canonical: { record, digest: canonicalDigest(record) },
  };
  const calculationSelectionText =
    JSON.stringify({ version: 1, principalId: 'sms-calculation-author-alpha' }, null, 2) + '\n';
  const calculationPreparedAt = new Date(Date.parse(recordedAt) + 1_000).toISOString();
  const calculation = prepareSmsCalculation(
    followup,
    monitoringActual,
    calculationSelectionText,
    calculationPreparedAt,
  );
  return {
    ...rehearsal,
    monitoringActual,
    monitoringBaselineSource: baselineSource,
    monitoringBaselineRecord: baselineRecord,
    calculationSelectionText,
    calculationPreparedAt,
    calculation,
  };
}

function calculationConfig(): SmsRehearsalConfig {
  const configuration = config();
  configuration.followup.radioInitialState = 'unknown';
  return configuration;
}

export function reviewFixture(configuration: SmsRehearsalConfig = calculationConfig()) {
  const rehearsal = calculationFixture(configuration);
  const { calculation } = rehearsal;
  const plan = calculation.plan;
  const recordedAt = new Date(Date.parse(rehearsal.calculationPreparedAt) + 1_000).toISOString();
  // The window the calculation actor opens and the result it records through it, as the API would answer.
  const window: ControlWindow = {
    id: 'sms-followup-control-window',
    variant: 'generic',
    organizationId: 'organization:tenant-alpha',
    control: structuredClone(plan.window.control),
    period: { ...plan.window.period },
    population: {
      subjectKind: plan.window.subjectKind,
      subjects: structuredClone(plan.window.subjects),
      complete: plan.window.complete,
      declaredBy: { kind: 'person', id: plan.principalId },
    },
    expectedObservations: structuredClone(plan.window.expectedObservations),
    indicators: structuredClone(plan.window.indicators),
    openedAt: recordedAt,
    revision: {
      number: 1,
      id: 'sms-followup-window-revision',
      recordedAt,
      digest: '1'.repeat(64),
      note: plan.window.note,
    },
  };
  const result: IndicatorResult = {
    version: 'ledger.indicator-result.1',
    definition: { ...plan.indicator },
    exposureKind: { id: 'exposure.covered-flight-hours', version: 1, digest: '2'.repeat(64) },
    control: {
      id: plan.window.control.recordId,
      version: 1,
    },
    window: { ...plan.window.period },
    recordedThrough: recordedAt,
    status: 'insufficient',
    eventCount: 0,
    exposure: {
      value: { numerator: '0', denominator: '1' },
      decimal: '0.000000',
      unit: 'flight_hour',
      coverage: 'checked',
      gaps: [],
      conflicts: [],
    },
    rate: null,
    reasons: ['exposure_not_positive'],
    eventsPlacedBy: [],
    population: {
      subjectCount: 1,
      digest: '3'.repeat(64),
      complete: plan.window.complete,
      declaredBy: { kind: 'person', id: plan.principalId },
    },
    counted: { events: [], exposure: [] },
    inputDigest: '4'.repeat(64),
  };
  const record: ControlIndicatorResultRecord = {
    format: 'ledger.control-indicator-result.1',
    id: 'sms-followup-indicator-result',
    organizationId: window.organizationId,
    windowId: window.id,
    windowRevision: 1,
    windowRevisionDigest: window.revision.digest,
    control: structuredClone(plan.window.control),
    request: {
      definition: { id: plan.indicator.id, version: plan.indicator.version },
      window: { ...plan.window.period },
      recordedThrough: recordedAt,
      population: {
        subjects: structuredClone(plan.window.subjects),
        complete: plan.window.complete,
        declaredBy: { kind: 'person', id: plan.principalId },
      },
    },
    selection: 'complete',
    result,
    actorId: plan.principalId,
    recordedAt: new Date(Date.parse(recordedAt) + 500).toISOString(),
  };
  const calculationAccepted = { record, digest: canonicalDigest(record) };
  const windowPayload = JSON.stringify(plan.window);
  const resultPayload = JSON.stringify({
    definition: { ...plan.indicator },
    expectedRevision: { number: 1, digest: window.revision.digest },
  });
  const calculationJournal: ControlEffectivenessJournal = {
    version: 2,
    kind: 'control-indicator-result-action',
    apiUrl: plan.apiUrl,
    planDigest: canonicalDigest(plan),
    tenantId: plan.tenantId,
    principalId: plan.principalId,
    actions: [
      {
        step: 'window',
        key: 'sms-followup-window-action',
        payload: windowPayload,
        payloadSha256: sha256(windowPayload),
        status: 'accepted',
        accepted: window,
      },
      {
        step: 'result',
        key: 'sms-followup-result-action',
        payload: resultPayload,
        payloadSha256: sha256(resultPayload),
        status: 'accepted',
        accepted: calculationAccepted,
      },
    ],
  };
  const reviewSelectionText =
    JSON.stringify(
      {
        version: 1,
        principalId: 'sms-human-reviewer-alpha',
        principalName: 'Sam Rivera',
        conclusion: 'inconclusive',
        note: 'The partial monitoring and unknown baseline do not establish a rate; retain the uncertainty.',
      },
      null,
      2,
    ) + '\n';
  const reviewPreparedAt = new Date(Date.parse(recordedAt) + 1_000).toISOString();
  const review = prepareSmsReview(
    rehearsal.followup,
    calculation,
    calculationJournal,
    reviewSelectionText,
    reviewPreparedAt,
  );
  return {
    ...rehearsal,
    calculationAccepted,
    calculationJournal,
    reviewSelectionText,
    reviewPreparedAt,
    review,
  };
}
