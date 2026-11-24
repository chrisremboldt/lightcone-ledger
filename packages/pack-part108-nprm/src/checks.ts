import { occurrenceNotReportable, type RulePopulation, type RuleRead } from '@ledger/contracts';
import { findCheckKind, type CheckedRuleSpec } from '@ledger/domain';
import { federalHolidayCalendar } from './federal-holidays.js';

/**
 * A check with no source framing: what it reads and asks. A pack gives it a source by quoting the paragraph it
 * serves, so a later text can frame the same check without rewriting it. Nothing here names a rulemaking stage.
 */
export type SourceNeutralCheck = Omit<CheckedRuleSpec, 'id' | 'version' | 'source'>;

function kind(id: string, version: number) {
  const found = findCheckKind(id, version);
  if (!found) throw new Error(`Check kind ${id} version ${version} is not registered`);
  return found;
}

type Condition = NonNullable<RuleRead['where']>[number];

/**
 * Operator records of one type about the target (or the organization, or a related subject), narrowed (and
 * optionally filtered) before the check sees them.
 */
function records(
  name: string,
  recordType: string,
  select: RuleRead['select'] = 'latest',
  about: RuleRead['about'] = 'target',
  where: Condition[] = [],
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

/** The named fields of the latest record of one type about the subject are filled. */
function recordHolds(
  title: string,
  subjectKind: SourceNeutralCheck['target']['subjectKind'],
  recordType: string,
  fields?: string[],
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind },
    reads: [records('record', recordType)],
    check: {
      kind: kind('record.complete', 2),
      params: { recordType, recordVersion: 1, ...(fields ? { fields } : {}) },
    },
  };
}

/** Each record of one type made when something happened (and matching the conditions) has the named fields. */
function eachEventRecordHolds(
  title: string,
  subjectKind: SourceNeutralCheck['target']['subjectKind'],
  recordType: string,
  options: { fields?: string[]; where?: { field: string; oneOf?: unknown[]; filled?: true }[] } = {},
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind },
    reads: [records('record', recordType, 'all')],
    check: {
      kind: kind('record.complete', 2),
      params: {
        recordType,
        recordVersion: 1,
        whenAbsent: 'not_applicable',
        scope: 'each',
        ...(options.fields ? { fields: options.fields } : {}),
        ...(options.where ? { where: options.where } : {}),
      },
    },
  };
}

const dutyPeriods: RuleRead = {
  name: 'periods',
  type: 'crew.duty-period',
  versions: [1],
  about: 'target',
  required: false,
  select: 'all',
};
const dutyAndRest = {
  dutySelect: { where: [{ field: 'values.period', oneOf: ['duty', 'flight_duty'] }] },
  restSelect: { where: [{ field: 'values.period', oneOf: ['rest'] }] },
};
const coordinatorAssignment: Condition[] = [
  { field: 'values.record.role', oneOf: ['flight_coordinator'] },
  { field: 'values.record.personId', filled: true },
];

export const flightPathRecorded: SourceNeutralCheck = recordHolds(
  'Flight path, origin, destination and height recorded',
  'flight',
  'flight.record',
  ['takeoffLocation', 'landingLocations', 'maxHeightFlownAboveGroundMeters', 'flightPathReference'],
);

// The record of each flight performed: one rule per item, each saying what is on file and where it was read -------

const valuesOnFile = (params: Record<string, unknown>) => ({
  kind: kind('values.on-file', 1),
  params: { subjectDescribes: 'flight', ...params },
});
/** The operator's own record of the flight as flown; the items it does not hold are read for a flight that has one. */
const flownRecord = records('flown', 'flight.record');

export const flightTimesOnFile: SourceNeutralCheck = {
  title: 'Takeoff and landing times on file, reported or else in the flight record',
  target: { subjectKind: 'flight' },
  reads: [
    { name: 'primary', type: 'flight.report', versions: [1], about: 'target', required: false, select: 'all' },
    records('fallback', 'flight.record'),
  ],
  check: valuesOnFile({
    describes: 'takeoff and landing times',
    values: [
      { field: 'values.takeoffAt', fallbackField: 'values.record.takeoffAt', describes: 'takeoff' },
      { field: 'values.landingAt', fallbackField: 'values.record.landingAt', describes: 'landing' },
    ],
    primaryDescribes: 'the flight’s reports',
    fallbackDescribes: 'the operator’s flight record',
    interval: true,
  }),
  wording: {
    pass: '{reading} Whether the times are right, and the date in the operator’s own time zone, are for a person to review.',
  },
};

export const registrationOnFile: SourceNeutralCheck = {
  title: 'Registration number of the aircraft flown on file',
  target: { subjectKind: 'flight' },
  related: [
    {
      name: 'aircraft',
      subjectKind: 'aircraft',
      fanOut: false,
      whenNone: 'empty',
      from: { read: 'flown', field: 'secondarySubject' },
    },
  ],
  reads: [flownRecord, records('primary', 'aircraft.identity', 'latest', { related: 'aircraft' })],
  check: valuesOnFile({
    describes: 'aircraft registration number',
    values: [{ field: 'values.record.registrationNumber', describes: 'registration number' }],
    primaryDescribes: 'the identity record of the aircraft its flight record names',
  }),
  wording: {
    pass: '{reading} Whether the aircraft named is the one flown, and its registration was current on the day, are for a person to review.',
  },
};

export const operationTypeOnFile: SourceNeutralCheck = {
  title: 'Type of operation on file for the flight flown',
  target: { subjectKind: 'flight' },
  reads: [flownRecord, records('primary', 'flight.plan')],
  check: valuesOnFile({
    describes: 'type of operation',
    values: [{ field: 'values.record.operationKind', describes: 'type of operation' }],
    primaryDescribes: 'its flight plan',
  }),
  wording: { pass: '{reading} Whether the flight was flown as that type of operation is for a person to review.' },
};

export const operationsPersonnelOnFile: SourceNeutralCheck = {
  title: 'Operations personnel assigned to the flight flown on file',
  target: { subjectKind: 'flight' },
  reads: [flownRecord, records('primary', 'operation.role-assignment', 'all')],
  check: valuesOnFile({
    describes: 'designated operations personnel',
    values: [
      { field: 'values.record.personId', describes: 'person' },
      { field: 'values.record.role', describes: 'role' },
    ],
    primaryDescribes: 'its role assignments',
    scope: 'each',
  }),
  wording: {
    pass: '{reading} Which of them are designated operations personnel, and the names behind the ids, are for a person to review.',
  },
};

export const landingLocationsOnFile: SourceNeutralCheck = {
  title: 'Landing places on file for the flight flown',
  target: { subjectKind: 'flight' },
  reads: [records('primary', 'flight.record')],
  check: valuesOnFile({
    describes: 'landing places',
    values: [{ field: 'values.record.landingLocations', describes: 'landing places' }],
    primaryDescribes: 'the operator’s flight record',
  }),
  wording: {
    pass: '{reading} Whether they differ from the takeoff origin or destination, which the paragraph asks for, is for a person to review.',
  },
};

export const personnelFileRecorded: SourceNeutralCheck = recordHolds(
  'Personnel name, qualifications and duties recorded',
  'person',
  'person.standing',
  ['fullName', 'qualificationSummary', 'duties'],
);

