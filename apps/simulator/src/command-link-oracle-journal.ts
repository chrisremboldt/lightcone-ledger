import type { CommandLinkSource } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';

export interface C2RetainedFact {
  sequence: number;
  source: CommandLinkSource;
  sourceId: string;
  bytes: Buffer;
  /** The receipt and original artifact Ledger confirmed for the report's observation. */
  accepted?: { receiptId: string; artifactId: string };
}

interface Context {
  attemptId: string;
  tenant: 'alpha' | 'beta';
  apiUrl: string;
}

export class C2EvidenceError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'C2EvidenceError';
  }
}

type JsonObject = Record<string, unknown>;
const maxSourceBytes = 64 * 1024;
const maxJournalBytes = 2 * 1024 * 1024;
const fail = (reason: string): never => {
  throw new C2EvidenceError(reason);
};
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return fail('Command-link evidence requires a supported object');
  return value as JsonObject;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    return fail('Command-link evidence identity is missing or unsupported');
  return value;
};
const digest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    return fail('Command-link evidence digest is invalid');
  return value;
};
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);

function keys(value: JsonObject, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail('Command-link evidence has missing or unsupported fields');
}

function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return fail('Command-link evidence requires an explicit UTC time');
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 19) !== value.slice(0, 19))
    return fail('Command-link evidence has an invalid UTC time');
  return new Date(instant).toISOString();
}

function strictJson(bytes: Uint8Array, maximum: number): unknown {
  if (bytes.byteLength > maximum) return fail('Command-link evidence exceeds its byte bound');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (source.startsWith('\uFEFF')) return fail('Command-link JSON must not contain a byte-order mark');
  const parsed: unknown = JSON.parse(source);
  let position = 0;
  const whitespace = () => {
    while (position < source.length && /[\t\n\r ]/.test(source[position])) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(source.slice(start, position)) as string;
    }
    return fail('Command-link JSON contains an invalid string');
  };
  const visit = (depth: number): void => {
    if (depth > 64) fail('Command-link JSON exceeds its nesting bound');
    whitespace();
    if (source[position] === '"') {
      string();
      return;
    }
    if (source[position] === '{') {
      position++;
      whitespace();
      if (source[position] === '}') {
        position++;
        return;
      }
      const seen = new Set<string>();
      while (true) {
        const key = string();
        if (seen.has(key)) fail('Command-link JSON contains a duplicate key');
        seen.add(key);
        whitespace();
        position++;
        visit(depth + 1);
        whitespace();
        if (source[position++] === '}') return;
        whitespace();
      }
    }
    if (source[position] === '[') {
      position++;
      whitespace();
      if (source[position] === ']') {
        position++;
        return;
      }
      while (true) {
        visit(depth + 1);
        whitespace();
        if (source[position++] === ']') return;
      }
    }
    while (position < source.length && !/[\s,}\]]/.test(source[position])) position++;
  };
  visit(0);
  canonicalDigest(parsed);
  return parsed;
}

function sourceBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length > 4 * Math.ceil(maxSourceBytes / 3))
    return fail('Retained command-link source exceeds its base64 bound');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maxSourceBytes || bytes.toString('base64') !== value)
    return fail('Retained command-link source is not canonical base64');
  return bytes;
}

function readSource(bytes: Buffer): CommandLinkSource {
  const source = object(strictJson(bytes, maxSourceBytes));
  keys(source, ['sourceSessionId', 'occurredAt', 'sourceEventId', 'incidentId', 'aircraftId', 'status'], ['position']);
  for (const field of ['sourceSessionId', 'sourceEventId', 'incidentId', 'aircraftId']) id(source[field]);
  utc(source.occurredAt);
  if (source.status !== 'lost' && source.status !== 'restored') fail('Command-link source status is unsupported');
  if (source.position !== undefined) {
    const position = object(source.position);
    keys(position, ['longitude', 'latitude']);
    if (
      typeof position.longitude !== 'number' ||
      !Number.isFinite(position.longitude) ||
      position.longitude < -180 ||
      position.longitude > 180 ||
      typeof position.latitude !== 'number' ||
      !Number.isFinite(position.latitude) ||
      position.latitude < -90 ||
      position.latitude > 90
    )
      fail('Command-link source position is outside WGS84 bounds');
  }
  return source as unknown as CommandLinkSource;
}

function readAccepted(value: unknown): NonNullable<C2RetainedFact['accepted']> {
  const accepted = object(value);
  keys(accepted, ['receiptId', 'artifactId']);
  return { receiptId: id(accepted.receiptId), artifactId: id(accepted.artifactId) };
}

