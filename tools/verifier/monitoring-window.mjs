import { canonicalDigest, canonicalize, decodeBase64, parseStrictJson, requireValue } from './integrity.mjs';

export const MONITORING_WINDOW_KIND = 'monitoring.window';
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value >= 1;
function utc(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : undefined;
}
function check(condition, path, message, code = 'monitoring_window_evidence') {
  requireValue(condition, code, path, message);
}
function keys(value, expected, path) {
  check(
    object(value) &&
      Object.keys(value).length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key)),
    path,
    'Monitoring fields do not match the versioned source contract',
  );
}
function interval(value, path, observedThrough) {
  keys(value, ['start', 'end'], path);
  check(
    utc(value.start) !== undefined && utc(value.end) !== undefined && utc(value.start) < utc(value.end),
    path,
    'Monitoring intervals must be finite ordered UTC intervals',
  );
  if (observedThrough !== undefined)
    check(
      utc(value.end) <= observedThrough,
      path,
      'Reported observation interval extends beyond its source occurrence time',
    );
}
function intervals(value, path, observedThrough) {
  check(Array.isArray(value) && value.length <= 16, path, 'Monitoring interval count exceeds its bound');
  for (const entry of value) interval(entry, path, observedThrough);
}
function reference(value, fields, path) {
  keys(value, fields, path);
  check(
    fields.every((field) =>
      field === 'acceptance'
        ? object(value[field])
        : field === 'digest' || field.endsWith('Digest')
          ? digest(value[field])
          : field === 'acceptedRevision' || field === 'sourceRevision' || field === 'controlVersion'
            ? positive(value[field])
            : id(value[field]),
    ),
    path,
    'Monitoring reference identity, version or digest is invalid',
  );
}