export const separationForCauseRecorded: SourceNeutralCheck = {
  title: 'Release for cause recorded with its details',
  target: { subjectKind: 'person' },
  reads: [records('record', 'person.employment', 'all')],
  check: {
    kind: kind('record.complete', 2),
    params: {
      recordType: 'person.employment',
      recordVersion: 1,
      fields: ['separationDetails'],
      where: [{ field: 'values.record.separationForCause', oneOf: ['yes'] }],
      whenAbsent: 'not_applicable',
    },
  },
};

export const dutyScheduleRecorded: SourceNeutralCheck = recordHolds(
  'Shift, prior rest and daily duty hours recorded',
  'person',
  'person.rest-assessment',
);

export const irregularityLogEntries: SourceNeutralCheck = eachEventRecordHolds(
  'Mechanical irregularities logged with the action taken',
  'aircraft',
  'occurrence.mechanical-irregularity',
);

export const maintenanceEntries: SourceNeutralCheck = eachEventRecordHolds(
  'Maintenance entries hold work, date, person and return to service',
  'aircraft',
  'maintenance.action',
  { fields: ['actionDescription', 'performedAt', 'performedByName', 'returnToServiceByName'] },
);

export const trainingRecordDetails: SourceNeutralCheck = recordHolds(
  'Latest training record holds date, materials, provider and evidence',
  'person',
  'person.training',
  ['completedOn', 'materialsReference', 'providerName', 'providerAddress', 'evidenceReference'],
);

export const noKnownUnsafeCondition: SourceNeutralCheck = {
  title: 'No known unsafe condition recorded for the aircraft',
  target: { subjectKind: 'aircraft' },
  reads: [records('subject', 'aircraft.condition')],
  check: {
    kind: kind('value.one-of', 1),
    params: {
      field: 'values.record.recordedCondition',
      expected: ['no_unsafe_condition_known'],
      undetermined: ['not_determined'],
    },
  },
};

function preflightDetermination(title: string, field: string): SourceNeutralCheck {
  return recordHolds(title, 'flight', 'flight.preflight-assessment', [field]);
}
export const weatherDetermination = preflightDetermination(
  'Weather determination recorded before flight',
  'weatherDetermination',
);
export const airspaceDetermination = preflightDetermination(
  'Airspace and flight restrictions determination recorded before flight',
  'airspaceDetermination',
);
export const groundHazardDetermination = preflightDetermination(
  'Ground obstacles and hazards determination recorded before flight',
  'groundHazardsDetermination',
);
export const energyDetermination = preflightDetermination(
  'Power, link and load determination recorded before flight',
  'linkEnergyLoadDetermination',
);

function aircraftPerCoordinator(title: string, limitField: string): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'flight' },
    reads: [records('quantity', 'operation.multiple-aircraft'), records('limit', 'operation.multiple-aircraft')],
    check: {
      kind: kind('value.within-limit', 2),
      params: { field: 'values.record.simultaneousAircraftCount', comparison: 'at_most', limitField },
    },
  };
}
export const aircraftWithinMethodLimit = aircraftPerCoordinator(
  'Aircraft per coordinator within the recorded method limit',
  'values.record.methodLimitCount',
);
export const aircraftWithinManufacturerLimit = aircraftPerCoordinator(
  'Aircraft per coordinator within the manufacturer limit',
  'values.record.manufacturerLimitCount',
);

export const operationsSupervisorInRole: SourceNeutralCheck = {
  title: 'A person is in the operations supervisor role',
  target: { subjectKind: 'organization' },
  reads: [
    records('interval', 'operation.role-assignment', 'all', 'target', [
      { field: 'values.record.role', oneOf: ['operations_supervisor'] },
    ]),
  ],
  check: {
    kind: kind('interval.covers-window', 2),
    params: {
      select: {
        where: [
          { field: 'values.record.role', oneOf: ['operations_supervisor'] },
          { field: 'values.record.personId', filled: true },
        ],
      },
      openEnd: 'open',
    },
  },
  wording: {
    pass: 'A person is recorded in the operations supervisor role at the evaluation time. Their training, experience or expertise is for a person to review.',
  },
};

export const coordinatorDesignated: SourceNeutralCheck = {
  title: 'Flight coordinator designated for the planned window when required',
  target: { subjectKind: 'flight' },
  reads: [
    records('requirement', 'organization.coordinator-requirement'),
    records('interval', 'operation.role-assignment', 'all'),
    records('window', 'flight.plan'),
  ],
  applicability: [
    { input: 'requirement', field: 'values.record.coordinatorRequired', oneOf: [true], whenAbsent: 'insufficient' },
  ],
  check: {
    kind: kind('interval.covers-window', 2),
    params: { select: { where: coordinatorAssignment }, openEnd: 'stated' },
  },
};

export const coordinatorHandover: SourceNeutralCheck = eachEventRecordHolds(
  'Coordinator handover names its handover procedure',
  'flight',
  'operation.role-assignment',
  {
    fields: ['handoverProcedureReference'],
    where: [
      { field: 'values.record.role', oneOf: ['flight_coordinator'] },
      { field: 'values.record.handoverFromPersonId', filled: true },
    ],
  },
);

export const dutyPeriodLength: SourceNeutralCheck = {
  title: 'Duty period of at most 14 hours',
  target: { subjectKind: 'person' },
  reads: [dutyPeriods],
  check: { kind: kind('duty.within-limits', 1), params: { ...dutyAndRest, maxDutyHours: 14 } },
};

export const dutyWeekTotal: SourceNeutralCheck = {
  title: 'Recorded duty week of at most 50 hours',
  target: { subjectKind: 'person' },
  reads: [records('quantity', 'person.rest-assessment')],
  check: {
    kind: kind('value.within-limit', 2),
    params: { field: 'values.record.weekDutyHours', comparison: 'at_most', limit: 50, unit: 'h' },
  },
};

export const restBeforeDuty: SourceNeutralCheck = {
  title: 'Ten hours of continuous rest in the 24 hours before duty',
  target: { subjectKind: 'person' },
  reads: [dutyPeriods],
  check: {
    kind: kind('duty.within-limits', 1),
    params: { ...dutyAndRest, minRestHours: 10, restWithinHours: 24 },
  },
};

export const returnedToService: SourceNeutralCheck = {
  title: 'Latest maintenance on the aircraft recorded as returned to service',
  target: { subjectKind: 'aircraft' },
  reads: [records('subject', 'maintenance.action')],
  applicability: [
    { input: 'subject', field: 'values.recordType', oneOf: ['maintenance.action'], whenAbsent: 'not_applicable' },
  ],
  check: { kind: kind('value.one-of', 1), params: { field: 'values.record.returnedToService', expected: [true] } },
  wording: {
    pass: 'The latest maintenance action on the aircraft is recorded as returned to service. Whether the person who approved it may do so is for a person to review.',
  },
};

// Rules that read a related subject or combine records (pack version 3) --------------------------------------------

const timeZoneParameter = {
  name: 'timeZone',
  title: 'Time zone the operator counts days in (an IANA name such as America/Denver, or UTC)',
  valueType: 'string',
} as const;

