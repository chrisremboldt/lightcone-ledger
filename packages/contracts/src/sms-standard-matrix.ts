import type { RiskAuthority, RiskMatrixBody } from './sms.js';

const severities = [
  ['minimal', 'Minimal', 'No injury or damage; negligible effect on operations.'],
  ['minor', 'Minor', 'Slight injury or minor damage; a small reduction in safety margins.'],
  ['major', 'Major', 'Injury, significant damage or a large reduction in safety margins.'],
  ['hazardous', 'Hazardous', 'Serious injury or major damage.'],
  ['catastrophic', 'Catastrophic', 'Fatality or loss of the aircraft.'],
] as const;
const likelihoods = [
  ['extremely_improbable', 'Extremely improbable', 'So unlikely it is not expected to occur.'],
  ['extremely_remote', 'Extremely remote', 'Possible, but not expected to occur.'],
  ['remote', 'Remote', 'Expected to occur once or a few times.'],
  ['probable', 'Probable', 'Expected to occur several times a year.'],
  ['frequent', 'Frequent', 'Expected to occur routinely, monthly or more often.'],
] as const;
// Rows from least to most likely; each row lists the level from least to most severe.
const levels: Record<(typeof likelihoods)[number][0], RiskAuthority[]> = {
  extremely_improbable: ['low', 'low', 'low', 'low', 'medium'],
  extremely_remote: ['low', 'low', 'low', 'medium', 'high'],
  remote: ['low', 'low', 'medium', 'high', 'high'],
  probable: ['low', 'medium', 'high', 'high', 'high'],
  frequent: ['medium', 'medium', 'high', 'high', 'high'],
};

/**
 * The standard 5 × 5 form an organization starts its own risk matrix from, in neutral wording. The organization edits
 * the labels, definitions and the level of each cell before a person with adoption authority signs it.
 */
export const standardRiskMatrix: RiskMatrixBody = {
  name: 'Safety risk matrix',
  severities: severities.map(([id, label, description]) => ({ id, label, description })),
  likelihoods: likelihoods.map(([id, label, description]) => ({ id, label, description })),
  levels: [
    {
      id: 'low',
      label: 'Low',
      meaning: 'Acceptable as assessed. A person who may accept low risk may accept it.',
      acceptance: 'low',
    },
    {
      id: 'medium',
      label: 'Medium',
      meaning: 'Acceptable with controls in place. A person who may accept medium risk may accept it.',
      acceptance: 'medium',
    },
    {
      id: 'high',
      label: 'High',
      meaning: 'Not acceptable without further controls. Only a person who may accept high risk may accept it.',
      acceptance: 'high',
    },
  ],
  cells: likelihoods.flatMap(([likelihood]) =>
    severities.map(([severity], index) => ({ severity, likelihood, level: levels[likelihood][index]! })),
  ),
};