export function verifyMonitoringWindowReceipt(envelope, receipt, artifacts, path) {
  const input = envelope.payload;
  keys(
    input,
    [
      'sourceId',
      'sourceSessionId',
      'kind',
      'occurredAt',
      'artifactId',
      'fidelity',
      'payload',
      'organizationId',
      'acceptedAuthority',
    ],
    path,
  );
  const organizationId = `organization:${envelope.tenantId}`;
  check(
    input.kind === MONITORING_WINDOW_KIND &&
      input.kind === envelope.type &&
      id(input.sourceId) &&
      input.sourceId === envelope.sourceId &&
      id(input.sourceSessionId) &&
      input.sourceSessionId === envelope.sourceSessionId &&
      id(input.artifactId) &&
      input.artifactId === envelope.artifactId &&
      input.fidelity === 'synthetic_contract' &&
      input.organizationId === organizationId &&
      utc(input.occurredAt) !== undefined &&
      input.occurredAt === envelope.occurredAt &&
      utc(envelope.receivedAt) !== undefined &&
      utc(input.occurredAt) <= utc(envelope.receivedAt) &&
      envelope.effectiveAt === null,
    path,
    'Monitoring context differs from its retained organization or source envelope',
  );
  const authority = input.acceptedAuthority;
  keys(
    authority,
    [
      'principalId',
      'tenantId',
      'principalRevision',
      'capabilities',
      'checkedCapabilities',
      'sourceId',
      'grantedSources',
      'policyVersion',
    ],
    path,
  );
  check(
    id(authority.principalId) &&
      authority.principalId === envelope.principalId &&
      authority.tenantId === envelope.tenantId &&
      positive(authority.principalRevision) &&
      authority.sourceId === input.sourceId &&
      authority.policyVersion === 'ledger.monitoring-authority.1' &&
      Array.isArray(authority.capabilities) &&
      authority.capabilities.every(id) &&
      canonicalize(authority.checkedCapabilities) === canonicalize(['input:write', 'monitoring:write']) &&
      authority.checkedCapabilities.every((value) => authority.capabilities.includes(value)) &&
      Array.isArray(authority.grantedSources) &&
      authority.grantedSources.length <= 100 &&
      authority.grantedSources.every(id) &&
      new Set(authority.grantedSources).size === authority.grantedSources.length &&
      authority.grantedSources.includes(input.sourceId),
    path,
    'Retained monitoring intake authority does not grant its recorded source',
  );
  const fields = input.payload;
  keys(
    fields,
    [
      'version',
      'sourceWindowId',
      'sourceRevision',
      'control',
      'window',
      'populationComplete',
      'completeThrough',
      'flights',
    ],
    path,
  );
  check(
    fields.version === 'monitoring.window.2' &&
      id(fields.sourceWindowId) &&
      positive(fields.sourceRevision) &&
      typeof fields.populationComplete === 'boolean' &&
      utc(fields.completeThrough) !== undefined &&
      utc(fields.completeThrough) <= utc(input.occurredAt),
    path,
    'Monitoring version, revision or occurrence chronology is invalid',
  );
  interval(fields.window, path);
  check(
    utc(fields.window.end) - utc(fields.window.start) <= 60 * 60 * 1000,
    path,
    'Monitoring window exceeds its one-hour bound',
  );
  reference(
    fields.control,
    ['hazardId', 'controlId', 'controlVersion', 'controlEventId', 'controlDigest', 'acceptance'],
    path,
  );
  reference(fields.control.acceptance, ['id', 'acceptedRevision', 'digest'], path);
  check(
    Array.isArray(fields.flights) && fields.flights.length <= 32,
    path,
    'Monitoring population exceeds its 32-flight bound',
  );
  const flights = new Set();
  const sessions = new Set();
  let references = 0;
  for (const scope of fields.flights) {
    keys(
      scope,
      [
        'flightId',
        'aircraftId',
        'mission',
        'c2SourceId',
        'c2SourceSessionId',
        'baseline',
        'observedIntervals',
        'coverageIntervals',
        'gaps',
        'declaredC2SourceEventIds',
      ],
      path,
    );
    const session = canonicalize([scope.c2SourceId, scope.c2SourceSessionId]);
    check(
      [scope.flightId, scope.aircraftId, scope.c2SourceId, scope.c2SourceSessionId].every(id) &&
        !flights.has(scope.flightId) &&
        !sessions.has(session),
      path,
      'Monitoring flight or C2 scope is invalid or duplicated',
    );
    flights.add(scope.flightId);
    sessions.add(session);
    reference(scope.mission, ['missionId', 'sourceRevision', 'eventId', 'contentDigest', 'recordDigest'], path);
    reference(scope.baseline, ['eventId', 'receiptId', 'sourceEventId', 'digest'], path);
    intervals(scope.observedIntervals, path, utc(input.occurredAt));
    if (scope.coverageIntervals !== null) intervals(scope.coverageIntervals, path, utc(input.occurredAt));
    check(Array.isArray(scope.gaps) && scope.gaps.length <= 16, path, 'Monitoring gap count exceeds its bound');
    for (const gap of scope.gaps) {
      keys(gap, ['interval', 'kind'], path);
      interval(gap.interval, path, utc(input.occurredAt));
      check(
        ['exposure', 'c2_monitor', 'telemetry_delivery'].includes(gap.kind),
        path,
        'Monitoring gap kind is unsupported',
      );
    }
    check(
      Array.isArray(scope.declaredC2SourceEventIds) &&
        scope.declaredC2SourceEventIds.every(id) &&
        new Set(scope.declaredC2SourceEventIds).size === scope.declaredC2SourceEventIds.length,
      path,
      'Declared C2 event identities are invalid or duplicated',
    );
    references += 1 + scope.declaredC2SourceEventIds.length;
  }
  check(references <= 128, path, 'Combined declared baseline and C2 event references exceed their 128-record bound');
  const artifact = artifacts.get(input.artifactId);
  check(artifact?.contentType === 'application/json', path, 'Monitoring original must be application/json');
  const bytes = decodeBase64(artifact.bytesBase64, path);
  check(bytes.byteLength > 0 && bytes.byteLength <= 128 * 1024, path, 'Monitoring original exceeds its 128 KiB bound');
  let source;
  try {
    source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), path);
  } catch {
    check(false, path, 'Monitoring original is not strict UTF-8 JSON');
  }
  const expected = { sourceSessionId: input.sourceSessionId, occurredAt: input.occurredAt, ...fields };
  check(
    canonicalize(source) === canonicalize(expected),
    path,
    'Monitoring normalized evidence does not reproduce its exact original source',
  );
  return {
    envelope,
    receipt,
    path,
    record: {
      version: 'monitoring.window.2',
      id: envelope.eventId,
      organizationId,
      sourceId: input.sourceId,
      source: expected,
      original: { artifactId: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength },
      recordedAt: envelope.receivedAt,
      authority,
    },
  };
}

