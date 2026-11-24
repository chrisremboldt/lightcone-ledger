import { withPopulation } from '@ledger/domain';
import * as checks from './checks.js';
import type { AddedCheckedEntry, AddedUncheckedEntry } from './part108-nprm-v3-added.js';
import type { QuotedParagraph } from './retained-document.js';

// Paragraphs an applicant looks for that the earlier rules left out: the coordinator's recency, notice of a new
// operations supervisor, the battery monitoring program, physical security, inoperative equipment, a failure of an
// approved data service, validation tests; and the organization-level rules that say what is not on file where a
// rule's population would otherwise be empty.

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

/** § 108.630(a), as version 2's rule about each aircraft quotes it; the rule about each flight quotes it too. */
const afterMaintenance = paragraph(
  '108.630(a)',
  1312726,
  1313057,
  '512230f5647eecfece902772d0c124d3afb0c09a727f70df1f07815d1a363ede',
);

export const depthCheckedEntries: readonly AddedCheckedEntry[] = [
  {
    id: 'ledger.nprm.108.45.d.2',
    paragraph: paragraph(
      '108.45(d)(2)',
      1215503,
      1216308,
      '40ae610be2b8d79d1ce39a1be7775cb533f24c2341d98185cc84af7e215377ab',
    ),
    check: withPopulation(
      checks.dataServiceFailureReported,
      checks.aboutEvents('occurrence.mechanical-irregularity', [checks.dataServiceFailureCondition]),
    ),
    answers:
      'Per aircraft a mechanical irregularity record is about that records a failure of an approved data service that endangered or may have endangered the operation: is each such record recorded as reported to the data service provider?',
    forAPerson:
      'What the report held (date and time, aircraft, nature, the service and its version, apparent cause, corrective actions). The paragraph sets no deadline, so none is counted.',
  },
  {
    id: 'ledger.nprm.108.150.c',
    paragraph: paragraph(
      '108.150(c)',
      1227775,
      1228068,
      'c74920e0db352b72d6b6525517dccc121ae0be435d1350eac99b2c371f9ab4e8',
    ),
    check: withPopulation(checks.physicalSecurityOnFile, checks.organization, {
      record: 'physical security policies and processes',
    }),
    answers:
      'Per organization: are physical security policies and processes on file with their title, reference, revision and date?',
    forAPerson: 'What they hold, and whether they are carried out at the locations operations are conducted from.',
  },
  {
    id: 'ledger.nprm.108.305.b',
    paragraph: paragraph(
      '108.305(b)',
      1247306,
      1247434,
      '615dc42ff28c118f5c01746b52f792ab75416f83e5152daf97a0d82f52474d4b',
    ),
    check: withPopulation(checks.supervisorChangeNotified, checks.organization),
    answers:
      'Per organization: is each operations supervisor assignment starting inside the adoption’s dates recorded as notified to the authority within 10 calendar days, in the time zone the organization sets?',
    forAPerson:
      'Whether an assignment is a change in the person in the position (the first assignment may not be), how the notice was given, and an ending without a new assignment.',
  },
  {
    id: 'ledger.nprm.108.310.f',
    paragraph: paragraph(
      '108.310(f)',
      1249502,
      1249843,
      '2d7cedfdaf13d6a021efdc31c6095e26a31512f3278ecc5d3a06d3d06828b621',
    ),
    check: withPopulation(checks.coordinatorRecency, checks.flights),
    answers:
      'Per flight, one result for each person assigned as flight coordinator: does a flight coordinator experience record in the make and model of the aircraft the flight plan names hold at least 5 hours in its recent period?',
    forAPerson:
      'Whether the recent period the record states is the 12 calendar months before the flight, and requalification after a lapse (§ 108.310(g)).',
  },
  {
    id: 'ledger.nprm.108.335.b',
    paragraph: paragraph(
      '108.335(b)',
      1256619,
      1257083,
      '229e173bb4442cd7353d4d179787c3ba54ce0725853814d6666a245dd9510c07',
    ),
    check: withPopulation(checks.securityThreatAssessmentRolesOnRecord, checks.organization, {
      interval: 'operations supervisor or flight coordinator role assignment',
    }),
    answers:
      'Per organization: is a person recorded as operations supervisor or as a standing flight coordinator? Without one, the security threat assessment rule covers no one, and this rule says so.',
    forAPerson:
      'The covered persons no role names: unescorted access to the aircraft or its cargo, or access to its control or flight path.',
  },
  {
    id: 'ledger.nprm.108.555.a',
    paragraph: paragraph(
      '108.555(a)',
      1291780,
      1292805,
      '80ff8dd76332bfb912ed3a68c7a9e3578f8b804adcee59222b2a7b17586eab8a',
    ),
    check: withPopulation(checks.inoperativeEquipmentDetermined, checks.flights, { plan: 'flight plan' }),
    answers:
      'Per flight: when the latest detect-and-avoid record of the planned aircraft before the planned start records the equipment as inoperative, does it name who determined it does not constitute a hazard, and when?',
    forAPerson:
      'Other inoperative equipment, which no record holds; whether the equipment is one the manufacturer, subpart H or the operation requires; whether it was removed or deactivated; and whether the people operating were told.',
  },
  {
    id: 'ledger.nprm.108.620.a',
    paragraph: paragraph(
      '108.620(a)',
      1311970,
      1312086,
      '371a97965fc62caf55938462d7fe4b939aea5b80842531e846531cccfdf3a44d',
    ),
    check: withPopulation(checks.batteryMonitoringProgramOnFile, checks.organization, {
      record: 'battery monitoring program',
    }),
    answers: 'Per organization: is a battery monitoring program on file with its title, reference, revision and date?',
    forAPerson: 'Whether batteries are a required in-flight power source, and what the program monitors.',
  },
  {
    id: 'ledger.nprm.108.630.a.flight',
    paragraph: afterMaintenance,
    check: withPopulation(checks.flownAfterReturnToService, checks.flights, { plan: 'flight plan' }),
    answers:
      'Per flight: is the latest maintenance recorded on the planned aircraft before the planned start recorded as returned to service? One not recorded as returned to service needs attention.',
    forAPerson:
      'Who approved the return to service, whether the maintenance entry is complete, and the operational check of § 108.630(b).',
  },
];

export const depthUncheckedEntries: readonly AddedUncheckedEntry[] = [
  {
    id: 'ledger.nprm.108.545.a',
    title: 'Validation tests',
    paragraph: paragraph(
      '108.545(a)',
      1289803,
      1290596,
      '51a7df679f604dfaadede5e70924dabfc1abb56bbfec3b89c574e7c12115035c',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm that validation tests were conducted when the paragraph requires them: during the application, for each make and model not validated before, for special authorizations, and for more than one aircraft per flight coordinator. The tests are conducted with the authority; no record type holds their acceptance.',
  },
  {
    id: 'ledger.nprm.108.620.b',
    title: 'Batteries showing degradation removed from service',
    paragraph: paragraph(
      '108.620(b)',
      1312086,
      1312219,
      'ef462ba5b5175fa7d18184d7290ee31e80dac9059428040cf0024871d7fd6881',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm that batteries indicating significant degradation or inadequate performance were removed from service. Battery availability is recorded per aircraft, but no record says what the monitoring found.',
  },
];
