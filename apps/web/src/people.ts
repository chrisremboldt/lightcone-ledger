import {
  OPERATOR_RECORD_SOURCE_ID,
  type Capability,
  type ObservationGrant,
  type PrincipalAuthorityEntry,
} from '@ledger/contracts';

/** Each capability a person can be given, in plain words, grouped as the People screen shows them. */
export const capabilityGroups: { title: string; capabilities: { value: Capability; label: string }[] }[] = [
  {
    title: 'Flights and records',
    capabilities: [
      { value: 'flight:read', label: 'See flights' },
      { value: 'flight:create', label: 'Create flights' },
      { value: 'order:read', label: 'See orders' },
      { value: 'evidence:read', label: 'See evidence and operator records' },
      { value: 'input:write', label: 'Submit reports and records' },
      { value: 'decision:write', label: 'Record decisions' },
      { value: 'correction:write', label: 'Correct evidence' },
      { value: 'identity:write', label: 'Link reports to flights and assign aircraft' },
      { value: 'monitoring:write', label: 'Report monitoring windows' },
    ],
  },
  {
    title: 'Missions',
    capabilities: [
      { value: 'mission:write', label: 'Plan missions' },
      { value: 'mission:release', label: 'Release missions and record departure' },
      { value: 'briefing:write', label: 'Brief crews' },
      { value: 'briefing:ack', label: 'Acknowledge a briefing' },
    ],
  },
  {
    title: 'Rules and safety records',
    capabilities: [
      { value: 'pack:adopt', label: 'Adopt rule packs' },
      { value: 'sms:read', label: 'See safety records' },
      { value: 'sms:write', label: 'Write safety records' },
      { value: 'sms:configure', label: 'Configure safety records' },
      { value: 'sms:adopt', label: 'Sign to adopt a risk matrix and documents' },
      { value: 'sms:report:read', label: 'Read safety reports, including who reported' },
      { value: 'sms:restricted:read', label: 'Read restricted attachments' },
      { value: 'risk:accept:low', label: 'Accept low risk' },
      { value: 'risk:accept:medium', label: 'Accept medium risk' },
      { value: 'risk:accept:high', label: 'Accept high risk' },
    ],
  },
  {
    title: 'Administration',
    capabilities: [{ value: 'authority:write', label: 'Manage people and what they may do' }],
  },
];

export const capabilityLabel = (value: string) =>
  capabilityGroups.flatMap((group) => group.capabilities).find((item) => item.value === value)?.label ?? value;

export const OPERATOR_RECORD_GRANT: ObservationGrant = {
  sourceId: OPERATOR_RECORD_SOURCE_ID,
  observationType: 'operator.record',
};
const isRecordGrant = (grant: ObservationGrant) =>
  grant.sourceId === OPERATOR_RECORD_GRANT.sourceId && grant.observationType === OPERATOR_RECORD_GRANT.observationType;

export function keepsRecords(person: Pick<PrincipalAuthorityEntry, 'observationGrants'>): boolean {
  return Boolean(person.observationGrants?.some(isRecordGrant));
}

/** The person's grants with the operator-record grant set or cleared; every other grant is kept as it is. */
export function withRecordGrant(grants: ObservationGrant[] | undefined, keeps: boolean): ObservationGrant[] {
  const others = (grants ?? []).filter((grant) => !isRecordGrant(grant));
  return keeps ? [...others, OPERATOR_RECORD_GRANT] : others;
}

/** Why the signed-in administrator may not make this change to their own authority, if they may not. */
export function selfChangeRefusal(
  selfId: string | undefined,
  person: Pick<PrincipalAuthorityEntry, 'id'>,
  change: { capabilities: readonly string[]; active: boolean },
): string | null {
  if (person.id !== selfId) return null;
  if (!change.active) return 'You cannot deactivate yourself. Another administrator can.';
  if (!change.capabilities.includes('authority:write'))
    return 'You cannot remove your own authority to manage people. Another administrator can.';
  return null;
}

export const kindLabels: Record<PrincipalAuthorityEntry['kind'], string> = {
  human: 'Person',
  source: 'Source',
  service: 'Service',
  worker: 'Worker',
};
