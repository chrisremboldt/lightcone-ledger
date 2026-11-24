export interface Copy {
  label: string;
  value: string;
}

export interface Step {
  as: string;
  title: string;
  text: string;
  copy?: Copy[];
}

const CREDENTIAL = 'ledger-dev-utility-executive';
const fixtures = __LEDGER_FIXTURES__;
const AVERY = 'Avery Chen · Safety manager';
const MORGAN = 'Morgan Ellis · Accountable executive';
const JORDAN = 'Jordan Reyes · Pilot';

function signIn(person: string): string {
  return `Click Switch operator (top right), choose Fictional Valley Power, pick ${person} and click Open operations.`;
}

const credential = { label: 'Fixture credential', value: CREDENTIAL };

export const steps: Step[] = [
  {
    as: AVERY,
    title: 'Sign in as the safety manager',
    text: `Choose Fictional Valley Power, pick ${AVERY} and click Open operations. Use ← and → (or the arrows above) to move between steps, and drag this card by its bar.`,
  },
  {
    as: AVERY,
    title: 'Review the safety policy',
    text: 'On Safety home, under Documents to review or issue, open Drone program safety policy. Click Review revision, enter the note, tick the confirmation and click Record review.',
    copy: [{ label: 'Review note', value: 'Checked the objectives, code of ethics and management commitment.' }],
  },
  {
    as: MORGAN,
    title: 'Sign the policy as the executive',
    text: `${signIn(MORGAN)} Under Signatures waiting on you, open the policy. Tick that you reviewed it, enter the rationale and credential, click Confirm it’s you, then Sign and adopt.`,
    copy: [
      { label: 'Rationale for adopting', value: 'Adopted as the safety policy for our drone program.' },
      credential,
    ],
  },
  {
    as: AVERY,
    title: 'Issue the policy',
    text: `${signIn(AVERY)} Under Documents to review or issue, open the policy and click Issue revision. Tick Jordan Reyes as a reader, enter the note, tick the confirmation and click Issue now.`,
    copy: [{ label: 'Issue note', value: 'Issued to every pilot in the program.' }],
  },
  {
    as: JORDAN,
    title: 'Acknowledge the policy as the pilot',
    text: `${signIn(JORDAN)} Under My reading, open the policy. In the reader, click Acknowledge, tick the box and click Record my acknowledgement.`,
  },
  {
    as: AVERY,
    title: 'Identify a hazard',
    text: `${signIn(AVERY)} On Safety home, fill in Identify a hazard and click Record hazard.`,
    copy: [
      { label: 'Hazard', value: 'Link loss near energized line' },
      {
        label: 'What could go wrong, and where',
        value: 'The controller link degrades behind lattice towers at the river crossing.',
      },
      { label: 'Worst credible outcome', value: 'Uncontrolled descent onto an energized conductor.' },
    ],
  },
  {
    as: AVERY,
    title: 'Assess its risk',
    text: 'On the hazard, click Propose a control. Keep the Described measure type, fill in the control and its measure, and click Propose control. Then click Assess risk. Initial risk: Catastrophic and Probable. Keep the stand-off control ticked. Residual risk: Hazardous and Remote. Choose We checked and found none, enter the basis and click Record assessment.',
    copy: [
      { label: 'Control', value: 'Stand-off from energized conductors' },
      { label: 'Measure', value: 'Keep 50 m from energized conductors.' },
      { label: 'Basis for this assessment', value: 'Assessed with the line crew lead at the river crossing.' },
    ],
  },
  {
    as: MORGAN,
    title: 'Accept the residual risk',
    text: `${signIn(MORGAN)} Under Signatures waiting on you, open the hazard. Tick that you reviewed it, enter the rationale and credential, click Confirm it’s you, then Sign and accept risk.`,
    copy: [{ label: 'Rationale for accepting', value: 'Accepted with the 50 m stand-off in place.' }, credential],
  },
  {
    as: AVERY,
    title: 'Record the manufacturer’s manual',
    text: `${signIn(AVERY)} Go to Documents and click Record a document. Origin: Received from another organization. Type: OEM manual. Fill in the rest and click Save draft.`,
    copy: [
      { label: 'Title', value: 'Aircraft inspection manual' },
      { label: 'Document number', value: 'FVP-OEM-100' },
      { label: 'Revision label', value: 'OEM Revision 4' },
      { label: 'Issuing organization', value: 'Fictional Aircraft Company' },
      { label: 'Source revision', value: '4' },
      { label: 'Issuer’s summary', value: 'Consolidated the routine preflight and postflight inspection steps.' },
      { label: 'Why we are adopting it', value: 'Inspection instructions for every FAC Scout 4 in our fleet.' },
    ],
  },
  {
    as: AVERY,
    title: 'Attach the Revision 4 PDF',
    text: 'On the manual, click Attach a file and choose the PDF. In the file picker, press ⌘⇧G and paste the path. Enter the description and click Attach file.',
    copy: [
      { label: 'File path', value: `${fixtures}aircraft-inspection-manual-revision-4.pdf` },
      { label: 'Description', value: 'OEM Revision 4 manual' },
    ],
  },
  {
    as: AVERY,
    title: 'Review OEM Revision 4',
    text: 'Click Review revision, select the OEM Revision 4 manual file, enter the note, tick the confirmation and click Record review.',
    copy: [{ label: 'Review note', value: 'Checked against the manufacturer’s release.' }],
  },
  {
    as: MORGAN,
    title: 'Sign OEM Revision 4',
    text: `${signIn(MORGAN)} Under Signatures waiting on you, open the manual. Tick that you reviewed it, enter the rationale and credential, click Confirm it’s you, then Sign and adopt.`,
    copy: [{ label: 'Rationale for adopting', value: 'Adopted for the FAC Scout 4 fleet.' }, credential],
  },
  {
    as: AVERY,
    title: 'Issue OEM Revision 4',
    text: `${signIn(AVERY)} Under Documents to review or issue, open the manual and click Issue revision. Tick Jordan Reyes, enter the note, tick the confirmation and click Issue now.`,
    copy: [{ label: 'Issue note', value: 'Issued to FAC Scout 4 pilots.' }],
  },
  {
    as: JORDAN,
    title: 'Acknowledge OEM Revision 4',
    text: `${signIn(JORDAN)} Under My reading, open the manual. In the reader, click Acknowledge, tick the box and click Record my acknowledgement.`,
  },
  {
    as: AVERY,
    title: 'Record OEM Revision 5',
    text: `${signIn(AVERY)} Go to Documents, open the manual and click Record a new revision. Fill it in and click Save version.`,
    copy: [
      { label: 'Revision label', value: 'OEM Revision 5' },
      { label: 'Source revision', value: '5' },
      {
        label: 'Issuer’s summary',
        value: 'Added a preflight rotor brake condition check and a requirement to record its result after landing.',
      },
      {
        label: 'Why we are adopting it',
        value: 'The manufacturer added a rotor brake check that applies to every FAC Scout 4 in our fleet.',
      },
    ],
  },
  {
    as: AVERY,
    title: 'Attach the Revision 5 PDF',
    text: 'Click Attach a file and choose the PDF (⌘⇧G in the picker, paste the path). Enter the description and click Attach file.',
    copy: [
      { label: 'File path', value: `${fixtures}aircraft-inspection-manual-revision-5.pdf` },
      { label: 'Description', value: 'OEM Revision 5 manual' },
    ],
  },
  {
    as: AVERY,
    title: 'Compare the revisions',
    text: 'Under the working revision, click Compare. Ledger shows the pages whose wording changed; Show whole page expands one.',
  },
  {
    as: AVERY,
    title: 'Review OEM Revision 5',
    text: 'Click Review revision, select only the OEM Revision 5 manual file, enter the note, tick the confirmation and click Record review.',
    copy: [{ label: 'Review note', value: 'Checked the rotor brake changes against the manufacturer’s highlights.' }],
  },
  {
    as: MORGAN,
    title: 'Sign OEM Revision 5',
    text: `${signIn(MORGAN)} Under Signatures waiting on you, open the manual. Tick, enter the rationale and credential, click Confirm it’s you, then Sign and adopt.`,
    copy: [
      { label: 'Rationale for adopting', value: 'Adopted the rotor brake check for the FAC Scout 4 fleet.' },
      credential,
    ],
  },
  {
    as: AVERY,
    title: 'Issue OEM Revision 5',
    text: `${signIn(AVERY)} Under Documents to review or issue, open the manual and click Issue revision. Tick Jordan Reyes, enter the note, tick the confirmation and click Issue now. Revision 5 replaces Revision 4.`,
    copy: [{ label: 'Issue note', value: 'Issued with the new rotor brake check.' }],
  },
  {
    as: JORDAN,
    title: 'Acknowledge OEM Revision 5',
    text: `${signIn(JORDAN)} Under My reading, open the manual. The reader shows what changed. Click Acknowledge, tick the box and click Record my acknowledgement.`,
  },
  {
    as: AVERY,
    title: 'Export the verifiable record',
    text: `${signIn(AVERY)} Go to Documents, open the manual and click Export verifiable record.`,
  },
];
