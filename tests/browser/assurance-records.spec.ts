import { test, expect, type Page } from '@playwright/test';

/**
 * Safety assurance records on the screens (docs/design/assurance-records.md), for a new organization made with
 * `pnpm org:create`: an audit with two actions, one closed and one that opens a hazard, a review of safety performance,
 * and the counts the Part 108 pack reads in shadow. Its people sign in through the test issuer, so it needs a stack of
 * its own, set up as first-day-safety.spec.ts describes, on a database neither that spec nor openid-connect.spec.ts
 * used:
 *
 *   pnpm test-issuer
 *   LEDGER_OIDC_ISSUER=http://127.0.0.1:4010 LEDGER_OIDC_CLIENT_ID=ledger-local pnpm dev
 *   LEDGER_OIDC_ISSUER=http://127.0.0.1:4010 LEDGER_OIDC_CLIENT_ID=ledger-local pnpm org:create \
 *     --name "Example Ridge Survey" --time-zone America/Denver --admin "Test Administrator" \
 *     --sign-in-issuer http://127.0.0.1:4010 --sign-in-subject test-administrator
 *   LEDGER_BROWSER_TEST_ISSUER=http://127.0.0.1:4010 pnpm test:browser assurance-records
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
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
}

/** Signs on the signing screen: reviewed, a rationale, and a fresh sign-in at the issuer in its own window. */
async function sign(page: Page, rationale: string, person: string) {
  const form = page.getByRole('form', { name: 'Sign', exact: true });
  await form.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await form.getByRole('textbox').first().fill(rationale);
  const popup = page.waitForEvent('popup');
  await form.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  await (await popup).getByRole('link', { name: person, exact: true }).click();
  await expect(form.getByText(/You signed in again at/)).toBeVisible();
  await form.getByRole('button', { name: 'Sign the record', exact: true }).click();
}

/** A date relative to today, as a date input takes it. */
/** A calendar day counted from today in the organization's zone, America/Denver, as its screens read dates. */
function day(offset: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(Date.now() + offset * 86_400_000);
}

test.skip(!issuer, 'Set LEDGER_BROWSER_TEST_ISSUER to run against a stack configured with the test issuer');

