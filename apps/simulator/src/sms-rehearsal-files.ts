import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalDigest, canonicalize, sha256 } from '@ledger/integrity';
import { assertSeparateOperationPaths } from './operation-paths.js';
import { ensureHostedSmsPhase, ensureHostedSmsRoot } from './hosted-sms-paths.js';
import {
  validateOperationReservationRevisionPlan,
  type OperationReservationRevisionPlan,
} from './operation-reservation-revision.js';
import { lockPrivateJournal, readJournalEnvelope, readPrivateText, writePrivateBytes } from './private-journal.js';
import { validateSmsCalculationPreparation, type SmsCalculationPreparation } from './sms-calculation-preparation.js';
import { validateSmsDeparturePreparation, type SmsDeparturePreparation } from './sms-departure-preparation.js';
import { validateSmsReviewPreparation, type SmsReviewPreparation } from './sms-review-preparation.js';
import {
  validateSmsRehearsalConfig,
  validateSmsRehearsalPreparation,
  type SmsFollowupPreparation,
  type SmsIncidentPreparation,
  type SmsRehearsalConfig,
  type SmsRehearsalPhase,
  type SmsRehearsalPreparation,
} from './sms-rehearsal-plan.js';

const maxBytes = 4 * 1024 * 1024;
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
const markerPath = (config: SmsRehearsalConfig) => resolve(config.directory, 'rehearsal.json');
const phasePath = (config: SmsRehearsalConfig, phase: SmsRehearsalPhase, name: string) =>
  resolve(config.directory, phase, name);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function privateDirectory(path: string, create = false): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700)
      throw new Error('SMS preparation directories must be private regular directories with mode 0700');
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function privateFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > maxBytes
    )
      throw new Error('SMS preparation files must be bounded private regular files with mode 0600');
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function guardPaths(config: SmsRehearsalConfig, inputs: string[] = []): Promise<void> {
  const worlds = ['incident', 'followup'].map((phase) => resolve(config.directory, phase, 'world.json'));
  const files = [
    markerPath(config),
    `${markerPath(config)}.lock`,
    ...['incident', 'followup'].flatMap((phase) =>
      ['preparation.json', 'world.env'].map((name) => resolve(config.directory, phase, name)),
    ),
    phasePath(config, 'followup', 'monitoring.plan.json'),
    phasePath(config, 'followup', 'revision.preparation.json'),
    phasePath(config, 'followup', 'revision.plan.json'),
    ...[
      'departure.preparation.json',
      'departure.plan.json',
      'departure.env',
      'departure.journal.json',
      'departure.journal.json.pending',
      'departure.journal.json.lock',
      'calculation.preparation.json',
      'calculation.plan.json',
      'calculation.env',
      'calculation.journal.json',
      'calculation.journal.json.pending',
      'calculation.journal.json.lock',
      'review.preparation.json',
      'review.plan.json',
      'review.env',
      'review.journal.json',
      'review.journal.json.pending',
      'review.journal.json.lock',
    ].map((name) => phasePath(config, 'followup', name)),
    ...inputs.flatMap((path) => [resolve(path), `${resolve(path)}.pending`, `${resolve(path)}.lock`]),
  ];
  for (const world of worlds)
    await assertSeparateOperationPaths(
      [
        ...files,
        ...worlds.filter((other) => other !== world).flatMap((other) => [other, `${other}.pending`, `${other}.lock`]),
      ],
      world,
    );
}

async function readMarker(config: SmsRehearsalConfig): Promise<boolean> {
  if (!(await privateDirectory(config.directory))) return false;
  const value = (await privateFile(markerPath(config)))
    ? await readJournalEnvelope(markerPath(config), maxBytes)
    : undefined;
  if (value === undefined) {
    if ((await readdir(config.directory)).some((name) => name !== 'rehearsal.json.lock'))
      throw new Error('Refusing to claim a nonempty directory without an SMS preparation marker');
    return false;
  }
  const marker = value as { version?: unknown; kind?: unknown; config?: unknown; configDigest?: unknown };
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    Object.keys(marker).sort().join(',') !== 'config,configDigest,kind,version' ||
    marker.version !== 1 ||
    marker.kind !== 'sms-rehearsal-root' ||
    marker.configDigest !== canonicalDigest(config) ||
    !same(marker.config, config)
  )
    throw new Error('The private SMS root belongs to another configuration');
  return true;
}

