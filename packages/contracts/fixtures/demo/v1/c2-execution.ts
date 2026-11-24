import type {
  C2EvaluationExecution,
  EvaluatorReference,
  FindingRecord,
  FlightRuleSelectionRecordV1,
  FlightRuleSelectionRecordV2,
} from '../../../src/index.js';
import {
  commandLinkLossEvaluation,
  commandLinkRestoredEvaluation,
  restoredCommandLinkFinding,
} from './command-link-findings.js';
import { ruleSelectionEligible, ruleSelectionExpired } from './rule-selection.js';

export const commandLinkEvaluator = {
  id: 'ledger.command-link-evidence',
  version: 1,
  digest: 'c25bef5721e555b19b3db564f6999d0fae967db642e7e5a56cd5dba490f46482',
} satisfies EvaluatorReference;

function selection(
  original: FlightRuleSelectionRecordV1,
  status: 'active' | 'inactive',
  selectionDigest: string,
): FlightRuleSelectionRecordV2 {
  return {
    ...original,
    id: `${original.id}-execution-v2`,
    version: 'flight.rule-selection.2',
    execution: {
      status,
      baseline: 'builtin_draft',
      policyVersion: 'ledger.company-c2-execution.1',
      evaluator: commandLinkEvaluator,
    },
    selectionDigest,
  };
}
export const adoptedCommandLinkSelection = selection(
  { ...ruleSelectionEligible.selection, clock: { mode: 'wall', evaluatedAt: '2026-10-15T14:12:15Z' } },
  'active',
  'f7f340c91f861493f0f74605173846ffa42c072b448a73a69b589a128174b649',
);
export const expiredCommandLinkSelection = selection(
  ruleSelectionExpired.selection,
  'inactive',
  'c08214b6c6cb04508a63b907bbb3312847a9aea9f4d3a3c43a147ca0535f0c06',
);

function execution(
  selected: FlightRuleSelectionRecordV2,
  trigger: C2EvaluationExecution['trigger'],
): C2EvaluationExecution {
  return {
    version: 'flight.c2-execution.1',
    mode: selected.execution.status === 'active' ? 'adopted' : 'builtin_draft',
    policyVersion: selected.execution.policyVersion,
    evaluator: selected.execution.evaluator,
    selection: { id: selected.id, version: selected.version, digest: selected.selectionDigest },
    adoption: selected.selection.adoption,
    trigger,
  };
}

const treatment = {
  id: 'resolved-link-owner-acknowledgement',
  evaluationId: commandLinkLossEvaluation.id,
  action: 'acknowledge' as const,
  actorId: restoredCommandLinkFinding.owner!.id,
  actorName: restoredCommandLinkFinding.owner!.name,
  note: 'I own the reported command-link loss review.',
  recordedAt: '2026-10-15T14:12:10Z',
};
export const draftCommandLinkFinding = {
  ...restoredCommandLinkFinding,
  latestEvaluation: commandLinkLossEvaluation,
  treatments: [treatment],
} satisfies FindingRecord;

export const adoptedCommandLinkFinding = {
  ...draftCommandLinkFinding,
  latestEvaluation: {
    ...commandLinkRestoredEvaluation,
    id: 'resolved-link-adopted-restoration-evaluation',
    profile: 'ledger.c2-evaluation.2',
    execution: execution(adoptedCommandLinkSelection, {
      kind: 'source_report',
      eventId: 'resolved-link-restoration-event',
    }),
    inputCut: {
      ...commandLinkRestoredEvaluation.inputCut,
      streams: {
        ...adoptedCommandLinkSelection.renderedInputCut.streams,
        ...commandLinkRestoredEvaluation.inputCut.streams,
        'resolved-selection-stream': 1,
      },
    },
    acceptedInputCut: {
      ...commandLinkRestoredEvaluation.acceptedInputCut,
      streams: {
        ...adoptedCommandLinkSelection.acceptedInputCut.streams,
        ...commandLinkRestoredEvaluation.acceptedInputCut.streams,
        'resolved-selection-stream': 1,
      },
    },
  },
} satisfies FindingRecord;

export const expiredCommandLinkFinding = {
  ...adoptedCommandLinkFinding,
  latestEvaluation: {
    ...adoptedCommandLinkFinding.latestEvaluation,
    id: 'resolved-link-expired-draft-evaluation',
    execution: execution(expiredCommandLinkSelection, {
      kind: 'selection_change',
      eventId: expiredCommandLinkSelection.id,
    }),
    explanation: { ...commandLinkRestoredEvaluation.explanation, evaluatedAt: '2026-10-15T14:20:01Z' },
    clock: { mode: 'wall', evaluatedAt: '2026-10-15T14:20:01Z' },
    inputCut: {
      ...commandLinkRestoredEvaluation.inputCut,
      streams: { ...adoptedCommandLinkFinding.latestEvaluation.inputCut.streams, 'resolved-selection-stream': 2 },
    },
    acceptedInputCut: {
      ...commandLinkRestoredEvaluation.acceptedInputCut,
      streams: {
        ...adoptedCommandLinkFinding.latestEvaluation.acceptedInputCut.streams,
        'resolved-selection-stream': 2,
      },
    },
    recordedAt: '2026-10-15T14:20:01Z',
  },
} satisfies FindingRecord;
