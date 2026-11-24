import type { FlightInput, ObservationInput } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  createObjectStore,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';
import {
  lockObservationCorrection,
  observationStanding,
  resolveObservationSubject,
  withdrawObservation,
} from './observation-corrections.js';
import { observationRegistry, validateObservation } from './observation-registry.js';
import { acceptObservationInput } from './observations.js';
import { retainPayload } from './retained-payload.js';

/**
 * LEGACY BRIDGE. Reports on the older `flight.observation` input kind, their `evidence.correct` corrections and their
 * `identity.link` moves are recorded a second time as the vocabulary's `flight.report@1` observation and the generic
 * correction records, in the same transaction, so rules read observations only (docs/design/observation-vocabulary.md,
 * "Mapping of today's inputs"). The older claims and their projections are unchanged. It knows the two input shapes
 * and nothing about any rule. It goes away with the older input kind.
 */

const REPORT_TYPE = 'flight.report';
const REPORT_VERSION = 1;
const CONTENT_VERSION = 'ledger.legacy-flight-report.1';
/** The source a person's correction of an older report is recorded under. */
export const LEGACY_CORRECTION_SOURCE = 'operator-correction';
const activities = new Set(['planned', 'active', 'landed', 'cancelled']);
const utcPattern = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/;
const BRIDGE_LIMITATION =
  'Recorded from an older flight observation report; its fields that flight.report@1 does not hold stay in the original.';

function utcInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !utcPattern.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return value;
}

/** The report's values in the vocabulary: one activity and one landing time, each only when valid. */
export function legacyReportValues(payload: Record<string, unknown>): Record<string, string> {
  const activity = [payload.activity, payload.state, payload.phase].find((value) => value !== undefined);
  const landingAt = utcInstant(payload.landingTime) ?? utcInstant(payload.landedAt);
  return {
    ...(typeof activity === 'string' && activities.has(activity) ? { activity } : {}),
    ...(landingAt ? { landingAt } : {}),
  };
}

function utcOccurredAt(value: string): string {
  return utcPattern.test(value) ? value : new Date(Date.parse(value)).toISOString();
}

interface ReportSubject {
  subject: { kind: 'flight'; id: string; scope: 'ledger' | 'source' };
  ledgerId: string | null;
  resolution: 'ledger' | 'alias' | 'unresolved' | 'ambiguous';
}

/** The report's subject as the vocabulary maps it, with what the older intake resolved it to. */
function reportSubject(input: FlightInput, link: { id?: string; status: string }): ReportSubject | undefined {
  if (input.subject.flightId)
    return {
      subject: { kind: 'flight', id: input.subject.flightId, scope: 'ledger' },
      ledgerId: link.id ?? null,
      resolution: 'ledger',
    };
  const id = input.subject.originationKey ?? input.subject.externalFlightId;
  if (!id) return undefined;
  return {
    subject: { kind: 'flight', id, scope: 'source' },
    ledgerId: link.id ?? null,
    resolution: link.id ? 'alias' : link.status === 'candidate' ? 'ambiguous' : 'unresolved',
  };
}

/**
 * Records an accepted older flight report as a flight.report@1 observation on the same receipt and event. A report
 * with no valid activity or landing time, or about an order only, has no observation.
 */