export const totalTimeInService: SourceNeutralCheck = {
  title: 'Aircraft total time in service derived from its latest complete total and later flights',
  target: { subjectKind: 'aircraft' },
  reads: [
    records('opening', 'aircraft.time-in-service', 'latest', 'target', [
      { field: 'values.record.coverage', oneOf: ['complete'] },
    ]),
    {
      name: 'additions',
      type: 'flight.report',
      versions: [1],
      about: 'target',
      required: false,
      select: 'all',
      where: [
        { field: 'values.activity', oneOf: ['landed'] },
        { field: 'values.landingAt', filled: true },
      ],
    },
    records('recordedAdditions', 'flight.record', 'all'),
  ],
  check: {
    kind: kind('total.from-opening', 1),
    params: {
      openingField: 'values.record.totalTimeHours',
      openingAtField: 'values.record.coveredThroughAt',
      additionsStartField: 'values.takeoffAt',
      additionsEndField: 'values.landingAt',
      recordedStartField: 'values.record.takeoffAt',
      recordedEndField: 'values.record.landingAt',
      unit: 'h',
    },
  },
  wording: {
    pass: 'A total time in service of {total} hours is derived for the aircraft: its latest recorded total with complete coverage, {openingValue} hours through {openingAt}, plus {additionCount} flight(s) since, each from takeoff to landing. Of those, {recordedAdditionCount} are read from the operator’s flight records because no source reported them; {recordedDiffering} flight record(s) state times that differ from the reported times counted instead. Flights on neither are not in it; whether the operator keeps this total in its records is for a person to review.',
  },
};

export const weeklyRestDay: SourceNeutralCheck = {
  title: 'A whole local calendar day of recorded rest in the current week',
  target: { subjectKind: 'person' },
  reads: [{ ...dutyPeriods, name: 'subject' }],
  check: {
    kind: kind('local-days.total', 1),
    params: {
      select: { where: [{ field: 'values.period', oneOf: ['rest'] }] },
      measure: 'hours_uncovered',
      scope: 'each_day',
      requireDays: 1,
      comparison: 'at_most',
      limit: 0,
    },
  },
  adoptionParameters: [
    timeZoneParameter,
    {
      name: 'weekStartsOn',
      title: 'First day of the operator’s scheduling week (1 Monday to 7 Sunday)',
      valueType: 'integer',
      minimum: 1,
      maximum: 7,
    },
  ],
  wording: {
    pass: 'Recorded rest covers at least one whole local calendar day of the week {firstDay} to {lastDay} in {timeZone}. This reads “one day” as a local calendar day, midnight to midnight; that reading, whether the rest was free of all responsibility for work or duty, and whether the operator scheduled this person for duty in this week are for a person to confirm.',
    pending:
      'No whole local calendar day of the week {firstDay} to {lastDay} in {timeZone} is covered by recorded rest yet ({daysWithinLimit} so far), and days of the week remain. This reads “one day” as a local calendar day, midnight to midnight, for a person to confirm.',
  },
};

export const deviationReportTiming: SourceNeutralCheck = {
  title: 'Emergency deviation reported within 10 days, excluding Saturdays, Sundays and Federal holidays',
  target: { subjectKind: 'flight' },
  reads: [records('subject', 'occurrence.emergency-deviation')],
  check: {
    kind: kind('business-days.within', 1),
    params: {
      toField: 'values.record.reportedToAuthorityAt',
      days: 10,
      excludedWeekdays: [6, 7],
      excludedDates: [...federalHolidayCalendar.dates],
      calendarFrom: federalHolidayCalendar.from,
      calendarThrough: federalHolidayCalendar.through,
      whenAbsent: 'not_applicable',
      notDue: occurrenceNotReportable(['occurrence.emergency-deviation']),
    },
  },
  adoptionParameters: [timeZoneParameter],
  wording: {
    pass: 'The report to the authority is recorded by the end of {dueThrough} in {timeZone}, the 10th day after the deviation’s local date {startDay} that is not a Saturday, Sunday or Federal holiday. The deviation’s own day is not counted, and Federal holidays are the observed legal public holidays of 5 U.S.C. 6103 for 2025 through 2027; that reading, whether the deviation was made under § 108.215, and whether the report holds what the paragraph lists are for a person to confirm.',
    pending:
      'No report to the authority is recorded yet; counting 10 days after {startDay} in {timeZone} without Saturdays, Sundays or Federal holidays, it is due by the end of {dueThrough}. That reading of the days is for a person to confirm.',
  },
};

export const partWithinLifeLimit: SourceNeutralCheck = {
  title: 'Life-limited part within its recorded life on the aircraft it is installed on',
  target: { subjectKind: 'component' },
  related: [
    {
      name: 'aircraft',
      subjectKind: 'aircraft',
      fanOut: false,
      whenNone: 'insufficient',
      from: { read: 'limit', field: 'values.record.aircraftId' },
    },
  ],
  reads: [
    records('limit', 'component.life-limit'),
    records('quantity', 'aircraft.time-in-service', 'all', { related: 'aircraft' }, [
      { field: 'values.record.coverage', oneOf: ['complete'] },
    ]),
  ],
  check: {
    kind: kind('value.within-limit', 2),
    params: {
      field: 'values.record.totalTimeHours',
      comparison: 'at_most',
      limitField: 'values.record.lifeLimitHours',
      offsetField: 'values.record.partTimeAtInstallHours',
      measureFrom: 'limit_start',
      unit: 'h',
    },
  },
  wording: {
    pass: 'The part’s time, its recorded time at installation plus the time in service its aircraft recorded since installation, is within the recorded life limit. Flight time after the aircraft’s latest recorded total is not counted, and whether the recorded limit is the one in the manufacturer’s maintenance instructions is for a person to review.',
  },
};

export const coordinatorMakeModelExperience: SourceNeutralCheck = {
  title: 'Each assigned flight coordinator has 5 hours of supervised experience in the planned make and model',
  target: { subjectKind: 'flight' },
  related: [
    {
      name: 'aircraft',
      subjectKind: 'aircraft',
      fanOut: false,
      whenNone: 'insufficient',
      from: { read: 'plan', field: 'secondarySubject' },
    },
    {
      name: 'coordinator',
      subjectKind: 'person',
      fanOut: true,
      whenNone: 'not_applicable',
      from: { read: 'assignments', field: 'values.record.personId' },
    },
  ],
  reads: [
    records('assignments', 'operation.role-assignment', 'all', 'target', coordinatorAssignment),
    records('plan', 'flight.plan'),
    records('reference', 'aircraft.identity', 'latest', { related: 'aircraft' }),
    records('candidate', 'person.aircraft-experience', 'all', { related: 'coordinator' }),
  ],
  check: {
    kind: kind('field.matches', 1),
    params: {
      referenceField: 'values.record.aircraftMakeModel',
      candidateField: 'values.record.aircraftMakeModel',
      candidateScope: 'any',
      textMatch: 'case_insensitive',
      matchedField: 'values.record.supervisedHours',
      matchedComparison: 'at_least',
      matchedLimit: 5,
    },
  },
  wording: {
    pass: 'The aircraft planned for the flight is recorded as {referenceValue} (compared ignoring case and spacing), and this flight coordinator’s experience record in that make and model holds {matchedValue} hours of supervised operating time, at least 5. Who supervised that time, and whether they were one of the persons the paragraph lists, is for a person to review.',
  },
};

