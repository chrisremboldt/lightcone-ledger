import { randomUUID } from 'node:crypto';
import {
  assuranceTypes,
  type AssuranceBody,
  type CommandRecord,
  type Command,
  type DocumentBody,
  type HazardBody,
  type ReauthenticationEvidence,
  type RiskAuthority,
  type RiskMatrixBody,
  type SignedContent,
  type SmsAcceptanceOutcome,
  type SmsAssessmentOutcome,
  type SmsAuthoritySnapshot,
  type SmsDecisionCommand,
  type SmsDecisionRecord,
  type SmsMatrixAdoptionOutcome,
  type SmsDocumentReviewOutcome,
  type SmsStatusOutcome,
  revisionWords,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type ObjectStore, type PoolClient } from '@ledger/persistence';
import { linkSubjectDependency, lockSubjectAndClosure, retainSubjectEvidence } from './cuts.js';
import {
  currentVersion,
  lockSmsRecord,
  readSmsBasis,
  readSmsRecord,
  recordCommand,
  requireCapability,
  requireRevision,
  SMS_KINDS,
  smsStream,
  type SmsRecordRow,
  type SmsVersionRow,
} from './sms-envelope.js';
import { documentFiles, prepareDocumentDecision, reviewedDocument } from './sms-documents.js';
import { coveringRiskCapability, evaluateRiskMatrix, matrixLabels } from './sms-matrix.js';
import { assessmentEvidence } from './sms-origins.js';
import { assessedControls, recordAcceptedControls, requireAssessedControlsCurrent } from './sms-controls.js';
import { refreshAcceptedControlRules } from './accepted-control-rules.js';
import { organization } from './adoptions.js';
import { lockRecordsOnFile, recordsOnFileScope, refreshRecordsOnFile } from './records-on-file.js';
import { prepareActionClose } from './sms-assurance.js';

export type Reauthenticate = () => Promise<ReauthenticationEvidence>;

export function isSmsDecisionCommand(command: Command): command is SmsDecisionCommand {
  return command.kind === 'decision.record' && 'subject' in command && command.subject.kind === 'sms';
}

interface ActorRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  capabilities: string[];
  revision: string;
}
interface DecisionRow {
  id: string;
  record: SmsDecisionRecord;
}
export interface AdoptedMatrix {
  adoption: SmsDecisionRecord;
  record: SmsRecordRow;
  version: SmsVersionRow & { body: RiskMatrixBody };
}

const AUTHORITY_POLICY = 'ledger.sms-decision-authority.1';

