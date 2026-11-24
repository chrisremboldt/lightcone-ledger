import { describe, expect, it } from 'vitest';
import { isOperatorRecordDefinition, RECORDKEEPING_PLAN_DOCUMENT_TYPE } from '@ledger/contracts';
import { observationRegistry } from '../../domain/src/observation-registry.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';

// The records proposed § 108.40 says an operator keeps, declared as data on version 3 (docs/design/required-records.md).

const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
const recordTypes = new Set(
  Object.values(observationRegistry().recordTypes)
    .filter(isOperatorRecordDefinition)
    .map((definition) => definition.recordType),
);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('Part 108 NPRM version 3: the records § 108.40 lists', () => {
  it('declares (a) to (e), each with the timeframe paragraph (f) states for it, in the notice’s own words', () => {
    expect(
      pack.requiredRecords!.map((record) => [record.id, record.source.reference, record.retention?.source.reference]),
    ).toEqual([
      ['part108-nprm.records.aircraft-time-in-service', 'Proposed 14 CFR 108.40(a)(1)', 'Proposed 14 CFR 108.40(f)(1)'],
      ['part108-nprm.records.life-limited-parts', 'Proposed 14 CFR 108.40(a)(2)', 'Proposed 14 CFR 108.40(f)(1)'],
      ['part108-nprm.records.flights', 'Proposed 14 CFR 108.40(a)(3)', 'Proposed 14 CFR 108.40(f)(1)'],
      ['part108-nprm.records.personnel', 'Proposed 14 CFR 108.40(b)(1)-(3)', 'Proposed 14 CFR 108.40(f)(2)'],
      ['part108-nprm.records.release-for-cause', 'Proposed 14 CFR 108.40(b)(4)', 'Proposed 14 CFR 108.40(f)(2)'],
      ['part108-nprm.records.duty-and-rest', 'Proposed 14 CFR 108.40(b)(5)', 'Proposed 14 CFR 108.40(f)(2)'],
      ['part108-nprm.records.mechanical-irregularities', 'Proposed 14 CFR 108.40(c)', 'Proposed 14 CFR 108.40(f)(3)'],
      ['part108-nprm.records.maintenance', 'Proposed 14 CFR 108.40(d)', 'Proposed 14 CFR 108.40(f)(4)'],
      ['part108-nprm.records.training', 'Proposed 14 CFR 108.40(e)', 'Proposed 14 CFR 108.40(f)(5)'],
    ]);
    const byId = new Map(pack.requiredRecords!.map((record) => [record.id, record]));
    expect(oneLine(byId.get('part108-nprm.records.flights')!.retention!.source.text)).toBe(
      'Data required under paragraph (a)(3) of this section must be maintained for a minimum of 24 months.',
    );
    expect(oneLine(byId.get('part108-nprm.records.duty-and-rest')!.retention!.source.text)).toBe(
      'Records required under paragraph (b)(5) of this section must be maintained for three (3) months.',
    );
    expect(oneLine(byId.get('part108-nprm.records.flights')!.source.text)).toMatch(
      /^\(3\) Records of each flight performed under this part which includes-- \(i\) The time, date, and duration of the flight;.* dispensed\.$/,
    );
    for (const record of pack.requiredRecords!) {
      expect(record.keptBy).toBe('Each operator');
      expect(record.source).toMatchObject({ kind: 'proposed_regulation', textSpan: { unit: 'utf8_byte' } });
      for (const holder of record.heldBy)
        expect(holder.kind === 'operator_record' && recordTypes.has(holder.recordType), JSON.stringify(holder)).toBe(
          true,
        );
    }
  });

  it('lets a recordkeeping plan serve § 108.505(b)(7) by its type', () => {
    expect(pack.purposes!.find((purpose) => purpose.id === 'part108-nprm.recordkeeping-plan')).toMatchObject({
      title: 'Recordkeeping plan',
      documentTypes: [RECORDKEEPING_PLAN_DOCUMENT_TYPE],
    });
  });
});
