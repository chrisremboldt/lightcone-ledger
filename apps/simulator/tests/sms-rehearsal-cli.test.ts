import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runSmsRehearsalCli } from '../src/sms-rehearsal-cli.js';
import { retainSmsCalculation, retainSmsPreparation, retainSmsRevision } from '../src/sms-rehearsal-files.js';
import * as operationState from '../src/operation-state.js';
import * as calculationJournal from '../src/control-effectiveness-plan.js';
import { calculationFixture, config, configV2, departureFixture, reviewFixture } from './sms-rehearsal-fixtures.js';

test('the local command retains the explicit incident clock without starting a world or choosing a control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-cli-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preparation must stay local'));
  try {
    const configPath = join(directory, 'config.json');
    const output = join(directory, 'retained');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        rehearsalId: 'sms-cli-1',
        directory: output,
        apiUrl: 'http://127.0.0.1:14200',
        emulatorUrl: 'http://127.0.0.1:14202',
        ports: { mqtt: 14283, callback: 14203 },
        seed: 71031,
        fleet: { alpha: 1, beta: 1 },
        sourcePrincipalId: 'principal-alpha-source',
        monitoringSourceId: 'operation-monitoring',
        followup: {
          radioInitialState: 'up',
          monitoringAvailable: true,
          departureOffsetMs: 480000,
          windowStartOffsetMs: 600000,
          windowEndOffsetMs: 900000,
          missionEndOffsetMs: 1800000,
          route: {
            coordinateReference: 'WGS84',
            coordinateOrder: 'longitude_latitude',
            segmentInterpolation: 'linear_longitude_latitude',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-87.63, 41.88],
                [-87.63, 41.89],
                [-87.63, 41.88],
              ],
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const start = '2026-10-16T14:00:00.000Z';
    const env = { SIMULATOR_SMS_CONFIG: configPath, SIMULATOR_SMS_PHASE: 'incident', SIMULATOR_SMS_START: start };
    const first = await runSmsRehearsalCli(env, () => Date.parse(start) + 1000);
    expect(first.status).toBe('prepared');
    const retained = await readFile(join(output, 'incident', 'preparation.json'), 'utf8');
    expect(await runSmsRehearsalCli(env, () => Date.parse(start) + 3600000)).toEqual(first);
    expect(await readFile(join(output, 'incident', 'preparation.json'), 'utf8')).toBe(retained);
    expect((await runSmsRehearsalCli({ ...env, SIMULATOR_SMS_START: '2026-10-16T14:00:01.000Z' })).status).toBe(
      'pending',
    );
    expect((await runSmsRehearsalCli({ ...env, SIMULATOR_SMS_PHASE: 'followup' })).status).toBe('pending');
    await expect(stat(join(output, 'incident', 'world.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(output, 'followup'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    log.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([config, configV2])(
  'departure preparation reads the actual held snapshot once and recovers its exact plan without execution (%#)',
  async (configuration) => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-departure-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preparation must stay local'));
    const readWorld = vi.spyOn(operationState, 'readOperationCheckpoint');
    try {
      const fixture = departureFixture({ ...configuration(), directory: join(directory, 'retained') });
      const { followup } = fixture;
      const configPath = join(directory, 'config.json');
      const selectionPath = join(directory, 'departure-selection.json');
      await writeFile(configPath, JSON.stringify(fixture.configuration), { mode: 0o600 });
      await writeFile(selectionPath, fixture.selectionText, { mode: 0o600 });
      await retainSmsPreparation(fixture.incident, [configPath]);
      await retainSmsPreparation(followup, [configPath]);
      await retainSmsRevision(followup, fixture.revision, [configPath]);
      const checkpoint = operationState.initialOperationCheckpoint(fixture.world, {
        mode: 'live',
        wallAt: fixture.world.now,
        paused: false,
      });
      checkpoint.reservationRevision = fixture.actual.revisionReceipt;
      checkpoint.monitoring = fixture.monitoring;
      readWorld.mockResolvedValue(checkpoint);
      const originalWorld = structuredClone(checkpoint);
      const oldPaths = ['preparation.json', 'revision.preparation.json', 'revision.plan.json', 'world.env'];
      const phaseDirectory = join(fixture.configuration.directory, 'followup');
      const oldBytes = await Promise.all(oldPaths.map((name) => readFile(join(phaseDirectory, name))));
      const env = {
        SIMULATOR_SMS_CONFIG: configPath,
        SIMULATOR_SMS_PHASE: 'departure',
        SIMULATOR_SMS_DEPARTURE_SELECTION: selectionPath,
      };
      if (followup.version === 2) {
        const alteredCapacity = structuredClone(checkpoint);
        alteredCapacity.world.config.capacity!.demandIntervalMs.alpha = 9000;
        readWorld.mockResolvedValue(alteredCapacity);
        expect(await runSmsRehearsalCli(env)).toMatchObject({
          status: 'pending',
          reason: expect.stringContaining('world profile'),
        });
        const alteredResources = structuredClone(checkpoint);
        alteredResources.world.resources!.chargers[0]!.id = 'another-charger';
        readWorld.mockResolvedValue(alteredResources);
        expect(await runSmsRehearsalCli(env)).toMatchObject({
          status: 'pending',
          reason: expect.stringContaining('resource identities'),
        });
        await expect(stat(join(phaseDirectory, 'departure.preparation.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        readWorld.mockClear();
        readWorld.mockResolvedValue(checkpoint);
      }
      const first = await runSmsRehearsalCli(env, () => Date.parse(fixture.preparedAt));
      expect(first).toMatchObject({ status: 'prepared', phase: 'departure', runId: followup.runId });
      expect(readWorld).toHaveBeenCalledExactlyOnceWith(followup.worldPath);
      expect(checkpoint).toEqual(originalWorld);
      const planPath = join(phaseDirectory, 'departure.plan.json');
      const commitmentPath = join(phaseDirectory, 'departure.preparation.json');
      expect(await readFile(planPath, 'utf8')).toBe(fixture.departure.planBytes);
      const commitment = await readFile(commitmentPath);
      await unlink(planPath);
      await unlink(join(phaseDirectory, 'departure.env'));
      readWorld.mockRejectedValue(new Error('A retry must use the original retained snapshot'));
      expect(
        await runSmsRehearsalCli(env, () => {
          throw new Error('Retain the original preparation clock');
        }),
      ).toEqual(first);
      expect(readWorld).toHaveBeenCalledTimes(1);
      expect(await readFile(planPath, 'utf8')).toBe(fixture.departure.planBytes);
      expect(await readFile(commitmentPath)).toEqual(commitment);
      await writeFile(selectionPath, fixture.selectionText + '\n', { mode: 0o600 });
      expect((await runSmsRehearsalCli(env)).status).toBe('pending');
      expect(await readFile(commitmentPath)).toEqual(commitment);
      expect(await Promise.all(oldPaths.map((name) => readFile(join(phaseDirectory, name))))).toEqual(oldBytes);
      await expect(stat(followup.worldPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(phaseDirectory, 'departure.journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(network).not.toHaveBeenCalled();
    } finally {
      readWorld.mockRestore();
      network.mockRestore();
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([config, configV2])(
  'calculation retry retains the original monitoring record without reading a world or invoking the actor (%#)',
  async (configuration) => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-calculation-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preparation must stay local'));
    const readWorld = vi.spyOn(operationState, 'readOperationCheckpoint').mockResolvedValue(undefined);
    try {
      const fixture = calculationFixture({ ...configuration(), directory: join(directory, 'retained') });
      const { followup } = fixture;
      const configPath = join(directory, 'config.json');
      const selectionPath = join(directory, 'calculation-selection.json');
      await writeFile(configPath, JSON.stringify(fixture.configuration), { mode: 0o600 });
      await writeFile(selectionPath, fixture.calculationSelectionText, { mode: 0o600 });
      await retainSmsPreparation(fixture.incident, [configPath]);
      await retainSmsPreparation(followup, [configPath]);
      const env = {
        SIMULATOR_SMS_CONFIG: configPath,
        SIMULATOR_SMS_PHASE: 'calculation',
        SIMULATOR_SMS_CALCULATION_SELECTION: selectionPath,
      };
      expect((await runSmsRehearsalCli(env)).status).toBe('pending');
      expect(readWorld).toHaveBeenCalledExactlyOnceWith(followup.worldPath);
      const phase = join(fixture.configuration.directory, 'followup');
      const commitmentPath = join(phase, 'calculation.preparation.json');
      await expect(stat(commitmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await retainSmsCalculation(followup, fixture.calculation, [configPath, selectionPath]);
      const commitment = await readFile(commitmentPath);
      await unlink(join(phase, 'calculation.plan.json'));
      await unlink(join(phase, 'calculation.env'));
      readWorld.mockClear();
      readWorld.mockRejectedValue(new Error('A retry must keep its first monitoring snapshot'));
      const retainedClock = () => {
        throw new Error('A retry must keep its first preparation clock');
      };
      expect(await runSmsRehearsalCli(env, retainedClock)).toMatchObject({ status: 'prepared', phase: 'calculation' });
      expect(readWorld).not.toHaveBeenCalled();
      expect(await readFile(join(phase, 'calculation.plan.json'), 'utf8')).toBe(fixture.calculation.planBytes);
      expect(await readFile(commitmentPath)).toEqual(commitment);
      await writeFile(selectionPath, fixture.calculationSelectionText + '\n', { mode: 0o600 });
      expect((await runSmsRehearsalCli(env, retainedClock)).status).toBe('pending');
      expect(await readFile(commitmentPath)).toEqual(commitment);
      await expect(stat(join(phase, 'calculation.journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(followup.worldPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(network).not.toHaveBeenCalled();
    } finally {
      readWorld.mockRestore();
      network.mockRestore();
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([config, configV2])(
  'review preparation pins the accepted calculation once and recovers explicit human choices without execution (%#)',
  async (configuration) => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-review-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preparation must stay local'));
    const readWorld = vi.spyOn(operationState, 'readOperationCheckpoint').mockRejectedValue(new Error('No world read'));
    const readCalculation = vi.spyOn(calculationJournal, 'readControlEffectivenessJournal');
    try {
      const fixture = reviewFixture({ ...configuration(), directory: join(directory, 'retained') });
      const { followup } = fixture;
      const configPath = join(directory, 'config.json');
      const selectionPath = join(directory, 'review-selection.json');
      await writeFile(configPath, JSON.stringify(fixture.configuration), { mode: 0o600 });
      await writeFile(selectionPath, fixture.reviewSelectionText, { mode: 0o600 });
      await retainSmsPreparation(fixture.incident, [configPath]);
      await retainSmsPreparation(followup, [configPath]);
      await retainSmsCalculation(followup, fixture.calculation, [configPath]);
      const phase = join(fixture.configuration.directory, 'followup');
      const journalPath = join(phase, 'calculation.journal.json');
      const commitmentPath = join(phase, 'review.preparation.json');
      const planPath = join(phase, 'review.plan.json');
      const settingsPath = join(phase, 'review.env');
      const env = {
        SIMULATOR_SMS_CONFIG: configPath,
        SIMULATOR_SMS_PHASE: 'review',
        SIMULATOR_SMS_REVIEW_SELECTION: selectionPath,
      };
      expect((await runSmsRehearsalCli(env)).status).toBe('pending');
      await expect(stat(commitmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(planPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await calculationJournal.saveControlEffectivenessJournal(journalPath, fixture.calculationJournal);
      const journalBytes = await readFile(journalPath);
      await writeFile(selectionPath, '\uFEFF' + fixture.reviewSelectionText, { mode: 0o600 });
      expect((await runSmsRehearsalCli(env)).status).toBe('pending');
      await expect(stat(commitmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(selectionPath, fixture.reviewSelectionText, { mode: 0o600 });
      const first = await runSmsRehearsalCli(env, () => Date.parse(fixture.reviewPreparedAt));
      expect(first).toMatchObject({ status: 'prepared', phase: 'review', runId: followup.runId });
      expect(readCalculation).toHaveBeenCalledTimes(3);
      expect(readCalculation).toHaveBeenLastCalledWith(journalPath);
      expect(await readFile(journalPath)).toEqual(journalBytes);
      const commitment = await readFile(commitmentPath);
      expect(await readFile(planPath, 'utf8')).toBe(fixture.review.planBytes);
      const settings = await readFile(settingsPath);
      await unlink(planPath);
      await unlink(settingsPath);
      await unlink(journalPath);
      readCalculation.mockRejectedValue(new Error('Retry must preserve the accepted calculation snapshot'));
      const retainedClock = () => {
        throw new Error('Retry must preserve the preparation clock');
      };
      expect(await runSmsRehearsalCli(env, retainedClock)).toEqual(first);
      expect(readCalculation).toHaveBeenCalledTimes(3);
      expect(await readFile(commitmentPath)).toEqual(commitment);
      expect(await readFile(planPath, 'utf8')).toBe(fixture.review.planBytes);
      expect(await readFile(settingsPath)).toEqual(settings);
      await writeFile(selectionPath, '\uFEFF' + fixture.reviewSelectionText, { mode: 0o600 });
      expect((await runSmsRehearsalCli(env, retainedClock)).status).toBe('pending');
      await writeFile(selectionPath, fixture.reviewSelectionText + '\n', { mode: 0o600 });
      expect((await runSmsRehearsalCli(env, retainedClock)).status).toBe('pending');
      expect(await readFile(commitmentPath)).toEqual(commitment);
      await expect(stat(join(phase, 'review.journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(followup.worldPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(readWorld).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      readCalculation.mockRestore();
      readWorld.mockRestore();
      network.mockRestore();
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
