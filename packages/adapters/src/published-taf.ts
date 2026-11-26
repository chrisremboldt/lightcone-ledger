import { sha256 } from '@ledger/integrity';
import type { ForecastObservationV1 } from '@ledger/contracts';
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
import {
  type MetarBinding,
  type MetarStationSite,
  MetarRefusal,
  metarTime,
  readVisibilityGroups,
  readWindGroup,
} from './published-metar.js';

/**
 * Published terminal aerodrome forecasts (TAF) read from the forecast text: when it was issued, the time it covers,
 * and each period with the wind and prevailing visibility it states, change groups kept as the forecast gives them.
 * The station-to-site configuration is the METAR adapter's.
 */
export const publishedTafDescriptor: AdapterDescriptor = {
  id: 'published-taf-forecasts',
  version: '1.0.0',
  source: {
    vendor: 'NOAA National Weather Service',
    product: 'Aviation Weather Center data API',
    interface: 'HTTPS GET /api/data/taf?ids={stations}&format=json, one forecast object of the JSON array per message',
  },
  produces: [{ type: 'weather.forecast', version: 1 }],
  fidelity: 'captured_source_replay',
  limitations: [
    'Built from the service’s published interface and the forecast code, and checked against forecasts fetched from the live service on 2026-11-26; not checked against a long-running poll, the service’s rate limits or an outage.',
    'A forecast is a record of what was forecast and when, not an observation of the weather. It is carried as its own type, never as a wind or visibility reading, so a rule about measured weather does not read it.',
    'occurredAt is the issue time the forecast states as day of month, hour and minute in UTC, placed in the month of the fetch (or the month before when the day is later than the fetch day). The validity and each period are placed from the issue time; hour 24 is midnight at the end of the day.',
    'Each change group is kept as the forecast gives it: from (FM) for conditions from its time, with the period ending at the next from group or the end of the validity; becoming (BECMG), temporary (TEMPO), probability (PROB30, PROB40) and probability_temporary (PROB TEMPO) for their stated periods. A becoming, temporary or probability period does not end the base or from period it changes, and nothing is merged into the conditions at an instant; the values the service decodes beside the text treat a becoming group as lasting to the next change and carry unchanged elements forward, which Ledger does not.',
    'Only the wind group and the prevailing visibility of each period are read. Cloud, weather, wind shear, temperature and remark groups, and the values the service decodes beside the text, are not read; they stay in each period’s text and in the retained forecast.',
    'Wind in knots is converted at 1852 meters per nautical mile; visibility in statute miles at 1609.344 meters per mile, P6SM as at least 6 statute miles, 9999 and CAVOK as at least 10000 m.',
    'A group shaped like a wind or a time that cannot be read is reported as not read, with its text, and no value is carried for it. A forecast marked NIL or cancelled (CNL) is not translated.',
    'The forecast is for the place the station stands, not for the site and not along a flight path. stationId names the station; stationDistanceMeters is the distance the configuration states, when it states one.',
    'An amended (AMD) or corrected (COR) forecast is carried as another observation; it does not replace the forecast before it.',
  ],
  documentation: [
    {
      reference:
        'Aviation Weather Center data API, OpenAPI document version v4.0 (aviationweather.gov/data/schema/openapi.yaml), fetched 2026-11-25 and again 2026-11-26 with the same digest: TAFproperties, rawTAF as the raw text of the forecast.',
      sha256: '51fe8bfd7fead5085aae9bba62aeaa0c287a836712b77f3c05f3915570465ec2',
    },
    {
      reference:
        'The TAF code: WMO Manual on Codes (WMO-No. 306), FM 51, and for forecasts from the United States the National Weather Service Instruction 10-813. Not pinned by digest.',
    },
  ],
};

const MESSAGE_MAX_BYTES = 128 * 1024;
const FORECAST_MAX_CHARACTERS = 4000;
const mappedKeys = ['icaoId', 'rawTAF', 'lat', 'lon'];
const STATION = /^[A-Z][A-Z0-9]{3}$/;
const HOUR_MS = 3_600_000;

type Period = ForecastObservationV1['values']['periods'][number];
type ForecastWind = NonNullable<Period['wind']>;

