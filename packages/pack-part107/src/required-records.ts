import type { RulePackRequiredRecord } from '@ledger/contracts';
import { paragraph, quotedSource, type QuotedParagraph } from './retained-document.js';

// What Part 107 requires to be presented or sent on request (docs/design/required-records.md). Part 107 states no
// period for keeping either, so neither carries a retention.

interface RequiredRecordEntry {
  id: string;
  title: string;
  paragraph: QuotedParagraph;
  keptBy: string;
  recordTypes: string[];
}

const entries: readonly RequiredRecordEntry[] = [
  {
    id: 'part107.records.remote-pilot-certificate',
    title: 'Remote pilot certificate and identification, presented on request',
    paragraph: paragraph('107.7(a)', 13480, 14400, 'e48766bb4d351343298d50c30fdce2d7bb135b1e9b7004ba4c7e0312dc2f49d0'),
    keptBy:
      'A remote pilot in command, owner, or person manipulating the flight controls of a small unmanned aircraft system',
    recordTypes: ['person.certificate'],
  },
  {
    id: 'part107.records.emergency-deviation-report',
    title: 'Written report of an emergency deviation, sent on request',
    paragraph: paragraph('107.21(b)', 21806, 22009, '7b4e0e3bf24ee1be6ea57747210b22c3054e83baded2e13a4f6f0b730600afb8'),
    keptBy: 'Each remote pilot in command who deviates from a rule under paragraph (a) of this section',
    recordTypes: ['occurrence.emergency-deviation'],
  },
];

/** The records version 2 says are presented or sent on request, each quoting its paragraph. */
export function requiredRecords(documentBytes: Buffer): RulePackRequiredRecord[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    source: quotedSource(documentBytes, entry.paragraph),
    keptBy: entry.keptBy,
    heldBy: entry.recordTypes.map((recordType) => ({ kind: 'operator_record' as const, recordType })),
  }));
}