export const coordinatorRecency: SourceNeutralCheck = {
  title: 'Each assigned flight coordinator has 5 hours as flight coordinator in the planned make and model recently',
  target: { subjectKind: 'flight' },
  related: coordinatorMakeModelExperience.related,
  // Asked of the coordinator planned for the flight, so every read takes records about a time still to come.
  reads: [
    records('assignments', 'operation.role-assignment', 'all', 'target', coordinatorAssignment),
    records('plan', 'flight.plan'),
    records('reference', 'aircraft.identity', 'latest', { related: 'aircraft' }),
    records('candidate', 'person.aircraft-experience', 'all', { related: 'coordinator' }, [
      { field: 'values.record.role', oneOf: ['flight_coordinator'] },
    ]),
  ].map((read) => ({ ...read, plans: true as const })),
  check: {
    kind: kind('field.matches', 1),
    params: {
      referenceField: 'values.record.aircraftMakeModel',
      candidateField: 'values.record.aircraftMakeModel',
      candidateScope: 'any',
      textMatch: 'case_insensitive',
      matchedField: 'values.record.recentHours',
      matchedComparison: 'at_least',
      matchedLimit: 5,
    },
  },
  wording: {
    pass: 'The aircraft planned for the flight is recorded as {referenceValue} (compared ignoring case and spacing), and this person’s flight coordinator experience record in that make and model holds {matchedValue} hours in its recent period, at least 5. Whether that period is the 12 calendar months before the flight, and whether the hours were served as flight coordinator, are for a person to confirm.',
  },
};

// Reporting clocks and certificate records (pack version 3) --------------------------------------------------------

const reportsOfKind = (name: string, reportKind: string) =>
  records(name, 'organization.report', 'all', 'target', [{ field: 'values.record.reportKind', oneOf: [reportKind] }]);

/** A report of one kind recorded as provided in each period of calendar months inside the adoption's dates. */
function reportEachPeriod(
  title: string,
  reportKind: string,
  months: number,
  periods: 'fixed' | 'rolling',
  pass: string,
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'organization' },
    reads: [reportsOfKind('records', reportKind)],
    check: { kind: kind('periods.each-recorded', 1), params: { months, periods } },
    adoptionParameters: [timeZoneParameter],
    wording: { pass },
  };
}

export const flightHoursReportedMonthly = reportEachPeriod(
  'Flight hours per aircraft recorded as reported in each calendar month',
  'flight_hours',
  1,
  'fixed',
  'A flight-hours report is recorded as provided in each calendar month in {timeZone} that has ended inside the adoption’s dates ({periodsEnded} so far). Whether each gave the total flight hours of every aircraft used, with its make, model, series and registration number, in a form and manner the authority accepts, is for a person to review.',
);

export const reliabilityDataSharedMonthly = reportEachPeriod(
  'Aircraft reliability data recorded as provided to the manufacturer in each calendar month',
  'reliability_data',
  1,
  'fixed',
  'Reliability data is recorded as provided in each calendar month in {timeZone} that has ended inside the adoption’s dates ({periodsEnded} so far). Whether it went to the manufacturer, or the manufacturer collected it, and held what the reliability data paragraph lists, is for a person to review.',
);

export const aircraftListReportedYearly = reportEachPeriod(
  'Aircraft registration and serial numbers recorded as reported at least once each 12 calendar months',
  'aircraft_list',
  12,
  'rolling',
  'A list of the aircraft used is recorded as provided no more than 12 calendar months after the adoption’s start or the list before it, counted in {timeZone}. Whether it named the registration and serial number of every aircraft used is for a person to review.',
);

/** Each event record of a type (meeting the conditions) holds its answer within a deadline. */
function eachEventAnswered(
  title: string,
  subjectKind: SourceNeutralCheck['target']['subjectKind'],
  recordType: string,
  where: Condition[],
  params: Record<string, unknown>,
  wording: SourceNeutralCheck['wording'],
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind },
    reads: [records('events', recordType, 'all', 'target', where)],
    check: { kind: kind('events.answered-within', 1), params },
    ...(params.hours === undefined ? { adoptionParameters: [timeZoneParameter] } : {}),
    wording,
  };
}

export const interruptionCondition: Condition = {
  field: 'values.record.interruptionKind',
  oneOf: ['landing_away', 'route_change_for_mechanical_difficulty'],
};

export const interruptionSummaryTiming = eachEventAnswered(
  'Each interruption included in a summary provided by the end of the 10th day of the following month',
  'flight',
  'occurrence.operation-anomaly',
  [interruptionCondition],
  {
    followingMonthDay: 10,
    answerField: 'values.record.includedInSummaryAt',
    answerLabel: 'summary of interruptions',
  },
  {
    pass: 'Each of the {eventCount} recorded landing(s) away from the normal landing location or route change(s) for a mechanical difficulty is recorded as included in a summary of interruptions provided by the end of the 10th day of the following month in {timeZone}. Whether the summary went to the authority in a form and manner it accepts is for a person to review.',
    pending:
      'No summary of interruptions is recorded yet for a recorded interruption; the earliest is due by the end of {nextDueThrough} in {timeZone}. Reading “the 10th day of the following month” as a local calendar date is for a person to confirm.',
  },
);

export const supervisorChangeNotified = eachEventAnswered(
  'Each change of operations supervisor notified to the authority within 10 days',
  'organization',
  'operation.role-assignment',
  [{ field: 'values.record.role', oneOf: ['operations_supervisor'] }],
  {
    days: 10,
    atField: 'values.record.startsAt',
    answerField: 'values.record.authorityNotifiedAt',
    answerLabel: 'notice to the authority',
  },
  {
    pass: 'Each of the {eventCount} operations supervisor assignment(s) starting inside the adoption’s dates is recorded as notified to the authority by the end of the 10th calendar day after its local date in {timeZone}, the day itself not counted. Reading each assignment’s start as a change in the position, and that reading of the days, are for a person to confirm.',
    pending:
      'No notice to the authority is recorded yet for an operations supervisor assignment; the earliest is due by the end of {nextDueThrough} in {timeZone}, counting 10 calendar days after the assignment’s local start date. That reading of the days is for a person to confirm.',
  },
);

export const dataServiceFailureCondition: Condition = {
  field: 'values.record.dataServiceFailure',
  oneOf: ['yes'],
};

export const dataServiceFailureReported: SourceNeutralCheck = {
  ...eachEventRecordHolds(
    'Each failure of an approved data service recorded as reported to its provider',
    'aircraft',
    'occurrence.mechanical-irregularity',
    { fields: ['reportedToServiceProviderAt'], where: [dataServiceFailureCondition] },
  ),
  wording: {
    pass: 'Each recorded failure, malfunction or defect of an approved data service that endangered or may have endangered the operation is recorded as reported to the data service provider. Whether the report held the date and time, the aircraft, the nature of the failure, the service and its version, the apparent cause and the corrective actions is for a person to review.',
    attention:
      'A recorded failure, malfunction or defect of an approved data service that endangered or may have endangered the operation is not recorded as reported to the data service provider.',
  },
};

export const serviceDifficultyCondition: Condition = {
  field: 'values.record.lossOfControlOrCommunication',
  oneOf: ['yes'],
};

export const serviceDifficultyReportTiming = eachEventAnswered(
  'Each failure that caused a loss of control or communication reported to the manufacturer within 7 days',
  'aircraft',
  'occurrence.mechanical-irregularity',
  [serviceDifficultyCondition],
  {
    days: 7,
    answerField: 'values.record.reportedToManufacturerAt',
    answerLabel: 'report to the manufacturer',
  },
  {
    pass: 'Each of the {eventCount} recorded failure(s) that caused a loss of control or communication is recorded as reported to the manufacturer by the end of the 7th calendar day after its local date in {timeZone}, the day itself not counted. That reading of the days, whether the failure endangered or could have endangered the operation, and whether the report held what the paragraph lists are for a person to confirm.',
    pending:
      'No report to the manufacturer is recorded yet; the earliest is due by the end of {nextDueThrough} in {timeZone}, counting 7 calendar days after the failure’s local date. That reading of the days is for a person to confirm.',
  },
);

