import type { MissionBriefingStanding } from '@ledger/contracts';
import { DomainError, type PoolClient } from '@ledger/persistence';

/** When a briefing stops counting, as recorded beside it, and the end of its release's departure window. */
export interface BriefingBounds {
  validUntil: string;
  releaseWindowEnd: string;
}

/**
 * Whether a briefing counts at `at`: it is in force before its `validUntil` and lapsed from that instant on. Its
 * `validUntil` is the release window's end or, when earlier, the first start or end of an accepted control that can
 * matter to the flight; the boundary says which. A briefing past it no longer describes controls known to hold.
 */
export function briefingStanding(bounds: BriefingBounds, at: string): MissionBriefingStanding {
  const validUntil = new Date(bounds.validUntil).toISOString();
  return {
    status: Date.parse(at) < Date.parse(validUntil) ? 'in_force' : 'lapsed',
    validUntil,
    boundary: Date.parse(validUntil) >= Date.parse(bounds.releaseWindowEnd) ? 'release_window_end' : 'control_boundary',
    evaluatedAt: new Date(at).toISOString(),
  };
}

/** The sentence a refusal gives for a lapsed briefing. */
export function briefingLapsedMessage(standing: MissionBriefingStanding): string {
  const cause =
    standing.boundary === 'release_window_end'
      ? "its release's departure window closed"
      : 'an accepted control that can matter to the flight started or ended';
  return `This briefing lapsed at ${standing.validUntil}, when ${cause}. Its picture of the controls is no longer known to hold; a new briefing is needed.`;
}

export function briefingLapsed(briefingId: string, standing: MissionBriefingStanding): DomainError {
  return new DomainError(409, 'briefing_lapsed', briefingLapsedMessage(standing), {
    briefingId,
    validUntil: standing.validUntil,
    boundary: standing.boundary,
    evaluatedAt: standing.evaluatedAt,
  });
}

/** Each named briefing's standing now, by the database clock in the caller's transaction. */
export async function briefingStandings(
  client: PoolClient,
  tenantId: string,
  flightId: string,
  briefingIds: readonly string[],
): Promise<Map<string, MissionBriefingStanding>> {
  if (!briefingIds.length) return new Map();
  const rows = (
    await client.query<{ id: string; valid_until: Date; window_end: string; now: Date }>(
      `SELECT b.id,b.valid_until,r.record#>>'{departureWindow,end}' AS window_end,clock_timestamp() AS now
       FROM mission_briefings b JOIN mission_releases r
       ON r.tenant_id=b.tenant_id AND r.id=b.release_id AND r.flight_id=b.flight_id
       WHERE b.tenant_id=$1 AND b.flight_id=$2 AND b.id=ANY($3::text[])`,
      [tenantId, flightId, [...briefingIds]],
    )
  ).rows;
  return new Map(
    rows.map((row) => [
      row.id,
      briefingStanding(
        { validUntil: row.valid_until.toISOString(), releaseWindowEnd: row.window_end },
        row.now.toISOString(),
      ),
    ]),
  );
}

export async function briefingStandingNow(
  client: PoolClient,
  tenantId: string,
  flightId: string,
  briefingId: string,
): Promise<MissionBriefingStanding> {
  const standing = (await briefingStandings(client, tenantId, flightId, [briefingId])).get(briefingId);
  if (!standing)
    throw new DomainError(404, 'mission_briefing_not_found', 'Mission briefing was not found within this flight');
  return standing;
}
