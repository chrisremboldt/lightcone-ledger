import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import type { OperatorRecordCommitResponse, SafetyReportReceipt, SignedInSafetyReport } from '@ledger/contracts';
import type { RecordDraft } from './operator-records.js';

// Entries kept on the device until Ledger acknowledges them (docs/design/offline-entry.md). Nothing here touches the
// browser: the store is given, so the rules are the same in the page and in a test.

/** The format of what this version stores. A later version reads this one; it never drops one it cannot read. */
export const OUTBOX_FORMAT = 1;

/** The person signed in when an entry was written: it is sent only under their sign-in, to their organization. */
export interface EntryOwner {
  principalId: string;
  tenantId: string;
  name: string;
}

export interface RecordEntryContent {
  kind: 'record';
  /** The record type's title and the subject, as the list of waiting entries names the entry. */
  title: string;
  subject: string;
  recordType: string;
  recordVersion: number;
  sourceId: string;
  /** The exact JSON document sent, every time: the same bytes under the same key are one record. */
  document: string;
  /** What the person typed, to correct the entry after a refusal. */
  draft: RecordDraft;
  replaces?: string;
}

/** What a person typed in the report form, kept to correct the entry after a refusal. */
export interface ReportEntryDraft {
  whatWasSeen: string;
  occurredAt: string;
  where: string;
  contact: string;
  named: boolean;
}

export interface ReportEntryContent {
  kind: 'report';
  /** The request body sent, every time. */
  report: SignedInSafetyReport;
  draft: ReportEntryDraft;
}

export type EntryContent = RecordEntryContent | ReportEntryContent;

export type EntryState = { status: 'waiting' } | { status: 'refused'; reasons: string[] };

export interface OutboxEntry {
  format: typeof OUTBOX_FORMAT;
  /** Made by the device when the entry is first saved; it names the entry on this device. */
  id: string;
  /** The idempotency key the entry is sent with. It changes only when its content changes after Ledger refused it. */
  key: string;
  owner: EntryOwner;
  /** When it was written, by this device's clock. */
  writtenAt: string;
  state: EntryState;
  content: EntryContent;
}

/** What may remain once Ledger has an entry: never its content. */
export interface OutboxReceipt {
  format: typeof OUTBOX_FORMAT;
  id: string;
  owner: EntryOwner;
  kind: EntryContent['kind'];
  /** What the entry was, in words that hold none of its content: "Flight record for FLIGHT-07", "Safety report". */
  title: string;
  /** The record's Ledger id, or a report's receipt code; absent when Ledger's first answer did not reach the device. */
  reference?: string;
  writtenAt: string;
  /** When the device had Ledger's answer, by this device's clock. */
  answeredAt: string;
}

