export interface Coordinate {
  latitude: number;
  longitude: number;
}
export interface GeographicView {
  referenceLongitude: number;
  west: number;
  east: number;
  south: number;
  north: number;
}
export interface MapFrame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export const mapFrame: MapFrame = { width: 720, height: 350, left: 62, right: 40, top: 24, bottom: 42 };

export function unwrapLongitude(value: number, reference: number) {
  return reference + ((value - reference + 540) % 360) - 180;
}

export function fitCoordinates(points: Coordinate[], frame: MapFrame = mapFrame): GeographicView | null {
  if (!points.length) return null;
  const referenceLongitude = points[0]!.longitude;
  const longitudes = points.map((point) => unwrapLongitude(point.longitude, referenceLongitude));
  const latitudes = points.map((point) => point.latitude);
  const west = Math.min(...longitudes),
    east = Math.max(...longitudes);
  const south = Math.min(...latitudes),
    north = Math.max(...latitudes);
  const centerLatitude = (north + south) / 2,
    centerLongitude = (east + west) / 2;
  const aspect = (frame.width - frame.left - frame.right) / (frame.height - frame.top - frame.bottom);
  const latitudeScale = Math.max(0.05, Math.cos((centerLatitude * Math.PI) / 180));
  let latitudeSpan = Math.max(0.002, north - south) * 1.35;
  let longitudeSpan = Math.max(0.002 / latitudeScale, east - west) * 1.35;
  if ((longitudeSpan * latitudeScale) / latitudeSpan < aspect) longitudeSpan = (latitudeSpan * aspect) / latitudeScale;
  else latitudeSpan = (longitudeSpan * latitudeScale) / aspect;
  return {
    referenceLongitude,
    west: centerLongitude - longitudeSpan / 2,
    east: centerLongitude + longitudeSpan / 2,
    south: Math.max(-90, centerLatitude - latitudeSpan / 2),
    north: Math.min(90, centerLatitude + latitudeSpan / 2),
  };
}

export function projectCoordinate(point: Coordinate, view: GeographicView, frame: MapFrame = mapFrame) {
  const longitude = unwrapLongitude(point.longitude, view.referenceLongitude);
  const x = frame.left + ((longitude - view.west) / (view.east - view.west)) * (frame.width - frame.left - frame.right);
  const y =
    frame.top + ((view.north - point.latitude) / (view.north - view.south)) * (frame.height - frame.top - frame.bottom);
  const inside =
    longitude >= view.west && longitude <= view.east && point.latitude >= view.south && point.latitude <= view.north;
  return { x, y, inside };
}

export function coordinateLabel(value: number, axis: 'latitude' | 'longitude', precision = 4) {
  const normalized = axis === 'longitude' ? ((value + 540) % 360) - 180 : value;
  return `${Math.abs(normalized).toFixed(precision)}° ${axis === 'latitude' ? (normalized < 0 ? 'S' : 'N') : normalized < 0 ? 'W' : 'E'}`;
}

export function unprojectCoordinate(
  point: { x: number; y: number },
  view: GeographicView,
  frame: MapFrame = mapFrame,
): Coordinate {
  const longitude =
    view.west + ((point.x - frame.left) / (frame.width - frame.left - frame.right)) * (view.east - view.west);
  return {
    longitude: ((longitude + 540) % 360) - 180,
    latitude: Math.max(
      -85,
      Math.min(
        85,
        view.north - ((point.y - frame.top) / (frame.height - frame.top - frame.bottom)) * (view.north - view.south),
      ),
    ),
  };
}

export function offsetCoordinate(center: Coordinate, east: number, north: number): Coordinate {
  const radians = Math.PI / 180;
  const latitude = center.latitude * radians;
  const eccentricitySquared = 0.0066943799901413165;
  const denominator = 1 - eccentricitySquared * Math.sin(latitude) ** 2;
  const meridianRadius = (6378137 * (1 - eccentricitySquared)) / denominator ** 1.5;
  const transverseRadius = 6378137 / Math.sqrt(denominator);
  return {
    latitude: Math.max(-85, Math.min(85, center.latitude + north / meridianRadius / radians)),
    longitude: ((center.longitude + east / (transverseRadius * Math.cos(latitude)) / radians + 540) % 360) - 180,
  };
}

export function displayDistance(left: Coordinate, right: Coordinate): number {
  const radians = Math.PI / 180;
  const latitude = ((left.latitude + right.latitude) / 2) * radians;
  return (
    Math.hypot(
      (right.latitude - left.latitude) * radians,
      (unwrapLongitude(right.longitude, left.longitude) - left.longitude) * Math.cos(latitude) * radians,
    ) * 6371008.8
  );
}

export function circleCoordinates(center: Coordinate, radiusMeters: number): Coordinate[] {
  return Array.from({ length: 64 }, (_, index) => {
    const angle = (index / 64) * Math.PI * 2;
    return offsetCoordinate(center, Math.cos(angle) * radiusMeters, Math.sin(angle) * radiusMeters);
  });
}

export function zoomGeographicView(view: GeographicView, factor: number, center?: Coordinate): GeographicView {
  const longitude = center ? unwrapLongitude(center.longitude, view.referenceLongitude) : (view.west + view.east) / 2;
  const latitude = center?.latitude ?? (view.north + view.south) / 2;
  const next = {
    referenceLongitude: view.referenceLongitude,
    west: longitude + (view.west - longitude) * factor,
    east: longitude + (view.east - longitude) * factor,
    south: latitude + (view.south - latitude) * factor,
    north: latitude + (view.north - latitude) * factor,
  };
  if (next.east - next.west > 360 || next.north > 85 || next.south < -85 || next.north - next.south < 0.00005)
    return view;
  return next;
}

export function fitViewAspect(view: GeographicView, frame: MapFrame): GeographicView {
  const latitude = (view.north + view.south) / 2;
  const longitude = (view.west + view.east) / 2;
  const aspect = (frame.width - frame.left - frame.right) / (frame.height - frame.top - frame.bottom);
  const latitudeScale = Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
  const latitudeSpan = Math.max(view.north - view.south, ((view.east - view.west) * latitudeScale) / aspect);
  const longitudeSpan = (latitudeSpan * aspect) / latitudeScale;
  return {
    ...view,
    west: longitude - longitudeSpan / 2,
    east: longitude + longitudeSpan / 2,
    south: latitude - latitudeSpan / 2,
    north: latitude + latitudeSpan / 2,
  };
}

/**
 * Of the circles given, those that reach into the view, in their order and at most the limit, with how many more reach
 * into it. A circle reaches into the view when its centre or a point of its edge lies inside it.
 */
export function circlesInView<T extends { center: Coordinate; radiusMeters: number }>(
  circles: readonly T[],
  view: GeographicView,
  limit: number,
  frame: MapFrame = mapFrame,
): { shown: T[]; more: number } {
  const inside = circles.filter(
    (circle) =>
      projectCoordinate(circle.center, view, frame).inside ||
      circleCoordinates(circle.center, circle.radiusMeters).some(
        (point) => projectCoordinate(point, view, frame).inside,
      ),
  );
  return { shown: inside.slice(0, limit), more: Math.max(0, inside.length - limit) };
}
