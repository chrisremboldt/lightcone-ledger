import {
  MISSION_RELEASE_FINDING_LIMIT,
  MISSION_RELEASE_FINDING_SUBJECT_LIMIT,
  observationSubjectKindValues,
  subjectReferenceKey,
  reliefStatement,
  summaryRecordValues,
  type CheckDetails,
  type MissionReleaseFinding,
  type MissionReleaseFindings,
  type MissionReleaseFindingSubject,
  type MissionReleaseFindingsResponse,
  type MissionReleaseRelievedRule,
  type RuleEvaluationRecord,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { correctionSql } from './observations.js';
import { summaryWordingOf } from './rule-evaluation-reads.js';

// What a release under policy version 2 lists: the findings not yet resolved about the flight, its organization and
// the subjects the flight's current records name (the other subject of an observation about the flight, and every
// reference field the observation registry indexed), including findings listed under one of them as the related
// subject. A finding that belongs to another flight is that flight's to release. The adoption mode of a finding's
// latest evaluation decides whether it is counted (active) or shown beside the list as proposed (shadow). A finding
// whose latest evaluation an active waiver adoption relieves is neither; the relieved rules are listed apart.

const subjectKinds = new Set<string>(observationSubjectKindValues);
const corrections = correctionSql('$3');

/** Current observations about the flight ($2), with each envelope role's current subject. */
const aboutFlight = `SELECT o.id,o.source_id,o.occurred_at,
    o.subject_kind AS p_kind,o.subject_scope AS p_scope,o.subject_id AS p_id,
    COALESCE(pr.ledger_subject_id,o.subject_ledger_id) AS p_ledger,
    o.secondary_subject_kind AS s_kind,o.secondary_subject_scope AS s_scope,o.secondary_subject_id AS s_id,
    COALESCE(sr.ledger_subject_id,o.secondary_subject_ledger_id) AS s_ledger
  FROM (SELECT id FROM observations WHERE tenant_id=$1 AND subject_ledger_id=$2
    UNION SELECT id FROM observations WHERE tenant_id=$1 AND secondary_subject_ledger_id=$2
    UNION SELECT observation_id FROM observation_subject_resolutions
      WHERE tenant_id=$1 AND ledger_subject_id=$2 AND observation_id IS NOT NULL
    UNION SELECT c.id FROM observation_subject_resolutions r
      JOIN observations c ON c.tenant_id=r.tenant_id AND c.source_id=r.source_id
        AND ((c.subject_scope='source' AND c.subject_kind=r.subject_kind AND c.subject_id=r.external_id)
          OR (c.secondary_subject_scope='source' AND c.secondary_subject_kind=r.subject_kind
            AND c.secondary_subject_id=r.external_id))
      WHERE r.tenant_id=$1 AND r.ledger_subject_id=$2 AND r.observation_id IS NULL) candidate
  JOIN observations o ON o.tenant_id=$1 AND o.id=candidate.id
  ${corrections.joins}
  WHERE rep.id IS NULL AND wd.id IS NULL
    AND ((COALESCE(pr.ledger_subject_id,o.subject_ledger_id)=$2 AND o.subject_kind='flight')
      OR (COALESCE(sr.ledger_subject_id,o.secondary_subject_ledger_id)=$2 AND o.secondary_subject_kind='flight'))`;

/** Subjects named by the observations about the flight: the other envelope role and every indexed reference. */
const namedSubjects = `WITH about AS (${aboutFlight})
  SELECT DISTINCT kind,scope,id,source_id FROM (
    SELECT s_kind AS kind,CASE WHEN s_ledger IS NOT NULL THEN 'ledger' ELSE s_scope END AS scope,
      COALESCE(s_ledger,s_id) AS id,CASE WHEN s_ledger IS NULL AND s_scope='source' THEN source_id END AS source_id
    FROM about WHERE s_kind IS NOT NULL AND NOT (s_ledger IS NOT DISTINCT FROM $2 AND s_kind='flight')
    UNION ALL
    SELECT p_kind,CASE WHEN p_ledger IS NOT NULL THEN 'ledger' ELSE p_scope END,COALESCE(p_ledger,p_id),
      CASE WHEN p_ledger IS NULL AND p_scope='source' THEN source_id END
    FROM about WHERE NOT (p_ledger IS NOT DISTINCT FROM $2 AND p_kind='flight')
    UNION ALL
    SELECT ref.reference_kind,CASE WHEN alias.ledger_subject_id IS NOT NULL THEN 'ledger' ELSE ref.reference_scope END,
      COALESCE(alias.ledger_subject_id,ref.reference_id),
      CASE WHEN alias.ledger_subject_id IS NULL THEN ref.reference_source_id END
    FROM about a JOIN observation_references ref ON ref.tenant_id=$1 AND ref.observation_id=a.id
    LEFT JOIN LATERAL (SELECT r.ledger_subject_id FROM observation_subject_resolutions r
      JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
      WHERE ref.reference_scope='source' AND r.tenant_id=$1 AND r.observation_id IS NULL
        AND r.source_id=ref.reference_source_id AND r.subject_kind=ref.reference_kind AND r.external_id=ref.reference_id
        AND (r.valid_from IS NULL OR r.valid_from<=a.occurred_at) AND (r.valid_to IS NULL OR r.valid_to>a.occurred_at)
      ORDER BY re.received_at DESC,r.id DESC LIMIT 1) alias ON true
  ) named`;

interface NamedRow {
  kind: string;
  scope: SubjectReference['scope'];
  id: string;
  source_id: string | null;
}

interface FindingRow {
  id: string;
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
  subject_key: string;
  related_key: string;
  related_name: string | null;
  related_scope: SubjectReference['scope'] | null;
  related_kind: SubjectReference['kind'] | null;
  related_id: string | null;
  related_source_id: string | null;
  status: MissionReleaseFinding['status'];
  record: RuleEvaluationRecord;
}

const openFindings = `SELECT f.id,f.subject_scope,f.subject_kind,f.subject_id,f.subject_source_id,f.subject_key,
    f.related_key,f.related_name,f.related_scope,f.related_kind,f.related_id,f.related_source_id,v.status,r.record
  FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
  JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
  WHERE f.tenant_id=$1 AND v.status<>'resolved'
    AND (f.subject_key=ANY($2::text[])
      OR (f.related_key=ANY($2::text[]) AND NOT (f.subject_kind='flight' AND f.subject_key<>$3)))
      AND (COALESCE(r.record->'adoption'->>'mode','active')='shadow')=$4 AND r.outcome<>'relieved'
  ORDER BY f.subject_key,f.id LIMIT $5`;

/** The latest evaluation of each rule about the subjects ($2) that an active waiver adoption in effect relieves. */
const relievedRules = `SELECT subject_key,related_key,record FROM (
    SELECT DISTINCT ON(r.subject_key,r.pack_id,r.leaf_id,r.related_key) r.subject_key,r.related_key,r.pack_id,
      r.leaf_id,r.outcome,r.record FROM rule_evaluations r
    WHERE r.tenant_id=$1 AND (r.subject_key=ANY($2::text[])
      OR (r.related_key=ANY($2::text[]) AND NOT (r.subject_kind='flight' AND r.subject_key<>$3)))
    ORDER BY r.subject_key,r.pack_id,r.leaf_id,r.related_key,r.recorded_at DESC,r.id DESC) latest
  WHERE outcome='relieved'
    AND (record->'relief'->'waiver'->'effectiveInterval'->>'end')::timestamptz>clock_timestamp()
  ORDER BY subject_key,pack_id,leaf_id,related_key LIMIT $4`;

const byKey = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function reference(
  scope: SubjectReference['scope'],
  kind: SubjectReference['kind'],
  id: string,
  sourceId: string | null,
): SubjectReference {
  return { scope, kind, id, ...(scope === 'source' && sourceId ? { sourceId } : {}) };
}

/** The subjects a release reads findings about: the flight, its organization and the subjects its records name. */
export async function findingSubjects(
  client: PoolClient,
  tenantId: string,
  flightId: string,
  organizationId: string,
): Promise<MissionReleaseFindingSubject[]> {
  const flight = reference('ledger', 'flight', flightId, null);
  const organization = reference('ledger', 'organization', organizationId, null);
  const subjects = new Map<string, MissionReleaseFindingSubject>();
  for (const [subject, reason] of [
    [flight, 'flight'],
    [organization, 'organization'],
  ] as const)
    subjects.set(subjectReferenceKey(subject), { subject, subjectKey: subjectReferenceKey(subject), reason });
  const named = await client.query<NamedRow>(namedSubjects, [tenantId, flightId, null]);
  for (const row of named.rows) {
    // Another flight's findings are that flight's to release.
    if (!subjectKinds.has(row.kind) || row.kind === 'flight' || (row.scope === 'source' && !row.source_id)) continue;
    const subject = reference(row.scope, row.kind as SubjectReference['kind'], row.id, row.source_id);
    const key = subjectReferenceKey(subject);
    if (!subjects.has(key)) subjects.set(key, { subject, subjectKey: key, reason: 'named' });
  }
  if (subjects.size > MISSION_RELEASE_FINDING_SUBJECT_LIMIT)
    throw new DomainError(
      409,
      'release_findings_limit',
      `This flight's records name ${subjects.size} subjects; one release lists findings for at most ${MISSION_RELEASE_FINDING_SUBJECT_LIMIT}`,
    );
  return [...subjects.values()].sort((left, right) => byKey(left.subjectKey, right.subjectKey));
}

function listed(row: FindingRow): MissionReleaseFinding {
  const record = row.record;
  return {
    id: row.id,
    subject: reference(row.subject_scope, row.subject_kind, row.subject_id, row.subject_source_id),
    subjectKey: row.subject_key,
    ...(row.related_key
      ? {
          related: {
            name: row.related_name!,
            subject: reference(row.related_scope!, row.related_kind!, row.related_id!, row.related_source_id),
            subjectKey: row.related_key,
          },
        }
      : {}),
    status: row.status,
    rule: { packId: record.pack.id, id: record.rule.id, version: record.rule.version, title: record.rule.title },
    answer: { outcome: record.outcome, evidenceState: record.evidenceState, summary: record.summary },
    evaluation: { id: record.id, digest: canonicalDigest(record), recordedAt: record.recordedAt },
  };
}

async function findingsOf(
  client: PoolClient,
  tenantId: string,
  flightKey: string,
  keys: string[],
  shadow: boolean,
): Promise<{ findings: MissionReleaseFinding[]; complete: boolean }> {
  const rows = await client.query<FindingRow>(openFindings, [
    tenantId,
    keys,
    flightKey,
    shadow,
    MISSION_RELEASE_FINDING_LIMIT + 1,
  ]);
  const findings = rows.rows
    .slice(0, MISSION_RELEASE_FINDING_LIMIT)
    .map(listed)
    .sort((left, right) => byKey(left.subjectKey, right.subjectKey) || byKey(left.id, right.id));
  return { findings, complete: rows.rows.length <= MISSION_RELEASE_FINDING_LIMIT };
}

function relievedRule(record: RuleEvaluationRecord): MissionReleaseRelievedRule {
  return {
    subject: { ...record.subject },
    subjectKey: record.subjectKey,
    ...(record.related
      ? {
          related: {
            name: record.related.name,
            subject: record.related.subject,
            subjectKey: record.related.subjectKey,
          },
        }
      : {}),
    rule: { packId: record.pack.id, id: record.rule.id, version: record.rule.version, title: record.rule.title },
    relief: record.relief!,
    statement: reliefStatement(record.relief!),
    evaluation: { id: record.id, digest: canonicalDigest(record), recordedAt: record.recordedAt },
  };
}

async function relievedOf(
  client: PoolClient,
  tenantId: string,
  flightKey: string,
  keys: string[],
): Promise<{ relieved: MissionReleaseRelievedRule[]; complete: boolean }> {
  const rows = await client.query<{ record: RuleEvaluationRecord }>(relievedRules, [
    tenantId,
    keys,
    flightKey,
    MISSION_RELEASE_FINDING_LIMIT + 1,
  ]);
  return {
    relieved: rows.rows.slice(0, MISSION_RELEASE_FINDING_LIMIT).map((row) => relievedRule(row.record)),
    complete: rows.rows.length <= MISSION_RELEASE_FINDING_LIMIT,
  };
}

/** The digest a release command pins: of the findings section without its own digest. */
export function missionReleaseFindingsDigest(findings: Omit<MissionReleaseFindings, 'digest'>): string {
  return canonicalDigest({ version: findings.version, subjects: findings.subjects, findings: findings.findings });
}

/**
 * The findings a release of this flight would record (basis) and the proposed-rule findings shown beside them. Reads
 * current state; the release command pins the basis by digest.
 */
export async function readMissionReleaseFindings(
  client: PoolClient,
  tenantId: string,
  flightId: string,
): Promise<Omit<MissionReleaseFindingsResponse, 'flightId' | 'readAt'>> {
  const organizationId = `organization:${tenantId}`;
  const subjects = await findingSubjects(client, tenantId, flightId, organizationId);
  const keys = subjects.map((subject) => subject.subjectKey);
  const flightKey = subjectReferenceKey(reference('ledger', 'flight', flightId, null));
  const counted = await findingsOf(client, tenantId, flightKey, keys, false);
  if (!counted.complete)
    throw new DomainError(
      409,
      'release_findings_limit',
      `More than ${MISSION_RELEASE_FINDING_LIMIT} findings are open for this flight; one release lists at most ${MISSION_RELEASE_FINDING_LIMIT}`,
    );
  const proposed = await findingsOf(client, tenantId, flightKey, keys, true);
  const relieved = await relievedOf(client, tenantId, flightKey, keys);
  const section = { version: 'mission.release-findings.1' as const, subjects, findings: counted.findings };
  return {
    basis: { ...section, digest: missionReleaseFindingsDigest(section) },
    proposed: proposed.findings,
    proposedComplete: proposed.complete,
    relieved: relieved.relieved,
    relievedComplete: relieved.complete,
  };
}

/** The read the release form shows. Requires flight:read, as the release record it leads to does. */
export async function getMissionReleaseFindings(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
): Promise<MissionReleaseFindingsResponse> {
  const flight = await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2', [
    principal.tenantId,
    flightId,
  ]);
  if (!flight.rowCount) throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const readAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const read = await readMissionReleaseFindings(client, principal.tenantId, flightId);
  return { flightId, readAt, ...read, ...(await shownWording(client, principal.tenantId, read)) };
}

