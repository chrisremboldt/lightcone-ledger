import type { MissionDeparturePolicy } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

const definition = Object.freeze({
  id: 'ledger.demo.route-avoidance-departure',
  version: 1,
  clock: 'wall',
  permitSeconds: 30,
  authorization: 'finite_lease_at_authorized_at',
  replay: 'same_original_unexpired_lease',
  renewal: 'unsupported',
  uniqueness: 'tenant_flight_and_attempt_and_allocation',
  operationFit: 'producer_checks_before_authorization_and_at_consumption',
  expiry: 'earliest_of_30_seconds_release_end_or_selection_boundary',
  instruction:
    'After retaining one live exclusive reservation and conservatively checking full remaining operation fit, atomically validate the exact release at authorizedAt and issue at most one nonrenewable lease per tenant and Ledger flight. Tenant/allocation identity binds one flight and attempt, not a pad name. The lease ends at the earliest of 30 seconds, release-window end or relevant selection boundary. Later safety changes do not revoke this issued lease. Exact original-key retries return the same unexpired lease without fresh safety or principal-revision comparison and never extend it; expired retries fail. No new key, attempt or allocation can obtain another authorization for this flight, including when its first lease expired unused. Before POST, the producer checks route duration, known holds, margin and conservative lease handoff delay against mission end. At consumption, it refreshes fit and atomically retains the exact pinned mission, aircraft, route, live exclusive allocation, fit witness, once-per-flight consumption and physical transition across restart. An unused expired lease leaves the flight held or abandoned; there is no replacement protocol. Allocation and operation fit are producer commitments, not Ledger resource or aircraft-performance certification.',
} as const);

const digest = '59abfd56f1b1892027fbe4c9bc129844d1cf5b16f45c1c45063b80014bcd34df';
if (canonicalDigest(definition) !== digest)
  throw new Error('Mission departure policy version 1 changed without a new version');
export const missionDeparturePolicy: Readonly<MissionDeparturePolicy> = Object.freeze({ ...definition, digest });
