import type { RulePackPurpose } from '@ledger/contracts';
import { withPopulation } from '@ledger/domain';
import * as checks from './checks.js';
import type { AddedCheckedEntry, AddedUncheckedEntry } from './part108-nprm-v3-added.js';
import { quotedSource, safetyManagementParagraph, type QuotedParagraph } from './retained-document.js';

// What is on file for a certificate application under proposed § 108.505(b) and for the safety management system of
// proposed § 108.560 (docs/design/on-file-checks.md). Each rule asks whether a record is on file and which it is,
// never whether it is adequate.

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

const ADEQUACY =
  'Whether its content addresses what the paragraph asks, and whether the authority accepts it, are for a person; Ledger reports only which document is on file and in effect.';

/** One item of § 108.505(b) a document serves: the purpose it is ticked for, and how a person calls it. */
interface ApplicationItem {
  item: number;
  paragraph: QuotedParagraph;
  purpose: string;
  /** The controlled-document types that serve the purpose by being what they are; none when no type plainly is it. */
  documentTypes?: string[];
  title: string;
  label: string;
  what: string;
}

const applicationItems: readonly ApplicationItem[] = [
  {
    item: 1,
    paragraph: paragraph(
      '108.505(b)(1)',
      1280599,
      1280710,
      '9dd9a8f60029ab5659f8ef3d6ccf6823f094608655025177a1c1ac3b92e70389',
    ),
    purpose: 'part108-nprm.applicant-contact',
    title: 'Applicant name and contact information',
    label: 'document stating the applicant’s name and contact information',
    what: 'it gives the physical address, email address and telephone number',
  },
  {
    item: 2,
    paragraph: paragraph(
      '108.505(b)(2)',
      1280710,
      1280862,
      'eca06abb323acd6f88394a409a66b756c81a19ec8c6edc571dcdfc11679e8d8a',
    ),
    purpose: 'part108-nprm.principal-base',
    title: 'Address of the principal base of operations',
    label: 'document stating the principal base of operations',
    what: 'it gives the address of the principal base of operations',
  },
  {
    item: 4,
    paragraph: paragraph(
      '108.505(b)(4)',
      1280965,
      1281048,
      'd87ae59e88933ebd7222484cec89b85be749097a5634aecb9a4b2d39a9d99ff2',
    ),
    purpose: 'part108-nprm.operation-types',
    title: 'Intended types of operation',
    label: 'description of the intended types of operation',
    what: 'it describes the intended types of operation',
  },
  {
    item: 5,
    paragraph: paragraph(
      '108.505(b)(5)',
      1281048,
      1281126,
      '97c39dd6a9b78a1d5407de58d3a08804843ed6d112c55e26f014d824fd3533b6',
    ),
    purpose: 'part108-nprm.operating-areas',
    title: 'Intended areas of operation',
    label: 'description of the intended areas of operation',
    what: 'it describes each intended area of operation (the operating area records are read by the rules on § 108.165)',
  },
  {
    item: 6,
    paragraph: paragraph(
      '108.505(b)(6)',
      1281126,
      1281186,
      '8138599f3fb7bbb70872619cbac811071751581a770d45db690ed5dcf9ebabe4',
    ),
    purpose: 'part108-nprm.company-manual',
    title: 'Company manual',
    label: 'company manual',
    what: 'it is the company manual § 108.135 describes',
  },
  {
    item: 7,
    paragraph: paragraph(
      '108.505(b)(7)',
      1281186,
      1281247,
      'ea18bbe96510676d611f1e0706e416a82b19e748ba1686457af20cd83edf8f51',
    ),
    purpose: 'part108-nprm.recordkeeping-plan',
    documentTypes: ['recordkeeping_plan'],
    title: 'Recordkeeping plan',
    label: 'recordkeeping plan',
    what: 'it plans the records § 108.40 requires',
  },
  {
    item: 8,
    paragraph: paragraph(
      '108.505(b)(8)',
      1281247,
      1281318,
      'af138f0b1193cfe257ed195ba3e580d91b6c2e24515859fff9b30c2c9cb08def',
    ),
    purpose: 'part108-nprm.reporting-procedures',
    title: 'Operator reporting procedures',
    label: 'operator reporting procedure',
    what: 'it sets out the reports § 108.45 requires',
  },
  {
    item: 9,
    paragraph: paragraph(
      '108.505(b)(9)',
      1281318,
      1281437,
      '467a4d73385cd1982146a452a15d669fd39ececed959bf7d94ffd2fc02d9e0a5',
    ),
    purpose: 'part108-nprm.aircraft-types',
    title: 'Types of unmanned aircraft to be used',
    label: 'document listing the types of unmanned aircraft to be used',
    what: 'it lists each type of aircraft and whether each meets § 108.105',
  },
  {
    item: 10,
    paragraph: paragraph(
      '108.505(b)(10)',
      1281437,
      1281517,
      '5bd022a53a60c1d29dcb0783321ecd4ef00876341d78fc88b1c10a29739f3506',
    ),
    purpose: 'part108-nprm.training-program',
    title: 'Training program',
    label: 'training program document',
    what: 'it is the training program §§ 108.540 and 108.315 describe (a training program recorded as an operator procedure is read by the rule on § 108.540(a))',
  },
  {
    item: 11,
    paragraph: paragraph(
      '108.505(b)(11)',
      1281517,
      1281603,
      '9e560786dc315eeeb78c1c012945b32fde6101bd4c47a843970a5481687b091e',
    ),
    purpose: 'part108-nprm.risk-assessments',
    title: 'Communication and ground risk assessments',
    label: 'communication and ground risk assessment',
    what: 'it holds the assessments § 108.550 requires',
  },
  {
    item: 12,
    paragraph: paragraph(
      '108.505(b)(12)',
      1281603,
      1281672,
      '2f9dc6cecb3f039de0ced6b62bba5ade71e3a07f1d76700b46875b9a1e2ec5e2',
    ),
    purpose: 'part108-nprm.safety-management-system',
    documentTypes: ['sms_manual'],
    title: 'Safety management system description',
    label: 'safety management system description',
    what: 'it describes the safety management system § 108.560 requires (the rules on § 108.560 read what Ledger holds of it)',
  },
  {
    item: 13,
    paragraph: paragraph(
      '108.505(b)(13)',
      1281672,
      1281782,
      'b4f570387a456915c3272619f685c6543fa632f3732c00e790dd97dea865b2e5',
    ),
    purpose: 'part108-nprm.hazardous-materials',
    title: 'Hazardous materials procedures, information and training program',
    label: 'hazardous materials procedure',
    what: 'it holds the procedures, information and training program § 108.570 requires, where the operation carries hazardous materials',
  },
  {
    item: 14,
    paragraph: paragraph(
      '108.505(b)(14)',
      1281782,
      1281875,
      '22cabca6620427e2c00beb889ceb589f870370d5fb6a8f68f7665220ad8042bb',
    ),
    purpose: 'part108-nprm.inoperative-equipment',
    title: 'Procedures for the use of inoperative equipment',
    label: 'inoperative equipment procedure',
    what: 'it permits the use of inoperative equipment as § 108.555 describes',
  },
  {
    item: 15,
    paragraph: paragraph(
      '108.505(b)(15)',
      1281875,
      1281964,
      '36393068ba1dfc64802e9d6e736923f75d56244b6ccd5420d34f220fa98c224c',
    ),
    purpose: 'part108-nprm.duty-rest-plan',
    title: 'Plan for duty and rest requirements',
    label: 'duty and rest plan',
    what: 'it plans for the duty and rest limits of § 108.330',
  },
  {
    item: 16,
    paragraph: paragraph(
      '108.505(b)(16)',
      1281964,
      1282078,
      '79f03661e95f162171db67878f93f18332a03232edb77724358bb9cf0fde5d90',
    ),
    purpose: 'part108-nprm.citizenship',
    title: 'Documentation of citizenship status (package delivery)',
    label: 'documentation of citizenship status',
    what: 'it documents citizenship status, which the paragraph asks only of operators proposing package delivery',
  },
];

