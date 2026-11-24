import type { DocumentPurposesResponse, PackAdoptionAcceptance, SmsRecordDraft } from '@ledger/contracts';
import { DomainError, type PoolClient } from '@ledger/persistence';

type Purpose = DocumentPurposesResponse['purposes'][number];

/**
 * The document purposes declared by the packs the organization has adopted, in effect or still to come
 * (docs/design/on-file-checks.md). A plain read: it takes no lock.
 */
export async function adoptedDocumentPurposes(client: PoolClient, tenantId: string): Promise<DocumentPurposesResponse> {
  const rows = await client.query<{ record: PackAdoptionAcceptance }>(
    `SELECT a.record FROM organization_pack_adoptions a
     JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
     WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.effective_end>clock_timestamp()
     ORDER BY a.pack_id COLLATE "C",a.accepted_revision DESC`,
    [tenantId, `organization:${tenantId}`],
  );
  const purposes = new Map<string, Purpose>();
  for (const { record } of rows.rows) {
    const { pack } = record;
    for (const declared of pack.purposes ?? []) {
      const purpose = purposes.get(declared.id) ?? {
        id: declared.id,
        title: declared.title,
        documentTypes: [],
        declaredBy: [],
      };
      for (const type of declared.documentTypes ?? [])
        if (!purpose.documentTypes.includes(type)) purpose.documentTypes.push(type);
      if (!purpose.declaredBy.some((item) => item.packId === pack.packId && item.version === pack.version))
        purpose.declaredBy.push({
          packId: pack.packId,
          version: pack.version,
          packTitle: pack.title,
          reference: declared.source.reference,
          text: declared.source.text,
        });
      purposes.set(declared.id, purpose);
    }
  }
  return {
    purposes: [...purposes.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1)),
  };
}

/** The purposes a document draft ticks; none for any other record. */
export function draftPurposes(draft: SmsRecordDraft): string[] {
  return draft.kind === 'document' && draft.schema === 'sms.document.2' ? [...(draft.body.purposes ?? [])] : [];
}

/**
 * Refuses a purpose no adopted pack declares, unless the document's previous revision already served it (a pack
 * revised since may no longer declare it).
 */
export async function requireOfferedPurposes(
  client: PoolClient,
  tenantId: string,
  draft: SmsRecordDraft,
  kept: readonly string[] = [],
): Promise<void> {
  const ticked = draftPurposes(draft).filter((id) => !kept.includes(id));
  if (!ticked.length) return;
  const offered = new Set((await adoptedDocumentPurposes(client, tenantId)).purposes.map((purpose) => purpose.id));
  const unknown = ticked.filter((id) => !offered.has(id));
  if (unknown.length)
    throw new DomainError(
      400,
      'unknown_document_purpose',
      `No rule pack your organization has adopted looks for ${unknown.join(', ')}`,
      { purposes: unknown },
    );
}
