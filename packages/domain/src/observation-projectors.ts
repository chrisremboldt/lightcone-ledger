import type { AuthContext, JournalEvent, PoolClient } from '@ledger/persistence';

/**
 * A projection a problem module adds for accepted observations of one type, for reads that are not yet on the
 * generic evaluator. The projection of an observation, or of a correction to one, calls `project` before it records
 * the stream position, and `settle` after it, once for each flight `project` returned.
 */
export interface ObservationProjector {
  readonly id: string;
  readonly type: string;
  /** Records what the event adds to flight threads, for an `observation` event or a correction event. */
  project(client: PoolClient, event: JournalEvent): Promise<readonly string[]>;
  settle(client: PoolClient, principal: AuthContext, flightId: string, event: JournalEvent): Promise<void>;
}

// One process can load this module both from source and from its build (tests do), so both copies share one list.
const registryKey = Symbol.for('ledger.observation-projectors.1');
const projectors: ObservationProjector[] = ((globalThis as Record<symbol, ObservationProjector[] | undefined>)[
  registryKey
] ??= []);

/** Adds a projector. The first registration of an id is kept. */
export function registerObservationProjector(projector: ObservationProjector): void {
  if (!projectors.some((existing) => existing.id === projector.id)) projectors.push(projector);
}

/** The observation types an `observation` event or a correction event names. */
function eventTypes(event: JournalEvent): Set<string> {
  const types = new Set<string>();
  const observationType = (event.payload.payload as { type?: unknown } | undefined)?.type;
  if (event.event_type === 'observation' && typeof observationType === 'string') types.add(observationType);
  for (const affected of (event.payload.affected as { type?: unknown }[] | undefined) ?? [])
    if (typeof affected?.type === 'string') types.add(affected.type);
  return types;
}

/** Runs the projectors for the types the event names, and returns what each must settle. */
export async function projectObservationEvent(
  client: PoolClient,
  event: JournalEvent,
): Promise<{ projector: ObservationProjector; flightIds: readonly string[] }[]> {
  const types = eventTypes(event);
  const projected = [];
  for (const projector of projectors.filter((candidate) => types.has(candidate.type)))
    projected.push({ projector, flightIds: [...new Set(await projector.project(client, event))].sort() });
  return projected;
}

export async function settleObservationEvent(
  client: PoolClient,
  principal: AuthContext,
  event: JournalEvent,
  projected: { projector: ObservationProjector; flightIds: readonly string[] }[],
): Promise<void> {
  for (const { projector, flightIds } of projected)
    for (const flightId of flightIds) await projector.settle(client, principal, flightId, event);
}
