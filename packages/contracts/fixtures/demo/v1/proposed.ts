import { identity } from './ready.js';
export {
  commandLinkLossSource,
  commandLinkRestorationSource,
  commandLinkLoss as proposedCommandLinkLoss,
  commandLinkRestoration as proposedCommandLinkRestoration,
} from './command-link.js';
export { monitoringSource } from './monitoring-window.js';

// Review examples only; these types are not API request schemas or enabled receipt kinds.
export interface VersionRef {
  id: string;
  version: number;
}
export interface Interval {
  start: string;
  end: string;
}
export interface Geometry {
  coordinateReference: 'WGS84';
  coordinateOrder: 'longitude_latitude';
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | {
        type: 'Polygon';
        coordinates: [number, number][][];
      };
}
export interface Mission {
  ref: VersionRef;
  intentId: string;
  attempt: number;
  aircraftId: string;
  siteRefs: VersionRef[];
  route: Geometry;
  lateralToleranceMeters: number;
  altitude: { minimum: number; maximum: number; unit: 'm'; reference: 'AGL' };
  operatingInterval: Interval;
}
export interface LinkObservation {
  sourceId: string;
  sourceSessionId: string;
  deviceId: string;
  sourceEventId: string;
  incidentId: string;
  missionRef: VersionRef;
  originationKey: string;
  occurredAt: string;
  effectiveAt: string;
  status: 'lost' | 'restored';
  artifactId: string;
}

export const profile = {
  id: 'alpha-certificate-demo.1',
  status: 'proposed',
  operator: 'Alpha Dispatch',
  operatingScope: 'Fictional certificate holder, short local delivery routes',
  targetConcurrentFlights: 25,
  retainedOperatingHours: 8,
  fleetAircraft: 32,
  staffing: { coordinators: 5, maximumActiveFlightsPerCoordinator: 5, safetyLead: 1, groundCrew: 4 },
  procedurePackRef: { id: 'alpha-demo-procedures', version: 1 },
  adoption: 'pending',
};

export const clock = {
  ref: { id: 'demo-71031:clock', version: 1 },
  mode: 'accelerated',
  evaluatedAt: '2026-10-15T14:20:00Z',
  wallAnchor: '2026-10-15T14:00:00Z',
  scenarioAnchor: '2026-10-15T14:00:00Z',
  scenarioSecondsPerWallSecond: 10,
  paused: false,
};

export const site = {
  ref: { id: 'demo-71031:site:eastside', version: 1 },
  name: 'Eastside Clinic',
  effectiveInterval: { start: '2026-10-15T14:00:00Z', end: '2026-10-15T22:00:00Z' },
  footprint: {
    coordinateReference: 'WGS84',
    coordinateOrder: 'longitude_latitude',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-87.622, 41.884],
          [-87.621, 41.884],
          [-87.621, 41.885],
          [-87.622, 41.884],
        ],
      ],
    },
  } satisfies Geometry,
};

export const mission = {
  ref: { id: 'demo-71031:mission:1', version: 1 },
  intentId: identity.intentId,
  attempt: 1,
  aircraftId: 'demo-71031:aircraft:1',
  siteRefs: [site.ref],
  route: {
    coordinateReference: 'WGS84',
    coordinateOrder: 'longitude_latitude',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-87.63, 41.88],
        [-87.62155, 41.8844],
      ],
    },
  },
  lateralToleranceMeters: 30,
  altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
  operatingInterval: { start: '2026-10-15T14:05:00Z', end: '2026-10-15T14:20:00Z' },
} satisfies Mission;

export const commandLink = {
  sourceId: 'command-link',
  sourceSessionId: 'demo-71031:link:capture:1',
  deviceId: mission.aircraftId,
  sourceEventId: 'link-event:1',
  incidentId: 'demo-71031:incident:regional-link:1',
  missionRef: mission.ref,
  originationKey: identity.originationKey,
  occurredAt: '2026-10-15T14:12:00Z',
  effectiveAt: '2026-10-15T14:12:00Z',
  status: 'lost',
  artifactId: 'resolved-link-artifact-1',
} satisfies LinkObservation;

export const report = {
  ref: { id: 'demo-71031:report:1', version: 1 },
  missionRef: mission.ref,
  incidentId: commandLink.incidentId,
  occurredAt: commandLink.occurredAt,
  narrative: 'Command link dropped near the clinic approach. Aircraft held position until recovery.',
  attribution: 'protected',
  disclosure: 'capability_checked_and_audited',
};

export const control = {
  ref: { id: 'demo-71031:control:1', version: 2 },
  assessmentRef: { id: 'demo-71031:assessment:1', version: 1 },
  matrixRef: { id: 'alpha-demo-matrix', version: 1 },
  procedureLeafRef: { id: 'alpha-demo-procedures:link-avoidance', version: 1 },
  siteRef: site.ref,
  excludedFootprint: site.footprint,
  bufferMeters: 150,
  effectiveInterval: { start: '2026-10-15T14:30:00Z', end: '2026-10-15T22:00:00Z' },
  ownerPrincipalId: 'resolved-safety-lead',
};

export interface ReleaseProposal {
  missionRef: VersionRef;
  controlRefs: VersionRef[];
  assessmentRef: VersionRef;
  matrixRef: VersionRef;
  clockRef: VersionRef;
  evaluatedAt: string;
  validUntil: string;
  expectedDependencyBasis: string;
}

export const release = {
  missionRef: { id: 'demo-71031:mission:2', version: 2 },
  controlRefs: [control.ref],
  assessmentRef: control.assessmentRef,
  matrixRef: control.matrixRef,
  clockRef: clock.ref,
  evaluatedAt: '2026-10-15T14:31:00Z',
  validUntil: '2026-10-15T14:35:00Z',
  expectedDependencyBasis: 'c'.repeat(64),
} satisfies ReleaseProposal;

export { missionBriefingAcknowledgementCommand as acknowledgement } from './mission-briefing.js';
