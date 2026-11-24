import {
  OPERATING_AREA_SIZE_LIMIT_METERS,
  parsePoint,
  parsePoints,
  type CheckDetails,
  type IssueTime,
} from '@ledger/contracts';
import GeographicLib from 'geographiclib-geodesic';
import { quantityText, textUnitSchema, type TextUnit } from './quantities.js';
import {
  current,
  fieldPath,
  labelOf,
  recordedSegment,
  round,
  scalars,
  selectionSchema,
  type Scalar,
  type Selection,
} from './check-kind-library-records.js';
import {
  inWindow,
  iso,
  observedWindow,
  windowDetailDefinitions,
  windowDetails,
  windowParameterSchema,
  type ObservedWindow,
  type WindowParams,
} from './check-kind-library-windows.js';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  spanStart,
  utcMillis,
  type CheckInputs,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { calculationDefinition } from './mission-avoidance-definition.js';

// Check kinds over positions and areas. The area is a circle or a polygon given in the rule, a circle the organization
// sets on adoption, or an area another input records. Each kind, its parameters and inputs are listed in
// docs/design/record-check-kinds.md.
//
// Distances use the route review kernel's geodesic library, ellipsoid, coordinate profile and numerical margin
// (mission-avoidance-kernel.ts). The kernel itself answers whether a route meets a circle and states no distance, so a
// position, which needs one, is measured here with the same geodesic.

const geodesic = GeographicLib.Geodesic.WGS84;
const numericalMargin = calculationDefinition.numericalMarginMeters;
const maxRadius = calculationDefinition.maxControlRadiusMeters;
const maxRingPositions = calculationDefinition.maxPositions;
const maxPerimeter = calculationDefinition.maxCurveLengthMeters;

interface Point {
  latitude: number;
  longitude: number;
}
interface Circle {
  shape: 'circle';
  center: Point;
  radiusMeters: number;
}
interface Polygon {
  shape: 'polygon';
  rings: Point[][];
}
/** A line of points and how far the area reaches on either side of it. */
interface Corridor {
  shape: 'corridor';
  points: Point[];
  halfWidthMeters: number;
}
type Area = Circle | Polygon | Corridor;

/** An area an operator record states, with its id and the time it is in force. */
interface RecordedArea {
  id: string;
  area: Area;
  from: number;
  until: number;
  /** The record that states it; none for an area the rule lists. */
  observation?: CheckObservation;
}

/** A circle as the avoidance-area control type and accepted area controls state it. */
interface CircleShape {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
}
/** A GeoJSON polygon in longitude, latitude order: an outer ring and optional holes, each ring closed. */
interface PolygonShape {
  type: 'Polygon';
  coordinates: [number, number][][];
}

const latitudeSchema = { type: 'number', minimum: -90, maximum: 90 } as const;
const longitudeSchema = { type: 'number', minimum: -180, maximum: 180 } as const;
const radiusSchema = { type: 'number', exclusiveMinimum: 0, maximum: maxRadius } as const;
const circleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['center', 'radiusMeters'],
  properties: {
    center: {
      type: 'object',
      additionalProperties: false,
      required: ['latitude', 'longitude'],
      properties: { latitude: latitudeSchema, longitude: longitudeSchema },
    },
    radiusMeters: radiusSchema,
  },
} as const;
const polygonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { const: 'Polygon' },
    coordinates: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'array',
        minItems: 4,
        maxItems: maxRingPositions,
        items: { type: 'array', minItems: 2, maxItems: 2, items: [longitudeSchema, latitudeSchema] },
      },
    },
  },
} as const;
const unusableSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'oneOf'],
    properties: { field: fieldPath, oneOf: scalars },
  },
} as const;

function result(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  details: CheckDetails,
): CheckResult {
  return {
    evidenceState,
    outcome,
    reasonCode,
    summary,
    evidence: [...new Set(evidence.map((observation) => observation.id))],
    details,
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validPoint(point: Point): boolean {
  return (
    isNumber(point.latitude) &&
    isNumber(point.longitude) &&
    Math.abs(point.latitude) <= calculationDefinition.maxAbsLatitudeDegrees &&
    Math.abs(point.longitude) <= calculationDefinition.maxAbsLongitudeDegrees
  );
}

function distance(from: Point, to: Point): { meters: number; azimuth: number } {
  const line = geodesic.Inverse(from.latitude, from.longitude, to.latitude, to.longitude);
  return { meters: line.s12!, azimuth: line.azi1! };
}

// Areas -------------------------------------------------------------------------------------------------------------

/** A circle or GeoJSON polygon inside the coordinate profile, or undefined for any other value. */
function areaOf(value: unknown): Area | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const shape = value as Partial<CircleShape & PolygonShape>;
  if (shape.type === 'Polygon') return polygonOf(shape.coordinates);
  const center = shape.center;
  if (!center || typeof center !== 'object') return undefined;
  const point = { latitude: center.latitude!, longitude: center.longitude! };
  const radius = shape.radiusMeters;
  if (!validPoint(point) || !isNumber(radius) || radius <= 0 || radius > maxRadius) return undefined;
  return { shape: 'circle', center: point, radiusMeters: radius };
}

function polygonOf(coordinates: unknown): Polygon | undefined {
  if (!Array.isArray(coordinates) || !coordinates.length || coordinates.length > 20) return undefined;
  const rings: Point[][] = [];
  let perimeter = 0;
  for (const ring of coordinates) {
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > maxRingPositions) return undefined;
    const points = ring.map((position: unknown) =>
      Array.isArray(position) && position.length === 2
        ? { longitude: position[0] as number, latitude: position[1] as number }
        : { longitude: NaN, latitude: NaN },
    );
    if (!points.every(validPoint)) return undefined;
    const first = points[0]!;
    const last = points.at(-1)!;
    if (first.latitude !== last.latitude || first.longitude !== last.longitude) return undefined;
    for (let index = 1; index < points.length; index += 1) {
      const [start, end] = [points[index - 1]!, points[index]!];
      if (Math.abs(end.longitude - start.longitude) > calculationDefinition.maxLongitudeDeltaDegrees) return undefined;
      perimeter += distance(start, end).meters;
    }
    rings.push(points.slice(0, -1));
  }
  return perimeter > maxPerimeter ? undefined : { shape: 'polygon', rings };
}

