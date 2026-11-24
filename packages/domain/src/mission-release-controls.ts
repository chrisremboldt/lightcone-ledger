import {
  ACCEPTED_CONTROL_PACK_ID,
  FLIGHT_CONTROL_LIMIT,
  isCheckedRuleLeaf,
  type CheckedRuleLeaf,
  MISSION_AVOIDANCE_CONSIDERED_LIMIT,
  type FlightControl,
  type FlightControlNotApplicable,
  type FlightControlResult,
  type FlightControlsResponse,
  type FlightControlsSeen,
  type MissionAvoidanceNotApplicable,
  type MissionAvoidanceReviewedCandidate,
  type MissionReleaseFindingSubject,
  type PackAdoptionAcceptance,
  type RuleEvaluationRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import {
  acceptedControlLeafId,
  acceptedControls,
  controlPeriod,
  type ControlInForce,
} from './accepted-control-rules.js';
import { controlCheck, controlRules, controlWording, describeControl, findControlType } from './control-types.js';
import { getMissionAvoidanceSnapshot, type MissionAvoidanceSnapshot } from './mission-avoidance.js';
import { findingSubjects } from './mission-release-findings.js';

// What release, briefing and departure show for the controls in scope for a flight: each accepted control in force,
// in its own words, with its current result. The subjects in scope are the ones a release reads findings about.

interface Context {
  tenantId: string;
  readAt: string;
  subjects: MissionReleaseFindingSubject[];
  pack: PackAdoptionAcceptance['pack'] | undefined;
  avoidance: () => Promise<MissionAvoidanceSnapshot>;
}

/** The accepted-controls pack version in effect and projected at the instant, as the evaluator reads it. */
async function packInEffect(client: PoolClient, tenantId: string, at: string) {
  return (
    await client.query<{ record: PackAdoptionAcceptance }>(
      `SELECT a.record FROM organization_pack_adoptions a
       JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
       WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.pack_id=$3
        AND a.effective_start<=$4::timestamptz AND a.effective_end>$4::timestamptz
       ORDER BY a.accepted_revision DESC LIMIT 1`,
      [tenantId, `organization:${tenantId}`, ACCEPTED_CONTROL_PACK_ID, at],
    )
  ).rows[0]?.record.pack;
}

/** The latest evaluation of one rule for each subject key, without related subjects. */
async function latestEvaluations(
  client: PoolClient,
  tenantId: string,
  leafId: string,
  keys: string[],
): Promise<Map<string, RuleEvaluationRecord>> {
  const rows = await client.query<{ subject_key: string; record: RuleEvaluationRecord }>(
    `SELECT DISTINCT ON(subject_key) subject_key,record FROM rule_evaluations
     WHERE tenant_id=$1 AND pack_id=$2 AND leaf_id=$3 AND subject_key=ANY($4::text[]) AND related_key=''
     ORDER BY subject_key,recorded_at DESC,id DESC`,
    [tenantId, ACCEPTED_CONTROL_PACK_ID, leafId, keys],
  );
  return new Map(rows.rows.map((row) => [row.subject_key, row.record]));
}

function evaluated(record: RuleEvaluationRecord, leaf: CheckedRuleLeaf, packVersion: number): FlightControlResult {
  const result: FlightControlResult['result'] =
    record.outcome === 'pending'
      ? 'insufficient'
      : // The accepted-controls pack is never registered, so no waiver can name it to relieve.
        record.outcome === 'not_applicable' || record.outcome === 'relieved'
        ? 'not_applicable'
        : record.outcome;
  return {
    result,
    summary: record.summary,
    subject: record.subject,
    subjectKey: record.subjectKey,
    rule: { packId: ACCEPTED_CONTROL_PACK_ID, packVersion, id: leaf.id, version: leaf.version, digest: leaf.digest },
    evaluation: { id: record.id, digest: canonicalDigest(record), recordedAt: record.recordedAt },
  };
}

/** One result per subject in scope of each rule the control's type declares, from the rule's latest evaluation. */
async function ruleResults(client: PoolClient, context: Context, control: ControlInForce) {
  const results: FlightControlResult[] = [];
  const leaves = (context.pack?.leaves ?? []).filter(isCheckedRuleLeaf);
  for (const declaration of controlRules(control.body.controlType, control.body.parameters) ?? []) {
    const kind = declaration.target.subjectKind;
    const inScope = context.subjects.filter(
      ({ subject }) =>
        subject.kind === kind && (!declaration.subjectIds || declaration.subjectIds.includes(subject.id)),
    );
    if (!inScope.length) {
      if (!declaration.subjectIds)
        results.push({
          result: 'insufficient',
          summary: `This flight’s records name no ${kind} for this rule to read.`,
        });
      continue;
    }
    const leafId = acceptedControlLeafId(control.controlId, kind);
    const leaf = leaves.find((candidate) => candidate.id === leafId && candidate.version === control.versionNumber);
    const latest = leaf
      ? await latestEvaluations(
          client,
          context.tenantId,
          leafId,
          inScope.map((item) => item.subjectKey),
        )
      : new Map<string, RuleEvaluationRecord>();
    for (const { subject, subjectKey } of inScope) {
      const record = latest.get(subjectKey);
      if (leaf && record?.rule.digest === leaf.digest) results.push(evaluated(record, leaf, context.pack!.version));
      else
        results.push({
          result: 'insufficient',
          summary: leaf
            ? 'This version of the control has not been evaluated for this subject yet.'
            : 'The rule for this version of the control is not in effect yet; its acceptance is still being processed.',
          subject,
          subjectKey,
        });
    }
  }
  return results;
}

/** What a result shows of an applicability record: the record itself is pinned by its digest. */
function shownApplicability(
  entry: MissionAvoidanceReviewedCandidate | MissionAvoidanceNotApplicable,
): NonNullable<FlightControlResult['applicability']> {
  const { outcome, basis, measured } = entry.applicability;
  return { outcome, basis, measured, digest: entry.applicabilityDigest };
}

/** Route review's result for an area control on the flight's planned route. */
async function routeResult(context: Context, control: ControlInForce): Promise<FlightControlResult> {
  const { mission, preview } = await context.avoidance();
  if (!mission)
    return {
      result: 'insufficient',
      summary: 'No planned route is recorded for this flight, so route review has none.',
    };
  const isControl = (item: { hazardId: string; controlId: string; controlVersion: number }) =>
    item.hazardId === control.hazardId &&
    item.controlId === control.controlId &&
    item.controlVersion === control.versionNumber;
  const excluded = preview.notApplicable.find(isControl);
  if (excluded)
    return {
      result: 'not_applicable',
      summary: excluded.applicability.summary,
      applicability: shownApplicability(excluded),
    };
  const candidate = preview.candidates.find(isControl);
  if (!candidate)
    return preview.candidateCompleteness.status === 'complete'
      ? { result: 'not_applicable', summary: 'The control is not in effect during the planned operating interval.' }
      : { result: 'insufficient', summary: 'Route review has not finished reading the accepted area controls.' };
  const applicability = shownApplicability(candidate);
  if (candidate.geometry === 'intersects')
    return { result: 'attention', summary: 'The planned route meets this area.', applicability };
  if (candidate.geometry === 'outside' && candidate.context === 'current')
    return { result: 'pass', summary: 'The planned route keeps clear of this area.', applicability };
  return {
    result: 'insufficient',
    summary: `Route review cannot confirm the planned route against this area${candidate.reasons.length ? ` (${candidate.reasons.join(', ')})` : ''}.`,
    applicability,
  };
}

/** A control outside its effective interval is listed with when it starts or ended, and is not evaluated. */
function outsideInterval(control: ControlInForce, period: 'upcoming' | 'ended'): FlightControlResult[] {
  return [
    {
      result: 'not_applicable',
      summary:
        period === 'upcoming'
          ? `This control takes effect on ${control.effectiveFrom}; it is not evaluated before then.`
          : `This control’s interval ended on ${control.effectiveUntil}; it is no longer evaluated.`,
    },
  ];
}

/** Whether a control that lists its subjects names one this flight's records name. */
function listsSubjectInScope(context: Context, control: ControlInForce): boolean {
  const declarations = controlRules(control.body.controlType, control.body.parameters) ?? [];
  return declarations.some(
    (declaration) =>
      !declaration.subjectIds ||
      context.subjects.some(
        ({ subject }) =>
          subject.kind === declaration.target.subjectKind && declaration.subjectIds!.includes(subject.id),
      ),
  );
}

async function currentResults(client: PoolClient, context: Context, control: ControlInForce, check: string) {
  if (check === 'rule') return ruleResults(client, context, control);
  if (check === 'route_review') return [await routeResult(context, control)];
  return [
    {
      result: 'needs_confirmation' as const,
      summary: 'Nothing checks this control automatically; a person confirms it.',
    },
  ];
}

async function listed(client: PoolClient, context: Context, control: ControlInForce): Promise<FlightControl | null> {
  const { controlType, parameters, effectiveFrom, effectiveUntil } = control.body;
  const check = controlCheck(controlType) ?? 'person';
  const period = controlPeriod(control, context.readAt);
  if (period !== 'current' && check === 'rule' && !listsSubjectInScope(context, control)) return null;
  // Route review judges an area control by the flight's planned operating interval, not by the clock at this read:
  // a flight planned for next week is reviewed against the controls in effect then. With a planned route, the list
  // says what route review found, so the two cannot disagree; without one, the clock is all there is.
  const reviewed = check === 'route_review' && Boolean((await context.avoidance()).mission);
  const results =
    period === 'current' || reviewed
      ? await currentResults(client, context, control, check)
      : outsideInterval(control, period);
  // A control that lists its subjects is in scope only for a flight whose records name one of them.
  if (!results.length) return null;
  return {
    hazard: { id: control.hazardId, title: control.hazardTitle },
    control: {
      id: control.controlId,
      versionNumber: control.versionNumber,
      bodyDigest: control.bodyDigest,
      title: control.title,
      type: { ...controlType, title: findControlType(controlType.id, controlType.version)?.title ?? null },
      description: describeControl(controlType, parameters) ?? control.title,
      effectiveFrom,
      effectiveUntil: effectiveUntil ?? null,
      period,
    },
    check,
    results,
  };
}

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The accepted controls in force that are in scope for a flight, each with its current result. A read at REPEATABLE
 * READ passes `reading`, so a route review takes no lock on the flight or the register.
 */
export async function getFlightControls(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  reading = false,
): Promise<FlightControlsResponse> {
  const flight = await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2', [
    principal.tenantId,
    flightId,
  ]);
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const readAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const tenantId = principal.tenantId;
  let snapshot: Promise<MissionAvoidanceSnapshot> | undefined;
  const context: Context = {
    tenantId,
    readAt,
    subjects: await findingSubjects(client, tenantId, flightId, `organization:${tenantId}`),
    pack: await packInEffect(client, tenantId, readAt),
    avoidance: () => (snapshot ??= getMissionAvoidanceSnapshot(client, principal, flightId, reading)),
  };
  // Grouped by hazard, then by control title, as a person reads them.
  const inForce = (await acceptedControls(client, tenantId)).sort(
    (left, right) =>
      byText(left.hazardTitle, right.hazardTitle) ||
      byText(left.hazardId, right.hazardId) ||
      byText(left.title, right.title) ||
      byText(left.controlId, right.controlId),
  );
  const controls: FlightControl[] = [];
  const notApplicable: FlightControlNotApplicable[] = [];
  for (const control of inForce) {
    const item = await listed(client, context, control);
    if (!item) continue;
    const compact = notApplying(item);
    if (compact) notApplicable.push(compact);
    else controls.push(item);
    if (controls.length > FLIGHT_CONTROL_LIMIT || notApplicable.length > MISSION_AVOIDANCE_CONSIDERED_LIMIT) break;
  }
  // The mission revision route review read for this list: every applicability record in it names it.
  const mission = snapshot ? (await snapshot).preview.mission : null;
  const seen = {
    controls: controls.slice(0, FLIGHT_CONTROL_LIMIT),
    notApplicable: notApplicable.slice(0, MISSION_AVOIDANCE_CONSIDERED_LIMIT),
    complete: controls.length <= FLIGHT_CONTROL_LIMIT && notApplicable.length <= MISSION_AVOIDANCE_CONSIDERED_LIMIT,
    mission,
  };
  return {
    flightId,
    readAt,
    ...seen,
    digest: flightControlsDigest(seen),
    wording: shownWording(inForce, seen.controls),
  };
}

