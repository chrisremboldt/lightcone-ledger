import {
  FLIGHTS_ON_RECORD_LIMIT,
  OPEN_FINDING_LIMIT,
  OPEN_FINDING_PAGE_LIMIT,
  OPERATOR_RECORD_SOURCE_ID,
  subjectReferenceKey,
  type FindingAttention,
  type FlightOnRecord,
  type FlightsOnRecordResponse,
  type NamedSubject,
  type OpenFinding,
  type OpenFindingGroup,
  type OpenFindingGroupsQuery,
  type OpenFindingGroupsResponse,
  type OpenFindingsQuery,
  type OpenFindingsResponse,
  type SubjectReference,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { findingActionOf, findingWorkColumns, type FindingWorkRow } from './finding-work.js';
import { OPERATOR_RECORD_CARRIER } from './operator-record-reads.js';
import { getRulePackVersion } from './rule-pack-registry.js';
import { subjectNames } from './subject-names.js';

/**
 * The open findings across every subject, and the home of an organization whose flights are known only from its own
 * records (docs/design/finding-work.md). Both are reads: they take no row locks.
 */

/** An open finding as the list orders and filters it, before a page is taken. */
export interface OpenFindingEntry extends Omit<OpenFinding, 'subject' | 'related'> {
  subject: SubjectReference;
  related?: { name: string; subject: SubjectReference };
  relieved: boolean;
}

/** Counted first: the tab a finding is shown on, or none for one an adopted waiver relieves. */
function tabOf(entry: OpenFindingEntry): 'counted' | 'proposed' | null {
  if (entry.mode === 'shadow') return 'proposed';
  return entry.relieved ? null : 'counted';
}

/**
 * Open counted findings by pack and rule, keyed `packId ruleId`: the number the open-findings list shows for each rule.
 * Every read that says how many findings of a rule are open now counts with this, so none can differ from the list.
 */
export function countedOpenByRule(entries: readonly OpenFindingEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (tabOf(entry) === 'counted') {
      const key = `${entry.packId} ${entry.ruleId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return counts;
}

export function findingAttention(entries: readonly OpenFindingEntry[]): FindingAttention {
  const counted = entries.filter((entry) => tabOf(entry) === 'counted');
  return {
    unowned: counted.filter((entry) => !entry.owner).length,
    overdue: counted.filter((entry) => entry.action?.overdue).length,
  };
}

/** The instants the days a finding is about are narrowed to: from, included, and before, excluded. */
export interface AboutBounds {
  from?: string;
  before?: string;
}

/** Whether a YYYY-MM-DD text is a calendar date. */
export function validDay(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

/** The days a finding is about, given in the organization's time zone, as instants: from its start, until its end. */
export async function aboutBounds(
  client: PoolClient,
  tenantId: string,
  days: { aboutFrom?: string; aboutUntil?: string },
): Promise<AboutBounds> {
  if (!days.aboutFrom && !days.aboutUntil) return {};
  for (const day of [days.aboutFrom, days.aboutUntil])
    if (day && !validDay(day))
      throw new DomainError(400, 'invalid_day', `${day} is not a calendar date; give a day such as 2026-11-01`);
  if (days.aboutFrom && days.aboutUntil && days.aboutUntil < days.aboutFrom)
    throw new DomainError(400, 'invalid_day', 'The last day the findings are about comes before the first');
  const row = (
    await client.query<{ start: Date | null; stop: Date | null }>(
      `SELECT ($2::date::timestamp AT TIME ZONE z.zone) AS start,(($3::date+1)::timestamp AT TIME ZONE z.zone) AS stop
       FROM (SELECT COALESCE(time_zone,'UTC') AS zone FROM tenants WHERE id=$1) z`,
      [tenantId, days.aboutFrom ?? null, days.aboutUntil ?? null],
    )
  ).rows[0];
  return {
    ...(row?.start ? { from: row.start.toISOString() } : {}),
    ...(row?.stop ? { before: row.stop.toISOString() } : {}),
  };
}

function withinAbout(entry: OpenFindingEntry, about: AboutBounds): boolean {
  return (!about.from || entry.aboutAt >= about.from) && (!about.before || entry.aboutAt < about.before);
}

/**
 * When a finding is about: the earliest time (an interval's start, else when it occurred) of the current records about
 * its subject, neither replaced nor withdrawn; when its subject has none, when it opened. `f` is the finding's row.
 */
export const findingAboutAt = `COALESCE((SELECT min(o.span_start) FROM observations o WHERE o.tenant_id=f.tenant_id
    AND ((f.subject_scope='ledger' AND o.subject_ledger_id=f.subject_id) OR (f.subject_scope='source'
      AND o.subject_scope='source' AND o.source_id=f.subject_source_id AND o.subject_kind=f.subject_kind
      AND o.subject_id=f.subject_id))
    AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)),
  f.opened_at)`;

/** Oldest first, then by id, so a page boundary is stable. */
function byAge(left: OpenFindingEntry, right: OpenFindingEntry): number {
  return left.openedAt < right.openedAt
    ? -1
    : left.openedAt > right.openedAt
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;
}

function encodeCursor(entry: OpenFindingEntry): string {
  return Buffer.from(JSON.stringify([entry.openedAt, entry.id])).toString('base64url');
}

function decodeCursor(cursor: string | undefined): [string, string] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'string'))
      return value as [string, string];
  } catch {
    // Reported below.
  }
  throw new DomainError(400, 'invalid_cursor', 'The page cursor is not one this list gave');
}

/**
 * One tab of the list: its findings oldest first, filtered by subject kind, pack and owner (`none` for nobody), a page
 * at a time; with the counts of every tab, what needs attention and the values the tab's findings hold to filter by.
 */
type TabFilters = Pick<OpenFindingsQuery, 'shown' | 'subjectKind' | 'packId' | 'ruleId' | 'owner' | 'result'>;

/** The findings of the shown tab the filters select, oldest first. */
function filtered(entries: readonly OpenFindingEntry[], query: TabFilters, about: AboutBounds): OpenFindingEntry[] {
  const shown = query.shown ?? 'counted';
  return entries
    .filter(
      (entry) =>
        tabOf(entry) === shown &&
        (!query.subjectKind || entry.subject.kind === query.subjectKind) &&
        (!query.packId || entry.packId === query.packId) &&
        (!query.ruleId || entry.ruleId === query.ruleId) &&
        (!query.owner || (query.owner === 'none' ? !entry.owner : entry.owner?.id === query.owner)) &&
        (!query.result || (query.result === 'cleared') === entry.cleared) &&
        withinAbout(entry, about),
    )
    .sort(byAge);
}

/** What every read of open findings says beside its findings: the tab counts, attention, and values to filter by. */
function tabSummary(entries: readonly OpenFindingEntry[], shown: 'counted' | 'proposed') {
  const tab = entries.filter((entry) => tabOf(entry) === shown);
  const packs = new Map(tab.map((entry) => [entry.packId, entry.packTitle]));
  const owners = new Map(tab.flatMap((entry) => (entry.owner ? [[entry.owner.id, entry.owner.name] as const] : [])));
  return {
    counts: {
      counted: entries.filter((entry) => tabOf(entry) === 'counted').length,
      proposed: entries.filter((entry) => tabOf(entry) === 'proposed').length,
      relieved: entries.filter((entry) => tabOf(entry) === null).length,
    },
    attention: findingAttention(entries),
    filters: {
      subjectKinds: [...new Set(tab.map((entry) => entry.subject.kind))].sort(),
      packs: [...packs].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
      owners: [...owners].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

export function selectOpenFindings(
  entries: readonly OpenFindingEntry[],
  query: OpenFindingsQuery,
  about: AboutBounds = {},
): Omit<OpenFindingsResponse, 'findings' | 'truncated' | 'computedAt'> & { findings: OpenFindingEntry[] } {
  const shown = query.shown ?? 'counted';
  const after = decodeCursor(query.cursor);
  const limit = Math.min(query.limit ?? 50, OPEN_FINDING_PAGE_LIMIT);
  const matching = filtered(entries, query, about);
  const rest = after
    ? matching.filter((entry) => entry.openedAt > after[0] || (entry.openedAt === after[0] && entry.id > after[1]))
    : matching;
  const page = rest.slice(0, limit);
  const hasMore = rest.length > limit;
  return {
    shown,
    findings: page,
    matching: matching.length,
    page: { limit, hasMore, nextCursor: hasMore ? encodeCursor(page.at(-1)!) : null },
    ...tabSummary(entries, shown),
  };
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The open findings of the shown tab the filters select, one group per pack and rule: how many are open, about how
 * many subjects, how many owned and supported by the record now, the oldest opening and the earliest and latest time
 * they are about. Fewest open first unless `order` is most; ties by pack title, then rule id.
 */
export function groupOpenFindings(
  entries: readonly OpenFindingEntry[],
  query: OpenFindingGroupsQuery,
  about: AboutBounds = {},
): Omit<OpenFindingGroupsResponse, 'truncated' | 'computedAt'> {
  const shown = query.shown ?? 'counted';
  const order = query.order ?? 'fewest';
  const groups = new Map<string, { group: OpenFindingGroup; subjects: Set<string> }>();
  const selected = filtered(entries, query, about);
  for (const entry of selected) {
    const key = `${entry.packId}\u0000${entry.ruleId}`;
    let held = groups.get(key);
    if (!held) {
      held = {
        group: {
          packId: entry.packId,
          packTitle: entry.packTitle,
          ruleId: entry.ruleId,
          ruleTitle: entry.ruleTitle,
          paragraph: entry.paragraph,
          open: 0,
          subjects: 0,
          owned: 0,
          cleared: 0,
          oldestOpenedAt: entry.openedAt,
          aboutFrom: entry.aboutAt,
          aboutUntil: entry.aboutAt,
        },
        subjects: new Set(),
      };
      groups.set(key, held);
    }
    const { group } = held;
    group.open += 1;
    if (entry.owner) group.owned += 1;
    if (entry.cleared) group.cleared += 1;
    held.subjects.add(subjectReferenceKey(entry.subject));
    if (entry.openedAt < group.oldestOpenedAt) group.oldestOpenedAt = entry.openedAt;
    if (entry.aboutAt < group.aboutFrom) group.aboutFrom = entry.aboutAt;
    if (entry.aboutAt > group.aboutUntil) group.aboutUntil = entry.aboutAt;
  }
  const listed = [...groups.values()]
    .map(({ group, subjects }) => ({ ...group, subjects: subjects.size }))
    .sort(
      (left, right) =>
        (order === 'most' ? right.open - left.open : left.open - right.open) ||
        compareText(left.packTitle, right.packTitle) ||
        compareText(left.ruleId, right.ruleId),
    );
  return {
    shown,
    order,
    groups: listed,
    total: { findings: selected.length, rules: listed.length },
    ...tabSummary(entries, shown),
  };
}

interface OpenRow extends FindingWorkRow {
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
  pack_id: string;
  pack_version: number;
  leaf_id: string;
  related_name: string | null;
  related_scope: SubjectReference['scope'] | null;
  related_kind: SubjectReference['kind'] | null;
  related_id: string | null;
  related_source_id: string | null;
  opened_at: Date;
  status: OpenFinding['status'];
  owner_id: string | null;
  owner_name: string | null;
  mode: string | null;
  outcome: string;
  issues: boolean;
  rule_title: string;
  paragraph: string | null;
  summary: string;
  evaluation_id: string;
  about_at: Date;
  now: Date;
}

function reference(
  scope: SubjectReference['scope'],
  kind: SubjectReference['kind'],
  id: string,
  sourceId: string | null,
): SubjectReference {
  return scope === 'source' ? { scope, kind, id, sourceId: sourceId! } : { scope, kind, id };
}

const DAY = 86_400_000;

/** Every open finding the generic evaluator opened in the organization, oldest first, at most the bound and one more. */
export async function readOpenFindingEntries(
  client: PoolClient,
  tenantId: string,
  bound = OPEN_FINDING_LIMIT,
): Promise<{ entries: OpenFindingEntry[]; truncated: boolean; now: Date }> {
  const rows = await client.query<OpenRow>(
    `SELECT f.id,f.subject_scope,f.subject_kind,f.subject_id,f.subject_source_id,f.pack_id,
       (r.record->'pack'->>'version')::int AS pack_version,f.leaf_id,f.related_name,f.related_scope,f.related_kind,
       f.related_id,f.related_source_id,f.opened_at,v.status,v.owner_id,p.name AS owner_name,${findingWorkColumns},
       r.record->'adoption'->>'mode' AS mode,r.outcome,r.record->'rule'->>'title' AS rule_title,
       r.record->'rule'->'source'->>'reference' AS paragraph,r.record->>'summary' AS summary,
       jsonb_array_length(COALESCE(r.record->'issues','[]'::jsonb))>0 AS issues,r.id AS evaluation_id,
       ${findingAboutAt} AS about_at,clock_timestamp() AS now
     FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
     JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
     LEFT JOIN principals p ON p.tenant_id=v.tenant_id AND p.id=v.owner_id
     WHERE f.tenant_id=$1 AND v.status<>'resolved'
     ORDER BY f.opened_at,f.id LIMIT $2`,
    [tenantId, bound + 1],
  );
  const now = rows.rows[0]?.now ?? (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const titles = new Map<string, string>();
  const packTitle = (packId: string, version: number) => {
    const key = `${packId}@${version}`;
    if (!titles.has(key)) titles.set(key, getRulePackVersion(packId, version)?.title ?? packId);
    return titles.get(key)!;
  };
  const entries = rows.rows.slice(0, bound).map((row): OpenFindingEntry => {
    const action = findingActionOf(row);
    return {
      id: row.id,
      subject: reference(row.subject_scope, row.subject_kind, row.subject_id, row.subject_source_id),
      ...(row.related_scope && row.related_kind && row.related_id
        ? {
            related: {
              name: row.related_name ?? '',
              subject: reference(row.related_scope, row.related_kind, row.related_id, row.related_source_id),
            },
          }
        : {}),
      packId: row.pack_id,
      packTitle: packTitle(row.pack_id, row.pack_version),
      ruleId: row.leaf_id,
      ruleTitle: row.rule_title,
      paragraph: row.paragraph ?? '',
      summary: row.summary,
      evaluationId: row.evaluation_id,
      aboutAt: row.about_at.toISOString(),
      cleared: row.outcome === 'pass' && !row.issues,
      mode: row.mode === 'shadow' ? 'shadow' : 'active',
      status: row.status,
      owner: row.owner_id ? { id: row.owner_id, name: row.owner_name ?? row.owner_id } : null,
      openedAt: row.opened_at.toISOString(),
      ageDays: Math.max(0, Math.floor((now.getTime() - row.opened_at.getTime()) / DAY)),
      ...(action ? { action } : {}),
      relieved: row.outcome === 'relieved',
    };
  });
  return { entries, truncated: rows.rows.length > bound, now };
}

function requireEvidenceRead(principal: AuthContext): void {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'capability_required', 'Reading findings requires evidence:read');
}

/** GET /v1/organization/open-findings. */
export async function listOpenFindings(
  client: PoolClient,
  principal: AuthContext,
  query: OpenFindingsQuery,
): Promise<OpenFindingsResponse> {
  requireEvidenceRead(principal);
  const about = await aboutBounds(client, principal.tenantId, query);
  const { entries, truncated, now } = await readOpenFindingEntries(client, principal.tenantId);
  const selected = selectOpenFindings(entries, query, about);
  const names = await subjectNames(
    client,
    principal.tenantId,
    selected.findings.flatMap((entry) => [entry.subject, ...(entry.related ? [entry.related.subject] : [])]),
  );
  const named = (subject: SubjectReference): NamedSubject =>
    names.get(subjectReferenceKey(subject)) ?? { ...subject, name: subject.id };
  return {
    ...selected,
    findings: selected.findings.map(({ relieved: _relieved, related, ...entry }) => ({
      ...entry,
      subject: named(entry.subject),
      ...(related ? { related: { name: related.name, subject: named(related.subject) } } : {}),
    })),
    truncated,
    computedAt: now.toISOString(),
  };
}

/** GET /v1/organization/open-findings/groups. */
export async function listOpenFindingGroups(
  client: PoolClient,
  principal: AuthContext,
  query: OpenFindingGroupsQuery,
): Promise<OpenFindingGroupsResponse> {
  requireEvidenceRead(principal);
  const about = await aboutBounds(client, principal.tenantId, query);
  const { entries, truncated, now } = await readOpenFindingEntries(client, principal.tenantId);
  return { ...groupOpenFindings(entries, query, about), truncated, computedAt: now.toISOString() };
}

interface PlanRow {
  subject_id: string;
  starts_at: Date;
  ends_at: Date;
  aircraft_kind: string | null;
  aircraft_id: string | null;
  aircraft_scope: SubjectReference['scope'] | null;
}

/** Current records of one operator record type, neither replaced nor withdrawn, about flights the source names. */
const currentRecords = `o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=$3 AND o.subject_scope='source'
  AND o.subject_kind='flight' AND o.observation->'values'->>'recordType'=$4
  AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)`;

/**
 * GET /v1/organization/flights-on-record: whether the organization has an order source on record (a source that may
 * create flights, or orders or flight intents one sent), and the
 * flights its own current flight plan records give, upcoming (soonest first) and recent (latest first), each with the
 * aircraft its plan names, the person a current role assignment names as pilot in command and its counted open
 * findings; with what needs attention.
 */
export async function getFlightsOnRecord(client: PoolClient, principal: AuthContext): Promise<FlightsOnRecordResponse> {
  requireEvidenceRead(principal);
  const tenantId = principal.tenantId;
  const sourceId = OPERATOR_RECORD_SOURCE_ID;
  // A source on record that may create flights, or anything such a source has sent.
  const orderSource =
    (
      await client.query(
        `SELECT 1 WHERE EXISTS(SELECT 1 FROM principals WHERE tenant_id=$1 AND kind='source' AND active
           AND 'flight:create'=ANY(capabilities))
         OR EXISTS(SELECT 1 FROM receipts WHERE tenant_id=$1 AND kind IN ('order.revision','intent.revision'))`,
        [tenantId],
      )
    ).rowCount !== 0;
  const plans = await client.query<PlanRow & { now: Date }>(
    `SELECT DISTINCT ON(o.subject_id) o.subject_id,o.interval_start AS starts_at,o.interval_end AS ends_at,
       o.secondary_subject_kind AS aircraft_kind,o.secondary_subject_id AS aircraft_id,
       o.secondary_subject_scope AS aircraft_scope,clock_timestamp() AS now
     FROM observations o WHERE ${currentRecords} AND o.interval_start IS NOT NULL AND o.interval_end IS NOT NULL
     ORDER BY o.subject_id,o.received_at DESC,o.id DESC LIMIT $5`,
    [tenantId, sourceId, OPERATOR_RECORD_CARRIER, 'flight.plan', OPEN_FINDING_LIMIT + 1],
  );
  const now = plans.rows[0]?.now ?? new Date();
  const ordered = plans.rows.slice(0, OPEN_FINDING_LIMIT);
  const upcoming = ordered
    .filter((row) => row.starts_at.getTime() >= now.getTime())
    .sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime() || a.subject_id.localeCompare(b.subject_id))
    .slice(0, FLIGHTS_ON_RECORD_LIMIT);
  const recent = ordered
    .filter((row) => row.starts_at.getTime() < now.getTime())
    .sort((a, b) => b.starts_at.getTime() - a.starts_at.getTime() || a.subject_id.localeCompare(b.subject_id))
    .slice(0, FLIGHTS_ON_RECORD_LIMIT);
  const shown = [...upcoming, ...recent];
  const flightIds = shown.map((row) => row.subject_id);
  const pilots = new Map(
    (
      await client.query<{ subject_id: string; person_id: string }>(
        // A reference field holds the id and the scope it was written in; an older record may hold the id alone.
        `SELECT DISTINCT ON(o.subject_id) o.subject_id,COALESCE(o.observation->'values'->'record'->'personId'->>'id',
           o.observation->'values'->'record'->>'personId') AS person_id
         FROM observations o WHERE ${currentRecords} AND o.subject_id=ANY($5::text[])
           AND o.observation->'values'->'record'->>'role'='pilot_in_command'
         ORDER BY o.subject_id,o.span_start DESC,o.received_at DESC,o.id DESC`,
        [tenantId, sourceId, OPERATOR_RECORD_CARRIER, 'operation.role-assignment', flightIds],
      )
    ).rows.map((row) => [row.subject_id, row.person_id]),
  );
  const flight = (id: string): SubjectReference => ({ scope: 'source', kind: 'flight', id, sourceId });
  const aircraftOf = (row: PlanRow): SubjectReference | null =>
    row.aircraft_kind === 'aircraft' && row.aircraft_id
      ? row.aircraft_scope === 'ledger'
        ? { scope: 'ledger', kind: 'aircraft', id: row.aircraft_id }
        : { scope: 'source', kind: 'aircraft', id: row.aircraft_id, sourceId }
      : null;
  const person = (id: string | undefined): SubjectReference | null =>
    id ? { scope: 'source', kind: 'person', id, sourceId } : null;
  const references = shown.flatMap((row) => [
    flight(row.subject_id),
    ...[aircraftOf(row), person(pilots.get(row.subject_id))].filter((item): item is SubjectReference => !!item),
  ]);
  const names = await subjectNames(client, tenantId, references);
  const named = (subject: SubjectReference | null): NamedSubject | null =>
    subject ? (names.get(subjectReferenceKey(subject)) ?? { ...subject, name: subject.id }) : null;
  const { entries } = await readOpenFindingEntries(client, tenantId);
  const counted = new Map<string, number>();
  for (const entry of entries)
    if (entry.mode === 'active' && !entry.relieved) {
      const key = subjectReferenceKey(entry.subject);
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  const onRecord = (row: PlanRow): FlightOnRecord => ({
    subject: named(flight(row.subject_id))!,
    window: { start: row.starts_at.toISOString(), end: row.ends_at.toISOString() },
    aircraft: named(aircraftOf(row)),
    pilotInCommand: named(person(pilots.get(row.subject_id))),
    openFindings: counted.get(subjectReferenceKey(flight(row.subject_id))) ?? 0,
  });
  return {
    orderSource,
    upcoming: upcoming.map(onRecord),
    recent: recent.map(onRecord),
    truncated: plans.rows.length > OPEN_FINDING_LIMIT,
    attention: findingAttention(entries),
    computedAt: now.toISOString(),
  };
}
