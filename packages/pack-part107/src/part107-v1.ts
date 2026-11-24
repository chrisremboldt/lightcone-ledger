import type { CheckedRuleLeaf, RulePackLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, withPopulation } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import * as checks from './checks.js';
import {
  PART107_EDITION_DATE,
  part107Document,
  part107Filename,
  paragraph,
  quotedSource,
  readRetainedDocument,
  type QuotedParagraph,
} from './retained-document.js';
import { versionTwo } from './part107-v2.js';

export const PART107_PACK_ID = 'ledger.part107';

const VERSION_ONE_DIGEST = '0daefd9d75ae430ccf9d6499f0c9104eeb4668752b250b81193ad6e412bbc3d9';

type RegulatoryLeaf = Extract<RulePackLeaf, { coverage: 'manual' | 'unsupported' }>;

/** A quoted paragraph and the check that serves it. */
interface CheckedEntry {
  id: string;
  paragraph: QuotedParagraph;
  check: checks.SourceNeutralCheck;
}

/** A quoted paragraph no check serves, with what it waits for. */
interface UncheckedEntry {
  id: string;
  title: string;
  paragraph: QuotedParagraph;
  coverage: RegulatoryLeaf['coverage'];
  /** What a person reviews, or the engine capability the rule needs; kept beside the entry, not in the pinned leaf. */
  waitingFor: string;
}

const certificate = paragraph(
  '107.12(b)',
  18130,
  18403,
  '68d7e0b9da22153109fe3e62c8b571113281faa3885ed4934e2632f6bb3a938b',
);
const safeCondition = paragraph(
  '107.15(a)',
  19133,
  19410,
  '4c1cb13b62b6092ebcc5751a621442725c8ea8ced84014a827c919213b10741a',
);
const cloudClearance = paragraph(
  '107.51(d)',
  35211,
  35431,
  '20793c0d5b390f7c18897a7bd0971486c7eb52e09889266c0e0be5def80fc410',
);
const safetyEventReporting = paragraph(
  '107.9 and 107.9(a)',
  15985,
  16362,
  '6145e5eae34c40aac2b205d3a84c864db42cea4528517037eb4cdc1429a35c71',
);

