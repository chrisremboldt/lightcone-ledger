import { randomBytes, randomUUID } from 'node:crypto';
import {
  CREDENTIAL_LIST_LIMIT,
  type CredentialListQuery,
  CREDENTIAL_SECRET_PREFIX,
  type CredentialEntry,
  type CredentialIssueCommand,
  type CredentialListResponse,
  type CredentialRevokeCommand,
  type IssuedCredential,
} from '@ledger/contracts';
import { DEVELOPMENT_TOKEN_PREFIX, type DevelopmentTokenResponse } from '@ledger/contracts/development-tokens';
import { sha256 } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';

/** A new secret: 256 bits from the system random source. */
export function newCredentialSecret(): string {
  return `${CREDENTIAL_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** A new development token: 192 bits from the system random source. */
export function newDevelopmentToken(): string {
  return `${DEVELOPMENT_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/** What the journal keeps of who acted: the actor and the authority they held at that moment. */
function actorAuthority(actor: AuthContext) {
  return { revision: actor.revision, capabilities: [...actor.capabilities].sort() };
}

async function recordCommand(
  client: PoolClient,
  actor: AuthContext,
  credentialId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; receivedAt: Date }> {
  const kind = String(payload.kind);
  const event = await appendEvent(client, actor, { type: kind, stream: `credential:${credentialId}`, payload });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, actor.tenantId, kind, actor.id, event.received_at, payload],
  );
  return { id: event.id, receivedAt: event.received_at };
}

/**
 * credential.issue: the secret is returned to the caller and never stored, logged or journaled; only its SHA-256
 * hash is kept, as every credential's is.
 */
export async function issueCredential(
  client: PoolClient,
  actor: AuthContext,
  command: CredentialIssueCommand,
): Promise<{ commandId: string; credential: IssuedCredential }> {
  const target = (
    await client.query<{ id: string; kind: string; active: boolean }>(
      'SELECT id,kind,active FROM principals WHERE id=$1 AND tenant_id=$2 FOR SHARE',
      [command.principalId, actor.tenantId],
    )
  ).rows[0];
  if (!target) throw new DomainError(404, 'principal_not_found', 'Principal was not found within your scope');
  if (target.kind !== 'source' && target.kind !== 'service')
    throw new DomainError(
      400,
      'credential_for_sources_and_services',
      'Only a source or a service is issued a credential; a person signs in through the identity provider',
    );
  if (!target.active)
    throw new DomainError(409, 'principal_inactive', 'This source or service is inactive; reactivate it first');
  if (command.expiresAt !== undefined) {
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (Date.parse(command.expiresAt) <= now.getTime())
      throw new DomainError(400, 'credential_expiry_past', 'The expiry must be later than now');
  }
  const id = `credential-${randomUUID()}`;
  const secret = newCredentialSecret();
  const label = command.label.trim();
  const expiresAt = command.expiresAt === undefined ? undefined : new Date(command.expiresAt).toISOString();
  const recorded = await recordCommand(client, actor, id, {
    kind: 'credential.issue',
    credentialId: id,
    principalId: target.id,
    label,
    ...(expiresAt ? { expiresAt } : {}),
    actorAuthority: actorAuthority(actor),
  });
  await client.query(
    `INSERT INTO api_credentials(id,token_hash,principal_id,label,issue_command_id,issued_by,issued_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, sha256(secret), target.id, label, recorded.id, actor.id, recorded.receivedAt, expiresAt ?? null],
  );
  return { commandId: recorded.id, credential: { id, principalId: target.id, secret } };
}

/** The label every development token is put on file with. */
export const DEVELOPMENT_TOKEN_LABEL = 'Development token';

/**
 * development-token.issue: a person's token for a local or test database, kept only as its hash, as the first
 * administrator's is. It replaces every earlier token of that person in the same transaction, so the earlier ones are
 * refused from the next request on. The token is returned to the caller and is in no read, log or journal entry.
 */
export async function issueDevelopmentToken(
  client: PoolClient,
  actor: AuthContext,
  principalId: string,
  allowed: boolean,
  note?: string,
): Promise<DevelopmentTokenResponse> {
  if (!allowed)
    throw new DomainError(
      403,
      'development_tokens_disabled',
      'Development tokens are only for a local or test database. Here a person signs in through the identity provider: tie their account to them on the People screen.',
    );
  if (actor.kind !== 'human' || !actor.capabilities.includes('authority:write'))
    throw new DomainError(
      403,
      'capability_required',
      'An administrator, a person with authority:write, issues a token',
    );
  // The person's row first, FOR UPDATE: two issues for one person take turns, and only the later token is left.
  const target = (
    await client.query<{ id: string; name: string; kind: string; active: boolean }>(
      'SELECT id,name,kind,active FROM principals WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [principalId, actor.tenantId],
    )
  ).rows[0];
  if (!target) throw new DomainError(404, 'principal_not_found', 'Principal was not found within your scope');
  if (target.kind !== 'human')
    throw new DomainError(
      400,
      'development_token_for_people',
      'A development token is for a person; a source or service is issued a credential under "Sources and services"',
    );
  if (!target.active)
    throw new DomainError(409, 'principal_inactive', `${target.name} is inactive; reactivate them first`);
  const replaced = (
    await client.query<{ id: string }>(
      `SELECT id FROM api_credentials WHERE tenant_id=$1 AND principal_id=$2 AND revoked_at IS NULL
       ORDER BY id COLLATE "C" FOR UPDATE`,
      [actor.tenantId, target.id],
    )
  ).rows.map((row) => row.id);
  const id = `credential-${randomUUID()}`;
  const token = newDevelopmentToken();
  const recorded = await recordCommand(client, actor, id, {
    kind: 'development-token.issue',
    credentialId: id,
    principalId: target.id,
    replacedCredentialIds: replaced,
    actorAuthority: actorAuthority(actor),
    ...(note ? { note } : {}),
  });
  if (replaced.length)
    await client.query(
      'UPDATE api_credentials SET revoke_command_id=$1,revoked_by=$2,revoked_at=$3 WHERE tenant_id=$4 AND id=ANY($5)',
      [recorded.id, actor.id, recorded.receivedAt, actor.tenantId, replaced],
    );
  await client.query(
    `INSERT INTO api_credentials(id,token_hash,principal_id,label,issue_command_id,issued_by,issued_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, sha256(token), target.id, DEVELOPMENT_TOKEN_LABEL, recorded.id, actor.id, recorded.receivedAt],
  );
  return {
    developmentToken: { credentialId: id, principalId: target.id, token },
    replacedCredentialIds: replaced,
    commandId: recorded.id,
  };
}

