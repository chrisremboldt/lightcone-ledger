import type { DocumentBodyV2, SmsRecordDraft } from '@ledger/contracts';

export const exampleTitle = 'Aircraft inspection manual';
export const exampleNumber = 'FVP-OEM-100';
export const exampleLabels = {
  4: 'Fictional Aircraft Company inspection manual — Revision 4',
  5: 'Fictional Aircraft Company inspection manual — Revision 5',
} as const;

export function exampleDocument(ownerId: string, revision: 4 | 5): SmsRecordDraft {
  const body: DocumentBodyV2 = {
    origin: 'received',
    documentType: 'oem_manual',
    documentNumber: exampleNumber,
    revisionLabel: `OEM Revision ${revision}`,
    changeReason:
      revision === 4
        ? 'Inspection instructions for every FAC Scout 4 in our fleet.'
        : 'The manufacturer added a rotor brake check that applies to every FAC Scout 4 in our fleet.',
    summary:
      revision === 4
        ? 'Preflight and post-landing inspection instructions for the FAC Scout 4.'
        : 'Adds a rotor brake condition check before flight (page 1, step 5) and a record of the result after landing (page 2).',
    source: {
      organization: 'Fictional Aircraft Company',
      reference: 'FAC-IM-100',
      revision: String(revision),
      issuedAt: revision === 4 ? '2026-08-14' : '2026-10-22',
      receivedAt: revision === 4 ? '2026-08-17T15:00:00Z' : '2026-10-23T15:00:00Z',
    },
  };
  return { kind: 'document', schema: 'sms.document.2', title: exampleTitle, ownerId, body };
}

export function examplePdfUrl(revision: 4 | 5): URL {
  return new URL(`../fixtures/utility-documents/aircraft-inspection-manual-revision-${revision}.pdf`, import.meta.url);
}
