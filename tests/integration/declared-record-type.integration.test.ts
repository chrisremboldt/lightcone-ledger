import 'dotenv/config';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdoptionRuleCoverageResponse,
  OperatorRecordListResponse,
  OperatorRecordPreviewResponse,
  OperatorRecordTypesResponse,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { buildPackFolder, registerPackFolder, registerStandardPacks } from '../../packages/standard-packs/src/index.js';
import { readZip, verifyRecordProduction } from '../../tools/verifier/record-production.mjs';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// The worked example of docs/design/declared-record-types.md and docs/guides/write-a-rule-pack.md, as an operator's
// agent runs it: build the pack, load it from a pack folder, adopt it, import the records as CSV and read coverage.
// If this test and those documents disagree, this test is right.
const example = new URL('../../examples/declared-record-type/', import.meta.url);
const TYPE = 'example-ridge-procedures.airframe-check';
const RULE = 'example-ridge-procedures.airframe-serviceable';
const csv = (name: string) => readFileSync(new URL(`records/${name}`, example));

describe('A record type a pack declares, adopted by one organization', () => {
  let owner: CoverageTenant;
  let other: CoverageTenant;
  let pack: RulePackVersion;
  let adoptionId: string;

  beforeAll(async () => {
    registerStandardPacks();
    const folder = mkdtempSync(join(process.cwd(), '.local', 'declared-record-type-'));
    const built = buildPackFolder(new URL('.', example).pathname);
    writeFileSync(join(folder, 'example-ridge-procedures-v1.pack.json'), JSON.stringify(built.file));
    pack = registerPackFolder(folder)[0]!.version;
    owner = await coverageTenant('declared-type-owner');
    other = await coverageTenant('declared-type-other');
  });
  afterAll(async () => {
    await settleOwnedWork([owner?.prefix, other?.prefix].filter(Boolean) as string[]);
    await owner?.close();
    await other?.close();
  });

  const types = async (tenant: CoverageTenant) => {
    const read = await tenant.call(tenant.operator, 'GET', '/v1/operator-records/types');
    expect(read.statusCode, read.body).toBe(200);
    return (read.json() as OperatorRecordTypesResponse).types;
  };
  const request = (artifactId: string, extra: Record<string, unknown> = {}) => ({
    artifactId,
    recordType: TYPE,
    recordVersion: 1,
    ...extra,
  });

  it('is offered only once the pack is adopted, with its columns and template', async () => {
    expect((await types(owner)).some((type) => type.recordType === TYPE)).toBe(false);
    adoptionId = await owner.adopt(pack, 'active');
    const declared = (await types(owner)).find((type) => type.recordType === TYPE)!;
    expect(declared).toMatchObject({
      title: 'Airframe check',
      subjectKinds: ['aircraft'],
      declaredBy: { packId: 'example-ridge-procedures', digest: pack.recordTypes![0]!.digest },
      ruleRead: { type: 'operator.record', where: [{ field: 'values.recordType', oneOf: [TYPE] }] },
    });
    expect(declared.columns.map((column) => column.key)).toEqual([
      'subjectId',
      'checkedAt',
      'inspectorId',
      'result',
      'airframeHours',
      'replaces',
    ]);
    const template = await owner.call(owner.operator, 'GET', `/v1/operator-records/types/${TYPE}/versions/1/template`);
    expect(template.statusCode, template.body).toBe(200);
    expect(template.body.trim()).toBe(csv('example-ridge-procedures.airframe-check.csv').toString().split(/\r?\n/)[0]);
  });

  it('checks and imports the CSV, and a column mapping reads an export in its own columns', async () => {
    await owner.importRecords('aircraft.identity', [
      { subjectId: 'RIDGE-AC-1', aircraftMakeModel: 'Fictional Survey Quad X8', serialNumber: 'SN-1' },
      { subjectId: 'RIDGE-AC-2', aircraftMakeModel: 'Fictional Survey Quad X8', serialNumber: 'SN-2' },
      { subjectId: 'RIDGE-AC-3', aircraftMakeModel: 'Fictional Mapper M2', serialNumber: 'SN-3' },
    ]);
    const artifactId = await owner.upload(csv('example-ridge-procedures.airframe-check.csv'), 'text/csv');
    const preview = await owner.call(
      owner.operator,
      'POST',
      '/v1/operator-records/imports/preview',
      request(artifactId),
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const checked = preview.json() as OperatorRecordPreviewResponse;
    expect(checked.summary).toMatchObject({ rows: 2, acceptable: 2, refused: 0, incomplete: 0 });
    expect(checked.rows[1]?.dayOnly?.checkedAt?.day).toBe('2026-11-03');
    const committed = await owner.call(owner.operator, 'POST', '/v1/operator-records/imports', request(artifactId));
    expect(committed.statusCode, committed.body).toBe(201);

    const mapping = await owner.upload(
      Buffer.from(
        [
          `recordType: ${TYPE}`,
          'recordVersion: 1',
          'times: { zone: utc }',
          'subject: { column: Tail }',
          'columns:',
          "  'Tail': ~",
          "  'When': checkedAt",
          "  'Who': inspectorId",
          "  'Outcome': result",
          "  'Hours': { field: airframeHours, unit: h }",
          'constants: {}',
        ].join('\n'),
      ),
      'application/yaml',
    );
    const exported = await owner.upload(
      Buffer.from('Tail,When,Who,Outcome,Hours\nRIDGE-AC-1,2026-11-20T15:00:00Z,RIDGE-P-01,serviceable,120\n'),
      'text/csv',
    );
    const mapped = await owner.call(
      owner.operator,
      'POST',
      '/v1/operator-records/imports/preview',
      request(exported, { mappingArtifactId: mapping }),
    );
    expect(mapped.statusCode, mapped.body).toBe(200);
    expect((mapped.json() as OperatorRecordPreviewResponse).summary, mapped.body).toMatchObject({
      acceptable: 1,
      refused: 0,
    });

    const listed = await owner.call(owner.operator, 'GET', `/v1/operator-records?recordType=${TYPE}`);
    expect(listed.statusCode, listed.body).toBe(200);
    const records = (listed.json() as OperatorRecordListResponse).records;
    expect(records.map((record) => record.subject.id).sort()).toEqual(['RIDGE-AC-1', 'RIDGE-AC-2']);
    expect(records.every((record) => record.complete)).toBe(true);
    const stored = await owner.admin.query(
      `SELECT observation->'values'->>'declarationDigest' AS digest FROM observations
       WHERE tenant_id=$1 AND observation->'values'->>'recordType'=$2`,
      [owner.tenantId, TYPE],
    );
    expect(stored.rows.map((row) => row.digest)).toEqual([pack.recordTypes![0]!.digest, pack.recordTypes![0]!.digest]);
  });

  it('is checked by a generic check kind: each aircraft on record, including one with no record on file', async () => {
    await owner.settle();
    const read = await owner.call(owner.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(read.statusCode, read.body).toBe(200);
    const rule = (read.json() as AdoptionRuleCoverageResponse).rules.find((item) => item.leafId === RULE);
    expect(rule).toMatchObject({
      checkedBy: 'automatic',
      subjectKind: 'aircraft',
      populationSize: 3,
      counts: { supported: 1, attention: 1, no_record: 1, not_evaluated: 0 },
    });
  });

  it('is produced on request with the other records, as a file the offline verifier accepts', async () => {
    const produced = await owner.call(owner.operator, 'POST', '/v1/record-productions', {
      subjects: [{ kind: 'aircraft', id: 'RIDGE-AC-2' }],
      recordTypes: [TYPE],
      includeOriginals: true,
      reason: 'Airframe checks asked for at an inspection',
      requestedBy: 'Inspector, regional office',
    });
    expect(produced.statusCode, produced.body).toBe(201);
    const record = produced.json().record;
    expect(record.counts).toMatchObject({ records: 1, recordTypes: 1 });
    const download = await owner.call(owner.operator, 'GET', `/v1/record-productions/${record.id}/content`);
    expect(download.statusCode).toBe(200);
    const verified = verifyRecordProduction(download.rawPayload, { expectedManifestDigest: record.manifestSha256 });
    expect(verified).toMatchObject({ status: 'verified', counts: { records: 1 } });
    const entries = readZip(download.rawPayload, {
      list: [],
      add() {},
      check: (condition: unknown) => Boolean(condition),
    });
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    const file = manifest.files.find((item: { role: string; recordType?: string }) => item.role === 'records');
    expect(file.recordType).toBe(TYPE);
    const [header, row] = entries.get(file.path)!.toString('utf8').split(/\r?\n/);
    // The import template's columns, each converted one beside what was entered, then what a production adds.
    expect(header).toBe(
      'subjectId,checkedAt,checkedAt as entered,inspectorId,result,airframeHours,airframeHours as entered,replaces,recordId,recordedAt,recordedBy,replacedBy,originalFile,originalSha256,notes',
    );
    expect(row).toContain('RIDGE-AC-2');
    expect(row).toContain('repair-needed');
    // Another organization cannot ask for a type it does not have.
    const refused = await other.call(other.operator, 'POST', '/v1/record-productions', {
      subjects: [{ kind: 'aircraft', id: 'RIDGE-AC-2' }],
      recordTypes: [TYPE],
      reason: 'A test of what another organization may produce',
      requestedBy: 'Nobody',
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.message).toMatch(/not one your organization has/);
  });

  it('is not visible to another organization in any read, and its records are refused there', async () => {
    expect((await types(other)).some((type) => type.recordType === TYPE)).toBe(false);
    const template = await other.call(other.operator, 'GET', `/v1/operator-records/types/${TYPE}/versions/1/template`);
    expect(template.statusCode).toBe(404);
    const artifactId = await other.upload(csv('example-ridge-procedures.airframe-check.csv'), 'text/csv');
    const preview = await other.call(
      other.operator,
      'POST',
      '/v1/operator-records/imports/preview',
      request(artifactId),
    );
    expect(preview.statusCode).toBe(404);
    expect(preview.json().error.message).toMatch(/not one your organization has/);
    // Generic intake refuses it too, even naming the right declaration.
    const intake = await other.call(other.operator, 'POST', '/v1/inputs', {
      sourceId: other.sourceId,
      kind: 'observation',
      occurredAt: '2026-11-02T15:00:00Z',
      payload: {
        type: 'operator.record',
        version: 1,
        subject: { kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' },
        occurredAt: '2026-11-02T15:00:00Z',
        fidelity: 'documented_schema_conformant',
        limitations: [],
        originalArtifactId: artifactId,
        values: {
          recordType: TYPE,
          recordVersion: 1,
          declarationDigest: pack.recordTypes![0]!.digest,
          record: {
            checkedAt: '2026-11-02T15:00:00Z',
            inspectorId: { id: 'RIDGE-P-01', scope: 'source' },
            result: 'serviceable',
            airframeHours: 112.5,
          },
        },
      },
    });
    expect(intake.statusCode, intake.body).toBe(400);
    expect(intake.json().error.code).toBe('unregistered_record_type');
    const listed = await other.call(other.operator, 'GET', `/v1/operator-records?recordType=${TYPE}`);
    expect((listed.json() as OperatorRecordListResponse).records).toEqual([]);
  });
});
