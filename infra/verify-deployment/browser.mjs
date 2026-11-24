// The verification's browser steps: a headless Chromium signs people in at Keycloak through the proxy, as a person
// would. The browser is given the local authority's server certificate by its public key, so nothing is added to the
// computer's trust store.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { organization, urls } from './settings.mjs';

export async function openBrowser(certificates) {
  const spki = readFileSync(`${certificates}/server.spki`, 'utf8').trim();
  const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  const context = await browser.newContext();
  context.setDefaultTimeout(30_000);
  return { browser, context };
}

/** Fills Keycloak's own sign-in form, on the page it opened or in the window Confirm it's you opened. */
async function keycloakSignIn(page, person) {
  await page.waitForURL((url) => url.host === new URL(urls.identityProvider).host);
  const password = page.getByLabel('Password', { exact: true });
  await password.waitFor();
  // Asked again, Keycloak shows who is signing in and asks for the password only.
  const username = page.getByRole('textbox', { name: 'Username or email', exact: true });
  if (await username.count()) await username.fill(person.username);
  await password.fill(person.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
}

/**
 * Signs a person in from Ledger's sign-in screen and returns the ID token the web app then sends, which the
 * command-line client uses for the same person until it expires.
 */
export async function signIn(context, person) {
  const page = await context.newPage();
  let token;
  page.on('request', (request) => {
    const header = request.headers().authorization;
    if (header?.startsWith('Bearer ') && request.url().startsWith(urls.web)) token = header.slice(7);
  });
  await page.goto(urls.web);
  await page.getByRole('heading', { name: organization.name }).waitFor();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await keycloakSignIn(page, person);
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'People', exact: true })
    .waitFor({ state: 'attached' })
    .catch(() => {});
  if (!token) await page.waitForRequest((request) => request.headers().authorization?.startsWith('Bearer '));
  return { page, token };
}

export async function signOut(page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await page.close();
}

/** Adds a person on the People screen, tied to their Keycloak account's ID. */
export async function addPerson(page, person) {
  await page.getByRole('button', { name: 'People', exact: true }).click();
  const area = page.getByRole('main', { name: 'People' });
  const add = area.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Name', { exact: true }).fill(person.name);
  await add.getByLabel('Start from').selectOption({ label: 'Pilot' });
  await add.getByLabel('Sign-in account (subject)').fill(person.subject);
  await add.getByRole('button', { name: 'Add person' }).click();
  await area.getByText(`${person.name} was added. The addition is recorded.`).waitFor();
  await area
    .getByRole('form', { name: `What ${person.name} may do` })
    .getByText('Tied to an identity-provider account')
    .waitFor();
  await page.getByRole('button', { name: 'Close people', exact: true }).click();
}

/** Signs on the signing screen, after a fresh sign-in at Keycloak in the window Confirm it's you opens. */
async function sign(page, person, rationale, button) {
  const form = page.getByRole('form', { name: 'Sign', exact: true });
  await form.getByLabel('I have reviewed the content and the intent statement.', { exact: true }).check();
  await form.getByRole('textbox').first().fill(rationale);
  const popup = page.waitForEvent('popup');
  await form.getByRole('button', { name: 'Confirm it’s you', exact: true }).click();
  const window = await popup;
  // Keycloak asks for the password again, though the person is signed in there: max_age=0 and prompt=login.
  await keycloakSignIn(window, person);
  await form.getByText(/You signed in again at/).waitFor();
  await form.getByRole('button', { name: button, exact: true }).click();
}

/**
 * Drafts, reviews, signs and issues the safety policy to the other person, as on the first day, and returns how the
 * signature says the signer's identity was confirmed: its method and when they signed in again.
 */
export async function signSafetyPolicy(page, signer, reader) {
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.getByRole('heading', { name: 'What needs attention' }).waitFor();
  const onFile = page.getByRole('region', { name: 'What is on file' });
  await onFile.getByRole('button', { name: 'Draft a safety policy', exact: true }).click();
  const draft = page.getByRole('form', { name: 'Record a document' });
  await draft.getByLabel('Title', { exact: true }).fill('Safety policy');
  await draft.getByLabel('Summary', { exact: true }).fill('Our commitment to safe survey work.');
  await draft
    .getByLabel(/^Document text/)
    .fill('We stop work whenever the link is in doubt, and report every concern.');
  await draft.getByRole('button', { name: 'Save draft', exact: true }).click();
  const record = page.getByTestId('sms-record');
  await record.getByRole('heading', { name: 'Safety policy', level: 2 }).waitFor();
  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  const review = page.getByRole('form', { name: 'Review document revision', exact: true });
  await review.getByLabel('Review note', { exact: true }).fill('Reviewed the text.');
  await review
    .getByRole('checkbox', { name: 'I reviewed the working text and selected files for this revision.', exact: true })
    .check();
  await review.getByRole('button', { name: 'Record review', exact: true }).click();
  await page.getByRole('button', { name: 'Review and sign adoption', exact: true }).click();
  await sign(page, signer, 'Our policy from today.', 'Sign and adopt');
  await record
    .locator('summary')
    .filter({ hasText: /^Decisions and signature/ })
    .click();
  await record
    .locator('summary')
    .filter({ hasText: /^Signed content, authority and digest$/ })
    .click();
  // A document's signature shows its signed record: how the signer confirmed who they are, and when they signed in.
  const signed = await record
    .getByText(/"reauthentication"/)
    .first()
    .innerText();
  const signature = JSON.parse(/"reauthentication": (\{[^}]*\})/.exec(signed)[1]);
  await page.getByRole('button', { name: 'Issue revision', exact: true }).click();
  const issue = page.getByRole('form', { name: 'Issue document revision', exact: true });
  await issue.getByRole('checkbox', { name: reader.name, exact: true }).check();
  await issue.getByLabel('Issue note', { exact: true }).fill('Issued to everyone who flies.');
  await issue
    .getByRole('checkbox', { name: 'I reviewed the signed revision, effective dates and named readers.', exact: true })
    .check();
  await issue.getByRole('button', { name: 'Issue now', exact: true }).click();
  await page.getByTestId('sms-issued-document').getByText('0 of 1 acknowledged').waitFor();
  await page.getByRole('button', { name: 'Return to flights', exact: true }).click();
  return signature;
}
