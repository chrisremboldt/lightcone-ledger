import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../../integrity/src/index.js';
import {
  defineOperatorRecordType,
  findObservationType,
  findOperatorRecordDefinition,
  findOperatorRecordType,
  missingFields,
  missingReplayFields,
  missingRequiredFields,
  observedRecordBody,
  observedRecordValues,
  observationRegistryV1,
  standardObservationRegistry,
  operatorRecordTypesV1,
  personTrainingV1,
  recordField,
  registerOperatorRecordType,
  timeFieldNames,
  type OperatorRecordDefinition,
} from '../src/index.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<TSchema, ReturnType<typeof ajv.compile>>();
const validate = (schema: TSchema, value: unknown) => {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema)!(value) as boolean;
};
const clone = <T>(value: T): T => structuredClone(value);
const definitionOf = (recordType: string) => operatorRecordTypesV1.find((item) => item.recordType === recordType)!;

/** Complete, fictional examples: every required field filled. */
const examples: Record<string, Record<string, unknown>> = {
  'person.standing': {
    fullName: 'Robin Vale',
    qualificationSummary: 'Remote pilot certificate; operator line check 2026',
    duties: 'Pilot in command for inspection flights; standby flight coordinator.',
    employeeReference: 'EMP-0042',
    qualificationSource: 'Certificate copy in personnel file',
  },
  'person.certificate': {
    credentialKind: 'remote_pilot_certificate',
    credentialNumber: 'RP-1234567',
    recordedStatus: 'held',
    issuedOn: '2025-06-12',
    issuingBody: 'Civil aviation authority',
  },
  'person.training': {
    trainingKind: 'recurrent',
    courseTitle: 'Recurrent operations training',
    completedOn: '2026-09-14',
    evidenceReference: 'TRN-2026-0914-RV',
    materialsReference: 'Training manual rev 7',
    providerName: 'Example Flight Academy',
    providerAddress: '1 Hangar Road, Example City',
    programName: 'Line operations',
  },
  'person.employment': {
    employmentStatus: 'employed',
    functionStartedOn: '2025-01-06',
  },
  'crew.duty-period': {
    periodId: 'duty-rv-2026-10-15',
    period: 'flight_duty',
    startsAt: '2026-10-15T13:00:00Z',
    endsAt: '2026-10-15T23:00:00Z',
    role: 'remote_pilot',
  },
  'person.rest-assessment': {
    assessedAt: '2026-10-15T12:50:00Z',
    dutyPeriodId: { id: 'duty-rv-2026-10-15', scope: 'source' },
    restPeriodId: { id: 'rest-rv-2026-10-14', scope: 'source' },
    weeklyRestPeriodId: { id: 'rest-rv-week-41', scope: 'source' },
    calendarDayDutyHours: 10,
    weekStartsAt: '2026-10-12T06:00:00Z',
    weekDutyHours: 34.5,
    timeZone: 'America/Denver',
    scheduleReference: 'Roster week 42 v3',
  },
  'person.aircraft-experience': {
    role: 'flight_coordinator',
    aircraftMakeModel: 'Example Aero X4',
    supervisedHours: 6.5,
    supervisorReference: 'Supervised by chief pilot; log pages 12-14',
    recentHours: 22,
    recentPeriodStartsOn: '2025-11-01',
    recentPeriodEndsOn: '2026-10-31',
    qualificationReference: 'QUAL-FC-007',
  },
  'person.readiness-declaration': {
    declaredAt: '2026-10-15T12:45:00Z',
    medicalStatement: 'no_known_condition',
    substanceStatement: 'no_known_disqualification',
  },
  'aircraft.identity': {
    aircraftMakeModel: 'Example Aero X4',
    serialNumber: 'X4-000917',
    registrationNumber: 'FA3EXAMPLE',
    registrationExpiresOn: '2028-05-01',
    remoteIdentificationMethod: 'standard_broadcast',
  },
  'aircraft.time-in-service': {
    entryKind: 'opening_balance',
    totalTimeHours: 412.25,
    coveredThroughAt: '2026-06-30T23:59:59Z',
    sourceReference: 'Aircraft logbook vol. 2',
    coverage: 'complete',
    coverageNotes: 'Logbook covers every flight since delivery; reconciled with the fleet register.',
    flightCount: 1388,
  },
  'aircraft.inspection': {
    inspectionKind: 'manufacturer_interval',
    inspectedAt: '2026-09-30T16:00:00Z',
    nextDueAt: '2026-12-30T16:00:00Z',
    recordedResult: 'serviceable',
    inspectorName: 'Sam Okafor',
  },
  'aircraft.condition': {
    determinedAt: '2026-10-15T13:20:00Z',
    recordedCondition: 'no_unsafe_condition_known',
  },
  'aircraft.system-availability': {
    assessedAt: '2026-10-15T12:00:00Z',
    installedSiteId: { id: 'site-north-yard', scope: 'ledger' },
    dockId: { id: 'dock-07', scope: 'source' },
    dockStatus: 'available',
    controlLinkStatus: 'available',
    batteryId: { id: 'PACK-0001', scope: 'source' },
    batteryStatus: 'available',
    sensorStatus: 'unknown',
    firmwareVersion: '10.2.1',
    configurationReference: 'CFG-X4-2026-08',
    logExportStatus: 'delayed',
  },
  'aircraft.payload': { hazardousMaterial: 'not_hazardous', payloadDescription: 'Survey camera' },
  'maintenance.action': {
    actionDescription: 'Replaced front-left motor and updated flight controller firmware.',
    performedAt: '2026-10-01T15:30:00Z',
    performedByName: 'Sam Okafor',
    returnedToService: true,
    returnToServiceByName: 'Jo Marsh',
    returnToServiceBasis: 'Maintenance manual 4.2 functional check completed',
  },
  'component.inspection': {
    inspectionKind: 'scheduled',
    inspectedAt: '2026-10-01T15:00:00Z',
    nextDueAt: '2026-10-31T15:00:00Z',
    recordedResult: 'serviceable',
    inspectorName: 'Riley Example',
  },
  'component.life-limit': {
    partName: 'Propeller set',
    partNumber: 'PROP-24',
    aircraftId: { id: 'aircraft-n42', scope: 'source' },
    installedAt: '2026-08-01T10:00:00Z',
    lifeLimitHours: 200,
    partTimeAtInstallHours: 12.5,
  },
  'operation.role-assignment': {
    personId: { id: 'person-robin-vale', scope: 'ledger' },
    role: 'flight_coordinator',
    startsAt: '2026-10-15T14:00:00Z',
    endsAt: '2026-10-15T18:00:00Z',
  },
  'organization.coordinator-requirement': {
    coordinatorRequired: true,
    basis: 'manufacturer_instructions',
    basisReference: 'Flight manual section 2',
  },
  'operation.multiple-aircraft': {
    supervisingPersonId: { id: 'person-robin-vale', scope: 'ledger' },
    simultaneousAircraftCount: 3,
    manufacturerLimitCount: 5,
    methodLimitCount: 4,
    methodReference: 'Operations manual chapter 9',
  },
  'flight.plan': {
    windowStartsAt: '2026-10-15T14:00:00Z',
    windowEndsAt: '2026-10-15T16:00:00Z',
    operationKind: 'aerial_survey',
    plannedOriginDescription: 'North yard dock',
    plannedDestinationDescription: 'North yard dock',
    routeSummary: 'Grid survey of the east field, 12 legs.',
    siteId: { id: 'site-north-yard', scope: 'ledger' },
    visualMode: 'beyond_visual_line_of_sight',
    plannedMaxHeightAboveGroundMeters: 110,
    plannedMaxGroundSpeedMetersPerSecond: 12,
  },
  'flight.preflight-assessment': {
    assessedAt: '2026-10-15T13:30:00Z',
    weatherDetermination: 'Wind 4 m/s from the west, no precipitation forecast.',
    airspaceDetermination: 'Class G; no temporary restrictions.',
    groundHazardsDetermination: 'Field closed to the public; one access road watched.',
    participantsBriefing: 'Coordinator and observer briefed at 13:15.',
    linkEnergyLoadDetermination: 'Link checked; batteries at 100 percent; camera payload within limits.',
    visibilityMeters: 9000,
  },
  'flight.record': {
    takeoffAt: '2026-10-15T14:02:00Z',
    landingAt: '2026-10-15T14:31:00Z',
    takeoffLocation: 'North yard dock',
    landingLocations: 'North yard dock',
    maxHeightFlownAboveGroundMeters: 104.5,
    flightPathReference: 'track-2026-10-15-01',
  },
  'organization.operating-area': {
    areaId: 'RIDGE-AREA-2',
    shape: 'corridor',
    corridorPoints: '39.5200, -105.2600; 39.5600, -105.1900; 39.6100, -105.1500',
    corridorHalfWidthMeters: 150,
    startsAt: '2026-06-01T06:00:00Z',
    areaApprovalReference: 'COA-EX-2026-0102',
    alternateLandingAreas: 'Ridge road pullout; the pad at tower 18',
    takeoffLandingAreas: 'Ridge road pullout, gravel, closed to the public during operations',
    boundaryArtifactReference: 'areas/ridge-area-2.kml',
  },
  'site.status': { recordedAt: '2026-10-15T07:00:00Z', status: 'available' },
  'aircraft.detect-and-avoid': {
    checkedAt: '2026-10-15T06:30:00Z',
    equipmentReference: 'Cooperative and non-cooperative traffic receiver, configuration 3',
    equipmentState: 'serviceable',
  },
  'operation.notification': {
    notifiedAt: '2026-10-14T09:00:00Z',
    recipient: 'East field landowner',
    means: 'email',
    coveredOperations: 'Survey flights over the east field on 15 October.',
  },
  'organization.procedure': {
    procedureKind: 'lost_link',
    title: 'Lost control link',
    documentReference: 'Operations manual chapter 7',
    revision: 'C',
    effectiveAt: '2026-09-01T00:00:00Z',
  },
  'occurrence.mechanical-irregularity': {
    occurredAt: '2026-10-15T14:30:00Z',
    irregularityDescription: 'Front-left motor temperature warning in cruise.',
    correctiveAction: 'Landed; motor scheduled for replacement.',
  },
  'occurrence.emergency-deviation': {
    occurredAt: '2026-10-15T14:32:00Z',
    summary: 'Climbed above the planned height to avoid a crewed helicopter.',
  },
  'occurrence.security': {
    occurredAt: '2026-10-15T14:10:00Z',
    summary: 'Unidentified person attempted to open the dock lid.',
    breachKind: 'physical_access',
    reportedToAuthorityAt: '2026-10-17T09:00:00Z',
  },
  'occurrence.operation-anomaly': {
    occurredAt: '2026-10-15T14:20:00Z',
    summary: 'Two survey legs skipped after a link quality drop.',
    recordedSeverity: 'irregularity',
  },
  'occurrence.property-or-area': {
    occurredAt: '2026-10-15T14:25:00Z',
    summary: 'Aircraft crossed the boundary of the neighbouring field for 20 seconds.',
    eventKind: 'unauthorized_area',
    meetsReportingCriteria: 'not_determined',
  },
  'organization.report': {
    reportKind: 'flight_hours',
    recipient: 'Civil aviation authority',
    providedAt: '2026-10-05T10:00:00Z',
    periodStartsOn: '2026-09-01',
    periodEndsOn: '2026-09-30',
    reportReference: 'FH-2026-09',
  },
  'organization.review': {
    reviewKind: 'cybersecurity_policy',
    documentReference: 'Information security policy',
    reviewedAt: '2026-09-20T15:00:00Z',
    reviewedByName: 'Robin Vale',
    recordedOutcome: 'revised',
    revisionAfterReview: 'D',
  },
  'occurrence.accident': {
    occurredAt: '2026-10-15T14:40:00Z',
    accidentKind: 'property_damage',
    summary: 'Hard landing damaged a fence panel.',
    estimatedDamage: '650 USD',
  },
};

