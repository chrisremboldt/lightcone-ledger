import type { TimelineResponse } from '@ledger/contracts';
import type { OracleIssue, OracleReader } from './attempt-oracle.js';
import type { CommandLinkOracleReport, CommandLinkOracleResult } from './command-link-oracle.js';
import { OracleReadError } from './oracle-api.js';

// The lost-link review runs on the generic evaluator: its finding is recognized by its check kind, never by its rule,
// and it cites the accepted reports as records. The oracle groups the confirmed reports as the check does.
const EPISODE_CHECK = 'episode.open';
const codes = [
  'episode_unavailable',
  'episode_open',
  'episode_conflicting',
  'transition_unreadable',
  'episodes_closed',
];
const states = ['unresolved', 'restored', 'conflicting', 'insufficient'];
type JsonObject = Record<string, unknown>;

class UnsupportedFinding extends Error {}
function unsupported(reason: string): never {
  throw new UnsupportedFinding(reason);
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return unsupported('Command-link finding has an unsupported object shape');
  return value as JsonObject;
}
function keys(value: JsonObject, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    unsupported('Command-link explanation has missing or unmodelled fields');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    return unsupported('Command-link finding identity is missing or unsupported');
  return value;
}
function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return unsupported('Command-link finding requires an explicit UTC time');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    return unsupported('Command-link finding has an invalid UTC time');
  return new Date(time).toISOString();
}
function choice(value: unknown, supported: string[]): string {
  if (typeof value !== 'string' || !supported.includes(value))
    return unsupported('Command-link finding uses an unsupported state or explanation code');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 64)
    return unsupported('Command-link explanation exceeds the 64-report comparison boundary');
  return value;
}
function ordered(values: string[]): string {
  return JSON.stringify([...values].sort());
}
function evidenceKey(value: unknown): string {
  const evidence = object(value);
  return JSON.stringify([
    id(evidence.eventId),
    id(evidence.receiptId),
    id(evidence.sourceId),
    utc(evidence.occurredAt),
  ]);
}
function scope(value: { sourceId: string; sourceSessionId: string; incidentId: string; aircraftId: string }): string[] {
  return [id(value.sourceId), id(value.sourceSessionId), id(value.incidentId), id(value.aircraftId)];
}
function expectedVerdict(reports: CommandLinkOracleReport[], evaluatedAt: string) {
  if (!reports.length || reports.length > 64 || !reports.some((report) => report.status === 'lost'))
    return unsupported('A command-link finding comparison requires a confirmed loss report');
  const scopes = new Map<string, CommandLinkOracleReport[]>();
  for (const report of reports) {
    choice(report.status, ['lost', 'restored']);
    const key = JSON.stringify(scope(report));
    scopes.set(key, [...(scopes.get(key) ?? []), report]);
  }
  let future = false;
  const groups = [...scopes.values()].map((scoped) => {
    const losses = scoped.filter((report) => report.status === 'lost');
    const restorations = scoped.filter((report) => report.status === 'restored');
    if (!losses.length)
      return unsupported('Restoration-only incident scopes are outside this confirmed-loss comparison');
    const futureReport = scoped.some((report) => Date.parse(utc(report.occurredAt)) > Date.parse(evaluatedAt));
    future ||= futureReport;
    let state = 'insufficient';
    if (!futureReport) {
      const lastLoss = Math.max(...losses.map((report) => Date.parse(utc(report.occurredAt))));
      const lastRestoration = restorations.length
        ? Math.max(...restorations.map((report) => Date.parse(utc(report.occurredAt))))
        : undefined;
      state =
        lastRestoration === lastLoss
          ? 'conflicting'
          : lastRestoration !== undefined && lastRestoration > lastLoss
            ? 'restored'
            : 'unresolved';
    }
    const first = scoped[0]!;
    return {
      sourceId: first.sourceId,
      sourceSessionId: first.sourceSessionId,
      incidentId: first.incidentId,
      aircraftId: first.aircraftId,
      state,
      lossEventIds: [...new Set(losses.map((report) => id(report.eventId)))],
      restorationEventIds: [...new Set(restorations.map((report) => id(report.eventId)))],
    };
  });
  if (future) return { groups, code: 'transition_unreadable', evidenceState: 'insufficient', outcome: 'attention' };
  if (groups.some((group) => group.state === 'conflicting'))
    return { groups, code: 'episode_conflicting', evidenceState: 'conflicting', outcome: 'attention' };
  if (groups.some((group) => group.state === 'unresolved'))
    return { groups, code: 'episode_open', evidenceState: 'insufficient', outcome: 'attention' };
  return { groups, code: 'episodes_closed', evidenceState: 'supported', outcome: 'pass' };
}