async function retainText(path: string, text: string, preserveBom = false): Promise<void> {
  if (Buffer.byteLength(text) > maxBytes) throw new Error('SMS preparation file exceeds its byte bound');
  if (await privateFile(path)) {
    if ((await readPrivateText(path, maxBytes, { preserveBom })) !== text)
      throw new Error('A retained SMS preparation file changed; refusing to overwrite it');
    return;
  }
  await writePrivateBytes(path, Buffer.from(text));
}

async function retainEnvelope(path: string, value: unknown, preserveBom = false): Promise<void> {
  const body = JSON.stringify(value);
  await retainText(path, JSON.stringify({ version: 1, body, sha256: sha256(body) }) + '\n', preserveBom);
}

async function ownedRoot<T>(config: SmsRehearsalConfig, inputs: string[], work: () => Promise<T>): Promise<T> {
  if (config.version === 3) await ensureHostedSmsRoot(config.directory, true);
  await guardPaths(config, inputs);
  if (config.version !== 3) await privateDirectory(config.directory, true);
  const unlock = await lockPrivateJournal(markerPath(config), 'SMS preparation');
  try {
    await guardPaths(config, inputs);
    if (!(await readMarker(config)))
      await retainEnvelope(markerPath(config), {
        version: 1,
        kind: 'sms-rehearsal-root',
        config,
        configDigest: canonicalDigest(config),
      });
    return await work();
  } finally {
    await unlock();
  }
}

async function retainedPhase(
  config: SmsRehearsalConfig,
  phase: SmsRehearsalPhase,
): Promise<SmsRehearsalPreparation | undefined> {
  const path = phasePath(config, phase, 'preparation.json');
  if (!(await privateDirectory(dirname(path)))) return undefined;
  const value = (await privateFile(path)) ? await readJournalEnvelope(path, maxBytes) : undefined;
  if (value === undefined) {
    if ((await readdir(dirname(path))).length) throw new Error('An unretained SMS phase directory is not empty');
    return undefined;
  }
  const incident =
    phase === 'followup'
      ? ((await retainedPhase(config, 'incident')) as SmsIncidentPreparation | undefined)
      : undefined;
  const preparation = validateSmsRehearsalPreparation(value, incident);
  if (preparation.phase !== phase || !same(preparation.config, config))
    throw new Error('Retained SMS phase differs from the requested configuration');
  return preparation;
}

export function readRetainedSmsPreparation(
  config: SmsRehearsalConfig,
  phase: 'incident',
): Promise<SmsIncidentPreparation | undefined>;
export function readRetainedSmsPreparation(
  config: SmsRehearsalConfig,
  phase: 'followup',
): Promise<SmsFollowupPreparation | undefined>;
export function readRetainedSmsPreparation(
  config: SmsRehearsalConfig,
  phase: SmsRehearsalPhase,
): Promise<SmsRehearsalPreparation | undefined>;
export async function readRetainedSmsPreparation(
  value: SmsRehearsalConfig,
  phase: SmsRehearsalPhase,
): Promise<SmsRehearsalPreparation | undefined> {
  const config = validateSmsRehearsalConfig(value);
  if (!['incident', 'followup'].includes(phase)) throw new Error('Unsupported SMS preparation phase');
  if (config.version === 3 && !(await ensureHostedSmsRoot(config.directory))) return undefined;
  await guardPaths(config);
  return (await readMarker(config)) ? retainedPhase(config, phase) : undefined;
}

function environment(preparation: SmsRehearsalPreparation): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const keys = [...preparation.clearEnvironment, ...Object.keys(preparation.environment)];
  if (
    keys.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name)) ||
    Object.entries(preparation.environment).some(
      ([name, value]) =>
        name === 'SIMULATOR_WORLD_MODE' || /TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(name) || value.includes('\0'),
    )
  )
    throw new Error('SMS source settings cannot contain credentials or a world execution mode');
  return [
    'for _sms_name in $(env | sed -n \'s/^\\(SIMULATOR_WORLD_[A-Z0-9_]*\\)=.*/\\1/p\'); do unset "$_sms_name"; done',
    'unset _sms_name',
    ...preparation.clearEnvironment.map((name) => `unset ${name}`),
    ...Object.entries(preparation.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `export ${name}=${quote(value)}`),
    '',
  ].join('\n');
}

