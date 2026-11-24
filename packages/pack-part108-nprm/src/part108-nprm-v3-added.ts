import { withPopulation } from '@ledger/domain';
import * as checks from './checks.js';
import type { RegulatoryLeaf } from './part108-nprm-v1.js';
import type { QuotedParagraph } from './retained-document.js';

/**
 * A paragraph version 3 quotes for the first time, with the check that serves it. `answers` and `forAPerson` are kept
 * beside the entry, not in the pinned leaf: what the check shows, and what in the paragraph it does not.
 */
export interface AddedCheckedEntry {
  id: string;
  paragraph: QuotedParagraph;
  check: checks.SourceNeutralCheck;
  answers: string;
  forAPerson: string;
}

/** A paragraph version 3 quotes for the first time that no check serves, with what a person confirms or why. */
export interface AddedUncheckedEntry {
  id: string;
  title: string;
  paragraph: QuotedParagraph;
  coverage: RegulatoryLeaf['coverage'];
  waitingFor: string;
}

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

const flightData = paragraph(
  '108.45(h)(1)',
  1218640,
  1218876,
  'b578c26b12bfcbb80778ac25a8f8a7e02dbf138dba53a37d2f30d29f315d8664',
);
const availability = { subject: 'availability record' };
const availabilityForAPerson =
  'Whether other equipment is inoperative, and whether an item was repaired as the manufacturer prescribes or is used under the inoperative equipment provisions of § 108.555; the record is per aircraft, not per flight.';
const availabilityParagraph = paragraph(
  '108.610(c)',
  1310113,
  1310410,
  '70f2787fac57fdd5e1139c49746ffc3a7ef8beedf534ae2b73637373d76ca7d6',
);

