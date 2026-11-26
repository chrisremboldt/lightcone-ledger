import type { SourceLoopStats } from '@ledger/adapters';
import type { MetricsRegistry } from '@ledger/metrics';

const MESSAGE_OUTCOMES = {
  received: 'received',
  submitted: 'submittedMessages',
  rejected: 'rejected',
  refused: 'refused',
  dropped: 'dropped',
} as const satisfies Record<string, keyof SourceLoopStats>;

/**
 * The adapter process's figures, read from its loop at each collection: messages by what became of them (received,
 * submitted, left out by the adapter's translation, refused by Ledger, dropped from a full queue), the observations
 * submitted, the retries, and the messages waiting. All zero until the process has signed in.
 */
export function registerAdapterMetrics(registry: MetricsRegistry, read: () => SourceLoopStats | undefined): void {
  const messages = registry.counter(
    'ledger_adapter_messages_total',
    'Messages from the source, by what became of them: received, submitted, rejected by the translation, refused by Ledger, dropped from a full queue.',
    ['outcome'],
  );
  const observations = registry.counter(
    'ledger_adapter_observations_submitted_total',
    'Observations in the messages submitted to Ledger.',
  );
  const retries = registry.counter(
    'ledger_adapter_retries_total',
    'Submissions sent again after Ledger could not take them.',
  );
  const queued = registry.gauge('ledger_adapter_queued_messages', 'Messages received and not yet submitted.');
  registry.onCollect(() => {
    const stats = read();
    for (const [outcome, field] of Object.entries(MESSAGE_OUTCOMES))
      messages.setTotal({ outcome }, stats?.[field] ?? 0);
    observations.setTotal({}, stats?.observations ?? 0);
    retries.setTotal({}, stats?.retries ?? 0);
    queued.set({}, stats?.queued ?? 0);
  });
}
