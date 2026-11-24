import { randomUUID } from 'node:crypto';
import type {
  CommandLinkAuthority,
  CommandLinkBaselineAuthority,
  CommandLinkBaselineInput,
  CommandLinkBaselineRecord,
  CommandLinkInput,
  Receipt,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import {
  appendEvent,
  appendLiveChange,
  readBoundedObject,
  withScope,
  type AuthContext,
  type ObjectStore,
  type Pool,
  type PoolClient,
} from '../../packages/persistence/src/index.js';
import { verifyCommandLinkInputSource } from '../../packages/domain/src/command-link.js';
import { verifyCommandLinkBaselineInputSource } from '../../packages/domain/src/command-link-baseline.js';
import { observationRegistry, validateObservation } from '../../packages/domain/src/observation-registry.js';
import { resolveSubject } from '../../packages/domain/src/observations.js';
import { retainSubjectEvidence } from '../../packages/domain/src/cuts.js';
import { getReceipt } from '../../packages/domain/src/index.js';

// RETAINED HISTORY FIXTURE. Ledger no longer accepts command-link reports or baselines through their own intake
// (reports arrive as link.status observations; baselines are refused with 410), but records accepted earlier stay
// readable and verifiable, and tests of those reads need some. This records them as the retired intake did in its last
// version, under the principal's own scope, so the worker projects and verifies them as it always has.

interface ArtifactRow {
  object_key: string;
  byte_length: number;
  sha256: string;
  content_type: string;
}

const BASELINE_AUTHORITY_VERSION = 'ledger.command-link-baseline-authority.1';

async function originalBytes(client: PoolClient, tenantId: string, artifactId: string, store: ObjectStore) {
  const artifact = (
    await client.query<ArtifactRow>(
      'SELECT object_key,byte_length,sha256,content_type FROM artifacts WHERE tenant_id=$1 AND id=$2',
      [tenantId, artifactId],
    )
  ).rows[0];
  if (!artifact) throw new Error('The fixture original was not uploaded');
  const bytes = await readBoundedObject(store, artifact.object_key, {
    maxBytes: artifact.byte_length,
    timeoutMs: 10000,
  });
  if (sha256(bytes) !== artifact.sha256) throw new Error('The fixture original differs from its digest');
  return bytes;
}

async function recordBaseline(
  client: PoolClient,
  principal: AuthContext,
  input: CommandLinkBaselineInput,
  store: ObjectStore,
): Promise<Receipt> {
  const actor = (
    await client.query<{ command_link_sources: string[] }>(
      'SELECT command_link_sources FROM principals WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, principal.id],
    )
  ).rows[0]!;
  const verified = verifyCommandLinkBaselineInputSource(
    input,
    await originalBytes(client, principal.tenantId, input.artifactId, store),
  );
  const authority: CommandLinkBaselineAuthority = {
    version: BASELINE_AUTHORITY_VERSION,
    principalId: principal.id,
    tenantId: principal.tenantId,
    principalRevision: principal.revision,
    inputKind: input.kind,
    sourceId: input.sourceId,
    requiredCapabilities: ['input:write', 'command-link:write'],
    grantedSources: [...actor.command_link_sources],
  };
  await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    principal.tenantId,
    input.subject.flightId,
  ]);
  const event = await appendEvent(client, principal, {
    type: input.kind,
    stream: `source:${principal.id}:${input.sourceId}:${input.sourceSessionId}`,
    sourceId: input.sourceId,
    sessionId: input.sourceSessionId,
    occurredAt: input.occurredAt,
    artifactId: input.artifactId,
    payload: { ...input, flightId: input.subject.flightId, acceptedAuthority: authority },
  });
  const receiptId = randomUUID();
  await client.query(
    `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,flight_id,artifact_id,link_status,payload,input_subject)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'linked',$10,$11)`,
    [
      receiptId,
      principal.tenantId,
      event.id,
      input.sourceId,
      input.kind,
      input.occurredAt,
      event.received_at,
      input.subject.flightId,
      input.artifactId,
      input.payload,
      input.subject,
    ],
  );
  await client.query(
    `INSERT INTO command_link_sessions(tenant_id,source_id,source_session_id,flight_id,aircraft_id,first_event_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      principal.tenantId,
      input.sourceId,
      input.sourceSessionId,
      input.subject.flightId,
      input.payload.aircraftId,
      event.id,
    ],
  );
  await client.query(
    `INSERT INTO command_link_source_events(tenant_id,source_id,source_session_id,source_event_id,flight_id,aircraft_id,receipt_id,event_id,content_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      principal.tenantId,
      input.sourceId,
      input.sourceSessionId,
      input.payload.sourceEventId,
      input.subject.flightId,
      input.payload.aircraftId,
      receiptId,
      event.id,
      verified.contentDigest,
    ],
  );
  const record: CommandLinkBaselineRecord = {
    eventId: event.id,
    receiptId,
    recordedAt: event.received_at.toISOString(),
    input,
    authority,
    original: { artifactId: input.artifactId, sha256: verified.sha256, byteLength: verified.byteLength },
  };
  await client.query(
    `INSERT INTO command_link_baselines(id,tenant_id,receipt_id,flight_id,aircraft_id,source_id,source_session_id,source_event_id,artifact_id,actor_id,occurred_at,recorded_at,record,record_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      event.id,
      principal.tenantId,
      receiptId,
      input.subject.flightId,
      input.payload.aircraftId,
      input.sourceId,
      input.sourceSessionId,
      input.payload.sourceEventId,
      input.artifactId,
      principal.id,
      input.occurredAt,
      event.received_at,
      record,
      canonicalDigest(record),
    ],
  );
  await retainSubjectEvidence(client, principal.tenantId, [input.subject.flightId], event);
  await client.query(
    'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=$1 WHERE tenant_id=$2 AND id=$3',
    [event.received_at, principal.tenantId, input.subject.flightId],
  );
  await appendLiveChange(client, principal.tenantId, input.subject.flightId, event.id, 'flight.updated', receiptId);
  return getReceipt(client, receiptId);
}

/** Records a baseline as the retired intake did, as the given principal, and returns its receipt. */
export function recordRetainedCommandLinkBaseline(
  pool: Pool,
  principal: Pick<AuthContext, 'id' | 'tenantId'>,
  input: CommandLinkBaselineInput,
  store: ObjectStore,
): Promise<Receipt> {
  return withScope(pool, principal, (client, current) => recordBaseline(client, current, input, store));
}

const BRIDGE_LIMITATION =
  'Recorded from an older command-link report; the original report and its retained intake records stay unchanged.';

async function recordReport(
  client: PoolClient,
  principal: AuthContext,
  input: CommandLinkInput,
  store: ObjectStore,
): Promise<Receipt> {
  const actor = (
    await client.query<{ command_link_sources: string[] }>(
      'SELECT command_link_sources FROM principals WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, principal.id],
    )
  ).rows[0]!;
  const verified = verifyCommandLinkInputSource(
    input,
    await originalBytes(client, principal.tenantId, input.artifactId, store),
  );
  const previous = (
    await client.query<{ receipt_id: string }>(
      'SELECT receipt_id FROM command_link_source_events WHERE tenant_id=$1 AND source_id=$2 AND source_session_id=$3 AND source_event_id=$4',
      [principal.tenantId, input.sourceId, input.sourceSessionId, input.payload.sourceEventId],
    )
  ).rows[0];
  if (previous) return getReceipt(client, previous.receipt_id);
  const session = await client.query(
    'SELECT 1 FROM command_link_sessions WHERE tenant_id=$1 AND source_id=$2 AND source_session_id=$3',
    [principal.tenantId, input.sourceId, input.sourceSessionId],
  );
  await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    principal.tenantId,
    input.subject.flightId,
  ]);
  await client.query(
    'UPDATE flight_views SET basis_revision=basis_revision+1,last_received_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
    [principal.tenantId, input.subject.flightId],
  );
  const acceptedAuthority: CommandLinkAuthority = {
    version: 'ledger.command-link-authority.1',
    principalId: principal.id,
    tenantId: principal.tenantId,
    principalRevision: principal.revision,
    inputKind: 'command-link.status',
    sourceId: input.sourceId,
    requiredCapabilities: ['input:write', 'command-link:write'],
    grantedSources: [...actor.command_link_sources],
  };
  const event = await appendEvent(client, principal, {
    type: input.kind,
    stream: `source:${principal.id}:${input.sourceId}:${input.sourceSessionId}`,
    sourceId: input.sourceId,
    sessionId: input.sourceSessionId,
    occurredAt: input.occurredAt,
    payload: { ...input, flightId: input.subject.flightId, acceptedAuthority },
    artifactId: input.artifactId,
  });
  await retainSubjectEvidence(client, principal.tenantId, [input.subject.flightId], event);
  const receiptId = randomUUID();
  await client.query(
    `INSERT INTO receipts(id,tenant_id,event_id,source_id,kind,occurred_at,received_at,flight_id,artifact_id,link_status,payload,input_subject)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'linked',$10,$11)`,
    [
      receiptId,
      principal.tenantId,
      event.id,
      input.sourceId,
      input.kind,
      input.occurredAt,
      event.received_at,
      input.subject.flightId,
      input.artifactId,
      input.payload,
      input.subject,
    ],
  );
  if (!session.rowCount)
    await client.query(
      `INSERT INTO command_link_sessions(tenant_id,source_id,source_session_id,flight_id,aircraft_id,first_event_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        principal.tenantId,
        input.sourceId,
        input.sourceSessionId,
        input.subject.flightId,
        input.payload.aircraftId,
        event.id,
      ],
    );
  await client.query(
    `INSERT INTO command_link_source_events(tenant_id,source_id,source_session_id,source_event_id,flight_id,aircraft_id,receipt_id,event_id,content_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      principal.tenantId,
      input.sourceId,
      input.sourceSessionId,
      input.payload.sourceEventId,
      input.subject.flightId,
      input.payload.aircraftId,
      receiptId,
      event.id,
      verified.contentDigest,
    ],
  );
  // The intake's last version also recorded each report as a link.status observation on the same event.
  const { position } = input.payload;
  const { observation } = validateObservation(observationRegistry(), {
    type: 'link.status',
    version: 1,
    subject: { kind: 'flight', id: input.subject.flightId, scope: 'ledger' },
    secondarySubject: { kind: 'aircraft', id: input.payload.aircraftId, scope: 'source' },
    occurredAt: input.occurredAt,
    sourceEventId: input.payload.sourceEventId,
    sourceSessionId: input.sourceSessionId,
    ...(position ? { position: { latitudeDegrees: position.latitude, longitudeDegrees: position.longitude } } : {}),
    fidelity: input.fidelity,
    limitations: [BRIDGE_LIMITATION],
    originalArtifactId: input.artifactId,
    values: {
      link: 'command_control',
      state: input.payload.status === 'lost' ? 'down' : 'up',
      report: 'transition',
      sourceEpisodeId: input.payload.incidentId,
    },
  });
  const secondary = await resolveSubject(
    client,
    principal.tenantId,
    input.sourceId,
    { kind: 'aircraft', id: input.payload.aircraftId, scope: 'source' },
    input.occurredAt,
  );
  await client.query(
    `INSERT INTO observations(id,tenant_id,receipt_id,event_id,artifact_id,principal_id,source_id,source_session_id,
       source_event_id,observation_type,observation_version,subject_kind,subject_id,subject_scope,subject_ledger_id,
       subject_resolution,secondary_subject_kind,secondary_subject_id,secondary_subject_scope,secondary_subject_ledger_id,
       secondary_subject_resolution,occurred_at,received_at,fidelity,content_digest,observation)
     VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,'link.status',1,'flight',$9,'ledger',$9,'ledger','aircraft',$10,'source',$11,$12,
       $13,$14,$15,$16,$17)`,
    [
      event.id,
      principal.tenantId,
      receiptId,
      input.artifactId,
      principal.id,
      input.sourceId,
      input.sourceSessionId,
      input.payload.sourceEventId,
      input.subject.flightId,
      input.payload.aircraftId,
      secondary.ledgerId ?? null,
      secondary.resolution,
      observation.occurredAt,
      event.received_at,
      observation.fidelity,
      canonicalDigest({ version: 'ledger.legacy-command-link-report.1', sourceId: input.sourceId, observation }),
      observation,
    ],
  );
  await appendLiveChange(client, principal.tenantId, input.subject.flightId, event.id, 'flight.updated', receiptId);
  return getReceipt(client, receiptId);
}

/** Records a command-link report as the retired intake did, as the given principal, and returns its receipt. */
export function recordRetainedCommandLinkReport(
  pool: Pool,
  principal: Pick<AuthContext, 'id' | 'tenantId'>,
  input: CommandLinkInput,
  store: ObjectStore,
): Promise<Receipt> {
  return withScope(pool, principal, (client, current) => recordReport(client, current, input, store));
}

/**
 * Gives a principal the authority the retired intake required (command-link:write and the source in its command-link
 * sources), as such principals held it when those records were accepted. Run as the database owner; Ledger itself no
 * longer grants either.
 */
export async function grantRetainedCommandLinkAuthority(
  admin: Pool,
  tenantId: string,
  principalId: string,
  sourceId: string,
): Promise<void> {
  await admin.query(
    `UPDATE principals SET
       capabilities=CASE WHEN 'command-link:write'=ANY(capabilities) THEN capabilities ELSE capabilities||ARRAY['command-link:write'] END,
       command_link_sources=CASE WHEN $3=ANY(command_link_sources) THEN command_link_sources ELSE command_link_sources||ARRAY[$3] END,
       revision=revision+1
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, principalId, sourceId],
  );
}
