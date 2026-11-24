import { Type, type Static } from '@sinclair/typebox';
import {
  AltitudeSchema,
  Closed,
  DocumentPurposeIdSchema,
  DocumentTypeIdSchema,
  ObservationId,
  ObservationIntervalSchema,
  ObservationPositionSchema,
  ObservationText,
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  Percent,
  UtcTime,
  observationHeader,
  observationProvenance,
  subjectOf,
} from './envelope.js';
import { isOperatorRecordDefinition } from './operator-records/define.js';
import type { ObservationTypeDefinition } from './registry.js';

const oneOf = <const Values extends readonly string[]>(values: Values, description?: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    description ? { description } : {},
  );
const optionalPosition = { position: Type.Optional(ObservationPositionSchema) };
const at = { occurredAt: UtcTime };

// link.status v1 -----------------------------------------------------------------------------------------------
const linkSubjects = ['flight', 'aircraft'] as const;
export const LinkStatusObservationV1Schema = Type.Object(
  {
    ...observationHeader('link.status', 1),
    subject: subjectOf(linkSubjects),
    secondarySubject: Type.Optional(subjectOf(linkSubjects)),
    ...at,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        link: oneOf(['command_control', 'video', 'payload_data'], 'Which link the state describes.'),
        state: oneOf(['up', 'degraded', 'down', 'unknown']),
        report: oneOf(
          ['transition', 'sample'],
          'transition: the source says the state began at occurredAt. sample: the state held at occurredAt.',
        ),
        sourceEpisodeId: Type.Optional(ObservationId),
        signalQualityPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100, title: 'Signal quality (%)' })),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'Reported state of one aircraft link at one instant.' },
);
export type LinkStatusObservationV1 = Static<typeof LinkStatusObservationV1Schema>;
export const linkStatusV1: ObservationTypeDefinition = {
  type: 'link.status',
  version: 1,
  title: 'Link status',
  timing: 'instant',
  intervalRequired: false,
  subjectKinds: linkSubjects,
  secondarySubjectKinds: linkSubjects,
  description: 'Reported state of one aircraft link (command and control, video or payload data) at one instant.',
  mayInfer: [
    'The source reported this link state at occurredAt.',
    'A transition down followed by a transition up with the same sourceEpisodeId bounds one reported loss episode.',
  ],
  mayNotInfer: [
    'Absence of a link-status observation is not evidence that the link was up.',
    'A sample of up does not show the link was up between samples.',
    'A transition up without a matching sourceEpisodeId does not close an earlier reported loss.',
    'unknown is not down.',
  ],
  schema: LinkStatusObservationV1Schema,
};

// battery.state v1 ---------------------------------------------------------------------------------------------
const batterySubjects = ['aircraft', 'flight'] as const;
const batterySecondarySubjects = ['aircraft', 'flight', 'component'] as const;
export const BatteryStateObservationV1Schema = Type.Object(
  {
    ...observationHeader('battery.state', 1),
    subject: subjectOf(batterySubjects),
    secondarySubject: Type.Optional(subjectOf(batterySecondarySubjects)),
    ...at,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        totalRemainingPercent: Type.Number({
          minimum: 0,
          maximum: 100,
          title: 'Battery remaining (%)',
          description: 'State of charge across all packs as the aircraft reports it.',
        }),
        packs: Type.Optional(
          Type.Array(
            Type.Object(
              {
                serialNumber: Type.Optional(ObservationId),
                slotIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })),
                remainingPercent: Percent,
                voltageVolts: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
                temperatureCelsius: Type.Optional(Type.Number({ minimum: -100, maximum: 200 })),
              },
              Closed,
            ),
            { minItems: 1, maxItems: 16 },
          ),
        ),
        forcedLandingRemainingPercent: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 100,
            title: 'Forced-landing charge (%)',
            description: 'Charge at which the aircraft says it will land on its own, as computed by the aircraft.',
          }),
        ),
        returnHomeRemainingPercent: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 100,
            title: 'Return-home charge (%)',
            description: 'Charge the aircraft says it needs to return home, as computed by the aircraft.',
          }),
        ),
        remainingFlightTimeSeconds: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 1_000_000,
            title: 'Remaining flight time (s)',
            description: 'Flight time the aircraft estimates it has left.',
          }),
        ),
        lowWarningThresholdPercent: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 100,
            title: 'Low battery warning level (%)',
            description: 'User-set low battery warning level.',
          }),
        ),
        criticalWarningThresholdPercent: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 100,
            title: 'Critical battery warning level (%)',
            description: 'User-set critical battery warning level.',
          }),
        ),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'Reported battery state of one aircraft at one instant.' },
);
export type BatteryStateObservationV1 = Static<typeof BatteryStateObservationV1Schema>;
export const batteryStateV1: ObservationTypeDefinition = {
  type: 'battery.state',
  version: 1,
  title: 'Battery state',
  timing: 'instant',
  intervalRequired: false,
  subjectKinds: batterySubjects,
  secondarySubjectKinds: batterySecondarySubjects,
  description:
    'Reported battery state at one instant: total charge, optional per-pack charge keyed by pack serial, and the warning levels in force.',
  mayInfer: [
    'The aircraft reported this charge at occurredAt.',
    'Whether reported charge was at or below a threshold stated in the same observation or in the rule.',
  ],
  mayNotInfer: [
    'Percentages are the aircraft’s state-of-charge estimates, not measured energy.',
    'Warning thresholds are user settings at that instant, not manufacturer or regulatory minimums.',
    'The forced-landing and return-home levels and the remaining flight time are the aircraft’s own calculations and change during flight.',
    'Absent voltage or temperature is not evidence that they were normal.',
    'Charge between two observations is not known.',
  ],
  schema: BatteryStateObservationV1Schema,
};

