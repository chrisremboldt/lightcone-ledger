import {
  evaluationMode,
  isCheckedRuleLeaf,
  SUBJECT_RECORD_PAGE_LIMIT,
  subjectReferenceKey,
  summaryRecordValues,
  type EvaluationInputSubjects,
  type EvaluationSummaryWording,
  type FindingRecord,
  type RuleEvaluationListResponse,
  type RuleEvaluationRecord,
  type SubjectFindingListResponse,
  type SubjectFindingRecord,
  type SubjectRecordQuery,
  type SubjectReference,
  localizeInstants,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { encodeHistoryCursor, historyCursor, historyLimit, historyPrecise } from './history.js';
import { findCheckKind, registeredCheckKindDigest } from './check-kinds.js';
import { checkSummaryWording, worded } from './checked-rules.js';
import { correctionSql } from './observations.js';
import { getRulePackVersion } from './rule-pack-registry.js';
import { rulesInEffect } from './rule-evaluations.js';
import { subjectNames } from './subject-names.js';
import {
  findingActionOf,
  findingClosureOf,
  findingWorkColumns,
  treatmentsOf,
  type FindingWorkRow,
} from './finding-work.js';

interface PageRow {
  id: string;
  page_time: string;
}

function requireEvidenceRead(principal: AuthContext): void {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'capability_required', 'Reading evaluations and findings requires evidence:read');
}

function subjectOf(query: SubjectRecordQuery): SubjectReference {
  const scope = query.subjectScope ?? 'ledger';
  if ((scope === 'source') !== (query.sourceId !== undefined))
    throw new DomainError(
      400,
      'invalid_subject_query',
      'sourceId is required with subjectScope source and not accepted otherwise',
    );
  return scope === 'source'
    ? { scope, kind: query.subjectKind, id: query.subjectId, sourceId: query.sourceId! }
    : { scope, kind: query.subjectKind, id: query.subjectId };
}

function pageOf<Row extends PageRow>(
  rows: Row[],
  limit: number,
  principal: AuthContext,
  resource: string,
  filters: Record<string, string>,
  upper: { id: string; time: string | null } | undefined,
) {
  const visible = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = visible.at(-1);
  const position = last ? { id: last.id, time: last.page_time } : null;
  return {
    visible,
    page: {
      limit,
      returned: visible.length,
      hasMore,
      nextCursor:
        hasMore && position ? encodeHistoryCursor(principal, resource, filters, upper ?? position, position) : null,
    },
  };
}

interface ObservationSubjectRow {
  id: string;
  source_id: string;
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_ledger_id: string | null;
  secondary_subject_scope: SubjectReference['scope'] | null;
  secondary_subject_kind: SubjectReference['kind'] | null;
  secondary_subject_id: string | null;
  secondary_subject_ledger_id: string | null;
}

/** An observation's subject in one role as it is current now: resolved to a Ledger subject, or the source's own id. */
function roleSubject(
  sourceId: string,
  scope: SubjectReference['scope'],
  kind: SubjectReference['kind'],
  id: string,
  ledgerId: string | null,
): SubjectReference {
  if (ledgerId) return { scope: 'ledger', kind, id: ledgerId };
  return scope === 'ledger' ? { scope, kind, id } : { scope, kind, id, sourceId };
}