/** credential.revoke: refused from the next request on. Returns the id of the recorded command. */
export async function revokeCredential(
  client: PoolClient,
  actor: AuthContext,
  command: CredentialRevokeCommand,
): Promise<string> {
  const credential = (
    await client.query<{ id: string; principal_id: string; revoked_at: Date | null }>(
      'SELECT id,principal_id,revoked_at FROM api_credentials WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [command.credentialId, actor.tenantId],
    )
  ).rows[0];
  if (!credential) throw new DomainError(404, 'credential_not_found', 'Credential was not found within your scope');
  if (credential.revoked_at)
    throw new DomainError(409, 'credential_already_revoked', 'This credential is already revoked');
  const recorded = await recordCommand(client, actor, credential.id, {
    kind: 'credential.revoke',
    credentialId: credential.id,
    principalId: credential.principal_id,
    actorAuthority: actorAuthority(actor),
  });
  await client.query('UPDATE api_credentials SET revoke_command_id=$1,revoked_by=$2,revoked_at=$3 WHERE id=$4', [
    recorded.id,
    actor.id,
    recorded.receivedAt,
    credential.id,
  ]);
  return recorded.id;
}

interface CredentialRow {
  id: string;
  principal_id: string;
  principal_name: string;
  principal_kind: 'source' | 'service';
  principal_active: boolean;
  label: string | null;
  issued_by: string | null;
  issuer_name: string | null;
  issued_at: Date | null;
  expires_at: Date | null;
  revoked_by: string | null;
  revoker_name: string | null;
  revoked_at: Date | null;
  expired: boolean;
}

