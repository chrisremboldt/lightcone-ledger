import React from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import { Button, Notice } from '@ledger/ui';
import {
  deliver,
  newEntry,
  readEntry,
  readReceipt,
  revisedEntry,
  sendWaiting,
  shownTo,
  type EntryContent,
  type EntryOwner,
  type OutboxEntry,
  type OutboxReceipt,
  type OutboxStore,
  type Delivered,
} from './outbox.js';
import { browserStore, OUTBOX_CHANNEL } from './outbox-store.js';
import { time, timeZoneLabel } from './format.js';

// The entries a signed-in person made on this device and Ledger does not have yet (docs/design/offline-entry.md).

/** How often waiting entries are tried again while the page is open. */
const RETRY_MS = 30_000;

type Shown = ReturnType<typeof shownTo>;

/** The demonstration, and a recorded or replayed scene, keep nothing on the device. */
function keepsNothing(): boolean {
  return (
    import.meta.env.VITE_LEDGER_ENV === 'demo' ||
    (import.meta.env.DEV && /[?&](record|replay)=1(&|$)/.test(window.location.search))
  );
}

export interface Outbox {
  person: EntryOwner;
  shown: Shown;
  /**
   * Keeps an entry on the device, then sends it at once. `content` is given the time it is written, which the entry
   * states; `revising` is a refused entry being corrected.
   */
  save(
    content: (writtenAt: string) => EntryContent,
    revising?: OutboxEntry,
  ): Promise<{ entry: OutboxEntry; outcome: Delivered }>;
  sendNow(): Promise<void>;
  discard(id: string): Promise<void>;
  removeReceipt(id: string): Promise<void>;
  /** Whether the last attempt reached Ledger; false after one that could not. */
  reached: boolean;
}

const OutboxContext = React.createContext<Outbox | null>(null);

/** The outbox of the person signed in; null where entries are sent directly (a recording, or no person read yet). */
export const useOutbox = () => React.useContext(OutboxContext);

const nothing: Shown = { own: [], receipts: [], others: 0, unread: 0 };

async function read(store: OutboxStore, person: EntryOwner | null): Promise<Shown> {
  const [entries, receipts] = await Promise.all([store.entries(), store.receipts()]);
  return shownTo(
    {
      entries: entries.map(readEntry),
      receipts: receipts.map(readReceipt).filter((receipt): receipt is OutboxReceipt => Boolean(receipt)),
    },
    person,
  );
}

/** Re-reads the outbox when this tab or another changes it. */
function useOutboxChanges(onChange: () => void) {
  React.useEffect(() => {
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(OUTBOX_CHANNEL);
      channel.onmessage = onChange;
    } catch {
      channel = undefined;
    }
    return () => channel?.close();
  }, [onChange]);
}

