import { demoProceduresIndicators, demoProceduresRulePack } from '@ledger/domain/builtin-packs';
import { registerIndicatorDefinition } from '@ledger/domain/indicators';
import {
  getRulePackVersion,
  isRulePackRegistered,
  registerRulePack,
  type RulePackRegistration,
} from '@ledger/domain/rule-pack-registry';
import {
  exampleAirspaceRulePack,
  excursionsPerFlightHourV1,
  excursionsPerFlightHourV2,
} from '@ledger/pack-example-airspace';
import { exampleBvlosWaiverRulePack } from '@ledger/pack-example-bvlos-waiver';
import { assignmentsOutsideLimitsV1, exampleCrewRulePack } from '@ledger/pack-example-crew';
import { exampleOperationsIndicators, exampleOperationsRulePack } from '@ledger/pack-example-operations';
import { exampleWaiverRulePack } from '@ledger/pack-example-waiver';
import {
  exampleWeatherRulePack,
  flightsWithWindAboveLimitInFlightV1,
  flightsWithWindAboveLimitV1,
  windExceedancesPer100FlightsV1,
} from '@ledger/pack-example-weather';
import { part107RulePack } from '@ledger/pack-part107';
import { part108NprmRulePack } from '@ledger/pack-part108-nprm';

export { PackFileError, packFileVersion, verifiedPackFile } from './pack-files.js';
export {
  packFileCollision,
  readPackFile,
  readPackFolder,
  registerPackFolder,
  type LoadedPackFile,
} from './pack-folder.js';
export {
  buildPackFile,
  buildPackFolder,
  coverageWords,
  findQuotation,
  type BuiltPack,
  type BuiltRuleReport,
} from './pack-builder.js';
export { packTemplate, packTemplateKinds, type PackTemplateKind } from './pack-templates.js';
export { checkKindLines, checkKindsPrintout } from './check-kind-printout.js';

/** The pack version the fictional seeded flight organizations adopt, as their dispatcher would. */
export const seededOrganizationPack = { packId: demoProceduresRulePack.packId, version: 6 } as const;

/** Every shipped pack, a relieved pack before the waiver that relieves it (the registry checks the relieved rules). */
export function standardRulePacks(): RulePackRegistration[] {
  return [
    demoProceduresRulePack,
    part108NprmRulePack(),
    exampleOperationsRulePack(),
    part107RulePack(),
    exampleWaiverRulePack(),
    exampleBvlosWaiverRulePack(),
    exampleAirspaceRulePack(),
    exampleCrewRulePack(),
    exampleWeatherRulePack(),
  ];
}

/** The packs that quote a regulation or a proposed one. Every other shipped pack is an invented example. */
const REGULATORY_PACK_IDS: readonly string[] = ['ledger.part107', 'ledger.part108-nprm'];

/** True for a shipped pack that is an invented example or demonstration, not a regulation's text. */
export function isExamplePack(packId: string): boolean {
  return !REGULATORY_PACK_IDS.includes(packId);
}

/**
 * Whether this process offers the invented example and demonstration packs. LEDGER_EXAMPLE_PACKS says so (1 or 0);
 * unset, they are offered in local development and tests and left out of a deployment (LEDGER_ENV=staging), where an
 * organization of its own should be offered only what it could adopt. The API and the workers must agree.
 */
export function examplePacksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.LEDGER_EXAMPLE_PACKS;
  if (setting !== undefined && setting !== '' && setting !== '0' && setting !== '1')
    throw new Error('LEDGER_EXAMPLE_PACKS must be 0 or 1');
  if (setting === '1') return true;
  if (setting === '0') return false;
  return env.LEDGER_ENV !== 'staging';
}

let shippedExamples: ReadonlySet<string> | undefined;

/**
 * Whether a registered pack is offered to an organization. The invented example packs shipped with Ledger are offered
 * to the seeded fictional organizations they were written for, and to any other only when the deployment sets
 * LEDGER_EXAMPLE_PACKS=1. Every other pack, a regulation's or one from the organization's own files, is offered.
 */
export function packOffered(
  packId: string,
  organization: { fictional: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  shippedExamples ??= new Set(
    standardRulePacks()
      .map((registration) => registration.packId)
      .filter(isExamplePack),
  );
  if (!shippedExamples.has(packId)) return true;
  return env.LEDGER_EXAMPLE_PACKS === '1' || organization.fictional;
}

function sameRegistration(registration: RulePackRegistration): boolean {
  return registration.versions.every(
    (version) => getRulePackVersion(registration.packId, version.version)?.digest === version.digest,
  );
}

/**
 * Registers the packs this process offers, and the indicators over their rules. With examples false only the packs
 * that quote a regulation are registered; the shipped indicators are all over example packs, so none is. Safe to call
 * repeatedly.
 */
export function registerStandardPacks(options: { examples?: boolean } = {}): void {
  const examples = options.examples ?? true;
  for (const registration of standardRulePacks()) {
    if (!examples && isExamplePack(registration.packId)) continue;
    if (!isRulePackRegistered(registration.packId)) registerRulePack(registration);
    else if (!sameRegistration(registration))
      throw new Error(`Rule pack ${registration.packId} is already registered with different versions`);
  }
  if (examples) for (const definition of standardIndicators()) registerIndicatorDefinition(definition);
}

/** The indicators the shipped packs define over their own rules. */
export function standardIndicators() {
  return [
    ...demoProceduresIndicators(),
    ...exampleOperationsIndicators(),
    excursionsPerFlightHourV1(),
    excursionsPerFlightHourV2(),
    assignmentsOutsideLimitsV1(),
    flightsWithWindAboveLimitInFlightV1(),
    windExceedancesPer100FlightsV1(),
    flightsWithWindAboveLimitV1(),
  ];
}
