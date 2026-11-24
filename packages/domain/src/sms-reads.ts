import { findingAttention, readOpenFindingEntries } from './open-findings.js';
import type {
  AssessedPosition,
  AssuranceBody,
  MatrixVersionRef,
  RiskAcceptance,
  RiskMatrixBody,
  SmsAction,
  SmsAssessmentOutcome,
  SmsAdoptedMatrix,
  SmsAttachment,
  SmsConfidentiality,
  SmsDecisionRecord,
  SmsClosingReview,
  SmsHomeResponse,
  SmsCurrentLink,
  SmsLink,
  SmsLinkChange,
  SmsLinkedFrom,
  SmsLinkedRecord,
  SmsPersonRef,
  SmsRecordContentResponse,
  SmsRecordDetailResponse,
  SmsRecordKind,
  SmsRecordSummary,
  SmsRecordVersion,
  SmsRegisterResponse,
  SmsSignatureRecord,
  SmsSigningPreviewResponse,
  SignedContent,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { reportLinksInForce } from './safety-report-submission.js';
import {
  adoptedMatrix,
  adoptionContext,
  riskAcceptanceContext,
  type AdoptedMatrix,
  type SigningContext,
} from './sms-decisions.js';
import {
  confidentialityCapability,
  readSmsBasis,
  readSmsRecord,
  requireCapability,
  RESTRICTED_VERSION_COLUMNS,
  SMS_KINDS,
  type SmsRecordRow,
  type SmsRestrictedVersionRow,
  type SmsVersionRow,
} from './sms-envelope.js';
import { coveringRiskCapability, highestRiskAuthority } from './sms-matrix.js';
import { hazardEvidence, hazardOrigin } from './sms-origins.js';
import { hazardControls } from './sms-controls.js';
import { listControlTypes } from './control-types.js';
import { observationTypeChoices } from './observation-registry.js';
import { lockSubjects } from './cuts.js';

import { documentAcknowledgements, projectDocumentControl } from './sms-documents.js';
import { documentReading, documentSummaries } from './sms-reading.js';
import { assuranceActionsDue, assuranceSummaries, assuranceView } from './sms-assurance.js';

const REGISTER_LIMIT = 200;
const restrictedContentReason: Record<SmsConfidentiality, string> = {
  ordinary: 'This record is not restricted; its content is shown on the record.',
  safety_report: 'Reading this report needs permission to read safety reports.',
  restricted_asset_information: 'Reading this record needs permission to read restricted asset information.',
};

interface SummaryRow extends SmsRecordRow {
  owner_name: string;
  version_schema: string | null;
  residual: AssessedPosition | null;
  assessed_matrix: MatrixVersionRef | null;
  origin_kind: NonNullable<SmsRecordSummary['origin']>['kind'] | null;
  origin_finding_id: string | null;
  origin_subject: NonNullable<SmsRecordSummary['origin']>['subject'] | null;
  now: Date;
}
interface PersonRow {
  id: string;
  name: string;
  capabilities: string[];
}
interface SignatureRow {
  id: string;
  decision_id: string;
  subject_id: string;
  subject_revision: string;
  signer_id: string;
  signer_name: string;
  meaning: SignedContent['meaning'];
  intent: string;
  content: SignedContent;
  content_digest: string;
  authority: SmsSignatureRecord['authority'];
  reauthentication: SmsSignatureRecord['reauthentication'];
  signed_at: Date;
}
interface AttachmentRow {
  id: string;
  document_version: { versionNumber: number; bodyDigest: string } | null;
  label: string;
  confidentiality: SmsConfidentiality;
  sha256: string;
  byte_length: number;
  content_type: string;
  revision: string;
  actor_id: string;
  actor_name: string;
  recorded_at: Date;
}

const summarySql = `SELECT r.*,o.name AS owner_name,v.schema AS version_schema,
 a.record->'outcome'->'residual' AS residual,
 a.record->'outcome'->'matrix' AS assessed_matrix,
 h.kind AS origin_kind,h.finding_id AS origin_finding_id,h.origin->'subject' AS origin_subject,clock_timestamp() AS now
 FROM sms_records r JOIN principals o ON o.tenant_id=r.tenant_id AND o.id=r.owner_id
 LEFT JOIN sms_record_versions v ON v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=r.version_number
 LEFT JOIN decisions a ON a.tenant_id=r.tenant_id AND a.subject_id=r.id AND a.id=r.latest_assessment_id
 LEFT JOIN sms_hazard_origins h ON h.tenant_id=r.tenant_id AND h.record_id=r.id`;

/** A record someone with adoption authority can sign now; a controlled document revision must be reviewed first. */
function readyToAdopt(record: { kind: SmsRecordKind; status: string }, versionSchema: string | null): boolean {
  if (!SMS_KINDS[record.kind].adoption) return false;
  if (record.kind === 'document' && versionSchema === 'sms.document.2') return record.status === 'reviewed';
  return ['draft', 'reviewed'].includes(record.status);
}

function isControlledRevision(row: SummaryRow): boolean {
  return row.kind === 'document' && row.version_schema === 'sms.document.2';
}

/** Records whose working version has an issue that was not withdrawn. */
async function issuedWorkingVersions(client: PoolClient, tenantId: string, rows: SummaryRow[]): Promise<Set<string>> {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return new Set();
  const issued = await client.query<{ subject_id: string; version_number: number }>(
    `SELECT d.subject_id,(d.record->'outcome'->'document'->>'versionNumber')::int AS version_number
     FROM decisions d WHERE d.tenant_id=$1 AND d.kind='document.issue' AND d.subject_id=ANY($2)
       AND NOT EXISTS(SELECT 1 FROM decisions w WHERE w.tenant_id=d.tenant_id AND w.subject_id=d.subject_id
         AND w.kind='document.withdraw' AND w.record->'outcome'->>'issueId'=d.id::text)`,
    [tenantId, ids],
  );
  const working = new Map(rows.map((row) => [row.id, row.version_number]));
  return new Set(
    issued.rows.filter((row) => working.get(row.subject_id) === row.version_number).map((row) => row.subject_id),
  );
}

async function documentWork(
  client: PoolClient,
  principal: AuthContext,
  rows: SummaryRow[],
  matrix: AdoptedMatrix | null,
) {
  if (!principal.capabilities.includes('sms:write')) return { documentsToReview: [], documentsToIssue: [] };
  const controlled = rows.filter(isControlledRevision);
  const signed = controlled.filter((row) => row.status === 'adopted');
  const issued = await issuedWorkingVersions(client, principal.tenantId, signed);
  return {
    documentsToReview: controlled.filter((row) => row.status === 'draft').map((row) => summary(row, principal, matrix)),
    documentsToIssue: signed.filter((row) => !issued.has(row.id)).map((row) => summary(row, principal, matrix)),
  };
}

function isCurrentMatrix(matrix: AdoptedMatrix | null, ref: MatrixVersionRef | null): boolean {
  return Boolean(
    matrix && ref && matrix.version.record_id === ref.recordId && matrix.version.version_number === ref.versionNumber,
  );
}

function summary(row: SummaryRow, principal: AuthContext, matrix: AdoptedMatrix | null): SmsRecordSummary {
  const closed = ['accepted', 'adopted', 'signed', 'closed'].includes(row.status);
  const awaiting = row.kind === 'hazard' && row.status === 'awaiting_acceptance';
  const stale = awaiting && !isCurrentMatrix(matrix, row.assessed_matrix);
  const adoptable = readyToAdopt(row, row.version_schema);
  const canDecide = principal.capabilities.includes('decision:write');
  return {
    id: row.id,
    kind: row.kind,
    reference: row.reference ?? null,
    title: row.title,
    status: stale ? 'needs_reassessment' : row.status,
    recordClass: row.record_class,
    confidentiality: row.confidentiality,
    owner: { id: row.owner_id, name: row.owner_name },
    dueAt: row.due_at?.toISOString() ?? null,
    overdue: Boolean(row.due_at && !closed && row.due_at.getTime() < row.now.getTime()),
    revision: Number(row.revision),
    projectedRevision: Number(row.projected_revision),
    versionNumber: row.version_number,
    openedAt: row.opened_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.residual ? { residual: row.residual } : {}),
    ...(row.kind === 'hazard' ? { origin: summaryOrigin(row) } : {}),
    waitingOnMe: Boolean(
      canDecide &&
      ((awaiting &&
        !stale &&
        row.residual &&
        coveringRiskCapability(row.residual.acceptance, principal.capabilities)) ||
        (adoptable && principal.capabilities.includes('sms:adopt'))),
    ),
  };
}