export const checkedEntries: readonly CheckedEntry[] = [
  {
    id: 'ledger.part107.107.12.b',
    paragraph: certificate,
    check: withPopulation(checks.remotePilotCertificateHeld, checks.remotePilots, {
      subject: 'remote pilot certificate',
    }),
  },
  {
    id: 'ledger.part107.107.65',
    paragraph: paragraph('107.65', 43478, 44251, '759020efe4e29a6a5b1ae2f4615620679aed562f5b1858f16b8cfa26e633c877'),
    check: withPopulation(checks.aeronauticalKnowledgeRecency, checks.remotePilots, {
      subject: 'knowledge test or recurrent training for the remote pilot certificate',
    }),
  },
  {
    id: 'ledger.part107.107.19.a',
    paragraph: paragraph('107.19(a)', 20343, 20458, 'd9d4cce5d8a6770aade9bc2fe71037f6da4609a881f4b3f6f90104c4cceea3dc'),
    check: withPopulation(checks.pilotInCommandDesignated, checks.flights, { window: 'flight plan' }),
  },
  {
    id: 'ledger.part107.107.13',
    paragraph: paragraph('107.13', 18804, 18961, '99a19304444fbf00e8b30838c1e1907405915ab90a22b164042c07624d2c590a'),
    check: withPopulation(checks.registrationRecorded, checks.aircraft, { record: 'aircraft identity record' }),
  },
  {
    id: 'ledger.part107.107.15.a',
    paragraph: safeCondition,
    check: withPopulation(checks.noKnownUnsafeCondition, checks.aircraft, { subject: 'aircraft condition record' }),
  },
  {
    id: 'ledger.part107.107.17',
    paragraph: paragraph('107.17', 19790, 20176, 'e0f3cbf74043e57b9496c50686706f2f0d63f60cf1456b12bc3463b7746ab0c5'),
    check: withPopulation(checks.noKnownMedicalCondition, checks.participants, {
      subject: 'fitness and substance declaration',
    }),
  },
  {
    id: 'ledger.part107.107.27',
    paragraph: paragraph('107.27', 23186, 23403, 'cb5dd5c6bdedb88c42acc092beef6086ef771d5d75e941d8435f42435cc2e84c'),
    check: withPopulation(checks.noKnownSubstanceDisqualification, checks.flightCrew, {
      subject: 'fitness and substance declaration',
    }),
  },
  {
    id: 'ledger.part107.107.31.a',
    paragraph: paragraph('107.31(a)', 26002, 26770, 'cd4c2d52198f0f12d56b0c89e7d83f46678dfad72c825cc1fbe529d89e6d4528'),
    check: withPopulation(checks.plannedWithinVisualLineOfSight, checks.flights, { subject: 'flight plan' }),
  },
  {
    id: 'ledger.part107.107.36',
    paragraph: paragraph('107.36', 28873, 29025, 'e7a9589b4e1aae62d95717e1d384e522ceed22cd591646f7427a1098220c0590'),
    check: withPopulation(checks.payloadNotHazardous, checks.flights, { subject: 'payload declaration' }),
  },
  {
    id: 'ledger.part107.107.49.a',
    paragraph: paragraph(
      '107.49 and 107.49(a)',
      32209,
      32718,
      '61c5095bfc95fc09d9744323d680a8201d21cf0d0b1d81d18bb2e309a40bcd99',
    ),
    check: withPopulation(checks.operatingEnvironmentAssessed, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.part107.107.49.b',
    paragraph: paragraph('107.49(b)', 32735, 32975, 'ac6efdcec7c6d73b66dfa74dbfddd82efed44b2c920d18a3df308d01e57b93bd'),
    check: withPopulation(checks.participantsInformed, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.part107.107.49.c-e',
    paragraph: paragraph(
      '107.49(c)-(e)',
      32992,
      33524,
      '9dfb15e45713f18b99c4f8993cd34cb2c37cd0820b979acaded460ec2451af09',
    ),
    check: withPopulation(checks.linkPowerAndLoadChecked, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.part107.107.51.a',
    paragraph: paragraph('107.51(a)', 34349, 34452, '7e3078e38c1f47e10db5fdb296d2c54150f1d3472a11e1b3bb7dceac38fbac8a'),
    check: withPopulation(checks.groundSpeedWithinLimit, checks.flights, { plan: 'flight plan' }),
  },
  {
    id: 'ledger.part107.107.51.b',
    paragraph: paragraph('107.51(b)', 34469, 34801, '6a2457686c13049a54a17c414af3291009c9ad88253582dff9c6a9cb078b1ca6'),
    check: withPopulation(checks.heightWithinLimit, checks.flights, { plan: 'flight plan' }),
  },
  {
    id: 'ledger.part107.107.51.c',
    paragraph: paragraph('107.51(c)', 34818, 35194, 'ab99c30b142222e96ddd9894145b30289f198d3f4727a6fdcf70a036b5d6b6c1'),
    check: withPopulation(checks.visibilityAtLeastMinimum, checks.flights, { quantity: 'preflight assessment' }),
  },
  {
    id: 'ledger.part107.107.51.d.1',
    paragraph: cloudClearance,
    check: withPopulation(checks.cloudClearanceBelow, checks.flights, { quantity: 'preflight assessment' }),
  },
  {
    id: 'ledger.part107.107.51.d.2',
    paragraph: cloudClearance,
    check: withPopulation(checks.cloudClearanceHorizontal, checks.flights, { quantity: 'preflight assessment' }),
  },
  {
    id: 'ledger.part107.107.9.a',
    paragraph: safetyEventReporting,
    check: withPopulation(checks.injuryReportRecorded, checks.flights),
  },
];

export const uncheckedEntries: readonly UncheckedEntry[] = [
  {
    id: 'ledger.part107.107.15.b',
    title: 'Flight not continued once the aircraft is no longer in a condition for safe operation',
    paragraph: paragraph('107.15(b)', 19427, 19629, '64be66aa691188b8cba3c9604d006627dc9f9d1e9301cef872e926c43b36ddbf'),
    coverage: 'manual',
    waitingFor: 'A person: what the pilot knew or had reason to know during the flight is not in a record.',
  },
  {
    id: 'ledger.part107.107.21.b',
    title: 'Written report of an emergency deviation sent on request',
    paragraph: paragraph('107.21(b)', 21806, 22009, '7b4e0e3bf24ee1be6ea57747210b22c3054e83baded2e13a4f6f0b730600afb8'),
    coverage: 'manual',
    waitingFor: 'A person: the report is due only on the Administrator’s request, which no record holds.',
  },
  {
    id: 'ledger.part107.107.9.b',
    title: 'Report of property damage beyond the stated repair cost or value',
    paragraph: paragraph('107.9(b)', 16379, 16800, 'c27f64ae621c5ab08f0697fb86af29613be4d4f3c9ca7d36c13d01f063f5227f'),
    coverage: 'manual',
    waitingFor: 'A person: whether repair cost or fair market value exceeds $500 is a judgment on free-text estimates.',
  },
  {
    id: 'ledger.part107.107.9.timing',
    title: 'Safety event reported within 10 calendar days',
    paragraph: paragraph('107.9', 15985, 16273, 'a75f6f52479b96eae41eb62261ad23919059610396eb191aefe50921dbc65631'),
    coverage: 'unsupported',
    waitingFor: 'A comparison of two times in one record counted in calendar days, which no check kind does.',
  },
  {
    id: 'ledger.part107.107.12.b.assigned',
    title: 'Certificate held by the person assigned as remote pilot in command',
    paragraph: certificate,
    coverage: 'unsupported',
    waitingFor:
      'A read of the certificate and training of the person a flight’s role assignment names, a related subject.',
  },
];

function checkedLeaf(documentBytes: Buffer, entry: CheckedEntry): CheckedRuleLeaf {
  return defineCheckedRule({
    ...entry.check,
    id: entry.id,
    version: 1,
    source: quotedSource(documentBytes, entry.paragraph),
  });
}

/** A quoted paragraph the engine does not check: a person reviews it, or no record or check kind covers it yet. */
function retainedLeaf(documentBytes: Buffer, entry: UncheckedEntry): RegulatoryLeaf {
  const content: Omit<RegulatoryLeaf, 'digest'> = {
    id: entry.id,
    version: 1,
    title: entry.title,
    source: quotedSource(documentBytes, entry.paragraph),
    review: 'ai_drafted',
    adopted: false,
    dependencies: [],
    coverage: entry.coverage,
  };
  return { ...content, digest: canonicalDigest(content) };
}

/** Version 1 leaves: the checked rules, then the quoted paragraphs no check serves. */
export function versionOneLeaves(documentBytes: Buffer): RulePackLeaf[] {
  return [
    ...checkedEntries.map((entry) => checkedLeaf(documentBytes, entry)),
    ...uncheckedEntries.map((entry) => retainedLeaf(documentBytes, entry)),
  ];
}

function versionOne(documentBytes: Buffer): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PART107_PACK_ID,
    version: 1,
    title: `Part 107 checks (14 CFR as of ${PART107_EDITION_DATE})`,
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves: versionOneLeaves(documentBytes),
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_ONE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 1 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}

/** Reads the retained document and assembles every pinned version; throws if any pinned byte changed. */
export function part107RulePack() {
  const documentBytes = readRetainedDocument();
  return {
    packId: PART107_PACK_ID,
    versions: [versionOne(documentBytes), versionTwo(documentBytes)],
    sources: [{ ...part107Document, filename: part107Filename, bytes: documentBytes }],
  };
}
