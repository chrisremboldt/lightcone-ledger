import {
  OPERATOR_RECORD_SOURCE_ID,
  RECORD_SUBJECT_FILE_LIMIT,
  RECORD_SUBJECT_LIMIT,
  RECORD_SUBJECT_PAGE_LIMIT,
  findOperatorRecordDefinition,
  isCheckedRuleLeaf,
  recordSubjectName,
  subjectReferenceKey,
  type NamedSubject,
  type PackAdoptionAcceptance,
  type RecordSubjectFile,
  type RecordSubjectQuery,
  type RecordSubjectRule,
  type RecordSubjectsQuery,
  type RecordSubjectsResponse,
  type SubjectReference,
} from '@ledger/contracts';
import type { PoolClient, AuthContext } from '@ledger/persistence';
import { observationRegistry } from './observation-registry.js';
import {
  OPERATOR_RECORD_CARRIER,
  operatorRecordDefinitions,
  readRecordRows,
  operatorRecordObservationTypes,
  recordView,
  resolveRecordSubject,
  referenceFieldsOf,
  requireRecordRead,
  type RecordSubject,
} from './operator-record-reads.js';
import { resultOf, standingResult, type LatestResult } from './rule-coverage.js';
import { findingIdFor, organizationIdOf } from './rule-evaluations.js';
import { organizationTimeZone } from './organization-zone.js';

/**
 * The organization's subjects as its records show them: by kind, with the name the latest current record of a naming
 * type gives each (docs/design/record-productions.md), how many records are about it and how many findings about it
 * are open. Names are read here, at display time, and never stored on other records.
 */

/** `kind id` keys of source subjects under one source mapped to the name their records give them. */
export async function recordNamesOf(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  subjects: readonly { kind: string; id: string }[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const kinds = new Set(subjects.map((subject) => subject.kind));
  const naming = operatorRecordDefinitions().filter(
    (definition) => definition.nameFields?.length && definition.subjectKinds.some((kind) => kinds.has(kind)),
  );
  if (!subjects.length || !naming.length) return names;
  const rows = await client.query<{ subject_kind: string; subject_id: string; values: Record<string, any> }>(
    `SELECT DISTINCT ON(o.subject_kind,o.subject_id) o.subject_kind,o.subject_id,o.observation->'values' AS values
     FROM observations o
     WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=$3 AND o.subject_scope='source'
       AND (o.subject_kind,o.subject_id) IN (SELECT * FROM unnest($4::text[],$5::text[]))
       AND (o.observation->'values'->>'recordType')||'@'||(o.observation->'values'->>'recordVersion')=ANY($6::text[])
       AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
     ORDER BY o.subject_kind,o.subject_id,o.span_start DESC,o.received_at DESC,o.id DESC`,
    [
      tenantId,
      sourceId,
      OPERATOR_RECORD_CARRIER,
      subjects.map((subject) => subject.kind),
      subjects.map((subject) => subject.id),
      naming.map((definition) => `${definition.recordType}@${definition.recordVersion}`),
    ],
  );
  if (!rows.rows.length) return names;
  const timeZone = await organizationTimeZone(client, tenantId);
  for (const row of rows.rows) {
    const definition = findOperatorRecordDefinition(
      observationRegistry(),
      row.values.recordType,
      row.values.recordVersion,
    );
    const name = definition && recordSubjectName(definition, row.values.record ?? {}, timeZone);
    if (name) names.set(`${row.subject_kind} ${row.subject_id}`, name);
  }
  return names;
}

/**
 * `kind id` keys mapped to the names a person knows subjects by: the operator's own organization, a subject Ledger holds
 * by its label, and a subject named by the operator's own id by its records under the source.
 */
async function ledgerAndRecordNames(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  subjects: readonly RecordSubject[],
): Promise<Map<string, string>> {
  const names = await recordNamesOf(
    client,
    tenantId,
    sourceId,
    subjects.filter((subject) => subject.scope === 'source'),
  );
  const held = subjects.filter((subject) => subject.scope === 'ledger');
  const organization = organizationIdOf(tenantId);
  for (const subject of held)
    if (subject.kind === 'organization' && subject.id === organization)
      names.set(`${subject.kind} ${subject.id}`, 'Your organization');
  const others = held.filter((subject) => !(subject.kind === 'organization' && subject.id === organization));
  if (others.length) {
    const rows = await client.query<{ kind: string; id: string; label: string }>(
      'SELECT kind,id,label FROM subjects WHERE tenant_id=$1 AND id=ANY($2::text[])',
      [tenantId, others.map((subject) => subject.id)],
    );
    for (const row of rows.rows) if (row.label.trim()) names.set(`${row.kind} ${row.id}`, row.label.trim());
  }
  return names;
}

function namedSubject(subject: RecordSubject, sourceId: string, name: string | undefined): NamedSubject {
  return { ...referenceOf(subject, sourceId), name: name ?? subject.id };
}

const referenceOf = (subject: RecordSubject, sourceId: string): SubjectReference =>
  subject.scope === 'ledger'
    ? { scope: 'ledger', kind: subject.kind as SubjectReference['kind'], id: subject.id }
    : { scope: 'source', kind: subject.kind as SubjectReference['kind'], id: subject.id, sourceId };

async function openFindingCounts(client: PoolClient, tenantId: string, keys: string[]): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const rows = await client.query<{ subject_key: string; open: number }>(
    `SELECT subject_key,count(*)::int AS open FROM finding_views
     WHERE tenant_id=$1 AND subject_key=ANY($2::text[]) AND status<>'resolved' GROUP BY subject_key`,
    [tenantId, keys],
  );
  return new Map(rows.rows.map((row) => [row.subject_key, row.open]));
}

