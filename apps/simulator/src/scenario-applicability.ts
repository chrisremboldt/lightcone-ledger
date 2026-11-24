import type { LedgerClient } from '@ledger/adapters';
import { ApiError } from '@ledger/contracts/client';
import {
  missionBriefingControls,
  type FlightControlsResponse,
  type MissionBriefingRecordResponse,
  type MissionReleaseRecordResponse,
  type MissionSource,
  type Principal,
  type ReceiptResponse,
  type SmsRecordDetailResponse,
  type SmsSigningPreviewResponse,
  type TimelineResponse,
} from '@ledger/contracts';
import { reviewedMissionReleaseCalculation, reviewedMissionReleasePolicy } from './mission-release-plan.js';

// The simulated day's far area controls. A safety lead of the fictional Alpha tenant records one fictional hazard with
// three avoidance areas that each declare a reach, placed well away from the one route the day releases, and accepts
// the risk with them in place. The day then releases that route, and its self-check reads back through the public API
// that every release of the tenant's flights records the three as not applying, and that no briefing lists them.

/** The rule the area control type declares; a control it finds not to apply names it in its record. */
export const areaReachRule = { id: 'ledger.control-applicability.area-reach', version: 1 } as const;
/** A degree of latitude spans at least this many metres on the WGS84 ellipsoid (at the equator). */
const METRES_PER_DEGREE_LATITUDE_AT_LEAST = 110_574;

const firstPosition = { latitude: 41.8792, longitude: -87.6236 };
export const farControlRoute: MissionSource['route'] = {
  coordinateReference: 'WGS84',
  coordinateOrder: 'longitude_latitude',
  segmentInterpolation: 'linear_longitude_latitude',
  geometry: {
    type: 'LineString',
    coordinates: [
      [firstPosition.longitude, firstPosition.latitude],
      [-87.6236, 41.8832],
      [-87.6176, 41.8832],
    ],
  },
};
/** An upper bound of the route's length: no point of the route is farther than this from its first position. */
export const FAR_CONTROL_ROUTE_EXTENT_METERS = 1_500;
export const FAR_CONTROL_LATERAL_TOLERANCE_METERS = 30;

export interface FarControlPlacement {
  title: string;
  latitudeOffsetDegrees: number;
  radiusMeters: number;
  appliesWithinMeters: number;
}
/** Each area lies due north or south of the route's first position; the reach is far shorter than the distance. */
export const farControlPlacements: readonly FarControlPlacement[] = Object.freeze([
  {
    title: 'Fictional far-field area north (simulated day)',
    latitudeOffsetDegrees: 0.2,
    radiusMeters: 400,
    appliesWithinMeters: 1_000,
  },
  {
    title: 'Fictional far-field area south (simulated day)',
    latitudeOffsetDegrees: -0.25,
    radiusMeters: 400,
    appliesWithinMeters: 1_000,
  },
  {
    title: 'Fictional far-field area far north (simulated day)',
    latitudeOffsetDegrees: 0.3,
    radiusMeters: 600,
    appliesWithinMeters: 2_000,
  },
]);

export function farControlCenter(placement: FarControlPlacement) {
  return {
    latitude: Number((firstPosition.latitude + placement.latitudeOffsetDegrees).toFixed(6)),
    longitude: firstPosition.longitude,
  };
}
/** A lower bound of the geodesic distance from the route's first position to the area's centre. */
export function farControlPlacedAtMeters(placement: FarControlPlacement): number {
  return Math.floor(Math.abs(placement.latitudeOffsetDegrees) * METRES_PER_DEGREE_LATITUDE_AT_LEAST);
}
/**
 * The least clearance from the planned corridor to the area's edge the placement allows: the distance it was placed
 * at, less the route's extent, the area's radius and the corridor's tolerance.
 */
