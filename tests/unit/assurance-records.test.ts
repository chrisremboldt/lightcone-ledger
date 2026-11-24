import { describe, expect, it } from 'vitest';
import { assuranceBodyProblems, type AssuranceBody } from '../../packages/contracts/src/index.js';
import { actionsDueByOwner, settledActions, type OpenAction } from '../../packages/domain/src/sms-assurance.js';
import { recordsCountedV1 } from '../../packages/domain/src/check-kind-library-on-file.js';
import {
  assuranceDraft,
  assuranceFieldsAsked,
  assuranceFormFrom,
  emptyAssuranceForm,
  nextItemId,
} from '../../apps/web/src/assurance-form.js';

const today = '2026-11-22';
const audit: AssuranceBody = {
  assuranceType: 'audit',
  performedOn: '2026-11-20',
  scope: 'Preflight records of the survey crews.',
  examined: 'Ten flight records of RIDGE-AC-1.',
  findings: [{ id: 'F1', text: 'Two assessments signed after takeoff.' }],
  actions: [{ id: 'A1', what: 'Brief the crews.', ownerId: 'avery', dueOn: '2026-12-01', findingId: 'F1' }],
};

describe('a safety assurance record’s body', () => {
  it('accepts a complete audit', () => {
    expect(assuranceBodyProblems(audit, today)).toEqual([]);
  });

  it('asks for the fields its type asks for, and refuses those it does not', () => {
    expect(assuranceBodyProblems({ ...audit, assuranceType: 'occurrence_investigation' }, today)).toEqual([
      'Give when the occurrence happened.',
    ]);
    expect(assuranceBodyProblems({ ...audit, counterpart: 'Example Tower Services' }, today)).toEqual([
      'An audit of operational processes and systems does not record the other organization.',
    ]);
    expect(assuranceBodyProblems({ ...audit, assuranceType: 'hazard_notice_received' }, today)).toEqual([
      'Give the other organization.',
    ]);
    expect(
      assuranceBodyProblems({ ...audit, assuranceType: 'change_assessment', system: 'New launch site' }, today),
    ).toEqual([]);
  });

  it('refuses dates in the future, a completion before the start, repeated ids and an unknown finding', () => {
    expect(
      assuranceBodyProblems(
        {
          ...audit,
          performedOn: '2026-11-23',
          completedOn: '2026-11-21',
          findings: [...audit.findings, { id: 'F1', text: 'Again.' }],
          actions: [{ ...audit.actions[0]!, findingId: 'F9' }],
        },
        today,
      ),
    ).toEqual([
      'The date it was performed cannot be in the future.',
      'The date it was completed cannot be before the date it was performed.',
      'Two findings are numbered F1.',
      'Action A1 answers finding F9, which this record does not hold.',
    ]);
  });
});

