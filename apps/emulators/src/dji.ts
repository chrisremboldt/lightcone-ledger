import { randomUUID } from 'node:crypto';
import { connect, type MqttClient } from 'mqtt';

export interface DjiEmulatorConfig {
  mqttUrl: string;
  username: string;
  password: string;
  deviceId: string;
  gatewayId: string;
  clientId?: string;
  reconnectPeriodMs?: number;
}
export interface DjiWorldPoint {
  occurredAt: string;
  latitude: number;
  longitude: number;
  height?: number;
  horizontalSpeed?: number;
  modeCode?: number;
  /** Omitted entirely when absent: a message without battery state, never a zero one. */
  battery?: DjiBatteryReport;
  lowBatteryWarningThreshold?: number;
  seriousLowBatteryWarningThreshold?: number;
  windSpeed?: number;
  windDirection?: number;
}
/** One pack as the documented `battery.batteries[]` item. */
export interface DjiBatteryPack {
  capacityPercent: number;
  index?: number;
  sn?: string;
  voltageMillivolts?: number;
  temperatureCelsius?: number;
}
/** The documented `battery` struct. Percentages are integers 0 to 100; remaining flight time is integer seconds. */
export interface DjiBatteryReport {
  capacityPercent: number;
  landingPower?: number;
  returnHomePower?: number;
  remainFlightTimeSeconds?: number;
  batteries?: DjiBatteryPack[];
}
function documentedInteger(value: number, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`DJI ${field} must be an integer from ${min} to ${max}`);
  return value;
}
const percentField = (value: number, field: string) => documentedInteger(value, field, 0, 100);
const optional = <T>(key: string, value: T | undefined, map: (value: T) => unknown = (v) => v) =>
  value === undefined ? {} : { [key]: map(value) };
