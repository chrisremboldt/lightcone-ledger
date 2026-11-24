import { occurrenceNotReportable, type RulePopulation, type RuleRead } from '@ledger/contracts';
import { findCheckKind, type CheckedRuleSpec } from '@ledger/domain';

/**
 * A check with no source framing: what it reads and asks. A pack gives it a source by quoting the paragraph it
 * serves, so a later edition of the text can frame the same check without rewriting it.
 */
export type SourceNeutralCheck = Omit<CheckedRuleSpec, 'id' | 'version' | 'source'>;
type SubjectKind = SourceNeutralCheck['target']['subjectKind'];
type Condition = NonNullable<RuleRead['where']>[number];

function kind(id: string, version: number) {
  const found = findCheckKind(id, version);
  if (!found) throw new Error(`Check kind ${id} version ${version} is not registered`);
  return found;
}

/**
 * Operator records of one type about the target (or a related subject), narrowed (and optionally filtered) before
 * the check sees them.
 */
function records(
  name: string,
  recordType: string,
  select: RuleRead['select'],
  where: Condition[] = [],
  about: RuleRead['about'] = 'target',
): RuleRead {
  return {
    name,
    type: 'operator.record',
    versions: [1],
    about,
    required: false,
    select,
    where: [
      { field: 'values.recordType', oneOf: [recordType] },
      { field: 'values.recordVersion', oneOf: [1] },
      ...where,
    ],
  };
}

/**
 * The check with the named reads reading plans: a record about a planned window (the plan, an assignment or preflight
 * item made for it) is read as soon as it is recorded, so a planned flight is checked before its window starts.
 */
function readingPlans<Check extends SourceNeutralCheck>(check: Check, names: string[]): Check {
  return { ...check, reads: check.reads.map((read) => (names.includes(read.name) ? { ...read, plans: true } : read)) };
}

/** The named fields of the latest record of one type about the subject are filled. */
function recordHolds(
  title: string,
  subjectKind: SubjectKind,
  recordType: string,
  fields: string[],
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind },
    reads: [records('record', recordType, 'latest')],
    check: { kind: kind('record.complete', 2), params: { recordType, recordVersion: 1, fields } },
  };
}

/** The latest record of one type (matching the conditions) holds one of the expected values in a field. */
function recordedValue(
  title: string,
  subjectKind: SubjectKind,
  recordType: string,
  field: string,
  expected: string[],
  options: { where?: Condition[]; undetermined?: string[]; pass: string },
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind },
    reads: [records('subject', recordType, 'latest', options.where)],
    check: {
      kind: kind('value.one-of', 1),
      params: {
        field: `values.record.${field}`,
        expected,
        ...(options.undetermined ? { undetermined: options.undetermined } : {}),
      },
    },
    wording: { pass: options.pass },
  };
}

/** A recorded quantity in the latest record of one type is within a fixed limit. */
function recordedQuantity(
  title: string,
  recordType: string,
  field: string,
  comparison: 'at_most' | 'at_least',
  limit: number,
  textUnit: 'ft' | 'mi',
  pass: string,
  onFile: string,
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'flight' },
    reads: [records('quantity', recordType, 'latest'), landedRead],
    check: {
      kind: kind('value.within-limit', 2),
      params: { field: `values.record.${field}`, comparison, limit, unit: 'm', textUnit },
    },
    waitEnds: waitsAWeekAfterLanding('landed', onFile),
    wording: { pass },
  };
}

const FOOT_METERS = 0.3048;
const STATUTE_MILE_METERS = 1609.344;
const KNOT_METERS_PER_SECOND = 1852 / 3600;

/** The operator's record of the flight as flown, read for when the flight landed. */
const landedRead = records('landed', 'flight.record', 'latest');
/**
 * A flown flight's result stops waiting for a record a week after it landed on record: the record is then not on file.
 * A week is the time a position reported after the flight still reaches it.
 */
function waitsAWeekAfterLanding(read: string, onFile: string): NonNullable<SourceNeutralCheck['waitEnds']> {
  return { read, field: 'values.record.landingAt', afterHours: 168, describes: 'the flight landed', onFile };
}