const operationsSupervisorItem = paragraph(
  '108.505(b)(3)',
  1280862,
  1280965,
  '9eca55030f256ff3aa0303e94a7b06249beda251f8b84776df04753444f53a90',
);

/** The purposes of § 108.560 a document serves, beside those of § 108.505(b). */
const safetyPolicy = {
  purpose: 'part108-nprm.safety-policy',
  documentTypes: ['safety_policy'],
  title: 'Safety policy',
  paragraph: safetyManagementParagraph,
};
const safetyReporting: { purpose: string; documentTypes?: string[]; title: string; paragraph: QuotedParagraph } = {
  purpose: 'part108-nprm.safety-reporting-procedure',
  title: 'Procedure for receiving safety reports',
  paragraph: safetyManagementParagraph,
};

/** What a rule asks a document to serve: the purpose, and the types that serve it by being what they are. */
const servesOf = (entry: { purpose: string; documentTypes?: string[] }) => ({
  purpose: entry.purpose,
  ...(entry.documentTypes ? { documentTypes: [...entry.documentTypes] } : {}),
});

const organizationOnFile = (spec: checks.SourceNeutralCheck, record: string) =>
  withPopulation(spec, checks.organization, { records: record });

export const onFileCheckedEntries: readonly AddedCheckedEntry[] = [
  ...applicationItems.flatMap((entry): AddedCheckedEntry[] => [
    {
      id: `ledger.nprm.108.505.b.${entry.item}`,
      paragraph: entry.paragraph,
      check: organizationOnFile(
        checks.documentServing(`${entry.title}: a document on file`, servesOf(entry), entry.label, entry.what),
        entry.label,
      ),
      answers: `Per organization: is a controlled document ticked as serving “${entry.title}” issued and in effect, and which revision is it?`,
      forAPerson: ADEQUACY,
    },
  ]),
  {
    id: 'ledger.nprm.108.505.b.3',
    paragraph: operationsSupervisorItem,
    check: withPopulation(checks.operationsSupervisorNamed, checks.organization, {
      interval: 'operations supervisor role assignment',
    }),
    answers:
      'Per organization: does a role assignment name a person as operations supervisor at the evaluation time? Ledger holds this as a record, not a document, and reads the record.',
    forAPerson:
      'Whether the application names that person, and whether they meet § 108.305; the rule on § 108.305(a) reads the same record.',
  },
  {
    id: 'ledger.nprm.108.560.a.safety-policy',
    paragraph: safetyManagementParagraph,
    check: organizationOnFile(
      checks.documentServing(
        'A safety policy issued and in effect',
        servesOf(safetyPolicy),
        'safety policy',
        'it is a safety policy that meets part 5, signed by the accountable executive',
      ),
      'safety policy',
    ),
    answers:
      'Per organization: is a controlled document ticked as its safety policy issued and in effect, and which revision is it?',
    forAPerson: ADEQUACY,
  },
  {
    id: 'ledger.nprm.108.560.a.risk-matrix',
    paragraph: safetyManagementParagraph,
    check: organizationOnFile(checks.riskMatrixAdopted, 'adopted risk matrix'),
    answers: 'Per organization: is a risk matrix adopted, and which version?',
    forAPerson:
      'Whether the matrix, and the safety risk management it serves, meet part 5; Ledger reports which version is adopted and since when.',
  },
  {
    id: 'ledger.nprm.108.560.a.safety-reporting',
    paragraph: safetyManagementParagraph,
    check: organizationOnFile(
      checks.documentServing(
        'A procedure for receiving safety reports issued and in effect',
        servesOf(safetyReporting),
        'procedure for receiving safety reports',
        'it sets up the confidential employee reporting the paragraph’s part 5 requires',
      ),
      'procedure for receiving safety reports',
    ),
    answers:
      'Per organization: is a controlled document ticked as its procedure for receiving safety reports issued and in effect, and which revision is it?',
    forAPerson: `${ADEQUACY} The reports themselves are never read by this rule.`,
  },
  {
    id: 'ledger.nprm.108.560.a.accountable-executive',
    paragraph: safetyManagementParagraph,
    check: withPopulation(checks.accountableExecutiveDesignated, checks.organization, {
      interval: 'accountable executive role assignment',
    }),
    answers: 'Per organization: does a role assignment name a person as accountable executive at the evaluation time?',
    forAPerson: 'Whether that person holds the authority and accountability part 5 describes.',
  },
  {
    id: 'ledger.nprm.108.560.a.hazards',
    paragraph: safetyManagementParagraph,
    check: organizationOnFile(checks.hazardsRecordedAndAssessed, 'hazard'),
    answers:
      'Per organization: how many hazards are on the register, how many of them are assessed on the risk matrix, and how many have their assessed risk accepted?',
    forAPerson:
      'Counts are what is on file, never a judgment: whether the hazards identified are the operation’s, and whether each assessment is sound, are for a person.',
  },
  {
    id: 'ledger.nprm.108.560.a.safety-assurance',
    paragraph: safetyManagementParagraph,
    check: organizationOnFile(checks.safetyAssuranceCounted, 'safety assurance record'),
    answers:
      'Per organization: how many signed safety assurance records (audits, evaluations of the safety program, investigations, reviews of safety performance by the accountable executive, assessments of new or changed systems, hazard notices) were performed within the adoption’s dates, and how many of the actions they set are open and past their due date?',
    forAPerson:
      'Counts are what is on file, never a judgment: whether the safety assurance part 5 describes is done, and whether each action was done well, are for a person.',
  },
];

