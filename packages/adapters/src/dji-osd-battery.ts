import type { BatteryStateObservationV1 } from '@ledger/contracts';
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
import type { DjiOsdBinding } from './dji-osd-position.js';

/** SHA-256 of the unmodified upstream Markdown files the battery mapping was read from. */
export const DJI_BATTERY_DOCUMENTATION = [
  {
    reference:
      'DJI Cloud API documentation, dji-sdk/Cloud-API-Doc commit 4ec6b0c7f9472aeb09a0a47949855d19c473ea07: docs/en/60.api-reference/20.dock-to-cloud/00.mqtt/10.aircraft/00.m30-properties.md (aircraft property table: battery, batteries, warning thresholds, wind_speed, wind_direction).',
    sha256: '64269c1fb66ec79f333a23f0a92773ac6c1defdb495350027a56c5b81ddc91b9',
  },
  {
    reference:
      'DJI Cloud API documentation, dji-sdk/Cloud-API-Doc commit 4ec6b0c7f9472aeb09a0a47949855d19c473ea07: docs/en/60.api-reference/20.dock-to-cloud/00.mqtt/10.aircraft/10.m3d-properties.md (the same battery, threshold and wind properties for a second aircraft family).',
    sha256: '466661069d474f4b392934c5ccea27c6aecae49ab22a00c341c810e9fdc2b2ef',
  },
  {
    reference:
      'DJI Cloud API documentation, dji-sdk/Cloud-API-Doc commit 4ec6b0c7f9472aeb09a0a47949855d19c473ea07: docs/en/60.api-reference/20.dock-to-cloud/00.mqtt/00.topic-definition.md (osd topic and message envelope: tid, bid, timestamp, gateway, data).',
    sha256: 'f09b866dfcd3a555af64c66dcdaca16176824e7f6184ac37c92524ae233ffcc2',
  },
] as const;

/**
 * Battery state from the same periodic aircraft state message the position adapter reads. A separate adapter, so
 * each descriptor states only what its own mapping carries. Wind is documented in that message but not mapped:
 * the speed has no documented unit and the direction does not say whether it is where the wind blows from or to.
 */
export const djiOsdBatteryDescriptor: AdapterDescriptor = {
  id: 'dji-cloud-api-osd-battery',
  version: '1.0.0',
  source: {
    vendor: 'DJI',
    product: 'DJI Cloud API',
    interface: 'MQTT device property push on thing/product/{device_sn}/osd',
  },
  produces: [{ type: 'battery.state', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from pinned public documentation of the source’s periodic aircraft state message and exercised only against synthetic samples and an emulator; no bytes from a real aircraft have been checked.',
    'occurredAt is the aircraft’s own clock reading; when Ledger received the message is recorded separately.',
    'All percentages are as reported by the aircraft: its own state-of-charge estimate, not measured energy.',
    'A field that is absent means the aircraft did not report it, not that its value is zero or normal.',
    'The forced-landing and return-home percentages and the remaining flight time are the aircraft’s own running calculations.',
    'The warning thresholds are the levels the user set on the aircraft, not manufacturer or regulatory minimums.',
    'A pack’s slot index is the position number the aircraft gives that pack; which physical bay it denotes is not documented.',
    'The same message may carry an aircraft-estimated wind speed and a coarse wind sector; neither is carried here, because the source documents no unit for the speed and does not say whether the sector is where the wind blows from or to.',
  ],
  documentation: DJI_BATTERY_DOCUMENTATION,
};

const envelopeKeys = ['tid', 'timestamp', 'gateway', 'data'];
const mappedDataKeys = ['battery', 'low_battery_warning_threshold', 'serious_low_battery_warning_threshold'];
const mappedBatteryKeys = ['capacity_percent', 'remain_flight_time', 'return_home_power', 'landing_power', 'batteries'];
const mappedPackKeys = ['capacity_percent', 'index', 'sn', 'voltage', 'temperature'];
const MAX_PACKS = 16;
const MAX_SLOT_INDEX = 15;
// The largest Unix millisecond timestamp whose ISO form still has a four-digit year.
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

type Values = BatteryStateObservationV1['values'];
type Pack = NonNullable<Values['packs']>[number];

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

/** An integer the source documents as a percentage, 0 to 100. Returns undefined when the field is absent. */
function percent(object: Record<string, unknown>, key: string, ...path: (string | number)[]): number | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  const locator = jsonPointer(...path, key);
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Refusal(`${locator.value} must be an integer percentage`, locator);
  if (value < 0 || value > 100) throw new Refusal(`${locator.value} is outside 0 to 100 percent`, locator);
  return value;
}

