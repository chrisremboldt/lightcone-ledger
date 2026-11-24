import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Type, type TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../../integrity/src/index.js';
import {
  ObservationHeaderSchema,
  emptyObservationRegistry,
  findObservationType,
  findOperatorRecordType,
  listObservationTypes,
  observationRegistryV1,
  observationTypesV1,
  registerObservationType,
  registerOperatorRecordType,
  type ObservationTypeDefinition,
  type ObservationV1,
} from '../src/index.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validator = (schema: TSchema) => ajv.compile(schema);
const clone = <T>(value: T): T => structuredClone(value);

const provenance = {
  sourceEventId: 'evt-0001',
  sourceSessionId: 'session-17',
  fidelity: 'synthetic_contract',
  limitations: ['Synthetic example data.'],
  originalArtifactId: 'artifact-0001',
} as const;
const flight = { kind: 'flight', id: 'flight-alpha-1', scope: 'ledger' } as const;
const aircraft = { kind: 'aircraft', id: 'aircraft-n42', scope: 'source' } as const;
const position = {
  latitudeDegrees: 40.0101,
  longitudeDegrees: -105.2702,
  altitude: { meters: 1712.4, datum: 'wgs84_ellipsoid' },
};

const examples: Record<string, ObservationV1> = {
  'link.status': {
    type: 'link.status',
    version: 1,
    subject: flight,
    secondarySubject: aircraft,
    occurredAt: '2026-10-15T14:05:00.250Z',
    position,
    ...provenance,
    values: { link: 'command_control', state: 'down', report: 'transition', sourceEpisodeId: 'episode-3' },
  },
  'battery.state': {
    type: 'battery.state',
    version: 1,
    subject: aircraft,
    secondarySubject: flight,
    occurredAt: '2026-10-15T14:06:00Z',
    ...provenance,
    values: {
      totalRemainingPercent: 41,
      packs: [
        { serialNumber: 'PACK-0001', slotIndex: 0, remainingPercent: 42 },
        { serialNumber: 'PACK-0002', slotIndex: 1, remainingPercent: 40, voltageVolts: 22.8, temperatureCelsius: 31 },
      ],
      forcedLandingRemainingPercent: 9,
      lowWarningThresholdPercent: 30,
      criticalWarningThresholdPercent: 15,
    },
  },
  'position.fix': {
    type: 'position.fix',
    version: 1,
    subject: aircraft,
    occurredAt: '2026-10-15T14:06:01Z',
    position,
    ...provenance,
    values: { fix: 'three_dimensional', method: 'satellite', satelliteCount: 17, groundSpeedMetersPerSecond: 8.2 },
  },
  'weather.wind': {
    type: 'weather.wind',
    version: 1,
    subject: flight,
    occurredAt: '2026-10-15T14:06:02Z',
    ...provenance,
    values: { method: 'estimated', speedMetersPerSecond: 6.5 },
  },
  'airspace.authorization': {
    type: 'airspace.authorization',
    version: 1,
    subject: { kind: 'flight', id: 'origination-key-9', scope: 'source' },
    occurredAt: '2026-10-15T13:00:00Z',
    interval: { start: '2026-10-15T13:30:00Z', end: '2026-10-15T15:30:00Z' },
    ...provenance,
    values: {
      authorizationId: 'auth-4471',
      reportedStatus: 'approved',
      sourceStatusCode: 'STATUS_APPROVED',
      ceiling: { meters: 60.96, datum: 'ground_level' },
      area: {
        boundary: [
          { latitudeDegrees: 41.87, longitudeDegrees: -87.64 },
          { latitudeDegrees: 41.89, longitudeDegrees: -87.64 },
          { latitudeDegrees: 41.89, longitudeDegrees: -87.62 },
          { latitudeDegrees: 41.87, longitudeDegrees: -87.62 },
        ],
      },
    },
  },
  'flight.report': {
    type: 'flight.report',
    version: 1,
    subject: flight,
    occurredAt: '2026-10-15T14:25:00Z',
    ...provenance,
    values: { activity: 'landed', takeoffAt: '2026-10-15T13:40:00Z', landingAt: '2026-10-15T14:20:00Z' },
  },
  'traffic.alert': {
    type: 'traffic.alert',
    version: 1,
    subject: flight,
    occurredAt: '2026-10-15T14:10:00Z',
    ...provenance,
    values: {
      level: 'caution',
      detection: 'cooperative_broadcast',
      intruderKind: 'crewed_aircraft',
      intruderIdentity: 'ICAO-A1B2C3',
      horizontalSeparationMeters: 1800,
      verticalSeparationMeters: 120,
    },
  },
  'aircraft.fault': {
    type: 'aircraft.fault',
    version: 1,
    subject: aircraft,
    occurredAt: '2026-10-15T14:12:00Z',
    ...provenance,
    values: { change: 'raised', severity: 'warning', system: 'propulsion', sourceFaultCode: 'E-0x1A07' },
  },
  'crew.duty-period': {
    type: 'crew.duty-period',
    version: 1,
    subject: { kind: 'person', id: 'person-lee', scope: 'ledger' },
    secondarySubject: { kind: 'organization', id: 'org-beta', scope: 'ledger' },
    occurredAt: '2026-10-15T18:00:00Z',
    interval: { start: '2026-10-15T08:00:00Z', end: '2026-10-15T17:30:00Z' },
    ...provenance,
    values: { period: 'duty', role: 'remote_pilot' },
  },
  'operator.record': {
    type: 'operator.record',
    version: 1,
    subject: aircraft,
    occurredAt: '2026-10-01T09:00:00Z',
    interval: { start: '2026-10-01T09:00:00Z', end: '2027-04-01T00:00:00Z' },
    ...provenance,
    values: {
      recordType: 'maintenance.inspection',
      recordVersion: 1,
      record: { inspectionKind: 'hundred_hour', result: 'serviceable' },
    },
  },
  'organization.record-in-force': {
    type: 'organization.record-in-force',
    version: 1,
    subject: { kind: 'organization', id: 'organization:tenant-1', scope: 'ledger' },
    occurredAt: '2026-10-01T09:00:00Z',
    interval: { start: '2026-10-02T00:00:00Z' },
    ...provenance,
    values: {
      recordKind: 'document',
      recordId: 'document-1',
      decisionId: 'issue-1',
      title: 'Safety policy',
      revision: 'Rev 3',
      purposes: ['example.safety-policy'],
    },
  },
};

