import { randomBytes, randomUUID } from 'node:crypto';
import {
  RECEIPT_CODE_ALPHABET,
  type ReportBody,
  type SafetyReportLink,
  type SafetyReportLinkInForce,
  type SafetyReportLinkIssue,
  type SafetyReportLinkIssued,
  type SafetyReportStatus,
  type SmsRecordOpenCommand,
  type submittedReportChannelValues,
} from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type ObjectStore, type PoolClient } from '@ledger/persistence';
import { retainSubjectEvidence } from './cuts.js';
import { recordsOnFileScope, refreshRecordsOnFile } from './records-on-file.js';
import {
  insertRestrictedVersion,
  recordCommand,
  requireCapability,
  restrictedCommand,
  restrictedContent,
  restrictedTitle,
  SMS_KINDS,
  smsStream,
} from './sms-envelope.js';

// Safety reports people submit themselves (docs/design/report-submission.md). Everything a submission writes is
// written as the organization's reporting channel, never as the person who sent it.

/** The organization's reporting channel principal, as migration 0086 names it. */
export function reportingChannelId(tenantId: string): string {
  return `safety-reports-${tenantId}`;
}

/** At most this many reports through one link in an hour. */
export const REPORT_LINK_HOURLY_LIMIT = 20;

export interface SubmittedReport {
  narrative: string;
  occurredAt?: string;
  siteReference?: string;
  contact?: string;
  /** When the reporter's device says the report was written, by its own clock. */
  writtenAt?: string;
  /** Present only when a signed-in person chose to put their name on the report. */
  reporterName?: string;
  channel: (typeof submittedReportChannelValues)[number];
}

const submittedTitles: Record<SubmittedReport['channel'], string> = {
  submitted_signed_in: 'Safety report submitted in Ledger',
  submitted_link: 'Safety report submitted through a reporting link',
};

function receiptCode(): string {
  return [...randomBytes(20)].map((byte) => RECEIPT_CODE_ALPHABET[byte & 31]).join('');
}

/** The receipt code as Ledger hashes it: upper case, without spaces or dashes, look-alike letters read as digits. */
export function canonicalReceiptCode(code: string): string | undefined {
  const plain = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return plain.length === 20 && [...plain].every((character) => RECEIPT_CODE_ALPHABET.includes(character))
    ? plain
    : undefined;
}

const shownCode = (plain: string) => plain.match(/.{4}/g)!.join('-');

function requireChannel(channel: AuthContext): void {
  if (channel.kind !== 'intake' || channel.id !== reportingChannelId(channel.tenantId))
    throw new DomainError(500, 'reporting_channel_required', 'A submitted report is written by the reporting channel');
}

/**
 * Stores a submitted report as a protected report record of the reporting channel, and returns the receipt code shown
 * once to the reporter. Nothing it writes names or describes the person who sent it.
 */
export async function submitSafetyReport(
  client: PoolClient,
  channel: AuthContext,
  report: SubmittedReport,
  store?: ObjectStore,
): Promise<{ code: string; recordId: string }> {
  requireChannel(channel);
  const policy = SMS_KINDS.report;
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const reporter =
    report.reporterName || report.contact
      ? {
          reporter: {
            ...(report.reporterName ? { name: report.reporterName } : {}),
            ...(report.contact ? { contact: report.contact } : {}),
          },
        }
      : {};
  const body: ReportBody = {
    narrative: report.narrative,
    ...(report.occurredAt ? { occurredAt: report.occurredAt } : {}),
    ...(report.siteReference ? { siteReference: report.siteReference } : {}),
    received: {
      channel: report.channel,
      receivedAt: now.toISOString(),
      ...(report.writtenAt ? { writtenAt: report.writtenAt } : {}),
    },
    ...reporter,
  };
  const command: SmsRecordOpenCommand = {
    kind: 'sms.record.open',
    record: {
      kind: 'report',
      schema: 'sms.report.1',
      title: submittedTitles[report.channel],
      ownerId: channel.id,
      body,
    },
  };
  const confidentiality = 'safety_report' as const;
  const content = restrictedContent(command.record);
  const title = await restrictedTitle(client, confidentiality);
  const id = randomUUID();
  await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'sms',$3)", [
    id,
    channel.tenantId,
    title,
  ]);
  const retained = restrictedCommand(command, content, []);
  const event = await appendEvent(client, channel, {
    type: command.kind,
    stream: smsStream(id),
    payload: {
      ...retained,
      recordId: id,
      recordKind: 'report',
      recordClass: policy.recordClass,
      confidentiality,
      versionNumber: 1,
    },
  });
  await client.query(
    `INSERT INTO sms_records(id,tenant_id,kind,record_class,confidentiality,revision,version_number,status,title,
     owner_id,due_at,opened_by,opened_at,updated_at,links) VALUES($1,$2,'report',$3,$4,1,1,$5,$6,$7,NULL,$7,$8,$8,'[]')`,
    [
      id,
      channel.tenantId,
      policy.recordClass,
      confidentiality,
      policy.initialStatus,
      title,
      channel.id,
      event.received_at,
    ],
  );
  await insertRestrictedVersion(
    client,
    channel,
    id,
    1,
    1,
    { recordClass: policy.recordClass, confidentiality },
    command.record,
    content,
    event,
  );
  await retainSubjectEvidence(client, channel.tenantId, [id], event);
  const onFile = recordsOnFileScope('report', id, command.kind);
  await refreshRecordsOnFile(client, channel, onFile, { eventId: event.id, at: event.received_at }, store);
  await recordCommand(client, channel, event, retained, id);
  const code = receiptCode();
  await client.query('INSERT INTO safety_report_receipts(code_sha256,tenant_id,record_id) VALUES($1,$2,$3)', [
    sha256(code),
    channel.tenantId,
    id,
  ]);
  return { code: shownCode(code), recordId: id };
}

