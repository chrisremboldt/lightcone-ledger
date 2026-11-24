import { describe, expect, it } from 'vitest';
import { renderSmsPacket, type SmsPacketBundle } from '../../packages/evidence/src/sms-packet.js';

const digest = 'a'.repeat(64);
const version = (overrides: Record<string, unknown>) => ({
  eventId: 'v1',
  versionNumber: 1,
  schema: 'sms.hazard.1',
  title: 'Hazard',
  body: null,
  bodyDigest: digest,
  ownerId: 'p1',
  dueAt: null,
  links: [],
  recordedBy: 'p1',
  recordedAt: '2026-10-20T15:00:00.000Z',
  ...overrides,
});
const bundle: SmsPacketBundle = {
  manifest: {
    exportId: 'e1',
    issuedBy: 'p1',
    issuedAt: '2026-10-20T16:00:00.000Z',
    scope: { kind: 'record_closure', recordId: 'h1', recordIds: ['h1', 'r1'], statement: 'Scope statement.' },
    counts: { records: 2, decisions: 0, signatures: 0, attachments: 0, withheld: 1 },
    limitations: ['Scope statement.'],
  },
  manifestDigest: digest,
  records: [
    {
      id: 'h1',
      kind: 'hazard',
      recordClass: 'srm_output',
      confidentiality: 'ordinary',
      status: 'identified',
      attachments: [],
      versions: [
        version({
          title: '<script>alert(1)</script> line strike',
          body: {
            description: 'Link loss <img src=x onerror=alert(1)>',
            consequence: 'Contact with a conductor.',
            source: { kind: 'manual_identification' },
          },
          links: [{ relation: 'derived_from', target: { kind: 'sms_record', id: 'r1' } }],
        }),
      ],
    },
    {
      id: 'r1',
      kind: 'report',
      recordClass: 'safety_assurance_output',
      confidentiality: 'safety_report',
      status: 'received',
      attachments: [],
      versions: [version({ eventId: 'v2', schema: 'sms.report.1', title: null, links: null })],
    },
  ],
  decisions: [],
  signatures: [],
  withheld: [
    {
      kind: 'record_body',
      id: 'v2',
      recordId: 'r1',
      confidentiality: 'safety_report',
      sha256: digest,
      reason: 'Safety report content is not included in ordinary exports.',
    },
  ],
  people: [{ id: 'p1', name: 'Fictional Safety Manager' }],
};

describe('SMS reading copy', () => {
  it('escapes recorded text and shows withheld content as withheld', () => {
    const html = renderSmsPacket(bundle, 'Fictional Utility <Drone Program>');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; line strike');
    expect(html).toContain('Fictional Utility &lt;Drone Program&gt;');
    expect(html).toContain('Safety report (content withheld)');
    expect(html).toContain('Content withheld.');
    expect(html).toContain('href="#record-r1"');
    expect(html).toContain(digest);
  });
});
