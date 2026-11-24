import { Ajv } from 'ajv';
import {
  ControlApplicabilityOutcomeSchema,
  type ControlApplicabilityOutcome,
  type ControlApplicabilityRecord,
  type MissionAvoidanceMissionReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  controlParameterProblem,
  findControlType,
  registeredControlTypeDigest,
  type ApplicabilityPlan,
} from './control-types.js';

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: false });
const validOutcome = ajv.compile<ControlApplicabilityOutcome>(structuredClone(ControlApplicabilityOutcomeSchema));

/** What an applicability evaluation is read against, besides the control's parameters and the plan. */
export interface ControlApplicabilityInputs {
  /** The exact mission revision the plan comes from, or null when there is none to read. */
  mission: MissionAvoidanceMissionReference | null;
  control: { controlId: string; versionNumber: number; controlEventId: string; bodyDigest: string };
  /** Whether the control's hazard assessment has changed since the control was accepted. */
  reviewRequired: boolean;
}

export interface ControlApplicabilityEvaluation {
  record: ControlApplicabilityRecord;
  digest: string;
}

const sentences = {
  unavailable: "This control's type or parameters cannot be read here, so it applies to every flight in its interval.",
  noRule: "This control's type declares no applicability rule, so it applies to every flight in its interval.",
  underReview:
    'The hazard assessment has changed since this control was accepted, so it applies until a person signs again.',
  inputsIncomplete: "The flight's mission revision cannot be read, so the control applies.",
  error: 'The applicability rule could not be evaluated, so the control applies.',
  undetermined: 'The applicability rule could not settle whether this control bears on the flight, so it applies.',
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function planCopy({ mission }: ApplicabilityPlan): ApplicabilityPlan {
  return deepFreeze(
    structuredClone({
      mission: {
        aircraftId: mission.aircraftId,
        sourceMissionId: mission.sourceMissionId,
        route: mission.route,
        lateralToleranceMeters: mission.lateralToleranceMeters,
        altitude: mission.altitude,
        operatingInterval: mission.operatingInterval,
      },
    }),
  );
}

/**
 * Whether one accepted control applies to one flight, by the applicability rule its pinned type declares. A control
 * applies unless its rule ran on complete inputs and found it does not: an unavailable type, no rule, a hazard under
 * review, a missing plan, an error and an undetermined result all apply. The same inputs give the same record.
 */
export function evaluateControlApplicability(
  pinnedType: { id: string; version: number; digest: string },
  parameters: unknown,
  plan: ApplicabilityPlan | null,
  inputs: ControlApplicabilityInputs,
): ControlApplicabilityEvaluation {
  const controlType = { id: pinnedType.id, version: pinnedType.version, digest: pinnedType.digest };
  const recorded = (
    rule: ControlApplicabilityRecord['rule'],
    result: Pick<ControlApplicabilityRecord, 'basis' | 'summary' | 'reasons'> &
      Partial<Pick<ControlApplicabilityRecord, 'outcome' | 'measured' | 'declared'>>,
  ): ControlApplicabilityEvaluation => {
    const record: ControlApplicabilityRecord = structuredClone({
      version: 'control.applicability.1',
      outcome: result.outcome ?? 'applies',
      basis: result.basis,
      rule,
      inputs: { mission: inputs.mission, control: inputs.control, controlType },
      measured: result.measured ?? [],
      declared: result.declared ?? [],
      summary: result.summary,
      reasons: result.reasons,
    });
    return { record, digest: canonicalDigest(record) };
  };

  const type = findControlType(pinnedType.id, pinnedType.version);
  if (!type || registeredControlTypeDigest(pinnedType.id, pinnedType.version) !== pinnedType.digest)
    return recorded(null, { basis: 'no_rule', summary: sentences.unavailable, reasons: ['control_type_unavailable'] });
  if (controlParameterProblem(pinnedType, parameters))
    return recorded(null, {
      basis: 'no_rule',
      summary: sentences.unavailable,
      reasons: ['control_parameters_invalid'],
    });
  if (!type.applicability) return recorded(null, { basis: 'no_rule', summary: sentences.noRule, reasons: [] });

  const rule = { ...type.applicability.rule };
  if (inputs.reviewRequired)
    return recorded(rule, { basis: 'under_review', summary: sentences.underReview, reasons: ['review_required'] });
  if (!plan || !inputs.mission)
    return recorded(rule, {
      basis: 'inputs_incomplete',
      summary: sentences.inputsIncomplete,
      reasons: ['mission_unavailable'],
    });

  let outcome: unknown;
  try {
    outcome = type.applicability.evaluate(deepFreeze(structuredClone(parameters)), planCopy(plan));
  } catch {
    return recorded(rule, { basis: 'error', summary: sentences.error, reasons: ['rule_failed'] });
  }
  if (!validOutcome(outcome))
    return recorded(rule, { basis: 'error', summary: sentences.error, reasons: ['rule_result_invalid'] });
  if (outcome.applies === 'undetermined')
    return recorded(rule, {
      basis: 'undetermined',
      summary: outcome.summary ?? sentences.undetermined,
      reasons: outcome.reasons,
    });
  return recorded(rule, {
    outcome: outcome.applies ? 'applies' : 'does_not_apply',
    basis: 'rule',
    measured: outcome.measured,
    declared: outcome.declared,
    summary: outcome.summary,
    reasons: [],
  });
}
