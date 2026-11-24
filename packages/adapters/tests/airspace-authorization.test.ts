import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import {
  type AirspaceAuthorizationBinding,
  airspaceAuthorizationAdapter,
  airspaceAuthorizationDescriptor,
} from '../src/airspace-authorization.js';
import { assertAdapterConformance } from '../src/conformance.js';

const context: TranslationContext<AirspaceAuthorizationBinding> = {
  subjects: { scope: 'source' },
  binding: { flightId: 'ALPHA-FLIGHT-0042' },
};

function message(body: unknown): VendorMessage {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
    transport: { method: 'GET', path: '/v1/operations/fictional-operation/laanc' },
    capturedAt: '2026-10-20T08:30:00.500Z',
  };
}

const record = {
  id: 'SIMA1B2C3D4E',
  geom: {
    type: 'Polygon',
    coordinates: [
      [
        [-87.64, 41.87],
        [-87.64, 41.89],
        [-87.62, 41.89],
        [-87.64, 41.87],
      ],
    ],
  },
  altitude: 400,
  startTime: '2026-10-20T09:00:00Z',
  endTime: '2026-10-20T11:00:00Z',
  status: 'STATUS_APPROVED',
  lastUpdatedAt: '2026-10-20T08:20:00Z',
};

describe('airspace authorization adapter on the contract', () => {
  it('passes the conformance kit against its golden files', async () => {
    const report = await assertAdapterConformance({
      adapter: airspaceAuthorizationAdapter,
      context,
      goldenDirectory: join(import.meta.dirname, '../src/golden/airspace-authorization'),
    });
    expect(report.checked).toMatchObject({ goldens: 9, observations: 6 });
  });

  it('records each authorization of an operation read, citing the read, and a replay as the same submission', async () => {
    const sink = new InMemoryObservationSink();
    const read = message({ operation: { authorizations: [record] } });
    const first = await translateAndSubmit(airspaceAuthorizationAdapter, read, context, sink);
    const replay = await translateAndSubmit(airspaceAuthorizationAdapter, read, context, sink);
    expect(replay.submitted.map((entry) => entry.receiptId)).toEqual(first.submitted.map((entry) => entry.receiptId));
    expect(sink.observations).toHaveLength(1);
    expect(first.submitted[0]!.observation).toMatchObject({
      type: 'airspace.authorization',
      subject: { kind: 'flight', id: 'ALPHA-FLIGHT-0042', scope: 'source' },
      occurredAt: '2026-10-20T08:20:00.000Z',
      interval: { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T11:00:00.000Z' },
      originalArtifactId: first.artifactId,
      limitations: airspaceAuthorizationDescriptor.limitations,
      values: {
        authorizationId: 'SIMA1B2C3D4E',
        reportedStatus: 'approved',
        sourceStatusCode: 'STATUS_APPROVED',
        ceiling: { meters: 121.92, datum: 'ground_level' },
        area: {
          boundary: [
            { latitudeDegrees: 41.87, longitudeDegrees: -87.64 },
            { latitudeDegrees: 41.89, longitudeDegrees: -87.64 },
            { latitudeDegrees: 41.89, longitudeDegrees: -87.62 },
          ],
        },
      },
    });
  });

  it('keeps an authorization without an altitude or area, saying what it does not carry', () => {
    const { altitude: _altitude, ...withoutAltitude } = record;
    const holed = {
      ...withoutAltitude,
      geom: { type: 'Polygon', coordinates: [record.geom.coordinates[0], record.geom.coordinates[0]] },
    };
    const { drafts, rejections } = airspaceAuthorizationAdapter.translate(
      message({ operation: { authorizations: [holed] } }),
      context,
    );
    expect(rejections).toEqual([]);
    expect(drafts[0]).not.toHaveProperty('values.ceiling');
    expect(drafts[0]).not.toHaveProperty('values.area');
    expect(drafts[0]!.extraLimitations).toEqual(['The area is not carried: a polygon with holes is not carried.']);
  });
});
