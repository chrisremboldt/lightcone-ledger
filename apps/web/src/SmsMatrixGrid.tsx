import type { AssessedPosition, RiskMatrixBody } from '@ledger/contracts';
import { acceptanceLabels, levelName } from './sms-labels.js';

/** A risk matrix as a grid, most likely row first, with an assessment's initial and residual positions if given. */
export function MatrixGrid({
  matrix,
  initial,
  residual,
}: {
  matrix: RiskMatrixBody;
  initial?: AssessedPosition;
  residual?: AssessedPosition;
}) {
  const likelihoods = [...matrix.likelihoods].reverse();
  const levelLabel = (level: string) => levelName(level, matrix);
  const acceptance = (level: string) => matrix.levels.find((entry) => entry.id === level)?.acceptance ?? 'low';
  return (
    <table className="sms-matrix" aria-label={`${matrix.name}: initial and residual positions`}>
      <thead>
        <tr>
          <th scope="col">Likelihood \ Severity</th>
          {matrix.severities.map((severity) => (
            <th scope="col" key={severity.id}>
              {severity.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {likelihoods.map((likelihood) => (
          <tr key={likelihood.id}>
            <th scope="row">{likelihood.label}</th>
            {matrix.severities.map((severity) => {
              const cell = matrix.cells.find(
                (item) => item.severity === severity.id && item.likelihood === likelihood.id,
              )!;
              const isInitial = initial?.severity === severity.id && initial?.likelihood === likelihood.id;
              const isResidual = residual?.severity === severity.id && residual?.likelihood === likelihood.id;
              return (
                <td key={severity.id} className={`sms-cell sms-cell--${acceptance(cell.level)}`}>
                  {initial || residual ? (
                    <span className="sr-only">{levelLabel(cell.level)}</span>
                  ) : (
                    levelLabel(cell.level)
                  )}
                  {isInitial && <b title="Initial risk">Initial</b>}
                  {isResidual && <b title="Predicted residual risk">Residual</b>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What each severity, likelihood and acceptance level of a matrix means, in its own words. */
export function MatrixDefinitions({ matrix }: { matrix: RiskMatrixBody }) {
  const groups = [
    { title: 'Severity, least to most severe', entries: matrix.severities },
    { title: 'Likelihood, least to most likely', entries: matrix.likelihoods },
    {
      title: 'Levels, least to most serious',
      entries: matrix.levels.map((level) => ({
        id: level.id,
        label: level.label,
        description: `${level.meaning} ${acceptanceLabels[level.acceptance]}${level.acceptance === 'not_acceptable' ? ' a risk at this level.' : ' may accept it.'}`,
      })),
    },
  ];
  return (
    <>
      {groups.map((group) => (
        <div key={group.title}>
          <h4 className="sms-subhead">{group.title}</h4>
          <dl className="safety-facts">
            {group.entries.map((entry) => (
              <div key={entry.id}>
                <dt>{entry.label}</dt>
                <dd>{entry.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}
