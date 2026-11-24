import type { CheckedRuleLeaf, RulePackLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, withPopulation } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import * as checks from './checks.js';
import { PART108_NPRM_PACK_ID, retainedLeaf, versionOneLeaves, type RegulatoryLeaf } from './part108-nprm-v1.js';
import { quotedSource, type QuotedParagraph } from './retained-document.js';

const VERSION_TWO_DIGEST = '27244ddf8f60502a791a8c8c6144a08cd092e8ffba6915a388c80da27ce7e6e2';

/** A quoted paragraph and the check that serves it. */
interface CheckedEntry {
  id: string;
  paragraph: QuotedParagraph;
  check: checks.SourceNeutralCheck;
}

/** A quoted paragraph no check serves yet, with what it waits for. */
interface UncheckedEntry {
  id: string;
  title: string;
  paragraph: QuotedParagraph;
  coverage: RegulatoryLeaf['coverage'];
  /** Why the engine cannot check it; kept beside the entry, not in the pinned leaf. */
  waitingFor: string;
}

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

export const checkedEntries: readonly CheckedEntry[] = [
  {
    id: 'ledger.nprm.108.40.a.3.iv',
    paragraph: paragraph(
      '108.40(a)(3)(iv)',
      1206671,
      1206772,
      '428c879c80c651f945e75cdacaba93ece8f449a04ef75660445175d4d99e9310',
    ),
    check: withPopulation(checks.flightPathRecorded, checks.flights, { record: 'flight record' }),
  },
  {
    id: 'ledger.nprm.108.40.b.1-3',
    paragraph: paragraph(
      '108.40(b)(1)-(3)',
      1207269,
      1207711,
      'ad4b2efd91d0d0099f3d9ea55872634cf95575eaf7443aabbf27a7470c7f5473',
    ),
    check: withPopulation(checks.personnelFileRecorded, checks.people, { record: 'personnel file' }),
  },
  {
    id: 'ledger.nprm.108.40.b.4',
    paragraph: paragraph(
      '108.40(b)(4)',
      1207711,
      1207803,
      'ab9f656528fb6d018d2ac0fbe7e74f5b5077a4bd789cd6c70384590701d4e6f8',
    ),
    check: withPopulation(checks.separationForCauseRecorded, checks.people),
  },
  {
    id: 'ledger.nprm.108.40.b.5',
    paragraph: paragraph(
      '108.40(b)(5)',
      1207803,
      1208183,
      '0e3b5a316f6fead6f30371fae9435591b6016f95e87adec956cc980b08afd7f3',
    ),
    check: withPopulation(checks.dutyScheduleRecorded, checks.people, { record: 'duty and rest assessment' }),
  },
  {
    id: 'ledger.nprm.108.40.c',
    paragraph: paragraph(
      '108.40(c)',
      1208183,
      1208806,
      'c7f2abf7a98baad1976fcb97add8d01dd26b24fc718ab512a4a59160a636026f',
    ),
    check: withPopulation(checks.irregularityLogEntries, checks.aircraft),
  },
  {
    id: 'ledger.nprm.108.40.d.1',
    paragraph: paragraph(
      '108.40(d)(1)',
      1209044,
      1209524,
      '28b63f20a5ae19272361230019fe01ab157e750bc5d542f185ff934ac1d915a0',
    ),
    check: withPopulation(checks.maintenanceEntries, checks.aircraft),
  },
  {
    id: 'ledger.nprm.108.40.e.1',
    paragraph: paragraph(
      '108.40(e)(1)(iii)-(vi)',
      1210687,
      1211059,
      '88fdf881459a8d80be2873bae01173fd53ae817d183881d841d7dca763c768a2',
    ),
    check: withPopulation(checks.trainingRecordDetails, checks.people, { record: 'training record' }),
  },
  {
    id: 'ledger.nprm.108.120.a',
    paragraph: paragraph(
      '108.120(a)',
      1222322,
      1222658,
      'e6bcccd0f197d6c10159518b54f46735ce658c62752c8ebdcb425a34abcd4a1e',
    ),
    check: withPopulation(checks.noKnownUnsafeCondition, checks.aircraft, { subject: 'aircraft condition record' }),
  },
  {
    id: 'ledger.nprm.108.170.a',
    paragraph: paragraph(
      '108.170(a)',
      1229949,
      1230182,
      '99c4e73ed15827554b4ce653fb0937705cbde6c2c1ea4e8ba0b9511f53ea9e4f',
    ),
    check: withPopulation(checks.weatherDetermination, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.nprm.108.170.b',
    paragraph: paragraph(
      '108.170(b)',
      1230182,
      1230279,
      'f53fd250d9ca18f7766580dc0ff96a5ca27fc005207188eb14930ead5b2001e5',
    ),
    check: withPopulation(checks.airspaceDetermination, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.nprm.108.170.d',
    paragraph: paragraph(
      '108.170(d)',
      1230363,
      1230427,
      '776386e3554ab37d781d657909ca1e0e6072c31c74262062412366f4936c4c2e',
    ),
    check: withPopulation(checks.groundHazardDetermination, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.nprm.108.170.h',
    paragraph: paragraph(
      '108.170(h)',
      1230761,
      1231178,
      '9a8d453d925b5a15072dbe3aabf1a3d31972c67003cb28ef637563d3aebb7907',
    ),
    check: withPopulation(checks.energyDetermination, checks.flights, { record: 'preflight assessment' }),
  },
  {
    id: 'ledger.nprm.108.210.b',
    paragraph: paragraph(
      '108.210(b)',
      1244721,
      1245183,
      '4c7fdde86c4365dd5078f96163127f6ac7e3dbf36af7e9f5204b3b91183de5e2',
    ),
    check: withPopulation(checks.aircraftWithinMethodLimit, checks.multipleAircraftFlights),
  },
  {
    id: 'ledger.nprm.108.210.c',
    paragraph: paragraph(
      '108.210(c)',
      1245183,
      1245418,
      '8c490692f9b9c2e40f95f2b871cbf6adc23749c3be3e123d6cfefd6d30a8bbf8',
    ),
    check: withPopulation(checks.aircraftWithinManufacturerLimit, checks.multipleAircraftFlights),
  },
  {
    id: 'ledger.nprm.108.305.a',
    paragraph: paragraph(
      '108.305(a)',
      1247143,
      1247306,
      '10a51bff8836ee3063b5b3d012e18600625fe49366bb8d513bb9bae030595b74',
    ),
    check: withPopulation(checks.operationsSupervisorInRole, checks.organization, {
      interval: 'operations supervisor role assignment',
    }),
  },
  {
    id: 'ledger.nprm.108.310.a',
    paragraph: paragraph(
      '108.310(a)',
      1247937,
      1248093,
      'e131ff51597eba0ae6f0d840389e9526cb36b23e6190430ce50e911b2e92d661',
    ),
    check: withPopulation(checks.coordinatorDesignated, checks.flights),
  },
  {
    id: 'ledger.nprm.108.310.c',
    paragraph: paragraph(
      '108.310(c)',
      1248386,
      1248587,
      'a0ee31d1a3b3b829c5ccc1ab7358b764bdad7997006aafe8ce5aeb9ddd540c87',
    ),
    check: withPopulation(checks.coordinatorHandover, checks.flights),
  },
  {
    id: 'ledger.nprm.108.330.a.duty-period',
    paragraph: paragraph(
      '108.330(a)',
      1255504,
      1255613,
      'b1e65519e9f43e6f51edb73401845e85e4a9a712e045f17c440965b9b374c563',
    ),
    check: withPopulation(checks.dutyPeriodLength, checks.people, { periods: 'duty or rest period' }),
  },
  {
    id: 'ledger.nprm.108.330.a.duty-week',
    paragraph: paragraph(
      '108.330(a)',
      1255504,
      1255613,
      'b1e65519e9f43e6f51edb73401845e85e4a9a712e045f17c440965b9b374c563',
    ),
    check: withPopulation(checks.dutyWeekTotal, checks.people, { quantity: 'duty and rest assessment' }),
  },
  {
    id: 'ledger.nprm.108.330.b',
    paragraph: paragraph(
      '108.330(b)',
      1255613,
      1255743,
      '4a8a4f0429c2ec7917fe6f9d7a164feaa448029b5f40c554040d1f2f194b88e9',
    ),
    check: withPopulation(checks.restBeforeDuty, checks.people, { periods: 'duty or rest period' }),
  },
  {
    id: 'ledger.nprm.108.630.a',
    paragraph: paragraph(
      '108.630(a)',
      1312726,
      1313057,
      '512230f5647eecfece902772d0c124d3afb0c09a727f70df1f07815d1a363ede',
    ),
    check: withPopulation(checks.returnedToService, checks.aircraft),
  },
];

export const uncheckedEntries: readonly UncheckedEntry[] = [
  {
    id: 'ledger.nprm.108.40.a.1',
    title: 'Aircraft total time in service',
    paragraph: paragraph(
      '108.40(a)(1)',
      1206215,
      1206413,
      '46a9ced49d6198ada8dda02cf6de6b05184c81a7d23eaa72b21cca3299d213ca',
    ),
    coverage: 'unsupported',
    waitingFor: 'A derived total: an opening balance plus later flight time from many observations.',
  },
  {
    id: 'ledger.nprm.108.615.a',
    title: 'Life-limited parts within their limits',
    paragraph: paragraph(
      '108.615(a)',
      1310448,
      1310615,
      'fc0e7142f77fa09903e2fed08fd358f8bba77d4db0cc0763d0a17d4c7a0fbb1a',
    ),
    coverage: 'unsupported',
    waitingFor:
      'One result per installed component and a read of the aircraft it is installed on, and the aircraft time derived from many observations.',
  },
  {
    id: 'ledger.nprm.108.310.e',
    title: 'Flight coordinator experience in the make and model',
    paragraph: paragraph(
      '108.310(e)',
      1248977,
      1249502,
      '35aaf56e74f6bb3376680751d523932e30f41fa7a0518d51649b7a2655f858a8',
    ),
    coverage: 'unsupported',
    waitingFor:
      "A read of the aircraft to be operated and a comparison of its make and model with the person's experience record.",
  },
  {
    id: 'ledger.nprm.108.330.c',
    title: 'One day of continuous rest each scheduled week',
    paragraph: paragraph(
      '108.330(c)',
      1255743,
      1255967,
      'b6f2a6dbfa768bff2c21ead9e961e68228dcfe04cd50c0a6b57e6eed8fb98db1',
    ),
    coverage: 'unsupported',
    waitingFor: "Weeks counted on the operator's calendar in its local time zone.",
  },
  {
    id: 'ledger.nprm.108.45.f',
    title: 'Report of a deviation in an emergency',
    paragraph: paragraph(
      '108.45(f)',
      1217474,
      1217839,
      '5ad3bf2b854c5fcf8adba2823db30fb7a741ca85980eefd14605973558c055c5',
    ),
    coverage: 'unsupported',
    waitingFor:
      'A comparison of two times in one record counted in days excluding weekends and holidays, which no check kind does.',
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

/** Version 2 leaves: the checked rules, then the quoted paragraphs no check serves yet, then version 1's two. */
export function versionTwoLeaves(documentBytes: Buffer): RulePackLeaf[] {
  return [
    ...checkedEntries.map((entry) => checkedLeaf(documentBytes, entry)),
    ...uncheckedEntries.map((entry) =>
      retainedLeaf(documentBytes, entry.id, entry.title, entry.coverage, entry.paragraph),
    ),
    ...versionOneLeaves(documentBytes),
  ];
}

export function versionTwo(documentBytes: Buffer): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PART108_NPRM_PACK_ID,
    version: 2,
    title: 'Part 108 NPRM checks (shadow only)',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves: versionTwoLeaves(documentBytes),
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_TWO_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 2 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}