// position.fix v1 ----------------------------------------------------------------------------------------------
const positionSubjects = ['aircraft', 'flight', 'person'] as const;
export const PositionFixObservationV1Schema = Type.Object(
  {
    ...observationHeader('position.fix', 1),
    subject: subjectOf(positionSubjects),
    secondarySubject: Type.Optional(subjectOf(positionSubjects)),
    ...at,
    position: ObservationPositionSchema,
    ...observationProvenance,
    values: Type.Object(
      {
        fix: oneOf([
          'none',
          'two_dimensional',
          'three_dimensional',
          'differential',
          'rtk_float',
          'rtk_fixed',
          'unknown',
        ]),
        method: Type.Optional(oneOf(['satellite', 'vision', 'inertial', 'manual', 'unknown'])),
        satelliteCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, title: 'Satellites used' })),
        horizontalAccuracyMeters: Type.Optional(
          Type.Number({ minimum: 0, maximum: 100_000, title: 'Horizontal accuracy (m)' }),
        ),
        verticalAccuracyMeters: Type.Optional(
          Type.Number({ minimum: 0, maximum: 100_000, title: 'Vertical accuracy (m)' }),
        ),
        groundSpeedMetersPerSecond: Type.Optional(
          Type.Number({ minimum: 0, maximum: 500, title: 'Ground speed (m/s)' }),
        ),
        verticalSpeedMetersPerSecond: Type.Optional(
          Type.Number({ minimum: -500, maximum: 500, title: 'Vertical speed (m/s)' }),
        ),
        courseDegrees: Type.Optional(Type.Number({ minimum: 0, exclusiveMaximum: 360, title: 'Course (degrees)' })),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'Reported position of an aircraft or person at one instant, with its fix quality.' },
);
export type PositionFixObservationV1 = Static<typeof PositionFixObservationV1Schema>;
export const positionFixV1: ObservationTypeDefinition = {
  type: 'position.fix',
  version: 1,
  title: 'Position',
  timing: 'instant',
  intervalRequired: false,
  subjectKinds: positionSubjects,
  secondarySubjectKinds: positionSubjects,
  description:
    'Reported position (required) of an aircraft, flight or person at one instant, with fix type and optional accuracy.',
  mayInfer: [
    'The source placed the subject at this position at occurredAt.',
    'Altitude may be compared with a limit only when its datum matches the limit’s datum.',
  ],
  mayNotInfer: [
    'A fix of none or unknown is not a reliable location.',
    'Absent accuracy is not high accuracy.',
    'An altitude with datum unknown cannot be compared with any limit.',
    'The path between two fixes is not known; missing fixes are not evidence of packet loss or of staying in place.',
  ],
  schema: PositionFixObservationV1Schema,
};