export async function retainSmsPreparation(
  value: SmsRehearsalPreparation,
  inputs: string[] = [],
): Promise<SmsRehearsalPreparation> {
  const config = validateSmsRehearsalConfig(value.config);
  const incident = value.phase === 'followup' ? await readRetainedSmsPreparation(config, 'incident') : undefined;
  const preparation = validateSmsRehearsalPreparation(value, incident);
  return ownedRoot(config, inputs, async () => {
    const retained = await retainedPhase(config, preparation.phase);
    if (retained && !same(retained, preparation))
      throw new Error('SMS start, preparation clock or accepted control selection changed');
    const directory = dirname(preparation.worldPath);
    if (config.version === 3) await ensureHostedSmsPhase(directory);
    else await privateDirectory(directory, true);
    await retainEnvelope(resolve(directory, 'preparation.json'), preparation);
    await retainText(resolve(directory, 'world.env'), environment(preparation));
    if (preparation.phase === 'followup')
      await retainText(
        resolve(directory, 'monitoring.plan.json'),
        JSON.stringify(preparation.monitoring, null, 2) + '\n',
      );
    return structuredClone(preparation);
  });
}

function revisionFor(followup: SmsFollowupPreparation, value: unknown): OperationReservationRevisionPlan {
  const revision = validateOperationReservationRevisionPlan(value);
  if (
    revision.runId !== followup.runId ||
    revision.tenant !== followup.monitoring.monitoring.tenant ||
    revision.reservationId !== followup.identities.attemptId ||
    revision.aircraftId !== followup.identities.aircraftId ||
    !same(revision.change, followup.missionChange)
  )
    throw new Error('Reservation revision differs from the retained follow-up identity or mission change');
  return revision;
}

export async function readRetainedSmsRevision(
  followup: SmsFollowupPreparation,
): Promise<OperationReservationRevisionPlan | undefined> {
  const retained = await readRetainedSmsPreparation(followup.config, 'followup');
  if (!retained || !same(retained, followup))
    throw new Error('The exact follow-up preparation must be retained before its revision');
  const path = phasePath(retained.config, 'followup', 'revision.plan.json');
  const committed = phasePath(retained.config, 'followup', 'revision.preparation.json');
  const value = (await privateFile(committed)) ? await readJournalEnvelope(committed, maxBytes) : undefined;
  if (value === undefined) {
    if (await privateFile(path)) throw new Error('A raw SMS revision has no retained preparation commitment');
    return undefined;
  }
  const envelope = value as { version?: unknown; kind?: unknown; preparationDigest?: unknown; revision?: unknown };
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(',') !== 'kind,preparationDigest,revision,version' ||
    envelope.version !== 1 ||
    envelope.kind !== 'sms-rehearsal-revision' ||
    envelope.preparationDigest !== canonicalDigest(retained)
  )
    throw new Error('The retained SMS revision belongs to another follow-up preparation');
  const revision = revisionFor(retained, envelope.revision);
  if ((await privateFile(path)) && (await readPrivateText(path, maxBytes)) !== JSON.stringify(revision, null, 2) + '\n')
    throw new Error('The raw SMS revision changed from its retained preparation');
  return revision;
}

export async function retainSmsRevision(
  followup: SmsFollowupPreparation,
  value: OperationReservationRevisionPlan,
  inputs: string[] = [],
): Promise<void> {
  const retained = await readRetainedSmsPreparation(followup.config, 'followup');
  if (!retained || !same(retained, followup))
    throw new Error('The exact follow-up preparation must be retained before its revision');
  const requested = revisionFor(retained, value);
  await ownedRoot(retained.config, inputs, async () => {
    const original = await readRetainedSmsRevision(retained);
    if (original && !same(original, requested)) throw new Error('The original SMS reservation binding cannot change');
    const revision = original ?? requested;
    await retainEnvelope(phasePath(retained.config, 'followup', 'revision.preparation.json'), {
      version: 1,
      kind: 'sms-rehearsal-revision',
      preparationDigest: canonicalDigest(retained),
      revision,
    });
    await retainText(
      phasePath(retained.config, 'followup', 'revision.plan.json'),
      JSON.stringify(revision, null, 2) + '\n',
    );
  });
}

function departureEnvironment(followup: SmsFollowupPreparation): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    'unset SIMULATOR_WORLD_DEPARTURE_PLAN',
    'unset SIMULATOR_WORLD_DEPARTURE_STATE',
    'unset SIMULATOR_WORLD_DEPARTURE_TOKEN',
    `export SIMULATOR_WORLD_DEPARTURE_PLAN=${quote(phasePath(followup.config, 'followup', 'departure.plan.json'))}`,
    `export SIMULATOR_WORLD_DEPARTURE_STATE=${quote(phasePath(followup.config, 'followup', 'departure.journal.json'))}`,
    '',
  ].join('\n');
}

