import { canonicalDigest } from '@ledger/integrity';
import {
  COMMAND_LINK_LOSS_LEAF_ID,
  commandLinkEvidenceLeafV1,
  commandLinkStatusBindingV1,
} from './command-link-evidence-v1.js';
import { demoProceduresRulePack } from './demo-procedures-pack.js';

// RETAINED FORMAT. The registration under which the version 1 lost-link review ran in its own evaluator, as
// evaluations, hazard records and decision packets issued before version 5 cite it. Nothing runs under it now;
// readers of those retained records compare against it. It goes away with the old decision packet format and the
// effectiveness calculation that still read it.

const pack = demoProceduresRulePack.versions.find((candidate) => candidate.version === 3)!;
const leaf = pack.leaves.find((candidate) => candidate.id === COMMAND_LINK_LOSS_LEAF_ID)!;
if (!('bindingId' in leaf)) throw new Error('The retained lost-link execution requires an automated leaf');
const binding = pack.bindings.find((candidate) => candidate.id === leaf.bindingId)!;
const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
  id,
  version,
  digest,
});
const definition = {
  id: 'ledger.command-link-evidence' as const,
  version: 1 as const,
  algorithm: 'reported-command-link-evidence.1',
  clock: 'wall',
  leaf: reference(leaf),
  binding: reference(binding),
};

export const c2ExecutionRegistration = Object.freeze({
  policyVersion: 'ledger.company-c2-execution.1' as const,
  pack: { id: pack.packId, version: pack.version, digest: pack.digest },
  leaf: reference(leaf),
  binding: reference(binding),
  evaluator: { id: definition.id, version: definition.version, digest: canonicalDigest(definition) },
});

export { COMMAND_LINK_LOSS_LEAF_ID, commandLinkEvidenceLeafV1, commandLinkStatusBindingV1 };
