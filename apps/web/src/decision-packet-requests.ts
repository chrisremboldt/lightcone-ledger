import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import {
  DECISION_PACKET_LIMITS,
  DECISION_PACKET_V2_LIMITS,
  FINDING_PACKET_LIMITS,
  FINDING_PACKET_V2_LIMITS,
  type DecisionPacketRecord,
  type FindingPacketCreate,
  type FindingPacketRecord,
  type Principal,
} from '@ledger/contracts';

// Packet requests made from a decision record. New packets are finding packets for the finding the decision treats;
// decision packets issued earlier in the older format can still be selected and read, but are no longer issued.
const endpoint = '/v1/finding-packets' as const;
const digest = /^[a-f0-9]{64}$/;

export type PacketRecord = FindingPacketRecord | DecisionPacketRecord;
export type PacketTarget =
  { kind: 'finding'; findingId: string } | { kind: 'decision'; flightId: string; decisionId: string };

/** The session key of a packet target: one per finding, and one per decision for older packets. */
export function packetKey(target: PacketTarget): string {
  return target.kind === 'finding' ? `finding:${target.findingId}` : `decision:${target.decisionId}`;
}

export interface PacketSession {
  record: PacketRecord | null;
  request: {
    body: FindingPacketCreate;
    key: string;
    endpoint: typeof endpoint;
    principalId: string;
    tenantId: string;
    state: 'sending' | 'unknown' | 'rejected';
  } | null;
  error: { message: string; details?: unknown } | null;
  status: string | null;
}

export interface DecisionPacketRequests {
  /** Sessions by packetKey. */
  sessions: Record<string, PacketSession>;
  issue(body: FindingPacketCreate): Promise<void>;
  select(target: PacketTarget, record: PacketRecord): void;
}

interface Scope {
  client: LedgerClient;
  baseUrl: string;
  principalId: string;
  tenantId: string;
  revision: number;
}
interface Attempt {
  original: Readonly<{
    scope: Scope;
    body: FindingPacketCreate;
    key: string;
  }>;
  uncertain: boolean;
}
interface RequestStore {
  scope: Scope | null;
  attempts: Map<string, Attempt>;
  operations: Map<string, object>;
}
interface Sessions {
  scope: Scope | null;
  values: Record<string, PacketSession>;
}
class PacketScopeError extends Error {}

function sameScope(left: Scope | null, right: Scope | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.client === right.client &&
    left.baseUrl === right.baseUrl &&
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId &&
    left.revision === right.revision
  );
}