export const addedCheckedEntries: readonly AddedCheckedEntry[] = [
  // Reporting clocks of § 108.45(h).
  {
    id: 'ledger.nprm.108.45.h.1.flight-hours',
    paragraph: flightData,
    check: withPopulation(checks.flightHoursReportedMonthly, checks.organization, { records: 'flight-hours report' }),
    answers:
      'Per organization: does each calendar month in its time zone that has ended inside the adoption’s dates hold a flight-hours report recorded as provided in that month? Each month without one is named.',
    forAPerson:
      'What the report held (the total flight hours of each aircraft, with make, model, series and registration number) and whether the authority accepts its form and manner. A month only partly inside the adoption’s dates is not counted.',
  },
  {
    id: 'ledger.nprm.108.45.h.1.reliability-data',
    paragraph: flightData,
    check: withPopulation(checks.reliabilityDataSharedMonthly, checks.organization, {
      records: 'reliability data record',
    }),
    answers:
      'Per organization: does each calendar month in its time zone that has ended inside the adoption’s dates hold a record of reliability data provided in that month? Each month without one is named.',
    forAPerson:
      'Whether the data went to the manufacturer or the manufacturer collected it, and whether it held make, model, series and serial number, flight duration, altitude, speed, location and anomalies. An operator whose manufacturer collects the data continuously records one provision a month.',
  },
  {
    id: 'ledger.nprm.108.45.h.2',
    paragraph: paragraph(
      '108.45(h)(2)',
      1218876,
      1219060,
      'bdb70ae2ac04ea2815f14a7013e3d27b5d339d79e262f3b13141629740873233',
    ),
    check: withPopulation(checks.aircraftListReportedYearly, checks.organization, { records: 'aircraft list report' }),
    answers:
      'Per organization: is a list of the aircraft used recorded as provided no more than 12 calendar months after the adoption’s start (counting its month) or after the list before it? Each 12-month period that ended without one is named.',
    forAPerson: 'Whether the list named the registration and serial number of every aircraft used.',
  },
  {
    id: 'ledger.nprm.108.45.h.3',
    paragraph: paragraph(
      '108.45(h)(3)',
      1219060,
      1219231,
      '72e7655fe15e65d0ef52e53c1711707e5a81a442cbe192d401576feb92452c7e',
    ),
    check: withPopulation(
      checks.interruptionSummaryTiming,
      checks.aboutEvents('occurrence.operation-anomaly', [checks.interruptionCondition]),
      { events: 'interruption record' },
    ),
    answers:
      'Per flight with a recorded landing away from the normal landing location or route change for a mechanical difficulty: is each recorded as included in a summary of interruptions provided by the end of the 10th day of the following month?',
    forAPerson:
      'Whether an anomaly is one of the two kinds the paragraph names (the operator records it), and what the summary held. Only anomalies recorded about the flight, or naming it as secondary subject, are read.',
  },
  {
    id: 'ledger.nprm.108.45.h.4',
    paragraph: paragraph(
      '108.45(h)(4)',
      1219231,
      1219558,
      '50b2f26fd094c05e38d7bb56191ce69b425eef0f82bf877e866cb2804f87ac6b',
    ),
    check: withPopulation(
      checks.serviceDifficultyReportTiming,
      checks.aboutEvents('occurrence.mechanical-irregularity', [checks.serviceDifficultyCondition]),
      { events: 'failure record' },
    ),
    answers:
      'Per aircraft with a recorded failure, malfunction or defect that caused a loss of control or communication: is each recorded as reported to the manufacturer by the end of the 7th calendar day after its local date?',
    forAPerson:
      'Whether the failure endangered or could have endangered the operation, whether the operator holds a certificate (the paragraph’s reports are for certificate holders), what the report held, and any supplement. Reports to an automated data service provider about an authorized service are not recorded and are left to a person.',
  },
  {
    id: 'ledger.nprm.108.45.h.5',
    paragraph: paragraph(
      '108.45(h)(5)',
      1219558,
      1219884,
      'bd985bbaf9cd78608dc9e2f169757e0ddddd619a51ec3a188557109fe03d7a69',
    ),
    check: withPopulation(
      checks.securityReportTiming,
      checks.aboutEvents('occurrence.security', [checks.securityBreachCondition]),
      { events: 'security breach record' },
    ),
    answers:
      'Per organization with a recorded security breach of one of the three kinds the paragraph names: is each recorded as reported to the authority no later than 96 hours after it occurred?',
    forAPerson:
      'What the report held (date and time, nature and scope, vulnerabilities, corrective actions) and whether a supplement followed new information. A security occurrence recorded as another kind is not counted.',
  },
  {
    id: 'ledger.nprm.108.45.h.7',
    paragraph: paragraph(
      '108.45(h)(7)',
      1220045,
      1220196,
      '52abac9f6d54f7c4b2545545ecbbda21b84b41feabae9266908ad07b8548bdd4',
    ),
    check: withPopulation(
      checks.eventReportTiming,
      checks.aboutEvents('occurrence.property-or-area', [checks.reportableEventCondition]),
      { events: 'property or unauthorized-area event record' },
    ),
    answers:
      'Per flight with a recorded property damage or unauthorized-area event that the operator did not determine to fall below its reporting criteria: is each recorded as reported to the authority by the end of the 10th calendar day after its local date?',
    forAPerson:
      'Whether the damage to property other than the aircraft exceeded $500, or the entry followed a malfunction or failure of a system: the operator records its determination, and an event recorded as not meeting the criteria is not counted. What the report held is also for a person.',
  },
  // Area of operations.
  {
    id: 'ledger.nprm.108.165.a',
    paragraph: paragraph(
      '108.165(a)',
      1228659,
      1228830,
      'f192bf2cd69bc2ed2d96609a65ef4fdcb4d868b933c132bd808fc5d57410a143',
    ),
    check: withPopulation(checks.areaApprovalRecorded, checks.organization, { records: 'operating area' }),
    answers:
      'Per organization: does each current operating area, by its own id, name the approval the operator holds for it? With none current, no operating area is on file.',
    forAPerson:
      'Whether the approval came from the authority, in a manner it accepts, before initial operations in the area. Whether flights stayed inside the areas is the rule on positions flown.',
  },
  {
    id: 'ledger.nprm.108.165.b',
    paragraph: paragraph(
      '108.165(b)',
      1228830,
      1229194,
      '166c618d7b74704adb6a817eac0510c17cceb475824a590c7604ae1ac7fbdd3b',
    ),
    check: withPopulation(checks.alternateLandingAreasRecorded, checks.organization, { records: 'operating area' }),
    answers: 'Per organization: does each current operating area, by its own id, name its alternate landing areas?',
    forAPerson:
      'Whether the aircraft can reach them, whether they avoid areas where overflight is not permitted, and whether a landing there is without undue hazard to persons or property.',
  },
  {
    id: 'ledger.nprm.108.165.c',
    paragraph: paragraph(
      '108.165(c)',
      1229194,
      1229518,
      '204f142c406e9e6303d11841a7744a30ff40307174f867f09000c3ec0730a656',
    ),
    check: withPopulation(checks.takeoffLandingAreasRecorded, checks.organization, { records: 'operating area' }),
    answers:
      'Per organization: does each current operating area, by its own id, describe its takeoff, landing and loading areas?',
    forAPerson:
      'Access restriction to participants, freedom from hazardous obstructions, and adequacy in size, surface and lighting.',
  },
  {
    id: 'ledger.nprm.108.165.d',
    paragraph: paragraph(
      '108.165(d)',
      1229518,
      1229625,
      '5ccc3b8bc320ca3ab84ca80cbf762c82f051283b5658a20f2a6b384b1e516fb7',
    ),
    check: withPopulation(checks.lostLinkProcedureOnFile, checks.organization, { record: 'lost link procedure' }),
    answers: 'Per organization: is a lost link procedure on file with its title, reference, revision and date?',
    forAPerson:
      'Whether communications coverage and availability are adequate in each operating area, and whether the procedure is appropriate there; the communication assessment of § 108.550(a) is its own rule.',
  },
  // Personnel, training and security.
  {
    id: 'ledger.nprm.108.315.d',
    paragraph: paragraph(
      '108.315(d)',
      1252402,
      1252853,
      'dc5006f9771aa1f3ffc6f8fd9654b33a5f74459da1906e0718cf695754085c12',
    ),
    check: withPopulation(checks.recurrentTrainingWithin24Months, checks.people, {
      subject: 'initial or recurrent training record',
    }),
    answers:
      'Per person: was the latest initial or recurrent training recorded for them completed within the previous 24 calendar months (a date in month M counts through the last day of month M + 24)?',
    forAPerson:
      'Whether the training covered the general and make-and-model subject areas of this person’s responsibilities, and the paragraph’s credit for training completed in the month before or after the month it was required.',
  },
  {
    id: 'ledger.nprm.108.335.a',
    paragraph: paragraph(
      '108.335(a)',
      1256040,
      1256623,
      '74838436ef574bc1350c583eaf1acdcf9a7865b465249c97c887ba955005b763',
    ),
    check: withPopulation(checks.securityThreatAssessmentHeld, checks.supervisorsAndCoordinators, {
      subject: 'security threat assessment',
    }),
    answers:
      'Per person a role assignment names as operations supervisor or flight coordinator: is their latest recorded security threat assessment recorded as held?',
    forAPerson:
      'The other covered persons (unescorted access to the aircraft or its cargo, or access to its control or flight path), which no record names; whether the assessment was completed before the person took up the function; whether one held is deemed comparable; and renewal.',
  },
  {
    id: 'ledger.nprm.108.535.a',
    paragraph: paragraph(
      '108.535(a)',
      1286801,
      1287034,
      '5dc31683c58ea336f4720d8006815ccdfda34346cdb4455422ed7e7d9a9a637d',
    ),
    check: withPopulation(checks.cybersecurityPolicyOnFile, checks.organization, { record: 'cybersecurity policy' }),
    answers:
      'Per organization: are cybersecurity policies and processes on file with their title, reference, revision and date?',
    forAPerson: 'What the policies say and whether they are carried out; Ledger does not read the document.',
  },
  {
    id: 'ledger.nprm.108.535.c',
    paragraph: paragraph(
      '108.535(c)',
      1287573,
      1287718,
      '0bf0b3889f8c938bfff4dabeca96513f76356c14e2c7b386beb847bb05113987',
    ),
    check: withPopulation(checks.cybersecurityReviewedYearly, checks.organization, {
      records: 'review of the cybersecurity policies',
    }),
    answers:
      'Per organization: is a review of the cybersecurity policies recorded no more than 12 calendar months after the adoption’s start (counting its month) or after the review before it? Each 12-month period that ended without one is named.',
    forAPerson:
      'Reading “at least annually” as at least once in each 12 calendar months, and whether the policies were revised where circumstances changed.',
  },
  {
    id: 'ledger.nprm.108.540.a',
    paragraph: paragraph(
      '108.540(a)',
      1287758,
      1288211,
      '3a138c0a3e1fec4e2284b6a6d4221755770a504e492e5bb87c123238b848ef78',
    ),
    check: withPopulation(checks.trainingProgramOnFile, checks.organization, { record: 'training program' }),
    answers: 'Per organization: is a training program on file with its title, reference, revision and date?',
    forAPerson:
      'Whether the authority accepted it and whether it holds initial and recurrent training under § 108.315 for each aircraft, position and type of operation; each person’s training is checked by the rule on § 108.315(d).',
  },
  {
    id: 'ledger.nprm.108.540.d',
    paragraph: paragraph(
      '108.540(d)',
      1288591,
      1288993,
      '9771e1a608524bb3573f9a36d32e42380704d7430421ea002d18c14d32d0f507',
    ),
    check: withPopulation(checks.trainingDesigneeInRole, checks.organization, {
      interval: 'training designee role assignment',
    }),
    answers:
      'Per organization: does a role assignment name a person responsible for training, in effect at the evaluation time?',
    forAPerson:
      'Whether the person is qualified to determine that personnel are trained, and whether their certification of each person’s proficiency is in that person’s record.',
  },
  // Maintenance.
  {
    id: 'ledger.nprm.108.610.b',
    paragraph: paragraph(
      '108.610(b)',
      1309857,
      1310113,
      '573b11b2509f60d99a2d04c43825eb04b3282d682ea3e902f6fa0f9c7246b0f3',
    ),
    check: withPopulation(checks.inspectionCurrent, checks.aircraft, { due: 'inspection record' }),
    answers:
      'Per aircraft: is it, now, within the next due time and the next due hours in service of its latest recorded inspection, whichever comes first? The hours are its latest recorded total with complete coverage and the flights since.',
    forAPerson:
      'Whether the recorded interval and method are those of the manufacturer’s inspection criteria, and what the inspection found (an unserviceable result is recorded but not judged here).',
  },
  {
    id: 'ledger.nprm.108.610.c.dock',
    paragraph: availabilityParagraph,
    check: withPopulation(checks.dockAvailable, checks.aircraft, availability),
    answers: 'Per aircraft: does its latest availability record have the dock available?',
    forAPerson: availabilityForAPerson,
  },
  {
    id: 'ledger.nprm.108.610.c.control-link',
    paragraph: availabilityParagraph,
    check: withPopulation(checks.controlLinkAvailable, checks.aircraft, availability),
    answers: 'Per aircraft: does its latest availability record have the control link available?',
    forAPerson: availabilityForAPerson,
  },
  {
    id: 'ledger.nprm.108.610.c.battery',
    paragraph: availabilityParagraph,
    check: withPopulation(checks.batteryAvailable, checks.aircraft, availability),
    answers: 'Per aircraft: does its latest availability record have the installed battery available?',
    forAPerson: availabilityForAPerson,
  },
  {
    id: 'ledger.nprm.108.610.c.sensors',
    paragraph: availabilityParagraph,
    check: withPopulation(checks.sensorsAvailable, checks.aircraft, availability),
    answers: 'Per aircraft: does its latest availability record have the supporting sensors available?',
    forAPerson: availabilityForAPerson,
  },
];

export const addedUncheckedEntries: readonly AddedUncheckedEntry[] = [
  {
    id: 'ledger.nprm.108.165.e',
    title: 'Planned operations minimize risk on the ground',
    paragraph: paragraph(
      '108.165(e)',
      1229625,
      1229808,
      'b01062344a7b36dec4c87f9a2315bea363bbda678e8e4d561fe2f47a764fbec3',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm that the planned operations in each operating area minimize risk to persons and property on the ground and consider the terrain and obstacles the operator intends to overfly. This is a judgment no record holds.',
  },
  {
    id: 'ledger.nprm.108.530.a',
    title: 'Recency of each operation under the certificate',
    paragraph: paragraph(
      '108.530(a)',
      1286110,
      1286360,
      '17f46d74f70b282bc701b2eb9fe71dfad376d762de4d8539d169b2c00c192bc8',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm that the operator conducted each operation its certificate authorizes within the 12 calendar months before conducting it again, or holds authorization to resume. Flight plans record the kind of each operation, but a rule reads one flight’s records at a time and no record lists the operations a certificate authorizes.',
  },
];
