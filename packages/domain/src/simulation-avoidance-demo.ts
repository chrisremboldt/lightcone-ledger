import { randomUUID } from 'node:crypto';
import {
  SIMULATION_AVOIDANCE_DEMO_LIMITS as limits,
  type SimulationAvoidanceDemoConfig,
  type SimulationAvoidanceDemoControl,
  type SimulationAvoidanceDemoControlQuery,
  type SimulationAvoidanceDemoCycle,
  type SimulationAvoidanceDemoCycleResponse,
  type SimulationAvoidanceDemoListResponse,
  type SimulationAvoidanceDemoPrepare,
  type SimulationAvoidanceDemoProgress,
  type SimulationAvoidanceDemoProgressRecord,
  type SimulationAvoidanceDemoProgressResponse,
  type SimulationAvoidanceDemoQuery,
  type SimulationAvoidanceDemoReferences,
  type SimulationAvoidanceDemoSource,
  type SimulationAvoidanceDemoPreparationQuery,
  type SimulationAvoidanceDemoPreparationContext,
  type SmsDecisionRecord,
  type MissionBriefingRecord,
  missionBriefingControls,
  type MissionDeparturePermit,
  type MissionReleaseRecord,
  type MissionRevisionRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type PoolClient, type JournalEvent } from '@ledger/persistence';
import { getControlWindow } from './control-windows.js';
import { getMonitoringWindow } from './monitoring-window.js';
import { getCommandLinkBaseline } from './command-link-baseline.js';
import { getMissionReleaseValidity } from './mission-release.js';
import { readMissionAvoidanceControlContext } from './mission-avoidance.js';
import { areaControlTypes } from './control-types.js';
import { decisionReference } from './sms-reads.js';
import { historyLimit } from './history.js';

const queueStream = 'simulation:avoidance-requests';
const terminal = (phase: string | undefined) => phase === 'monitoring_available' || phase === 'abandoned';
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);
const controlStream = (control: Pick<SimulationAvoidanceDemoControl, 'controlEventId' | 'acceptance'>) =>
  `simulation:avoidance-control:${canonicalDigest([control.controlEventId, control.acceptance.id])}`;
const progressStream = (cycleId: string) => `simulation:avoidance-cycle:${cycleId}`;
const initialId = (tenantId: string, control: SimulationAvoidanceDemoControl) =>
  `avoidance-demo:${canonicalDigest([tenantId, control.controlEventId, control.acceptance.id])}`;
