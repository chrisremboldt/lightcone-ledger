import { randomUUID } from 'node:crypto';
import {
  DocumentBodySchema,
  DocumentBodyV2Schema,
  HazardBodySchema,
  ReportBodySchema,
  RiskMatrixBodySchema,
  SmsDecisionCommandSchema,
  SmsDocumentAcknowledgeCommandSchema,
  type SmsConfidentiality,
  type SmsDocumentAcknowledgement,
  type SmsExportCreate,
  type SmsExportRecord,
  type SmsExportScope,
  type SmsLink,
  type SmsWithheldItem,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize, INTEGRITY_VERSION, sha256 } from '@ledger/integrity';
import {
  DomainError,
  readBoundedObject,
  writeBoundedObject,
  type AuthContext,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';

export const SMS_EXPORT_FORMAT = 'ledger.sms-export.1';
const LIMITS = {
  maxRecords: 200,
  maxAttachments: 200,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
};
const STATEMENT =
  'This export covers the selected record and the records it depends on. It is not the complete history of the organization.';
const LIMITATIONS = [
  'Items listed as withheld are kept out by their confidentiality class. Their bytes and content are not in this file; their digests are.',
  'Signatures record the re-authentication Ledger observed, the intent statement shown, the signer’s authority and the digest of the signed content. They are not signatures made with the signer’s own key.',
  'Keep the manifest digest separately. This file is not externally timestamped.',
];
const WITHHELD_REASON: Record<SmsConfidentiality, string> = {
  ordinary: '',
  restricted_asset_information: 'Restricted asset information is not included in ordinary exports.',
  safety_report: 'Safety report content is not included in ordinary exports.',
};

interface RecordRow {
  id: string;
  kind: string;
  record_class: string;
  confidentiality: SmsConfidentiality;
  status: string;
  revision: string;
  links: SmsLink[];
}
interface LinkChangeRow {
  id: string;
  record_id: string;
  revision: string;
  added: SmsLink[];
  removed: SmsLink[];
  actor_id: string;
  recorded_at: Date;
}
interface VersionRow {
  id: string;
  record_id: string;
  version_number: number;
  revision: string;
  schema: string;
  title: string;
  body: Record<string, unknown>;
  body_digest: string;
  confidentiality: SmsConfidentiality;
  owner_id: string;
  due_at: Date | null;
  links: SmsLink[];
  actor_id: string;
  recorded_at: Date;
}
interface RestrictedVersionRow {
  id: string;
  record_id: string;
  version_number: number;
  revision: string;
  schema: string;
  confidentiality: Exclude<SmsConfidentiality, 'ordinary'>;
  content_digest: string;
  owner_id: string;
  due_at: Date | null;
  actor_id: string;
  recorded_at: Date;
}
interface AttachmentRow {
  id: string;
  document_version: { versionNumber: number; bodyDigest: string } | null;
  record_id: string;
  revision: string;
  label: string;
  confidentiality: SmsConfidentiality;
  sha256: string;
  byte_length: number;
  content_type: string;
  actor_id: string;
  recorded_at: Date;
  object_key: string | null;
}
interface SignatureRow {
  id: string;
  decision_id: string;
  subject_id: string;
  subject_revision: string;
  signer_id: string;
  meaning: string;
  intent: string;
  content: Record<string, unknown>;
  content_digest: string;
  authority: Record<string, unknown>;
  reauthentication: Record<string, unknown>;
  signed_at: Date;
}

const plain = (schema: unknown) => JSON.parse(JSON.stringify(schema)) as unknown;
const SCHEMA_DIGESTS = {
  'sms.hazard.1': canonicalDigest(plain(HazardBodySchema)),
  'sms.risk-matrix.1': canonicalDigest(plain(RiskMatrixBodySchema)),
  'sms.document.1': canonicalDigest(plain(DocumentBodySchema)),
  'sms.document.2': canonicalDigest(plain(DocumentBodyV2Schema)),
  'sms.report.1': canonicalDigest(plain(ReportBodySchema)),
  'sms.decision-command.1': canonicalDigest(plain(SmsDecisionCommandSchema)),
  'sms.document-acknowledge-command.1': canonicalDigest(plain(SmsDocumentAcknowledgeCommandSchema)),
};

async function closure(client: PoolClient, tenantId: string, seedIds: string[]): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `WITH RECURSIVE reached(id) AS (
       SELECT id FROM sms_records WHERE tenant_id=$1 AND id=ANY($2)
       UNION SELECT d.dependency_subject_id FROM subject_dependencies d JOIN reached r ON r.id=d.subject_id WHERE d.tenant_id=$1
     ) SELECT r.id FROM reached r JOIN sms_records s ON s.tenant_id=$1 AND s.id=r.id ORDER BY r.id COLLATE "C"`,
    [tenantId, seedIds],
  );
  return rows.rows.map((row) => row.id);
}