function retainedRecord(event, type, version, path) {
  const value = event?.payload.acceptance;
  check(
    event?.type === type &&
      object(value) &&
      value.version === version &&
      !Object.hasOwn(value, 'id') &&
      !Object.hasOwn(value, 'recordedAt'),
    path,
    'Monitoring reference lacks its retained immutable record',
    'monitoring_window_reference',
  );
  return { ...value, id: event.eventId, recordedAt: event.receivedAt };
}
function earlier(reference, monitoring, path) {
  check(
    utc(reference.receivedAt) !== undefined &&
      utc(reference.receivedAt) <= utc(monitoring.receivedAt) &&
      (reference.streamId !== monitoring.streamId || BigInt(reference.sequence) < BigInt(monitoring.sequence)),
    path,
    'Monitoring reference was not retained before the comparable monitoring record',
    'monitoring_window_reference',
  );
}
function immutableContext(source) {
  const population = source.flights.map(
    ({ flightId, aircraftId, mission, c2SourceId, c2SourceSessionId, baseline }) => ({
      flightId,
      aircraftId,
      mission,
      c2SourceId,
      c2SourceSessionId,
      baseline,
    }),
  );
  population.sort((left, right) => (left.flightId < right.flightId ? -1 : left.flightId > right.flightId ? 1 : 0));
  return { version: 'ledger.monitoring-window-context.1', control: source.control, window: source.window, population };
}
export function verifyMonitoringWindowReferences(monitoring, events, receipts, artifacts) {
  const identities = new Map();
  for (const { envelope, record, path } of monitoring) {
    const source = record.source;
    const checkReference = (condition, message) => check(condition, path, message, 'monitoring_window_reference');
    for (const scope of source.flights) {
      const baselineEvent = events.get(scope.baseline.eventId)?.envelope;
      const receipt = receipts.get(scope.baseline.receiptId);
      checkReference(
        baselineEvent?.type === 'command-link.baseline' &&
          receipt?.kind === 'command-link.baseline' &&
          receipt.eventId === baselineEvent.eventId,
        'Monitoring baseline event or receipt is absent',
      );
      const { acceptedAuthority: authority, flightId: _flight, ...input } = baselineEvent.payload;
      const artifact = artifacts.get(input.artifactId);
      const baseline = {
        eventId: baselineEvent.eventId,
        receiptId: receipt.id,
        recordedAt: baselineEvent.receivedAt,
        input,
        authority,
        original: { artifactId: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength },
      };
      checkReference(
        input.subject.flightId === scope.flightId &&
          input.payload.aircraftId === scope.aircraftId &&
          input.sourceId === scope.c2SourceId &&
          input.sourceSessionId === scope.c2SourceSessionId &&
          input.payload.sourceEventId === scope.baseline.sourceEventId &&
          canonicalDigest(baseline) === scope.baseline.digest,
        'Monitoring baseline pin differs from its exact scoped record',
      );
      earlier(baselineEvent, envelope, path);
      const missionEvent = events.get(scope.mission.eventId)?.envelope;
      const mission = retainedRecord(missionEvent, 'mission.revision', 'flight.mission.1', path);
      checkReference(
        mission.missionId === scope.mission.missionId &&
          mission.sourceRevision === scope.mission.sourceRevision &&
          mission.flightId === scope.flightId &&
          mission.aircraftId === scope.aircraftId &&
          mission.contentDigest === scope.mission.contentDigest &&
          canonicalDigest(mission) === scope.mission.recordDigest,
        'Monitoring mission pin differs from its exact scoped record',
      );
      earlier(missionEvent, envelope, path);
    }
    const identity = canonicalize([envelope.tenantId, record.sourceId, source.sourceSessionId, source.sourceWindowId]);
    const history = identities.get(identity) ?? [];
    history.push({ envelope, record, path });
    identities.set(identity, history);
  }
  for (const history of identities.values()) {
    history.sort((left, right) => left.record.source.sourceRevision - right.record.source.sourceRevision);
    const context = canonicalDigest(immutableContext(history[0].record.source));
    for (const [index, { envelope, record, path }] of history.entries()) {
      check(
        record.source.sourceRevision === index + 1 && canonicalDigest(immutableContext(record.source)) === context,
        path,
        'Monitoring history skips or duplicates a revision or changes its permanent context',
        'monitoring_window_history',
      );
      if (index) earlier(history[index - 1].envelope, envelope, path);
    }
  }
}