export function readCommandLinkJournal(
  raw: Uint8Array,
  context: Context,
): { flightId?: string; principalId?: string; facts: C2RetainedFact[] } {
  try {
    id(context.attemptId);
    if (context.tenant !== 'alpha' && context.tenant !== 'beta')
      return fail('Command-link tenant scope is unsupported');
    const envelope = object(strictJson(raw, maxJournalBytes));
    keys(envelope, ['version', 'body', 'sha256']);
    if (
      envelope.version !== 1 ||
      typeof envelope.body !== 'string' ||
      digest(envelope.sha256) !== sha256(envelope.body)
    )
      return fail('Command-link journal envelope commitment is invalid');
    const body = Buffer.from(envelope.body, 'utf8');
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body) !== envelope.body)
      return fail('Command-link journal body is not exact UTF-8 text');
    const journal = object(strictJson(body, maxJournalBytes));
    keys(journal, ['version', 'binding', 'facts'], ['principalId', 'flightId']);
    // Version 1 journals were kept by the retired dedicated intake.
    if (journal.version !== 2) return fail('Command-link journal version is unsupported');
    const principalId = journal.principalId === undefined ? undefined : id(journal.principalId);
    const flightId = journal.flightId === undefined ? undefined : id(journal.flightId);
    const entries = Object.entries(object(journal.facts));
    if (!entries.length || entries.length > 64) return fail('Command-link journal requires 1–64 retained facts');
    const sourceEvents = new Set<string>();
    const receiptIds = new Set<string>();
    const facts = entries.map(([sequence, value]): C2RetainedFact => {
      const entry = object(value);
      keys(entry, ['fact', 'bytesBase64'], ['accepted']);
      const retained = object(entry.fact);
      keys(
        retained,
        [
          'sequence',
          'tenant',
          'at',
          'attemptId',
          'sourceSessionId',
          'aircraftId',
          'kind',
          'sourceId',
          'sourceEventId',
          'incidentId',
          'status',
        ],
        ['position'],
      );
      if (
        !Number.isSafeInteger(retained.sequence) ||
        Number(retained.sequence) < 0 ||
        String(retained.sequence) !== sequence ||
        retained.kind !== 'command-link' ||
        retained.tenant !== context.tenant ||
        retained.attemptId !== context.attemptId
      )
        return fail('Command-link fact identity differs from the selected attempt');
      const bytes = sourceBytes(entry.bytesBase64);
      const source = readSource(bytes);
      const expected = {
        sourceSessionId: retained.sourceSessionId,
        occurredAt: retained.at,
        sourceEventId: retained.sourceEventId,
        incidentId: retained.incidentId,
        aircraftId: retained.aircraftId,
        status: retained.status,
        ...(retained.position !== undefined ? { position: retained.position } : {}),
      };
      if (!same(source, expected) || sourceEvents.has(source.sourceEventId))
        return fail('Command-link source bytes differ from their fact or repeat a source event');
      sourceEvents.add(source.sourceEventId);
      const fact: C2RetainedFact = {
        sequence: Number(retained.sequence),
        source,
        sourceId: id(retained.sourceId),
        bytes,
      };
      if (entry.accepted !== undefined) {
        if (!principalId || !flightId) return fail('Command-link acceptance lacks its principal or flight binding');
        fact.accepted = readAccepted(entry.accepted);
        if (receiptIds.has(fact.accepted.receiptId))
          return fail('Command-link journal repeats an accepted receipt identity');
        receiptIds.add(fact.accepted.receiptId);
      }
      return fact;
    });
    const first = facts[0]!;
    if (
      facts.some(
        (fact) =>
          fact.sourceId !== first.sourceId ||
          fact.source.sourceSessionId !== first.source.sourceSessionId ||
          fact.source.aircraftId !== first.source.aircraftId,
      ) ||
      journal.binding !==
        sha256(
          JSON.stringify({
            apiUrl: context.apiUrl,
            tenantId: `tenant-${context.tenant}`,
            attemptId: context.attemptId,
            sourceId: first.sourceId,
            sourceSessionId: first.source.sourceSessionId,
            aircraftId: first.source.aircraftId,
          }),
        )
    )
      return fail('Command-link journal changed its API, tenant, attempt or source binding');
    facts.sort((left, right) => left.sequence - right.sequence);
    return { ...(flightId ? { flightId } : {}), ...(principalId ? { principalId } : {}), facts };
  } catch (error) {
    if (error instanceof C2EvidenceError) throw error;
    throw new C2EvidenceError('Command-link journal JSON or retained evidence is malformed or unsupported');
  }
}
