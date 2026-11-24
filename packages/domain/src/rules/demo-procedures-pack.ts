// The demo procedures pack, assembled beside its rules. Versions 1 to 4 keep leaves that ran in built-in evaluators;
// from version 5 every automated leaf is a checked rule on the generic evaluator.
import type {
  CheckedRuleLeaf,
  IndicatorDefinition,
  RulePackBinding,
  RulePackLeaf,
  RulePackVersion,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { authorizationEvidenceLeafV1, authorizationStatusBindingV1 } from './authorization-evidence-v1.js';
import { commandLinkEvidenceLeafV1, commandLinkStatusBindingV1 } from './command-link-evidence-v1.js';
import {
  flightObservationBindingV1,
  flightRuleLeavesV1,
  type RuleLeaf,
  type SourceBinding,
} from './demo-procedures-v1.js';
import { commandLinkLossesPerFlightHourV1 } from './demo-command-link-indicator-v1.js';
import { commandLinkLossLeafV2 } from './demo-command-link-v2.js';
import { commandLinkLossLeafV3 } from './demo-command-link-v3.js';
import { landingLeavesV2 } from './demo-landing-v2.js';
import type { RulePackRegistration } from '../rule-pack-registry.js';

const VERSION_ONE_DIGEST = '83c479d2eb9d7e0f2687ae6fa06cc54efdbfb0ff46a6118391db19d764d676d5';
const VERSION_TWO_DIGEST = '2c5a817396018cd1104d0a162435a8e39326fb4c2ebb0445ff1874749d197a10';
const VERSION_THREE_DIGEST = '46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188';
const VERSION_FOUR_DIGEST = 'f604f882b16648a20113f623717c39cff02377068d70e9a161687f147cdeb0a9';
const VERSION_FIVE_DIGEST = '4f3d945eee82eda80e88af3b3bfb034d91e195daa79d6a63cbb35cd7b064c162';
const VERSION_SIX_DIGEST = 'fede06c40f00cf2b3ee5ec8d4b927ff8bf8d473f4804266d400e733e12185757';

type AutomatedRulePackLeaf = Extract<RulePackLeaf, { bindingId: string }>;

type DraftProcedureLeaf = Omit<RuleLeaf, 'dependencies'> & {
  dependencies: readonly AutomatedRulePackLeaf['dependencies'][number][];
};

function catalogBinding(
  binding: SourceBinding | typeof authorizationStatusBindingV1 | typeof commandLinkStatusBindingV1,
): RulePackBinding {
  if (binding.inputKind === 'flight.observation') {
    const content = { ...binding, supportedFields: [...binding.supportedFields] };
    return { ...content, digest: canonicalDigest(content) };
  }
  if (binding.inputKind === 'airspace.status') {
    const content = { ...binding, supportedFields: [...binding.supportedFields] };
    return { ...content, digest: canonicalDigest(content) };
  }
  const content = { ...binding, supportedFields: [...binding.supportedFields] };
  return { ...content, digest: canonicalDigest(content) };
}

function catalogLeaf(leaf: DraftProcedureLeaf, binding: RulePackBinding): AutomatedRulePackLeaf {
  if (leaf.bindingId !== binding.id || leaf.bindingVersion !== binding.version)
    throw new Error('Draft procedure leaf references an unavailable source binding');
  const bytes = Buffer.from(leaf.source.text, 'utf8');
  const content: Omit<AutomatedRulePackLeaf, 'digest'> = {
    ...leaf,
    dependencies: [...leaf.dependencies],
    bindingDigest: binding.digest,
    coverage: 'automated',
    source: {
      ...leaf.source,
      encoding: 'utf-8',
      byteLength: bytes.length,
      sha256: sha256(bytes),
      textSpan: {
        start: Buffer.byteLength(leaf.source.text.slice(0, leaf.source.textSpan.start), 'utf8'),
        end: Buffer.byteLength(leaf.source.text.slice(0, leaf.source.textSpan.end), 'utf8'),
        unit: 'utf8_byte',
      },
    },
  };
  return { ...content, digest: canonicalDigest(content) };
}

function draftProcedurePack(
  version: number,
  bindings: RulePackBinding[],
  leaves: readonly (DraftProcedureLeaf | CheckedRuleLeaf)[],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: 'ledger.demo-procedures',
    version,
    title: 'Demo flight procedures',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings,
    leaves: leaves.map((leaf) => {
      if ('check' in leaf) return leaf;
      const binding = bindings.find(
        (candidate) => candidate.id === leaf.bindingId && candidate.version === leaf.bindingVersion,
      );
      if (!binding) throw new Error('Draft procedure leaf references an unavailable source binding');
      return catalogLeaf(leaf, binding);
    }),
  };
  return { ...content, digest: canonicalDigest(content) };
}

