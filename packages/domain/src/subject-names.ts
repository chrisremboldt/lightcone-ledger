import { subjectReferenceKey, type NamedSubject, type SubjectReference } from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { recordNamesOf } from './operator-record-subjects.js';

/**
 * The names a person knows subjects by: a Ledger subject's label, or for a subject a source names by its own id, the
 * name the latest current record of a naming type under that source gives it (a person's personnel file, an
 * aircraft's identity, a flight's plan), else that id. Names are read now, never stored. Keyed by subjectReferenceKey.
 */
export async function subjectNames(
  client: PoolClient,
  tenantId: string,
  subjects: readonly SubjectReference[],
): Promise<Map<string, NamedSubject>> {
  const ledgerIds = [...new Set(subjects.filter((item) => item.scope === 'ledger').map((item) => item.id))];
  const labels = new Map<string, string>();
  if (ledgerIds.length) {
    const rows = await client.query<{ id: string; kind: string; label: string }>(
      'SELECT id,kind,label FROM subjects WHERE tenant_id=$1 AND id=ANY($2::text[])',
      [tenantId, ledgerIds],
    );
    for (const row of rows.rows) labels.set(`${row.kind}\u0000${row.id}`, row.label);
  }
  const recordNames = new Map<string, string>();
  const bySource = new Map<string, { kind: string; id: string }[]>();
  for (const subject of subjects)
    if (subject.scope === 'source' && subject.sourceId)
      bySource.set(subject.sourceId, [...(bySource.get(subject.sourceId) ?? []), subject]);
  for (const [sourceId, members] of bySource)
    for (const [key, name] of await recordNamesOf(client, tenantId, sourceId, members))
      recordNames.set(`${sourceId}\u0000${key}`, name);
  const named = new Map<string, NamedSubject>();
  for (const subject of subjects) {
    const label =
      subject.scope === 'ledger'
        ? labels.get(`${subject.kind}\u0000${subject.id}`)
        : recordNames.get(`${subject.sourceId}\u0000${subject.kind} ${subject.id}`);
    named.set(subjectReferenceKey(subject), { ...subject, name: label?.trim() || subject.id });
  }
  return named;
}
