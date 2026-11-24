import { ApiError } from '@ledger/contracts/client';

/**
 * What a failed read means for the screen that made it. Lost access hides what the person may no longer see; a stale
 * read names something that changed after another read listed it, so reading again is expected to recover; anything
 * else interrupts updates and keeps the last view.
 */
export type ReadFailureOutcome = 'access_lost' | 'stale' | 'interrupted';

/**
 * A read of the record the screen is about answers 404 when the person can no longer see it: the API does not reveal
 * whether a record exists outside the person's scope. A 404 from a read the screen made because another read listed
 * its target is stale instead.
 */
export function readFailureOutcome(failure: unknown, subjectRead: boolean): ReadFailureOutcome {
  const status = failure instanceof ApiError ? failure.status : null;
  if (status === 401 || status === 403) return 'access_lost';
  if (status === 404) return subjectRead ? 'access_lost' : 'stale';
  return 'interrupted';
}

/** The reads the mission review and its departure progress make, each by what it names. */
export type MissionRead = 'flight' | 'mission' | 'preview' | 'findings' | 'release' | 'control';

/** What a screen does after a failed read: read again at once, clear what it showed, or keep the last view. */
export type ReadFailureStep = 'read_again' | 'clear' | 'keep';

/** A stale read is read once more straight away; if that read fails too, the screen keeps its last view. */
export function readFailureStep(outcome: ReadFailureOutcome, readAgain: boolean): ReadFailureStep {
  if (outcome === 'access_lost') return 'clear';
  return outcome === 'stale' && readAgain ? 'read_again' : 'keep';
}

/** A failed mission review read, with which read it was. */
export class MissionReadFailure extends Error {
  constructor(
    readonly read: MissionRead,
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * The flight and its mission are what the review is about; the preview, findings, release and controls are listed by
 * them.
 */
export function missionReadOutcome(failure: unknown): ReadFailureOutcome {
  if (!(failure instanceof MissionReadFailure)) return readFailureOutcome(failure, false);
  return readFailureOutcome(failure.failure, failure.read === 'flight' || failure.read === 'mission');
}

/**
 * For a screen about one record (a release, a briefing, a flight's map context) that tags only the reads its own
 * reads listed: a tagged read is judged by what it names, and any other failure was a read of the subject.
 */
export function subjectReadOutcome(failure: unknown): ReadFailureOutcome {
  if (failure instanceof MissionReadFailure) return missionReadOutcome(failure);
  return readFailureOutcome(failure, true);
}

/** The failure a tagged read carries, or the failure itself when it was not tagged. */
export function readFailureCause(failure: unknown): unknown {
  return failure instanceof MissionReadFailure ? failure.failure : failure;
}

/** Tags a mission review read so a failure says which read it was. */
export function missionRead<T>(read: MissionRead, pending: Promise<T>): Promise<T> {
  return pending.catch((failure: unknown) => {
    throw new MissionReadFailure(read, failure);
  });
}

/** Of several failed reads, the one whose outcome matters most: lost access, then a stale read, then the first. */
export function decisiveMissionFailure(failures: readonly unknown[]): unknown {
  const order: ReadFailureOutcome[] = ['access_lost', 'stale'];
  for (const outcome of order) {
    const found = failures.find((failure) => missionReadOutcome(failure) === outcome);
    if (found !== undefined) return found;
  }
  return failures[0];
}

/** Waits for every read, so a lost flight is not reported as a stale preview that happened to fail first. */
export async function settledReads<T extends readonly unknown[] | []>(
  reads: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(reads);
  const failures = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
  if (failures.length) throw decisiveMissionFailure(failures);
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}
