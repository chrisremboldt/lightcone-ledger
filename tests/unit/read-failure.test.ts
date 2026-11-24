import { describe, expect, test } from 'vitest';
// The web app resolves its client through the built package, so its errors are that build's ApiError.
import { ApiError } from '../../packages/contracts/dist/client.js';
import {
  MissionReadFailure,
  decisiveMissionFailure,
  missionRead,
  missionReadOutcome,
  readFailureCause,
  readFailureOutcome,
  readFailureStep,
  settledReads,
  subjectReadOutcome,
  type MissionRead,
} from '../../apps/web/src/read-failure.js';

const failed = (read: MissionRead, status: number) => new MissionReadFailure(read, new ApiError(status, null));

describe('mission review read failures', () => {
  test.each([
    ['flight', 401, 'access_lost'],
    ['flight', 403, 'access_lost'],
    ['flight', 404, 'access_lost'],
    ['mission', 401, 'access_lost'],
    ['mission', 403, 'access_lost'],
    ['mission', 404, 'access_lost'],
    ['preview', 401, 'access_lost'],
    ['preview', 403, 'access_lost'],
    ['preview', 404, 'stale'],
    ['findings', 401, 'access_lost'],
    ['findings', 403, 'access_lost'],
    ['findings', 404, 'stale'],
    ['release', 401, 'access_lost'],
    ['release', 403, 'access_lost'],
    ['release', 404, 'stale'],
    ['control', 401, 'access_lost'],
    ['control', 403, 'access_lost'],
    ['control', 404, 'stale'],
    ['flight', 409, 'interrupted'],
    ['control', 500, 'interrupted'],
    ['findings', 503, 'interrupted'],
  ] as const)('a %s read answering %i means %s', (read, status, outcome) => {
    expect(missionReadOutcome(failed(read, status))).toBe(outcome);
  });

  test('a failure that is not an API answer interrupts updates', () => {
    expect(missionReadOutcome(new MissionReadFailure('flight', new TypeError('Failed to fetch')))).toBe('interrupted');
    expect(missionReadOutcome(new Error('An exact accepted control could not be matched.'))).toBe('interrupted');
  });

  test('an untagged 404 is never taken as lost access', () => {
    expect(missionReadOutcome(new ApiError(404, null))).toBe('stale');
    expect(missionReadOutcome(new ApiError(403, null))).toBe('access_lost');
  });

  test('a tagged read keeps the original failure and its message', async () => {
    const original = new ApiError(404, { error: { message: 'The accepted area control was not found' } });
    const tagged = await missionRead('control', Promise.reject(original)).catch((failure: unknown) => failure);
    expect(tagged).toBeInstanceOf(MissionReadFailure);
    expect((tagged as MissionReadFailure).read).toBe('control');
    expect((tagged as MissionReadFailure).failure).toBe(original);
    await expect(missionRead('flight', Promise.resolve(7))).resolves.toBe(7);
  });

  test('of several failed reads, lost access decides over a stale read, and a stale read over an interruption', () => {
    const lost = failed('flight', 404);
    const stale = failed('preview', 404);
    const interrupted = failed('mission', 500);
    expect(decisiveMissionFailure([stale, interrupted, lost])).toBe(lost);
    expect(decisiveMissionFailure([interrupted, stale])).toBe(stale);
    expect(decisiveMissionFailure([interrupted, failed('flight', 502)])).toBe(interrupted);
  });

  test('settled reads report the decisive failure, not the first to arrive', async () => {
    const lost = failed('flight', 404);
    const stale = failed('preview', 404);
    await expect(
      settledReads([
        Promise.reject(stale),
        new Promise((_, reject) => setTimeout(() => reject(lost), 5)),
        Promise.resolve('mission'),
      ]),
    ).rejects.toBe(lost);
    await expect(settledReads([Promise.resolve(1), Promise.resolve('two')])).resolves.toEqual([1, 'two']);
  });
});

