import { randomUUID } from 'node:crypto';
import {
  capabilityValues,
  operatorRecordObservationGrant,
  rolePresets,
  type AuthorityPrincipal,
  type Capability,
  type Command,
  type CurrentPrincipalResponse,
  type ObservationGrant,
  type SignInConfiguration,
} from '@ledger/contracts';
import { RefusalError, UsageError, type Context, type Output } from './commands.js';
import { isPerson, personSendsIt, refuseUnlessPerson } from './persons-decision.js';

/**
 * Changing what someone may do and issuing a person a development token, from the command line. Both grant authority,
 * so each prints what it would send and sends it only with a person's credential and their reason, as people add does.
 */

const kindWords: Record<string, string> = { human: 'person', source: 'source', service: 'service', worker: 'worker' };

/** Someone in the organization, by their Ledger id or their full name as people list shows it. */
async function principalNamed(context: Context, named: string | undefined): Promise<AuthorityPrincipal> {
  const wanted = named?.trim();
  if (!wanted)
    throw new UsageError('Give the person: their Ledger id or their full name, as pnpm ledger people list shows.');
  const { principals } = await context.client.principalAuthorities();
  const byId = principals.find((principal) => principal.id === wanted);
  const byName = principals.filter((principal) => principal.name.trim().toLowerCase() === wanted.toLowerCase());
  if (!byId && byName.length > 1)
    throw new UsageError(
      `${byName.length} people are named ${wanted}: ${byName.map((principal) => principal.id).join(', ')}. Give the Ledger id of the one you mean.`,
    );
  const found = byId ?? byName[0];
  if (!found) throw new RefusalError(`No one here is named ${wanted}. pnpm ledger people list shows each person.`);
  // The list is a summary; the principal's own read has its current revision and every grant.
  return (await context.client.principalAuthority(found.id)).principal;
}

const grantWords = (grants: readonly ObservationGrant[]) =>
  grants.length ? grants.map((grant) => `${grant.observationType} under ${grant.sourceId}`).join('; ') : 'nothing';
const capabilityWords = (capabilities: readonly string[]) =>
  capabilities.length ? capabilities.join(', ') : 'nothing';
const sameGrant = (a: ObservationGrant) => (b: ObservationGrant) =>
  a.sourceId === b.sourceId && a.observationType === b.observationType;

function grantOf(text: string, flag: string): ObservationGrant {
  const split = text.indexOf(':');
  if (split < 1 || split === text.length - 1)
    throw new UsageError(`${flag} is <source id>:<observation type>, for example operator-records:operator.record`);
  return { sourceId: text.slice(0, split), observationType: text.slice(split + 1) };
}

function capabilityOf(text: string): Capability {
  if (!(capabilityValues as readonly string[]).includes(text))
    throw new UsageError(`${text} is not a capability. Capabilities: ${capabilityValues.join(', ')}.`);
  return text as Capability;
}

export interface PersonSetRequest {
  person?: string;
  preset?: string;
  capabilities: string[];
  removeCapabilities: string[];
  grants: string[];
  removeGrants: string[];
  reason?: string;
}

/** What someone may do after the change: what they hold, with a preset's and the named additions, less the removals. */
export function changedAuthority(
  current: { capabilities: readonly string[]; observationGrants?: readonly ObservationGrant[] },
  request: PersonSetRequest,
): { capabilities: Capability[]; observationGrants: ObservationGrant[] } {
  const preset = request.preset === undefined ? undefined : rolePresets.find((item) => item.key === request.preset);
  if (request.preset !== undefined && !preset)
    throw new UsageError(
      `${request.preset} is not a preset. Presets: ${rolePresets.map((item) => `${item.key} (${item.title})`).join(', ')}.`,
    );
  if (
    !preset &&
    !request.capabilities.length &&
    !request.removeCapabilities.length &&
    !request.grants.length &&
    !request.removeGrants.length
  )
    throw new UsageError(
      'Say what changes: --preset, --capability or --grant to add, --remove-capability or --remove-grant to take away. pnpm ledger people presets lists what each preset grants.',
    );
  const added = [...(preset?.capabilities ?? []), ...request.capabilities.map(capabilityOf)];
  const removed = new Set(request.removeCapabilities.map(capabilityOf));
  const unheld = [...removed].find((capability) => !current.capabilities.includes(capability));
  if (unheld)
    throw new UsageError(`--remove-capability ${unheld}: they do not hold it, so there is nothing to remove.`);
  const both = added.find((capability) => removed.has(capability));
  if (both) throw new UsageError(`${both} is both added and removed. Give it once.`);
  const capabilities = [...new Set([...(current.capabilities as Capability[]), ...added])].filter(
    (capability) => !removed.has(capability),
  );
  const addedGrants = [
    ...(preset?.keepsRecords ? [{ ...operatorRecordObservationGrant }] : []),
    ...request.grants.map((text) => grantOf(text, '--grant')),
  ];
  const removedGrants = request.removeGrants.map((text) => grantOf(text, '--remove-grant'));
  const unheldGrant = removedGrants.find((grant) => !(current.observationGrants ?? []).some(sameGrant(grant)));
  if (unheldGrant)
    throw new UsageError(
      `--remove-grant ${unheldGrant.sourceId}:${unheldGrant.observationType}: they hold no such grant, so there is nothing to remove.`,
    );
  const observationGrants: ObservationGrant[] = [];
  for (const grant of [...(current.observationGrants ?? []), ...addedGrants])
    if (!observationGrants.some(sameGrant(grant)) && !removedGrants.some(sameGrant(grant)))
      observationGrants.push(grant);
  return { capabilities, observationGrants };
}