/** Each break makes the body invalid by shape, not by missing content. */
const breaks: Record<string, (body: Record<string, any>) => void> = {
  'person.standing': (b) => (b.fullName = ''),
  'person.certificate': (b) => (b.recordedStatus = 'valid'),
  'person.training': (b) => (b.completedOn = '14/09/2026'),
  'person.employment': (b) => (b.employmentStatus = 'contractor'),
  'crew.duty-period': (b) => (b.period = 'standby'),
  'person.rest-assessment': (b) => (b.dutyPeriodId = 'duty-rv-2026-10-15'),
  'person.aircraft-experience': (b) => (b.recentHours = -1),
  'person.readiness-declaration': (b) => (b.medicalStatement = 'fit'),
  'aircraft.identity': (b) => (b.registrationNumber = '   '),
  'aircraft.time-in-service': (b) => (b.totalTime = 412.25),
  'aircraft.inspection': (b) => (b.recordedResult = 'airworthy'),
  'aircraft.condition': (b) => (b.recordedCondition = 'safe'),
  'aircraft.system-availability': (b) => (b.dockStatus = 'up'),
  'aircraft.payload': (b) => (b.hazardousMaterial = true),
  'maintenance.action': (b) => (b.returnedToService = 'yes'),
  'component.life-limit': (b) => (b.aircraftId = { id: 'aircraft-n42' }),
  'component.inspection': (b) => (b.recordedResult = 'fine'),
  'operation.role-assignment': (b) => (b.role = 'rpic'),
  'organization.coordinator-requirement': (b) => (b.coordinatorRequired = 'true'),
  'operation.multiple-aircraft': (b) => (b.simultaneousAircraftCount = 2.5),
  'flight.plan': (b) => (b.plannedMaxHeightAboveGroundFeet = 360),
  'flight.preflight-assessment': (b) => (b.weatherDetermination = ''),
  'flight.record': (b) => (b.maxHeightFlownAboveGroundMeters = '104.5'),
  'organization.operating-area': (b) => (b.corridorHalfWidthMeters = 50_001),
  'site.status': (b) => (b.status = 'open'),
  'aircraft.detect-and-avoid': (b) => (b.equipmentState = 'working'),
  'operation.notification': (b) => (b.notifiedAt = 'the day before'),
  'organization.procedure': (b) => (b.procedureKind = 'lost link'),
  'occurrence.mechanical-irregularity': (b) => (b.vendorCode = 'E-0x1A07'),
  'occurrence.emergency-deviation': (b) => (b.reportedToAuthorityAt = 'yesterday'),
  'occurrence.security': (b) => (b.summary = 42),
  'occurrence.operation-anomaly': (b) => (b.recordedSeverity = 'critical'),
  'occurrence.property-or-area': (b) => (b.occurredAt = '2026-10-15T14:25:00.1234Z'),
  'occurrence.accident': (b) => (b.accidentKind = 'fatal'),
  'organization.report': (b) => (b.periodStartsOn = '2026-09-31'),
  'organization.review': (b) => (b.recordedOutcome = 'approved'),
};