async function departureContext(followup: SmsFollowupPreparation) {
  const retained = await readRetainedSmsPreparation(followup.config, 'followup');
  if (!retained || !same(retained, followup))
    throw new Error('The exact follow-up preparation must be retained before its departure');
  const revision = await readRetainedSmsRevision(retained);
  if (!revision) throw new Error('The exact reservation revision must be retained before its departure');
  return { retained, revision };
}

export async function readRetainedSmsDeparture(
  followup: SmsFollowupPreparation,
): Promise<SmsDeparturePreparation | undefined> {
  const { retained, revision } = await departureContext(followup);
  const committed = phasePath(retained.config, 'followup', 'departure.preparation.json');
  const planPath = phasePath(retained.config, 'followup', 'departure.plan.json');
  const environmentPath = phasePath(retained.config, 'followup', 'departure.env');
  const value = (await privateFile(committed)) ? await readJournalEnvelope(committed, maxBytes) : undefined;
  if (value === undefined) {
    if ((await privateFile(planPath)) || (await privateFile(environmentPath)))
      throw new Error('SMS departure outputs have no retained preparation commitment');
    return undefined;
  }
  const preparation = validateSmsDeparturePreparation(value, retained, revision);
  if ((await privateFile(planPath)) && (await readPrivateText(planPath, maxBytes)) !== preparation.planBytes)
    throw new Error('The raw departure plan changed from its retained preparation');
  if (
    (await privateFile(environmentPath)) &&
    (await readPrivateText(environmentPath, maxBytes)) !== departureEnvironment(retained)
  )
    throw new Error('The departure settings changed from their retained preparation');
  return preparation;
}

export async function retainSmsDeparture(
  followup: SmsFollowupPreparation,
  value: SmsDeparturePreparation,
  inputs: string[] = [],
): Promise<SmsDeparturePreparation> {
  const { retained, revision } = await departureContext(followup);
  const requested = validateSmsDeparturePreparation(value, retained, revision);
  return ownedRoot(retained.config, inputs, async () => {
    const original = await readRetainedSmsDeparture(retained);
    if (original && !same(original, requested))
      throw new Error('The original SMS departure inputs, clock or plan cannot change');
    const preparation = original ?? requested;
    await retainEnvelope(phasePath(retained.config, 'followup', 'departure.preparation.json'), preparation);
    await retainText(phasePath(retained.config, 'followup', 'departure.plan.json'), preparation.planBytes);
    await retainText(phasePath(retained.config, 'followup', 'departure.env'), departureEnvironment(retained));
    return structuredClone(preparation);
  });
}

function calculationEnvironment(followup: SmsFollowupPreparation): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    'unset SIMULATOR_EFFECTIVENESS_PLAN',
    'unset SIMULATOR_EFFECTIVENESS_STATE',
    'unset SIMULATOR_EFFECTIVENESS_TOKEN',
    `export SIMULATOR_EFFECTIVENESS_PLAN=${quote(phasePath(followup.config, 'followup', 'calculation.plan.json'))}`,
    `export SIMULATOR_EFFECTIVENESS_STATE=${quote(phasePath(followup.config, 'followup', 'calculation.journal.json'))}`,
    '',
  ].join('\n');
}

async function calculationContext(followup: SmsFollowupPreparation): Promise<SmsFollowupPreparation> {
  const retained = await readRetainedSmsPreparation(followup.config, 'followup');
  if (!retained || !same(retained, followup))
    throw new Error('The exact follow-up preparation must be retained before its calculation');
  return retained;
}

export async function readRetainedSmsCalculation(
  followup: SmsFollowupPreparation,
): Promise<SmsCalculationPreparation | undefined> {
  const retained = await calculationContext(followup);
  const committed = phasePath(retained.config, 'followup', 'calculation.preparation.json');
  const planPath = phasePath(retained.config, 'followup', 'calculation.plan.json');
  const environmentPath = phasePath(retained.config, 'followup', 'calculation.env');
  const value = (await privateFile(committed)) ? await readJournalEnvelope(committed, maxBytes) : undefined;
  if (value === undefined) {
    if ((await privateFile(planPath)) || (await privateFile(environmentPath)))
      throw new Error('SMS calculation outputs have no retained preparation commitment');
    return undefined;
  }
  const preparation = validateSmsCalculationPreparation(value, retained);
  if ((await privateFile(planPath)) && (await readPrivateText(planPath, maxBytes)) !== preparation.planBytes)
    throw new Error('The raw calculation plan changed from its retained preparation');
  if (
    (await privateFile(environmentPath)) &&
    (await readPrivateText(environmentPath, maxBytes)) !== calculationEnvironment(retained)
  )
    throw new Error('The calculation settings changed from their retained preparation');
  return preparation;
}

