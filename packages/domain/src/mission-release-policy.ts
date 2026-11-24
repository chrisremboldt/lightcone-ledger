import type { MissionReleasePolicy } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

const avoidance = {
  status: 'draft',
  scope: 'recorded_route_avoidance',
  clock: 'wall',
  mission: 'exact_accepted_and_projected_revision',
  aircraft: 'exact_current_assignment',
  avoidance: 'applicable_outside_complete_current',
  applicability: 'considered_controls_recorded',
  window: 'finite_half_open_subset_of_mission',
  comparison: 'mission_aircraft_policy_and_safety_context',
  validity: 'as_of_read_only',
  departure: 'separate_authorization_after_allocation',
} as const;
const avoidanceInstruction =
  'At acceptance, record route-avoidance release for the exact assigned aircraft and accepted and projected mission revision using the complete outside and current avoidance context. Every accepted area control overlapping the mission interval is considered and evaluated by the applicability rule its type declares; only the controls that apply must be outside, and each that does not is recorded with what was measured, the rule that decided it and its inputs by digest. The departure window lies within the mission interval. Current validity is as-of information; final authorization after allocation issues a separate finite lease. This release alone does not permit entering flight.';

const definition = Object.freeze({
  id: 'ledger.demo.route-avoidance-release',
  version: 2,
  title: 'Recorded route avoidance release with open findings and control applicability',
  ...avoidance,
  findings: 'open_active_findings_listed_and_attested',
  instruction: `${avoidanceInstruction} The release also lists the open findings from rules adopted in active mode about the flight, its organization and the subjects its records name, each with its rule, current answer and pinned evaluation, and pins that list by digest. The person releasing attests having seen them; a listed finding is not a verdict and blocks nothing. Findings from rules adopted in shadow mode are shown beside the list, recorded and not counted.`,
} as const);

function pinned<Policy extends object>(
  definition: Policy,
  digest: string,
  version: number,
): Policy & { digest: string } {
  if (canonicalDigest(definition) !== digest)
    throw new Error(`Mission release policy version ${version} changed without a new version`);
  return Object.freeze({ ...definition, digest });
}

/** The policy a release is recorded under. */
export const missionReleasePolicy: Readonly<MissionReleasePolicy> = pinned(
  definition,
  '158378d5b0e92e042d9b122ad1c6e7d815104eaa35707c98c4377a9e5fb2e7b1',
  2,
);

/** The registered policy of a version, or undefined for a version this build does not know. */
export function registeredMissionReleasePolicy(version: unknown): Readonly<MissionReleasePolicy> | undefined {
  return version === missionReleasePolicy.version ? missionReleasePolicy : undefined;
}

/** Whether a policy object is exactly the registered policy of its version. */
export function isRegisteredMissionReleasePolicy(policy: unknown): boolean {
  const known = registeredMissionReleasePolicy((policy as { version?: unknown } | null)?.version);
  return known !== undefined && canonicalDigest(policy) === canonicalDigest(known);
}