/**
 * A control route review recorded as not applying, in the list's compact part: its identity, title, applicability and
 * the recorded sentence. Its wording and parameters are in the control version its body digest names.
 */
function notApplying(item: FlightControl): FlightControlNotApplicable | undefined {
  const [result] = item.results;
  if (
    item.check !== 'route_review' ||
    item.results.length !== 1 ||
    result!.result !== 'not_applicable' ||
    result!.applicability?.outcome !== 'does_not_apply'
  )
    return undefined;
  const { id, versionNumber, bodyDigest, title } = item.control;
  return {
    hazardId: item.hazard.id,
    control: { id, versionNumber, bodyDigest, title },
    applicability: result!.applicability,
    summary: result!.summary,
  };
}

/** Each listed control version in its type's words for a person, by body digest; beside the list, never digested. */
function shownWording(inForce: readonly ControlInForce[], shown: readonly FlightControl[]): Record<string, string> {
  const listed = new Set(shown.map((item) => item.control.bodyDigest));
  const wording: Record<string, string> = {};
  for (const control of inForce) {
    if (!listed.has(control.bodyDigest)) continue;
    const words = controlWording(control.body.controlType, control.body.parameters);
    if (words !== undefined) wording[control.bodyDigest] = words;
  }
  return wording;
}

