import {
  subjectReferenceKey,
  type CheckedRuleLeaf,
  type PackAdoptionAcceptance,
  type RulePopulation,
  type RuleReadCondition,
  type SubjectReference,
} from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { observationMatches, type CheckObservation } from './check-kinds.js';
import { aliasOf, currentRole, referencedSubjects } from './related-subject-queueing.js';

/**
 * Who a rule is meant for (docs/design/rule-coverage.md): the members of the population a rule declares, read from
 * current observations and subjects in a fixed order, a page at a time. Nothing names a rule or a record type: the
 * declaration on the rule says which records designate members.
 */

type Kind = SubjectReference['kind'];

/** The adoption a population is resolved for: its dates bound `in_adoption_dates`. */
export interface PopulationScope {
  tenantId: string;
  kind: Kind;
  population: RulePopulation;
  interval: PackAdoptionAcceptance['effectiveInterval'];
}

/** A member and its position in the fixed order members are read in. */
export interface PopulationMember {
  subject: SubjectReference;
  position: string;
}

const SEPARATOR = '\u001f';

/** The position of a subject in member order: scope, source and id, compared byte by byte. */
export function populationPosition(subject: SubjectReference): string {
  return [subject.scope, subject.scope === 'source' ? subject.sourceId : '', subject.id].join(SEPARATOR);
}

const CURRENT = `NOT EXISTS(SELECT 1 FROM observations rep WHERE rep.tenant_id=o.tenant_id AND rep.replaces_observation_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)`;

/** SQL for one observation role as a member row: the current Ledger subject, else the source's identity. */
function roleMembers(column: 'subject' | 'secondary_subject', role: string, filter: string): string {
  return `SELECT CASE WHEN c.current IS NULL THEN 'source' ELSE 'ledger' END AS scope,
      COALESCE(c.current,c.raw_id) AS id,CASE WHEN c.current IS NULL THEN c.source_id END AS source_id
    FROM (SELECT ${currentRole(column, role)} AS current,o.${column}_id AS raw_id,o.source_id FROM observations o
      WHERE o.tenant_id=$1 AND o.${column}_kind=$2 AND ${CURRENT} AND ${filter}) c`;
}

/** SQL for references of the kind in current observations as member rows, resolved through alias resolutions. */
function referenceMembers(filter: string, field?: string): string {
  return `SELECT CASE WHEN ref.reference_scope='ledger' OR c.resolved IS NOT NULL THEN 'ledger' ELSE 'source' END AS scope,
      COALESCE(c.resolved,ref.reference_id) AS id,
      CASE WHEN ref.reference_scope='source' AND c.resolved IS NULL THEN ref.reference_source_id END AS source_id
    FROM observation_references ref JOIN observations o ON o.tenant_id=ref.tenant_id AND o.id=ref.observation_id
    CROSS JOIN LATERAL (SELECT CASE WHEN ref.reference_scope='source' THEN ${aliasOf('ref')} END AS resolved) c
    WHERE ref.tenant_id=$1 AND ref.reference_kind=$2 ${field === undefined ? '' : `AND ref.field=${field}`}
      AND ${CURRENT} AND ${filter}`;
}

/** A condition of a designating read as SQL over the observation's JSON, with the same meaning as in a rule read. */
export function conditionSql(condition: RuleReadCondition, parameter: (value: unknown) => string): string {
  const value = `(o.observation #> ${parameter(condition.field.split('.'))}::text[])`;
  if ('filled' in condition)
    return `(${value} IS NOT NULL AND ${value}<>'null'::jsonb
      AND NOT (jsonb_typeof(${value})='string' AND (${value}#>>'{}') ~ '^[[:space:]]*$'))`;
  const values = `(SELECT jsonb_array_elements(${parameter(JSON.stringify(condition.oneOf))}::jsonb))`;
  // A field that holds a list matches when the list holds one of the values, as observationMatches reads it.
  return `(CASE WHEN jsonb_typeof(${value})='array' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(${value}) e
    WHERE e.value IN ${values}) ELSE ${value} IN ${values} END)`;
}

