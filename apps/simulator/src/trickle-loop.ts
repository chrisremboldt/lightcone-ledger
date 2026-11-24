const landingPollInterval = 15_000;

interface TrickleLoop {
  interval: number;
  stopped(): boolean;
  assertControl(): void;
  arrival(scheduled: number): Promise<void>;
  landings(): Promise<void>;
  observations?(): Promise<void>;
  saturated(): void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function runTrickleLoop(loop: TrickleLoop): Promise<void> {
  const now = loop.now ?? Date.now;
  const sleep = loop.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let scheduled = now();
  let nextLandingPoll = scheduled;
  let nextObservationPoll = scheduled;
  const deliver = async (action: () => Promise<void>) => {
    try {
      loop.assertControl();
      await action();
    } catch (error) {
      loop.assertControl();
      throw error;
    }
    loop.assertControl();
  };
  while (!loop.stopped()) {
    loop.assertControl();
    if (now() >= scheduled) {
      await deliver(() => loop.arrival(scheduled));
      scheduled += loop.interval;
      if (scheduled < now() - loop.interval) {
        loop.saturated();
        scheduled = now() + loop.interval;
      }
    }
    if (!loop.stopped() && now() >= nextLandingPoll) {
      await deliver(loop.landings);
      nextLandingPoll = now() + landingPollInterval;
    }
    if (!loop.stopped() && loop.observations && now() >= nextObservationPoll) {
      await deliver(loop.observations);
      nextObservationPoll = now() + 1000;
    }
    if (!loop.stopped())
      await sleep(
        Math.max(
          0,
          Math.min(
            1000,
            scheduled - now(),
            nextLandingPoll - now(),
            loop.observations ? nextObservationPoll - now() : Infinity,
          ),
        ),
      );
  }
}
