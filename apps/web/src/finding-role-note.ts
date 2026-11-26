import { readsOnly } from '@ledger/contracts';

/**
 * What a person who cannot take a finding is told about it, true for their role: a person who only reads is not told
 * that they can review it, since a review is recorded and they record nothing.
 */
export function findingRoleNote(
  capabilities: readonly string[] | undefined,
  taker: { who: string; otherwise: string },
): string {
  if (capabilities && readsOnly(capabilities))
    return `You can read this finding and what is on file about it. ${taker.who} takes it, assigns it and closes it.`;
  return `Your role can review this finding. ${taker.otherwise}`;
}