export const securityBreachCondition: Condition = {
  field: 'values.record.breachKind',
  oneOf: ['loss_of_control', 'physical_access', 'network_access'],
};

export const securityReportTiming = eachEventAnswered(
  'Each security breach reported to the authority within 96 hours',
  'organization',
  'occurrence.security',
  [securityBreachCondition],
  {
    hours: 96,
    answerField: 'values.record.reportedToAuthorityAt',
    answerLabel: 'report to the authority',
    notDue: occurrenceNotReportable(['occurrence.security']),
  },
  {
    pass: 'Each of the {eventCount} recorded security breach(es) of the kinds the paragraph names is recorded as reported to the authority no later than 96 hours after it occurred. Whether the report held the date and time, nature and scope, vulnerabilities and corrective actions, and whether a supplement followed new information, are for a person to review.',
    pending:
      'No report to the authority is recorded yet for a recorded security breach; the earliest is due by {nextDueBy}, 96 hours after it occurred.',
  },
);

export const reportableEventCondition: Condition = {
  field: 'values.record.meetsReportingCriteria',
  oneOf: ['yes', 'not_determined'],
};

export const eventReportTiming = eachEventAnswered(
  'Each property damage or unauthorized-area event reported to the authority within 10 days',
  'flight',
  'occurrence.property-or-area',
  [reportableEventCondition],
  { days: 10, answerField: 'values.record.reportedToAuthorityAt', answerLabel: 'report to the authority' },
  {
    pass: 'Each of the {eventCount} recorded event(s) the operator did not determine to fall below its reporting criteria is recorded as reported to the authority by the end of the 10th calendar day after its local date in {timeZone}, the day itself not counted. That reading of the days, whether the damage exceeded $500 or the entry followed a system malfunction or failure, and what the report held are for a person to confirm.',
    pending:
      'No report to the authority is recorded yet; the earliest is due by the end of {nextDueThrough} in {timeZone}, counting 10 calendar days after the event’s local date. That reading of the days is for a person to confirm.',
  },
);

/** The organization's operating area records, about it or read for a flight from its organization. */
const operatingAreas = (name: string, about: RuleRead['about']): RuleRead => ({
  name,
  type: 'operator.record',
  versions: [1],
  about,
  required: false,
  select: 'all',
  where: [
    { field: 'values.recordType', oneOf: ['organization.operating-area'] },
    { field: 'values.recordVersion', oneOf: [1] },
  ],
});

/** Every operating area in force states a value: one result for the organization, naming each area. */
function operatingAreasHold(title: string, field: string, describes: string, pass: string): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'organization' },
    reads: [operatingAreas('records', 'target')],
    check: {
      kind: kind('records.each-in-force', 1),
      params: {
        recordLabel: 'operating area',
        idField: 'values.record.areaId',
        values: [{ field: `values.record.${field}`, describes }],
      },
    },
    wording: { pass },
  };
}

export const areaApprovalRecorded = operatingAreasHold(
  'Each current operating area names its approval',
  'areaApprovalReference',
  'approval for the area',
  'Each current operating area ({named}) names the approval the operator holds for it. Whether that approval came from the authority before initial operations in the area is for a person to review.',
);

export const alternateLandingAreasRecorded = operatingAreasHold(
  'Each current operating area names its alternate landing areas',
  'alternateLandingAreas',
  'alternate landing areas',
  'Each current operating area ({named}) names its alternate landing areas. Whether the aircraft can reach them, whether they avoid areas where overflight is not permitted, and whether a landing there is without undue hazard are for a person to review.',
);

export const takeoffLandingAreasRecorded = operatingAreasHold(
  'Each current operating area describes its takeoff, landing and loading areas',
  'takeoffLandingAreas',
  'takeoff, landing and loading areas',
  'Each current operating area ({named}) describes its takeoff, landing and loading areas. Whether they are access-restricted, free of hazardous obstructions and adequate in size, surface and lighting are for a person to review.',
);

/** The latest procedure of one kind is on file and complete. */
function procedureOnFile(title: string, procedureKind: string, pass: string): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'organization' },
    reads: [
      records('record', 'organization.procedure', 'latest', 'target', [
        { field: 'values.record.procedureKind', oneOf: [procedureKind] },
      ]),
    ],
    check: { kind: kind('record.complete', 2), params: { recordType: 'organization.procedure', recordVersion: 1 } },
    wording: { pass },
  };
}

export const lostLinkProcedureOnFile = procedureOnFile(
  'Lost link procedure on file',
  'lost_link',
  'A lost link procedure is on file with its title, document reference, revision and date in effect. Whether it is appropriate for each operating area, and whether communications coverage and availability are adequate there, are for a person to review.',
);

export const cybersecurityPolicyOnFile = procedureOnFile(
  'Cybersecurity policies and processes on file',
  'cybersecurity',
  'Cybersecurity policies and processes are on file with their title, document reference, revision and date in effect. Whether they protect networks, devices and data, limit and remove access as the paragraph lists, and are carried out, is for a person to review.',
);

export const physicalSecurityOnFile = procedureOnFile(
  'Physical security policies and processes on file',
  'physical_security',
  'Physical security policies and processes are on file with their title, document reference, revision and date in effect. Whether they keep people not allowed access out of the pre-designated, access-controlled locations operations are conducted from and protect other controlled access areas, and whether they are carried out, is for a person to review.',
);

export const batteryMonitoringProgramOnFile = procedureOnFile(
  'Battery monitoring program on file',
  'battery_monitoring',
  'A battery monitoring program is on file with its title, document reference, revision and date in effect. Whether the operator uses batteries as a required in-flight power source, and whether the program finds batteries that show significant degradation or inadequate performance so they are removed from service, are for a person to review.',
);

export const trainingProgramOnFile = procedureOnFile(
  'Training program on file',
  'training_program',
  'A training program is on file with its title, document reference, revision and date in effect. Whether the authority accepted it, and whether it holds the initial and recurrent training that keeps each person proficient in each aircraft, position and type of operation, are for a person to review.',
);

export const cybersecurityReviewedYearly: SourceNeutralCheck = {
  title: 'Cybersecurity policies recorded as reviewed at least once each 12 calendar months',
  target: { subjectKind: 'organization' },
  reads: [
    records('records', 'organization.review', 'all', 'target', [
      { field: 'values.record.reviewKind', oneOf: ['cybersecurity_policy'] },
    ]),
  ],
  check: { kind: kind('periods.each-recorded', 1), params: { months: 12, periods: 'rolling' } },
  adoptionParameters: [timeZoneParameter],
  wording: {
    pass: 'A review of the cybersecurity policies is recorded no more than 12 calendar months after the adoption’s start or the review before it, counted in {timeZone}. This reads “at least annually” as at least once in each 12 calendar months; that reading, and whether the review revised the policies where circumstances had changed, are for a person to confirm.',
  },
};

