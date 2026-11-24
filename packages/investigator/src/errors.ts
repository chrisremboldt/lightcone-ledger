export type InvestigatorErrorCode = 'unavailable';

const messages: Record<InvestigatorErrorCode, string> = {
  unavailable: 'No investigator is available in this build.',
};

export class InvestigatorError extends Error {
  constructor(public readonly code: InvestigatorErrorCode) {
    super(messages[code]);
    this.name = 'InvestigatorError';
  }
}
