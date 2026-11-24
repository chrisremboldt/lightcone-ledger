import type {
  DecisionPacketCreate,
  DecisionPacketQuery,
  DecisionPacketManifest,
  DecisionPacketManifestV2,
} from '../../../src/index.js';
import { restoredCommandLinkFinding } from './command-link-findings.js';
import { adoptedCommandLinkFinding, adoptedCommandLinkSelection, commandLinkEvaluator } from './c2-execution.js';

export const commandLinkDecisionPacketCreate = {
  flightId: restoredCommandLinkFinding.flightId,
  decisionId: 'resolved-link-owner-resolution-decision',
} satisfies DecisionPacketCreate;
export const commandLinkDecisionPacketQuery = {
  flightId: commandLinkDecisionPacketCreate.flightId,
  decisionId: commandLinkDecisionPacketCreate.decisionId,
} satisfies DecisionPacketQuery;
export const commandLinkDecisionPacketSelection = {
  decisionId: commandLinkDecisionPacketCreate.decisionId,
  evaluationId: restoredCommandLinkFinding.latestEvaluation.id,
  findingId: restoredCommandLinkFinding.id,
  selection: 'command-link-finding-treatment.1',
  scope: 'selected_c2_finding_treatment_records',
  historicalActorPolicy: { status: 'not_retained' },
  dependencyManifest: { status: 'not_retained' },
} satisfies Pick<
  DecisionPacketManifest,
  'decisionId' | 'evaluationId' | 'findingId' | 'selection' | 'scope' | 'historicalActorPolicy' | 'dependencyManifest'
>;

export const commandLinkExecutionPacketCreate = {
  flightId: adoptedCommandLinkFinding.flightId,
  decisionId: 'resolved-link-adopted-resolution-decision',
} satisfies DecisionPacketCreate;
export const commandLinkExecutionPacketSelection = {
  decisionId: commandLinkExecutionPacketCreate.decisionId,
  evaluationId: adoptedCommandLinkFinding.latestEvaluation.id,
  findingId: adoptedCommandLinkFinding.id,
  selection: 'c2-execution-finding-treatment.2',
  selectionId: adoptedCommandLinkSelection.id,
  selectionDigest: adoptedCommandLinkSelection.selectionDigest,
  evaluator: commandLinkEvaluator,
  adoptionId: adoptedCommandLinkSelection.selection.adoption!.id,
  scope: 'selected_c2_finding_treatment_records',
  historicalActorPolicy: { status: 'not_retained' },
  dependencyManifest: { status: 'not_retained' },
} satisfies Pick<
  DecisionPacketManifestV2,
  | 'decisionId'
  | 'evaluationId'
  | 'findingId'
  | 'selection'
  | 'selectionId'
  | 'selectionDigest'
  | 'evaluator'
  | 'adoptionId'
  | 'scope'
  | 'historicalActorPolicy'
  | 'dependencyManifest'
>;