// weather.wind v1 ----------------------------------------------------------------------------------------------
const windSubjects = ['flight', 'aircraft', 'site'] as const;
export const WindObservationV1Schema = Type.Object(
  {
    ...observationHeader('weather.wind', 1),
    subject: subjectOf(windSubjects),
    secondarySubject: Type.Optional(subjectOf(windSubjects)),
    ...at,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        method: oneOf(
          ['measured', 'estimated', 'forecast'],
          'measured: an anemometer or equivalent sensor. estimated: derived, for example by the aircraft from its attitude. forecast: predicted.',
        ),
        speedMetersPerSecond: Type.Number({ minimum: 0, maximum: 150, title: 'Wind speed (m/s)' }),
        gustSpeedMetersPerSecond: Type.Optional(Type.Number({ minimum: 0, maximum: 150, title: 'Gust speed (m/s)' })),
        directionFromDegrees: Type.Optional(
          Type.Number({
            minimum: 0,
            exclusiveMaximum: 360,
            title: 'Wind direction (degrees)',
            description: 'True direction the wind blows from.',
          }),
        ),
        heightAboveGroundMeters: Type.Optional(
          Type.Number({ minimum: 0, maximum: 10_000, title: 'Measured height above ground (m)' }),
        ),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'Reported wind at one instant, stating whether it was measured, estimated or forecast.' },
);
export type WindObservationV1 = Static<typeof WindObservationV1Schema>;
export const windV1: ObservationTypeDefinition = {
  type: 'weather.wind',
  version: 1,
  title: 'Wind reading',
  timing: 'instant',
  intervalRequired: false,
  subjectKinds: windSubjects,
  secondarySubjectKinds: windSubjects,
  description: 'Reported wind speed at one instant, with how it was obtained.',
  mayInfer: ['The source reported this wind, obtained by the stated method, at occurredAt.'],
  mayNotInfer: [
    'An estimated wind value is not a measurement.',
    'A forecast is not an observation of what happened.',
    'Wind estimated by an aircraft applies at the aircraft, not at ground level or at the site.',
    'Absent gust speed is not evidence of no gusts.',
    'Absence of wind observations is not evidence of calm.',
  ],
  schema: WindObservationV1Schema,
};

// airspace.authorization v1 ------------------------------------------------------------------------------------
const authorizationSubjects = ['flight', 'organization'] as const;
export const AirspaceAuthorizationObservationV1Schema = Type.Object(
  {
    ...observationHeader('airspace.authorization', 1),
    subject: subjectOf(authorizationSubjects),
    secondarySubject: Type.Optional(subjectOf(authorizationSubjects)),
    ...at,
    interval: Type.Optional(ObservationIntervalSchema),
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        authorizationId: ObservationId,
        reportedStatus: oneOf(
          ['requested', 'approved', 'denied', 'cancelled', 'rescinded', 'revoked', 'expired', 'invalid', 'unknown'],
          'Status the issuing party reported, normalised by the adapter. It is the issuing party’s statement, not a Ledger result.',
        ),
        sourceStatusCode: Type.Optional(
          Type.String({ minLength: 1, maxLength: 200, description: 'The status code exactly as the source sent it.' }),
        ),
        ceiling: Type.Optional(AltitudeSchema),
        area: Type.Optional(
          Type.Object(
            {
              boundary: Type.Array(
                Type.Object(
                  {
                    latitudeDegrees: Type.Number({ minimum: -90, maximum: 90 }),
                    longitudeDegrees: Type.Number({ minimum: -180, maximum: 180 }),
                  },
                  Closed,
                ),
                {
                  minItems: 3,
                  maxItems: 1000,
                  description: 'The corners of the outer boundary, WGS84, in order; the last joins the first.',
                },
              ),
            },
            { ...Closed, description: 'The area the authorization covers, as the issuing party stated it.' },
          ),
        ),
      },
      Closed,
    ),
  },
  {
    ...Closed,
    description:
      'Reported status of one airspace authorization request; interval is the reported validity window when the source states one.',
  },
);
export type AirspaceAuthorizationObservationV1 = Static<typeof AirspaceAuthorizationObservationV1Schema>;
export const airspaceAuthorizationV1: ObservationTypeDefinition = {
  type: 'airspace.authorization',
  version: 1,
  title: 'Airspace authorization',
  timing: 'interval',
  intervalRequired: false,
  subjectKinds: authorizationSubjects,
  secondarySubjectKinds: authorizationSubjects,
  description:
    'Reported status of one airspace authorization request at occurredAt, with the reported validity interval, ceiling and area when stated.',
  mayInfer: [
    'The issuing party reported this status for this authorizationId at occurredAt.',
    'Whether an instant falls inside the reported interval, when an interval with an end is present.',
    'Whether a position falls inside the reported area, and a height at or below the reported ceiling in its datum.',
  ],
  mayNotInfer: [
    'A reported approval is recorded evidence, not legal clearance.',
    'Without an area, the place the authorization covers is not stated.',
    'Without an interval, the status cannot be placed in time beyond occurredAt.',
    'A later report with a different status is a change or a conflict; neither is silently preferred.',
    'unknown is not approved and not denied.',
  ],
  schema: AirspaceAuthorizationObservationV1Schema,
};

