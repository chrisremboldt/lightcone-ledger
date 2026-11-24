import { createHash } from 'node:crypto';
import { lockPrivateJournal, readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

export interface AdoptionAction {
  key: string;
  payload: string;
  payloadSha256: string;
  status: 'submitted' | 'accepted' | 'rejected';
  adoptionId?: string;
  rejection?: { status: number; code: string };
}

export interface ActionJournal {
  version: 1;
  planDigest: string;
  principalId: string;
  tenantId: string;
  endpoint: string;
  actions: AdoptionAction[];
}

const maxJournalBytes = 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = (): never => {
  throw new Error('Pack adoption journal commitment is invalid; refusing to reset the action');
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validateJournal(value: unknown): ActionJournal {
  const journal = object(value);
  if (
    !exactKeys(journal, ['version', 'planDigest', 'principalId', 'tenantId', 'endpoint', 'actions']) ||
    journal.version !== 1 ||
    !digest(journal.planDigest) ||
    !id(journal.principalId) ||
    !id(journal.tenantId) ||
    journal.endpoint !== '/v1/commands' ||
    !Array.isArray(journal.actions) ||
    journal.actions.length > 16
  )
    return invalid();
  const keys = new Set<string>();
  for (const entry of journal.actions) {
    const action = object(entry);
    if (
      !exactKeys(action, ['key', 'payload', 'payloadSha256', 'status', 'adoptionId', 'rejection']) ||
      !id(action.key) ||
      keys.has(action.key) ||
      typeof action.payload !== 'string' ||
      !digest(action.payloadSha256) ||
      hash(action.payload) !== action.payloadSha256 ||
      !['submitted', 'accepted', 'rejected'].includes(String(action.status)) ||
      (action.adoptionId !== undefined && !id(action.adoptionId))
    )
      return invalid();
    keys.add(action.key);
    const payload = object(JSON.parse(action.payload));
    if (
      payload.kind !== 'rule-pack.adopt' ||
      !exactKeys(payload, [
        'kind',
        'expectedRevision',
        'inputCut',
        'expectedDependencyBasis',
        'pack',
        'effectiveInterval',
        'note',
        'mode',
      ])
    )
      return invalid();
    if (action.rejection !== undefined) {
      const rejection = object(action.rejection);
      if (
        !exactKeys(rejection, ['status', 'code']) ||
        !Number.isSafeInteger(rejection.status) ||
        Number(rejection.status) < 400 ||
        Number(rejection.status) > 599 ||
        !id(rejection.code)
      )
        return invalid();
    }
  }
  return journal as unknown as ActionJournal;
}

export async function readAdoptionJournal(path: string): Promise<ActionJournal | undefined> {
  try {
    const value = await readJournalEnvelope(path, maxJournalBytes);
    return value === undefined ? undefined : validateJournal(value);
  } catch {
    return invalid();
  }
}

export async function saveAdoptionJournal(path: string, journal: ActionJournal): Promise<void> {
  validateJournal(journal);
  await writeJournalEnvelope(path, journal, maxJournalBytes);
}

export async function lockAdoptionJournal(path: string): Promise<() => Promise<void>> {
  return lockPrivateJournal(path, 'Pack adoption');
}
