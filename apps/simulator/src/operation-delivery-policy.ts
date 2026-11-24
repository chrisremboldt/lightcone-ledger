import type { OperationWorld, WorldFact } from '@ledger/simulation-models/operation';

export function commandLinkDeliveryPending(fact: WorldFact): boolean {
  return fact.kind === 'command-link';
}

export function missionDeliveryPending(fact: WorldFact): boolean {
  return fact.kind === 'mission' && !fact.publicAcceptance;
}

export function ordinaryDeliveryPending(fact: WorldFact): boolean {
  return !commandLinkDeliveryPending(fact) && fact.kind !== 'mission';
}

export function departureDeliveryChannel(world: OperationWorld, fact: WorldFact): 'native' | 'telemetry' | undefined {
  if (!world.departures?.some((departure) => departure.attemptId === fact.attemptId)) return undefined;
  if (fact.kind === 'position') return 'telemetry';
  if (fact.kind === 'departure' || fact.kind === 'landing' || fact.kind === 'landing-report') return 'native';
  return undefined;
}

export function missionDeliveryStatus(world: OperationWorld, pending: Record<string, Array<{ fact: WorldFact }>>) {
  if (!world.config.missionPlan && !world.config.predeparture && !world.demoFlights?.length && !world.ordinaryDispatch)
    return {};
  return {
    missionDelivery: {
      sourceId: 'mission-planner',
      consumer: 'available',
      pendingPlans: Object.values(pending)
        .flat()
        .filter((entry) => missionDeliveryPending(entry.fact)).length,
    },
  };
}

export function commandLinkDeliveryStatus(world: OperationWorld, pending: Record<string, Array<{ fact: WorldFact }>>) {
  if (!world.commandLinkEpisode) return {};
  const pendingReports = Object.values(pending)
    .flat()
    .filter((entry) => commandLinkDeliveryPending(entry.fact)).length;
  return {
    commandLinkDelivery: {
      state: pendingReports
        ? 'pending'
        : world.now < Date.parse(world.commandLinkEpisode.endsAt)
          ? 'awaiting reports'
          : 'drained',
      pendingReports,
    },
  };
}

export function interruptionFrame(world: OperationWorld, fact: WorldFact): boolean {
  const interruption = world.telemetryDeliveryInterruption;
  if (world.config.profile !== 'telemetry-delivery-interruption' || !interruption) return false;
  return fact.kind === 'position' && fact.aircraftId === interruption.aircraftId;
}

export function telemetryDeliveryInterrupted(world: OperationWorld): boolean {
  const interruption = world.telemetryDeliveryInterruption;
  if (world.config.profile !== 'telemetry-delivery-interruption' || !interruption) return false;
  return world.now >= Date.parse(interruption.startsAt) && world.now < Date.parse(interruption.endsAt);
}

export function telemetryDeliveryStatus(
  world: OperationWorld,
  pending: Record<string, Array<{ fact: WorldFact }>> = {},
) {
  if (world.config.profile !== 'telemetry-delivery-interruption') return {};
  const interruption = world.telemetryDeliveryInterruption;
  if (!interruption) return { telemetryDelivery: { state: 'awaiting first flight' } };
  const bufferedFrames = Object.values(pending)
    .flat()
    .filter(
      (entry) => interruptionFrame(world, entry.fact) && Date.parse(entry.fact.at) < Date.parse(interruption.endsAt),
    ).length;
  return {
    telemetryDelivery: {
      ...interruption,
      state:
        world.now < Date.parse(interruption.startsAt)
          ? 'scheduled'
          : telemetryDeliveryInterrupted(world)
            ? 'interrupted'
            : bufferedFrames
              ? 'replaying'
              : 'recovered',
      bufferedFrames,
    },
  };
}
