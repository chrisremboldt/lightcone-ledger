import type { RiskAuthority, RiskMatrixBody } from '@ledger/contracts';

const severities = [
  ['minimal', 'Minimal', 'No injury or damage; negligible effect on operations.'],
  ['minor', 'Minor', 'Slight injury or damage; small reduction in safety margins.'],
  ['major', 'Major', 'Injury, significant damage or a large reduction in safety margins.'],
  ['hazardous', 'Hazardous', 'Serious injury or major damage to the aircraft, people or utility assets.'],
  ['catastrophic', 'Catastrophic', 'Fatality, loss of the aircraft over people, or loss of a critical asset.'],
] as const;
const likelihoods = [
  [
    'extremely_improbable',
    'Extremely improbable',
    'So unlikely it is not expected to occur in the life of the program.',
  ],
  ['extremely_remote', 'Extremely remote', 'Possible, but not expected to occur in the life of the program.'],
  ['remote', 'Remote', 'Expected to occur once or a few times in the life of the program.'],
  ['probable', 'Probable', 'Expected to occur several times a year across the program.'],
  ['frequent', 'Frequent', 'Expected to occur routinely, monthly or more often.'],
] as const;
const levels: Record<(typeof likelihoods)[number][0], RiskAuthority[]> = {
  extremely_improbable: ['low', 'low', 'low', 'low', 'medium'],
  extremely_remote: ['low', 'low', 'low', 'medium', 'high'],
  remote: ['low', 'low', 'medium', 'high', 'high'],
  probable: ['low', 'medium', 'high', 'high', 'high'],
  frequent: ['medium', 'medium', 'high', 'high', 'high'],
};

/** A fictional starting matrix for seeded tenants; a customer adopts their own. */
export const exampleRiskMatrix: RiskMatrixBody = {
  name: 'Program safety risk matrix',
  severities: severities.map(([id, label, description]) => ({ id, label, description })),
  likelihoods: likelihoods.map(([id, label, description]) => ({ id, label, description })),
  levels: [
    { id: 'low', label: 'Low', meaning: 'Acceptable with review. The safety manager may accept.', acceptance: 'low' },
    {
      id: 'medium',
      label: 'Medium',
      meaning: 'Acceptable with controls in place. The safety manager may accept.',
      acceptance: 'medium',
    },
    {
      id: 'high',
      label: 'High',
      meaning: 'Unacceptable without controls. Only the accountable executive may accept.',
      acceptance: 'high',
    },
  ],
  cells: likelihoods.flatMap(([likelihood]) =>
    severities.map(([severity], index) => ({ severity, likelihood, level: levels[likelihood][index] })),
  ),
};