export async function compareCommandLinkFinding(
  timeline: TimelineResponse,
  reports: CommandLinkOracleReport[],
  add: (issue: OracleIssue) => void,
  _api: OracleReader,
  _tenantId: string,
): Promise<CommandLinkOracleResult['finding']> {
  try {
    if (!Array.isArray(timeline.findings)) return unsupported('Public flight does not include recorded findings');
    const episodeReview = (finding: unknown) => {
      const explanation = object(object(object(finding).latestEvaluation).explanation);
      return explanation.kind === 'rule' && object(explanation.ruleEvaluation).check
        ? object(object(explanation.ruleEvaluation).check).kind === EPISODE_CHECK
        : false;
    };
    const matching = timeline.findings.filter(episodeReview);
    if (matching.length !== 1) return unsupported('One recorded command-link finding is required for comparison');
    const finding = object(matching[0]);
    const flightId = id(timeline.flight.id);
    const evaluation = object(finding.latestEvaluation);
    const clock = object(evaluation.clock);
    keys(clock, ['mode', 'evaluatedAt']);
    if (clock.mode !== 'wall') return unsupported('Command-link finding requires its recorded wall clock');
    const evaluatedAt = utc(clock.evaluatedAt);
    const explanation = object(evaluation.explanation);
    if (explanation.kind !== 'rule' || typeof explanation.summary !== 'string')
      return unsupported('Command-link finding explanation is unsupported');
    const code = choice(explanation.code, codes);
    const evidenceState = choice(evaluation.evidenceState, [
      'supported',
      'insufficient',
      'conflicting',
      'not_applicable',
    ]);
    const outcome = choice(evaluation.outcome, ['pass', 'attention', 'pending', 'not_applicable']);
    const applicability = choice(evaluation.applicability, ['applicable', 'not_applicable']);
    const treatmentStatus = choice(finding.status, ['open', 'acknowledged', 'responding', 'resolved']);
    let treatmentOwner: { id: string; name: string } | null = null;
    if (finding.owner !== null) {
      const owner = object(finding.owner);
      keys(owner, ['id', 'name']);
      if (typeof owner.name !== 'string') return unsupported('Command-link finding owner name is unsupported');
      treatmentOwner = { id: id(owner.id), name: owner.name };
    }
    const expected = expectedVerdict(reports, evaluatedAt);
    const expectedEvidence = reports.map(({ actorId: _actorId, ...report }) => evidenceKey(report));
    const actualEvidence = list(explanation.evidence).map(evidenceKey);
    const details = object(explanation.details);
    const count = (state: string) => expected.groups.filter((group) => group.state === state).length;
    if (
      id(finding.flightId) !== flightId ||
      id(evaluation.flightId) !== flightId ||
      applicability !== 'applicable' ||
      utc(explanation.evaluatedAt) !== evaluatedAt ||
      code !== expected.code ||
      evidenceState !== expected.evidenceState ||
      outcome !== expected.outcome ||
      ordered(actualEvidence) !== ordered(expectedEvidence) ||
      (code !== 'transition_unreadable' &&
        (details.openEpisodeCount !== count('unresolved') ||
          details.conflictingEpisodeCount !== count('conflicting') ||
          details.closedEpisodeCount !== count('restored')))
    )
      add({
        status: 'mismatch',
        code: 'command_link_finding_disagrees',
        reason: 'Recorded command-link outcome, clock or exact scoped evidence differs from the confirmed reports',
      });
    return {
      findingId: id(finding.id),
      evaluationId: id(evaluation.id),
      evidenceState,
      outcome,
      treatmentStatus,
      treatmentOwner,
    };
  } catch (error) {
    if (error instanceof OracleReadError) {
      add({ status: error.status, code: error.code, reason: error.message });
      return undefined;
    }
    add({
      status: 'unverifiable',
      code: 'unsupported_finding',
      reason: error instanceof UnsupportedFinding ? error.message : 'Command-link finding is malformed or unsupported',
    });
    return undefined;
  }
}
