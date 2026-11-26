import { randomBytes, randomUUID } from 'node:crypto';
import {
  assuranceTypes,
  type AssuranceBody,
  type CommandRecord,
  type SmsAttachmentAddCommand,
  type SmsConfidentiality,
  type SmsLink,
  type SmsRecordClass,
  type SmsRecordDraft,
  type SmsRecordKind,
  type SmsRecordLinksCommand,
  type SmsRecordOpenCommand,
  type SmsRecordReviseCommand,
  type SubjectBasisManifest,
} from '@ledger/contracts';
import { submittedReportChannelValues } from '@ledger/contracts';
import { canonicalDigest, canonicalize, sha256 } from '@ledger/integrity';
import {
  appendEvent,
  DomainError,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import { linkSubjectDependency, readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import { requireControlDraft } from './sms-controls.js';
import { riskMatrixProblems } from './sms-matrix.js';
import { requireOfferedPurposes } from './document-purposes.js';
import { lockRecordsOnFile, recordsOnFileScope, refreshRecordsOnFile } from './records-on-file.js';
import { linkedSubjectIds, prepareHazardOrigin, recordHazardOrigin, requireRevisedSource } from './sms-origins.js';
import { requireAssuranceDraft } from './sms-assurance.js';

interface KindPolicy {
  schema: SmsRecordDraft['schema'];
  recordClass: SmsRecordClass;
  confidentiality: readonly SmsConfidentiality[];
  initialStatus: string;
  writeCapability: string;
  closable: boolean;
  adoption?: 'matrix.adopt' | 'document.adopt' | 'assurance.sign';
}
export const SMS_KINDS: Record<SmsRecordKind, KindPolicy> = {
  hazard: {
    schema: 'sms.hazard.1',
    recordClass: 'srm_output',
    confidentiality: ['ordinary'],
    initialStatus: 'identified',
    writeCapability: 'sms:write',
    closable: true,
  },
  risk_matrix: {
    schema: 'sms.risk-matrix.1',
    recordClass: 'sms_documentation',
    confidentiality: ['ordinary'],
    initialStatus: 'draft',
    writeCapability: 'sms:configure',
    closable: false,
    adoption: 'matrix.adopt',
  },
  document: {
    schema: 'sms.document.1',
    recordClass: 'sms_documentation',
    confidentiality: ['ordinary'],
    initialStatus: 'draft',
    writeCapability: 'sms:write',
    closable: true,
    adoption: 'document.adopt',
  },
  report: {
    schema: 'sms.report.1',
    recordClass: 'safety_assurance_output',
    confidentiality: ['safety_report'],
    initialStatus: 'received',
    writeCapability: 'sms:write',
    closable: true,
  },
  control: {
    schema: 'sms.control.1',
    recordClass: 'srm_output',
    confidentiality: ['ordinary'],
    initialStatus: 'proposed',
    writeCapability: 'sms:write',
    closable: true,
  },
  assurance: {
    schema: 'sms.assurance.1',
    // The class of an assurance record is its type's (recordClassOf).
    recordClass: 'safety_assurance_output',
    confidentiality: ['ordinary'],
    initialStatus: 'draft',
    writeCapability: 'sms:write',
    closable: false,
    adoption: 'assurance.sign',
  },
};

/** The § 5.97 class a new record carries: its kind's, or for an assurance record its type's. */
function recordClassOf(draft: SmsRecordDraft): SmsRecordClass {
  return draft.kind === 'assurance'
    ? assuranceTypes[draft.body.assuranceType].recordClass
    : SMS_KINDS[draft.kind].recordClass;
}
export const confidentialityCapability: Record<SmsConfidentiality, string> = {
  ordinary: 'sms:read',
  safety_report: 'sms:report:read',
  restricted_asset_information: 'sms:restricted:read',
};
const restrictedLabel: Record<Exclude<SmsConfidentiality, 'ordinary'>, string> = {
  safety_report: 'Safety report',
  restricted_asset_information: 'Restricted record',
};
const restrictedReader: Record<Exclude<SmsConfidentiality, 'ordinary'>, string> = {
  safety_report: 'Recording a safety report needs permission to read safety reports',
  restricted_asset_information: 'Recording restricted asset information needs permission to read it',
};

export interface SmsRecordRow {
  id: string;
  tenant_id: string;
  kind: SmsRecordKind;
  record_class: SmsRecordClass;
  confidentiality: SmsConfidentiality;
  revision: string;
  projected_revision: string;
  version_number: number;
  status: string;
  title: string;
  owner_id: string;
  due_at: Date | null;
  opened_by: string;
  opened_at: Date;
  updated_at: Date;
  latest_assessment_id: string | null;
  latest_acceptance_id: string | null;
  links: SmsLink[];
  /** The organization's own id for the record, when it was opened with one. */
  reference: string | null;
}
export interface SmsVersionRow {
  id: string;
  record_id: string;
  version_number: number;
  revision: string;
  schema: string;
  record_class: SmsRecordClass;
  confidentiality: SmsConfidentiality;
  title: string;
  body: Record<string, unknown>;
  body_digest: string;
  owner_id: string;
  due_at: Date | null;
  links: SmsLink[];
  actor_id: string;
  recorded_at: Date;
}
/** The columns of sms_restricted_record_versions that ledger_app may select. */
export interface SmsRestrictedVersionRow {
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
export const RESTRICTED_VERSION_COLUMNS =
  'v.id,v.record_id,v.version_number,v.revision,v.schema,v.confidentiality,v.content_digest,v.owner_id,v.due_at,v.actor_id,v.recorded_at';

export const smsStream = (recordId: string) => `sms:${recordId}`;

export function requireCapability(principal: AuthContext, capability: string, message?: string): void {
  if (!principal.capabilities.includes(capability))
    throw new DomainError(403, 'capability_required', message ?? `Capability ${capability} is required`, {
      capability,
    });
}

/** The kinds of safety record that are controlled documents: what document:read opens. */
export const documentKinds: readonly SmsRecordKind[] = ['document', 'risk_matrix'];

/**
 * Refuses a principal who may not open safety records of this kind: sms:read opens every kind, document:read only the
 * controlled documents. Without a kind, only sms:read does.
 */
export function requireSmsRead(principal: AuthContext, kind?: SmsRecordKind): void {
  if (principal.capabilities.includes('sms:read')) return;
  if (kind && documentKinds.includes(kind) && principal.capabilities.includes('document:read')) return;
  requireCapability(principal, 'sms:read', 'Reading these safety records requires sms:read');
}

export async function lockSmsRecord(client: PoolClient, tenantId: string, id: string): Promise<SmsRecordRow> {
  await client.query('SELECT id FROM subjects WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, id]);
  const row = (
    await client.query<SmsRecordRow>('SELECT * FROM sms_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      tenantId,
      id,
    ])
  ).rows[0];
  if (!row) throw new DomainError(404, 'sms_record_not_found', 'The record was not found in your organization');
  return row;
}

export async function readSmsRecord(client: PoolClient, tenantId: string, id: string): Promise<SmsRecordRow> {
  const row = (
    await client.query<SmsRecordRow>('SELECT * FROM sms_records WHERE tenant_id=$1 AND id=$2', [tenantId, id])
  ).rows[0];
  if (!row) throw new DomainError(404, 'sms_record_not_found', 'The record was not found in your organization');
  return row;
}

export async function currentVersion(client: PoolClient, record: SmsRecordRow): Promise<SmsVersionRow> {
  const row = (
    await client.query<SmsVersionRow>(
      'SELECT * FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2 AND version_number=$3',
      [record.tenant_id, record.id, record.version_number],
    )
  ).rows[0];
  if (!row) throw new DomainError(409, 'sms_version_missing', 'The current record version is unavailable');
  return row;
}

/** Accepted stream positions only, so projection progress alone never makes a displayed basis stale. */
export function smsDependencyBasis(manifest: SubjectBasisManifest): string {
  return canonicalDigest({
    version: 'sms-basis.1',
    subjectId: manifest.subjectId,
    principalId: manifest.principalId,
    principalRevision: manifest.principalRevision,
    subjects: manifest.subjects,
    edges: manifest.edges,
    frontiers: manifest.frontiers.map(({ subjectId, streamId, sequence }) => ({ subjectId, streamId, sequence })),
    authority: manifest.authority
      ? { streamId: manifest.authority.streamId, sequence: manifest.authority.sequence }
      : null,
  });
}

export async function readSmsBasis(
  client: PoolClient,
  record: SmsRecordRow,
  principal: AuthContext,
  options: { lock?: boolean } = {},
) {
  // The basis a person's decision rests on (docs/design/decision-basis.md).
  const evidence = await readSubjectEvidence(client, record.id, principal, { ...options, decision: true });
  return { ...evidence, smsBasis: smsDependencyBasis(evidence.basisManifest) };
}

export function requireRevision(record: SmsRecordRow, expected: number): void {
  if (Number(record.revision) !== expected)
    throw new DomainError(409, 'stale_basis', 'This record changed since you opened it; review the latest version', {
      currentRevision: Number(record.revision),
    });
}

async function requireOwner(client: PoolClient, tenantId: string, ownerId: string): Promise<void> {
  const owner = await client.query(
    "SELECT 1 FROM principals WHERE tenant_id=$1 AND id=$2 AND active AND kind='human' FOR SHARE",
    [tenantId, ownerId],
  );
  if (!owner.rowCount)
    throw new DomainError(400, 'owner_unavailable', 'The owner must be an active person in your organization');
}

/**
 * Refuses a reference another record of the kind carries. The transaction-scoped lock on the reference makes a second
 * opener wait for the first, so the unique index is never the one to refuse.
 */
async function requireFreeReference(
  client: PoolClient,
  tenantId: string,
  kind: SmsRecordKind,
  reference: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `sms-reference|${tenantId}|${kind}|${reference}`,
  ]);
  const taken = await client.query<{ id: string }>(
    'SELECT id FROM sms_records WHERE tenant_id=$1 AND kind=$2 AND reference=$3',
    [tenantId, kind, reference],
  );
  if (taken.rows[0])
    throw new DomainError(409, 'reference_in_use', `Another record already carries the reference ${reference}`, {
      recordId: taken.rows[0].id,
      reference,
    });
}

async function linkedRecordIds(
  client: PoolClient,
  tenantId: string,
  links: SmsLink[],
  selfId?: string,
): Promise<string[]> {
  if (new Set(links.map((link) => canonicalize(link))).size !== links.length)
    throw new DomainError(400, 'duplicate_link', 'The same link is listed twice');
  const ids = [...new Set(links.flatMap((link) => (link.target.kind === 'sms_record' ? [link.target.id] : [])))].sort();
  if (selfId && ids.includes(selfId)) throw new DomainError(400, 'link_to_self', 'A record cannot link to itself');
  if (!ids.length) return [];
  const found = await client.query<{ id: string }>('SELECT id FROM sms_records WHERE tenant_id=$1 AND id=ANY($2)', [
    tenantId,
    ids,
  ]);
  if (found.rowCount !== ids.length)
    throw new DomainError(400, 'link_target_unavailable', 'A linked record was not found in your organization');
  return ids;
}

/** Every Ledger subject a record's links make it depend on: linked records, flights and finding subjects. */
async function linkDependencies(
  client: PoolClient,
  tenantId: string,
  links: SmsLink[],
  selfId?: string,
): Promise<{ recordIds: string[]; subjectIds: string[] }> {
  const recordIds = await linkedRecordIds(client, tenantId, links, selfId);
  const others = await linkedSubjectIds(client, tenantId, links);
  return { recordIds, subjectIds: [...new Set([...recordIds, ...others])].sort() };
}

function validateDraft(draft: SmsRecordDraft): KindPolicy {
  const policy = SMS_KINDS[draft.kind];
  if (draft.schema !== policy.schema && !(draft.kind === 'document' && draft.schema === 'sms.document.2'))
    throw new DomainError(400, 'unsupported_record_schema', 'The record body uses an unsupported schema version');
  if (draft.kind === 'risk_matrix') {
    const problems = riskMatrixProblems(draft.body);
    if (problems.length) throw new DomainError(400, 'invalid_risk_matrix', problems[0], { problems });
  }
  if (draft.kind === 'document' && draft.schema === 'sms.document.2' && draft.body.origin === 'received') {
    const source = draft.body.source;
    // A date-only issue date began earliest at UTC+14, so only a date that had not started anywhere is refused.
    const issuedFrom =
      source.issuedAt && (source.issuedAt.includes('T') ? source.issuedAt : `${source.issuedAt}T00:00:00+14:00`);
    if (
      Date.parse(source.receivedAt) > Date.now() ||
      (issuedFrom && Date.parse(issuedFrom) > Date.parse(source.receivedAt))
    )
      throw new DomainError(
        400,
        'invalid_source_dates',
        'The source issue date must precede receipt, and receipt cannot be in the future',
      );
  }
  if (
    draft.kind === 'report' &&
    (submittedReportChannelValues as readonly string[]).includes(draft.body.received.channel)
  )
    throw new DomainError(
      400,
      'report_channel_submitted',
      'A report submitted to Ledger is recorded by Ledger itself; record how you received this one',
    );
  if (draft.dueAt && !Number.isFinite(Date.parse(draft.dueAt)))
    throw new DomainError(400, 'invalid_due_date', 'The due date is not a valid time');
  return policy;
}

async function insertVersion(
  client: PoolClient,
  principal: AuthContext,
  recordId: string,
  versionNumber: number,
  revision: number,
  record: { recordClass: SmsRecordClass; confidentiality: SmsConfidentiality },
  draft: SmsRecordDraft,
  event: JournalEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO sms_record_versions(id,tenant_id,record_id,version_number,revision,schema,record_class,confidentiality,
     title,body,body_canonical,body_digest,owner_id,due_at,links,actor_id,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      event.id,
      principal.tenantId,
      recordId,
      versionNumber,
      revision,
      draft.schema,
      record.recordClass,
      record.confidentiality,
      draft.title,
      draft.body,
      canonicalize(draft.body),
      canonicalDigest(draft.body),
      draft.ownerId,
      draft.dueAt ?? null,
      JSON.stringify(draft.links ?? []),
      principal.id,
      event.received_at,
    ],
  );
}

