import { parseArgs } from 'node:util';
import { sha256 } from '@ledger/integrity';
import type { Pool } from '@ledger/persistence';
import {
  createOrganization,
  newDevelopmentToken,
  validTimeZone,
  type OrganizationCreationResult,
  type SignInIdentity,
} from '@ledger/domain';

export interface OrganizationSetupOptions {
  tenantId: string;
  name: string;
  timeZone: string;
  administratorName: string;
  signIn?: SignInIdentity;
}
export type SetupEnvironment = 'local' | 'test' | 'staging';

export const organizationSetupUsage = `Usage: pnpm org:create --name <organization> --time-zone <IANA zone> --admin <administrator's name>
       [--id <short id>] [--sign-in-issuer <issuer URL> --sign-in-subject <subject>]

  --name             The organization's name.
  --time-zone        Its IANA time zone, for example America/Denver or Europe/Berlin. Every screen shows times in it.
  --admin            The first administrator's full name.
  --id               A short id of lowercase letters, digits and dashes. Defaults to one made from the name.
  --sign-in-issuer   The OpenID Connect issuer the administrator signs in through: exactly one of the issuers in
                     LEDGER_OIDC_ISSUER or LEDGER_OIDC_ISSUERS, the same setting the API reads.
  --sign-in-subject  The administrator's subject at that issuer: the sub claim of their tokens, their user id there.

The sign-in pair is required outside local and test environments. Without it, on a local or test database, the
administrator gets a development token instead.`;

/** The environment as the API decides it, so the script ties the administrator to what the API will accept. */
export function setupEnvironment(env: NodeJS.ProcessEnv = process.env): SetupEnvironment {
  const value = env.LEDGER_ENV ?? (env.NODE_ENV === 'production' ? 'staging' : 'local');
  if (value !== 'local' && value !== 'test' && value !== 'staging')
    throw new Error('LEDGER_ENV must be local, test or staging');
  if (value !== 'staging' && env.NODE_ENV === 'production')
    throw new Error('A production process runs with LEDGER_ENV=staging');
  return value;
}

function organizationId(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

export function parseOrganizationSetup(argv: string[]): OrganizationSetupOptions {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      name: { type: 'string' },
      'time-zone': { type: 'string' },
      admin: { type: 'string' },
      id: { type: 'string' },
      'sign-in-issuer': { type: 'string' },
      'sign-in-subject': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const name = values.name?.trim();
  const timeZone = values['time-zone']?.trim();
  const administratorName = values.admin?.trim();
  if (!name || !timeZone || !administratorName) throw new Error('--name, --time-zone and --admin are required');
  if (name.length > 200 || administratorName.length > 200) throw new Error('A name has at most 200 characters');
  if (!validTimeZone(timeZone)) throw new Error(`${timeZone} is not an IANA time zone name`);
  const id = values.id?.trim() ?? organizationId(name);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || id.length > 60)
    throw new Error('--id is lowercase letters and digits, with single dashes between them, at most 60 characters');
  const issuer = values['sign-in-issuer']?.trim();
  const subject = values['sign-in-subject']?.trim();
  if (Boolean(issuer) !== Boolean(subject)) throw new Error('--sign-in-issuer and --sign-in-subject go together');
  if (issuer && (!/^https?:\/\/\S+$/.test(issuer) || issuer.length > 500))
    throw new Error('--sign-in-issuer is the URL the identity provider puts in the iss claim of its tokens');
  if (subject && subject.length > 200) throw new Error('--sign-in-subject has at most 200 characters');
  return {
    tenantId: `tenant-${id}`,
    name,
    timeZone,
    administratorName,
    ...(issuer && subject ? { signIn: { issuer, subject } } : {}),
  };
}

export type OrganizationSetupResult = OrganizationCreationResult & { developmentToken?: string };

/** Creates the organization once on the owner connection. A second run finds it and changes nothing. */
export async function setUpOrganization(
  pool: Pool,
  options: OrganizationSetupOptions,
  environment: SetupEnvironment,
  acceptedIssuers: readonly string[],
): Promise<OrganizationSetupResult> {
  if (environment === 'staging' && !options.signIn)
    throw new Error(
      'Outside local and test the administrator signs in through the identity provider: pass --sign-in-issuer and --sign-in-subject',
    );
  if (options.signIn && !acceptedIssuers.includes(options.signIn.issuer))
    throw new Error(
      [
        `The API does not accept sign-in from ${options.signIn.issuer}, so the administrator could never sign in.`,
        acceptedIssuers.length
          ? `It accepts: ${acceptedIssuers.join(', ')}. Pass one of those, or add this one to LEDGER_OIDC_ISSUERS.`
          : 'No issuer is configured: set LEDGER_OIDC_ISSUER and LEDGER_OIDC_CLIENT_ID (or LEDGER_OIDC_ISSUERS) for org:create and the API alike.',
      ].join(' '),
    );
  const migrated = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tenants' AND column_name='time_zone'",
  );
  if (!migrated.rowCount) throw new Error('The database is not migrated: run pnpm db:migrate first');
  const developmentToken = options.signIn ? undefined : newDevelopmentToken();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await createOrganization(client, {
      tenantId: options.tenantId,
      name: options.name,
      timeZone: options.timeZone,
      administrator: { name: options.administratorName, ...(options.signIn ? { signIn: options.signIn } : {}) },
      ...(developmentToken ? { developmentTokenHash: sha256(developmentToken) } : {}),
    });
    await client.query('COMMIT');
    return result.created && developmentToken ? { ...result, developmentToken } : result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** What the person running the script reads: what happened and exactly how the administrator signs in. */
export function setupReport(options: OrganizationSetupOptions, result: OrganizationSetupResult): string {
  const organization = `${result.organization.name} (${result.organization.id}, ${result.organization.timeZone})`;
  if (!result.created)
    return [
      `The organization ${organization} already exists. Nothing was changed.`,
      'Its administrators add and change people on the People screen. A development token is shown only once.',
      `On a local or test database a lost token is replaced with: pnpm development-token:issue --organization ${result.organization.id} --for "<the person's name>"`,
    ].join('\n');
  const lines = [
    `Created ${organization}.`,
    `Its first administrator is ${options.administratorName} (${result.administratorId}).`,
    '',
  ];
  if (result.developmentToken)
    lines.push(
      'This is a local or test database, so the administrator signs in with a development token, shown only now:',
      '',
      `  ${result.developmentToken}`,
      '',
      `With pnpm dev running, open http://localhost:${process.env.LEDGER_WEB_PORT || '5173'}, choose "Use a development token", and paste it.`,
      'For the API, send it as "Authorization: Bearer <token>". The API refuses development tokens outside local and test.',
      '',
      'Each person you add signs in the same way: on the People screen, choose the person and "Issue a development',
      'token". Development tokens are for a trial on a computer that faces no network; real use by several people',
      "needs sign-in through an identity provider (the deployment guide's section on sign-in).",
    );
  else
    lines.push(
      `${options.administratorName} signs in through ${options.signIn!.issuer} as subject ${options.signIn!.subject}.`,
      'Open the web app, sign in with that account, and choose People to add the rest of the organization. Each person',
      'needs their own account at the provider; the People screen asks for its subject (their user id there).',
    );
  lines.push(
    '',
    'Next: add people on the People screen, adopt rule packs on the Rules screen, and import records on the Records screen.',
  );
  return lines.join('\n');
}
