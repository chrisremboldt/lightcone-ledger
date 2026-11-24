import {
  subjectReferenceKey,
  type AssuranceBody,
  type EvaluationRecord,
  type HazardFindingOrigin,
  type HazardOrigin,
  type HazardOriginInput,
  type HazardRuleIdentity,
  type InputCut,
  type RelatedSubject,
  type RuleEvaluationRecord,
  type SmsAssessmentOutcome,
  type SmsEvidenceComparison,
  type SmsEvidencePin,
  type SmsFindingPromotionResponse,
  type SmsHazardEvidence,
  type SmsLink,
  type SmsNewerRecord,
  type SmsRecordDraft,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import { DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { readSubjectEvidence } from './cuts.js';
import { subjectFindingView } from './subject-findings.js';
import { readSmsRecord, requireCapability, smsDependencyBasis, smsStream } from './sms-envelope.js';
import { RECORDS_ON_FILE_SOURCE } from './records-on-file.js';

// A finding is either a flight finding (flight evaluations) or a finding the generic evaluator opened for a subject
// reference (rule evaluations). Both are read through one view; which rule produced it is data, never a branch.
export type FindingKind = HazardFindingOrigin['findingKind'];

export interface EvaluationView {
  id: string;
  digest: string;
  recordedAt: string;
  acceptedInputCut: InputCut;
  outcome: string;
  evidenceState: string;
  summary: string;
  rule: HazardRuleIdentity;
}

export interface FindingView {
  findingId: string;
  findingKind: FindingKind;
  subject: SubjectReference;
  subjectKey: string;
  ruleId: string;
  status: SmsFindingPromotionResponse['findingStatus'];
  latest: EvaluationView;
  /** The related subject of a finding from a rule that fans out. */
  related?: RelatedSubject;
}

interface FindingRow {
  id: string;
  leaf_id: string;
  flight_id: string | null;
  subject_key: string | null;
  subject_scope: SubjectReference['scope'] | null;
  subject_kind: SubjectReference['kind'] | null;
  subject_id: string | null;
  subject_source_id: string | null;
  status: FindingView['status'];
  flight_record: EvaluationRecord | null;
  rule_record: RuleEvaluationRecord | null;
}

export function flightEvaluationView(record: EvaluationRecord): EvaluationView {
  return {
    id: record.id,
    digest: canonicalDigest(record),
    recordedAt: record.recordedAt,
    acceptedInputCut: record.acceptedInputCut,
    outcome: record.outcome,
    evidenceState: record.evidenceState,
    summary: record.explanation.summary,
    rule: {
      packId: null,
      packVersion: null,
      ruleId: record.leafId,
      ruleVersion: record.leafVersion,
      ruleDigest: null,
      bindingId: record.bindingId,
      bindingVersion: record.bindingVersion,
      title: record.title,
    },
  };
}

export function ruleEvaluationView(record: RuleEvaluationRecord): EvaluationView {
  return {
    id: record.id,
    digest: canonicalDigest(record),
    recordedAt: record.recordedAt,
    acceptedInputCut: record.inputCut,
    outcome: record.outcome,
    evidenceState: record.evidenceState,
    summary: record.summary,
    rule: {
      packId: record.pack.id,
      packVersion: record.pack.version,
      ruleId: record.rule.id,
      ruleVersion: record.rule.version,
      ruleDigest: record.rule.digest,
      bindingId: null,
      bindingVersion: null,
      title: record.rule.title,
    },
  };
}

/** The origin a hazard records when it is opened from this finding at its latest evaluation. */
export function findingOrigin(finding: FindingView): HazardFindingOrigin {
  return {
    kind: 'finding',
    findingId: finding.findingId,
    findingKind: finding.findingKind,
    subject: finding.subject,
    subjectKey: finding.subjectKey,
    evaluationId: finding.latest.id,
    evaluationDigest: finding.latest.digest,
    evaluationRecordedAt: finding.latest.recordedAt,
    rule: finding.latest.rule,
    ...(finding.related ? { related: finding.related } : {}),
  };
}

function findingView(row: FindingRow): FindingView {
  if (row.flight_record) {
    const subject: SubjectReference = { scope: 'ledger', kind: 'flight', id: row.flight_id! };
    return {
      findingId: row.id,
      findingKind: 'flight',
      subject,
      subjectKey: subjectReferenceKey(subject),
      ruleId: row.leaf_id,
      status: row.status,
      latest: flightEvaluationView(row.flight_record),
    };
  }
  const subject: SubjectReference =
    row.subject_scope === 'source'
      ? { scope: 'source', kind: row.subject_kind!, id: row.subject_id!, sourceId: row.subject_source_id! }
      : { scope: 'ledger', kind: row.subject_kind!, id: row.subject_id! };
  return {
    findingId: row.id,
    findingKind: 'subject',
    subject,
    subjectKey: row.subject_key!,
    ruleId: row.leaf_id,
    status: row.status,
    latest: ruleEvaluationView(row.rule_record!),
    ...(row.rule_record!.related
      ? {
          related: {
            name: row.rule_record!.related.name,
            subject: row.rule_record!.related.subject,
            subjectKey: row.rule_record!.related.subjectKey,
          },
        }
      : {}),
  };
}

export async function readFinding(
  client: PoolClient,
  tenantId: string,
  findingId: string,
  options: { lock?: boolean } = {},
): Promise<FindingView> {
  const row = (
    await client.query<FindingRow>(
      `SELECT f.id,f.leaf_id,f.flight_id,f.subject_key,f.subject_scope,f.subject_kind,f.subject_id,f.subject_source_id,
       v.status,fe.record AS flight_record,re.record AS rule_record
       FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
       LEFT JOIN flight_evaluations fe ON fe.tenant_id=v.tenant_id AND fe.id=v.latest_evaluation_id
       LEFT JOIN rule_evaluations re ON re.tenant_id=v.tenant_id AND re.id=v.latest_rule_evaluation_id
       WHERE f.tenant_id=$1 AND f.id=$2${options.lock ? ' FOR UPDATE OF v' : ''}`,
      [tenantId, findingId],
    )
  ).rows[0];
  if (!row || (!row.flight_record && !row.rule_record))
    throw new DomainError(404, 'finding_not_found', 'The finding was not found in your organization');
  return findingView(row);
}

async function readEvaluation(
  client: PoolClient,
  tenantId: string,
  kind: FindingKind,
  id: string,
): Promise<EvaluationView> {
  const row = (
    await client.query<{ record: unknown }>(
      `SELECT record FROM ${kind === 'flight' ? 'flight_evaluations' : 'rule_evaluations'} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new DomainError(409, 'evaluation_unavailable', 'The pinned evaluation is unavailable');
  return kind === 'flight'
    ? flightEvaluationView(row.record as EvaluationRecord)
    : ruleEvaluationView(row.record as RuleEvaluationRecord);
}

async function streamHeads(
  client: PoolClient,
  tenantId: string,
  streamIds: string[],
): Promise<{ id: string; sequence: number; projected: number }[]> {
  const rows = await client.query<{ id: string; sequence: string; projected: string }>(
    `SELECT s.id,s.sequence,COALESCE(p.sequence,0) AS projected FROM streams s
     LEFT JOIN projection_offsets p ON p.tenant_id=s.tenant_id AND p.stream_id=s.id
     WHERE s.tenant_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id COLLATE "C"`,
    [tenantId, streamIds],
  );
  return rows.rows.map((row) => ({ id: row.id, sequence: Number(row.sequence), projected: Number(row.projected) }));
}

/** The streams that hold evidence: those holding only Ledger's records of what is on file are left out. */
async function evidenceStreams(client: PoolClient, tenantId: string, streamIds: string[]): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `SELECT s.id FROM streams s WHERE s.tenant_id=$1 AND s.id=ANY($2::text[]) AND EXISTS(
       SELECT 1 FROM journal_events e WHERE e.tenant_id=s.tenant_id AND e.stream_id=s.id
       AND e.source_id IS DISTINCT FROM $3)`,
    [tenantId, streamIds, RECORDS_ON_FILE_SOURCE],
  );
  return rows.rows.map((row) => row.id);
}

/**
 * The basis a person promoting a finding saw. For a Ledger subject it is the subject's dependency basis, as decisions
 * on SMS records use. A subject a source names by its own id has no Ledger subject, so its basis is the current head
 * of every stream its latest evaluation read.
 */
export async function findingBasis(
  client: PoolClient,
  principal: AuthContext,
  finding: FindingView,
  options: { lock?: boolean } = {},
): Promise<string> {
  const basis = await subjectBasis(client, principal, finding, finding.subject, finding.subjectKey, options);
  if (!finding.related) return basis;
  // A finding about a related subject also rests on that subject's evidence, so newer evidence about it conflicts.
  const related = await subjectBasis(
    client,
    principal,
    finding,
    finding.related.subject,
    finding.related.subjectKey,
    options,
  );
  return canonicalDigest({
    version: 'sms-finding-basis.related.1',
    basis,
    relatedKey: finding.related.subjectKey,
    related,
  });
}

async function subjectBasis(
  client: PoolClient,
  principal: AuthContext,
  finding: FindingView,
  subject: SubjectReference,
  subjectKey: string,
  options: { lock?: boolean },
): Promise<string> {
  if (subject.scope === 'ledger')
    return smsDependencyBasis(
      (await readSubjectEvidence(client, subject.id, principal, { ...options, decision: true })).basisManifest,
    );
  const heads = await streamHeads(
    client,
    principal.tenantId,
    await evidenceStreams(client, principal.tenantId, Object.keys(finding.latest.acceptedInputCut.streams)),
  );
  return canonicalDigest({
    version: 'sms-finding-basis.1',
    subjectKey,
    principalId: principal.id,
    principalRevision: principal.revision,
    evaluationId: finding.latest.id,
    streams: heads.map(({ id, sequence }) => ({ id, sequence })),
  });
}

async function existingHazard(
  client: PoolClient,
  tenantId: string,
  findingId: string,
  evaluationId: string,
): Promise<{ recordId: string; title: string } | null> {
  const row = (
    await client.query<{ record_id: string; title: string }>(
      `SELECT o.record_id,r.title FROM sms_hazard_origins o JOIN sms_records r ON r.tenant_id=o.tenant_id AND r.id=o.record_id
       WHERE o.tenant_id=$1 AND o.finding_id=$2 AND COALESCE(o.flight_evaluation_id,o.rule_evaluation_id)=$3`,
      [tenantId, findingId, evaluationId],
    )
  ).rows[0];
  return row ? { recordId: row.record_id, title: row.title } : null;
}

function requireFindingReader(principal: AuthContext): void {
  requireCapability(principal, 'evidence:read', 'Promoting a finding needs permission to read evidence');
}

export async function getFindingPromotion(
  client: PoolClient,
  principal: AuthContext,
  findingId: string,
): Promise<SmsFindingPromotionResponse> {
  requireFindingReader(principal);
  const finding = await readFinding(client, principal.tenantId, findingId);
  const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return {
    origin: findingOrigin(finding),
    evaluation: {
      outcome: finding.latest.outcome,
      evidenceState: finding.latest.evidenceState,
      summary: finding.latest.summary,
    },
    findingStatus: finding.status,
    basis: { dependencyBasis: await findingBasis(client, principal, finding) },
    existingHazard: await existingHazard(client, principal.tenantId, finding.findingId, finding.latest.id),
    computedAt: clock.rows[0].now.toISOString(),
  };
}

type HazardSourceKind = Extract<SmsRecordDraft, { kind: 'hazard' }>['body']['source']['kind'];

const originSource: Partial<Record<HazardOrigin['kind'], HazardSourceKind>> = {
  finding: 'finding',
  report: 'report',
  assurance: 'assurance',
};

const originWords: Record<HazardOrigin['kind'], string> = {
  finding: 'finding',
  report: 'report',
  assurance: 'safety assurance record',
  manual: 'person',
};

function requireSource(origin: HazardOrigin['kind'], source: HazardSourceKind): void {
  const expected = originSource[origin];
  if (expected ? source !== expected : source === 'finding' || source === 'assurance')
    throw new DomainError(
      400,
      'hazard_source_mismatch',
      expected
        ? `A hazard opened from a ${originWords[origin]} records its source as ${expected}`
        : `Only a hazard opened from a ${originWords[source === 'finding' ? 'finding' : 'assurance']} records that source`,
      { expected: expected ?? null },
    );
}

export async function hazardOrigin(client: PoolClient, tenantId: string, recordId: string): Promise<HazardOrigin> {
  const row = (
    await client.query<{ origin: HazardOrigin }>(
      'SELECT origin FROM sms_hazard_origins WHERE tenant_id=$1 AND record_id=$2',
      [tenantId, recordId],
    )
  ).rows[0];
  return row?.origin ?? { kind: 'manual' };
}

/** A new version keeps the source its origin implies. */
export async function requireRevisedSource(
  client: PoolClient,
  tenantId: string,
  recordId: string,
  draft: SmsRecordDraft,
): Promise<void> {
  if (draft.kind !== 'hazard') return;
  requireSource((await hazardOrigin(client, tenantId, recordId)).kind, draft.body.source.kind);
}

export interface PreparedOrigin {
  origin: HazardOrigin;
  /** The draft's links with the derived-from link to the origin added. */
  links: SmsLink[];
  /** The Ledger subject the hazard's basis must cover, if the origin has one. */
  dependencySubjectId?: string;
}

function withDerivedLink(links: SmsLink[] | undefined, derived: SmsLink): SmsLink[] {
  const all = links ?? [];
  return all.some((link) => canonicalize(link) === canonicalize(derived)) ? all : [...all, derived];
}

/** Checks a hazard's origin against what its author was shown and returns what the opening records. */
export async function prepareHazardOrigin(
  client: PoolClient,
  principal: AuthContext,
  draft: Extract<SmsRecordDraft, { kind: 'hazard' }>,
  input: HazardOriginInput,
): Promise<PreparedOrigin> {
  requireSource(input.kind, draft.body.source.kind);
  if (input.kind === 'manual') return { origin: { kind: 'manual' }, links: draft.links ?? [] };
  if (input.kind === 'report') {
    requireCapability(
      principal,
      'sms:report:read',
      'Opening a hazard from a safety report needs permission to read it',
    );
    const report = await readSmsRecord(client, principal.tenantId, input.recordId);
    if (report.kind !== 'report')
      throw new DomainError(400, 'origin_not_report', 'The origin record is not a safety report');
    if (report.version_number !== input.versionNumber)
      throw new DomainError(409, 'stale_basis', 'The report has a newer version; review it before opening the hazard', {
        currentVersionNumber: report.version_number,
      });
    const digest = (
      await client.query<{ digest: string }>(
        `SELECT content_digest AS digest FROM sms_restricted_record_versions WHERE tenant_id=$1 AND record_id=$2 AND version_number=$3
         UNION ALL SELECT body_digest FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2 AND version_number=$3`,
        [principal.tenantId, report.id, report.version_number],
      )
    ).rows[0]!.digest;
    return {
      origin: { kind: 'report', recordId: report.id, versionNumber: report.version_number, contentDigest: digest },
      links: withDerivedLink(draft.links, { relation: 'derived_from', target: { kind: 'sms_record', id: report.id } }),
    };
  }
  if (input.kind === 'assurance') return assuranceOrigin(client, principal, draft, input);
  requireFindingReader(principal);
  const shown = await readFinding(client, principal.tenantId, input.findingId);
  // The module that owns the finding's subject locks its record first, then the subjects, then the finding: the order
  // the evaluator and that module's commands, such as a decision treating the finding, take them.
  if (shown.subject.scope === 'ledger')
    await subjectFindingView(shown.subject.kind)?.lockSubject?.(client, shown.subject.id);
  const basis = await findingBasis(client, principal, shown, { lock: true });
  const finding = await readFinding(client, principal.tenantId, input.findingId, { lock: true });
  if (basis !== input.expectedDependencyBasis)
    throw new DomainError(
      409,
      'stale_basis',
      'The finding’s evidence changed since you reviewed it; review the current finding before opening a hazard',
    );
  if (finding.latest.id !== input.evaluationId)
    throw new DomainError(409, 'stale_finding', 'The finding was evaluated again; review the current evaluation', {
      currentEvaluationId: finding.latest.id,
    });
  const existing = await existingHazard(client, principal.tenantId, finding.findingId, finding.latest.id);
  if (existing)
    throw new DomainError(409, 'hazard_already_opened', 'A hazard already records this exact finding evaluation', {
      existingRecordId: existing.recordId,
    });
  return {
    origin: findingOrigin(finding),
    links: withDerivedLink(draft.links, {
      relation: 'derived_from',
      target: { kind: 'finding', id: finding.findingId },
    }),
    ...(finding.subject.scope === 'ledger' ? { dependencySubjectId: finding.subject.id } : {}),
  };
}

/** A hazard from a finding or an action of the current version of a safety assurance record. */
async function assuranceOrigin(
  client: PoolClient,
  principal: AuthContext,
  draft: Extract<SmsRecordDraft, { kind: 'hazard' }>,
  input: Extract<HazardOriginInput, { kind: 'assurance' }>,
): Promise<PreparedOrigin> {
  const record = await readSmsRecord(client, principal.tenantId, input.recordId);
  if (record.kind !== 'assurance')
    throw new DomainError(400, 'origin_not_assurance', 'The origin record is not a safety assurance record');
  if (record.version_number !== input.versionNumber)
    throw new DomainError(
      409,
      'stale_basis',
      'The safety assurance record has a newer version; review it before opening the hazard',
      { currentVersionNumber: record.version_number },
    );
  const version = (
    await client.query<{ body: AssuranceBody; body_digest: string }>(
      'SELECT body,body_digest FROM sms_record_versions WHERE tenant_id=$1 AND record_id=$2 AND version_number=$3',
      [principal.tenantId, record.id, record.version_number],
    )
  ).rows[0]!;
  const items = input.item.kind === 'action' ? version.body.actions : version.body.findings;
  if (!items.some((item) => item.id === input.item.id))
    throw new DomainError(
      400,
      'assurance_item_not_found',
      `This version of the record has no ${input.item.kind} ${input.item.id}`,
    );
  return {
    origin: {
      kind: 'assurance',
      recordId: record.id,
      versionNumber: record.version_number,
      bodyDigest: version.body_digest,
      assuranceType: version.body.assuranceType,
      item: input.item,
    },
    links: withDerivedLink(draft.links, { relation: 'derived_from', target: { kind: 'sms_record', id: record.id } }),
  };
}

export async function recordHazardOrigin(
  client: PoolClient,
  principal: AuthContext,
  recordId: string,
  origin: HazardOrigin,
  event: JournalEvent,
): Promise<void> {
  const finding = origin.kind === 'finding' ? origin : undefined;
  const report = origin.kind === 'report' ? origin : undefined;
  const assurance = origin.kind === 'assurance' ? origin : undefined;
  await client.query(
    `INSERT INTO sms_hazard_origins(id,tenant_id,record_id,kind,finding_id,flight_id,subject_key,flight_evaluation_id,
     rule_evaluation_id,evaluation_digest,report_record_id,report_version_number,assurance_record_id,
     assurance_version_number,origin,actor_id,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      event.id,
      principal.tenantId,
      recordId,
      origin.kind,
      finding?.findingId ?? null,
      finding?.findingKind === 'flight' ? finding.subject.id : null,
      finding?.subjectKey ?? null,
      finding?.findingKind === 'flight' ? finding.evaluationId : null,
      finding?.findingKind === 'subject' ? finding.evaluationId : null,
      finding?.evaluationDigest ?? null,
      report?.recordId ?? null,
      report?.versionNumber ?? null,
      assurance?.recordId ?? null,
      assurance?.versionNumber ?? null,
      origin,
      principal.id,
      event.received_at,
    ],
  );
}

/** For a hazard opened from a finding, the evaluation its assessor reviewed; refused if it is no longer the latest. */
export async function assessmentEvidence(
  client: PoolClient,
  tenantId: string,
  recordId: string,
  requested: { evaluationId: string } | undefined,
): Promise<SmsEvidencePin | undefined> {
  const origin = await hazardOrigin(client, tenantId, recordId);
  if (origin.kind !== 'finding') {
    if (requested)
      throw new DomainError(400, 'evidence_not_applicable', 'Only a hazard opened from a finding pins its evidence');
    return undefined;
  }
  if (!requested)
    throw new DomainError(400, 'evidence_required', 'Name the finding evaluation you reviewed for this assessment');
  const finding = await readFinding(client, tenantId, origin.findingId);
  if (finding.latest.id !== requested.evaluationId)
    throw new DomainError(409, 'stale_finding', 'The finding was evaluated again; review the current evaluation', {
      currentEvaluationId: finding.latest.id,
    });
  return {
    findingId: finding.findingId,
    findingKind: finding.findingKind,
    evaluationId: finding.latest.id,
    evaluationDigest: finding.latest.digest,
    evaluationRecordedAt: finding.latest.recordedAt,
  };
}

/**
 * Records accepted after a pinned evaluation on any stream it read, oldest first. Recorded evaluations are derived
 * from those records rather than evidence themselves, so they are left out; a newer evaluation of the same finding is
 * reported on its own. So are the records Ledger keeps of what is on file, derived from its own safety decisions
 * (opening this very hazard among them).
 */
async function newerRecords(
  client: PoolClient,
  tenantId: string,
  pinned: EvaluationView,
): Promise<{ records: SmsNewerRecord[]; truncated: boolean }> {
  const streams = Object.entries(pinned.acceptedInputCut.streams);
  if (!streams.length) return { records: [], truncated: false };
  const rows = await client.query<{
    id: string;
    event_type: string;
    stream_id: string;
    stream_sequence: string;
    received_at: Date;
  }>(
    `SELECT e.id,e.event_type,e.stream_id,e.stream_sequence,e.received_at
     FROM unnest($2::text[],$3::bigint[]) AS cut(stream_id,sequence)
     JOIN journal_events e ON e.tenant_id=$1 AND e.stream_id=cut.stream_id AND e.stream_sequence>cut.sequence
     WHERE NOT EXISTS(SELECT 1 FROM rule_evaluations r WHERE r.tenant_id=e.tenant_id AND r.id=e.id)
      AND NOT EXISTS(SELECT 1 FROM flight_evaluations f WHERE f.tenant_id=e.tenant_id AND f.id=e.id)
      AND e.source_id IS DISTINCT FROM $4
     ORDER BY e.received_at,e.id LIMIT 51`,
    [tenantId, streams.map(([stream]) => stream), streams.map(([, sequence]) => sequence), RECORDS_ON_FILE_SOURCE],
  );
  return {
    records: rows.rows.slice(0, 50).map((row) => ({
      eventId: row.id,
      eventType: row.event_type,
      streamId: row.stream_id,
      sequence: Number(row.stream_sequence),
      recordedAt: row.received_at.toISOString(),
    })),
    truncated: rows.rows.length > 50,
  };
}

async function compareWithPin(
  client: PoolClient,
  tenantId: string,
  finding: FindingView,
  pinnedId: string,
): Promise<SmsEvidenceComparison> {
  const pinned = await readEvaluation(client, tenantId, finding.findingKind, pinnedId);
  const newer = await newerRecords(client, tenantId, pinned);
  const heads = await streamHeads(
    client,
    tenantId,
    await evidenceStreams(client, tenantId, Object.keys(pinned.acceptedInputCut.streams)),
  );
  const ref = (view: EvaluationView) => ({ id: view.id, digest: view.digest, recordedAt: view.recordedAt });
  return {
    pinned: ref(pinned),
    latestEvaluation: ref(finding.latest),
    newerEvaluation: finding.latest.id !== pinned.id,
    newerRecords: newer.records,
    newerRecordsTruncated: newer.truncated,
    sourceProjectionPending: heads.some((head) => head.projected < head.sequence),
  };
}

/** Newer evidence since a hazard opened from a finding was opened and since its latest assessment. */
export async function hazardEvidence(
  client: PoolClient,
  tenantId: string,
  recordId: string,
  origin: HazardOrigin,
  latestAssessment: SmsAssessmentOutcome | undefined,
): Promise<SmsHazardEvidence | undefined> {
  if (origin.kind !== 'finding') return undefined;
  const finding = await readFinding(client, tenantId, origin.findingId);
  const pending = await client.query<{ pending: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM work_items w JOIN streams s ON s.tenant_id=w.tenant_id AND s.id=w.stream_id
     WHERE w.tenant_id=$1 AND s.name=$2 AND w.state<>'completed') AS pending`,
    [tenantId, smsStream(recordId)],
  );
  return {
    sinceOpened: await compareWithPin(client, tenantId, finding, origin.evaluationId),
    sinceAssessed: latestAssessment?.evidence
      ? await compareWithPin(client, tenantId, finding, latestAssessment.evidence.evaluationId)
      : null,
    hazardProjectionPending: pending.rows[0]!.pending,
  };
}

/** Ledger subjects that flight and finding link targets stand for, so a record's basis covers them. */
export async function linkedSubjectIds(client: PoolClient, tenantId: string, links: SmsLink[]): Promise<string[]> {
  const flights = [...new Set(links.flatMap((link) => (link.target.kind === 'flight' ? [link.target.id] : [])))];
  const findings = [...new Set(links.flatMap((link) => (link.target.kind === 'finding' ? [link.target.id] : [])))];
  const subjects: string[] = [];
  if (flights.length) {
    const found = await client.query<{ id: string }>('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=ANY($2)', [
      tenantId,
      flights,
    ]);
    if (found.rowCount !== flights.length)
      throw new DomainError(400, 'link_target_unavailable', 'A linked flight was not found in your organization');
    subjects.push(...found.rows.map((row) => row.id));
  }
  if (findings.length) {
    const found = await client.query<{ id: string; subject: string | null }>(
      `SELECT id,COALESCE(flight_id,CASE WHEN subject_scope='ledger' THEN subject_id END) AS subject FROM findings
       WHERE tenant_id=$1 AND id=ANY($2)`,
      [tenantId, findings],
    );
    if (found.rowCount !== findings.length)
      throw new DomainError(400, 'link_target_unavailable', 'A linked finding was not found in your organization');
    subjects.push(...found.rows.flatMap((row) => (row.subject ? [row.subject] : [])));
  }
  return [...new Set(subjects)].sort();
}
