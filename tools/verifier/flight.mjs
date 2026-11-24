import { canonicalize, decodeBase64, parseStrictJson, requireValue } from './integrity.mjs';

export const FLIGHT_FORMAT = 'ledger.flight-evidence.2';
export const COMMAND_LINK_KIND = 'command-link.status';

export function verifyCommandLinkReceipt(envelope, artifacts, path) {
  const check = (condition, message) => requireValue(condition, 'command_link_evidence', path, message);
  const object = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  const keys = (value, required, optional = []) =>
    check(
      object(value) &&
        required.every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
      'Command-link fields do not match the versioned source contract',
    );
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const utc = (value) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  const input = envelope.payload;
  keys(
    input,
    [
      'sourceId',
      'sourceSessionId',
      'kind',
      'occurredAt',
      'subject',
      'artifactId',
      'fidelity',
      'payload',
      'acceptedAuthority',
    ],
    ['flightId'],
  );
  check(
    input.kind === COMMAND_LINK_KIND &&
      input.kind === envelope.type &&
      input.fidelity === 'synthetic_contract' &&
      id(input.sourceId) &&
      input.sourceId === envelope.sourceId &&
      id(input.sourceSessionId) &&
      input.sourceSessionId === envelope.sourceSessionId &&
      utc(input.occurredAt) &&
      input.occurredAt === envelope.occurredAt &&
      envelope.effectiveAt === null &&
      id(input.artifactId) &&
      input.artifactId === envelope.artifactId,
    'Command-link source context differs from its retained envelope',
  );
  keys(input.subject, ['flightId']);
  check(
    id(input.subject.flightId) && (!Object.hasOwn(input, 'flightId') || input.flightId === input.subject.flightId),
    'Command-link evidence must identify one flight scope consistently',
  );
  keys(input.payload, ['sourceEventId', 'incidentId', 'aircraftId', 'status'], ['position']);
  check(
    id(input.payload.sourceEventId) &&
      id(input.payload.incidentId) &&
      id(input.payload.aircraftId) &&
      ['lost', 'restored'].includes(input.payload.status),
    'Command-link event identity or reported state is invalid',
  );
  if (Object.hasOwn(input.payload, 'position')) {
    keys(input.payload.position, ['longitude', 'latitude']);
    const { longitude, latitude } = input.payload.position;
    check(
      typeof longitude === 'number' &&
        Number.isFinite(longitude) &&
        longitude >= -180 &&
        longitude <= 180 &&
        typeof latitude === 'number' &&
        Number.isFinite(latitude) &&
        latitude >= -90 &&
        latitude <= 90,
      'Reported command-link position is outside its declared degree bounds',
    );
  }
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
    authority.version === 'ledger.command-link-authority.1' &&
      authority.principalId === envelope.principalId &&
      authority.tenantId === envelope.tenantId &&
      Number.isSafeInteger(authority.principalRevision) &&
      authority.principalRevision >= 1 &&
      authority.inputKind === COMMAND_LINK_KIND &&
      authority.sourceId === envelope.sourceId &&
      canonicalize(authority.requiredCapabilities) === canonicalize(['input:write', 'command-link:write']) &&
      Array.isArray(authority.grantedSources) &&
      authority.grantedSources.length <= 100 &&
      authority.grantedSources.every(id) &&
      new Set(authority.grantedSources).size === authority.grantedSources.length &&
      authority.grantedSources.includes(envelope.sourceId),
    'Retained command-link intake authority does not grant its recorded source',
  );
  const artifact = artifacts.get(input.artifactId);
  check(
    artifact?.contentType === 'application/json',
    'Command-link original source must be retained as application/json',
  );
  const bytes = decodeBase64(artifact.bytesBase64, path);
  check(bytes.byteLength <= 64 * 1024, 'Command-link original source exceeds its 64 KiB intake bound');
  let source;
  try {
    source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), path);
  } catch {
    check(false, 'Command-link original source is not strict UTF-8 JSON');
  }
  keys(source, ['sourceSessionId', 'occurredAt', 'sourceEventId', 'incidentId', 'aircraftId', 'status'], ['position']);
  const { sourceSessionId, occurredAt, ...fields } = source;
  check(
    sourceSessionId === input.sourceSessionId &&
      occurredAt === input.occurredAt &&
      canonicalize(fields) === canonicalize(input.payload),
    'Command-link normalized evidence does not reproduce the retained original source',
  );
}

export function verifyFlightTarget(bundle) {
  requireValue(
    canonicalize(bundle.manifest.subject) === canonicalize({ kind: 'flight', id: bundle.manifest.flightId }),
    'flight_target',
    '$.manifest.subject',
    'Flight subject must identify the selected manifest flight',
  );
  requireValue(
    canonicalize(bundle.basisManifest) === canonicalize({ status: 'not_retained' }),
    'flight_basis',
    '$.basisManifest',
    'Ordinary flight decisions have no retained dependency-basis manifest',
  );
}
