import { riskAcceptanceValues, type RiskMatrixBody } from '@ledger/contracts';

/** A problem with a matrix draft, keyed by the field it belongs to so the form can show it beside that field. */
export interface MatrixDraftProblem {
  field: string;
  message: string;
}

// The lengths the sms.risk-matrix.1 schema allows.
const limits = { name: 120, label: 80, description: 400, levelLabel: 40, meaning: 400 };

type Axis = 'severities' | 'likelihoods';
const axisNoun: Record<Axis, string> = { severities: 'severity', likelihoods: 'likelihood' };

function textProblem(field: string, value: string, what: string, max: number): MatrixDraftProblem[] {
  const trimmed = value.trim();
  if (!trimmed) return [{ field, message: `${what} is empty.` }];
  if (trimmed.length > max) return [{ field, message: `${what} is longer than ${max} characters.` }];
  return [];
}

function axisProblems(draft: RiskMatrixBody, axis: Axis): MatrixDraftProblem[] {
  const noun = axisNoun[axis];
  const problems = draft[axis].flatMap((entry, index) => [
    ...textProblem(`${axis}.${index}.label`, entry.label, `The label of ${noun} ${index + 1}`, limits.label),
    ...textProblem(
      `${axis}.${index}.description`,
      entry.description,
      `The definition of ${noun} ${index + 1}`,
      limits.description,
    ),
  ]);
  const seen = new Map<string, number>();
  draft[axis].forEach((entry, index) => {
    const key = entry.label.trim().toLowerCase();
    if (!key) return;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, index);
    else
      problems.push({
        field: `${axis}.${index}.label`,
        message: `${noun[0]!.toUpperCase()}${noun.slice(1)} ${index + 1} has the same label as ${noun} ${first + 1}.`,
      });
  });
  return problems;
}

export const MIN_LEVELS = 2;
export const MAX_LEVELS = 6;

function levelProblems(draft: RiskMatrixBody): MatrixDraftProblem[] {
  const problems = draft.levels.flatMap((level, index) => [
    ...textProblem(`levels.${level.id}.label`, level.label, `The name of level ${index + 1}`, limits.levelLabel),
    ...textProblem(`levels.${level.id}.meaning`, level.meaning, `What level ${index + 1} means`, limits.meaning),
  ]);
  const labels = draft.levels.map((level) => level.label.trim().toLowerCase()).filter(Boolean);
  if (new Set(labels).size !== labels.length)
    problems.push({ field: 'levels', message: 'Two levels have the same name.' });
  if (draft.levels.length < MIN_LEVELS || draft.levels.length > MAX_LEVELS)
    problems.push({ field: 'levels', message: `A matrix has from ${MIN_LEVELS} to ${MAX_LEVELS} levels.` });
  if (draft.levels[0]?.acceptance === 'not_acceptable')
    problems.push({ field: 'levels', message: 'Somebody may accept a risk at the first level.' });
  const rank = (acceptance: RiskMatrixBody['levels'][number]['acceptance']) => riskAcceptanceValues.indexOf(acceptance);
  draft.levels.forEach((level, index) => {
    const earlier = draft.levels[index - 1];
    if (earlier && rank(level.acceptance) < rank(earlier.acceptance))
      problems.push({
        field: `levels.${level.id}.acceptance`,
        message: `Level ${index + 1} comes after level ${index}, so it needs at least the authority level ${index} needs.`,
      });
  });
  return problems;
}

function cellProblems(draft: RiskMatrixBody): MatrixDraftProblem[] {
  const levels = new Set(draft.levels.map((level) => level.id));
  const problems: MatrixDraftProblem[] = [];
  for (const severity of draft.severities)
    for (const likelihood of draft.likelihoods) {
      const cells = draft.cells.filter((cell) => cell.severity === severity.id && cell.likelihood === likelihood.id);
      if (cells.length !== 1 || !levels.has(cells[0]!.level))
        problems.push({
          field: `cells.${severity.id}.${likelihood.id}`,
          message: `The cell ${severity.label.trim() || severity.id} × ${likelihood.label.trim() || likelihood.id} needs one acceptance level.`,
        });
    }
  return problems;
}

/** Every problem with a matrix draft before it is sent; none means the draft can be recorded. */
export function matrixDraftProblems(draft: RiskMatrixBody): MatrixDraftProblem[] {
  return [
    ...textProblem('name', draft.name, 'The matrix name', limits.name),
    ...axisProblems(draft, 'severities'),
    ...axisProblems(draft, 'likelihoods'),
    ...levelProblems(draft),
    ...cellProblems(draft),
  ];
}

/** The draft as it is recorded: every text trimmed. */
export function trimmedMatrix(draft: RiskMatrixBody): RiskMatrixBody {
  const entry = (item: { id: string; label: string; description: string }) => ({
    id: item.id,
    label: item.label.trim(),
    description: item.description.trim(),
  });
  return {
    name: draft.name.trim(),
    severities: draft.severities.map(entry),
    likelihoods: draft.likelihoods.map(entry),
    levels: draft.levels.map((level) => ({
      id: level.id,
      label: level.label.trim(),
      meaning: level.meaning.trim(),
      acceptance: level.acceptance,
    })),
    cells: draft.cells.map((cell) => ({ ...cell })),
  };
}

/** The draft with one cell's acceptance level set. */
export function withCellLevel(
  draft: RiskMatrixBody,
  severity: string,
  likelihood: string,
  level: string,
): RiskMatrixBody {
  const matches = (cell: { severity: string; likelihood: string }) =>
    cell.severity === severity && cell.likelihood === likelihood;
  const cells = draft.cells.some(matches)
    ? draft.cells.map((cell) => (matches(cell) ? { ...cell, level } : cell))
    : [...draft.cells, { severity, likelihood, level }];
  return { ...draft, cells };
}

/** The level a cell needs, if it has one. */
export function cellLevel(draft: RiskMatrixBody, severity: string, likelihood: string): string | undefined {
  return draft.cells.find((cell) => cell.severity === severity && cell.likelihood === likelihood)?.level;
}

/** The draft with a new last level, needing at least the authority the level before it needs. */
export function withAddedLevel(draft: RiskMatrixBody): RiskMatrixBody {
  const ids = new Set(draft.levels.map((level) => level.id));
  let number = draft.levels.length + 1;
  while (ids.has(`level_${number}`)) number += 1;
  const last = draft.levels[draft.levels.length - 1];
  return {
    ...draft,
    levels: [...draft.levels, { id: `level_${number}`, label: '', meaning: '', acceptance: last?.acceptance ?? 'low' }],
  };
}

/** The draft without a level; its cells then need another level chosen. */
export function withoutLevel(draft: RiskMatrixBody, id: string): RiskMatrixBody {
  return { ...draft, levels: draft.levels.filter((level) => level.id !== id) };
}
