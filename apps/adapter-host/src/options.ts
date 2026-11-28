import { parseArgs } from 'node:util';
import { transportUrl } from '@ledger/adapters';
import { metricsListen, type MetricsListen } from '@ledger/metrics';
import { bindingProblem, runnableAdapters, type BindingOption, type RunnableAdapter } from './runnable.js';

export interface HostOptions {
  readonly adapterId: string;
  readonly runnable: RunnableAdapter;
  readonly apiUrl: string;
  /** Secret: from the environment only, never logged. */
  readonly credential: string;
  readonly credentialLabel: string;
  readonly sourceId?: string;
  readonly binding: Readonly<Partial<Record<BindingOption, string>>>;
  readonly broker?: { readonly url: string; readonly username: string; readonly password: string };
  readonly service?: {
    readonly url: string;
    /** The URL of one poll, for a service asked for what began in the look-back before it. */
    readonly urlAt?: (now: Date) => string;
    readonly lookBackHours?: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly pollMs: number;
  };
  readonly queueLimit: number;
  readonly shutdownMs: number;
  readonly privateNetwork: boolean;
  /** Where the process serves its metrics; unset, it serves none. */
  readonly metrics?: MetricsListen;
}

/** Each setting's environment variable with its flag. A flag wins over the environment. */
const settings = {
  LEDGER_API_URL: 'api-url',
  LEDGER_CREDENTIAL_LABEL: 'credential-label',
  LEDGER_SOURCE_ID: 'source-id',
  ADAPTER_BROKER_URL: 'broker-url',
  ADAPTER_BROKER_USERNAME: 'broker-username',
  ADAPTER_DEVICE: 'device',
  ADAPTER_GATEWAY: 'gateway',
  ADAPTER_DOCK: 'dock',
  ADAPTER_SITE: 'site',
  ADAPTER_DOCK_MODEL: 'dock-model',
  ADAPTER_SERVICE_URL: 'service-url',
  ADAPTER_OPERATION: 'operation',
  ADAPTER_FLIGHT: 'flight',
  ADAPTER_STATIONS: 'stations',
  ADAPTER_REGIONS: 'regions',
  ADAPTER_POLL_SECONDS: 'poll-seconds',
  ADAPTER_LOOK_BACK_HOURS: 'look-back-hours',
  ADAPTER_QUEUE_LIMIT: 'queue-limit',
  ADAPTER_SHUTDOWN_SECONDS: 'shutdown-seconds',
  LEDGER_METRICS_LISTEN: 'metrics-listen',
} as const;
type Variable = keyof typeof settings;
type Flag = (typeof settings)[Variable];

/** Secrets are read from the environment only, so they never reach a shell history or a process list. */
const secretVariables = [
  'LEDGER_API_CREDENTIAL',
  'ADAPTER_BROKER_PASSWORD',
  'ADAPTER_SERVICE_TOKEN',
  'ADAPTER_SERVICE_API_KEY',
];

const bindingVariables: Record<BindingOption, Variable> = {
  device: 'ADAPTER_DEVICE',
  gateway: 'ADAPTER_GATEWAY',
  dock: 'ADAPTER_DOCK',
  site: 'ADAPTER_SITE',
  dockModel: 'ADAPTER_DOCK_MODEL',
  operation: 'ADAPTER_OPERATION',
  flight: 'ADAPTER_FLIGHT',
  stations: 'ADAPTER_STATIONS',
  regions: 'ADAPTER_REGIONS',
};
const flagOf = (option: BindingOption): Flag => settings[bindingVariables[option]];