function boundedNumber(
  object: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number; integer: boolean },
  ...path: (string | number)[]
): number | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  const locator = jsonPointer(...path, key);
  if (typeof value !== 'number' || !Number.isFinite(value) || (bounds.integer && !Number.isInteger(value)))
    throw new Refusal(`${locator.value} must be ${bounds.integer ? 'an integer' : 'a number'}`, locator);
  if (value < bounds.min || value > bounds.max)
    throw new Refusal(`${locator.value} is outside ${bounds.min} to ${bounds.max}`, locator);
  return value;
}

function readPack(item: unknown, position: number): { pack: Pack; unmapped: OriginalLocator[] } {
  const path = ['data', 'battery', 'batteries', position];
  if (!isRecord(item)) throw new Refusal(`${jsonPointer(...path).value} must be an object`, jsonPointer(...path));
  const remainingPercent = percent(item, 'capacity_percent', ...path);
  if (remainingPercent === undefined)
    throw new Refusal(`${jsonPointer(...path).value} has no remaining percentage`, jsonPointer(...path));
  const slotIndex = boundedNumber(item, 'index', { min: 0, max: MAX_SLOT_INDEX, integer: true }, ...path);
  let serialNumber: string | undefined;
  if (Object.hasOwn(item, 'sn')) {
    const value = item.sn;
    if (typeof value !== 'string' || value.length === 0 || value.length > 200)
      throw new Refusal(`${jsonPointer(...path, 'sn').value} must be a non-empty string`, jsonPointer(...path, 'sn'));
    serialNumber = value;
  }
  // voltage is documented as an integer in millivolts: divide by 1000 for volts.
  const millivolts = boundedNumber(item, 'voltage', { min: 0, max: 1_000_000, integer: true }, ...path);
  // temperature is documented in degrees Celsius: the conversion is the identity.
  const celsius = boundedNumber(item, 'temperature', { min: -100, max: 200, integer: false }, ...path);
  return {
    pack: {
      ...(serialNumber === undefined ? {} : { serialNumber }),
      // index is documented as a non-negative integer position: the conversion is the identity.
      ...(slotIndex === undefined ? {} : { slotIndex }),
      remainingPercent,
      ...(millivolts === undefined ? {} : { voltageVolts: millivolts / 1000 }),
      ...(celsius === undefined ? {} : { temperatureCelsius: celsius }),
    },
    unmapped: unknownKeys(item, mappedPackKeys, ...path),
  };
}

function readPacks(battery: Record<string, unknown>): { packs?: Pack[]; unmapped: OriginalLocator[] } {
  if (!Object.hasOwn(battery, 'batteries')) return { unmapped: [] };
  const list = battery.batteries;
  const locator = jsonPointer('data', 'battery', 'batteries');
  if (!Array.isArray(list)) throw new Refusal('/data/battery/batteries must be an array', locator);
  if (list.length > MAX_PACKS) throw new Refusal(`/data/battery/batteries has more than ${MAX_PACKS} packs`, locator);
  const read = list.map(readPack);
  const packs = read.map((entry) => entry.pack);
  for (const key of ['serialNumber', 'slotIndex'] as const) {
    const seen = packs.map((pack) => pack[key]).filter((value) => value !== undefined);
    if (new Set(seen).size !== seen.length)
      throw new Refusal(
        `Two packs in /data/battery/batteries report the same ${key === 'slotIndex' ? 'index' : 'sn'}`,
        locator,
      );
  }
  return { ...(packs.length > 0 ? { packs } : {}), unmapped: read.flatMap((entry) => entry.unmapped) };
}

