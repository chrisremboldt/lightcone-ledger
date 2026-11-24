import { parseArgs } from 'node:util';
import {
  capabilityValues,
  type Capability,
  type IssuedCredential,
  type ObservationGrant,
  type PersonAddCommand,
} from '@ledger/contracts';
import { addPerson, issueCredential } from '@ledger/domain';
import type { AuthContext, Pool, PoolClient } from '@ledger/persistence';

export interface CredentialSetupOptions {
  tenantId: string;
  /** The source's or service's id, or its exact name. */
  principal: string;
  label: string;
  expiresAt?: string;
  /** Adds the source or service when none has that name. */
  add?: { kind: 'source' | 'service'; capabilities: Capability[]; observationGrants: ObservationGrant[] };
  /** The administrator the issue is recorded under; by default the organization's first administrator. */
  by?: string;
}

export const credentialSetupUsage = `Usage: pnpm credential:issue --organization <organization id> --for <source or service> --label <what it is for>
       [--expires <ISO 8601 time>] [--by <administrator id>]
       [--add source|service [--capability <capability>]... [--grant <source id>:<observation type>]...]

  --organization  The organization's id, as pnpm org:create printed it (tenant-...).
  --for           The source or service, by its id or its exact name.
  --label         What the credential is for, in words you will recognise when you revoke it.
  --expires       When the credential stops being accepted, for example 2027-06-30T00:00:00Z. Default: until revoked.
  --by            The administrator the issue is recorded under. Default: the organization's first administrator.
  --add           Add the source or service first when none has that name, with the capabilities and observation
                  grants given. The addition is recorded under the same administrator.

The secret is printed once and never again; Ledger keeps only its hash. Later credentials are issued, listed and
revoked on the People screen, under "Sources and services".`;

export function parseCredentialSetup(argv: string[]): CredentialSetupOptions {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      organization: { type: 'string' },
      for: { type: 'string' },
      label: { type: 'string' },
      expires: { type: 'string' },
      by: { type: 'string' },
      add: { type: 'string' },
      capability: { type: 'string', multiple: true },
      grant: { type: 'string', multiple: true },
    },
    strict: true,
    allowPositionals: false,
  });
  const tenantId = values.organization?.trim();
  const principal = values.for?.trim();
  const label = values.label?.trim();
  if (!tenantId || !principal || !label) throw new Error('--organization, --for and --label are required');
  if (label.length > 200 || principal.length > 200) throw new Error('--for and --label have at most 200 characters');
  let expiresAt: string | undefined;
  if (values.expires !== undefined) {
    const time = Date.parse(values.expires);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(values.expires) || !Number.isFinite(time))
      throw new Error('--expires is an ISO 8601 time, for example 2027-06-30T00:00:00Z');
    expiresAt = new Date(time).toISOString();
  }
  if (values.add === undefined && (values.capability?.length || values.grant?.length))
    throw new Error('--capability and --grant describe a source or service being added: pass --add');
  let add: CredentialSetupOptions['add'];
  if (values.add !== undefined) {
    if (values.add !== 'source' && values.add !== 'service') throw new Error('--add is source or service');
    const capabilities = [...new Set(values.capability ?? [])];
    const unknown = capabilities.find((value) => !(capabilityValues as readonly string[]).includes(value));
    if (unknown) throw new Error(`${unknown} is not a capability. Capabilities: ${capabilityValues.join(', ')}`);
    const observationGrants = [...new Set(values.grant ?? [])].map((value) => {
      const split = value.indexOf(':');
      if (split < 1 || split === value.length - 1)
        throw new Error('--grant is <source id>:<observation type>, for example mission-planner:link.status');
      return { sourceId: value.slice(0, split), observationType: value.slice(split + 1) };
    });
    add = { kind: values.add, capabilities: capabilities as Capability[], observationGrants };
  }
  return {
    tenantId,
    principal,
    label,
    ...(expiresAt ? { expiresAt } : {}),
    ...(add ? { add } : {}),
    ...(values.by?.trim() ? { by: values.by.trim() } : {}),
  };
}

export interface CredentialSetupResult {
  organization: string;
  principal: { id: string; name: string; kind: string; added: boolean };
  administrator: { id: string; name: string };
  credential: IssuedCredential;
  expiresAt?: string;
}