/** A forecast read from its text, with the groups that could not be read. */
export interface TafReading {
  readonly station: string;
  readonly amended: boolean;
  readonly corrected: boolean;
  readonly issuedAt: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly periods: readonly Period[];
  readonly notRead: readonly string[];
}

/** A day and hour (DDHH, hour 0 to 24) placed at or after the day before `reference`, within about a month. */
export function tafDayHour(group: string, reference: number): number {
  const match = /^(\d{2})(\d{2})(\d{2})?$/.exec(group);
  if (!match) throw new MetarRefusal(`The time ${group} is not a day and hour`);
  const [day, hour, minute] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (day < 1 || day > 31 || hour > 24 || minute > 59 || (hour === 24 && minute > 0))
    throw new MetarRefusal(`The time ${group} is not a day and hour`);
  const at = new Date(reference);
  for (const monthShift of [0, 1, -1]) {
    const month = at.getUTCMonth() + monthShift;
    const placed = Date.UTC(at.getUTCFullYear(), month, day, hour, minute);
    // A day the month does not have rolls over in Date.UTC; such a placing is not this day.
    if (new Date(Date.UTC(at.getUTCFullYear(), month, day)).getUTCDate() !== day) continue;
    if (placed >= reference - 48 * HOUR_MS && placed <= reference + 31 * 24 * HOUR_MS) return placed;
  }
  throw new MetarRefusal(`The time ${group} cannot be placed near the issue time`);
}

function span(group: string, reference: number): [number, number] {
  const match = /^(\d{4})\/(\d{4})$/.exec(group);
  if (!match) throw new MetarRefusal(`The period ${group} is not DDHH/DDHH`);
  const start = tafDayHour(match[1]!, reference);
  const end = tafDayHour(match[2]!, start);
  if (end <= start) throw new MetarRefusal(`The period ${group} ends before it starts`);
  return [start, end];
}

const iso = (time: number) => new Date(time).toISOString();
const WIND_SHAPED = /^(\d{3}|VRB|\/{3})[\d/]{2,3}(G[\d/]{2,3})?(KT|MPS|KMH)$/;
const VISIBILITY_START = /^(CAVOK|\d{4}(NDV)?|[MP]?\d{1,2}SM|[MP]?\d{1,2}\/\d{1,2}SM)$/;
const CHANGE = /^(FM\d{6}|BECMG|TEMPO|PROB\d{2})$/;

/** The wind and visibility a period's groups state, and the groups that could not be read. */
function periodValues(groups: readonly string[]): {
  wind?: ForecastWind;
  visibility?: Period['visibility'];
  notRead: string[];
} {
  const notRead: string[] = [];
  let wind: ForecastWind | undefined;
  let visibility: Period['visibility'];
  for (let at = 0; at < groups.length; at++) {
    const group = groups[at]!;
    if (wind === undefined && WIND_SHAPED.test(group)) {
      const reading = readWindGroup(group);
      if ('notRead' in reading) notRead.push(reading.notRead);
      else {
        const { method: _method, ...values } = reading.values;
        wind = values;
      }
      continue;
    }
    const mixed = /^\d{1,2}$/.test(group) && /^\d{1,2}\/\d{1,2}SM$/.test(groups[at + 1] ?? '');
    if (visibility === undefined && (VISIBILITY_START.test(group) || mixed)) {
      const { reading, used } = readVisibilityGroups(groups.slice(at));
      if ('notRead' in reading) notRead.push(reading.notRead);
      else visibility = { visibilityMeters: reading.values.visibilityMeters, bound: reading.values.bound };
      at += Math.max(used, 1) - 1;
    }
  }
  return { ...(wind ? { wind } : {}), ...(visibility ? { visibility } : {}), notRead };
}

