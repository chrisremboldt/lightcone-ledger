import {
  assuranceBodyProblems,
  assuranceTypes,
  type AssuranceAction,
  type AssuranceBody,
  type SmsActionCloseOutcome,
  type SmsAssuranceActionDue,
  type SmsAssuranceSignOutcome,
  type SmsAssuranceSummary,
  type SmsAssuranceView,
  type SmsDecisionRecord,
  type SmsLink,
  type SmsPersonRef,
  type SmsRecordDraft,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import type { SmsRecordRow } from './sms-envelope.js';

// Safety assurance records (docs/design/assurance-records.md). An action is set when a version listing it is signed,
// and closed by an `action.close` decision. Days are the organization's own: an action is overdue from the start of
// the day after it is due, in the organization's time zone.

/** The organization's current day and time zone. */
export async function organizationDay(
  client: PoolClient,
  tenantId: string,
): Promise<{ today: string; timeZone: string }> {
  const row = (
    await client.query<{ today: string; time_zone: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE time_zone,'YYYY-MM-DD') AS today,time_zone FROM tenants WHERE id=$1`,
      [tenantId],
    )
  ).rows[0];
  return row
    ? { today: row.today, timeZone: row.time_zone }
    : { today: new Date().toISOString().slice(0, 10), timeZone: 'UTC' };
}

/** The instant a day starts in a time zone, as ISO. */
export async function dayStart(client: PoolClient, day: string, timeZone: string, addDays = 0): Promise<string> {
  const row = (
    await client.query<{ at: Date }>('SELECT (($1::date + $3::int)::timestamp AT TIME ZONE $2) AS at', [
      day,
      timeZone,
      addDays,
    ])
  ).rows[0]!;
  return row.at.toISOString();
}

async function requireActionOwners(client: PoolClient, tenantId: string, actions: AssuranceAction[]): Promise<void> {
  const ids = [...new Set(actions.map((action) => action.ownerId))].sort();
  if (!ids.length) return;
  const found = await client.query<{ id: string }>(
    "SELECT id FROM principals WHERE tenant_id=$1 AND id=ANY($2) AND active AND kind='human'",
    [tenantId, ids],
  );
  const active = new Set(found.rows.map((row) => row.id));
  const missing = actions.find((action) => !active.has(action.ownerId));
  if (missing)
    throw new DomainError(
      400,
      'action_owner_unavailable',
      `The owner of action ${missing.id} must be an active person in your organization`,
    );
}

/**
 * Checks an assurance draft and returns its links with a derived-from link to the report an investigation started
 * from. A revision keeps the type, and every closed action exactly as it was closed. Other kinds pass unchanged.
 */
export async function requireAssuranceDraft(
  client: PoolClient,
  tenantId: string,
  draft: SmsRecordDraft,
  previous?: { record: SmsRecordRow; body: AssuranceBody },
): Promise<SmsLink[] | undefined> {
  if (draft.kind !== 'assurance') return undefined;
  const body = draft.body;
  const { today } = await organizationDay(client, tenantId);
  const problems = assuranceBodyProblems(body, today);
  if (problems.length) throw new DomainError(400, 'invalid_assurance_record', problems[0]!, { problems });
  if (previous && previous.body.assuranceType !== body.assuranceType)
    throw new DomainError(400, 'assurance_type_fixed', 'A safety assurance record keeps the type it was opened with');
  if (previous) {
    const closed = await closedActions(client, tenantId, previous.record.id);
    for (const [id, closing] of closed) {
      const kept = body.actions.find((action) => action.id === id);
      const was = (closing.outcome as SmsActionCloseOutcome).action;
      if (!kept || canonicalDigest(actionFacts(kept)) !== canonicalDigest(was))
        throw new DomainError(400, 'closed_action_changed', `Action ${id} is closed; keep it as it was closed`);
    }
  }
  await requireActionOwners(client, tenantId, body.actions);
  if (!body.fromReport) return draft.links;
  const report = (
    await client.query<{ kind: string }>('SELECT kind FROM sms_records WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      body.fromReport,
    ])
  ).rows[0];
  if (report?.kind !== 'report')
    throw new DomainError(400, 'report_unavailable', 'The safety report was not found in your organization');
  const derived: SmsLink = { relation: 'derived_from', target: { kind: 'sms_record', id: body.fromReport } };
  const links = draft.links ?? [];
  return links.some((link) => link.target.kind === 'sms_record' && link.target.id === body.fromReport)
    ? links
    : [...links, derived];
}

function actionFacts(action: AssuranceAction): SmsActionCloseOutcome['action'] {
  return { what: action.what, ownerId: action.ownerId, dueOn: action.dueOn, findingId: action.findingId ?? null };
}

async function decisionsOf(client: PoolClient, tenantId: string, recordId: string, kind: string) {
  return (
    await client.query<{ record: SmsDecisionRecord }>(
      `SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND kind=$3
       AND record->>'version'='sms.decision.1' ORDER BY accepted_revision`,
      [tenantId, recordId, kind],
    )
  ).rows.map((row) => row.record);
}

/** The closing decision of each closed action, by action id. */
export async function closedActions(
  client: PoolClient,
  tenantId: string,
  recordId: string,
): Promise<Map<string, SmsDecisionRecord>> {
  const closes = await decisionsOf(client, tenantId, recordId, 'action.close');
  return new Map(closes.map((decision) => [(decision.outcome as SmsActionCloseOutcome).actionId, decision]));
}

/** A signed version of an assurance record: what its signature set. */
export interface SignedVersion {
  decisionId: string;
  versionNumber: number;
  bodyDigest: string;
  signedAt: string;
  body: AssuranceBody;
}

export async function signedVersions(client: PoolClient, tenantId: string, recordId: string): Promise<SignedVersion[]> {
  const signs = await decisionsOf(client, tenantId, recordId, 'assurance.sign');
  if (!signs.length) return [];
  const bodies = await client.query<{ version_number: number; body: AssuranceBody }>(
    'SELECT version_number,body FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2',
    [tenantId, recordId],
  );
  const byNumber = new Map(bodies.rows.map((row) => [row.version_number, row.body]));
  return signs.map((decision) => {
    const { assurance } = decision.outcome as SmsAssuranceSignOutcome;
    return {
      decisionId: decision.id,
      versionNumber: assurance.versionNumber,
      bodyDigest: assurance.bodyDigest,
      signedAt: decision.recordedAt,
      body: byNumber.get(assurance.versionNumber)!,
    };
  });
}

/** An action that a signature set, as it stands. */
export interface SettledAction {
  action: SmsActionCloseOutcome['action'] & { id: string };
  setIn: { versionNumber: number; bodyDigest: string };
  setAt: string;
  closed: SmsDecisionRecord | null;
}

/**
 * The actions set by signatures, oldest signature first: each is set by the first signed version listing it and
 * stands as the latest signed version holds it. One a later signed version no longer lists is gone, unless it was
 * closed; a closed one stands as it was closed.
 */
export function settledActions(signed: SignedVersion[], closes: Map<string, SmsDecisionRecord>): SettledAction[] {
  const first = new Map<string, SignedVersion>();
  for (const version of signed)
    for (const action of version.body.actions) if (!first.has(action.id)) first.set(action.id, version);
  const latest = signed.at(-1);
  const settled: SettledAction[] = [];
  for (const [id, setBy] of first) {
    const closing = closes.get(id) ?? null;
    const current = latest?.body.actions.find((action) => action.id === id);
    if (!closing && !current) continue;
    const facts = closing ? (closing.outcome as SmsActionCloseOutcome).action : actionFacts(current!);
    settled.push({
      action: { id, ...facts },
      setIn: closing
        ? (closing.outcome as SmsActionCloseOutcome).setIn
        : { versionNumber: setBy.versionNumber, bodyDigest: setBy.bodyDigest },
      setAt: setBy.signedAt,
      closed: closing,
    });
  }
  return settled;
}

/** What closing an action records: the action as the latest signature set it. */
export async function prepareActionClose(
  client: PoolClient,
  actor: AuthContext,
  record: SmsRecordRow,
  actionId: string,
): Promise<SmsActionCloseOutcome> {
  if (record.kind !== 'assurance')
    throw new DomainError(400, 'unsupported_decision', 'Only a safety assurance record has actions');
  const signed = await signedVersions(client, record.tenant_id, record.id);
  const closes = await closedActions(client, record.tenant_id, record.id);
  if (closes.has(actionId)) throw new DomainError(409, 'action_closed', `Action ${actionId} is already closed`);
  const settled = settledActions(signed, closes).find((entry) => entry.action.id === actionId);
  if (!settled)
    throw new DomainError(
      409,
      'action_not_set',
      `Action ${actionId} is not set: it is set when a version listing it is signed`,
    );
  if (actor.id !== settled.action.ownerId && actor.id !== record.owner_id)
    throw new DomainError(403, 'owner_required', 'Only the action’s owner or the record’s owner closes it');
  const { id, ...action } = settled.action;
  return { actionId: id, action, setIn: settled.setIn };
}

interface ActionRow {
  record_id: string;
  title: string;
  owner_id: string;
}

async function names(client: PoolClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await client.query<{ id: string; name: string }>(
    'SELECT id,name FROM principals WHERE tenant_id=$1 AND id=ANY($2)',
    [tenantId, [...new Set(ids)]],
  );
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}

const person = (directory: Map<string, string>, id: string): SmsPersonRef => ({ id, name: directory.get(id) ?? id });

/** An assurance record's actions and the hazards opened from it, as its page shows them. */
export async function assuranceView(
  client: PoolClient,
  principal: AuthContext,
  record: SmsRecordRow,
  current: AssuranceBody,
): Promise<SmsAssuranceView> {
  const signed = await signedVersions(client, record.tenant_id, record.id);
  const settled = settledActions(signed, await closedActions(client, record.tenant_id, record.id));
  const { today } = await organizationDay(client, record.tenant_id);
  const signedNow = record.status === 'signed';
  const proposed = signedNow
    ? []
    : current.actions.filter((action) => !settled.some((entry) => entry.action.id === action.id));
  const directory = await names(client, record.tenant_id, [
    ...settled.flatMap((entry) => [entry.action.ownerId, ...(entry.closed ? [entry.closed.actor.principalId] : [])]),
    ...proposed.map((action) => action.ownerId),
  ]);
  const canClose = (ownerId: string) =>
    !principal.capabilities.includes('sms:write') || !principal.capabilities.includes('decision:write')
      ? { available: false, reason: 'Closing an action needs permission to edit safety records and record decisions.' }
      : principal.id !== ownerId && principal.id !== record.owner_id
        ? { available: false, reason: 'The action’s owner or the record’s owner closes it.' }
        : { available: true };
  const hazards = await client.query<{
    origin: { item: SmsAssuranceView['hazards'][number]['item'] };
    id: string;
    title: string;
    status: string;
  }>(
    `SELECT o.origin,r.id,r.title,r.status FROM sms_hazard_origins o
     JOIN sms_records r ON r.tenant_id=o.tenant_id AND r.id=o.record_id
     WHERE o.tenant_id=$1 AND o.assurance_record_id=$2 ORDER BY o.recorded_at,o.id`,
    [record.tenant_id, record.id],
  );
  return {
    assuranceType: current.assuranceType,
    signedVersion: signed.at(-1)?.versionNumber ?? null,
    actions: [
      ...settled.map((entry) => ({
        id: entry.action.id,
        what: entry.action.what,
        owner: person(directory, entry.action.ownerId),
        dueOn: entry.action.dueOn,
        findingId: entry.action.findingId,
        state: entry.closed ? ('closed' as const) : ('open' as const),
        overdue: !entry.closed && entry.action.dueOn < today,
        setIn: entry.setIn.versionNumber,
        closed: entry.closed
          ? {
              decisionId: entry.closed.id,
              by: person(directory, entry.closed.actor.principalId),
              at: entry.closed.recordedAt,
              note: entry.closed.note,
            }
          : null,
        close: entry.closed ? { available: false, reason: 'This action is closed.' } : canClose(entry.action.ownerId),
      })),
      ...proposed.map((action) => ({
        id: action.id,
        what: action.what,
        owner: person(directory, action.ownerId),
        dueOn: action.dueOn,
        findingId: action.findingId ?? null,
        state: 'proposed' as const,
        overdue: false,
        setIn: null,
        closed: null,
        close: { available: false, reason: 'An action is set when a version listing it is signed.' },
      })),
    ],
    hazards: hazards.rows.map((row) => ({
      item: row.origin.item,
      record: { id: row.id, title: row.title, status: row.status },
    })),
  };
}

/** The type and the open and overdue action counts of each assurance record, by record id. */
export async function assuranceSummaries(
  client: PoolClient,
  tenantId: string,
  ids: string[],
): Promise<Map<string, SmsAssuranceSummary>> {
  if (!ids.length) return new Map();
  const { today } = await organizationDay(client, tenantId);
  const bodies = await client.query<{ id: string; body: AssuranceBody }>(
    `SELECT r.id,v.body FROM sms_records r
     JOIN sms_record_versions v ON v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=r.version_number
     WHERE r.tenant_id=$1 AND r.id=ANY($2) AND r.kind='assurance'`,
    [tenantId, ids],
  );
  const summaries = new Map<string, SmsAssuranceSummary>();
  for (const record of bodies.rows) {
    const open = settledActions(
      await signedVersions(client, tenantId, record.id),
      await closedActions(client, tenantId, record.id),
    ).filter((entry) => !entry.closed);
    summaries.set(record.id, {
      assuranceType: record.body.assuranceType,
      openActions: open.length,
      overdueActions: open.filter((entry) => entry.action.dueOn < today).length,
    });
  }
  return summaries;
}

/** An open action with what a person needs to find it. */
export interface OpenAction extends SmsAssuranceActionDue {
  owner: SmsPersonRef;
}

/**
 * The open actions due within `days` days of `today` or overdue, grouped by owner: owners with an overdue action
 * first, then by their earliest due date and name; each owner's actions by due date.
 */
export function actionsDueByOwner(
  actions: OpenAction[],
  today: string,
  days = 30,
): { owner: SmsPersonRef; actions: SmsAssuranceActionDue[] }[] {
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + days);
  const until = horizon.toISOString().slice(0, 10);
  const groups = new Map<string, { owner: SmsPersonRef; actions: SmsAssuranceActionDue[] }>();
  const due = actions
    .filter((action) => action.dueOn <= until)
    .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.recordTitle.localeCompare(b.recordTitle)));
  for (const { owner, ...action } of due) {
    const group = groups.get(owner.id) ?? { owner, actions: [] };
    group.actions.push({ ...action, overdue: action.dueOn < today });
    groups.set(owner.id, group);
  }
  return [...groups.values()].sort((a, b) => {
    const late = Number(b.actions[0]!.overdue) - Number(a.actions[0]!.overdue);
    if (late) return late;
    const first = a.actions[0]!.dueOn.localeCompare(b.actions[0]!.dueOn);
    return first || a.owner.name.localeCompare(b.owner.name);
  });
}

/** The Safety home's list: open actions of every signed assurance record due within 30 days or overdue, by owner. */
export async function assuranceActionsDue(
  client: PoolClient,
  tenantId: string,
): Promise<{ owner: SmsPersonRef; actions: SmsAssuranceActionDue[] }[]> {
  const records = await client.query<ActionRow & { body: AssuranceBody }>(
    `SELECT r.id AS record_id,r.title,r.owner_id,v.body FROM sms_records r
     JOIN sms_record_versions v ON v.tenant_id=r.tenant_id AND v.record_id=r.id AND v.version_number=r.version_number
     WHERE r.tenant_id=$1 AND r.kind='assurance'
       AND EXISTS(SELECT 1 FROM decisions d WHERE d.tenant_id=r.tenant_id AND d.subject_id=r.id AND d.kind='assurance.sign')`,
    [tenantId],
  );
  const open: (Omit<OpenAction, 'owner'> & { ownerId: string })[] = [];
  for (const record of records.rows) {
    const settled = settledActions(
      await signedVersions(client, tenantId, record.record_id),
      await closedActions(client, tenantId, record.record_id),
    );
    for (const entry of settled.filter((item) => !item.closed))
      open.push({
        recordId: record.record_id,
        recordTitle: record.title,
        assuranceType: record.body.assuranceType,
        actionId: entry.action.id,
        what: entry.action.what,
        dueOn: entry.action.dueOn,
        overdue: false,
        ownerId: entry.action.ownerId,
      });
  }
  const directory = await names(
    client,
    tenantId,
    open.map((action) => action.ownerId),
  );
  const { today } = await organizationDay(client, tenantId);
  return actionsDueByOwner(
    open.map(({ ownerId, ...action }) => ({ ...action, owner: person(directory, ownerId) })),
    today,
  );
}

/** The plain words for an assurance record's type. */
export function assuranceTitle(body: AssuranceBody): string {
  return assuranceTypes[body.assuranceType].title;
}
