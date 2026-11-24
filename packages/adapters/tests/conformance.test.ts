import { describe, expect, it } from 'vitest';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type TranslateFunction,
  type TranslationContext,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from '../src/adapter-contract.js';
import { type GoldenFile, checkAdapterConformance, type ConformanceCheck } from '../src/conformance.js';

// A fictional vendor whose position report gives altitude in feet above mean sea level and speed in knots.
// The adapter is written only against the contract.
const descriptor: AdapterDescriptor = {
  id: 'fictivendor-position-report',
  version: '1.0.0',
  source: { vendor: 'Fictivendor', product: 'Fictivendor Fleet Feed', interface: 'HTTP POST /reports' },
  produces: [{ type: 'position.fix', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: ['Built from a fictional specification for tests.'],
  documentation: [{ reference: 'Fictional position report specification, revision 1.' }],
};

interface Flaws {
  forgetsKnots?: boolean;
  laxJson?: boolean;
  dropsUnknownFields?: boolean;
  readsClock?: boolean;
  omitsFix?: boolean;
  throwsOnMalformed?: boolean;
}
const known = ['report_id', 'time', 'unit', 'lat', 'lon', 'alt_ft', 'speed_kn'];

function translator(flaws: Flaws = {}): TranslateFunction<undefined> {
  return (message, context) => {
    let body: unknown;
    if (flaws.laxJson || flaws.throwsOnMalformed) {
      try {
        body = JSON.parse(new TextDecoder().decode(message.bytes));
      } catch (error) {
        if (flaws.throwsOnMalformed) throw error;
        return rejected('Body is not JSON');
      }
    } else {
      const decoded = decodeStrictJson(message.bytes, 4096);
      if (!decoded.ok) return rejected(decoded.reason);
      body = decoded.value;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return rejected('Body is not a JSON object');
    const report = body as Record<string, unknown>;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
    if (typeof report.report_id !== 'string' || typeof report.unit !== 'string') return rejected('Missing identity');
    if (!number(report.lat) || !number(report.lon) || !number(report.alt_ft) || !number(report.speed_kn))
      return rejected('Position fields must be numbers');
    const time = flaws.readsClock ? new Date().toISOString() : report.time;
    if (typeof time !== 'string' || !/Z$/.test(time) || !Number.isFinite(Date.parse(time)))
      return rejected('time must be a UTC instant');
    const subject = subjectFor(context.subjects, 'aircraft', report.unit);
    if (!subject) return rejected('No Ledger aircraft is bound to this unit');
    const speedKnots = report.speed_kn as number;
    const draft = {
      type: 'position.fix',
      version: 1,
      subject,
      occurredAt: new Date(Date.parse(time)).toISOString(),
      sourceEventId: report.report_id,
      position: {
        latitudeDegrees: report.lat as number,
        longitudeDegrees: report.lon as number,
        altitude: { meters: (report.alt_ft as number) * 0.3048, datum: 'mean_sea_level' },
      },
      values: {
        ...(flaws.omitsFix ? {} : { fix: 'three_dimensional' }),
        groundSpeedMetersPerSecond: flaws.forgetsKnots ? speedKnots : (speedKnots * 1852) / 3600,
      },
    } as ObservationDraft;
    return {
      drafts: [draft],
      rejections: [],
      unmapped: flaws.dropsUnknownFields ? [] : unknownKeys(report, known),
    };
  };
}
const adapterWith = (flaws: Flaws = {}, overrides: Partial<AdapterDescriptor> = {}): ObservationAdapter => ({
  descriptor: { ...descriptor, ...overrides },
  translate: translator(flaws),
});
const context: TranslationContext = { subjects: { scope: 'source' }, binding: undefined };

const transport = { method: 'POST', path: '/reports' };
const sample = {
  report_id: 'report-0001',
  time: '2026-10-01T17:00:00Z',
  unit: 'UNIT-ALPHA',
  lat: 41.88,
  lon: -87.63,
  alt_ft: 1000,
  speed_kn: 20,
  heading_mag: 270,
};
const message = (body: Partial<GoldenFile['message']>): GoldenFile['message'] => ({
  contentType: 'application/json',
  transport,
  capturedAt: '2026-10-01T17:00:00.400Z',
  ...body,
});
const expectedDraft = {
  type: 'position.fix',
  version: 1,
  subject: { kind: 'aircraft', id: 'UNIT-ALPHA', scope: 'source' },
  occurredAt: '2026-10-01T17:00:00.000Z',
  sourceEventId: 'report-0001',
  position: {
    latitudeDegrees: 41.88,
    longitudeDegrees: -87.63,
    altitude: { meters: 304.8, datum: 'mean_sea_level' },
  },
  values: { fix: 'three_dimensional', groundSpeedMetersPerSecond: 37040 / 3600 },
};
const conversions = [
  {
    observation: 0,
    field: '/position/latitudeDegrees',
    vendorField: '/lat',
    vendorUnit: 'deg',
    vendorValue: 41.88,
    expected: 41.88,
  },
  {
    observation: 0,
    field: '/position/longitudeDegrees',
    vendorField: '/lon',
    vendorUnit: 'deg',
    vendorValue: -87.63,
    expected: -87.63,
  },
  {
    observation: 0,
    field: '/position/altitude/meters',
    vendorField: '/alt_ft',
    vendorUnit: 'ft',
    vendorValue: 1000,
    expected: 304.8,
  },
  {
    observation: 0,
    field: '/values/groundSpeedMetersPerSecond',
    vendorField: '/speed_kn',
    vendorUnit: 'kn',
    vendorValue: 20,
    expected: 37040 / 3600,
  },
];
const goldens: GoldenFile<undefined>[] = [
  {
    name: 'valid.json',
    case: 'valid',
    message: message({ body: sample }),
    expect: {
      observations: [expectedDraft],
      rejections: [],
      unmapped: [jsonPointer('heading_mag')],
      conversions,
    },
  },
  {
    name: 'ambiguous.json',
    case: 'ambiguous',
    message: message({ bodyText: '{"report_id":"r","report_id":"s","unit":"UNIT-ALPHA"}' }),
    expect: { observations: [], rejections: [{ reasonIncludes: 'duplicate' }], unmapped: [] },
  },
  {
    name: 'malformed.json',
    case: 'malformed',
    message: message({ body: { ...sample, speed_kn: '20' } }),
    expect: { observations: [], rejections: [{ reasonIncludes: 'must be numbers' }], unmapped: [] },
  },
];

async function failedChecks(adapter: ObservationAdapter, files: GoldenFile<undefined>[] = goldens) {
  const report = await checkAdapterConformance({ adapter, context, goldens: files });
  return { report, checks: new Set<ConformanceCheck>(report.failures.map((failure) => failure.check)) };
}

describe('adapter conformance kit', () => {
  it('passes an adapter written only against the contract', async () => {
    const { report } = await failedChecks(adapterWith());
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checked.goldens).toBe(3);
    expect(report.checked.probes).toBeGreaterThan(5);
  });

  it('fails an adapter that silently drops a required unit conversion', async () => {
    const { report } = await failedChecks(adapterWith({ forgetsKnots: true }));
    expect(report.passed).toBe(false);
    expect(report.failures).toContainEqual({
      check: 'units',
      golden: 'valid.json',
      message: expect.stringContaining('produced 20, the unconverted vendor value in kn'),
    });
  });

  it('fails a golden file whose stated conversion is wrong, and a numeric field no golden file explains', async () => {
    const wrong = conversions.map((entry) => (entry.vendorUnit === 'ft' ? { ...entry, expected: 1000 } : entry));
    const missing = conversions.filter((entry) => entry.vendorUnit !== 'kn');
    for (const [files, text] of [
      [wrong, '1000 ft is 304.8'],
      [missing, 'no golden file states the vendor unit and expected value of position.fix@1 /values/groundSpeed'],
    ] as const) {
      const { report } = await failedChecks(adapterWith(), [
        { ...goldens[0]!, expect: { ...goldens[0]!.expect, conversions: files } },
        ...goldens.slice(1),
      ]);
      expect(report.failures.map((failure) => failure.message).join('\n')).toContain(text);
    }
  });

  it('fails an adapter that accepts ambiguous JSON', async () => {
    const { report, checks } = await failedChecks(adapterWith({ laxJson: true }));
    expect(checks).toContain('rejection');
    expect(report.failures.map((failure) => failure.message).join('\n')).toContain('repeated was not rejected');
  });

  it('fails an adapter that silently drops unknown vendor fields', async () => {
    const { report } = await failedChecks(adapterWith({ dropsUnknownFields: true }));
    expect(report.failures).toContainEqual({
      check: 'unmapped',
      golden: 'valid.json',
      message: expect.stringContaining('/conformanceProbeField was silently dropped'),
    });
  });

  it('fails an adapter whose output depends on the clock', async () => {
    const { checks } = await failedChecks(adapterWith({ readsClock: true }));
    expect(checks).toContain('purity');
  });

  it('fails an adapter that throws instead of rejecting', async () => {
    const { report } = await failedChecks(adapterWith({ throwsOnMalformed: true }));
    expect(report.failures).toContainEqual({
      check: 'no-throw',
      golden: 'valid.json',
      message: expect.stringContaining('translate threw on the sample truncated to half its length'),
    });
  });

  it('fails output that does not validate against the registered schema', async () => {
    const { report } = await failedChecks(adapterWith({ omitsFix: true }));
    expect(report.failures).toContainEqual({
      check: 'schema',
      golden: 'valid.json',
      message: expect.stringContaining("must have required property 'fix'"),
    });
  });

  it('fails undeclared observation types and vendor names in observation limitations', async () => {
    const undeclared = await failedChecks(adapterWith({}, { produces: [{ type: 'link.status', version: 1 }] }));
    expect(undeclared.checks).toContain('declared-types');
    const named = await failedChecks(
      adapterWith({}, { limitations: ['Fictivendor rounds speeds to whole knots.', 'Fleet times come from DJI.'] }),
    );
    expect(named.report.failures.filter((failure) => failure.check === 'vendor-names')).toHaveLength(2);
  });

  it('requires valid, malformed and ambiguous samples', async () => {
    const { report } = await failedChecks(adapterWith(), [goldens[0]!]);
    expect(report.failures.map((failure) => failure.message)).toEqual([
      'the golden files need at least one malformed sample',
      'the golden files need at least one ambiguous sample',
    ]);
  });
});