const SEEN_VERSION = 'flight.controls-seen.1';

/** Whether a retained controls section has its shape and its digest reproduces from what it holds. */
export function isFlightControlsSeen(seen: unknown): seen is FlightControlsSeen {
  if (seen === null || typeof seen !== 'object' || Array.isArray(seen)) return false;
  const section = seen as Partial<FlightControlsSeen>;
  return (
    Object.keys(section).sort().join() === 'complete,controls,digest,mission,notApplicable,version' &&
    section.version === SEEN_VERSION &&
    Array.isArray(section.controls) &&
    section.controls.length <= FLIGHT_CONTROL_LIMIT &&
    Array.isArray(section.notApplicable) &&
    section.notApplicable.length <= MISSION_AVOIDANCE_CONSIDERED_LIMIT &&
    typeof section.complete === 'boolean' &&
    (section.mission === null || (typeof section.mission === 'object' && !Array.isArray(section.mission))) &&
    section.digest === flightControlsDigest(section as FlightControlsSeen)
  );
}

/** The digest a briefing or departure command pins: of the list as shown, without the instant it was read. */
export function flightControlsDigest(
  seen: Pick<FlightControlsSeen, 'controls' | 'notApplicable' | 'complete' | 'mission'>,
): string {
  return canonicalDigest({
    version: SEEN_VERSION,
    controls: seen.controls,
    notApplicable: seen.notApplicable,
    complete: seen.complete,
    mission: seen.mission,
  });
}

