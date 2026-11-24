import { describe, expect, it } from 'vitest';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { PART107_PACK_ID } from '../src/index.js';

// What Part 107 requires to be presented or sent on request (docs/design/required-records.md).

describe('Part 107 version 2: records produced on request', () => {
  it('declares the certificate and the deviation report, quoting their paragraphs, with no period the text does not state', () => {
    const pack = getRulePackVersion(PART107_PACK_ID, 2)!;
    expect(
      pack.requiredRecords!.map((record) => [record.id, record.source.reference, record.heldBy, record.retention]),
    ).toEqual([
      [
        'part107.records.remote-pilot-certificate',
        '14 CFR 107.7(a) (edition of 2026-01-01)',
        [{ kind: 'operator_record', recordType: 'person.certificate' }],
        undefined,
      ],
      [
        'part107.records.emergency-deviation-report',
        '14 CFR 107.21(b) (edition of 2026-01-01)',
        [{ kind: 'operator_record', recordType: 'occurrence.emergency-deviation' }],
        undefined,
      ],
    ]);
    expect(pack.requiredRecords![0]!.source.text).toContain('for inspection upon a request from—');
    expect(pack.requiredRecords![1]!.keptBy).toBe(
      'Each remote pilot in command who deviates from a rule under paragraph (a) of this section',
    );
    // Version 1 is as it was.
    expect(getRulePackVersion(PART107_PACK_ID, 1)!.requiredRecords).toBeUndefined();
  });
});
