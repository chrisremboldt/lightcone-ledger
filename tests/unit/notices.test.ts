import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { failureReason } from '../../apps/workers/src/notices.js';
import { placeFromAddress } from '../../apps/web/src/place.js';
import {
  noticeDay,
  noticeSentence,
  noticeTime,
  noticeWebhookBody,
  renderNoticeEmail,
  webhookSignature,
  type NoticeContent,
} from '../../packages/domain/src/notice-content.js';
import {
  noticeDeployment,
  noticePath,
  safetyNoticeRecord,
  webhookAddressProblem,
} from '../../packages/domain/src/notices.js';

const organization = { id: 'tenant-ridge', name: 'Example Ridge Survey', timeZone: 'America/Denver' };
const audit = safetyNoticeRecord({
  id: 'record-1',
  kind: 'assurance',
  title: 'Preflight records audit, RIDGE-AUD-1',
  reference: 'AUD-7',
  confidentiality: 'ordinary',
});

function content(extra: Partial<NoticeContent>): NoticeContent {
  return {
    version: 'notice.1',
    kind: 'assigned',
    event: 'action.assigned',
    organization,
    assigneeId: 'person-avery',
    by: 'Avery Example',
    record: audit,
    ...extra,
  };
}

describe('what a notice says', () => {
  it('says what happened, names the record by its reference and title, its due day and its address', () => {
    const { subject, text } = renderNoticeEmail(
      content({ actionId: 'A1', dueOn: '2026-12-01' }),
      'https://ledger.example.org/',
    );
    expect(subject).toBe('[Example Ridge Survey] An action is set for you: Safety assurance record AUD-7');
    expect(text).toBe(
      [
        'Example Ridge Survey',
        '',
        'Avery Example set an action for you, due on Tuesday 1 December 2026.',
        '',
        'Safety assurance record AUD-7 · Preflight records audit, RIDGE-AUD-1',
        'Action: A1',
        'Due: Tuesday 1 December 2026',
        'Open it in Ledger: https://ledger.example.org/safety/assurance/record-1',
        '',
        "You get this email because you chose when something is assigned to you in Ledger. Change your notices from your name in Ledger's bar.",
        '',
      ].join('\n'),
    );
    expect(text).not.toMatch(/<|https?:\/\/(?!ledger\.example\.org\/safety)/);
  });

  it('says each kind of notice in one sentence, to the person and to the organization', () => {
    const due = content({ event: 'action.due', kind: 'due', by: undefined, actionId: 'A2', dueOn: '2026-12-03' });
    expect(noticeSentence(due)).toBe('Action A2 of yours is due on Thursday 3 December 2026.');
    expect(noticeSentence(due, 'organization')).toBe('Action A2 is due on Thursday 3 December 2026.');
    const overdue = content({ event: 'action.overdue', kind: 'overdue', by: undefined, dueOn: '2026-11-20' });
    expect(noticeSentence(overdue)).toBe(
      'An action of yours was due on Friday 20 November 2026 and is not recorded as done.',
    );
    const finding = content({ event: 'finding.assigned' });
    expect(noticeSentence(finding)).toBe('Avery Example assigned a finding to you.');
    expect(noticeSentence(finding, 'organization')).toBe('Avery Example assigned a finding to a person.');
    // A deadline is an instant, shown in the organization's own time zone.
    const acknowledge = content({
      event: 'document.acknowledgement',
      kind: 'acknowledgement',
      dueAt: '2026-12-02T00:00:00.000Z',
    });
    expect(noticeSentence(acknowledge)).toBe(
      'Avery Example issued a document for you to acknowledge by 1 December 2026, 17:00 MST.',
    );
    expect(noticeTime('2026-07-02T00:00:00.000Z', 'America/Denver')).toBe('1 July 2026, 18:00 MDT');
    expect(noticeDay('2026-12-01')).toBe('Tuesday 1 December 2026');
  });

  it('never carries the title of a safety report or a restricted record, only its reference and link', () => {
    for (const record of [
      {
        id: 'report-1',
        kind: 'report',
        title: 'Near collision at the ridge',
        reference: 'SR-3',
        confidentiality: 'safety_report',
      },
      {
        id: 'hazard-9',
        kind: 'hazard',
        title: 'Dock RIDGE-D1 battery fault details',
        reference: null,
        confidentiality: 'restricted_asset_information',
      },
    ]) {
      const named = safetyNoticeRecord(record);
      expect(named.title).toBeNull();
      const notice = content({ record: named });
      const { subject, text } = renderNoticeEmail(notice, 'https://ledger.example.org');
      const body = JSON.stringify(noticeWebhookBody({ id: 'n1', createdAt: '2026-11-25T00:00:00.000Z' }, notice, null));
      for (const shown of [subject, text, body]) {
        expect(shown).not.toContain(record.title);
        expect(shown).toContain(record.reference ?? record.id);
      }
      expect(text).toContain(`https://ledger.example.org${named.path}`);
    }
  });

  it('lists what is someone’s in a digest', () => {
    const { subject, text } = renderNoticeEmail(
      content({
        event: 'digest',
        kind: 'digest',
        record: undefined,
        by: undefined,
        digest: {
          period: 'daily',
          day: '2026-11-25',
          overdue: [{ record: audit, actionId: 'A1', dueOn: '2026-11-20' }],
          due: [],
          assigned: [{ record: { ...audit, label: 'Finding', reference: 'f-1', path: '/rules/findings/person/p-1' } }],
          acknowledgement: [{ record: { ...audit, label: 'Document', reference: 'DOC-2', title: null }, dueAt: null }],
        },
      }),
      'https://ledger.example.org',
    );
    expect(subject).toBe('[Example Ridge Survey] What is yours in Ledger');
    expect(text).toContain('What is yours in Example Ridge Survey today, Wednesday 25 November 2026.');
    expect(text).toContain(
      'Overdue\n- Safety assurance record AUD-7 · Preflight records audit, RIDGE-AUD-1, action A1 (was due Friday 20 November 2026)',
    );
    expect(text).toContain('Assigned to you\n- Finding f-1');
    expect(text).toContain('Waiting for your acknowledgement\n- Document DOC-2\n');
    expect(text).not.toContain('Due soon');
  });
});

