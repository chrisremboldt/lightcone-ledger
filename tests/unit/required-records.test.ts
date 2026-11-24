import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  DocumentBodyV2Schema,
  planBlanks,
  RECORDKEEPING_PLAN_DOCUMENT_TYPE,
  type RequiredRecordsResponse,
} from '../../packages/contracts/src/index.js';
import { recordkeepingPlanDraft } from '../../packages/domain/src/required-records.js';

// A recordkeeping plan drafted from the required records read (docs/design/required-records.md).

const read: RequiredRecordsResponse = {
  asOf: '2026-11-22T17:00:00.000Z',
  organization: { name: 'Example Ridge Survey', timeZone: 'America/Denver' },
  records: [
    {
      id: 'example.records.flights',
      title: 'Record of each flight',
      keptBy: 'Each operator',
      source: { reference: 'Example 1(a)', text: '(a) A record of\n  each flight.' },
      retention: { reference: 'Example 1(f)', text: 'Kept for a minimum of 24 months.' },
      declaredBy: [{ packId: 'example.pack', version: 2, packTitle: 'Example pack' }],
      heldBy: [
        {
          kind: 'operator_record',
          recordType: 'flight.record',
          title: 'Flight record',
          onFile: {
            current: 4,
            replaced: 1,
            earliest: '2026-11-01T16:00:00.000Z',
            latest: '2026-11-03T18:30:00.000Z',
          },
        },
      ],
      onFile: { current: 4, replaced: 1, earliest: '2026-11-01T16:00:00.000Z', latest: '2026-11-03T18:30:00.000Z' },
    },
    {
      id: 'example.records.certificate',
      title: 'Certificate, presented on request',
      keptBy: 'A remote pilot',
      source: { reference: 'Example 2', text: 'Presented on request.' },
      retention: null,
      declaredBy: [{ packId: 'example.pack', version: 2, packTitle: 'Example pack' }],
      heldBy: [
        {
          kind: 'operator_record',
          recordType: 'person.certificate',
          title: 'Certificate',
          onFile: { current: 0, replaced: 0, earliest: null, latest: null },
        },
      ],
      onFile: { current: 0, replaced: 0, earliest: null, latest: null },
    },
  ],
};

describe('a recordkeeping plan drafted from the required records', () => {
  const draft = recordkeepingPlanDraft(read);
  const text = draft.body.text!;

  it('is a controlled document of its own type, ready to open', () => {
    expect(draft.body).toMatchObject({ origin: 'authored', documentType: RECORDKEEPING_PLAN_DOCUMENT_TYPE });
    const ajv = new Ajv({ strict: false, allowUnionTypes: true });
    addFormats(ajv);
    expect(ajv.validate(DocumentBodyV2Schema, draft.body), JSON.stringify(ajv.errors)).toBe(true);
    expect(draft.title).toBe('Recordkeeping plan');
    expect(draft.requiredRecords).toBe(2);
  });

  it('states each record with its quoted words, what holds it, what was on file and the retention as written', () => {
    expect(text).toContain('3.1 Record of each flight');
    expect(text).toContain('What the text lists: “(a) A record of each flight.” (Example 1(a))');
    expect(text).toContain('Who the text says keeps it: Each operator');
    expect(text).toContain('Held in Ledger as: Flight record (flight.record)');
    expect(text).toContain(
      'On file when this draft was made: Flight record: 4 on file, about 2026-11-01 to 2026-11-03; 1 earlier versions replaced by corrections are kept',
    );
    expect(text).toContain('How long the text says it is kept: “Kept for a minimum of 24 months.” (Example 1(f))');
    expect(text).toContain('On file when this draft was made: Certificate: none on file');
    expect(text).toContain('How long the text says it is kept: the text states no period.');
    expect(text).toContain('read from Ledger on 2026-11-22 (America/Denver)');
    expect(text).toContain('Example pack (example.pack version 2)');
  });

  it('describes what Ledger does with records and how they are produced, and leaves the rest as visible blanks', () => {
    expect(text).toContain('No record is changed or removed.');
    expect(text).toContain('tools/verifier/record-production-cli.mjs');
    expect(text).toContain('Ledger removes no record.');
    expect(draft.blanks).toEqual([
      'the person or role responsible for keeping these records and producing them on request',
      'where the Ledger deployment that holds these records runs',
      'how the deployment’s database and stored files are backed up, how often, and where the backups are kept',
      'how long the organization undertakes to keep the deployment and its backups',
    ]);
    expect(planBlanks(text)).toEqual(draft.blanks);
    expect(planBlanks(text.replaceAll(/\[To be filled in: [^\]]+\]/g, 'Avery Example'))).toEqual([]);
  });

  it('never says a requirement is met or the plan is adequate', () => {
    for (const word of [/complian/i, /adequate/i, /\bsatisf/i, /\bmeets?\b/i, /authori[sz]ed/i, /long enough/i])
      expect(text).not.toMatch(word);
  });

  it('says so when no adopted pack lists a required record', () => {
    const empty = recordkeepingPlanDraft({ ...read, records: [] });
    expect(empty.body.text).toContain('No adopted rule pack lists a required record.');
    expect(empty.requiredRecords).toBe(0);
  });
});