export const hostUsage = `Usage: pnpm adapter:run <adapter> [flags]
       node apps/adapter-host/dist/main.js <adapter> [flags]

Runs one adapter for one source: receives the source's messages over its own transport, translates them with the
adapter and submits them to Ledger's API with their original bytes. It writes nothing to the database.

Adapters:
${Object.entries(runnableAdapters)
  .map(
    ([id, runnable]) =>
      `  ${id.padEnd(36)} ${runnable.transport === 'broker' ? 'message broker' : 'polls the service'}: ${runnable.bindingOptions.map((option) => `--${flagOf(option)}`).join(' ') || '(no source settings)'}`,
  )
  .join('\n')}

Every flag can be given as the environment variable after it instead; the flag wins.
  --help                                               Print this and exit
  --api-url <url>            LEDGER_API_URL            Ledger's API, for example https://ledger.example.org
  --credential-label <text>  LEDGER_CREDENTIAL_LABEL   The label the credential was issued with
  --source-id <id>           LEDGER_SOURCE_ID          The source id its observation grants name (default: the
                                                       one source id they name)
  --broker-url <url>         ADAPTER_BROKER_URL        mqtts://host:8883, or mqtt://127.0.0.1:1883 on this host
  --broker-username <name>   ADAPTER_BROKER_USERNAME   The source's broker account (its id)
  --device <serial>          ADAPTER_DEVICE            The aircraft's serial number
  --gateway <serial>         ADAPTER_GATEWAY           The dock or controller the aircraft reports through
  --dock <serial>            ADAPTER_DOCK              The dock's serial number
  --site <id>                ADAPTER_SITE              The site the dock stands at
  --dock-model <model>       ADAPTER_DOCK_MODEL        dock2, dock3 or dock4
  --service-url <url>        ADAPTER_SERVICE_URL       The service, for example https://service.example.org
  --operation <id>           ADAPTER_OPERATION         The airspace service's operation id
  --flight <id>              ADAPTER_FLIGHT            The Ledger flight the operation was requested for
  --stations <list>          ADAPTER_STATIONS          Weather stations and the sites each reports for, as
                                                       STATION=SITE[@DISTANCE] separated by semicolons, the
                                                       distance in m or km: KORD=RIDGE-SITE-1@14.2km;KORD=RIDGE-SITE-2
  --regions <list>           ADAPTER_REGIONS           Circles a flight restriction is recorded for when it touches one,
                                                       as REGION=SITE@LATITUDE,LONGITUDE,RADIUS separated by
                                                       semicolons, the radius in m or km: RIDGE-AREA-1=RIDGE-SITE-1@39.97,-86.13,5km
  --poll-seconds <n>         ADAPTER_POLL_SECONDS      Seconds between reads of the service (default 60 for the
                                                       airspace service, 300 for weather reports, 900 for
                                                       forecasts, 600 for flight restrictions, 120 for the
                                                       flight service; at least 5)
  --look-back-hours <n>      ADAPTER_LOOK_BACK_HOURS   The flight service only: each read asks for the flights that
                                                       took off in this many hours before it (default 168)
  --queue-limit <n>          ADAPTER_QUEUE_LIMIT       Messages held while Ledger cannot be reached (default 10000)
  --shutdown-seconds <n>     ADAPTER_SHUTDOWN_SECONDS  How long a stop waits to submit what it holds (default 10)
  --private-network          ADAPTER_PRIVATE_NETWORK=1 Allow http:// and mqtt:// to another host on a network you
                                                       control
  --metrics-listen <where>   LEDGER_METRICS_LISTEN     Serve metrics at /metrics on this port (loopback) or
                                                       address:port (default: none)

Secrets, from the environment only:
  LEDGER_API_CREDENTIAL      The source's API credential, as issued
  ADAPTER_BROKER_PASSWORD    The broker account's password
  ADAPTER_SERVICE_TOKEN      The service's token: the airspace service's access token, sent as a bearer token,
                             or the flight service's API token, sent as the whole Authorization header
  ADAPTER_SERVICE_API_KEY    The airspace service's API key, if it asks for one (sent as x-api-key)
  The weather and flight restriction services are public and take no secret.
${Object.entries(runnableAdapters)
  .filter(([, runnable]) => runnable.startNotice)
  .map(([id, runnable]) => `\n${id}: ${runnable.startNotice}`)
  .join('')}`;

export class UsageError extends Error {}

/** A public service is sent only a name for this client, which it asks for; nothing about the organization. */
const PUBLIC_SERVICE_USER_AGENT = 'ledger-adapter-host';

function positiveInteger(text: string, name: string, minimum: number, maximum: number): number {
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new UsageError(`${name} is a whole number from ${minimum} to ${maximum}`);
  return parsed;
}

