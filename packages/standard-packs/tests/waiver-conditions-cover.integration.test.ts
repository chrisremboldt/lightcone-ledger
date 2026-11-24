import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import type {
  AdoptionParameterValues,
  AdoptionRuleCoverageResponse,
  OrganizationCoverageResponse,
  PackFile,
  RuleEvaluationRecord,
  RulePackVersion,
} from '../../contracts/src/index.js';
import { getRulePackVersion, listRulePackVersions } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { PART107_PACK_ID } from '../../pack-part107/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { databaseNow, runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const example = fileURLToPath(new URL('./fixtures/ridge-survey-waiver/', import.meta.url));
const DAY = 86_400_000;
/** The day the invented records were written about; the test moves every date by whole days to the database clock. */
const RECORDS_WRITTEN = Date.parse('2026-11-20T00:00:00Z');
const VLOS_RULE = 'ledger.part107.107.31.a';

// The order the records are imported in: people and aircraft, then the flights and what is recorded about them.
const recordTypes = [
  'person.standing',
  'person.certificate',
  'person.training',
  'aircraft.identity',
  'aircraft.inspection',
  'aircraft.detect-and-avoid',
  'maintenance.action',
  'organization.procedure',
  'flight.plan',
  'operation.role-assignment',
  'operation.notification',
  'flight.preflight-assessment',
  'flight.record',
  'occurrence.emergency-deviation',
];

/** A CSV cell that is a date or an instant, moved by whole days. */
function moved(cell: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(cell)) return cell;
  const at = new Date(Date.parse(cell.length === 10 ? `${cell}T00:00:00Z` : cell) + days * DAY).toISOString();
  return cell.length === 10 ? at.slice(0, 10) : `${at.slice(0, 19)}Z`;
}

