import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// A person editing a controlled document ticks the purposes it serves, from the packs the organization has adopted
// (docs/design/on-file-checks.md). Alpha Dispatch adopts the proposed Part 108 pack in shadow first, if it has not.
test('a person ticks the purposes a document serves, and the next revision keeps them', async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const title = `Safety policy ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();

  await page.getByRole('link', { name: 'Rules', exact: true }).click();
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
    await form.getByLabel('Reason, kept with the adoption', { exact: true }).fill('See what is on file for Part 108.');
    await form.getByRole('button', { name: 'Adopt in shadow', exact: true }).click();
    await expect(adopted.getByText('In effect', { exact: true })).toBeVisible({ timeout: 60_000 });
  }
  await page.getByRole('link', { name: 'Flights', exact: true }).click();

  await page.getByRole('link', { name: 'Safety', exact: true }).click();
  await page.getByRole('button', { name: /^Documents/ }).click();
  const startDraft = page.getByRole('button', { name: 'Record a document', exact: true });
  const draft = page.getByRole('form', { name: 'Record a document' });
  // The form is open already when nothing is recorded yet; otherwise a button opens it.
  await expect(startDraft.or(draft).first()).toBeVisible();
  if (await startDraft.isVisible()) await startDraft.click();
  await draft.getByLabel('Title', { exact: true }).fill(title);
  await draft.getByLabel('Revision label', { exact: true }).fill('Rev A');
  await draft.getByLabel('Summary', { exact: true }).fill('Alpha’s fictional safety policy.');
  await draft.getByLabel(/^Document text/).fill('Safety comes before schedule.');

  // The purposes come from the adopted packs, each with the paragraph it quotes.
  const purposes = draft.getByTestId('document-purposes');
  await expect(purposes).toContainText('A rule counts it only once this revision is signed, issued and in effect');
  const policy = purposes.getByRole('checkbox', { name: /^Safety policy/ });
  await expect(purposes.getByText(/Proposed 14 CFR 108\.560\(a\)/).first()).toBeVisible();
  // A safety policy serves the safety policy purpose by its type, so it is shown as served, not as a box to tick.
  await expect(policy).toBeChecked();
  await expect(policy).toBeDisabled();
  await expect(purposes).toContainText('served by its type');
  // A document of another type serves it when ticked.
  await draft.getByRole('combobox', { name: 'Type', exact: true }).selectOption('procedure');
  await expect(policy).toBeEnabled();
  await policy.check();
  await draft.getByRole('button', { name: 'Save draft', exact: true }).click();

  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: title, exact: true, level: 2 })).toBeVisible();
  // The revision's page lists what it is on file for, for its reviewer and signer.
  await expect(record.getByTestId('document-serves').first()).toContainText('Safety policy (ticked)');
  await page.getByRole('button', { name: 'Record a new revision', exact: true }).click();
  const revision = page.getByRole('form', { name: 'Record a new revision' });
  await expect(
    revision.getByTestId('document-purposes').getByRole('checkbox', { name: /^Safety policy/ }),
  ).toBeChecked();
  await expect(
    revision.getByTestId('document-purposes').getByRole('checkbox', { name: /^Company manual/ }),
  ).not.toBeChecked();
});
