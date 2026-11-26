import { sha256 } from '@ledger/integrity';
import type { AirspaceRestrictionObservationV1 } from '@ledger/contracts';
import {
  type AdapterDescriptor,
  type ObservationAdapter,
  type ObservationDraft,
  type TranslateFunction,
  type TranslationRejection,
  type TranslationResult,
  rejected,
  subjectFor,
} from './adapter-contract.js';
import type { ListedItem } from './source-transports.js';
import { type XmlElement, XmlRefusal, byteRangeOf, childText, childrenNamed, readXmlElements } from './xml-elements.js';

/** A circle the organization names, around one of its sites, that a restriction is recorded for when it touches. */
export interface RestrictionRegion {
  /** The organization's own name for the region, such as an operating area's id. */
  readonly regionId: string;
  readonly siteId: string;
  readonly center: { readonly latitudeDegrees: number; readonly longitudeDegrees: number };
  readonly radiusMeters: number;
}

export interface RestrictionBinding {
  readonly regions: readonly RestrictionRegion[];
}

/**
 * Published temporary flight restrictions, one notice's detail document per message: each area whose published
 * boundary touches a configured region is recorded about that region's site, with its times, altitudes and area.
 */
export const publishedTfrDescriptor: AdapterDescriptor = {
  id: 'published-flight-restrictions',
  version: '1.0.0',
  source: {
    vendor: 'Federal Aviation Administration',
    product: 'TFR list and detail service (tfr.faa.gov)',
    interface:
      'HTTPS GET /tfrapi/exportTfrList, a JSON list of the restrictions in effect or scheduled, then GET /download/detail_{year}_{number}.xml for each, one detail document per message',
  },
  produces: [{ type: 'airspace.restriction', version: 1 }],
  fidelity: 'captured_source_replay',
  limitations: [
    'No published description of the detail document was found. The adapter is built from nine detail documents and the list fetched from the live service on 2026-11-26, and each time it reads was compared with the notice text in the same document; it is not checked against a long-running poll, the service’s rate limits or an outage.',
    'Only restrictions whose published boundary touches a configured region are recorded. A region is a circle the configuration names around one of the organization’s sites; the organization’s operating areas recorded in Ledger are not read by the adapter. Whether a boundary touches a circle is computed on a flat projection centered on the circle, which errs by well under one percent of the distance for a radius of up to 100 km.',
    'The boundary is the merged area the document publishes as corners (abdMergedArea), as published; a circle is published as corners. An area that publishes no boundary is reported as not read.',
    'The times are those of the area’s schedule, or else of the notice, read as UTC: the document writes them without a zone, and each matched the UTC times of the notice text. A notice that publishes no effective time starts at its issue time; one with no expiry has no interval end.',
    'A daily schedule (isScheduledTfrArea TRUE, dayCode Daily) is carried as its UTC times of day; other schedules are reported as not read, and the interval alone is carried.',
    'Altitudes in feet are converted at 0.3048 m per foot: HEI is above ground level, ALT above mean sea level. A flight level or another reference is reported as not read and no altitude is carried for it.',
    'The notice’s text, instructions and exceptions are not read: what the restriction restricts and allows is in the retained document. sourceTypeCode is the document’s own code for the kind of restriction, kept for people.',
    'A restriction removed from the list is not recorded as cancelled; a change to a detail document is read when its entry in the list changes.',
  ],
  documentation: [
    {
      reference:
        'The detail documents (XNOTAM-Update, version 0.1) and the list served by tfr.faa.gov, fetched 2026-11-26; no published schema. Recorded under apps/emulators/recordings/published-tfr-2026-11-26.',
    },
  ],
};

const MESSAGE_MAX_BYTES = 2 * 1024 * 1024;
const FOOT_METERS = 0.3048;
const EARTH_RADIUS_METERS = 6_371_008.8;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

type Values = AirspaceRestrictionObservationV1['values'];
type Corner = Values['area']['boundary'][number];

class Refusal extends Error {}

/** A document time, written without a zone, read as UTC. */
function utc(text: string | undefined, what: string): string | undefined {
  if (text === undefined) return undefined;
  if (!LOCAL_TIME.test(text) || !Number.isFinite(Date.parse(`${text}Z`)))
    throw new Refusal(`The ${what} ${text} is not a date and time`);
  return new Date(`${text}Z`).toISOString();
}

