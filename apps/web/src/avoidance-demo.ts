import type {
  SimulationAvoidanceDemoControl,
  SimulationAvoidanceDemoCycleResponse,
  SmsDecisionRecord,
} from '@ledger/contracts';
import { canonicalDigest } from './safety.js';

export type DemoPhase = NonNullable<SimulationAvoidanceDemoCycleResponse['progress']>['phase'];

/** The accepted area control a demo flight exercises: its exact reference, and what its record calls it. */
export interface DemoAreaControl {
  reference: SimulationAvoidanceDemoControl;
  title: string;
  effectiveUntil: string | null;
}

/** A mission opened from a demo flight of an accepted area control. */
export interface AvoidanceDemoMission {
  cycleId: string;
  control: DemoAreaControl;
}

/** One version of a control record, as its own record page reads it. */
export interface DemoControlVersion {
  hazardId: string;
  controlId: string;
  versionNumber: number;
  /** The version event id, which route review and the demonstration cite. */
  versionId: string;
  bodyDigest: string;
}

export const demoPhaseLabels: Record<DemoPhase, string> = {
  preparing: 'Preparing an affected flight',
  held: 'Flight held for review',
  awaiting_route: 'Revise the affected route',
  awaiting_release: 'Record a release',
  awaiting_briefing: 'Prepare the exact briefing',
  awaiting_acknowledgement: 'Personal review needed',
  ready: 'Ready for the recorded departure',
  departure_unknown: 'Departure result unconfirmed',
  airborne: 'Flight reported airborne',
  monitoring: 'Collecting the flight sample',
  monitoring_available: 'Flight sample recorded',
  blocked: 'Preparation needs attention',
  abandoned: 'Demo cycle ended',
};

export const demoPhaseActions: Record<DemoPhase, string> = {
  preparing: 'The simulator is preparing a held flight for this accepted area.',
  held: 'Review the affected mission and its accepted avoidance areas.',
  awaiting_route: 'Request a suggested route, inspect it, then apply a new mission revision.',
  awaiting_release: 'Wait for the revised mission to finish processing, then record its release.',
  awaiting_briefing: 'Prepare a briefing for the recorded release and select the people who must review it.',
  awaiting_acknowledgement: 'Each named recipient must sign in and acknowledge this exact briefing personally.',
  ready: 'The simulator is checking allocation, timing and the recorded release before departure.',
  departure_unknown: 'Wait for the retained departure attempt to be reconciled. Do not start a replacement flight.',
  airborne: 'The simulator is flying the accepted mission geometry and reporting its actual observations.',
  monitoring: 'Wait for the linked monitoring sample to finish processing.',
  monitoring_available: 'Inspect the exact sample and the control’s indicator results on its safety record.',
  blocked: 'Review the reported reason before continuing.',
  abandoned: 'The earlier flight and its evidence remain on record.',
};

export function demoCanRepeat(result: SimulationAvoidanceDemoCycleResponse): boolean {
  return result.progress?.phase === 'monitoring_available' || result.progress?.phase === 'abandoned';
}

/**
 * The exact reference a demo flight names: the control version and the signed risk acceptance on its hazard that binds
 * it, cited by the digest of the content its signer signed.
 */
export function demoControlReference(
  control: DemoControlVersion,
  acceptance: Pick<SmsDecisionRecord, 'id' | 'kind' | 'subjectId' | 'acceptedRevision' | 'signature'>,
): SimulationAvoidanceDemoControl {
  if (acceptance.kind !== 'risk.accept' || acceptance.subjectId !== control.hazardId || !acceptance.signature)
    throw new Error('The accepted control could not be matched to its signed risk acceptance.');
  return {
    hazardId: control.hazardId,
    controlId: control.controlId,
    controlVersion: control.versionNumber,
    controlEventId: control.versionId,
    controlDigest: control.bodyDigest,
    acceptance: {
      id: acceptance.id,
      acceptedRevision: acceptance.acceptedRevision,
      digest: acceptance.signature.contentDigest,
    },
  };
}

export async function validateDemoCycle(
  result: SimulationAvoidanceDemoCycleResponse,
  control: SimulationAvoidanceDemoControl,
  expected: { cycleId?: string; flightId?: string } = {},
): Promise<void> {
  if (
    (expected.cycleId && result.cycle.id !== expected.cycleId) ||
    (await canonicalDigest(result.cycle.control)) !== (await canonicalDigest(control)) ||
    (await canonicalDigest(result.cycle)) !== result.digest
  )
    throw new Error('The demo flight does not match this exact accepted control. Refresh its record.');
  if (
    (result.progress === null) !== (result.progressDigest === null) ||
    (result.progress &&
      (result.progress.cycleId !== result.cycle.id ||
        (await canonicalDigest(result.progress)) !== result.progressDigest)) ||
    (expected.flightId && result.progress?.references.execution?.flightId !== expected.flightId)
  )
    throw new Error('The reported demo progress could not be matched to this flight and cycle. Refresh its record.');
}

export function retainDemoProgress(
  previous: SimulationAvoidanceDemoCycleResponse | undefined,
  next: SimulationAvoidanceDemoCycleResponse,
): SimulationAvoidanceDemoCycleResponse {
  if (!previous || previous.cycle.id !== next.cycle.id) return next;
  const earlierRevision = previous.progress?.revision ?? 0;
  const nextRevision = next.progress?.revision ?? 0;
  if (nextRevision < earlierRevision || (nextRevision === earlierRevision && next.readAt < previous.readAt))
    return previous;
  return next;
}
