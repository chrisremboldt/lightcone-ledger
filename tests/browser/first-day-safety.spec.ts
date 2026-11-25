import { test, expect, type Page } from '@playwright/test';

/**
 * A new organization's first day in the safety area, from `pnpm org:create` alone. Its people sign in through the
 * test issuer, so it needs a stack set up for it on a database of its own (a sign-in subject is tied to one person
 * only, so it runs once per database, and not on the database openid-connect.spec.ts used):
 *
 *   pnpm test-issuer                                   # http://127.0.0.1:4010, client ledger-local
 *   LEDGER_OIDC_ISSUER=http://127.0.0.1:4010 LEDGER_OIDC_CLIENT_ID=ledger-local pnpm dev
 *   LEDGER_OIDC_ISSUER=http://127.0.0.1:4010 LEDGER_OIDC_CLIENT_ID=ledger-local pnpm org:create \
 *     --name "Example Ridge Survey" --time-zone America/Denver --admin "Test Administrator" \
 *     --sign-in-issuer http://127.0.0.1:4010 --sign-in-subject test-administrator
 *   LEDGER_BROWSER_TEST_ISSUER=http://127.0.0.1:4010 pnpm test:browser first-day-safety
 */
const issuer = process.env.LEDGER_BROWSER_TEST_ISSUER;