/** GET /v1/operator-records/subjects: subjects of one kind that records are about, by id, a page at a time. */
export async function listRecordSubjects(
  client: PoolClient,
  principal: AuthContext,
  query: RecordSubjectsQuery,
  bound = RECORD_SUBJECT_LIMIT,
): Promise<RecordSubjectsResponse> {
  requireRecordRead(principal);
  const sourceId = query.sourceId ?? OPERATOR_RECORD_SOURCE_ID;
  const limit = Math.min(query.limit ?? 50, RECORD_SUBJECT_PAGE_LIMIT);
  const references = referenceFieldsOf(query.kind);
  const rows = await client.query<{
    scope: 'ledger' | 'source';
    id: string;
    about: number;
    current: number;
    latest: Date | null;
  }>(
    `SELECT x.scope,x.id,count(DISTINCT o.id)::int AS about,
       count(DISTINCT o.id) FILTER (WHERE NOT EXISTS(
         SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id))::int AS current,
       max(o.span_start) AS latest
     FROM observations o
     CROSS JOIN LATERAL (
       SELECT o.subject_scope AS scope,o.subject_id AS id WHERE o.subject_kind=$4
       UNION SELECT o.secondary_subject_scope,o.secondary_subject_id WHERE o.secondary_subject_kind=$4
       UNION SELECT 'source',o.observation#>>ARRAY['values','record',f.field,'id']
         FROM unnest($5::text[],$6::text[]) AS f(record_type,field)
         WHERE f.record_type=o.observation->'values'->>'recordType'
           AND o.observation#>>ARRAY['values','record',f.field,'scope']='source'
           AND o.observation#>>ARRAY['values','record',f.field,'id'] IS NOT NULL
     ) AS x
     WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=ANY($3::text[])
     GROUP BY x.scope,x.id ORDER BY x.id,x.scope LIMIT $7`,
    [
      principal.tenantId,
      sourceId,
      operatorRecordObservationTypes(),
      query.kind,
      references.types,
      references.fields,
      bound + 1,
    ],
  );
  const members = rows.rows.slice(0, bound);
  const subjects = members.map((row): RecordSubject => ({ kind: query.kind, id: row.id, scope: row.scope }));
  const names = await ledgerAndRecordNames(client, principal.tenantId, sourceId, subjects);
  const search = query.search?.trim().toLowerCase();
  const matching = members
    .map((row, index) => ({ row, subject: subjects[index]!, name: names.get(`${query.kind} ${row.id}`) }))
    .filter(({ row }) => query.cursor === undefined || row.id > query.cursor)
    .filter(
      ({ row, name }) =>
        !search || row.id.toLowerCase().includes(search) || Boolean(name?.toLowerCase().includes(search)),
    );
  const shown = matching.slice(0, limit);
  const keys = shown.map(({ subject }) => subjectReferenceKey(referenceOf(subject, sourceId)));
  const open = await openFindingCounts(client, principal.tenantId, keys);
  const hasMore = matching.length > limit;
  return {
    kind: query.kind,
    sourceId,
    subjects: shown.map(({ row, subject, name }, index) => ({
      subject: namedSubject(subject, sourceId, name),
      named: Boolean(name),
      records: { about: row.about, current: row.current },
      openFindings: open.get(keys[index]!) ?? 0,
      latestAt: row.latest ? row.latest.toISOString() : null,
    })),
    page: { limit, hasMore, nextCursor: hasMore ? shown.at(-1)!.row.id : null },
    truncated: rows.rows.length > bound,
  };
}

