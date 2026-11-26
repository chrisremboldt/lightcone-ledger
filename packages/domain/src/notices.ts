import { randomBytes, randomUUID } from 'node:crypto';
import {
  subjectReferenceKey,
  type SubjectReference,
  NOTICE_ATTEMPT_LIMIT,
  NOTICE_EMAIL_PATTERN,
  NOTICE_LIST_LIMIT,
  type NoticeEntry,
  type NoticeKind,
  type NoticeListQuery,
  type NoticeListResponse,
  type NoticeSettings,
  type NoticeSettingsResponse,
  type NoticeSettingsUpdate,
  type NoticeState,
  type NoticeWebhookResponse,
  type NoticeWebhookSetResponse,
} from '@ledger/contracts';
import { appendEvent, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import {
  noticeKindOf,
  noticeSentence,
  noticeSubjectReference,
  recordLine,
  type NoticeContent,
  type NoticeEvent,
  type NoticeRecord,
} from './notice-content.js';
import { subjectNames } from './subject-names.js';

/**
 * Notices (docs/design/notices.md). A notice is written to the outbox in the same transaction as what causes it, or by
 * the periodic worker for the dated ones; a worker sends it. Writing one never blocks or fails its cause: a person
 * with no address, a channel that is off, or a notice already written is simply not written again.
 */

// --- What the deployment configures ---

export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS from the first byte (port 465); otherwise the connection is upgraded when the server offers it. */
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}
export interface NoticeDeployment {
  smtp: SmtpSettings | null;
  /** The address people open Ledger at; every link in a notice starts with it. */
  publicUrl: string | null;
}

/**
 * The deployment's notice settings, from its environment. Email is off unless LEDGER_SMTP_HOST is set; with it set,
 * the From address and the public address for links are required, and a start without them is refused.
 */
