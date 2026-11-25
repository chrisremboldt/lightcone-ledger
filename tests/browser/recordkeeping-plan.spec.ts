import { expect, test } from '@playwright/test';
import { ruleRow } from './rule-coverage-fixture.js';

// The records the adopted rules require, and a recordkeeping plan started from them, filled, signed and issued
// (docs/design/required-records.md). Alpha Dispatch adopts the proposed Part 108 pack in shadow first, if it has not;
// its dispatcher drafts, reviews, signs and issues. Each run starts a plan of its own; a later issue supersedes an
// earlier one.
const PLAN_RULE = 'ledger.nprm.108.505.b.7';

test('a dispatcher reads the required records, starts a recordkeeping plan, fills its blanks and issues it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();

  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  const rules = page.getByRole('main', { name: 'Rules and findings' });
  const adopted = rules.getByTestId('adoption').filter({ hasText: 'Part 108 NPRM checks (shadow only) · version 3' });
  if (!(await adopted.count())) {
    const form = rules.getByTestId('adopt-pack');
    await form.getByLabel('Rule pack').selectOption({
      label: 'Part 108 NPRM checks (shadow only) · version 3 · built into Ledger',
    });
    await expect(form.getByLabel(/^First day/)).toBeVisible();
    for (const [label, value] of [
      [/^Time zone/, 'America/Chicago'],
      [/^First day/, '1'],
      [/^Approved operating area centre latitude/, '41.8873'],
      [/^Approved operating area centre longitude/, '-87.6398'],
      [/^Approved operating area radius/, '5000'],
      [/^Margin beyond the approved operating area/, '100'],
    ] as const)
      for (const field of await form.getByLabel(label).all()) if (!(await field.inputValue())) await field.fill(value);
    await form.getByLabel('Reason, kept with the adoption', { exact: true }).fill('See what Part 108 asks us to keep.');
    await form.getByRole('button', { name: 'Adopt in shadow', exact: true }).click();
    await expect(adopted.getByText('In effect', { exact: true })).toBeVisible({ timeout: 60_000 });
  }
  await page.getByRole('link', { name: 'Flights', exact: true }).click();

  // What the adopted rules require, in their own words, with what is on file and how long the text says.
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  const area = page.getByRole('main', { name: 'Operator records' });
  await area
    .getByRole('navigation', { name: 'Records lists' })
    .getByRole('button', { name: 'Records your rules require', exact: true })
    .click();
  const required = area.getByRole('region', { name: 'Records your rules require' });
  const flights = required
    .getByTestId('required-record')
    .filter({ has: page.getByRole('heading', { name: 'Record of each flight', exact: true }) });
  await expect(flights).toContainText('Proposed 14 CFR 108.40(a)(3)');
  await expect(flights).toContainText('Each operator');
  await expect(flights).toContainText(/must be\s+maintained for a minimum of 24 months\./);
  await expect(flights).toContainText(/Flight record: (None on file\.|\d+ on file)/);
  await expect(required).toContainText('Ledger keeps every record and every correction and removes none.');

  // Starting the plan opens a draft controlled document; its blanks are visible as blanks.
  await required.getByRole('button', { name: 'Start a recordkeeping plan', exact: true }).click();
  await expect(required.getByText('Draft recordkeeping plan opened', { exact: true })).toBeVisible();
  await required.getByRole('button', { name: 'Open the draft plan', exact: true }).click();
  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: 'Recordkeeping plan', exact: true, level: 2 })).toBeVisible();
  await expect(record).toContainText('[To be filled in: the person or role responsible for keeping these records');

  // Reviewing it with a blank is refused, naming the first blank.
  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  const review = page.getByRole('form', { name: 'Review document revision', exact: true });
  await review.getByLabel('Review note', { exact: true }).fill('Reviewed the draft.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the working text and selected files for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await expect(page.getByText(/the first for the person or role responsible for keeping these records/)).toBeVisible();

  // The dispatcher fills every blank in a new revision, then reviews, signs and issues it.
  await page.getByRole('button', { name: 'Record a new revision', exact: true }).click();
  const revision = page.getByRole('form', { name: 'Record a new revision' });
  const text = revision.getByLabel(/^Document text/);
  await text.fill((await text.inputValue()).replace(/\[To be filled in: [^\]]+\]/g, 'Alpha Dispatch operations lead'));
  await revision
    .getByRole('textbox', { name: 'Reason for this revision', exact: true })
    .fill('Filled in who is responsible and where the deployment and its backups are.');
  await revision.getByRole('button', { name: 'Save version 2', exact: true }).click();
  await expect(record).not.toContainText('[To be filled in:');

  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  await review.getByLabel('Review note', { exact: true }).fill('Reviewed the filled plan.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the working text and selected files for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Reviewed, awaiting signature');

  await page.getByRole('button', { name: 'Review and sign adoption', exact: true }).click();
  const sign = page.getByRole('form', { name: 'Sign', exact: true });
  await sign.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await sign.getByLabel('Rationale for adopting', { exact: true }).fill('Adopted as our recordkeeping plan.');
  await sign.getByLabel('Fixture credential', { exact: true }).fill('ledger-dev-alpha-operator');
  await sign.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  await expect(sign.getByText(/Confirmed\. Sign within five minutes/)).toBeVisible();
  await sign.getByRole('button', { name: 'Sign and adopt', exact: true }).click();
  await expect(page.getByTestId('sms-working-document')).toContainText('Signed, ready to issue');

  await page.getByRole('button', { name: 'Issue revision', exact: true }).click();
  const issue = page.getByRole('form', { name: 'Issue document revision', exact: true });
  await issue.getByLabel('Issue note', { exact: true }).fill('Issued as the recordkeeping plan.');
  await issue
    .getByRole('checkbox', { name: 'I reviewed the signed revision, effective dates and named readers.', exact: true })
    .check();
  await issue.getByRole('button', { name: 'Issue now', exact: true }).click();
  await expect(page.getByTestId('sms-issued-document')).toBeVisible();

  // The recordkeeping-plan rule reads it as on file once the worker has evaluated it.
  await page.getByRole('link', { name: 'Rules', exact: true }).click();
  const row = await ruleRow(rules, PLAN_RULE);
  await expect(row).toContainText('Supported by the record', { timeout: 60_000 });
});
