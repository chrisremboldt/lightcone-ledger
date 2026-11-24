import { withPopulation } from '@ledger/domain';
import * as checks from './checks.js';
import type { AddedCheckedEntry } from './part108-nprm-v3-added.js';
import type { QuotedParagraph } from './retained-document.js';

// The record of each flight performed, item by item. Item (iv), the path, origin, destination and heights, is
// version 2's rule. The operator's flight record is its own log of a flight as flown; items it does not hold (the
// registration, the type of operation, the people) are read for a flight that has one, so a flight with no record of
// having been flown has no item on file.

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

export const flightRecordCheckedEntries: readonly AddedCheckedEntry[] = [
  {
    id: 'ledger.nprm.108.40.a.3.i',
    paragraph: paragraph(
      '108.40(a)(3)(i)',
      1206534,
      1206586,
      'c6a11a88bf8583c9ec2ff46c9e6b47d4f3d6234006b83ec1b6211bbda1c3ccc3',
    ),
    check: withPopulation(checks.flightTimesOnFile, checks.flights),
    answers:
      'Per flight: are its takeoff and landing times on file, from its reports where a source reported them and otherwise from the operator’s flight record, with the duration between them?',
    forAPerson:
      'Whether the times are right, and the date in the operator’s own time zone (the times are UTC). Where the flight record differs from a report, the result names both.',
  },
  {
    id: 'ledger.nprm.108.40.a.3.ii',
    paragraph: paragraph(
      '108.40(a)(3)(ii)',
      1206586,
      1206638,
      '913a5ca012ff2d5296ce33c833ffe8597544e66bcd611757794ef8b5a7655e30',
    ),
    check: withPopulation(checks.registrationOnFile, checks.flights, { flown: 'flight record' }),
    answers:
      'Per flight with a flight record: does the identity record of the aircraft the flight record names hold a registration number?',
    forAPerson: 'Whether the registration was current on the day, and whether the aircraft named is the one flown.',
  },
  {
    id: 'ledger.nprm.108.40.a.3.iii',
    paragraph: paragraph(
      '108.40(a)(3)(iii)',
      1206638,
      1206671,
      'e8358618123932ad0569a7922ee751f4b4d6e72fd9386f68671f229a52daac25',
    ),
    check: withPopulation(checks.operationTypeOnFile, checks.flights, { flown: 'flight record' }),
    answers: 'Per flight with a flight record: does its flight plan state the type of operation?',
    forAPerson: 'Whether the flight was flown as the type its plan states.',
  },
  {
    id: 'ledger.nprm.108.40.a.3.v',
    paragraph: paragraph(
      '108.40(a)(3)(v)',
      1206772,
      1206854,
      '42852071489432a550d89abb2646791e76e1f6eaef84a4ced8be4913b3575dc4',
    ),
    check: withPopulation(checks.operationsPersonnelOnFile, checks.flights, { flown: 'flight record' }),
    answers:
      'Per flight with a flight record: does a role assignment for the flight name a person and a role? Each is listed by the organization’s own id.',
    forAPerson:
      'Which roles count as designated operations personnel, and the names behind the ids (in each person’s standing record).',
  },
  {
    id: 'ledger.nprm.108.40.a.3.vi',
    paragraph: paragraph(
      '108.40(a)(3)(vi)',
      1206854,
      1206943,
      'ad0f14525ae0f240de7b230bb72f0a49672b9a7b01a30c94f444de6c537ebda3',
    ),
    check: withPopulation(checks.landingLocationsOnFile, checks.flights, { primary: 'flight record' }),
    answers: 'Per flight: does the operator’s flight record state where the flight landed, including diversions?',
    forAPerson:
      'Whether the places are different from the takeoff origin or destination, which the paragraph asks for.',
  },
];
