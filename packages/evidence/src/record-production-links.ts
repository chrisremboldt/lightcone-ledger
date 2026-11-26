import { randomBytes, randomUUID } from 'node:crypto';
import {
  RECORD_LINK_DEFAULT_DAYS,
  type RecordLink,
  type RecordLinkCreate,
  type RecordLinkCreated,
  type RecordLinkOpening,
  type RecordProduction,
  type RecordProductionManifest,
  type SharedRecords,
  type SharedRecordsFile,
} from '@ledger/contracts';
import { requireRecordRead } from '@ledger/domain';
import { sha256 } from '@ledger/integrity';
import {
  appendEvent,
  DomainError,
  readBoundedObject,
  type AuthContext,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import { readZip } from './zip.js';

/**
 * Links to one produced set of records (docs/design/shared-links.md). Making and revoking one is a recorded command of
 * a person who may produce records; opening one needs no sign-in and reaches only that set.
 */

const STORE_TIMEOUT_MS = 30_000;
const OPENINGS_SHOWN = 200;
const MANIFEST_PATH = 'manifest.json';

interface LinkRow {
  id: string;
  production_id: string;
  note: string;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  expires_at: Date;
  revoked_by: string | null;
  revoked_by_name: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  now: Date;
}
const linkSql = `SELECT l.id,l.production_id,l.note,l.created_by,c.name AS created_by_name,l.created_at,l.expires_at,
  l.revoked_by,r.name AS revoked_by_name,l.revoked_at,l.revoke_reason,clock_timestamp() AS now
 FROM record_production_links l
 JOIN principals c ON c.tenant_id=l.tenant_id AND c.id=l.created_by
 LEFT JOIN principals r ON r.tenant_id=l.tenant_id AND r.id=l.revoked_by`;

async function openingsOf(
  client: PoolClient,
  tenantId: string,
  ids: string[],
): Promise<Map<string, RecordLinkOpening[]>> {
  const rows = await client.query<{
    link_id: string;
    opened_at: Date;
    opened: RecordLinkOpening['opened'];
    path: string | null;
  }>(
    `SELECT link_id,opened_at,opened,path FROM (
       SELECT o.*,row_number() OVER (PARTITION BY o.link_id ORDER BY o.opened_at DESC,o.id DESC) AS place
       FROM record_production_link_openings o WHERE o.tenant_id=$1 AND o.link_id=ANY($2::text[])) shown
     WHERE place<=$3 ORDER BY opened_at DESC,id DESC`,
    [tenantId, ids, OPENINGS_SHOWN],
  );
  const byLink = new Map<string, RecordLinkOpening[]>();
  for (const row of rows.rows)
    byLink.set(row.link_id, [
      ...(byLink.get(row.link_id) ?? []),
      { openedAt: row.opened_at.toISOString(), opened: row.opened, path: row.path },
    ]);
  return byLink;
}

function link(row: LinkRow, openings: RecordLinkOpening[]): RecordLink {
  return {
    id: row.id,
    productionId: row.production_id,
    note: row.note,
    createdBy: { id: row.created_by, name: row.created_by_name },
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedBy: row.revoked_by ? { id: row.revoked_by, name: row.revoked_by_name ?? row.revoked_by } : null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokeReason: row.revoke_reason,
    state: row.revoked_at ? 'revoked' : row.expires_at <= row.now ? 'expired' : 'open',
    openings,
  };
}

async function readLinks(client: PoolClient, tenantId: string, where: string, value: string): Promise<RecordLink[]> {
  const rows = (
    await client.query<LinkRow>(`${linkSql} WHERE l.tenant_id=$1 AND ${where}=$2 ORDER BY l.created_at DESC,l.id`, [
      tenantId,
      value,
    ])
  ).rows;
  const openings = await openingsOf(
    client,
    tenantId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => link(row, openings.get(row.id) ?? []));
}

async function requireProduction(client: PoolClient, tenantId: string, productionId: string): Promise<void> {
  const found = await client.query('SELECT 1 FROM record_productions WHERE tenant_id=$1 AND id=$2', [
    tenantId,
    productionId,
  ]);
  if (!found.rowCount)
    throw new DomainError(404, 'production_not_found', 'The production was not found within your scope');
}

/** Every link made to one produced set, newest first, with its state and its openings. */
export async function listRecordLinks(
  client: PoolClient,
  principal: AuthContext,
  productionId: string,
): Promise<{ links: RecordLink[] }> {
  requireRecordRead(principal);
  await requireProduction(client, principal.tenantId, productionId);
  return { links: await readLinks(client, principal.tenantId, 'l.production_id', productionId) };
}

/** Makes a link to one produced set. Its secret is returned here once; only its SHA-256 is kept. */
export async function createRecordLink(
  client: PoolClient,
  principal: AuthContext,
  productionId: string,
  input: RecordLinkCreate,
): Promise<RecordLinkCreated> {
  requireRecordRead(principal);
  await requireProduction(client, principal.tenantId, productionId);
  const note = input.note.trim();
  const days = input.expiresInDays ?? RECORD_LINK_DEFAULT_DAYS;
  const id = `record-link-${randomUUID()}`;
  const secret = `ledger-records-${randomBytes(32).toString('base64url')}`;
  const event = await appendEvent(client, principal, {
    type: 'record-production.link.create',
    stream: `record-production-link:${id}`,
    payload: { linkId: id, productionId, note, expiresInDays: days },
  });
  await client.query(
    `INSERT INTO record_production_links(id,tenant_id,production_id,note,secret_sha256,create_event_id,created_by,
       created_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz+make_interval(days=>$9::int))`,
    [id, principal.tenantId, productionId, note, sha256(secret), event.id, principal.id, event.received_at, days],
  );
  const [made] = await readLinks(client, principal.tenantId, 'l.id', id);
  return { link: made!, secret };
}

/** Revokes a link at once, with the reason. A revoked link opens nothing. */
export async function revokeRecordLink(
  client: PoolClient,
  principal: AuthContext,
  id: string,
  reason: string,
): Promise<{ link: RecordLink }> {
  requireRecordRead(principal);
  const held = (
    await client.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM record_production_links WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [principal.tenantId, id],
    )
  ).rows[0];
  if (!held) throw new DomainError(404, 'record_link_not_found', 'The link was not found in your organization');
  if (held.revoked_at) throw new DomainError(409, 'record_link_revoked', 'This link is already revoked');
  const why = reason.trim();
  const event = await appendEvent(client, principal, {
    type: 'record-production.link.revoke',
    stream: `record-production-link:${id}`,
    payload: { linkId: id, reason: why },
  });
  await client.query(
    `UPDATE record_production_links SET revoke_event_id=$1,revoked_by=$2,revoked_at=$3,revoke_reason=$4
     WHERE tenant_id=$5 AND id=$6`,
    [event.id, principal.id, event.received_at, why, principal.tenantId, id],
  );
  const [revoked] = await readLinks(client, principal.tenantId, 'l.id', id);
  return { link: revoked! };
}

