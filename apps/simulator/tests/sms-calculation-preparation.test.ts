import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandLinkLossesPerFlightHourV1 } from '../../../packages/domain/src/rules/demo-procedures-pack.js';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { advanceOperation, reviseOperationReservation } from '../../../packages/simulation-models/src/operation.js';
import {
  prepareSmsCalculation,
  validateSmsCalculationPreparation,
  type SmsCalculationActual,
} from '../src/sms-calculation-preparation.js';
import { readRetainedSmsCalculation, retainSmsCalculation, retainSmsPreparation } from '../src/sms-rehearsal-files.js';
import { calculationFixture, config } from './sms-rehearsal-fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function resealSource(actual: SmsCalculationActual) {
  const source = actual.canonical.record.source;
  const bytes = Buffer.from(JSON.stringify(source, null, 2) + '\n');
  const { sourceSessionId, occurredAt, ...payload } = source;
  const submission = actual.submission;
  submission.input.sourceSessionId = sourceSessionId;
  submission.input.occurredAt = occurredAt;
  submission.input.payload = structuredClone(payload);
  submission.bytesBase64 = bytes.toString('base64');
  submission.sha256 = sha256(bytes);
  submission.key = `monitoring-window:revision:${canonicalDigest({
    version: 'ledger.monitoring-window-delivery.2',
    tenantId: submission.tenantId,
    sourceId: submission.input.sourceId,
    sourceSessionId,
    sourceWindowId: source.sourceWindowId,
    sourceRevision: source.sourceRevision,
  })}`;
  const { submissionDigest: _submissionDigest, ...content } = submission;
  submission.submissionDigest = canonicalDigest(content);
  actual.accepted.sha256 = submission.sha256;
  actual.accepted.receipt.receipt.occurredAt = occurredAt;
  actual.accepted.receipt.receipt.payload = structuredClone(payload);
  actual.canonical.record.original.sha256 = submission.sha256;
  actual.canonical.record.original.byteLength = bytes.length;
  actual.canonical.digest = canonicalDigest(actual.canonical.record);
}

async function retainedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-calculation-'));
  directories.push(directory);
  const fixture = calculationFixture({ ...config(), directory: join(directory, 'rehearsal') });
  await retainSmsPreparation(fixture.incident);
  await retainSmsPreparation(fixture.followup);
  return { ...fixture, directory };
}