/** Each break removes or corrupts one required or unit-bounded field. */
const breaks: Record<string, (observation: Record<string, any>) => void> = {
  'link.status': (o) => delete o.values.state,
  'battery.state': (o) => delete o.values.totalRemainingPercent,
  'position.fix': (o) => delete o.position,
  'weather.wind': (o) => delete o.values.method,
  'airspace.authorization': (o) => delete o.values.authorizationId,
  'flight.report': (o) => (o.values = {}),
  'traffic.alert': (o) => (o.values.level = 'severe'),
  'aircraft.fault': (o) => delete o.values.sourceFaultCode,
  'crew.duty-period': (o) => delete o.interval,
  'operator.record': (o) => (o.values.recordType = 'MaintenanceInspection'),
  'organization.record-in-force': (o) => (o.values.purposes = ['Not a purpose id']),
};

const check = (observation: unknown) => {
  const header = observation as { type: string; version: number };
  const definition = findObservationType(observationRegistryV1, header.type, header.version);
  if (!definition) throw new Error(`unregistered ${header.type}@${header.version}`);
  const validate = validator(definition.schema);
  return { valid: validate(observation), errors: validate.errors };
};

describe('observation vocabulary v1', () => {
  it('defines the agreed version 1 types', () => {
    expect(listObservationTypes(observationRegistryV1).map(({ type, version }) => `${type}@${version}`)).toEqual([
      'aircraft.fault@1',
      'airspace.authorization@1',
      'battery.state@1',
      'crew.duty-period@1',
      'flight.report@1',
      'link.status@1',
      'operator.record@1',
      'organization.record-in-force@1',
      'position.fix@1',
      'traffic.alert@1',
      'weather.wind@1',
    ]);
  });

  for (const definition of observationTypesV1) {
    describe(definition.type, () => {
      it('validates a realistic example and rejects a broken one', () => {
        const example = examples[definition.type]!;
        const result = check(example);
        expect(result.valid, JSON.stringify(result.errors)).toBe(true);
        const broken = clone(example) as Record<string, any>;
        breaks[definition.type]!(broken);
        expect(check(broken).valid).toBe(false);
      });

      it('rejects unknown properties on the envelope and in values', () => {
        expect(check({ ...clone(examples[definition.type]!), receivedAt: '2026-10-15T14:30:00Z' }).valid).toBe(false);
        const extraValue = clone(examples[definition.type]!) as Record<string, any>;
        extraValue.values.vendorField = 1;
        expect(check(extraValue).valid).toBe(false);
      });

      it('requires the envelope fields', () => {
        for (const field of [
          'type',
          'version',
          'subject',
          'occurredAt',
          'fidelity',
          'limitations',
          'originalArtifactId',
          'values',
        ]) {
          const missing = clone(examples[definition.type]!) as Record<string, unknown>;
          delete missing[field];
          const validate = validator(definition.schema);
          expect(validate(missing), field).toBe(false);
        }
      });

      it('accepts only its declared subject kinds and a stated subject scope', () => {
        const validate = validator(definition.schema);
        for (const kind of ['flight', 'aircraft', 'person', 'site', 'organization', 'component']) {
          const observation = clone(examples[definition.type]!) as Record<string, any>;
          observation.subject = { kind, id: 'subject-1', scope: 'ledger' };
          expect(validate(observation), kind).toBe(definition.subjectKinds.includes(kind as never));
        }
        const unscoped = clone(examples[definition.type]!) as Record<string, any>;
        delete unscoped.subject.scope;
        expect(validate(unscoped)).toBe(false);
      });

      it('keeps its definition consistent with its schema', () => {
        const schema = definition.schema as unknown as {
          required: string[];
          properties: Record<string, any>;
        };
        expect(schema.properties.type.const).toBe(definition.type);
        expect(schema.properties.version.const).toBe(definition.version);
        expect(schema.required.includes('interval')).toBe(definition.intervalRequired);
        expect('interval' in schema.properties).toBe(definition.timing === 'interval');
        expect(definition.mayNotInfer.length).toBeGreaterThan(0);
      });
    });
  }

  it('enforces UTC times, units and ranges', () => {
    const cases: Array<[string, (o: Record<string, any>) => void]> = [
      ['battery.state', (o) => (o.occurredAt = '2026-10-15T14:06:00+02:00')],
      ['battery.state', (o) => (o.values.totalRemainingPercent = 101)],
      ['battery.state', (o) => (o.values.packs[0].remainingPercent = -1)],
      ['battery.state', (o) => (o.values.packs[0].voltage = 22.8)],
      ['battery.state', (o) => (o.values.totalRemaining = 41)],
      ['weather.wind', (o) => (o.values.speedMetersPerSecond = -1)],
      ['weather.wind', (o) => (o.values.speedKnots = 12)],
      ['position.fix', (o) => (o.position.altitude = { meters: 100 })],
      ['position.fix', (o) => (o.position.latitudeDegrees = 91)],
      ['position.fix', (o) => (o.position.latitude = 40)],
      ['crew.duty-period', (o) => (o.interval.start = '2026-10-15 08:00:00')],
      ['battery.state', (o) => (o.interval = { start: '2026-10-15T14:00:00Z' })],
      ['link.status', (o) => (o.version = 2)],
    ];
    for (const [type, mutate] of cases) {
      const observation = clone(examples[type]!) as Record<string, any>;
      mutate(observation);
      expect(validator(findObservationType(observationRegistryV1, type, 1)!.schema)(observation), String(mutate)).toBe(
        false,
      );
    }
    const unknownDatum = clone(examples['position.fix']!) as Record<string, any>;
    unknownDatum.position.altitude = { meters: 100, datum: 'unknown' };
    expect(check(unknownDatum).valid).toBe(true);
  });

  it('accepts the published minimum for battery state: total percentage only, no voltage or temperature', () => {
    const minimal = clone(examples['battery.state']!) as Record<string, any>;
    minimal.values = { totalRemainingPercent: 55 };
    expect(check(minimal).valid).toBe(true);
  });

  it('names every numeric field with its unit', () => {
    const units =
      /(Meters|MetersPerSecond|Percent|Degrees|Volts|Celsius|Seconds|Hours|Count|Index|Version|Bytes|^meters|^version)$/;
    const numeric: string[] = [];
    const walk = (node: any, name: string) => {
      if (!node || typeof node !== 'object') return;
      if ((node.type === 'number' || node.type === 'integer') && !units.test(name)) numeric.push(name);
      for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, key);
      if (node.items) walk(node.items, name);
      for (const branch of node.anyOf ?? []) walk(branch, name);
    };
    for (const definition of observationTypesV1) walk(definition.schema, definition.type);
    expect(numeric).toEqual([]);
  });

  it('mentions no vendor in type ids, field names, descriptions or inference statements', () => {
    const vendors =
      /\b(dji|autel|skydio|parrot|yuneec|airhub|aloft|airmap|dronedeploy|flighthub|dedrone|wingcopter|ardupilot|px4|mavlink|airspace-?link|laanc)\b/i;
    const fieldNames: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        if (key === 'properties') fieldNames.push(...Object.keys(child as object));
        walk(child);
      }
    };
    for (const definition of observationTypesV1) {
      walk(definition.schema);
      expect(JSON.stringify(definition), definition.type).not.toMatch(vendors);
    }
    expect(fieldNames.join(' ')).not.toMatch(vendors);
  });

  it('never edits the structure of a published version', () => {
    // A changed digest means a published version's structure was edited; add a new version instead.
    const digests = Object.fromEntries(
      observationTypesV1.map((definition) => [`${definition.type}@${definition.version}`, structureDigest(definition)]),
    );
    expect(digests).toEqual(PUBLISHED_DIGESTS);
  });

  it('pins structure but not wording', () => {
    const battery = findObservationType(observationRegistryV1, 'battery.state', 1)!;
    const reworded = clone(JSON.parse(JSON.stringify(battery)));
    reworded.description = 'Reworded.';
    reworded.mayNotInfer = ['Reworded.'];
    reworded.schema.properties.values.properties.forcedLandingRemainingPercent.description = 'Reworded.';
    expect(structureDigest(reworded)).toBe(structureDigest(battery));
    const restructured = clone(JSON.parse(JSON.stringify(battery)));
    restructured.schema.properties.values.properties.totalRemainingPercent.maximum = 1;
    expect(structureDigest(restructured)).not.toBe(structureDigest(battery));
    const resubjected = { ...JSON.parse(JSON.stringify(battery)), subjectKinds: ['aircraft'] };
    expect(structureDigest(resubjected)).not.toBe(structureDigest(battery));
  });

  it('accepts an optional locator into the retained original', () => {
    const pointer = clone(examples['airspace.authorization']!) as Record<string, any>;
    pointer.originalLocator = { kind: 'json_pointer', value: '/operation/authorizations/2' };
    expect(check(pointer).valid).toBe(true);
    const range = clone(examples['position.fix']!) as Record<string, any>;
    range.originalLocator = { kind: 'byte_range', value: { offsetBytes: 1024, lengthBytes: 512 } };
    expect(check(range).valid).toBe(true);
    for (const originalLocator of [
      { kind: 'json_pointer', value: 'operation/authorizations' },
      { kind: 'byte_range', value: { offsetBytes: 0, lengthBytes: 0 } },
      { kind: 'byte_range', value: { start: 0, end: 10 } },
      { kind: 'line', value: 3 },
    ]) {
      expect(
        check({ ...clone(examples['position.fix']!), originalLocator }).valid,
        JSON.stringify(originalLocator),
      ).toBe(false);
    }
  });

  it('carries battery calculations and a component as the secondary subject', () => {
    const battery = clone(examples['battery.state']!) as Record<string, any>;
    battery.secondarySubject = { kind: 'component', id: 'PACK-0001', scope: 'source' };
    battery.values.returnHomeRemainingPercent = 22;
    battery.values.remainingFlightTimeSeconds = 640;
    expect(check(battery).valid).toBe(true);
    battery.values.remainingFlightTimeSeconds = -1;
    expect(check(battery).valid).toBe(false);
  });

  it('names the authorization status as the reported status', () => {
    const renamed = clone(examples['airspace.authorization']!) as Record<string, any>;
    renamed.values.status = renamed.values.reportedStatus;
    delete renamed.values.reportedStatus;
    expect(check(renamed).valid).toBe(false);
  });
});

