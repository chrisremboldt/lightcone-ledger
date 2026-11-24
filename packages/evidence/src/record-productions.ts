import { randomUUID } from 'node:crypto';
import {
  OPERATOR_RECORD_SOURCE_ID,
  RECORD_PRODUCTION_FORMAT,
  RECORD_PRODUCTION_LIMITS,
  RECORD_PRODUCTION_PAGE_LIMIT,
  type RecordProduction,
  type RecordProductionCreate,
  type RecordProductionJournalPosition,
  type RecordProductionLimits,
  type RecordProductionListResponse,
  type RecordProductionOriginal,
  type RecordProductionQuery,
  type RecordProductionSelection,
} from '@ledger/contracts';
import {
  encodeHistoryCursor,
  getOrganizationSummary,
  historyCursor,
  historyLimit,
  historyPrecise,
  listOperatorRecordTypes,
  operatorRecordObservationTypes,
  readRecordRows,
  recordNamesOf,
  recordSubjectOf,
  requireRecordRead,
  type RecordRow,
  type RecordSubject,
} from '@ledger/domain';
import { sha256 } from '@ledger/integrity';
import {
  appendEvent,
  DomainError,
  readBoundedObject,
  writeBoundedObject,
  type AuthContext,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import { assembleRecordProduction, assignedFlights, type ProductionSources } from './record-production-assembly.js';

/**
 * Producing an organization's records on request (docs/design/record-productions.md): a recorded command with its own
 * journal event and an append-only production record; the .zip is kept in object storage and can be downloaded again.
 */

const EVENT_TYPE = 'record-production.produce';
const STORE_TIMEOUT_MS = 30_000;

interface ProductionRow {
  id: string;
  metadata: RecordProduction;
  archive_object_key: string;
  archive_sha256: string;
  manifest_sha256: string;
  byte_length: number;
}

function selectionOf(input: RecordProductionCreate): RecordProductionSelection {
  return {
    subjects: (input.subjects ?? []).map((subject) => ({ ...subject })),
    recordTypes: [...new Set(input.recordTypes ?? [])].sort(),
    from: input.from ?? null,
    to: input.to ?? null,
    includeOriginals: input.includeOriginals ?? false,
    withFlights: input.withFlights ?? false,
    sourceId: input.sourceId ?? OPERATOR_RECORD_SOURCE_ID,
  };
}

function subjectsOf(tenantId: string, selection: RecordProductionSelection): RecordSubject[] {
  return selection.subjects.map((subject) => {
    if (subject.id) return recordSubjectOf(tenantId, subject.kind, subject.id);
    if (subject.kind !== 'organization')
      throw new DomainError(400, 'subject_id_required', `A ${subject.kind} is named by your own id for it`);
    return { kind: 'organization', id: `organization:${tenantId}`, scope: 'ledger' };
  });
}

function checkSelection(selection: RecordProductionSelection, limits: RecordProductionLimits): void {
  if (selection.from && selection.to && Date.parse(selection.from) >= Date.parse(selection.to))
    throw new DomainError(400, 'invalid_time_range', 'The start of the dates must be before their end');
  if (selection.subjects.length > limits.maxSubjects)
    throw new DomainError(
      400,
      'too_many_subjects',
      `Produce the records of at most ${limits.maxSubjects} subjects at a time`,
    );
  const registered = new Set(listOperatorRecordTypes().map((definition) => definition.recordType));
  for (const recordType of selection.recordTypes)
    if (!registered.has(recordType))
      throw new DomainError(400, 'record_type_not_found', `Record type ${recordType} is not registered`);
}

/** Each journal stream the records' events are in, with the position it stood at when they were read. */
async function journalPositions(
  client: PoolClient,
  tenantId: string,
  eventIds: string[],
): Promise<RecordProductionJournalPosition[]> {
  if (!eventIds.length) return [];
  const rows = await client.query<{ name: string; sequence: string; head_hash: string }>(
    `SELECT s.name,s.sequence,s.head_hash FROM streams s
     WHERE s.tenant_id=$1 AND s.id IN (SELECT e.stream_id FROM journal_events e WHERE e.tenant_id=$1 AND e.id=ANY($2::text[]))
     ORDER BY s.name`,
    [tenantId, eventIds],
  );
  return rows.rows.map((row) => ({ stream: row.name, sequence: Number(row.sequence), headHash: row.head_hash }));
}

async function readOriginals(
  client: PoolClient,
  store: ObjectStore,
  tenantId: string,
  originals: readonly RecordProductionOriginal[],
): Promise<Map<string, Uint8Array>> {
  const bytes = new Map<string, Uint8Array>();
  const keys = new Map(
    (
      await client.query<{ id: string; object_key: string }>(
        'SELECT id,object_key FROM artifacts WHERE tenant_id=$1 AND id=ANY($2::text[])',
        [tenantId, originals.map((original) => original.artifactId)],
      )
    ).rows.map((row) => [row.id, row.object_key]),
  );
  for (const original of originals) {
    let read: Uint8Array;
    try {
      read = await readBoundedObject(store, keys.get(original.artifactId)!, {
        maxBytes: original.byteLength,
        timeoutMs: 10_000,
      });
    } catch {
      throw new DomainError(409, 'production_original_unavailable', 'An original file could not be read');
    }
    if (read.byteLength !== original.byteLength || sha256(read) !== original.sha256)
      throw new DomainError(409, 'artifact_integrity_failure', 'Retained bytes do not match the receipt commitment');
    bytes.set(original.artifactId, read);
  }
  return bytes;
}

/** The original files of the rows, each with how many of its records the file holds and how many it does not. */
async function originalsOf(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  rows: readonly RecordRow[],
): Promise<RecordProductionOriginal[]> {
  const byId = new Map<string, Omit<RecordProductionOriginal, 'otherRecords'>>();
  for (const row of rows) {
    const seen = byId.get(row.artifact_id);
    byId.set(row.artifact_id, {
      artifactId: row.artifact_id,
      filename: row.filename,
      contentType: row.content_type,
      byteLength: Number(row.byte_length),
      sha256: row.artifact_sha256,
      records: (seen?.records ?? 0) + 1,
      path: null,
    });
  }
  const totals = new Map(
    (
      await client.query<{ artifact_id: string; records: string }>(
        `SELECT artifact_id,count(*) AS records FROM observations
         WHERE tenant_id=$1 AND source_id=$2 AND observation_type=ANY($3::text[]) AND artifact_id=ANY($4::text[])
         GROUP BY artifact_id`,
        [tenantId, sourceId, operatorRecordObservationTypes(), [...byId.keys()]],
      )
    ).rows.map((row) => [row.artifact_id, Number(row.records)]),
  );
  return [...byId.values()]
    .map((original) => ({
      ...original,
      otherRecords: Math.max(0, (totals.get(original.artifactId) ?? original.records) - original.records),
    }))
    .sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1));
}