/** Hazards recorded before origins existed are manual. */
function summaryOrigin(row: SummaryRow): NonNullable<SmsRecordSummary['origin']> {
  return {
    kind: row.origin_kind ?? 'manual',
    ...(row.origin_finding_id ? { findingId: row.origin_finding_id } : {}),
    ...(row.origin_subject ? { subject: row.origin_subject } : {}),
  };
}

interface LinkedRecordRow {
  id: string;
  kind: SmsRecordKind;
  title: string;
  status: string;
  confidentiality: SmsConfidentiality;
}
interface LinkChangeRow {
  id: string;
  revision: string;
  added: SmsLink[];
  removed: SmsLink[];
  actor_id: string;
  actor_name: string;
  recorded_at: Date;
}

function linkedRecord(row: LinkedRecordRow): SmsLinkedRecord {
  return { id: row.id, kind: row.kind, title: row.title, status: row.status, confidentiality: row.confidentiality };
}

async function linkTargets(
  client: PoolClient,
  tenantId: string,
  links: SmsLink[],
): Promise<Map<string, SmsLinkedRecord>> {
  const ids = links.flatMap((link) => (link.target.kind === 'sms_record' ? [link.target.id] : []));
  if (!ids.length) return new Map();
  const rows = await client.query<LinkedRecordRow>(
    'SELECT id,kind,title,status,confidentiality FROM sms_records WHERE tenant_id=$1 AND id=ANY($2)',
    [tenantId, [...new Set(ids)]],
  );
  return new Map(rows.rows.map((row) => [row.id, linkedRecord(row)]));
}

function withRecords(links: SmsLink[], targets: Map<string, SmsLinkedRecord>): SmsCurrentLink[] {
  return links.map((link) => {
    const record = link.target.kind === 'sms_record' ? targets.get(link.target.id) : undefined;
    return record ? { ...link, record } : link;
  });
}

