import { sha256 } from '@ledger/integrity';
import type { ObservationPosition, VisibilityObservationV1, WindObservationV1 } from '@ledger/contracts';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type TranslateFunction,
  type TranslationRejection,
  type TranslationResult,
  decodeStrictJson,
  jsonPointer,
  rejected,
  subjectFor,
  unknownKeys,
} from './adapter-contract.js';

/** One of the organization's sites a station reports for, with how far the station is from it when known. */
export interface MetarStationSite {
  readonly siteId: string;
  /** Configuration: the station-to-site distance the organization states. Absent: not on record. */
  readonly distanceMeters?: number;
}

export interface MetarBinding {
  /** Station identifier (four letters or digits, as the report states it) to the sites it reports for. */
  readonly stations: Readonly<Record<string, readonly MetarStationSite[]>>;
}

/**
 * Published aviation routine weather reports (METAR and SPECI) read from the report text: the wind, its direction
 * range and the prevailing visibility, each about every site the station is configured to report for.
 */
export const publishedMetarDescriptor: AdapterDescriptor = {
  id: 'published-metar-observations',
  version: '1.0.0',
  source: {
    vendor: 'NOAA National Weather Service',
    product: 'Aviation Weather Center data API',
    interface: 'HTTPS GET /api/data/metar?ids={stations}&format=json, one report object of the JSON array per message',
  },
  produces: [
    { type: 'weather.wind', version: 1 },
    { type: 'weather.visibility', version: 1 },
  ],
  fidelity: 'captured_source_replay',
  limitations: [
    'Built from the service’s published interface and the report code, and checked against reports fetched from the live service on 2026-11-25; not checked against a long-running poll, the service’s rate limits or an outage.',
    'occurredAt is the observation time the report states as day of month, hour and minute in UTC. The month and year are those of the fetch, or of the month before when the day is later than the fetch day.',
    'The values are the station’s, measured or observed where the station stands, not at the site and not along a flight path. Each observation names the station and, when the configuration states it, how far the station is from the site. Nothing is interpolated between stations, and no station is chosen as the nearest.',
    'Only the report text is read: the wind group, the wind direction range and the prevailing visibility. Cloud, weather, temperature, pressure, runway and remark groups, and the values the service decodes beside the text, are not read; they stay in the retained report.',
    'Wind in knots is converted at 1852 meters per nautical mile; wind in meters per second is carried as stated. The speed is an average over a period the station’s practice sets, at the height of the station’s sensor; the report states neither.',
    'A calm wind (00000) is carried as speed 0 with no direction. A variable direction (VRB) is carried as directionVariable with no direction. A direction of 360 is carried as 0, the same direction.',
    'The gust is the peak the report states. A report without a gust says nothing about gusts.',
    'Visibility in statute miles is converted at 1609.344 meters per mile. 9999 and CAVOK are carried as at least 10000 m, 0000 as less than 50 m, a value marked M as less than and one marked P as at least the value. Reports from the United States state at most 10 statute miles, so a stated 10 may have been more.',
    'The visibility is the prevailing visibility the station reports, not the visibility from a control station or in a direction the report qualifies separately.',
    'A group that cannot be read is reported as not read, with its text, and no value is carried for it. A report marked NIL is not translated.',
    'The position is the station’s location as the service lists it beside the report, not the site’s. stationId names the station; stationDistanceMeters is the distance the configuration states, when it states one.',
    'A corrected report (COR) is carried as another observation; it does not replace the report it corrects.',
  ],
  documentation: [
    {
      reference:
        'Aviation Weather Center data API, OpenAPI document version v4.0 (aviationweather.gov/data/schema/openapi.yaml), fetched 2026-11-25: METARproperties, rawOb as the raw text of the observation.',
      sha256: '51fe8bfd7fead5085aae9bba62aeaa0c287a836712b77f3c05f3915570465ec2',
    },
    {
      reference:
        'The METAR and SPECI report code: WMO Manual on Codes (WMO-No. 306), FM 15 and FM 16, and the Federal Meteorological Handbook No. 1 for reports from the United States. Not pinned by digest.',
    },
  ],
};