/** Each rule that has evaluated the subject under an adoption, with the result that stands for it now. */
async function subjectRules(client: PoolClient, tenant: string, subjectKey: string): Promise<RecordSubjectRule[]> {
  const rows = await client.query<{
    adoption_id: string;
    pack_id: string;
    leaf_id: string;
    related_key: string;
    id: string;
    outcome: string;
    evidence_state: string;
    reason_code: string;
    summary: string;
    inputs: LatestResult['inputs'];
    recorded_at: Date;
  }>(
    `SELECT DISTINCT ON(adoption_id,pack_id,leaf_id,related_key) adoption_id,pack_id,leaf_id,related_key,id,outcome,
       evidence_state,record->>'reasonCode' AS reason_code,record->>'summary' AS summary,record->'inputs' AS inputs,
       recorded_at
     FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=$2 AND adoption_id IS NOT NULL
     ORDER BY adoption_id,pack_id,leaf_id,related_key,recorded_at DESC,id DESC`,
    [tenant, subjectKey],
  );
  if (!rows.rows.length) return [];
  const adoptions = new Map(
    (
      await client.query<{ id: string; record: PackAdoptionAcceptance }>(
        'SELECT id,record FROM organization_pack_adoptions WHERE tenant_id=$1 AND id=ANY($2::text[])',
        [tenant, [...new Set(rows.rows.map((row) => row.adoption_id))]],
      )
    ).rows.map((row) => [row.id, row.record]),
  );
  const byRule = new Map<string, { adoptionId: string; packId: string; leafId: string; results: LatestResult[] }>();
  for (const row of rows.rows) {
    const key = `${row.adoption_id}\u0000${row.pack_id}\u0000${row.leaf_id}`;
    const entry = byRule.get(key) ?? {
      adoptionId: row.adoption_id,
      packId: row.pack_id,
      leafId: row.leaf_id,
      results: [],
    };
    entry.results.push({
      id: row.id,
      related: row.related_key !== '',
      relatedKey: row.related_key,
      outcome: row.outcome,
      evidenceState: row.evidence_state,
      reasonCode: row.reason_code,
      summary: row.summary,
      recordedAt: row.recorded_at.toISOString(),
      inputs: row.inputs ?? [],
    });
    byRule.set(key, entry);
  }
  const findingIds = [...byRule.values()].map((entry) => {
    const standing = standingResult(entry.results);
    return findingIdFor(tenant, subjectKey, entry.packId, entry.leafId, standing?.relatedKey ?? '');
  });
  const statuses = new Map(
    (
      await client.query<{ id: string; status: string }>(
        'SELECT id,status FROM finding_views WHERE tenant_id=$1 AND id=ANY($2::text[])',
        [tenant, findingIds],
      )
    ).rows.map((row) => [row.id, row.status]),
  );
  return [...byRule.values()].flatMap((entry, index) => {
    const standing = standingResult(entry.results);
    if (!standing) return [];
    const adoption = adoptions.get(entry.adoptionId);
    const leaf = adoption?.pack.leaves.find((item) => item.id === entry.leafId);
    const findingId = findingIds[index]!;
    const status = statuses.get(findingId);
    return [
      {
        adoptionId: entry.adoptionId,
        packId: entry.packId,
        packTitle: adoption?.pack.title ?? entry.packId,
        mode: adoption?.mode === 'shadow' ? ('shadow' as const) : ('active' as const),
        leafId: entry.leafId,
        title: leaf && isCheckedRuleLeaf(leaf) ? leaf.title : (leaf?.title ?? entry.leafId),
        result: resultOf(standing),
        evaluation: {
          id: standing.id,
          outcome: standing.outcome,
          reasonCode: standing.reasonCode,
          summary: standing.summary,
          recordedAt: standing.recordedAt,
        },
        finding: status ? { id: findingId, status } : null,
      },
    ];
  });
}

