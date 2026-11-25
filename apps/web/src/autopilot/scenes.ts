import { mode } from '../transport.js';
import { centralDateTimeInput } from '../sms-document-dates.js';
import { Locator, page } from './locators.js';
import type { Actor, Scene } from './player.js';
import trainingRecords from '../../../../packages/contracts/fixtures/operator-records/alpha-training-records.csv?raw';

const AVERY = 'Avery Chen · Safety manager';
const MORGAN = 'Morgan Ellis · Accountable executive';
const JORDAN = 'Jordan Reyes · Pilot';
const DANA = 'Dana Ortiz · Dispatcher, Alpha Dispatch';
const LEE = 'Lee Park · Dispatcher, Beta Inspection';
const SAM = 'Sam Rivera · Field crew, Alpha Dispatch';
const UTILITY = 'Fictional Valley Power';

/** A recording and its replay must use the same words and numbers; a live run varies them. */
const pick = (low: number, high: number, recorded: number) =>
  mode() === 'live' ? low + Math.floor(Math.random() * (high - low + 1)) : recorded;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** The map centres on the market's reference marker, which takes its own clicks; this is just beside it. */
const BESIDE_THE_MARKET = { x: 0.53, y: 0.53 };

interface Created {
  flight: { id: string };
}

/** The person's name in the bar, which opens their account. */
const account = new Locator('the account in the bar', () => [
  ...document.querySelectorAll('.topbar button.topbar-user'),
]);

/** Sign in on the local gate, leaving the current person first if someone is signed in. */
async function signIn(actor: Actor, operator: string, person: string): Promise<void> {
  if (account.element()) {
    await actor.click(account);
    await actor.click(page.button('Switch operator', { exact: true }));
  }
  await actor.tick(page.field(operator, { exact: true }));
  await actor.choose(page.field('Person', { exact: true }), person);
  await actor.click(page.button('Open operations', { exact: true }));
}

async function signInToUtility(actor: Actor, person: string): Promise<void> {
  await signIn(actor, UTILITY, person);
  await actor.see(page.heading('What needs attention'));
}

/** Prove identity with the fixture credential, as the signing form asks. */
async function confirmIdentity(actor: Actor, credential: string): Promise<void> {
  const sign = page.form('Sign');
  await actor.type(sign.field('Fixture credential'), credential);
  await actor.click(sign.button('Confirm it’s you'));
  await actor.see(sign.text(/Confirmed\. Sign within five minutes/));
}

/**
 * A fictional hazard at the fictional utility. The safety manager identifies and assesses it; the
 * residual risk is above the safety manager's authority, so the accountable executive signs.
 */
const hazard: Scene = {
  id: 'hazard',
  operator: 'utility',
  shows: 'Hazards and risk',
  title: 'A hazard is identified, assessed and accepted',
  summary: 'The safety manager records a hazard; its risk is too high for them to accept, so the executive signs.',
  async run(actor) {
    const title = `Link loss near energized line at Tower ${pick(10, 98, 41)}`;

    await actor.say(`Avery Chen runs the safety program at ${UTILITY}. Avery signs in.`, AVERY);
    await signInToUtility(actor, 'safety');

    await actor.say(
      'A line crew lead reported that the control link drops out behind the towers at the river crossing.',
    );
    await actor.say('Avery records it as a hazard. No flight is needed to raise one.');
    const identify = page.form('Identify a hazard');
    await actor.type(identify.field('Hazard', { exact: true }), title);
    await actor.type(
      identify.field('What could go wrong, and where'),
      'The controller link degrades behind lattice towers at the fictional river crossing.',
    );
    await actor.type(identify.field('Worst credible outcome'), 'Uncontrolled descent onto an energized conductor.');
    await actor.click(identify.button('Record hazard'));

    const record = page.testId('sms-record');
    await actor.see(record.text('Needs assessment', { exact: true }));
    await actor.say('The hazard is now a record. Ledger shows the next step: it needs a risk assessment.');

    await actor.say('Then a control to bring it down: a stand-off distance from energized conductors.');
    await actor.click(page.button('Propose a control', { exact: true }));
    const propose = page.form('Propose a control');
    await actor.type(propose.field('Control', { exact: true }), 'Stand-off from energized conductors');
    await actor.type(propose.field('Measure'), 'Keep 50 m from energized conductors.');
    await actor.click(propose.button('Propose control'));
    await actor.see(page.testId('sms-hazard-controls').text('Keep 50 m from energized conductors.'));

    await actor.click(page.button('Assess risk', { exact: true }));
    const assess = page.form('Assess risk');
    await actor.say('First, the risk as things stand today: catastrophic and probable.');
    await actor.choose(assess.field('Severity').nth(0), 'catastrophic');
    await actor.choose(assess.field('Likelihood').nth(0), 'probable');

    await actor.say('The assessment relies on the stand-off control just proposed.');

    await actor.say('With that control in place, Avery predicts hazardous but remote.');
    await actor.choose(assess.field('Severity').nth(1), 'hazardous');
    await actor.choose(assess.field('Likelihood').nth(1), 'remote');
    await actor.say('Ledger asks whether the control itself creates a new hazard. Avery checked and found none.');
    await actor.tick(assess.field('We checked and found none'));
    await actor.type(assess.field('Basis for this assessment'), 'Assessed with the line crew lead.');
    await actor.click(assess.button('Record assessment'));

    await actor.see(record.text('High residual risk'));
    await actor.say('Ledger works out the level from the adopted risk matrix: High. Avery did not choose it.');
    await actor.see(page.testId('accept-unavailable'));
    await actor.say('High is above Avery’s authority. Ledger names who can accept it: Morgan Ellis.');

    await actor.say('Morgan Ellis is the accountable executive. Morgan signs in.', MORGAN);
    await signInToUtility(actor, 'executive');

    const waiting = page.region('Signatures waiting on you');
    await actor.say('The acceptance is waiting for Morgan’s signature.');
    await actor.click(waiting.button(title));

    const signing = page.testId('sms-signing');
    await actor.see(signing.testId('sms-intent'));
    await actor.say('Morgan reads the exact statement the signature will be bound to.');

    const sign = page.form('Sign');
    await actor.tick(sign.field('I have reviewed the content and the intent statement.'));
    await actor.type(sign.field('Rationale for accepting'), 'Accepted with the stand-off in place.');
    await actor.say(
      'Before signing, Ledger asks Morgan to prove it is really Morgan. In this demonstration that is a fixture credential.',
    );
    await confirmIdentity(actor, 'ledger-dev-utility-executive');
    await actor.click(sign.button('Sign and accept risk'));

    await actor.see(record.text('Risk accepted', { exact: true }));
    await actor.see(page.testId('sms-signature'));
    await actor.say(
      'The record now carries the signed acceptance: who signed, under what authority, and the exact words.',
    );
    await actor.say('Nothing was edited along the way. Every step is a new entry in the record.');
  },
};

/**
 * Document control at the fictional utility: a procedure is written, reviewed, signed by the
 * executive, issued to a named reader, and personally acknowledged by that reader.
 */