const capability = (who: AuthContext, name: string) => {
  if (!who.capabilities.includes(name))
    throw new DomainError(403, 'capability_required', `Capability ${name} is required`);
};
function conflict(message: string): never {
  throw new DomainError(409, 'simulation_demo_reference_invalid', message);
}
const bounded = <T>(value: T): T => {
  if (Buffer.byteLength(JSON.stringify(value)) > limits.responseBytes)
    throw new DomainError(
      413,
      'simulation_demo_response_too_large',
      'Demo history exceeds its response bound; request a smaller page',
    );
  return value;
};
const readAt = async (client: PoolClient) =>
  (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();

export function simulationAvoidanceDemoSource(
  config: SimulationAvoidanceDemoConfig | undefined,
  tenantId: string,
): SimulationAvoidanceDemoSource | undefined {
  return config?.tenants.find((row) => row.tenantId === tenantId)?.source;
}
function configured(
  config: SimulationAvoidanceDemoConfig | undefined,
  who: AuthContext,
): SimulationAvoidanceDemoSource {
  const source = simulationAvoidanceDemoSource(config, who.tenantId);
  if (!source)
    throw new DomainError(
      404,
      'simulation_demo_not_configured',
      'Repeatable avoidance demonstrations are not configured for this operator',
    );
  return source;
}
async function sourceAvailable(
  client: PoolClient,
  tenantId: string,
  source: SimulationAvoidanceDemoSource,
): Promise<boolean> {
  const row = (
    await client.query<{
      kind: string;
      capabilities: string[];
      mission_sources: string[];
      monitoring_sources: string[];
      link_granted: boolean;
    }>(
      `SELECT p.kind,p.capabilities,p.mission_sources,p.monitoring_sources,
         EXISTS(SELECT 1 FROM observation_grants g WHERE g.tenant_id=p.tenant_id AND g.principal_id=p.id
           AND g.source_id=$3 AND g.observation_type='link.status') AS link_granted
       FROM principals p WHERE p.tenant_id=$1 AND p.id=$2 AND p.active FOR SHARE OF p`,
      [tenantId, source.principalId, source.commandLinkSourceId],
    )
  ).rows[0];
  // Link reports arrive as link.status observations under the configured command-link source.
  return (
    !!row &&
    ['source', 'service'].includes(row.kind) &&
    ['flight:read', 'input:write', 'mission:write', 'monitoring:write'].every((value) =>
      row.capabilities.includes(value),
    ) &&
    row.mission_sources.includes(source.missionSourceId) &&
    row.link_granted &&
    row.monitoring_sources.includes(source.monitoringSourceId)
  );
}
async function coordinator(
  client: PoolClient,
  who: AuthContext,
  config: SimulationAvoidanceDemoConfig | undefined,
): Promise<SimulationAvoidanceDemoSource> {
  const source = configured(config, who);
  if (who.id !== source.principalId || !(await sourceAvailable(client, who.tenantId, source)))
    throw new DomainError(
      403,
      'simulation_demo_source_required',
      'Only the configured active source with its actual mission, C2 and monitoring grants may coordinate this demonstration',
    );
  return source;
}
async function lockStream(
  client: PoolClient,
  who: AuthContext,
  name: string,
): Promise<{ id: string; sequence: string }> {
  await client.query('INSERT INTO streams(id,tenant_id,name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,name) DO NOTHING', [
    randomUUID(),
    who.tenantId,
    name,
  ]);
  return (
    await client.query<{ id: string; sequence: string }>(
      'SELECT id,sequence FROM streams WHERE tenant_id=$1 AND name=$2 FOR UPDATE',
      [who.tenantId, name],
    )
  ).rows[0]!;
}
interface AcceptedControlRow {
  hazard_id: string;
  control_id: string;
  control_version_number: number;
  control_body_digest: string;
  control_event_id: string;
  effective_until: Date | null;
  acceptance: SmsDecisionRecord | null;
  bytes: number;
}
interface ExactControl {
  control: SimulationAvoidanceDemoControl;
  effectiveUntil: Date | null;
}

/**
 * One accepted control record version of an area type, as a risk acceptance on its safety-record hazard binds it:
 * the control version event, its body digest and the acceptance that binds it.
 */
async function acceptedAreaControl(
  client: PoolClient,
  tenantId: string,
  hazardId: string,
  where: { controlEventId: string; acceptanceId: string } | { acceptanceId: string },
): Promise<AcceptedControlRow[]> {
  const types = areaControlTypes();
  return (
    await client.query<AcceptedControlRow>(
      `SELECT a.hazard_id,a.control_id,a.control_version_number,a.control_body_digest,v.id AS control_event_id,
       a.effective_until,CASE WHEN octet_length(d.record::text)<=4194304 THEN d.record END AS acceptance,
       octet_length(d.record::text) AS bytes
       FROM accepted_hazard_controls a
       JOIN sms_record_versions v ON v.tenant_id=a.tenant_id AND v.record_id=a.control_id
        AND v.version_number=a.control_version_number AND v.body_digest=a.control_body_digest
       JOIN decisions d ON d.tenant_id=a.tenant_id AND d.subject_id=a.hazard_id AND d.id=a.acceptance_id
       WHERE a.tenant_id=$1 AND a.hazard_id=$2 AND a.acceptance_id=$3 AND ($4::text IS NULL OR v.id=$4)
        AND (a.control_type_id,a.control_type_version,a.control_type_digest) IN
         (SELECT * FROM unnest($5::text[],$6::integer[],$7::text[]))
       ORDER BY a.control_id COLLATE "C"`,
      [
        tenantId,
        hazardId,
        where.acceptanceId,
        'controlEventId' in where ? where.controlEventId : null,
        types.map((type) => type.id),
        types.map((type) => type.version),
        types.map((type) => type.digest),
      ],
    )
  ).rows;
}
function controlReference(row: AcceptedControlRow): ExactControl {
  if (row.bytes > 4194304 || !row.acceptance)
    throw new DomainError(413, 'simulation_demo_control_too_large', 'The exact control exceeds its read bound');
  if (row.acceptance.kind !== 'risk.accept' || row.acceptance.subjectId !== row.hazard_id)
    conflict('The exact accepted control commitments do not agree');
  return {
    control: {
      hazardId: row.hazard_id,
      controlId: row.control_id,
      controlVersion: row.control_version_number,
      controlEventId: row.control_event_id,
      controlDigest: row.control_body_digest,
      acceptance: decisionReference(row.acceptance),
    },
    effectiveUntil: row.effective_until,
  };
}
async function exactControl(
  client: PoolClient,
  who: AuthContext,
  hazardId: string,
  controlEventId: string,
  acceptanceId: string,
): Promise<ExactControl> {
  const row = (await acceptedAreaControl(client, who.tenantId, hazardId, { controlEventId, acceptanceId }))[0];
  if (!row)
    throw new DomainError(404, 'control_not_found', 'The exact accepted control was not found within this hazard');
  return controlReference(row);
}
async function cycleRecord(client: PoolClient, who: AuthContext, id: string): Promise<SimulationAvoidanceDemoCycle> {
  const row = (
    await client.query<{ payload: { cycle: SimulationAvoidanceDemoCycle; digest: string }; bytes: number }>(
      `SELECT CASE WHEN octet_length(payload::text)<=16384 THEN payload END AS payload,octet_length(payload::text) AS bytes FROM command_records WHERE tenant_id=$1 AND id=$2 AND kind='simulation.avoidance-requested'`,
      [who.tenantId, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'simulation_demo_not_found',
      'The demonstration cycle was not found within your operator',
    );
  if (
    row.bytes > limits.bodyBytes ||
    row.payload.cycle.id !== id ||
    canonicalDigest(row.payload.cycle) !== row.payload.digest
  )
    conflict('The retained demonstration request commitment does not agree');
  return row.payload.cycle;
}
async function latestProgress(
  client: PoolClient,
  who: AuthContext,
  cycleId: string,
): Promise<SimulationAvoidanceDemoProgressResponse | null> {
  const row = (
    await client.query<{ payload: { progress: SimulationAvoidanceDemoProgressRecord; digest: string }; bytes: number }>(
      `SELECT CASE WHEN octet_length(e.payload::text)<=16384 THEN e.payload END AS payload,octet_length(e.payload::text) AS bytes
     FROM streams s JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id
     WHERE s.tenant_id=$1 AND s.name=$2 ORDER BY e.stream_sequence DESC LIMIT 1`,
      [who.tenantId, progressStream(cycleId)],
    )
  ).rows[0];
  if (!row) return null;
  if (
    row.bytes > limits.bodyBytes ||
    row.payload.progress.cycleId !== cycleId ||
    canonicalDigest(row.payload.progress) !== row.payload.digest
  )
    conflict('The retained demonstration progress commitment does not agree');
  return row.payload;
}
export async function getSimulationAvoidanceDemo(
  client: PoolClient,
  who: AuthContext,
  id: string,
  config?: SimulationAvoidanceDemoConfig,
): Promise<SimulationAvoidanceDemoCycleResponse> {
  capability(who, 'flight:read');
  configured(config, who);
  const cycle = await cycleRecord(client, who, id);
  const progress = await latestProgress(client, who, id);
  const state = (
    await client.query<{ state: string }>('SELECT state FROM work_items WHERE tenant_id=$1 AND event_id=$2', [
      who.tenantId,
      progress?.progress.id ?? id,
    ])
  ).rows[0]?.state;
  return bounded({
    cycle,
    digest: canonicalDigest(cycle),
    progress: progress?.progress ?? null,
    progressDigest: progress?.digest ?? null,
    processing: state === 'leased' ? 'processing' : state === 'completed' || state === 'failed' ? state : 'pending',
    readAt: await readAt(client),
  });
}
async function retainRequest(
  client: PoolClient,
  who: AuthContext,
  control: SimulationAvoidanceDemoControl,
  source: SimulationAvoidanceDemoSource,
  mode: 'initial' | 'repeat',
  previousCycleId: string | null,
): Promise<string> {
  const stream = await lockStream(client, who, controlStream(control));
  const firstId = initialId(who.tenantId, control);
  const existing = (
    await client.query('SELECT id FROM command_records WHERE tenant_id=$1 AND id=$2', [who.tenantId, firstId])
  ).rows[0];
  if (mode === 'initial' && existing) return firstId;
  if (mode === 'repeat') {
    const last = (
      await client.query<{ payload: { cycle: SimulationAvoidanceDemoCycle } }>(
        'SELECT payload FROM journal_events WHERE tenant_id=$1 AND stream_id=$2 ORDER BY stream_sequence DESC LIMIT 1',
        [who.tenantId, stream.id],
      )
    ).rows[0]?.payload.cycle;
    if (!last || last.id !== previousCycleId || !same(last.control, control))
      throw new DomainError(
        409,
        'simulation_demo_predecessor_changed',
        'Repeat requires the exact latest cycle for this accepted control',
      );
    const progress = await latestProgress(client, who, last.id);
    if (!terminal(progress?.progress.phase))
      throw new DomainError(
        409,
        'simulation_demo_cycle_active',
        'The existing cycle is still active; recover it before preparing another',
      );
  }
  const id = mode === 'initial' ? firstId : `avoidance-demo:${randomUUID()}`;
  const event = await appendEvent(client, who, {
    id,
    type: 'simulation.avoidance-requested',
    stream: controlStream(control),
    causationId: previousCycleId ?? control.acceptance.id,
    payload: ({ receivedAt }) => {
      const cycle: SimulationAvoidanceDemoCycle = {
        version: 'simulation.avoidance-cycle.1',
        id,
        control,
        trigger: mode,
        previousCycleId,
        requestedAt: receivedAt,
        requestedBy: { id: who.id, principalRevision: who.revision },
        source,
      };
      return { cycle, digest: canonicalDigest(cycle) };
    },
  });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [id, who.tenantId, event.event_type, who.id, event.received_at, event.payload],
  );
  await appendEvent(client, who, {
    type: 'simulation.avoidance-queued',
    stream: queueStream,
    causationId: id,
    payload: { cycleId: id, digest: event.payload.digest },
  });
  return id;
}
/**
 * After a risk acceptance on a safety-record hazard, recovers the initial demonstration cycle for each area control
 * it binds, when demonstrations are configured for the organization and its source is available.
 */
export async function enqueueInitialSimulationAvoidanceDemos(
  client: PoolClient,
  who: AuthContext,
  hazardId: string,
  acceptanceId: string,
  config?: SimulationAvoidanceDemoConfig,
): Promise<void> {
  const source = simulationAvoidanceDemoSource(config, who.tenantId);
  if (!source || !(await sourceAvailable(client, who.tenantId, source))) return;
  for (const row of await acceptedAreaControl(client, who.tenantId, hazardId, { acceptanceId }))
    await retainRequest(client, who, controlReference(row).control, source, 'initial', null);
}
export async function prepareSimulationAvoidanceDemo(
  client: PoolClient,
  who: AuthContext,
  hazardId: string,
  request: SimulationAvoidanceDemoPrepare,
  config?: SimulationAvoidanceDemoConfig,
): Promise<string> {
  capability(who, 'flight:read');
  capability(who, 'decision:write');
  if (who.kind !== 'human')
    throw new DomainError(
      403,
      'simulation_demo_human_required',
      'Only an authenticated human may request another demonstration',
    );
  const source = configured(config, who);
  if (who.revision !== request.expectedPrincipalRevision)
    throw new DomainError(409, 'stale_authority', 'Authority changed; review preparation again');
  if (!(await sourceAvailable(client, who.tenantId, source)))
    throw new DomainError(
      409,
      'simulation_demo_source_unavailable',
      'The configured source lacks current mission, C2 or monitoring authority',
    );
  const retained = await exactControl(
    client,
    who,
    hazardId,
    request.control.controlEventId,
    request.control.acceptance.id,
  );
  if (!same(request.control, retained.control)) conflict('Preparation must name the exact control and risk acceptance');
  if ((request.mode === 'repeat') !== !!request.previousCycleId)
    throw new DomainError(
      400,
      'simulation_demo_predecessor_required',
      'Only repeat preparation requires a previous cycle',
    );
  if (retained.effectiveUntil && retained.effectiveUntil.getTime() <= Date.parse(await readAt(client)))
    throw new DomainError(
      409,
      'simulation_demo_control_expired',
      'Prepare a demonstration while its exact accepted control remains in effect',
    );
  return retainRequest(client, who, request.control, source, request.mode, request.previousCycleId ?? null);
}

interface SequenceCursor {
  v: 1;
  tenant: string;
  principal: string;
  authority: number;
  stream: string;
  position: string;
}
function cursorPosition(value: string | undefined, who: AuthContext, stream: string, initial: string): string {
  if (!value) return initial;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SequenceCursor;
    if (
      Object.keys(decoded).sort().join(',') !== 'authority,position,principal,stream,tenant,v' ||
      decoded.v !== 1 ||
      decoded.tenant !== who.tenantId ||
      decoded.principal !== who.id ||
      decoded.authority !== who.revision ||
      decoded.stream !== stream ||
      !/^(0|[1-9][0-9]*)$/.test(decoded.position) ||
      BigInt(decoded.position) > 9223372036854775807n
    )
      throw new Error();
    return decoded.position;
  } catch {
    throw new DomainError(
      400,
      'invalid_cursor',
      'The demonstration cursor does not match the current reader, authority or exact scope',
    );
  }
}
async function listStream(
  client: PoolClient,
  who: AuthContext,
  stream: string,
  query: SimulationAvoidanceDemoQuery,
  config: SimulationAvoidanceDemoConfig | undefined,
  queue: boolean,
): Promise<SimulationAvoidanceDemoListResponse> {
  const position = cursorPosition(query.cursor, who, stream, queue ? '0' : '9223372036854775807');
  const limit = historyLimit(query.limit, limits.page, limits.maxPage);
  const rows = (
    await client.query<{ sequence: string; cycle_id: string }>(
      `SELECT e.stream_sequence::text AS sequence,CASE WHEN $5 THEN e.payload->>'cycleId' ELSE e.id END AS cycle_id
     FROM streams s JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id
     WHERE s.tenant_id=$1 AND s.name=$2 AND e.stream_sequence${queue ? '>' : '<'}$3::bigint ORDER BY e.stream_sequence ${queue ? 'ASC' : 'DESC'} LIMIT $4`,
      [who.tenantId, stream, position, limit + 1, queue],
    )
  ).rows;
  const page = rows.slice(0, limit);
  const cycles: SimulationAvoidanceDemoCycleResponse[] = [];
  for (const row of page) cycles.push(await getSimulationAvoidanceDemo(client, who, row.cycle_id, config));
  const nextCursor =
    queue || (page.length && rows.length > limit)
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            tenant: who.tenantId,
            principal: who.id,
            authority: who.revision,
            stream,
            position: page.at(-1)?.sequence ?? position,
          } satisfies SequenceCursor),
        ).toString('base64url')
      : null;
  return bounded({ cycles, nextCursor, readAt: await readAt(client) });
}
export async function getHazardSimulationAvoidanceDemos(
  client: PoolClient,
  who: AuthContext,
  hazardId: string,
  query: SimulationAvoidanceDemoControlQuery,
  config?: SimulationAvoidanceDemoConfig,
): Promise<SimulationAvoidanceDemoListResponse> {
  capability(who, 'flight:read');
  configured(config, who);
  const retained = await exactControl(client, who, hazardId, query.controlEventId, query.acceptanceId);
  return listStream(client, who, controlStream(retained.control), query, config, false);
}
export async function getSimulationAvoidanceDemoRequests(
  client: PoolClient,
  who: AuthContext,
  query: SimulationAvoidanceDemoQuery,
  config?: SimulationAvoidanceDemoConfig,
): Promise<SimulationAvoidanceDemoListResponse> {
  await coordinator(client, who, config);
  return listStream(client, who, queueStream, query, config, true);
}

