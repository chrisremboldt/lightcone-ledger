import { riskAcceptanceValues, type RiskAcceptance, type RiskMatrixBody } from './sms.js';

// What the matrix schema cannot say. The API, the web form and the command-line client share it.

export const MIN_RISK_LEVELS = 2;
export const MAX_RISK_LEVELS = 6;

export function riskMatrixProblems(matrix: RiskMatrixBody): string[] {
  const problems: string[] = [];
  const severities = new Set(matrix.severities.map((entry) => entry.id));
  const likelihoods = new Set(matrix.likelihoods.map((entry) => entry.id));
  if (severities.size !== 5) problems.push('Severity categories need five distinct identifiers.');
  if (likelihoods.size !== 5) problems.push('Likelihood categories need five distinct identifiers.');
  problems.push(...levelProblems(matrix));
  const levels = new Set(matrix.levels.map((entry) => entry.id));
  const cells = new Set<string>();
  for (const cell of matrix.cells) {
    if (!severities.has(cell.severity) || !likelihoods.has(cell.likelihood))
      problems.push(`Cell ${cell.severity} × ${cell.likelihood} names an unknown category.`);
    if (!levels.has(cell.level))
      problems.push(
        `Cell ${cell.severity} × ${cell.likelihood} names ${cell.level}, which is not a level of the matrix.`,
      );
    const key = `${cell.severity}\u0000${cell.likelihood}`;
    if (cells.has(key)) problems.push(`Cell ${cell.severity} × ${cell.likelihood} is defined twice.`);
    cells.add(key);
  }
  if (cells.size !== 25) problems.push('Every severity and likelihood combination needs exactly one level.');
  return problems;
}

function levelProblems(matrix: RiskMatrixBody): string[] {
  const problems: string[] = [];
  const { levels } = matrix;
  if (levels.length < MIN_RISK_LEVELS || levels.length > MAX_RISK_LEVELS)
    problems.push(`A matrix has from ${MIN_RISK_LEVELS} to ${MAX_RISK_LEVELS} levels.`);
  if (new Set(levels.map((level) => level.id)).size !== levels.length)
    problems.push('Two levels have the same identifier.');
  if (new Set(levels.map((level) => level.label.trim().toLowerCase())).size !== levels.length)
    problems.push('Two levels have the same label.');
  if (levels[0]?.acceptance === 'not_acceptable')
    problems.push(`The first level, ${levels[0].label}, is one somebody may accept.`);
  levels.forEach((level, index) => {
    const earlier = levels[index - 1];
    if (earlier && acceptanceRank(level.acceptance) < acceptanceRank(earlier.acceptance))
      problems.push(
        `${level.label} comes after ${earlier.label}, so it needs at least the authority ${earlier.label} needs.`,
      );
  });
  return problems;
}

function acceptanceRank(acceptance: RiskAcceptance): number {
  return riskAcceptanceValues.indexOf(acceptance);
}
