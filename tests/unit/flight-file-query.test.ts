import Ajv from 'ajv';
import { describe, expect, test } from 'vitest';
import { SubjectRecordQuerySchema } from '../../packages/contracts/src/index.js';
import { flightFileQuery } from '../../apps/web/src/ReportsArea.js';

describe('one flight’s file', () => {
  test('asks the API only what its query schema accepts', () => {
    const valid = new Ajv({ strict: false }).compile(SubjectRecordQuerySchema);
    for (const query of [
      flightFileQuery({ scope: 'source', kind: 'flight', id: 'ridge-flight-0042', sourceId: 'operator-records' }),
      flightFileQuery({ scope: 'ledger', kind: 'flight', id: '6f1c0e1a-2b7d-4a52-9d55-0c2f7d1e9a10' }),
    ])
      expect(valid(query), JSON.stringify(valid.errors)).toBe(true);
  });

  test('asks about the subject the id resolved to: Ledger’s own flight without a source, the operator’s with one', () => {
    expect(flightFileQuery({ scope: 'ledger', kind: 'flight', id: 'f-1' })).toEqual({
      subjectKind: 'flight',
      subjectId: 'f-1',
      limit: expect.any(Number),
    });
    expect(
      flightFileQuery({ scope: 'source', kind: 'flight', id: 'ridge-flight-0042', sourceId: 'operator-records' }),
    ).toMatchObject({ subjectScope: 'source', sourceId: 'operator-records', subjectId: 'ridge-flight-0042' });
  });
});
