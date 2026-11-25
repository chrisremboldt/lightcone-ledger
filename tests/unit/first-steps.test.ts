import { describe, expect, it } from 'vitest';
import type {
  AdoptionRuleCoverageResponse,
  NamedSubject,
  PackAdoptionRecord,
  SmsHomeResponse,
  SmsRecordSummary,
} from '../../packages/contracts/src/index.js';
import {
  ACCEPTED_CONTROL_PACK_ID,
  OPERATOR_RECORD_SOURCE_ID,
  standardRiskMatrix,
} from '../../packages/contracts/src/index.js';
import {
  coverageLine,
  firstDaySteps,
  firstStepPlace,
  firstSteps,
  firstStepsReadable,
  mayStartFirstDay,
  offersSetup,
  opensOnFirstDay,
  type FirstDayInput,
  type FirstStepsInput,
} from '../../apps/web/src/first-steps.js';

type Person = SmsHomeResponse['people'][number];
const person = (name: string, may: Partial<Omit<Person, 'id' | 'name'>> = {}): Person => ({
  id: `principal-${name.toLowerCase().replace(/\s+/g, '-')}`,
  name,
  authority: null,
  adopts: false,
  configures: false,
  writes: false,
  readsReports: false,
  ...may,
});
const administrator = person('Robin Vale', { adopts: true, configures: true, writes: true });

function summary(kind: SmsRecordSummary['kind'], title: string, status: string, extra = {}): SmsRecordSummary {
  return {
    id: `${kind}-${title.toLowerCase().replace(/\s+/g, '-')}`,
    kind,
    reference: null,
    title,
    status,
    recordClass: 'sms_documentation',
    confidentiality: 'ordinary',
    owner: { id: administrator.id, name: administrator.name },
    dueAt: null,
    overdue: false,
    revision: 1,
    projectedRevision: 1,
    versionNumber: 1,
    openedAt: '2026-11-02T15:00:00.000Z',
    updatedAt: '2026-11-02T15:00:00.000Z',
    waitingOnMe: false,
    ...extra,
  };
}
const policy = (inForce: boolean) =>
  summary('document', 'Our safety policy', inForce ? 'issued' : 'draft', {
    document: {
      documentType: 'safety_policy',
      documentNumber: null,
      origin: 'authored',
      inForce: inForce
        ? { issueId: 'issue-1', versionNumber: 1, revisionLabel: 'Revision 1', effectiveFrom: '2026-11-03T15:00:00Z' }
        : null,
      scheduled: null,
      reviewDueAt: null,
      reading: null,
    },
  });
const adopted = {
  record: summary('risk_matrix', 'Line survey risk matrix', 'adopted'),
  version: { versionNumber: 2, body: { ...standardRiskMatrix, name: 'Line survey risk matrix' } },
} as unknown as NonNullable<SmsHomeResponse['program']['matrix']>;

function input(overrides: Partial<FirstStepsInput> & { people?: Person[] } = {}): FirstStepsInput {
  const { people, ...rest } = overrides;
  return {
    home: { people: people ?? [administrator], program: { active: false, matrix: null } },
    documents: [],
    reports: [],
    principal: { id: administrator.id, capabilities: ['authority:write', 'sms:read', 'sms:write', 'sms:configure'] },
    ...rest,
  };
}
const byKey = (steps: ReturnType<typeof firstSteps>) => Object.fromEntries(steps.map((step) => [step.key, step]));

