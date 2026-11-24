import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { setUpCredential } from '../../apps/api/src/credential-setup.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import type {
  SmsHomeResponse,
  SmsRecordDetailResponse,
  SmsRegisterResponse,
} from '../../packages/contracts/src/index.js';
import type { DevelopmentTokenResponse } from '../../packages/contracts/src/development-tokens.js';
import { runCli } from '../../packages/cli/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

// The safety part of examples/first-operator, as docs/guides/bring-your-safety-records.md runs it: a service drafts
// the operator's own files, people decide with their own development tokens, through the command-line client's code.
// If the guide and this test ever disagree, this test is right.
const example = join(import.meta.dirname, '..', '..', 'examples', 'first-operator');
const safety = (file: string) => `safety/${file}`;
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-safety-files-${run}`;
const narrative = 'the control link dropped for twelve seconds';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Safety records brought in from the operator’s own files', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const logged: string[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'ledger-safety-files-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let avery: string;

  /** fetch, answered by the API in this process. */
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const response = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(response.rawPayload.byteLength ? response.rawPayload : null, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  }) as typeof fetch;

  async function ledger(credential: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      env: { LEDGER_API_URL: 'http://ledger.invalid', LEDGER_TOKEN: credential },
      folders: [example],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetcher,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  async function ok(credential: string, ...argv: string[]) {
    const result = await ledger(credential, ...argv);
    expect(result.code, `${argv.join(' ')}\n${result.out}\n${result.err}`).toBe(0);
    return result.out;
  }
  async function read<T>(credential: string, path: string): Promise<T> {
    const response = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${credential}` } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as T;
  }
  const byReference = async (credential: string, kind: string, reference: string) =>
    (
      await read<SmsRegisterResponse>(
        credential,
        `/v1/sms/records?kind=${kind}&reference=${encodeURIComponent(reference)}`,
      )
    ).records;
  async function tokenFor(principalId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/authority/principals/${principalId}/development-token`,
      headers: { authorization: `Bearer ${avery}` },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as DevelopmentTokenResponse).developmentToken.token;
  }
  async function addPerson(name: string, ...grants: string[]): Promise<string> {
    const added = await ledger(
      avery,
      'people',
      'add',
      '--name',
      name,
      ...grants,
      '--reason',
      'Safety program roles',
      '--json',
    );
    expect(added.code, added.err).toBe(0);
    return tokenFor(JSON.parse(added.out).principalId);
  }

  beforeAll(async () => {
    app = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      logger: { level: 'info', stream: { write: (line: string) => logged.push(line) } },
    });
    await app.ready();
    const created = await setUpOrganization(
      admin,
      parseOrganizationSetup([
        '--name',
        'Example Ridge Survey',
        '--time-zone',
        'America/Denver',
        '--admin',
        'Avery Example',
        '--id',
        `safety-files-${run}`,
      ]),
      'local',
      [],
    );
    if (!created.created || !created.developmentToken) throw new Error('The organization should be new');
    avery = created.developmentToken;
  });
  afterAll(async () => {
    await settleOwnedWork([tenantId], { objectStore: store });
    await app?.close();
    await pool.end();
    await admin.end();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('drafts the files with a service, then people adopt, assess, accept, sign, issue and close with their own tokens', async () => {
    // The people who decide, added by the administrator: a safety manager who may accept low risk and an accountable
    // executive who may accept high risk and adopt.
    const rowan = await addPerson('Rowan Example', '--preset', 'safety', '--capability', 'risk:accept:low');
    const jordan = await addPerson(
      'Jordan Example',
      '--preset',
      'none',
      ...['decision:write', 'sms:read', 'sms:write', 'sms:adopt', 'risk:accept:high'].flatMap((value) => [
        '--capability',
        value,
      ]),
    );
    // The agent's credential, with the drafting capabilities the administrator adds to the guide's default.
    const service = (
      await setUpCredential(admin, {
        tenantId,
        principal: 'Safety records agent',
        label: 'Coding agent on the office computer',
        add: { kind: 'service', capabilities: ['sms:read', 'sms:write', 'sms:configure'], observationGrants: [] },
      })
    ).credential.secret;

    // What a control of each type needs; the plain control states a measure and is not checked against flights.
    const types = await ok(service, 'safety', 'control-types');
    expect(types).toContain('control.described-measure');
    expect(types).toContain('no, a person reads it');

    // The check says what would open and records nothing.
    const checked = await ok(service, 'safety', 'check', 'hazards', safety('hazards.csv'));
    expect(checked).toContain('Hazard H-001: would open an identified hazard');
    expect(checked).toContain('Control H-001/3: would open a proposed control on hazard H-001');
    expect(checked).toContain('14 in the file: 14 would open, 0 already on file, 0 refused. Nothing was recorded.');
    expect(await byReference(service, 'hazard', 'H-001')).toEqual([]);

    // The service drafts every file but the report.
    const matrixDrafted = await ok(service, 'safety', 'draft', 'matrix', safety('risk-matrix.yaml'));
    expect(matrixDrafted).toContain('Risk matrix ERS-RM-1: opened as');
    expect(matrixDrafted).toContain('a draft risk matrix with 4 levels');
    expect(await ok(service, 'safety', 'draft', 'hazards', safety('hazards.csv'))).toContain(
      '14 in the file: 14 opened, 0 already on file, 0 refused.',
    );
    await ok(service, 'safety', 'draft', 'document', safety('safety-policy.md'));
    await ok(service, 'safety', 'draft', 'assurance', safety('internal-audit.yaml'));
    await ok(service, 'safety', 'draft', 'assurance', safety('management-review.yaml'));

    // A second import opens nothing.
    const again = await ok(service, 'safety', 'draft', 'hazards', safety('hazards.csv'));
    expect(again).toContain('14 in the file: 0 opened, 14 already on file, 0 refused.');
    expect(again).toMatch(/Hazard H-001: on file as \S+\. Nothing opened\./);
    expect(await ok(service, 'safety', 'draft', 'matrix', safety('risk-matrix.yaml'))).toContain(
      '0 opened, 1 already on file',
    );
    expect(await byReference(service, 'hazard', 'H-001')).toHaveLength(1);
    expect(await byReference(service, 'control', 'H-001/1')).toHaveLength(1);
    // A changed file is said to differ, and still opens nothing.
    const changed = join(scratch, 'hazards-changed.csv');
    writeFileSync(
      changed,
      readFileSync(join(example, safety('hazards.csv')), 'utf8').replace(
        'Collision with a crewed',
        'Mid-air collision with a crewed',
      ),
    );
    expect(await ok(service, 'safety', 'draft', 'hazards', changed)).toMatch(
      /Hazard H-001: on file as \S+, and the file differs from the version on file\. Nothing opened/,
    );
    // The API itself refuses a second record of a kind under one reference, whoever sends it.
    const [h1] = await byReference(service, 'hazard', 'H-001');
    const doubled = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${service}`, 'idempotency-key': randomUUID() },
      payload: {
        kind: 'sms.record.open',
        reference: 'H-001',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Another',
          ownerId: h1!.owner.id,
          body: { description: 'x', consequence: 'y', source: { kind: 'manual_identification' } },
        },
      },
    });
    expect(doubled.statusCode, doubled.body).toBe(409);
    expect(doubled.json().error).toMatchObject({ code: 'reference_in_use', details: { recordId: h1!.id } });

    // A service only prints a person's decision.
    const byService = await ledger(service, 'safety', 'adopt', 'matrix', 'ERS-RM-1', '--reason', 'Ours');
    expect(byService.code).toBe(1);
    expect(byService.err).toContain('Not sent. Adopting the matrix is a person');
    // Printed without a reason, it is shown under any credential, and says who sends it.
    const printedByService = await ledger(service, 'safety', 'adopt', 'matrix', 'ERS-RM-1');
    expect(printedByService.code, printedByService.err).toBe(0);
    expect(printedByService.out).toContain(
      'The person who decides runs this again with their own credential and --reason "<their reason>".',
    );

    // The accountable executive adopts the matrix, signing it after the client confirms it is them.
    const shownMatrix = await ok(jordan, 'safety', 'adopt', 'matrix', 'ERS-RM-1');
    expect(shownMatrix).toContain('What you sign: I, Jordan Example, adopt version 1 of “Example Ridge risk matrix”');
    expect(shownMatrix).toContain('Not sent. The person signs by running this again with --reason');
    expect(
      await ok(jordan, 'safety', 'adopt', 'matrix', 'ERS-RM-1', '--reason', 'Our matrix as in the safety manual'),
    ).toContain('Signed, after confirming it is Jordan Example with their own development token.');

    // The safety manager assesses the register on it, with the controls proposed from the mitigations.
    const shownAssessment = await ledger(rowan, 'safety', 'assess', safety('hazards.csv'));
    // H-005 has no assessment on the register yet, so the file is not wholly sent.
    expect(shownAssessment.code).toBe(1);
    const assessedShown = shownAssessment.out;
    expect(assessedShown).toContain(
      'Hazard H-001: would record before Catastrophic × Now and then = Orange, a person who may accept high risk may accept it; with 3 controls, Catastrophic × Not expected = Yellow, a person who may accept medium risk may accept it.',
    );
    expect(assessedShown).toContain('Hazard H-005: not assessed. Give severityBefore and likelihoodBefore.');
    const assessedByService = await ledger(service, 'safety', 'assess', safety('hazards.csv'), '--hazard', 'H-001');
    expect(assessedByService.code, assessedByService.err).toBe(0);
    expect(assessedByService.out).toContain('Hazard H-001: would record before Catastrophic × Now and then = Orange');
    expect(assessedByService.out).toContain("Not sent. Assessing a risk is a person's decision");
    const refusedToService = await ledger(
      service,
      'safety',
      'assess',
      safety('hazards.csv'),
      '--hazard',
      'H-001',
      '--reason',
      'Not a person',
    );
    expect(refusedToService.code).toBe(1);
    expect(refusedToService.err).toContain("Not sent. Assessing a risk is a person's decision");
    const assessed = await ledger(rowan, 'safety', 'assess', safety('hazards.csv'), '--reason', 'As on our register');
    expect(assessed.code).toBe(1);
    expect(assessed.out).toContain('Hazard H-003: assessed, before Minor × Likely = Yellow');
    expect(assessed.out).toContain('Hazard H-004: assessed, before Major × Likely = Red, nobody may accept it');
    const h1Shown = await read<SmsRecordDetailResponse>(rowan, `/v1/sms/records/${h1!.id}`);
    expect(h1Shown.record.residual).toEqual({
      severity: 'catastrophic',
      likelihood: 'not_expected',
      level: 'yellow',
      acceptance: 'medium',
    });
    expect(h1Shown.decisions.find((decision) => decision.kind === 'risk.assess')!.outcome).toMatchObject({
      controls: [{ type: 'Described measure' }, { type: 'Described measure' }, { type: 'Described measure' }],
    });
    // Assessing again with the same file sends nothing twice.
    expect(
      await ledger(rowan, 'safety', 'assess', safety('hazards.csv'), '--hazard', 'H-001', '--reason', 'Again'),
    ).toMatchObject({
      code: 0,
      out: expect.stringMatching(/Hazard H-001: assessed so already/),
    });

    // Each accepts what their authority covers; nobody may accept the band the manual says stops the operation.
    expect(await ok(rowan, 'safety', 'accept', 'H-003', '--reason', 'Stand-off in place')).toContain('Signed');
    const tooHigh = await ledger(rowan, 'safety', 'accept', 'H-001', '--reason', 'Not mine');
    expect(tooHigh.code).toBe(1);
    expect(tooHigh.out).toContain('Not sent. Accepting yellow risk needs authority to accept medium risk.');
    expect(tooHigh.out).toContain('Jordan Example can accept it.');
    expect(
      await ok(jordan, 'safety', 'accept', 'H-001', '--reason', 'Traffic receiver and notices in place'),
    ).toContain('Signed');
    const red = await ledger(jordan, 'safety', 'accept', 'H-004', '--reason', 'Trying anyway');
    expect(red.code).toBe(1);
    expect(red.out).toContain(
      'Not sent. “Example Ridge risk matrix” says Red risk may not be accepted: Stop the affected operation. Reassess it with further controls.',
    );
    const [h4] = await byReference(jordan, 'hazard', 'H-004');
    expect(h4!.status).toBe('awaiting_acceptance');
    expect(h4!.waitingOnMe).toBe(false);

    // The policy: reviewed, adopted with a signature, issued to everyone.
    expect(await ok(rowan, 'safety', 'review', 'ERS-POL-1', '--reason', 'Matches the signed paper copy')).toContain(
      'Recorded.',
    );
    expect(await ok(jordan, 'safety', 'adopt', 'document', 'ERS-POL-1', '--reason', 'Our policy')).toContain('Signed');
    expect(
      await ok(rowan, 'safety', 'issue', 'ERS-POL-1', '--recipient', 'everyone', '--reason', 'The policy in force'),
    ).toContain('Recorded.');

    // The accountable executive signs the audit and the review, which sets their actions; an action's owner closes it.
    expect(await ok(jordan, 'safety', 'sign', 'ERS-IA-2026-1', '--reason', 'The audit as completed')).toContain(
      'Signed',
    );
    expect(await ok(jordan, 'safety', 'sign', 'ERS-MR-2026-2', '--reason', 'The review as held')).toContain('Signed');
    expect(
      await ok(rowan, 'safety', 'close-action', 'ERS-IA-2026-1', 'A1', '--reason', 'Briefed every pilot on 2026-03-10'),
    ).toContain('Recorded.');

    // The home read: what is on file, what waits for a person, and what is overdue.
    const home = await ok(rowan, 'safety', 'home');
    expect(home).toContain('Risk matrix in force: “Example Ridge risk matrix”, version 1 (ERS-RM-1).');
    expect(home).toContain('    Red: nobody may accept it.');
    expect(home).toMatch(
      /In force: Document ERS-POL-1 \(\S+\), “Safety policy”, revision 2, since \d{4}-\d{2}-\d{2}\./,
    );
    expect(home).toContain('May accept low risk (and no higher): Rowan Example.');
    expect(home).toMatch(/Hazards to assess:\n {2}Hazard H-005 \(\S+\), “Loose antenna connectors”, overdue/);
    expect(home).toMatch(
      /Hazard H-004 \(\S+\), “Pilot fatigue in the operations room”: residual Red; nobody may accept it\. A person reassesses it with further controls/,
    );
    expect(home).toMatch(
      /A2 of “Internal audit, February 2026”: Issue the current lost-link procedure and withdraw the old one\. Owner Rowan Example, due 2026-04-30, overdue\./,
    );
    expect(home).not.toContain('A1 of “Internal audit');
    const homeJson = JSON.parse(await ok(rowan, 'safety', 'home', '--json')).home as SmsHomeResponse;
    expect(homeJson.attention.overdue.map((record) => record.reference)).toContain('H-005');
  });

  it('enters a report received before Ledger only with a cleared person’s token, and never prints what it says', async () => {
    const service = (
      await setUpCredential(admin, {
        tenantId,
        principal: 'Report drafting agent',
        label: 'Coding agent',
        add: { kind: 'service', capabilities: ['sms:read', 'sms:write', 'sms:report:read'], observationGrants: [] },
      })
    ).credential.secret;
    const reportFile = safety('safety-report-SR-1.md');
    const refused = await ledger(service, 'safety', 'draft', 'report', reportFile, '--json');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Not opened. A safety report received before Ledger is entered by a person');

    const people = JSON.parse((await ledger(avery, 'people', 'list', '--json')).out).principals as {
      id: string;
      name: string;
    }[];
    const rowan = await tokenFor(people.find((person) => person.name === 'Rowan Example')!.id);
    const outputs = [
      await ledger(rowan, 'safety', 'check', 'report', reportFile),
      await ledger(rowan, 'safety', 'check', 'report', reportFile, '--json'),
      await ledger(rowan, 'safety', 'draft', 'report', reportFile, '--json'),
      await ledger(rowan, 'safety', 'draft', 'report', reportFile),
      await ledger(rowan, 'safety', 'home', '--json'),
    ];
    expect(outputs[2]!.code, outputs[2]!.err).toBe(0);
    expect(JSON.parse(outputs[2]!.out).results).toEqual([
      { reference: 'ERS-SR-1', kind: 'report', outcome: 'opened', recordId: expect.any(String) },
    ]);
    expect(outputs[3]!.out).toContain('Safety report ERS-SR-1: on file as');
    // A front matter the parser cannot read is named by its line, never quoted.
    const broken = join(scratch, 'broken-report.md');
    writeFileSync(broken, `---\nid: ERS-SR-2\nreporterName: [Casey Example\n---\n${narrative}\n`);
    outputs.push(await ledger(rowan, 'safety', 'draft', 'report', broken, '--json'));
    expect(outputs[5]!.code).toBe(1);
    expect(outputs[5]!.err).toContain('The stated values are not valid YAML');
    const [report] = await byReference(rowan, 'report', 'ERS-SR-1');
    expect(report).toMatchObject({ confidentiality: 'safety_report', status: 'received' });
    const said = [...outputs.flatMap(({ out, err }) => [out, err]), ...logged].join('\n');
    expect(said).not.toContain(narrative);
    expect(said).not.toContain('Casey Example');
    expect(said).not.toContain('antenna connector loose');
  });
});