export const remotePilotCertificateHeld = recordedValue(
  'Remote pilot certificate recorded as held',
  'person',
  'person.certificate',
  'recordedStatus',
  ['held'],
  {
    where: [{ field: 'values.record.credentialKind', oneOf: ['remote_pilot_certificate'] }],
    pass: 'The latest remote pilot certificate recorded for this person is recorded as held. Whether it carries a small UAS rating, and whether this person acts as remote pilot in command, is for a person to review.',
  },
);

export const aeronauticalKnowledgeRecency: SourceNeutralCheck = {
  title: 'Knowledge test or recurrent training completed within the previous 24 calendar months',
  target: { subjectKind: 'person' },
  reads: [
    // Only training recorded as the remote pilot certificate's own: a company course of the same kind on the same day
    // is another program, not a second date for this one.
    records('subject', 'person.training', 'latest', [
      { field: 'values.record.trainingKind', oneOf: ['knowledge_test', 'recurrent'] },
      { field: 'values.record.program', oneOf: ['remote_pilot_certificate'] },
    ]),
  ],
  check: {
    kind: kind('date.within-months', 2),
    params: {
      field: 'values.record.completedOn',
      months: 24,
      nameField: 'values.record.courseTitle',
      sameWhen: ['values.record.courseTitle', 'values.record.evidenceReference'],
    },
  },
  wording: {
    pass: 'The latest knowledge test or recurrent training recorded for the remote pilot certificate was completed within the previous 24 calendar months. Whether it covered the areas of knowledge the paragraph names, and was accomplished in a manner acceptable to the Administrator, is for a person to review.',
  },
};

export const pilotInCommandDesignated: SourceNeutralCheck = readingPlans(
  {
    title: 'Remote pilot in command designated for the planned window',
    target: { subjectKind: 'flight' },
    reads: [records('interval', 'operation.role-assignment', 'all'), records('window', 'flight.plan', 'latest')],
    check: {
      kind: kind('interval.covers-window', 2),
      params: {
        select: {
          where: [
            { field: 'values.record.role', oneOf: ['pilot_in_command'] },
            { field: 'values.record.personId', filled: true },
          ],
        },
        openEnd: 'stated',
      },
    },
  },
  ['interval', 'window'],
);

export const registrationRecorded: SourceNeutralCheck = {
  ...recordHolds('Aircraft registration number recorded', 'aircraft', 'aircraft.identity', ['registrationNumber']),
  wording: {
    pass: 'A registration number is recorded for the aircraft. Whether the registration meets § 91.203(a)(2) is for a person to review.',
  },
};

export const noKnownUnsafeCondition = recordedValue(
  'No known unsafe condition recorded for the aircraft',
  'aircraft',
  'aircraft.condition',
  'recordedCondition',
  ['no_unsafe_condition_known'],
  {
    undetermined: ['not_determined'],
    pass: 'The latest condition recorded for the aircraft is that no unsafe condition is known. Whether the remote pilot in command checked it before this flight is for a person to review.',
  },
);

export const noKnownMedicalCondition = recordedValue(
  'No known interfering medical condition declared',
  'person',
  'person.readiness-declaration',
  'medicalStatement',
  ['no_known_condition'],
  {
    pass: 'The latest declaration states no known condition that would interfere. It is the person’s statement, not a medical finding, and covers the time it was made; whether it covers this duty is for a person to review.',
  },
);

export const noKnownSubstanceDisqualification = recordedValue(
  'No known alcohol or drug disqualification declared',
  'person',
  'person.readiness-declaration',
  'substanceStatement',
  ['no_known_disqualification'],
  {
    pass: 'The latest declaration states no known alcohol or drug disqualification. Whether §§ 91.17 and 91.19 are met for this duty is for a person to review.',
  },
);