export async function getSimulationAvoidanceDemoPreparationContext(
  client: PoolClient,
  who: AuthContext,
  cycleId: string,
  request: SimulationAvoidanceDemoPreparationQuery,
  config?: SimulationAvoidanceDemoConfig,
): Promise<SimulationAvoidanceDemoPreparationContext> {
  const source = await coordinator(client, who, config);
  const cycle = await cycleRecord(client, who, cycleId);
  if (!same(source, cycle.source))
    throw new DomainError(
      403,
      'simulation_demo_source_changed',
      'This cycle belongs to its original exact configured source',
    );
  const interval = request.operatingInterval;
  const start = Date.parse(interval.start);
  const end = Date.parse(interval.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end <= Date.parse(await readAt(client)))
    throw new DomainError(
      400,
      'simulation_demo_interval_invalid',
      'Preparation requires a finite future operating interval',
    );
  const context = await readMissionAvoidanceControlContext(client, who, interval, true);
  const reasons = [...context.reasons];
  if (context.controls.some((control) => control.context !== 'current')) reasons.push('control_context_not_current');
  if (
    !context.controls.some(
      (control) =>
        same(
          {
            hazardId: control.hazardId,
            controlId: control.controlId,
            controlVersion: control.controlVersion,
            controlEventId: control.controlEventId,
            controlDigest: control.controlDigest,
            acceptance: control.acceptance,
          },
          cycle.control,
        ) &&
        Date.parse(control.interval.start) <= start &&
        Date.parse(control.interval.end) >= end,
    )
  )
    reasons.push('selected_control_not_current_for_interval');
  const preimage = {
    version: 'simulation.avoidance-preparation-context.1' as const,
    cycle: { id: cycle.id, digest: canonicalDigest(cycle) },
    operatingInterval: interval,
    controls: context.controls,
    candidateCompleteness: context.candidateCompleteness,
  };
  return bounded({
    ...preimage,
    evaluatedAt: context.evaluatedAt,
    status: reasons.length ? 'insufficient' : 'ready',
    contextDigest: context.candidateCompleteness.status === 'complete' ? canonicalDigest(preimage) : null,
    reasons,
  });
}

