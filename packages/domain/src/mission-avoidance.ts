import {
  MISSION_AVOIDANCE_CANDIDATE_LIMIT,
  MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  type AreaControlCenter,
  type ControlBody,
  type MissionAvoidanceCandidate,
  type MissionAvoidanceMissionReference,
  type MissionAvoidanceNotApplicable,
  type MissionAvoidanceNotApplicableArea,
  type MissionAvoidancePreview,
  type MissionAvoidanceReviewedCandidate,
  type MissionAvoidanceResponse,
  type MissionRevisionRecord,
  type SimulationAvoidanceDemoPreparationContext,
  type SmsAcceptanceOutcome,
  type SmsDecisionRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { responseMeta } from './index.js';
import { nextAcceptedControlBoundary } from './accepted-control-rules.js';
import { decisionReference } from './sms-reads.js';
import { calculationMeta, evaluateMissionAvoidanceGeometry } from './mission-avoidance-kernel.js';
import { verifyMissionInputSource } from './missions.js';
import { areaControlTypes, controlArea } from './control-types.js';
import { evaluateControlApplicability } from './control-applicability.js';
import { missionAvoidanceContextDigest } from './mission-avoidance-context.js';

export { missionAvoidanceContextDigest } from './mission-avoidance-context.js';

const RECORD_BYTES_LIMIT = 2 * 1024 * 1024;

interface MissionHead {
  id: string;
  byte_length: string;
  projected_id: string | null;
  state: string | null;
}

/**
 * What a candidate from a control record was read against: the hazard's current assessment and acceptance and the
 * control record's current version. A changed one asks for review.
 */
export interface ControlRecordAvoidanceContext {
  version: 'mission.avoidance-control-record-context.1';
  assessment: { id: string; acceptedRevision: number; digest: string } | null;
  hazard: { id: string; latestAcceptanceId: string };
  control: { recordId: string; versionNumber: number; status: string };
}

/** The retained preimage of one considered control's safety context digest. */
export interface ControlRecordContextEntry {
  controlEventId: string;
  acceptanceId: string;
  context: ControlRecordAvoidanceContext;
}

export interface MissionAvoidanceSnapshot {
  preview: MissionAvoidancePreview;
  mission: MissionRevisionRecord | null;
  /** The candidates' areas, in the order of the candidates. */
  circles: { center: AreaControlCenter; radiusMeters: number }[];
  /** Every considered control's area, whether it applies or not: a detour keeps clear of all of them. */
  consideredCircles: { center: AreaControlCenter; radiusMeters: number }[];
  candidateContexts: ControlRecordContextEntry[];
  notApplicableContexts: ControlRecordContextEntry[];
  /**
   * The earliest instant after evaluation at which any of the organization's accepted controls starts or ends: the set
   * of controls in force changes then without any new decision. A release refuses to record past it and a departure
   * lease ends at it; a briefing and a release's recheck time use only the controls that can matter to the flight.
   */
  nextBoundary: string | null;
}

/** One accepted area control in the shape route review reads it. */
export interface AcceptedAreaControl {
  candidate: Omit<MissionAvoidanceCandidate, 'geometry'>;
  circle: { center: AreaControlCenter; radiusMeters: number };
  safetyContext: ControlRecordAvoidanceContext;
  /** The accepted version's title and parameters, as its applicability rule reads them. */
  title: string;
  parameters: unknown;
}

type AcceptedAreaControls =
  | { complete: true; count: number; controls: AcceptedAreaControl[] }
  | { complete: false; count: number; reason: 'considered_limit_exceeded' | 'record_budget_exceeded' };

interface ControlRecordRow {
  acceptance_id: string;
  hazard_id: string;
  control_id: string;
  control_version_number: number;
  control_body_digest: string;
  control_type_id: string;
  control_type_version: number;
  control_type_digest: string;
  effective_from: Date;
  effective_until: Date | null;
  control_event_id: string;
  control_title: string;
  control_body: ControlBody;
  control_current_version: number;
  control_status: string;
  acceptance: SmsDecisionRecord;
  accepted_assessment: SmsDecisionRecord;
  current_assessment: SmsDecisionRecord | null;
  body_bytes: string;
  acceptance_bytes: string;
  accepted_assessment_bytes: string;
  current_assessment_bytes: string | null;
}

// Rows of a hazard's latest acceptance whose pinned control type describes an area. The hazard may have any origin.
const controlRecordSql = `SELECT a.acceptance_id,a.hazard_id,a.control_id,a.control_version_number,a.control_body_digest,
 a.control_type_id,a.control_type_version,a.control_type_digest,a.effective_from,a.effective_until,
 v.id AS control_event_id,v.title AS control_title,v.body AS control_body,c.version_number AS control_current_version,c.status AS control_status,
 d.record AS acceptance,ad.record AS accepted_assessment,cur.record AS current_assessment,
 octet_length(v.body::text)::text AS body_bytes,octet_length(d.record::text)::text AS acceptance_bytes,
 octet_length(ad.record::text)::text AS accepted_assessment_bytes,octet_length(cur.record::text)::text AS current_assessment_bytes
 FROM accepted_hazard_controls a
 JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id AND h.latest_acceptance_id=a.acceptance_id
 JOIN sms_records c ON c.tenant_id=a.tenant_id AND c.id=a.control_id
 JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
  AND v.version_number=a.control_version_number AND v.body_digest=a.control_body_digest
 JOIN decisions d ON d.tenant_id=a.tenant_id AND d.subject_id=a.hazard_id AND d.id=a.acceptance_id
 JOIN decisions ad ON ad.tenant_id=a.tenant_id AND ad.subject_id=a.hazard_id AND ad.id=d.record#>>'{outcome,assessmentId}'
 LEFT JOIN decisions cur ON cur.tenant_id=a.tenant_id AND cur.subject_id=a.hazard_id AND cur.id=h.latest_assessment_id
 WHERE a.tenant_id=$1 AND a.effective_from<$3::timestamptz
  AND (a.effective_until IS NULL OR a.effective_until>$2::timestamptz)
  AND (a.control_type_id,a.control_type_version,a.control_type_digest) IN
   (SELECT * FROM unnest($4::text[],$5::integer[],$6::text[]))
 ORDER BY a.hazard_id COLLATE "C",a.control_id COLLATE "C"
 LIMIT ${MISSION_AVOIDANCE_CONSIDERED_LIMIT + 1}`;

function controlRecordAuthority(acceptance: SmsDecisionRecord): MissionAvoidanceCandidate['authority'] {
  const { actor } = acceptance;
  const capability = actor?.satisfyingCapability;
  if (
    !acceptance.signature ||
    actor.policyVersion !== 'ledger.sms-decision-authority.1' ||
    (capability !== 'risk:accept:low' && capability !== 'risk:accept:medium' && capability !== 'risk:accept:high')
  )
    return null;
  return {
    policyVersion: actor.policyVersion,
    principalId: actor.principalId,
    principalRevision: actor.principalRevision,
    satisfyingCapability: capability,
  };
}

function controlRecordCandidate(row: ControlRecordRow, interval: { end: string }): AcceptedAreaControl {
  const controlType = { id: row.control_type_id, version: row.control_type_version, digest: row.control_type_digest };
  const area = controlArea(controlType, row.control_body.parameters);
  const authority = controlRecordAuthority(row.acceptance);
  const accepted = row.acceptance.outcome as SmsAcceptanceOutcome;
  const reasons: string[] = [];
  if (
    !area ||
    !authority ||
    row.acceptance.kind !== 'risk.accept' ||
    accepted.assessmentDigest !== canonicalDigest(row.accepted_assessment.outcome)
  )
    reasons.push('unsupported_control_or_authority');
  if (row.current_assessment?.id !== row.accepted_assessment.id) reasons.push('assessment_changed');
  if (row.control_current_version !== row.control_version_number || row.control_status === 'closed')
    reasons.push('control_changed');
  const safetyContext: ControlRecordAvoidanceContext = {
    version: 'mission.avoidance-control-record-context.1',
    assessment: row.current_assessment ? decisionReference(row.current_assessment) : null,
    hazard: { id: row.hazard_id, latestAcceptanceId: row.acceptance_id },
    control: { recordId: row.control_id, versionNumber: row.control_current_version, status: row.control_status },
  };
  return {
    candidate: {
      hazardId: row.hazard_id,
      controlId: row.control_id,
      controlVersion: row.control_version_number,
      controlEventId: row.control_event_id,
      controlDigest: row.control_body_digest,
      template: controlType,
      acceptance: decisionReference(row.acceptance),
      assessment: decisionReference(row.accepted_assessment),
      authority,
      safetyContextDigest: canonicalDigest(safetyContext),
      interval: {
        start: row.effective_from.toISOString(),
        end: row.effective_until?.toISOString() ?? interval.end,
      },
      context: reasons.some((reason) => reason.startsWith('unsupported_'))
        ? 'unsupported'
        : reasons.length
          ? 'review_required'
          : 'current',
      reasons,
    },
    circle: area
      ? { center: area.center, radiusMeters: area.radiusMeters }
      : { center: { latitude: 0, longitude: 0 }, radiusMeters: 0 },
    safetyContext,
    title: row.control_title,
    parameters: row.control_body.parameters,
  };
}

/**
 * Every accepted area control in effect during the interval: the control records accepted on safety-record hazards
 * of any origin whose registered type describes an area. The caller holds the avoidance register lock. Records
 * already read count towards the byte budget.
 */
export async function acceptedAreaControls(
  client: PoolClient,
  tenantId: string,
  interval: { start: string; end: string },
  bytesAlreadyRead = 0,
): Promise<AcceptedAreaControls> {
  const types = areaControlTypes();
  const rows = (
    await client.query<ControlRecordRow>(controlRecordSql, [
      tenantId,
      interval.start,
      interval.end,
      types.map((type) => type.id),
      types.map((type) => type.version),
      types.map((type) => type.digest),
    ])
  ).rows;
  const count = rows.length;
  if (count > MISSION_AVOIDANCE_CONSIDERED_LIMIT)
    return { complete: false, count, reason: 'considered_limit_exceeded' };
  // Each control version counts once, and each decision record once however many of a hazard's controls cite it.
  const decisions = new Map<string, number>();
  let bytes = bytesAlreadyRead;
  for (const row of rows) {
    bytes += Number(row.body_bytes);
    decisions.set(row.acceptance.id, Number(row.acceptance_bytes));
    decisions.set(row.accepted_assessment.id, Number(row.accepted_assessment_bytes));
    if (row.current_assessment) decisions.set(row.current_assessment.id, Number(row.current_assessment_bytes));
  }
  for (const size of decisions.values()) bytes += size;
  if (bytes > RECORD_BYTES_LIMIT) return { complete: false, count, reason: 'record_budget_exceeded' };
  return { complete: true, count, controls: rows.map((row) => controlRecordCandidate(row, interval)) };
}

function supportedMission(record: MissionRevisionRecord, flightId: string): boolean {
  if (record.version !== 'flight.mission.1' || record.flightId !== flightId) return false;
  try {
    const payload = {
      sourceMissionId: record.sourceMissionId,
      aircraftId: record.aircraftId,
      route: record.route,
      lateralToleranceMeters: record.lateralToleranceMeters,
      altitude: record.altitude,
      operatingInterval: record.operatingInterval,
      ...(record.routePlanning ? { routePlanning: record.routePlanning } : {}),
    };
    const source = { sourceRevision: record.sourceRevision, occurredAt: record.occurredAt, ...payload };
    verifyMissionInputSource(
      {
        sourceId: record.sourceId,
        kind: 'mission.revision',
        sourceRevision: record.sourceRevision,
        occurredAt: record.occurredAt,
        subject: { flightId },
        artifactId: record.artifactId,
        fidelity: 'synthetic_contract',
        payload,
      },
      Buffer.from(JSON.stringify(source), 'utf8'),
    );
    return true;
  } catch {
    return false;
  }
}

function missionReferenceFor(record: MissionRevisionRecord): MissionAvoidanceMissionReference | null {
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (
    !id(record.missionId) ||
    !id(record.id) ||
    !Number.isSafeInteger(record.sourceRevision) ||
    record.sourceRevision < 1 ||
    !digest(record.contentDigest)
  )
    return null;
  return {
    missionId: record.missionId,
    sourceRevision: record.sourceRevision,
    eventId: record.id,
    contentDigest: record.contentDigest,
    recordDigest: canonicalDigest(record),
  };
}

export async function readMissionAvoidanceControlContext(
  client: PoolClient,
  principal: AuthContext,
  interval: MissionRevisionRecord['operatingInterval'],
  reading = false,
): Promise<
  Pick<SimulationAvoidanceDemoPreparationContext, 'evaluatedAt' | 'controls' | 'candidateCompleteness' | 'reasons'>
> {
  if (!reading) await client.query('SELECT ledger_lock_mission_avoidance_register()');
  const evaluatedAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const read = await acceptedAreaControls(client, principal.tenantId, interval);
  const reasons: string[] = [];
  const controls: SimulationAvoidanceDemoPreparationContext['controls'] = [];
  if (read.count > MISSION_AVOIDANCE_CANDIDATE_LIMIT) reasons.push('candidate_limit_exceeded');
  else if (!read.complete) reasons.push(read.reason);
  else for (const { candidate, circle } of read.controls) controls.push({ ...candidate, ...circle });
  return {
    evaluatedAt,
    controls,
    candidateCompleteness: {
      status: reasons.length ? 'incomplete' : 'complete',
      count: read.count,
      limit: MISSION_AVOIDANCE_CANDIDATE_LIMIT,
    },
    reasons,
  };
}

/**
 * A command locks the flight view and the register, which pins the register revision it records until commit. A read
 * at REPEATABLE READ passes `reading`: its snapshot already gives it one consistent view, and a lock there only turns
 * a concurrent change of the flight or the register into a serialization failure.
 */
export async function getMissionAvoidanceSnapshot(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  reading = false,
): Promise<MissionAvoidanceSnapshot> {
  const flight = await client.query(
    `SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2${reading ? '' : ' FOR SHARE'}`,
    [principal.tenantId, flightId],
  );
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  if (!reading) await client.query('SELECT ledger_lock_mission_avoidance_register()');
  const evaluatedAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const head = (
    await client.query<MissionHead>(
      `SELECT a.id,octet_length(a.record::text)::text AS byte_length,v.current_revision_id AS projected_id,w.state
       FROM missions m JOIN LATERAL(SELECT id,record FROM mission_revisions r
        WHERE r.tenant_id=m.tenant_id AND r.mission_id=m.id ORDER BY source_revision DESC LIMIT 1)a ON true
       LEFT JOIN mission_projection_views v ON v.tenant_id=m.tenant_id AND v.mission_id=m.id
       LEFT JOIN work_items w ON w.tenant_id=m.tenant_id AND w.event_id=a.id WHERE m.tenant_id=$1 AND m.flight_id=$2`,
      [principal.tenantId, flightId],
    )
  ).rows[0];
  let mission: MissionRevisionRecord | null = null;
  let missionReference: MissionAvoidanceMissionReference | null = null;
  let reviewed: ReviewedControls = {
    candidates: [],
    notApplicable: [],
    circles: [],
    considered: [],
    candidateContexts: [],
    notApplicableContexts: [],
    reasons: [],
  };
  const nextBoundary = await nextAcceptedControlBoundary(client, principal.tenantId, evaluatedAt);
  let complete = false;
  let count = 0;
  let considered = 0;
  const consideredTypes = areaControlTypes();
  const reasons: string[] = [];
  if (!head) reasons.push('mission_missing');
  else if (Number(head.byte_length) > RECORD_BYTES_LIMIT) reasons.push('record_budget_exceeded');
  else {
    mission = (
      await client.query<{ record: MissionRevisionRecord }>(
        'SELECT record FROM mission_revisions WHERE tenant_id=$1 AND id=$2',
        [principal.tenantId, head.id],
      )
    ).rows[0].record;
    missionReference = missionReferenceFor(mission);
    if (!missionReference || !supportedMission(mission, flightId)) reasons.push('unsupported_mission');
    else if (head.id !== head.projected_id || head.state !== 'completed') reasons.push('mission_projection_pending');
    else {
      const read = await acceptedAreaControls(
        client,
        principal.tenantId,
        mission.operatingInterval,
        Number(head.byte_length),
      );
      considered = read.count;
      if (!read.complete) reasons.push(read.reason);
      else {
        const review = reviewConsideredControls(read.controls, mission, missionReference);
        count = review.count;
        if (!review.complete) reasons.push(review.reason);
        else {
          complete = true;
          reviewed = review;
          reasons.push(...reviewed.reasons);
        }
      }
    }
  }
  const { candidates, notApplicable } = reviewed;
  const candidateCompleteness: MissionAvoidancePreview['candidateCompleteness'] = {
    status: complete ? ('complete' as const) : ('incomplete' as const),
    count,
    limit: MISSION_AVOIDANCE_CANDIDATE_LIMIT,
    considered,
    consideredLimit: MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  };
  const calculation = { id: calculationMeta.id, version: calculationMeta.version, digest: calculationMeta.digest };
  const contextDigest =
    missionReference && complete
      ? missionAvoidanceContextDigest({
          mission: missionReference,
          calculation,
          candidates,
          notApplicable,
          consideredTypes,
          candidateCompleteness,
        })
      : null;
  const status =
    !complete ||
    reasons.length ||
    candidates.some((candidate) => candidate.context !== 'current' || candidate.geometry === 'insufficient')
      ? ('insufficient' as const)
      : candidates.some((candidate) => candidate.geometry === 'intersects')
        ? ('intersects' as const)
        : ('outside' as const);
  const preview: Omit<MissionAvoidancePreview, 'previewDigest'> = {
    version: 'flight.mission-avoidance.1',
    evaluatedAt,
    status,
    mission: missionReference,
    candidates,
    notApplicable,
    consideredTypes,
    candidateCompleteness,
    calculation: { ...calculationMeta },
    contextDigest,
    reasons,
  };
  return {
    preview: { ...preview, previewDigest: canonicalDigest(preview) },
    mission,
    circles: reviewed.circles,
    consideredCircles: reviewed.considered.map((control) => control.circle),
    candidateContexts: reviewed.candidateContexts,
    notApplicableContexts: reviewed.notApplicableContexts,
    nextBoundary,
  };
}

interface EvaluatedControl extends AcceptedAreaControl {
  applicability: MissionAvoidanceReviewedCandidate['applicability'];
  applicabilityDigest: string;
}

export interface ReviewedControls {
  candidates: MissionAvoidanceReviewedCandidate[];
  notApplicable: MissionAvoidanceNotApplicable[];
  circles: MissionAvoidanceSnapshot['circles'];
  considered: AcceptedAreaControl[];
  candidateContexts: ControlRecordContextEntry[];
  notApplicableContexts: ControlRecordContextEntry[];
  reasons: string[];
}

/**
 * Each considered control evaluated by the applicability rule its pinned type declares, for the exact mission
 * revision. A control whose safety context is not current applies until a person signs again.
 */
function reviewControls(
  controls: AcceptedAreaControl[],
  mission: MissionRevisionRecord,
  reference: MissionAvoidanceMissionReference,
): { applying: EvaluatedControl[]; notApplying: EvaluatedControl[]; considered: AcceptedAreaControl[] } {
  const applying: EvaluatedControl[] = [];
  const notApplying: EvaluatedControl[] = [];
  for (const control of controls) {
    const { candidate } = control;
    const { record, digest } = evaluateControlApplicability(
      candidate.template,
      control.parameters,
      { mission },
      {
        mission: reference,
        control: {
          controlId: candidate.controlId,
          versionNumber: candidate.controlVersion,
          controlEventId: candidate.controlEventId,
          bodyDigest: candidate.controlDigest,
        },
        reviewRequired: candidate.context !== 'current',
      },
    );
    (record.outcome === 'applies' ? applying : notApplying).push({
      ...control,
      applicability: record,
      applicabilityDigest: digest,
    });
  }
  return { applying, notApplying, considered: controls };
}

const contextEntry = ({ candidate, safetyContext }: AcceptedAreaControl): ControlRecordContextEntry => ({
  controlEventId: candidate.controlEventId,
  acceptanceId: candidate.acceptance.id,
  context: safetyContext,
});

/**
 * Route review of the considered controls for one exact mission revision: each is evaluated by its applicability rule,
 * those that apply (at most 64) are compared with the route as candidates, and those that do not are listed with their
 * applicability records. Plain computation: it reads nothing and takes no lock.
 */
export function reviewConsideredControls(
  controls: AcceptedAreaControl[],
  mission: MissionRevisionRecord,
  reference: MissionAvoidanceMissionReference,
): (ReviewedControls & { complete: true; count: number }) | { complete: false; count: number; reason: string } {
  const split = reviewControls(controls, mission, reference);
  const count = split.applying.length;
  if (count > MISSION_AVOIDANCE_CANDIDATE_LIMIT) return { complete: false, count, reason: 'candidate_limit_exceeded' };
  return { ...compareCandidates(split, mission), complete: true, count };
}

/** The controls that apply compared with the route; those that do not are listed with their records. */
function compareCandidates(split: ReturnType<typeof reviewControls>, mission: MissionRevisionRecord): ReviewedControls {
  const circles = split.applying.map((control) => control.circle);
  const geometry = evaluateMissionAvoidanceGeometry({ mission, circles });
  return {
    candidates: split.applying.map(({ candidate, applicability, applicabilityDigest }, index) => {
      const result = geometry.results[index]!;
      return {
        ...candidate,
        geometry: candidate.context === 'unsupported' ? 'insufficient' : result.verdict,
        reasons: [...new Set([...candidate.reasons, ...result.reasons])],
        applicability,
        applicabilityDigest,
      };
    }),
    notApplicable: split.notApplying.map(({ candidate, title, parameters, applicability, applicabilityDigest }) => ({
      ...candidate,
      title,
      area: describedArea(candidate.template, parameters),
      applicability,
      applicabilityDigest,
    })),
    circles,
    considered: split.considered,
    candidateContexts: split.applying.map(contextEntry),
    notApplicableContexts: split.notApplying.map(contextEntry),
    reasons: geometry.reasons,
  };
}

/**
 * The circle a control's pinned type describes for its parameters, as a screen places it without reading the control;
 * null when the type describes none or its answer cannot be read.
 */
function describedArea(
  template: MissionAvoidanceCandidate['template'],
  parameters: unknown,
): MissionAvoidanceNotApplicableArea | null {
  let area;
  try {
    area = controlArea(template, parameters as Record<string, unknown>);
  } catch {
    return null;
  }
  if (!area) return null;
  const [latitude, longitude, radiusMeters] = [area.center?.latitude, area.center?.longitude, area.radiusMeters];
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (
    !finite(latitude) ||
    !finite(longitude) ||
    !finite(radiusMeters) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    radiusMeters <= 0
  )
    return null;
  return { center: { latitude, longitude }, radiusMeters };
}

export async function getMissionAvoidance(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
): Promise<MissionAvoidanceResponse> {
  const { preview } = await getMissionAvoidanceSnapshot(client, principal, flightId, true);
  return {
    ...preview,
    meta: await responseMeta(client, '', principal, undefined, flightId),
  };
}
