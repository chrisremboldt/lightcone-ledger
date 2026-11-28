import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ObservationV1 } from '@ledger/contracts';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance } from '../src/conformance.js';
import {
  SKYDIO_CLOUD_START_NOTICE,
  SKYDIO_MAX_POSITIONS_PER_FLIGHT,
  skydioCloudFlightsAdapter,
  skydioCloudFlightsDescriptor,
  skydioCloudFlightsPoll,
  skydioFlightKey,
  skydioFlightParts,
  skydioFlightsPath,
  skydioNextFlightsPage,
  skydioTelemetryItems,
  skydioTelemetryPart,
  skydioTime,
  thinSamples,
  translateSkydioCloudFlights,
} from '../src/skydio-cloud-flights.js';
import type { SourceLoopEvent } from '../src/source-loop.js';
import { ServiceCredentialRefused, ServicePoll, type ServicePollConfig } from '../src/source-transports.js';
import { schemaValidator } from '../src/source-contract.js';
import { createEmulator, emulatorConfig } from '../../../apps/emulators/src/server.js';
import {
  type SkydioEmulatedFlight,
  answerSkydioRequest,
  skydioEmulatorState,
  skydioFlightObject,
  skydioTelemetrySamples,
} from '../../../apps/emulators/src/skydio.js';

const goldenDirectory = join(import.meta.dirname, '../src/golden/skydio-cloud-flights');
const context: TranslationContext = { subjects: { scope: 'source' }, binding: undefined };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const flightMessage = (flight: unknown): VendorMessage => ({
  bytes: encode(flight),
  contentType: 'application/json',
  transport: { method: 'GET', path: '/api/v0/flights' },
  capturedAt: '2026-11-20T16:00:05.000Z',
});
const telemetryMessage = (flightId: string, data: unknown): VendorMessage => ({
  bytes: encode(data),
  contentType: 'application/json',
  transport: { method: 'GET', path: `/api/v1/flight/${flightId}/telemetry` },
  capturedAt: '2026-11-20T16:00:05.000Z',
});

/** The emulator's clock in these tests, and the three invented flights placed around it. */
const BASE = '2026-11-20T16:00:00.000Z';
const minutes = (offset: number) => new Date(Date.parse(BASE) + offset * 60_000).toISOString();
const home = { latitude: 44.5, longitude: -100.5, seaLevelMeters: 520 };

