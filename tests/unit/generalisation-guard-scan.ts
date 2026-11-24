import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export const repositoryRoot = join(import.meta.dirname, '..', '..');

// Generic modules: the core that must stay free of any one problem type.
const scannedSourceRoots = [
  'packages/domain/src',
  'apps/workers/src',
  'apps/api/src',
  'packages/projections/src',
  'packages/evidence/src',
  'packages/persistence/src',
];
// Rule modules are specific by design; a later generic rules index is the only part of it under the guard.
const excludedSourceRoots = ['packages/domain/src/rules/'];
const migrationsRoot = 'packages/persistence/migrations';
// Applied migrations are never edited, so every migration up to this number is exempt by number.
export const lastExemptMigration = 47;

// Input kinds every problem type shares. Any other kind the contracts or rule modules declare is problem-specific.
const coreInputKinds = new Set([
  'order.revision',
  'intent.revision',
  'flight.observation',
  'source.observation',
  'telemetry.segment',
  'mission.revision',
  'observation',
]);

// Word sequences that name one problem type or one vendor. Matched against whole words of identifiers,
// string-literal tokens and module paths, after splitting camelCase, snake_case, kebab-case and dots.
// Landing alone is ordinary flight vocabulary; only the landing rules' own terms are listed.
const problemVocabulary = [
  ['command', 'link'],
  ['lost', 'link'],
  ['c2'],
  ['landing', 'disagreement'],
  ['landing', 'evidence'],
  ['landing', 'times'],
  ['monitoring', 'window'],
];
const vendorNames = [['dji'], ['airspace', 'link'], ['skydio']];

export type Finding = { file: string; rule: string; match: string; line: number };

export type ForbiddenLiterals = { ruleIds: Set<string>; inputKinds: Set<string> };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(c|m)?(t|j)sx?$/.test(name) && !/\.test\.(c|m)?(t|j)sx?$/.test(name) ? [path] : [];
  });
}

function repositoryPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join('/');
}

export function scannedFiles(): string[] {
  const sources = scannedSourceRoots
    .flatMap((root) => sourceFiles(join(repositoryRoot, root)))
    .map(repositoryPath)
    .filter((path) => !excludedSourceRoots.some((excluded) => path.startsWith(excluded)));
  const migrations = readdirSync(join(repositoryRoot, migrationsRoot))
    .filter((name) => Number(/^(\d+)_.*\.sql$/.exec(name)?.[1] ?? 0) > lastExemptMigration)
    .map((name) => `${migrationsRoot}/${name}`);
  return [...sources, ...migrations].sort();
}

function read(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

function parse(path: string, text = read(path)): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function stringLiterals(source: ts.SourceFile): ts.StringLiteralLike[] {
  const found: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function inputKindLiterals(source: ts.SourceFile): string[] {
  const kinds: string[] = [];
  const visit = (node: ts.Node): void => {
    const named = (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) && node.name.getText(source);
    if (named === 'inputKind') kinds.push(...stringLiterals(node).map((literal) => literal.text));
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'inputKindValues')
      kinds.push(...stringLiterals(node).map((literal) => literal.text));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return kinds;
}

// Rule ids, pack references and policy ids are read from the rule modules, so new rules are caught without
// editing this guard. Input kinds are read from the contracts and the rule modules' source bindings.
export function forbiddenLiterals(): ForbiddenLiterals {
  const ruleModules = sourceFiles(join(repositoryRoot, 'packages/domain/src/rules'))
    .map(repositoryPath)
    .map((path) => parse(path));
  const ruleIds = new Set<string>();
  for (const source of ruleModules) {
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && /^ledger\.[a-z0-9]/.test(node.text)) ruleIds.add(node.text);
      if (ts.isVariableDeclaration(node) && /_ID$/.test(node.name.getText(source)) && node.initializer)
        if (ts.isStringLiteralLike(node.initializer)) ruleIds.add(node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const id of [...ruleIds]) if (/\.\d+$/.test(id)) ruleIds.add(id.replace(/\.\d+$/, ''));
  const contracts = sourceFiles(join(repositoryRoot, 'packages/contracts/src'))
    .map(repositoryPath)
    .filter((path) => !path.includes('/generated/'))
    .map((path) => parse(path));
  const inputKinds = new Set(
    [...ruleModules, ...contracts].flatMap(inputKindLiterals).filter((kind) => !coreInputKinds.has(kind)),
  );
  return { ruleIds, inputKinds };
}

function words(text: string): string[] {
  return (text.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z0-9]+/g) ?? []).map((word) => word.toLowerCase());
}

