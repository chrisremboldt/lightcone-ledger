import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function openAs(page: Page, person: 'safety' | 'executive') {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Fictional Valley Power', exact: true }).check();
  await page.getByLabel('Person').selectOption(person);
  await page.getByRole('button', { name: 'Open operations' }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
}

test('a safety manager identifies and assesses a hazard and the accountable executive signs its acceptance', async ({
  page,
}) => {
  const title = `Link loss near energized line ${randomUUID().slice(0, 8)}`;
  await openAs(page, 'safety');
  const identify = page.getByRole('form', { name: 'Identify a hazard' });
  await identify.getByLabel('Hazard', { exact: true }).fill(title);
  await identify
    .getByLabel('What could go wrong, and where')
    .fill('The controller link degrades behind lattice towers at the fictional river crossing.');
  await identify.getByLabel('Worst credible outcome').fill('Uncontrolled descent onto an energized conductor.');
  await identify.getByRole('button', { name: 'Record hazard' }).click();

  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: title })).toBeVisible();
  await expect(record.getByText('Needs assessment', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Propose a control', exact: true }).click();
  const propose = page.getByRole('form', { name: 'Propose a control' });
  await propose.getByLabel('Control type').selectOption({ label: 'Described measure' });
  await propose.getByLabel('Control', { exact: true }).fill('Stand-off from energized conductors');
  await propose.getByLabel('Measure').fill('Keep 50 m from energized conductors.');
  await propose.getByRole('button', { name: 'Propose control' }).click();
  await expect(page.getByTestId('sms-hazard-controls')).toContainText('Keep 50 m from energized conductors.');
  await page.getByRole('button', { name: 'Assess risk', exact: true }).click();
  const assess = page.getByRole('form', { name: 'Assess risk' });
  await assess.getByLabel('Severity').first().selectOption('catastrophic');
  await assess.getByLabel('Likelihood').first().selectOption('probable');
  await expect(assess.getByLabel(/Stand-off from energized conductors/)).toBeChecked();
  await assess.getByLabel('Severity').nth(1).selectOption('hazardous');
  await assess.getByLabel('Likelihood').nth(1).selectOption('remote');
  await assess.getByLabel('We checked and found none').check();
  await assess.getByLabel('Basis for this assessment').fill('Assessed with the line crew lead.');
  await assess.getByRole('button', { name: 'Record assessment' }).click();
  await expect(record.getByText('Awaiting risk acceptance', { exact: true })).toBeVisible();
  await expect(record.getByText('High residual risk')).toBeVisible();
  await expect(page.getByTestId('accept-unavailable')).toContainText('Morgan Ellis can accept it');

  await page.getByRole('button', { name: 'Switch operator' }).click();
  await openAs(page, 'executive');
  const waiting = page.getByRole('region', { name: 'Signatures waiting on you' });
  await waiting.getByRole('button', { name: new RegExp(title) }).click();
  const signing = page.getByTestId('sms-signing');
  await expect(signing.getByRole('heading', { name: title })).toBeVisible();
  await expect(signing.getByTestId('sms-intent')).toContainText(
    `I, Morgan Ellis, accept the predicted residual risk of High for the hazard “${title}”`,
  );
  const sign = page.getByRole('form', { name: 'Sign' });
  await expect(signing).toContainText('Keep 50 m from energized conductors.');
  await expect(sign.getByRole('button', { name: 'Sign and accept risk' })).toBeDisabled();
  await sign.getByLabel('I have reviewed the content and the intent statement.').check();
  await sign.getByLabel('Rationale for accepting').fill('Accepted with the stand-off in place.');
  await sign.getByLabel('Fixture credential').fill('ledger-dev-utility-executive');
  await sign.getByRole('button', { name: 'Confirm it’s you' }).click();
  await expect(sign.getByText(/Confirmed\. Sign within five minutes/)).toBeVisible();
  await sign.getByRole('button', { name: 'Sign and accept risk' }).click();

  await expect(record.getByText('Risk accepted', { exact: true })).toBeVisible();
  const signature = page.getByTestId('sms-signature');
  await expect(signature).toContainText('I, Morgan Ellis, accept the predicted residual risk of High');
  await expect(signature).toContainText('Accepts high risk');
  await expect(signature).toContainText('Local fixture confirmation');
});

