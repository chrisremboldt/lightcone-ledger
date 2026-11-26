import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import {
  noticeWebhookBody,
  renderNoticeEmail,
  webhookAddressProblem,
  webhookSignature,
  writeDatedNotices,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type NoticeContent,
  type NoticeDeployment,
} from '@ledger/domain';
import { DomainError, isDatabaseUnavailable, withScope, type Pool } from '@ledger/persistence';

/**
 * Sending notices (docs/design/notices.md). A worker leases a notice, sends it, and records the attempt only while it
 * still holds the lease: an attempt is a row, never an update. A failure is tried again after a growing wait; the fifth
 * failure is recorded as given up. The periodic pass that writes the dated notices and digests is leased per
 * organization the same way.
 */

export const NOTICE_TIMEOUT_MS = 10_000;
/** The waits after the first four failures, in seconds. */
export const NOTICE_RETRY_DELAYS = [60, 300, 1800, 7200];
/** How often an organization's dated notices and digests are looked for, in seconds. */
export const NOTICE_SCHEDULE_SECONDS = 900;
const ATTEMPT_LIMIT = 5;

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}
export interface OutgoingCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}
/** How notices leave Ledger; a test replaces either. */
export interface NoticeTransport {
  email: (message: OutgoingEmail) => Promise<void>;
  webhook: (call: OutgoingCall) => Promise<void>;
}

export interface NoticeWorkerOptions {
  deployment: NoticeDeployment;
  /** Whether an http:// webhook is posted to: only on a local Ledger. */
  httpWebhooks: boolean;
  transport?: Partial<NoticeTransport>;
  owner?: string;
  limit?: number;
  /** Longer than a send can take, so a lease is not lost while sending. */
  leaseSeconds?: number;
  retryDelays?: number[];
  scheduleSeconds?: number;
  digestHour?: number;
}

export interface NoticeLease {
  tenant_id: string;
  notice_id: string;
  generation: string;
  lease_owner: string;
  worker_id: string;
}

function smtpTransport(deployment: NoticeDeployment): NoticeTransport['email'] {
  const smtp = deployment.smtp;
  if (!smtp) return async () => Promise.reject(new Error('This Ledger is not configured to send email'));
  const mailer = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    connectionTimeout: NOTICE_TIMEOUT_MS,
    greetingTimeout: NOTICE_TIMEOUT_MS,
    socketTimeout: NOTICE_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (message) => {
    await mailer.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text });
  };
}

async function postWebhook(call: OutgoingCall): Promise<void> {
  const response = await fetch(call.url, {
    method: 'POST',
    headers: call.headers,
    body: call.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status < 200 || response.status > 299)
    throw new Error(`The webhook answered ${response.status} ${response.statusText}`.trim());
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNECTION',
  'ESOCKET',
  'EPIPE',
]);