// flight.report v1 ---------------------------------------------------------------------------------------------
const flightReportSubjects = ['flight'] as const;
export const FlightReportObservationV1Schema = Type.Object(
  {
    ...observationHeader('flight.report', 1),
    subject: subjectOf(flightReportSubjects),
    secondarySubject: Type.Optional(subjectOf(['aircraft', 'person'])),
    ...at,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        activity: Type.Optional(oneOf(['planned', 'active', 'landed', 'cancelled'])),
        takeoffAt: Type.Optional(UtcTime),
        landingAt: Type.Optional(UtcTime),
      },
      { ...Closed, minProperties: 1 },
    ),
  },
  { ...Closed, description: 'A report about one flight’s activity and its takeoff and landing times.' },
);
export type FlightReportObservationV1 = Static<typeof FlightReportObservationV1Schema>;
export const flightReportV1: ObservationTypeDefinition = {
  type: 'flight.report',
  version: 1,
  title: 'Flight report',
  timing: 'event',
  intervalRequired: false,
  subjectKinds: flightReportSubjects,
  secondarySubjectKinds: ['aircraft', 'person'],
  description:
    'A report made at occurredAt about one flight: its activity, and the takeoff and landing times the reporter states.',
  mayInfer: [
    'The reporter stated this activity and these times at occurredAt.',
    'Two reports with different landingAt values for the same flight disagree.',
  ],
  mayNotInfer: [
    'occurredAt is when the report was made, not the landing time.',
    'activity landed without landingAt gives no landing time.',
    'Disagreeing times are not averaged or resolved by recency.',
    'Absence of a landing report is not evidence the flight is still airborne.',
  ],
  schema: FlightReportObservationV1Schema,
};

// traffic.alert v1 ---------------------------------------------------------------------------------------------
const trafficSubjects = ['flight', 'aircraft'] as const;
export const TrafficAlertObservationV1Schema = Type.Object(
  {
    ...observationHeader('traffic.alert', 1),
    subject: subjectOf(trafficSubjects),
    secondarySubject: Type.Optional(subjectOf(trafficSubjects)),
    ...at,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        level: oneOf(['advisory', 'caution', 'warning', 'unknown']),
        detection: Type.Optional(
          oneOf([
            'cooperative_broadcast',
            'remote_identification',
            'ground_radar',
            'onboard_sensor',
            'visual',
            'unknown',
          ]),
        ),
        intruderKind: Type.Optional(oneOf(['crewed_aircraft', 'uncrewed_aircraft', 'unknown'])),
        intruderIdentity: Type.Optional(ObservationId),
        intruderPosition: Type.Optional(ObservationPositionSchema),
        horizontalSeparationMeters: Type.Optional(
          Type.Number({ minimum: 0, maximum: 1_000_000, title: 'Horizontal separation (m)' }),
        ),
        verticalSeparationMeters: Type.Optional(
          Type.Number({ minimum: 0, maximum: 100_000, title: 'Vertical separation (m)' }),
        ),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'A traffic alert a detection system raised for one flight or aircraft.' },
);
export type TrafficAlertObservationV1 = Static<typeof TrafficAlertObservationV1Schema>;
export const trafficAlertV1: ObservationTypeDefinition = {
  type: 'traffic.alert',
  version: 1,
  title: 'Traffic alert',
  timing: 'event',
  intervalRequired: false,
  subjectKinds: trafficSubjects,
  secondarySubjectKinds: trafficSubjects,
  description: 'A traffic alert raised at occurredAt by a detection system, with the separation it estimated.',
  mayInfer: ['The detection system raised an alert of this level at occurredAt.'],
  mayNotInfer: [
    'An alert is not a determination that separation was lost.',
    'Separation values are the detection system’s estimates.',
    'Absence of alerts is not evidence of no traffic; detection coverage is not stated by this type.',
  ],
  schema: TrafficAlertObservationV1Schema,
};

