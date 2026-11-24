import { describe, expect, test } from 'vitest';
// The web app resolves its client through the built package, so its errors are that build's ApiError.
import { ApiError } from '../../packages/contracts/dist/client.js';
import { coverageReadRetries, readsCoverageAgain } from '../../apps/web/src/coverage-read.js';

describe('coverage read retries', () => {
  test('a 409 is read again', () => {
    expect(readsCoverageAgain(new ApiError(409, null), 1)).toBe(true);
  });

  test('a network interruption is read again', () => {
    expect(readsCoverageAgain(new TypeError('Failed to fetch'), 1)).toBe(true);
  });

  test.each([400, 401, 403, 404, 500, 503])('a %i is not read again', (status) => {
    expect(readsCoverageAgain(new ApiError(status, null), 1)).toBe(false);
  });

  test('reads again at most five times in a row, then stops', () => {
    expect(coverageReadRetries).toBe(5);
    const conflict = new ApiError(409, null);
    const decisions = [1, 2, 3, 4, 5, 6, 7].map((failedInARow) => readsCoverageAgain(conflict, failedInARow));
    expect(decisions).toEqual([true, true, true, true, true, false, false]);
    expect(readsCoverageAgain(new TypeError('Failed to fetch'), 6)).toBe(false);
  });
});
