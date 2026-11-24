import {
  assuranceTypes,
  type DocumentBody,
  type ObservationInput,
  type SmsDecisionRecord,
  type SmsDocumentIssueOutcome,
  type SmsDocumentWithdrawalOutcome,
  type SmsMatrixAdoptionOutcome,
  type SmsStatusOutcome,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { createObjectStore, type AuthContext, type ObjectStore, type PoolClient } from '@ledger/persistence';
import { lockObservationCorrection, withdrawObservation } from './observation-corrections.js';
import { acceptObservationInput } from './observations.js';
import { retainPayload } from './retained-payload.js';
import { closedActions, dayStart, organizationDay, settledActions, signedVersions } from './sms-assurance.js';

/**
 * What the organization keeps on file, as neutral observations about the organization (docs/design/on-file-checks.md):
 * each issued document revision, adopted risk matrix version and hazard, with the interval it is in force, its title,
 * revision and purposes. Never its content. A change to a safety record restates the observations of its scope from
 * the record's decisions: a changed one is replaced, one that no longer applies is withdrawn, a new one is accepted.
 */

import { RECORDS_ON_FILE_SOURCE } from './records-on-file-source.js';

export { RECORDS_ON_FILE_SOURCE };
const TYPE = 'organization.record-in-force';
const VERSION = 1;
const LIMITATION = 'Recorded by Ledger from its own decisions on the record; it holds none of the record’s content.';

/**
 * The records one change restates: one document's issues, one hazard, one safety assurance record and its actions, or
 * every adopted risk matrix version.
 */
export type RecordsOnFileScope =
  { kind: 'document' | 'hazard' | 'assurance'; recordId: string } | { kind: 'risk_matrix' };

const changes: Record<string, readonly string[]> = {
  document: ['document.issue', 'document.withdraw', 'record.close', 'record.reopen'],
  risk_matrix: ['matrix.adopt'],
  hazard: ['sms.record.open', 'sms.record.revise', 'risk.assess', 'risk.accept', 'record.close', 'record.reopen'],
  assurance: ['assurance.sign', 'action.close'],
};

/** The scope a change to a safety record restates, or undefined when the change puts nothing in or out of force. */
export function recordsOnFileScope(
  recordKind: string,
  recordId: string,
  change: string,
): RecordsOnFileScope | undefined {
  if (!changes[recordKind]?.includes(change)) return undefined;
  return recordKind === 'risk_matrix'
    ? { kind: 'risk_matrix' }
    : { kind: recordKind as 'document' | 'hazard' | 'assurance', recordId };
}

interface Statement {
  key: string;
  interval: { start: string; end?: string };
  values: Record<string, unknown>;
}

interface HeldRow {
  id: string;
  observation: { interval: Statement['interval']; values: Record<string, unknown> };
}

const iso = (millis: number) => new Date(millis).toISOString();
const keyOf = (values: Record<string, unknown>) =>
  values.actionId === undefined
    ? String(values.decisionId ?? values.recordId)
    : `${String(values.recordId)}:${String(values.actionId)}`;

/** The current observations of the scope, by the decision (or hazard) each states. */
async function heldRecords(client: PoolClient, tenantId: string, scope: RecordsOnFileScope): Promise<HeldRow[]> {
  const rows = await client.query<HeldRow>(
    `SELECT o.id,o.observation FROM observations o
     WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=$3 AND o.observation#>>'{values,recordKind}'=$4
       AND ($5::text IS NULL OR o.observation#>>'{values,recordId}'=$5)
       AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
     ORDER BY o.id COLLATE "C"`,
    [tenantId, RECORDS_ON_FILE_SOURCE, TYPE, scope.kind, 'recordId' in scope ? scope.recordId : null],
  );
  return rows.rows;
}

/**
 * Takes, before any row lock, the scope's key and the correction lock of each observation the change may replace or
 * withdraw, in id order: group 2 of the lock order.
 */
export async function lockRecordsOnFile(
  client: PoolClient,
  tenantId: string,
  scope: RecordsOnFileScope | undefined,
): Promise<void> {
  if (!scope) return;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `records-on-file:${tenantId}:${'recordId' in scope ? scope.recordId : scope.kind}`,
  ]);
  for (const row of await heldRecords(client, tenantId, scope))
    await lockObservationCorrection(client, tenantId, row.id);
}

async function decisionsOf(client: PoolClient, tenantId: string, recordId: string): Promise<SmsDecisionRecord[]> {
  const rows = await client.query<{ record: SmsDecisionRecord }>(
    `SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND record->>'version'='sms.decision.1'
     ORDER BY accepted_revision`,
    [tenantId, recordId],
  );
  return rows.rows.map((row) => row.record);
}