const flightBinding = catalogBinding(flightObservationBindingV1);
const versionOne = draftProcedurePack(1, [flightBinding], flightRuleLeavesV1);
if (versionOne.digest !== VERSION_ONE_DIGEST)
  throw new Error(
    `Rule pack ${versionOne.packId} version 1 changed without a new pack version: its digest is now ${versionOne.digest}`,
  );

const versionTwo = draftProcedurePack(
  2,
  [flightBinding, catalogBinding(authorizationStatusBindingV1)],
  [...flightRuleLeavesV1, authorizationEvidenceLeafV1],
);
if (versionTwo.digest !== VERSION_TWO_DIGEST)
  throw new Error(
    `Rule pack ${versionTwo.packId} version 2 changed without a new pack version: its digest is now ${versionTwo.digest}`,
  );

const versionThree = draftProcedurePack(
  3,
  [flightBinding, catalogBinding(authorizationStatusBindingV1), catalogBinding(commandLinkStatusBindingV1)],
  [...flightRuleLeavesV1, authorizationEvidenceLeafV1, commandLinkEvidenceLeafV1],
);
if (versionThree.digest !== VERSION_THREE_DIGEST)
  throw new Error(
    `Rule pack ${versionThree.packId} version 3 changed without a new pack version: its digest is now ${versionThree.digest}`,
  );

// Version 4 moves the landing checks onto the generic evaluator; versions 1 to 3 keep their built-in leaves.
const versionFour = draftProcedurePack(
  4,
  [catalogBinding(authorizationStatusBindingV1), catalogBinding(commandLinkStatusBindingV1)],
  [...landingLeavesV2, authorizationEvidenceLeafV1, commandLinkEvidenceLeafV1],
);
if (versionFour.digest !== VERSION_FOUR_DIGEST)
  throw new Error(
    `Rule pack ${versionFour.packId} version 4 changed without a new pack version: its digest is now ${versionFour.digest}`,
  );

// Version 5 moves the lost-link review onto the generic evaluator; versions 3 and 4 keep its built-in leaf.
const versionFive = draftProcedurePack(
  5,
  [catalogBinding(authorizationStatusBindingV1)],
  [...landingLeavesV2, authorizationEvidenceLeafV1, commandLinkLossLeafV2],
);
if (versionFive.digest !== VERSION_FIVE_DIGEST)
  throw new Error(
    `Rule pack ${versionFive.packId} version 5 changed without a new pack version: its digest is now ${versionFive.digest}`,
  );

// Version 6 binds a lost-link capture session across flights; version 5 keeps the review that binds it per flight.
const versionSix = draftProcedurePack(
  6,
  [catalogBinding(authorizationStatusBindingV1)],
  [...landingLeavesV2, authorizationEvidenceLeafV1, commandLinkLossLeafV3],
);
if (versionSix.digest !== VERSION_SIX_DIGEST)
  throw new Error(
    `Rule pack ${versionSix.packId} version 6 changed without a new pack version: its digest is now ${versionSix.digest}`,
  );

export const demoProceduresRulePack: RulePackRegistration = Object.freeze({
  packId: versionOne.packId,
  versions: Object.freeze([versionOne, versionTwo, versionThree, versionFour, versionFive, versionSix]),
});

/** The indicators defined over the demo procedures' rules. */
export function demoProceduresIndicators(): IndicatorDefinition[] {
  return [commandLinkLossesPerFlightHourV1()];
}
export { commandLinkLossesPerFlightHourV1 } from './demo-command-link-indicator-v1.js';