function batteryPackFields(pack: DjiBatteryPack): Record<string, unknown> {
  return {
    capacity_percent: percentField(pack.capacityPercent, 'batteries[].capacity_percent'),
    ...optional('index', pack.index, (value) => documentedInteger(value, 'batteries[].index')),
    ...optional('sn', pack.sn),
    ...optional('voltage', pack.voltageMillivolts, (value) => documentedInteger(value, 'batteries[].voltage')),
    // Documented as float Celsius with one decimal place retained.
    ...optional('temperature', pack.temperatureCelsius, (value) => Math.round(value * 10) / 10),
  };
}
function batteryFields(battery: DjiBatteryReport): Record<string, unknown> {
  const serials = (battery.batteries ?? []).map((pack) => pack.sn).filter((sn) => sn !== undefined);
  if (new Set(serials).size !== serials.length) throw new Error('DJI battery packs need unique sn values');
  return {
    capacity_percent: percentField(battery.capacityPercent, 'battery.capacity_percent'),
    ...optional('remain_flight_time', battery.remainFlightTimeSeconds, (value) =>
      documentedInteger(value, 'battery.remain_flight_time'),
    ),
    ...optional('return_home_power', battery.returnHomePower, (value) =>
      percentField(value, 'battery.return_home_power'),
    ),
    ...optional('landing_power', battery.landingPower, (value) => percentField(value, 'battery.landing_power')),
    ...optional('batteries', battery.batteries, (packs) => packs.map(batteryPackFields)),
  };
}
export function djiOsdBytes(
  point: DjiWorldPoint,
  gatewayId: string,
  identity: { tid: string; bid: string } = { tid: randomUUID(), bid: randomUUID() },
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      tid: identity.tid,
      bid: identity.bid,
      timestamp: Date.parse(point.occurredAt),
      gateway: gatewayId,
      data: {
        latitude: point.latitude,
        longitude: point.longitude,
        ...(point.height !== undefined ? { height: point.height } : {}),
        ...(point.horizontalSpeed !== undefined ? { horizontal_speed: point.horizontalSpeed } : {}),
        ...(point.modeCode !== undefined ? { mode_code: point.modeCode } : {}),
        ...optional('battery', point.battery, batteryFields),
        ...optional('low_battery_warning_threshold', point.lowBatteryWarningThreshold, (value) =>
          percentField(value, 'low_battery_warning_threshold'),
        ),
        ...optional('serious_low_battery_warning_threshold', point.seriousLowBatteryWarningThreshold, (value) =>
          percentField(value, 'serious_low_battery_warning_threshold'),
        ),
        ...optional('wind_speed', point.windSpeed),
        // Documented as enum_int: 1 true north, 2 northeast, and so on clockwise to 8 northwest.
        ...optional('wind_direction', point.windDirection, (value) => documentedInteger(value, 'wind_direction', 1, 8)),
      },
    }),
  );
}
/** The weather a dock reports in its periodic property message. */
export interface DjiDockWeatherPoint {
  occurredAt: string;
  /** Documented for the second to fourth dock generations as a float in meters per second. */
  windSpeed: number;
  /** Documented as enum_int: 1 true north, 2 northeast, and so on clockwise to 8 northwest. */
  windDirection?: number;
  /** Documented as enum_int: 0 none, 1 light, 2 moderate, 3 heavy. */
  rainfall?: number;
  environmentTemperatureCelsius?: number;
}
export function djiDockOsdBytes(
  point: DjiDockWeatherPoint,
  dockId: string,
  identity: { tid: string; bid: string } = { tid: randomUUID(), bid: randomUUID() },
): Uint8Array {
  if (typeof point.windSpeed !== 'number' || !Number.isFinite(point.windSpeed) || point.windSpeed < 0)
    throw new Error('DJI dock wind_speed must be a non-negative number');
  return new TextEncoder().encode(
    JSON.stringify({
      tid: identity.tid,
      bid: identity.bid,
      timestamp: Date.parse(point.occurredAt),
      // A dock is its own gateway.
      gateway: dockId,
      data: {
        wind_speed: Math.round(point.windSpeed * 10) / 10,
        ...optional('wind_direction', point.windDirection, (value) => documentedInteger(value, 'wind_direction', 1, 8)),
        ...optional('rainfall', point.rainfall, (value) => documentedInteger(value, 'rainfall', 0, 3)),
        ...optional(
          'environment_temperature',
          point.environmentTemperatureCelsius,
          (value) => Math.round(value * 10) / 10,
        ),
      },
    }),
  );
}
export class DjiOsdEmulator {
  private client?: MqttClient;
  connections = 0;
  readonly published: Array<{ bytes: Uint8Array; topic: string }> = [];
  constructor(private config: DjiEmulatorConfig) {
    const url = new URL(config.mqttUrl);
    if (
      !['mqtt:', 'mqtts:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.protocol === 'mqtt:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('DJI emulator MQTT requires explicit credentials and TLS outside loopback');
    if (
      ![config.username, config.password, config.deviceId, config.gatewayId].every(Boolean) ||
      !/^[A-Za-z0-9_-]+$/.test(config.deviceId)
    )
      throw new Error('Explicit DJI emulator binding and credentials required');
  }
  async start(): Promise<void> {
    const client = (this.client = connect(this.config.mqttUrl, {
      protocolVersion: 5,
      clientId: this.config.clientId ?? `ledger-local-dji-device-${this.config.deviceId}`,
      username: this.config.username,
      password: this.config.password,
      clean: false,
      reconnectPeriod: this.config.reconnectPeriodMs ?? 250,
      connectTimeout: 5000,
      properties: { sessionExpiryInterval: 3600 },
    }));
    client.on('error', () => {});
    client.on('connect', () => {
      this.connections++;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DJI emulator broker connection unavailable')), 8000);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('error', () => {
        clearTimeout(timer);
        reject(new Error('DJI emulator broker authentication/transport rejected'));
      });
    }).catch(async (error) => {
      await client.endAsync(true);
      this.client = undefined;
      throw error;
    });
  }
  async publishBytes(bytes: Uint8Array): Promise<void> {
    if (!this.client) throw new Error('DJI emulator must connect before publishing');
    const topic = `thing/product/${this.config.deviceId}/osd`;
    await this.client.publishAsync(topic, Buffer.from(bytes), { qos: 1, retain: false });
    this.published.push({ bytes: bytes.slice(), topic });
  }
  async publish(point: DjiWorldPoint, identity?: { tid: string; bid: string }): Promise<Uint8Array> {
    const bytes = djiOsdBytes(point, this.config.gatewayId, identity);
    await this.publishBytes(bytes);
    return bytes;
  }
  interruptTransport(): void {
    this.client?.stream.destroy();
  }
  async stop(): Promise<void> {
    await this.client?.endAsync(true);
    this.client = undefined;
  }
}

/** A publisher for scripted flights that connects on first use and reconnects after a failed connection. */
export function djiFlightPublisher(config: DjiEmulatorConfig) {
  const emulator = new DjiOsdEmulator(config);
  let connected: Promise<void> | undefined;
  return {
    deviceId: config.deviceId,
    gatewayId: config.gatewayId,
    async publishBytes(bytes: Uint8Array): Promise<void> {
      connected ??= emulator.start().catch((error) => {
        connected = undefined;
        throw error;
      });
      await connected;
      await emulator.publishBytes(bytes);
    },
  };
}

/** Scripted-flight publishing from DJI_EMULATOR_* settings, or undefined when they are not all set. */
export function djiFlightPublisherFromEnv(env: NodeJS.ProcessEnv) {
  const names = ['MQTT_URL', 'MQTT_USERNAME', 'MQTT_PASSWORD', 'DEVICE_ID', 'GATEWAY_ID'] as const;
  const values = names.map((name) => env[`DJI_EMULATOR_${name}`]);
  if (values.some((value) => !value)) return undefined;
  const [mqttUrl, username, password, deviceId, gatewayId] = values as string[];
  return djiFlightPublisher({
    mqttUrl: mqttUrl!,
    username: username!,
    password: password!,
    deviceId: deviceId!,
    gatewayId: gatewayId!,
  });
}