describe('the safety assurance form', () => {
  const filled = () => ({
    ...emptyAssuranceForm('audit'),
    title: 'Preflight records audit',
    performedOn: '2026-11-20',
    scope: ' Preflight records. ',
    examined: 'Ten flight records.',
    findings: [
      { id: 'F1', text: 'Two assessments signed after takeoff.' },
      { id: 'F2', text: '   ' },
    ],
    actions: [{ id: 'A1', what: 'Brief the crews.', ownerId: 'avery', dueOn: '2026-12-01', findingId: 'F1' }],
  });

  it('builds the body from what was typed, dropping blank rows and trimming text', () => {
    const draft = assuranceDraft(filled(), today);
    expect(draft.problems).toEqual([]);
    expect(draft.body).toEqual({
      assuranceType: 'audit',
      performedOn: '2026-11-20',
      scope: 'Preflight records.',
      examined: 'Ten flight records.',
      findings: [{ id: 'F1', text: 'Two assessments signed after takeoff.' }],
      actions: [{ id: 'A1', what: 'Brief the crews.', ownerId: 'avery', dueOn: '2026-12-01', findingId: 'F1' }],
    });
  });

  it('leaves out a field the chosen type does not ask for, so changing the type never sends one', () => {
    const draft = assuranceDraft(
      { ...filled(), counterpart: 'Example Tower Services', occurredOn: '2026-11-19' },
      today,
    );
    expect(draft.body).not.toHaveProperty('counterpart');
    expect(draft.body).not.toHaveProperty('occurredOn');
    const notice = assuranceDraft(
      { ...filled(), assuranceType: 'hazard_notice_sent', counterpart: 'Example Tower Services' },
      today,
    );
    expect(notice.body.counterpart).toBe('Example Tower Services');
    expect(assuranceFieldsAsked('occurrence_investigation')).toEqual([
      { field: 'occurredOn', required: true },
      { field: 'fromReport', required: false },
    ]);
  });

  it('says in plain words what is missing before anything is sent', () => {
    const draft = assuranceDraft(
      {
        ...emptyAssuranceForm('occurrence_investigation'),
        actions: [{ id: 'A1', what: 'Replace the propeller.', ownerId: '', dueOn: '', findingId: '' }],
      },
      today,
    );
    expect(draft.problems).toEqual([
      'Give the record a title.',
      'Give the date it was performed.',
      'Say what it covered.',
      'Say what it looked at.',
      'Choose who owns action A1.',
      'Give action A1 a due date.',
    ]);
  });

  it('numbers new findings and actions after the highest used, and reads a recorded version back', () => {
    expect(nextItemId('A', [{ id: 'A1' }, { id: 'A7' }, { id: 'X2' }])).toBe('A8');
    expect(nextItemId('F', [])).toBe('F1');
    const back = assuranceFormFrom('Preflight records audit', audit);
    expect(assuranceDraft(back, today).body).toEqual(audit);
  });
});

describe('the Safety home’s list of actions due', () => {
  const owner = (name: string) => ({ id: name.toLowerCase().replace(' ', '-'), name });
  const action = (who: string, actionId: string, dueOn: string): OpenAction => ({
    owner: owner(who),
    recordId: `record-${actionId}`,
    recordTitle: `Audit ${actionId}`,
    assuranceType: 'audit',
    actionId,
    what: `Do ${actionId}.`,
    dueOn,
    overdue: false,
  });

  it('lists open actions due in the next 30 days or overdue, by owner, owners with overdue actions first', () => {
    const groups = actionsDueByOwner(
      [
        action('Avery Example', 'A1', '2026-12-10'),
        action('Blake Example', 'A2', '2026-11-30'),
        action('Avery Example', 'A3', '2026-11-20'),
        action('Casey Example', 'A4', '2027-01-15'),
        action('Blake Example', 'A5', '2026-11-25'),
      ],
      today,
    );
    expect(
      groups.map((group) => [group.owner.name, group.actions.map((item) => [item.actionId, item.overdue])]),
    ).toEqual([
      [
        'Avery Example',
        [
          ['A3', true],
          ['A1', false],
        ],
      ],
      [
        'Blake Example',
        [
          ['A5', false],
          ['A2', false],
        ],
      ],
    ]);
  });

  it('counts an action due today as not yet overdue', () => {
    expect(actionsDueByOwner([action('Avery Example', 'A1', today)], today)[0]!.actions[0]!.overdue).toBe(false);
  });
});

