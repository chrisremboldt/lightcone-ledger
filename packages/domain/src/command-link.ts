import type { CommandLinkAuthority, CommandLinkInput, LinkStatusObservationV1 } from '@ledger/contracts';
import { canonicalDigest, canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';
import { DomainError, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { retainSubjectEvidence } from './cuts.js';
import { registerObservationProjector } from './observation-projectors.js';
import { commandLinkObservationReport } from './command-link-reports.js';
import { commandLinkReportFromObservation } from './rules/command-link-evidence-v1.js';

export interface VerifiedCommandLinkSource {
  sha256: string;
  byteLength: number;
  contentDigest: string;
}

// RETAINED: command-link reports are no longer accepted through their own intake; they arrive as link.status
// observations (packages/adapters/src/command-link-status.ts). Reports accepted earlier keep their records, and the
// verification of their source bytes and authority below serves the retained reads that cite them.
const SOURCE_BYTES_LIMIT = 64 * 1024;
const REQUIRED_CAPABILITIES = ['input:write', 'command-link:write'] as const;
const AUTHORITY_VERSION = 'ledger.command-link-authority.1';
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function keys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function sourceGrants(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id) && new Set(value).size === value.length;
}
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}
function normalizedInput(input: CommandLinkInput): void {
  if (
    !keys(
      input,
      ['sourceId', 'sourceSessionId', 'kind', 'occurredAt', 'subject', 'artifactId', 'fidelity', 'payload'],
      ['flightId', 'acceptedAuthority'],
    ) ||
    input.kind !== 'command-link.status' ||
    input.fidelity !== 'synthetic_contract' ||
    !id(input.sourceId) ||
    !id(input.sourceSessionId) ||
    !id(input.artifactId) ||
    !utc(input.occurredAt) ||
    !keys(input.subject, ['flightId']) ||
    !id(input.subject.flightId) ||
    !keys(input.payload, ['sourceEventId', 'incidentId', 'aircraftId', 'status'], ['position']) ||
    !id(input.payload.sourceEventId) ||
    !id(input.payload.incidentId) ||
    !id(input.payload.aircraftId) ||
    !['lost', 'restored'].includes(input.payload.status)
  )
    throw new DomainError(
      400,
      'command_link_source_invalid',
      'Command-link evidence must match its typed source contract',
    );
  if (input.payload.position !== undefined) {
    const position = input.payload.position;
    if (
      !keys(position, ['longitude', 'latitude']) ||
      typeof position.longitude !== 'number' ||
      !Number.isFinite(position.longitude) ||
      position.longitude < -180 ||
      position.longitude > 180 ||
      typeof position.latitude !== 'number' ||
      !Number.isFinite(position.latitude) ||
      position.latitude < -90 ||
      position.latitude > 90
    )
      throw new DomainError(
        400,
        'command_link_source_invalid',
        'Command-link position must use valid longitude and latitude degrees',
      );
  }
}

export function verifyCommandLinkInputSource(input: CommandLinkInput, bytes: Uint8Array): VerifiedCommandLinkSource {
  normalizedInput(input);
  if (bytes.byteLength > SOURCE_BYTES_LIMIT)
    throw new DomainError(413, 'command_link_source_too_large', 'Command-link source exceeds its 64 KiB bound');
  let source: unknown;
  try {
    source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    const expected = { sourceSessionId: input.sourceSessionId, occurredAt: input.occurredAt, ...input.payload };
    if (canonicalize(source) !== canonicalize(expected)) throw new Error('Source mapping differs');
  } catch {
    throw new DomainError(
      400,
      'command_link_source_invalid',
      'Command-link input must reproduce its exact original UTF-8 JSON source',
    );
  }
  const original = {
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    bytesBase64: Buffer.from(bytes).toString('base64'),
  };
  return {
    sha256: original.sha256,
    byteLength: original.byteLength,
    contentDigest: canonicalDigest({
      version: 'ledger.command-link-content.1',
      sourceId: input.sourceId,
      sourceSessionId: input.sourceSessionId,
      flightId: input.subject.flightId,
      occurredAt: input.occurredAt,
      fidelity: input.fidelity,
      payload: input.payload,
      original,
    }),
  };
}