export async function restrictedTitle(
  client: PoolClient,
  confidentiality: Exclude<SmsConfidentiality, 'ordinary'>,
): Promise<string> {
  const day = await client.query<{ day: string }>(
    "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
  );
  return `${restrictedLabel[confidentiality]} recorded ${day.rows[0].day}`;
}

export interface RestrictedContent {
  salt: string;
  canonical: string;
  digest: string;
}

export function restrictedContent(draft: SmsRecordDraft): RestrictedContent {
  const salt = randomBytes(32).toString('hex');
  const canonical = canonicalize({
    salt,
    schema: draft.schema,
    title: draft.title,
    body: draft.body,
    links: draft.links ?? [],
  });
  return { salt, canonical, digest: sha256(canonical) };
}

/** What the journal and command_records keep of a restricted draft: its shape and commitment, never its text. */
export function restrictedCommand(
  command: SmsRecordOpenCommand | SmsRecordReviseCommand,
  content: RestrictedContent,
  linkedRecordIds: string[],
): { kind: CommandRecord['kind'] } & Record<string, unknown> {
  const { record, ...rest } = command;
  return {
    ...rest,
    record: {
      kind: record.kind,
      schema: record.schema,
      ownerId: record.ownerId,
      dueAt: record.dueAt ?? null,
      linkedRecordIds,
    },
    contentDigest: content.digest,
  };
}