export function farControlMinimumClearance(placement: FarControlPlacement): number {
  return Math.floor(
    farControlPlacedAtMeters(placement) -
      FAR_CONTROL_ROUTE_EXTENT_METERS -
      placement.radiusMeters -
      FAR_CONTROL_LATERAL_TOLERANCE_METERS,
  );
}

export interface RecordedFarControl {
  controlId: string;
  minimumClearanceMeters: number;
}
export interface FarControlObservation {
  controls: RecordedFarControl[];
  releases: MissionReleaseRecordResponse[];
  briefings: MissionBriefingRecordResponse[];
  controlLists: FlightControlsResponse[];
  /** The far control records and releases the other tenant could read. */
  otherTenantVisible: string[];
}
export const farControlAssertionName =
  'far area controls with a reach are recorded as not applying, no briefing lists them and the second tenant sees none';

/** Every problem found, as `release or list : control : what`; none when the self-check holds. */
export function farControlProblems(observation: FarControlObservation): string[] {
  const problems: string[] = [];
  if (observation.controls.length !== farControlPlacements.length) problems.push('controls:not_accepted');
  if (!observation.releases.length) problems.push('releases:none_recorded');
  for (const { release } of observation.releases) {
    const avoidance = release.basis.avoidance;
    for (const control of observation.controls) {
      const at = `${release.id}:${control.controlId}`;
      if (avoidance.candidates.some((candidate) => candidate.controlId === control.controlId))
        problems.push(`${at}:candidate`);
      const entry = avoidance.notApplicable.find((row) => row.controlId === control.controlId);
      if (!entry) {
        problems.push(`${at}:not_recorded`);
        continue;
      }
      const record = entry.applicability;
      if (record.outcome !== 'does_not_apply') problems.push(`${at}:outcome_${record.outcome}`);
      if (record.basis !== 'rule') problems.push(`${at}:basis_${record.basis}`);
      if (record.rule?.id !== areaReachRule.id || record.rule.version !== areaReachRule.version)
        problems.push(`${at}:rule`);
      const clearance = record.measured.find((measure) => measure.name === 'clearanceAtLeastMeters');
      if (
        typeof clearance?.value !== 'number' ||
        clearance.unit !== 'm' ||
        clearance.value < control.minimumClearanceMeters
      )
        problems.push(`${at}:clearance`);
    }
  }
  for (const { briefing } of observation.briefings)
    for (const { reference } of missionBriefingControls(briefing))
      if (observation.controls.some((control) => control.controlId === reference.controlId))
        problems.push(`${briefing.id}:${reference.controlId}:briefed`);
  for (const list of observation.controlLists)
    for (const control of observation.controls) {
      if (list.controls.some((entry) => entry.control.id === control.controlId))
        problems.push(`${list.flightId}:${control.controlId}:listed_for_briefing`);
      if (!list.notApplicable.some((entry) => entry.control.id === control.controlId))
        problems.push(`${list.flightId}:${control.controlId}:not_listed_as_not_applying`);
    }
  for (const id of observation.otherTenantVisible) problems.push(`${id}:visible_to_second_tenant`);
  return problems;
}

export function assessFarControls(observation: FarControlObservation) {
  const actual = farControlProblems(observation);
  return { name: farControlAssertionName, expected: [], actual, passed: actual.length === 0 };
}

export interface FarControlDay {
  operator: LedgerClient;
  operatorToken: string;
  source: LedgerClient;
  otherTenant: LedgerClient;
  /** This run's flights of the tenant, besides the one the day releases. */
  flightIds: string[];
  key: (step: string) => string;
  /** Waits until the read value is ready, or fails the run. */
  eventually: <T>(description: string, read: () => Promise<T>, ready: (value: T) => boolean) => Promise<T>;
  now?: () => number;
}

type Accepted = { command: { id: string; subject?: { id: string } } };
const minute = 60_000;
const missionSourceId = 'simulation-mission-planner';

function post<T>(client: LedgerClient, path: string, body: unknown, key: string, headers: Record<string, string> = {}) {
  return client.request<T>(path, { method: 'POST', body: JSON.stringify(body), headers }, key);
}
const me = async (client: LedgerClient) => (await client.request<{ principal: Principal }>('/v1/me')).principal;