/**
 * The SQL of the members, each once however many records designate it, with its parameters; $1 is the tenant and
 * $2 the kind.
 */
function membersSql(scope: PopulationScope): { sql: string; parameters: unknown[] } {
  const { sql, parameters } = memberRowsSql(scope);
  return { sql: `SELECT DISTINCT r.scope,r.id,r.source_id FROM (${sql}) r`, parameters };
}

/** The SQL of every member row, one per designating record, with its parameters. */
function memberRowsSql(scope: PopulationScope): { sql: string; parameters: unknown[] } {
  const parameters: unknown[] = [scope.tenantId, scope.kind];
  const parameter = (value: unknown) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const { population } = scope;
  if (population.of === 'designated') {
    const { by } = population;
    const filter = [
      `o.observation_type=${parameter(by.type)}`,
      `o.observation_version=ANY(${parameter(by.versions)}::integer[])`,
      ...(by.where ?? []).map((condition) => conditionSql(condition, parameter)),
    ].join(' AND ');
    const sql =
      by.field === 'subject'
        ? roleMembers('subject', 'subject', filter)
        : by.field === 'secondarySubject'
          ? roleMembers('secondary_subject', 'secondarySubject', filter)
          : referenceMembers(filter, parameter(by.field));
    return { sql, parameters };
  }
  const filter =
    population.of === 'in_adoption_dates'
      ? `COALESCE(o.interval_start,o.occurred_at)<${parameter(scope.interval.end)}::timestamptz
         AND COALESCE(o.interval_end,o.interval_start,o.occurred_at)>=${parameter(scope.interval.start)}::timestamptz`
      : 'true';
  const observed = [
    roleMembers('subject', 'subject', filter),
    roleMembers('secondary_subject', 'secondarySubject', filter),
    referenceMembers(filter),
  ];
  const recorded =
    population.of === 'on_record'
      ? [`SELECT 'ledger' AS scope,s.id,NULL::text AS source_id FROM subjects s WHERE s.tenant_id=$1 AND s.kind=$2`]
      : [];
  return { sql: [...recorded, ...observed].join(' UNION '), parameters };
}

/** One page of members after a position, in member order. */
export async function populationPage(
  client: PoolClient,
  scope: PopulationScope,
  after: string,
  limit: number,
): Promise<PopulationMember[]> {
  const { sql, parameters } = membersSql(scope);
  const n = parameters.length;
  const position = `(m.scope||$${n + 1}::text||COALESCE(m.source_id,'')||$${n + 1}::text||m.id) COLLATE "C"`;
  const rows = await client.query<{ scope: SubjectReference['scope']; id: string; source_id: string | null }>(
    `SELECT m.scope,m.id,m.source_id FROM (${sql}) m WHERE ${position}>$${n + 2}::text
     ORDER BY ${position} LIMIT $${n + 3}`,
    [...parameters, SEPARATOR, after, limit],
  );
  return rows.rows.map((row) => {
    const subject: SubjectReference =
      row.scope === 'source'
        ? { scope: 'source', kind: scope.kind, id: row.id, sourceId: row.source_id! }
        : { scope: 'ledger', kind: scope.kind, id: row.id };
    return { subject, position: populationPosition(subject) };
  });
}

// Members read per query when a read takes a whole bounded population.
const READ_PAGE = 500;

/** The first members, at most `limit`, in member order. */
export async function populationMembers(
  client: PoolClient,
  scope: PopulationScope,
  limit: number,
): Promise<PopulationMember[]> {
  const members: PopulationMember[] = [];
  let after = '';
  while (members.length < limit) {
    const wanted = Math.min(READ_PAGE, limit - members.length);
    const page = await populationPage(client, scope, after, wanted);
    members.push(...page);
    if (page.length < wanted) break;
    after = page.at(-1)!.position;
  }
  return members;
}