describe('the first steps on the safety home', () => {
  it('lists, for a new organization, what is not on file with the action that starts each and who may take it', () => {
    const steps = firstSteps(input());
    expect(steps.map((step) => [step.key, step.onFile])).toEqual([
      ['adopt', true],
      ['accept-low', false],
      ['accept-medium', false],
      ['accept-high', false],
      ['matrix', false],
      ['policy', false],
      ['reports', false],
    ]);
    const shown = byKey(steps);
    expect(shown.adopt!.detail).toBe('Robin Vale');
    expect(shown['accept-low']!.action).toEqual({
      label: 'Grant it on the People screen',
      who: 'An administrator',
      target: { kind: 'people' },
      mine: true,
    });
    expect(shown.matrix!.action).toMatchObject({
      label: 'Start a risk matrix',
      who: 'Robin Vale',
      target: { kind: 'new_matrix' },
      mine: true,
    });
    expect(shown.policy!.action).toMatchObject({ label: 'Draft a safety policy', target: { kind: 'new_policy' } });
    expect(shown.reports!.detail).toBe(
      'No one is cleared to read safety reports, so none can be read or recorded as received. Anyone signed in can submit a report; no reporting link is in force.',
    );
  });

  it('says no one may take an action yet when no one holds what it needs, and offers it only to whoever may', () => {
    const shown = byKey(
      firstSteps(input({ people: [person('Ari Moss')], principal: { id: 'principal-ari-moss', capabilities: [] } })),
    );
    expect(shown.adopt).toMatchObject({ onFile: false, action: { mine: false } });
    expect(shown.matrix!.action).toMatchObject({
      who: 'A person who may configure safety records; no one may yet',
      mine: false,
    });
  });

  it('names who may accept each level, higher authority covering the lower levels', () => {
    const people = [
      administrator,
      person('Kim Arden', { authority: 'medium' }),
      person('Lee Brook', { authority: 'high' }),
    ];
    const shown = byKey(firstSteps(input({ people })));
    expect(shown['accept-low']).toMatchObject({ onFile: true, detail: 'Kim Arden and Lee Brook' });
    expect(shown['accept-medium']).toMatchObject({ onFile: true, detail: 'Kim Arden and Lee Brook' });
    expect(shown['accept-high']).toMatchObject({ onFile: true, detail: 'Lee Brook' });
    expect(shown['accept-high']!.action).toBeUndefined();
  });

  it('sends a draft matrix to signature, then names the matrix in force', () => {
    const draft = summary('risk_matrix', 'Line survey risk matrix', 'draft');
    const drafted = byKey(firstSteps(input({ documents: [draft] }))).matrix!;
    expect(drafted).toMatchObject({
      onFile: false,
      detail: '“Line survey risk matrix” version 1 is a draft until it is signed.',
      action: {
        label: 'Review and sign the draft',
        who: 'Robin Vale',
        target: { kind: 'record', id: draft.id, recordKind: 'risk_matrix' },
        mine: false,
      },
    });
    const inForce = byKey(
      firstSteps(input({ home: { people: [administrator], program: { active: true, matrix: adopted } } })),
    ).matrix!;
    expect(inForce).toEqual({
      key: 'matrix',
      title: 'A risk matrix in force',
      onFile: true,
      detail: 'Line survey risk matrix, version 2, adopted',
    });
  });

  it('opens a draft policy until a revision is issued, then names the policy in force', () => {
    expect(byKey(firstSteps(input({ documents: [policy(false)] }))).policy).toMatchObject({
      onFile: false,
      action: { label: 'Open the draft policy', target: { kind: 'record', recordKind: 'document' } },
    });
    expect(byKey(firstSteps(input({ documents: [policy(true)] }))).policy).toMatchObject({
      onFile: true,
      detail: 'Our safety policy, Revision 1, in force',
    });
  });

  it('counts reports once someone cleared to read them may record them, naming who is cleared', () => {
    const reader = person('Kim Arden', { readsReports: true });
    const notYet = byKey(firstSteps(input({ people: [administrator, reader] }))).reports!;
    expect(notYet).toMatchObject({
      onFile: false,
      detail:
        'Kim Arden may read safety reports but not record them. Anyone signed in can submit a report; no reporting link is in force.',
    });
    const receiver = person('Lee Brook', { readsReports: true, writes: true });
    const reports = [summary('report', 'Safety report recorded 2026-11-04', 'received')];
    const shown = byKey(firstSteps(input({ people: [administrator, reader, receiver], reports }))).reports!;
    expect(shown).toEqual({
      key: 'reports',
      title: 'Who receives safety reports and who is cleared to read them',
      onFile: true,
      detail:
        'Recorded as received by Lee Brook. Anyone signed in can submit a report; no reporting link is in force. Cleared to read them, including who reported: Kim Arden and Lee Brook. 1 safety report on file.',
    });
  });

  it('names each reporting link in force by its label', () => {
    const receiver = person('Lee Brook', { readsReports: true, writes: true });
    const home = {
      people: [administrator, receiver],
      program: { active: false, matrix: null },
      reportLinks: [
        { label: 'Hangar crew room poster', expiresAt: null },
        { label: 'Ridge site trailer', expiresAt: '2027-01-31T00:00:00.000Z' },
      ],
    };
    expect(byKey(firstSteps(input({ home }))).reports!.detail).toBe(
      'Recorded as received by Lee Brook. Anyone signed in can submit a report, and anyone without signing in through the reporting links “Hangar crew room poster” and “Ridge site trailer”. Cleared to read them, including who reported: Lee Brook. No safety report on file yet.',
    );
  });

  it('lists what is on file when everything is, and never says the whole is complete or ready', () => {
    const everyone = person('Robin Vale', {
      adopts: true,
      configures: true,
      writes: true,
      readsReports: true,
      authority: 'high',
    });
    const steps = firstSteps(
      input({
        home: { people: [everyone], program: { active: true, matrix: adopted } },
        documents: [policy(true)],
      }),
    );
    expect(steps.every((step) => step.onFile && !step.action)).toBe(true);
    expect(JSON.stringify(steps)).not.toMatch(/complete|ready|conform|compliant|authorized/i);
  });

  it('is not shown from a recording made before the home named what each person may do', () => {
    const { configures: _c, writes: _w, readsReports: _r, ...old } = administrator;
    expect(firstStepsReadable({ people: [old as Person] })).toBe(false);
    expect(firstStepsReadable({ people: [administrator] })).toBe(true);
  });
});