describe('explicit SMS calculation preparation', () => {
  it('pins exact canonical V2 evidence while preserving insufficient observations and rejects changed scope or commitments', () => {
    const fixture = calculationFixture();
    const {
      followup,
      monitoringActual: actual,
      calculationSelectionText,
      calculationPreparedAt,
      calculation,
    } = fixture;
    const before = structuredClone(actual);
    const prepare = (value: SmsCalculationActual) =>
      prepareSmsCalculation(followup, value, calculationSelectionText, calculationPreparedAt);
    expect(prepare(actual)).toEqual(calculation);
    expect(validateSmsCalculationPreparation(JSON.parse(JSON.stringify(calculation)), followup)).toEqual(calculation);
    // The plan opens a window for the monitored control over its reported period and records the loss indicator.
    const declared = actual.canonical.record.source;
    const indicator = commandLinkLossesPerFlightHourV1();
    expect(calculation.plan).toMatchObject({
      version: 2,
      apiUrl: followup.config.apiUrl,
      tenantId: 'tenant-alpha',
      principalId: 'sms-calculation-author-alpha',
      indicator: { id: indicator.id, version: 1, digest: indicator.digest },
      window: {
        control: {
          kind: 'control_record',
          hazardId: declared.control.hazardId,
          recordId: declared.control.controlId,
          versionNumber: declared.control.controlVersion,
          bodyDigest: declared.control.controlDigest,
          acceptanceId: declared.control.acceptance.id,
        },
        period: declared.window,
        subjectKind: 'flight',
        subjects: [{ scope: 'ledger', kind: 'flight', id: declared.flights[0]!.flightId }],
        complete: declared.populationComplete,
        indicators: [{ id: indicator.id, version: 1, digest: indicator.digest }],
      },
    });
    expect(calculation.plan.principalId).not.toBe(actual.submission.principalId);
    expect(actual.canonical.record.authority.principalId).not.toBe(actual.submission.principalId);
    expect(actual.canonical.record.original.artifactId).not.toBe(actual.submission.input.artifactId);
    expect(actual.accepted.submittedUploadArtifactId).toBe(actual.submission.input.artifactId);
    expect(actual.accepted.receipt.receipt.artifactId).toBe(actual.canonical.record.original.artifactId);
    expect(actual.binding).toMatchObject({
      attemptId: followup.identities.attemptId,
      tenantId: 'tenant-alpha',
      sourceSessionId: followup.identities.commandLinkSourceSessionId,
      flight: {
        id: actual.mission.flightId,
        originationKey: followup.identities.attemptId,
        aircraft: followup.identities.aircraftId,
      },
    });
    const source = actual.canonical.record.source;
    expect(JSON.parse(Buffer.from(actual.submission.bytesBase64, 'base64').toString('utf8'))).toEqual(source);
    expect(source).toMatchObject({
      sourceRevision: 1,
      sourceSessionId: followup.identities.monitoringSourceSessionId,
      sourceWindowId: followup.identities.monitoringSourceWindowId,
      control: followup.monitoring.monitoring.control,
      window: followup.monitoring.monitoring.window,
      populationComplete: false,
    });
    expect(source.flights[0]).toMatchObject({
      mission: { sourceRevision: 2, eventId: actual.mission.id, recordDigest: canonicalDigest(actual.mission) },
      c2SourceSessionId: followup.identities.commandLinkSourceSessionId,
      coverageIntervals: null,
      gaps: [{ interval: source.window, kind: 'c2_monitor' }],
      baseline: { digest: canonicalDigest(fixture.monitoringBaselineRecord) },
    });
    expect(fixture.monitoringBaselineSource.state).toBe('unknown');
    expect(Object.hasOwn(calculation, 'evaluation')).toBe(false);
    expect(Object.hasOwn(source, 'reportedLossGroupsPerFlightHour')).toBe(false);
    expect(calculation.selectionText).toBe(calculationSelectionText);
    expect(calculation.selectionSha256).toBe(sha256(calculationSelectionText));
    expect(calculation.planBytes).toBe(JSON.stringify(calculation.plan, null, 2) + '\n');
    expect(calculation.planSha256).toBe(sha256(calculation.planBytes));
    expect(calculation.followupDigest).toBe(canonicalDigest(followup));
    expect(actual).toEqual(before);

    const changedPins = [
      (value: SmsCalculationActual) => {
        value.canonical.record.source.sourceRevision = 2;
      },
      (value: SmsCalculationActual) => {
        value.canonical.record.source.window.end = '2026-10-15T14:29:59.000Z';
      },
      (value: SmsCalculationActual) => {
        value.canonical.record.source.control.controlDigest = '0'.repeat(64);
      },
    ];
    for (const change of changedPins) {
      const changed = structuredClone(actual);
      change(changed);
      resealSource(changed);
      expect(() => prepare(changed)).toThrow();
    }
    const foreign = structuredClone(actual);
    foreign.binding.flight.originationKey = 'another-attempt';
    expect(() => prepare(foreign)).toThrow();
    const changedReceipt = structuredClone(actual);
    changedReceipt.accepted.receipt.receipt.eventId = 'another-canonical-event';
    expect(() => prepare(changedReceipt)).toThrow();
    const changedDigest = structuredClone(actual);
    changedDigest.canonical.digest = '0'.repeat(64);
    expect(() => prepare(changedDigest)).toThrow();
    const changedOriginal = structuredClone(actual);
    changedOriginal.submission.bytesBase64 = Buffer.from('{}\n').toString('base64');
    expect(() => prepare(changedOriginal)).toThrow();
    expect(() =>
      prepareSmsCalculation(
        followup,
        actual,
        '{"version":1,"principalId":"first","principalId":"second"}',
        calculationPreparedAt,
      ),
    ).toThrow();
  });

  it('retains the original evidence, caller and plan across restart without touching inputs or the calculation actor journal', async () => {
    const {
      directory,
      followup,
      monitoringActual,
      calculationSelectionText,
      calculationPreparedAt,
      calculation,
      world,
    } = await retainedFixture();
    const actualPath = join(directory, 'monitoring.json');
    const selectionPath = join(directory, 'selection.json');
    await writeFile(actualPath, JSON.stringify(monitoringActual, null, 2) + '\n', { mode: 0o600 });
    await writeFile(selectionPath, calculationSelectionText, { mode: 0o600 });
    const actualBytes = await readFile(actualPath);
    const selectionBytes = await readFile(selectionPath);
    expect(await readRetainedSmsCalculation(followup)).toBeUndefined();
    expect(await retainSmsCalculation(followup, calculation, [actualPath, selectionPath])).toEqual(calculation);
    const phase = join(followup.config.directory, 'followup');
    const commitmentPath = join(phase, 'calculation.preparation.json');
    const planPath = join(phase, 'calculation.plan.json');
    const environmentPath = join(phase, 'calculation.env');
    const actorPath = join(phase, 'calculation.journal.json');
    const commitment = await readFile(commitmentPath);
    const environment = await readFile(environmentPath);
    await writeFile(actorPath, 'independent calculation actor journal', { mode: 0o600 });
    expect((await stat(commitmentPath)).mode & 0o777).toBe(0o600);
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
    expect(environment.toString()).toContain('unset SIMULATOR_EFFECTIVENESS_TOKEN');
    expect(environment.toString()).not.toMatch(/^export .*TOKEN=/m);
    advanceOperation(world, world.now + 2_000);
    reviseOperationReservation(world, followup.identities.attemptId, {
      sourceRevision: 3,
      operatingInterval: {
        ...followup.missionChange.operatingInterval,
        start: new Date(Date.parse(followup.missionChange.operatingInterval.start) + 60_000).toISOString(),
      },
    });
    await unlink(planPath);
    await unlink(environmentPath);
    expect(await readRetainedSmsCalculation(followup)).toEqual(calculation);
    expect(await retainSmsCalculation(followup, JSON.parse(JSON.stringify(calculation)))).toEqual(calculation);
    expect(await readFile(planPath, 'utf8')).toBe(calculation.planBytes);
    expect(await readFile(environmentPath)).toEqual(environment);
    expect(await readFile(commitmentPath)).toEqual(commitment);
    expect(await readFile(actualPath)).toEqual(actualBytes);
    expect(await readFile(selectionPath)).toEqual(selectionBytes);
    expect(await readFile(actorPath, 'utf8')).toBe('independent calculation actor journal');
    const changedCaller = prepareSmsCalculation(
      followup,
      monitoringActual,
      JSON.stringify({ version: 1, principalId: 'another-calculation-author' }),
      calculationPreparedAt,
    );
    await expect(retainSmsCalculation(followup, changedCaller)).rejects.toThrow(/original|change/i);
    const tampered = structuredClone(calculation);
    tampered.planBytes = JSON.stringify({
      ...calculation.plan,
      monitoring: { id: 'different-record', digest: '0'.repeat(64) },
    });
    tampered.planSha256 = sha256(tampered.planBytes);
    expect(() => validateSmsCalculationPreparation(tampered, followup)).toThrow();
    await writeFile(planPath, tampered.planBytes, { mode: 0o600 });
    const changedBytes = await readFile(planPath);
    await expect(readRetainedSmsCalculation(followup)).rejects.toThrow(/changed/i);
    await expect(retainSmsCalculation(followup, calculation)).rejects.toThrow(/changed/i);
    expect(await readFile(planPath)).toEqual(changedBytes);
    expect(await readFile(commitmentPath)).toEqual(commitment);
  });

  it('refuses aliased world inputs and calculation outputs before creating a calculation commitment', async () => {
    const { directory, followup, calculation } = await retainedFixture();
    const worldBytes = 'test-local retained world';
    await writeFile(followup.worldPath, worldBytes, { mode: 0o600 });
    const alias = join(directory, 'world-as-monitoring.json');
    await link(followup.worldPath, alias);
    await expect(retainSmsCalculation(followup, calculation, [alias])).rejects.toThrow(/alias|separate/i);
    const phase = join(followup.config.directory, 'followup');
    await expect(
      retainSmsCalculation(followup, calculation, [join(phase, 'calculation.journal.json')]),
    ).rejects.toThrow(/alias|separate/i);
    await mkdir(`${followup.worldPath}.history`, { mode: 0o700 });
    const history = join(directory, 'history-alias');
    await symlink(`${followup.worldPath}.history`, history, 'dir');
    await expect(
      retainSmsCalculation(followup, calculation, [join(history, 'future-monitoring.json')]),
    ).rejects.toThrow(/world-owned|alias|separate/i);
    expect(await readFile(followup.worldPath, 'utf8')).toBe(worldBytes);
    expect(await readRetainedSmsCalculation(followup)).toBeUndefined();
  });
});
