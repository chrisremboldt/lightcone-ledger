import { parseArgs } from 'node:util';
import type { DevelopmentTokenResponse } from '@ledger/contracts/development-tokens';
import { issueDevelopmentToken } from '@ledger/domain';
import type { Pool, PoolClient } from '@ledger/persistence';
import { administrator } from './credential-setup.js';
import type { SetupEnvironment } from './organization-setup.js';

export interface DevelopmentTokenSetupOptions {
  tenantId: string;
  /** The person's id, or their exact name. */
  person: string;
  /** The administrator the issue is recorded under; by default the organization's first administrator. */
  by?: string;
}

export const developmentTokenSetupUsage = `Usage: pnpm development-token:issue --organization <organization id> --for <person> [--by <administrator id>]

  --organization  The organization's id, as pnpm org:create printed it (tenant-...).
  --for           The person, by their id or their exact name.
  --by            The administrator the issue is recorded under. Default: the organization's first administrator.

For a local or test database only. It prints a new development token for the person, once; Ledger keeps only its
hash. The person's earlier token stops working at once. Use it when a token is lost, the administrator's own
included; otherwise an administrator issues tokens on the People screen. Outside local and test a person signs in
through the identity provider, and this command refuses.`;

export function parseDevelopmentTokenSetup(argv: string[]): DevelopmentTokenSetupOptions {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      organization: { type: 'string' },
      for: { type: 'string' },
      by: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const tenantId = values.organization?.trim();
  const person = values.for?.trim();
  if (!tenantId || !person) throw new Error('--organization and --for are required');
  if (person.length > 200) throw new Error('--for has at most 200 characters');
  return { tenantId, person, ...(values.by?.trim() ? { by: values.by.trim() } : {}) };
}

export interface DevelopmentTokenSetupResult {
  organization: string;
  person: { id: string; name: string };
  administrator: { id: string; name: string };
  issued: DevelopmentTokenResponse;
}

async function findPerson(client: PoolClient, tenantId: string, wanted: string): Promise<{ id: string; name: string }> {
  const rows = (
    await client.query<{ id: string; name: string }>(
      `SELECT id,name FROM principals WHERE tenant_id=$1 AND kind='human' AND (id=$2 OR name=$2) ORDER BY id`,
      [tenantId, wanted],
    )
  ).rows;
  const exact = rows.find((row) => row.id === wanted);
  if (exact) return exact;
  if (rows.length > 1)
    throw new Error(`More than one person is named ${wanted}: pass one id (${rows.map((row) => row.id).join(', ')})`);
  if (!rows[0]) throw new Error(`No person ${wanted} is in the organization. The People screen lists everyone.`);
  return rows[0];
}

/**
 * Issues a person's development token on the owner connection, for when no administrator can sign in to do it on the
 * People screen. The issue is recorded under an administrator, exactly as the People screen records it.
 */
export async function setUpDevelopmentToken(
  pool: Pool,
  options: DevelopmentTokenSetupOptions,
  environment: SetupEnvironment,
): Promise<DevelopmentTokenSetupResult> {
  if (environment === 'staging')
    throw new Error(
      'Development tokens are only for a local or test database. Here a person signs in through the identity provider: tie their account to them on the People screen.',
    );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [options.tenantId]);
    const organization = (
      await client.query<{ name: string }>('SELECT name FROM tenants WHERE id=$1', [options.tenantId])
    ).rows[0]?.name;
    if (!organization) throw new Error(`There is no organization ${options.tenantId}. pnpm org:create prints its id.`);
    const person = await findPerson(client, options.tenantId, options.person);
    const actor = await administrator(client, options.tenantId, options.by);
    await client.query("SELECT set_config('ledger.principal_id',$1,true)", [actor.id]);
    const issued = await issueDevelopmentToken(client, actor, person.id, true);
    await client.query('COMMIT');
    return { organization, person, administrator: { id: actor.id, name: actor.name }, issued };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** What the person running the script reads; the only place the token ever appears. */
export function developmentTokenReport(result: DevelopmentTokenSetupResult): string {
  const replaced = result.issued.replacedCredentialIds.length;
  return [
    `Issued a development token to ${result.person.name} (${result.person.id}) in ${result.organization}, recorded under ${result.administrator.name}.`,
    replaced
      ? `It replaces ${replaced === 1 ? 'their earlier token, which' : `their ${replaced} earlier tokens, which`} no longer works.`
      : 'They held no earlier token.',
    '',
    'The token, shown only now. Ledger keeps only its hash:',
    '',
    `  ${result.issued.developmentToken.token}`,
    '',
    `With pnpm dev running, open http://localhost:${process.env.LEDGER_WEB_PORT || '5173'}, choose "Use a development token", and paste it. For the API`,
    'and pnpm ledger, send it as "Authorization: Bearer <token>".',
  ].join('\n');
}
