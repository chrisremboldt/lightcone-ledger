import { lstat, mkdir } from 'node:fs/promises';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function directory(path: string, create: boolean): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return false;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    metadata = await lstat(path);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (path !== '/data' && (metadata.mode & 0o777) !== 0o700))
    throw new Error('Hosted SMS ancestors must be private regular directories');
  return true;
}

export async function ensureHostedSmsRoot(path: string, create = false): Promise<boolean> {
  if (!/^\/data\/ledger\/world\/sms\/[A-Za-z0-9-]{1,30}$/.test(path))
    throw new Error('Hosted SMS requires its exact named root');
  for (const ancestor of ['/data', '/data/ledger', '/data/ledger/world'])
    if (!(await directory(ancestor, false))) throw new Error('Hosted SMS persistent ancestors must already exist');
  if (!(await directory('/data/ledger/world/sms', create))) return false;
  return directory(path, create);
}

export async function ensureHostedSmsPhase(path: string): Promise<void> {
  const match = /^(\/data\/ledger\/world\/sms\/[A-Za-z0-9-]{1,30})\/(incident|followup)$/.exec(path);
  if (!match) throw new Error('Hosted SMS requires its exact named phase directory');
  await ensureHostedSmsRoot(match[1]!, true);
  await directory(path, true);
}