describe('observation registry', () => {
  it('resolves a type by id and version', () => {
    expect(findObservationType(observationRegistryV1, 'battery.state', 1)?.type).toBe('battery.state');
    expect(findObservationType(observationRegistryV1, 'battery.state', 2)).toBeUndefined();
    expect(findObservationType(observationRegistryV1, 'battery', 1)).toBeUndefined();
    expect(findObservationType(observationRegistryV1, 'toString', 1)).toBeUndefined();
  });

  it('reads the header of any observation before full validation', () => {
    const header = validator(ObservationHeaderSchema);
    expect(header(examples['weather.wind'])).toBe(true);
    expect(header({ type: 'Weather.Wind', version: 1 })).toBe(false);
    expect(header({ type: 'weather.wind', version: 0 })).toBe(false);
  });

  it('registers a new version alongside the old one and refuses duplicates', () => {
    const windV2: ObservationTypeDefinition = {
      ...findObservationType(observationRegistryV1, 'weather.wind', 1)!,
      version: 2,
      schema: Type.Object({}),
    };
    const next = registerObservationType(observationRegistryV1, windV2);
    expect(findObservationType(next, 'weather.wind', 2)?.version).toBe(2);
    expect(findObservationType(next, 'weather.wind', 1)?.version).toBe(1);
    expect(findObservationType(observationRegistryV1, 'weather.wind', 2)).toBeUndefined();
    expect(() => registerObservationType(next, windV2)).toThrow(/already registered/);
    expect(() =>
      registerObservationType(observationRegistryV1, { ...windV2, version: 1, schema: Type.Object({}) }),
    ).toThrow(/already registered/);
    expect(Object.isFrozen(next.types)).toBe(true);
  });

  it('refuses malformed type ids and versions', () => {
    const base = findObservationType(observationRegistryV1, 'weather.wind', 1)!;
    for (const type of ['Weather.wind', 'weather', 'weather.wind.gust', 'weather_wind', '']) {
      expect(() => registerObservationType(emptyObservationRegistry, { ...base, type }), type).toThrow(/domain\.noun/);
    }
    for (const version of [0, 1.5, -1]) {
      expect(() => registerObservationType(emptyObservationRegistry, { ...base, version })).toThrow(/version/);
    }
  });

  it('plugs an operator record type into the operator.record carrier', () => {
    const inspection = {
      recordType: 'maintenance.inspection',
      recordVersion: 1,
      subjectKinds: ['aircraft'],
      description: 'Example record type used only by this test.',
      mayInfer: ['The operator recorded this inspection.'],
      mayNotInfer: ['A recorded inspection is not an airworthiness finding.'],
      schema: Type.Object(
        {
          inspectionKind: Type.String({ minLength: 1 }),
          result: Type.Union([Type.Literal('serviceable'), Type.Literal('unserviceable')]),
        },
        { additionalProperties: false },
      ),
    } as const;
    const registry = registerOperatorRecordType(observationRegistryV1, inspection);
    expect(() => registerOperatorRecordType(registry, inspection)).toThrow(/already registered/);
    const observation = examples['operator.record'] as Extract<ObservationV1, { type: 'operator.record' }>;
    expect(check(observation).valid).toBe(true);
    const recordType = findOperatorRecordType(
      registry,
      observation.values.recordType,
      observation.values.recordVersion,
    );
    expect(recordType?.recordType).toBe('maintenance.inspection');
    expect(validator(recordType!.schema)(observation.values.record)).toBe(true);
    expect(validator(recordType!.schema)({ ...observation.values.record, result: 'fine' })).toBe(false);
    expect(findOperatorRecordType(observationRegistryV1, 'maintenance.inspection', 1)).toBeUndefined();
  });
});

