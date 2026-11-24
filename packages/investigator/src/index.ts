import type { InvestigationRunner } from '@ledger/contracts';
import { InvestigatorError } from './errors.js';

export { InvestigatorError, type InvestigatorErrorCode } from './errors.js';

/**
 * Placeholder for the finding-investigation seam. No runner is included: every request is
 * refused as unavailable, which the API reports as 503 investigation_unavailable.
 */
export function createLocalInvestigationRunner(): InvestigationRunner {
  return async () => {
    throw new InvestigatorError('unavailable');
  };
}
