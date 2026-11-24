import type {
  DecisionEvidenceBundle,
  EvidenceEnvelope,
  FlightEvidenceBundle,
  MissionReleaseCommand,
  MissionReleaseRecord,
  SubjectEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import {
  missionReleaseCommand,
  missionReleaseFindingEvaluation,
  missionReleaseRecord,
} from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { appendJournalHistory } from './journal-history-fixture.js';

type InventoryBundle = DecisionEvidenceBundle | FlightEvidenceBundle | SubjectEvidenceBundle;

const byKey = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** The fixture release as the bundle's tenant would have recorded it: its organization and finding identities. */
function rebased(
  tenantId: string,
  record: MissionReleaseRecord,
  command: MissionReleaseCommand,
): [MissionReleaseRecord, MissionReleaseCommand] {
  const organizationId = `organization:${tenantId}`;
  const organization = { scope: 'ledger' as const, kind: 'organization' as const, id: organizationId };
  const subjects = record.basis.findings.subjects
    .map((entry) =>
      entry.reason === 'organization'
        ? { ...entry, subject: organization, subjectKey: `ledger/organization/${encodeURIComponent(organizationId)}` }
        : entry,
    )
    .sort((left, right) => byKey(left.subjectKey, right.subjectKey));
  const findings = record.basis.findings.findings.map((finding) => ({
    ...finding,
    id: `finding:${canonicalDigest({ tenant: tenantId, subjectKey: finding.subjectKey, packId: finding.rule.packId, leafId: finding.rule.id, scope: 'subject' })}`,
  }));
  const body = { version: record.basis.findings.version, subjects, findings };
  const section = { ...body, digest: canonicalDigest(body) };
  return [
    { ...record, organizationId, basis: { ...record.basis, findings: section } },
    { ...command, expectedFindingsDigest: section.digest },
  ];
}

function releaseEffect(
  tenantId: string,
  retained: MissionReleaseRecord,
  shown: MissionReleaseCommand,
): EvidenceEnvelope {
  const [record, command] = rebased(tenantId, retained, shown);
  const { id, recordedAt, acceptedRevision: _acceptedRevision, ...acceptance } = record;
  return {
    eventId: id,
    tenantId,
    streamId: 'retained-mission-release-stream',
    sequence: '1',
    type: 'mission.release',
    schemaVersion: 1,
    principalId: record.actor.id,
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: recordedAt,
    causationId: null,
    artifactId: null,
    payload: { ...command, acceptance, declaredSubjects: [record.flightId] },
  };
}

/** A release that lists no open findings, so the inventory needs no evaluation for it. */
export function missionReleaseHistoryEffect(tenantId: string): EvidenceEnvelope {
  const { findings } = missionReleaseRecord.basis;
  const record = {
    ...missionReleaseRecord,
    basis: { ...missionReleaseRecord.basis, findings: { ...findings, findings: [] } },
  };
  return releaseEffect(tenantId, record, missionReleaseCommand);
}

/** A release that lists one finding. */
export function missionReleaseV2HistoryEffect(tenantId: string): EvidenceEnvelope {
  return releaseEffect(tenantId, missionReleaseRecord, missionReleaseCommand);
}

/** The evaluation the release's listed finding is pinned to, as the evaluator journals it. */
export function missionReleaseFindingEvaluationEffect(tenantId: string): EvidenceEnvelope {
  const { recordedAt, ...evaluation } = missionReleaseFindingEvaluation;
  return {
    eventId: evaluation.id,
    tenantId,
    streamId: 'retained-rule-evaluation-stream',
    sequence: '1',
    type: 'rule-evaluation.recorded',
    schemaVersion: 1,
    principalId: 'resolved-evaluation-worker',
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: recordedAt,
    causationId: null,
    artifactId: null,
    payload: { evaluation },
  };
}

export function appendMissionReleaseHistory<T extends InventoryBundle>(bundle: T): T {
  return appendJournalHistory(
    bundle,
    [missionReleaseHistoryEffect(bundle.manifest.tenantId)],
    `flight:${missionReleaseRecord.flightId}`,
  );
}

/** Appends the pinned evaluation's stream and a release listing its finding; `release` replaces the release event. */
export function appendMissionReleaseV2History<T extends InventoryBundle>(
  bundle: T,
  release: (effect: EvidenceEnvelope) => EvidenceEnvelope = (effect) => effect,
  evaluation: (effect: EvidenceEnvelope) => EvidenceEnvelope = (effect) => effect,
): T {
  const tenantId = bundle.manifest.tenantId;
  const evaluated = appendJournalHistory(
    bundle,
    [evaluation(missionReleaseFindingEvaluationEffect(tenantId))],
    `rule-evaluation:${missionReleaseFindingEvaluation.subjectKey}`,
  );
  return appendJournalHistory(
    evaluated,
    [release(missionReleaseV2HistoryEffect(tenantId))],
    `flight:${missionReleaseRecord.flightId}`,
  );
}