async function linkedFrom(client: PoolClient, tenantId: string, id: string): Promise<SmsLinkedFrom[]> {
  const rows = await client.query<LinkedRecordRow & { relation: SmsLink['relation'] }>(
    `SELECT r.id,r.kind,r.title,r.status,r.confidentiality,l.link->>'relation' AS relation
     FROM sms_records r CROSS JOIN LATERAL jsonb_array_elements(r.links) l(link)
     WHERE r.tenant_id=$1 AND r.links @> $2::jsonb
       AND l.link->'target'->>'kind'='sms_record' AND l.link->'target'->>'id'=$3
     ORDER BY r.updated_at DESC,r.id`,
    [tenantId, JSON.stringify([{ target: { kind: 'sms_record', id } }]), id],
  );
  return rows.rows.map((row) => ({ relation: row.relation, record: linkedRecord(row) }));
}

async function linkChanges(
  client: PoolClient,
  tenantId: string,
  id: string,
  targets: Map<string, SmsLinkedRecord>,
): Promise<SmsLinkChange[]> {
  const rows = await client.query<LinkChangeRow>(
    `SELECT c.*,p.name AS actor_name FROM sms_link_changes c JOIN principals p ON p.tenant_id=c.tenant_id AND p.id=c.actor_id
     WHERE c.tenant_id=$1 AND c.record_id=$2 ORDER BY c.revision DESC`,
    [tenantId, id],
  );
  const missing = rows.rows.flatMap((row) => [...row.added, ...row.removed]);
  for (const [key, record] of await linkTargets(client, tenantId, missing)) targets.set(key, record);
  return rows.rows.map((row) => ({
    id: row.id,
    revision: Number(row.revision),
    added: withRecords(row.added, targets),
    removed: withRecords(row.removed, targets),
    recordedBy: { id: row.actor_id, name: row.actor_name },
    recordedAt: row.recorded_at.toISOString(),
  }));
}

function version(row: SmsVersionRow & { owner_name: string; actor_name: string }): SmsRecordVersion {
  return {
    id: row.id,
    versionNumber: row.version_number,
    revision: Number(row.revision),
    schema: row.schema,
    title: row.title,
    body: row.body,
    bodyDigest: row.body_digest,
    owner: { id: row.owner_id, name: row.owner_name },
    dueAt: row.due_at?.toISOString() ?? null,
    links: row.links,
    recordedBy: { id: row.actor_id, name: row.actor_name },
    recordedAt: row.recorded_at.toISOString(),
  };
}

async function versions(client: PoolClient, tenantId: string, recordId: string): Promise<SmsRecordVersion[]> {
  const rows = await client.query<SmsVersionRow & { owner_name: string; actor_name: string }>(
    `SELECT v.*,o.name AS owner_name,a.name AS actor_name FROM sms_record_versions v
     JOIN principals o ON o.tenant_id=v.tenant_id AND o.id=v.owner_id
     JOIN principals a ON a.tenant_id=v.tenant_id AND a.id=v.actor_id
     WHERE v.tenant_id=$1 AND v.record_id=$2 ORDER BY v.version_number DESC`,
    [tenantId, recordId],
  );
  return rows.rows.map(version);
}

async function restrictedVersions(client: PoolClient, record: SmsRecordRow): Promise<SmsRecordVersion[]> {
  const rows = await client.query<SmsRestrictedVersionRow & { owner_name: string; actor_name: string }>(
    `SELECT ${RESTRICTED_VERSION_COLUMNS},o.name AS owner_name,a.name AS actor_name FROM sms_restricted_record_versions v
     JOIN principals o ON o.tenant_id=v.tenant_id AND o.id=v.owner_id
     JOIN principals a ON a.tenant_id=v.tenant_id AND a.id=v.actor_id
     WHERE v.tenant_id=$1 AND v.record_id=$2 ORDER BY v.version_number DESC`,
    [record.tenant_id, record.id],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    revision: Number(row.revision),
    schema: row.schema,
    title: record.title,
    body: null,
    bodyDigest: row.content_digest,
    owner: { id: row.owner_id, name: row.owner_name },
    dueAt: row.due_at?.toISOString() ?? null,
    links: [],
    recordedBy: { id: row.actor_id, name: row.actor_name },
    recordedAt: row.recorded_at.toISOString(),
  }));
}

function adoptedView(matrix: AdoptedMatrix, principal: AuthContext, signature: SmsSignatureRecord | null) {
  return async (client: PoolClient): Promise<SmsAdoptedMatrix> => {
    const rows = await client.query<SummaryRow>(`${summarySql} WHERE r.tenant_id=$1 AND r.id=$2`, [
      principal.tenantId,
      matrix.record.id,
    ]);
    const all = await versions(client, principal.tenantId, matrix.record.id);
    const shown = all.find((entry) => entry.versionNumber === matrix.version.version_number)!;
    return {
      record: summary(rows.rows[0], principal, matrix),
      version: { ...shown, body: matrix.version.body },
      adoption: matrix.adoption,
      signature,
    };
  };
}

