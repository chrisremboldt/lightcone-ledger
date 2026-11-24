import { describe, expect, it } from 'vitest';
import { listOperatorRecordTypes } from '../../domain/src/operator-record-import.js';
import { ruleReadLines } from '../src/record-rule-read.js';

// The end of `pnpm ledger records columns <type>`: the read a rule writes for the record type and each column's path.

const summary = (recordType: string) => listOperatorRecordTypes().find((type) => type.recordType === recordType)!;

describe('How a rule reads a record type, as records columns prints it', () => {
  it('says a duty or rest period is its own observation type, read with no record type condition', () => {
    const lines = ruleReadLines(summary('crew.duty-period')).join('\n');
    expect(lines).toContain(
      'each is stored as a crew.duty-period observation of its own, not inside operator.record, so a read takes type crew.duty-period with no where on values.recordType',
    );
    expect(lines).toContain('        type: crew.duty-period\n        versions: [1]');
    expect(lines).not.toContain('where:');
    expect(lines).toMatch(/period\s+values\.period/u);
    expect(lines).toMatch(/startsAt\s+interval\.start/u);
    expect(lines).toMatch(/periodId\s+sourceEventId/u);
  });

  it('gives every other record type inside operator.record, selected by its type, fields under values.record', () => {
    const lines = ruleReadLines(summary('flight.plan')).join('\n');
    expect(lines).toContain(
      '        type: operator.record\n        versions: [1]\n        where:\n          - field: values.recordType\n            oneOf: [flight.plan]',
    );
    expect(lines).toMatch(/operatingAuthorityReference\s+values\.record\.operatingAuthorityReference/u);
  });

  it('gives every record type a read', () => {
    for (const type of listOperatorRecordTypes())
      expect(ruleReadLines(type).length, type.recordType).toBeGreaterThan(4);
  });
});