export function OutboxProvider({
  client,
  person,
  store: given,
  children,
}: {
  client: LedgerClient;
  person: EntryOwner | null;
  store?: OutboxStore;
  children: React.ReactNode;
}) {
  const [store] = React.useState(() => given ?? (keepsNothing() ? undefined : browserStore()));
  const [shown, setShown] = React.useState<Shown>(nothing);
  const [reached, setReached] = React.useState(true);
  const busy = React.useRef(new Set<string>());
  const refresh = React.useCallback(() => {
    if (store) void read(store, person).then(setShown, () => undefined);
  }, [store, person]);
  useOutboxChanges(refresh);
  const sendNow = React.useCallback(async () => {
    if (!store || !person) return;
    const counts = await sendWaiting(store, client, person, busy.current).catch(() => null);
    if (counts) setReached(counts.waiting === 0);
    refresh();
  }, [store, person, client, refresh]);
  const waiting = shown.own.some((entry) => entry.state.status === 'waiting');
  React.useEffect(() => {
    refresh();
    void sendNow();
    const online = () => void sendNow();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [refresh, sendNow]);
  React.useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void sendNow(), RETRY_MS);
    return () => window.clearInterval(timer);
  }, [waiting, sendNow]);
  const outbox = React.useMemo<Outbox | null>(
    () =>
      store && person
        ? {
            person,
            shown,
            reached,
            sendNow,
            async save(content, revising) {
              const writtenAt = new Date().toISOString();
              const made = content(writtenAt);
              const entry = revising ? revisedEntry(revising, made, writtenAt) : newEntry(person, made, writtenAt);
              await store.put(entry);
              busy.current.add(entry.id);
              try {
                const outcome = await deliver(store, client, entry);
                setReached(outcome.kind !== 'waiting');
                // Ledger's answer is shown to the person right here, so the device keeps no receipt of it.
                if (outcome.kind === 'acknowledged') await store.removeReceipt(entry.id);
                return { entry, outcome };
              } finally {
                busy.current.delete(entry.id);
                refresh();
              }
            },
            async discard(id) {
              // Only the person's own entry: another person's is never shown, so never offered.
              const stored = await read(store, person);
              if (!stored.own.some((entry) => entry.id === id)) return;
              await store.remove(id);
              refresh();
            },
            async removeReceipt(id) {
              const stored = await read(store, person);
              if (!stored.receipts.some((receipt) => receipt.id === id)) return;
              await store.removeReceipt(id);
              refresh();
            },
          }
        : null,
    [store, person, shown, reached, sendNow, client, refresh],
  );
  return <OutboxContext.Provider value={outbox}>{children}</OutboxContext.Provider>;
}

const written = (value: string) => `${time(value, true)} ${timeZoneLabel()}`;

/**
 * Where a person saves a form: how many of their entries wait on this device, a list of them to see, send or discard,
 * and only a count of anyone else's. `onCorrect` takes a refused entry of the kind this form makes.
 */
export function OutboxSummary({
  kind,
  onCorrect,
}: {
  kind: EntryContent['kind'];
  onCorrect?: (entry: OutboxEntry) => void;
}) {
  const outbox = useOutbox();
  const [open, setOpen] = React.useState(false);
  if (!outbox) return null;
  const { own, receipts, others, unread } = outbox.shown;
  if (!own.length && !receipts.length && !others && !unread) return null;
  const refused = own.filter((entry) => entry.state.status === 'refused').length;
  return (
    <section className="outbox" aria-label="Kept on this device">
      {own.length > 0 && (
        <p className="records-note" data-testid="outbox-count">
          {own.length === 1 ? '1 of your entries waits' : `${own.length} of your entries wait`} on this device to be
          sent{refused ? `; Ledger refused ${refused === 1 ? 'one' : refused}` : ''}.
          {!outbox.reached && ' Ledger cannot be reached now; they are sent when the connection returns.'}
        </p>
      )}
      {others > 0 && (
        <p className="records-note" data-testid="outbox-others">
          Entries of another person wait on this device. They are sent only when that person signs in, and are not shown
          here.
        </p>
      )}
      {unread > 0 && (
        <p className="records-note">
          {unread === 1 ? 'An entry was' : `${unread} entries were`} kept by another version of Ledger. They stay on
          this device.
        </p>
      )}
      {(own.length > 0 || receipts.length > 0) && (
        <Button type="button" kind="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide what is kept on this device' : 'Show what is kept on this device'}
        </Button>
      )}
      {open && <OutboxList kind={kind} outbox={outbox} onCorrect={onCorrect} />}
    </section>
  );
}