/** A short reason a send failed, in words an administrator can act on; never a credential. */
export function failureReason(error: unknown, channel: 'email' | 'webhook'): string {
  const failure = error as {
    name?: string;
    message?: string;
    code?: string;
    response?: string;
    responseCode?: number;
    cause?: { code?: string };
  };
  const where = channel === 'email' ? 'the mail server' : 'the webhook';
  const code = failure?.cause?.code ?? failure?.code;
  let reason: string;
  if (failure?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
    reason = `${channel === 'email' ? 'The mail server' : 'The webhook'} did not answer within 10 seconds`;
  else if (code && UNREACHABLE.has(code)) reason = `Could not reach ${where} (${code})`;
  else if (channel === 'email' && failure?.responseCode)
    reason = `The mail server refused it: ${failure.response ?? failure.message}`;
  else reason = failure?.message || `Sending to ${where} failed`;
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function leaseNotices(
  pool: Pool,
  options: { owner?: string; limit?: number; leaseSeconds?: number } = {},
) {
  return (
    await pool.query<NoticeLease>('SELECT * FROM ledger_lease_notices($1,$2,$3)', [
      options.owner ?? randomUUID(),
      options.limit ?? 20,
      options.leaseSeconds ?? 60,
    ])
  ).rows;
}

const leaseHeld = `SELECT 1 FROM notice_deliveries WHERE tenant_id=$1 AND notice_id=$2 AND state='leased'
  AND generation=$3 AND lease_owner=$4 AND lease_until>clock_timestamp()`;

interface Prepared {
  channel: 'email' | 'webhook';
  address: string | null;
  content: NoticeContent;
  createdAt: string;
  attempts: number;
  webhook: { url: string; secret: string } | null;
}

/** Sends one leased notice and records the attempt. Returns false when the lease was lost and nothing was recorded. */
export async function sendLeasedNotice(pool: Pool, lease: NoticeLease, options: NoticeWorkerOptions): Promise<boolean> {
  const scope = { id: lease.worker_id, tenantId: lease.tenant_id };
  const prepared = await withScope(pool, scope, async (client): Promise<Prepared | null> => {
    const held = await client.query(leaseHeld, [lease.tenant_id, lease.notice_id, lease.generation, lease.lease_owner]);
    if (!held.rowCount) return null;
    const notice = (
      await client.query<{
        channel: 'email' | 'webhook';
        address: string | null;
        content: NoticeContent;
        created_at: Date;
      }>('SELECT channel,address,content,created_at FROM notices WHERE tenant_id=$1 AND id=$2', [
        lease.tenant_id,
        lease.notice_id,
      ])
    ).rows[0]!;
    const attempts = Number(
      (
        await client.query<{ count: string }>(
          'SELECT count(*) AS count FROM notice_attempts WHERE tenant_id=$1 AND notice_id=$2',
          [lease.tenant_id, lease.notice_id],
        )
      ).rows[0]!.count,
    );
    const webhook =
      notice.channel === 'webhook'
        ? ((
            await client.query<{ url: string; secret: string }>(
              'SELECT url,secret FROM notice_webhooks WHERE tenant_id=$1',
              [lease.tenant_id],
            )
          ).rows[0] ?? null)
        : null;
    return {
      channel: notice.channel,
      address: notice.address,
      content: notice.content,
      createdAt: notice.created_at.toISOString(),
      attempts,
      webhook,
    };
  });
  if (!prepared) return false;
  const attempt = prepared.attempts + 1;
  let outcome: 'sent' | 'failed' | 'given_up';
  let reason: string | null = null;
  const unsendable = unsendableReason(prepared, options);
  if (unsendable) {
    outcome = 'given_up';
    reason = unsendable;
  } else {
    try {
      await send(lease, prepared, options);
      outcome = 'sent';
    } catch (error) {
      reason = failureReason(error, prepared.channel);
      outcome = attempt >= ATTEMPT_LIMIT ? 'given_up' : 'failed';
    }
  }
  return recordAttempt(pool, lease, attempt, outcome, reason, options.retryDelays ?? NOTICE_RETRY_DELAYS);
}

function unsendableReason(prepared: Prepared, options: NoticeWorkerOptions): string | null {
  if (prepared.channel === 'email') return options.deployment.smtp ? null : 'This Ledger no longer sends email';
  if (!prepared.webhook) return 'The organization has no webhook now';
  return webhookAddressProblem(prepared.webhook.url, options.httpWebhooks) ?? null;
}

async function send(lease: NoticeLease, prepared: Prepared, options: NoticeWorkerOptions): Promise<void> {
  const { deployment } = options;
  if (prepared.channel === 'email') {
    const { subject, text } = renderNoticeEmail(prepared.content, deployment.publicUrl);
    const email = options.transport?.email ?? smtpTransport(deployment);
    await email({ from: deployment.smtp!.from, to: prepared.address!, subject, text });
    return;
  }
  const body = JSON.stringify(
    noticeWebhookBody({ id: lease.notice_id, createdAt: prepared.createdAt }, prepared.content, deployment.publicUrl),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  await (options.transport?.webhook ?? postWebhook)({
    url: prepared.webhook!.url,
    body,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Ledger notices',
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_SIGNATURE_HEADER]: webhookSignature(prepared.webhook!.secret, timestamp, body),
    },
  });
}

async function recordAttempt(
  pool: Pool,
  lease: NoticeLease,
  attempt: number,
  outcome: 'sent' | 'failed' | 'given_up',
  reason: string | null,
  delays: number[],
): Promise<boolean> {
  return withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    // The worker's own queue row first; a worker that lost its lease records nothing.
    const held = await client.query(`${leaseHeld} FOR UPDATE`, [
      lease.tenant_id,
      lease.notice_id,
      lease.generation,
      lease.lease_owner,
    ]);
    if (!held.rowCount) return false;
    await client.query(
      `INSERT INTO notice_attempts(id,tenant_id,notice_id,attempt,attempted_at,outcome,reason)
       VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6)`,
      [randomUUID(), lease.tenant_id, lease.notice_id, attempt, outcome, reason],
    );
    const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
    const updated = await client.query(
      `UPDATE notice_deliveries SET state=$1,lease_owner=NULL,lease_until=NULL,
         available_at=CASE WHEN $1='pending' THEN clock_timestamp()+make_interval(secs=>$2) ELSE available_at END
       WHERE tenant_id=$3 AND notice_id=$4 AND generation=$5 AND state='leased' AND lease_until>clock_timestamp()`,
      [outcome === 'failed' ? 'pending' : 'done', delay, lease.tenant_id, lease.notice_id, lease.generation],
    );
    if (updated.rowCount !== 1)
      throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease before commit');
    return true;
  });
}

