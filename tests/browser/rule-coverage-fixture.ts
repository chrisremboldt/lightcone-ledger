import type { Locator } from '@playwright/test';

/**
 * A rule's row on Coverage by rule, its section opened first as a person would: a section with nothing to do starts
 * folded, and so do the rules that count nothing yet.
 */
export async function ruleRow(scope: Locator, leafId: string): Promise<Locator> {
  const row = scope.locator(`[data-testid="rule-coverage-row"][data-rule="${leafId}"]`);
  const section = row.locator('xpath=ancestor::details[1]');
  if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open)))
    await section.locator(':scope > summary').click();
  return row;
}
