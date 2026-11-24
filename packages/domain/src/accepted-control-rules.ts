import { randomUUID } from 'node:crypto';
import {
  ACCEPTED_CONTROL_PACK_ID,
  subjectReferenceKey,
  type CheckedRuleLeaf,
  type ControlBody,
  type PackAdoptionAcceptance,
  type RulePackVersion,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { organization } from './adoptions.js';
import { findCheckKind } from './check-kinds.js';
import { checkedPackProblem, defineCheckedRule } from './checked-rules.js';
import { controlRules, describeControl } from './control-types.js';
import { readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import { enqueueRuleSelectionFanout } from './rule-selections.js';

export { ACCEPTED_CONTROL_PACK_ID };

/**
 * An accepted control version bound by its open hazard's latest acceptance and not withdrawn. It is in force while
 * its effective interval [effectiveFrom, effectiveUntil) holds.
 */
export interface ControlInForce {
  hazardId: string;
  hazardTitle: string;
  controlId: string;
  versionNumber: number;
  /** The control version's event, and the hazard acceptance that binds it. */
  controlEventId: string;
  acceptanceId: string;
  bodyDigest: string;
  title: string;
  body: ControlBody;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

interface ControlInForceRow {
  hazard_id: string;
  hazard_title: string;
  control_id: string;
  control_version_number: number;
  control_event_id: string;
  acceptance_id: string;
  control_body_digest: string;
  title: string;
  body: ControlBody;
  effective_from: Date;
  effective_until: Date | null;
}

interface AdoptionRow {
  id: string;
  record: PackAdoptionAcceptance;
}

const ADOPTION_END = '9999-12-31T00:00:00.000Z';
const POLICY_VERSION = 'ledger.accepted-control-rules.1';
const BOUNDARY_POLICY_VERSION = 'ledger.accepted-control-interval.1';

/** Every accepted control version bound and not withdrawn, whatever its interval, ordered by control id. */
export async function acceptedControls(client: PoolClient, tenantId: string): Promise<ControlInForce[]> {
  const rows = await client.query<ControlInForceRow>(
    `SELECT a.hazard_id,hv.title AS hazard_title,a.control_id,a.control_version_number,v.id AS control_event_id,
      a.acceptance_id,a.control_body_digest,v.title,v.body,a.effective_from,a.effective_until
     FROM accepted_hazard_controls a
     JOIN sms_records h ON h.tenant_id=a.tenant_id AND h.id=a.hazard_id AND h.latest_acceptance_id=a.acceptance_id
     JOIN sms_record_versions hv ON hv.tenant_id=h.tenant_id AND hv.record_id=h.id AND hv.version_number=h.version_number
     JOIN sms_records c ON c.tenant_id=a.tenant_id AND c.id=a.control_id
     JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
      AND v.version_number=a.control_version_number AND v.body_digest=a.control_body_digest
     WHERE a.tenant_id=$1 AND h.status<>'closed' AND c.status<>'closed'
     ORDER BY a.control_id COLLATE "C"`,
    [tenantId],
  );
  return rows.rows.map((row) => ({
    hazardId: row.hazard_id,
    hazardTitle: row.hazard_title,
    controlId: row.control_id,
    versionNumber: row.control_version_number,
    controlEventId: row.control_event_id,
    acceptanceId: row.acceptance_id,
    bodyDigest: row.control_body_digest,
    title: row.title,
    body: row.body,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveUntil: row.effective_until?.toISOString() ?? null,
  }));
}

/** Where the instant falls in a control's effective interval. */
export function controlPeriod(
  control: Pick<ControlInForce, 'effectiveFrom' | 'effectiveUntil'>,
  at: string,
): 'upcoming' | 'current' | 'ended' {
  if (Date.parse(at) < Date.parse(control.effectiveFrom)) return 'upcoming';
  if (control.effectiveUntil !== null && Date.parse(at) >= Date.parse(control.effectiveUntil)) return 'ended';
  return 'current';
}

/**
 * The instants after `after` at which an accepted control's effective interval starts or ends, ascending and
 * distinct. At each of them the set of controls in force changes without any new decision.
 */
export function acceptedControlBoundaries(
  controls: readonly Pick<ControlInForce, 'effectiveFrom' | 'effectiveUntil'>[],
  after: number,
): string[] {
  const instants = new Map<number, string>();
  for (const control of controls)
    for (const at of [control.effectiveFrom, control.effectiveUntil])
      if (at !== null && Date.parse(at) > after && !instants.has(Date.parse(at))) instants.set(Date.parse(at), at);
  return [...instants].sort(([left], [right]) => left - right).map(([, at]) => at);
}

/**
 * The earliest instant after `after` at which one of the organization's accepted controls starts or stops being in
 * force, or null when none does: what was read about the controls holds no longer than this. The same instants the
 * worker reassembles the organization's rules at.
 */
export async function nextAcceptedControlBoundary(
  client: PoolClient,
  tenantId: string,
  after: string,
): Promise<string | null> {
  return acceptedControlBoundaries(await acceptedControls(client, tenantId), Date.parse(after))[0] ?? null;
}

/** Every accepted control version in force at the instant, ordered by control id. */
export async function controlsInForce(client: PoolClient, tenantId: string, at: string): Promise<ControlInForce[]> {
  return (await acceptedControls(client, tenantId)).filter((control) => controlPeriod(control, at) === 'current');
}

/** The id of the rule one accepted control gives for one target kind; the same for every version of the control. */
export function acceptedControlLeafId(controlId: string, subjectKind: string): string {
  return `ledger.accepted-control.${controlId}.${subjectKind}`;
}

/** The reference a rule's source gives: the exact control version it quotes. */
export function acceptedControlReference(control: Pick<ControlInForce, 'controlId' | 'versionNumber' | 'bodyDigest'>) {
  return `Accepted control ${control.controlId} version ${control.versionNumber}, body ${control.bodyDigest}`;
}

/**
 * The checked rules one accepted control becomes, as its registered type declares them: none for a type that
 * declares no rule or is not registered here. Each quotes the control's own wording.
 */
export function acceptedControlLeaves(control: ControlInForce): CheckedRuleLeaf[] {
  const { controlType, parameters } = control.body;
  const declarations = controlRules(controlType, parameters);
  const wording = describeControl(controlType, parameters);
  if (!declarations?.length || wording === undefined) return [];
  return declarations.map((declaration) => {
    const kind = findCheckKind(declaration.check.kind, declaration.check.version);
    if (!kind)
      throw new DomainError(
        409,
        'control_rule_unavailable',
        `The control “${control.title}” names check kind ${declaration.check.kind} version ${declaration.check.version}, which is not registered here`,
      );
    return defineCheckedRule({
      id: acceptedControlLeafId(control.controlId, declaration.target.subjectKind),
      version: control.versionNumber,
      title: control.title.slice(0, 200),
      source: { kind: 'operator_procedure', reference: acceptedControlReference(control), text: wording },
      target: { ...declaration.target },
      reads: structuredClone(declaration.reads),
      check: { kind, params: structuredClone(declaration.check.params) },
      ...(declaration.applicability ? { applicability: structuredClone(declaration.applicability) } : {}),
      ...(declaration.wording ? { wording: { ...declaration.wording } } : {}),
    });
  });
}

const byId = (left: CheckedRuleLeaf, right: CheckedRuleLeaf) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** One version of the accepted-controls pack holding exactly these rules, ordered by id. */
export function acceptedControlPack(version: number, leaves: readonly CheckedRuleLeaf[]): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: ACCEPTED_CONTROL_PACK_ID,
    version,
    title: 'Accepted controls',
    status: 'assembled',
    review: 'accepted_and_signed',
    adopted: false,
    bindings: [],
    leaves: [...leaves].sort(byId),
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  const problem = checkedPackProblem(pack);
  if (problem) throw new DomainError(409, 'control_rule_unavailable', problem);
  return pack;
}

/** The latest adoption of the accepted-controls pack, or undefined before the first. */
export async function latestAcceptedControlAdoption(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
): Promise<AdoptionRow | undefined> {
  return (
    await client.query<AdoptionRow>(
      `SELECT id,record FROM organization_pack_adoptions WHERE tenant_id=$1 AND organization_id=$2 AND pack_id=$3
       ORDER BY accepted_revision DESC LIMIT 1`,
      [tenantId, organizationId, ACCEPTED_CONTROL_PACK_ID],
    )
  ).rows[0];
}

function sameLeaves(left: readonly CheckedRuleLeaf[], right: readonly CheckedRuleLeaf[]): boolean {
  const digests = (leaves: readonly CheckedRuleLeaf[]) => leaves.map((leaf) => leaf.digest).sort();
  return canonicalDigest(digests(left)) === canonicalDigest(digests(right));
}

/** What reassembles the accepted-controls pack: a safety decision, or an instant at which an accepted control's
 * effective interval starts or ends. */
export type AcceptedControlCause =
  { id: string; checkedCapabilities: string[] } | { boundaryAt: string; scheduledBy: string };

function adoptionActor(
  actor: AuthContext & { kind: string },
  cause: AcceptedControlCause,
): PackAdoptionAcceptance['actor'] {
  const who = {
    id: actor.id,
    name: actor.name,
    kind: actor.kind,
    principalRevision: actor.revision,
    capabilities: [...actor.capabilities],
  };
  return 'boundaryAt' in cause
    ? {
        ...who,
        checkedCapabilities: [],
        policyVersion: BOUNDARY_POLICY_VERSION,
        boundaryAt: cause.boundaryAt,
        scheduledBy: cause.scheduledBy,
      }
    : {
        ...who,
        checkedCapabilities: [...cause.checkedCapabilities],
        policyVersion: POLICY_VERSION,
        decisionId: cause.id,
      };
}

/**
 * Assembles the organization's rules from the accepted controls in force now, in the caller's transaction: after a
 * safety decision that may change them, or at an instant where an accepted control's interval starts or ends. When
 * they differ from the latest version, the next version is adopted in active mode from now, revising the previous
 * one. History is never rewritten.
 */
export async function refreshAcceptedControlRules(
  client: PoolClient,
  actor: AuthContext & { kind: string },
  cause: AcceptedControlCause,
): Promise<void> {
  const org = await organization(client, actor.tenantId, 'UPDATE');
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const leaves = (await controlsInForce(client, actor.tenantId, now)).flatMap(acceptedControlLeaves);
  const latest = await latestAcceptedControlAdoption(client, actor.tenantId, org.id);
  if (latest ? sameLeaves(latest.record.pack.leaves as CheckedRuleLeaf[], leaves) : !leaves.length) return;
  const pack = acceptedControlPack((latest?.record.pack.version ?? 0) + 1, leaves);
  const revision = Number(org.revision);
  const evidence = await readSubjectEvidence(client, org.id, actor, { lock: true });
  const acceptance: Omit<PackAdoptionAcceptance, 'id' | 'acceptedAt'> = {
    organizationId: org.id,
    acceptedRevision: revision + 1,
    actor: adoptionActor(actor, cause),
    pack,
    scope: { kind: 'organization', organizationId: org.id },
    effectiveInterval: { start: now, end: ADOPTION_END },
    note:
      'boundaryAt' in cause
        ? `Version ${pack.version} of the rules from the accepted controls, at ${cause.boundaryAt}, where an accepted control's effective interval starts or ends.`
        : `Version ${pack.version} of the rules from the accepted controls, after safety decision ${cause.id}.`,
    mode: 'active',
    ...(latest ? { revises: latest.id } : {}),
    renderedInputCut: { ...evidence.rendered, basisRevision: revision },
    acceptedInputCut: { ...evidence.accepted, basisRevision: revision },
    dependencyBasis: evidence.dependencyBasis,
  };
  const event = await appendEvent(client, actor, {
    id: randomUUID(),
    type: 'rule-pack.adopt',
    stream: org.id,
    causationId: 'boundaryAt' in cause ? cause.scheduledBy : cause.id,
    payload: { kind: 'rule-pack.adopt', acceptance },
  });
  await client.query(
    `INSERT INTO organization_pack_adoptions(id,tenant_id,organization_id,accepted_revision,pack_id,effective_start,
       effective_end,mode,revises_id,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event.id,
      actor.tenantId,
      org.id,
      acceptance.acceptedRevision,
      pack.packId,
      acceptance.effectiveInterval.start,
      acceptance.effectiveInterval.end,
      'active',
      latest?.id ?? null,
      { ...acceptance, id: event.id, acceptedAt: event.received_at.toISOString() },
    ],
  );
  await client.query('UPDATE organizations SET revision=$1 WHERE tenant_id=$2 AND id=$3', [
    acceptance.acceptedRevision,
    actor.tenantId,
    org.id,
  ]);
  await retainSubjectEvidence(client, actor.tenantId, [org.id], event);
  await enqueueRuleSelectionFanout(client, actor.tenantId, org.id, event.id, 'accepted');
}

const CHANGING_DECISIONS = ['risk.accept', 'record.close', 'record.reopen'];

/**
 * Once a safety decision that may change the accepted controls is projected, queues a reassembly of the pack at
 * every later instant where a bound control's effective interval starts or ends. The work waits in the generic
 * evaluator's queue until it is due, so any worker keeps it; one row per organization and instant, whichever
 * decision queued it first.
 */
export async function scheduleAcceptedControlBoundaries(client: PoolClient, event: JournalEvent): Promise<void> {
  const payload = event.payload as { subject?: { kind?: string }; decision?: { kind?: string } };
  if (
    event.event_type !== 'decision.record' ||
    payload.subject?.kind !== 'sms' ||
    !CHANGING_DECISIONS.includes(payload.decision?.kind ?? '')
  )
    return;
  const instants = acceptedControlBoundaries(
    await acceptedControls(client, event.tenant_id),
    event.received_at.getTime(),
  );
  if (!instants.length) return;
  const org = (await client.query<{ id: string }>('SELECT id FROM organizations WHERE tenant_id=$1', [event.tenant_id]))
    .rows[0];
  if (!org) return;
  const subject = { scope: 'ledger' as const, kind: 'organization' as const, id: org.id };
  for (const at of instants)
    await client.query(
      `INSERT INTO rule_evaluation_work(id,tenant_id,subject_key,subject_scope,subject_kind,subject_id,pack_id,leaf_id,
         trigger_kind,trigger_event_id,due_at,available_at)
       VALUES($1,$2,$3,'ledger','organization',$4,$5,$5,'control-boundary',$6,$7,$7) ON CONFLICT DO NOTHING`,
      [randomUUID(), event.tenant_id, subjectReferenceKey(subject), org.id, ACCEPTED_CONTROL_PACK_ID, event.id, at],
    );
}
