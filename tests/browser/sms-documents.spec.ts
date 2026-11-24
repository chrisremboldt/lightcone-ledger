import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { twoPageManualPdf } from './document-fixture.js';

async function openAs(page: Page, person: 'safety' | 'executive' | 'pilot') {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Fictional Valley Power', exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations' }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
}

async function attachPdf(page: Page, bytes: Buffer, label: string, revision: string) {
  await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
  const form = page.getByRole('form', { name: 'Attach a file', exact: true });
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: `fictional-aircraft-inspection-revision-${revision}.pdf`,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await form.getByLabel('Description', { exact: true }).fill(label);
  await form.getByRole('button', { name: 'Attach file', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('sms-record').getByText(label, { exact: true }).first()).toBeVisible();
}

test('a received manual is reviewed, signed, issued and personally acknowledged while the next revision is drafted', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(12_000);
  const suffix = randomUUID().slice(0, 8);
  const title = `Aircraft inspection manual ${suffix}`;
  const fileLabel = `OEM inspection instructions ${suffix}`;
  const nextFileLabel = `Draft OEM revision 5 ${suffix}`;
  const sourceBytes = twoPageManualPdf(suffix);
  await openAs(page, 'safety');
  await page.getByRole('button', { name: /^Documents/ }).click();
  await expect(page.getByRole('heading', { name: 'Controlled documents', exact: true })).toBeVisible();
  const startDraft = page.getByRole('button', { name: 'Record a document', exact: true });
  if (await startDraft.isVisible()) await startDraft.click();
  const draft = page.getByRole('form', { name: 'Record a document' });
  await draft.getByLabel('Title', { exact: true }).fill(title);
  await draft.getByRole('combobox', { name: 'Origin', exact: true }).selectOption('received');
  await draft.getByRole('combobox', { name: 'Type', exact: true }).selectOption('oem_manual');
  await draft.getByLabel('Document number (optional)', { exact: true }).fill(`FVP-OEM-${suffix}`);
  await draft.getByLabel('Revision label', { exact: true }).fill('OEM Revision 4');
  await draft.getByLabel('Issuing organization', { exact: true }).fill('Fictional Aircraft Company');
  await draft.getByLabel('Source reference (optional)', { exact: true }).fill('AIRCRAFT-INSPECTION');
  await draft.getByLabel('Source revision', { exact: true }).fill('4');
  await draft.getByLabel('Issued by source (optional)', { exact: true }).fill('2026-10-01');
  await draft.getByLabel(/^Received/).fill('2026-10-22T09:00');
  await draft
    .getByLabel("Issuer's summary of this revision", { exact: true })
    .fill('Manufacturer inspection instructions for the fictional fleet.');
  await expect(draft.getByRole('textbox', { name: 'Why we are adopting it', exact: true })).toHaveValue('');
  await draft
    .getByRole('textbox', { name: 'Why we are adopting it', exact: true })
    .fill('Initial receipt of the aircraft manual.');
  await expect(draft.getByLabel(/^Document text/)).toHaveCount(0);
  await draft.getByRole('button', { name: 'Save draft', exact: true }).click();

  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: title, exact: true, level: 2 })).toBeVisible();
  await expect(page.getByTestId('sms-working-document')).toContainText('Draft, awaiting review');
  await attachPdf(page, sourceBytes, fileLabel, '4');
  await page
    .getByTestId('sms-working-document')
    .getByRole('button', { name: 'Read OEM Revision 4', exact: true })
    .click();
  const draftReader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await expect(draftReader.getByRole('note')).toContainText('Not issued');
  await expect(draftReader.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
  await draftReader.getByRole('button', { name: 'Review revision', exact: true }).click();
  await expect(draftReader).toBeHidden();
  const review = page.getByRole('form', { name: 'Review document revision', exact: true });
  await review.getByRole('checkbox', { name: new RegExp(fileLabel) }).check();
  await review.getByLabel('Review note', { exact: true }).fill('Checked the source revision and the retained file.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the selected files and details for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Reviewed, awaiting signature');

  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAs(page, 'executive');
  await page
    .getByRole('region', { name: 'Signatures waiting on you', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(page.getByTestId('sms-intent')).toContainText(`I, Morgan Ellis, adopt OEM Revision 4`);
  await page.getByRole('button', { name: 'Read OEM Revision 4', exact: true }).click();
  const signingReader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await expect(signingReader).toContainText('Reviewed, awaiting signature');
  await expect(signingReader).toContainText(fileLabel);
  await expect(signingReader.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
  await signingReader.getByRole('button', { name: 'Sign adoption', exact: true }).click();
  await expect(signingReader).toBeHidden();
  const sign = page.getByRole('form', { name: 'Sign', exact: true });
  await sign.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await sign
    .getByLabel('Rationale for adopting', { exact: true })
    .fill('Adopted for use by the fictional inspection crews.');
  await sign.getByLabel('Fixture credential', { exact: true }).fill('ledger-dev-utility-executive');
  await sign.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  await expect(sign.getByText(/Confirmed\. Sign within five minutes/)).toBeVisible();
  const signingAttempts: { key: string; body: string; grant: string }[] = [];
  await page.route('**/v1/commands', async (route) => {
    const sent = route.request();
    if (sent.method() !== 'POST' || sent.postDataJSON()?.decision?.kind !== 'document.adopt') {
      await route.continue();
      return;
    }
    signingAttempts.push({
      key: sent.headers()['idempotency-key'],
      body: sent.postData()!,
      grant: sent.headers()['x-ledger-reauthentication'],
    });
    if (signingAttempts.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.status(), await accepted.text()).toBe(201);
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'upstream_error', message: 'Temporary upstream response failure' } }),
      });
    } else await route.continue();
  });
  const acceptedBasis = page.waitForResponse(async (response) => {
    if (
      response.request().method() !== 'GET' ||
      !/\/v1\/sms\/records\/[^/?]+$/.test(response.url()) ||
      !signingAttempts.length
    )
      return false;
    const current = await response.json();
    return current.basis?.revision > JSON.parse(signingAttempts[0].body).expectedRevision;
  });
  await sign.getByRole('button', { name: 'Sign and adopt', exact: true }).click();
  await expect(sign.getByRole('button', { name: 'Retry exact signing request', exact: true })).toBeEnabled();
  await acceptedBasis;
  await sign.getByRole('button', { name: 'Retry exact signing request', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Signed, ready to issue');
  expect(signingAttempts).toHaveLength(2);
  expect(signingAttempts[1]).toEqual(signingAttempts[0]);
  await page.unroute('**/v1/commands');

  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAs(page, 'safety');
  await page
    .getByRole('region', { name: 'Documents to review or issue', exact: true })
    .getByRole('button', { name: new RegExp(`${title}.*Signed, ready to issue.*Issue`) })
    .click();
  await page.getByRole('button', { name: 'Issue revision', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel issuing', exact: true })).toBeVisible();
  const issue = page.getByRole('form', { name: 'Issue document revision', exact: true });
  await issue.getByRole('checkbox', { name: 'Jordan Reyes', exact: true }).check();
  await issue.getByLabel(/^Acknowledgement due/).fill(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16));
  await issue.getByLabel('Issue note', { exact: true }).fill('Issued to the pilot before the next inspection shift.');
  await issue
    .getByRole('checkbox', { name: 'I reviewed the signed revision, effective dates and named readers.', exact: true })
    .check();
  await issue.getByRole('button', { name: 'Issue now', exact: true }).click();
  const issued = page.getByTestId('sms-issued-document');
  await expect(issued).toContainText('OEM Revision 4 in force');
  await expect(issued).toContainText(fileLabel);
  await expect(issued).toContainText('0 of 1 acknowledged');
  const desktop = testInfo.outputPath('document-issue-desktop.png');
  await page.screenshot({ path: desktop, fullPage: true });
  await testInfo.attach('Document issued to its named reader', { path: desktop, contentType: 'image/png' });
  await page.getByRole('button', { name: /^Safety home/ }).click();
  const organizationReading = page
    .getByRole('region', { name: 'Reading across the organization', exact: true })
    .getByRole('button', { name: new RegExp(title) });
  await expect(organizationReading).toContainText('0 of 1 acknowledged');
  const readingHome = testInfo.outputPath('document-reading-home-desktop.png');
  await page.screenshot({ path: readingHome, fullPage: true });
  await testInfo.attach('Safety manager sees outstanding reading across documents', {
    path: readingHome,
    contentType: 'image/png',
  });
  await organizationReading.click();
  await expect(issued.getByText('Jordan Reyes', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Record a new revision', exact: true }).click();
  const revise = page.getByRole('form', { name: 'Record a new revision', exact: true });
  await expect(revise.getByLabel('Revision label', { exact: true })).toHaveValue('');
  await expect(revise.getByLabel('Revision label', { exact: true })).toHaveAttribute(
    'placeholder',
    'Previously OEM Revision 4',
  );
  await expect(revise.getByLabel('Issued by source (optional)', { exact: true })).toHaveValue('');
  await expect(revise).toContainText('OEM Revision 4 was source revision 4, issued Oct 1, 2026.');
  await expect(revise).toContainText("This is OEM Revision 4's summary.");
  await revise.getByLabel('Revision label', { exact: true }).fill('OEM Revision 5');
  await revise.getByLabel('Source revision', { exact: true }).fill('5');
  await revise
    .getByLabel("Issuer's summary of this revision", { exact: true })
    .fill('Draft instructions awaiting review; this is not the issued procedure.');
  await revise
    .getByRole('textbox', { name: 'Why we are adopting it', exact: true })
    .fill('Preparing the newly received manufacturer update.');
  await revise.getByRole('button', { name: 'Save version 2', exact: true }).click();
  await expect(revise).toBeHidden();
  await expect(page.getByTestId('sms-working-document')).toContainText('OEM Revision 5');
  await attachPdf(page, twoPageManualPdf(suffix, '5'), nextFileLabel, '5');
  await expect(issued).toContainText('OEM Revision 4 in force');
  const revisionTabs = page.getByRole('group', { name: 'Show revision', exact: true });
  await revisionTabs.getByRole('button', { name: /^Compare/ }).click();
  const compare = page.getByTestId('sms-document-compare');
  await expect(compare).toContainText('OEM Revision 4 → OEM Revision 5');
  const pageChanges = compare.getByRole('group', { name: 'Page changes', exact: true });
  await expect(pageChanges).toContainText('2 changed, 0 added, 0 removed');
  await expect(pageChanges.locator('ins').first()).toHaveText(/5$/);
  await page.getByRole('button', { name: 'Record periodic review', exact: true }).click();
  const periodic = page.getByRole('form', { name: 'Record periodic review', exact: true });
  await periodic.getByLabel('What was reviewed', { exact: true }).fill('Checked against the current fleet.');
  await periodic
    .getByRole('checkbox', { name: 'I reviewed OEM Revision 4 in force and it remains current.', exact: true })
    .check();
  await periodic.getByRole('button', { name: 'Record periodic review', exact: true }).click();
  await expect(periodic).toBeHidden();
  await expect(issued.getByText('Not scheduled', { exact: true })).toHaveCount(0);

  await issued.getByRole('button', { name: 'Read document', exact: true }).click();
  const reader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await expect(reader.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(reader).toContainText('OEM Revision 4');
  await expect(reader.getByRole('combobox', { name: 'Content', exact: true })).toHaveCount(0);
  await expect(reader).toContainText(fileLabel);
  await expect(reader).not.toContainText(nextFileLabel);
  const about = reader.getByRole('region', { name: 'About OEM Revision 4', exact: true });
  await expect(about).toContainText('Manufacturer inspection instructions for the fictional fleet.');
  await expect(about).toContainText('Why we adopted it Initial receipt of the aircraft manual.');
  await expect(reader).not.toContainText('Draft instructions awaiting review');

  const pdfPage = reader.getByRole('spinbutton', { name: 'Page number', exact: true });
  await expect(pdfPage).toHaveValue('1');
  await reader.getByLabel('Find in document', { exact: true }).fill(`Rotor brake inspection marker ${suffix}`);
  await expect(pdfPage).toHaveValue('2');
  await expect(reader.getByText(`Rotor brake inspection marker ${suffix}`, { exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(pdfPage).toHaveValue('1');
  await reader
    .getByRole('combobox', { name: 'Document outline', exact: true })
    .selectOption({ label: 'After landing' });
  await expect(pdfPage).toHaveValue('2');
  const readerDesktop = testInfo.outputPath('document-reader-desktop.png');
  await page.screenshot({ path: readerDesktop });
  await testInfo.attach('Reader searches the exact issued PDF', { path: readerDesktop, contentType: 'image/png' });
  await reader.getByRole('button', { name: 'Document record', exact: true }).click();
  await expect(reader).toBeHidden();
  await expect(issued).toContainText('OEM Revision 4 in force');
  await expect(issued).not.toContainText(nextFileLabel);

  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, 'pilot');
  await page
    .getByRole('region', { name: 'My reading', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(reader).toBeVisible();
  await expect(reader).toContainText('OEM Revision 4');
  await reader.getByRole('button', { name: 'Document record', exact: true }).click();
  await expect(reader).toBeHidden();
  await expect(issued).toContainText('OEM Revision 4 in force');
  await expect(issued).toContainText('OEM Revision 5 · Draft, awaiting review');
  await expect(issued).not.toContainText('Draft instructions awaiting review');
  const working = page.getByTestId('sms-working-document');
  await expect(working).toHaveCount(0);
  await revisionTabs.getByRole('button', { name: /^Draft/ }).click();
  await expect(
    working.getByText('Draft instructions awaiting review; this is not the issued procedure.', { exact: true }),
  ).toBeVisible();
  await revisionTabs.getByRole('button', { name: /^In force/ }).click();
  await expect(working).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await issued.getByRole('button', { name: 'Read and acknowledge', exact: true }).click();
  await expect(reader).toBeVisible();
  await reader.getByRole('combobox', { name: 'PDF zoom', exact: true }).selectOption({ label: 'Fit width' });
  await pdfPage.fill('1');
  await pdfPage.press('Enter');
  await expect(reader.getByText(`Preflight inspection marker ${suffix}`, { exact: true })).toBeVisible();
  expect(await reader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const pdfOverflow = () =>
    reader.locator('.sms-pdf-scroll').evaluate((element) => element.scrollWidth - element.clientWidth);
  await expect.poll(pdfOverflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 700, height: 844 });
  await expect.poll(pdfOverflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(pdfOverflow).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const downloadEvent = page.waitForEvent('download');
  await reader.getByRole('button', { name: 'Download original', exact: true }).click();
  const download = await downloadEvent;
  expect(await readFile((await download.path())!)).toEqual(sourceBytes);
  const mobilePdf = testInfo.outputPath('document-reader-pdf-mobile.png');
  await page.screenshot({ path: mobilePdf });
  await testInfo.attach('Pilot reads the issued PDF on a phone', { path: mobilePdf, contentType: 'image/png' });
  await reader
    .locator('summary')
    .filter({ hasText: /^Acknowledgement required/ })
    .click();
  const acknowledge = reader.getByRole('form', { name: 'Acknowledge document', exact: true });
  await expect(acknowledge.getByRole('button', { name: 'Record my acknowledgement', exact: true })).toBeDisabled();
  await acknowledge.getByRole('checkbox', { name: new RegExp(`I have read ${title}, OEM Revision 4`) }).check();
  await acknowledge.getByRole('button', { name: 'Record my acknowledgement', exact: true }).click();
  await expect(reader.getByRole('contentinfo')).toContainText('You acknowledged OEM Revision 4 on');
  const mobile = testInfo.outputPath('document-reader-acknowledgement-mobile.png');
  await page.screenshot({ path: mobile });
  await testInfo.attach('Pilot personally acknowledges the exact issued revision', {
    path: mobile,
    contentType: 'image/png',
  });
  await reader.getByRole('button', { name: 'Document record', exact: true }).click();
  await expect(reader).toBeHidden();
  await expect(issued).toContainText('OEM Revision 4 in force');
  await expect(issued).toContainText('1 of 1 acknowledged');
  await expect(issued).toContainText('You acknowledged');
});

test('an authored policy with a signed copy is issued and read as searchable text or PDF', async ({ page }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(12_000);
  const suffix = randomUUID().slice(0, 8);
  const title = `Crew briefing policy ${suffix}`;
  const policyText = [
    '# Before flight',
    `Brief the crew on the inspection plan. Readiness marker ${suffix}.`,
    Array.from({ length: 30 }, (_, index) => `Briefing item ${index + 1}: confirm the crew is ready.`).join('\n'),
    '# After landing',
    `Record the inspection and secure the aircraft. Completion marker ${suffix}.`,
  ].join('\n\n');
  await openAs(page, 'safety');
  await page.getByRole('button', { name: /^Documents/ }).click();
  const startDraft = page.getByRole('button', { name: 'Record a document', exact: true });
  if (await startDraft.isVisible()) await startDraft.click();
  const draft = page.getByRole('form', { name: 'Record a document' });
  await draft.getByLabel('Title', { exact: true }).fill(title);
  await draft.getByLabel('Revision label', { exact: true }).fill('Revision 1');
  await draft.getByLabel('Summary', { exact: true }).fill('How crews brief before and after inspection flights.');
  await draft.getByLabel(/^Document text/).fill(policyText);
  await draft.getByRole('button', { name: 'Save draft', exact: true }).click();
  const copyLabel = `Signed policy copy ${suffix}`;
  await attachPdf(page, twoPageManualPdf(suffix), copyLabel, '1');
  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  const review = page.getByRole('form', { name: 'Review document revision', exact: true });
  await review.getByRole('checkbox', { name: new RegExp(copyLabel) }).check();
  await review.getByLabel('Review note', { exact: true }).fill('Checked the policy text and its signed copy.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the working text and selected files for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Reviewed, awaiting signature');

  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAs(page, 'executive');
  await page
    .getByRole('region', { name: 'Signatures waiting on you', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const sign = page.getByRole('form', { name: 'Sign', exact: true });
  await sign.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await sign.getByLabel('Rationale for adopting', { exact: true }).fill('Adopted for the fictional crews.');
  await sign.getByLabel('Fixture credential', { exact: true }).fill('ledger-dev-utility-executive');
  await sign.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  await sign.getByRole('button', { name: 'Sign and adopt', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Signed, ready to issue');

  await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
  await openAs(page, 'safety');
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
  const issued = page.getByTestId('sms-issued-document');
  await expect(issued).toContainText('Revision 1 in force');

  await issued.getByRole('button', { name: 'Read document', exact: true }).click();
  const reader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await expect(reader.getByRole('region', { name: 'About Revision 1', exact: true })).toContainText(
    'How crews brief before and after inspection flights.',
  );
  await expect(reader.getByRole('region', { name: 'Document text', exact: true })).toHaveText(policyText);
  await reader.getByLabel('Search document text', { exact: true }).fill('inspection');
  await expect(reader.getByRole('status')).toHaveText('1 of 2');
  await reader.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(reader.getByRole('status')).toHaveText('2 of 2');
  await reader.getByRole('button', { name: 'Previous match', exact: true }).click();
  await expect(reader.getByRole('status')).toHaveText('1 of 2');
  await reader
    .locator('summary')
    .filter({ hasText: /^Sections/ })
    .click();
  await reader
    .getByRole('navigation', { name: 'Sections', exact: true })
    .getByRole('button', { name: 'After landing', exact: true })
    .click();
  await expect(reader.locator(':focus')).toContainText('# After landing');
  await expect(reader.locator(':focus')).toBeInViewport();

  await expect(reader.locator('.sms-reader-picker-count')).toHaveText('2 items');
  await reader.getByRole('combobox', { name: 'Content', exact: true }).selectOption({ label: copyLabel });
  await expect(reader.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
});
