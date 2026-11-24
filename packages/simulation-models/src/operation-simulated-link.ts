import type { OperationAttempt, OperationConfig, OperationWorld } from './operation.js';

export type OperationSimulatedLinkState = 'up' | 'down' | 'unknown';

export interface OperationSimulatedLinkConfig {
  version: 'simulated-link.1';
  attemptId: string;
  initialState: OperationSimulatedLinkState;
}

export interface OperationSimulatedLink {
  version: 'simulated-link.1';
  state: OperationSimulatedLinkState;
  changedAt: string;
}

export interface OperationCommandLinkReading {
  version: 'operation.command-link-reading.1';
  attemptId: string;
  aircraftId: string;
  sourceId: 'command-link';
  sourceSessionId: string;
  state: OperationSimulatedLinkState;
  occurredAt: string;
}

const state = (value: unknown): value is OperationSimulatedLinkState =>
  value === 'up' || value === 'down' || value === 'unknown';

export function validateOperationSimulatedLink(config: OperationConfig): void {
  const radio = config.simulatedLink;
  if (radio === undefined) return;
  if (
    !radio ||
    Object.keys(radio).sort().join(',') !== 'attemptId,initialState,version' ||
    radio.version !== 'simulated-link.1' ||
    !state(radio.initialState) ||
    typeof radio.attemptId !== 'string' ||
    !new RegExp(`^intent-${config.runId}-(alpha|beta)-(0|[1-9]\\d*):attempt:1$`).test(radio.attemptId) ||
    !Number.isSafeInteger(Number(radio.attemptId.split(':')[0]!.split('-').at(-1)))
  )
    throw new Error('Simulated link requires one explicit initial state and an exact attempt in this fresh run');
}

export function initializeOperationSimulatedLink(world: OperationWorld, attempt: OperationAttempt): void {
  const demo = world.demoFlights?.find((flight) => flight.attemptId === attempt.id);
  const radio = demo
    ? { version: 'simulated-link.1' as const, attemptId: demo.attemptId, initialState: demo.radioInitialState }
    : world.config.simulatedLink;
  if (!radio || radio.attemptId !== attempt.id) return;
  if (!demo) validateOperationSimulatedLink(world.config);
  if (attempt.simulatedLink || attempt.departure !== new Date(world.now).toISOString())
    throw new Error('Simulated link can initialize only once at its selected actual departure');
  attempt.simulatedLink = { version: 'simulated-link.1', state: radio.initialState, changedAt: attempt.departure };
}

function retained(world: OperationWorld, attempt: OperationAttempt): OperationSimulatedLink | undefined {
  const configured = world.config.simulatedLink?.attemptId === attempt.id;
  if (
    !configured &&
    !world.demoFlights?.some((flight) => flight.attemptId === attempt.id) &&
    attempt.ordinaryIncident?.kind !== 'command-link'
  )
    return undefined;
  if (configured) validateOperationSimulatedLink(world.config);
  const radio = attempt.simulatedLink;
  if (!radio) return undefined;
  const changedAt = Date.parse(radio.changedAt);
  if (
    Object.keys(radio).sort().join(',') !== 'changedAt,state,version' ||
    radio.version !== 'simulated-link.1' ||
    !state(radio.state) ||
    !Number.isSafeInteger(changedAt) ||
    new Date(changedAt).toISOString() !== radio.changedAt ||
    changedAt < Date.parse(attempt.departure) ||
    changedAt > world.now
  )
    throw new Error('Retained simulated link state or transition clock is invalid');
  return radio;
}

export function transitionOperationSimulatedLink(
  world: OperationWorld,
  attempt: OperationAttempt,
  next: 'up' | 'down',
): void {
  const radio = retained(world, attempt);
  if (!radio) return;
  radio.state = next;
  radio.changedAt = new Date(world.now).toISOString();
}

export function operationCommandLinkReading(
  world: OperationWorld,
  attemptId: string,
): OperationCommandLinkReading | undefined {
  if (!Number.isSafeInteger(world.now) || !Number.isFinite(new Date(world.now).getTime()))
    throw new Error('Simulated link reading requires a valid current world clock');
  const attempt = world.attempts.find((row) => row.id === attemptId);
  if (!attempt || attempt.phase !== 'flying') return undefined;
  const radio = retained(world, attempt);
  if (!radio) return undefined;
  return {
    version: 'operation.command-link-reading.1',
    attemptId: attempt.id,
    aircraftId: attempt.aircraftId,
    sourceId: 'command-link',
    sourceSessionId: `${attempt.sourceSessionId}-command-link-1`,
    state: radio.state,
    occurredAt: new Date(world.now).toISOString(),
  };
}
