export interface Coordinate {
  latitude: number;
  longitude: number;
}

export const places: Record<string, Coordinate> = {
  'Eastside Clinic': { latitude: 41.8844, longitude: -87.62155 },
  'Mercy North': { latitude: 41.89365, longitude: -87.64005 },
  'Ridge Pharmacy': { latitude: 41.88665, longitude: -87.64655 },
  'Harbor Street Depot': { latitude: 41.87915, longitude: -87.62355 },
  'Northgate Station': { latitude: 41.8974, longitude: -87.6323 },
  'Willow Court': { latitude: 41.8889, longitude: -87.6538 },
  'Southbank Clinic': { latitude: 41.87665, longitude: -87.6343 },
  'Riverside Yard': { latitude: 41.88265, longitude: -87.66155 },
  'Route 9': { latitude: 41.8734, longitude: -87.64805 },
  Oakview: { latitude: 41.89065, longitude: -87.62605 },
  'Canal Market': { latitude: 41.88115, longitude: -87.64105 },
  'Lakeshore Pool': { latitude: 41.89515, longitude: -87.65105 },
  'Westfield Lab': { latitude: 41.8874, longitude: -87.6573 },
  'Feeder 12': { latitude: 41.89965, longitude: -87.64105 },
  Hilltop: { latitude: 41.89665, longitude: -87.65605 },
  'Mile 41': { latitude: 41.87765, longitude: -87.65855 },
  'Array C': { latitude: 41.86965, longitude: -87.63855 },
  'Elm Park': { latitude: 41.8859, longitude: -87.63605 },
  'Grid 3': { latitude: 41.89215, longitude: -87.62855 },
  'Dock 1': { latitude: 41.87515, longitude: -87.62855 },
};

const flightCount = /^\d+ of \d+$/;

export const yards: Record<string, Coordinate & { name: string }> = {
  'tenant-alpha': { name: 'Alpha yard', latitude: 41.88, longitude: -87.63 },
  'tenant-beta': { name: 'Inspection yard', latitude: 41.87, longitude: -87.65 },
};

export function missionPlace(label: string) {
  const parts = label
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.find((part) => places[part]) ?? parts.filter((part) => !flightCount.test(part)).at(-1) ?? label;
}

export function locate(label: string, yard: Coordinate) {
  const name = missionPlace(label);
  const known = places[name];
  if (known) return { name, coordinate: known, named: true };
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const turn = ((hash >>> 0) % 360) * (Math.PI / 180);
  const distance = 0.015 + ((hash >>> 0) % 80) / 8000;
  const latitudeScale = Math.max(0.2, Math.cos((yard.latitude * Math.PI) / 180));
  return {
    name,
    named: false,
    coordinate: {
      latitude: yard.latitude + Math.sin(turn) * distance,
      longitude: yard.longitude + (Math.cos(turn) * distance) / latitudeScale,
    },
  };
}