export async function insertRestrictedVersion(
  client: PoolClient,
  principal: AuthContext,
  recordId: string,
  versionNumber: number,
  revision: number,
  record: { recordClass: SmsRecordClass; confidentiality: SmsConfidentiality },
  draft: SmsRecordDraft,
  content: RestrictedContent,
  event: JournalEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO sms_restricted_record_versions(id,tenant_id,record_id,version_number,revision,schema,record_class,
     confidentiality,salt,title,body,links,content_canonical,content_digest,owner_id,due_at,actor_id,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      event.id,
      principal.tenantId,
      recordId,
      versionNumber,
      revision,
      draft.schema,
      record.recordClass,
      record.confidentiality,
      content.salt,
      draft.title,
      draft.body,
      JSON.stringify(draft.links ?? []),
      content.canonical,
      content.digest,
      draft.ownerId,
      draft.dueAt ?? null,
      principal.id,
      event.received_at,
    ],
  );
}

export async function recordCommand(
  client: PoolClient,
  principal: AuthContext,
  event: JournalEvent,
  command: { kind: CommandRecord['kind'] } & Record<string, unknown>,
  recordId: string,
): Promise<CommandRecord> {
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, principal.tenantId, command.kind, principal.id, event.received_at, command],
  );
  return {
    id: event.id,
    kind: command.kind,
    subject: { kind: 'sms', id: recordId },
    actorId: principal.id,
    recordedAt: event.received_at.toISOString(),
    payload: { ...command },
  };
}