export function parseHostOptions(argv: readonly string[], env: NodeJS.ProcessEnv): HostOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const secretFlag = args.find((arg) =>
    /^--(?:api-)?(?:credential|password|token|secret|api-key|broker-password)(?:=|$)/.test(arg),
  );
  if (secretFlag)
    throw new UsageError(
      `${secretFlag.split('=')[0]} is a secret: give it in the environment (${secretVariables.join(', ')})`,
    );
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        ...Object.fromEntries(Object.values(settings).map((flag) => [flag, { type: 'string' as const }])),
        'private-network': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const flags = parsed.values as Partial<Record<Flag, string>> & { 'private-network'?: boolean };
  const setting = (variable: Variable): string | undefined => {
    const given = flags[settings[variable]] ?? env[variable];
    return given?.trim() ? given.trim() : undefined;
  };
  const required = (variable: Variable): string => {
    const given = setting(variable);
    if (!given) throw new UsageError(`--${settings[variable]} (or ${variable}) is required`);
    return given;
  };
  const secret = (variable: string, purpose: string): string => {
    const given = env[variable];
    if (!given) throw new UsageError(`${variable} is required: ${purpose}`);
    return given;
  };
  const serviceHeaders = (credential: 'bearer' | 'token' | 'none'): Record<string, string> => {
    if (credential === 'none') return { 'user-agent': PUBLIC_SERVICE_USER_AGENT };
    const token = secret('ADAPTER_SERVICE_TOKEN', 'the service’s access token');
    // This service takes the token itself as the header: a scheme word before it would make it another token.
    if (credential === 'token') return { authorization: token };
    const apiKey = env.ADAPTER_SERVICE_API_KEY;
    return { authorization: `Bearer ${token}`, ...(apiKey ? { 'x-api-key': apiKey } : {}) };
  };

  if (parsed.positionals.length > 1) throw new UsageError('Name one adapter');
  const adapterId = parsed.positionals[0] ?? env.LEDGER_ADAPTER?.trim();
  if (!adapterId) throw new UsageError('Name the adapter to run');
  if (!Object.hasOwn(runnableAdapters, adapterId))
    throw new UsageError(
      `${adapterId} is not an adapter this process runs. It runs: ${Object.keys(runnableAdapters).join(', ')}`,
    );
  const runnable = runnableAdapters[adapterId]!;
  const privateNetwork = flags['private-network'] === true || env.ADAPTER_PRIVATE_NETWORK === '1';

  const credential = secret('LEDGER_API_CREDENTIAL', 'the source’s API credential');
  const credentialLabel = required('LEDGER_CREDENTIAL_LABEL');
  const apiUrl = transportUrl(
    required('LEDGER_API_URL'),
    'The API URL',
    { tls: 'https:', plain: 'http:' },
    privateNetwork,
  )
    .toString()
    .replace(/\/$/, '');

  const binding: Partial<Record<BindingOption, string>> = {};
  for (const option of runnable.bindingOptions) {
    const given = required(bindingVariables[option]);
    const problem = bindingProblem(option, given);
    if (problem) throw new UsageError(`--${flagOf(option)}: ${problem}`);
    binding[option] = given;
  }

  let broker: HostOptions['broker'];
  let service: HostOptions['service'];
  if (runnable.transport === 'broker') {
    const password = secret('ADAPTER_BROKER_PASSWORD', 'the broker account’s password');
    broker = {
      url: transportUrl(
        required('ADAPTER_BROKER_URL'),
        'The broker URL',
        { tls: 'mqtts:', plain: 'mqtt:' },
        privateNetwork,
      )
        .toString()
        .replace(/\/$/, ''),
      username: required('ADAPTER_BROKER_USERNAME'),
      password,
    };
  } else {
    const base = transportUrl(
      required('ADAPTER_SERVICE_URL'),
      'The service URL',
      { tls: 'https:', plain: 'http:' },
      privateNetwork,
    );
    const origin = base.toString().replace(/\/$/, '');
    const { lookBack } = runnable;
    const lookBackHours = lookBack
      ? positiveInteger(
          setting('ADAPTER_LOOK_BACK_HOURS') ?? String(lookBack.defaultHours),
          '--look-back-hours',
          1,
          8760,
        )
      : undefined;
    service = {
      url: `${origin}${runnable.path(binding)}`,
      ...(lookBack && lookBackHours
        ? {
            urlAt: (now: Date) =>
              `${origin}${lookBack.path(binding, new Date(now.getTime() - lookBackHours * 3_600_000))}`,
            lookBackHours,
          }
        : {}),
      headers: serviceHeaders(runnable.serviceCredential),
      pollMs:
        positiveInteger(
          setting('ADAPTER_POLL_SECONDS') ?? String(runnable.defaultPollSeconds),
          '--poll-seconds',
          5,
          86_400,
        ) * 1000,
    };
  }
  const sourceId = setting('LEDGER_SOURCE_ID');
  let metrics: MetricsListen | undefined;
  try {
    metrics = metricsListen(setting('LEDGER_METRICS_LISTEN'));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  return {
    adapterId,
    runnable,
    apiUrl,
    credential,
    credentialLabel,
    ...(sourceId ? { sourceId } : {}),
    binding,
    ...(broker ? { broker } : {}),
    ...(service ? { service } : {}),
    queueLimit: positiveInteger(setting('ADAPTER_QUEUE_LIMIT') ?? '10000', '--queue-limit', 1, 1_000_000),
    shutdownMs: positiveInteger(setting('ADAPTER_SHUTDOWN_SECONDS') ?? '10', '--shutdown-seconds', 1, 600) * 1000,
    privateNetwork,
    ...(metrics ? { metrics } : {}),
  };
}