describe('flight service adapter on the contract', () => {
  it('passes the conformance kit against its golden files, every one constructed from the reference', async () => {
    const report = await assertAdapterConformance({
      adapter: skydioCloudFlightsAdapter,
      context,
      goldenDirectory,
      vendorTerms: ['skydio cloud'],
    });
    expect(report.checked).toMatchObject({ goldens: 16, observations: 6 });
  });

  it('says in its descriptor, its limitations and its start notice that it has not been run against the service', () => {
    expect(skydioCloudFlightsDescriptor.fidelity).toBe('synthetic_contract');
    expect(skydioCloudFlightsDescriptor.limitations[0]).toMatch(/has not been run against the service/);
    expect(skydioCloudFlightsDescriptor.limitations[0]).toMatch(/Test it against your own account/);
    expect(SKYDIO_CLOUD_START_NOTICE).toMatch(/NOT been run against the real service/);
    expect(skydioCloudFlightsDescriptor.limitations.join(' ')).not.toMatch(/skydio/i);
    // Room for the sentence a thinned flight's positions add.
    expect(skydioCloudFlightsDescriptor.limitations.length).toBeLessThan(20);
  });

  it('reads the time formats the reference lists, and nothing else', () => {
    expect(skydioTime('2022-05-03T03:10:52.503+00:00')).toBe('2022-05-03T03:10:52.503Z');
    expect(skydioTime('2022-03-07T03:10:52-05:00')).toBe('2022-03-07T08:10:52.000Z');
    expect(skydioTime('2022-03-07T03:10:52Z')).toBe('2022-03-07T03:10:52.000Z');
    // Without a zone the reference says UTC; microseconds are cut, not rounded.
    expect(skydioTime('2022-08-18T08:30:07.233999')).toBe('2022-08-18T08:30:07.233Z');
    for (const refused of [
      1651547452503000,
      '1651547452503000',
      '2022-05-03',
      '2022-05-03 03:10:52',
      '2022-02-30T03:10:52Z',
      '2022-05-03T24:10:52Z',
      '2022-05-03T03:10:52.1234567Z',
      null,
      undefined,
    ])
      expect(skydioTime(refused), String(refused)).toBeUndefined();
  });

  it('reports a flight in progress with its takeoff only, and never says it is in the air', () => {
    const result = translateSkydioCloudFlights(
      flightMessage({
        flight_id: 'EXAMPLE-FLIGHT-0003',
        vehicle_serial: 'EXAMPLE-VEHICLE-01',
        takeoff: '2026-11-20T15:56:00.000000+00:00',
        has_telemetry: false,
      }),
      context,
    );
    expect(result.rejections).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      type: 'flight.report',
      subject: { kind: 'flight', id: 'EXAMPLE-FLIGHT-0003', scope: 'source' },
      secondarySubject: { kind: 'aircraft', id: 'EXAMPLE-VEHICLE-01', scope: 'source' },
      occurredAt: '2026-11-20T15:56:00.000Z',
      values: { takeoffAt: '2026-11-20T15:56:00.000Z' },
    });
    expect(result.drafts[0]!.values).not.toHaveProperty('activity');
    expect(result.drafts[0]).not.toHaveProperty('position');
    expect(result.unmapped).toEqual([{ kind: 'json_pointer', value: '/has_telemetry' }]);
  });

  it('gives a flight one source event per statement: the same statement again is the same event, a change is another', () => {
    const flight = {
      flight_id: 'EXAMPLE-FLIGHT-0001',
      vehicle_serial: 'EXAMPLE-VEHICLE-01',
      takeoff: '2026-11-20T15:00:02Z',
      has_telemetry: false,
    };
    const event = (given: unknown) =>
      (translateSkydioCloudFlights(flightMessage(given), context).drafts[0] as ObservationV1).sourceEventId;
    // A field no observation carries does not change the statement.
    expect(event({ ...flight, has_telemetry: true, battery_serial: 'EXAMPLE-BATTERY-09' })).toBe(event(flight));
    expect(event({ ...flight, landing: '2026-11-20T15:18:40Z' })).not.toBe(event(flight));
    expect(event({ ...flight, takeoff: '2026-11-20T15:00:03Z' })).not.toBe(event(flight));
    expect(event({ ...flight, takeoff_latitude: 44.5, takeoff_longitude: -100.5 })).not.toBe(event(flight));
    expect(event({ ...flight, vehicle_serial: 'EXAMPLE-VEHICLE-02' })).not.toBe(event(flight));
  });

  it('carries a height with the datum the reference states for it, and no height it states none for', () => {
    const flight = { flight_id: 'EXAMPLE-FLIGHT-0001', vehicle_serial: 'EXAMPLE-VEHICLE-01' };
    const sample = { timestamp: '2026-11-20T15:01:00Z', gps_latitude: 44.5, gps_longitude: -100.5 };
    const positions = (samples: unknown[]) =>
      translateSkydioCloudFlights(
        telemetryMessage('EXAMPLE-FLIGHT-0001', { flight, flight_telemetry: { aligned_telemetry: samples } }),
        context,
      ).drafts as Extract<ObservationV1, { type: 'position.fix' }>[];
    const [aboveTakeoff, aboveSeaLevel, neither] = positions([
      { ...sample, height_above_takeoff: 61.5, gps_altitude: 581.5, hybrid_altitude: 581.9, gps_vertical_accuracy: 2 },
      { ...sample, timestamp: '2026-11-20T15:01:01Z', gps_altitude: 581.5, gps_vertical_accuracy: 2 },
      { ...sample, timestamp: '2026-11-20T15:01:02Z', hybrid_altitude: 581.9 },
    ]);
    expect(aboveTakeoff!.position.altitude).toEqual({ meters: 61.5, datum: 'takeoff_point' });
    // The receiver's vertical accuracy describes its own altitude, so it travels only with that altitude.
    expect(aboveTakeoff!.values).not.toHaveProperty('verticalAccuracyMeters');
    expect(aboveSeaLevel!.position.altitude).toEqual({ meters: 581.5, datum: 'mean_sea_level' });
    expect(aboveSeaLevel!.values.verticalAccuracyMeters).toBe(2);
    expect(neither!.position).toEqual({ latitudeDegrees: 44.5, longitudeDegrees: -100.5 });
    for (const position of [aboveTakeoff, aboveSeaLevel, neither])
      expect(position!.position.altitude?.datum).not.toBe('ground_level');
  });

  it('thins a long flight to at most 240 positions that keep its first, last, highest and fastest', () => {
    const flight: SkydioEmulatedFlight = {
      flightId: 'EXAMPLE-FLIGHT-0001',
      vehicleSerial: 'EXAMPLE-VEHICLE-01',
      takeoff: minutes(-60),
      landing: minutes(-30),
      telemetryAt: minutes(-20),
      home,
    };
    const samples = skydioTelemetrySamples(flight);
    expect(samples).toHaveLength(1801);
    // One sample climbs above the rest and one is faster than the rest, both between the periods' first samples.
    samples[777] = { ...samples[777], height_above_takeoff: 97.5 };
    samples[1203] = { ...samples[1203], gps_velocity: [12, 9, 0] };
    const result = translateSkydioCloudFlights(
      telemetryMessage(flight.flightId, {
        flight: skydioFlightObject(flight, BASE),
        flight_telemetry: { aligned_telemetry: samples },
        metadata: {},
      }),
      context,
    );
    const drafts = result.drafts as (Extract<ObservationV1, { type: 'position.fix' }> & {
      extraLimitations?: string[];
    })[];
    expect(drafts.length).toBeLessThanOrEqual(SKYDIO_MAX_POSITIONS_PER_FLIGHT);
    expect(drafts.length).toBeGreaterThan(200);
    expect(drafts[0]!.occurredAt).toBe(minutes(-60));
    expect(drafts.at(-1)!.occurredAt).toBe(minutes(-30));
    expect(Math.max(...drafts.map((draft) => draft.position.altitude!.meters))).toBe(97.5);
    expect(Math.max(...drafts.map((draft) => draft.values.groundSpeedMetersPerSecond!))).toBe(15);
    expect(drafts[5]!.extraLimitations).toEqual([
      `This flight’s telemetry held 1801 positions; ${drafts.length} are carried: the first in each 8 s, the last, the highest and the fastest.`,
    ]);
    expect(skydioCloudFlightsDescriptor.limitations.length + 1).toBeLessThanOrEqual(20);
    // Every sample is accounted for: carried, or reported as not carried.
    const whole = result.unmapped.filter((locator) => /aligned_telemetry\/\d+$/.test(String(locator.value)));
    expect(whole.length + drafts.length).toBe(1801);
    expect(new Set(drafts.map((draft) => draft.sourceEventId)).size).toBe(drafts.length);
    // A short flight is carried whole and says nothing about thinning.
    expect(thinSamples([{ time: 0 }, { time: 1000 }], 240, [])).toEqual({ kept: [{ time: 0 }, { time: 1000 }] });
  });

  it('cuts the service’s answers into the flight’s own bytes and the telemetry’s data part, exactly as sent', () => {
    const page = `{"data": {"flights": [ {"flight_id":"A",  "vehicle_serial":"V", "has_telemetry":true},{"flight_id":"B","vehicle_serial":"V","has_telemetry":false} ], "pagination": {"current_page":1,"max_per_page":100,"total_pages":3}}, "meta":{"time":1.5},"skydio_error_code":0,"status_code":200}`;
    const bytes = new TextEncoder().encode(page);
    expect(skydioFlightParts(bytes)!.map(text)).toEqual([
      '{"flight_id":"A",  "vehicle_serial":"V", "has_telemetry":true}',
      '{"flight_id":"B","vehicle_serial":"V","has_telemetry":false}',
    ]);
    expect(skydioTelemetryItems(bytes)).toEqual([{ path: '/api/v1/flight/A/telemetry', key: 'A', mayBeAbsent: true }]);
    expect(skydioFlightParts(encode({ flights: [] }))).toBeUndefined();
    expect(skydioFlightParts(encode({ data: { flights: [] } }))).toEqual([]);
    const url = `https://service.example.invalid${skydioFlightsPath(new Date('2026-11-13T16:00:00.250Z'))}`;
    expect(url).toBe(
      'https://service.example.invalid/api/v0/flights?takeoff_since=2026-11-13T16%3A00%3A00Z&per_page=100&page_number=1',
    );
    expect(skydioNextFlightsPage(bytes, url)).toBe(
      '/api/v0/flights?takeoff_since=2026-11-13T16%3A00%3A00Z&per_page=100&page_number=2',
    );
    expect(skydioNextFlightsPage(bytes, url.replace('page_number=1', 'page_number=3'))).toBeUndefined();
    expect(skydioNextFlightsPage(encode({ data: { flights: [] } }), url)).toBeUndefined();
    const answer = `{"data":{"flight":{"flight_id":"A"},  "flight_telemetry":{"aligned_telemetry":[]}},"meta":{"time":2.5},"status_code":200}`;
    expect(text(skydioTelemetryPart(new TextEncoder().encode(answer))!)).toBe(
      '{"flight":{"flight_id":"A"},  "flight_telemetry":{"aligned_telemetry":[]}}',
    );
    // The answer's time changes with every read; the part handed over does not.
    expect(skydioTelemetryPart(new TextEncoder().encode(answer.replace('2.5', '9.5')))).toEqual(
      skydioTelemetryPart(new TextEncoder().encode(answer)),
    );
    const flight = { flight_id: 'A', vehicle_serial: 'V', takeoff: '2026-11-20T15:00:02Z', has_telemetry: false };
    expect(skydioFlightKey(encode({ ...flight, has_telemetry: true }))).toBe(skydioFlightKey(encode(flight)));
    expect(skydioFlightKey(encode({ ...flight, landing: '2026-11-20T15:10:00Z' }))).not.toBe(
      skydioFlightKey(encode(flight)),
    );
  });
});