// aircraft.fault v1 --------------------------------------------------------------------------------------------
const faultSubjects = ['aircraft', 'flight'] as const;
const faultSecondarySubjects = ['aircraft', 'flight', 'component'] as const;
export const AircraftFaultObservationV1Schema = Type.Object(
  {
    ...observationHeader('aircraft.fault', 1),
    subject: subjectOf(faultSubjects),
    secondarySubject: Type.Optional(subjectOf(faultSecondarySubjects)),
    ...at,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        change: oneOf(['raised', 'cleared']),
        severity: oneOf(['info', 'caution', 'warning', 'critical', 'unknown'], 'Severity as the source classifies it.'),
        system: oneOf([
          'propulsion',
          'power',
          'navigation',
          'link',
          'flight_control',
          'sensor',
          'payload',
          'airframe',
          'other',
          'unknown',
        ]),
        sourceFaultCode: Type.String({
          minLength: 1,
          maxLength: 200,
          description:
            'The fault code exactly as the source sent it, kept for people. Rules must not match on it; they read system and severity, which the adapter maps from source codes.',
        }),
        summary: Type.Optional(ObservationText),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'A fault the aircraft or its software raised or cleared.' },
);
export type AircraftFaultObservationV1 = Static<typeof AircraftFaultObservationV1Schema>;
export const aircraftFaultV1: ObservationTypeDefinition = {
  type: 'aircraft.fault',
  version: 1,
  title: 'Aircraft fault',
  timing: 'event',
  intervalRequired: false,
  subjectKinds: faultSubjects,
  secondarySubjectKinds: faultSecondarySubjects,
  description: 'A fault raised or cleared at occurredAt, with source severity, affected system and source fault code.',
  mayInfer: ['The source raised or cleared this fault at occurredAt, with this severity and system.'],
  mayNotInfer: [
    'Severity is the source’s classification, not an airworthiness finding.',
    'cleared means the source stopped reporting the fault, not that it was repaired.',
    'Rules must not match on sourceFaultCode; it means something only within the source that sent it.',
    'Absence of fault observations is not evidence the aircraft was healthy.',
  ],
  schema: AircraftFaultObservationV1Schema,
};

// crew.duty-period v1 ------------------------------------------------------------------------------------------
const crewSubjects = ['person'] as const;
export const CrewDutyPeriodObservationV1Schema = Type.Object(
  {
    ...observationHeader('crew.duty-period', 1),
    subject: subjectOf(crewSubjects),
    secondarySubject: Type.Optional(subjectOf(['organization', 'flight'])),
    ...at,
    interval: ObservationIntervalSchema,
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        period: oneOf(['duty', 'flight_duty', 'rest']),
        role: Type.Optional(oneOf(['remote_pilot', 'visual_observer', 'payload_operator', 'other'])),
      },
      Closed,
    ),
  },
  { ...Closed, description: 'A reported duty, flight-duty or rest period of one person.' },
);
export type CrewDutyPeriodObservationV1 = Static<typeof CrewDutyPeriodObservationV1Schema>;
export const crewDutyPeriodV1: ObservationTypeDefinition = {
  type: 'crew.duty-period',
  version: 1,
  // Duty and rest periods are the organization's own roster entries, corrected and replaced by people.
  keptRecord: true,
  title: 'Duty period',
  timing: 'interval',
  intervalRequired: true,
  subjectKinds: crewSubjects,
  secondarySubjectKinds: ['organization', 'flight'],
  description: 'A duty, flight-duty or rest period of one person over [interval.start, interval.end).',
  mayInfer: ['The source recorded this period for this person.'],
  mayNotInfer: [
    'An absent end means no end was reported, not that the person is still on duty.',
    'A gap between reported periods is not rest unless a rest period is reported.',
    'Self-reported and scheduled periods are not the same as recorded ones; fidelity and limitations say which.',
  ],
  schema: CrewDutyPeriodObservationV1Schema,
};

