import type { ObservationSubject } from '@ledger/contracts';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type OriginalLocator,
  type TranslateFunction,
  type TranslationRejection,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';

/** The flight an airspace operation was requested for, by the id the operator's system gave it. */
export interface AirspaceAuthorizationBinding {
  readonly flightId: string;
}

const RESPONSE_BYTES_LIMIT = 1024 * 1024;
const MAX_AUTHORIZATIONS = 200;
const FOOT_METERS = 0.3048;
const UTC = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?Z$/;

/** The source's status codes in the vocabulary. A code not listed is reported as unknown, with the code kept. */
const statuses: Readonly<Record<string, string>> = {
  STATUS_RECEIVED: 'requested',
  STATUS_APPROVED: 'approved',
  STATUS_DENIED: 'denied',
  STATUS_CANCELED: 'cancelled',
  STATUS_INVALID_CANCEL: 'cancelled',
  STATUS_AUTOCANCEL: 'cancelled',
  STATUS_CLOSED: 'cancelled',
  STATUS_RESCINDED: 'rescinded',
  STATUS_RESCIND_ACK: 'rescinded',
  STATUS_EXPIRED: 'expired',
  STATUS_INVALID: 'invalid',
  STATUS_UNSPECIFIED: 'unknown',
};

const responseKeys = ['operation'];
const operationKeys = ['authorizations'];
const authorizationKeys = ['id', 'status', 'lastUpdatedAt', 'startTime', 'endTime', 'altitude', 'geom'];
const geometryKeys = ['type', 'coordinates'];

export const airspaceAuthorizationDescriptor: AdapterDescriptor = {
  id: 'airspace-link-laanc-authorization',
  version: '1.0.0',
  source: {
    vendor: 'Airspace Link',
    product: 'AirHub LAANC operations',
    interface: 'HTTPS GET /v1/operations/{id}/laanc, the operation with its authorizations',
  },
  produces: [{ type: 'airspace.authorization', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from the published schema of the operation read and checked against its emulator; not checked against a sandbox or a live service.',
    'reportedStatus is the issuing party’s statement. Its status codes are mapped: received is requested; cancelled, invalid-cancelled, automatically cancelled and closed are cancelled; a rescission and its acknowledgement are rescinded. The code itself is kept in sourceStatusCode.',
    'occurredAt is when the authorization record was last updated, to the millisecond; the interval is the time the record states it covers.',
    'The ceiling is the record’s altitude, which its schema states in feet above ground level, converted to meters.',
    'The area is the outer boundary of the record’s polygon; a polygon with holes is not carried.',
  ],
  documentation: [
    {
      reference:
        'The source’s published OpenAPI schema for reading an operation with its authorizations, pinned in apps/emulators/vendor/airspace-link/provenance.json (file 10829370.yaml).',
      sha256: 'fbdd89230d9c694086de882bcf1f64f6eab9e982fe92be4980e7780d0a11deff',
    },
  ],
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const utcTime = (value: unknown): value is string =>
  typeof value === 'string' && UTC.test(value) && Number.isFinite(Date.parse(value));
/** The instant to the millisecond: the vocabulary carries at most millisecond precision. */
const instant = (value: string) => new Date(Date.parse(value)).toISOString();

interface Boundary {
  boundary: { latitudeDegrees: number; longitudeDegrees: number }[];
}

/** The outer ring of a GeoJSON polygon as the vocabulary's boundary, or a reason it is not carried. */
function areaOf(geom: unknown): Boundary | { problem: string } {
  if (!isObject(geom) || geom.type !== 'Polygon' || !Array.isArray(geom.coordinates))
    return { problem: 'geom must be a GeoJSON Polygon' };
  if (geom.coordinates.length !== 1) return { problem: 'a polygon with holes is not carried' };
  const ring = geom.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 1001)
    return { problem: 'the polygon must be one closed ring of 4 to 1,001 positions' };
  const corners = ring.map((position: unknown) =>
    Array.isArray(position) &&
    position.length === 2 &&
    typeof position[0] === 'number' &&
    typeof position[1] === 'number' &&
    Math.abs(position[0]) <= 180 &&
    Math.abs(position[1]) <= 90
      ? { latitudeDegrees: position[1], longitudeDegrees: position[0] }
      : undefined,
  );
  if (corners.some((corner) => corner === undefined))
    return { problem: 'every polygon position must be a longitude and latitude in degrees' };
  const first = corners[0]!;
  const last = corners.at(-1)!;
  if (first.latitudeDegrees !== last.latitudeDegrees || first.longitudeDegrees !== last.longitudeDegrees)
    return { problem: 'the polygon ring must close on its first position' };
  return { boundary: corners.slice(0, -1) as Boundary['boundary'] };
}

/** The reason an authorization record cannot become an observation, or undefined. */
function authorizationProblem(record: Json): string | undefined {
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(record.id))
    return 'id must be 1 to 200 letters, digits, dots, colons, hyphens or underscores';
  if (typeof record.status !== 'string' || !/^[A-Z_]{1,100}$/.test(record.status))
    return 'status must be a status code';
  if (!utcTime(record.lastUpdatedAt)) return 'lastUpdatedAt must be a UTC time ending in Z';
  if (!utcTime(record.startTime) || !utcTime(record.endTime)) return 'startTime and endTime must be UTC times';
  if (Date.parse(record.endTime) <= Date.parse(record.startTime)) return 'endTime must be after startTime';
  if (
    record.altitude !== undefined &&
    (typeof record.altitude !== 'number' || !Number.isFinite(record.altitude) || record.altitude < 0)
  )
    return 'altitude must be a number of feet, zero or more';
  return undefined;
}