async function signatures(client: PoolClient, tenantId: string, subjectId: string): Promise<SmsSignatureRecord[]> {
  const rows = await client.query<SignatureRow>(
    `SELECT s.*,p.name AS signer_name FROM sms_signatures s JOIN principals p ON p.tenant_id=s.tenant_id AND p.id=s.signer_id
     WHERE s.tenant_id=$1 AND s.subject_id=$2 ORDER BY s.signed_at,s.id`,
    [tenantId, subjectId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    decisionId: row.decision_id,
    subjectId: row.subject_id,
    subjectRevision: Number(row.subject_revision),
    signer: { id: row.signer_id, name: row.signer_name },
    meaning: row.meaning,
    intent: row.intent,
    content: row.content,
    contentDigest: row.content_digest,
    authority: row.authority,
    reauthentication: row.reauthentication,
    signedAt: row.signed_at.toISOString(),
  }));
}

async function people(client: PoolClient, tenantId: string): Promise<PersonRow[]> {
  return (
    await client.query<PersonRow>(
      "SELECT id,name,capabilities FROM principals WHERE tenant_id=$1 AND active AND kind='human' AND 'sms:read'=ANY(capabilities) ORDER BY name,id",
      [tenantId],
    )
  ).rows;
}

async function matrixView(
  client: PoolClient,
  principal: AuthContext,
  matrix: AdoptedMatrix | null,
): Promise<SmsAdoptedMatrix | null> {
  if (!matrix) return null;
  const signed = (await signatures(client, principal.tenantId, matrix.record.id)).find(
    (entry) => entry.decisionId === matrix.adoption.id,
  );
  return adoptedView(matrix, principal, signed ?? null)(client);
}

/** Every seeded organization adopts a risk matrix, so a matrix alone does not move it to the safety application. */
/**
 * Which application a person opens on. A person who reads flights always opens on flights, reaching the safety
 * application from there when the organization keeps safety records they may read; anyone else opens on the safety
 * application once the organization keeps safety records. A risk matrix alone is not yet a safety program.
 */
export async function getSmsProgram(
  client: PoolClient,
  principal: AuthContext,
): Promise<{ active: boolean; flights: boolean; safetyRecords: boolean }> {
  const records = await client.query("SELECT 1 FROM sms_records WHERE tenant_id=$1 AND kind<>'risk_matrix' LIMIT 1", [
    principal.tenantId,
  ]);
  const active = records.rowCount !== 0;
  return {
    active,
    flights: principal.capabilities.includes('flight:read'),
    safetyRecords: active && principal.capabilities.includes('sms:read'),
  };
}

export async function getSmsHome(client: PoolClient, principal: AuthContext): Promise<SmsHomeResponse> {
  const matrix = await adoptedMatrix(client, principal.tenantId);
  const rows = await client.query<SummaryRow>(
    `${summarySql} WHERE r.tenant_id=$1 AND r.status<>'closed'
     ORDER BY r.due_at NULLS LAST,r.updated_at DESC,r.id LIMIT $2`,
    [principal.tenantId, REGISTER_LIMIT],
  );
  const records = rows.rows.map((row) => summary(row, principal, matrix));
  const hazards = records.filter((record) => record.kind === 'hazard');
  const directory = await people(client, principal.tenantId);
  return {
    ...(await documentReading(client, principal)),
    program: { active: Boolean(matrix), matrix: await matrixView(client, principal, matrix) },
    people: directory.map((person) => ({
      id: person.id,
      name: person.name,
      authority: highestRiskAuthority(person.capabilities),
      adopts: person.capabilities.includes('sms:adopt'),
      configures: person.capabilities.includes('sms:configure'),
      writes: person.capabilities.includes('sms:write'),
      readsReports: person.capabilities.includes('sms:report:read'),
    })),
    attention: {
      waitingOnMe: records.filter((record) => record.waitingOnMe),
      awaitingAcceptance: hazards.filter((hazard) => hazard.status === 'awaiting_acceptance'),
      needsAssessment: hazards.filter((hazard) => ['identified', 'needs_reassessment'].includes(hazard.status)),
      documentsAwaitingAdoption: records.filter((record, index) =>
        readyToAdopt(record, rows.rows[index]!.version_schema),
      ),
      ...(await documentWork(client, principal, rows.rows, matrix)),
      overdue: records.filter((record) => record.overdue),
      ...(principal.capabilities.includes('evidence:read')
        ? {
            findingsWithoutOwner: findingAttention((await readOpenFindingEntries(client, principal.tenantId)).entries)
              .unowned,
          }
        : {}),
    },
    assuranceActions: await assuranceActionsDue(client, principal.tenantId),
    reportLinks: await reportLinksInForce(client, principal.tenantId),
    capabilities: principal.capabilities,
    computedAt: rows.rows[0]?.now.toISOString() ?? new Date().toISOString(),
  };
}

/**
 * One page of a register, newest first by when each record was opened. `cursor` is the last record of the previous
 * page; `findingId` keeps the hazards promoted from that finding, from any of its evaluations.
 */
