import { createHmac } from 'node:crypto';
import type { NoticeChannel, NoticeKind } from '@ledger/contracts';

/**
 * What a notice says (docs/design/notices.md): the organization's name, what happened in one plain sentence, the
 * record's own reference and title, the due date in the organization's time zone, and a link to the record's address.
 * A safety report's or a restricted record's notice carries its reference and the link only: no title, no content.
 * Everything here is pure: the content is fixed when a notice is written, and the text is made from it when it is sent.
 */

/** A record a notice is about, as the notice names it. */
export interface NoticeRecord {
  /** What a person calls it: "Finding", "Safety assurance record", "Document". */
  label: string;
  id: string;
  /** The organization's own id for it, or Ledger's id when it has none. */
  reference: string;
  /** Null for a safety report or a restricted record, whose title is never sent. */
  title: string | null;
  /** The record's address in Ledger, a path such as /safety/assurance/<id>. */
  path: string;
}

export interface NoticeItem {
  record: NoticeRecord;
  /** An action's id on its record, such as A1. */
  actionId?: string;
  /** A due day, in the organization's days. */
  dueOn?: string;
  /** A due instant, shown in the organization's time zone. */
  dueAt?: string | null;
}

export type NoticeEvent =
  'finding.assigned' | 'action.assigned' | 'action.due' | 'action.overdue' | 'document.acknowledgement' | 'digest';

export interface NoticeDigest {
  period: 'daily' | 'weekly';
  /** The organization's day the digest is for. */
  day: string;
  assigned: NoticeItem[];
  due: NoticeItem[];
  overdue: NoticeItem[];
  acknowledgement: NoticeItem[];
}

/** A notice's content as stored in the outbox. */
export interface NoticeContent extends Partial<NoticeItem> {
  version: 'notice.1';
  kind: NoticeKind;
  event: NoticeEvent;
  organization: { id: string; name: string; timeZone: string };
  /** The person the notice is for: the assignee, owner or reader. */
  assigneeId: string;
  /** Who did what the notice reports, when a person did. */
  by?: string;
  digest?: NoticeDigest;
}

const eventKinds: Record<NoticeEvent, NoticeKind> = {
  'finding.assigned': 'assigned',
  'action.assigned': 'assigned',
  'action.due': 'due',
  'action.overdue': 'overdue',
  'document.acknowledgement': 'acknowledgement',
  digest: 'digest',
};
export const noticeKindOf = (event: NoticeEvent): NoticeKind => eventKinds[event];

/** A day such as 2026-12-01, as Tuesday 1 December 2026. It is the organization's day, so no zone moves it. */
export function noticeDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(date)
    .replace(',', '');
}

/** An instant in the organization's time zone, with the zone's short name: 1 December 2026, 17:00 MST. */
export function noticeTime(at: string, timeZone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  // The zone's short name as people in it write it, such as MST; British English would write GMT-7.
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(date)
      .find((entry) => entry.type === 'timeZoneName')?.value ?? timeZone;
  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')} ${zone}`;
}

function dueWords(item: Partial<NoticeItem>, timeZone: string): string | null {
  if (item.dueOn) return noticeDay(item.dueOn);
  if (item.dueAt) return noticeTime(item.dueAt, timeZone);
  return null;
}

/**
 * A subject as a notice names it: the name its records give it beside the organization's own id, or the id alone. An
 * id Ledger made, a UUID, is shortened to its first eight characters beside a name.
 */
export function noticeSubjectReference(id: string, name: string | null | undefined): string {
  const named = name?.trim();
  if (!named || named === id) return id;
  return `${named} (${/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.slice(0, 8) : id})`;
}

/** "Finding F-12 · Battery log missing", or the reference alone for a record whose title is never sent. */
export function recordLine(record: NoticeRecord): string {
  return `${record.label} ${record.reference}${record.title ? ` · ${record.title}` : ''}`;
}

/**
 * What happened, in one sentence: to the person it is for ("you"), or to the organization, which names the person by
 * id beside it in a webhook's body, or by name where the organization's list of notices gives it.
 */
export function noticeSentence(
  content: NoticeContent,
  audience: 'person' | 'organization' = 'person',
  recipientName?: string,
): string {
  const you = audience === 'person';
  const person = recipientName ?? 'a person';
  const by = content.by ?? 'Someone';
  const action = content.actionId ? `Action ${content.actionId}` : 'An action';
  const due = dueWords(content, content.organization.timeZone);
  switch (content.event) {
    case 'finding.assigned':
      return you ? `${by} assigned a finding to you.` : `${by} assigned a finding to ${person}.`;
    case 'action.assigned':
      return you
        ? `${by} set an action for you${due ? `, due on ${due}` : ''}.`
        : `${by} set an action for ${person}${due ? `, due on ${due}` : ''}.`;
    case 'action.due':
      return you ? `${action} of yours is due on ${due}.` : `${action} is due on ${due}.`;
    case 'action.overdue':
      return you
        ? `${action} of yours was due on ${due} and is not recorded as done.`
        : `${action} was due on ${due} and is not recorded as done.`;
    case 'document.acknowledgement':
      return you
        ? `${by} issued a document for you to acknowledge${due ? ` by ${due}` : ''}.`
        : `${by} issued a document for ${person} to acknowledge${due ? ` by ${due}` : ''}.`;
    case 'digest': {
      const digest = content.digest!;
      return `What is yours in ${content.organization.name} ${digest.period === 'weekly' ? 'this week' : 'today'}, ${noticeDay(digest.day)}.`;
    }
  }
}