/** Counts a report against its link's hour, refusing it once the link has taken its limit. */
export async function countLinkReport(client: PoolClient, channel: AuthContext, linkId: string): Promise<void> {
  requireChannel(channel);
  const counted = (
    await client.query<{ window_count: number }>(
      `UPDATE safety_report_links SET
        window_started_at=CASE WHEN window_started_at IS NULL OR window_started_at<=clock_timestamp()-interval '1 hour'
         THEN clock_timestamp() ELSE window_started_at END,
        window_count=CASE WHEN window_started_at IS NULL OR window_started_at<=clock_timestamp()-interval '1 hour'
         THEN 1 ELSE window_count+1 END
       WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
       RETURNING window_count`,
      [channel.tenantId, linkId],
    )
  ).rows[0];
  if (!counted) throw linkNotInUse();
  if (counted.window_count > REPORT_LINK_HOURLY_LIMIT)
    throw new DomainError(
      429,
      'report_link_busy',
      'This reporting link has taken many reports in the last hour. Try again later, or tell your safety lead in person.',
    );
}

export function linkNotInUse(): DomainError {
  return new DomainError(404, 'report_link_not_in_use', 'This reporting link is not in use');
}

interface LinkRow {
  id: string;
  label: string;
  issued_by: string;
  issued_by_name: string;
  issued_at: Date;
  expires_at: Date | null;
  revoked_by: string | null;
  revoked_by_name: string | null;
  revoked_at: Date | null;
  in_force: boolean;
}
const linkSql = `SELECT l.id,l.label,l.issued_by,i.name AS issued_by_name,l.issued_at,l.expires_at,l.revoked_by,
  r.name AS revoked_by_name,l.revoked_at,
  (l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>clock_timestamp())) AS in_force
 FROM safety_report_links l
 JOIN principals i ON i.tenant_id=l.tenant_id AND i.id=l.issued_by
 LEFT JOIN principals r ON r.tenant_id=l.tenant_id AND r.id=l.revoked_by`;

function link(row: LinkRow): SafetyReportLink {
  return {
    id: row.id,
    label: row.label,
    issuedBy: { id: row.issued_by, name: row.issued_by_name },
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedBy: row.revoked_by ? { id: row.revoked_by, name: row.revoked_by_name ?? row.revoked_by } : null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    inForce: row.in_force,
  };
}

async function readLink(client: PoolClient, tenantId: string, id: string): Promise<SafetyReportLink> {
  const row = (await client.query<LinkRow>(`${linkSql} WHERE l.tenant_id=$1 AND l.id=$2`, [tenantId, id])).rows[0];
  if (!row)
    throw new DomainError(404, 'report_link_not_found', 'The reporting link was not found in your organization');
  return link(row);
}

const configureMessage = 'Reporting links are issued and revoked by a person who may configure safety records';