/** Reads a forecast's text deterministically. Throws MetarRefusal when the whole forecast cannot be read. */
export function readTaf(text: string, capturedAt: string): TafReading {
  const all = text.trim().replace(/=$/, '').split(/\s+/);
  const remarks = all.indexOf('RMK');
  const groups = remarks === -1 ? all : all.slice(0, remarks);
  let at = 0;
  if (groups[at] === 'TAF') at++;
  let [amended, corrected] = [false, false];
  for (; ['AMD', 'COR'].includes(groups[at] ?? ''); at++) {
    if (groups[at] === 'AMD') amended = true;
    else corrected = true;
  }
  const station = groups[at++] ?? '';
  if (!STATION.test(station))
    throw new MetarRefusal(`The forecast does not begin with a station identifier: ${station}`);
  const issuedAt = metarTime(groups[at++] ?? '', capturedAt);
  const issued = Date.parse(issuedAt);
  if (groups[at] === 'NIL') throw new MetarRefusal(`The forecast from ${station} at ${issuedAt} is NIL: no forecast`);
  const [validFrom, validTo] = span(groups[at++] ?? '', issued);
  if (groups.slice(at).includes('CNL'))
    throw new MetarRefusal(`The forecast from ${station} at ${issuedAt} cancels the forecast before it (CNL)`);
  // Cut the rest into periods at each change group; the groups before the first are the base period.
  const pieces: { head: string[]; body: string[] }[] = [{ head: [], body: [] }];
  for (; at < groups.length; at++) {
    const group = groups[at]!;
    const tempoAfterProb =
      group === 'TEMPO' && /^PROB\d{2}$/.test(pieces.at(-1)!.head[0] ?? '') && !pieces.at(-1)!.body.length;
    if (CHANGE.test(group) && !tempoAfterProb) pieces.push({ head: [group], body: [] });
    else if (tempoAfterProb) pieces.at(-1)!.head.push(group);
    else pieces.at(-1)!.body.push(group);
  }
  const periods: Period[] = [];
  const notRead: string[] = [];
  const fromStarts: number[] = [];
  for (const piece of pieces.slice(1))
    if (piece.head[0]!.startsWith('FM'))
      try {
        fromStarts.push(tafDayHour(piece.head[0]!.slice(2), validFrom));
      } catch {
        // Reported when the period is read.
      }
  const nextFrom = (after: number) => Math.min(validTo, ...fromStarts.filter((start) => start > after));
  for (const [index, piece] of pieces.entries()) {
    const head = piece.head[0];
    const label = [...piece.head, ...piece.body].join(' ');
    try {
      let change: Period['change'];
      let probabilityPercent: number | undefined;
      let start: number;
      let end: number;
      let body = piece.body;
      if (index === 0) {
        if (!body.length) throw new MetarRefusal('The forecast states no base conditions');
        [change, start, end] = ['base', validFrom, nextFrom(validFrom)];
      } else if (head!.startsWith('FM')) {
        start = tafDayHour(head!.slice(2), validFrom);
        [change, end] = ['from', nextFrom(start)];
      } else {
        if (head!.startsWith('PROB')) {
          probabilityPercent = Number(head!.slice(4));
          if (probabilityPercent < 1 || probabilityPercent > 99)
            throw new MetarRefusal(`The probability ${head} is not a percentage`);
          change = piece.head[1] === 'TEMPO' ? 'probability_temporary' : 'probability';
        } else change = head === 'BECMG' ? 'becoming' : 'temporary';
        [start, end] = span(body[0] ?? '', validFrom);
        body = body.slice(1);
      }
      if (start < validFrom || end > validTo)
        throw new MetarRefusal(`The period ${label} lies outside the forecast’s validity`);
      const values = periodValues(body);
      notRead.push(...values.notRead.map((reason) => `${reason} (in ${label})`));
      periods.push({
        change,
        ...(probabilityPercent === undefined ? {} : { probabilityPercent }),
        startAt: iso(start),
        endAt: iso(end),
        text: label.slice(0, 500),
        ...(values.wind ? { wind: values.wind } : {}),
        ...(values.visibility ? { visibility: values.visibility } : {}),
      });
    } catch (error) {
      if (!(error instanceof MetarRefusal) || index === 0) throw error;
      notRead.push(`The change group ${label} could not be read: ${error.message}`);
    }
  }
  return {
    station,
    amended,
    corrected,
    issuedAt,
    validFrom: iso(validFrom),
    validTo: iso(validTo),
    periods,
    notRead,
  };
}