/** The administrator the command is recorded under, with the authority they hold now. */
export async function administrator(
  client: PoolClient,
  tenantId: string,
  by: string | undefined,
): Promise<AuthContext> {
  const id =
    by ??
    (
      await client.query<{ actor_id: string }>(
        `SELECT actor_id FROM command_records WHERE tenant_id=$1 AND kind='person.add'
         AND payload->>'firstAdministrator'='true' ORDER BY recorded_at LIMIT 1`,
        [tenantId],
      )
    ).rows[0]?.actor_id;
  if (!id) throw new Error(`The organization ${tenantId} has no first administrator. Is the id right?`);
  const row = (
    await client.query<{ name: string; kind: string; capabilities: string[]; revision: string; active: boolean }>(
      'SELECT name,kind,capabilities,revision,active FROM principals WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new Error(`${id} is not someone in the organization ${tenantId}`);
  if (row.kind !== 'human' || !row.active || !row.capabilities.includes('authority:write'))
    throw new Error(
      `${row.name} is not an active administrator who may manage people. Name one with --by, or issue the credential on the People screen.`,
    );
  return {
    id,
    tenantId,
    name: row.name,
    kind: 'human',
    capabilities: row.capabilities,
    revision: Number(row.revision),
  };
}

async function findPrincipal(
  client: PoolClient,
  tenantId: string,
  wanted: string,
): Promise<{ id: string; name: string; kind: string } | undefined> {
  const rows = (
    await client.query<{ id: string; name: string; kind: string }>(
      `SELECT id,name,kind FROM principals WHERE tenant_id=$1 AND kind IN ('source','service') AND (id=$2 OR name=$2)
       ORDER BY id`,
      [tenantId, wanted],
    )
  ).rows;
  const exact = rows.find((row) => row.id === wanted);
  if (exact) return exact;
  if (rows.length > 1)
    throw new Error(
      `More than one source or service is named ${wanted}: pass one id (${rows.map((row) => row.id).join(', ')})`,
    );
  return rows[0];
}

/**
 * Issues the first credential of a fresh deployment on the owner connection, as pnpm org:create creates the
 * organization: no one can yet act through the API. The issue is recorded under an administrator of the
 * organization with the authority they hold at that moment, exactly as the People screen records it.
 */
export async function setUpCredential(pool: Pool, options: CredentialSetupOptions): Promise<CredentialSetupResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [options.tenantId]);
    const organization = (
      await client.query<{ name: string }>('SELECT name FROM tenants WHERE id=$1', [options.tenantId])
    ).rows[0]?.name;
    if (!organization) throw new Error(`There is no organization ${options.tenantId}. pnpm org:create prints its id.`);
    const actor = await administrator(client, options.tenantId, options.by);
    await client.query("SELECT set_config('ledger.principal_id',$1,true)", [actor.id]);
    let principal = await findPrincipal(client, options.tenantId, options.principal);
    let added = false;
    if (!principal) {
      if (!options.add)
        throw new Error(
          `No source or service ${options.principal} is in ${organization}. Add it on the People screen, or pass --add source or --add service.`,
        );
      const command: PersonAddCommand = {
        kind: 'person.add',
        name: options.principal,
        principalKind: options.add.kind,
        capabilities: options.add.capabilities,
        ...(options.add.observationGrants.length ? { observationGrants: options.add.observationGrants } : {}),
      };
      const commandId = await addPerson(client, actor, command);
      const id = (
        await client.query<{ payload: { principalId: string } }>('SELECT payload FROM command_records WHERE id=$1', [
          commandId,
        ])
      ).rows[0]!.payload.principalId;
      principal = { id, name: options.principal, kind: options.add.kind };
      added = true;
    }
    const issued = await issueCredential(client, actor, {
      kind: 'credential.issue',
      principalId: principal.id,
      label: options.label,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    });
    await client.query('COMMIT');
    return {
      organization,
      principal: { ...principal, added },
      administrator: { id: actor.id, name: actor.name },
      credential: issued.credential,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** What the person running the script reads; the only place the secret ever appears. */
export function credentialReport(result: CredentialSetupResult): string {
  const kind = result.principal.kind === 'service' ? 'service' : 'source';
  return [
    ...(result.principal.added
      ? [`Added the ${kind} ${result.principal.name} (${result.principal.id}) to ${result.organization}.`]
      : []),
    `Issued credential ${result.credential.id} to the ${kind} ${result.principal.name}, recorded under ${result.administrator.name}.`,
    result.expiresAt ? `It is accepted until ${result.expiresAt}.` : 'It is accepted until it is revoked.',
    '',
    'The secret, shown only now. Ledger keeps only its hash:',
    '',
    `  ${result.credential.secret}`,
    '',
    `The ${kind} sends it as "Authorization: Bearer <secret>". Revoke it on the People screen, under "Sources and services".`,
  ].join('\n');
}
