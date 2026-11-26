import { receiptToKeep, type OutboxEntry, type OutboxReceipt, type OutboxStore } from './outbox.js';

// The outbox in the browser's own database for this site (IndexedDB). It is not encrypted: anyone who can open this
// browser profile can read it, and the app says so where entries are listed.

const DATABASE = 'ledger-outbox';
const ENTRIES = 'entries';
const RECEIPTS = 'receipts';
/** Tells the other tabs of this site that the outbox changed, so each shows the same count. */
export const OUTBOX_CHANNEL = 'ledger-outbox';

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    // Entries carry their own format; a later version adds stores or reads new formats, never drops these.
    if (!database.objectStoreNames.contains(ENTRIES)) database.createObjectStore(ENTRIES, { keyPath: 'id' });
    if (!database.objectStoreNames.contains(RECEIPTS)) database.createObjectStore(RECEIPTS, { keyPath: 'id' });
  };
  return done(request);
}

/** The outbox kept in this browser, or undefined where the browser keeps no database (a private window may not). */
export function browserStore(): OutboxStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  let database: Promise<IDBDatabase> | null = null;
  const changed = () => {
    try {
      const channel = new BroadcastChannel(OUTBOX_CHANNEL);
      channel.postMessage('changed');
      channel.close();
    } catch {
      // A browser without BroadcastChannel shows other tabs' changes on their next read.
    }
  };
  async function run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    database ??= open().catch((error: unknown) => {
      database = null;
      throw error;
    });
    const transaction = (await database).transaction(stores, mode);
    const request = work(transaction);
    const finished = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    const result = request ? await done(request) : undefined;
    await finished;
    if (mode === 'readwrite') changed();
    return result;
  }
  const all = async (store: string) =>
    ((await run(store === ENTRIES ? [ENTRIES] : [RECEIPTS], 'readonly', (transaction) =>
      transaction.objectStore(store).getAll(),
    )) ?? []) as unknown[];
  return {
    entries: () => all(ENTRIES),
    receipts: () => all(RECEIPTS),
    put: async (entry: OutboxEntry) => {
      await run([ENTRIES], 'readwrite', (transaction) => void transaction.objectStore(ENTRIES).put(entry));
    },
    remove: async (id: string) => {
      await run([ENTRIES], 'readwrite', (transaction) => void transaction.objectStore(ENTRIES).delete(id));
    },
    acknowledge: async (id: string, receipt: OutboxReceipt) => {
      await run([ENTRIES, RECEIPTS], 'readwrite', (transaction) => {
        transaction.objectStore(ENTRIES).delete(id);
        const receipts = transaction.objectStore(RECEIPTS);
        const existing = receipts.get(receipt.id);
        existing.onsuccess = () => receipts.put(receiptToKeep(existing.result, receipt));
      });
    },
    removeReceipt: async (id: string) => {
      await run([RECEIPTS], 'readwrite', (transaction) => void transaction.objectStore(RECEIPTS).delete(id));
    },
  };
}