export async function openSmsRecord(
  client: PoolClient,
  principal: AuthContext,
  sent: SmsRecordOpenCommand,
  store?: ObjectStore,
): Promise<CommandRecord> {
  const policy = validateDraft(sent.record);
  requireCapability(principal, policy.writeCapability);
  if (sent.origin && sent.record.kind !== 'hazard')
    throw new DomainError(400, 'origin_not_supported', 'Only a hazard records where it came from');
  const confidentiality = sent.confidentiality ?? policy.confidentiality[0];
  if (!policy.confidentiality.includes(confidentiality))
    throw new DomainError(
      400,
      'confidentiality_not_supported',
      sent.record.kind === 'report'
        ? 'A safety report is always restricted to people cleared to read reports.'
        : 'Hazards, controls, safety assurance records and SMS documentation are ordinary records. Put restricted asset detail in a restricted attachment.',
    );
  if (confidentiality !== 'ordinary')
    requireCapability(principal, confidentialityCapability[confidentiality], restrictedReader[confidentiality]);
  await requireOwner(client, principal.tenantId, sent.record.ownerId);
  if (sent.reference !== undefined)
    await requireFreeReference(client, principal.tenantId, sent.record.kind, sent.reference);
  await requireOfferedPurposes(client, principal.tenantId, sent.record);
  await requireControlDraft(client, principal.tenantId, sent.record);
  const assuranceLinks = await requireAssuranceDraft(client, principal.tenantId, sent.record);
  const origin =
    sent.record.kind === 'hazard'
      ? await prepareHazardOrigin(client, principal, sent.record, sent.origin ?? { kind: 'manual' })
      : undefined;
  const command: SmsRecordOpenCommand =
    origin && origin.origin.kind !== 'manual'
      ? { ...sent, record: { ...sent.record, links: origin.links } }
      : assuranceLinks && assuranceLinks !== sent.record.links
        ? { ...sent, record: { ...sent.record, links: assuranceLinks } }
        : sent;
  const draft = command.record;
  const { recordIds: linked, subjectIds: dependencies } = await linkDependencies(
    client,
    principal.tenantId,
    draft.links ?? [],
  );
  const content = confidentiality === 'ordinary' ? undefined : restrictedContent(draft);
  const title = confidentiality === 'ordinary' ? draft.title : await restrictedTitle(client, confidentiality);
  const id = randomUUID();
  await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'sms',$3)", [
    id,
    principal.tenantId,
    title,
  ]);
  const recordClass = recordClassOf(draft);
  const envelope = { recordId: id, recordKind: draft.kind, recordClass, confidentiality };
  const retained = content ? restrictedCommand(command, content, linked) : command;
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: smsStream(id),
    payload: content
      ? { ...retained, ...envelope, versionNumber: 1 }
      : {
          ...command,
          ...envelope,
          versionNumber: 1,
          bodyDigest: canonicalDigest(draft.body),
          ...(origin ? { recordedOrigin: origin.origin } : {}),
        },
  });
  await client.query(
    `INSERT INTO sms_records(id,tenant_id,kind,record_class,confidentiality,revision,version_number,status,title,
     owner_id,due_at,opened_by,opened_at,updated_at,links,reference)
     VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,$10,$11,$11,$12,$13)`,
    [
      id,
      principal.tenantId,
      draft.kind,
      recordClass,
      confidentiality,
      policy.initialStatus,
      title,
      draft.ownerId,
      draft.dueAt ?? null,
      principal.id,
      event.received_at,
      JSON.stringify(content ? [] : (draft.links ?? [])),
      sent.reference ?? null,
    ],
  );
  const classes = { recordClass, confidentiality };
  if (content) await insertRestrictedVersion(client, principal, id, 1, 1, classes, draft, content, event);
  else await insertVersion(client, principal, id, 1, 1, classes, draft, event);
  if (origin) await recordHazardOrigin(client, principal, id, origin.origin, event);
  await retainSubjectEvidence(client, principal.tenantId, [id], event);
  const subjects = new Set([...dependencies, ...(origin?.dependencySubjectId ? [origin.dependencySubjectId] : [])]);
  for (const target of subjects) await linkSubjectDependency(client, principal.tenantId, id, target, event.id);
  // A new record has no observations to correct, so nothing is locked for them first.
  const onFile = recordsOnFileScope(draft.kind, id, command.kind);
  await refreshRecordsOnFile(client, principal, onFile, { eventId: event.id, at: event.received_at }, store);
  return recordCommand(client, principal, event, retained, id);
}

