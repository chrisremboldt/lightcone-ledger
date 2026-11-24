import { defineOperatorRecordType, recordField } from './define.js';

const required = { required: true } as const;
const replay = { replayOnly: true } as const;
const personSubjects = ['person'] as const;
const personSecondary = ['organization'] as const;

export const personStandingV1 = defineOperatorRecordType({
  recordType: 'person.standing',
  recordVersion: 1,
  title: 'Personnel file',
  subjectKinds: personSubjects,
  secondarySubjectKinds: personSecondary,
  time: { meaning: 'as_of' },
  nameFields: ['fullName'],
  description:
    'The standing personnel file the operator keeps for one person: identity, qualification and duties. The date the person started in the function is in person.employment.',
  mayInfer: ['The operator recorded this identity, qualification summary and duties for the person.'],
  mayNotInfer: [
    'The qualification summary is the operator’s wording; it does not show that a certificate is held or in force (see person.certificate).',
    'This is the standing file, not a per-flight list of who took part.',
  ],
  fields: [
    recordField.text('fullName', 'Full name', required),
    recordField.text('qualificationSummary', 'Qualification', {
      ...required,
      help: 'The qualification the operator relies on for these duties, in the operator’s words.',
    }),
    recordField.longText('duties', 'Duties', required),
    recordField.text('employeeReference', 'Operator’s personnel reference'),
    recordField.text('qualificationSource', 'Source of the qualification', {
      ...replay,
      help: 'Where the operator took the qualification from, such as a certificate copy or a training file.',
    }),
  ],
});

