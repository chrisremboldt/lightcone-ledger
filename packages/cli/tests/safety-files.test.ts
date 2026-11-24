import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RiskMatrixBodySchema, riskMatrixProblems } from '@ledger/contracts';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  frontMatter,
  matrixPosition,
  parseCsv,
  readSafetyFile,
  runCli,
  safetyTemplates,
  usage,
  type FileContext,
  type SafetyFileKind,
} from '../src/index.js';

const example = join(import.meta.dirname, '..', '..', '..', 'examples', 'first-operator', 'safety');
const people = [
  { id: 'person-avery', name: 'Avery Example' },
  { id: 'person-rowan', name: 'Rowan Example' },
  { id: 'person-jordan', name: 'Jordan Example' },
];
const context: FileContext = { people, zone: 'America/Denver', today: '2026-11-23' };
const read = (kind: SafetyFileKind, file: string) =>
  readSafetyFile(kind, readFileSync(join(example, file), 'utf8'), file, context);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

describe('safety files', () => {
  it('reads the example matrix: four bands of its own, the last nobody may accept', () => {
    const { items } = read('matrix', 'risk-matrix.yaml');
    expect(items[0]!.problems).toEqual([]);
    const draft = items[0]!.draft!;
    if (draft.kind !== 'risk_matrix') throw new Error('a matrix');
    expect(draft.ownerId).toBe('person-avery');
    expect(draft.body.levels.map((level) => [level.label, level.acceptance])).toEqual([
      ['Green', 'low'],
      ['Yellow', 'medium'],
      ['Orange', 'high'],
      ['Red', 'not_acceptable'],
    ]);
    expect(riskMatrixProblems(draft.body)).toEqual([]);
    expect(ajv.validate(RiskMatrixBodySchema, draft.body), JSON.stringify(ajv.errors)).toBe(true);
    expect(matrixPosition(draft.body, { severity: 'Catastrophic', likelihood: 'Now and then' })).toEqual({
      position: { severity: 'catastrophic', likelihood: 'now_and_then' },
    });
    expect(matrixPosition(draft.body, { severity: 'Severe', likelihood: 'Likely' }).problem).toBe(
      'Severe is not a severity of “Example Ridge risk matrix”.',
    );
  });

  it('reads a register as hazards and one plain control per mitigation, under the organization’s own ids', () => {
    const { items, problems, assessments } = read('hazards', 'hazards.csv');
    expect(problems).toEqual([]);
    expect(items.filter((item) => item.problems.length)).toEqual([]);
    expect(items.map((item) => item.reference)).toEqual([
      'H-001',
      'H-001/1',
      'H-001/2',
      'H-001/3',
      'H-002',
      'H-002/1',
      'H-002/2',
      'H-003',
      'H-003/1',
      'H-003/2',
      'H-004',
      'H-004/1',
      'H-005',
      'H-005/1',
    ]);
    const control = items[1]!.draft!;
    expect(control).toMatchObject({
      kind: 'control',
      ownerId: 'person-rowan',
      body: {
        controlType: { id: 'control.described-measure', version: 1 },
        parameters: { measure: 'Traffic receiver on every aircraft' },
        effectiveFrom: '2025-03-04T07:00:00.000Z',
      },
    });
    expect(items[0]!.draft).toMatchObject({ dueAt: '2027-03-02T07:00:00.000Z' });
    expect(assessments[4]).toEqual({ reference: 'H-005', initial: null, residual: null, newHazards: '' });
  });

  it('says what is wrong with a row in words, and opens nothing of it', () => {
    const { items, problems } = readSafetyFile(
      'hazards',
      'id,hazard,consequence,owner,raised,colour\nH-9,,Fly-away,Casey Nobody,03/02/2026,red\n',
      'hazards.csv',
      context,
    );
    expect(problems).toEqual([
      '"colour" is not a column of a hazard register. The columns: id, title, hazard, consequence, operation, owner, raised, reviewDue, controls, controlsFrom, severityBefore, likelihoodBefore, severityAfter, likelihoodAfter, newHazards.',
    ]);
    expect(items).toEqual([]);
    const row = readSafetyFile(
      'hazards',
      'id,hazard,consequence,owner,raised\nH-9,,Fly-away,Casey Nobody,03/02/2026\n',
      'h.csv',
      context,
    ).items[0]!;
    expect(row.draft).toBeUndefined();
    expect(row.problems).toEqual([
      'Give the hazard.',
      "The owner, Casey Nobody, is nobody who may read safety records here. pnpm ledger people list shows each person's full name and id.",
      'Raised is a date such as 2026-06-01 or a time with its offset: 03/02/2026',
      'ControlsFrom is a date such as 2026-06-01 or a time with its offset: 03/02/2026',
    ]);
  });

  it('reads a document, an audit and a review with their owners', () => {
    const policy = read('document', 'safety-policy.md').items[0]!;
    expect(policy.problems).toEqual([]);
    expect(policy.draft).toMatchObject({
      kind: 'document',
      schema: 'sms.document.2',
      body: { origin: 'authored', documentType: 'safety_policy', revisionLabel: '2', documentNumber: 'ERS-POL-1' },
    });
    const audit = read('assurance', 'internal-audit.yaml').items[0]!;
    expect(audit.problems).toEqual([]);
    expect(audit.draft).toMatchObject({
      body: {
        assuranceType: 'audit',
        actions: [{ id: 'A1', ownerId: 'person-rowan', dueOn: '2026-03-15', findingId: 'F1' }, {}],
      },
    });
    expect(read('assurance', 'management-review.yaml').items[0]!.problems).toEqual([]);
  });

  it('reads a report and never quotes it in a problem', () => {
    const report = read('report', 'safety-report-SR-1.md').items[0]!;
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ confidentiality: 'safety_report', name: 'Safety report ERS-SR-1' });
    const secret = 'Casey Example saw it happen';
    expect(() => frontMatter(`---\nid: SR-2\nreporterName: [${secret}\n---\nWhat happened.\n`)).toThrow(
      /^The stated values are not valid YAML at line \d+ of the file\.$/,
    );
    const long = readSafetyFile(
      'report',
      `---\nid: SR-3\nowner: Rowan Example\nreceived: fax\nreporterName: ${secret}\n---\n${'x'.repeat(8001)}\n`,
      'r.md',
      context,
    ).items[0]!;
    expect(long.problems.join(' ')).not.toContain(secret);
    expect(long.problems).toContain('The narrative has more than 8000 characters.');
  });

  it('reads quoted CSV cells with commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\n"one, two","say ""hi""\nthere"\n')).toEqual({
      headings: ['a', 'b'],
      rows: [{ a: 'one, two', b: 'say "hi"\nthere' }],
    });
  });

  it('gives a template of each kind that reads back without problems', () => {
    for (const [kind, template] of Object.entries(safetyTemplates)) {
      const people = [{ id: 'person-avery', name: 'Avery Example' }];
      const file = readSafetyFile(kind as SafetyFileKind, template.text, template.file, { ...context, people });
      expect(file.problems, kind).toEqual([]);
      expect(
        file.items.flatMap((item) => item.problems),
        kind,
      ).toEqual([]);
    }
  });

  it('lists the safety commands, and refuses an option a safety command does not read', async () => {
    expect(usage).toContain('safety draft <kind> <file>');
    const err: string[] = [];
    const code = await runCli(['safety', 'home', '--reason', 'x'], {
      env: { LEDGER_API_URL: 'http://ledger.invalid', LEDGER_TOKEN: 'token' },
      folders: [example],
      out: () => {},
      err: (line) => err.push(line),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('safety home does not read --reason, so nothing was done.');
  });

  it('prints the dates of the safety home in the organization’s zone, never in UTC', async () => {
    // 03:30 UTC on 24 November is still the evening of 23 November in Denver.
    const late = '2026-11-24T03:30:00.000Z';
    const answers: Record<string, unknown> = {
      '/v1/me': {
        principal: { id: 'person-avery', name: 'Avery Example', kind: 'human', capabilities: ['sms:read'] },
        organization: { id: 'organization:example', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
      },
      '/v1/sms/home': {
        computedAt: late,
        program: { matrix: null },
        people: [],
        attention: {
          documentsAwaitingAdoption: [],
          documentsToReview: [],
          documentsToIssue: [],
          needsAssessment: [],
          awaitingAcceptance: [],
          overdue: [],
        },
        assuranceActions: [],
      },
      '/v1/sms/records': {
        records: [
          {
            id: 'sms-policy',
            kind: 'document',
            reference: 'POL-1',
            title: 'Safety policy',
            confidentiality: 'ordinary',
            document: { documentType: 'safety_policy', inForce: { revisionLabel: '1', effectiveFrom: late } },
          },
        ],
      },
    };
    const fetcher = (async (input: string | URL | Request) => {
      const body = answers[new URL(String(input)).pathname];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const out: string[] = [];
    const code = await runCli(['safety', 'home'], {
      env: { LEDGER_API_URL: 'http://ledger.invalid', LEDGER_TOKEN: 'token' },
      folders: [example],
      out: (line) => out.push(line),
      err: () => {},
      fetcher,
    });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Safety records of Example Ridge Survey, as of 2026-11-23 20:30 America/Denver.');
    expect(text).toContain('In force: Document POL-1 (sms-policy), “Safety policy”, revision 1, since 2026-11-23.');
    expect(text).not.toContain('2026-11-24');
  });
});
