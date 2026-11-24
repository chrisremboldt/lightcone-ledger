import { CORRIDOR_POINT_LIMIT, OPERATING_AREA_SIZE_LIMIT_METERS } from '../../operating-areas.js';
import { defineOperatorRecordType, recordField } from './define.js';

const sizeLimitWords = `${OPERATING_AREA_SIZE_LIMIT_METERS.toLocaleString('en-US')} m (${OPERATING_AREA_SIZE_LIMIT_METERS / 1000} km)`;

const required = { required: true } as const;
const replay = { replayOnly: true } as const;

export const operatingRoleValues = [
  ['operations_supervisor', 'Operations supervisor'],
  ['flight_coordinator', 'Flight coordinator'],
  ['pilot_in_command', 'Pilot in command'],
  ['person_manipulating_controls', 'Person manipulating the controls'],
  ['visual_observer', 'Visual observer'],
  ['payload_operator', 'Payload operator'],
  ['training_designee', 'Person responsible for training'],
  ['accountable_executive', 'Accountable executive'],
  ['other', 'Other'],
] as const;

export const operationRoleAssignmentV1 = defineOperatorRecordType({
  recordType: 'operation.role-assignment',
  recordVersion: 1,
  title: 'Role assignment',
  subjectKinds: ['flight', 'organization'],
  secondarySubjectKinds: ['organization', 'site', 'aircraft'],
  time: { meaning: 'interval', startField: 'startsAt', endField: 'endsAt' },
  description:
    'Who the operator recorded as holding one operating role for a flight (subject flight) or as a standing designation (subject organization), over a period, including any handover.',
  mayInfer: [
    'The operator recorded this person in this role over [startsAt, endsAt).',
    'One record names one person in one role; a flight with several roles has several records.',
  ],
  mayNotInfer: [
    'An organization-level designation does not by itself assign the person to a particular flight.',
    'An absent endsAt means no end was recorded.',
    'A role assignment says nothing about the person’s qualification, training or duty time.',
  ],
  fields: [
    recordField.reference('personId', 'Person', 'person', required),
    recordField.select('role', 'Role', operatingRoleValues, required),
    recordField.dateTime('startsAt', 'Starts at', required),
    recordField.dateTime('endsAt', 'Ends at'),
    recordField.reference('handoverFromPersonId', 'Taken over from', 'person', {
      help: 'Empty for the first assignment in this role.',
    }),
    recordField.text('handoverProcedureReference', 'Handover procedure reference'),
    recordField.longText('handoverBrief', 'Handover briefing', {
      help: 'Active aircraft, restrictions and deferred work passed on at handover.',
    }),
    recordField.dateTime('authorityNotifiedAt', 'Authority notified of the change at', {
      takesDate: true,
      help: 'For an operations supervisor: when the authority was told that this person took up the position.',
    }),
  ],
});

export const organizationCoordinatorRequirementV1 = defineOperatorRecordType({
  recordType: 'organization.coordinator-requirement',
  recordVersion: 1,
  title: 'Flight coordinator requirement',
  subjectKinds: ['organization', 'flight'],
  time: { meaning: 'as_of' },
  description:
    'Whether the operator recorded that manufacturer instructions or its authority documents call for a flight coordinator, and on what basis.',
  mayInfer: ['The operator recorded this coordinator requirement and its basis.'],
  mayNotInfer: [
    'The basis is the operator’s reading of the source document, not Ledger’s.',
    'This record does not name a coordinator; read operation.role-assignment.',
  ],
  fields: [
    recordField.boolean('coordinatorRequired', 'A flight coordinator is called for', required),
    recordField.select(
      'basis',
      'Basis',
      [
        ['manufacturer_instructions', 'Manufacturer instructions'],
        ['authority_documents', 'Operator’s authority documents'],
        ['operator_procedure', 'Operator’s own procedure'],
        ['none_found', 'No source calls for one'],
      ],
      required,
    ),
    recordField.text('basisReference', 'Source document reference'),
  ],
});

