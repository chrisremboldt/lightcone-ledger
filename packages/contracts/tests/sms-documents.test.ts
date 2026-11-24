import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { CommandSchema } from '../src/index.js';
import { DocumentBodySchema, DocumentBodyV2Schema } from '../src/sms.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

describe('controlled SMS document contracts', () => {
  it('preserves the original document schema while requiring provenance for received revisions', () => {
    const original = ajv.compile(DocumentBodySchema);
    const current = ajv.compile(DocumentBodyV2Schema);
    const body = { documentType: 'procedure', summary: 'Battery isolation procedure.', revisionLabel: 'Revision 1' };
    expect(original(body), JSON.stringify(original.errors)).toBe(true);
    expect(original({ ...body, origin: 'authored', changeReason: 'Initial issue' })).toBe(false);
    expect(original({ ...body, documentType: 'oem_manual' })).toBe(false);
    expect(current({ ...body, origin: 'authored', changeReason: 'Initial issue' })).toBe(true);
    expect(current({ ...body, origin: 'authored' })).toBe(false);

    const received = {
      ...body,
      documentType: 'service_bulletin',
      origin: 'received',
      changeReason: 'Received the updated isolation procedure.',
      source: {
        organization: 'Fictional Aircraft Manufacturer',
        revision: 'B',
        receivedAt: '2026-10-23T14:00:00Z',
      },
    };
    expect(current(received), JSON.stringify(current.errors)).toBe(true);
    expect(current({ ...received, source: { ...received.source, issuedAt: '2026-10-01' } })).toBe(true);
    expect(current({ ...received, source: undefined })).toBe(false);
    expect(current({ ...received, source: { ...received.source, revision: undefined } })).toBe(false);
    expect(current({ ...received, source: { ...received.source, receivedAt: undefined } })).toBe(false);
  });

  it('uses the existing command envelope to review, issue and distribute an exact document', () => {
    const commands = ajv.compile(CommandSchema);
    const envelope = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: 'procedure-1' },
      expectedRevision: 4,
      expectedDependencyBasis: 'a'.repeat(64),
    };
    const review = {
      kind: 'document.review',
      versionNumber: 2,
      attachmentIds: ['source-2'],
      note: 'Reviewed the revised manufacturer instructions.',
    };
    const issue = {
      kind: 'document.issue',
      versionNumber: 2,
      adoptionId: 'adoption-2',
      effectiveFrom: '2026-10-24T14:00:00Z',
      recipientIds: ['pilot-1'],
      note: 'Issue this reviewed and adopted procedure.',
    };
    const distribution = {
      kind: 'document.distribute',
      issueId: 'issue-2',
      recipientIds: ['pilot-2'],
      note: 'Assign this issue to the new pilot.',
    };
    for (const decision of [review, issue, distribution]) {
      expect(commands({ ...envelope, decision }), JSON.stringify(commands.errors)).toBe(true);
    }
    expect(commands({ ...envelope, decision: { ...review, attachmentIds: ['source-2', 'source-2'] } })).toBe(false);
    expect(
      commands({ ...envelope, decision: { ...issue, recipients: [{ id: 'pilot-1', name: 'Caller name' }] } }),
    ).toBe(false);
  });

  it('requires the acknowledged issue and content digest without accepting another identity or statement', () => {
    const commands = ajv.compile(CommandSchema);
    const command = {
      kind: 'sms.document.acknowledge',
      recordId: 'procedure-1',
      issueId: 'issue-2',
      contentDigest: 'b'.repeat(64),
      note: 'Reviewed before my next assignment.',
    };
    expect(commands(command), JSON.stringify(commands.errors)).toBe(true);
    expect(commands({ ...command, contentDigest: undefined })).toBe(false);
    expect(commands({ ...command, principalId: 'another-pilot' })).toBe(false);
    expect(commands({ ...command, statement: 'I read something else.' })).toBe(false);
  });
});
