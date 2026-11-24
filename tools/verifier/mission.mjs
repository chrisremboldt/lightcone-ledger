import { canonicalDigest, canonicalize, decodeBase64, parseStrictJson, requireValue, sha256 } from './integrity.mjs';

export const MISSION_KIND = 'mission.revision';

export function verifyMissionReceipt(envelope, receipt, artifacts, path) {
  const check = (condition, message) => requireValue(condition, 'mission_evidence', path, message);
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
      'Mission fields do not match the versioned source contract',
    );
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const positiveInteger = (value) => Number.isSafeInteger(value) && value >= 1;
  const boundedNumber = (value, minimum, maximum) =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
  const utc = (value) =>
    typeof value === 'string' &&
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  const input = envelope.payload;
  keys(input, [
    'sourceId',
    'kind',
    'sourceRevision',
    'occurredAt',
    'subject',
    'artifactId',
    'fidelity',
    'payload',
    'flightId',
    'acceptedAuthority',
    'acceptance',
  ]);
  keys(input.subject, ['flightId']);
  check(
    input.kind === MISSION_KIND &&
      input.kind === envelope.type &&
      id(input.sourceId) &&
      input.sourceId === envelope.sourceId &&
      positiveInteger(input.sourceRevision) &&
      utc(input.occurredAt) &&
      input.occurredAt === envelope.occurredAt &&
      envelope.sourceSessionId === null &&
      envelope.effectiveAt === null &&
      id(input.subject.flightId) &&
      input.flightId === input.subject.flightId &&
      id(input.artifactId) &&
      input.artifactId === envelope.artifactId &&
      input.fidelity === 'synthetic_contract',
    'Mission source context differs from its retained envelope',
  );
  const fields = input.payload;
  keys(
    fields,
    ['sourceMissionId', 'aircraftId', 'route', 'lateralToleranceMeters', 'altitude', 'operatingInterval'],
    ['routePlanning'],
  );
  check(id(fields.sourceMissionId) && id(fields.aircraftId), 'Mission or aircraft identity is invalid');
  keys(fields.route, ['coordinateReference', 'coordinateOrder', 'segmentInterpolation', 'geometry']);
  keys(fields.route.geometry, ['type', 'coordinates']);
  check(
    fields.route.coordinateReference === 'WGS84' &&
      fields.route.coordinateOrder === 'longitude_latitude' &&
      fields.route.segmentInterpolation === 'linear_longitude_latitude' &&
      fields.route.geometry.type === 'LineString' &&
      Array.isArray(fields.route.geometry.coordinates) &&
      fields.route.geometry.coordinates.length >= 2 &&
      fields.route.geometry.coordinates.length <= 256 &&
      fields.route.geometry.coordinates.every(
        (position) =>
          Array.isArray(position) &&
          position.length === 2 &&
          boundedNumber(position[0], -180, 180) &&
          boundedNumber(position[1], -90, 90),
      ),
    'Mission route differs from its bounded longitude/latitude LineString contract',
  );
  keys(fields.altitude, ['minimum', 'maximum', 'unit', 'reference']);
  check(
    boundedNumber(fields.lateralToleranceMeters, 0, 1000) &&
      boundedNumber(fields.altitude.minimum, 0, 10000) &&
      boundedNumber(fields.altitude.maximum, 0, 10000) &&
      fields.altitude.minimum <= fields.altitude.maximum &&
      fields.altitude.unit === 'm' &&
      fields.altitude.reference === 'AGL',
    'Mission tolerance or planned altitude band is invalid',
  );
  keys(fields.operatingInterval, ['start', 'end']);
  check(
    utc(fields.operatingInterval.start) &&
      utc(fields.operatingInterval.end) &&
      Date.parse(fields.operatingInterval.start) < Date.parse(fields.operatingInterval.end),
    'Mission planned operating interval is not a finite UTC half-open interval',
  );
  if (Object.hasOwn(fields, 'routePlanning')) {
    const planning = fields.routePlanning;
    keys(planning, [
      'version',
      'requiredLocations',
      'cruiseMetersPerSecond',
      'ascentMs',
      'serviceMs',
      'descentMs',
      'holdAllowanceMs',
      'handoffAllowanceMs',
      'marginMs',
      'customerInterval',
      'resourceInterval',
    ]);
    check(
      planning.version === 'mission.route-planning.1' &&
        Array.isArray(planning.requiredLocations) &&
        planning.requiredLocations.length >= 3 &&
        planning.requiredLocations.length <= 32 &&
        boundedNumber(planning.cruiseMetersPerSecond, Number.MIN_VALUE, 100) &&
        ['ascentMs', 'serviceMs', 'descentMs', 'holdAllowanceMs', 'handoffAllowanceMs', 'marginMs'].every(
          (key) =>
            Number.isSafeInteger(planning[key]) &&
            planning[key] >= (key === 'marginMs' ? 1 : 0) &&
            planning[key] <= (key === 'marginMs' ? 3600000 : 86400000),
        ),
      'Mission planning bounds are invalid',
    );
    const locations = planning.requiredLocations;
    locations.forEach((location, index) => {
      keys(location, ['role', 'position']);
      check(
        location.role === (index === 0 ? 'launch' : index === locations.length - 1 ? 'return' : 'service') &&
          Array.isArray(location.position) &&
          location.position.length === 2 &&
          boundedNumber(location.position[0], -180, 180) &&
          boundedNumber(location.position[1], -90, 90),
        'Mission planning required location is invalid',
      );
    });
    const coordinates = fields.route.geometry.coordinates;
    const same = (first, second) => first[0] === second[0] && first[1] === second[1];
    check(
      same(coordinates[0], locations[0].position) && same(coordinates.at(-1), locations.at(-1).position),
      'Mission planning launch or return is missing',
    );
    let previous = 0;
    for (const location of locations.slice(1, -1)) {
      const next = coordinates.findIndex((point, index) => index >= previous && same(point, location.position));
      check(next >= 0, 'Mission planning service locations are missing or reordered');
      previous = next;
    }
    for (const interval of [planning.customerInterval, planning.resourceInterval]) {
      keys(interval, ['start', 'end']);
      check(
        utc(interval.start) &&
          utc(interval.end) &&
          Date.parse(interval.start) < Date.parse(interval.end) &&
          Date.parse(fields.operatingInterval.start) >= Date.parse(interval.start) &&
          Date.parse(fields.operatingInterval.end) <= Date.parse(interval.end),
        'Mission planning interval is outside source bounds',
      );
    }
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
    authority.version === 'ledger.mission-authority.1' &&
      id(authority.principalId) &&
      authority.principalId === envelope.principalId &&
      id(authority.tenantId) &&
      authority.tenantId === envelope.tenantId &&
      positiveInteger(authority.principalRevision) &&
      authority.inputKind === MISSION_KIND &&
      authority.sourceId === input.sourceId &&
      canonicalize(authority.requiredCapabilities) === canonicalize(['input:write', 'mission:write']) &&
      Array.isArray(authority.grantedSources) &&
      authority.grantedSources.length <= 100 &&
      authority.grantedSources.every(id) &&
      new Set(authority.grantedSources).size === authority.grantedSources.length &&
      authority.grantedSources.includes(input.sourceId),
    'Retained mission intake authority does not grant its recorded source',
  );
  const artifact = artifacts.get(input.artifactId);
  check(artifact?.contentType === 'application/json', 'Mission original source must be retained as application/json');
  const bytes = decodeBase64(artifact.bytesBase64, path);
  check(
    bytes.byteLength > 0 && bytes.byteLength <= 64 * 1024,
    'Mission original source exceeds its 64 KiB intake bound',
  );
  let source;
  try {
    source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), path);
  } catch {
    check(false, 'Mission original source is not strict UTF-8 JSON');
  }
  check(
    canonicalize(source) ===
      canonicalize({ sourceRevision: input.sourceRevision, occurredAt: input.occurredAt, ...fields }),
    'Mission normalized evidence does not reproduce the retained original source',
  );
  const acceptance = input.acceptance;
  keys(
    acceptance,
    [
      'version',
      'missionId',
      'flightId',
      'sourceId',
      'sourceMissionId',
      'aircraftId',
      'sourceRevision',
      'occurredAt',
      'receiptId',
      'artifactId',
      'route',
      'lateralToleranceMeters',
      'altitude',
      'operatingInterval',
      'original',
      'contentDigest',
      'authority',
    ],
    ['routePlanning'],
  );
  const original = { sha256: sha256(bytes), byteLength: bytes.byteLength };
  const contentDigest = canonicalDigest({
    version: 'ledger.mission-content.1',
    sourceId: input.sourceId,
    flightId: input.subject.flightId,
    sourceRevision: input.sourceRevision,
    occurredAt: input.occurredAt,
    fidelity: input.fidelity,
    payload: fields,
    original: { ...original, bytesBase64: artifact.bytesBase64 },
  });
  check(
    id(acceptance.missionId) &&
      id(acceptance.receiptId) &&
      canonicalize(acceptance) ===
        canonicalize({
          version: 'flight.mission.1',
          missionId: acceptance.missionId,
          flightId: input.subject.flightId,
          sourceId: input.sourceId,
          ...fields,
          sourceRevision: input.sourceRevision,
          occurredAt: input.occurredAt,
          receiptId: receipt.id,
          artifactId: input.artifactId,
          original,
          contentDigest,
          authority,
        }),
    'Mission acceptance differs from its retained input, authority or original-byte commitment',
  );
  return {
    sourceId: input.sourceId,
    sourceMissionId: fields.sourceMissionId,
    missionId: acceptance.missionId,
    flightId: input.subject.flightId,
    aircraftId: fields.aircraftId,
    sourceRevision: input.sourceRevision,
  };
}