export function noticeDeployment(env: NodeJS.ProcessEnv = process.env): NoticeDeployment {
  const value = (name: string) => env[name]?.trim() || null;
  const publicUrl = value('LEDGER_PUBLIC_URL');
  if (publicUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(publicUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash)
      throw new Error(
        'LEDGER_PUBLIC_URL must be the address people open Ledger at, such as https://ledger.example.org',
      );
  }
  const host = value('LEDGER_SMTP_HOST');
  if (!host) return { smtp: null, publicUrl: publicUrl?.replace(/\/+$/, '') ?? null };
  const from = value('LEDGER_SMTP_FROM');
  if (!from || !/@/.test(from))
    throw new Error('Email notices need LEDGER_SMTP_FROM, the address they are sent from, such as ledger@example.org');
  if (!publicUrl)
    throw new Error(
      'Email notices link to the record they are about: set LEDGER_PUBLIC_URL to the address people open Ledger at, such as https://ledger.example.org',
    );
  const user = value('LEDGER_SMTP_USER');
  const password = env.LEDGER_SMTP_PASSWORD || null;
  if (Boolean(user) !== Boolean(password))
    throw new Error(
      'Set both LEDGER_SMTP_USER and LEDGER_SMTP_PASSWORD, or neither when the mail server needs no sign-in',
    );
  const secure = value('LEDGER_SMTP_SECURE') === '1';
  const port = Number(value('LEDGER_SMTP_PORT') ?? (secure ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LEDGER_SMTP_PORT must be a port number');
  return { smtp: { host, port, secure, user, password, from }, publicUrl: publicUrl.replace(/\/+$/, '') };
}

let emailNotices = false;
/** Whether this process writes email notices: set once at start from the deployment's settings. */
export function configureNoticeChannels(options: { email: boolean }): void {
  emailNotices = options.email;
}
export function emailNoticesConfigured(): boolean {
  return emailNotices;
}

// --- The records notices are about ---

export interface NoticeOrganization {
  id: string;
  name: string;
  timeZone: string;
}

export async function noticeOrganization(client: PoolClient, tenantId: string): Promise<NoticeOrganization> {
  const row = (
    await client.query<{ name: string; time_zone: string }>('SELECT name,time_zone FROM tenants WHERE id=$1', [
      tenantId,
    ])
  ).rows[0];
  return { id: tenantId, name: row?.name ?? tenantId, timeZone: row?.time_zone ?? 'UTC' };
}

/** A path segment as the web app writes it (apps/web/src/place.ts). */
function segment(id: string): string {
  return encodeURIComponent(id).replaceAll('%40', '@').replaceAll('%3A', ':');
}
export const noticePath = (...parts: string[]) => `/${parts.map(segment).join('/')}`;

/** How each finding is named in a notice, by finding id. A finding about a restricted record carries no title. */
export async function findingNoticeRecords(
  client: PoolClient,
  tenantId: string,
  ids: string[],
): Promise<Map<string, NoticeRecord>> {
  if (!ids.length) return new Map();
  const rows = await client.query<{
    id: string;
    flight_id: string | null;
    subject_scope: string | null;
    subject_kind: string | null;
    subject_id: string | null;
    subject_source_id: string | null;
    title: string | null;
    restricted: boolean;
  }>(
    `SELECT f.id,v.flight_id,f.subject_scope,f.subject_kind,f.subject_id,f.subject_source_id,
       COALESCE(r.record->'rule'->>'title',e.record->>'title') AS title,
       EXISTS(SELECT 1 FROM sms_records s WHERE s.tenant_id=f.tenant_id AND s.id=f.subject_id
         AND s.confidentiality<>'ordinary') AS restricted
     FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
     LEFT JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
     LEFT JOIN flight_evaluations e ON e.tenant_id=v.tenant_id AND e.id=v.latest_evaluation_id
     WHERE f.tenant_id=$1 AND f.id=ANY($2::text[])`,
    [tenantId, ids],
  );
  // A finding is named as the open findings list names it: its rule's title and its subject in the organization's own
  // id. A restricted record's subject is named by its id only, since its name may be the record's title.
  const subjectOf = (row: (typeof rows.rows)[number]): SubjectReference | null =>
    row.subject_scope && row.subject_kind && row.subject_id
      ? ({
          scope: row.subject_scope,
          kind: row.subject_kind,
          id: row.subject_id,
          ...(row.subject_source_id ? { sourceId: row.subject_source_id } : {}),
        } as SubjectReference)
      : null;
  const names = await subjectNames(
    client,
    tenantId,
    rows.rows.flatMap((row) => {
      const subject = subjectOf(row);
      return subject && !row.restricted ? [subject] : [];
    }),
  );
  return new Map(
    rows.rows.map((row) => {
      const subject = subjectOf(row);
      const reference = subject
        ? noticeSubjectReference(subject.id, row.restricted ? null : names.get(subjectReferenceKey(subject))?.name)
        : row.id;
      const path = row.flight_id
        ? noticePath('flights', row.flight_id, 'findings', row.id)
        : row.subject_scope === 'source' && row.subject_source_id
          ? noticePath('rules', 'findings', row.subject_source_id, row.subject_kind ?? '', row.subject_id ?? '')
          : noticePath('rules', 'findings', row.subject_kind ?? '', row.subject_id ?? '');
      return [row.id, { label: 'Finding', id: row.id, reference, title: row.restricted ? null : row.title, path }];
    }),
  );
}

const recordSegments: Record<string, string> = {
  hazard: 'hazards',
  control: 'controls',
  document: 'documents',
  risk_matrix: 'risk-matrices',
  report: 'reports',
  assurance: 'assurance',
};
const recordLabels: Record<string, string> = {
  hazard: 'Hazard',
  control: 'Control',
  document: 'Document',
  risk_matrix: 'Risk matrix',
  report: 'Safety report',
  assurance: 'Safety assurance record',
};

/** How a safety record is named in a notice. A safety report or a restricted record is named by reference only. */
export function safetyNoticeRecord(
  record: { id: string; kind: string; title: string; reference: string | null; confidentiality: string },
  issueId?: string,
): NoticeRecord {
  const restricted = record.kind === 'report' || record.confidentiality !== 'ordinary';
  return {
    label: recordLabels[record.kind] ?? 'Safety record',
    id: record.id,
    reference: record.reference ?? record.id,
    title: restricted ? null : record.title,
    path: noticePath(
      'safety',
      recordSegments[record.kind] ?? record.kind,
      record.id,
      ...(issueId && record.kind === 'document' ? ['issues', issueId] : []),
    ),
  };
}

// --- Writing notices ---

export interface NoticeDraft {
  /** What the notice is, without its person and channel: the same draft from a retry has the same key. */
  key: string;
  recipientId: string;
  event: NoticeEvent;
  record?: NoticeRecord;
  actionId?: string;
  dueOn?: string;
  dueAt?: string | null;
  by?: string;
  digest?: NoticeContent['digest'];
  /** The person did it themselves: the organization's webhook hears of it, the person gets no email. */
  ownDoing?: boolean;
}

interface RecipientRow {
  id: string;
  email: string | null;
  assigned: boolean | null;
  due: boolean | null;
  overdue: boolean | null;
  acknowledgement: boolean | null;
  digest: string | null;
}

/**
 * Writes the notices of these drafts: an email for each person with an address who wants that kind, when this
 * Ledger sends email, and a webhook call for each but a digest when the organization has a webhook. A notice already
 * written for the same key, person and channel is left as it is. Returns how many were written.
 */
export async function queueNotices(client: PoolClient, tenantId: string, drafts: NoticeDraft[]): Promise<number> {
  if (!drafts.length) return 0;
  const webhook = (await client.query('SELECT tenant_id FROM notice_webhooks WHERE tenant_id=$1', [tenantId])).rowCount;
  if (!webhook && !emailNotices) return 0;
  const people = new Map(
    (
      await client.query<RecipientRow>(
        `SELECT p.id,s.email,s.assigned,s.due,s.overdue,s.acknowledgement,s.digest FROM principals p
         LEFT JOIN notice_settings s ON s.tenant_id=p.tenant_id AND s.principal_id=p.id
         WHERE p.tenant_id=$1 AND p.id=ANY($2::text[]) AND p.active AND p.kind='human'`,
        [tenantId, [...new Set(drafts.map((draft) => draft.recipientId))]],
      )
    ).rows.map((row) => [row.id, row]),
  );
  const organization = await noticeOrganization(client, tenantId);
  let written = 0;
  for (const draft of drafts) {
    const person = people.get(draft.recipientId);
    if (!person) continue;
    const kind = noticeKindOf(draft.event);
    const content: NoticeContent = {
      version: 'notice.1',
      kind,
      event: draft.event,
      organization,
      assigneeId: draft.recipientId,
      ...(draft.by ? { by: draft.by } : {}),
      ...(draft.record ? { record: draft.record } : {}),
      ...(draft.actionId ? { actionId: draft.actionId } : {}),
      ...(draft.dueOn ? { dueOn: draft.dueOn } : {}),
      ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
      ...(draft.digest ? { digest: draft.digest } : {}),
    };
    const wants = kind === 'digest' ? person.digest !== null && person.digest !== 'none' : (person[kind] ?? true);
    if (emailNotices && person.email && wants && !draft.ownDoing)
      written += await insertNotice(client, tenantId, draft, 'email', person.email, content);
    if (webhook && kind !== 'digest') written += await insertNotice(client, tenantId, draft, 'webhook', null, content);
  }
  return written;
}

async function insertNotice(
  client: PoolClient,
  tenantId: string,
  draft: NoticeDraft,
  channel: 'email' | 'webhook',
  address: string | null,
  content: NoticeContent,
): Promise<number> {
  const inserted = await client.query(
    `WITH written AS (
       INSERT INTO notices(id,tenant_id,key,channel,recipient_id,kind,address,record_id,content)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(tenant_id,channel,recipient_id,key) DO NOTHING RETURNING tenant_id,id)
     INSERT INTO notice_deliveries(tenant_id,notice_id) SELECT tenant_id,id FROM written`,
    [
      randomUUID(),
      tenantId,
      draft.key,
      channel,
      draft.recipientId,
      content.kind,
      address,
      draft.record?.id ?? null,
      content,
    ],
  );
  return inserted.rowCount ?? 0;
}

// --- A person's settings ---

const defaultSettings: NoticeSettings = {
  email: null,
  choices: { assigned: true, due: true, overdue: true, acknowledgement: true },
  digest: 'none',
};

interface SettingsRow {
  email: string | null;
  assigned: boolean;
  due: boolean;
  overdue: boolean;
  acknowledgement: boolean;
  digest: NoticeSettings['digest'];
}
function settingsOf(row: SettingsRow | undefined): NoticeSettings {
  if (!row) return defaultSettings;
  return {
    email: row.email,
    choices: {
      assigned: row.assigned,
      due: row.due,
      overdue: row.overdue,
      acknowledgement: row.acknowledgement,
    },
    digest: row.digest,
  };
}

async function readSettings(client: PoolClient, tenantId: string, principalId: string): Promise<NoticeSettings> {
  return settingsOf(
    (
      await client.query<SettingsRow>(
        'SELECT email,assigned,due,overdue,acknowledgement,digest FROM notice_settings WHERE tenant_id=$1 AND principal_id=$2',
        [tenantId, principalId],
      )
    ).rows[0],
  );
}

export async function getNoticeSettings(client: PoolClient, principal: AuthContext): Promise<NoticeSettingsResponse> {
  return { settings: await readSettings(client, principal.tenantId, principal.id), emailAvailable: emailNotices };
}

function normalizedEmail(email: string | null | undefined): string | null | undefined {
  if (email === undefined || email === null) return email;
  const trimmed = email.trim();
  if (!new RegExp(NOTICE_EMAIL_PATTERN).test(trimmed) || trimmed.length > 254)
    throw new DomainError(400, 'invalid_notice_email', 'Give one plain email address, such as avery@example.org');
  return trimmed;
}

/**
 * Changes where a person's notices go and which they want: the person themselves, or an administrator setting their
 * address. Recorded as a journal event that says whether an address is kept, never the address itself.
 */
export async function updateNoticeSettings(
  client: PoolClient,
  actor: AuthContext,
  principalId: string,
  update: NoticeSettingsUpdate,
): Promise<{ settings: NoticeSettings; commandId: string }> {
  if (principalId !== actor.id && !actor.capabilities.includes('authority:write'))
    throw new DomainError(403, 'capability_required', 'Setting another person’s notices requires authority:write');
  const person = (
    await client.query<{ kind: string; active: boolean }>(
      'SELECT kind,active FROM principals WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, principalId],
    )
  ).rows[0];
  if (!person || person.kind !== 'human' || !person.active)
    throw new DomainError(
      404,
      'person_not_found',
      'That person was not found among the active people of your organization',
    );
  const email = normalizedEmail(update.email);
  const current = (
    await client.query<SettingsRow>(
      `SELECT email,assigned,due,overdue,acknowledgement,digest FROM notice_settings
       WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`,
      [actor.tenantId, principalId],
    )
  ).rows[0];
  const before = settingsOf(current);
  const settings: NoticeSettings = {
    email: email === undefined ? before.email : email,
    choices: { ...before.choices, ...(update.choices ?? {}) },
    digest: update.digest ?? before.digest,
  };
  const event = await appendEvent(client, actor, {
    type: 'notice.settings',
    stream: `notices:${principalId}`,
    payload: {
      kind: 'notice.settings',
      principalId,
      emailKept: settings.email !== null,
      ...(email !== undefined ? { emailChanged: email !== before.email } : {}),
      choices: settings.choices,
      digest: settings.digest,
    },
  });
  await client.query(
    `INSERT INTO notice_settings(tenant_id,principal_id,email,assigned,due,overdue,acknowledgement,digest,updated_at,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(tenant_id,principal_id) DO UPDATE SET email=EXCLUDED.email,assigned=EXCLUDED.assigned,
       due=EXCLUDED.due,overdue=EXCLUDED.overdue,acknowledgement=EXCLUDED.acknowledgement,digest=EXCLUDED.digest,
       updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`,
    [
      actor.tenantId,
      principalId,
      settings.email,
      settings.choices.assigned,
      settings.choices.due,
      settings.choices.overdue,
      settings.choices.acknowledgement,
      settings.digest,
      event.received_at,
      actor.id,
    ],
  );
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, actor.tenantId, 'notice.settings', actor.id, event.received_at, event.payload],
  );
  return { settings, commandId: event.id };
}