async function completedRecord<T>(
  client: PoolClient,
  who: AuthContext,
  table: 'mission_revisions' | 'mission_releases' | 'mission_briefings',
  id: string,
): Promise<T> {
  const row = (
    await client.query<{ record: T; bytes: number; state: string; projected: boolean }>(
      `SELECT CASE WHEN octet_length(r.record::text)<=4194304 THEN r.record END AS record,octet_length(r.record::text) AS bytes,w.state,p.sequence>=e.stream_sequence AS projected
     FROM ${table} r JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.id LEFT JOIN work_items w ON w.tenant_id=e.tenant_id AND w.event_id=e.id LEFT JOIN projection_offsets p ON p.tenant_id=e.tenant_id AND p.stream_id=e.stream_id WHERE r.tenant_id=$1 AND r.id=$2`,
      [who.tenantId, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'simulation_demo_reference_not_found',
      'The exact referenced record was not found within this operator',
    );
  if (row.bytes > 4194304)
    throw new DomainError(413, 'simulation_demo_reference_too_large', 'The referenced record exceeds its read bound');
  if (row.state !== 'completed' || row.projected !== true)
    throw new DomainError(
      409,
      'simulation_demo_projection_pending',
      'The exact referenced record has not completed projection',
    );
  return row.record;
}
async function validateReferences(
  client: PoolClient,
  who: AuthContext,
  cycle: SimulationAvoidanceDemoCycle,
  request: SimulationAvoidanceDemoProgress,
  previous: SimulationAvoidanceDemoProgressRecord | null,
): Promise<void> {
  const refs = request.references;
  const fixed = previous?.references;
  if (fixed?.execution && !same(fixed.execution, refs.execution))
    conflict('The cycle execution identity cannot change');
  for (const key of ['baseline', 'departure', 'monitoring', 'controlWindow'] as const)
    if (fixed?.[key] && !same(fixed[key], refs[key])) conflict(`The retained ${key} reference cannot change`);
  if (
    fixed?.departure &&
    (!same(fixed.mission, refs.mission) || !same(fixed.release, refs.release) || !same(fixed.briefing, refs.briefing))
  )
    conflict('An authorized departure keeps its exact mission, release and briefing');
  if (!refs.execution) {
    if (Object.keys(refs).length || !['preparing', 'blocked', 'abandoned'].includes(request.phase))
      conflict('This phase requires the cycle execution identity');
    return;
  }
  const execution = refs.execution;
  const flight = (
    await client.query<{ aircraft: string | null; origination_key: string; activity: string }>(
      'SELECT aircraft,origination_key,activity FROM flight_views WHERE tenant_id=$1 AND id=$2',
      [who.tenantId, execution.flightId],
    )
  ).rows[0];
  if (!flight)
    throw new DomainError(404, 'flight_not_found', 'The referenced flight was not found within your operator');
  if (flight.aircraft !== execution.aircraftId || flight.origination_key !== execution.reservationId)
    conflict('The flight does not match the exact reservation and assigned aircraft');
  if (!refs.mission) conflict('The held flight requires its exact accepted and projected mission');
  const mission = await completedRecord<MissionRevisionRecord>(client, who, 'mission_revisions', refs.mission.eventId);
  const missionReference = {
    missionId: mission.missionId,
    eventId: mission.id,
    sourceRevision: mission.sourceRevision,
    contentDigest: mission.contentDigest,
    recordDigest: canonicalDigest(mission),
  };
  if (
    !same(missionReference, refs.mission) ||
    mission.flightId !== execution.flightId ||
    mission.aircraftId !== execution.aircraftId ||
    mission.sourceId !== cycle.source.missionSourceId ||
    mission.sourceMissionId !== execution.sourceMissionId
  )
    conflict('The exact mission does not match this cycle source, flight and aircraft');
  if (
    fixed?.mission &&
    (refs.mission.sourceRevision < fixed.mission.sourceRevision ||
      (refs.mission.sourceRevision === fixed.mission.sourceRevision && !same(refs.mission, fixed.mission)))
  )
    conflict('A cycle cannot replace or move backwards from a retained mission revision');
  let release: MissionReleaseRecord | undefined;
  if (refs.release) {
    release = await completedRecord<MissionReleaseRecord>(client, who, 'mission_releases', refs.release.id);
    if (
      canonicalDigest(release) !== refs.release.digest ||
      release.flightId !== execution.flightId ||
      !same(release.basis.avoidance.mission, refs.mission) ||
      !release.basis.avoidance.candidates.some((candidate) =>
        same(
          {
            hazardId: candidate.hazardId,
            controlId: candidate.controlId,
            controlVersion: candidate.controlVersion,
            controlEventId: candidate.controlEventId,
            controlDigest: candidate.controlDigest,
            acceptance: candidate.acceptance,
          },
          cycle.control,
        ),
      ) ||
      release.actor.kind !== 'human'
    )
      conflict('The release must be a retained human decision for this exact mission and accepted control');
  }
  let briefing: MissionBriefingRecord | undefined;
  if (refs.briefing) {
    briefing = await completedRecord<MissionBriefingRecord>(client, who, 'mission_briefings', refs.briefing.id);
    if (
      !release ||
      canonicalDigest(briefing) !== refs.briefing.digest ||
      briefing.flightId !== execution.flightId ||
      !same(briefing.context.release, refs.release) ||
      !missionBriefingControls(briefing).some(({ reference }) => same(reference, cycle.control)) ||
      briefing.actor.kind !== 'human'
    )
      conflict('The briefing must be a retained human action for this exact release and control');
  }
  const afterRelease = [
    'awaiting_briefing',
    'awaiting_acknowledgement',
    'ready',
    'departure_unknown',
    'airborne',
    'monitoring',
    'monitoring_available',
  ].includes(request.phase);
  if (afterRelease && !release) conflict('This phase requires the exact human release');
  const afterBriefing = [
    'awaiting_acknowledgement',
    'ready',
    'departure_unknown',
    'airborne',
    'monitoring',
    'monitoring_available',
  ].includes(request.phase);
  if (afterBriefing && !briefing) conflict('This phase requires the exact human briefing');
  if (request.phase === 'ready') {
    const validity = await getMissionReleaseValidity(client, who, execution.flightId, release!.id);
    if (!['current', 'scheduled'].includes(validity.status))
      conflict('The exact human release is no longer valid for departure preparation');
  }
  if (['ready', 'departure_unknown', 'airborne', 'monitoring', 'monitoring_available'].includes(request.phase)) {
    const acknowledgements = await client.query<{ principal_id: string }>(
      "SELECT a.recipient_principal_id AS principal_id FROM mission_briefing_acknowledgements a JOIN work_items w ON w.tenant_id=a.tenant_id AND w.event_id=a.id WHERE a.tenant_id=$1 AND a.briefing_id=$2 AND w.state='completed'",
      [who.tenantId, briefing!.id],
    );
    if (
      !briefing!.population.recipients.every((recipient) =>
        acknowledgements.rows.some((row) => row.principal_id === recipient.principalId),
      )
    )
      conflict('Every person in the exact frozen briefing population must acknowledge personally');
  }
  if (refs.baseline) {
    const baseline = await getCommandLinkBaseline(client, who, execution.flightId, refs.baseline.id);
    if (
      baseline.digest !== refs.baseline.digest ||
      baseline.processing !== 'completed' ||
      baseline.baseline.input.payload.aircraftId !== execution.aircraftId ||
      baseline.baseline.input.sourceId !== cycle.source.commandLinkSourceId
    )
      conflict('The exact native C2 baseline does not match this flight and configured source');
  }
  if (refs.departure) {
    const row = (
      await client.query<{ permit: MissionDeparturePermit; permit_digest: string }>(
        'SELECT permit,permit_digest FROM mission_departure_authorizations WHERE tenant_id=$1 AND id=$2 AND flight_id=$3',
        [who.tenantId, refs.departure.permit.id, execution.flightId],
      )
    ).rows[0];
    if (
      !row ||
      row.permit_digest !== refs.departure.permit.digest ||
      canonicalDigest(row.permit) !== row.permit_digest ||
      row.permit.departureAttemptId !== refs.departure.attemptId ||
      row.permit.aircraftId !== execution.aircraftId ||
      !same(row.permit.release, refs.release) ||
      !same(row.permit.mission, refs.mission)
    )
      conflict('The departure must retain its actual exact authorization');
    const receipt = (
      await client.query<{
        payload: { activity?: string; phase?: string; aircraft?: string };
        state: string;
        occurred_at: Date;
      }>(
        `SELECT r.payload,w.state,r.occurred_at FROM receipts r JOIN work_items w ON w.tenant_id=r.tenant_id AND w.event_id=r.event_id JOIN journal_events e ON e.tenant_id=r.tenant_id AND e.id=r.event_id WHERE r.tenant_id=$1 AND r.id=$2 AND r.flight_id=$3 AND r.kind='flight.observation' AND e.principal_id=$4`,
        [who.tenantId, refs.departure.receiptId, execution.flightId, row.permit.actor.id],
      )
    ).rows[0];
    const activity = receipt?.payload.activity ?? receipt?.payload.phase;
    if (
      receipt?.state !== 'completed' ||
      receipt.payload.aircraft !== execution.aircraftId ||
      receipt.occurred_at.getTime() < Date.parse(row.permit.authorizedAt) ||
      receipt.occurred_at.getTime() >= Date.parse(row.permit.validUntil) ||
      !['active', 'departed', 'airborne'].includes(activity ?? '')
    )
      conflict('Airborne progress requires the actual retained departure source receipt');
  }
  if (['airborne', 'monitoring', 'monitoring_available'].includes(request.phase) && !refs.departure)
    conflict('This phase requires the actual departure receipt');
  if (refs.controlWindow) {
    const window = await getControlWindow(client, who, refs.controlWindow.id);
    if (
      window.variant !== 'generic' ||
      window.revision.number !== 1 ||
      window.revision.digest !== refs.controlWindow.digest ||
      !same(
        {
          hazardId: window.control.hazardId,
          recordId: window.control.recordId,
          versionNumber: window.control.versionNumber,
          bodyDigest: window.control.bodyDigest,
          acceptanceId: window.control.acceptanceId,
        },
        {
          hazardId: cycle.control.hazardId,
          recordId: cycle.control.controlId,
          versionNumber: cycle.control.controlVersion,
          bodyDigest: cycle.control.controlDigest,
          acceptanceId: cycle.control.acceptance.id,
        },
      ) ||
      window.population.subjects.length !== 1 ||
      !same(window.population.subjects[0], { scope: 'ledger', kind: 'flight', id: execution.flightId })
    )
      conflict('The control window must be for this exact control and name only this flight');
  }
  if (refs.monitoring) {
    const monitoring = await getMonitoringWindow(client, who, refs.monitoring.id);
    const source = monitoring.monitoring.source;
    if (
      monitoring.digest !== refs.monitoring.digest ||
      monitoring.processing !== 'completed' ||
      monitoring.monitoring.sourceId !== cycle.source.monitoringSourceId ||
      !same(source.control, cycle.control) ||
      source.flights.length !== 1 ||
      source.flights[0]!.flightId !== execution.flightId ||
      source.flights[0]!.mission.eventId !== mission.id ||
      source.flights[0]!.baseline.eventId !== refs.baseline?.id ||
      source.flights[0]!.baseline.digest !== refs.baseline?.digest
    )
      conflict('Monitoring must cite this exact cycle, executed mission and native baseline');
  }
  if (request.phase === 'monitoring_available' && !refs.monitoring && !refs.controlWindow)
    conflict('Monitoring availability requires its control window or retained monitoring record');
  if (request.phase === 'abandoned' && (flight.activity !== 'cancelled' || refs.departure))
    conflict('Abandonment requires the retained cancellation of the held flight');
}
async function bindExecution(
  client: PoolClient,
  who: AuthContext,
  cycle: SimulationAvoidanceDemoCycle,
  refs: SimulationAvoidanceDemoReferences,
): Promise<void> {
  if (!refs.execution) return;
  const slot = await lockStream(client, who, `simulation:avoidance-slot:${cycle.source.principalId}`);
  const existing = (
    await client.query<{ payload: { cycleId: string } }>(
      'SELECT payload FROM journal_events WHERE tenant_id=$1 AND stream_id=$2 ORDER BY stream_sequence DESC LIMIT 1',
      [who.tenantId, slot.id],
    )
  ).rows[0];
  if (
    existing &&
    existing.payload.cycleId !== cycle.id &&
    !terminal((await latestProgress(client, who, existing.payload.cycleId))?.progress.phase)
  )
    throw new DomainError(
      409,
      'simulation_demo_coordinator_busy',
      'The source coordinator already has an active bound cycle; retain this request until that cycle is terminal',
    );
  const id = `avoidance-demo-binding:${canonicalDigest([who.tenantId, refs.execution.flightId])}`;
  const bound = (
    await client.query<{ payload: { cycleId: string; execution: SimulationAvoidanceDemoReferences['execution'] } }>(
      "SELECT payload FROM command_records WHERE tenant_id=$1 AND id=$2 AND kind='simulation.avoidance-bound'",
      [who.tenantId, id],
    )
  ).rows[0];
  if (bound) {
    if (bound.payload.cycleId !== cycle.id || !same(bound.payload.execution, refs.execution))
      conflict('A flight can belong to only one exact demonstration cycle');
    return;
  }
  const event = await appendEvent(client, who, {
    id,
    type: 'simulation.avoidance-bound',
    stream: `simulation:avoidance-slot:${cycle.source.principalId}`,
    causationId: cycle.id,
    payload: { cycleId: cycle.id, execution: refs.execution },
  });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, who.tenantId, event.event_type, who.id, event.received_at, event.payload],
  );
}
export async function recordSimulationAvoidanceDemoProgress(
  client: PoolClient,
  who: AuthContext,
  cycleId: string,
  request: SimulationAvoidanceDemoProgress,
  config?: SimulationAvoidanceDemoConfig,
): Promise<string> {
  const source = await coordinator(client, who, config);
  const cycle = await cycleRecord(client, who, cycleId);
  if (!same(source, cycle.source))
    throw new DomainError(
      403,
      'simulation_demo_source_changed',
      'This cycle belongs to its original exact configured source',
    );
  await lockStream(client, who, progressStream(cycleId));
  const previous = await latestProgress(client, who, cycleId);
  if ((previous?.progress.revision ?? 0) !== request.expectedRevision)
    throw new DomainError(
      409,
      'simulation_demo_progress_changed',
      'Progress changed; recover the original request or read its exact current revision',
    );
  if (terminal(previous?.progress.phase))
    throw new DomainError(
      409,
      'simulation_demo_cycle_terminal',
      'The retained cycle is terminal; use explicit repeat preparation for another flight',
    );
  if (request.expectedRevision >= limits.progress)
    throw new DomainError(413, 'simulation_demo_progress_limit', 'The cycle reached its retained progress bound');
  if (terminal(request.phase) && request.retryable)
    throw new DomainError(400, 'simulation_demo_terminal_retryable', 'A terminal cycle cannot request retry');
  await validateReferences(client, who, cycle, request, previous?.progress ?? null);
  await bindExecution(client, who, cycle, request.references);
  const event = await appendEvent(client, who, {
    type: 'simulation.avoidance-progress',
    stream: progressStream(cycleId),
    causationId: previous?.progress.id ?? cycle.id,
    payload: ({ id, receivedAt }) => {
      const { expectedRevision, ...fields } = request;
      const progress: SimulationAvoidanceDemoProgressRecord = {
        ...fields,
        id,
        cycleId,
        revision: expectedRevision + 1,
        recordedAt: receivedAt,
        actorId: who.id,
      };
      return { progress, digest: canonicalDigest(progress) };
    },
  });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, who.tenantId, event.event_type, who.id, event.received_at, event.payload],
  );
  return event.id;
}
export async function getSimulationAvoidanceDemoProgress(
  client: PoolClient,
  who: AuthContext,
  cycleId: string,
  id: string,
): Promise<SimulationAvoidanceDemoProgressResponse> {
  await cycleRecord(client, who, cycleId);
  const row = (
    await client.query<{ payload: SimulationAvoidanceDemoProgressResponse }>(
      "SELECT payload FROM command_records WHERE tenant_id=$1 AND id=$2 AND kind='simulation.avoidance-progress'",
      [who.tenantId, id],
    )
  ).rows[0];
  if (!row || row.payload.progress.cycleId !== cycleId || canonicalDigest(row.payload.progress) !== row.payload.digest)
    conflict('The original progress acceptance was not found with its exact commitment');
  return bounded(row.payload);
}