export async function getSmsRegister(
  client: PoolClient,
  principal: AuthContext,
  kind: SmsRecordKind = 'hazard',
  page: { cursor?: string; findingId?: string; reference?: string; limit?: number } = {},
): Promise<SmsRegisterResponse> {
  const matrix = await adoptedMatrix(client, principal.tenantId);
  const limit = page.limit ?? REGISTER_LIMIT;
  if (page.cursor) {
    const anchor = await client.query('SELECT 1 FROM sms_records WHERE tenant_id=$1 AND id=$2 AND kind=$3', [
      principal.tenantId,
      page.cursor,
      kind,
    ]);
    if (!anchor.rowCount) throw new DomainError(400, 'invalid_cursor', 'The register cursor is not a record here');
  }
  const rows = await client.query<SummaryRow>(
    `${summarySql} WHERE r.tenant_id=$1 AND r.kind=$2
     AND ($4::text IS NULL OR (r.opened_at,r.id)<(SELECT c.opened_at,c.id FROM sms_records c WHERE c.tenant_id=$1 AND c.id=$4))
     AND ($5::text IS NULL OR h.finding_id=$5)
     AND ($6::text IS NULL OR r.reference=$6)
     ORDER BY r.opened_at DESC,r.id DESC LIMIT $3`,
    [principal.tenantId, kind, limit + 1, page.cursor ?? null, page.findingId ?? null, page.reference ?? null],
  );
  const shown = rows.rows.slice(0, limit);
  const documents = kind === 'document' ? await documentSummaries(client, principal, shown) : new Map();
  const assurance =
    kind === 'assurance'
      ? await assuranceSummaries(
          client,
          principal.tenantId,
          shown.map((row) => row.id),
        )
      : new Map();
  const hasMore = rows.rows.length > limit;
  return {
    records: shown.map((row) => {
      const document = documents.get(row.id);
      const assured = assurance.get(row.id);
      return {
        ...summary(row, principal, matrix),
        ...(document ? { document } : {}),
        ...(assured ? { assurance: assured } : {}),
      };
    }),
    limit,
    hasMore,
    nextCursor: hasMore ? shown[shown.length - 1]!.id : null,
    computedAt: rows.rows[0]?.now.toISOString() ?? new Date().toISOString(),
  };
}

/** Recorded reviews of indicator results for the controls the hazard's latest risk acceptance binds, newest first. */
async function closingReviews(client: PoolClient, tenantId: string, hazard: SmsRecordRow): Promise<SmsClosingReview[]> {
  if (!hazard.latest_acceptance_id) return [];
  const rows = await client.query<{
    id: string;
    record_digest: string;
    conclusion: SmsClosingReview['conclusion'];
    recorded_at: Date;
    reviewer: string;
    control_id: string;
    control_version: number;
    title: string;
    result_status: string;
  }>(
    `SELECT r.id,r.record_digest,r.conclusion,r.recorded_at,r.record#>>'{actor,name}' AS reviewer,r.control_id,
      r.control_version,v.title,r.record->>'resultStatus' AS result_status
     FROM control_indicator_reviews r
     JOIN accepted_hazard_controls a ON a.tenant_id=r.tenant_id AND a.hazard_id=r.hazard_id
      AND a.acceptance_id=$3 AND a.control_id=r.control_id AND a.control_version_number=r.control_version
     JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
      AND v.version_number=a.control_version_number
     WHERE r.tenant_id=$1 AND r.hazard_id=$2 AND r.control_kind='control_record'
     ORDER BY r.recorded_at DESC,r.id COLLATE "C" DESC LIMIT 50`,
    [tenantId, hazard.id, hazard.latest_acceptance_id],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    digest: row.record_digest,
    conclusion: row.conclusion,
    recordedAt: row.recorded_at.toISOString(),
    reviewer: row.reviewer,
    control: { id: row.control_id, title: row.title, versionNumber: Number(row.control_version) },
    resultStatus: row.result_status,
  }));
}

/**
 * How other records cite a decision: by id, the revision it recorded and the digest it already carries. A signed
 * decision is cited by the digest of the content its signer signed; an assessment by the digest of its outcome, which
 * is what a risk acceptance records of it. Readers receive both from the record read.
 */
export function decisionReference(record: SmsDecisionRecord): { id: string; acceptedRevision: number; digest: string } {
  return {
    id: record.id,
    acceptedRevision: record.acceptedRevision,
    digest: record.signature?.contentDigest ?? canonicalDigest(record.outcome),
  };
}

function publicDecision(record: SmsDecisionRecord & { basisManifest?: unknown }): SmsDecisionRecord {
  const { basisManifest, ...decision } = record;
  void basisManifest;
  return decision;
}

const allowed: SmsAction = { available: true };
const unavailable = (reason: string): SmsAction => ({ available: false, reason });

function whoCan(directory: PersonRow[], acceptance: RiskAcceptance): string {
  const names = directory
    .filter(
      (person) =>
        coveringRiskCapability(acceptance, person.capabilities) && person.capabilities.includes('decision:write'),
    )
    .map((person) => person.name);
  return names.length
    ? ` ${names.join(', ')} can accept it.`
    : ' Nobody in your organization holds that authority yet.';
}

async function adoptAction(client: PoolClient, principal: AuthContext, record: SmsRecordRow): Promise<SmsAction> {
  if (!SMS_KINDS[record.kind].adoption) return unavailable('This record is not adopted with a signature.');
  try {
    if (!principal.capabilities.includes('decision:write'))
      throw new DomainError(403, 'capability_required', 'Recording a decision needs decision permission.');
    await adoptionContext(client, principal, record);
    return allowed;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return unavailable(`${error.message}.`);
  }
}