export async function bridgeLegacyFlightReport(
  client: PoolClient,
  principal: AuthContext,
  input: FlightInput,
  accepted: { event: JournalEvent; receiptId: string; link: { id?: string; status: string } },
  store: ObjectStore = createObjectStore(),
): Promise<void> {
  const values = legacyReportValues(input.payload);
  const subject = reportSubject(input, accepted.link);
  if (!Object.keys(values).length || !subject || (subject.resolution === 'ledger' && !subject.ledgerId)) return;
  const artifactId = input.artifactId ?? (await retainPayload(client, principal, input, store));
  const { observation } = validateObservation(observationRegistry(), {
    type: REPORT_TYPE,
    version: REPORT_VERSION,
    subject: subject.subject,
    occurredAt: utcOccurredAt(input.occurredAt),
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    fidelity: input.fidelity ?? 'documented_schema_conformant',
    limitations: input.fidelity
      ? [BRIDGE_LIMITATION]
      : [BRIDGE_LIMITATION, 'The older report stated no fidelity; documented_schema_conformant is assumed.'],
    originalArtifactId: artifactId,
    values,
  });
  const event = accepted.event;
  await client.query(
    `INSERT INTO observations(id,tenant_id,receipt_id,event_id,artifact_id,principal_id,source_id,source_session_id,
       observation_type,observation_version,subject_kind,subject_id,subject_scope,subject_ledger_id,subject_resolution,
       occurred_at,received_at,fidelity,content_digest,observation)
     VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,$9,'flight',$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      event.id,
      principal.tenantId,
      accepted.receiptId,
      artifactId,
      principal.id,
      input.sourceId,
      input.sourceSessionId ?? null,
      REPORT_TYPE,
      REPORT_VERSION,
      subject.subject.id,
      subject.subject.scope,
      subject.ledgerId,
      subject.resolution,
      observation.occurredAt,
      event.received_at,
      observation.fidelity,
      canonicalDigest({ version: CONTENT_VERSION, sourceId: input.sourceId, observation }),
      observation,
    ],
  );
}

/** The current flight report the corrected evidence stands for: the older report's, or an earlier correction's. */
async function correctedReport(
  client: PoolClient,
  tenantId: string,
  correctionOf: string,
): Promise<string | undefined> {
  const row = (
    await client.query<{ id: string }>(
      `SELECT o.id FROM observations o JOIN journal_events e ON e.tenant_id=o.tenant_id AND e.id=o.event_id
       WHERE o.tenant_id=$1 AND o.observation_type=$2 AND (o.event_id=$3 OR e.causation_id=$3)
       ORDER BY o.received_at DESC,o.id DESC LIMIT 1`,
      [tenantId, REPORT_TYPE, correctionOf],
    )
  ).rows[0];
  return row?.id;
}

/**
 * The current record that stands for a report: the report itself, the replacement that replaced it, or the report a
 * correction recorded when it withdrew it, followed to the end. The older path appended a second correction to an
 * already corrected report rather than refusing it, so the bridge records it against that current record too.
 */
async function currentSuccessor(
  client: PoolClient,
  tenantId: string,
  observationId: string,
): Promise<string | undefined> {
  let id: string | undefined = observationId;
  for (let step = 0; id && step < 100; step++) {
    const standing = await observationStanding(client, tenantId, id);
    if (!standing) return undefined;
    if (standing.current) return id;
    if (standing.replacedBy) {
      id = standing.replacedBy;
      continue;
    }
    id = (
      await client.query<{ id: string }>(
        `SELECT o.id FROM journal_events w JOIN journal_events e ON e.tenant_id=w.tenant_id AND e.causation_id=w.causation_id
         JOIN observations o ON o.tenant_id=e.tenant_id AND o.event_id=e.id
         WHERE w.tenant_id=$1 AND w.id=$2 AND o.observation_type=$3 ORDER BY o.id LIMIT 1`,
        [tenantId, standing.withdrawalEventId, REPORT_TYPE],
      )
    ).rows[0]?.id;
  }
  return undefined;
}

/**
 * Takes the correction lock of the observation a bridged correction or link will correct, followed until it holds the
 * current one. A flight command calls it before it locks its flight, since the lock belongs to group 2 of the lock
 * order and observation corrections take it before any row.
 */
async function lockBridgedTarget(
  client: PoolClient,
  tenantId: string,
  target: () => Promise<string | undefined>,
): Promise<void> {
  const locked = new Set<string>();
  for (let id = await target(); id && !locked.has(id); id = await target()) {
    await lockObservationCorrection(client, tenantId, id);
    locked.add(id);
  }
}

/** Before an `evidence.correct` locks its flight: the lock of the report it corrects, at its current record. */
export async function lockLegacyFlightReportCorrection(
  client: PoolClient,
  tenantId: string,
  correctionOf: string,
): Promise<void> {
  await lockBridgedTarget(client, tenantId, async () => {
    const corrected = await correctedReport(client, tenantId, correctionOf);
    return corrected && currentSuccessor(client, tenantId, corrected);
  });
}

/** Before an `identity.link` locks its flight: the lock of the linked receipt's report, when it is current. */
export async function lockLegacyFlightReportLink(
  client: PoolClient,
  tenantId: string,
  receiptId: string,
): Promise<void> {
  await lockBridgedTarget(client, tenantId, () => linkedReport(client, tenantId, receiptId));
}

async function linkedReport(client: PoolClient, tenantId: string, receiptId: string): Promise<string | undefined> {
  const row = (
    await client.query<{ id: string }>(
      'SELECT id FROM observations WHERE tenant_id=$1 AND receipt_id=$2 AND observation_type=$3',
      [tenantId, receiptId, REPORT_TYPE],
    )
  ).rows[0];
  return row && (await observationStanding(client, tenantId, row.id))?.current ? row.id : undefined;
}

/**
 * Records a person's correction of an older flight report on the observation records: a replacement when the
 * corrected report came from the correction source itself, otherwise a withdrawal of the report plus a new report
 * from the correction source. A report already corrected is corrected at its current record; when nothing current
 * stands for it, the new report is recorded alone.
 */
export async function bridgeLegacyFlightReportCorrection(
  client: PoolClient,
  principal: AuthContext,
  correction: {
    flightId: string;
    correctionOf: string;
    occurredAt: string;
    note: string;
    payload: Record<string, unknown>;
  },
  event: JournalEvent,
  store: ObjectStore = createObjectStore(),
): Promise<void> {
  const corrected = await correctedReport(client, principal.tenantId, correction.correctionOf);
  if (!corrected) return;
  const targetId = await currentSuccessor(client, principal.tenantId, corrected);
  const target = targetId ? await observationStanding(client, principal.tenantId, targetId) : undefined;
  const options = { bridgedFrom: event.id };
  const sameSource = target?.sourceId === LEGACY_CORRECTION_SOURCE;
  const values = legacyReportValues(correction.payload);
  if (targetId && (!sameSource || !Object.keys(values).length))
    await withdrawObservation(
      client,
      principal,
      { kind: 'observation.withdraw', observationId: targetId, reason: correction.note },
      options,
    );
  if (!Object.keys(values).length) return;
  const occurredAt = utcOccurredAt(correction.occurredAt);
  const artifactId = await retainPayload(client, principal, correction, store);
  const input: ObservationInput = {
    kind: 'observation',
    sourceId: LEGACY_CORRECTION_SOURCE,
    occurredAt,
    payload: {
      type: REPORT_TYPE,
      version: REPORT_VERSION,
      subject: { kind: 'flight', id: correction.flightId, scope: 'ledger' },
      occurredAt,
      fidelity: 'documented_schema_conformant',
      limitations: [BRIDGE_LIMITATION, `Corrected by a person: ${correction.note}`.slice(0, 1000)],
      originalArtifactId: artifactId,
      values,
    },
    ...(sameSource && targetId ? { replaces: targetId } : {}),
  };
  // The correction command's capability authorized this record.
  const authority = {
    version: 'ledger.input-authority.1',
    principalId: principal.id,
    tenantId: principal.tenantId,
    principalRevision: principal.revision,
    inputKind: 'observation' as const,
    sourceId: LEGACY_CORRECTION_SOURCE,
    requiredCapabilities: ['correction:write'],
  };
  await acceptObservationInput(client, principal, input, authority, options);
}

/** Records an identity link that moves an older flight report to a flight as a subject resolution of its report. */
export async function bridgeLegacyFlightReportLink(
  client: PoolClient,
  principal: AuthContext,
  link: { receiptId: string; flightId: string },
  event: JournalEvent,
): Promise<void> {
  const row = (
    await client.query<{ id: string }>(
      'SELECT id FROM observations WHERE tenant_id=$1 AND receipt_id=$2 AND observation_type=$3',
      [principal.tenantId, link.receiptId, REPORT_TYPE],
    )
  ).rows[0];
  const standing = row ? await observationStanding(client, principal.tenantId, row.id) : undefined;
  if (!row || !standing?.current || standing.ledgerId === link.flightId) return;
  await resolveObservationSubject(
    client,
    principal,
    {
      kind: 'observation.resolve-subject',
      observationId: row.id,
      ledgerSubjectId: link.flightId,
      reason: 'The older flight report was linked to this flight.',
    },
    { bridgedFrom: event.id },
  );
}