type DayInput = FirstDayInput;
const administratorPrincipal: DayInput['principal'] = {
  id: administrator.id,
  name: administrator.name,
  capabilities: [
    'authority:write',
    'flight:read',
    'evidence:read',
    'input:write',
    'pack:adopt',
    'sms:read',
    'sms:write',
    'sms:configure',
    'sms:adopt',
  ],
  observationGrants: [{ sourceId: OPERATOR_RECORD_SOURCE_ID, observationType: 'operator.record' }],
};
const pilotPrincipal: DayInput['principal'] = {
  id: 'principal-ari-moss',
  name: 'Ari Moss',
  capabilities: ['flight:read', 'evidence:read', 'input:write', 'briefing:ack', 'sms:read', 'sms:write'],
  observationGrants: [],
};
const subject = (kind: 'aircraft' | 'person' | 'flight', id: string, name = id): NamedSubject => ({
  scope: 'ledger',
  kind,
  id,
  name,
});
const adoption = (
  packId: string,
  title: string,
  state: PackAdoptionRecord['state'] = 'effective',
  mode: 'active' | 'shadow' = 'active',
) => ({ id: `adoption-${packId}`, pack: { packId, version: 2, title }, state, mode }) as unknown as PackAdoptionRecord;
const coverage = (
  title: string,
  needingAttention: number,
  withNoRecord: number,
  mode: 'active' | 'shadow' = 'active',
) =>
  ({
    title,
    mode,
    sections: [
      { needingAttention, withNoRecord: 0 },
      { needingAttention: 0, withNoRecord },
    ],
  }) as unknown as AdoptionRuleCoverageResponse;