async function principalNames(client: PoolClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const rows = await client.query<{ id: string; name: string }>(
    'SELECT id,name FROM principals WHERE tenant_id=$1 AND id=ANY($2::text[])',
    [tenantId, [...new Set(ids)]],
  );
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}

/** Reads everything a production holds, refusing a selection over its bounds before anything is written. */
async function loadSources(
  client: PoolClient,
  principal: AuthContext,
  store: ObjectStore,
  selection: RecordProductionSelection,
  limits: RecordProductionLimits,
): Promise<ProductionSources> {
  const subjects = subjectsOf(principal.tenantId, selection);
  const read = (about: readonly RecordSubject[], everyType = false) =>
    readRecordRows(
      client,
      principal.tenantId,
      {
        sourceId: selection.sourceId,
        ...(selection.recordTypes.length && !everyType ? { recordTypes: selection.recordTypes } : {}),
        ...(about.length ? { subjects: [...about] } : {}),
        ...(selection.from ? { from: selection.from } : {}),
        ...(selection.to ? { to: selection.to } : {}),
      },
      limits.maxRecords + 1,
    );
  let rows = await read(subjects);
  // A person's flights are listed whatever record types are selected.
  const people = subjects.filter((subject) => subject.kind === 'person');
  const flights = assignedFlights(
    people,
    selection.recordTypes.length && people.length ? await read(people, true) : rows,
  );
  if (selection.withFlights && flights.length) {
    const flightSubjects = [...new Set(flights.map((flight) => flight.flight))].map((id) =>
      recordSubjectOf(principal.tenantId, 'flight', id),
    );
    const seen = new Set(rows.map((row) => row.id));
    rows = [...rows, ...(await read(flightSubjects)).filter((row) => !seen.has(row.id))];
  }
  if (rows.length > limits.maxRecords)
    throw new DomainError(
      413,
      'production_too_large',
      `The selection holds more than ${limits.maxRecords} records, the most one file holds. Narrow it by subject, record type or dates and produce the rest in another file.`,
      { maxRecords: limits.maxRecords },
    );
  const originals = await originalsOf(client, principal.tenantId, selection.sourceId, rows);
  const originalBytes = originals.reduce((total, original) => total + original.byteLength, 0);
  if (selection.includeOriginals && originalBytes > limits.maxOriginalBytes)
    throw new DomainError(
      413,
      'production_too_large',
      `The original files of these records total ${originalBytes} bytes, more than the ${limits.maxOriginalBytes} one file holds. Produce them without originals, or narrow the selection.`,
      { maxOriginalBytes: limits.maxOriginalBytes },
    );
  const named = new Map<string, string>();
  const sourceSubjects = [
    ...rows.flatMap((row) => [
      { kind: row.subject_kind, id: row.subject_id, scope: row.subject_scope },
      ...(row.secondary_subject_kind && row.secondary_subject_id && row.secondary_subject_scope
        ? [{ kind: row.secondary_subject_kind, id: row.secondary_subject_id, scope: row.secondary_subject_scope }]
        : []),
    ]),
    ...subjects,
  ].filter((subject) => subject.scope === 'source');
  for (const [key, name] of await recordNamesOf(client, principal.tenantId, selection.sourceId, sourceSubjects))
    named.set(key, name);
  return {
    organization: await getOrganizationSummary(client, principal.tenantId),
    selection,
    subjects,
    rows,
    names: named,
    recordedBy: await principalNames(client, principal.tenantId, [
      principal.id,
      ...rows.map((row) => row.principal_id),
    ]),
    originals,
    flights,
    originalBytes: selection.includeOriginals
      ? await readOriginals(client, store, principal.tenantId, originals)
      : new Map(),
    journal: await journalPositions(
      client,
      principal.tenantId,
      rows.map((row) => row.event_id),
    ),
    limits,
  };
}