describe('a webhook call', () => {
  it('names the person by id, never by address, and is signed over the timestamp and the body', () => {
    const notice = content({ actionId: 'A1', dueOn: '2026-12-01' });
    const body = JSON.stringify(
      noticeWebhookBody({ id: 'n1', createdAt: '2026-11-25T00:00:00.000Z' }, notice, 'https://ledger.example.org'),
    );
    expect(JSON.parse(body)).toMatchObject({
      version: 'ledger.notice.1',
      kind: 'assigned',
      assigneeId: 'person-avery',
      sentence: 'Avery Example set an action for a person, due on Tuesday 1 December 2026.',
      record: { url: 'https://ledger.example.org/safety/assurance/record-1', reference: 'AUD-7' },
    });
    expect(body).not.toContain('@');
    const signature = webhookSignature('a-secret', '1764028800', body);
    expect(signature).toBe(`sha256=${createHmac('sha256', 'a-secret').update(`1764028800.${body}`).digest('hex')}`);
  });

  it('is sent to https only, and to http only on a local Ledger', () => {
    expect(webhookAddressProblem('https://hooks.example.org/ledger', false)).toBeUndefined();
    expect(webhookAddressProblem('http://127.0.0.1:4002/_notices/webhook', true)).toBeUndefined();
    expect(webhookAddressProblem('http://hooks.example.org/ledger', false)).toMatch(/https:\/\//);
    expect(webhookAddressProblem('ftp://hooks.example.org', true)).toBeDefined();
  });
});

describe('the deployment’s notice settings', () => {
  it('sends no email unless a mail server is named', () => {
    expect(noticeDeployment({})).toEqual({ smtp: null, publicUrl: null });
  });

  it('refuses to start with a mail server and no public address for links, or no From address', () => {
    expect(() =>
      noticeDeployment({ LEDGER_SMTP_HOST: 'mail.example.org', LEDGER_SMTP_FROM: 'ledger@example.org' }),
    ).toThrow(/LEDGER_PUBLIC_URL/);
    expect(() =>
      noticeDeployment({ LEDGER_SMTP_HOST: 'mail.example.org', LEDGER_PUBLIC_URL: 'https://ledger.example.org' }),
    ).toThrow(/LEDGER_SMTP_FROM/);
    expect(() =>
      noticeDeployment({
        LEDGER_SMTP_HOST: 'mail.example.org',
        LEDGER_SMTP_FROM: 'ledger@example.org',
        LEDGER_PUBLIC_URL: 'https://ledger.example.org',
        LEDGER_SMTP_USER: 'ledger',
      }),
    ).toThrow(/LEDGER_SMTP_PASSWORD/);
    expect(() => noticeDeployment({ LEDGER_PUBLIC_URL: 'ledger.example.org' })).toThrow(/LEDGER_PUBLIC_URL/);
  });

  it('reads the mail server, its port and the public address', () => {
    expect(
      noticeDeployment({
        LEDGER_SMTP_HOST: 'mail.example.org',
        LEDGER_SMTP_FROM: 'ledger@example.org',
        LEDGER_PUBLIC_URL: 'https://ledger.example.org/',
        LEDGER_SMTP_SECURE: '1',
      }),
    ).toEqual({
      smtp: {
        host: 'mail.example.org',
        port: 465,
        secure: true,
        user: null,
        password: null,
        from: 'ledger@example.org',
      },
      publicUrl: 'https://ledger.example.org',
    });
  });
});

describe('the address a notice links to', () => {
  it('is the address of the record’s place in the web app', () => {
    expect(placeFromAddress(noticePath('safety', 'assurance', 'record-1'))).toEqual({
      section: 'safety',
      view: 'record',
      kind: 'assurance',
      id: 'record-1',
    });
    expect(
      placeFromAddress(
        safetyNoticeRecord(
          { id: 'doc-1', kind: 'document', title: 'Ops manual', reference: null, confidentiality: 'ordinary' },
          'issue-1',
        ).path,
      ),
    ).toEqual({ section: 'safety', view: 'record', kind: 'document', id: 'doc-1', issueId: 'issue-1' });
    expect(placeFromAddress(noticePath('flights', 'flight-1', 'findings', 'finding-1'))).toEqual({
      section: 'flights',
      flightId: 'flight-1',
      findingId: 'finding-1',
    });
    expect(placeFromAddress(noticePath('rules', 'findings', 'operator-records', 'person', 'RIDGE-PILOT@1'))).toEqual({
      section: 'rules',
      pane: 'open',
      subject: { sourceId: 'operator-records', kind: 'person', id: 'RIDGE-PILOT@1' },
    });
    expect(placeFromAddress('/people/notices')).toEqual({ section: 'people', pane: 'notices' });
    expect(placeFromAddress('/people/notices/webhook')).toEqual({ section: 'people', pane: 'webhook' });
  });
});

describe('why a send failed', () => {
  it('says it in words an administrator can act on', () => {
    expect(failureReason(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'webhook')).toBe(
      'The webhook did not answer within 10 seconds',
    );
    expect(
      failureReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'webhook'),
    ).toBe('Could not reach the webhook (ECONNREFUSED)');
    expect(
      failureReason(
        Object.assign(new Error('Can’t send mail'), {
          code: 'EENVELOPE',
          responseCode: 550,
          response: '550 Mailbox unavailable',
        }),
        'email',
      ),
    ).toBe('The mail server refused it: 550 Mailbox unavailable');
  });
});
