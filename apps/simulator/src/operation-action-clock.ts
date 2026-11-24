import { ReleasePending } from './mission-departure-plan.js';
import { advanceLiveClock, type OperationCheckpoint } from './operation-state.js';
import { HOSTED_WORLD_LIMITS } from './operation-target.js';

export type OperationActionClock = (state: OperationCheckpoint, at: number) => void;

export function hostedActionClock(isStopping: () => boolean): OperationActionClock {
  return (state, at) => {
    if (isStopping())
      throw new ReleasePending('world_stopping', 'A stopping hosted world cannot begin or consume an action');
    if (
      !Number.isSafeInteger(at) ||
      !Number.isFinite(new Date(at).getTime()) ||
      state.clock.mode !== 'live' ||
      state.clock.paused ||
      !Number.isSafeInteger(state.clock.wallAt) ||
      !Number.isFinite(new Date(state.clock.wallAt).getTime()) ||
      state.world.now !== state.clock.wallAt ||
      at < state.clock.wallAt
    )
      throw new ReleasePending(
        'world_clock_unavailable',
        'Hosted actions require a finite, aligned, unpaused live clock',
      );
    if (at - state.clock.wallAt > HOSTED_WORLD_LIMITS.advanceMs)
      throw new ReleasePending('world_clock_lagging', 'The hosted scheduler must catch up before this action');
    const pending = state.world.nextFact - state.accepted;
    if (!Number.isSafeInteger(pending) || pending < 0)
      throw new ReleasePending('world_clock_unavailable', 'Hosted pending evidence counters are invalid');
    if (pending >= HOSTED_WORLD_LIMITS.pendingFacts)
      throw new ReleasePending('world_backpressure', 'Hosted pending evidence must drain before this action');
    advanceLiveClock(state, at, false);
  };
}
