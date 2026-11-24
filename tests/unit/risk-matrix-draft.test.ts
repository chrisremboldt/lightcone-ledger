import { describe, expect, it } from 'vitest';
import { RiskMatrixBodySchema, standardRiskMatrix } from '../../packages/contracts/src/index.js';
import { riskMatrixProblems } from '../../packages/domain/src/sms-matrix.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  cellLevel,
  matrixDraftProblems,
  trimmedMatrix,
  withAddedLevel,
  withCellLevel,
  withoutLevel,
} from '../../apps/web/src/risk-matrix-draft.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const fields = (draft: typeof standardRiskMatrix) => matrixDraftProblems(draft).map((problem) => problem.field);

describe('the risk matrix drafting form', () => {
  it('starts from a standard 5 × 5 form the API accepts as it is, in neutral words', () => {
    expect(matrixDraftProblems(standardRiskMatrix)).toEqual([]);
    expect(riskMatrixProblems(standardRiskMatrix)).toEqual([]);
    expect(ajv.validate(RiskMatrixBodySchema, standardRiskMatrix), JSON.stringify(ajv.errors)).toBe(true);
    expect(JSON.stringify(standardRiskMatrix)).not.toMatch(/fictional|utility|executive|safety manager/i);
  });

  it('refuses an empty name, label, definition or level meaning, naming the field', () => {
    const draft = structuredClone(standardRiskMatrix);
    draft.name = '   ';
    draft.severities[2]!.label = '';
    draft.likelihoods[4]!.description = ' ';
    draft.levels[1]!.meaning = '';
    expect(fields(draft)).toEqual(['name', 'severities.2.label', 'likelihoods.4.description', 'levels.medium.meaning']);
    expect(matrixDraftProblems(draft)[1]!.message).toBe('The label of severity 3 is empty.');
  });

  it('refuses two severities, two likelihoods or two levels with the same label', () => {
    const draft = structuredClone(standardRiskMatrix);
    draft.severities[3]!.label = ' minor ';
    draft.likelihoods[1]!.label = draft.likelihoods[0]!.label;
    draft.levels[2]!.label = 'low';
    expect(matrixDraftProblems(draft)).toEqual([
      { field: 'severities.3.label', message: 'Severity 4 has the same label as severity 2.' },
      { field: 'likelihoods.1.label', message: 'Likelihood 2 has the same label as likelihood 1.' },
      { field: 'levels', message: 'Two levels have the same name.' },
    ]);
  });

  it('refuses text longer than the record allows', () => {
    const draft = structuredClone(standardRiskMatrix);
    draft.name = 'x'.repeat(121);
    draft.levels[0]!.label = 'x'.repeat(41);
    expect(fields(draft)).toEqual(['name', 'levels.low.label']);
  });

  it('needs exactly one level for every cell', () => {
    const missing = { ...standardRiskMatrix, cells: standardRiskMatrix.cells.slice(1) };
    expect(fields(missing)).toEqual(['cells.minimal.extremely_improbable']);
    const doubled = { ...standardRiskMatrix, cells: [...standardRiskMatrix.cells, standardRiskMatrix.cells[0]!] };
    expect(fields(doubled)).toEqual(['cells.minimal.extremely_improbable']);
  });

  it('sets one cell in place and trims every text before it is recorded', () => {
    const raised = withCellLevel(standardRiskMatrix, 'minor', 'frequent', 'high');
    expect(cellLevel(raised, 'minor', 'frequent')).toBe('high');
    expect(cellLevel(standardRiskMatrix, 'minor', 'frequent')).toBe('medium');
    expect(raised.cells.map((cell) => [cell.severity, cell.likelihood])).toEqual(
      standardRiskMatrix.cells.map((cell) => [cell.severity, cell.likelihood]),
    );
    const padded = structuredClone(standardRiskMatrix);
    padded.name = '  Line survey risk matrix ';
    padded.severities[0]!.description = ' No harm. ';
    const trimmed = trimmedMatrix(padded);
    expect(trimmed.name).toBe('Line survey risk matrix');
    expect(trimmed.severities[0]!.description).toBe('No harm.');
    expect(riskMatrixProblems(trimmed)).toEqual([]);
  });

  it('takes two to six levels of the organization, in order, one of which nobody may accept', () => {
    const four = withAddedLevel(standardRiskMatrix);
    const added = four.levels[3]!;
    expect(added).toEqual({ id: 'level_4', label: '', meaning: '', acceptance: 'high' });
    added.label = 'Stop';
    added.meaning = 'Stop the affected operation.';
    added.acceptance = 'not_acceptable';
    const withStop = withCellLevel(four, 'catastrophic', 'frequent', 'level_4');
    expect(matrixDraftProblems(withStop)).toEqual([]);
    expect(riskMatrixProblems(trimmedMatrix(withStop))).toEqual([]);
    expect(ajv.validate(RiskMatrixBodySchema, trimmedMatrix(withStop)), JSON.stringify(ajv.errors)).toBe(true);

    const reversed = structuredClone(withStop);
    reversed.levels[2]!.acceptance = 'low';
    expect(matrixDraftProblems(reversed)).toEqual([
      {
        field: 'levels.high.acceptance',
        message: 'Level 3 comes after level 2, so it needs at least the authority level 2 needs.',
      },
    ]);
    expect(riskMatrixProblems(reversed)).toEqual([
      'High comes after Medium, so it needs at least the authority Medium needs.',
    ]);

    const nobodyFirst = structuredClone(standardRiskMatrix);
    nobodyFirst.levels = nobodyFirst.levels.map((level) => ({ ...level, acceptance: 'not_acceptable' as const }));
    expect(fields(nobodyFirst)).toContain('levels');
    expect(riskMatrixProblems(nobodyFirst)).toContain('The first level, Low, is one somebody may accept.');

    const one = withoutLevel(withoutLevel(standardRiskMatrix, 'medium'), 'high');
    expect(fields(one)).toContain('levels');
    expect(riskMatrixProblems(one)).toContain('A matrix has from 2 to 6 levels.');
    expect(riskMatrixProblems(one).join(' ')).toMatch(/names medium, which is not a level of the matrix/);
  });
});
