import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { twoPageManualPdf } from './document-fixture.js';
import { openAccount } from './account-fixture.js';

// The three forms a person fills in away from a desk, on a phone: a safety report, a document's acknowledgement and a
// flight record. Each is usable at 375 × 812 on a touch screen: labels above their fields, nothing cut off at the
// side, every control at least 44 px each way, and the button that sends it reachable.

const phone = { width: 375, height: 812 };
test.use({ viewport: phone, hasTouch: true, isMobile: true });

async function openAs(page: Page, organization: string, person: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: organization, exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations' }).click();
}

/** Opens the narrow bar's menu and follows one of its links or buttons. */
async function fromMenu(page: Page, role: 'link' | 'button', name: string) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.topbar-menu').getByRole(role, { name, exact: true }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
}

/** What a phone shows wrongly in a form: a label beside its field, a control past the edge, a control too small. */
async function layoutProblems(form: Locator): Promise<string[]> {
  return form.evaluate((element, width) => {
    const problems: string[] = [];
    const shown = (node: Element) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const name = (node: Element) => node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 40) ?? '';
    for (const label of element.querySelectorAll('label')) {
      const control = label.control;
      if (!control || !shown(label) || !shown(control)) continue;
      if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) continue;
      // The label's own words: its first text that is not inside the field.
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let words: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.textContent!.trim() && !control.contains(node)) {
          words = node as Text;
          break;
        }
      if (!words) continue;
      const range = document.createRange();
      range.selectNodeContents(words);
      const text = range.getBoundingClientRect();
      if (text.bottom > control.getBoundingClientRect().top + 2)
        problems.push(`label beside its field: ${name(label)}`);
    }
    for (const control of element.querySelectorAll('button, input, select, textarea, summary')) {
      if (!shown(control)) continue;
      const box = control.getBoundingClientRect();
      if (box.left < -1 || box.right > width + 1) problems.push(`cut off at the side: ${name(control)}`);
      const checkable = control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type);
      // A box to tick is reached through its label, which is the hit area.
      const target = checkable ? (control.closest('label') ?? control) : control;
      const hit = target.getBoundingClientRect();
      if (hit.height < 43.5 || (!checkable && hit.width < 43.5))
        problems.push(`smaller than 44 px: ${name(target)} ${Math.round(hit.width)}×${Math.round(hit.height)}`);
    }
    if (element.scrollWidth > element.clientWidth + 1) problems.push('the form scrolls sideways');
    return problems;
  }, phone.width);
}

async function expectUsable(page: Page, form: Locator, send: Locator) {
  expect(await layoutProblems(form)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone.width);
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
}