const reviseStatus: Record<string, string> = {
  awaiting_acceptance: 'needs_reassessment',
  accepted: 'needs_reassessment',
  adopted: 'draft',
  reviewed: 'draft',
  signed: 'draft',
};

export async function reviseSmsRecord(
  client: PoolClient,
  principal: AuthContext,
  sent: SmsRecordReviseCommand,
  store?: ObjectStore,
): Promise<CommandRecord> {
  let command = sent;
  const onFile = recordsOnFileScope(
    (await readSmsRecord(client, principal.tenantId, command.recordId)).kind,
    command.recordId,
    command.kind,
  );
  await lockRecordsOnFile(client, principal.tenantId, onFile);
  const record = await lockSmsRecord(client, principal.tenantId, command.recordId);
  requireRevision(record, command.expectedRevision);
  if (record.status === 'closed')
    throw new DomainError(409, 'record_closed', 'This record is closed; reopen it before recording a new version');
  let draft = command.record;
  if (draft.kind !== record.kind)
    throw new DomainError(400, 'record_kind_fixed', 'A record keeps the kind it was opened with');
  const policy = validateDraft(draft);
  requireCapability(principal, policy.writeCapability);
  if (record.confidentiality !== 'ordinary')
    requireCapability(
      principal,
      confidentialityCapability[record.confidentiality],
      restrictedReader[record.confidentiality],
    );
  await requireOwner(client, principal.tenantId, draft.ownerId);
  await requireRevisedSource(client, principal.tenantId, record.id, draft);
  if (record.kind === 'document')
    await requireOfferedPurposes(
      client,
      principal.tenantId,
      draft,
      ((await currentVersion(client, record)).body as { purposes?: string[] }).purposes ?? [],
    );
  if (record.kind === 'control')
    await requireControlDraft(client, principal.tenantId, draft, await currentVersion(client, record));
  const assuranceLinks =
    record.kind === 'assurance'
      ? await requireAssuranceDraft(client, principal.tenantId, draft, {
          record,
          body: (await currentVersion(client, record)).body as AssuranceBody,
        })
      : undefined;
  if (assuranceLinks && assuranceLinks !== draft.links) {
    draft = { ...draft, links: assuranceLinks };
    command = { ...command, record: draft };
  }
  const { recordIds: linked, subjectIds: dependencies } = await linkDependencies(
    client,
    principal.tenantId,
    draft.links ?? [],
    record.id,
  );
  const content = record.confidentiality === 'ordinary' ? undefined : restrictedContent(draft);
  const retained = content ? restrictedCommand(command, content, linked) : command;
  const versionNumber = record.version_number + 1;
  const revision = Number(record.revision) + 1;
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: smsStream(record.id),
    payload: content
      ? { ...retained, versionNumber }
      : { ...command, versionNumber, bodyDigest: canonicalDigest(draft.body) },
  });
  const status = reviseStatus[record.status] ?? record.status;
  const links = content ? [] : (draft.links ?? []);
  await client.query(
    `UPDATE sms_records SET revision=$1,version_number=$2,status=$3,title=$4,owner_id=$5,due_at=$6,updated_at=$7,links=$8
     WHERE tenant_id=$9 AND id=$10`,
    [
      revision,
      versionNumber,
      status,
      content ? record.title : draft.title,
      draft.ownerId,
      draft.dueAt ?? null,
      event.received_at,
      JSON.stringify(links),
      principal.tenantId,
      record.id,
    ],
  );
  await insertLinkChange(client, principal, record, revision, links, event);
  const classes = { recordClass: record.record_class, confidentiality: record.confidentiality };
  if (content)
    await insertRestrictedVersion(
      client,
      principal,
      record.id,
      versionNumber,
      revision,
      classes,
      draft,
      content,
      event,
    );
  else await insertVersion(client, principal, record.id, versionNumber, revision, classes, draft, event);
  await retainSubjectEvidence(client, principal.tenantId, [record.id], event);
  for (const target of dependencies)
    await linkSubjectDependency(client, principal.tenantId, record.id, target, event.id);
  await refreshRecordsOnFile(client, principal, onFile, { eventId: event.id, at: event.received_at }, store);
  return recordCommand(client, principal, event, retained, record.id);
}