// Opening a link: no sign-in, so no organization is known until the secret's hash finds one.

/** The one answer to a link that opens nothing: unknown, expired and revoked are not told apart. */
export function linkNotInUse(): DomainError {
  return new DomainError(
    404,
    'record_link_not_in_use',
    'This link does not open any records. It may have expired or been revoked.',
  );
}

interface SharedRow {
  organization_name: string;
  expires_at: Date;
  metadata: RecordProduction;
  archive_object_key: string;
  archive_sha256: string;
  manifest_sha256: string;
  byte_length: number;
}

/** The set a link opens, with its files as its manifest lists them, read from the kept and checked .zip. */
interface SharedSet {
  row: SharedRow;
  archive: Uint8Array;
  entries: Map<string, Buffer>;
  files: SharedRecordsFile[];
}

async function sharedSet(client: Pick<PoolClient, 'query'>, store: ObjectStore, secret: string): Promise<SharedSet> {
  const row = (
    await client.query<SharedRow>(
      `SELECT organization_name,expires_at,metadata,archive_object_key,archive_sha256,manifest_sha256,byte_length
       FROM ledger_record_production_link($1)`,
      [sha256(secret)],
    )
  ).rows[0];
  if (!row) throw linkNotInUse();
  let archive: Uint8Array;
  try {
    archive = await readBoundedObject(store, row.archive_object_key, {
      maxBytes: row.byte_length,
      timeoutMs: STORE_TIMEOUT_MS,
    });
  } catch {
    throw new DomainError(409, 'production_bytes_unavailable', 'The produced file is unavailable');
  }
  if (archive.byteLength !== row.byte_length || sha256(archive) !== row.archive_sha256)
    throw new DomainError(409, 'production_integrity_failure', 'The kept file differs from its record');
  const entries = readZip(archive);
  const manifestBytes = entries.get(MANIFEST_PATH);
  if (!manifestBytes || sha256(manifestBytes) !== row.manifest_sha256)
    throw new DomainError(409, 'production_integrity_failure', 'The kept manifest differs from its record');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as RecordProductionManifest;
  const files: SharedRecordsFile[] = [
    ...manifest.files.map((file) => ({
      path: file.path,
      role: file.role,
      contentType: file.contentType,
      byteLength: file.byteLength,
      sha256: file.sha256,
    })),
    {
      path: MANIFEST_PATH,
      role: 'manifest' as const,
      contentType: 'application/json',
      byteLength: manifestBytes.byteLength,
      sha256: null,
    },
  ];
  return { row, archive, entries, files };
}

