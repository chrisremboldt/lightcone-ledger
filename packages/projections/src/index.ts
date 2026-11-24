import { FLIGHT_PREDEPARTURE_EVENT } from '@ledger/contracts';
import { validateFlightPredepartureEvent } from '@ledger/domain';
import { randomUUID } from 'node:crypto';
import type { FlightCreate, FlightInput as Input } from '@ledger/contracts';
import { SIMULATION_AVOIDANCE_DEMO_EVENT_TYPES } from '@ledger/contracts';
import {
  appendLiveChange,
  createObjectStore,
  DomainError,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import {
  addFulfillments,
  canonicalDigest,
  createFlight,
  lockOrderIdentity,
  lockOriginationKeys,
  originationContext,
  requireRow,
  resolveFlight,
  retainSubjectEvidence,
  beginProjectionSubjects,
  endProjectionSubjects,
  lockProjectionSubjects,
  projectPackAdoption,
  projectOrganizationDecision,
  projectMissionEvent,
  projectMissionReleaseEvent,
  projectMissionDepartureEvent,
  projectMissionBriefingEvent,
  projectCommandLinkBaselineEvent,
  projectMonitoringWindowEvent,
  validateAcceptedCommandLinkAuthority,
  validateSimulationAvoidanceDemoEvent,
  isSmsEvent,
  lockAdoptedRules,
  projectSmsEvent,
  scheduleAcceptedControlBoundaries,
  queueRuleEvaluationsForCorrection,
  queueRuleEvaluationsForObservation,
  bridgeLegacyFlightReportLink,
  queueRuleEvaluationsForSubjectState,
  projectObservationEvent,
  settleObservationEvent,
} from '@ledger/domain';
import { projectTelemetry } from './telemetry.js';
import { retainIntentRevision } from './intent-revisions.js';
export { decodeTelemetry } from './telemetry.js';

export const PROJECTOR_VERSION = 'thread.1';
// Events whose projection queues the evaluations of rules that read the state of the flights they change.
const FLIGHT_STATE_EVENTS = [
  'flight.created',
  'order.revision',
  'intent.revision',
  'flight.observation',
  'evidence.correct',
  'identity.link',
];
interface ProjectionReceipt {
  id: string;
  event_id: string;
  flight_id: string | null;
  link_status: string;
  source_revision: string | null;
}
async function requireReceipt(client: PoolClient, id: string, lock = false): Promise<ProjectionReceipt> {
  const row = (
    await client.query<ProjectionReceipt>(`SELECT * FROM receipts WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])
  ).rows[0];
  if (!row) throw new DomainError(404, 'not_found', 'Receipt was not found within your scope');
  return row;
}
async function timeline(
  client: PoolClient,
  event: JournalEvent,
  flightId: string,
  lane: string,
  title: string,
  receipt?: Pick<ProjectionReceipt, 'id'>,
): Promise<void> {
  await client.query(
    `INSERT INTO timeline_items(id,tenant_id,flight_id,lane,kind,title,occurred_at,received_at,actor_id,source_id,payload,receipt_id,artifact_id,correction_of,link_status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'linked') ON CONFLICT DO NOTHING`,
    [
      event.id,
      event.tenant_id,
      flightId,
      lane,
      event.event_type,
      title,
      event.occurred_at ?? event.received_at,
      event.received_at,
      event.principal_id,
      event.source_id,
      event.event_type === 'evidence.correct'
        ? { note: event.payload.note, ...event.payload.payload }
        : ['command-link.status', 'command-link.baseline'].includes(event.event_type)
          ? { ...event.payload.payload, sourceSessionId: event.source_session_id }
          : (event.payload.payload ?? event.payload),
      receipt?.id ?? null,
      event.artifact_id,
      event.payload.correctionOf ?? null,
    ],
  );
  await retainSubjectEvidence(client, event.tenant_id, [flightId], event);
}
async function refreshObservationSummary(client: PoolClient, flightId: string): Promise<void> {
  await requireRow(client, 'flight_views', flightId, true);
  const active = `c.flight_id=$1 AND NOT EXISTS(SELECT 1 FROM claims replacement WHERE replacement.correction_of=c.id) AND (c.receipt_id IS NULL OR EXISTS(SELECT 1 FROM receipts r WHERE r.id=c.receipt_id AND r.flight_id=$1))`;
  const latest = await client.query(
    `SELECT c.payload FROM claims c WHERE ${active} AND COALESCE(c.payload->>'activity',c.payload->>'state',c.payload->>'phase') IN ('planned','active','landed','cancelled') ORDER BY c.occurred_at DESC NULLS LAST,COALESCE(c.source_revision,-1) DESC,c.id DESC LIMIT 1`,
    [flightId],
  );
  const selected = latest.rows[0]?.payload ?? {};
  const activity = selected.activity ?? selected.state ?? selected.phase;
  const validActivity = ['planned', 'active', 'landed', 'cancelled'].includes(activity) ? activity : null;
  const landing = await client.query(
    `SELECT DISTINCT COALESCE(c.payload->>'landingTime',c.payload->>'landedAt') AS landing FROM claims c WHERE ${active} AND (c.payload ? 'landingTime' OR c.payload ? 'landedAt')`,
    [flightId],
  );
  const conflicts = Math.max(0, landing.rows.filter((r) => r.landing !== null).length - 1);
  const count = Number((await client.query(`SELECT COUNT(*) FROM claims c WHERE ${active}`, [flightId])).rows[0].count);
  await client.query(
    `UPDATE flight_views SET activity=COALESCE($1,CASE WHEN EXISTS(SELECT 1 FROM fulfillments f JOIN operational_orders o ON o.source_id=f.source_id AND o.external_id=f.order_external_id WHERE f.flight_id=$4 AND o.status='cancelled') THEN 'cancelled' ELSE 'planned' END),coverage=$2,conflict_count=$3 WHERE id=$4`,
    [validActivity, conflicts ? 'conflicting' : count ? 'partial' : 'unknown', conflicts, flightId],
  );
}
async function applyObservation(
  client: PoolClient,
  event: JournalEvent,
  receipt: ProjectionReceipt,
  flightId: string,
): Promise<void> {
  // Lock before inserting/reading claims; otherwise concurrent streams can overwrite a summary computed from disjoint snapshots.
  await requireRow(client, 'flight_views', flightId, true);
  const payload = event.payload.payload as Record<string, any>;
  await client.query(
    'INSERT INTO claims(id,tenant_id,event_id,receipt_id,flight_id,kind,payload,source_revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
    [
      `${event.id}:${flightId}`,
      event.tenant_id,
      event.id,
      receipt.id,
      flightId,
      event.event_type,
      payload,
      receipt.source_revision,
      event.occurred_at,
    ],
  );
  await refreshObservationSummary(client, flightId);
  await client.query(
    `UPDATE flight_views SET revision=revision+1,last_occurred_at=GREATEST(last_occurred_at,$1),last_received_at=GREATEST(last_received_at,$2),source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$3]::text[])) WHERE id=$4`,
    [event.occurred_at, event.received_at, event.source_id, flightId],
  );
  await timeline(
    client,
    event,
    flightId,
    event.event_type === 'airspace.status' ? 'checks' : 'observed',
    payload.title ?? `${event.event_type}: ${payload.activity ?? payload.status ?? 'observation'}`,
    receipt,
  );
}
export async function projectEvent(
  client: PoolClient,
  principal: AuthContext,
  event: JournalEvent,
  options: { objectStore?: ObjectStore } = {},
): Promise<void> {
  beginProjectionSubjects(client, event);
  try {
    await projectWithSubjects(client, principal, event, options);
  } finally {
    endProjectionSubjects(client);
  }
}

// Live heads are locked in flight id order, by code unit as "C" collation orders them, never by locale.
const byFlight = (a: { flight_id: string }, b: { flight_id: string }) =>
  a.flight_id < b.flight_id ? -1 : a.flight_id > b.flight_id ? 1 : 0;

async function projectWithSubjects(
  client: PoolClient,
  principal: AuthContext,
  event: JournalEvent,
  options: { objectStore?: ObjectStore },
): Promise<void> {
  const offset = (
    await client.query('SELECT sequence FROM projection_offsets WHERE stream_id=$1 FOR UPDATE', [event.stream_id])
  ).rows[0];
  const last = Number(offset?.sequence ?? 0);
  const next = Number(event.stream_sequence);
  if (next <= last) return;
  if (next !== last + 1)
    throw new DomainError(409, 'missing_predecessor', 'Projection waits for the preceding stream position');
  // Their queueing reads the adopted rules under the tenant's shared lock. Take it before any row lock, as an
  // adoption's projection takes it exclusively before the organization row: a flight created here shares that row,
  // and taken in the other order the two projections deadlock.
  if (FLIGHT_STATE_EVENTS.includes(event.event_type)) await lockAdoptedRules(client, event.tenant_id, 'shared');
  let receipt = (await client.query<ProjectionReceipt>('SELECT * FROM receipts WHERE event_id=$1', [event.id])).rows[0];
  let observationProjections: Awaited<ReturnType<typeof projectObservationEvent>> = [];
  if (isSmsEvent(event)) {
    await projectSmsEvent(client, event);
    await scheduleAcceptedControlBoundaries(client, event);
  } else if (event.event_type === 'observation') {
    // Intake stores accepted observations itself; they add no flight claims. Rules that read the observation are
    // queued for the generic evaluator, and projectors registered for its type add what they read.
    await queueRuleEvaluationsForObservation(client, event);
    await queueRuleEvaluationsForCorrection(client, event);
    // A command on the flight locks its view before its subject and live head, which this projection takes below;
    // take the view first too, or a person's command and the projection of the flight's observation deadlock.
    if (receipt?.flight_id) await requireRow(client, 'flight_views', receipt.flight_id, true);
    observationProjections = await projectObservationEvent(client, event);
  } else if (['observation.withdraw', 'observation.resolve-subject', 'subject.alias'].includes(event.event_type)) {
    // Corrections to accepted observations are stored at acceptance; rules reading what they affected are queued.
    await queueRuleEvaluationsForCorrection(client, event);
    observationProjections = await projectObservationEvent(client, event);
  } else if (event.event_type === FLIGHT_PREDEPARTURE_EVENT) {
    // A command on the flight locks its view before its live head; take them in the same order, or a person's
    // command and the source's progress on one held flight deadlock.
    await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      event.tenant_id,
      event.payload.progress.flightId,
    ]);
    // Then its subjects, before the live head.
    await lockProjectionSubjects(client);
    await validateFlightPredepartureEvent(client, event);
    await appendLiveChange(client, principal.tenantId, event.payload.progress.flightId, event.id, 'flight.updated');
  } else if ((SIMULATION_AVOIDANCE_DEMO_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
    await validateSimulationAvoidanceDemoEvent(client, event);
  } else if (event.event_type === 'rule-pack.adopt') {
    await projectPackAdoption(client, event);
  } else if (event.event_type === 'decision.record' && event.payload.subject?.kind === 'organization') {
    await projectOrganizationDecision(client, event);
  } else if (event.event_type === 'mission.release') {
    await projectMissionReleaseEvent(client, event);
    const flightId = String(event.payload.flightId);
    await client.query(
      'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1) WHERE tenant_id=$2 AND id=$3',
      [event.received_at, event.tenant_id, flightId],
    );
    await timeline(client, event, flightId, 'checks', 'Mission route release recorded');
  } else if (event.event_type === 'mission.departure-authorize') {
    await projectMissionDepartureEvent(client, event);
    const flightId = String(event.payload.flightId);
    await client.query(
      'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1) WHERE tenant_id=$2 AND id=$3',
      [event.received_at, event.tenant_id, flightId],
    );
    await timeline(client, event, flightId, 'checks', 'Departure authorization recorded');
  } else if (['mission.brief', 'mission.briefing-acknowledge'].includes(event.event_type)) {
    await projectMissionBriefingEvent(client, event);
    const flightId = String(event.payload.flightId);
    await client.query(
      'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1) WHERE tenant_id=$2 AND id=$3',
      [event.received_at, event.tenant_id, flightId],
    );
    await timeline(
      client,
      event,
      flightId,
      'checks',
      event.event_type === 'mission.brief' ? 'Mission briefing recorded' : 'Mission briefing acknowledged',
    );
  } else if (event.event_type === 'monitoring.window') {
    // Its subjects before the receipt the projection reads.
    await lockProjectionSubjects(client);
    await projectMonitoringWindowEvent(client, event, options.objectStore ?? createObjectStore());
  } else if (event.event_type === 'mission.revision') {
    await projectMissionEvent(client, event);
    if (
      !receipt ||
      !receipt.flight_id ||
      receipt.flight_id !== event.payload.flightId ||
      receipt.link_status !== 'linked'
    )
      throw new DomainError(
        409,
        'mission_identity_changed',
        'Mission evidence must retain its accepted flight identity',
      );
    await requireRow(client, 'flight_views', receipt.flight_id, true);
    await client.query(
      'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1),source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$2]::text[])) WHERE id=$3',
      [event.received_at, event.source_id, receipt.flight_id],
    );
    await timeline(
      client,
      event,
      receipt.flight_id,
      'plan',
      `Mission plan revision ${event.payload.sourceRevision}`,
      receipt,
    );
  } else if (event.event_type === 'command-link.baseline') {
    await projectCommandLinkBaselineEvent(client, event, options.objectStore ?? createObjectStore());
    const flightId = String(event.payload.flightId);
    if (!receipt || receipt.flight_id !== flightId || receipt.link_status !== 'linked')
      throw new DomainError(
        409,
        'command_link_identity_changed',
        'Baseline evidence must retain its accepted flight identity',
      );
    await client.query(
      'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1),source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$2]::text[])) WHERE tenant_id=$3 AND id=$4',
      [event.received_at, event.source_id, event.tenant_id, flightId],
    );
    await timeline(
      client,
      event,
      flightId,
      'observed',
      `Command link initially ${event.payload.payload.state}`,
      receipt,
    );
  } else if (event.event_type === 'command-link.status') {
    validateAcceptedCommandLinkAuthority(event);
    const flightId = String(event.payload.flightId);
    if (!receipt || receipt.flight_id !== flightId || receipt.link_status !== 'linked')
      throw new DomainError(
        409,
        'command_link_identity_changed',
        'Command-link evidence must retain its accepted flight identity',
      );
    await requireRow(client, 'flight_views', flightId, true);
    await client.query(
      'UPDATE flight_views SET revision=revision+1,last_received_at=GREATEST(last_received_at,$1),source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$2]::text[])) WHERE id=$3',
      [event.received_at, event.source_id, flightId],
    );
    await timeline(
      client,
      event,
      flightId,
      'observed',
      `Command link reported ${event.payload.payload.status}`,
      receipt,
    );
  } else if (event.event_type === 'telemetry.segment') {
    await projectTelemetry(client, event, options.objectStore ?? createObjectStore());
    // Object I/O yields outside the identity boundary. Re-read afterwards, lock
    // flight before receipt as commands do, then reject a concurrently changed link.
    receipt = await requireReceipt(client, receipt.id);
    const resolved = receipt.flight_id
      ? { id: receipt.flight_id, status: 'linked' }
      : await resolveFlight(client, event.payload as unknown as Input, false);
    if (resolved.id) await requireRow(client, 'flight_views', resolved.id, true);
    const guarded = await requireReceipt(client, receipt.id, true);
    if (guarded.flight_id !== receipt.flight_id || guarded.link_status !== receipt.link_status)
      throw new DomainError(
        409,
        'telemetry_link_changed',
        'Telemetry identity changed during projection; retry with its current journaled link',
      );
    receipt = guarded;
    if (resolved.id) {
      // One segment-sized lock protects the new visible map basis; sample writes never lock the flight.
      await client.query(
        'UPDATE flight_views SET revision=revision+1,last_occurred_at=GREATEST(last_occurred_at,$1),source_ids=ARRAY(SELECT DISTINCT unnest(source_ids||ARRAY[$2]::text[])) WHERE id=$3',
        [event.occurred_at, event.source_id, resolved.id],
      );
      await client.query("UPDATE receipts SET flight_id=$1,link_status='linked' WHERE id=$2", [
        resolved.id,
        receipt.id,
      ]);
      await timeline(client, event, resolved.id, 'observed', 'Retained durable telemetry segment', receipt);
      receipt.flight_id = resolved.id;
    }
  } else if (event.event_type === 'order.revision') {
    const { principal: issuer, ...origin } = await originationContext(client, principal, event);
    const input = event.payload as unknown as Input;
    const order = input.payload as Record<string, any>;
    const external = input.subject.orderId ?? order.externalId;
    if (typeof external !== 'string')
      throw new DomainError(400, 'invalid_order', 'Order needs source-scoped external identity');
    await lockOrderIdentity(client, principal.tenantId, input.sourceId, external);
    const fulfillmentKeys = Array.isArray(order.fulfillments)
      ? order.fulfillments
          .map((item: any) => item?.originationKey)
          .filter((key: unknown): key is string => typeof key === 'string')
      : [];
    await lockOriginationKeys(client, principal.tenantId, fulfillmentKeys);
    await client.query(
      'SELECT v.id FROM flight_views v WHERE v.origination_key=ANY($1::text[]) OR EXISTS(SELECT 1 FROM fulfillments f WHERE f.flight_id=v.id AND f.source_id=$2 AND f.order_external_id=$3) ORDER BY v.id COLLATE "C" FOR UPDATE',
      [fulfillmentKeys, input.sourceId, external],
    );
    const revision = input.sourceRevision ?? Number(order.revision ?? 0);
    const existing = (
      await client.query('SELECT * FROM operational_orders WHERE source_id=$1 AND external_id=$2 FOR UPDATE', [
        input.sourceId,
        external,
      ])
    ).rows[0];
    const shouldApply = !existing || revision > Number(existing.revision);
    if (
      existing &&
      revision === Number(existing.revision) &&
      canonicalDigest(existing.payload) !== canonicalDigest(order)
    )
      throw new DomainError(409, 'source_revision_conflict', 'Same source order revision carries conflicting content');
    if (shouldApply) {
      const id = existing?.id ?? randomUUID();
      if (!existing)
        await client.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'order',$3)", [
          id,
          principal.tenantId,
          order.label ?? external,
        ]);
      await client.query(
        `INSERT INTO operational_orders(id,tenant_id,source_id,external_id,revision,status,payload,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(tenant_id,source_id,external_id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status,payload=EXCLUDED.payload,event_id=EXCLUDED.event_id`,
        [id, principal.tenantId, input.sourceId, external, revision, order.status ?? 'accepted', order, event.id],
      );
      if (Array.isArray(order.fulfillments))
        for (const fulfillment of order.fulfillments as FlightCreate[]) {
          const flight = await createFlight(
            client,
            issuer,
            { ...fulfillment, orderRefs: fulfillment.orderRefs ?? [{ orderId: external, revision }] },
            input.sourceId,
            event.id,
            origin,
          );
          await addFulfillments(
            client,
            principal,
            flight.id,
            fulfillment.orderRefs ?? [{ orderId: external, revision }],
            input.sourceId,
          );
          await timeline(client, event, flight.id, 'plan', `Order ${external} revision ${revision}`, receipt);
          // Order changes participate in the same protected basis used by decision acceptance.
          await client.query(
            'UPDATE flight_views SET basis_revision=basis_revision+1,revision=revision+1 WHERE id=$1',
            [flight.id],
          );
          if (receipt)
            await client.query(
              "UPDATE receipts SET link_status='linked',flight_id=COALESCE(flight_id,$1) WHERE id=$2",
              [flight.id, receipt.id],
            );
        }
      if (order.status === 'cancelled')
        await client.query(
          "UPDATE flight_views SET activity=CASE WHEN activity IN ('unknown','planned') THEN 'cancelled' ELSE activity END,basis_revision=basis_revision+1,revision=revision+1 WHERE id IN(SELECT flight_id FROM fulfillments WHERE source_id=$1 AND order_external_id=$2)",
          [input.sourceId, external],
        );
    }
  } else if (event.event_type === 'intent.revision') {
    const { principal: issuer, ...origin } = await originationContext(client, principal, event);
    const input = event.payload as unknown as Input;
    const raw = (input.payload.intent ?? input.payload) as Record<string, any>;
    const key = input.subject.originationKey ?? raw.originationKey;
    if (typeof key !== 'string') throw new DomainError(400, 'invalid_intent', 'Intent needs a stable origination key');
    const revision = input.sourceRevision ?? raw.revision ?? 0;
    await lockOriginationKeys(client, principal.tenantId, [key]);
    const current = (
      await client.query(
        'SELECT id,intent_revision,intent_source_id FROM flight_views WHERE origination_key=$1 FOR UPDATE',
        [key],
      )
    ).rows[0];
    const interpretation = await retainIntentRevision(client, event, input, key, current);
    const flight = await createFlight(
      client,
      issuer,
      { ...raw, originationKey: key, intentRef: { id: input.subject.externalFlightId ?? key, revision } },
      input.sourceId,
      event.id,
      origin,
    );
    if (interpretation.sourceId)
      await client.query('UPDATE flight_views SET intent_source_id=$1 WHERE id=$2', [
        interpretation.sourceId,
        flight.id,
      ]);
    if (interpretation.apply) {
      await addFulfillments(client, principal, flight.id, raw.orderRefs ?? [], input.sourceId);
      await client.query(
        `UPDATE flight_views SET intent_revision=$1,label=COALESCE($2,label),
       aircraft=CASE WHEN EXISTS(SELECT 1 FROM command_records c WHERE c.flight_id=flight_views.id AND c.kind='flight.assign') THEN aircraft ELSE COALESCE($3,aircraft) END,
       scheduled_start=COALESCE($4,scheduled_start),scheduled_end=COALESCE($5,scheduled_end),basis_revision=basis_revision+1,revision=revision+1 WHERE id=$6`,
        [
          revision,
          raw.label ?? null,
          raw.aircraft ?? null,
          raw.scheduledStart ?? null,
          raw.scheduledEnd ?? null,
          flight.id,
        ],
      );
    }
    await timeline(client, event, flight.id, 'plan', `Flight intent revision ${revision}`, receipt);
    if (receipt)
      await client.query("UPDATE receipts SET flight_id=$1,link_status='linked' WHERE id=$2", [flight.id, receipt.id]);
  } else if (receipt) {
    const resolved = receipt.flight_id
      ? { id: receipt.flight_id, status: 'linked' }
      : await resolveFlight(client, event.payload as unknown as Input);
    if (resolved.id) {
      // A command on the flight locks its view before the receipt, as an identity link does; take them in the same
      // order, or a person's link and the projection of the linked report deadlock.
      await requireRow(client, 'flight_views', resolved.id, true);
      await client.query("UPDATE receipts SET flight_id=$1,link_status='linked' WHERE id=$2", [
        resolved.id,
        receipt.id,
      ]);
      await applyObservation(client, event, receipt, resolved.id);
      // A report intake could not link is attached to the flight its projection found.
      if (!receipt.flight_id)
        await bridgeLegacyFlightReportLink(client, principal, { receiptId: receipt.id, flightId: resolved.id }, event);
    }
  } else if (event.payload.flightId) {
    const flightId = String(event.payload.flightId);
    if (event.event_type === 'identity.link') {
      const linked = await requireReceipt(client, String(event.payload.receiptId));
      const original = (await client.query('SELECT * FROM journal_events WHERE id=$1', [linked.event_id]))
        .rows[0] as JournalEvent;
      const previousClaims = await client.query(
        'SELECT DISTINCT flight_id FROM claims WHERE receipt_id=$1 AND flight_id<>$2',
        [linked.id, flightId],
      );
      const previousIds = new Set<string>(previousClaims.rows.map((row) => row.flight_id));
      if (event.payload.previousFlightId && event.payload.previousFlightId !== flightId)
        previousIds.add(String(event.payload.previousFlightId));
      for (const id of [flightId, ...previousIds].sort()) await requireRow(client, 'flight_views', id, true);
      if (original.event_type === 'telemetry.segment')
        await timeline(client, original, flightId, 'observed', 'Retained durable telemetry segment', linked);
      else await applyObservation(client, original, linked, flightId);
      for (const id of previousIds) {
        await refreshObservationSummary(client, id);
        await timeline(client, event, id, 'plan', 'Evidence identity moved to another flight');
        await client.query('INSERT INTO view_changes(tenant_id,flight_id,event_id) VALUES($1,$2,$3)', [
          principal.tenantId,
          id,
          event.id,
        ]);
      }
    }
    if (event.event_type === 'evidence.correct') {
      const original = (
        await client.query('SELECT * FROM claims WHERE event_id=$1 AND flight_id=$2', [
          event.payload.correctionOf,
          flightId,
        ])
      ).rows[0];
      if (original) {
        await client.query(
          'INSERT INTO claims(id,tenant_id,event_id,flight_id,kind,payload,occurred_at,correction_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
          [
            `${event.id}:${flightId}`,
            event.tenant_id,
            event.id,
            flightId,
            original.kind,
            event.payload.payload,
            event.occurred_at,
            original.id,
          ],
        );
        await refreshObservationSummary(client, flightId);
      }
    }
    const lane =
      event.event_type === 'decision.record'
        ? 'decisions'
        : event.event_type === 'evidence.correct'
          ? 'evidence'
          : 'plan';
    await timeline(
      client,
      event,
      flightId,
      lane,
      event.event_type === 'decision.record'
        ? `Decision: ${event.payload.decision.kind}`
        : event.event_type === 'evidence.correct'
          ? 'Appended evidence correction'
          : event.event_type === 'flight.assign'
            ? 'Aircraft assignment'
            : 'Flight identity',
    );
  }
  // An older input kind can carry an observation too (the legacy flight-report bridge records one at intake).
  if (event.event_type !== 'observation') await queueRuleEvaluationsForObservation(client, event);
  // Every subject that retained this stream at or after the event: the projection's first subject lock took them all
  // in one statement, or, if no step locked a subject, they are taken here.
  await lockProjectionSubjects(client);
  await client.query(
    'INSERT INTO projection_offsets(tenant_id,stream_id,sequence,projector_version) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,stream_id) DO UPDATE SET sequence=EXCLUDED.sequence,projector_version=EXCLUDED.projector_version',
    [principal.tenantId, event.stream_id, next, PROJECTOR_VERSION],
  );
  await client.query('INSERT INTO view_changes(tenant_id,flight_id,event_id) VALUES($1,$2,$3)', [
    principal.tenantId,
    receipt?.flight_id ?? event.payload.flightId ?? null,
    event.id,
  ]);
  const affected = await client.query<{ flight_id: string }>(
    'SELECT DISTINCT flight_id FROM timeline_items WHERE id=$1 UNION SELECT flight_id FROM receipts WHERE event_id=$1 AND flight_id IS NOT NULL',
    [event.id],
  );
  if (event.event_type === 'order.revision') {
    const input = event.payload as unknown as Input;
    const external = input.subject.orderId ?? input.payload.externalId;
    const linked = await client.query<{ flight_id: string }>(
      'SELECT DISTINCT flight_id FROM fulfillments WHERE source_id=$1 AND order_external_id=$2',
      [input.sourceId, external],
    );
    for (const row of linked.rows)
      if (!affected.rows.some((existing) => existing.flight_id === row.flight_id)) affected.rows.push(row);
  }
  if (FLIGHT_STATE_EVENTS.includes(event.event_type))
    for (const { flight_id } of affected.rows.sort(byFlight))
      // Rules that read a flight's own state are queued when it changes.
      await queueRuleEvaluationsForSubjectState(client, event, 'flight', flight_id);
  await settleObservationEvent(client, principal, event, observationProjections);
  for (const { flight_id } of affected.rows.sort(byFlight))
    await appendLiveChange(
      client,
      principal.tenantId,
      flight_id,
      event.id,
      event.event_type === 'telemetry.segment' ? 'telemetry.updated' : 'flight.updated',
      receipt?.id,
    );
}