function draftOf(record: Json, index: number, subject: ObservationSubject): ObservationDraft {
  const area = record.geom === undefined ? undefined : areaOf(record.geom);
  const status = record.status as string;
  return {
    type: 'airspace.authorization',
    version: 1,
    subject,
    occurredAt: instant(record.lastUpdatedAt as string),
    interval: { start: instant(record.startTime as string), end: instant(record.endTime as string) },
    sourceEventId: `${String(record.id)}@${String(record.lastUpdatedAt)}`,
    originalLocator: jsonPointer('operation', 'authorizations', index),
    values: {
      authorizationId: record.id as string,
      reportedStatus: statuses[status] ?? 'unknown',
      sourceStatusCode: status,
      ...(typeof record.altitude === 'number'
        ? { ceiling: { meters: record.altitude * FOOT_METERS, datum: 'ground_level' } }
        : {}),
      ...(area && 'boundary' in area ? { area } : {}),
    },
    ...(area && 'problem' in area ? { extraLimitations: [`The area is not carried: ${area.problem}.`] } : {}),
  } as ObservationDraft;
}

export const translateAirspaceAuthorization: TranslateFunction<AirspaceAuthorizationBinding> = (message, context) => {
  if (message.contentType !== 'application/json') return rejected('An operation read must be application/json');
  const decoded = decodeStrictJson(message.bytes, RESPONSE_BYTES_LIMIT);
  if (!decoded.ok) return rejected(`Invalid or ambiguous JSON: ${decoded.reason}`);
  const body = decoded.value;
  if (!isObject(body) || !isObject(body.operation)) return rejected('The response holds no operation object');
  const authorizations = body.operation.authorizations;
  if (!Array.isArray(authorizations) || authorizations.length > MAX_AUTHORIZATIONS)
    return rejected(
      `operation.authorizations must list at most ${MAX_AUTHORIZATIONS} authorizations`,
      jsonPointer('operation', 'authorizations'),
    );
  const subject = subjectFor(context.subjects, 'flight', context.binding.flightId);
  if (!subject) return rejected('No Ledger flight is bound to this operation');
  const seen = new Map<string, number>();
  for (const [index, record] of authorizations.entries()) {
    if (!isObject(record) || typeof record.id !== 'string') continue;
    const key = `${record.id}@${String(record.lastUpdatedAt)}`;
    if (seen.has(key))
      return rejected(
        `Authorization ${key} is listed twice (authorizations ${seen.get(key)} and ${index}); the response is ambiguous`,
        jsonPointer('operation', 'authorizations', index),
      );
    seen.set(key, index);
  }

  const drafts: ObservationDraft[] = [];
  const rejections: TranslationRejection[] = [];
  const unmapped: OriginalLocator[] = [
    ...unknownKeys(body, responseKeys),
    ...unknownKeys(body.operation, operationKeys, 'operation'),
  ];
  for (const [index, record] of authorizations.entries()) {
    const locator = jsonPointer('operation', 'authorizations', index);
    if (!isObject(record)) {
      rejections.push({ reason: 'An authorization is a JSON object', locator });
      continue;
    }
    unmapped.push(...unknownKeys(record, authorizationKeys, 'operation', 'authorizations', index));
    if (isObject(record.geom))
      unmapped.push(...unknownKeys(record.geom, geometryKeys, 'operation', 'authorizations', index, 'geom'));
    const problem = authorizationProblem(record);
    if (problem) {
      rejections.push({ reason: problem, locator });
      continue;
    }
    drafts.push(draftOf(record, index, subject));
  }
  return { drafts, rejections, unmapped };
};

export const airspaceAuthorizationAdapter: ObservationAdapter<AirspaceAuthorizationBinding> = {
  descriptor: airspaceAuthorizationDescriptor,
  translate: translateAirspaceAuthorization,
};