async function recordOpening(
  client: Pick<PoolClient, 'query'>,
  secret: string,
  opened: RecordLinkOpening['opened'],
  path: string | null,
): Promise<void> {
  const kept = (
    await client.query<{ kept: boolean }>('SELECT ledger_record_production_link_opened($1,$2,$3) AS kept', [
      sha256(secret),
      opened,
      path,
    ])
  ).rows[0];
  // Revoked between reading the set and keeping the opening: the link opens nothing from that moment.
  if (!kept?.kept) throw linkNotInUse();
}

/** The page of a link: what the set is and its files. The opening is kept. */
export async function openSharedRecords(
  client: Pick<PoolClient, 'query'>,
  store: ObjectStore,
  secret: string,
): Promise<SharedRecords> {
  const { row, files } = await sharedSet(client, store, secret);
  await recordOpening(client, secret, 'page', null);
  const production = row.metadata;
  return {
    organization: { name: row.organization_name, timeZone: production.organization.timeZone },
    set: {
      reason: production.reason,
      requestedBy: production.requestedBy,
      producedAt: production.producedAt,
      producedBy: production.producedBy.name ?? production.producedBy.id,
      records: production.counts.records,
      archiveSha256: row.archive_sha256,
      manifestSha256: row.manifest_sha256,
      byteLength: row.byte_length,
    },
    files,
    expiresAt: row.expires_at.toISOString(),
  };
}

/** One file of the set a link opens, checked against the manifest's SHA-256. The opening is kept. */
export async function openSharedRecordsFile(
  client: Pick<PoolClient, 'query'>,
  store: ObjectStore,
  secret: string,
  path: string,
): Promise<{ file: SharedRecordsFile; bytes: Buffer }> {
  const { entries, files } = await sharedSet(client, store, secret);
  const file = files.find((candidate) => candidate.path === path);
  const bytes = entries.get(path);
  if (!file || !bytes)
    throw new DomainError(404, 'shared_file_not_found', 'The records this link opens hold no file by that name');
  if (file.sha256 !== null && sha256(bytes) !== file.sha256)
    throw new DomainError(409, 'production_integrity_failure', 'A kept file differs from its manifest');
  await recordOpening(client, secret, 'file', path);
  return { file, bytes };
}

/** The whole .zip of the set a link opens, checked against its recorded SHA-256. The opening is kept. */
export async function openSharedRecordsArchive(
  client: Pick<PoolClient, 'query'>,
  store: ObjectStore,
  secret: string,
): Promise<{ production: RecordProduction; bytes: Uint8Array }> {
  const { row, archive } = await sharedSet(client, store, secret);
  await recordOpening(client, secret, 'archive', null);
  return { production: row.metadata, bytes: archive };
}