function credentialEntry(row: CredentialRow): CredentialEntry {
  return {
    id: row.id,
    principal: {
      id: row.principal_id,
      name: row.principal_name,
      kind: row.principal_kind,
      active: row.principal_active,
    },
    ...(row.label !== null ? { label: row.label } : {}),
    ...(row.issued_by !== null ? { issuedBy: { id: row.issued_by, name: row.issuer_name ?? row.issued_by } } : {}),
    ...(row.issued_at ? { issuedAt: row.issued_at.toISOString() } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    ...(row.revoked_by !== null ? { revokedBy: { id: row.revoked_by, name: row.revoker_name ?? row.revoked_by } } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
    state: row.revoked_at ? 'revoked' : row.expired ? 'expired' : 'usable',
  };
}

/** Every credential of the organization's sources and services, without secrets or hashes. */
/**
 * A page's position: whether its last credential was usable when read, when it was issued (empty when not recorded,
 * with microseconds so the boundary compares exactly) and its id. Usable can change with the clock between pages;
 * the next page starts after the position as it was read.
 */
function credentialCursor(usable: boolean, issued: string, id: string): string {
  return Buffer.from(JSON.stringify([usable, issued, id])).toString('base64url');
}
function readCredentialCursor(cursor: string): [boolean, string, string] {
  try {
    const position: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(position) &&
      position.length === 3 &&
      typeof position[0] === 'boolean' &&
      typeof position[1] === 'string' &&
      typeof position[2] === 'string' &&
      credentialCursor(position[0], position[1], position[2]) === cursor
    )
      return [position[0], position[1], position[2]];
  } catch {
    // Refused below, like any other cursor this list did not give.
  }
  throw new DomainError(400, 'invalid_cursor', 'The credentials list cursor is not one this list gave');
}

export async function listCredentials(
  client: PoolClient,
  actor: AuthContext,
  query: CredentialListQuery = {},
): Promise<CredentialListResponse> {
  if (!actor.capabilities.includes('authority:write'))
    throw new DomainError(403, 'capability_required', 'Reading credentials requires authority:write');
  const limit = Math.min(query.limit ?? CREDENTIAL_LIST_LIMIT, CREDENTIAL_LIST_LIMIT);
  const after = query.cursor ? readCredentialCursor(query.cursor) : null;
  const rows = (
    await client.query<CredentialRow & { usable: boolean; issued_key: string | null }>(
      `SELECT * FROM (
         SELECT c.id,c.principal_id,p.name AS principal_name,p.kind AS principal_kind,p.active AS principal_active,
           c.label,c.issued_by,issuer.name AS issuer_name,c.issued_at,c.expires_at,c.revoked_by,
           revoker.name AS revoker_name,c.revoked_at,(c.expires_at IS NOT NULL AND c.expires_at<=clock_timestamp()) AS expired,
           (c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())) AS usable,
           to_char(c.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS issued_key
         FROM api_credentials c
         JOIN principals p ON p.tenant_id=c.tenant_id AND p.id=c.principal_id
         LEFT JOIN principals issuer ON issuer.tenant_id=c.tenant_id AND issuer.id=c.issued_by
         LEFT JOIN principals revoker ON revoker.tenant_id=c.tenant_id AND revoker.id=c.revoked_by
         WHERE c.tenant_id=$1 AND p.kind IN ('source','service')) AS listed
       WHERE ($3::boolean IS NULL OR usable<$3::boolean OR (usable=$3::boolean AND (CASE WHEN $4::text=''
         THEN issued_at IS NULL AND id COLLATE "C">$5::text COLLATE "C"
         ELSE issued_at IS NULL OR issued_at<NULLIF($4::text,'')::timestamptz
           OR (issued_at=NULLIF($4::text,'')::timestamptz AND id COLLATE "C">$5::text COLLATE "C") END)))
       ORDER BY usable DESC,issued_at DESC NULLS LAST,id COLLATE "C"
       LIMIT $2`,
      [actor.tenantId, limit + 1, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null],
    )
  ).rows;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  const hasMore = rows.length > limit;
  return {
    credentials: shown.map(credentialEntry),
    hasMore,
    nextCursor: hasMore && last ? credentialCursor(last.usable, last.issued_key ?? '', last.id) : null,
  };
}