const documents: Scene = {
  id: 'documents',
  operator: 'utility',
  shows: 'Controlled documents',
  title: 'A procedure is written, signed, issued and acknowledged',
  summary: 'A new procedure goes from draft to the pilot’s personal acknowledgement, each step tied to one revision.',
  async run(actor) {
    const title = `Battery handling procedure BH-${pick(100, 999, 204)}`;
    const body = [
      '# Before charging',
      'Inspect each pack for swelling, damage or heat. Set aside any pack that fails and record it as a discrepancy.',
      '# Charging',
      'Charge only in the marked bay, on the approved charger, with a person present. Never charge a pack that is warm from flight.',
      '# After flight',
      'Let packs rest until cool, then store them at storage charge in the fire-resistant cabinet.',
    ].join('\n\n');

    await actor.say(`Avery Chen keeps ${UTILITY}’s controlled documents. Avery signs in.`, AVERY);
    await signInToUtility(actor, 'safety');
    await actor.say('After a battery scare in the field, the program needs a written battery handling procedure.');
    await actor.click(page.button(/^Documents/));
    await actor.rest(700);
    if (page.button('Record a document', { exact: true }).element())
      await actor.click(page.button('Record a document', { exact: true }));

    const draft = page.form('Record a document');
    await actor.type(draft.field('Title', { exact: true }), title);
    await actor.choose(draft.field('Type', { exact: true }), 'procedure');
    await actor.type(draft.field('Revision label', { exact: true }), 'Revision 1');
    await actor.type(draft.field('Summary', { exact: true }), 'How crews inspect, charge and store flight batteries.');
    await actor.type(draft.field(/^Document text/), body);
    await actor.click(draft.button('Save draft', { exact: true }));

    const working = page.testId('sms-working-document');
    await actor.say('The draft is saved as Revision 1. Nobody can rely on it yet: it has to be reviewed first.');
    await actor.click(page.button('Review revision', { exact: true }));
    const review = page.form('Review document revision');
    await actor.type(
      review.field('Review note', { exact: true }),
      'Checked against the manufacturer’s battery guidance.',
    );
    await actor.tick(review.field('I reviewed the working text and selected files for this revision.'));
    await actor.click(review.button('Record review', { exact: true }));
    await actor.see(working.text('Reviewed, awaiting signature'));
    await actor.say(
      'Reviewed. Adopting a procedure is the accountable executive’s decision, so it now waits for Morgan.',
    );

    await actor.say('Morgan Ellis signs in.', MORGAN);
    await signInToUtility(actor, 'executive');
    await actor.click(page.region('Signatures waiting on you').button(title));
    const sign = page.form('Sign');
    await actor.say('Morgan sees the exact revision and the words the signature will be bound to.');
    await actor.tick(sign.field('I have reviewed the content and the intent statement.'));
    await actor.type(
      sign.field('Rationale for adopting', { exact: true }),
      'Adopted for every crew that handles packs.',
    );
    await confirmIdentity(actor, 'ledger-dev-utility-executive');
    await actor.click(sign.button('Sign and adopt', { exact: true }));
    await actor.see(working.text('Signed, ready to issue'));
    await actor.say('Signed. If the text changed now, the signature would no longer apply and Ledger would say so.');

    await actor.say('Avery issues the signed revision and names who must read it.', AVERY);
    await signInToUtility(actor, 'safety');
    await actor.click(page.button(/^Documents/));
    await actor.type(page.field('Find document', { exact: true }), title);
    await actor.click(page.labelled('Recorded documents').button(title));
    await actor.click(page.button('Issue revision', { exact: true }));
    const issue = page.form('Issue document revision');
    await actor.tick(issue.field('Jordan Reyes', { exact: true }));
    await actor.type(issue.field('Issue note', { exact: true }), 'Issued before the next inspection shift.');
    await actor.tick(issue.field('I reviewed the signed revision, effective dates and named readers.'));
    await actor.click(issue.button('Issue now', { exact: true }));
    await actor.see(page.testId('sms-issued-document').text('Revision 1 in force'));
    await actor.say('Revision 1 is in force. Ledger now tracks who has read it: so far, nobody.');

    await actor.say('Jordan Reyes is one of the pilots. Jordan signs in.', JORDAN);
    await signInToUtility(actor, 'pilot');
    await actor.say('The procedure is waiting under Jordan’s own reading.');
    await actor.click(page.region('My reading').button(title));
    const reader = page.dialog('Document reader');
    await actor.see(reader.text('# Before charging').nth(0), 8_000).catch(() => undefined);
    await actor.say('Jordan reads the issued text. Ledger checked it against the signed revision before showing it.');
    await actor.click(reader.text(/^Acknowledgement required/));
    const acknowledge = reader.form('Acknowledge document');
    await actor.tick(acknowledge.field(/^I have read/));
    await actor.click(acknowledge.button('Record my acknowledgement', { exact: true }));
    await actor.see(reader.text(/You acknowledged Revision 1 on/));
    await actor.say('The acknowledgement is personal and tied to Revision 1. A later revision will ask Jordan again.');
  },
};

/**
 * Flight operations at Alpha Dispatch: a delivery lands but no landing report arrives. Ledger's
 * adopted rule opens a finding; the dispatcher owns it, the late report arrives, and the dispatcher closes it.
 */
const landing: Scene = {
  id: 'landing',
  operator: 'alpha',
  shows: 'Rules and findings',
  title: 'A landing report goes missing',
  summary:
    'A rule check opens a finding by itself; the dispatcher owns it, the late report arrives, and the dispatcher closes it.',
  async run(actor) {
    const { flight } = await actor.happen<Created>('ledger-dev-alpha-operator', '/v1/flights', {
      originationKey: `demonstration:${crypto.randomUUID()}`,
      label: `Insulin restock · Ridge Pharmacy ${pick(100, 999, 318)}`,
      aircraft: 'Courier 7',
      scheduledStart: minutesFromNow(-30),
      // The adopted procedure allows five minutes after the scheduled end, so this is due in seconds.
      scheduledEnd: new Date(Date.now() + 15_000 - 5 * 60_000).toISOString(),
    });

    await actor.say('Dana Ortiz dispatches medical and parcel deliveries for Alpha Dispatch. Dana signs in.', DANA);
    await signIn(actor, 'Alpha Dispatch', 'operator');
    await actor.say('One delivery should have landed by now, but no landing report has reached Ledger.');
    await actor.click(page.button('Overdue', { exact: true }));
    await actor.click(page.testId(`flight-row-${flight.id}`));

    await actor.say(
      'Alpha adopted a procedure: record a landing time within five minutes of the scheduled end. Ledger checks it for every flight.',
    );
    const panel = page.testId('findings-panel');
    await actor.see(panel, 60_000);
    await actor.say(
      'The five minutes have passed. Ledger opens a finding by itself, and shows that nobody owns it yet.',
    );

    await actor.click(panel.button('Take responsibility', { exact: true }));
    let form = panel.testId('finding-treatment-form');
    await actor.type(form.field('What you will check'), 'I will get the landing report from the crew.');
    await actor.click(form.button('Take responsibility', { exact: true }));
    await actor.see(panel.text('Dana Ortiz owns this finding'));
    await actor.say('The finding now has an owner. It stays open until someone says what was found.');

    await actor.click(panel.button('Record response', { exact: true }));
    form = panel.testId('finding-treatment-form');
    await actor.type(form.field('Response and reason'), 'I asked the crew to send the landing report.');
    await actor.click(form.button('Record response', { exact: true }));
    await actor.see(panel.text(/^Treatment history · 2/));
    await actor.say('Dana records what was done. The finding stays open: the rule still has no landing time.');

    await actor.say('Then the crew’s landing report finally arrives from the field.');
    await actor.happen('ledger-dev-alpha-source', '/v1/inputs', {
      sourceId: `crew-app-${flight.id.slice(0, 8)}`,
      kind: 'flight.observation',
      occurredAt: new Date().toISOString(),
      subject: { flightId: flight.id },
      payload: { title: 'Crew landing report', activity: 'landed', landingTime: minutesFromNow(-12) },
    });
    await actor.see(panel.text('The latest result is supported by the record; a person closes this finding.'), 45_000);
    await actor.say(
      'Ledger re-ran the check on the new report: it clears. The landing was still reported late, so the finding stays open for Dana to close.',
    );
    await actor.click(panel.button('Close the finding', { exact: true }));
    form = panel.testId('finding-treatment-form');
    await actor.tick(form.field('The condition ended; what it reported still happened', { exact: true }));
    await actor.type(form.field('Why it is closed'), 'Landing evidence is now recorded and checked.');
    await actor.click(form.button('Close the finding', { exact: true }));
    await actor.see(panel.testId('finding-detail').text('Closed', { exact: true }));
    await actor.click(panel.text(/^Treatment history/));
    await actor.say(
      'Closed, with its history intact: what the rule found, who owned it, what was done and why it closed.',
    );
  },
};

