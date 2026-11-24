import type { RulePackRequiredRecord } from '@ledger/contracts';
import { quotedSource, type QuotedParagraph } from './retained-document.js';

// The records proposed § 108.40 says an operator keeps, each with the timeframe its paragraph (f) states
// (docs/design/required-records.md). The words are the notice's own, pinned by their bytes; nothing here counts months.

const paragraph = (reference: string, start: number, end: number, sha256: string): QuotedParagraph => ({
  reference: `Proposed 14 CFR ${reference}`,
  start,
  end,
  sha256,
});

interface RequiredRecordEntry {
  id: string;
  title: string;
  paragraph: QuotedParagraph;
  /** The record types that hold it. */
  recordTypes: string[];
  retention: QuotedParagraph;
}

const KEPT_BY = 'Each operator';

const lifeOfAircraft = paragraph(
  '108.40(f)(1)',
  1211815,
  1211939,
  'be999f7143ad49bc23dd8174fef6804b065ea5f731db85d35c18173e65740267',
);

const entries: readonly RequiredRecordEntry[] = [
  {
    id: 'part108-nprm.records.aircraft-time-in-service',
    title: 'Total time in service of each aircraft',
    paragraph: paragraph(
      '108.40(a)(1)',
      1206356,
      1206412,
      'b34e53af7bcd738ddc0664617db2b8e0e1b223a9a0e8683c2c18f957b17d3df3',
    ),
    recordTypes: ['aircraft.time-in-service', 'flight.record'],
    retention: lifeOfAircraft,
  },
  {
    id: 'part108-nprm.records.life-limited-parts',
    title: 'Status of life-limited parts',
    paragraph: paragraph(
      '108.40(a)(2)',
      1206417,
      1206458,
      '234f1f61e65315955f87f3cfebc8fc603f07654aec4b5b502f5b4fc1b3f78b62',
    ),
    recordTypes: ['component.life-limit'],
    retention: lifeOfAircraft,
  },
  {
    id: 'part108-nprm.records.flights',
    title: 'Record of each flight',
    paragraph: paragraph(
      '108.40(a)(3)',
      1206463,
      1207268,
      'bb8e06b614e9b8acf897e31b6650d1b02f9151607f92e37cef4212bc75b9605e',
    ),
    recordTypes: ['flight.record', 'flight.plan', 'operation.role-assignment'],
    retention: paragraph(
      '108.40(f)(1)',
      1211940,
      1212040,
      '2f62d01b3bc95f08140e44d7f223801ae60c37396c4419b32ea29bd628c1b7e5',
    ),
  },
  {
    id: 'part108-nprm.records.personnel',
    title: 'Personnel: name, qualifications and current duties',
    paragraph: paragraph(
      '108.40(b)(1)-(3)',
      1207273,
      1207710,
      '3c119f6fbe38907e5214efba6866d390e6a7f32f1519d6692424b15557ec4e56',
    ),
    recordTypes: ['person.standing', 'person.certificate'],
    retention: paragraph(
      '108.40(f)(2)',
      1212060,
      1212230,
      '62b8bc0be1f372e9740c3435f43a842cf30dc90b0f264eaa9860a0b8063ad82a',
    ),
  },
  {
    id: 'part108-nprm.records.release-for-cause',
    title: 'Release from employment for cause',
    paragraph: paragraph(
      '108.40(b)(4)',
      1207715,
      1207802,
      'f553a7b110ba711802332208d51673ff87c8c603c57c932de6299bbddd8a8501',
    ),
    recordTypes: ['person.employment'],
    retention: paragraph(
      '108.40(f)(2)',
      1212231,
      1212375,
      '51fa435e30b9ed1b659ea4945ae34e8b55f97da7ae72285506ba08d82ab1b0ba',
    ),
  },
  {
    id: 'part108-nprm.records.duty-and-rest',
    title: 'Work shifts, rest before duty and daily duty hours',
    paragraph: paragraph(
      '108.40(b)(5)',
      1207807,
      1208182,
      '08860dedfde5573d7b97b27baf326a2e63cc821e8cc2604e1284110babbc107d',
    ),
    recordTypes: ['crew.duty-period', 'person.rest-assessment'],
    retention: paragraph(
      '108.40(f)(2)',
      1212376,
      1212474,
      '0fafedfe33b3bf667aa386ed9192a8533b183888d28d6328362afa01e2286d68',
    ),
  },
  {
    id: 'part108-nprm.records.mechanical-irregularities',
    title: 'Log of mechanical irregularities and the action taken',
    paragraph: paragraph(
      '108.40(c)',
      1208187,
      1208369,
      '67dbf6883541a435637c38a51ceadf3ed6aaa4a78c37d5cd12bc24f12e837411',
    ),
    recordTypes: ['occurrence.mechanical-irregularity'],
    retention: paragraph(
      '108.40(f)(3)',
      1212510,
      1212610,
      'e6b11fd3ce31b9656be4e31699687b233dbb2856595e8a749aedcca3fbc19486',
    ),
  },
  {
    id: 'part108-nprm.records.maintenance',
    title: 'Inspection status and each maintenance or alteration',
    paragraph: paragraph(
      '108.40(d)',
      1208827,
      1209043,
      'a3866a982349eb0ee5f23452852100dc8999cf8056f8f1f8e2afb4020fd6405a',
    ),
    recordTypes: ['aircraft.inspection', 'maintenance.action'],
    retention: paragraph(
      '108.40(f)(4)',
      1212632,
      1212732,
      '10eb1e3575ccaad701e4fb5befa33f637458631f93ea8c460ddace2e6ec42828',
    ),
  },
  {
    id: 'part108-nprm.records.training',
    title: 'Initial and recurrent training',
    paragraph: paragraph(
      '108.40(e)',
      1210366,
      1210523,
      'f8a6ddb770ea4601bc5f9c4c7652003011200b532761c9636c9553a9f9535085',
    ),
    recordTypes: ['person.training'],
    retention: paragraph(
      '108.40(f)(5)',
      1212751,
      1212905,
      'b32ea2af5c21d1cec9a316abb9c1d57e69fce0576683ccf578361cea8812bfda',
    ),
  },
];

/** The records version 3 says are kept, each quoting what § 108.40 lists and the timeframe its paragraph (f) states. */
export function requiredRecords(documentBytes: Buffer): RulePackRequiredRecord[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    source: quotedSource(documentBytes, entry.paragraph),
    keptBy: KEPT_BY,
    heldBy: entry.recordTypes.map((recordType) => ({ kind: 'operator_record' as const, recordType })),
    retention: { source: quotedSource(documentBytes, entry.retention) },
  }));
}
