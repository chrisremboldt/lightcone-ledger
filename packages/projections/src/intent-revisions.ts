import type { FlightInput as Input } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type JournalEvent, type PoolClient } from '@ledger/persistence';

interface IntentState {
  id: string;
  intent_revision: string | number;
  intent_source_id: string | null;
}
interface RetainedRevision {
  revision: string;
  payload_digest: string;
  event_id: string;
}
interface LegacyInput {
  id: string;
  source_id: string;
  payload: Input;
}
const legacyMaxEvents = 64,
  legacyMaxBytes = 1024 * 1024;
function digest(input: Input, key: string): string {
  return canonicalDigest({
    originationKey: key,
    intentRefId: input.subject.externalFlightId ?? key,
    payload: input.payload.intent ?? input.payload,
  });
}
const legacyFrom = `FROM timeline_items t JOIN journal_events e ON e.tenant_id=t.tenant_id AND e.id=t.id JOIN work_items w ON w.tenant_id=e.tenant_id AND w.event_id=e.id
 WHERE t.flight_id=$1 AND e.event_type='intent.revision' AND w.state='completed'
 AND COALESCE(e.payload#>>'{subject,originationKey}',e.payload#>>'{payload,intent,originationKey}',e.payload#>>'{payload,originationKey}')=$2
 AND COALESCE(e.payload->'sourceRevision',e.payload#>'{payload,intent,revision}',e.payload#>'{payload,revision}','0'::jsonb)=ANY($3::jsonb[])`;
async function legacyInputs(
  client: PoolClient,
  flight: IntentState,
  key: string,
  revision: number,
  includeCurrent: boolean,
): Promise<LegacyInput[]> {
  const versions = [...new Set(includeCurrent ? [revision, Number(flight.intent_revision)] : [revision])].map(String);
  const params = [flight.id, key, versions];
  const count = (
    await client.query(
      `SELECT COUNT(*) AS count FROM (SELECT 1 ${legacyFrom} LIMIT ${legacyMaxEvents + 1}) candidate`,
      params,
    )
  ).rows[0].count;
  if (Number(count) > legacyMaxEvents)
    throw new DomainError(
      409,
      'legacy_intent_revision_unverifiable',
      'Legacy source intent verification exceeds its bounded history window',
    );
  const bytes = (
    await client.query(`SELECT COALESCE(SUM(octet_length(e.payload::text)),0) AS bytes ${legacyFrom}`, params)
  ).rows[0].bytes;
  if (Number(bytes) > legacyMaxBytes)
    throw new DomainError(
      409,
      'legacy_intent_revision_unverifiable',
      'Legacy source intent verification exceeds its bounded history window',
    );
  return (await client.query(`SELECT e.id,e.source_id,e.payload ${legacyFrom} ORDER BY e.received_at,e.id`, params))
    .rows;
}
async function retain(
  client: PoolClient,
  event: JournalEvent,
  key: string,
  revision: number,
  payloadDigest: string,
  origin: 'projected_input' | 'legacy_projected_input',
): Promise<void> {
  await client.query(
    'INSERT INTO source_intent_revisions(tenant_id,source_id,origination_key,revision,payload_digest,event_id,retention_origin) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
    [event.tenant_id, event.source_id, key, revision, payloadDigest, event.id, origin],
  );
}
function sourceRevision(input: Input): number {
  return (
    input.sourceRevision ?? Number(((input.payload.intent ?? input.payload) as Record<string, unknown>).revision ?? 0)
  );
}