class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stationPosition(body: Record<string, unknown>) {
  if (!Object.hasOwn(body, 'lat') && !Object.hasOwn(body, 'lon')) return undefined;
  const { lat, lon } = body;
  if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new Refusal('lat and lon, the station’s location, must be degrees of latitude and longitude');
  // The service lists the station's location in degrees: the conversion is the identity.
  return { latitudeDegrees: lat, longitudeDegrees: lon };
}

function stationNote(station: string, site: MetarStationSite): string {
  const distance =
    site.distanceMeters === undefined
      ? 'the distance from the station to the site is not on record'
      : `${site.distanceMeters >= 1000 ? `${Number((site.distanceMeters / 1000).toFixed(1))} km` : `${Math.round(site.distanceMeters)} m`} from the site as configured`;
  return `Forecast for station ${station}, configured for the site ${site.siteId}; ${distance}.`;
}

function translate(
  message: Parameters<TranslateFunction<MetarBinding>>[0],
  context: Parameters<TranslateFunction<MetarBinding>>[1],
): TranslationResult {
  const decoded = decodeStrictJson(message.bytes, MESSAGE_MAX_BYTES);
  if (!decoded.ok) throw new Refusal(`Invalid or ambiguous JSON: ${decoded.reason}`);
  const body = decoded.value;
  if (!isRecord(body)) throw new Refusal('The message must be one forecast object');
  const text = body.rawTAF;
  if (typeof text !== 'string' || !text.trim() || text.length > FORECAST_MAX_CHARACTERS)
    throw new Refusal('rawTAF, the forecast text, must be a non-empty string');
  let reading: TafReading;
  try {
    reading = readTaf(text, message.capturedAt);
  } catch (error) {
    if (error instanceof MetarRefusal) throw new Refusal(error.message);
    throw error;
  }
  const { station } = reading;
  if (body.icaoId !== station)
    throw new Refusal(`icaoId does not name the station the forecast text names (${station})`);
  const sites = Object.hasOwn(context.binding.stations, station) ? context.binding.stations[station]! : [];
  if (!sites.length) throw new Refusal(`Station ${station} is not configured to report for any site`);
  const position = stationPosition(body);
  const marks = [
    ...(reading.amended ? ['The forecast is an amendment (AMD) of an earlier forecast.'] : []),
    ...(reading.corrected ? ['The forecast is a correction (COR) of an earlier forecast.'] : []),
  ];
  const forecast = `${station} ${reading.issuedAt} TAF${reading.amended ? ' AMD' : ''}${reading.corrected ? ' COR' : ''}`;
  const drafts: ObservationDraft[] = [];
  for (const site of sites) {
    const subject = subjectFor(context.subjects, 'site', site.siteId);
    if (!subject) throw new Refusal(`No Ledger site is bound to the configured site ${site.siteId}`);
    drafts.push({
      type: 'weather.forecast',
      version: 1,
      subject,
      occurredAt: reading.issuedAt,
      interval: { start: reading.validFrom, end: reading.validTo },
      sourceEventId:
        site.siteId.length > 120
          ? `${forecast} for site ${sha256(site.siteId).slice(0, 32)}`
          : `${forecast} for ${site.siteId}`,
      ...(position ? { position } : {}),
      originalLocator: jsonPointer('rawTAF'),
      values: {
        stationId: station,
        ...(site.distanceMeters === undefined ? {} : { stationDistanceMeters: site.distanceMeters }),
        ...(reading.amended ? { amended: true } : {}),
        ...(reading.corrected ? { corrected: true } : {}),
        periods: [...reading.periods],
      },
      extraLimitations: [stationNote(station, site), ...marks],
    });
  }
  const rejections: TranslationRejection[] = reading.notRead.map((reason) => ({
    reason,
    locator: jsonPointer('rawTAF'),
  }));
  return { drafts, rejections, unmapped: unknownKeys(body, mappedKeys) };
}

export const translatePublishedTaf: TranslateFunction<MetarBinding> = (message, context) => {
  try {
    return translate(message, context);
  } catch (error) {
    if (error instanceof Refusal) return rejected(error.message);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const publishedTafAdapter: ObservationAdapter<MetarBinding> = {
  descriptor: publishedTafDescriptor,
  translate: translatePublishedTaf,
};
