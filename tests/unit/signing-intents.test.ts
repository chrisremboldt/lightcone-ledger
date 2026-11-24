import { describe, expect, it } from 'vitest';
import {
  documentAcknowledgementStatement,
  documentTypeValues,
  revisionWords,
} from '../../packages/contracts/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { adoptionContent } from '../../packages/domain/src/sms-decisions.js';

// A signing intent names what its number is: the person reads "revision 3 of the safety policy", never "3 of".

const signer = {
  id: 'principal-avery',
  tenantId: 'tenant-example-ridge',
  name: 'Avery Example',
  kind: 'human',
  capabilities: ['decision:write', 'sms:adopt'],
} as unknown as AuthContext;

function documentIntent(documentType: string, revisionLabel: string | undefined): string {
  const record = { id: 'sms-document-1', kind: 'document', revision: '2', tenant_id: signer.tenantId };
  const version = {
    record_id: record.id,
    version_number: 4,
    title: 'Safety policy',
    body_digest: 'a'.repeat(64),
    body: { documentType, summary: 'What the organization commits to.', ...(revisionLabel ? { revisionLabel } : {}) },
  };
  return adoptionContent(signer, record as never, version as never, []).content.intent;
}

describe('a signing intent that carries a number', () => {
  it('names a bare revision label as a revision, for every document type', () => {
    for (const documentType of documentTypeValues) {
      const intent = documentIntent(documentType, '3');
      expect(intent).toMatch(/^I, Avery Example, adopt revision 3 of the /);
      expect(intent).not.toMatch(/adopt 3 /);
    }
    expect(documentIntent('safety_policy', 'B')).toContain('adopt revision B of the safety policy “Safety policy”');
  });

  it('keeps a label written in words, and names a document with no label by its version', () => {
    expect(documentIntent('safety_policy', 'Revision 1')).toContain('adopt Revision 1 of the safety policy');
    expect(documentIntent('oem_manual', 'OEM Revision 4')).toContain('adopt OEM Revision 4 of the OEM manual');
    expect(documentIntent('procedure', undefined)).toContain('adopt version 4 of the procedure');
  });

  it('names the revision the same way in a reader’s acknowledgement', () => {
    expect(
      documentAcknowledgementStatement({
        title: 'Safety policy',
        revisionLabel: '3',
        versionNumber: 4,
        attachmentIds: [],
      }),
    ).toBe('I have read Safety policy, revision 3.');
    expect(revisionWords(null, 2)).toBe('version 2');
    expect(revisionWords(' 2.1 ', 2)).toBe('revision 2.1');
  });
});
