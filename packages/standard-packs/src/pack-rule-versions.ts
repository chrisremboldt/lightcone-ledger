import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PackFile, PackFileRule } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { BuiltPack } from './pack-builder.js';
import { packFileVersion, verifiedPackFile } from './pack-files.js';
import { readPackFile } from './pack-folder.js';

// A new pack version built beside an earlier one numbers its rules from it: a rule whose definition changed gets the
// next rule version, an unchanged rule keeps its version, so a result recorded under either says which rule it read.

/** An earlier version of the pack, found beside the new one, and the file it was read from. */
export interface EarlierPackFile {
  file: PackFile;
  path: string;
}

/** What numbering the rules from the earlier version changed. */
export interface RuleVersionChanges {
  earlier: { version: number; path: string };
  changed: { id: string; from: number; to: number }[];
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * The latest version of the pack below `version` among the pack files in the folders, or undefined. A file that does
 * not load is passed over: the build reports nothing it cannot read.
 */
export function earlierPackFile(
  folders: readonly string[],
  packId: string,
  version: number,
): EarlierPackFile | undefined {
  let found: EarlierPackFile | undefined;
  for (const folder of new Set(folders)) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (!name.startsWith(`${packId}-v`) || !name.endsWith('.pack.json')) continue;
      const path = join(folder, name);
      let file: PackFile;
      try {
        file = readPackFile(path).file;
      } catch {
        continue;
      }
      if (file.packId === packId && file.version < version && (!found || file.version > found.file.version))
        found = { file, path };
    }
  }
  return found;
}

/** A rule's definition apart from its version number. */
const definitionDigest = (rule: PackFileRule) => canonicalDigest({ ...rule, version: 0 });

/** The built pack with each rule's version numbered from the earlier version, and what that changed. */
export function withRuleVersions(
  built: BuiltPack,
  earlier: EarlierPackFile,
): { built: BuiltPack; changes: RuleVersionChanges } {
  const before = new Map(earlier.file.rules.map((rule) => [rule.id, rule]));
  const changes: RuleVersionChanges = {
    earlier: { version: earlier.file.version, path: earlier.path },
    changed: [],
    added: [],
    removed: earlier.file.rules
      .filter((rule) => !built.file.rules.some((item) => item.id === rule.id))
      .map((rule) => rule.id),
    unchanged: 0,
  };
  const numbered = new Map<string, PackFileRule>();
  for (const rule of built.file.rules) {
    const old = before.get(rule.id);
    if (!old) {
      changes.added.push(rule.id);
      numbered.set(rule.id, rule);
    } else if (definitionDigest(old) === definitionDigest(rule)) {
      changes.unchanged += 1;
      numbered.set(rule.id, { ...rule, version: old.version });
    } else {
      const to = Math.max(old.version + 1, rule.version);
      changes.changed.push({ id: rule.id, from: old.version, to });
      numbered.set(rule.id, { ...rule, version: to });
    }
  }
  const { digest: _digest, ...content } = built.file;
  const rules = built.file.rules.map((rule) => numbered.get(rule.id)!);
  const file: PackFile = { ...content, rules, digest: packFileVersion({ ...content, rules }).digest };
  verifiedPackFile(file);
  return {
    built: { file, reports: built.reports.map((report) => ({ ...report, rule: numbered.get(report.rule.id)! })) },
    changes,
  };
}

/** The lines the build prints about how the rules were numbered from the earlier version. */
export function ruleVersionLines(changes: RuleVersionChanges): string[] {
  const { earlier, changed, added, removed, unchanged } = changes;
  return [
    `  Rule versions follow version ${earlier.version} (${earlier.path}): ${changed.length} changed, ${added.length} added, ${removed.length} no longer in this version, ${unchanged} unchanged and keeping their versions`,
    ...changed.map((item) => `    changed: ${item.id} version ${item.from} becomes version ${item.to}`),
    ...added.map((id) => `    added: ${id}`),
    ...removed.map((id) => `    no longer in this version: ${id}`),
  ];
}