// organization.record-in-force v1 ------------------------------------------------------------------------------
const recordInForceSubjects = ['organization'] as const;
export const recordInForceKindValues = ['document', 'risk_matrix', 'hazard', 'assurance'] as const;
export const RecordInForceObservationV1Schema = Type.Object(
  {
    ...observationHeader('organization.record-in-force', 1),
    subject: subjectOf(recordInForceSubjects),
    ...at,
    interval: ObservationIntervalSchema,
    ...observationProvenance,
    values: Type.Object(
      {
        recordKind: oneOf(
          recordInForceKindValues,
          'document: an issued revision of a controlled document. risk_matrix: an adopted risk matrix version. hazard: a hazard on the register. assurance: a signed safety assurance record, or an action it set.',
        ),
        recordId: ObservationId,
        decisionId: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description: 'The decision that put this revision in force: the document issue or the matrix adoption.',
          }),
        ),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        revision: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        documentType: Type.Optional(DocumentTypeIdSchema),
        purposes: Type.Array(DocumentPurposeIdSchema, {
          maxItems: 50,
          uniqueItems: true,
          description: 'The purposes the issued revision serves, as a person ticked them.',
        }),
        riskAssessed: Type.Optional(
          Type.Boolean({ description: 'A hazard: its risk is assessed on the risk matrix.' }),
        ),
        riskAccepted: Type.Optional(Type.Boolean({ description: 'A hazard: its assessed risk is accepted.' })),
        item: Type.Optional(
          oneOf(
            ['record', 'action'] as const,
            'A safety assurance record: the record itself, on file from its first signature, or an action it set, in force while it is open.',
          ),
        ),
        assuranceType: Type.Optional(
          Type.String({
            pattern: '^[a-z][a-z_]{0,39}$',
            description: 'A safety assurance record: its type, such as audit or management_review.',
          }),
        ),
        recordClass: Type.Optional(
          Type.String({
            pattern: '^[a-z][a-z_]{0,39}$',
            description: 'The record class it carries under 14 CFR 5.97.',
          }),
        ),
        actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 20, description: 'An action: its id.' })),
        dueAt: Type.Optional(
          Type.String({
            format: 'date-time',
            description: 'An action: the instant it becomes overdue, the start of the day after its due date.',
          }),
        ),
      },
      Closed,
    ),
  },
  {
    ...Closed,
    description:
      'A record the organization keeps under document control or in its safety records, in force over interval: what kind it is, its title, revision and purposes. Never its content.',
  },
);
export type RecordInForceObservationV1 = Static<typeof RecordInForceObservationV1Schema>;
export const recordInForceV1: ObservationTypeDefinition = {
  type: 'organization.record-in-force',
  version: 1,
  // Ledger's own statement of a record the organization keeps in force.
  keptRecord: true,
  title: 'Record in force',
  timing: 'interval',
  intervalRequired: true,
  subjectKinds: recordInForceSubjects,
  secondarySubjectKinds: [],
  description:
    'Ledger’s statement that a controlled document revision, a risk matrix version, a hazard, a signed safety assurance record or an open action it set was on file and in force over [interval.start, interval.end). Recorded by Ledger from its own decisions, never by a source.',
  mayInfer: [
    'The record was on file and in force over the interval, as Ledger’s decisions on it stated at occurredAt.',
    'A document revision served the purposes listed, as the person who issued it ticked them.',
  ],
  mayNotInfer: [
    'Nothing about what the record says: its content is not here, and whether it meets a requirement is for a person.',
    'An absent end means no end was recorded yet, not that the record will stay in force.',
    'A hazard counted here says nothing about its severity or the report it came from.',
    'A safety assurance record or action counted here says nothing about what it found or what was done; an action out of force was closed by a person, which says nothing about whether it worked.',
  ],
  schema: RecordInForceObservationV1Schema,
};