async function versionsOf(client: PoolClient, tenantId: string, recordId: string) {
  const rows = await client.query<{ version_number: number; title: string; body: unknown }>(
    'SELECT version_number,title,body FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2',
    [tenantId, recordId],
  );
  return new Map(rows.rows.map((row) => [row.version_number, row]));
}

function interval(start: number, ends: (string | null | undefined)[]): Statement['interval'] | undefined {
  const times = ends.flatMap((end) => (end ? [Date.parse(end)] : []));
  const end = times.length ? Math.min(...times) : undefined;
  if (end !== undefined && end <= start) return undefined;
  return { start: iso(start), ...(end === undefined ? {} : { end: iso(end) }) };
}

/**
 * Each issue of a document not withdrawn, in force from its effective date until the earliest of its expiry, the next
 * issue's effective date and a retirement after it. An issue retired before it took effect has none.
 */
async function documentStatements(client: PoolClient, tenantId: string, recordId: string): Promise<Statement[]> {
  const decisions = await decisionsOf(client, tenantId, recordId);
  const versions = await versionsOf(client, tenantId, recordId);
  const withdrawn = new Set(
    decisions
      .filter((item) => item.kind === 'document.withdraw')
      .map((item) => (item.outcome as SmsDocumentWithdrawalOutcome).issueId),
  );
  const issues = decisions.filter((item) => item.kind === 'document.issue' && !withdrawn.has(item.id));
  return issues.flatMap((issue, index) => {
    const outcome = issue.outcome as SmsDocumentIssueOutcome;
    const next = issues[index + 1]?.outcome as SmsDocumentIssueOutcome | undefined;
    const retired = decisions.find(
      (item) => item.kind === 'record.close' && item.acceptedRevision > issue.acceptedRevision,
    );
    const span = interval(Date.parse(outcome.effectiveFrom), [
      outcome.effectiveUntil,
      next?.effectiveFrom,
      retired?.recordedAt,
    ]);
    const version = versions.get(outcome.document.versionNumber);
    if (!span || !version) return [];
    const body = version.body as DocumentBody;
    return [
      {
        key: issue.id,
        interval: span,
        values: {
          recordKind: 'document',
          recordId,
          decisionId: issue.id,
          title: version.title,
          revision: body.revisionLabel?.trim() || `Version ${version.version_number}`,
          documentType: body.documentType,
          purposes: [...(body.purposes ?? [])],
        },
      },
    ];
  });
}

/** Each adopted risk matrix version, in force from its adoption until the next adoption of any matrix. */
async function matrixStatements(client: PoolClient, tenantId: string): Promise<Statement[]> {
  const adoptions = (
    await client.query<{ record: SmsDecisionRecord }>(
      `SELECT record FROM decisions WHERE tenant_id=$1 AND kind='matrix.adopt' AND record->>'version'='sms.decision.1'
       ORDER BY recorded_at,id`,
      [tenantId],
    )
  ).rows.map((row) => row.record);
  const statements: Statement[] = [];
  for (const [index, adoption] of adoptions.entries()) {
    const { matrix } = adoption.outcome as SmsMatrixAdoptionOutcome;
    const version = (await versionsOf(client, tenantId, matrix.recordId)).get(matrix.versionNumber);
    const span = interval(Date.parse(adoption.recordedAt), [adoptions[index + 1]?.recordedAt]);
    if (!span || !version) continue;
    statements.push({
      key: adoption.id,
      interval: span,
      values: {
        recordKind: 'risk_matrix',
        recordId: matrix.recordId,
        decisionId: adoption.id,
        title: version.title,
        revision: `Version ${matrix.versionNumber}`,
        purposes: [],
      },
    });
  }
  return statements;
}

/** A hazard, on the register from its opening until it is closed, with whether its risk is assessed and accepted. */
async function hazardStatements(client: PoolClient, tenantId: string, recordId: string): Promise<Statement[]> {
  const record = (
    await client.query<{ status: string; opened_at: Date }>(
      'SELECT status,opened_at FROM sms_records WHERE tenant_id=$1 AND id=$2',
      [tenantId, recordId],
    )
  ).rows[0];
  if (!record) return [];
  const closing =
    record.status === 'closed'
      ? (await decisionsOf(client, tenantId, recordId)).filter((item) => item.kind === 'record.close').at(-1)
      : undefined;
  const status = closing ? (closing.outcome as SmsStatusOutcome).priorStatus : record.status;
  const span = interval(record.opened_at.getTime(), [closing?.recordedAt]);
  if (!span) return [];
  return [
    {
      key: recordId,
      interval: span,
      values: {
        recordKind: 'hazard',
        recordId,
        purposes: [],
        riskAssessed: status === 'awaiting_acceptance' || status === 'accepted',
        riskAccepted: status === 'accepted',
      },
    },
  ];
}

