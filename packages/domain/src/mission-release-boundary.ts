import type { MissionAvoidanceNotApplicable } from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { acceptedControlBoundaries, acceptedControls, type ControlInForce } from './accepted-control-rules.js';

type BoundControl = Pick<
  ControlInForce,
  'hazardId' | 'controlId' | 'versionNumber' | 'controlEventId' | 'acceptanceId' | 'effectiveFrom' | 'effectiveUntil'
>;

/** What a release records about the controls it found not to apply, by the binding each names. */
interface ReleaseApplicability {
  basis: {
    avoidance: {
      notApplicable: readonly (Pick<
        MissionAvoidanceNotApplicable,
        'hazardId' | 'controlId' | 'controlVersion' | 'controlEventId'
      > & { acceptance: { id: string } })[];
    };
  };
}

const bindingKey = (hazardId: string, controlId: string, version: number, eventId: string, acceptanceId: string) =>
  JSON.stringify([hazardId, controlId, version, eventId, acceptanceId]);

/**
 * The earliest instant after `after` at which an accepted control that can matter to the release's flight starts or
 * ends, or null when none does. A control the release recorded as not applying is left out: its outcome depends only
 * on the pinned mission revision, control version and rule, none of which an instant changes, and whether it is
 * considered depends on its interval overlapping the recorded operating interval, not on the clock. Every other
 * control counts, including one accepted or revised after the release, which changes the register on its own.
 */
export function releaseControlBoundary(
  controls: readonly BoundControl[],
  release: ReleaseApplicability,
  after: string,
): string | null {
  const notApplicable = new Set(
    release.basis.avoidance.notApplicable.map((entry) =>
      bindingKey(entry.hazardId, entry.controlId, entry.controlVersion, entry.controlEventId, entry.acceptance.id),
    ),
  );
  const matter = controls.filter(
    (control) =>
      !notApplicable.has(
        bindingKey(
          control.hazardId,
          control.controlId,
          control.versionNumber,
          control.controlEventId,
          control.acceptanceId,
        ),
      ),
  );
  return acceptedControlBoundaries(matter, Date.parse(after))[0] ?? null;
}

/** `releaseControlBoundary` over the organization's accepted controls as read now. */
export async function nextReleaseControlBoundary(
  client: PoolClient,
  tenantId: string,
  release: ReleaseApplicability,
  after: string,
): Promise<string | null> {
  return releaseControlBoundary(await acceptedControls(client, tenantId), release, after);
}