/** A new organization: only its first administrator, nothing on record, nothing adopted, nothing produced. */
function day(overrides: Partial<DayInput> = {}): DayInput {
  return {
    principal: administratorPrincipal,
    people: { people: [{ id: administrator.id, name: administrator.name }], more: false },
    subjects: { aircraft: [], person: [], flight: [] },
    packs: [
      { packId: 'ledger.part107', version: 2, title: 'Part 107 checks', digest: 'd', origin: { kind: 'built_in' } },
    ],
    adoptions: [],
    coverage: [],
    safety: { home: { people: [administrator], program: { active: false, matrix: null } }, documents: [], reports: [] },
    productions: { latest: null },
    ...overrides,
  };
}
const stepsByKey = (input: DayInput) => Object.fromEntries(firstDaySteps(input).map((step) => [step.key, step]));

describe('the first day as one list', () => {
  it('lists the steps in the order of the setup guide, for a new organization only its first person on file', () => {
    const steps = firstDaySteps(day());
    expect(steps.map((step) => [step.number, step.key, step.state])).toEqual([
      [1, 'people', 'on_file'],
      [2, 'records', 'not_on_file'],
      [3, 'pack-file', 'not_on_file'],
      [4, 'adoption', 'not_on_file'],
      [5, 'coverage', 'not_on_file'],
      [6, 'safety', 'not_on_file'],
      [7, 'production', 'not_on_file'],
    ]);
    expect(steps.find((step) => step.key === 'production')!.optional).toBe(true);
    expect(JSON.stringify(steps)).not.toMatch(/complete|ready|conform|compliant|authorized/i);
  });

  it('says who may sign in, and links an administrator to the People screen', () => {
    const alone = stepsByKey(day())['people']!;
    expect(alone).toMatchObject({
      state: 'on_file',
      detail: 'Only Robin Vale may sign in. Add anyone else who will use Ledger.',
      action: {
        label: 'Add a person on the People screen',
        who: 'An administrator',
        place: { section: 'people' },
        mine: true,
      },
    });
    expect(stepsByKey(day({ principal: pilotPrincipal }))['people']!.action!.mine).toBe(false);
    const two = {
      people: [
        { id: 'a', name: 'Robin Vale' },
        { id: 'b', name: 'Kim Arden' },
      ],
      more: true,
    };
    expect(stepsByKey(day({ people: two }))['people']).toEqual({
      key: 'people',
      number: 1,
      title: 'The people who sign in',
      state: 'on_file',
      detail: 'Robin Vale, Kim Arden and more may sign in.',
    });
  });

  it('names the aircraft, pilots and flights on record by name and id, on file once each kind has one', () => {
    const some = { aircraft: [subject('aircraft', 'RIDGE-AC-1', 'Skyfield X4')], person: [], flight: [] };
    const partly = stepsByKey(day({ subjects: some }))['records']!;
    expect(partly).toMatchObject({
      state: 'not_on_file',
      detail: 'Aircraft: Skyfield X4 (RIDGE-AC-1). Pilots: none on record. Flights: none on record.',
      action: { place: { section: 'records', pane: 'import' }, who: 'A person who keeps your records', mine: true },
    });
    const all = {
      aircraft: [
        subject('aircraft', 'RIDGE-AC-1'),
        subject('aircraft', 'RIDGE-AC-2'),
        subject('aircraft', 'RIDGE-AC-3'),
      ],
      person: [subject('person', 'RIDGE-P-01')],
      flight: [subject('flight', 'RIDGE-FLT-1')],
    };
    expect(stepsByKey(day({ subjects: all }))['records']).toMatchObject({
      state: 'on_file',
      detail: 'Aircraft: RIDGE-AC-1, RIDGE-AC-2 and more. Pilots: RIDGE-P-01. Flights: RIDGE-FLT-1.',
    });
    expect(stepsByKey(day({ subjects: all }))['records']!.action).toBeUndefined();
    // Records are kept only with the grant to import and enter them, not with input:write alone.
    expect(stepsByKey(day({ principal: pilotPrincipal }))['records']!.action!.mine).toBe(false);
  });

  it('shows the command and the guide for a pack file, never a link, and names a loaded file', () => {
    const none = stepsByKey(day())['pack-file']!;
    expect(none.action).toMatchObject({ command: 'pnpm pack:new <name> --kind waiver', mine: false });
    expect(none.action!.place).toBeUndefined();
    expect(none.action!.guide).toContain('section 6');
    const loaded = day({
      packs: [
        {
          packId: 'ridge.waiver',
          version: 1,
          title: 'Ridge BVLOS waiver',
          digest: 'd',
          origin: { kind: 'organization_file', file: 'ridge-waiver-1.ledgerpack' },
        },
      ],
    });
    expect(stepsByKey(loaded)['pack-file']).toMatchObject({
      state: 'on_file',
      detail: 'Ridge BVLOS waiver version 1, from the file ridge-waiver-1.ledgerpack.',
    });
  });

  it('counts adoptions a person made that are in effect or will be, not the accepted-controls rules', () => {
    const accepted = adoption(ACCEPTED_CONTROL_PACK_ID, 'Accepted controls');
    expect(stepsByKey(day({ adoptions: [accepted, adoption('old', 'Old', 'expired')] }))['adoption']).toMatchObject({
      state: 'not_on_file',
      detail: 'No rule pack is adopted.',
      action: { place: { section: 'rules', pane: 'coverage' }, who: 'A person who may adopt rule packs', mine: true },
    });
    const adopted = day({
      adoptions: [
        adoption('ledger.part107', 'Part 107 checks'),
        adoption('p108', 'Part 108 NPRM', 'pending', 'shadow'),
      ],
    });
    expect(stepsByKey(adopted)['adoption']).toMatchObject({
      state: 'on_file',
      detail: 'Part 107 checks version 2, active and Part 108 NPRM version 2, in shadow.',
    });
    expect(stepsByKey(day({ principal: pilotPrincipal }))['adoption']!.action!.mine).toBe(false);
  });

  it('says in one line what coverage says, rather than ticking it', () => {
    expect(coverageLine(coverage('Part 107 checks', 2, 5))).toBe(
      'Part 107 checks: 2 rules with a subject needing attention, 5 with a record not on file.',
    );
    expect(coverageLine(coverage('Part 107 checks', 0, 1))).toBe('Part 107 checks: 1 rule with a record not on file.');
    expect(coverageLine(coverage('Part 108 NPRM', 0, 0, 'shadow'))).toBe(
      'Part 108 NPRM (in shadow): no rule with a subject needing attention or a record not on file.',
    );
    const read = stepsByKey(
      day({
        adoptions: [adoption('ledger.part107', 'Part 107 checks')],
        coverage: [coverage('Part 107 checks', 1, 0)],
      }),
    )['coverage']!;
    expect(read).toMatchObject({
      state: 'read',
      detail: 'Part 107 checks: 1 rule with a subject needing attention.',
      action: { place: { section: 'rules', pane: 'coverage', packId: 'ledger.part107' }, mine: true },
    });
    expect(stepsByKey(day())['coverage']).toMatchObject({
      state: 'not_on_file',
      detail: 'Coverage is read once a rule pack is adopted and in effect.',
    });
  });

  it('holds the safety items as the safety home lists them, on file once every one is', () => {
    const safety = stepsByKey(day())['safety']!;
    expect(safety.detail).toBe('1 of 7 on file.');
    expect(safety.items!.map((item) => item.key)).toEqual([
      'adopt',
      'accept-low',
      'accept-medium',
      'accept-high',
      'matrix',
      'policy',
      'reports',
    ]);
    expect(stepsByKey(day({ safety: null }))['safety']).toMatchObject({ state: 'unreadable' });
  });

  it('offers producing records as optional, and names the latest production', () => {
    expect(stepsByKey(day())['production']).toMatchObject({
      state: 'not_on_file',
      action: { place: { section: 'records', pane: 'produce' }, mine: true },
    });
    const produced = stepsByKey(
      day({
        productions: {
          latest: {
            producedAt: '2026-11-04T16:00:00.000Z',
            producedBy: { id: 'a', name: 'Robin Vale' },
            requestedBy: 'An inspector',
          },
        },
      }),
    )['production']!;
    expect(produced.state).toBe('on_file');
    expect(produced.detail).toMatch(/^Latest produced .+ by Robin Vale, asked for by An inspector\.$/);
  });

  it('says a step could not be read rather than guess, keeping its action', () => {
    const shown = stepsByKey(
      day({ people: null, subjects: null, packs: null, adoptions: null, coverage: null, productions: null }),
    );
    for (const key of ['people', 'records', 'pack-file', 'adoption', 'coverage', 'production'])
      expect(shown[key]!.state).toBe('unreadable');
    expect(shown['people']!.action!.mine).toBe(true);
  });
});

