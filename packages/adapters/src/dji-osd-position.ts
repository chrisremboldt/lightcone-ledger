import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type TranslateFunction,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';
import { decodeDjiOsd, DJI_DOCUMENTATION_DIGEST } from './dji-osd.js';

export interface DjiOsdBinding {
  readonly deviceId: string;
  readonly gatewayId: string;
}

/** The reference adapter on the contract: one periodic aircraft state message becomes one position.fix@1. */
export const djiOsdPositionDescriptor: AdapterDescriptor = {
  id: 'dji-cloud-api-osd-position',
  version: '1.0.0',
  source: {
    vendor: 'DJI',
    product: 'DJI Cloud API',
    interface: 'MQTT device property push on thing/product/{device_sn}/osd',
  },
  produces: [{ type: 'position.fix', version: 1 }],
  fidelity: 'synthetic_contract',
  limitations: [
    'Built from pinned public documentation of a selected subset of the source’s periodic aircraft state message; not checked against a complete published schema or a real aircraft.',
    'occurredAt is the aircraft’s own clock reading; when Ledger received the message is recorded separately.',
    'Altitude is height above the WGS84 ellipsoid as the source documents it, not height above the takeoff point or the ground. Coordinates are read as WGS84 pending validation against a real aircraft.',
    'Ground speed is the source’s horizontal speed, which its documentation states in meters per second.',
    'The fields read carry no fix quality, so fix is unknown.',
    'The source numbers no messages, so a gap between fixes does not show that messages were lost.',
  ],
  documentation: [
    {
      reference:
        'DJI Cloud API documentation: device properties pushed on the osd topic, with the M30 series unit table (pinned official Markdown).',
      sha256: DJI_DOCUMENTATION_DIGEST,
    },
  ],
};

// bid (the source's business correlation id) is not carried, so it is reported as unmapped.
const envelopeKeys = ['tid', 'timestamp', 'gateway', 'data'];
const mappedDataKeys = ['latitude', 'longitude', 'height', 'horizontal_speed'];

export const translateDjiOsdPosition: TranslateFunction<DjiOsdBinding> = (message, context) => {
  const topic = message.transport.topic;
  if (topic === undefined) return rejected('Message has no MQTT topic');
  let sample;
  try {
    // The decoder checks topic and gateway binding, strict JSON, bounds and units. Its capture sequence
    // belongs to the telemetry-segment path and is not used here.
    sample = decodeDjiOsd(topic, message.bytes, context.binding, 1);
  } catch (error) {
    return rejected((error as Error).message);
  }
  // decodeDjiOsd has already rejected malformed or ambiguous JSON, so a plain parse reads the same value.
  const body = JSON.parse(new TextDecoder().decode(message.bytes)) as {
    tid: string;
    data: Record<string, unknown>;
  } & Record<string, unknown>;
  const subject = subjectFor(context.subjects, 'aircraft', context.binding.deviceId);
  if (!subject) return rejected('No Ledger aircraft is bound to this device');
  return {
    drafts: [
      {
        type: 'position.fix',
        version: 1,
        subject,
        occurredAt: sample.occurredAt,
        sourceEventId: body.tid,
        position: {
          latitudeDegrees: sample.latitude,
          longitudeDegrees: sample.longitude,
          // The decoder reads height as ellipsoid height in meters, the unit its documentation states.
          ...(sample.altitudeMeters === null
            ? {}
            : { altitude: { meters: sample.altitudeMeters, datum: 'wgs84_ellipsoid' as const } }),
        },
        originalLocator: jsonPointer('data'),
        values: {
          fix: 'unknown',
          // horizontal_speed is documented in meters per second: the conversion is the identity.
          ...(sample.speedMetersPerSecond === undefined
            ? {}
            : { groundSpeedMetersPerSecond: sample.speedMetersPerSecond }),
        },
      },
    ],
    rejections: [],
    unmapped: [...unknownKeys(body, envelopeKeys), ...unknownKeys(body.data, mappedDataKeys, 'data')],
  };
};

export const djiOsdPositionAdapter: ObservationAdapter<DjiOsdBinding> = {
  descriptor: djiOsdPositionDescriptor,
  translate: translateDjiOsdPosition,
};