describe('subject and listed reads', () => {
  test('a 404 means lost access only on a read of the subject itself', () => {
    expect(readFailureOutcome(new ApiError(404, null), true)).toBe('access_lost');
    expect(readFailureOutcome(new ApiError(404, null), false)).toBe('stale');
    expect(readFailureOutcome(new ApiError(401, null), false)).toBe('access_lost');
    expect(readFailureOutcome(new ApiError(403, null), false)).toBe('access_lost');
    expect(readFailureOutcome(new ApiError(500, null), true)).toBe('interrupted');
    expect(readFailureOutcome(new Error('offline'), true)).toBe('interrupted');
  });
});

describe('what a screen does after a failed read', () => {
  test.each([
    ['access_lost', true, 'clear'],
    ['access_lost', false, 'clear'],
    ['stale', true, 'read_again'],
    ['stale', false, 'keep'],
    ['interrupted', true, 'keep'],
    ['interrupted', false, 'keep'],
  ] as const)('%s, reading again allowed %s, means %s', (outcome, readAgain, step) => {
    expect(readFailureStep(outcome, readAgain)).toBe(step);
  });

  test('departure progress reads its flight, then the release and controls the progress lists', () => {
    expect(readFailureStep(missionReadOutcome(failed('flight', 404)), true)).toBe('clear');
    expect(readFailureStep(missionReadOutcome(failed('release', 404)), true)).toBe('read_again');
    expect(readFailureStep(missionReadOutcome(failed('control', 404)), true)).toBe('read_again');
    expect(readFailureStep(missionReadOutcome(failed('control', 404)), false)).toBe('keep');
    expect(readFailureStep(missionReadOutcome(failed('control', 403)), true)).toBe('clear');
    expect(readFailureStep(missionReadOutcome(failed('release', 502)), true)).toBe('keep');
    expect(readFailureStep(missionReadOutcome(new Error('The departure progress could not be matched.')), true)).toBe(
      'keep',
    );
  });
});

describe('screens about one record, with the reads that record lists', () => {
  const api = (status: number) => new ApiError(status, null);

  test('an untagged read is of the subject; a tagged read is judged by what it names', () => {
    expect(subjectReadOutcome(api(404))).toBe('access_lost');
    expect(subjectReadOutcome(api(401))).toBe('access_lost');
    expect(subjectReadOutcome(api(403))).toBe('access_lost');
    expect(subjectReadOutcome(api(500))).toBe('interrupted');
    expect(subjectReadOutcome(new Error('The exact release could not be matched.'))).toBe('interrupted');
    expect(subjectReadOutcome(failed('control', 404))).toBe('stale');
    expect(subjectReadOutcome(failed('control', 403))).toBe('access_lost');
    expect(subjectReadOutcome(failed('control', 503))).toBe('interrupted');
  });

  test('the failure shown is the one the tagged read carries', () => {
    const original = api(404);
    expect(readFailureCause(new MissionReadFailure('control', original))).toBe(original);
    expect(readFailureCause(original)).toBe(original);
  });

  // The briefing workspace, the mission record inspection and the hazard map read their record, then its controls.
  test.each([
    ['release', api(404), true, 'clear'],
    ['release', api(403), true, 'clear'],
    ['release', api(502), true, 'keep'],
    ['control', failed('control', 404), true, 'read_again'],
    ['control', failed('control', 404), false, 'keep'],
    ['control', failed('control', 401), true, 'clear'],
    ['control', failed('control', 403), false, 'clear'],
  ] as const)('a failed %s read (%#), reading again allowed %s, means %s', (_read, failure, readAgain, step) => {
    expect(readFailureStep(subjectReadOutcome(failure), readAgain)).toBe(step);
  });

  test('a demo cycle another read listed is read again on a 404 and cleared only on 401 or 403', () => {
    expect(readFailureStep(readFailureOutcome(api(404), false), true)).toBe('read_again');
    expect(readFailureStep(readFailureOutcome(api(404), false), false)).toBe('keep');
    expect(readFailureStep(readFailureOutcome(api(401), false), true)).toBe('clear');
    expect(readFailureStep(readFailureOutcome(api(403), false), true)).toBe('clear');
  });

  test('a session or list read names no record, so its 404 is not lost access', () => {
    expect(readFailureOutcome(api(404), false)).not.toBe('access_lost');
    expect(readFailureOutcome(api(401), false)).toBe('access_lost');
    expect(readFailureOutcome(api(403), false)).toBe('access_lost');
  });
});