/** The store: the browser's database in the page, a map in a test. */
export interface OutboxStore {
  entries(): Promise<unknown[]>;
  receipts(): Promise<unknown[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes the entry and keeps its receipt, together: the content goes first, before anything else is done. */
  acknowledge(id: string, receipt: OutboxReceipt): Promise<void>;
  removeReceipt(id: string): Promise<void>;
}

/**
 * The receipt to keep when an entry is acknowledged. Sent twice at once (two tabs, or a retry beside a save), the later
 * answer may say only that Ledger already has it: the receipt the first answer gave, with its reference, stays. A store
 * applies this inside the write that keeps the receipt.
 */
export function receiptToKeep(stored: unknown, incoming: OutboxReceipt): OutboxReceipt {
  const kept = readReceipt(stored);
  return kept?.reference && !incoming.reference ? kept : incoming;
}

/** A stored value this version cannot read: kept, counted, never sent and never discarded on its own. */
export interface UnreadEntry {
  unread: true;
  value: unknown;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function readOwner(value: unknown): EntryOwner | undefined {
  const owner = value as Partial<EntryOwner> | null;
  return owner && isText(owner.principalId) && isText(owner.tenantId) && typeof owner.name === 'string'
    ? { principalId: owner.principalId, tenantId: owner.tenantId, name: owner.name }
    : undefined;
}

function readContent(value: unknown): EntryContent | undefined {
  const content = value as
    (Partial<Omit<RecordEntryContent, 'kind'>> & Partial<Omit<ReportEntryContent, 'kind'>> & { kind?: unknown }) | null;
  if (content?.kind === 'record')
    return isText(content.document) &&
      isText(content.recordType) &&
      typeof content.recordVersion === 'number' &&
      isText(content.sourceId)
      ? (content as unknown as RecordEntryContent)
      : undefined;
  if (content?.kind === 'report')
    return content.report && typeof content.report.whatWasSeen === 'string'
      ? (content as unknown as ReportEntryContent)
      : undefined;
  return undefined;
}

/** A stored entry as this version reads it. A field a later version may add is ignored; a missing state is waiting. */
export function readEntry(value: unknown): OutboxEntry | UnreadEntry {
  const stored = value as Partial<OutboxEntry> | null;
  const owner = readOwner(stored?.owner);
  const content = readContent(stored?.content);
  if (stored?.format !== OUTBOX_FORMAT || !isText(stored.id) || !owner || !content || !isText(stored.writtenAt))
    return { unread: true, value };
  const state: EntryState =
    stored.state?.status === 'refused'
      ? { status: 'refused', reasons: [...(stored.state.reasons ?? [])].map(String) }
      : { status: 'waiting' };
  return {
    format: OUTBOX_FORMAT,
    id: stored.id,
    key: isText(stored.key) ? stored.key : stored.id,
    owner,
    writtenAt: stored.writtenAt,
    state,
    content,
  };
}

export function readReceipt(value: unknown): OutboxReceipt | undefined {
  const stored = value as Partial<OutboxReceipt> | null;
  const owner = readOwner(stored?.owner);
  if (stored?.format !== OUTBOX_FORMAT || !isText(stored.id) || !owner || !isText(stored.title)) return undefined;
  return {
    format: OUTBOX_FORMAT,
    id: stored.id,
    owner,
    kind: stored.kind === 'report' ? 'report' : 'record',
    title: stored.title,
    ...(isText(stored.reference) ? { reference: stored.reference } : {}),
    writtenAt: String(stored.writtenAt ?? ''),
    answeredAt: String(stored.answeredAt ?? ''),
  };
}

const newId = () => globalThis.crypto.randomUUID();

/** A new entry, when its form is first saved: the device makes its id and its key now. */
export function newEntry(
  owner: EntryOwner,
  content: EntryContent,
  writtenAt = new Date().toISOString(),
  id = newId(),
): OutboxEntry {
  return { format: OUTBOX_FORMAT, id, key: id, owner, writtenAt, state: { status: 'waiting' }, content };
}

/** A refused entry corrected: new content, written now, under a new key, since nothing was recorded under the old. */
export function revisedEntry(
  entry: OutboxEntry,
  content: EntryContent,
  writtenAt = new Date().toISOString(),
): OutboxEntry {
  return { ...entry, key: newId(), writtenAt, state: { status: 'waiting' }, content };
}

const samePerson = (owner: EntryOwner, person: EntryOwner) =>
  owner.principalId === person.principalId && owner.tenantId === person.tenantId;

/**
 * What the person signed in may see of what waits on the device: their own entries and receipts in full, and only how
 * many entries are another person's or were stored by a version this one cannot read.
 */
export function shownTo(
  stored: { entries: readonly (OutboxEntry | UnreadEntry)[]; receipts: readonly OutboxReceipt[] },
  person: EntryOwner | null,
): { own: OutboxEntry[]; receipts: OutboxReceipt[]; others: number; unread: number } {
  const readable = stored.entries.filter((entry): entry is OutboxEntry => !('unread' in entry));
  const own = person ? readable.filter((entry) => samePerson(entry.owner, person)) : [];
  return {
    own: own.sort((left, right) => left.writtenAt.localeCompare(right.writtenAt)),
    receipts: person ? stored.receipts.filter((receipt) => samePerson(receipt.owner, person)) : [],
    others: readable.length - own.length,
    unread: stored.entries.length - readable.length,
  };
}

/** The entries to send now: the person's own that are waiting. Another person's are never sent under this sign-in. */
export function toSend(entries: readonly (OutboxEntry | UnreadEntry)[], person: EntryOwner): OutboxEntry[] {
  return shownTo({ entries, receipts: [] }, person).own.filter((entry) => entry.state.status === 'waiting');
}

export type SendOutcome =
  | { kind: 'acknowledged'; receipt: OutboxReceipt; recorded?: OperatorRecordCommitResponse }
  | { kind: 'refused'; reasons: string[] }
  /** Ledger said nothing about the entry: no connection, a busy or failing server, or the sign-in ended. */
  | { kind: 'waiting'; reason: string }
  /** An upload left unfinished expired; nothing can have been recorded under the key, so a new one is safe. */
  | { kind: 'new_key' };

/** Ledger's answer when it is not a success; read by shape, since a test may load a second copy of the client. */
function answered(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  const shaped = error as Partial<ApiError> | null;
  return typeof shaped?.status === 'number' && shaped instanceof Error && 'body' in shaped
    ? (shaped as ApiError)
    : undefined;
}

/** What an answer that is not a success means for the entry. */
function outcomeOfFailure(failure: unknown, entry: OutboxEntry, answeredAt: string): SendOutcome {
  const error = answered(failure);
  if (!error) return { kind: 'waiting', reason: 'Ledger cannot be reached.' };
  const { code, message } = (error.body as { error?: { code?: string; message?: string } } | null)?.error ?? {};
  if (error.status === 401) return { kind: 'waiting', reason: 'Your sign-in has ended. Sign in again to send it.' };
  if (error.status === 408 || error.status === 429 || error.status >= 500)
    return { kind: 'waiting', reason: message ?? 'Ledger could not take it right now.' };
  if (error.status === 410 && code === 'upload_expired') return { kind: 'new_key' };
  if (entry.content.kind === 'report' && code === 'safety_report_already_received')
    return { kind: 'acknowledged', receipt: receiptOf(entry, answeredAt) };
  return { kind: 'refused', reasons: [message ?? `Ledger refused it (${error.status}).`] };
}

function titleOf(content: EntryContent): string {
  return content.kind === 'report' ? 'Safety report' : `${content.title} for ${content.subject}`;
}

function receiptOf(entry: OutboxEntry, answeredAt: string, reference?: string): OutboxReceipt {
  return {
    format: OUTBOX_FORMAT,
    id: entry.id,
    owner: entry.owner,
    kind: entry.content.kind,
    title: titleOf(entry.content),
    ...(reference ? { reference } : {}),
    writtenAt: entry.writtenAt,
    answeredAt,
  };
}

/** Sends one entry, as its owner, under its key. The caller has checked that its owner is the person signed in. */
export async function sendEntry(
  client: LedgerClient,
  entry: OutboxEntry,
  now: () => string = () => new Date().toISOString(),
): Promise<SendOutcome> {
  const content = entry.content;
  try {
    if (content.kind === 'report') {
      const answer = await client.request<SafetyReportReceipt>(
        '/v1/safety-reports',
        { method: 'POST', body: JSON.stringify(content.report) },
        entry.key,
      );
      return { kind: 'acknowledged', receipt: receiptOf(entry, now(), answer.receipt.code) };
    }
    const bytes = new TextEncoder().encode(content.document);
    const { artifact } = await client.upload(bytes, 'application/json', entry.key);
    const result = await client.request<OperatorRecordCommitResponse>('/v1/operator-records/imports', {
      method: 'POST',
      body: JSON.stringify({
        artifactId: artifact.id,
        recordType: content.recordType,
        recordVersion: content.recordVersion,
        sourceId: content.sourceId,
      }),
    });
    const row = result.rows[0];
    // Committing the same file again records nothing and names the record it made the first time.
    if ((row?.status === 'recorded' || row?.status === 'already_recorded') && row.observationId)
      return { kind: 'acknowledged', receipt: receiptOf(entry, now(), row.observationId), recorded: result };
    return { kind: 'refused', reasons: row?.reasons.length ? [...row.reasons] : ['The record was not recorded.'] };
  } catch (error) {
    return outcomeOfFailure(error, entry, now());
  }
}

/** What became of an entry sent: Ledger has it, refused it, or said nothing about it yet. */
export type Delivered = Exclude<SendOutcome, { kind: 'new_key' }>;

/** Sends an entry and keeps what its answer means: removed on acknowledgement, marked when refused, else waiting. */
export async function deliver(
  store: OutboxStore,
  client: LedgerClient,
  entry: OutboxEntry,
  now?: () => string,
): Promise<Delivered> {
  let current = entry;
  let sent = await sendEntry(client, current, now);
  if (sent.kind === 'new_key') {
    current = { ...entry, key: newId() };
    await store.put(current);
    sent = await sendEntry(client, current, now);
  }
  const outcome: Delivered =
    sent.kind === 'new_key' ? { kind: 'waiting', reason: 'Ledger could not take it right now.' } : sent;
  if (outcome.kind === 'acknowledged') await store.acknowledge(entry.id, outcome.receipt);
  else if (outcome.kind === 'refused')
    await store.put({ ...current, state: { status: 'refused', reasons: outcome.reasons } });
  return outcome;
}

/**
 * Sends the person's waiting entries, oldest first, and stops at the first that Ledger said nothing about: the next
 * would meet the same connection.
 */
export async function sendWaiting(
  store: OutboxStore,
  client: LedgerClient,
  person: EntryOwner,
  busy: Set<string> = new Set(),
): Promise<{ sent: number; refused: number; waiting: number }> {
  const counts = { sent: 0, refused: 0, waiting: 0 };
  const entries = toSend((await store.entries()).map(readEntry), person);
  for (const [index, entry] of entries.entries()) {
    if (busy.has(entry.id)) continue;
    // Sent meanwhile by another tab or by the form itself: nothing is left to send.
    if (!(await store.entries()).some((stored) => (stored as { id?: unknown } | null)?.id === entry.id)) continue;
    busy.add(entry.id);
    try {
      const outcome = await deliver(store, client, entry);
      if (outcome.kind === 'acknowledged') counts.sent++;
      else if (outcome.kind === 'refused') counts.refused++;
      else {
        counts.waiting += entries.length - index;
        break;
      }
    } finally {
      busy.delete(entry.id);
    }
  }
  return counts;
}

/** A store in memory: for a test, and for a session that keeps nothing on the device. */
export function memoryStore(): OutboxStore & { stored: Map<string, unknown>; kept: Map<string, unknown> } {
  const stored = new Map<string, unknown>();
  const kept = new Map<string, unknown>();
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    stored,
    kept,
    entries: async () => [...stored.values()].map(copy),
    receipts: async () => [...kept.values()].map(copy),
    put: async (entry) => void stored.set(entry.id, copy(entry)),
    remove: async (id) => void stored.delete(id),
    acknowledge: async (id, receipt) => {
      stored.delete(id);
      kept.set(receipt.id, copy(receiptToKeep(kept.get(receipt.id), receipt)));
    },
    removeReceipt: async (id) => void kept.delete(id),
  };
}