/**
 * How far a point is outside the area, in meters: negative inside, by how far it is from the boundary. The boundary
 * belongs to the area. Polygon edges are straight lines in a plane centred on the point (azimuthal equidistant), so
 * distances to vertices are exact geodesic distances.
 */
function signedDistance(area: Area, point: Point): number {
  if (area.shape === 'circle') return distance(area.center, point).meters - area.radiusMeters;
  if (area.shape === 'corridor') return distanceToLine(point, area.points) - area.halfWidthMeters;
  let inside = false;
  let nearest = Infinity;
  for (const ring of area.rings) {
    const plane = ring.map((vertex) => {
      const { meters, azimuth } = distance(point, vertex);
      const radians = (azimuth * Math.PI) / 180;
      return { x: meters * Math.sin(radians), y: meters * Math.cos(radians) };
    });
    for (let index = 0; index < plane.length; index += 1) {
      const a = plane[index]!;
      const b = plane[(index + 1) % plane.length]!;
      if (a.y > 0 !== b.y > 0 && 0 < a.x + ((0 - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
      nearest = Math.min(nearest, distanceToSegment(a, b));
    }
  }
  return inside ? -nearest : nearest;
}

/** Legs no longer than this are measured as straight lines in a plane centred on the point. */
const PIECE_METERS = 1_000;

interface Leg {
  a: Point;
  b: Point;
  length: number;
  /** Geodesic distances from the point to each end. */
  toA: number;
  toB: number;
}

/**
 * The geodesic distance from a point to a line of geodesic legs. Each leg is halved along its geodesic until a piece
 * is at most PIECE_METERS long, which is then measured in a plane centred on the point; a piece that cannot come
 * nearer than the nearest distance found so far is not halved further. No point X of a leg from A to B can be nearer
 * than (|PA| + |PB| - |AB|) / 2, by the triangle inequality, which is the bound used.
 */
function distanceToLine(point: Point, points: readonly Point[]): number {
  const toVertex = points.map((vertex) => distance(point, vertex).meters);
  let nearest = Math.min(...toVertex);
  const legs: Leg[] = points.slice(1).map((b, index) => ({
    a: points[index]!,
    b,
    length: distance(points[index]!, b).meters,
    toA: toVertex[index]!,
    toB: toVertex[index + 1]!,
  }));
  while (legs.length) {
    const leg = legs.pop()!;
    if ((leg.toA + leg.toB - leg.length) / 2 >= nearest) continue;
    if (leg.length <= PIECE_METERS) {
      nearest = Math.min(nearest, distanceToSegment(planeOf(point, leg.a), planeOf(point, leg.b)));
      continue;
    }
    const azimuth = distance(leg.a, leg.b).azimuth;
    const halfway = geodesic.Direct(leg.a.latitude, leg.a.longitude, azimuth, leg.length / 2);
    const middle = { latitude: halfway.lat2!, longitude: halfway.lon2! };
    const toMiddle = distance(point, middle).meters;
    nearest = Math.min(nearest, toMiddle);
    legs.push(
      { a: leg.a, b: middle, length: leg.length / 2, toA: leg.toA, toB: toMiddle },
      { a: middle, b: leg.b, length: leg.length / 2, toA: toMiddle, toB: leg.toB },
    );
  }
  return nearest;
}

/** A vertex in a plane centred on the point (azimuthal equidistant): its distance from the point is exact. */
function planeOf(point: Point, vertex: Point): { x: number; y: number } {
  const { meters, azimuth } = distance(point, vertex);
  const radians = (azimuth * Math.PI) / 180;
  return { x: meters * Math.sin(radians), y: meters * Math.cos(radians) };
}

function distanceToSegment(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / length));
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

/**
 * How far each point is outside an area stated as a circle or GeoJSON polygon, in meters (negative inside, within the
 * numerical margin on the boundary). Undefined when the value is not an area inside the coordinate profile, or a point
 * is outside it.
 */
export function distancesOutsideArea(value: unknown, points: readonly Point[]): number[] | undefined {
  const area = areaOf(value);
  if (!area || !points.every(validPoint)) return undefined;
  return points.map((point) => {
    const outside = signedDistance(area, point);
    return outside > numericalMargin ? outside : Math.min(outside, 0);
  });
}

function areaWords(area: Area, textUnit?: TextUnit): string {
  if (area.shape === 'circle')
    return `the circle of ${quantityText(area.radiusMeters, 'm', textUnit)} around ${area.center.latitude}, ${area.center.longitude}`;
  if (area.shape === 'corridor')
    return `the corridor ${quantityText(area.halfWidthMeters, 'm', textUnit)} either side of a line of ${area.points.length} points`;
  return `the polygon of ${area.rings[0]!.length} corners`;
}

/** Where an operator record states an area's id, shape, and the fields of a circle or a corridor. */
export interface AreaRecordFields {
  idField: string;
  shapeField: string;
  centerField: string;
  radiusField: string;
  pointsField: string;
  halfWidthField: string;
}

function textAt(observation: CheckObservation, field: string): string | undefined {
  const value = observationField(observation, field);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A size an area record states, within the bound the record type and this kind share. */
function sizeAt(observation: CheckObservation, field: string, what: string): number | string {
  const value = observationField(observation, field);
  if (!isNumber(value)) return `states no ${what}`;
  if (value <= 0) return `states a ${what} of ${value} m, which is not more than 0`;
  if (value > OPERATING_AREA_SIZE_LIMIT_METERS)
    return `states a ${what} of ${value} m, more than the ${OPERATING_AREA_SIZE_LIMIT_METERS} m an area may reach`;
  return value;
}

/** The area an operator record states, or why it cannot be placed: in the record's own words. */
function recordedArea(observation: CheckObservation, fields: AreaRecordFields): Area | string {
  const shape = observationField(observation, fields.shapeField);
  if (shape === 'circle') {
    const written = textAt(observation, fields.centerField);
    if (!written) return 'states no centre';
    const center = parsePoint(written);
    if (typeof center === 'string') return `has a centre that cannot be read: ${center}`;
    if (!validPoint(center)) return 'has a centre beyond 80 degrees of latitude';
    const radius = sizeAt(observation, fields.radiusField, 'radius');
    return typeof radius === 'string' ? radius : { shape: 'circle', center, radiusMeters: radius };
  }
  if (shape === 'corridor') {
    const written = textAt(observation, fields.pointsField);
    if (!written) return 'states no points along its line';
    const points = parsePoints(written);
    if (typeof points === 'string') return `has points that cannot be read: ${points}`;
    if (!points.every(validPoint)) return 'has a point beyond 80 degrees of latitude';
    for (let index = 1; index < points.length; index += 1)
      if (
        Math.abs(points[index]!.longitude - points[index - 1]!.longitude) >
        calculationDefinition.maxLongitudeDeltaDegrees
      )
        return `has a leg from point ${index} to point ${index + 1} that crosses more longitude than Ledger measures`;
    const halfWidth = sizeAt(observation, fields.halfWidthField, 'half-width');
    return typeof halfWidth === 'string' ? halfWidth : { shape: 'corridor', points, halfWidthMeters: halfWidth };
  }
  return 'states no shape';
}

function recordedAreaId(observation: CheckObservation, fields: AreaRecordFields): string {
  return textAt(observation, fields.idField) ?? observation.id;
}

const byId = new Intl.Collator('en', { numeric: true }).compare;

/** The areas by the ids their records state, in the order of those ids, so no summary depends on Ledger's own. */
function namedAreas(areas: readonly RecordedArea[]): string {
  const ids = [...new Set(areas.map((item) => item.id))].sort(byId);
  return ids.length === 1 ? `operating area ${ids[0]}` : `the ${ids.length} operating areas ${ids.join(', ')}`;
}

// A position is inside, or outside, an area -----------------------------------------------------------------------

export interface PositionInAreaParams {
  /** Version 2 only: the unit the rule's text states distances and heights in. */
  textUnit?: TextUnit;
  select?: Selection;
  expect: 'inside' | 'outside';
  area?: CircleShape | PolygonShape;
  centerLatitude?: number;
  centerLongitude?: number;
  radiusMeters?: number;
  areaSelect?: Selection;
  areaField?: string;
  /** Version 2: every selected area record in force at a position's time is an area; inside any one is inside. */
  areaRecords?: AreaRecordFields;
  /** Version 2: the areas the rule lists, each a circle or a corridor; inside any one is inside. */
  areas?: ListedArea[];
  marginMeters?: number;
  maxHeightMeters?: number;
  heightDatum?: string;
  minPositions?: number;
  minSeconds?: number;
  unusable?: { field: string; oneOf: Scalar[] }[];
  accuracyField?: string;
  maxAccuracyMeters?: number;
  scope: 'latest' | 'any';
}

interface Placed {
  observation: CheckObservation;
  at: number;
  /** Meters outside the area grown by the margin: negative inside. */
  outside: number;
  /** Meters beyond the area grown by the margin: positive where the position is on the wrong side. */
  beyond: number;
  /** Meters above the maximum height, when compared. */
  above: number | undefined;
  away: boolean;
}

interface Excursion {
  positions: Placed[];
}

type AreaFound =
  | { area: Area; evidence: CheckObservation[] }
  | { areas: RecordedArea[]; leftOut: string[]; evidence: CheckObservation[] }
  | { problem: string; evidence: CheckObservation[]; leftOut?: string[] };

/** Every selected area record, with the time it is in force; those whose area cannot be placed are named and left out. */
function recordedAreas(params: PositionInAreaParams, inputs: CheckInputs): AreaFound {
  const fields = params.areaRecords!;
  const records = current(inputs.area, params.areaSelect);
  if (!records.length) return { problem: 'area_missing', evidence: [] };
  const areas: RecordedArea[] = [];
  const leftOut: string[] = [];
  for (const observation of records) {
    const id = recordedAreaId(observation, fields);
    const area = recordedArea(observation, fields);
    const segment = recordedSegment(observation, 'open');
    if (typeof area === 'string') leftOut.push(`${id} ${area}`);
    else if (!segment) leftOut.push(`${id} states no time it is in force`);
    else areas.push({ id, area, from: segment.start, until: segment.end, observation });
  }
  leftOut.sort(byId);
  if (!areas.length) return { problem: 'area_invalid', evidence: records, leftOut };
  return { areas, leftOut, evidence: areas.flatMap((item) => item.observation ?? []) };
}

/** An area a rule lists by its id: a circle, or a corridor along a line of points. */
export type ListedArea =
  { id: string; center: Point; radiusMeters: number } | { id: string; points: Point[]; halfWidthMeters: number };

/** The areas a rule lists, each in force at every time; one whose shape cannot be placed is named and left out. */
function listedAreas(listed: readonly ListedArea[]): AreaFound {
  const areas: RecordedArea[] = [];
  const leftOut: string[] = [];
  for (const item of listed) {
    if ('center' in item) {
      const area = areaOf({ center: item.center, radiusMeters: item.radiusMeters });
      if (area) areas.push({ id: item.id, area, from: -Infinity, until: Infinity });
      else leftOut.push(`${item.id} has a centre or radius Ledger cannot place`);
      continue;
    }
    const legsMeasured = item.points.every(
      (point, index) =>
        index === 0 ||
        Math.abs(point.longitude - item.points[index - 1]!.longitude) <= calculationDefinition.maxLongitudeDeltaDegrees,
    );
    if (item.points.every(validPoint) && legsMeasured && item.halfWidthMeters > 0)
      areas.push({
        id: item.id,
        area: { shape: 'corridor', points: item.points, halfWidthMeters: item.halfWidthMeters },
        from: -Infinity,
        until: Infinity,
      });
    else leftOut.push(`${item.id} has points or a half-width Ledger cannot place`);
  }
  leftOut.sort(byId);
  return areas.length ? { areas, leftOut, evidence: [] } : { problem: 'area_invalid', evidence: [], leftOut };
}

function statedArea(params: PositionInAreaParams, inputs: CheckInputs): AreaFound {
  if (params.areaRecords !== undefined) return recordedAreas(params, inputs);
  if (params.areas !== undefined) return listedAreas(params.areas);
  if (params.area !== undefined) {
    const area = areaOf(params.area);
    return area ? { area, evidence: [] } : { problem: 'area_invalid', evidence: [] };
  }
  if (params.areaField === undefined) {
    const area = areaOf({
      center: { latitude: params.centerLatitude, longitude: params.centerLongitude },
      radiusMeters: params.radiusMeters,
    });
    return area ? { area, evidence: [] } : { problem: 'area_invalid', evidence: [] };
  }
  const latest = latestObservations(current(inputs.area, params.areaSelect));
  const stated = latest.flatMap((observation) => {
    const value = observationField(observation, params.areaField!);
    return value === undefined || value === null ? [] : [{ observation, value, area: areaOf(value) }];
  });
  const evidence = stated.map((item) => item.observation);
  if (!stated.length) return { problem: 'area_missing', evidence: latest };
  if (stated.some((item) => !item.area)) return { problem: 'area_invalid', evidence };
  if (new Set(stated.map((item) => JSON.stringify(item.value))).size > 1)
    return { problem: 'areas_disagree', evidence };
  return { area: stated[0]!.area!, evidence };
}

/** Why a position cannot be used, or undefined when it can. */
function unusableBecause(observation: CheckObservation, params: PositionInAreaParams): string | undefined {
  const point = {
    latitude: observationField(observation, 'position.latitudeDegrees') as number,
    longitude: observationField(observation, 'position.longitudeDegrees') as number,
  };
  if (!validPoint(point)) return 'no position inside the coordinate profile';
  for (const condition of params.unusable ?? []) {
    const value = observationField(observation, condition.field);
    if (condition.oneOf.some((listed) => listed === value))
      return `${labelOf(condition.field, [observation])} ${String(value)}`;
  }
  if (params.accuracyField !== undefined) {
    const accuracy = observationField(observation, params.accuracyField);
    if (isNumber(accuracy) && accuracy > params.maxAccuracyMeters!)
      return `${labelOf(params.accuracyField, [observation])} ${accuracy}`;
  }
  return undefined;
}

function heightAbove(observation: CheckObservation, params: PositionInAreaParams): number | undefined {
  if (params.maxHeightMeters === undefined) return undefined;
  const meters = observationField(observation, 'position.altitude.meters');
  const datum = observationField(observation, 'position.altitude.datum');
  return isNumber(meters) && datum === params.heightDatum ? meters - params.maxHeightMeters : undefined;
}

/** Runs of consecutive positions on the wrong side, oldest first. Unusable positions neither end nor extend a run. */
function excursions(placed: readonly Placed[]): Excursion[] {
  const runs: Excursion[] = [];
  let run: Placed[] = [];
  for (const position of placed) {
    if (position.away) run.push(position);
    else if (run.length) {
      runs.push({ positions: run });
      run = [];
    }
  }
  if (run.length) runs.push({ positions: run });
  return runs;
}

function seconds(excursion: Excursion): number {
  return (excursion.positions.at(-1)!.at - excursion.positions[0]!.at) / 1000;
}

function counts(excursion: Excursion, params: PositionInAreaParams): boolean {
  return excursion.positions.length >= (params.minPositions ?? 1) && seconds(excursion) >= (params.minSeconds ?? 0);
}

/** How far an excursion went: up to its greatest distance, or, where no area was in force, that none was. */
function reach(excursion: Excursion, textUnit?: TextUnit): string {
  const distances = excursion.positions.map((position) => position.beyond).filter(Number.isFinite);
  const unplaced = excursion.positions.length - distances.length;
  const most = distances.length ? `up to ${quantityText(round2(Math.max(...distances)), 'm', textUnit)}` : '';
  const none = unplaced ? `${unplaced} of them when no operating area was in force` : '';
  return [most, none].filter(Boolean).join(', ');
}

function describeExcursion(excursion: Excursion, details: CheckDetails): void {
  const first = excursion.positions[0]!;
  const last = excursion.positions.at(-1)!;
  const heights = excursion.positions.flatMap((position) => (position.above === undefined ? [] : [position.above]));
  Object.assign(details, {
    excursionStartedAt: spanStart(first.observation),
    excursionLastAt: spanStart(last.observation),
    excursionSeconds: seconds(excursion),
    excursionPositions: excursion.positions.length,
    maxDistanceOutsideMeters: (() => {
      const distances = excursion.positions.map((position) => position.beyond).filter(Number.isFinite);
      return distances.length ? round2(Math.max(...distances)) : null;
    })(),
    maxHeightAboveLimitMeters: heights.length ? round2(Math.max(...heights)) : null,
  });
}

function round2(value: number): number {
  return round(Math.round(value * 100) / 100);
}

export const positionInAreaV1: CheckKind<PositionInAreaParams> = {
  id: 'position.in-area',
  version: 1,
  title: 'Positions inside, or outside, an area',
  description:
    'Each selected position (the observation’s WGS84 position) is placed against an area: a circle or a GeoJSON polygon fixed in the rule, a circle whose centre and radius the organization sets, or the circle or polygon in a field of the latest selected area observation. The area is closed, grown by marginMeters (shrunk when negative), and measured by geodesic distance on the WGS84 ellipsoid; positions within a millimetre of its boundary are on it. With expect inside a position is away when it is outside the area or, with maxHeightMeters, its height in heightDatum is above that height; with expect outside it is away when it is inside the area. Consecutive away positions make an excursion, which counts only with at least minPositions positions and minSeconds from its first to its last position. With scope latest the excursion still going on at the newest position is checked; with any, every excursion among the positions read. A counted excursion needs attention; one not yet long enough is pending. Positions outside the coordinate profile, matching an unusable condition or stating an accuracy worse than maxAccuracyMeters are left out and counted. No area, an invalid area or no usable position is insufficient; simultaneous areas that disagree conflict.',
  inputs: [
    { name: 'positions', description: 'Observations that carry a position.' },
    { name: 'area', description: 'Observations or operator records that carry the area.', optional: true },
  ],
  details: [
    { name: 'areaShape', description: 'circle or polygon; null when no area was read.' },
    { name: 'marginMeters', description: 'How far the area was grown, in meters (negative: shrunk).' },
    { name: 'positionsChecked', description: 'How many usable positions were placed against the area.' },
    { name: 'unusablePositions', description: 'How many positions were left out as unusable.' },
    {
      name: 'heightsUnchecked',
      description: 'With maxHeightMeters, how many usable positions state no height in heightDatum; otherwise null.',
    },
    {
      name: 'latestDistanceOutsideMeters',
      description:
        'How far the newest usable position is outside the area grown by the margin, in meters; negative inside. Null when none.',
    },
    { name: 'excursionStartedAt', description: 'Time of the first position of the excursion; null when none.' },
    { name: 'excursionLastAt', description: 'Time of the last position of the excursion; null when none.' },
    { name: 'excursionSeconds', description: 'Seconds from the first to the last position of the excursion.' },
    { name: 'excursionPositions', description: 'How many positions the excursion holds; null when none.' },
    {
      name: 'maxDistanceOutsideMeters',
      description:
        'Over the excursion, the greatest distance on the wrong side of the area grown by the margin, in meters; null when none.',
    },
    {
      name: 'maxHeightAboveLimitMeters',
      description: 'Over the excursion, the greatest height above maxHeightMeters; null when not compared.',
    },
  ],
  summaryValues: ['excursionStartedAt', 'excursionLastAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['expect', 'scope'],
    properties: {
      select: selectionSchema,
      expect: { enum: ['inside', 'outside'] },
      area: { oneOf: [circleSchema, polygonSchema] },
      centerLatitude: latitudeSchema,
      centerLongitude: longitudeSchema,
      radiusMeters: radiusSchema,
      areaSelect: selectionSchema,
      areaField: fieldPath,
      marginMeters: { type: 'number', minimum: -maxRadius, maximum: maxRadius },
      maxHeightMeters: { type: 'number', minimum: -10_000, maximum: 100_000 },
      heightDatum: { type: 'string', minLength: 1, maxLength: 100 },
      minPositions: { type: 'integer', minimum: 1, maximum: 10_000 },
      minSeconds: { type: 'number', minimum: 0, maximum: 86_400 },
      unusable: unusableSchema,
      accuracyField: fieldPath,
      maxAccuracyMeters: { type: 'number', minimum: 0, maximum: 100_000 },
      scope: { enum: ['latest', 'any'] },
    },
    oneOf: [
      { required: ['area'] },
      { required: ['centerLatitude', 'centerLongitude', 'radiusMeters'] },
      { required: ['areaField'] },
    ],
    dependencies: {
      centerLatitude: ['centerLongitude', 'radiusMeters'],
      centerLongitude: ['centerLatitude', 'radiusMeters'],
      radiusMeters: ['centerLatitude', 'centerLongitude'],
      areaSelect: ['areaField'],
      maxHeightMeters: { required: ['heightDatum'], properties: { expect: { const: 'inside' } } },
      heightDatum: ['maxHeightMeters'],
      accuracyField: ['maxAccuracyMeters'],
      maxAccuracyMeters: ['accuracyField'],
    },
  },
  evaluate: (params, inputs) => assessPositions(params, inputs, current(inputs.positions, params.select)).result,
};

function unplacedDetails(params: PositionInAreaParams): CheckDetails {
  return {
    areaShape: null,
    marginMeters: params.marginMeters ?? 0,
    positionsChecked: 0,
    unusablePositions: 0,
    heightsUnchecked: null,
    latestDistanceOutsideMeters: null,
    excursionStartedAt: null,
    excursionLastAt: null,
    excursionSeconds: null,
    excursionPositions: null,
    maxDistanceOutsideMeters: null,
    maxHeightAboveLimitMeters: null,
  };
}

/** What placing the positions found: the result, and the runs and positions behind it when any were placed. */
interface Assessment {
  result: CheckResult;
  runs: Excursion[];
  placed: Placed[];
  counted: Excursion[];
}

function assessPositions(
  params: PositionInAreaParams,
  inputs: CheckInputs,
  selected: readonly CheckObservation[],
  details: CheckDetails = {},
): Assessment {
  const settled = (result: CheckResult): Assessment => ({ result, runs: [], placed: [], counted: [] });
  const margin = params.marginMeters ?? 0;
  Object.assign(details, unplacedDetails(params));
  const found = statedArea(params, inputs);
  if ('problem' in found) {
    const areaLabel = labelOf(params.areaField ?? 'area', current(inputs.area, params.areaSelect), params.areaSelect);
    const leftOutWords = found.leftOut?.length ? ` ${found.leftOut.join('; ')}.` : '';
    const words: Record<string, [CheckResult['evidenceState'], string]> = {
      area_missing: [
        'insufficient',
        params.areaRecords ? 'No operating area is on file.' : `No area is recorded for ${areaLabel}.`,
      ],
      area_invalid: [
        'insufficient',
        params.areaRecords || params.areas
          ? `No ${params.areas ? 'area the rule lists' : 'operating area on file'} states a shape a position can be placed against:${leftOutWords}`
          : 'The area is not a circle or polygon within the coordinate profile, so no position is placed against it.',
      ],
      areas_disagree: ['conflicting', `Observations at the same time state different areas for ${areaLabel}.`],
    };
    const [state, summary] = words[found.problem]!;
    return settled(
      result(state, state === 'conflicting' ? 'attention' : 'pending', found.problem, summary, found.evidence, details),
    );
  }
  const single = 'area' in found ? found.area : undefined;
  const recorded = 'areas' in found ? found.areas : [];
  details.areaShape = single ? single.shape : params.areas ? 'listed_areas' : 'recorded_areas';
  const leftOutNote =
    'leftOut' in found && found.leftOut?.length
      ? ` Left out, as no position can be placed against them: ${found.leftOut.join('; ')}.`
      : '';
  /** How far a point is outside the area, or every recorded area in force at its time; Infinity with none in force. */
  const outsideOf = (point: Point, at: number): number => {
    if (single) return signedDistance(single, point);
    const inForce = recorded.filter((item) => item.from <= at && at < item.until);
    return inForce.length ? Math.min(...inForce.map((item) => signedDistance(item.area, point))) : Infinity;
  };
  const statedWords = single
    ? areaWords(single, params.textUnit)
    : params.areas
      ? `${recorded.length === 1 ? 'the area' : 'any of the areas'} the rule lists (${[...new Set(recorded.map((item) => item.id))].sort(byId).join(', ')})`
      : `every operating area in force (${namedAreas(recorded)})`;
  const reasons = new Map(selected.map((observation) => [observation, unusableBecause(observation, params)]));
  const unusable = selected.filter((observation) => reasons.get(observation) !== undefined);
  details.unusablePositions = unusable.length;
  const unusableNote = unusable.length
    ? ` ${unusable.length} position(s) left out as unusable: ${unusable.map((item) => `${item.id} (${reasons.get(item)})`).join(', ')}.`
    : '';
  const usable = selected.filter((observation) => reasons.get(observation) === undefined);
  if (!usable.length)
    return settled(
      result(
        'insufficient',
        'pending',
        selected.length ? 'positions_unusable' : 'positions_missing',
        `No usable position is recorded to place against ${statedWords}.${unusableNote}${leftOutNote}`,
        [...found.evidence, ...unusable],
        details,
      ),
    );
  const placed: Placed[] = usable
    .map((observation) => {
      const point = {
        latitude: observationField(observation, 'position.latitudeDegrees') as number,
        longitude: observationField(observation, 'position.longitudeDegrees') as number,
      };
      const at = Date.parse(spanStart(observation));
      const outside = outsideOf(point, at) - margin;
      const beyond = params.expect === 'inside' ? outside : -outside;
      const above = heightAbove(observation, params);
      const away =
        params.expect === 'inside'
          ? outside > numericalMargin || (above !== undefined && above > 0)
          : outside <= numericalMargin;
      return { observation, at, beyond, above, away, outside };
    })
    .sort((a, b) => a.at - b.at || (a.observation.id < b.observation.id ? -1 : 1));
  details.positionsChecked = placed.length;
  if (params.maxHeightMeters !== undefined)
    details.heightsUnchecked = placed.filter((position) => position.above === undefined).length;
  const newest = placed.at(-1)!;
  details.latestDistanceOutsideMeters = Number.isFinite(newest.outside) ? round2(newest.outside) : null;
  const runs = excursions(placed);
  const ongoing = newest.away ? runs.at(-1) : undefined;
  const checked = params.scope === 'any' ? runs : ongoing ? [ongoing] : [];
  const countedRuns = checked.filter((run) => counts(run, params));
  const counted = countedRuns[0];
  const assessed = (result: CheckResult): Assessment => ({ result, runs, placed, counted: countedRuns });
  const side = params.expect === 'inside' ? 'outside' : 'inside';
  const meters = (value: unknown) => quantityText(Number(value), 'm', params.textUnit);
  const against = `${statedWords}${margin ? ` grown by ${meters(margin)}` : ''}`;
  if (counted) {
    describeExcursion(counted, details);
    const height =
      details.maxHeightAboveLimitMeters !== null && Number(details.maxHeightAboveLimitMeters) > 0
        ? `, up to ${meters(details.maxHeightAboveLimitMeters)} above ${meters(params.maxHeightMeters)}`
        : '';
    return assessed(
      result(
        'supported',
        'attention',
        'excursion',
        `${counted.positions.length} position(s) from ${details.excursionStartedAt} to ${details.excursionLastAt} were ${side} ${against}, ${reach(counted, params.textUnit)}${height}.${unusableNote}${leftOutNote}`,
        [...found.evidence, ...counted.positions.map((position) => position.observation)],
        details,
      ),
    );
  }
  if (ongoing) {
    describeExcursion(ongoing, details);
    return assessed(
      result(
        'insufficient',
        'pending',
        'excursion_unconfirmed',
        `${ongoing.positions.length} position(s) since ${details.excursionStartedAt} are ${side} ${against}, fewer or shorter than an excursion counts.${unusableNote}${leftOutNote}`,
        [...found.evidence, ...ongoing.positions.map((position) => position.observation)],
        details,
      ),
    );
  }
  const none = params.scope === 'any' ? ` No excursion among ${placed.length} usable position(s) counts.` : '';
  return assessed(
    result(
      'supported',
      'pass',
      params.expect === 'inside' ? 'positions_inside' : 'positions_outside',
      `The newest usable position is ${params.expect} ${against}.${none}${unusableNote}${leftOutNote}`,
      [...found.evidence, ...(params.scope === 'latest' ? [newest.observation] : usable)],
      details,
    ),
  );
}

// Positions inside, or outside, an area within a window, version 2 -------------------------------------------------

export interface PositionInAreaV2Params extends PositionInAreaParams, WindowParams {
  coverage?: 'required' | 'optional';
}

/** When a counted excursion began and ended: at the first position back on the right side, or at its last position. */
function excursionTime(run: Excursion, placed: readonly Placed[], ended: boolean): IssueTime {
  const first = run.positions[0]!;
  const last = run.positions.at(-1)!;
  const after = placed[placed.indexOf(last) + 1];
  const start = iso(first.at);
  const issue = `excursion-from:${start}`;
  if (after) return { issue, start, end: iso(after.at) };
  return ended ? { issue, start, end: iso(last.at) } : { issue, start };
}

const v2DetailWords: Record<string, string> = {
  areaShape:
    'circle, polygon or corridor; recorded_areas when the areas are read from area records; listed_areas when the rule lists several; null when no area was read.',
  latestDistanceOutsideMeters:
    'How far the newest usable position is outside the area grown by the margin, in meters; negative inside. Null when none, or when no area record was in force at its time.',
  maxDistanceOutsideMeters:
    'Over the excursion, the greatest distance on the wrong side of the area grown by the margin, in meters; null when none, or when no area record was in force at any of its positions.',
};
const v1Details = positionInAreaV1.details!.map((detail) =>
  v2DetailWords[detail.name] ? { ...detail, description: v2DetailWords[detail.name]! } : detail,
);
const v1Schema = positionInAreaV1.parameterSchema as {
  properties: Record<string, unknown>;
  dependencies: Record<string, unknown>;
};
const pointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['latitude', 'longitude'],
  properties: { latitude: latitudeSchema, longitude: longitudeSchema },
} as const;
const areaIdSchema = { type: 'string', minLength: 1, maxLength: 100 } as const;
const areaSizeSchema = { type: 'number', exclusiveMinimum: 0, maximum: OPERATING_AREA_SIZE_LIMIT_METERS } as const;
const listedAreasSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'center', 'radiusMeters'],
        properties: { id: areaIdSchema, center: pointSchema, radiusMeters: areaSizeSchema },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'points', 'halfWidthMeters'],
        properties: {
          id: areaIdSchema,
          points: { type: 'array', minItems: 2, maxItems: 200, items: pointSchema },
          halfWidthMeters: areaSizeSchema,
        },
      },
    ],
  },
} as const;
const areaRecordsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['idField', 'shapeField', 'centerField', 'radiusField', 'pointsField', 'halfWidthField'],
  properties: {
    idField: fieldPath,
    shapeField: fieldPath,
    centerField: fieldPath,
    radiusField: fieldPath,
    pointsField: fieldPath,
    halfWidthField: fieldPath,
  },
} as const;