export const plannedWithinVisualLineOfSight = readingPlans(
  recordedValue(
    'Flight planned within visual line of sight',
    'flight',
    'flight.plan',
    'visualMode',
    ['visual_line_of_sight'],
    {
      pass: 'The flight is planned within visual line of sight. Whether the persons the paragraph names could see the aircraft throughout the flight is for a person to review.',
    },
  ),
  ['subject'],
);

export const payloadNotHazardous = readingPlans(
  recordedValue(
    'Payload recorded as not hazardous material',
    'flight',
    'aircraft.payload',
    'hazardousMaterial',
    ['not_hazardous'],
    {
      pass: 'The payload is recorded as not hazardous material. The classification is the operator’s; whether it matches the definition in 49 CFR 171.8 is for a person to review.',
    },
  ),
  ['subject'],
);

function preflightRecorded(title: string, fields: string[], pass: string): SourceNeutralCheck {
  return readingPlans({ ...recordHolds(title, 'flight', 'flight.preflight-assessment', fields), wording: { pass } }, [
    'record',
  ]);
}

export const operatingEnvironmentAssessed = preflightRecorded(
  'Weather, airspace, people, property and ground hazards assessed before flight',
  ['weatherDetermination', 'airspaceDetermination', 'groundHazardsDetermination'],
  'The latest preflight assessment records weather, airspace and ground determinations. Whether they consider the risks the paragraph names is for a person to review.',
);

export const participantsInformed = preflightRecorded(
  'Participants informed before flight',
  ['participantsBriefing'],
  'The latest preflight assessment records how participants were informed. Whether every directly participating person was informed of each item the paragraph lists is for a person to review.',
);

export const linkPowerAndLoadChecked = preflightRecorded(
  'Control link, power and attached objects checked before flight',
  ['linkEnergyLoadDetermination'],
  'The latest preflight assessment records the control link, power and load determination. Whether each was ensured is for a person to review.',
);

export const visibilityAtLeastMinimum = readingPlans(
  recordedQuantity(
    'Recorded visibility of at least 3 statute miles',
    'flight.preflight-assessment',
    'visibilityMeters',
    'at_least',
    3 * STATUTE_MILE_METERS,
    'mi',
    'The visibility recorded before flight is at least 3 statute miles. Visibility during the flight is for a person to review.',
    'preflight assessment stating the visibility',
  ),
  ['quantity'],
);

export const cloudClearanceBelow = readingPlans(
  recordedQuantity(
    'Recorded distance below cloud of at least 500 feet',
    'flight.preflight-assessment',
    'cloudVerticalClearanceMeters',
    'at_least',
    500 * FOOT_METERS,
    'ft',
    'The distance below cloud recorded before flight is at least 500 feet. The distance kept during the flight is for a person to review.',
    'preflight assessment stating the distance below cloud',
  ),
  ['quantity'],
);

export const cloudClearanceHorizontal = readingPlans(
  recordedQuantity(
    'Recorded horizontal distance from cloud of at least 2,000 feet',
    'flight.preflight-assessment',
    'cloudHorizontalClearanceMeters',
    'at_least',
    2000 * FOOT_METERS,
    'ft',
    'The horizontal distance from cloud recorded before flight is at least 2,000 feet. The distance kept during the flight is for a person to review.',
    'preflight assessment stating the horizontal distance from cloud',
  ),
  ['quantity'],
);

// Height, speed and airspace authorization: the flown value when the aircraft reported it, the plan otherwise -------

/**
 * The aircraft the flight's plan names. With none named the reads about it are empty and the rule rests on the plan.
 * A position about the aircraft re-evaluates the flights whose planned window has not ended, or ended within a week,
 * so telemetry uploaded after a flight still reaches it.
 */
