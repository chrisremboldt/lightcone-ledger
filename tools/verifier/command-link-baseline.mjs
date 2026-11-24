import { canonicalize, decodeBase64, parseStrictJson, requireValue } from './integrity.mjs';

export const COMMAND_LINK_BASELINE_KIND = 'command-link.baseline';

export function verifyCommandLinkBaselineReceipt(envelope, artifacts, path) {
  const check = (condition, message) => requireValue(condition, 'command_link_baseline_evidence', path, message);
  const object = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  const keys = (value, expected) =>
    check(
      object(value) &&
        Object.keys(value).length === expected.length &&
        expected.every((key) => Object.hasOwn(value, key)),
      'Baseline fields do not match the versioned source contract',
    );
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const utc = (value) =>
    typeof value === 'string' &&
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  const input = envelope.payload;
  keys(input, [
    'sourceId',
    'sourceSessionId',
    'kind',
    'occurredAt',
    'subject',
    'artifactId',
    'fidelity',
    'payload',
    'flightId',
    'acceptedAuthority',
  ]);
  keys(input.subject, ['flightId']);
  keys(input.payload, ['version', 'sourceEventId', 'aircraftId', 'state']);
  check(
    input.kind === COMMAND_LINK_BASELINE_KIND &&
      input.kind === envelope.type &&
      id(input.sourceId) &&
      input.sourceId === envelope.sourceId &&
      id(input.sourceSessionId) &&
      input.sourceSessionId === envelope.sourceSessionId &&
      id(input.subject.flightId) &&
      input.flightId === input.subject.flightId &&
      id(input.artifactId) &&
      input.artifactId === envelope.artifactId &&
      input.fidelity === 'synthetic_contract' &&
      utc(input.occurredAt) &&
      input.occurredAt === envelope.occurredAt &&
      utc(envelope.receivedAt) &&
      Date.parse(input.occurredAt) <= Date.parse(envelope.receivedAt) &&
      envelope.effectiveAt === null &&
      input.payload.version === 'command-link.baseline.1' &&
      id(input.payload.sourceEventId) &&
      id(input.payload.aircraftId) &&
      ['up', 'down', 'unknown'].includes(input.payload.state),
    'Baseline identity, reported state or source context differs from its retained envelope',
  );
  const authority = input.acceptedAuthority;
  keys(authority, [
    'version',
    'principalId',
    'tenantId',
    'principalRevision',
    'inputKind',
    'sourceId',
    'requiredCapabilities',
    'grantedSources',
  ]);
  check(
    authority.version === 'ledger.command-link-baseline-authority.1' &&
      id(authority.principalId) &&
      authority.principalId === envelope.principalId &&
      id(authority.tenantId) &&
      authority.tenantId === envelope.tenantId &&
      Number.isSafeInteger(authority.principalRevision) &&
      authority.principalRevision >= 1 &&
      authority.inputKind === COMMAND_LINK_BASELINE_KIND &&
      authority.sourceId === input.sourceId &&
      canonicalize(authority.requiredCapabilities) === canonicalize(['input:write', 'command-link:write']) &&
      Array.isArray(authority.grantedSources) &&
      authority.grantedSources.length <= 100 &&
      authority.grantedSources.every(id) &&
      new Set(authority.grantedSources).size === authority.grantedSources.length &&
      authority.grantedSources.includes(input.sourceId),
    'Retained baseline intake authority does not grant its recorded source',
  );
  const artifact = artifacts.get(input.artifactId);
  check(artifact?.contentType === 'application/json', 'Baseline original source must be retained as application/json');
  const bytes = decodeBase64(artifact.bytesBase64, path);
  check(
    bytes.byteLength > 0 && bytes.byteLength <= 64 * 1024,
    'Baseline original source exceeds its 64 KiB intake bound',
  );
  let source;
  try {
    source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), path);
  } catch {
    check(false, 'Baseline original source is not strict UTF-8 JSON');
  }
  keys(source, [
    'version',
    'sourceId',
    'sourceSessionId',
    'sourceEventId',
    'flightId',
    'aircraftId',
    'occurredAt',
    'state',
  ]);
  check(
    canonicalize(source) ===
      canonicalize({
        sourceId: input.sourceId,
        sourceSessionId: input.sourceSessionId,
        flightId: input.subject.flightId,
        occurredAt: input.occurredAt,
        ...input.payload,
      }),
    'Baseline normalized evidence does not reproduce its exact original source',
  );
}

export function verifyCommandLinkBaselineHistory(records) {
  const sessions = new Map();
  for (const record of records) {
    const envelope = record.envelope;
    const session = canonicalize([envelope.tenantId, envelope.sourceId, envelope.sourceSessionId]);
    const history = sessions.get(session) ?? [];
    history.push(record);
    sessions.set(session, history);
  }
  for (const history of sessions.values()) {
    const baselines = history.filter(({ envelope }) => envelope.type === COMMAND_LINK_BASELINE_KIND);
    if (!baselines.length) continue;
    const baseline = baselines[0].envelope;
    const path = baselines[0].path;
    const check = (condition, message) => requireValue(condition, 'command_link_baseline_history', path, message);
    check(baselines.length === 1, 'One source session retains more than one baseline');
    const binding = canonicalize([baseline.payload.subject.flightId, baseline.payload.payload.aircraftId]);
    const sourceEvents = new Set();
    for (const { envelope } of history) {
      check(
        canonicalize([envelope.payload.subject.flightId, envelope.payload.payload.aircraftId]) === binding,
        'Baseline and status history change their fixed flight or aircraft binding',
      );
      const sourceEventId = envelope.payload.payload.sourceEventId;
      check(!sourceEvents.has(sourceEventId), 'Baseline and status history reuse a source event identity');
      sourceEvents.add(sourceEventId);
      if (envelope === baseline) continue;
      check(
        Date.parse(baseline.receivedAt) <= Date.parse(envelope.receivedAt) &&
          (baseline.streamId !== envelope.streamId || BigInt(baseline.sequence) < BigInt(envelope.sequence)),
        'Baseline was not retained before the comparable status history',
      );
    }
  }
}