export const operationMultipleAircraftV1 = defineOperatorRecordType({
  recordType: 'operation.multiple-aircraft',
  recordVersion: 1,
  title: 'Multiple-aircraft operation',
  subjectKinds: ['flight', 'organization'],
  secondarySubjectKinds: ['organization'],
  time: { meaning: 'as_of' },
  description:
    'How many aircraft the operator recorded one person as supervising at the same time, with the manufacturer limit and the limit of the method the operator uses.',
  mayInfer: ['The operator recorded these counts, limits and method reference.'],
  mayNotInfer: [
    'The method reference is what the operator cited; its acceptance status is not recorded here.',
    'A planned count is not an observed count of aircraft in flight.',
  ],
  fields: [
    recordField.reference('supervisingPersonId', 'Supervising person', 'person'),
    recordField.number('simultaneousAircraftCount', 'Aircraft assigned at the same time', 'Count', required),
    recordField.number('manufacturerLimitCount', 'Manufacturer maximum', 'Count', required),
    recordField.number('methodLimitCount', 'Maximum under the operator’s method', 'Count', required),
    recordField.text('methodReference', 'Method reference', required),
  ],
});

export const flightPlanV1 = defineOperatorRecordType({
  recordType: 'flight.plan',
  recordVersion: 1,
  title: 'Flight plan',
  subjectKinds: ['flight'],
  secondarySubjectKinds: ['aircraft'],
  time: { meaning: 'interval', startField: 'windowStartsAt', endField: 'windowEndsAt' },
  nameFields: ['windowStartsAt', 'windowEndsAt', 'routeSummary'],
  description:
    'The planned flight: time window, kind of operation, route, operating site and the planned limits of height, speed and distance.',
  mayInfer: ['The operator planned this window, route and these limits for the flight.'],
  mayNotInfer: [
    'Planned limits are not flown values; read position and flight observations for those.',
    'A plan is not a record that the flight took place.',
  ],
  fields: [
    recordField.dateTime('windowStartsAt', 'Window starts', required),
    recordField.dateTime('windowEndsAt', 'Window ends', required),
    recordField.select(
      'operationKind',
      'Kind of operation',
      [
        ['aerial_survey', 'Aerial survey'],
        ['inspection', 'Inspection'],
        ['package_delivery', 'Package delivery'],
        ['agricultural', 'Agricultural'],
        ['training', 'Training'],
        ['test', 'Test or functional check'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('plannedOriginDescription', 'Planned origin', required),
    recordField.text('plannedDestinationDescription', 'Planned destination', required),
    recordField.longText('routeSummary', 'Route', required),
    recordField.reference('siteId', 'Operating site', 'site'),
    recordField.reference('dockId', 'Dock or ground station', 'component', {
      help: 'The dock or ground station the flight uses, by your own component id, when it uses one. A rule about the dock reads it from here.',
    }),
    recordField.select('visualMode', 'Visual line of sight', [
      ['visual_line_of_sight', 'Within visual line of sight'],
      ['beyond_visual_line_of_sight', 'Beyond visual line of sight'],
    ]),
    recordField.text('operatingAuthorityReference', 'Operating authority reference', {
      help: 'Certificate, waiver or exemption the operator cites for this flight, if any.',
    }),
    recordField.select('pilotInOperatingArea', 'Pilot located in the operating area', [
      ['yes', 'Yes'],
      ['no', 'No'],
    ]),
    recordField.number('plannedMaxHeightAboveGroundMeters', 'Planned maximum height above ground', 'Meters'),
    recordField.number('plannedMaxGroundSpeedMetersPerSecond', 'Planned maximum ground speed', 'MetersPerSecond'),
    recordField.number(
      'plannedMaxDistanceFromControlStationMeters',
      'Planned maximum distance from control station',
      'Meters',
    ),
    recordField.number('structureHeightMeters', 'Height of the structure flown near', 'Meters', {
      help: 'Lowest height of the structure or obstacle along segments flown above the usual height, from the same ground reference.',
    }),
    recordField.number('structureMaxDistanceMeters', 'Maximum horizontal distance from the structure', 'Meters'),
    recordField.text('structureBasisReference', 'Survey or route basis for flying near the structure'),
    recordField.longText('visualObserverCoverage', 'Visual observer coverage of the operating volume'),
  ],
});

export const flightPreflightAssessmentV1 = defineOperatorRecordType({
  recordType: 'flight.preflight-assessment',
  recordVersion: 1,
  title: 'Preflight assessment',
  subjectKinds: ['flight'],
  secondarySubjectKinds: ['aircraft', 'site'],
  time: { meaning: 'event', atField: 'assessedAt' },
  description:
    'The conditions the operator recorded before flight: weather and visibility, airspace and restrictions, ground hazards, briefing of participants, and control link, energy and load.',
  mayInfer: ['At assessedAt the operator recorded these preflight determinations.'],
  mayNotInfer: [
    'Each determination is the operator’s conclusion in its own words, not a measurement.',
    'Visibility and cloud clearances are the operator’s estimates unless a weather observation says otherwise.',
    'An airspace summary is not an airspace authorization; read airspace.authorization observations.',
  ],
  fields: [
    recordField.dateTime('assessedAt', 'Assessed at', required),
    recordField.longText('weatherDetermination', 'Local weather', required),
    recordField.longText('airspaceDetermination', 'Airspace and flight restrictions', required),
    recordField.longText('groundHazardsDetermination', 'People, property and ground hazards', required),
    recordField.longText('participantsBriefing', 'Participants briefed', required),
    recordField.longText('linkEnergyLoadDetermination', 'Control link, energy and load', required),
    recordField.number('visibilityMeters', 'Visibility from the control station', 'Meters'),
    recordField.number('cloudVerticalClearanceMeters', 'Distance below cloud', 'Meters'),
    recordField.number('cloudHorizontalClearanceMeters', 'Horizontal distance from cloud', 'Meters'),
    recordField.text('assessedByName', 'Assessed by', replay),
    recordField.dateTime('sourcesRetrievedAt', 'Weather and airspace sources retrieved at', replay),
  ],
});

export const flightRecordV1 = defineOperatorRecordType({
  recordType: 'flight.record',
  recordVersion: 1,
  title: 'Flight record',
  subjectKinds: ['flight'],
  secondarySubjectKinds: ['aircraft'],
  time: { meaning: 'interval', startField: 'takeoffAt', endField: 'landingAt' },
  description:
    'The operator’s own logbook entry for one flight as flown: when it took off and landed, where, the heights flown and the path, and the wind, visibility and battery the operator wrote down. The aircraft and its registration are aircraft.identity, the kind of operation is flight.plan and the people are operation.role-assignment records. A source may also report the times as flight.report observations, the wind as weather.wind and the battery as battery.state; rules read those first and this record otherwise.',
  mayInfer: [
    'The operator recorded that the flight took off at takeoffAt and landed at landingAt, at these places, heights and path.',
    'The operator recorded this wind, gust and visibility at takeoff and this battery remaining at landing.',
  ],
  mayNotInfer: [
    'Recorded times are the operator’s figures, not a source’s report.',
    'The flight path reference points at retained data; the path itself is in position.fix observations when they exist.',
    'Recorded heights are the operator’s figures, not position observations.',
    'Recorded wind, visibility and battery are the operator’s figures, not a sensor’s report; an absent gust is not evidence of no gusts.',
  ],
  fields: [
    recordField.dateTime('takeoffAt', 'Takeoff at', required),
    recordField.dateTime('landingAt', 'Landing at', required),
    recordField.text('takeoffLocation', 'Takeoff place', required),
    recordField.longText('landingLocations', 'Landing places, including diversions', required),
    recordField.number('maxHeightFlownAboveGroundMeters', 'Maximum height flown above ground', 'Meters', required),
    recordField.text('heightNotes', 'Other heights flown'),
    recordField.text('flightPathReference', 'Flight path reference', {
      help: 'Retained track or log file for the path actually flown.',
    }),
    recordField.number('windAtTakeoffMetersPerSecond', 'Wind at takeoff', 'MetersPerSecond', {
      maximum: 150,
      help: 'The sustained wind the operator recorded at takeoff.',
    }),
    recordField.number('gustAtTakeoffMetersPerSecond', 'Gust at takeoff', 'MetersPerSecond', {
      maximum: 150,
      help: 'The gust the operator recorded at takeoff, if any.',
    }),
    recordField.number('visibilityAtTakeoffMeters', 'Visibility at takeoff', 'Meters'),
    recordField.number('batteryAtLandingPercent', 'Battery remaining at landing', 'Percent', {
      help: 'The battery remaining the operator recorded at landing, in percent.',
    }),
    recordField.longText('weatherSummary', 'Weather', replay),
    recordField.text('missionName', 'Mission name', replay),
  ],
});

export const organizationOperatingAreaV1 = defineOperatorRecordType({
  recordType: 'organization.operating-area',
  recordVersion: 1,
  title: 'Operating area',
  subjectKinds: ['organization'],
  time: { meaning: 'interval', startField: 'startsAt', endField: 'endsAt' },
  description:
    'One area the organization operates in, by its own id: its shape (a circle by centre and radius, or a corridor by the points along a line and a half-width), when it is in force, the approval it holds for it, its alternate landing areas and its takeoff, landing and loading areas. An organization records one per area; every area in force is read together.',
  mayInfer: [
    'The operator recorded this area, with this shape, as in force from startsAt until endsAt (no end when none is recorded).',
  ],
  mayNotInfer: [
    'The shape is the operator’s; Ledger does not check it against maps or against the approval it names.',
    'A recorded area is not evidence a flight stayed inside it; the rule that reads positions says that.',
    'An absent endsAt means no end was recorded.',
  ],
  fields: [
    recordField.text('areaId', 'Area id', {
      ...required,
      help: 'Your own id for the area, such as RIDGE-AREA-1. Results name the area by it.',
    }),
    recordField.select(
      'shape',
      'Shape',
      [
        ['circle', 'Circle: a centre and a radius'],
        ['corridor', 'Corridor: points along a line and a half-width'],
      ],
      required,
    ),
    recordField.text('center', 'Centre of a circle', {
      help: 'Latitude, longitude in decimal degrees (WGS84), such as 39.5012, -105.2034.',
    }),
    recordField.number('radiusMeters', 'Radius of a circle', 'Meters', {
      maximum: OPERATING_AREA_SIZE_LIMIT_METERS,
      help: `At most ${sizeLimitWords}.`,
    }),
    recordField.longText('corridorPoints', 'Points along a corridor', {
      help: `The line the corridor follows, from 2 to ${CORRIDOR_POINT_LIMIT} points in order, each latitude, longitude in decimal degrees (WGS84), separated by semicolons, such as 39.50, -105.20; 39.52, -105.15.`,
    }),
    recordField.number('corridorHalfWidthMeters', 'Half-width of a corridor', 'Meters', {
      maximum: OPERATING_AREA_SIZE_LIMIT_METERS,
      help: `How far the area reaches on either side of the line; at most ${sizeLimitWords}.`,
    }),
    recordField.dateTime('startsAt', 'In force from', required),
    recordField.dateTime('endsAt', 'In force until', { help: 'Leave empty while the area is in force.' }),
    recordField.text('areaApprovalReference', 'Approval for the area', {
      help: 'The reference of the approval the operator holds to operate in this area.',
    }),
    recordField.longText('alternateLandingAreas', 'Alternate landing areas', {
      help: 'Where the aircraft can land if it cannot complete its intended flight.',
    }),
    recordField.longText('takeoffLandingAreas', 'Takeoff, landing and loading areas and their suitability'),
    recordField.longText('boundaryDescription', 'Boundary in words'),
    recordField.number('ceilingAboveGroundMeters', 'Ceiling above ground', 'Meters'),
    recordField.text('verifiedByName', 'Verified by'),
    recordField.text('boundaryArtifactReference', 'Boundary file reference', replay),
  ],
});

export const siteStatusV1 = defineOperatorRecordType({
  recordType: 'site.status',
  recordVersion: 1,
  title: 'Site status',
  subjectKinds: ['site'],
  time: { meaning: 'as_of', atField: 'recordedAt' },
  description:
    'The status the operator recorded for a site (available, held or deferred), with the condition behind it and what it needs to resume.',
  mayInfer: ['At recordedAt the operator recorded this site status and condition.'],
  mayNotInfer: ['A recorded status holds as of recordedAt; a later record replaces it, absence does not.'],
  fields: [
    recordField.dateTime('recordedAt', 'Recorded at', required),
    recordField.select(
      'status',
      'Status',
      [
        ['available', 'Available'],
        ['held', 'Held'],
        ['deferred', 'Deferred'],
      ],
      required,
    ),
    recordField.longText('condition', 'Condition'),
    recordField.longText('resumeEvidence', 'Needed to resume'),
    recordField.text('responsibleName', 'Responsible person', replay),
    recordField.dateTime('followUpAt', 'Follow up at', replay),
  ],
});

export const operationNotificationV1 = defineOperatorRecordType({
  recordType: 'operation.notification',
  recordVersion: 1,
  title: 'Notice of operations',
  subjectKinds: ['flight', 'organization'],
  time: { meaning: 'event', atField: 'notifiedAt' },
  description:
    'A notice the operator recorded giving a named party notice of planned operations: who was notified, how and when, and the operations it covered.',
  mayInfer: ['At notifiedAt the operator recorded giving this notice to the named recipient by the stated means.'],
  mayNotInfer: [
    'A recorded notice is the operator’s record that it was sent; it is not a record that the recipient received or accepted it.',
    'An organization-level notice does not by itself name the flights it covers; read coveredOperations.',
  ],
  fields: [
    recordField.dateTime('notifiedAt', 'Notified at', required),
    recordField.text('recipient', 'Recipient', required),
    recordField.select(
      'means',
      'Means',
      [
        ['email', 'Email'],
        ['telephone', 'Telephone'],
        ['in_person', 'In person'],
        ['online_form', 'Online form'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.longText('coveredOperations', 'Operations covered'),
    recordField.text('confirmationReference', 'Confirmation reference', replay),
  ],
});

export const organizationProcedureV1 = defineOperatorRecordType({
  recordType: 'organization.procedure',
  recordVersion: 1,
  title: 'Procedure on file',
  subjectKinds: ['organization'],
  time: { meaning: 'as_of', atField: 'effectiveAt' },
  description:
    'A written procedure the operator recorded as on file and in effect from a date: its kind, title, document reference and revision.',
  mayInfer: ['The operator recorded this procedure document as in effect from effectiveAt.'],
  mayNotInfer: [
    'Ledger does not read the procedure itself; what it says is for a person to review.',
    'A later record of the same kind replaces this one; absence of a later record is not evidence the procedure was withdrawn.',
  ],
  fields: [
    recordField.select(
      'procedureKind',
      'Kind of procedure',
      [
        ['lost_link', 'Lost control link'],
        ['emergency', 'Emergency'],
        ['flight_termination', 'Flight termination'],
        ['cybersecurity', 'Cybersecurity policies and processes'],
        ['training_program', 'Training program'],
        ['physical_security', 'Physical security policies and processes'],
        ['battery_monitoring', 'Battery monitoring program'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('title', 'Title', required),
    recordField.text('documentReference', 'Document reference', required),
    recordField.text('revision', 'Revision', required),
    recordField.dateTime('effectiveAt', 'In effect from', required),
  ],
});

export const organizationReportV1 = defineOperatorRecordType({
  recordType: 'organization.report',
  recordVersion: 1,
  title: 'Report provided',
  subjectKinds: ['organization'],
  time: { meaning: 'event', atField: 'providedAt' },
  description:
    'A periodic report or summary the operator recorded as provided to a named recipient, such as its flight hours per aircraft or the list of aircraft it uses, and the days it covers.',
  mayInfer: [
    'At providedAt the operator recorded providing this kind of report, covering these days, to the recipient.',
  ],
  mayNotInfer: [
    'Ledger does not hold or read the report itself; what it says is for a person to review.',
    'A recorded report is the operator’s record that it was provided, not a record that the recipient accepted it.',
  ],
  fields: [
    recordField.select(
      'reportKind',
      'Kind of report',
      [
        ['flight_hours', 'Flight hours per aircraft'],
        ['reliability_data', 'Aircraft reliability data'],
        ['aircraft_list', 'Registration and serial numbers of the aircraft used'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('recipient', 'Provided to', required),
    recordField.dateTime('providedAt', 'Provided at', required),
    recordField.date('periodStartsOn', 'First day covered'),
    recordField.date('periodEndsOn', 'Last day covered'),
    recordField.text('reportReference', 'Report reference', replay),
  ],
});

export const organizationReviewV1 = defineOperatorRecordType({
  recordType: 'organization.review',
  recordVersion: 1,
  title: 'Review of a policy or program',
  subjectKinds: ['organization'],
  time: { meaning: 'event', atField: 'reviewedAt' },
  description:
    'A review the operator recorded of one of its own policies or programs: what was reviewed, when, by whom, and whether it was revised.',
  mayInfer: ['At reviewedAt the operator recorded this review of the named document by the named person.'],
  mayNotInfer: [
    'Ledger does not read the document reviewed; whether the review was adequate is for a person to judge.',
    'A review with no change is still a review.',
  ],
  fields: [
    recordField.select(
      'reviewKind',
      'What was reviewed',
      [
        ['cybersecurity_policy', 'Cybersecurity policies'],
        ['training_program', 'Training program'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('documentReference', 'Document reviewed', required),
    recordField.dateTime('reviewedAt', 'Reviewed at', required),
    recordField.text('reviewedByName', 'Reviewed by', required),
    recordField.select(
      'recordedOutcome',
      'Outcome',
      [
        ['no_change', 'Reviewed with no change'],
        ['revised', 'Reviewed and revised'],
      ],
      required,
    ),
    recordField.text('revisionAfterReview', 'Revision after the review'),
    recordField.longText('note', 'Note', replay),
  ],
});

export const operationRecordTypesV1 = [
  operationRoleAssignmentV1,
  organizationCoordinatorRequirementV1,
  operationMultipleAircraftV1,
  flightPlanV1,
  flightPreflightAssessmentV1,
  flightRecordV1,
  organizationOperatingAreaV1,
  siteStatusV1,
  operationNotificationV1,
  organizationProcedureV1,
  organizationReportV1,
  organizationReviewV1,
] as const;
