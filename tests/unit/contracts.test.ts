import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  CommandSchema,
  AuthorityPrincipalResponseSchema,
  FlightCreateSchema,
  InputSchema,
  TelemetrySegmentSchema,
  UploadCreateSchema,
} from '../../packages/contracts/src/index.js';
import { principalAuthority } from '../../packages/contracts/fixtures/demo/v1/authority.js';
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
describe('Public authority boundary contracts', () => {
  it('describes complete current authority without credential or authentication fields', () => {
    const validate = ajv.compile(AuthorityPrincipalResponseSchema);
    expect(validate(principalAuthority)).toBe(true);
    expect(validate({ principal: { ...principalAuthority.principal, signInSubject: 'private-subject' } })).toBe(false);
    const { monitoringSources, ...incomplete } = principalAuthority.principal;
    expect(validate({ principal: incomplete })).toBe(false);
  });
  it('does not accept tenant or principal authority from an input body', () => {
    const validate = ajv.compile(InputSchema);
    const input = {
      sourceId: 'source-a',
      kind: 'flight.observation',
      occurredAt: '2026-10-01T12:00:00Z',
      subject: {},
      payload: { activity: 'active' },
    };
    expect(validate(input)).toBe(true);
    expect(validate({ ...input, tenantId: 'another-tenant' })).toBe(false);
    expect(validate({ ...input, principalId: 'admin' })).toBe(false);
  });
  it('requires an explicit displayed basis for a local decision', () => {
    const validate = ajv.compile(CommandSchema);
    const decision = {
      kind: 'decision.record',
      flightId: 'flight-a',
      expectedRevision: 3,
      expectedBasisRevision: 4,
      inputCut: { streams: { 'flight:flight-a': 3 }, principalRevision: 1 },
      expectedDependencyBasis: 'a'.repeat(64),
      decision: { kind: 'synthetic.dispatch', note: 'Observed basis inspected.' },
    };
    expect(validate(decision)).toBe(true);
    const { inputCut, ...withoutCut } = decision;
    expect(validate(withoutCut)).toBe(false);
    expect(validate({ ...decision, actorId: 'someone-else' })).toBe(false);
  });
  it('bounds artifact bytes and command text before processing', () => {
    const upload = ajv.compile(UploadCreateSchema);
    expect(upload({ contentType: 'application/json', byteLength: 10 * 1024 * 1024 })).toBe(true);
    expect(upload({ contentType: 'application/json', byteLength: 10 * 1024 * 1024 + 1 })).toBe(false);
    const flight = ajv.compile(FlightCreateSchema);
    expect(flight({ originationKey: 'order-42:attempt-1', orderRefs: [{ orderId: 'order-42', revision: 2 }] })).toBe(
      true,
    );
    expect(
      flight({
        originationKey: 'order-42',
        aliases: [{ sourceId: 'vendor', externalId: 'aircraft-42', tenantId: 'other' }],
      }),
    ).toBe(false);
  });
  it('requires a bounded descriptor and retained artifact for telemetry intake', () => {
    const validate = ajv.compile(InputSchema);
    const payload = {
      format: 'ledger.telemetry-segment.1',
      deviceId: 'DJI-ALPHA-01',
      gatewayId: 'DJI-ALPHA-GATEWAY',
      decoderVersion: 'dji-osd.synthetic.1',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 0,
      sampleCount: 2,
      firstSequence: 0,
      lastSequence: 1,
      firstOccurredAt: '2026-10-01T12:00:00Z',
      lastOccurredAt: '2026-10-01T12:00:02Z',
    };
    const input = {
      sourceId: 'dji',
      sourceSessionId: 'capture-one',
      artifactId: 'retained',
      kind: 'telemetry.segment',
      fidelity: 'synthetic_contract',
      occurredAt: payload.firstOccurredAt,
      subject: {},
      payload,
    };
    expect(validate(input)).toBe(true);
    expect(validate({ ...input, artifactId: undefined })).toBe(false);
    expect(validate({ ...input, sourceSessionId: undefined })).toBe(false);
    expect(validate({ ...input, fidelity: 'documented_schema_conformant' })).toBe(false);
    expect(validate({ ...input, payload: { ...payload, sampleCount: 121 } })).toBe(false);
    expect(validate({ ...input, payload: { ...payload, sequenceBasis: 'dji_packet_counter' } })).toBe(false);
    expect(validate({ ...input, payload: { ...payload, samples: [] } })).toBe(false);
  });
  it('bounds coordinate ranges and distinguishes unknown altitude from zero', () => {
    const validate = ajv.compile(TelemetrySegmentSchema);
    const sample = {
      sequence: 0,
      occurredAt: '2026-10-01T12:00:00Z',
      latitude: 33,
      longitude: -84,
      altitudeMeters: null,
      altitudeReference: 'unknown',
      original: { topic: 'thing/product/DJI-ALPHA-01/osd', bytesBase64: 'e30=' },
    };
    const segment = {
      format: 'ledger.telemetry-segment.1',
      sourceId: 'dji',
      sourceSessionId: 'capture-one',
      deviceId: 'DJI-ALPHA-01',
      gatewayId: 'DJI-ALPHA-GATEWAY',
      decoderVersion: 'dji-osd.synthetic.1',
      fidelity: 'synthetic_contract',
      coordinateReference: 'WGS84',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 0,
      samples: [sample],
    };
    expect(validate(segment)).toBe(true);
    expect(validate({ ...segment, samples: [{ ...sample, latitude: 91 }] })).toBe(false);
    expect(validate({ ...segment, samples: [{ ...sample, sequence: Number.MAX_SAFE_INTEGER + 1 }] })).toBe(false);
    expect(validate({ ...segment, samples: Array.from({ length: 121 }, () => sample) })).toBe(false);
    expect(validate({ ...segment, fidelity: 'validated_live' })).toBe(false);
  });
});