/** Each person's address for email notices, by principal id, for the People screen. */
export async function noticeEmails(client: PoolClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await client.query<{ principal_id: string; email: string }>(
    `SELECT principal_id,email FROM notice_settings WHERE tenant_id=$1 AND principal_id=ANY($2::text[])
     AND email IS NOT NULL`,
    [tenantId, ids],
  );
  return new Map(rows.rows.map((row) => [row.principal_id, row.email]));
}

// --- The organization's webhook ---

function requireAdministrator(actor: AuthContext): void {
  if (!actor.capabilities.includes('authority:write'))
    throw new DomainError(
      403,
      'capability_required',
      'The organization’s webhook is set by a person with authority:write',
    );
}

export async function getNoticeWebhook(
  client: PoolClient,
  actor: AuthContext,
  httpAllowed: boolean,
): Promise<NoticeWebhookResponse> {
  requireAdministrator(actor);
  const row = (
    await client.query<{ url: string; set_at: Date; set_by: string; name: string }>(
      `SELECT w.url,w.set_at,w.set_by,p.name FROM notice_webhooks w
       JOIN principals p ON p.tenant_id=w.tenant_id AND p.id=w.set_by WHERE w.tenant_id=$1`,
      [actor.tenantId],
    )
  ).rows[0];
  return {
    webhook: row ? { url: row.url, setAt: row.set_at.toISOString(), setBy: { id: row.set_by, name: row.name } } : null,
    httpAllowed,
  };
}