/** The limitations the command-link adapter's descriptor states for every report it translates. */
const commandLinkStatusLimitations = [
  'Built from a synthetic source contract, not from a real aircraft or ground station.',
  'The source reports only transitions of the command and control link: lost becomes down and restored becomes up. It sends no samples between them.',
  'The incident id is the source’s own grouping of a loss with its restoration; it is carried as the episode id.',
  'The reported aircraft is the source’s own identifier, not a Ledger aircraft.',
  'Position, when present, is the source’s reported longitude and latitude in WGS84 degrees, without altitude.',
];

/**
 * Flight operations into safety management at Alpha Dispatch: a link monitor reports a lost
 * control link. The rule check opens a finding; the dispatcher promotes it to a hazard on the
 * safety record that stays tied to the flight and the exact evaluation, proposes an avoidance
 * area on the map and assesses its risk. A field crew member granted that risk level signs the
 * acceptance.
 */
const lostLink: Scene = {
  id: 'lostlink',
  operator: 'alpha',
  shows: 'From a finding to a control',
  title: 'A lost control link becomes a hazard',
  summary:
    'A link monitor reports a lost control link; the finding becomes a hazard, a control is proposed and its risk accepted.',
  async run(actor) {
    const operator = 'ledger-dev-alpha-operator';
    const monitor = 'ledger-dev-alpha-source';
    const run = pick(100, 999, 527);
    const sourceId = `link-monitor-${run}`;

    // Alpha's administrator allows the link monitor to report link status under its own source.
    interface Me {
      principal: {
        id: string;
        revision: number;
        capabilities: string[];
        observationGrants?: { sourceId: string; observationType: string }[];
      };
    }
    const { principal } = await actor.ask<Me>(monitor, '/v1/me');
    await actor.happen(operator, '/v1/commands', {
      kind: 'authority.update',
      principalId: principal.id,
      expectedRevision: principal.revision,
      capabilities: principal.capabilities,
      observationGrants: [...(principal.observationGrants ?? []), { sourceId, observationType: 'link.status' }],
    });

    const { flight } = await actor.happen<{ flight: { id: string; aircraft: string } }>(operator, '/v1/flights', {
      originationKey: `demonstration:${crypto.randomUUID()}`,
      label: `Parcel delivery · Canal Market ${run}`,
      aircraft: 'Courier 4',
      scheduledStart: minutesFromNow(-5),
      scheduledEnd: minutesFromNow(30),
    });

    /**
     * The link monitor sends its original report bytes first, then the link.status observation that cites them,
     * as the command-link adapter (packages/adapters/src/command-link-status.ts) translates the report.
     */
    const linkReport = async (status: 'lost' | 'restored', minutesAgo: number, extra: object = {}) => {
      const raw = {
        sourceSessionId: `link-session-${run}-${flight.id.slice(0, 8)}`,
        sourceEventId: `${status}-${flight.id.slice(0, 8)}`,
        incidentId: `link-incident-${flight.id.slice(0, 8)}`,
        aircraftId: flight.aircraft,
        occurredAt: minutesFromNow(-minutesAgo),
        status,
        ...extra,
      };
      const bytes = new TextEncoder().encode(`${JSON.stringify(raw)}\n`);
      const { upload } = await actor.happen<{ upload: { id: string } }>(monitor, '/v1/uploads', {
        contentType: 'application/json',
        byteLength: bytes.byteLength,
      });
      await actor.happen(monitor, `/v1/uploads/${upload.id}/content`, undefined, { method: 'PUT', bytes });
      const { artifact } = await actor.happen<{ artifact: { id: string } }>(
        monitor,
        `/v1/uploads/${upload.id}/finalize`,
      );
      const position = (raw as { position?: { longitude: number; latitude: number } }).position;
      await actor.happen(monitor, '/v1/inputs', {
        sourceId,
        kind: 'observation',
        occurredAt: raw.occurredAt,
        payload: {
          type: 'link.status',
          version: 1,
          subject: { kind: 'flight', id: flight.id, scope: 'ledger' },
          secondarySubject: { kind: 'aircraft', id: raw.aircraftId, scope: 'source' },
          occurredAt: raw.occurredAt,
          sourceEventId: raw.sourceEventId,
          sourceSessionId: raw.sourceSessionId,
          ...(position
            ? { position: { latitudeDegrees: position.latitude, longitudeDegrees: position.longitude } }
            : {}),
          values: {
            link: 'command_control',
            state: status === 'lost' ? 'down' : 'up',
            report: 'transition',
            sourceEpisodeId: raw.incidentId,
          },
          fidelity: 'synthetic_contract',
          limitations: commandLinkStatusLimitations,
          originalArtifactId: artifact.id,
        },
      });
    };
    await linkReport('lost', 2);

    await actor.say(
      'Dana Ortiz is dispatching for Alpha Dispatch when a delivery to Canal Market loses its control link.',
      DANA,
    );
    await signIn(actor, 'Alpha Dispatch', 'operator');
    await actor.click(page.testId(`flight-row-${flight.id}`));
    await actor.say(
      'The aircraft’s link monitor reported the loss to Ledger, with the original report kept byte for byte.',
    );
    const finding = page.testId('finding-detail');
    await actor.see(finding, 60_000);
    await actor.say('Alpha adopted a procedure for lost links, so Ledger opened a finding and asks for an owner.');
    await actor.click(finding.button('Show triggering evidence', { exact: true }));
    await actor.say(
      'The finding points at the exact report that triggered it. Nothing here is a summary of a summary.',
    );

    await actor.say('One lost link is an event. Dana judges it could happen again here, which makes it a hazard.');
    await actor.click(finding.button('Open safety workspace', { exact: true }));
    const title = `Control link loss near Canal Market ${run}`;
    const opening = page.form('Open a hazard from this finding');
    await actor.see(opening, 30_000);
    await actor.say(
      'The safety workspace opens on the safety record, with this finding and its evaluation as the origin.',
    );
    await actor.type(opening.field('Hazard', { exact: true }), title);
    await actor.type(
      opening.field('What could go wrong, and where'),
      'The control link dropped on approach to Canal Market. Buildings there may shadow the link on this route.',
    );
    await actor.type(opening.field('Worst credible outcome'), 'Uncontrolled descent over a busy market.');
    await actor.click(opening.button('Open hazard', { exact: true }));
    const record = page.testId('sms-record');
    await actor.see(record.testId('hazard-origin'), 30_000);
    await actor.say(
      'This is the one hazard record the safety program uses. It keeps its origin: this flight, this finding, and the evaluation Dana reviewed.',
    );

    await actor.click(page.button('Propose a control', { exact: true }));
    const proposal = page.form('Propose a control');
    await actor.choose(proposal.field('Control type', { exact: true }), 'control.avoidance-area@1');
    const label = `Avoid the Canal Market approach ${run}`;
    await actor.type(proposal.field('Control', { exact: true }), label);
    await actor.say(
      'Dana proposes an avoidance area. The loss report carried no position, so Dana places the center by hand at the market.',
    );
    const map = proposal.testId('hazard-control-map');
    await actor.choose(map.field(/^View an operating site/), 'Canal Market');
    await actor.type(map.field('Proposed radius (m)', { exact: true }), '150');
    await actor.click(map.button('Place center', { exact: true }));
    await actor.clickAt(
      map.labelled('Hazard evidence positions, historical observed track and mission corridor'),
      BESIDE_THE_MARKET,
    );
    await actor.see(map.testId('control-center-handle'));
    await actor.say('The radius is Dana’s precaution, not a measured radio boundary. It holds for the next half hour.');
    await actor.type(proposal.field('Until (CT, optional)'), centralDateTimeInput(minutesFromNow(30)).slice(0, 16));
    await actor.click(proposal.button('Propose control', { exact: true }));
    await actor.see(page.testId('sms-hazard-controls').text(label, { exact: true }), 30_000);

    await actor.click(page.button('Assess risk', { exact: true }));
    const assessment = page.form('Assess risk');
    await actor.say('As things stand, a lost link over a busy market is hazardous and probable.');
    await actor.choose(assessment.field('Severity').nth(0), 'hazardous');
    await actor.choose(assessment.field('Likelihood').nth(0), 'probable');
    await actor.say('With the avoidance area in place, Dana predicts major but remote.');
    await actor.choose(assessment.field('Severity').nth(1), 'major');
    await actor.choose(assessment.field('Likelihood').nth(1), 'remote');
    await actor.tick(assessment.field('We checked and found none'));
    await actor.type(
      assessment.field('Basis for this assessment'),
      'Judged on the evidence reported so far, with later routes kept clear of the market approach.',
    );

    await actor.say('While Dana assesses it, the monitor reports the link restored a minute later, with a position.');
    await linkReport('restored', 1, { position: { latitude: 41.8873, longitude: -87.6398 } });
    await actor.see(assessment.button('Refresh basis', { exact: true }), 45_000);
    await actor.say('The evidence changed, so Ledger asks Dana to look again before the assessment is recorded.');
    await actor.click(assessment.button('Refresh basis', { exact: true }));
    await actor.click(assessment.button('Record assessment', { exact: true }));
    await actor.see(record.text('Medium residual risk'), 30_000);
    await actor.see(page.testId('accept-unavailable'));
    await actor.say(
      'Ledger computed medium residual risk from the matrix. Accepting it needs a grant that Dana does not hold, so the record waits.',
    );

    // Alpha's administrator grants a field crew member the authority to accept medium risk.
    const { principal: crew } = await actor.ask<Me>('ledger-dev-alpha-actor', '/v1/me');
    if (!crew.capabilities.includes('risk:accept:medium'))
      await actor.happen(operator, '/v1/commands', {
        kind: 'authority.update',
        principalId: crew.id,
        expectedRevision: crew.revision,
        capabilities: [...crew.capabilities, 'risk:accept:medium'],
      });

    await actor.say(
      'Alpha’s administrator has given Sam Rivera, of the field crew, a grant to accept medium risk. Sam signs in.',
      SAM,
    );
    await signIn(actor, 'Alpha Dispatch', 'actor');
    await actor.click(page.testId(`flight-row-${flight.id}`));
    await actor.see(finding, 60_000);
    await actor.click(finding.button('Open safety workspace', { exact: true }));
    await actor.see(record.testId('sms-hazard-controls').text(label, { exact: true }), 30_000);
    await actor.say('The finding opens the same hazard record. Sam sees the assessment, the area and its origin.');

    await actor.click(page.button('Review and sign acceptance', { exact: true }));
    const sign = page.form('Sign');
    await actor.tick(sign.field('I have reviewed the content and the intent statement.'));
    await actor.type(
      sign.field('Rationale for accepting'),
      'Medium risk accepted with the avoidance area in place for its effective interval.',
    );
    await confirmIdentity(actor, 'ledger-dev-alpha-actor');
    await actor.click(sign.button('Sign and accept risk'));
    await actor.see(record.text('Risk accepted', { exact: true }), 30_000);
    await actor.see(page.testId('sms-signature'));
    await actor.say(
      'The record now holds the signed acceptance: who accepted the risk, under what grant, and the exact assessment and control it covers.',
    );
    await actor.say('Route review now names this area on any flight planned through it, until someone withdraws it.');
  },
};

