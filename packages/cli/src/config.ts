import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Where the API is and the credential the client sends. Never taken from a command-line argument. */
export interface Connection {
  apiUrl: string;
  token: string;
  /** Where the credential was read: the environment, or the file's path. */
  from: string;
}

export const CREDENTIALS_FILE = join('.ledger', 'credentials');

export class ConfigurationError extends Error {}

/** KEY=value lines; blank lines and lines starting with # are ignored. */
export function parseCredentialsFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split < 1) continue;
    values[trimmed.slice(0, split).trim()] = trimmed
      .slice(split + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** The nearest .ledger/credentials from each starting folder upward. */
export function findCredentialsFile(starts: readonly string[]): string | undefined {
  for (const start of starts) {
    let folder = resolve(start);
    for (;;) {
      const candidate = join(folder, CREDENTIALS_FILE);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  return undefined;
}

/**
 * LEDGER_API_URL and LEDGER_TOKEN from the environment win; anything missing is read from the nearest
 * .ledger/credentials above the folder the command was typed in, then above the checkout.
 */
export function readConnection(env: NodeJS.ProcessEnv, starts: readonly string[]): Connection {
  let apiUrl = env.LEDGER_API_URL?.trim();
  let token = env.LEDGER_TOKEN?.trim();
  let from = 'the environment';
  if (!apiUrl || !token) {
    const file = findCredentialsFile(starts);
    if (file) {
      const values = parseCredentialsFile(readFileSync(file, 'utf8'));
      apiUrl ||= values.LEDGER_API_URL;
      if (!token && values.LEDGER_TOKEN) {
        token = values.LEDGER_TOKEN;
        from = file;
      }
    }
  }
  apiUrl ||= 'http://127.0.0.1:4000';
  if (!token)
    throw new ConfigurationError(
      `No credential. Set LEDGER_TOKEN, or write LEDGER_TOKEN=<credential> in ${CREDENTIALS_FILE} (git-ignored). A credential is never given as an argument.`,
    );
  if (!/^https?:\/\//.test(apiUrl)) throw new ConfigurationError(`LEDGER_API_URL is not an http(s) address: ${apiUrl}`);
  return { apiUrl: apiUrl.replace(/\/$/, ''), token, from };
}
