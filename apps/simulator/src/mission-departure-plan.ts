import type { MissionDepartureAuthorizationCommand, MissionReleaseCommand } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { ReleasePending } from './mission-release-plan.js';

export { ReleasePending } from './mission-release-plan.js';

export interface MissionDeparturePlan {
  version: 1;
  apiUrl: string;
  tenantId: string;
  principalId: string;
  runId: string;
  reservationId: string;
  flightId: string;
  aircraftId: string;
  release: MissionDepartureAuthorizationCommand['release'];
  mission: MissionReleaseCommand['mission'];
  departureAttemptId: string;
  marginMs: number;
  latencyMarginMs: number;
  handoffAllowanceMs: number;
  allocationDurationMs: number;
}

function invalid(): never {
  throw new ReleasePending(
    'plan_invalid',
    'Departure requires one exact reviewed reservation and finite timing bounds',
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) invalid();
}

function id(value: unknown): boolean {
  return (
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function digest(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function validateMissionDeparturePlan(value: unknown): MissionDeparturePlan {
  const plan = object(value);
  keys(plan, [
    'version',
    'apiUrl',
    'tenantId',
    'principalId',
    'runId',
    'reservationId',
    'flightId',
    'aircraftId',
    'release',
    'mission',
    'departureAttemptId',
    'marginMs',
    'latencyMarginMs',
    'handoffAllowanceMs',
    'allocationDurationMs',
  ]);
  if (
    plan.version !== 1 ||
    !['tenantId', 'principalId', 'runId', 'reservationId', 'flightId', 'aircraftId', 'departureAttemptId'].every(
      (key) => id(plan[key]),
    )
  )
    return invalid();
  try {
    if (typeof plan.apiUrl !== 'string' || plan.apiUrl.length > 2048) return invalid();
    const url = new URL(plan.apiUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return invalid();
  } catch {
    return invalid();
  }
  const release = object(plan.release);
  keys(release, ['id', 'digest']);
  if (!id(release.id) || !digest(release.digest)) return invalid();
  const mission = object(plan.mission);
  keys(mission, ['missionId', 'sourceRevision', 'eventId', 'contentDigest', 'recordDigest']);
  if (
    !id(mission.missionId) ||
    !id(mission.eventId) ||
    !Number.isSafeInteger(mission.sourceRevision) ||
    Number(mission.sourceRevision) < 1 ||
    !digest(mission.contentDigest) ||
    !digest(mission.recordDigest)
  )
    return invalid();
  for (const field of ['marginMs', 'latencyMarginMs', 'handoffAllowanceMs', 'allocationDurationMs'])
    if (!Number.isSafeInteger(plan[field]) || Number(plan[field]) <= 0) return invalid();
  if (
    Number(plan.latencyMarginMs) > 10_000 ||
    Number(plan.handoffAllowanceMs) > 30_000 ||
    Number(plan.allocationDurationMs) > 90_000 ||
    Number(plan.allocationDurationMs) < Number(plan.handoffAllowanceMs) + Number(plan.latencyMarginMs) + 10_000
  )
    return invalid();
  canonicalDigest(plan);
  return structuredClone(plan) as unknown as MissionDeparturePlan;
}