/** Builds the operator.record carrier for a body, taking its time from the fields the type names. */
function carrier(definition: OperatorRecordDefinition, body: Record<string, unknown>) {
  const time = definition.time;
  const statedAt = '2026-10-16T08:00:00Z';
  const occurredAt = time.meaning === 'interval' ? statedAt : time.atField ? body[time.atField] : statedAt;
  const interval =
    time.meaning === 'interval'
      ? { start: body[time.startField], ...(body[time.endField] ? { end: body[time.endField] } : {}) }
      : undefined;
  return {
    type: 'operator.record',
    version: 1,
    subject: { kind: definition.subjectKinds[0], id: 'subject-1', scope: 'source' },
    occurredAt,
    ...(interval ? { interval } : {}),
    fidelity: 'synthetic_contract',
    limitations: ['Synthetic example data.'],
    originalArtifactId: 'artifact-import-0001',
    originalLocator: { kind: 'json_pointer', value: '/rows/0' },
    values: { recordType: definition.recordType, recordVersion: definition.recordVersion, record: body },
  };
}

describe('operator record types v1', () => {
  it('defines the agreed record types', () => {
    expect(operatorRecordTypesV1.map((item) => `${item.recordType}@${item.recordVersion}`).sort()).toEqual(
      Object.keys(examples)
        .map((id) => `${id}@1`)
        .sort(),
    );
  });

  for (const definition of operatorRecordTypesV1) {
    describe(definition.recordType, () => {
      const example = examples[definition.recordType]!;

      it('validates a realistic example and rejects a broken one', () => {
        expect(validate(definition.schema, example), JSON.stringify(ajv.errors)).toBe(true);
        const broken = clone(example) as Record<string, any>;
        breaks[definition.recordType]!(broken);
        expect(validate(definition.schema, broken)).toBe(false);
      });

      it('rejects unknown fields and an empty body', () => {
        expect(validate(definition.schema, { ...example, sourceColumn: 'x' })).toBe(false);
        expect(validate(definition.schema, {})).toBe(false);
      });

      it('derives missing required fields and ignores replay-only ones', () => {
        expect(missingRequiredFields(definition, example)).toEqual([]);
        const requiredNames = definition.fields.filter((item) => item.required).map((item) => item.name);
        for (const name of requiredNames) {
          const { [name]: _removed, ...rest } = example;
          expect(missingRequiredFields(definition, rest), name).toEqual([name]);
          expect(validate(definition.schema, rest), `an incomplete record is still well formed: ${name}`).toBe(
            Object.keys(rest).length > 0,
          );
        }
        const withoutReplay = Object.fromEntries(
          Object.entries(example).filter(([name]) => !definition.fields.find((item) => item.name === name)?.replayOnly),
        );
        expect(missingRequiredFields(definition, withoutReplay)).toEqual([]);
        expect(missingReplayFields(definition, withoutReplay)).toEqual(
          definition.fields.filter((item) => item.replayOnly).map((item) => item.name),
        );
      });

      it('travels in the operator.record carrier with its time taken from the named fields', () => {
        if (definition.observed) {
          // Recorded as its own observation type: the values are every field but the id and time fields.
          const own = findObservationType(observationRegistryV1, definition.recordType, definition.recordVersion)!;
          const { values, ...rest } = carrier(definition, example);
          const observation = {
            ...rest,
            type: definition.recordType,
            sourceEventId: example[definition.observed.idField],
            values: observedRecordValues(definition, example),
          };
          expect(validate(own.schema, observation), JSON.stringify(ajv.errors)).toBe(true);
          expect(observedRecordBody(definition, observation)).toEqual(example);
          return;
        }
        const observation = carrier(definition, example);
        const envelope = findObservationType(observationRegistryV1, 'operator.record', 1)!;
        expect(validate(envelope.schema, observation), JSON.stringify(ajv.errors)).toBe(true);
        const found = findOperatorRecordDefinition(
          standardObservationRegistry,
          observation.values.recordType,
          observation.values.recordVersion,
        );
        expect(found).toBe(findOperatorRecordType(standardObservationRegistry, definition.recordType, 1));
        expect(validate(found!.schema, observation.values.record)).toBe(true);
      });

      it('keeps field metadata and schema in step', () => {
        const schema = definition.schema as unknown as {
          properties: Record<string, unknown>;
          required?: string[];
          additionalProperties: boolean;
        };
        expect(Object.keys(schema.properties)).toEqual(definition.fields.map((item) => item.name));
        expect(schema.required ?? []).toEqual([]);
        expect(schema.additionalProperties).toBe(false);
        for (const item of definition.fields) {
          expect(item.label.trim().length, item.name).toBeGreaterThan(0);
          expect(item.required && item.replayOnly, item.name).toBe(false);
          if (item.kind === 'select') expect(item.options.length, item.name).toBeGreaterThan(0);
        }
        for (const name of timeFieldNames(definition.time))
          expect(definition.fields.find((item) => item.name === name)?.kind).toBe('date_time');
        expect(definition.mayNotInfer.length).toBeGreaterThan(0);
        expect(definition.subjectKinds.length).toBeGreaterThan(0);
      });
    });
  }

  it('names numeric fields with their unit and time, date and reference fields by convention', () => {
    const units = /(Meters|MetersPerSecond|Percent|Degrees|Volts|Celsius|Seconds|Hours|Count|Index|Bytes)$/;
    const broken: string[] = [];
    for (const definition of operatorRecordTypesV1) {
      for (const item of definition.fields) {
        const where = `${definition.recordType}.${item.name}`;
        if (item.kind === 'number' && (!units.test(item.name) || !item.name.endsWith(item.unit))) broken.push(where);
        if (item.kind === 'date_time' && !item.name.endsWith('At')) broken.push(where);
        if (item.kind === 'date' && !item.name.endsWith('On')) broken.push(where);
        if (item.kind === 'reference' && !item.name.endsWith('Id')) broken.push(where);
        if (item.kind !== 'date_time' && item.name.endsWith('At')) broken.push(where);
      }
      const walk = (node: any, name: string) => {
        if (!node || typeof node !== 'object') return;
        if ((node.type === 'number' || node.type === 'integer') && !units.test(name)) broken.push(name);
        for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, key);
      };
      walk(definition.schema, definition.recordType);
    }
    expect(broken).toEqual([]);
  });

  it('accepts whole counts only and rejects blank text, local times and impossible dates', () => {
    const assignment = definitionOf('operation.role-assignment');
    expect(
      validate(assignment.schema, { ...examples['operation.role-assignment'], startsAt: '2026-10-15T14:00Z' }),
    ).toBe(false);
    const training = definitionOf('person.training');
    expect(validate(training.schema, { ...examples['person.training'], courseTitle: ' \t ' })).toBe(false);
    expect(validate(training.schema, { ...examples['person.training'], completedOn: '2026-13-40' })).toBe(false);
    expect(validate(training.schema, { ...examples['person.training'], completedOn: '0000-01-01' })).toBe(false);
  });

  it('treats false as an answer and blank text as missing', () => {
    const requirement = definitionOf('organization.coordinator-requirement');
    expect(missingRequiredFields(requirement, { coordinatorRequired: false, basis: 'none_found' })).toEqual([]);
    expect(missingRequiredFields(personTrainingV1, { ...examples['person.training'], courseTitle: '  ' })).toEqual([
      'courseTitle',
    ]);
  });

  it('lets a rule ask for its own fields but never for replay-only ones', () => {
    const training = personTrainingV1;
    const { providerAddress: _address, ...body } = examples['person.training']!;
    expect(missingFields(training, body, ['completedOn', 'providerName', 'providerAddress'])).toEqual([
      'providerAddress',
    ]);
    expect(() => missingFields(training, body, ['programName'])).toThrow(/replay only/);
    expect(() => missingFields(training, body, ['noSuchField'])).toThrow(/no field/);
  });

  it('refuses inconsistent definitions', () => {
    const base = {
      recordType: 'example.record',
      recordVersion: 1,
      title: 'Example',
      subjectKinds: ['person'],
      description: 'Example.',
      mayInfer: [],
      mayNotInfer: [],
    } as const;
    const at = recordField.dateTime('recordedAt', 'Recorded at', { required: true });
    expect(() =>
      defineOperatorRecordType({
        ...base,
        time: { meaning: 'as_of' },
        fields: [recordField.text('note', 'Note', { required: true, replayOnly: true })],
      }),
    ).toThrow(/required and replay only/);
    expect(() =>
      defineOperatorRecordType({
        ...base,
        time: { meaning: 'event', atField: 'recordedOn' },
        fields: [at, recordField.date('recordedOn', 'Recorded on', { required: true })],
      }),
    ).toThrow(/must be a date_time/);
    expect(() =>
      defineOperatorRecordType({
        ...base,
        time: { meaning: 'event', atField: 'recordedAt' },
        fields: [
          recordField.dateTime('recordedAt', 'Recorded at'),
          recordField.text('note', 'Note', { required: true }),
        ],
      }),
    ).toThrow(/must be required/);
    expect(() => defineOperatorRecordType({ ...base, time: { meaning: 'as_of' }, fields: [at, { ...at }] })).toThrow(
      /duplicate/,
    );
  });

  it('registers every type once, alongside the observation types', () => {
    for (const definition of operatorRecordTypesV1) {
      expect(findOperatorRecordDefinition(standardObservationRegistry, definition.recordType, 1)).toBe(
        findOperatorRecordType(standardObservationRegistry, definition.recordType, 1),
      );
      expect(findOperatorRecordType(observationRegistryV1, definition.recordType, 1)).toBeUndefined();
      expect(() => registerOperatorRecordType(standardObservationRegistry, definition)).toThrow(/already registered/);
    }
    expect(findObservationType(standardObservationRegistry, 'operator.record', 1)?.type).toBe('operator.record');
    expect(findOperatorRecordDefinition(standardObservationRegistry, 'person.training', 2)).toBeUndefined();
  });

  it('accepts references as an id with a stated scope', () => {
    const assignment = definitionOf('operation.role-assignment');
    const body = examples['operation.role-assignment']!;
    for (const personId of ['person-robin-vale', { id: 'person-robin-vale' }, { id: '', scope: 'ledger' }])
      expect(validate(assignment.schema, { ...body, personId }), JSON.stringify(personId)).toBe(false);
    expect(validate(assignment.schema, { ...body, personId: { id: 'EMP-0042', scope: 'source' } })).toBe(true);
  });

  it('never edits the structure of a published version', () => {
    // A changed digest means a published version's structure was edited; add a new version instead.
    const digests = Object.fromEntries(
      operatorRecordTypesV1.map((definition) => [
        `${definition.recordType}@${definition.recordVersion}`,
        recordStructureDigest(definition),
      ]),
    );
    expect(digests).toEqual(PUBLISHED_RECORD_DIGESTS);
  });

  it('pins structure but not wording', () => {
    const training = JSON.parse(JSON.stringify(personTrainingV1));
    const reworded = clone(training);
    reworded.description = 'Reworded.';
    reworded.title = 'Reworded.';
    reworded.mayNotInfer = ['Reworded.'];
    reworded.fields[0].label = 'Reworded.';
    reworded.fields[0].options[0].label = 'Reworded.';
    reworded.fields[3].help = 'Reworded.';
    reworded.schema.properties.courseTitle.description = 'Reworded.';
    expect(recordStructureDigest(reworded)).toBe(recordStructureDigest(training));
    const optional = clone(training);
    optional.fields[2].required = false;
    expect(recordStructureDigest(optional)).not.toBe(recordStructureDigest(training));
    const retimed = { ...clone(training), time: { meaning: 'event', atField: 'completedOn' } };
    expect(recordStructureDigest(retimed)).not.toBe(recordStructureDigest(training));
  });

  it('uses neutral wording and names no vendor, regulation section or real organization', () => {
    const vendors =
      /\b(dji|autel|skydio|parrot|yuneec|airhub|aloft|airmap|dronedeploy|flighthub|dedrone|wingcopter|ardupilot|px4|mavlink|airspace-?link|laanc)\b/i;
    const organizations = /\b(faa|easa|caa|casa|transport canada|nasa|icao)\b/i;
    const sections = /(§|\bcfr\b|\bnprm\b|\bpart\s*10[78]\b|\b10[78]\.\d+)/i;
    const verdicts =
      /\b(compliant|compliance|non-?compliant|authorized|airworthy|no-go|go\/no-go|is met|are met|requirement met|satisfies|satisfied)\b/i;
    for (const definition of operatorRecordTypesV1) {
      const identifiers = [definition.recordType, ...definition.fields.map((item) => item.name)].join(' ');
      const text = JSON.stringify(definition);
      for (const pattern of [vendors, organizations, sections]) {
        expect(identifiers, definition.recordType).not.toMatch(pattern);
        expect(text, definition.recordType).not.toMatch(pattern);
      }
      expect(text, definition.recordType).not.toMatch(verdicts);
    }
  });
});