function containsSequence(text: string, sequences: string[][]): boolean {
  const split = words(text);
  return sequences.some((sequence) =>
    split.some((_, start) => sequence.every((word, offset) => split[start + offset] === word)),
  );
}

// Literals are checked token by token, so an id inside SQL or a message is reported as that id alone.
function literalTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9_.:/@-]+/).filter((token) => token.length > 0);
}

function literalFindings(text: string, forbidden: ForbiddenLiterals): { rule: string; match: string }[] {
  return literalTokens(text).flatMap((token) => {
    const rules: string[] = [];
    if (forbidden.ruleIds.has(token)) rules.push('rule-id');
    if (forbidden.inputKinds.has(token)) rules.push('input-kind');
    if (/^ledger\.demo[.-]/.test(token)) rules.push('demo-content-id');
    if (containsSequence(token, problemVocabulary)) rules.push('problem-literal');
    if (containsSequence(token, vendorNames)) rules.push('vendor');
    return rules.map((rule) => ({ rule, match: token }));
  });
}

function moduleSpecifierRules(specifier: string): string[] {
  const rules: string[] = [];
  if (/(^|\/)rules\/(?!index(\.[cm]?[jt]s)?$)/.test(specifier)) rules.push('rule-module-import');
  if (containsSequence(specifier, problemVocabulary)) rules.push('problem-module-import');
  if (containsSequence(specifier, vendorNames)) rules.push('vendor');
  return rules;
}

function identifierRules(name: string): string[] {
  const rules: string[] = [];
  if (containsSequence(name, problemVocabulary)) rules.push('problem-identifier');
  if (containsSequence(name, vendorNames)) rules.push('vendor');
  return rules;
}

function scanTypeScript(path: string, text: string, forbidden: ForbiddenLiterals): Finding[] {
  const source = parse(path, text);
  const findings: Finding[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: ts.Node, rules: string[], match: string): void => {
    for (const rule of rules) findings.push({ file: path, rule, match, line: lineOf(node) });
  };
  const reportLiteral = (node: ts.Node, text: string): void => {
    for (const { rule, match } of literalFindings(text, forbidden))
      findings.push({ file: path, rule, match, line: lineOf(node) });
  };
  const visit = (node: ts.Node): void => {
    const isModuleSpecifier =
      ts.isStringLiteralLike(node) &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent) ||
        ts.isExternalModuleReference(node.parent) ||
        (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
        (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)));
    if (isModuleSpecifier) report(node, moduleSpecifierRules(node.text), node.text);
    else if (ts.isStringLiteralLike(node)) reportLiteral(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      reportLiteral(node, node.text);
    else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) report(node, identifierRules(node.text), node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function scanSql(path: string, text: string, forbidden: ForbiddenLiterals): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    const code = line.replace(/--.*$/, '');
    for (const [, literal] of code.matchAll(/'([^']*)'/g))
      for (const { rule, match } of literalFindings(literal, forbidden))
        findings.push({ file: path, rule, match, line: index + 1 });
    for (const [identifier] of code.replace(/'[^']*'/g, '').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g))
      for (const rule of identifierRules(identifier))
        findings.push({ file: path, rule, match: identifier, line: index + 1 });
  });
  return findings;
}

export function scanSource(path: string, text: string, forbidden: ForbiddenLiterals): Finding[] {
  return path.endsWith('.sql') ? scanSql(path, text, forbidden) : scanTypeScript(path, text, forbidden);
}

export function scan(files: string[] = scannedFiles(), forbidden = forbiddenLiterals()): Finding[] {
  return files.flatMap((path) => scanSource(path, read(path), forbidden));
}
