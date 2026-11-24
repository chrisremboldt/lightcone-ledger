import {
  CONTROL_INDICATOR_LIMITS,
  type ControlIndicatorRecord,
  type ControlIndicatorResultListResponse,
  type ControlIndicatorResultRecord,
  type ControlIndicatorResultResponse,
  type ControlIndicatorReview,
  type ControlIndicatorReviewRecord,
  type ControlIndicatorReviewResponse,
  type ControlWindow,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  appendEvent,
  authFromRow,
  DomainError,
  idempotent,
  type AuthContext,
  type PoolClient,
} from '@ledger/persistence';
import { controlWindowIndicatorRequest, getControlWindow } from './control-windows.js';
import { gatherIndicatorInputs } from './indicator-gathering.js';
import { calculateIndicator, findIndicatorDefinition } from './indicators.js';
import { indicatorResultWording, principalNames } from './indicator-wording.js';

// Recorded indicator results for a control, and the human review of one. The review means what the review of the
// draft control-effectiveness calculation meant, by the same authority; it now binds a recorded result's digest.

const REVIEW_CAPABILITIES = ['decision:write', 'flight:read'] as const;

interface PrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  capabilities: string[];
  revision: string;
}

function controlColumns(control: ControlWindow['control']) {
  return { kind: control.kind, hazardId: control.hazardId, id: control.recordId, version: control.versionNumber };
}

function mismatch(): never {
  throw new DomainError(
    409,
    'control_indicator_commitment_mismatch',
    'A recorded indicator result or review differs from its retained digest',
  );
}

/** Calculates the result a recorded request gives now, from the same window revision and cut. */
async function recalculate(client: PoolClient, principal: AuthContext, record: ControlIndicatorResultRecord) {
  const gathering = await gatherIndicatorInputs(client, principal, {
    definition: { ...record.request.definition },
    window: { ...record.request.window },
    recordedThrough: record.request.recordedThrough,
    control: { id: record.result.control!.id, version: record.result.control!.version },
    population: structuredClone(record.request.population),
  });
  return { gathering, result: calculateIndicator(gathering.definition, gathering.input) };
}

async function loadResult(
  client: PoolClient,
  principal: AuthContext,
  resultId: string,
): Promise<{ record: ControlIndicatorResultRecord; digest: string }> {
  const row = (
    await client.query<{ record: ControlIndicatorResultRecord; record_digest: string }>(
      'SELECT record,record_digest FROM control_indicator_results WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, resultId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'control_indicator_result_not_found', 'The recorded result was not found here');
  if (canonicalDigest(row.record) !== row.record_digest) mismatch();
  return { record: row.record, digest: row.record_digest };
}

/**
 * Records one indicator result for a control window, at the window's current revision. The person cites the window
 * revision and indicator definition they were shown; a changed window or definition conflicts.
 */
export async function recordControlWindowIndicator(
  client: PoolClient,
  principal: AuthContext,
  windowId: string,
  input: ControlIndicatorRecord,
  key: string,
): Promise<{ response: ControlIndicatorResultResponse; replayed: boolean }> {
  const result = await idempotent(
    client,
    principal,
    `control-window.indicator:${windowId}`,
    key,
    input,
    async () => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('control-window-revision',$1::text,$2::text)::text,0))`,
        [principal.tenantId, windowId],
      );
      const window = await getControlWindow(client, principal, windowId);
      const cited = window.indicators.find(
        (entry) => entry.id === input.definition.id && entry.version === input.definition.version,
      );
      if (
        window.revision.number !== input.expectedRevision.number ||
        window.revision.digest !== input.expectedRevision.digest ||
        cited?.digest !== input.definition.digest ||
        findIndicatorDefinition(input.definition.id, input.definition.version)?.digest !== input.definition.digest
      )
        throw new DomainError(
          409,
          'stale_basis',
          'The window or the indicator changed since it was shown; review it again',
        );
      const request = controlWindowIndicatorRequest(window, input.definition);
      const gathering = await gatherIndicatorInputs(client, principal, request);
      const calculated = calculateIndicator(gathering.definition, gathering.input);
      const control = controlColumns(window.control);
      const event = await appendEvent(client, principal, {
        type: 'control-window.indicator-recorded',
        stream: `control-window:${windowId}`,
        payload: ({ id, receivedAt }) => ({
          format: 'ledger.control-indicator-result.1',
          id,
          organizationId: window.organizationId,
          windowId,
          windowRevision: window.revision.number,
          windowRevisionDigest: window.revision.digest,
          control: structuredClone(window.control),
          request: {
            definition: { ...request.definition },
            window: { ...request.window },
            recordedThrough: request.recordedThrough,
            population: structuredClone(request.population!),
          },
          selection: gathering.outcome,
          result: calculated,
          actorId: principal.id,
          recordedAt: receivedAt,
        }),
      });
      const record = event.payload as unknown as ControlIndicatorResultRecord;
      await client.query(
        `INSERT INTO control_indicator_results(id,tenant_id,organization_id,window_id,window_revision,control_kind,hazard_id,
         control_id,control_version,definition_id,definition_version,definition_digest,exposure_kind_digest,
         recorded_through,status,input_digest,actor_id,recorded_at,record,record_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          record.id,
          principal.tenantId,
          record.organizationId,
          windowId,
          record.windowRevision,
          control.kind,
          control.hazardId,
          control.id,
          control.version,
          calculated.definition.id,
          calculated.definition.version,
          calculated.definition.digest,
          calculated.exposureKind.digest,
          calculated.recordedThrough,
          calculated.status,
          calculated.inputDigest,
          principal.id,
          event.received_at,
          record,
          canonicalDigest(record),
        ],
      );
      return { id: record.id, value: record.id };
    },
    async (id) => id,
  );
  return { response: await getControlIndicatorResult(client, principal, result.value), replayed: result.replayed };
}