/**
 * POST /v1/record-productions: produces the selected records as one .zip, recorded as a journal event and an
 * append-only production record. The file's time is the time its event is received.
 */
export async function createRecordProduction(
  client: PoolClient,
  principal: AuthContext,
  input: RecordProductionCreate,
  store: ObjectStore,
  idempotencyKey: string,
  limits: RecordProductionLimits = RECORD_PRODUCTION_LIMITS,
): Promise<RecordProduction> {
  requireRecordRead(principal);
  await client.query("SET LOCAL statement_timeout='60s'");
  const selection = selectionOf(input);
  checkSelection(selection, limits);
  const reused = await client.query('SELECT 1 FROM record_productions WHERE tenant_id=$1 AND idempotency_key=$2', [
    principal.tenantId,
    idempotencyKey,
  ]);
  if (reused.rowCount)
    throw new DomainError(409, 'idempotency_conflict', 'This key already identifies another production');
  const sources = await loadSources(client, principal, store, selection, limits);
  const id = randomUUID();
  let bytes!: Buffer;
  let record!: RecordProduction;
  const event = await appendEvent(client, principal, {
    id,
    type: EVENT_TYPE,
    stream: `record-production:${id}`,
    payload: ({ receivedAt }) => {
      const produced = assembleRecordProduction(sources, {
        productionId: id,
        producedBy: {
          id: principal.id,
          ...(sources.recordedBy.get(principal.id) ? { name: sources.recordedBy.get(principal.id)! } : {}),
        },
        producedAt: receivedAt,
        reason: input.reason.trim(),
        requestedBy: input.requestedBy.trim(),
      });
      bytes = produced.archive;
      if (bytes.byteLength > limits.maxArchiveBytes)
        throw new DomainError(
          413,
          'production_too_large',
          `The file would be ${bytes.byteLength} bytes, more than the ${limits.maxArchiveBytes} one file holds. Narrow the selection or leave out originals.`,
        );
      record = {
        id,
        format: RECORD_PRODUCTION_FORMAT,
        eventId: id,
        organization: produced.manifest.organization,
        producedBy: produced.manifest.producedBy,
        producedAt: receivedAt,
        reason: produced.manifest.reason,
        requestedBy: produced.manifest.requestedBy,
        selection,
        counts: produced.manifest.counts,
        byteLength: bytes.byteLength,
        archiveSha256: sha256(bytes),
        manifestSha256: produced.manifestSha256,
        limits: { ...limits },
      };
      return {
        kind: EVENT_TYPE,
        productionId: id,
        format: RECORD_PRODUCTION_FORMAT,
        reason: record.reason,
        requestedBy: record.requestedBy,
        selection,
        counts: record.counts,
        journal: produced.manifest.journal,
        archiveSha256: record.archiveSha256,
        manifestSha256: record.manifestSha256,
        byteLength: record.byteLength,
      };
    },
  });
  const key = `${principal.tenantId}/record-productions/${id}/archive`;
  const stored = await writeBoundedObject(store, key, bytes, 'application/zip', STORE_TIMEOUT_MS);
  await client.query(
    `INSERT INTO record_productions(id,tenant_id,format,event_id,idempotency_key,produced_by,produced_at,
       archive_object_key,object_version,archive_sha256,manifest_sha256,byte_length,record_count,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      principal.tenantId,
      RECORD_PRODUCTION_FORMAT,
      event.id,
      idempotencyKey,
      principal.id,
      record.producedAt,
      key,
      stored.version ?? null,
      record.archiveSha256,
      record.manifestSha256,
      record.byteLength,
      record.counts.records,
      record,
    ],
  );
  return record;
}

function integral(row: ProductionRow): void {
  const record = row.metadata;
  if (
    record.format !== RECORD_PRODUCTION_FORMAT ||
    record.archiveSha256 !== row.archive_sha256 ||
    record.manifestSha256 !== row.manifest_sha256 ||
    record.byteLength !== row.byte_length
  )
    throw new DomainError(409, 'production_integrity_failure', 'The production record differs from its columns');
}

async function retained(client: PoolClient, principal: AuthContext, id: string): Promise<ProductionRow> {
  requireRecordRead(principal);
  const row = (
    await client.query<ProductionRow>(
      `SELECT id,metadata,archive_object_key,archive_sha256,manifest_sha256,byte_length FROM record_productions
       WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'production_not_found', 'The production was not found within your scope');
  integral(row);
  return row;
}