/** The documented shapes, restated: the envelope, the Flight object, Pagination and a telemetry sample. */
const envelope = (data: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: ['data', 'status_code', 'skydio_error_code', 'meta'],
  properties: {
    data,
    error_message: { type: ['string', 'null'] },
    meta: { type: 'object', properties: { time: { type: 'number' } } },
    skydio_error_code: { type: 'integer' },
    status_code: { type: 'integer' },
  },
});
const numbers = (count: number) => ({ type: 'array', items: { type: 'number' }, minItems: count, maxItems: count });
const flightShape = {
  type: 'object',
  additionalProperties: false,
  required: ['flight_id', 'vehicle_serial'],
  properties: {
    attachments: { type: 'array' },
    battery_serial: { type: 'string' },
    flight_id: { type: 'string' },
    has_telemetry: { type: 'boolean' },
    landing: { type: 'string', format: 'date-time' },
    markers: { type: 'array' },
    sensor_package: { type: 'object' },
    takeoff: { type: 'string', format: 'date-time' },
    takeoff_latitude: { type: 'number' },
    takeoff_longitude: { type: 'number' },
    user_email: { type: 'string' },
    vehicle_serial: { type: 'string' },
  },
};
const listShape = envelope({
  type: 'object',
  required: ['flights', 'pagination'],
  properties: {
    flights: { type: 'array', items: flightShape },
    pagination: {
      type: 'object',
      additionalProperties: false,
      required: ['current_page', 'total_pages', 'max_per_page'],
      properties: {
        current_page: { type: 'integer' },
        max_per_page: { type: 'integer' },
        total_pages: { type: 'integer' },
      },
    },
  },
});
const telemetryShape = envelope({
  type: 'object',
  required: ['flight_telemetry', 'metadata'],
  properties: {
    flight: flightShape,
    flight_telemetry: {
      type: 'object',
      additionalProperties: false,
      required: ['aligned_telemetry'],
      properties: {
        aligned_telemetry: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['timestamp'],
            properties: {
              battery_percentage: { type: 'number', minimum: 0, maximum: 1 },
              gps_altitude: { type: 'number' },
              gps_horizontal_accuracy: { type: 'number' },
              gps_latitude: { type: 'number' },
              gps_longitude: { type: 'number' },
              gps_num_satellites_used: { type: 'integer' },
              gps_speed_accuracy: { type: 'number' },
              gps_velocity: numbers(3),
              gps_vertical_accuracy: { type: 'number' },
              height_above_takeoff: { type: 'number' },
              hybrid_altitude: { type: 'number' },
              hybrid_camera_orientation_rpy_ned: numbers(3),
              site_camera_orientation_quat_enu: numbers(4),
              site_camera_orientation_rpy_enu: numbers(3),
              site_camera_position_enu: numbers(3),
              site_orientation_quat_enu: numbers(4),
              site_orientation_rpy_enu: numbers(3),
              site_position_enu: numbers(3),
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
});

describe('the flight service emulator', () => {
  const token = 'fictional-flight-service-token';
  const ask = (path: string, query = '', given: { authorization?: string; at?: string } = { authorization: token }) =>
    answerSkydioRequest(
      state,
      token,
      { method: 'GET', path, query: new URLSearchParams(query), authorization: given.authorization },
      given.at ?? BASE,
    )!;
  let state = skydioEmulatorState(BASE);
  beforeEach(() => {
    state = skydioEmulatorState(BASE);
  });
  const validator = schemaValidator();

  it('answers the list, one flight and telemetry in the shapes the reference documents', () => {
    const list = ask('/api/v0/flights');
    const listed = JSON.parse(list.body);
    expect(validator.validate(listShape, listed), validator.errorsText()).toBe(true);
    expect(listed).toMatchObject({ status_code: 200, skydio_error_code: 0, meta: { time: Date.parse(BASE) / 1000 } });
    expect(listed.data.pagination).toEqual({ current_page: 1, max_per_page: 25, total_pages: 1 });
    expect(listed.data.flights.map((flight: { flight_id: string }) => flight.flight_id)).toEqual([
      'EXAMPLE-FLIGHT-0003',
      'EXAMPLE-FLIGHT-0002',
      'EXAMPLE-FLIGHT-0001',
    ]);
    // In the air: no landing. Landed with nothing uploaded: no takeoff place. Uploaded: both.
    expect(listed.data.flights[0]).toEqual({
      battery_serial: 'EXAMPLE-BATTERY-03',
      flight_id: 'EXAMPLE-FLIGHT-0003',
      has_telemetry: false,
      takeoff: '2026-11-20T15:56:00.000000+00:00',
      user_email: 'pilot.one@example.invalid',
      vehicle_serial: 'EXAMPLE-VEHICLE-01',
    });
    expect(listed.data.flights[1]).toMatchObject({ has_telemetry: false, landing: '2026-11-20T13:12:00.000000+00:00' });
    expect(listed.data.flights[1]).not.toHaveProperty('takeoff_latitude');
    expect(listed.data.flights[2]).toMatchObject({ has_telemetry: true, takeoff_latitude: 44.5 });

    const single = JSON.parse(ask('/api/v0/flight/EXAMPLE-FLIGHT-0001').body);
    expect(
      validator.validate(
        envelope({ type: 'object', required: ['flight'], properties: { flight: flightShape } }),
        single,
      ),
    ).toBe(true);
    expect(single.data.flight).toEqual(listed.data.flights[2]);

    const telemetry = JSON.parse(ask('/api/v1/flight/EXAMPLE-FLIGHT-0001/telemetry').body);
    expect(validator.validate(telemetryShape, telemetry), validator.errorsText()).toBe(true);
    expect(telemetry.data.flight_telemetry.aligned_telemetry).toHaveLength(18 * 60 + 1);
    expect(telemetry.data.flight_telemetry.aligned_telemetry[0].timestamp).toBe('2026-11-19T14:00:00.000000+00:00');
  });

  it('filters and pages the list as the reference’s parameters describe', () => {
    const ids = (query: string) =>
      JSON.parse(ask('/api/v0/flights', query).body).data.flights.map(
        (flight: { flight_id: string }) => flight.flight_id,
      );
    expect(ids('vehicle_serial=EXAMPLE-VEHICLE-02')).toEqual(['EXAMPLE-FLIGHT-0002']);
    expect(ids('takeoff_since=2026-11-20T13:00:00Z')).toEqual(['EXAMPLE-FLIGHT-0003', 'EXAMPLE-FLIGHT-0002']);
    expect(ids('takeoff_before=2026-11-20T13:00:00')).toEqual(['EXAMPLE-FLIGHT-0001']);
    expect(ids('per_page=2&page_number=2')).toEqual(['EXAMPLE-FLIGHT-0001']);
    const second = JSON.parse(ask('/api/v0/flights', 'per_page=2&page_number=2').body);
    expect(second.data.pagination).toEqual({ current_page: 2, max_per_page: 2, total_pages: 2 });
    expect(JSON.parse(ask('/api/v0/flights', 'takeoff_since=2026-11-21T00:00:00Z').body).data).toEqual({
      flights: [],
      pagination: { current_page: 1, max_per_page: 25, total_pages: 0 },
    });
    for (const refused of ['per_page=501', 'per_page=0', 'page_number=0', 'takeoff_since=yesterday', 'order=asc']) {
      const answer = ask('/api/v0/flights', refused);
      expect(answer.status, refused).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ status_code: 400, skydio_error_code: 5100 });
    }
  });

  it('refuses a token it does not know, a flight it does not hold and telemetry not uploaded, and asks for a wait', () => {
    for (const authorization of [undefined, 'another-token', `Bearer ${token}`]) {
      const refused = ask('/api/v0/flights', '', { authorization });
      expect(refused.status).toBe(401);
      expect(JSON.parse(refused.body)).toMatchObject({ status_code: 401, skydio_error_code: 3300 });
      expect(validator.validate(envelope({ type: 'object' }), JSON.parse(refused.body))).toBe(true);
    }
    expect(JSON.parse(ask('/api/v0/flight/NO-SUCH-FLIGHT').body)).toMatchObject({
      status_code: 404,
      skydio_error_code: 4400,
    });
    const notUploaded = ask('/api/v1/flight/EXAMPLE-FLIGHT-0002/telemetry');
    expect(notUploaded.status).toBe(404);
    expect(JSON.parse(notUploaded.body).skydio_error_code).toBe(4700);
    expect(
      ask('/api/v1/flight/EXAMPLE-FLIGHT-0002/telemetry', '', { authorization: token, at: minutes(10) }).status,
    ).toBe(200);
    state.rateLimited = 1;
    state.retryAfterSeconds = 7;
    const busy = ask('/api/v0/flights');
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('7');
    expect(JSON.parse(busy.body)).toMatchObject({ status_code: 429, skydio_error_code: 1429 });
    expect(ask('/api/v0/flights').status).toBe(200);
    expect(
      answerSkydioRequest(state, token, { method: 'GET', path: '/api/data/metar', query: new URLSearchParams() }, BASE),
    ).toBeUndefined();
  });
});

describe('flight service adapter against the emulator', () => {
  const config = { ...emulatorConfig({}), port: 0 };
  const { server, state } = createEmulator(config);
  let origin: string;
  let asked: string[] = [];

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    state.skydio = skydioEmulatorState(BASE);
    state.sourceClock = BASE;
    asked = [];
  });

  /** The poll as the adapter process configures it, asking for the week before the emulator's clock. */
  const pollConfig = (overrides: Partial<ServicePollConfig> = {}): ServicePollConfig => ({
    url: () => `${origin}${skydioCloudFlightsPoll.path(new Date(Date.parse(BASE) - 7 * 86_400_000))}`,
    headers: { authorization: config.flightServiceToken! },
    intervalMs: 5,
    split: skydioCloudFlightsPoll.split,
    partKey: skydioCloudFlightsPoll.partKey,
    follow: skydioCloudFlightsPoll.follow,
    followedPart: skydioCloudFlightsPoll.followedPart,
    nextPage: skydioCloudFlightsPoll.nextPage,
    maxBytes: skydioCloudFlightsPoll.maxBytes,
    fetcher: (async (url: string, init: RequestInit) => {
      asked.push(`${new URL(url).pathname}${new URL(url).search}`);
      return fetch(url, init);
    }) as typeof fetch,
    ...overrides,
  });

  /** One run of the process: reads the service until two polls have finished, submitting what it is handed. */
  async function run(sink: InMemoryObservationSink, overrides: Partial<ServicePollConfig> = {}) {
    const received: VendorMessage[] = [];
    const poll = new ServicePoll(pollConfig(overrides), async (item) => {
      received.push(item);
      await translateAndSubmit(skydioCloudFlightsAdapter, item, context, sink);
    });
    void poll.start();
    for (let attempt = 0; attempt < 2000 && poll.polls < 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await poll.stop();
    return { received, poll };
  }
  const newSink = () => new InMemoryObservationSink({ oneCurrentPerSubject: ['flight.report'] });
  const reports = (sink: InMemoryObservationSink, flightId: string, all = false) =>
    (all ? sink.observations : sink.current)
      .map((entry) => entry.observation)
      .filter((observation) => observation.type === 'flight.report' && observation.subject.id === flightId);
  const positions = (sink: InMemoryObservationSink, flightId: string) =>
    sink.observations
      .map((entry) => entry.observation)
      .filter((observation) => observation.type === 'position.fix' && observation.secondarySubject?.id === flightId);

  it('reports a flight in progress with its takeoff, and replaces that report when the flight lands', async () => {
    const sink = newSink();
    await run(sink);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0003')).toMatchObject([
      { occurredAt: minutes(-4), values: { takeoffAt: minutes(-4) }, fidelity: 'synthetic_contract' },
    ]);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0003')[0]!.values).not.toHaveProperty('landingAt');
    expect(positions(sink, 'EXAMPLE-FLIGHT-0003')).toEqual([]);

    // Nine minutes later the service lists the flight with its landing. The process started again in between.
    state.sourceClock = minutes(9);
    await run(sink);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0003')).toMatchObject([
      { occurredAt: minutes(8), values: { activity: 'landed', takeoffAt: minutes(-4), landingAt: minutes(8) } },
    ]);
    // The earlier report stays on file, replaced: a correction, not a second report beside the first.
    const all = sink.observations.filter((entry) => entry.observation.subject.id === 'EXAMPLE-FLIGHT-0003');
    expect(all).toHaveLength(2);
    expect(all[1]!.replaces).toBe(all[0]!.receiptId);
  });

  it('reports a completed flight once with its place and positions; reading it again records nothing new', async () => {
    const sink = newSink();
    const first = await run(sink);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0001')).toMatchObject([
      {
        subject: { kind: 'flight', id: 'EXAMPLE-FLIGHT-0001', scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: 'EXAMPLE-VEHICLE-01', scope: 'source' },
        occurredAt: minutes(-26 * 60 + 18),
        position: { latitudeDegrees: 44.5, longitudeDegrees: -100.5 },
        values: { activity: 'landed', takeoffAt: minutes(-26 * 60), landingAt: minutes(-26 * 60 + 18) },
      },
    ]);
    const flown = positions(sink, 'EXAMPLE-FLIGHT-0001') as Extract<ObservationV1, { type: 'position.fix' }>[];
    expect(flown.length).toBeGreaterThan(200);
    expect(flown.length).toBeLessThanOrEqual(SKYDIO_MAX_POSITIONS_PER_FLIGHT);
    expect(flown[0]).toMatchObject({
      subject: { kind: 'aircraft', id: 'EXAMPLE-VEHICLE-01', scope: 'source' },
      occurredAt: minutes(-26 * 60),
      position: { latitudeDegrees: 44.5, longitudeDegrees: -100.5, altitude: { meters: 0, datum: 'takeoff_point' } },
      values: { fix: 'unknown', method: 'satellite', satelliteCount: 14, groundSpeedMetersPerSecond: 0 },
    });
    expect(Math.max(...flown.map((position) => position.position.altitude!.meters))).toBe(60);
    expect(new Set(flown.map((position) => position.position.altitude!.datum))).toEqual(new Set(['takeoff_point']));
    // The original kept is the service's own bytes: the flight's object, and the telemetry answer's data part.
    const telemetry = first.received.find((item) => item.transport.path!.endsWith('/telemetry'))!;
    const answer = await fetch(`${origin}/api/v1/flight/EXAMPLE-FLIGHT-0001/telemetry`, {
      headers: { authorization: config.flightServiceToken! },
    });
    expect((await answer.text()).includes(text(telemetry.bytes))).toBe(true);
    expect(sink.originals.get(flown[0]!.originalArtifactId)!.bytes).toEqual(telemetry.bytes);
    expect(text(telemetry.bytes)).not.toContain('"meta"');

    // Within one run the second poll hands nothing over; a second run reads everything again and records nothing.
    expect(first.poll.unchanged).toBeGreaterThanOrEqual(1);
    const before = sink.observations.length;
    const receipts = sink.observations.map((entry) => entry.receiptId);
    const second = await run(sink);
    expect(second.received.length).toBe(first.received.length);
    expect(sink.observations).toHaveLength(before);
    expect(sink.observations.map((entry) => entry.receiptId)).toEqual(receipts);
  });

  it('does not ask for telemetry the service has not got, and reads it once it says it has', async () => {
    const sink = newSink();
    await run(sink);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0002')).toMatchObject([{ values: { landingAt: minutes(-168) } }]);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0002')[0]).not.toHaveProperty('position');
    expect(positions(sink, 'EXAMPLE-FLIGHT-0002')).toEqual([]);
    expect(asked.filter((path) => path.includes('EXAMPLE-FLIGHT-0002'))).toEqual([]);

    // Eleven minutes later the telemetry has been uploaded: the list says so and gives the takeoff place.
    state.sourceClock = minutes(11);
    asked = [];
    await run(sink);
    expect(asked.filter((path) => path.includes('EXAMPLE-FLIGHT-0002'))).toEqual([
      '/api/v1/flight/EXAMPLE-FLIGHT-0002/telemetry',
    ]);
    // Twelve minutes at a sample a second: thinned to the first position in each four seconds.
    expect(positions(sink, 'EXAMPLE-FLIGHT-0002').length).toBeGreaterThan(150);
    // The takeoff place is new, so the flight's report is replaced by one that states it.
    expect(reports(sink, 'EXAMPLE-FLIGHT-0002')).toMatchObject([
      { position: { latitudeDegrees: 44.52, longitudeDegrees: -100.5 }, values: { landingAt: minutes(-168) } },
    ]);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0002', true)).toHaveLength(2);
  });

  it('asks again for telemetry the service lists and then answers 404 for', async () => {
    const sink = newSink();
    const events: SourceLoopEvent[] = [];
    let refuse = true;
    const { poll } = await run(sink, {
      log: (event) => events.push(event),
      fetcher: (async (url: string, init: RequestInit) => {
        if (refuse && String(url).endsWith('EXAMPLE-FLIGHT-0001/telemetry')) {
          refuse = false;
          return new Response('{}', { status: 404 });
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect(positions(sink, 'EXAMPLE-FLIGHT-0001').length).toBeGreaterThan(200);
    expect(poll.polls).toBeGreaterThanOrEqual(2);
    expect(events).toEqual([]);
  });

  it('reads a list of many flights a page at a time and reports each once', async () => {
    state.skydio.flights = Array.from({ length: 230 }, (_, index) => ({
      flightId: `EXAMPLE-FLIGHT-${String(index + 1).padStart(4, '0')}`,
      vehicleSerial: `EXAMPLE-VEHICLE-${String((index % 4) + 1).padStart(2, '0')}`,
      takeoff: minutes(-30 * (index + 1)),
      landing: minutes(-30 * (index + 1) + 12),
      home,
    }));
    const sink = newSink();
    const { received } = await run(sink);
    expect(asked.slice(0, 3).map((path) => new URLSearchParams(path.split('?')[1]).get('page_number'))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(asked.slice(0, 3).every((path) => path.includes('per_page=100'))).toBe(true);
    expect(received).toHaveLength(230);
    expect(sink.current).toHaveLength(230);
    expect(new Set(sink.current.map((entry) => entry.observation.subject.id)).size).toBe(230);
    // Asked only for the flights that took off in the look-back before the clock: none older is listed.
    expect(asked[0]).toContain('takeoff_since=2026-11-13T16%3A00%3A00Z');
  });

  it('stops when the service refuses the token, without writing the token anywhere', async () => {
    const events: SourceLoopEvent[] = [];
    const secret = 'a-token-the-service-does-not-know';
    const poll = new ServicePoll(
      pollConfig({ headers: { authorization: secret }, log: (event) => events.push(event) }),
      async () => {
        throw new Error('Nothing is handed over when the token is refused');
      },
    );
    const failure = await poll.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceCredentialRefused);
    expect((failure as Error).message).toBe(
      'The service refused the access token with 401: issue a new one and start the process again',
    );
    expect(`${(failure as Error).message} ${JSON.stringify(events)}`).not.toContain(secret);
  });

  it('waits as long as the service asks when it answers 429, then reads on', async () => {
    state.skydio.rateLimited = 1;
    state.skydio.retryAfterSeconds = 1;
    const sink = newSink();
    const events: SourceLoopEvent[] = [];
    const started = Date.now();
    await run(sink, { log: (event) => events.push(event), retry: { initialMs: 1, maxMs: 4 } });
    expect(events).toMatchObject([{ event: 'poll_rate_limited', waitMs: 1000 }]);
    expect(events[0]!.message).toContain('asks for a wait of 1 s');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(reports(sink, 'EXAMPLE-FLIGHT-0001')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(config.flightServiceToken);
  });
});