/** One recorded result, with whether gathering the same request again reads the same inputs. */
export async function getControlIndicatorResult(
  client: PoolClient,
  principal: AuthContext,
  resultId: string,
): Promise<ControlIndicatorResultResponse> {
  const { record, digest } = await loadResult(client, principal, resultId);
  const { result } = await recalculate(client, principal, record);
  const names = await principalNames(client, principal.tenantId, [record.result.population.declaredBy]);
  return {
    record,
    digest,
    wording: indicatorResultWording(record.result, { subjectKind: record.request.population.subjects[0]?.kind, names }),
    currentness: {
      status: result.inputDigest === record.result.inputDigest ? 'current' : 'changed',
      checkedAt: new Date().toISOString(),
      inputDigest: result.inputDigest,
    },
  };
}

/** The results recorded for one window and the reviews of them, newest first. */
export async function listControlWindowIndicatorResults(
  client: PoolClient,
  principal: AuthContext,
  windowId: string,
): Promise<ControlIndicatorResultListResponse> {
  const window = await getControlWindow(client, principal, windowId);
  const limit = CONTROL_INDICATOR_LIMITS.maxListed;
  const results = await client.query<{ record: ControlIndicatorResultRecord; record_digest: string }>(
    `SELECT record,record_digest FROM control_indicator_results WHERE tenant_id=$1 AND window_id=$2
     ORDER BY recorded_at DESC,id DESC LIMIT $3`,
    [principal.tenantId, windowId, limit],
  );
  const reviews = await client.query<{ record: ControlIndicatorReviewRecord; record_digest: string }>(
    `SELECT v.record,v.record_digest FROM control_indicator_reviews v
     JOIN control_indicator_results r ON r.tenant_id=v.tenant_id AND r.id=v.result_id
     WHERE v.tenant_id=$1 AND r.window_id=$2 ORDER BY v.recorded_at DESC,v.id DESC LIMIT $3`,
    [principal.tenantId, windowId, limit],
  );
  for (const row of [...results.rows, ...reviews.rows])
    if (canonicalDigest(row.record) !== row.record_digest) mismatch();
  const names = await principalNames(
    client,
    principal.tenantId,
    results.rows.map((row) => row.record.result.population.declaredBy),
  );
  const subjectKind = window.population.subjectKind;
  return {
    results: results.rows.map((row) => ({
      record: row.record,
      digest: row.record_digest,
      wording: indicatorResultWording(row.record.result, { subjectKind, names }),
    })),
    reviews: reviews.rows.map((row) => ({ record: row.record, digest: row.record_digest })),
  };
}