/**
 * Changes what someone may do: prints what they may do now and after, and sends it only with a person's credential and
 * their reason, which is kept with the change.
 */
export async function setPerson(context: Context, request: PersonSetRequest): Promise<Output> {
  const target = await principalNamed(context, request.person);
  const after = changedAuthority(target, request);
  const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  const before = target.observationGrants ?? [];
  const adds = after.capabilities.filter((capability) => !target.capabilities.includes(capability));
  const removes = target.capabilities.filter((capability) => !after.capabilities.includes(capability));
  const grantsAdded = after.observationGrants.filter((grant) => !before.some(sameGrant(grant)));
  const grantsRemoved = before.filter((grant) => !after.observationGrants.some(sameGrant(grant)));
  const reason = request.reason?.trim();
  const lines = [
    `${kindWords[target.kind] === 'person' ? 'Person' : 'Principal'}: ${target.name} (${target.id}), ${kindWords[target.kind] ?? target.kind}${target.active ? '' : ', inactive'}`,
    `May now: ${capabilityWords(target.capabilities)}`,
    `Adds: ${capabilityWords(adds)}`,
    `Removes: ${capabilityWords(removes)}`,
    `May after: ${capabilityWords(after.capabilities)}`,
    `May record now: ${grantWords(before)}`,
    ...(grantsAdded.length || grantsRemoved.length
      ? [`May record after: ${grantWords(after.observationGrants)}`]
      : ['May record after: unchanged']),
    `Reason: ${reason ?? 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  ];
  if (!adds.length && !removes.length && !grantsAdded.length && !grantsRemoved.length)
    return {
      data: { sent: false, unchanged: true, principalId: target.id },
      lines: [...lines.slice(0, 2), `Nothing changes: ${target.name} already may do exactly this. Nothing was sent.`],
    };
  const command = {
    kind: 'authority.update',
    principalId: target.id,
    expectedRevision: target.revision,
    capabilities: after.capabilities,
    ...(grantsAdded.length || grantsRemoved.length ? { observationGrants: after.observationGrants } : {}),
    ...(reason ? { note: reason } : {}),
  } as Command;
  const plan = {
    command,
    recordedAs: { id: who.principal.id, name: who.principal.name, kind: who.principal.kind ?? 'human' },
  };
  const decision = "Changing what someone may do grants or removes authority, which is a person's decision";
  refuseUnlessPerson(who, reason, lines, decision, 'An administrator');
  if (!reason)
    return {
      data: { sent: false, ...plan },
      lines: [
        ...lines,
        isPerson(who)
          ? 'Not sent. An administrator changes it by running this again with --reason "<their reason>"; the reason is kept with the change.'
          : personSendsIt(who, decision, 'An administrator'),
      ],
    };
  const sent = await context.client.command(command, randomUUID());
  return {
    data: { sent: true, ...plan, command: sent.command },
    lines: [
      ...lines,
      `Changed. What ${target.name} may do is recorded as changed, with the reason, as ${sent.command.id}.`,
    ],
  };
}

export interface PersonTokenRequest {
  person?: string;
  reason?: string;
}

/**
 * Issues a person a development token on a local Ledger: prints what it would do, and issues it only with a person's
 * credential and their reason. The token is printed once, for the person it is issued to.
 */
export async function issuePersonToken(context: Context, request: PersonTokenRequest): Promise<Output> {
  const target = await principalNamed(context, request.person);
  if (target.kind !== 'human')
    throw new UsageError(
      `${target.name} is a ${kindWords[target.kind] ?? target.kind}, not a person. A development token is for a person; a source or service is issued a credential with pnpm credential:issue.`,
    );
  const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  const signIn = await context.client.request<SignInConfiguration>('/v1/sign-in');
  const reason = request.reason?.trim();
  const lines = [
    `Person: ${target.name} (${target.id})${target.active ? '' : ', inactive: reactivate them first'}`,
    'Issues: a development token for them, shown once. It replaces every earlier token of theirs, which stops working at once.',
    `Reason: ${reason ?? 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  ];
  if (!signIn.developmentTokens)
    return {
      data: { sent: false, principalId: target.id, developmentTokens: false },
      lines: [
        ...lines.slice(0, 1),
        `Not sent. This Ledger takes no development tokens: ${target.name} signs in through the identity provider, with the account tied to them on the People screen.`,
      ],
      refused: Boolean(reason),
    };
  const decision = "Issuing a person a token lets anyone holding it act as them, which is a person's decision";
  refuseUnlessPerson(who, reason, lines, decision, 'An administrator');
  if (!reason)
    return {
      data: { sent: false, principalId: target.id },
      lines: [
        ...lines,
        isPerson(who)
          ? 'Not sent. An administrator issues it by running this again with --reason "<their reason>"; the reason is kept with the issue.'
          : personSendsIt(who, decision, 'An administrator'),
      ],
    };
  const issued = await context.client.issueDevelopmentToken(target.id, reason);
  return {
    data: issued,
    lines: [
      ...lines,
      `Issued, as ${issued.commandId}${issued.replacedCredentialIds.length ? `; ${issued.replacedCredentialIds.length === 1 ? 'their earlier token no longer works' : `their ${issued.replacedCredentialIds.length} earlier tokens no longer work`}` : ''}. ${target.name}'s development token, shown only now:`,
      '',
      `  ${issued.developmentToken.token}`,
      '',
      `Give it to ${target.name} alone. They sign in to the web app with it ("Use a development token"), and give it as LEDGER_TOKEN in their own terminal. Never put it in a file of this repository.`,
    ],
  };
}