export const positionInAreaV2: CheckKind<PositionInAreaV2Params> = {
  ...positionInAreaV1,
  version: 2,
  description: `As version 1, within a window, with each counted excursion named, and with areas read from area records. Each selected position (the observation’s WGS84 position) is placed against an area: a circle or a GeoJSON polygon fixed in the rule, a circle whose centre and radius the organization sets, the circle or polygon in a field of the latest selected area observation, or, with areaRecords, every selected area record in force at the position’s time (its interval holds the time; no end is in force from its start on), a position inside any one of them being inside, or, with areas, every circle or corridor the rule lists by its id, in force at every time, a position inside any one of them being inside. An area record states its id, its shape (circle or corridor), a circle’s centre as latitude, longitude in decimal degrees and its radius, or a corridor’s points along its line, separated by semicolons, and its half-width; a radius or half-width above ${OPERATING_AREA_SIZE_LIMIT_METERS} m, or a record whose area cannot be read, is named and left out. A corridor is every place within its half-width of the geodesic line through its points. A position with no area record in force at its time is outside, at no stated distance. The area is closed, grown by marginMeters (shrunk when negative), and measured by geodesic distance on the WGS84 ellipsoid; positions within a millimetre of its boundary are on it. With expect inside a position is away when it is outside the area or, with maxHeightMeters, its height in heightDatum is above that height; with expect outside it is away when it is inside the area. Consecutive away positions make an excursion, which counts only with at least minPositions positions and minSeconds from its first to its last position. With scope latest the excursion still going on at the newest position is checked; with any, every excursion among the positions read. When the rule reads a window (an observation, operator record or subject state, by its start and end fields, default its interval; both ends belong to it), only positions whose span start falls in it are placed; a window with no stated end, or whose end is after the evaluation time, is open and the result covers the positions so far and says so. A window with no valid start, or simultaneous windows that disagree, are insufficient or conflicting. A window with no position is insufficient with coverage required (the default); with coverage optional it does not apply, whether the window has closed or is still open, and a position that arrives later is placed as usual. Each counted excursion is one issue, named and timed by its first position; it ends at the first position back on the right side, or at its last position once the window has closed, and continues otherwise. A counted excursion needs attention; one not yet long enough is pending. Positions outside the coordinate profile, matching an unusable condition or stating an accuracy worse than maxAccuracyMeters are left out and counted. No area, an invalid area or no usable position is insufficient; simultaneous areas that disagree conflict.`,
  inputs: [
    ...positionInAreaV1.inputs,
    {
      name: 'window',
      description: 'An observation, operator record or subject state stating the window, such as takeoff to landing.',
      optional: true,
    },
  ],
  details: [
    ...v1Details,
    ...windowDetailDefinitions,
    { name: 'excursionCount', description: 'How many excursions count.' },
    {
      name: 'secondsOutside',
      description: 'The total length of the counted excursions, in seconds, each from its first position to its end.',
    },
  ],
  summaryValues: [...positionInAreaV1.summaryValues!, 'windowStart', 'windowEnd'],
  issues: {
    description: 'One counted excursion, named by when its first position was reported.',
    timed:
      'An excursion starts at its first position and ends at the first position back on the right side; with none, at its last position once the window has closed, and it continues otherwise.',
  },
  parameterSchema: {
    ...positionInAreaV1.parameterSchema,
    properties: {
      ...v1Schema.properties,
      areaRecords: areaRecordsSchema,
      areas: listedAreasSchema,
      ...windowParameterSchema,
      coverage: { enum: ['required', 'optional'] },
      textUnit: textUnitSchema,
    },
    oneOf: [
      { required: ['area'] },
      { required: ['centerLatitude', 'centerLongitude', 'radiusMeters'] },
      { required: ['areaField'] },
      { required: ['areaRecords'] },
      { required: ['areas'] },
    ],
    dependencies: {
      ...v1Schema.dependencies,
      areaSelect: { anyOf: [{ required: ['areaField'] }, { required: ['areaRecords'] }] },
    },
  },
  evaluate(params, inputs, clock) {
    const now = utcMillis(clock.evaluatedAt)!;
    const details: CheckDetails = {
      ...unplacedDetails(params),
      ...windowDetails(undefined),
      excursionCount: null,
      secondsOutside: null,
    };
    const named = (result: CheckResult, issueTimes: IssueTime[] = []): CheckResult => ({
      ...result,
      details,
      issues: issueTimes.map((time) => time.issue),
      issueTimes,
    });
    let window: ObservedWindow | undefined;
    if (inputs.window !== undefined) {
      const found = observedWindow(inputs, params, now);
      if ('problem' in found)
        return named(
          found.problem === 'windows_disagree'
            ? result(
                'conflicting',
                'attention',
                'windows_disagree',
                'Observations at the same time state different windows.',
                found.evidence,
                details,
              )
            : result(
                'insufficient',
                'pending',
                'window_missing',
                'No window with a valid start, and an end not before it, is recorded.',
                found.evidence,
                details,
              ),
        );
      window = found.window;
      Object.assign(details, windowDetails(window));
    }
    const selected = current(inputs.positions, params.select).filter(
      (observation) => !window || inWindow(window, Date.parse(spanStart(observation)), now),
    );
    const span = window
      ? ` in the window from ${iso(window.start)} ${window.closed ? `to ${iso(window.end!)}` : 'so far, the window still open'}`
      : '';
    if (window && !selected.length && params.coverage === 'optional')
      return named(
        result(
          'not_applicable',
          'not_applicable',
          'no_positions_in_window',
          `No position is reported${span}.`,
          window.evidence,
          details,
        ),
      );
    const assessed = assessPositions(params, inputs, selected, details);
    const issueTimes = assessed.counted.map((run) =>
      excursionTime(run, assessed.placed, window ? window.closed : false),
    );
    if (assessed.placed.length)
      Object.assign(details, {
        excursionCount: issueTimes.length,
        secondsOutside: round(
          issueTimes.reduce((sum, time) => sum + (Date.parse(time.end ?? time.start) - Date.parse(time.start)), 0) /
            1000,
        ),
      });
    const evidence = [...(window?.evidence ?? []).map((item) => item.id), ...assessed.result.evidence];
    const counted = issueTimes.length > 1 ? ` ${issueTimes.length} excursions count.` : '';
    return named(
      {
        ...assessed.result,
        summary: `${assessed.result.summary}${counted}${span ? ` Positions read${span}.` : ''}`,
        evidence: [...new Set(evidence)],
        ...(window && !window.closed && window.end !== undefined ? { nextBoundary: iso(window.end) } : {}),
      },
      issueTimes,
    );
  },
};

export const geometryCheckKinds: readonly CheckKind[] = [positionInAreaV1, positionInAreaV2];
for (const kind of geometryCheckKinds) registerCheckKind(kind);