const plannedAircraft: NonNullable<SourceNeutralCheck['related']>[number] = {
  name: 'aircraft',
  subjectKind: 'aircraft',
  fanOut: false,
  whenNone: 'empty',
  from: { read: 'plan', field: 'secondarySubject' },
  requeue: { windowEnd: { read: 'plan', field: 'values.record.windowEndsAt' }, endedWithinDays: 7 },
};
const planRead = records('plan', 'flight.plan', 'latest');
/** The positions the planned aircraft reported in the planned window: the flight's flown values. */
const flownPositions: RuleRead = {
  name: 'flown',
  type: 'position.fix',
  versions: [1],
  about: { related: 'aircraft' },
  required: false,
  select: {
    within: { read: 'plan', startField: 'values.record.windowStartsAt', endField: 'values.record.windowEndsAt' },
  },
};
const unusableFix = [{ field: 'values.fix', oneOf: ['none'] }];
const datum = (datums: string[]) => [{ field: 'position.altitude.datum', oneOf: datums }];
/** What a reported height measures. Only heights above ground level or the takeoff point meet a limit above ground. */
const heightMeasures = [
  { where: datum(['ground_level']), describes: 'flown height above ground level', compared: true },
  { where: datum(['takeoff_point']), describes: 'flown height above the takeoff point', compared: true },
  { where: datum(['wgs84_ellipsoid']), describes: 'height above the WGS84 ellipsoid', compared: false },
  { where: datum(['mean_sea_level']), describes: 'height above mean sea level', compared: false },
  { where: datum(['unknown']), describes: 'height against an unstated reference', compared: false },
];

export const groundSpeedWithinLimit: SourceNeutralCheck = readingPlans(
  {
    title: 'Ground speed of at most 87 knots, flown or else planned',
    target: { subjectKind: 'flight' },
    related: [plannedAircraft],
    reads: [planRead, flownPositions, landedRead],
    waitEnds: waitsAWeekAfterLanding('landed', 'ground speed, flown or planned,'),
    check: {
      kind: kind('value.flown-or-planned', 1),
      params: {
        plannedField: 'values.record.plannedMaxGroundSpeedMetersPerSecond',
        plannedDescribes: 'planned maximum ground speed',
        flownField: 'values.groundSpeedMetersPerSecond',
        flownDescribes: 'ground speed',
        measures: [{ describes: 'flown ground speed the aircraft reported', compared: true }],
        unusable: unusableFix,
        comparison: 'at_most',
        limit: 87 * KNOT_METERS_PER_SECOND,
        limitDescribes: 'at most 87 knots, 44.76 m/s',
        unit: 'm/s',
        textUnit: 'kn',
      },
    },
    wording: { pass: '{reading} The speed between reports is for a person to review.' },
  },
  ['plan'],
);

/**
 * A height the operator recorded for the flight is read after heights above ground level the aircraft reported, and
 * before a height above the takeoff point: the operator's figure is above ground (docs/design/observed-values.md).
 */
const heightMeasuresBesideRecord = heightMeasures.map((measure) =>
  measure.where[0]!.oneOf.includes('takeoff_point') ? { ...measure, afterRecorded: true } : measure,
);
const recordedHeight = {
  recordedField: 'values.record.maxHeightFlownAboveGroundMeters',
  recordedDescribes: 'maximum height flown above ground level in the operator’s flight record',
};
/** The flight's time and height as the operator recorded them, read where no position is on record. */
const recordedFlight = {
  recordedStartField: 'values.record.takeoffAt',
  recordedEndField: 'values.record.landingAt',
  recordedHeightField: recordedHeight.recordedField,
  recordedHeightDescribes: recordedHeight.recordedDescribes,
};

export const heightWithinLimit: SourceNeutralCheck = readingPlans(
  {
    title: 'Height of at most 400 feet above ground, flown or else planned',
    target: { subjectKind: 'flight' },
    related: [plannedAircraft],
    reads: [planRead, records('recorded', 'flight.record', 'latest'), flownPositions],
    waitEnds: waitsAWeekAfterLanding('recorded', 'height, flown, recorded or planned,'),
    check: {
      kind: kind('value.flown-or-planned', 1),
      params: {
        plannedField: 'values.record.plannedMaxHeightAboveGroundMeters',
        plannedDescribes: 'planned maximum height above ground level',
        ...recordedHeight,
        flownField: 'position.altitude.meters',
        flownDescribes: 'height',
        measures: heightMeasuresBesideRecord,
        unusable: unusableFix,
        comparison: 'at_most',
        limit: 400 * FOOT_METERS,
        limitDescribes: 'at most 400 feet above ground level, 121.92 m',
        unit: 'm',
        textUnit: 'ft',
      },
    },
    wording: {
      pass: '{reading} A height above the takeoff point is not a height above ground level where the ground rises or falls, and a height the operator recorded is its own figure; those, and the height between reports, are for a person to review.',
      attention:
        '{reading} Whether the aircraft was within 400 feet of a structure and no higher than 400 feet above its uppermost limit, which the paragraph allows, is for a person to review.',
    },
  },
  ['plan'],
);

