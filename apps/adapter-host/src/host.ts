import {
  BrokerAccountRefused,
  BrokerSubscription,
  CredentialRefused,
  describeFailure,
  HttpObservationSink,
  LedgerClient,
  pause,
  retryDelay,
  ServiceCredentialRefused,
  ServicePoll,
  SourceLoop,
  type AdapterDescriptor,
  type SourceLoopEvent,
  type SourceLoopStats,
} from '@ledger/adapters';
import type { Fidelity } from '@ledger/contracts';
import { MetricsRegistry, registerProcessMetrics, serveMetrics, type MetricsServer } from '@ledger/metrics';
import { sha256 } from '@ledger/integrity';
import { hostUsage, parseHostOptions, UsageError, type HostOptions } from './options.js';
import { registerAdapterMetrics } from './metrics.js';

export { hostUsage, parseHostOptions, UsageError, type HostOptions } from './options.js';
export { runnableAdapters, type RunnableAdapter } from './runnable.js';

/** What each fidelity level claims, in the words an operator reads at start. */
const fidelityWords: Record<Fidelity, string> = {
  synthetic_contract:
    'built from the source’s documentation and run against an emulator only; not checked against your equipment or a live service',
  documented_schema_conformant: 'checked against the source’s complete published schema; not against real equipment',
  captured_source_replay: 'checked against messages captured from a real source',
  validated_sandbox: 'checked against the source’s own sandbox',
  validated_live: 'checked against a live source',
};

export interface HostDependencies {
  /** Each log line, one JSON object. Default: standard output. */
  readonly out?: (line: string) => void;
  /** Usage and argument errors. Default: standard error. */
  readonly err?: (line: string) => void;
  /** Aborted to stop the process cleanly. Default: SIGTERM or SIGINT. */
  readonly stop?: AbortSignal;
  readonly fetcher?: typeof fetch;
  readonly summaryMs?: number;
}

interface Me {
  principal: {
    id: string;
    name: string;
    capabilities: string[];
    observationGrants: { sourceId: string; observationType: string }[];
  };
  organization?: { name?: string };
}

const REQUEST_TIMEOUT_MS = 30_000;

/** The fetch Ledger is called with: no request may hang the loop. */
function timedFetch(fetcher: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) =>
    fetcher(input, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })) as typeof fetch;
}

const status = (error: unknown): number | undefined =>
  typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;

function signalFromProcess(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return controller.signal;
}

/** Signs in, waiting for Ledger while it cannot be reached. Undefined when stopped first. */
async function signIn(
  ledger: LedgerClient,
  options: HostOptions,
  log: (event: SourceLoopEvent) => void,
  stop: AbortSignal,
): Promise<Me | undefined> {
  for (let attempt = 0; !stop.aborted; attempt++) {
    try {
      return await ledger.request<Me>('/v1/me');
    } catch (error) {
      const code = status(error);
      if (code === 401 || code === 403) throw new CredentialRefused(code, 'unauthenticated');
      const wait = retryDelay(attempt);
      log({
        event: 'ledger_unreachable',
        message: `Cannot reach Ledger at ${options.apiUrl} (${code ? `it answered ${code}` : describeFailure(error)}); trying again in ${wait} ms.`,
        waitMs: wait,
      });
      await pause(wait, stop);
    }
  }
  return undefined;
}

/** The source id the observations are submitted under, or why the credential cannot submit them. */
function sourceIdFor(me: Me, descriptor: AdapterDescriptor, wanted: string | undefined): string {
  const types = [...new Set(descriptor.produces.map((ref) => ref.type))];
  const grants = me.principal.observationGrants ?? [];
  const covers = (sourceId: string) =>
    types.every((type) => grants.some((grant) => grant.sourceId === sourceId && grant.observationType === type));
  const missing = (sourceId: string) =>
    types.filter((type) => !grants.some((grant) => grant.sourceId === sourceId && grant.observationType === type));
  if (!me.principal.capabilities.includes('input:write'))
    throw new Error(`${me.principal.name} may not submit inputs: give it input:write on the People screen`);
  if (wanted) {
    if (!covers(wanted))
      throw new Error(
        `${me.principal.name} has no observation grant for ${missing(wanted).join(', ')} under the source id ${wanted}: add it on the People screen`,
      );
    return wanted;
  }
  const candidates = [...new Set(grants.map((grant) => grant.sourceId))].filter(covers);
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length)
    throw new Error(
      `${me.principal.name} has no observation grants for ${types.join(', ')} under one source id: add them on the People screen`,
    );
  throw new Error(`${me.principal.name} may submit under ${candidates.join(', ')}: name one with --source-id`);
}

