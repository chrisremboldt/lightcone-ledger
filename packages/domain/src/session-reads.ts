import {
  subjectReferenceKey,
  type AcceptedObservation,
  type CheckedRuleLeaf,
  type InputCut,
  type RuleRead,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { JournalEvent, PoolClient } from '@ledger/persistence';
import { observationStreamsSql } from './observation-streams.js';

/**
 * Reads by capture session: a read `about: { sameSessionAs: <read> }` gathers the observations a source reported in
 * the capture sessions of an earlier read about the target, whatever subject they are about. A check can then tell
 * whether a session was first used for another subject. Nothing here names a type or a rule.
 */

/** Capture sessions one evaluation reads at most; more makes the read truncated, never read in part silently. */
export const SESSION_READ_LIMIT = 50;
// Subjects queued at most for one observation in a session; a session normally reports for one subject.
const SESSION_SUBJECT_LIMIT = 500;

export interface CaptureSession {
  sourceId: string;
  sourceSessionId: string;
}

/** The earlier read a read takes its capture sessions from, or undefined. */
export function sessionReadOf(read: RuleRead): string | undefined {
  return typeof read.about === 'object' && 'sameSessionAs' in read.about ? read.about.sameSessionAs : undefined;
}

/** Describes the first problem with a leaf's reads by capture session, or returns undefined. */
export function sessionReadProblem(leaf: CheckedRuleLeaf): string | undefined {
  for (const [index, read] of leaf.reads.entries()) {
    const from = sessionReadOf(read);
    if (from === undefined) continue;
    if (
      leaf.related?.length ||
      leaf.reads.some((other) => typeof other.about === 'object' && 'referencing' in other.about)
    )
      return `reads ${read.name} by capture session beside related subjects or referencing reads`;
    if (read.select !== 'all') return `reads ${read.name} by capture session without selecting all`;
    const earlier = leaf.reads.slice(0, index).find((other) => other.name === from);
    if (!earlier || earlier.about !== 'target')
      return `reads ${read.name} in the sessions of ${from}, which is not an earlier read about the target`;
  }
  return undefined;
}

/** The distinct capture sessions of the observations, in a stable order. */
export function sessionsOf(observations: readonly AcceptedObservation[]): CaptureSession[] {
  const sessions = new Map<string, CaptureSession>();
  for (const observation of observations)
    if (observation.sourceSessionId)
      sessions.set(JSON.stringify([observation.sourceId, observation.sourceSessionId]), {
        sourceId: observation.sourceId,
        sourceSessionId: observation.sourceSessionId,
      });
  return [...sessions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, session]) => session);
}

/** The types a leaf reads by capture session. */
function sessionTypes(leaf: CheckedRuleLeaf): string[] {
  return [...new Set(leaf.reads.filter((read) => sessionReadOf(read) !== undefined).map((read) => read.type))];
}

/**
 * The streams holding the observations of the sessions, with their withdrawals and replacements, at their newest
 * position. A session's observations about other subjects retain nothing on the evaluated subject, so its own cut
 * does not hold them.
 */
async function sessionStreams(
  client: PoolClient,
  tenantId: string,
  types: string[],
  sessions: readonly CaptureSession[],
): Promise<Record<string, number>> {
  const streams: Record<string, number> = {};
  for (const session of sessions) {
    const rows = await client.query<{ stream_id: string; sequence: string }>(
      observationStreamsSql(`SELECT o.tenant_id,o.id,o.event_id FROM observations o
       WHERE o.tenant_id=$1 AND o.source_id=$2 AND COALESCE(o.source_session_id,'')=$3 AND o.source_event_id IS NOT NULL
         AND o.observation_type=ANY($4::text[])`),
      [tenantId, session.sourceId, session.sourceSessionId, types],
    );
    for (const row of rows.rows) streams[row.stream_id] = Math.max(streams[row.stream_id] ?? 0, Number(row.sequence));
  }
  return streams;
}

/** The sessions the leaf's session reads take from, in the gathered reads. */
export function sessionsRead(
  leaf: CheckedRuleLeaf,
  reads: readonly { read: RuleRead; observations: AcceptedObservation[] }[],
) {
  const from = new Set(leaf.reads.flatMap((read) => sessionReadOf(read) ?? []));
  return sessionsOf(reads.filter((input) => from.has(input.read.name)).flatMap((input) => input.observations));
}

