import { describe, expect, it } from 'vitest';
import type { OperatorRecordView, Principal } from '@ledger/contracts';
import { listOperatorRecordTypes } from '../../packages/domain/src/operator-record-import.js';
import {
  interpretRecordRow,
  findOperatorRecordDefinition,
  standardObservationRegistry,
} from '../../packages/contracts/src/index.js';
import {
  canKeepRecords,
  draftFromRecord,
  emptyDraft,
  entryDocument,
  localInputValue,
  originalExcerpt,
  recordHeadline,
} from '../../apps/web/src/operator-records.js';

const types = listOperatorRecordTypes();
const summary = (recordType: string) => types.find((type) => type.recordType === recordType)!;
const definition = (recordType: string) => findOperatorRecordDefinition(standardObservationRegistry, recordType, 1)!;

describe('generated entry form', () => {
  it('submits a one-record document that import reads back without problems, converting a chosen unit', () => {
    const plan = summary('flight.plan');
    const draft = emptyDraft(plan);
    draft.subjectId = 'FLIGHT-22';
    draft.values = {
      windowStartsAt: '2026-11-02T14:00',
      plannedMaxHeightAboveGroundMeters: '400',
      pilotInOperatingArea: 'yes',
      routeSummary: '  Along the river  ',
    };
    draft.units.plannedMaxHeightAboveGroundMeters = 'ft';
    const document = entryDocument(plan, draft);
    expect(document).toMatchObject({ recordType: 'flight.plan', recordVersion: 1 });
    const [record] = document.records;
    expect(record).toEqual({
      subjectId: 'FLIGHT-22',
      'windowStartsAt [local]': '2026-11-02T14:00',
      'plannedMaxHeightAboveGround [ft]': 400,
      routeSummary: 'Along the river',
      pilotInOperatingArea: 'yes',
    });
    const reading = interpretRecordRow(definition('flight.plan'), record!, { timeZone: 'America/Chicago' });
    expect(reading.problems).toEqual([]);
    expect(reading.record.plannedMaxHeightAboveGroundMeters).toBe(121.92);
    // The form's times are the organization's wall-clock times; the import reads them in its zone.
    expect(reading.record.windowStartsAt).toBe('2026-11-02T20:00:00Z');
  });

  it('starts a correction’s times in the organization’s zone, as the form enters them', () => {
    const plan = summary('flight.plan');
    const record = {
      subject: { kind: 'flight', id: 'FLIGHT-22', scope: 'source', resolution: 'unresolved' },
      record: { windowStartsAt: '2026-07-01T14:00:00Z' },
    } as unknown as OperatorRecordView;
    expect(localInputValue('2026-07-01T14:00:00Z', 'America/Chicago')).toBe('2026-07-01T09:00:00');
    expect(draftFromRecord(plan, record).values.windowStartsAt).toBe(localInputValue('2026-07-01T14:00:00Z'));
  });

  it('starts a correction from the record it replaces and names it', () => {
    const training = summary('person.training');
    const record = {
      subject: { kind: 'person', id: 'PILOT-1', scope: 'source', resolution: 'unresolved' },
      record: { trainingKind: 'recurrent', courseTitle: 'Course', completedOn: '2026-01-02' },
    } as unknown as OperatorRecordView;
    const draft = draftFromRecord(training, record);
    expect(draft).toMatchObject({
      subjectId: 'PILOT-1',
      values: { trainingKind: 'recurrent', courseTitle: 'Course', completedOn: '2026-01-02' },
    });
    expect(entryDocument(training, draft, 'observation-1').records[0]).toMatchObject({ replaces: 'observation-1' });
    expect(recordHeadline(training, record.record)).toBe('Recurrent · Course');
  });

  it('offers entry only with input:write and the operator-records grant', () => {
    const principal = {
      capabilities: ['input:write', 'evidence:read'],
      observationGrants: [{ sourceId: 'operator-records', observationType: 'operator.record' }],
    } as unknown as Principal;
    expect(canKeepRecords(principal, 'operator-records')).toBe(true);
    expect(canKeepRecords({ ...principal, capabilities: ['evidence:read'] }, 'operator-records')).toBe(false);
    expect(canKeepRecords({ ...principal, observationGrants: [] }, 'operator-records')).toBe(false);
  });

  it('shows the original row or JSON record a locator points at', () => {
    const csv = new TextEncoder().encode('subjectId,courseTitle\nP-1,Course\n');
    expect(originalExcerpt(csv, { kind: 'byte_range', value: { offsetBytes: 22, lengthBytes: 10 } })).toBe(
      'P-1,Course',
    );
    const json = new TextEncoder().encode('{"records":[{"subjectId":"P-1"}]}');
    expect(JSON.parse(originalExcerpt(json, { kind: 'json_pointer', value: '/records/0' }))).toEqual({
      subjectId: 'P-1',
    });
  });
});

describe('entry form fields', () => {
  it('marks a field that only explains a record as optional, says what it is for, and offers subjects on file', async () => {
    const { createRequire } = await import('node:module');
    const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
    const { createElement } = webRequire('react') as typeof import('react');
    const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');
    const { RecordForm } = await import('../../apps/web/src/RecordForm.js');
    const type = types.find(
      (candidate) =>
        candidate.fields.some((field) => field.replayOnly) &&
        candidate.fields.some((field) => field.kind === 'reference' && field.referenceKind !== 'duty_period') &&
        !candidate.subjectKinds.includes('organization'),
    )!;
    const shown = renderToStaticMarkup(
      createElement(RecordForm, {
        client: {} as never,
        type,
        sourceId: 'operator-records',
        onRecorded: () => {},
      }),
    );
    expect(shown).not.toMatch(/for replay/i);
    const replay = type.fields.find((field) => field.replayOnly)!;
    const label = shown.slice(
      shown.indexOf(`>${replay.label}`),
      shown.indexOf('</label>', shown.indexOf(`>${replay.label}`)),
    );
    expect(label).toContain('<small>Optional</small>');
    expect(label).toContain('Explains the record to a later reader; it never counts toward a complete record.');
    // The subject id and each reference to a person, aircraft, site or component are comboboxes over subjects on file.
    const references = type.fields.filter(
      (field) => field.kind === 'reference' && field.referenceKind !== 'duty_period',
    );
    expect(shown.match(/role="combobox"/g)).toHaveLength(
      1 + references.length + (type.secondarySubjectKinds.some((kind) => kind !== 'organization') ? 1 : 0),
    );
  });
});