/** The list a command pins when no control is in scope for the flight. */
export function noControlsSeen(): FlightControlsSeen {
  const seen = { controls: [], notApplicable: [], complete: true, mission: null };
  return { version: SEEN_VERSION, ...seen, digest: flightControlsDigest(seen) };
}

/**
 * The controls in scope as the command's author saw them, read again inside the command's transaction. A changed
 * list conflicts, as a release's changed findings do.
 */
export async function pinFlightControls(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  expectedDigest: string,
): Promise<FlightControlsSeen> {
  const { controls, notApplicable, complete, mission, digest } = await getFlightControls(client, principal, flightId);
  if (digest !== expectedDigest)
    throw new DomainError(
      409,
      'flight_controls_changed',
      'The controls in scope for this flight changed; review them again',
      {
        controlsDigest: digest,
      },
    );
  return { version: SEEN_VERSION, controls, notApplicable, complete, mission, digest };
}

/**
 * What a briefing or departure pins: the list its author saw when the command names its digest. A command that names
 * none is refused while any control is in scope for the flight, since the record would not say which the person saw;
 * with none in scope there is nothing to pin.
 */
export async function controlsSeenForCommand(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  expectedDigest: string | undefined,
): Promise<FlightControlsSeen | undefined> {
  if (expectedDigest) return pinFlightControls(client, principal, flightId, expectedDigest);
  const { controls, notApplicable } = await getFlightControls(client, principal, flightId);
  if (controls.length || notApplicable.length)
    throw new DomainError(
      409,
      'flight_controls_not_seen',
      'Controls are in scope for this flight; read them and send the digest of the list you reviewed',
    );
  return undefined;
}