/** The example's CSV file, with its dates moved; no quoted cell holds a date, so cells split on commas outside quotes. */
function csvMoved(recordType: string, days: number): Buffer {
  const text = readFileSync(join(example, 'records', `${recordType}.csv`), 'utf8');
  return Buffer.from(
    text.replace(/(^|,)([^,"\n]*)(?=,|$)/gm, (_match, before: string, cell: string) => before + moved(cell, days)),
  );
}

// An operator that flies most flights under Part 107 alone holds a waiver for flights beyond visual line of sight.
// Its own pack is built from the waiver's text and description, adopted active beside Part 107, and its records are
// imported from CSV files. The waiver's conditions cover only the flights whose plan cites its certificate.
describe.runIf(process.env.LEDGER_ENV !== 'staging')(
  'A waiver whose conditions cover the flights flown under it',
  () => {
    const prefix = `waiver-cover-${randomUUID()}`;
    const tenantId = `${prefix}:operator`;
    const sourceId = 'operator-records';
    const pool = createPool();
    const admin = createPool(process.env.DATABASE_ADMIN_URL);
    const workerPool = createPool(process.env.WORKER_DATABASE_URL);
    const base = { tenantId, revision: 1, kind: 'human', name: 'Harper Example' };
    const actor: AuthContext = {
      ...base,
      id: `${tenantId}:actor`,
      capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
    };
    const operator: AuthContext = {
      ...base,
      id: `${tenantId}:records`,
      capabilities: ['input:write', 'flight:read', 'evidence:read'],
    };
    const packsDir = mkdtempSync(join(tmpdir(), 'ledger-packs-'));
    let app: Awaited<ReturnType<typeof createApp>>;
    let built: string;
    let file: PackFile;
    let waiverAdoption: string;
    let started: number;

    function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
      return app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ledger-dev-${principal.id}`,
          'idempotency-key': randomUUID(),
          ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    }

    async function importCsv(recordType: string, bytes: Buffer): Promise<void> {
      const created = await call(operator, 'POST', '/v1/uploads', {
        contentType: 'text/csv',
        byteLength: bytes.byteLength,
        filename: `${recordType}.csv`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().upload.id as string;
      expect((await call(operator, 'PUT', `/v1/uploads/${id}/content`, bytes)).statusCode).toBe(200);
      const finalized = await call(operator, 'POST', `/v1/uploads/${id}/finalize`);
      expect(finalized.statusCode, finalized.body).toBe(201);
      const committed = await call(operator, 'POST', '/v1/operator-records/imports', {
        artifactId: finalized.json().artifact.id,
        recordType,
        recordVersion: 1,
      });
      expect(committed.statusCode, committed.body).toBe(201);
      expect(committed.json().summary.refused, recordType).toBe(0);
    }

    async function settle(): Promise<void> {
      for (let attempt = 0; attempt < 400; attempt++) {
        if (await runOwnedWork(admin, workerPool, [prefix])) continue;
        const pending = await admin.query(
          `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
          [tenantId],
        );
        if (Number(pending.rows[0].count) === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Worker did not settle');
    }

    /** Every value an adoption asks for, valid for it. */
    function parametersFor(pack: RulePackVersion): AdoptionParameterValues | undefined {
      const values: AdoptionParameterValues = {};
      for (const leaf of pack.leaves)
        if ('adoptionParameters' in leaf && leaf.adoptionParameters.length)
          values[leaf.id] = Object.fromEntries(
            leaf.adoptionParameters.map((parameter) => [
              parameter.name,
              parameter.options?.[0] ??
                (parameter.valueType === 'string'
                  ? 'UTC'
                  : parameter.valueType === 'boolean'
                    ? true
                    : (parameter.minimum ?? 1)),
            ]),
          );
      return Object.keys(values).length ? values : undefined;
    }

    async function adopt(pack: RulePackVersion): Promise<string> {
      const shown = await call(actor, 'GET', '/v1/organization/coverage');
      expect(shown.statusCode, shown.body).toBe(200);
      const interval = {
        start: new Date(started - 30 * DAY).toISOString(),
        end: new Date(started + 60 * DAY).toISOString(),
      };
      const parameters = parametersFor(pack);
      const adopted = await call(actor, 'POST', '/v1/commands', {
        ...adoptShownPack(
          shown.json() as OrganizationCoverageResponse,
          pack,
          interval,
          'Fictional adoption.',
          'active',
        ),
        ...(parameters ? { parameters } : {}),
      });
      expect(adopted.statusCode, adopted.body).toBe(201);
      return adopted.json().command.id as string;
    }

    /** Every evaluation about one subject, newest first, read a page at a time. */
    async function evaluations(kind: string, subjectId: string): Promise<RuleEvaluationRecord[]> {
      const found: RuleEvaluationRecord[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({
          subjectKind: kind,
          subjectId,
          subjectScope: 'source',
          sourceId,
          limit: '100',
        });
        if (cursor) query.set('cursor', cursor);
        const response = await call(actor, 'GET', `/v1/evaluations?${query}`);
        expect(response.statusCode, response.body).toBe(200);
        found.push(...response.json().evaluations);
        cursor = response.json().page.nextCursor;
      } while (cursor);
      return found;
    }

    /** The latest result of each of the waiver's rules for one flight, by provision, as an outcome and reason. */
    async function waiverResults(flight: string): Promise<Record<string, string>> {
      const latest = new Map<string, RuleEvaluationRecord>();
      for (const evaluation of await evaluations('flight', flight))
        if (
          evaluation.pack.id === file.packId &&
          !latest.has(evaluation.rule.id + (evaluation.related?.subjectKey ?? ''))
        )
          latest.set(evaluation.rule.id + (evaluation.related?.subjectKey ?? ''), evaluation);
      const results: Record<string, string> = {};
      for (const evaluation of latest.values()) {
        if (evaluation.reasonCode === 'evaluated_per_related_subject') continue;
        const name = evaluation.rule.id.slice(file.packId.length + 1);
        results[name] = `${evaluation.outcome} ${evaluation.reasonCode}`;
      }
      return results;
    }

    beforeAll(async () => {
      started = Date.parse(await databaseNow(admin));
      built = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'packages/standard-packs/src/pack-cli.ts', 'build', example, '--out', packsDir],
        { cwd: repository, encoding: 'utf8' },
      );
      const fileName = readdirSync(packsDir).find((name) => name.endsWith('.pack.json'))!;
      file = JSON.parse(readFileSync(join(packsDir, fileName), 'utf8'));
      app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore(), packsDir });
      await app.ready();
      await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Example Ridge Survey']);
      const worker = {
        ...base,
        id: `${tenantId}:worker`,
        kind: 'worker',
        capabilities: ['flight:read', 'evidence:read', 'input:write'],
      };
      for (const principal of [actor, operator, worker]) {
        await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
          principal.id,
          tenantId,
          principal.name,
          principal.kind,
          principal.capabilities,
        ]);
        await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
          sha256(`ledger-dev-${principal.id}`),
          principal.id,
        ]);
      }
      const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(operator.id)}`);
      expect(current.statusCode, current.body).toBe(200);
      const granted = await call(actor, 'POST', '/v1/commands', {
        kind: 'authority.update',
        principalId: operator.id,
        expectedRevision: current.json().principal.revision,
        capabilities: current.json().principal.capabilities,
        observationGrants: [{ sourceId, observationType: 'operator.record' }],
      });
      expect(granted.statusCode, granted.body).toBe(201);

      const part107 = listRulePackVersions()
        .filter((pack) => pack.packId === PART107_PACK_ID)
        .at(-1)!;
      await adopt(getRulePackVersion(PART107_PACK_ID, part107.version)!);
      waiverAdoption = await adopt(getRulePackVersion(file.packId, file.version)!);
      const days = Math.round((started - RECORDS_WRITTEN) / DAY);
      for (const recordType of recordTypes) await importCsv(recordType, csvMoved(recordType, days));
      await settle();
    }, 240_000);
    afterAll(async () => {
      await settleOwnedWork([prefix]);
      if (app) await app.close();
      await pool.end();
      await admin.end();
      await workerPool.end();
    });

    it('is built from the waiver’s two files, which state what its conditions cover', () => {
      expect(file.waiver).toEqual({
        certificateNumber: 'EXW-0417',
        conditionsCover: 'flights_citing_certificate',
        effective: { from: '2026-06-01', through: '2028-05-31' },
      });
      expect(built).toContain(
        'Its conditions cover flights whose plan cites the certificate (the latest plan cites EXW-0417)',
      );
      // Each rule says what it covers.
      expect(built).toContain('covers the organization, once');
      expect(built.match(/covers each flight whose latest plan cites EXW-0417/g)).toHaveLength(11);
    });

    it('reports every provision as not applying to the ordinary flight, with why', async () => {
      const results = await waiverResults('RIDGE-FLT-1103');
      const checkedAboutFlights = file.rules.filter((rule) => 'check' in rule && rule.target.subjectKind === 'flight');
      expect(Object.keys(results).sort()).toEqual(
        checkedAboutFlights.map((rule) => rule.id.slice(file.packId.length + 1)).sort(),
      );
      for (const [name, result] of Object.entries(results))
        expect(result, name).toBe('not_applicable condition_not_met');
      const height = (await evaluations('flight', 'RIDGE-FLT-1103')).find((item) =>
        item.rule.id.endsWith('provision-4'),
      )!;
      expect(height.summary).toBe(
        'The latest flight plan does not cite EXW-0417 as its operating authority, so the waiver’s conditions do not cover this flight.',
      );
      // Counted under "Does not apply", with no finding.
      const coverage = await call(actor, 'GET', `/v1/organization/coverage/adoptions/${waiverAdoption}`);
      expect(coverage.statusCode, coverage.body).toBe(200);
      for (const rule of (coverage.json() as AdoptionRuleCoverageResponse).rules)
        // The relief provision is about the flights whose plan cites the certificate, so the ordinary flight is not
        // one of its members.
        if (rule.checkedBy === 'automatic' && rule.subjectKind === 'flight' && !rule.leafId.endsWith('.provision-1'))
          expect(rule.counts!.not_applicable, rule.leafId).toBeGreaterThanOrEqual(1);
      const findings = await admin.query(
        `SELECT COUNT(*) AS count FROM findings WHERE tenant_id=$1 AND pack_id=$2 AND subject_key LIKE '%RIDGE-FLT-1103%'`,
        [tenantId, file.packId],
      );
      expect(Number(findings.rows[0].count)).toBe(0);
    });

    it('gives the unlisted pilot and aircraft of the ordinary flight no waiver result', async () => {
      for (const [kind, id] of [
        ['person', 'RIDGE-P-04'],
        ['aircraft', 'RIDGE-AC-3'],
      ] as const)
        expect(
          (await evaluations(kind, id)).filter((evaluation) => evaluation.pack.id === file.packId),
          id,
        ).toEqual([]);
      const related = await admin.query(
        `SELECT COUNT(*) AS count FROM rule_evaluations WHERE tenant_id=$1 AND pack_id=$2
         AND (related_id IN ('RIDGE-P-04','RIDGE-AC-3') OR subject_key LIKE '%RIDGE-P-04%' OR subject_key LIKE '%RIDGE-AC-3%')`,
        [tenantId, file.packId],
      );
      expect(Number(related.rows[0].count)).toBe(0);
    });

    it('keeps the results of the flights flown under the waiver', async () => {
      // What the height reads is not this test's concern; only whether it is within the limit.
      const height = (outcome: string) => expect.stringMatching(new RegExp(`^${outcome} `));
      expect(await waiverResults('RIDGE-FLT-1101')).toEqual({
        'provision-1': 'pass within_dates',
        'provision-2': 'pass value_expected',
        'provision-3': 'pass value_expected',
        'provision-4': height('pass'),
        'provision-5': 'pass planned_within_limit',
        'provision-6': 'pass date_within_months',
        'provision-7': 'pass value_expected',
        'provision-9': 'pass made_in_time',
        'provision-10': 'pass planned_within_limit',
        'provision-12': 'not_applicable no_events',
        'provision-13': 'pass record_complete',
      });
      // Planned higher and farther than the waiver allows, a late notice, low visibility, an old course, equipment
      // recorded inoperative, a lost link reported late and a maintenance entry without who did the work.
      expect(await waiverResults('RIDGE-FLT-1102')).toEqual({
        'provision-1': 'pass within_dates',
        'provision-2': 'pass value_expected',
        'provision-3': 'pass value_expected',
        'provision-4': height('attention'),
        'provision-5': 'attention planned_beyond_limit',
        'provision-6': 'attention date_outside_months',
        'provision-7': 'attention value_unexpected',
        'provision-9': 'attention made_late',
        'provision-10': 'attention planned_beyond_limit',
        'provision-12': 'attention answer_late',
        'provision-13': 'attention record_incomplete',
      });
      // Planned for later: its notice and preflight assessment are not due yet, and its pilot has no course on file.
      // Its aircraft's detect-and-avoid check was made before that aircraft's previous flight, so none is on file for it.
      expect(await waiverResults('RIDGE-FLT-1201')).toEqual({
        'provision-1': 'pass within_dates',
        'provision-2': 'pass value_expected',
        'provision-3': 'pass value_expected',
        'provision-4': height('pass'),
        'provision-5': 'pass planned_within_limit',
        'provision-6': 'pending record_not_on_file',
        'provision-7': 'pending record_not_on_file',
        'provision-9': 'pending not_made_yet',
        'provision-10': 'pending planned_value_missing',
        'provision-12': 'not_applicable no_events',
        'provision-13': 'pass record_complete',
      });
      const course = (await evaluations('flight', 'RIDGE-FLT-1201')).find((item) =>
        item.rule.id.endsWith('provision-6'),
      )!;
      expect(course).toMatchObject({
        related: { name: 'pilot', subject: { id: 'RIDGE-P-03' } },
        summary: 'No record of the named training on file.',
      });
    });

    it('checks the lost link procedure once, for the organization', async () => {
      const coverage = (await call(actor, 'GET', `/v1/organization/coverage/adoptions/${waiverAdoption}`)).json();
      const procedure = (coverage as AdoptionRuleCoverageResponse).rules.find((rule) =>
        rule.leafId.endsWith('provision-8'),
      )!;
      expect(procedure).toMatchObject({ subjectKind: 'organization', populationSize: 1, counts: { supported: 1 } });
    });

    it('relieves the visual-line-of-sight rule as before: only for the flights the relief provision covers', async () => {
      for (const flight of ['RIDGE-FLT-1101', 'RIDGE-FLT-1102', 'RIDGE-FLT-1201']) {
        const rule = (await evaluations('flight', flight)).find((item) => item.rule.id === VLOS_RULE)!;
        expect(rule, flight).toMatchObject({
          outcome: 'relieved',
          relief: { mode: 'active', coverage: { covered: true } },
        });
      }
      const ordinary = (await evaluations('flight', 'RIDGE-FLT-1103')).find((item) => item.rule.id === VLOS_RULE)!;
      expect(ordinary.outcome).not.toBe('relieved');
      expect(ordinary.relief).toMatchObject({ coverage: { covered: false } });
    });
  },
);
