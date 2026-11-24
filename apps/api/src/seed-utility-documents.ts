import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  SmsBasis,
  SmsRecordDetailResponse,
  SmsRegisterResponse,
  SmsSigningPreviewResponse,
} from '@ledger/contracts';
import { createApp } from './index.js';
import {
  exampleDocument,
  exampleLabels,
  exampleNumber,
  examplePdfUrl,
  exampleTitle,
} from './utility-document-example.js';

if (!['local', 'test'].includes(process.env.LEDGER_ENV ?? '') || process.env.NODE_ENV === 'production')
  throw new Error('The fictional document example is for isolated local and test databases only');

function requireLoopbackUrl(name: string, value: string | undefined, protocols: string[]) {
  if (!value) throw new Error(`${name} is required for the fictional local document example`);
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(`${name} must point to a loopback service for the fictional local document example`);
  return url;
}

for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
  const value = process.env[name];
  if (name === 'DATABASE_ADMIN_URL' && !value) continue;
  const url = requireLoopbackUrl(name, value, ['postgres:', 'postgresql:']);
  if (!['/ledger', '/ledger_test'].includes(url.pathname) || url.search)
    throw new Error(`${name} must identify the local ledger or ledger_test database without connection overrides`);
}
if (process.env.OBJECT_STORE === 's3' || process.env.OBJECT_STORAGE_BACKEND === 's3')
  requireLoopbackUrl('S3_ENDPOINT', process.env.S3_ENDPOINT, ['http:', 'https:']);

const files = await Promise.all([readFile(examplePdfUrl(4)), readFile(examplePdfUrl(5))]);
const app = await createApp({ env: 'local' });
type Role = 'safety' | 'executive';
async function call<T>(
  role: Role,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers = {},
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ledger-dev-utility-${role}`, 'idempotency-key': randomUUID(), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  if (response.statusCode >= 300) throw new Error(`${method} ${url} failed: ${response.body}`);
  return response.json() as T;
}
async function detail(id: string, role: Role = 'safety'): Promise<SmsRecordDetailResponse> {
  return call(role, 'GET', `/v1/sms/records/${id}`);
}
async function command(role: Role, payload: object, headers = {}): Promise<{ id: string; subject: { id: string } }> {
  const result = await call<{ command: { id: string; subject: { id: string } } }>(
    role,
    'POST',
    '/v1/commands',
    payload,
    headers,
  );
  return result.command;
}
function decision(id: string, basis: SmsBasis, input: object) {
  return {
    kind: 'decision.record',
    subject: { kind: 'sms', id },
    expectedRevision: basis.revision,
    expectedDependencyBasis: basis.dependencyBasis,
    decision: input,
  };
}
async function attach(id: string, revision: 4 | 5, bytes: Buffer): Promise<string> {
  const created = await call<{ upload: { id: string } }>('safety', 'POST', '/v1/uploads', {
    contentType: 'application/pdf',
    byteLength: bytes.length,
    filename: `aircraft-inspection-manual-revision-${revision}.pdf`,
    confidentiality: 'ordinary',
  });
  const uploadId = created.upload.id;
  await call('safety', 'PUT', `/v1/uploads/${uploadId}/content`, bytes, { 'content-type': 'application/octet-stream' });
  await call('safety', 'POST', `/v1/uploads/${uploadId}/finalize`);
  const current = await detail(id);
  const attached = await command('safety', {
    kind: 'sms.attachment.add',
    recordId: id,
    expectedRevision: current.basis.revision,
    attachment: { uploadId, label: exampleLabels[revision] },
  });
  return attached.id;
}

try {
  await app.ready();
  const register = await call<SmsRegisterResponse>('safety', 'GET', '/v1/sms/records?kind=document');
  const matches = register.records.filter(
    (record) => record.title === exampleTitle || record.document?.documentNumber === exampleNumber,
  );
  if (matches.length) {
    if (
      matches.length !== 1 ||
      matches[0].title !== exampleTitle ||
      matches[0].document?.documentNumber !== exampleNumber
    )
      throw new Error('A document has the example title or number; inspect it before preparing the example.');
    const existing = await detail(matches[0].id);
    if (existing.versions.length < 2 || existing.attachments.length < 2 || !existing.documentControl?.issues.length)
      throw new Error(
        'The example is incomplete. Inspect the existing record before continuing; no duplicate was created.',
      );
    console.log('Fictional document example already exists; retained without changes.');
  } else {
    const opened = await command('safety', {
      kind: 'sms.record.open',
      record: exampleDocument('principal-utility-safety', 4),
    });
    const id = opened.subject.id;
    const fileId = await attach(id, 4, files[0]);
    let shown = await detail(id);
    await command(
      'safety',
      decision(id, shown.basis, {
        kind: 'document.review',
        versionNumber: 1,
        attachmentIds: [fileId],
        note: 'Reviewed the manufacturer instructions for the fictional inspection fleet.',
      }),
    );
    const preview = await call<SmsSigningPreviewResponse>(
      'executive',
      'GET',
      `/v1/sms/records/${id}/signing?meaning=document.adopt`,
    );
    if (!preview.available || !preview.intent || !preview.contentDigest)
      throw new Error('The fixture adoption preview is unavailable.');
    const { grant } = await call<{ grant: string }>('executive', 'POST', '/v1/local/reauthentications', {
      credential: 'ledger-dev-utility-executive',
    });
    const adopted = await command(
      'executive',
      decision(id, preview.basis, {
        kind: 'document.adopt',
        versionNumber: 1,
        note: 'Adopted for the fictional inspection fleet.',
        signature: { intent: preview.intent, contentDigest: preview.contentDigest, reviewed: true },
      }),
      { 'x-ledger-reauthentication': grant },
    );
    shown = await detail(id);
    await command(
      'safety',
      decision(id, shown.basis, {
        kind: 'document.issue',
        versionNumber: 1,
        adoptionId: adopted.id,
        recipientIds: ['principal-utility-pilot'],
        acknowledgementDueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        note: 'Issued to the fictional inspection pilot.',
      }),
    );
    shown = await detail(id);
    await command('safety', {
      kind: 'sms.record.revise',
      recordId: id,
      expectedRevision: shown.basis.revision,
      record: exampleDocument('principal-utility-safety', 5),
    });
    await attach(id, 5, files[1]);
    console.log('Fictional manual prepared: Revision 4 in force, Revision 5 awaiting review.');
  }
} finally {
  await app.close();
}
