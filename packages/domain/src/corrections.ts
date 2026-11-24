import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';

const correctableEvidenceKinds = new Set([
  'flight.observation',
  'source.observation',
  'airspace.status',
  'telemetry.segment',
  'command-link.status',
  'command-link.baseline',
]);

interface CorrectionTarget {
  id: string;
  kind: string;
  correction_of: string | null;
}

export async function requireEvidenceCorrectionTarget(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  targetId: string,
): Promise<void> {
  const targets = await client.query<CorrectionTarget>(
    `WITH RECURSIVE targets AS (
      SELECT id,kind,correction_of FROM timeline_items WHERE tenant_id=$1 AND flight_id=$2 AND id=$3
      UNION
      SELECT t.id,t.kind,t.correction_of FROM timeline_items t JOIN targets prior
       ON prior.kind='evidence.correct' AND prior.correction_of=t.id
       WHERE t.tenant_id=$1 AND t.flight_id=$2
     ) SELECT id,kind,correction_of FROM targets`,
    [principal.tenantId, flightId, targetId],
  );
  if (!targets.rowCount)
    throw new DomainError(404, 'correction_target_missing', 'Correction must name evidence in this flight thread');
  const original = targets.rows.find((target) => target.kind !== 'evidence.correct');
  if (original?.kind === 'mission.revision')
    throw new DomainError(
      409,
      'mission_revision_required',
      'Mission plans change through an authorized source revision',
    );
  if (original && ['order.revision', 'intent.revision'].includes(original.kind))
    throw new DomainError(409, 'source_revision_required', 'Plans change through an authorized source revision');
  if (!original || !correctableEvidenceKinds.has(original.kind))
    throw new DomainError(
      409,
      'correction_target_unsupported',
      'Append corrections to source reports or evidence; recorded decisions and computed checks remain unchanged',
    );
}