async function signInAs(page: Page, person: string) {
  await page.goto('/');
  await page.getByRole('button', { name: `Sign in through ${new URL(issuer!).host}` }).click();
  await expect(page.getByRole('heading', { name: 'Test issuer' })).toBeVisible();
  await page.getByRole('link', { name: person, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openSafety(page: Page) {
  await page.getByRole('link', { name: 'Safety', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
}

/** Signs on the signing screen: reviewed, a rationale, and a fresh sign-in at the issuer in its own window. */
async function sign(page: Page, rationale: string, person: string, button: string) {
  const form = page.getByRole('form', { name: 'Sign', exact: true });
  await form.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await form.getByRole('textbox').first().fill(rationale);
  const popup = page.waitForEvent('popup');
  await form.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  await (await popup).getByRole('link', { name: person, exact: true }).click();
  await expect(form.getByText(/You signed in again at/)).toBeVisible();
  await form.getByRole('button', { name: button, exact: true }).click();
}

/** Ticks boxes for a person on the People screen and saves. */
async function grant(page: Page, name: string, labels: string[], tick = true) {
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });
  await area
    .getByRole('complementary', { name: 'People list' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  const person = area.getByRole('form', { name: `What ${name} may do` });
  for (const label of labels) await person.getByLabel(label, { exact: true }).setChecked(tick);
  await person.getByRole('button', { name: 'Save what they may do' }).click();
  await expect(area.getByText(`What ${name} may do was changed. The change is recorded.`)).toBeVisible();
  await page.getByRole('link', { name: 'Flights', exact: true }).click();
}

test.skip(!issuer, 'Set LEDGER_BROWSER_TEST_ISSUER to run against a stack configured with the test issuer');

test('a new organization drafts and adopts its matrix, accepts a risk, issues its policy and reads a report', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, 'Test Administrator');

  // Nothing is on file but the administrator's own adoption authority, and nothing fictional is shown.
  await openSafety(page);
  const onFile = page.getByRole('region', { name: 'What is on file' });
  await expect(onFile.getByTestId('first-step-adopt')).toContainText('On file');
  await expect(onFile.getByTestId('first-step-matrix')).toContainText('Not on file');
  await expect(onFile.getByTestId('first-step-reports')).toContainText('No one is cleared to read safety reports');
  await expect(page.locator('body')).not.toContainText(/Valley Power|Alpha Dispatch|Beta Inspection|fictional/i);
  await page.getByRole('link', { name: 'Flights', exact: true }).click();

  // People: another person to read the policy, and the administrator's own risk and report authority.
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });
  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill('Test Person');
  await add.getByLabel('Start from').selectOption({ label: 'Pilot' });
  await add.getByLabel('Sign-in account (subject)').fill('test-person');
  await add.getByRole('button', { name: 'Add person' }).click();
  await expect(area.getByText('Test Person was added. The addition is recorded.')).toBeVisible();
  await page.getByRole('link', { name: 'Flights', exact: true }).click();
  await grant(page, 'Test Administrator', ['Accept high risk', 'Read safety reports, including who reported']);

  // The matrix: from the standard form, renamed and edited, saved as a draft and signed.
  await openSafety(page);
  await onFile.getByRole('button', { name: 'Start a risk matrix', exact: true }).click();
  const matrix = page.getByRole('form', { name: 'Draft a risk matrix' });
  await matrix.getByLabel('Matrix name', { exact: true }).fill('Ridge survey risk matrix');
  await matrix.getByLabel('Severity 1', { exact: true }).fill('Negligible');
  await matrix
    .getByLabel('Level for Minor severity and Frequent likelihood', { exact: true })
    .selectOption({ label: 'High' });
  await matrix.getByRole('button', { name: 'Save the draft matrix', exact: true }).click();
  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: 'Ridge survey risk matrix', level: 2 })).toBeVisible();
  await expect(record).toContainText('Negligible');
  await page.getByRole('button', { name: 'Review and sign adoption', exact: true }).click();
  await expect(page.getByTestId('sms-signing')).toContainText('Ridge survey risk matrix');
  await sign(page, 'Our matrix for ridge survey work.', 'Test Administrator', 'Sign and adopt');
  await expect(record).toContainText('Version 1 adopted');

  // A hazard is recorded, a control proposed, the risk assessed and accepted under the granted authority.
  await page.getByRole('button', { name: /^Hazard register/ }).click();
  const identify = page.getByRole('form', { name: 'Identify a hazard' });
  await identify.getByLabel('Hazard', { exact: true }).fill('Loss of link behind the ridge');
  await identify
    .getByLabel('What could go wrong, and where')
    .fill('The link drops behind the ridge on the north line.');
  await identify.getByLabel('Worst credible outcome').fill('Uncontrolled descent onto the access road.');
  await identify.getByRole('button', { name: 'Record hazard' }).click();
  await expect(record.getByRole('heading', { name: 'Loss of link behind the ridge' })).toBeVisible();
  await page.getByRole('button', { name: 'Propose a control', exact: true }).click();
  const propose = page.getByRole('form', { name: 'Propose a control' });
  await propose.getByLabel('Control type').selectOption({ label: 'Described measure' });
  await propose.getByLabel('Control', { exact: true }).fill('Relay aircraft on the north line');
  await propose.getByLabel('Measure').fill('Fly a relay aircraft above the ridge on the north line.');
  await propose.getByRole('button', { name: 'Propose control' }).click();
  await expect(page.getByTestId('sms-hazard-controls')).toContainText('Relay aircraft on the north line');
  await page.getByRole('button', { name: 'Assess risk', exact: true }).click();
  const assess = page.getByRole('form', { name: 'Assess risk' });
  await assess.getByLabel('Severity').first().selectOption('catastrophic');
  await assess.getByLabel('Likelihood').first().selectOption('probable');
  await assess.getByLabel('Severity').nth(1).selectOption('hazardous');
  await assess.getByLabel('Likelihood').nth(1).selectOption('remote');
  await assess.getByLabel('We checked and found none').check();
  await assess.getByLabel('Basis for this assessment').fill('Assessed with the survey crew.');
  await assess.getByRole('button', { name: 'Record assessment' }).click();
  await expect(record.getByText('Awaiting risk acceptance', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review and sign acceptance', exact: true }).click();
  await sign(page, 'Accepted with the relay aircraft in place.', 'Test Administrator', 'Sign and accept risk');
  await expect(record.getByText('Risk accepted', { exact: true })).toBeVisible();

  // The safety policy is drafted, reviewed, signed and issued to the other person.
  await page.getByRole('button', { name: /^Safety home/ }).click();
  await onFile.getByRole('button', { name: 'Draft a safety policy', exact: true }).click();
  const draft = page.getByRole('form', { name: 'Record a document' });
  await draft.getByLabel('Title', { exact: true }).fill('Safety policy');
  await draft.getByLabel('Summary', { exact: true }).fill('Our commitment to safe survey work.');
  await draft
    .getByLabel(/^Document text/)
    .fill('We stop work whenever the link is in doubt, and report every concern.');
  await draft.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(record.getByRole('heading', { name: 'Safety policy', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  const review = page.getByRole('form', { name: 'Review document revision', exact: true });
  await review.getByLabel('Review note', { exact: true }).fill('Reviewed the text.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the working text and selected files for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await page.getByRole('button', { name: 'Review and sign adoption', exact: true }).click();
  await sign(page, 'Our policy from today.', 'Test Administrator', 'Sign and adopt');
  await page.getByRole('button', { name: 'Issue revision', exact: true }).click();
  const issue = page.getByRole('form', { name: 'Issue document revision', exact: true });
  await issue.getByRole('checkbox', { name: 'Test Person', exact: true }).check();
  await issue.getByLabel('Issue note', { exact: true }).fill('Issued to everyone who flies.');
  await issue
    .getByRole('checkbox', { name: 'I reviewed the signed revision, effective dates and named readers.', exact: true })
    .check();
  await issue.getByRole('button', { name: 'Issue now', exact: true }).click();
  await expect(page.getByTestId('sms-issued-document')).toContainText('0 of 1 acknowledged');

  // A safety report is recorded as received and read by the administrator, now cleared to read it.
  await page.getByRole('button', { name: /^Safety reports/ }).click();
  const report = page.getByRole('form', { name: 'Record a safety report' });
  await report.getByLabel('Short title', { exact: true }).fill('Aircraft drifted toward the road');
  await report.getByLabel('What was reported', { exact: true }).fill('The aircraft drifted toward the access road.');
  await report.getByLabel('How it was received').selectOption({ label: 'By phone' });
  await report.getByLabel('Name', { exact: true }).fill('Sam Field');
  await report.getByRole('button', { name: 'Record report', exact: true }).click();
  await record.getByRole('button', { name: 'Read the report', exact: true }).click();
  await expect(page.getByTestId('report-content')).toContainText('Sam Field');

  await page.getByRole('button', { name: /^Safety home/ }).click();
  for (const key of ['adopt', 'accept-low', 'accept-medium', 'accept-high', 'matrix', 'policy', 'reports'])
    await expect(onFile.getByTestId(`first-step-${key}`)).toContainText('On file');
  await expect(onFile).not.toContainText(/complete|ready|conform/i);

  // The other person acknowledges the policy and cannot see who made the report.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInAs(page, 'Test Person');
  await openSafety(page);
  await page
    .getByRole('region', { name: 'My reading', exact: true })
    .getByRole('button', { name: /Safety policy/ })
    .click();
  const reader = page.getByRole('dialog', { name: 'Document reader', exact: true });
  await reader
    .locator('summary')
    .filter({ hasText: /^Acknowledgement required/ })
    .click();
  const acknowledge = reader.getByRole('form', { name: 'Acknowledge document', exact: true });
  await acknowledge.getByRole('checkbox').first().check();
  await acknowledge.getByRole('button', { name: 'Record my acknowledgement', exact: true }).click();
  await expect(reader.getByRole('contentinfo')).toContainText('You acknowledged');
  await reader.getByRole('button', { name: 'Document record', exact: true }).click();
  await page.getByRole('button', { name: /^Safety reports/ }).click();
  await page.locator('[data-testid^="sms-row-"]').first().click();
  await expect(page.getByTestId('report-unreadable')).toContainText('needs permission to read safety reports');
  await expect(page.locator('body')).not.toContainText('Sam Field');
});