test('a safety manager proposes an avoidance area on a hazard with the map editor', async ({ page }) => {
  const title = `Crowds at the fictional market ${randomUUID().slice(0, 8)}`;
  await openAs(page, 'safety');
  const identify = page.getByRole('form', { name: 'Identify a hazard' });
  await identify.getByLabel('Hazard', { exact: true }).fill(title);
  await identify.getByLabel('What could go wrong, and where').fill('Crowds gather at the fictional market.');
  await identify.getByLabel('Worst credible outcome').fill('A forced landing among people.');
  await identify.getByRole('button', { name: 'Record hazard' }).click();
  const record = page.getByTestId('sms-record');
  await expect(record.getByRole('heading', { name: title })).toBeVisible();

  await page.getByRole('button', { name: 'Propose a control', exact: true }).click();
  const propose = page.getByRole('form', { name: 'Propose a control' });
  await propose.getByLabel('Control type').selectOption({ label: 'Route avoidance area' });
  const map = propose.getByTestId('hazard-control-map');
  await expect(map.getByRole('heading', { name: 'Avoidance area' })).toBeVisible();
  await expect(map.getByRole('button', { name: 'Refresh evidence locations' })).toHaveCount(0);
  await propose.getByLabel('Control', { exact: true }).fill('Keep routes clear of the market');
  await propose.getByLabel('Centre latitude').fill('41.8873');
  await propose.getByLabel('Centre longitude').fill('-87.6398');
  await propose.getByLabel('Proposed radius (m)').fill('250');
  await propose.getByLabel('Site (optional)').fill('Fictional market');
  await propose.getByRole('button', { name: 'Propose control' }).click();
  const controls = page.getByTestId('sms-hazard-controls');
  await expect(controls).toContainText('Route avoidance area');
  await expect(controls).toContainText(
    'Keep planned routes clear of the circle of 250 m around 41.8873, -87.6398 (Fictional market), at all altitudes.',
  );
});

test('an organization that flies keeps its hazard register and matrix in a Safety section beside its flights', async ({
  page,
}) => {
  const title = `Gusts over the fictional depot ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await expect(page.getByRole('searchbox', { name: 'Find flight' })).toBeVisible();

  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
  await expect(page.locator('.sms-program')).toContainText('Program safety risk matrix');
  // Documents appear once the organization records one; the adopted matrix lives in the program card.
  const nav = page.locator('.sms-nav-links');
  await expect(nav.getByRole('button', { name: /^Hazard register/ })).toBeVisible();

  await nav.getByRole('button', { name: /^Hazard register/ }).click();
  const identify = page.getByRole('form', { name: 'Identify a hazard' });
  await identify.getByLabel('Hazard', { exact: true }).fill(title);
  await identify.getByLabel('What could go wrong, and where').fill('Gusts funnel between the fictional depot sheds.');
  await identify.getByLabel('Worst credible outcome').fill('Loss of control on departure.');
  await identify.getByRole('button', { name: 'Record hazard' }).click();
  await expect(page.getByTestId('sms-record').getByRole('heading', { name: title })).toBeVisible();

  // The register lists it first: newest first.
  await page.getByRole('button', { name: 'Hazard register', exact: false }).first().click();
  await expect(page.locator('[data-testid^="sms-row-"]').first()).toContainText(title);

  await page.getByRole('button', { name: 'Return to flights', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Find flight' })).toBeVisible();
});

test('a safety manager searches, filters and orders the hazard register, and finds reports by reference only', async ({
  page,
}) => {
  const word = `Quarry${randomUUID().slice(0, 8)}`;
  await openAs(page, 'safety');
  for (const title of [`${word} dust on the optics`, `${word} blasting schedule`]) {
    const identify = page.getByRole('form', { name: 'Identify a hazard' });
    await identify.getByLabel('Hazard', { exact: true }).fill(title);
    await identify.getByLabel('What could go wrong, and where').fill('Fictional quarry operations near the route.');
    await identify.getByLabel('Worst credible outcome').fill('Loss of the fictional aircraft.');
    await identify.getByRole('button', { name: 'Record hazard' }).click();
    await expect(page.getByTestId('sms-record').getByRole('heading', { name: title })).toBeVisible();
    await page
      .getByRole('button', { name: /^Hazard register/ })
      .first()
      .click();
  }

  const rows = page.locator('[aria-label="Recorded hazards"] [data-testid^="sms-row-"]');
  await page.getByRole('searchbox', { name: 'Find hazards', exact: true }).fill(word.toLowerCase());
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(`${word} blasting schedule`);
  await page.getByLabel('Order', { exact: true }).selectOption('oldest');
  await expect(rows.first()).toContainText(`${word} dust on the optics`);
  await page.getByLabel('State', { exact: true }).selectOption('accepted');
  await expect(page.getByText('No hazards match. Try other words, another state or another order.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Find hazards', exact: true })).toHaveValue('');

  // A safety report's title is never searched: only the organization's own reference for it finds it.
  await page
    .getByRole('button', { name: /^Safety reports/ })
    .first()
    .click();
  const report = page.getByRole('form', { name: 'Record a safety report' });
  await report.getByLabel('Short title', { exact: true }).fill(`${word} crew saw a drone near the crusher`);
  await report.getByLabel('What was reported', { exact: true }).fill('A fictional account of what was seen.');
  await report.getByRole('button', { name: 'Record report', exact: true }).click();
  await page
    .getByRole('button', { name: /^Safety reports/ })
    .first()
    .click();
  await page.getByRole('searchbox', { name: 'Find reports', exact: true }).fill(word);
  await expect(page.getByText('No safety reports match. Try another reference, state or day.')).toBeVisible();
});
