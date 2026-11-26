/**
 * The seeded fictional organizations, as local development and the public demonstration show them. Any other
 * organization is shown by its own name and is never matched against these.
 */
export const operators = [
  { key: 'alpha', name: 'Alpha Dispatch', description: 'Medical and parcel delivery' },
  { key: 'beta', name: 'Beta Inspection', description: 'Infrastructure inspection' },
  { key: 'utility', name: 'Fictional Valley Power', description: 'Utility drone program safety management' },
] as const;

/** The seeded fictional organization with this id, if it is one. */
export function seededOrganization(tenantId: string) {
  return operators.find((operator) => tenantId === `tenant-${operator.key}`);
}

/** What the bar calls a seeded organization's data: the utility's own, or the flight operators'. Null for any other. */
export function seededDataLabel(tenantId: string): string | null {
  const organization = seededOrganization(tenantId);
  if (!organization) return null;
  return organization.key === 'utility' ? 'fictional utility' : 'fictional operators';
}

/**
 * The seeded fictional people the local sign-in screen and the demonstration offer, with their development tokens.
 * Read only behind the development and demonstration build switch, so a production build leaves them out.
 */
export const fictionalPeople = [
  {
    operator: 'alpha',
    role: 'operator',
    name: 'Dana Ortiz',
    title: 'Dispatcher',
    token: 'ledger-dev-alpha-operator',
  },
  { operator: 'alpha', role: 'actor', name: 'Sam Rivera', title: 'Field crew', token: 'ledger-dev-alpha-actor' },
  {
    operator: 'beta',
    role: 'operator',
    name: 'Lee Park',
    title: 'Dispatcher',
    token: 'ledger-dev-beta-operator',
  },
  { operator: 'beta', role: 'actor', name: 'Jordan Hale', title: 'Field crew', token: 'ledger-dev-beta-actor' },
  {
    operator: 'utility',
    role: 'safety',
    name: 'Avery Chen',
    title: 'Safety manager',
    token: 'ledger-dev-utility-safety',
  },
  {
    operator: 'utility',
    role: 'executive',
    name: 'Morgan Ellis',
    title: 'Accountable executive',
    token: 'ledger-dev-utility-executive',
  },
  { operator: 'utility', role: 'pilot', name: 'Jordan Reyes', title: 'Pilot', token: 'ledger-dev-utility-pilot' },
];
