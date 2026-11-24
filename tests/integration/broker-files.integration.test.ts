import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { brokerFiles, brokerOrganizations, BROKER_FILES_PATH } from '../../apps/api/src/broker-files.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import { createPool } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Broker accounts from the sources on record', () => {
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  afterAll(async () => {
    await settleOwnedWork([`tenant-broker-${run}`]);
    await admin.end();
  });

  async function organization(suffix: string) {
    const setup = parseOrganizationSetup([
      '--name',
      `Fictional Broker Works ${suffix}`,
      '--time-zone',
      'UTC',
      '--admin',
      'Robin Vale',
      '--id',
      `broker-${run}-${suffix}`,
    ]);
    await setUpOrganization(admin, setup, 'local');
    return setup.tenantId;
  }
  async function principal(tenantId: string, id: string, kind: string, active = true) {
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities,active) VALUES($1,$2,$3,$4,$5,$6)', [
      id,
      tenantId,
      `Fictional ${kind}`,
      kind,
      ['input:write'],
      active,
    ]);
  }

  it('gives each active source of each named organization an account on its own listener, and nothing else', async () => {
    const first = await organization('first');
    const second = await organization('second');
    await principal(first, `source-${run}-a`, 'source');
    await principal(first, `source-${run}-inactive`, 'source', false);
    await principal(first, `service-${run}`, 'service');
    await principal(second, `source-${run}-b`, 'source');

    const { organizations, unheard } = await brokerOrganizations(
      admin,
      new Map([
        [first, 1883],
        [second, 1884],
      ]),
    );
    expect(organizations).toEqual([
      {
        id: first,
        name: 'Fictional Broker Works first',
        port: 1883,
        sources: [`source-${run}-a`],
        sourceNames: { [`source-${run}-a`]: 'Fictional source' },
      },
      {
        id: second,
        name: 'Fictional Broker Works second',
        port: 1884,
        sources: [`source-${run}-b`],
        sourceNames: { [`source-${run}-b`]: 'Fictional source' },
      },
    ]);
    expect(unheard).toContain('tenant-alpha');
    const { files } = brokerFiles(organizations, {
      brokerPath: BROKER_FILES_PATH,
      developmentPasswords: true,
      existing: new Map(),
    });
    expect(files[`acl-${first}`]).toContain(`user source-${run}-a\n`);
    expect(files[`acl-${first}`]).not.toContain(`source-${run}-b`);
    expect(files[`passwords-${second}`]).toMatch(new RegExp(`^source-${run}-b:\\$7\\$101\\$`));

    await expect(brokerOrganizations(admin, new Map())).rejects.toThrow('Name each one that uses the broker');
    await expect(brokerOrganizations(admin, new Map([[`tenant-broker-${run}-missing`, 1883]]))).rejects.toThrow(
      'There is no organization',
    );
  });
});
