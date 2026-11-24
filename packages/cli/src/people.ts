import { randomUUID } from 'node:crypto';
import {
  capabilityValues,
  operatorRecordObservationGrant,
  rolePresets,
  type Capability,
  type CurrentPrincipalResponse,
  type ObservationGrant,
  type PersonAddCommand,
  type PrincipalAuthorityListResponse,
} from '@ledger/contracts';
import { UsageError, type Context, type Output } from './commands.js';
import { isPerson, personSendsIt, refuseUnlessPerson } from './persons-decision.js';
import { wrappedTable } from './format.js';

export const PEOPLE_WIDTH = 140;

const kindWords: Record<string, string> = { human: 'person', source: 'source', service: 'service' };

/** Everyone in the organization and what each may do, as the People screen lists them. */
export async function listPeople(context: Context): Promise<Output> {
  const read = await context.client.principalAuthorities();
  const grants = (person: PrincipalAuthorityListResponse['principals'][number]) =>
    (person.observationGrants ?? []).map((grant) => `${grant.observationType} under ${grant.sourceId}`).join('; ');
  return {
    data: read,
    lines: [
      ...wrappedTable(
        ['Name', 'Id', 'Kind', 'Status', 'Sign-in account', 'May', 'May record'],
        read.principals.map((person) => [
          person.name,
          person.id,
          kindWords[person.kind] ?? person.kind,
          person.active ? 'active' : 'inactive',
          person.kind !== 'human' ? '' : person.signInLinked ? 'tied' : 'none tied',
          person.capabilities.length ? person.capabilities.join(', ') : 'nothing',
          grants(person),
        ]),
        PEOPLE_WIDTH,
        { 5: 3, 6: 1 },
      ),
      ...(read.hasMore ? [`Only the first ${read.principals.length} are listed.`] : []),
    ],
  };
}

export interface PersonAddRequest {
  name?: string;
  preset?: string;
  capabilities: string[];
  /** `<source id>:<observation type>`. */
  grants: string[];
  signInSubject?: string;
  signInIssuer?: string;
  /** The person's own reason. Without it nothing is sent. */
  reason?: string;
}

function presetWords(): string {
  return rolePresets.map((preset) => `${preset.key} (${preset.title})`).join(', ');
}

/** The capabilities and grants a request asks for: a preset's, then any given one by one. */
export function chosenAuthority(request: PersonAddRequest): {
  preset?: (typeof rolePresets)[number];
  capabilities: Capability[];
  observationGrants: ObservationGrant[];
} {
  const preset = request.preset === undefined ? undefined : rolePresets.find((item) => item.key === request.preset);
  if (request.preset !== undefined && !preset)
    throw new UsageError(`${request.preset} is not a preset. Presets: ${presetWords()}.`);
  if (!preset && !request.capabilities.length)
    throw new UsageError(
      `Give a preset with --preset, capabilities with --capability, or both. Presets: ${presetWords()}. pnpm ledger people presets lists what each grants.`,
    );
  const unknown = request.capabilities.find((value) => !(capabilityValues as readonly string[]).includes(value));
  if (unknown) throw new UsageError(`${unknown} is not a capability. Capabilities: ${capabilityValues.join(', ')}.`);
  const capabilities = [...new Set([...(preset?.capabilities ?? []), ...(request.capabilities as Capability[])])];
  const observationGrants: ObservationGrant[] = preset?.keepsRecords ? [{ ...operatorRecordObservationGrant }] : [];
  for (const text of request.grants) {
    const split = text.indexOf(':');
    if (split < 1 || split === text.length - 1)
      throw new UsageError(`--grant is <source id>:<observation type>, for example operator-records:operator.record`);
    const grant = { sourceId: text.slice(0, split), observationType: text.slice(split + 1) };
    if (
      !observationGrants.some(
        (item) => item.sourceId === grant.sourceId && item.observationType === grant.observationType,
      )
    )
      observationGrants.push(grant);
  }
  return { ...(preset ? { preset } : {}), capabilities, observationGrants };
}

/** Each preset and exactly what it grants. */
export function listPresets(): Output {
  return {
    data: { presets: rolePresets },
    lines: wrappedTable(
      ['Preset', 'Title', 'May', 'May record'],
      rolePresets.map((preset) => [
        preset.key,
        preset.title,
        preset.capabilities.length ? preset.capabilities.join(', ') : 'nothing',
        preset.keepsRecords ? 'operator.record under operator-records' : '',
      ]),
      PEOPLE_WIDTH,
      { 2: 1 },
    ),
  };
}

/**
 * Adding a person grants authority: says everything the addition would record and who it would be recorded as, and
 * sends it only with a person's credential and their own reason.
 */
export async function addPerson(context: Context, request: PersonAddRequest): Promise<Output> {
  const name = request.name?.trim();
  if (!name) throw new UsageError('--name is required: the person’s full name.');
  if (name.length > 200) throw new UsageError('--name has at most 200 characters.');
  if (request.signInIssuer !== undefined && !request.signInSubject)
    throw new UsageError('--sign-in-issuer goes with --sign-in-subject.');
  const chosen = chosenAuthority(request);
  const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  const subject = request.signInSubject?.trim();
  const issuer = request.signInIssuer?.trim();
  const lines = [
    `Person: ${name}`,
    `Preset: ${chosen.preset ? `${chosen.preset.title} (${chosen.preset.key})` : 'none; the capabilities are given one by one'}`,
    `May: ${chosen.capabilities.length ? chosen.capabilities.join(', ') : 'nothing yet'}`,
    `May record: ${chosen.observationGrants.length ? chosen.observationGrants.map((grant) => `${grant.observationType} under ${grant.sourceId}`).join('; ') : 'nothing'}`,
    `Sign-in account: ${subject ? `subject ${subject}${issuer ? ` at ${issuer}` : ', at the identity provider you sign in through'}` : 'none tied. On a local Ledger an administrator issues them a development token on the People screen.'}`,
    `Reason: ${request.reason?.trim() ? request.reason.trim() : 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  ];
  const command: PersonAddCommand = {
    kind: 'person.add',
    name,
    principalKind: 'human',
    capabilities: chosen.capabilities,
    ...(chosen.observationGrants.length ? { observationGrants: chosen.observationGrants } : {}),
    ...(subject ? { signIn: { subject, ...(issuer ? { issuer } : {}) } } : {}),
    ...(request.reason?.trim() ? { note: request.reason.trim() } : {}),
  };
  const plan = {
    command,
    recordedAs: { id: who.principal.id, name: who.principal.name, kind: who.principal.kind ?? 'human' },
  };
  const decision = "Adding a person grants them authority, which is a person's decision";
  const sender = 'An administrator';
  refuseUnlessPerson(who, request.reason, lines, decision, sender);
  if (!request.reason?.trim())
    return {
      data: { sent: false, ...plan },
      lines: [
        ...lines,
        isPerson(who)
          ? 'Not sent. An administrator adds them by running this again with --reason "<their reason>"; the reason is kept with the addition.'
          : personSendsIt(who, decision, sender),
      ],
    };
  const sent = await context.client.command(command, randomUUID());
  const id = String(sent.command.payload.principalId);
  return {
    data: { sent: true, principalId: id, ...plan, command: sent.command },
    lines: [...lines, `Added. ${name} is ${id}. The addition is recorded.`],
  };
}