/** The full address of a record: the deployment's public address and the record's path. */
export function noticeLink(path: string, publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/+$/, '')}${path}`;
}

const subjects: Record<NoticeEvent, string> = {
  'finding.assigned': 'A finding is assigned to you',
  'action.assigned': 'An action is set for you',
  'action.due': 'An action of yours is due soon',
  'action.overdue': 'An action of yours is overdue',
  'document.acknowledgement': 'A document is waiting for your acknowledgement',
  digest: 'What is yours in Ledger',
};

const choiceWords: Record<NoticeKind, string> = {
  assigned: 'when something is assigned to you',
  due: 'when an action of yours is due soon',
  overdue: 'when an action of yours is overdue',
  acknowledgement: 'when a document waits for your acknowledgement',
  digest: 'a digest',
};

function itemLines(items: NoticeItem[], timeZone: string, publicUrl: string | null, dueLabel: string): string[] {
  return items.flatMap((item) => {
    const due = dueWords(item, timeZone);
    const link = noticeLink(item.record.path, publicUrl);
    return [
      `- ${recordLine(item.record)}${item.actionId ? `, action ${item.actionId}` : ''}${due ? ` (${dueLabel} ${due})` : ''}`,
      ...(link ? [`  ${link}`] : []),
    ];
  });
}

/** The plain-text email for a notice: no tracking, no images, no markup. The subject never holds a title. */
export function renderNoticeEmail(content: NoticeContent, publicUrl: string | null): { subject: string; text: string } {
  const organization = content.organization.name;
  const subject = `[${organization}] ${subjects[content.event]}${content.record ? `: ${content.record.label} ${content.record.reference}` : ''}`;
  const lines = [organization, '', noticeSentence(content, 'person'), ''];
  if (content.event === 'digest') {
    const digest = content.digest!;
    const zone = content.organization.timeZone;
    const section = (title: string, items: NoticeItem[], dueLabel: string) =>
      items.length ? [title, ...itemLines(items, zone, publicUrl, dueLabel), ''] : [];
    lines.push(
      ...section('Overdue', digest.overdue, 'was due'),
      ...section('Due soon', digest.due, 'due'),
      ...section('Assigned to you', digest.assigned, 'due'),
      ...section('Waiting for your acknowledgement', digest.acknowledgement, 'by'),
    );
  } else if (content.record) {
    lines.push(recordLine(content.record));
    if (content.actionId) lines.push(`Action: ${content.actionId}`);
    const due = dueWords(content, content.organization.timeZone);
    if (due) lines.push(`Due: ${due}`);
    const link = noticeLink(content.record.path, publicUrl);
    if (link) lines.push(`Open it in Ledger: ${link}`);
    lines.push('');
  }
  lines.push(
    `You get this email because you chose ${choiceWords[content.kind]} in Ledger. Change your notices from your name in Ledger's bar.`,
  );
  return { subject, text: `${lines.join('\n')}\n` };
}

/**
 * The JSON body of a webhook call. It names the person by id only, never by email address, and a restricted record by
 * its reference and link only.
 */
export function noticeWebhookBody(
  notice: { id: string; createdAt: string },
  content: NoticeContent,
  publicUrl: string | null,
): Record<string, unknown> {
  return {
    version: 'ledger.notice.1',
    id: notice.id,
    createdAt: notice.createdAt,
    kind: content.kind,
    event: content.event,
    organization: { id: content.organization.id, name: content.organization.name },
    assigneeId: content.assigneeId,
    sentence: noticeSentence(content, 'organization'),
    record: content.record
      ? {
          label: content.record.label,
          id: content.record.id,
          reference: content.record.reference,
          title: content.record.title,
          path: content.record.path,
          url: noticeLink(content.record.path, publicUrl),
        }
      : null,
    actionId: content.actionId ?? null,
    dueOn: content.dueOn ?? null,
    dueAt: content.dueAt ?? null,
    timeZone: content.organization.timeZone,
  };
}

export const WEBHOOK_SIGNATURE_HEADER = 'Ledger-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'Ledger-Timestamp';

/** The signature of a webhook call: HMAC-SHA256 with the secret over "<timestamp>.<body>", as hex. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** The key that makes a notice exist once for its person and channel. */
export function noticeKey(parts: (string | number)[]): string {
  return parts.map(String).join(':');
}

export type { NoticeChannel };
