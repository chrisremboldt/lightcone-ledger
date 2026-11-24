import type { InvestigationContext } from '@ledger/contracts';
import { describe, expect, it } from 'vitest';
import { createLocalInvestigationRunner, InvestigatorError } from '../src/index.js';

describe('investigator placeholder', () => {
  it('refuses every investigation as unavailable', async () => {
    const run = createLocalInvestigationRunner();
    const refusal = run({} as InvestigationContext, new AbortController().signal);
    await expect(refusal).rejects.toBeInstanceOf(InvestigatorError);
    await expect(refusal).rejects.toMatchObject({ code: 'unavailable' });
  });
});
