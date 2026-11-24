import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { expect, test } from 'vitest';
import { FlightOperationSummarySchema } from '../../packages/contracts/src/operation.js';
import { FlightQuerySchema, OrderQuerySchema } from '../../packages/contracts/src/history.js';
import {
  currentOperation,
  overdueOperation,
  pendingOperation,
  historicalIssueOperation,
} from '../../packages/contracts/fixtures/demo/v1/operation.js';

test('scoped operation examples retain plan currentness and report clocks without changing activity', () => {
  const ajv = addFormats(new Ajv({ allErrors: true }));
  const validate = ajv.compile(FlightOperationSummarySchema);
  for (const example of [currentOperation, overdueOperation, pendingOperation, historicalIssueOperation])
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  expect(pendingOperation.window).toBeNull();
  expect(pendingOperation.mission.accepted?.id).not.toBe(pendingOperation.mission.projected?.id);
  expect(overdueOperation.activityReport?.activity).toBe('active');
  expect(historicalIssueOperation.activityReport?.activity).toBe('landed');
  const flights = ajv.compile(FlightQuerySchema);
  for (const view of ['monitor', 'overdue', 'historical-issues', 'history']) expect(flights({ view })).toBe(true);
  const orders = ajv.compile(OrderQuerySchema);
  for (const view of ['awaiting-current', 'awaiting-overdue']) expect(orders({ view })).toBe(true);
});