export const onFileUncheckedEntries: readonly AddedUncheckedEntry[] = [
  {
    id: 'ledger.nprm.108.505.b.17',
    title: 'Additional information the Administrator requests',
    paragraph: paragraph(
      '108.505(b)(17)',
      1282078,
      1282181,
      '3ab6e8e7bab8620cea725de1a0dda33f982fcb0c4e4e520fa5a8e5f99e82c594',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm that any additional information the Administrator determined necessary was provided. What is asked depends on the request, so no record or purpose can stand for it.',
  },
  {
    id: 'ledger.nprm.108.560.b',
    title: 'Exceptions for a sole individual',
    paragraph: paragraph(
      '108.560(b)',
      1293314,
      1293716,
      '753de96a76ab9f0a2971b0f889fddf92ef85820b13fbb73fe8a2758dac6b7527',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm whether one individual performs all the operations functions, and so which provisions of part 5 do not apply. No record states how the organization is staffed.',
  },
  {
    id: 'ledger.nprm.108.560.c',
    title: 'Safety management system information available on request',
    paragraph: paragraph(
      '108.560(c)',
      1293716,
      1293988,
      '89bfbcc77c8cb3d314944d21f0b12e76bf48179f58dd2b24373ba298493a81db',
    ),
    coverage: 'manual',
    waitingFor:
      'Confirm that the information and data showing the safety management system meets part 5 are made available on request. The rules on § 108.560(a) list what is on file; whether it shows the system meets part 5 is a judgment no record holds.',
  },
];

/** What of § 108.560(a) no record bears on: version 2 of the entry version 1 marked as not supported. */
export const safetyManagementRemainder: AddedUncheckedEntry = {
  id: 'ledger.nprm.108.560.a',
  title: 'Safety management system',
  paragraph: safetyManagementParagraph,
  coverage: 'manual',
  waitingFor:
    'Confirm that the safety management system is developed, implemented and kept current and meets part 5, and that it was submitted with the application. The rules beside this one list what is on file: the safety policy, the risk matrix, the procedure for receiving safety reports, the accountable executive, the hazards, and the safety assurance records with their actions; none of them says the system meets part 5.',
};

/** The document purposes version 3 looks for, each quoting the paragraph it serves. */
export function onFilePurposes(documentBytes: Buffer): RulePackPurpose[] {
  return [...applicationItems, safetyPolicy, safetyReporting].map(
    ({ purpose, title, documentTypes, paragraph: quoted }) => ({
      id: purpose,
      title,
      ...(documentTypes ? { documentTypes: [...documentTypes] } : {}),
      source: quotedSource(documentBytes, quoted),
    }),
  );
}
