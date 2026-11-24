import { ApiError } from '@ledger/contracts/client';

/** How long the coverage pane waits before reading again, while work is outstanding or after a failed read. */
export const coverageReadDelayMs = 1000;

/** How many times in a row the coverage pane reads again by itself after failed reads before it asks the person. */
export const coverageReadRetries = 5;

/**
 * Whether the coverage pane reads again by itself after a failed read. A 409 is a change that raced the read, and a
 * failure that is not an API answer is a network interruption; reading again is expected to recover from either.
 * `failedInARow` counts the failed reads since the last one that succeeded, this one included.
 */
export function readsCoverageAgain(failure: unknown, failedInARow: number): boolean {
  if (failedInARow > coverageReadRetries) return false;
  return failure instanceof ApiError ? failure.status === 409 : true;
}
