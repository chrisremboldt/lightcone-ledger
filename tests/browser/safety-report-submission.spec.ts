import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// People submit safety reports themselves: signed in from any screen, and through a reporting link without signing in.

async function openAs(page: Page, person: 'safety' | 'pilot') {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Fictional Valley Power', exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations' }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
}

async function receiptCode(page: Page): Promise<string> {
  const code = page.getByTestId('receipt-code');
  await expect(code).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  return (await code.textContent())!.trim();
}

test('a pilot submits a report without their name and is shown a receipt code once', async ({ page }) => {
  await openAs(page, 'pilot');
  await page.getByRole('button', { name: 'Report a safety concern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a safety concern' });
  await dialog
    .getByLabel('What happened or what you saw', { exact: true })
    .fill(`Spare battery left charging unattended in the crew room ${randomUUID().slice(0, 8)}`);
  await dialog.getByLabel('Where it happened (optional)', { exact: true }).fill('Crew room');
  await expect(dialog.getByLabel('Put my name on this report', { exact: true })).not.toBeChecked();
  await expect(dialog.getByText('Files and photos cannot be sent with a report.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Send report', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Your report is received' })).toBeVisible();
  await receiptCode(page);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('the report dialog keeps focus, closes on Escape without sending, and keeps the draft until discarded', async ({
  page,
}) => {
  await openAs(page, 'pilot');
  const opener = page.getByRole('button', { name: 'Report a safety concern', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Report a safety concern' });
  const seen = dialog.getByLabel('What happened or what you saw', { exact: true });
  await expect(seen).toBeFocused();
  const words = `Loose propeller guard on the spare aircraft ${randomUUID().slice(0, 8)}`;
  await seen.fill(words);
  // The page behind is inert: tabbing never reaches it (past the last control the browser may hold focus itself).
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate(
      (element) => element.contains(document.activeElement) || document.activeElement === document.body,
    );
    expect(inside).toBe(true);
  }

  let sent = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/safety-reports') sent = true;
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(sent).toBe(false);

  await opener.click();
  await expect(dialog.getByTestId('report-draft-kept')).toBeVisible();
  await expect(dialog.getByLabel('What happened or what you saw', { exact: true })).toHaveValue(words);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(dialog.getByLabel('What happened or what you saw', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await opener.click();
  await expect(dialog.getByTestId('report-draft-kept')).toHaveCount(0);
  expect(sent).toBe(false);
});

test('a safety manager issues a reporting link, and a report sent through it is received', async ({ page }) => {
  const label = `Line crew trailer ${randomUUID().slice(0, 8)}`;
  await openAs(page, 'safety');
  await page.getByRole('button', { name: /^Safety reports\s*\d*$/ }).click();
  const links = page.getByRole('region', { name: 'Reporting links' });
  const issue = links.getByRole('form', { name: 'Issue a reporting link' });
  await issue.getByLabel('Label', { exact: true }).fill(label);
  await issue.getByRole('button', { name: 'Issue a reporting link', exact: true }).click();
  const issued = links.getByTestId('issued-report-link');
  await expect(issued).toContainText(label);
  const address = (await issued.locator('.safety-report-code').textContent())!.trim();
  expect(address).toMatch(/\/report#ledger-report-[A-Za-z0-9_-]{43}$/);
  await expect(links.getByRole('list', { name: 'Issued reporting links' })).toContainText(label);

  // The link's page: no sign-in, only what was seen, when and where, and an optional way to reach the reporter.
  await page.goto(address);
  const form = page.getByRole('form', { name: 'Send a safety report' });
  await form.getByLabel('What happened or what you saw', { exact: true }).fill('Ground wire left across the walkway.');
  await form.getByLabel('Where it happened (optional)', { exact: true }).fill('Substation 4 gate');
  await expect(
    form.getByText('Optional. If you give one, the people cleared to read safety reports can see it.', { exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Send report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your report is received' })).toBeVisible();
  const code = await receiptCode(page);

  const check = page.getByRole('form', { name: 'Check a report' });
  await check.getByLabel('Receipt code', { exact: true }).fill(code);
  await check.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(check.getByTestId('receipt-status')).toHaveText('Received. It is not closed yet.');

  // Back in Ledger, the link is named on the Safety home and can be revoked.
  await openAs(page, 'safety');
  await expect(page.getByTestId('first-step-reports')).toContainText(`“${label}”`);
  await page.getByRole('button', { name: /^Safety reports\s*\d*$/ }).click();
  const listed = page
    .getByRole('region', { name: 'Reporting links' })
    .getByRole('list', { name: 'Issued reporting links' })
    .getByRole('listitem')
    .filter({ hasText: label });
  await listed.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(listed).toContainText('Revoked');
});
