import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  PROGRAM_GRANT_DEFAULT_DAYS,
  PROGRAM_VIEW_VERSION,
  type PackAdoptionRecord,
  type ProgramGrant,
  type ProgramGrantCreate,
  type ProgramGrantCreated,
  type ProgramGrantRead,
  type ProgramViewDocument,
  type ProgramViewFindingRule,
  type ProgramViewPack,
  type RecordProduction,
} from '@ledger/contracts';
import {
  getAdoptionRuleCoverage,
  groupOpenFindings,
  readOpenFindingEntries,
  standingAdoptionRecords,
} from '@ledger/domain';
import { sha256 } from '@ledger/integrity';
import { appendEvent, DomainError, withScope, type AuthContext, type Pool, type PoolClient } from '@ledger/persistence';

/**
 * Grants to a program owner (docs/design/program-owner-view.md): made and revoked by whoever manages authority, read
 * without sign-in by whoever holds the secret. A read answers counts only, in the organization's own scope.
 */

const READS_SHOWN = 200;
const LISTED = 200;
const DAY = 86_400_000;

function requireAuthority(principal: AuthContext): void {
  if (!principal.capabilities.includes('authority:write'))
    throw new DomainError(
      403,
      'capability_required',
      'Grants to a program owner are made by a person with authority:write',
    );
}

/**
 * The secret of a link a grant made: derived from the grant's own secret, so the link works for whoever holds the
 * grant and Ledger keeps only its hash, as for any link.
 */
export function grantLinkSecret(grantSecret: string, linkId: string): string {
  return `ledger-records-${createHmac('sha256', grantSecret).update(`record-link:${linkId}`).digest('base64url')}`;
}

interface GrantRow {
  id: string;
  program_owner: string;
  packs: string[];
  open_findings: boolean;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  expires_at: Date;
  revoked_by: string | null;
  revoked_by_name: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  read_count: string;
  now: Date;
}

async function packTitles(client: PoolClient, tenantId: string): Promise<Map<string, string>> {
  const standing = await standingAdoptionRecords(client, tenantId, new Date().toISOString());
  const titles = new Map<string, string>();
  for (const adoption of standing)
    if (!titles.has(adoption.pack.packId)) titles.set(adoption.pack.packId, adoption.pack.title);
  return titles;
}

async function readGrants(client: PoolClient, tenantId: string, id?: string): Promise<ProgramGrant[]> {
  const rows = (
    await client.query<GrantRow>(
      `SELECT g.id,g.program_owner,g.packs,g.open_findings,g.created_by,c.name AS created_by_name,g.created_at,
         g.expires_at,g.revoked_by,r.name AS revoked_by_name,g.revoked_at,g.revoke_reason,
         (SELECT count(*) FROM program_grant_reads x WHERE x.tenant_id=g.tenant_id AND x.grant_id=g.id) AS read_count,
         clock_timestamp() AS now
       FROM program_grants g
       JOIN principals c ON c.tenant_id=g.tenant_id AND c.id=g.created_by
       LEFT JOIN principals r ON r.tenant_id=g.tenant_id AND r.id=g.revoked_by
       WHERE g.tenant_id=$1 AND ($2::text IS NULL OR g.id=$2)
       ORDER BY g.created_at DESC,g.id LIMIT $3`,
      [tenantId, id ?? null, LISTED],
    )
  ).rows;
  const ids = rows.map((row) => row.id);
  const reads = await client.query<{ grant_id: string; read_at: Date; parts: string[] }>(
    `SELECT grant_id,read_at,parts FROM (
       SELECT x.*,row_number() OVER (PARTITION BY x.grant_id ORDER BY x.read_at DESC,x.id DESC) AS place
       FROM program_grant_reads x WHERE x.tenant_id=$1 AND x.grant_id=ANY($2::text[])) shown
     WHERE place<=$3 ORDER BY read_at DESC,id DESC`,
    [tenantId, ids, READS_SHOWN],
  );
  const productions = await client.query<{
    grant_id: string;
    link_id: string;
    id: string;
    produced_at: Date;
    record_count: number;
    metadata: RecordProduction;
  }>(
    `SELECT l.program_grant_id AS grant_id,l.id AS link_id,p.id,p.produced_at,p.record_count,p.metadata
     FROM record_production_links l
     JOIN record_productions p ON p.tenant_id=l.tenant_id AND p.id=l.production_id
     WHERE l.tenant_id=$1 AND l.program_grant_id=ANY($2::text[]) ORDER BY l.id`,
    [tenantId, ids],
  );
  const titles = rows.length ? await packTitles(client, tenantId) : new Map<string, string>();
  return rows.map((row) => ({
    id: row.id,
    programOwner: row.program_owner,
    createdBy: { id: row.created_by, name: row.created_by_name },
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedBy: row.revoked_by ? { id: row.revoked_by, name: row.revoked_by_name ?? row.revoked_by } : null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokeReason: row.revoke_reason,
    state: row.revoked_at ? 'revoked' : row.expires_at <= row.now ? 'expired' : 'in_force',
    covers: {
      packs: row.packs.map((packId) => ({ packId, title: titles.get(packId) ?? packId })),
      openFindings: row.open_findings,
      productions: productions.rows
        .filter((production) => production.grant_id === row.id)
        .map((production) => ({
          id: production.id,
          producedAt: production.produced_at.toISOString(),
          records: production.record_count,
          linkId: production.link_id,
          reason: production.metadata.reason,
        })),
    },
    readCount: Number(row.read_count),
    reads: reads.rows
      .filter((read) => read.grant_id === row.id)
      .map((read): ProgramGrantRead => ({ readAt: read.read_at.toISOString(), parts: read.parts })),
  }));
}

