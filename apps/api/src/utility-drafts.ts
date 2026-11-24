import type { SmsRecordDraft } from '@ledger/contracts';

export function utilityPolicyDraft(ownerId: string): SmsRecordDraft {
  return {
    kind: 'document',
    schema: 'sms.document.2',
    title: 'Drone program safety policy',
    ownerId,
    body: {
      origin: 'authored',
      documentType: 'safety_policy',
      documentNumber: 'FVP-SP-001',
      revisionLabel: 'Revision 1',
      summary:
        'Safety objectives, the code of ethics and management commitment for the fictional utility drone program.',
      changeReason: 'Initial issue',
      text: [
        'Fictional Valley Power operates its drone program so that no flight puts the public, our crews or the grid at unacceptable risk.',
        'Objectives: report every hazard we see; assess risk before new operations; keep controls in place and check that they work.',
        'Code of ethics: we speak up about safety without fear of reprisal, and we never trade safety for schedule.',
        'The accountable executive provides the resources the program needs and reviews its safety performance every quarter.',
      ].join('\n\n'),
    },
  };
}