export const trainingDesigneeInRole: SourceNeutralCheck = {
  title: 'A person is designated as responsible for training',
  target: { subjectKind: 'organization' },
  reads: [
    records('interval', 'operation.role-assignment', 'all', 'target', [
      { field: 'values.record.role', oneOf: ['training_designee'] },
    ]),
  ],
  check: {
    kind: kind('interval.covers-window', 2),
    params: {
      select: {
        where: [
          { field: 'values.record.role', oneOf: ['training_designee'] },
          { field: 'values.record.personId', filled: true },
        ],
      },
      openEnd: 'open',
    },
  },
  wording: {
    pass: 'A person is recorded as responsible for training at the evaluation time. Whether they are qualified to determine that operations personnel are trained, and whether their certifications of proficiency are in each person’s record, are for a person to review.',
  },
};

export const recurrentTrainingWithin24Months: SourceNeutralCheck = {
  title: 'Initial or recurrent training completed within the previous 24 calendar months',
  target: { subjectKind: 'person' },
  reads: [
    records('subject', 'person.training', 'all', 'target', [
      { field: 'values.record.trainingKind', oneOf: ['initial', 'recurrent'] },
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
    pass: 'The latest initial or recurrent training recorded for this person was completed within the previous 24 calendar months. Whether it covered the general and make-and-model subject areas of this person’s responsibilities, and how training completed a month early or late is credited, are for a person to review.',
  },
};

export const securityThreatAssessmentHeld: SourceNeutralCheck = {
  title: 'Security threat assessment recorded as held',
  target: { subjectKind: 'person' },
  reads: [
    records('subject', 'person.certificate', 'latest', 'target', [
      { field: 'values.record.credentialKind', oneOf: ['security_threat_assessment'] },
    ]),
  ],
  check: {
    kind: kind('value.one-of', 1),
    params: { field: 'values.record.recordedStatus', expected: ['held'] },
  },
  wording: {
    pass: 'The latest security threat assessment recorded for this person, who holds an operations supervisor or flight coordinator role, is recorded as held. Whether it was completed before they took up the role, meets the standard the paragraph names or is one deemed comparable, and is renewed on its cycle, is for a person to review.',
  },
};

export const securityThreatAssessmentRolesOnRecord: SourceNeutralCheck = {
  title: 'People in the roles that need a security threat assessment are on record',
  target: { subjectKind: 'organization' },
  reads: [
    records('interval', 'operation.role-assignment', 'all', 'target', [
      { field: 'values.record.role', oneOf: ['operations_supervisor', 'flight_coordinator'] },
    ]),
  ],
  check: {
    kind: kind('interval.covers-window', 2),
    params: {
      select: {
        where: [
          { field: 'values.record.role', oneOf: ['operations_supervisor', 'flight_coordinator'] },
          { field: 'values.record.personId', filled: true },
        ],
      },
      openEnd: 'open',
    },
  },
  wording: {
    pass: 'A person is recorded as operations supervisor or as a standing flight coordinator at the evaluation time, so the security threat assessment rule reads that person’s record. People with unescorted access to the aircraft or its cargo, or with access to its control or flight path, are covered persons too; no role on record names them, so whether each holds an assessment is for a person to review.',
  },
};

export const inspectionCurrent: SourceNeutralCheck = {
  title: 'The aircraft within the next due time and hours in service of its latest recorded inspection',
  target: { subjectKind: 'aircraft' },
  reads: [
    records('due', 'aircraft.inspection', 'all'),
    records('opening', 'aircraft.time-in-service', 'all', 'target', [
      { field: 'values.record.coverage', oneOf: ['complete'] },
    ]),
    {
      name: 'additions',
      type: 'flight.report',
      versions: [1],
      about: 'target',
      required: false,
      select: 'all',
      where: [
        { field: 'values.activity', oneOf: ['landed'] },
        { field: 'values.landingAt', filled: true },
      ],
    },
    records('recordedAdditions', 'flight.record', 'all'),
  ],
  check: {
    kind: kind('due.time-or-total', 1),
    params: {
      dueDescribes: 'inspection',
      dueTimeField: 'values.record.nextDueAt',
      dueTotalField: 'values.record.nextDueTimeInServiceHours',
      openingField: 'values.record.totalTimeHours',
      openingAtField: 'values.record.coveredThroughAt',
      additionsStartField: 'values.takeoffAt',
      additionsEndField: 'values.landingAt',
      recordedStartField: 'values.record.takeoffAt',
      recordedEndField: 'values.record.landingAt',
      totalDescribes: 'in service',
      unit: 'h',
    },
  },
  wording: {
    pass: '{reading} Whether the recorded interval and method are the manufacturer’s, and what the inspection found, are for a person to review.',
  },
};

function elementAvailable(title: string, field: string, element: string): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'aircraft' },
    reads: [records('subject', 'aircraft.system-availability')],
    check: {
      kind: kind('value.one-of', 1),
      params: { field: `values.record.${field}`, expected: ['available'], undetermined: ['unknown'] },
    },
    wording: {
      pass: `The latest availability recorded for the aircraft has its ${element} available. Whether other equipment is inoperative, and whether an item was repaired as the manufacturer prescribes or left under the inoperative equipment provisions, are for a person to review.`,
    },
  };
}

export const dockAvailable = elementAvailable('Dock recorded as available', 'dockStatus', 'dock');
export const controlLinkAvailable = elementAvailable(
  'Control link recorded as available',
  'controlLinkStatus',
  'control link',
);
export const batteryAvailable = elementAvailable('Installed battery recorded as available', 'batteryStatus', 'battery');
export const sensorsAvailable = elementAvailable(
  'Supporting sensors recorded as available',
  'sensorStatus',
  'supporting sensors',
);

// What the organization keeps on file (docs/design/on-file-checks.md) -----------------------------------------------

type Conditions = Condition[];

/** The records the organization keeps on file, read as soon as recorded so an issue taking effect later is seen. */
function onFile(name: string, where: Conditions): RuleRead {
  return {
    name,
    type: 'organization.record-in-force',
    versions: [1],
    about: 'target',
    required: false,
    select: 'all',
    plans: true,
    where,
  };
}

/**
 * A controlled document serving a purpose is issued and in effect: one of the types the purpose names, or one ticked as
 * serving it. `what` names the document in the sentence that leaves its content to a person.
 */
export function documentServing(
  title: string,
  serves: { purpose: string; documentTypes?: string[] },
  label: string,
  what: string,
): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'organization' },
    reads: [onFile('records', [{ field: 'values.recordKind', oneOf: ['document'] }])],
    check: { kind: kind('record.in-force', 1), params: { recordLabel: label, serves } },
    wording: {
      pass: `{named} Ledger does not read the document: whether ${what} is for a person to review.`,
    },
  };
}

export const riskMatrixAdopted: SourceNeutralCheck = {
  title: 'A risk matrix adopted',
  target: { subjectKind: 'organization' },
  reads: [onFile('records', [{ field: 'values.recordKind', oneOf: ['risk_matrix'] }])],
  check: { kind: kind('record.in-force', 1), params: { recordLabel: 'adopted risk matrix' } },
  wording: {
    pass: '{named} Whether its severity and likelihood categories and its acceptance levels serve the safety risk management the paragraph requires is for a person to review.',
  },
};

export const hazardsRecordedAndAssessed: SourceNeutralCheck = {
  title: 'Hazards recorded and assessed, as counts on file',
  target: { subjectKind: 'organization' },
  reads: [onFile('records', [{ field: 'values.recordKind', oneOf: ['hazard'] }])],
  check: {
    kind: kind('record.in-force', 1),
    params: {
      recordLabel: 'hazard',
      counts: [
        { where: [{ field: 'values.riskAssessed', oneOf: [true] }], describes: 'assessed on the risk matrix' },
        { where: [{ field: 'values.riskAccepted', oneOf: [true] }], describes: 'with the assessed risk accepted' },
      ],
    },
  },
  wording: {
    pass: '{named} {counts}. These are counts of what is on file; whether the hazards identified are the ones the operation has, and whether each assessment is sound, are for a person to review.',
  },
};