/**
 * Flight operations at Beta Inspection: new evidence arrives while a dispatcher is writing a
 * decision. Ledger refuses the stale decision, keeps the draft, and records it after a fresh look.
 */
const decision: Scene = {
  id: 'decision',
  operator: 'beta',
  shows: 'Decisions on the record',
  title: 'New evidence arrives mid-decision',
  summary: 'A dispatcher’s decision is refused because the record changed underneath it, then recorded after review.',
  async run(actor) {
    const { flight } = await actor.happen<Created>('ledger-dev-beta-operator', '/v1/flights', {
      originationKey: `demonstration:${crypto.randomUUID()}`,
      label: `Power line patrol · Feeder ${pick(10, 99, 12)}`,
      aircraft: 'Surveyor 3',
      scheduledStart: minutesFromNow(-60),
      scheduledEnd: minutesFromNow(60),
    });
    const report = (title: string, minutesAgo: number, payload: Record<string, string>) =>
      actor.happen('ledger-dev-beta-source', '/v1/inputs', {
        sourceId: `crew-app-${flight.id.slice(0, 8)}`,
        kind: 'flight.observation',
        occurredAt: minutesFromNow(-minutesAgo),
        subject: { flightId: flight.id },
        payload: { title, ...payload },
      });
    await report('Crew report: airborne on the patrol', 0, { activity: 'active' });

    await actor.say('Lee Park dispatches infrastructure inspections for Beta Inspection. Lee signs in.', LEE);
    await signIn(actor, 'Beta Inspection', 'operator');
    await actor.say('A power line patrol is in the air. Lee opens it to record a decision on what has come in so far.');
    await actor.click(page.testId(`flight-row-${flight.id}`));
    await actor.see(page.testId('timeline-scroll'));

    await actor.click(page.button('Record decision', { exact: true }));
    const form = page.testId('decision-form');
    await actor.type(form.field('Decision rationale'), 'Patrol record reviewed; nothing outstanding to follow up.');

    await actor.say('Before Lee can record it, a second report arrives late from an observer, and it disagrees.');
    await report('Late observer report', 1, { activity: 'active', landingTime: minutesFromNow(-20) });
    await actor.see(form.text('record changed'), 45_000);
    await actor.say('Ledger tells Lee the record changed. Lee tries to record the decision anyway.');
    await actor.click(form.button('Record decision', { exact: true }));
    await actor.see(page.text('The viewed basis has changed', { exact: true }));
    await actor.say(
      'Refused. A decision is bound to exactly what its author saw, and Lee has not seen the new report.',
    );
    await actor.say('Nothing is lost: the draft is kept. Lee refreshes to see the new evidence.');
    await actor.click(form.button('Refresh basis'));
    await actor.say(
      'With the late report in view, Lee changes the decision: hold the record open until the times are reconciled.',
    );
    await actor.choose(form.field('Judgment'), 'hold');
    await actor.type(
      form.field('Decision rationale'),
      'Holding this record open until the observer and crew times are reconciled.',
    );
    await actor.click(form.button('Record decision', { exact: true }));
    await actor.see(page.text('Decision recorded with its input basis.', { exact: true }));
    await actor.say(
      'Recorded, together with the exact inputs Lee had on screen. That is what “what did we know” means.',
    );
  },
};