export async function getRecordProduction(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<RecordProduction> {
  return (await retained(client, principal, id)).metadata;
}

/** The kept .zip, refused unless its bytes match the recorded digest and length. */
export async function getRecordProductionContent(
  client: PoolClient,
  principal: AuthContext,
  id: string,
  store: ObjectStore,
): Promise<{ record: RecordProduction; bytes: Uint8Array }> {
  const row = await retained(client, principal, id);
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedObject(store, row.archive_object_key, {
      maxBytes: row.byte_length,
      timeoutMs: STORE_TIMEOUT_MS,
    });
  } catch {
    throw new DomainError(409, 'production_bytes_unavailable', 'The produced file is unavailable');
  }
  if (bytes.byteLength !== row.byte_length || sha256(bytes) !== row.archive_sha256)
    throw new DomainError(409, 'production_integrity_failure', 'The kept file differs from its record');
  return { record: row.metadata, bytes };
}

/** GET /v1/record-productions: the organization's produced records, newest first. */
export async function listRecordProductions(
  client: PoolClient,
  principal: AuthContext,
  query: RecordProductionQuery,
): Promise<RecordProductionListResponse> {
  requireRecordRead(principal);
  const limit = historyLimit(query.limit, 20, RECORD_PRODUCTION_PAGE_LIMIT);
  const prior = historyCursor(query.cursor, principal, 'record-productions', {}, true);
  const rows = await client.query<ProductionRow & { page_time: string }>(
    `SELECT id,metadata,archive_object_key,archive_sha256,manifest_sha256,byte_length,
       ${historyPrecise('produced_at')} AS page_time FROM record_productions
     WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR (produced_at,id)<($2::timestamptz,$3::text))
     ORDER BY produced_at DESC,id DESC LIMIT $4`,
    [principal.tenantId, prior?.position.time ?? null, prior?.position.id ?? null, limit + 1],
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
          ? encodeHistoryCursor(principal, 'record-productions', {}, prior?.upper ?? position, position)
          : null,
    },
  };
}