function linkDifference(before: SmsLink[], after: SmsLink[]): { added: SmsLink[]; removed: SmsLink[] } {
  const keys = (links: SmsLink[]) => new Set(links.map((link) => canonicalize(link)));
  const had = keys(before);
  const has = keys(after);
  return {
    added: after.filter((link) => !had.has(canonicalize(link))),
    removed: before.filter((link) => !has.has(canonicalize(link))),
  };
}

async function insertLinkChange(
  client: PoolClient,
  principal: AuthContext,
  record: SmsRecordRow,
  revision: number,
  links: SmsLink[],
  event: JournalEvent,
): Promise<void> {
  if (record.confidentiality !== 'ordinary') return;
  const { added, removed } = linkDifference(record.links, links);
  if (!added.length && !removed.length) return;
  await client.query(
    `INSERT INTO sms_link_changes(id,tenant_id,record_id,revision,added,removed,links,actor_id,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      event.id,
      principal.tenantId,
      record.id,
      revision,
      JSON.stringify(added),
      JSON.stringify(removed),
      JSON.stringify(links),
      principal.id,
      event.received_at,
    ],
  );
}

export async function setSmsRecordLinks(
  client: PoolClient,
  principal: AuthContext,
  command: SmsRecordLinksCommand,
): Promise<CommandRecord> {
  const record = await lockSmsRecord(client, principal.tenantId, command.recordId);
  requireRevision(record, command.expectedRevision);
  requireCapability(principal, SMS_KINDS[record.kind].writeCapability);
  if (record.confidentiality !== 'ordinary')
    throw new DomainError(
      409,
      'restricted_links',
      'Links on a restricted record are part of its restricted content; record a new version to change them',
    );
  if (record.status === 'closed')
    throw new DomainError(409, 'record_closed', 'This record is closed; reopen it before changing its links');
  const { subjectIds: dependencies } = await linkDependencies(client, principal.tenantId, command.links, record.id);
  const { added, removed } = linkDifference(record.links, command.links);
  if (!added.length && !removed.length)
    throw new DomainError(400, 'links_unchanged', 'The record already has exactly these links');
  const revision = Number(record.revision) + 1;
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: smsStream(record.id),
    payload: { ...command, revision, added, removed },
  });
  await client.query('UPDATE sms_records SET revision=$1,links=$2,updated_at=$3 WHERE tenant_id=$4 AND id=$5', [
    revision,
    JSON.stringify(command.links),
    event.received_at,
    principal.tenantId,
    record.id,
  ]);
  await insertLinkChange(client, principal, record, revision, command.links, event);
  await retainSubjectEvidence(client, principal.tenantId, [record.id], event);
  for (const target of dependencies)
    await linkSubjectDependency(client, principal.tenantId, record.id, target, event.id);
  return recordCommand(client, principal, event, command, record.id);
}

interface UploadRow {
  id: string;
  principal_id: string;
  status: string;
  confidentiality: SmsConfidentiality;
  artifact_id: string | null;
}
interface StoredBytesRow {
  id: string;
  sha256: string;
  byte_length: number;
  content_type: string;
}

export async function addSmsAttachment(
  client: PoolClient,
  principal: AuthContext,
  command: SmsAttachmentAddCommand,
): Promise<CommandRecord> {
  requireCapability(principal, 'sms:write');
  const record = await lockSmsRecord(client, principal.tenantId, command.recordId);
  requireRevision(record, command.expectedRevision);
  const upload = (
    await client.query<UploadRow>(
      'SELECT id,principal_id,status,confidentiality,artifact_id FROM uploads WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, command.attachment.uploadId],
    )
  ).rows[0];
  if (!upload) throw new DomainError(404, 'upload_not_found', 'The upload was not found in your organization');
  if (upload.principal_id !== principal.id)
    throw new DomainError(403, 'upload_owner_required', 'Attach files you uploaded yourself');
  if (upload.status !== 'finalized' || !upload.artifact_id)
    throw new DomainError(409, 'upload_incomplete', 'Finish uploading the file before attaching it');
  if (record.confidentiality !== 'ordinary') {
    requireCapability(
      principal,
      confidentialityCapability[record.confidentiality],
      restrictedReader[record.confidentiality],
    );
    if (upload.confidentiality !== record.confidentiality)
      throw new DomainError(
        400,
        'attachment_class_mismatch',
        'Files on a restricted record must be uploaded with the same confidentiality as the record',
      );
  }
  const label = record.confidentiality === 'ordinary' ? command.attachment.label : 'Restricted attachment';
  const ordinary = upload.confidentiality === 'ordinary';
  const stored = (
    await client.query<StoredBytesRow>(
      `SELECT id,sha256,byte_length,content_type FROM ${ordinary ? 'artifacts' : 'restricted_artifacts'}
       WHERE tenant_id=$1 AND id=$2`,
      [principal.tenantId, upload.artifact_id],
    )
  ).rows[0];
  if (!stored) throw new DomainError(409, 'upload_incomplete', 'The retained file is unavailable');
  const revision = Number(record.revision) + 1;
  const retained = { ...command, attachment: { ...command.attachment, label } };
  const documentVersion = record.kind === 'document' ? await currentVersion(client, record) : undefined;
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: smsStream(record.id),
    payload: {
      ...retained,
      ...(documentVersion
        ? {
            documentVersion: { versionNumber: documentVersion.version_number, bodyDigest: documentVersion.body_digest },
          }
        : {}),
      confidentiality: upload.confidentiality,
      sha256: stored.sha256,
      byteLength: stored.byte_length,
      contentType: stored.content_type,
    },
    ...(ordinary ? { artifactId: stored.id } : {}),
  });
  await client.query(
    `INSERT INTO sms_attachments(id,tenant_id,record_id,revision,label,confidentiality,artifact_id,restricted_artifact_id,
     sha256,byte_length,content_type,actor_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      event.id,
      principal.tenantId,
      record.id,
      revision,
      label,
      upload.confidentiality,
      ordinary ? stored.id : null,
      ordinary ? null : stored.id,
      stored.sha256,
      stored.byte_length,
      stored.content_type,
      principal.id,
      event.received_at,
    ],
  );
  await client.query('UPDATE sms_records SET revision=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4', [
    revision,
    event.received_at,
    principal.tenantId,
    record.id,
  ]);
  await retainSubjectEvidence(client, principal.tenantId, [record.id], event);
  return recordCommand(client, principal, event, retained, record.id);
}
