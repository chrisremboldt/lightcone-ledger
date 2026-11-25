/** The kinds of subject the Records area lists, in the order people look for them. */
export const recordSubjectKinds = [
  ['person', 'People'],
  ['aircraft', 'Aircraft'],
  ['flight', 'Flights'],
  ['site', 'Sites'],
  ['component', 'Components'],
  ['organization', 'Your organization'],
] as const;
export type RecordSubjectKind = (typeof recordSubjectKinds)[number][0];
