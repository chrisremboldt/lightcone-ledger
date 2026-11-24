import { createContext } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { AcceptedAreaControlResponse, MissionAvoidanceCandidate } from '@ledger/contracts';

/** The exact accepted control version a route-review candidate, release or review names. */
export type AreaControlReference = Pick<
  MissionAvoidanceCandidate,
  'hazardId' | 'controlId' | 'controlVersion' | 'controlEventId' | 'controlDigest'
>;

/** An accepted area control record as a screen shows it. */
export interface AreaControl {
  controlId: string;
  controlVersion: number;
  /** Where it was accepted, in words. */
  sourceLabel: string;
  eventId: string;
  title: string;
  /** What the control asks of a person, in the wording its type gives it. */
  wording: string;
  area: { center: { latitude: number; longitude: number }; radiusMeters: number; site?: string };
  hazard: { id: string; title: string | null };
  effective: { from: string; until: string | null };
  owner: { id: string; name: string };
}

/** Opens a safety-record hazard's page, when the screen around it can. */
export const SafetyRecordLink = createContext<((hazardId: string) => void) | null>(null);

type ControlRecordRead = AcceptedAreaControlResponse['control'];

/** An area control record accepted on a safety-record hazard, as screens show it. */
export function recordAreaControl(read: ControlRecordRead, reference: AreaControlReference): AreaControl {
  const { content } = read;
  return {
    controlId: reference.controlId,
    controlVersion: reference.controlVersion,
    sourceLabel: `${content.controlType.title} on the safety record`,
    eventId: read.controlEventId,
    title: content.title,
    wording: content.description,
    area: content.area,
    hazard: read.hazard,
    effective: { from: content.effectiveFrom, until: content.effectiveUntil },
    owner: read.owner,
  };
}

/** Reads one accepted area control version and checks it is exactly the one referenced. */
export async function resolveAreaControl(client: LedgerClient, reference: AreaControlReference): Promise<AreaControl> {
  const { control } = await client.acceptedAreaControl(
    reference.hazardId,
    reference.controlId,
    reference.controlVersion,
  );
  if (
    control.controlEventId !== reference.controlEventId ||
    control.bodyDigest !== reference.controlDigest ||
    control.hazard.id !== reference.hazardId
  )
    throw new Error('An accepted area control could not be matched to its exact version.');
  return recordAreaControl(control, reference);
}
