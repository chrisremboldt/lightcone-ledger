import {
  documentAcknowledgementStatement,
  type CommandRecord,
  type DocumentType,
  type SmsDecisionRecord,
  type SmsDocumentAcknowledgeCommand,
  type SmsDocumentAcknowledgement,
  type SmsDocumentAssignment,
  type SmsDocumentControl,
  type SmsDocumentIssue,
  type SmsDocumentIssueRef,
  type SmsDocumentReadingProgress,
  type SmsDocumentReviewDue,
  type SmsDocumentSummary,
  type SmsPersonReading,
} from '@ledger/contracts';
import { appendEvent, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { authoritySnapshot, currentActor } from './sms-decisions.js';
import { documentAcknowledgements, documentDecisions, projectDocumentControl } from './sms-documents.js';
import { recordCommand, requireCapability, smsStream, type SmsRecordRow } from './sms-envelope.js';

interface ControlVersionRow {
  record_id: string;
  version_number: number;
  title: string;
  body: {
    revisionLabel?: string;
    reviewDueAt?: string;
    documentType: DocumentType;
    documentNumber?: string;
    origin?: 'authored' | 'received';
  };
}
const controlVersionColumns = `record_id,version_number,title,jsonb_build_object('revisionLabel',body->'revisionLabel',
 'reviewDueAt',body->'reviewDueAt','documentType',body->'documentType','documentNumber',body->'documentNumber',
 'origin',body->'origin') AS body`;
const controlDecisionKinds = [
  'document.issue',
  'document.distribute',
  'document.withdraw',
  'document.periodic-review',
  'record.close',
];
const REVIEW_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;
const isActive = (status: string) => status === 'current' || status === 'scheduled';
const issueRef = (issue: SmsDocumentIssue): SmsDocumentIssueRef => ({
  issueId: issue.id,
  versionNumber: issue.versionNumber,
  revisionLabel: issue.revisionLabel,
  effectiveFrom: issue.effectiveFrom,
});

async function databaseNow(client: PoolClient): Promise<string> {
  return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
}

/** A personal receipt. It shares the document's lock with other readers and never advances its revision. */
export async function acknowledgeDocumentIssue(
  client: PoolClient,
  principal: AuthContext,
  command: SmsDocumentAcknowledgeCommand,
): Promise<CommandRecord> {
  const actor = await currentActor(client, principal);
  requireCapability(actor, 'sms:read');
  const record = (
    await client.query<SmsRecordRow>('SELECT * FROM sms_records WHERE tenant_id=$1 AND id=$2 FOR SHARE', [
      actor.tenantId,
      command.recordId,
    ])
  ).rows[0];
  if (!record) throw new DomainError(404, 'sms_record_not_found', 'The record was not found in your organization');
  if (record.kind !== 'document') throw new DomainError(400, 'document_required', 'This action requires a document');
  if (record.status === 'closed') throw new DomainError(409, 'document_retired', 'This document is retired');
  const versions = (
    await client.query<ControlVersionRow>(
      `SELECT ${controlVersionColumns} FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2`,
      [actor.tenantId, record.id],
    )
  ).rows;
  const control = projectDocumentControl(
    record,
    versions,
    await documentDecisions(client, record),
    [],
    await databaseNow(client),
  );
  const issue = control.issues.find((entry) => entry.id === command.issueId);
  if (!issue)
    throw new DomainError(404, 'document_issue_unavailable', 'The issued revision was not found on this document');
  if (!isActive(issue.status))
    throw new DomainError(409, 'document_issue_inactive', 'This issue is no longer current or scheduled');
  if (!issue.recipients.some((person) => person.id === actor.id))
    throw new DomainError(
      403,
      'document_recipient_required',
      'Only an assigned person can acknowledge their own reading',
    );
  if (command.contentDigest !== issue.contentDigest)
    throw new DomainError(409, 'document_content_changed', 'Review the exact issued document before acknowledging it');
  let acknowledgement!: SmsDocumentAcknowledgement;
  const event = await appendEvent(client, actor, {
    type: command.kind,
    stream: smsStream(record.id),
    payload: ({ id, receivedAt }) => {
      acknowledgement = {
        version: 'sms.document-acknowledgement.1',
        id,
        recordId: record.id,
        issueId: issue.id,
        contentDigest: issue.contentDigest,
        statement: documentAcknowledgementStatement(issue),
        note: command.note?.trim() || null,
        actor: authoritySnapshot(actor, ['sms:read']),
        recordedAt: receivedAt,
      };
      return { ...command, acknowledgement };
    },
  });
  // The stream lock taken by appendEvent serializes readers of this document, so this sees any earlier receipt.
  const prior = await client.query(
    'SELECT 1 FROM sms_document_acknowledgements WHERE tenant_id=$1 AND issue_id=$2 AND recipient_id=$3',
    [actor.tenantId, issue.id, actor.id],
  );
  if (prior.rowCount)
    throw new DomainError(409, 'document_already_acknowledged', 'You already acknowledged this exact issue');
  await client.query(
    `INSERT INTO sms_document_acknowledgements(id,tenant_id,record_id,issue_id,recipient_id,content_digest,record,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      event.id,
      actor.tenantId,
      record.id,
      issue.id,
      actor.id,
      issue.contentDigest,
      acknowledgement,
      acknowledgement.recordedAt,
    ],
  );
  return recordCommand(client, actor, event, command, record.id);
}

interface ControlledDocument {
  record: SmsRecordRow;
  working: ControlVersionRow | undefined;
  control: SmsDocumentControl;
}

/** Projects many documents in four queries. Receipts are everyone's, one reader's, or none. */
async function controlledDocuments(
  client: PoolClient,
  tenantId: string,
  records: SmsRecordRow[],
  now: string,
  receiptsOf: 'everyone' | 'nobody' | { recipientId: string },
): Promise<ControlledDocument[]> {
  if (!records.length) return [];
  const ids = records.map((record) => record.id);
  const decisions = (
    await client.query<{ subject_id: string; record: SmsDecisionRecord }>(
      `SELECT subject_id,record FROM decisions WHERE tenant_id=$1 AND subject_id=ANY($2)
       AND kind=ANY($3) AND record->>'version'='sms.decision.1'`,
      [tenantId, ids, controlDecisionKinds],
    )
  ).rows;
  const versions = (
    await client.query<ControlVersionRow>(
      `SELECT ${controlVersionColumns} FROM sms_record_versions WHERE tenant_id=$1 AND record_id=ANY($2)`,
      [tenantId, ids],
    )
  ).rows;
  const receipts =
    receiptsOf === 'nobody'
      ? []
      : receiptsOf === 'everyone'
        ? await documentAcknowledgements(client, tenantId, ids)
        : (
            await client.query<{ record: SmsDocumentAcknowledgement }>(
              'SELECT record FROM sms_document_acknowledgements WHERE tenant_id=$1 AND recipient_id=$2',
              [tenantId, receiptsOf.recipientId],
            )
          ).rows.map(({ record }) => record);
  return records.map((record) => {
    const own = versions.filter((version) => version.record_id === record.id);
    return {
      record,
      working: own.find((version) => version.version_number === record.version_number),
      control: projectDocumentControl(
        record,
        own,
        decisions.filter((decision) => decision.subject_id === record.id).map((decision) => decision.record),
        receipts.filter((receipt) => receipt.recordId === record.id),
        now,
      ),
    };
  });
}

async function issuedDocuments(
  client: PoolClient,
  tenantId: string,
  now: string,
  receiptsOf: 'everyone' | { recipientId: string },
): Promise<ControlledDocument[]> {
  const records = (
    await client.query<SmsRecordRow>(
      `SELECT r.* FROM sms_records r WHERE r.tenant_id=$1 AND r.kind='document' AND r.status<>'closed'
       AND EXISTS(SELECT 1 FROM decisions d WHERE d.tenant_id=r.tenant_id AND d.subject_id=r.id AND d.kind='document.issue')`,
      [tenantId],
    )
  ).rows;
  return controlledDocuments(client, tenantId, records, now, receiptsOf);
}

/** Register facts for documents. Reading counts need the organization's receipts, so only document controllers get them. */
export async function documentSummaries(
  client: PoolClient,
  principal: AuthContext,
  records: SmsRecordRow[],
): Promise<Map<string, SmsDocumentSummary>> {
  const controlsDocuments = principal.capabilities.includes('sms:write');
  const now = await databaseNow(client);
  const documents = await controlledDocuments(
    client,
    principal.tenantId,
    records.filter((record) => record.kind === 'document'),
    now,
    controlsDocuments ? 'everyone' : 'nobody',
  );
  return new Map(
    documents.map(({ record, working, control }) => {
      const active = control.issues.filter((issue) => isActive(issue.status));
      const recipients = active.flatMap((issue) => issue.recipients);
      const scheduled = control.issues.find((issue) => issue.status === 'scheduled');
      return [
        record.id,
        {
          documentType: working?.body.documentType ?? 'other',
          documentNumber: working?.body.documentNumber ?? null,
          origin: working?.body.origin ?? 'authored',
          inForce: control.effectiveIssue ? issueRef(control.effectiveIssue) : null,
          scheduled: scheduled ? issueRef(scheduled) : null,
          reviewDueAt: control.reviewDueAt,
          reading: controlsDocuments
            ? {
                assigned: recipients.length,
                acknowledged: recipients.filter((person) => person.acknowledgedAt).length,
                overdue: recipients.filter(
                  (person) => !person.acknowledgedAt && person.dueAt && Date.parse(person.dueAt) <= Date.parse(now),
                ).length,
              }
            : null,
        },
      ];
    }),
  );
}

function assignments(documents: ControlledDocument[], principalId: string): SmsDocumentAssignment[] {
  const reading = documents.flatMap(({ record, control }) =>
    control.issues.flatMap((issue) => {
      const recipient = issue.recipients.find((person) => person.id === principalId);
      if (!recipient || !isActive(issue.status)) return [];
      return [
        {
          recordId: record.id,
          title: issue.title,
          issueId: issue.id,
          versionNumber: issue.versionNumber,
          revisionLabel: issue.revisionLabel,
          contentDigest: issue.contentDigest,
          effectiveFrom: issue.effectiveFrom,
          effectiveUntil: issue.effectiveUntil,
          dueAt: recipient.dueAt,
          acknowledgedAt: recipient.acknowledgedAt,
          status: issue.status,
        },
      ];
    }),
  );
  return reading.sort((a, b) => (a.dueAt ?? a.effectiveFrom).localeCompare(b.dueAt ?? b.effectiveFrom));
}

function progress(documents: ControlledDocument[], now: string): SmsDocumentReadingProgress[] {
  const rows = documents.flatMap(({ record, control }) =>
    control.issues.flatMap((issue) => {
      const outstanding = issue.recipients.filter((person) => !person.acknowledgedAt);
      if (!isActive(issue.status) || !outstanding.length) return [];
      const deadlines = outstanding.flatMap((person) => (person.dueAt ? [person.dueAt] : [])).sort();
      return [
        {
          recordId: record.id,
          title: issue.title,
          issueId: issue.id,
          versionNumber: issue.versionNumber,
          revisionLabel: issue.revisionLabel,
          status: issue.status,
          effectiveFrom: issue.effectiveFrom,
          assigned: issue.recipients.length,
          acknowledged: issue.recipients.length - outstanding.length,
          overdue: deadlines.filter((due) => Date.parse(due) <= Date.parse(now)).length,
          nextDueAt: deadlines[0] ?? null,
        },
      ];
    }),
  );
  return rows.sort(
    (a, b) =>
      b.overdue - a.overdue ||
      (a.nextDueAt ?? '\uffff').localeCompare(b.nextDueAt ?? '\uffff') ||
      a.title.localeCompare(b.title),
  );
}

function byPerson(documents: ControlledDocument[], now: string): SmsPersonReading[] {
  const people = new Map<string, SmsPersonReading>();
  for (const { record, control } of documents)
    for (const issue of control.issues.filter((entry) => isActive(entry.status)))
      for (const recipient of issue.recipients.filter((entry) => !entry.acknowledgedAt)) {
        const entry = people.get(recipient.id) ?? {
          person: { id: recipient.id, name: recipient.name },
          overdue: 0,
          documents: [],
        };
        entry.documents.push({ ...issueRef(issue), recordId: record.id, title: issue.title, dueAt: recipient.dueAt });
        if (recipient.dueAt && Date.parse(recipient.dueAt) <= Date.parse(now)) entry.overdue += 1;
        people.set(recipient.id, entry);
      }
  return [...people.values()]
    .map((entry) => ({
      ...entry,
      documents: entry.documents.sort((a, b) => (a.dueAt ?? '\uffff').localeCompare(b.dueAt ?? '\uffff')),
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue || b.documents.length - a.documents.length || a.person.name.localeCompare(b.person.name),
    );
}

function reviewsDue(documents: ControlledDocument[], now: string): SmsDocumentReviewDue[] {
  return documents
    .flatMap(({ record, control }) => {
      const issue = control.effectiveIssue;
      const due = control.reviewDueAt;
      if (!issue || !due || Date.parse(due) - Date.parse(now) > REVIEW_NOTICE_MS) return [];
      return [
        {
          ...issueRef(issue),
          recordId: record.id,
          title: issue.title,
          reviewDueAt: due,
          overdue: Date.parse(due) <= Date.parse(now),
        },
      ];
    })
    .sort((a, b) => a.reviewDueAt.localeCompare(b.reviewDueAt));
}

export async function documentReading(
  client: PoolClient,
  principal: AuthContext,
): Promise<{
  reading: SmsDocumentAssignment[];
  readingProgress: SmsDocumentReadingProgress[];
  readingByPerson: SmsPersonReading[];
  reviewsDue: SmsDocumentReviewDue[];
}> {
  const now = await databaseNow(client);
  const controlsDocuments = principal.capabilities.includes('sms:write');
  const documents = await issuedDocuments(
    client,
    principal.tenantId,
    now,
    controlsDocuments ? 'everyone' : { recipientId: principal.id },
  );
  return {
    reading: assignments(documents, principal.id),
    readingProgress: controlsDocuments ? progress(documents, now) : [],
    readingByPerson: controlsDocuments ? byPerson(documents, now) : [],
    reviewsDue: controlsDocuments ? reviewsDue(documents, now) : [],
  };
}