const MESSAGE_MAX_BYTES = 64 * 1024;
const REPORT_MAX_CHARACTERS = 2000;
const mappedKeys = ['icaoId', 'rawOb', 'lat', 'lon'];
const STATUTE_MILE_METERS = 1609.344;
const MAX_WIND_METERS_PER_SECOND = 150;
const MAX_VISIBILITY_METERS = 100_000;
// A report stamped later than this after its fetch is not rolled to another month: it is refused.
const MAX_AHEAD_OF_FETCH_MS = 3_600_000;
const STATION = /^[A-Z][A-Z0-9]{3}$/;

type WindValues = WindObservationV1['values'];
type VisibilityValues = VisibilityObservationV1['values'];

/** A group read, or the reason it was not, with the group's text. */
export type GroupReading<Values> =
  { readonly values: Values; readonly notes: readonly string[] } | { readonly notRead: string };

export interface MetarReading {
  readonly station: string;
  /** METAR or SPECI, when the text states it. */
  readonly reportType?: 'METAR' | 'SPECI';
  readonly timeGroup: string;
  readonly occurredAt: string;
  readonly corrected: boolean;
  readonly automated: boolean;
  readonly wind: GroupReading<WindValues>;
  readonly visibility: GroupReading<VisibilityValues>;
}

/** Why a whole report cannot be read. */
export class MetarRefusal extends Error {}

/** The observation time: day, hour and minute from the report, month and year from the fetch (see the limitation). */
export function metarTime(group: string, capturedAt: string): string {
  const match = /^(\d{2})(\d{2})(\d{2})Z$/.exec(group);
  if (!match) throw new MetarRefusal(`The report time group ${group} could not be read`);
  const [day, hour, minute] = match.slice(1).map(Number) as [number, number, number];
  if (day < 1 || day > 31 || hour > 23 || minute > 59)
    throw new MetarRefusal(`The report time group ${group} is not a day, hour and minute`);
  const fetched = Date.parse(capturedAt);
  if (!Number.isFinite(fetched)) throw new MetarRefusal('The time the report was fetched is not a time');
  const fetchedAt = new Date(fetched);
  const month = fetchedAt.getUTCMonth() - (day > fetchedAt.getUTCDate() ? 1 : 0);
  const time = new Date(Date.UTC(fetchedAt.getUTCFullYear(), month, day, hour, minute));
  if (time.getUTCDate() !== day)
    throw new MetarRefusal(`The report time group ${group} names a day the month before the fetch does not have`);
  if (time.getTime() - fetched > MAX_AHEAD_OF_FETCH_MS)
    throw new MetarRefusal(`The report time group ${group} is more than an hour after the report was fetched`);
  return time.toISOString();
}

const direction = (degrees: number): number => (degrees === 360 ? 0 : degrees);

