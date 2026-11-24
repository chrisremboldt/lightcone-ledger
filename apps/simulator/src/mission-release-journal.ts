import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  MissionReleaseAcceptedCommandSchema,
  MissionReleaseCommandSchema,
  type MissionReleaseCommandResponse,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { lockPrivateJournal, readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

export interface MissionReleaseAction {
  key: string;
  payload: string;
  payloadSha256: string;
  status: 'submitted' | 'accepted' | 'rejected';
  accepted?: MissionReleaseCommandResponse['command'];
  rejection?: { status: number; code: string };
}

export interface MissionReleaseJournal {
  version: 1;
  kind: 'mission-release-action';
  planDigest: string;
  principalId: string;
  tenantId: string;
  endpoint: '/v1/commands';
  actions: MissionReleaseAction[];
}

const validator = new Ajv({ strict: false, strictNumbers: true });
const installFormats = addFormats as unknown as (instance: Ajv) => void;
installFormats(validator);
const validateCommand = validator.compile(MissionReleaseCommandSchema);
const validateAccepted = validator.compile(MissionReleaseAcceptedCommandSchema);
const maxBytes = 1024 * 1024;

function invalid(): never {
  throw new Error('Mission release journal commitment is invalid; refusing to reset the action');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}

const id = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validateJournal(value: unknown): MissionReleaseJournal {
  const journal = object(value);
  keys(journal, ['version', 'kind', 'planDigest', 'principalId', 'tenantId', 'endpoint', 'actions']);
  if (
    journal.version !== 1 ||
    journal.kind !== 'mission-release-action' ||
    !digest(journal.planDigest) ||
    !id(journal.principalId) ||
    !id(journal.tenantId) ||
    journal.endpoint !== '/v1/commands' ||
    !Array.isArray(journal.actions) ||
    journal.actions.length > 1
  )
    return invalid();
  for (const entry of journal.actions) {
    const action = object(entry);
    keys(action, ['key', 'payload', 'payloadSha256', 'status'], ['accepted', 'rejection']);
    if (
      !id(action.key) ||
      typeof action.payload !== 'string' ||
      !digest(action.payloadSha256) ||
      sha256(action.payload) !== action.payloadSha256 ||
      !['submitted', 'accepted', 'rejected'].includes(String(action.status))
    )
      return invalid();
    const payload = JSON.parse(action.payload) as unknown;
    if (!validateCommand(payload)) return invalid();
    if (action.accepted !== undefined) {
      if (!validateAccepted(action.accepted)) return invalid();
      const accepted = object(action.accepted);
      if (
        accepted.actorId !== journal.principalId ||
        accepted.flightId !== object(payload).flightId ||
        canonicalDigest(accepted.payload) !== canonicalDigest(payload)
      )
        return invalid();
    }
    if (action.rejection !== undefined) {
      const rejection = object(action.rejection);
      keys(rejection, ['status', 'code']);
      if (
        !Number.isSafeInteger(rejection.status) ||
        Number(rejection.status) < 400 ||
        Number(rejection.status) >= 500 ||
        [401, 403, 404, 408, 425, 429].includes(Number(rejection.status)) ||
        typeof rejection.code !== 'string' ||
        !/^[a-z][a-z0-9_]{0,99}$/.test(rejection.code)
      )
        return invalid();
    }
    if (
      (action.status === 'submitted' && (action.accepted !== undefined || action.rejection !== undefined)) ||
      (action.status === 'accepted' && (action.accepted === undefined || action.rejection !== undefined)) ||
      (action.status === 'rejected' && (action.rejection === undefined || action.accepted !== undefined))
    )
      return invalid();
  }
  return journal as unknown as MissionReleaseJournal;
}

export async function readMissionReleaseJournal(path: string): Promise<MissionReleaseJournal | undefined> {
  try {
    const value = await readJournalEnvelope(path, maxBytes);
    return value === undefined ? undefined : validateJournal(value);
  } catch {
    return invalid();
  }
}

export async function saveMissionReleaseJournal(path: string, journal: MissionReleaseJournal): Promise<void> {
  validateJournal(journal);
  await writeJournalEnvelope(path, journal, maxBytes);
}

export async function lockMissionReleaseJournal(path: string): Promise<() => Promise<void>> {
  return lockPrivateJournal(path, 'Mission release');
}
