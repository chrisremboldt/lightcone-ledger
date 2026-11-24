import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

const NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
const skipped =
  /(?:^|\/)(?:node_modules|dist|dist-demo|generated|tests|fixtures|tapes|vendor)(?:\/|$)|\.test\.[cm]?[jt]sx?$/;

/** The repository's own code, scripts and configuration: everything that can read a variable at run time. */
export function codeFiles(): string[] {
  const files: string[] = [];
  for (const top of ['apps', 'packages', 'infra', 'tools'])
    for (const entry of readdirSync(join(root, top), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = relative(root, join(entry.parentPath, entry.name)).split('\\').join('/');
      if (!skipped.test(path) && /\.(?:[cm]?[jt]sx?|sh|ya?ml)$|(?:^|\/)Dockerfile$/.test(path)) files.push(path);
    }
  // The local stand-in identity provider is a development tool, though it lives beside the tests.
  for (const entry of readdirSync(join(root, 'tests', 'oidc'), { withFileTypes: true }))
    if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\./.test(entry.name))
      files.push(`tests/oidc/${entry.name}`);
  for (const name of readdirSync(root))
    if (/^(?:vitest.*|playwright\.config)\.[cm]?[jt]s$/.test(name) || name === 'package.json') files.push(name);
  return files.sort();
}

/** The variables a file reads: by name, or by a pattern for a name it builds from parts. */
export function readsIn(text: string, path: string): { names: Set<string>; patterns: RegExp[] } {
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  const add = (expression: RegExp) => {
    for (const match of text.matchAll(expression)) names.add(match[1]!);
  };
  if (/\.(?:sh|ya?ml)$|Dockerfile$|package\.json$/.test(path)) {
    add(new RegExp(`\\$\\{?(${NAME})\\b`, 'g'));
    // A variable set for a command it starts, as in VAR=value command.
    add(new RegExp(`(?:^|[\\s"'])(${NAME})=(?=\\S)`, 'gm'));
    return { names, patterns };
  }
  add(new RegExp(`(?:process\\.env|import\\.meta\\.env|\\benv|\\bvariables)\\??\\.(${NAME})\\b`, 'g'));
  add(new RegExp(`(?:process\\.env|\\benv)\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`, 'g'));
  for (const match of text.matchAll(/const \{([^}]+)\} = process\.env/g))
    for (const name of match[1]!.split(',')) names.add(name.trim());
  if (/process\.env|\benv\[/.test(text)) {
    // A name handed to a helper that reads it, as in required(env, 'X') or value('X', fallback).
    add(new RegExp(`\\b[a-z]\\w*\\(\\s*(?:env\\s*,\\s*)?['"](${NAME}_${NAME})['"]\\s*[,)]`, 'g'));
    // A list of settings read together, as in ['X', 'Y'].some((name) => env[name] !== undefined).
    for (const list of text.matchAll(/(const settings = )?\[((?:\s*'[A-Z][A-Z0-9_]*',?)+\s*)\]([^]{0,200})/g))
      if (list[1] || /\benv\[(?:name|key)\]/.test(list[3]!))
        for (const name of list[2]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)) names.add(name[1]!);
    // Settings checked against their required values, as in const settings = { X: 'value' }.
    for (const block of text.matchAll(/const settings = \{([^}]*)\}/g))
      for (const name of block[1]!.matchAll(/^\s*([A-Z][A-Z0-9_]*):/gm)) names.add(name[1]!);
  }
  for (const match of text.matchAll(/(?:process\.env|\benv)\[\s*`([A-Z0-9_]*(?:\$\{[^}`]+\}[A-Z0-9_]*)+)`\s*\]/g))
    patterns.push(new RegExp(`^${match[1]!.replace(/\$\{[^}]+\}/g, '[A-Z0-9_]+')}$`));
  return { names, patterns };
}

/**
 * Each variable `.env.example` lists, set or commented out, with the comment above it: the comment lines since the
 * previous variable, or that variable's own comment when two are listed together.
 */
export function exampleVariables(text: string): Map<string, string> {
  const variables = new Map<string, string>();
  let comment: string[] = [];
  let previous = '';
  for (const line of text.split('\n')) {
    const variable = new RegExp(`^(?:# )?(${NAME})=`).exec(line);
    if (variable) {
      previous = comment.length ? comment.join('\n') : previous;
      variables.set(variable[1]!, previous);
      comment = [];
    } else if (line.startsWith('#')) comment.push(line);
    else {
      comment = [];
      previous = '';
    }
  }
  return variables;
}
