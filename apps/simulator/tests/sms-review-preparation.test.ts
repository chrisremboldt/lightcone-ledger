import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  saveControlEffectivenessJournal,
  type ControlEffectivenessJournal,
  type RecordedIndicatorResult,
} from '../src/control-effectiveness-plan.js';
import {
  readRetainedSmsReview,
  retainSmsCalculation,
  retainSmsPreparation,
  retainSmsReview,
} from '../src/sms-rehearsal-files.js';
import { prepareSmsReview, validateSmsReviewPreparation } from '../src/sms-review-preparation.js';
import { config, reviewFixture } from './sms-rehearsal-fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function retainedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-sms-review-'));
  directories.push(directory);
  const fixture = reviewFixture({ ...config(), directory: join(directory, 'rehearsal') });
  await retainSmsPreparation(fixture.incident);
  await retainSmsPreparation(fixture.followup);
  await retainSmsCalculation(fixture.followup, fixture.calculation);
  return { ...fixture, directory };
}

describe('explicit SMS human review preparation', () => {
  it('pins the full actual calculation and explicit human choice while preserving insufficient evidence', () => {
    const fixture = reviewFixture();
    const {
      followup,
      calculation,
      calculationJournal,
      calculationAccepted,
      reviewSelectionText,
      reviewPreparedAt,
      review,
    } = fixture;
    const before = structuredClone(calculationJournal);
    const prepare = (actual: ControlEffectivenessJournal) =>
      prepareSmsReview(followup, calculation, actual, reviewSelectionText, reviewPreparedAt);
    expect(prepare(calculationJournal)).toEqual(review);
    expect(validateSmsReviewPreparation(JSON.parse(JSON.stringify(review)), followup, calculation)).toEqual(review);
    expect(review.plan).toEqual({
      version: 2,
      apiUrl: followup.config.apiUrl,
      tenantId: 'tenant-alpha',
      principalId: 'sms-human-reviewer-alpha',
      result: { id: calculationAccepted.record.id, digest: canonicalDigest(calculationAccepted.record) },
      conclusion: 'inconclusive',
      note: JSON.parse(reviewSelectionText).note,
    });
    expect(review.plan.principalId).not.toBe(calculationAccepted.record.actorId);
    // The recorded result states no rate; the review keeps that uncertainty.
    expect(calculationAccepted.record.result).toMatchObject({ status: 'insufficient', rate: null });
    expect(review.actual).toEqual(calculationJournal);
    expect(review.selectionText).toBe(reviewSelectionText);
    expect(review.selectionSha256).toBe(sha256(reviewSelectionText));
    expect(review.planBytes).toBe(JSON.stringify(review.plan, null, 2) + '\n');
    expect(review.planSha256).toBe(sha256(review.planBytes));
    expect(review.followupDigest).toBe(canonicalDigest(followup));
    expect(review.calculationPreparationDigest).toBe(canonicalDigest(calculation));
    expect(calculationJournal).toEqual(before);

    const authored = JSON.stringify({ ...JSON.parse(reviewSelectionText), conclusion: 'effective' });
    expect(prepareSmsReview(followup, calculation, calculationJournal, authored, reviewPreparedAt)).toMatchObject({
      selectionText: authored,
      plan: { conclusion: 'effective' },
      actual: calculationJournal,
    });
    const { conclusion: _conclusion, ...withoutChoice } = JSON.parse(reviewSelectionText);
    expect(() =>
      prepareSmsReview(followup, calculation, calculationJournal, JSON.stringify(withoutChoice), reviewPreparedAt),
    ).toThrow();
    expect(() =>
      prepareSmsReview(
        followup,
        calculation,
        calculationJournal,
        reviewSelectionText.replace('"version": 1,', '"version": 1, "version": 1,'),
        reviewPreparedAt,
      ),
    ).toThrow();
    expect(() =>
      prepareSmsReview(
        followup,
        calculation,
        calculationJournal,
        ' '.repeat(32 * 1024) + reviewSelectionText,
        reviewPreparedAt,
      ),
    ).toThrow();

    const result = (journal: ControlEffectivenessJournal) => journal.actions[1]!.accepted as RecordedIndicatorResult;
    const submitted = structuredClone(calculationJournal);
    submitted.actions[1]!.status = 'submitted';
    delete submitted.actions[1]!.accepted;
    expect(() => prepare(submitted)).toThrow();
    const rejected = structuredClone(submitted);
    rejected.actions[1]!.status = 'rejected';
    rejected.actions[1]!.rejection = { status: 409, code: 'stale_basis' };
    expect(() => prepare(rejected)).toThrow();
    const changedDigest = structuredClone(calculationJournal);
    result(changedDigest).digest = '0'.repeat(64);
    expect(() => prepare(changedDigest)).toThrow();
    const changedPlan = structuredClone(calculationJournal);
    changedPlan.planDigest = '0'.repeat(64);
    expect(() => prepare(changedPlan)).toThrow();
    const changedAuthor = structuredClone(calculationJournal);
    result(changedAuthor).record.actorId = 'another-calculation-author';
    result(changedAuthor).digest = canonicalDigest(result(changedAuthor).record);
    expect(() => prepare(changedAuthor)).toThrow();
    const changedWindow = structuredClone(calculationJournal);
    result(changedWindow).record.request.window = {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    };
    result(changedWindow).digest = canonicalDigest(result(changedWindow).record);
    expect(() => prepare(changedWindow)).toThrow();
  });

  it('restores its original review files and refuses substitutions without writing either actor journal', async () => {
    const { directory, followup, calculation, calculationJournal, reviewSelectionText, reviewPreparedAt, review } =
      await retainedFixture();
    const phase = join(followup.config.directory, 'followup');
    const calculationPath = join(phase, 'calculation.journal.json');
    const selectionPath = join(directory, 'review-selection.json');
    await saveControlEffectivenessJournal(calculationPath, calculationJournal);
    await writeFile(selectionPath, reviewSelectionText, { mode: 0o600 });
    const calculationBytes = await readFile(calculationPath);
    const selectionBytes = await readFile(selectionPath);
    expect(await readRetainedSmsReview(followup)).toBeUndefined();
    expect(await retainSmsReview(followup, review, [selectionPath])).toEqual(review);
    const commitmentPath = join(phase, 'review.preparation.json');
    const planPath = join(phase, 'review.plan.json');
    const environmentPath = join(phase, 'review.env');
    const actorPath = join(phase, 'review.journal.json');
    const commitment = await readFile(commitmentPath);
    const environment = await readFile(environmentPath);
    expect((await stat(commitmentPath)).mode & 0o777).toBe(0o600);
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
    expect(environment.toString()).toContain('unset SIMULATOR_EFFECTIVENESS_REVIEW_TOKEN');
    expect(environment.toString()).not.toMatch(/^export .*TOKEN=/m);
    await expect(stat(actorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(actorPath, 'independent human review actor journal', { mode: 0o600 });
    await unlink(planPath);
    await unlink(environmentPath);
    expect(await readRetainedSmsReview(followup)).toEqual(review);
    expect(await retainSmsReview(followup, JSON.parse(JSON.stringify(review)))).toEqual(review);
    expect(await readFile(planPath, 'utf8')).toBe(review.planBytes);
    expect(await readFile(environmentPath)).toEqual(environment);
    expect(await readFile(commitmentPath)).toEqual(commitment);
    expect(await readFile(calculationPath)).toEqual(calculationBytes);
    expect(await readFile(selectionPath)).toEqual(selectionBytes);
    expect(await readFile(actorPath, 'utf8')).toBe('independent human review actor journal');
    await writeFile(planPath, '\uFEFF' + review.planBytes, { mode: 0o600 });
    await expect(readRetainedSmsReview(followup)).rejects.toThrow(/changed/i);
    await expect(retainSmsReview(followup, review)).rejects.toThrow(/changed/i);
    await writeFile(planPath, review.planBytes, { mode: 0o600 });
    await writeFile(environmentPath, Buffer.concat([Buffer.from('\uFEFF'), environment]), { mode: 0o600 });
    await expect(readRetainedSmsReview(followup)).rejects.toThrow(/changed/i);
    await writeFile(environmentPath, environment, { mode: 0o600 });
    const changedHuman = prepareSmsReview(
      followup,
      calculation,
      calculationJournal,
      JSON.stringify({ ...JSON.parse(reviewSelectionText), principalId: 'another-human-reviewer' }),
      reviewPreparedAt,
    );
    await expect(retainSmsReview(followup, changedHuman)).rejects.toThrow(/original|change/i);
    const tampered = structuredClone(review);
    tampered.planBytes = JSON.stringify({
      ...review.plan,
      calculation: { id: 'another-wrapper', digest: '0'.repeat(64) },
    });
    tampered.planSha256 = sha256(tampered.planBytes);
    expect(() => validateSmsReviewPreparation(tampered, followup, calculation)).toThrow();
    await writeFile(planPath, tampered.planBytes, { mode: 0o600 });
    const changedBytes = await readFile(planPath);
    await expect(readRetainedSmsReview(followup)).rejects.toThrow(/changed/i);
    await expect(retainSmsReview(followup, review)).rejects.toThrow(/changed/i);
    expect(await readFile(planPath)).toEqual(changedBytes);
    expect(await readFile(commitmentPath)).toEqual(commitment);
    expect(await readFile(calculationPath)).toEqual(calculationBytes);
    expect(await readFile(actorPath, 'utf8')).toBe('independent human review actor journal');
  });

  it('refuses world and reserved journal aliases before committing a review', async () => {
    const { directory, incident, followup, review } = await retainedFixture();
    const worldBytes = 'test-local retained world';
    await writeFile(incident.worldPath, worldBytes, { mode: 0o600 });
    await writeFile(followup.worldPath, worldBytes, { mode: 0o600 });
    const alias = join(directory, 'world-as-review-selection.json');
    await link(incident.worldPath, alias);
    await expect(retainSmsReview(followup, review, [alias])).rejects.toThrow(/alias|separate/i);
    await unlink(alias);
    await link(followup.worldPath, alias);
    await expect(retainSmsReview(followup, review, [alias])).rejects.toThrow(/alias|separate/i);
    const phase = join(followup.config.directory, 'followup');
    await expect(retainSmsReview(followup, review, [join(phase, 'review.journal.json')])).rejects.toThrow(
      /alias|separate/i,
    );
    await expect(retainSmsReview(followup, review, [join(phase, 'calculation.journal.json')])).rejects.toThrow(
      /alias|separate/i,
    );
    await mkdir(`${followup.worldPath}.history`, { mode: 0o700 });
    const history = join(directory, 'history-alias');
    await symlink(`${followup.worldPath}.history`, history, 'dir');
    await expect(retainSmsReview(followup, review, [join(history, 'future-review.json')])).rejects.toThrow(
      /world-owned|alias|separate/i,
    );
    expect(await readFile(incident.worldPath, 'utf8')).toBe(worldBytes);
    expect(await readFile(followup.worldPath, 'utf8')).toBe(worldBytes);
    expect(await readRetainedSmsReview(followup)).toBeUndefined();
  });
});