test('a new organization records an audit and a review, closes an action, opens a hazard from another and reads the counts', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInAs(page, 'Test Administrator');

  // The proposed Part 108 pack in shadow, adopted first: it counts what goes on file from its start.
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const area = page.getByRole('main', { name: 'Rules and findings' });
  const adopted = area.getByTestId('adoption').filter({ hasText: 'Part 108 NPRM checks (shadow only) · version 3' });
  const adopt = area.getByTestId('adopt-pack');
  await adopt.getByLabel('Rule pack').selectOption({
    label: 'Part 108 NPRM checks (shadow only) · version 3 · built into Ledger',
  });
  await expect(adopt.getByLabel(/^First day/)).toBeVisible();
  for (const [label, value] of [
    [/^Time zone/, 'America/Denver'],
    [/^First day/, '1'],
    [/^Approved operating area centre latitude/, '39.7392'],
    [/^Approved operating area centre longitude/, '-104.9903'],
    [/^Approved operating area radius/, '5000'],
    [/^Margin beyond the approved operating area/, '100'],
  ] as const)
    for (const field of await adopt.getByLabel(label).all()) if (!(await field.inputValue())) await field.fill(value);
  await adopt.getByLabel('Reason, kept with the adoption', { exact: true }).fill('See what is on file for Part 108.');
  await adopt.getByRole('button', { name: 'Adopt in shadow', exact: true }).click();
  await expect(adopted.getByText('In effect', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Close rules', exact: true }).click();

  await openSafety(page);
  // Nothing fictional is on file for a new organization.
  await expect(page.getByRole('region', { name: 'Safety assurance actions due', exact: true })).toContainText(
    'No safety assurance action is due in the next 30 days or overdue.',
  );

  // The audit: two findings and two actions, recorded as a draft.
  await page.getByRole('button', { name: /^Safety assurance/ }).click();
  await page.getByRole('button', { name: 'Record a safety assurance record', exact: true }).click();
  const form = page.getByRole('form', { name: 'Record a safety assurance record', exact: true });
  await form
    .getByLabel('Kind of record', { exact: true })
    .selectOption({ label: 'Audit of operational processes and systems' });
  await form.getByLabel('Title', { exact: true }).fill('Preflight records audit, RIDGE-AUD-1');
  await form.getByLabel('Performed on', { exact: true }).fill(day(-1));
  await form.getByLabel('What it covered', { exact: true }).fill('Preflight records of the survey crews.');
  await form.getByLabel('What it looked at', { exact: true }).fill('Ten flight records of RIDGE-AC-1 and RIDGE-AC-2.');
  await form.getByRole('button', { name: 'Add a finding', exact: true }).click();
  await form.getByLabel('Finding F1', { exact: true }).fill('Two preflight assessments were signed after takeoff.');
  await form.getByRole('button', { name: 'Add a finding', exact: true }).click();
  await form.getByLabel('Finding F2', { exact: true }).fill('The battery log of RIDGE-AC-2 had gaps.');
  await form.getByRole('button', { name: 'Add an action', exact: true }).click();
  await form.getByLabel('Action A1', { exact: true }).fill('Brief the crews on signing before takeoff.');
  await form
    .getByRole('combobox', { name: 'Owner of action A1', exact: true })
    .selectOption({ label: 'Test Administrator' });
  await form.getByLabel('Due date of action A1', { exact: true }).fill(day(7));
  await form.getByRole('button', { name: 'Add an action', exact: true }).click();
  await form.getByLabel('Action A2', { exact: true }).fill('Find why the battery log has gaps.');
  await form
    .getByRole('combobox', { name: 'Owner of action A2', exact: true })
    .selectOption({ label: 'Test Administrator' });
  await form.getByLabel('Due date of action A2', { exact: true }).fill(day(-1));
  await form
    .getByRole('combobox', { name: 'Finding action A2 answers (optional)', exact: true })
    .selectOption({ label: 'F2' });
  await form.getByRole('button', { name: 'Record as a draft', exact: true }).click();

  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: 'Preflight records audit, RIDGE-AUD-1', level: 2 })).toBeVisible();
  await expect(record.getByTestId('assurance-action-A1')).toContainText('Set when signed');

  // Signed by the person with the authority to adopt safety documentation; signing sets the actions.
  await page.getByRole('button', { name: 'Review and sign', exact: true }).click();
  await expect(page.getByTestId('sms-signing')).toContainText('Actions your signature sets');
  await sign(page, 'The audit as it was done.', 'Test Administrator');
  await expect(record.getByTestId('assurance-facts')).toContainText('Version 1 signed');
  await expect(record.getByTestId('assurance-action-A2')).toContainText('Overdue');

  // The Safety home lists both actions under their owner, the overdue one first. The safety area is already open.
  await page.getByRole('button', { name: /^Safety home/ }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
  const due = page.getByRole('region', { name: 'Safety assurance actions due', exact: true });
  await expect(due.getByRole('heading', { name: 'Test Administrator', exact: true })).toBeVisible();
  await expect(due.getByRole('button').first()).toContainText('A2 · Find why the battery log has gaps.');
  await due.getByRole('button').first().click();

  // A1 is closed with what was done.
  await record.getByRole('button', { name: 'Close action A1', exact: true }).click();
  const close = record.getByRole('form', { name: 'Close action A1', exact: true });
  await close.getByLabel('What was done', { exact: true }).fill('Briefed all three crews.');
  await close.getByRole('button', { name: 'Close action A1', exact: true }).click();
  await expect(record.getByTestId('assurance-action-A1')).toContainText('Closed by Test Administrator');

  // A2 opens a hazard that keeps it as its origin.
  await record.getByRole('button', { name: 'Open a hazard from action A2', exact: true }).click();
  const hazard = record.getByRole('form', { name: 'Open a hazard from action A2', exact: true });
  await hazard.getByLabel('Hazard', { exact: true }).fill('Battery state unknown at launch');
  await hazard
    .getByLabel('What could go wrong, and where', { exact: true })
    .fill('Gaps in the battery log leave the state of charge at launch unknown.');
  await hazard.getByLabel('Worst credible outcome', { exact: true }).fill('Loss of power over the survey area.');
  await hazard.getByRole('button', { name: 'Open the hazard', exact: true }).click();
  await expect(record.getByRole('heading', { name: 'Battery state unknown at launch', level: 2 })).toBeVisible();
  await expect(page.getByTestId('hazard-origin')).toContainText('Opened from action A2 of version 1');

  // A review of safety performance by the accountable executive, signed.
  await page.getByRole('button', { name: /^Safety assurance/ }).click();
  await page.getByRole('button', { name: 'Record a safety assurance record', exact: true }).click();
  await form
    .getByLabel('Kind of record', { exact: true })
    .selectOption({ label: 'Review of safety performance by the accountable executive' });
  await form.getByLabel('Title', { exact: true }).fill('Quarterly review of safety performance');
  await form.getByLabel('Performed on', { exact: true }).fill(day(0));
  await form.getByLabel('What it covered', { exact: true }).fill('Safety performance of the survey operation.');
  await form.getByLabel('What it looked at', { exact: true }).fill('The hazard register and the open actions.');
  await form.getByRole('button', { name: 'Record as a draft', exact: true }).click();
  await expect(record.getByRole('heading', { name: 'Quarterly review of safety performance', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Review and sign', exact: true }).click();
  await sign(page, 'The review as it was held.', 'Test Administrator');
  await expect(record.getByTestId('assurance-facts')).toContainText('Version 1 signed');
  await page.getByRole('button', { name: 'Return to flights', exact: true }).click();

  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  const row = area.locator('[data-testid="rule-coverage-row"][data-rule="ledger.nprm.108.560.a.safety-assurance"]');
  await row.getByRole('button', { name: '1 · Supported by the record', exact: true }).click({ timeout: 60_000 });
  const subjects = area.getByTestId('rule-subjects');
  await expect(subjects).toContainText('2 signed safety assurance records on file since');
  await expect(subjects).toContainText('audits of operational processes and systems: 1');
  await expect(subjects).toContainText('reviews of safety performance by the accountable executive: 1');
  await expect(subjects).toContainText('Actions they set: 1 open, 1 of them past the due date.');
});