function credentialMessage(options: HostOptions, error: { status: number; code: string }): string {
  return `Ledger refused the credential labelled "${options.credentialLabel}" (${error.status} ${error.code}). It may be revoked, expired, mistyped or lack a grant: issue a new one on the People screen, under "Sources and services", and start the process again.`;
}

/**
 * Runs one adapter for one source until stopped. Returns the exit code: 0 after a clean stop with nothing left
 * unsubmitted, 1 when a credential is refused, the source cannot be read or payloads were left, 2 on a usage error.
 */
export async function runAdapterHost(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: HostDependencies = {},
): Promise<number> {
  const out = dependencies.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = dependencies.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (argv.includes('--help') || argv.includes('-h')) {
    out(hostUsage);
    return 0;
  }
  let options: HostOptions;
  try {
    options = parseHostOptions(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`${error.message}\n\n${hostUsage}`);
    return 2;
  }
  const { runnable } = options;
  const { descriptor } = runnable.adapter;
  const log = (event: SourceLoopEvent) =>
    out(JSON.stringify({ at: new Date().toISOString(), adapter: descriptor.id, ...event }));
  const stop = dependencies.stop ?? signalFromProcess();
  // The first line: what runs, how far it has been checked, and what a person must do before relying on it.
  log({
    event: 'starting',
    message: `${descriptor.id} ${descriptor.version} reads ${descriptor.source.product} (${descriptor.source.interface}). Fidelity ${descriptor.fidelity}: ${fidelityWords[descriptor.fidelity]}.${runnable.startNotice ? ` ${runnable.startNotice}` : ''}`,
    version: descriptor.version,
    fidelity: descriptor.fidelity,
    limitations: descriptor.limitations,
  });
  let stats: (() => SourceLoopStats) | undefined;
  let metrics: MetricsServer | undefined;
  if (options.metrics) {
    const registry = new MetricsRegistry();
    registerProcessMetrics(registry);
    registerAdapterMetrics(registry, () => stats?.());
    try {
      metrics = await serveMetrics(registry, options.metrics);
    } catch (error) {
      log({
        event: 'cannot_start',
        message: `Cannot serve metrics on ${options.metrics.host}:${options.metrics.port}: ${(error as Error).message}`,
      });
      return 1;
    }
    log({
      event: 'serving_metrics',
      message: `Serving metrics at http://${metrics.host.includes(':') ? `[${metrics.host}]` : metrics.host}:${metrics.port}/metrics.`,
      port: metrics.port,
    });
  }
  try {
    return await runSource(options, log, stop, dependencies, (read) => (stats = read));
  } finally {
    await metrics?.close();
  }
}