/** Every reporting link of the organization, newest first. */
export async function listReportLinks(client: PoolClient, actor: AuthContext): Promise<{ links: SafetyReportLink[] }> {
  requireCapability(actor, 'sms:configure', configureMessage);
  const rows = await client.query<LinkRow>(`${linkSql} WHERE l.tenant_id=$1 ORDER BY l.issued_at DESC,l.id LIMIT 200`, [
    actor.tenantId,
  ]);
  return { links: rows.rows.map(link) };
}

/** The links that take reports now, by label, for the Safety home. */
export async function reportLinksInForce(client: PoolClient, tenantId: string): Promise<SafetyReportLinkInForce[]> {
  const rows = await client.query<{ label: string; expires_at: Date | null }>(
    `SELECT label,expires_at FROM safety_report_links WHERE tenant_id=$1 AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY issued_at,id`,
    [tenantId],
  );
  return rows.rows.map((row) => ({ label: row.label, expiresAt: row.expires_at?.toISOString() ?? null }));
}

/** Issues a reporting link. Its token is returned here once; only its SHA-256 is kept. */
export async function issueReportLink(
  client: PoolClient,
  actor: AuthContext,
  issue: SafetyReportLinkIssue,
): Promise<SafetyReportLinkIssued> {
  requireCapability(actor, 'sms:configure', configureMessage);
  const label = issue.label.trim();
  if (issue.expiresAt) {
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (Date.parse(issue.expiresAt) <= now.getTime())
      throw new DomainError(400, 'report_link_expiry_past', 'The expiry must be later than now');
  }
  const id = `report-link-${randomUUID()}`;
  const token = `ledger-report-${randomBytes(32).toString('base64url')}`;
  const event = await appendEvent(client, actor, {
    type: 'sms.report-link.issue',
    stream: `sms-report-link:${id}`,
    payload: { linkId: id, label, expiresAt: issue.expiresAt ?? null },
  });
  await client.query(
    `INSERT INTO safety_report_links(id,tenant_id,label,token_sha256,issue_event_id,issued_by,issued_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, actor.tenantId, label, sha256(token), event.id, actor.id, event.received_at, issue.expiresAt ?? null],
  );
  return { link: await readLink(client, actor.tenantId, id), token };
}

/** Revokes a reporting link at once. A revoked link takes no more reports. */
export async function revokeReportLink(
  client: PoolClient,
  actor: AuthContext,
  id: string,
): Promise<{ link: SafetyReportLink }> {
  requireCapability(actor, 'sms:configure', configureMessage);
  const held = (
    await client.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM safety_report_links WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [actor.tenantId, id],
    )
  ).rows[0];
  if (!held)
    throw new DomainError(404, 'report_link_not_found', 'The reporting link was not found in your organization');
  if (held.revoked_at) throw new DomainError(409, 'report_link_revoked', 'This reporting link is already revoked');
  const event = await appendEvent(client, actor, {
    type: 'sms.report-link.revoke',
    stream: `sms-report-link:${id}`,
    payload: { linkId: id },
  });
  await client.query(
    'UPDATE safety_report_links SET revoke_event_id=$1,revoked_by=$2,revoked_at=$3 WHERE tenant_id=$4 AND id=$5',
    [event.id, actor.id, event.received_at, actor.tenantId, id],
  );
  return { link: await readLink(client, actor.tenantId, id) };
}

/** All a receipt code tells: whether its report is received or closed. Reads across organizations by the code alone. */
export async function safetyReportStatus(client: Pick<PoolClient, 'query'>, code: string): Promise<SafetyReportStatus> {
  const plain = canonicalReceiptCode(code);
  const row = plain
    ? (
        await client.query<{ status: SafetyReportStatus['status'] }>(
          'SELECT status FROM ledger_safety_report_receipt($1)',
          [sha256(plain)],
        )
      ).rows[0]
    : undefined;
  if (!row) throw new DomainError(404, 'receipt_not_found', 'No safety report has this receipt code');
  return { status: row.status };
}

/** The link a token opens while it is in force, with its organization's reporting channel. */
export async function reportLinkForToken(
  client: Pick<PoolClient, 'query'>,
  token: string,
): Promise<{ linkId: string; tenantId: string; channelId: string }> {
  const row = (
    await client.query<{ link_id: string; tenant_id: string; channel_id: string }>(
      'SELECT link_id,tenant_id,channel_id FROM ledger_safety_report_link($1)',
      [sha256(token)],
    )
  ).rows[0];
  if (!row) throw linkNotInUse();
  return { linkId: row.link_id, tenantId: row.tenant_id, channelId: row.channel_id };
}