export async function retainIntentRevision(
  client: PoolClient,
  event: JournalEvent,
  input: Input,
  key: string,
  flight?: IntentState,
): Promise<{ apply: boolean; sourceId: string | null }> {
  const revision = sourceRevision(input),
    payloadDigest = digest(input, key);
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new DomainError(400, 'invalid_intent_revision', 'Intent revision must be a nonnegative safe integer');
  let currentSource = flight?.intent_source_id ?? null;
  let exact = (
    await client.query(
      'SELECT revision,payload_digest,event_id FROM source_intent_revisions WHERE source_id=$1 AND origination_key=$2 AND revision=$3',
      [input.sourceId, key, revision],
    )
  ).rows[0] as RetainedRevision | undefined;
  if (currentSource && currentSource !== input.sourceId)
    throw new DomainError(
      409,
      'intent_source_conflict',
      'Another source owns the current intent; source adoption is not implemented',
    );
  let head = (
    await client.query(
      'SELECT revision FROM source_intent_revisions WHERE source_id=$1 AND origination_key=$2 ORDER BY revision DESC LIMIT 1',
      [input.sourceId, key],
    )
  ).rows[0];
  if (flight && (!currentSource || (!exact && revision <= Number(head?.revision ?? flight.intent_revision)))) {
    const prior = await legacyInputs(client, flight, key, revision, !currentSource);
    const current = prior.filter((row) => sourceRevision(row.payload) === Number(flight.intent_revision));
    if (!currentSource && current.length) {
      const sources = new Set(current.map((row) => row.source_id)),
        digests = new Set(current.map((row) => digest(row.payload, key)));
      if (sources.size !== 1 || digests.size !== 1)
        throw new DomainError(
          409,
          'legacy_intent_revision_unverifiable',
          'Legacy current intent has competing sources or conflicting retained payloads',
        );
      currentSource = current[0]!.source_id;
      await retain(
        client,
        { ...event, id: current[0]!.id, source_id: currentSource },
        key,
        Number(flight.intent_revision),
        [...digests][0]!,
        'legacy_projected_input',
      );
    }
    const same = prior.filter((row) => row.source_id === input.sourceId && sourceRevision(row.payload) === revision);
    if (!exact && same.length) {
      const digests = new Set(same.map((row) => digest(row.payload, key)));
      if (digests.size !== 1)
        throw new DomainError(
          409,
          'source_revision_conflict',
          'Historical source intent revision carries conflicting content',
        );
      exact = { revision: String(revision), payload_digest: [...digests][0]!, event_id: same[0]!.id };
      await retain(
        client,
        { ...event, id: exact.event_id, source_id: input.sourceId },
        key,
        revision,
        exact.payload_digest,
        'legacy_projected_input',
      );
    }
  }
  if (currentSource && currentSource !== input.sourceId)
    throw new DomainError(
      409,
      'intent_source_conflict',
      'Another source owns the current intent; source adoption is not implemented',
    );
  if (exact && exact.payload_digest !== payloadDigest)
    throw new DomainError(409, 'source_revision_conflict', 'Same source intent revision carries conflicting content');
  let apply = !exact;
  if (flight) {
    if (currentSource) {
      head = (
        await client.query(
          'SELECT revision FROM source_intent_revisions WHERE source_id=$1 AND origination_key=$2 ORDER BY revision DESC LIMIT 1',
          [input.sourceId, key],
        )
      ).rows[0];
      if (!head)
        throw new DomainError(
          409,
          'legacy_intent_revision_unverifiable',
          'Current intent source has no retained revision baseline',
        );
      apply = revision > Number(head.revision);
    } else {
      const declaration = (
        await client.query(
          "SELECT 1 FROM journal_events WHERE event_type='flight.created' AND payload->>'flightId'=$1 AND payload ? 'intentRef' LIMIT 1",
          [flight.id],
        )
      ).rowCount;
      const hasBaseline = Number(flight.intent_revision) > 0 || Boolean(declaration);
      if (hasBaseline && revision === Number(flight.intent_revision))
        throw new DomainError(
          409,
          'legacy_intent_revision_unverifiable',
          'Direct or legacy intent revision has no verified historical payload',
        );
      apply = !hasBaseline || revision > Number(flight.intent_revision);
    }
  }
  if (!exact) await retain(client, event, key, revision, payloadDigest, 'projected_input');
  return { apply, sourceId: currentSource ?? (apply ? input.sourceId : null) };
}
