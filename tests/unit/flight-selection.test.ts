import { expect, test } from 'vitest';
import type { FlightSummary } from '@ledger/contracts';
import { retainFlight } from '../../apps/web/src/flightSelection.js';

const captured: FlightSummary = {
  id: 'reviewed-flight',
  label: 'Reviewed mission',
  originationKey: 'reviewed-mission',
  revision: 1,
  basisRevision: 1,
  activity: 'planned',
  coverage: 'partial',
  orderIds: [],
  sourceIds: [],
  unresolvedCount: 0,
  conflictCount: 0,
  outstandingWork: 0,
};

test('retains the captured mission flight when it leaves the roster without selecting another flight', () => {
  const other = { ...captured, id: 'another-flight', revision: 20 };
  expect(retainFlight(captured, [other])).toBe(captured);
  const landed = { ...captured, activity: 'landed' as const, revision: 2 };
  expect(retainFlight(captured, [other, landed])).toBe(landed);
});