/** Every grant the organization made, newest first, with its state, what it covers and its reads. Never a secret. */
export async function listProgramGrants(
  client: PoolClient,
  principal: AuthContext,
): Promise<{ grants: ProgramGrant[] }> {
  requireAuthority(principal);
  return { grants: await readGrants(client, principal.tenantId) };
}

/** Makes a grant. Its secret is returned here once; only its SHA-256 is kept, and its links' secrets derive from it. */
export async function createProgramGrant(
  client: PoolClient,
  principal: AuthContext,
  input: ProgramGrantCreate,
): Promise<ProgramGrantCreated> {
  requireAuthority(principal);
  const programOwner = input.programOwner.trim();
  if (!input.packs.length && !input.openFindings && !input.productions.length)
    throw new DomainError(
      400,
      'program_grant_empty',
      'Choose what the grant shows: the coverage of a pack, the open findings or a produced set',
    );
  const adopted = new Set(
    (await standingAdoptionRecords(client, principal.tenantId, new Date().toISOString())).map(
      (adoption) => adoption.pack.packId,
    ),
  );
  const notAdopted = input.packs.filter((packId) => !adopted.has(packId));
  if (notAdopted.length)
    throw new DomainError(
      400,
      'pack_not_adopted',
      `Your organization has no adoption that stands now of ${notAdopted.join(', ')}`,
    );
  const found = await client.query<{ id: string }>(
    'SELECT id FROM record_productions WHERE tenant_id=$1 AND id=ANY($2::text[])',
    [principal.tenantId, input.productions],
  );
  if (found.rowCount !== input.productions.length)
    throw new DomainError(
      404,
      'production_not_found',
      'A produced set the grant names was not found within your scope',
    );
  const days = input.expiresInDays ?? PROGRAM_GRANT_DEFAULT_DAYS;
  const id = `program-grant-${randomUUID()}`;
  const secret = `ledger-program-${randomBytes(32).toString('base64url')}`;
  const links = input.productions.map((productionId) => ({ productionId, linkId: `record-link-${randomUUID()}` }));
  const event = await appendEvent(client, principal, {
    type: 'program-grant.create',
    stream: `program-grant:${id}`,
    payload: {
      grantId: id,
      programOwner,
      expiresInDays: days,
      packs: input.packs,
      openFindings: input.openFindings,
      links,
    },
  });
  const expiresAt = (
    await client.query<{ expires_at: Date }>(
      `INSERT INTO program_grants(id,tenant_id,program_owner,secret_sha256,packs,open_findings,create_event_id,created_by,
         created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::timestamptz+make_interval(days=>$10::int))
       RETURNING expires_at`,
      [
        id,
        principal.tenantId,
        programOwner,
        sha256(secret),
        input.packs,
        input.openFindings,
        event.id,
        principal.id,
        event.received_at,
        days,
      ],
    )
  ).rows[0]!.expires_at;
  const note = `For ${programOwner} under a program grant`.slice(0, 300);
  for (const { productionId, linkId } of links)
    await client.query(
      `INSERT INTO record_production_links(id,tenant_id,production_id,note,secret_sha256,create_event_id,created_by,
         created_at,expires_at,program_grant_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        linkId,
        principal.tenantId,
        productionId,
        note,
        sha256(grantLinkSecret(secret, linkId)),
        event.id,
        principal.id,
        event.received_at,
        expiresAt,
        id,
      ],
    );
  const [made] = await readGrants(client, principal.tenantId, id);
  return { grant: made!, secret };
}

/** Revokes a grant at once, with the reason, and the links made with it. A revoked grant answers nothing. */
export async function revokeProgramGrant(
  client: PoolClient,
  principal: AuthContext,
  id: string,
  reason: string,
): Promise<{ grant: ProgramGrant }> {
  requireAuthority(principal);
  const held = (
    await client.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM program_grants WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [principal.tenantId, id],
    )
  ).rows[0];
  if (!held) throw new DomainError(404, 'program_grant_not_found', 'The grant was not found in your organization');
  if (held.revoked_at) throw new DomainError(409, 'program_grant_revoked', 'This grant is already revoked');
  const links = (
    await client.query<{ id: string }>(
      `SELECT id FROM record_production_links WHERE tenant_id=$1 AND program_grant_id=$2 AND revoked_at IS NULL
       ORDER BY id FOR UPDATE`,
      [principal.tenantId, id],
    )
  ).rows.map((row) => row.id);
  const why = reason.trim();
  const event = await appendEvent(client, principal, {
    type: 'program-grant.revoke',
    stream: `program-grant:${id}`,
    payload: { grantId: id, reason: why, linkIds: links },
  });
  await client.query(
    `UPDATE program_grants SET revoke_event_id=$1,revoked_by=$2,revoked_at=$3,revoke_reason=$4
     WHERE tenant_id=$5 AND id=$6`,
    [event.id, principal.id, event.received_at, why, principal.tenantId, id],
  );
  if (links.length)
    await client.query(
      `UPDATE record_production_links SET revoke_event_id=$1,revoked_by=$2,revoked_at=$3,revoke_reason=$4
       WHERE tenant_id=$5 AND id=ANY($6::text[])`,
      [
        event.id,
        principal.id,
        event.received_at,
        `The program grant was revoked: ${why}`.slice(0, 1000),
        principal.tenantId,
        links,
      ],
    );
  const [revoked] = await readGrants(client, principal.tenantId, id);
  return { grant: revoked! };
}

// Reading a grant: no sign-in, so no organization is known until the secret's hash finds one.

/** The one answer to a secret that opens nothing: unknown, expired and revoked are not told apart. */
export function grantNotInUse(): DomainError {
  return new DomainError(
    404,
    'program_grant_not_in_use',
    'This grant opens nothing. It may have expired or been revoked.',
  );
}

interface FoundGrant {
  grant_id: string;
  tenant_id: string;
  organization_name: string;
  expires_at: Date;
  packs: string[];
  open_findings: boolean;
  worker_id: string;
}

async function packPart(
  client: PoolClient,
  who: AuthContext,
  standing: readonly PackAdoptionRecord[],
  packId: string,
): Promise<ProgramViewPack> {
  // Standing adoptions come highest version first within a pack.
  const adoption = standing.find((candidate) => candidate.pack.packId === packId);
  if (!adoption) return { packId, title: packId, version: null, mode: null, rules: [] };
  const coverage = await getAdoptionRuleCoverage(client, who, adoption.id);
  return {
    packId,
    title: coverage.title,
    version: coverage.version,
    mode: coverage.mode,
    rules: coverage.rules.map((rule) => ({
      ruleId: rule.leafId,
      title: rule.title,
      citation: rule.paragraph ?? null,
      checkedBy: rule.checkedBy,
      counts: rule.counts,
      complete: rule.complete,
    })),
  };
}

async function findingsPart(client: PoolClient, tenantId: string): Promise<ProgramViewDocument['openFindings']> {
  const { entries, truncated, now } = await readOpenFindingEntries(client, tenantId);
  const grouped = groupOpenFindings(entries, { shown: 'counted' });
  const rules = grouped.groups
    .map((group): ProgramViewFindingRule => ({
      packId: group.packId,
      packTitle: group.packTitle,
      ruleId: group.ruleId,
      ruleTitle: group.ruleTitle,
      citation: group.paragraph,
      open: group.open,
      oldestOpenedAt: group.oldestOpenedAt,
      oldestAgeDays: Math.max(0, Math.floor((now.getTime() - Date.parse(group.oldestOpenedAt)) / DAY)),
    }))
    // In the packs' and rules' own order: nothing here is ranked.
    .sort((a, b) => a.packTitle.localeCompare(b.packTitle) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  return { total: grouped.total.findings, truncated, rules };
}

async function recordsPart(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  secret: string,
): Promise<{ records: NonNullable<ProgramViewDocument['records']>; productions: string[] }> {
  const rows = (
    await client.query<{
      id: string;
      production_id: string;
      expires_at: Date;
      produced_at: Date;
      record_count: number;
    }>(
      `SELECT l.id,l.production_id,l.expires_at,p.produced_at,p.record_count FROM record_production_links l
       JOIN record_productions p ON p.tenant_id=l.tenant_id AND p.id=l.production_id
       WHERE l.tenant_id=$1 AND l.program_grant_id=$2 AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp()
       ORDER BY p.produced_at,l.id`,
      [tenantId, grantId],
    )
  ).rows;
  return {
    records: rows.map((row) => ({
      producedAt: row.produced_at.toISOString(),
      records: row.record_count,
      expiresAt: row.expires_at.toISOString(),
      secret: grantLinkSecret(secret, row.id),
    })),
    productions: rows.map((row) => row.production_id),
  };
}

/**
 * The document a grant's secret opens: counts of recorded things, read in the organization's own scope as its worker
 * principal. The read is kept; a grant revoked meanwhile keeps none and answers like an unknown secret.
 */
export async function readProgramView(pool: Pool, secret: string): Promise<ProgramViewDocument> {
  const hash = sha256(secret);
  const grant = (await pool.query<FoundGrant>('SELECT * FROM ledger_program_grant($1)', [hash])).rows[0];
  if (!grant) throw grantNotInUse();
  const { document, parts } = await withScope(
    pool,
    { id: grant.worker_id, tenantId: grant.tenant_id },
    async (client, who) => {
      const madeAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const document: ProgramViewDocument = {
        version: PROGRAM_VIEW_VERSION,
        operator: { name: grant.organization_name },
        madeAt: madeAt.toISOString(),
        grantExpiresAt: grant.expires_at.toISOString(),
      };
      const parts: string[] = [];
      if (grant.packs.length) {
        const standing = await standingAdoptionRecords(client, grant.tenant_id, madeAt.toISOString());
        document.packs = [];
        for (const packId of grant.packs) {
          document.packs.push(await packPart(client, who, standing, packId));
          parts.push(`pack:${packId}`);
        }
      }
      if (grant.open_findings) {
        document.openFindings = await findingsPart(client, grant.tenant_id);
        parts.push('open_findings');
      }
      const { records, productions } = await recordsPart(client, grant.tenant_id, grant.grant_id, secret);
      if (records.length) {
        document.records = records;
        parts.push(...productions.map((id) => `records:${id}`));
      }
      return { document, parts };
    },
    undefined,
    true,
  );
  const kept = (await pool.query<{ kept: boolean }>('SELECT ledger_program_grant_read($1,$2) AS kept', [hash, parts]))
    .rows[0];
  // Revoked between finding the grant and keeping the read: it answers nothing from that moment.
  if (!kept?.kept) throw grantNotInUse();
  return document;
}
