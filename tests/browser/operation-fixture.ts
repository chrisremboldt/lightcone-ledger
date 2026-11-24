import {
  advanceOperation,
  activateOperationOrdinaryDispatch,
  createOperation,
} from '../../packages/simulation-models/dist/operation.js';
import { yards } from '../../packages/simulation-models/dist/places.js';
import { advanceLiveClock, type OperationCheckpoint } from '../../apps/simulator/src/operation-state.js';

/**
 * A simulated operation with ordinary dispatch, moved to its own patch of geography so no other test's accepted area
 * overlaps its routes. The clock and work run with the shifted yards in place.
 */
export function routeFixtureWorld(config: Parameters<typeof createOperation>[0]) {
  const cell = Math.floor(Date.now() / 1000) % (512 * 512);
  const offset = { latitude: 2 + (cell % 512) * 0.05, longitude: 2 + Math.floor(cell / 512) * 0.05 };
  const fixtureYards = Object.fromEntries(
    Object.entries(yards).map(([id, yard]) => [
      id,
      { ...yard, latitude: yard.latitude + offset.latitude, longitude: yard.longitude + offset.longitude },
    ]),
  );
  function inFixtureGeography<T>(work: () => T): T {
    const originalYards = Object.entries(yards);
    try {
      Object.assign(yards, fixtureYards);
      return work();
    } finally {
      Object.assign(yards, Object.fromEntries(originalYards));
    }
  }
  const world = inFixtureGeography(() => {
    const created = createOperation(config);
    for (const site of created.sites) {
      site.coordinate.latitude += offset.latitude;
      site.coordinate.longitude += offset.longitude;
    }
    activateOperationOrdinaryDispatch(created);
    advanceOperation(created, Date.parse(created.config.start));
    return created;
  });
  const clock = (state: OperationCheckpoint, at: number) =>
    inFixtureGeography(() => advanceLiveClock(state, at, false));
  const inGeography = async <T>(work: () => Promise<T>): Promise<T> => {
    const originalYards = Object.entries(yards);
    try {
      Object.assign(yards, fixtureYards);
      return await work();
    } finally {
      Object.assign(yards, Object.fromEntries(originalYards));
    }
  };
  return { world, clock, inGeography };
}

/**
 * One pass of a source coordinator, as the simulator's own loop runs it: a pass refused because a record it names has
 * not finished projection keeps its request and sends it again on the next pass, so the caller polls. Any other
 * failure is the test's.
 */
export async function sourcePass(pass: () => Promise<void>): Promise<void> {
  try {
    await pass();
  } catch (failure) {
    // Read by shape: the coordinator's client and this file may load the error class from different copies.
    const refused = failure as { status?: unknown; body?: { error?: { code?: unknown } } } | null;
    if (refused?.status !== 409 || refused.body?.error?.code !== 'predeparture_projection_pending') throw failure;
  }
}