/** An observation as queueing sees it: its roles as recorded, its time and its content. */
export interface JoiningObservation {
  id: string;
  sourceId: string;
  subject: { kind: Kind; id: string; ledgerId: string | null };
  secondarySubject?: { kind: Kind; id: string; ledgerId: string | null };
  content: CheckObservation;
}

function roleSubject(observation: JoiningObservation, role: 'subject' | 'secondarySubject'): SubjectReference[] {
  const named = observation[role];
  if (!named) return [];
  return [
    named.ledgerId
      ? { scope: 'ledger', kind: named.kind, id: named.ledgerId }
      : { scope: 'source', kind: named.kind, id: named.id, sourceId: observation.sourceId },
  ];
}

/** True when the observation's time overlaps the interval, as `in_adoption_dates` reads it. */
export function overlaps(content: CheckObservation, interval: PopulationScope['interval']): boolean {
  const start = Date.parse(content.interval?.start ?? content.occurredAt);
  const end = Date.parse(content.interval?.end ?? content.interval?.start ?? content.occurredAt);
  return start < Date.parse(interval.end) && end >= Date.parse(interval.start);
}

/**
 * The envelope roles through which an observation can bring a subject of the kind into the population, before
 * references are looked up: which roles to take, and whether references of the kind (and at which field) count.
 */
export function joiningRoles(
  scope: PopulationScope,
  observation: Pick<JoiningObservation, 'content'>,
): { roles: ('subject' | 'secondarySubject')[]; references: boolean; field?: string } {
  const { population } = scope;
  if (population.of === 'designated') {
    const { by } = population;
    const designates =
      by.type === observation.content.type &&
      by.versions.includes(observation.content.version) &&
      observationMatches(observation.content, by.where);
    if (!designates) return { roles: [], references: false };
    if (by.field === 'subject' || by.field === 'secondarySubject') return { roles: [by.field], references: false };
    return { roles: [], references: true, field: by.field };
  }
  if (population.of === 'in_adoption_dates' && !overlaps(observation.content, scope.interval))
    return { roles: [], references: false };
  return { roles: ['subject', 'secondarySubject'], references: true };
}

/** The subjects of the kind an accepted observation brings into a population, each once. */
export async function joiningSubjects(
  client: PoolClient,
  scope: PopulationScope,
  observation: JoiningObservation,
  /** References already resolved for this observation, by kind and field; shared across the rules it queues. */
  references: Map<string, SubjectReference[]> = new Map(),
): Promise<SubjectReference[]> {
  const joining = joiningRoles(scope, observation);
  const subjects = joining.roles
    .flatMap((role) => roleSubject(observation, role))
    .filter((item) => item.kind === scope.kind);
  if (joining.references) {
    const key = JSON.stringify([scope.kind, joining.field ?? null]);
    let named = references.get(key);
    if (!named) {
      const fields =
        joining.field !== undefined
          ? [joining.field]
          : (
              await client.query<{ field: string }>(
                'SELECT field FROM observation_references WHERE tenant_id=$1 AND observation_id=$2 AND reference_kind=$3',
                [scope.tenantId, observation.id, scope.kind],
              )
            ).rows.map((row) => row.field);
      named = [];
      for (const field of fields)
        named.push(...(await referencedSubjects(client, scope.tenantId, observation.id, field, scope.kind)));
      references.set(key, named);
    }
    subjects.push(...named);
  }
  return [...new Map(subjects.map((subject) => [subjectReferenceKey(subject), subject])).values()];
}

/** The population scope of a rule under an adoption, or undefined for a rule that declares none. */
export function populationScope(
  tenantId: string,
  adoption: PackAdoptionAcceptance,
  leaf: CheckedRuleLeaf,
): PopulationScope | undefined {
  if (!leaf.population) return undefined;
  return {
    tenantId,
    kind: leaf.target.subjectKind,
    population: leaf.population,
    interval: adoption.effectiveInterval,
  };
}