/** The wind group, such as 06018G25KT, VRB03KT, 00000KT, 33007G15MPS or /////KT. */
export function readWindGroup(group: string): GroupReading<WindValues> {
  if (/^\/{5}(KT|MPS)?$/.test(group)) return { notRead: `The station reported no wind (${group})` };
  const match = /^(\d{3}|VRB|\/{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(group);
  if (!match) return { notRead: `The wind group ${group} could not be read` };
  const [, from, speedText, gustText, unit] = match as unknown as [string, string, string, string | undefined, string];
  // Knots convert at 1852 m per nautical mile; meters per second are the identity.
  const toMetersPerSecond = (value: number) => (unit === 'KT' ? (value * 1852) / 3600 : value);
  const speed = Number(speedText);
  const gust = gustText === undefined ? undefined : Number(gustText);
  const notes: string[] = [];
  const values: { -readonly [Key in keyof WindValues]: WindValues[Key] } = {
    method: 'measured',
    speedMetersPerSecond: toMetersPerSecond(speed),
  };
  if (gust !== undefined) {
    if (gust <= speed) return { notRead: `The wind group ${group} states a gust no higher than the speed` };
    values.gustSpeedMetersPerSecond = toMetersPerSecond(gust);
  }
  if ((values.gustSpeedMetersPerSecond ?? values.speedMetersPerSecond) > MAX_WIND_METERS_PER_SECOND)
    return { notRead: `The wind group ${group} states a speed above ${MAX_WIND_METERS_PER_SECOND} m/s` };
  if (from === 'VRB') values.directionVariable = true;
  else if (from === '///') notes.push(`The station did not report the wind direction (${group}).`);
  else {
    const degrees = Number(from);
    if (degrees > 360) return { notRead: `The wind group ${group} states a direction above 360 degrees` };
    if ((degrees === 0) !== (speed === 0))
      return {
        notRead: `The wind group ${group} states a direction of 000 with a speed, or a speed of 0 with a direction`,
      };
    if (speed > 0) values.directionFromDegrees = direction(degrees);
  }
  return { values, notes };
}

/** The direction range group, such as 010V080, added to a wind already read. */
export function readDirectionRange(group: string, wind: WindValues): GroupReading<WindValues> {
  const match = /^(\d{3})V(\d{3})$/.exec(group);
  const [from, to] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!match || from > 360 || to > 360 || direction(from) === direction(to))
    return { notRead: `The wind direction range ${group} could not be read` };
  return {
    values: { ...wind, directionVariesFromDegrees: direction(from), directionVariesToDegrees: direction(to) },
    notes: [],
  };
}

const miles = (value: number) => value * STATUTE_MILE_METERS;

function fraction(numerator: string, denominator: string): number | undefined {
  const [top, bottom] = [Number(numerator), Number(denominator)];
  return [2, 4, 8, 16].includes(bottom) && top >= 1 && top < bottom ? top / bottom : undefined;
}

/**
 * The prevailing visibility: CAVOK, metres (1800, 9999, 0000, 4000NDV), or statute miles (10SM, 1/2SM, M1/4SM,
 * P6SM, and a whole number followed by a fraction, 2 1/2SM, which is two groups). Returns how many groups it used.
 */
export function readVisibilityGroups(groups: readonly string[]): {
  reading: GroupReading<VisibilityValues>;
  used: number;
} {
  const [first, second] = groups;
  const observed = (visibilityMeters: number, bound: VisibilityValues['bound'], used = 1) => ({
    reading:
      visibilityMeters > MAX_VISIBILITY_METERS
        ? {
            notRead: `The visibility group ${groups.slice(0, used).join(' ')} states more than ${MAX_VISIBILITY_METERS} m`,
          }
        : { values: { method: 'observed' as const, visibilityMeters, bound }, notes: [] },
    used,
  });
  if (first === undefined) return { reading: { notRead: 'The report ends before its visibility group' }, used: 0 };
  if (first === 'CAVOK') return observed(10_000, 'at_least');
  if (/^\/{4}(SM)?$/.test(first))
    return { reading: { notRead: `The station reported no visibility (${first})` }, used: 1 };
  const metres = /^(\d{4})(NDV)?$/.exec(first);
  // Metres as stated; 9999 is 10 km or more and 0000 less than 50 m.
  if (metres) {
    const value = Number(metres[1]);
    return value === 9999
      ? observed(10_000, 'at_least')
      : value === 0
        ? observed(50, 'less_than')
        : observed(value, 'stated');
  }
  const bound = (prefix: string | undefined) => (prefix === 'M' ? 'less_than' : prefix === 'P' ? 'at_least' : 'stated');
  const whole = /^(M|P)?(\d{1,2})SM$/.exec(first);
  if (whole) return observed(miles(Number(whole[2])), bound(whole[1]));
  const part = /^(M|P)?(\d{1,2})\/(\d{1,2})SM$/.exec(first);
  if (part) {
    const value = fraction(part[2]!, part[3]!);
    if (value !== undefined) return observed(miles(value), bound(part[1]));
  }
  const mixed = second === undefined ? null : /^(\d{1,2})\/(\d{1,2})SM$/.exec(second);
  if (/^\d{1,2}$/.test(first) && mixed) {
    const value = fraction(mixed[1]!, mixed[2]!);
    if (value !== undefined) return observed(miles(Number(first) + value), 'stated', 2);
    return { reading: { notRead: `The visibility group ${first} ${second} could not be read` }, used: 2 };
  }
  return { reading: { notRead: `The visibility group ${first} could not be read` }, used: 1 };
}

// A group in the wind's place that is not shaped like a wind group is left for the visibility.
const WIND_SHAPED = /^(\d{3}|VRB|\/{3})[\d/]{2,3}(G[\d/]{2,3})?(KT|MPS|KMH)$|^\/{5}(KT|MPS)?$/;

/** Reads a report's text deterministically: station, time, the AUTO, COR and NIL marks, wind and visibility. */
export function readMetar(text: string, capturedAt: string): MetarReading {
  const groups = text.trim().replace(/=$/, '').split(/\s+/);
  let at = 0;
  const reportType = groups[at] === 'METAR' || groups[at] === 'SPECI' ? (groups[at++] as 'METAR' | 'SPECI') : undefined;
  let corrected = false;
  let automated = false;
  if (groups[at] === 'COR') [corrected, at] = [true, at + 1];
  const station = groups[at++] ?? '';
  if (!STATION.test(station)) throw new MetarRefusal(`The report does not begin with a station identifier: ${station}`);
  const timeGroup = groups[at++] ?? '';
  const occurredAt = metarTime(timeGroup, capturedAt);
  for (; ['AUTO', 'COR', 'NIL'].includes(groups[at] ?? ''); at++) {
    if (groups[at] === 'NIL')
      throw new MetarRefusal(`The report from ${station} at ${timeGroup} is NIL: no observation`);
    if (groups[at] === 'AUTO') automated = true;
    else corrected = true;
  }
  let wind: GroupReading<WindValues>;
  const windGroup = groups[at];
  if (windGroup === undefined) wind = { notRead: 'The report ends before its wind group' };
  else if (!WIND_SHAPED.test(windGroup))
    wind = { notRead: `The report has no wind group: ${windGroup} stands in its place` };
  else {
    wind = readWindGroup(windGroup);
    at++;
  }
  if (/^\d{3}V\d{3}$/.test(groups[at] ?? '')) {
    if ('values' in wind) {
      const ranged = readDirectionRange(groups[at]!, wind.values);
      wind =
        'values' in ranged
          ? { values: ranged.values, notes: wind.notes }
          : { values: wind.values, notes: [...wind.notes, `${ranged.notRead}; the wind is carried without it.`] };
    }
    at++;
  }
  const { reading: visibility } = readVisibilityGroups(groups.slice(at));
  return {
    station,
    ...(reportType ? { reportType } : {}),
    timeGroup,
    occurredAt,
    corrected,
    automated,
    wind,
    visibility,
  };
}

class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The station's location as the service lists it, when it lists one. */
function stationPosition(body: Record<string, unknown>): ObservationPosition | undefined {
  if (!Object.hasOwn(body, 'lat') && !Object.hasOwn(body, 'lon')) return undefined;
  const { lat, lon } = body;
  if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new Refusal('lat and lon, the station’s location, must be degrees of latitude and longitude');
  // The service lists the station's location in degrees: the conversion is the identity.
  return { latitudeDegrees: lat, longitudeDegrees: lon };
}

function distanceText(meters: number): string {
  return meters >= 1000 ? `${Number((meters / 1000).toFixed(1))} km` : `${Math.round(meters)} m`;
}

function stationNote(station: string, site: MetarStationSite): string {
  return site.distanceMeters === undefined
    ? `Reported by station ${station} for the site ${site.siteId}; the distance from the station to the site is not on record.`
    : `Reported by station ${station} for the site ${site.siteId}, ${distanceText(site.distanceMeters)} from the site as configured.`;
}

function translate(
  message: Parameters<TranslateFunction<MetarBinding>>[0],
  context: Parameters<TranslateFunction<MetarBinding>>[1],
): TranslationResult {
  const decoded = decodeStrictJson(message.bytes, MESSAGE_MAX_BYTES);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`);
  const body = decoded.value;
  if (!isRecord(body)) throw new Refusal('The message must be one report object');
  const text = body.rawOb;
  if (typeof text !== 'string' || !text.trim() || text.length > REPORT_MAX_CHARACTERS)
    throw new Refusal('rawOb, the report text, must be a non-empty string');
  let reading: MetarReading;
  try {
    reading = readMetar(text, message.capturedAt);
  } catch (error) {
    if (error instanceof MetarRefusal) throw new Refusal(error.message);
    throw error;
  }
  const { station } = reading;
  if (body.icaoId !== station) throw new Refusal(`icaoId does not name the station the report text names (${station})`);
  const sites = Object.hasOwn(context.binding.stations, station) ? context.binding.stations[station]! : [];
  if (!sites.length) throw new Refusal(`Station ${station} is not configured to report for any site`);
  const position = stationPosition(body);
  const marks = [
    ...(reading.automated ? ['The report is automated (AUTO): no person observed it.'] : []),
    ...(reading.corrected ? ['The report is a correction (COR) of an earlier report for the same time.'] : []),
  ];
  const report = `${station} ${reading.occurredAt} ${reading.reportType ?? 'report'}${reading.corrected ? ' COR' : ''}`;
  // One report gives one observation of each type per site, so the site is part of the source event.
  const eventId = (siteId: string) =>
    siteId.length > 120 ? `${report} for site ${sha256(siteId).slice(0, 32)}` : `${report} for ${siteId}`;
  const drafts: ObservationDraft[] = [];
  for (const site of sites) {
    const subject = subjectFor(context.subjects, 'site', site.siteId);
    if (!subject) throw new Refusal(`No Ledger site is bound to the configured site ${site.siteId}`);
    const common = {
      subject,
      occurredAt: reading.occurredAt,
      sourceEventId: eventId(site.siteId),
      ...(position ? { position } : {}),
      originalLocator: jsonPointer('rawOb'),
    };
    const reportedBy = {
      stationId: station,
      ...(site.distanceMeters === undefined ? {} : { stationDistanceMeters: site.distanceMeters }),
    };
    if ('values' in reading.wind)
      drafts.push({
        type: 'weather.wind',
        version: 1,
        ...common,
        values: { ...reading.wind.values, ...reportedBy },
        extraLimitations: [stationNote(station, site), ...marks, ...reading.wind.notes],
      });
    if ('values' in reading.visibility)
      drafts.push({
        type: 'weather.visibility',
        version: 1,
        ...common,
        values: { ...reading.visibility.values, ...reportedBy },
        extraLimitations: [stationNote(station, site), ...marks],
      });
  }
  const rejections: TranslationRejection[] = [reading.wind, reading.visibility]
    .filter((group): group is { notRead: string } => 'notRead' in group)
    .map((group) => ({ reason: group.notRead, locator: jsonPointer('rawOb') }));
  return { drafts, rejections, unmapped: unknownKeys(body, mappedKeys) };
}

export const translatePublishedMetar: TranslateFunction<MetarBinding> = (message, context) => {
  try {
    return translate(message, context);
  } catch (error) {
    if (error instanceof Refusal) return rejected(error.message);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const publishedMetarAdapter: ObservationAdapter<MetarBinding> = {
  descriptor: publishedMetarDescriptor,
  translate: translatePublishedMetar,
};

const SITE_ID = /^[^;=@\s][^;=@]{0,198}[^;=@\s]$|^[^;=@\s]$/;

/**
 * Reads the station-to-site configuration: entries separated by semicolons, each STATION=SITE or
 * STATION=SITE@DISTANCE with the distance in m or km, for example `KORD=RIDGE-SITE-1@14.2km;KORD=RIDGE-SITE-2`.
 */
export function parseMetarStations(text: string): MetarBinding {
  const stations: Record<string, MetarStationSite[]> = {};
  const entries = text
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) throw new Error('name at least one station and the site it reports for, as STATION=SITE');
  if (entries.length > 100) throw new Error('name at most 100 station and site pairs');
  for (const entry of entries) {
    const match = /^([^=]+)=([^@]+)(?:@(\d+(?:\.\d+)?)(m|km))?$/.exec(entry);
    if (!match) throw new Error(`${entry} is not STATION=SITE or STATION=SITE@DISTANCE (in m or km)`);
    const [, station, siteText, distance, unit] = match as unknown as [string, string, string, string?, string?];
    const siteId = siteText.trim();
    if (!STATION.test(station.trim()))
      throw new Error(
        `${station.trim()} is not a station identifier: four capital letters or digits, starting with a letter`,
      );
    if (!SITE_ID.test(siteId)) throw new Error(`${siteId} is not a site id of 1 to 200 characters`);
    const sites = (stations[station.trim()] ??= []);
    if (sites.some((site) => site.siteId === siteId)) throw new Error(`${station.trim()}=${siteId} is named twice`);
    sites.push(
      distance === undefined ? { siteId } : { siteId, distanceMeters: Number(distance) * (unit === 'km' ? 1000 : 1) },
    );
  }
  return { stations };
}