const stripWording = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(stripWording);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'description' && key !== 'title')
      .map(([key, value]) => [key, stripWording(value)]),
  );
};
/** Digest of what a version promises structurally: identity, timing, subject kinds and the schema without wording. */
function structureDigest(definition: ObservationTypeDefinition): string {
  const { type, version, timing, intervalRequired, subjectKinds, secondarySubjectKinds, schema } = definition;
  return canonicalDigest(
    stripWording(
      JSON.parse(
        JSON.stringify({ type, version, timing, intervalRequired, subjectKinds, secondarySubjectKinds, schema }),
      ),
    ) as Record<string, unknown>,
  );
}

const PUBLISHED_DIGESTS: Record<string, string> = {
  'aircraft.fault@1': '795c909776e3f6de5466819d295f5cbd274caa244d00ba690b3587caa20d94cb',
  'airspace.authorization@1': 'e18831bc554851e980d7205fbcc02ddff32bdaafdbdf6ddb5b5b66f4cae02026',
  'battery.state@1': '44004161d15fdf33e524cc1ed7ee4ce61c6c35d176c02d68b25f432cee8efb30',
  'crew.duty-period@1': 'ed612707c16c46053e7095a5c565ba1deef128184d48bbcbb5cf179f3d73bbdb',
  'flight.report@1': 'a4c64c0fe66a1431a690348044a442a3d6a792b330329ff39a54879f65b2337e',
  'link.status@1': '6fd8bde82c73d9d4f8dceeefebfe475c47b721502a1d2a59c780b6eec552086a',
  'operator.record@1': 'ccd1e34636b736668d199c153d26803f576a55d41c6fa058463582c5eb27af9b',
  'organization.record-in-force@1': '017efe903689e3dc85c79b5538a84d9bc3aa94f79b5310387f118990fd7403c0',
  'position.fix@1': 'e6f4abbd6356af9d5482048bdd0c36c6d956ba3c071cb97b19558ef41fd4da8d',
  'traffic.alert@1': '7f0111c64faf3f7336dcd2362aed12ef33e8cad1b86da21d7a5fde236ac94bde',
  'weather.wind@1': '3cb56a1677c28023e49b600771586bad0ac7c6bacfb46466d53b3c346aa1a3dc',
};