/**
 * The cut widened by the streams of the capture sessions read, or undefined when it already holds them. The basis
 * names the widening so a replay at the recorded cut reads the same sessions.
 */
export async function widenedBySessions(
  client: PoolClient,
  tenantId: string,
  leaf: CheckedRuleLeaf,
  sessions: readonly CaptureSession[],
  cut: { inputCut: InputCut; dependencyBasis: string },
): Promise<{ inputCut: InputCut; dependencyBasis: string } | undefined> {
  const found = await sessionStreams(client, tenantId, sessionTypes(leaf), sessions.slice(0, SESSION_READ_LIMIT));
  const current = cut.inputCut.streams;
  if (Object.entries(found).every(([stream, sequence]) => (current[stream] ?? 0) >= sequence)) return undefined;
  const streams = { ...current };
  for (const [stream, sequence] of Object.entries(found)) streams[stream] = Math.max(streams[stream] ?? 0, sequence);
  const inputCut: InputCut = { ...cut.inputCut, streams };
  return { inputCut, dependencyBasis: canonicalDigest({ basis: cut.dependencyBasis, sessions: inputCut }) };
}

interface SessionSubjectRow {
  source_id: string;
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_ledger_id: string | null;
  secondary_subject_kind: SubjectReference['kind'] | null;
  secondary_subject_id: string | null;
  secondary_subject_ledger_id: string | null;
}

/**
 * The subjects of the given kind that other observations of the type in the capture session are about, as
 * recorded at intake: a new or corrected report in the session can change which of their reports come first.
 */
export async function subjectsInSession(
  client: PoolClient,
  tenantId: string,
  session: CaptureSession,
  type: string,
  kind: SubjectReference['kind'],
): Promise<SubjectReference[]> {
  const rows = await client.query<SessionSubjectRow>(
    `SELECT DISTINCT source_id,subject_kind,subject_id,subject_ledger_id,secondary_subject_kind,secondary_subject_id,
       secondary_subject_ledger_id FROM observations
     WHERE tenant_id=$1 AND source_id=$2 AND COALESCE(source_session_id,'')=$3 AND source_event_id IS NOT NULL
       AND observation_type=$4 LIMIT $5`,
    [tenantId, session.sourceId, session.sourceSessionId, type, SESSION_SUBJECT_LIMIT],
  );
  const subjects = new Map<string, SubjectReference>();
  for (const row of rows.rows)
    for (const [roleKind, id, ledgerId] of [
      [row.subject_kind, row.subject_id, row.subject_ledger_id],
      [row.secondary_subject_kind, row.secondary_subject_id, row.secondary_subject_ledger_id],
    ] as const) {
      if (roleKind !== kind || !id) continue;
      const subject: SubjectReference = ledgerId
        ? { scope: 'ledger', kind, id: ledgerId }
        : { scope: 'source', kind, id, sourceId: row.source_id };
      subjects.set(subjectReferenceKey(subject), subject);
    }
  return [...subjects.values()];
}

/** The capture sessions of the observations a correction event names: withdrawn, replaced or re-attached. */
export async function correctedSessions(
  client: PoolClient,
  event: JournalEvent,
): Promise<(CaptureSession & { type: string })[]> {
  const named = typeof event.payload.observationId === 'string' ? event.payload.observationId : null;
  const rows = await client.query<{ source_id: string; source_session_id: string; observation_type: string }>(
    `SELECT o.source_id,o.source_session_id,o.observation_type FROM observations o WHERE o.tenant_id=$1
       AND o.source_session_id IS NOT NULL AND o.source_event_id IS NOT NULL AND (o.id=$2 OR o.id=(
       SELECT r.replaces_observation_id FROM observations r WHERE r.tenant_id=$1 AND r.event_id=$3))`,
    [event.tenant_id, named, event.id],
  );
  return rows.rows.map((row) => ({
    sourceId: row.source_id,
    sourceSessionId: row.source_session_id,
    type: row.observation_type,
  }));
}