/** A coordinate such as 39.97750645N or 086.13W. */
function coordinate(text: string | undefined, positive: 'N' | 'E', negative: 'S' | 'W', limit: number): number {
  const match = /^(\d{1,3}(?:\.\d+)?)([NSEW])$/.exec(text ?? '');
  if (!match || (match[2] !== positive && match[2] !== negative))
    throw new Refusal(`The coordinate ${text ?? '(none)'} could not be read`);
  const value = Number(match[1]) * (match[2] === negative ? -1 : 1);
  if (Math.abs(value) > limit) throw new Refusal(`The coordinate ${text} is out of range`);
  return value;
}

function boundaryOf(merged: XmlElement): Corner[] {
  const corners = childrenNamed(merged, 'Avx').map((vertex) => {
    const datum = childText(vertex, 'codeDatum');
    if (datum !== undefined && datum !== 'WGE') throw new Refusal(`A corner is given in datum ${datum}, not WGS84`);
    return {
      latitudeDegrees: coordinate(childText(vertex, 'geoLat'), 'N', 'S', 90),
      longitudeDegrees: coordinate(childText(vertex, 'geoLong'), 'E', 'W', 180),
    };
  });
  const [first, last] = [corners[0], corners.at(-1)];
  // The boundary is published closed; the schema's last corner joins the first, so the repeat is dropped.
  if (
    corners.length > 1 &&
    first!.latitudeDegrees === last!.latitudeDegrees &&
    first!.longitudeDegrees === last!.longitudeDegrees
  )
    corners.pop();
  if (corners.length < 3 || corners.length > 1000)
    throw new Refusal(`The boundary has ${corners.length} corners, not 3 to 1000`);
  return corners;
}

function altitude(area: XmlElement, side: 'Upper' | 'Lower'): { value?: Values['ceiling']; notRead?: string } {
  const reference = childText(area, `codeDistVer${side}`);
  const value = childText(area, `valDistVer${side}`);
  const unit = childText(area, `uomDistVer${side}`);
  if (reference === undefined && value === undefined) return {};
  const datum = reference === 'HEI' ? 'ground_level' : reference === 'ALT' ? 'mean_sea_level' : undefined;
  const feet = Number(value);
  if (!datum || unit !== 'FT' || !/^\d{1,6}$/.test(value ?? ''))
    return {
      notRead:
        `The ${side === 'Upper' ? 'ceiling' : 'floor'} ${reference ?? ''} ${value ?? ''} ${unit ?? ''} could not be read`.replace(
          /\s+/g,
          ' ',
        ),
    };
  return { value: { meters: Number((feet * FOOT_METERS).toFixed(4)), datum } };
}

function dailySchedule(
  area: XmlElement,
  schedule: XmlElement | undefined,
): { value?: Values['dailySchedule']; notRead?: string } {
  if (childText(area, 'isScheduledTfrArea') !== 'TRUE') return {};
  const day = childText(area, 'dayCode');
  const [from, to] = [schedule && childText(schedule, 'startTime'), schedule && childText(schedule, 'endTime')];
  if (day !== 'Daily' || !from || !to || !LOCAL_TIME.test(from) || !LOCAL_TIME.test(to))
    return { notRead: `The schedule ${day ?? '(no day code)'} could not be read; only the interval is carried` };
  return { value: { fromTime: from.slice(11, 16), toTime: to.slice(11, 16) } };
}

/** Whether a boundary touches a circle: a corner or edge within the radius, or the center inside the boundary. */
export function boundaryTouchesCircle(
  boundary: readonly Corner[],
  center: { latitudeDegrees: number; longitudeDegrees: number },
  radiusMeters: number,
): boolean {
  const radians = Math.PI / 180;
  const scale = Math.cos(center.latitudeDegrees * radians);
  const points = boundary.map((corner) => {
    const longitude = ((((corner.longitudeDegrees - center.longitudeDegrees) % 360) + 540) % 360) - 180;
    return {
      x: longitude * radians * scale * EARTH_RADIUS_METERS,
      y: (corner.latitudeDegrees - center.latitudeDegrees) * radians * EARTH_RADIUS_METERS,
    };
  });
  let inside = false;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const along = dx || dy ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy))) : 0;
    if (Math.hypot(a.x + along * dx, a.y + along * dy) <= radiusMeters) return true;
  }
  return inside;
}