describe('who sees the list first, and the bar’s Setup entry', () => {
  it('opens on the list for a person who may take a step, until a rule pack is adopted', () => {
    expect(opensOnFirstDay(administratorPrincipal, [])).toBe(true);
    expect(opensOnFirstDay(administratorPrincipal, [adoption(ACCEPTED_CONTROL_PACK_ID, 'Accepted controls')])).toBe(
      true,
    );
    expect(opensOnFirstDay(administratorPrincipal, [adoption('ledger.part107', 'Part 107 checks')])).toBe(false);
    // Adoptions that could not be read never move the first screen.
    expect(opensOnFirstDay(administratorPrincipal, null)).toBe(false);
  });

  it('never opens on it for a pilot, who may take none of the steps, or for a person who reads no flights', () => {
    expect(mayStartFirstDay(pilotPrincipal)).toBe(false);
    expect(opensOnFirstDay(pilotPrincipal, [])).toBe(false);
    const recordKeeper = { ...pilotPrincipal, observationGrants: administratorPrincipal.observationGrants };
    expect(mayStartFirstDay(recordKeeper)).toBe(true);
    const safetyOnly = {
      ...administratorPrincipal,
      capabilities: administratorPrincipal.capabilities.filter((capability) => capability !== 'flight:read'),
    };
    expect(opensOnFirstDay(safetyOnly, [])).toBe(false);
  });

  it('offers Setup while one of steps 1 to 4 or 6 is not on file, and not when a step could not be read', () => {
    expect(offersSetup(administratorPrincipal, firstDaySteps(day()))).toBe(true);
    expect(offersSetup(pilotPrincipal, firstDaySteps(day({ principal: pilotPrincipal })))).toBe(false);
    expect(offersSetup(administratorPrincipal, firstDaySteps(day({ packs: null })))).toBe(false);
    const steps = firstDaySteps(day()).map((step) =>
      step.key === 'coverage' || step.key === 'production' ? step : { ...step, state: 'on_file' as const },
    );
    expect(offersSetup(administratorPrincipal, steps)).toBe(false);
  });
});

describe('where each item leads', () => {
  it('opens the exact place, keeping what the move needs', () => {
    expect(firstStepPlace({ kind: 'people' })).toEqual({ place: { section: 'people' }, extras: {} });
    expect(firstStepPlace({ kind: 'new_policy' })).toEqual({
      place: { section: 'safety', view: 'documents' },
      extras: { drafting: true },
    });
    expect(firstStepPlace({ kind: 'record', id: 'm-1', recordKind: 'risk_matrix' })).toEqual({
      place: { section: 'safety', view: 'record', kind: 'risk_matrix', id: 'm-1' },
      extras: { sign: true },
    });
    expect(firstStepPlace({ kind: 'record', id: 'd-1', recordKind: 'document' }).extras).toEqual({});
  });
});
