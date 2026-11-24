import { test, expect } from '@playwright/test';

test('a dispatcher reviews adopted packs, sees proposed text offered in shadow only, and lists findings for a subject', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const area = page.getByRole('main', { name: 'Rules and findings' });

  // The seeded procedures are adopted as active.
  const coverage = area.getByTestId('organization-coverage');
  await expect(coverage.locator('[data-testid="adoption"][data-mode="active"]').first()).toBeVisible();
  // Each adoption in effect lists its rules, how each is checked, and its subjects counted by latest result.
  await expect(coverage.getByTestId('rule-coverage').first()).toContainText('How it is checked');

  // A pack quoting proposed text can be chosen only in shadow, and the form says why.
  const form = area.getByTestId('adopt-pack');
  await form
    .getByLabel('Rule pack', { exact: true })
    .selectOption({ label: 'Part 108 NPRM checks (shadow only) · version 3 · built into Ledger' });
  await expect(form.getByRole('radio', { name: /Shadow/ })).toBeChecked();
  await expect(form.getByRole('radio', { name: /Active/ })).toBeDisabled();
  await expect(form).toContainText('proposed rule text, which is not in force');
  await expect(form.getByTestId('adopt-pack-rules').getByRole('listitem').first()).toBeVisible();

  // The invented BVLOS waiver, which relieves a Part 107 rule while active, can be adopted in either mode.
  await form.getByLabel('Rule pack', { exact: true }).selectOption({
    label:
      'Example waiver BVW-0001 for Alpha Dispatch, beyond visual line of sight (fictional) · version 1 · built into Ledger',
  });
  await expect(form.getByRole('radio', { name: /Shadow/ })).toBeEnabled();
  await expect(form.getByRole('radio', { name: /Active/ })).toBeEnabled();
  // A waiver's adoption starts at the dates its certificate states, which the person may change.
  await expect(form.getByTestId('adopt-waiver-dates')).toContainText(
    'The certificate states it is effective through August 31, 2028',
  );
  await expect(form.getByLabel('From the start of', { exact: true })).toHaveValue('2026-09-01');
  await expect(form.getByLabel('To the end of', { exact: true })).toHaveValue('2028-08-31');
  await expect(form.getByTestId('adopt-dates-meaning')).toContainText(
    'The rules cover flights and records inside these dates: from the start of September 1, 2026 to the end of August 31, 2028, in America/Chicago.',
  );

  // Findings for a subject picked by name, with proposed results kept apart in plain words.
  await area.getByRole('button', { name: 'Findings by subject' }).click();
  await area.getByLabel('Subject kind').selectOption('organization');
  await area
    .getByTestId('subjects-on-record')
    .getByRole('button', { name: /Synthetic Operations/ })
    .click();
  await expect(area.getByTestId('proposed-findings')).toContainText('Proposed rule: recorded, not counted');

  await page.getByRole('button', { name: 'Close rules' }).click();
  await expect(page.getByRole('main', { name: 'Rules and findings' })).toHaveCount(0);
});

test('the Rules screen lists an adopted pack’s rules under its sections, each with the paragraph it reads', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const area = page.getByRole('main', { name: 'Rules and findings' });
  const adopted = area.getByTestId('adoption').filter({ hasText: 'Part 108 NPRM checks (shadow only) · version 3' });
  if (!(await adopted.count())) {
    const form = area.getByTestId('adopt-pack');
    await form.getByLabel('Rule pack').selectOption({
      label: 'Part 108 NPRM checks (shadow only) · version 3 · built into Ledger',
    });
    await expect(form.getByLabel(/^First day/)).toBeVisible();
    for (const [label, value] of [
      [/^Time zone/, 'America/Chicago'],
      [/^First day/, '1'],
    ] as const)
      for (const field of await form.getByLabel(label).all()) if (!(await field.inputValue())) await field.fill(value);
    await form.getByLabel('Reason, kept with the adoption', { exact: true }).fill('See the rules by section.');
    await form.getByRole('button', { name: 'Adopt in shadow', exact: true }).click();
    await expect(adopted.getByText('In effect', { exact: true })).toBeVisible({ timeout: 60_000 });
  }
  const coverage = adopted.getByTestId('rule-coverage');
  const sections = coverage.getByTestId('rule-coverage-section');
  // Sections in the order of the proposed part, each a heading with its counts.
  await expect(sections.first().getByRole('heading', { level: 6 })).toHaveText(
    '§ 108.40 Operator recordkeeping requirements',
  );
  const areas = coverage.locator('[data-testid="rule-coverage-section"][data-section="108.165"]');
  await expect(areas.getByRole('heading', { level: 6 })).toHaveText('§ 108.165 Area of operations');
  await expect(areas.getByTestId('rule-coverage-section-counts')).toHaveText(/^\d+ rules: \d+ checked automatically/);
  // Each rule beside the paragraph it reads.
  const approval = areas.locator('[data-testid="rule-coverage-row"][data-rule="ledger.nprm.108.165.a"]');
  await expect(approval.getByTestId('rule-paragraph')).toHaveText('§ 108.165(a)');
  await expect(approval.getByRole('rowheader')).toContainText('Each current operating area names its approval');

  await page.getByRole('button', { name: 'Close rules', exact: true }).click();
});
