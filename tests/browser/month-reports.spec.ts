import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// The two reports of a month: flight time by aircraft and the occurrences recorded. Each opens from Reports at an
// address of its own, shows the numbers the API counted, prints without the screen's choices, and leads to the entry
// form that records that a report was provided, with the period filled in. Runs on the seeded stack: the spec first
// records a month of its own through the import form, under ids of this run, in a month long before the seed's
// records, so its rows are told apart from those of an earlier run that happened to pick the same month.

const run = randomUUID().slice(0, 6).toUpperCase();
const id = (own: string) => `${run}-MR-${own}`;
/** A month of this run's own, between 2001 and 2019. */
const year = 2001 + (Number.parseInt(run.slice(0, 2), 16) % 19);
const monthNumber = 1 + (Number.parseInt(run.slice(2, 4), 16) % 12);
const pad = (value: number) => String(value).padStart(2, '0');
const month = `${year}-${pad(monthNumber)}`;
const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
const next = monthNumber === 12 ? `${year + 1}-01` : `${year}-${pad(monthNumber + 1)}`;
const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(
  new Date(Date.UTC(year, monthNumber - 1, 15)),
);

// Times are written as the organization's clocks read them, so the month is the organization's whatever its zone.
const files = {
  identity: [
    'subjectId,aircraftMakeModel,serialNumber,registrationNumber',
    `${id('AC-1')},Example Survey Quad X8,SN-${run}-1,REG-${run}-1`,
  ],
  flights: [
    'subjectId,secondarySubjectId,takeoffAt [local],landingAt [local],takeoffLocation,landingLocations,maxHeightFlownAboveGround [ft]',
    // An hour.
    `${id('FLT-1')},${id('AC-1')},${month}-10 09:00,${month}-10 10:00,North pad,North pad,200`,
    // Across midnight at the month's end: 45 minutes, all of them this month's.
    `${id('FLT-2')},${id('AC-1')},${month}-${lastDay} 23:40,${next}-01 00:25,North pad,North pad,200`,
    // Twenty minutes, on an aircraft with no identity record.
    `${id('FLT-3')},${id('AC-2')},${month}-12 09:00,${month}-12 09:20,Quarry gate,Quarry gate,200`,
    // A takeoff and no landing time.
    `${id('FLT-4')},${id('AC-2')},${month}-15 09:00,,Quarry gate,Quarry gate,200`,
    // The only flight of a third aircraft: 31 minutes.
    `${id('FLT-5')},${id('AC-3')},${month}-20 14:00,${month}-20 14:31,Quarry gate,Quarry gate,200`,
  ],
  anomalies: [
    'subjectId,subjectKind,secondarySubjectId,secondarySubjectKind,occurredAt [local],summary,interruptionKind',
    `${id('FLT-1')},flight,${id('AC-1')},aircraft,${month}-10 09:30,Landed at the north pad after a link warning,landing_away`,
    `${id('FLT-2')},flight,,,${month}-${lastDay} 23:50,Held over the ridge for a passing helicopter,`,
  ],
  irregularities: [
    'subjectId,subjectKind,occurredAt [local],irregularityDescription,correctiveAction',
    `${id('AC-2')},aircraft,${month}-12 09:10,Motor three ran warm,Replaced the motor`,
  ],
};

async function openAs(page: Page, address = '/') {
  await page.goto(address);
  await page.getByRole('radio', { name: 'Alpha Dispatch', exact: true }).check();
  await page.getByRole('button', { name: 'Open operations' }).click();
}

async function importFile(area: Locator, recordTypeTitle: string, name: string, lines: string[]) {
  const rows = lines.length - 1;
  const counted = `${rows} ${rows === 1 ? 'row' : 'rows'}`;
  await area.getByLabel('Record type', { exact: true }).selectOption({ label: recordTypeTitle });
  await area.getByRole('button', { name: 'Import a file', exact: true }).click();
  await area
    .getByLabel('File to import')
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) });
  await area.getByRole('button', { name: 'Check file', exact: true }).click();
  await area.getByRole('button', { name: `Record ${counted}`, exact: true }).click();
  await expect(area.getByText(new RegExp(`^Recorded ${rows} of ${counted}`))).toBeVisible();
}

