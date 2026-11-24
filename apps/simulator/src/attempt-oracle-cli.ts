import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditAttemptJournal, type OracleResult } from './attempt-oracle.js';
import { auditCommandLinkJournal, type CommandLinkOracleResult } from './command-link-oracle.js';
import { OracleApi } from './oracle-api.js';

const maxJournalBytes = 8 * 1024 * 1024;
const exitStatus = { match: 0, mismatch: 1, pending: 2, unverifiable: 3 } as const;

interface OracleCliFailure {
  status: 'unverifiable';
  kind?: 'command-link';
  attemptId?: string;
  tenant?: 'alpha' | 'beta';
  issues: Array<{ status: 'unverifiable'; code: string; reason: string }>;
  usage: { requests: number; bytes: number };
}

class OracleCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new OracleCliError('configuration_missing', `${name} is required`);
  return value;
}

async function readJournal(path: string): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new OracleCliError('journal_not_regular', 'The attempt journal must be a regular file');
    if (stat.size > maxJournalBytes) throw new OracleCliError('journal_too_large', 'The attempt journal exceeds 8 MiB');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxJournalBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxJournalBytes) throw new OracleCliError('journal_too_large', 'The attempt journal exceeds 8 MiB');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

export async function runAttemptOracle(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OracleResult | CommandLinkOracleResult | OracleCliFailure> {
  let kind: 'landing' | 'command-link' = 'landing';
  let attemptId: string | undefined;
  let tenant: 'alpha' | 'beta' | undefined;
  let api: OracleApi | undefined;
  let stage: 'configuration' | 'journal' | 'audit' = 'configuration';
  let result: OracleResult | CommandLinkOracleResult | OracleCliFailure;
  try {
    const selectedKind = env.SIMULATOR_ORACLE_KIND ?? 'landing';
    if (selectedKind !== 'landing' && selectedKind !== 'command-link')
      throw new OracleCliError('kind_invalid', 'SIMULATOR_ORACLE_KIND must be landing or command-link');
    kind = selectedKind;
    const statePath = resolve(required(env, 'SIMULATOR_WORLD_STATE'));
    attemptId = required(env, 'SIMULATOR_ORACLE_ATTEMPT');
    const requestedTenant = required(env, 'SIMULATOR_ORACLE_TENANT');
    if (requestedTenant !== 'alpha' && requestedTenant !== 'beta')
      throw new OracleCliError('tenant_invalid', 'SIMULATOR_ORACLE_TENANT must be alpha or beta');
    tenant = requestedTenant;
    const apiUrl = required(env, 'LEDGER_API_URL');
    const token = required(env, 'SIMULATOR_ORACLE_TOKEN');
    if (/[\r\n]/.test(token))
      throw new OracleCliError('credential_invalid', 'SIMULATOR_ORACLE_TOKEN must be a bearer credential');
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      throw new OracleCliError('api_url_invalid', 'LEDGER_API_URL must be an absolute HTTP or HTTPS URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new OracleCliError(
        'api_url_invalid',
        'LEDGER_API_URL must be an HTTP or HTTPS origin without credentials, query or fragment',
      );
    stage = 'journal';
    const journalName = createHash('sha256').update(attemptId).digest('hex');
    const directory = kind === 'command-link' ? 'command-link' : 'delivery';
    const raw = await readJournal(`${statePath}.delivery/${directory}/${journalName}.json`);
    stage = 'audit';
    api = new OracleApi(apiUrl, token, {
      requests: 256,
      bytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      requestTimeoutMs: 5_000,
    });
    result =
      kind === 'command-link'
        ? await auditCommandLinkJournal(raw, { attemptId, tenant, apiUrl }, api)
        : await auditAttemptJournal(raw, { attemptId, tenant, apiUrl }, api);
  } catch (error) {
    const failure =
      error instanceof OracleCliError
        ? error
        : stage === 'journal'
          ? new OracleCliError('journal_unreadable', 'The attempt journal could not be read as a bounded regular file')
          : new OracleCliError('audit_unavailable', 'The attempt audit could not be completed');
    result = {
      status: 'unverifiable',
      ...(kind === 'command-link' ? { kind } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(tenant ? { tenant } : {}),
      issues: [{ status: 'unverifiable', code: failure.code, reason: failure.message }],
      usage: api?.usage() ?? { requests: 0, bytes: 0 },
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runAttemptOracle();
  process.exitCode = exitStatus[result.status];
}
