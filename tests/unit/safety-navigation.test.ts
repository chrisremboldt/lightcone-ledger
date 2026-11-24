import { expect, test } from 'vitest';
import { originFlightId } from '../../apps/web/src/safety-navigation.js';

test('a hazard from a finding about a Ledger flight leads back to that flight, and no other origin does', () => {
  expect(
    originFlightId({
      kind: 'finding',
      findingId: 'finding-1',
      subject: { scope: 'ledger', kind: 'flight', id: 'f-1' },
    }),
  ).toBe('f-1');
  expect(
    originFlightId({
      kind: 'finding',
      findingId: 'finding-2',
      subject: { scope: 'source', kind: 'aircraft', id: 'tail-1', sourceId: 'source-1' },
    }),
  ).toBeUndefined();
  expect(originFlightId({ kind: 'manual' })).toBeUndefined();
  expect(originFlightId(undefined)).toBeUndefined();
});
