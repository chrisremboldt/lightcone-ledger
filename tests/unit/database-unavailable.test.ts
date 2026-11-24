import { describe, expect, it } from 'vitest';
import {
  databaseRetryDelay,
  isDatabaseUnavailable,
  untilDatabaseReachable,
} from '../../packages/persistence/src/index.js';

const withCode = (code: string, message = 'database error') => Object.assign(new Error(message), { code });

describe('A database that cannot be reached', () => {
  it('is told apart from a statement the database refused', () => {
    for (const error of [
      withCode('57P01', 'terminating connection due to administrator command'),
      withCode('57P03', 'the database system is starting up'),
      withCode('08006'),
      withCode('53300', 'too many connections for database'),
      withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'),
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
      new Error('Client has encountered a connection error and is not queryable'),
      new AggregateError([withCode('ECONNREFUSED')], ''),
    ])
      expect(isDatabaseUnavailable(error), error.message).toBe(true);
    for (const error of [
      withCode('23505', 'duplicate key value violates unique constraint'),
      withCode('40001', 'could not serialize access'),
      withCode('42501', 'permission denied'),
      new Error('Principal no longer has access'),
      'Connection terminated',
      undefined,
    ])
      expect(isDatabaseUnavailable(error)).toBe(false);
  });

  it('is waited for with a growing delay of at most five seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(databaseRetryDelay)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it('is retried until it answers, while any other error is thrown at once', async () => {
    let calls = 0;
    const waits: number[] = [];
    const value = await untilDatabaseReachable(
      async () => {
        if (++calls < 3) throw withCode('ECONNREFUSED');
        return 'ready';
      },
      (_error, delayMs) => waits.push(delayMs),
    );
    expect(value).toBe('ready');
    expect(waits).toEqual([250, 500]);
    await expect(
      untilDatabaseReachable(async () => {
        throw withCode('42501', 'permission denied');
      }),
    ).rejects.toThrow('permission denied');
  });
});