/** Signs in, then reads the source and submits what it sends until stopped. Returns the exit code. */
async function runSource(
  options: HostOptions,
  log: (event: SourceLoopEvent) => void,
  stop: AbortSignal,
  dependencies: HostDependencies,
  measure: (stats: () => SourceLoopStats) => void,
): Promise<number> {
  const { runnable } = options;
  const { descriptor } = runnable.adapter;

  const ledger = new LedgerClient(options.apiUrl, options.credential, timedFetch(dependencies.fetcher ?? fetch));
  let sourceId: string;
  try {
    const me = await signIn(ledger, options, log, stop);
    if (!me) return 0;
    sourceId = sourceIdFor(me, descriptor, options.sourceId);
    if (runnable.oneCurrentPerSubject?.length && !me.principal.capabilities.includes('evidence:read'))
      throw new Error(
        `${me.principal.name} may not read observations: give it evidence:read on the People screen. Before this adapter reports a ${runnable.oneCurrentPerSubject.join(' or ')} it reads the one on file about the same subject, so a changed record replaces the earlier one instead of standing beside it.`,
      );
    log({
      event: 'signed_in',
      message: `Signed in to ${me.organization?.name ?? 'Ledger'} as ${me.principal.name} with the credential labelled "${options.credentialLabel}"; submitting under the source id ${sourceId}.`,
      principal: me.principal.id,
      sourceId,
    });
  } catch (error) {
    log({
      event: 'cannot_start',
      message: error instanceof CredentialRefused ? credentialMessage(options, error) : (error as Error).message,
    });
    return 1;
  }

  const loop = new SourceLoop({
    adapter: runnable.adapter,
    context: { subjects: runnable.subjects(options.binding), binding: runnable.binding(options.binding) as never },
    sink: new HttpObservationSink({
      ledger,
      sourceId,
      ...(runnable.oneCurrentPerSubject ? { oneCurrentPerSubject: runnable.oneCurrentPerSubject } : {}),
    }),
    delivery: runnable.delivery,
    queueLimit: options.queueLimit,
    log,
  });
  measure(() => loop.stats);
  const receive = (message: Parameters<typeof loop.offer>[0]) => loop.offer(message);
  let transport: BrokerSubscription | ServicePoll;
  let transportFailed: Promise<unknown>;
  if (runnable.transport === 'broker') {
    const topic = runnable.topic(options.binding);
    const broker = options.broker!;
    const subscription = new BrokerSubscription(
      {
        url: broker.url,
        username: broker.username,
        password: broker.password,
        topic,
        clientId: `ledger-adapter-${sha256(`${descriptor.id}\n${broker.username}\n${topic}`).slice(0, 32)}`,
        log,
      },
      receive,
    );
    subscription.start().catch(() => {});
    transport = subscription;
    transportFailed = subscription.failed;
  } else {
    const service = options.service!;
    const poll = new ServicePoll(
      {
        url: service.urlAt ?? service.url,
        headers: service.headers,
        intervalMs: service.pollMs,
        log,
        ...(runnable.split ? { split: runnable.split } : {}),
        ...(runnable.partKey ? { partKey: runnable.partKey } : {}),
        ...(runnable.follow ? { follow: runnable.follow } : {}),
        ...(runnable.followedPart ? { followedPart: runnable.followedPart } : {}),
        ...(runnable.nextPage ? { nextPage: runnable.nextPage } : {}),
        ...(runnable.maxBytes ? { maxBytes: runnable.maxBytes } : {}),
        ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
      },
      receive,
    );
    log({
      event: 'polling',
      message: `Reading ${new URL(service.url).pathname}${new URL(service.url).search} every ${service.pollMs / 1000} s${service.lookBackHours ? `, each time for what began in the ${service.lookBackHours} hours before it` : ''}.`,
    });
    transport = poll;
    transportFailed = poll.start();
  }

  const summaries = setInterval(() => loop.summary(), dependencies.summaryMs ?? 60_000);
  const stopped = new Promise<'signal'>((resolve) => {
    if (stop.aborted) resolve('signal');
    stop.addEventListener('abort', () => resolve('signal'), { once: true });
  });
  const ended = await Promise.race([
    loop.start().then(
      () => ({ kind: 'signal' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    ),
    transportFailed.then(
      () => ({ kind: 'signal' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    ),
    stopped.then(() => ({ kind: 'signal' as const })),
  ]);
  clearInterval(summaries);
  await transport.stop();
  if (ended.kind === 'failed') {
    const { error } = ended;
    log({
      event: 'stopping_on_refusal',
      message:
        error instanceof CredentialRefused
          ? credentialMessage(options, error)
          : error instanceof BrokerAccountRefused || error instanceof ServiceCredentialRefused
            ? error.message
            : `The source cannot be read: ${(error as Error).message}`,
    });
  } else log({ event: 'stopping', message: 'Stopping: submitting what is held, then exiting.' });
  const left = await loop.stop(options.shutdownMs);
  const stats = loop.summary();
  log({
    event: 'stopped',
    message: left
      ? `Stopped with ${left} received message(s) not submitted. They are not kept: the next start reads the source afresh.`
      : 'Stopped with every received message submitted.',
    unsubmitted: left,
    ...stats,
  });
  return ended.kind === 'failed' || left ? 1 : 0;
}