const ALPHA_OPERATOR = 'ledger-dev-alpha-operator';
const ALPHA_SOURCE = 'ledger-dev-alpha-source';
const ALPHA_CREW = 'ledger-dev-alpha-actor';

interface Principal {
  id: string;
  revision: number;
  capabilities: string[];
  observationGrants?: { sourceId: string; observationType: string }[];
  missionSources?: string[];
}

/** Alpha's administrator gives a person or source what it does not hold yet; what it already holds is left alone. */
async function extend(
  actor: Actor,
  token: string,
  wanted: {
    capabilities?: string[];
    observationGrants?: { sourceId: string; observationType: string }[];
    missionSources?: string[];
  },
): Promise<void> {
  const { principal } = await actor.ask<{ principal: Principal }>(token, '/v1/me');
  const granted = principal.observationGrants ?? [];
  const capabilities = (wanted.capabilities ?? []).filter((capability) => !principal.capabilities.includes(capability));
  const grants = (wanted.observationGrants ?? []).filter(
    (grant) =>
      !granted.some((held) => held.sourceId === grant.sourceId && held.observationType === grant.observationType),
  );
  const missionSources = (wanted.missionSources ?? []).filter((id) => !principal.missionSources?.includes(id));
  if (!capabilities.length && !grants.length && !missionSources.length) return;
  await actor.happen(ALPHA_OPERATOR, '/v1/commands', {
    kind: 'authority.update',
    principalId: principal.id,
    expectedRevision: principal.revision,
    capabilities: [...principal.capabilities, ...capabilities],
    ...(grants.length ? { observationGrants: [...granted, ...grants] } : {}),
    ...(missionSources.length ? { missionSources: [...(principal.missionSources ?? []), ...missionSources] } : {}),
  });
}

interface Coverage {
  adoptions: {
    pack: { packId: string; version: number; title: string };
    mode: string;
    state: string;
    revisedBy?: unknown;
    succeededBy?: unknown;
  }[];
}

/** An effective adoption of an earlier version of the pack, from an earlier run of the scene, not yet taken over. */
function earlierAdoption(shown: Coverage, pack: { id: string; version: number }) {
  return shown.adoptions.find(
    (adoption) =>
      adoption.pack.packId === pack.id &&
      adoption.pack.version < pack.version &&
      adoption.state === 'effective' &&
      !adoption.revisedBy &&
      !adoption.succeededBy,
  );
}

/**
 * Adopt one pack version on the Rules screen, with a mode and the values its rules ask for. A pack this organization
 * already adopted, from an earlier run of the scene, is shown rather than adopted again; an earlier version of it is
 * taken over by this one.
 */
async function adoptPack(
  actor: Actor,
  shown: Coverage,
  pack: { id: string; version: number; title: string },
  mode: 'active' | 'shadow',
  values: [label: RegExp, value: string][],
  note: string,
  /** Said once the form shows the adoption's dates. */
  dates?: string,
): Promise<void> {
  const card = page.testId('adoption').containing(`${pack.title} · version ${pack.version}`);
  if (shown.adoptions.some((adoption) => adoption.pack.packId === pack.id && adoption.pack.version === pack.version)) {
    await actor.see(card);
    return;
  }
  const earlier = earlierAdoption(shown, pack);
  if (earlier) {
    const held = page.testId('adoption').containing(`${earlier.pack.title} · version ${earlier.pack.version}`);
    await actor.click(held.button(`Adopt version ${pack.version}`, { exact: true }));
    const successor = page.testId('adopt-successor');
    await actor.type(successor.field('Reason, kept with the adoption', { exact: true }), note);
    await actor.click(successor.button(`Adopt version ${pack.version}`, { exact: true }));
    await actor.see(card.text('In effect', { exact: true }), 60_000);
    return;
  }
  const form = page.testId('adopt-pack');
  await actor.choose(form.field('Rule pack', { exact: true }), JSON.stringify([pack.id, pack.version]));
  if (dates) {
    await actor.see(form.field('From the start of', { exact: true }));
    await actor.say(dates);
  }
  if (mode === 'active') await actor.tick(form.field('Active: findings counted', { exact: true }));
  for (const [label, value] of values) {
    const field = form.field(label);
    const index = field.elements().findIndex((element) => !(element as HTMLInputElement).value);
    await actor.type(field.nth(Math.max(0, index)), value);
  }
  await actor.type(form.field('Reason, kept with the adoption', { exact: true }), note);
  await actor.click(form.button(`Adopt in ${mode}`, { exact: true }));
  // Recorded once its rules are in effect; the screen reads coverage again until then.
  await actor.see(card.text('In effect', { exact: true }), 60_000);
  // The next adoption waits for its rules' first evaluations, which would otherwise change its basis underneath it.
  await actor.gone(page.text(/^Recording is still in progress\./), 120_000);
}

/** The limitations the dock wind adapter's descriptor states for every reading it translates. */
const dockWindLimitations = [
  'Built from public documentation of the source’s periodic dock property message and exercised only against synthetic samples and an emulator; no bytes from a real dock have been checked.',
  'occurredAt is the dock’s own clock reading; when Ledger received the message is recorded separately.',
  'The wind is measured by the dock’s own sensor where the dock stands, at the dock’s height. It is not the wind at the aircraft or at the height flown. The subject is the site the adapter is configured to place the dock at.',
  'The speed is the value the dock reports, which its documentation states in meters per second, with no averaging period; gusts are not reported.',
  'The message does not say which dock model sent it; the model is the adapter’s configuration, and wind is translated only for the models whose documentation states meters per second. The first-generation model’s two official sources disagree on the scale, so its wind is refused.',
  'The direction is reported as one of eight compass sectors; it is not carried, because this observation records a direction in degrees and a sector is not one.',
];