test('a pilot reports a safety concern from the menu on a phone', async ({ page }, testInfo) => {
  await openAs(page, 'Fictional Valley Power', 'pilot');
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
  // One row: the brand, the section and the menu.
  const bar = page.getByRole('banner');
  expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(60);
  await fromMenu(page, 'button', 'Report a safety concern');
  const dialog = page.getByRole('dialog', { name: 'Report a safety concern' });
  await dialog
    .getByLabel('What happened or what you saw', { exact: true })
    .fill(`Loose strap on the spare battery case ${randomUUID().slice(0, 8)}`);
  await dialog.getByLabel('Where it happened (optional)', { exact: true }).fill('Truck 3');
  const send = dialog.getByRole('button', { name: 'Send report', exact: true });
  await expectUsable(page, dialog, send);
  await page.screenshot({ path: testInfo.outputPath('report-a-safety-concern-375.png') });
  await send.click();
  await expect(dialog.getByRole('heading', { name: 'Your report is received' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('a pilot acknowledges an issued document on a phone', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8);
  const title = `Field crew checklist ${suffix}`;
  // Drafting, review, signature and issue happen at a desk.
  await page.setViewportSize({ width: 1440, height: 960 });
  const openAtDesk = async (person: string) => {
    await openAs(page, 'Fictional Valley Power', person);
    await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
  };
  await openAtDesk('safety');
  await page.getByRole('button', { name: /^Documents/ }).click();
  const startDraft = page.getByRole('button', { name: 'Record a document', exact: true });
  if (await startDraft.isVisible()) await startDraft.click();
  const draft = page.getByRole('form', { name: 'Record a document' });
  await draft.getByLabel('Title', { exact: true }).fill(title);
  await draft.getByLabel('Revision label', { exact: true }).fill('Revision 1');
  await draft.getByLabel('Summary', { exact: true }).fill('What the field crew checks before leaving the yard.');
  await draft
    .getByLabel(/^Document text/)
    .fill(`# Before leaving\n\nCheck the straps on every case. Marker ${suffix}.`);
  await draft.getByRole('button', { name: 'Save draft', exact: true }).click();
  const copyLabel = `Signed checklist copy ${suffix}`;
  await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
  const attach = page.getByRole('form', { name: 'Attach a file', exact: true });
  await attach.getByLabel('File', { exact: true }).setInputFiles({
    name: `field-crew-checklist-${suffix}.pdf`,
    mimeType: 'application/pdf',
    buffer: twoPageManualPdf(suffix),
  });
  await attach.getByLabel('Description', { exact: true }).fill(copyLabel);
  await attach.getByRole('button', { name: 'Attach file', exact: true }).click();
  await expect(attach).toBeHidden();
  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  const review = page.getByRole('form', { name: 'Review document revision', exact: true });
  await review.getByRole('checkbox', { name: new RegExp(copyLabel) }).check();
  await review.getByLabel('Review note', { exact: true }).fill('Checked the checklist and its signed copy.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the working text and selected files for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Reviewed, awaiting signature');

  await openAccount(page);
  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAtDesk('executive');
  await page
    .getByRole('region', { name: 'Signatures waiting on you', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const sign = page.getByRole('form', { name: 'Sign', exact: true });
  await sign.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await sign.getByLabel('Rationale for adopting', { exact: true }).fill('Adopted for the fictional field crews.');
  await sign.getByLabel('Fixture credential', { exact: true }).fill('ledger-dev-utility-executive');
  await sign.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  await sign.getByRole('button', { name: 'Sign and adopt', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Signed, ready to issue');

  await openAccount(page);
  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAtDesk('safety');
  await page.getByRole('button', { name: /^Documents/ }).click();
  await page.getByRole('searchbox', { name: 'Find document', exact: true }).fill(title);
  await page
    .getByLabel('Recorded documents', { exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await page.getByRole('button', { name: 'Issue revision', exact: true }).click();
  const issue = page.getByRole('form', { name: 'Issue document revision', exact: true });
  await issue.getByRole('checkbox', { name: 'Jordan Reyes', exact: true }).check();
  await issue.getByLabel(/^Acknowledgement due/).fill(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16));
  await issue.getByLabel('Issue note', { exact: true }).fill('Issued before the next shift.');
  await issue
    .getByRole('checkbox', { name: 'I reviewed the signed revision, effective dates and named readers.', exact: true })
    .check();
  await issue.getByRole('button', { name: 'Issue now', exact: true }).click();
  await expect(page.getByTestId('sms-issued-document')).toContainText('Revision 1 in force');
  await openAccount(page);
  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();

  // The pilot reads and acknowledges it on a phone.
  await page.setViewportSize(phone);
  await openAs(page, 'Fictional Valley Power', 'pilot');
  await page
    .getByRole('region', { name: 'My reading', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const reader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await expect(reader).toBeVisible();
  await reader
    .locator('summary')
    .filter({ hasText: /^Acknowledgement required/ })
    .click();
  const acknowledge = reader.getByRole('form', { name: 'Acknowledge document', exact: true });
  await acknowledge.getByRole('checkbox', { name: new RegExp(`I have read ${title}, Revision 1`) }).check();
  const record = acknowledge.getByRole('button', { name: 'Record my acknowledgement', exact: true });
  await expectUsable(page, acknowledge, record);
  await page.screenshot({ path: testInfo.outputPath('acknowledge-a-document-375.png') });
  await record.click();
  await expect(reader.getByRole('contentinfo')).toContainText('You acknowledged Revision 1 on');
});

test('a dispatcher enters a flight record on a phone, choosing a subject on file', async ({ page }, testInfo) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  await openAs(page, 'Alpha Dispatch', 'operator');
  await fromMenu(page, 'link', 'Records');
  const area = page.getByRole('main', { name: 'Operator records' });
  await area.getByRole('button', { name: 'Enter a record', exact: true }).click();
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: 'Flight record' });
  // A flight on file first, so the picker has one to offer.
  const first = area.getByRole('form', { name: 'Enter Flight record' });
  await first.getByRole('combobox', { name: /^Subject id/ }).fill(`${run}-ALPHA-FLIGHT-07`);
  await first.getByLabel(/^Takeoff at/).fill('2026-10-05T09:30');
  await first.getByLabel(/^Takeoff place/).fill('Alpha yard');
  await first.getByRole('button', { name: 'Record entry', exact: true }).click();
  await expect(area.getByRole('button', { name: /Open Flight record record/ }).first()).toBeVisible();

  await area.getByRole('button', { name: 'Enter a record', exact: true }).click();
  const entry = area.getByRole('form', { name: 'Enter Flight record' });
  const subject = entry.getByRole('combobox', { name: /^Subject id/ });
  await subject.fill(`${run}-ALPHA`);
  await expect(entry.getByRole('listbox', { name: 'Subjects on file' }).getByRole('option')).toHaveCount(1);
  await subject.press('ArrowDown');
  await subject.press('Enter');
  await expect(subject).toHaveValue(`${run}-ALPHA-FLIGHT-07`);
  const send = entry.getByRole('button', { name: 'Record entry', exact: true });
  await expectUsable(page, entry, send);
  await page.screenshot({ path: testInfo.outputPath('enter-a-flight-record-375.png'), fullPage: true });
});
