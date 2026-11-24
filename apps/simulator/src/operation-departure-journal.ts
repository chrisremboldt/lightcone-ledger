import type { MissionDepartureAuthorizationResponse, MissionReleaseRecordResponse } from '@ledger/contracts';
import type { OperationDepartureAllocation } from '@ledger/simulation-models/operation';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { validateMissionDepartureRequest, validateMissionDepartureResponse } from './mission-departure-api.js';
import { validateMissionDeparturePlan, type MissionDeparturePlan } from './mission-departure-plan.js';
import { lockPrivateJournal, readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

export interface OperationDeparturePreparation {
  version: 1;
  kind: 'operation-departure';
  planDigest: string;
  principalId: string;
  tenantId: string;
  apiUrl: string;
  runId: string;
  reservationId: string;
  flightId: string;
  allocation: OperationDepartureAllocation;
  request: { key: string; payload: string; payloadSha256: string; startedAt: string };
  release: MissionReleaseRecordResponse;
}

export interface OperationDepartureJournal extends OperationDeparturePreparation {
  status: 'submitted' | 'authorized' | 'departed' | 'abandoned';
  authorization?: MissionDepartureAuthorizationResponse;
  receivedAt?: string;
  rejection?: { code: string; status?: number };
  consumed?: { attemptId: string; departureAt: string };
}

const maxBytes = 8 * 1024 * 1024;
const invalid = (): never => {
  throw new Error('Departure journal commitment is invalid; refusing to replace its request');
};
const same = (first: unknown, second: unknown) => canonicalDigest(first) === canonicalDigest(second);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return at;
}

export function validateDeparturePreparation(
  value: unknown,
  planValue: MissionDeparturePlan,
): OperationDeparturePreparation {
  const plan = validateMissionDeparturePlan(planValue);
  const row = object(value);
  const fields = [
    'version',
    'kind',
    'planDigest',
    'principalId',
    'tenantId',
    'apiUrl',
    'runId',
    'reservationId',
    'flightId',
    'allocation',
    'request',
    'release',
  ];
  if (fields.some((field) => !Object.hasOwn(row, field)) || Object.keys(row).some((key) => !fields.includes(key)))
    return invalid();
  if (
    row.version !== 1 ||
    row.kind !== 'operation-departure' ||
    row.planDigest !== canonicalDigest(plan) ||
    row.principalId !== plan.principalId ||
    row.tenantId !== plan.tenantId ||
    row.apiUrl !== plan.apiUrl ||
    row.runId !== plan.runId ||
    row.reservationId !== plan.reservationId ||
    row.flightId !== plan.flightId
  )
    return invalid();
  const prepared = row as unknown as OperationDeparturePreparation;
  const allocation = object(row.allocation);
  if (
    allocation.version !== 'operation.departure-allocation.1' ||
    allocation.reservationId !== plan.reservationId ||
    allocation.flightId !== plan.flightId ||
    allocation.departureAttemptId !== plan.departureAttemptId ||
    allocation.aircraftId !== plan.aircraftId ||
    !same(allocation.mission, plan.mission) ||
    !same(allocation.release, plan.release)
  )
    return invalid();
  utc(allocation.startsAt);
  utc(allocation.endsAt);
  const request = object(row.request);
  if (
    Object.keys(request).length !== 4 ||
    typeof request.key !== 'string' ||
    !/^simulator:departure:[a-f0-9-]{36}$/.test(request.key) ||
    typeof request.payload !== 'string' ||
    sha256(request.payload) !== request.payloadSha256
  )
    return invalid();
  utc(request.startedAt);
  validateMissionDepartureRequest(JSON.parse(request.payload), plan, {
    id: prepared.allocation.id,
    digest: canonicalDigest(prepared.allocation),
  });
  if (
    prepared.release.release.id !== plan.release.id ||
    prepared.release.digest !== plan.release.digest ||
    canonicalDigest(prepared.release.release) !== plan.release.digest
  )
    return invalid();
  return structuredClone(prepared);
}

export function preparationFromJournal(journal: OperationDepartureJournal): OperationDeparturePreparation {
  const {
    status: _status,
    authorization: _authorization,
    receivedAt: _receivedAt,
    rejection: _rejection,
    consumed: _consumed,
    ...prepared
  } = journal;
  return prepared;
}

export function validateDepartureJournal(value: unknown, plan: MissionDeparturePlan): OperationDepartureJournal {
  const row = object(value);
  if (!['submitted', 'authorized', 'departed', 'abandoned'].includes(String(row.status))) return invalid();
  const journal = row as unknown as OperationDepartureJournal;
  const prepared = validateDeparturePreparation(preparationFromJournal(journal), plan);
  if (journal.authorization !== undefined) {
    if (journal.receivedAt === undefined) return invalid();
    validateMissionDepartureResponse(
      journal.authorization,
      JSON.parse(prepared.request.payload),
      plan,
      { id: prepared.allocation.id, digest: canonicalDigest(prepared.allocation) },
      prepared.release.release.basis.mission,
      prepared.release,
      utc(prepared.request.startedAt),
      utc(journal.receivedAt),
    );
  } else if (journal.receivedAt !== undefined) return invalid();
  if (
    (journal.status === 'submitted' && (journal.authorization || journal.rejection || journal.consumed)) ||
    (journal.status === 'authorized' && (!journal.authorization || journal.rejection || journal.consumed)) ||
    (journal.status === 'departed' && (!journal.authorization || !journal.consumed || journal.rejection)) ||
    (journal.status === 'abandoned' && (!journal.rejection || journal.consumed))
  )
    return invalid();
  if (
    journal.consumed &&
    (typeof journal.consumed.attemptId !== 'string' ||
      !journal.consumed.attemptId ||
      !Number.isSafeInteger(utc(journal.consumed.departureAt)))
  )
    return invalid();
  if (
    journal.rejection &&
    (typeof journal.rejection.code !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(journal.rejection.code))
  )
    return invalid();
  return structuredClone(journal);
}

export async function readDepartureJournal(
  path: string,
  plan: MissionDeparturePlan,
): Promise<OperationDepartureJournal | undefined> {
  const value = await readJournalEnvelope(path, maxBytes);
  return value === undefined ? undefined : validateDepartureJournal(value, plan);
}

export async function saveDepartureJournal(
  path: string,
  journal: OperationDepartureJournal,
  plan: MissionDeparturePlan,
): Promise<void> {
  validateDepartureJournal(journal, plan);
  await writeJournalEnvelope(path, journal, maxBytes);
}

export function lockDepartureJournal(path: string): Promise<() => Promise<void>> {
  return lockPrivateJournal(path, 'World departure');
}