/** Store a source's original bytes, as an adapter does before it reports what it read from them. */
async function original(actor: Actor, token: string, content: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(content)}\n`);
  const { upload } = await actor.happen<{ upload: { id: string } }>(token, '/v1/uploads', {
    contentType: 'application/json',
    byteLength: bytes.byteLength,
  });
  await actor.happen(token, `/v1/uploads/${upload.id}/content`, undefined, { method: 'PUT', bytes });
  const { artifact } = await actor.happen<{ artifact: { id: string } }>(token, `/v1/uploads/${upload.id}/finalize`);
  return artifact.id;
}

/**
 * A new problem type, end to end, at Alpha Dispatch: the dispatcher adopts the example wind limit, the dock at a
 * site reports the wind rising during a flight, and the rule names the reading. The finding becomes a hazard with
 * an operating limit on the wind; a crew member granted that risk level accepts it, and the next flight from the
 * dock lists the limit with its result.
 */
const wind: Scene = {
  id: 'wind',
  operator: 'alpha',
  shows: 'From a finding to a control',
  title: 'Wind at a dock rises above the adopted limit',
  summary:
    'A wind limit is adopted, the dock measures wind above it in flight, and the finding becomes a limit the next flight lists.',
  async run(actor) {
    const run = pick(100, 999, 236);
    const sourceId = `roof-dock-${run}`;
    const dockId = `DOCK${run}N`;
    const site = { id: `north-roof-${run}`, scope: 'source' };
    const takeoff = Date.now() - 6 * 60_000;
    const at = (seconds: number) => new Date(takeoff + seconds * 1000).toISOString();
    const sinceTakeoff = () => Math.floor((Date.now() - takeoff) / 1000);
    const shown = await actor.ask<Coverage>(ALPHA_OPERATOR, '/v1/organization/coverage');

    // Alpha's administrator lets the roof operations system report flight plans, flight reports and the dock's wind.
    await extend(actor, ALPHA_SOURCE, {
      observationGrants: ['operator.record', 'flight.report', 'weather.wind'].map((observationType) => ({
        sourceId,
        observationType,
      })),
    });
    const plan = async (label: string, start: string, end: string) => {
      const { flight } = await actor.happen<{ flight: { id: string } }>(ALPHA_OPERATOR, '/v1/flights', {
        originationKey: `demonstration:${crypto.randomUUID()}`,
        label,
        aircraft: 'Courier 9',
        scheduledStart: start,
        scheduledEnd: end,
      });
      return {
        flight,
        record: {
          type: 'operator.record',
          version: 1,
          subject: { kind: 'flight', id: flight.id, scope: 'ledger' },
          occurredAt: start,
          interval: { start, end },
          sourceEventId: `plan-${flight.id.slice(0, 8)}`,
          values: {
            recordType: 'flight.plan',
            recordVersion: 1,
            record: {
              windowStartsAt: start,
              windowEndsAt: end,
              operationKind: 'inspection',
              plannedOriginDescription: 'North roof dock',
              plannedDestinationDescription: 'North roof dock',
              routeSummary: 'Out and back along the roofline survey grid.',
              siteId: site,
            },
          },
        },
      };
    };
    const survey = await plan(`Roof survey ${run} · Dock 1`, at(-120), at(26 * 60));
    const following = await plan(`Roof survey ${run + 1} · Dock 1`, at(60 * 60), at(90 * 60));
    const airborne = {
      type: 'flight.report',
      version: 1,
      subject: { kind: 'flight', id: survey.flight.id, scope: 'ledger' },
      occurredAt: at(0),
      sourceEventId: `airborne-${survey.flight.id.slice(0, 8)}`,
      values: { activity: 'active', takeoffAt: at(0) },
    };
    const send = (
      artifactId: string,
      limitations: string[],
      observation: { occurredAt: string; [field: string]: unknown },
    ) =>
      actor.happen(ALPHA_SOURCE, '/v1/inputs', {
        sourceId,
        kind: 'observation',
        occurredAt: observation.occurredAt,
        payload: { ...observation, fidelity: 'synthetic_contract', limitations, originalArtifactId: artifactId },
      });
    // The operations system's export of the two plans and the crew's takeoff report, kept as it was sent.
    const exported = { flightPlans: [survey.record, following.record], flightReports: [airborne] };
    const exportId = await original(actor, ALPHA_SOURCE, exported);
    const entered = ['Entered in the fictional roof operations system by the crew.'];
    for (const [index, record] of exported.flightPlans.entries())
      await send(exportId, entered, {
        ...record,
        originalLocator: { kind: 'json_pointer', value: `/flightPlans/${index}` },
      });
    await send(exportId, entered, {
      ...airborne,
      originalLocator: { kind: 'json_pointer', value: '/flightReports/0' },
    });

    /** The dock's periodic messages, kept as sent, then each reading as the dock wind adapter translates it. */
    // The dock reports every forty seconds; a fixed number of readings keeps a recording's writes in order.
    const dock = async (speeds: number[], end = sinceTakeoff()) => {
      const messages = speeds.map((speed, index) => ({
        tid: crypto.randomUUID(),
        bid: crypto.randomUUID(),
        timestamp: Date.parse(at(end - 40 * (speeds.length - 1 - index))),
        gateway: dockId,
        data: {
          wind_speed: speed,
          wind_direction: 6,
          rainfall: 0,
          environment_temperature: 14.5,
        },
      }));
      const artifactId = await original(actor, ALPHA_SOURCE, messages);
      for (const [index, message] of messages.entries())
        await send(artifactId, dockWindLimitations, {
          type: 'weather.wind',
          version: 1,
          subject: { kind: 'site', ...site },
          occurredAt: new Date(message.timestamp).toISOString(),
          sourceEventId: message.tid,
          originalLocator: { kind: 'json_pointer', value: `/${index}/data` },
          values: { method: 'measured', speedMetersPerSecond: message.data.wind_speed },
        });
    };
    await dock([4.4, 4.6, 5.2, 5.8, 6.3, 6.9, 7.4, 7.9, 8.2], sinceTakeoff() - 100);

    await actor.say(
      'Dana Ortiz dispatches for Alpha Dispatch. Alpha now flies roof surveys from a dock that measures the wind.',
      DANA,
    );
    await signIn(actor, 'Alpha Dispatch', 'operator');
    await actor.say('First, a wind limit. Dana opens Rules, where Alpha adopts the rule packs it is checked against.');
    await actor.click(page.link('Rules', { exact: true }));
    await actor.see(page.testId('organization-coverage'), 30_000);
    await adoptPack(
      actor,
      shown,
      { id: 'ledger.example-weather', version: 2, title: 'Example weather procedures' },
      'active',
      [[/^Wind limit/, '10']],
      'Dock flights hold at 10 m/s of measured wind.',
    );
    await actor.say('Adopted as active, with Alpha’s own limit: 10 m/s at takeoff and for the whole flight.');
    await actor.click(page.link('Flights', { exact: true }));

    await actor.click(page.testId(`flight-row-${survey.flight.id}`));
    await actor.say('A survey from the north roof dock is in the air. The dock reports the wind, and it is rising.');
    await dock([8.6, 9.4, 12.6, 14.2]);
    const finding = page.testId('finding-detail');
    await actor.see(finding, 60_000);
    await actor.say('The rule checks each new reading. Ledger opens a finding: wind above the limit in flight.');
    await actor.see(finding.text(/the highest was 14\.2 m\/s/), 30_000);
    await actor.click(finding.text('What the check computed', { exact: true }));
    await actor.see(finding.text('14.2', { exact: true }));
    await actor.say(
      'It names the stretch above the limit and the highest reading in it: 14.2 m/s. Dana sees a hazard.',
    );
    await actor.see(finding.testId('evaluation-read-subject').text(`Site ${site.id}`, { exact: true }), 30_000);
    await actor.say('Below, the dock’s readings it relied on, listed under the north roof site they are about.');
    await actor.click(finding.button('Open safety workspace', { exact: true }));
    const opening = page.form('Open a hazard from this finding');
    await actor.see(opening, 30_000);
    const title = `Wind above the dock limit at north roof ${run}`;
    await actor.type(opening.field('Hazard', { exact: true }), title);
    await actor.type(
      opening.field('What could go wrong, and where'),
      'Gusts above 10 m/s at the north roof dock in flight.',
    );
    await actor.type(opening.field('Worst credible outcome'), 'Aircraft pushed into the building.');
    await actor.click(opening.button('Open hazard', { exact: true }));
    const record = page.testId('sms-record');
    await actor.see(record.testId('hazard-origin'), 30_000);
    await actor.say('The hazard keeps its origin: this flight, this finding and the exact evaluation.');

    await actor.click(page.button('Propose a control', { exact: true }));
    const proposal = page.form('Propose a control');
    await actor.choose(proposal.field('Control type', { exact: true }), 'control.operating-limit@1');
    const limit = `Wind limit at docks ${run}`;
    await actor.type(proposal.field('Control', { exact: true }), limit);
    await actor.say('An operating limit, stated in terms Ledger can check against the dock’s readings.');
    await actor.choose(proposal.field(/^Observation type/), 'weather.wind@1');
    await actor.choose(proposal.field(/^Field/), 'values.speedMetersPerSecond');
    await actor.say('Dana picks what the limit reads by name: the wind reading, and its wind speed.');
    await actor.choose(proposal.field(/^Comparison/), 'at_most');
    await actor.type(proposal.field(/^Limit/), '10');
    await actor.type(proposal.field(/^Unit/), 'm/s');
    await actor.choose(proposal.field(/^Applies to/), 'subject_kind');
    await actor.choose(proposal.field(/^Kind of subject/), 'site');
    await actor.click(proposal.button('Propose control', { exact: true }));
    await actor.see(page.testId('sms-hazard-controls').text(limit, { exact: true }), 30_000);

    await actor.click(page.button('Assess risk', { exact: true }));
    const assessment = page.form('Assess risk');
    await actor.say('Hazardous and probable today; major and remote with the limit.');
    await actor.choose(assessment.field('Severity').nth(0), 'hazardous');
    await actor.choose(assessment.field('Likelihood').nth(0), 'probable');
    await actor.choose(assessment.field('Severity').nth(1), 'major');
    await actor.choose(assessment.field('Likelihood').nth(1), 'remote');
    await actor.tick(assessment.field('We checked and found none'));
    await actor.type(assessment.field('Basis for this assessment'), 'From this flight’s readings.');
    await actor.click(assessment.button('Record assessment', { exact: true }));
    await actor.see(record.text('Medium residual risk'), 30_000);
    await actor.see(page.testId('accept-unavailable'));
    await actor.say('Ledger computes medium residual risk. Accepting it needs a grant Dana does not hold.');

    // Alpha's administrator grants a field crew member the authority to accept medium risk.
    await extend(actor, ALPHA_CREW, { capabilities: ['risk:accept:medium'] });
    await actor.say(
      'Alpha’s administrator has granted Sam Rivera, of the field crew, that authority. Sam signs in.',
      SAM,
    );
    await signIn(actor, 'Alpha Dispatch', 'actor');
    await actor.click(page.testId(`flight-row-${survey.flight.id}`));
    await actor.see(finding, 60_000);
    await actor.click(finding.button('Open safety workspace', { exact: true }));
    await actor.see(record.testId('sms-hazard-controls').text(limit, { exact: true }), 30_000);
    await actor.click(page.button('Review and sign acceptance', { exact: true }));
    const sign = page.form('Sign');
    await actor.tick(sign.field('I have reviewed the content and the intent statement.'));
    await actor.type(sign.field('Rationale for accepting'), 'Accepted with the wind limit.');
    await confirmIdentity(actor, ALPHA_CREW);
    await actor.click(sign.button('Sign and accept risk'));
    await actor.see(record.text('Risk accepted', { exact: true }), 30_000);
    // One new reading is enough for the accepted limit's rule to check the site.
    await dock([5.1]);
    await actor.say('Accepted, the limit becomes one of Alpha’s own rules. Sam checks the next survey from this dock.');
    await actor.click(page.button(/^Return to /));
    await actor.click(page.testId(`flight-row-${following.flight.id}`));
    await actor.click(page.button(/^Review mission route/));
    const controls = page.region('Controls in scope for this flight');
    await actor.see(controls.text(limit, { exact: true }), 30_000);
    await actor.see(controls.text('Pass', { exact: true }), 60_000);
    await actor.say(
      'Its release lists the wind limit with its result. A result blocks nothing; the person releasing decides.',
    );
  },
};

/**
 * Today's rules and tomorrow's at once, at Alpha Dispatch: the dispatcher adopts Part 107 and Alpha's waiver as
 * active and the proposed Part 108 in shadow, imports the crew's training records, and one flight's findings show
 * the counted results apart from the proposed ones. Its release lists only the counted findings.
 */
const rules: Scene = {
  id: 'rules',
  operator: 'alpha',
  shows: 'Rules and findings',
  title: 'One flight checked against today’s rules and proposed ones',
  summary:
    'Part 107 and a waiver are adopted as active and proposed Part 108 in shadow; one flight shows both, kept apart.',
  async run(actor) {
    const run = pick(1000, 9999, 4817);
    const person = (id: string) => ({ id: `R${run}-ALPHA-${id}`, scope: 'source' });
    const planner = `route-planner-${run}`;
    const shown = await actor.ask<Coverage>(ALPHA_OPERATOR, '/v1/organization/coverage');

    // Alpha's administrator lets the route planner submit missions, and Sam Rivera release flights.
    await extend(actor, ALPHA_SOURCE, { capabilities: ['mission:write'], missionSources: [planner] });
    await extend(actor, ALPHA_CREW, { capabilities: ['mission:release'] });
    const start = minutesFromNow(-1);
    const end = minutesFromNow(40);
    const { flight } = await actor.happen<{ flight: { id: string; label: string } }>(ALPHA_OPERATOR, '/v1/flights', {
      originationKey: `demonstration:${crypto.randomUUID()}`,
      label: `Prescription delivery ${run} · Eastside Clinic`,
      aircraft: 'Courier 2',
      scheduledStart: start,
      scheduledEnd: end,
    });
    const route = {
      sourceMissionId: `mission-${run}`,
      sourceRevision: 1,
      occurredAt: new Date().toISOString(),
      aircraftId: 'Courier 2',
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-87.63, 41.88],
            [-87.62155, 41.8844],
          ],
        },
      },
      lateralToleranceMeters: 30,
      altitude: { minimum: 45, maximum: 105, unit: 'm', reference: 'AGL' },
      operatingInterval: { start, end },
    };
    const routeId = await original(actor, ALPHA_SOURCE, route);
    const { sourceRevision, occurredAt, ...mission } = route;
    await actor.happen(ALPHA_SOURCE, '/v1/inputs', {
      kind: 'mission.revision',
      sourceId: planner,
      sourceRevision,
      occurredAt,
      subject: { flightId: flight.id },
      artifactId: routeId,
      fidelity: 'synthetic_contract',
      payload: mission,
    });

    // Alpha's planning tool exports the flight's plan and crew; it sends them once the rules are adopted.
    const subject = { kind: 'flight', id: flight.id, scope: 'ledger' };
    const planned: { recordType: string; record: Record<string, unknown> }[] = [
      {
        recordType: 'flight.plan',
        record: {
          windowStartsAt: start,
          windowEndsAt: end,
          operationKind: 'package_delivery',
          plannedOriginDescription: 'Alpha yard',
          plannedDestinationDescription: 'Eastside Clinic',
          routeSummary: 'Yard to the clinic roof pad and back.',
          visualMode: 'visual_line_of_sight',
          pilotInOperatingArea: 'yes',
          plannedMaxHeightAboveGroundMeters: 105,
          plannedMaxGroundSpeedMetersPerSecond: 18,
          plannedMaxDistanceFromControlStationMeters: 1300,
        },
      },
      ...(
        [
          ['PILOT-02', 'pilot_in_command', {}],
          ['OBSERVER-01', 'visual_observer', {}],
          ['PILOT-01', 'flight_coordinator', { handoverFromPersonId: person('PILOT-02') }],
        ] as const
      ).map(([id, role, extra]) => ({
        recordType: 'operation.role-assignment',
        record: { personId: person(id), role, startsAt: start, endsAt: end, ...extra },
      })),
    ];
    const exportId = await original(actor, ALPHA_OPERATOR, planned);

    await actor.say(
      'Dana Ortiz dispatches for Alpha Dispatch. Alpha flies under Part 107 and holds a waiver with limits of its own.',
      DANA,
    );
    await signIn(actor, 'Alpha Dispatch', 'operator');
    await actor.say('Part 108 is proposed, not in force. Dana wants to see how Alpha’s flights would fare under it.');
    await actor.click(page.link('Rules', { exact: true }));
    await actor.see(page.testId('organization-coverage'), 30_000);
    const timeZone: [RegExp, string] = [/^Time zone/, 'America/Chicago'];
    await adoptPack(
      actor,
      shown,
      { id: 'ledger.part107', version: 2, title: 'Part 107 checks (14 CFR as of 2026-01-01)' },
      'active',
      [timeZone],
      'The rules Alpha flies under today.',
    );
    await adoptPack(
      actor,
      shown,
      {
        id: 'ledger.example-waiver',
        version: 2,
        title: 'Example waiver EXW-0001 amendment 1 for Alpha Dispatch (fictional)',
      },
      'active',
      [],
      'The waiver Alpha holds, with its named pilots and limits.',
      'The form starts the adoption on the first and last day the certificate states.',
    );
    await actor.say('Both are active: what they find is counted. Now the proposed rule.');
    const part108 = { id: 'ledger.part108-nprm', version: 3, title: 'Part 108 NPRM checks (shadow only)' };
    if (!shown.adoptions.some((adoption) => adoption.pack.packId === part108.id)) {
      const form = page.testId('adopt-pack');
      await actor.choose(form.field('Rule pack', { exact: true }), JSON.stringify([part108.id, part108.version]));
      await actor.see(form.text(/can be adopted only in shadow/));
      await actor.say('The screen offers shadow only, and says why: this text is proposed, not in force.');
    }
    await adoptPack(
      actor,
      shown,
      part108,
      'shadow',
      [timeZone, [/^First day/, '1']],
      'To see what the proposed rule would find, without counting it.',
    );
    await actor.click(page.link('Flights', { exact: true }));
    for (const [index, { recordType, record }] of planned.entries())
      await actor.happen(ALPHA_OPERATOR, '/v1/inputs', {
        sourceId: 'operator-records',
        kind: 'observation',
        occurredAt: start,
        payload: {
          type: 'operator.record',
          version: 1,
          subject,
          occurredAt: start,
          interval: { start, end },
          sourceEventId: `${recordType}-${flight.id.slice(0, 8)}-${index}`,
          originalLocator: { kind: 'json_pointer', value: `/${index}` },
          values: { recordType, recordVersion: 1, record },
          fidelity: 'synthetic_contract',
          limitations: ['Exported from the fictional planning tool Alpha’s dispatchers use.'],
          originalArtifactId: exportId,
        },
      });

    await actor.say('The proposed rule asks more of training records. Dana imports the crew’s, as kept today.');
    await actor.click(page.link('Records', { exact: true }));
    const records = page.labelled('Operator records');
    await actor.choose(records.field('Record type', { exact: true }), 'person.training@1');
    await actor.click(records.button('Import a file', { exact: true }));
    await actor.attach(records.field('File to import', { exact: true }), {
      name: 'alpha-training-records.csv',
      type: 'text/csv',
      text: trainingRecords.replaceAll('ALPHA-', `R${run}-ALPHA-`),
    });
    await actor.click(records.button('Check file', { exact: true }));
    await actor.see(records.text(/4 of 5 rows can be recorded/), 30_000);
    await actor.say(
      'Ledger checks every row first. One has a date that does not exist, so it is refused, with the reason.',
    );
    await actor.click(records.button('Record 4 rows', { exact: true }));
    await actor.see(records.text(/Recorded 4 of 5 rows/), 30_000);
    await actor.click(page.link('Flights', { exact: true }));

    await actor.say(
      'A delivery to Eastside Clinic is about to leave. Its plan and crew came in from the planning tool.',
    );
    await actor.click(page.testId(`flight-row-${flight.id}`));
    const counted = page.testId('finding-detail');
    await actor.see(counted, 60_000);
    await actor.say(
      'Counted findings come from the active packs. The waiver names its pilots, and this flight’s pilot is not one.',
    );
    await actor.click(page.button(/^Height of at most 300 feet/));
    await actor.see(counted.text(/91\.44/));
    await actor.say(
      'And the waiver allows 300 feet, where Part 107 allows 400. The plan says 105 meters, about 344 feet.',
    );

    const proposed = page.testId('proposed-findings');
    // The proposed rules are evaluated after the counted ones; on a busy stack that takes a while.
    await actor.see(proposed, 90_000);
    await actor.say('Apart, and labelled: a proposed-rule result. It is recorded, and never counted.');
    await actor.click(proposed.text('The proposed text this rule checks', { exact: true }));
    await actor.see(proposed.testId('finding-rule-text').text(/./).nth(1));
    await actor.say('Opened, it quotes the proposed paragraph that a coordinator handover names its procedure.');
    await actor.see(proposed.testId('evaluation-read'));
    await actor.say('Below, the record it checked: the planned handover from the pilot to a coordinator names none.');

    await actor.say('Sam Rivera releases Alpha’s flights. Sam signs in.', SAM);
    await signIn(actor, 'Alpha Dispatch', 'actor');
    await actor.click(page.testId(`flight-row-${flight.id}`));
    await actor.click(page.button(/^Review mission route/));
    await actor.click(page.button('Prepare release', { exact: true }));
    await actor.see(page.testId('release-findings-counted'), 30_000);
    await actor.say('The release lists the counted findings. Sam records having seen them; they block nothing.');
    await actor.see(page.testId('release-findings-proposed'), 30_000);
    await actor.say(
      'The proposed-rule findings sit beside it, labelled, including the training record imported earlier. They are not part of the release.',
    );
  },
};

export const scenes: Scene[] = [hazard, documents, landing, lostLink, decision, wind, rules];

export const sceneById = (id: string | null): Scene | undefined => scenes.find((scene) => scene.id === id);
