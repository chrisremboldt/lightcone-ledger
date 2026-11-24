import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PACK_FILE_MAX_BYTES, PACK_FILE_SUFFIX, type PackFile, type RulePackVersion } from '@ledger/contracts';
import {
  getRulePackVersion,
  isRulePackRegistered,
  listRulePackVersions,
  registerRulePack,
} from '@ledger/domain/rule-pack-registry';
import { PackFileError, verifiedPackFile } from './pack-files.js';

/** One verified pack file: its name in the folder, its content and the pack version it makes. */
export interface LoadedPackFile {
  name: string;
  file: PackFile;
  version: RulePackVersion;
}

/** Reads and verifies one pack file; every refusal names the file and the reason. */
export function readPackFile(path: string, name = path): LoadedPackFile {
  try {
    const size = statSync(path).size;
    if (size > PACK_FILE_MAX_BYTES)
      throw new PackFileError(`It is ${size} bytes; a pack file holds at most ${PACK_FILE_MAX_BYTES}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new PackFileError(`It is not JSON: ${(error as Error).message}`);
    }
    return { name, ...verifiedPackFile(parsed) };
  } catch (error) {
    throw new PackFileError(`Pack file ${name} was refused. ${(error as Error).message}`);
  }
}

/** The reason a pack version from a file cannot join this process's registry, or undefined when it can. */
export function packFileCollision(packId: string, version: number, digest: string): string | undefined {
  if (!isRulePackRegistered(packId)) return undefined;
  const registered = getRulePackVersion(packId, version);
  if (registered?.digest === digest) return undefined;
  if (registered)
    return `Pack ${packId} version ${version} is already registered with different content (digest ${registered.digest})`;
  const builtIn = listRulePackVersions().some((item) => item.packId === packId && item.origin.kind === 'built_in');
  // The registry holds whole packs, so a registered pack does not gain a version from a file after startup.
  return builtIn
    ? `Pack id ${packId} is a pack built into Ledger; give your pack its own id`
    : `Pack ${packId} is already registered without version ${version}; restart Ledger to load it`;
}

/**
 * Reads and verifies every *.pack.json in a folder, in name order. The same pack version in two files is read once,
 * under the first file's name. Throws, naming the file, on the first file refused or on two files that state
 * different content for one pack id and version.
 */
export function readPackFolder(folder: string): LoadedPackFile[] {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    throw new PackFileError(`The pack folder ${folder} cannot be read: ${(error as Error).message}`);
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(PACK_FILE_SUFFIX))
    .map((entry) => entry.name)
    .sort();
  const kept = new Map<string, LoadedPackFile>();
  for (const name of names) {
    const loaded = readPackFile(join(folder, name), name);
    const key = `${loaded.version.packId}@${loaded.version.version}`;
    const earlier = kept.get(key);
    if (earlier && earlier.version.digest !== loaded.version.digest)
      throw new PackFileError(
        `Pack file ${name} was refused. It states pack ${loaded.version.packId} version ${loaded.version.version}, which ${earlier.name} also states with different content`,
      );
    if (earlier) continue;
    const collision = packFileCollision(loaded.version.packId, loaded.version.version, loaded.version.digest);
    if (collision) throw new PackFileError(`Pack file ${name} was refused. ${collision}`);
    kept.set(key, loaded);
  }
  return [...kept.values()];
}

/**
 * Registers every pack file in the folder LEDGER_PACKS_DIR names, through the same registry path a built-in pack
 * takes. Call it after the built-in packs are registered. An unset or empty folder name loads nothing. Every file
 * is verified before any is registered, so a refused file leaves the registry as it was. Loading the same files
 * again is not an error.
 */
export function registerPackFolder(folder: string | undefined): LoadedPackFile[] {
  if (!folder?.trim()) return [];
  const loaded = readPackFolder(folder);
  const byPack = new Map<string, LoadedPackFile[]>();
  for (const item of loaded)
    if (!isRulePackRegistered(item.version.packId))
      byPack.set(item.version.packId, [...(byPack.get(item.version.packId) ?? []), item]);
  for (const [packId, files] of byPack)
    registerRulePack({
      packId,
      versions: files.map(({ version }) => version),
      origins: Object.fromEntries(
        files.map(({ name, version }) => [version.version, { kind: 'organization_file' as const, file: name }]),
      ),
    });
  return loaded;
}
