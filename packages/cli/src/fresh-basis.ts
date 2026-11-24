import { ApiError } from '@ledger/contracts/client';
import type { Context } from './commands.js';

/** How many times a command is sent in all before a concurrent change is reported. */
export const FRESH_BASIS_ATTEMPTS = 6;

/** The wait before the first resend; each later wait is twice the one before, so all of them add up to 15.5 s. */
const FIRST_PAUSE_MS = 500;

/** The wait before attempt `tried + 1`, after `tried` attempts were refused. */
function freshBasisPause(tried: number): number {
  return FIRST_PAUSE_MS * 2 ** (tried - 1);
}

function concurrentChange(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const body = error.body as { error?: { code?: unknown } } | undefined;
  return body?.error?.code === 'concurrent_change';
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Sends a command whose content does not depend on what changed: each attempt reads its basis afresh and builds the
 * command again. When Ledger refuses it as a concurrent change, because work recorded at the same moment touched what
 * it reads (such as the queueing that follows an adoption sent just before), it is sent again, waiting longer each
 * time, saying so each time, before the refusal is reported with the words that nothing was recorded.
 */
export async function onFreshBasis<T>(
  context: Context,
  attempt: () => Promise<T>,
): Promise<{ value: T; retried: number }> {
  const pause = context.pause ?? sleep;
  for (let tried = 1; ; tried++) {
    try {
      return { value: await attempt(), retried: tried - 1 };
    } catch (error) {
      if (!concurrentChange(error)) throw error;
      if (tried >= FRESH_BASIS_ATTEMPTS) {
        context.say(
          `Ledger refused this as a concurrent change ${FRESH_BASIS_ATTEMPTS} times: other work was still being recorded. Nothing was recorded by this command, so it is safe to send again as it is, in a minute or so.`,
        );
        throw error;
      }
      const wait = freshBasisPause(tried);
      context.say(
        `Ledger refused this as a concurrent change (409 concurrent_change): other work was being recorded at the same moment. Sending it again on a fresh basis in ${wait / 1000} s (attempt ${tried + 1} of ${FRESH_BASIS_ATTEMPTS}).`,
      );
      await pause(wait);
    }
  }
}