function notamIdOf(notice: XmlElement): string {
  const uid = childrenNamed(notice, 'NotUid')[0];
  const year = uid && childText(uid, 'dateIndexYear');
  const number = uid && childText(uid, 'noSeqNo');
  if (!year || !number || !/^\d{4}$/.test(year) || !/^\d{1,5}$/.test(number))
    throw new Refusal('The notice does not state its year and number (NotUid)');
  return `${year.slice(-1)}/${number.padStart(4, '0')}`;
}

function translate(
  message: Parameters<TranslateFunction<RestrictionBinding>>[0],
  context: Parameters<TranslateFunction<RestrictionBinding>>[1],
): TranslationResult {
  if (message.bytes.byteLength === 0 || message.bytes.byteLength > MESSAGE_MAX_BYTES)
    throw new Refusal(`The document must be 1 to ${MESSAGE_MAX_BYTES} bytes`);
  let root: XmlElement;
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(message.bytes);
    root = readXmlElements(source);
  } catch (error) {
    throw new Refusal(`Invalid XML: ${error instanceof XmlRefusal ? error.message : 'the bytes are not UTF-8'}`);
  }
  if (root.name !== 'XNOTAM-Update') throw new Refusal(`The document is ${root.name}, not an XNOTAM-Update`);
  const notices = childrenNamed(root, 'Group').flatMap((group) =>
    childrenNamed(group, 'Add').flatMap((add) => childrenNamed(add, 'Not')),
  );
  if (notices.length !== 1) throw new Refusal(`The document holds ${notices.length} notices, not one`);
  const notice = notices[0]!;
  const notamId = notamIdOf(notice);
  const uid = childrenNamed(notice, 'NotUid')[0]!;
  const issuedAt = utc(childText(uid, 'dateIssued'), 'issue time');
  if (!issuedAt) throw new Refusal(`The notice ${notamId} does not state when it was issued`);
  const name = childText(uid, 'txtLocalName');
  const noticeFrom = utc(childText(notice, 'dateEffective'), 'effective time');
  const noticeTo = utc(childText(notice, 'dateExpire'), 'expiry time');
  const restriction = childrenNamed(notice, 'TfrNot')[0];
  if (!restriction) throw new Refusal(`The notice ${notamId} is not a flight restriction (no TfrNot)`);
  const sourceTypeCode = childText(restriction, 'codeType');
  const groups = childrenNamed(restriction, 'TFRAreaGroup');
  if (!groups.length) throw new Refusal(`The notice ${notamId} publishes no area`);
  const drafts: ObservationDraft[] = [];
  const rejections: TranslationRejection[] = [];
  const notRead = (reason: string) => rejections.push({ reason: `${notamId}: ${reason}` });
  for (const [index, group] of groups.entries()) {
    const area = childrenNamed(group, 'aseTFRArea')[0];
    const merged = childrenNamed(group, 'abdMergedArea')[0];
    const areaName = (area && childText(area, 'txtName')) ?? `area ${index + 1}`;
    if (!area || !merged) {
      notRead(`${areaName} publishes no boundary`);
      continue;
    }
    const boundary = boundaryOf(merged);
    const schedule = childrenNamed(area, 'ScheduleGroup')[0];
    const from = utc(schedule && childText(schedule, 'dateEffective'), 'effective time') ?? noticeFrom ?? issuedAt;
    const to = utc(schedule && childText(schedule, 'dateExpire'), 'expiry time') ?? noticeTo;
    if (to !== undefined && Date.parse(to) <= Date.parse(from))
      throw new Refusal(`${areaName} of ${notamId} expires before it takes effect`);
    const floor = altitude(area, 'Lower');
    const ceiling = altitude(area, 'Upper');
    const daily = dailySchedule(area, schedule);
    for (const problem of [floor.notRead, ceiling.notRead, daily.notRead])
      if (problem) notRead(`${areaName}: ${problem}`);
    for (const region of context.binding.regions) {
      if (!boundaryTouchesCircle(boundary, region.center, region.radiusMeters)) continue;
      const subject = subjectFor(context.subjects, 'site', region.siteId);
      if (!subject) throw new Refusal(`No Ledger site is bound to the configured site ${region.siteId}`);
      const event = `${notamId} ${areaName} touching ${region.regionId}`;
      drafts.push({
        type: 'airspace.restriction',
        version: 1,
        subject,
        occurredAt: issuedAt,
        interval: { start: from, ...(to ? { end: to } : {}) },
        sourceEventId: event.length > 200 ? `${notamId} ${sha256(event).slice(0, 32)}` : event,
        originalLocator: { kind: 'byte_range', value: byteRangeOf(source, group) },
        values: {
          notamId,
          ...(name ? { name: name.slice(0, 300) } : {}),
          areaName: areaName.slice(0, 200),
          ...(sourceTypeCode ? { sourceTypeCode: sourceTypeCode.slice(0, 100) } : {}),
          ...(floor.value ? { floor: floor.value } : {}),
          ...(ceiling.value ? { ceiling: ceiling.value } : {}),
          ...(daily.value ? { dailySchedule: daily.value } : {}),
          area: { boundary },
          regionId: region.regionId,
        },
        extraLimitations: [
          `The published area touches the region ${region.regionId}, a circle of ${region.radiusMeters} m configured around the site ${region.siteId}.`,
          ...(noticeFrom === undefined && !(schedule && childText(schedule, 'dateEffective'))
            ? ['The notice publishes no effective time: the interval starts at its issue time.']
            : []),
        ],
      });
    }
  }
  return { drafts, rejections, unmapped: [] };
}