/**
 * Records a person's review of one recorded indicator result. A supported current result allows any conclusion; an
 * insufficient or conflicting one only inconclusive; a result whose inputs changed since it was recorded allows none.
 */
export async function reviewControlIndicatorResult(
  client: PoolClient,
  principal: AuthContext,
  input: ControlIndicatorReview,
  key: string,
): Promise<{ response: ControlIndicatorReviewResponse; replayed: boolean }> {
  const result = await idempotent(
    client,
    principal,
    'control-indicator.review',
    key,
    input,
    async () => {
      const actor = (
        await client.query<PrincipalRow>(
          'SELECT id,tenant_id,name,kind,capabilities,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
          [principal.tenantId, principal.id],
        )
      ).rows[0];
      if (
        !actor ||
        actor.kind !== 'human' ||
        !REVIEW_CAPABILITIES.every((capability) => actor.capabilities.includes(capability))
      )
        throw new DomainError(
          403,
          'effectiveness_review_authority_required',
          'An active human with decision and flight read authority must author the review',
        );
      const current = authFromRow(actor);
      const cited = await getControlIndicatorResult(client, current, input.result.id);
      if (cited.digest !== input.result.digest)
        throw new DomainError(409, 'stale_basis', 'Cite the recorded result exactly as it was shown');
      const status = cited.record.result.status;
      if (cited.currentness.status !== 'current')
        throw new DomainError(
          409,
          'effectiveness_review_prerequisite',
          'The evidence for this result changed since it was recorded; record the result again before reviewing',
        );
      if (status !== 'supported' && input.conclusion !== 'inconclusive')
        throw new DomainError(
          409,
          'effectiveness_review_prerequisite',
          'A result that states no rate can only be reviewed as inconclusive',
        );
      const control = controlColumns(cited.record.control);
      const event = await appendEvent(client, current, {
        type: 'control-indicator.reviewed',
        stream: `control-window:${cited.record.windowId}`,
        causationId: cited.record.id,
        payload: ({ id, receivedAt }) => ({
          format: 'ledger.control-indicator-review.1',
          id,
          organizationId: cited.record.organizationId,
          control: structuredClone(cited.record.control),
          result: { id: cited.record.id, digest: cited.digest },
          resultStatus: status,
          conclusion: input.conclusion,
          note: input.note,
          actor: {
            id: current.id,
            name: current.name,
            kind: 'human',
            principalRevision: current.revision,
            capabilities: [...current.capabilities],
            checkedCapabilities: [...REVIEW_CAPABILITIES],
            policyVersion: 'ledger.control-effectiveness-review-authority.2',
          },
          recordedAt: receivedAt,
        }),
      });
      const record = event.payload as unknown as ControlIndicatorReviewRecord;
      await client.query(
        `INSERT INTO control_indicator_reviews(id,tenant_id,organization_id,result_id,result_digest,control_kind,hazard_id,
         control_id,control_version,conclusion,actor_id,recorded_at,record,record_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          record.id,
          current.tenantId,
          record.organizationId,
          record.result.id,
          record.result.digest,
          control.kind,
          control.hazardId,
          control.id,
          control.version,
          record.conclusion,
          current.id,
          event.received_at,
          record,
          canonicalDigest(record),
        ],
      );
      return { id: record.id, value: record.id };
    },
    async (id) => id,
  );
  return { response: await getControlIndicatorReview(client, principal, result.value), replayed: result.replayed };
}

export async function getControlIndicatorReview(
  client: PoolClient,
  principal: AuthContext,
  reviewId: string,
): Promise<ControlIndicatorReviewResponse> {
  const row = (
    await client.query<{ record: ControlIndicatorReviewRecord; record_digest: string }>(
      'SELECT record,record_digest FROM control_indicator_reviews WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, reviewId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'control_indicator_review_not_found', 'The review was not found here');
  if (canonicalDigest(row.record) !== row.record_digest) mismatch();
  await loadResult(client, principal, row.record.result.id);
  return { record: row.record, digest: row.record_digest };
}
