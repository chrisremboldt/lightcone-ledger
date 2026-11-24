import { randomUUID } from 'node:crypto';
import {
  FINDING_PACKET_FORMAT,
  FINDING_PACKET_LIMITS,
  FINDING_PACKET_PAGE_LIMIT,
  FINDING_PACKET_V2_FORMAT,
  FINDING_PACKET_V2_LIMITS,
  type FindingPacketCreate,
  type FindingPacketListResponse,
  type FindingPacketQuery,
  type FindingPacketRecord,
  type FindingPacketV2,
} from '@ledger/contracts';
import { encodeHistoryCursor, historyCursor, historyLimit, historyPrecise } from '@ledger/domain';
import { canonicalDigest, canonicalize, sha256 } from '@ledger/integrity';
import {
  appendEvent,
  DomainError,
  readBoundedObject,
  writeBoundedObject,
  type AuthContext,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import {
  assembleFindingPacketV2,
  originalsLeaveOutOrder,
  originalsLeftOut,
  type FindingPacketSources,
  type PacketIssue,
} from './finding-packet-assembly.js';
import { loadFindingPacketSources } from './finding-packets.js';

const LIMITS = FINDING_PACKET_V2_LIMITS;
const FORMAT_LIMITS: Record<string, object> = {
  [FINDING_PACKET_FORMAT]: FINDING_PACKET_LIMITS,
  [FINDING_PACKET_V2_FORMAT]: FINDING_PACKET_V2_LIMITS,
};
const EVENT_TYPE = 'finding-packet.issue';

interface RecordRow {
  format: string;
  metadata: FindingPacketRecord;
  packet_object_key: string;
  packet_sha256: string;
  byte_length: number;
  manifest_digest: string;
}

function requireEvidenceRead(principal: AuthContext): void {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'capability_required', 'Finding packets require evidence:read');
}

/** Reads the exact original bytes of the sources a packet carries, each within its recorded length and a time bound. */
async function readOriginals(
  client: PoolClient,
  store: ObjectStore,
  tenantId: string,
  ids: string[],
): Promise<Map<string, Uint8Array>> {
  const originals = new Map<string, Uint8Array>();
  if (!ids.length) return originals;
  const rows = await client.query<{ id: string; object_key: string; byte_length: number }>(
    'SELECT id,object_key,byte_length FROM artifacts WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id',
    [tenantId, ids],
  );
  const until = Date.now() + 30000;
  for (const row of rows.rows) {
    const remaining = until - Date.now();
    try {
      if (remaining <= 0) throw new Error('timeout');
      const bytes = await readBoundedObject(store, row.object_key, {
        maxBytes: Number(row.byte_length),
        timeoutMs: Math.min(10000, remaining),
      });
      originals.set(row.id, bytes);
    } catch {
      throw new DomainError(
        409,
        'finding_packet_bytes_unavailable',
        'The original bytes of a source are unavailable within their byte and time bounds',
      );
    }
  }
  return originals;
}

/**
 * Builds the version 2 packet with as many source originals as fit: bytes are left out largest first, first to keep
 * within the original-byte bound and then, if needed, to keep the whole packet within its byte bound.
 */
function packWithOriginals(
  sources: FindingPacketSources,
  issue: PacketIssue,
  originals: ReadonlyMap<string, Uint8Array>,
): { packet: FindingPacketV2; bytes: Buffer } {
  const order = originalsLeaveOutOrder(sources.artifacts).map((item) => item.id);
  for (let count = originalsLeftOut(sources.artifacts).length; count <= order.length; count++) {
    const packet = assembleFindingPacketV2(sources, issue, originals, order.slice(0, count));
    const bytes = Buffer.from(canonicalize(packet), 'utf8');
    if (bytes.length <= LIMITS.maxPacketBytes) return { packet, bytes };
  }
  throw new DomainError(429, 'finding_packet_budget_exceeded', 'The finding records exceed the packet budget');
}

/**
 * Issues a packet for one finding: assembles it from the records that exist for the finding, keeps its bytes in
 * object storage, and records the issue as a journal event and an append-only packet record.
 */