async function recordsActiveIn(client: PoolClient, tenantId: string, from: string, to: string): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `SELECT r.id FROM sms_records r JOIN streams s ON s.tenant_id=r.tenant_id AND s.name='sms:'||r.id
     WHERE r.tenant_id=$1 AND EXISTS(SELECT 1 FROM journal_events e
       WHERE e.tenant_id=s.tenant_id AND e.stream_id=s.id AND e.received_at>=$2 AND e.received_at<$3)
     ORDER BY r.id COLLATE "C"`,
    [tenantId, from, to],
  );
  return rows.rows.map((row) => row.id);
}

const utcTime = (iso: string) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

async function exportScope(client: PoolClient, tenantId: string, input: SmsExportCreate): Promise<SmsExportScope> {
  if ('recordId' in input) {
    const recordIds = await closure(client, tenantId, [input.recordId]);
    if (!recordIds.length)
      throw new DomainError(404, 'sms_record_not_found', 'The record was not found in your organization');
    return { kind: 'record_closure', recordId: input.recordId, recordIds, statement: STATEMENT };
  }
  const from = new Date(input.period.from).toISOString();
  const to = new Date(input.period.to).toISOString();
  if (from >= to) throw new DomainError(400, 'invalid_period', 'The period must end after it starts');
  const selectedRecordIds = await recordsActiveIn(client, tenantId, from, to);
  if (!selectedRecordIds.length)
    throw new DomainError(404, 'no_activity_in_period', 'No SMS record changed during that period');
  return {
    kind: 'period',
    from,
    to,
    selectedRecordIds,
    recordIds: await closure(client, tenantId, selectedRecordIds),
    statement: `This export covers the SMS records with recorded activity from ${utcTime(from)} up to ${utcTime(to)}, and the records they depend on, each with its full history up to the time of export. It is not the complete history of the organization.`,
  };
}

