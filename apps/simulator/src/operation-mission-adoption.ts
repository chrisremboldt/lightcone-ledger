import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  MissionRevisionRecordSchema,
  type ArtifactResponse,
  type MissionRevisionRecord,
  type ReceiptResponse,
} from '@ledger/contracts';
import { FlightMissionResponseSchema } from '@ledger/contracts/openapi';
import { canonicalDigest, parseStrictJson, sha256 } from '@ledger/integrity';
import {
  adoptOperationMissionSource,
  operationAdditiveFlight,
  validateOperationMissionSource,
  type OperationMissionSource,
} from '@ledger/simulation-models/operation';
import type { OracleReader } from './attempt-oracle.js';
import type { MissionDeparturePlan } from './mission-departure-plan.js';
import { ReleasePending } from './mission-release-plan.js';
import { advanceLiveClock, type OperationStore } from './operation-state.js';
import type { OperationActionClock } from './operation-action-clock.js';

const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const missionShape = ajv.compile<MissionRevisionRecord>(MissionRevisionRecordSchema);
const headShape = ajv.compile(FlightMissionResponseSchema);
const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);
function pending(code: string, reason: string): never {
  throw new ReleasePending(code, reason);
}

export function operationSourceFromMission(record: MissionRevisionRecord): OperationMissionSource {
  return {
    sourceRevision: record.sourceRevision,
    occurredAt: record.occurredAt,
    sourceMissionId: record.sourceMissionId,
    aircraftId: record.aircraftId,
    route: structuredClone(record.route),
    lateralToleranceMeters: record.lateralToleranceMeters,
    altitude: { ...record.altitude },
    operatingInterval: { ...record.operatingInterval },
    ...(record.routePlanning ? { routePlanning: structuredClone(record.routePlanning) } : {}),
  };
}

export async function adoptSelectedPublicMission(
  plan: MissionDeparturePlan,
  record: MissionRevisionRecord,
  store: OperationStore,
  api: OracleReader,
  now: () => number,
  clock?: OperationActionClock,
): Promise<'unchanged' | 'adopted'> {
  const reservation = store.state.world.reservations?.find((row) => row.id === plan.reservationId);
  const source = operationSourceFromMission(record);
  if (reservation && same(reservation.plan, source)) return 'unchanged';
  if (
    !missionShape(record) ||
    !reservation ||
    (store.state.world.config.predeparture?.version !== 'reserve-selected-await-release.1' &&
      !operationAdditiveFlight(store.state.world, plan.reservationId)) ||
    record.flightId !== plan.flightId ||
    record.aircraftId !== plan.aircraftId ||
    record.sourceId !== 'mission-planner' ||
    record.sourceMissionId !== `${plan.reservationId}:mission` ||
    record.authority.tenantId !== plan.tenantId ||
    record.authority.sourceId !== record.sourceId ||
    !record.authority.grantedSources.includes(record.sourceId) ||
    !same(plan.mission, {
      missionId: record.missionId,
      sourceRevision: record.sourceRevision,
      eventId: record.id,
      contentDigest: record.contentDigest,
      recordDigest: canonicalDigest(record),
    })
  )
    pending('mission_adoption_mismatch', 'The public mission does not match this exact selected departure');
  const previousDigest = canonicalDigest(reservation.plan);
  const { receipt } = await api.json<ReceiptResponse>(`/v1/receipts/${encodeURIComponent(record.receiptId)}`);
  const { artifact } = await api.json<ArtifactResponse>(`/v1/artifacts/${encodeURIComponent(record.artifactId)}`);
  const bytes = await api.bytes(`/v1/artifacts/${encodeURIComponent(record.artifactId)}/content`);
  if (
    bytes.byteLength > 64 * 1024 ||
    artifact?.id !== record.artifactId ||
    artifact.contentType !== 'application/json' ||
    artifact.byteLength !== bytes.byteLength ||
    artifact.sha256 !== sha256(bytes) ||
    !same(record.original, { sha256: artifact.sha256, byteLength: artifact.byteLength })
  )
    pending('mission_adoption_original', 'The public mission original bytes or metadata do not agree');
  let original: unknown;
  try {
    original = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    pending('mission_adoption_original', 'The public mission original is not supported strict JSON');
  }
  validateOperationMissionSource(original);
  if (!same(original, source))
    pending('mission_adoption_original', 'The retained source differs from the projected mission');
  const { sourceRevision, occurredAt, ...payload } = source;
  if (
    !receipt ||
    receipt.id !== record.receiptId ||
    receipt.kind !== 'mission.revision' ||
    receipt.status !== 'accepted' ||
    receipt.processing?.status !== 'completed' ||
    receipt.linkStatus !== 'linked' ||
    receipt.eventId !== record.id ||
    receipt.flightId !== plan.flightId ||
    receipt.sourceId !== record.sourceId ||
    receipt.artifactId !== record.artifactId ||
    Date.parse(receipt.occurredAt) !== Date.parse(record.occurredAt) ||
    !same(receipt.payload, payload) ||
    record.contentDigest !==
      canonicalDigest({
        version: 'ledger.mission-content.1',
        sourceId: record.sourceId,
        flightId: record.flightId,
        sourceRevision,
        occurredAt,
        fidelity: 'synthetic_contract',
        payload,
        original: {
          sha256: artifact.sha256,
          byteLength: bytes.byteLength,
          bytesBase64: Buffer.from(bytes).toString('base64'),
        },
      })
  )
    pending('mission_adoption_receipt', 'The source receipt does not confirm the exact projected mission');
  const head = await api.json<unknown>(`/v1/flights/${encodeURIComponent(plan.flightId)}/mission`);
  if (
    !headShape(head) ||
    !head.acceptedHead ||
    !head.projectedHead ||
    head.acceptedHead.processing.status !== 'completed' ||
    !same(head.acceptedHead.record, record) ||
    !same(head.projectedHead, record) ||
    !same(head.binding, {
      missionId: record.missionId,
      flightId: record.flightId,
      sourceId: record.sourceId,
      sourceMissionId: record.sourceMissionId,
      aircraftId: record.aircraftId,
    })
  )
    pending('mission_pending', 'The selected source revision is no longer the accepted and projected mission');
  await store.update((state) => {
    if (
      state.world.config.runId !== plan.runId ||
      state.clock.mode !== 'live' ||
      state.clock.paused ||
      state.world.now !== state.clock.wallAt ||
      state.departureRequests?.[plan.flightId] ||
      canonicalDigest(state.world.reservations?.find((row) => row.id === plan.reservationId)?.plan ?? null) !==
        previousDigest
    )
      pending('mission_adoption_changed', 'The held reservation changed before the public revision could be adopted');
    const at = now();
    if (!Number.isSafeInteger(at) || at < state.clock.wallAt)
      pending('world_clock_unavailable', 'Mission adoption requires the current finite live clock');
    if (clock) clock(state, at);
    else advanceLiveClock(state, at, false);
    try {
      adoptOperationMissionSource(
        state.world,
        plan.reservationId,
        source,
        { receiptId: record.receiptId, originalBytesBase64: Buffer.from(bytes).toString('base64') },
        { marginMs: plan.marginMs, handoffAllowanceMs: plan.handoffAllowanceMs },
      );
    } catch (error) {
      pending(
        'mission_adoption_refused',
        error instanceof Error ? error.message : 'The held mission cannot adopt this revision',
      );
    }
  });
  return 'adopted';
}
