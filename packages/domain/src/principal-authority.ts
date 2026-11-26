import { randomUUID } from 'node:crypto';
import {
  OPERATOR_RECORD_SOURCE_ID,
  PRINCIPAL_AUTHORITY_LIST_LIMIT,
  retiredCapabilityValues,
  type Capability,
  type ObservationGrant,
  type OrganizationSummary,
  type PersonAddCommand,
  type PrincipalAuthorityEntry,
  type PrincipalAuthorityListQuery,
  type PrincipalAuthorityListResponse,
} from '@ledger/contracts';
import { appendEvent, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { AUTHORITY_PRINCIPAL_COLUMNS, authorityPrincipal, type AuthorityPrincipalRow } from './authority.js';
import { noticeEmails } from './notices.js';
import { replaceObservationGrants } from './observations.js';

/**
 * What an organization's first administrator may do: manage people and their authority, adopt rule packs, keep
 * operator records and the safety records. Accepting risk and reading protected reports are left out: an
 * administrator grants them to a named person, themselves included, on the People screen.
 */
export const administratorCapabilities: Capability[] = [
  'authority:write',
  'flight:read',
  'flight:create',
  'order:read',
  'evidence:read',
  'input:write',
  'decision:write',
  'correction:write',
  'identity:write',
  'pack:adopt',
  'sms:read',
  'sms:write',
  'sms:configure',
  'sms:adopt',
];
/** The grant that lets a person import and enter operator records. */
export const operatorRecordGrant: ObservationGrant = {
  sourceId: OPERATOR_RECORD_SOURCE_ID,
  observationType: 'operator.record',
};
/** What the organization's own worker may do; the worker carries out queued work for the tenant. */
const workerCapabilities: Capability[] = [
  'input:write',
  'flight:create',
  'flight:read',
  'order:read',
  'evidence:read',
  'identity:write',
];

export interface SignInIdentity {
  issuer: string;
  subject: string;
}
export interface NewPrincipal {
  name: string;
  kind: PersonAddCommand['principalKind'];
  capabilities: Capability[];
  observationGrants?: ObservationGrant[];
  signIn?: SignInIdentity;
}

export function validTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export async function getOrganizationSummary(client: PoolClient, tenantId: string): Promise<OrganizationSummary> {
  const row = (
    await client.query<{ id: string; name: string; time_zone: string }>(
      'SELECT id,name,time_zone FROM tenants WHERE id=$1',
      [tenantId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'organization_not_found', 'Organization was not found within your scope');
  return { id: row.id, name: row.name, timeZone: row.time_zone };
}

function refuseRetiredCapabilities(capabilities: readonly string[]): void {
  const retired = capabilities.find((capability) =>
    (retiredCapabilityValues as readonly string[]).includes(capability),
  );
  if (retired) throw new DomainError(400, 'capability_retired', `${retired} is retired and is no longer granted`);
}

/** Inserts one principal with its authority; the caller records the command that added it. */
async function insertPrincipal(
  client: PoolClient,
  tenantId: string,
  id: string,
  principal: NewPrincipal,
): Promise<void> {
  refuseRetiredCapabilities(principal.capabilities);
  if (principal.signIn && principal.kind !== 'human')
    throw new DomainError(400, 'sign_in_for_people_only', 'Only a person signs in with an identity-provider account');
  try {
    await client.query(
      `INSERT INTO principals(id,tenant_id,name,kind,capabilities,sign_in_issuer,sign_in_subject)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        tenantId,
        principal.name.trim(),
        principal.kind,
        principal.capabilities,
        principal.signIn?.issuer ?? null,
        principal.signIn?.subject ?? null,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new DomainError(
        409,
        'sign_in_identity_in_use',
        'This sign-in account is already tied to another principal',
      );
    throw error;
  }
  if (principal.observationGrants?.length)
    await replaceObservationGrants(client, tenantId, id, principal.observationGrants);
}

/** Records a principal's addition as a command by the actor, under the authority the actor holds now. */
async function recordAddition(
  client: PoolClient,
  actor: AuthContext,
  id: string,
  principal: NewPrincipal,
  firstAdministrator: boolean,
  note?: string,
): Promise<string> {
  // The sign-in account is tied to the principal; the journal records only that one is.
  const payload = {
    kind: 'person.add',
    principalId: id,
    name: principal.name.trim(),
    principalKind: principal.kind,
    capabilities: principal.capabilities,
    ...(principal.observationGrants ? { observationGrants: principal.observationGrants } : {}),
    signInLinked: Boolean(principal.signIn),
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(firstAdministrator ? { firstAdministrator: true } : {}),
  };
  const event = await appendEvent(client, actor, { type: 'person.add', stream: `authority:${id}`, payload });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, actor.tenantId, 'person.add', actor.id, event.received_at, payload],
  );
  return event.id;
}

/** The issuer the actor signs in through: a person added beside them signs in through the same provider. */
async function actorIssuer(client: PoolClient, actor: AuthContext): Promise<string> {
  const issuer = (
    await client.query<{ sign_in_issuer: string | null }>('SELECT sign_in_issuer FROM principals WHERE id=$1', [
      actor.id,
    ])
  ).rows[0]?.sign_in_issuer;
  if (!issuer)
    throw new DomainError(
      400,
      'sign_in_issuer_required',
      "You do not sign in through an identity provider, so name the sign-in account's issuer",
    );
  return issuer;
}

/** person.add: returns the id of the recorded command. */
export async function addPerson(client: PoolClient, actor: AuthContext, command: PersonAddCommand): Promise<string> {
  // The id says what it names: person-, source- or service-.
  const id = `${command.principalKind === 'human' ? 'person' : command.principalKind}-${randomUUID()}`;
  const principal: NewPrincipal = {
    name: command.name,
    kind: command.principalKind,
    capabilities: command.capabilities,
    ...(command.observationGrants ? { observationGrants: command.observationGrants } : {}),
    ...(command.signIn
      ? {
          signIn: {
            issuer: command.signIn.issuer ?? (await actorIssuer(client, actor)),
            subject: command.signIn.subject,
          },
        }
      : {}),
  };
  await insertPrincipal(client, actor.tenantId, id, principal);
  return recordAddition(client, actor, id, principal, false, command.note);
}

export interface OrganizationCreation {
  tenantId: string;
  name: string;
  timeZone: string;
  administrator: { name: string; signIn?: SignInIdentity };
  /** SHA-256 of a development token; only for local and test databases. */
  developmentTokenHash?: string;
}
export type OrganizationCreationResult =
  | { created: true; organization: OrganizationSummary; administratorId: string }
  | { created: false; organization: OrganizationSummary };

/**
 * Creates an organization, its worker and its first administrator in the caller's transaction, on the owner
 * connection, since no one in the organization exists yet to do it through the API. An organization that already
 * exists is left exactly as it is.
 */
export async function createOrganization(
  client: PoolClient,
  creation: OrganizationCreation,
): Promise<OrganizationCreationResult> {
  if (!validTimeZone(creation.timeZone))
    throw new DomainError(400, 'unknown_time_zone', `${creation.timeZone} is not an IANA time zone name`);
  await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [creation.tenantId]);
  // Two runs at once for one organization: the second waits here, then finds it.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ledger:organization-create:' || $1))", [
    creation.tenantId,
  ]);
  const existing = await client.query('SELECT 1 FROM tenants WHERE id=$1', [creation.tenantId]);
  if (existing.rowCount)
    return { created: false, organization: await getOrganizationSummary(client, creation.tenantId) };
  await client.query('INSERT INTO tenants(id,name,time_zone) VALUES($1,$2,$3)', [
    creation.tenantId,
    creation.name.trim(),
    creation.timeZone,
  ]);
  const slug = creation.tenantId.replace(/^tenant-/, '');
  await client.query(`INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)`, [
    `worker-${slug}`,
    creation.tenantId,
    `${creation.name.trim()} worker`,
    workerCapabilities,
  ]);
  const administratorId = `person-${randomUUID()}`;
  const administrator: NewPrincipal = {
    name: creation.administrator.name,
    kind: 'human',
    capabilities: administratorCapabilities,
    observationGrants: [operatorRecordGrant],
    ...(creation.administrator.signIn ? { signIn: creation.administrator.signIn } : {}),
  };
  await insertPrincipal(client, creation.tenantId, administratorId, administrator);
  if (creation.developmentTokenHash)
    await client.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      creation.developmentTokenHash,
      administratorId,
    ]);
  await client.query("SELECT set_config('ledger.principal_id',$1,true)", [administratorId]);
  const actor: AuthContext = {
    id: administratorId,
    tenantId: creation.tenantId,
    name: administrator.name.trim(),
    kind: 'human',
    capabilities: administratorCapabilities,
    revision: 1,
  };
  await recordAddition(client, actor, administratorId, administrator, true);
  return {
    created: true,
    organization: await getOrganizationSummary(client, creation.tenantId),
    administratorId,
  };
}

/** A page's position in the list: the name and id of its last entry, as the order compares them. */
function principalCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}
function readPrincipalCursor(cursor: string): [string, string] {
  try {
    const position: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(position) &&
      position.length === 2 &&
      position.every((part) => typeof part === 'string') &&
      principalCursor(position[0], position[1]) === cursor
    )
      return [position[0], position[1]];
  } catch {
    // Refused below, like any other cursor this list did not give.
  }
  throw new DomainError(400, 'invalid_cursor', 'The people list cursor is not one this list gave');
}

/**
 * Everyone in the organization but its worker and its reporting channel, active or not, with their current authority,
 * by name and then id, a page at a time.
 */
export async function listPrincipalAuthority(
  client: PoolClient,
  principal: AuthContext,
  query: PrincipalAuthorityListQuery = {},
): Promise<PrincipalAuthorityListResponse> {
  if (!principal.capabilities.includes('authority:write'))
    throw new DomainError(403, 'capability_required', 'Reading principal authority requires authority:write');
  const limit = Math.min(query.limit ?? PRINCIPAL_AUTHORITY_LIST_LIMIT, PRINCIPAL_AUTHORITY_LIST_LIMIT);
  const after = query.cursor ? readPrincipalCursor(query.cursor) : null;
  const rows = (
    await client.query<AuthorityPrincipalRow & { sign_in_linked: boolean }>(
      `SELECT ${AUTHORITY_PRINCIPAL_COLUMNS},sign_in_subject IS NOT NULL AS sign_in_linked
       FROM principals WHERE tenant_id=$1 AND kind NOT IN ('worker','intake')
         AND ($3::text IS NULL OR (name COLLATE "C",id COLLATE "C")>($3::text COLLATE "C",$4::text COLLATE "C"))
       ORDER BY name COLLATE "C",id COLLATE "C" LIMIT $2`,
      [principal.tenantId, limit + 1, after?.[0] ?? null, after?.[1] ?? null],
    )
  ).rows;
  const shown = rows.slice(0, limit);
  const grants = new Map<string, ObservationGrant[]>();
  for (const grant of (
    await client.query<{ principal_id: string; source_id: string; observation_type: string }>(
      `SELECT principal_id,source_id,observation_type FROM observation_grants WHERE tenant_id=$1 AND principal_id=ANY($2)
       ORDER BY source_id COLLATE "C",observation_type COLLATE "C"`,
      [principal.tenantId, shown.map((row) => row.id)],
    )
  ).rows)
    grants.set(grant.principal_id, [
      ...(grants.get(grant.principal_id) ?? []),
      { sourceId: grant.source_id, observationType: grant.observation_type },
    ]);
  const emails = await noticeEmails(
    client,
    principal.tenantId,
    shown.map((row) => row.id),
  );
  const principals = shown.map((row): PrincipalAuthorityEntry => ({
    ...authorityPrincipal(row, grants.get(row.id) ?? []),
    signInLinked: row.sign_in_linked,
    noticeEmail: emails.get(row.id) ?? null,
  }));
  const hasMore = rows.length > limit;
  const last = shown.at(-1);
  return { principals, hasMore, nextCursor: hasMore && last ? principalCursor(last.name, last.id) : null };
}