/** The recorded details, and the recorded fields besides them that the wording names. */
function wordingValues(record: RuleEvaluationRecord, template: string): CheckDetails {
  const details = record.details ?? {};
  return Object.fromEntries(
    Object.entries(summaryRecordValues(record)).filter(
      ([name]) => Object.hasOwn(details, name) || template.includes(`{${name}}`),
    ),
  );
}

/** For display only, beside the findings: the wording each listed summary came from, with the values it names. */
async function shownWording(
  client: PoolClient,
  tenantId: string,
  read: Pick<MissionReleaseFindingsResponse, 'basis' | 'proposed'>,
): Promise<Pick<MissionReleaseFindingsResponse, 'summaryWording' | 'summaryDetails'>> {
  const ids = [...read.basis.findings, ...read.proposed].map((finding) => finding.evaluation.id);
  if (!ids.length) return {};
  const rows = await client.query<{ record: RuleEvaluationRecord }>(
    'SELECT record FROM rule_evaluations WHERE tenant_id=$1 AND id=ANY($2::text[])',
    [tenantId, ids],
  );
  const records = rows.rows.map((row) => row.record);
  const summaryWording = summaryWordingOf(records);
  const summaryDetails = Object.fromEntries(
    records.flatMap((record) => {
      const template = summaryWording[record.id];
      return template ? [[record.id, wordingValues(record, template)]] : [];
    }),
  );
  return { summaryWording, summaryDetails };
}