function readEnvelope(
  message: Parameters<TranslateFunction<DjiOsdBinding>>[0],
  binding: DjiOsdBinding,
): { tid: string; occurredAt: string; body: Record<string, unknown>; data: Record<string, unknown> } {
  const root = jsonPointer();
  if (message.transport.topic !== `thing/product/${binding.deviceId}/osd`)
    throw new Refusal('Topic does not match the bound aircraft’s osd topic', root);
  const decoded = decodeStrictJson(message.bytes, DJI_MESSAGE_MAX_BYTES);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`, root);
  const body = decoded.value;
  if (!isRecord(body)) throw new Refusal('Message body must be a JSON object', root);
  if (body.gateway !== binding.gatewayId) throw new Refusal('gateway does not match the bound gateway', root);
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

function translate(
  message: Parameters<TranslateFunction<DjiOsdBinding>>[0],
  context: Parameters<TranslateFunction<DjiOsdBinding>>[1],
): TranslationResult {
  const { tid, occurredAt, body, data } = readEnvelope(message, context.binding);
  if (!Object.hasOwn(data, 'battery')) throw new Refusal('The message reports no battery state', jsonPointer('data'));
  const battery = data.battery;
  if (!isRecord(battery)) throw new Refusal('/data/battery must be an object', jsonPointer('data', 'battery'));
  // capacity_percent, return_home_power and landing_power are documented as integer percentages 0 to 100.
  const totalRemainingPercent = percent(battery, 'capacity_percent', 'data', 'battery');
  if (totalRemainingPercent === undefined)
    throw new Refusal('/data/battery has no total remaining percentage', jsonPointer('data', 'battery'));
  const returnHome = percent(battery, 'return_home_power', 'data', 'battery');
  const forcedLanding = percent(battery, 'landing_power', 'data', 'battery');
  // remain_flight_time is documented as an integer in seconds: the conversion is the identity.
  const flightSeconds = boundedNumber(
    battery,
    'remain_flight_time',
    { min: 0, max: 1_000_000, integer: true },
    'data',
    'battery',
  );
  // The warning thresholds are documented as user-set integer percentages.
  const lowWarning = percent(data, 'low_battery_warning_threshold', 'data');
  const criticalWarning = percent(data, 'serious_low_battery_warning_threshold', 'data');
  const { packs, unmapped: packUnmapped } = readPacks(battery);
  const subject = subjectFor(context.subjects, 'aircraft', context.binding.deviceId);
  if (!subject) throw new Refusal('No Ledger aircraft is bound to this device', jsonPointer());
  return {
    drafts: [
      {
        type: 'battery.state',
        version: 1,
        subject,
        occurredAt,
        sourceEventId: tid,
        originalLocator: jsonPointer('data'),
        values: {
          totalRemainingPercent,
          ...(packs === undefined ? {} : { packs }),
          ...(forcedLanding === undefined ? {} : { forcedLandingRemainingPercent: forcedLanding }),
          ...(returnHome === undefined ? {} : { returnHomeRemainingPercent: returnHome }),
          ...(flightSeconds === undefined ? {} : { remainingFlightTimeSeconds: flightSeconds }),
          ...(lowWarning === undefined ? {} : { lowWarningThresholdPercent: lowWarning }),
          ...(criticalWarning === undefined ? {} : { criticalWarningThresholdPercent: criticalWarning }),
        },
      },
    ],
    rejections: [],
    unmapped: [
      ...unknownKeys(body, envelopeKeys),
      ...unknownKeys(data, mappedDataKeys, 'data'),
      ...unknownKeys(battery, mappedBatteryKeys, 'data', 'battery'),
      ...packUnmapped,
    ],
  };
}

export const translateDjiOsdBattery: TranslateFunction<DjiOsdBinding> = (message, context) => {
  try {
    return translate(message, context);
  } catch (error) {
    if (error instanceof Refusal)
      return error.locator.value === '' ? rejected(error.message) : rejected(error.message, error.locator);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const djiOsdBatteryAdapter: ObservationAdapter<DjiOsdBinding> = {
  descriptor: djiOsdBatteryDescriptor,
  translate: translateDjiOsdBattery,
};