const wording = new Set(['description', 'title', 'label', 'help', 'mayInfer', 'mayNotInfer']);
const stripWording = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(stripWording);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !wording.has(key))
      .map(([key, value]) => [key, stripWording(value)]),
  );
};
/** Digest of what a record version promises structurally: identity, subjects, time, field structure and schema. */
function recordStructureDigest(definition: OperatorRecordDefinition): string {
  const { recordType, recordVersion, subjectKinds, secondarySubjectKinds, time, fields, schema } = definition;
  return canonicalDigest(
    stripWording(
      JSON.parse(
        JSON.stringify({ recordType, recordVersion, subjectKinds, secondarySubjectKinds, time, fields, schema }),
      ),
    ) as Record<string, unknown>,
  );
}

const PUBLISHED_RECORD_DIGESTS: Record<string, string> = {
  'crew.duty-period@1': '17f9f93aa846bea5f01755ad8c012e4fd3669f4804dfb030856dbaaca0cbf6fd',
  'aircraft.detect-and-avoid@1': 'a810da75c6787f218c91c1e896b5217254d36231b87c33d8541760de74c7d4f6',
  'operation.notification@1': 'e2cd3212114fa80722b27bb0e1d378d21b2ef55313ef0201615a6e2ebabe4aec',
  'organization.procedure@1': '7a42fc33c931b0dd85960a7cafe5326a8d1bccaaf27ac32481962742b57977bf',
  'organization.report@1': '9ac27bb1d6a63139ababa8d6d8d00891d4d28b05f573108d3f13d0594d02fea7',
  'organization.review@1': '23c8ebee61790190baa9a54eb9e4de13e1152fcd387c16b412ba5dcf05f447e8',
  'aircraft.condition@1': '99cf60eb48952a5b54a42e3eeaa12c7a3c8a19d0f811cd70242a44283dc08130',
  'aircraft.identity@1': '08de9568b7953e385ab7230c25fef9cc269b680502c46722fc9ac88644f07328',
  'aircraft.inspection@1': '59a5013c729f10b10b22513171e2d4d78471aae04373209fd0b324eece67b612',
  'aircraft.payload@1': '22efdcb15cee7a591350b2f00b31e272d091c407e963974e8179214a5d7a7598',
  'aircraft.system-availability@1': '4027087f864fbbb4ea1e0977452042a236071e6eb1b38a73c8c488f0d9646c1f',
  'aircraft.time-in-service@1': '7e87593362913216e57e262d049c175f89e1568f6f91d0c9b24bf91098b9b623',
  'component.inspection@1': '1f2b4acc671869473b09961b17024aeb722c806854a9b1c4d72d9fa8b7117f5c',
  'component.life-limit@1': 'a527f0b24caa2838936de723dbe4ee3882228bb4f32ebb986e0658fb37dba21c',
  'flight.plan@1': 'aa7f894c3d58ad5a74b6a762a2a7e192ee567a8b7e4c3d252c7ae0d51fff701d',
  'flight.preflight-assessment@1': '1dfdd94bec345b18bd5b98fb2436a84a52e8c7675ee514ad9ffa1eab95ccf806',
  'flight.record@1': '9795121d9fd7cb870470e44ff910c5ca63024eb9f5996a1824d416a52d73bd80',
  'maintenance.action@1': '2ce0a3f0633fa118251202d9afe1f1df0b8463dd68c1c1054948093f8fb0030d',
  'occurrence.accident@1': 'ed56f04766a15a21148e49a6a3229a6f5e6b7e676a798d31ddeaeab9ffaea034',
  'occurrence.emergency-deviation@1': '318bd5ebc20c5ae4e01d56bb567a8491df62669d57888be9660fc848a3f63757',
  'occurrence.mechanical-irregularity@1': '7cfd5001f5fa1a844f6f963bbaacfe0711523dd140bc30dd6c1c56336cbcf804',
  'occurrence.operation-anomaly@1': '64391627cc65ac538490c66762580dc361a9087595468487c2740bf0e8a55939',
  'occurrence.property-or-area@1': 'd7549851e0f25ddda0c256e4afca168b3779eb42b98085e8ce14a1b39f420b72',
  'occurrence.security@1': '09b1c76f864db855d845461ab1651b538b8958d59136125c73ecf9769cd5ebb1',
  'operation.multiple-aircraft@1': 'ff0f99fcf4913cca0b4615e43fcab3d263263c8a015b6085ef237aef37f30d1d',
  'operation.role-assignment@1': '3148c48b69ca7b4524763c1d4e135a402a79433d0a2eacdc6956b51ee2570789',
  'organization.coordinator-requirement@1': '10c339fc71e871de3e6c93727cc55ec4557bc169dab028ec949b66bfeb6e9875',
  'person.aircraft-experience@1': '4b2b9b880241296dfc0c911a9447fbc438f32a79d5f5f584c53b32f59b81b198',
  'person.certificate@1': '871ba7330643ad56893549bba875906562bea869f315925f60920b6d73c87731',
  'person.employment@1': '73ee6025f2d8e5153e5ec1f038dc5fa010a55280eecd54ffae9cf0fe8be58317',
  'person.readiness-declaration@1': '93c018eb8c5016e040a6b2a36c5786f1683d78a21445979298b53828ab0ca3dd',
  'person.rest-assessment@1': '43b450bae8d32e628334f89af61335f67ec1ffe34659f3f942fbc00a29185b86',
  'person.standing@1': '1a057932b1cda53ad3b7e5b1dbe9d249dabc8ac3ac87255d20a022ab813352b0',
  'person.training@1': 'd81b4f011182e54b65fa0c2bd4d6551f09050b2af1d0ef2b9c3163dae237ac6e',
  'organization.operating-area@1': '69f49aca431d417ccbe94c1969a870e745bcad628bd3602f3016940414e5b72b',
  'site.status@1': '34bb54bfb8a3e66e90f044ee3aa35559aa2072c9dd5beff4661584f38976ed10',
};