/** Grants what the day's release needs and returns a step that restores each principal's authority as it was. */
async function grantReleaseAuthority(day: FarControlDay): Promise<() => Promise<void>> {
  const restore: Array<() => Promise<void>> = [];
  // The operator holds authority:write and updates both principals, passing on every grant it does not change.
  const update = (
    current: Principal,
    capabilities: Principal['capabilities'],
    missionSources: string[],
    step: string,
  ) =>
    post(
      day.operator,
      '/v1/commands',
      {
        kind: 'authority.update',
        principalId: current.id,
        expectedRevision: current.revision,
        capabilities,
        missionSources,
        ...(current.monitoringSources ? { monitoringSources: current.monitoringSources } : {}),
        ...(current.observationGrants ? { observationGrants: current.observationGrants } : {}),
      },
      day.key(`far-controls:${step}:${current.id}`),
    );
  const grant = async (holder: LedgerClient, capabilities: Principal['capabilities'], missionSources: string[]) => {
    const before = await me(holder);
    const wanted = [...new Set([...before.capabilities, ...capabilities])];
    const sources = [...new Set([...before.missionSources, ...missionSources])];
    if (wanted.length === before.capabilities.length && sources.length === before.missionSources.length) return;
    await update(before, wanted, sources, 'grant');
    restore.unshift(async () => {
      await update(await me(holder), before.capabilities, before.missionSources, 'restore');
    });
  };
  const operator = await me(day.operator);
  const riskAuthority = operator.capabilities.some((value) =>
    ['risk:accept:medium', 'risk:accept:high'].includes(value),
  )
    ? []
    : (['risk:accept:medium'] as const);
  await grant(day.operator, ['mission:release', ...riskAuthority], []);
  await grant(day.source, ['mission:write'], [missionSourceId]);
  return async () => {
    for (const step of restore) await step();
  };
}