export const personCertificateV1 = defineOperatorRecordType({
  recordType: 'person.certificate',
  recordVersion: 1,
  title: 'Certificate or credential',
  subjectKinds: personSubjects,
  secondarySubjectKinds: personSecondary,
  time: { meaning: 'as_of' },
  description:
    'A certificate, rating or credential the operator recorded as held by the person, with its status as recorded.',
  mayInfer: ['The operator recorded that the person holds this credential with this number, dates and status.'],
  mayNotInfer: [
    'recordedStatus is the operator’s entry, not a check with the issuing body.',
    'An absent expiry date means none was recorded, not that the credential does not expire.',
  ],
  fields: [
    recordField.select(
      'credentialKind',
      'Credential',
      [
        ['remote_pilot_certificate', 'Remote pilot certificate'],
        ['operator_qualification', 'Operator-issued qualification'],
        ['type_rating', 'Aircraft type or model rating'],
        ['security_threat_assessment', 'Security threat assessment'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('credentialNumber', 'Certificate or credential number', required),
    recordField.select(
      'recordedStatus',
      'Status as recorded',
      [
        ['held', 'Held'],
        ['suspended', 'Suspended'],
        ['revoked', 'Revoked'],
        ['surrendered', 'Surrendered'],
        ['expired', 'Expired'],
      ],
      required,
    ),
    recordField.date('issuedOn', 'Issued on'),
    recordField.date('expiresOn', 'Expires on'),
    recordField.text('issuingBody', 'Issued by'),
    recordField.text('copyReference', 'Retained copy reference', replay),
  ],
});

export const personTrainingV1 = defineOperatorRecordType({
  recordType: 'person.training',
  recordVersion: 1,
  title: 'Training',
  subjectKinds: personSubjects,
  secondarySubjectKinds: personSecondary,
  time: { meaning: 'as_of' },
  description:
    'One completed course, test or training event for one person, with its completion date and the evidence the operator retains.',
  mayInfer: ['The operator recorded that the person completed this training on completedOn.'],
  mayNotInfer: [
    'A completion date says nothing about whether the training covered a particular topic beyond trainingKind, courseTitle and program.',
    'A missing training record is not evidence that the training did not happen; it is a missing record.',
    'safetyTraining is the operator’s marking; a record without it says nothing either way about whether the training served the safety program.',
  ],
  fields: [
    recordField.select(
      'trainingKind',
      'Kind of training',
      [
        ['initial', 'Initial'],
        ['recurrent', 'Recurrent'],
        ['knowledge_test', 'Knowledge test'],
        ['aircraft_specific', 'Aircraft-specific'],
        ['role_specific', 'Role-specific'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('courseTitle', 'Course or event', required),
    recordField.date('completedOn', 'Completed on', required),
    recordField.select(
      'program',
      'Program it belongs to',
      [
        ['remote_pilot_certificate', 'Remote pilot certificate: the knowledge test or its recurrent training'],
        ['operator_program', 'The operator’s own training program'],
        ['other', 'Another program'],
      ],
      {
        help: 'Which program the training counts towards, so a rule reads the training of its own program: the recurrent training for the remote pilot certificate and a company recurrent course are two programs, not two dates for one.',
      },
    ),
    recordField.text('evidenceReference', 'Completion evidence reference', {
      ...required,
      help: 'The retained certificate, test report or sign-off that shows completion.',
    }),
    recordField.text('materialsReference', 'Training materials reference', {
      help: 'The controlled version of the materials used.',
    }),
    recordField.text('providerName', 'Training provider'),
    recordField.longText('providerAddress', 'Training provider address'),
    recordField.boolean('safetyTraining', 'Safety training under the safety program', {
      help: 'Yes when this training is part of the organization’s safety program, such as training on safety reporting or hazard identification.',
    }),
    recordField.text('programName', 'Program name', replay),
    recordField.text('instructorName', 'Instructor or examiner', replay),
  ],
});

export const personEmploymentV1 = defineOperatorRecordType({
  recordType: 'person.employment',
  recordVersion: 1,
  title: 'Employment',
  subjectKinds: personSubjects,
  secondarySubjectKinds: personSecondary,
  time: { meaning: 'as_of' },
  description:
    'The person’s employment with the operator: when they started the function, whether they are still employed and, on separation, whether it was for cause.',
  mayInfer: ['The operator recorded this employment status, start date and separation details.'],
  mayNotInfer: [
    'An absent separation date means none was recorded, not that the person is still employed; read employmentStatus.',
  ],
  fields: [
    recordField.select(
      'employmentStatus',
      'Employment status',
      [
        ['employed', 'Employed'],
        ['separated', 'Separated'],
      ],
      required,
    ),
    recordField.date('functionStartedOn', 'Started in this function on', required),
    recordField.date('separatedOn', 'Separated on'),
    recordField.select('separationForCause', 'Released for cause', [
      ['yes', 'Yes'],
      ['no', 'No'],
    ]),
    recordField.longText('separationDetails', 'Release-for-cause details', {
      help: 'What the operator recorded about a release for cause, or an explicit statement that there was none.',
    }),
  ],
});

export const crewDutyPeriodRecordV1 = defineOperatorRecordType({
  recordType: 'crew.duty-period',
  recordVersion: 1,
  title: 'Duty or rest period',
  subjectKinds: personSubjects,
  secondarySubjectKinds: ['organization', 'flight'],
  time: { meaning: 'interval', startField: 'startsAt', endField: 'endsAt' },
  observed: { idField: 'periodId' },
  description:
    'One duty, flight-duty or rest period of one person, as the operator’s schedule records it. Recorded as the crew.duty-period observation the duty and rest rules read, the same as a period from a crew roster; a duty and rest assessment names periods by their period id.',
  mayInfer: ['The operator recorded this period for this person.'],
  mayNotInfer: [
    'An absent end means no end was recorded, not that the person is still on duty.',
    'A gap between recorded periods is not rest unless a rest period is recorded.',
    'A period entered from a schedule reads the same as one worked as scheduled.',
  ],
  fields: [
    recordField.text('periodId', 'Period id', {
      ...required,
      help: 'Your own id for this period, unique among your periods. A duty and rest assessment names periods by it.',
    }),
    recordField.select(
      'period',
      'Kind of period',
      [
        ['duty', 'Duty'],
        ['flight_duty', 'Flight duty'],
        ['rest', 'Rest'],
      ],
      required,
    ),
    recordField.dateTime('startsAt', 'Starts', required),
    recordField.dateTime('endsAt', 'Ends', required),
    recordField.select('role', 'Role', [
      ['remote_pilot', 'Remote pilot'],
      ['visual_observer', 'Visual observer'],
      ['payload_operator', 'Payload operator'],
      ['other', 'Other'],
    ]),
  ],
});

export const personRestAssessmentV1 = defineOperatorRecordType({
  recordType: 'person.rest-assessment',
  recordVersion: 1,
  title: 'Duty and rest assessment',
  subjectKinds: personSubjects,
  secondarySubjectKinds: ['organization', 'flight'],
  time: { meaning: 'event', atField: 'assessedAt' },
  description:
    'The operator’s recorded assessment of one duty period: which rest periods it relied on, the day and week duty totals it stated, and the calendar it used. The periods themselves are duty or rest period records (crew.duty-period), named by their period id.',
  mayInfer: [
    'At assessedAt the operator recorded these totals and these rest periods for the referenced duty period.',
    'Totals are the operator’s stated figures; a rule may compare them with the duty periods it can see.',
  ],
  mayNotInfer: [
    'Totals are not computed by Ledger; they may disagree with the recorded periods.',
    'An assessment of one duty period says nothing about another.',
    'Sign-in or system activity is not rest or duty evidence.',
  ],
  fields: [
    recordField.dateTime('assessedAt', 'Assessed at', required),
    recordField.reference('dutyPeriodId', 'Duty period assessed', 'duty_period', {
      ...required,
      help: 'The period id of the duty period, as you recorded it.',
    }),
    recordField.reference('restPeriodId', 'Continuous rest before the duty period', 'duty_period', {
      ...required,
      help: 'The period id of the rest period, as you recorded it.',
    }),
    recordField.reference('weeklyRestPeriodId', 'Weekly rest period', 'duty_period', {
      ...required,
      help: 'The period id of the weekly rest period, as you recorded it.',
    }),
    recordField.number('calendarDayDutyHours', 'Duty in the calendar day', 'Hours', required),
    recordField.dateTime('weekStartsAt', 'Week starts', {
      ...required,
      help: 'Start of the seven-day week the operator’s schedule uses.',
    }),
    recordField.number('weekDutyHours', 'Duty in the week', 'Hours', required),
    recordField.text('timeZone', 'Schedule time zone', {
      ...required,
      help: 'IANA time zone of the operator’s calendar, such as America/Denver. Times are stored in UTC.',
    }),
    recordField.text('scheduleReference', 'Schedule and rest declaration reference', required),
    recordField.longText('note', 'Note', replay),
  ],
});

export const personAircraftExperienceV1 = defineOperatorRecordType({
  recordType: 'person.aircraft-experience',
  recordVersion: 1,
  title: 'Aircraft experience',
  subjectKinds: personSubjects,
  secondarySubjectKinds: ['organization', 'aircraft'],
  time: { meaning: 'as_of' },
  description:
    'Operating experience the operator recorded for a person on one aircraft make and model in a role: supervised hours, recent hours over a stated period, and the qualification record.',
  mayInfer: ['The operator recorded these hours for the person on this make and model, over the stated period.'],
  mayNotInfer: [
    'Hours are the operator’s figures, not derived from flight observations.',
    'Experience on one make and model says nothing about another.',
  ],
  fields: [
    recordField.select(
      'role',
      'Role',
      [
        ['flight_coordinator', 'Flight coordinator'],
        ['operations_supervisor', 'Operations supervisor'],
        ['pilot_in_command', 'Pilot in command'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.text('aircraftMakeModel', 'Aircraft make and model', required),
    recordField.number('supervisedHours', 'Initial supervised operating time', 'Hours', required),
    recordField.text('supervisorReference', 'Supervisor and evidence reference', required),
    recordField.number('recentHours', 'Operating time in the recent period', 'Hours', required),
    recordField.date('recentPeriodStartsOn', 'Recent period starts on', required),
    recordField.date('recentPeriodEndsOn', 'Recent period ends on', required),
    recordField.text('qualificationReference', 'Operator qualification or requalification record', required),
  ],
});

export const personReadinessDeclarationV1 = defineOperatorRecordType({
  recordType: 'person.readiness-declaration',
  recordVersion: 1,
  title: 'Fitness and substance declaration',
  subjectKinds: personSubjects,
  secondarySubjectKinds: ['flight', 'organization'],
  time: { meaning: 'event', atField: 'declaredAt' },
  description:
    'What a person declared, or the operator recorded, before duty about known medical conditions and alcohol or drug disqualification.',
  mayInfer: ['This statement was recorded at declaredAt.'],
  mayNotInfer: [
    'A declaration of no known condition is the person’s statement, not a medical finding.',
    'A declaration covers the time it was made; it says nothing about later duty.',
  ],
  fields: [
    recordField.dateTime('declaredAt', 'Declared at', required),
    recordField.select(
      'medicalStatement',
      'Medical condition',
      [
        ['no_known_condition', 'No known condition that would interfere'],
        ['condition_reported', 'A condition was reported'],
      ],
      required,
    ),
    recordField.select(
      'substanceStatement',
      'Alcohol and drugs',
      [
        ['no_known_disqualification', 'No known alcohol or drug disqualification'],
        ['removed_from_duty', 'Removed from duty'],
      ],
      required,
    ),
    recordField.text('recordedByName', 'Recorded by', replay),
  ],
});

export const personRecordTypesV1 = [
  personStandingV1,
  crewDutyPeriodRecordV1,
  personCertificateV1,
  personTrainingV1,
  personEmploymentV1,
  personRestAssessmentV1,
  personAircraftExperienceV1,
  personReadinessDeclarationV1,
] as const;