/**
 * A safety assurance record once a version is signed, on file from its first signature with no end, and each action
 * a signature set, open from that signature until it is closed. Only its type, class and dates.
 */
async function assuranceStatements(client: PoolClient, tenantId: string, recordId: string): Promise<Statement[]> {
  const signed = await signedVersions(client, tenantId, recordId);
  const latest = signed.at(-1);
  if (!latest) return [];
  const { timeZone } = await organizationDay(client, tenantId);
  const type = latest.body.assuranceType;
  const common = {
    recordKind: 'assurance',
    recordId,
    assuranceType: type,
    recordClass: assuranceTypes[type].recordClass,
  };
  const statements: Statement[] = [
    { key: recordId, interval: { start: signed[0]!.signedAt }, values: { ...common, item: 'record', purposes: [] } },
  ];
  for (const entry of settledActions(signed, await closedActions(client, tenantId, recordId))) {
    const span = interval(Date.parse(entry.setAt), [entry.closed?.recordedAt]);
    if (!span) continue;
    statements.push({
      key: `${recordId}:${entry.action.id}`,
      interval: span,
      values: {
        ...common,
        item: 'action',
        actionId: entry.action.id,
        dueAt: await dayStart(client, entry.action.dueOn, timeZone, 1),
        purposes: [],
      },
    });
  }
  return statements;
}

function statementsOf(client: PoolClient, tenantId: string, scope: RecordsOnFileScope): Promise<Statement[]> {
  if (scope.kind === 'risk_matrix') return matrixStatements(client, tenantId);
  if (scope.kind === 'assurance') return assuranceStatements(client, tenantId, scope.recordId);
  return scope.kind === 'document'
    ? documentStatements(client, tenantId, scope.recordId)
    : hazardStatements(client, tenantId, scope.recordId);
}

const content = (value: { interval: Statement['interval']; values: Record<string, unknown> }) =>
  canonicalDigest({ interval: value.interval, values: value.values });

async function record(
  client: PoolClient,
  principal: AuthContext,
  statement: Statement,
  cause: { eventId: string; at: string },
  store: ObjectStore,
  replaces: string | undefined,
): Promise<void> {
  const artifactId = await retainPayload(
    client,
    principal,
    {
      version: 'ledger.records-on-file.1',
      cause: cause.eventId,
      interval: statement.interval,
      values: statement.values,
    },
    store,
    'record-in-force.json',
  );
  const input: ObservationInput = {
    kind: 'observation',
    sourceId: RECORDS_ON_FILE_SOURCE,
    occurredAt: cause.at,
    payload: {
      type: TYPE,
      version: VERSION,
      subject: { kind: 'organization', id: `organization:${principal.tenantId}`, scope: 'ledger' },
      occurredAt: cause.at,
      interval: statement.interval,
      fidelity: 'validated_live',
      limitations: [LIMITATION],
      originalArtifactId: artifactId,
      values: statement.values,
    },
    ...(replaces ? { replaces } : {}),
  };
  // The decision's own capability authorized this record.
  const authority = {
    version: 'ledger.input-authority.1',
    principalId: principal.id,
    tenantId: principal.tenantId,
    principalRevision: principal.revision,
    inputKind: 'observation' as const,
    sourceId: RECORDS_ON_FILE_SOURCE,
    requiredCapabilities: [],
  };
  await acceptObservationInput(client, principal, input, authority, { bridgedFrom: cause.eventId });
}

/**
 * Restates the scope's observations from the records' decisions, after the change that caused it is recorded. The
 * caller took `lockRecordsOnFile` for the scope before any row lock.
 */
export async function refreshRecordsOnFile(
  client: PoolClient,
  principal: AuthContext,
  scope: RecordsOnFileScope | undefined,
  cause: { eventId: string; at: Date },
  store: ObjectStore = createObjectStore(),
): Promise<void> {
  if (!scope) return;
  const statements = await statementsOf(client, principal.tenantId, scope);
  const held = new Map(
    (await heldRecords(client, principal.tenantId, scope)).map((row) => [keyOf(row.observation.values), row]),
  );
  const at = { eventId: cause.eventId, at: cause.at.toISOString() };
  for (const statement of [...statements].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const existing = held.get(statement.key);
    held.delete(statement.key);
    if (existing && content(existing.observation) === content(statement)) continue;
    await record(client, principal, statement, at, store, existing?.id);
  }
  for (const row of held.values())
    await withdrawObservation(
      client,
      principal,
      {
        kind: 'observation.withdraw',
        observationId: row.id,
        reason: 'The decisions on this record no longer put it in force at any time.',
      },
      { bridgedFrom: cause.eventId },
    );
}
