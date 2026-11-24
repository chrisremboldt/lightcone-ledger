import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { advanceOperation, reviseOperationReservation } from '../../../packages/simulation-models/src/operation.js';
import {
  prepareSmsDeparture,
  validateSmsDeparturePreparation,
  type SmsDepartureSelection,
} from '../src/sms-departure-preparation.js';
import {
  readRetainedSmsDeparture,
  retainSmsDeparture,
  retainSmsPreparation,
  retainSmsRevision,
} from '../src/sms-rehearsal-files.js';
import { config, departureFixture, resealRelease } from './sms-rehearsal-fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function retainedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-departure-'));
  directories.push(directory);
  const fixture = departureFixture({ ...config(), directory: join(directory, 'rehearsal') });
  await retainSmsPreparation(fixture.incident);
  await retainSmsPreparation(fixture.followup);
  await retainSmsRevision(fixture.followup, fixture.revision);
  return { ...fixture, directory };
}

describe('explicit SMS departure preparation', () => {
  it('pins the actual applied source revision, retained release and an independent departure caller without taking off', () => {
    const fixture = departureFixture();
    const { followup, actual, revision, selection, selectionText, preparedAt, departure, world } = fixture;
    const before = structuredClone(world);
    expect(prepareSmsDeparture(followup, revision, actual, selectionText, preparedAt)).toEqual(departure);
    expect(validateSmsDeparturePreparation(JSON.parse(JSON.stringify(departure)), followup, revision)).toEqual(
      departure,
    );
    expect(departure.plan).toMatchObject({
      apiUrl: followup.config.apiUrl,
      tenantId: 'tenant-alpha',
      principalId: selection.principalId,
      runId: followup.runId,
      reservationId: actual.reservation.id,
      aircraftId: actual.reservation.aircraftId,
      flightId: selection.flight.flight.id,
      departureAttemptId: `${followup.identities.attemptId}:departure:1`,
      release: { id: selection.release.release.id, digest: canonicalDigest(selection.release.release) },
      mission: {
        sourceRevision: 2,
        eventId: selection.mission.mission.id,
        recordDigest: canonicalDigest(selection.mission.mission),
      },
    });
    expect(departure.plan.principalId).not.toBe(selection.release.release.actor.id);
    expect(departure.plan.principalId).not.toBe(followup.config.sourcePrincipalId);
    expect(departure.plan.flightId).not.toBe(followup.selection.origin.flight.id);
    expect(departure.followupDigest).toBe(canonicalDigest(followup));
    expect(departure.revisionDigest).toBe(canonicalDigest(revision));
    expect(departure.selectionText).toBe(selectionText);
    expect(departure.selectionSha256).toBe(sha256(selectionText));
    expect(departure.planBytes).toBe(JSON.stringify(departure.plan, null, 2) + '\n');
    expect(departure.planSha256).toBe(sha256(departure.planBytes));
    const sourceBytes = Buffer.from(JSON.stringify(actual.reservation.plan), 'utf8');
    const { sourceRevision, occurredAt, ...payload } = actual.reservation.plan;
    expect(selection.mission.mission.original).toEqual({
      sha256: sha256(sourceBytes),
      byteLength: sourceBytes.byteLength,
    });
    expect(selection.mission.mission.contentDigest).toBe(
      canonicalDigest({
        version: 'ledger.mission-content.1',
        sourceId: 'mission-planner',
        flightId: selection.flight.flight.id,
        sourceRevision,
        occurredAt,
        fidelity: 'synthetic_contract',
        payload,
        original: {
          bytesBase64: sourceBytes.toString('base64'),
          sha256: sha256(sourceBytes),
          byteLength: sourceBytes.byteLength,
        },
      }),
    );
    expect(world).toEqual(before);
    expect(world.departureAllocations).toBeUndefined();
    expect(world.departures).toBeUndefined();
    expect(world.attempts.some((row) => row.id === followup.identities.attemptId)).toBe(false);
    departure.actual.reservation.plan.route.geometry.coordinates[0]![0] = 0;
    expect(actual.reservation.plan.route).toEqual(followup.missionChange.route);
  });

  it('refuses conflicting public identities, changed accepted control context, source originals and unproven revision clocks', () => {
    const { followup, revision, actual, selection, preparedAt } = departureFixture();
    const prepare = (selected: SmsDepartureSelection, retained = actual, at = preparedAt) =>
      prepareSmsDeparture(followup, revision, retained, JSON.stringify(selected), at);
    const foreign = structuredClone(selection);
    foreign.flight.flight.originationKey = 'another-held-reservation';
    expect(() => prepare(foreign)).toThrow();
    const changedControl = structuredClone(selection);
    changedControl.release.release.basis.avoidance.candidates[0]!.controlDigest = '0'.repeat(64);
    resealRelease(changedControl.release);
    expect(() => prepare(changedControl)).toThrow();
    const changedSource = structuredClone(selection);
    changedSource.mission.mission.original.sha256 = sha256(JSON.stringify(actual.reservation.plan, null, 2));
    changedSource.release.release.basis.mission = structuredClone(changedSource.mission.mission);
    changedSource.release.release.basis.avoidance.mission.recordDigest = canonicalDigest(changedSource.mission.mission);
    resealRelease(changedSource.release);
    expect(() => prepare(changedSource)).toThrow();
    const unproven = structuredClone(actual);
    unproven.revisionReceipt.sourceDigest = '0'.repeat(64);
    expect(() => prepare(selection, unproven)).toThrow();
    expect(() => prepare(selection, actual, '2026-10-15T14:20:03.000Z')).toThrow();
    expect(() =>
      prepareSmsDeparture(
        followup,
        revision,
        actual,
        JSON.stringify({ ...selection, token: 'must-not-be-retained' }),
        preparedAt,
      ),
    ).toThrow();
  });

  it('recovers the original private inputs and plan bytes after world changes, and refuses substitution or raw plan tampering', async () => {
    const { directory, followup, revision, actual, selection, preparedAt, departure, world } = await retainedFixture();
    const inputPath = join(directory, 'selection.json');
    await writeFile(inputPath, departure.selectionText, { mode: 0o600 });
    expect(await readRetainedSmsDeparture(followup)).toBeUndefined();
    expect(await retainSmsDeparture(followup, departure, [inputPath])).toEqual(departure);
    const phase = join(followup.config.directory, 'followup');
    const preparationPath = join(phase, 'departure.preparation.json');
    const planPath = join(phase, 'departure.plan.json');
    const environmentPath = join(phase, 'departure.env');
    const commitment = await readFile(preparationPath);
    const environment = await readFile(environmentPath);
    expect((await stat(preparationPath)).mode & 0o777).toBe(0o600);
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
    expect(environment.toString()).toContain('unset SIMULATOR_WORLD_DEPARTURE_TOKEN');
    expect(environment.toString()).not.toMatch(/^export .*TOKEN=/m);
    const consumerJournalPath = join(phase, 'departure.journal.json');
    await writeFile(consumerJournalPath, 'independent consumer journal', { mode: 0o600 });
    advanceOperation(world, world.now + 2_000);
    reviseOperationReservation(world, actual.reservation.id, {
      sourceRevision: 3,
      operatingInterval: {
        ...followup.missionChange.operatingInterval,
        start: new Date(Date.parse(followup.missionChange.operatingInterval.start) + 60_000).toISOString(),
      },
    });
    await unlink(planPath);
    await unlink(environmentPath);
    expect(await readRetainedSmsDeparture(followup)).toEqual(departure);
    expect(await retainSmsDeparture(followup, JSON.parse(JSON.stringify(departure)), [inputPath])).toEqual(departure);
    expect(await readFile(planPath, 'utf8')).toBe(departure.planBytes);
    expect(await readFile(environmentPath)).toEqual(environment);
    expect(await readFile(preparationPath)).toEqual(commitment);
    expect(await readFile(consumerJournalPath, 'utf8')).toBe('independent consumer journal');

    const reserialized = prepareSmsDeparture(followup, revision, actual, JSON.stringify(selection), preparedAt);
    await expect(retainSmsDeparture(followup, reserialized, [inputPath])).rejects.toThrow(/original|change/i);
    const altered = structuredClone(departure);
    altered.planBytes = JSON.stringify({ ...departure.plan, principalId: 'substituted-caller' });
    altered.planSha256 = sha256(altered.planBytes);
    expect(() => validateSmsDeparturePreparation(altered, followup, revision)).toThrow();
    await writeFile(planPath, altered.planBytes, { mode: 0o600 });
    const changedBytes = await readFile(planPath);
    await expect(readRetainedSmsDeparture(followup)).rejects.toThrow(/changed/i);
    await expect(retainSmsDeparture(followup, departure)).rejects.toThrow(/changed/i);
    expect(await readFile(planPath)).toEqual(changedBytes);
    expect(await readFile(preparationPath)).toEqual(commitment);
  });

  it('keeps selection inputs separate from world-owned trees and every departure output', async () => {
    const { directory, followup, departure } = await retainedFixture();
    const phase = join(followup.config.directory, 'followup');
    const worldBytes = 'test-local retained world';
    await writeFile(followup.worldPath, worldBytes, { mode: 0o600 });
    const alias = join(directory, 'world-selection.json');
    await link(followup.worldPath, alias);
    await expect(retainSmsDeparture(followup, departure, [alias])).rejects.toThrow(/alias|separate/i);
    await expect(retainSmsDeparture(followup, departure, [join(phase, 'departure.plan.json')])).rejects.toThrow(
      /alias|separate/i,
    );
    const futureTree = join(directory, 'future-history');
    await mkdir(`${followup.worldPath}.history`, { mode: 0o700 });
    await symlink(`${followup.worldPath}.history`, futureTree, 'dir');
    await expect(retainSmsDeparture(followup, departure, [join(futureTree, 'future-selection.json')])).rejects.toThrow(
      /world-owned|alias|separate/i,
    );
    expect(await readFile(followup.worldPath, 'utf8')).toBe(worldBytes);
    expect(await readRetainedSmsDeparture(followup)).toBeUndefined();
  });
});
