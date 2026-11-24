import { randomUUID } from 'node:crypto';
import { FINDING_SET_LIMIT, type FindingSetTreatmentCommand } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { insertFindingTreatment, requireAssignee, requirePerson, treatmentShapeProblem } from './finding-work.js';
import { aboutBounds, findingAboutAt, type AboutBounds } from './open-findings.js';
import { subjectFindingView } from './subject-findings.js';

/**
 * One decision of one person about every counted open finding of one rule (docs/design/finding-work.md): one journal
 * event and one command record that name each finding, and one treatment row per finding naming that decision.
 */

interface SetRow {
  id: string;
  evaluation_id: string;
  owner_id: string | null;
  ledger_kind: string | null;
  ledger_id: string | null;
}

type Selection = FindingSetTreatmentCommand['selection'];

/** The counted open findings of the selection, in id order, at most one more than the bound. */
async function readFindingSet(
  client: PoolClient,
  tenantId: string,
  selection: Selection,
  about: AboutBounds,
): Promise<SetRow[]> {
  return (
    await client.query<SetRow>(
      `SELECT f.id,v.latest_rule_evaluation_id AS evaluation_id,v.owner_id,
         CASE WHEN f.subject_scope='ledger' THEN f.subject_kind END AS ledger_kind,
         CASE WHEN f.subject_scope='ledger' THEN f.subject_id END AS ledger_id
       FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
       JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
       WHERE f.tenant_id=$1 AND v.status<>'resolved' AND f.pack_id=$2 AND f.leaf_id=$3
         AND COALESCE(r.record->'adoption'->>'mode','active')<>'shadow' AND r.outcome<>'relieved'
         AND ($4::text IS NULL OR f.subject_kind=$4)
         AND ($5::timestamptz IS NULL OR ${findingAboutAt}>=$5::timestamptz)
         AND ($6::timestamptz IS NULL OR ${findingAboutAt}<$6::timestamptz)
       ORDER BY f.id COLLATE "C" LIMIT $7`,
      [
        tenantId,
        selection.packId,
        selection.ruleId,
        selection.subjectKind ?? null,
        about.from ?? null,
        about.before ?? null,
        FINDING_SET_LIMIT + 1,
      ],
    )
  ).rows;
}

/** The Ledger subjects of a set, by kind and then id, in code-unit order. */
function ledgerSubjects(rows: readonly SetRow[]): { kind: string; id: string }[] {
  const keys = new Map<string, { kind: string; id: string }>();
  for (const row of rows)
    if (row.ledger_kind && row.ledger_id)
      keys.set(`${row.ledger_kind}\u0000${row.ledger_id}`, { kind: row.ledger_kind, id: row.ledger_id });
  return [...keys.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, at]) => at);
}

function commandShapeProblem(command: FindingSetTreatmentCommand): string | undefined {
  const shape = treatmentShapeProblem(command);
  if (shape) return shape;
  if (command.shownCount !== command.findings.length)
    return `The command names ${command.findings.length} findings but says ${command.shownCount} were shown; name each finding shown`;
  if (new Set(command.findings.map((item) => item.findingId)).size !== command.findings.length)
    return 'Name each finding once';
  return undefined;
}

function tooLarge(count: number): DomainError {
  return new DomainError(
    400,
    'finding_set_too_large',
    `More than ${FINDING_SET_LIMIT} open findings of this rule match (${count > FINDING_SET_LIMIT ? 'at least ' : ''}${count}); one decision covers at most ${FINDING_SET_LIMIT}. Narrow the set by the days the findings are about or by subject kind, and decide on each part.`,
  );
}

/** Refuses unless the set read now is exactly the set the person was shown, each at the evaluation shown. */
function requireShownSet(command: FindingSetTreatmentCommand, current: readonly SetRow[]): void {
  const shown = new Map(command.findings.map((item) => [item.findingId, item.evaluationId]));
  const missing = command.findings.filter((item) => !current.some((row) => row.id === item.findingId)).length;
  const added = current.filter((row) => !shown.has(row.id)).length;
  const evaluated = current.filter((row) => shown.has(row.id) && shown.get(row.id) !== row.evaluation_id).length;
  if (!missing && !added && !evaluated) return;
  const changes = [
    added ? `${added} opened or now match` : '',
    missing ? `${missing} closed or no longer match` : '',
    evaluated ? `${evaluated} evaluated again` : '',
  ].filter(Boolean);
  throw new DomainError(
    409,
    'stale_finding_set',
    `The open findings of this rule changed after they were shown: ${command.findings.length} were shown, ${current.length} match now (${changes.join(', ')}). Nothing was recorded; read them again and decide on what is shown.`,
    { shown: command.findings.length, current: current.length },
  );
}

/**
 * `finding.treat-many`. Locks: the record of each Ledger subject in the set through its kind's `lockSubject`, kind by
 * kind and in id order within a kind; then the set's finding views in id order; then the rule's stream.
 */
export async function acceptFindingSetTreatment(
  client: PoolClient,
  principal: AuthContext,
  command: FindingSetTreatmentCommand,
): Promise<string> {
  requirePerson(principal);
  const shape = commandShapeProblem(command);
  if (shape) throw new DomainError(400, 'invalid_finding_treatment', shape);
  const about = await aboutBounds(client, principal.tenantId, command.selection);
  const seen = await readFindingSet(client, principal.tenantId, command.selection, about);
  if (seen.length > FINDING_SET_LIMIT) throw tooLarge(seen.length);
  for (const subject of ledgerSubjects(seen)) await subjectFindingView(subject.kind)?.lockSubject?.(client, subject.id);
  await client.query(
    'SELECT id FROM finding_views WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
    [principal.tenantId, seen.map((row) => row.id)],
  );
  const current = await readFindingSet(client, principal.tenantId, command.selection, about);
  if (current.length > FINDING_SET_LIMIT) throw tooLarge(current.length);
  requireShownSet(command, current);
  if (command.action === 'assign') await requireAssignee(client, principal.tenantId, command.assigneeId!);
  if (command.action === 'plan' || command.action === 'close') {
    const owned = current.filter((row) => row.owner_id === principal.id).length;
    if (owned !== current.length)
      throw new DomainError(
        409,
        'finding_owner_required',
        `You own ${owned} of these ${current.length} findings. Take responsibility for them first: one decision takes every finding of the set, then record this.`,
      );
  }
  const accepted = {
    count: current.length,
    digest: canonicalDigest(current.map((row) => ({ findingId: row.id, evaluationId: row.evaluation_id }))),
  };
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `findings:${command.selection.packId}:${command.selection.ruleId}`,
    payload: { ...command, accepted },
  });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, principal.tenantId, command.kind, principal.id, event.received_at, command],
  );
  for (const row of current)
    await insertFindingTreatment(
      client,
      principal,
      { treatmentId: randomUUID(), decisionId: event.id },
      {
        findingId: row.id,
        evaluationId: row.evaluation_id,
        action: command.action,
        ...(command.assigneeId ? { assigneeId: command.assigneeId } : {}),
        ...(command.dueOn ? { dueOn: command.dueOn } : {}),
        ...(command.reason ? { reason: command.reason } : {}),
      },
      command.note,
      event.received_at,
    );
  for (const subject of ledgerSubjects(current))
    await subjectFindingView(subject.kind)?.treated(client, subject.id, event);
  return event.id;
}
