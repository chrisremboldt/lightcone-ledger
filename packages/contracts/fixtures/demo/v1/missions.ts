import type {
  Command,
  FlightMissionResponse,
  FlightMissionRevisionResponse,
  MissionAuthority,
  MissionBinding,
  MissionInput,
  MissionRevisionRecord,
  MissionSource,
  Principal,
} from '../../../src/index.js';
import { identity } from './ready.js';

export const missionSource = {
  sourceRevision: 1,
  occurredAt: '2026-10-15T13:59:00Z',
  sourceMissionId: 'demo-71031:mission:1',
  aircraftId: 'demo-71031:aircraft:1',
  route: {
    coordinateReference: 'WGS84',
    coordinateOrder: 'longitude_latitude',
    segmentInterpolation: 'linear_longitude_latitude',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-87.63, 41.88],
        [-87.625, 41.882],
        [-87.62155, 41.8844],
      ],
    },
  },
  lateralToleranceMeters: 30,
  altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
  operatingInterval: { start: '2026-10-15T14:05:00Z', end: '2026-10-15T14:20:00Z' },
} satisfies MissionSource;
export const missionCorridorExample = {
  source: { ...missionSource, lateralToleranceMeters: 30 } satisfies MissionSource,
  meaning:
    'A closed avoidance circle whose nearest point is 20 metres from the centerline intersects the 30-metre planned corridor, even when the circle does not touch the centerline.',
};
export const missionRevision2Source = {
  ...missionSource,
  sourceRevision: 2,
  occurredAt: '2026-10-15T13:59:30Z',
  route: {
    ...missionSource.route,
    geometry: {
      type: 'LineString',
      coordinates: [
        [-87.63, 41.88],
        [-87.627, 41.886],
        [-87.62155, 41.8844],
      ],
    },
  },
} satisfies MissionSource;
export const missionSourceText = JSON.stringify(missionSource, null, 2) + '\n';
export const missionRevision2SourceText = JSON.stringify(missionRevision2Source, null, 2) + '\n';

function input(source: MissionSource, artifactId: string): MissionInput {
  const { sourceRevision, occurredAt, ...payload } = source;
  return {
    sourceId: 'mission-planner',
    kind: 'mission.revision',
    sourceRevision,
    occurredAt,
    subject: { flightId: identity.flightId },
    artifactId,
    fidelity: 'synthetic_contract',
    payload,
  };
}
export const missionInput = input(missionSource, 'resolved-mission-revision-1-artifact');
export const missionRevision2Input = input(missionRevision2Source, 'resolved-mission-revision-2-artifact');
export const missionBinding = {
  missionId: 'resolved-ledger-mission',
  flightId: identity.flightId,
  sourceId: missionInput.sourceId,
  sourceMissionId: missionSource.sourceMissionId,
  aircraftId: missionSource.aircraftId,
} satisfies MissionBinding;
export const missionAuthority = {
  version: 'ledger.mission-authority.1',
  principalId: 'resolved-mission-source',
  tenantId: 'fixture-tenant',
  principalRevision: 2,
  inputKind: 'mission.revision',
  sourceId: missionInput.sourceId,
  requiredCapabilities: ['input:write', 'mission:write'],
  grantedSources: [missionInput.sourceId],
} satisfies MissionAuthority;

export const missionRecord = {
  ...missionBinding,
  version: 'flight.mission.1',
  id: 'resolved-mission-revision-1-event',
  sourceRevision: missionSource.sourceRevision,
  occurredAt: missionSource.occurredAt,
  recordedAt: '2026-10-15T14:00:01Z',
  receiptId: 'resolved-mission-revision-1-receipt',
  artifactId: missionInput.artifactId,
  route: missionSource.route,
  lateralToleranceMeters: missionSource.lateralToleranceMeters,
  altitude: missionSource.altitude,
  operatingInterval: missionSource.operatingInterval,
  original: { sha256: '90304440420765e64e8294fe76e730e1d9867cdb8ad74f49a3704090ca1bd0e7', byteLength: 794 },
  contentDigest: '5a9ab176f795a213977a2d8c054fae1340efcdc6a255fab2cb230c1d36f72795',
  authority: missionAuthority,
} satisfies MissionRevisionRecord;
export const missionRevision2Record = {
  ...missionRecord,
  id: 'resolved-mission-revision-2-event',
  sourceRevision: missionRevision2Source.sourceRevision,
  occurredAt: missionRevision2Source.occurredAt,
  recordedAt: '2026-10-15T14:00:05Z',
  receiptId: 'resolved-mission-revision-2-receipt',
  artifactId: missionRevision2Input.artifactId,
  route: missionRevision2Source.route,
  original: { sha256: 'a8d93873f67f816fa504d5ce5d0d8374727ef1be9ba182e3b1bb8650bfa32ef1', byteLength: 794 },
  contentDigest: 'efb4cbee6a4ec1bfd122910f50af0f7e48cb2e586baf1778e6d2e27954793525',
} satisfies MissionRevisionRecord;