/** Whether a webhook address may be used: https, or http on a local Ledger. */
export function webhookAddressProblem(url: string, httpAllowed: boolean): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Give the webhook’s full address, such as https://hooks.example.org/ledger';
  }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol === 'http:' && httpAllowed) return undefined;
  return httpAllowed
    ? 'A webhook address starts with https:// or, on a local Ledger, http://'
    : 'A webhook address must start with https://; only a local Ledger posts to http://';
}

/**
 * Sets or removes the organization's webhook. Setting it makes a new secret, returned here once and never again;
 * the journal records the address and who set it, never the secret.
 */
export async function setNoticeWebhook(
  client: PoolClient,
  actor: AuthContext,
  url: string | null,
  httpAllowed: boolean,
): Promise<NoticeWebhookSetResponse> {
  requireAdministrator(actor);
  const address = url?.trim() ?? null;
  if (address !== null) {
    const problem = webhookAddressProblem(address, httpAllowed);
    if (problem) throw new DomainError(400, 'invalid_webhook_address', problem);
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notice-webhook|${actor.tenantId}`]);
  const event = await appendEvent(client, actor, {
    type: 'notice.webhook',
    stream: `notices:webhook`,
    payload: { kind: 'notice.webhook', url: address },
  });
  await client.query('DELETE FROM notice_webhooks WHERE tenant_id=$1', [actor.tenantId]);
  const secret = address === null ? null : randomBytes(32).toString('base64url');
  if (address !== null)
    await client.query('INSERT INTO notice_webhooks(tenant_id,url,secret,set_at,set_by) VALUES($1,$2,$3,$4,$5)', [
      actor.tenantId,
      address,
      secret,
      event.received_at,
      actor.id,
    ]);
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, actor.tenantId, 'notice.webhook', actor.id, event.received_at, event.payload],
  );
  return {
    webhook:
      address === null
        ? null
        : { url: address, setAt: event.received_at.toISOString(), setBy: { id: actor.id, name: actor.name } },
    secret,
    commandId: event.id,
  };
}

// --- The administrator's list ---

function listCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}
function readListCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === 'string') &&
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:\d\d)?$/.test(value[0]) &&
      listCursor(value[0], value[1]) === cursor
    )
      return [value[0], value[1]];
  } catch {
    // Refused below.
  }
  throw new DomainError(400, 'invalid_cursor', 'The notices cursor is not one this list gave');
}

const stateCondition: Record<NoticeState, string> = {
  waiting: 'a.outcome IS NULL',
  sent: "a.outcome='sent'",
  failed: "a.outcome='failed'",
  given_up: "a.outcome='given_up'",
};

/** Every notice of the organization, newest first, a page at a time, with its state. */
export async function listNotices(
  client: PoolClient,
  actor: AuthContext,
  query: NoticeListQuery = {},
): Promise<NoticeListResponse> {
  requireAdministrator(actor);
  const limit = Math.min(query.limit ?? NOTICE_LIST_LIMIT, NOTICE_LIST_LIMIT);
  const after = query.cursor ? readListCursor(query.cursor) : null;
  const rows = (
    await client.query<{
      id: string;
      created_at: Date;
      created_key: string;
      kind: NoticeKind;
      channel: 'email' | 'webhook';
      recipient_id: string;
      recipient_name: string;
      content: NoticeContent;
      outcome: 'sent' | 'failed' | 'given_up' | null;
      reason: string | null;
      attempt: number | null;
      attempted_at: Date | null;
    }>(
      `SELECT n.id,n.created_at,n.created_at::text AS created_key,n.kind,n.channel,n.recipient_id,p.name AS recipient_name,n.content,
         a.outcome,a.reason,a.attempt,a.attempted_at
       FROM notices n JOIN principals p ON p.tenant_id=n.tenant_id AND p.id=n.recipient_id
       LEFT JOIN LATERAL(SELECT x.outcome,x.reason,x.attempt,x.attempted_at FROM notice_attempts x
         WHERE x.tenant_id=n.tenant_id AND x.notice_id=n.id ORDER BY x.attempt DESC LIMIT 1) a ON true
       WHERE n.tenant_id=$1 ${query.state ? `AND ${stateCondition[query.state]}` : ''}
         AND ($3::timestamptz IS NULL OR (n.created_at,n.id COLLATE "C")<($3::timestamptz,$4::text COLLATE "C"))
       ORDER BY n.created_at DESC,n.id COLLATE "C" DESC LIMIT $2`,
      [actor.tenantId, limit + 1, after?.[0] ?? null, after?.[1] ?? null],
    )
  ).rows;
  const shown = rows.slice(0, limit);
  const notices = shown.map((row): NoticeEntry => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    kind: row.kind,
    channel: row.channel,
    recipient: { id: row.recipient_id, name: row.recipient_name },
    sentence: noticeSentence(row.content, 'organization', row.recipient_name),
    reference: row.content.record ? recordLine(row.content.record) : null,
    path: row.content.record?.path ?? null,
    state: row.outcome === null ? 'waiting' : row.outcome,
    attempts: row.attempt ?? 0,
    lastAttemptAt: row.attempted_at?.toISOString() ?? null,
    reason: row.outcome === 'sent' ? null : row.reason,
  }));
  const hasMore = rows.length > limit;
  const last = shown.at(-1);
  return {
    notices,
    hasMore,
    nextCursor: hasMore && last ? listCursor(last.created_key, last.id) : null,
  };
}

export { NOTICE_ATTEMPT_LIMIT };