export async function validateSimulationAvoidanceDemoEvent(client: PoolClient, event: JournalEvent): Promise<void> {
  if (event.event_type === 'simulation.avoidance-bound') {
    const row = (
      await client.query<{ payload: { cycle: SimulationAvoidanceDemoCycle } }>(
        "SELECT payload FROM command_records WHERE tenant_id=$1 AND id=$2 AND kind='simulation.avoidance-requested'",
        [event.tenant_id, event.payload.cycleId],
      )
    ).rows[0];
    const execution = event.payload.execution as SimulationAvoidanceDemoReferences['execution'];
    if (
      !row ||
      !execution ||
      event.principal_id !== row.payload.cycle.source.principalId ||
      event.causation_id !== row.payload.cycle.id ||
      event.id !== `avoidance-demo-binding:${canonicalDigest([event.tenant_id, execution.flightId])}`
    )
      conflict('The operational execution binding does not match its exact source and cycle');
    return;
  }
  if (event.event_type === 'simulation.avoidance-queued') {
    const row = (
      await client.query<{ payload: { digest: string } }>(
        "SELECT payload FROM command_records WHERE tenant_id=$1 AND id=$2 AND kind='simulation.avoidance-requested'",
        [event.tenant_id, event.payload.cycleId],
      )
    ).rows[0];
    if (!row || row.payload.digest !== event.payload.digest || event.causation_id !== event.payload.cycleId)
      conflict('The queue event does not match its exact request');
    return;
  }
  const payload = event.payload;
  const record =
    event.event_type === 'simulation.avoidance-requested'
      ? (payload.cycle as SimulationAvoidanceDemoCycle)
      : (payload.progress as SimulationAvoidanceDemoProgressRecord);
  if (
    !record ||
    record.id !== event.id ||
    canonicalDigest(record) !== payload.digest ||
    (event.event_type === 'simulation.avoidance-requested'
      ? (record as SimulationAvoidanceDemoCycle).requestedBy.id !== event.principal_id
      : (record as SimulationAvoidanceDemoProgressRecord).actorId !== event.principal_id)
  )
    conflict('The operational event does not match its immutable acceptance');
}