describe('the actions a signature sets', () => {
  const signed = (versionNumber: number, body: AssuranceBody) => ({
    decisionId: `sign-${versionNumber}`,
    versionNumber,
    bodyDigest: String(versionNumber).repeat(64).slice(0, 64),
    signedAt: `2026-11-2${versionNumber}T12:00:00.000Z`,
    body,
  });

  it('sets each action at the first signature listing it, as the latest signature holds it', () => {
    const second = {
      ...audit,
      actions: [
        { ...audit.actions[0]!, dueOn: '2026-12-05' },
        { id: 'A2', what: 'Check the logs.', ownerId: 'blake', dueOn: '2026-12-10' },
      ],
    };
    const settled = settledActions([signed(1, audit), signed(2, second)], new Map());
    expect(
      settled.map((entry) => [entry.action.id, entry.action.dueOn, entry.setIn.versionNumber, entry.setAt]),
    ).toEqual([
      ['A1', '2026-12-05', 1, '2026-11-21T12:00:00.000Z'],
      ['A2', '2026-12-10', 2, '2026-11-22T12:00:00.000Z'],
    ]);
  });

  it('drops an open action a later signature no longer lists', () => {
    expect(settledActions([signed(1, audit), signed(2, { ...audit, actions: [] })], new Map())).toEqual([]);
  });
});

describe('records.counted@1', () => {
  const observation = (id: string, values: Record<string, unknown>, start: string, end?: string) => ({
    id,
    type: 'organization.record-in-force',
    version: 1,
    occurredAt: start,
    interval: { start, ...(end ? { end } : {}) },
    observation: { values },
  });
  const params = {
    recordLabel: 'signed safety assurance record',
    select: { where: [{ field: 'values.item', oneOf: ['record'] }] },
    counts: [
      {
        where: [{ field: 'values.assuranceType', oneOf: ['audit'] }],
        describes: 'audits of operational processes and systems',
      },
      {
        where: [{ field: 'values.assuranceType', oneOf: ['management_review'] }],
        describes: 'reviews of safety performance by the accountable executive',
      },
    ],
    open: {
      select: { where: [{ field: 'values.item', oneOf: ['action'] }] },
      label: 'Actions they set',
      dueField: 'values.dueAt',
    },
  };
  const clock = {
    mode: 'wall' as const,
    evaluatedAt: '2026-11-22T12:00:00.000Z',
    adoption: { start: '2026-11-01T00:00:00.000Z', end: '2027-11-01T00:00:00.000Z' },
  };

  it('counts records on file within the adoption’s dates by type, with actions open and past due', () => {
    const result = recordsCountedV1.evaluate(
      params,
      {
        records: [
          observation('o1', { item: 'record', assuranceType: 'audit' }, '2026-11-10T09:00:00.000Z'),
          observation('o2', { item: 'record', assuranceType: 'audit' }, '2026-10-10T09:00:00.000Z'),
          observation('o3', { item: 'record', assuranceType: 'management_review' }, '2026-11-20T09:00:00.000Z'),
          observation('o4', { item: 'action', dueAt: '2026-11-21T00:00:00.000Z' }, '2026-11-10T09:00:00.000Z'),
          observation('o5', { item: 'action', dueAt: '2026-12-01T00:00:00.000Z' }, '2026-11-10T09:00:00.000Z'),
          observation(
            'o6',
            { item: 'action', dueAt: '2026-11-15T00:00:00.000Z' },
            '2026-11-10T09:00:00.000Z',
            '2026-11-12T09:00:00.000Z',
          ),
        ],
      },
      clock,
    );
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      nextBoundary: '2026-12-01T00:00:00.000Z',
    });
    expect(result.summary).toBe(
      '2 signed safety assurance records on file since 2026-11-01: audits of operational processes and systems: 1; reviews of safety performance by the accountable executive: 1. Actions they set: 2 open, 1 of them past the due date.',
    );
  });

  it('says nothing is on file in the dates, and how many are on file from before', () => {
    const result = recordsCountedV1.evaluate(
      params,
      { records: [observation('o2', { item: 'record', assuranceType: 'audit' }, '2026-10-10T09:00:00.000Z')] },
      clock,
    );
    expect(result).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'record_not_on_file' });
    expect(result.summary).toBe(
      'No signed safety assurance record on file since 2026-11-01. 1 earlier one is on file, the latest from 2026-10-10. Actions they set: 0 open, 0 of them past the due date.',
    );
  });
});
