import { describe, expect, it } from 'vitest';
import type { SmsHomeResponse, SmsRecordSummary } from '../../packages/contracts/src/index.js';
import { standardRiskMatrix } from '../../packages/contracts/src/index.js';
import { firstSteps, firstStepsReadable, type FirstStepsInput } from '../../apps/web/src/first-steps.js';

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