/** The airspace authorizations recorded about the flight: one covering its time, place and height supports the rule. */
export const controlledAirspaceAuthorization: SourceNeutralCheck = readingPlans(
  {
    title: 'Airspace authorization on record covering the flight’s time, place and height',
    target: { subjectKind: 'flight' },
    related: [plannedAircraft],
    reads: [
      planRead,
      {
        name: 'authorizations',
        type: 'airspace.authorization',
        versions: [1],
        about: 'target',
        required: false,
        select: 'all',
      },
      records('recorded', 'flight.record', 'latest'),
      flownPositions,
    ],
    check: {
      kind: kind('authorization.covers-flight', 1),
      params: {
        plannedStartField: 'values.record.windowStartsAt',
        plannedEndField: 'values.record.windowEndsAt',
        plannedHeightField: 'values.record.plannedMaxHeightAboveGroundMeters',
        plannedHeightDescribes: 'planned maximum height above ground level',
        ...recordedFlight,
        heightField: 'position.altitude.meters',
        measures: heightMeasures,
        unusable: unusableFix,
        inForce: ['approved'],
        awaiting: ['requested', 'unknown'],
        ceilingDatums: ['ground_level'],
        textUnit: 'ft',
      },
    },
    wording: {
      pass: '{reading} The status is the issuing party’s report. Whether the flight entered airspace that needs prior authorization, and kept to the authorization’s other terms, is for a person to review.',
      attention:
        '{reading} An authorization obtained another way is not on record here; whether the flight needed one, and had one, is for a person to review.',
    },
  },
  ['plan', 'authorizations'],
);

export const injuryReportRecorded: SourceNeutralCheck = {
  title: 'Each recorded serious injury or loss of consciousness has a report to the authority recorded',
  target: { subjectKind: 'flight' },
  reads: [records('record', 'occurrence.accident', 'all')],
  check: {
    kind: kind('record.complete', 2),
    params: {
      recordType: 'occurrence.accident',
      recordVersion: 1,
      fields: ['reportedToAuthorityAt'],
      where: [{ field: 'values.record.accidentKind', oneOf: ['serious_injury', 'loss_of_consciousness'] }],
      whenAbsent: 'not_applicable',
      scope: 'each',
    },
  },
  wording: {
    pass: 'Each recorded serious injury or loss of consciousness has a time it was reported to the authority. Whether each report was made within 10 calendar days, and in a manner acceptable to the Administrator, is for a person to review.',
  },
};

// Rules that read a related subject or compare two recorded times (pack version 2) ---------------------------------

/**
 * Per flight, one result for each person assigned as remote pilot in command: the role assignments about the flight
 * name the people, and reads about `pilot` are about that person.
 */
const assignedPilot: NonNullable<SourceNeutralCheck['related']>[number] = {
  name: 'pilot',
  subjectKind: 'person',
  fanOut: true,
  whenNone: 'insufficient',
  from: { read: 'assignments', field: 'values.record.personId' },
};
const pilotAssignments = records('assignments', 'operation.role-assignment', 'all', [
  { field: 'values.record.role', oneOf: ['pilot_in_command'] },
  { field: 'values.record.personId', filled: true },
]);