const reportsNav = (page: Page) => page.getByRole('navigation', { name: 'Reports', exact: true });

test.describe.configure({ mode: 'serial' });

test('the month is recorded through the import form', async ({ page }) => {
  await openAs(page, '/records');
  const area = page.getByRole('main', { name: 'Operator records' });
  await importFile(area, 'Aircraft identity and registration', 'aircraft.identity.csv', files.identity);
  await importFile(area, 'Flight record', 'flight.record.csv', files.flights);
  await importFile(area, 'Operation anomaly', 'occurrence.operation-anomaly.csv', files.anomalies);
  await importFile(area, 'Mechanical irregularity', 'occurrence.mechanical-irregularity.csv', files.irregularities);
});

test('flight time by aircraft opens from Reports, counts the month, prints, and leads to the form', async ({
  page,
}) => {
  await openAs(page, '/reports');
  await page
    .getByRole('region', { name: 'Flight time by aircraft', exact: true })
    .getByRole('link', { name: 'Flight time of the last whole month', exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports\/flight-time$/);
  await expect(page).toHaveTitle('Flight time by aircraft · Reports · Ledger');
  await expect(reportsNav(page).getByRole('link', { name: 'Flight time by aircraft', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const report = page.getByTestId('flight-time-report');
  await expect(report).toBeVisible();
  await expect(report.getByText(/^Made .+ from the flight records on file\./)).toBeVisible();

  // The month of this run, chosen on the page: its address carries it.
  await page.getByLabel('Month', { exact: true }).fill(month);
  await page.getByRole('button', { name: 'Show this month', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/flight-time/${month}$`));
  await expect(page).toHaveTitle(`Flight time by aircraft ${month} · Reports · Ledger`);
  await expect(
    page.getByRole('heading', { name: `Flight time by aircraft, ${monthName} ${year}`, exact: true }),
  ).toBeVisible();

  // Two flights of the first aircraft, an hour and 45 minutes across midnight at the month's end.
  const first = report.locator(`[data-testid="flight-time-row"][data-aircraft="${id('AC-1')}"]`);
  await expect(first.getByRole('cell', { name: `REG-${run}-1`, exact: true })).toBeVisible();
  await expect(first.getByRole('cell', { name: `SN-${run}-1`, exact: true })).toBeVisible();
  await expect(first.getByRole('link', { name: `2 flights of ${id('AC-1')}`, exact: true })).toBeVisible();
  await expect(first.getByRole('cell', { name: '1 h 45 min', exact: true })).toBeVisible();
  // The identity record was imported today, long after this month: the row says so.
  await expect(
    first.getByText('Its identity record was recorded after the month ended.', { exact: true }),
  ).toBeVisible();

  // The second aircraft: no identity record, and a flight with no landing time, counted and adding no time.
  const second = report.locator(`[data-testid="flight-time-row"][data-aircraft="${id('AC-2')}"]`);
  await expect(second.getByRole('cell', { name: 'no identity record on file', exact: true })).toBeVisible();
  await expect(second.getByRole('link', { name: `2 flights of ${id('AC-2')}`, exact: true })).toBeVisible();
  await expect(second.getByRole('cell', { name: '0 h 20 min', exact: true })).toBeVisible();
  const missing = second.getByRole('list', { name: 'Flights that add no time', exact: true });
  await expect(missing.getByRole('listitem')).toHaveCount(1);
  await expect(missing.getByRole('listitem')).toContainText(
    'no landing time on file. In the flights, not in the time.',
  );
  await expect(missing.getByRole('link', { name: id('FLT-4'), exact: true })).toBeVisible();

  // One flight is read out as one flight.
  const third = report.locator(`[data-testid="flight-time-row"][data-aircraft="${id('AC-3')}"]`);
  await expect(third.getByRole('link', { name: `1 flight of ${id('AC-3')}`, exact: true })).toBeVisible();
  await expect(third.getByRole('cell', { name: '0 h 31 min', exact: true })).toBeVisible();

  // The total counts at least this run's five flights, and opens the list it counts.
  const total = report.getByTestId('flight-time-total').getByRole('link', { name: /^\d+ flights$/ });
  expect(Number.parseInt(await total.innerText(), 10)).toBeGreaterThanOrEqual(5);
  await expect(total).toHaveAttribute('href', '/records/browse/flight.record@1');
  await expect(
    report.getByText(
      /^A flight known only from a source’s report or from a plan, with no flight record, is not counted/,
    ),
  ).toBeVisible();

  // The table as a file: decimal hours to one place beside the exact seconds.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download as CSV', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(`flight-time-${month}.csv`);
  const stream = await saved.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const csv = Buffer.concat(chunks).toString('utf8').split('\r\n');
  expect(csv[0]).toBe(
    'month,timeZone,aircraftId,registrationNumber,serialNumber,flights,flightHours,flightSeconds,flightsWithoutTime,notes',
  );
  expect(csv.find((line) => line.includes(`,${id('AC-1')},`))).toContain(`,REG-${run}-1,SN-${run}-1,2,1.8,6300,0,`);
  expect(csv.find((line) => line.includes(`,${id('AC-2')},`))).toContain(
    `,,,2,0.3,1200,1,Aircraft: no identity record on file. Flight ${id('FLT-4')}: no landing time on file.`,
  );

  // On paper: the report, without the month's choice, the buttons or what to do next in Ledger.
  await page.emulateMedia({ media: 'print' });
  await expect(first).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print or save as PDF', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show this month', exact: true })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Record that this was sent', exact: true })).toBeHidden();
  await expect(reportsNav(page)).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  // The number of flights opens the aircraft's file under Records.
  await second.getByRole('link', { name: `2 flights of ${id('AC-2')}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/records/aircraft/${id('AC-2')}$`));
  await page.goBack();

  // Ledger sends nothing: the person records that they sent it, on the form with the period filled in.
  await page.getByRole('link', { name: 'Record that this was sent', exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/records/enter/organization\\.report@1\\?fill\\.periodStartsOn=${month}-01&fill\\.periodEndsOn=${month}-${lastDay}$`,
    ),
  );
  const form = page.getByRole('form', { name: 'Enter Report provided', exact: true });
  await expect(form.getByLabel(/^First day covered/)).toHaveValue(`${month}-01`);
  await expect(form.getByLabel(/^Last day covered/)).toHaveValue(`${month}-${lastDay}`);
  await expect(form.getByLabel(/^Kind of report/)).toHaveValue('');
  await expect(page.getByTestId('record-form-filled')).toHaveText(
    'Filled in from the page you came from: First day covered, Last day covered. Check them before you record.',
  );
});

test('occurrences by month open from Reports, list the month by type, and lead to the form', async ({ page }) => {
  await openAs(page, '/reports');
  await reportsNav(page).getByRole('link', { name: 'Occurrences by month', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/occurrences$/);
  await expect(page).toHaveTitle('Occurrences by month · Reports · Ledger');
  await expect(page.getByTestId('occurrences-report')).toBeVisible();

  await openAs(page, `/reports/occurrences/${month}`);
  await expect(page).toHaveTitle(`Occurrences ${month} · Reports · Ledger`);
  await expect(
    page.getByRole('heading', { name: `Occurrences recorded, ${monthName} ${year}`, exact: true }),
  ).toBeVisible();
  const report = page.getByTestId('occurrences-report');
  await expect(report.getByText(/^Made .+ from the occurrence records on file\./)).toBeVisible();

  // Every occurrence type is listed with what is on file for the month, a type with none too.
  const counts = page.getByTestId('occurrence-counts');
  const count = async (title: string) =>
    Number.parseInt(await counts.getByRole('link', { name: new RegExp(`^\\d+ ${title} records?$`) }).innerText(), 10);
  expect(await count('Operation anomaly')).toBeGreaterThanOrEqual(2);
  expect(await count('Mechanical irregularity')).toBeGreaterThanOrEqual(1);
  await expect(counts.getByRole('link', { name: /^\d+ Accident records?$/ })).toBeVisible();
  await expect(counts.locator('[data-testid="occurrence-type"][data-type="occurrence.operation-anomaly"]')).toHaveCount(
    1,
  );

  // Each occurrence: its date, the flight and aircraft it names in the organization's ids, and what was recorded.
  const anomalies = report.getByRole('region', { name: 'Operation anomaly', exact: true });
  const landed = anomalies
    .getByTestId('occurrence-row')
    .filter({ has: page.getByRole('link', { name: id('FLT-1'), exact: true }) });
  await expect(landed).toHaveCount(1);
  await expect(landed.getByRole('link', { name: id('AC-1'), exact: true })).toBeVisible();
  await expect(landed.getByText('Landed at the north pad after a link warning', { exact: true })).toBeVisible();
  await expect(
    landed.getByText('Unplanned or precautionary landing away from the normal landing location', { exact: true }),
  ).toBeVisible();
  // Ten to midnight on the month's last day is this month's.
  const held = anomalies
    .getByTestId('occurrence-row')
    .filter({ has: page.getByRole('link', { name: id('FLT-2'), exact: true }) });
  await expect(held).toHaveCount(1);
  await expect(held.getByText('Held over the ridge for a passing helicopter', { exact: true })).toBeVisible();
  const irregularities = report.getByRole('region', { name: 'Mechanical irregularity', exact: true });
  const warm = irregularities
    .getByTestId('occurrence-row')
    .filter({ has: page.getByRole('link', { name: id('AC-2'), exact: true }) });
  await expect(warm).toHaveCount(1);
  await expect(warm.getByText('Motor three ran warm', { exact: true })).toBeVisible();
  await expect(warm.getByText('Replaced the motor', { exact: true })).toBeVisible();
  await expect(
    report.getByText('Safety reports are not occurrence records: nothing of a safety report appears here.', {
      exact: true,
    }),
  ).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download as CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`occurrences-${month}.csv`);

  await page.emulateMedia({ media: 'print' });
  await expect(landed).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download as CSV', exact: true })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Record that this was sent', exact: true })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  await page.getByRole('link', { name: 'Record that this was sent', exact: true }).click();
  const form = page.getByRole('form', { name: 'Enter Report provided', exact: true });
  await expect(form.getByLabel(/^First day covered/)).toHaveValue(`${month}-01`);
  await expect(form.getByLabel(/^Last day covered/)).toHaveValue(`${month}-${lastDay}`);
});

test('a report of a month at phone width keeps to the screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const address of [`/reports/flight-time/${month}`, `/reports/occurrences/${month}`]) {
    await openAs(page, address);
    await expect(page.getByRole('main', { name: 'Reports', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'What this report counts', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, address).toBeLessThanOrEqual(0);
    // A row is a block of its own on a phone: no column of it is past the edge, to be found by scrolling sideways.
    const last = address.includes('flight-time')
      ? page.locator(`[data-testid="flight-time-row"][data-aircraft="${id('AC-1')}"]`).getByText('1 h 45 min')
      : page.getByTestId('occurrence-row').getByText('Motor three ran warm', { exact: true });
    await expect(last).toBeVisible();
    const box = (await last.boundingBox())!;
    expect(box.x, address).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, address).toBeLessThanOrEqual(375);
  }
});
