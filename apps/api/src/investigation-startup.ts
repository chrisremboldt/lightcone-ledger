import { createLocalInvestigationRunner } from '@ledger/investigator';
import type { InvestigationOptions } from './investigation.js';
import { investigationApiOrigin } from './investigation-transport.js';

export function localInvestigationOptions(env: NodeJS.ProcessEnv = process.env): InvestigationOptions | undefined {
  const enabled = env.LEDGER_INVESTIGATOR_ENABLED;
  if (!enabled || enabled === '0') return undefined;
  if (enabled !== '1') throw new Error('LEDGER_INVESTIGATOR_ENABLED must be 0 or 1.');
  const apiOrigin = investigationApiOrigin(env.LEDGER_INVESTIGATOR_API_ORIGIN ?? '');
  return { apiOrigin, runner: createLocalInvestigationRunner() };
}