/** The current subjects, primary first, of each observation named, read now. */
async function observationSubjects(
  client: PoolClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, SubjectReference[]>> {
  const found = new Map<string, SubjectReference[]>();
  if (!ids.length) return found;
  const corrections = correctionSql('$3');
  const rows = await client.query<ObservationSubjectRow>(
    `SELECT o.id,o.source_id,o.subject_scope,o.subject_kind,o.subject_id,
       COALESCE(pr.ledger_subject_id,o.subject_ledger_id) AS subject_ledger_id,o.secondary_subject_scope,
       o.secondary_subject_kind,o.secondary_subject_id,
       COALESCE(sr.ledger_subject_id,o.secondary_subject_ledger_id) AS secondary_subject_ledger_id
     FROM observations o ${corrections.joins}
     WHERE o.tenant_id=$1 AND o.id=ANY($2::text[])`,
    [tenantId, [...ids], null],
  );
  for (const row of rows.rows) {
    const subjects = [
      roleSubject(row.source_id, row.subject_scope, row.subject_kind, row.subject_id, row.subject_ledger_id),
    ];
    if (row.secondary_subject_scope && row.secondary_subject_kind && row.secondary_subject_id)
      subjects.push(
        roleSubject(
          row.source_id,
          row.secondary_subject_scope,
          row.secondary_subject_kind,
          row.secondary_subject_id,
          row.secondary_subject_ledger_id,
        ),
      );
    found.set(row.id, subjects);
  }
  return found;
}

/**
 * The subject an input was about: the subject recorded with it; otherwise the one subject its observations are
 * about, taking the subject the read was about wherever an observation names it; otherwise the subject the read was
 * about, as when it read nothing or read records about several subjects that each name it.
 */
function inputSubject(
  record: RuleEvaluationRecord,
  input: RuleEvaluationRecord['inputs'][number],
  observed: Map<string, SubjectReference[]>,
): SubjectReference {
  if (input.subject) return input.subject;
  const about: SubjectReference =
    input.about === 'organization'
      ? { scope: 'ledger', kind: 'organization', id: record.organizationId }
      : record.subject;
  const aboutKey = subjectReferenceKey(about);
  const distinct = new Map<string, SubjectReference>();
  for (const id of input.observationIds) {
    const roles = observed.get(id);
    if (!roles) continue;
    const named = roles.find((role) => subjectReferenceKey(role) === aboutKey) ?? roles[0]!;
    distinct.set(subjectReferenceKey(named), named);
  }
  return distinct.size === 1 ? [...distinct.values()][0]! : about;
}

/**
 * For each record, the subject each of its inputs was about and that subject's name, read now and in input order.
 * Nothing recorded changes: the records keep their content and digests, and this is returned beside them.
 */
export async function inputSubjectsOf(
  client: PoolClient,
  tenantId: string,
  records: readonly RuleEvaluationRecord[],
): Promise<EvaluationInputSubjects> {
  const unrecorded = records.flatMap((record) =>
    record.inputs.flatMap((input) => (input.subject ? [] : input.observationIds)),
  );
  const observed = await observationSubjects(client, tenantId, [...new Set(unrecorded)]);
  const subjects = records.map((record) => record.inputs.map((input) => inputSubject(record, input, observed)));
  const names = await subjectNames(client, tenantId, subjects.flat());
  return Object.fromEntries(
    records.map((record, index) => [
      record.id,
      subjects[index]!.map((subject) => names.get(subjectReferenceKey(subject))!),
    ]),
  );
}

/** The rule's own wording the recorded summary came from, from the pinned pack version and rule as registered here. */
function packWording(
  record: RuleEvaluationRecord,
  packs: Map<string, ReturnType<typeof getRulePackVersion>>,
): string | undefined {
  const packKey = `${record.pack.id}@${record.pack.version}`;
  if (!packs.has(packKey)) packs.set(packKey, getRulePackVersion(record.pack.id, record.pack.version));
  const pack = packs.get(packKey);
  if (!pack || pack.digest !== record.pack.digest) return undefined;
  const leaf = pack.leaves.find((item) => item.id === record.rule.id && item.digest === record.rule.digest);
  const template =
    leaf && isCheckedRuleLeaf(leaf) && record.outcome !== 'relieved' ? leaf.wording?.[record.outcome] : undefined;
  return template && localizeInstants(worded(template, record.details) ?? '', record.clock?.timeZone) === record.summary
    ? template
    : undefined;
}

/** The check kind's own summary as wording, from the pinned check kind as registered here. */
function checkWording(record: RuleEvaluationRecord): string | undefined {
  const { kind: id, version, definitionDigest } = record.check;
  const kind = findCheckKind(id, version);
  if (!kind || registeredCheckKindDigest(id, version) !== definitionDigest) return undefined;
  return checkSummaryWording(kind, record.summary, summaryRecordValues(record), record.clock?.timeZone);
}

/**
 * For each record whose summary is wording filled from the recorded details, that wording, so a screen can fill it
 * again in a person's terms: the rule's own wording, or else the check kind's own summary with the values it names
 * marked. Only when filling it gives the recorded summary exactly; the recorded summary is never changed.
 */
export function summaryWordingOf(records: readonly RuleEvaluationRecord[]): EvaluationSummaryWording {
  const packs = new Map<string, ReturnType<typeof getRulePackVersion>>();
  const found: EvaluationSummaryWording = {};
  for (const record of records) {
    const template = packWording(record, packs) ?? checkWording(record);
    if (template) found[record.id] = template;
  }
  return found;
}

/** The input subjects and summary wording of the generic evaluations a flight's findings show, read beside them. */
export async function flightFindingReadContext(
  client: PoolClient,
  findings: readonly FindingRecord[],
): Promise<{ inputSubjects: EvaluationInputSubjects; summaryWording: EvaluationSummaryWording }> {
  const ids = [
    ...new Set(
      findings.flatMap((finding) =>
        [finding.initialEvaluation, finding.latestEvaluation].flatMap((evaluation) =>
          'kind' in evaluation.explanation && evaluation.explanation.kind === 'rule' ? [evaluation.id] : [],
        ),
      ),
    ),
  ];
  if (!ids.length) return { inputSubjects: {}, summaryWording: {} };
  const rows = await client.query<{ tenant_id: string; record: RuleEvaluationRecord }>(
    'SELECT tenant_id,record FROM rule_evaluations WHERE id=ANY($1::text[]) ORDER BY id',
    [ids],
  );
  if (!rows.rows.length) return { inputSubjects: {}, summaryWording: {} };
  const records = rows.rows.map((row) => row.record);
  return {
    inputSubjects: await inputSubjectsOf(client, rows.rows[0]!.tenant_id, records),
    summaryWording: summaryWordingOf(records),
  };
}

/** Evaluations recorded for one subject reference, newest first. Requires evidence:read. */
export async function listRuleEvaluations(
  client: PoolClient,
  principal: AuthContext,
  query: SubjectRecordQuery,
): Promise<RuleEvaluationListResponse> {
  requireEvidenceRead(principal);
  const subjectKey = subjectReferenceKey(subjectOf(query));
  const limit = historyLimit(query.limit, 50, SUBJECT_RECORD_PAGE_LIMIT);
  const filters = { subjectKey };
  const prior = historyCursor(query.cursor, principal, 'rule-evaluations', filters, true);
  const rows = await client.query<PageRow & { record: RuleEvaluationRecord }>(
    `SELECT id,record,${historyPrecise('recorded_at')} AS page_time FROM rule_evaluations
     WHERE tenant_id=$1 AND subject_key=$2 AND ($3::timestamptz IS NULL OR (recorded_at,id)<($3::timestamptz,$4::text))
     ORDER BY recorded_at DESC,id DESC LIMIT $5`,
    [principal.tenantId, subjectKey, prior?.position.time ?? null, prior?.position.id ?? null, limit + 1],
  );
  const { visible, page } = pageOf(rows.rows, limit, principal, 'rule-evaluations', filters, prior?.upper);
  const evaluations = visible.map((row) => row.record);
  return {
    evaluations,
    page,
    inputSubjects: await inputSubjectsOf(client, principal.tenantId, evaluations),
    summaryWording: summaryWordingOf(evaluations),
  };
}

export async function getRuleEvaluation(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<RuleEvaluationRecord> {
  requireEvidenceRead(principal);
  const row = (
    await client.query<{ record: RuleEvaluationRecord }>(
      'SELECT record FROM rule_evaluations WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'not_found', 'Evaluation was not found within your scope');
  return row.record;
}

interface FindingRow extends PageRow, FindingWorkRow {
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
  subject_key: string;
  pack_id: string;
  leaf_id: string;
  related_key: string;
  related_name: string | null;
  related_scope: SubjectReference['scope'] | null;
  related_kind: SubjectReference['kind'] | null;
  related_id: string | null;
  related_source_id: string | null;
  status: SubjectFindingRecord['status'];
  owner_id: string | null;
  owner_name: string | null;
  opened_at: Date;
  initial_evaluation: RuleEvaluationRecord;
  latest_evaluation: RuleEvaluationRecord;
}

/**
 * Findings the generic evaluator opened for one subject reference, or for another subject about this one as a related
 * subject, newest first. Requires evidence:read.
 */
export async function listSubjectFindings(
  client: PoolClient,
  principal: AuthContext,
  query: SubjectRecordQuery,
): Promise<SubjectFindingListResponse> {
  requireEvidenceRead(principal);
  const subjectKey = subjectReferenceKey(subjectOf(query));
  const limit = historyLimit(query.limit, 50, SUBJECT_RECORD_PAGE_LIMIT);
  const filters = { subjectKey };
  const prior = historyCursor(query.cursor, principal, 'subject-findings', filters, true);
  const rows = await client.query<FindingRow>(
    `SELECT f.id,f.subject_scope,f.subject_kind,f.subject_id,f.subject_source_id,f.subject_key,f.pack_id,f.leaf_id,
       f.related_key,f.related_name,f.related_scope,f.related_kind,f.related_id,f.related_source_id,f.opened_at,v.status,v.owner_id,p.name AS owner_name,${findingWorkColumns},first.record AS initial_evaluation,
       latest.record AS latest_evaluation,${historyPrecise('f.opened_at')} AS page_time
     FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
     JOIN rule_evaluations first ON first.tenant_id=f.tenant_id AND first.id=f.initial_rule_evaluation_id
     JOIN rule_evaluations latest ON latest.tenant_id=v.tenant_id AND latest.id=v.latest_rule_evaluation_id
     LEFT JOIN principals p ON p.tenant_id=v.tenant_id AND p.id=v.owner_id
     WHERE f.tenant_id=$1 AND (f.subject_key=$2 OR f.related_key=$2)
       AND ($3::timestamptz IS NULL OR (f.opened_at,f.id)<($3::timestamptz,$4::text))
     ORDER BY f.opened_at DESC,f.id DESC LIMIT $5`,
    [principal.tenantId, subjectKey, prior?.position.time ?? null, prior?.position.id ?? null, limit + 1],
  );
  const { visible, page } = pageOf(rows.rows, limit, principal, 'subject-findings', filters, prior?.upper);
  const held = visible.length ? await rulesInEffect(client, principal.tenantId) : new Set<string>();
  const shown = visible.flatMap((row) => [row.initial_evaluation, row.latest_evaluation]);
  const inputSubjects = await inputSubjectsOf(client, principal.tenantId, shown);
  const summaryWording = summaryWordingOf(shown);
  const findings: SubjectFindingRecord[] = [];
  for (const row of visible) {
    const action = findingActionOf(row);
    const closure = await findingClosureOf(
      client,
      principal.tenantId,
      row,
      row.initial_evaluation.evidence.map((item) => item.observationId),
    );
    findings.push({
      id: row.id,
      subject: {
        scope: row.subject_scope,
        kind: row.subject_kind,
        id: row.subject_id,
        ...(row.subject_source_id ? { sourceId: row.subject_source_id } : {}),
      },
      subjectKey: row.subject_key,
      packId: row.pack_id,
      ruleId: row.leaf_id,
      ...(row.related_key
        ? {
            related: {
              name: row.related_name!,
              subject: {
                scope: row.related_scope!,
                kind: row.related_kind!,
                id: row.related_id!,
                ...(row.related_source_id ? { sourceId: row.related_source_id } : {}),
              },
              subjectKey: row.related_key,
            },
          }
        : {}),
      mode: evaluationMode(row.latest_evaluation),
      status: row.status,
      ...(held.has(JSON.stringify([row.pack_id, row.leaf_id])) ? {} : { ruleNoLongerAdopted: true as const }),
      owner: row.owner_id ? { id: row.owner_id, name: row.owner_name ?? '' } : null,
      openedAt: row.opened_at.toISOString(),
      initialEvaluation: row.initial_evaluation,
      latestEvaluation: row.latest_evaluation,
      ...(await treatmentsOf(client, principal.tenantId, row.id)),
      ...(action ? { action } : {}),
      ...(closure ? { closure } : {}),
    });
  }
  return { findings, page, inputSubjects, summaryWording };
}
