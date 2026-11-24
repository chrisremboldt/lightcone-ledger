import {
  riskAcceptanceCapability,
  riskAuthorityValues,
  type AssessedPosition,
  type RiskAuthority,
  type RiskMatrixBody,
} from '@ledger/contracts';

export {
  coveringRiskCapability,
  riskAcceptanceCapability,
  riskMatrixProblems,
  MIN_RISK_LEVELS,
  MAX_RISK_LEVELS,
} from '@ledger/contracts';

export const RISK_AUTHORITIES: readonly RiskAuthority[] = riskAuthorityValues;
export function evaluateRiskMatrix(
  matrix: RiskMatrixBody,
  position: { severity: string; likelihood: string },
): AssessedPosition | undefined {
  const cell = matrix.cells.find(
    (candidate) => candidate.severity === position.severity && candidate.likelihood === position.likelihood,
  );
  const level = cell && matrix.levels.find((entry) => entry.id === cell.level);
  if (!cell || !level) return undefined;
  return { severity: cell.severity, likelihood: cell.likelihood, level: level.id, acceptance: level.acceptance };
}

export function highestRiskAuthority(capabilities: readonly string[]): RiskAuthority | null {
  for (const authority of [...RISK_AUTHORITIES].reverse())
    if (capabilities.includes(riskAcceptanceCapability(authority))) return authority;
  return null;
}

export function matrixLabels(matrix: RiskMatrixBody, position: AssessedPosition) {
  return {
    severity: matrix.severities.find((entry) => entry.id === position.severity)?.label ?? position.severity,
    likelihood: matrix.likelihoods.find((entry) => entry.id === position.likelihood)?.label ?? position.likelihood,
    level: matrix.levels.find((entry) => entry.id === position.level)?.label ?? position.level,
  };
}