// operator.record v1 -------------------------------------------------------------------------------------------
const recordSubjects = ['flight', 'aircraft', 'person', 'site', 'organization', 'component'] as const;
export const OperatorRecordObservationV1Schema = Type.Object(
  {
    ...observationHeader('operator.record', 1),
    subject: subjectOf(recordSubjects),
    secondarySubject: Type.Optional(subjectOf(recordSubjects)),
    ...at,
    interval: Type.Optional(ObservationIntervalSchema),
    ...optionalPosition,
    ...observationProvenance,
    values: Type.Object(
      {
        recordType: ObservationTypeIdSchema,
        recordVersion: ObservationVersionSchema,
        record: Type.Record(Type.String(), Type.Unknown(), {
          description: 'Validated separately against the registered schema of recordType at recordVersion.',
        }),
        dayOnly: Type.Optional(
          Type.Record(
            Type.String({ minLength: 1, maxLength: 200 }),
            Type.Object(
              {
                day: Type.String({ format: 'date', pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}$' }),
                timeZone: Type.String({ minLength: 1, maxLength: 100 }),
                nextDayAt: UtcTime,
              },
              Closed,
            ),
            {
              description:
                'Fields of the record given as a date alone (the field that places it in time, or a time a report or notice was made): the day in timeZone, and the first instant of the next day. The field holds the first instant of the day, or the end of the day (the first instant of the next day) for the field that ends the interval of the record.',
            },
          ),
        ),
        entered: Type.Optional(
          Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String({ minLength: 1, maxLength: 200 }), {
            description:
              'What was written for each field the import converted: a number with the unit it was written in, or a time with the zone it was read in. The record holds the stored value.',
          }),
        ),
      },
      Closed,
    ),
  },
  {
    ...Closed,
    description:
      'An imported operator record of a registered record type; interval is the record’s validity period when it has one.',
  },
);
export type OperatorRecordObservationV1 = Static<typeof OperatorRecordObservationV1Schema>;
export const operatorRecordV1: ObservationTypeDefinition = {
  type: 'operator.record',
  version: 1,
  keptRecord: true,
  title: 'Operator record',
  timing: 'interval',
  intervalRequired: false,
  subjectKinds: recordSubjects,
  secondarySubjectKinds: recordSubjects,
  description:
    'Carrier for an imported operator record. The record body is validated against the registered record type; the record type sets its own subject kinds and inferences.',
  mayInfer: ['The operator’s system held this record at occurredAt.'],
  mayNotInfer: [
    'A record whose recordType and recordVersion are not registered says nothing a rule can read.',
    'A record is the operator’s statement, not independent verification.',
  ],
  schema: OperatorRecordObservationV1Schema,
  referenceFields: (registry) =>
    Object.values(registry.recordTypes).flatMap((recordType) =>
      isOperatorRecordDefinition(recordType)
        ? recordType.fields.flatMap((field) =>
            field.kind === 'reference'
              ? [
                  {
                    field: `values.record.${field.name}`,
                    referenceKind: field.referenceKind,
                    when: [
                      { field: 'values.recordType', value: recordType.recordType },
                      { field: 'values.recordVersion', value: recordType.recordVersion },
                    ],
                  },
                ]
              : [],
          )
        : [],
    ),
};

export const observationTypesV1 = [
  linkStatusV1,
  batteryStateV1,
  positionFixV1,
  windV1,
  airspaceAuthorizationV1,
  flightReportV1,
  trafficAlertV1,
  aircraftFaultV1,
  crewDutyPeriodV1,
  operatorRecordV1,
  recordInForceV1,
] as const;

export type ObservationV1 =
  | LinkStatusObservationV1
  | BatteryStateObservationV1
  | PositionFixObservationV1
  | WindObservationV1
  | AirspaceAuthorizationObservationV1
  | FlightReportObservationV1
  | TrafficAlertObservationV1
  | AircraftFaultObservationV1
  | CrewDutyPeriodObservationV1
  | OperatorRecordObservationV1
  | RecordInForceObservationV1;