const meta = {
  requestId: 'mission-read',
  projectionRevision: 10,
  inputCut: { streams: { 'resolved-mission-stream': 1 }, basisRevision: 4, principalRevision: 1 },
  dependencyBasis: 'b'.repeat(64),
  computedAt: '2026-10-15T14:00:06Z',
  outstandingWork: 1,
};
export const missionPendingRead = {
  binding: missionBinding,
  acceptedHead: { record: missionRevision2Record, processing: { status: 'pending', attempts: 0 } },
  projectedHead: missionRecord,
  meta,
} satisfies FlightMissionResponse;
export const missionFailedRead = {
  ...missionPendingRead,
  acceptedHead: {
    record: missionRevision2Record,
    processing: { status: 'failed', attempts: 8, error: 'Projection could not complete' },
  },
} satisfies FlightMissionResponse;
export const missionCurrentRead = {
  ...missionPendingRead,
  acceptedHead: { record: missionRevision2Record, processing: { status: 'completed', attempts: 1 } },
  projectedHead: missionRevision2Record,
  meta: { ...meta, inputCut: { ...meta.inputCut, streams: { 'resolved-mission-stream': 2 } }, outstandingWork: 0 },
} satisfies FlightMissionResponse;
export const missionEmptyRead = {
  binding: null,
  acceptedHead: null,
  projectedHead: null,
  meta: { ...meta, inputCut: { streams: {}, basisRevision: 1, principalRevision: 1 }, outstandingWork: 0 },
} satisfies FlightMissionResponse;
export const missionRevisionRead = { mission: missionRecord } satisfies FlightMissionRevisionResponse;

export const missionDeliveryCases = {
  outOfOrder: {
    inputs: [missionRevision2Input, missionInput],
    expectedHeadRevision: 2,
    expectedRetainedRevisions: [1, 2],
  },
  exactReplay: {
    original: missionInput,
    retry: { ...missionInput, artifactId: 'resolved-identical-mission-reupload-artifact' },
    originalText: missionSourceText,
    expectedReceiptId: missionRecord.receiptId,
    expectedAdditionalWork: 0,
  },
  changedRevision: {
    body: {
      ...missionInput,
      artifactId: 'resolved-changed-mission-artifact',
      payload: { ...missionInput.payload, lateralToleranceMeters: 60 },
    },
    source: { ...missionSource, lateralToleranceMeters: 60 },
    status: 409,
  },
  changedOriginal: {
    body: { ...missionInput, artifactId: 'resolved-reformatted-mission-artifact' },
    sourceText: JSON.stringify(missionSource),
    status: 409,
  },
  retargetedFlight: { body: { ...missionInput, subject: { flightId: 'resolved-other-flight' } }, status: 409 },
  reboundAircraft: {
    body: {
      ...missionRevision2Input,
      artifactId: 'resolved-other-aircraft-mission-artifact',
      payload: { ...missionRevision2Input.payload, aircraftId: 'other-aircraft' },
    },
    source: { ...missionRevision2Source, aircraftId: 'other-aircraft' },
    status: 409,
  },
};
export const missionInvalidCases = {
  zeroRevision: { ...missionSource, sourceRevision: 0 },
  thirdCoordinate: {
    ...missionSource,
    route: {
      ...missionSource.route,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-87.63, 41.88, 45],
          [-87.62, 41.88, 45],
        ],
      },
    },
  },
  implicitInterpolation: { ...missionSource, route: { ...missionSource.route, segmentInterpolation: 'geodesic' } },
  reversedAltitude: { ...missionSource, altitude: { ...missionSource.altitude, minimum: 80 } },
  reversedInterval: {
    ...missionSource,
    operatingInterval: { start: missionSource.operatingInterval.end, end: missionSource.operatingInterval.start },
  },
};

export function authorizeMissionSource(
  target: Pick<Principal, 'id' | 'revision' | 'capabilities' | 'missionSources'>,
  sourceId: string,
): Extract<Command, { kind: 'authority.update' }> {
  return {
    kind: 'authority.update',
    principalId: target.id,
    expectedRevision: target.revision,
    capabilities: [...new Set([...target.capabilities, 'input:write' as const, 'mission:write' as const])],
    missionSources: [...new Set([...target.missionSources, sourceId])],
  };
}