export async function currentActor(
  client: PoolClient,
  principal: AuthContext,
): Promise<AuthContext & { kind: string }> {
  const actor = (
    await client.query<ActorRow>(
      'SELECT id,tenant_id,name,kind,capabilities,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!actor) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  if (actor.kind !== 'human') throw new DomainError(403, 'person_required', 'Only a person can record SMS decisions');
  return {
    id: actor.id,
    tenantId: actor.tenant_id,
    name: actor.name,
    kind: actor.kind,
    capabilities: actor.capabilities,
    revision: Number(actor.revision),
  };
}

export function authoritySnapshot(
  actor: AuthContext & { kind: string },
  checked: string[],
  satisfying?: string,
): SmsAuthoritySnapshot {
  return {
    policyVersion: AUTHORITY_POLICY,
    principalId: actor.id,
    name: actor.name,
    kind: actor.kind,
    principalRevision: actor.revision,
    capabilities: [...actor.capabilities],
    checkedCapabilities: checked,
    ...(satisfying ? { satisfyingCapability: satisfying } : {}),
  };
}

export async function adoptedMatrix(client: PoolClient, tenantId: string): Promise<AdoptedMatrix | null> {
  const adoption = (
    await client.query<DecisionRow>(
      `SELECT id,record FROM decisions WHERE tenant_id=$1 AND kind='matrix.adopt' AND record->>'version'='sms.decision.1'
       ORDER BY recorded_at DESC,id DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  if (!adoption) return null;
  const outcome = adoption.record.outcome as SmsMatrixAdoptionOutcome;
  const record = (
    await client.query<SmsRecordRow>('SELECT * FROM sms_records WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      outcome.matrix.recordId,
    ])
  ).rows[0];
  const version = (
    await client.query<SmsVersionRow & { body: RiskMatrixBody }>(
      'SELECT * FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2 AND version_number=$3',
      [tenantId, outcome.matrix.recordId, outcome.matrix.versionNumber],
    )
  ).rows[0];
  if (!record || !version || version.body_digest !== outcome.matrix.bodyDigest)
    throw new DomainError(409, 'matrix_unavailable', 'The adopted risk matrix version is unavailable');
  return { adoption: adoption.record, record, version };
}

export async function readDecision(
  client: PoolClient,
  tenantId: string,
  subjectId: string,
  id: string,
): Promise<SmsDecisionRecord | undefined> {
  return (
    await client.query<DecisionRow>(
      `SELECT id,record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND id=$3
       AND record->>'version'='sms.decision.1'`,
      [tenantId, subjectId, id],
    )
  ).rows[0]?.record;
}

/** The refusal for a level nobody may accept, in the matrix's own words. */
export function notAcceptableWords(matrix: RiskMatrixBody, levelId: string): string {
  const level = matrixLevel(matrix, levelId);
  const meaning = level?.meaning.trim().replace(/[.\s]+$/, '');
  return `“${matrix.name}” says ${level?.label ?? levelId} risk may not be accepted${meaning ? `: ${meaning}` : ''}. Reassess it with further controls`;
}

function matrixLevel(matrix: RiskMatrixBody, level: string): RiskMatrixBody['levels'][number] | undefined {
  return matrix.levels.find((entry) => entry.id === level);
}

export interface SigningContext {
  content: SignedContent;
  satisfyingCapability: string;
  checkedCapabilities: string[];
}

/**
 * A review the owner cites when closing a hazard: the recorded review of an indicator result, exactly as recorded,
 * for a control version the hazard's latest risk acceptance binds.
 */
async function closingReview(
  client: PoolClient,
  record: SmsRecordRow,
  closing: boolean,
  cited: { id: string; digest: string },
): Promise<NonNullable<SmsStatusOutcome['review']>> {
  if (!closing || record.kind !== 'hazard')
    throw new DomainError(400, 'review_citation_unsupported', 'Only closing a hazard may cite a review');
  const review = (
    await client.query<{ record_digest: string; conclusion: string; control_id: string; bound: boolean }>(
      `SELECT r.record_digest,r.conclusion,r.control_id,EXISTS(SELECT 1 FROM accepted_hazard_controls a
        WHERE a.tenant_id=r.tenant_id AND a.hazard_id=$3 AND a.acceptance_id=$4 AND a.control_id=r.control_id
         AND a.control_version_number=r.control_version) AS bound
       FROM control_indicator_reviews r WHERE r.tenant_id=$1 AND r.id=$2 AND r.control_kind='control_record'`,
      [record.tenant_id, cited.id, record.id, record.latest_acceptance_id],
    )
  ).rows[0];
  if (!review || review.record_digest !== cited.digest)
    throw new DomainError(409, 'review_citation_mismatch', 'The cited review does not match what is recorded');
  if (!review.bound)
    throw new DomainError(
      409,
      'review_control_not_bound',
      'The cited review is of a control that this hazard’s latest risk acceptance does not bind',
    );
  return {
    id: cited.id,
    digest: cited.digest,
    conclusion: review.conclusion as NonNullable<SmsStatusOutcome['review']>['conclusion'],
    controlId: review.control_id,
  };
}

/** Content a person signs to accept a hazard's predicted residual risk; the same function previews and verifies it. */
export function riskAcceptanceContent(
  signer: AuthContext,
  hazard: SmsRecordRow,
  version: SmsVersionRow,
  assessment: SmsDecisionRecord,
  matrix: SmsVersionRow & { body: RiskMatrixBody },
): SigningContext {
  const outcome = assessment.outcome as SmsAssessmentOutcome;
  const { acceptance } = outcome.residual;
  const level = matrixLevel(matrix.body, outcome.residual.level);
  const label = level?.label ?? outcome.residual.level;
  if (acceptance === 'not_acceptable')
    throw new DomainError(409, 'risk_not_acceptable', notAcceptableWords(matrix.body, outcome.residual.level), {
      level: outcome.residual.level,
      acceptance,
    });
  const satisfying = coveringRiskCapability(acceptance, signer.capabilities);
  if (!satisfying)
    throw new DomainError(
      403,
      'risk_authority_insufficient',
      `Accepting ${label.toLowerCase()} risk needs authority to accept ${acceptance} risk`,
      { requiredCapability: `risk:accept:${acceptance}`, level: outcome.residual.level, acceptance },
    );
  const body = version.body as HazardBody;
  const controls = outcome.controls.length;
  const intent =
    `I, ${signer.name}, accept the predicted residual risk of ${label} for the hazard ` +
    `“${version.title}”, ${controls ? `with the ${controls === 1 ? 'control' : `${controls} controls`} listed` : 'with no additional controls'}, ` +
    `under my authority to accept ${satisfying.slice('risk:accept:'.length)} risk.`;
  return {
    satisfyingCapability: satisfying,
    checkedCapabilities: ['decision:write', satisfying],
    content: {
      version: 'sms.signed-content.1',
      meaning: 'risk.accept',
      intent,
      tenantId: signer.tenantId,
      subject: { id: hazard.id, kind: hazard.kind, revision: Number(hazard.revision), title: version.title },
      signer: { id: signer.id, name: signer.name },
      bindings: [
        {
          kind: 'record_version',
          recordId: hazard.id,
          versionNumber: version.version_number,
          bodyDigest: version.body_digest,
        },
        { kind: 'decision', decisionId: assessment.id, outcomeDigest: canonicalDigest(assessment.outcome) },
        {
          kind: 'record_version',
          recordId: matrix.record_id,
          versionNumber: matrix.version_number,
          bodyDigest: matrix.body_digest,
        },
        ...outcome.controls.map((control) => ({
          kind: 'record_version' as const,
          recordId: control.recordId,
          versionNumber: control.versionNumber,
          bodyDigest: control.bodyDigest,
        })),
      ],
      statement: {
        hazard: { title: version.title, description: body.description, consequence: body.consequence },
        matrix: { name: matrix.body.name, versionNumber: matrix.version_number },
        initialRisk: matrixLabels(matrix.body, outcome.initial),
        controls: outcome.controls,
        residualRisk: matrixLabels(matrix.body, outcome.residual),
        newHazardCheck: outcome.newHazardCheck,
        assessedBy: assessment.actor.name,
        assessedAt: assessment.recordedAt,
      },
    },
  };
}

const documentTypeLabels: Record<DocumentBody['documentType'], string> = {
  safety_policy: 'safety policy',
  accountable_executive_designation: 'accountable executive designation',
  roles_and_authority: 'roles and risk authority',
  emergency_response_plan: 'emergency response plan',
  sms_manual: 'SMS manual',
  procedure: 'procedure',
  safety_notice: 'safety notice',
  oem_manual: 'OEM manual',
  service_bulletin: 'service bulletin',
  specification: 'specification',
  certificate: 'certificate',
  recordkeeping_plan: 'recordkeeping plan',
  other: 'document',
};

interface AttachmentDigest {
  id: string;
  label: string;
  sha256: string;
  confidentiality: string;
}

async function attachmentDigests(client: PoolClient, record: SmsRecordRow): Promise<AttachmentDigest[]> {
  return (
    await client.query<AttachmentDigest>(
      'SELECT id,label,sha256,confidentiality FROM sms_attachments WHERE tenant_id=$1 AND record_id=$2 ORDER BY revision',
      [record.tenant_id, record.id],
    )
  ).rows;
}

/** Content a person signs to adopt SMS documentation: the exact version body and every attached file by digest. */
export function adoptionContent(
  signer: AuthContext,
  record: SmsRecordRow,
  version: SmsVersionRow,
  attachments: AttachmentDigest[],
  review?: SmsDecisionRecord,
): SigningContext {
  const meaning = SMS_KINDS[record.kind].adoption;
  if (!meaning) throw new DomainError(400, 'unsupported_decision', 'This record is not adopted with a signature');
  if (!signer.capabilities.includes('sms:adopt'))
    throw new DomainError(
      403,
      'adoption_authority_insufficient',
      record.kind === 'assurance'
        ? 'Signing a safety assurance record needs the authority to adopt safety documentation'
        : 'Adopting SMS documentation needs adoption authority',
      {
        requiredCapability: 'sms:adopt',
      },
    );
  if (record.kind === 'assurance') return assuranceSigningContent(signer, record, version, attachments);
  const matrix = record.kind === 'risk_matrix' ? (version.body as RiskMatrixBody) : undefined;
  const document = record.kind === 'document' ? (version.body as DocumentBody) : undefined;
  const revision = revisionWords(document?.revisionLabel, version.version_number);
  const intent = matrix
    ? `I, ${signer.name}, adopt version ${version.version_number} of “${matrix.name}” as this organization’s safety risk matrix.`
    : `I, ${signer.name}, adopt ${revision} of the ${documentTypeLabels[document!.documentType]} “${version.title}” for this organization’s safety management system.`;
  return {
    satisfyingCapability: 'sms:adopt',
    checkedCapabilities: ['decision:write', 'sms:adopt'],
    content: {
      version: 'sms.signed-content.1',
      meaning,
      intent,
      tenantId: signer.tenantId,
      subject: { id: record.id, kind: record.kind, revision: Number(record.revision), title: version.title },
      signer: { id: signer.id, name: signer.name },
      bindings: [
        {
          kind: 'record_version',
          recordId: record.id,
          versionNumber: version.version_number,
          bodyDigest: version.body_digest,
        },
        ...(review
          ? [{ kind: 'decision' as const, decisionId: review.id, outcomeDigest: canonicalDigest(review.outcome) }]
          : []),
        ...attachments.map((attachment) => ({
          kind: 'attachment' as const,
          attachmentId: attachment.id,
          sha256: attachment.sha256,
        })),
      ],
      statement: {
        title: version.title,
        versionNumber: version.version_number,
        ...(matrix
          ? {
              matrix: {
                name: matrix.name,
                severities: matrix.severities.map((entry) => entry.label),
                likelihoods: matrix.likelihoods.map((entry) => entry.label),
                levels: matrix.levels,
              },
            }
          : {
              document: {
                type: documentTypeLabels[document!.documentType],
                revision,
                summary: document!.summary,
                ...(document!.source ? { source: document!.source } : {}),
                ...(document!.changeReason ? { changeReason: document!.changeReason } : {}),
                ...(review
                  ? { review: { id: review.id, by: review.actor.name, at: review.recordedAt, note: review.note } }
                  : {}),
                ...(document!.text ? { text: document!.text } : {}),
              },
            }),
        attachments: attachments.map(({ label, sha256, confidentiality }) => ({ label, sha256, confidentiality })),
      },
    },
  };
}

/** Content a person signs for a safety assurance record: the exact version body and every attached file by digest. */
function assuranceSigningContent(
  signer: AuthContext,
  record: SmsRecordRow,
  version: SmsVersionRow,
  attachments: AttachmentDigest[],
): SigningContext {
  const body = version.body as AssuranceBody;
  const type = assuranceTypes[body.assuranceType].title.toLowerCase();
  const actions = body.actions.length;
  const intent =
    `I, ${signer.name}, sign version ${version.version_number} of the ${type} “${version.title}” as this ` +
    `organization’s record of it${actions ? `, setting the ${actions === 1 ? 'action' : `${actions} actions`} it lists` : ''}.`;
  return {
    satisfyingCapability: 'sms:adopt',
    checkedCapabilities: ['decision:write', 'sms:adopt'],
    content: {
      version: 'sms.signed-content.1',
      meaning: 'assurance.sign',
      intent,
      tenantId: signer.tenantId,
      subject: { id: record.id, kind: record.kind, revision: Number(record.revision), title: version.title },
      signer: { id: signer.id, name: signer.name },
      bindings: [
        {
          kind: 'record_version',
          recordId: record.id,
          versionNumber: version.version_number,
          bodyDigest: version.body_digest,
        },
        ...attachments.map((attachment) => ({
          kind: 'attachment' as const,
          attachmentId: attachment.id,
          sha256: attachment.sha256,
        })),
      ],
      statement: {
        title: version.title,
        versionNumber: version.version_number,
        assurance: { type: assuranceTypes[body.assuranceType].title, ...body },
        attachments: attachments.map(({ label, sha256, confidentiality }) => ({ label, sha256, confidentiality })),
      },
    },
  };
}

export async function riskAcceptanceContext(
  client: PoolClient,
  signer: AuthContext,
  hazard: SmsRecordRow,
): Promise<SigningContext> {
  if (hazard.kind !== 'hazard')
    throw new DomainError(400, 'unsupported_decision', 'Only a hazard has a risk acceptance');
  if (!hazard.latest_assessment_id)
    throw new DomainError(409, 'assessment_required', 'Assess this hazard on the risk matrix before accepting it');
  if (hazard.status === 'accepted')
    throw new DomainError(409, 'already_accepted', 'The current assessment is already accepted');
  if (hazard.status !== 'awaiting_acceptance')
    throw new DomainError(409, 'assessment_outdated', 'The hazard changed after its assessment; reassess it first');
  const assessment = await readDecision(client, hazard.tenant_id, hazard.id, hazard.latest_assessment_id);
  if (!assessment) throw new DomainError(409, 'assessment_unavailable', 'The assessment is unavailable');
  const adopted = await adoptedMatrix(client, hazard.tenant_id);
  const outcome = assessment.outcome as SmsAssessmentOutcome;
  if (
    !adopted ||
    adopted.version.record_id !== outcome.matrix.recordId ||
    adopted.version.version_number !== outcome.matrix.versionNumber
  )
    throw new DomainError(409, 'matrix_changed', 'A newer risk matrix is adopted; reassess this hazard on it');
  await requireAssessedControlsCurrent(client, hazard.tenant_id, hazard.id, outcome.controls);
  const version = await currentVersion(client, hazard);
  return riskAcceptanceContent(signer, hazard, version, assessment, adopted.version);
}

export async function adoptionContext(
  client: PoolClient,
  signer: AuthContext,
  record: SmsRecordRow,
): Promise<SigningContext> {
  if (!SMS_KINDS[record.kind].adoption)
    throw new DomainError(400, 'unsupported_decision', 'This record is not adopted with a signature');
  if (record.status === 'adopted') throw new DomainError(409, 'already_adopted', 'This version is already adopted');
  if (record.status === 'signed') throw new DomainError(409, 'already_signed', 'This version is already signed');
  if (record.status === 'closed')
    throw new DomainError(409, 'record_closed', 'This record is closed; reopen it before adopting it');
  const version = await currentVersion(client, record);
  if (record.kind === 'document') {
    const review = await reviewedDocument(client, record);
    if (!review && version.schema === 'sms.document.2')
      throw new DomainError(
        409,
        'document_review_required',
        'Review this revision and select its files before signing',
      );
    if (review) {
      const manifest = review.outcome as SmsDocumentReviewOutcome;
      if (manifest.document.bodyDigest !== version.body_digest)
        throw new DomainError(409, 'document_review_changed', 'The document changed after review');
      const files = await documentFiles(
        client,
        record,
        manifest.attachments.map((file) => file.id),
      );
      if (canonicalDigest(files.map(({ id, sha256 }) => ({ id, sha256 }))) !== canonicalDigest(manifest.attachments))
        throw new DomainError(409, 'document_files_changed', 'The reviewed files no longer match');
      return adoptionContent(signer, record, version, files, review);
    }
  }
  return adoptionContent(signer, record, version, await attachmentDigests(client, record));
}

async function statusBeforeClosing(client: PoolClient, record: SmsRecordRow): Promise<string> {
  const closed = (
    await client.query<{ record: SmsDecisionRecord }>(
      `SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND kind='record.close'
       AND record->>'version'='sms.decision.1' ORDER BY accepted_revision DESC LIMIT 1`,
      [record.tenant_id, record.id],
    )
  ).rows[0];
  return (closed?.record.outcome as SmsStatusOutcome | undefined)?.priorStatus ?? SMS_KINDS[record.kind].initialStatus;
}

function requireSignedContent(
  shown: { intent: string; contentDigest: string },
  signing: SigningContext,
): { canonical: string; digest: string } {
  const canonical = canonicalize(signing.content);
  const digest = canonicalDigest(signing.content);
  if (shown.contentDigest !== digest || shown.intent !== signing.content.intent)
    throw new DomainError(
      409,
      'signed_content_changed',
      'What you reviewed no longer matches the record; review the current content before signing',
    );
  return { canonical, digest };
}

function assessmentOutcome(
  command: Extract<SmsDecisionCommand['decision'], { kind: 'risk.assess' }>,
  matrix: SmsVersionRow & { body: RiskMatrixBody },
  version: SmsVersionRow,
  controls: SmsAssessmentOutcome['controls'],
): SmsAssessmentOutcome {
  const initial = evaluateRiskMatrix(matrix.body, command.initial);
  const residual = evaluateRiskMatrix(matrix.body, command.residual);
  if (!initial || !residual)
    throw new DomainError(400, 'unknown_matrix_position', 'Choose a severity and likelihood from the adopted matrix');
  if (command.newHazardCheck.answer === 'new_hazards_identified' && !command.newHazardCheck.note)
    throw new DomainError(400, 'new_hazard_note_required', 'Describe the new hazards the controls may introduce');
  return {
    matrix: { recordId: matrix.record_id, versionNumber: matrix.version_number, bodyDigest: matrix.body_digest },
    initial,
    controls,
    residual,
    newHazardCheck: command.newHazardCheck,
    assessedVersion: { versionNumber: version.version_number, bodyDigest: version.body_digest },
  };
}

/** Whether a decision can change which accepted controls are in force, and so the organization's rules. */
function changesAcceptedControls(recordKind: string, decisionKind: string): boolean {
  return (
    (recordKind === 'hazard' || recordKind === 'control') &&
    ['risk.accept', 'record.close', 'record.reopen'].includes(decisionKind)
  );
}

export async function acceptSmsDecision(
  client: PoolClient,
  principal: AuthContext,
  command: SmsDecisionCommand,
  reauthenticate?: Reauthenticate,
  store?: ObjectStore,
): Promise<CommandRecord> {
  const actor = await currentActor(client, principal);
  requireCapability(actor, 'decision:write');
  // A record's kind never changes, so the unlocked read decides what the decision locks first.
  const recordKind = (await readSmsRecord(client, actor.tenantId, command.subject.id)).kind;
  // A decision that changes what is on file restates its observations last; their keys come before any row.
  const onFile = recordsOnFileScope(recordKind, command.subject.id, command.decision.kind);
  await lockRecordsOnFile(client, actor.tenantId, onFile);
  // A decision that can change the accepted controls updates the organization row later. It takes that row before
  // its record and basis closure, as the commands that hold the organization row before a subject or the avoidance
  // register do.
  if (changesAcceptedControls(recordKind, command.decision.kind)) await organization(client, actor.tenantId, 'UPDATE');
  // The record's subject and every subject its basis rests on, in id order, before the record: a decision on a hazard
  // and a revision of one of its controls then cannot hold each other's subject and record.
  await lockSubjectAndClosure(client, actor, command.subject.id);
  const record = await lockSmsRecord(client, actor.tenantId, command.subject.id);
  requireRevision(record, command.expectedRevision);
  const basis = await readSmsBasis(client, record, actor, { lock: true });
  if (basis.smsBasis !== command.expectedDependencyBasis)
    throw new DomainError(
      409,
      'stale_basis',
      'Something this decision depends on changed; review the current record and decide again',
    );
  const decision = command.decision;
  let outcome: SmsDecisionRecord['outcome'] | ((receivedAt: string) => SmsDecisionRecord['outcome']);
  let status: string;
  let authority: SmsAuthoritySnapshot;
  let signing: (SigningContext & { canonical: string; digest: string }) | undefined;
  const dependencies: { subjectId: string; eventId: string }[] = [];
  let acceptedControls: SmsAssessmentOutcome['controls'] = [];
  if (
    decision.kind === 'document.review' ||
    decision.kind === 'document.issue' ||
    decision.kind === 'document.distribute' ||
    decision.kind === 'document.withdraw' ||
    decision.kind === 'document.periodic-review'
  ) {
    requireCapability(actor, 'sms:write');
    const prepared = await prepareDocumentDecision(client, actor, record, decision);
    outcome = prepared.outcome;
    status = prepared.status;
    authority = authoritySnapshot(actor, ['decision:write', 'sms:write']);
  } else if (decision.kind === 'risk.assess') {
    if (record.kind !== 'hazard')
      throw new DomainError(400, 'unsupported_decision', 'Only a hazard is assessed on the risk matrix');
    if (record.status === 'closed')
      throw new DomainError(409, 'record_closed', 'This hazard is closed; reopen it before assessing it');
    requireCapability(actor, 'sms:write');
    const adopted = await adoptedMatrix(client, actor.tenantId);
    if (!adopted)
      throw new DomainError(409, 'matrix_not_adopted', 'Your organization has not adopted a risk matrix yet');
    if (
      adopted.version.record_id !== decision.matrix.recordId ||
      adopted.version.version_number !== decision.matrix.versionNumber
    )
      throw new DomainError(409, 'matrix_not_current', 'A different risk matrix version is now adopted; review it');
    const evidence = await assessmentEvidence(client, actor.tenantId, record.id, decision.evidence);
    const controls = await assessedControls(client, actor.tenantId, record.id, decision.controls);
    outcome = {
      ...assessmentOutcome(decision, adopted.version, await currentVersion(client, record), controls.controls),
      ...(evidence ? { evidence } : {}),
    };
    status = 'awaiting_acceptance';
    authority = authoritySnapshot(actor, ['decision:write', 'sms:write']);
    dependencies.push({ subjectId: adopted.record.id, eventId: adopted.adoption.id });
    for (const [subjectId, eventId] of controls.eventIds) dependencies.push({ subjectId, eventId });
  } else if (decision.kind === 'risk.accept') {
    if (decision.assessmentId !== record.latest_assessment_id)
      throw new DomainError(
        409,
        'assessment_not_current',
        'A newer assessment is recorded; review it before accepting',
      );
    const context = await riskAcceptanceContext(client, actor, record);
    signing = { ...context, ...requireSignedContent(decision.signature, context) };
    const assessment = (await readDecision(client, actor.tenantId, record.id, decision.assessmentId))!;
    const assessed = assessment.outcome as SmsAssessmentOutcome;
    const accepted: SmsAcceptanceOutcome = {
      assessmentId: assessment.id,
      assessmentDigest: canonicalDigest(assessment.outcome),
      matrix: assessed.matrix,
      level: assessed.residual.level,
      acceptance: assessed.residual.acceptance as RiskAuthority,
    };
    outcome = accepted;
    acceptedControls = assessed.controls;
    status = 'accepted';
    authority = authoritySnapshot(actor, context.checkedCapabilities, context.satisfyingCapability);
  } else if (decision.kind === 'action.close') {
    requireCapability(actor, 'sms:write');
    outcome = await prepareActionClose(client, actor, record, decision.actionId);
    status = record.status;
    authority = authoritySnapshot(actor, ['decision:write', 'sms:write']);
  } else if (
    decision.kind === 'matrix.adopt' ||
    decision.kind === 'document.adopt' ||
    decision.kind === 'assurance.sign'
  ) {
    if (SMS_KINDS[record.kind].adoption !== decision.kind)
      throw new DomainError(400, 'unsupported_decision', 'This record is not adopted with that decision');
    if (decision.versionNumber !== record.version_number)
      throw new DomainError(409, 'stale_basis', 'A newer version of this record exists; review it before adopting');
    const context = await adoptionContext(client, actor, record);
    signing = { ...context, ...requireSignedContent(decision.signature, context) };
    const version = await currentVersion(client, record);
    const reference = { recordId: record.id, versionNumber: version.version_number, bodyDigest: version.body_digest };
    const review = decision.kind === 'document.adopt' ? await reviewedDocument(client, record) : undefined;
    const attachments = review
      ? (review.outcome as SmsDocumentReviewOutcome).attachments
      : (await attachmentDigests(client, record)).map(({ id, sha256 }) => ({ id, sha256 }));
    outcome =
      decision.kind === 'matrix.adopt'
        ? { matrix: reference, attachments }
        : decision.kind === 'assurance.sign'
          ? { assurance: reference, attachments }
          : { document: reference, attachments, ...(review ? { reviewId: review.id } : {}) };
    status = decision.kind === 'assurance.sign' ? 'signed' : 'adopted';
    authority = authoritySnapshot(actor, context.checkedCapabilities, context.satisfyingCapability);
  } else {
    requireCapability(actor, SMS_KINDS[record.kind].writeCapability);
    if (!SMS_KINDS[record.kind].closable)
      throw new DomainError(400, 'unsupported_decision', 'This kind of record is not closed');
    const closing = decision.kind === 'record.close';
    if (closing && record.kind === 'hazard' && record.owner_id !== actor.id)
      throw new DomainError(403, 'owner_required', 'Only the hazard’s owner closes it');
    if (closing === (record.status === 'closed'))
      throw new DomainError(409, 'status_unchanged', closing ? 'This record is already closed' : 'This record is open');
    const priorStatus = closing ? record.status : await statusBeforeClosing(client, record);
    status = closing ? 'closed' : record.kind === 'document' ? 'draft' : priorStatus;
    const review = decision.review ? await closingReview(client, record, closing, decision.review) : undefined;
    outcome = { status, priorStatus: record.status, ...(review ? { review } : {}) };
    authority = authoritySnapshot(actor, ['decision:write', SMS_KINDS[record.kind].writeCapability]);
  }
  let reauthentication: ReauthenticationEvidence | undefined;
  if (signing) {
    if (!reauthenticate) throw new DomainError(403, 'reauthentication_required', 'Confirm it is you before signing');
    reauthentication = await reauthenticate();
  }
  const revision = Number(record.revision);
  const signatureId = signing ? randomUUID() : undefined;
  let acceptance!: Omit<SmsDecisionRecord, 'id' | 'recordedAt'>;
  const event = await appendEvent(client, actor, {
    type: command.kind,
    stream: smsStream(record.id),
    payload: ({ receivedAt }) => {
      acceptance = {
        version: 'sms.decision.1',
        subjectId: record.id,
        kind: decision.kind,
        note: decision.note,
        acceptedRevision: revision + 1,
        acceptedBasisRevision: revision,
        outcome: typeof outcome === 'function' ? outcome(receivedAt) : outcome,
        actor: authority,
        dependencyBasis: basis.smsBasis,
        ...(signing ? { signature: { id: signatureId!, contentDigest: signing.digest } } : {}),
      };
      return { ...command, acceptance };
    },
  });
  const stored: SmsDecisionRecord = { ...acceptance, id: event.id, recordedAt: event.received_at.toISOString() };
  await client.query(
    `INSERT INTO decisions(id,tenant_id,flight_id,subject_id,adoption_id,accepted_revision,actor_id,kind,note,
     recorded_at,rendered_input_cut,accepted_input_cut,accepted_basis_revision,record)
     VALUES($1,$2,NULL,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      event.id,
      actor.tenantId,
      record.id,
      stored.acceptedRevision,
      actor.id,
      stored.kind,
      stored.note,
      event.received_at,
      { ...basis.rendered, basisRevision: revision },
      { ...basis.accepted, basisRevision: revision },
      revision,
      { ...stored, basisManifest: basis.basisManifest },
    ],
  );
  if (signing && reauthentication)
    await client.query(
      `INSERT INTO sms_signatures(id,tenant_id,subject_id,subject_revision,decision_id,signer_id,meaning,intent,content,
       content_canonical,content_digest,authority,reauthentication,signed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        signatureId,
        actor.tenantId,
        record.id,
        revision,
        event.id,
        actor.id,
        signing.content.meaning,
        signing.content.intent,
        signing.content,
        signing.canonical,
        signing.digest,
        authority,
        reauthentication,
        event.received_at,
      ],
    );
  await client.query(
    `UPDATE sms_records SET revision=$1,status=$2,updated_at=$3,
     latest_assessment_id=CASE WHEN $4='risk.assess' THEN $5 ELSE latest_assessment_id END,
     latest_acceptance_id=CASE WHEN $4='risk.accept' THEN $5 ELSE latest_acceptance_id END
     WHERE tenant_id=$6 AND id=$7`,
    [revision + 1, status, event.received_at, decision.kind, event.id, actor.tenantId, record.id],
  );
  if (acceptedControls.length)
    await recordAcceptedControls(client, actor.tenantId, record.id, event.id, acceptedControls, event.received_at);
  await retainSubjectEvidence(client, actor.tenantId, [record.id], event);
  for (const dependency of dependencies)
    await linkSubjectDependency(client, actor.tenantId, record.id, dependency.subjectId, dependency.eventId);
  if (changesAcceptedControls(record.kind, decision.kind))
    await refreshAcceptedControlRules(client, actor, {
      id: event.id,
      checkedCapabilities: [
        ...new Set([
          ...authority.checkedCapabilities,
          ...(authority.satisfyingCapability ? [authority.satisfyingCapability] : []),
        ]),
      ],
    });
  await refreshRecordsOnFile(client, actor, onFile, { eventId: event.id, at: event.received_at }, store);
  return recordCommand(client, actor, event, command, record.id);
}