export const assignedPilotCertificateHeld: SourceNeutralCheck = readingPlans(
  {
    title: 'Remote pilot certificate recorded as held by each person assigned as remote pilot in command',
    target: { subjectKind: 'flight' },
    related: [assignedPilot],
    reads: [
      pilotAssignments,
      records(
        'subject',
        'person.certificate',
        'latest',
        [{ field: 'values.record.credentialKind', oneOf: ['remote_pilot_certificate'] }],
        { related: 'pilot' },
      ),
      landedRead,
    ],
    waitEnds: waitsAWeekAfterLanding('landed', 'remote pilot certificate stating its status'),
    check: { kind: kind('value.one-of', 1), params: { field: 'values.record.recordedStatus', expected: ['held'] } },
    wording: {
      pass: 'The latest remote pilot certificate recorded for this person, who is assigned as remote pilot in command of the flight, is recorded as held at the evaluation time. Whether it was held at the time of the flight, whether it carries a small UAS rating, and whether § 107.65 is met are for a person to review.',
    },
  },
  ['assignments'],
);

export const injuryReportTiming: SourceNeutralCheck = {
  title: 'Serious injury or loss of consciousness reported to the authority within 10 calendar days',
  target: { subjectKind: 'flight' },
  reads: [
    records('subject', 'occurrence.accident', 'latest', [
      { field: 'values.record.accidentKind', oneOf: ['serious_injury', 'loss_of_consciousness'] },
    ]),
  ],
  check: {
    kind: kind('business-days.within', 1),
    params: {
      toField: 'values.record.reportedToAuthorityAt',
      days: 10,
      // Calendar days: no weekday or date is excluded, so the bounds only say how far the count runs.
      excludedWeekdays: [],
      excludedDates: [],
      calendarFrom: '2000-01-01',
      calendarThrough: '2099-12-31',
      whenAbsent: 'not_applicable',
      notDue: occurrenceNotReportable(['occurrence.accident']),
    },
  },
  adoptionParameters: [
    {
      name: 'timeZone',
      title: 'Time zone the operator counts days in (an IANA name such as America/Denver, or UTC)',
      valueType: 'string',
    },
  ],
  wording: {
    pass: 'The report to the authority is recorded by the end of {dueThrough} in {timeZone}, the 10th calendar day after {startDay}, the local date of the recorded accident. This reads the day of the operation as the accident’s recorded date and does not count it; that reading, and whether the report was made in a manner acceptable to the Administrator, are for a person to confirm.',
    pending:
      'No report to the authority is recorded yet; counting 10 calendar days after {startDay} in {timeZone}, the local date of the recorded accident, it is due by the end of {dueThrough}. That reading of the days is for a person to confirm.',
  },
};

// Who each rule is meant for (docs/design/rule-coverage.md) -------------------------------------------------------

/** The people role-assignment records name in one of the roles, for a flight or as a standing designation. */
function inRoles(roles: readonly string[]): RulePopulation {
  return {
    of: 'designated',
    by: {
      type: 'operator.record',
      versions: [1],
      where: [
        { field: 'values.recordType', oneOf: ['operation.role-assignment'] },
        { field: 'values.record.role', oneOf: [...roles] },
      ],
      field: 'values.record.personId',
    },
  };
}
/** § 107.12(b) and § 107.65 are about a person who acts as remote pilot in command. */
export const remotePilots = inRoles(['pilot_in_command']);
/** § 107.27 is about a person manipulating the flight controls, the remote pilot in command and the visual observer. */
export const flightCrew = inRoles(['pilot_in_command', 'person_manipulating_controls', 'visual_observer']);
/**
 * § 107.17 adds any direct participant in the operation: the roles a person holds on an operation, all but the two
 * that are not part of one (the person responsible for training and the accountable executive).
 */
export const participants = inRoles([
  'pilot_in_command',
  'person_manipulating_controls',
  'visual_observer',
  'payload_operator',
  'operations_supervisor',
  'flight_coordinator',
  'other',
]);
/** Every aircraft the organization has on record. */
export const aircraft: RulePopulation = { of: 'on_record' };
/** The flights whose records fall within the adoption's dates. */
export const flights: RulePopulation = { of: 'in_adoption_dates' };
