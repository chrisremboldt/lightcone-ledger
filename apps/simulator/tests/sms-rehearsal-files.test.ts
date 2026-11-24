import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRetainedSmsPreparation, retainSmsPreparation } from '../src/sms-rehearsal-files.js';
import { prepareSmsIncident, type SmsRehearsalConfig } from '../src/sms-rehearsal-plan.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function config(directory: string): SmsRehearsalConfig {
  return {
    version: 1,
    rehearsalId: 'sms-unit',
    directory,
    apiUrl: 'http://127.0.0.1:14300',
    emulatorUrl: 'http://127.0.0.1:14302',
    ports: { mqtt: 14383, callback: 14303 },
    seed: 71031,
    fleet: { alpha: 1, beta: 1 },
    sourcePrincipalId: 'sms-source-alpha',
    monitoringSourceId: 'sms-monitoring',
    followup: {
      radioInitialState: 'up',
      monitoringAvailable: true,
      departureOffsetMs: 60000,
      windowStartOffsetMs: 120000,
      windowEndOffsetMs: 600000,
      missionEndOffsetMs: 900000,
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-87.63, 41.88],
            [-87.63, 41.9],
            [-87.64655, 41.88665],
            [-87.65, 41.9],
            [-87.63, 41.88],
          ],
        },
      },
    },
  };
}

describe('private SMS preparation retention', () => {
  it('recovers missing derived settings while preserving clocks, ownership and separate world/input files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-preparation-'));
    directories.push(directory);
    const selected = config(join(directory, "preparation's"));
    const inputPath = join(directory, 'config.json');
    await writeFile(inputPath, JSON.stringify(selected), { mode: 0o600 });
    const start = '2026-10-15T14:00:00.000Z';
    const preparedAt = '2026-10-15T14:00:01.000Z';
    const preparation = prepareSmsIncident(selected, start, preparedAt);
    expect(await readRetainedSmsPreparation(selected, 'incident')).toBeUndefined();
    expect(await retainSmsPreparation(preparation, [inputPath])).toEqual(preparation);
    const phase = dirname(preparation.worldPath);
    const preparedPath = join(phase, 'preparation.json');
    const environmentPath = join(phase, 'world.env');
    const retained = await readFile(preparedPath);
    const environment = await readFile(environmentPath, 'utf8');
    expect(await readRetainedSmsPreparation(selected, 'incident')).toEqual(preparation);
    expect((await stat(selected.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(preparedPath)).mode & 0o777).toBe(0o600);
    expect(environment).toContain("'\\''");
    expect(environment).toContain('SIMULATOR_WORLD_[A-Z0-9_]*');
    expect(environment).not.toMatch(/^export .*TOKEN|^export SIMULATOR_WORLD_MODE=/m);

    await rm(environmentPath);
    await writeFile(preparation.worldPath, 'owned live checkpoint stays untouched', { mode: 0o600 });
    await retainSmsPreparation(preparation, [inputPath]);
    expect(await readFile(environmentPath, 'utf8')).toBe(environment);
    expect(await readFile(preparedPath)).toEqual(retained);
    expect(await readFile(preparation.worldPath, 'utf8')).toBe('owned live checkpoint stays untouched');

    await writeFile(environmentPath, 'changed settings', { mode: 0o600 });
    await expect(retainSmsPreparation(preparation, [inputPath])).rejects.toThrow('refusing to overwrite');
    expect(await readFile(environmentPath, 'utf8')).toBe('changed settings');
    await writeFile(environmentPath, environment, { mode: 0o600 });
    await expect(
      retainSmsPreparation(prepareSmsIncident(selected, '2026-10-15T14:00:01.000Z', preparedAt), [inputPath]),
    ).rejects.toThrow('changed');
    await expect(
      readRetainedSmsPreparation({ ...selected, monitoringSourceId: 'changed-source' }, 'incident'),
    ).rejects.toThrow('configuration');

    const alias = join(directory, 'aliased-config.json');
    await link(preparation.worldPath, alias);
    await expect(retainSmsPreparation(preparation, [alias])).rejects.toThrow(/alias|separate/);
    await expect(
      retainSmsPreparation(preparation, [join(selected.directory, 'followup', 'world.json.broker', 'input.json')]),
    ).rejects.toThrow('world-owned');
    expect(await readFile(preparedPath)).toEqual(retained);
    expect(await readFile(preparation.worldPath, 'utf8')).toBe('owned live checkpoint stays untouched');

    const unowned = join(directory, 'unowned');
    await mkdir(unowned, { mode: 0o700 });
    const foreign = join(unowned, 'existing.json');
    await writeFile(foreign, 'existing private data', { mode: 0o600 });
    await expect(retainSmsPreparation(prepareSmsIncident(config(unowned), start, preparedAt))).rejects.toThrow(
      'nonempty',
    );
    expect(await readFile(foreign, 'utf8')).toBe('existing private data');
  });
});