async function openFindings(
  client: PoolClient,
  tenant: string,
  subjectKey: string,
): Promise<RecordSubjectFile['findings']> {
  const rows = await client.query<{
    id: string;
    status: string;
    pack_id: string;
    leaf_id: string;
    opened_at: Date;
    mode: string | null;
  }>(
    `SELECT f.id,v.status,f.pack_id,f.leaf_id,f.opened_at,r.record->'adoption'->>'mode' AS mode FROM findings f
     JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
     LEFT JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
     WHERE f.tenant_id=$1 AND f.subject_key=$2 AND v.status<>'resolved' ORDER BY f.opened_at DESC,f.id DESC LIMIT 200`,
    [tenant, subjectKey],
  );
  if (!rows.rows.length) return [];
  const titles = new Map<string, string>();
  const adoptions = await client.query<{ record: PackAdoptionAcceptance }>(
    'SELECT record FROM organization_pack_adoptions WHERE tenant_id=$1 AND pack_id=ANY($2::text[])',
    [tenant, [...new Set(rows.rows.map((row) => row.pack_id))]],
  );
  for (const adoption of adoptions.rows)
    for (const leaf of adoption.record.pack.leaves) titles.set(`${adoption.record.pack.packId} ${leaf.id}`, leaf.title);
  return rows.rows.map((row) => ({
    id: row.id,
    status: row.status,
    packId: row.pack_id,
    mode: row.mode === 'shadow' ? ('shadow' as const) : ('active' as const),
    leafId: row.leaf_id,
    title: titles.get(`${row.pack_id} ${row.leaf_id}`) ?? row.leaf_id,
    openedAt: row.opened_at.toISOString(),
  }));
}

/** GET /v1/operator-records/subjects/:kind/:id: everything on file about one subject. */
export async function getRecordSubjectFile(
  client: PoolClient,
  principal: AuthContext,
  kind: string,
  id: string,
  query: RecordSubjectQuery,
): Promise<RecordSubjectFile> {
  requireRecordRead(principal);
  const sourceId = query.sourceId ?? OPERATOR_RECORD_SOURCE_ID;
  const subject = await resolveRecordSubject(client, principal.tenantId, kind, id);
  const rows = await readRecordRows(
    client,
    principal.tenantId,
    { sourceId, subjects: [subject] },
    RECORD_SUBJECT_FILE_LIMIT + 1,
  );
  const shown = rows.slice(0, RECORD_SUBJECT_FILE_LIMIT).map(recordView);
  const groups = new Map<string, RecordSubjectFile['groups'][number]>();
  for (const record of shown) {
    const key = `${record.recordType}@${record.recordVersion}`;
    const definition = findOperatorRecordDefinition(observationRegistry(), record.recordType, record.recordVersion);
    const group = groups.get(key) ?? {
      recordType: record.recordType,
      recordVersion: record.recordVersion,
      title: definition?.title ?? record.recordType,
      records: [],
    };
    group.records.push(record);
    groups.set(key, group);
  }
  const name = (await ledgerAndRecordNames(client, principal.tenantId, sourceId, [subject])).get(`${kind} ${id}`);
  const key = subjectReferenceKey(referenceOf(subject, sourceId));
  return {
    subject: namedSubject(subject, sourceId, name),
    named: Boolean(name),
    sourceId,
    groups: [...groups.values()].sort((a, b) => a.title.localeCompare(b.title)),
    records: { shown: shown.length, truncated: rows.length > RECORD_SUBJECT_FILE_LIMIT },
    rules: await subjectRules(client, principal.tenantId, key),
    findings: await openFindings(client, principal.tenantId, key),
  };
}