export const translatePublishedTfr: TranslateFunction<RestrictionBinding> = (message, context) => {
  try {
    return translate(message, context);
  } catch (error) {
    if (error instanceof Refusal) return rejected(error.message);
    return rejected(`Could not read the message: ${(error as Error).message}`);
  }
};

export const publishedTfrAdapter: ObservationAdapter<RestrictionBinding> = {
  descriptor: publishedTfrDescriptor,
  translate: translatePublishedTfr,
};

/**
 * The detail documents the service's list names, each keyed by its list entry so a changed entry is read again.
 * Undefined when the bytes are not the list.
 */
export function restrictionListItems(bytes: Uint8Array): ListedItem[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const items: ListedItem[] = [];
  for (const entry of list) {
    const id = (entry as { notam_id?: unknown } | null)?.notam_id;
    const match = typeof id === 'string' ? /^(\d)\/(\d{1,5})$/.exec(id) : null;
    if (!match) return undefined;
    items.push({ path: `/download/detail_${match[1]}_${match[2]}.xml`, key: sha256(JSON.stringify(entry)) });
  }
  return items;
}

const REGION_ID = /^[^;=@\s][^;=@]{0,198}[^;=@\s]$|^[^;=@\s]$/;
const MAX_REGION_RADIUS_METERS = 100_000;

/**
 * Reads the region configuration: entries separated by semicolons, each REGION=SITE@LATITUDE,LONGITUDE,RADIUS with
 * the radius in m or km, for example `RIDGE-AREA-1=RIDGE-SITE-1@39.97,-86.13,5km`.
 */
export function parseRestrictionRegions(text: string): RestrictionBinding {
  const entries = text
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) throw new Error('name at least one region, as REGION=SITE@LATITUDE,LONGITUDE,RADIUS');
  if (entries.length > 100) throw new Error('name at most 100 regions');
  const regions: RestrictionRegion[] = [];
  for (const entry of entries) {
    const match = /^([^=]+)=([^@]+)@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(m|km)$/.exec(entry);
    if (!match) throw new Error(`${entry} is not REGION=SITE@LATITUDE,LONGITUDE,RADIUS (in m or km)`);
    const [regionId, siteId] = [match[1]!.trim(), match[2]!.trim()];
    const [latitude, longitude] = [Number(match[3]), Number(match[4])];
    const radiusMeters = Number(match[5]) * (match[6] === 'km' ? 1000 : 1);
    if (!REGION_ID.test(regionId) || !REGION_ID.test(siteId))
      throw new Error(`${entry}: the region and the site are ids of 1 to 200 characters`);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
      throw new Error(`${entry}: the center is degrees of latitude and longitude`);
    if (radiusMeters <= 0 || radiusMeters > MAX_REGION_RADIUS_METERS)
      throw new Error(`${entry}: the radius is more than 0 and at most ${MAX_REGION_RADIUS_METERS / 1000} km`);
    if (regions.some((region) => region.regionId === regionId)) throw new Error(`${regionId} is named twice`);
    regions.push({
      regionId,
      siteId,
      center: { latitudeDegrees: latitude, longitudeDegrees: longitude },
      radiusMeters,
    });
  }
  return { regions };
}