const assuranceType = (type: string) => [
  { field: 'values.assuranceType', oneOf: [type] },
  { field: 'values.item', oneOf: ['record'] },
];

export const safetyAssuranceCounted: SourceNeutralCheck = {
  title: 'Safety assurance records and their actions, as counts on file',
  target: { subjectKind: 'organization' },
  reads: [onFile('records', [{ field: 'values.recordKind', oneOf: ['assurance'] }])],
  check: {
    kind: kind('records.counted', 1),
    params: {
      recordLabel: 'signed safety assurance record',
      select: { where: [{ field: 'values.item', oneOf: ['record'] }] },
      counts: [
        { where: assuranceType('audit'), describes: 'audits of operational processes and systems' },
        { where: assuranceType('program_evaluation'), describes: 'evaluations of the safety program' },
        { where: assuranceType('occurrence_investigation'), describes: 'investigations of an incident or accident' },
        {
          where: assuranceType('noncompliance_investigation'),
          describes: 'investigations of a report of possible non-compliance',
        },
        {
          where: assuranceType('management_review'),
          describes: 'reviews of safety performance by the accountable executive',
        },
        { where: assuranceType('change_assessment'), describes: 'assessments of a new or changed system' },
        { where: assuranceType('hazard_notice_sent'), describes: 'hazard notices sent to another organization' },
        {
          where: assuranceType('hazard_notice_received'),
          describes: 'hazard notices received from another organization',
        },
      ],
      open: {
        select: { where: [{ field: 'values.item', oneOf: ['action'] }] },
        label: 'Actions they set',
        dueField: 'values.dueAt',
      },
    },
  },
  wording: {
    pass: '{stated} These are counts of what is on file; whether the audits, reviews and investigations are the ones the safety program needs, and whether each action was done well, are for a person to review.',
  },
};

/** A person is recorded in a standing organizational role at the evaluation time. */
function standingRole(title: string, role: string, pass: string): SourceNeutralCheck {
  return {
    title,
    target: { subjectKind: 'organization' },
    reads: [
      records('interval', 'operation.role-assignment', 'all', 'target', [
        { field: 'values.record.role', oneOf: [role] },
      ]),
    ],
    check: {
      kind: kind('interval.covers-window', 2),
      params: {
        select: {
          where: [
            { field: 'values.record.role', oneOf: [role] },
            { field: 'values.record.personId', filled: true },
          ],
        },
        openEnd: 'open',
      },
    },
    wording: { pass },
  };
}

export const accountableExecutiveDesignated = standingRole(
  'A person is designated as accountable executive',
  'accountable_executive',
  'A person is recorded in the accountable executive role at the evaluation time. Whether they hold the authority and accountability the safety management system requires is for a person to review.',
);

export const operationsSupervisorNamed = standingRole(
  'The operations supervisor is on record',
  'operations_supervisor',
  'Ledger holds this as a role assignment rather than a document: a person is recorded in the operations supervisor role at the evaluation time. Whether the application names them, and their qualifications, are for a person to review.',
);

// Height, airspace and area: the flown value when the aircraft reported it, the plan otherwise (pack version 3) ------

const FOOT_METERS = 0.3048;

/**
 * The aircraft the flight's plan names. With none named the reads about it are empty and the rule rests on the plan.
 * A position about the aircraft re-evaluates the flights whose planned window has not ended, or ended within a week.
 */
const aircraftOfPlan = (plan: string): NonNullable<SourceNeutralCheck['related']>[number] => ({
  name: 'aircraft',
  subjectKind: 'aircraft',
  fanOut: false,
  whenNone: 'empty',
  from: { read: plan, field: 'secondarySubject' },
  requeue: { windowEnd: { read: plan, field: 'values.record.windowEndsAt' }, endedWithinDays: 7 },
});
const plannedAircraft = aircraftOfPlan('plan');
const planNamed = (name: string): RuleRead => ({ ...records(name, 'flight.plan', 'latest'), plans: true });
const planRead = planNamed('plan');
/** The positions the planned aircraft reported in the planned window: the flight's flown values. */
const positionsInWindow = (name: string, plan: string): RuleRead => ({
  name,
  type: 'position.fix',
  versions: [1],
  about: { related: 'aircraft' },
  required: false,
  select: {
    within: { read: plan, startField: 'values.record.windowStartsAt', endField: 'values.record.windowEndsAt' },
  },
});
const flownPositions = positionsInWindow('flown', 'plan');
const unusableFix = [{ field: 'values.fix', oneOf: ['none'] }];
const datum = (datums: string[]) => [{ field: 'position.altitude.datum', oneOf: datums }];
/**
 * What a reported height measures. A height above ground level, or above the takeoff point (named as such), is
 * compared with a limit above ground; one above the ellipsoid or mean sea level is named and never compared.
 */
const heightMeasures = [
  { where: datum(['ground_level']), describes: 'flown height above ground level', compared: true },
  { where: datum(['takeoff_point']), describes: 'flown height above the takeoff point', compared: true },
  { where: datum(['wgs84_ellipsoid']), describes: 'height above the WGS84 ellipsoid', compared: false },
  { where: datum(['mean_sea_level']), describes: 'height above mean sea level', compared: false },
  { where: datum(['unknown']), describes: 'height against an unstated reference', compared: false },
];

/**
 * A height the operator recorded for the flight is read after heights above ground level the aircraft reported, and
 * before a height above the takeoff point: the operator's figure is above ground (docs/design/observed-values.md).
 */
const heightMeasuresBesideRecord = heightMeasures.map((measure) =>
  measure.where[0]!.oneOf.includes('takeoff_point') ? { ...measure, afterRecorded: true } : measure,
);

export const heightWithinLimit: SourceNeutralCheck = {
  title: 'Height of at most 400 feet above ground, flown or else planned',
  target: { subjectKind: 'flight' },
  related: [plannedAircraft],
  reads: [planRead, records('recorded', 'flight.record'), flownPositions],
  check: {
    kind: kind('value.flown-or-planned', 1),
    params: {
      textUnit: 'ft',
      plannedField: 'values.record.plannedMaxHeightAboveGroundMeters',
      plannedDescribes: 'planned maximum height above ground level',
      recordedField: 'values.record.maxHeightFlownAboveGroundMeters',
      recordedDescribes: 'maximum height flown above ground level in the operator’s flight record',
      flownField: 'position.altitude.meters',
      flownDescribes: 'height',
      measures: heightMeasuresBesideRecord,
      unusable: unusableFix,
      comparison: 'at_most',
      limit: 400 * FOOT_METERS,
      limitDescribes: 'at most 400 feet above ground level, 121.92 m',
      unit: 'm',
    },
  },
  wording: {
    pass: '{reading} A height above the takeoff point is not a height above ground level where the ground rises or falls, and a height the operator recorded is its own figure; those, and the height between reports, are for a person to review.',
    attention:
      '{reading} Whether the flight was in class G airspace and transiting steeply changing terrain, near a structure, or maneuvering to avoid a collision, which the paragraph allows, is for a person to review.',
  },
};

