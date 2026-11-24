import type { CurrentPrincipalResponse } from '@ledger/contracts';
import { RefusalError } from './commands.js';

/**
 * A person's decision is printed under any credential and sent only with a person's credential and their reason.
 * Printing is success: without --reason a command exits 0 whoever runs it, and says who sends it. Only an attempt to
 * send, with --reason, under a credential that is not a person's is refused.
 */

export function isPerson(who: CurrentPrincipalResponse): boolean {
  return who.principal.kind === undefined || who.principal.kind === 'human';
}

/** What the credential is, when it is not a person's. */
export function credentialKind(who: CurrentPrincipalResponse): string {
  return who.principal.kind === 'service' ? 'a service' : who.principal.kind === 'source' ? 'a source' : 'not a person';
}

/**
 * The closing line of a decision printed under a credential that is not a person's: whose decision it is and who sends
 * it. `decision` is a sentence ending before its full stop ("An adoption is a person's decision"); `sender` names who
 * runs it again ("The person who decides").
 */
export function personSendsIt(who: CurrentPrincipalResponse, decision: string, sender: string): string {
  return `Not sent. ${decision}, and this credential belongs to ${who.principal.name}, ${credentialKind(who)}. ${sender} runs this again with their own credential and --reason "<their reason>".`;
}

/** Refuses an attempt to send a person's decision, with a reason, under a credential that is not a person's. */
export function refuseUnlessPerson(
  who: CurrentPrincipalResponse,
  reason: string | undefined,
  lines: string[],
  decision: string,
  sender: string,
): void {
  if (!isPerson(who) && reason?.trim())
    throw new RefusalError([...lines, personSendsIt(who, decision, sender)].join('\n'));
}
