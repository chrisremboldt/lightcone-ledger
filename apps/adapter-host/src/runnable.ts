import {
  airspaceAuthorizationAdapter,
  djiDockModels,
  djiDockWindAdapter,
  djiOsdBatteryAdapter,
  djiOsdPositionAdapter,
  type DeliveryKind,
  type ObservationAdapter,
  type SubjectNaming,
} from '@ledger/adapters';

/** The source settings an adapter is bound by, given as flags or environment variables. */
export type BindingOption = 'device' | 'gateway' | 'dock' | 'site' | 'dockModel' | 'operation' | 'flight';
export type BindingValues = Readonly<Partial<Record<BindingOption, string>>>;

interface Common {
  /** The adapter exactly as registered in packages/adapters. */
  readonly adapter: ObservationAdapter<never>;
  readonly delivery: DeliveryKind;
  readonly bindingOptions: readonly BindingOption[];
  binding(values: BindingValues): unknown;
  subjects(values: BindingValues): SubjectNaming;
}
export interface BrokerAdapter extends Common {
  readonly transport: 'broker';
  topic(values: BindingValues): string;
}
export interface PollAdapter extends Common {
  readonly transport: 'poll';
  path(values: BindingValues): string;
  readonly defaultPollSeconds: number;
}
export type RunnableAdapter = BrokerAdapter | PollAdapter;

const value = (values: BindingValues, name: BindingOption): string => values[name]!;
const sourceNames: SubjectNaming = { scope: 'source' };

const aircraftTelemetry = {
  transport: 'broker',
  // Periodic state: a newer message supersedes an older one.
  delivery: 'latest',
  bindingOptions: ['device', 'gateway'],
  binding: (values: BindingValues) => ({ deviceId: value(values, 'device'), gatewayId: value(values, 'gateway') }),
  subjects: () => sourceNames,
  topic: (values: BindingValues) => `thing/product/${value(values, 'device')}/osd`,
} as const;

/**
 * The shipped adapters a process can run, by their registered id, with the transport each one's source uses. The
 * command-link and crew-roster adapters receive an HTTP callback and an uploaded file, which this process does not
 * take.
 */
export const runnableAdapters: Readonly<Record<string, RunnableAdapter>> = {
  [djiOsdPositionAdapter.descriptor.id]: {
    adapter: djiOsdPositionAdapter as ObservationAdapter<never>,
    ...aircraftTelemetry,
  },
  [djiOsdBatteryAdapter.descriptor.id]: {
    adapter: djiOsdBatteryAdapter as ObservationAdapter<never>,
    ...aircraftTelemetry,
  },
  [djiDockWindAdapter.descriptor.id]: {
    adapter: djiDockWindAdapter as ObservationAdapter<never>,
    transport: 'broker',
    delivery: 'latest',
    bindingOptions: ['dock', 'site', 'dockModel'],
    binding: (values) => ({
      dockId: value(values, 'dock'),
      siteId: value(values, 'site'),
      dockModel: value(values, 'dockModel'),
    }),
    subjects: () => sourceNames,
    topic: (values) => `thing/product/${value(values, 'dock')}/osd`,
  },
  [airspaceAuthorizationAdapter.descriptor.id]: {
    adapter: airspaceAuthorizationAdapter as ObservationAdapter<never>,
    transport: 'poll',
    // A change of an authorization's status is an event: none is dropped.
    delivery: 'every',
    bindingOptions: ['operation', 'flight'],
    binding: (values) => ({ flightId: value(values, 'flight') }),
    subjects: (values) => ({
      scope: 'ledger',
      ids: { flight: { [value(values, 'flight')]: value(values, 'flight') } },
    }),
    path: (values) => `/v1/operations/${encodeURIComponent(value(values, 'operation'))}/laanc`,
    defaultPollSeconds: 60,
  },
};

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/** Why a binding value cannot be used, or undefined. */
export function bindingProblem(name: BindingOption, given: string): string | undefined {
  // The adapter refuses the first-generation dock's wind; a process bound to one would submit nothing.
  if (name === 'dockModel')
    return djiDockModels.filter((model) => model !== 'dock1').includes(given as never)
      ? undefined
      : `the dock model is dock2, dock3 or dock4 (the first-generation dock's wind is not translated)`;
  if (name === 'site' || name === 'flight')
    return given.length >= 1 && given.length <= 200 && given === given.trim()
      ? undefined
      : `the ${name} is an id of 1 to 200 characters`;
  return IDENTIFIER.test(given)
    ? undefined
    : `the ${name} is 1 to 128 letters, digits, hyphens or underscores (no topic separators or wildcards)`;
}