export async function createSmsExport(
  client: PoolClient,
  principal: AuthContext,
  input: SmsExportCreate,
  store: ObjectStore,
): Promise<SmsExportRecord> {
  if (!principal.capabilities.includes('sms:read'))
    throw new DomainError(403, 'capability_required', 'Capability sms:read is required');
  const scope = await exportScope(client, principal.tenantId, input);
  const { recordIds } = scope;
  if (recordIds.length > LIMITS.maxRecords)
    throw new DomainError(
      429,
      'export_budget_exceeded',
      scope.kind === 'period'
        ? 'The period covers too many records for one export; choose a shorter period'
        : 'The record depends on too many records for one export',
    );
  const records = (
    await client.query<RecordRow>(
      'SELECT id,kind,record_class,confidentiality,status,revision,links FROM sms_records WHERE tenant_id=$1 AND id=ANY($2) ORDER BY id COLLATE "C"',
      [principal.tenantId, recordIds],
    )
  ).rows;
  const versions = (
    await client.query<VersionRow>(
      'SELECT * FROM sms_record_versions WHERE tenant_id=$1 AND record_id=ANY($2) ORDER BY record_id COLLATE "C",version_number',
      [principal.tenantId, recordIds],
    )
  ).rows;
  const restrictedVersions = (
    await client.query<RestrictedVersionRow>(
      `SELECT id,record_id,version_number,revision,schema,confidentiality,content_digest,owner_id,due_at,actor_id,recorded_at
       FROM sms_restricted_record_versions WHERE tenant_id=$1 AND record_id=ANY($2)
       ORDER BY record_id COLLATE "C",version_number`,
      [principal.tenantId, recordIds],
    )
  ).rows;
  const attachmentRows = (
    await client.query<AttachmentRow>(
      `SELECT a.*,o.object_key,j.payload->'documentVersion' AS document_version FROM sms_attachments a
       JOIN journal_events j ON j.tenant_id=a.tenant_id AND j.id=a.id
       LEFT JOIN artifacts o ON o.tenant_id=a.tenant_id AND o.id=a.artifact_id AND a.confidentiality='ordinary'
       WHERE a.tenant_id=$1 AND a.record_id=ANY($2) ORDER BY a.record_id COLLATE "C",a.revision`,
      [principal.tenantId, recordIds],
    )
  ).rows;
  const linkChangeRows = (
    await client.query<LinkChangeRow>(
      `SELECT id,record_id,revision,added,removed,actor_id,recorded_at FROM sms_link_changes
       WHERE tenant_id=$1 AND record_id=ANY($2) ORDER BY record_id COLLATE "C",revision`,
      [principal.tenantId, recordIds],
    )
  ).rows;
  const origins = new Map(
    (
      await client.query<{ record_id: string; origin: Record<string, unknown> }>(
        'SELECT record_id,origin FROM sms_hazard_origins WHERE tenant_id=$1 AND record_id=ANY($2)',
        [principal.tenantId, recordIds],
      )
    ).rows.map((row) => [row.record_id, row.origin]),
  );
  if (attachmentRows.length > LIMITS.maxAttachments)
    throw new DomainError(429, 'export_budget_exceeded', 'The records carry too many attachments for one export');
  const decisions = (
    await client.query<{ record: Record<string, unknown> }>(
      `SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=ANY($2) AND record->>'version'='sms.decision.1'
       ORDER BY subject_id COLLATE "C",accepted_revision`,
      [principal.tenantId, recordIds],
    )
  ).rows.map((row) => row.record);
  const acknowledgements = (
    await client.query<{ record: SmsDocumentAcknowledgement }>(
      `SELECT record FROM sms_document_acknowledgements WHERE tenant_id=$1 AND record_id=ANY($2)
       ORDER BY record_id COLLATE "C",recorded_at,id`,
      [principal.tenantId, recordIds],
    )
  ).rows.map((row) => row.record);
  const signatures = (
    await client.query<SignatureRow>(
      'SELECT * FROM sms_signatures WHERE tenant_id=$1 AND subject_id=ANY($2) ORDER BY subject_id COLLATE "C",signed_at,id',
      [principal.tenantId, recordIds],
    )
  ).rows.map((row) => ({
    id: row.id,
    decisionId: row.decision_id,
    subjectId: row.subject_id,
    subjectRevision: Number(row.subject_revision),
    signerId: row.signer_id,
    meaning: row.meaning,
    intent: row.intent,
    content: row.content,
    contentDigest: row.content_digest,
    authority: row.authority,
    reauthentication: row.reauthentication,
    signedAt: row.signed_at.toISOString(),
  }));
  const withheld: SmsWithheldItem[] = [];
  const exportedRecords = records.map((record) => ({
    id: record.id,
    kind: record.kind,
    recordClass: record.record_class,
    confidentiality: record.confidentiality,
    status: record.status,
    revision: Number(record.revision),
    ...(origins.has(record.id) ? { origin: origins.get(record.id) } : {}),
    versions: [
      ...versions
        .filter((version) => version.record_id === record.id)
        .map((version) => ({
          eventId: version.id,
          versionNumber: version.version_number,
          revision: Number(version.revision),
          schema: version.schema,
          title: version.title,
          body: version.body,
          bodyDigest: version.body_digest,
          ownerId: version.owner_id,
          dueAt: version.due_at?.toISOString() ?? null,
          links: version.links,
          recordedBy: version.actor_id,
          recordedAt: version.recorded_at.toISOString(),
        })),
      ...restrictedVersions
        .filter((version) => version.record_id === record.id)
        .map((version) => {
          withheld.push({
            kind: 'record_body',
            id: version.id,
            recordId: record.id,
            confidentiality: version.confidentiality,
            sha256: version.content_digest,
            reason: WITHHELD_REASON[version.confidentiality],
          });
          return {
            eventId: version.id,
            versionNumber: version.version_number,
            revision: Number(version.revision),
            schema: version.schema,
            title: null,
            body: null,
            bodyDigest: version.content_digest,
            ownerId: version.owner_id,
            dueAt: version.due_at?.toISOString() ?? null,
            links: null,
            recordedBy: version.actor_id,
            recordedAt: version.recorded_at.toISOString(),
          };
        }),
    ],
    links: record.links,
    linkChanges: linkChangeRows
      .filter((change) => change.record_id === record.id)
      .map((change) => ({
        eventId: change.id,
        revision: Number(change.revision),
        added: change.added,
        removed: change.removed,
        recordedBy: change.actor_id,
        recordedAt: change.recorded_at.toISOString(),
      })),
    attachments: attachmentRows
      .filter((attachment) => attachment.record_id === record.id)
      .map((attachment) => ({
        id: attachment.id,
        ...(attachment.document_version ? { documentVersion: attachment.document_version } : {}),
        revision: Number(attachment.revision),
        label: attachment.label,
        confidentiality: attachment.confidentiality,
        sha256: attachment.sha256,
        byteLength: attachment.byte_length,
        contentType: attachment.content_type,
        recordedBy: attachment.actor_id,
        recordedAt: attachment.recorded_at.toISOString(),
      })),
    ...(record.kind === 'document'
      ? { documentAcknowledgements: acknowledgements.filter((receipt) => receipt.recordId === record.id) }
      : {}),
  }));
  const artifacts = [];
  let artifactBytes = 0;
  for (const attachment of attachmentRows) {
    if (attachment.confidentiality !== 'ordinary') {
      withheld.push({
        kind: 'attachment',
        id: attachment.id,
        recordId: attachment.record_id,
        confidentiality: attachment.confidentiality,
        sha256: attachment.sha256,
        byteLength: attachment.byte_length,
        reason: WITHHELD_REASON[attachment.confidentiality],
      });
      continue;
    }
    artifactBytes += attachment.byte_length;
    if (!attachment.object_key || artifactBytes > LIMITS.maxArtifactBytes)
      throw new DomainError(429, 'export_budget_exceeded', 'The attachments exceed the bounded export size');
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedObject(store, attachment.object_key, {
        maxBytes: attachment.byte_length,
        timeoutMs: 10000,
      });
    } catch {
      throw new DomainError(409, 'artifact_unavailable', 'An attachment’s original bytes are unavailable', {
        attachmentId: attachment.id,
      });
    }
    if (bytes.byteLength !== attachment.byte_length || sha256(bytes) !== attachment.sha256)
      throw new DomainError(409, 'artifact_integrity_failure', 'An attachment no longer matches its retained digest', {
        attachmentId: attachment.id,
      });
    artifacts.push({
      attachmentId: attachment.id,
      sha256: attachment.sha256,
      byteLength: attachment.byte_length,
      contentType: attachment.content_type,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  const personIds = [
    ...new Set([
      ...[...versions, ...restrictedVersions].flatMap((version) => [version.owner_id, version.actor_id]),
      ...attachmentRows.map((attachment) => attachment.actor_id),
      ...linkChangeRows.map((change) => change.actor_id),
      ...signatures.map((signature) => signature.signerId),
      ...decisions.map((decision) => String((decision.actor as { principalId: string }).principalId)),
      ...acknowledgements.map((receipt) => receipt.actor.principalId),
    ]),
  ].sort();
  const people = (
    await client.query<{ id: string; name: string }>(
      'SELECT id,name FROM principals WHERE tenant_id=$1 AND id=ANY($2) ORDER BY id COLLATE "C"',
      [principal.tenantId, personIds],
    )
  ).rows;
  const clock = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  const id = randomUUID();
  const sections = { records: exportedRecords, decisions, signatures, artifacts, withheld, people };
  const counts = {
    records: exportedRecords.length,
    decisions: decisions.length,
    signatures: signatures.length,
    attachments: artifacts.length,
    withheld: withheld.length,
  };
  const manifest = {
    format: SMS_EXPORT_FORMAT,
    exportId: id,
    tenantId: principal.tenantId,
    issuedBy: principal.id,
    issuedAt: clock.toISOString(),
    scope,
    integrity: INTEGRITY_VERSION,
    schemas: SCHEMA_DIGESTS,
    counts,
    sectionDigests: Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, canonicalDigest(value)])),
    limitations: [scope.statement, ...LIMITATIONS],
  };
  const manifestDigest = canonicalDigest(manifest);
  const bytes = Buffer.from(canonicalize({ format: SMS_EXPORT_FORMAT, manifest, manifestDigest, ...sections }), 'utf8');
  if (bytes.byteLength > LIMITS.maxBundleBytes)
    throw new DomainError(429, 'export_budget_exceeded', 'The export exceeds the bounded bundle size');
  const record: SmsExportRecord = {
    id,
    format: SMS_EXPORT_FORMAT,
    recordId: scope.kind === 'record_closure' ? scope.recordId : null,
    issuedBy: principal.id,
    issuedAt: manifest.issuedAt,
    bundleSha256: sha256(bytes),
    manifestDigest,
    byteLength: bytes.byteLength,
    counts,
    withheld,
    scope,
  };
  const key = `${principal.tenantId}/sms-exports/${id}/bundle`;
  await writeBoundedObject(store, key, bytes, 'application/json', 15000);
  await client.query(
    `INSERT INTO sms_exports(id,tenant_id,record_id,scope_kind,period_from,period_to,format,issued_by,issued_at,object_key,
     bundle_sha256,manifest_digest,byte_length,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      principal.tenantId,
      record.recordId,
      scope.kind,
      scope.kind === 'period' ? scope.from : null,
      scope.kind === 'period' ? scope.to : null,
      SMS_EXPORT_FORMAT,
      principal.id,
      manifest.issuedAt,
      key,
      record.bundleSha256,
      manifestDigest,
      bytes.byteLength,
      record,
    ],
  );
  return record;
}

export async function getSmsExport(
  client: PoolClient,
  id: string,
): Promise<{ record: SmsExportRecord; objectKey: string }> {
  const row = (
    await client.query<{ metadata: SmsExportRecord; object_key: string }>(
      'SELECT metadata,object_key FROM sms_exports WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'export_not_found', 'Export is unavailable within this scope');
  return { record: row.metadata, objectKey: row.object_key };
}
