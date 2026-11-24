import { randomUUID } from 'node:crypto';
import type { SmsHomeResponse, SmsRecordDraft, SmsSigningPreviewResponse } from '@ledger/contracts';
import { exampleRiskMatrix } from '@ledger/domain';
import { seededOrganizations } from '@ledger/persistence';
import type { createApp } from './index.js';

type App = Awaited<ReturnType<typeof createApp>>;

export interface MatrixSeedPeople {
  /** Opens the draft and owns the record; needs sms:configure. */
  drafter: { id: string; token: string };
  /** Signs the adoption after a local fixture re-authentication; needs sms:adopt. */
  adopter: { token: string };
  note: string;
}

export function exampleMatrixDraft(ownerId: string): SmsRecordDraft {
  return {
    kind: 'risk_matrix',
    schema: 'sms.risk-matrix.1',
    title: 'Program safety risk matrix',
    ownerId,
    body: exampleRiskMatrix,
  };
}

/**
 * Opens the example matrix and adopts it with a signature through the same commands a person uses.
 * Returns false when the organization already has an adopted matrix.
 */
export async function adoptExampleRiskMatrix(app: App, people: MatrixSeedPeople): Promise<boolean> {
  const call = async <T>(token: string, method: 'GET' | 'POST', url: string, payload?: object, headers = {}) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300) throw new Error(`Seed request ${method} ${url} failed: ${response.body}`);
    return response.json() as T;
  };
  const home = await call<SmsHomeResponse>(people.adopter.token, 'GET', '/v1/sms/home');
  if (home.program.active) return false;
  const opened = await call<{ command: { subject: { id: string } } }>(people.drafter.token, 'POST', '/v1/commands', {
    kind: 'sms.record.open',
    record: exampleMatrixDraft(people.drafter.id),
  });
  const matrixId = opened.command.subject.id;
  const shown = await call<SmsSigningPreviewResponse>(
    people.adopter.token,
    'GET',
    `/v1/sms/records/${matrixId}/signing?meaning=matrix.adopt`,
  );
  if (!shown.available) throw new Error(`The example matrix cannot be adopted: ${shown.reason}`);
  const { grant } = await call<{ grant: string }>(people.adopter.token, 'POST', '/v1/local/reauthentications', {
    credential: people.adopter.token,
  });
  await call(
    people.adopter.token,
    'POST',
    '/v1/commands',
    {
      kind: 'decision.record',
      subject: { kind: 'sms', id: matrixId },
      expectedRevision: shown.basis.revision,
      expectedDependencyBasis: shown.basis.dependencyBasis,
      decision: {
        kind: 'matrix.adopt',
        note: people.note,
        versionNumber: 1,
        signature: { intent: shown.intent, contentDigest: shown.contentDigest, reviewed: true },
      },
    },
    { 'x-ledger-reauthentication': grant },
  );
  return true;
}

/** Each seeded flight organization's operator opens and adopts the example matrix. Returns the tenants adopted now. */
export async function adoptSeededRiskMatrices(app: App): Promise<string[]> {
  const adopted: string[] = [];
  for (const name of seededOrganizations) {
    const operator = { id: `principal-${name}-operator`, token: `ledger-dev-${name}-operator` };
    const note = 'Adopted as the starting matrix for the fictional flight organization.';
    if (await adoptExampleRiskMatrix(app, { drafter: operator, adopter: operator, note }))
      adopted.push(`tenant-${name}`);
  }
  return adopted;
}