export const airspaceAuthorizationCoversFlight: SourceNeutralCheck = {
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
      plans: true,
    },
    records('recorded', 'flight.record'),
    flownPositions,
  ],
  check: {
    kind: kind('authorization.covers-flight', 1),
    params: {
      textUnit: 'ft',
      plannedStartField: 'values.record.windowStartsAt',
      plannedEndField: 'values.record.windowEndsAt',
      plannedHeightField: 'values.record.plannedMaxHeightAboveGroundMeters',
      plannedHeightDescribes: 'planned maximum height above ground level',
      recordedStartField: 'values.record.takeoffAt',
      recordedEndField: 'values.record.landingAt',
      recordedHeightField: 'values.record.maxHeightFlownAboveGroundMeters',
      recordedHeightDescribes: 'maximum height flown above ground level in the operator’s flight record',
      heightField: 'position.altitude.meters',
      measures: heightMeasures,
      unusable: unusableFix,
      inForce: ['approved'],
      awaiting: ['requested', 'unknown'],
      ceilingDatums: ['ground_level'],
    },
  },
  wording: {
    pass: '{reading} The status is the issuing party’s report. Whether the flight entered airspace the designations name, and kept to the authorization’s other terms, is for a person to review.',
    attention:
      '{reading} An authorization obtained another way is not on record here; whether the flight needed one, and had one, is for a person to review.',
  },
};

export const flownInsideOperatingArea: SourceNeutralCheck = {
  title: 'Positions flown inside an operating area on file for their time',
  target: { subjectKind: 'flight' },
  related: [aircraftOfPlan('window')],
  reads: [planNamed('window'), positionsInWindow('positions', 'window'), operatingAreas('area', 'organization')],
  check: {
    kind: kind('position.in-area', 2),
    params: {
      expect: 'inside',
      scope: 'any',
      minPositions: 2,
      unusable: unusableFix,
      areaRecords: {
        idField: 'values.record.areaId',
        shapeField: 'values.record.shape',
        centerField: 'values.record.center',
        radiusField: 'values.record.radiusMeters',
        pointsField: 'values.record.corridorPoints',
        halfWidthField: 'values.record.corridorHalfWidthMeters',
      },
      windowSelect: { recordType: 'flight.plan', recordVersion: 1 },
      windowStartField: 'values.record.windowStartsAt',
      windowEndField: 'values.record.windowEndsAt',
      coverage: 'optional',
    },
  },
  wording: {
    pass: 'Read the flown positions: every usable position the planned aircraft reported in the planned window is inside an operating area the organization has on file for the time of the position. Whether each area is the one the authority approved, and whether the flight stayed inside between reports, are for a person to review.',
    not_applicable:
      'No position is reported for the planned aircraft in the planned window, and a plan states no path to place, so the check does not apply until positions are on record. Whether the flight kept inside its approved area is for a person to review.',
  },
};

// The aircraft flown, before the flight: inoperative equipment and maintenance (pack version 3) ----------------------

/** The latest record of a type about the planned aircraft at or before the planned start of the flight. */
const beforePlannedStart = (name: string, recordType: string): RuleRead =>
  records(
    name,
    recordType,
    { latestAtOrBefore: { read: 'plan', field: 'values.record.windowStartsAt' } },
    { related: 'aircraft' },
  );

export const inoperativeEquipmentDetermined: SourceNeutralCheck = {
  title: 'Inoperative detect-and-avoid equipment on the aircraft flown determined not to be a hazard',
  target: { subjectKind: 'flight' },
  related: [plannedAircraft],
  reads: [planRead, beforePlannedStart('record', 'aircraft.detect-and-avoid')],
  check: {
    kind: kind('record.complete', 2),
    params: {
      recordType: 'aircraft.detect-and-avoid',
      recordVersion: 1,
      where: [{ field: 'values.record.equipmentState', oneOf: ['inoperative'] }],
      fields: ['hazardDeterminedByName', 'hazardDeterminedAt'],
      whenAbsent: 'not_applicable',
    },
  },
  wording: {
    pass: 'The detect-and-avoid equipment recorded on the planned aircraft before the flight is inoperative, and its record names who determined it does not constitute a hazard to the aircraft, and when. Whether that person is one the operator authorizes to perform maintenance, whether the equipment is needed for the operation, and whether the people operating the flight were told, are for a person to review.',
    attention:
      'The detect-and-avoid equipment recorded on the planned aircraft before the flight is inoperative, and its record does not name who determined that it does not constitute a hazard to the aircraft, or when.',
    not_applicable:
      'No detect-and-avoid equipment is recorded as inoperative on the planned aircraft before the flight. Other inoperative equipment is not in these records; it is for a person to review.',
  },
};

export const flownAfterReturnToService: SourceNeutralCheck = {
  title: 'Flight of an aircraft whose latest maintenance before it is recorded as returned to service',
  target: { subjectKind: 'flight' },
  related: [plannedAircraft],
  reads: [planRead, beforePlannedStart('subject', 'maintenance.action')],
  check: {
    kind: kind('value.recorded-as', 1),
    params: { field: 'values.record.returnedToService', expected: [true] },
  },
  wording: {
    pass: 'The latest maintenance recorded on the planned aircraft before the flight’s planned start is recorded as returned to service. Whether the person who approved it may do so, and whether an operational check was due after it, are for a person to review.',
    attention:
      'The latest maintenance recorded on the planned aircraft before the flight’s planned start is not recorded as returned to service, and the flight is planned after it. Whether the aircraft was approved for return to service before it flew is for a person to review.',
    not_applicable: 'No maintenance is recorded on the planned aircraft before the flight’s planned start.',
  },
};

// Who each rule is meant for (docs/design/rule-coverage.md) -------------------------------------------------------

/** Every person the organization has on record. */
export const people: RulePopulation = { of: 'on_record' };
/** Every aircraft the organization has on record. */
export const aircraft: RulePopulation = { of: 'on_record' };
/** Every life-limited part the organization has on record. */
export const components: RulePopulation = { of: 'on_record' };
/** The organization itself, which is on record as a Ledger subject. */
export const organization: RulePopulation = { of: 'on_record' };
/** The flights whose records fall within the adoption's dates. */
export const flights: RulePopulation = { of: 'in_adoption_dates' };
/** The flights a multiple-aircraft operation record is about: the rules on aircraft per coordinator are for them. */
export const multipleAircraftFlights: RulePopulation = {
  of: 'designated',
  by: {
    type: 'operator.record',
    versions: [1],
    where: [{ field: 'values.recordType', oneOf: ['operation.multiple-aircraft'] }],
    field: 'subject',
  },
};
/** The subjects that the records of one type, meeting the conditions, are about: the rules on events are for them. */
export function aboutEvents(recordType: string, where: readonly Condition[]): RulePopulation {
  return {
    of: 'designated',
    by: {
      type: 'operator.record',
      versions: [1],
      where: [{ field: 'values.recordType', oneOf: [recordType] }, ...where],
      field: 'subject',
    },
  };
}
/** The people role-assignment records name as operations supervisor or flight coordinator. */
export const supervisorsAndCoordinators: RulePopulation = {
  of: 'designated',
  by: {
    type: 'operator.record',
    versions: [1],
    where: [
      { field: 'values.recordType', oneOf: ['operation.role-assignment'] },
      { field: 'values.record.role', oneOf: ['operations_supervisor', 'flight_coordinator'] },
    ],
    field: 'values.record.personId',
  },
};