export function validateAcceptedCommandLinkAuthority(event: JournalEvent): CommandLinkAuthority {
  const retained: unknown = event.payload.acceptedAuthority;
  if (
    event.event_type !== 'command-link.status' ||
    !keys(retained, [
      'version',
      'principalId',
      'tenantId',
      'principalRevision',
      'inputKind',
      'sourceId',
      'requiredCapabilities',
      'grantedSources',
    ]) ||
    retained.version !== AUTHORITY_VERSION ||
    retained.principalId !== event.principal_id ||
    retained.tenantId !== event.tenant_id ||
    !Number.isSafeInteger(retained.principalRevision) ||
    Number(retained.principalRevision) < 1 ||
    retained.inputKind !== event.event_type ||
    retained.sourceId !== event.source_id ||
    !Array.isArray(retained.requiredCapabilities) ||
    canonicalDigest(retained.requiredCapabilities) !== canonicalDigest(REQUIRED_CAPABILITIES) ||
    !sourceGrants(retained.grantedSources) ||
    !retained.grantedSources.includes(retained.sourceId as string)
  )
    throw new DomainError(
      403,
      'command_link_authority_invalid',
      'Retained command-link authority does not match its immutable issuer and source',
    );
  return retained as unknown as CommandLinkAuthority;
}

interface ObservationReportRow {
  id: string;
  receipt_id: string;
  artifact_id: string;
  source_id: string;
  subject_kind: string;
  subject_ledger_id: string | null;
  content_digest: string;
  observation: LinkStatusObservationV1;
  receipt_flight_id: string | null;
  receipt_link_status: string;
}

/**
 * Projects one link.status observation that is a command-link report onto its flight: the flight thread item and the
 * flight revision. A report whose capture session's earliest report names another flight or aircraft is left out of
 * the thread, as the lost-link review leaves it out. Nothing is written to the retained session and source-event
 * tables: the reads that count reports take observations from the observations themselves (command-link-reports.ts).
 */
async function projectCommandLinkObservation(client: PoolClient, event: JournalEvent): Promise<string[]> {
  const row = (
    await client.query<ObservationReportRow>(
      `SELECT o.id,o.receipt_id,o.artifact_id,o.source_id,o.subject_kind,o.subject_ledger_id,o.content_digest,o.observation,
       r.flight_id AS receipt_flight_id,r.link_status AS receipt_link_status
       FROM observations o JOIN receipts r ON r.tenant_id=o.tenant_id AND r.id=o.receipt_id
       WHERE o.tenant_id=$1 AND o.event_id=$2 AND ${commandLinkObservationReport}`,
      [event.tenant_id, event.id],
    )
  ).rows[0];
  const flightId = row?.subject_ledger_id;
  if (!row || row.subject_kind !== 'flight' || !flightId) return [];
  if (row.receipt_flight_id !== flightId || row.receipt_link_status !== 'linked') return [];
  const report = commandLinkReportFromObservation(row.observation, {
    flightId,
    eventId: event.id,
    receiptId: row.receipt_id,
    sourceId: row.source_id,
  });
  if (!report) return [];
  await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    event.tenant_id,
    flightId,
  ]);
  await client.query(
    'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1),source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$2]::text[])) WHERE tenant_id=$3 AND id=$4',
    [event.received_at, event.source_id, event.tenant_id, flightId],
  );
  await client.query(
    `INSERT INTO timeline_items(id,tenant_id,flight_id,lane,kind,title,occurred_at,received_at,actor_id,source_id,payload,receipt_id,artifact_id,link_status)
     VALUES($1,$2,$3,'observed',$4,$5,$6,$7,$8,$9,$10,$11,$12,'linked') ON CONFLICT DO NOTHING`,
    [
      event.id,
      event.tenant_id,
      flightId,
      event.event_type,
      `Command link reported ${report.status}`,
      event.occurred_at,
      event.received_at,
      event.principal_id,
      event.source_id,
      row.observation,
      row.receipt_id,
      row.artifact_id,
    ],
  );
  await retainSubjectEvidence(client, event.tenant_id, [flightId], event);
  return [flightId];
}

/** Flights whose command-link reports a withdrawal or replacement of a link.status observation changed. */
async function correctedCommandLinkFlights(client: PoolClient, event: JournalEvent): Promise<string[]> {
  const flights = ((event.payload.affected as { subjects?: { kind: string; id: string; scope: string }[] }[]) ?? [])
    .flatMap((affected) => affected.subjects ?? [])
    .filter((subject) => subject.kind === 'flight' && subject.scope === 'ledger')
    .map((subject) => subject.id);
  if (!flights.length) return [];
  const reported = await client.query<{ flight_id: string }>(
    `SELECT DISTINCT t.flight_id FROM timeline_items t JOIN observations o ON o.tenant_id=t.tenant_id AND o.event_id=t.id
     WHERE t.tenant_id=$1 AND t.flight_id=ANY($2::text[]) AND o.observation_type='link.status'`,
    [event.tenant_id, flights],
  );
  return reported.rows.map((item) => item.flight_id);
}

registerObservationProjector({
  id: 'command-link-reports',
  type: 'link.status',
  project: async (client, event) => [
    ...(event.event_type === 'observation' ? await projectCommandLinkObservation(client, event) : []),
    ...(await correctedCommandLinkFlights(client, event)),
  ],
  // The lost-link review runs on the generic evaluator, which queues itself for observations and corrections.
  settle: async () => {},
});
