import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { OPERATOR_RECORD_SOURCE_ID, type Capability } from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';
import { createPool, SEEDED_TIME_ZONE } from '@ledger/persistence';
import { createApp } from './index.js';
import { adoptExampleRiskMatrix } from './seed-risk-matrix.js';
import { utilityPolicyDraft } from './utility-drafts.js';

if (process.env.LEDGER_ENV === 'staging' || process.env.NODE_ENV === 'production')
  throw new Error('The fictional utility seed is for isolated local and test databases only');

const UTILITY_TENANT = 'tenant-utility';
// keepsOperatorRecords: may import and enter operator records under the conventional operator-records source.
const people: { role: string; name: string; capabilities: Capability[]; keepsOperatorRecords?: boolean }[] = [
  {
    role: 'safety',
    name: 'Avery Chen',
    keepsOperatorRecords: true,
    capabilities: [
      'sms:read',
      'sms:write',
      'sms:configure',
      'sms:report:read',
      'sms:restricted:read',
      'decision:write',
      'evidence:read',
      'input:write',
      'risk:accept:low',
      'risk:accept:medium',
    ],
  },
  {
    role: 'executive',
    name: 'Morgan Ellis',
    capabilities: [
      'sms:read',
      'sms:adopt',
      'sms:restricted:read',
      'decision:write',
      'evidence:read',
      'risk:accept:low',
      'risk:accept:medium',
      'risk:accept:high',
    ],
  },
  { role: 'pilot', name: 'Jordan Reyes', capabilities: ['sms:read', 'input:write', 'evidence:read'] },
];

const admin = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO tenants(id,name,time_zone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
      UTILITY_TENANT,
      'Fictional Valley Power',
      SEEDED_TIME_ZONE,
    ]);
    for (const person of people) {
      const id = `principal-utility-${person.role}`;
      await client.query(
        `INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)
         ON CONFLICT(id) DO UPDATE SET capabilities=EXCLUDED.capabilities,revision=principals.revision+1
         WHERE principals.capabilities IS DISTINCT FROM EXCLUDED.capabilities`,
        [id, UTILITY_TENANT, person.name, person.capabilities],
      );
      await client.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        sha256(`ledger-dev-utility-${person.role}`),
        id,
      ]);
      if (person.keepsOperatorRecords)
        await client.query(
          `INSERT INTO observation_grants(tenant_id,principal_id,source_id,observation_type)
           VALUES($1,$2,$3,'operator.record') ON CONFLICT DO NOTHING`,
          [UTILITY_TENANT, id, OPERATOR_RECORD_SOURCE_ID],
        );
    }
    await client.query(
      `INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES('principal-utility-worker',$1,'Utility worker','worker',$2)
       ON CONFLICT DO NOTHING`,
      [UTILITY_TENANT, ['input:write', 'flight:create', 'flight:read', 'evidence:read']],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await admin.end();
}

const app = await createApp({ env: 'local' });
const call = async (role: string, method: 'GET' | 'POST', url: string, payload?: object, headers = {}) => {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ledger-dev-utility-${role}`, 'idempotency-key': randomUUID(), ...headers },
    ...(payload ? { payload } : {}),
  });
  if (response.statusCode >= 300) throw new Error(`Seed request ${method} ${url} failed: ${response.body}`);
  return response.json();
};
try {
  await app.ready();
  const adopted = await adoptExampleRiskMatrix(app, {
    drafter: { id: 'principal-utility-safety', token: 'ledger-dev-utility-safety' },
    adopter: { token: 'ledger-dev-utility-executive' },
    note: 'Adopted as the starting matrix for the fictional utility program.',
  });
  console.log(
    adopted
      ? 'Seeded the fictional utility tenant and adopted its 5×5 risk matrix'
      : 'Fictional utility tenant already has an adopted risk matrix',
  );
  const documents = await call('safety', 'GET', '/v1/sms/records?kind=document');
  if (!documents.records.length) {
    await call('safety', 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: utilityPolicyDraft('principal-utility-safety'),
    });
    console.log('Drafted the fictional safety policy for adoption');
  }
} finally {
  await app.close();
}