function emptySession(): PacketSession {
  return { record: null, request: null, error: null, status: null };
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= 200;
}
function boundedCount(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function issuedRecord(record: PacketRecord, tenantId: string, limits: Record<string, number>): boolean {
  return Boolean(
    boundedId(record.id) &&
    boundedId(record.tenantId) &&
    boundedId(record.issuedBy) &&
    typeof record.issuedAt === 'string' &&
    record.issuedAt.length <= 128 &&
    Number.isFinite(Date.parse(record.issuedAt)) &&
    record.tenantId === tenantId &&
    record.limits &&
    Object.keys(limits).length === Object.keys(record.limits).length &&
    Object.entries(limits).every(([name, value]) => (record.limits as Record<string, unknown>)[name] === value) &&
    boundedCount(record.counts?.events, 2, limits.maxEvents!) &&
    boundedCount(record.counts?.receipts, 0, limits.maxReceipts!) &&
    boundedCount(record.counts?.artifacts, 0, limits.maxArtifacts!) &&
    Number.isSafeInteger(record.byteLength) &&
    record.byteLength > 0 &&
    record.byteLength <= limits.maxPacketBytes! &&
    typeof record.packetSha256 === 'string' &&
    digest.test(record.packetSha256) &&
    typeof record.manifestDigest === 'string' &&
    digest.test(record.manifestDigest),
  );
}

function findingRecordMatches(record: FindingPacketRecord, findingId: string, tenantId: string): boolean {
  const version2 = record.format === 'ledger.finding-packet.2';
  if (!version2 && record.format !== 'ledger.finding-packet.1') return false;
  const limits = version2 ? FINDING_PACKET_V2_LIMITS : FINDING_PACKET_LIMITS;
  return (
    issuedRecord(record, tenantId, limits) &&
    record.findingId === findingId &&
    boundedId(record.eventId) &&
    boundedCount(record.counts.evaluations, 1, limits.maxEvaluations) &&
    boundedCount(record.counts.hazards, 0, limits.maxHazards) &&
    (!version2 ||
      (boundedCount(record.counts.originalBytes, 0, FINDING_PACKET_V2_LIMITS.maxOriginalBytes) &&
        boundedCount(record.counts.leftOutOriginals, 0, record.counts.artifacts)))
  );
}

function decisionRecordMatches(
  record: DecisionPacketRecord,
  target: Extract<PacketTarget, { kind: 'decision' }>,
  tenantId: string,
): boolean {
  if (record.format !== 'ledger.decision-packet.1' && record.format !== 'ledger.decision-packet.2') return false;
  const limits = record.format === 'ledger.decision-packet.2' ? DECISION_PACKET_V2_LIMITS : DECISION_PACKET_LIMITS;
  return (
    issuedRecord(record, tenantId, limits) &&
    boundedId(record.flightId) &&
    boundedId(record.decisionId) &&
    record.flightId === target.flightId &&
    record.decisionId === target.decisionId &&
    record.scope === 'selected_c2_finding_treatment_records' &&
    boundedCount(record.counts.artifactBytes, 0, limits.maxOriginalBytes)
  );
}

/** Whether a packet record is an issued packet of this target in this tenant, within its format's own limits. */
export function packetRecordMatches(record: unknown, target: PacketTarget, tenantId: string): record is PacketRecord {
  if (!record || typeof record !== 'object') return false;
  return target.kind === 'finding'
    ? findingRecordMatches(record as FindingPacketRecord, target.findingId, tenantId)
    : decisionRecordMatches(record as DecisionPacketRecord, target, tenantId);
}

function packetFailure(error: unknown): NonNullable<PacketSession['error']> {
  if (error instanceof ApiError) {
    let body = error.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    const detail =
      body && typeof body === 'object' ? (body as { error?: { message?: unknown; details?: unknown } }).error : null;
    return {
      message:
        typeof detail?.message === 'string'
          ? detail.message
          : `Packet request failed (${error.status}). Retry the same request.`,
      ...(detail?.details !== undefined ? { details: detail.details } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : 'The packet result is unknown. Retry the same request.',
  };
}

export function useDecisionPacketRequests(client: LedgerClient, principal: Principal | null): DecisionPacketRequests {
  const scope = useMemo<Scope | null>(
    () =>
      principal
        ? Object.freeze({
            client,
            baseUrl: client.baseUrl,
            principalId: principal.id,
            tenantId: principal.tenantId,
            revision: principal.revision,
          })
        : null,
    [client, client.baseUrl, principal?.id, principal?.tenantId, principal?.revision],
  );
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const alive = useRef(true);
  const store = useRef<RequestStore>({ scope, attempts: new Map(), operations: new Map() });
  const [sessions, setSessions] = useState<Sessions>({ scope, values: {} });

  const scopedStore = useCallback((expected: Scope | null): RequestStore => {
    if (!sameScope(store.current.scope, expected))
      store.current = { scope: expected, attempts: new Map(), operations: new Map() };
    return store.current;
  }, []);

  const current = useCallback((expected: Scope): boolean => {
    return alive.current && latestScope.current === expected && expected.client.baseUrl === expected.baseUrl;
  }, []);

  const update = useCallback(
    (expected: Scope, sessionKey: string, change: (session: PacketSession) => PacketSession): void => {
      if (!current(expected)) return;
      setSessions((previous) => {
        if (!current(expected)) return previous;
        const values = sameScope(previous.scope, expected) ? previous.values : {};
        return { scope: expected, values: { ...values, [sessionKey]: change(values[sessionKey] ?? emptySession()) } };
      });
    },
    [current],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    scopedStore(scope);
    setSessions((previous) => (sameScope(previous.scope, scope) ? previous : { scope, values: {} }));
  }, [scope, scopedStore]);

  const issue = useCallback(
    async (body: FindingPacketCreate): Promise<void> => {
      const expected = latestScope.current;
      if (!expected || !current(expected)) return;
      const active = scopedStore(expected);
      const target: PacketTarget = { kind: 'finding', findingId: body.findingId };
      const sessionKey = packetKey(target);
      if (active.operations.has(sessionKey)) return;
      let attempt = active.attempts.get(sessionKey);
      if (!attempt) {
        attempt = {
          original: Object.freeze({
            scope: expected,
            body: Object.freeze(structuredClone(body)),
            key: crypto.randomUUID(),
          }),
          uncertain: false,
        };
        active.attempts.set(sessionKey, attempt);
      }
      const saved = attempt;
      const original = saved.original;
      const operation = {};
      active.operations.set(sessionKey, operation);
      update(expected, sessionKey, (session) => ({
        ...session,
        request: {
          body: original.body,
          key: original.key,
          endpoint,
          principalId: original.scope.principalId,
          tenantId: original.scope.tenantId,
          state: 'sending',
        },
        error: null,
        status: null,
      }));
      try {
        const session = await original.scope.client.request<{ principal: Principal }>('/v1/me');
        if (!current(expected)) return;
        if (
          session?.principal?.id !== original.scope.principalId ||
          session.principal.tenantId !== original.scope.tenantId ||
          session.principal.revision !== original.scope.revision
        )
          throw new PacketScopeError(
            'Your active identity or authority changed. Restore the original session before retrying this packet request.',
          );
        const response = await original.scope.client.createFindingPacket(original.body, original.key);
        if (
          !packetRecordMatches(response?.record, target, original.scope.tenantId) ||
          response.record.issuedBy !== original.scope.principalId
        )
          throw new Error(
            'The response could not be matched to this packet request. Retry the same request to confirm its result.',
          );
        if (!current(expected)) return;
        const record = structuredClone(response.record);
        active.attempts.delete(sessionKey);
        update(expected, sessionKey, (session) => ({
          ...session,
          record,
          request: null,
          error: null,
          status: 'Finding packet confirmed. Retain its manifest digest separately.',
        }));
      } catch (error) {
        if (!current(expected)) return;
        const rejected =
          error instanceof PacketScopeError ||
          (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408);
        saved.uncertain ||= !rejected;
        update(expected, sessionKey, (session) => ({
          ...session,
          request: {
            body: original.body,
            key: original.key,
            endpoint,
            principalId: original.scope.principalId,
            tenantId: original.scope.tenantId,
            state: saved.uncertain ? 'unknown' : 'rejected',
          },
          error: packetFailure(error),
          status: null,
        }));
      } finally {
        if (active.operations.get(sessionKey) === operation) active.operations.delete(sessionKey);
      }
    },
    [current, scopedStore, update],
  );

  const select = useCallback(
    (target: PacketTarget, record: PacketRecord): void => {
      const expected = latestScope.current;
      if (!expected || !current(expected)) return;
      const key = packetKey(target);
      if (!packetRecordMatches(record, target, expected.tenantId)) {
        update(expected, key, (session) => ({
          ...session,
          error: { message: 'This packet does not match the selected record and tenant. Refresh packet records.' },
        }));
        return;
      }
      update(expected, key, (session) => ({ ...session, record: structuredClone(record), status: null }));
    },
    [current, scopedStore, update],
  );

  return useMemo(
    () => ({ sessions: sameScope(sessions.scope, scope) ? sessions.values : {}, issue, select }),
    [scope, sessions, issue, select],
  );
}
