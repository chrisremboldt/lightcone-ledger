import {
  airspaceAuthorizationAdapter,
  djiDockModels,
  djiDockWindAdapter,
  djiOsdBatteryAdapter,
  djiOsdPositionAdapter,
  jsonArrayElements,
  parseMetarStations,
  parseRestrictionRegions,
  publishedMetarAdapter,
  publishedTafAdapter,
  publishedTfrAdapter,
  restrictionListItems,
  SKYDIO_CLOUD_START_NOTICE,
  skydioCloudFlightsAdapter,
  skydioCloudFlightsPoll,
  type DeliveryKind,
  type ListedItem,
  type ObservationAdapter,
  type Receive,
  type SourceLoopEvent,
  type SubjectNaming,
} from '@ledger/adapters';
import { flightHub2Flights, pointTimesProblem } from './flighthub2.js';

/** The source settings an adapter is bound by, given as flags or environment variables. */
export type BindingOption =
  | 'device'
  | 'gateway'
  | 'dock'
  | 'site'
  | 'dockModel'
  | 'operation'
  | 'flight'
  | 'stations'
  | 'regions'
  | 'project'
  | 'pointTimes';
export type BindingValues = Readonly<Partial<Record<BindingOption, string>>>;

interface Common {
  /** The adapter exactly as registered in packages/adapters. */
  readonly adapter: ObservationAdapter<never>;
  readonly delivery: DeliveryKind;
  readonly bindingOptions: readonly BindingOption[];
  binding(values: BindingValues): unknown;
  subjects(values: BindingValues): SubjectNaming;
  /**
   * Observation types of which the source keeps one changing record per subject: before one is submitted, what is
   * on file about its subject is read, and a changed one replaces it. The credential then also needs evidence:read.
   */
  readonly oneCurrentPerSubject?: readonly string[];
  /** A sentence the process prints in its first line, for an adapter a person must test before relying on it. */
  readonly startNotice?: string;
}
export interface BrokerAdapter extends Common {
  readonly transport: 'broker';
  topic(values: BindingValues): string;
}
export interface PollAdapter extends Common {
  readonly transport: 'poll';
  /** The path, and query when the service takes one, read on each poll. */
  path(values: BindingValues): string;
  readonly defaultPollSeconds: number;
  /**
   * bearer: the service takes an access token (ADAPTER_SERVICE_TOKEN) as a bearer token. token: it takes the token
   * as the whole Authorization header, with no scheme word. none: it is public and takes none. header: it takes the
   * token in a header of its own.
   */
  readonly serviceCredential: 'bearer' | 'token' | 'none' | { readonly header: string };
  /** Cuts a response into the messages it holds; each poll then hands over only those not in the previous one. */
  readonly split?: (bytes: Uint8Array) => Uint8Array[] | undefined;
  /** What a part is known by from one poll to the next; default the digest of its bytes. */
  readonly partKey?: (part: Uint8Array) => string;
  /** Reads a response as a list of items, each read at its own path and handed over as its own message. */
  readonly follow?: (bytes: Uint8Array) => readonly ListedItem[] | undefined;
  /** Cuts a followed item's response down to the part that is handed over. */
  readonly followedPart?: (bytes: Uint8Array) => Uint8Array | undefined;
  /** The path and query of a list's next page, or undefined at the last. */
  readonly nextPage?: (bytes: Uint8Array, url: string) => string | undefined;
  /** The largest response read, in bytes; default 1 MiB. */
  readonly maxBytes?: number;
  /**
   * With it, each poll asks for what began in the hours before it (--look-back-hours): the path and query are built
   * again for every poll, and `path` only names what is read.
   */
  readonly lookBack?: { readonly defaultHours: number; path(values: BindingValues, since: Date): string };
  /**
   * A source that one read of a list and its items cannot cover brings its own transport, which the process starts
   * in place of the shared poll, with the same settings.
   */
  readonly source?: (values: BindingValues, reads: SourceReads, receive: Receive) => SourceTransport;
}
/** The settings the process gives a transport an adapter brings itself. */
export interface SourceReads {
  /** The service's address with the adapter's path. */
  readonly url: string;
  /** Sent with each request. They hold secrets and are never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs: number;
  readonly lookBackHours?: number;
  readonly log: (event: SourceLoopEvent) => void;
  readonly fetcher?: typeof fetch;
}
/** What the process starts and stops to receive a source's messages. */
export interface SourceTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
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
    serviceCredential: 'bearer',
  },
  [publishedMetarAdapter.descriptor.id]: {
    adapter: publishedMetarAdapter as ObservationAdapter<never>,
    transport: 'poll',
    // A station's newer report supersedes its older one.
    delivery: 'latest',
    bindingOptions: ['stations'],
    binding: (values) => parseMetarStations(value(values, 'stations')),
    subjects: () => sourceNames,
    path: (values) =>
      `/api/data/metar?ids=${Object.keys(parseMetarStations(value(values, 'stations')).stations)
        .sort()
        .join(',')}&format=json`,
    // Stations report about once an hour, and specially between; the service asks clients to poll sparingly.
    defaultPollSeconds: 300,
    serviceCredential: 'none',
    split: jsonArrayElements,
  },
  [publishedTafAdapter.descriptor.id]: {
    adapter: publishedTafAdapter as ObservationAdapter<never>,
    transport: 'poll',
    // Each forecast is kept: a newer one, or an amendment, is another record of what was forecast.
    delivery: 'every',
    bindingOptions: ['stations'],
    binding: (values) => parseMetarStations(value(values, 'stations')),
    subjects: () => sourceNames,
    path: (values) =>
      `/api/data/taf?ids=${Object.keys(parseMetarStations(value(values, 'stations')).stations)
        .sort()
        .join(',')}&format=json`,
    // Forecasts are issued about every six hours and amended between.
    defaultPollSeconds: 900,
    serviceCredential: 'none',
    split: jsonArrayElements,
  },
  [publishedTfrAdapter.descriptor.id]: {
    adapter: publishedTfrAdapter as ObservationAdapter<never>,
    transport: 'poll',
    // Each restriction is its own notice: none is dropped.
    delivery: 'every',
    bindingOptions: ['regions'],
    binding: (values) => parseRestrictionRegions(value(values, 'regions')),
    subjects: () => sourceNames,
    path: () => '/tfrapi/exportTfrList',
    // The list changes a few times an hour; each new entry's document is read once.
    defaultPollSeconds: 600,
    serviceCredential: 'none',
    follow: restrictionListItems,
  },
  [skydioCloudFlightsAdapter.descriptor.id]: {
    adapter: skydioCloudFlightsAdapter as ObservationAdapter<never>,
    transport: 'poll',
    // A flight and its telemetry are records: none is dropped.
    delivery: 'every',
    bindingOptions: [],
    binding: () => undefined,
    subjects: () => sourceNames,
    path: () => '/api/v0/flights',
    // A flight that took off days ago can still change in the list, or have its telemetry uploaded.
    lookBack: { defaultHours: 168, path: (_values, since) => skydioCloudFlightsPoll.path(since) },
    // The service limits requests and does not publish the limit: two minutes is 720 reads of the list a day.
    defaultPollSeconds: 120,
    serviceCredential: 'token',
    split: skydioCloudFlightsPoll.split,
    partKey: skydioCloudFlightsPoll.partKey,
    follow: skydioCloudFlightsPoll.follow,
    followedPart: skydioCloudFlightsPoll.followedPart,
    nextPage: skydioCloudFlightsPoll.nextPage,
    maxBytes: skydioCloudFlightsPoll.maxBytes,
    // The service keeps one record of a flight and changes it when the aircraft lands or the record is corrected.
    oneCurrentPerSubject: ['flight.report'],
    startNotice: SKYDIO_CLOUD_START_NOTICE,
  },
  [flightHub2Flights.adapter.descriptor.id]: flightHub2Flights,
};

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/** Why a binding value cannot be used, or undefined. */
export function bindingProblem(name: BindingOption, given: string): string | undefined {
  if (name === 'regions')
    try {
      parseRestrictionRegions(given);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  if (name === 'pointTimes') return pointTimesProblem(given);
  if (name === 'stations')
    try {
      parseMetarStations(given);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
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