export async function createFindingPacket(
  client: PoolClient,
  principal: AuthContext,
  input: FindingPacketCreate,
  store: ObjectStore,
  idempotencyKey: string,
): Promise<FindingPacketRecord> {
  requireEvidenceRead(principal);
  await client.query("SET LOCAL statement_timeout='15s'");
  const sources = await loadFindingPacketSources(client, principal.tenantId, input.findingId);
  const reused = await client.query('SELECT 1 FROM finding_packet_records WHERE tenant_id=$1 AND idempotency_key=$2', [
    principal.tenantId,
    idempotencyKey,
  ]);
  if (reused.rowCount)
    throw new DomainError(
      409,
      'idempotency_conflict',
      'This key already identifies another packet in your organization',
    );
  const carried = originalsLeaveOutOrder(sources.artifacts)
    .slice(originalsLeftOut(sources.artifacts).length)
    .map((item) => item.id);
  const originals = await readOriginals(client, store, principal.tenantId, carried);
  const id = randomUUID();
  let bytes!: Buffer;
  let record!: FindingPacketRecord;
  // The packet's issue time is the time its journal event is received.
  const event = await appendEvent(client, principal, {
    id,
    type: EVENT_TYPE,
    stream: `finding-packet:${input.findingId}`,
    payload: ({ receivedAt }) => {
      const issue = { packetId: id, issuedBy: principal.id, issuedAt: receivedAt };
      const packed = packWithOriginals(sources, issue, originals);
      const packet = packed.packet;
      bytes = packed.bytes;
      record = {
        id,
        format: FINDING_PACKET_V2_FORMAT,
        tenantId: principal.tenantId,
        findingId: input.findingId,
        subjectKey: sources.finding.subjectKey,
        eventId: id,
        issuedBy: principal.id,
        issuedAt: receivedAt,
        byteLength: bytes.length,
        packetSha256: sha256(bytes),
        manifestDigest: packet.manifestDigest,
        counts: packet.manifest.counts,
        limits: { ...LIMITS },
      };
      return {
        kind: EVENT_TYPE,
        packetId: id,
        findingId: input.findingId,
        format: FINDING_PACKET_V2_FORMAT,
        manifestDigest: record.manifestDigest,
        packetSha256: record.packetSha256,
        byteLength: record.byteLength,
      };
    },
  });
  const key = `${principal.tenantId}/finding-packets/${id}/packet`;
  const stored = await writeBoundedObject(store, key, bytes, 'application/json', 10000);
  await client.query(
    `INSERT INTO finding_packet_records(id,tenant_id,finding_id,subject_key,format,event_id,idempotency_key,issued_by,
       issued_at,packet_object_key,object_version,packet_sha256,manifest_digest,byte_length,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      principal.tenantId,
      record.findingId,
      record.subjectKey,
      record.format,
      event.id,
      idempotencyKey,
      principal.id,
      record.issuedAt,
      key,
      stored.version ?? null,
      record.packetSha256,
      record.manifestDigest,
      record.byteLength,
      record,
    ],
  );
  return record;
}

/** The record and storage of one packet, refused if the record differs from the columns it was kept with. */
async function retained(client: PoolClient, principal: AuthContext, id: string): Promise<RecordRow> {
  requireEvidenceRead(principal);
  const row = (
    await client.query<RecordRow>(
      `SELECT format,metadata,packet_object_key,packet_sha256,byte_length,manifest_digest FROM finding_packet_records
       WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'finding_packet_not_found', 'Finding packet is unavailable within this scope');
  integral(row);
  return row;
}

function integral(row: RecordRow): void {
  const record = row.metadata;
  const limits = FORMAT_LIMITS[row.format];
  if (
    !limits ||
    record.format !== row.format ||
    record.packetSha256 !== row.packet_sha256 ||
    record.manifestDigest !== row.manifest_digest ||
    record.byteLength !== row.byte_length ||
    canonicalDigest(record.limits) !== canonicalDigest(limits)
  )
    throw new DomainError(409, 'finding_packet_integrity_failure', 'Retained packet record differs from its format');
}

export async function getFindingPacket(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<FindingPacketRecord> {
  return (await retained(client, principal, id)).metadata;
}

/** The kept bytes of a packet, refused unless they match the recorded content digest and length. */
export async function getFindingPacketContent(
  client: PoolClient,
  principal: AuthContext,
  id: string,
  store: ObjectStore,
): Promise<{ record: FindingPacketRecord; bytes: Uint8Array }> {
  const row = await retained(client, principal, id);
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedObject(store, row.packet_object_key, { maxBytes: row.byte_length, timeoutMs: 10000 });
  } catch {
    throw new DomainError(409, 'finding_packet_bytes_unavailable', 'Retained packet bytes are unavailable');
  }
  if (bytes.byteLength !== row.byte_length || sha256(bytes) !== row.packet_sha256)
    throw new DomainError(409, 'finding_packet_integrity_failure', 'Retained packet bytes differ from their record');
  return { record: row.metadata, bytes };
}

/** Packets issued for one finding, newest first. */
export async function listFindingPackets(
  client: PoolClient,
  principal: AuthContext,
  query: FindingPacketQuery,
): Promise<Omit<FindingPacketListResponse, 'requestId'>> {
  requireEvidenceRead(principal);
  const limit = historyLimit(query.limit, 20, FINDING_PACKET_PAGE_LIMIT);
  const filters = { findingId: query.findingId };
  const prior = historyCursor(query.cursor, principal, 'finding-packets', filters, true);
  const rows = await client.query<RecordRow & { id: string; page_time: string }>(
    `SELECT id,format,metadata,packet_object_key,packet_sha256,byte_length,manifest_digest,
       ${historyPrecise('issued_at')} AS page_time FROM finding_packet_records
     WHERE tenant_id=$1 AND finding_id=$2 AND ($3::timestamptz IS NULL OR (issued_at,id)<($3::timestamptz,$4::text))
     ORDER BY issued_at DESC,id DESC LIMIT $5`,
    [principal.tenantId, query.findingId, prior?.position.time ?? null, prior?.position.id ?? null, limit + 1],
  );
  const visible = rows.rows.slice(0, limit);
  for (const row of visible) integral(row);
  const hasMore = rows.rows.length > limit;
  const last = visible.at(-1);
  const position = last ? { id: last.id, time: last.page_time } : null;
  return {
    records: visible.map((row) => row.metadata),
    page: {
      limit,
      returned: visible.length,
      hasMore,
      nextCursor:
        hasMore && position
          ? encodeHistoryCursor(principal, 'finding-packets', filters, prior?.upper ?? position, position)
          : null,
    },
  };
}