/** Opens the fictional hazard, proposes the three areas, assesses it with them in place and accepts the risk. */
async function acceptFarControls(
  day: FarControlDay,
  interval: { start: string; end: string },
): Promise<RecordedFarControl[]> {
  const ownerId = (await me(day.operator)).id;
  const record = (id: string) => day.operator.request<SmsRecordDetailResponse>(`/v1/sms/records/${id}`);
  const decide = async (hazardId: string, decision: Record<string, unknown>, step: string, headers = {}) => {
    const shown = await record(hazardId);
    await post(
      day.operator,
      '/v1/commands',
      {
        kind: 'decision.record',
        subject: { kind: 'sms', id: hazardId },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision,
      },
      day.key(step),
      headers,
    );
  };
  const hazard = await post<Accepted>(
    day.operator,
    '/v1/commands',
    {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: 'Fictional far-field hazard (simulated day)',
        ownerId,
        body: {
          description: 'Fictional sites well away from the simulated day’s route, kept clear by avoidance areas.',
          consequence: 'A fictional aircraft could enter a fictional site.',
          source: { kind: 'manual_identification' },
        },
      },
    },
    day.key('far-controls:hazard'),
  );
  const hazardId = hazard.command.subject!.id;
  const type = (await record(hazardId)).controlTypes!.find((entry) => entry.id === 'control.avoidance-area')!;
  const controls: RecordedFarControl[] = [];
  for (const [index, placement] of farControlPlacements.entries()) {
    const opened = await post<Accepted>(
      day.operator,
      '/v1/commands',
      {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: placement.title,
          ownerId,
          body: {
            hazardId,
            controlType: { id: type.id, version: type.version, digest: type.digest },
            parameters: {
              center: farControlCenter(placement),
              radiusMeters: placement.radiusMeters,
              appliesWithinMeters: placement.appliesWithinMeters,
            },
            effectiveFrom: interval.start,
            effectiveUntil: interval.end,
          },
        },
      },
      day.key(`far-controls:control:${index}`),
    );
    controls.push({
      controlId: opened.command.subject!.id,
      minimumClearanceMeters: farControlMinimumClearance(placement),
    });
  }
  const opened = await record(hazardId);
  await decide(
    hazardId,
    {
      kind: 'risk.assess',
      note: 'Assessed with the three fictional far-field avoidance areas in place.',
      matrix: { recordId: opened.matrix!.record.id, versionNumber: opened.matrix!.version.versionNumber },
      initial: { severity: 'major', likelihood: 'remote' },
      controls: controls.map(({ controlId }) => ({
        recordId: controlId,
        versionNumber: opened.controls!.find((control) => control.id === controlId)!.versionNumber,
      })),
      residual: { severity: 'minor', likelihood: 'remote' },
      newHazardCheck: { answer: 'none_identified' },
    },
    'far-controls:assess',
  );
  const assessmentId = (await record(hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!.id;
  const signing = await day.operator.request<SmsSigningPreviewResponse>(
    `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`,
  );
  if (!signing.available) throw new Error(`The far-field risk cannot be accepted: ${signing.reason ?? 'unavailable'}`);
  const { grant } = await post<{ grant: string }>(
    day.operator,
    '/v1/local/reauthentications',
    { credential: day.operatorToken },
    day.key('far-controls:reauthentication'),
  );
  await decide(
    hazardId,
    {
      kind: 'risk.accept',
      note: 'Residual risk accepted with the three fictional far-field avoidance areas in place.',
      assessmentId,
      signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
    },
    'far-controls:accept',
    { 'x-ledger-reauthentication': grant },
  );
  return controls;
}

/** Creates the day's released flight, records its mission and releases it once route review has every far control. */
async function releaseFarControlFlight(
  day: FarControlDay,
  interval: { start: string; end: string },
  controls: RecordedFarControl[],
): Promise<string> {
  const aircraft = 'aircraft-alpha-far-field';
  const { flight } = await day.operator.createFlight(
    {
      originationKey: day.key('far-controls:flight'),
      label: 'Fictional far-field release (simulated day)',
      aircraft,
      scheduledStart: interval.start,
      scheduledEnd: interval.end,
    },
    day.key('far-controls:flight'),
  );
  await day.eventually(
    `flight ${flight.id}`,
    () => day.operator.timeline(flight.id),
    (view) => view.flight.outstandingWork === 0,
  );
  const raw: MissionSource = {
    sourceRevision: 1,
    occurredAt: new Date((day.now ?? Date.now)()).toISOString(),
    sourceMissionId: day.key('far-controls:mission'),
    aircraftId: aircraft,
    route: farControlRoute,
    lateralToleranceMeters: FAR_CONTROL_LATERAL_TOLERANCE_METERS,
    altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
    operatingInterval: interval,
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(raw)}\n`);
  const { artifact } = await day.source.upload(bytes, 'application/json', day.key('far-controls:mission-bytes'));
  const { sourceRevision, occurredAt, ...payload } = raw;
  const received = await post<ReceiptResponse>(
    day.source,
    '/v1/inputs',
    {
      kind: 'mission.revision',
      sourceId: missionSourceId,
      sourceRevision,
      occurredAt,
      subject: { flightId: flight.id },
      artifactId: artifact.id,
      fidelity: 'synthetic_contract',
      payload,
    },
    day.key('far-controls:mission'),
  );
  await day.eventually(
    `mission receipt ${received.receipt.id}`,
    () => day.source.receipt(received.receipt.id),
    (result) => {
      if (result.receipt.processing.status === 'failed') throw new Error('The far-field mission failed processing');
      return result.receipt.processing.status === 'completed';
    },
  );
  const reviewed = await day.eventually(
    'route review of every far control',
    () => day.operator.missionAvoidance(flight.id),
    (review) =>
      review.status === 'outside' &&
      review.mission?.eventId === received.receipt.eventId &&
      controls.every((control) => review.notApplicable.some((entry) => entry.controlId === control.controlId)),
  );
  const { digest: findingsDigest } = (await day.operator.missionReleaseFindings(flight.id)).basis;
  const start = Date.parse(interval.start);
  await post(
    day.operator,
    '/v1/commands',
    {
      kind: 'mission.release',
      flightId: flight.id,
      aircraftId: aircraft,
      mission: reviewed.mission,
      calculation: {
        id: reviewedMissionReleaseCalculation.id,
        version: reviewedMissionReleaseCalculation.version,
        digest: reviewedMissionReleaseCalculation.digest,
      },
      policy: {
        id: reviewedMissionReleasePolicy.id,
        version: reviewedMissionReleasePolicy.version,
        digest: reviewedMissionReleasePolicy.digest,
      },
      expectedContextDigest: reviewed.contextDigest,
      expectedFindingsDigest: findingsDigest,
      expectedPrincipalRevision: (await me(day.operator)).revision,
      departureWindow: {
        start: new Date(start + 5 * minute).toISOString(),
        end: new Date(start + 30 * minute).toISOString(),
      },
      note: 'Released the fictional far-field route; the far areas were reviewed and do not apply to it.',
    },
    day.key('far-controls:release'),
  );
  // The release reaches the flight's timeline when its projection has run; the self-check reads it from there.
  await day.eventually(
    `release of flight ${flight.id} on its timeline`,
    () => day.operator.timeline(flight.id, { limit: 500 }),
    (view) => view.items.some((item) => item.kind === 'mission.release'),
  );
  return flight.id;
}

/** What the self-check reads back: every release and briefing of the given flights, their control lists. */
async function readFarControlRecords(
  day: FarControlDay,
  flightIds: string[],
  controls: RecordedFarControl[],
): Promise<FarControlObservation> {
  const releases: MissionReleaseRecordResponse[] = [];
  const briefings: MissionBriefingRecordResponse[] = [];
  const controlLists: FlightControlsResponse[] = [];
  const otherTenantVisible: string[] = [];
  const hidden = async (id: string, read: () => Promise<unknown>) => {
    try {
      await read();
      otherTenantVisible.push(id);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  };
  for (const flightId of flightIds) {
    const timeline: TimelineResponse = await day.operator.timeline(flightId, { limit: 500 });
    const released = timeline.items.filter((item) => item.kind === 'mission.release');
    for (const item of released) {
      releases.push(await day.operator.missionRelease(flightId, item.id));
      await hidden(item.id, () => day.otherTenant.missionRelease(flightId, item.id));
    }
    for (const item of timeline.items.filter((row) => row.kind === 'mission.brief'))
      briefings.push(await day.operator.missionBriefing(flightId, item.id));
    if (released.length) controlLists.push(await day.operator.flightControls(flightId));
  }
  for (const { controlId } of controls)
    await hidden(controlId, () => day.otherTenant.request(`/v1/sms/records/${encodeURIComponent(controlId)}`));
  return { controls, releases, briefings, controlLists, otherTenantVisible };
}

/**
 * Accepts the far controls, releases the day's one route and reads back what the self-check needs. The principals'
 * authority is restored afterwards, as it was before the run.
 */
export async function runFarControlDay(day: FarControlDay): Promise<FarControlObservation> {
  const now = (day.now ?? Date.now)();
  // Seventeen days ahead, so no area another fixture accepts for a nearer interval is considered with these.
  const start = Math.floor((now + 17 * 24 * 60 * minute) / minute) * minute;
  const interval = { start: new Date(start).toISOString(), end: new Date(start + 60 * minute).toISOString() };
  const restore = await grantReleaseAuthority(day);
  try {
    const controls = await acceptFarControls(day, interval);
    const flightId = await releaseFarControlFlight(day, interval, controls);
    return await readFarControlRecords(day, [...day.flightIds, flightId], controls);
  } finally {
    await restore();
  }
}