function OutboxList({
  kind,
  outbox,
  onCorrect,
}: {
  kind: EntryContent['kind'];
  outbox: Outbox;
  onCorrect?: (entry: OutboxEntry) => void;
}) {
  const [discarding, setDiscarding] = React.useState<string | null>(null);
  const { own, receipts } = outbox.shown;
  return (
    <div className="outbox-list">
      <p className="records-note">
        Kept in this browser’s own storage for this site until Ledger has it. Ledger does not encrypt it: anyone who can
        open this browser on this device can read it.
      </p>
      {own.length > 0 && <h4>Not in Ledger yet</h4>}
      {own.length > 0 && (
        <ul aria-label="Not in Ledger yet">
          {own.map((entry) => (
            <li key={entry.id} data-testid="outbox-entry">
              <strong>{entry.content.kind === 'report' ? 'Safety report' : entryTitle(entry)}</strong>
              <p className="outbox-line">Written {written(entry.writtenAt)}, by this device’s clock.</p>
              {entry.state.status === 'refused' ? (
                <Notice tone="alert" title="Ledger refused it">
                  <ul className="records-reasons">
                    {entry.state.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </Notice>
              ) : (
                <p className="outbox-line">Waiting to be sent.</p>
              )}
              <div className="records-actions">
                {entry.state.status === 'refused' && entry.content.kind === kind && onCorrect && (
                  <Button type="button" onClick={() => onCorrect(entry)}>
                    Correct
                  </Button>
                )}
                {discarding === entry.id ? (
                  <>
                    <Button
                      type="button"
                      kind="primary"
                      onClick={() => void outbox.discard(entry.id).then(() => setDiscarding(null))}
                    >
                      Discard entry
                    </Button>
                    <Button type="button" kind="quiet" onClick={() => setDiscarding(null)}>
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button type="button" kind="quiet" onClick={() => setDiscarding(entry.id)}>
                    Discard
                  </Button>
                )}
              </div>
              {discarding === entry.id && (
                <p className="records-note">Ledger does not have it. Once discarded it cannot be brought back.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {own.some((entry) => entry.state.status === 'waiting') && (
        <Button type="button" onClick={() => void outbox.sendNow()}>
          Send now
        </Button>
      )}
      {receipts.length > 0 && <h4>Sent from this device</h4>}
      {receipts.length > 0 && (
        <ul aria-label="Sent from this device">
          {receipts.map((receipt) => (
            <li key={receipt.id} data-testid="outbox-receipt">
              <strong>{receipt.title}</strong>
              <p className="outbox-line">
                Written {written(receipt.writtenAt)}; Ledger’s answer reached this device {written(receipt.answeredAt)},
                both by this device’s clock.
              </p>
              <p className="outbox-line">
                {receipt.kind === 'report' ? (
                  receipt.reference ? (
                    <>
                      Received. Receipt code <code>{receipt.reference}</code>: write it down, Ledger keeps no copy it
                      can show again.
                    </>
                  ) : (
                    'Received. Its receipt code was in an answer this device did not get, and Ledger cannot show it again.'
                  )
                ) : (
                  <>
                    Recorded as record <code>{receipt.reference}</code>.
                  </>
                )}
              </p>
              <Button type="button" kind="quiet" onClick={() => void outbox.removeReceipt(receipt.id)}>
                Remove from this device
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function entryTitle(entry: OutboxEntry): string {
  return entry.content.kind === 'record' ? `${entry.content.title} for ${entry.content.subject}` : 'Safety report';
}

/**
 * On the sign-in screen: how many entries wait on this device, and that they are sent once the person who wrote them
 * signs in again. Nothing of what they say, nor whose they are.
 */
export function WaitingOnDevice() {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    // Not on a page opened by a link someone was given: such a page says nothing about this device.
    const linked = ['/report', '/shared'].includes(window.location.pathname);
    const store = keepsNothing() || linked ? undefined : browserStore();
    let stopped = false;
    if (store)
      void store.entries().then(
        (entries) => !stopped && setCount(entries.length),
        () => undefined,
      );
    return () => {
      stopped = true;
    };
  }, []);
  if (!count) return null;
  return (
    <p className="gate-note" data-testid="outbox-waiting-signed-out">
      {count === 1
        ? 'An entry made on this device waits to be sent. It is sent once the person who wrote it signs in again.'
        : `${count} entries made on this device wait to be sent. They are sent once the person who wrote them signs in again.`}
    </p>
  );
}