export interface ScheduleLease {
  tenant_id: string;
  generation: string;
  lease_owner: string;
  worker_id: string;
}

export async function leaseNoticeSchedules(
  pool: Pool,
  options: { owner?: string; limit?: number; leaseSeconds?: number } = {},
): Promise<ScheduleLease[]> {
  return (
    await pool.query<ScheduleLease>('SELECT * FROM ledger_lease_notice_schedules($1,$2,$3)', [
      options.owner ?? randomUUID(),
      options.limit ?? 20,
      options.leaseSeconds ?? 60,
    ])
  ).rows;
}

/** Writes one organization's dated notices and digests while holding its schedule lease. */
export async function processNoticeSchedule(
  pool: Pool,
  lease: ScheduleLease,
  options: Pick<NoticeWorkerOptions, 'scheduleSeconds' | 'digestHour'> = {},
): Promise<number | null> {
  return withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    const held = await client.query(
      `SELECT 1 FROM notice_schedules WHERE tenant_id=$1 AND generation=$2 AND lease_owner=$3
       AND lease_until>clock_timestamp() FOR UPDATE`,
      [lease.tenant_id, lease.generation, lease.lease_owner],
    );
    if (!held.rowCount) return null;
    const written = await writeDatedNotices(client, lease.tenant_id, { digestHour: options.digestHour });
    const done = await client.query(
      `UPDATE notice_schedules SET lease_owner=NULL,lease_until=NULL,
         available_at=clock_timestamp()+make_interval(secs=>$1)
       WHERE tenant_id=$2 AND generation=$3 AND lease_owner=$4 AND lease_until>clock_timestamp()`,
      [options.scheduleSeconds ?? NOTICE_SCHEDULE_SECONDS, lease.tenant_id, lease.generation, lease.lease_owner],
    );
    if (done.rowCount !== 1) throw new DomainError(409, 'worker_lease_expired', 'Worker lost its lease before commit');
    return written;
  });
}

async function releaseSchedule(pool: Pool, lease: ScheduleLease): Promise<void> {
  await withScope(pool, { id: lease.worker_id, tenantId: lease.tenant_id }, async (client) => {
    await client.query(
      `UPDATE notice_schedules SET lease_owner=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '60 seconds'
       WHERE tenant_id=$1 AND generation=$2 AND lease_owner=$3`,
      [lease.tenant_id, lease.generation, lease.lease_owner],
    );
  });
}

/** One pass: the organizations whose dated notices are due, then the notices waiting to be sent. */
export async function runDueNotices(pool: Pool, options: NoticeWorkerOptions): Promise<number> {
  let completed = 0;
  for (const lease of await leaseNoticeSchedules(pool, options)) {
    try {
      if ((await processNoticeSchedule(pool, lease, options)) !== null) completed++;
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw error;
      await releaseSchedule(pool, lease);
    }
  }
  for (const lease of await leaseNotices(pool, options)) {
    try {
      if (await sendLeasedNotice(pool, lease, options)) completed++;
    } catch (error) {
      // An unrecorded attempt is leased again once its lease runs out.
      if (isDatabaseUnavailable(error)) throw error;
    }
  }
  return completed;
}
