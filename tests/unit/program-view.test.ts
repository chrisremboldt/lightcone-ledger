import { describe, expect, test } from 'vitest';
import {
  privateAddressLiteral,
  programAddressProblem,
  programAnswerDocument,
  programOperatorState,
  programViewUrl,
} from '../../packages/domain/src/program-operators.js';
import { grantLinkSecret } from '../../packages/evidence/src/program-grants.js';
import { RECORD_LINK_SECRET_PATTERN } from '../../packages/contracts/src/index.js';

const document = {
  version: 'ledger.program-view.1',
  operator: { name: 'Example Ridge Survey' },
  madeAt: '2026-11-20T10:00:00.000Z',
  grantExpiresAt: '2027-02-18T10:00:00.000Z',
  openFindings: { total: 0, truncated: false, rules: [] },
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('an operator’s address', () => {
  test('is https outside a local Ledger, and http only on one', () => {
    expect(programAddressProblem('https://ledger.example.org', false)).toBeUndefined();
    expect(programAddressProblem('http://ledger.example.org', false)).toMatch(/must start with https/);
    expect(programAddressProblem('http://127.0.0.1:4000', true)).toBeUndefined();
    expect(programAddressProblem('ftp://ledger.example.org', true)).toMatch(/https:\/\//);
    expect(programAddressProblem('not an address', false)).toMatch(/full address/);
  });

  test('names no credential, query or fragment', () => {
    expect(programAddressProblem('https://someone:word@ledger.example.org', false)).toMatch(/name or password/);
    expect(programAddressProblem('https://ledger.example.org/?next=1', false)).toMatch(/without \?/);
  });

  test('is never this computer or a private network outside a local Ledger', () => {
    for (const address of [
      'https://localhost',
      'https://ledger.localhost',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://172.20.0.1',
      'https://192.168.1.10',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://0.0.0.0',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[fe80::1]',
      'https://[::ffff:10.0.0.1]',
    ])
      expect(programAddressProblem(address, false), address).toMatch(/private network/);
    for (const host of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:db8::1', 'ledger.example.org'])
      expect(privateAddressLiteral(host), host).toBe(false);
  });

  test('is read at its fixed path', () => {
    expect(programViewUrl('https://ledger.example.org/')).toBe('https://ledger.example.org/v1/program-view');
    expect(programViewUrl('https://example.org/ledger')).toBe('https://example.org/ledger/v1/program-view');
  });
});

describe('an operator’s answer', () => {
  test('is kept only when it is a program view document', () => {
    expect(programAnswerDocument(bytes(document))).toEqual(document);
    expect(programAnswerDocument(bytes({ ...document, version: 'ledger.program-view.2' }))).toBeNull();
    expect(programAnswerDocument(bytes({ ...document, subjects: ['RIDGE-AC-1'] }))).toBeNull();
    expect(programAnswerDocument(bytes({ ...document, operator: { name: 'Example', id: 'x' } }))).toBeNull();
    expect(programAnswerDocument(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('an operator’s row', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  const answered = (readAt: string) => ({ readAt, outcome: 'answered' as const });

  test('says when it was not read, read lately, read long ago, failed or ended', () => {
    expect(programOperatorState(null, null, now)).toBe('not_read');
    expect(programOperatorState(answered('2026-11-20T11:30:00.000Z'), { document }, now)).toBe('read');
    expect(programOperatorState(answered('2026-11-20T09:30:00.000Z'), { document }, now)).toBe('late');
    expect(programOperatorState({ readAt: '2026-11-20T11:30:00.000Z', outcome: 'failed' }, { document }, now)).toBe(
      'failed',
    );
    expect(programOperatorState({ readAt: '2026-11-20T11:30:00.000Z', outcome: 'not_in_use' }, { document }, now)).toBe(
      'ended',
    );
    const expired = { document: { grantExpiresAt: '2026-11-20T11:00:00.000Z' } };
    expect(programOperatorState(answered('2026-11-20T10:30:00.000Z'), expired, now)).toBe('ended');
  });
});

describe('a link a grant makes', () => {
  test('has a link’s own form, derived from the grant’s secret and the link', () => {
    const secret = `ledger-program-${'a'.repeat(43)}`;
    const first = grantLinkSecret(secret, 'record-link-1');
    expect(first).toMatch(new RegExp(RECORD_LINK_SECRET_PATTERN));
    expect(grantLinkSecret(secret, 'record-link-1')).toBe(first);
    expect(grantLinkSecret(secret, 'record-link-2')).not.toBe(first);
    expect(grantLinkSecret(`ledger-program-${'b'.repeat(43)}`, 'record-link-1')).not.toBe(first);
  });
});
