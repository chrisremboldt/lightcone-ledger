import { NOTICE_DUE_SOON_DAYS } from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { noticeKey, type NoticeItem } from './notice-content.js';
import {
  emailNoticesConfigured,
  findingNoticeRecords,
  queueNotices,
  safetyNoticeRecord,
  type NoticeDraft,
} from './notices.js';
import { openAssuranceActions, organizationDay } from './sms-assurance.js';
import { documentReading } from './sms-reading.js';

// The dated notices and the digests (docs/design/notices.md), written by the periodic worker. Each draft's key names
// the action and its due day, or the person's digest and its day, so a second pass writes nothing new.

/** An open action with a due day and its person: a finding's action, or a safety assurance record's. */
interface DatedAction extends NoticeItem {
  ownerId: string;
  dueOn: string;
  /** What names the action across passes: the finding, or the record and the action's id. */
  itemKey: string;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function datedActions(client: PoolClient, tenantId: string, until: string): Promise<DatedAction[]> {
  const findings = (
    await client.query<{ id: string; owner_id: string; due_on: string }>(
      `SELECT v.id,v.owner_id,v.action_due_on::text AS due_on FROM finding_views v
       WHERE v.tenant_id=$1 AND v.status<>'resolved' AND v.owner_id IS NOT NULL AND v.action_note IS NOT NULL
         AND v.action_done_at IS NULL AND v.action_due_on<=$2::date`,
      [tenantId, until],
    )
  ).rows;
  const records = await findingNoticeRecords(
    client,
    tenantId,
    findings.map((row) => row.id),
  );
  const actions: DatedAction[] = findings.flatMap((row) => {
    const record = records.get(row.id);
    return record ? [{ ownerId: row.owner_id, dueOn: row.due_on, record, itemKey: `finding:${row.id}` }] : [];
  });
  for (const action of await openAssuranceActions(client, tenantId))
    if (action.dueOn <= until)
      actions.push({
        ownerId: action.ownerId,
        dueOn: action.dueOn,
        actionId: action.actionId,
        record: safetyNoticeRecord(action.record),
        itemKey: `assurance:${action.recordId}:${action.actionId}`,
      });
  return actions;
}

/** Days a digest looks ahead for what is due. */
const DIGEST_DAYS = 7;

export interface DatedNoticeOptions {
  /** The organization's hour from which the day's digests are written; default 6. */
  digestHour?: number;
}

/**
 * The periodic pass for one organization: an action due within three days, once; an action overdue, once; and the
 * digest of each person who asked for one, once a day or on Mondays once a week, from the digest hour on. Run by a
 * worker holding the organization's schedule lease. Returns how many notices were written.
 */
export async function writeDatedNotices(
  client: PoolClient,
  tenantId: string,
  options: DatedNoticeOptions = {},
): Promise<number> {
  const { today, timeZone } = await organizationDay(client, tenantId);
  const actions = await datedActions(client, tenantId, addDays(today, Math.max(NOTICE_DUE_SOON_DAYS, DIGEST_DAYS)));
  const soon = addDays(today, NOTICE_DUE_SOON_DAYS);
  const drafts: NoticeDraft[] = [];
  for (const action of actions) {
    const overdue = action.dueOn < today;
    if (!overdue && action.dueOn > soon) continue;
    drafts.push({
      key: noticeKey([overdue ? 'action.overdue' : 'action.due', action.itemKey, action.dueOn]),
      recipientId: action.ownerId,
      event: overdue ? 'action.overdue' : 'action.due',
      record: action.record,
      dueOn: action.dueOn,
      ...(action.actionId ? { actionId: action.actionId } : {}),
    });
  }
  let written = await queueNotices(client, tenantId, drafts);
  if (emailNoticesConfigured())
    written += await writeDigests(client, tenantId, today, timeZone, actions, options.digestHour ?? 6);
  return written;
}

async function writeDigests(
  client: PoolClient,
  tenantId: string,
  today: string,
  timeZone: string,
  actions: DatedAction[],
  digestHour: number,
): Promise<number> {
  const clock = (
    await client.query<{ hour: number; weekday: number }>(
      `SELECT extract(hour FROM clock_timestamp() AT TIME ZONE $1)::int AS hour,
         extract(isodow FROM clock_timestamp() AT TIME ZONE $1)::int AS weekday`,
      [timeZone],
    )
  ).rows[0]!;
  if (clock.hour < digestHour) return 0;
  const people = (
    await client.query<{ id: string; digest: 'daily' | 'weekly' }>(
      `SELECT s.principal_id AS id,s.digest FROM notice_settings s
       JOIN principals p ON p.tenant_id=s.tenant_id AND p.id=s.principal_id
       WHERE s.tenant_id=$1 AND s.email IS NOT NULL AND s.digest<>'none' AND p.active AND p.kind='human'
         AND (s.digest='daily' OR $2::int=1)`,
      [tenantId, clock.weekday],
    )
  ).rows;
  if (!people.length) return 0;
  const owned = (
    await client.query<{ id: string; owner_id: string }>(
      `SELECT v.id,v.owner_id FROM finding_views v WHERE v.tenant_id=$1 AND v.status<>'resolved'
       AND v.owner_id=ANY($2::text[])`,
      [tenantId, people.map((person) => person.id)],
    )
  ).rows;
  const records = await findingNoticeRecords(
    client,
    tenantId,
    owned.map((row) => row.id),
  );
  const horizon = addDays(today, DIGEST_DAYS);
  const drafts: NoticeDraft[] = [];
  for (const person of people) {
    const mine = actions.filter((action) => action.ownerId === person.id);
    const item = ({ record, actionId, dueOn }: DatedAction): NoticeItem => ({
      record,
      dueOn,
      ...(actionId ? { actionId } : {}),
    });
    const reading = await documentReading(client, {
      id: person.id,
      tenantId,
      name: '',
      kind: 'human',
      capabilities: [],
      revision: 1,
    });
    const digest = {
      period: person.digest,
      day: today,
      overdue: mine.filter((action) => action.dueOn < today).map(item),
      due: mine.filter((action) => action.dueOn >= today && action.dueOn <= horizon).map(item),
      assigned: owned
        .filter((row) => row.owner_id === person.id && !mine.some((action) => action.record.id === row.id))
        .flatMap((row) => {
          const record = records.get(row.id);
          return record ? [{ record }] : [];
        }),
      acknowledgement: reading.reading
        .filter((entry) => !entry.acknowledgedAt && ['current', 'scheduled'].includes(entry.status))
        .map((entry): NoticeItem => ({
          record: safetyNoticeRecord(
            { id: entry.recordId, kind: 'document', title: entry.title, reference: null, confidentiality: 'ordinary' },
            entry.issueId,
          ),
          dueAt: entry.dueAt,
        })),
    };
    if (!digest.overdue.length && !digest.due.length && !digest.assigned.length && !digest.acknowledgement.length)
      continue;
    drafts.push({
      key: noticeKey(['digest', person.digest, today]),
      recipientId: person.id,
      event: 'digest',
      digest,
    });
  }
  return queueNotices(client, tenantId, drafts);
}
