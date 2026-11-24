import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type OriginalLocator,
  type TranslateFunction,
  type TranslationResult,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';
import { DJI_MESSAGE_MAX_BYTES } from './dji-osd.js';
import { DJI_BATTERY_DOCUMENTATION } from './dji-osd-battery.js';

/** The dock models the source documents. The periodic message does not say which one sent it. */
export const djiDockModels = ['dock1', 'dock2', 'dock3', 'dock4'] as const;
export type DjiDockModel = (typeof djiDockModels)[number];

/** Dock models whose documentation states the wind speed in metres per second. */
const measuredWindModels: readonly DjiDockModel[] = ['dock2', 'dock3', 'dock4'];

export interface DjiDockBinding {
  /** The dock's serial number: its osd topic and the gateway its messages name. */
  readonly dockId: string;
  /** The site the dock stands at, which the wind is reported for. */
  readonly siteId: string;
  /** Required to translate wind; configuration, because the message does not carry it. */
  readonly dockModel?: DjiDockModel;
}

/**
 * Measured wind from the dock's periodic property message. Only the docks whose documentation states metres per
 * second are translated: the first-generation dock's two official sources disagree on the scale, and the
 * aircraft's own wind estimate is a different message this adapter does not read.
 */
export const djiDockWindDescriptor: AdapterDescriptor = {
  id: 'dji-cloud-api-dock-wind',
  version: '1.0.0',
  source: {
    vendor: 'DJI',
    product: 'DJI Cloud API',
    interface: 'MQTT dock property push on thing/product/{dock_sn}/osd',
  },
  produces: [{ type: 'weather.wind', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from public documentation of the source’s periodic dock property message and exercised only against synthetic samples and an emulator; no bytes from a real dock have been checked.',
    'occurredAt is the dock’s own clock reading; when Ledger received the message is recorded separately.',
    'The wind is measured by the dock’s own sensor where the dock stands, at the dock’s height. It is not the wind at the aircraft or at the height flown. The subject is the site the adapter is configured to place the dock at.',
    'The speed is the value the dock reports, which its documentation states in meters per second, with no averaging period; gusts are not reported.',
    'The message does not say which dock model sent it; the model is the adapter’s configuration, and wind is translated only for the models whose documentation states meters per second. The first-generation model’s two official sources disagree on the scale, so its wind is refused.',
    'The direction is reported as one of eight compass sectors; it is not carried, because this observation records a direction in degrees and a sector is not one.',
  ],
  documentation: [
    {
      reference:
        'DJI Cloud API documentation (developer.dji.com/doc/cloud-api-tutorial), dock property pages for the second, third and fourth dock generations: wind_speed as a float in meters per second, wind_direction as an eight-sector enumeration. Not pinned by digest.',
    },
    DJI_BATTERY_DOCUMENTATION[2],
  ],
};

const envelopeKeys = ['tid', 'timestamp', 'gateway', 'data'];
const mappedDataKeys = ['wind_speed'];
// The largest wind speed weather.wind accepts.
const MAX_WIND_METERS_PER_SECOND = 150;
// The largest Unix millisecond timestamp whose ISO form still has a four-digit year.
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

class Refusal extends Error {
  constructor(
    reason: string,
    readonly locator: OriginalLocator,
  ) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readEnvelope(
  message: Parameters<TranslateFunction<DjiDockBinding>>[0],
  binding: DjiDockBinding,
): { tid: string; occurredAt: string; body: Record<string, unknown>; data: Record<string, unknown> } {
  const root = jsonPointer();
  if (message.transport.topic !== `thing/product/${binding.dockId}/osd`)
    throw new Refusal('Topic does not match the bound dock’s osd topic', root);
  const decoded = decodeStrictJson(message.bytes, DJI_MESSAGE_MAX_BYTES);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`, root);
  const body = decoded.value;
  if (!isRecord(body)) throw new Refusal('Message body must be a JSON object', root);
  // A dock is its own gateway.
  if (body.gateway !== binding.dockId) throw new Refusal('gateway does not match the bound dock', root);
  if (typeof body.tid !== 'string' || body.tid.length === 0 || body.tid.length > 200)
    throw new Refusal('tid must be a non-empty string', root);
  const timestamp = body.timestamp;
  if (
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_TIMESTAMP_MS
  )
    throw new Refusal('timestamp must be Unix milliseconds', root);
  if (!isRecord(body.data)) throw new Refusal('data must be an object', root);
  return { tid: body.tid, occurredAt: new Date(timestamp).toISOString(), body, data: body.data };
}

function requireWindModel(binding: DjiDockBinding, locator: OriginalLocator): void {
  const model = binding.dockModel;
  if (model === undefined || !djiDockModels.includes(model))
    throw new Refusal('The dock model is not configured; wind is not translated without it', locator);
  if (!measuredWindModels.includes(model))
    throw new Refusal(
      'Wind from a first-generation dock is not translated: its two official sources disagree on the scale of wind_speed, pending real device data',
      locator,
    );
}

function translate(
  message: Parameters<TranslateFunction<DjiDockBinding>>[0],
  context: Parameters<TranslateFunction<DjiDockBinding>>[1],
): TranslationResult {
  const { tid, occurredAt, body, data } = readEnvelope(message, context.binding);
  const locator = jsonPointer('data', 'wind_speed');
  if (!Object.hasOwn(data, 'wind_speed')) throw new Refusal('The message reports no wind speed', jsonPointer('data'));
  requireWindModel(context.binding, locator);
  const speed = data.wind_speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed))
    throw new Refusal('/data/wind_speed must be a number', locator);
  if (speed < 0 || speed > MAX_WIND_METERS_PER_SECOND)
    throw new Refusal(`/data/wind_speed is outside 0 to ${MAX_WIND_METERS_PER_SECOND}`, locator);
  const subject = subjectFor(context.subjects, 'site', context.binding.siteId);
  if (!subject) throw new Refusal('No Ledger site is bound to this dock', jsonPointer());
  return {
    drafts: [
      {
        type: 'weather.wind',
        version: 1,
        subject,
        occurredAt,
        sourceEventId: tid,
        originalLocator: jsonPointer('data'),
        // wind_speed is documented in meters per second for these models: the conversion is the identity.
        values: { method: 'measured', speedMetersPerSecond: speed },
      },
    ],
    rejections: [],
    unmapped: [...unknownKeys(body, envelopeKeys), ...unknownKeys(data, mappedDataKeys, 'data')],
  };
}

export const translateDjiDockWind: TranslateFunction<DjiDockBinding> = (message, context) => {
  try {
    return translate(message, context);
  } catch (error) {
    if (error instanceof Refusal)
      return error.locator.value === '' ? rejected(error.message) : rejected(error.message, error.locator);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const djiDockWindAdapter: ObservationAdapter<DjiDockBinding> = {
  descriptor: djiDockWindDescriptor,
  translate: translateDjiDockWind,
};