async function acceptAction(
  client: PoolClient,
  principal: AuthContext,
  record: SmsRecordRow,
  directory: PersonRow[],
): Promise<SmsAction> {
  if (record.kind !== 'hazard') return unavailable('Only a hazard has a risk acceptance.');
  try {
    if (!principal.capabilities.includes('decision:write'))
      throw new DomainError(403, 'capability_required', 'Recording a decision needs decision permission.');
    await riskAcceptanceContext(client, principal, record);
    return allowed;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const acceptance = error.details?.acceptance as RiskAcceptance | undefined;
    const who = acceptance && acceptance !== 'not_acceptable' ? whoCan(directory, acceptance) : '';
    return unavailable(`${error.message}.${who}`.replace('..', '.'));
  }
}

export async function getSmsRecord(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<SmsRecordDetailResponse> {
  const matrix = await adoptedMatrix(client, principal.tenantId);
  const row = (
    await client.query<SummaryRow>(`${summarySql} WHERE r.tenant_id=$1 AND r.id=$2`, [principal.tenantId, id])
  ).rows[0];
  if (!row) throw new DomainError(404, 'sms_record_not_found', 'The record was not found in your organization');
  const all =
    row.confidentiality === 'ordinary'
      ? await versions(client, principal.tenantId, id)
      : await restrictedVersions(client, row);
  const decisions = (
    await client.query<{ record: SmsDecisionRecord }>(
      `SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND record->>'version'='sms.decision.1'
       ORDER BY accepted_revision DESC`,
      [principal.tenantId, id],
    )
  ).rows.map((decision) => publicDecision(decision.record));
  const attachments = await client.query<AttachmentRow>(
    `SELECT a.*,p.name AS actor_name,j.payload->'documentVersion' AS document_version FROM sms_attachments a
     JOIN principals p ON p.tenant_id=a.tenant_id AND p.id=a.actor_id
     JOIN journal_events j ON j.tenant_id=a.tenant_id AND j.id=a.id
     WHERE a.tenant_id=$1 AND a.record_id=$2 ORDER BY a.revision DESC`,
    [principal.tenantId, id],
  );
  const directory = await people(client, principal.tenantId);
  const basis = await readSmsBasis(client, row, principal);
  const writeCapability = SMS_KINDS[row.kind].writeCapability;
  const canWrite = principal.capabilities.includes(writeCapability);
  const canReadContent = principal.capabilities.includes(confidentialityCapability[row.confidentiality]);
  const canEditContent = canWrite && canReadContent;
  const assessedMatrix =
    row.assessed_matrix &&
    (
      await client.query<SmsVersionRow & { owner_name: string; actor_name: string }>(
        `SELECT v.*,o.name AS owner_name,a.name AS actor_name FROM sms_record_versions v
         JOIN principals o ON o.tenant_id=v.tenant_id AND o.id=v.owner_id
         JOIN principals a ON a.tenant_id=v.tenant_id AND a.id=v.actor_id
         WHERE v.tenant_id=$1 AND v.record_id=$2 AND v.version_number=$3`,
        [principal.tenantId, row.assessed_matrix.recordId, row.assessed_matrix.versionNumber],
      )
    ).rows[0];
  const assess =
    row.kind !== 'hazard'
      ? unavailable('Only a hazard is assessed on the risk matrix.')
      : !matrix
        ? unavailable('Your organization has not adopted a risk matrix yet.')
        : !principal.capabilities.includes('sms:write') || !principal.capabilities.includes('decision:write')
          ? unavailable('Assessing risk needs permission to edit SMS records and record decisions.')
          : allowed;
  const targets = await linkTargets(client, principal.tenantId, row.links);
  const origin = row.kind === 'hazard' ? await hazardOrigin(client, principal.tenantId, id) : undefined;
  const latestAssessment = decisions.find((decision) => decision.id === row.latest_assessment_id);
  const evidence = origin
    ? await hazardEvidence(
        client,
        principal.tenantId,
        id,
        origin,
        latestAssessment?.outcome as SmsAssessmentOutcome | undefined,
      )
    : undefined;
  const ownerOnly = row.kind === 'hazard' && row.owner_id !== principal.id;
  const proposeControl =
    row.kind !== 'hazard'
      ? unavailable('Only a hazard has controls.')
      : row.status === 'closed'
        ? unavailable('This hazard is closed; reopen it to propose a control.')
        : principal.capabilities.includes('sms:write')
          ? allowed
          : unavailable('Proposing a control needs permission to edit SMS records.');
  return {
    record: summary(row, principal, matrix),
    ...(origin ? { origin } : {}),
    ...(evidence ? { evidence } : {}),
    current: all[0],
    versions: all,
    links: withRecords(row.links, targets),
    linkedFrom: await linkedFrom(client, principal.tenantId, id),
    linkChanges: await linkChanges(client, principal.tenantId, id, targets),
    attachments: attachments.rows.map((attachment): SmsAttachment => ({
      id: attachment.id,
      ...(attachment.document_version ? { documentVersion: attachment.document_version } : {}),
      label: attachment.label,
      confidentiality: attachment.confidentiality,
      sha256: attachment.sha256,
      byteLength: attachment.byte_length,
      contentType: attachment.content_type,
      revision: Number(attachment.revision),
      recordedBy: { id: attachment.actor_id, name: attachment.actor_name },
      recordedAt: attachment.recorded_at.toISOString(),
      readable: principal.capabilities.includes(confidentialityCapability[attachment.confidentiality]),
    })),
    decisions,
    ...(row.kind === 'document'
      ? {
          documentControl: projectDocumentControl(
            row,
            all,
            decisions,
            await documentAcknowledgements(client, principal.tenantId, [id]),
            row.now.toISOString(),
          ),
        }
      : {}),
    ...(row.kind === 'hazard'
      ? {
          controls: await hazardControls(client, principal.tenantId, row),
          closingReviews: await closingReviews(client, principal.tenantId, row),
        }
      : {}),
    ...(row.kind === 'hazard' || row.kind === 'control'
      ? { controlTypes: listControlTypes(), observationTypes: observationTypeChoices() }
      : {}),
    ...(row.kind === 'assurance'
      ? { assurance: await assuranceView(client, principal, row, all[0]!.body as unknown as AssuranceBody) }
      : {}),
    signatures: await signatures(client, principal.tenantId, id),
    matrix: await matrixView(client, principal, matrix),
    assessedMatrix: assessedMatrix
      ? { ...version(assessedMatrix), body: assessedMatrix.body as unknown as RiskMatrixBody }
      : null,
    actions: {
      revise:
        row.status === 'closed'
          ? unavailable('This record is closed; reopen it to record a new version.')
          : canEditContent
            ? allowed
            : unavailable(
                canWrite
                  ? restrictedContentReason[row.confidentiality]
                  : 'Editing this record needs permission to edit SMS records.',
              ),
      proposeControl,
      link:
        row.confidentiality !== 'ordinary'
          ? unavailable('Links on a restricted record are part of its restricted content.')
          : row.status === 'closed'
            ? unavailable('This record is closed; reopen it to change its links.')
            : canWrite && principal.capabilities.includes('sms:write')
              ? allowed
              : unavailable('Changing links needs permission to edit SMS records.'),
      attach: !principal.capabilities.includes('sms:write')
        ? unavailable('Adding files needs permission to edit SMS records.')
        : canReadContent
          ? allowed
          : unavailable(restrictedContentReason[row.confidentiality]),
      assess,
      accept: await acceptAction(client, principal, row, directory),
      adopt: await adoptAction(client, principal, row),
      close: !SMS_KINDS[row.kind].closable
        ? unavailable('This kind of record is not closed.')
        : row.status === 'closed'
          ? unavailable('This record is already closed.')
          : ownerOnly
            ? unavailable(`Only the hazard’s owner, ${row.owner_name}, closes it.`)
            : canWrite && principal.capabilities.includes('decision:write')
              ? allowed
              : unavailable('Closing needs permission to edit this record and record decisions.'),
      reopen:
        row.status !== 'closed'
          ? unavailable('This record is open.')
          : canWrite && principal.capabilities.includes('decision:write')
            ? allowed
            : unavailable('Reopening needs permission to edit this record and record decisions.'),
      export: principal.capabilities.includes('evidence:read')
        ? allowed
        : unavailable('Exporting needs permission to read evidence.'),
      readContent:
        row.confidentiality !== 'ordinary' && canReadContent
          ? allowed
          : unavailable(restrictedContentReason[row.confidentiality]),
    },
    basis: { revision: Number(row.revision), dependencyBasis: basis.smsBasis },
    computedAt: row.now.toISOString(),
  };
}

export async function getSmsSigningPreview(
  client: PoolClient,
  principal: AuthContext,
  id: string,
  meaning: SignedContent['meaning'],
  reauthentication: SmsSigningPreviewResponse['reauthentication'],
): Promise<SmsSigningPreviewResponse> {
  const record = await readSmsRecord(client, principal.tenantId, id);
  const basis = {
    revision: Number(record.revision),
    dependencyBasis: (await readSmsBasis(client, record, principal)).smsBasis,
  };
  let signing: SigningContext;
  try {
    if (!principal.capabilities.includes('decision:write'))
      throw new DomainError(403, 'capability_required', 'Signing needs permission to record decisions');
    signing =
      meaning === 'risk.accept'
        ? await riskAcceptanceContext(client, principal, record)
        : await adoptionContext(client, principal, record);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const acceptance = error.details?.acceptance as RiskAcceptance | undefined;
    const who =
      acceptance && acceptance !== 'not_acceptable' ? whoCan(await people(client, principal.tenantId), acceptance) : '';
    return {
      meaning,
      available: false,
      reason: who ? `${error.message}.${who}` : error.message,
      content: null,
      contentDigest: null,
      intent: null,
      reauthentication,
      basis,
    };
  }
  return {
    meaning,
    available: true,
    content: signing.content,
    contentDigest: canonicalDigest(signing.content),
    intent: signing.content.intent,
    reauthentication,
    basis,
  };
}

export interface AttachmentObject {
  objectKey: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  confidentiality: SmsConfidentiality;
}

/** Restricted bytes are disclosed only to the capability that covers their class, and each disclosure is retained. */
export async function readSmsAttachmentObject(
  client: PoolClient,
  principal: AuthContext,
  attachmentId: string,
): Promise<AttachmentObject> {
  const row = (
    await client.query<AttachmentObject & { object_key: string; content_type: string; byte_length: number }>(
      `SELECT a.confidentiality,a.sha256,a.byte_length,a.content_type,COALESCE(o.object_key,r.object_key) AS object_key
       FROM sms_attachments a
       LEFT JOIN artifacts o ON o.tenant_id=a.tenant_id AND o.id=a.artifact_id
       LEFT JOIN restricted_artifacts r ON r.tenant_id=a.tenant_id AND r.id=a.restricted_artifact_id
       WHERE a.tenant_id=$1 AND a.id=$2`,
      [principal.tenantId, attachmentId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'attachment_not_found', 'The attachment was not found in your organization');
  const capability = confidentialityCapability[row.confidentiality];
  if (!principal.capabilities.includes(capability))
    throw new DomainError(403, 'capability_required', 'This attachment is restricted to people cleared to read it', {
      capability,
    });
  if (row.confidentiality !== 'ordinary')
    await client.query(
      'INSERT INTO sms_restricted_disclosures(id,tenant_id,principal_id,attachment_id,capability) VALUES(gen_random_uuid()::text,$1,$2,$3,$4)',
      [principal.tenantId, principal.id, attachmentId, capability],
    );
  return {
    objectKey: row.object_key,
    sha256: row.sha256,
    byteLength: row.byte_length,
    contentType: row.content_type,
    confidentiality: row.confidentiality,
  };
}

/** Restricted titles, bodies and links leave the database only through the disclosing function, one row per version. */
export async function getSmsRecordContent(
  client: PoolClient,
  principal: AuthContext,
  id: string,
): Promise<SmsRecordContentResponse> {
  const record = await readSmsRecord(client, principal.tenantId, id);
  if (record.confidentiality === 'ordinary')
    throw new DomainError(400, 'record_not_restricted', restrictedContentReason.ordinary);
  requireCapability(
    principal,
    confidentialityCapability[record.confidentiality],
    restrictedContentReason[record.confidentiality],
  );
  if (principal.kind !== 'human')
    throw new DomainError(403, 'person_required', 'Only a person can read restricted record content');
  const digests = await client.query<{ id: string; content_digest: string }>(
    'SELECT id,content_digest FROM sms_restricted_record_versions WHERE tenant_id=$1 AND record_id=$2',
    [principal.tenantId, id],
  );
  const digestOf = new Map(digests.rows.map((row) => [row.id, row.content_digest]));
  const disclosed = await client.query<{
    version_id: string;
    version_number: number;
    title: string;
    body: Record<string, unknown>;
    links: SmsLink[];
  }>('SELECT * FROM ledger_disclose_sms_record_content($1)', [id]);
  const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return {
    recordId: id,
    confidentiality: record.confidentiality,
    versions: disclosed.rows.map((row) => ({
      id: row.version_id,
      versionNumber: row.version_number,
      title: row.title,
      body: row.body,
      links: row.links,
      contentDigest: digestOf.get(row.version_id)!,
    })),
    disclosedAt: clock.rows[0].now.toISOString(),
  };
}

export async function projectSmsEvent(client: PoolClient, event: JournalEvent): Promise<void> {
  if (event.event_type === 'sms.document.acknowledge') {
    const receipt = await client.query('SELECT 1 FROM sms_document_acknowledgements WHERE tenant_id=$1 AND id=$2', [
      event.tenant_id,
      event.id,
    ]);
    if (!receipt.rowCount)
      throw new DomainError(409, 'sms_commitment_missing', 'The document acknowledgement is unavailable');
    return;
  }
  const located =
    event.event_type === 'sms.attachment.add'
      ? await client.query<{ record_id: string; revision: string }>(
          'SELECT record_id,revision FROM sms_attachments WHERE tenant_id=$1 AND id=$2',
          [event.tenant_id, event.id],
        )
      : event.event_type === 'decision.record'
        ? await client.query<{ record_id: string; revision: string }>(
            'SELECT subject_id AS record_id,accepted_revision AS revision FROM decisions WHERE tenant_id=$1 AND id=$2',
            [event.tenant_id, event.id],
          )
        : event.event_type === 'sms.record.links'
          ? await client.query<{ record_id: string; revision: string }>(
              'SELECT record_id,revision FROM sms_link_changes WHERE tenant_id=$1 AND id=$2',
              [event.tenant_id, event.id],
            )
          : await client.query<{ record_id: string; revision: string }>(
              `SELECT record_id,revision FROM sms_record_versions WHERE tenant_id=$1 AND id=$2
             UNION ALL SELECT record_id,revision FROM sms_restricted_record_versions WHERE tenant_id=$1 AND id=$2`,
              [event.tenant_id, event.id],
            );
  const row = located.rows[0];
  if (!row) throw new DomainError(409, 'sms_commitment_missing', 'The SMS record change is unavailable');
  // A command on the record locks its subject, then the record; take them in the same order, or a person's command
  // and the projection of the record's previous change deadlock. In a projection this is its one subject lock.
  await lockSubjects(client, event.tenant_id, [row.record_id], 'UPDATE');
  await client.query(
    'UPDATE sms_records SET projected_revision=GREATEST(projected_revision,$1) WHERE tenant_id=$2 AND id=$3',
    [row.revision, event.tenant_id, row.record_id],
  );
}

export function isSmsEvent(event: JournalEvent): boolean {
  return (
    [
      'sms.record.open',
      'sms.record.revise',
      'sms.attachment.add',
      'sms.record.links',
      'sms.document.acknowledge',
    ].includes(event.event_type) ||
    (event.event_type === 'decision.record' && event.payload.subject?.kind === 'sms')
  );
}

export type { SmsPersonRef };
