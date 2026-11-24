import { readFile, readdir } from 'node:fs/promises';
import { sha256 } from '@ledger/integrity';

export interface SqlMigration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}
export async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const versions = new Set<number>();
  const migrations: SqlMigration[] = [];
  for (const name of files) {
    const version = Number(name.slice(0, 4));
    if (versions.has(version)) throw new Error('Duplicate SQL migration version');
    versions.add(version);
    const sql = await readFile(new URL(name, directory), 'utf8');
    migrations.push({ version, name, sql, checksum: sha256(sql) });
  }
  return migrations;
}
