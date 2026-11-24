import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findOperatorRecordDefinition,
  interpretRecordRow,
  parseRecordFile,
  producedCsvColumns,
  producedRecordCsv,
  recordImportColumns,
  recordSubjectName,
  standardObservationRegistry,
  type OperatorRecordDefinition,
  type ProducedRecordRow,
} from '../../packages/contracts/src/index.js';
import type { RecordRow } from '../../packages/domain/src/operator-record-reads.js';
import {
  assembleRecordProduction,
  assignedFlights,
  type ProductionSources,
} from '../../packages/evidence/src/record-production-assembly.js';
import { writeZip } from '../../packages/evidence/src/zip.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { csvRows, readZip, verifyRecordProduction } from '../../tools/verifier/record-production.mjs';

const type = (recordType: string): OperatorRecordDefinition =>
  findOperatorRecordDefinition(standardObservationRegistry, recordType, 1)!;
const identity = type('aircraft.identity');
const plan = type('flight.plan');
const standing = type('person.standing');
const procedure = type('organization.procedure');
const roles = type('operation.role-assignment');

const produced = (overrides: Partial<ProducedRecordRow> & Pick<ProducedRecordRow, 'record'>): ProducedRecordRow => ({
  recordId: 'rec-1',
  subject: { kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' },
  recordedAt: '2026-11-02T10:00:00.000Z',
  recordedBy: 'Avery Example',
  originalFile: 'aircraft.csv',
  originalSha256: 'a'.repeat(64),
  limitations: [],
  ...overrides,
});

/** Reads a produced CSV back through the importer, row by row. */
function reimport(definition: OperatorRecordDefinition, csv: string) {
  const parsed = parseRecordFile(new TextEncoder().encode(csv), 'csv');
  expect(parsed.problems).toEqual([]);
  return parsed.rows.map((row) => ({ row, reading: interpretRecordRow(definition, row.cells) }));
}

describe('Produced record CSV', () => {
  it('writes the import template’s columns, each number and time followed by it as entered, then the produced columns', () => {
    expect(producedCsvColumns(identity)).toEqual([
      ...recordImportColumns(identity).flatMap((column) =>
        identity.fields.some(
          (field) => field.name === column.key && (field.kind === 'number' || field.kind === 'date_time'),
        )
          ? [column.key, `${column.key} as entered`]
          : [column.key],
      ),
      'recordId',
      'recordedAt',
      'recordedBy',
      'replacedBy',
      'originalFile',
      'originalSha256',
      'notes',
    ]);
  });

  it('round-trips through the importer as the same records, keeping stored units and noting conversions', () => {
    const record = {
      windowStartsAt: '2026-11-10T16:00:00Z',
      windowEndsAt: '2026-11-10T17:00:00Z',
      operationKind: 'inspection',
      plannedOriginDescription: 'North pad, "gate 2"',
      plannedDestinationDescription: 'North pad',
      routeSummary: 'Line segment 14,\ntowers 3 to 22',
      pilotInOperatingArea: 'yes',
      plannedMaxHeightAboveGroundMeters: 45.72,
      plannedMaxGroundSpeedMetersPerSecond: 12.861111,
    };
    const csv = producedRecordCsv(plan, [
      produced({
        recordId: 'rec-plan',
        subject: { kind: 'flight', id: 'RIDGE-FLT-1', scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' },
        record,
        limitations: ['Planned maximum height above ground was entered as 150 ft and recorded as 45.72 m.'],
      }),
    ]);
    const [only] = reimport(plan, csv);
    expect(only!.reading.problems).toEqual([]);
    expect(only!.reading.record).toEqual(record);
    expect(only!.reading.conversions).toEqual([]);
    expect(only!.reading.subject).toEqual({ kind: 'flight', id: 'RIDGE-FLT-1', scope: 'source' });
    expect(only!.reading.secondarySubject).toEqual({ kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' });
    expect(only!.reading.recordId).toBe('rec-plan');
    expect(only!.row.cells.notes).toBe(
      'Planned maximum height above ground was entered as 150 ft and recorded as 45.72 m.',
    );
    expect(csv.split('\r\n')[0]).toContain('plannedMaxHeightAboveGroundMeters');
  });

  it('shows each number and time as it was entered, with its unit or zone, beside the stored value', () => {
    const record = {
      windowStartsAt: '2026-11-10T16:00:00Z',
      windowEndsAt: '2026-11-10T17:00:00Z',
      operationKind: 'inspection',
      plannedMaxHeightAboveGroundMeters: 45.72,
      plannedMaxGroundSpeedMetersPerSecond: 12,
    };
    const csv = producedRecordCsv(plan, [
      produced({
        subject: { kind: 'flight', id: 'RIDGE-FLT-1', scope: 'source' },
        record,
        entered: { plannedMaxHeightAboveGroundMeters: '150 ft', windowStartsAt: '2026-11-10 09:00 in America/Denver' },
      }),
    ]);
    const [only] = reimport(plan, csv);
    expect(only!.reading.problems).toEqual([]);
    expect(only!.reading.record).toEqual(record);
    expect(only!.row.cells).toMatchObject({
      plannedMaxHeightAboveGroundMeters: '45.72',
      'plannedMaxHeightAboveGroundMeters as entered': '150 ft',
      plannedMaxGroundSpeedMetersPerSecond: '12',
      'plannedMaxGroundSpeedMetersPerSecond as entered': '12 m/s',
      windowStartsAt: '2026-11-10T16:00:00Z',
      'windowStartsAt as entered': '2026-11-10 09:00 in America/Denver',
      'windowEndsAt as entered': '2026-11-10T17:00:00Z',
    });
  });

  it('writes a record placed by a date alone as that date, says so, and imports it on the same day', () => {
    const inspection = type('aircraft.inspection');
    const placing = inspection.fields.find((field) => field.kind === 'date_time' && field.required)!;
    const record = { [placing.name]: '2026-10-05T06:00:00.000Z' };
    const csv = producedRecordCsv(inspection, [
      produced({
        record,
        entered: { [placing.name]: '2026-10-05 (date only)' },
        dayOnly: { [placing.name]: { day: '2026-10-05' } },
      }),
    ]);
    const [only] = reimport(inspection, csv);
    expect(only!.row.cells[placing.name]).toBe('2026-10-05');
    expect(only!.row.cells[`${placing.name} as entered`]).toBe('2026-10-05 (date only)');
    expect(csv).not.toContain('2026-10-05T06:00');
    expect(interpretRecordRow(inspection, only!.row.cells, { timeZone: 'America/Denver' }).dayOnly).toEqual({
      [placing.name]: { day: '2026-10-05', timeZone: 'America/Denver', nextDayAt: '2026-10-06T06:00:00Z' },
    });
  });

  it('writes references by the operator’s own id', () => {
    const record = {
      personId: { id: 'RIDGE-P-01', scope: 'source' },
      role: 'pilot_in_command',
      startsAt: '2026-11-10T16:00:00Z',
    };
    const csv = producedRecordCsv(roles, [
      produced({ subject: { kind: 'flight', id: 'RIDGE-FLT-1', scope: 'source' }, record }),
    ]);
    const [only] = reimport(roles, csv);
    expect(only!.reading.problems).toEqual([]);
    expect(only!.reading.record).toEqual(record);
    expect(only!.row.cells.subjectKind).toBe('flight');
  });

  it('leaves the subject blank for a record about the organization itself, so it imports about the importer’s own', () => {
    const record = {
      procedureKind: 'lost_link',
      title: 'Lost link procedure',
      documentReference: 'OPS-7',
      revision: '3',
      effectiveAt: '2026-01-01T00:00:00Z',
    };
    const csv = producedRecordCsv(procedure, [
      produced({ subject: { kind: 'organization', id: 'organization:tenant-x', scope: 'ledger' }, record }),
    ]);
    const [only] = reimport(procedure, csv);
    expect(only!.reading.problems).toEqual([]);
    expect(only!.reading.ownOrganization).toBe(true);
    expect(only!.reading.record).toEqual(record);
  });

  it('carries what replaced what, so a later row replaces an earlier one of the same file', () => {
    const csv = producedRecordCsv(standing, [
      produced({
        recordId: 'old',
        subject: { kind: 'person', id: 'RIDGE-P-01', scope: 'source' },
        record: { fullName: 'Avery Exampel', qualificationSummary: 'Remote pilot', duties: 'Pilot' },
        replacedBy: 'new',
      }),
      produced({
        recordId: 'new',
        subject: { kind: 'person', id: 'RIDGE-P-01', scope: 'source' },
        record: { fullName: 'Avery Example', qualificationSummary: 'Remote pilot', duties: 'Pilot' },
        replaces: 'old',
      }),
    ]);
    const rows = reimport(standing, csv);
    expect(rows.map(({ reading }) => [reading.recordId, reading.replaces])).toEqual([
      ['old', undefined],
      ['new', 'old'],
    ]);
    expect(rows[0]!.row.cells.replacedBy).toBe('new');
  });
});

describe('Subject names from records', () => {
  it('names a flight by its window in the organization’s zone and its route', () => {
    expect(
      recordSubjectName(
        plan,
        { windowStartsAt: '2026-11-10T16:00:00Z', windowEndsAt: '2026-11-10T17:30:00Z', routeSummary: 'Segment 14' },
        'America/Denver',
      ),
    ).toBe('2026-11-10 09:00 to 10:30 (America/Denver), Segment 14');
  });
  it('names an aircraft by make and model and registration, and a person by name', () => {
    expect(
      recordSubjectName(identity, { aircraftMakeModel: 'Example Quad X8', registrationNumber: 'EX-0001' }, 'UTC'),
    ).toBe('Example Quad X8, EX-0001');
    expect(recordSubjectName(standing, { fullName: 'Avery Example' }, 'UTC')).toBe('Avery Example');
  });
  it('gives no name for a record type that names nothing or a record without its name fields', () => {
    expect(recordSubjectName(procedure, { title: 'Lost link' }, 'UTC')).toBeUndefined();
    expect(recordSubjectName(standing, { duties: 'Pilot' }, 'UTC')).toBeUndefined();
  });
});

function recordRow(
  id: string,
  values: { recordType: string; record: Record<string, unknown> },
  extra: Partial<RecordRow> = {},
): RecordRow {
  return {
    id,
    receipt_id: `receipt-${id}`,
    event_id: `event-${id}`,
    source_id: 'operator-records',
    principal_id: 'principal-avery',
    principal_name: 'Avery Example',
    artifact_id: 'artifact-1',
    content_type: 'text/csv',
    byte_length: 11,
    artifact_sha256: sha256(Buffer.from('subjectId\r\n')),
    filename: 'aircraft identity.csv',
    subject_kind: 'aircraft',
    subject_id: 'RIDGE-AC-1',
    subject_scope: 'source',
    subject_ledger_id: null,
    subject_resolution: 'unresolved',
    secondary_subject_kind: null,
    secondary_subject_id: null,
    secondary_subject_scope: null,
    secondary_subject_ledger_id: null,
    secondary_subject_resolution: null,
    occurred_at: new Date('2026-11-02T10:00:00Z'),
    interval_start: null,
    interval_end: null,
    received_at: new Date('2026-11-02T10:00:00Z'),
    observation: { values: { ...values, recordVersion: 1 }, limitations: [] },
    replaces_observation_id: null,
    replaced_by: null,
    about: 'subject',
    page_time: '2026-11-02T10:00:00.000000Z',
    ...extra,
  } as RecordRow;
}

function sources(includeOriginals: boolean): ProductionSources {
  const original = {
    artifactId: 'artifact-1',
    filename: 'aircraft identity.csv',
    contentType: 'text/csv',
    byteLength: 11,
    sha256: sha256(Buffer.from('subjectId\r\n')),
    records: 2,
    otherRecords: 0,
    path: null,
  };
  return {
    organization: { id: 'tenant-ridge', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
    selection: {
      subjects: [{ kind: 'aircraft', id: 'RIDGE-AC-1' }],
      recordTypes: [],
      from: null,
      to: null,
      includeOriginals,
      withFlights: false,
      sourceId: 'operator-records',
    },
    subjects: [{ kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' }],
    rows: [
      recordRow(
        'rec-2',
        {
          recordType: 'aircraft.identity',
          record: { aircraftMakeModel: 'Example Quad X8', serialNumber: 'SN-2', registrationNumber: 'EX-0001' },
        },
        { replaces_observation_id: 'rec-1', received_at: new Date('2026-11-03T10:00:00Z') },
      ),
      recordRow(
        'rec-1',
        {
          recordType: 'aircraft.identity',
          record: { aircraftMakeModel: 'Example Quad X8', serialNumber: 'SN-1', registrationNumber: 'EX-0001' },
        },
        { replaced_by: 'rec-2' },
      ),
    ],
    names: new Map([['aircraft RIDGE-AC-1', 'Example Quad X8, EX-0001']]),
    recordedBy: new Map([['principal-avery', 'Avery Example']]),
    originals: [original],
    flights: [],
    originalBytes: includeOriginals ? new Map([['artifact-1', Buffer.from('subjectId\r\n')]]) : new Map(),
    journal: [{ stream: 'source:principal-avery:operator-records:artifact-1', sequence: 2, headHash: 'b'.repeat(64) }],
    limits: { maxRecords: 10, maxSubjects: 5, maxOriginalBytes: 1024, maxArchiveBytes: 1024 * 1024 },
  };
}

const issue = {
  productionId: 'production-1',
  producedBy: { id: 'principal-avery', name: 'Avery Example' },
  producedAt: '2026-11-20T15:00:00.000Z',
  reason: 'Inspection of maintenance records',
  requestedBy: 'Inspector, regional office',
};

describe('Produced file and its verifier', () => {
  it('holds an index, a manifest and a CSV per record type, and verifies offline against the kept digest', () => {
    const assembled = assembleRecordProduction(sources(true), issue);
    const entries = readZip(assembled.archive, {
      list: [],
      add() {},
      check: (condition: unknown) => Boolean(condition),
    });
    expect([...entries.keys()]).toEqual([
      'index.html',
      'manifest.json',
      'records/aircraft.identity-v1.csv',
      'originals/artifact-1/aircraft_identity.csv',
    ]);
    expect(assembled.manifest).toMatchObject({
      format: 'ledger.record-production.1',
      organization: { name: 'Example Ridge Survey' },
      reason: issue.reason,
      requestedBy: issue.requestedBy,
      counts: { records: 2, recordTypes: 1, replaced: 1, originals: 1, originalsIncluded: 1, originalBytes: 11 },
      journal: [{ sequence: 2 }],
    });
    const csv = csvRows(entries.get('records/aircraft.identity-v1.csv')!.toString('utf8')).rows;
    expect(csv.slice(1).map((row) => row[csv[0]!.indexOf('recordId')])).toEqual(['rec-1', 'rec-2']);
    const index = entries.get('index.html')!.toString('utf8');
    expect(index).not.toMatch(/<script|https?:\/\//);
    expect(index).toContain('Example Quad X8, EX-0001 (aircraft RIDGE-AC-1)');
    expect(index).toContain('Replaced by rec-2');
    const verified = verifyRecordProduction(assembled.archive, { expectedManifestDigest: assembled.manifestSha256 });
    expect(verified).toMatchObject({
      status: 'verified',
      counts: { records: 2 },
      originals: { listed: 1, included: 1 },
    });
    expect(verifyRecordProduction(assembled.archive).status).toBe('internally_consistent');
  });

  it('gives the same bytes for the same records and issue', () => {
    expect(sha256(assembleRecordProduction(sources(false), issue).archive)).toBe(
      sha256(assembleRecordProduction(sources(false), issue).archive),
    );
  });

  it('lists originals without including them unless asked', () => {
    const assembled = assembleRecordProduction(sources(false), issue);
    expect(assembled.manifest.originals).toEqual([expect.objectContaining({ artifactId: 'artifact-1', path: null })]);
    expect(assembled.manifest.files.map((file) => file.path)).toEqual([
      'index.html',
      'records/aircraft.identity-v1.csv',
    ]);
    expect(verifyRecordProduction(assembled.archive, { expectedManifestDigest: assembled.manifestSha256 }).status).toBe(
      'verified',
    );
  });

  it('fails a file whose manifest differs from the kept digest, a changed file, or a file the manifest does not list', () => {
    const assembled = assembleRecordProduction(sources(false), issue);
    expect(verifyRecordProduction(assembled.archive, { expectedManifestDigest: '0'.repeat(64) })).toMatchObject({
      status: 'failed',
      issues: [expect.objectContaining({ code: 'manifest_anchor' })],
    });
    const entries = readZip(assembled.archive, {
      list: [],
      add() {},
      check: (condition: unknown) => Boolean(condition),
    });
    const changed = [...entries].map(([path, bytes]) => ({
      path,
      bytes: path.endsWith('.csv') ? Buffer.from(bytes.toString('utf8').replace('SN-1', 'SN-9')) : bytes,
    }));
    expect(verifyRecordProduction(writeZip(changed, issue.producedAt)).issues).toEqual([
      expect.objectContaining({ code: 'file_digest', path: '$.files["records/aircraft.identity-v1.csv"]' }),
    ]);
    const extra = [
      ...[...entries].map(([path, bytes]) => ({ path, bytes })),
      { path: 'notes.txt', bytes: Buffer.from('x') },
    ];
    expect(verifyRecordProduction(writeZip(extra, issue.producedAt)).issues).toEqual([
      expect.objectContaining({ code: 'file_unlisted' }),
    ]);
    expect(verifyRecordProduction(Buffer.from('not a zip')).issues).toEqual([
      expect.objectContaining({ code: 'zip_structure' }),
    ]);
  });

  it('refuses an index page that runs a script or loads from elsewhere', () => {
    const assembled = assembleRecordProduction(sources(false), issue);
    const entries = readZip(assembled.archive, {
      list: [],
      add() {},
      check: (condition: unknown) => Boolean(condition),
    });
    const page = Buffer.from('<html><img src="https://example.invalid/x.png"><script>1</script></html>');
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    manifest.files = manifest.files.map((file: { path: string }) =>
      file.path === 'index.html' ? { ...file, byteLength: page.length, sha256: sha256(page) } : file,
    );
    const rebuilt = [...entries].map(([path, bytes]) => ({
      path,
      bytes: path === 'index.html' ? page : path === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : bytes,
    }));
    expect(
      verifyRecordProduction(writeZip(rebuilt, issue.producedAt)).issues.map((item: { code: string }) => item.code),
    ).toEqual(['index_page', 'index_page']);
  });

  it('verifies from the command line with Node alone, exiting 0 when verified, 2 without the digest and 1 on failure', () => {
    const assembled = assembleRecordProduction(sources(true), issue);
    const directory = mkdtempSync(join(tmpdir(), 'record-production-'));
    const file = join(directory, 'records.zip');
    writeFileSync(file, assembled.archive);
    const cli = join(import.meta.dirname, '..', '..', 'tools', 'verifier', 'record-production-cli.mjs');
    const run = (...args: string[]) => {
      try {
        return { code: 0, output: JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' })) };
      } catch (error) {
        const failed = error as { status: number; stdout: string };
        return { code: failed.status, output: JSON.parse(failed.stdout) };
      }
    };
    expect(run(file, '--expected-manifest-sha256', assembled.manifestSha256)).toMatchObject({
      code: 0,
      output: { status: 'verified', counts: { records: 2 } },
    });
    expect(run(file)).toMatchObject({ code: 2, output: { status: 'internally_consistent' } });
    expect(run(file, '--expected-manifest-sha256', 'f'.repeat(64))).toMatchObject({
      code: 1,
      output: { status: 'failed', issues: [{ code: 'manifest_anchor' }] },
    });
  });
});

describe('Records produced for a pilot', () => {
  const pilot = { kind: 'person' as const, id: 'RIDGE-P-1', scope: 'source' as const };
  const assignment = (id: string, flight: string, person: string, start: string, end: string) =>
    recordRow(
      id,
      {
        recordType: 'operation.role-assignment',
        record: {
          personId: { id: person, scope: 'source' },
          role: 'remote_pilot_in_command',
          startsAt: start,
          endsAt: end,
        },
      },
      {
        subject_kind: 'flight',
        subject_id: flight,
        interval_start: new Date(start),
        interval_end: new Date(end),
        about: 'reference',
      },
    );

  it('lists the flights the pilot was assigned to, with their ids and times', () => {
    const rows = [
      assignment('a-2', 'RIDGE-F-2', 'RIDGE-P-1', '2026-10-02T15:00:00Z', '2026-10-02T16:00:00Z'),
      assignment('a-1', 'RIDGE-F-1', 'RIDGE-P-1', '2026-10-01T15:00:00Z', '2026-10-01T16:00:00Z'),
      assignment('a-3', 'RIDGE-F-3', 'RIDGE-P-2', '2026-10-03T15:00:00Z', '2026-10-03T16:00:00Z'),
    ];
    const flights = assignedFlights([pilot], rows);
    expect(flights).toEqual([
      {
        person: 'RIDGE-P-1',
        flight: 'RIDGE-F-1',
        start: '2026-10-01T15:00:00.000Z',
        end: '2026-10-01T16:00:00.000Z',
        recordId: 'a-1',
      },
      {
        person: 'RIDGE-P-1',
        flight: 'RIDGE-F-2',
        start: '2026-10-02T15:00:00.000Z',
        end: '2026-10-02T16:00:00.000Z',
        recordId: 'a-2',
      },
    ]);
    const base = sources(false);
    const assembled = assembleRecordProduction(
      {
        ...base,
        selection: { ...base.selection, subjects: [{ kind: 'person', id: 'RIDGE-P-1' }] },
        subjects: [pilot],
        rows: rows.slice(0, 2),
        flights,
        originals: [{ ...base.originals[0]!, records: 2, otherRecords: 1 }],
      },
      issue,
    );
    expect(assembled.manifest.flights).toEqual(flights);
    expect(assembled.manifest.counts).toMatchObject({ flights: 2, originalsWithOtherRecords: 1, otherRecords: 1 });
    const index = readZip(assembled.archive, { list: [], add() {}, check: (condition: unknown) => Boolean(condition) })
      .get('index.html')!
      .toString('utf8');
    expect(index).toContain('<h2>Flights assigned</h2>');
    expect(index).toContain('2026-10-01 09:00 to 2026-10-01 10:00 (America/Denver)');
    expect(assembled.manifest.statements).toContain(
      '1 original file also holds 1 record this file does not, about other subjects. The table of original files gives the number for each.',
    );
  });
});