export async function retainSmsCalculation(
  followup: SmsFollowupPreparation,
  value: SmsCalculationPreparation,
  inputs: string[] = [],
): Promise<SmsCalculationPreparation> {
  const retained = await calculationContext(followup);
  const requested = validateSmsCalculationPreparation(value, retained);
  return ownedRoot(retained.config, inputs, async () => {
    const original = await readRetainedSmsCalculation(retained);
    if (original && !same(original, requested))
      throw new Error('The original SMS calculation inputs, clock or plan cannot change');
    const preparation = original ?? requested;
    await retainEnvelope(phasePath(retained.config, 'followup', 'calculation.preparation.json'), preparation);
    await retainText(phasePath(retained.config, 'followup', 'calculation.plan.json'), preparation.planBytes);
    await retainText(phasePath(retained.config, 'followup', 'calculation.env'), calculationEnvironment(retained));
    return structuredClone(preparation);
  });
}

function reviewEnvironment(followup: SmsFollowupPreparation): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    'unset SIMULATOR_EFFECTIVENESS_REVIEW_PLAN',
    'unset SIMULATOR_EFFECTIVENESS_REVIEW_STATE',
    'unset SIMULATOR_EFFECTIVENESS_REVIEW_TOKEN',
    `export SIMULATOR_EFFECTIVENESS_REVIEW_PLAN=${quote(phasePath(followup.config, 'followup', 'review.plan.json'))}`,
    `export SIMULATOR_EFFECTIVENESS_REVIEW_STATE=${quote(phasePath(followup.config, 'followup', 'review.journal.json'))}`,
    '',
  ].join('\n');
}

async function reviewContext(followup: SmsFollowupPreparation) {
  const retained = await readRetainedSmsPreparation(followup.config, 'followup');
  if (!retained || !same(retained, followup))
    throw new Error('The exact follow-up preparation must be retained before its review');
  const calculation = await readRetainedSmsCalculation(retained);
  if (!calculation) throw new Error('The exact calculation preparation must be retained before its review');
  return { retained, calculation };
}

export async function readRetainedSmsReview(
  followup: SmsFollowupPreparation,
): Promise<SmsReviewPreparation | undefined> {
  const { retained, calculation } = await reviewContext(followup);
  const committed = phasePath(retained.config, 'followup', 'review.preparation.json');
  const planPath = phasePath(retained.config, 'followup', 'review.plan.json');
  const environmentPath = phasePath(retained.config, 'followup', 'review.env');
  const value = (await privateFile(committed))
    ? await readJournalEnvelope(committed, maxBytes, { preserveBom: true })
    : undefined;
  if (value === undefined) {
    if ((await privateFile(planPath)) || (await privateFile(environmentPath)))
      throw new Error('SMS review outputs have no retained preparation commitment');
    return undefined;
  }
  const preparation = validateSmsReviewPreparation(value, retained, calculation);
  if (
    (await privateFile(planPath)) &&
    (await readPrivateText(planPath, maxBytes, { preserveBom: true })) !== preparation.planBytes
  )
    throw new Error('The raw review plan changed from its retained preparation');
  if (
    (await privateFile(environmentPath)) &&
    (await readPrivateText(environmentPath, maxBytes, { preserveBom: true })) !== reviewEnvironment(retained)
  )
    throw new Error('The review settings changed from their retained preparation');
  return preparation;
}

export async function retainSmsReview(
  followup: SmsFollowupPreparation,
  value: SmsReviewPreparation,
  inputs: string[] = [],
): Promise<SmsReviewPreparation> {
  const { retained, calculation } = await reviewContext(followup);
  const requested = validateSmsReviewPreparation(value, retained, calculation);
  return ownedRoot(retained.config, inputs, async () => {
    const original = await readRetainedSmsReview(retained);
    if (original && !same(original, requested))
      throw new Error('The original SMS review inputs, clock or plan cannot change');
    const preparation = original ?? requested;
    await retainEnvelope(phasePath(retained.config, 'followup', 'review.preparation.json'), preparation, true);
    await retainText(phasePath(retained.config, 'followup', 'review.plan.json'), preparation.planBytes, true);
    await retainText(phasePath(retained.config, 'followup', 'review.env'), reviewEnvironment(retained), true);
    return structuredClone(preparation);
  });
}
